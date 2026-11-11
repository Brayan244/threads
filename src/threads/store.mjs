// Same schema and canonical requests as the Python store; short-lived transactions.
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RecordDraft, Origin, ExternalReference, ValidationError, ConflictError, NotFoundError, StorageError, StoreBusyError, trimText, sliceText, text } from './domain.mjs';
import { parseJSON, stringify } from './json.mjs';

export const SCHEMA_VERSION = 2;
export const MIGRATION_1 = [
  `CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, retained INTEGER NOT NULL CHECK(retained IN (0,1)), references_json TEXT NOT NULL, latest_sequence INTEGER NOT NULL, event_count INTEGER NOT NULL, received_at TEXT NOT NULL)`,
  `CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL REFERENCES threads(id), agent TEXT NOT NULL, session_id TEXT NOT NULL, operation_key TEXT NOT NULL, request_json TEXT NOT NULL, event_json TEXT NOT NULL, UNIQUE(agent, session_id, operation_key))`,
  'CREATE INDEX event_thread_sequence ON events(thread_id, sequence)',
  'CREATE INDEX thread_latest ON threads(latest_sequence DESC)',
  'CREATE TABLE sessions (thread_id TEXT NOT NULL REFERENCES threads(id), agent TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(thread_id, agent, session_id))',
  'CREATE INDEX session_lookup ON sessions(agent, session_id, thread_id)',
  'CREATE TABLE external_references (thread_id TEXT NOT NULL REFERENCES threads(id), kind TEXT NOT NULL, reference TEXT NOT NULL, PRIMARY KEY(thread_id, kind, reference))',
  'CREATE INDEX reference_lookup ON external_references(kind, reference, thread_id)',
  "CREATE TRIGGER immutable_events_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END",
  "CREATE TRIGGER immutable_events_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END",
];
const MIGRATION_2 = [
  'CREATE TABLE association_operations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, session_id TEXT NOT NULL, operation_key TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id), request_json TEXT NOT NULL, binding_json TEXT NOT NULL, UNIQUE(agent, session_id, operation_key))',
  'CREATE INDEX association_thread ON association_operations(thread_id, sequence)',
  'CREATE TABLE current_associations (agent TEXT NOT NULL, session_id TEXT NOT NULL, sequence INTEGER NOT NULL REFERENCES association_operations(sequence), PRIMARY KEY(agent, session_id))',
  "CREATE TRIGGER immutable_associations_update BEFORE UPDATE ON association_operations BEGIN SELECT RAISE(ABORT, 'associations are append-only'); END",
  "CREATE TRIGGER immutable_associations_delete BEFORE DELETE ON association_operations BEGIN SELECT RAISE(ABORT, 'associations are append-only'); END",
];
// Rebuildable discovery index, not canonical history: keep schema-v2 exports and
// old writers compatible. SQLite triggers update it in the same transaction.
const SEARCH_INDEX = [
  "CREATE VIRTUAL TABLE thread_search_v1 USING fts5(title, summary, content='threads', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')",
  `CREATE TRIGGER thread_search_v1_insert AFTER INSERT ON threads BEGIN
    INSERT INTO thread_search_v1(rowid,title,summary) VALUES(new.rowid,new.title,new.summary); END`,
  `CREATE TRIGGER thread_search_v1_update AFTER UPDATE ON threads BEGIN
    INSERT INTO thread_search_v1(thread_search_v1,rowid,title,summary) VALUES('delete',old.rowid,old.title,old.summary);
    INSERT INTO thread_search_v1(rowid,title,summary) VALUES(new.rowid,new.title,new.summary); END`,
  `CREATE TRIGGER thread_search_v1_delete AFTER DELETE ON threads BEGIN
    INSERT INTO thread_search_v1(thread_search_v1,rowid,title,summary) VALUES('delete',old.rowid,old.title,old.summary); END`,
  "INSERT INTO thread_search_v1(thread_search_v1) VALUES('rebuild')",
];
export function searchQuery(value) {
  text(value,'query',320);
  const words=value.normalize('NFC').match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
  if(!words.length || words.length>16) throw new ValidationError('Search needs 1–16 literal terms');
  return words.map(word=>'"'+word+'"*').join(' AND ');
}
const normal = value => typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value;
const rowValues = row => row === undefined ? null : Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normal(value)]));
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
const now = () => new Date().toISOString().replace('Z', '000+00:00');
function bound(value, maximum, name) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new ValidationError(`Invalid ${name}`);
}
function cursor(value, name) {
  if (!(typeof value === 'bigint' ? value >= 0n && value <= 9223372036854775807n : Number.isSafeInteger(value) && value >= 0)) throw new ValidationError(`Invalid ${name}`);
}
function query(db, sql) {
  const statement = db.prepare(sql); statement.setReadBigInts(true);
  return { get: (...args) => rowValues(statement.get(...args)), all: (...args) => statement.all(...args).map(rowValues),
    run: (...args) => rowValues(statement.run(...args)) };
}
function event(row) {
  const value = parseJSON(row.event_json), received_at = value.received_at;
  delete value.received_at; delete value.sequence;
  return frozen({...RecordDraft.fromDict(value).toDict(),sequence:row.sequence,received_at});
}
function snapshot(row) {
  const {references_json, ...values} = row;
  return frozen({...values,retained:Boolean(values.retained),references:parseJSON(references_json).map(ref => ({...new ExternalReference(ref)}))});
}
function realMissing(path) {
  try{return fs.realpathSync.native(path);}catch(error){
    if(error.code!=='ENOENT')throw error;
    return join(realMissing(dirname(path)),basename(path));
  }
}
function insideGit(path) {
  for(let parent=path;;parent=dirname(parent)) {
    if(fs.existsSync(join(parent,'.git'))) return true;
    if(dirname(parent)===parent) return false;
  }
}
function privatePath(path, directory) {
  const info=fs.lstatSync(path);
  if (!(directory ? info.isDirectory() : info.isFile()) || typeof process.getuid !== 'function' || info.uid!==process.getuid() || (info.mode&0o077)) {
    throw new StorageError('Storage must be owner-only and not a symlink');
  }
}
export function defaultDataDir() {
  const base=process.env.XDG_DATA_HOME ?? join(homedir(),'.local/share');
  if(!isAbsolute(base)) throw new StorageError('XDG data directory must be absolute');
  return join(base,'threads');
}
export class Store {
  constructor(dataDir=defaultDataDir(),{busy_timeout_ms=5000}={}) {
    bound(busy_timeout_ms,60000,'busy timeout'); this.busyTimeoutMs=busy_timeout_ms;
    if(typeof dataDir!=='string'||!isAbsolute(dataDir)) throw new StorageError('Storage root must be absolute');
    const candidate=dataDir.replace(/(?:\/+|\/\.)+$/,'')||'/';
    try { if(fs.lstatSync(candidate).isSymbolicLink()) throw new StorageError('Storage root must not be a symlink'); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    this.dataDir=realMissing(candidate);
    if(insideGit(this.dataDir)) throw new StorageError('History must stay outside Git');
    fs.mkdirSync(this.dataDir,{mode:0o700,recursive:true}); privatePath(this.dataDir,true);
    this.databasePath=join(this.dataDir,'threads.sqlite3');
    try { const fd=fs.openSync(this.databasePath,'wx',0o600);fs.closeSync(fd); }
    catch(error) { if(error.code!=='EEXIST') throw error; }
    privatePath(this.databasePath,false);
    this.connection(db=>{
      let version=Number(query(db,'PRAGMA user_version').get().user_version);
      if(version>SCHEMA_VERSION) throw new StorageError('Unsupported history schema');
      if(version===0) {for(const sql of MIGRATION_1)db.exec(sql);version=1;}
      if(version===1) {for(const sql of MIGRATION_2)db.exec(sql);db.exec('PRAGMA user_version=2');}
      if(!query(db,"SELECT 1 FROM sqlite_master WHERE name='thread_search_v1'").get()) {
        for(const sql of SEARCH_INDEX)db.exec(sql);
      }
    },true);
  }
  connection(action,write=false) {
    let db,started=false;
    try {
      db=new DatabaseSync(this.databasePath); db.exec('PRAGMA foreign_keys=ON');
      db.exec(`PRAGMA busy_timeout=${this.busyTimeoutMs}`);db.exec(write?'BEGIN IMMEDIATE':'BEGIN');started=true;
      const result=action(db);db.exec('COMMIT');started=false;return result;
    } catch(error) {
      if(started) {try {db.exec('ROLLBACK');}catch{/* Preserve the original failure. */}}
      if([5,6].includes(Number(error.errcode)&255)) throw new StoreBusyError('History is busy; retry the identical operation');
      throw error;
    } finally {if(db)db.close();}
  }
  append(draft) {
    if(!(draft instanceof RecordDraft)) throw new ValidationError('Append requires a RecordDraft');
    const request=stringify(draft.toDict());
    return this.connection(db=>{
      const old=query(db,'SELECT * FROM events WHERE agent=? AND session_id=? AND operation_key=?').get(draft.origin.agent,draft.origin.session_id,draft.operation_key);
      if(old) {if(old.request_json!==request)throw new ConflictError('Operation key conflict');return event(old);}
      const threadId=draft.thread_id ?? randomUUID(),receivedAt=now();
      if(draft.thread_id===null) query(db,"INSERT INTO threads VALUES (?, ?, ?, 0, '[]', 0, 0, ?)").run(threadId,
        draft.title ?? sliceText(trimText(draft.body).split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)[0],240),draft.summary ?? sliceText(draft.body,4000),receivedAt);
      const row=query(db,'SELECT * FROM threads WHERE id=?').get(threadId);
      if(!row)throw new NotFoundError('Unknown thread');
      const values={...draft.toDict(),thread_id:threadId,received_at:receivedAt};
      const inserted=query(db,'INSERT INTO events(thread_id,agent,session_id,operation_key,request_json,event_json) VALUES (?,?,?,?,?,?)')
        .run(threadId,draft.origin.agent,draft.origin.session_id,draft.operation_key,request,stringify(values));
      const sequence=inserted.lastInsertRowid;
      const references=draft.references===null?row.references_json:stringify(values.references);
      query(db,'UPDATE threads SET title=?,summary=?,retained=?,references_json=?,latest_sequence=?,event_count=event_count+1,received_at=? WHERE id=?')
        .run(draft.title ?? row.title,draft.summary ?? sliceText(draft.body,4000),draft.retained===null?row.retained:Number(draft.retained),references,sequence,receivedAt,threadId);
      query(db,'INSERT OR IGNORE INTO sessions VALUES (?,?,?)').run(threadId,draft.origin.agent,draft.origin.session_id);
      for(const reference of draft.references ?? [])query(db,'INSERT OR IGNORE INTO external_references VALUES (?,?,?)').run(threadId,reference.kind,reference.reference);
      this.bind(db,draft.origin,threadId,draft.operation_key,'record',receivedAt);
      return frozen({...values,sequence});
    },true);
  }
  bind(db,origin,threadId,operationKey,source,receivedAt) {
    const key=source+':'+operationKey,request=stringify({origin:{...origin},thread_id:threadId});
    const old=query(db,'SELECT * FROM association_operations WHERE agent=? AND session_id=? AND operation_key=?').get(origin.agent,origin.session_id,key);
    if(old) {if(old.request_json!==request)throw new ConflictError('Association key conflict');return {...parseJSON(old.binding_json),sequence:old.sequence};}
    if(!query(db,'SELECT 1 FROM threads WHERE id=?').get(threadId))throw new NotFoundError('Unknown thread');
    const binding={origin:{...origin},thread_id:threadId,operation_key:operationKey,source,received_at:receivedAt};
    const inserted=query(db,'INSERT INTO association_operations(agent,session_id,operation_key,thread_id,request_json,binding_json) VALUES (?,?,?,?,?,?)')
      .run(origin.agent,origin.session_id,key,threadId,request,stringify(binding));
    query(db,'INSERT INTO current_associations VALUES (?,?,?) ON CONFLICT(agent,session_id) DO UPDATE SET sequence=excluded.sequence')
      .run(origin.agent,origin.session_id,inserted.lastInsertRowid);
    query(db,'INSERT OR IGNORE INTO sessions VALUES (?,?,?)').run(threadId,origin.agent,origin.session_id);
    return {...binding,sequence:inserted.lastInsertRowid};
  }
  associate(origin,threadId,operationKey) {
    const draft=RecordDraft.fromDict({kind:'observation',body:'association',origin,operation_key:operationKey,thread_id:threadId});
    if(draft.thread_id===null)throw new ValidationError('Association needs a thread');
    return this.connection(db=>this.bind(db,draft.origin,threadId,operationKey,'associate',now()),true);
  }
  currentAssociation(origin) {
    if(!(origin instanceof Origin))throw new ValidationError('Origin required');
    return this.connection(db=>{
      const row=query(db,'SELECT a.* FROM current_associations c JOIN association_operations a ON a.sequence=c.sequence WHERE c.agent=? AND c.session_id=?').get(origin.agent,origin.session_id);
      return row?{...parseJSON(row.binding_json),sequence:row.sequence}:null;
    });
  }
  associationHistory(threadId,{after_sequence=0,limit=50}={}) {
    cursor(after_sequence,'after sequence');bound(limit,200,'limit');
    return this.connection(db=>{
      if(!query(db,'SELECT 1 FROM threads WHERE id=?').get(threadId))throw new NotFoundError('Unknown thread');
      return query(db,'SELECT * FROM association_operations WHERE thread_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(threadId,after_sequence,limit)
        .map(row=>({...parseJSON(row.binding_json),sequence:row.sequence}));
    });
  }
  sessionCount(threadId) {return this.connection(db=>query(db,'SELECT COUNT(*) AS count FROM sessions WHERE thread_id=?').get(threadId).count);}
  getThread(threadId) {
    return this.connection(db=>{const row=query(db,'SELECT * FROM threads WHERE id=?').get(threadId);if(!row)throw new NotFoundError('Unknown thread');return snapshot(row);});
  }
  listThreads({limit=50,before_sequence=null,origin=null,reference=null}={}) {
    bound(limit,100,'limit');const clauses=[],parameters=[];
    if(before_sequence!==null){cursor(before_sequence,'before sequence');clauses.push('t.latest_sequence < ?');parameters.push(before_sequence);}
    if(origin!==null){if(!(origin instanceof Origin))throw new ValidationError('Origin filter required');clauses.push('EXISTS (SELECT 1 FROM sessions s WHERE s.thread_id=t.id AND s.agent=? AND s.session_id=?)');parameters.push(origin.agent,origin.session_id);}
    if(reference!==null){const ref=new ExternalReference(reference);clauses.push('EXISTS (SELECT 1 FROM external_references r WHERE r.thread_id=t.id AND r.kind=? AND r.reference=?)');parameters.push(ref.kind,ref.reference);}
    return this.connection(db=>query(db,'SELECT t.* FROM threads t'+(clauses.length?' WHERE '+clauses.join(' AND '):'')+' ORDER BY t.latest_sequence DESC LIMIT ?').all(...parameters,limit).map(snapshot));
  }
  searchThreads(value,{limit=5}={}) {
    bound(limit,20,'limit');const match=searchQuery(value);
    return this.connection(db=>{
      const rows=query(db,`SELECT t.* FROM thread_search_v1 JOIN threads t ON t.rowid=thread_search_v1.rowid
        WHERE thread_search_v1 MATCH ? ORDER BY bm25(thread_search_v1,5.0,1.0),t.latest_sequence DESC LIMIT ?`).all(match,limit+1);
      return {threads:rows.slice(0,limit).map(snapshot),has_more:rows.length>limit};
    });
  }
  events(threadId,{after_sequence=0,limit=50}={}) {cursor(after_sequence,'after sequence');return this.eventsPage(threadId,limit,after_sequence,false);}
  recentEvents(threadId,{before_sequence=null,limit=10}={}) {if(before_sequence!==null)cursor(before_sequence,'before sequence');return this.eventsPage(threadId,limit,before_sequence,true);}
  eventsPage(threadId,limit,position,newest) {
    bound(limit,200,'limit');
    return this.connection(db=>{
      if(!query(db,'SELECT 1 FROM threads WHERE id=?').get(threadId))throw new NotFoundError('Unknown thread');
      const clause=position===null?'':newest?' AND sequence<?':' AND sequence>?';
      const parameters=position===null?[threadId,limit]:[threadId,position,limit];
      return query(db,'SELECT * FROM events WHERE thread_id=?'+clause+' ORDER BY sequence '+(newest?'DESC':'ASC')+' LIMIT ?').all(...parameters).map(event);
    });
  }
  exportJson() {
    return this.connection(db=>stringify({schema_version:SCHEMA_VERSION,
      threads:query(db,'SELECT * FROM threads ORDER BY latest_sequence').all().map(snapshot),
      events:query(db,'SELECT * FROM events ORDER BY sequence').all().map(event),
      associations:query(db,'SELECT * FROM association_operations ORDER BY sequence').all().map(row=>({...parseJSON(row.binding_json),sequence:row.sequence})),
      current_associations:query(db,'SELECT a.* FROM current_associations c JOIN association_operations a ON a.sequence=c.sequence ORDER BY a.sequence').all().map(row=>({...parseJSON(row.binding_json),sequence:row.sequence})),
    },{pretty:true}));
  }
}
