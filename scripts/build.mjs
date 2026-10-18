import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const result=await build({
  absWorkingDir:root,
  entryPoints:['src/cli/main.ts'],outfile:'dist/clivoxa.mjs',bundle:true,platform:'node',format:'esm',target:'node22',
  banner:{js:'// Bundled dependency licenses: THIRD-PARTY-NOTICES.txt\nimport {createRequire as __clivoxaCreateRequire} from "node:module"; const require = __clivoxaCreateRequire(import.meta.url);'},
  sourcemap:true,metafile:true,logLevel:'warning',
});

// Use the files actually bundled, including nested dependencies. Some packages have
// intermediate package.json files that only specify "type", so keep walking until
// the owning package's name and version are found.
const packages=new Map();
for(const input of Object.keys(result.metafile.inputs)) {
  if(!input.split(/[\\/]/).includes('node_modules'))continue;
  let directory=path.dirname(path.resolve(root,input));
  let found=false;
  while(directory!==path.dirname(directory)) {
    const manifestFile=path.join(directory,'package.json');
    if(fs.existsSync(manifestFile)) {
      const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
      if(typeof manifest.name==='string'&&typeof manifest.version==='string') {
        packages.set(fs.realpathSync(directory),manifest);
        found=true;
        break;
      }
    }
    // Never fall through to Clivoxa's own package for an unrecognized dependency.
    if(path.basename(directory)==='node_modules')break;
    directory=path.dirname(directory);
  }
  if(!found)throw new Error(`Cannot locate the bundled dependency package for ${input}`);
}

const sections=[];
for(const [directory,manifest] of packages) {
  const files=fs.readdirSync(directory).filter(name=>
    /^(licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name)&&fs.statSync(path.join(directory,name)).isFile()
  ).sort();
  if(!files.some(name=>/^(licen[cs]e|copying)(?:[.-].*)?$/i.test(name))) {
    throw new Error(`Missing license text for bundled dependency ${manifest.name}@${manifest.version}`);
  }
  const notices=files.map(name=>`${name}\n\n${fs.readFileSync(path.join(directory,name),'utf8').trim()}`).join('\n\n');
  sections.push(`${manifest.name}@${manifest.version}\n${'='.repeat(72)}\n\n${notices}`);
}
const notices='Clivoxa bundles the following third-party software.\nThe license and notice texts below apply to those components.\n\n'+[...new Set(sections)].sort().join('\n\n\n')+'\n';
fs.writeFileSync(path.join(root,'dist','THIRD-PARTY-NOTICES.txt'),notices);
if(process.platform!=='win32')fs.chmodSync(path.join(root,'dist','clivoxa.mjs'),0o755);
