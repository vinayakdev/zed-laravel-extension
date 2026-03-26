#!/usr/bin/env node
// Minimal LSP: resolves Laravel view() calls to blade template files + blade snippet completions

const fs = require('fs');
const path = require('path');

let documents = {};
let workspaceRoot = null;
let pendingCreations = {};
let promptedPaths = new Set(); // tracks files already being prompted
let nextRequestId = 1;

function send(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

function uriToPath(uri) {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

function pathToUri(filePath) {
  return 'file://' + filePath;
}

function isBladeFile(uri) {
  return uri.endsWith('.blade.php');
}

// ─── View Variable Inference ────────────────────────────────────────────────

function getViewNameFromUri(uri, root) {
  const filePath = uriToPath(uri);
  const viewsDir = path.join(root, 'resources', 'views') + path.sep;
  if (!filePath.startsWith(viewsDir)) return null;
  const relative = filePath.slice(viewsDir.length).replace(/\.blade\.php$/, '');
  return relative.split(path.sep).join('.');
}

function collectPhpFiles(dir, results) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectPhpFiles(full, results);
      else if (entry.name.endsWith('.php')) results.push(full);
    }
  } catch (_) {}
}

// Extract variable names from a PHP array literal starting at text[0] = '['
function extractArrayKeys(text) {
  const vars = [];
  let depth = 0, i = 0;
  let inner = '';
  for (; i < text.length; i++) {
    if (text[i] === '[') { depth++; if (depth === 1) continue; }
    else if (text[i] === ']') { depth--; if (depth === 0) break; }
    if (depth >= 1) inner += text[i];
  }
  const keyRe = /['"]([^'"]+)['"]\s*=>/g;
  let m;
  while ((m = keyRe.exec(inner)) !== null) vars.push(m[1]);
  return vars;
}

// Extract variable names from compact(...) starting at text = "compact(...)"
function extractCompactArgs(text) {
  const vars = [];
  const inner = text.match(/^compact\s*\(([^)]*)\)/);
  if (!inner) return vars;
  const strRe = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = strRe.exec(inner[1])) !== null) vars.push(m[1]);
  return vars;
}

function findViewVariables(viewName, root) {
  const vars = new Set();
  const files = [];
  for (const dir of ['app', 'routes']) collectPhpFiles(path.join(root, dir), files);
  try {
    for (const f of fs.readdirSync(root))
      if (f.endsWith('.php')) files.push(path.join(root, f));
  } catch (_) {}

  const escaped = viewName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const callRe = new RegExp(`view\\s*\\(\\s*['"]${escaped}['"]\\s*,\\s*`, 'g');

  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    let m;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(content)) !== null) {
      const after = content.slice(callRe.lastIndex);
      const extracted = after.trimStart().startsWith('compact')
        ? extractCompactArgs(after.trimStart())
        : after.trimStart().startsWith('[')
          ? extractArrayKeys(after.trimStart())
          : [];
      for (const v of extracted) vars.add(v);
    }
  }
  return [...vars];
}

// ─── PHP Class Discovery & Import ───────────────────────────────────────────

let phpClassCache = null;

function discoverPhpClasses(root) {
  if (phpClassCache) return phpClassCache;
  const files = [];
  collectPhpFiles(path.join(root, 'app'), files);

  const classes = [];
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }

    const nsMatch = content.match(/^\s*namespace\s+([\w\\]+)\s*;/m);
    const namespace = nsMatch ? nsMatch[1] : null;

    const classRe = /^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+(\w+)/gm;
    let m;
    while ((m = classRe.exec(content)) !== null) {
      const className = m[1];
      const fqn = namespace ? `${namespace}\\${className}` : className;
      // Count lines up to match offset so we can jump to the declaration
      const lineNum = content.slice(0, m.index).split('\n').length - 1;
      classes.push({ className, fqn, file, line: lineNum });
    }
  }

  phpClassCache = classes;
  return classes;
}

// Find the line number where a new `use` statement should be inserted
function getUseInsertLine(text) {
  const lines = text.split('\n');
  let lastUse = -1, namespaceLine = -1, phpTag = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (phpTag === -1 && t.startsWith('<?php')) phpTag = i;
    if (t.startsWith('namespace '))             namespaceLine = i;
    if (t.startsWith('use '))                   lastUse = i;
  }
  if (lastUse >= 0)       return lastUse + 1;
  if (namespaceLine >= 0) return namespaceLine + 2;
  if (phpTag >= 0)        return phpTag + 2;
  return 0;
}

function isAlreadyImported(text, fqn) {
  const esc = fqn.replace(/\\/g, '\\\\');
  return new RegExp(`^\\s*use\\s+${esc}(\\s+as\\s+|;)`, 'm').test(text);
}

// ─── Eloquent static method list ────────────────────────────────────────────
const ELOQUENT_METHODS = [
  { name: 'all',             snippet: 'all()' },
  { name: 'get',             snippet: 'get()' },
  { name: 'find',            snippet: 'find(${1:$id})' },
  { name: 'findOrFail',      snippet: 'findOrFail(${1:$id})' },
  { name: 'findMany',        snippet: 'findMany([${1:$ids}])' },
  { name: 'first',           snippet: 'first()' },
  { name: 'firstOrFail',     snippet: 'firstOrFail()' },
  { name: 'firstOrCreate',   snippet: 'firstOrCreate([${1:}])' },
  { name: 'firstOrNew',      snippet: 'firstOrNew([${1:}])' },
  { name: 'create',          snippet: 'create([${1:}])' },
  { name: 'forceCreate',     snippet: 'forceCreate([${1:}])' },
  { name: 'updateOrCreate',  snippet: 'updateOrCreate([${1:}], [${2:}])' },
  { name: 'destroy',         snippet: 'destroy(${1:$id})' },
  { name: 'truncate',        snippet: 'truncate()' },
  { name: 'query',           snippet: 'query()' },
  { name: 'where',           snippet: "where('${1:column}', ${2:'value'})" },
  { name: 'whereIn',         snippet: "whereIn('${1:column}', [${2:}])" },
  { name: 'whereNotIn',      snippet: "whereNotIn('${1:column}', [${2:}])" },
  { name: 'whereBetween',    snippet: "whereBetween('${1:column}', [${2:min}, ${3:max}])" },
  { name: 'whereNull',       snippet: "whereNull('${1:column}')" },
  { name: 'whereNotNull',    snippet: "whereNotNull('${1:column}')" },
  { name: 'with',            snippet: "with('${1:relation}')" },
  { name: 'withCount',       snippet: "withCount('${1:relation}')" },
  { name: 'has',             snippet: "has('${1:relation}')" },
  { name: 'doesntHave',      snippet: "doesntHave('${1:relation}')" },
  { name: 'whereHas',        snippet: "whereHas('${1:relation}', function (\\$q) {\n    ${2:}\n})" },
  { name: 'orderBy',         snippet: "orderBy('${1:column}', '${2:asc}')" },
  { name: 'orderByDesc',     snippet: "orderByDesc('${1:column}')" },
  { name: 'latest',          snippet: 'latest()' },
  { name: 'oldest',          snippet: 'oldest()' },
  { name: 'paginate',        snippet: 'paginate(${1:15})' },
  { name: 'simplePaginate',  snippet: 'simplePaginate(${1:15})' },
  { name: 'cursorPaginate',  snippet: 'cursorPaginate(${1:15})' },
  { name: 'pluck',           snippet: "pluck('${1:column}')" },
  { name: 'value',           snippet: "value('${1:column}')" },
  { name: 'count',           snippet: 'count()' },
  { name: 'sum',             snippet: "sum('${1:column}')" },
  { name: 'avg',             snippet: "avg('${1:column}')" },
  { name: 'max',             snippet: "max('${1:column}')" },
  { name: 'min',             snippet: "min('${1:column}')" },
  { name: 'exists',          snippet: 'exists()' },
  { name: 'doesntExist',     snippet: 'doesntExist()' },
  { name: 'select',          snippet: "select('${1:column}')" },
  { name: 'distinct',        snippet: 'distinct()' },
  { name: 'limit',           snippet: 'limit(${1:10})' },
  { name: 'take',            snippet: 'take(${1:10})' },
  { name: 'skip',            snippet: 'skip(${1:0})' },
  { name: 'chunk',           snippet: 'chunk(${1:100}, function (\\$items) {\n    ${2:}\n})' },
  { name: 'each',            snippet: 'each(function (\\$item) {\n    ${1:}\n})' },
  { name: 'increment',       snippet: "increment('${1:column}')" },
  { name: 'decrement',       snippet: "decrement('${1:column}')" },
  { name: 'update',          snippet: 'update([${1:}])' },
  { name: 'delete',          snippet: 'delete()' },
  { name: 'forceDelete',     snippet: 'forceDelete()' },
  { name: 'restore',         snippet: 'restore()' },
  { name: 'withTrashed',     snippet: 'withTrashed()' },
  { name: 'onlyTrashed',     snippet: 'onlyTrashed()' },
];

// Returns static method completions for ClassName:: context
function getClassStaticCompletions(lineText, character, lineNum, root) {
  const before = lineText.slice(0, character);
  // Match ClassName:: with optional partial method name after
  const match = before.match(/\b([A-Z][a-zA-Z0-9_]*)::[a-zA-Z_]*$/);
  if (!match) return null;

  const className = match[1];
  const typedMethod = before.slice(before.lastIndexOf('::') + 2);
  const methodStart = character - typedMethod.length;

  const classes = discoverPhpClasses(root);
  const classEntry = classes.find(c => c.className === className);
  if (!classEntry) return null;

  let methods = [];

  let content;
  try { content = fs.readFileSync(classEntry.file, 'utf8'); } catch (_) {}

  if (content) {
    // Include Eloquent methods if this class extends a Model base
    if (/extends\s+(?:Model|Authenticatable|Pivot|MorphPivot)\b/.test(content)) {
      methods = [...ELOQUENT_METHODS];
    }

    // Also include any explicitly declared public static methods
    const staticRe = /public\s+static\s+function\s+(\w+)\s*\(([^)]*)\)/g;
    let m;
    while ((m = staticRe.exec(content)) !== null) {
      const name = m[1];
      if (!methods.find(em => em.name === name)) {
        const params = m[2].trim();
        methods.push({ name, snippet: params ? `${name}(\${1:})` : `${name}()` });
      }
    }
  }

  const filtered = methods.filter(
    mt => typedMethod === '' || mt.name.toLowerCase().startsWith(typedMethod.toLowerCase())
  );

  return filtered.length > 0
    ? filtered.map((mt, i) => ({
        label: mt.name,
        kind: 2, // Method
        detail: `${className}::${mt.name}`,
        insertTextFormat: 2,
        sortText: i.toString().padStart(4, '0'),
        textEdit: {
          range: {
            start: { line: lineNum, character: methodStart },
            end:   { line: lineNum, character },
          },
          newText: mt.snippet,
        },
      }))
    : null;
}

function getPhpClassCompletions(lineText, character, lineNum, fileText, root) {
  const before = lineText.slice(0, character);
  // Only trigger on words starting with an uppercase letter (not after ::)
  if (/::/.test(before.match(/[A-Z][a-zA-Z0-9_]*[^]*$/)?.[0] || '')) return null;
  const wordMatch = before.match(/\b([A-Z][a-zA-Z0-9_]*)$/);
  if (!wordMatch) return null;

  const typed = wordMatch[1];
  const wordStart = character - typed.length;

  // Detect `new ClassName` context — insert with ()
  const isNewContext = /\bnew\s+$/.test(before.slice(0, wordStart));

  const classes = discoverPhpClasses(root);
  const insertLine = getUseInsertLine(fileText);

  const items = classes
    .filter(c => c.className.toLowerCase().startsWith(typed.toLowerCase()))
    .map((c, i) => {
      const alreadyImported = isAlreadyImported(fileText, c.fqn);
      const insertText = isNewContext ? `${c.className}($1)` : c.className;
      const item = {
        label: c.className,
        kind: 7, // Class
        detail: c.fqn,
        insertTextFormat: isNewContext ? 2 : 1,
        sortText: i.toString().padStart(4, '0'),
        textEdit: {
          range: {
            start: { line: lineNum, character: wordStart },
            end:   { line: lineNum, character },
          },
          newText: insertText,
        },
      };
      if (!alreadyImported) {
        item.additionalTextEdits = [{
          range: {
            start: { line: insertLine, character: 0 },
            end:   { line: insertLine, character: 0 },
          },
          newText: `use ${c.fqn};\n`,
        }];
        item.detail = `${c.fqn}  (auto-import)`;
      }
      return item;
    });

  return items.length > 0 ? items : null;
}

function isPhpFile(uri) {
  return uri.endsWith('.php') && !isBladeFile(uri);
}

// Extract the word (class name) the cursor is sitting on
function classNameAtPosition(text, line, character) {
  const lineText = text.split('\n')[line] || '';
  // Expand left and right to grab the full word
  let start = character;
  let end = character;
  while (start > 0 && /\w/.test(lineText[start - 1])) start--;
  while (end < lineText.length && /\w/.test(lineText[end])) end++;
  const word = lineText.slice(start, end);
  // Only treat as a class name if it starts with uppercase
  return /^[A-Z]/.test(word) ? word : null;
}

function findViewAtPosition(text, line, character) {
  const lines = text.split('\n');
  if (line >= lines.length) return null;
  const lineText = lines[line];
  const viewRegex = /view\s*\(\s*(['"])([^'"]+)\1/g;
  let match;
  while ((match = viewRegex.exec(lineText)) !== null) {
    if (character >= match.index && character <= viewRegex.lastIndex) {
      return match[2];
    }
  }
  return null;
}

function resolveViewPath(viewName, root) {
  const relative = viewName.replace(/\./g, '/');
  return path.join(root, 'resources', 'views', relative + '.blade.php');
}

function createBladeFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '<div>\n\n</div>\n');
}

function handleResponse(id, result) {
  if (!pendingCreations[id]) return;
  const { filePath, viewName } = pendingCreations[id];
  delete pendingCreations[id];
  promptedPaths.delete(filePath);

  if (result && result.title === 'Create File') {
    createBladeFile(filePath);

    // Try to open the new file
    send({
      jsonrpc: '2.0',
      id: nextRequestId++,
      method: 'window/showDocument',
      params: { uri: pathToUri(filePath), takeFocus: true },
    });

    // Notify success regardless of showDocument support
    send({
      jsonrpc: '2.0',
      method: 'window/showMessage',
      params: {
        type: 3, // Info
        message: `Created: resources/views/${viewName.replace(/\./g, '/')}.blade.php`,
      },
    });
  }
}

// ─── Blade Snippets ────────────────────────────────────────────────────────────
// Each entry: label (without @), detail, insertText (without leading @, uses snippet syntax)
const BLADE_SNIPPETS = [
  // Conditionals
  { label: 'if',            detail: 'If block',                      insertText: 'if (${1:condition})\n    $2\n@endif' },
  { label: 'if-else',       detail: 'If / else block',               insertText: 'if (${1:condition})\n    $2\n@else\n    $3\n@endif' },
  { label: 'if-elseif',     detail: 'If / elseif / else block',      insertText: 'if (${1:condition})\n    $2\n@elseif (${3:condition})\n    $4\n@else\n    $5\n@endif' },
  { label: 'elseif',        detail: 'Else-if clause',                 insertText: 'elseif (${1:condition})' },
  { label: 'else',          detail: 'Else clause',                    insertText: 'else' },
  { label: 'endif',         detail: 'End if block',                   insertText: 'endif' },
  { label: 'unless',        detail: 'Unless conditional block',       insertText: 'unless (${1:condition})\n    $2\n@endunless' },
  { label: 'endunless',     detail: 'End unless block',               insertText: 'endunless' },
  { label: 'isset',         detail: 'Check if variable is set',       insertText: 'isset(\\$${1:variable})\n    $2\n@endisset' },
  { label: 'endisset',      detail: 'End isset block',                insertText: 'endisset' },
  { label: 'empty',         detail: 'Check if variable is empty',     insertText: 'empty(\\$${1:variable})\n    $2\n@endempty' },
  { label: 'endempty',      detail: 'End empty block',                insertText: 'endempty' },

  // Authentication
  { label: 'auth',          detail: 'Authenticated users block',      insertText: 'auth\n    $1\n@endauth' },
  { label: 'endauth',       detail: 'End auth block',                 insertText: 'endauth' },
  { label: 'guest',         detail: 'Guest (unauthenticated) block',  insertText: 'guest\n    $1\n@endguest' },
  { label: 'endguest',      detail: 'End guest block',                insertText: 'endguest' },

  // Environment
  { label: 'production',    detail: 'Production environment block',   insertText: 'production\n    $1\n@endproduction' },
  { label: 'endproduction', detail: 'End production block',           insertText: 'endproduction' },
  { label: 'env',           detail: 'Specific environment block',     insertText: "env('${1:staging}')\n    $2\n@endenv" },
  { label: 'endenv',        detail: 'End env block',                  insertText: 'endenv' },

  // Section / Layout checks
  { label: 'hasSection',    detail: 'Check if section has content',   insertText: "hasSection('${1:section}')\n    $2\n@endif" },
  { label: 'sectionMissing',detail: 'Check if section is missing',    insertText: "sectionMissing('${1:section}')\n    $2\n@endif" },
  { label: 'session',       detail: 'Session value exists block',     insertText: "session('${1:key}')\n    $2\n@endsession" },
  { label: 'endsession',    detail: 'End session block',              insertText: 'endsession' },
  { label: 'context',       detail: 'Context value exists block',     insertText: "context('${1:key}')\n    $2\n@endcontext" },
  { label: 'endcontext',    detail: 'End context block',              insertText: 'endcontext' },

  // Switch
  { label: 'switch',        detail: 'Switch statement',               insertText: 'switch(\\$${1:variable})\n    @case(${2:1})\n        $3\n        @break\n\n    @default\n        $4\n@endswitch' },
  { label: 'case',          detail: 'Case clause in switch',          insertText: 'case(${1:value})' },
  { label: 'default',       detail: 'Default clause in switch',       insertText: 'default' },
  { label: 'endswitch',     detail: 'End switch block',               insertText: 'endswitch' },

  // Loops
  { label: 'for',           detail: 'For loop',                       insertText: 'for (\\$${1:i} = 0; \\$${1:i} < ${2:10}; \\$${1:i}++)\n    $3\n@endfor' },
  { label: 'endfor',        detail: 'End for loop',                   insertText: 'endfor' },
  { label: 'foreach',       detail: 'Foreach loop',                   insertText: 'foreach (\\$${1:items} as \\$${2:item})\n    $3\n@endforeach' },
  { label: 'endforeach',    detail: 'End foreach loop',               insertText: 'endforeach' },
  { label: 'forelse',       detail: 'Forelse loop with empty fallback',insertText: 'forelse (\\$${1:items} as \\$${2:item})\n    $3\n@empty\n    $4\n@endforelse' },
  { label: 'endforelse',    detail: 'End forelse loop',               insertText: 'endforelse' },
  { label: 'while',         detail: 'While loop',                     insertText: 'while (${1:condition})\n    $2\n@endwhile' },
  { label: 'endwhile',      detail: 'End while loop',                 insertText: 'endwhile' },
  { label: 'continue',      detail: 'Skip to next iteration',         insertText: 'continue' },
  { label: 'break',         detail: 'Break out of loop / switch',     insertText: 'break' },

  // Conditional HTML attributes
  { label: 'class',         detail: 'Conditional CSS class list',     insertText: "class([\n    '${1:base-class}',\n    '${2:conditional-class}' => \\$${3:condition},\n])" },
  { label: 'style',         detail: 'Conditional inline CSS styles',  insertText: "style([\n    '${1:property}: ${2:value}',\n    '${3:property}: ${4:value}' => \\$${5:condition},\n])" },
  { label: 'checked',       detail: 'Conditional checked attribute',  insertText: 'checked(${1:condition})' },
  { label: 'selected',      detail: 'Conditional selected attribute', insertText: 'selected(${1:condition})' },
  { label: 'disabled',      detail: 'Conditional disabled attribute', insertText: 'disabled(${1:condition})' },
  { label: 'readonly',      detail: 'Conditional readonly attribute', insertText: 'readonly(${1:condition})' },
  { label: 'required',      detail: 'Conditional required attribute', insertText: 'required(${1:condition})' },

  // Subview includes
  { label: 'include',         detail: 'Include a subview',                    insertText: "include('${1:view.name}')" },
  { label: 'includeIf',       detail: 'Include a view if it exists',          insertText: "includeIf('${1:view.name}')" },
  { label: 'includeWhen',     detail: 'Include a view when condition is true', insertText: "includeWhen(\\$${1:condition}, '${2:view.name}')" },
  { label: 'includeUnless',   detail: 'Include a view unless condition',       insertText: "includeUnless(\\$${1:condition}, '${2:view.name}')" },
  { label: 'includeFirst',    detail: 'Include first existing view in array',  insertText: "includeFirst(['${1:view.name}', '${2:fallback}'])" },
  { label: 'includeIsolated', detail: 'Include view without parent variables', insertText: "includeIsolated('${1:view.name}')" },
  { label: 'each',            detail: 'Render a view for each collection item',insertText: "each('${1:view.name}', \\$${2:items}, '${3:item}')" },

  // Once / push-once
  { label: 'once',          detail: 'Execute once per rendering cycle',  insertText: 'once\n    $1\n@endonce' },
  { label: 'endonce',       detail: 'End once block',                    insertText: 'endonce' },
  { label: 'pushOnce',      detail: 'Push to stack once per cycle',      insertText: "pushOnce('${1:scripts}')\n    $2\n@endPushOnce" },
  { label: 'prependOnce',   detail: 'Prepend to stack once per cycle',   insertText: "prependOnce('${1:scripts}')\n    $2\n@endPrependOnce" },

  // Raw PHP
  { label: 'php',           detail: 'Raw PHP block',                    insertText: 'php\n    $1\n@endphp' },
  { label: 'endphp',        detail: 'End PHP block',                    insertText: 'endphp' },
  { label: 'use',           detail: 'Import a PHP class / function',    insertText: "use('${1:App\\\\Models\\\\Model}')" },
  { label: 'verbatim',      detail: 'Output verbatim (no Blade)',        insertText: 'verbatim\n    $1\n@endverbatim' },
  { label: 'endverbatim',   detail: 'End verbatim block',               insertText: 'endverbatim' },

  // Template inheritance (layouts)
  { label: 'extends',       detail: 'Extend a parent layout',           insertText: "extends('${1:layouts.app}')" },
  { label: 'section',       detail: 'Define a named section',           insertText: "section('${1:content}')\n    $2\n@endsection" },
  { label: 'endsection',    detail: 'End section block',                insertText: 'endsection' },
  { label: 'show',          detail: 'Define and immediately yield a section', insertText: 'show' },
  { label: 'yield',         detail: 'Yield (output) a section',         insertText: "yield('${1:content}')" },
  { label: 'parent',        detail: 'Include parent section content',   insertText: 'parent' },

  // Stacks
  { label: 'push',          detail: 'Push content to a named stack',    insertText: "push('${1:scripts}')\n    $2\n@endpush" },
  { label: 'endpush',       detail: 'End push block',                   insertText: 'endpush' },
  { label: 'pushIf',        detail: 'Conditionally push to a stack',    insertText: "pushIf(\\$${1:condition}, '${2:scripts}')\n    $3\n@endPushIf" },
  { label: 'prepend',       detail: 'Prepend content to a named stack', insertText: "prepend('${1:scripts}')\n    $2\n@endprepend" },
  { label: 'endprepend',    detail: 'End prepend block',                insertText: 'endprepend' },
  { label: 'stack',         detail: 'Render a named stack',             insertText: "stack('${1:scripts}')" },
  { label: 'hasstack',      detail: 'Check if a stack has content',     insertText: "hasstack('${1:scripts}')\n    $2\n@endif" },

  // Forms
  { label: 'csrf',          detail: 'Generate CSRF hidden token field', insertText: 'csrf' },
  { label: 'method',        detail: 'Spoof HTTP method for HTML forms', insertText: "method('${1:PUT}')" },
  { label: 'error',         detail: 'Display a validation error',       insertText: "error('${1:field}')\n    $2\n@enderror" },
  { label: 'enderror',      detail: 'End error block',                  insertText: 'enderror' },

  // Components
  { label: 'props',         detail: 'Declare component props',          insertText: "props(['${1:type}' => '${2:info}', '${3:message}'])" },
  { label: 'aware',         detail: 'Access parent component data',     insertText: "aware(['${1:color}' => '${2:gray}'])" },

  // Fragments (Turbo / htmx)
  { label: 'fragment',      detail: 'Define a renderable fragment',     insertText: "fragment('${1:user-list}')\n    $2\n@endfragment" },
  { label: 'endfragment',   detail: 'End fragment block',               insertText: 'endfragment' },

  // Service injection
  { label: 'inject',        detail: 'Inject a service from the container', insertText: "inject('${1:metrics}', '${2:App\\\\Services\\\\MetricsService}')" },
];

function getBladeCompletions(line, character) {
  const beforeCursor = line.slice(0, character);

  // Match @ followed by optional word characters immediately before the cursor
  const atMatch = beforeCursor.match(/@([a-zA-Z-]*)$/);
  if (!atMatch) return null;

  const typed = atMatch[1].toLowerCase();
  const atCharacter = character - atMatch[0].length; // column position of the @

  const items = BLADE_SNIPPETS
    .filter(s => typed === '' || s.label.toLowerCase().startsWith(typed))
    .map((s, i) => ({
      label: `@${s.label}`,
      kind: 15, // Snippet
      detail: s.detail,
      insertTextFormat: 2, // Snippet (tab stops, placeholders)
      filterText: `@${s.label}`,
      sortText: i.toString().padStart(4, '0'),
      // textEdit replaces "@typed_so_far" with the full snippet
      textEdit: {
        range: {
          start: { line: 0, character: atCharacter }, // line is relative; resolved below
          end:   { line: 0, character },
        },
        newText: `@${s.insertText}`,
      },
    }));

  return { atCharacter, items };
}

function handleMessage(msg) {
  const { id, method, params, result } = msg;

  // Responses to our outbound requests (have id, no method)
  if (id !== undefined && !method) {
    handleResponse(id, result);
    return;
  }

  switch (method) {
    case 'initialize': {
      if (params.workspaceFolders?.length > 0) {
        workspaceRoot = uriToPath(params.workspaceFolders[0].uri);
      } else if (params.rootUri) {
        workspaceRoot = uriToPath(params.rootUri);
      } else if (params.rootPath) {
        workspaceRoot = params.rootPath;
      }

      send({
        jsonrpc: '2.0', id,
        result: {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1 },
            definitionProvider: true,
            completionProvider: {
              triggerCharacters: ['@', '$', ':'],
              resolveProvider: false,
            },
          },
          serverInfo: { name: 'laravel-view-lsp', version: '0.1.0' },
        },
      });
      break;
    }

    case 'initialized': break;

    case 'textDocument/didOpen':
      documents[params.textDocument.uri] = params.textDocument.text;
      if (isPhpFile(params.textDocument.uri)) phpClassCache = null;
      break;

    case 'textDocument/didChange':
      if (params.contentChanges.length > 0) {
        documents[params.textDocument.uri] =
          params.contentChanges[params.contentChanges.length - 1].text;
      }
      if (isPhpFile(params.textDocument.uri)) phpClassCache = null;
      break;

    case 'textDocument/didClose':
      delete documents[params.textDocument.uri];
      break;

    case 'textDocument/completion': {
      const uri = params.textDocument.uri;

      const text = documents[uri] || '';
      const { line: lineNum, character } = params.position;
      const lineText = text.split('\n')[lineNum] || '';

      // PHP completions (non-blade PHP files only)
      if (isPhpFile(uri) && workspaceRoot) {
        // :: static method completions take priority
        const staticItems = getClassStaticCompletions(lineText, character, lineNum, workspaceRoot);
        if (staticItems) {
          send({ jsonrpc: '2.0', id, result: { isIncomplete: false, items: staticItems } });
          break;
        }
        // Fall back to class name / import completions
        const items = getPhpClassCompletions(lineText, character, lineNum, text, workspaceRoot);
        send({ jsonrpc: '2.0', id, result: { isIncomplete: false, items: items || [] } });
        break;
      }

      // Everything below is Blade-only
      if (!isBladeFile(uri)) {
        send({ jsonrpc: '2.0', id, result: { isIncomplete: false, items: [] } });
        break;
      }

      const completion = getBladeCompletions(lineText, character);
      if (completion) {
        // Fix the line number in textEdit ranges (getBladeCompletions uses 0 as placeholder)
        const items = completion.items.map(item => ({
          ...item,
          textEdit: {
            ...item.textEdit,
            range: {
              start: { line: lineNum, character: item.textEdit.range.start.character },
              end:   { line: lineNum, character: item.textEdit.range.end.character },
            },
          },
        }));
        send({ jsonrpc: '2.0', id, result: { isIncomplete: true, items } });
        break;
      }

      // Variable completions: trigger on $, inside {{ }} or anywhere in the file
      const beforeCursor = lineText.slice(0, character);
      const varMatch = beforeCursor.match(/\$([a-zA-Z_]*)$/);
      if (varMatch && workspaceRoot) {
        const viewName = getViewNameFromUri(uri, workspaceRoot);
        if (viewName) {
          const viewVars = findViewVariables(viewName, workspaceRoot);
          if (viewVars.length > 0) {
            const typed = varMatch[1].toLowerCase();
            const dollarStart = character - varMatch[0].length;
            const items = viewVars
              .filter(v => typed === '' || v.toLowerCase().startsWith(typed))
              .map((v, i) => ({
                label: `$${v}`,
                kind: 6, // Variable
                detail: 'View variable',
                sortText: i.toString().padStart(4, '0'),
                textEdit: {
                  range: {
                    start: { line: lineNum, character: dollarStart },
                    end:   { line: lineNum, character },
                  },
                  newText: `$${v}`,
                },
              }));
            send({ jsonrpc: '2.0', id, result: { isIncomplete: false, items } });
            break;
          }
        }
      }

      send({ jsonrpc: '2.0', id, result: { isIncomplete: false, items: [] } });
      break;
    }

    case 'textDocument/definition': {
      const uri = params.textDocument.uri;
      const text = documents[uri] || '';
      const { line, character } = params.position;

      // PHP class jump-to-definition
      if (isPhpFile(uri) && workspaceRoot) {
        const className = classNameAtPosition(text, line, character);
        if (className) {
          const classes = discoverPhpClasses(workspaceRoot);
          const found = classes.find(c => c.className === className);
          if (found) {
            send({
              jsonrpc: '2.0', id,
              result: {
                uri: pathToUri(found.file),
                range: {
                  start: { line: found.line, character: 0 },
                  end:   { line: found.line, character: 0 },
                },
              },
            });
            break;
          }
        }
        send({ jsonrpc: '2.0', id, result: null });
        break;
      }

      const viewName = findViewAtPosition(text, line, character);

      if (!viewName || !workspaceRoot) {
        send({ jsonrpc: '2.0', id, result: null });
        break;
      }

      const filePath = resolveViewPath(viewName, workspaceRoot);

      if (!fs.existsSync(filePath)) {
        send({ jsonrpc: '2.0', id, result: null });

        // Only prompt once per file path at a time
        if (!promptedPaths.has(filePath)) {
          promptedPaths.add(filePath);
          const reqId = nextRequestId++;
          pendingCreations[reqId] = { filePath, viewName };

          send({
            jsonrpc: '2.0',
            id: reqId,
            method: 'window/showMessageRequest',
            params: {
              type: 2, // Warning
              message: `Blade view "${viewName}" does not exist. Create it?`,
              actions: [{ title: 'Create File' }, { title: 'Cancel' }],
            },
          });
        }
        break;
      }

      send({
        jsonrpc: '2.0', id,
        result: {
          uri: pathToUri(filePath),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
      });
      break;
    }

    case 'shutdown':
      send({ jsonrpc: '2.0', id, result: null });
      break;

    case 'exit':
      process.exit(0);
      break;

    default:
      if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
  }
}

// JSON-RPC stdin parser
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  while (true) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep === -1) break;
    const lenMatch = buf.slice(0, sep).match(/Content-Length:\s*(\d+)/i);
    if (!lenMatch) { buf = buf.slice(sep + 4); continue; }
    const len = parseInt(lenMatch[1], 10);
    const bodyStart = sep + 4;
    if (buf.length < bodyStart + len) break;
    const body = buf.slice(bodyStart, bodyStart + len);
    buf = buf.slice(bodyStart + len);
    try { handleMessage(JSON.parse(body)); } catch (_) {}
  }
});
