import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = new URL('../', import.meta.url);
let count = 0;
async function check(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) { if (!['private', 'node_modules', 'release'].includes(entry.name)) await check(path.join(dir, entry.name)); }
        else if (/\.(?:mjs|js)$/.test(entry.name)) {
            const result = spawnSync(process.execPath, ['--check', path.join(dir, entry.name)], { encoding: 'utf8' });
            if (result.status) throw new Error(result.stderr); count++;
        }
    }
}
await check(new URL('.', root).pathname);
const manifest = JSON.parse(await fs.readFile(new URL('client/manifest.json', root)));
for (const field of ['js','css']) await fs.access(new URL(`client/${manifest[field]}`, root));
console.log(JSON.stringify({ syntaxFiles: count, manifest: true }));
