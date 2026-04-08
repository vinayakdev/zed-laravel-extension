#!/usr/bin/env node
// Laravel LSP — entry point
// Handles JSON-RPC framing, LSP lifecycle, and routes requests to modules.
'use strict';

const fs   = require('fs');
const path = require('path');

const { phpCompletions }  = require('./php/completions');
const { phpDefinition }   = require('./php/definition');
const { invalidateCache, discoverPhpClasses, getAppClass } = require('./php/discovery');
const { bladeCompletions } = require('./blade/completions');
const { resolveViewPath, createBladeFile, findViewAtPosition, findBladeDirectiveViewAtPosition, invalidateViewVarCache } = require('./blade/views');
const { discoverComponents, invalidateComponentCache, componentTagToFiles } = require('./blade/components');
const { getRoutes, invalidateRouteCache, invalidateAllRouteCaches, refreshArtisanRoutes } = require('./php/routes');
const { getConfigEntries, invalidateConfigCache } = require('./php/config');
const { parseEnvFile } = require('./php/env');
const { getModelData, invalidateModelCache } = require('./php/models');
const { inferVariableType } = require('./php/inference');

// ── §1  Infrastructure ───────────────────────────────────────────────────────

// LRU document cache — keeps at most DOC_CACHE_MAX files in memory.
// Map preserves insertion order so the oldest entry is always first.
const DOC_CACHE_MAX = 50;
let documents     = new Map();
let workspaceRoot = null;
let nextRequestId = 1;

/** Upsert a document into the LRU cache, evicting the oldest if at capacity. */
function setDocument(uri, text) {
  if (documents.has(uri)) documents.delete(uri); // refresh position (move to end)
  else if (documents.size >= DOC_CACHE_MAX) documents.delete(documents.keys().next().value);
  documents.set(uri, text);
}

/** Simple debounce — returns a function that delays `fn` by `ms` on each call. */
function debounce(fn, ms) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(...args); }, ms); };
}

/** Debounced class-discovery invalidation — 150 ms quiet window after last change. */
const debouncedInvalidateCache = debounce(invalidateCache, 150);

// Write a debug line to stderr — visible in Zed via: Extensions › laravel-view-lsp log
// (or command palette → "zed: open log")
function dbg(...args) {
  process.stderr.write('[laravel-lsp] ' + args.join(' ') + '\n');
}

function send(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

function uriToPath(uri)      { return decodeURIComponent(uri.replace(/^file:\/\//, '')); }
function pathToUri(filePath) { return 'file://' + filePath; }

function isBladeFile(uri) { return uri.endsWith('.blade.php'); }
function isPhpFile(uri)   { return uri.endsWith('.php') && !isBladeFile(uri); }

// Return document text from cache, falling back to disk if the file was already
// open when the LSP started (didOpen was never received for it).
function getDocumentText(uri) {
  const cached = documents.get(uri);
  if (cached !== undefined) return cached;
  try {
    const text = fs.readFileSync(uriToPath(uri), 'utf8');
    setDocument(uri, text); // warm the cache so subsequent requests are free
    return text;
  } catch (_) { return ''; }
}

// ── View-creation prompt state ───────────────────────────────────────────────

let pendingCreations       = {};
let pendingMethodCreations = {};
let promptedPaths          = new Set();

function promptCreateView(filePath, viewName) {
  promptedPaths.add(filePath);
  const reqId = nextRequestId++;
  pendingCreations[reqId] = { filePath, viewName };
  send({
    jsonrpc: '2.0', id: reqId,
    method: 'window/showMessageRequest',
    params: {
      type:    2,
      message: `Blade view "${viewName}" does not exist. Create it?`,
      actions: [{ title: 'Create File' }, { title: 'Cancel' }],
    },
  });
}

function handleCreateResponse(id, result) {
  if (pendingCreations[id]) {
    const { filePath, viewName } = pendingCreations[id];
    delete pendingCreations[id];
    promptedPaths.delete(filePath);
    if (result?.title === 'Create File') {
      createBladeFile(filePath);
      send({ jsonrpc: '2.0', id: nextRequestId++, method: 'window/showDocument',
             params: { uri: pathToUri(filePath), takeFocus: true } });
      send({ jsonrpc: '2.0', method: 'window/showMessage',
             params: { type: 3, message: `Created: resources/views/${viewName.replace(/\./g, '/')}.blade.php` } });
    }
    return;
  }

  if (pendingMethodCreations[id]) {
    const { filePath, className, methodName } = pendingMethodCreations[id];
    delete pendingMethodCreations[id];
    if (result?.title !== 'Create Method') return;

    let src;
    try { src = fs.readFileSync(filePath, 'utf8'); } catch (_) { return; }

    const lines    = src.split('\n');
    // Find the last line that is just a closing brace — the class end
    let insertAt = lines.length - 1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*\}\s*$/.test(lines[i])) { insertAt = i; break; }
    }

    const ind   = '    '; // 4-space indent
    const stub  = `\n${ind}public function ${methodName}()\n${ind}{\n${ind}    //\n${ind}}\n`;
    const newFnLine = insertAt + 1; // line index of `public function` after insert

    send({
      jsonrpc: '2.0', id: nextRequestId++,
      method: 'workspace/applyEdit',
      params: {
        edit: {
          changes: {
            [pathToUri(filePath)]: [{
              range:   { start: { line: insertAt, character: 0 },
                         end:   { line: insertAt, character: 0 } },
              newText: stub,
            }],
          },
        },
      },
    });

    send({ jsonrpc: '2.0', id: nextRequestId++, method: 'window/showDocument',
           params: { uri: pathToUri(filePath), takeFocus: true,
                     selection: { start: { line: newFnLine, character: ind.length },
                                  end:   { line: newFnLine, character: ind.length + `public function ${methodName}()`.length } } } });
  }
}

// ── Component file creation ───────────────────────────────────────────────────

/**
 * Create an anonymous Blade component at the conventional path.
 * tagName: dot-notated (e.g. "alert", "forms.input")
 * Creates resources/views/components/<tagName as path>.blade.php with a
 * basic @props + $slot template, then opens the file in the editor.
 */
function createComponent(tagName, rootPath) {
  const relPath  = tagName.replace(/\./g, path.sep);
  const filePath = path.join(rootPath, 'resources', 'views', 'components', relPath + '.blade.php');
  const dir      = path.dirname(filePath);
  const relDisplay = 'resources/views/components/' + tagName.replace(/\./g, '/') + '.blade.php';

  if (fs.existsSync(filePath)) {
    send({ jsonrpc: '2.0', method: 'window/showMessage',
           params: { type: 2, message: `Component already exists: ${relDisplay}` } });
    // Still open it so the user can see it
    send({ jsonrpc: '2.0', id: nextRequestId++, method: 'window/showDocument',
           params: { uri: pathToUri(filePath), takeFocus: false } });
    return;
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    // Basic anonymous component: empty div, no props or slots
    const template = '<div>\n\n</div>\n';
    fs.writeFileSync(filePath, template, 'utf8');

    invalidateComponentCache();

    send({ jsonrpc: '2.0', id: nextRequestId++, method: 'window/showDocument',
           params: { uri: pathToUri(filePath), takeFocus: false } });
    send({ jsonrpc: '2.0', method: 'window/showMessage',
           params: { type: 3, message: `Created: ${relDisplay}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', method: 'window/showMessage',
           params: { type: 1, message: `Failed to create component: ${e.message}` } });
  }
}

// ── x-component tag position helper ─────────────────────────────────────────

/**
 * Scan the line for all `<x-tagname` occurrences and check whether the cursor
 * falls within any tag's span (covering `x`, `-`, and the tag name chars).
 * Returns the tag name (e.g. "alert", "forms.input") or null.
 *
 * Using a full-line scan rather than word-expansion means the cursor can sit
 * on `x`, `-`, or any letter of the tag name and still resolve correctly.
 */
function findXTagAtPosition(text, line, character) {
  const lineText = text.split('\n')[line] || '';
  const re = /<x-([\w.-]+)/g;
  let m;
  while ((m = re.exec(lineText)) !== null) {
    const spanStart = m.index + 1;           // position of 'x' (after '<')
    const spanEnd   = m.index + m[0].length; // position after last tag char
    if (character >= spanStart && character <= spanEnd) {
      return m[1]; // the tag name, e.g. "forms.input"
    }
  }
  return null;
}

// ── Controller method go-to-definition helpers ───────────────────────────────

/**
 * Detect if the cursor is on a controller method name in route definitions.
 *
 * Handles both syntaxes:
 *   [WebsiteController::class, 'blogList']
 *   [\App\Http\Controllers\WebsiteController::class, 'blogList']
 *   'WebsiteController@blogList'  (legacy string syntax)
 *
 * Returns { className, methodName } or null.
 */
function findControllerMethodAtPosition(text, line, character) {
  const lineText = text.split('\n')[line] || '';
  let m;

  // Array syntax: [ClassName::class, 'method']
  const arrayRe = /\[\s*\\?(?:[\w\\]+\\)?(\w+)::class\s*,\s*(['"])(\w+)\2/g;
  while ((m = arrayRe.exec(lineText)) !== null) {
    if (character >= m.index && character <= arrayRe.lastIndex)
      return { className: m[1], methodName: m[3] };
  }

  // Legacy string syntax: 'ClassName@method'
  const strRe = /['"]([A-Z]\w*)@(\w+)['"]/g;
  while ((m = strRe.exec(lineText)) !== null) {
    if (character >= m.index && character <= strRe.lastIndex)
      return { className: m[1], methodName: m[2] };
  }

  return null;
}

/**
 * Resolve a controller method to an LSP Location.
 * Returns { uri, range } pointing to the method definition, or null if not found.
 */
function resolveControllerMethod(className, methodName, root, pathToUri) {
  const classEntry = getAppClass(root, className);
  if (!classEntry) return null;

  let methodLine = null;
  try {
    const src   = fs.readFileSync(classEntry.file, 'utf8');
    const lines = src.split('\n');
    const re    = new RegExp(`function\\s+${methodName}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) { methodLine = i; break; }
    }
  } catch (_) { return null; }

  if (methodLine === null) return null;

  return {
    uri:   pathToUri(classEntry.file),
    range: { start: { line: methodLine, character: 0 },
             end:   { line: methodLine, character: 0 } },
  };
}

/**
 * Prompt the user to create a public method in an existing controller class.
 */
function promptCreateMethod(filePath, className, methodName) {
  const reqId = nextRequestId++;
  pendingMethodCreations[reqId] = { filePath, className, methodName };
  send({
    jsonrpc: '2.0', id: reqId,
    method: 'window/showMessageRequest',
    params: {
      type:    2,
      message: `Method "${methodName}" not found in ${className}. Create it?`,
      actions: [{ title: 'Create Method' }, { title: 'Cancel' }],
    },
  });
}

// ── §6  route() / config() completion helpers ────────────────────────────────

/**
 * Detect if the cursor is inside route('...') or config('...').
 * Returns { type: 'route'|'config', typed: string } or null.
 *
 * Matches both single and double quoted strings, and handles the cursor
 * sitting anywhere inside the argument (including empty: route('|')).
 */
function detectLaravelStringContext(lineText, character) {
    const prefix = lineText.slice(0, character);
    let m;

    m = prefix.match(/\broute\(\s*["']([^"']*)$/);
    if (m) return { type: 'route',  typed: m[1] };

    m = prefix.match(/\bconfig\(\s*["']([^"']*)$/);
    if (m) return { type: 'config', typed: m[1] };

    return null;
}

/** Build LSP completion items for named routes. */
function routeCompletionItems(rootPath, typed, lineNum, character) {
    const routes = getRoutes(rootPath);
    // Replace range: start of the typed prefix up to the current cursor
    const replaceStart = character - typed.length;
    return routes
        .filter(r => r.name.startsWith(typed))
        .map(r => {
            const docs = r.action ? `**Action:** ${r.action}` : '';
            return {
                label:         r.name,
                kind:          12,          // Value
                detail:        `${r.verb} ${r.uri}`,
                documentation: docs ? { kind: 'markdown', value: docs } : undefined,
                // textEdit replaces exactly the typed prefix so no duplication on commit
                textEdit: {
                    range: { start: { line: lineNum, character: replaceStart },
                             end:   { line: lineNum, character } },
                    newText: r.name,
                },
                filterText: r.name,
                sortText:   '\x00' + r.name,
            };
        });
}

/** Build LSP completion items for config keys, showing current/default values. */
function configCompletionItems(rootPath, typed, lineNum, character) {
    const entries     = getConfigEntries(rootPath);
    const envValues   = parseEnvFile(rootPath);
    const replaceStart = character - typed.length;

    return entries
        .filter(e => e.key.startsWith(typed))
        .map(e => {
            let detail  = '';
            let mdLines = [];

            if (e.envKey) {
                const live = envValues[e.envKey];
                detail = live !== undefined ? `${e.envKey} = "${live}"` : `env('${e.envKey}')`;
                mdLines.push(`**Env key:** \`${e.envKey}\``);
                if (e.default !== null)      mdLines.push(`**Default:** ${e.default}`);
                if (live !== undefined)      mdLines.push(`**Current (.env):** \`${live}\``);
            } else if (e.literal !== null) {
                detail = e.literal;
                mdLines.push(`**Value:** ${e.literal}`);
            }

            return {
                label:         e.key,
                kind:          12,          // Value
                detail,
                documentation: mdLines.length ? { kind: 'markdown', value: mdLines.join('\n\n') } : undefined,
                textEdit: {
                    range: { start: { line: lineNum, character: replaceStart },
                             end:   { line: lineNum, character } },
                    newText: e.key,
                },
                filterText: e.key,
                sortText:   '\x00' + e.key,
            };
        });
}

// ── §6b  Eloquent argument-context detection ──────────────────────────────────

const ELOQUENT_ATTR_METHODS = new Set([
    'where', 'orWhere', 'whereIn', 'whereNotIn', 'whereBetween',
    'whereNull', 'whereNotNull', 'orderBy', 'orderByDesc', 'select',
    'addSelect', 'groupBy', 'value', 'pluck', 'max', 'min', 'sum',
    'avg', 'increment', 'decrement', 'whereColumn', 'firstWhere',
]);

const ELOQUENT_REL_METHODS = new Set([
    'with', 'without', 'withCount', 'withAvg', 'withSum', 'withMax',
    'withMin', 'whereHas', 'orWhereHas', 'whereDoesntHave',
    'orWhereDoesntHave', 'has', 'doesntHave', 'orHas', 'orDoesntHave',
]);

const ELOQUENT_FILL_METHODS = new Set([
    'create', 'forceCreate', 'make', 'fill', 'firstOrCreate',
    'firstOrNew', 'updateOrCreate', 'update',
]);

/**
 * Detect if the cursor is inside an Eloquent method string argument.
 * Returns { type: 'attribute'|'relation'|'fillable', className, typed } or null.
 */
function detectEloquentArgContext(lineText, character, fileText, lineNum) {
    const prefix = lineText.slice(0, character);

    // Array-key context: ->create(['col|  or ->update(['col|
    const arrayKeyRe = /(?:->|::)(\w+)\s*\(\s*\[(?:[^\[\]]*,\s*)?["']([^"']*)$/;
    const arrayMatch = arrayKeyRe.exec(prefix);
    if (arrayMatch && ELOQUENT_FILL_METHODS.has(arrayMatch[1])) {
        const className = resolveEloquentClass(prefix, arrayMatch.index, fileText, lineNum);
        if (!className) return null;
        return { type: 'fillable', className, typed: arrayMatch[2] };
    }

    // String-argument context: ->where('col|  or ::where('col|
    const argRe = /(?:->|::)(\w+)\s*\((?:[^()]*,\s*)?["']([^"']*)$/;
    const argMatch = argRe.exec(prefix);
    if (!argMatch) return null;

    const methodName = argMatch[1];
    const typed      = argMatch[2];

    let type;
    if      (ELOQUENT_ATTR_METHODS.has(methodName)) type = 'attribute';
    else if (ELOQUENT_REL_METHODS.has(methodName))  type = 'relation';
    else return null;

    // Pass argMatch.index so resolveEloquentClass only looks at the receiver
    // segment before this specific method call — avoids picking up $this or
    // an unrelated class earlier in the line.
    const className = resolveEloquentClass(prefix, argMatch.index, fileText, lineNum);
    if (!className) return null;

    return { type, className, typed };
}

/**
 * Resolve the Eloquent model class name from the part of the line that comes
 * before the method call at `methodCallIndex`.
 *
 * @param {string} prefix          - full line text up to cursor
 * @param {number} methodCallIndex - index of the `->` or `::` that starts the method call
 * @param {string} fileText        - full document text (for variable type inference)
 * @param {number} lineNum         - 0-based line number (for variable type inference)
 */
function resolveEloquentClass(prefix, methodCallIndex, fileText, lineNum) {
    // `before` is everything up to (but not including) the `->` or `::` at methodCallIndex.
    // For "User::with('", methodCallIndex=4 so before="User" (no `::` included).
    const before = prefix.slice(0, methodCallIndex);

    // Direct static call: the receiver is an uppercase class name at the very end
    // of `before`, e.g. before="User" from "User::with(".
    const directStatic = before.match(/\b([A-Z][a-zA-Z0-9_]*)$/);
    if (directStatic) return directStatic[1];

    // Chained static: User::query()->with( — `before` contains "User::query()"
    const chainStatic = before.match(/\b([A-Z][a-zA-Z0-9_]*)::/);
    if (chainStatic) return chainStatic[1];

    // Direct instance: $var-> immediately before this method call (skip $this)
    const directInstance = before.match(/\$(?!this\b)([a-zA-Z_]\w*)\s*$/);
    if (directInstance) return inferVariableType(directInstance[1], fileText, lineNum) || null;

    // Chained instance: $var->something()-> — first non-$this var in the chain
    const chainInstance = before.match(/\$(?!this\b)([a-zA-Z_]\w*)->/);
    if (chainInstance) return inferVariableType(chainInstance[1], fileText, lineNum) || null;

    return null;
}

/**
 * Build LSP completion items for Eloquent model attributes, relations, or fillable fields.
 */
function buildModelCompletionItems(type, className, typed, lineNum, character, root) {
    const model = getModelData(className, root);
    if (!model) return [];

    const replaceStart = character - typed.length;

    if (type === 'attribute') {
        return model.attributes
            .filter(a => !typed || a.name.startsWith(typed))
            .map(a => {
                const parts = [a.type, a.cast ? `cast:${a.cast}` : '', a.fillable ? 'fillable' : ''].filter(Boolean);
                return {
                    label:      a.name,
                    kind:       12,
                    detail:     parts.join(' · ') || 'attribute',
                    textEdit: {
                        range:   { start: { line: lineNum, character: replaceStart },
                                   end:   { line: lineNum, character } },
                        newText: a.name,
                    },
                    filterText: a.name,
                    sortText:   '\x00' + a.name,
                };
            });
    }

    if (type === 'relation') {
        return model.relations
            .filter(r => !typed || r.name.startsWith(typed))
            .map(r => ({
                label:      r.name,
                kind:       12,
                detail:     `${r.type} → ${r.related}`,
                textEdit: {
                    range:   { start: { line: lineNum, character: replaceStart },
                               end:   { line: lineNum, character } },
                    newText: r.name,
                },
                filterText: r.name,
                sortText:   '\x00' + r.name,
            }));
    }

    if (type === 'fillable') {
        return model.attributes
            .filter(a => a.fillable && (!typed || a.name.startsWith(typed)))
            .map(a => ({
                label:      a.name,
                kind:       12,
                detail:     [a.type, a.cast ? `cast:${a.cast}` : ''].filter(Boolean).join(' · ') || 'fillable',
                textEdit: {
                    range:   { start: { line: lineNum, character: replaceStart },
                               end:   { line: lineNum, character } },
                    newText: a.name,
                },
                filterText: a.name,
                sortText:   '\x00' + a.name,
            }));
    }

    return [];
}

/**
 * If the cursor is on a quoted string inside a relation method (with, whereHas, etc.),
 * navigate to that relation's method definition inside the model file.
 *
 * Returns an LSP Location or null.
 */
function resolveRelationDefinition(fileText, lineNum, character, root, pathToUri) {
    const lineText = fileText.split('\n')[lineNum] || '';

    // Find the full quoted string the cursor is inside (e.g. 'blogs' or "blogs")
    const quotedRe = /["']([a-zA-Z_]\w*)["']/g;
    let relationName = null;
    let qm;
    while ((qm = quotedRe.exec(lineText)) !== null) {
        // +1 / -1 to exclude the quote chars themselves
        if (character >= qm.index + 1 && character <= qm.index + qm[0].length - 1) {
            relationName = qm[1];
            break;
        }
    }
    if (!relationName) return null;

    // Use the position at the end of the quoted string to detect context
    const endOfQuote = qm.index + qm[0].length;
    const modelCtx = detectEloquentArgContext(lineText, endOfQuote, fileText, lineNum);
    if (!modelCtx || modelCtx.type !== 'relation') return null;

    const { className } = modelCtx;

    // Verify the relation exists on this model
    const model = getModelData(className, root);
    if (!model) return null;
    const relation = model.relations.find(r => r.name === relationName);
    if (!relation) return null;

    // Find the model file via the class discovery cache
    const classEntry = getAppClass(root, className);
    if (!classEntry || !classEntry.file) return null;

    // Scan the model file for the relation method definition line
    let methodLine = 0;
    try {
        const src   = require('fs').readFileSync(classEntry.file, 'utf8');
        const lines = src.split('\n');
        const methodRe = new RegExp(`function\\s+${relationName}\\s*\\(`);
        for (let i = 0; i < lines.length; i++) {
            if (methodRe.test(lines[i])) { methodLine = i; break; }
        }
    } catch (_) { return null; }

    return {
        uri:   pathToUri(classEntry.file),
        range: { start: { line: methodLine, character: 0 },
                 end:   { line: methodLine, character: 0 } },
    };
}

// ── §7  Message handler ──────────────────────────────────────────────────────

function handleMessage(msg) {
  const { id, method, params, result } = msg;

  if (id !== undefined && !method) { handleCreateResponse(id, result); return; }

  switch (method) {

    // Lifecycle
    case 'initialize': {
      if      (params.workspaceFolders?.length > 0) workspaceRoot = uriToPath(params.workspaceFolders[0].uri);
      else if (params.rootUri)                       workspaceRoot = uriToPath(params.rootUri);
      else if (params.rootPath)                      workspaceRoot = params.rootPath;
      dbg('initialized — workspaceRoot:', workspaceRoot);
      send({
        jsonrpc: '2.0', id,
        result: {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1 },
            definitionProvider: true,
            hoverProvider: true,
            completionProvider: { triggerCharacters: ['@', '$', ':', '-', '>', "'", '"', '.'], resolveProvider: false },
            executeCommandProvider: { commands: ['laravel.createComponent'] },
          },
          serverInfo: { name: 'laravel-view-lsp', version: '0.1.2' },
        },
      });
      break;
    }
    case 'initialized':
      // Kick off artisan route:list in the background so the first completion
      // that references route() already has package/SP routes available.
      if (workspaceRoot) refreshArtisanRoutes(workspaceRoot);
      break;
    case 'shutdown':    send({ jsonrpc: '2.0', id, result: null }); break;
    case 'exit':        process.exit(0);

    // Document sync
    case 'textDocument/didOpen': {
      const openUri = params.textDocument.uri;
      setDocument(openUri, params.textDocument.text);
      if (isPhpFile(openUri)) invalidateCache();
      if (isPhpFile(openUri)   && openUri.includes('/app/View/Components/'))        invalidateComponentCache();
      if (isBladeFile(openUri) && openUri.includes('/resources/views/components/')) invalidateComponentCache();
      if (isPhpFile(openUri)   && openUri.includes('/routes/'))  { invalidateAllRouteCaches(); invalidateViewVarCache(); }
      if (isPhpFile(openUri)   && openUri.includes('/app/') && !openUri.includes('/app/View/Components/')) invalidateViewVarCache();
      if (isPhpFile(openUri)   && openUri.includes('/config/'))  invalidateConfigCache();
      if (isPhpFile(openUri) && (openUri.includes('/app/Models/') || openUri.includes('/database/migrations/')))
          invalidateModelCache();
      break;
    }

    case 'textDocument/didChange': {
      const changeUri = params.textDocument.uri;
      if (params.contentChanges.length > 0)
        setDocument(changeUri, params.contentChanges[params.contentChanges.length - 1].text);
      if (isPhpFile(changeUri)) debouncedInvalidateCache();
      if (isPhpFile(changeUri)   && changeUri.includes('/app/View/Components/'))        invalidateComponentCache();
      if (isBladeFile(changeUri) && changeUri.includes('/resources/views/components/')) invalidateComponentCache();
      if (isPhpFile(changeUri)   && changeUri.includes('/routes/'))  { invalidateAllRouteCaches(); invalidateViewVarCache(); }
      if (isPhpFile(changeUri)   && changeUri.includes('/app/') && !changeUri.includes('/app/View/Components/')) invalidateViewVarCache();
      if (isPhpFile(changeUri)   && changeUri.includes('/config/'))  invalidateConfigCache();
      if (isPhpFile(changeUri) && (changeUri.includes('/app/Models/') || changeUri.includes('/database/migrations/')))
          invalidateModelCache();
      break;
    }

    case 'textDocument/didClose':
      documents.delete(params.textDocument.uri);
      break;

    // Completions
    case 'textDocument/completion': {
      const uri      = params.textDocument.uri;
      const text     = getDocumentText(uri);
      const { line: lineNum, character } = params.position;
      const lineText = text.split('\n')[lineNum] || '';

      let completionResult = { isIncomplete: false, items: [] };

      // route('...') and config('...') work in both PHP and Blade files
      if (workspaceRoot) {
        const laravelCtx = detectLaravelStringContext(lineText, character);
        if (laravelCtx) {
          const items = laravelCtx.type === 'route'
            ? routeCompletionItems(workspaceRoot, laravelCtx.typed, lineNum, character)
            : configCompletionItems(workspaceRoot, laravelCtx.typed, lineNum, character);
          // isIncomplete: true tells the editor to re-request on every keystroke
          // so typing 'app.' keeps the list alive without needing it as a trigger char
          send({ jsonrpc: '2.0', id, result: { isIncomplete: true, items } });
          break;
        }
      }

      // Eloquent model argument completions (attributes / relations / fillable)
      if (workspaceRoot && (isPhpFile(uri) || isBladeFile(uri))) {
          const modelCtx = detectEloquentArgContext(lineText, character, text, lineNum);
          if (modelCtx) {
              const items = buildModelCompletionItems(
                  modelCtx.type, modelCtx.className, modelCtx.typed,
                  lineNum, character, workspaceRoot
              );
              send({ jsonrpc: '2.0', id, result: { isIncomplete: true, items } });
              break;
          }
      }

      if      (isPhpFile(uri)   && workspaceRoot) completionResult = phpCompletions(lineText, character, lineNum, text, workspaceRoot);
      else if (isBladeFile(uri))                  completionResult = bladeCompletions(lineText, character, lineNum, uri, workspaceRoot);

      send({ jsonrpc: '2.0', id, result: completionResult });
      break;
    }

    // Definitions
    case 'textDocument/definition': {
      const uri  = params.textDocument.uri;
      const text = getDocumentText(uri);
      const { line, character } = params.position;

      if (isPhpFile(uri) && workspaceRoot) {
        // Try class-name navigation first; fall through to view() navigation if it returns nothing
        const classDef = phpDefinition(text, line, character, workspaceRoot, pathToUri);
        if (classDef) { send({ jsonrpc: '2.0', id, result: classDef }); break; }

        // Eloquent relation go-to-definition: cursor on 'relationName' inside with()/whereHas()/etc.
        // Extract the full quoted word at the cursor position, then resolve the model + method.
        const relDef = resolveRelationDefinition(text, line, character, workspaceRoot, pathToUri);
        if (relDef) { send({ jsonrpc: '2.0', id, result: relDef }); break; }

        // Controller method in route array syntax: [ClassName::class, 'method']
        const ctrlCtx = findControllerMethodAtPosition(text, line, character);
        if (ctrlCtx) {
          const ctrlDef = resolveControllerMethod(ctrlCtx.className, ctrlCtx.methodName, workspaceRoot, pathToUri);
          if (ctrlDef) {
            send({ jsonrpc: '2.0', id, result: ctrlDef }); break;
          }
          // Method not found — offer to create it
          send({ jsonrpc: '2.0', id, result: null });
          const classEntry = getAppClass(workspaceRoot, ctrlCtx.className);
          if (classEntry) promptCreateMethod(classEntry.file, ctrlCtx.className, ctrlCtx.methodName);
          break;
        }

        // view('some.view') in controllers / routes
        const viewName = findViewAtPosition(text, line, character);
        dbg('definition/php — uri:', uri);
        dbg('definition/php — textLen:', text.length, 'line:', line, 'char:', character);
        dbg('definition/php — viewName:', viewName);
        if (viewName) {
          const filePath = resolveViewPath(viewName, workspaceRoot);
          dbg('definition/php — resolved path:', filePath, 'exists:', fs.existsSync(filePath));
          if (fs.existsSync(filePath)) {
            send({ jsonrpc: '2.0', id, result: { uri: pathToUri(filePath),
                   range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } });
          } else {
            send({ jsonrpc: '2.0', id, result: null });
            if (!promptedPaths.has(filePath)) promptCreateView(filePath, viewName);
          }
          break;
        }

        send({ jsonrpc: '2.0', id, result: null });
        break;
      }

      if (isBladeFile(uri) && workspaceRoot) {
        // Check if cursor is on an x-component tag — only handle if we find files,
        // otherwise fall through to the view() navigation below.
        try {
          const xTag = findXTagAtPosition(text, line, character);
          if (xTag) {
            const { classFile, viewFile } = componentTagToFiles(xTag, workspaceRoot);
            const locs = [];
            if (classFile && fs.existsSync(classFile))
              locs.push({ uri: pathToUri(classFile), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } });
            if (viewFile && fs.existsSync(viewFile))
              locs.push({ uri: pathToUri(viewFile),  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } });
            if (locs.length) {
              send({ jsonrpc: '2.0', id, result: locs });
              break;
            }
          }
        } catch (_) {}

        // view('some.view') call or @include/@extends/@includeIf/etc. directive
        const viewName = findViewAtPosition(text, line, character)
                      || findBladeDirectiveViewAtPosition(text, line, character);
        if (!viewName) { send({ jsonrpc: '2.0', id, result: null }); break; }

        const filePath = resolveViewPath(viewName, workspaceRoot);
        if (fs.existsSync(filePath)) {
          send({ jsonrpc: '2.0', id, result: { uri: pathToUri(filePath),
                 range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } });
        } else {
          send({ jsonrpc: '2.0', id, result: null });
          if (!promptedPaths.has(filePath)) promptCreateView(filePath, viewName);
        }
        break;
      }

      send({ jsonrpc: '2.0', id, result: null });
      break;
    }

    // Hover — show model attribute/relation info
    case 'textDocument/hover': {
      const uri      = params.textDocument.uri;
      const text     = getDocumentText(uri);
      const { line: lineNum, character } = params.position;
      const lineText = text.split('\n')[lineNum] || '';

      if (workspaceRoot && isPhpFile(uri)) {
        // Find quoted word under cursor
        const wordRe = /["']([a-zA-Z_]\w*)["']/g;
        let hoveredWord = null;
        let wm;
        while ((wm = wordRe.exec(lineText)) !== null) {
          if (character >= wm.index + 1 && character <= wm.index + wm[0].length - 1) {
            hoveredWord = wm[1];
            break;
          }
        }

        if (hoveredWord) {
          const modelCtx = detectEloquentArgContext(lineText, character, text, lineNum);
          if (modelCtx) {
            const model = getModelData(modelCtx.className, workspaceRoot);
            if (model) {
              const attr = model.attributes.find(a => a.name === hoveredWord);
              if (attr) {
                const lines = [
                  `**${modelCtx.className}** · \`${attr.name}\``,
                  `**Type:** ${attr.type || 'unknown'}`,
                  attr.cast ? `**Cast:** ${attr.cast}` : null,
                  `**Fillable:** ${attr.fillable ? 'yes ✓' : 'no'}`,
                ].filter(Boolean);
                send({ jsonrpc: '2.0', id, result: { contents: { kind: 'markdown', value: lines.join('\n\n') } } });
                break;
              }
              const rel = model.relations.find(r => r.name === hoveredWord);
              if (rel) {
                const lines = [
                  `**${modelCtx.className}** relation · \`${rel.name}\``,
                  `**Type:** ${rel.type}`,
                  `**Related:** \`${rel.related}\``,
                ];
                send({ jsonrpc: '2.0', id, result: { contents: { kind: 'markdown', value: lines.join('\n\n') } } });
                break;
              }
            }
          }
        }
      }

      send({ jsonrpc: '2.0', id, result: null });
      break;
    }

    // Component scaffolding
    case 'workspace/executeCommand': {
      const { command, arguments: args = [] } = params;
      if (command === 'laravel.createComponent') {
        const [tagName, rootPath] = args;
        if (tagName && rootPath) createComponent(tagName, rootPath);
      }
      send({ jsonrpc: '2.0', id, result: null });
      break;
    }

    default:
      if (id !== undefined)
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

// ── §8  JSON-RPC stdin parser ────────────────────────────────────────────────

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
