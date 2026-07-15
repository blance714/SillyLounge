import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { generateStDataRoot } from './generate-data-root.mjs';
import { inspectStCheckout, startStServer } from './st-process.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..');
const DEFAULT_RUNTIME_ROOT = path.join(PROJECT_ROOT, '.runtime', 'SillyTavern-ChatUI');

function parseArgs(argv) {
    const values = { keep: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') continue;
        if (argument === '--keep') {
            values.keep = true;
            continue;
        }
        if (!argument.startsWith('--')) throw new Error(`invalid argument: ${argument}`);
        const value = argv[index + 1];
        if (!value) throw new Error(`${argument} requires a value`);
        values[argument.slice(2)] = value;
        index += 1;
    }
    return values;
}

export async function runStSmoke({
    stRoot,
    runtimeRoot = DEFAULT_RUNTIME_ROOT,
    keep = false,
}) {
    if (!stRoot) throw new Error('stRoot is required (pass --st or SILLYTAVERN_TEST_ROOT)');
    const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sillylounge-st-smoke-'));
    const dataRoot = path.join(runRoot, 'data');
    let server = null;
    let succeeded = false;

    try {
        const generated = await generateStDataRoot({ targetRoot: dataRoot, stRoot, runtimeRoot });
        server = await startStServer({ stRoot, runRoot, dataRoot });
        const [versionResponse, pageResponse] = await Promise.all([
            fetch(`${server.url}/version`, { signal: AbortSignal.timeout(5_000) }),
            fetch(server.url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) }),
        ]);
        if (!versionResponse.ok) throw new Error(`/version returned HTTP ${versionResponse.status}`);
        if (pageResponse.status !== 200) throw new Error(`/ returned HTTP ${pageResponse.status}`);
        const version = await versionResponse.json();
        const pageType = pageResponse.headers.get('content-type') ?? '';
        if (!pageType.includes('text/html')) throw new Error(`/ did not return HTML: ${pageType}`);
        if (version.pkgVersion !== generated.manifest.st.version) {
            throw new Error(`running ST version mismatch: expected ${generated.manifest.st.version}, got ${version.pkgVersion}`);
        }

        const url = server.url;
        await server.stop();
        server = null;
        await inspectStCheckout({ stRoot });
        succeeded = true;
        return Object.freeze({
            runRoot,
            dataRoot,
            url,
            version: Object.freeze(structuredClone(version)),
            pageStatus: pageResponse.status,
            fixture: generated.manifest.fixture,
        });
    } finally {
        if (server) await server.stop();
        if (!keep && succeeded) await fs.rm(runRoot, { recursive: true, force: true });
        if (!succeeded) console.error(`[SillyLounge test] retained failed ST smoke run: ${runRoot}`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const result = await runStSmoke({
        stRoot: args.st ?? process.env.SILLYTAVERN_TEST_ROOT,
        runtimeRoot: args.runtime,
        keep: args.keep,
    });
    console.log(`[SillyLounge test] ST host smoke passed (${result.version.pkgVersion}, fixture=${result.fixture})`);
    if (args.keep) console.log(`[SillyLounge test] retained run: ${result.runRoot}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
