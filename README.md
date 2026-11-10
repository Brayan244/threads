# Threads

Local work history for Pi and Codex, with a native sidebar and reading view in [Herdr](https://herdr.dev).

A thread follows a piece of work across sessions, issues and pull requests. It stores concise milestones and evidence references—not full conversations. Starting an agent does not create a thread.

## What it does

- Records observations, hypotheses, decisions, progress, review findings and validations with runtime attribution.
- Keeps history in local SQLite outside the code repository.
- Adds a compact tree between Spaces and Agents in Herdr's existing left sidebar.
- Opens detail in a reusable central reading tab, without closing the terminal.
- Refreshes every five seconds, with red unread dots and an explicit `✓` read control. Reading never means approval.

## Components

| Path | Purpose |
| --- | --- |
| `src/threads/`, `bin/threads` | Domain, SQLite storage and JSON CLI |
| `integrations/pi/` | Pi tools with execution-time session identity |
| `skills/threads/` | Shared reporting and continuity guidance |
| `herdr/mods/threads/` | Native tree and reading view |
| `scripts/` | Explicit-root installation and read-only diagnostics |

## Development

Python 3.11+ uses only the standard library. JavaScript tests require Node 24+ and installed Pi/Herdr contracts. They do not install dependencies or launch model sessions.

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.mjs
```

Latest focused verification: **69 Node tests and 31 installer tests passed**, plus isolated native renderer checks. These results do not certify every interactive host behavior. See [compatibility](docs/compatibility.md).

## Install deliberately

Read [usage](docs/usage.md) and [compatibility](docs/compatibility.md) before installing.

The installer requires explicit absolute roots and an initialized Herdr home. It natively clones the selected layout **and switches to the clone**. It does not edit shipped originals, copy credentials, change approval policies or start agents. Start with an approved isolated environment.

```sh
python3 scripts/doctor.py \
  --home /absolute/approved/home \
  --herdr-home /absolute/approved/herdr-home
```

`bin/threads --help` describes the checkout-local CLI. Installed launchers pin one history directory across integrations. Removal preserves history, evidence and edited resources.

## Status

Experimental local MVP. The code and targeted checks are available; broader live-host, accessibility and visual acceptance remain incomplete. Runtime history, transcripts, screenshots and private verification receipts are not included in this repository.
