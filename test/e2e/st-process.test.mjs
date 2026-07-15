import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
    inspectStCheckout,
    startStServer,
    validateFixtureDataRoot,
} from '../../scripts/e2e/st-process.mjs';

const execFile = promisify(execFileCallback);
const ST_VERSION = '1.18.0';

const FAKE_SERVER = `
import fs from 'node:fs';
import path from 'node:path';

const value = name => process.argv.find(argument => argument.startsWith('--' + name + '='))?.split('=').slice(1).join('=');
const port = Number(value('port'));
const dataRoot = value('dataRoot');
const configPath = value('configPath');
const config = fs.readFileSync(configPath, 'utf8');
fs.writeFileSync(path.join(dataRoot, 'fake-server-started.json'), JSON.stringify({ dataRoot, configPath, port, config }));
setInterval(() => {}, 1_000);
const stop = () => process.exit(0);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`;

async function git(root, ...args) {
    const { stdout } = await execFile('git', ['-C', root, ...args], { encoding: 'utf8' });
    return stdout.trim();
}

async function makeFakeCheckout(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sillylounge-st-checkout-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'sillytavern', version: ST_VERSION })}\n`);
    await fs.writeFile(path.join(root, 'server.js'), FAKE_SERVER);
    await fs.mkdir(path.join(root, 'default'), { recursive: true });
    await fs.writeFile(path.join(root, 'default', 'config.yaml'), 'extensions:\n  enabled: true\n  autoUpdate: true\n');
    await git(root, 'init', '-q');
    await git(root, 'add', 'package.json', 'server.js', 'default/config.yaml');
    await git(root, '-c', 'user.name=SillyLounge Test', '-c', 'user.email=test@sillylounge.invalid', 'commit', '-q', '-m', 'fixture');
    await fs.mkdir(path.join(root, 'node_modules'));
    const commit = await git(root, 'rev-parse', 'HEAD');
    return { root, commit };
}

async function makeRunRoot(t, pin) {
    const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sillylounge-st-run-'));
    t.after(() => fs.rm(runRoot, { recursive: true, force: true }));
    const dataRoot = path.join(runRoot, 'data');
    await fs.mkdir(dataRoot);
    await fs.writeFile(path.join(dataRoot, '_sillylounge-fixture.json'), `${JSON.stringify({
        schemaVersion: pin.fixtureSchema,
        fixture: 'smoke',
        st: { version: pin.version, commit: pin.commit },
        user: { handle: 'default-user' },
    })}\n`);
    const pinPath = path.join(runRoot, 'st-version.json');
    await fs.writeFile(pinPath, `${JSON.stringify(pin)}\n`);
    return { runRoot, dataRoot, pinPath };
}

async function waitForFakeReadiness({ child, timeoutMs }, markerPath) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error('fake server exited before writing its readiness marker');
        }
        try {
            await fs.access(markerPath);
            return { pkgVersion: ST_VERSION, fixture: true };
        } catch {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    throw new Error('fake server did not write its readiness marker');
}

test('checkout pin accepts untracked files but rejects commit or tracked-tree drift', async t => {
    await t.test('untracked files are allowed', async t => {
        const checkout = await makeFakeCheckout(t);
        const run = await makeRunRoot(t, {
            repository: 'SillyTavern/SillyTavern',
            version: ST_VERSION,
            commit: checkout.commit,
            fixtureSchema: 1,
        });
        await fs.writeFile(path.join(checkout.root, 'local-backup.txt'), 'allowed');
        const result = await inspectStCheckout({ stRoot: checkout.root, pinPath: run.pinPath });
        assert.equal(result.commit, checkout.commit);
    });

    await t.test('the wrong commit is rejected', async t => {
        const checkout = await makeFakeCheckout(t);
        const run = await makeRunRoot(t, {
            repository: 'SillyTavern/SillyTavern',
            version: ST_VERSION,
            commit: '0'.repeat(40),
            fixtureSchema: 1,
        });
        await assert.rejects(
            inspectStCheckout({ stRoot: checkout.root, pinPath: run.pinPath }),
            /SillyTavern commit mismatch/,
        );
    });

    await t.test('tracked modifications are rejected', async t => {
        const checkout = await makeFakeCheckout(t);
        const run = await makeRunRoot(t, {
            repository: 'SillyTavern/SillyTavern',
            version: ST_VERSION,
            commit: checkout.commit,
            fixtureSchema: 1,
        });
        await fs.appendFile(path.join(checkout.root, 'server.js'), '\n// modified\n');
        await assert.rejects(
            inspectStCheckout({ stRoot: checkout.root, pinPath: run.pinPath }),
            /tracked files differ/,
        );
    });
});

test('fixture guard rejects unsigned or out-of-run data roots', async t => {
    const pin = { version: ST_VERSION, commit: 'a'.repeat(40), fixtureSchema: 1 };
    const run = await makeRunRoot(t, pin);
    const valid = await validateFixtureDataRoot({ runRoot: run.runRoot, dataRoot: run.dataRoot, pin });
    assert.equal(valid.manifest.user.handle, 'default-user');

    const unsigned = await fs.mkdtemp(path.join(os.tmpdir(), 'sillylounge-unsigned-data-'));
    t.after(() => fs.rm(unsigned, { recursive: true, force: true }));
    await assert.rejects(
        validateFixtureDataRoot({ runRoot: run.runRoot, dataRoot: unsigned, pin }),
        /strictly inside runRoot/,
    );

    await fs.unlink(path.join(run.dataRoot, '_sillylounge-fixture.json'));
    await assert.rejects(
        validateFixtureDataRoot({ runRoot: run.runRoot, dataRoot: run.dataRoot, pin }),
        /not a generated SillyLounge fixture/,
    );
});

test('server lifecycle passes isolated paths, probes readiness, and releases the process', async t => {
    const checkout = await makeFakeCheckout(t);
    const pin = {
        repository: 'SillyTavern/SillyTavern',
        version: ST_VERSION,
        commit: checkout.commit,
        fixtureSchema: 1,
    };
    const run = await makeRunRoot(t, pin);
    const markerPath = path.join(run.dataRoot, 'fake-server-started.json');
    const server = await startStServer({
        stRoot: checkout.root,
        runRoot: run.runRoot,
        dataRoot: run.dataRoot,
        pinPath: run.pinPath,
        port: 43127,
        readyTimeoutMs: 5_000,
        readinessProbe: context => waitForFakeReadiness(context, markerPath),
    });
    t.after(() => server.stop());

    assert.equal(server.isRunning(), true);
    assert.equal(server.version.pkgVersion, ST_VERSION);
    assert.equal(server.version.fixture, true);
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    assert.equal(marker.dataRoot, server.fixture.dataRoot);
    assert.equal(marker.configPath, path.join(server.fixture.runRoot, 'config.yaml'));
    assert.equal(marker.port, server.port);
    assert.match(marker.config, /autoUpdate: false/);
    assert.equal(server.paths.stdout.startsWith(server.fixture.runRoot), true);
    assert.equal(server.paths.stderr.startsWith(server.fixture.runRoot), true);

    await server.stop();
    assert.equal(server.isRunning(), false);
});
