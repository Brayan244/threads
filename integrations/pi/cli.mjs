// Pi's exec API has no stdin facility. Spawn argv directly to keep semantic JSON
// off shell command lines and out of origin metadata; never invoke a shell.
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../bin/threads', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const captureFailure = () => new Error('Threads capture_failed: outcome unconfirmed. Retry the identical operation in the same session; do not claim it was saved.');
const failures = {
  invalid_arguments: [2, 'Invalid command arguments.'],
  identity_required: [2, 'Fresh, unambiguous Pi SessionManager identity and an absolute session file are required.'],
  invalid_input: [2, 'Invalid or oversized semantic input.'],
  conflict: [3, 'Operation key already used with different input; inspect before retrying.'],
  not_found: [4, 'Requested thread does not exist.'],
  busy: [5, 'History is busy; retry the identical operation in the same session.'],
  storage_error: [6, 'Cannot access private local history; check storage permissions and schema.'],
};

export async function runThreads(args, payload, ctx, signal) {
  // Read BOTH from THIS execution context, before any asynchronous work. The
  // factory, environment and semantic parameters never supply Pi identity.
  let id, ref;
  try {
    id = ctx.sessionManager.getSessionId();
    ref = ctx.sessionManager.getSessionFile();
    if (typeof id !== 'string' || !uuid.test(id) ||
        id === '00000000-0000-0000-0000-000000000000' ||
        typeof ref !== 'string' || !ref.isWellFormed() || !isAbsolute(ref) ||
        ref.startsWith('//') || /[\x00-\x1f]/.test(ref)) throw Error();
  } catch {
    throw new Error(`Threads identity_required: ${failures.identity_required[1]}`);
  }
  let input;
  try {
    if (payload && Object.hasOwn(payload, 'origin')) throw Error();
    input = payload === undefined ? '' : JSON.stringify(payload);
    if (Buffer.byteLength(input) > 65536) throw Error();
  } catch {
    throw new Error('Threads invalid_input: semantic input must fit CLI v1 and must not contain origin.');
  }
  if (signal?.aborted) throw captureFailure();
  const { output, status } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--pi-session-id', id, '--pi-session-ref', ref, ...args], {
      cwd: ctx.cwd, stdio: ['pipe', 'pipe', 'pipe'], signal, timeout: 15000, killSignal: 'SIGKILL',
    });
    const chunks = [];
    let bytes = 0, invalid = false;
    child.on('error', () => reject(captureFailure()));
    child.stdin.on('error', () => reject(captureFailure()));
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) { invalid = true; child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    // CLI v1 never emits stderr; do not surface arbitrary subprocess diagnostics.
    child.stderr.on('data', () => { invalid = true; });
    child.on('close', (status, killedBy) => {
      if (invalid || killedBy || status === null) reject(captureFailure());
      else resolve({ output: Buffer.concat(chunks).toString('utf8'), status });
    });
    child.stdin.end(input);
  }).catch(() => { throw captureFailure(); });
  let response;
  try { response = JSON.parse(output); } catch { throw captureFailure(); }
  if (response?.contract_version !== 1 || typeof response.ok !== 'boolean') throw captureFailure();
  if (!response.ok) {
    const code = response.error?.code;
    const failure = Object.hasOwn(failures, code) ? failures[code] : undefined;
    if (!failure || failure[0] !== status || response.error.retryable !== (code === 'busy')) throw captureFailure();
    throw new Error(`Threads ${code}: ${failure[1]}`);
  }
  if (status !== 0 || !response.result || typeof response.result !== 'object' || Array.isArray(response.result)) throw captureFailure();
  const details = response.result;
  // Attribution stays in structured internal details, not in the default display.
  let text = JSON.stringify(details, (key, value) => key === 'origin' ? undefined : value);
  if (text.length > 48000) {
    text = JSON.stringify({ ok: true, result_omitted: true,
      thread_id: details.event?.thread_id ?? details.thread?.id,
      event_sequence: details.event?.sequence,
      guidance: 'Large result omitted from model context. Full structured result is in tool details. Read full values with the checkout bin/threads show THREAD_ID --limit 1 (or list); use pagination for older records.',
    });
  }
  return { content: [{ type: 'text', text }], details };
}
