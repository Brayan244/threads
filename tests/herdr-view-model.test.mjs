// Pure projections plus real read-only CLI/temporary SQLite integration; not live UI proof.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ThreadsModel, createClient, referenceAction, reviewLabel } from '../herdr/mods/threads/view-model.js';

import * as presentation from '../herdr/mods/threads/view-model.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const event = (sequence, thread_id = A) => ({ sequence, thread_id, kind: 'progress', body: `Avance ${sequence}`,
  evidence: [], received_at: '2026-11-03T00:00:00+00:00' });
const thread = (id = A, latest_sequence = 30) => ({ id, title: 'Trabajo', summary: 'Último avance',
  latest_sequence, event_count: latest_sequence, session_count: 1, references: [] });
function fixture() {
  const calls = [];
  const client = {
    async list(before) { calls.push(['list', before]); return { threads: [A, B, 'c', 'd', 'e'].map(id => thread(id)), next_before_sequence: null }; },
    async show(id, before) { calls.push(['show', id, before]); return { thread: thread(id), events: [event(before ? 10 : 30, id)], next_before_sequence: before ? null : 30 }; },
    async sessions(id, after) { calls.push(['sessions', id, after]); return { associations: [], next_after_sequence: null }; },
  };
  return { client, calls, model: new ThreadsModel(client) };
}

test('mini captions are complete short phrases, never arbitrary body truncation or invented summaries', () => {
  assert.equal(typeof presentation.miniCaption, 'function');
  assert.equal(presentation.miniCaption({kind:'progress',summary:'Se corrigió la pérdida de precisión.',body:'Technical output '.repeat(100)}), 'Se corrigió la pérdida de precisión.');
  assert.equal(presentation.miniCaption({kind:'hypothesis',summary:'La causa podría ser la caché. Falta comprobarla.'}), 'La causa podría ser la caché.');
  assert.equal(presentation.miniCaption({kind:'validation',summary:'Texto sin final '.repeat(100)}), 'Validación registrada.');
  assert.equal(presentation.miniCaption({kind:'progress',body:'/private/very/long/path.py sha256:'+'a'.repeat(64)}), 'Avance registrado.');
  assert.equal(presentation.miniCaption({kind:'observation',body:'El caso se reproduce.'}), 'El caso se reproduce.');
  assert.equal(presentation.miniCaption({kind:'decision',summary:'```json {secret: 1} ```'}), 'Decisión registrada.');
});

test('selected work outside the first list page still exposes its exact reference snapshot', async () => {
  const client = { list: async () => ({threads:[],next_before_sequence:null}),
    show: async () => ({thread:{...thread(A),references:[{kind:'issue',reference:'issue-older'}]},events:[event(30)],next_before_sequence:null}) };
  const model = new ThreadsModel(client);
  await model.refresh(); await model.selectDetail(A);
  assert.equal(model.thread(A).id, A);
  assert.deepEqual(model.referenceGroups(A).find(group=>group.kind==='issue'), {kind:'issue',count:1});
});

test('five cards, two expansions and detail are independent; fetch/selection are not exposure', async () => {
  const { model } = fixture();
  await model.refresh();
  assert.equal(model.threads.length, 5);
  assert.equal(model.expanded.size, 0);
  await model.toggleHistory(A); await model.toggleHistory(B); await model.selectDetail(A);
  assert.deepEqual([...model.expanded], [A, B]);
  assert.equal(model.selected, A);
  await model.selectDetail(B);
  assert.deepEqual([...model.expanded], [A, B]);
  assert.equal(model.selected, B);
  assert.equal(model.isSeen(A, 30), false);
  assert.equal(model.isSeen(B, 30), false);
  const restored = new ThreadsModel(fixture().client, model.snapshot());
  assert.equal(restored.selected, B);
  assert.deepEqual([...restored.expanded], [A, B]);
});

test('legacy sparse exposure remains compatible without inferring gaps, approval or offscreen exposure', async () => {
  const { model } = fixture();
  await model.refresh(); await model.toggleHistory(A);
  assert.equal(model.expose('mini', A, 30, false), false);
  assert.equal(model.expose('detail', A, 30, true), false); // not selected/rendered
  assert.equal(model.expose('mini', A, 29, true), false); // not loaded
  assert.equal(model.expose('mini', A, 30, true), true);
  assert.equal(model.isSeen(A, 30), true);
  assert.equal(model.isSeen(A, 29), false);
  assert.equal(new ThreadsModel(fixture().client, model.snapshot()).isSeen(A, 30), true);
  assert.equal(model.page('mini', A).events[0].review, undefined);
  await model.toggleHistory(A);
  assert.equal(model.expose('mini', A, 30, true), false);
});

test('explicit read marks cover the known thread snapshot, not future arrivals or other threads', async () => {
  const {model,client}=fixture();
  await model.refresh(); await model.toggleHistory(A);
  assert.equal(model.markRead(A),true);
  assert.equal(model.isSeen(A,1),true);
  assert.equal(model.isSeen(A,30),true);
  assert.equal(model.isSeen(A,31),false);
  assert.equal(model.isSeen(B,30),false);
  assert.equal(model.markRead(A),false);
  const restored=new ThreadsModel(client,model.snapshot());
  assert.equal(restored.isSeen(A,1),true);
  client.list=async()=>({threads:[thread(A,31)],next_before_sequence:null});
  await model.refresh();
  assert.equal(model.isSeen(A,31),false);
  assert.equal(model.hasUnread(A),true);
  assert.equal(model.markRead('invalid'),false);
  client.show=async()=>({thread:thread(A,32),events:[event(32)],next_before_sequence:null});
  await model.selectDetail(A);
  assert.equal(model.markRead(A),true,'include the newest snapshot already loaded in detail, even if the list is stale');
  assert.equal(model.isSeen(A,32),true);
  assert.equal(model.isSeen(A,33),false);
  assert.equal(model.page('mini',A).events[0].review,undefined,'read is not approval');
});

test('read-through snapshot parsing rejects invalid marks and merges monotonically', () => {
  const model=new ThreadsModel(fixture().client,{readThrough:[[A,30],[A,10],[B,-1],['invalid',12],[B,NaN],null]});
  assert.equal(model.isSeen(A,30),true);
  assert.equal(model.isSeen(A,31),false);
  assert.equal(model.isSeen(B,1),false);
  assert.deepEqual(model.snapshot().readThrough,[[A,30]]);
});

test('unchanged refreshes retain list/page identity and report no presentation change', async () => {
  const {model}=fixture();
  await model.refresh(); await model.selectDetail(A);
  const list=model.threads,page=model.page('detail',A);
  assert.equal(await model.refresh(),false);
  assert.equal(model.threads,list);
  assert.equal(await model.loadPage('detail',A,null,[]),false);
  assert.equal(model.page('detail',A),page);
});

test('live refresh updates only changed latest pages, preserving historical pages and last good data', async () => {
  const {model,client,calls}=fixture();
  await model.refresh(); await model.toggleHistory(A); await model.selectDetail(B);
  await model.older('detail',B);
  const historical=model.page('detail',B);
  client.list=async()=>({threads:[thread(A,31),thread(B,31)],next_before_sequence:null});
  client.show=async(id,before)=>{calls.push(['show',id,before]);return {thread:thread(id,31),events:[event(31,id),event(30,id)],next_before_sequence:30};};
  await model.refresh();
  assert.equal(await model.refreshLatest('mini',A),true);
  assert.deepEqual(model.page('mini',A).events.map(event=>event.sequence),[31,30]);
  assert.equal(await model.refreshLatest('detail',B),false);
  assert.equal(model.page('detail',B),historical);
  assert.equal(model.isSeen(A,31),false);
  const good=model.page('mini',A);
  client.list=async()=>({threads:[thread(A,32)],next_before_sequence:null});
  await model.refresh(); client.show=async()=>{throw Error('private');};
  assert.equal(await model.refreshLatest('mini',A),true,'first failure changes the error presentation');
  assert.equal(model.page('mini',A),good);
  assert.equal(await model.refreshLatest('mini',A),false,'the same repeated error is not a new redraw');
});

test('older page, selected detail, expansion and last good data survive arrival and CLI failure', async () => {
  const { model, client, calls } = fixture();
  await model.refresh(); await model.toggleHistory(A); await model.selectDetail(B);
  await model.older('mini', A);
  const oldPage = model.page('mini', A);
  client.list = async () => ({ threads: [thread(A, 31), thread(B)], next_before_sequence: null });
  await model.refresh();
  assert.equal(model.page('mini', A), oldPage);
  assert.equal(model.page('mini', A).before, 30);
  assert.equal(model.hasUpdates('mini', A), true);
  assert.equal(model.isSeen(A, 31), false);
  assert.equal(model.selected, B);
  assert.deepEqual([...model.expanded], [A]);
  assert.equal(calls.filter(c => c[0] === 'show').length, 3, 'refresh never reloads a reading surface');
  client.list = async () => { throw Error('private subprocess diagnostics'); };
  const good = model.threads;
  await model.refresh();
  assert.equal(model.threads, good);
  assert.equal(model.page('mini', A), oldPage);
  assert.match(model.error, /No se pudo/);
  assert.doesNotMatch(model.error, /private/);
  client.show = async () => { throw Error('private'); };
  await model.latest('mini', A);
  assert.equal(model.page('mini', A), oldPage);
  assert.match(model.pageError('mini', A), /No se pudo/);
});

// Match CLI list's descending, exclusive-before, 20-row keyset contract.
function keysetFixture(count) {
  const id = sequence => `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  const rows = new Map(), calls = [];
  const add = (first, last) => { for (let sequence = first; sequence <= last; sequence++) rows.set(id(sequence), thread(id(sequence), sequence)); };
  add(1, count);
  let fail = false;
  const client = { ...fixture().client, async list(before) {
    calls.push(before);
    if (fail) throw Error('private list failure');
    const page = [...rows.values()].filter(row => before === undefined || row.latest_sequence < before)
      .sort((a, b) => b.latest_sequence - a.latest_sequence).slice(0, 20);
    return { threads: page, next_before_sequence: page.length === 20 ? page.at(-1).latest_sequence : null };
  } };
  return { model: new ThreadsModel(client), rows, calls, add, id, setFailure(value) { fail = value; } };
}

async function exhaustList(model) {
  let pages = 0;
  while (model.listCursor !== null && pages++ < 30) await model.refresh(true);
  assert.equal(model.listCursor, null, 'pagination must eventually exhaust');
}

test('refresh catch-up covers >20 arrivals without losing independent older-list progress or reading state', async () => {
  const { model, rows, calls, add, id, setFailure } = keysetFixture(60);
  await model.refresh(); await model.refresh(true);
  const order = model.threads.map(row => row.id), olderCursor = model.listCursor;
  await model.toggleHistory(id(60)); await model.older('mini', id(60)); await model.selectDetail(id(59));
  model.expose('mini', id(60), 10, true);
  const mini = model.page('mini', id(60)), detail = model.page('detail', id(59)), seen = [...model.seen];
  add(61, 105); await model.refresh();
  await model.refresh(true); // Leave the first refresh gap unfinished.
  add(106, 150); await model.refresh();
  add(151, 175); await model.refresh(); // Multiple pending refresh ranges.
  const lastGood = model.threads, retryCursor = model.listCursor;
  setFailure(true); await model.refresh(true);
  assert.equal(model.threads, lastGood);
  assert.equal(model.listCursor, retryCursor);
  assert.match(model.error, /No se pudo/);
  setFailure(false); await exhaustList(model);
  assert.equal(model.error, null);
  assert.equal(model.threads.length, rows.size);
  assert.equal(new Set(model.threads.map(row => row.id)).size, rows.size);
  assert.deepEqual(model.threads.slice(0, order.length).map(row => row.id), order);
  assert.equal(calls.filter(before => before === olderCursor).length, 1, 'saved older traversal resumes once');
  assert.equal(model.page('mini', id(60)), mini);
  assert.equal(model.page('detail', id(59)), detail);
  assert.equal(model.selected, id(59));
  assert.deepEqual([...model.expanded], [id(60)]);
  assert.deepEqual([...model.seen], seen, 'data arrivals never mark events seen');
  const count = calls.length; await model.refresh(true);
  assert.equal(calls.length, count, 'exhausted More is a no-op');
});

test('a known thread becoming active cannot terminate an uncovered refresh gap', async () => {
  const { model, rows, calls, add, id } = keysetFixture(40);
  await model.refresh();
  add(41, 60);
  rows.set(id(39), thread(id(39), 61));
  add(62, 80);
  rows.set(id(40), thread(id(40), 81));
  await model.refresh();
  // Already-loaded card 39 lies inside the continuation, before unseen 41.
  await exhaustList(model);
  assert.equal(model.threads.length, rows.size);
  assert.ok(model.thread(id(41)), 'known IDs do not prove that a numeric interval was covered');
  assert.equal(model.thread(id(39)).latest_sequence, 61);
  assert.equal(model.threads[0].id, id(40));
  assert.equal(calls.filter(before => before === 21).length, 1);
  // A later refresh after exhaustion must also expose a fresh multi-page gap.
  add(82, 125); await model.refresh(); await exhaustList(model);
  assert.equal(model.threads.length, rows.size);
});

test('one refresh at a time; stale asynchronous page replies cannot replace newer reading state', async () => {
  const { model, client } = fixture();
  let resolveList, listCalls = 0;
  client.list = () => { listCalls++; return new Promise(resolve => { resolveList = resolve; }); };
  const pending = model.refresh(); await model.refresh();
  assert.equal(listCalls, 1);
  resolveList({ threads: [thread()], next_before_sequence: null }); await pending;
  let resolveOld;
  client.show = async (id, before) => before ? new Promise(resolve => { resolveOld = resolve; }) :
    { thread: thread(), events: [event(30)], next_before_sequence: 30 };
  await model.toggleHistory(A);
  const older = model.older('mini', A);
  await model.latest('mini', A);
  resolveOld({ thread: thread(), events: [event(10)], next_before_sequence: null }); await older;
  assert.equal(model.page('mini', A).events[0].sequence, 30);
});

test('reference controls omit zero groups and do not count association operations as sessions', async () => {
  const { model, client } = fixture();
  client.list = async () => ({ threads: [thread(A), { ...thread(B), session_count: 0,
    references: [{ kind: 'issue', reference: 'ABC-1' }, { kind: 'pr', reference: 'https://example.test/pr/1' },
      { kind: 'issue', reference: 'ABC-2' }] }], next_before_sequence: null });
  await model.refresh();
  assert.deepEqual(model.referenceGroups(A), [{ kind: 'session', count: 1 }]);
  assert.deepEqual(model.referenceGroups(B), [{ kind: 'issue', count: 2 }, { kind: 'pr', count: 1 }]);
  assert.equal(model.referencesVisible(A, 'session'), false);
  client.sessions = async () => ({ associations: [
    { origin: { agent: 'pi', session_id: A, session_ref: '/tmp/a' }, sequence: 1 },
    { origin: { agent: 'pi', session_id: A, session_ref: '/tmp/a' }, sequence: 2 },
    { origin: { agent: 'codex', session_id: B, session_ref: '/tmp/b' }, sequence: 3 },
  ], next_after_sequence: null });
  await model.toggleReferences(A, 'session');
  assert.equal(model.sessions.get(A).items.length, 2);
});

test('reopening sessions revalidates exhausted caches, retaining last-good pages during pending reads and failures', async () => {
  const { model, client } = fixture();
  const associations = [
    { sequence: 1, origin: { agent: 'pi', session_id: A, session_ref: '/tmp/first' } },
    { sequence: 2, origin: { agent: 'codex', session_id: B, session_ref: '/tmp/second' } },
  ];
  const calls = [];
  const read = async (id, after) => {
    calls.push([id, after]);
    const page = associations.filter(item => after === undefined || item.sequence > after).slice(0, 1);
    return { associations: page, next_after_sequence: page.length === 1 ? page[0].sequence : null };
  };
  client.sessions = read;
  await model.refresh(); await model.toggleReferences(A, 'session');
  await model.loadSessions(A, true); await model.loadSessions(A, true);
  assert.equal(model.sessions.get(A).next_after_sequence, null);
  assert.equal(model.sessions.get(A).items.length, 2);
  associations.push({ sequence: 3, origin: { agent: 'pi', session_id: B, session_ref: '/tmp/third' } });
  client.list = async () => ({ threads: [{ ...thread(A), session_count: 3 }], next_before_sequence: null });
  await model.refresh(); await model.toggleReferences(A, 'session');
  const good = model.sessions.get(A);
  let rejectRead;
  client.sessions = () => new Promise((_resolve, reject) => { rejectRead = reject; });
  const reopening = model.toggleReferences(A, 'session');
  assert.equal(model.pending.has(`sessions:${A}`), true, 'opening a cached panel starts a read');
  assert.equal(model.sessions.get(A), good, 'all cached pages remain visible while revalidating');
  rejectRead(Error('private session diagnostics')); await reopening;
  assert.equal(model.sessions.get(A), good);
  assert.match(model.errors.get(`sessions:${A}`), /No se pudo/);
  assert.doesNotMatch(model.errors.get(`sessions:${A}`), /private/);
  client.sessions = read;
  await model.loadSessions(A); // Explicit retry restarts normal pagination.
  while (model.sessions.get(A).next_after_sequence !== null) await model.loadSessions(A, true);
  assert.equal(model.sessions.get(A).items.length, 3);
  assert.equal(model.errors.has(`sessions:${A}`), false);
  assert.deepEqual(model.referenceGroups(A), [{ kind: 'session', count: 3 }]);
  await model.toggleReferences(A, 'session'); await model.toggleReferences(A, 'session');
  assert.deepEqual(calls.at(-1), [A, undefined], 'successful cached reopen also revalidates from the first page');
  assert.equal(model.seen.size, 0);
});

test('explicit session links stay discoverable without miscounting them as distinct attributed sessions', async () => {
  const { model, client } = fixture();
  client.list = async () => ({ threads: [{ ...thread(A), references: [
    { kind: 'session', reference: 'https://example.test/session' }], session_count: 1 }], next_before_sequence: null });
  await model.refresh();
  assert.deepEqual(model.referenceGroups(A), [{ kind: 'session', count: 1, links: 1 }]);
});

test('malformed saved view state cannot prevent loading history', async () => {
  const { client } = fixture();
  const model = new ThreadsModel(client, { pages: [null, 5, {}, ['mini:' + A, { before: -1, back: [] }]],
    seen: [false, {}, 'bad'], expanded: [null, {}, A], selected: 45 });
  await model.refresh(); await model.restore();
  assert.equal(model.selected, null);
  assert.deepEqual([...model.expanded], [A]);
  assert.equal(model.page('mini', A).before, null);
});

test('version-scoped review and validation labels identify every object/version/digest without inherited approval', () => {
  const targets = [
    { object_id: 'plan', version: 'v1', digest: 'sha256:first' },
    { object_id: 'report', version: 'v1', digest: 'sha256:first' },
    { object_id: 'plan', version: 'v1', digest: 'sha256:second' },
    { object_id: 'plan', digest: 'sha256:only' },
    { object_id: 'unversioned-plan' },
  ];
  for (const kind of ['review', 'validation']) {
    const labels = targets.map(target => reviewLabel({ ...event(1), [kind]: { target,
      ...(kind === 'review' ? { disposition: 'approved', instruction: 'Review v1' } : { outcome: 'passed' }) } }));
    assert.equal(new Set(labels).size, targets.length, `${kind} targets must remain distinguishable`);
    for (const [index, target] of targets.entries()) {
      for (const value of Object.values(target)) assert.ok(labels[index].includes(value), `${kind} omitted ${value}`);
      assert.match(labels[index], /registrada/);
      assert.match(labels[index], kind === 'review' ? /solo este objeto\/versión/ : /no verifica el contenido actual/);
    }
    assert.match(labels.at(-1), /sin versión verificable/);
    assert.doesNotMatch(labels[3], /sin versión verificable/, 'a digest alone scopes the recorded target');
    assert.doesNotMatch(reviewLabel({ ...event(2), evidence: [{ target: { ...targets[0], version: 'v2' } }] }), /aprob|pasó/i);
  }
  assert.match(reviewLabel({ review: { disposition: 'changes_requested', target: targets[0] } }), /cambios solicitados/);
  assert.match(reviewLabel({ validation: { outcome: 'failed', target: targets[0] } }), /falló/);
});

test('references are inert data unless explicit safe action; commands, credentials and hostile schemes are rejected', () => {
  for (const reference of ['javascript:alert(1)', 'data:text/html,hi', '//evil.test/a', 'https://user:pass@a.test',
    'file://evil.test/a', 'https://a.test/\ncmd', '/tmp/a\ncommand']) assert.equal(referenceAction(reference), null, reference);
  assert.deepEqual(referenceAction('https://example.test/$(touch nope)'), { kind: 'browser', value: 'https://example.test/$(touch nope)' });
  assert.deepEqual(referenceAction('/tmp/a.command'), { kind: 'reveal', value: '/tmp/a.command' });
  assert.deepEqual(referenceAction('file:///tmp/a%20b'), { kind: 'reveal', value: '/tmp/a b' });
  assert.equal(referenceAction('ABC-1'), null);
});

test('CLI client enforces trusted configuration, bounded argv-only reads, version/envelope failures and redaction', async () => {
  const calls = [];
  const client = createClient(async (...args) => { calls.push(args); return { code: 0, stderr: '', stdout: JSON.stringify({
    contract_version: 1, ok: true, result: { threads: [], next_before_sequence: null } }) }; }, { cli: '/tmp/threads path', dataDir: '/tmp/private data' });
  await client.list();
  assert.deepEqual(calls[0], ['/tmp/threads path', ['--data-dir', '/tmp/private data', 'list', '--limit', '20', '--include-references']]);
  for (const config of [{ cli: 'sh -c evil' }, { dataDir: 'relative' }, { cli: '/tmp/a\ncmd' }]) assert.throws(() => createClient(() => {}, config));
  await assert.rejects(client.show('$(evil)'), /lectura/);
  for (const result of [{ code: 0, stdout: '{}', stderr: '' }, { code: 6, stdout: 'private', stderr: 'secret' },
    { code: 0, stdout: JSON.stringify({ contract_version: 2, ok: true, result: {} }), stderr: '' }]) {
    await assert.rejects(createClient(async () => result).list(), error => !/private|secret/.test(error.message));
  }
});

test('real CLI keyset pages keep refreshed arrivals reachable alongside an unfinished older backlog', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'threads-herdr-list-'));
  try {
    const cli = fileURLToPath(new URL('../bin/threads', import.meta.url)), dataDir = join(temp, 'data');
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }; delete env.CODEX_THREAD_ID;
    const record = (sequence, thread_id) => JSON.parse(execFileSync(process.execPath, [cli, '--data-dir', dataDir,
      '--pi-session-id', A, '--pi-session-ref', join(temp, 'fixture.jsonl'), 'record'], { env, timeout: 10000,
      input: JSON.stringify({ operation_key: `list-${sequence}`, kind: 'progress', body: 'Isolated fixture',
        ...(thread_id ? { thread_id } : {}) }), encoding: 'utf8' })).result.event;
    const ids = [];
    for (let sequence = 1; sequence <= 45; sequence++) ids.push(record(sequence).thread_id);
    const model = new ThreadsModel(createClient(async (command, args) => ({ code: 0, stderr: '', stdout:
      execFileSync(process.execPath, [command, ...args], { env, timeout: 10000, encoding: 'utf8' }) }), { cli, dataDir }));
    await model.refresh(); await model.refresh(true);
    const order = model.threads.map(row => row.id);
    for (let sequence = 46; sequence <= 70; sequence++) ids.push(record(sequence).thread_id);
    record(71, ids[44]); // An already-loaded identity moves into a refreshed page.
    await model.refresh();
    for (let sequence = 72; sequence <= 96; sequence++) ids.push(record(sequence).thread_id);
    await model.refresh(); await exhaustList(model);
    assert.equal(model.threads.length, ids.length);
    assert.deepEqual(new Set(model.threads.map(row => row.id)), new Set(ids));
    assert.deepEqual(model.threads.slice(0, order.length).map(row => row.id), order);
    assert.equal(model.seen.size, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('real CLI -> client -> model uses isolated data, aggregate session counts and versioned evidence', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'threads-herdr-'));
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const cli = join(root, 'bin/threads');
    const env = { ...process.env }; delete env.CODEX_THREAD_ID;
    const record = (key, changes = {}) => JSON.parse(execFileSync(process.execPath, [cli, '--data-dir', join(temp, 'data'),
      '--pi-session-id', A, '--pi-session-ref', join(temp, 'fixture.jsonl'), 'record'], { env, timeout: 10000,
      input: JSON.stringify({ operation_key: key, kind: 'progress', body: 'Fixture', ...changes }), encoding: 'utf8' })).result.event;
    const target = { object_id: 'plan', version: 'v1', digest: 'sha256:fixture-v1' };
    const first = record('first', { kind: 'review_finding', review: { target, disposition: 'approved', instruction: 'Review plan v1' },
      evidence: [{ kind: 'document', reference: '/tmp/fixture-plan.md', target, availability: 'available' }] });
    record('second', { thread_id: first.thread_id, evidence: [{ kind: 'document', reference: '/tmp/fixture-plan.md',
      target: { ...target, version: 'v2', digest: 'sha256:fixture-v2' }, availability: 'unknown' }] });
    const client = createClient(async (command, args) => ({ code: 0, stderr: '', stdout: execFileSync(process.execPath,
      [command, ...args], { input: '', env, timeout: 10000, encoding: 'utf8' }) }), { cli, dataDir: join(temp, 'data') });
    const model = new ThreadsModel(client);
    await model.refresh();
    assert.equal(model.threads.length, 1);
    assert.equal(model.threads[0].session_count, 1, 'two records from the same session count once');
    await model.selectDetail(first.thread_id);
    const events = model.page('detail', first.thread_id).events;
    assert.equal(events.length, 2);
    assert.equal(reviewLabel(events[0]), '', 'v2 does not inherit v1 approval');
    for (const value of Object.values(target)) assert.ok(reviewLabel(events[1]).includes(value));
    assert.equal(model.expose('detail', first.thread_id, events[0].sequence, true), true);
    assert.equal(reviewLabel(events[0]), '', 'exposure creates no review');
    assert.equal(model.isSeen(first.thread_id, first.sequence), false);
    await model.toggleReferences(first.thread_id, 'session');
    assert.equal(model.sessions.get(first.thread_id).items.length, 1);
    execFileSync(process.execPath, [cli, '--data-dir', join(temp, 'data'), '--pi-session-id', B, '--pi-session-ref',
      join(temp, 'second-fixture.jsonl'), 'associate'], { env, timeout: 10000, encoding: 'utf8',
      input: JSON.stringify({ thread_id: first.thread_id, operation_key: 'second-origin' }) });
    await model.refresh();
    assert.equal(model.referenceGroups(first.thread_id).find(group => group.kind === 'session').count, 2);
    await model.toggleReferences(first.thread_id, 'session'); await model.toggleReferences(first.thread_id, 'session');
    assert.equal(model.sessions.get(first.thread_id).items.length, 2, 'reopening revalidates real association growth');
  } finally { await rm(temp, { recursive: true, force: true }); }
});
