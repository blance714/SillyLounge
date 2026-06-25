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
 * Composer line mode (DESIGN §4.2):
 *   'multi'  = tall auto-growing textarea, selector B on its own row below;
 *   'single' = compact one-line input, selector B relocated into the ＋ menu top.
 * @typedef {'multi'|'single'} ComposerLinesValue
 */

/**
 * @typedef {object} ChatuiConfig
 * @property {SidebarFormValue} sidebarForm
 * @property {MessageHeaderValue} headerGroup Header mode used in group chats.
 * @property {MessageHeaderValue} headerSolo  Header mode used in solo chats.
 * @property {ComposerLinesValue} composerLines Composer single/multi-line mode.
 * @property {string[]} plusPinned ＋menu tool ids promoted to top tiles (DESIGN §4.3).
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

/**
 * Canonical ordered list of composer line modes — single source for default,
 * validation, and the settings select order.
 * @type {ComposerLinesValue[]}
 */
export const COMPOSER_LINES = ['multi', 'single'];

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * Defaults follow DESIGN §5.A: group chats show avatars (tell characters apart),
 * solo chats stay clean (pure ChatGPT, no header). Composer defaults to multi-line.
 * @type {ChatuiConfig}
 */
const DEFAULT_CONFIG = {
    sidebarForm: SIDEBAR_FORMS[0],
    headerGroup: 'icon',
    headerSolo: 'none',
    composerLines: 'multi',
    // DESIGN §4.3 defaults to [重生成, 删除], but batch-delete needs ChatUI's own
    // message-selection UI (ST's delete mode checkboxes live in the parked #chat),
    // so 续写 stands in until that lands.
    plusPinned: ['regenerate', 'continue'],
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
 * Set the composer line mode ('multi' | 'single').
 * @param {ComposerLinesValue} value
 * @returns {void}
 */
export function setComposerLines(value) {
    setConfigValue('composerLines', value);
}

/**
 * Set the ＋menu pinned tool ids (DESIGN §4.3 ① 置顶磁贴). The pin editor that
 * will call this is deferred to the §7 config surface; exported now to keep the
 * per-key setter API symmetric.
 * @param {string[]} ids
 * @returns {void}
 */
export function setPlusPinned(ids) {
    setConfigValue('plusPinned', ids);
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

    const rawPinned = persisted.plusPinned;
    const plusPinned = Array.isArray(rawPinned)
        ? rawPinned.filter(id => typeof id === 'string')
        : DEFAULT_CONFIG.plusPinned;

    /** @type {ChatuiConfig} */
    const normalized = {
        sidebarForm: pick(SIDEBAR_FORMS, persisted.sidebarForm, DEFAULT_CONFIG.sidebarForm),
        headerGroup: pick(MESSAGE_HEADERS, persisted.headerGroup, DEFAULT_CONFIG.headerGroup),
        headerSolo: pick(MESSAGE_HEADERS, persisted.headerSolo, DEFAULT_CONFIG.headerSolo),
        composerLines: pick(COMPOSER_LINES, persisted.composerLines, DEFAULT_CONFIG.composerLines),
        plusPinned,
    };

    _store.setState(normalized);
}
