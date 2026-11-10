// Immutable semantic values. Runtime authenticity belongs to the invoking host.
import { isIP } from 'node:net';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class StorageError extends Error {}
export class StoreBusyError extends StorageError {}

const choices = (...values) => new Set(values);
const kinds = choices('observation','hypothesis','decision','progress','review_finding','validation');
const referenceKinds = choices('issue','pr','session');
const evidenceKinds = choices('document','screenshot','report','result','link','other');
const availability = choices('unknown','available','unavailable');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const whitespace = /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
export const trimText = value => value.replace(whitespace, '');
export const sliceText = (value, length) => Array.from(value).slice(0, length).join('');
export function text(value, name, maximum = 2048) {
  if (typeof value !== 'string' || !trimText(value) || Array.from(value).length > maximum || value.includes('\0') || !value.isWellFormed()) {
    throw new ValidationError(`Invalid ${name}`);
  }
  return value;
}
export function canonicalId(value, name = 'thread_id') {
  if (typeof value !== 'string' || !uuid.test(value) || value === '00000000-0000-0000-0000-000000000000') throw new ValidationError(`Invalid ${name}`);
  return value;
}
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ValidationError('Invalid typed object');
  return value;
}
function choice(value, allowed) {
  if (!allowed.has(value)) throw new ValidationError('Invalid enum value');
  return value;
}
export function reference(value) {
  text(value, 'reference');
  if (/[\x00-\x1f]/.test(value)) throw new ValidationError('Reference contains control characters');
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  // Preserve the old urlsplit contract without URL's host/port normalization.
  const match = value.replace(/^ +/, '').match(/^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)/);
  if (!match) throw new ValidationError('Absolute reference required');
  const scheme = match[1].toLowerCase(), authority = match[2] ?? '', pathname = match[3];
  if (!['http','https','file'].includes(scheme)) throw new ValidationError('Unsafe reference scheme');
  if (/[/?#@:]/.test(authority.replace(/[@:#?]/g, '').normalize('NFKC'))) throw new ValidationError('Malformed URL authority');
  const userAt = authority.lastIndexOf('@');
  const host = userAt < 0 ? authority : authority.slice(userAt + 1);
  if (userAt >= 0 && authority.slice(0, userAt).replace(':', '')) throw new ValidationError('URL credentials are forbidden');
  if (host.includes('[') || host.includes(']')) {
    const bracketed = host.match(/^\[([^\]]+)\](?::[^/]*)?$/);
    if (!bracketed || !(isIP(bracketed[1]) === 6 || /^v[\da-f]+\..+/i.test(bracketed[1]))) throw new ValidationError('Malformed URL host');
  }
  if (scheme === 'file') {
    if (!['','localhost'].includes(authority) || !pathname.startsWith('/')) throw new ValidationError('File reference must be local and absolute');
  } else if (match[2] === undefined || !host || !host.split(':')[0]) throw new ValidationError('URL requires a host');
  return value;
}

export class Origin {
  constructor(value) {
    object(value, ['agent','session_id','session_ref']);
    this.agent = text(value.agent, 'agent', 80);
    this.session_id = canonicalId(value.session_id, 'session_id');
    this.session_ref = reference(value.session_ref);
    Object.freeze(this);
  }
}
export class ExternalReference {
  constructor(value) {
    object(value, ['kind','reference']);
    this.kind = choice(value.kind, referenceKinds);
    this.reference = text(value.reference, 'external reference');
    if (this.reference.includes(':') || this.reference.startsWith('/')) reference(this.reference);
    Object.freeze(this);
  }
}
export class ObjectVersion {
  constructor(value) {
    object(value, ['object_id','version','digest']);
    this.object_id = text(value.object_id, 'object_id');
    this.version = value.version ?? null;
    this.digest = value.digest ?? null;
    if (this.version !== null) text(this.version, 'version', 256);
    if (this.digest !== null) text(this.digest, 'digest', 256);
    Object.freeze(this);
  }
  get pinned() { return this.version !== null || this.digest !== null; }
}
export class Evidence {
  constructor(value) {
    object(value, ['kind','reference','target','availability']);
    this.kind = choice(value.kind, evidenceKinds);
    this.reference = reference(value.reference);
    this.target = value.target == null ? null : new ObjectVersion(value.target);
    this.availability = choice(value.availability === undefined ? 'unknown' : value.availability, availability);
    Object.freeze(this);
  }
}
export class Review {
  constructor(value) {
    object(value, ['target','instruction','disposition']);
    this.target = new ObjectVersion(value.target);
    this.instruction = text(value.instruction, 'human review instruction', 4000);
    this.disposition = choice(value.disposition, choices('approved','changes_requested'));
    Object.freeze(this);
  }
}
export class Validation {
  constructor(value) {
    object(value, ['target','outcome']);
    this.target = new ObjectVersion(value.target);
    this.outcome = choice(value.outcome, choices('passed','failed'));
    Object.freeze(this);
  }
}
export class RecordDraft {
  constructor(value) {
    object(value, ['kind','body','origin','operation_key','thread_id','title','summary','references','retained','evidence','review','validation']);
    this.kind = choice(value.kind, kinds);
    this.body = text(value.body, 'body', 16000);
    this.origin = new Origin(value.origin);
    this.operation_key = text(value.operation_key, 'operation_key', 200);
    this.thread_id = value.thread_id ?? null;
    if (this.thread_id !== null) canonicalId(this.thread_id);
    this.title = value.title ?? null;
    this.summary = value.summary ?? null;
    if (this.title !== null) text(this.title, 'title', 240);
    if (this.summary !== null) text(this.summary, 'summary', 4000);
    this.retained = value.retained ?? null;
    if (this.retained !== null && typeof this.retained !== 'boolean') throw new ValidationError('Retained must be boolean');
    const list = (items, Type) => {
      if (!Array.isArray(items) || items.length > 32) throw new ValidationError('At most 32 typed references are allowed');
      return Object.freeze(items.map(item => new Type(item)));
    };
    this.references = value.references == null ? null : list(value.references, ExternalReference);
    if (this.references && new Set(this.references.map(ref => ref.kind + '\0' + ref.reference)).size !== this.references.length) throw new ValidationError('Duplicate external references');
    this.evidence = list(value.evidence === undefined ? [] : value.evidence, Evidence);
    this.review = value.review == null ? null : new Review(value.review);
    this.validation = value.validation == null ? null : new Validation(value.validation);
    if (this.review && this.kind !== 'review_finding') throw new ValidationError('Review requires review_finding kind');
    if (this.validation && this.kind !== 'validation') throw new ValidationError('Validation requires validation kind');
    Object.freeze(this);
  }
  static fromDict(value) { return new RecordDraft(value); }
  toDict() { return structuredClone(this); }
}

const matches = (recorded, current) => recorded.object_id === current.object_id && recorded.pinned &&
  ['version','digest'].every(field => recorded[field] === null || recorded[field] === current[field]);
export function assess(evidence, current, { review = null, validation = null } = {}) {
  // Stored events and wire values have no class prototypes; normalize explicitly.
  current = new ObjectVersion(current);
  evidence = evidence.map(item => new Evidence(item));
  review = review === null ? null : new Review(review);
  validation = validation === null ? null : new Validation(validation);
  const action = review ?? validation;
  if (!action || (review && review.disposition !== 'approved') || (validation && validation.outcome !== 'passed')) return 'none';
  if (!action.target.pinned || !current.pinned) return 'unverifiable';
  if (!matches(action.target, current)) return 'stale';
  const matching = evidence.filter(item => item.target && matches(item.target, current));
  if (matching.some(item => item.availability === 'available')) return review ? 'reviewed' : 'validated';
  if (matching.some(item => item.availability === 'unavailable')) return 'unavailable';
  return 'unverifiable';
}
