'use strict';

// ── Merge helpers ─────────────────────────────────────────────────────────────

function mergeMethods(existing, incoming) {
  const seen = new Set(existing.map(m => m.name));
  return [...existing, ...incoming.filter(m => !seen.has(m.name))];
}

function mergeProps(existing, incoming) {
  const seen = new Set(existing.map(p => p.name));
  return [...existing, ...incoming.filter(p => !seen.has(p.name))];
}

// ── Core resolver ─────────────────────────────────────────────────────────────

/**
 * resolveMembers(className, opts, depth) → { methods, properties }
 *
 * opts = {
 *   getAppClass:      (name) => classEntry | null
 *   getVendorClass:   (name, root, altFileText?) => classEntry | null
 *   root:             string
 *   context:          'instance' | 'static'
 *   callerVisibility: 'inside' | 'outside'
 * }
 *
 * depth is used internally to cap recursion; callers omit it.
 */
function resolveMembers(className, opts, depth = 0) {
  if (depth >= 3) {
    return { methods: [], properties: [] };
  }

  const entry =
    opts.getAppClass(className) ||
    opts.getVendorClass(className, opts.root) ||
    null;

  if (!entry) {
    return { methods: [], properties: [] };
  }

  // When recursing into this entry's traits/parent/interfaces, use the entry's
  // own fileContent (if it's a vendor class) for FQN lookups.  This ensures
  // that `use` statements from the vendor file itself are used — not the
  // original editing file — when resolving deeper chains like
  // SoftDeletes → SoftDeletingScope → Builder.
  const childOpts = entry.fileContent
    ? { ...opts, getVendorClass: (name, r) => opts.getVendorClass(name, r, entry.fileContent) }
    : opts;

  // Own members — shallow copy so we never mutate the index entries
  let methods    = [...(entry.methods    || [])];
  let properties = [...(entry.properties || [])];

  // Traits use the same depth (copy-paste semantics)
  for (const trait of (entry.traits || [])) {
    const merged = resolveMembers(trait, childOpts, depth);
    methods    = mergeMethods(methods, merged.methods);
    properties = mergeProps(properties, merged.properties);
  }

  // Parent class increments depth
  if (entry.extends) {
    const merged = resolveMembers(entry.extends, childOpts, depth + 1);
    methods    = mergeMethods(methods, merged.methods);
    properties = mergeProps(properties, merged.properties);
  }

  // Interfaces increment depth (interfaces only contribute methods)
  for (const iface of (entry.implements || [])) {
    const merged = resolveMembers(iface, childOpts, depth + 1);
    methods = mergeMethods(methods, merged.methods);
  }

  // Only apply visibility/context filtering at the top-level call
  if (depth !== 0) {
    return { methods, properties };
  }

  return applyFilters({ methods, properties }, opts);
}

// ── Visibility / context filtering ───────────────────────────────────────────

function applyFilters({ methods, properties }, opts) {
  const vis = opts.callerVisibility || 'outside';
  const ctx = opts.context          || 'instance';

  // Visibility predicate
  function visOk(member) {
    // Scope methods are always externally callable via Laravel's __callStatic magic
    if (member.isScope) return true;
    if (vis === 'outside') {
      return member.visibility === 'public';
    }
    // 'inside': public + protected (private from parent is already excluded
    // by child-wins dedup; own private is fine to keep)
    return member.visibility === 'public' || member.visibility === 'protected' || member.visibility === 'private';
  }

  // Context predicate for methods
  function ctxOk(method) {
    // Scope methods are always callable in static context on models
    if (method.isScope) return true;
    if (ctx === 'static') {
      return method.isStatic === true;
    }
    // 'instance': $this-> shows both static and instance methods
    return true;
  }

  return {
    methods:    methods.filter(m => visOk(m) && ctxOk(m)),
    properties: properties.filter(p => visOk(p)),
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { resolveMembers };
