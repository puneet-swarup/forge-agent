// scripts/ui-seed.js — create a live demo instance for UI screenshotting
'use strict';
const registry = require('../src/session-registry');
const eventLog = require('../src/event-log');

const name = 'demo-inst';
process.env.FORGE_SESSION_NAME = name;
process.env.FORGE_ROLE = 'backend';
const dir = registry.sessionDirFor(name);
process.env.FORGE_SESSION_DIR = dir;

registry.writeHeartbeat({ model: 'deepseek', profile: 'backend', status: 'running' });

eventLog.emit('task', { task: 'build a REST API with Express and JWT' }, { sessionDir: dir });
eventLog.emit('step', { step: 1 }, { sessionDir: dir });
eventLog.emit('tool_call', { name: 'write_file', args: { path: 'server.js' } }, { sessionDir: dir });
eventLog.emit('tool_result', { name: 'write_file', result: 'Wrote 1.2 KB to server.js', isError: false }, { sessionDir: dir });
eventLog.emit('tool_call', { name: 'run_command', args: { command: 'npm test' } }, { sessionDir: dir });
eventLog.emit('error', { message: 'Command failed: npm test (exit 1)' }, { sessionDir: dir });
eventLog.emit('tool_call', { name: 'replace_in_file', args: { path: 'src/auth.js' } }, { sessionDir: dir });
eventLog.emit('tool_result', { name: 'replace_in_file', result: 'Replaced 1 occurrence(s) in src/auth.js', isError: false }, { sessionDir: dir });
eventLog.emit('final', { content: 'Server scaffolded, auth wired up, tests green.' }, { sessionDir: dir });

console.log('seeded ' + dir);
setInterval(() => { registry.updateHeartbeat('running'); }, 3000);
