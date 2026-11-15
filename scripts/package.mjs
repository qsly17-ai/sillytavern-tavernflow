import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const root = new URL('../', import.meta.url).pathname;
const out = new URL('../release/', import.meta.url).pathname;
await fs.mkdir(out, { recursive: true });
const stage = `${out}tavern-flow-0.3.0`;
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage);
await fs.cp(`${root}client`, `${stage}/extension`, { recursive: true });
await fs.mkdir(`${stage}/extension/lib`, { recursive: true });
await fs.copyFile(`${root}shared/protocol.mjs`, `${stage}/extension/lib/protocol.mjs`);
await fs.mkdir(`${stage}/server-plugin`);
for (const dir of ['server','shared']) await fs.cp(`${root}${dir}`, `${stage}/server-plugin/${dir}`, { recursive: true });
await fs.writeFile(`${stage}/server-plugin/package.json`, JSON.stringify({ name:'tavern-flow',version:'0.3.0',type:'module',main:'server/index.mjs',license:'AGPL-3.0-only' },null,2));
for (const name of ['README.md','USAGE.zh-CN.txt','LICENSE','NOTICE.md']) await fs.copyFile(`${root}${name}`, `${stage}/${name}`);
for (const dir of ['extension','server-plugin']) for (const name of ['LICENSE','NOTICE.md']) await fs.copyFile(`${root}${name}`, `${stage}/${dir}/${name}`);
await fs.mkdir(`${stage}/reports`);
for (const name of ['acceptance-0.3.md','runtime-0.3.json','review-0.3.md','startup-0.3-investigation.md','xiaobaix-ny-0.3.md','source-sha256-0.3.json']) {
  await fs.copyFile(`${root}reports/${name}`, `${stage}/reports/${name}`);
}
await fs.mkdir(`${stage}/scripts`);
await fs.copyFile(`${root}scripts/install.py`, `${stage}/scripts/install.py`);
for (const dir of ['client','server','shared','tests']) await fs.cp(`${root}${dir}`, `${stage}/${dir}`, { recursive: true });
await fs.copyFile(`${root}package.json`, `${stage}/package.json`);
await fs.copyFile(`${root}CONTRACT.md`, `${stage}/CONTRACT.md`);
for (const name of ['check.mjs','package.mjs','startup-http-benchmark.mjs']) await fs.copyFile(`${root}scripts/${name}`, `${stage}/scripts/${name}`);
const zip = `${out}tavern-flow-0.3.0.zip`;
await fs.rm(zip, { force: true });
execFileSync('python3', ['-c', `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as archive:
    for item in sorted(root.rglob('*')):
        if item.is_file(): archive.write(item, item.relative_to(root.parent))
`, stage, zip]);
console.log(JSON.stringify({zip,bytes:(await fs.stat(zip)).size}));
