'use strict';

const fs   = require('fs');
const path = require('path');

// ── File collection ──────────────────────────────────────────────────────────

function collectPhpFiles(dir, out) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) collectPhpFiles(full, out);
      else if (e.name.endsWith('.php')) out.push(full);
    }
  } catch (_) {}
}

// ── Class cache ──────────────────────────────────────────────────────────────

let cache = null;

function discoverPhpClasses(root) {
  if (cache) return cache;

  const files = [];
  collectPhpFiles(path.join(root, 'app'), files);

  const classes = [];
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }

    const nsMatch   = content.match(/^\s*namespace\s+([\w\\]+)\s*;/m);
    const namespace = nsMatch ? nsMatch[1] : null;

    const classRe = /^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+(\w+)/gm;
    let m;
    while ((m = classRe.exec(content)) !== null) {
      const className = m[1];
      const fqn       = namespace ? `${namespace}\\${className}` : className;
      const lineNum   = content.slice(0, m.index).split('\n').length - 1;
      classes.push({ className, fqn, file, line: lineNum });
    }
  }

  return (cache = classes);
}

function invalidateCache() { cache = null; }

// ── Import helpers ───────────────────────────────────────────────────────────

function getUseInsertLine(text) {
  const lines = text.split('\n');
  let lastUse = -1, namespaceLine = -1, phpTag = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (phpTag       === -1 && t.startsWith('<?php'))  phpTag        = i;
    if (t.startsWith('namespace '))                     namespaceLine = i;
    if (t.startsWith('use '))                           lastUse       = i;
  }
  if (lastUse       >= 0) return lastUse + 1;
  if (namespaceLine >= 0) return namespaceLine + 2;
  if (phpTag        >= 0) return phpTag + 2;
  return 0;
}

function isAlreadyImported(text, fqn) {
  const esc = fqn.replace(/\\/g, '\\\\');
  return new RegExp(`^\\s*use\\s+${esc}(\\s+as\\s+|;)`, 'm').test(text);
}

module.exports = { collectPhpFiles, discoverPhpClasses, invalidateCache, getUseInsertLine, isAlreadyImported };
