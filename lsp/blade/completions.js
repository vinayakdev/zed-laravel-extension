'use strict';

const { BLADE_SNIPPETS }    = require('./data');
const { getViewNameFromUri, findViewVariables } = require('./views');

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
  const directives = directiveCompletions(lineText, character, lineNum);
  if (directives) return { isIncomplete: true,  items: directives };

  const vars = variableCompletions(lineText, character, lineNum, uri, root);
  return        { isIncomplete: false, items: vars || [] };
}

module.exports = { bladeCompletions };
