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

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { initChatuiStore, teardownChatuiStore } from './store/chat-store.js';
import { initSidebarStore, teardownSidebarStore } from './store/sidebar-store.js';
import { initConfigStore, getConfig, setSidebarForm, setMessageHeader, subscribeConfig, SIDEBAR_FORMS, MESSAGE_HEADERS } from './store/config-store.js';
import { initStDomShield, teardownStDomShield } from './shield/st-dom-shield.js';
import { initChatuiRoot, teardownChatuiRoot } from './ui/root.js';

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

/** Sidebar-form option labels for the settings select (values come from SIDEBAR_FORMS). */
const SIDEBAR_FORM_LABELS = { list: '列表', block: '方块', icon: '纯图标' };

/** Identity-header option labels for the settings selects (values come from MESSAGE_HEADERS). */
const MESSAGE_HEADER_LABELS = { icon: '头像 + 名字', name: '仅名字', none: '无（纯净）' };

// ── Internal state ────────────────────────────────────────────────────────────

/** @type {boolean} */
let isSetup = false;

// ── Settings UI helpers ─────────────────────────────────────────────────────────

/**
 * Build `<option>` markup from an ordered value list and a label map. Values are
 * the canonical store enums; the rendered text is the localized label.
 *
 * @param {string[]} values
 * @param {Record<string, string>} labels
 * @returns {string}
 */
function optionsHtml(values, labels) {
    return values.map(v => `<option value="${v}">${labels[v]}</option>`).join('');
}

/**
 * Wire a settings `<select>` to a config value, two-way: seed it, persist on
 * change, and re-sync when the value changes elsewhere. The panel lives for the
 * whole page, so the subscription is intentionally never torn down.
 *
 * @param {string} selectId
 * @param {() => string} read  Current persisted value.
 * @param {(value: string) => void} write  Persist a new value.
 * @returns {void}
 */
function bindConfigSelect(selectId, read, write) {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById(selectId));
    if (!select) return;
    select.value = read();
    select.addEventListener('change', () => write(select.value));
    subscribeConfig(() => { select.value = read(); });
}

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
 * Activate ChatUI: mount shield, store, and Preact root. Idempotent.
 *
 * @returns {void}
 */
function setup() {
    if (isSetup) return;

    initStDomShield();
    initChatuiStore();
    initSidebarStore();
    initChatuiRoot();

    isSetup = true;
}

/**
 * Deactivate ChatUI: tear down in reverse order so the Preact app unmounts
 * before the shield removes #chatui-root. Idempotent.
 *
 * @returns {void}
 */
function teardown() {
    if (!isSetup) return;

    teardownChatuiRoot();
    teardownSidebarStore();
    teardownChatuiStore();
    teardownStDomShield();

    isSetup = false;
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
                <label class="checkbox_label" for="chatui_sidebar_form" title="侧边栏默认展示形式">
                    <span>侧边栏形式</span>
                </label>
                <select id="chatui_sidebar_form" class="text_pole" style="margin-bottom:8px">
                    ${optionsHtml(SIDEBAR_FORMS, SIDEBAR_FORM_LABELS)}
                </select>
                <div class="margin-bot-10px"></div>
                <label class="checkbox_label" for="chatui_header_group" title="群聊里角色消息的身份标头">
                    <span>群聊标头</span>
                </label>
                <select id="chatui_header_group" class="text_pole" style="margin-bottom:8px">
                    ${optionsHtml(MESSAGE_HEADERS, MESSAGE_HEADER_LABELS)}
                </select>
                <div class="margin-bot-10px"></div>
                <label class="checkbox_label" for="chatui_header_solo" title="单聊里角色消息的身份标头">
                    <span>单聊标头</span>
                </label>
                <select id="chatui_header_solo" class="text_pole" style="margin-bottom:8px">
                    ${optionsHtml(MESSAGE_HEADERS, MESSAGE_HEADER_LABELS)}
                </select>
                <div class="margin-bot-10px"></div>
            </div>
        </div>
    `;

    container.appendChild(wrapper);

    // Inline-drawer chevron toggle (we build the markup ourselves, so wire it manually).
    const drawerToggle = wrapper.querySelector('.inline-drawer-toggle');
    const drawerContent = /** @type {HTMLElement} */ (wrapper.querySelector('.inline-drawer-content'));
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

    // Enable toggle drives setup/teardown.
    const enabledCb = /** @type {HTMLInputElement} */ (document.getElementById('chatui_enabled'));
    enabledCb.addEventListener('change', () => {
        const settings = getSettings();
        settings.enabled = enabledCb.checked;
        saveSettingsDebounced();
        if (settings.enabled) {
            setup();
        } else {
            teardown();
        }
    });

    // Config selects — each persistent via the config store and two-way synced:
    // they write on change AND re-sync when the value changes elsewhere (e.g. the
    // in-app sidebar cycle/summon), so the surfaces never disagree.
    bindConfigSelect('chatui_sidebar_form', () => getConfig().sidebarForm, v => setSidebarForm(/** @type {any} */ (v)));
    bindConfigSelect('chatui_header_group', () => getConfig().headerGroup, v => setMessageHeader('group', /** @type {any} */ (v)));
    bindConfigSelect('chatui_header_solo', () => getConfig().headerSolo, v => setMessageHeader('solo', /** @type {any} */ (v)));
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
    injectSettingsUI();
    if (settings.enabled) setup();
}

// autoFireAfterEmit — APP_READY re-emits to late subscribers, so this is safe.
eventSource.on(event_types.APP_READY, init);
