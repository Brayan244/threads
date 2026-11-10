// Installed Pi loader + synthetic execution contexts + real CLI/temporary SQLite.
// These are integration fixtures, not live-agent semantic or provenance evidence.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const piExecutable = (process.env.PATH ?? '').split(delimiter)
  .map(path => join(path, 'pi')).find(path => existsSync(path));
assert.ok(piExecutable, 'Installed Pi is required; no dependency installation is performed.');
let piRoot = dirname(realpathSync(piExecutable));
while (!existsSync(join(piRoot, 'package.json')) ||
  JSON.parse(readFileSync(join(piRoot, 'package.json'), 'utf8')).name !== '@earendil-works/pi-coding-agent') {
  assert.notEqual(dirname(piRoot), piRoot, 'Cannot locate the installed Pi package.');
  piRoot = dirname(piRoot);
}
const { loadExtensions } = await import(pathToFileURL(join(piRoot, 'dist/core/extensions/loader.js')));
const { validateToolArguments } = await import(pathToFileURL(
  join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js')));
const python = (process.env.PATH ?? '').split(delimiter)
  .map(path => join(path, 'python3')).find(path => existsSync(path));
assert.ok(python, 'Python 3 is required.');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let temp, extension, loadErrors;
const originalEnv = { ...process.env };

before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'threads-pi-'));
  process.env.XDG_DATA_HOME = join(temp, 'xdg');
  delete process.env.CODEX_THREAD_ID;
  const loaded = await loadExtensions([join(root, 'integrations/pi/index.ts')], root);
  loadErrors = loaded.errors;
  extension = loaded.extensions[0];
});
after(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  if (temp) await rm(temp, { recursive: true, force: true });
});

function tool(name) {
  assert.deepEqual(loadErrors, [], 'Extension must load through installed Pi, not a schema stub.');
  const value = extension.tools.get(name)?.definition;
  assert.ok(value, `Missing ${name}`);
  return value;
}
function context(id = A, ref = join(temp, 'pi-a.jsonl')) {
  return { cwd: root, sessionManager: { getSessionId: () => id, getSessionFile: () => ref } };
}
async function call(name, args = {}, ctx = context(), signal) {
  const definition = tool(name);
  const params = validateToolArguments(definition, { name, arguments: args });
  return definition.execute('synthetic-call-id', params, signal, undefined, ctx);
}
function draft(operation_key, changes = {}) {
  return { kind: 'progress', body: 'Fixture investigation found a reproducible failure.', operation_key, ...changes };
}
function cli(args, input, env = {}) {
  return JSON.parse(execFileSync(python, [join(root, 'bin/threads'), ...args], {
    input: input === undefined ? '' : JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, ...env }, timeout: 10000, maxBuffer: 16 * 1024 * 1024,
  }));
}
async function fakePython(source, action) {
  const directory = await mkdtemp(join(temp, 'fake-python-'));
  const executable = join(directory, 'python3');
  await writeFile(executable, `#!${process.execPath}\n${source}\n`);
  await chmod(executable, 0o700);
  const previous = process.env.PATH;
  process.env.PATH = directory;
  try { return await action(); } finally { process.env.PATH = previous; }
}

test('registers only explicit domain tools; loading does not create data or hooks', () => {
  assert.deepEqual(loadErrors, []);
  assert.deepEqual([...extension.tools.keys()].sort(),
    ['threads_associate', 'threads_current', 'threads_list', 'threads_record', 'threads_show']);
  assert.equal(extension.handlers.size, 0);
  assert.equal(existsSync(join(temp, 'xdg')), false);
});

test('empty list and current reads create no thread, event, or association', async () => {
  assert.deepEqual((await call('threads_list')).details.threads, []);
  assert.equal((await call('threads_current')).details.association, null);
});

test('fresh execution context survives session switching without capturing factory identity', async () => {
  let id = A, ref = join(temp, 'fresh-a.jsonl'), idReads = 0, refReads = 0;
  const ctx = { cwd: root, sessionManager: {
    getSessionId() { idReads++; return id; },
    getSessionFile() { refReads++; return ref; },
  } };
  const first = (await call('threads_record', draft('fresh-first'), ctx)).details.event;
  id = B; ref = join(temp, 'fresh-b.jsonl');
  assert.equal((await call('threads_current', {}, ctx)).details.association, null);
  const second = (await call('threads_record', draft('fresh-second', { thread_id: first.thread_id }), ctx)).details.event;
  assert.deepEqual(first.origin, { agent: 'pi', session_id: A, session_ref: join(temp, 'fresh-a.jsonl') });
  assert.deepEqual(second.origin, { agent: 'pi', session_id: B, session_ref: ref });
  assert.equal(idReads, 3);
  assert.equal(refReads, 3);
  assert.equal((await call('threads_current', {}, ctx)).details.association.thread_id, first.thread_id);
});

test('record retries are idempotent; changed payload conflicts; old associations do not rewind', async () => {
  const payload = draft('retry-create', { thread_id: null, title: 'Idempotent fixture' });
  const first = await call('threads_record', payload);
  assert.deepEqual((await call('threads_record', payload)).details, first.details);
  await assert.rejects(call('threads_record', { ...payload, body: 'Changed' }), /conflict/);
  const firstId = first.details.event.thread_id;
  const secondId = (await call('threads_record', draft('retry-second'))).details.event.thread_id;
  const association = { thread_id: firstId, operation_key: 'bind-first' };
  const receipt = await call('threads_associate', association);
  await call('threads_associate', { thread_id: secondId, operation_key: 'bind-second' });
  assert.deepEqual((await call('threads_associate', association)).details, receipt.details);
  await call('threads_record', payload);
  assert.equal((await call('threads_current')).details.association.thread_id, secondId);
  assert.equal((await call('threads_show', { thread_id: firstId })).details.thread.event_count, 1);
});

test('origin and runtime overrides are absent from schemas and rejected rather than stripped', async () => {
  for (const [name, args] of [
    ['threads_record', draft('forbidden')],
    ['threads_associate', { thread_id: A, operation_key: 'forbidden' }],
    ['threads_list', {}], ['threads_current', {}], ['threads_show', { thread_id: A }],
  ]) {
    const definition = tool(name);
    for (const field of ['origin', 'pi_session_id', 'pi_session_ref', 'data_dir']) {
      assert.equal(field in definition.parameters.properties, false);
      assert.throws(() => validateToolArguments(definition, {
        name, arguments: { ...args, [field]: { private: 'fixture-secret' } },
      }), /Validation failed/);
    }
  }
  // Direct callback execution must not silently discard a forged origin either.
  await assert.rejects(tool('threads_record').execute('id', {
    ...draft('forbidden-direct'), origin: { session_id: B },
  }, undefined, undefined, context()), /invalid_input/);
});

test('missing, invalid, ambiguous or failing runtime identity never confirms a write', async () => {
  for (const ctx of [context('invalid'), context(A, 'relative'),
    { cwd: root, sessionManager: { getSessionId() { throw Error('fixture-secret'); }, getSessionFile: () => '/tmp/a' } },
  ]) {
    await assert.rejects(call('threads_record', draft('bad-runtime'), ctx), /identity_required/);
  }
  const missing = context(); missing.sessionManager.getSessionFile = () => undefined;
  await assert.rejects(call('threads_record', draft('missing-runtime'), missing), /identity_required/);
  process.env.CODEX_THREAD_ID = B;
  try { await assert.rejects(call('threads_record', draft('ambiguous-runtime')), /identity_required/); }
  finally { delete process.env.CODEX_THREAD_ID; }
});

test('async spawn and child failures reject, redact diagnostics, and allow identical retry', async () => {
  const payload = draft('async-retry');
  const previous = process.env.PATH;
  process.env.PATH = join(temp, 'absent');
  try { await assert.rejects(call('threads_record', payload), /capture_failed/); }
  finally { process.env.PATH = previous; }
  await fakePython("process.stderr.write('fixture-secret'); process.exit(1);", async () => {
    await assert.rejects(call('threads_record', payload), error =>
      /capture_failed/.test(error.message) && !error.message.includes('fixture-secret'));
  });
  await fakePython("process.stdout.write('{bad fixture-secret');", async () => {
    await assert.rejects(call('threads_record', payload), /capture_failed/);
  });
  await fakePython("process.stdout.write(JSON.stringify({contract_version:99,ok:true,result:{}}));", async () => {
    await assert.rejects(call('threads_record', payload), /capture_failed/);
  });
  const saved = await call('threads_record', payload);
  assert.deepEqual((await call('threads_record', payload)).details, saved.details);
});

test('lost receipt after a real commit is safely recovered by the identical retry', async () => {
  const payload = draft('lost-real-receipt', { title: 'Lost receipt fixture', thread_id: null });
  await fakePython(`
    const { spawnSync } = require('node:child_process');
    const input = require('node:fs').readFileSync(0);
    const committed = spawnSync(${JSON.stringify(python)}, process.argv.slice(2), {
      input, encoding: 'utf8', env: process.env,
    });
    if (committed.status !== 0) process.exit(1);
    process.stdout.write('receipt lost');
  `, async () => {
    await assert.rejects(call('threads_record', payload), /capture_failed/);
  });
  const saved = (await call('threads_record', payload)).details.event;
  assert.deepEqual((await call('threads_record', payload)).details.event, saved);
  assert.equal((await call('threads_show', { thread_id: saved.thread_id })).details.thread.event_count, 1);
});

test('CLI busy envelope is a failed tool result, never a success-shaped receipt', async () => {
  await fakePython(`process.stdout.write(JSON.stringify({
    contract_version: 1, ok: false,
    error: { code: 'busy', message: 'fixture-secret', retryable: true },
  })); process.exitCode = 5;`, async () => {
    await assert.rejects(call('threads_record', draft('busy-retry')), error =>
      /busy/.test(error.message) && /identical/.test(error.message) && !error.message.includes('fixture-secret'));
  });
});

test('cancellation rejects before spawn and while an asynchronous child runs', async () => {
  const already = new AbortController(); already.abort();
  await assert.rejects(call('threads_record', draft('cancel-before'), context(), already.signal), /capture_failed/);
  await fakePython('setTimeout(() => {}, 10000);', async () => {
    const controller = new AbortController();
    const pending = call('threads_record', draft('cancel-during'), context(), controller.signal);
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(pending, /capture_failed/);
  });
});

test('real CLI cross-host fixture preserves both origins, typed evidence and bounded recovery', async () => {
  const target = { object_id: 'fixture-plan', version: 'v1', digest: 'sha256:fixture' };
  const first = (await call('threads_record', draft('cross-pi', {
    kind: 'hypothesis', title: 'Cross-host fixture', summary: 'Failure isolated; cause still hypothetical.',
    references: [{ kind: 'issue', reference: 'FIXTURE-1' }],
    evidence: [{ kind: 'document', reference: join(temp, 'plan.md'), target, availability: 'unknown' }],
  }))).details.event;
  const codex = cli(['record'], draft('cross-codex', { thread_id: first.thread_id, kind: 'review_finding',
    review: { target, instruction: 'Fixture human requests changes to v1', disposition: 'changes_requested' },
  }), { CODEX_THREAD_ID: B, CODEX_HOME: join(temp, 'codex') }).result.event;
  const listing = (await call('threads_list', { reference_kind: 'issue', reference: 'FIXTURE-1', limit: 1 })).details;
  assert.equal(listing.threads[0].id, first.thread_id);
  const page = (await call('threads_show', { thread_id: first.thread_id, limit: 1 })).details;
  assert.equal(page.events[0].review.disposition, 'changes_requested');
  const older = (await call('threads_show', {
    thread_id: first.thread_id, limit: 1, before_sequence: page.next_before_sequence,
  })).details;
  assert.deepEqual(older.events[0].evidence[0].target, target);
  const history = cli(['events', first.thread_id, '--include-origin']).result.events;
  assert.equal(history.length, 2);
  assert.deepEqual(history.map(event => event.origin.agent), ['pi', 'codex']);
  assert.equal(history[0].origin.session_id, A);
  assert.equal(codex.origin.session_id, B);
  assert.equal(codex.origin.session_ref, pathToFileURL(join(temp, 'codex')).href + '#thread=' + B);
});

for (const name of ['threads_list', 'threads_show']) {
  test(`installed Pi schema for ${name} advertises and enforces a 20-item read ceiling`, () => {
    const definition = tool(name);
    assert.equal(definition.parameters.properties.limit.minimum, 1);
    assert.equal(definition.parameters.properties.limit.maximum, 20);
    const args = name === 'threads_show' ? { thread_id: A } : {};
    for (const limit of [1, 20]) {
      assert.equal(validateToolArguments(definition, { name, arguments: { ...args, limit } }).limit, limit);
    }
    for (const limit of [0, 21, 200]) {
      assert.throws(() => validateToolArguments(definition, {
        name, arguments: { ...args, limit },
      }), /Validation failed/, `${name} must reject limit ${limit}`);
    }
  });
}

for (const shape of ['Unicode', 'DEL-escaped']) {
  test(`maximum Pi pages traverse accepted ${shape} records and inherited references`, { timeout: 120000 }, async () => {
    const character = shape === 'Unicode' ? '界' : '\u007f';
    const references = Array.from({ length: 32 }, (_, i) => ({
      kind: 'issue', reference: `fixture-${i}-` + character.repeat(shape === 'Unicode' ? 650 : 1990),
    }));
    const target = shape === 'Unicode'
      ? { object_id: character.repeat(128), version: character.repeat(64), digest: character.repeat(64) }
      : { object_id: character.repeat(2048), version: character.repeat(256), digest: character.repeat(256) };
    const rich = {
      kind: 'review_finding', body: character.repeat(16000), summary: character.repeat(4000),
      title: character.repeat(240),
      review: { target, instruction: character.repeat(shape === 'Unicode' ? 128 : 4000), disposition: 'changes_requested' },
      evidence: Array.from({ length: shape === 'Unicode' ? 1 : 7 }, () => ({
        kind: 'document', reference: '/' + character.repeat(shape === 'Unicode' ? 128 : 2047),
        target, availability: 'unknown',
      })),
    };
    // Each write is schema-validated, passes the real bridge's 64KiB input check,
    // and reaches real SQLite under this test's temporary XDG data root. The
    // later record omits references: the larger prior snapshot must survive.
    async function accepted(payload) {
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      assert.ok(bytes > 60000 && bytes <= 65536, `fixture must approach the accepted input ceiling: ${bytes}`);
      return (await call('threads_record', payload)).details.event;
    }
    const ids = [];
    let firstEvent;
    for (let i = 0; i < 21; i++) {
      const seed = await accepted(draft(`${shape}-seed-${i}`, { references }));
      ids.push(seed.thread_id);
      const event = await accepted(draft(`${shape}-rich-${i}`, { ...rich, thread_id: seed.thread_id }));
      assert.deepEqual(event.origin, { agent: 'pi', session_id: A, session_ref: join(temp, 'pi-a.jsonl') });
      if (i === 0) firstEvent = event;
    }
    for (let i = 0; i < 20; i++) {
      await accepted(draft(`${shape}-history-${i}`, { ...rich, thread_id: ids[0] }));
    }
    const filter = { reference_kind: 'issue', reference: references[0].reference, include_references: true, limit: 20 };
    const listing = (await call('threads_list', filter)).details;
    const { limit: _limit, ...defaultFilter } = filter;
    const defaultListing = (await call('threads_list', defaultFilter)).details;
    assert.equal(defaultListing.threads.length, 20,
      'omitting limit must not fall back to the standalone CLI default of 50');
    assert.equal(defaultListing.next_before_sequence, listing.next_before_sequence);
    assert.deepEqual(defaultListing.threads.map(thread => thread.id), listing.threads.map(thread => thread.id));
    assert.equal(listing.threads.length, 20);
    assert.ok(Number.isSafeInteger(listing.next_before_sequence));
    for (const thread of listing.threads) {
      assert.deepEqual(thread.references, references);
      assert.equal(thread.summary, rich.summary);
      assert.equal(thread.title, rich.title);
    }
    const olderList = (await call('threads_list', { ...filter, before_sequence: listing.next_before_sequence })).details;
    assert.equal(olderList.threads.length, 1);
    assert.equal(olderList.next_before_sequence, null);
    assert.deepEqual(new Set([...listing.threads, ...olderList.threads].map(thread => thread.id)), new Set(ids));

    const args = { thread_id: ids[0], limit: 20, include_references: true };
    const response = await call('threads_show', args);
    const page = response.details;
    assert.equal(page.events.length, 20);
    assert.deepEqual(page.thread.references, references);
    assert.equal(page.next_before_sequence, page.events.at(-1).sequence);
    for (const event of page.events) {
      assert.equal(event.body, rich.body);
      assert.deepEqual(event.review, rich.review);
      assert.deepEqual(event.evidence, rich.evidence);
      assert.equal('origin' in event, false);
      assert.equal(event.references, null);
      assert.ok(event.received_at);
    }
    assert.equal(JSON.parse(response.content[0].text).result_omitted, true);
    assert.ok(response.content[0].text.length < 48000);
    const savedPage = JSON.stringify(page);
    await assert.rejects(call('threads_show', { ...args, limit: 21 }), /Validation failed/);
    // A valid success envelope above the existing capture ceiling must still
    // fail, without mutating the prior page or making its cursor unusable.
    await fakePython(`process.stdout.write(JSON.stringify({
      contract_version: 1, ok: true, result: { padding: 'x'.repeat(16 * 1024 * 1024) },
    }));`, async () => {
      await assert.rejects(call('threads_show', args), /capture_failed/);
    });
    assert.equal(JSON.stringify(page), savedPage, 'failed reads leave the last successful result intact');
    const older = (await call('threads_show', { ...args, before_sequence: page.next_before_sequence })).details;
    assert.deepEqual(older.events.map(event => event.sequence), [firstEvent.sequence, firstEvent.sequence - 1]);
    assert.deepEqual(older.events.at(-1).references, references);
    assert.equal(older.next_before_sequence, null);
    const sequences = [...page.events, ...older.events].map(event => event.sequence);
    assert.equal(new Set(sequences).size, 22);
    assert.deepEqual((await call('threads_show', args)).details, page, 'reads do not change stored history');

    // Standalone CLI contracts remain list=100/show=200, independently of Pi.
    assert.equal(cli(['list', '--limit', '100', '--reference-kind', 'issue', '--reference', references[0].reference]).result.threads.length, 21);
    assert.equal(cli(['show', ids[0], '--limit', '200']).result.events.length, 22);
    assert.equal(cli(['show', ids[0]]).result.events.length, 10);
  });
}

test('read boundaries and large replies are explicit, not silently unbounded model context', async () => {
  assert.throws(() => validateToolArguments(tool('threads_list'), {
    name: 'threads_list', arguments: { limit: 101 },
  }), /Validation failed/);
  const first = (await call('threads_record', draft('large-first', { body: 'x'.repeat(16000) }))).details.event;
  for (let i = 0; i < 4; i++) await call('threads_record', draft(`large-${i}`, {
    thread_id: first.thread_id, body: 'x'.repeat(16000),
  }));
  const response = await call('threads_show', { thread_id: first.thread_id, limit: 5 });
  assert.equal(response.details.events.length, 5);
  assert.ok(response.content[0].text.length < 50000);
  assert.match(response.content[0].text, /truncated|omitted/i);
  assert.match(response.content[0].text, /bin\/threads/);
});
