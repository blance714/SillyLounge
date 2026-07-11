/**
 * Small dependency-free bounded work coordinator.
 *
 * A duplicate arriving while work is queued is already covered by that future
 * run. A duplicate arriving after the run starts marks it dirty and schedules
 * exactly one follow-up. This is the concurrency contract used by sidebar Query
 * refetches, extracted from the hook so it can be tested without Preact/ST.
 */

export type BoundedWork = Readonly<{
    key: string;
    run: () => Promise<unknown>;
}>;

export type BoundedWorkCoordinator = Readonly<{
    enqueue: (work: BoundedWork) => boolean;
    dispose: () => void;
    waitForIdle: () => Promise<void>;
}>;

export function createBoundedWorkCoordinator(
    concurrency: number,
    onError: (error: unknown, work: BoundedWork) => void = () => undefined,
): BoundedWorkCoordinator {
    const limit = Math.max(1, Math.floor(concurrency));
    const queue: BoundedWork[] = [];
    const known = new Set<string>();
    const active = new Set<string>();
    const dirty = new Set<string>();
    const idleWaiters = new Set<() => void>();
    let activeCount = 0;
    let disposed = false;

    const resolveIdle = () => {
        if (queue.length > 0 || activeCount > 0) return;
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
    };

    const pump = () => {
        if (disposed) {
            resolveIdle();
            return;
        }
        while (activeCount < limit && queue.length > 0) {
            const work = queue.shift();
            if (!work) break;
            activeCount += 1;
            active.add(work.key);
            void Promise.resolve()
                .then(work.run)
                .catch(error => onError(error, work))
                .finally(() => {
                    active.delete(work.key);
                    activeCount -= 1;
                    if (!disposed && dirty.delete(work.key)) {
                        queue.push(work);
                    } else {
                        known.delete(work.key);
                    }
                    pump();
                    resolveIdle();
                });
        }
        resolveIdle();
    };

    return Object.freeze({
        enqueue(work: BoundedWork): boolean {
            if (disposed || !work.key) return false;
            if (active.has(work.key)) {
                dirty.add(work.key);
                return false;
            }
            if (known.has(work.key)) return false;
            known.add(work.key);
            queue.push(work);
            pump();
            return true;
        },
        dispose(): void {
            disposed = true;
            queue.length = 0;
            known.clear();
            dirty.clear();
            resolveIdle();
        },
        waitForIdle(): Promise<void> {
            if (queue.length === 0 && activeCount === 0) return Promise.resolve();
            return new Promise(resolve => idleWaiters.add(resolve));
        },
    });
}
