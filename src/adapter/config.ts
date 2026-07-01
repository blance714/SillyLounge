/**
 * SillyTavern-ChatUI · config adapter
 *
 * Boundary submodule that reads and writes the chatui_composer.config slice
 * inside SillyTavern's extension_settings via getContext(). Only this module
 * is allowed to touch the ST persistence layer for user-facing config values.
 */

import { saveSettingsDebounced } from '@st/script';
import { getContext } from './internals.js';

/** Settings namespace key — must match index.js MODULE constant. */
const MODULE = 'chatui_composer';

/**
 * Read the persisted config object.
 * Returns an empty object if the namespace or .config key is absent.
 *
 * @returns {Record<string, unknown>}
 */
export function read() {
    return /** @type {Record<string, unknown>} */ (
        getContext().extensionSettings?.[MODULE]?.config ?? {}
    );
}

/**
 * Persist a full config object.
 * Ensures the module namespace exists before writing, then debounces save.
 *
 * @param {Record<string, unknown>} config
 * @returns {void}
 */
export function write(config: any) {
    const settings = getContext().extensionSettings;
    if (!settings[MODULE]) {
        settings[MODULE] = {};
    }
    settings[MODULE].config = config;
    saveSettingsDebounced();
}
