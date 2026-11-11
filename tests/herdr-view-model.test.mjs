// Pure projections plus real read-only CLI/temporary SQLite integration; not live UI proof.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ThreadsModel, createClient, referenceAction, reviewLabel } from '../mods/threads/view-model.js';

import * as presentation from '../mods/threads/view-model.js';

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

test('latest activity raises existing threads while preserving reading state and unchanged row identity', async () => {
  const { model, client } = fixture();
  const C = '33333333-3333-4333-8333-333333333333';
  const D = '44444444-4444-4444-8444-444444444444';
  client.list = async () => ({ threads: [thread(A, 30), thread(B, 20)], next_before_sequence: null });
  await model.refresh(); await model.toggleHistory(A); await model.selectDetail(B);
  const originalA = model.thread(A), mini = model.page('mini', A), detail = model.page('detail', B);
  client.list = async () => ({ threads: [thread(B, 33), thread(C, 32), thread(D, 31), thread(A, 30)], next_before_sequence: null });
  assert.equal(await model.refresh(), true);
  assert.deepEqual(model.threads.map(row => row.id), [B, C, D, A]);
  assert.equal(model.thread(B).latest_sequence, 33, 'an existing thread update leads new arrivals with older activity');
  assert.equal(model.thread(A), originalA, 'unchanged rows retain their identity');
  assert.equal(model.page('mini', A), mini);
  assert.equal(model.page('detail', B), detail);
  assert.equal(model.selected, B);
  assert.deepEqual([...model.expanded], [A]);
  assert.equal(model.seen.size, 0);
  const list = model.threads;
  assert.equal(await model.refresh(), false);
  assert.equal(model.threads, list, 'unchanged polls do not recreate or reorder the list');
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

test('open mini histories hold background changes until explicit update, preserving historical and last-good pages', async () => {
  const {model,client,calls}=fixture();
  await model.refresh(); await model.toggleHistory(A); await model.selectDetail(B);
  await model.older('detail',B);
  const historical=model.page('detail',B);
  client.list=async()=>({threads:[thread(A,31),thread(B,31)],next_before_sequence:null});
  client.show=async(id,before)=>{calls.push(['show',id,before]);return {thread:thread(id,31),events:[event(31,id),event(30,id)],next_before_sequence:30};};
  await model.refresh();
  assert.equal(await model.refreshLatest('mini',A),false, 'background updates cannot insert text into an open mini history');
  assert.deepEqual(model.page('mini',A).events.map(event=>event.sequence),[30]);
  await model.updateReading();
  assert.deepEqual(model.page('mini',A).events.map(event=>event.sequence),[31,30]);
  assert.equal(await model.refreshLatest('detail',B),false);
  assert.equal(model.page('detail',B),historical);
  assert.equal(model.isSeen(A,31),false);
  const good=model.page('mini',A);
  client.list=async()=>({threads:[thread(A,32)],next_before_sequence:null});
  await model.refresh(); client.show=async()=>{throw Error('private');};
  assert.equal(await model.refreshLatest('mini',A),false,'the paused page is not fetched in the background');
  await model.updateReading();
  assert.equal(model.page('mini',A),good);
  assert.match(model.pageError('mini',A), /No se pudo/);
  assert.equal(await model.refreshLatest('mini',A),false,'the failed manual refresh does not enable automatic retries');
});

test('multiple open histories hold list snapshots and unread work until the last visible history closes', async () => {
  const { model, client } = fixture();
  client.list = async () => ({ threads: [thread(A, 30), thread(B, 20)], next_before_sequence: null });
  await model.refresh(); await model.toggleHistory(A); await model.toggleHistory(B);
  const visible = model.visibleThreads, miniA = model.page('mini', A), miniB = model.page('mini', B);
  client.list = async () => ({ threads: [thread(B, 31), thread(A, 30)], next_before_sequence: null });
  await model.refresh();
  assert.deepEqual(model.threads.map(row => row.id), [B, A], 'live metadata continues to arrive');
  assert.equal(model.visibleThreads, visible, 'visible rows and their metadata are the original snapshot');
  assert.equal(model.readingPaused, true);
  assert.equal(model.hasPendingUpdates, true);
  assert.equal(await model.refreshLatest('mini', B), false);
  assert.equal(model.page('mini', A), miniA);
  assert.equal(model.page('mini', B), miniB);
  assert.equal(model.markRead(B), true);
  assert.equal(model.isSeen(B, 30), true, 'the visible loaded mini snapshot may be marked read');
  assert.equal(model.isSeen(B, 31), false, 'unshown pending advances stay unread');
  await model.toggleHistory(A);
  assert.equal(model.readingPaused, true);
  assert.deepEqual(model.visibleThreads.map(row => row.id), [A, B]);
  await model.toggleHistory(B);
  assert.equal(model.readingPaused, false);
  assert.equal(model.visibleThreads, model.threads);
  assert.equal(model.hasPendingUpdates, false);
  client.show = async id => ({ thread: thread(id, 31), events: [event(31, id)], next_before_sequence: null });
  await model.toggleHistory(B);
  assert.equal(model.page('mini', B).loadedLatest, 31, 'reopening refreshes a stale latest page before holding it');
});

test('explicit update rebases open reading without closing it or navigating away from historical pages', async () => {
  const { model, client } = fixture();
  client.list = async () => ({ threads: [thread(A, 30), thread(B, 20)], next_before_sequence: null });
  await model.refresh(); await model.toggleHistory(A); await model.toggleHistory(B); await model.older('mini', A);
  const historical = model.page('mini', A);
  client.list = async () => ({ threads: [thread(B, 33), thread(A, 32)], next_before_sequence: null });
  client.show = async id => ({ thread: thread(id, 33), events: [event(33, id)], next_before_sequence: null });
  await model.updateReading();
  assert.deepEqual(model.visibleThreads.map(row => row.id), [B, A]);
  assert.equal(model.readingPaused, true);
  assert.deepEqual([...model.expanded], [A, B]);
  assert.equal(model.page('mini', A), historical);
  assert.equal(model.page('mini', B).loadedLatest, 33);
  assert.equal(model.hasPendingUpdates, false, 'intentional historical pages are not treated as failed refreshes');
  client.list = async () => ({ threads: [thread(A, 34), thread(B, 33)], next_before_sequence: null });
  await model.refresh();
  assert.deepEqual(model.visibleThreads.map(row => row.id), [B, A], 'an explicit update starts a new protected snapshot');
  assert.equal(model.hasPendingUpdates, true);
});

test('a failed explicit list update preserves reading and a successful retry applies pending work', async () => {
  const { model, client } = fixture();
  await model.refresh(); await model.toggleHistory(A);
  const held = model.visibleThreads, mini = model.page('mini', A);
  client.list = async () => { throw Error('private'); };
  await model.updateReading();
  assert.equal(model.visibleThreads, held);
  assert.equal(model.page('mini', A), mini);
  assert.match(model.error, /No se pudo/);
  client.list = async () => ({ threads: [thread(A, 31)], next_before_sequence: null });
  client.show = async () => ({ thread: thread(A, 31), events: [event(31)], next_before_sequence: null });
  await model.updateReading();
  assert.equal(model.error, null);
  assert.equal(model.page('mini', A).loadedLatest, 31);
  assert.equal(model.hasPendingUpdates, false);
});

test('manual update joins a background list read and ignores duplicate update clicks', async () => {
  const { model, client } = fixture();
  await model.refresh(); await model.toggleHistory(A);
  let resolve, reads = 0;
  client.list = () => ++reads === 1 ? new Promise(done => { resolve = done; }) :
    Promise.resolve({ threads: [thread(A, 32)], next_before_sequence: null });
  client.show = async () => ({ thread: thread(A, 32), events: [event(32)], next_before_sequence: null });
  const polling = model.refresh(), update = model.updateReading(), duplicate = model.updateReading();
  resolve({ threads: [thread(A, 31)], next_before_sequence: null });
  await Promise.all([polling, update, duplicate]);
  assert.equal(reads, 2);
  assert.equal(model.visibleThreads.find(row => row.id === A).latest_sequence, 32);
  assert.equal(model.page('mini', A).loadedLatest, 32);
  assert.equal(model.hasPendingUpdates, false);
});

test('a failed mini update keeps the protected rows and visible read boundary until retry succeeds', async () => {
  const { model, client } = fixture();
  await model.refresh(); await model.toggleHistory(A);
  const held = model.visibleThreads, good = model.page('mini', A);
  client.list = async () => ({ threads: [thread(A, 31)], next_before_sequence: null });
  client.show = async () => { throw Error('private'); };
  await model.updateReading();
  assert.equal(model.visibleThreads, held);
  assert.equal(model.page('mini', A), good);
  assert.equal(model.hasPendingUpdates, true);
  assert.equal(model.markRead(A), true);
  assert.equal(model.isSeen(A, 31), false);
  client.show = async () => ({ thread: thread(A, 31), events: [event(31)], next_before_sequence: null });
  await model.updateReading();
  assert.equal(model.visibleThreads.find(row => row.id === A).latest_sequence, 31);
  assert.equal(model.hasPendingUpdates, false);
});

test('late manual refreshes cannot release a reading snapshot opened after the refresh began', async () => {
  const { model, client } = fixture();
  await model.refresh(); await model.toggleHistory(A);
  let resolve;
  client.list = () => new Promise(done => { resolve = done; });
  const pending = model.updateReading();
  await model.toggleHistory(A); await model.toggleHistory(B);
  const held = model.visibleThreads;
  resolve({ threads: [thread(B, 31)], next_before_sequence: null });
  await pending;
  assert.equal(model.visibleThreads, held);
  assert.equal(model.hasPendingUpdates, true);
  assert.equal(model.page('mini', B).loadedLatest, 30);
});

test('a manual refresh started before mini pagination cannot displace the newly chosen historical page', async () => {
  const { model, client } = fixture();
  await model.refresh(); await model.toggleHistory(A);
  const held = model.visibleThreads;
  let resolve;
  client.list = () => new Promise(done => { resolve = done; });
  const update = model.updateReading();
  await model.older('mini', A);
  const historical = model.page('mini', A);
  resolve({ threads: [thread(A, 31)], next_before_sequence: null });
  await update;
  assert.equal(model.visibleThreads, held);
  assert.equal(model.page('mini', A), historical);
  assert.equal(model.page('mini', A).before, 30);
});

test('restored offscreen expansions do not freeze a list with no visible reading history', async () => {
  const { client } = fixture();
  client.list = async () => ({ threads: [thread(B, 20)], next_before_sequence: null });
  const model = new ThreadsModel(client, { expanded: [A] });
  await model.refresh();
  assert.equal(model.readingPaused, false);
  client.list = async () => ({ threads: [thread(B, 21)], next_before_sequence: null });
  await model.refresh();
  assert.equal(model.visibleThreads[0].latest_sequence, 21);
  await model.toggleHistory(B);
  assert.equal(model.readingPaused, true);
  await model.toggleHistory(B);
  assert.equal(model.readingPaused, false, 'an offscreen restored ID cannot keep the list paused');
});

test('Update refreshes a restored expansion that becomes visible with queued arrivals', async () => {
  const { client } = fixture();
  client.list = async () => ({ threads: [thread(A, 30)], next_before_sequence: null });
  const model = new ThreadsModel(client, { expanded: [B] });
  await model.refresh(); await model.ensurePage('mini', B); await model.toggleHistory(A);
  client.list = async () => ({ threads: [thread(B, 31), thread(A, 30)], next_before_sequence: null });
  client.show = async id => ({ thread: thread(id, id === B ? 31 : 30), events: [event(id === B ? 31 : 30, id)], next_before_sequence: null });
  await model.refresh();
  assert.deepEqual(model.visibleThreads.map(row => row.id), [A]);
  await model.updateReading();
  assert.deepEqual(model.visibleThreads.map(row => row.id), [B, A]);
  assert.equal(model.page('mini', B).loadedLatest, 31);
  assert.equal(model.hasPendingUpdates, false);
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

test('More can append older rows below protected reading without exposing queued head arrivals', async () => {
  const { model, add, id } = keysetFixture(40);
  await model.refresh(); await model.toggleHistory(id(40));
  const original = model.visibleThreads.map(row => row.id), page = model.page('mini', id(40));
  add(41, 65); await model.refresh(); await exhaustList(model);
  assert.deepEqual(model.visibleThreads.slice(0, original.length).map(row => row.id), original);
  assert.equal(model.visibleThreads.length, 40);
  assert.equal(model.visibleThreads.at(-1).id, id(1));
  assert.equal(model.threads.length, 65);
  assert.equal(model.hasPendingUpdates, true);
  assert.equal(model.page('mini', id(40)), page);
  await model.toggleHistory(id(40));
  assert.equal(model.visibleThreads.length, 65);
  assert.equal(model.visibleThreads[0].id, id(65));
});

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
  assert.deepEqual(model.threads.map(row => row.id), Array.from({ length: rows.size }, (_, index) => id(rows.size - index)),
    'catch-up pages fill their original head gap above existing threads, not below them');
  assert.deepEqual(model.threads.filter(row => order.includes(row.id)).map(row => row.id), order);
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
  assert.equal(model.threads[0].id, id(40), 'the most recent update leads regardless of creation time');
  assert.ok(model.threads.findIndex(row => row.id === id(39)) < model.threads.findIndex(row => row.id === id(60)),
    'an existing thread also rises when discovered inside a catch-up page');
  const sequences = model.threads.map(row => row.latest_sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => b - a));
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

test('session reads accept native opaque IDs/null locators and keep distinct actors', async () => {
  const origin={agent:'opencode',session_id:'ses_native_fixture',session_ref:null};
  const associations=[origin,origin,{...origin,actor_id:'native-child-a'},{...origin,actor_id:'native-child-b'}]
    .map((value,index)=>({thread_id:A,sequence:index+1,origin:value}));
  const client=createClient(async()=>({code:0,stderr:'',stdout:JSON.stringify({contract_version:1,ok:true,result:{associations,next_after_sequence:null}})}));
  const model=new ThreadsModel(client);await model.loadSessions(A);
  assert.equal(model.errors.has(`sessions:${A}`),false);assert.equal(model.sessions.get(A).items.length,3);
  assert.equal(model.sessions.get(A).items[0].origin.session_id,'ses_native_fixture');
  associations[0]={thread_id:A,sequence:1,origin:{agent:'pi',session_id:'not-a-uuid',session_ref:null}};
  await assert.rejects(client.sessions(A),/No se pudo/);
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
    await model.refresh(); await model.refresh(true); await model.toggleHistory(ids[44]);
    const held = model.visibleThreads.map(row => row.id), reading = model.page('mini', ids[44]);
    for (let sequence = 46; sequence <= 70; sequence++) ids.push(record(sequence).thread_id);
    record(71, ids[25]); // A lower, already-loaded thread receives the newest advance.
    await model.refresh();
    assert.equal(model.threads[0].id, ids[25], 'real CLI activity raises a lower existing thread');
    for (let sequence = 72; sequence <= 96; sequence++) ids.push(record(sequence).thread_id);
    await model.refresh(); await exhaustList(model);
    assert.equal(model.threads.length, ids.length);
    assert.deepEqual(new Set(model.threads.map(row => row.id)), new Set(ids));
    assert.equal(model.threads[0].id, ids.at(-1));
    const sequences = model.threads.map(row => row.latest_sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => b - a));
    assert.equal(model.thread(ids[25]).latest_sequence, 71);
    assert.deepEqual(model.visibleThreads.slice(0, held.length).map(row => row.id), held);
    assert.equal(model.page('mini', ids[44]), reading);
    assert.equal(model.hasPendingUpdates, true);
    assert.equal(model.markRead(ids[25]), true);
    assert.equal(model.isSeen(ids[25], 71), false, 'real pending records remain unread');
    await model.updateReading();
    assert.equal(model.visibleThreads, model.threads);
    assert.equal(model.hasPendingUpdates, false);
    assert.deepEqual([...model.expanded], [ids[44]]);
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
