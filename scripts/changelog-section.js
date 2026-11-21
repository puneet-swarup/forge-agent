#!/usr/bin/env node
// scripts/changelog-section.js — extract one version's section from CHANGELOG.md.
//
// Used by the release workflow so a GitHub Release carries the notes a human
// actually wrote, instead of GitHub's auto-generated list of merge commits.
//
// Usage:
//   node scripts/changelog-section.js 2.2.0        print the section
//   node scripts/changelog-section.js v2.2.0       (leading v is ignored)
//   node scripts/changelog-section.js --latest     the newest version
//
// Exit 1 with a message on stderr when the version is not in the file, so a
// release fails loudly rather than publishing empty notes.
'use strict';

const fs = require('fs');
const path = require('path');

const CHANGELOG = path.join(__dirname, '..', 'CHANGELOG.md');

/** Version headings look like `## [2.2.0] - 2026-11-21` or `## 2.2.0`. */
const HEADING = /^##\s+\[?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\]?/;

/**
 * Split the changelog into { version, body } sections, newest first.
 * @param {string} markdown
 * @returns {Array<{version: string, body: string}>}
 */
function parseSections(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const m = line.match(HEADING);
    if (m) {
      if (current) sections.push(current);
      current = { version: m[1], body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);

  return sections.map((s) => ({
    version: s.version,
    body: s.body.join('\n').replace(/^\s*---\s*$/gm, '').trim(),
  }));
}

/**
 * @param {string} markdown
 * @param {string} [version]  omit for the newest section
 * @returns {{version: string, body: string}|null}
 */
function findSection(markdown, version) {
  const sections = parseSections(markdown);
  if (sections.length === 0) return null;

  if (!version) return sections[0];
  const wanted = String(version).replace(/^v/, '');
  return sections.find((s) => s.version === wanted) || null;
}

function main(argv) {
  const arg = argv[2];

  if (!fs.existsSync(CHANGELOG)) {
    process.stderr.write('CHANGELOG.md not found\n');
    process.exit(1);
  }

  const markdown = fs.readFileSync(CHANGELOG, 'utf8');
  const section = findSection(markdown, arg === '--latest' ? undefined : arg);

  if (!section) {
    process.stderr.write(
      `No CHANGELOG section for "${arg || '(latest)'}". Add one before releasing.\n`
    );
    process.exit(1);
  }

  process.stdout.write(`## ${section.version}\n\n${section.body}\n`);
}

if (require.main === module) main(process.argv);

module.exports = { parseSections, findSection };
