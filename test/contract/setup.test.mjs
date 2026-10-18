import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {discoverExecutable} from '../../dist/system/executables.js';
import {systemEnvironment} from '../../dist/system/platform/index.js';
import {loadConfig} from '../../dist/config/config.js';
import {resolveLaunch} from '../../dist/providers/child-env.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const codex=process.env.CLIVOXA_CONTRACT_CODEX??discoverExecutable('codex',process.env,os.homedir());
const claude=process.env.CLIVOXA_CONTRACT_CLAUDE??discoverExecutable('claude',process.env,os.homedir());
test('real CLI setup uses normal registrations with opposite roles in an isolated user profile',{skip:(!codex||!claude)&&'Both host CLIs required'},()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'cv-setup-'));
  try {
    const env={...systemEnvironment(),PATH:process.env.PATH,HOME:home,USERPROFILE:home,
      APPDATA:path.join(home,'AppData','Roaming'),LOCALAPPDATA:path.join(home,'AppData','Local'),
      CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),
      CODEX_BIN:codex,CLAUDE_BIN:claude,NODE_BIN:process.execPath,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
    fs.mkdirSync(env.CODEX_HOME,{recursive:true});
    fs.mkdirSync(env.CLAUDE_CONFIG_DIR,{recursive:true});
    const result=spawnSync(process.execPath,[path.join(root,'dist','clivoxa.mjs'),'setup','--local'],{env,encoding:'utf8',windowsHide:true,timeout:180_000});
    assert.equal(result.status,0,result.stdout+result.stderr);
    const claudeSettings=JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR,'.claude.json'),'utf8'));
    assert.equal(claudeSettings.mcpServers.clivoxa.env.CLIVOXA_EXPOSE,'codex');
    assert.equal(claudeSettings.mcpServers.clivoxa.command,process.execPath);
    assert.deepEqual(claudeSettings.mcpServers.clivoxa.args,[path.join(root,'dist','clivoxa.mjs')]);
    const codexSettings=fs.readFileSync(path.join(home,'.codex','config.toml'),'utf8');
    assert.match(codexSettings,/\[mcp_servers\.clivoxa\]/);
    assert.match(codexSettings,/CLIVOXA_EXPOSE\s*=\s*"claude"/);
    assert.match(codexSettings,/clivoxa\.mjs/);
    // Read back through the real host CLIs: a parseable file alone does not prove
    // that the host accepts its schema or that setup selected its actual profile.
    const cfg=loadConfig(env);
    const hostRead=(binary,args)=>{
      const launch=resolveLaunch(cfg,binary);
      const output=spawnSync(launch.cmd,[...launch.pre,...args],{env,cwd:home,encoding:'utf8',windowsHide:true,timeout:30_000});
      assert.equal(output.status,0,output.stdout+output.stderr);
      return output.stdout;
    };
    const claudeRead=hostRead(claude,['mcp','get','clivoxa']);
    assert.match(claudeRead,/clivoxa/);
    assert.match(claudeRead,/clivoxa\.mjs/);
    const codexRead=JSON.parse(hostRead(codex,['mcp','get','clivoxa','--json']));
    assert.equal(codexRead.name,'clivoxa');
    assert.equal(codexRead.enabled,true);
    assert.equal(codexRead.transport.type,'stdio');
    assert.equal(codexRead.transport.command,process.execPath);
    assert.deepEqual(codexRead.transport.args,[path.join(root,'dist','clivoxa.mjs')]);
    assert.equal(codexRead.transport.env.CLIVOXA_EXPOSE,'claude');
  } finally {fs.rmSync(home,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
