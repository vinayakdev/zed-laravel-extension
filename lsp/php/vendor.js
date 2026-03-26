'use strict';

const fs   = require('fs');
const path = require('path');

// ── Caches ────────────────────────────────────────────────────────────────────

/** Map<root, Map<fqn, absoluteFilePath>> — populated once per workspace root */
const classmapCache = new Map();

/** Map<className, entry> — parsed vendor class entries, never invalidated */
const vendorClassCache = new Map();

// ── Classmap parser ───────────────────────────────────────────────────────────

/**
 * Parse vendor/composer/autoload_classmap.php and return a Map<fqn, filePath>.
 * Uses regex only — never eval/require PHP.
 */
function parseClassmap(root) {
  if (classmapCache.has(root)) {
    return classmapCache.get(root);
  }

  const map = new Map();
  const classmapPath = path.join(root, 'vendor', 'composer', 'autoload_classmap.php');

  let content;
  try {
    content = fs.readFileSync(classmapPath, 'utf8');
  } catch (_) {
    classmapCache.set(root, map);
    return map;
  }

  const baseDir   = root;
  const vendorDir = path.join(root, 'vendor');

  // Match lines like: 'App\Models\User' => $baseDir . '/app/Models/User.php',
  const lineRe = /['"]([^'"]+)['"]\s*=>\s*\$(\w+)\s*\.\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = lineRe.exec(content)) !== null) {
    const fqn      = m[1];
    const varName  = m[2];   // 'baseDir' or 'vendorDir'
    const relPath  = m[3];   // e.g. '/app/Models/User.php'

    let absPath;
    if (varName === 'baseDir') {
      absPath = baseDir + relPath;
    } else if (varName === 'vendorDir') {
      absPath = vendorDir + relPath;
    } else {
      // Unknown variable — skip
      continue;
    }

    map.set(fqn, absPath);
  }

  classmapCache.set(root, map);
  return map;
}

// ── FQN resolver from use statements ─────────────────────────────────────────

/**
 * Given the text of a PHP file and a short class name (or alias), find the
 * fully-qualified name from the file's `use` statements.
 *
 * Handles:
 *   use Full\Qualified\ClassName;
 *   use Full\Qualified\OriginalName as Alias;
 */
function fqnFromUseStatements(fileText, className) {
  const re = /^\s*use\s+([\w\\]+(?:\\(\w+))?)\s*(?:as\s+(\w+))?\s*;/gm;
  let m;
  while ((m = re.exec(fileText)) !== null) {
    const fullName  = m[1];                          // e.g. Full\Qualified\Panel
    const alias     = m[3] || null;                  // e.g. Panel (if aliased)
    const shortName = fullName.split('\\').pop();    // last segment

    const matchesAlias = alias && alias === className;
    const matchesShort = !alias && shortName === className;

    if (matchesAlias || matchesShort) {
      return fullName;
    }
  }
  return null;
}

// ── PHP file parser ───────────────────────────────────────────────────────────

// Reuse the same helpers as discovery.js

function findClassBodyStart(content, classMatchIndex) {
  return content.indexOf('{', classMatchIndex);
}

function extractClassBody(content, openBraceIndex) {
  let depth = 0;
  let start = -1;
  for (let i = openBraceIndex; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') {
      depth++;
      if (start === -1) start = i + 1;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return content.slice(start, i);
      }
    }
  }
  return start !== -1 ? content.slice(start) : '';
}

function parseTraits(classBody) {
  const traitRe = /^\s*use\s+([\w\\,\s]+);/gm;
  const traits = [];
  let m;
  while ((m = traitRe.exec(classBody)) !== null) {
    for (const part of m[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const short = trimmed.split('\\').pop().trim();
      if (short) traits.push(short);
    }
  }
  return traits;
}

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
  return classBody.slice(start).trim();
}

function parseMethods(classBody) {
  const methodRe = /^\s*(public|protected|private)?\s*(static\s+)?(?:abstract\s+|final\s+)?function\s+(\w+)\s*\(/gm;
  const methods = [];
  let m;
  while ((m = methodRe.exec(classBody)) !== null) {
    const openParenIdx = m.index + m[0].length - 1;
    methods.push({
      name:       m[3],
      params:     extractMethodParams(classBody, openParenIdx),
      isStatic:   !!m[2],
      visibility: m[1] || 'public',
    });
  }
  return methods;
}

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

/**
 * Parse a single PHP file and return a class entry (same shape as discovery.js).
 * Returns null if no class declaration is found or the file cannot be read.
 */
function parseVendorFile(filePath, expectedClassName) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }

  const classRe = /^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/m;
  const classMatch = classRe.exec(content);
  if (!classMatch) return null;

  const className = classMatch[1];
  const lineNum   = content.slice(0, classMatch.index).split('\n').length - 1;

  const nsMatch   = content.match(/^\s*namespace\s+([\w\\]+)\s*;/m);
  const namespace = nsMatch ? nsMatch[1] : null;
  const fqn       = namespace ? `${namespace}\\${className}` : className;

  const extendsName    = classMatch[2] ? classMatch[2].trim() : null;
  const implementsList = classMatch[3]
    ? classMatch[3].split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const openBraceIdx = findClassBodyStart(content, classMatch.index);
  let traits     = [];
  let methods    = [];
  let properties = [];

  if (openBraceIdx !== -1) {
    const classBody = extractClassBody(content, openBraceIdx);
    traits     = parseTraits(classBody);
    methods    = parseMethods(classBody);
    properties = parseProperties(classBody);
  }

  return {
    className:  expectedClassName || className,
    fqn,
    file:       filePath,
    line:       lineNum,
    extends:    extendsName,
    traits,
    implements: implementsList,
    methods,
    properties,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up a vendor class by short name (or alias).
 *
 * @param {string} className  - Short class name as it appears in the source file
 * @param {string} fileText   - Full text of the file that references the class
 * @param {string} root       - Absolute path to the workspace root
 * @returns {object|null}     - Class entry or null if not found
 */
function getVendorClass(className, fileText, root) {
  // Return cached result if available
  if (vendorClassCache.has(className)) {
    return vendorClassCache.get(className);
  }

  // 1. Resolve FQN from use statements in the calling file
  const fqn = fqnFromUseStatements(fileText, className);
  if (!fqn) return null;

  // 2. Look up file path in the classmap
  const classmap = parseClassmap(root);
  const filePath = classmap.get(fqn);
  if (!filePath) return null;

  // 3. Parse the vendor file
  const entry = parseVendorFile(filePath, className);
  if (!entry) return null;

  // 4. Cache and return
  vendorClassCache.set(className, entry);
  return entry;
}

/**
 * Invalidate the classmap cache (e.g. when workspace root changes).
 * Does not invalidate parsed vendor class entries.
 */
function invalidateClassmap() {
  classmapCache.clear();
}

module.exports = { getVendorClass, invalidateClassmap };
