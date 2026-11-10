# Using Threads

## Install only into an approved explicit root

Do not use your personal HOME as a fixture. The live host procedure in [compatibility.md](compatibility.md) requires operator approval first. Tests initialize their own simulated Herdr home; the installer itself does not launch Herdr, install dependencies or create work history.

With an approved, already-running Herdr instance whose initialized home is `HERDR_ROOT`:

```sh
# Set these to the approved absolute paths. Do not infer a personal root.
THREADS_HOME=/absolute/approved/home
HERDR_ROOT=/absolute/approved/herdr-home
HERDR_COMMAND=/absolute/resolved/path/to/herdr-app
python3 scripts/install.py install \
  --home "$THREADS_HOME" --herdr-home "$HERDR_ROOT" \
  --herdr-command "$HERDR_COMMAND" --layout main
python3 scripts/doctor.py --home "$THREADS_HOME" --herdr-home "$HERDR_ROOT"
```

`--herdr-command` must name a regular executable, not a symlink; resolve the installed launcher with `realpath "$(command -v herdr-app)"`. The chosen source must be a nonempty row-root layout with unique IDs and an existing left `sidebar` column containing adjacent `spaces` then `agents` sections, such as the observed shipped `main`. The sections may be nested in its `sidebar-lists` column. Unsupported structures fail before cloning or switching; the installer never falls back to adding another sidebar. Collisions, symlinks inside either root, inaccessible parents or invalid manifests stop installation rather than rewrite configuration. Custom Pi resource-root overrides are not configured by this installer; use the documented default discovery directories or explicitly load the installed extension/skill in an approved session.

The native operation is exactly `herdr-app do layout.clone '{"name":"main","as":"threads-main"}'`, routed with explicit `HOME` and `HERDR_APP_HOME`. It copies native layout click state and **switches the window to the clone**. Only that confirmed clone receives a `threads-sidebar` section **inside the existing left sidebar, below Spaces and above Agents**. The three sections share its available height; Threads has its own scroll area. The sidebar keeps its original width. No extra column, right-panel selector or permanent reader block is installed, and Files/Changes, the workspace and unrelated mod references remain unchanged. Detail opens a native mod tab only when the user requests it. The original source layout, settings and keys are untouched. Threads ships with `place: none` so publishing its mod cannot auto-dock it into an original layout. Unchanged reinstall does not clone, switch or duplicate anything. This is not a silent upgrade mechanism: edited or different installations require inspection/removal before a fresh installation.

## What installation owns

| Resource | Location under the explicit root |
| --- | --- |
| CLI and source-relative Pi runtime | `HOME/.local/share/threads-runtime/` |
| Pinned CLI launcher | `HOME/.local/bin/threads` |
| Shared skill and reporting reference | `HOME/.agents/skills/threads/` |
| Pi extension discovery entry | `HOME/.pi/agent/extensions/threads.ts` |
| Mod and native-created layout clone | `HERDR_ROOT/mods/threads/`, `HERDR_ROOT/layouts/threads-main.json` |

Ownership and file hash/mode records live at `HOME/.local/state/threads-install/manifest.json`. The five authored mod files are copied; generated `.d.ts`/`jsconfig.json` are not. The installer never copies symlink targets, edits host settings, adds hooks or changes trust/approval policies. Herdr executes only bounded read commands through the configured launcher; explicit evidence opening uses Dia for http(s) URLs and Finder reveal for local files. Missing Dia is an error, not permission to pick another application.

History is pinned to `HOME/.local/share/threads/` for **all three consumers**, regardless of ambient `XDG_DATA_HOME`. It is created owner-only by the first CLI read/write, not by installation. The installed runtime has its own Python modules and bridge; it does not depend on the checkout staying in place for everyday use. Keep this checkout for installer/removal operations. The installer uses the Python interpreter that ran it; that interpreter and `python3` for Pi's bridge must remain available and be 3.11+.

## Start and continue meaningful work

1. Put `"$THREADS_HOME/.local/bin"` first on the **approved session's** PATH; do not edit a shell profile. Start Pi/Codex using the same approved HOME. Pi discovers the entry under `.pi/agent/extensions`; both hosts have the shared `.agents/skills/threads` skill. Confirm actual discovery using the host diagnostics; file placement alone is not behavioral evidence.
2. Work normally. A greeting, brief answer or mechanical tool call is not a milestone. For a substantive finding, the skill first consults current association, bounded summaries and plausible candidate context. It creates a new thread only together with its first meaningful record, with no per-milestone confirmation prompt.
3. To resume, ask “revisa los threads y continúa con esto” with the work's goal/evidence. The agent chooses continuity deliberately and associates its own current session. A shared directory or title alone is not enough. Ambiguous intent needs one clarification; there is no repo-global active thread.
4. To retain a temporary thread explicitly, ask the agent to retain that work. Its next substantive `record` can include `"retained": true` and the selected `thread_id`. Retention never enables automatic deletion; removal of the integration never deletes temporary or retained history.

Pi writes only through its runtime tools, which take fresh SessionManager identity. Codex invokes `threads` from its **current shell execution**, using the real `CODEX_THREAD_ID`; never set that variable yourself or copy another session's identity. Missing or ambiguous provenance blocks capture. For an approved Codex session, allow the pinned history directory through the normal supported directory-access/approval mechanism when required. Do not disable sandboxing, approvals or hook trust. Report a blocked prerequisite once; do not claim a failed write was saved.

## Inspect history without an agent

```sh
"$THREADS_HOME/.local/bin/threads" list --limit 20
"$THREADS_HOME/.local/bin/threads" show THREAD_ID --limit 10
"$THREADS_HOME/.local/bin/threads" events THREAD_ID --include-references --limit 20
```

Pi's `threads_list` and `threads_show` tools accept **1–20 items per page**, including when `include_references` is true. Omitting the limit reads 20 summaries or 10 events. Follow `next_before_sequence` to continue; larger tool limits fail schema validation. This Pi-only budget keeps accepted Unicode/escape-heavy CLI records, metadata and inherited reference snapshots below the bridge's unchanged 16 MiB subprocess ceiling. The standalone CLI still permits list pages of 100 and show/events pages of 200. Large Pi results remain available in structured tool details even when their model-facing text is omitted. Isolated loader/CLI fixtures verify this budget, not real-host compatibility.

Use the returned `next_before_sequence` for older list/show pages; events use `next_after_sequence`. `--include-origin` on events/show is an explicit private attribution audit. References are hidden by default; evidence remains with its event. `sessions THREAD_ID` exposes attributed session locators, not a promise that a host can reopen a transcript. The CLI has no unbounded export command; the Python library's explicit `Store.export_json()` is available for an authorized full export.

In Herdr's embedded `section` role, Threads uses **compact 30px rows** aligned with Spaces and Agents, not summary cards. A **▸ / ▾ chevron** (accessible label and tooltip: Historial) expands each mini timeline; a separate **› control** (Ver detalle) opens the selected history **in a native Threads reading tab in the central workspace**. The left tree remains visible and retains its expanded histories. Titles and row bodies do not navigate. The quiet number beside a title counts **recorded advances**, not unread or approved work. A reserved dot shows the latest known advance in soft theme red while unread. **✓** marks that thread through its latest known sequence, including older pages; later advances remain unread. The same control is available in the reading header. Opening content and hovering do not mark it read, and reading is never review or approval.

Expanded histories show one-line advance captions and one muted metadata line with date, kind and attachment count. They do not repeat a separate work summary or list filenames. Native ellipsis limits visual width only: the caption/title tooltip preserves its source text and detail retains the original content. Histories use the section's outer scrollbar rather than a fixed-height scroll box per thread. Detail reuses one registered reading tab per Space and history source, so selecting other threads does not multiply tabs. The original workspace tab stays open. **‹ Volver al workspace** selects the originating tab without closing the reader or any terminal; if that tab disappeared, it selects a surviving terminal tab in the same Space, or reports that no return target exists. An invalid/stale reader registration is not reused when it points at a terminal-only tab.

The wide `page` role centers a column capped at 720 logical pixels, with a single outer scrollbar, original body paragraphs at 25px line height, one work title and subdued type/time metadata. Evidence uses quiet filename controls next to its advance; complete record data and review/validation targets require explicit disclosure. Work summaries are not repeated above the original bodies. Reading is not approval. In the collapsed sidebar rail, **T** expands the existing sidebar; it never opens another panel. Navigation only creates/selects the reading tab or selects the previous tab: it never closes, hides or recreates a terminal.

Existing `combined`, `sidebar` and `reader` roles remain supported for legacy layouts. Only those legacy separate-reader layouts expose **× Cerrar lector** and **Ampliar lectura**; fresh installations use the embedded section instead.

Each mini point uses one complete short sentence from the existing event summary, or a suitable short source sentence. Older records without one receive a truthful kind label, not a generated summary or an arbitrary truncated paragraph. New reporting guidance asks for a concise one-sentence `summary`; the domain/API limits and stored history do not change. The wide reader shows original body paragraphs by default; the recorded summary and raw metadata remain under **Datos del registro**. Legacy readers retain their concise/default disclosure behavior. In detail, evidence stays next to its event using a friendly filename; its complete address remains available explicitly. References and session locators also require disclosure.

Each copy has one **5-second polling timer**, with no overlapping poll. It refreshes thread summaries, then reloads an expanded/selected latest page only when that thread changed (or its page read needs a retry). Unchanged results preserve list/page object identity and do not request a repaint or repeat local-state writes. A background refresh of an empty list does not toggle a loading placeholder. Inactive reading tabs and hidden legacy readers skip polling.

The latest page updates automatically in **newest-first order**, as chosen by the operator. Existing element/scroll IDs stay stable, but inserting a new item above the current text can still move it; no pixel-perfect scroll guarantee is claimed. Historical pages retain their cursor/content and provide the existing **Más recientes** navigation. Errors preserve the last good content. There is no **Novedades / Ver recientes** banner.

Unread advance dots use the theme's red; explicit **✓** stores a monotonic UI read-through sequence, shared across copies of the same history source and persisted with their view state. It covers the latest snapshot known at the click, not records arriving afterward. Older sparse markers remain readable for compatibility, but current row-hover handlers no longer create them. Polling, selection, opening and closing never mark data read or approved. A v1 review stays a v1 review, never approval of changed v2 content. Existing combined layouts remain readable; changed installations require the normal inspected removal/reinstall, not silent migration.

## Failed capture or installation

A CLI operation succeeds only with exit 0 and `ok: true`. Retry an uncertain/busy write in the same runtime session with its **identical** payload and stable operation key; do not add a newly returned thread ID to an original create retry. A changed payload with the same key conflicts. Preserve an unsaved milestone when host access is blocked.

Installer errors return exit 1/`ok: false`. Inspect the journal before retrying. Resource creation is exclusive, but native cloning/switching cannot be made atomic with filesystem writes:

- `recovery_required` with `unconfirmed_clone`: the native receipt was lost/failed or the clone contract was unexpected. That clone is **not** claimed or automatically removed. Inspect it and the actual window manually. Do not delete the journal to force a retry.
- `rolled_back`: confirmed unchanged resources were removed after a later failure. Native selection/click-state effects can remain. Run removal to retire the journal after inspecting/switching away normally.
- Edited or unexpected files survive removal. The journal remains for unresolved owned edits; user-added files/directories are never recursively cleaned. A partial file or staging file after an interrupted write may also require manual inspection. No automatic repair changes permissions.

## Remove the integration, not the data

First use the approved Herdr window's normal layout selector to switch away from `threads-main`. Removal intentionally does **not** switch the current window or edit native `.state` files.

```sh
python3 scripts/install.py remove \
  --home "$THREADS_HOME" --herdr-home "$HERDR_ROOT" --layout main
```

Only recorded, unchanged regular files are removed; only recorded empty directories are pruned. Changed files, unknown additions, native click state, all SQLite history and user evidence survive. Repeated removal is safe. A later fresh install still fails on preserved name collisions: inspect them instead of overwriting them. Host-generated files in a previously installed mod directory may also require an explicit operator decision before reinstallation; they are not silently deleted. No trust or approval rollback is attempted because installation never changed those controls.
