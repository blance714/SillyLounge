/**
 * SillyTavern-ChatUI · index.js
 *
 * Extension entry point. Owns the enable toggle + settings UI and orchestrates
 * the ChatUI architecture layers:
 *
 *   ST DOM Shield  →  ChatUI Store  →  ChatUI Root (Preact)
 *
 * SillyTavern keeps owning runtime (persistence, generation, native DOM). The
 * shield parks the native #chat / #send_form surfaces and promotes #chatui-root
 * as the visible chat surface; the store exposes DTOs; the Preact root renders.
 */

import { extension_settings } from '@st/extensions';
import { saveSettings, saveSettingsDebounced, eventSource, event_types } from '@st/script';
import { CHATUI_DISABLE_EVENT } from './store/chat-actions.js';
import { initChatuiStore, teardownChatuiStore } from './store/chat-store.js';
import { getConfig, initConfigStore } from './store/config-store.js';
import { initTempChatStore } from './store/temp-chat-store.js';
import { enqueueHostTask, sealHostOperationQueueForReload } from './store/host-operation-queue.js';
import { finalizeChatuiDraftQuarantine } from './store/sidebar-actions.js';
import { initStDomShield, teardownStDomShield } from './shield/st-dom-shield.js';
import { initChatuiRoot, teardownChatuiRoot } from './ui/root.js';
import { finalizePendingCharacterChatDeletion } from './adapter/chats.js';
import {
    activateNativeTruncationGuard,
    isNativeTruncationGuardLive,
    restoreForDisable as restoreNativeTruncationForDisable,
    selfHealNativeTruncation,
} from './adapter/native-window-guard.js';

// ── Module constants ──────────────────────────────────────────────────────────

/** Settings namespace key. */
const MODULE = 'chatui_composer';

/**
 * Default settings. ChatUI owns only the master `enabled` toggle here; all
 * per-feature config lives in (and is normalised by) store/config-store.js.
 * @type {{ enabled: boolean }}
 */
const defaultSettings = {
    enabled: false,
};

// ── Internal state ────────────────────────────────────────────────────────────

/** @type {boolean} */
let isSetup = false;
let isSettingUp = false;

// ── Settings ──────────────────────────────────────────────────────────────────

/**
 * Ensures extension_settings[MODULE] exists and the `enabled` flag is well-formed.
 * The per-feature `config` slice in the same namespace is owned and normalised by
 * store/config-store.js (via the adapter), not here.
 *
 * @returns {{ enabled: boolean }} Live settings object.
 */
function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(defaultSettings);
    }

    const s = extension_settings[MODULE];
    if (typeof s.enabled !== 'boolean') s.enabled = defaultSettings.enabled;

    return s;
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

/**
 * Run every teardown even if an earlier one fails. Restoring the native ST
 * surface is deliberately first, so a broken ChatUI can never strand the page
 * behind its shield.
 */
function cleanupLifecycle(phase: 'rollback' | 'teardown') {
    const cleanups = [
        ['DOM shield', teardownStDomShield],
        ['Preact root', teardownChatuiRoot],
        ['chat store', teardownChatuiStore],
    ] as const;

    for (const [label, cleanup] of cleanups) {
        try {
            cleanup();
        } catch (error) {
            console.error(`[ChatUI] ${phase} failed for ${label}`, error);
        }
    }
}

/**
 * Activate ChatUI transactionally. Store and root health are established before
 * the DOM shield commits the visible switch; any failure rolls every layer back.
 *
 * @returns {void}
 */
function setup() {
    if (isSetup || isSettingUp) return;

    isSettingUp = true;
    try {
        initChatuiStore();
        initChatuiRoot();
        initStDomShield();
        // Only force ST's native chat_truncation once the full replacement UI
        // is confirmed live (all three layers above succeeded) — see
        // adapter/native-window-guard.ts's module doc for why the override
        // itself is gated behind a config flag that defaults ON.
        activateNativeTruncationGuard(getConfig().nativeTruncationOverrideEnabled);

        isSetup = true;
    } catch (error) {
        isSetup = false;
        cleanupLifecycle('rollback');
        throw error;
    } finally {
        isSettingUp = false;
    }
}

/**
 * Deactivate ChatUI. This intentionally repairs every layer even when the
 * committed flag is false, so teardown also heals a partially-failed setup.
 *
 * @returns {void}
 */
function teardown() {
    isSetup = false;
    cleanupLifecycle('teardown');
}

/**
 * Disable ChatUI. When the native-truncation guard is actually live *this
 * session* (DOM-DECOUPLING.md 停用恢复 row), an in-place teardown() is not
 * enough: `power_user.chat_truncation` still sits at the override sentinel
 * in memory, and it may already have been flushed into the user's
 * persisted settings by some unrelated ST saveSettingsDebounced() call.
 * Restore the real value, persist it, and hard-reload through the exact
 * same terminal reloadRequired machinery the sidebar chat transactions use
 * (store/host-operation-queue.ts's sealHostOperationQueueForReload +
 * enqueueHostTask — see store/sidebar-actions.ts's deleteChatuiChat), so the
 * restore-then-reload only runs once every in-flight host operation has
 * drained, and every module-level ChatUI singleton also resets cleanly on
 * reload instead of needing its own manual rollback.
 *
 * MUST await a real, non-debounced `saveSettings()` (script.js's own
 * unwrapped save, not `saveSettingsDebounced()`) between the restore and the
 * reload. `saveSettingsDebounced()` — called both by the `settings.enabled =
 * false` write above this function's callers and by
 * restoreForDisable()'s internal clearBackup() — is a single shared,
 * cancel-and-reset timer (SillyTavern/public/scripts/utils.js's `debounce()`:
 * every call clears and re-arms the *same* timeout). `window.location.reload()`
 * tears down this page's JS context well before that timer's
 * debounce_timeout.relaxed (1000ms) window can ever elapse, so without a
 * forced flush here, this exact click reliably (not just occasionally) loses
 * *both* writes: the persisted `settings.enabled` stays `true` and
 * `power_user.chat_truncation`/the backup stay at their pre-restore values on
 * disk. The very next boot then reads `enabled: true` off disk, reactivates
 * ChatUI (and the truncation guard) all over again before SillyTavern's own
 * fire-and-forget boot print (RA_autoloadchat → printMessages) gets a chance
 * to run against the restored value — so the native chat window stays pinned
 * at the truncation sentinel indefinitely, since nothing ever prints again to
 * pick up a later in-memory fix. (Confirmed via
 * scripts/e2e/verify-truncation-guard.mjs's scenario A + instrumented disk/DOM
 * polling across a real disable-reload: disk settings never moved off their
 * pre-disable values for the entire observation window, and `#chat` stayed
 * stuck at the sentinel count.) Awaiting the real save turns "the reload
 * usually beats the debounce" into "the reload only ever runs once the write
 * actually landed" — the same guarantee this codebase's other reload paths
 * already get for free from their own awaited server round trip (e.g.
 * store/sidebar-actions.ts's current-chat delete awaits the delete API call
 * before reloading). Boot self-heal (selfHealNativeTruncation(), called
 * unconditionally at the top of init()) remains as a defense-in-depth
 * backstop for cases the awaited save itself can't cover (e.g. the tab
 * crashing mid-request), not as the primary mechanism for the ordinary click
 * path.
 *
 * Branches on `isNativeTruncationGuardLive()` — whether
 * activateNativeTruncationGuard() actually applied the override this
 * session — rather than on `getConfig().nativeTruncationOverrideEnabled`
 * (the config flag's *current* value). The flag has no live UI toggle yet,
 * but once one exists, flipping it off mid-session must not divert this
 * path away from a still-live override with no restore attempt and no
 * reload; session state, not the flag, is what actually determines whether
 * `power_user.chat_truncation` needs restoring.
 *
 * When the guard was never live this session, nothing native was ever
 * touched: the existing in-place teardown() (no reload) is unchanged, and
 * no forced flush is needed — no reload races it.
 *
 * @returns {void}
 */
function disableChatuiLayers(): void {
    if (!isNativeTruncationGuardLive()) {
        teardown();
        return;
    }
    enqueueHostTask(async () => {
        restoreNativeTruncationForDisable();
        await saveSettings();
        sealHostOperationQueueForReload();
        window.location.reload();
    });
}

/** Keep the persisted toggle honest when activation cannot be completed. */
function setupOrDisable(enabledCb?: HTMLInputElement | null): boolean {
    try {
        setup();
        return true;
    } catch (error) {
        console.error('[ChatUI] setup failed; ChatUI has been disabled', error);
        const settings = getSettings();
        settings.enabled = false;
        saveSettingsDebounced();
        if (enabledCb) enabledCb.checked = false;
        return false;
    }
}

// ── Settings UI ───────────────────────────────────────────────────────────────

/**
 * Injects a collapsible settings panel into #extensions_settings2.
 * Mirrors the inline-drawer pattern used by other ST extensions.
 *
 * @returns {void}
 */
function injectSettingsUI() {
    const container = document.getElementById('extensions_settings2');
    if (!container) {
        console.warn('[ChatUI] #extensions_settings2 not found, skipping settings UI');
        return;
    }

    // Prevent double-injection if init() runs twice.
    if (document.getElementById('chatui-settings-drawer')) return;

    const s = getSettings();

    const wrapper = document.createElement('div');
    wrapper.className = 'extension_container';
    wrapper.innerHTML = `
        <div id="chatui-settings-drawer" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>ChatUI</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="chatui_enabled" title="启用 / 禁用 ChatUI 界面">
                    <input id="chatui_enabled" type="checkbox" class="checkbox"${s.enabled ? ' checked' : ''}>
                    <span>启用 ChatUI</span>
                </label>
                <div class="margin-bot-10px"></div>
                <small class="opacity50p">界面 / 消息 / 输入框等设置已移入 ChatUI 内的「ChatUI 设置」面板。</small>
            </div>
        </div>
    `;

    container.appendChild(wrapper);

    // Inline-drawer chevron toggle (we build the markup ourselves, so wire it manually).
    const drawerToggle = wrapper.querySelector('.inline-drawer-toggle');
    const drawerContent = wrapper.querySelector('.inline-drawer-content') as HTMLElement | null;
    const drawerIcon = wrapper.querySelector('.inline-drawer-icon');

    if (drawerToggle && drawerContent && drawerIcon) {
        drawerToggle.addEventListener('click', () => {
            const isOpen = drawerIcon.classList.contains('up');
            drawerIcon.classList.toggle('up', !isOpen);
            drawerIcon.classList.toggle('down', isOpen);
            drawerContent.style.display = isOpen ? 'none' : '';
        });
        // Start collapsed (ST convention).
        drawerContent.style.display = 'none';
    }

    // Enable toggle drives setup/teardown. The per-feature config (sidebar form,
    // message headers, composer lines, ＋menu pins) now lives in the in-app ChatUI
    // settings panel (ui/components/config/ConfigPanel) — this native drawer keeps
    // only the master enable toggle, the bootstrap that must exist while ChatUI is off.
    const enabledCb = document.getElementById('chatui_enabled') as HTMLInputElement | null;
    if (!enabledCb) return;
    enabledCb.addEventListener('change', () => {
        const settings = getSettings();
        settings.enabled = enabledCb.checked;
        saveSettingsDebounced();
        if (settings.enabled) {
            setupOrDisable(enabledCb);
        } else {
            disableChatuiLayers();
        }
    });
}

/**
 * Handles CHATUI_DISABLE_EVENT (dispatched by the in-app "关闭 ChatUI" settings
 * button — see store/chat-actions.js disableChatui()). Mirrors exactly what
 * the native #chatui_enabled checkbox's own change handler does, including
 * syncing that checkbox's visual state, so the native settings drawer stays
 * consistent with reality if the user ever opens it.
 *
 * @returns {void}
 */
function disableFromUi() {
    const settings = getSettings();
    if (!settings.enabled) return;

    settings.enabled = false;
    saveSettingsDebounced();

    const enabledCb = document.getElementById('chatui_enabled') as HTMLInputElement | null;
    if (enabledCb) enabledCb.checked = false;

    disableChatuiLayers();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

/**
 * Called once on APP_READY: ensure settings, inject UI, auto-enable if opted in.
 *
 * @returns {void}
 */
function init() {
    // Must run before anything else, in EVERY mode — including bootstrap
    // (settings.enabled === false below) and regardless of this session's
    // nativeTruncationOverrideEnabled flag. A previous session's crash or
    // force-closed tab can leave ST's native chat_truncation permanently
    // pinned at the override sentinel in the user's own persisted settings
    // even though that session's flag/enabled state has since changed — see
    // adapter/native-window-guard.ts's module doc for the exact signature
    // this repairs.
    selfHealNativeTruncation();

    const settings = getSettings();
    // Hydrate the config store once, eagerly: it backs the always-present settings
    // panel as well as the (conditionally-mounted) Preact root, so it lives for the
    // whole page — intentionally NOT tied to setup()/teardown().
    initConfigStore();
    initTempChatStore();
    injectSettingsUI();
    window.addEventListener(CHATUI_DISABLE_EVENT, disableFromUi);
    // Second handoff of the reload a current-chat delete forces: if that delete
    // emptied the character's whole history, ST's boot is materializing a
    // fallback file this session (not settings.enabled) needs to fold into the
    // draft quarantine regardless of whether the ChatUI UI is currently on.
    // Deliberately not "has materialized": that file lands *after* APP_READY on
    // a chain this event does not wait for, so the call below arms and watches
    // rather than checks — see sidebar-actions.ts's
    // finalizeChatuiDraftQuarantine doc comment.
    //
    // Ahead of the mount on purpose. Its synchronous half decides the fate of
    // the `sessionStorage` credential — claim it for this page, or expire one a
    // previous page already claimed — and the spine reads that same credential
    // during render as one of its membership sources (ui/spine-cast.ts). A
    // `sessionStorage` record notifies nobody, so a first render that observed
    // an expired credential would seat a character with nothing to its name for
    // the rest of the session: the memo has no reason to run again, because the
    // expiry touches neither the cast nor the lease store. Settling it first
    // makes the reactivity argument in useSpineCharacters true rather than
    // nearly true — after this line the only thing that can still clear the
    // credential is the commit that puts a lease in its place, and that does
    // notify. The landing it may start is async and does not delay the mount.
    finalizeChatuiDraftQuarantine();
    if (settings.enabled) {
        const enabledCb = document.getElementById('chatui_enabled') as HTMLInputElement | null;
        setupOrDisable(enabledCb);
    }
    // A current-chat delete reloads before emitting CHAT_DELETED so arbitrary
    // third-party listeners can never observe/save the stale deleted runtime.
    // APP_READY guarantees the replacement chat is now reconstructed. Kept
    // after the mount: this one emits into ST's event bus for *listeners*, and
    // ChatUI's own UI is one of them.
    void finalizePendingCharacterChatDeletion();
}

// autoFireAfterEmit — APP_READY re-emits to late subscribers, so this is safe.
eventSource.on(event_types.APP_READY, init);
