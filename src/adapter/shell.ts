/**
 * SillyTavern-ChatUI · shell adapter
 */

import { _dispatchClick } from './internals.js';

/**
 * @param {string} selector
 * @returns {Element|null}
 */
function getElement(selector: any) {
    return document.querySelector(selector);
}

/**
 * @param {string} selector
 * @returns {void}
 */
function clickElement(selector: any) {
    const element = getElement(selector);
    if (element) _dispatchClick(element);
}

/**
 * @param {string} drawerSelector
 * @returns {void}
 */
function openDrawer(drawerSelector: any) {
    const drawer = getElement(drawerSelector);
    if (!drawer) return;

    const content = drawer.querySelector('.drawer-content');
    if (content?.classList.contains('openDrawer')) return;

    const icon = drawer.querySelector('.drawer-toggle, .drawer-icon');
    if (icon) _dispatchClick(icon);
}

/**
 * @param {string} selector
 * @returns {void}
 */
function openRightDrawerPanel(selector: any) {
    openDrawer('#rightNavHolder');
    setTimeout(() => clickElement(selector), 0);
}

/**
 * @param {string} action
 * @returns {void}
 */
export function triggerShellAction(action: any) {
    switch (action) {
        case 'characters': openRightDrawerPanel('#rm_button_characters'); break;
        case 'characterCreate': openRightDrawerPanel('#rm_button_create'); break;
        case 'groupChats': openRightDrawerPanel('#rm_button_group_chats'); break;
        case 'aiConfig': openDrawer('#ai-config-button'); break;
        case 'formatting': openDrawer('#advanced-formatting-button'); break;
        case 'worldInfo': openDrawer('#WI-SP-button'); break;
        case 'background': openDrawer('#backgrounds-button'); break;
        case 'userSettings': openDrawer('#user-settings-button'); break;
        case 'extensions': openDrawer('#extensions-settings-button'); break;
        case 'personas': openDrawer('#persona-management-button'); break;
        default: break;
    }
}
