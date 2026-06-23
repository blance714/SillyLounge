/**
 * SillyTavern-ChatUI · index.js
 *
 * Entry point for the ChatUI (Composer) extension.
 * Orchestrates init/teardown, owns the settings schema, and injects the settings UI.
 *
 * CONTRACT §10 — wiring is non-negotiable.
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { initComposer, teardownComposer, setComposerMode } from './composer.js';
import { initPlusMenu, teardownPlusMenu, refreshPlusMenuWandItems } from './plus-menu.js';
import { initSelector, teardownSelector, refreshSelector } from './selector.js';
import { initQr, teardownQr } from './qr.js';
import { initMessageLayout, teardownMessageLayout } from './message-layout.js';
import { initMessageActions, teardownMessageActions } from './message-actions.js';
import { initMessageExtras, teardownMessageExtras } from './message-extras.js';
import { initChatChrome, teardownChatChrome } from './chat-chrome.js';
import { initChatuiStore, teardownChatuiStore } from './store/chat-store.js';
import { initStDomShield, teardownStDomShield } from './shield/st-dom-shield.js';
import { initChatuiRoot, teardownChatuiRoot } from './ui/root.js';

// ── Module constants ──────────────────────────────────────────────────────────

/** Settings namespace key (Phase 1) */
const MODULE = 'chatui_composer';

/** Settings namespace key (Phase 2) */
const MODULE_P2 = 'chatui_messages';

/**
 * Default settings per CONTRACT §3.
 * @type {object}
 */
const defaultSettings = {
    enabled: false,
    composerMode: 'multiline',
    selectorBKind: 'preset',
    plus: {
        pinned: ['regenerate', 'delete'],
        tools: [
            { id: 'continue',     enabled: true },
            { id: 'impersonate',  enabled: true },
            { id: 'camera',       enabled: true },
            { id: 'photos',       enabled: true },
            { id: 'files',        enabled: true },
        ],
    },
};

/**
 * Default settings for Phase 2 (message / content area) per CONTRACT-P2.md §3.
 * @type {object}
 */
const defaultSettingsP2 = {
    identityHeaderGroup: 'icon',
    identityHeaderSingle: 'none',
    charActionRow: ['copy', 'regenerate', 'edit'],
    userMenu: ['copy', 'edit', 'delete', 'branch', 'checkpoint', 'hide'],
    swipeStyle: 'buttons',
    reasoningCollapsed: true,
    codeHeader: true,
    scrollToBottom: true,
    bottomRegen: true,
};

// ── Internal state ────────────────────────────────────────────────────────────

/** @type {boolean} */
let isSetup = false;

// ── Settings helpers ──────────────────────────────────────────────────────────

/**
 * Ensures extension_settings[MODULE] exists and has all required keys.
 * Returns the live settings reference.
 *
 * @returns {object} Live settings object.
 */
function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(defaultSettings);
    }

    const s = extension_settings[MODULE];

    // Ensure top-level keys exist
    if (typeof s.enabled !== 'boolean')         s.enabled = defaultSettings.enabled;
    if (typeof s.composerMode !== 'string')      s.composerMode = defaultSettings.composerMode;
    if (typeof s.selectorBKind !== 'string')     s.selectorBKind = defaultSettings.selectorBKind;

    // Ensure plus object exists
    if (!s.plus || typeof s.plus !== 'object') {
        s.plus = structuredClone(defaultSettings.plus);
    }
    if (!Array.isArray(s.plus.pinned)) {
        s.plus.pinned = [...defaultSettings.plus.pinned];
    }
    if (!Array.isArray(s.plus.tools)) {
        s.plus.tools = structuredClone(defaultSettings.plus.tools);
    }

    return s;
}

/**
 * Ensures extension_settings[MODULE_P2] exists and has all required keys.
 * Returns the live Phase 2 settings reference.
 *
 * @returns {object} Live Phase 2 settings object.
 */
function getSettingsP2() {
    if (!extension_settings[MODULE_P2]) {
        extension_settings[MODULE_P2] = structuredClone(defaultSettingsP2);
    }

    const s = extension_settings[MODULE_P2];

    if (!['icon', 'name', 'none'].includes(s.identityHeaderGroup))
        s.identityHeaderGroup = defaultSettingsP2.identityHeaderGroup;
    if (!['icon', 'name', 'none'].includes(s.identityHeaderSingle))
        s.identityHeaderSingle = defaultSettingsP2.identityHeaderSingle;
    if (!Array.isArray(s.charActionRow))
        s.charActionRow = [...defaultSettingsP2.charActionRow];
    if (!Array.isArray(s.userMenu))
        s.userMenu = [...defaultSettingsP2.userMenu];
    if (typeof s.reasoningCollapsed !== 'boolean')
        s.reasoningCollapsed = defaultSettingsP2.reasoningCollapsed;
    if (typeof s.codeHeader !== 'boolean')
        s.codeHeader = defaultSettingsP2.codeHeader;
    if (typeof s.scrollToBottom !== 'boolean')
        s.scrollToBottom = defaultSettingsP2.scrollToBottom;
    if (typeof s.bottomRegen !== 'boolean')
        s.bottomRegen = defaultSettingsP2.bottomRegen;

    return s;
}

// ── ctx factory ───────────────────────────────────────────────────────────────

/**
 * Builds the shared ctx object passed to all sub-modules.
 *
 * @returns {{ settings: object, settingsP2: object }} Shared context.
 */
function buildCtx() {
    return {
        settings: getSettings(),
        settingsP2: getSettingsP2(),
    };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

/**
 * Activate ChatUI: add body class, init sub-modules in contract order.
 * Idempotent — no-op if already set up.
 *
 * @returns {void}
 */
function setup() {
    if (isSetup) return;

    const ctx = buildCtx();

    // CONTRACT §4 init order: composer → plusMenu → selector → qr → body class
    initComposer(ctx);
    initPlusMenu(ctx);
    initSelector(ctx);
    initQr(ctx);

    initStDomShield();
    initChatuiStore();
    initChatuiRoot(ctx);

    // Phase 2 inits (after body class so chatui-active gate is live)
    initMessageLayout(ctx);
    initMessageActions(ctx);
    initMessageExtras(ctx);
    initChatChrome(ctx);

    isSetup = true;
}

/**
 * Deactivate ChatUI: teardown sub-modules in contract order, remove body class.
 * Idempotent — no-op if not set up.
 *
 * @returns {void}
 */
function teardown() {
    if (!isSetup) return;

    // Phase 2 teardown first (reverse init order, before body class is removed)
    teardownChatChrome();
    teardownMessageExtras();
    teardownMessageActions();
    teardownMessageLayout();
    teardownChatuiRoot();

    // CONTRACT §4 teardown order: qr → selector → plusMenu → composer → remove body class
    teardownQr();
    teardownSelector();
    teardownPlusMenu();
    teardownComposer();

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

    // Prevent double-injection if init() is called twice
    if (document.getElementById('chatui-settings-drawer')) return;

    const s = getSettings();
    const sp2 = getSettingsP2();

    const wrapper = document.createElement('div');
    wrapper.className = 'extension_container';

    wrapper.innerHTML = `
        <div id="chatui-settings-drawer" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>ChatUI 输入框重制</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="chatui_enabled" title="启用/禁用 ChatUI Composer">
                    <input id="chatui_enabled" type="checkbox" class="checkbox"${s.enabled ? ' checked' : ''}>
                    <span>启用 ChatUI Composer</span>
                </label>

                <div class="flex-container flexFlowColumn flexNoGap marginTop5">
                    <label for="chatui_composer_mode">输入框模式</label>
                    <select id="chatui_composer_mode" class="text_pole">
                        <option value="multiline"${s.composerMode === 'multiline' ? ' selected' : ''}>多行（Multi-line）</option>
                        <option value="singleline"${s.composerMode === 'singleline' ? ' selected' : ''}>单行（Single-line）</option>
                    </select>
                </div>

                <div class="flex-container flexFlowColumn flexNoGap marginTop5">
                    <label for="chatui_selector_b_kind">选择框 B 内容</label>
                    <select id="chatui_selector_b_kind" class="text_pole">
                        <option value="preset"${s.selectorBKind === 'preset' ? ' selected' : ''}>预设（Preset）</option>
                        <option value="model"${s.selectorBKind === 'model' ? ' selected' : ''}>模型（Model / Connection profile）</option>
                        <option value="persona"${s.selectorBKind === 'persona' ? ' selected' : ''}>人设（Persona）</option>
                    </select>
                </div>

                <hr style="margin:0.6rem 0; border-color: var(--SmartThemeBorderColor);">
                <small style="opacity:0.7">— 内容区（Phase 2）—</small>

                <div class="flex-container flexFlowColumn flexNoGap marginTop5">
                    <label for="chatui_identity_group">身份标头（群聊）</label>
                    <select id="chatui_identity_group" class="text_pole">
                        <option value="icon"${sp2.identityHeaderGroup === 'icon' ? ' selected' : ''}>头像 + 名字（Icon）</option>
                        <option value="name"${sp2.identityHeaderGroup === 'name' ? ' selected' : ''}>仅名字（Name only）</option>
                        <option value="none"${sp2.identityHeaderGroup === 'none' ? ' selected' : ''}>无（None）</option>
                    </select>
                </div>

                <div class="flex-container flexFlowColumn flexNoGap marginTop5">
                    <label for="chatui_identity_single">身份标头（单聊）</label>
                    <select id="chatui_identity_single" class="text_pole">
                        <option value="icon"${sp2.identityHeaderSingle === 'icon' ? ' selected' : ''}>头像 + 名字（Icon）</option>
                        <option value="name"${sp2.identityHeaderSingle === 'name' ? ' selected' : ''}>仅名字（Name only）</option>
                        <option value="none"${sp2.identityHeaderSingle === 'none' ? ' selected' : ''}>无（None）</option>
                    </select>
                </div>

                <label class="checkbox_label marginTop5" for="chatui_reasoning_collapsed">
                    <input id="chatui_reasoning_collapsed" type="checkbox" class="checkbox"${sp2.reasoningCollapsed ? ' checked' : ''}>
                    <span>思考块默认折叠</span>
                </label>

                <label class="checkbox_label marginTop5" for="chatui_code_header">
                    <input id="chatui_code_header" type="checkbox" class="checkbox"${sp2.codeHeader ? ' checked' : ''}>
                    <span>代码块顶栏（语言名 + 复制）</span>
                </label>

                <label class="checkbox_label marginTop5" for="chatui_scroll_to_bottom">
                    <input id="chatui_scroll_to_bottom" type="checkbox" class="checkbox"${sp2.scrollToBottom ? ' checked' : ''}>
                    <span>回到底部按钮</span>
                </label>

                <label class="checkbox_label marginTop5" for="chatui_bottom_regen">
                    <input id="chatui_bottom_regen" type="checkbox" class="checkbox"${sp2.bottomRegen ? ' checked' : ''}>
                    <span>底部重生成按钮</span>
                </label>

                <div class="margin-bot-10px"></div>
            </div>
        </div>
    `;

    container.appendChild(wrapper);

    // ── Wire listeners ────────────────────────────────────────────────────────

    /** @type {HTMLInputElement} */
    const enabledCb = /** @type {HTMLInputElement} */ (document.getElementById('chatui_enabled'));
    /** @type {HTMLSelectElement} */
    const modeSel = /** @type {HTMLSelectElement} */ (document.getElementById('chatui_composer_mode'));
    /** @type {HTMLSelectElement} */
    const selectorSel = /** @type {HTMLSelectElement} */ (document.getElementById('chatui_selector_b_kind'));
    /** @type {HTMLSelectElement} */
    const identityGroupSel = /** @type {HTMLSelectElement} */ (document.getElementById('chatui_identity_group'));
    /** @type {HTMLSelectElement} */
    const identitySingleSel = /** @type {HTMLSelectElement} */ (document.getElementById('chatui_identity_single'));
    /** @type {HTMLInputElement} */
    const reasoningCb = /** @type {HTMLInputElement} */ (document.getElementById('chatui_reasoning_collapsed'));
    /** @type {HTMLInputElement} */
    const codeHeaderCb = /** @type {HTMLInputElement} */ (document.getElementById('chatui_code_header'));
    /** @type {HTMLInputElement} */
    const scrollBtnCb = /** @type {HTMLInputElement} */ (document.getElementById('chatui_scroll_to_bottom'));
    /** @type {HTMLInputElement} */
    const regenBtnCb = /** @type {HTMLInputElement} */ (document.getElementById('chatui_bottom_regen'));

    // Inline-drawer toggle (matches ST's own pattern — uses slideToggle via delegated handler,
    // but we wire the chevron flip manually since we build the HTML ourselves).
    const drawerToggle = wrapper.querySelector('.inline-drawer-toggle');
    const drawerContent = wrapper.querySelector('.inline-drawer-content');
    const drawerIcon = wrapper.querySelector('.inline-drawer-icon');

    if (drawerToggle && drawerContent && drawerIcon) {
        drawerToggle.addEventListener('click', () => {
            const isOpen = drawerIcon.classList.contains('up');
            if (isOpen) {
                drawerIcon.classList.remove('up');
                drawerIcon.classList.add('down');
                /** @type {HTMLElement} */ (drawerContent).style.display = 'none';
            } else {
                drawerIcon.classList.remove('down');
                drawerIcon.classList.add('up');
                /** @type {HTMLElement} */ (drawerContent).style.display = '';
            }
        });
        // Start collapsed (ST convention: closed by default)
        /** @type {HTMLElement} */ (drawerContent).style.display = 'none';
    }

    // Enabled toggle
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

    // Composer mode
    modeSel.addEventListener('change', () => {
        const settings = getSettings();
        settings.composerMode = modeSel.value;
        saveSettingsDebounced();
        // Apply mode switch without full reinit if we're active
        if (isSetup) {
            setComposerMode(/** @type {'multiline'|'singleline'} */ (modeSel.value));
        }
    });

    // Selector B kind
    selectorSel.addEventListener('change', () => {
        const settings = getSettings();
        settings.selectorBKind = selectorSel.value;
        saveSettingsDebounced();
        // Refresh selector to show the newly-chosen kind
        if (isSetup) {
            refreshSelector();
        }
    });

    // ── Phase 2 controls ──────────────────────────────────────────────────────

    // Identity header — group chat
    identityGroupSel.addEventListener('change', () => {
        const p2 = getSettingsP2();
        p2.identityHeaderGroup = identityGroupSel.value;
        saveSettingsDebounced();
        if (isSetup) {
            // Re-sweep layout to apply the new header level
            teardownMessageLayout();
            initMessageLayout(buildCtx());
        }
    });

    // Identity header — single chat
    identitySingleSel.addEventListener('change', () => {
        const p2 = getSettingsP2();
        p2.identityHeaderSingle = identitySingleSel.value;
        saveSettingsDebounced();
        if (isSetup) {
            teardownMessageLayout();
            initMessageLayout(buildCtx());
        }
    });

    // Reasoning collapsed default (CSS-only, just save — CSS reads the class)
    reasoningCb.addEventListener('change', () => {
        const p2 = getSettingsP2();
        p2.reasoningCollapsed = reasoningCb.checked;
        saveSettingsDebounced();
    });

    // Code header toggle — reinit extras to apply
    codeHeaderCb.addEventListener('change', () => {
        const p2 = getSettingsP2();
        p2.codeHeader = codeHeaderCb.checked;
        saveSettingsDebounced();
        if (isSetup) {
            teardownMessageExtras();
            initMessageExtras(buildCtx());
        }
    });

    // Scroll-to-bottom button toggle
    scrollBtnCb.addEventListener('change', () => {
        const p2 = getSettingsP2();
        p2.scrollToBottom = scrollBtnCb.checked;
        saveSettingsDebounced();
        if (isSetup) {
            teardownChatChrome();
            initChatChrome(buildCtx());
        }
    });

    // Bottom-regen button toggle
    regenBtnCb.addEventListener('change', () => {
        const p2 = getSettingsP2();
        p2.bottomRegen = regenBtnCb.checked;
        saveSettingsDebounced();
        if (isSetup) {
            teardownChatChrome();
            initChatChrome(buildCtx());
        }
    });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

/**
 * Called once on APP_READY. Ensures settings, injects UI, and auto-enables
 * if settings.enabled is true.
 *
 * @returns {void}
 */
function init() {
    const settings = getSettings();

    injectSettingsUI();

    if (settings.enabled) {
        setup();
    }
}

// ── Event bindings ────────────────────────────────────────────────────────────

// autoFireAfterEmit — safe for late load (APP_READY re-emits to late subscribers)
eventSource.on(event_types.APP_READY, init);

eventSource.on(event_types.CHAT_CHANGED, () => {
    if (!isSetup) return;
    // Let QR's own CHAT_CHANGED handler run first before we resync
    setTimeout(() => {
        refreshPlusMenuWandItems();
        refreshSelector();
    }, 0);
});
