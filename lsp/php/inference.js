'use strict';

/**
 * Scans backward in the current PHP function body to infer the type of a
 * variable from its assignment.
 */

const RE_NEW = /\$(\w+)\s*=\s*new\s+([A-Z]\w*)\s*[({;]/;
const RE_STATIC = /\$(\w+)\s*=\s*([A-Z]\w*)::[\w]+\s*\(/;
const RE_PHPDOC = /@var\s+([A-Z]\w+)\s+\$(\w+)/;

const RE_FUNCTION = /\bfunction\s+\w+\s*\(/;
const RE_CLASS = /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/;

/**
 * Returns the class name assigned to `varName` within the enclosing function
 * body, scanning lines above `cursorLine`.
 *
 * @param {string} varName   - Variable name WITHOUT the leading `$`
 * @param {string} fileText  - Full text of the PHP file
 * @param {number} cursorLine - 0-indexed line number of the cursor
 * @returns {string|null}
 */
function inferVariableType(varName, fileText, cursorLine) {
  const lines = fileText.split('\n');

  // --- 1. Find the enclosing function boundary ---

  let functionLine = -1;
  for (let i = cursorLine - 1; i >= 0; i--) {
    if (RE_FUNCTION.test(lines[i])) {
      functionLine = i;
      break;
    }
  }

  // If no enclosing function found, scan from the top of the file.
  let bodyStartLine = 0;
  if (functionLine >= 0) {
    // Scan forward from the function declaration to find the opening `{`.
    for (let i = functionLine; i <= cursorLine; i++) {
      if (lines[i].includes('{')) {
        bodyStartLine = i;
        break;
      }
    }
  }

  // --- 2. Scan lines in [bodyStartLine, cursorLine) for assignments ---

  let lastMatch = null;

  for (let i = bodyStartLine; i < cursorLine; i++) {
    const line = lines[i];

    // PHPDoc @var annotation
    const docMatch = RE_PHPDOC.exec(line);
    if (docMatch) {
      // docMatch[1] = ClassName, docMatch[2] = varName (without $)
      if (docMatch[2] === varName) {
        lastMatch = docMatch[1];
      }
      continue;
    }

    // $var = new ClassName( / $var = new ClassName;
    const newMatch = RE_NEW.exec(line);
    if (newMatch) {
      if (newMatch[1] === varName) {
        lastMatch = newMatch[2];
      }
      continue;
    }

    // $var = ClassName::anything(
    const staticMatch = RE_STATIC.exec(line);
    if (staticMatch) {
      if (staticMatch[1] === varName) {
        lastMatch = staticMatch[2];
      }
      continue;
    }
  }

  return lastMatch;
}

/**
 * Returns the class name that the cursor is currently inside.
 * Scans backward from `cursorLine` for a class declaration.
 *
 * @param {string} fileText   - Full text of the PHP file
 * @param {number} cursorLine - 0-indexed line number of the cursor
 * @returns {string|null}
 */
function inferCurrentClass(fileText, cursorLine) {
  const lines = fileText.split('\n');
  const limit = Math.max(0, cursorLine - 500);

  for (let i = cursorLine; i >= limit; i--) {
    const match = RE_CLASS.exec(lines[i]);
    if (match) {
      return match[1];
    }
  }

  return null;
}

module.exports = {
  inferVariableType,
  inferCurrentClass,
};
