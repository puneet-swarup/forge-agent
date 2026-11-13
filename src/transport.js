// src/transport.js — Opaque, corruption-resistant argument transport.
'use strict';

function decodeTransportArg(value, isBase64, label) {
  if (typeof value !== 'string') {
    throw new Error('Transport arg "' + label + '" must be a string, got ' + typeof value);
  }
  if (!isBase64) {
    const buffer = Buffer.from(value, 'utf8');
    return { buffer: buffer, text: value };
  }

  // Strip whitespace/newlines MIME encoders insert every 76 chars.
  const cleaned = value.replace(/\s+/g, '');
  if (cleaned.length === 0) {
    return { buffer: Buffer.alloc(0), text: '' };
  }
  if (/[^A-Za-z0-9+/=]/.test(cleaned)) {
    throw new Error('Transport arg "' + label + '" is not valid base64 (non-base64 characters present)');
  }

  // Tolerate missing padding (RFC 4648 §3.2). Length % 4 === 1 is impossible.
  const rem = cleaned.length % 4;
  if (rem === 1) {
    throw new Error('Transport arg "' + label + '" is not valid base64 (length mod 4 == 1)');
  }
  const padded = rem === 0 ? cleaned : cleaned + '='.repeat(4 - rem);

  const buffer = Buffer.from(padded, 'base64');

  // Round-trip integrity: Buffer.from(...,'base64') silently drops bad input,
  // so re-encode and compare to what we parsed. NOTE the /g flag is REQUIRED.
  const canonical = buffer.toString('base64').replace(/=+$/g, '');
  const expected  = padded.replace(/=+$/g, '');
  if (canonical !== expected) {
    throw new Error('Transport arg "' + label + '" failed base64 round-trip integrity check');
  }

  return { buffer: buffer, text: buffer.toString('utf8') };
}

module.exports = { decodeTransportArg };