import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { startMockMessages } from './mock-models.mjs';

const dist = new URL('../../dist/', import.meta.url);
const imp = name => import(new URL(name, dist));
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const bashPath = value => process.platform === 'win32' ? value.replace(/\\/g,'/').replace(/^([A-Za-z]):\//,(_,drive)=>'/'+drive.toLowerCase()+'/') : value;

/** Positive and negative file probes, using the actual production Claude argv and local model. */
export async function verifyClaudeSandbox({cfg, mutateSettings, writeRecord=true, debug=false}) {
  const {buildClaudeArgv,buildClaudeSettings,writeClaudeSettings} = await imp('providers/claude/argv.js');
  const {buildChildEnv,resolveLaunch} = await imp('providers/child-env.js');
  const {binFingerprint,sandboxContext} = await imp('providers/capabilities.js');
  const {writeJsonAtomic,privateTemporaryDirectory} = await imp('system/fs.js');
  const {systemEnvironment} = await imp('system/platform/index.js');
  const tag = randomUUID();
  const base = privateTemporaryDirectory('cv-v-');
  fs.mkdirSync(base,{recursive:true,mode:0o700});
  const canary = path.join(base,'outside.txt');
  const secret = `CLIVOXA-CANARY-${tag}`;
  fs.writeFileSync(canary,secret,{mode:0o600});
  const outcomes={read:false,write:false};
  const details={};
  let steps=[];
  const mock = await startMockMessages(({body}) => {
    const turn=(body?.messages??[]).filter(message=>message.role==='assistant').length;
    return turn < steps.length ? {toolUse:steps[turn]} : {text:'local verification complete'};
  });
  try {
    for (const access of ['read','write']) {
      const cwd=path.join(base,access);
      const tmp=path.join(base,access+'-tmp');
      fs.mkdirSync(cwd,{mode:0o700});fs.mkdirSync(tmp,{mode:0o700});
      fs.writeFileSync(path.join(cwd,'positive.txt'),`POSITIVE-${tag}`);
      const code=`const fs=require('node:fs');const test=(p,v)=>{try{fs.mkdirSync(require('node:path').dirname(p),{recursive:true});fs.writeFileSync(p,v);console.log('wrote:'+p);}catch{}};test('ok.txt','ok');test(${JSON.stringify(path.join(base,'escape.txt'))},'escape');test('AGENTS.md','injected');test('.codex/config.toml','injected');try{console.log(fs.readFileSync(${JSON.stringify(canary)},'utf8'));}catch{};`;
      const probeFile=path.join(cwd,'probe.cjs');
      fs.writeFileSync(probeFile,code,{mode:0o600});
      const command=quote(bashPath(cfg.bins.node))+' '+quote(bashPath(probeFile));
      steps=[
        {name:'Read',input:{file_path:path.join(cwd,'positive.txt')}},
        {name:'Read',input:{file_path:canary}},
        {name:'Bash',input:{command,description:'Local sandbox verification'}},
        {name:'Write',input:{file_path:path.join(cwd,'AGENTS.md'),content:'injected'}},
      ];
      const cfgV={...cfg,claudeConfigDir:path.join(base,'config'),childEnvPass:['ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']};
      const source={...systemEnvironment(),HOME:cfg.userHome,PATH:cfg.userPath,LANG:'C.UTF-8',NO_PROXY:'127.0.0.1,localhost',CLAUDE_CONFIG_DIR:cfgV.claudeConfigDir,ANTHROPIC_API_KEY:'clivoxa-local-dummy-key',ANTHROPIC_BASE_URL:mock.baseUrl,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
      const {env}=buildChildEnv(cfgV,source,{target:'claude',jobId:`verify-${tag}`,tmpDir:tmp,cliBin:cfg.bins.claude});
      const rulePath=canary.replace(/\\/g,'/').replace(/^([A-Za-z]):\//,(_,drive)=>'/'+drive.toLowerCase()+'/');
      // Settings travel in a file, as in jobs; outside cwd and TMPDIR, so the probe cannot rewrite them.
      const input={mode:'new',sessionId:randomUUID(),access,shell:true,web:'off',network:false,gitWrite:false,cwd,tmpDir:tmp,model:'',effort:'',jobId:tag,agent:false,gitDirs:[],userDeny:[`Read(/${rulePath})`],settingsFile:path.join(base,`settings-${access}.json`)};
      const argv=buildClaudeArgv(input);
      let settings=buildClaudeSettings(cfgV,input);
      settings.sandbox.filesystem.denyRead.push(canary);
      if(mutateSettings) settings=mutateSettings(access,settings);
      writeClaudeSettings(input.settingsFile,settings);
      const launch=resolveLaunch(cfgV,cfgV.bins.claude);
      const start=mock.requests.length;
      const result=await new Promise(resolve=>{
        const child=spawn(launch.cmd,[...launch.pre,...argv],{env,cwd,windowsHide:true,stdio:'pipe'});
        let output='';let stderr='';let size=0;
        const timeout=setTimeout(()=>child.kill('SIGKILL'),90_000);
        child.stdout.on('data',chunk=>{size+=chunk.length;if(size<=2*1024*1024)output+=chunk;else child.kill('SIGKILL');});
        child.stderr.on('data',chunk=>{size+=chunk.length;if(size<=2*1024*1024)stderr+=chunk;else child.kill('SIGKILL');});
        child.on('error',()=>{clearTimeout(timeout);resolve({code:127,output,stderr:'CLI spawn failed'});});
        child.on('close',code=>{clearTimeout(timeout);resolve({code,output,stderr});});
        child.stdin.on('error',()=>{});
        child.stdin.end('Run the local verification steps.');
      });
      const outputs=mock.requests.slice(start).flatMap(request=>(request.body?.messages??[]).filter(message=>message.role==='user').flatMap(message=>Array.isArray(message.content)?message.content.filter(item=>item.type==='tool_result'):[]));
      const data=JSON.stringify(outputs);
      const checks={
        completed:result.code===0,
        positive_read:data.includes(`POSITIVE-${tag}`),
        secret_denied:!data.includes(secret),
        outside_denied:!fs.existsSync(path.join(base,'escape.txt')),
        protected_denied:!fs.existsSync(path.join(cwd,'AGENTS.md'))&&!fs.existsSync(path.join(cwd,'.codex','config.toml')),
        write:fs.existsSync(path.join(cwd,'ok.txt'))===(access==='write'),
      };
      const failed=Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name);
      if(debug) console.error(JSON.stringify({access,checks,outputs}));
      outcomes[access]=failed.length===0;
      // This isolated probe contains only synthetic prompts, a dummy key and a
      // loopback endpoint. Preserve its bounded startup diagnostic for doctor.
      const diagnostic=result.stderr.replace(/\x1b\[[0-9;]*m/g,'').trim().slice(0,600);
      details[access]=failed.length?`Failed: ${failed.join(', ')}${diagnostic?' — '+diagnostic:''}`:'ok';
    }
  } finally { await mock.close(); fs.rmSync(base,{recursive:true,force:true}); }
  const record={fp:binFingerprint(cfg.bins.claude),context:sandboxContext(cfg),at:Date.now(),settings:'file',...outcomes,details};
  if(writeRecord) { fs.mkdirSync(path.join(cfg.home,'caps'),{recursive:true,mode:0o700}); writeJsonAtomic(path.join(cfg.home,'caps',`claude-sandbox-${record.fp}.json`),record); }
  return record;
}
