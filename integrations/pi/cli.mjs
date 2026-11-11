// Read Pi identity before asynchronous work; never use cached factory context.
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function runThreads(args,payload,ctx,signal) {
  let id,ref;
  try {
    id=ctx.sessionManager.getSessionId();ref=ctx.sessionManager.getSessionFile();
    if(typeof id!=='string'||!uuid.test(id)||id==='00000000-0000-0000-0000-000000000000'||
      typeof ref!=='string'||!ref.isWellFormed()||!isAbsolute(ref)||ref.startsWith('//')||/[\x00-\x1f]/.test(ref))throw Error();
  }catch{throw new Error('Threads identity_required: Fresh, unambiguous Pi SessionManager identity and an absolute session file are required.');}
  // Native ESM content-versioning also covers changes to the shared transport.
  const transport=new URL('../common/invoke.mjs',import.meta.url);
  transport.searchParams.set('v',createHash('sha256').update(readFileSync(transport)).digest('hex'));
  const {invokeThreads}=await import(transport.href);
  return invokeThreads(['--pi-session-id',id,'--pi-session-ref',ref,...args],payload,{cwd:ctx.cwd},signal);
}
