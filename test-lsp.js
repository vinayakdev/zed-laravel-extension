#!/usr/bin/env node
'use strict';

/**
 * LSP protocol smoke test.
 * Spawns the real server.js and sends JSON-RPC messages through stdin/stdout,
 * exactly as Zed does.
 *
 * Usage:  node test-lsp.js /path/to/laravel/project
 */

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');

const root = process.argv[2];
if (!root) { console.error('Usage: node test-lsp.js /path/to/laravel'); process.exit(1); }

// ── RPC helpers ───────────────────────────────────────────────────────────────

function encode(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

let idCounter = 1;
function req(method, params) {
  return { jsonrpc: '2.0', id: idCounter++, method, params };
}
function notif(method, params) {
  return { jsonrpc: '2.0', method, params };
}

// ── Spawn server ──────────────────────────────────────────────────────────────

const server = spawn('node', [path.join(__dirname, 'lsp', 'server.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

// ── Response reader ───────────────────────────────────────────────────────────

let buf = '';
const pending = new Map(); // id → { resolve, label }

server.stdout.setEncoding('utf8');
server.stdout.on('data', chunk => {
  buf += chunk;
  while (true) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep === -1) break;
    const lenMatch = buf.slice(0, sep).match(/Content-Length:\s*(\d+)/i);
    if (!lenMatch) { buf = buf.slice(sep + 4); continue; }
    const len   = parseInt(lenMatch[1], 10);
    const start = sep + 4;
    if (buf.length < start + len) break;
    const msg = JSON.parse(buf.slice(start, start + len));
    buf = buf.slice(start + len);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, label } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve({ label, msg });
    }
  }
});

function send(obj) { server.stdin.write(encode(obj)); }

function rpc(method, params, label) {
  return new Promise(resolve => {
    const msg = req(method, params);
    pending.set(msg.id, { resolve, label });
    send(msg);
  });
}

// ── Test sequence ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function check(label, actual, predicate) {
  if (predicate(actual)) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}  →  ${JSON.stringify(actual)}`);
    failed++;
  }
}

async function run() {
  // 1. initialize
  const { msg: initMsg } = await rpc('initialize', {
    rootUri:          'file://' + root,
    workspaceFolders: [{ uri: 'file://' + root, name: 'laravel' }],
    capabilities:     {},
  }, 'initialize');
  check('initialize', initMsg.result?.capabilities, c => c?.completionProvider);

  // 2. initialized (notification — no response expected)
  send(notif('initialized', {}));
  await new Promise(r => setTimeout(r, 100)); // let prefetch kick off

  // 3. Open a PHP file
  const phpUri  = 'file:///tmp/test_lsp_file.php';
  const phpText = `<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\n\nclass User extends Model {\n}\n`;
  send(notif('textDocument/didOpen', {
    textDocument: { uri: phpUri, languageId: 'php', version: 1, text: phpText },
  }));

  // 4. Completion: User::
  const line     = 'User::';
  const { msg: comp1 } = await rpc('textDocument/completion', {
    textDocument: { uri: phpUri },
    position:     { line: 6, character: line.length },
    context:      { triggerKind: 2, triggerCharacter: ':' },
  }, 'User:: completion');
  // Inject the line into documents via didChange so server sees it
  send(notif('textDocument/didChange', {
    textDocument:   { uri: phpUri, version: 2 },
    contentChanges: [{ text: phpText + '\n' + line }],
  }));
  const { msg: comp2 } = await rpc('textDocument/completion', {
    textDocument: { uri: phpUri },
    position:     { line: 7, character: line.length },
  }, 'User:: completion (2)');
  const labels = (comp2.result?.items || []).map(i => i.label);
  console.log(`\n  User:: items: [${labels.slice(0,6).join(', ')}${labels.length > 6 ? '…' : ''}]`);
  check('User:: returns completions', labels, l => l.length > 0);

  // 5. Shutdown
  await rpc('shutdown', {}, 'shutdown');
  send(notif('exit', {}));

  console.log(`\n── Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
