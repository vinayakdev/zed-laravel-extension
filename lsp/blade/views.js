'use strict';

const fs   = require('fs');
const path = require('path');

// ── View path resolution ─────────────────────────────────────────────────────

function getViewNameFromUri(uri, root) {
  const filePath = decodeURIComponent(uri.replace(/^file:\/\//, ''));
  const viewsDir = path.join(root, 'resources', 'views') + path.sep;
  if (!filePath.startsWith(viewsDir)) return null;
  return filePath
    .slice(viewsDir.length)
    .replace(/\.blade\.php$/, '')
    .split(path.sep)
    .join('.');
}

function resolveViewPath(viewName, root) {
  return path.join(root, 'resources', 'views', viewName.replace(/\./g, '/') + '.blade.php');
}

function createBladeFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '<div>\n\n</div>\n');
}

// ── Variable inference (from PHP view() calls) ───────────────────────────────

function collectPhpFiles(dir, out) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) collectPhpFiles(full, out);
      else if (e.name.endsWith('.php')) out.push(full);
    }
  } catch (_) {}
}

function extractArrayKeys(text) {
  const vars = [];
  let depth = 0, inner = '';
  for (let i = 0; i < text.length; i++) {
    if      (text[i] === '[') { depth++; if (depth === 1) continue; }
    else if (text[i] === ']') { depth--; if (depth === 0) break;    }
    if (depth >= 1) inner += text[i];
  }
  const re = /['"]([^'"]+)['"]\s*=>/g;
  let m;
  while ((m = re.exec(inner)) !== null) vars.push(m[1]);
  return vars;
}

function extractCompactArgs(text) {
  const vars  = [];
  const inner = text.match(/^compact\s*\(([^)]*)\)/);
  if (!inner) return vars;
  const re = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(inner[1])) !== null) vars.push(m[1]);
  return vars;
}

function findViewVariables(viewName, root) {
  const vars  = new Set();
  const files = [];
  for (const dir of ['app', 'routes']) collectPhpFiles(path.join(root, dir), files);
  try {
    for (const f of fs.readdirSync(root))
      if (f.endsWith('.php')) files.push(path.join(root, f));
  } catch (_) {}

  const escaped = viewName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const callRe  = new RegExp(`view\\s*\\(\\s*['"]${escaped}['"]\\s*,\\s*`, 'g');

  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    callRe.lastIndex = 0;
    let m;
    while ((m = callRe.exec(content)) !== null) {
      const after = content.slice(callRe.lastIndex).trimStart();
      const extracted = after.startsWith('compact')
        ? extractCompactArgs(after)
        : after.startsWith('[')
          ? extractArrayKeys(after)
          : [];
      for (const v of extracted) vars.add(v);
    }
  }
  return [...vars];
}

// ── view() call detection (for Go to Definition) ────────────────────────────

function findViewAtPosition(text, line, character) {
  const lineText  = text.split('\n')[line] || '';
  const viewRegex = /view\s*\(\s*(['"])([^'"]+)\1/g;
  let match;
  while ((match = viewRegex.exec(lineText)) !== null) {
    if (character >= match.index && character <= viewRegex.lastIndex)
      return match[2];
  }
  return null;
}

module.exports = {
  getViewNameFromUri,
  resolveViewPath,
  createBladeFile,
  findViewVariables,
  findViewAtPosition,
};
