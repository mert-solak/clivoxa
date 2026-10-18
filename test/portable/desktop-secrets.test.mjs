import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {mkHome,cleanupHome} from '../helpers/harness.mjs';
import {loadConfig} from '../../dist/config/config.js';
import {codexReadDeny} from '../../dist/providers/codex/argv.js';
import {buildClaudeSettings,claudeReadDeny} from '../../dist/providers/claude/argv.js';
import {within} from '../../dist/system/paths.js';

/** `Read(//c/...)` rule form of an absolute Windows path (providers/claude/argv.ts). */
const ruleForm=(abs)=>'Read(/'+abs.replace(/\\/g,'/').replace(/^([A-Za-z]):\//,(_,drive)=>'/'+drive.toLowerCase()+'/');

test('packaged and moved Claude Desktop profiles are read-denied like the classic profile',{skip:process.platform!=='win32'?'Packaged Claude Desktop exists on Windows only':false},()=>{
  const h=mkHome();
  try {
    const local=path.join(h.home,'AppData','Local');
    // A LOCALAPPDATA away from HOME\AppData\Local is reached by the variable alone, never by a home-relative rule.
    const relocated=path.join(h.home,'Relocated Local');
    // Exactly the profiles setup registers (setup/host-config.ts), plus a secret another CLI wrote inside the package.
    const profiles=(root)=>[
      path.join(root,'Packages','Claude_pzs8sxrjxfjjc','LocalCache','Roaming','Claude','claude_desktop_config.json'),
      path.join(root,'Packages','AnthropicPBC.Claude_abcdefghjkmnp','LocalCache','Roaming','Claude','claude_desktop_config.json'),
      path.join(root,'Claude-Data','claude_pzs8sxrjxfjjc','claude_desktop_config.json'),
      path.join(root,'Packages','Claude_pzs8sxrjxfjjc','LocalCache','Roaming','GitHub CLI','hosts.yml'),
    ];
    const unrelated=path.join(local,'Packages','Microsoft.WindowsTerminal_8wekyb3d8bbwe','LocalState','settings.json');
    for(const file of [...profiles(local),...profiles(relocated),unrelated]) {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{"synthetic":true}');}
    const base={HOME:h.home,USERPROFILE:h.home,CLIVOXA_HOME:h.clivoxa};
    for(const [source,secrets] of [[{...base,LOCALAPPDATA:local},profiles(local)],[base,profiles(local)],[{...base,LOCALAPPDATA:relocated},[...profiles(local),...profiles(relocated)]]]) {
      const cfg=loadConfig(source);
      const codex=codexReadDeny(cfg);
      const settings=buildClaudeSettings(cfg,{mode:'new',sessionId:'s',access:'read',shell:true,web:'off',network:false,gitWrite:false,
        cwd:h.proj,tmpDir:path.join(h.clivoxa,'tmp'),model:'',effort:'',jobId:'desktop-secrets',agent:false,gitDirs:[],userDeny:[]});
      const rules=claudeReadDeny(cfg).filter(rule=>rule.endsWith('/**)')).map(rule=>rule.slice(0,-'/**)'.length).toLowerCase());
      for(const file of secrets) {
        assert.ok(codex.some(root=>within(file,root)),`clivoxa_ro must deny ${file}`);
        assert.ok(settings.sandbox.filesystem.denyRead.some(root=>within(file,root)),`Claude sandbox must deny ${file}`);
        assert.ok(rules.some(rule=>ruleForm(file).toLowerCase().startsWith(rule+'/')),`Claude Read rules must deny ${file}`);
      }
      assert.ok(!codex.some(root=>within(unrelated,root)),'other packages are not part of the Desktop profile');
    }
    // A Packages that cannot be listed is denied whole (fail closed); a file there fails the listing with ENOTDIR.
    const unlisted=path.join(h.home,'Unlisted Local');
    fs.mkdirSync(unlisted,{recursive:true});fs.writeFileSync(path.join(unlisted,'Packages'),'not a directory');
    const closed=loadConfig({...base,LOCALAPPDATA:unlisted});
    assert.ok(codexReadDeny(closed).some(root=>within(path.join(unlisted,'Packages'),root)),'an unlistable Packages is denied whole');
  } finally {cleanupHome(h);}
});
