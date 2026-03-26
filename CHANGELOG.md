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
