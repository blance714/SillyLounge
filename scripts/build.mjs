import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { posixPath, walk } from './lib.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const RUNTIME_OUT_DIR = path.join(PROJECT_ROOT, 'dist', 'runtime');
const ROOT_APP_ENTRY = path.join(SRC_DIR, 'ui/app.tsx');
const ROOT_APP_FILE_NAME = 'root-app.mjs';
const ROOT_APP_SOURCE_SPECIFIER = '../../dist/root-app.mjs';
const ROOT_APP_EXTERNAL_ID = 'chatui:root-app';
const ROOT_APP_RUNTIME_PATH = `dist/${ROOT_APP_FILE_NAME}`;
const RUNTIME_VENDOR_SOURCE_ID = 'zod/mini';
const RUNTIME_VENDOR_FILE_NAME = 'chunks/vendor/zod.js';
const RUNTIME_VENDOR_ENTRY = path.join(SCRIPT_DIR, 'vendor', 'zod-mini.mjs');
const BUILD_TARGET = 'es2020';
const VITE_LOG_LEVEL = 'info';
const RUNTIME_ENTRY_DIRS = Object.freeze(['adapter', 'store', 'shield']);
const RUNTIME_ENTRY_FILES = Object.freeze([
    'index.ts',
    'ui/root.ts',
    // Pure ui/ modules are bundled into root-app.mjs like everything else; they
    // are named here as well so `dist/runtime/ui/*.js` carries a standalone,
    // importable copy for the Node unit tests.
    'ui/escape-ladder.ts',
    'ui/floor-rail-math.ts',
    'ui/follow-scroll-math.ts',
    'ui/format.ts',
    'ui/menu-placement.ts',
    'ui/message-menu-rows.ts',
    'ui/spine-cast.ts',
    'ui/swipe-segment-math.ts',
    'ui/topbar-menu-logic.ts',
]);

const ST_EXTERNAL_TARGETS = Object.freeze({
    '@st/extensions': { up: 3, file: 'extensions.js' },
    '@st/script': { up: 4, file: 'script.js' },
    '@st/st-context': { up: 3, file: 'st-context.js' },
    '@st/utils': { up: 3, file: 'utils.js' },
    '@st/bookmarks': { up: 3, file: 'bookmarks.js' },
    '@st/chats': { up: 3, file: 'chats.js' },
    '@st/itemized-prompts': { up: 3, file: 'itemized-prompts.js' },
    '@st/regex-engine': { up: 3, file: 'extensions/regex/engine.js' },
    '@st/personas': { up: 3, file: 'personas.js' },
    '@st/slash-commands': { up: 3, file: 'slash-commands.js' },
    '@st/scripts/RossAscends-mods': { up: 4, file: 'scripts/RossAscends-mods.js' },
});

const PREACT_COMPAT_ALIASES = Object.freeze({
    react: 'preact/compat',
    'react-dom': 'preact/compat',
    'react-dom/client': 'preact/compat/client',
    'react/jsx-runtime': 'preact/compat/jsx-runtime',
    'react/jsx-dev-runtime': 'preact/compat/jsx-dev-runtime',
});

const BROWSER_DEFINE = Object.freeze({
    'process.env.NODE_ENV': JSON.stringify('production'),
});

const JSX_ESBUILD_OPTIONS = Object.freeze({
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
});

const RUNTIME_INTERNAL_EXTERNAL_TARGETS = Object.freeze({
    [ROOT_APP_EXTERNAL_ID]: ROOT_APP_RUNTIME_PATH,
    [RUNTIME_VENDOR_SOURCE_ID]: RUNTIME_VENDOR_FILE_NAME,
});

function createBaseViteOptions() {
    return {
        root: PROJECT_ROOT,
        configFile: false,
        publicDir: false,
        logLevel: VITE_LOG_LEVEL,
        define: { ...BROWSER_DEFINE },
    };
}

function upPath(count) {
    return '../'.repeat(count);
}

function runtimeRelativeSpecifier(chunkFileName, targetFileName) {
    const dirname = path.posix.dirname(posixPath(chunkFileName));
    const rel = path.posix.relative(dirname === '.' ? '' : dirname, targetFileName);
    return rel.startsWith('.') ? rel : `./${rel}`;
}

function stableSourceMapPath(sourcePath) {
    const normalized = posixPath(sourcePath);
    const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
    const nodeModulesMarker = '/node_modules/';
    const nodeModulesIndex = withLeadingSlash.lastIndexOf(nodeModulesMarker);
    if (nodeModulesIndex >= 0) {
        return `vendor/${withLeadingSlash.slice(nodeModulesIndex + nodeModulesMarker.length)}`;
    }

    const sourceMarker = '/src/';
    const sourceIndex = withLeadingSlash.lastIndexOf(sourceMarker);
    if (sourceIndex >= 0) {
        return `src/${withLeadingSlash.slice(sourceIndex + sourceMarker.length)}`;
    }

    if (path.isAbsolute(sourcePath)) {
        return `sources/${path.basename(sourcePath)}`;
    }

    return normalized
        .replace(/^(?:\.\.\/)+/, 'sources/')
        .replace(/^\.\//, '');
}

function stExternalPath(id, chunkFileName) {
    const target = ST_EXTERNAL_TARGETS[id];
    if (!target) return id;
    const cleanFileName = posixPath(chunkFileName).replace(/^(\.\.\/)+/, '').replace(/^\.\/+/, '');
    const dirname = posixPath(path.dirname(cleanFileName));
    const depth = dirname === '.'
        ? 0
        : dirname.split('/').filter(Boolean).length;
    return `${upPath(depth + target.up)}${target.file}`;
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteStExternalSpecifiers(code, fileName) {
    let next = code;
    for (const id of Object.keys(ST_EXTERNAL_TARGETS)) {
        const escaped = escapeRegex(id);
        const replacement = stExternalPath(id, fileName);
        next = next
            .replace(new RegExp(`from\\s+(['"])${escaped}\\1`, 'g'), `from "${replacement}"`)
            .replace(new RegExp(`import\\s+(['"])${escaped}\\1`, 'g'), `import "${replacement}"`)
            .replace(new RegExp(`import\\(\\s*(['"])${escaped}\\1\\s*\\)`, 'g'), `import("${replacement}")`);
    }
    return next;
}

function createStExternalRewritePlugin() {
    return {
        name: 'chatui-rewrite-st-externals',
        renderChunk(code, chunk) {
            const next = rewriteStExternalSpecifiers(code, chunk.fileName);
            return next === code ? null : { code: next, map: null };
        },
        generateBundle(_options, bundle) {
            for (const item of Object.values(bundle)) {
                if (item.type !== 'chunk') continue;
                item.code = rewriteStExternalSpecifiers(item.code, item.fileName);
            }
        },
    };
}

async function listRuntimeEntries() {
    const entries = new Map();

    for (const file of RUNTIME_ENTRY_FILES) {
        entries.set(file.replace(/\.ts$/, ''), path.join(SRC_DIR, file));
    }

    for (const dir of RUNTIME_ENTRY_DIRS) {
        await walk(path.join(SRC_DIR, dir), full => {
            if (!full.endsWith('.ts') || full.endsWith('.d.ts')) return;
            const rel = posixPath(path.relative(SRC_DIR, full)).replace(/\.ts$/, '');
            entries.set(rel, full);
        });
    }

    return Object.fromEntries(entries);
}

function rewriteRuntimeInternalExternalSpecifiers(code, fileName) {
    let next = code;
    for (const [id, target] of Object.entries(RUNTIME_INTERNAL_EXTERNAL_TARGETS)) {
        const replacement = runtimeRelativeSpecifier(fileName, target);
        next = next.replace(
            new RegExp(`(['"])${escapeRegex(id)}\\1`, 'g'),
            `"${replacement}"`,
        );
    }
    return next;
}

function createRuntimeInternalExternalPlugin() {
    return {
        name: 'chatui-runtime-internal-externals',
        resolveId(id) {
            if (id !== ROOT_APP_SOURCE_SPECIFIER) return null;
            return { id: ROOT_APP_EXTERNAL_ID, external: true };
        },
        renderChunk(code, chunk) {
            const next = rewriteRuntimeInternalExternalSpecifiers(code, chunk.fileName);
            return next === code ? null : { code: next, map: null };
        },
        generateBundle(_options, bundle) {
            for (const item of Object.values(bundle)) {
                if (item.type !== 'chunk') continue;
                item.code = rewriteRuntimeInternalExternalSpecifiers(item.code, item.fileName);
            }
        },
    };
}

function isStExternal(id) {
    return id in ST_EXTERNAL_TARGETS;
}

function isRuntimeExternal(id) {
    return isStExternal(id)
        || id === ROOT_APP_EXTERNAL_ID
        || id === RUNTIME_VENDOR_SOURCE_ID;
}

function isUiRuntimeExternal(id) {
    return id.startsWith('../store/')
        || id.startsWith('../shield/');
}

function createRuntimeBuildOptions(runtimeEntries) {
    return {
        ...createBaseViteOptions(),
        plugins: [createRuntimeInternalExternalPlugin()],
        build: {
            target: BUILD_TARGET,
            outDir: RUNTIME_OUT_DIR,
            emptyOutDir: true,
            minify: false,
            sourcemap: true,
            rollupOptions: {
                input: runtimeEntries,
                external: isRuntimeExternal,
                preserveEntrySignatures: 'strict',
                output: {
                    dir: RUNTIME_OUT_DIR,
                    format: 'es',
                    preserveModules: true,
                    preserveModulesRoot: 'src',
                    entryFileNames: '[name].js',
                    chunkFileNames: 'chunks/[name]-[hash].js',
                    sourcemapPathTransform: stableSourceMapPath,
                    plugins: [createStExternalRewritePlugin()],
                },
            },
        },
    };
}

function createRuntimeVendorBuildOptions() {
    return {
        ...createBaseViteOptions(),
        build: {
            target: BUILD_TARGET,
            outDir: RUNTIME_OUT_DIR,
            emptyOutDir: false,
            minify: false,
            sourcemap: true,
            lib: {
                entry: RUNTIME_VENDOR_ENTRY,
                formats: ['es'],
                fileName: () => RUNTIME_VENDOR_FILE_NAME,
            },
            rollupOptions: {
                output: {
                    entryFileNames: RUNTIME_VENDOR_FILE_NAME,
                    sourcemapPathTransform: stableSourceMapPath,
                },
            },
        },
    };
}

function createUiBundleBuildOptions() {
    return {
        ...createBaseViteOptions(),
        resolve: {
            alias: { ...PREACT_COMPAT_ALIASES },
        },
        esbuild: { ...JSX_ESBUILD_OPTIONS },
        build: {
            target: BUILD_TARGET,
            outDir: DIST_DIR,
            emptyOutDir: false,
            minify: false,
            sourcemap: true,
            lib: {
                entry: ROOT_APP_ENTRY,
                formats: ['es'],
                fileName: () => ROOT_APP_FILE_NAME,
            },
            rollupOptions: {
                external: isUiRuntimeExternal,
                output: {
                    entryFileNames: ROOT_APP_FILE_NAME,
                    assetFileNames: 'assets/[name][extname]',
                    sourcemapPathTransform: stableSourceMapPath,
                },
            },
        },
    };
}

export async function buildRuntimeModules() {
    await build(createRuntimeBuildOptions(await listRuntimeEntries()));
}

export async function buildRuntimeVendor() {
    await build(createRuntimeVendorBuildOptions());
}

export async function buildUiBundle() {
    await build(createUiBundleBuildOptions());
}

export async function buildAll() {
    await fs.rm(DIST_DIR, { recursive: true, force: true });
    await buildRuntimeModules();
    await buildRuntimeVendor();
    await buildUiBundle();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await buildAll();
}
