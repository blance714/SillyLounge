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
 * Two honest limits, recorded because "the flush returned" is weaker than "the
 * write landed" and callers reload immediately after awaiting this:
 *
 * - `saveSettings()` swallows its own transport failures (try/catch + a
 *   toastr, script.js:8055-8058) and never rejects, so a caller's catch block
 *   is unreachable for a failed request. It is still worth keeping for a
 *   throwing *stub* or a future ST that does reject.
 * - it also returns without saving anything in two states, re-arming the very
 *   debounce this call exists to defeat: `!settingsReady` (script.js:7992) and
 *   `TempResponseLength.isCustomized()` (script.js:7998). Both re-queue
 *   through `saveSettingsDebounced()`, so a reload that follows lands right
 *   back in the dropped-write case. Neither is reachable from a settled page
 *   in practice — settings are ready long before ChatUI mounts, and the
 *   temporary response-length override only exists mid-generation, which every
 *   reloading path already refuses to run during — but neither is *impossible*
 *   either, and this function cannot tell the difference between them and a
 *   real save.
 *
 * @returns {Promise<void>}
 */
export async function flushSettings(): Promise<void> {
    await saveSettings();
}
