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
 * Extract the raw parameter string for a method whose opening `(` is at
 * `openParenIdx` inside `classBody`.  Uses a brace-depth counter so nested
 * parentheses in default values (e.g. `$x = foo()`) are handled correctly.
 */
function extractMethodParams(classBody, openParenIdx) {
  let depth = 0;
  const start = openParenIdx + 1;
  for (let i = openParenIdx; i < classBody.length; i++) {
    if      (classBody[i] === '(') depth++;
    else if (classBody[i] === ')') {
      depth--;
      if (depth === 0) return classBody.slice(start, i).trim();
    }
  }
  return classBody.slice(start).trim(); // unclosed paren — return remainder
}

/**
 * Scan backward from `matchIndex` through blank lines, single-line comments,
 * PHPDoc lines, and other PHP attributes to look for `#[Scope]`.
 * Returns true if found, false if a "real" non-attribute line is hit first.
 */
function hasAttributeScope(classBody, matchIndex) {
  const lines = classBody.slice(0, matchIndex).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === '')                                           continue; // blank
    if (t.startsWith('//'))                                continue; // inline comment
    if (t.startsWith('*') || t.startsWith('/*') || t.endsWith('*/')) continue; // PHPDoc
    if (/^#\[Scope(\([^)]*\))?\]/.test(t))               return true; // #[Scope] or #[Scope(...)]
    if (t.startsWith('#['))                                continue; // other attribute
    break; // hit a real line of code — stop
  }
  return false;
}

/**
 * Parse methods declared inside a class body.
 * Detects local scope methods in two styles:
 *   - New: `#[Scope]` PHP attribute anywhere in the preceding annotation block
 *   - Old: method name prefixed with `scope` + uppercase letter (e.g. `scopePopular`)
 * Scope methods are marked `isScope: true` with a `scopeName` (the caller-facing name).
 *
 * Params are extracted with a balanced-paren scanner so nested parens in
 * default values (e.g. `$type = strtolower(foo())`) don't truncate early.
 */
function parseMethods(classBody) {
  // Match up to and including the opening '(' — params extracted separately
  const methodRe = /^\s*(public|protected|private)?\s*(static\s+)?(?:abstract\s+|final\s+)?function\s+(\w+)\s*\(/gm;
  const methods = [];
  let m;
  while ((m = methodRe.exec(classBody)) !== null) {
    const name       = m[3];
    const visibility = m[1] || 'public';
    const isStatic   = !!m[2];

    // Opening '(' is the last character of the match
    const openParenIdx = m.index + m[0].length - 1;
    const params       = extractMethodParams(classBody, openParenIdx);

    // Detect #[Scope] anywhere in the preceding annotation block
    const scopeAttr = hasAttributeScope(classBody, m.index);

    // Detect old-style scopeXxx naming convention
    const oldScopeMatch = name.match(/^scope([A-Z]\w*)$/);

    let isScope   = false;
    let scopeName = null;
    if (scopeAttr) {
      isScope   = true;
      scopeName = name; // attribute style: method name IS the scope name
    } else if (oldScopeMatch) {
      isScope   = true;
      // scopePopular → popular, scopeOfType → ofType
      scopeName = oldScopeMatch[1].charAt(0).toLowerCase() + oldScopeMatch[1].slice(1);
    }

    methods.push({ name, params, isStatic, visibility, isScope, scopeName });
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
