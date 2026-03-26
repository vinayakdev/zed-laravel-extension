#!/usr/bin/env node
// Laravel LSP — entry point
// Handles JSON-RPC framing, LSP lifecycle, and routes requests to modules.
'use strict';

const fs   = require('fs');
const path = require('path');

const { phpCompletions }  = require('./php/completions');
const { phpDefinition }   = require('./php/definition');
const { invalidateCache } = require('./php/discovery');
const { bladeCompletions } = require('./blade/completions');
const { resolveViewPath, createBladeFile, findViewAtPosition } = require('./blade/views');

// ── §1  Infrastructure ───────────────────────────────────────────────────────

let documents     = {};
let workspaceRoot = null;
let nextRequestId = 1;

function send(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

function uriToPath(uri)      { return decodeURIComponent(uri.replace(/^file:\/\//, '')); }
function pathToUri(filePath) { return 'file://' + filePath; }

function isBladeFile(uri) { return uri.endsWith('.blade.php'); }
function isPhpFile(uri)   { return uri.endsWith('.php') && !isBladeFile(uri); }

// ── View-creation prompt state ───────────────────────────────────────────────

let pendingCreations = {};
let promptedPaths    = new Set();

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
  if (!pendingCreations[id]) return;
  const { filePath, viewName } = pendingCreations[id];
  delete pendingCreations[id];
  promptedPaths.delete(filePath);

  if (result?.title !== 'Create File') return;

  createBladeFile(filePath);
  send({ jsonrpc: '2.0', id: nextRequestId++, method: 'window/showDocument',
         params: { uri: pathToUri(filePath), takeFocus: true } });
  send({ jsonrpc: '2.0', method: 'window/showMessage',
         params: { type: 3, message: `Created: resources/views/${viewName.replace(/\./g, '/')}.blade.php` } });
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
      send({
        jsonrpc: '2.0', id,
        result: {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1 },
            definitionProvider: true,
            completionProvider: { triggerCharacters: ['@', '$', ':', '-', '>'], resolveProvider: false },
          },
          serverInfo: { name: 'laravel-view-lsp', version: '0.1.0' },
        },
      });
      break;
    }
    case 'initialized': break;
    case 'shutdown':    send({ jsonrpc: '2.0', id, result: null }); break;
    case 'exit':        process.exit(0);

    // Document sync
    case 'textDocument/didOpen':
      documents[params.textDocument.uri] = params.textDocument.text;
      if (isPhpFile(params.textDocument.uri)) invalidateCache();
      break;

    case 'textDocument/didChange':
      if (params.contentChanges.length > 0)
        documents[params.textDocument.uri] = params.contentChanges[params.contentChanges.length - 1].text;
      if (isPhpFile(params.textDocument.uri)) invalidateCache();
      break;

    case 'textDocument/didClose':
      delete documents[params.textDocument.uri];
      break;

    // Completions
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

    // Definitions
    case 'textDocument/definition': {
      const uri  = params.textDocument.uri;
      const text = documents[uri] || '';
      const { line, character } = params.position;

      if (isPhpFile(uri) && workspaceRoot) {
        send({ jsonrpc: '2.0', id, result: phpDefinition(text, line, character, workspaceRoot, pathToUri) });
        break;
      }

      if (isBladeFile(uri) && workspaceRoot) {
        const viewName = findViewAtPosition(text, line, character);
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
