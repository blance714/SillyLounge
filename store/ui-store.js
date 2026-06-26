/**
 * SillyTavern-ChatUI · ephemeral UI store
 *
 * Session-local view state that no other store owns and that is deliberately
 * NOT persisted: it never touches the adapter / extension_settings. Currently
 * one flag — whether the ChatUI-native settings panel (独立配置面) is open.
 *
 * The open trigger (sidebar config rail) and the panel (a sibling of <Sidebar/>)
 * live in different render subtrees, so the state is held here rather than lifted
 * into ChatuiApp — decoupled, no prop-drilling, and ready for future entry points
 * (e.g. a topbar gear).
 */

import { createStore } from './create-store.js';

/**
 * @typedef {object} ChatuiUiState
 * @property {boolean} settingsPanelOpen Whether the settings panel is open.
 */

/** @type {ChatuiUiState} */
const INITIAL_STATE = {
    settingsPanelOpen: false,
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
 * Open the settings panel. No-op (skips notifying subscribers) if already open.
 * @returns {void}
 */
export function openSettingsPanel() {
    if (_store.getState().settingsPanelOpen) return;
    _store.setState({ ..._store.getState(), settingsPanelOpen: true });
}

/**
 * Close the settings panel. No-op if already closed. Called both from the panel
 * itself (✕ / Escape) and from teardown so a re-mount starts clean.
 * @returns {void}
 */
export function closeSettingsPanel() {
    if (!_store.getState().settingsPanelOpen) return;
    _store.setState({ ..._store.getState(), settingsPanelOpen: false });
}
