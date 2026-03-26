'use strict';

const { BLADE_SNIPPETS }    = require('./data');
const { getViewNameFromUri, findViewVariables } = require('./views');
const { discoverComponents } = require('./components');

// ── x-component tag completions ──────────────────────────────────────────────

/**
 * Triggered when the user types `<x-` (or continues typing after it).
 * Returns completion items for every discovered component whose tag starts with
 * the already-typed prefix.
 */
function componentTagCompletions(lineText, character, lineNum, root) {
  if (!root) return null;
  const before = lineText.slice(0, character);
  const tagMatch = before.match(/<x-([\w.-]*)$/);
  if (!tagMatch) return null;

  const typed  = tagMatch[1].toLowerCase();
  // Replace range: from the `x` in `<x-` up to the end of the already-typed word
  const xStart = character - tagMatch[0].length + 1; // position of 'x'
  // Extend to end of currently-typed partial tag name (after cursor)
  let wordEnd = character;
  while (wordEnd < lineText.length && /[\w.-]/.test(lineText[wordEnd])) wordEnd++;

  let components;
  try { components = discoverComponents(root); } catch (_) { return null; }

  // Match on full prefix OR any dot-segment prefix: <x-app matches layouts.app
  function tagMatches(tagName) {
    if (typed === '') return true;
    if (tagName.startsWith(typed)) return true;
    return tagName.split('.').some(seg => seg.startsWith(typed));
  }

  // Rank: exact prefix beats segment match, so sort prefix matches first
  function sortKey(tagName, idx) {
    const rank = tagName.startsWith(typed) ? '0' : '1';
    // \x00 prefix ensures all our items sort above Emmet completions
    return '\x00' + rank + tagName;
  }

  const items = components
    .filter(c => tagMatches(c.tagName))
    .map((c, i) => {
      const label  = `x-${c.tagName}`;
      const detail = c.isAnonymous
        ? `(anonymous)${c.props.length ? ' — ' + c.props.map(p => p.kebab).join(', ') : ''}`
        : `${c.className}${c.props.length ? ' — ' + c.props.map(p => p.kebab).join(', ') : ''}`;

      return {
        label,
        kind:             10, // Property
        detail,
        insertTextFormat: 2,  // Snippet
        sortText:         sortKey(c.tagName, i),
        textEdit: {
          range: {
            start: { line: lineNum, character: xStart },
            end:   { line: lineNum, character: wordEnd },
          },
          newText: `x-${c.tagName}$1 />`,
        },
      };
    });

  return items.length ? items : null;
}

// ── x-component prop completions ─────────────────────────────────────────────

/**
 * Triggered when the user is inside an `<x-tag …` attribute position.
 * Returns completions for the component's props (both static and bound variants).
 */
function componentPropCompletions(lineText, character, lineNum, root) {
  if (!root) return null;
  const before = lineText.slice(0, character);
  // Detect we are inside an x-component tag (after the tag name, inside attributes area)
  const tagMatch = before.match(/<x-([\w.-]+)\s+(?:[^>]*)$/);
  if (!tagMatch) return null;

  const tagName = tagMatch[1];

  let components;
  try { components = discoverComponents(root); } catch (_) { return null; }

  const entry = components.find(c => c.tagName === tagName);
  if (!entry || !entry.props.length) return null;

  // Sort: required (no default) first, then optional
  const sorted = [...entry.props].sort((a, b) => {
    if (a.hasDefault === b.hasDefault) return 0;
    return a.hasDefault ? 1 : -1;
  });

  const items = [];
  sorted.forEach((prop, i) => {
    const sortBase = i.toString().padStart(4, '0');

    // Static string binding: propname="$1"
    items.push({
      label:            `${prop.kebab}=""`,
      kind:             10,
      detail:           prop.hasDefault ? `optional` : `required`,
      insertTextFormat: 2,
      sortText:         sortBase + 'a',
      textEdit: {
        range: {
          start: { line: lineNum, character },
          end:   { line: lineNum, character },
        },
        newText: `${prop.kebab}="$1"`,
      },
    });

    // PHP expression binding: :propname="$1"
    items.push({
      label:            `:${prop.kebab}=""`,
      kind:             10,
      detail:           `(PHP) ${prop.hasDefault ? 'optional' : 'required'}`,
      insertTextFormat: 2,
      sortText:         sortBase + 'b',
      textEdit: {
        range: {
          start: { line: lineNum, character },
          end:   { line: lineNum, character },
        },
        newText: `:${prop.kebab}="$1"`,
      },
    });
  });

  return items.length ? items : null;
}

// ── @directive completions ───────────────────────────────────────────────────

function directiveCompletions(lineText, character, lineNum) {
  const before  = lineText.slice(0, character);
  const atMatch = before.match(/@([a-zA-Z-]*)$/);
  if (!atMatch) return null;

  const typed       = atMatch[1].toLowerCase();
  const atCharacter = character - atMatch[0].length;

  const items = BLADE_SNIPPETS
    .filter(s => typed === '' || s.label.toLowerCase().startsWith(typed))
    .map((s, i) => ({
      label:            `@${s.label}`,
      kind:             15, // Snippet
      detail:           s.detail,
      insertTextFormat: 2,
      filterText:       `@${s.label}`,
      sortText:         i.toString().padStart(4, '0'),
      textEdit: {
        range:   { start: { line: lineNum, character: atCharacter },
                   end:   { line: lineNum, character } },
        newText: `@${s.insertText}`,
      },
    }));

  return items.length ? items : null;
}

// ── $variable completions (inferred from view() calls) ───────────────────────

function variableCompletions(lineText, character, lineNum, uri, root) {
  if (!root) return null;
  const before   = lineText.slice(0, character);
  const varMatch = before.match(/\$([a-zA-Z_]*)$/);
  if (!varMatch) return null;

  const viewName = getViewNameFromUri(uri, root);
  if (!viewName) return null;

  const viewVars = findViewVariables(viewName, root);
  if (!viewVars.length) return null;

  const typed      = varMatch[1].toLowerCase();
  const dollarStart = character - varMatch[0].length;

  const items = viewVars
    .filter(v => typed === '' || v.toLowerCase().startsWith(typed))
    .map((v, i) => ({
      label:    `$${v}`,
      kind:     6, // Variable
      detail:   'View variable',
      sortText: i.toString().padStart(4, '0'),
      textEdit: {
        range:   { start: { line: lineNum, character: dollarStart },
                   end:   { line: lineNum, character } },
        newText: `$${v}`,
      },
    }));

  return items.length ? items : null;
}

// ── Public entry point ───────────────────────────────────────────────────────

function bladeCompletions(lineText, character, lineNum, uri, root) {
  const tagItems = componentTagCompletions(lineText, character, lineNum, root);
  if (tagItems) return { isIncomplete: true, items: tagItems };

  const propItems = componentPropCompletions(lineText, character, lineNum, root);
  if (propItems) return { isIncomplete: true, items: propItems };

  const directives = directiveCompletions(lineText, character, lineNum);
  if (directives) return { isIncomplete: true,  items: directives };

  const vars = variableCompletions(lineText, character, lineNum, uri, root);
  return        { isIncomplete: false, items: vars || [] };
}

module.exports = { bladeCompletions };
