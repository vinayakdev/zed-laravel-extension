#!/usr/bin/env node
// Laravel LSP — single server for PHP + Blade in Zed
// ─────────────────────────────────────────────────────────────────────────────
// §1  Infrastructure    send / URI helpers / file-type guards / fs utils
// §2  PHP › Discovery   class cache, namespace extraction, import helpers
// §3  PHP › Completions class import, ClassName::method, ->chain
// §4  PHP › Definition  jump to class declaration
// §5  Blade › Views     path resolution, variable inference, file creation
// §6  Blade › Completions  @directives, $variables
// §7  Message handler   routes LSP methods to the sections above
// §8  JSON-RPC parser   stdin framing
// ─────────────────────────────────────────────────────────────────────────────

'use strict';
const fs   = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// §1  INFRASTRUCTURE
// ══════════════════════════════════════════════════════════════════════════════

let documents      = {};   // uri → full text
let workspaceRoot  = null;
let nextRequestId  = 1;

function send(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

function uriToPath(uri)      { return decodeURIComponent(uri.replace(/^file:\/\//, '')); }
function pathToUri(filePath) { return 'file://' + filePath; }

function isBladeFile(uri) { return uri.endsWith('.blade.php'); }
function isPhpFile(uri)   { return uri.endsWith('.php') && !isBladeFile(uri); }

function collectPhpFiles(dir, out) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) collectPhpFiles(full, out);
      else if (e.name.endsWith('.php')) out.push(full);
    }
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// §2  PHP › DISCOVERY & IMPORT HELPERS
// ══════════════════════════════════════════════════════════════════════════════

let phpClassCache = null;

function discoverPhpClasses(root) {
  if (phpClassCache) return phpClassCache;

  const files = [];
  collectPhpFiles(path.join(root, 'app'), files);

  const classes = [];
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }

    const nsMatch  = content.match(/^\s*namespace\s+([\w\\]+)\s*;/m);
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

  return (phpClassCache = classes);
}

// Line at which to insert a new `use` statement
function getUseInsertLine(text) {
  const lines = text.split('\n');
  let lastUse = -1, namespaceLine = -1, phpTag = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (phpTag       === -1 && t.startsWith('<?php'))     phpTag       = i;
    if (t.startsWith('namespace '))                        namespaceLine = i;
    if (t.startsWith('use '))                              lastUse       = i;
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

// ══════════════════════════════════════════════════════════════════════════════
// §3  PHP › COMPLETIONS
// ══════════════════════════════════════════════════════════════════════════════

// ── 3a. Eloquent static-call methods (Model::...) ───────────────────────────
const ELOQUENT_METHODS = [
  { name: 'all',            snippet: 'all()' },
  { name: 'get',            snippet: 'get()' },
  { name: 'find',           snippet: 'find(${1:$id})' },
  { name: 'findOrFail',     snippet: 'findOrFail(${1:$id})' },
  { name: 'findMany',       snippet: 'findMany([${1:$ids}])' },
  { name: 'first',          snippet: 'first()' },
  { name: 'firstOrFail',    snippet: 'firstOrFail()' },
  { name: 'firstOrCreate',  snippet: 'firstOrCreate([${1:}])' },
  { name: 'firstOrNew',     snippet: 'firstOrNew([${1:}])' },
  { name: 'create',         snippet: 'create([${1:}])' },
  { name: 'forceCreate',    snippet: 'forceCreate([${1:}])' },
  { name: 'updateOrCreate', snippet: 'updateOrCreate([${1:}], [${2:}])' },
  { name: 'destroy',        snippet: 'destroy(${1:$id})' },
  { name: 'truncate',       snippet: 'truncate()' },
  { name: 'query',          snippet: 'query()' },
  { name: 'where',          snippet: "where('${1:column}', ${2:'value'})" },
  { name: 'whereIn',        snippet: "whereIn('${1:column}', [${2:}])" },
  { name: 'whereNotIn',     snippet: "whereNotIn('${1:column}', [${2:}])" },
  { name: 'whereBetween',   snippet: "whereBetween('${1:column}', [${2:min}, ${3:max}])" },
  { name: 'whereNull',      snippet: "whereNull('${1:column}')" },
  { name: 'whereNotNull',   snippet: "whereNotNull('${1:column}')" },
  { name: 'with',           snippet: "with('${1:relation}')" },
  { name: 'withCount',      snippet: "withCount('${1:relation}')" },
  { name: 'has',            snippet: "has('${1:relation}')" },
  { name: 'doesntHave',     snippet: "doesntHave('${1:relation}')" },
  { name: 'whereHas',       snippet: "whereHas('${1:relation}', function (\\$q) {\n    ${2:}\n})" },
  { name: 'orderBy',        snippet: "orderBy('${1:column}', '${2:asc}')" },
  { name: 'orderByDesc',    snippet: "orderByDesc('${1:column}')" },
  { name: 'latest',         snippet: 'latest()' },
  { name: 'oldest',         snippet: 'oldest()' },
  { name: 'paginate',       snippet: 'paginate(${1:15})' },
  { name: 'simplePaginate', snippet: 'simplePaginate(${1:15})' },
  { name: 'cursorPaginate', snippet: 'cursorPaginate(${1:15})' },
  { name: 'pluck',          snippet: "pluck('${1:column}')" },
  { name: 'value',          snippet: "value('${1:column}')" },
  { name: 'count',          snippet: 'count()' },
  { name: 'sum',            snippet: "sum('${1:column}')" },
  { name: 'avg',            snippet: "avg('${1:column}')" },
  { name: 'max',            snippet: "max('${1:column}')" },
  { name: 'min',            snippet: "min('${1:column}')" },
  { name: 'exists',         snippet: 'exists()' },
  { name: 'doesntExist',    snippet: 'doesntExist()' },
  { name: 'select',         snippet: "select('${1:column}')" },
  { name: 'distinct',       snippet: 'distinct()' },
  { name: 'limit',          snippet: 'limit(${1:10})' },
  { name: 'take',           snippet: 'take(${1:10})' },
  { name: 'skip',           snippet: 'skip(${1:0})' },
  { name: 'chunk',          snippet: 'chunk(${1:100}, function (\\$items) {\n    ${2:}\n})' },
  { name: 'each',           snippet: 'each(function (\\$item) {\n    ${1:}\n})' },
  { name: 'increment',      snippet: "increment('${1:column}')" },
  { name: 'decrement',      snippet: "decrement('${1:column}')" },
  { name: 'update',         snippet: 'update([${1:}])' },
  { name: 'delete',         snippet: 'delete()' },
  { name: 'forceDelete',    snippet: 'forceDelete()' },
  { name: 'restore',        snippet: 'restore()' },
  { name: 'withTrashed',    snippet: 'withTrashed()' },
  { name: 'onlyTrashed',    snippet: 'onlyTrashed()' },
];

// ── 3b. Query-builder chain methods (used after ->) ─────────────────────────
const CHAIN_METHODS = [
  // Terminal — return results
  { name: 'get',            snippet: 'get()' },
  { name: 'first',          snippet: 'first()' },
  { name: 'firstOrFail',    snippet: 'firstOrFail()' },
  { name: 'firstOrCreate',  snippet: 'firstOrCreate([${1:}])' },
  { name: 'firstOrNew',     snippet: 'firstOrNew([${1:}])' },
  { name: 'find',           snippet: 'find(${1:$id})' },
  { name: 'findOrFail',     snippet: 'findOrFail(${1:$id})' },
  { name: 'all',            snippet: 'all()' },
  { name: 'count',          snippet: 'count()' },
  { name: 'exists',         snippet: 'exists()' },
  { name: 'doesntExist',    snippet: 'doesntExist()' },
  { name: 'paginate',       snippet: 'paginate(${1:15})' },
  { name: 'simplePaginate', snippet: 'simplePaginate(${1:15})' },
  { name: 'cursorPaginate', snippet: 'cursorPaginate(${1:15})' },
  { name: 'pluck',          snippet: "pluck('${1:column}')" },
  { name: 'value',          snippet: "value('${1:column}')" },
  { name: 'sum',            snippet: "sum('${1:column}')" },
  { name: 'avg',            snippet: "avg('${1:column}')" },
  { name: 'max',            snippet: "max('${1:column}')" },
  { name: 'min',            snippet: "min('${1:column}')" },
  { name: 'chunk',          snippet: 'chunk(${1:100}, function (\\$items) {\n    ${2:}\n})' },
  { name: 'each',           snippet: 'each(function (\\$item) {\n    ${1:}\n})' },
  { name: 'toArray',        snippet: 'toArray()' },
  { name: 'toJson',         snippet: 'toJson()' },
  // Constraints — keep building the query
  { name: 'where',          snippet: "where('${1:column}', ${2:'value'})" },
  { name: 'orWhere',        snippet: "orWhere('${1:column}', ${2:'value'})" },
  { name: 'whereIn',        snippet: "whereIn('${1:column}', [${2:}])" },
  { name: 'whereNotIn',     snippet: "whereNotIn('${1:column}', [${2:}])" },
  { name: 'whereBetween',   snippet: "whereBetween('${1:column}', [${2:min}, ${3:max}])" },
  { name: 'whereNull',      snippet: "whereNull('${1:column}')" },
  { name: 'whereNotNull',   snippet: "whereNotNull('${1:column}')" },
  { name: 'whereHas',       snippet: "whereHas('${1:relation}', function (\\$q) {\n    ${2:}\n})" },
  { name: 'has',            snippet: "has('${1:relation}')" },
  { name: 'doesntHave',     snippet: "doesntHave('${1:relation}')" },
  { name: 'with',           snippet: "with('${1:relation}')" },
  { name: 'withCount',      snippet: "withCount('${1:relation}')" },
  { name: 'without',        snippet: "without('${1:relation}')" },
  { name: 'select',         snippet: "select('${1:column}')" },
  { name: 'addSelect',      snippet: "addSelect('${1:column}')" },
  { name: 'distinct',       snippet: 'distinct()' },
  { name: 'orderBy',        snippet: "orderBy('${1:column}', '${2:asc}')" },
  { name: 'orderByDesc',    snippet: "orderByDesc('${1:column}')" },
  { name: 'latest',         snippet: 'latest()' },
  { name: 'oldest',         snippet: 'oldest()' },
  { name: 'limit',          snippet: 'limit(${1:10})' },
  { name: 'take',           snippet: 'take(${1:10})' },
  { name: 'skip',           snippet: 'skip(${1:0})' },
  { name: 'offset',         snippet: 'offset(${1:0})' },
  { name: 'groupBy',        snippet: "groupBy('${1:column}')" },
  { name: 'having',         snippet: "having('${1:column}', '${2:>=}', ${3:value})" },
  // Writes
  { name: 'update',         snippet: 'update([${1:}])' },
  { name: 'delete',         snippet: 'delete()' },
  { name: 'forceDelete',    snippet: 'forceDelete()' },
  { name: 'restore',        snippet: 'restore()' },
  { name: 'increment',      snippet: "increment('${1:column}')" },
  { name: 'decrement',      snippet: "decrement('${1:column}')" },
  // Soft deletes
  { name: 'withTrashed',    snippet: 'withTrashed()' },
  { name: 'onlyTrashed',    snippet: 'onlyTrashed()' },
  // Instance methods
  { name: 'save',           snippet: 'save()' },
  { name: 'fresh',          snippet: 'fresh()' },
  { name: 'refresh',        snippet: 'refresh()' },
  { name: 'touch',          snippet: 'touch()' },
  { name: 'fill',           snippet: 'fill([${1:}])' },
  // Debug
  { name: 'dd',             snippet: 'dd()' },
  { name: 'dump',           snippet: 'dump()' },
];

function _methodItems(methods, typed, lineNum, rangeStart, rangeEnd, labelPrefix) {
  const filtered = typed
    ? methods.filter(m => m.name.toLowerCase().startsWith(typed.toLowerCase()))
    : methods;
  if (!filtered.length) return null;
  return filtered.map((m, i) => ({
    label:            (labelPrefix || '') + m.name,
    kind:             2, // Method
    detail:           (labelPrefix || '') + m.name,
    insertTextFormat: 2,
    sortText:         i.toString().padStart(4, '0'),
    textEdit: {
      range:   { start: { line: lineNum, character: rangeStart },
                 end:   { line: lineNum, character: rangeEnd } },
      newText: (labelPrefix ? labelPrefix : '') + m.snippet,
    },
  }));
}

// ClassName:: — static + Eloquent methods
function _staticCompletions(lineText, character, lineNum, root) {
  const before = lineText.slice(0, character);
  const match  = before.match(/\b([A-Z][a-zA-Z0-9_]*)::[a-zA-Z_]*$/);
  if (!match) return null;

  const className   = match[1];
  const typedMethod = before.slice(before.lastIndexOf('::') + 2);
  const methodStart = character - typedMethod.length;

  const classEntry = discoverPhpClasses(root).find(c => c.className === className);
  if (!classEntry) return null;

  let methods = [];
  let content;
  try { content = fs.readFileSync(classEntry.file, 'utf8'); } catch (_) {}

  if (content) {
    if (/extends\s+(?:Model|Authenticatable|Pivot|MorphPivot)\b/.test(content))
      methods = [...ELOQUENT_METHODS];

    const re = /public\s+static\s+function\s+(\w+)\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      if (!methods.find(e => e.name === m[1])) {
        const p = m[2].trim();
        methods.push({ name: m[1], snippet: p ? `${m[1]}(\${1:})` : `${m[1]}()` });
      }
    }
  }

  return _methodItems(methods, typedMethod, lineNum, methodStart, character, null);
}

// -> chain methods — triggered by '-' or '>'
function _chainCompletions(lineText, character, lineNum) {
  const before = lineText.slice(0, character);

  // Case A: just typed '-' after an expression end
  if (/[)\w\]]-$/.test(before))
    return _methodItems(CHAIN_METHODS, '', lineNum, character - 1, character, '->');

  // Case B: '->' already present, optional partial method typed
  const arrowMatch = before.match(/->([a-zA-Z_]*)$/);
  if (!arrowMatch) return null;

  const typed      = arrowMatch[1];
  const arrowStart = character - 2 - typed.length;
  return _methodItems(CHAIN_METHODS, typed, lineNum, arrowStart, character, '->');
}

// Class-name import — new Foo / Foo with auto-use insertion
function _classImportCompletions(lineText, character, lineNum, fileText, root) {
  const before = lineText.slice(0, character);
  if (/::/.test(before.match(/[A-Z][a-zA-Z0-9_]*[^]*$/)?.[0] || '')) return null;

  const wordMatch = before.match(/\b([A-Z][a-zA-Z0-9_]*)$/);
  if (!wordMatch) return null;

  const typed      = wordMatch[1];
  const wordStart  = character - typed.length;
  const isNew      = /\bnew\s+$/.test(before.slice(0, wordStart));
  const insertLine = getUseInsertLine(fileText);

  const items = discoverPhpClasses(root)
    .filter(c => c.className.toLowerCase().startsWith(typed.toLowerCase()))
    .map((c, i) => {
      const imported   = isAlreadyImported(fileText, c.fqn);
      const insertText = isNew ? `${c.className}($1)` : c.className;
      const item = {
        label:            c.className,
        kind:             7, // Class
        detail:           c.fqn,
        insertTextFormat: isNew ? 2 : 1,
        sortText:         i.toString().padStart(4, '0'),
        textEdit: {
          range:   { start: { line: lineNum, character: wordStart },
                     end:   { line: lineNum, character } },
          newText: insertText,
        },
      };
      if (!imported) {
        item.additionalTextEdits = [{
          range:   { start: { line: insertLine, character: 0 },
                     end:   { line: insertLine, character: 0 } },
          newText: `use ${c.fqn};\n`,
        }];
        item.detail = `${c.fqn}  (auto-import)`;
      }
      return item;
    });

  return items.length ? items : null;
}

// Public entry point called by the handler
function phpCompletions(lineText, character, lineNum, fileText, root) {
  const chain = _chainCompletions(lineText, character, lineNum);
  if (chain)  return { isIncomplete: true,  items: chain };

  const statics = _staticCompletions(lineText, character, lineNum, root);
  if (statics) return { isIncomplete: true,  items: statics };

  const classes = _classImportCompletions(lineText, character, lineNum, fileText, root);
  return           { isIncomplete: false, items: classes || [] };
}

// ══════════════════════════════════════════════════════════════════════════════
// §4  PHP › DEFINITION  (jump to class declaration)
// ══════════════════════════════════════════════════════════════════════════════

function _classNameAtCursor(text, line, character) {
  const lineText = text.split('\n')[line] || '';
  let s = character, e = character;
  while (s > 0 && /\w/.test(lineText[s - 1])) s--;
  while (e < lineText.length && /\w/.test(lineText[e])) e++;
  const word = lineText.slice(s, e);
  return /^[A-Z]/.test(word) ? word : null;
}

function phpDefinition(text, line, character, root) {
  const className = _classNameAtCursor(text, line, character);
  if (!className) return null;
  const found = discoverPhpClasses(root).find(c => c.className === className);
  if (!found) return null;
  return {
    uri:   pathToUri(found.file),
    range: { start: { line: found.line, character: 0 },
             end:   { line: found.line, character: 0 } },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// §5  BLADE › VIEWS  (path resolution, variable inference, file creation)
// ══════════════════════════════════════════════════════════════════════════════

// ── 5a. View path resolution ─────────────────────────────────────────────────

function getViewNameFromUri(uri, root) {
  const filePath = uriToPath(uri);
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

// ── 5b. View variable inference (from PHP view() calls) ──────────────────────

function _extractArrayKeys(text) {
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

function _extractCompactArgs(text) {
  const vars = [];
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
        ? _extractCompactArgs(after)
        : after.startsWith('[')
          ? _extractArrayKeys(after)
          : [];
      for (const v of extracted) vars.add(v);
    }
  }
  return [...vars];
}

// ── 5c. Blade definition (view() → blade file) ───────────────────────────────

function bladeDefinition(text, line, character) {
  const lineText  = text.split('\n')[line] || '';
  const viewRegex = /view\s*\(\s*(['"])([^'"]+)\1/g;
  let match;
  while ((match = viewRegex.exec(lineText)) !== null) {
    if (character >= match.index && character <= viewRegex.lastIndex)
      return match[2];
  }
  return null;
}

// ── 5d. Pending view-creation prompts ────────────────────────────────────────

let pendingCreations = {};
let promptedPaths    = new Set();

function promptCreateView(reqId, filePath, viewName) {
  promptedPaths.add(filePath);
  pendingCreations[reqId] = { filePath, viewName };
  send({
    jsonrpc: '2.0', id: reqId,
    method: 'window/showMessageRequest',
    params: {
      type:    2, // Warning
      message: `Blade view "${viewName}" does not exist. Create it?`,
      actions: [{ title: 'Create File' }, { title: 'Cancel' }],
    },
  });
}

function handleCreateResponse(id, result) {
  if (!pendingCreations[id]) return;
  const { filePath, viewName } = pendingCreations[id];
  delete pendingCreations[id];
  promptedPaths.delete(filePath);

  if (result?.title !== 'Create File') return;

  createBladeFile(filePath);
  send({
    jsonrpc: '2.0', id: nextRequestId++,
    method: 'window/showDocument',
    params: { uri: pathToUri(filePath), takeFocus: true },
  });
  send({
    jsonrpc: '2.0',
    method: 'window/showMessage',
    params: { type: 3, message: `Created: resources/views/${viewName.replace(/\./g, '/')}.blade.php` },
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// §6  BLADE › COMPLETIONS  (@directives, $variables)
// ══════════════════════════════════════════════════════════════════════════════

// ── 6a. Blade directive snippets ─────────────────────────────────────────────
const BLADE_SNIPPETS = [
  // Conditionals
  { label: 'if',             detail: 'If block',                       insertText: 'if (${1:condition})\n    $2\n@endif' },
  { label: 'if-else',        detail: 'If / else block',                insertText: 'if (${1:condition})\n    $2\n@else\n    $3\n@endif' },
  { label: 'if-elseif',      detail: 'If / elseif / else block',       insertText: 'if (${1:condition})\n    $2\n@elseif (${3:condition})\n    $4\n@else\n    $5\n@endif' },
  { label: 'elseif',         detail: 'Else-if clause',                  insertText: 'elseif (${1:condition})' },
  { label: 'else',           detail: 'Else clause',                     insertText: 'else' },
  { label: 'endif',          detail: 'End if block',                    insertText: 'endif' },
  { label: 'unless',         detail: 'Unless conditional block',        insertText: 'unless (${1:condition})\n    $2\n@endunless' },
  { label: 'endunless',      detail: 'End unless block',                insertText: 'endunless' },
  { label: 'isset',          detail: 'Check if variable is set',        insertText: 'isset(\\$${1:variable})\n    $2\n@endisset' },
  { label: 'endisset',       detail: 'End isset block',                 insertText: 'endisset' },
  { label: 'empty',          detail: 'Check if variable is empty',      insertText: 'empty(\\$${1:variable})\n    $2\n@endempty' },
  { label: 'endempty',       detail: 'End empty block',                 insertText: 'endempty' },
  // Authentication
  { label: 'auth',           detail: 'Authenticated users block',       insertText: 'auth\n    $1\n@endauth' },
  { label: 'endauth',        detail: 'End auth block',                  insertText: 'endauth' },
  { label: 'guest',          detail: 'Guest (unauthenticated) block',   insertText: 'guest\n    $1\n@endguest' },
  { label: 'endguest',       detail: 'End guest block',                 insertText: 'endguest' },
  // Environment
  { label: 'production',     detail: 'Production environment block',    insertText: 'production\n    $1\n@endproduction' },
  { label: 'endproduction',  detail: 'End production block',            insertText: 'endproduction' },
  { label: 'env',            detail: 'Specific environment block',      insertText: "env('${1:staging}')\n    $2\n@endenv" },
  { label: 'endenv',         detail: 'End env block',                   insertText: 'endenv' },
  // Section / Layout checks
  { label: 'hasSection',     detail: 'Check if section has content',    insertText: "hasSection('${1:section}')\n    $2\n@endif" },
  { label: 'sectionMissing', detail: 'Check if section is missing',     insertText: "sectionMissing('${1:section}')\n    $2\n@endif" },
  { label: 'session',        detail: 'Session value exists block',      insertText: "session('${1:key}')\n    $2\n@endsession" },
  { label: 'endsession',     detail: 'End session block',               insertText: 'endsession' },
  { label: 'context',        detail: 'Context value exists block',      insertText: "context('${1:key}')\n    $2\n@endcontext" },
  { label: 'endcontext',     detail: 'End context block',               insertText: 'endcontext' },
  // Switch
  { label: 'switch',         detail: 'Switch statement',                insertText: 'switch(\\$${1:variable})\n    @case(${2:1})\n        $3\n        @break\n\n    @default\n        $4\n@endswitch' },
  { label: 'case',           detail: 'Case clause in switch',           insertText: 'case(${1:value})' },
  { label: 'default',        detail: 'Default clause in switch',        insertText: 'default' },
  { label: 'endswitch',      detail: 'End switch block',                insertText: 'endswitch' },
  // Loops
  { label: 'for',            detail: 'For loop',                        insertText: 'for (\\$${1:i} = 0; \\$${1:i} < ${2:10}; \\$${1:i}++)\n    $3\n@endfor' },
  { label: 'endfor',         detail: 'End for loop',                    insertText: 'endfor' },
  { label: 'foreach',        detail: 'Foreach loop',                    insertText: 'foreach (\\$${1:items} as \\$${2:item})\n    $3\n@endforeach' },
  { label: 'endforeach',     detail: 'End foreach loop',                insertText: 'endforeach' },
  { label: 'forelse',        detail: 'Forelse loop with empty fallback', insertText: 'forelse (\\$${1:items} as \\$${2:item})\n    $3\n@empty\n    $4\n@endforelse' },
  { label: 'endforelse',     detail: 'End forelse loop',                insertText: 'endforelse' },
  { label: 'while',          detail: 'While loop',                      insertText: 'while (${1:condition})\n    $2\n@endwhile' },
  { label: 'endwhile',       detail: 'End while loop',                  insertText: 'endwhile' },
  { label: 'continue',       detail: 'Skip to next iteration',          insertText: 'continue' },
  { label: 'break',          detail: 'Break out of loop / switch',      insertText: 'break' },
  // Conditional HTML attributes
  { label: 'class',          detail: 'Conditional CSS class list',      insertText: "class([\n    '${1:base-class}',\n    '${2:conditional-class}' => \\$${3:condition},\n])" },
  { label: 'style',          detail: 'Conditional inline CSS styles',   insertText: "style([\n    '${1:property}: ${2:value}',\n    '${3:property}: ${4:value}' => \\$${5:condition},\n])" },
  { label: 'checked',        detail: 'Conditional checked attribute',   insertText: 'checked(${1:condition})' },
  { label: 'selected',       detail: 'Conditional selected attribute',  insertText: 'selected(${1:condition})' },
  { label: 'disabled',       detail: 'Conditional disabled attribute',  insertText: 'disabled(${1:condition})' },
  { label: 'readonly',       detail: 'Conditional readonly attribute',  insertText: 'readonly(${1:condition})' },
  { label: 'required',       detail: 'Conditional required attribute',  insertText: 'required(${1:condition})' },
  // Subview includes
  { label: 'include',         detail: 'Include a subview',                     insertText: "include('${1:view.name}')" },
  { label: 'includeIf',       detail: 'Include a view if it exists',           insertText: "includeIf('${1:view.name}')" },
  { label: 'includeWhen',     detail: 'Include a view when condition is true',  insertText: "includeWhen(\\$${1:condition}, '${2:view.name}')" },
  { label: 'includeUnless',   detail: 'Include a view unless condition',        insertText: "includeUnless(\\$${1:condition}, '${2:view.name}')" },
  { label: 'includeFirst',    detail: 'Include first existing view in array',   insertText: "includeFirst(['${1:view.name}', '${2:fallback}'])" },
  { label: 'includeIsolated', detail: 'Include view without parent variables',  insertText: "includeIsolated('${1:view.name}')" },
  { label: 'each',            detail: 'Render a view for each collection item', insertText: "each('${1:view.name}', \\$${2:items}, '${3:item}')" },
  // Once / push-once
  { label: 'once',           detail: 'Execute once per rendering cycle',  insertText: 'once\n    $1\n@endonce' },
  { label: 'endonce',        detail: 'End once block',                    insertText: 'endonce' },
  { label: 'pushOnce',       detail: 'Push to stack once per cycle',      insertText: "pushOnce('${1:scripts}')\n    $2\n@endPushOnce" },
  { label: 'prependOnce',    detail: 'Prepend to stack once per cycle',   insertText: "prependOnce('${1:scripts}')\n    $2\n@endPrependOnce" },
  // Raw PHP
  { label: 'php',            detail: 'Raw PHP block',                     insertText: 'php\n    $1\n@endphp' },
  { label: 'endphp',         detail: 'End PHP block',                     insertText: 'endphp' },
  { label: 'use',            detail: 'Import a PHP class / function',     insertText: "use('${1:App\\\\Models\\\\Model}')" },
  { label: 'verbatim',       detail: 'Output verbatim (no Blade)',         insertText: 'verbatim\n    $1\n@endverbatim' },
  { label: 'endverbatim',    detail: 'End verbatim block',                insertText: 'endverbatim' },
  // Template inheritance
  { label: 'extends',        detail: 'Extend a parent layout',            insertText: "extends('${1:layouts.app}')" },
  { label: 'section',        detail: 'Define a named section',            insertText: "section('${1:content}')\n    $2\n@endsection" },
  { label: 'endsection',     detail: 'End section block',                 insertText: 'endsection' },
  { label: 'show',           detail: 'Define and immediately yield a section', insertText: 'show' },
  { label: 'yield',          detail: 'Yield (output) a section',          insertText: "yield('${1:content}')" },
  { label: 'parent',         detail: 'Include parent section content',    insertText: 'parent' },
  // Stacks
  { label: 'push',           detail: 'Push content to a named stack',     insertText: "push('${1:scripts}')\n    $2\n@endpush" },
  { label: 'endpush',        detail: 'End push block',                    insertText: 'endpush' },
  { label: 'pushIf',         detail: 'Conditionally push to a stack',     insertText: "pushIf(\\$${1:condition}, '${2:scripts}')\n    $3\n@endPushIf" },
  { label: 'prepend',        detail: 'Prepend content to a named stack',  insertText: "prepend('${1:scripts}')\n    $2\n@endprepend" },
  { label: 'endprepend',     detail: 'End prepend block',                 insertText: 'endprepend' },
  { label: 'stack',          detail: 'Render a named stack',              insertText: "stack('${1:scripts}')" },
  { label: 'hasstack',       detail: 'Check if a stack has content',      insertText: "hasstack('${1:scripts}')\n    $2\n@endif" },
  // Forms
  { label: 'csrf',           detail: 'Generate CSRF hidden token field',  insertText: 'csrf' },
  { label: 'method',         detail: 'Spoof HTTP method for HTML forms',  insertText: "method('${1:PUT}')" },
  { label: 'error',          detail: 'Display a validation error',        insertText: "error('${1:field}')\n    $2\n@enderror" },
  { label: 'enderror',       detail: 'End error block',                   insertText: 'enderror' },
  // Components
  { label: 'props',          detail: 'Declare component props',           insertText: "props(['${1:type}' => '${2:info}', '${3:message}'])" },
  { label: 'aware',          detail: 'Access parent component data',      insertText: "aware(['${1:color}' => '${2:gray}'])" },
  // Fragments
  { label: 'fragment',       detail: 'Define a renderable fragment',      insertText: "fragment('${1:user-list}')\n    $2\n@endfragment" },
  { label: 'endfragment',    detail: 'End fragment block',                insertText: 'endfragment' },
  // Service injection
  { label: 'inject',         detail: 'Inject a service from the container', insertText: "inject('${1:metrics}', '${2:App\\\\Services\\\\MetricsService}')" },
];

function _directiveCompletions(lineText, character, lineNum) {
  const before   = lineText.slice(0, character);
  const atMatch  = before.match(/@([a-zA-Z-]*)$/);
  if (!atMatch) return null;

  const typed       = atMatch[1].toLowerCase();
  const atCharacter = character - atMatch[0].length;

  const items = BLADE_SNIPPETS
    .filter(s => typed === '' || s.label.toLowerCase().startsWith(typed))
    .map((s, i) => ({
      label:            `@${s.label}`,
      kind:             15, // Snippet
      detail:           s.detail,
      insertTextFormat: 2,
      filterText:       `@${s.label}`,
      sortText:         i.toString().padStart(4, '0'),
      textEdit: {
        range:   { start: { line: lineNum, character: atCharacter },
                   end:   { line: lineNum, character } },
        newText: `@${s.insertText}`,
      },
    }));

  return items.length ? items : null;
}

// ── 6b. Blade $variable completions (inferred from view() calls) ─────────────

function _variableCompletions(lineText, character, lineNum, uri, root) {
  const before   = lineText.slice(0, character);
  const varMatch = before.match(/\$([a-zA-Z_]*)$/);
  if (!varMatch || !root) return null;

  const viewName = getViewNameFromUri(uri, root);
  if (!viewName) return null;

  const viewVars = findViewVariables(viewName, root);
  if (!viewVars.length) return null;

  const typed      = varMatch[1].toLowerCase();
  const dollarStart = character - varMatch[0].length;

  const items = viewVars
    .filter(v => typed === '' || v.toLowerCase().startsWith(typed))
    .map((v, i) => ({
      label:    `$${v}`,
      kind:     6, // Variable
      detail:   'View variable',
      sortText: i.toString().padStart(4, '0'),
      textEdit: {
        range:   { start: { line: lineNum, character: dollarStart },
                   end:   { line: lineNum, character } },
        newText: `$${v}`,
      },
    }));

  return items.length ? items : null;
}

// Public entry point called by the handler
function bladeCompletions(lineText, character, lineNum, uri, root) {
  const directives = _directiveCompletions(lineText, character, lineNum);
  if (directives) return { isIncomplete: true,  items: directives };

  const vars = _variableCompletions(lineText, character, lineNum, uri, root);
  return        { isIncomplete: false, items: vars || [] };
}

// ══════════════════════════════════════════════════════════════════════════════
// §7  MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════════════════════

function handleMessage(msg) {
  const { id, method, params, result } = msg;

  // Outbound responses (have id but no method)
  if (id !== undefined && !method) {
    handleCreateResponse(id, result);
    return;
  }

  switch (method) {

    // ── Lifecycle ────────────────────────────────────────────────────────────
    case 'initialize': {
      if      (params.workspaceFolders?.length > 0) workspaceRoot = uriToPath(params.workspaceFolders[0].uri);
      else if (params.rootUri)                       workspaceRoot = uriToPath(params.rootUri);
      else if (params.rootPath)                      workspaceRoot = params.rootPath;

      send({
        jsonrpc: '2.0', id,
        result: {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1 },
            definitionProvider: true,
            completionProvider: {
              triggerCharacters: ['@', '$', ':', '-', '>'],
              resolveProvider:   false,
            },
          },
          serverInfo: { name: 'laravel-view-lsp', version: '0.1.0' },
        },
      });
      break;
    }

    case 'initialized': break;
    case 'shutdown':    send({ jsonrpc: '2.0', id, result: null }); break;
    case 'exit':        process.exit(0);

    // ── Document sync ────────────────────────────────────────────────────────
    case 'textDocument/didOpen':
      documents[params.textDocument.uri] = params.textDocument.text;
      if (isPhpFile(params.textDocument.uri)) phpClassCache = null;
      break;

    case 'textDocument/didChange':
      if (params.contentChanges.length > 0)
        documents[params.textDocument.uri] = params.contentChanges[params.contentChanges.length - 1].text;
      if (isPhpFile(params.textDocument.uri)) phpClassCache = null;
      break;

    case 'textDocument/didClose':
      delete documents[params.textDocument.uri];
      break;

    // ── Completions ──────────────────────────────────────────────────────────
    case 'textDocument/completion': {
      const uri      = params.textDocument.uri;
      const text     = documents[uri] || '';
      const { line: lineNum, character } = params.position;
      const lineText = text.split('\n')[lineNum] || '';

      let completionResult = { isIncomplete: false, items: [] };

      if      (isPhpFile(uri)   && workspaceRoot) completionResult = phpCompletions(lineText, character, lineNum, text, workspaceRoot);
      else if (isBladeFile(uri))                  completionResult = bladeCompletions(lineText, character, lineNum, uri, workspaceRoot);

      send({ jsonrpc: '2.0', id, result: completionResult });
      break;
    }

    // ── Definitions ──────────────────────────────────────────────────────────
    case 'textDocument/definition': {
      const uri  = params.textDocument.uri;
      const text = documents[uri] || '';
      const { line, character } = params.position;

      if (isPhpFile(uri) && workspaceRoot) {
        send({ jsonrpc: '2.0', id, result: phpDefinition(text, line, character, workspaceRoot) });
        break;
      }

      if (isBladeFile(uri) && workspaceRoot) {
        const viewName = bladeDefinition(text, line, character);
        if (!viewName) { send({ jsonrpc: '2.0', id, result: null }); break; }

        const filePath = resolveViewPath(viewName, workspaceRoot);
        if (fs.existsSync(filePath)) {
          send({
            jsonrpc: '2.0', id,
            result: { uri: pathToUri(filePath), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
          });
        } else {
          send({ jsonrpc: '2.0', id, result: null });
          if (!promptedPaths.has(filePath))
            promptCreateView(nextRequestId++, filePath, viewName);
        }
        break;
      }

      send({ jsonrpc: '2.0', id, result: null });
      break;
    }

    default:
      if (id !== undefined)
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// §8  JSON-RPC STDIN PARSER
// ══════════════════════════════════════════════════════════════════════════════

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  while (true) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep === -1) break;
    const lenMatch = buf.slice(0, sep).match(/Content-Length:\s*(\d+)/i);
    if (!lenMatch) { buf = buf.slice(sep + 4); continue; }
    const len       = parseInt(lenMatch[1], 10);
    const bodyStart = sep + 4;
    if (buf.length < bodyStart + len) break;
    const body = buf.slice(bodyStart, bodyStart + len);
    buf = buf.slice(bodyStart + len);
    try { handleMessage(JSON.parse(body)); } catch (_) {}
  }
});
