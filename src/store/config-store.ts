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

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Canonical ordered list of identity-header modes — single source of truth for
 * defaults, validation, and the settings select order.
 * @type {readonly MessageHeaderValue[]}
 */
export const MESSAGE_HEADERS = ['icon', 'name', 'none'] as const;

/**
 * Canonical ordered list of composer line modes — single source for default,
 * validation, and the settings select order.
 * @type {readonly ComposerLinesValue[]}
 */
export const COMPOSER_LINES = ['multi', 'single'] as const;

/**
 * Canonical ordered list of ＋menu tool ids — the single source of truth for which
 * tools exist and their order. The UI (ui/components/PlusMenu) supplies each id's
 * label / icon / behavior; this list owns the id universe used to validate the
 * persisted plusPinned setting. Same contract as the enums above.
 * @type {readonly PlusToolId[]}
 */
export const PLUS_TOOL_IDS = ['photos', 'files', 'continue', 'impersonate', 'regenerate'] as const;

/** Max number of ＋menu tools that can be pinned as top tiles (DESIGN §4.3). */
export const PLUS_PIN_CAP = 4;

// Derived unions stay coupled to the canonical runtime lists above.
export type MessageHeaderValue = (typeof MESSAGE_HEADERS)[number];
export type ComposerLinesValue = (typeof COMPOSER_LINES)[number];
export type PlusToolId = (typeof PLUS_TOOL_IDS)[number];

export type ChatuiConfig = {
    headerGroup: MessageHeaderValue;
    headerSolo: MessageHeaderValue;
    composerLines: ComposerLinesValue;
    plusPinned: PlusToolId[];
    nativeTruncationOverrideEnabled: boolean;
};

const PLUS_TOOL_ID_SET = new Set<string>(PLUS_TOOL_IDS);

function isPlusToolId(value: unknown): value is PlusToolId {
    return typeof value === 'string' && PLUS_TOOL_ID_SET.has(value);
}

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * Defaults follow DESIGN §5.A: group chats show avatars (tell characters apart),
 * solo chats stay clean (pure ChatGPT, no header). Composer defaults to multi-line.
 * @type {ChatuiConfig}
 */
const DEFAULT_CONFIG: ChatuiConfig = {
    headerGroup: 'icon',
    headerSolo: 'none',
    composerLines: 'multi',
    // DESIGN §4.3 defaults to [重生成, 删除], but batch-delete needs ChatUI's own
    // message-selection UI (ST's delete mode checkboxes live in the parked #chat),
    // so 续写 stands in until that lands.
    plusPinned: ['regenerate', 'continue'],
    // Gates adapter/native-window-guard.ts's power_user.chat_truncation=1
    // override (DOM-DECOUPLING.md 停用恢复 row, 2026-07-19 拍板). Defaults ON
    // since 2026-07-19: all three decoupling tiers shipped (every message
    // action works without the native .mes row), the disable-reload round
    // trip and crash self-heal passed real-browser acceptance
    // (test:e2e:guard), and the measured payoff is -22% chat-switch
    // content-ready with switch long-tasks eliminated (PERFORMANCE.md
    // 2026-07-19 真实 flag 性能验收).
    nativeTruncationOverrideEnabled: true,
};

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
 * @returns {PlusToolId[]}
 */
function normalizePlusPinned(raw: unknown): PlusToolId[] {
    if (!Array.isArray(raw)) return [...DEFAULT_CONFIG.plusPinned];

    const seen = new Set<PlusToolId>();
    const out: PlusToolId[] = [];
    for (const id of raw) {
        if (!isPlusToolId(id)) continue;
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
export function subscribeConfig(fn: (config: ChatuiConfig) => void) {
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
export function setConfigValue<K extends keyof ChatuiConfig>(key: K, value: ChatuiConfig[K]) {
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
export function setMessageHeader(scope: 'group' | 'solo', value: MessageHeaderValue) {
    setConfigValue(scope === 'group' ? 'headerGroup' : 'headerSolo', value);
}

/**
 * Set the composer line mode ('multi' | 'single').
 * @param {ComposerLinesValue} value
 * @returns {void}
 */
export function setComposerLines(value: ComposerLinesValue) {
    setConfigValue('composerLines', value);
}

/**
 * Set the ＋menu pinned tool ids (DESIGN §4.3 ① 置顶磁贴). The pin editor that
 * will call this is deferred to the §7 config surface; exported now to keep the
 * per-key setter API symmetric.
 * @param {string[]} ids
 * @returns {void}
 */
export function setPlusPinned(ids: string[]) {
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
    const pick = <T extends string>(allowed: readonly T[], raw: unknown, fallback: T): T =>
        typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? raw as T : fallback;

    const normalized: ChatuiConfig = {
        headerGroup: pick(MESSAGE_HEADERS, persisted.headerGroup, DEFAULT_CONFIG.headerGroup),
        headerSolo: pick(MESSAGE_HEADERS, persisted.headerSolo, DEFAULT_CONFIG.headerSolo),
        composerLines: pick(COMPOSER_LINES, persisted.composerLines, DEFAULT_CONFIG.composerLines),
        plusPinned: normalizePlusPinned(persisted.plusPinned),
        nativeTruncationOverrideEnabled: typeof persisted.nativeTruncationOverrideEnabled === 'boolean'
            ? persisted.nativeTruncationOverrideEnabled
            : DEFAULT_CONFIG.nativeTruncationOverrideEnabled,
    };

    _store.setState(normalized);
}
