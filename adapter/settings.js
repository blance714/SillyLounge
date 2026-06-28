/**
 * SillyTavern-ChatUI · adapter/settings.js
 *
 * Embed-engine: move a live ST .drawer-content node into a ChatUI-owned host
 * element, then restore it to its original DOM position.
 *
 * ONLY this adapter layer may touch ST DOM. All ST-internal classes/selectors
 * are isolated here.
 *
 * Exported surface (used by st-adapter.js facade):
 *   mountStDrawer(drawerContentId, hostEl)  – relocate node into hostEl
 *   unmountStDrawer(drawerContentId)        – restore node to original position
 */

/**
 * The exact live node plus its original DOM position and class state, captured at
 * mount so restore is precise and resilient to ST/movingUI churn while hosted.
 * @typedef {{
 *   node: Element,
 *   parent: Element|null,
 *   nextSibling: Node|null,
 *   hostEl: Element,
 *   className: string,
 *   cssText: string,
 *   dataDragged: string|null,
 *   chatuiHostedAttr: string|null,
 *   icon: Element|null,
 *   iconClassName: string|null,
 *   iconCssText: string|null,
 *   dragGrabbers: Array<{
 *     node: Element,
 *     className: string,
 *     cssText: string,
 *     ariaHidden: string|null,
 *     tabIndex: string|null,
 *     chatuiDragDisabledAttr: string|null,
 *   }>,
 * }} OriginalPosition
 */

/** @type {Map<string, OriginalPosition>} */
const _positions = new Map();

const HOSTED_DRAWER_CLASS = 'chatui-hosted-st-drawer';
const HOSTED_DRAWER_ATTR = 'data-chatui-hosted-drawer';
const DRAG_DISABLED_ATTR = 'data-chatui-drag-disabled';
const PARKING_ROOT_ID = 'chatui-st-drawer-parking';

/**
 * @param {Element} el
 * @returns {string}
 */
function getClassName(el) {
    return el.getAttribute('class') || '';
}

/**
 * @param {Element} el
 * @returns {string}
 */
function getCssText(el) {
    return el instanceof HTMLElement ? el.style.cssText : '';
}

/**
 * @param {Element} el
 * @param {string} cssText
 */
function setCssText(el, cssText) {
    if (el instanceof HTMLElement) {
        el.style.cssText = cssText;
    }
}

/**
 * @param {Element} el
 * @param {string} name
 * @param {string|null} value
 */
function restoreAttr(el, name, value) {
    if (value === null) {
        el.removeAttribute(name);
    } else {
        el.setAttribute(name, value);
    }
}

/**
 * @param {Element} node
 * @param {Element|null} parent
 * @returns {Element|null}
 */
function findDrawerIcon(node, parent) {
    return parent?.querySelector('.drawer-toggle .drawer-icon')
        || node.parentElement?.querySelector('.drawer-toggle .drawer-icon')
        || null;
}

/**
 * @returns {HTMLElement|null}
 */
function getParkingRoot() {
    let root = document.getElementById(PARKING_ROOT_ID);
    if (root instanceof HTMLElement) {
        return root;
    }
    const parkingParent = document.body || document.documentElement;
    if (!parkingParent) {
        return null;
    }
    root = document.createElement('div');
    root.id = PARKING_ROOT_ID;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = 'display: none !important;';
    parkingParent.appendChild(root);
    return root;
}

/**
 * @param {OriginalPosition} pos
 * @returns {boolean}
 */
function restoreToOriginalParent(pos) {
    const { node, parent, nextSibling, hostEl } = pos;
    if (!parent || !parent.isConnected) {
        return false;
    }

    if (nextSibling && nextSibling.parentNode === parent) {
        parent.insertBefore(node, nextSibling);
    } else {
        parent.appendChild(node);
    }

    return node.parentNode === parent && !hostEl.contains(node);
}

/**
 * @param {OriginalPosition} pos
 * @returns {boolean}
 */
function parkHostedDrawer(pos) {
    const parkingRoot = getParkingRoot();
    if (!parkingRoot) {
        return false;
    }
    parkingRoot.appendChild(pos.node);
    return pos.node.parentNode === parkingRoot && !pos.hostEl.contains(pos.node);
}

/**
 * @param {OriginalPosition} pos
 */
function restoreSnapshot(pos) {
    const { node, className, cssText, dataDragged, chatuiHostedAttr, icon, iconClassName, iconCssText } = pos;

    node.setAttribute('class', className);
    setCssText(node, cssText);
    restoreAttr(node, 'data-dragged', dataDragged);
    restoreAttr(node, HOSTED_DRAWER_ATTR, chatuiHostedAttr);

    if (icon && iconClassName !== null && iconCssText !== null) {
        icon.setAttribute('class', iconClassName);
        setCssText(icon, iconCssText);
    }

    for (const grabber of pos.dragGrabbers) {
        grabber.node.setAttribute('class', grabber.className);
        setCssText(grabber.node, grabber.cssText);
        restoreAttr(grabber.node, 'aria-hidden', grabber.ariaHidden);
        restoreAttr(grabber.node, 'tabindex', grabber.tabIndex);
        restoreAttr(grabber.node, DRAG_DISABLED_ATTR, grabber.chatuiDragDisabledAttr);
    }
}

/**
 * ST drawer entries in DOM default order. Ids match the `.drawer-content` element's
 * `id` attribute in index.html. Labels are Chinese display names.
 *
 * Source line numbers for each drawerContentId in index.html (SillyTavern/public/index.html):
 *   left-nav-panel      line 72   (fillLeft)
 *   rm_api_block        line 2277
 *   AdvancedFormatting  line 4081
 *   WorldInfo           line 4661
 *   user-settings-block line 4868
 *   Backgrounds         line 5643
 *   rm_extensions_block line 5740
 *   PersonaManagement   line 5823
 *   right-nav-panel     line 5992  (fillRight)
 *
 * @type {ReadonlyArray<{id: string, section: 'st', label: string, iconClass: string, drawerContentId: string}>}
 */
export const ST_SETTINGS_ENTRIES = Object.freeze([
    { id: 'st:left-nav-panel',      section: /** @type {'st'} */ ('st'), label: 'AI 配置',  iconClass: 'fa-solid fa-sliders',                 drawerContentId: 'left-nav-panel' },
    { id: 'st:rm_api_block',        section: /** @type {'st'} */ ('st'), label: 'API 连接', iconClass: 'fa-solid fa-plug-circle-exclamation',  drawerContentId: 'rm_api_block' },
    { id: 'st:AdvancedFormatting',  section: /** @type {'st'} */ ('st'), label: 'AI 格式化', iconClass: 'fa-solid fa-font',                     drawerContentId: 'AdvancedFormatting' },
    { id: 'st:WorldInfo',           section: /** @type {'st'} */ ('st'), label: '世界书',   iconClass: 'fa-solid fa-book-atlas',               drawerContentId: 'WorldInfo' },
    { id: 'st:user-settings-block', section: /** @type {'st'} */ ('st'), label: '用户设置', iconClass: 'fa-solid fa-user-cog',                 drawerContentId: 'user-settings-block' },
    { id: 'st:Backgrounds',         section: /** @type {'st'} */ ('st'), label: '背景',     iconClass: 'fa-solid fa-panorama',                 drawerContentId: 'Backgrounds' },
    { id: 'st:rm_extensions_block', section: /** @type {'st'} */ ('st'), label: '扩展',     iconClass: 'fa-solid fa-cubes',                    drawerContentId: 'rm_extensions_block' },
    { id: 'st:PersonaManagement',   section: /** @type {'st'} */ ('st'), label: '人设',     iconClass: 'fa-solid fa-face-smile',               drawerContentId: 'PersonaManagement' },
    { id: 'st:right-nav-panel',     section: /** @type {'st'} */ ('st'), label: '角色管理', iconClass: 'fa-solid fa-address-card',             drawerContentId: 'right-nav-panel' },
]);

/**
 * Return the full ordered ST settings entry list (static).
 * @returns {typeof ST_SETTINGS_ENTRIES}
 */
export function listStSettingsEntries() {
    return ST_SETTINGS_ENTRIES;
}

/**
 * Move the live ST drawer-content node identified by `drawerContentId` into
 * `hostEl`. Records the node's original parent + nextSibling so it can be
 * precisely restored by unmountStDrawer. Captures the drawer/icon/drag-handle
 * state before applying ChatUI hosted markers, then opens + pins the drawer so
 * ST's own toggle logic leaves it alone.
 *
 * Guard: if the node is missing, or is already mounted (id already in map),
 * logs a warning and returns false.
 *
 * @param {string} drawerContentId  id attribute of the .drawer-content element
 * @param {Element} hostEl          ChatUI-owned container to append the node into
 * @returns {boolean}               true on success
 */
export function mountStDrawer(drawerContentId, hostEl) {
    if (_positions.has(drawerContentId)) {
        console.warn(`[chatui/settings] mountStDrawer: "${drawerContentId}" already mounted`);
        return false;
    }

    const node = document.getElementById(drawerContentId);
    if (!node) {
        console.warn(`[chatui/settings] mountStDrawer: node #${drawerContentId} not found`);
        return false;
    }

    const parent = node.parentElement;
    const icon = findDrawerIcon(node, parent);
    const dragGrabbers = Array.from(node.querySelectorAll('.drag-grabber')).map(grabber => ({
        node: grabber,
        className: getClassName(grabber),
        cssText: getCssText(grabber),
        ariaHidden: grabber.getAttribute('aria-hidden'),
        tabIndex: grabber.getAttribute('tabindex'),
        chatuiDragDisabledAttr: grabber.getAttribute(DRAG_DISABLED_ATTR),
    }));
    /** @type {OriginalPosition} */
    const pos = {
        node,
        parent,
        nextSibling: node.nextSibling,
        hostEl,
        className: getClassName(node),
        cssText: getCssText(node),
        dataDragged: node.getAttribute('data-dragged'),
        chatuiHostedAttr: node.getAttribute(HOSTED_DRAWER_ATTR),
        icon,
        iconClassName: icon ? getClassName(icon) : null,
        iconCssText: icon ? getCssText(icon) : null,
        dragGrabbers,
    };

    // Remove ST's closed state; open + pin so ST's click-outside auto-close skips it.
    node.classList.add(HOSTED_DRAWER_CLASS);
    node.setAttribute(HOSTED_DRAWER_ATTR, 'true');
    node.classList.remove('closedDrawer');
    node.classList.add('openDrawer', 'pinnedOpen');

    if (icon) {
        icon.classList.remove('closedIcon');
        icon.classList.add('openIcon', 'drawerPinnedOpen');
    }

    for (const grabber of dragGrabbers) {
        grabber.node.classList.remove('drag-grabber');
        grabber.node.setAttribute(DRAG_DISABLED_ATTR, 'true');
        grabber.node.setAttribute('aria-hidden', 'true');
        grabber.node.setAttribute('tabindex', '-1');
    }

    try {
        hostEl.appendChild(node);
    } catch (err) {
        restoreSnapshot(pos);
        console.warn(`[chatui/settings] mountStDrawer: hosting #${drawerContentId} failed`, err);
        return false;
    }

    _positions.set(drawerContentId, pos);

    // right-nav-panel: refresh the hotswap favorites row after reparenting.
    // favsToHotswap is from RossAscends-mods; it's async but we fire-and-forget.
    if (drawerContentId === 'right-nav-panel') {
        import('../../../../../scripts/RossAscends-mods.js')
            .then(({ favsToHotswap }) => favsToHotswap())
            .catch(() => {});
    }

    return true;
}

/**
 * Restore a hosted drawer to its original DOM position and class state. Uses the
 * node reference captured at mount (not getElementById, which could hit a
 * duplicate id), re-inserts before the recorded sibling only if that sibling is
 * still a child of the recorded parent (ST/movingUI may have mutated the tree),
 * and falls back to a hidden body-level parking root if the original parent is
 * gone. The map entry is removed only after the live node is confirmed outside
 * the ChatUI host and placed in the original parent or parking root.
 *
 * @param {string} drawerContentId  id attribute of the .drawer-content element
 * @returns {boolean}               true if a mounted entry was found and restored
 */
export function unmountStDrawer(drawerContentId) {
    const pos = _positions.get(drawerContentId);
    if (!pos) {
        console.warn(`[chatui/settings] unmountStDrawer: "${drawerContentId}" not mounted`);
        return false;
    }
    let restored = false;
    try {
        restored = restoreToOriginalParent(pos);
    } catch (err) {
        console.warn(`[chatui/settings] unmountStDrawer: restore of #${drawerContentId} failed`, err);
    }

    if (!restored) {
        try {
            restored = parkHostedDrawer(pos);
        } catch (err) {
            console.warn(`[chatui/settings] unmountStDrawer: parking of #${drawerContentId} failed`, err);
        }
    }

    if (!restored) {
        console.warn(`[chatui/settings] unmountStDrawer: #${drawerContentId} is still hosted; keeping mount record`);
        return false;
    }

    try {
        restoreSnapshot(pos);
    } catch (err) {
        console.warn(`[chatui/settings] unmountStDrawer: snapshot restore of #${drawerContentId} failed`, err);
        return false;
    }

    _positions.delete(drawerContentId);
    return true;
}
