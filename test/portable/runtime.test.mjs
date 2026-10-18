import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {mkHome,baseEnv,startServer,untilDone,argvLog,cleanupHome,FAKE_CODEX} from '../helpers/harness.mjs';
import {createWindowsProcesses} from '../../dist/system/platform/windows.js';
import {probe,signalAll,isGone} from '../../dist/system/platform/index.js';
import {discoverExecutable,resolveExecutable} from '../../dist/system/executables.js';
import {loadConfig} from '../../dist/config/config.js';
import {validateWorkdir,WorkdirError} from '../../dist/security/workspace.js';
import {buildChildEnv} from '../../dist/providers/child-env.js';
import {codexReadDeny} from '../../dist/providers/codex/argv.js';
import {isolateMcp} from '../../dist/providers/codex/mcp-isolation.js';
import {selectionValue} from '../../dist/providers/models.js';
import {binFingerprint,readSandboxRecord,sandboxContext,sandboxRecordPath} from '../../dist/providers/capabilities.js';

test('child CLI keeps Claude global settings in the default profile unless an override was requested',()=>{
  const home=path.resolve('fixture-claude-user-profile');
  const source={HOME:home,USERPROFILE:home,NODE_BIN:process.execPath,CODEX_BIN:FAKE_CODEX};
  const cfg=loadConfig(source);
  const options={target:'claude',jobId:'profile-test',tmpDir:path.join(home,'tmp'),cliBin:null};
  const ordinary=buildChildEnv(cfg,{},options).env;
  assert.equal(Object.hasOwn(ordinary,'CLAUDE_CONFIG_DIR'),false,
    'setting the default directory would move global .claude.json away from its normal location');
  const explicitDefault=buildChildEnv(cfg,{CLAUDE_CONFIG_DIR:cfg.claudeConfigDir},options).env;
  assert.equal(explicitDefault.CLAUDE_CONFIG_DIR,path.join(home,'.claude'));
  const customDirectory=path.join(home,'Custom Claude Profile');
  const customCfg=loadConfig({...source,CLAUDE_CONFIG_DIR:customDirectory});
  const custom=buildChildEnv(customCfg,{},options).env;
  assert.equal(custom.CLAUDE_CONFIG_DIR,customDirectory,
    'a selected custom profile must survive even when the caller environment omits the variable');
});

test('Windows process identity: marker mismatch is dead; access failure and null command line are unknown',()=>{
  const kill=()=>true;
  const fixture=CommandLine=>createWindowsProcesses(()=>({status:0,stdout:JSON.stringify([{ProcessId:4242,ParentProcessId:1,CommandLine}])}),kill);
  assert.equal(fixture('node --clivoxa-job example').probe(4242,'--clivoxa-job example'),'alive');
  assert.equal(fixture('unrelated reused process').probe(4242,'--clivoxa-job example'),'dead');
  assert.equal(fixture(null).probe(4242,'marker'),'unknown');
  assert.equal(createWindowsProcesses(()=>({status:1,stdout:''}),kill).probe(4242,'marker'),'unknown');
});

test('Windows process tree cancellation uses numeric argv and taskkill; force is only the final stage',()=>{
  const calls=[];
  const win=createWindowsProcesses((file,args)=>{calls.push({file,args});return {status:0,stdout:JSON.stringify([{ProcessId:4242,ParentProcessId:1,CommandLine:'root'},{ProcessId:4243,ParentProcessId:4242,CommandLine:'child'}])};},()=>true);
  assert.deepEqual(win.descendants([4242]),[4243]);
  win.signalAll([4242],'SIGTERM');
  assert.deepEqual(calls.at(-1).args,['/PID','4242']);
  win.signalAll([4242],'SIGKILL');
  assert.deepEqual(calls.at(-1).args,['/PID','4242','/F']);
  const count=calls.length;win.signalAll([NaN,-1,process.pid],'SIGKILL');assert.equal(calls.length,count);
});

// Windows reuses pids and keeps a dead parent's id: an older process naming the job as its parent is not its child.
test('Windows tree walk skips processes older than the parent they name (recycled pid)',()=>{
  const rows=[
    {ProcessId:4242,ParentProcessId:1,CommandLine:'job',Created:5000},
    {ProcessId:4243,ParentProcessId:4242,CommandLine:'real child',Created:6000},
    {ProcessId:4300,ParentProcessId:4242,CommandLine:'orphan of an earlier 4242',Created:1000},
    {ProcessId:4301,ParentProcessId:4300,CommandLine:'its child',Created:1200},
    {ProcessId:4244,ParentProcessId:4243,CommandLine:'grandchild',Created:null},
  ];
  const win=createWindowsProcesses(()=>({status:0,stdout:JSON.stringify(rows)}),()=>true);
  assert.deepEqual(win.descendants([4242]).sort(),[4243,4244]);
});

test('Windows ancestry stops only at a proven foreign owner with an inaccessible command line',()=>{
  const currentSid='S-1-5-21-100-200-300-1001';
  const parent=process.ppid;
  const ancestor=parent+1_000_000;
  const ancestry=(OwnerSid)=>createWindowsProcesses(()=>({status:0,stdout:JSON.stringify({CurrentSid:currentSid,Processes:[
    {ProcessId:parent,ParentProcessId:ancestor,CommandLine:'host --normal'},
    {ProcessId:ancestor,ParentProcessId:0,CommandLine:null,...(OwnerSid===undefined?{}:{OwnerSid})},
  ]})}),()=>true).ancestorCommands();
  assert.deepEqual(ancestry('S-1-5-18'),['host --normal']);
  assert.equal(ancestry(currentSid),null);
  assert.equal(ancestry(undefined),null);
  assert.equal(ancestry(''),null);
  assert.equal(ancestry('untrusted-owner'),null);
});

test('Windows ancestry ends at the services session but stays fail-closed inside the user session',()=>{
  const currentSid='S-1-5-21-100-200-300-1001';
  const parent=process.ppid;
  // node <- codex.exe <- ChatGPT.exe (MSIX) <- sihost.exe <- svchost.exe (session 0)
  const ancestry=(chain,currentSession=1)=>{
    const ids=chain.map((_,i)=>i===0?parent:parent+1_000_000+i);
    const Processes=chain.map((row,i)=>({ProcessId:ids[i],ParentProcessId:ids[i+1]??0,...row}));
    return createWindowsProcesses(()=>({status:0,stdout:JSON.stringify({CurrentSid:currentSid,
      ...(currentSession===null?{}:{CurrentSessionId:currentSession}),Processes})}),()=>true).ancestorCommands();
  };
  const user=[{CommandLine:'codex.exe',SessionId:1},{CommandLine:'ChatGPT.exe',SessionId:1},{CommandLine:'sihost.exe',SessionId:1}];
  const service={CommandLine:null,SessionId:0};
  assert.deepEqual(ancestry([...user,service,{CommandLine:null,SessionId:0}]),['codex.exe','ChatGPT.exe','sihost.exe']);
  assert.match(ancestry([...user,{CommandLine:'node --clivoxa-runner',SessionId:0}]).join('\n'),/--clivoxa-runner/,
    'a readable session-0 ancestor is still inspected');
  assert.equal(ancestry([...user,{CommandLine:null,SessionId:1},service]),null,
    'an unreadable same-session ancestor (e.g. elevated) still fails closed');
  assert.equal(ancestry([...user,service],0),null,'a process in session 0 itself gets no boundary');
  assert.equal(ancestry([...user,service],null),null,'an unknown current session gets no boundary');
  assert.equal(createWindowsProcesses(()=>({status:0,stdout:JSON.stringify({CurrentSid:currentSid,CurrentSessionId:1,
    Processes:[{ProcessId:parent,ParentProcessId:0,CommandLine:'x',SessionId:'0'}]})}),()=>true).ancestorCommands(),null,
    'malformed session ids are rejected');
  // Only the shell may hand a user branch over to a service: anything else could launder a sub-agent.
  const explorer=[{CommandLine:'cmd.exe /c x.cmd',SessionId:1},{CommandLine:'C:\\WINDOWS\\explorer.exe /factory,{75dff2b7} -Embedding',SessionId:1}];
  assert.deepEqual(ancestry([...explorer,service]),['cmd.exe /c x.cmd','C:\\WINDOWS\\explorer.exe /factory,{75dff2b7} -Embedding']);
  assert.ok(ancestry([{CommandLine:'node x',SessionId:1},{CommandLine:'"C:\\Windows\\System32\\sihost.exe"',SessionId:1},service]));
  // Windows 11 default terminal: a new tab's shell under a COM-activated Windows Terminal.
  const wt='"C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.21.0_x64__8wekyb3d8bbwe\\WindowsTerminal.exe" -Embedding';
  assert.deepEqual(ancestry([{CommandLine:'claude.exe',SessionId:1},{CommandLine:'pwsh.exe',SessionId:1},{CommandLine:wt,SessionId:1},service]),['claude.exe','pwsh.exe',wt]);
  assert.equal(ancestry([{CommandLine:'node x',SessionId:1},{CommandLine:'taskhostw.exe',SessionId:1},service]),null,'Task Scheduler');
  assert.equal(ancestry([{CommandLine:'cmd.exe /c node x',SessionId:1},service]),null,'WMI Win32_Process.Create');
  assert.equal(ancestry([service]),null,'a direct service parent');
  assert.equal(ancestry([{CommandLine:'C:\\tools\\explorer.exe.bak x',SessionId:1},service]),null,'the file name must match exactly');
});

test('native process probe and cancellation work on the current OS',async()=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','--','--clivoxa-job','portable-marker'],{stdio:'ignore',windowsHide:true});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  try {
    assert.equal(probe(child.pid,'--clivoxa-job portable-marker'),'alive');
    assert.equal(probe(child.pid,'another-job'),'dead');
    const closed=new Promise(resolve=>child.once('close',resolve));
    signalAll([child.pid],'SIGKILL');await closed;
    assert.equal(isGone(child.pid),true);
  } finally {if(!isGone(child.pid)) child.kill('SIGKILL');}
});

test('automatic executable discovery supports a directory with spaces; explicit config wins',()=>{
  const h=mkHome();
  try {
    const bin=path.join(h.home,'bin with spaces');fs.mkdirSync(bin);
    const file=path.join(bin,process.platform==='win32'?'codex.cmd':'codex');
    if(process.platform==='win32') {
      const target=path.join(bin,'node_modules','fixture','cli.js');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'#!/usr/bin/env node\nconsole.log("fixture");');
      fs.writeFileSync(path.join(bin,'node.exe'),'interpreter fixture');
      fs.writeFileSync(file,'@ECHO off\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n)\n"%_prog%" "%dp0%\\node_modules\\fixture\\cli.js" %*\n');
      assert.equal(discoverExecutable('codex',{Path:bin},h.home),target);
      assert.equal(resolveExecutable(file),target,'npm interpreter is not the CLI entrypoint');
    } else {
      fs.writeFileSync(file,'#!/usr/bin/env node\nconsole.log("fixture");',{mode:0o700});
      assert.equal(discoverExecutable('codex',{PATH:bin},h.home),file);
    }
    const cfg=loadConfig({HOME:h.home,PATH:bin,CODEX_BIN:FAKE_CODEX});
    assert.equal(cfg.bins.codex,FAKE_CODEX);
    const unsafe=path.join(bin,'unsafe.cmd');fs.writeFileSync(unsafe,'@echo off\nmalicious-command');
    assert.equal(resolveExecutable(unsafe,'win32'),null);
  } finally {cleanupHome(h);}
});

test('permission deny paths keep the parent protection without overlapping child mounts',()=>{
  const h=mkHome();
  try {
    const cfg=loadConfig({HOME:h.home,CLIVOXA_HOME:h.clivoxa});
    const deny=codexReadDeny(cfg);
    assert.ok(deny.includes(path.join(h.home,'.docker')));
    assert.ok(!deny.includes(path.join(h.home,'.docker','config.json')));
    for(const p of deny) assert.ok(!deny.some(parent=>parent!==p&&p.startsWith(parent+path.sep)),p);
  } finally {cleanupHome(h);}
});

test('Windows sandbox verification expires when provisioned setup state is removed or replaced',{skip:process.platform!=='win32'?'Native Windows setup state only':false},()=>{
  const h=mkHome();
  try {
    const codexHome=path.join(h.home,'.codex');
    const cfg=loadConfig({HOME:h.home,CLIVOXA_HOME:h.clivoxa,CODEX_HOME:codexHome,CODEX_BIN:FAKE_CODEX});
    const files=[path.join(codexHome,'.sandbox','setup_marker.json'),path.join(codexHome,'.sandbox-secrets','sandbox_users.json')];
    for(const file of files) {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'synthetic setup fixture');}
    const capsDir=path.join(h.clivoxa,'caps');fs.mkdirSync(capsDir,{recursive:true});
    const fp=binFingerprint(FAKE_CODEX);assert.ok(fp);
    const cacheFile=sandboxRecordPath(capsDir,fp);
    for(const file of files) {
      const record={fp,version:'fixture',at:Date.now(),context:sandboxContext(cfg),profiles_verified:{ro:true,rw:true,rw_git:true,rw_net:true},details:{}};
      fs.writeFileSync(cacheFile,JSON.stringify(record));
      assert.deepEqual(readSandboxRecord(cfg,capsDir),record,'successful verification is initially reusable');
      fs.unlinkSync(file);
      assert.equal(readSandboxRecord(cfg,capsDir),null,`removed ${path.basename(file)} invalidates success`);
      fs.writeFileSync(file,'replacement synthetic setup fixture with a different size');
      assert.equal(readSandboxRecord(cfg,capsDir),null,`replaced ${path.basename(file)} invalidates success`);
    }
  } finally {cleanupHome(h);}
});

for(const role of ['codex','claude']) test(`${role}: MCP discovers and invokes a future model and effort without a bridge update`,async()=>{
  const h=mkHome();
  const id='new-family-2030';const effort='future-effort';
  const model=role==='codex'?{model:id,displayName:id,isDefault:true,supportedReasoningEfforts:[{reasoningEffort:effort}]}:{value:id,displayName:id,supportedEffortLevels:[effort]};
  const server=await startServer(h,role,{FAKE_MODELS:JSON.stringify([model]),CLIVOXA_CHILD_ENV_PASS:'FAKE_MODELS,FAKE_ARGV_LOG'});
  try {
    const listing=await server.call('list_models',{refresh:true});
    assert.equal(listing.isError,false,listing.text);
    const catalogue=JSON.parse(listing.text);assert.equal(catalogue.models[0].id,id);assert.deepEqual(catalogue.models[0].efforts,[effort]);
    assert.equal(catalogue.sourceFreshness,'unknown');assert.equal(catalogue.accessVerified,false);
    const answer=await server.call(`ask_${role}`,{prompt:'normal portable request',model:id,effort,wait_seconds:30});
    const result=answer.h.status==='running'?await untilDone(server,answer.h.job_id):answer;
    assert.equal(result.h.status,'done',result.text);
    const request=JSON.parse(fs.readFileSync(path.join(result.h.job_dir,'request.json'),'utf8'));
    assert.equal(request.model,id);assert.equal(request.effort,effort);
    assert.equal(request.target,role,'persisted like job ids');
    const invoked=argvLog(h).filter(row=>row.argv.includes('exec')||row.argv.includes('-p')).at(-1);
    assert.ok(invoked.argv.includes(id));
    const rejected=await server.call(`ask_${role}`,{prompt:'invalid effort',model:id,effort:'unsupported',wait_seconds:0});
    assert.equal(rejected.isError,true,rejected.text);
    assert.match(rejected.text,/future-effort/);
  } finally {await server.close();cleanupHome(h);}
});

test('model safety accepts new families and rejects argument/control injection',()=>{
  const cfg=loadConfig({});
  for(const value of ['future-model','provider/model:2030','new-alias[1m]']) assert.equal(selectionValue(value),true);
  for(const value of ['--settings','model\nnext','nul\0byte',' model','']) assert.equal(selectionValue(value),false);
});

test('MCP cancellation is cooperative and records a terminal result on the current OS',async()=>{
  const h=mkHome();const server=await startServer(h,'claude');
  try {
    const job=await server.call('ask_claude',{prompt:'[[FAKE:sleep=30]]',wait_seconds:0});
    assert.ok(job.h.job_id,job.text);
    await server.call('cancel_job',{job_id:job.h.job_id});
    const result=await untilDone(server,job.h.job_id,20_000);
    assert.equal(result.h.status,'error',result.text);assert.equal(result.h.error_kind,'cancelled',result.text);
  } finally {await server.close();cleanupHome(h);}
});

for(const role of ['codex','claude']) test(`${role}: native project paths, write lifecycle and protected-file restoration`,async()=>{
  const h=mkHome({git:true});
  fs.writeFileSync(path.join(h.proj,'AGENTS.md'),'original instructions');
  const server=await startServer(h,role);
  try {
    const answer=await server.call(`ask_${role}`,{prompt:'[[FAKE:write_file=portable.txt]] [[FAKE:plant=AGENTS.md]]',workdir:h.proj,access:'write',wait_seconds:30});
    const result=answer.h.status==='running'?await untilDone(server,answer.h.job_id):answer;
    assert.equal(result.h.status,'done',result.text);
    assert.ok(fs.existsSync(path.join(h.proj,'portable.txt')));
    assert.equal(fs.readFileSync(path.join(h.proj,'AGENTS.md'),'utf8'),'original instructions');
    const meta=JSON.parse(fs.readFileSync(path.join(result.h.job_dir,'meta.json'),'utf8'));
    const restored=meta.protected.items.find(item=>item.path==='AGENTS.md');
    assert.equal(restored.action,'reverted');
    assert.ok(restored.saved_as&&!restored.saved_as.includes('\\'),'relative archive paths use /');
  } finally {await server.close();cleanupHome(h);}
});

test('workdir takes the config ~ forms: ~/ and ~\\ resolve to HOME and every later check still applies',()=>{
  const h=mkHome();
  try {
    const cfg=loadConfig({HOME:h.home,CLIVOXA_HOME:h.clivoxa});
    const install=path.join(h.home,'no-install');
    for(const input of ['~/proj','~\\proj',' ~\\proj ']) assert.equal(validateWorkdir(cfg,input,'read',install).real,h.proj,input);
    for(const input of ['~','~\\','~proj','~\\missing']) assert.throws(()=>validateWorkdir(cfg,input,'read',install),WorkdirError,input);
    fs.mkdirSync(path.join(h.home,'.ssh','k'),{recursive:true});
    // Only Windows splits on '\'; on POSIX '.ssh\k' is one missing name and is refused for that reason.
    assert.throws(()=>validateWorkdir(cfg,'~\\.ssh\\k','read',install),e=>e instanceof WorkdirError&&(process.platform!=='win32'||/~\/\.ssh/.test(e.message)));
  } finally {cleanupHome(h);}
});

test('MCP isolation cache never reuses an override built under the other user-server policy',()=>{
  const h=mkHome();
  try {
    const run=(caps,extra)=>{const env=baseEnv(h,'codex',{FAKE_CODEX_SERVERS:'kopru,github',...extra});return isolateMcp(loadConfig(env),path.join(h.clivoxa,caps),env,h.proj,null);};
    const lists=()=>argvLog(h).filter(e=>e.cli==='codex'&&e.argv.includes('list')).length;
    const keep=run('caps',{CLIVOXA_CODEX_USER_MCP:'keep'});
    assert.deepEqual(keep.names,['clivoxa','kopru'],JSON.stringify(keep));
    const off=run('caps',{});
    assert.deepEqual(off.names,['clivoxa','kopru','github'],`the default off policy must not reuse a keep-mode cache: ${JSON.stringify(off)}`);
    assert.match(off.override,/github=\{enabled=false\}/);
    const spawned=lists();
    assert.deepEqual(run('caps',{CLIVOXA_CODEX_USER_MCP:'keep'}).names,['clivoxa','kopru']);
    assert.deepEqual(run('caps',{}).names,['clivoxa','kopru','github']);
    assert.equal(lists(),spawned,'each policy still reuses its own record');
    // Reverse order on an empty cache: keep must not inherit the off record either.
    assert.deepEqual(run('caps-reverse',{}).names,['clivoxa','kopru','github']);
    const keepAfterOff=run('caps-reverse',{CLIVOXA_CODEX_USER_MCP:'keep'});
    assert.deepEqual(keepAfterOff.names,['clivoxa','kopru'],`keep must not reuse an off-mode cache: ${JSON.stringify(keepAfterOff)}`);
  } finally {cleanupHome(h);}
});

test('Windows: provider profiles follow USERPROFILE like the CLIs do, while HOME stays protected',()=>{
  const profile=path.resolve('fixture-windows-user-profile');
  const shellHome=path.resolve('fixture-shell-home');
  const cfg=loadConfig({HOME:shellHome,USERPROFILE:profile,NODE_BIN:process.execPath,CODEX_BIN:FAKE_CODEX});
  // Node's os.homedir() (Claude Code) and Codex ignore HOME only on Windows.
  const cliHome=process.platform==='win32'?profile:shellHome;
  assert.equal(cfg.codexHome,path.join(cliHome,'.codex'));
  assert.equal(cfg.claudeConfigDir,path.join(cliHome,'.claude'));
  const env=buildChildEnv(cfg,{USERPROFILE:profile},{target:'codex',jobId:'profile-test',tmpDir:path.join(profile,'tmp'),cliBin:null}).env;
  assert.equal(env.CODEX_HOME,path.join(cliHome,'.codex'),'the consulted Codex must find its own login and settings');
  assert.equal(Object.hasOwn(env,'CLAUDE_CONFIG_DIR'),false,'the default profile must not relocate .claude.json');
  assert.equal(env.HOME,shellHome);
  assert.ok(codexReadDeny(cfg).includes(path.join(shellHome,'.ssh')),'secrets under HOME stay denied');
});
