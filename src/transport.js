// src/transport.js — integrity-checked argument transport.
//
// Why this exists
// ---------------
// Tool arguments cross a lossy channel: the model writes text, the browser UI
// renders it, the scraper extracts it, the parser unescapes it. Any of those
// steps can drop a character, collapse a newline or mangle a `$`. A truncated
// write is worse than a failed write, because the tool reports success.
//
// This module gives an argument an end-to-end check:
//
//   encode  text -> { value, md5, is_base64 | is_hex }      (caller-side helper)
//   decode  { value, md5, encoding } -> bytes + verified    (tool-side)
//
// When a hash is supplied and does not match what arrived, decode throws. It
// never returns bytes it cannot vouch for.
//
// Honest limitation
// -----------------
// The hash must be computed by the SENDER. For an LLM that is reliable on short
// strings and unreliable on large ones, so treat a match as proof the payload
// survived intact, and a mismatch as a hard stop — but do not assume the model
// will always supply a hash. Absent a hash, behaviour is unchanged from before
// (base64 round-trip check only). See docs/RELIABILITY.md §10.
'use strict';

const crypto = require('crypto');

const MD5_RE = /^[a-f0-9]{32}$/i;

/** Lower-case hex MD5 of a string or Buffer. */
function md5hex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return crypto.createHash('md5').update(buf).digest('hex');
}

/** True when `value` looks like an MD5 digest (32 hex chars). */
function isMd5(value) {
  return typeof value === 'string' && MD5_RE.test(value.trim());
}

/**
 * Encode text for transport. Used by callers that want to hand a payload over
 * safely (plugins, tests, and any future tool that generates arguments).
 *
 * @param {string|Buffer} input
 * @param {'base64'|'hex'} [encoding]
 * @returns {{value: string, md5: string, is_base64: boolean, is_hex: boolean}}
 */
function encodeTransportArg(input, encoding = 'base64') {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');

  if (encoding === 'hex') {
    return { value: buf.toString('hex'), md5: md5hex(buf), is_base64: false, is_hex: true };
  }
  if (encoding !== 'base64') {
    throw new Error(`encodeTransportArg: unknown encoding "${encoding}" (use "base64" or "hex")`);
  }
  return { value: buf.toString('base64'), md5: md5hex(buf), is_base64: true, is_hex: false };
}

/**
 * Decode a tool argument and, when a hash is supplied, verify it.
 *
 * Two calling conventions are supported:
 *   decodeTransportArg(value, isBase64, label)                  legacy
 *   decodeTransportArg(value, { isBase64, isHex, md5, label })  current
 *
 * @param {string} value
 * @param {boolean|object} optsOrIsBase64
 * @param {string} [label]
 * @returns {{buffer: Buffer, text: string, md5: string, verified: boolean}}
 */
function decodeTransportArg(value, optsOrIsBase64, label) {
  const opts = (optsOrIsBase64 && typeof optsOrIsBase64 === 'object')
    ? optsOrIsBase64
    : { isBase64: !!optsOrIsBase64, label };

  const name = opts.label || label || 'argument';

  if (typeof value !== 'string') {
    throw new Error(`Transport arg "${name}" must be a string, got ${typeof value}`);
  }

  const buffer = opts.isHex
    ? decodeHex(value, name)
    : (opts.isBase64 ? decodeBase64(value, name) : Buffer.from(value, 'utf8'));

  const actual = md5hex(buffer);
  const expected = typeof opts.md5 === 'string' ? opts.md5.trim().toLowerCase() : '';

  if (expected) {
    if (!isMd5(expected)) {
      throw new Error(
        `Transport arg "${name}": md5 must be 32 hex characters, got "${opts.md5}"`
      );
    }
    if (actual !== expected) {
      // Fail closed. Writing bytes we cannot vouch for is how a file gets
      // silently truncated.
      throw new Error(
        `Transport arg "${name}" failed its MD5 integrity check ` +
        `(expected ${expected}, received ${actual}). ` +
        `The payload was altered in transit; nothing was written.`
      );
    }
  }

  return {
    buffer,
    text: buffer.toString('utf8'),
    md5: actual,
    verified: Boolean(expected),
  };
}

// ── encodings ──────────────────────────────────────────────────────────────

function decodeBase64(value, name) {
  // Strip the newlines MIME encoders insert every 76 characters.
  const cleaned = value.replace(/\s+/g, '');

  if (cleaned.length === 0) return Buffer.alloc(0);

  if (/[^A-Za-z0-9+/=]/.test(cleaned)) {
    throw new Error(`Transport arg "${name}" is not valid base64 (non-base64 characters present)`);
  }

  // Tolerate missing padding (RFC 4648 §3.2). Length % 4 === 1 is impossible.
  const rem = cleaned.length % 4;
  if (rem === 1) {
    throw new Error(`Transport arg "${name}" is not valid base64 (length mod 4 == 1)`);
  }
  const padded = rem === 0 ? cleaned : cleaned + '='.repeat(4 - rem);

  const buffer = Buffer.from(padded, 'base64');

  // Round-trip check: Buffer.from(..., 'base64') silently drops bad input, so
  // re-encode and compare with what we parsed. The /g flag is REQUIRED.
  const canonical = buffer.toString('base64').replace(/=+$/g, '');
  const expected = padded.replace(/=+$/g, '');
  if (canonical !== expected) {
    throw new Error(`Transport arg "${name}" failed base64 round-trip integrity check`);
  }

  return buffer;
}

function decodeHex(value, name) {
  const cleaned = value.replace(/\s+/g, '');

  if (cleaned.length === 0) return Buffer.alloc(0);

  if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw new Error(`Transport arg "${name}" is not valid hex (non-hex characters present)`);
  }
  if (cleaned.length % 2 !== 0) {
    throw new Error(`Transport arg "${name}" is not valid hex (odd number of digits)`);
  }

  const buffer = Buffer.from(cleaned, 'hex');

  // Same reasoning as base64: verify we consumed exactly what was sent.
  if (buffer.toString('hex') !== cleaned.toLowerCase()) {
    throw new Error(`Transport arg "${name}" failed hex round-trip integrity check`);
  }

  return buffer;
}

module.exports = {
  decodeTransportArg,
  encodeTransportArg,
  md5hex,
  isMd5,
};
