/**
 * SillyTavern-ChatUI · composer adapter
 */

import { sendTextareaMessage } from '../../../../../script.js';
import { _dispatchClick } from './internals.js';

/**
 * @returns {HTMLTextAreaElement|null}
 */
export function getNativeComposerTextarea() {
    return /** @type {HTMLTextAreaElement|null} */ (document.getElementById('send_textarea'));
}

/**
 * @param {string} text
 * @returns {void}
 */
export function setNativeComposerText(text) {
    const textarea = getNativeComposerTextarea();
    if (!textarea) return;

    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

/**
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function sendComposerMessage(text) {
    setNativeComposerText(text);
    await sendTextareaMessage();
}

/**
 * @returns {boolean} true if a stop control was found and clicked
 */
export function stopGeneration() {
    const stopButton = document.querySelector('.mes_stop');
    if (!stopButton) return false;
    _dispatchClick(stopButton);
    return true;
}
