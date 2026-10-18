// Native Windows/macOS acceptance uses real CLIs and loopback mock models only.
// Linux's real-cli.test.mjs exercises these profiles with additional negative controls.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../../dist/config/config.js';
import {discoverExecutable} from '../../dist/system/executables.js';
import {systemEnvironment} from '../../dist/system/platform/index.js';
import {verifyCodexProfiles} from '../../scripts/lib/verify-sandbox.mjs';
import {verifyClaudeSandbox} from '../../scripts/lib/verify-claude.mjs';

const codex=process.env.CLIVOXA_CONTRACT_CODEX??discoverExecutable('codex',process.env,os.homedir());
const claude=process.env.CLIVOXA_CONTRACT_CLAUDE??discoverExecutable('claude',process.env,os.homedir());
const git=discoverExecutable('git',process.env,os.homedir());
const platformSkip=process.platform==='linux'
  ? 'Linux sandbox acceptance and negative controls run in real-cli.test.mjs'
  : !['win32','darwin'].includes(process.platform)&&'Native acceptance targets Windows and macOS';

async function withIsolatedProfile(target,run) {
  const home=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'cv-sandbox-')));
  const overrides={
    USERPROFILE:home,
    APPDATA:path.join(home,'AppData','Roaming'),
    LOCALAPPDATA:path.join(home,'AppData','Local'),
    CODEX_HOME:path.join(home,'.codex'),
    CLAUDE_CONFIG_DIR:path.join(home,'.claude'),
  };
  const before=Object.fromEntries(Object.keys(overrides).map(key=>[key,process.env[key]]));
  try {
    for(const dir of Object.values(overrides))fs.mkdirSync(dir,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(overrides.CODEX_HOME,'config.toml'),'');
    // The production verifier also consults these environment locations. Keep its
    // copied config and Windows profile paths inside this disposable fixture.
    Object.assign(process.env,overrides);
    const cfg=loadConfig({
      ...systemEnvironment(),...overrides,HOME:home,PATH:process.env.PATH,
      CLIVOXA_HOME:path.join(home,'.clivoxa'),CLIVOXA_EXPOSE:target,
      CLIVOXA_MAX_ACCESS:'write',CODEX_BIN:codex??'',CLAUDE_BIN:claude??'',
      GIT_BIN:git??'',NODE_BIN:process.execPath,
    });
    await run(cfg);
  } finally {
    for(const [key,value] of Object.entries(before)) {
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
    fs.rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
}

test('native Codex sandbox accepts read/write and denies protected, outside, secret and network access',{
  skip:platformSkip||(!codex&&'Codex CLI not installed')||(!git&&'Git is required for nested-repository protection probes')
    ||(process.platform==='win32'&&'Codex file access is not offered on Windows'),
},async()=>{
  await withIsolatedProfile('codex',async cfg=>{
    const {record,details}=await verifyCodexProfiles({cfg,modes:['ro','rw'],writeRecord:false});
    assert.equal(record.profiles_verified.ro,true,`native ${process.platform} read: ${JSON.stringify(details)}`);
    assert.equal(record.profiles_verified.rw,true,`native ${process.platform} write: ${JSON.stringify(details)}`);
  });
});

test('native Claude sandbox accepts read/write and denies protected, outside and secret access',{
  skip:platformSkip||(!claude&&'Claude CLI not installed'),
},async()=>{
  await withIsolatedProfile('claude',async cfg=>{
    const result=await verifyClaudeSandbox({cfg,writeRecord:false});
    assert.equal(result.read,true,`native ${process.platform} read: ${JSON.stringify(result.details)}`);
    assert.equal(result.write,true,`native ${process.platform} write: ${JSON.stringify(result.details)}`);
  });
});
