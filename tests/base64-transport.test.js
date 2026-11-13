'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { TOOLS } = require('../src/tools.js');

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

describe('Base64 transport - write_file / append_to_file / replace_in_file / write_files', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-b64-'));
    process.env.STRICT_SANDBOX = 'false';
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  test('write_file with is_base64 decodes UTF-8 round-trip', async () => {
    const target = path.join(tmpDir, 'utf8.txt');
    const payload = 'h\u00e9llo \u4e16\u754c \u2014 emoji \ud83d\ude80 and {braces} $dollars\n';
    await TOOLS.write_file.execute({ path: target, content: b64(payload), is_base64: true });
    expect(fs.readFileSync(target, 'utf8')).toBe(payload);
  });

  test('write_file without is_base64 keeps the raw text intact', async () => {
    const target = path.join(tmpDir, 'plain.txt');
    const payload = 'const x = { a: 1, b: "two" };\n';
    await TOOLS.write_file.execute({ path: target, content: payload });
    expect(fs.readFileSync(target, 'utf8')).toBe(payload);
  });

  test('append_to_file supports mixed base64 + plain appends', async () => {
    const target = path.join(tmpDir, 'append.txt');
    await TOOLS.append_to_file.execute({ path: target, content: b64('A'), is_base64: true });
    await TOOLS.append_to_file.execute({ path: target, content: 'B' });
    await TOOLS.append_to_file.execute({ path: target, content: b64('C'), is_base64: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('ABC');
  });

  test('replace_in_file with is_base64 decodes both find and replace', async () => {
    const target = path.join(tmpDir, 'replace.txt');
    fs.writeFileSync(target, 'pre XX mid XX post', 'utf8');
    const result = await TOOLS.replace_in_file.execute({
      path: target,
      find: b64('XX'),
      replace: b64('{Y}$Y'),
      is_base64: true,
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('pre {Y}$Y mid {Y}$Y post');
    expect(result).toMatch(/Replaced 2 occurrence/);
  });

  test('replace_in_file plain path still works when is_base64 is false', async () => {
    const target = path.join(tmpDir, 'replace-plain.txt');
    fs.writeFileSync(target, 'a-XX-b-XX-c', 'utf8');
    await TOOLS.replace_in_file.execute({
      path: target,
      find: 'XX',
      replace: 'YY',
      all_occurrences: false,
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('a-YY-b-XX-c');
  });

  test('write_files honours per-item is_base64 independently', async () => {
    const a = path.join(tmpDir, 'multi-a.txt');
    const b = path.join(tmpDir, 'multi-b.txt');
    await TOOLS.write_files.execute({
      files: [
        { path: a, content: b64('encoded {a}'), is_base64: true },
        { path: b, content: 'plain {b}' },
      ],
    });
    expect(fs.readFileSync(a, 'utf8')).toBe('encoded {a}');
    expect(fs.readFileSync(b, 'utf8')).toBe('plain {b}');
  });

  // Changed contract: invalid base64 must fail loudly, not write garbage.
  // This is the fix for docs/AGENT_TRANSPORT_DIAGNOSTIC.md Defect 3.
  test('write_file rejects invalid base64 loudly and writes nothing', async () => {
    const target = path.join(tmpDir, 'invalid.txt');
    await expect(
      TOOLS.write_file.execute({ path: target, content: '!!!not base64!!!', is_base64: true })
    ).rejects.toThrow(/not valid base64/);
    expect(fs.existsSync(target)).toBe(false);
  });

  // Sanity: whitespace-padded base64 (MIME style) must still succeed.
  test('write_file tolerates MIME-wrapped base64', async () => {
    const target = path.join(tmpDir, 'mime.txt');
    const raw = 'hello\nworld';
    const wrapped = Buffer.from(raw, 'utf8').toString('base64').replace(/(.{4})/g, '$1\n');
    await TOOLS.write_file.execute({ path: target, content: wrapped, is_base64: true });
    expect(fs.readFileSync(target, 'utf8')).toBe(raw);
  });
});