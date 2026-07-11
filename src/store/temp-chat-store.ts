/**
 * SillyTavern-ChatUI · temp chat quarantine store
 *
 * ST materializes a real JSONL as soon as `doNewChat()` runs. Because its
 * delete endpoint has no conditional revision check, abandoning that file
 * cannot be made safe by a client-side read-then-delete. ChatUI therefore keeps
 * every unadopted new chat in a persisted quarantine set: it stays out of the
 * ordinary conversation list until a user mutation adopts it or the user
 * explicitly deletes it.
 */

import { createStore } from './create-store.js';

const LEGACY_TEMP_CHAT_STORAGE_KEY = 'chatui:tempChat';
const TEMP_CHAT_STORAGE_PREFIX = 'chatui:tempChat:';
const TEMP_CHAT_STORAGE_VERSION = 2;
let _storageListenerInstalled = false;

export type TempChatPointer = { avatar: string; fileName: string };

export type TempChatPointerSnapshot = Readonly<{
    pointer: TempChatPointer | null;
    version: number;
}>;

export type TempChatDraft = {
    avatar: string;
    knownFileNames: string[];
    complete: boolean;
};

export type TempChatDraftSnapshot = Readonly<{
    draft: TempChatDraft | null;
    version: number;
}>;

type TempChatState = {
    /** All unadopted files, including the one currently open. */
    tempChats: ReadonlyArray<TempChatPointer>;
    /** The tracked temp currently loaded in ST, if known. */
    activeTempChat: TempChatPointer | null;
    /** ABA generation for the active slot only; dormant-set churn is unrelated. */
    activeVersion: number;
    optimisticDraft: TempChatDraft | null;
    draftVersion: number;
};

const _initialState: TempChatState = {
    tempChats: [],
    activeTempChat: null,
    activeVersion: 0,
    optimisticDraft: null,
    draftVersion: 0,
};

const _store = createStore<TempChatState>(_initialState);

function _storage(): Storage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

function _normalizeFileName(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\.jsonl$/i, '') : '';
}

function _normalizePointer(value: unknown): TempChatPointer | null {
    const entry = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    const avatar = typeof entry?.avatar === 'string' ? entry.avatar : '';
    const fileName = _normalizeFileName(entry?.fileName);
    return avatar && fileName ? { avatar, fileName } : null;
}

function _samePointer(a: TempChatPointer | null, b: TempChatPointer | null): boolean {
    return a?.avatar === b?.avatar && a?.fileName === b?.fileName;
}

function _normalizePointers(value: unknown): TempChatPointer[] {
    if (!Array.isArray(value)) return [];
    const byIdentity = new Map<string, TempChatPointer>();
    for (const item of value) {
        const pointer = _normalizePointer(item);
        if (pointer) byIdentity.set(JSON.stringify([pointer.avatar, pointer.fileName]), pointer);
    }
    return Array.from(byIdentity.values());
}

function _normalizeKnownFileNames(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    for (const item of value) {
        const fileName = _normalizeFileName(item);
        if (fileName) seen.add(fileName);
    }
    return Array.from(seen);
}

function _pointerStorageKey(pointer: TempChatPointer): string {
    return `${TEMP_CHAT_STORAGE_PREFIX}${encodeURIComponent(JSON.stringify([pointer.avatar, pointer.fileName]))}`;
}

function _pointerFromStorageKey(key: string): TempChatPointer | null {
    if (!key.startsWith(TEMP_CHAT_STORAGE_PREFIX)) return null;
    try {
        const identity = JSON.parse(decodeURIComponent(key.slice(TEMP_CHAT_STORAGE_PREFIX.length))) as unknown;
        return Array.isArray(identity)
            ? _normalizePointer({ avatar: identity[0], fileName: identity[1] })
            : null;
    } catch {
        return null;
    }
}

function _readStoredPointers(): TempChatPointer[] {
    const storage = _storage();
    if (!storage) return [];

    const values: unknown[] = [];
    let storageLength = 0;
    try {
        storageLength = storage.length;
    } catch {
        // The legacy record below may still be readable.
    }
    for (let index = 0; index < storageLength; index += 1) {
        try {
            const key = storage.key(index);
            if (!key?.startsWith(TEMP_CHAT_STORAGE_PREFIX)) continue;
            const keyPointer = _pointerFromStorageKey(key);
            if (!keyPointer) continue;
            const raw = storage.getItem(key);
            const valuePointer = raw ? _normalizePointer(JSON.parse(raw) as unknown) : null;
            if (valuePointer && _samePointer(valuePointer, keyPointer)) values.push(valuePointer);
        } catch {
            // One corrupt lease must not publish every other quarantined draft.
        }
    }

    try {
        const legacyRaw = storage.getItem(LEGACY_TEMP_CHAT_STORAGE_KEY);
        if (legacyRaw) {
            const legacyValue = JSON.parse(legacyRaw) as unknown;
            if (Array.isArray(legacyValue)) values.push(...legacyValue);
            else if (legacyValue && typeof legacyValue === 'object') {
                const record = legacyValue as Record<string, unknown>;
                if (record.version === TEMP_CHAT_STORAGE_VERSION && Array.isArray(record.pointers)) {
                    values.push(...record.pointers);
                } else {
                    values.push(legacyValue);
                }
            }
        }
    } catch {
        // A corrupt legacy record is isolated from the per-pointer v2 leases.
    }
    return _normalizePointers(values);
}

function _addStoredPointer(pointer: TempChatPointer): boolean {
    const storage = _storage();
    if (!storage) return false;
    try {
        storage.setItem(_pointerStorageKey(pointer), JSON.stringify(pointer));
        return true;
    } catch {
        // Private browsing / quota failures should not break ChatUI navigation.
        return false;
    }
}

function _removeStoredPointer(pointer: TempChatPointer): void {
    try {
        _storage()?.removeItem(_pointerStorageKey(pointer));
    } catch {
        // Storage failure keeps the draft quarantined after reload, which is safe.
    }
}

function _replaceStoredPointers(pointers: ReadonlyArray<TempChatPointer>): void {
    const storage = _storage();
    if (!storage) return;
    try {
        const keys: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key?.startsWith(TEMP_CHAT_STORAGE_PREFIX)) keys.push(key);
        }
        for (const key of keys) storage.removeItem(key);
        storage.removeItem(LEGACY_TEMP_CHAT_STORAGE_KEY);
        for (const pointer of pointers) _addStoredPointer(pointer);
    } catch {
        // Used only by initialization/tests; in-memory state remains usable.
    }
}

function _migrateLegacyStorage(pointers: ReadonlyArray<TempChatPointer>): void {
    const storage = _storage();
    if (!storage) return;
    try {
        if (!storage.getItem(LEGACY_TEMP_CHAT_STORAGE_KEY)) return;
        // Do not use the best-effort writer here: the legacy record is removed
        // only after every v2 lease is durably written.
        for (const pointer of pointers) {
            storage.setItem(_pointerStorageKey(pointer), JSON.stringify(pointer));
        }
        storage.removeItem(LEGACY_TEMP_CHAT_STORAGE_KEY);
    } catch {
        // Leave the legacy record intact so a later load can retry migration.
    }
}

function _syncPointersFromStorage(): void {
    const tempChats = _readStoredPointers();
    const state = _store.getState();
    const activeTempChat = state.activeTempChat
        && tempChats.some(pointer => _samePointer(pointer, state.activeTempChat))
        ? state.activeTempChat
        : null;
    _store.setState({
        ...state,
        tempChats,
        activeTempChat,
        activeVersion: _samePointer(activeTempChat, state.activeTempChat)
            ? state.activeVersion
            : state.activeVersion + 1,
    });
}

/** Stable external-store snapshot of every quarantined temp chat. */
export function getTempChats(): ReadonlyArray<TempChatPointer> {
    return _store.getState().tempChats;
}

/** The quarantined temp currently loaded in ST, if one is known. */
export function getTempChat(): TempChatPointer | null {
    return _store.getState().activeTempChat;
}

export function getTempChatDraft(): TempChatDraft | null {
    return _store.getState().optimisticDraft;
}

/** Capture active ownership for one queued navigation or mutation. */
export function getTempChatSnapshot(): TempChatPointerSnapshot {
    const state = _store.getState();
    return {
        pointer: state.activeTempChat ? { ...state.activeTempChat } : null,
        version: state.activeVersion,
    };
}

export function isTempChatSnapshotCurrent(snapshot: TempChatPointerSnapshot): boolean {
    const state = _store.getState();
    return state.activeVersion === snapshot.version
        && _samePointer(state.activeTempChat, snapshot.pointer);
}

export function getTempChatDraftSnapshot(): TempChatDraftSnapshot {
    const state = _store.getState();
    return {
        draft: state.optimisticDraft
            ? { ...state.optimisticDraft, knownFileNames: [...state.optimisticDraft.knownFileNames] }
            : null,
        version: state.draftVersion,
    };
}

export function beginTempChatDraft(
    draft: { avatar: string; knownFileNames?: string[]; complete?: boolean },
): TempChatDraftSnapshot {
    const avatar = typeof draft?.avatar === 'string' ? draft.avatar : '';
    if (!avatar) return getTempChatDraftSnapshot();
    const state = _store.getState();
    _store.setState({
        ...state,
        optimisticDraft: {
            avatar,
            knownFileNames: _normalizeKnownFileNames(draft.knownFileNames),
            complete: !!draft.complete,
        },
        draftVersion: state.draftVersion + 1,
    });
    return getTempChatDraftSnapshot();
}

export function cancelTempChatDraft(): void {
    const state = _store.getState();
    _store.setState({
        ...state,
        optimisticDraft: null,
        draftVersion: state.draftVersion + 1,
    });
}

export function cancelTempChatDraftIfMatches(snapshot: TempChatDraftSnapshot): boolean {
    const state = _store.getState();
    if (state.draftVersion !== snapshot.version) return false;
    _store.setState({
        ...state,
        optimisticDraft: null,
        draftVersion: state.draftVersion + 1,
    });
    return true;
}

/** Test/compatibility setter: replace the quarantine with exactly one pointer. */
export function setTempChat(pointer: TempChatPointer | null): void {
    const next = _normalizePointer(pointer);
    const state = _store.getState();
    const tempChats = next ? [next] : [];
    _replaceStoredPointers(tempChats);
    _store.setState({
        tempChats,
        activeTempChat: next,
        activeVersion: state.activeVersion + 1,
        optimisticDraft: null,
        draftVersion: state.draftVersion + 1,
    });
}

/** Add a newly materialized file to quarantine and mark it active. */
export function commitTempChatDraft(
    pointer: TempChatPointer,
    draftSnapshot: TempChatDraftSnapshot,
): boolean {
    const next = _normalizePointer(pointer);
    if (!next) return false;

    const state = _store.getState();
    const tempChats = [
        ...state.tempChats.filter(item => !_samePointer(item, next)),
        next,
    ];
    const ownsDraft = state.draftVersion === draftSnapshot.version;
    _addStoredPointer(next);
    _store.setState({
        tempChats,
        activeTempChat: next,
        activeVersion: state.activeVersion + 1,
        optimisticDraft: ownsDraft ? null : state.optimisticDraft,
        draftVersion: ownsDraft ? state.draftVersion + 1 : state.draftVersion,
    });
    return true;
}

/** Adopt and publish the active temp after a user-owned mutation. */
export function clearTempChat(): void {
    const state = _store.getState();
    const active = state.activeTempChat;
    if (!active) return;
    const tempChats = state.tempChats.filter(item => !_samePointer(item, active));
    _removeStoredPointer(active);
    _store.setState({
        ...state,
        tempChats,
        activeTempChat: null,
        activeVersion: state.activeVersion + 1,
    });
}

/** Remove one exact active generation after explicit deletion or adoption. */
export function clearTempChatIfMatches(snapshot: TempChatPointerSnapshot): boolean {
    if (!snapshot.pointer || !isTempChatSnapshotCurrent(snapshot)) return false;
    const state = _store.getState();
    const tempChats = state.tempChats.filter(item => !_samePointer(item, snapshot.pointer));
    _removeStoredPointer(snapshot.pointer);
    _store.setState({
        ...state,
        tempChats,
        activeTempChat: null,
        activeVersion: state.activeVersion + 1,
    });
    return true;
}

/** Leave a temp quarantined but stop treating it as the currently open draft. */
export function deactivateTempChatIfMatches(snapshot: TempChatPointerSnapshot): boolean {
    if (!snapshot.pointer || !isTempChatSnapshotCurrent(snapshot)) return false;
    const state = _store.getState();
    _store.setState({
        ...state,
        activeTempChat: null,
        activeVersion: state.activeVersion + 1,
    });
    return true;
}

/** Remove a quarantined file only after an explicit delete confirms success. */
export function removeTempChat(avatar: string, fileName: string): boolean {
    const target = _normalizePointer({ avatar, fileName });
    if (!target) return false;
    const state = _store.getState();
    const tempChats = state.tempChats.filter(item => !_samePointer(item, target));
    if (tempChats.length === state.tempChats.length) return false;
    const removesActive = _samePointer(state.activeTempChat, target);
    const activeTempChat = removesActive ? null : state.activeTempChat;
    _removeStoredPointer(target);
    _store.setState({
        ...state,
        tempChats,
        activeTempChat,
        activeVersion: removesActive ? state.activeVersion + 1 : state.activeVersion,
    });
    return true;
}

/** Mark a known quarantined file active when native ST loads it. */
export function markTempChatActive(avatar: string, fileName: string): boolean {
    const target = _normalizePointer({ avatar, fileName });
    if (!target) return false;
    const state = _store.getState();
    const tracked = state.tempChats.find(item => _samePointer(item, target));
    if (!tracked) return false;
    if (_samePointer(state.activeTempChat, tracked)) return true;
    _store.setState({
        ...state,
        activeTempChat: tracked,
        activeVersion: state.activeVersion + 1,
    });
    return true;
}

/** Rename exactly the active generation captured before an async host call. */
export function moveTempChatIfMatches(
    snapshot: TempChatPointerSnapshot,
    nextPointer: TempChatPointer,
): boolean {
    const next = _normalizePointer(nextPointer);
    if (!next || !snapshot.pointer || !isTempChatSnapshotCurrent(snapshot)) return false;
    const state = _store.getState();
    const tempChats = state.tempChats.map(item => (
        _samePointer(item, snapshot.pointer) ? next : item
    ));
    if (_addStoredPointer(next)) _removeStoredPointer(snapshot.pointer);
    _store.setState({
        ...state,
        tempChats,
        activeTempChat: next,
        activeVersion: state.activeVersion + 1,
    });
    return true;
}

/**
 * A rename conflict may leave both old and new files on disk. Quarantine the
 * server-confirmed new identity without publishing the old candidate until a
 * later raw existence check can resolve which files remain.
 */
export function retainTempChatRenameCandidateIfMatches(
    snapshot: TempChatPointerSnapshot,
    nextPointer: TempChatPointer,
): boolean {
    const next = _normalizePointer(nextPointer);
    if (!next || !snapshot.pointer || !isTempChatSnapshotCurrent(snapshot)) return false;
    const state = _store.getState();
    if (!state.tempChats.some(item => _samePointer(item, snapshot.pointer))) return false;
    const tempChats = [
        ...state.tempChats.filter(item => !_samePointer(item, next)),
        next,
    ];
    _addStoredPointer(next);
    _store.setState({
        ...state,
        tempChats,
    });
    return true;
}

/** Re-scope every quarantined draft after a character avatar rename. */
export function moveTempChatsForCharacter(oldAvatar: string, newAvatar: string): void {
    if (!oldAvatar || !newAvatar || oldAvatar === newAvatar) return;
    const state = _store.getState();
    if (!state.tempChats.some(pointer => pointer.avatar === oldAvatar)) return;
    const tempChats = state.tempChats.map(pointer => (
        pointer.avatar === oldAvatar ? { ...pointer, avatar: newAvatar } : pointer
    ));
    const activeTempChat = state.activeTempChat?.avatar === oldAvatar
        ? { ...state.activeTempChat, avatar: newAvatar }
        : state.activeTempChat;
    const movesActive = state.activeTempChat?.avatar === oldAvatar;
    for (const pointer of state.tempChats) {
        if (pointer.avatar !== oldAvatar) continue;
        if (_addStoredPointer({ ...pointer, avatar: newAvatar })) {
            _removeStoredPointer(pointer);
        }
    }
    _store.setState({
        ...state,
        tempChats,
        activeTempChat,
        activeVersion: movesActive ? state.activeVersion + 1 : state.activeVersion,
    });
}

export function isTempChat(avatar: string, fileName: string): boolean {
    const target = _normalizePointer({ avatar, fileName });
    return !!target && _store.getState().tempChats.some(pointer => _samePointer(pointer, target));
}

/**
 * Match a concrete quarantined file or a post-click file absent from the
 * optimistic draft's known sidebar snapshot.
 */
export function isTempChatDraft(avatar: string, fileName: string): boolean {
    const normalized = _normalizeFileName(fileName);
    if (isTempChat(avatar, normalized)) return true;
    const active = getTempChat();
    if (active?.avatar === avatar) return false;

    const draft = getTempChatDraft();
    if (!draft || draft.avatar !== avatar) return false;
    return normalized !== '' && !draft.knownFileNames.includes(normalized);
}

export function subscribeTempChatStore(callback: (state: TempChatState) => void): () => void {
    return _store.subscribe(callback);
}

/** Hydrate every quarantined pointer; active ownership is re-correlated by CHAT_CHANGED. */
export function initTempChatStore(): void {
    const tempChats = _readStoredPointers();
    _migrateLegacyStorage(tempChats);
    const state = _store.getState();
    _store.setState({
        tempChats,
        activeTempChat: null,
        activeVersion: state.activeVersion + 1,
        optimisticDraft: null,
        draftVersion: state.draftVersion + 1,
    });
    if (!_storageListenerInstalled && typeof window !== 'undefined') {
        _storageListenerInstalled = true;
        window.addEventListener('storage', event => {
            if (event.storageArea !== _storage()) return;
            if (
                event.key !== null
                && !event.key.startsWith(TEMP_CHAT_STORAGE_PREFIX)
                && event.key !== LEGACY_TEMP_CHAT_STORAGE_KEY
            ) return;
            _syncPointersFromStorage();
        });
    }
}
