#!/usr/bin/env node
'use strict';

/**
 * Manual test runner for the Laravel LSP modules.
 * Usage:  node test.js /path/to/your/laravel/project
 *
 * No test framework needed — just pipes output to stdout so you can
 * eyeball what the completions/discovery actually returns.
 */

const root = process.argv[2];
if (!root) {
  console.error('Usage: node test.js /path/to/laravel/project');
  process.exit(1);
}

const { discoverPhpClasses }          = require('./lsp/php/discovery');
const { phpCompletions }              = require('./lsp/php/completions');
const { inferVariableType, inferCurrentClass } = require('./lsp/php/inference');
const { resolveMembers }              = require('./lsp/php/resolver');
const { getVendorClass }              = require('./lsp/php/vendor');

// ── helpers ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
          || (typeof expected === 'function' && expected(actual));
  if (ok) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    console.error(`     expected: ${JSON.stringify(expected)}`);
    console.error(`     actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function completionLabels(lineText, character, fileText) {
  const result = phpCompletions(lineText, character, 0, fileText, root);
  return result.items.map(i => i.label);
}

// ── 1. Class discovery ────────────────────────────────────────────────────────

console.log('\n── 1. Class discovery');
const classes = discoverPhpClasses(root);
console.log(`   Found ${classes.length} classes in app/`);
classes.slice(0, 5).forEach(c => console.log(`   • ${c.fqn}  (${c.methods.length} methods, ${c.traits.length} traits)`));

// ── 2. Scope detection ────────────────────────────────────────────────────────

console.log('\n── 2. Scope detection');
classes.forEach(c => {
  const scopes = c.methods.filter(m => m.isScope);
  if (scopes.length) {
    console.log(`   ${c.className}: scopes = [${scopes.map(s => s.scopeName).join(', ')}]`);
  }
});

// ── 3. Static completions (User::) ───────────────────────────────────────────

console.log('\n── 3. Static completions');
const fileText = `<?php\nuse App\\Models\\User;\n`;
const staticLine  = 'User::';
const staticItems = completionLabels(staticLine, staticLine.length, fileText);
console.log(`   User:: → [${staticItems.slice(0, 8).join(', ')}${staticItems.length > 8 ? '…' : ''}]`);
check('User:: returns items', staticItems.length > 0, true);

// ── 4. Chain completions (User::where()->  ) ──────────────────────────────────

console.log('\n── 4. Chain completions');
const chainLine  = 'User::where()->';
const chainItems = completionLabels(chainLine, chainLine.length, fileText);
console.log(`   User::where()-> → [${chainItems.slice(0, 8).join(', ')}${chainItems.length > 8 ? '…' : ''}]`);
check('chain returns items', chainItems.length > 0, true);

// ── 5. Inference ──────────────────────────────────────────────────────────────

console.log('\n── 5. Variable type inference');
const inferText = `<?php\nfunction test() {\n  $user = new User();\n`;
check('new User() → User', inferVariableType('user', inferText, 3), 'User');

const inferText2 = `<?php\nfunction test() {\n  $user = User::find(1);\n`;
check('User::find() → User', inferVariableType('user', inferText2, 3), 'User');

const classText = `<?php\nclass User extends Model {\n  public function test() {\n`;
check('inferCurrentClass', inferCurrentClass(classText, 3), 'User');

// ── 6. Vendor resolution (SoftDeletes) ───────────────────────────────────────

console.log('\n── 6. Vendor class resolution');
const softDeletesFileText = `<?php\nuse Illuminate\\Database\\Eloquent\\SoftDeletes;\n`;
const sd = getVendorClass('SoftDeletes', softDeletesFileText, root);
if (sd) {
  console.log(`   SoftDeletes found: ${sd.methods.length} methods`);
  console.log(`   methods: [${sd.methods.slice(0,6).map(m=>m.name).join(', ')}]`);
  check('SoftDeletes has delete method', sd.methods.some(m => m.name === 'delete'), true);
} else {
  console.log('   SoftDeletes not found (vendor/ may not be present)');
}

// ── 7. $this-> completions ────────────────────────────────────────────────────

console.log('\n── 7. $this-> completions');
const firstModel = classes.find(c => c.methods.length > 0);
if (firstModel) {
  const thisFileText = `<?php\nnamespace App\\Models;\nclass ${firstModel.className} {\n  public function test() {\n`;
  const thisLine  = '    $this->';
  const thisItems = completionLabels(thisLine, thisLine.length, thisFileText);
  console.log(`   ${firstModel.className} $this-> → [${thisItems.slice(0,6).join(', ')}${thisItems.length>6?'…':''}]`);
  check('$this-> returns items', thisItems.length > 0, true);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
