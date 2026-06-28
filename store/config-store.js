/**
 * SillyTavern-ChatUI · config store
 *
 * Thin persistent config layer backed by ST extension_settings (via adapter).
 * Tracks visual/UX preferences that survive page reloads.
 *
 * Shape is intentionally minimal. New config keys should be added here, never
 * directly to other stores.
 */

import { chatuiAdapter } from '../adapter/st-adapter.js';
import { createStore } from './create-store.js';

// ── Types (JSDoc) ─────────────────────────────────────────────────────────────

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
 * @property {MessageHeaderValue} headerGroup Header mode used in group chats.
 * @property {MessageHeaderValue} headerSolo  Header mode used in solo chats.
 * @property {ComposerLinesValue} composerLines Composer single/multi-line mode.
 * @property {string[]} plusPinned ＋menu tool ids promoted to top tiles (DESIGN §4.3).
 */

// ── Constants ─────────────────────────────────────────────────────────────────

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

/**
 * Canonical ordered list of ＋menu tool ids — the single source of truth for which
 * tools exist and their order. The UI (ui/components/PlusMenu) supplies each id's
 * label / icon / behavior; this list owns the id universe used to validate the
 * persisted plusPinned setting. Same contract as the enums above.
 * @type {string[]}
 */
export const PLUS_TOOL_IDS = ['photos', 'files', 'continue', 'impersonate', 'regenerate'];

/** Max number of ＋menu tools that can be pinned as top tiles (DESIGN §4.3). */
export const PLUS_PIN_CAP = 4;

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * Defaults follow DESIGN §5.A: group chats show avatars (tell characters apart),
 * solo chats stay clean (pure ChatGPT, no header). Composer defaults to multi-line.
 * @type {ChatuiConfig}
 */
const DEFAULT_CONFIG = {
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

/**
 * Normalize a raw plusPinned list to the persistence invariant: keep only known
 * tool ids (PLUS_TOOL_IDS), de-duplicated, in first-seen order, capped at
 * PLUS_PIN_CAP. Every read (initConfigStore) and write (setPlusPinned) funnels
 * through here, so stale / corrupt persisted ids can never desync the ＋menu tiles
 * from the pin editor's cap count (which would otherwise lock the editor — a list
 * of N unknown ids reads as "cap full" yet shows zero pinned tiles, with no UI
 * path to repair it). A non-array falls back to the default; an array that filters
 * empty stays empty (a valid, recoverable "nothing pinned" state).
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizePlusPinned(raw) {
    if (!Array.isArray(raw)) return [...DEFAULT_CONFIG.plusPinned];

    const seen = new Set();
    const out = [];
    for (const id of raw) {
        if (typeof id !== 'string') continue;
        if (!PLUS_TOOL_IDS.includes(id)) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        if (out.length >= PLUS_PIN_CAP) break;
    }
    return out;
}

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
    setConfigValue('plusPinned', normalizePlusPinned(ids));
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
        headerGroup: pick(MESSAGE_HEADERS, persisted.headerGroup, DEFAULT_CONFIG.headerGroup),
        headerSolo: pick(MESSAGE_HEADERS, persisted.headerSolo, DEFAULT_CONFIG.headerSolo),
        composerLines: pick(COMPOSER_LINES, persisted.composerLines, DEFAULT_CONFIG.composerLines),
        plusPinned: normalizePlusPinned(persisted.plusPinned),
    };

    _store.setState(normalized);
}
