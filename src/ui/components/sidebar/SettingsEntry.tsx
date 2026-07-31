import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { openChatuiSettings } from '../../actions.js';

/**
 * The settings gear pinned to the bottom of the spine (DESIGN §4.2). It used to
 * be a full-width labelled row in the single-column sidebar; on a 58px rail it
 * is an icon square like every other spine slot, so the visible 「设置」 label
 * is gone and `aria-label`/`title` carry the same word instead. The
 * .cui-root-settings-entry class is a CI assertion target and stays put.
 *
 * No wrapper element: the spine is the flex column now, and the old
 * .cui-root-sidebar-footer only existed to push this button to the bottom of
 * the playbill with margin-top:auto.
 */
export function SettingsEntry({ onNavigate }: { onNavigate: () => void }): ComponentChild {
    return (
        <button
            className="cui-root-settings-entry"
            type="button"
            aria-label="设置"
            title="设置"
            onClick={() => {
                openChatuiSettings();
                onNavigate();
            }}
        >
            <i className="fa-solid fa-gear" aria-hidden="true" />
        </button>
    );
}
