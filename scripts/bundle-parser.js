// Entry point for esbuild — bundles php-parser into a single CJS file
// embedded by src/lib.rs via include_str!
module.exports = require('php-parser');
