import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const suites={all:['unit','integration','portable'],unit:['unit'],portable:['portable'],contract:['contract']};
const name=process.argv[2]??'all';
if(!Object.hasOwn(suites,name)) throw new Error(`Unknown test suite: ${name}`);
if(name==='all'&&process.platform==='win32') {
  // The unit and integration suites use Unix permission bits and signals;
  // Windows runs the native portable contracts.
  suites.all=['portable'];
  console.log('Windows: running the portable suite; the unit and integration suites need macOS or Linux.');
}
const files=suites[name].flatMap(suite=>fs.readdirSync(path.join('test',suite)).filter(file=>file.endsWith('.test.mjs')).sort().map(file=>path.join('test',suite,file)));
// Windows fixtures start real PowerShell/CIM processes. Running four files at
// once overloads small machines and causes unrelated bounded probes to time
// out. Explicit parallel-install tests still exercise concurrency within a file.
const concurrency=name==='contract'||process.platform==='win32'?1:4;
const result=spawnSync(process.execPath,['--test',`--test-concurrency=${concurrency}`,...files],{stdio:'inherit',windowsHide:true});
process.exitCode=result.status??1;
