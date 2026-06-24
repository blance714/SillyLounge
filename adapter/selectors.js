/**
 * SillyTavern-ChatUI · selector adapter
 */

import { getUserAvatars, setUserAvatar, user_avatar } from '../../../../personas.js';
import { getContext } from './internals.js';

// ── Selector chips (preset / model / persona quick-switch) ─────────────────────

/**
 * @returns {any}
 */
function _presetManager() {
    return getContext().getPresetManager?.() ?? null;
}

/**
 * @returns {{ value: string, label: string, selected: boolean }[]}
 */
function _presetOptions() {
    const pm = _presetManager();
    if (!pm) return [];
    const names = pm.getAllPresets() ?? [];
    const current = pm.getSelectedPresetName();
    return names.map(name => ({ value: name, label: name, selected: name === current }));
}

/**
 * @returns {{ value: string, label: string, selected: boolean }[]}
 */
function _modelOptions() {
    const cm = getContext().extensionSettings?.connectionManager;
    const profiles = Array.isArray(cm?.profiles) ? cm.profiles : [];
    const selected = cm?.selectedProfile ?? '';
    const options = [{ value: '', label: '— 默认 —', selected: !selected }];
    [...profiles]
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .forEach(profile => options.push({
            value: profile.id,
            label: profile.name ?? profile.id,
            selected: profile.id === selected,
        }));
    return options;
}

/**
 * @returns {Promise<{ value: string, label: string, selected: boolean }[]>}
 */
async function _personaOptions() {
    let ids = [];
    try {
        ids = await getUserAvatars(false);
    } catch {
        ids = [];
    }
    const personas = getContext().powerUserSettings?.personas ?? {};
    return (Array.isArray(ids) ? ids : []).map(id => ({
        value: id,
        label: personas[id] ?? id,
        selected: id === user_avatar,
    }));
}

/**
 * @param {'preset'|'model'|'persona'} kind
 * @returns {Promise<{ value: string, label: string, selected: boolean }[]>}
 */
export async function getSelectorOptions(kind) {
    if (kind === 'preset') return _presetOptions();
    if (kind === 'model') return _modelOptions();
    if (kind === 'persona') return _personaOptions();
    return [];
}

/**
 * @param {'preset'|'model'|'persona'} kind
 * @returns {Promise<{ value: string, label: string }|null>}
 */
export async function getSelectedSelector(kind) {
    const options = await getSelectorOptions(kind);
    const current = options.find(option => option.selected);
    return current ? { value: current.value, label: current.label } : null;
}

/**
 * @param {'preset'|'model'|'persona'} kind
 * @param {string} value
 * @returns {Promise<void>}
 */
export async function selectSelector(kind, value) {
    if (kind === 'preset') {
        const pm = _presetManager();
        if (!pm) return;
        const resolved = pm.findPreset(value);
        if (resolved !== undefined && resolved !== null) pm.selectPreset(resolved);
        return;
    }
    if (kind === 'model') {
        const select = document.getElementById('connection_profiles');
        if (!(select instanceof HTMLSelectElement)) return;
        select.value = value;
        select.dispatchEvent(new Event('change'));
        return;
    }
    if (kind === 'persona') {
        if (!value) return;
        await setUserAvatar(value);
    }
}
