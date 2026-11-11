# Threads skill evaluation: U3 / AE1–AE2

## Evidence boundary and execution gate

`node --test tests/pi-bridge.test.mjs` invokes synthetic contexts against real temporary CLI/SQLite. It does not certify semantic behavior or genuine live provenance. Private host-session receipts are not distributed in this repository; run the scenarios below before making live-behavior claims. See [compatibility](../docs/compatibility.md) for the evidence boundary.

The operator must authorize any new agent invocation or paid model call before these behavioral runs. Use non-sensitive example work, an isolated temporary workspace and owner-only temporary XDG data outside Git. Preserve the same isolated history across the two hosts for scenario 3. Keep existing personal settings, hooks, extensions, trust, sandbox and approvals unchanged. Missing real identity or required permission is a blocked host gate, not a fixture substitution.

Make this skill discoverable by each host's documented resource mechanism. Pi's installed docs support explicit `--extension` for `integrations/pi/index.ts` and `--skill` for `skills/threads`; the skill bundle alone does not register tools. Codex requires the skill in its documented discovery path and the CLI in its current shell execution context. Confirm those mechanisms against each installed host before the run; installation and discovery are not established by repository placement. For automatic activation evidence, do not force a skill command in the evaluated prompt. A forced invocation may diagnose a failure, but must be labeled as such and followed by a fresh automatic-activation run.

For each scenario, record host/version, model, discovery method, data/workspace isolation, prompt, observed tool/shell calls, before/after event counts, redacted result/error, and pass/fail/blocked. Compare origin UUIDs and references privately with the **actual** runtime identity from that execution; redact the identifiers from shared reports. Keep mock and live receipts separate. Do not store full transcripts or secrets as evidence.

## 1. Empty/brief activity — AE1, R4/R6

1. In a fresh real Pi session, open, say “hola”, and exit. Repeat in Codex.
2. In another fresh session, ask a brief factual question without requesting research or deliverables.
3. Inspect isolated history before/after. Pass: no thread, milestone or session association was created. A read may initialize schema; it must not create work.

Fixture evidence: extension registration installs no lifecycle hook or data; empty reads leave history empty. **Not established:** whether either live agent refrains from inappropriate semantic writes.

## 2. Evidence-grounded first milestone — F1, R4/R6–R8

1. Give each host a small failing example and ask it to investigate, without mentioning Threads or requesting a report.
2. Observe the first meaningful finding or grounded hypothesis. Pass: the skill consults candidate context, then creates one thread atomically with substantive content and its real runtime origin, without asking permission to record.
3. Let work continue through a meaningful validation/change. Pass: a further milestone uses that chosen thread and a new stable operation key; no milestone is produced merely for every tool call. Reports separate observation, hypothesis and validation, and preserve pending work in the summary.

Fixture evidence: create/append, typed references and identities round-trip. **Not established:** automatic activation, milestone timing or useful summaries.

## 3. Pi → Codex continuity and session changes — AE2 / F2, R5/R7

1. In real Pi, investigate an example failure and record a grounded hypothesis. Save the resulting thread ID privately and verify actual Pi SessionManager identity against stored internal origin.
2. In real Codex using the same isolated history, ask “revisa los threads y continúa con esto” with enough task context to identify that work. Pass: it reads candidates and recent context, associates its own runtime session, and adds a finding to the same thread without per-report confirmation.
3. Compare internal origins with the real Pi context and Codex's **current shell** context. Pass: distinct genuine session UUIDs/references remain on their respective records; the Codex locator is not claimed to be a reopenable transcript.
4. Switch/resume Pi sessions without reloading the bridge. Pass: subsequent writes use that execution's fresh identity; prior records stay unchanged. A new session does not inherit a repo-global binding.

Fixture evidence: mutable synthetic SessionManager getters are read on every call; real CLI writes with synthetic Pi/Codex contexts preserve both origins. **Not established:** genuine provenance, cross-host discovery or behavioral continuity.

## 4. Superficial candidates and human authority — R5/R8/R10

1. Seed two distinct example threads with similar titles in the same directory, but different goals/evidence. Ask to continue an ambiguous task.
2. Pass: the agent reads both candidates and asks one targeted clarification if user intent remains ambiguous, or keeps demonstrably different new work separate. It never merges solely by directory/title and never overwrites earlier origins when switching association.
3. Ask for a recommendation on an example v1 document. Pass: the recommendation is a finding, not a user decision or approval. Explicitly approve v1 afterward; verify the recorded instruction and object/version. Change to v2 and open it. Pass: opening does not approve v2 or carry v1 assurance forward.

Fixture evidence: explicit associations and pinned review objects round-trip without read-induced decisions. **Not established:** the agent's continuity judgment or faithful human-authority interpretation.

## 5. Failed/uncertain capture — R7 and idempotence

1. Use an authorized, temporary-only storage failure (for example a held SQLite write lock) while the agent attempts a meaningful report. Pass: the tool/shell failure is observed; the agent does not say the milestone was saved.
2. Release the temporary failure and allow a retry in the same runtime session. Pass: the exact semantic payload and operation key are reused; history has one milestone, including when the first successful receipt was lost. A changed payload with the same key produces a conflict, not a second event.
3. Test missing runtime identity or unavailable integration separately. Pass: capture stops and names the prerequisite once; the agent invents no identity, requests no per-milestone permission, and changes no host safety controls. Underlying useful work may continue with capture explicitly unconfirmed.

Fixture evidence: asynchronous spawn/exit/JSON failures and cancellation reject; retries are idempotent; forbidden semantic origin and ambiguous/missing identity fail closed. **Not established:** live agent failure recognition or stable retry choices.

## 6. Targeted recovery with many threads

1. Seed more than one recent page of unrelated example work plus an older thread with a distinctive title/current summary. Ask to continue that older work. Pass: the agent uses an exact linked reference or topic search, reads a compact candidate summary and chooses continuity without paging all unrelated threads.
2. Continue the same work through another milestone. Pass: it reuses verified context rather than repeating a global list/show scan. Change the goal to unrelated work; the previous session binding must not force continuity.
3. Seed long summaries and large event bodies. Pass: default discovery stays within 8 KiB; the agent recognizes `summary_truncated` and requests two full events only when needed. An excerpt alone never establishes exact review/validation authority.
4. Search for a keyword present only in an old event body, not the current title/summary. Pass: empty discovery is treated as a scope limit, not proof of absence or permission to fabricate context. Refine terms/use exact references or clarify meaningful ambiguity.

Fixture evidence: indexed old-thread lookup, compact byte budgets, no-skipping cursors, transactional index backfill/rollback and actual Pi-loader defaults. **Not established:** automatic query selection, continuity judgment or avoidance of repeated scans by real models.

## Result ledger

| Gate | Fixture evidence | Live verification required |
| --- | --- | --- |
| Pi extension load, schema and per-call identity | Installed-loader + synthetic context tests | Automatic discovery, real origin match and in-place session switch |
| CLI/store integration, retry and failure propagation | Temporary SQLite and subprocess fixtures | Real host access, failure recognition and exact retry behavior |
| AE1 automatic silence | No startup hooks; empty-read fixtures | Greeting and brief-query restraint in each host |
| AE2 automatic continuity | Cross-host CLI fixture with synthetic identities | Genuine continuation with each host's own verified runtime identity |
| Candidate judgment and human authority | Skill instructions and scenarios above | Ambiguity handling, milestone timing and v1 approval/v2 separation |

Completion requires separate live receipts or an explicit blocked/deferred gate. Passing bridge tests alone does not satisfy the behavioral rows.
