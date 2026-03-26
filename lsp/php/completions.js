'use strict';

const fs = require('fs');
const { discoverPhpClasses, getUseInsertLine, isAlreadyImported } = require('./discovery');
const { ELOQUENT_METHODS, CHAIN_METHODS }                          = require('./data');
const { resolveMembers }                                           = require('./resolver');
const { getVendorClass }                                           = require('./vendor');
const { inferVariableType, inferCurrentClass }                     = require('./inference');

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Build a snippet from raw params string */
function buildSnippet(name, params) {
  if (!params) return `${name}()`;
  return `${name}($1)`;
}

/** Build opts object for resolveMembers */
function makeOpts(root, fileText, context, callerVisibility) {
  return {
    getAppClass:      (name) => discoverPhpClasses(root).find(c => c.className === name) || null,
    getVendorClass:   (name, r) => getVendorClass(name, fileText, r),
    root,
    context,
    callerVisibility,
  };
}

/** Convert resolved methods+properties to LSP completion items */
function membersToItems(methods, properties, typed, lineNum, rangeStart, rangeEnd, prefix) {
  const lc = typed.toLowerCase();

  const methodItems = methods
    .filter(m => !typed || m.name.toLowerCase().startsWith(lc))
    .map((m, i) => ({
      label:            (prefix || '') + m.name,
      kind:             2, // Method
      detail:           `${m.visibility}${m.isStatic ? ' static' : ''} ${m.name}(${m.params || ''})`,
      insertTextFormat: 2,
      sortText:         i.toString().padStart(4, '0'),
      textEdit: {
        range:   { start: { line: lineNum, character: rangeStart },
                   end:   { line: lineNum, character: rangeEnd } },
        newText: (prefix || '') + buildSnippet(m.name, m.params),
      },
    }));

  const propItems = properties
    .filter(p => !typed || p.name.toLowerCase().startsWith(lc))
    .map((p, i) => ({
      label:            (prefix || '') + p.name,
      kind:             10, // Property
      detail:           `${p.visibility}${p.isStatic ? ' static' : ''} $${p.name}`,
      insertTextFormat: 1,
      sortText:         (i + 9999).toString().padStart(4, '0'),
      textEdit: {
        range:   { start: { line: lineNum, character: rangeStart },
                   end:   { line: lineNum, character: rangeEnd } },
        newText: (prefix || '') + p.name,
      },
    }));

  return [...methodItems, ...propItems];
}

/** Item builder for simple named method lists (ELOQUENT_METHODS, CHAIN_METHODS) */
function methodItems(methods, typed, lineNum, rangeStart, rangeEnd, prefix) {
  const filtered = typed
    ? methods.filter(m => m.name.toLowerCase().startsWith(typed.toLowerCase()))
    : methods;
  if (!filtered.length) return null;

  return filtered.map((m, i) => ({
    label:            (prefix || '') + m.name,
    kind:             2,
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

// ── $this-> completions ──────────────────────────────────────────────────────

function thisCompletions(lineText, character, lineNum, fileText, root) {
  const before = lineText.slice(0, character);
  const match  = before.match(/\$this->([a-zA-Z_]*)$/);
  if (!match) return null;

  const typed      = match[1];
  const arrowStart = character - 2 - typed.length;

  const className = inferCurrentClass(fileText, lineNum);
  if (!className) return null;

  const opts = makeOpts(root, fileText, 'instance', 'inside');
  const { methods, properties } = resolveMembers(className, opts);

  const items = membersToItems(methods, properties, typed, lineNum, arrowStart, character, '->');
  return items.length ? items : null;
}

// ── self:: completions ───────────────────────────────────────────────────────

function selfCompletions(lineText, character, lineNum, fileText, root) {
  const before = lineText.slice(0, character);
  const match  = before.match(/\bself::([a-zA-Z_]*)$/);
  if (!match) return null;

  const typed      = match[1];
  const colonStart = character - 2 - typed.length;

  const className = inferCurrentClass(fileText, lineNum);
  if (!className) return null;

  const opts = makeOpts(root, fileText, 'static', 'inside');
  const { methods, properties } = resolveMembers(className, opts);

  const items = membersToItems(methods, properties, typed, lineNum, colonStart, character, '::');
  return items.length ? items : null;
}

// ── parent:: completions ─────────────────────────────────────────────────────

function parentCompletions(lineText, character, lineNum, fileText, root) {
  const before = lineText.slice(0, character);
  const match  = before.match(/\bparent::([a-zA-Z_]*)$/);
  if (!match) return null;

  const typed      = match[1];
  const colonStart = character - 2 - typed.length;

  const currentClass = inferCurrentClass(fileText, lineNum);
  if (!currentClass) return null;

  const appClass = discoverPhpClasses(root).find(c => c.className === currentClass);
  if (!appClass || !appClass.extends) return null;

  const opts = makeOpts(root, fileText, 'instance', 'inside');
  const { methods, properties } = resolveMembers(appClass.extends, opts);

  const items = membersToItems(methods, properties, typed, lineNum, colonStart, character, '::');
  return items.length ? items : null;
}

// ── $var-> completions ────────────────────────────────────────────────────────

function varChainCompletions(lineText, character, lineNum, fileText, root) {
  const before = lineText.slice(0, character);
  // Exclude $this-> (handled above)
  const match  = before.match(/\$(?!this\b)([a-zA-Z_]\w*)->([a-zA-Z_]*)$/);
  if (!match) return null;

  const varName    = match[1];
  const typed      = match[2];
  const arrowStart = character - 2 - typed.length;

  const className = inferVariableType(varName, fileText, lineNum);
  if (!className) return null;

  const opts = makeOpts(root, fileText, 'instance', 'outside');
  const { methods, properties } = resolveMembers(className, opts);

  const items = membersToItems(methods, properties, typed, lineNum, arrowStart, character, '->');
  return items.length ? items : null;
}

// ── ClassName:: static completions ──────────────────────────────────────────

function staticCompletions(lineText, character, lineNum, fileText, root) {
  const before = lineText.slice(0, character);
  // Exclude self:: / parent:: — handled above
  const match  = before.match(/\b(?!self\b)(?!parent\b)([A-Z][a-zA-Z0-9_]*)::[a-zA-Z_]*$/);
  if (!match) return null;

  const className   = match[1];
  const typedMethod = before.slice(before.lastIndexOf('::') + 2);
  const methodStart = character - typedMethod.length;

  const entry = discoverPhpClasses(root).find(c => c.className === className)
             || getVendorClass(className, fileText, root);

  if (entry) {
    const opts = makeOpts(root, fileText, 'static', 'outside');
    let { methods, properties } = resolveMembers(className, opts);

    // Augment with Eloquent methods if the class extends a Model base
    if (entry.extends && /^(Model|Authenticatable|Pivot|MorphPivot)$/.test(entry.extends)) {
      const eloquentMethods = ELOQUENT_METHODS.map(m => ({
        name: m.name, params: '', isStatic: true, visibility: 'public',
      }));
      const seen = new Set(methods.map(m => m.name));
      methods = [...methods, ...eloquentMethods.filter(m => !seen.has(m.name))];
    }

    const items = membersToItems(methods, properties, typedMethod, lineNum, methodStart, character, '::');
    if (items.length) return items;
  }

  // Fallback: scan file for static functions + Eloquent check (handles legacy cache miss)
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

// ── -> chain completions (generic, unknown type) ──────────────────────────────

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
        kind:             7,
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
  // $this-> — instance members of current class (inside visibility)
  const thisItems = thisCompletions(lineText, character, lineNum, fileText, root);
  if (thisItems)    return { isIncomplete: true, items: thisItems };

  // self:: — static members of current class (inside visibility)
  const selfItems = selfCompletions(lineText, character, lineNum, fileText, root);
  if (selfItems)    return { isIncomplete: true, items: selfItems };

  // parent:: — members of parent class (inside visibility)
  const parentItems = parentCompletions(lineText, character, lineNum, fileText, root);
  if (parentItems)  return { isIncomplete: true, items: parentItems };

  // $var-> — inferred type member completions (outside visibility)
  const varItems = varChainCompletions(lineText, character, lineNum, fileText, root);
  if (varItems)     return { isIncomplete: true, items: varItems };

  // ClassName:: — static completions (app + vendor + Eloquent)
  const statics = staticCompletions(lineText, character, lineNum, fileText, root);
  if (statics)   return { isIncomplete: true, items: statics };

  // -> — generic chain completions when type is unknown
  const chain = chainCompletions(lineText, character, lineNum);
  if (chain)    return { isIncomplete: true, items: chain };

  // ClassName — class import completions
  const classes = classImportCompletions(lineText, character, lineNum, fileText, root);
  return          { isIncomplete: false, items: classes || [] };
}

module.exports = { phpCompletions };
