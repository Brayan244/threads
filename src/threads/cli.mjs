// Bounded JSON/argv contract v1. No shell, network, implicit thread or transcript import.
import { RecordDraft, ExternalReference, ValidationError, ConflictError, NotFoundError, StorageError, StoreBusyError } from './domain.mjs';
import { resolveOrigin, IdentityError } from './identity.mjs';
import { parseJSON, stringify } from './json.mjs';
import { MIN_NODE, supportedNode } from './runtime.mjs';
export const CONTRACT_VERSION=1, MAX_INPUT_BYTES=65536;
class InputError extends Error {}
class ArgumentsError extends Error {}
const HELP=`Invocation: threads [--data-dir ABS] [--busy-timeout-ms 1..60000]
  [--pi-session-id UUID --pi-session-ref ABS_FILE] COMMAND [OPTIONS]
Requires Node ${MIN_NODE}+. Pi supplies fresh SessionManager argv; Codex uses this
shell's CODEX_THREAD_ID and CODEX_HOME. Semantic JSON must never contain origin.
record: stdin RecordDraft without origin. Null/omitted thread_id creates with content.
associate: stdin {thread_id,operation_key}; current: this runtime's binding or null.
Old retries return the original receipt, not proof of the current binding.
list [--limit 1..100] [--before-sequence N] [--current-session]
  [--reference-kind issue|pr|session --reference TEXT] [--include-references]
show THREAD_ID [--limit 1..200] [--before-sequence N] [--include-origin] [--include-references]
events THREAD_ID [--limit 1..200] [--after-sequence N] [--include-origin] [--include-references]
sessions THREAD_ID [--limit 1..200] [--after-sequence N]
List/show are newest first; events/sessions oldest first. Cursors are independent.
Origins and issue/PR/session references are omitted unless explicitly requested.
Evidence/review/validation stay with events. Viewing never establishes approval.
Response: one JSON object on stdout; stderr empty. Only exit 0 with ok:true confirms
success. contract_version:1; result or error:{code,message,retryable}.
Exit: 0 success, 2 invalid input/identity, 3 conflict, 4 not found, 5 busy, 6 storage.
Only busy is retryable. Reuse identical payload and operation_key on uncertain retry.
No pager, transcript import, links opened, network, unbounded export or auto-thread.`;
function integer(value,maximum,minimum=0) {
  // Match argparse's decimal integer syntax, including signs and digit separators.
  const normalized=value.trim();
  if(!/^[+-]?\d(?:_?\d)*$/.test(normalized))throw new ArgumentsError();
  const number=BigInt(normalized.replaceAll('_',''));
  if(number<BigInt(minimum)||number>BigInt(maximum))throw new ArgumentsError();
  return number<=BigInt(Number.MAX_SAFE_INTEGER)?Number(number):number;
}
function parseArguments(argv) {
  const args={help:false,data_dir:undefined,busy_timeout_ms:5000,pi_session_id:undefined,pi_session_ref:undefined,
    command:null,limit:50,before_sequence:null,after_sequence:0,current_session:false,reference_kind:null,reference:null,include_references:false,include_origin:false};
  const globals=new Set(['--data-dir','--busy-timeout-ms','--pi-session-id','--pi-session-ref']);
  const commands=new Set(['record','associate','current','list','show','events','sessions']);
  for(let i=0;i<argv.length;i++) {
    const token=argv[i],equal=token.indexOf('='),flag=equal<0?token:token.slice(0,equal);
    if(!args.command&&token==='--help'){args.help=true;continue;}
    if(!args.command&&commands.has(token)){args.command=token;args.limit=token==='show'?10:50;continue;}
    const options=args.command===null?globals:args.command==='list'?new Set(['--limit','--before-sequence','--current-session','--reference-kind','--reference','--include-references']):
      ['show','events','sessions'].includes(args.command)?new Set(['--limit',args.command==='show'?'--before-sequence':'--after-sequence',...(args.command==='sessions'?[]:['--include-origin','--include-references'])]):new Set();
    if(options.has(flag)) {
      const key=flag.slice(2).replaceAll('-','_');
      if(['current_session','include_references','include_origin'].includes(key)){if(equal>=0)throw new ArgumentsError();args[key]=true;continue;}
      const value=equal>=0?token.slice(equal+1):argv[++i];
      if(value===undefined||value.startsWith('--'))throw new ArgumentsError();
      args[key]=key==='limit'?integer(value,args.command==='list'?100:200,1):key==='busy_timeout_ms'?integer(value,60000,1):
        ['before_sequence','after_sequence'].includes(key)?integer(value,9223372036854775807n):value;
      if(key==='reference_kind'&&!['issue','pr','session'].includes(value))throw new ArgumentsError();
      continue;
    }
    if(['show','events','sessions'].includes(args.command)&&args.thread_id===undefined&&!token.startsWith('-')){args.thread_id=token;continue;}
    throw new ArgumentsError();
  }
  if(!args.help&&!args.command||['show','events','sessions'].includes(args.command)&&args.thread_id===undefined)throw new ArgumentsError();
  return args;
}
async function input(stream,required) {
  const chunks=[];let size=0;
  if(!stream.isTTY)for await(const chunk of stream){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=buffer.length;if(size>MAX_INPUT_BYTES)throw new InputError();chunks.push(buffer);}
  const raw=Buffer.concat(chunks);
  if(!required){if(raw.some(byte=>![9,10,11,12,13,32].includes(byte)))throw new InputError();return null;}
  try {
    const value=parseJSON(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw));
    if(!value||typeof value!=='object'||Array.isArray(value))throw new InputError();
    return value;
  } catch {throw new InputError();}
}
const next=(page,limit,field)=>page.length===limit?page.at(-1)[field]:null;
function event(value,args){const result={...value};if(!args.include_origin)delete result.origin;if(!args.include_references)delete result.references;return result;}
function snapshot(value,args,store){const result={...value,session_count:store.sessionCount(value.id)};if(!args.include_references)delete result.references;return result;}
async function execute(args,payload,environ) {
  const origin=()=>resolveOrigin(environ,args);
  let draft=null,runtime=null;
  if(args.command==='record'){
    if(Object.hasOwn(payload,'origin'))throw new InputError();
    runtime=origin();draft=RecordDraft.fromDict({...payload,origin:runtime});
  } else if(args.command==='associate'){
    if(Object.keys(payload).sort().join(',')!=='operation_key,thread_id')throw new InputError();runtime=origin();
  } else if(args.command==='current'||args.command==='list'&&args.current_session)runtime=origin();
  if(args.command==='list'&&Boolean(args.reference_kind)!==Boolean(args.reference))throw new ArgumentsError();
  // Import node:sqlite only after checking the runtime and validating write input.
  const {Store}=await import('./store.mjs');
  const store=new Store(args.data_dir,{busy_timeout_ms:args.busy_timeout_ms});
  if(args.command==='record')return {event:store.append(draft)};
  if(args.command==='associate')return {association:store.associate(runtime,payload.thread_id,payload.operation_key)};
  if(args.command==='current')return {association:store.currentAssociation(runtime)};
  if(args.command==='list'){
    const reference=args.reference_kind?new ExternalReference({kind:args.reference_kind,reference:args.reference}):null;
    const page=store.listThreads({limit:args.limit,before_sequence:args.before_sequence,origin:runtime,reference});
    return {threads:page.map(value=>snapshot(value,args,store)),next_before_sequence:next(page,args.limit,'latest_sequence')};
  }
  if(args.command==='sessions'){
    const page=store.associationHistory(args.thread_id,{limit:args.limit,after_sequence:args.after_sequence});
    return {associations:page,next_after_sequence:next(page,args.limit,'sequence')};
  }
  if(args.command==='events'){
    const page=store.events(args.thread_id,{limit:args.limit,after_sequence:args.after_sequence});
    return {events:page.map(value=>event(value,args)),next_after_sequence:next(page,args.limit,'sequence')};
  }
  const thread=store.getThread(args.thread_id),page=store.recentEvents(args.thread_id,{limit:args.limit,before_sequence:args.before_sequence});
  return {thread:snapshot(thread,args,store),events:page.map(value=>event(value,args)),next_before_sequence:next(page,args.limit,'sequence')};
}
function failure(error) {
  const types=[
    [ArgumentsError,'invalid_arguments','Invalid command arguments; run --help.',2],
    [IdentityError,'identity_required','Fresh, unambiguous Pi context or current shell CODEX_THREAD_ID required.',2],
    [InputError,'invalid_input','Invalid or oversized input; check contract and field bounds.',2],
    [ValidationError,'invalid_input','Invalid or oversized input; check contract and field bounds.',2],
    [TypeError,'invalid_input','Invalid or oversized input; check contract and field bounds.',2],
    [RangeError,'invalid_input','Invalid or oversized input; check contract and field bounds.',2],
    [ConflictError,'conflict','Operation key was already used with different input.',3],
    [NotFoundError,'not_found','Requested thread does not exist.',4],
    [StoreBusyError,'busy','Local history is busy; retry the identical operation.',5],
  ];
  const [,code,message,status]=types.find(([Type])=>error instanceof Type)??[Error,'storage_error','Cannot access local history; check private storage permissions, path and schema.',6];
  return [{ok:false,error:{code,message,retryable:status===5}},status];
}
export async function main(argv=process.argv.slice(2),{stdin=process.stdin,stdout=process.stdout,environ=process.env}={}) {
  let response,status;
  try {
    if(!supportedNode())throw new StorageError(`Node ${MIN_NODE}+ required`);
    const args=parseArguments(argv);
    const result=args.help?{help:HELP,max_input_bytes:MAX_INPUT_BYTES}:await execute(args,await input(stdin,['record','associate'].includes(args.command)),environ);
    response={ok:true,result};status=0;
  } catch(error){[response,status]=failure(error);}
  stdout.write(stringify({contract_version:CONTRACT_VERSION,...response})+'\n');return status;
}
