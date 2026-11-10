import { div } from 'gpui-kit';
import { Button, h_flex, v_flex } from 'gpui-base';
import { referenceAction, reviewLabel, miniCaption, kindLabel, referenceLabel, shortPhrase } from './view-model.js';

export function control(id, label, action, t) {
  return Button.new(id).child(label).accessibility_label(label).text_size(13).px(6).py(4)
    .text_color(t.accent).on_click(action);
}
export function iconControl(id, glyph, name, action, t) {
  return Button.new(id).child(glyph).accessibility_label(name).tooltip(name).w(22).h(26).px(0).py(0)
    .text_size(13).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(action);
}
const label = (text, t) => div().text_size(12).line_height('19px').text_color(t.muted).child(text);
function disclose(view, key, cx) {
  if (view.revealed.has(key)) view.revealed.delete(key); else view.revealed.add(key);
  cx.notify();
}
function timestamp(value) {
  if (typeof value !== 'string') return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} · ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function reference(view, key, ref, t, available = 'unknown', discloseReference = true) {
  const open = !discloseReference || view.revealed.has(key), row = v_flex().gap(5).flex_none();
  if (discloseReference) row.child(control(`evidence-${key}`, open ? 'Ocultar referencia' : 'Mostrar referencia',
    (_event, cx) => disclose(view, key, cx), t));
  if (!open) return row;
  row.child(div().text_size(13).line_height('20px').child(referenceLabel(ref)));
  row.child(label(available === 'unavailable' ? 'Referencia no disponible' : available === 'available' ?
    'Disponibilidad registrada; no certifica validación' : 'Disponibilidad no comprobada', t));
  const action = referenceAction(ref);
  if (action && available !== 'unavailable') row.child(control(`open-${key}`,
    action.kind === 'browser' ? 'Abrir en Dia' : 'Mostrar en Finder', (_event, cx) => view.activateReference(ref, cx), t));
  else if (!action) row.child(label('Sin apertura segura; referencia solo de lectura', t));
  const fullKey = `full-reference-${key}`;
  row.child(control(`reference-value-${key}`, view.revealed.has(fullKey) ? 'Ocultar dirección completa' : 'Ver dirección completa',
    (_event, cx) => disclose(view, fullKey, cx), t));
  if (view.revealed.has(fullKey)) row.child(label(String(ref), t));
  return row;
}
function readingEvent(view, id, event, t) {
  const key = `detail-${id}-${event.sequence}`, seen = view.model.isSeen(id, event.sequence);
  const row = v_flex().id(`event-${key}`).flex_none().gap(10).py(14).pl(20).border_l(1).border_color(t.border);
  row.child(h_flex().gap(8).items_center()
    .child(div().id(`unread-${key}`).text_size(12).text_color(seen ? t.dim : t.ansi1).child('·').tooltip(seen ? 'Leído' : 'Sin leer'))
    .child(div().text_size(11).line_height('18px').text_color(t.dim).child(`${kindLabel(event.kind)} · ${timestamp(event.received_at)}`)));
  event.body.split(/\r?\n\s*\r?\n/).forEach((paragraph, index) => row.child(div().id(`paragraph-${key}-${index}`)
    .min_w(0).text_size(14).line_height('25px').child(paragraph)));
  const review = reviewLabel(event);
  if (review) {
    const scopeKey = `scope-${key}`;
    row.child(label(event.review ? 'Sólo el objeto/versión de esta revisión.' : 'No verifica el contenido actual ni otras versiones.', t));
    row.child(control(`metadata-${key}`, view.revealed.has(scopeKey) ? 'Ocultar alcance completo' : 'Objeto, versión y hash',
      (_e, cx) => disclose(view, scopeKey, cx), t).text_color(t.muted));
    if (view.revealed.has(scopeKey)) row.child(label(review, t));
  }
  if (event.evidence.length) {
    const chips = h_flex().gap(6).flex_wrap();
    for (const [index, evidence] of event.evidence.entries()) {
      const action = referenceAction(evidence.reference), name = referenceLabel(evidence.reference);
      if (action && evidence.availability !== 'unavailable') chips.child(control(`open-${key}-${index}`, name,
        (_e, cx) => view.activateReference(evidence.reference, cx), t).text_color(t.muted).text_size(11)
        .border(1).border_color(t.border).rounded(4).tooltip(action.kind === 'browser' ? 'Abrir en Dia' : 'Mostrar en Finder'));
      else chips.child(div().text_size(11).text_color(t.dim).child(name)
        .tooltip(evidence.availability === 'unavailable' ? 'Referencia no disponible' : 'Referencia sólo de lectura'));
    }
    row.child(chips);
  }
  const dataKey = `record-data-${key}`;
  row.child(control(dataKey, view.revealed.has(dataKey) ? 'Ocultar datos del registro' : 'Datos del registro',
    (_e, cx) => disclose(view, dataKey, cx), t).text_color(t.dim).text_size(11));
  if (view.revealed.has(dataKey)) row.child(label(JSON.stringify({ summary: event.summary, body: event.body,
    received_at: event.received_at, evidence: event.evidence, review: event.review, validation: event.validation }, null, 2), t));
  return row;
}
function eventRow(view, surface, id, event, t) {
  if (surface === 'detail' && view.role === 'page') return readingEvent(view, id, event, t);
  const key = `${surface}-${id}-${event.sequence}`, mini = surface === 'mini';
  const seen = view.model.isSeen(id, event.sequence), caption = miniCaption(event);
  const row = v_flex().id(`event-${key}`).flex_none();
  if (mini && view.role === 'section') {
    const metadata = [timestamp(event.received_at), kindLabel(event.kind),
      event.evidence.length ? `${event.evidence.length} adjunto${event.evidence.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    return row.gap(2).py(4)
      .child(h_flex().gap(6).min_w(0)
        .child(div().id(`unread-${key}`).flex_none().text_size(12).text_color(seen ? t.dim : t.ansi1).child('·').tooltip(seen ? 'Leído' : 'Sin leer'))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).line_height('17px').text_color(t.muted).child(caption).tooltip(caption)))
      .child(div().pl(10).truncate().text_size(10).line_height('14px').text_color(t.dim).child(metadata).tooltip(metadata));
  }
  row.gap(mini ? 5 : 9).py(mini ? 8 : 14).border_b_1().border_color(t.border)
    .child(label(`${seen ? 'Visto' : 'Nuevo'} · ${kindLabel(event.kind)} · ${timestamp(event.received_at)}`, t))
    .child(div().text_size(mini ? 14 : 16).line_height(mini ? '21px' : '25px').child(caption));
  if (!mini) {
    const bodyKey = `body-${key}`;
    row.child(control(`body-${key}`, view.revealed.has(bodyKey) ? 'Ocultar texto original' : 'Texto completo del avance',
      (_e, cx) => disclose(view, bodyKey, cx), t));
    if (view.revealed.has(bodyKey)) {
      if (event.summary && event.summary !== miniCaption(event)) row.child(div().text_size(14).line_height('22px').child(event.summary));
      row.child(div().id(`body-text-${key}`).text_size(16).line_height('25px').child(event.body));
    }
  }
  const review = reviewLabel(event);
  if (review) {
    // A concise surface never turns recorded scope into a current/global assurance.
    row.child(label(event.review ? 'Sólo el objeto/versión de esta revisión.' : 'No verifica el contenido actual ni otras versiones.', t));
    const scopeKey = `scope-${key}`;
    row.child(control(`metadata-${key}`, view.revealed.has(scopeKey) ? 'Ocultar alcance completo' : 'Objeto, versión y hash',
      (_e, cx) => disclose(view, scopeKey, cx), t));
    if (view.revealed.has(scopeKey)) row.child(label(review, t));
  }
  for (const [index, evidence] of event.evidence.entries()) {
    if (mini) {
      // Evidence stays next to the point without dumping paths or adding another reader.
      row.child(label(`Evidencia · ${referenceLabel(evidence.reference)}`, t));
    } else {
      row.child(v_flex().flex_none().gap(4).child(label(`Evidencia · ${evidence.kind}`, t))
        .child(reference(view, `${key}-${index}`, evidence.reference, t, evidence.availability, false)));
    }
  }
  return row;
}
export function renderReading(view, surface, id, t) {
  const model = view.model, page = model.page(surface, id), error = model.pageError(surface, id);
  const compact = view.role === 'section' && surface === 'mini';
  const root = v_flex().id(`surface-${surface}-${id}`).min_h(0).gap(compact ? 4 : 8);
  if (compact) root.pl(16).pr(6).pb(6);
  if (error) root.child(label(error, t)).child(control(`retry-${surface}-${id}`, 'Reintentar lectura',
    (_e, cx) => view.task(cx, () => page ? model.loadPage(surface, id, page.before, page.back) : model.ensurePage(surface, id)), t));
  if (!page) return root.child(label(model.pending.has(`${surface}:${id}`) ? 'Cargando…' : 'Sin avances cargados', t));
  const inline = (view.role === 'section' || view.role === 'page') && surface === 'detail';
  const reading = v_flex().id(`reading-${surface}-${id}-${page.before ?? 'latest'}`).min_h(0).gap(5)
    .children(page.events.map(event => eventRow(view, surface, id, event, t)));
  if (compact) reading.pl(8).border_l(1).border_color(t.border);
  if (inline || compact) reading.flex_none();
  else {
    reading.overflow_y_scrollbar();
    if (surface === 'mini') reading.h(220).max_h(220).flex_none(); else reading.flex_1();
  }
  if (!page.events.length) reading.child(label('Sin avances en esta página', t));
  root.child(reading);
  const navigation = v_flex().flex_none().gap(4);
  if (page.back.length) navigation.child(control(`newer-${surface}-${id}`, 'Página siguiente',
    (_e, cx) => view.task(cx, () => model.newer(surface, id)), t));
  if (page.next_before_sequence) navigation.child(control(`older-${surface}-${id}`, 'Página anterior',
    (_e, cx) => view.task(cx, () => model.older(surface, id)), t));
  if (page.before !== null) navigation.child(control(`latest-${surface}-${id}`, 'Más recientes',
    (_e, cx) => view.task(cx, () => model.latest(surface, id)), t));
  root.child(navigation);
  return surface === 'detail' && !inline ? root.flex_1() : root.flex_none();
}
export function renderReferences(view, id, t) {
  const root = v_flex().flex_none().gap(5), model = view.model;
  const names = { issue: 'Issues', pr: 'PRs', session: 'Sesiones' };
  const groups = model.referenceGroups(id);
  if (!groups.length) return null;
  root.child(h_flex().gap(6).flex_wrap().children(groups.map(({ kind, count, links }) => control(`references-${id}-${kind}`,
    `${names[kind]}${count === null ? '' : ` ${count}`}${links ? ` · enlaces ${links}` : ''}`,
    (_e, cx) => view.task(cx, () => model.toggleReferences(id, kind)), t).text_color(view.role === 'page' ? t.muted : t.accent))));
  for (const { kind } of groups) {
    if (!model.referencesVisible(id, kind)) continue;
    const panel = v_flex().id(`references-panel-${id}-${kind}`).h(140).max_h(140).flex_none().overflow_y_scrollbar().gap(6);
    const references = (model.thread(id).references ?? []).filter(ref => ref.kind === kind);
    references.forEach((ref, index) => panel.child(reference(view, `ref-${id}-${kind}-${index}`, ref.reference, t)));
    if (kind === 'session') {
      const sessions = model.sessions.get(id), error = model.errors.get(`sessions:${id}`);
      if (error) panel.child(label(error, t)).child(control(`retry-sessions-${id}`, 'Reintentar sesiones',
        (_e, cx) => view.task(cx, () => model.loadSessions(id)), t));
      if (!sessions) panel.child(label(error ? 'Sesiones no disponibles' : 'Cargando sesiones…', t));
      else {
        sessions.items.forEach((item, index) => panel.child(v_flex().flex_none().gap(4)
          .child(label(`${item.origin.agent} · Sesión ${index + 1}`, t))
          .child(reference(view, `session-${id}-${index}`, item.origin.session_ref, t))));
        if (!sessions.items.length) panel.child(label('Sin sesiones en esta página', t));
        if (sessions.next_after_sequence) panel.child(control(`more-sessions-${id}`, 'Más sesiones',
          (_e, cx) => view.task(cx, () => model.loadSessions(id, true)), t));
        panel.child(label('Origen registrado; no garantiza reabrir la sesión', t));
      }
    }
    root.child(panel);
  }
  return root;
}
function renderPage(view, t) {
  const id = view.model.selected, thread = view.model.thread(id);
  const root = v_flex().id('threads-reading-page').size_full().min_h(0).min_w(0);
  root.child(h_flex().h(40).flex_none().px(20).items_center().justify_between().border_b_1().border_color(t.border)
    .child(div().text_size(11).text_color(t.dim).child('Threads / Detalle'))
    .child(h_flex().gap(8).items_center()
      .child(iconControl('mark-read-page', '✓', 'Marcar thread como leído', (_e, cx) => view.markRead(id, cx), t))
      .child(control('return-workspace', '‹ Volver al workspace', (_e, cx) => view.returnToWorkspace(cx), t).text_color(t.muted))));
  const scroll = v_flex().id(`threads-page-scroll-${id ?? 'empty'}`).flex_1().min_h(0).min_w(0)
    .overflow_y_scrollbar().px(view.width < 600 ? 16 : 32);
  const column = v_flex().id('threads-reading-column').w_full().max_w(720).min_w(0).flex_none().py(28).gap(16);
  if (view.stateError || view.linkError || view.model.error) column.child(label(view.stateError ?? view.linkError ?? view.model.error, t));
  if (!id) column.child(label('Elige un thread desde el árbol izquierdo.', t));
  else {
    column.child(div().text_size(22).line_height('31px').font_semibold().child(thread?.title ?? 'Detalle del trabajo'));
    const counts = [];
    if (Number.isSafeInteger(thread?.event_count)) counts.push(`${thread.event_count} avance${thread.event_count === 1 ? '' : 's'}`);
    if (Number.isSafeInteger(thread?.session_count)) counts.push(`${thread.session_count} sesi${thread.session_count === 1 ? 'ón' : 'ones'}`);
    if (counts.length) column.child(div().text_size(11).text_color(t.dim).child(counts.join(' · ')));
    const references = renderReferences(view, id, t);
    if (references) column.child(references);
    column.child(renderReading(view, 'detail', id, t));
  }
  scroll.child(h_flex().w_full().flex_none().items_start().justify_center().child(column));
  return root.child(scroll);
}
export function renderDetail(view, t) {
  if (view.role === 'page') return renderPage(view, t);
  const id = view.model.selected, compact = view.role === 'section';
  const root = v_flex().id('threads-detail').flex_1().min_w(0).min_h(0).gap(compact ? 8 : 14).p(compact ? 10 : 16);
  if (compact) root.overflow_y_scrollbar();
  if (view.role === 'reader') {
    const header = h_flex().id('reader-header').flex_none().items_center().justify_between().gap(8)
      .child(label('Lector de Threads', t));
    if (view.workId) header.child(control('wide-reader', view.selection().wide ? 'Restaurar distribución' : 'Ampliar lectura',
      (_e, cx) => view.toggleWide(cx), t));
    header.child(iconControl('mark-read-reader', '✓', 'Marcar thread como leído', (_e, cx) => view.markRead(id, cx), t));
    header.child(control('close-reader', '× Cerrar lector', (_e, cx) => view.closeReader(cx), t)
      .tooltip('Cerrar sólo el lector; la terminal sigue funcionando.'));
    root.child(header);
  }
  if (view.stateError || view.linkError) root.child(label(view.stateError ?? view.linkError, t));
  if (!id) return root.child(label('Selecciona «Ver detalle» para leer un trabajo.', t));
  const thread = view.model.thread(id);
  root.child(div().flex_none().text_size(compact ? 14 : 20).line_height(compact ? '21px' : '28px').font_semibold().child(thread?.title ?? 'Detalle del trabajo'));
  const summary = shortPhrase(thread?.summary, 320);
  if (summary) root.child(div().flex_none().text_size(compact ? 13 : 16).line_height(compact ? '20px' : '25px').child(summary));
  if (thread?.summary && summary !== thread.summary.trim()) {
    const key = `summary-${id}`;
    root.child(control('full-work-summary', view.revealed.has(key) ? 'Ocultar resumen original' : 'Resumen completo del trabajo',
      (_e, cx) => disclose(view, key, cx), t));
    if (view.revealed.has(key)) root.child(div().h(100).flex_none().overflow_y_scrollbar()
      .child(div().text_size(16).line_height('25px').child(thread.summary)));
  }
  root.child(label('Visto ≠ revisado. Una revisión sólo cubre su objeto y versión.', t));
  if (view.role !== 'combined') { const references = renderReferences(view, id, t); if (references) root.child(references); }
  return root.child(renderReading(view, 'detail', id, t));
}
