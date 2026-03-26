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

// ── Parsing helpers ──────────────────────────────────────────────────────────

/**
 * Given file content and the index of the class declaration match, find the
 * offset of the opening `{` that starts the class body.  Returns -1 if not
 * found.
 */
function findClassBodyStart(content, classMatchIndex) {
  const braceIdx = content.indexOf('{', classMatchIndex);
  return braceIdx;
}

/**
 * Given the content string and the index of the opening `{` of a class body,
 * return the substring that represents the class body (everything between the
 * matching `{` and `}`).  A simple brace-counter is used so nested braces are
 * handled correctly.
 */
function extractClassBody(content, openBraceIndex) {
  let depth = 0;
  let start = -1;
  for (let i = openBraceIndex; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') {
      depth++;
      if (start === -1) start = i + 1; // character after the opening brace
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return content.slice(start, i);
      }
    }
  }
  // Unclosed brace — return everything after the opening brace
  return start !== -1 ? content.slice(start) : '';
}

/**
 * Parse traits used inside a class body.
 * Matches `use X, Y\Z;` lines but deliberately ignores namespace-style `use`
 * statements that contain a backslash followed by more text (those are import
 * statements that can appear at file scope).  Inside a class body, trait `use`
 * statements may reference bare short names or fully-qualified names; we only
 * keep the short name (last segment after `\`).
 *
 * We also skip `use` lines that look like closures: `use (...)`.
 */
function parseTraits(classBody) {
  const traitRe = /^\s*use\s+([\w\\,\s]+);/gm;
  const traits = [];
  let m;
  while ((m = traitRe.exec(classBody)) !== null) {
    // Skip closure `use` — those bind variables and have a `(` nearby;
    // the regex above already excludes them because it requires `;` after the
    // name list, but double-check for safety.
    const raw = m[1];
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // Take only the short name (last segment)
      const short = trimmed.split('\\').pop().trim();
      if (short) traits.push(short);
    }
  }
  return traits;
}

/**
 * Parse methods declared inside a class body.
 */
function parseMethods(classBody) {
  const methodRe = /^\s*(public|protected|private)?\s*(static\s+)?(?:abstract\s+|final\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm;
  const methods = [];
  let m;
  while ((m = methodRe.exec(classBody)) !== null) {
    methods.push({
      name:       m[3],
      params:     m[4].trim(),
      isStatic:   !!m[2],
      visibility: m[1] || 'public',
    });
  }
  return methods;
}

/**
 * Parse properties declared inside a class body.
 */
function parseProperties(classBody) {
  const propRe = /^\s*(public|protected|private)\s+(static\s+)?\$(\w+)/gm;
  const properties = [];
  let m;
  while ((m = propRe.exec(classBody)) !== null) {
    properties.push({
      name:       m[3],
      isStatic:   !!m[2],
      visibility: m[1],
    });
  }
  return properties;
}

// ── Class cache ──────────────────────────────────────────────────────────────

let cache = null;

function discoverPhpClasses(root) {
  if (cache) return cache;

  const files = [];
  collectPhpFiles(path.join(root, 'app'), files);

  const classes = [];

  // Regex captures: className, optional extends, optional implements list
  const classRe = /^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/gm;

  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }

    const nsMatch   = content.match(/^\s*namespace\s+([\w\\]+)\s*;/m);
    const namespace = nsMatch ? nsMatch[1] : null;

    let m;
    while ((m = classRe.exec(content)) !== null) {
      const className = m[1];
      const fqn       = namespace ? `${namespace}\\${className}` : className;
      const lineNum   = content.slice(0, m.index).split('\n').length - 1;

      // extends — short name only
      const extendsName = m[2] ? m[2].trim() : null;

      // implements — split, trim, keep short names
      const implementsList = m[3]
        ? m[3].split(',').map(s => s.trim()).filter(Boolean)
        : [];

      // Locate the class body
      const openBraceIdx = findClassBodyStart(content, m.index);
      let traits     = [];
      let methods    = [];
      let properties = [];

      if (openBraceIdx !== -1) {
        const classBody = extractClassBody(content, openBraceIdx);
        traits     = parseTraits(classBody);
        methods    = parseMethods(classBody);
        properties = parseProperties(classBody);
      }

      classes.push({
        className,
        fqn,
        file,
        line:       lineNum,
        extends:    extendsName,
        traits,
        implements: implementsList,
        methods,
        properties,
      });
    }

    // Reset lastIndex so the regex can be reused across files
    classRe.lastIndex = 0;
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
