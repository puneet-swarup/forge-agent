// src/agent.js — The core agent loop that ties everything together
'use strict';

const fs                           = require('fs');
const path                         = require('path');
const { execSync }                 = require('child_process');
const config                       = require('./config');
const logger                       = require('./logger');
const ForgeBrowser              = require('./browser');
const { executeTool, cache, setAdapterProvider, TOOLS } = require('./tools');
const {
  parseResponse,
  formatToolResult,
  hasToolCall
} = require('./parser');
const { executeBatch }             = require('./parallel-executor');
const { PermissionStore, isReadOnly, getCategory, CATEGORY_LABELS } = require('./permission-store');
const { showPermissionMenu } = require('./permission-menu');
const { ConversationManager }      = require('./prompt');
const { Errors, displayError }     = require('./errors');
const security                     = require('./security');
const shellPolicy                  = require('./shell-policy');
const { Budget, BudgetExceeded }    = require('./budget');
const { Throttle }                  = require('./throttle');
const { verifyProject, describeVerification } = require('./verify');
const { buildContextDigest }        = require('./loom/attach');
const { decideStart, decideEnd, isPlanWrite } = require('./lifecycle-gate');
const { sleep }                    = require('./retry');
const { ProgressTracker }          = require('./progress');
const { MemoryStore }              = require('./memory');
const { HistoryStore }             = require('./history');
const { TemplateStore }            = require('./templates');
const { format }                   = require('./formatter');
const { CommandRouter }            = require('./commands');
const { getProfile, getProfileSystemPromptAddition, applyProfile } = require('./profiles');
const {
  buildPlanPrompt,
  parsePlan,
  formatPlanForDisplay,
  formatPlanForContext,
  isPlanResponse
} = require('./planner');
const { isRunningInDocker, printDockerInfo } = require('./docker');
const { describeStep }             = require('./step-summary');

// ─────────────────────────────────────────────
//  Agent class
// ─────────────────────────────────────────────

class ForgeAgent {
  constructor(options = {}) {
    this.browser      = new ForgeBrowser();
    this.conversation = new ConversationManager();
    this.memory       = new MemoryStore();
    this.history      = new HistoryStore();
    this.templates    = new TemplateStore();
    this.options      = options;
    this._running     = false;
    this.permissionStore = new PermissionStore(config.WORKING_DIR || process.cwd());

    const { getProjectContext } = require('./project-context');
    this.projectContext = getProjectContext(config.WORKING_DIR || process.cwd());

    // Phase 1: durable, gitignored session working memory (SESSION_CONTEXT.md)
    try {
      const { SessionContext } = require('./session-context');
      this.sessionContext = new SessionContext({
        projectDir   : config.WORKING_DIR || process.cwd(),
        sessionName  : process.env.FORGE_SESSION_NAME || 'default',
        task         : options.task || '',
        autoGitignore: config.SESSION_CONTEXT_GITIGNORE !== false,
      });
    } catch (_) {
      this.sessionContext = null;
    }

    this.commandRouter = new CommandRouter({
      config : config,
      agent  : this,
      logger : logger,
      history: this.history || null,
      memory : this.memory  || null,
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Boot the browser and load whichever model the adapter drives */
  async init() {
    // Load project context FIRST
    const context = await this.projectContext.getOrCreate();
    logger.dim(`  Project: ${context.projectName}`);

    if (context.techStack && context.techStack.length > 0) {
      logger.dim(`  Stack: ${context.techStack.join(', ')}`);
    }

    if (context.completedTasks && context.completedTasks.length > 0) {
      logger.dim(`  Memory: ${context.completedTasks.length} past task(s) loaded`);
    }

    await this.browser.launch();

    // Let the read_file tool reach the live adapter for opt-in upload
    // (ARCHITECTURE.md §11). No-op unless READ_FILE_UPLOAD is enabled.
    setAdapterProvider(() => this.browser && this.browser.adapter);

    if (isRunningInDocker()) {
      printDockerInfo();
    }

    await this.browser.newChat();

    // Subscribe to config changes to update TUI status bar
    const { onConfigChange } = require('./config');
    onConfigChange(['MODEL', 'ACTIVE_PROFILE', 'PLANNING_MODE'],
      (newValue, oldValue, key) => {
        logger.updateRunContext(config);
        if (key === 'MODEL') {
          logger.dim(`  Model changed to: ${newValue}`);
        }
      }
    );

    const { getLoadedPluginCount } = require('./tools');
    const pluginCount = getLoadedPluginCount();
    if (pluginCount > 0) {
      logger.info(`Loaded ${pluginCount} custom plugin(s) from ${config.PLUGIN_DIR}`);
    }
  }

  /** Shut down cleanly */
  async shutdown() {
    if (this._closed) return;
    this._closed = true;
    if (typeof this._sessionCtxUpdate  === 'function') this._sessionCtxUpdate();
    if (typeof this._sessionCtxVerify  === 'function') this._sessionCtxVerify();
    if (typeof this._sessionCtxDestroy === 'function') this._sessionCtxDestroy();
    await this.browser.close();
  }

  // -- Session context helpers --
  //
  // SESSION_CONTEXT.md is the durable working memory of a run: goal, decisions,
  // progress, git state. It survives a chat restart, which is exactly what
  // _recoverWithNewChat() needs.
  //
  // This block used to be half-wired: _sessionCtxStart() was called twice and
  // defined nowhere (the guarded call was silently skipped, the unguarded one
  // would throw), and _sessionCtxUpdate() was declared twice. The file was
  // written by accident and never read back.

  /** Create (or resume) SESSION_CONTEXT.md at task start. */
  _sessionCtxStart(task) {
    if (!this.sessionContext) return null;
    try {
      // The agent is constructed before the task is known, so the task is
      // attached here, at task start, before the file is rendered.
      if (task) {
        const clean = String(task).replace(/\s+/g, ' ').trim().slice(0, 300);
        this.sessionContext.task = clean;
        if (this.sessionContext.data) {
          this.sessionContext.data.task = clean;
          if (!this.sessionContext.data.goal) this.sessionContext.data.goal = clean;
        }
      }

      if (typeof this.sessionContext.create === 'function') {
        return this.sessionContext.create();
      }
      return this.sessionContext.update();
    } catch (err) {
      logger.warn(`Session context create FAILED: ${err.message}`);
      return null;
    }
  }

  /** Refresh the on-disk context after tool batches / git operations. */
  _sessionCtxUpdate() {
    if (!this.sessionContext) return;
    try {
      this.sessionContext.update();
    } catch (err) {
      logger.warn(`Session context update FAILED: ${err.message}`);
    }
  }

  /** Current session notes, for re-feeding after a chat restart. */
  _sessionCtxSnapshot() {
    if (!this.sessionContext) return '';
    try {
      if (typeof this.sessionContext.asContextString === 'function') {
        const text = this.sessionContext.asContextString() || '';
        return text.length > 2000 ? text.slice(0, 2000) + '\n… (truncated)' : text;
      }
    } catch (_) { /* best effort */ }
    return '';
  }

  /** Delete the ephemeral context file at session end. */
  _sessionCtxDestroy() {
    if (!this.sessionContext) return;
    try {
      this.sessionContext.destroy();
    } catch (err) {
      logger.warn(`Session context destroy FAILED: ${err.message}`);
    }
  }
  
  /**
   * Tripwire: verify that SESSION_CONTEXT.md exists on disk. Called at the end
   * of run() and in shutdown(). A missing file is a WARN, not a throw — the task
   * result is still returned — but the operator now sees the failure instead of
   * discovering it weeks later.
   */
  _sessionCtxVerify() {
    if (!this.sessionContext) {
      logger.warn('Session context: disabled (no instance) — SESSION_CONTEXT.md will not exist');
      return false;
    }
    try {
      if (!this.sessionContext.exists()) {
        logger.warn(`Session context MISSING at ${this.sessionContext.file} — state was not written`);
        return false;
      }
      return true;
    } catch (err) {
      logger.warn(`Session context verify FAILED: ${err.message}`);
      return false;
    }
  }

  /**
   * Restart the chat WITHOUT losing the contract.
   *
   * A fresh chat has no system prompt, no tool list and no call format. The
   * old recovery path sent only "you are a coding agent, continue the task",
   * so the model's next reply was prose, which tripped the correction counter
   * and aborted the run a few steps later. Recovery turned a stall into a
   * guaranteed failure.
   *
   * This re-sends the full system prompt plus the plan and progress, so the
   * model resumes with the same rules it started with.
   *
   * @param {string} task
   * @param {ProgressTracker} progress
   * @returns {Promise<void>}
   */
  async _recoverWithNewChat(task, progress) {
    return this._rotateChat(task, progress, 'the previous chat stopped responding');
  }

  /**
   * Start a fresh chat and re-send the contract plus the state that matters.
   *
   * Used by two callers, deliberately through one code path so they cannot
   * diverge:
   *   - stall recovery (the model stopped answering);
   *   - routine context rotation, every CONTEXT_ROTATION_TURNS turns.
   *
   * Rotation exists because the model's real context window belongs to the
   * remote chat, not to this process. `ConversationManager.compress()` rewrites
   * a local log that is never re-sent, so the remote context keeps growing until
   * the provider silently truncates it — and the model then loses the tool
   * contract and starts replying in prose. Rotating on our own terms, with the
   * contract and a state digest, is the fix.
   *
   * @param {string} task
   * @param {ProgressTracker} progress
   * @param {string} reason  shown to the model
   */
  async _rotateChat(task, progress, reason) {
    logger.warn(`Restarting chat — ${reason}`);

    await this.browser.newChat();
    await sleep(2_000);

    const message = this.conversation.buildResumeMessage({
      task,
      progress: progress.getStatusLine(),
      plan: this._readPlanState(),
      sessionContext: this._sessionCtxSnapshot(),
      recentErrors: typeof progress.recentErrors === 'function'
        ? progress.recentErrors(3)
        : [],
      reason,
      profile: config.ACTIVE_PROFILE,
      workingDir: config.WORKING_DIR,
    });

    // The local log mirrors the new chat: the resume message is the whole
    // history now, so the array cannot grow without bound across rotations.
    this.conversation.resetTo(message);

    await this.browser.sendMessage(message);
    this._turnsSinceRotation = 0;
    logger.dim('  Contract re-sent: system prompt + plan + progress');
  }

  /**
   * Does this tool call need the user's permission?
   *
   * Read-only tools never do. A `run_command` the shell policy allows (npm test,
   * git status, ls) does not either — prompting for every build command trained
   * users to hit "allow all", which defeats the prompt entirely. Anything the
   * policy flags as `confirm`, and every other mutating tool, still asks.
   *
   * @param {string} name
   * @param {object} args
   * @returns {boolean}
   */
  _needsPermission(name, args) {
    if (isReadOnly(name)) return false;

    if (name === 'run_command' && args && typeof args.command === 'string') {
      const verdict = shellPolicy.evaluate(args.command, { policy: config.SHELL_POLICY });
      if (verdict.verdict === 'allow') return false;
    }

    return true;
  }

  /**
   * Redact secrets from a tool result before it is sent to the chat UI.
   *
   * Everything the agent reads leaves the machine: the chat UI is a third-party
   * service and keeps its own history. `.env` files are masked by read_file,
   * but a key in a config module, a k8s manifest or a PEM was forwarded
   * verbatim. The redactor is deliberately narrow (see security.SECRET_PATTERNS)
   * so ordinary source code is never mangled.
   *
   * @param {string} toolName
   * @param {*} result
   * @returns {string}
   */
  _forEgress(toolName, result) {
    const text = typeof result === 'string' ? result : String(result);
    try {
      const { text: safe, redactions } = security.redactSecrets(text);
      if (redactions.length) {
        const summary = redactions.map((r) => `${r.kind}×${r.count}`).join(', ');
        logger.warn(`  ⚠ redacted ${summary} from ${toolName} output before sending`);
      }
      return safe;
    } catch (err) {
      // Never let redaction break a run; fail closed on the side of sending.
      logger.warn(`Secret redaction failed for ${toolName}: ${err.message}`);
      return text;
    }
  }

  /**
   * Current plan state, if the agent has written one. Bounded so a large plan
   * cannot blow the context on a restart.
   *
   * @returns {string|null}
   */
  _readPlanState() {
    try {
      const file = path.join(config.WORKING_DIR || process.cwd(), 'FORGE_PLAN.md');
      if (!fs.existsSync(file)) return null;
      const body = fs.readFileSync(file, 'utf8').trim();
      if (!body) return null;
      return body.length > 2000 ? body.slice(0, 2000) + '\n… (truncated)' : body;
    } catch (_) {
      return null;
    }
  }

  /**
   * Plan gate, task start: refuse the first mutating tool of a multi-step task
   * until FORGE_PLAN.md exists.
   *
   * Returns null when the call may proceed, or the feedback message that should
   * go back to the model instead of executing the tool. A write to FORGE_PLAN.md
   * is always allowed — it is how the gate gets satisfied. Bounded by
   * MAX_PLAN_GATE_ATTEMPTS, after which the gate steps aside rather than
   * blocking the task.
   *
   * @param {string} name
   * @param {object} args
   * @returns {string|null}
   */
  _planGateBeforeTool(name, args) {
    if (!this._planGate) return null;
    // Reading, searching and status checks never need a plan.
    if (isReadOnly(name)) return null;
    if (isPlanWrite(name, args)) return null;

    const decision = decideStart({
      dir: config.WORKING_DIR || process.cwd(),
      task: this._planGate.task,
      attempt: this._planGate.startAttempts,
      maxAttempts: config.MAX_PLAN_GATE_ATTEMPTS,
      enabled: config.PLAN_GATE !== false,
      multistepOnly: config.PLAN_GATE_MULTISTEP_ONLY !== false,
    });

    if (decision.allow) {
      if (decision.exhausted) {
        logger.warn('Plan gate: still no ' + require('./lifecycle').PLAN_FILE +
          ' after ' + this._planGate.startAttempts + ' refusal(s) — continuing without a plan');
      }
      return null;
    }

    this._planGate.startAttempts++;
    logger.warn('Plan gate — ' + decision.errors.join('; '));
    return decision.feedback;
  }

  /**
   * Plan gate, completion: refuse TASK_COMPLETE while the plan still has open
   * steps. Returns null when completion may be accepted, or the feedback to
   * send back. Bounded by MAX_PLAN_GATE_ATTEMPTS.
   *
   * @returns {string|null}
   */
  _planGateBeforeComplete() {
    if (!this._planGate) return null;

    const decision = decideEnd({
      dir: config.WORKING_DIR || process.cwd(),
      attempt: this._planGate.endAttempts,
      maxAttempts: config.MAX_PLAN_GATE_ATTEMPTS,
      enabled: config.PLAN_GATE !== false,
    });

    if (decision.allow) {
      if (decision.reason === 'exhausted') {
        logger.warn('Plan gate: plan still incomplete after ' + this._planGate.endAttempts +
          ' refusal(s) — accepting completion anyway');
      }
      return null;
    }

    this._planGate.endAttempts++;
    logger.warn('Completion refused — ' + decision.errors.join('; '));
    return decision.feedback;
  }

  /**
   * Run a task to completion.
   * Returns the final response string, or a partial summary on timeout.
   */
  async run(task, templateName = null) {
    if (this.commandRouter && this.commandRouter.isCommand(task)) {
      const result = await this.commandRouter.execute(task);
      if (result) console.log('\n' + result + '\n');
      return result || '';
    }

    logger.initTUI(config);
    this._running   = true;
    // Per-run counters. They are instance state, so a second run() on the same
    // agent must not inherit the previous run's streak or recovery count.
    this._emptyStreak = 0;
    this._recoveries = 0;
    this._lastToolCallCountAtFailure = 0;
    this._verifyAttempts = 0;
    this._lastVerification = null;
    // Plan gate counters: refusals issued this run, per gate. Reset per run so a
    // second run() on the same agent gets a fresh budget of attempts.
    this._planGate = { task, startAttempts: 0, endAttempts: 0 };
    this._turnsSinceRotation = 0;
    // Resource envelope for this run: steps, wall clock, tool calls.
    const budget = new Budget(config);
    this._budget = budget;

    // Reactive rate-limit handling: no fixed pause between prompts, back off
    // only when the provider actually says it is throttling.
    this._throttle = new Throttle({
      baseMs: config.RATE_LIMIT_BASE_MS,
      maxMs: config.RATE_LIMIT_MAX_MS,
      maxAttempts: config.RATE_LIMIT_MAX_ATTEMPTS,
    });
    const startTime = Date.now();
    const progress  = new ProgressTracker(task);

    // Phase 1: open the durable session context for this task.
    // Defensive: callers that construct a partial agent (parallel executor,
    // spawn stubs, tests) may not have this helper. State tracking is
    // best-effort and must never abort a task.
    if (typeof this._sessionCtxStart === 'function') {
      this._sessionCtxStart(task);
    }

    // Track consecutive plain-text / unrecognised responses
    // so we can send a correction rather than freezing.
    let _consecutiveUnrecognised = 0;
    const MAX_CORRECTION_ATTEMPTS = 3;

    try {
      // ── 0. Gather memory + project context ────────────────────────────────
      // Both are passed INTO buildFirstMessage. Previously the memory text was
      // prepended to conversation.messages[0], which did not exist yet, so the
      // injection was a no-op.
      let memoryContext = '';
      if (config.MEMORY_ENABLED) {
        try {
          this.memory.extractTechStackFromFiles(config.WORKING_DIR);
          memoryContext = this.memory.buildMemoryContext(config.WORKING_DIR) || '';
        } catch (err) {
          logger.warn(`Failed to inject memory: ${err.message}`);
        }
      }
      const projectContext = [memoryContext, this._buildProjectContextString()]
        .filter(Boolean)
        .join('\n\n');

      // ── 1. Snapshot working directory ──────────────────────────────────────
      const dirListing = this._getWorkingDirListing();

      // ── 2. Build and send first message ───────────────────────────────────
      logger.header(task, {
        model  : config.MODEL    || 'deepseek',
        profile: config.ACTIVE_PROFILE || 'default',
      });

      const profileAddition = getProfileSystemPromptAddition(config.ACTIVE_PROFILE);

      // ── Loom: project orientation for the first message ─────────────────
      // One integration point, one boundary (src/loom/attach.js). A digest
      // that is empty — Loom off, not built, or broken — changes nothing.
      const loomDigest = buildContextDigest({ cwd: config.WORKING_DIR });
      if (loomDigest) {
        if (this.browser && this.browser.adapter &&
            typeof this.browser.adapter.setProjectContext === 'function') {
          this.browser.adapter.setProjectContext(loomDigest);
          logger.dim(`  Loom digest attached (${Math.ceil(loomDigest.length / 4)} tokens)`);
        }
      }

      if (config.PLANNING_MODE) {
        logger.info('Generating execution plan...');
        const planPrompt = buildPlanPrompt(task, dirListing);
        const firstMsg   = this.conversation.buildFirstMessage(
          planPrompt, null, config.ACTIVE_PROFILE, profileAddition,
          { projectContext, workingDir: config.WORKING_DIR }
        );

        try {
          await this.browser.sendMessage(firstMsg);
          const planResponse = await this.browser.waitForResponse();

          const steps = parsePlan(planResponse);
          if (steps.length > 0) {
            process.stdout.write('\n' + formatPlanForDisplay(steps) + '\n');

            const planContext = formatPlanForContext(steps);
            this.conversation.addAssistantMessage(planResponse);
            const feedback = this.conversation.addToolResult('PLANNER', planContext, false);

            logger.info('Starting execution based on plan...');
            await this.browser.sendMessage(feedback);
          } else {
            logger.warn('Could not parse plan. Proceeding with normal execution.');
            const nudge = this.conversation.addToolResult('SYSTEM', 'Please proceed with the task normally.', false);
            await this.browser.sendMessage(nudge);
          }
        } catch (err) {
          logger.warn(`Planning failed: ${err.message}. Proceeding without plan.`);
          const recovery = this.conversation.addToolResult('SYSTEM', 'Planning failed. Please proceed with the task normally.', true);
          await this.browser.sendMessage(recovery);
        }
      } else {
        const firstMsg = this.conversation.buildFirstMessage(
          task, dirListing, config.ACTIVE_PROFILE, profileAddition,
          { projectContext, workingDir: config.WORKING_DIR }
        );

        if (config.DEBUG) {
          logger.dim('--- First message (truncated) ---');
          logger.dim(firstMsg.slice(0, 600) + '...');
        }

        logger.info('Sending task to ' + config.MODEL + '...');

        try {
          await this.browser.sendMessage(firstMsg);
        } catch (err) {
          this._running = false;
          throw err;
        }
      }

      // ── 3. Agent loop ──────────────────────────────────────────────────────
      let step = 1;

      while (true) {
        // Protocol default: every step line carries a short one-liner saying
        // what the step is doing, derived from the previous tool call.

        // Safety circuit breaker — honours MAX_ITERATIONS, MAX_RUNTIME_MS and
        // MAX_TOOL_CALLS. Exceeding it is a normal end state: report what was
        // done rather than throwing out of run().
        try {
          budget.tick();
        } catch (budgetErr) {
          if (!(budgetErr instanceof BudgetExceeded)) throw budgetErr;
          logger.warn(budgetErr.message);
          const summary = progress.buildPartialSummary(budgetErr.message);
          const formatted = format(summary, config.OUTPUT_FORMAT, {
            task, model: config.MODEL, profile: config.ACTIVE_PROFILE, timestamp: config.OUTPUT_TIMESTAMP
          });
          if (config.OUTPUT_FILE) this._saveToFile(config.OUTPUT_FILE, formatted);
          else logger.finalOutput(formatted);
          this._recordHistory(task, 'timeout', startTime, progress, summary, templateName);
          if (this.options.saveLog) await this._saveConversationLog(task, summary);
          this._running = false;
          return summary;
        }

        if (config.DEBUG) {
          const stats = cache.stats();
          logger.dim(`Cache: ${stats.hits} hits, ${stats.misses} misses, ${stats.entries} entries (${stats.hitRate} hit rate)`);
        }

        // ── Wait for response ──────────────────────────────────────────────
        let rawResponse;
        try {
          rawResponse = await this.browser.waitForResponse();
        } catch (err) {
          logger.warn(`Response failed: ${err.message}`);
          progress.recordError(err.message);

          if (this._emptyStreak === undefined) this._emptyStreak = 0;
          this._emptyStreak++;

          // ── Stall escalation ─────────────────────────────────────────────
          // Three levels, in order, each reachable and bounded:
          //   1. nudge   — ask the model to continue
          //   2. recover — restart the chat WITH the contract (bounded)
          //   3. give up — capture diagnostics and return a partial result
          //
          // Before this change level 2 was unreachable: a successful response
          // (the only thing that raises toolCallCount) also resets
          // _emptyStreak, so the "no progress" guard was always true at the
          // threshold and the loop aborted before it could ever recover.
          const recoverAt     = config.EMPTY_RESPONSE_THRESHOLD || 4;
          const giveUpAt      = config.PARTIAL_RESULT_THRESHOLD || 6;
          const maxRecoveries = config.MAX_CHAT_RECOVERIES || 2;

          if (this._emptyStreak >= giveUpAt) {
            logger.warn('Too many consecutive failures — returning partial result.');

            if (config.MEMORY_ENABLED) {
              try { this.memory.recordError(config.WORKING_DIR, 'Repeated response failures'); }
              catch (err) {}
            }

            this._running = false;
            const summary = progress.buildPartialSummary('repeated response failures');
            const formatted = format(summary, config.OUTPUT_FORMAT, {
              task, model: config.MODEL, profile: config.ACTIVE_PROFILE, timestamp: config.OUTPUT_TIMESTAMP
            });
            if (config.OUTPUT_FILE) this._saveToFile(config.OUTPUT_FILE, formatted);
            else logger.finalOutput(formatted);
            this._recordHistory(task, 'timeout', startTime, progress, summary, templateName);
            if (this.options.saveLog) await this._saveConversationLog(task, summary);
            return summary;
          }

          if (this._emptyStreak >= recoverAt) {
            if ((this._recoveries || 0) >= maxRecoveries) {
              // Capture diagnostics before aborting (s.13.2). Best-effort.
              try {
                const { captureFailure } = require('./failure-capture');
                const page = this.browser && this.browser.page;
                const adapterName = this.browser && this.browser.adapter && this.browser.adapter.constructor
                  ? this.browser.adapter.constructor.name : 'unknown';
                await captureFailure(page, 'empty-streak-abort', { adapterName });
              } catch (_) { /* never mask the abort */ }
              logger.error(`Still stalled after ${maxRecoveries} chat restart(s) — aborting.`);
              const summary = progress.buildPartialSummary('stuck in empty response loop');
              this._recordHistory(task, 'failed', startTime, progress, summary, templateName);
              if (this.options.saveLog) await this._saveConversationLog(task, summary);
              this._running = false;
              return summary;
            }

            this._recoveries = (this._recoveries || 0) + 1;
            logger.warn(`Stall ${this._emptyStreak}: restarting chat (recovery ${this._recoveries}/${maxRecoveries})`);
            await this._recoverWithNewChat(task, progress);
          } else {
            await sleep(2_000);
            const nudge = this.conversation.addToolResult(
              'SYSTEM',
              'No response received. Please continue with the next step.',
              true
            );
            await this.browser.sendMessage(nudge);
          }
          step++;
          continue;
        }

        // Clear streak on successful response
        this._emptyStreak = 0;
        this._turnsSinceRotation = (this._turnsSinceRotation || 0) + 1;

        // Routine rotation: keep the remote context bounded on our terms rather
        // than letting the provider truncate it silently. Checked before the
        // reply is parsed, because the reply we just read belongs to the chat we
        // are about to leave — it has already been recorded.
        const rotationTurns = Number(config.CONTEXT_ROTATION_TURNS) || 0;
        if (rotationTurns > 0 && this._turnsSinceRotation >= rotationTurns) {
          await this._rotateChat(
            task, progress,
            `routine rotation after ${this._turnsSinceRotation} turns`
          );
          step++;
          continue;
        }

        // ── Rate limiting ───────────────────────────────────────────────────
        // A throttled reply is transport, not an answer: do not parse it, do
        // not count it as a protocol violation. Back off briefly and re-ask.
        if (config.RATE_LIMIT_BACKOFF !== false && this._throttle.detect(rawResponse)) {
          const waitMs = this._throttle.nextDelayMs();

          if (waitMs < 0) {
            logger.error('Rate limited repeatedly — giving up on this run.');
            const summary = progress.buildPartialSummary('rate limited by the model provider');
            this._recordHistory(task, 'failed', startTime, progress, summary, templateName);
            if (this.options.saveLog) await this._saveConversationLog(task, summary);
            this._running = false;
            return summary;
          }

          logger.warn(`Rate limited (${this._throttle.describe()}) — waiting ${(waitMs / 1000).toFixed(1)}s`);
          progress.recordError('rate limited');
          await sleep(waitMs);

          const retry = this.conversation.addToolResult(
            'SYSTEM',
            'The provider rate-limited that request. Continue with the next step.',
            true
          );
          await this.browser.sendMessage(retry);
          step++;
          continue;
        }

        // A normal reply means the provider is no longer throttling us.
        if (this._throttle) this._throttle.noteSuccess();

        progress.recordAiResponse(rawResponse);

        if (config.DEBUG) {
          logger.dim(`--- Raw response (${rawResponse.length} chars) ---`);
          logger.dim(rawResponse.slice(0, 400));
          // Persist the full pre-parse text so protocol compliance can be
          // inspected offline. Best-effort; never disrupts the run.
          require('./raw-log').writeRawResponse(rawResponse);
        }

        // Record the AI response in conversation history
        this.conversation.addAssistantMessage(rawResponse);

        // Parse the response
        // Parse WITH the tool registry so prose that merely contains JSON, and
        // misspelled tool names, cannot execute. See parser._finalise().
        const parsed = parseResponse(rawResponse, { toolNames: Object.keys(TOOLS) });

        // Step line describes the tool that is ACTUALLY about to run (current
        // intent), not the previous one. Emitted after parsing so the label and
        // the tool-call line below always agree.
        try {
          let _desc;
          if (parsed.type === 'tool_call') {
           _desc = describeStep({ tool: parsed.name, args: parsed.args, maxLen: 60 });
          } else if (parsed.type === 'tool_batch') {
           const n = Array.isArray(parsed.calls) ? parsed.calls.length : 0;
           _desc = 'running ' + n + ' tools';
          } else if (parsed.type === 'final' || parsed.type === 'task_complete') {
           _desc = describeStep({ state: 'answering' });
          } else {
           _desc = describeStep({ state: 'waiting' });
          }
          logger.stepLine(step, progress.elapsedMs, progress, _desc);
        } catch (e) { void e; }

        // Only treat explicitly completed responses as final.
        // Ordinary text must go through Case 4 recovery.
        if (parsed.type === 'text' && hasToolCall(rawResponse)) {
          parsed.type = 'error';
          parsed.message = 'A possible tool call was detected but could not be parsed.';
        }

        // ── Case 0: Tool batch (parallel groups, Item 5) ────────────────────
        if (parsed.type === 'tool_batch') {
          _consecutiveUnrecognised = 0;
          const calls = Array.isArray(parsed.calls) ? parsed.calls : [];
          const _outcome = await this._runToolBatch(calls, progress);
          if (_outcome && _outcome.stop) { this._running = false; return _outcome.content || ''; }
          step++;
          continue;
        }

        // ── Case 1: Tool call ──────────────────────────────────────────────
        if (parsed.type === 'tool_call') {
          // Reset unrecognised counter — model is behaving correctly
          _consecutiveUnrecognised = 0;

          const toolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [parsed];
          const toolCallCount = toolCalls.length;
          if (toolCallCount > 5) {
            logger.warn('⚠ High tool call rate detected — possible loop or prompt injection');
          }
          if (toolCallCount > 10) {
            logger.warn('⚠ Extremely high tool call rate — pausing for 3 seconds...');
            await sleep(3000);
          }

          // Track consecutive identical tool calls
          const currentCall = JSON.stringify({ name: parsed.name, args: parsed.args });
          if (this._lastToolCall === currentCall) {
            this._consecutiveIdenticalCalls = (this._consecutiveIdenticalCalls || 0) + 1;
          } else {
            this._consecutiveIdenticalCalls = 1;
            this._lastToolCall = currentCall;
          }

          if (this._consecutiveIdenticalCalls >= 3) {
            logger.warn(`Identical tool call "${parsed.name}" repeated ${this._consecutiveIdenticalCalls} times — possible infinite loop`);

            if (!process.stdin.isTTY || config.NO_INTERACTIVE) {
              logger.dim('  Non-interactive mode — continuing automatically...');
              this._consecutiveIdenticalCalls = 0;
            } else {
              const choice = await this._askLoopChoice(parsed.name, this._consecutiveIdenticalCalls);

              if (choice === 'c') {
                logger.dim('  Continuing...');
                this._consecutiveIdenticalCalls = 0;
              } else if (choice === 's') {
                logger.dim('  Skipping repeated tool call — asking AI to try differently...');
                this._consecutiveIdenticalCalls = 0;
                const skipMsg = this.conversation.addToolResult(
                  'SYSTEM',
                  `The tool "${parsed.name}" has been called multiple times with similar arguments. ` +
                  `Please try a DIFFERENT approach to accomplish the task. ` +
                  `Consider using a different tool or a different strategy.`,
                  true
                );
                await this.browser.sendMessage(skipMsg);
                step++;
                continue;
              } else if (choice === 'n') {
                logger.info('Starting new task...');
                this._running = false;
                return '';
              } else {
                logger.info('Task stopped by user.');
                this._running = false;
                return '';
              }
            }
          }

          // ── Plan gate ──────────────────────────────────────────────────
          // A multi-step task must have FORGE_PLAN.md before the first
          // mutating tool. Refused here, before the permission prompt, so the
          // user is never asked to approve an action that will not run.
          const _planRefusal = this._planGateBeforeTool(parsed.name, parsed.args);
          if (_planRefusal) {
            progress.recordError('plan gate: no FORGE_PLAN.md');
            const gateMsg = this.conversation.addToolResult('SYSTEM', _planRefusal, true);
            await this.browser.sendMessage(gateMsg);
            step++;
            continue;
          }

          if (this._needsPermission(parsed.name, parsed.args)) {
            const category = getCategory(parsed.name);
            if (!this.permissionStore.isPreApproved(category)) {
              const detail = parsed.args?.path
                ? `${parsed.name} → ${parsed.args.path}`
                : parsed.args?.command
                  ? `${parsed.name} → ${String(parsed.args.command).slice(0, 80)}`
                  : parsed.name;

              const decision = await showPermissionMenu({
                label: CATEGORY_LABELS[category] || category,
                detail,
              });

              if (decision === 'stop') {
                logger.info('Task stopped by user (permission denied).');
                this._running = false;
                return '';
              }

              if (decision === 'deny') {
                logger.warn(`Permission denied for ${parsed.name} — informing AI`);
                const denialMsg = this.conversation.addToolResult(
                  parsed.name,
                  `Permission denied by user. Do not retry the exact same action — try a different approach or continue with other parts of the task.`,
                  true
                );
                await this.browser.sendMessage(denialMsg);
                step++;
                continue;
              }

              this.permissionStore.record(category, decision === 'once' ? null : decision);
            }
          }

          logger.toolCall(parsed.name, parsed.args);
          progress.recordToolCall(parsed.name, parsed.args);
          if (this._budget) this._budget.recordToolCalls(1);

          let result;
          let isError = false;

          try {
            result  = await executeTool(parsed.name, parsed.args);
            logger.toolResult(result, false, parsed.name);
          } catch (err) {
            result  = err.message || String(err);
            isError = true;
            logger.toolResult(result, true, parsed.name);
          }

          if (parsed.name === 'show_info' && !isError) {
            try {
              const answerContent = (result && typeof result === 'object' && result.content)
                ? result.content
                : String(result);
              const answerTitle = (result && typeof result === 'object' && result.title) || null;

              if (answerTitle) {
                logger.getTUI().separator(answerTitle);
              }
              logger.getTUI().renderAnswer(answerContent);
            } catch (renderErr) {
              // Never let display formatting crash the agent — fall back to plain print
              console.log('\n' + String(result) + '\n');
            }
          }

          progress.recordToolResult(parsed.name, result, isError);

          const feedbackMsg = this.conversation.addToolResult(
            parsed.name, this._forEgress(parsed.name, result), isError
          );

          // Phase 1: refresh durable session context after each tool result.
          if (typeof this._sessionCtxUpdate === 'function') {
            this._sessionCtxUpdate();
            if (this.sessionContext && !this.sessionContext.exists()) {
              logger.warn('SESSION_CONTEXT.md disappeared after a tool call — re-creating');
              if (typeof this._sessionCtxStart === 'function') this._sessionCtxStart(task);
            }
          }
          if (!this.sessionContext || !this.sessionContext.exists()) {
            logger.warn('SESSION_CONTEXT.md disappeared after a tool call — re-creating');
            this._sessionCtxStart(task);
          }

          const estimatedTokens = this.conversation.messages
            .reduce((sum, m) => sum + Math.ceil(
              (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).length / 4
            ), 0);
          logger.contextMeter(estimatedTokens, 80000);

          if (this.conversation.shouldCompress(config.CONTEXT_COMPRESSION_THRESHOLD)) {
            logger.dim('Compressing context...');
            this.conversation.compress({ keepRecent: config.CONTEXT_KEEP_RECENT });
          }

          await this.browser.sendMessage(feedbackMsg);
          step++;
          continue;
        }

        // ── Case 1b: Unknown tool name ─────────────────────────────────────
        // One targeted repair ("did you mean read_file?") instead of the
        // executor's full registry dump, and no execution of a partial batch.
        if (parsed.type === 'invalid_tool') {
          _consecutiveUnrecognised++;
          logger.warn(`Unknown tool: ${parsed.name}${parsed.suggestion ? ` (did you mean ${parsed.suggestion}?)` : ''}`);
          progress.recordError(`unknown tool: ${parsed.name}`);

          if (_consecutiveUnrecognised >= MAX_CORRECTION_ATTEMPTS) {
            throw new Error(
              `The AI kept calling tools that do not exist (last: "${parsed.name}"). ` +
              'Check the model response and try again.'
            );
          }

          const hint = parsed.suggestion
            ? `Did you mean "${parsed.suggestion}"?`
            : 'Use one of the names listed under AVAILABLE TOOLS.';
          const repair = this.conversation.addToolResult(
            'SYSTEM',
            `There is no tool called "${parsed.name}". ${hint}\n` +
            'Reply with a single <tool_call> block using an exact tool name.',
            true
          );
          await this.browser.sendMessage(repair);
          step++;
          continue;
        }

        // ── Case 2: Parse error ────────────────────────────────────────────
        if (parsed.type === 'error') {
          _consecutiveUnrecognised = 0;
          logger.warn(`Parse error: ${parsed.message}`);
          progress.recordError(parsed.message);
          const recovery = this.conversation.addToolResult(
            'SYSTEM',
            `Parse error: ${parsed.message}\n\nPlease try again with valid JSON in your tool call.`,
            true
          );
          await this.browser.sendMessage(recovery);
          step++;
          continue;
        }

        // ── Case 3: Final / task_complete response ─────────────────────────
        // Handles both 'final' (old parser) and 'task_complete' (new parser)
        if (parsed.type === 'final' || parsed.type === 'task_complete') {
          _consecutiveUnrecognised = 0;

          // ── Verification gate ────────────────────────────────────────────
          // "Done" must mean done. Run the project's own cheapest check before
          // accepting TASK_COMPLETE. Only commands the project already declares
          // are run (package.json script, Makefile target, cargo/go), never a
          // command assembled from model output. Bounded by
          // MAX_VERIFICATION_ATTEMPTS so a broken project cannot loop forever.
          if (config.VERIFY_BEFORE_COMPLETE !== false &&
              this._verifyAttempts < (config.MAX_VERIFICATION_ATTEMPTS || 2)) {
            const verification = await verifyProject({
              cwd: config.WORKING_DIR,
              timeoutMs: config.VERIFY_TIMEOUT_MS,
            });
            this._lastVerification = verification;

            if (verification.ran && !verification.result.ok) {
              this._verifyAttempts++;
              logger.warn(`Completion refused — ${describeVerification(verification)}`);

              const feedback = this.conversation.addToolResult(
                'SYSTEM',
                [
                  'You said the task is complete, but the project\'s own check failed:',
                  '',
                  '```',
                  verification.result.output || '(no output)',
                  '```',
                  '',
                  'Fix the failure, then finish again. Do not report TASK_COMPLETE until this passes.',
                ].join('\n'),
                true
              );
              await this.browser.sendMessage(feedback);
              step++;
              continue;
            }

            logger.dim(`  ${describeVerification(verification)}`);
          }

          // ── Plan gate ────────────────────────────────────────────────────
          // The project's checks can pass while the agent's own plan still has
          // unchecked steps. Both gates must agree before completion stands.
          const _planEnd = this._planGateBeforeComplete();
          if (_planEnd) {
            progress.recordError('plan gate: plan still open');
            const gateMsg = this.conversation.addToolResult('SYSTEM', _planEnd, true);
            await this.browser.sendMessage(gateMsg);
            step++;
            continue;
          }

          const content = parsed.content || rawResponse;

          // Safety net: if the response looks like a missed tool call
          const looksLikeToolCall = (
            /tool_call/i.test(content) ||
            /"name"\s*:\s*"[\w_]+"/.test(content) ||
            /write_file|read_file|run_command|list_directory/i.test(content.slice(0, 200))
          );

          if (looksLikeToolCall) {
            logger.warn('Response looks like a tool call but was not parsed — asking AI to retry format...');
            const retry = this.conversation.addToolResult(
              'SYSTEM',
              'Your response appeared to contain a tool call but it could not be parsed. ' +
              'Please respond with ONLY a tool call block and nothing else:\n' +
              '<tool_call>\n{"tool": "TOOL_NAME", "args": {}}\n</tool_call>',
              true
            );
            await this.browser.sendMessage(retry);
            step++;
            continue;
          }

          function _looksLikeInformationalAnswer(content, hadAnyToolCalls) {
            if (hadAnyToolCalls) return false; // real work happened — treat as task result
            if (!content) return false;
            // Heuristic: short-to-medium prose, no code fences implying file creation intent,
            // or explicitly answers a question-style task
            const looksExplanatory = /^(react is|a |an |the |this |it is|yes|no|here is an explanation|in short|to summarize)/i.test(content.trim());
            const isShortish = content.length < 4000;
            return isShortish && (looksExplanatory || !/\.(js|py|html|css|json)\b/i.test(content.slice(0, 200)));
          }

          if (_looksLikeInformationalAnswer(content, progress.toolCallCount > 0)) {
            logger.answer(content);
          } else {
            // Build formatted output once, regardless of display mode,
            // so OUTPUT_FILE is honoured consistently.
            const formatted = format(content, config.OUTPUT_FORMAT, {
              task,
              model    : config.MODEL,
              profile  : config.ACTIVE_PROFILE,
              timestamp: config.OUTPUT_TIMESTAMP,
            });

            const tuiAvailable =
              logger.getTUI &&
              typeof logger.getTUI === 'function' &&
              logger.getTUI() &&
              logger.getTUI().noColor === false;

            if (tuiAvailable) {
              // Show the answer exactly once (markdown-rendered), then the
              // completion summary box. Previously both raw `content` AND
              // `formatted` were printed, double-printing the answer.
              logger.answer(content);
              logger.getTUI().renderCompletion(progress, 'completed', {
                verification: describeVerification(this._lastVerification),
                model: config.MODEL,
              });
            } else if (config.OUTPUT_FILE) {
              this._saveToFile(config.OUTPUT_FILE, formatted);
            } else {
              logger.finalOutput(formatted);
            }
          }

          this._recordHistory(task, 'completed', startTime, progress, content, templateName);
          if (templateName) this.templates.incrementUseCount(templateName);
          if (this.options.saveLog) await this._saveConversationLog(task, content);

          try {
            const { showNudgeIfAppropriate } = require('./sponsor');
            showNudgeIfAppropriate(this.history, config, logger);
          } catch (err) {
            // Nudge failures must never crash the agent
          }

          if (config.MEMORY_ENABLED) {
            try {
              this.memory.recordCompletedTask(config.WORKING_DIR, task.slice(0, 100));
              this.memory.recordFilesCreated(config.WORKING_DIR, [...progress.filesWritten]);
            } catch (err) {
              logger.warn(`Failed to record success in memory: ${err.message}`);
            }
          }

          try {
            const _s = require('./run-summary').buildSummary({
              task: task, status: 'completed',
              session: process.env.FORGE_SESSION_NAME || null,
              role: process.env.FORGE_ROLE || null,
              model: config.MODEL || 'deepseek',
              profile: config.ACTIVE_PROFILE || 'default',
              workingDir: config.WORKING_DIR,
              durationMs: Date.now() - startTime,
              stepsCount: progress.toolCallCount,
              filesWritten: [...progress.filesWritten],
              commandsRun: progress.commandsRun.slice(0, 10),
              errorCount: progress.errorCount,
              verification: describeVerification(this._lastVerification),
              finalOutput: content, templateName: templateName
            });
            logger.dim('');
            logger.dim('-- Run summary: ' + _s.session + ' (' + _s.role + ') --');
            logger.dim('  Status : ' + _s.status + ' . ' + _s.duration + ' . ' + _s.steps + ' steps . ' + _s.errorCount + ' errors');
            if (_s.filesWritten.length) logger.dim('  Files  : ' + _s.filesWritten.length + ' written');
            if (_s.commandsRun.length) logger.dim('  Cmds   : ' + _s.commandsRun.length + ' run');
            logger.dim('  Saved  : ~/.forge-agent/sessions/' + _s.session + '/summary.md');
          } catch (_) {}

          this._running = false;
          if (config.DEBUG) {
            const stats = cache.stats();
            logger.dim(`Final Cache Stats: ${stats.hits} hits, ${stats.misses} misses, ${stats.entries} entries (${stats.hitRate} hit rate)`);
          }
          return content;
        }

        // ── Case 4: Plain text / unrecognised type ────────────────────────
        _consecutiveUnrecognised++;

        const content = String(rawResponse || '').trim();

        if (!content) {
          logger.warn('Received an empty or unrecognised response.');
        } else {
          logger.warn('Received plain text instead of a tool call. Requesting retry.');
        }

        // Stop retrying if the AI repeatedly fails to follow the tool protocol.
        if (_consecutiveUnrecognised >= MAX_CORRECTION_ATTEMPTS) {
          throw new Error(
            'The AI repeatedly returned plain text instead of using tools. ' +
            'Please inspect the model response and try again.'
          );
        }

        // Ask the AI to continue using the available tools.
        const correctionMsg = this.conversation.addToolResult(
          'SYSTEM',
          [
            'Your previous response did not contain a valid tool call.',
            'The requested task is not complete.',
            'You MUST use the available tools to perform the requested action.',
            'Review the available tool descriptions and select the appropriate tool.',
            'Use the required tool-call format exactly.',
            'Do not invent a different task or perform unrelated actions.',
            'Do not ask the user for information that is already available.',
            'If the task is genuinely complete, provide a valid task-complete response.'
          ].join('\n'),
          true
        );

        await this.browser.sendMessage(correctionMsg);
        step++;
        continue;
      }

      return '';
    } catch (err) {
      this._running = false;
      this._sessionCtxVerify();   // tripwire: warn if state file missing on failure
      this._recordHistory(task, 'failed', startTime, progress, err.message, templateName);
      throw err;
    } finally {
	  if (typeof this._sessionCtxVerify === 'function') this._sessionCtxVerify();	   // tripwire: warn if state file missing on ANY exit
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async _generatePlan(task) {
    try {
      const { buildPlanningPrompt, parsePlan } = require('./planner');
      const planPrompt = buildPlanningPrompt(task);
      logger.dim('  📋 Generating execution plan...');
      await this.browser.sendMessage(planPrompt);
      const planResponse = await this.browser.waitForResponse();
      const plan = parsePlan(planResponse);
      return plan;
    } catch (e) {
      logger.warn('Plan generation failed: ' + e.message);
      return null;
    }
  }

  async _confirmPlan() {
    return new Promise(resolve => {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      process.stdout.write('\n  Proceed with this plan? [Y/n]: ');
      rl.once('line', line => {
        rl.close();
        const answer = line.trim().toLowerCase();
        resolve(answer === '' || answer === 'y' || answer === 'yes');
      });
    });
  }

  async _askLoopChoice(toolName, count) {
    return new Promise(resolve => {
      const readline = require('readline');
      process.stdout.write('\n');
      process.stdout.write(`  \x1b[33m⚠  "${toolName}" called ${count}x in a row — possible loop\x1b[0m\n`);
      process.stdout.write('  \x1b[90m[c] Continue anyway\x1b[0m\n');
      process.stdout.write('  \x1b[90m[s] Skip — ask AI to try differently\x1b[0m\n');
      process.stdout.write('  \x1b[90m[n] New task\x1b[0m\n');
      process.stdout.write('  \x1b[90m[q] Quit\x1b[0m\n');
      process.stdout.write('  \x1b[90m❯ \x1b[0m');

      const rl = readline.createInterface({ input: process.stdin });
      const timer = setTimeout(() => {
        process.stdout.write('\n  (auto-continuing)\n');
        rl.close();
        resolve('c');
      }, 30_000);

      rl.once('line', line => {
        clearTimeout(timer);
        rl.close();
        const choice = line.trim().toLowerCase();
        resolve(['c','s','n','q'].includes(choice) ? choice : 'c');
      });
    });
  }

  async _runToolBatch(calls, progress) {
    if (!Array.isArray(calls) || calls.length === 0) {
      const emptyMsg = this.conversation.addToolResult('SYSTEM', 'Empty tool batch received. Please emit one or more tool calls.', true);
      await this.browser.sendMessage(emptyMsg);
      return { stop: false };
    }

    // Plan gate: one refusal for the whole batch. Nothing in it runs, so a
    // batch cannot smuggle a mutating call past the gate.
    const _firstMutating = calls.find((c) => c && c.name && !isReadOnly(c.name));
    if (_firstMutating) {
      const refusal = this._planGateBeforeTool(_firstMutating.name, _firstMutating.args);
      if (refusal) {
        progress.recordError('plan gate: no FORGE_PLAN.md');
        const gateMsg = this.conversation.addToolResult('SYSTEM', refusal, true);
        await this.browser.sendMessage(gateMsg);
        return { stop: false };
      }
    }

    for (const c of calls) {
      if (!c || !c.name || !this._needsPermission(c.name, c.args)) continue;
      const category = getCategory(c.name);
      if (this.permissionStore.isPreApproved(category)) continue;
      const detail = c.args?.path
        ? c.name + ' -> ' + c.args.path
        : c.args?.command
          ? c.name + ' -> ' + String(c.args.command).slice(0, 80)
          : c.name;
      const decision = await showPermissionMenu({
        label: CATEGORY_LABELS[category] || category,
        detail,
      });
      if (decision === 'stop') {
        logger.info('Task stopped by user (permission denied).');
        return { stop: true, content: '' };
      }
      if (decision === 'deny') {
        logger.warn('Permission denied for ' + c.name + ' - informing AI');
        const denialMsg = this.conversation.addToolResult(
          c.name,
          'Permission denied by user for a tool in the batch. Do not retry the exact same action - try a different approach or continue with other parts of the task.',
          true
        );
        await this.browser.sendMessage(denialMsg);
        return { stop: false, denied: true };
      }
      this.permissionStore.record(category, decision === 'once' ? null : decision);
    }

    for (const c of calls) {
      logger.toolCall(c.name, c.args);
      progress.recordToolCall(c.name, c.args);
    }
    if (this._budget) this._budget.recordToolCalls(calls.length);

    let results;
    try {
      results = await executeBatch(calls, {
        executeTool,
        cwd: config.WORKING_DIR || process.cwd(),
        maxParallel: config.PARALLEL_TOOL_CALLS === false ? 1 : (config.MAX_PARALLEL_TOOL_CALLS || 4),
      });
    } catch (err) {
      logger.warn('Batch execution failed: ' + err.message);
      const recovery = this.conversation.addToolResult('SYSTEM', 'Batch execution failed: ' + err.message + '. Please retry with individual tool calls.', true);
      await this.browser.sendMessage(recovery);
      return { stop: false };
    }

    const parts = [];
    let anyError = false;
    for (const r of results) {
      logger.toolResult(r.result, r.isError, r.name);
      progress.recordToolResult(r.name, r.result, r.isError);
      if (r.isError) anyError = true;
      const status = r.isError ? 'ERROR' : 'SUCCESS';
      parts.push('[TOOL RESULT: ' + r.name + ' | ' + status + ']\n' + this._forEgress(r.name, r.result) + '\n[END TOOL RESULT]');
    }

    const combined =
      '[TOOL RESULT: BATCH | ' + (anyError ? 'PARTIAL ERROR' : 'SUCCESS') + ']\n' +
      'You issued ' + calls.length + ' tool call(s) in one turn. Results are labelled and in the SAME ORDER you requested:\n\n' +
      parts.join('\n\n') +
      '\n\nContinue with the next step, or provide your final response if the task is complete.';

    this.conversation.messages.push({ role: 'user', content: combined });

    // Phase 1: refresh durable session context after a tool batch.
    this._sessionCtxUpdate();

    const estimatedTokens = this.conversation.messages
      .reduce((sum, m) => sum + Math.ceil(
        (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).length / 4
      ), 0);
    logger.contextMeter(estimatedTokens, 80000);

    if (this.conversation.shouldCompress(config.CONTEXT_COMPRESSION_THRESHOLD)) {
      logger.dim('Compressing context...');
      this.conversation.compress({ keepRecent: config.CONTEXT_KEEP_RECENT });
    }

    await this.browser.sendMessage(combined);
    return { stop: false };
  }

  _buildProjectContextString() {
    if (!this.projectContext) return '';
    return this.projectContext.buildContextString();
  }

  _extractTaskSummary(output) {
    if (!output) return '';
    const lines = output.split('\n').filter(l => l.trim());
    return lines.slice(0, 3).join(' ').slice(0, 300);
  }

  _getWorkingDirListing() {
    const SKIP = new Set(['.git']);

    try {
      const profile = getProfile(config.ACTIVE_PROFILE);
      if (profile.ignoredPatterns) {
        profile.ignoredPatterns.forEach(p => SKIP.has(p) || SKIP.add(p));
      }
    } catch {
      ['node_modules', 'dist', '.next', 'build'].forEach(p => SKIP.add(p));
    }

    const results = [];

    function walk(dir, depth) {
      if (depth > 3 || results.length >= 80) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
        if (e.name.endsWith('.lock')) continue;
        const rel = path.relative(config.WORKING_DIR, path.join(dir, e.name));
        results.push('./' + rel.split(path.sep).join('/'));
        if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
      }
    }

    try {
      walk(config.WORKING_DIR, 0);
      return results.length > 0 ? results.sort().join('\n') : '(empty directory)';
    } catch {
      return '(could not read directory)';
    }
  }

  async _saveConversationLog(task, finalResponse) {
    try {
      const logsDir = require('./paths').forgePath('logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const logFile = path.join(logsDir, `session-${ts}.txt`);
      const content = [
        `Forge Agent — Session Log`,
        `Date: ${new Date().toISOString()}`,
        `Task: ${task}`,
        `Working Dir: ${config.WORKING_DIR}`,
        '═'.repeat(60),
        this.conversation.exportLog(),
        '',
        '═'.repeat(60),
        'FINAL RESPONSE:',
        finalResponse,
      ].join('\n');

      fs.writeFileSync(logFile, content, 'utf8');
      logger.dim(`Conversation saved: ${logFile}`);
    } catch (err) {
      logger.warn(`Could not save log: ${err.message}`);
    }
  }

  _saveToFile(filePath, content) {
    try {
      const outPath = path.resolve(filePath);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, content, 'utf8');
      logger.success(`Output saved to ${filePath}`);
    } catch (err) {
      logger.warn(`Failed to save output to ${filePath}: ${err.message}`);
      logger.finalOutput(content);
    }
  }

  _recordHistory(task, status, startTime, progress, result, templateName = null) {
    try {
      this.history.addEntry({
        task,
        taskShort: task.slice(0, 80),
        workingDir: config.WORKING_DIR,
        model: config.MODEL || 'deepseek',
        profile: config.ACTIVE_PROFILE || 'default',
        role:     process.env.FORGE_ROLE         || null,
        session:  process.env.FORGE_SESSION_NAME || null,
        status,
        durationMs: Date.now() - startTime,
        stepsCount: progress.toolCallCount,
        filesWritten: [...progress.filesWritten],
        commandsRun: progress.commandsRun.slice(0, 10),
        errorCount: progress.errorCount,
        finalOutput: (result || '').slice(0, 500),
        templateName
      });
    } catch (err) {
      // History failures must never crash the agent
    }

    try {
      require('./run-summary').writeSummary({
        task: task,
        status: status,
        session: process.env.FORGE_SESSION_NAME || null,
        role: process.env.FORGE_ROLE || null,
        model: config.MODEL || 'deepseek',
        profile: config.ACTIVE_PROFILE || 'default',
        workingDir: config.WORKING_DIR,
        durationMs: Date.now() - startTime,
        stepsCount: progress.toolCallCount,
        filesWritten: [...progress.filesWritten],
        commandsRun: progress.commandsRun.slice(0, 10),
        errorCount: progress.errorCount,
        finalOutput: (result || '').slice(0, 2000),
        templateName: templateName
      });
    } catch (_) {}
  }
}

module.exports = ForgeAgent;