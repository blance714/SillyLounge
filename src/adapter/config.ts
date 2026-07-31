/**
 * SillyTavern-ChatUI · config adapter
 *
 * Boundary submodule that reads and writes the chatui_composer.config slice
 * inside SillyTavern's extension_settings via getContext(). Only this module
 * is allowed to touch the ST persistence layer for user-facing config values.
 */

import { saveSettings, saveSettingsDebounced } from '@st/script';
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
    const ctx = getContext();
    // read() tolerates a missing extensionSettings namespace via `?.`; mirror
    // that here instead of assuming some earlier boot step always created it.
    if (!ctx.extensionSettings) {
        ctx.extensionSettings = {};
    }
    const settings = ctx.extensionSettings;
    if (!settings[MODULE]) {
        settings[MODULE] = {};
    }
    settings[MODULE].config = config;
    saveSettingsDebounced();
}

/**
 * Force every pending ST settings write to disk, now.
 *
 * `saveSettingsDebounced()` — the call this module, ST's own
 * `.character_select` handler and dozens of other ST call sites all share —
 * is one cancel-and-re-arm timer (utils.js's `debounce()`), so a
 * `window.location.reload()` that beats its 1000ms relaxed window tears the
 * page down with the write still queued and loses it silently. Every ChatUI
 * path that reloads on purpose must therefore land its settings first; see
 * index.ts's disableChatuiLayers doc comment for the instrumented case where
 * skipping this reliably (not occasionally) lost both the enable flag and the
 * truncation backup.
 *
 * This is ST's whole settings file, not just this extension's slice: that is
 * the granularity `saveSettings()` offers and the granularity the shared
 * debounce loses.
 *
 * @returns {Promise<void>}
 */
export async function flushSettings(): Promise<void> {
    await saveSettings();
}
