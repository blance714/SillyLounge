/**
 * SillyTavern-ChatUI · ephemeral UI store
 *
 * Session-local view state that no other store owns and that is deliberately
 * NOT persisted: it never touches the adapter / extension_settings.
 * Tracks whether the app is in settings mode and which entry is active.
 *
 * The SettingsEntry button (sidebar bottom) and the two-pane
 * settings layout live in different render subtrees, so the state is held here
 * rather than lifted — decoupled, no prop-drilling.
 */

import { createStore } from './create-store.js';

/**
 * @typedef {object} ChatuiUiState
 * @property {boolean} settingsOpen Whether the app is in settings mode.
 * @property {string|null} activeSettingsId The active settings entry id, or null if none selected.
 */

/** @type {ChatuiUiState} */
const INITIAL_STATE = {
    settingsOpen: false,
    activeSettingsId: null,
};

/** @type {ReturnType<typeof createStore<ChatuiUiState>>} */
const _store = createStore(INITIAL_STATE);

/**
 * @returns {ChatuiUiState}
 */
export function getUiState() {
    return _store.getState();
}

/**
 * @param {(state: ChatuiUiState) => void} fn
 * @returns {() => void} Unsubscribe function.
 */
export function subscribeUiStore(fn) {
    return _store.subscribe(fn);
}

/**
 * Enter settings mode. Optionally pre-select an entry by id.
 * Defaults to 'st:left-nav-panel' if no id is given and none was previously active.
 * No-op (skips notification) if already open AND id is unchanged.
 * @param {string} [id]
 * @returns {void}
 */
export function openSettings(id) {
    const s = _store.getState();
    const nextId = id ?? s.activeSettingsId ?? 'st:left-nav-panel';
    if (s.settingsOpen && s.activeSettingsId === nextId) return;
    _store.setState({ settingsOpen: true, activeSettingsId: nextId });
}

/**
 * Leave settings mode. Preserves activeSettingsId so re-opening lands on the
 * last selection. No-op if already closed.
 * @returns {void}
 */
export function closeSettings() {
    if (!_store.getState().settingsOpen) return;
    _store.setState({ ..._store.getState(), settingsOpen: false });
}

/**
 * Change the active entry without toggling mode. No-op if settings is not open.
 * @param {string} id
 * @returns {void}
 */
export function setActiveSettings(id) {
    if (!_store.getState().settingsOpen) return;
    if (_store.getState().activeSettingsId === id) return;
    _store.setState({ ..._store.getState(), activeSettingsId: id });
}
