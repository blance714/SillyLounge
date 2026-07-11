import { getRequestHeaders } from '@st/script';
import { parseRecord } from '../schema.js';
import { stripChatExt } from './state.js';

export type PersistCharacterChatSelectionOutcome =
    | Readonly<{ status: 'persisted'; fileName: string }>
    | Readonly<{ status: 'different'; fileName: string }>
    | Readonly<{ status: 'rejected' }>
    | Readonly<{ status: 'unknown' }>;

export function waitForRetry(delayMs = 250): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, delayMs));
}

async function writeCharacterChatSelection(
    avatar: string,
    fileName: string,
): Promise<'accepted' | 'rejected' | 'ambiguous'> {
    try {
        const response = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar, chat: fileName }),
        });
        return response.ok ? 'accepted' : 'rejected';
    } catch (error) {
        console.error('[ChatUI] persist character chat selection failed', error);
        return 'ambiguous';
    }
}

/** Read the durable character-card pointer by stable avatar, never live index. */
export async function readCharacterChatSelection(avatar: string): Promise<string> {
    const response = await fetch('/api/characters/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar }),
    });
    if (!response.ok) throw new Error('character-chat-selection-read-failed');
    return stripChatExt(parseRecord(await response.json() as unknown).chat);
}

/**
 * Persist a character-card chat pointer with stable-avatar readback.
 *
 * A dropped response is not a failed write: the server may still have committed
 * it. In that case the assignment is safe to repeat, so converge with
 * idempotent retries until stable-avatar readback proves the target.
 * This prevents rollback from racing a request that committed after transport
 * loss. `expectedFileName` lets a non-ambiguous concurrent selection win.
 */
export async function persistCharacterChatSelection(
    avatar: string,
    fileName: string,
    expectedFileName: string,
): Promise<PersistCharacterChatSelectionOutcome> {
    const target = stripChatExt(fileName);
    const expected = stripChatExt(expectedFileName);
    let writeState = await writeCharacterChatSelection(avatar, target);
    let hadAmbiguousWrite = writeState === 'ambiguous';
    let loggedReadFailure = false;

    for (;;) {
        try {
            const persisted = await readCharacterChatSelection(avatar);
            if (persisted === target) return { status: 'persisted', fileName: target };

            // After a transport-ambiguous write, an observed old value is only
            // a snapshot: the first server handler may still commit later. Keep
            // converging to the same idempotent target before releasing the lane.
            if (!hadAmbiguousWrite) {
                if (writeState === 'rejected' && persisted === expected) {
                    return { status: 'rejected' };
                }
                return { status: 'different', fileName: persisted };
            }
        } catch (error) {
            if (!loggedReadFailure) {
                loggedReadFailure = true;
                console.error('[ChatUI] character chat selection readback failed', error);
            }
            if (!hadAmbiguousWrite && writeState === 'rejected') return { status: 'rejected' };
        }

        await waitForRetry();
        if (!hadAmbiguousWrite && writeState === 'accepted') {
            // `/merge-attributes` can return 2xx even when its internal card
            // write failed. Never treat transport success as durable proof;
            // keep the lane and retry stable-avatar readback.
            continue;
        }
        const retryState = await writeCharacterChatSelection(avatar, target);
        if (retryState === 'accepted') {
            writeState = 'accepted';
            hadAmbiguousWrite = false;
        } else if (retryState === 'ambiguous') {
            hadAmbiguousWrite = true;
        }
        // Once any attempt was ambiguous, a later rejection cannot prove that
        // the earlier in-flight assignment did not commit. Keep retrying.
    }
}

export async function listRawCharacterChatNames(avatar: string): Promise<string[]> {
    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar, simple: true }),
    });
    if (!response.ok) throw new Error('character-chat-file-list-failed');

    const payload = await response.json() as unknown;
    if (!Array.isArray(payload)) throw new Error('character-chat-file-list-invalid');
    return payload
        .map(entry => stripChatExt(parseRecord(entry).file_id))
        .filter(Boolean);
}
