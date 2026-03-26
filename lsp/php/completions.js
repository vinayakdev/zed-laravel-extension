'use strict';

const fs = require('fs');
const { discoverPhpClasses, getUseInsertLine, isAlreadyImported } = require('./discovery');
const { ELOQUENT_METHODS, CHAIN_METHODS }                          = require('./data');
const { resolveMembers }                                           = require('./resolver');
const { getVendorClass, searchVendorByPrefix }                     = require('./vendor');
const { inferVariableType, inferCurrentClass }                     = require('./inference');

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Build a snippet/insertion text for a method.
 * `nextChar` is the character immediately after the cursor — if it is already
 * `(`, we skip adding parens so we don't end up with double `()`.
 */
function buildSnippet(name, params, nextChar) {
  if (nextChar === '(') return name;       // parens already present
  if (!params)         return `${name}()`;
  return `${name}($1)`;
}

/**
 * For scope methods, strip the first `Builder $query` parameter — that's
 * injected by Laravel and invisible to the caller.
 * e.g. `Builder $query, string $type` → `string $type`
 */
function scopeCallParams(params) {
  if (!params) return '';
  const parts = params.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length > 0 && /\bBuilder\b/.test(parts[0])) parts.shift();
  return parts.join(', ');
}

/** Build opts object for resolveMembers */
function makeOpts(root, fileText, context, callerVisibility) {
  return {
    getAppClass:    (name) => discoverPhpClasses(root).find(c => c.className === name) || null,
    // altText is supplied by resolver.js when recursing into a vendor entry —
    // it passes that entry's own fileContent so FQN lookups use the right
    // use-statements instead of the original editing file.
    getVendorClass: (name, r, altText) => getVendorClass(name, altText !== undefined ? altText : fileText, r),
    root,
    context,
    callerVisibility,
  };
}

/**
 * Convert resolved methods+properties to LSP completion items.
 *
 * `labelPrefix`  — text prepended to the dropdown label   (e.g. '->')
 * `insertPrefix` — text prepended to the inserted newText (e.g. '->')
 *                  Pass null/'' when the range already covers the operator.
 * `nextChar`     — character immediately after cursor; if '(' skip parens.
 */
function membersToItems(methods, properties, typed, lineNum, rangeStart, rangeEnd,
                        labelPrefix, insertPrefix, nextChar) {
  const lc = typed.toLowerCase();
  const lp = labelPrefix  || '';
  const ip = insertPrefix || '';

  const methodItems = methods
    .filter(m => {
      const label = m.isScope ? m.scopeName : m.name;
      return !typed || label.toLowerCase().startsWith(lc);
    })
    .map((m, i) => {
      const label      = m.isScope ? m.scopeName  : m.name;
      const callParams = m.isScope ? scopeCallParams(m.params) : (m.params || '');
      const detail     = m.isScope
        ? `scope ${label}(${callParams})`
        : `${m.visibility}${m.isStatic ? ' static' : ''} ${m.name}(${m.params || ''})`;
      return {
        label:            lp + label,
        kind:             2, // Method
        detail,
        insertTextFormat: 2,
        sortText:         i.toString().padStart(4, '0'),
        textEdit: {
          range:   { start: { line: lineNum, character: rangeStart },
                     end:   { line: lineNum, character: rangeEnd } },
          newText: ip + buildSnippet(label, callParams, nextChar),
        },
      };
    });

  const propItems = properties
    .filter(p => !typed || p.name.toLowerCase().startsWith(lc))
    .map((p, i) => ({
      label:            lp + p.name,
      kind:             10, // Property
      detail:           `${p.visibility}${p.isStatic ? ' static' : ''} $${p.name}`,
      insertTextFormat: 1,
      sortText:         (i + 9999).toString().padStart(4, '0'),
      textEdit: {
        range:   { start: { line: lineNum, character: rangeStart },
                   end:   { line: lineNum, character: rangeEnd } },
        newText: ip + p.name,
      },
    }));

  return [...methodItems, ...propItems];
}

/** Item builder for simple named method lists (ELOQUENT_METHODS, CHAIN_METHODS) */
function methodItems(methods, typed, lineNum, rangeStart, rangeEnd, prefix, nextChar) {
  const filtered = typed
    ? methods.filter(m => m.name.toLowerCase().startsWith(typed.toLowerCase()))
    : methods;
  if (!filtered.length) return null;

  return filtered.map((m, i) => {
    // If next char is '(', strip the trailing '(...)' from the snippet
    const snippet = nextChar === '('
      ? (prefix || '') + m.name
      : (prefix || '') + m.snippet;
    return {
      label:            (prefix || '') + m.name,
      kind:             2,
      detail:           (prefix || '') + m.name,
      insertTextFormat: 2,
      sortText:         i.toString().padStart(4, '0'),
      textEdit: {
        range:   { start: { line: lineNum, character: rangeStart },
                   end:   { line: lineNum, character: rangeEnd } },
        newText: snippet,
      },
    };
  });
}

// ── $this-> completions ──────────────────────────────────────────────────────

function thisCompletions(lineText, character, lineNum, fileText, root) {
  const before = lineText.slice(0, character);
  const match  = before.match(/\$this->([a-zA-Z_]*)$/);
  if (!match) return null;

  const typed      = match[1];
  const arrowStart = character - 2 - typed.length;
  const nextChar   = lineText[character] || '';

  const className = inferCurrentClass(fileText, lineNum);
  if (!className) return null;

  const opts = makeOpts(root, fileText, 'instance', 'inside');
  const { methods, properties } = resolveMembers(className, opts);

  const items = membersToItems(methods, properties, typed, lineNum, arrowStart, character, '->', '->', nextChar);
  return items.length ? items : null;
}

// ── self:: completions ───────────────────────────────────────────────────────

function selfCompletions(lineText, character, lineNum, fileText, root) {
  const before = lineText.slice(0, character);
  const match  = before.match(/\bself::([a-zA-Z_]*)$/);
  if (!match) return null;

  const typed      = match[1];
  const colonStart = character - 2 - typed.length;
  const nextChar   = lineText[character] || '';

  const className = inferCurrentClass(fileText, lineNum);
  if (!className) return null;

  const opts = makeOpts(root, fileText, 'static', 'inside');
  const { methods, properties } = resolveMembers(className, opts);

  const items = membersToItems(methods, properties, typed, lineNum, colonStart, character, '::', '::', nextChar);
  return items.length ? items : null;
}

// ── parent:: completions ─────────────────────────────────────────────────────

function parentCompletions(lineText, character, lineNum, fileText, root) {
  const before = lineText.slice(0, character);
  const match  = before.match(/\bparent::([a-zA-Z_]*)$/);
  if (!match) return null;

  const typed      = match[1];
  const colonStart = character - 2 - typed.length;
  const nextChar   = lineText[character] || '';

  const currentClass = inferCurrentClass(fileText, lineNum);
  if (!currentClass) return null;

  const appClass = discoverPhpClasses(root).find(c => c.className === currentClass);
  if (!appClass || !appClass.extends) return null;

  const opts = makeOpts(root, fileText, 'instance', 'inside');
  const { methods, properties } = resolveMembers(appClass.extends, opts);

  const items = membersToItems(methods, properties, typed, lineNum, colonStart, character, '::', '::', nextChar);
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
  const nextChar   = lineText[character] || '';

  const className = inferVariableType(varName, fileText, lineNum);
  if (!className) return null;

  const opts = makeOpts(root, fileText, 'instance', 'outside');
  const { methods, properties } = resolveMembers(className, opts);

  const items = membersToItems(methods, properties, typed, lineNum, arrowStart, character, '->', '->', nextChar);
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
  const nextChar    = lineText[character] || '';

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

    // Range starts AFTER '::' so no '::' prefix in newText.
    // Label prefix 'ClassName::method' shown for context; insertPrefix empty.
    const items = membersToItems(methods, properties, typedMethod, lineNum, methodStart, character,
                                 '', '', nextChar);
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

  return methodItems(methods, typedMethod, lineNum, methodStart, character, null, nextChar);
}

// ── -> chain completions (generic, unknown type) ──────────────────────────────

/**
 * Returns all public instance methods of `className` as CHAIN_METHODS-shaped
 * objects `{ name, snippet }`.  Checks both app classes and vendor (so
 * Filament's TextInput, FileUpload etc. are included once the prefetcher has
 * warmed the cache).  Scope methods are converted to their caller-facing name.
 */
function classInstanceMembersAsChain(className, fileText, root) {
  if (!root) return [];
  const entry = discoverPhpClasses(root).find(c => c.className === className)
             || getVendorClass(className, fileText, root);
  if (!entry) return [];

  const opts = makeOpts(root, fileText, 'instance', 'outside');
  const { methods } = resolveMembers(className, opts);

  return methods.map(m => {
    const label      = m.isScope ? m.scopeName : m.name;
    const callParams = m.isScope ? scopeCallParams(m.params) : (m.params || '');
    return {
      name:    label,
      snippet: callParams ? `${label}($1)` : `${label}()`,
    };
  });
}

function chainCompletions(lineText, character, lineNum, fileText, root) {
  const before   = lineText.slice(0, character);
  const nextChar = lineText[character] || '';

  // Detect if we're chaining off a known class (e.g. User::popular()->  or
  // TextInput::make()->  ) so we can surface that class's instance methods.
  const chainClassMatch = before.match(/\b([A-Z][a-zA-Z0-9_]*)::/);
  const classExtras     = chainClassMatch
    ? classInstanceMembersAsChain(chainClassMatch[1], fileText, root)
    : [];

  // Class-specific methods first, then generic builder methods (deduped)
  const seenNames  = new Set(classExtras.map(m => m.name));
  const chainPool  = [...classExtras, ...CHAIN_METHODS.filter(m => !seenNames.has(m.name))];

  // Case A: lone '-' after an expression end
  if (/[)\w\]]-$/.test(before))
    return methodItems(chainPool, '', lineNum, character - 1, character, '->', nextChar);

  // Case B: '->' with optional partial method
  const arrowMatch = before.match(/->([a-zA-Z_]*)$/);
  if (!arrowMatch) return null;

  const typed      = arrowMatch[1];
  const arrowStart = character - 2 - typed.length;
  return methodItems(chainPool, typed, lineNum, arrowStart, character, '->', nextChar);
}

// ── Class name + auto-import completions ─────────────────────────────────────

/** Build one LSP completion item for a class/trait/interface */
function buildImportItem(entry, i, { lineNum, wordStart, character, insertAt,
                                     isNew, isTypeHint, nextChar, fileText }) {
  const { className, fqn, kind } = entry;

  // Insertion text depends on context and kind:
  //   new Foo     → Foo($1)  (or Foo if '(' already follows)
  //   type hint   → Foo
  //   trait       → Foo      (used with `use Foo;` inside a class, not Foo::)
  //   class/enum  → Foo::    (triggers static completions immediately)
  let newText;
  let insertTextFormat;
  if (isNew) {
    newText          = nextChar === '(' ? className : `${className}($1)`;
    insertTextFormat = nextChar === '(' ? 1 : 2;
  } else if (isTypeHint || kind === 'trait' || kind === 'interface') {
    newText          = className;
    insertTextFormat = 1;
  } else {
    newText          = `${className}::`;
    insertTextFormat = 1;
  }

  const imported = isAlreadyImported(fileText, fqn);
  const item = {
    label:            className,
    kind:             kind === 'trait' ? 8 : 7, // 8=Interface used for traits too (closest LSP kind)
    detail:           fqn,
    insertTextFormat,
    sortText:         i.toString().padStart(4, '0'),
    textEdit: {
      range:   { start: { line: lineNum, character: wordStart },
                 end:   { line: lineNum, character } },
      newText,
    },
  };
  if (!imported) {
    item.additionalTextEdits = [{
      range:   { start: { line: insertAt, character: 0 },
                 end:   { line: insertAt, character: 0 } },
      newText: `use ${fqn};\n`,
    }];
    item.detail = `${fqn}  (auto-import)`;
  }
  return item;
}

function classImportCompletions(lineText, character, lineNum, fileText, root) {
  const before = lineText.slice(0, character);
  if (/::/.test(before.match(/[A-Z][a-zA-Z0-9_]*[^]*$/)?.[0] || '')) return null;

  const wordMatch = before.match(/\b([A-Z][a-zA-Z0-9_]*)$/);
  if (!wordMatch) return null;

  const typed     = wordMatch[1];
  const wordStart = character - typed.length;
  const insertAt  = getUseInsertLine(fileText);
  const nextChar  = lineText[character] || '';
  const isNew      = /\bnew\s+$/.test(before.slice(0, wordStart));
  const isTypeHint = /^\s*\$/.test(lineText.slice(character));
  const ctx        = { lineNum, wordStart, character, insertAt, isNew, isTypeHint, nextChar, fileText };

  // App classes (app/ directory)
  const appClasses = discoverPhpClasses(root)
    .filter(c => c.className.toLowerCase().startsWith(typed.toLowerCase()));
  const appNames = new Set(appClasses.map(c => c.className));

  // Vendor classes (from Composer classmap short-name index — no file reads)
  const vendorMatches = searchVendorByPrefix(typed, root)
    .filter(v => !appNames.has(v.className)); // app classes take priority

  const allEntries = [
    ...appClasses.map(c => ({ className: c.className, fqn: c.fqn, kind: 'class' })),
    ...vendorMatches,
  ];

  // Sort by relevance: exact match first, then shorter names, then alphabetical
  const lc = typed.toLowerCase();
  allEntries.sort((a, b) => {
    const aExact = a.className.toLowerCase() === lc ? 0 : 1;
    const bExact = b.className.toLowerCase() === lc ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    if (a.className.length !== b.className.length) return a.className.length - b.className.length;
    return a.className.localeCompare(b.className);
  });

  const items = allEntries.map((entry, i) => buildImportItem(entry, i, ctx));
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
  const chain = chainCompletions(lineText, character, lineNum, fileText, root);
  if (chain)    return { isIncomplete: true, items: chain };

  // ClassName — class import completions
  const classes = classImportCompletions(lineText, character, lineNum, fileText, root);
  return          { isIncomplete: false, items: classes || [] };
}

module.exports = { phpCompletions };
