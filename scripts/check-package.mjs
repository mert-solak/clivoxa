import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {systemEnvironment} from '../dist/system/platform/index.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'clivoxa-pack-'));
const npm=process.env.npm_execpath;
if(!npm)throw new Error('Run through npm run test:package so npm_execpath is explicit.');
try {
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  assert.equal(Object.keys(manifest.dependencies??{}).length,0,'consumer has no runtime install dependencies');
  const packed=spawnSync(process.execPath,[npm,'pack','--ignore-scripts','--json','--pack-destination',scratch],{cwd:root,encoding:'utf8',windowsHide:true});
  assert.equal(packed.status,0,packed.stderr);
  const archive=JSON.parse(packed.stdout)[0];
  assert.ok(archive.files.some(file=>file.path==='dist/clivoxa.mjs'));
  // Every compiled module ships from a current source file: stale output from moved modules must not leak.
  const stale=archive.files.map(file=>file.path).filter(p=>/^dist\/.+\.js$/.test(p)&&!fs.existsSync(path.join(root,'src',p.slice('dist/'.length).replace(/\.js$/,'.ts'))));
  assert.deepEqual(stale,[],'no compiled module without a source file');
  const notices=archive.files.find(file=>file.path==='dist/THIRD-PARTY-NOTICES.txt');
  assert.ok(notices?.size>0,'bundled dependency license notices ship in the npm artifact');
  assert.equal(notices.size,fs.statSync(path.join(root,'dist','THIRD-PARTY-NOTICES.txt')).size);
  const tarball=path.join(scratch,archive.filename);
  for(const role of ['codex','claude']) {
    const client=new Client({name:'package-contract',version:'1'});
    const transport=new StdioClientTransport({
      command:process.execPath,
      args:[npm,'exec','--offline','--yes','--ignore-scripts','--cache',path.join(scratch,'empty-cache'),'--package',tarball,'--','clivoxa'],
      cwd:scratch,stderr:'pipe',
      env:{...systemEnvironment(),HOME:scratch,USERPROFILE:scratch,PATH:process.env.PATH,NODE_BIN:process.execPath,
        CODEX_BIN:path.join(root,'test','fakes','codex.mjs'),CLAUDE_BIN:path.join(root,'test','fakes','claude.mjs'),
        CLIVOXA_EXPOSE:role,CLIVOXA_HOME:path.join(scratch,role),CODEX_HOME:path.join(scratch,'codex'),CLAUDE_CONFIG_DIR:path.join(scratch,'claude')},
    });
    let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk;});
    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion()?.name,'clivoxa');
      const names=(await client.listTools()).tools.map(tool=>tool.name).sort();
      assert.deepEqual(names,[`ask_${role}`,'cancel_job','get_job','list_jobs','list_models'].sort());
      const catalogue=await client.callTool({name:'list_models',arguments:{refresh:true}});
      assert.ok(!catalogue.isError);
      let result=await client.callTool({name:`ask_${role}`,arguments:{prompt:'isolated package request',effort:'low',wait_seconds:30}});
      let text=result.content.map(item=>item.text??'').join('\n');
      if(text.includes('status: running')) {
        const id=/^job_id: (.+)$/m.exec(text)?.[1];
        assert.ok(id,text);
        result=await client.callTool({name:'get_job',arguments:{job_id:id,wait_seconds:30}});
        text=result.content.map(item=>item.text??'').join('\n');
      }
      assert.match(text,/status: done/);
      console.log(`${role}: offline npm tarball, MCP, catalogue and detached runner passed`);
    } catch(error) {process.stderr.write(stderr);throw error;}
    finally {await client.close();}
  }
} finally {fs.rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
