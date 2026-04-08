# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- `<x-` component tag completions scanning `app/View/Components/` and `resources/views/components/`
- Component discovery: class-based (PHP constructor props) and anonymous (`@props`) components
- PascalCase → kebab-case tag name mapping with index-component deduplication
- Prop attribute completions: static `propname=""` and PHP-bound `:propname=""` variants
- Go to Definition on `<x-tag>` returns both the component class file and the Blade view file
- Component cache keyed by workspace root; invalidated on component file changes (`didOpen` / `didChange`)

## [0.0.3] — 2026-04-08

### Added
- **Controller method go-to-definition**: cursor on `'methodName'` inside a route array
  `[ClassName::class, 'methodName']` (or legacy `'ClassName@method'` string) now navigates
  directly to the method definition in the controller file.
- **Controller method scaffold**: if the method does not exist, a notification prompts
  "Create Method?" — accepting inserts a `public function` stub at the end of the class
  and opens the file at the new method via `workspace/applyEdit`.
- **`pub` / `pubf` PHP snippets**: typing `pub` or `pubf` at the start of a line offers
  snippet completions for `public function`, `public static function`, and `public $property`,
  with tab stops and correct indentation alignment.
- Go to Definition for Blade `@include`, `@extends`, `@includeIf`, `@includeWhen`, and
  `@includeUnless` directives — jumps to the target view file, or prompts to create it
  when missing.

### Fixed
- **Document cache miss (root cause of view-jump failures on pre-opened files)**: when a
  file was already open in Zed before the LSP started, `textDocument/didOpen` was never
  received, so all `definition` / `hover` / `completion` requests operated on empty text
  and silently returned `null`. The LSP now falls back to reading the file from disk and
  warms the cache for subsequent requests.
- Missing "Create Blade view?" prompt for `view()` calls in PHP files — previously only
  Blade files prompted; now both file types offer the scaffold dialog.

## [0.0.2] — 2026-04-08

### Fixed
- Corrected Eloquent class resolution for chained static calls (`User::query()->with(…)`).
- Synced initial `artisan route:list` so all routes appear on first completion trigger.
- Added missing `artisan-routes.js` to `LSP_FILES` embed list.
