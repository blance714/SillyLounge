/**
 * SillyTavern-ChatUI · host operation queue
 *
 * SillyTavern exposes one mutable active-chat context. Operations that read
 * and then mutate that context (navigation, send, destructive chat actions)
 * must not overlap even when their UI entry points live in different modules.
 */

export type HostNavigationOperation = Readonly<{
    id: number;
    epoch: number;
    isLatest: () => boolean;
}>;

let _hostTaskTail: Promise<void> = Promise.resolve();
let _nextNavigationId = 0;
let _latestNavigationId = 0;
let _lifecycleEpoch = 0;
let _terminalReload = false;

export class HostOperationCancelledError extends Error {
    constructor() {
        super('[ChatUI] Host operation belonged to an inactive UI lifecycle');
        this.name = 'HostOperationCancelledError';
    }
}

type HostTaskOptions<T> = Readonly<{
    rejectOnCancelled?: boolean;
    onCancelled?: () => Promise<T> | T;
}>;

/** Current ChatUI lifecycle generation. Tokens from another epoch are stale. */
export function getHostOperationEpoch(): number {
    return _lifecycleEpoch;
}

/**
 * Invalidate work that has not entered ST yet. The existing tail is deliberately
 * retained: an already-running host mutation must finish before the next
 * lifecycle starts mutating the same global context.
 */
export function resetHostOperationQueueLifecycle(): number {
    _lifecycleEpoch += 1;
    _latestNavigationId = 0;
    return _lifecycleEpoch;
}

/**
 * Enter a terminal state before reloading from durable host data. Existing and
 * newly-enqueued intents are cancelled; the current task may finish its cleanup,
 * but nothing else can enter ST in the navigation-before-unload window.
 */
export function sealHostOperationQueueForReload(): number {
    _terminalReload = true;
    return resetHostOperationQueueLifecycle();
}

/** Serialize one operation against every other host-context mutation. */
export function enqueueHostTask<T>(
    task: () => Promise<T>,
    options: HostTaskOptions<T> = {},
): Promise<T | undefined> {
    const epoch = _lifecycleEpoch;
    const runIfCurrent = (): Promise<T | undefined> => {
        if (!_terminalReload && epoch === _lifecycleEpoch) return task();
        if (options.onCancelled) return Promise.resolve(options.onCancelled());
        if (options.rejectOnCancelled) return Promise.reject(new HostOperationCancelledError());
        return Promise.resolve(undefined);
    };
    const result = _hostTaskTail.then(runIfCurrent, runIfCurrent);
    _hostTaskTail = result.then(() => undefined, () => undefined);
    return result;
}

/**
 * Serialize navigation and drop an older navigation intent if it has not
 * started yet. An operation already inside ST is allowed to finish; the latest
 * intent then runs after it, making the final host state deterministic.
 */
export function enqueueLatestNavigation(
    task: (operation: HostNavigationOperation) => Promise<void>,
    onSuperseded?: () => void,
): Promise<void> {
    const epoch = _lifecycleEpoch;
    const id = ++_nextNavigationId;
    _latestNavigationId = id;
    const operation: HostNavigationOperation = {
        id,
        epoch,
        isLatest: () => epoch === _lifecycleEpoch && id === _latestNavigationId,
    };

    return enqueueHostTask(async () => {
        if (!operation.isLatest()) {
            onSuperseded?.();
            return;
        }
        await task(operation);
    }, { onCancelled: () => onSuperseded?.() }).then(() => undefined);
}

/** Deterministic completion boundary for focused operation tests/teardown. */
export function waitForHostOperationsIdle(): Promise<void> {
    return _hostTaskTail;
}
