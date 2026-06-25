/**
 * SillyTavern-ChatUI · config store
 *
 * Thin persistent config layer backed by ST extension_settings (via adapter).
 * Currently tracks exactly one feature: sidebarForm — so the sidebar keeps its
 * last form ('list' | 'block' | 'icon') across page reloads.
 *
 * Shape is intentionally minimal. New config keys should be added here, never
 * directly to other stores.
 */

import { chatuiAdapter } from '../adapter/st-adapter.js';
import { createStore } from './create-store.js';

// ── Types (JSDoc) ─────────────────────────────────────────────────────────────

/**
 * @typedef {'list'|'block'|'icon'} SidebarFormValue
 */

/**
 * @typedef {object} ChatuiConfig
 * @property {SidebarFormValue} sidebarForm
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Canonical ordered list of sidebar forms — the single source of truth for the
 * default value, validation, and the UI cycle order. The matching literal type
 * (SidebarForm) lives in ui/components/sidebar/Sidebar.tsx; keep the two in sync.
 * @type {SidebarFormValue[]}
 */
export const SIDEBAR_FORMS = ['list', 'block', 'icon'];

// ── Store ─────────────────────────────────────────────────────────────────────

/** @type {ChatuiConfig} */
const DEFAULT_CONFIG = {
    sidebarForm: SIDEBAR_FORMS[0],
};

/** @type {ReturnType<typeof createStore<ChatuiConfig>>} */
const _store = createStore(DEFAULT_CONFIG);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @returns {ChatuiConfig}
 */
export function getConfig() {
    return _store.getState();
}

/**
 * @param {(config: ChatuiConfig) => void} fn
 * @returns {() => void} Unsubscribe function.
 */
export function subscribeConfig(fn) {
    return _store.subscribe(fn);
}

/**
 * Set a single config value, update the store, and persist immediately.
 *
 * @template {keyof ChatuiConfig} K
 * @param {K} key
 * @param {ChatuiConfig[K]} value
 * @returns {void}
 */
export function setConfigValue(key, value) {
    const next = { ...getConfig(), [key]: value };
    _store.setState(next);
    chatuiAdapter.configActions.write(next);
}

/**
 * Set the sidebar form directly (e.g. the hamburger always summons 'list').
 * @param {SidebarFormValue} form
 * @returns {void}
 */
export function setSidebarForm(form) {
    setConfigValue('sidebarForm', form);
}

/**
 * Advance the sidebar form to the next in SIDEBAR_FORMS order, reading the
 * freshest persisted value (not a captured render value) so rapid cycles never
 * drop a step.
 * @returns {void}
 */
export function cycleSidebarForm() {
    const current = getConfig().sidebarForm;
    const next = SIDEBAR_FORMS[(SIDEBAR_FORMS.indexOf(current) + 1) % SIDEBAR_FORMS.length];
    setConfigValue('sidebarForm', next);
}

/**
 * Load the persisted config from ST extension_settings (via adapter), normalise
 * it against DEFAULT_CONFIG (drop unknown keys, fill missing, coerce invalid
 * enum values to their defaults), and push the result into the store.
 *
 * Idempotent: safe to call multiple times.
 *
 * @returns {void}
 */
export function initConfigStore() {
    const persisted = chatuiAdapter.configActions.read();

    /** @type {SidebarFormValue} */
    const rawForm = /** @type {any} */ (persisted.sidebarForm);
    const sidebarForm = SIDEBAR_FORMS.includes(rawForm) ? rawForm : DEFAULT_CONFIG.sidebarForm;

    /** @type {ChatuiConfig} */
    const normalized = {
        sidebarForm,
    };

    _store.setState(normalized);
}
