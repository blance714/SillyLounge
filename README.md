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

`dev` watches the Preact/TSX build and runtime extension files, then keeps the
`.runtime/SillyTavern-ChatUI` install directory synced.

## Docs

- `ARCHITECTURE.md`: long-form architecture, migration strategy, and dependency inventory.
- `STATUS.md`: current progress snapshot, important boundaries, and next milestones.

## Runtime Files

The generated runtime directory intentionally excludes:

- `node_modules/`
- `package.json`
- `tsconfig.json`
- `scripts/`
- `ui/*.ts`
- `ui/*.tsx`
- `ui/components/`
- docs and source-only contracts

It includes the SillyTavern manifest, runtime JS/CSS modules, and built Preact
assets under `dist/`.
