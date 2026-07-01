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

Run typecheck and build:

```sh
pnpm run typecheck
pnpm run build
```

Generate the local runtime install directory:

```sh
pnpm run runtime
```

In non-interactive automation, prefer the explicit CI form so pnpm will not stop
on its module-purge prompt:

```sh
CI=true pnpm run typecheck
CI=true pnpm run build
CI=true pnpm run runtime
```

`pnpm run build` only writes generated artifacts under `dist/`:

- runtime modules: `dist/runtime/`
- bundled Preact app: `dist/root-app.mjs`

`pnpm run runtime` runs the build, syncs the SillyTavern-loadable tree into
`.runtime/SillyTavern-ChatUI`, then runs `scripts/check-runtime.mjs` against
both `dist/` and `.runtime/SillyTavern-ChatUI`. That check fails on unresolved
`@st/*` aliases, leftover `process.env` / Node globals, and absolute or Node-only
import specifiers in generated browser files.

For local development against a SillyTavern checkout, link SillyTavern's
`public/scripts/extensions/third-party/SillyTavern-ChatUI` path to:

```text
.runtime/SillyTavern-ChatUI
```

On this machine, the concrete symlink target is:

```text
/Users/blance/Documents/SillyTavern/public/scripts/extensions/third-party/SillyTavern-ChatUI
  -> /Users/blance/Documents/SillyTavern-ChatUI/.runtime/SillyTavern-ChatUI
```

Then run:

```sh
pnpm run dev
```

`dev` watches the Vite build inputs and runtime extension files, then keeps the
`.runtime/SillyTavern-ChatUI` install directory synced.

## Docs

- `ARCHITECTURE.md`: long-form architecture, migration strategy, and dependency inventory.
- `STATUS.md`: current progress snapshot, important boundaries, and next milestones.

## Runtime Files

The generated runtime directory intentionally excludes:

- `node_modules/`
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
