// tests/detokenize.test.js - guardrail for the token->char transport protocol
'use strict';

const { detokenize, TOKENS, CH } = require('../scripts/detokenize');

const BS = String.fromCharCode(92);
const ST = String.fromCharCode(42);
const QM = String.fromCharCode(63);
const BT = String.fromCharCode(96);

describe('detokenize', () => {
  test('converts every token to its character', () => {
    expect(detokenize('@@BS@@')).toBe(BS);
    expect(detokenize('@@ST@@')).toBe(ST);
    expect(detokenize('@@QM@@')).toBe(QM);
    expect(detokenize('@@BT@@')).toBe(BT);
  });

  test('exposes the char table', () => {
    expect(CH.BS).toBe(BS);
    expect(CH.ST).toBe(ST);
    expect(TOKENS.length).toBeGreaterThanOrEqual(5);
  });

  test('leaves text without tokens untouched', () => {
    const plain = 'const x = 1; // hello { } ( ) [ ]';
    expect(detokenize(plain)).toBe(plain);
  });

  test('decodes a realistic regex-escape line', () => {
    // template for the classic regex-escape line (backslashes via @@BS@@)
    const tpl =
      '    .replace(/[.+^{}()|[' + '@@BS@@@@BS@@' + ']' + '@@BS@@@@BS@@' + ']/g, ' +
      String.fromCharCode(39) + '@@BS@@$&' + String.fromCharCode(39) + ')';
    const out = detokenize(tpl);
    // must contain two consecutive backslashes and a backslash-dollar
    expect(out.indexOf(BS + BS)).toBeGreaterThanOrEqual(0);
    expect(out.indexOf(BS + '$')).toBeGreaterThanOrEqual(0);
  });

  test('decodes the glob star and question rules', () => {
    // .replace(/\/g, '[^/]')
    const starTpl = '.replace(/' + '@@BS@@' + '@@ST@@' + '/g, ' +
      String.fromCharCode(39) + '[^/]@@ST@@' + String.fromCharCode(39) + ')';
    const starOut = detokenize(starTpl);
    expect(starOut.indexOf(BS + ST)).toBeGreaterThanOrEqual(0);
    expect(starOut.indexOf(']' + ST)).toBeGreaterThanOrEqual(0);

    // .replace(/\?/g, '[^/]')
    const qTpl = '.replace(/' + '@@BS@@' + '@@QM@@' + '/g, ' +
      String.fromCharCode(39) + '[^/]' + String.fromCharCode(39) + ')';
    const qOut = detokenize(qTpl);
    expect(qOut.indexOf(BS + QM)).toBeGreaterThanOrEqual(0);
  });

  test('is idempotent on already-decoded text', () => {
    const once = detokenize('a@@BS@@b');
    expect(detokenize(once)).toBe(once);
  });

  test('handles multiple tokens on one line', () => {
    expect(detokenize('@@BS@@x@@ST@@y@@QM@@z')).toBe(BS + 'x' + ST + 'y' + QM + 'z');
  });
});
