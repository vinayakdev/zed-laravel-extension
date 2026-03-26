'use strict';

const { warmVendorCache, getClassmapFiles } = require('./vendor');

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
 * Kick off a background warm of ALL vendor packages registered in Composer's
 * classmap (vendor/composer/autoload_classmap.php).  This covers Laravel,
 * Filament, Spatie, and any other installed package automatically — no
 * hard-coded directory paths needed.
 *
 * Safe to call multiple times: warmVendorCache skips already-cached entries so
 * redundant calls are cheap.  Batching via setImmediate keeps the event loop
 * free for incoming LSP requests between batches.
 */
function prefetchVendorNamespaces(root) {
  const files = getClassmapFiles(root);
  if (!files.length) return; // vendor/ not present (e.g. bare project)
  // Start after the current tick so the `initialized` response goes out first
  setImmediate(() => processBatches(files, 0));
}

module.exports = { prefetchVendorNamespaces };
