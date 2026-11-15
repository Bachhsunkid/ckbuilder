#!/usr/bin/env node
// Bundles every contract in contracts/ with esbuild and compiles it to ckb-js-vm bytecode.
// Adapted from week-05/project/scripts/build-contract.js.
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const isDebug = process.argv.includes('--debug');
const NAMES = ['mines-lock', 'mines-session'];
// npm workspaces hoist packages, so look for them from here up to the repo root.
function findPkg(name) {
  for (let dir = process.cwd(); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} not found`);
}
const esbuild = path.join(findPkg('esbuild'), 'bin', 'esbuild');
const jsVm = path.join(findPkg('ckb-testtool'), 'src', 'unittest', 'defaultScript', 'ckb-js-vm');

fs.mkdirSync('dist', { recursive: true });
const flags = isDebug
  ? ['--sourcemap=external', '--sources-content', '--keep-names', '--minify=false', '--define:DEBUG=true']
  : ['--minify'];
for (const name of NAMES) {
  const src = path.join('contracts', name, 'src', 'index.ts');
  const outJs = path.join('dist', `${name}.js`);
  const outBc = path.join('dist', `${name}.bc`);
  execSync(
    [`"${esbuild}"`, '--platform=neutral', '--main-fields=module,main', '--bundle', '--external:@ckb-js-std/bindings', '--target=es2022', ...flags, `"${src}"`, `--outfile="${outJs}"`].join(' '),
    { stdio: 'inherit' },
  );
  execSync(`ckb-debugger --read-file "${outJs}" --bin "${jsVm}" -- -c "${outBc}"`, { stdio: 'pipe' });
  console.log(`${outJs} ${fs.statSync(outJs).size} bytes, ${outBc} ${fs.statSync(outBc).size} bytes`);
}
