// Native builder/event fixtures only. herdr-app check and live host gates are separate.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ThreadsModel } from '../mods/threads/view-model.js';

const nativeTypes = readFileSync(join(process.env.HERDR_APP_HOME ?? join(homedir(), '.config/herdr-app'), 'gpui-kit.d.ts'), 'utf8');

class Element {
  constructor(kind, id) { this.kind = kind; this.attrs = { id }; this.nodes = []; this.handlers = {}; }
  child(node) { this.nodes.push(node); return this; }
  children(nodes) { this.nodes.push(...nodes); return this; }
  on_click(fn) { this.handlers.click = fn; return this; }
  on_hover(fn) { this.handlers.hover = fn; return this; }
}
const builder = (kind, id) => new Proxy(new Element(kind, id), { get(target, key, receiver) {
  if (key in target) return Reflect.get(target, key, receiver);
  if (typeof key === 'symbol') return undefined;
  assert.ok(new RegExp(`\\b${key}(?:<[^\\n]*>)?\\s*\\(`).test(nativeTypes), `Unsupported installed GPUI method: ${key}`);
  return (...args) => {
    target.attrs[key] = args[0];
    if (key === 'spring' || key === 'transition') {
      (target.attrs.motion ??= {})[args[0]] = { kind: key, ...args[1] };
    }
    if (['items_center', 'items_start', 'items_stretch'].includes(key)) target.attrs.align_items = key.slice(6);
    return receiver;
  };
} });
const calls = [], saved = new Map(), sharedValues = new Map(), nativeCommands = [];
let execResult = null, nativeProps = {}, nativeSpaces = [], nativePanes = [], nativeFocus = null, tabSequence = 0, storageWrites = 0;
function selectTab(id) {
  for (const space of nativeSpaces) {
    if (!space.tabs.some(tab => tab.id === id)) continue;
    for (const candidate of nativeSpaces) candidate.active = candidate.id === space.id;
    for (const tab of space.tabs) tab.active = tab.id === id;
    const pane = nativePanes.find(pane => pane.tab === id);
    nativeFocus = { space: space.id, tab: id, pane: pane?.pane, terminal: pane?.terminal ?? null };
  }
}
globalThis.__threadsNative = {
  View: class {}, div: () => builder('div'),
  // Installed GPUI h_flex centers columns; v_flex leaves them stretching.
  h_flex: () => builder('row').items_center(), v_flex: () => builder('column').items_stretch(),
  Button: { new: id => builder('button', id) },
  theme: () => ({ surface: '#111111', chrome: '#181818', foreground: '#eeeeee', muted: '#aaaaaa', dim: '#777777', ansi1: '#d06b75', hover: '#242424', border: '#333333', accent: '#abcdef' }),
  props: () => nativeProps,
  shared: key => sharedValues.get(key), setShared: (key, value) => { sharedValues.set(key, value); },
  run: (name, args) => {
    nativeCommands.push([name, args]);
    if (name === 'tab.new') {
      const id = `reader-tab-${++tabSequence}`, space = nativeSpaces.find(space => space.id === args.space);
      space.tabs.push({ id, name: args.name, active: false });
      nativePanes.push({ pane: `reader-pane-${tabSequence}`, tab: id, mod: args.mod, terminal: null });
      selectTab(id);
    } else if (name === 'tab.select') selectTab(args.id);
  },
  spaces: () => nativeSpaces, panes: () => nativePanes, focused: () => nativeFocus,
  layout: () => ({ id: 'root', type: 'row', children: [{ id: 'work', type: 'column' }, { id: 'threads-reader', type: 'block' }] }),
  exec: async (...args) => { calls.push(args); return execResult ?? { code: 0, stderr: '', stdout: JSON.stringify({
    contract_version: 1, ok: true, result: { threads: [], next_before_sequence: null } }) }; },
};
const hook = registerHooks({ resolve(specifier, context, next) {
  const exports = { 'gpui-kit': ['View', 'div'], 'gpui-base': ['h_flex', 'v_flex', 'Button'], herdr: ['exec', 'theme', 'shared', 'setShared', 'run', 'layout', 'props', 'spaces', 'panes', 'focused'] }[specifier];
  if (!exports) return next(specifier, context);
  return { url: 'data:text/javascript,' + encodeURIComponent(exports.map(name => `export const ${name} = globalThis.__threadsNative.${name};`).join('\n')), shortCircuit: true };
} });
globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { storageWrites++; saved.set(key, value); } };
const { default: Threads } = await import('../mods/threads/main.js');
hook.deregister();
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
function context() {
  const tasks = [], timers = [];
  let notifications = 0;
  const cx = { notify() { notifications++; }, spawn(fn) { const task = fn(cx); tasks.push(task); return task; },
    timer: { every(ms, fn) { timers.push({ ms, fn }); } } };
  return { cx, tasks, timers, notifications: () => notifications, async flush() { while (tasks.length) await Promise.all(tasks.splice(0)); } };
}
function flatten(node) { return node instanceof Element ? [node, ...node.nodes.flatMap(flatten)] : []; }
const find = (root, id) => { const node = flatten(root).find(node => node.attrs.id === id); assert.ok(node, `missing ${id}`); return node; };
const text = node => node instanceof Element ? node.nodes.map(text).join(' ') : String(node ?? '');
async function setup(config = {}, reset = true) {
  saved.clear();
  if (reset) {
    calls.length = 0; execResult = null; sharedValues.clear(); nativeCommands.length = 0; nativeProps = {}; tabSequence = 0; storageWrites = 0;
    nativeSpaces = [{ id: 'space-1', active: true, tabs: [{ id: 'terminal-tab', name: 'Pi', active: true }] }];
    nativePanes = [{ pane: 'terminal-pane', tab: 'terminal-tab', terminal: 't1' }];
    nativeFocus = { space: 'space-1', tab: 'terminal-tab', pane: 'terminal-pane', terminal: 't1' };
  }
  const view = new Threads(), ctx = context();
  view.init(config, ctx.cx);
  await ctx.flush(); // Finish startup before seeding a specific rendered-order fixture.
  view.model.threads = [A, B].map((id, index) => ({ id, title: `Trabajo ${index}`, summary: 'Avance',
    latest_sequence: index + 1, event_count: 1, session_count: 1, references: [] }));
  view.model.client.show = async id => ({ thread: view.model.threads.find(t => t.id === id), events: [{
    thread_id: id, sequence: id === A ? 1 : 2, body: 'Untrusted ${code} <script>', summary: 'Untrusted ${code} <script>', kind: 'progress',
    evidence: [{ kind: 'document', reference: 'https://example.test/plan', availability: 'unknown' }],
  }], next_before_sequence: null });
  return { view, ...ctx };
}

test('native Herdr props select the sidebar role even when View.init receives no config', async () => {
  nativeProps = {role:'sidebar',readerId:'threads-reader',channel:'native-config'};
  const {view,cx}=await setup({},false);
  assert.equal(view.role,'sidebar');
  assert.equal(flatten(view.render(cx)).some(node=>node.attrs.id==='threads-detail'),false);
  nativeProps = {};
});

test('embedded section fills its sidebar slot with an independent scroll list and no separate reader', async () => {
  const { view, cx } = await setup({ role: 'section' });
  const tree = view.render(cx);
  assert.equal(view.role, 'section');
  assert.ok(Object.hasOwn(find(tree, 'threads-sidebar').attrs, 'size_full'));
  assert.equal(find(tree, 'threads-sidebar').attrs.max_h, undefined, 'the section uses its assigned height');
  assert.ok(Object.hasOwn(find(tree, 'threads-cards').attrs, 'overflow_y_scrollbar'));
  assert.equal(find(tree, 'threads-root').attrs.bg, '#181818', 'matches the existing sidebar chrome');
  assert.equal(flatten(tree).some(node => node.attrs.id === 'threads-detail'), false);
  assert.deepEqual(nativeCommands, []);
});

test('compact reading holds motion until explicit update retargets springs without closing history', async () => {
  const { view, cx, flush, timers, notifications } = await setup({ role: 'section' });
  await view.model.toggleHistory(A); await view.model.selectDetail(B);
  let tree = view.render(cx);
  assert.equal(typeof find(tree, `card-${A}`).attrs.on_size_change, 'function');
  find(tree, `card-${A}`).attrs.on_size_change({ width: 240, height: 96 }, cx);
  tree = view.render(cx);
  assert.equal(find(tree, `card-${A}`).attrs.top, 0);
  assert.equal(find(tree, `card-${B}`).attrs.top, 96);
  assert.equal(find(tree, 'threads-motion').attrs.h, 126);
  const mini = view.model.page('mini', A), detail = view.model.page('detail', B);
  view.model.client.list = async () => ({ threads: [{ ...view.model.thread(B), latest_sequence: 3 }], next_before_sequence: null });
  view.poll(cx); await flush();
  tree = view.render(cx);
  assert.deepEqual(view.model.threads.map(thread => thread.id), [B, A]);
  assert.equal(find(tree, `card-${A}`).attrs.top, 0);
  assert.equal(find(tree, `card-${B}`).attrs.top, 96);
  assert.equal(text(find(tree, 'pending-thread-updates')), '·');
  for (const id of [A, B]) {
    const row = find(tree, `card-${id}`);
    assert.ok(Object.hasOwn(row.attrs, 'absolute'));
    assert.deepEqual(row.attrs.motion.top, { kind: 'spring', response: 280, damping: 1 });
  }
  assert.equal(find(tree, 'threads-motion').attrs.h, 126);
  assert.equal(view.model.page('mini', A), mini);
  assert.equal(view.model.page('detail', B), detail);
  assert.equal(view.model.selected, B);
  assert.deepEqual([...view.model.expanded], [A]);
  assert.equal(view.model.seen.size, 0);
  assert.equal(view.model.isSeen(B, 3), false);
  assert.deepEqual(timers.map(timer => timer.ms), [5000], 'no script-side frame timer');
  const count = notifications();
  view.poll(cx); await flush();
  assert.equal(notifications(), count, 'an unchanged poll does not restart script work');
  find(tree, 'refresh-threads').handlers.click({}, cx); await flush();
  tree = view.render(cx);
  assert.equal(find(tree, `card-${B}`).attrs.top, 0);
  assert.equal(find(tree, `card-${A}`).attrs.top, 30);
  assert.equal(text(find(tree, 'pending-thread-updates')), '');
  assert.deepEqual([...view.model.expanded], [A]);
  assert.equal(view.model.page('mini', A), mini);
});

test('compact motion measures real expanded heights and ignores hidden, invalid and unchanged sizes', async () => {
  const { view, cx, notifications } = await setup({ role: 'section' });
  let tree = view.render(cx);
  const measure = find(tree, `card-${A}`).attrs.on_size_change;
  assert.equal(typeof measure, 'function');
  const count = notifications();
  for (const height of [0, -1, NaN, Infinity, 30, 30.1]) measure({ width: 240, height }, cx);
  assert.equal(notifications(), count);
  measure({ width: 240, height: 60 }, cx);
  assert.equal(notifications(), count + 1);
  measure({ width: 240, height: 60 }, cx);
  assert.equal(notifications(), count + 1);
  tree = view.render(cx);
  assert.equal(find(tree, `card-${B}`).attrs.top, 60);
  assert.equal(find(tree, 'threads-motion').attrs.h, 90);
  measure({ width: 180, height: 75 }, cx);
  tree = view.render(cx);
  assert.equal(find(tree, `card-${B}`).attrs.top, 75);
  assert.equal(find(tree, 'threads-motion').attrs.h, 105);
  measure({ width: 180, height: 30 }, cx);
  assert.equal(find(view.render(cx), `card-${B}`).attrs.top, 30);
});

test('section uses native-style one-line rows, neutral separate controls and no summary card', async () => {
  const { view, cx } = await setup({ role: 'section' });
  view.model.threads[0].title = 'A long work title that must fit inside the existing sidebar';
  view.model.threads[0].summary = 'The latest work summary must not repeat above the timeline.';
  const tree = view.render(cx), row = find(tree, `thread-row-${A}`), title = find(tree, `title-${A}`);
  assert.equal(row.attrs.h, 30);
  assert.equal(row.handlers.click, undefined);
  assert.equal(title.handlers.click, undefined);
  assert.ok(Object.hasOwn(title.attrs, 'truncate'));
  assert.equal(title.attrs.tooltip, view.model.threads[0].title);
  assert.doesNotMatch(text(tree), /latest work summary/);
  const history = find(tree, `history-${A}`), detail = find(tree, `detail-${A}`);
  assert.equal(text(history), '▸');
  assert.equal(text(detail), '›');
  assert.equal(history.attrs.tooltip, 'Historial');
  assert.match(history.attrs.accessibility_label, /Historial cerrado/);
  assert.match(detail.attrs.accessibility_label, /Ver detalle/);
  assert.equal(history.attrs.text_color, '#777777');
  assert.equal(detail.attrs.text_color, '#777777');
  assert.equal(find(tree, 'threads-heading').attrs.h, 31);
  assert.equal(find(tree, 'threads-cards').attrs.px, 8);
});

test('compact mini histories have single-line captions, attachment counts and no nested scroll viewport', async () => {
  const { view, cx, flush } = await setup({ role: 'section' });
  const summary = 'La UI ya funciona dentro del sidebar.';
  view.model.threads[0].summary = summary;
  view.model.client.show = async id => ({ thread: view.model.thread(id), events: [{ thread_id: id,
    sequence: id === A ? 1 : 2, kind: 'progress', summary, body: 'Original source body',
    received_at: '2026-11-10T17:57:00Z', evidence: [
      { kind: 'document', reference: '/tmp/usage-private.md' },
      { kind: 'report', reference: '/tmp/report-private.md' },
    ],
  }], next_before_sequence: null });
  for (const id of [A, B]) {
    find(view.render(cx), `history-${id}`).handlers.click({}, cx); await flush();
  }
  let tree = view.render(cx);
  assert.equal(text(find(tree, `card-${A}`)).split(summary).length - 1, 1, 'summary appears only in its milestone');
  for (const id of [A, B]) {
    const reading = find(tree, `reading-mini-${id}-latest`), row = find(tree, `event-mini-${id}-${id === A ? 1 : 2}`);
    assert.equal(reading.attrs.h, undefined);
    assert.equal(reading.attrs.max_h, undefined);
    assert.equal(Object.hasOwn(reading.attrs, 'overflow_y_scrollbar'), false, 'the section already owns scrolling');
    assert.ok(Object.hasOwn(reading.attrs, 'flex_none'));
    assert.match(text(row), /2 adjuntos/);
    assert.doesNotMatch(text(row), /usage-private|report-private|Original source body/);
    assert.ok(flatten(row).some(node => Object.hasOwn(node.attrs, 'truncate')));
    assert.equal(row.handlers.click, undefined);
  }
  assert.equal(view.model.seen.size, 0);
  assert.equal(find(tree, `event-mini-${A}-1`).handlers.hover, undefined);
  find(tree, `mark-read-${A}`).handlers.click({}, cx);
  assert.equal(view.model.isSeen(A, 1), true);
  assert.equal(view.model.isSeen(B, 2), false);
  find(tree, `detail-${A}`).handlers.click({}, cx); await flush();
  view.render(cx);
  const page = await setup(nativeCommands.find(([name]) => name === 'tab.new')[1].props, false);
  page.view.model.client.show = view.model.client.show;
  await page.view.model.loadPage('detail', A, null, []);
  tree = page.view.render(page.cx);
  assert.match(text(tree), /usage-private\.md|report-private\.md/, 'evidence is still accessible in detail');
});

test('compact history keeps original review scope in detail without implying approval from its caption', async () => {
  const { view, cx, flush } = await setup({ role: 'section' });
  view.model.client.show = async id => ({ thread: view.model.thread(id), events: [{ thread_id: id, sequence: 1,
    kind: 'review_finding', body: 'Review source text', summary: 'Se revisó una versión concreta.', evidence: [],
    review: { target: { object_id: 'plan', version: 'v1', digest: 'sha256:original' }, disposition: 'approved' },
  }], next_before_sequence: null });
  find(view.render(cx), `history-${A}`).handlers.click({}, cx); await flush();
  let tree = view.render(cx);
  assert.doesNotMatch(text(find(tree, `event-mini-${A}-1`)), /aprobación|approved|sha256|Objeto, versión/);
  find(tree, `detail-${A}`).handlers.click({}, cx); await flush();
  view.render(cx);
  const page = await setup(nativeCommands.find(([name]) => name === 'tab.new')[1].props, false);
  page.view.model.client.show = view.model.client.show;
  await page.view.model.loadPage('detail', A, null, []);
  tree = page.view.render(page.cx);
  find(tree, `metadata-detail-${A}-1`).handlers.click({}, page.cx);
  assert.match(text(page.view.render(page.cx)), /v1.*sha256:original/);
});

test('section opens a reusable native reading tab without replacing the sidebar or closing the terminal', async () => {
  const { view, cx, flush } = await setup({ role: 'section', channel: 'page-fixture' });
  find(view.render(cx), `history-${A}`).handlers.click({}, cx); await flush();
  const mini = view.model.page('mini', A);
  find(view.render(cx), `detail-${B}`).handlers.click({}, cx); await flush();
  let tree = view.render(cx);
  const creation = nativeCommands.find(([name]) => name === 'tab.new');
  assert.ok(creation, 'detail must open in the native workspace, not the narrow section');
  assert.equal(creation[1].mod, 'threads');
  assert.equal(creation[1].props.role, 'page');
  assert.equal(creation[1].space, 'space-1');
  assert.ok(find(tree, 'threads-cards'));
  const page = await setup(creation[1].props, false);
  tree = page.view.render(page.cx); await page.flush(); tree = page.view.render(page.cx);
  assert.equal(page.view.model.selected, B);
  assert.ok(find(tree, 'threads-reading-column'));
  assert.equal(flatten(tree).some(node => node.attrs.id === 'threads-cards'), false);
  const detail = page.view.model.page('detail', B);
  find(tree, 'return-workspace').handlers.click({}, page.cx);
  assert.equal(nativeFocus.tab, 'terminal-tab');
  const reads = calls.length;
  page.timers[0].fn(page.cx); await page.flush();
  assert.equal(calls.length, reads, 'a background reading tab does not poll');
  find(view.render(cx), `detail-${B}`).handlers.click({}, cx); await flush();
  view.render(cx);
  assert.equal(nativeCommands.filter(([name]) => name === 'tab.new').length, 1, 'reuse one reading tab per space');
  assert.equal(nativeFocus.tab, 'reader-tab-1');
  assert.equal(page.view.model.page('detail', B), detail);
  assert.ok(view.model.expanded.has(A));
  assert.equal(view.model.page('mini', A), mini);
  assert.equal(view.model.seen.size, 0);
  assert.ok(nativeCommands.every(([name]) => ['tab.new', 'tab.select'].includes(name)), 'never close, kill, hide or recreate a terminal');
});

test('upgrading section view always restores navigation even with a saved inline detail', async () => {
  for (const sectionDetail of [false, true]) {
    saved.clear(); sharedValues.clear(); nativeProps = {};
    saved.set('threads.view.v1', JSON.stringify({ selected: A, expanded: [B], sectionDetail }));
    const view = new Threads(), ctx = context(), reads = [];
    view.init({ role: 'section' }, ctx.cx);
    view.model.client.show = async id => {
      reads.push(id);
      return { thread: { id, title: 'Trabajo', summary: 'Avance', latest_sequence: 1 }, events: [], next_before_sequence: null };
    };
    await ctx.flush();
    assert.deepEqual(reads, [B], 'the sidebar restores mini histories only; detail belongs in its own page');
    const tree = view.render(ctx.cx);
    assert.ok(find(tree, 'threads-cards'));
    assert.equal(flatten(tree).some(node => node.attrs.id === 'back-threads'), false);
  }
});

test('wide page reads original paragraphs in one bounded column and keeps exact metadata behind disclosure', async () => {
  const sidebar = await setup({ role: 'section' });
  find(sidebar.view.render(sidebar.cx), `detail-${A}`).handlers.click({}, sidebar.cx); await sidebar.flush();
  sidebar.view.render(sidebar.cx);
  const page = await setup(nativeCommands.find(([name]) => name === 'tab.new')[1].props, false);
  page.view.model.client.show = async id => ({ thread: page.view.model.thread(id), events: [{ thread_id: id, sequence: 1,
    kind: 'progress', summary: 'A summary should not repeat the body.',
    body: 'First readable paragraph.\n\nSecond source paragraph with literal <script>.',
    evidence: [{kind:'document',reference:'/tmp/private/path/evidence.md',availability:'unknown'}],
  }], next_before_sequence: null });
  await page.view.model.loadPage('detail', A, null, []);
  let tree = page.view.render(page.cx);
  assert.equal(find(tree, 'threads-reading-column').attrs.max_w, 720);
  assert.ok(flatten(tree).some(node => Object.hasOwn(node.attrs, 'overflow_y_scrollbar')));
  assert.match(text(tree), /First readable paragraph/);
  assert.match(text(tree), /Second source paragraph with literal <script>/);
  assert.doesNotMatch(text(tree), /A summary should not repeat|\/tmp\/private\/path/);
  assert.match(text(tree), /evidence\.md/);
  const paragraphs = flatten(tree).filter(node => node.attrs.id?.startsWith('paragraph-detail-'));
  assert.equal(paragraphs.length, 2);
  assert.ok(paragraphs.every(node => node.attrs.line_height === '25px'));
  assert.equal(page.view.model.seen.size, 0);
  assert.equal(find(tree, `event-detail-${A}-1`).handlers.hover, undefined);
  find(tree, 'mark-read-page').handlers.click({}, page.cx);
  assert.equal(page.view.model.isSeen(A, 1), true);
  find(tree, `record-data-detail-${A}-1`).handlers.click({}, page.cx);
  tree = page.view.render(page.cx);
  assert.match(text(tree), /A summary should not repeat/);
  assert.match(text(tree), /\/tmp\/private\/path\/evidence\.md/);
});

test('reading navigation fails closed without a current Space and keeps missing-workspace errors local', async () => {
  const sidebar = await setup({ role:'section' });
  nativeFocus = null;
  find(sidebar.view.render(sidebar.cx), `detail-${A}`).handlers.click({},sidebar.cx);
  assert.deepEqual(nativeCommands, []);
  assert.match(sidebar.view.stateError, /Space actual/);
  nativeFocus = {space:'space-1',tab:'terminal-tab',pane:'terminal-pane',terminal:'t1'};
  find(sidebar.view.render(sidebar.cx), `detail-${A}`).handlers.click({},sidebar.cx); await sidebar.flush();
  sidebar.view.render(sidebar.cx);
  const page = await setup(nativeCommands.find(([name]) => name === 'tab.new')[1].props,false);
  nativeSpaces[0].tabs = nativeSpaces[0].tabs.filter(tab => tab.id === 'reader-tab-1');
  nativePanes = nativePanes.filter(pane => pane.mod === 'threads');
  const before = nativeCommands.length;
  find(page.view.render(page.cx),'return-workspace').handlers.click({},page.cx);
  assert.equal(nativeCommands.length,before);
  assert.match(page.view.stateError,/workspace anterior ya no está disponible/);
});

test('stale reading-tab registration is not reused when it points at a terminal', async () => {
  const { view, cx, flush } = await setup({ role: 'section' });
  sharedValues.set(`${view.channel}:page:space-1`, { tabId:'terminal-tab' });
  find(view.render(cx), `detail-${A}`).handlers.click({}, cx); await flush();
  view.render(cx);
  assert.equal(nativeCommands.filter(([name]) => name === 'tab.new').length, 1);
  assert.ok(nativePanes.some(pane => pane.terminal === 't1'));
});

test('return from reading uses a surviving terminal tab if the original workspace tab disappeared', async () => {
  const sidebar = await setup({ role:'section' });
  find(sidebar.view.render(sidebar.cx), `detail-${A}`).handlers.click({},sidebar.cx); await sidebar.flush();
  sidebar.view.render(sidebar.cx);
  const page = await setup(nativeCommands.find(([name]) => name === 'tab.new')[1].props,false);
  nativeSpaces[0].tabs = nativeSpaces[0].tabs.filter(tab => tab.id !== 'terminal-tab');
  nativePanes = nativePanes.filter(pane => pane.tab !== 'terminal-tab');
  nativeSpaces[0].tabs.push({id:'other-terminal',name:'Shell',active:false});
  nativePanes.push({pane:'other-pane',tab:'other-terminal',terminal:'t2'});
  find(page.view.render(page.cx),'return-workspace').handlers.click({},page.cx);
  assert.equal(nativeFocus.tab,'other-terminal');
  assert.ok(nativeCommands.every(([name]) => ['tab.new','tab.select'].includes(name)));
});

test('collapsed section shows a rail control that restores the existing sidebar width', async () => {
  const { view, cx, flush } = await setup({ role: 'section' });
  view.width = 76;
  sharedValues.set('sidebar.width', 300);
  let tree = view.render(cx);
  assert.equal(flatten(tree).some(node => node.attrs.id === 'threads-cards'), false);
  find(tree, 'expand-threads').handlers.click({}, cx); await flush();
  assert.deepEqual(nativeCommands, [['layout.resize', { id: 'sidebar', px: 300 }]]);
  view.width = 268;
  tree = view.render(cx);
  assert.ok(find(tree, 'threads-cards'));
});

test('separate inspector opens and closes only its native layout block, retaining the terminal and reading state', async () => {
  const config = { readerId: 'threads-reader', workId: 'work', channel: 'fixture' };
  const sidebar = await setup({ ...config, role: 'sidebar' });
  let tree = sidebar.view.render(sidebar.cx);
  assert.equal(flatten(tree).some(node => node.attrs.id === 'threads-detail'), false, 'list is no longer a narrow combined reader');
  find(tree, `history-${A}`).handlers.click({}, sidebar.cx); await sidebar.flush();
  find(sidebar.view.render(sidebar.cx), `detail-${B}`).handlers.click({}, sidebar.cx); await sidebar.flush();
  assert.deepEqual(nativeCommands.at(-1), ['layout.show', { id: 'threads-reader' }]);
  const reader = await setup({ ...config, role: 'reader' }, false);
  tree = reader.view.render(reader.cx); await reader.flush(); tree = reader.view.render(reader.cx);
  assert.equal(reader.view.model.selected, B);
  assert.equal(flatten(tree).some(node => node.attrs.id === 'threads-cards'), false);
  const page = reader.view.model.page('detail', B);
  assert.ok(page);
  find(tree, 'close-reader').handlers.click({}, reader.cx); await reader.flush();
  assert.deepEqual(nativeCommands.at(-1), ['layout.hide', { id: 'threads-reader' }]);
  const reads = calls.length;
  reader.timers[0].fn(reader.cx); await reader.flush();
  assert.equal(calls.length, reads, 'hidden reader does not poll');
  find(sidebar.view.render(sidebar.cx), `detail-${B}`).handlers.click({}, sidebar.cx); await sidebar.flush();
  reader.view.render(reader.cx); await reader.flush();
  assert.equal(reader.view.model.page('detail', B), page, 'reopen preserves the cached page');
  assert.ok(sidebar.view.model.expanded.has(A));
  assert.ok(nativeCommands.every(([name]) => name.startsWith('layout.')), 'no terminal/pane/tab lifecycle command');
});

test('reader startup restores no mini histories and issues one deferred selected-detail read', async () => {
  saved.clear(); sharedValues.clear(); nativeProps = {};
  saved.set('threads.view.v1', JSON.stringify({ selected: A, expanded: [A, B] }));
  const channel = 'threads.inspector.v2:' + JSON.stringify(['threads', '', 'startup-fixture']);
  sharedValues.set(channel, { threadId: A, open: true });
  const view = new Threads(), ctx = context();
  view.init({ role: 'reader', channel: 'startup-fixture' }, ctx.cx);
  const reads = [];
  let release;
  const deferred = new Promise(resolve => { release = resolve; });
  view.model.client.show = async id => {
    reads.push(id); await deferred;
    return { thread: { id, title: 'Trabajo', summary: 'Avance', latest_sequence: 1 }, events: [], next_before_sequence: null };
  };
  view.render(ctx.cx);
  // Let startup refresh settle while the selected page remains in flight.
  await new Promise(setImmediate);
  release(); await ctx.flush();
  assert.deepEqual(reads, [A], 'only syncReader loads the selected page; expanded histories belong to the sidebar');
  assert.equal(view.model.page('mini', A), undefined);
  assert.equal(view.model.page('mini', B), undefined);
});

test('explicit read marks are shared between sidebar and reader, never caused by opening/closing', async () => {
  const config = { readerId: 'threads-reader', channel: 'seen-fixture' };
  const sidebar = await setup({ ...config, role: 'sidebar' });
  find(sidebar.view.render(sidebar.cx), `history-${A}`).handlers.click({}, sidebar.cx); await sidebar.flush();
  find(sidebar.view.render(sidebar.cx), `detail-${A}`).handlers.click({}, sidebar.cx); await sidebar.flush();
  const reader = await setup({ ...config, role: 'reader' }, false);
  reader.view.render(reader.cx); await reader.flush();
  let tree = reader.view.render(reader.cx);
  assert.equal(reader.view.model.seen.size, 0);
  assert.equal(find(tree, `event-detail-${A}-1`).handlers.hover, undefined);
  find(tree, 'mark-read-reader').handlers.click({}, reader.cx);
  sidebar.view.render(sidebar.cx);
  assert.equal(sidebar.view.model.isSeen(A, 1), true);
  assert.equal(sidebar.view.model.isSeen(A, 2), false);
  find(tree, 'close-reader').handlers.click({}, reader.cx); await reader.flush();
  assert.equal(reader.view.model.isSeen(A, 1), true);
  assert.equal(reader.view.model.isSeen(A, 2), false);
});

test('widening hides only the work layout and closing restores it without ending a terminal', async () => {
  const config = { readerId:'threads-reader',workId:'work',channel:'wide-fixture' };
  const sidebar = await setup({...config,role:'sidebar'});
  find(sidebar.view.render(sidebar.cx),`detail-${A}`).handlers.click({},sidebar.cx);await sidebar.flush();
  const reader = await setup({...config,role:'reader'},false);
  find(reader.view.render(reader.cx),'wide-reader').handlers.click({},reader.cx);
  assert.deepEqual(nativeCommands.slice(-2),[['layout.hide',{id:'work'}],['layout.resize',{id:'threads-reader',weight:1}]]);
  find(reader.view.render(reader.cx),'close-reader').handlers.click({},reader.cx);
  assert.deepEqual(nativeCommands.slice(-3),[['layout.hide',{id:'threads-reader'}],['layout.show',{id:'work'}],['layout.resize',{id:'threads-reader',px:520}]]);
  assert.ok(nativeCommands.every(([name])=>name.startsWith('layout.')));
});

test('reader keeps the original long body behind a deliberate expansion', async () => {
  const {view,cx,flush}=await setup();
  const body='Original technical detail '.repeat(100);
  view.model.client.show=async()=>({thread:view.model.thread(A),events:[{thread_id:A,sequence:1,kind:'progress',summary:'Se añadió una regresión.',body,evidence:[]}],next_before_sequence:null});
  find(view.render(cx),`detail-${A}`).handlers.click({},cx);await flush();
  let tree=view.render(cx);
  assert.doesNotMatch(text(tree),/Original technical detail/);
  find(tree,`body-detail-${A}-1`).handlers.click({},cx);
  tree=view.render(cx);
  assert.equal(text(find(tree,`body-text-detail-${A}-1`)),body);
});

test('unchanged polling has no notify, storage write, loading blink or overlapping request', async () => {
  const {view,cx,flush,timers,notifications}=await setup({role:'section'});
  await view.model.refresh(); // Establish activity order before measuring unchanged polls.
  const before=notifications(),writes=storageWrites;
  const rows=view.model.threads;
  for(let i=0;i<3;i++){timers[0].fn(cx);await flush();}
  assert.equal(notifications(),before);
  assert.equal(storageWrites,writes);
  assert.equal(view.model.threads,rows);
  let release,reads=0;
  view.model.client.list=async()=>{reads++;await new Promise(resolve=>{release=resolve;});return {threads:[],next_before_sequence:null};};
  timers[0].fn(cx);timers[0].fn(cx);
  assert.equal(reads,1);
  assert.equal(notifications(),before);
  release();await flush();
  view.model.threads=[];
  timers[0].fn(cx);
  assert.doesNotMatch(text(view.render(cx)),/Cargando/,'an empty background refresh does not flash a loading state');
  release();await flush();
});

test('five-second polling signals pending work without moving history or marking unseen advances read', async () => {
  const {view,cx,flush,timers}=await setup({role:'section'});
  find(view.render(cx),`history-${A}`).handlers.click({},cx);await flush();
  const readingId=`reading-mini-${A}-latest`;
  const before=find(view.render(cx),readingId).attrs;
  view.model.client.list=async()=>({threads:view.model.threads.map(thread=>thread.id===A?{...thread,latest_sequence:3,event_count:2}:thread),next_before_sequence:null});
  view.model.client.show=async id=>({thread:view.model.thread(id),events:[3,1].map(sequence=>({thread_id:id,sequence,kind:'progress',body:`Avance ${sequence}`,evidence:[]})),next_before_sequence:null});
  timers[0].fn(cx);await flush();
  let tree=view.render(cx);
  assert.deepEqual(find(tree,readingId).attrs,before,'scroll identity and style stay stable');
  assert.deepEqual(view.model.page('mini',A).events.map(event=>event.sequence),[1]);
  assert.doesNotMatch(text(tree),/Novedades|Ver recientes/);
  assert.equal(text(find(tree,'pending-thread-updates')),'·');
  assert.equal(view.model.isSeen(A,3),false);
  find(tree,`mark-read-${A}`).handlers.click({},cx);
  assert.equal(view.model.isSeen(A,1),true);
  assert.equal(view.model.isSeen(A,3),false,'pending advances were not displayed');
  find(tree,'refresh-threads').handlers.click({},cx);await flush();
  tree=view.render(cx);
  assert.deepEqual(view.model.page('mini',A).events.map(event=>event.sequence),[3,1]);
  assert.equal(find(tree,`unread-mini-${A}-3`).attrs.text_color,'#d06b75');
  find(tree,`mark-read-${A}`).handlers.click({},cx);
  assert.equal(view.model.isSeen(A,3),true);
  assert.equal(view.model.isSeen(A,4),false);
});

test('background refresh errors stay in the fixed header while reading, not above the history', async () => {
  const {view,cx,flush,timers}=await setup({role:'section'});
  find(view.render(cx),`history-${A}`).handlers.click({},cx);await flush();
  let tree=view.render(cx);
  const page=view.model.page('mini',A), before=text(find(tree,`reading-mini-${A}-latest`));
  const children=find(tree,'threads-cards').nodes.map(node=>node.attrs?.id);
  view.model.client.list=async()=>{throw Error('private diagnostics');};
  timers[0].fn(cx);await flush();
  tree=view.render(cx);
  assert.equal(view.model.page('mini',A),page);
  assert.equal(text(find(tree,`reading-mini-${A}-latest`)),before);
  assert.deepEqual(find(tree,'threads-cards').nodes.map(node=>node.attrs?.id),children);
  assert.equal(text(find(tree,'pending-thread-updates')),'·');
  assert.match(find(tree,'refresh-threads').attrs.tooltip,/No se pudo/);
  assert.doesNotMatch(text(tree),/No se pudo|private diagnostics/);
});

test('shared manual read cursors never move backwards when a stale copy persists', async () => {
  const first=await setup({role:'section',channel:'manual-read'});
  first.view.model.threads[0].latest_sequence=10;
  first.view.markRead(A,first.cx);
  const second=await setup({role:'section',channel:'manual-read'},false);
  second.view.model.threads[0].latest_sequence=5;
  second.view.markRead(A,second.cx);
  first.view.render(first.cx);
  assert.equal(first.view.model.isSeen(A,10),true);
  assert.equal(second.view.model.isSeen(A,10),true);
  assert.equal(second.view.model.isSeen(A,11),false);
});

test('one five-second refresh timer per instance, not per card or render', async () => {
  const { view, timers, cx } = await setup();
  for (let i = 0; i < 4; i++) view.render(cx);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5000);
  assert.equal(calls.length, 1);
});

test('native root stretches header/scroll columns instead of vertically centering them', async () => {
  const { view, cx } = await setup();
  let tree = view.render(cx);
  assert.equal(tree.kind, 'row');
  assert.equal(tree.attrs.align_items, 'stretch', 'wide sidebar/detail need the full row height');
  tree.attrs.on_size_change({ width: 400, height: 800 }, cx);
  tree = view.render(cx);
  assert.equal(tree.kind, 'column');
  assert.equal(tree.attrs.align_items, 'stretch');
  const sidebar = find(tree, 'threads-sidebar');
  assert.ok(Object.hasOwn(sidebar.attrs, 'flex_1'), 'narrow cards need an allocated scroll height');
  assert.equal(sidebar.attrs.max_h, 300, 'keep the existing narrow-height bound');
});

test('card/title inert; separate accessible Historial chevron and Ver detalle controls', async () => {
  const { view, cx, flush } = await setup();
  let tree = view.render(cx);
  assert.equal(find(tree, `card-${A}`).handlers.click, undefined);
  assert.equal(find(tree, `title-${A}`).handlers.click, undefined);
  const history = find(tree, `history-${A}`);
  assert.equal(history.attrs.tooltip, 'Historial');
  assert.match(history.attrs.accessibility_label, /Historial/);
  assert.equal(text(history), '▸ Historial');
  history.handlers.click({}, cx); await flush();
  assert.equal(view.model.selected, null);
  tree = view.render(cx);
  assert.equal(text(find(tree, `history-${A}`)), '▾ Historial');
  assert.ok(view.model.expanded.has(A));
  find(tree, `detail-${B}`).handlers.click({}, cx); await flush();
  assert.equal(view.model.selected, B);
  assert.ok(view.model.expanded.has(A));
  assert.equal(view.model.isSeen(A, 1), false);
});

test('expanded mini histories keep a definite scroll viewport without card or surface shrink', async () => {
  const { view, cx, flush } = await setup();
  for (const id of [A, B]) {
    find(view.render(cx), `history-${id}`).handlers.click({}, cx); await flush();
  }
  const tree = view.render(cx);
  for (const id of [A, B]) {
    assert.ok(Object.hasOwn(find(tree, `card-${id}`).attrs, 'flex_none'), 'scroll-list cards must not squeeze histories to zero');
    assert.ok(Object.hasOwn(find(tree, `surface-mini-${id}`).attrs, 'flex_none'), 'mini surface retains its viewport height');
    const reading = find(tree, `reading-mini-${id}-latest`);
    assert.equal(reading.attrs.h, 220, 'max-height alone does not allocate native scroll height');
    assert.ok(Object.hasOwn(reading.attrs, 'flex_none'));
    assert.ok(Object.hasOwn(reading.attrs, 'overflow_y_scrollbar'));
  }
});

test('only the explicit read control clears red markers; hovering, rendering and opening do not', async () => {
  const { view, cx, flush } = await setup({role:'section'});
  find(view.render(cx), `history-${A}`).handlers.click({}, cx); await flush();
  let tree = view.render(cx);
  assert.equal(find(tree, `event-mini-${A}-1`).handlers.hover, undefined);
  assert.equal(view.model.isSeen(A, 1), false);
  assert.equal(find(tree,`unread-mini-${A}-1`).attrs.text_color,'#d06b75');
  find(tree,`mark-read-${A}`).handlers.click({},cx);
  tree=view.render(cx);
  assert.equal(view.model.isSeen(A, 1), true);
  assert.equal(view.model.isSeen(A, 2), false);
  assert.equal(find(tree,`unread-mini-${A}-1`).attrs.text_color,'#777777');
  assert.match(text(tree), /Untrusted \$\{code\} <script>/);
});

test('evidence is visible beside its advance; optional references stay hidden and opening is explicit', async () => {
  const { view, cx, flush } = await setup();
  view.model.threads[0].references = [
    { kind: 'issue', reference: 'ISSUE-PRIVATE' }, { kind: 'pr', reference: 'https://example.test/pr-private' },
    { kind: 'session', reference: 'https://example.test/session-private' }];
  find(view.render(cx), `detail-${A}`).handlers.click({}, cx); await flush();
  const tree = view.render(cx), row = find(tree, `event-detail-${A}-1`);
  assert.match(text(row), /Untrusted \$\{code\} <script>/);
  assert.match(text(row), /plan/);
  assert.doesNotMatch(text(row), /https:\/\/example.test\/plan/);
  find(tree, `reference-value-detail-${A}-1-0`).handlers.click({}, cx);
  assert.match(text(find(view.render(cx), `event-detail-${A}-1`)), /https:\/\/example.test\/plan/);
  assert.match(text(row), /Disponibilidad no comprobada/);
  assert.doesNotMatch(text(tree), /ISSUE-PRIVATE|pr-private|session-private/);
  assert.doesNotMatch(text(tree), new RegExp(A));
  assert.equal(calls.length, 1, 'rendering evidence did not open anything');
  assert.equal(row.handlers.hover, undefined);
  find(tree,`mark-read-${A}`).handlers.click({},cx);
  assert.equal(calls.length, 1, 'marking read did not open evidence');
  find(tree, `open-detail-${A}-1-0`).handlers.click({}, cx); await flush();
  assert.deepEqual(calls.at(-1), ['open', ['-a', 'Dia', 'https://example.test/plan']]);
  await view.activateReference('javascript:alert(1)', cx); await flush();
  assert.equal(calls.length, 2);
});

test('session reference controls show both explicit links and distinct origins without UUIDs', async () => {
  const { view, cx, flush } = await setup();
  view.model.threads[0].references = [{ kind: 'session', reference: 'https://example.test/session' }];
  view.model.client.sessions = async () => ({ associations: [{ sequence: 1, origin: { agent: 'pi', session_id: A, session_ref: '/tmp/session' } }], next_after_sequence: null });
  let tree = view.render(cx);
  assert.match(text(find(tree, `references-${A}-session`)), /Sesiones 1.*enlaces 1/);
  find(tree, `references-${A}-session`).handlers.click({}, cx); await flush();
  tree = view.render(cx);
  assert.ok(find(tree, `evidence-ref-${A}-session-0`));
  assert.ok(find(tree, `evidence-session-${A}-0`));
  assert.doesNotMatch(text(tree), new RegExp(A));
});

test('opaque native session IDs without locators disclose honestly without invented links', async () => {
  const { view, cx, flush } = await setup();
  view.model.client.sessions = async () => ({ associations: [{ sequence: 1, origin: {
    agent: 'opencode', session_id: 'ses_native_fixture', session_ref: null, actor_id: 'native-child',
  } }], next_after_sequence: null });
  assert.doesNotMatch(text(view.render(cx)), /ses_native_fixture/);
  find(view.render(cx), `references-${A}-session`).handlers.click({}, cx); await flush();
  const tree = view.render(cx);
  assert.match(text(tree), /ID nativo: ses_native_fixture.*Localizador no disponible/);
  assert.match(text(tree), /Actor native-child/);
  assert.equal(flatten(tree).some(node => node.attrs.id === `open-session-${A}-0`), false);
});

test('native More keeps held histories still and explicit Update applies queued arrivals', async () => {
  const { view, cx, flush } = await setup();
  const rows = new Map();
  const id = sequence => sequence === 40 ? A : sequence === 39 ? B : `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  const add = (first, last) => { for (let sequence = first; sequence <= last; sequence++) rows.set(id(sequence), {
    id: id(sequence), title: `Work ${sequence}`, summary: 'Progress', latest_sequence: sequence, event_count: 1, session_count: 0,
  }); };
  add(1, 40);
  view.model = new ThreadsModel({ ...view.model.client, async list(before) {
    const page = [...rows.values()].filter(row => before === undefined || row.latest_sequence < before)
      .sort((a, b) => b.latest_sequence - a.latest_sequence).slice(0, 20);
    return { threads: page, next_before_sequence: page.length === 20 ? page.at(-1).latest_sequence : null };
  } });
  const click = async control => { find(view.render(cx), control).handlers.click({}, cx); await flush(); };
  await click('refresh-threads'); await click(`history-${A}`); await click(`detail-${B}`);
  const reading = find(view.render(cx), `reading-detail-${B}-latest`).attrs;
  const mini = view.model.page('mini', A), detail = view.model.page('detail', B);
  add(41, 85); view.poll(cx); await flush();
  let pages = 0;
  while (view.model.listCursor !== null && pages++ < 10) await click('more-threads');
  let tree = view.render(cx);
  assert.equal(flatten(tree).filter(node => node.attrs.id?.startsWith('card-')).length, 40);
  assert.equal(view.model.visibleThreads[0].id, A);
  await click('refresh-threads');
  tree = view.render(cx);
  assert.equal(view.model.threads.length, 85);
  assert.equal(flatten(tree).filter(node => node.attrs.id?.startsWith('card-')).length, 85);
  assert.equal(view.model.threads[0].id, id(85));
  assert.deepEqual(flatten(tree).filter(node => node.attrs.id?.startsWith('card-')).map(node => node.attrs.id),
    Array.from({ length: 85 }, (_, index) => `card-${id(85 - index)}`));
  assert.equal(view.model.selected, B);
  assert.equal(view.model.page('mini', A), mini);
  assert.equal(view.model.page('detail', B), detail);
  assert.deepEqual(find(tree, `reading-detail-${B}-latest`).attrs, reading);
  assert.equal(view.model.seen.size, 0);
  assert.equal(flatten(tree).some(node => node.attrs.id === 'more-threads'), false);
});

test('native session reopen preserves cached rows through failure and exposes new paginated origins on retry', async () => {
  const { view, cx, flush } = await setup();
  const origin = (sequence, agent) => ({ sequence, origin: { agent, session_id: sequence === 1 ? A : B,
    session_ref: `/tmp/session-${sequence}` } });
  let associations = [origin(1, 'pi')], fail = false;
  view.model.client.sessions = async (_id, after) => {
    if (fail) throw Error('private');
    return after ? { associations: associations.slice(1), next_after_sequence: null } :
      { associations: associations.slice(0, 1), next_after_sequence: associations.length > 1 ? 1 : null };
  };
  const toggle = async () => { find(view.render(cx), `references-${A}-session`).handlers.click({}, cx); await flush(); };
  await toggle();
  const good = view.model.sessions.get(A);
  associations = [origin(1, 'pi'), origin(2, 'codex')];
  view.model.threads[0].session_count = 2;
  await toggle(); fail = true; await toggle();
  let tree = view.render(cx);
  assert.equal(view.model.sessions.get(A), good);
  assert.ok(find(tree, `retry-sessions-${A}`), 'reopening an exhausted cache actually revalidates');
  assert.ok(find(tree, `evidence-session-${A}-0`));
  fail = false;
  find(tree, `retry-sessions-${A}`).handlers.click({}, cx); await flush();
  tree = view.render(cx);
  find(tree, `more-sessions-${A}`).handlers.click({}, cx); await flush();
  tree = view.render(cx);
  assert.match(text(tree), /Sesiones 2/);
  assert.match(text(tree), /codex · Sesión 2/);
  assert.ok(find(tree, `evidence-session-${A}-1`));
  assert.doesNotMatch(text(tree), new RegExp(A));
});

test('unavailable evidence never opens; missing Dia surfaces a bounded error without fallback', async () => {
  const { view, cx, flush } = await setup();
  find(view.render(cx), `detail-${A}`).handlers.click({}, cx); await flush();
  const evidence = view.model.page('detail', A).events[0].evidence[0];
  evidence.availability = 'unavailable';
  const tree = view.render(cx);
  assert.match(text(find(tree, `event-detail-${A}-1`)), /plan/);
  assert.equal(flatten(tree).some(node => node.attrs.id === `open-detail-${A}-1-0`), false);
  assert.match(text(tree), /Referencia no disponible/);
  // Invalid URI cannot even start an exec.
  view.activateReference('data:text/html,bad', cx); await flush();
  assert.equal(calls.length, 1);
  execResult = { code: 1, stderr: 'private error', stdout: '' };
  view.activateReference('https://example.test/missing', cx); await flush();
  assert.equal(calls.length, 2, 'one Dia attempt, no fallback application');
  assert.match(view.linkError, /No se usó otra aplicación/);
  assert.doesNotMatch(view.linkError, /private/);
});

test('native mini/detail review and validation rows preserve object, version and digest scope', async () => {
  const { view, cx, flush } = await setup();
  const targets = [
    { object_id: 'plan', version: 'v1', digest: 'sha256:first' },
    { object_id: 'report', version: 'v1', digest: 'sha256:first' },
    { object_id: 'plan', version: 'v1', digest: 'sha256:second' },
    { object_id: 'unversioned-plan' },
  ];
  const events = ['review', 'validation'].flatMap(kind => targets.map((target, index) => ({ thread_id: A,
    sequence: (kind === 'review' ? 1 : 5) + index, kind, body: 'Recorded result', evidence: [],
    [kind]: { target, ...(kind === 'review' ? { disposition: 'approved' } : { outcome: 'passed' }) } })));
  events.push({ thread_id: A, sequence: 9, kind: 'progress', body: 'Next version', evidence: [] });
  view.model.client.show = async () => ({ thread: view.model.thread(A), events, next_before_sequence: null });
  find(view.render(cx), `history-${A}`).handlers.click({}, cx); await flush();
  find(view.render(cx), `detail-${A}`).handlers.click({}, cx); await flush();
  let tree = view.render(cx);
  for (const surface of ['mini', 'detail']) {
    for (const event of events.slice(0, -1)) {
      find(tree, `metadata-${surface}-${A}-${event.sequence}`).handlers.click({}, cx);
      tree = view.render(cx);
      const row = text(find(tree, `event-${surface}-${A}-${event.sequence}`));
      for (const value of Object.values((event.review ?? event.validation).target)) assert.ok(row.includes(value), `missing ${value}`);
      assert.match(row, event.review ? /solo este objeto\/versión/ : /no verifica el contenido actual/);
      if (event.sequence === 4 || event.sequence === 8) assert.match(row, /sin versión verificable/);
    }
    const next = find(tree, `event-${surface}-${A}-9`);
    assert.equal(next.handlers.hover, undefined);
    assert.doesNotMatch(text(next), /aprobación|pasó/);
  }
});

test('native scroll identifiers and page content stay stable across asynchronous refresh/failure', async () => {
  const { view, cx, flush } = await setup();
  find(view.render(cx), `detail-${A}`).handlers.click({}, cx); await flush();
  const before = find(view.render(cx), `reading-detail-${A}-latest`).attrs;
  view.model.client.list = async () => { throw Error('private'); };
  await view.model.refresh();
  const after = find(view.render(cx), `reading-detail-${A}-latest`).attrs;
  assert.deepEqual(after, before);
  assert.equal(view.model.selected, A);
  assert.equal(view.model.page('detail', A).events[0].sequence, 1);
});
