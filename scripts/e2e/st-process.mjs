import { execFile as execFileCallback, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..');
const DEFAULT_ST_PIN_PATH = path.join(PROJECT_ROOT, 'test', 'e2e', 'st-version.json');
const FIXTURE_MANIFEST_FILE = '_sillylounge-fixture.json';

function isPathInside(rootPath, candidatePath) {
    const relative = path.relative(rootPath, candidatePath);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function readJson(filePath) {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function gitOutput(stRoot, args) {
    try {
        const { stdout } = await execFile('git', ['-C', stRoot, ...args], {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
        });
        return stdout.trim();
    } catch (error) {
        throw new Error(`unable to inspect SillyTavern checkout with git: ${error.message}`, { cause: error });
    }
}

export async function inspectStCheckout({
    stRoot,
    pinPath = DEFAULT_ST_PIN_PATH,
}) {
    if (!stRoot) throw new Error('stRoot is required');
    const resolvedStRoot = await fs.realpath(path.resolve(stRoot));
    const [pin, stPackage, head, trackedStatus] = await Promise.all([
        readJson(pinPath),
        readJson(path.join(resolvedStRoot, 'package.json')),
        gitOutput(resolvedStRoot, ['rev-parse', 'HEAD']),
        gitOutput(resolvedStRoot, ['status', '--porcelain=v1', '--untracked-files=no']),
        fs.access(path.join(resolvedStRoot, 'server.js')),
        fs.access(path.join(resolvedStRoot, 'node_modules')),
    ]);

    if (stPackage.version !== pin.version) {
        throw new Error(`SillyTavern version mismatch: expected ${pin.version}, got ${stPackage.version}`);
    }
    if (head !== pin.commit) {
        throw new Error(`SillyTavern commit mismatch: expected ${pin.commit}, got ${head}`);
    }
    if (trackedStatus) {
        throw new Error(`SillyTavern tracked files differ from ${pin.commit}:\n${trackedStatus}`);
    }

    return Object.freeze({
        stRoot: resolvedStRoot,
        pin: Object.freeze(structuredClone(pin)),
        version: stPackage.version,
        commit: head,
    });
}

export async function validateFixtureDataRoot({
    runRoot,
    dataRoot,
    pin,
}) {
    if (!runRoot || !dataRoot || !pin) throw new Error('runRoot, dataRoot, and pin are required');
    const resolvedRunRoot = await fs.realpath(path.resolve(runRoot));
    const resolvedDataRoot = await fs.realpath(path.resolve(dataRoot));
    const [runStat, dataStat] = await Promise.all([
        fs.lstat(path.resolve(runRoot)),
        fs.lstat(path.resolve(dataRoot)),
    ]);
    if (runStat.isSymbolicLink() || dataStat.isSymbolicLink()) {
        throw new Error('runRoot and dataRoot must not be symbolic links');
    }
    if (!dataStat.isDirectory() || !isPathInside(resolvedRunRoot, resolvedDataRoot) || resolvedDataRoot === resolvedRunRoot) {
        throw new Error('dataRoot must be a directory strictly inside runRoot');
    }

    const manifestPath = path.join(resolvedDataRoot, FIXTURE_MANIFEST_FILE);
    let manifest;
    try {
        manifest = await readJson(manifestPath);
    } catch (error) {
        throw new Error(`dataRoot is not a generated SillyLounge fixture: ${manifestPath}`, { cause: error });
    }
    if (manifest.schemaVersion !== pin.fixtureSchema) {
        throw new Error(`fixture schema mismatch: expected ${pin.fixtureSchema}, got ${manifest.schemaVersion}`);
    }
    if (manifest.st?.version !== pin.version || manifest.st?.commit !== pin.commit) {
        throw new Error('fixture SillyTavern pin does not match the checkout pin');
    }
    if (manifest.user?.handle !== 'default-user' || typeof manifest.fixture !== 'string') {
        throw new Error('fixture manifest does not declare the synthetic default-user');
    }

    return Object.freeze({
        runRoot: resolvedRunRoot,
        dataRoot: resolvedDataRoot,
        manifest: Object.freeze(structuredClone(manifest)),
        manifestPath,
    });
}

export async function findFreePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('unable to allocate a local TCP port');
    }
    const port = address.port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

function waitForExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }
    return new Promise(resolve => {
        let timer;
        const onExit = (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        };
        child.once('exit', onExit);
        timer = setTimeout(() => {
            child.off('exit', onExit);
            resolve(null);
        }, timeoutMs);
        timer.unref?.();
    });
}

async function terminateChild(child, timeoutMs = 10_000) {
    const alreadyExited = await waitForExit(child, 0);
    if (alreadyExited) return alreadyExited;
    child.kill('SIGTERM');
    const gracefulExit = await waitForExit(child, timeoutMs);
    if (gracefulExit) return gracefulExit;
    child.kill('SIGKILL');
    const forcedExit = await waitForExit(child, 5_000);
    if (!forcedExit) throw new Error(`SillyTavern process ${child.pid} did not exit after SIGKILL`);
    return forcedExit;
}

async function readLogTail(filePath, maxCharacters = 8_000) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        return content.slice(-maxCharacters);
    } catch {
        return '';
    }
}

async function waitForReady({ child, url, timeoutMs, stderrPath }) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
            const stderr = await readLogTail(stderrPath);
            throw new Error(`SillyTavern exited before becoming ready (${child.exitCode ?? child.signalCode})${stderr ? `:\n${stderr}` : ''}`);
        }
        try {
            const response = await fetch(`${url}/version`, {
                headers: { accept: 'application/json' },
                signal: AbortSignal.timeout(1_000),
            });
            if (response.ok) return await response.json();
            lastError = new Error(`/version returned HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    const stderr = await readLogTail(stderrPath);
    throw new Error(
        `SillyTavern did not become ready within ${timeoutMs}ms: ${lastError?.message ?? 'unknown error'}${stderr ? `\n${stderr}` : ''}`,
        { cause: lastError },
    );
}

export async function startStServer({
    stRoot,
    runRoot,
    dataRoot,
    pinPath = DEFAULT_ST_PIN_PATH,
    port,
    readyTimeoutMs = 90_000,
    readinessProbe,
}) {
    const checkout = await inspectStCheckout({ stRoot, pinPath });
    const fixture = await validateFixtureDataRoot({ runRoot, dataRoot, pin: checkout.pin });
    if (isPathInside(checkout.stRoot, fixture.runRoot) || isPathInside(checkout.stRoot, fixture.dataRoot)) {
        throw new Error('runRoot and dataRoot must be outside the SillyTavern checkout');
    }

    const selectedPort = port ?? await findFreePort();
    if (!Number.isInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535) {
        throw new Error(`invalid SillyTavern port: ${selectedPort}`);
    }

    const configPath = path.join(fixture.runRoot, 'config.yaml');
    const logRoot = path.join(fixture.runRoot, 'logs');
    const stdoutPath = path.join(logRoot, 'sillytavern.stdout.log');
    const stderrPath = path.join(logRoot, 'sillytavern.stderr.log');
    await fs.mkdir(logRoot, { recursive: true });
    const [stdoutHandle, stderrHandle] = await Promise.all([
        fs.open(stdoutPath, 'w'),
        fs.open(stderrPath, 'w'),
    ]);

    let child;
    try {
        child = spawn(process.execPath, [
            'server.js',
            `--configPath=${configPath}`,
            `--dataRoot=${fixture.dataRoot}`,
            `--port=${selectedPort}`,
            '--listen=false',
            '--enableIPv4=true',
            '--enableIPv6=false',
            '--browserLaunchEnabled=false',
            '--heartbeatInterval=0',
            '--whitelist=false',
            '--basicAuthMode=false',
            '--ssl=false',
        ], {
            cwd: checkout.stRoot,
            env: {
                ...process.env,
                NODE_ENV: 'production',
                SILLYTAVERN_DATAROOT: fixture.dataRoot,
            },
            stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
        });
    } finally {
        await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
    }

    const url = `http://127.0.0.1:${selectedPort}`;
    let stopPromise = null;
    const stop = () => {
        stopPromise ??= terminateChild(child);
        return stopPromise;
    };

    try {
        const version = readinessProbe
            ? await readinessProbe({ child, url, timeoutMs: readyTimeoutMs, stderrPath })
            : await waitForReady({ child, url, timeoutMs: readyTimeoutMs, stderrPath });
        return Object.freeze({
            pid: child.pid,
            port: selectedPort,
            url,
            version: Object.freeze(structuredClone(version)),
            checkout,
            fixture,
            paths: Object.freeze({ config: configPath, stdout: stdoutPath, stderr: stderrPath }),
            isRunning: () => child.exitCode === null && child.signalCode === null,
            stop,
        });
    } catch (error) {
        await stop();
        throw error;
    }
}
