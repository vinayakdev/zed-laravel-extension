#!/usr/bin/env node
// Minimal LSP: resolves Laravel view() calls to blade template files

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
          },
          serverInfo: { name: 'laravel-view-lsp', version: '0.1.0' },
        },
      });
      break;
    }

    case 'initialized': break;

    case 'textDocument/didOpen':
      documents[params.textDocument.uri] = params.textDocument.text;
      break;

    case 'textDocument/didChange':
      if (params.contentChanges.length > 0) {
        documents[params.textDocument.uri] =
          params.contentChanges[params.contentChanges.length - 1].text;
      }
      break;

    case 'textDocument/didClose':
      delete documents[params.textDocument.uri];
      break;

    case 'textDocument/definition': {
      const text = documents[params.textDocument.uri] || '';
      const { line, character } = params.position;
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
