import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const paths = ['manifest.json', 'background.js'];
async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (/\.(?:js|mjs|json)$/.test(path)) paths.push(relative(root, path).replaceAll('\\', '/'));
    }
}
for (const sub of ['js', 'lib']) await walk(join(root, sub));
const hash = createHash('sha256');
for (const path of paths.sort()) {
    const data = await readFile(join(root, path));
    hash.update(`${path}\0${data.length}\0`); hash.update(data);
}
await writeFile(join(root, 'build-info.json'), JSON.stringify({ digest: hash.digest('hex') }) + '\n', { mode: 0o600 });
