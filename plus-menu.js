/**
 * SillyTavern-ChatUI · plus-menu.js
 *
 * "+" button + menu: half-screen bottom-sheet (mobile) / popup (desktop).
 * Two sections:
 *   1. Pinned tiles  — default: regenerate, delete
 *   2. Tool list     — built-in tools, then dynamic wand proxies from #extensionsMenu
 *
 * Exports: initPlusMenu(ctx), teardownPlusMenu(), refreshPlusMenuWandItems()
 */

import { chatuiAdapter } from './adapter/st-adapter.js';

// ─── Internal state ───────────────────────────────────────────────────────────

/** @type {HTMLButtonElement|null} */
let _plusBtn = null;

/** @type {HTMLElement|null} - The active menu element (sheet or popup) */
let _menuEl = null;

/** @type {HTMLElement|null} - Overlay backdrop for mobile sheet */
let _overlayEl = null;

/** @type {boolean} */
let _isMenuOpen = false;

/** @type {boolean} */
let _isMobile = false;

/** @type {function|null} - Stored reference for removal */
let _docClickHandler = null;

/** @type {function|null} - Stored resize handler for responsive switch */
let _resizeHandler = null;

/** @type {object|null} - live settings reference from ctx */
let _settings = null;

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Returns true when viewport width ≤ 768 px (mobile breakpoint per CONTRACT §2).
 * @returns {boolean}
 */
function isMobileViewport() {
    return window.innerWidth <= 768;
}

// ─── Action dispatch ─────────────────────────────────────────────────────────

/**
 * Map of action id → adapter function.
 * All ST DOM fallbacks live inside adapter/st-adapter.js.
 */
const ACTION_DISPATCH = {
    regenerate() {
        chatuiAdapter.menuActions.regenerateFromPlusMenu();
    },

    delete() {
        chatuiAdapter.menuActions.openDeleteMessageMode();
    },

    continue() {
        chatuiAdapter.menuActions.continueMessage();
    },

    impersonate() {
        chatuiAdapter.menuActions.impersonateMessage();
    },

    camera() {
        chatuiAdapter.menuActions.openAttachmentPicker('image/*');
    },

    photos() {
        chatuiAdapter.menuActions.openAttachmentPicker('image/*,video/*,audio/*');
    },

    files() {
        chatuiAdapter.menuActions.openAttachmentPicker();
    },
};

// ─── Label / icon map for built-in tools ─────────────────────────────────────

/** @type {Record<string, {icon: string, label: string}>} */
const TOOL_META = {
    continue: { icon: 'fa-solid fa-arrow-right',      label: '续写' },
    impersonate: { icon: 'fa-solid fa-user-secret',      label: '代笔' },
    camera: { icon: 'fa-solid fa-camera',           label: '相机' },
    photos: { icon: 'fa-solid fa-images',           label: '图片' },
    files: { icon: 'fa-solid fa-paperclip',        label: '文件' },
};

/** @type {Record<string, {icon: string, label: string}>} */
const PINNED_META = {
    regenerate: { icon: 'fa-solid fa-repeat',     label: '重生成' },
    delete: { icon: 'fa-solid fa-trash-can',  label: '删除' },
};

// ─── Menu DOM construction ────────────────────────────────────────────────────

/**
 * Build a single pinned tile element.
 * @param {string} action
 * @returns {HTMLElement}
 */
function buildTile(action) {
    const meta = PINNED_META[action];
    const tile = document.createElement('button');
    tile.className = 'cui-plus-tile';
    tile.dataset.action = action;
    tile.type = 'button';
    tile.innerHTML = `<i class="${meta.icon} cui-tile-icon"></i><span class="cui-tile-label">${meta.label}</span>`;
    tile.addEventListener('click', () => {
        closeMenu();
        ACTION_DISPATCH[action]?.();
    });
    return tile;
}

/**
 * Build a single built-in tool row element.
 * @param {string} action
 * @returns {HTMLElement}
 */
function buildToolItem(action) {
    const meta = TOOL_META[action];
    const item = document.createElement('button');
    item.className = 'cui-plus-tool-item';
    item.dataset.action = action;
    item.type = 'button';
    item.innerHTML = `<i class="${meta.icon} cui-tool-icon"></i><span class="cui-tool-label">${meta.label}</span>`;
    item.addEventListener('click', () => {
        closeMenu();
        ACTION_DISPATCH[action]?.();
    });
    return item;
}

/**
 * Build a proxy element that visually mirrors a wand menu item and dispatches
 * a click to the original element when clicked.
 * @param {Element} original - The original wand menu item element
 * @returns {HTMLElement}
 */
function buildWandProxy(original) {
    const proxy = /** @type {HTMLElement} */ (original.cloneNode(true));
    proxy.classList.add('cui-wand-proxy');
    proxy.removeAttribute('id'); // avoid duplicate IDs

    proxy.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        chatuiAdapter.menuActions.triggerWandAction(original);
    });
    return proxy;
}

/**
 * Create the full menu DOM (shared between mobile and desktop variants).
 * @param {boolean} mobile - true → sheet; false → popup
 * @returns {HTMLElement}
 */
function buildMenuDOM(mobile) {
    const menu = document.createElement('div');
    menu.className = mobile
        ? 'cui-plus-menu cui-plus-sheet'
        : 'cui-plus-menu cui-plus-popup';
    menu.id = mobile ? 'cui-plus-sheet' : 'cui-plus-popup';

    // ── Header ────────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'cui-plus-header';

    const title = document.createElement('span');
    title.className = 'cui-plus-title';
    title.textContent = '工具';

    header.appendChild(title);

    if (mobile) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'cui-plus-close';
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', '关闭');
        closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        closeBtn.addEventListener('click', closeMenu);
        header.insertBefore(closeBtn, title);
    }

    menu.appendChild(header);

    // ── Pinned tiles section ──────────────────────────────────────────────────
    const pinnedSection = document.createElement('div');
    pinnedSection.className = 'cui-plus-pinned';

    const pinned = _settings?.plus?.pinned ?? ['regenerate', 'delete'];
    for (const action of pinned) {
        if (PINNED_META[action]) {
            pinnedSection.appendChild(buildTile(action));
        }
    }
    menu.appendChild(pinnedSection);

    // ── Divider ───────────────────────────────────────────────────────────────
    const divider = document.createElement('div');
    divider.className = 'cui-plus-divider';
    menu.appendChild(divider);

    // ── Tools section ─────────────────────────────────────────────────────────
    const toolsSection = document.createElement('div');
    toolsSection.className = 'cui-plus-tools';

    const tools = _settings?.plus?.tools ?? [
        { id: 'continue',    enabled: true },
        { id: 'impersonate', enabled: true },
        { id: 'camera',      enabled: true },
        { id: 'photos',      enabled: true },
        { id: 'files',       enabled: true },
    ];

    for (const tool of tools) {
        if (tool.enabled && TOOL_META[tool.id]) {
            toolsSection.appendChild(buildToolItem(tool.id));
        }
    }

    // Wand proxies will be injected here by refreshPlusMenuWandItems()
    menu.appendChild(toolsSection);

    return menu;
}

// ─── Menu open / close ────────────────────────────────────────────────────────

/**
 * Open the + menu (creates DOM if not yet attached).
 */
function openMenu() {
    if (_isMenuOpen || !_plusBtn) return;

    _isMobile = isMobileViewport();

    // Remove any stale menu from the other breakpoint
    document.getElementById('cui-plus-sheet')?.remove();
    document.getElementById('cui-plus-popup')?.remove();
    _overlayEl?.remove();
    _overlayEl = null;

    _menuEl = buildMenuDOM(_isMobile);

    if (_isMobile) {
        // Backdrop overlay
        _overlayEl = document.createElement('div');
        _overlayEl.className = 'cui-plus-overlay';
        _overlayEl.addEventListener('click', closeMenu);
        document.body.appendChild(_overlayEl);

        document.body.appendChild(_menuEl);
        // cui-sheet-in animation fires automatically on append (defined in CSS)
    } else {
        document.body.appendChild(_menuEl);
        positionPopup();
    }

    _isMenuOpen = true;

    // Inject current wand proxies
    refreshPlusMenuWandItems();

    // Click-outside handler for desktop popup
    if (!_isMobile) {
        _docClickHandler = (/** @type {MouseEvent} */ e) => {
            if (!_menuEl) return;
            if (_menuEl.contains(/** @type {Node} */ (e.target))) return;
            if (_plusBtn?.contains(/** @type {Node} */ (e.target))) return;
            closeMenu();
        };
        // Defer one tick so this open-click doesn't immediately close the menu
        setTimeout(() => {
            document.addEventListener('click', _docClickHandler, { capture: true });
        }, 0);
    }
}

/**
 * Position the popup above the + button using getBoundingClientRect.
 */
function positionPopup() {
    if (!_menuEl || !_plusBtn) return;

    const rect = _plusBtn.getBoundingClientRect();

    // Temporarily display to measure
    _menuEl.style.visibility = 'hidden';
    _menuEl.style.display = 'block';

    const menuH = _menuEl.offsetHeight;
    const menuW = _menuEl.offsetWidth;

    _menuEl.style.visibility = '';
    _menuEl.style.display = '';

    const GAP = 8; // px between button and popup

    // Default: popup above button, left-aligned with button
    let top = rect.top - menuH - GAP;
    let left = rect.left;

    // Keep inside viewport horizontally
    if (left + menuW > window.innerWidth - 8) {
        left = window.innerWidth - menuW - 8;
    }
    if (left < 8) left = 8;

    // If not enough space above, flip below
    if (top < 8) {
        top = rect.bottom + GAP;
    }

    _menuEl.style.position = 'fixed';
    _menuEl.style.top = `${top}px`;
    _menuEl.style.left = `${left}px`;
}

/**
 * Close and destroy the + menu DOM.
 */
function closeMenu() {
    if (!_isMenuOpen) return;
    _isMenuOpen = false;

    if (_docClickHandler) {
        document.removeEventListener('click', _docClickHandler, { capture: true });
        _docClickHandler = null;
    }

    if (_isMobile && _menuEl) {
        // Trigger slide-out animation; remove element when animation completes
        const el = _menuEl;
        el.classList.add('cui-plus-sheet--closing');
        el.addEventListener('animationend', () => el.remove(), { once: true });
        // Fallback: remove after 400ms if animationend never fires
        setTimeout(() => el.remove(), 400);
    } else {
        _menuEl?.remove();
    }

    _overlayEl?.remove();
    _overlayEl = null;
    _menuEl = null;
}

// ─── Wand proxy sync ─────────────────────────────────────────────────────────

/**
 * Re-sync wand proxies: removes existing .cui-wand-proxy nodes from the
 * active menu's .cui-plus-tools section, re-scans #extensionsMenu containers,
 * and appends visible ones as visual-only proxies.
 *
 * Safe to call when no menu is open (no-op in that case).
 */
export function refreshPlusMenuWandItems() {
    if (!_menuEl) return;

    const toolsSection = _menuEl.querySelector('.cui-plus-tools');
    if (!toolsSection) return;

    // Remove stale proxies
    toolsSection.querySelectorAll('.cui-wand-proxy').forEach(el => el.remove());

    const wandMenu = document.getElementById('extensionsMenu');
    if (!wandMenu) return;

    // Walk every extension_container slot; mirror visible items as proxies
    wandMenu.querySelectorAll('.extension_container').forEach(container => {
        Array.from(container.children).forEach(item => {
            // Skip items that are hidden (display:none or .displayNone class)
            const el = /** @type {HTMLElement} */ (item);
            if (el.classList.contains('displayNone')) return;
            if (window.getComputedStyle(el).display === 'none') return;

            const proxy = buildWandProxy(el);
            toolsSection.appendChild(proxy);
        });
    });

    // Also check for items appended directly to #extensionsMenu (fallback pattern)
    Array.from(wandMenu.children).forEach(child => {
        const el = /** @type {HTMLElement} */ (child);
        if (el.classList.contains('extension_container')) return; // already handled above
        if (el.classList.contains('displayNone')) return;
        if (window.getComputedStyle(el).display === 'none') return;

        const proxy = buildWandProxy(el);
        toolsSection.appendChild(proxy);
    });
}

// ─── + Button ─────────────────────────────────────────────────────────────────

/**
 * Build and return the + button element.
 * @returns {HTMLButtonElement}
 */
function buildPlusButton() {
    const btn = document.createElement('button');
    btn.id = 'cui-plus-btn';
    btn.className = 'cui-plus-btn interactable';
    btn.type = 'button';
    btn.setAttribute('aria-label', '打开工具菜单');
    btn.title = '工具';
    btn.innerHTML = '<i class="fa-solid fa-plus"></i>';

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_isMenuOpen) {
            closeMenu();
        } else {
            openMenu();
        }
    });

    return btn;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the + button menu.
 * Injects the + button into .cui-plus-slot (created by composer.js).
 *
 * @param {{ settings: object, settingsP2?: object }} ctx - Shared context object
 */
export function initPlusMenu(ctx) {
    _settings = ctx.settings;

    // Guard against double-init
    if (_plusBtn) return;

    const slot = document.querySelector('.cui-plus-slot');
    if (!slot) {
        console.warn('[ChatUI] plus-menu: .cui-plus-slot not found — initComposer must run first');
        return;
    }

    _plusBtn = buildPlusButton();
    slot.appendChild(_plusBtn);

    // Responsive: if viewport crosses 768 px while menu is open, close and
    // let the user re-open in the correct mode.
    _resizeHandler = () => {
        const nowMobile = isMobileViewport();
        if (_isMenuOpen && nowMobile !== _isMobile) {
            closeMenu();
        }
    };
    window.addEventListener('resize', _resizeHandler);
}

/**
 * Teardown: remove + button and any open menu; clean up all listeners.
 * Idempotent — safe to call when not set up.
 */
export function teardownPlusMenu() {
    // Close any open menu first (handles listener cleanup internally)
    if (_isMenuOpen) {
        // Force-remove without transition for teardown speed
        if (_docClickHandler) {
            document.removeEventListener('click', _docClickHandler, { capture: true });
            _docClickHandler = null;
        }
        _menuEl?.remove();
        _overlayEl?.remove();
        _menuEl = null;
        _overlayEl = null;
        _isMenuOpen = false;
    }

    // Also remove any lingering menu elements that may have been left by CSS transition
    document.getElementById('cui-plus-sheet')?.remove();
    document.getElementById('cui-plus-popup')?.remove();

    chatuiAdapter.menuActions.clearAttachmentPickerRestore();

    // Remove resize handler
    if (_resizeHandler) {
        window.removeEventListener('resize', _resizeHandler);
        _resizeHandler = null;
    }

    // Remove + button from its slot
    if (_plusBtn) {
        _plusBtn.remove();
        _plusBtn = null;
    }

    _settings = null;
}
