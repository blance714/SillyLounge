import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');
const RUNTIME_OUT_DIR = path.join(PROJECT_ROOT, 'dist', 'runtime');

const ST_EXTERNAL_TARGETS = Object.freeze({
    '@st/extensions': { up: 3, file: 'extensions.js' },
    '@st/script': { up: 4, file: 'script.js' },
    '@st/st-context': { up: 3, file: 'st-context.js' },
    '@st/utils': { up: 3, file: 'utils.js' },
    '@st/bookmarks': { up: 3, file: 'bookmarks.js' },
    '@st/chats': { up: 3, file: 'chats.js' },
    '@st/personas': { up: 3, file: 'personas.js' },
    '@st/scripts/RossAscends-mods': { up: 4, file: 'scripts/RossAscends-mods.js' },
});

function posixPath(value) {
    return value.split(path.sep).join('/');
}

function upPath(count) {
    return '../'.repeat(count);
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

function rewriteStExternalImports() {
    const rewrite = (code, fileName) => {
        let next = code;
        for (const id of Object.keys(ST_EXTERNAL_TARGETS)) {
            const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const replacement = stExternalPath(id, fileName);
            next = next
                .replace(new RegExp(`from\\s+(['"])${escaped}\\1`, 'g'), `from "${replacement}"`)
                .replace(new RegExp(`import\\s+(['"])${escaped}\\1`, 'g'), `import "${replacement}"`)
                .replace(new RegExp(`import\\(\\s*(['"])${escaped}\\1\\s*\\)`, 'g'), `import("${replacement}")`);
        }
        return next;
    };

    return {
        name: 'chatui-rewrite-st-externals',
        renderChunk(code, chunk) {
            const next = rewrite(code, chunk.fileName);
            return next === code ? null : { code: next, map: null };
        },
        generateBundle(_options, bundle) {
            for (const item of Object.values(bundle)) {
                if (item.type !== 'chunk') continue;
                item.code = rewrite(item.code, item.fileName);
            }
        },
    };
}

async function listRuntimeEntries() {
    const entries = new Map();
    const includeDirs = ['adapter', 'store', 'shield'];
    const includeFiles = ['index.ts', 'ui/root.ts'];

    for (const file of includeFiles) {
        entries.set(file.replace(/\.ts$/, ''), path.join(SRC_DIR, file));
    }

    async function walk(dir) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) {
                const rel = posixPath(path.relative(SRC_DIR, full)).replace(/\.ts$/, '');
                entries.set(rel, full);
            }
        }
    }

    for (const dir of includeDirs) {
        await walk(path.join(SRC_DIR, dir));
    }

    return Object.fromEntries(entries);
}

function isStExternal(id) {
    return id in ST_EXTERNAL_TARGETS;
}

function isRuntimeExternal(id) {
    return isStExternal(id) || id === '../dist/root-app.mjs';
}

function isUiRuntimeExternal(id) {
    return id.startsWith('../store/')
        || id.startsWith('../shield/');
}

const reactAliases = {
    react: 'preact/compat',
    'react-dom': 'preact/compat',
    'react-dom/client': 'preact/compat/client',
    'react/jsx-runtime': 'preact/compat/jsx-runtime',
    'react/jsx-dev-runtime': 'preact/compat/jsx-dev-runtime',
};

const browserDefines = {
    'process.env.NODE_ENV': JSON.stringify('production'),
};

export async function buildAll() {
    await fs.rm(path.join(PROJECT_ROOT, 'dist'), { recursive: true, force: true });

    await build({
        root: PROJECT_ROOT,
        configFile: false,
        publicDir: false,
        logLevel: 'info',
        define: browserDefines,
        build: {
            target: 'es2020',
            outDir: RUNTIME_OUT_DIR,
            emptyOutDir: true,
            minify: false,
            sourcemap: true,
            rollupOptions: {
                input: await listRuntimeEntries(),
                external: isRuntimeExternal,
                preserveEntrySignatures: 'strict',
                output: {
                    dir: RUNTIME_OUT_DIR,
                    format: 'es',
                    preserveModules: true,
                    preserveModulesRoot: 'src',
                    entryFileNames: '[name].js',
                    chunkFileNames: 'chunks/[name]-[hash].js',
                    plugins: [rewriteStExternalImports()],
                },
            },
        },
    });

    await build({
        root: PROJECT_ROOT,
        configFile: false,
        publicDir: false,
        logLevel: 'info',
        define: browserDefines,
        resolve: {
            alias: reactAliases,
        },
        esbuild: {
            jsxFactory: 'React.createElement',
            jsxFragment: 'React.Fragment',
        },
        build: {
            target: 'es2020',
            outDir: path.join(PROJECT_ROOT, 'dist'),
            emptyOutDir: false,
            minify: false,
            sourcemap: true,
            lib: {
                entry: path.join(SRC_DIR, 'ui/app.tsx'),
                formats: ['es'],
                fileName: () => 'root-app.mjs',
            },
            rollupOptions: {
                external: isUiRuntimeExternal,
                output: {
                    entryFileNames: 'root-app.mjs',
                    assetFileNames: 'assets/[name][extname]',
                },
            },
        },
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await buildAll();
}
