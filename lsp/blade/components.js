'use strict';

const fs   = require('fs');
const path = require('path');

// ── Naming helpers ────────────────────────────────────────────────────────────

/**
 * Convert PascalCase class name (or slash-separated path segment) to kebab tag.
 * e.g.  "AlertBox"   → "alert-box"
 *       "Forms/Input" → "forms.input"
 */
function pascalToKebab(str) {
  // Handle namespace separator → dot
  return str
    .split('/')
    .map(segment =>
      segment
        .replace(/([A-Z])/g, (_, c, i) => (i === 0 ? c.toLowerCase() : '-' + c.toLowerCase()))
    )
    .join('.');
}

/**
 * Convert camelCase to kebab-case.
 * e.g.  "alertType" → "alert-type"
 */
function camelToKebab(str) {
  return str.replace(/([A-Z])/g, (_, c) => '-' + c.toLowerCase());
}

// ── PHP balanced-paren scanner (mirrors discovery.js) ────────────────────────

function extractMethodParams(content, openParenIdx) {
  let depth = 0;
  const start = openParenIdx + 1;
  for (let i = openParenIdx; i < content.length; i++) {
    if      (content[i] === '(') depth++;
    else if (content[i] === ')') {
      depth--;
      if (depth === 0) return content.slice(start, i).trim();
    }
  }
  return content.slice(start).trim();
}

// ── Prop parsing ──────────────────────────────────────────────────────────────

const RESERVED_PROP_NAMES = new Set([
  'data', 'render', 'resolve', 'resolveView', 'shouldRender',
  'view', 'withAttributes', 'withName',
]);

// Types that look like uppercase class names but are actually scalars — allow them
const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Bool', 'Array', 'Object']);

/**
 * Parse constructor parameter string into prop descriptors.
 * Each param: `[visibility] [?type] $name [= default]`
 */
function parseConstructorParams(paramStr) {
  if (!paramStr) return [];
  const props = [];

  // Split on commas that are NOT inside nested parens
  const params = splitParams(paramStr);

  for (const raw of params) {
    const param = raw.trim();
    if (!param) continue;

    // Extract variable name
    const nameMatch = param.match(/\$(\w+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    if (RESERVED_PROP_NAMES.has(name)) continue;

    // Check for hasDefault (presence of `=` after the variable name)
    const afterName = param.slice(param.indexOf('$' + name) + name.length + 1);
    const hasDefault = /^\s*=/.test(afterName);

    // Extract type hint (before the `$name`)
    const beforeName = param.slice(0, param.indexOf('$' + name));
    // Strip visibility keywords
    const typeStr = beforeName
      .replace(/\b(public|protected|private|readonly)\b/g, '')
      .replace(/\?/, '')
      .trim();

    // Skip service-injected: type looks like a class (starts uppercase) and is NOT a scalar
    if (typeStr && /^[A-Z]/.test(typeStr) && !SCALAR_TYPES.has(typeStr)) continue;

    props.push({
      name,
      kebab:      camelToKebab(name),
      type:       typeStr || null,
      hasDefault,
    });
  }

  return props;
}

/**
 * Split a comma-separated parameter string respecting nested parentheses.
 */
function splitParams(str) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if      (ch === '(' || ch === '[') { depth++; current += ch; }
    else if (ch === ')' || ch === ']') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Parse `@props([...])` from Blade file content.
 * Returns array of { name, kebab, type: null, hasDefault }.
 *
 * Uses a bracket-depth-aware scan to handle nested arrays in defaults
 * and avoids mistaking string default values for prop names.
 */
function parseBladeProps(content) {
  // Find @props( then scan forward to find the matching closing )
  const startMatch = content.match(/@props\s*\(\s*\[/);
  if (!startMatch) return [];

  // Walk forward from the opening [ to find the matching ]
  const openIdx = startMatch.index + startMatch[0].length - 1; // index of [
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < content.length; i++) {
    if (content[i] === '[') depth++;
    else if (content[i] === ']') {
      depth--;
      if (depth === 0) { closeIdx = i; break; }
    }
  }
  if (closeIdx === -1) return [];

  const arrayStr = content.slice(openIdx + 1, closeIdx);
  const props = [];

  // State-machine parser: walk char by char, identify keys (left of =>) vs values
  let i = 0;
  const len = arrayStr.length;

  while (i < len) {
    // Skip whitespace and commas
    while (i < len && /[\s,]/.test(arrayStr[i])) i++;
    if (i >= len) break;

    // Expect a quoted string key
    const q = arrayStr[i];
    if (q !== "'" && q !== '"') { i++; continue; } // skip non-string tokens

    // Read quoted string
    i++; // skip opening quote
    let key = '';
    while (i < len && arrayStr[i] !== q) {
      if (arrayStr[i] === '\\') i++; // skip escape
      key += arrayStr[i++];
    }
    i++; // skip closing quote

    // Skip whitespace
    while (i < len && arrayStr[i] === ' ') i++;

    if (i < len && arrayStr[i] === '=' && arrayStr[i + 1] === '>') {
      // Associative entry: key => value — skip the value
      i += 2;
      while (i < len && arrayStr[i] === ' ') i++;
      // Skip the value token (could be string, array, number, expression)
      if (i < len && (arrayStr[i] === "'" || arrayStr[i] === '"')) {
        const vq = arrayStr[i++];
        while (i < len && arrayStr[i] !== vq) { if (arrayStr[i] === '\\') i++; i++; }
        i++; // closing quote
      } else if (i < len && arrayStr[i] === '[') {
        // Nested array — skip with depth counter
        let d = 0;
        while (i < len) {
          if (arrayStr[i] === '[') d++;
          else if (arrayStr[i] === ']') { d--; if (d === 0) { i++; break; } }
          i++;
        }
      } else {
        // Scalar (number, null, true, false, PHP expr) — skip to next comma or ]
        while (i < len && arrayStr[i] !== ',') i++;
      }
      props.push({ name: key, kebab: camelToKebab(key), type: null, hasDefault: true });
    } else {
      // Bare entry: 'key' without a default
      props.push({ name: key, kebab: camelToKebab(key), type: null, hasDefault: false });
    }
  }

  return props;
}

// ── Slot detection ────────────────────────────────────────────────────────────

const SLOT_METHOD_NAMES = new Set(['has', 'isEmpty', 'isNotEmpty', 'hasActualContent', 'attributes']);

/**
 * Detect default and named slots used in a Blade file.
 * - Default slot: `$slot` used as a variable (not a method chain like `$slot->...`)
 * - Named slots:  `$slots->name` where `name` is not a framework helper method
 *
 * Returns { hasSlot: bool, namedSlots: string[] }
 */
function parseSlots(content) {
  if (!content) return { hasSlot: false, namedSlots: [] };

  // $slot as a standalone variable — word-boundary, not followed by -> or [
  const hasSlot = /\$slot\b(?!\s*(?:->|\[))/.test(content);

  const namedSlots = [];
  const re = /\$slots->(\w+)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    if (!SLOT_METHOD_NAMES.has(name) && !namedSlots.includes(name)) {
      namedSlots.push(name);
    }
  }

  return { hasSlot, namedSlots };
}

// ── File discovery ────────────────────────────────────────────────────────────

/**
 * Recursively collect files under dir matching the given extension.
 */
function collectFiles(dir, ext, out) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) collectFiles(full, ext, out);
      else if (e.name.endsWith(ext)) out.push(full);
    }
  } catch (e) { process.stderr.write('[blade/components] scan error: ' + e.message + '\n'); }
}

/**
 * Derive a tag name from a class file path relative to the components dir.
 * e.g.  "/…/app/View/Components/AlertBox.php"          → "alert-box"
 *       "/…/app/View/Components/Forms/Input.php"        → "forms.input"
 *       "/…/app/View/Components/Card/Card.php"          → "card"  (index)
 */
function classFileToTag(filePath, componentsDir) {
  const rel     = filePath.slice(componentsDir.length).replace(/^[/\\]/, '');
  const noExt   = rel.replace(/\.php$/, '');
  const parts   = noExt.split(/[/\\]/);

  // Index detection: last segment equals parent dir name (case-insensitive)
  if (parts.length >= 2) {
    const last   = parts[parts.length - 1];
    const parent = parts[parts.length - 2];
    if (last.toLowerCase() === parent.toLowerCase()) {
      parts.pop();
    }
  }

  return parts.map(p => pascalToKebab(p)).join('.');
}

/**
 * Derive a tag name from a blade view file relative to the anonymous components dir.
 * e.g.  "/…/resources/views/components/alert.blade.php"         → "alert"
 *       "/…/resources/views/components/forms/input.blade.php"   → "forms.input"
 *       "/…/resources/views/components/accordion/accordion.blade.php" → "accordion"
 */
function viewFileToTag(filePath, componentsDir) {
  const rel   = filePath.slice(componentsDir.length).replace(/^[/\\]/, '');
  const noExt = rel.replace(/\.blade\.php$/, '');
  const parts = noExt.split(/[/\\]/);

  // Index detection: last part equals parent (case-insensitive)
  if (parts.length >= 2) {
    const last   = parts[parts.length - 1];
    const parent = parts[parts.length - 2];
    if (last.toLowerCase() === parent.toLowerCase()) {
      parts.pop();
    }
  }

  // Blade view dirs are already kebab — lowercase and join with dot
  return parts.map(p => p.toLowerCase()).join('.');
}

// ── Discovery ─────────────────────────────────────────────────────────────────

let componentCache     = null;
let componentCacheRoot = null;

function discoverComponents(root) {
  if (componentCache && componentCacheRoot === root) return componentCache;

  const classDir = path.join(root, 'app', 'View', 'Components');
  const viewDir  = path.join(root, 'resources', 'views', 'components');

  // ── Class-based components ──────────────────────────────────────────────────
  const phpFiles = [];
  collectFiles(classDir, '.php', phpFiles);

  const byTag = {};

  for (const filePath of phpFiles) {
    const tagName = classFileToTag(filePath, classDir);

    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { continue; }

    // Extract class name
    const classMatch = content.match(/\bclass\s+(\w+)/);
    const className  = classMatch ? classMatch[1] : path.basename(filePath, '.php');

    // Extract constructor props
    const ctorMatch = content.match(/\b__construct\s*\(/);
    let props = [];
    if (ctorMatch) {
      const openIdx = content.indexOf('(', ctorMatch.index + ctorMatch[0].length - 1);
      const paramStr = extractMethodParams(content, openIdx);
      props = parseConstructorParams(paramStr);
    }

    byTag[tagName] = {
      tagName,
      className,
      classFile: filePath,
      viewFile:  null,
      props,
      isAnonymous: false,
      hasSlot:    false,   // populated later when view file is found
      namedSlots: [],
    };
  }

  // ── Anonymous components (blade files) ────────────────────────────────────
  const bladeFiles = [];
  collectFiles(viewDir, '.blade.php', bladeFiles);

  for (const filePath of bladeFiles) {
    const tagName = viewFileToTag(filePath, viewDir);

    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { /* keep empty */ }

    if (byTag[tagName]) {
      // Class-based wins — attach view file and parse slots from it
      if (!byTag[tagName].viewFile) {
        byTag[tagName].viewFile = filePath;
        const { hasSlot, namedSlots } = parseSlots(content);
        byTag[tagName].hasSlot    = hasSlot;
        byTag[tagName].namedSlots = namedSlots;
      }
      continue;
    }

    const props = parseBladeProps(content);
    const { hasSlot, namedSlots } = parseSlots(content);

    byTag[tagName] = {
      tagName,
      className:   null,
      classFile:   null,
      viewFile:    filePath,
      props,
      isAnonymous: true,
      hasSlot,
      namedSlots,
    };
  }

  componentCache     = Object.values(byTag).sort((a, b) => a.tagName.localeCompare(b.tagName));
  componentCacheRoot = root;
  return componentCache;
}

function invalidateComponentCache() {
  componentCache     = null;
  componentCacheRoot = null;
}

/**
 * Given a tag name (e.g. "alert", "forms.input"), return { classFile, viewFile }.
 * Both may be null if not found.
 */
function componentTagToFiles(tagName, root) {
  const components = discoverComponents(root);
  const entry = components.find(c => c.tagName === tagName);
  if (!entry) return { classFile: null, viewFile: null };
  return { classFile: entry.classFile, viewFile: entry.viewFile };
}

module.exports = { discoverComponents, invalidateComponentCache, componentTagToFiles };
