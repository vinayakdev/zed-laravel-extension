'use strict';

const fs   = require('fs');
const path = require('path');
const { warmVendorCache } = require('./vendor');

// ── File collector ────────────────────────────────────────────────────────────

function collectPhpFiles(dir, out) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) collectPhpFiles(full, out);
      else if (e.name.endsWith('.php')) out.push(full);
    }
  } catch (_) {}
}

// ── Background batch processor ────────────────────────────────────────────────

const BATCH_SIZE = 20; // files per setImmediate tick

/**
 * Warm the vendor class cache by processing `files` in batches of BATCH_SIZE,
 * yielding to the event loop between each batch via setImmediate.
 *
 * This means:
 *  - No single batch blocks the event loop for more than ~10ms
 *  - Incoming LSP requests are handled between batches
 *  - Cache hits accumulate silently in the background
 */
function processBatches(files, i) {
  const end = Math.min(i + BATCH_SIZE, files.length);
  for (; i < end; i++) {
    warmVendorCache(files[i]);
  }
  if (i < files.length) {
    setImmediate(() => processBatches(files, i));
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Kick off a background scan of known vendor namespaces.
 * Safe to call multiple times — collectPhpFiles is fast and warmVendorCache
 * skips already-cached entries, so duplicate scans are cheap.
 *
 * Currently scans:
 *   vendor/laravel/framework/src/   — all Illuminate classes
 *
 * To add support for another package (e.g. Filament, Spatie) either call
 * prefetchVendorNamespaces again with a new root-relative path, or extend
 * VENDOR_PATHS below.
 */
const VENDOR_PATHS = [
  path.join('vendor', 'laravel', 'framework', 'src'),
];

function prefetchVendorNamespaces(root) {
  const files = [];
  for (const rel of VENDOR_PATHS) {
    collectPhpFiles(path.join(root, rel), files);
  }
  if (!files.length) return; // vendor/ not present (e.g. bare project)
  // Start after the current tick so the `initialized` response goes out first
  setImmediate(() => processBatches(files, 0));
}

module.exports = { prefetchVendorNamespaces };
