// Read identity from this invocation, never semantic JSON or a cached factory.
import { isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { Origin, ValidationError } from './domain.mjs';
import { parseJSON, stringify } from './json.mjs';
export class IdentityError extends ValidationError {}
export const NATIVE_CONTEXT='THREADS_RUNTIME_CONTEXT';
export function encodeNativeContext(value) {
  const origin=new Origin(value);
  if(['pi','codex'].includes(origin.agent))throw new IdentityError('Use the native Pi/Codex adapter');
  return 'v1.'+Buffer.from(stringify({version:1,origin})).toString('base64url');
}
function decodeNativeContext(encoded) {
  if(typeof encoded!=='string'||encoded.length>16384||!/^v1\.[A-Za-z0-9_-]+$/.test(encoded))throw new IdentityError('Invalid native context');
  const bytes=Buffer.from(encoded.slice(3),'base64url');
  if(bytes.toString('base64url')!==encoded.slice(3))throw new IdentityError('Noncanonical native context');
  const value=parseJSON(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));
  if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='origin,version'||value.version!==1)throw new IdentityError('Unsupported native context');
  const origin=new Origin(value.origin);
  if(['pi','codex'].includes(origin.agent))throw new IdentityError('Use the native Pi/Codex adapter');
  return origin;
}
function fileLocator(path) {
  // Match pathlib.as_uri: collapse dots/slashes, preserve parent segments and
  // strip a trailing slash. URL/path.resolve would change legacy attribution.
  const prefix=path.startsWith('//')&&!path.startsWith('///')?'//':'/';
  const normalized=prefix+path.split('/').filter(part=>part&&part!=='.').join('/');
  const encoded=normalized.split('/').map(part=>encodeURIComponent(part).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())).join('/');
  return 'file://'+encoded;
}
export function resolveOrigin(environ = process.env, { pi_session_id, pi_session_ref, require_native_context=false } = {}) {
  try {
    const pi = pi_session_id !== undefined && pi_session_id !== null || pi_session_ref !== undefined && pi_session_ref !== null;
    if(Object.hasOwn(environ,NATIVE_CONTEXT)) {
      if(pi)throw new IdentityError('Ambiguous native/Pi context');
      // A per-tool hook/SDK envelope takes precedence over ancestor shell state.
      // Invalid envelopes fail closed; never fall back to inherited Codex IDs.
      return decodeNativeContext(environ[NATIVE_CONTEXT]);
    }
    if(require_native_context)throw new IdentityError('Fresh native adapter context required');
    if (pi) {
      if (Object.hasOwn(environ, 'CODEX_THREAD_ID') || !pi_session_id || !pi_session_ref || !isAbsolute(pi_session_ref)) throw new IdentityError('Missing or ambiguous runtime context');
      return new Origin({agent:'pi',session_id:pi_session_id,session_ref:pi_session_ref});
    }
    const id = environ.CODEX_THREAD_ID;
    if (!id) throw new IdentityError('Current shell runtime identity required');
    const home = Object.hasOwn(environ, 'CODEX_HOME') ? environ.CODEX_HOME : homedir()+'/.codex';
    if (typeof home !== 'string' || !isAbsolute(home) || /[\x00-\x1f]/.test(home) || !home.isWellFormed()) throw new IdentityError('Invalid runtime directory');
    const ref = fileLocator(home);
    const origin = new Origin({agent:'codex',session_id:id,session_ref:ref});
    return new Origin({...origin,session_ref:ref+'#thread='+origin.session_id});
  } catch (error) {
    if (error instanceof IdentityError) throw error;
    throw new IdentityError('Invalid current runtime identity or reference');
  }
}
