# Laravel — Zed Extension

Full Laravel development support for the [Zed](https://zed.dev) editor.
One LSP server handles everything: PHP class intelligence, Eloquent query
builder, and Blade template authoring.

---

## Project structure

```
zed-laravel/
├── extension.toml              # Extension manifest (id, version, LSP registration)
├── Cargo.toml                  # Rust crate (cdylib → WASM)
├── src/
│   └── lib.rs                  # Rust bootstrap — embeds & launches view-lsp.js
├── lsp/
│   └── view-lsp.js             # Node.js LSP server (all features live here)
│       ├── §1  Infrastructure      send / URI helpers / file-type guards
│       ├── §2  PHP › Discovery     class cache, namespace extraction, import helpers
│       ├── §3  PHP › Completions   class import · ClassName:: · ->chain
│       ├── §4  PHP › Definition    jump to class declaration
│       ├── §5  Blade › Views       path resolution, variable inference, file creation
│       ├── §6  Blade › Completions @directives · $variables
│       ├── §7  Message handler     thin LSP router
│       └── §8  JSON-RPC parser     stdin framing
└── grammars/
    └── blade/                  # tree-sitter-blade grammar (syntax highlighting)
        ├── grammar.js
        └── queries/
            ├── highlights.scm  # Syntax highlight rules
            └── injections.scm  # PHP / JS language injections
```

---

## Features

### PHP

| Trigger | What happens |
|---------|-------------|
| Type an uppercase word (`Us`, `Con`) | Class name completions from `app/` with **auto `use` import** |
| `new User` | Inserts `User($1)` with cursor in parens + auto-import |
| `User::` | Eloquent static methods (`find`, `where`, `create`, `paginate` …) + any declared `public static` on the class |
| `->` or `-` after `)` | Full query-builder **chain completions** (`get`, `orderBy`, `with`, `paginate` …) |
| Go to Definition on a class name | Jumps to the `class`/`interface`/`trait`/`enum` declaration line in `app/` |

Auto-import inserts `use App\Models\User;` at the right line (after existing imports, after `namespace`, or after `<?php`). Duplicate imports are never added.

### Blade

| Trigger | What happens |
|---------|-------------|
| `@` | Full Blade directive snippets with tab stops (`@if`, `@foreach`, `@section` …) |
| `$` | Variable completions inferred from `view('name', ['key' => …])` / `compact(…)` calls in PHP files |
| Go to Definition on `view('pages.about')` | Opens `resources/views/pages/about.blade.php` — prompts to create it if missing |

---

## How it works

```
Zed editor
  └── Rust extension (extension.wasm)
        └── Extracts lsp/view-lsp.js at runtime
              └── Spawns: node view-lsp.js   ← single LSP server (JSON-RPC 2.0)
                    ├── textDocument/completion  → phpCompletions() | bladeCompletions()
                    └── textDocument/definition  → phpDefinition()  | bladeDefinition()
```

The Rust layer (`src/lib.rs`) does nothing except locate `node`, embed the JS
file via `include_str!`, write it to disk, and launch it.  All intelligence is
in `lsp/view-lsp.js`.

---

## Requirements

- **Node.js** must be on `PATH` inside the workspace (the Rust bootstrap runs
  `worktree.which("node")`).
- A standard Laravel project layout is assumed:
  - PHP classes under `app/`
  - Blade views under `resources/views/`
  - Routes under `routes/`

---

## Building

```bash
cargo build --release --target wasm32-wasip1
cp target/wasm32-wasip1/release/zed_laravel.wasm extension.wasm
```

Then reload the extension in Zed (`zed: reload extensions`).
