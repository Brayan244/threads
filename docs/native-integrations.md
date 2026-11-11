# Native agent integrations

Threads records the **actual session ID supplied by the host on each call**. A new conversation uses its new native ID; the work thread can remain the same after deliberate continuity selection. No launcher-generated session IDs, transcript searches or terminal-ID substitutions are used.

## Verification boundary

| Host | Identity source | Verification in this checkout |
| --- | --- | --- |
| Pi | Current execution's SessionManager ID/file | Installed real loader plus synthetic contexts; existing integration |
| Codex | Current shell's `CODEX_THREAD_ID` | CLI fixtures; existing integration |
| Claude Code | `PreToolUse.session_id`, transcript path, optional native `agent_id` | Protocol fixtures; local 2.1.283 schema accepts `updatedInput` without a permission decision; live smoke pending |
| Gemini CLI | `BeforeTool.session_id` and transcript path | Official hook contract plus protocol fixtures; live smoke pending |
| OpenCode | Tool callback's `context.sessionID` and directory | Fixtures plus six exports imported with real SDK 1.19.5; native discovery/live smoke in OpenCode 2.2.7 pending |
| Cursor | `preToolUse.conversation_id` | Fixtures plus static inspection of official build 2026.11.10-731fb78 confirms `updated_input` and optional permission; live smoke pending |

**Four adapters being present is not four live compatibility certifications.** Cursor requires a host supporting `preToolUse.updated_input` for native shell tools. Older `beforeShellExecution` hooks that cannot rewrite input are not sufficient. Do not advertise this package as verified with every agent or host version.

## Configure only after inspection

Install the runtime into an approved isolated home using [usage](usage.md), then emit a plan:

```sh
node scripts/host-config.mjs --home /absolute/approved/home --host claude-code
node scripts/host-config.mjs --home /absolute/approved/home --host gemini-cli
node scripts/host-config.mjs --home /absolute/approved/home --host opencode
node scripts/host-config.mjs --home /absolute/approved/home --host cursor
```

This command **prints configuration; it writes nothing**. It shows the default settings/discovery path, a merge fragment or OpenCode entry, and the shared skill's source/target. Custom host resource-root overrides need manual placement. Copy the skill together with `references/` after approval. Discovery must be checked in the real host; a file on disk is not proof that the model loaded it.

Append hook entries without replacing other hooks/settings. Keep occupied filenames intact until their owner approves a change. OpenCode's generated entry imports `@opencode-ai/plugin` from the host's own installation and passes its tool builder to the runtime factory; Threads does not install the host or its SDK. No host configuration, sandbox, authentication or permission policy is changed by the installer or emitter.

### Claude, Gemini and Cursor shell calls

Use one **direct** command per shell tool call, including `--require-native-context`:

```sh
threads --require-native-context record <<'JSON'
{"kind":"progress","body":"The observed issue is fixed; verification is pending.","summary":"Issue fixed; verification pending.","operation_key":"fix-observed-issue-v1"}
JSON
```

The hook supplies a command-scoped native envelope before execution. It preserves the original tool arguments except the command prefix, and returns no permission decision. Normal host permission checks still apply. The variable is not exported to the persistent shell or later commands.

Direct `threads` and the exact configured absolute launcher are recognized. Pipelines such as `cat payload.json | threads ...`, aliases, `command threads`, compound wrappers and command substitutions around the executable are not supported. The mandatory flag makes missing context a failed capture instead of falling back to an inherited Codex identity. Do not set the runtime envelope yourself or copy it across calls. Keep native host environments separate; Codex's existing unflagged interface is only for its actual current shell execution.

Search/list/show do not need write identity. `current`, `associate`, `record` and current-session filters require fresh identity. Invalid/missing hook metadata blocks the tool/capture; it never confirms a save. Hooks accept bounded JSON (256 KiB) and do not record their input, tool output or transcripts.

### OpenCode custom tools

The emitted `threads.ts` entry targets OpenCode's legacy custom-tool contract. Its six exports load with SDK 1.19.5, which also exposes a separate V2 plugin API; this does **not** establish discovery compatibility with the OpenCode 2.2.7 client. Treat this adapter as experimental and verify actual tool registration in your host before relying on it.

After installing the entry into an approved compatible discovery directory, restart/reload OpenCode. The intended registered tools are `threads_current`, `threads_search`, `threads_list`, `threads_show`, `threads_record` and `threads_associate`, without replacing built-in tools.

The record tool accepts `payload`, a string containing the same strict semantic JSON as the CLI, never origin. The runtime reads `sessionID` from **that tool callback**, not plugin initialization, a shared daemon or model arguments. Read tools keep the compact defaults. Session IDs such as `ses_...` remain unchanged. No transcript path is invented when the host supplies none.

## Identity and storage details

The neutral bridge uses a versioned, bounded per-call envelope outside semantic JSON. It is attribution integrity, not authentication against another process running as the same OS user. Pi/Codex cannot be impersonated through this envelope; their established adapters remain separate. Invalid envelopes fail closed even when an ancestor's Codex variables exist.

Native opaque IDs are preserved, not converted to UUIDs. Pi/Codex keep their existing UUID validation. A missing native locator is explicitly `session_ref: null` for new providers, not a made-up file or deep link. A native `actor_id`, when actually provided, distinguishes subagent writes under the same conversation. Internal SQLite scope keys can be tuples for these actors; exported event/binding `origin.session_id` always remains the real native ID. Existing keys, canonical exports, schema-v2 history and exact replays remain unchanged. Do not infer isolated child identities if the host does not expose them.

Update the runtime **and its mod reader together before enabling new providers**. An unchanged SQLite schema number is not a promise that an older reader understands opaque IDs, null locators or actor metadata. Older runtimes may reject those new records; do not blindly roll back readers after recording with new providers. Preserve the data and restore a capable runtime instead of rewriting history.

A stored ID/locator is not a guarantee that a host can reopen that conversation. Resuming depends on that host/version and its retained local data. Nothing automatically opens a session, reads a transcript or shares a conversation.

## Required live smoke before release claims

Use separate approved temporary homes/workspaces, no copied credentials/transcripts or changed approval policies. New model sessions/host installations need their own approval.

1. Confirm actual host tool/skill discovery and normal permission checks.
2. Record one meaningful synthetic task milestone; privately compare stored origin with the runtime's actual session ID.
3. Start a new conversation and record into the deliberately chosen same work thread. The native ID must change; prior origin stays unchanged.
4. Check exact retry/conflict behavior and two concurrent sessions/real child actors when exposed. Missing hooks/context must fail rather than reuse a parent ID.
5. Verify compact search/show and inspect history only on demand. Keep live receipts private and separate from protocol fixtures.

## Contract sources

- [Claude Code hook reference](https://code.claude.com/docs/en/hooks). Web extraction was partial; installed Claude Code 2.1.283's hook schema was inspected locally. That is not a live hook receipt.
- [Gemini CLI hook reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md).
- [OpenCode custom tools](https://opencode.ai/v1/docs/custom-tools) and its current official documentation source. API/version and live discovery still need host validation.
- [Cursor hooks](https://cursor.com/docs/hooks). Static inspection of the official 2026.11.10-731fb78 client confirms the input/output fields above; no client or model session was executed for that check. The opt-in adapter remains experimental until verified in the intended host.
