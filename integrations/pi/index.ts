import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadBridge } from "./bridge-loader.mjs";

const text = (maximum = 2048) => Type.String({ minLength: 1, maxLength: maximum });
const nullable = <T extends ReturnType<typeof text>>(schema: T) => Type.Union([schema, Type.Null()]);
const choices = (...values: string[]) => Type.Union(values.map(value => Type.Literal(value)));
const target = Type.Object({
  object_id: text(), version: Type.Optional(nullable(text(256))), digest: Type.Optional(nullable(text(256))),
}, { additionalProperties: false });
const referenceKind = choices("issue", "pr", "session");
const record = Type.Object({
  kind: choices("observation", "hypothesis", "decision", "progress", "review_finding", "validation"),
  body: text(16000),
  operation_key: text(200),
  thread_id: Type.Optional(nullable(text(36))),
  title: Type.Optional(nullable(text(240))),
  summary: Type.Optional(nullable(text(4000))),
  retained: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  references: Type.Optional(Type.Union([Type.Array(Type.Object({
    kind: referenceKind, reference: text(),
  }, { additionalProperties: false }), { maxItems: 32 }), Type.Null()])),
  evidence: Type.Optional(Type.Array(Type.Object({
    kind: choices("document", "screenshot", "report", "result", "link", "other"),
    reference: text(),
    target: Type.Optional(Type.Union([target, Type.Null()])),
    availability: Type.Optional(choices("unknown", "available", "unavailable")),
  }, { additionalProperties: false }), { maxItems: 32 })),
  review: Type.Optional(Type.Union([Type.Object({
    target, instruction: text(4000), disposition: choices("approved", "changes_requested"),
  }, { additionalProperties: false }), Type.Null()])),
  validation: Type.Optional(Type.Union([Type.Object({
    target, outcome: choices("passed", "failed"),
  }, { additionalProperties: false }), Type.Null()])),
}, { additionalProperties: false });
// Pi captures at most 16 MiB. Budget for up to 6x JSON ASCII escaping of each
// 64 KiB CLI input, event metadata, and an independently inherited reference
// snapshot. Twenty items leave headroom for both list and show projections;
// the standalone CLI keeps its larger limits.
const readPageLimit = 20;
const listing = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: readPageLimit })),
  before_sequence: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  current_session: Type.Optional(Type.Boolean()),
  reference_kind: Type.Optional(referenceKind),
  reference: Type.Optional(text()),
  include_references: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const searching = Type.Object({
  query: text(320),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: readPageLimit })),
}, { additionalProperties: false });
const showing = Type.Object({
  thread_id: text(36),
  detail: Type.Optional(Type.Boolean({ description: "True reads full events (default 2). False returns only a compact summary. Explicit pagination/reference options imply detail when omitted." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: readPageLimit })),
  before_sequence: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  include_references: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const association = Type.Object({ thread_id: text(36), operation_key: text(200) }, { additionalProperties: false });
const empty = Type.Object({}, { additionalProperties: false });

// Reject unknown top-level fields even when a caller bypasses Pi's schema check.
// This is attribution integrity, not authentication against same-user processes.
function checked(parameters: { properties: object }, args: object) {
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).some(key => !Object.hasOwn(parameters.properties, key))) {
    throw new Error("Threads invalid_input: fields must match the tool schema; runtime origin is not semantic input.");
  }
}
function readArgs(command: string, args: Record<string, unknown>) {
  const argv = [command];
  if (command === "search") argv.push(String(args.query));
  if (command === "show") {
    argv.push(String(args.thread_id));
    // Preserve existing explicit history requests, while plain show is summary-only.
    const requestedHistory = args.limit !== undefined || args.before_sequence !== undefined || args.include_references === true;
    if (args.detail === false && requestedHistory) throw new Error("Threads invalid_input: pagination and references require detail.");
    if (args.detail === true || args.detail === undefined && requestedHistory) {
      if (args.limit === undefined) argv.push("--limit", "2");
    } else argv.push("--compact");
  }
  if (command === "list") {
    if (args.include_references !== true) argv.push("--compact");
    if (args.limit === undefined) argv.push("--limit", "5");
  }
  for (const key of ["limit", "before_sequence", "reference_kind", "reference"]) {
    if (args[key] !== undefined) argv.push(`--${key.replaceAll("_", "-")}`, String(args[key]));
  }
  for (const key of ["current_session", "include_references"]) {
    if (args[key] === true) argv.push(`--${key.replaceAll("_", "-")}`);
  }
  return argv;
}

export default async function threads(pi: ExtensionAPI) {
  // Pi reloads factories, but Node caches native ESM dependencies by URL.
  // Version only the trusted bridge code; runtime identity stays per execution.
  const { runThreads } = await loadBridge();
  pi.registerTool(defineTool({
    name: "threads_list", label: "Threads: list",
    description: "Browse compact thread summaries, default 5 and at most 20, with an 8 KiB reply budget. Prefer threads_current for known continuity or threads_search for a topic. Filter exact references when known; page with before_sequence. include_references explicitly requests full metadata. No automatic merging by directory.",
    parameters: listing,
    async execute(_id, args, signal, _update, ctx) {
      checked(listing, args);
      return runThreads(readArgs("list", args), undefined, ctx, signal);
    },
  }));
  pi.registerTool(defineTool({
    name: "threads_search", label: "Threads: search",
    description: "Find work by title/current summary without paging all threads. Supply 1–16 literal prefix terms (320 characters max), all required; accents/case ignored. Returns up to 5 compact candidates by default, at most 20, within 8 KiB. has_more means refine your query. Does not search event bodies; no match is not proof that related history does not exist. Read a candidate with threads_show before choosing continuity.",
    parameters: searching,
    async execute(_id, args, signal, _update, ctx) {
      checked(searching, args);
      return runThreads(readArgs("search", args), undefined, ctx, signal);
    },
  }));
  pi.registerTool(defineTool({
    name: "threads_show", label: "Threads: context",
    description: "Read one compact current summary by default (8 KiB max; no events). For missing context set detail:true to read 2 full recent events; explicit limit, before_sequence or include_references also requests detail. Full pages accept at most 20 events and use next_before_sequence. Viewing never approves anything.",
    parameters: showing,
    async execute(_id, args, signal, _update, ctx) {
      checked(showing, args);
      return runThreads(readArgs("show", args), undefined, ctx, signal);
    },
  }));
  pi.registerTool(defineTool({
    name: "threads_current", label: "Threads: current session",
    description: "Read this execution's durable session association. An association is context, not proof that unrelated new work belongs to it.",
    parameters: empty,
    async execute(_id, args, signal, _update, ctx) {
      checked(empty, args);
      return runThreads(["current"], undefined, ctx, signal);
    },
  }));
  pi.registerTool(defineTool({
    name: "threads_record", label: "Threads: record milestone",
    description: "Save meaningful progress automatically under the Threads skill. Omit thread_id (or use null) to create atomically with the first record; supply a chosen ID to continue. Runtime supplies origin. Reuse the exact payload and operation_key on retry, including null/omitted thread_id. References replace the active links; [] clears them. Recommendations are not user decisions.",
    parameters: record, executionMode: "sequential",
    async execute(_id, args, signal, _update, ctx) {
      checked(record, args);
      return runThreads(["record"], args, ctx, signal);
    },
  }));
  pi.registerTool(defineTool({
    name: "threads_associate", label: "Threads: choose continuity",
    description: "Explicitly associate this runtime session with a thread after reading its context. Does not merge threads or add a milestone. Retry the exact operation_key/payload; an old receipt does not describe the current binding. Use threads_current to check it.",
    parameters: association, executionMode: "sequential",
    async execute(_id, args, signal, _update, ctx) {
      checked(association, args);
      return runThreads(["associate"], args, ctx, signal);
    },
  }));
}
