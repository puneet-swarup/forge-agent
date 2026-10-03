// benchmarks/parallel-latency.bench.js
// Demonstrates the wall-clock latency difference between sequential and
// parallel execution of the SAME batch of independent tool calls.
'use strict';

const { executeBatch } = require('../src/parallel-executor');

// Simulate a realistic tool: a fixed I/O delay.
function makeTool(delayMs) {
  return async (name, args) => {
    await new Promise(r => setTimeout(r, delayMs));
    return name + ':' + (args && args.path ? args.path : '');
  };
}

// A batch of fully independent calls (different files => no conflict).
function independentBatch(n) {
  const calls = [];
  for (let i = 0; i < n; i++) {
    calls.push({ name: i % 2 === 0 ? 'write_file' : 'read_file', args: { path: 'file' + i + '.txt' } });
  }
  return calls;
}

async function timeRun(calls, maxParallel, delayMs) {
  const exec = makeTool(delayMs);
  const start = process.hrtime.bigint();
  const results = await executeBatch(calls, { executeTool: exec, cwd: '.', maxParallel });
  const end = process.hrtime.bigint();
  return { ms: Number(end - start) / 1e6, results };
}

async function main() {
  const DELAY = 100;

  console.log('=== Parallel Tool Latency Benchmark ===');
  console.log('Tool simulated delay : ' + DELAY + ' ms per call');
  console.log('');

  // Warm-up (JIT + module caches)
  await timeRun(independentBatch(1), 1, 5);

  const sizes = [6, 12, 24];
  const caps  = [1, 2, 4];

  const header = ['batch', ...caps.map(c => 'max=' + c), 'best speedup'];
  console.log('Independent calls (all different files, no conflicts):');
  console.log('  ' + header[0].padEnd(6) + header.slice(1).map(h => h.padStart(14)).join(''));

  let overall = null;
  for (const n of sizes) {
    const calls = independentBatch(n);
    const row = [];
    let seqMs = null;
    let bestPar = Infinity;
    for (const cap of caps) {
      const r = await timeRun(calls, cap, DELAY);
      if (cap === 1) seqMs = r.ms;
      else bestPar = Math.min(bestPar, r.ms);
      row.push(r.ms.toFixed(0) + ' ms');
    }
    const sp = seqMs / bestPar;
    console.log('  ' + String(n).padEnd(6) + row.map(v => v.padStart(14)).join('') + ('  ' + sp.toFixed(2) + 'x').padStart(14));
    if (n === 6) overall = { seq: seqMs, par: bestPar, speedup: sp };
  }
  console.log('');

  // Detailed single-batch view (batch=6, cap=4)
  const calls6 = independentBatch(6);
  const seq = await timeRun(calls6, 1, DELAY);
  const par = await timeRun(calls6, 4, DELAY);
  console.log('Detailed view (batch=6, maxParallel=4):');
  console.log('  Sequential : ' + seq.ms.toFixed(1) + ' ms');
  console.log('  Parallel   : ' + par.ms.toFixed(1) + ' ms');
  console.log('  Speed-up   : ' + (seq.ms / par.ms).toFixed(2) + 'x   (time saved ' + (seq.ms - par.ms).toFixed(1) + ' ms)');

  const sameOrder = seq.results.every((r, i) => r.name === par.results[i].name && r.result === par.results[i].result);
  console.log('  Results identical & in same order: ' + (sameOrder ? 'YES' : 'NO'));

  return overall;
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { main };
