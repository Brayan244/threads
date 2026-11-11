// Tool builder is supplied by OpenCode's own @opencode-ai/plugin installation.
import { isAbsolute } from 'node:path';
import { invokeThreads } from '../common/invoke.mjs';
import { encodeNativeContext, NATIVE_CONTEXT } from '../../src/threads/identity.mjs';
import { parseJSON } from '../../src/threads/json.mjs';

export function createOpenCodeTools(tool) {
  const text=maximum=>tool.schema.string().min(1).max(maximum);
  const limit=()=>tool.schema.number().int().min(1).max(20).optional();
  const definitions={
    current:{description:'Read the current runtime session association. It is a candidate, not proof of continuity.',args:{}},
    search:{description:'Find up to five compact candidates by title/current summary. All literal prefix terms must match; no event-body search.',args:{query:text(320),limit:limit()}},
    list:{description:'Fallback recent compact summaries (default five); prefer current/search. Exact reference filters are available through the CLI.',args:{limit:limit()}},
    show:{description:'Compact current summary by default; detail:true reads two full events. Viewing never approves anything.',args:{thread_id:text(36),detail:tool.schema.boolean().optional(),limit:limit(),before_sequence:tool.schema.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()}},
    record:{description:'Record a meaningful milestone. payload is semantic JSON with kind/body/operation_key and optional thread_id; omit origin. Reuse identical payload/key on retry.',args:{payload:text(65536)}},
    associate:{description:'Choose a thread after reading its context. No milestone or merge. Reuse identical payload/key on retry.',args:{thread_id:text(36),operation_key:text(200)}},
  };
  return Object.fromEntries(Object.entries(definitions).map(([name,definition])=>[name,tool({...definition,
    async execute(args,context) {
      if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!Object.hasOwn(definition.args,key)))throw new Error('Threads invalid_input: fields must match the tool schema.');
      let encoded,cwd;
      try {
        // Read from this callback, never plugin initialization or daemon env.
        const session_id=context.sessionID;cwd=context.directory;
        if(typeof cwd!=='string'||!isAbsolute(cwd))throw Error();
        encoded=encodeNativeContext({agent:'opencode',session_id,session_ref:null});
      }catch{throw new Error('Threads identity_required: fresh OpenCode sessionID and directory are required.');}
      let payload,argv=['--require-native-context',name];
      if(name==='record'){
        try{payload=parseJSON(args.payload);}catch{throw new Error('Threads invalid_input: payload must be strict semantic JSON.');}
      }else if(name==='associate')payload={thread_id:args.thread_id,operation_key:args.operation_key};
      else if(name==='search')argv.push(String(args.query));
      else if(name==='show'){
        argv.push(String(args.thread_id));
        const historical=args.detail??(args.limit!==undefined||args.before_sequence!==undefined);
        if(!historical&&(args.limit!==undefined||args.before_sequence!==undefined))throw new Error('Threads invalid_input: pagination requires detail.');
        if(!historical)argv.push('--compact');else if(args.limit===undefined)argv.push('--limit','2');
      }else if(name==='list'){argv.push('--compact');if(args.limit===undefined)argv.push('--limit','5');}
      for(const key of ['limit','before_sequence'])if(args[key]!==undefined)argv.push('--'+key.replaceAll('_','-'),String(args[key]));
      const result=await invokeThreads(argv,payload,{cwd,environ:{...process.env,[NATIVE_CONTEXT]:encoded}},context.abort);
      return result.content[0].text;
    },
  })]));
}
