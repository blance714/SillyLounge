# SillyTavern ChatUI

ChatUI is a SillyTavern extension-hosted frontend experiment.

## Branch Model

- `dist`: default branch for SillyTavern Extension Installer. Contains only runtime files that SillyTavern can load directly.
- `main`: development branch. Contains TypeScript/TSX source, build scripts, docs, and local tooling.

SillyTavern does not build extensions during installation, so the installable
branch must already contain built browser assets.

## Development

Install dependencies:

```sh
pnpm install
```

Development requires Node.js `^20.19.0` or `>=22.12.0` (the supported Vite
runtime range).

Run the full local verification gate:

```sh
pnpm run verify
```

`verify` runs typecheck, the Node test suite, a clean Vite build, and the
assembled-runtime build contract. The contract check does not replace the live
runtime directory.

Generate the local runtime install directory:

```sh
pnpm run runtime
```

In non-interactive automation, prefer the explicit CI form so pnpm will not stop
on its module-purge prompt:

```sh
CI=true pnpm run typecheck
CI=true pnpm run verify
CI=true pnpm run runtime
```

`pnpm run build` only writes generated artifacts under `dist/`:

- runtime modules: `dist/runtime/`
- stable runtime dependencies: `dist/runtime/chunks/vendor/`
- bundled Preact app: `dist/root-app.mjs`

`pnpm run runtime` builds a complete candidate tree beside
`.runtime/SillyTavern-ChatUI`, validates it, and only then publishes it. The
validator checks the manifest JS/CSS entries, every generated relative import,
the explicit SillyTavern external-import allowlist, Node globals, and generated
paths. `node_modules`, `.pnpm`, unresolved bare imports, and absolute
machine-local paths are release blockers.

The live path is a symlink to a validated release generation. Replacing that
pointer is atomic, so SillyTavern sees either the complete previous runtime or
the complete next runtime. A failed build or validation leaves the previous
runtime untouched. `pnpm run check:build` validates a newly assembled candidate
without publishing it; `pnpm run check:runtime` validates the current live tree.

For local development against a SillyTavern checkout, link SillyTavern's
`public/scripts/extensions/third-party/SillyTavern-ChatUI` path to:

```text
.runtime/SillyTavern-ChatUI
```

On this machine, the concrete symlink target is:

```text
/Users/blance/Developer/SillyTavern/public/scripts/extensions/third-party/SillyTavern-ChatUI
  -> /Users/blance/Developer/SillyTavern-ChatUI/.runtime/SillyTavern-ChatUI
```

Then run:

```sh
pnpm run dev
```

`dev` polls only the Vite/runtime source inputs (not `node_modules`). Every rebuild
goes through the same assembled-tree validation and atomic publication path as
`runtime`; a broken intermediate build never overwrites the live tree.

## Publishing the installable branch

SillyTavern's Extension Installer does not run this repository's build tools.
The `dist` branch must therefore contain the contents of the validated runtime
tree at its branch root: `manifest.json`, `style.css`, `index.js`, the compiled
module directories (including `chunks/vendor/`), and `dist/root-app.mjs`.

Do not publish the development branch's generated `dist/` directory by itself:
that directory intentionally lacks the manifest, stylesheet, and extension-root
layout. Run `pnpm run verify` first, then `pnpm run runtime`, and take the
installable payload from the resolved `.runtime/SillyTavern-ChatUI/` tree. There
is currently no repository CI or automated branch publication; these commands
are the local release gate.

## HTML card trust model

HTML card iframes are intentionally unsandboxed so trusted cards can integrate
with TavernHelper, MVU, and the surrounding SillyTavern runtime. Running such a
card is equivalent to running code supplied by that chat with the extension's
page privileges. Only load cards, character data, and chat histories you trust.
Sandboxing or an execution-confirmation gate is deliberately not applied because
it would break that compatibility contract.

## Docs

- `DESIGN.md`: product north star and testable Manuscript Flow visual contract.
- `ARCHITECTURE.md`: long-form architecture, migration strategy, and dependency inventory.
- `STATUS.md`: current progress snapshot, important boundaries, and next milestones.
- `ROADMAP.md`: completeness map and prioritized remaining work.

## Runtime Files

The generated runtime directory intentionally excludes:

- `node_modules/`
- `.pnpm/`
- `.pnpm-store/`
- `package.json`
- `tsconfig.json`
- `scripts/`
- `src/`
- docs and source-only contracts

Authored source now lives under `src/`. Vite compiles the runtime modules into
`dist/runtime/` and the Preact app into `dist/root-app.mjs`; `pnpm run runtime`
then syncs the SillyTavern-loadable tree into `.runtime/SillyTavern-ChatUI`.
The runtime chain is:

```text
src/
  -> dist/runtime/ + dist/root-app.mjs
  -> .runtime/SillyTavern-ChatUI
  -> SillyTavern public/scripts/extensions/third-party/SillyTavern-ChatUI symlink
```

Vite may print a React Query warning about package-level `"use client"`
directives being ignored. That warning is expected for this browser bundle. The
bundle defines `process.env.NODE_ENV` as `"production"` in `scripts/build.mjs`,
and the runtime artifact check verifies no `process.env` reference survives in
generated JS/MJS files.
