/**
 * SillyTavern-ChatUI · root UI public entry
 *
 * The mounted app is authored in Preact and built to dist/root-app.mjs.
 * Keeping this file as a stable wrapper preserves the extension import path.
 */

export { initChatuiRoot, teardownChatuiRoot } from '../../dist/root-app.mjs';
