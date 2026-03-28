'use strict';
// Parses .env files into a plain key→value map.
// No php-parser needed — .env is plain text.

const fs   = require('fs');
const path = require('path');

/**
 * Parse PROJECT_ROOT/.env and return { KEY: 'value', ... }.
 * Returns {} when the file is missing or unreadable.
 */
function parseEnvFile(rootPath) {
    const envPath = path.join(rootPath, '.env');
    let content;
    try { content = fs.readFileSync(envPath, 'utf8'); } catch (_) { return {}; }

    const result = {};
    for (const raw of content.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        const eq = line.indexOf('=');
        if (eq === -1) continue;

        const key = line.slice(0, eq).trim();
        let val   = line.slice(eq + 1).trim();

        // Strip surrounding quotes (single or double)
        if (val.length >= 2) {
            const q = val[0];
            if ((q === '"' || q === "'") && val[val.length - 1] === q) {
                val = val.slice(1, -1);
            }
        }

        result[key] = val;
    }
    return result;
}

module.exports = { parseEnvFile };
