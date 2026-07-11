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
import { saveSettingsDebounced, eventSource, event_types } from '@st/script';
import { CHATUI_DISABLE_EVENT } from './store/chat-actions.js';
import { initChatuiStore, teardownChatuiStore } from './store/chat-store.js';
import { initConfigStore } from './store/config-store.js';
import { initTempChatStore } from './store/temp-chat-store.js';
import { initStDomShield, teardownStDomShield } from './shield/st-dom-shield.js';
import { initChatuiRoot, teardownChatuiRoot } from './ui/root.js';
import { finalizePendingCharacterChatDeletion } from './adapter/chats.js';

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
            teardown();
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

    teardown();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

/**
 * Called once on APP_READY: ensure settings, inject UI, auto-enable if opted in.
 *
 * @returns {void}
 */
function init() {
    const settings = getSettings();
    // Hydrate the config store once, eagerly: it backs the always-present settings
    // panel as well as the (conditionally-mounted) Preact root, so it lives for the
    // whole page — intentionally NOT tied to setup()/teardown().
    initConfigStore();
    initTempChatStore();
    injectSettingsUI();
    window.addEventListener(CHATUI_DISABLE_EVENT, disableFromUi);
    if (settings.enabled) {
        const enabledCb = document.getElementById('chatui_enabled') as HTMLInputElement | null;
        setupOrDisable(enabledCb);
    }
    // A current-chat delete reloads before emitting CHAT_DELETED so arbitrary
    // third-party listeners can never observe/save the stale deleted runtime.
    // APP_READY guarantees the replacement chat is now reconstructed.
    void finalizePendingCharacterChatDeletion();
}

// autoFireAfterEmit — APP_READY re-emits to late subscribers, so this is safe.
eventSource.on(event_types.APP_READY, init);
