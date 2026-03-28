'use strict';
// Fetches Eloquent model metadata via `php artisan model:show ClassName --json`.
// Results are cached per (root, className) for CACHE_TTL_MS milliseconds.

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const CACHE_TTL_MS = 30_000;

// Map<string, { data: ModelData|null, ts: number }>
// Key = root + ':' + className
const modelCache = new Map();

function artisanExists(rootPath) {
    return fs.existsSync(path.join(rootPath, 'artisan'));
}

/**
 * Normalise `php artisan model:show --json` output into a stable shape.
 * Raw shape (Laravel 9.21+):
 *   { attributes: [{name, type, cast, fillable, ...}], relations: [{name, type, related, ...}] }
 */
function normalise(raw) {
    const attributes = (raw.attributes || []).map(a => ({
        name:     String(a.name     || ''),
        type:     String(a.type     || ''),
        cast:     a.cast ? String(a.cast) : '',
        fillable: Boolean(a.fillable),
    }));

    const relations = (raw.relations || []).map(r => ({
        name:    String(r.name    || ''),
        type:    String(r.type    || ''),
        related: String(r.related || ''),
    }));

    return { attributes, relations };
}

/**
 * Return metadata for a single model class, running artisan if not cached.
 * Returns null if artisan is unavailable or the model cannot be resolved.
 *
 * @param {string} className  Short or fully-qualified class name (e.g. "User" or "App\\Models\\User")
 * @param {string} root       Absolute path to the Laravel project root
 * @returns {{ attributes: Array, relations: Array } | null}
 */
function getModelData(className, root) {
    if (!artisanExists(root)) return null;

    const key    = root + ':' + className;
    const cached = modelCache.get(key);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        return cached.data;
    }

    const php      = process.env.PHP_BINARY || 'php';
    const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].join(':');
    const env = {
        ...process.env,
        PATH: `${extraPath}:${process.env.PATH || ''}`,
    };

    const result = spawnSync(
        php,
        ['artisan', 'model:show', className, '--json', '--no-ansi'],
        { cwd: root, env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }
    );

    let data = null;

    if (!result.error && result.status === 0 && result.stdout) {
        try {
            // Trim leading non-JSON output (deprecation notices, etc.)
            const start = result.stdout.indexOf('{');
            if (start !== -1) {
                const raw = JSON.parse(result.stdout.slice(start));
                data = normalise(raw);
            }
        } catch (_) {}
    } else if (result.stderr && result.stderr.trim()) {
        process.stderr.write(
            `[laravel-lsp] model:show ${className} failed: ${result.stderr.slice(0, 200)}\n`
        );
    }

    modelCache.set(key, { data, ts: Date.now() });
    return data;
}

/**
 * Recursively collect PHP file class names from a directory.
 * @param {string} dir
 * @param {string[]} out  accumulator
 */
function collectModelNames(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            collectModelNames(full, out);
        } else if (e.name.endsWith('.php')) {
            try {
                const content = fs.readFileSync(full, 'utf8');
                const m = content.match(/^\s*class\s+(\w+)/m);
                if (m) out.push(m[1]);
            } catch (_) {}
        }
    }
}

/**
 * Return the short class names of all models in app/Models/.
 * @param {string} root  Laravel project root
 * @returns {string[]}
 */
function getAllModelNames(root) {
    const names = [];
    collectModelNames(path.join(root, 'app', 'Models'), names);
    return names;
}

/**
 * Clear all cached model data.
 * Call this when model files or migrations change.
 */
function invalidateModelCache() {
    modelCache.clear();
}

module.exports = { getModelData, getAllModelNames, invalidateModelCache };
