'use strict';
// Parses config/*.php files into a flat dot-notation map using php-parser (AST).
// Each entry records the key, the env() variable name + default if applicable,
// or the literal value — so completions can show real values in their detail line.

const fs   = require('fs');
const path = require('path');

// php-parser is bundled into lsp/vendor/php-parser.js by build.rs / npm run build.
let PhpParser = null;
try { PhpParser = require('../vendor/php-parser.js'); } catch (_) {}

// ── Cache ────────────────────────────────────────────────────────────────────

let cache = null; // { root: string, entries: ConfigEntry[] }

function invalidateConfigCache() { cache = null; }

// ── AST helpers ──────────────────────────────────────────────────────────────

function makeParser() {
    if (!PhpParser) return null;
    return new PhpParser({ parser: { extractDoc: false, suppressErrors: true },
                           ast:    { withPositions: false } });
}

/**
 * Extract a display-friendly scalar string from an AST value node.
 * Returns null for non-scalar nodes.
 */
function scalarToString(node) {
    if (!node) return null;
    switch (node.kind) {
        case 'string':      return `"${node.value}"`;
        case 'number':      return String(node.value);
        case 'boolean':     return node.value ? 'true' : 'false';
        case 'nullkeyword': return 'null';
        case 'cast':        return scalarToString(node.expr);
        case 'unary':       // e.g. !false
            if (node.type === '!' && node.what?.kind === 'boolean')
                return node.what.value ? 'false' : 'true';
            return null;
        default:            return null;
    }
}

/**
 * If node is env('KEY') or env('KEY', default), return { envKey, default }.
 * Otherwise return null.
 */
function extractEnvCall(node) {
    if (!node || node.kind !== 'call') return null;
    // env() is a plain name call, not a method call
    const callee = node.what;
    if (!callee) return null;
    const name = callee.name ?? callee.offset?.name;
    if (name !== 'env') return null;

    const args     = node.arguments || [];
    const envKey   = args[0]?.kind === 'string' ? args[0].value : null;
    const defValue = args[1] ? scalarToString(args[1]) : null;
    return { envKey, default: defValue };
}

/**
 * Recursively walk a PHP array AST node and append flat ConfigEntry objects.
 * @param {object}         node    - array AST node
 * @param {string}         prefix  - dot-notation prefix built so far
 * @param {ConfigEntry[]}  entries - accumulator
 */
function flattenArray(node, prefix, entries) {
    if (!node || node.kind !== 'array') return;

    for (const item of (node.items || [])) {
        if (!item || item.kind !== 'entry') continue;
        // Config arrays always have string keys; skip numeric entries
        if (!item.key || item.key.kind !== 'string') continue;

        const key     = item.key.value;
        const fullKey = prefix ? `${prefix}.${key}` : key;
        const val     = item.value;

        if (val?.kind === 'array') {
            flattenArray(val, fullKey, entries);
            continue;
        }

        const envInfo = extractEnvCall(val);
        if (envInfo) {
            entries.push({ key: fullKey, envKey: envInfo.envKey, default: envInfo.default, literal: null });
        } else {
            entries.push({ key: fullKey, envKey: null, default: null, literal: scalarToString(val) });
        }
    }
}

/**
 * Parse one config file and return its entries prefixed with configName.
 */
function parseOneConfigFile(parser, filePath, configName) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { return []; }

    let ast;
    try { ast = parser.parseCode(content, filePath); } catch (_) { return []; }

    const entries = [];

    // Config files are: <?php return [...];
    // The top-level program children contain the return statement directly.
    for (const node of (ast.children || [])) {
        // Might be wrapped in a namespace node; unwrap one level
        const stmt = node.kind === 'namespace' ? (node.children || [])[0] : node;
        if (!stmt || stmt.kind !== 'return') continue;
        if (stmt.expr?.kind !== 'array') continue;
        flattenArray(stmt.expr, configName, entries);
        break;
    }

    return entries;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * @typedef {{ key: string, envKey: string|null, default: string|null, literal: string|null }} ConfigEntry
 */

/**
 * Return all config entries for the project at rootPath.
 * Results are cached until invalidateConfigCache() is called.
 *
 * @param {string} rootPath
 * @returns {ConfigEntry[]}
 */
function getConfigEntries(rootPath) {
    if (cache && cache.root === rootPath) return cache.entries;

    const parser = makeParser();
    if (!parser) return [];

    const configDir = path.join(rootPath, 'config');
    let files;
    try {
        files = fs.readdirSync(configDir).filter(f => f.endsWith('.php'));
    } catch (_) {
        return [];
    }

    const entries = [];
    for (const file of files) {
        const name     = path.basename(file, '.php'); // e.g. "app", "database"
        const filePath = path.join(configDir, file);
        entries.push(...parseOneConfigFile(parser, filePath, name));
    }

    cache = { root: rootPath, entries };
    return entries;
}

module.exports = { getConfigEntries, invalidateConfigCache };
