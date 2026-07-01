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

For local development against a SillyTavern checkout, link SillyTavern's
`public/scripts/extensions/third-party/SillyTavern-ChatUI` path to:

```text
.runtime/SillyTavern-ChatUI
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
