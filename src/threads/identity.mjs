// Read identity from this invocation, never semantic JSON or a cached factory.
import { isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { Origin, ValidationError } from './domain.mjs';
export class IdentityError extends ValidationError {}
function fileLocator(path) {
  // Match pathlib.as_uri: collapse dots/slashes, preserve parent segments and
  // strip a trailing slash. URL/path.resolve would change legacy attribution.
  const prefix=path.startsWith('//')&&!path.startsWith('///')?'//':'/';
  const normalized=prefix+path.split('/').filter(part=>part&&part!=='.').join('/');
  const encoded=normalized.split('/').map(part=>encodeURIComponent(part).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())).join('/');
  return 'file://'+encoded;
}
export function resolveOrigin(environ = process.env, { pi_session_id, pi_session_ref } = {}) {
  try {
    const pi = pi_session_id !== undefined && pi_session_id !== null || pi_session_ref !== undefined && pi_session_ref !== null;
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
