import React, { useEffect, useRef } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { mountChatuiStDrawer, unmountChatuiStDrawer } from '../../actions.js';

type StDrawerHostProps = {
    drawerContentId: string;
    /** Whether this host is the active (displayed) pane. */
    active: boolean;
};

/**
 * Manages the lifecycle of a single embedded ST drawer-content node.
 * When active, mounts the drawer into this host div.
 * When inactive, the host stays in the DOM (hidden) so the ref is stable.
 * On component unmount (settings mode exit), restores the drawer to ST's DOM.
 */
export function StDrawerHost({ drawerContentId, active }: StDrawerHostProps): ComponentChild {
    const hostRef = useRef<HTMLDivElement>(null);
    // isMountedRef tracks whether mountChatuiStDrawer has been called successfully.
    const isMountedRef = useRef(false);

    // Mount when active; unmount when inactive.
    useEffect(() => {
        if (active && !isMountedRef.current && hostRef.current) {
            const ok = mountChatuiStDrawer(drawerContentId, hostRef.current);
            if (ok) isMountedRef.current = true;
        } else if (!active && isMountedRef.current) {
            const ok = unmountChatuiStDrawer(drawerContentId);
            if (ok) isMountedRef.current = false;
        }
    }, [active, drawerContentId]);

    // On component unmount (settings mode exited), restore the drawer.
    useEffect(() => {
        return () => {
            if (isMountedRef.current) {
                const ok = unmountChatuiStDrawer(drawerContentId);
                if (ok) isMountedRef.current = false;
            }
        };
    }, [drawerContentId]);

    return (
        <div
            ref={hostRef}
            className="cui-settings-host"
            hidden={!active}
            data-drawer-id={drawerContentId}
            aria-hidden={!active}
        />
    );
}
