# Threads

Local work history for coding agents, with a native sidebar and reading view in [Herdr](https://herdr.dev).

A thread follows a piece of work across sessions, issues and pull requests. It stores concise milestones and evidence references—not full conversations. Starting an agent does not create a thread.

**Public alpha:** [v0.1.0-alpha.1](https://github.com/Brayan244/threads/releases/tag/v0.1.0-alpha.1). Download the allowlisted package and `SHA256SUMS` from that release. Start in an isolated environment; this is not a stable release or a verified Herdr Gallery entry.

## What it does

- Records observations, hypotheses, decisions, progress, review findings and validations with runtime attribution.
- Keeps history in local SQLite outside the code repository.
- Finds work by indexed title/current-summary search, with compact discovery and full history on demand.
- Adds a compact tree between Spaces and Agents in Herdr's existing left sidebar.
- Opens detail in a reusable central reading tab, without closing the terminal.
- Refreshes every five seconds, with red unread dots and an explicit `✓` read control. Reading never means approval.

## Components

| Path | Purpose |
| --- | --- |
| `src/threads/`, `bin/threads` | Domain, SQLite storage and JSON CLI |
| `integrations/` | Pi tools, shared CLI transport and opt-in native agent adapters |
| `skills/threads/` | Shared reporting and continuity guidance |
| `mods/threads/` | Native tree and reading view |
| `scripts/` | Explicit-root installation and read-only diagnostics |

## Requirements

**Herdr + Node.js 24.15.0 or newer.** No Python, npm packages, database server or native addon build is required. SQLite comes with Node. The supported filesystem model is macOS/Linux with owner-only POSIX permissions.

Agent integrations are optional. Pi/Codex retain their established paths; opt-in Claude Code, Gemini CLI, OpenCode and Cursor adapters are implemented with protocol fixtures, **not live compatibility certification**. See [native integrations](docs/native-integrations.md) before configuring them. Herdr mods use Herdr's native GPUI JavaScript runtime—not Node; the CLI, persistence, installer and diagnostics run in Node.

## Development

Core, CLI, migration and installation checks need only Node:

```sh
node --test tests/core.test.mjs tests/cli.test.mjs tests/migration.test.mjs tests/retrieval.test.mjs tests/install.test.mjs
```

The full suite additionally uses installed Pi and Herdr contracts, without downloading dependencies or launching model sessions:

```sh
node --test tests/*.test.mjs
```

Checks cover legacy SQLite compatibility, idempotency, multiprocess writes, installation fault recovery and native UI behavior. Fixtures do not certify every interactive host behavior. See [compatibility](docs/compatibility.md).

## Install deliberately

Read [usage](docs/usage.md) and [compatibility](docs/compatibility.md) before installing.

The installer requires explicit absolute roots and an initialized Herdr home. It natively clones the selected layout **and switches to the clone**. It does not edit shipped originals, copy credentials, change approval policies or start agents. Start with an approved isolated environment.

```sh
node scripts/doctor.mjs \
  --home /absolute/approved/home \
  --herdr-home /absolute/approved/herdr-home
```

`node bin/threads --help` describes the checkout-local CLI. Installed launchers pin one history directory across integrations. Removal preserves history, evidence and edited resources. Existing Python installations require the inspected [migration procedure](docs/usage.md#replace-a-python-installation); they are not silently overwritten.

## Distribution

Original code is [MIT](LICENSE). [RECIPE.md](RECIPE.md) describes process/file access, installation limits and the pending Gallery preparation. Build a local allowlisted package with `node scripts/package.mjs --output /absolute/approved/build/threads`; read [distribution](docs/distribution.md) first. The builder does not publish or edit agent settings.

The illustrated preview uses synthetic data, **not a native screenshot**. A reviewed native PNG and real-host validation remain Gallery-readiness gates, not claims made by this GitHub alpha.

## Status

Experimental public alpha. The code and targeted checks are available; broader live-host, accessibility and visual acceptance remain incomplete. Runtime history, transcripts, screenshots and private verification receipts are not included in this repository.
