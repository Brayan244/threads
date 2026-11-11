#!/usr/bin/env node
// Emit an inspectable opt-in plan. Never write host settings, skills or hooks.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { absolute, calledAsMain } from './install.mjs';
import { shellQuote } from '../integrations/hooks/native.mjs';
const supported=new Set(['claude-code','gemini-cli','cursor','opencode']);
export function hostConfiguration(host,home) {
  if(!supported.has(host))throw Error('Unknown host');home=absolute(home);
  const runtime=join(home,'.local/share/threads-runtime'),cli=join(home,'.local/bin/threads');
  const skillHome={
    'claude-code':'.claude/skills', 'gemini-cli':'.gemini/skills', cursor:'.cursor/skills', opencode:'.config/opencode/skills',
  };
  const result={host,applied:false,validation:'protocol_fixtures_only',
    skill:{source:join(home,'.agents/skills/threads'),target:join(home,skillHome[host],'threads')},
    command_policy:'Hook hosts use one direct threads --require-native-context COMMAND per shell call; no pipelines. Normal permission checks remain in force.',
    instructions:['Inspect every emitted path and command.','Append hook entries to existing settings; never replace unrelated configuration.','Preserve occupied discovery filenames; ask the owner before changing them.','Copy the skill with its references only after approval; custom resource-root overrides require manual placement.','Verify the real host before claiming native compatibility.'],
  };
  if(host==='opencode'){
    const factory=pathToFileURL(join(runtime,'integrations/opencode/tools.mjs')).href;
    result.entry={path:join(home,'.config/opencode/tools/threads.ts'),content:
      '// Threads native tools; inspect before placing in the discovery directory.\n'+
      'import { tool } from "@opencode-ai/plugin";\n'+
      `import { createOpenCodeTools } from ${JSON.stringify(factory)};\n`+
      'const tools = createOpenCodeTools(tool);\n'+
      ['current','search','list','show','record','associate'].map(name=>`export const ${name} = tools.${name};`).join('\n')+'\n'};
    result.command_policy='Use the threads_* custom tools; sessionID is read from every execution callback. Restart/reload OpenCode after changing the entry.';
  }else{
    const command='node '+shellQuote(join(runtime,'integrations/hooks/native.mjs'))+' --host '+shellQuote(host)+' --cli '+shellQuote(cli);
    const event=host==='claude-code'?'PreToolUse':host==='gemini-cli'?'BeforeTool':'preToolUse';
    const matcher=host==='claude-code'?'Bash':host==='gemini-cli'?'run_shell_command':'Shell|Bash|run_terminal_cmd';
    const handler={type:'command',command,timeout:host==='gemini-cli'?5000:5};
    const merge=host==='cursor'?{version:1,hooks:{[event]:[{command,matcher,timeout:5}]}}:
      {hooks:{[event]:[{matcher,hooks:[handler]}]}};
    const location=host==='claude-code'?'.claude/settings.json':host==='gemini-cli'?'.gemini/settings.json':'.cursor/hooks.json';
    result.settings={path:join(home,location),merge};
    if(host==='cursor')result.instructions.push('Requires a Cursor version accepting preToolUse.updated_input for native shell tools. This contract has not been verified in a live Cursor host.');
  }
  return result;
}
export function main(argv=process.argv.slice(2)) {
  try {
    const {values}=parseArgs({args:argv,options:{host:{type:'string'},home:{type:'string'}}});
    console.log(JSON.stringify({ok:true,result:hostConfiguration(values.host,values.home)}));return 0;
  }catch{console.log(JSON.stringify({ok:false,error:'Choose a supported --host and explicit absolute --home. No configuration was changed.'}));return 2;}
}
if(calledAsMain(import.meta.url))process.exitCode=main();
