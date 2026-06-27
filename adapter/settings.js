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
 * @typedef {{ parent: Element, nextSibling: Node|null }} OriginalPosition
 */

/** @type {Map<string, OriginalPosition>} */
const _positions = new Map();

/**
 * Move the live ST drawer-content node identified by `drawerContentId` into
 * `hostEl`. Records the node's original parent + nextSibling so it can be
 * precisely restored by unmountStDrawer. Removes ST's closedDrawer class and
 * adds openDrawer + pinnedOpen so ST's own toggle logic leaves it alone.
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

    // Record original position for precise restore.
    _positions.set(drawerContentId, {
        parent: /** @type {Element} */ (node.parentElement),
        nextSibling: node.nextSibling,
    });

    // Remove ST's closed state; open + pin so ST's click-outside auto-close skips it.
    node.classList.remove('closedDrawer');
    node.classList.add('openDrawer', 'pinnedOpen');

    hostEl.appendChild(node);
    return true;
}

/**
 * Restore the node identified by `drawerContentId` to its original DOM
 * position (before the recorded nextSibling, or appended when nextSibling
 * was null). Cleans up openDrawer/pinnedOpen and re-adds closedDrawer.
 *
 * Guard: if the id is not in the map (never mounted or already unmounted),
 * logs a warning and returns false.
 *
 * @param {string} drawerContentId  id attribute of the .drawer-content element
 * @returns {boolean}               true on success
 */
export function unmountStDrawer(drawerContentId) {
    const pos = _positions.get(drawerContentId);
    if (!pos) {
        console.warn(`[chatui/settings] unmountStDrawer: "${drawerContentId}" not mounted`);
        return false;
    }

    const node = document.getElementById(drawerContentId);
    if (!node) {
        // Node somehow disappeared — still clean up the map.
        _positions.delete(drawerContentId);
        console.warn(`[chatui/settings] unmountStDrawer: node #${drawerContentId} not found during restore`);
        return false;
    }

    // Restore ST's closed state.
    node.classList.remove('openDrawer', 'pinnedOpen');
    node.classList.add('closedDrawer');

    // Re-insert at exact original position.
    if (pos.nextSibling) {
        pos.parent.insertBefore(node, pos.nextSibling);
    } else {
        pos.parent.appendChild(node);
    }

    _positions.delete(drawerContentId);
    return true;
}
