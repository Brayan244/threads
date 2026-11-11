import { View, div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { exec, theme, shared, setShared, run, layout, props, spaces, panes, focused } from 'herdr';
import { ThreadsModel, createClient, referenceAction, shortPhrase, validThreadId, validSeenKey, validReadMark } from './view-model.js';
import { control, iconControl, renderDetail, renderReading, renderReferences } from './detail.js';

const nodeId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
function findNode(root, id) {
  if (!root || typeof root !== 'object') return null;
  if (root.id === id) return root;
  for (const child of root.children ?? []) { const found = findNode(child, id); if (found) return found; }
  return null;
}

export default class Threads extends View {
  init(config = {}, cx) {
    // Herdr's block props are authoritative; GPUI View.init may receive {}.
    config = { ...(config ?? {}), ...(props() ?? {}) };
    this.revealed = new Set(); this.width = 620; this.linkError = null;
    this.rowHeights = new Map();
    this.role = config.role ?? 'combined';
    this.pageSpace = config.pageSpace;
    this.resourceConfig = { cli: config.cli ?? 'threads', channel: config.channel ?? 'default',
      ...(config.dataDir === undefined ? {} : { dataDir: config.dataDir }) };
    this.readerId = config.readerId ?? 'threads-reader'; this.workId = config.workId;
    this.channel = `threads.inspector.v2:${JSON.stringify([config.cli ?? 'threads', config.dataDir ?? '', config.channel ?? 'default'])}`;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('threads.view.v1') ?? '{}') ?? {}; } catch { /* Ignore malformed view state, never domain history. */ }
    try {
      if (!['combined', 'sidebar', 'reader', 'section', 'page'].includes(this.role) || !nodeId(this.readerId) ||
          (this.role === 'page' && !nodeId(this.pageSpace)) || (this.workId !== undefined && !nodeId(this.workId))) throw Error();
      this.model = new ThreadsModel(createClient(exec, config), saved);
    } catch { this.configError = 'Configuración de Threads no válida.'; return; }
    if ((this.role === 'reader' || this.role === 'page') && validThreadId(this.selection().threadId)) this.model.selected = this.selection().threadId;
    this.syncSeen();
    this.task(cx, async () => {
      if ((this.role === 'reader' && !this.selection().open) || (this.role === 'page' && !this.pageVisible())) return;
      await this.model.refresh();
      if (this.role === 'sidebar' || this.role === 'section') await Promise.all([...this.model.expanded].map(id => this.model.ensurePage('mini', id)));
      else if (this.role === 'combined') await this.model.restore();
    });
    cx.timer.every(5000, cx => this.poll(cx));
  }
  selection() {
    const value = shared(this.role === 'page' ? `${this.channel}:reading:${this.pageSpace}` : this.channel);
    return value && typeof value === 'object' && validThreadId(value.threadId) ? value : {};
  }
  syncSeen() {
    const values = shared(`${this.channel}:seen`);
    if (Array.isArray(values)) for (const key of values) if (validSeenKey(key)) this.model.seen.add(key);
    const marks = shared(`${this.channel}:read`);
    if (Array.isArray(marks)) for (const mark of marks) {
      if (validReadMark(mark)) this.model.readThrough.set(mark[0], Math.max(this.model.readThrough.get(mark[0]) ?? 0, mark[1]));
    }
  }
  persist() {
    this.syncSeen();
    try {
      const snapshot = JSON.stringify(this.model.snapshot());
      if (localStorage.getItem('threads.view.v1') !== snapshot) localStorage.setItem('threads.view.v1', snapshot);
      const values = shared(`${this.channel}:seen`), known = new Set(Array.isArray(values) ? values.filter(validSeenKey) : []);
      if (this.model.seen.size !== known.size || [...this.model.seen].some(key => !known.has(key))) {
        setShared(`${this.channel}:seen`, [...this.model.seen]);
      }
      const marks = shared(`${this.channel}:read`), knownMarks = new Map(Array.isArray(marks) ? marks.filter(validReadMark) : []);
      if (knownMarks.size !== this.model.readThrough.size || [...this.model.readThrough].some(([id, sequence]) => knownMarks.get(id) !== sequence)) {
        setShared(`${this.channel}:read`, [...this.model.readThrough]);
      }
    } catch { this.stateError = 'No se pudo guardar el estado de lectura.'; }
  }
  markRead(id, cx) {
    this.syncSeen();
    if (this.model.markRead(id)) { this.persist(); cx.notify(); }
  }
  pollActive() {
    return this.role === 'page' ? this.pageVisible() : this.role !== 'reader' || this.selection().open;
  }
  poll(cx) {
    if (this.polling || !this.pollActive()) return;
    this.polling = true;
    cx.spawn(async cx => {
      let changed = false;
      try {
        changed = await this.model.refresh();
        if (this.pollActive()) {
          const reads = [];
          if (['section', 'sidebar', 'combined'].includes(this.role)) {
            for (const id of this.model.expanded) reads.push(this.model.refreshLatest('mini', id));
          }
          if (['page', 'reader', 'combined'].includes(this.role) && this.model.selected) {
            reads.push(this.model.refreshLatest('detail', this.model.selected));
          }
          const results = await Promise.all(reads);
          changed = results.some(Boolean) || changed;
        }
      } catch {
        const message = 'No se pudo actualizar Threads. Se conserva el último contenido disponible.';
        changed = this.stateError !== message;
        this.stateError = message;
      } finally {
        this.polling = false;
        if (changed) { this.persist(); cx.notify(); }
      }
    });
  }
  task(cx, action) {
    cx.spawn(async cx => {
      try { await action(); }
      catch { this.stateError = 'No se pudo completar la operación de lectura.'; }
      finally { this.persist(); cx.notify(); }
    });
    cx.notify();
  }
  openDetail(id, cx) {
    if (!validThreadId(id)) return;
    if (this.role === 'section') { this.openPage(id, cx); return; }
    if (this.role === 'combined') { this.task(cx, () => this.model.selectDetail(id)); return; }
    this.model.selected = id;
    setShared(this.channel, { ...this.selection(), threadId: id, open: true });
    run('layout.show', { id: this.readerId });
    this.persist(); cx.notify();
  }
  pageTab(spaceId) {
    const record = shared(`${this.channel}:page:${spaceId}`);
    const tab = spaces().find(space => space.id === spaceId)?.tabs.find(tab => tab.id === record?.tabId);
    return tab && panes().some(pane => pane.tab === tab.id && pane.mod === 'threads') ? tab : null;
  }
  pageVisible() {
    const space = spaces().find(space => space.id === this.pageSpace), tab = this.pageTab(this.pageSpace);
    return Boolean(space?.active && tab?.active);
  }
  reconcilePage() {
    const pending = this.pendingPage;
    if (!pending) return;
    const tabs = spaces().find(space => space.id === pending.space)?.tabs ?? [];
    const candidates = tabs.filter(tab => !pending.before.has(tab.id) &&
      panes().some(pane => pane.tab === tab.id && pane.mod === 'threads'));
    if (candidates.length === 1) {
      setShared(`${this.channel}:page:${pending.space}`, { tabId: candidates[0].id });
      this.pendingPage = null;
    } else if (candidates.length > 1 || Date.now() - pending.started > 5000) {
      this.stateError = 'No se pudo identificar la pestaña de lectura. Revisa las pestañas antes de reintentar.';
      this.pendingPage = null;
    }
  }
  openPage(id, cx) {
    this.reconcilePage();
    const context = focused(), space = spaces().find(space => space.id === context?.space);
    if (!space || !space.tabs.some(tab => tab.id === context?.tab) || this.pendingPage) {
      this.stateError = 'No se pudo abrir el detalle en el Space actual. Revisa sus pestañas antes de reintentar.';
      cx.notify(); return;
    }
    const tab = this.pageTab(space.id), key = `${this.channel}:reading:${space.id}`, previous = shared(key);
    const returnTab = tab?.id === context.tab ? previous?.returnTab : context.tab;
    setShared(key, { threadId: id, open: true, returnTab });
    this.model.selected = id;
    this.stateError = null;
    try {
      if (tab) run('tab.select', { id: tab.id });
      else {
        this.pendingPage = { space: space.id, before: new Set(space.tabs.map(tab => tab.id)), started: Date.now() };
        run('tab.new', { space: space.id, name: 'Threads', mod: 'threads',
          props: { ...this.resourceConfig, role: 'page', pageSpace: space.id } });
        this.reconcilePage();
      }
    } catch {
      this.pendingPage = null;
      this.stateError = 'No se pudo abrir la pestaña de lectura; el workspace sigue intacto.';
    }
    this.persist(); cx.notify();
  }
  returnToWorkspace(cx) {
    const space = spaces().find(space => space.id === this.pageSpace), reader = this.pageTab(this.pageSpace);
    const wanted = this.selection().returnTab;
    const target = space?.tabs.find(tab => tab.id === wanted && tab.id !== reader?.id) ??
      space?.tabs.find(tab => tab.id !== reader?.id && panes().some(pane => pane.tab === tab.id && pane.terminal));
    if (target) run('tab.select', { id: target.id });
    else this.stateError = 'El workspace anterior ya no está disponible. Puedes elegir otra pestaña desde Herdr.';
    cx.notify();
  }
  syncReader(cx) {
    const selected = this.selection();
    if (!selected.open || !validThreadId(selected.threadId)) return;
    if (this.model.selected !== selected.threadId) this.model.selected = selected.threadId;
    const key = `detail:${selected.threadId}`;
    if (!this.model.page('detail', selected.threadId) && !this.model.pending.has(key) && !this.model.pageError('detail', selected.threadId)) {
      this.task(cx, () => this.model.ensurePage('detail', selected.threadId));
    }
  }
  closeReader(cx) {
    const selected = this.selection();
    run('layout.hide', { id: this.readerId });
    if (selected.wide) {
      if (selected.workHiddenByReader && this.workId) run('layout.show', { id: this.workId });
      run('layout.resize', { id: this.readerId, px: 520 });
    }
    setShared(this.channel, { ...selected, open: false, wide: false, workHiddenByReader: false });
    this.persist(); cx.notify();
  }
  toggleWide(cx) {
    const selected = this.selection(), work = this.workId && findNode(layout(), this.workId);
    if (!work) { this.stateError = 'No se pudo identificar el área de trabajo para ampliar el lector.'; cx.notify(); return; }
    if (selected.wide) {
      if (selected.workHiddenByReader) run('layout.show', { id: this.workId });
      run('layout.resize', { id: this.readerId, px: 520 });
      setShared(this.channel, { ...selected, wide: false, workHiddenByReader: false });
    } else {
      const visible = work.hidden !== true;
      if (visible) run('layout.hide', { id: this.workId });
      run('layout.resize', { id: this.readerId, weight: 1 });
      setShared(this.channel, { ...selected, wide: true, workHiddenByReader: visible });
    }
    cx.notify();
  }
  activateReference(reference, cx) {
    const action = referenceAction(reference);
    if (!action) return;
    this.task(cx, async () => {
      try {
        const result = action.kind === 'browser' ? await exec('open', ['-a', 'Dia', action.value]) : await exec('open', ['-R', action.value]);
        if (result.code !== 0) throw Error();
        this.linkError = null;
      } catch { this.linkError = 'Referencia no disponible o no se pudo abrir. No se usó otra aplicación.'; }
    });
  }
  threadRow(thread, t) {
    const id = thread.id, expanded = this.model.expanded.has(id);
    const root = v_flex().id(`card-${id}`).flex_none();
    root.child(h_flex().id(`thread-row-${id}`).h(30).flex_none().px(4).gap(4).items_center().rounded(6).hover(s => s.bg(t.hover))
      .child(iconControl(`history-${id}`, expanded ? '▾' : '▸', `Historial ${expanded ? 'abierto' : 'cerrado'} de ${thread.title}`,
        (_e, cx) => this.task(cx, () => this.model.toggleHistory(id)), t).tooltip('Historial').selected(expanded))
      .child(div().id(`unread-thread-${id}`).w(8).flex_none().text_size(12)
        .text_color(this.model.hasUnread(id) ? t.ansi1 : t.dim).child('·').tooltip(this.model.hasUnread(id) ? 'Sin leer' : 'Leído'))
      .child(div().id(`title-${id}`).flex_1().min_w(0).truncate().text_size(13).line_height('20px').child(thread.title).tooltip(thread.title))
      .child(div().flex_none().text_size(10).text_color(t.dim).child(String(thread.event_count))
        .tooltip(`${thread.event_count} avances registrados`))
      .child(iconControl(`mark-read-${id}`, '✓', 'Marcar thread como leído', (_e, cx) => this.markRead(id, cx), t))
      .child(iconControl(`detail-${id}`, '›', `Ver detalle de ${thread.title}`, (_e, cx) => this.openDetail(id, cx), t).tooltip('Ver detalle')));
    if (expanded) root.child(renderReading(this, 'mini', id, t));
    return root;
  }
  card(thread, t) {
    if (this.role === 'section') return this.threadRow(thread, t);
    const id = thread.id, expanded = this.model.expanded.has(id);
    const card = v_flex().id(`card-${id}`).flex_none().p(12).gap(8).border_b_1().border_color(t.border)
      .child(div().id(`title-${id}`).text_size(16).line_height('23px').font_semibold().child(thread.title));
    const summary = shortPhrase(thread.summary);
    if (summary) card.child(div().text_size(13).line_height('20px').text_color(t.muted).child(summary));
    card.child(h_flex().gap(12).flex_wrap().items_center()
      .child(control(`history-${id}`, expanded ? '▾ Historial' : '▸ Historial', (_e, cx) => this.task(cx, () => this.model.toggleHistory(id)), t)
        .accessibility_label(`Historial ${expanded ? 'abierto' : 'cerrado'} de ${thread.title}`).tooltip('Historial').selected(expanded))
      .child(control(`detail-${id}`, 'Ver detalle', (_e, cx) => this.openDetail(id, cx), t))
      .child(iconControl(`mark-read-${id}`, '✓', 'Marcar thread como leído', (_e, cx) => this.markRead(id, cx), t)));
    if (this.role === 'combined') { const refs = renderReferences(this, id, t); if (refs) card.child(refs); }
    if (expanded) card.child(renderReading(this, 'mini', id, t));
    return card;
  }
  animatedRows(t) {
    let top = 0;
    const rows = this.model.visibleThreads.map(thread => {
      const row = this.card(thread, t).absolute().left(0).top(top).w_full().bg(t.chrome)
        .spring('top', { response: 280, damping: 1 })
        .on_size_change(({ height }, cx) => {
          if (Number.isFinite(height) && height > 0 && Math.abs(height - (this.rowHeights.get(thread.id) ?? 30)) > 0.5) {
            this.rowHeights.set(thread.id, Math.ceil(height));
            cx.notify();
          }
        });
      top += this.rowHeights.get(thread.id) ?? 30;
      return row;
    });
    // Absolute, keyed targets let GPUI retarget motion without script-side frames.
    // Real row measurements keep expanded histories and the scroll extent intact.
    return div().id('threads-motion').relative().w_full().h(top).flex_none().children(rows);
  }
  sidebar(t) {
    const model = this.model, compact = this.role === 'section', threads = model.visibleThreads;
    const status = model.error ?? this.stateError ?? this.linkError;
    const pending = model.hasPendingUpdates || (model.readingPaused && Boolean(status));
    const hint = status ?? (pending ? 'Hay avances nuevos. Actualizar conserva los historiales abiertos.' : 'Actualizar Threads');
    const update = (compact ? iconControl('refresh-threads', '↻', 'Actualizar Threads',
      (_e, cx) => this.task(cx, () => model.updateReading()), t) : control('refresh-threads', 'Actualizar',
      (_e, cx) => this.task(cx, () => model.updateReading()), t).accessibility_label('Actualizar Threads'))
      .tooltip(hint).disabled(model.pending.has('reading-update'));
    const refresh = h_flex().gap(2).items_center()
      .child(div().id('pending-thread-updates').w(8).flex_none().text_size(12).text_color(t.ansi1)
        .child(pending ? '·' : '').tooltip(hint).accessibility_label(pending ? hint : ''))
      .child(update);
    const sidebar = v_flex().id('threads-sidebar').min_h(0).gap(compact ? 0 : 6);
    if (this.role === 'sidebar' || compact) sidebar.size_full();
    else if (this.width >= 500) sidebar.w(260).flex_none();
    else sidebar.w_full().flex_1().max_h(300);
    if (compact) {
      sidebar.child(h_flex().id('threads-heading').h(31).flex_none().pl(16).pr(10).items_center().justify_between()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child('Threads'))
        .child(refresh));
    } else {
      sidebar.child(h_flex().flex_none().px(12).py(10).items_center().justify_between()
        .child(div().text_size(19).font_semibold().child('Threads'))
        .child(refresh));
      sidebar.child(div().flex_none().px(12).text_size(12).text_color(t.muted).child('Trabajos y últimos avances'));
    }
    const cards = v_flex().id('threads-cards').flex_1().min_h(0).overflow_y_scrollbar();
    if (compact) cards.px(8);
    if (model.error && !model.readingPaused) cards.child(div().flex_none().px(12).text_size(13).child(model.error));
    if ((this.stateError || this.linkError) && !model.readingPaused) cards.child(div().flex_none().px(12).text_size(13).child(this.stateError ?? this.linkError));
    if (compact && threads.length) cards.child(this.animatedRows(t));
    else cards.children(threads.map(thread => this.card(thread, t)));
    if (!threads.length) cards.child(div().flex_none().p(12).text_size(compact ? 12 : 14).text_color(t.muted)
      .child(model.loading && model.listHead === null && !model.error ? 'Cargando…' : model.error ? 'Último contenido válido no disponible' : 'Sin trabajos todavía. Abrir el panel no crea uno.'));
    if (model.listCursor !== null) cards.child(control('more-threads', 'Más trabajos',
      (_e, cx) => this.task(cx, () => model.refresh(true)), t));
    return sidebar.child(cards);
  }
  render(cx) {
    const t = theme();
    if (this.configError) return div().p(12).text_color(t.foreground).child(this.configError);
    this.syncSeen();
    if (this.role === 'section') this.reconcilePage();
    if (this.role === 'reader' || (this.role === 'page' && this.pageVisible())) this.syncReader(cx);
    const root = (this.role === 'combined' && this.width >= 500 ? h_flex() : v_flex())
      .id('threads-root').size_full().items_stretch().min_h(0).min_w(0)
      .bg(this.role === 'section' ? t.chrome : t.surface).text_color(t.foreground).text_size(14)
      .on_size_change((size, cx) => { if (this.width !== size.width) { this.width = size.width; cx.notify(); } });
    if (this.role === 'section') {
      const width = findNode(layout(), 'sidebar')?.size?.px ?? this.width;
      if (width < 160) return root.child(h_flex().justify_center().child(control('expand-threads', 'T', (_e, cx) => {
        const savedWidth = shared('sidebar.width');
        run('layout.resize', { id: 'sidebar', px: typeof savedWidth === 'number' && Number.isFinite(savedWidth) ? Math.max(160, Math.min(480, savedWidth)) : 268 });
        cx.notify();
      }, t).accessibility_label('Mostrar Threads').tooltip('Threads')));
      return root.child(this.sidebar(t));
    }
    if (this.role === 'page') return root.child(renderDetail(this, t));
    if (this.role !== 'reader') root.child(this.sidebar(t));
    if (this.role !== 'sidebar') root.child(renderDetail(this, t));
    return root;
  }
}
