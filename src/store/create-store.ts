/**
 * SillyTavern-ChatUI · shared store primitive
 *
 * Tiny observable state holder for UI-facing stores.
 */

export type Store<T> = {
    getState: () => T;
    setState: (nextState: T) => void;
    subscribe: (subscriber: (state: T) => void) => () => void;
};

export function createStore<T>(initialState: T): Store<T> {
    let state = initialState;
    const subscribers = new Set<(state: T) => void>();

    return {
        getState(): T {
            return state;
        },
        setState(nextState: T): void {
            state = nextState;
            for (const subscriber of subscribers) {
                subscriber(state);
            }
        },
        subscribe(subscriber: (state: T) => void): () => void {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
        },
    };
}
