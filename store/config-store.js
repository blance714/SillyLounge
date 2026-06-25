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
 * Identity-header density for character messages (DESIGN §5.A):
 *   'icon' = avatar + name (+time), 'name' = name (+time) only, 'none' = nothing.
 * @typedef {'icon'|'name'|'none'} MessageHeaderValue
 */

/**
 * @typedef {object} ChatuiConfig
 * @property {SidebarFormValue} sidebarForm
 * @property {MessageHeaderValue} headerGroup Header mode used in group chats.
 * @property {MessageHeaderValue} headerSolo  Header mode used in solo chats.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Canonical ordered list of sidebar forms — the single source of truth for the
 * default value, validation, and the UI cycle order. The matching literal type
 * (SidebarForm) lives in ui/components/sidebar/Sidebar.tsx; keep the two in sync.
 * @type {SidebarFormValue[]}
 */
export const SIDEBAR_FORMS = ['list', 'block', 'icon'];

/**
 * Canonical ordered list of identity-header modes — single source of truth for
 * defaults, validation, and the settings select order.
 * @type {MessageHeaderValue[]}
 */
export const MESSAGE_HEADERS = ['icon', 'name', 'none'];

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * Defaults follow DESIGN §5.A: group chats show avatars (tell characters apart),
 * solo chats stay clean (pure ChatGPT, no header).
 * @type {ChatuiConfig}
 */
const DEFAULT_CONFIG = {
    sidebarForm: SIDEBAR_FORMS[0],
    headerGroup: 'icon',
    headerSolo: 'none',
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
 * Set the identity-header mode for one chat scope. Group and solo chats keep
 * independent settings, so the active mode is chosen per chat type at render.
 * @param {'group'|'solo'} scope
 * @param {MessageHeaderValue} value
 * @returns {void}
 */
export function setMessageHeader(scope, value) {
    setConfigValue(scope === 'group' ? 'headerGroup' : 'headerSolo', value);
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

    /** Coerce a persisted enum value to a known member, else fall back. */
    const pick = (/** @type {string[]} */ allowed, /** @type {unknown} */ raw, /** @type {string} */ fallback) =>
        allowed.includes(/** @type {string} */ (raw)) ? /** @type {any} */ (raw) : fallback;

    /** @type {ChatuiConfig} */
    const normalized = {
        sidebarForm: pick(SIDEBAR_FORMS, persisted.sidebarForm, DEFAULT_CONFIG.sidebarForm),
        headerGroup: pick(MESSAGE_HEADERS, persisted.headerGroup, DEFAULT_CONFIG.headerGroup),
        headerSolo: pick(MESSAGE_HEADERS, persisted.headerSolo, DEFAULT_CONFIG.headerSolo),
    };

    _store.setState(normalized);
}
