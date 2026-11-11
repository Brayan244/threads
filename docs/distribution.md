# Alpha distribution

The [GitHub alpha v0.1.0-alpha.1](https://github.com/Brayan244/threads/releases/tag/v0.1.0-alpha.1) includes MIT licensing, a Gallery preparation recipe, the mod in `mods/threads/`, the Node runtime, optional experimental native adapters and an inspectable configuration emitter. It is a prerelease, not a verified Gallery entry. Download `threads-v0.1.0-alpha.1.tar.gz` and `SHA256SUMS` from the release.

Verify the downloaded archive before extracting it:

```sh
shasum -a 256 -c SHA256SUMS
tar -xzf threads-v0.1.0-alpha.1.tar.gz
node threads/scripts/package.mjs --verify /absolute/path/to/extracted/threads
```

The checksum detects mismatched bytes; it is not a publisher signature. Inspect the installation instructions before running the installer.

## Build outside Git

Choose a new output directory under an existing approved build parent:

```sh
node scripts/package.mjs --output /absolute/approved/build/threads
node scripts/package.mjs --verify /absolute/approved/build/threads
```

The builder copies a fixed public allowlist and records the package version and SHA-256/mode proofs in `package-manifest.json`. Its `publication: build_only` describes the builder's scope, not whether a later operator uploaded the artifact. It refuses an occupied output directory, symlink sources and outputs inside Git. No recursive checkout copy, dependency download, host installation, agent invocation, commit, push or topic change occurs. A failed partial build is left for inspection rather than recursively deleted.

The allowlist excludes `.git`, research drafts, SQLite history, transcripts, personal configuration and private verification receipts. The included SQL/JSON test fixtures are synthetic. Output permissions are private by default (directories 0700, data/source 0600, executables 0700). Verification checks hashes/modes, not publisher authenticity; the manifest is not a signed release.

The folder is self-contained for the documented installation and tests. It is not an npm publication. Archive creation and public upload are separate operator actions; running the builder never authorizes either. The alpha keeps the four new adapters experimental rather than claiming completed live-host verification.

## Install deliberately

Read [RECIPE](../RECIPE.md), [usage](usage.md) and [native integrations](native-integrations.md). The default installer clones/switches a supported layout; it is not a drop-in installer for arbitrary layouts. Do not use removal/reinstallation as a workaround for an edited personal layout. Preserve collisions, custom mods, settings and ownership warnings.

`host-config.mjs` emits native configuration/entry plans only. Review and merge them with consent; it does not install missing hosts or edit settings. Copy the shared skill with its references and check actual discovery. Pi/Codex retain their established identity paths; four additional adapters remain explicitly unverified in live hosts until the documented smoke runs pass.

## Preview and publication gates

`preview.svg` is an **illustration with synthetic data**, not a screenshot or proof of native rendering. The builder reports this limitation in the manifest. If an approved `preview.png` is later supplied, it is copied explicitly but still marked unverified; file presence does not prove privacy or live-render acceptance.

Before calling the entry Gallery-ready:

1. Verify the intended real host versions and native IDs/session switching without weakening permissions. Keep receipts private.
2. Produce a native screenshot in an isolated synthetic-data demo. Do not capture personal history, sessions, terminals or credentials. An agent outside Herdr must not inspect/control the personal window to obtain it.
3. Review every public file and the preview. Confirm recipe/install behavior and test the intended custom-layout composition; do not promise universal layout compatibility.
4. Explicitly authorize the revision/merge, commit/push and GitHub `herdr-mod` topic. None is authorized by the local build.
5. Confirm actual Gallery indexing. A topic being present or a manual's expected discovery window is not proof of a live entry.

MIT covers original Threads code; unbundled host SDK/runtime libraries keep their own licenses. Windows is not supported/certified by this candidate.
