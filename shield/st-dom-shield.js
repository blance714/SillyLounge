/**
 * SillyTavern-ChatUI · ST DOM shield
 *
 * Owns the ChatUI root and the global active gate. Stronger hiding rules will
 * be added here as dependencies are inventoried.
 */

const ROOT_ID = 'chatui-root';
const SHIELD_LEVEL_ATTRIBUTE = 'data-chatui-shield-level';
const DEFAULT_SHIELD_LEVEL = 4;

const SHIELD_CLASSES = Object.freeze([
    'chatui-shield-lite',
    'chatui-root-visible',
    'chatui-chat-surface-shielded',
    'chatui-composer-surface-shielded',
]);

/**
 * @returns {HTMLElement}
 */
export function ensureChatuiRoot() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
        root = document.createElement('div');
        root.id = ROOT_ID;
        root.setAttribute('data-cui-root', '1');
    }

    const sheld = document.getElementById('sheld');
    const chat = document.getElementById('chat');

    if (sheld) {
        if (root.parentElement !== sheld) {
            sheld.insertBefore(root, chat ?? sheld.firstChild);
        } else if (chat && root.nextElementSibling !== chat) {
            sheld.insertBefore(root, chat);
        }
    } else {
        document.body.appendChild(root);
    }

    return root;
}

/**
 * @param {number} level
 * @returns {void}
 */
function applyShieldLevel(level) {
    const normalizedLevel = Math.max(0, Number(level) || 0);

    document.body.setAttribute(SHIELD_LEVEL_ATTRIBUTE, String(normalizedLevel));
    document.body.classList.toggle('chatui-shield-lite', normalizedLevel >= 1);
    document.body.classList.toggle('chatui-root-visible', normalizedLevel >= 2);
    document.body.classList.toggle('chatui-chat-surface-shielded', normalizedLevel >= 3);
    document.body.classList.toggle('chatui-composer-surface-shielded', normalizedLevel >= 4);
}

/**
 * @returns {void}
 */
function clearShieldLevel() {
    document.body.removeAttribute(SHIELD_LEVEL_ATTRIBUTE);
    document.body.classList.remove(...SHIELD_CLASSES);
}

/**
 * @param {number} level
 * @returns {void}
 */
export function setStDomShieldLevel(level) {
    ensureChatuiRoot();
    applyShieldLevel(level);
}

/**
 * @returns {HTMLElement}
 */
export function initStDomShield() {
    const root = ensureChatuiRoot();
    document.body.classList.add('chatui-active');
    applyShieldLevel(DEFAULT_SHIELD_LEVEL);
    return root;
}

/**
 * @returns {void}
 */
export function teardownStDomShield() {
    document.getElementById(ROOT_ID)?.remove();
    clearShieldLevel();
    document.body.classList.remove('chatui-active');
}
