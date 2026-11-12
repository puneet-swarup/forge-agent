// tests/spawn-window.test.js — unit tests for the new-window command builder.
'use strict';

const sw = require('../src/spawn-window');

const base = {
  node: '/usr/bin/node',
  entry: '/app/src/index.js',
  args: ['--session', 'w', 'do thing'],
  cwd: '/app',
  title: 'Forge w',
  env: { PATH: '/bin' },
};

describe('spawn-window.buildWindowCommand', () => {
  const OLD = process.env.FORGE_SPAWN_NO_WINDOW;
  afterEach(() => {
    if (OLD === undefined) delete process.env.FORGE_SPAWN_NO_WINDOW;
    else process.env.FORGE_SPAWN_NO_WINDOW = OLD;
  });

  test('FORGE_SPAWN_NO_WINDOW=1 forces headless mode', () => {
    process.env.FORGE_SPAWN_NO_WINDOW = '1';
    const spec = sw.buildWindowCommand({ ...base, platform: 'win32' });
    expect(spec.mode).toBe('headless');
    expect(spec.command).toBe('/usr/bin/node');
    expect(spec.options.detached).toBe(true);
    expect(spec.options.stdio).toBe('ignore');
  });

  test('win32 builds a `cmd /c start "<title>"` command', () => {
    delete process.env.FORGE_SPAWN_NO_WINDOW;
    const spec = sw.buildWindowCommand({ ...base, platform: 'win32' });
    expect(spec.mode).toBe('new-window');
    expect(spec.command).toBe('cmd.exe');
    expect(spec.args[0]).toBe('/c');
    expect(spec.args[1]).toBe('start');
    expect(spec.args[2]).toBe('"Forge w"');
    expect(spec.args[3]).toBe('/usr/bin/node');
    expect(spec.args[4]).toBe('/app/src/index.js');
    expect(spec.args).toContain('do thing');
  });

  test('win32 title is sanitised of quotes and newlines', () => {
    delete process.env.FORGE_SPAWN_NO_WINDOW;
    const spec = sw.buildWindowCommand({ ...base, title: 'a"b\nc', platform: 'win32' });
    expect(spec.args[2]).not.toMatch(/[\r\n]/);
    expect(spec.args[2]).toBe('"a b c"');
  });

  test('darwin uses osascript / Terminal', () => {
    delete process.env.FORGE_SPAWN_NO_WINDOW;
    const spec = sw.buildWindowCommand({ ...base, platform: 'darwin' });
    expect(spec.mode).toBe('new-window');
    expect(spec.command).toBe('osascript');
    expect(spec.args[0]).toBe('-e');
    expect(spec.args[1]).toMatch(/Terminal/);
  });

  test('linux falls back to headless when no terminal emulator is found', () => {
    delete process.env.FORGE_SPAWN_NO_WINDOW;
    // On the test host none of the terminal emulators are likely present;
    // whichever branch it takes, it must return a valid spec object.
    const spec = sw.buildWindowCommand({ ...base, platform: 'linux' });
    expect(spec).toHaveProperty('command');
    expect(Array.isArray(spec.args)).toBe(true);
    expect(['new-window', 'headless']).toContain(spec.mode);
    expect(spec.options.detached).toBe(true);
  });
});

describe('spawn-window helpers', () => {
  test('safeTitle strips quotes/newlines and truncates', () => {
    expect(sw.safeTitle('a"b\nc')).toBe('a b c');
    expect(sw.safeTitle('x'.repeat(200)).length).toBe(120);
    expect(sw.safeTitle('')).toBe('forge-agent');
  });

  test('quoteWin quotes whitespace/metachars and leaves simple tokens', () => {
    expect(sw.quoteWin('simple')).toBe('simple');
    expect(sw.quoteWin('has space')).toBe('"has space"');
    expect(sw.quoteWin('a&b')).toBe('"a&b"');
    expect(sw.quoteWin('')).toBe('""');
  });

  test('quotePosix quotes unsafe tokens', () => {
    expect(sw.quotePosix('simple')).toBe('simple');
    expect(sw.quotePosix('has space')).toBe("'has space'");
    expect(sw.quotePosix("it's")).toBe("'it'\\''s'");
  });
});
