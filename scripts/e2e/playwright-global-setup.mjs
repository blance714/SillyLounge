import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { generateStDataRoot } from './generate-data-root.mjs';
import { inspectStCheckout, startStServer } from './st-process.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const RUNTIME_ROOT = path.join(PROJECT_ROOT, '.runtime', 'SillyTavern-ChatUI');
const RESULTS_ROOT = path.join(PROJECT_ROOT, 'test-results', 'host');

async function copyIfPresent(source, destination) {
    try {
        await fs.copyFile(source, destination);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

async function preserveHostEvidence(server, runRoot, extra = {}) {
    await fs.mkdir(RESULTS_ROOT, { recursive: true });
    if (server) {
        await Promise.all([
            copyIfPresent(server.paths.stdout, path.join(RESULTS_ROOT, 'sillytavern.stdout.log')),
            copyIfPresent(server.paths.stderr, path.join(RESULTS_ROOT, 'sillytavern.stderr.log')),
            copyIfPresent(server.paths.config, path.join(RESULTS_ROOT, 'config.yaml')),
        ]);
    }
    const evidence = {
        runRoot,
        fixture: server?.fixture.manifest.fixture ?? null,
        url: server?.url ?? null,
        version: server?.version ?? null,
        commit: server?.checkout.commit ?? null,
        ...extra,
    };
    await fs.writeFile(
        path.join(RESULTS_ROOT, 'host-state.json'),
        `${JSON.stringify(evidence, null, 4)}\n`,
        'utf8',
    );
}

export default async function globalSetup() {
    const stRoot = process.env.SILLYTAVERN_TEST_ROOT;
    if (!stRoot) {
        throw new Error('SILLYTAVERN_TEST_ROOT must point at the pinned SillyTavern checkout');
    }

    await fs.rm(RESULTS_ROOT, { recursive: true, force: true });
    const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sillylounge-playwright-'));
    const dataRoot = path.join(runRoot, 'data');
    let server = null;

    try {
        const generated = await generateStDataRoot({ targetRoot: dataRoot, stRoot, runtimeRoot: RUNTIME_ROOT });
        server = await startStServer({ stRoot, runRoot, dataRoot });
        process.env.SILLYLOUNGE_E2E_URL = server.url;
        // What smoke.spec.mjs checks the served extension against, so that
        // 「these assertions describe the build under test」 is something the
        // suite proves rather than assumes.
        process.env.SILLYLOUNGE_E2E_STAMP = generated.manifest.stamp;
        await preserveHostEvidence(server, runRoot, { phase: 'ready' });
    } catch (error) {
        await preserveHostEvidence(server, runRoot, {
            phase: 'setup-failed',
            error: error instanceof Error ? error.stack : String(error),
        });
        if (server) await server.stop();
        await fs.rm(runRoot, { recursive: true, force: true });
        throw error;
    }

    return async () => {
        const cleanupErrors = [];
        try {
            await server.stop();
        } catch (error) {
            cleanupErrors.push(error);
        }
        try {
            await inspectStCheckout({ stRoot });
        } catch (error) {
            cleanupErrors.push(error);
        }
        try {
            await preserveHostEvidence(server, runRoot, {
                phase: cleanupErrors.length === 0 ? 'stopped-cleanly' : 'cleanup-failed',
                cleanupErrors: cleanupErrors.map(error => error instanceof Error ? error.stack : String(error)),
            });
        } finally {
            await fs.rm(runRoot, { recursive: true, force: true });
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, 'SillyTavern test host cleanup failed');
        }
    };
}
