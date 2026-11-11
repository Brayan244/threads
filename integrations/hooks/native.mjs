// Opt-in native hooks. Rewrite a direct Threads command, never permission policy.
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { encodeNativeContext, IdentityError } from '../../src/threads/identity.mjs';
import { parseJSON } from '../../src/threads/json.mjs';

const profiles={
  'claude-code':{event:'PreToolUse',tools:['Bash'],id:'session_id',output:'updatedInput'},
  'gemini-cli':{event:'BeforeTool',tools:['run_shell_command'],id:'session_id',output:'tool_input'},
  cursor:{event:'preToolUse',tools:['Shell','Bash','run_terminal_cmd'],id:'conversation_id',output:'updated_input'},
};
export const shellQuote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
function directCommand(command,cli) {
  const candidates=['threads',shellQuote(cli),JSON.stringify(cli)];
  if(!/[\s'"\\$`;&|()<>]/.test(cli))candidates.push(cli);
  return candidates.some(prefix=>command===prefix||command.startsWith(prefix)&&/\s/.test(command[prefix.length]??''));
}
export function transformHook(host,payload,cli) {
  const profile=profiles[host];
  if(!profile||typeof cli!=='string'||!isAbsolute(cli))throw new IdentityError('Invalid hook configuration');
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new IdentityError('Invalid hook input');
  if(payload.hook_event_name!==profile.event||!profile.tools.includes(payload.tool_name))return {};
  const input=payload.tool_input,command=typeof input?.command==='string'?input.command.trimStart():null;
  if(command===null||!directCommand(command,cli))return {};
  const value={agent:host,session_id:payload[profile.id],session_ref:payload.transcript_path??null};
  if(host==='claude-code'&&payload.agent_id!==undefined&&payload.agent_id!==null)value.actor_id=payload.agent_id;
  const encoded=encodeNativeContext(value);
  // POSIX assignment applies to this executable only, including heredoc stdin.
  // Subsequent commands and persistent shells do not retain a session identity.
  const rewritten={...input,command:`THREADS_RUNTIME_CONTEXT=${shellQuote(encoded)} ${command}`};
  if(host==='cursor')return {updated_input:rewritten};
  const specific={[profile.output]:rewritten};
  if(host==='claude-code')specific.hookEventName=profile.event;
  return {hookSpecificOutput:specific};
}
export async function main(argv=process.argv.slice(2),{stdin=process.stdin,stdout=process.stdout,stderr=process.stderr}={}) {
  try {
    const {values}=parseArgs({args:argv,options:{host:{type:'string'},cli:{type:'string'}}});
    const chunks=[];let size=0;
    for await(const chunk of stdin){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>262144)throw Error();chunks.push(bytes);}
    const payload=parseJSON(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)));
    stdout.write(JSON.stringify(transformHook(values.host,payload,values.cli))+'\n');return 0;
  }catch{
    stdout.write('{}\n');stderr.write('Threads identity_required: hook context is invalid or unavailable; capture was not confirmed.\n');return 2;
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
