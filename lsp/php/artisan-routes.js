'use strict';
// Fetches routes from `php artisan route:list --json`.
// Runs asynchronously so the LSP never blocks; returns cached results immediately.
//
// RouteEntry shape matches routes.js: { name, verb, uri, action }

const { exec } = require('child_process');
const path = require('path');
const fs   = require('fs');

// ── Cache ─────────────────────────────────────────────────────────────────────

let cache = null; // { root: string, routes: RouteEntry[], ts: number }
let pending = false;

const CACHE_TTL_MS = 30_000; // re-run artisan at most every 30 s

function invalidateArtisanRouteCache() {
    cache   = null;
    pending = false;
}

// ── Normalise artisan JSON → RouteEntry[] ─────────────────────────────────────

/**
 * `php artisan route:list --json` returns an array of objects:
 *   { domain, method, uri, name, action, middleware }
 *
 * `method` can be "GET|HEAD", "POST", "PUT|PATCH", etc.
 * We keep only the first HTTP verb and skip unnamed routes.
 */
function normalise(rows) {
    const out = [];
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;

        const name = row.name ? String(row.name).trim() : '';
        if (!name) continue;

        const verb = row.method
            ? String(row.method).split('|')[0].toUpperCase()
            : 'GET';

        const uri    = row.uri    ? String(row.uri)    : '';
        const action = row.action ? String(row.action) : '';

        // Shorten action: strip namespace down to "Controller@method"
        const shortAction = action.includes('\\')
            ? action.split('\\').pop()
            : action;

        out.push({ name, verb, uri, action: shortAction });
    }
    return out;
}

// ── Artisan runner ────────────────────────────────────────────────────────────

/**
 * Detect the artisan file for the given root.
 * Returns null if artisan doesn't exist (not a Laravel project).
 */
function artisanPath(rootPath) {
    const p = path.join(rootPath, 'artisan');
    return fs.existsSync(p) ? p : null;
}

/**
 * Fire-and-forget: run artisan via the shell and update the cache when done.
 * Using exec (shell=true) so the shell's PATH is used — important because the
 * LSP process (spawned by the editor as a GUI app) often has a stripped PATH
 * that doesn't include /usr/local/bin, /opt/homebrew/bin, etc.
 */
function refreshArtisanRoutes(rootPath) {
    if (pending) return;

    if (!artisanPath(rootPath)) return; // not a Laravel project

    pending = true;

    // PHP_BINARY env var lets users point at a specific binary (e.g. php8.3).
    const php = process.env.PHP_BINARY || 'php';

    // Common Homebrew / system PHP locations to prepend to PATH so the shell
    // can find `php` even when the editor's GUI PATH is minimal.
    const extraPath = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
    ].join(':');

    const env = {
        ...process.env,
        PATH: `${extraPath}:${process.env.PATH || ''}`,
    };

    exec(
        `${php} artisan route:list --json --no-ansi`,
        { cwd: rootPath, env, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
            pending = false;

            if (err) {
                process.stderr.write(
                    `[laravel-lsp] artisan route:list failed: ${err.message}\n` +
                    (stderr ? `  stderr: ${stderr.slice(0, 300)}\n` : '')
                );
                return;
            }

            let rows;
            try {
                // Trim any leading non-JSON output (deprecation notices, etc.)
                const start = stdout.indexOf('[');
                if (start === -1) {
                    process.stderr.write('[laravel-lsp] artisan route:list: no JSON array in output\n');
                    return;
                }
                rows = JSON.parse(stdout.slice(start));
            } catch (parseErr) {
                process.stderr.write(`[laravel-lsp] artisan route:list JSON parse error: ${parseErr.message}\n`);
                return;
            }

            const routes = normalise(rows);
            process.stderr.write(`[laravel-lsp] artisan route:list: loaded ${routes.length} named routes\n`);
            cache = { root: rootPath, routes, ts: Date.now() };
        }
    );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the most recently fetched artisan routes for rootPath.
 * Also schedules a background refresh when the cache is missing or stale.
 *
 * @param {string} rootPath
 * @returns {RouteEntry[]}
 */
function getArtisanRoutes(rootPath) {
    const stale = !cache
        || cache.root !== rootPath
        || (Date.now() - cache.ts) > CACHE_TTL_MS;

    if (stale) refreshArtisanRoutes(rootPath);

    return (cache && cache.root === rootPath) ? cache.routes : [];
}

module.exports = { getArtisanRoutes, refreshArtisanRoutes, invalidateArtisanRouteCache };
