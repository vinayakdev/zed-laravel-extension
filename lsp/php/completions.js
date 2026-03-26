'use strict';

const fs = require('fs');
const { discoverPhpClasses, getUseInsertLine, isAlreadyImported } = require('./discovery');
const { ELOQUENT_METHODS, CHAIN_METHODS } = require('./data');

// ── Shared item builder ──────────────────────────────────────────────────────

function methodItems(methods, typed, lineNum, rangeStart, rangeEnd, prefix) {
  const filtered = typed
    ? methods.filter(m => m.name.toLowerCase().startsWith(typed.toLowerCase()))
    : methods;
  if (!filtered.length) return null;

  return filtered.map((m, i) => ({
    label:            (prefix || '') + m.name,
    kind:             2, // Method
    detail:           (prefix || '') + m.name,
    insertTextFormat: 2,
    sortText:         i.toString().padStart(4, '0'),
    textEdit: {
      range:   { start: { line: lineNum, character: rangeStart },
                 end:   { line: lineNum, character: rangeEnd } },
      newText: (prefix || '') + m.snippet,
    },
  }));
}

// ── ClassName:: static completions ──────────────────────────────────────────

function staticCompletions(lineText, character, lineNum, root) {
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
      if (!methods.find(e => e.name === m[1]))
        methods.push({ name: m[1], snippet: m[2].trim() ? `${m[1]}(\${1:})` : `${m[1]}()` });
    }
  }

  return methodItems(methods, typedMethod, lineNum, methodStart, character, null);
}

// ── -> chain completions ─────────────────────────────────────────────────────

function chainCompletions(lineText, character, lineNum) {
  const before = lineText.slice(0, character);

  // Case A: lone '-' after an expression end
  if (/[)\w\]]-$/.test(before))
    return methodItems(CHAIN_METHODS, '', lineNum, character - 1, character, '->');

  // Case B: '->' with optional partial method
  const arrowMatch = before.match(/->([a-zA-Z_]*)$/);
  if (!arrowMatch) return null;

  const typed      = arrowMatch[1];
  const arrowStart = character - 2 - typed.length;
  return methodItems(CHAIN_METHODS, typed, lineNum, arrowStart, character, '->');
}

// ── Class name + auto-import completions ─────────────────────────────────────

function classImportCompletions(lineText, character, lineNum, fileText, root) {
  const before = lineText.slice(0, character);
  if (/::/.test(before.match(/[A-Z][a-zA-Z0-9_]*[^]*$/)?.[0] || '')) return null;

  const wordMatch = before.match(/\b([A-Z][a-zA-Z0-9_]*)$/);
  if (!wordMatch) return null;

  const typed     = wordMatch[1];
  const wordStart = character - typed.length;
  const isNew     = /\bnew\s+$/.test(before.slice(0, wordStart));
  const insertAt  = getUseInsertLine(fileText);

  const items = discoverPhpClasses(root)
    .filter(c => c.className.toLowerCase().startsWith(typed.toLowerCase()))
    .map((c, i) => {
      const imported = isAlreadyImported(fileText, c.fqn);
      const item = {
        label:            c.className,
        kind:             7, // Class
        detail:           c.fqn,
        insertTextFormat: isNew ? 2 : 1,
        sortText:         i.toString().padStart(4, '0'),
        textEdit: {
          range:   { start: { line: lineNum, character: wordStart },
                     end:   { line: lineNum, character } },
          newText: isNew ? `${c.className}($1)` : c.className,
        },
      };
      if (!imported) {
        item.additionalTextEdits = [{
          range:   { start: { line: insertAt, character: 0 },
                     end:   { line: insertAt, character: 0 } },
          newText: `use ${c.fqn};\n`,
        }];
        item.detail = `${c.fqn}  (auto-import)`;
      }
      return item;
    });

  return items.length ? items : null;
}

// ── Public entry point ───────────────────────────────────────────────────────

function phpCompletions(lineText, character, lineNum, fileText, root) {
  const chain = chainCompletions(lineText, character, lineNum);
  if (chain)   return { isIncomplete: true,  items: chain };

  const statics = staticCompletions(lineText, character, lineNum, root);
  if (statics)  return { isIncomplete: true,  items: statics };

  const classes = classImportCompletions(lineText, character, lineNum, fileText, root);
  return          { isIncomplete: false, items: classes || [] };
}

module.exports = { phpCompletions };
