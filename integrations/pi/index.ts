import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runThreads } from "./cli.mjs";

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
const showing = Type.Object({
  thread_id: text(36),
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
  if (command === "show") argv.push(String(args.thread_id));
  // The CLI list default (50) is larger than Pi's capture-safe page budget.
  if (command === "list" && args.limit === undefined) argv.push("--limit", String(readPageLimit));
  for (const key of ["limit", "before_sequence", "reference_kind", "reference"]) {
    if (args[key] !== undefined) argv.push(`--${key.replaceAll("_", "-")}`, String(args[key]));
  }
  for (const key of ["current_session", "include_references"]) {
    if (args[key] === true) argv.push(`--${key.replaceAll("_", "-")}`);
  }
  return argv;
}

export default function threads(pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: "threads_list", label: "Threads: list",
    description: "Read up to 20 thread summaries per page before choosing continuity. Filter by exact issue/PR/session reference or current session; page with before_sequence. No automatic merging by directory.",
    parameters: listing,
    async execute(_id, args, signal, _update, ctx) {
      checked(listing, args);
      return runThreads(readArgs("list", args), undefined, ctx, signal);
    },
  }));
  pi.registerTool(defineTool({
    name: "threads_show", label: "Threads: context",
    description: "Read a thread's current summary and up to 20 recent events per page (newest first). Read candidate context before continuing. Use next_before_sequence to page older records. Viewing never approves anything.",
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
