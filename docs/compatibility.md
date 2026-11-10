# Compatibility and verification

Threads is an experimental local MVP. A passing fixture, static check or doctor result is not a substitute for live interaction.

## Runtime requirements

| Component | Requirement / observed version |
| --- | --- |
| Python | Core minimum 3.11; recent checks used 3.14.7 and SQLite 3.53.4 |
| Node | Node 24+ for the JavaScript test setup; recent checks used 24.15.0 |
| Pi | Installed extension loader and SessionManager contracts; recently checked with 0.87.1 |
| Codex | Current-shell runtime identity for CLI writes; recent host inspection used 0.166.0 |
| Herdr | Native GPUI mod contracts; recent renderer checks used app 0.1.14 |

These are observations, not a support matrix or a compatibility guarantee for every host configuration. No standalone lint or typecheck command is configured.

## Current behavior

- The compact tree lives between Spaces and Agents in the existing left sidebar, with its own scroll region.
- Detail opens in one reusable native reading tab per Space and history source. Return selects the original workspace tab, or another surviving terminal tab; it does not close terminals.
- Reading uses a column capped at 720 logical pixels, original paragraphs, quiet metadata and evidence controls. Full record data and exact review targets require disclosure.
- One non-overlapping poll runs every five seconds. Unchanged results preserve object identity and avoid explicit redraws or repeated state writes. Historical pages and last-good data survive updates and failures.
- Red dots indicate unread updates. Explicit `✓` marks a thread through its latest known snapshot, not future arrivals. Hovering, opening and polling do not mark it read. Reading is not review or approval.

Latest-page updates are newest-first. Stable element IDs reduce avoidable movement, but inserting a new row above existing text can still move the reading position. There is no zero-jitter guarantee.

## Available verification

The latest focused run passed **69 Node tests and 31 installer tests**, plus four isolated native renderer checks. Coverage includes:

1. CLI/storage boundaries, Pi loader/schema behavior and runtime-identity failure handling.
2. Installer ownership, collisions, reinstall/removal and preservation of unrelated configuration/history.
3. Reader navigation, stale tab registration, return behavior and inactive-tab polling suppression.
4. Explicit read-marker validation and monotonic sharing, future arrivals, no-op polling and last-good data.
5. Native initial descriptions for unread/read tree and reading states.

Python domain/CLI tests are also included. Run the commands in the README for the available suite; no historical transcripts or private verification artifacts are distributed here.

`herdr-app check <mod-folder>` validates initial native descriptions, not actual geometry, deferred interaction, scrolling, focus or hit testing. Installation tests use temporary HOME directories and a simulated native clone command; they do not install into personal configuration.

## Approval and live verification

Before a live test, explicitly approve the environment and any model sessions. Use a separate temporary HOME, example workspace and Herdr home outside Git. Do not copy credentials, personal settings or transcript archives. Use normal host authentication, trust and directory-access approvals; missing access is a blocked gate, not permission to weaken safeguards.

After starting the approved Herdr instance:

1. Verify its selected home/socket through the host's documented diagnostics, then install with explicit roots as described in [usage](usage.md). Native cloning changes that instance's shown layout.
2. Confirm automatic skill/tool discovery in real Pi and Codex sessions. Explicit resource loading is diagnostic evidence, not automatic discovery.
3. Confirm greeting/brief-query restraint and genuine cross-session continuation. Privately compare each stored origin with its actual runtime; never invent session IDs.
4. Exercise the tree, reading-tab reuse/return, five-second updates, explicit read controls, historical pagination, narrow/wide geometry, keyboard/focus and safe evidence opening.
5. Switch away normally before testing removal. Check that unrelated configuration, edited resources, history and evidence survive. Inspect any ownership collision before retrying.

The [skill scenarios](../tests/skill-scenarios.md) provide the behavioral protocol. Further host combinations, sandbox boundaries, accessibility and full visual acceptance remain pending.

## Read-only doctor

```sh
python3 scripts/doctor.py \
  --home /absolute/approved/home \
  --herdr-home /absolute/approved/herdr-home \
  --layout main
```

Doctor checks the ownership manifest, recorded file hashes/modes, storage permissions, executable presence and bounded version probes. It does not open or migrate the database, invoke agents, run a native clone, repair permissions or certify sandbox access.

A zero exit means those static checks passed. Inspect recovery state before retrying any failed installation; do not erase a journal or overwrite edited resources to force success.
