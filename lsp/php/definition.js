'use strict';

const { discoverPhpClasses } = require('./discovery');

function phpDefinition(text, line, character, root, pathToUri) {
  const lineText = text.split('\n')[line] || '';

  // Expand cursor position to the full word
  let s = character, e = character;
  while (s > 0 && /\w/.test(lineText[s - 1])) s--;
  while (e < lineText.length && /\w/.test(lineText[e])) e++;
  const word = lineText.slice(s, e);

  // Only resolve words that start with an uppercase letter (class names)
  if (!/^[A-Z]/.test(word)) return null;

  const found = discoverPhpClasses(root).find(c => c.className === word);
  if (!found) return null;

  return {
    uri:   pathToUri(found.file),
    range: { start: { line: found.line, character: 0 },
             end:   { line: found.line, character: 0 } },
  };
}

module.exports = { phpDefinition };
