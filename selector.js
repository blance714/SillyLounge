/**
 * selector.js — Selector B proxy dropdown for SillyTavern-ChatUI
 *
 * Injects a <select>-backed dropdown into .cui-selectorB-slot that proxies one of:
 *   - preset      (AI settings preset via PresetManager)
 *   - model       (connection profile via #connection_profiles)
 *   - persona     (user persona via setUserAvatar)
 *
 * Reads settings.selectorBKind to decide which kind to show.
 * Stays in sync with ST by listening to the relevant event_types events.
 * Teardown removes the injected DOM and all event listeners.
 */

import { extension_settings } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';
import { getPresetManager } from '../../../preset-manager.js';
import { setUserAvatar, getUserAvatars, user_avatar } from '../../../personas.js';
import { power_user } from '../../../power-user.js';

// ── Module-level state ────────────────────────────────────────────────────────

/** @type {HTMLDivElement|null} The injected .cui-selector-b wrapper element */
let _selectorDiv = null;

/** @type {HTMLSelectElement|null} The injected <select> element */
let _selectEl = null;

/** Bound listener references for eventSource.off() */
const _listeners = {
    presetChanged: null,
    oaiPresetChanged: null,
    connectionProfileLoaded: null,
    personaChanged: null,
};

/** @type {{ settings: object, settingsP2?: object }|null} */
let _ctx = null;

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Returns the current selectorBKind from settings (fallback: 'preset').
 * @returns {'preset'|'model'|'persona'}
 */
function getKind() {
    const kind = _ctx?.settings?.selectorBKind;
    if (kind === 'model' || kind === 'persona') return kind;
    return 'preset';
}

/**
 * Populates the <select> element with options for the current kind.
 * Sets the selected option to the currently active value in ST.
 * @returns {Promise<void>}
 */
async function populateSelect() {
    if (!_selectEl) return;

    const kind = getKind();
    _selectEl.innerHTML = '';

    if (kind === 'preset') {
        const pm = getPresetManager();
        if (!pm) return;

        const allPresets = pm.getAllPresets();
        const current = pm.getSelectedPresetName();

        for (const name of allPresets) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            opt.selected = (name === current);
            _selectEl.appendChild(opt);
        }
    } else if (kind === 'model') {
        const cm = extension_settings.connectionManager;
        if (!cm || !Array.isArray(cm.profiles)) return;

        if (cm.profiles.length === 0) {
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = '— No profiles —';
            placeholder.disabled = true;
            placeholder.selected = true;
            _selectEl.appendChild(placeholder);
            return;
        }

        // None option
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = '— None —';
        noneOpt.selected = !cm.selectedProfile;
        _selectEl.appendChild(noneOpt);

        const sorted = [...cm.profiles].sort((a, b) => a.name.localeCompare(b.name));
        for (const profile of sorted) {
            const opt = document.createElement('option');
            opt.value = profile.id;
            opt.textContent = profile.name;
            opt.selected = (profile.id === cm.selectedProfile);
            _selectEl.appendChild(opt);
        }
    } else if (kind === 'persona') {
        let avatarIds;
        try {
            avatarIds = await getUserAvatars(false);
        } catch (_e) {
            avatarIds = [];
        }
        const currentId = user_avatar;

        for (const id of avatarIds) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = (power_user.personas && power_user.personas[id]) ? power_user.personas[id] : id;
            opt.selected = (id === currentId);
            _selectEl.appendChild(opt);
        }
    }
}

/**
 * Handles a user selection change on the <select> element.
 * Drives the corresponding ST API to apply the change.
 * @param {Event} e
 * @returns {Promise<void>}
 */
async function onSelectChange(e) {
    const kind = getKind();
    const selected = /** @type {HTMLSelectElement} */ (e.target).value;

    if (kind === 'preset') {
        const pm = getPresetManager();
        if (!pm) return;
        const value = pm.findPreset(selected);
        if (value !== undefined && value !== null) {
            pm.selectPreset(value);
        }
    } else if (kind === 'model') {
        if (!selected) return;
        const selectEl = document.getElementById('connection_profiles');
        if (!selectEl) return;
        selectEl.value = selected;
        selectEl.dispatchEvent(new Event('change'));
    } else if (kind === 'persona') {
        if (!selected) return;
        await setUserAvatar(selected);
    }
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Injects a <select>-backed dropdown into .cui-selectorB-slot and wires ST sync events.
 * @param {{ settings: object, settingsP2?: object }} ctx
 * @returns {void}
 */
export function initSelector(ctx) {
    if (_selectorDiv) return; // idempotent guard — mirrors initComposer / initPlusMenu pattern

    _ctx = ctx;

    const slot = document.querySelector('.cui-selectorB-slot');
    if (!slot) return;

    // Create wrapper div
    _selectorDiv = document.createElement('div');
    _selectorDiv.className = 'cui-selector-b';

    // Create the select element
    _selectEl = document.createElement('select');
    _selectEl.className = 'cui-selector-select';
    _selectEl.addEventListener('change', onSelectChange);

    _selectorDiv.appendChild(_selectEl);
    slot.appendChild(_selectorDiv);

    // Populate asynchronously; errors are non-fatal
    populateSelect().catch((err) => console.warn('[ChatUI] selector init failed:', err));

    // Register sync listeners
    _listeners.presetChanged = () => refreshSelector();
    _listeners.oaiPresetChanged = () => refreshSelector();
    _listeners.connectionProfileLoaded = () => refreshSelector();
    _listeners.personaChanged = () => refreshSelector();

    eventSource.on(event_types.PRESET_CHANGED, _listeners.presetChanged);
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, _listeners.oaiPresetChanged);
    eventSource.on(event_types.CONNECTION_PROFILE_LOADED, _listeners.connectionProfileLoaded);
    eventSource.on(event_types.PERSONA_CHANGED, _listeners.personaChanged);
}

/**
 * Removes the injected selector DOM and unregisters all eventSource listeners.
 * No-op if initSelector() was never called or teardown already ran.
 * @returns {void}
 */
export function teardownSelector() {
    // Remove event listeners
    if (_listeners.presetChanged) {
        eventSource.removeListener(event_types.PRESET_CHANGED, _listeners.presetChanged);
        _listeners.presetChanged = null;
    }
    if (_listeners.oaiPresetChanged) {
        eventSource.removeListener(event_types.OAI_PRESET_CHANGED_AFTER, _listeners.oaiPresetChanged);
        _listeners.oaiPresetChanged = null;
    }
    if (_listeners.connectionProfileLoaded) {
        eventSource.removeListener(event_types.CONNECTION_PROFILE_LOADED, _listeners.connectionProfileLoaded);
        _listeners.connectionProfileLoaded = null;
    }
    if (_listeners.personaChanged) {
        eventSource.removeListener(event_types.PERSONA_CHANGED, _listeners.personaChanged);
        _listeners.personaChanged = null;
    }

    // Remove the select's own change handler before removing from DOM
    if (_selectEl) {
        _selectEl.removeEventListener('change', onSelectChange);
        _selectEl = null;
    }

    // Remove injected DOM
    if (_selectorDiv) {
        _selectorDiv.remove();
        _selectorDiv = null;
    }

    _ctx = null;
}

/**
 * Repopulates the selector's <option> list and re-selects the current value.
 * Call after PRESET_CHANGED, PERSONA_CHANGED, CONNECTION_PROFILE_LOADED, or CHAT_CHANGED.
 * @returns {void}
 */
export function refreshSelector() {
    if (!_selectEl) return;
    populateSelect().catch((err) => console.warn('[ChatUI] selector refresh failed:', err));
}
