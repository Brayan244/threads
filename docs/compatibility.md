# Compatibility and verification

Threads v0.1.0-alpha.1 is an experimental public alpha. A passing fixture, static check or doctor result is not a substitute for live interaction.

## Runtime requirements

| Component | Requirement / observed version |
| --- | --- |
| Node | 24.15.0+ with built-in `node:sqlite`; the Node port was checked with 24.15.0 / SQLite 3.51.3 |
| Herdr | Required native GPUI mod host; renderer contracts checked with app 0.1.14 |
| Pi (optional) | Installed extension loader and SessionManager contracts; checked with 0.87.1 |
| Codex (optional) | Current-shell runtime identity for CLI writes; prior host inspection used 0.166.0 |

Four additional native adapters (Claude Code, Gemini CLI, OpenCode and Cursor) have protocol/CLI fixtures, not live compatibility certification. Cursor's current rewrite fields have static source confirmation, not a live native-shell receipt; OpenCode V2 discovery is unverified. See [native integrations](native-integrations.md). The installer does not activate those hosts or change their settings. Only Herdr and Node are installation/runtime prerequisites. There are no npm dependencies, Python helpers or native addon builds. macOS/Linux owner-only POSIX storage is supported; Windows permissions and launcher behavior have not been ported. Herdr's mod runtime remains native GPUI JavaScript, not Node.

These are observations, not a support matrix or a compatibility guarantee for every host configuration. No standalone lint or typecheck command is configured.

## Current behavior

- The compact tree lives between Spaces and Agents in the existing left sidebar, with its own scroll region.
- Detail opens in one reusable native reading tab per Space and history source. Return selects the original workspace tab, or another surviving terminal tab; it does not close terminals.
- Reading uses a column capped at 720 logical pixels, original paragraphs, quiet metadata and evidence controls. Full record data and exact review targets require disclosure.
- One non-overlapping poll runs every five seconds. Open visible mini histories hold sidebar order and content while incoming work is signaled beside Update. Closing the last visible history or explicitly updating applies held work; historical page cursors and unread pending advances remain intact. The central reader keeps automatic updates. Unchanged polls avoid explicit redraws and repeated state writes.
- Red dots indicate unread updates. Explicit `✓` marks a thread through its latest known snapshot, not future arrivals. Hovering, opening and polling do not mark it read. Reading is not review or approval.

Threads are ordered by latest recorded activity, including updates to older threads. The embedded sidebar retargets native position springs with stable row IDs and measured expanded heights; legacy card lists retain their rendering. Latest-page events are also newest-first. Stable element IDs reduce avoidable movement, but inserting or moving a row above existing text can still move the reading position. There is no zero-jitter guarantee. Builder fixtures cover ordering, geometry targets, paused reading, explicit application, read boundaries and refresh/navigation races. Real CLI fixtures cover held arrivals and pagination. Seeded native checks exercise motion and pending/error header descriptions, not visual smoothness or pixel-perfect scroll anchoring.

## Available verification

Run the Node suites described in the README. Coverage includes:

1. CLI/storage boundaries, legacy Python-created SQLite replay, schema v1 upgrade, full-width cursors, multiprocess initialization/writes, opaque native IDs, actor-scoped idempotency and fresh runtime identity.
2. Installer ownership, collisions, reinstall/removal and preservation of unrelated configuration/history.
3. Reader navigation, stale tab registration, return behavior and inactive-tab polling suppression.
4. Explicit read-marker validation and monotonic sharing, future arrivals, no-op polling and last-good data.
5. Native initial descriptions for unread/read tree and reading states.

The synthetic schema-v2 SQL/JSON fixture was produced by the previous Python store; current tests load it using Node only. It contains no real session data. Installed-runtime journeys restrict PATH to Node and a simulated Herdr executable, proving that launchers, Pi's installed bridge and diagnostics do not need Python. No historical transcripts or private verification artifacts are distributed here.

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
node scripts/doctor.mjs \
  --home /absolute/approved/home \
  --herdr-home /absolute/approved/herdr-home \
  --layout main
```

Doctor checks the ownership manifest, recorded file hashes/modes, storage permissions, executable presence and bounded version probes. Node and Herdr are required; absent Pi/Codex executables do not fail installation diagnostics. Legacy Python manifests are inspectable without Python, but are not reported as an intact Node installation. It does not open or migrate the database, invoke agents, run a native clone, repair permissions or certify sandbox access.

A zero exit means those static checks passed. Inspect recovery state before retrying any failed installation; do not erase a journal or overwrite edited resources to force success.
