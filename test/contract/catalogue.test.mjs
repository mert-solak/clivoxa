import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {loadConfig} from '../../dist/config/config.js';
import {discoverExecutable} from '../../dist/system/executables.js';
import {listModels} from '../../dist/providers/models.js';

const codex=process.env.CLIVOXA_CONTRACT_CODEX??discoverExecutable('codex',process.env,os.homedir());
const claude=process.env.CLIVOXA_CONTRACT_CLAUDE??discoverExecutable('claude',process.env,os.homedir());

test('real Codex control protocol discovers a future model/effort and never sends inference',{skip:!codex&&'Codex CLI not installed'},async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'cv-catalogue-'));
  const requests=[];
  const fixture=JSON.parse(fs.readFileSync(new URL('./model-fixture.json',import.meta.url),'utf8'));
  const mock=http.createServer((req,res)=>{
    requests.push({method:req.method,url:req.url});
    res.writeHead(req.method==='GET'&&req.url.startsWith('/catalog')?200:404,{'content-type':'application/json'});
    res.end(JSON.stringify({models:[fixture]}));
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${mock.address().port}`;
  const config=path.join(home,'.codex');fs.mkdirSync(config);
  fs.writeFileSync(path.join(config,'config.toml'),`model="clivoxa-future-model"\nmodel_provider="clivoxa_fixture"\n[features]\napi_key_model_discovery=true\n[model_providers.clivoxa_fixture]\nname="local metadata"\nbase_url=${JSON.stringify(base+'/v1')}\nmodel_catalog_url=${JSON.stringify(base+'/catalog')}\nenv_key="CLIVOXA_FIXTURE_KEY"\nwire_api="responses"\n`);
  const prior=process.env.CLIVOXA_FIXTURE_KEY;process.env.CLIVOXA_FIXTURE_KEY='dummy-not-a-credential';
  try {
    const cfg=loadConfig({...process.env,HOME:home,CLIVOXA_HOME:path.join(home,'.clivoxa'),CODEX_HOME:config,CODEX_BIN:codex,CLIVOXA_CHILD_ENV_PASS:'CLIVOXA_FIXTURE_KEY'});
    const result=await listModels(cfg,'codex',true);
    const model=result.models.find(item=>item.id===fixture.slug);
    assert.ok(model,JSON.stringify({result,requests}));assert.deepEqual(model.efforts,['future-effort']);
    assert.ok(requests.some(req=>req.url.startsWith('/catalog')));
    assert.ok(requests.every(req=>req.method==='GET'));
  } finally {
    if(prior===undefined)delete process.env.CLIVOXA_FIXTURE_KEY;else process.env.CLIVOXA_FIXTURE_KEY=prior;
    await new Promise(resolve=>mock.close(resolve));fs.rmSync(home,{recursive:true,force:true});
  }
});

test('real Claude initialize discovers a custom model without a Messages call',{skip:!claude&&'Claude CLI not installed'},async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'cv-catalogue-'));
  const requests=[];
  const mock=http.createServer((req,res)=>{requests.push({method:req.method,url:req.url});res.writeHead(404);res.end('Inference is forbidden in this test');});
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  const names=['ANTHROPIC_CUSTOM_MODEL_OPTION','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL'];
  const before=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{ANTHROPIC_CUSTOM_MODEL_OPTION:'claude-future-2030',ANTHROPIC_API_KEY:'dummy-local-key',ANTHROPIC_BASE_URL:`http://127.0.0.1:${mock.address().port}`});
  try {
    const cfg=loadConfig({...process.env,HOME:home,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),CLIVOXA_HOME:path.join(home,'.clivoxa'),CLAUDE_BIN:claude,CLIVOXA_CHILD_ENV_PASS:'ANTHROPIC_API_KEY'});
    const result=await listModels(cfg,'claude',true);
    assert.ok(result.models.some(item=>item.id==='claude-future-2030'),JSON.stringify(result));
    assert.equal(requests.length,0,`No inference or auth request should be made: ${JSON.stringify(requests)}`);
  } finally {
    for(const key of names) if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];
    await new Promise(resolve=>mock.close(resolve));fs.rmSync(home,{recursive:true,force:true});
  }
});
