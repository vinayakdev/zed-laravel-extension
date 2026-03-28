'use strict';
// Parses routes/*.php files into a list of named routes using php-parser (AST).
// Handles:  Route::verb()->name()   Route::name()->group(fn)
//           Route::prefix()->group  Route::resource()  Route::apiResource()
//
// Also merges routes from `php artisan route:list --json` (see artisan-routes.js)
// so that package / service-provider routes are included.

const fs   = require('fs');
const path = require('path');
const { getArtisanRoutes, invalidateArtisanRouteCache, refreshArtisanRoutes } = require('./artisan-routes');

let PhpParser = null;
try { PhpParser = require('../vendor/php-parser.js'); } catch (_) {}

// ── Cache ────────────────────────────────────────────────────────────────────

// Caches only the static-parsed routes from routes/*.php.
// The merged result is NOT cached here — artisan results are merged fresh on
// every call so that the background artisan process can populate completions
// without needing a route-file save to trigger a cache bust.
let staticCache = null; // { root: string, routes: RouteEntry[] }

function invalidateRouteCache() { staticCache = null; }

// ── Parser factory ───────────────────────────────────────────────────────────

function makeParser() {
    if (!PhpParser) return null;
    return new PhpParser({ parser: { extractDoc: false, suppressErrors: true },
                           ast:    { withPositions: false } });
}

// ── AST helpers ──────────────────────────────────────────────────────────────

/**
 * Extract a plain string from a node.
 * Handles:  'literal'  |  __DIR__ . '/sub'  |  __DIR__ . $var (→ null)
 */
function extractString(node, fileDir) {
    if (!node) return null;
    if (node.kind === 'string') return node.value;
    if (node.kind === 'magic'  && node.value === '__DIR__') return fileDir;
    if (node.kind === 'bin'    && node.type  === '.') {
        const l = extractString(node.left,  fileDir);
        const r = extractString(node.right, fileDir);
        return l !== null && r !== null ? l + r : null;
    }
    return null;
}

/**
 * Extract a human-readable action label from a route handler argument.
 * [Controller::class, 'method']  →  "Controller@method"
 * 'App\Http\Controllers\Foo@bar' →  "Foo@bar"  (last segment)
 * Closure                        →  "Closure"
 */
function extractAction(arg) {
    if (!arg) return '';
    if (arg.kind === 'string') {
        const parts = arg.value.split('\\');
        return parts[parts.length - 1];
    }
    if (arg.kind === 'array') {
        const vals = (arg.items || []).map(e => {
            if (!e?.value) return '';
            if (e.value.kind === 'staticlookup') {
                // ClassName::class
                return e.value.what?.name ?? e.value.what?.resolution ?? '';
            }
            if (e.value.kind === 'string') return e.value.value;
            return '';
        }).filter(Boolean);
        return vals.join('@');
    }
    if (arg.kind === 'closure' || arg.kind === 'arrowfunc') return 'Closure';
    return '';
}

// HTTP verbs that register a single route
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match']);

// resource() action → HTTP verb
const RESOURCE_METHOD_MAP = {
    index:   'GET',   create: 'GET',  store:   'POST',
    show:    'GET',   edit:   'GET',  update:  'PUT',
    destroy: 'DELETE',
};
const RESOURCE_ACTIONS     = Object.keys(RESOURCE_METHOD_MAP);
const API_RESOURCE_ACTIONS = ['index', 'store', 'show', 'update', 'destroy'];

// ── Chain collection ─────────────────────────────────────────────────────────

/**
 * Unwind a method-call chain into a flat array (base call first).
 *
 * Route::get('/a', H)->name('a')->middleware('auth')
 * →  [ {method:'get', isStatic:true, cls:'Route', args:[...]},
 *       {method:'name',      args:['a']},
 *       {method:'middleware',args:['auth']} ]
 */
function collectChain(node) {
    const chain = [];
    let cur = node;
    while (cur && cur.kind === 'call') {
        const what = cur.what;
        if (what?.kind === 'propertylookup') {
            chain.unshift({ method: what.offset?.name ?? '', args: cur.arguments || [] });
            cur = what.what;
        } else if (what?.kind === 'staticlookup') {
            const cls = what.what?.name ?? what.what?.resolution ?? '';
            chain.unshift({ method: what.offset?.name ?? what.offset?.resolution ?? '',
                            args: cur.arguments || [],
                            isStatic: true, cls });
            break;
        } else {
            break;
        }
    }
    return chain;
}

// ── Route extraction ─────────────────────────────────────────────────────────

/**
 * @typedef {{ name:string, verb:string, uri:string, action:string }} RouteEntry
 */

/**
 * Walk a list of statement AST nodes and collect RouteEntry objects.
 */
function extractFromNodes(nodes, fileDir, ctx, out) {
    for (const node of nodes) {
        if (node?.kind !== 'expressionstatement') continue;
        const chain = collectChain(node.expression);
        if (!chain.length) continue;
        const first = chain[0];
        if (!first.isStatic || first.cls !== 'Route') continue;
        processChain(chain, fileDir, ctx, out);
    }
}

function processChain(chain, fileDir, ctx, out) {
    const verb = (chain[0].method || '').toLowerCase();

    // Gather modifiers from every link in the chain
    let routeName       = null;  // final route name (no trailing dot)
    let localNamePrefix = '';    // e.g. 'admin.' from ->name('admin.')
    let localUriPrefix  = '';
    let groupClosure    = null;

    for (const link of chain) {
        if (link.method === 'name' && link.args[0]) {
            const n = extractString(link.args[0], fileDir);
            if (n !== null) {
                if (n.endsWith('.')) localNamePrefix = n;
                else routeName = n;
            }
        }
        if (link.method === 'prefix' && link.args[0]) {
            const p = extractString(link.args[0], fileDir);
            if (p !== null) localUriPrefix = p;
        }
        if (link.method === 'group') {
            groupClosure = link.args.find(a => a.kind === 'closure' || a.kind === 'arrowfunc') ?? null;
        }
    }

    const fullNamePrefix = ctx.namePrefix + localNamePrefix;
    const fullUriPrefix  = ctx.uriPrefix  + localUriPrefix;

    // ── group() ──────────────────────────────────────────────────────────────
    if (groupClosure) {
        const children = groupClosure.body?.children
                      ?? (Array.isArray(groupClosure.body) ? groupClosure.body : []);
        extractFromNodes(children, fileDir,
                         { namePrefix: fullNamePrefix, uriPrefix: fullUriPrefix }, out);
        return;
    }

    // ── resource / apiResource ────────────────────────────────────────────────
    if (verb === 'resource' || verb === 'apiresource') {
        const uriSeg     = extractString(chain[0].args[0], fileDir) ?? '';
        const baseName   = uriSeg.replace(/^\//, '').replace(/\//g, '.');
        const actions    = verb === 'apiresource' ? API_RESOURCE_ACTIONS : RESOURCE_ACTIONS;

        // Check for ->only([...]) / ->except([...])
        let only = null, except = null;
        for (const link of chain) {
            if (link.method === 'only'   && link.args[0]) only   = stringsFromArray(link.args[0]);
            if (link.method === 'except' && link.args[0]) except = stringsFromArray(link.args[0]);
        }

        for (const action of actions) {
            if (only   && !only.includes(action))   continue;
            if (except &&  except.includes(action)) continue;
            out.push({
                name:   fullNamePrefix + baseName + '.' + action,
                verb:   RESOURCE_METHOD_MAP[action],
                uri:    fullUriPrefix + '/' + uriSeg,
                action: `${baseName} resource → ${action}`,
            });
        }
        return;
    }

    // ── plain HTTP verb ───────────────────────────────────────────────────────
    if (HTTP_VERBS.has(verb) && routeName) {
        const uri    = extractString(chain[0].args[0], fileDir) ?? '';
        const action = extractAction(chain[0].args[1]);
        out.push({
            name:   ctx.namePrefix + routeName,
            verb:   verb.toUpperCase(),
            uri:    ctx.uriPrefix + uri,
            action,
        });
    }
}

/** Extract string values from a PHP array node (for ->only([...])). */
function stringsFromArray(node) {
    if (node?.kind !== 'array') return null;
    return (node.items || [])
        .map(e => e?.value?.kind === 'string' ? e.value.value : null)
        .filter(Boolean);
}

// ── File discovery ───────────────────────────────────────────────────────────

function findRouteFiles(rootPath) {
    const dir = path.join(rootPath, 'routes');
    try {
        return fs.readdirSync(dir)
            .filter(f => f.endsWith('.php'))
            .map(f => path.join(dir, f));
    } catch (_) { return []; }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Return all named routes for the project at rootPath.
 * Cached until invalidateRouteCache() is called.
 *
 * @param {string} rootPath
 * @returns {RouteEntry[]}
 */
function getRoutes(rootPath) {
    // ── Static parsing (cached until a route file changes) ───────────────────
    if (!staticCache || staticCache.root !== rootPath) {
        const routes = [];
        const parser = makeParser();
        if (parser) {
            for (const filePath of findRouteFiles(rootPath)) {
                let content;
                try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { continue; }
                let ast;
                try { ast = parser.parseCode(content, filePath); } catch (_) { continue; }
                extractFromNodes(ast.children || [], path.dirname(filePath),
                                 { namePrefix: '', uriPrefix: '' }, routes);
            }
        }
        staticCache = { root: rootPath, routes };
    }

    // ── Artisan routes — always merged fresh ─────────────────────────────────
    // getArtisanRoutes() has its own TTL cache and triggers a background refresh
    // when stale. By merging here on every call (not caching the merged result),
    // completions automatically include artisan routes as soon as the first
    // background run completes — no route-file save required.
    const artisanRoutes = getArtisanRoutes(rootPath);

    // Artisan is authoritative — it overwrites static entries on name collision.
    const merged = new Map();
    for (const r of staticCache.routes) merged.set(r.name, r);
    for (const r of artisanRoutes)      merged.set(r.name, r);
    return Array.from(merged.values());
}

/**
 * Invalidate both the static-parse cache and the artisan-routes cache.
 * Call this when route files change so the next completion re-reads everything.
 */
function invalidateAllRouteCaches() {
    staticCache = null;
    invalidateArtisanRouteCache();
}

module.exports = { getRoutes, invalidateRouteCache, invalidateAllRouteCaches, refreshArtisanRoutes };
