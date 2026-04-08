'use strict';
// Fetches routes from `php artisan route:list --json`.
// First call is synchronous (spawnSync) so completions have full data immediately.
// Subsequent refreshes are async (exec) to avoid blocking the LSP.
//
// RouteEntry shape matches routes.js: { name, verb, uri, action }

const { exec, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

// ── Cache ─────────────────────────────────────────────────────────────────────

let cache = null; // { root: string, routes: RouteEntry[], ts: number }
let pending = false;
let initialSyncDone = false; // true once the first synchronous load has run

const CACHE_TTL_MS = 30_000; // re-run artisan at most every 30 s

function invalidateArtisanRouteCache() {
    cache          = null;
    pending        = false;
    initialSyncDone = false;
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

function makeEnv() {
    const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].join(':');
    return { ...process.env, PATH: `${extraPath}:${process.env.PATH || ''}` };
}

function parseRouteJson(stdout) {
    const start = stdout.indexOf('[');
    if (start === -1) return null;
    try { return JSON.parse(stdout.slice(start)); } catch (_) { return null; }
}

/**
 * Synchronous initial load — blocks until artisan finishes.
 * Called once per root so the very first completion request has full route data.
 * Subsequent refreshes use the async path to avoid blocking the LSP.
 */
function loadArtisanRoutesSync(rootPath) {
    if (!artisanPath(rootPath)) return;

    const php = process.env.PHP_BINARY || 'php';
    const result = spawnSync(
        php,
        ['artisan', 'route:list', '--json', '--no-ansi'],
        { cwd: rootPath, env: makeEnv(), timeout: 15_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }
    );

    initialSyncDone = true;

    if (result.error || result.status !== 0) {
        process.stderr.write(
            `[laravel-lsp] artisan route:list (sync) failed: ${(result.stderr || result.error?.message || '').slice(0, 300)}\n`
        );
        return;
    }

    const rows = parseRouteJson(result.stdout || '');
    if (!rows) {
        process.stderr.write('[laravel-lsp] artisan route:list (sync): no JSON array in output\n');
        return;
    }

    const routes = normalise(rows);
    process.stderr.write(`[laravel-lsp] artisan route:list (sync): loaded ${routes.length} named routes\n`);
    cache = { root: rootPath, routes, ts: Date.now() };
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

    const php = process.env.PHP_BINARY || 'php';

    exec(
        `${php} artisan route:list --json --no-ansi`,
        { cwd: rootPath, env: makeEnv(), timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
            pending = false;

            if (err) {
                process.stderr.write(
                    `[laravel-lsp] artisan route:list failed: ${err.message}\n` +
                    (stderr ? `  stderr: ${stderr.slice(0, 300)}\n` : '')
                );
                return;
            }

            const rows = parseRouteJson(stdout || '');
            if (!rows) {
                process.stderr.write('[laravel-lsp] artisan route:list: no JSON array in output\n');
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
 * Return routes for rootPath, covering ALL routes including those registered
 * in service providers, packages, and any file outside routes/.
 *
 * On `initialized`, server.js calls refreshArtisanRoutes() which starts an
 * async fetch. If that fetch is still running when the first completion fires,
 * we return an empty array rather than blocking with spawnSync — the async
 * result will populate the cache in the background and be available on the
 * next request. If no async fetch is running, we fall back to a single sync
 * load so the first completion still gets full data on slow networks.
 *
 * @param {string} rootPath
 * @returns {RouteEntry[]}
 */
function getArtisanRoutes(rootPath) {
    if (!initialSyncDone) {
        if (pending) {
            // Async fetch already underway (started by server.js on initialized).
            // Mark sync as done so we don't block on future calls; return empty
            // for now — the async result will be cached shortly.
            initialSyncDone = true;
        } else {
            // No async fetch in flight — do a one-time blocking load so the very
            // first completion request has data (only happens if initialized fires
            // before refreshArtisanRoutes is called, which is an edge case).
            loadArtisanRoutesSync(rootPath);
        }
    }

    // Schedule an async background refresh if the data is getting stale.
    const stale = !cache
        || cache.root !== rootPath
        || (Date.now() - cache.ts) > CACHE_TTL_MS;

    if (stale && !pending) refreshArtisanRoutes(rootPath);

    return (cache && cache.root === rootPath) ? cache.routes : [];
}

module.exports = { getArtisanRoutes, refreshArtisanRoutes, invalidateArtisanRouteCache };
