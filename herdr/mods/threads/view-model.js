// Read-only CLI v1 consumer. Native rendering and exposure signals live in main/detail.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validSequence = value => Number.isSafeInteger(value) && value > 0;
const validCursor = value => value === null || validSequence(value);
const path = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\x00-\x1f\x7f]/.test(value);
const failure = () => new Error('No se pudo completar la lectura de Threads.');
const kinds = ['issue', 'pr', 'session'];

export function createClient(exec, config = {}) {
  const cli = config.cli ?? 'threads', dataDir = config.dataDir;
  if ((cli !== 'threads' && !path(cli)) || (dataDir !== undefined && !path(dataDir))) throw failure();
  const prefix = dataDir === undefined ? [] : ['--data-dir', dataDir];
  async function read(command, id, cursor) {
    try {
      if (id !== undefined && (typeof id !== 'string' || !UUID.test(id))) throw failure();
      if (cursor !== undefined && cursor !== null && !validSequence(cursor)) throw failure();
      const args = [...prefix, command];
      if (id !== undefined) args.push(id);
      args.push('--limit', command === 'show' ? '10' : '20');
      if (command === 'list' || command === 'show') args.push('--include-references');
      if (cursor !== undefined && cursor !== null) args.push(command === 'sessions' ? '--after-sequence' : '--before-sequence', String(cursor));
      // Installed Herdr exec enforces 30 seconds and 8 MiB. No shell or per-card poll.
      const r = await exec(cli, args);
      if (r.code !== 0 || r.stderr !== '' || typeof r.stdout !== 'string' || r.stdout.length > 8 * 1024 * 1024) throw failure();
      const envelope = JSON.parse(r.stdout), result = envelope.result;
      if (envelope.contract_version !== 1 || envelope.ok !== true || !result || typeof result !== 'object') throw failure();
      const key = command === 'list' ? 'threads' : command === 'show' ? 'events' : 'associations';
      const cursorKey = command === 'sessions' ? 'next_after_sequence' : 'next_before_sequence';
      if (!Array.isArray(result[key]) || result[key].length > (command === 'show' ? 10 : 20) || !validCursor(result[cursorKey])) throw failure();
      const checkThread = thread => {
        if (!thread || !UUID.test(thread.id) || typeof thread.title !== 'string' || typeof thread.summary !== 'string' ||
            !validSequence(thread.latest_sequence) || !validSequence(thread.event_count) ||
            (thread.session_count !== undefined && (!Number.isSafeInteger(thread.session_count) || thread.session_count < 0)) ||
            (thread.references !== undefined && (!Array.isArray(thread.references) || thread.references.some(ref => !kinds.includes(ref.kind) || typeof ref.reference !== 'string')))) throw failure();
      };
      if (command === 'list') result.threads.forEach(checkThread);
      if (command === 'show') {
        checkThread(result.thread);
        if (result.thread.id !== id || result.events.some(event => event.thread_id !== id || !validSequence(event.sequence) ||
            typeof event.body !== 'string' || typeof event.kind !== 'string' || !Array.isArray(event.evidence))) throw failure();
      }
      if (command === 'sessions' && result.associations.some(item => item.thread_id !== id || !validSequence(item.sequence) ||
          !item.origin || typeof item.origin.agent !== 'string' || !UUID.test(item.origin.session_id) || typeof item.origin.session_ref !== 'string')) throw failure();
      return result;
    } catch { throw failure(); }
  }
  return { list: before => read('list', undefined, before), show: (id, before) => read('show', id, before),
    sessions: (id, after) => read('sessions', id, after) };
}

// Opening is always a separate user action. Local files are revealed, never executed.
export function referenceAction(reference) {
  if (typeof reference !== 'string' || /[\x00-\x1f\x7f]/.test(reference)) return null;
  if (path(reference)) return { kind: 'reveal', value: reference };
  try {
    const url = new URL(reference);
    if (url.username || url.password) return null;
    if (['http:', 'https:'].includes(url.protocol) && url.hostname) return { kind: 'browser', value: reference };
    if (url.protocol === 'file:' && ['', 'localhost'].includes(url.hostname)) {
      const local = decodeURIComponent(url.pathname);
      if (path(local)) return { kind: 'reveal', value: local };
    }
  } catch { /* Opaque issue identifiers remain readable, not executable. */ }
  return null;
}

const targetLabel = target => [target?.object_id, target?.version && `versión ${target.version}`,
  target?.digest && `digest ${target.digest}`, !target?.version && !target?.digest && 'sin versión verificable']
  .filter(Boolean).join(' · ');
export function reviewLabel(event) {
  if (event.review) return `Revisión registrada: ${event.review.disposition === 'approved' ? 'aprobación' : 'cambios solicitados'} · ${targetLabel(event.review.target)} (solo este objeto/versión)`;
  if (event.validation) return `Validación registrada: ${event.validation.outcome === 'passed' ? 'pasó' : 'falló'} · ${targetLabel(event.validation.target)} (no verifica el contenido actual)`;
  return '';
}

const kindNames = { observation: 'Observación', hypothesis: 'Hipótesis', decision: 'Decisión',
  progress: 'Avance', review_finding: 'Hallazgo', validation: 'Validación' };
export const kindLabel = kind => Object.hasOwn(kindNames, kind) ? kindNames[kind] : 'Avance';
export const validThreadId = value => typeof value === 'string' && UUID.test(value);
export const validSeenKey = value => typeof value === 'string' && /^[-a-f0-9]{36}:\d+$/.test(value);
export const validReadMark = value => Array.isArray(value) && value.length === 2 && validThreadId(value[0]) && validSequence(value[1]);

// Preserve a complete source sentence, not an invented summary or an ellipsis.
export function shortPhrase(value, maximum = 140) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || /[\n\r]|```|https?:\/\/|sha256:|[a-f0-9]{48,}|(?:^|\s)\/\S+|^[{\[]/i.test(text)) return '';
  const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0];
  if (sentence && sentence.length <= maximum && !/^\d+[.!?]$/.test(sentence)) return sentence;
  return text.length <= maximum ? text : '';
}
export function miniCaption(event) {
  const label = kindLabel(event.kind), masculine = label === 'Avance' || label === 'Hallazgo';
  return shortPhrase(event.summary) || shortPhrase(event.body) || `${label} registrad${masculine ? 'o' : 'a'}.`;
}
export function referenceLabel(value) {
  if (typeof value !== 'string') return 'Referencia';
  try {
    if (value.startsWith('/')) return value.split('/').filter(Boolean).at(-1) ?? 'Archivo local';
    const url = new URL(value);
    return decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? url.hostname) || 'Referencia';
  } catch { return value.length <= 80 ? value : 'Referencia registrada'; }
}

export class ThreadsModel {
  constructor(client, saved = {}) {
    this.client = client;
    this.threads = []; this.olderListCursor = null; this.listHead = null; this.listGaps = [];
    this.loading = false; this.error = null;
    this.expanded = new Set(Array.isArray(saved.expanded) ? saved.expanded.filter(id => UUID.test(id)) : []);
    this.selected = typeof saved.selected === 'string' && UUID.test(saved.selected) ? saved.selected : null;
    this.seen = new Set(Array.isArray(saved.seen) ? saved.seen.filter(validSeenKey) : []);
    this.readThrough = new Map();
    for (const mark of Array.isArray(saved.readThrough) ? saved.readThrough : []) {
      if (validReadMark(mark)) this.readThrough.set(mark[0], Math.max(this.readThrough.get(mark[0]) ?? 0, mark[1]));
    }
    this.pages = new Map(); this.requests = new Map(); this.errors = new Map(); this.pending = new Set();
    this.referencePanels = new Set(); this.sessions = new Map();
    this.savedPages = new Map(Array.isArray(saved.pages) ? saved.pages.filter(entry => {
      if (!Array.isArray(entry) || entry.length !== 2) return false;
      const [key, value] = entry;
      return typeof key === 'string' && /^(mini|detail):[-a-f0-9]{36}$/.test(key) && value && validCursor(value.before) &&
        Array.isArray(value.back) && value.back.every(validCursor);
    }) : []);
  }
  snapshot() {
    const pages = new Map(this.savedPages);
    for (const [key, page] of this.pages) pages.set(key, { before: page.before, back: page.back });
    return { selected: this.selected, expanded: [...this.expanded], seen: [...this.seen],
      readThrough: [...this.readThrough], pages: [...pages] };
  }
  thread(id) { return this.threads.find(thread => thread.id === id) ?? this.page('detail', id)?.thread ?? this.page('mini', id)?.thread; }
  page(surface, id) { return this.pages.get(`${surface}:${id}`); }
  pageError(surface, id) { return this.errors.get(`${surface}:${id}`); }
  isSeen(id, sequence) {
    return validSequence(sequence) && (sequence <= (this.readThrough.get(id) ?? 0) || this.seen.has(`${id}:${sequence}`));
  }
  latestSequence(id) {
    return Math.max(0, ...[this.thread(id), this.page('mini', id)?.thread, this.page('detail', id)?.thread]
      .map(thread => thread?.latest_sequence).filter(validSequence));
  }
  hasUnread(id) {
    const latest = this.latestSequence(id);
    return latest > 0 && !this.isSeen(id, latest);
  }
  markRead(id) {
    const latest = this.latestSequence(id);
    if (!validThreadId(id) || latest === 0 || latest <= (this.readThrough.get(id) ?? 0)) return false;
    this.readThrough.set(id, latest);
    return true;
  }
  hasUpdates(surface, id) {
    const page = this.page(surface, id);
    return Boolean(page && this.thread(id)?.latest_sequence > page.loadedLatest);
  }
  get listCursor() { return this.listGaps[0]?.before ?? this.olderListCursor; }
  async refresh(more = false) {
    if (this.loading || (more && this.listCursor === null)) return false;
    const previous = this.threads, previousCursor = this.listCursor, previousError = this.error;
    this.loading = true;
    try {
      const result = await this.client.list(more ? this.listCursor : undefined);
      // Preserve existing row order/scroll anchors. New arrivals never push a reading card down.
      const incoming = new Map(result.threads.map(thread => [thread.id, thread]));
      const nextThreads = this.threads.map(thread => {
        const next = incoming.get(thread.id);
        return next && JSON.stringify(next) !== JSON.stringify(thread) ? next : thread;
      });
      const ids = new Set(nextThreads.map(thread => thread.id));
      nextThreads.push(...result.threads.filter(thread => !ids.has(thread.id)));
      if (nextThreads.length !== previous.length || nextThreads.some((thread, index) => thread !== previous[index])) {
        this.threads = nextThreads;
      }
      const next = result.next_before_sequence;
      if (more) {
        const gap = this.listGaps[0];
        if (!gap) this.olderListCursor = next;
        // Numeric coverage, not a familiar thread ID, closes a refreshed gap.
        else if (next === null || result.threads.at(-1).latest_sequence <= gap.through) this.listGaps.shift();
        else gap.before = next;
      } else {
        const newest = result.threads[0]?.latest_sequence ?? 0;
        if (this.listHead === null) this.olderListCursor = next;
        else if (next !== null && result.threads.at(-1).latest_sequence > this.listHead) {
          // Each head read adds only its uncovered interval. FIFO ranges retain
          // catch-up progress across polls and leave the older traversal intact.
          this.listGaps.push({ before: next, through: this.listHead });
        }
        this.listHead = Math.max(this.listHead ?? 0, newest);
      }
      this.error = null;
    } catch { this.error = failure().message; }
    finally { this.loading = false; }
    return this.threads !== previous || this.listCursor !== previousCursor || this.error !== previousError;
  }
  async restore() {
    const work = [...this.expanded].map(id => this.ensurePage('mini', id));
    if (this.selected) work.push(this.ensurePage('detail', this.selected));
    await Promise.all(work);
  }
  async ensurePage(surface, id) {
    if (this.page(surface, id)) return;
    const saved = this.savedPages.get(`${surface}:${id}`);
    return this.loadPage(surface, id, saved?.before ?? null, saved?.back ?? []);
  }
  async toggleHistory(id) {
    if (this.expanded.has(id)) { this.expanded.delete(id); return; }
    this.expanded.add(id);
    await this.ensurePage('mini', id);
  }
  async selectDetail(id) { this.selected = id; await this.ensurePage('detail', id); }
  async loadPage(surface, id, before, back) {
    const key = `${surface}:${id}`, token = (this.requests.get(key) ?? 0) + 1;
    const previous = this.page(surface, id), previousError = this.errors.get(key);
    this.requests.set(key, token); this.pending.add(key);
    try {
      const result = await this.client.show(id, before);
      if (this.requests.get(key) !== token) return false;
      const next = { ...result, before, back, loadedLatest: result.thread.latest_sequence };
      const changed = JSON.stringify(previous) !== JSON.stringify(next);
      if (changed) this.pages.set(key, next);
      this.errors.delete(key);
      return changed || previousError !== undefined;
    } catch {
      if (this.requests.get(key) !== token) return false;
      const message = failure().message;
      this.errors.set(key, message);
      return previousError !== message;
    } finally { if (this.requests.get(key) === token) this.pending.delete(key); }
  }
  async refreshLatest(surface, id) {
    const page = this.page(surface, id), key = `${surface}:${id}`;
    if (!page || page.before !== null || this.pending.has(key) || (!this.hasUpdates(surface, id) && !this.errors.has(key))) return false;
    return this.loadPage(surface, id, null, page.back);
  }
  async older(surface, id) {
    const page = this.page(surface, id);
    if (page?.next_before_sequence) return this.loadPage(surface, id, page.next_before_sequence, [...page.back, page.before]);
  }
  async newer(surface, id) {
    const page = this.page(surface, id);
    if (page?.back.length) return this.loadPage(surface, id, page.back.at(-1), page.back.slice(0, -1));
  }
  async latest(surface, id) { return this.loadPage(surface, id, null, []); }
  expose(surface, id, sequence, entered) {
    // Compatibility for previously recorded sparse exposure. Current UI controls
    // use explicit markRead; rendering, polling and hovering never call this.
    if (!entered || (surface === 'mini' ? !this.expanded.has(id) : surface !== 'detail' || this.selected !== id) ||
        !this.page(surface, id)?.events.some(event => event.sequence === sequence)) return false;
    const key = `${id}:${sequence}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key); return true;
  }
  referenceGroups(id) {
    const thread = this.thread(id);
    if (!thread) return [];
    return kinds.map(kind => {
      const links = (thread.references ?? []).filter(ref => ref.kind === kind).length;
      if (kind !== 'session') return { kind, count: links };
      // Explicit session links are not evidence of another distinct attributed
      // session. Present their count separately rather than adding it to COUNT(*).
      return { kind, count: thread.session_count ?? null, ...(links ? { links } : {}) };
    }).filter(group => group.count > 0 || group.links > 0);
  }
  referencesVisible(id, kind) { return this.referencePanels.has(`${id}:${kind}`); }
  async toggleReferences(id, kind) {
    const key = `${id}:${kind}`;
    if (this.referencePanels.has(key)) { this.referencePanels.delete(key); return; }
    this.referencePanels.add(key);
    if (kind === 'session') await this.loadSessions(id);
  }
  async loadSessions(id, more = false) {
    const key = `sessions:${id}`, current = this.sessions.get(id);
    if (this.pending.has(key) || (more && !current?.next_after_sequence)) return;
    this.pending.add(key); this.errors.delete(key);
    try {
      const result = await this.client.sessions(id, more ? current.next_after_sequence : undefined);
      const unique = new Map((more ? current.items : []).map(item => [`${item.origin.agent}:${item.origin.session_id}`, item]));
      for (const item of result.associations) unique.set(`${item.origin.agent}:${item.origin.session_id}`, item);
      this.sessions.set(id, { items: [...unique.values()], next_after_sequence: result.next_after_sequence });
    } catch { this.errors.set(key, failure().message); }
    finally { this.pending.delete(key); }
  }
}
