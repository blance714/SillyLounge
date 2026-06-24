/**
 * SillyTavern-ChatUI · shared store primitive
 *
 * Tiny observable state holder for UI-facing stores.
 */

/**
 * @template T
 * @param {T} initialState
 * @returns {{ getState: () => T, setState: (nextState: T) => void, subscribe: (subscriber: (state: T) => void) => () => void }}
 */
export function createStore(initialState) {
    let state = initialState;
    /** @type {Set<(state: T) => void>} */
    const subscribers = new Set();

    return {
        getState() {
            return state;
        },
        setState(nextState) {
            state = nextState;
            for (const subscriber of subscribers) {
                subscriber(state);
            }
        },
        subscribe(subscriber) {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
        },
    };
}
