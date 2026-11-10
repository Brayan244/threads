# Reporting contract

## Host operations

Pi uses the extension's tools; Codex runs the configured `threads` launcher from its **current shell tool execution**. If no launcher is installed, use `python3` with the known absolute path to the source checkout's `bin/threads`. Resolve the actual installation first; a copied skill directory alone is not an executable installation. Run that CLI's `--help` for the authoritative v1 schema and bounds. Commands return one JSON envelope: `contract_version: 1`, `ok`, and `result` or `error`; only exit 0 with `ok: true` confirms success.

| Intent | Pi | CLI |
| --- | --- | --- |
| Session's current binding | `threads_current {}` | `threads current` |
| Candidate summaries | `threads_list {limit: 20}` | `threads list --limit 20` |
| Exact linked reference | `threads_list {reference_kind: "issue", reference: "ISSUE-123"}` | `threads list --reference-kind issue --reference ISSUE-123` |
| Candidate context | `threads_show {thread_id: ID, limit: 10}` | `threads show ID --limit 10` |
| Choose continuity | `threads_associate {thread_id: ID, operation_key: KEY}` | `threads associate` + JSON stdin |
| Create with first milestone / append | `threads_record` with the semantic object below | `threads record` + JSON stdin |

These are examples of tool arguments, not literal JSON where `ID`/`KEY` appear. CLI read commands take no stdin. For list/show, `before_sequence` in Pi maps to `--before-sequence`; use `next_before_sequence` from the prior page. List filters also support `current_session` and `include_references`; show supports `include_references`. Origins stay internal by default. For an authorized attribution audit, CLI `show`/`events --include-origin` and `sessions ID` expose metadata explicitly. There is no full-text search or merge operation: inspect bounded summaries and exact linked references.

Pi supplies `--pi-session-id` and `--pi-session-ref` from the execution context, not model arguments. Codex supplies neither: invoke the CLI directly in the current shell, with its existing runtime environment. Do not set or synthesize `CODEX_THREAD_ID`, or run writes through a long-lived server that captured startup environment. A missing identity is a blocked capture, not permission to weaken sandbox or approval controls.

## Semantic records

A first record can be this JSON stdin (the installed launcher is assumed in this example):

```sh
threads record <<'JSON'
{"kind":"hypothesis","body":"The failure occurs only after a session switch; the cached binding is a candidate cause, not yet verified.","operation_key":"investigation-first-hypothesis","title":"Investigate session-switch failure","summary":"Reproduced after a session switch; next inspect the binding and add a regression test."}
JSON
```

Reuse that exact object for a retry, including the absence of `thread_id`. Successful creation returns `result.event.thread_id`; subsequent **new** milestones include that ID and a new operation key. Recording also binds the current session atomically. Explicit association binds without a milestone and uses a separate operation-key namespace.

| Kind | Claim to capture |
| --- | --- |
| `observation` | What was directly observed, with scope and source. |
| `hypothesis` | A plausible explanation, marked uncertain and grounded in observations. |
| `decision` | The user's instruction, attribution to the user and its concrete consequence. Agent recommendations remain observations or review findings. |
| `progress` | A meaningful completed change and what remains. |
| `review_finding` | An agent finding, or an explicit human review with the typed review object below. |
| `validation` | The exact check, result and tested scope, with the typed validation object when available. |

Required fields: `kind`, nonblank `body` (up to 16000 characters), stable `operation_key` (up to 200). Optional fields: `thread_id` (null/omitted creates), `title` (240), `summary` (4000), `retained`, `references`, `evidence`, `review`, `validation`. Keep the entire JSON stdin under 65536 bytes. Runtime sets `origin`, sequence and UTC receipt time; omit them from semantic input. This is attribution integrity, not authentication against same-user processes.

Supply `summary` on each substantive record as one short, complete sentence for the mini history (aim for 80–140 characters). Carry the outcome and relevant pending action together, for example: “Regression fixed; user review is still pending.” Keep `body` concise too: a few short sentences for the observation, change and remaining work. Put full paths, hashes and raw test output in the existing typed targets/evidence rather than repeating them in narrative text. The reader exposes original text and exact metadata on demand; historical records remain unchanged. The summary is also the latest recovery context, so preserve any still-relevant unresolved question. Omitted/null title, retention and references preserve their current values. `references` replaces the active issue/PR/session links; `[]` intentionally clears them. Preserve unrelated links when updating. Each entry is `{ "kind": "issue" | "pr" | "session", "reference": "..." }`, at most 32. References are metadata, not proof that two threads are the same work.

## Evidence, reviews and validations

Evidence entries are `{ "kind": "document" | "screenshot" | "report" | "result" | "link" | "other", "reference": "absolute path or http(s)/file URL", "target": {"object_id":"...","version":"...","digest":"..."}, "availability":"unknown" | "available" | "unavailable" }`. `target` is optional; its version/digest are optional. Default availability is unknown; claim available only after checking the exact reference. Missing evidence stays unavailable without invalidating the milestone. URLs must contain no credentials. The store retains references, not external contents or a promise that a session can be reopened.

For a human review, use `kind: "review_finding"` and `review: { "target": {"object_id":"...","version":"...","digest":"..."}, "instruction":"User's actual review instruction", "disposition":"approved" | "changes_requested" }`. Establish that the user actually gave this decision; a request to inspect is not approval. For a check, use `kind: "validation"` and `validation: { "target": {"object_id":"...","version":"...","digest":"..."}, "outcome":"passed" | "failed" }`. Cite the command/result in the body and evidence. An unpinned object or mutable path is not version-specific assurance. Viewing never produces review/validation state; a changed version requires fresh evidence.

## Failed or uncertain capture

A Pi tool failure is an error, not a receipt. CLI failures have `ok: false`, a redacted code/message and a retryable flag. `busy` is retryable: retry the identical payload and key in the **same runtime session** after the lock clears. A process error, cancellation or lost response leaves the outcome unconfirmed; the same retry also safely discovers an already-committed receipt. Keep omitted/null fields unchanged on retries, even if a thread ID became visible elsewhere. Do not generate a new key to work around uncertainty.

`conflict` means the key was used for different input: inspect context before deciding whether there is a genuinely new milestone. For invalid input, identity or storage/permission errors, fix only the authorized prerequisite; report that capture did not confirm. If repair requires host settings or access approval, stop capture and name that gate once. Continue useful underlying work when safe, preserving the unsaved milestone for recovery. A later session cannot masquerade as the failed session; inspect history before recording a new attributed account.

The bridge bounds subprocess time to 15 seconds and redacts subprocess diagnostics. Large model-facing results are explicitly omitted with a receipt/lookup hint; full structured results remain in tool details. Use CLI bounded pages to inspect full values. A successful association retry returns its historical receipt, not necessarily today's binding: use current to verify before continuing.
