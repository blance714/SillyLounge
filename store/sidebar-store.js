/**
 * SillyTavern-ChatUI · sidebar store
 *
 * View-model store for the navigation sidebar (Region 5). Slice 1 owns the
 * current character's conversation list (Mode A): a time-sorted chat list plus
 * the active-chat header. Mirrors chat-store.js: it talks only to the adapter,
 * emits plain DTOs, and knows nothing about ST selectors.
 */

import { chatuiAdapter, stEventKeys } from '../adapter/st-adapter.js';
import { createStore } from './create-store.js';

/**
 * @typedef {object} ChatListItemDto
 * @property {string} fileName
 * @property {string} displayName
 * @property {number} messageCount
 * @property {string} preview
 * @property {number} lastMesTs
 * @property {string} lastMesLabel
 * @property {boolean} isCurrent
 */

/**
 * @typedef {object} CharacterSummaryDto
 * @property {string} avatar
 * @property {string} name
 * @property {string} thumbnailUrl
 * @property {boolean} fav
 * @property {boolean} isCurrent
 */

/**
 * @typedef {import('../adapter/chats.js').CharConversationGroupDto} CharConversationGroupDto
 */

/** @type {{ header: { sessionName: string, characterName: string, avatarImgURL: string, isGroup: boolean }, characters: Array<CharacterSummaryDto>, chats: Array<ChatListItemDto>, loading: boolean, error: string|null, charGroups: CharConversationGroupDto[], charGroupsLoading: boolean, charGroupsError: string|null }} */
const _initialState = {
    header: { sessionName: '', characterName: '', avatarImgURL: '', isGroup: false },
    characters: [],
    chats: [],
    loading: false,
    error: null,
    // S4: character-grouped conversation list
    charGroups: /** @type {CharConversationGroupDto[]} */([]),
    charGroupsLoading: false,
    charGroupsError: /** @type {string|null} */(null),
};

const _store = createStore(_initialState);

/** @type {Set<() => void>} */
const _storeUnsubscribers = new Set();

/** @type {Array<() => void>} */
let _unsubscribers = [];

/** Monotonic token so an out-of-order async chat fetch can't clobber a newer one. */
let _loadToken = 0;

let _chatEventRefreshSuppressed = false;
export function setSidebarChatEventRefreshSuppressed(value) {
    _chatEventRefreshSuppressed = !!value;
}

/** Full charGroups rebuild token; targeted patches must not cancel it. */
let _groupsFullLoadToken = 0;

/** Targeted charGroups patch token; full rebuilds must not cancel it. */
let _groupsPatchToken = 0;

/** Completed targeted patches, used so an older full rebuild cannot overwrite them. */
let _groupsPatchVersion = 0;

/** @type {Map<string, number>} */
const _groupPatchVersions = new Map();

/**
 * @returns {typeof _initialState}
 */
export function getSidebarState() {
    return _store.getState();
}

/**
 * @param {Function} subscriber
 * @returns {() => void}
 */
export function subscribeSidebarStore(subscriber) {
    const unsubscribe = _store.subscribe(subscriber);
    _storeUnsubscribers.add(unsubscribe);
    return () => {
        _storeUnsubscribers.delete(unsubscribe);
        unsubscribe();
    };
}

/**
 * Rebuild the synchronous slices — active-chat header + full character list —
 * from the adapter. Cheap (no network), so CHARACTER_* events can use it alone.
 * @param {ReturnType<typeof getSidebarState>} state
 * @returns {ReturnType<typeof getSidebarState>}
 */
function _buildMetaState(state) {
    return {
        ...state,
        header: chatuiAdapter.sidebarActions.getCurrentChatHeader(),
        characters: chatuiAdapter.sidebarActions.listCharacters(),
    };
}

/**
 * Refresh the synchronous slices and emit. Used by CHARACTER_* events, which
 * change the switcher list but not the current chat list.
 * @returns {void}
 */
export function refreshSidebarMeta() {
    _store.setState(_buildMetaState(getSidebarState()));
}

/**
 * @param {CharConversationGroupDto} group
 * @returns {string}
 */
function _groupKey(group) {
    return group.avatar || String(group.charId);
}

/**
 * @param {ChatListItemDto} chat
 * @returns {number}
 */
function _chatRecencyTs(chat) {
    return typeof chat.lastMesTs === 'number' && Number.isFinite(chat.lastMesTs) ? chat.lastMesTs : 0;
}

/**
 * @param {ChatListItemDto[]} chats
 * @returns {ChatListItemDto[]}
 */
function _sortChatsByRecency(chats) {
    return chats.slice().sort((a, b) => _chatRecencyTs(b) - _chatRecencyTs(a));
}

/**
 * @param {CharConversationGroupDto} group
 * @returns {number}
 */
function _groupRecencyTs(group) {
    return group.chats.reduce((max, chat) => Math.max(max, _chatRecencyTs(chat)), 0);
}

/**
 * Stable-sort character groups by their newest loaded chat timestamp.
 * @param {CharConversationGroupDto[]} groups
 * @returns {CharConversationGroupDto[]}
 */
function _sortCharGroupsByRecency(groups) {
    return groups
        .map((group, index) => ({ group, index }))
        .sort((a, b) => (_groupRecencyTs(b.group) - _groupRecencyTs(a.group)) || (a.index - b.index))
        .map(({ group }) => group);
}

/**
 * Preserve targeted patches that completed after a full rebuild began.
 * @param {CharConversationGroupDto[]} rebuilt
 * @param {number} patchVersionAtStart
 * @returns {CharConversationGroupDto[]}
 */
function _mergePatchedGroupsSince(rebuilt, patchVersionAtStart) {
    if (_groupsPatchVersion === patchVersionAtStart) return rebuilt;

    const current = getSidebarState().charGroups;
    const currentByKey = new Map(current.map(group => [_groupKey(group), group]));
    const merged = rebuilt.map(group => {
        const key = _groupKey(group);
        const version = _groupPatchVersions.get(key) ?? 0;
        return version > patchVersionAtStart && currentByKey.has(key) ? currentByKey.get(key) : group;
    });
    const mergedKeys = new Set(merged.map(group => _groupKey(group)));
    for (const group of current) {
        const key = _groupKey(group);
        const version = _groupPatchVersions.get(key) ?? 0;
        if (version > patchVersionAtStart && !mergedKeys.has(key)) {
            merged.push(group);
        }
    }
    return /** @type {CharConversationGroupDto[]} */ (merged);
}

/**
 * Fetch the current character's chats (async — getPastCharacterChats hits the
 * server). Guards loading/error and drops stale responses via _loadToken.
 * @param {ReturnType<typeof getSidebarState>} state
 * @returns {Promise<void>}
 */
async function _refreshSidebarChatsFromState(state) {
    const token = ++_loadToken;
    _store.setState({ ...state, loading: true, error: null });

    try {
        const chats = await chatuiAdapter.sidebarActions.listCharacterChats();
        if (token !== _loadToken) return;
        _store.setState({ ...getSidebarState(), chats, loading: false });
    } catch (error) {
        if (token !== _loadToken) return;
        console.error('[ChatUI] sidebar chat refresh failed', error);
        _store.setState({ ...getSidebarState(), chats: [], loading: false, error: 'load-failed' });
    }
}

/**
 * Fetch the current character's chats (async — getPastCharacterChats hits the
 * server). Guards loading/error and drops stale responses via _loadToken.
 * @returns {Promise<void>}
 */
export async function refreshSidebarChats() {
    await _refreshSidebarChatsFromState(getSidebarState());
}

/**
 * Fetch all character-grouped conversation data (async).
 * Guards stale full-rebuild responses via _groupsFullLoadToken.
 * @param {ReturnType<typeof getSidebarState>} state
 * @returns {Promise<void>}
 */
async function _refreshCharGroupsFromState(state) {
    const token = ++_groupsFullLoadToken;
    const patchVersionAtStart = _groupsPatchVersion;
    _store.setState({ ...state, charGroupsLoading: true, charGroupsError: null });

    try {
        const charGroups = await chatuiAdapter.sidebarActions.listCharacterConversations();
        if (token !== _groupsFullLoadToken) return;
        _store.setState({
            ...getSidebarState(),
            charGroups: _sortCharGroupsByRecency(_mergePatchedGroupsSince(charGroups, patchVersionAtStart)),
            charGroupsLoading: false,
        });
    } catch (error) {
        if (token !== _groupsFullLoadToken) return;
        console.error('[ChatUI] charGroups refresh failed', error);
        _store.setState({
            ...getSidebarState(),
            charGroups: [],
            charGroupsLoading: false,
            charGroupsError: 'load-failed',
        });
    }
}

/**
 * Public: trigger a full charGroups rebuild.
 * @returns {Promise<void>}
 */
export async function refreshCharGroups() {
    await _refreshCharGroupsFromState(getSidebarState());
}

/**
 * @param {string} avatar
 * @returns {{ charId: number, avatar: string }|null}
 */
function _getCharacterTargetByAvatar(avatar) {
    if (typeof avatar !== 'string' || !avatar) return null;
    const ctx = chatuiAdapter.getContext();
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const charId = characters.findIndex(char => char?.avatar === avatar);
    return charId >= 0 ? { charId, avatar } : null;
}

/**
 * @returns {{ charId: number, avatar: string }|null}
 */
function _getCurrentCharacterTarget() {
    const ctx = chatuiAdapter.getContext();
    if (ctx.groupId || ctx.characterId === undefined || ctx.characterId === null) return null;
    const charId = Number(ctx.characterId);
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const avatar = typeof characters[charId]?.avatar === 'string' ? characters[charId].avatar : '';
    return Number.isFinite(charId) && avatar ? { charId, avatar } : null;
}

/**
 * Patch one character group by re-fetching that character's chats only.
 * Falls back to a full rebuild when there is no local group to patch.
 * @param {{ charId: number, avatar: string }} target
 * @returns {Promise<void>}
 */
async function _refreshCharGroupChats(target) {
    const state = getSidebarState();
    const hasGroups = state.charGroups.length > 0;
    const localIndex = state.charGroups.findIndex(group => (
        group.avatar === target.avatar || group.charId === target.charId
    ));

    if (!hasGroups || localIndex < 0) {
        await _refreshCharGroupsFromState(_buildMetaState(getSidebarState()));
        return;
    }

    const token = ++_groupsPatchToken;
    const chats = await chatuiAdapter.sidebarActions.listChatsForCharacter(target.charId);
    if (token !== _groupsPatchToken) return;

    const latestState = getSidebarState();
    const latestIndex = latestState.charGroups.findIndex(group => (
        group.avatar === target.avatar || group.charId === target.charId
    ));
    if (latestIndex < 0 || (latestState.charGroupsLoading && latestState.charGroups.length === 0)) {
        await _refreshCharGroupsFromState(_buildMetaState(latestState));
        return;
    }

    const ctx = chatuiAdapter.getContext();
    const currentCharId = !ctx.groupId && ctx.characterId !== undefined && ctx.characterId !== null
        ? Number(ctx.characterId)
        : -1;
    const refreshedChats = _sortChatsByRecency(chats).slice(0, 5);
    const updated = latestState.charGroups.map(g => ({
        ...g,
        isCurrent: g.charId === currentCharId,
        chats: (g.avatar === target.avatar || g.charId === target.charId)
            ? refreshedChats
            : g.chats.map(chat => (chat.isCurrent ? { ...chat, isCurrent: false } : chat)),
        chatsLoaded: (g.avatar === target.avatar || g.charId === target.charId) ? true : g.chatsLoaded,
    }));
    const ordered = _sortCharGroupsByRecency(updated);
    _groupsPatchVersion += 1;
    _groupPatchVersions.set(target.avatar, _groupsPatchVersion);
    _store.setState({ ...latestState, charGroups: ordered, charGroupsLoading: false, charGroupsError: null });
}

/**
 * Public: refresh one character group by stable avatar.
 * @param {string} avatar
 * @returns {Promise<void>}
 */
export async function refreshCharGroupForCharacter(avatar) {
    const target = _getCharacterTargetByAvatar(avatar);
    if (!target) {
        await _refreshCharGroupsFromState(_buildMetaState(getSidebarState()));
        return;
    }
    await _refreshCharGroupChats(target);
}

/**
 * Cheap partial refresh for the current character's chats within charGroups.
 * Called on CHAT_CHANGED so only the affected group is re-fetched.
 * @returns {Promise<void>}
 */
async function _refreshCurrentCharGroupChats() {
    const target = _getCurrentCharacterTarget();
    if (!target) return;
    await _refreshCharGroupChats(target);
}

/**
 * Refresh header (sync) + chats (async). The async fetch emits the new header
 * alongside its loading flag, so the header updates immediately.
 * Also triggers an independent charGroups rebuild.
 * @returns {void}
 */
export function refreshSidebarStore() {
    void _refreshSidebarChatsFromState(_buildMetaState(getSidebarState()));
    // S4: refresh all char groups (async, independent token)
    void _refreshCharGroupsFromState(getSidebarState());
}

/**
 * @returns {void}
 */
export function initSidebarStore() {
    if (_unsubscribers.length) return;

    refreshSidebarStore();

    // CHAT events fire mid-switch — debounce to the next tick. Each does the CHEAP
    // current-character work only: refresh meta + the current char's Mode-A chats
    // (TopbarMenu reads sidebarState.chats) + its group inside charGroups. No full
    // (up-to-50-character) rebuild on routine chat open/rename/delete.
    const onChatEvent = () => setTimeout(() => {
        if (_chatEventRefreshSuppressed) return;
        refreshSidebarMeta();
        void refreshSidebarChats();
        void _refreshCurrentCharGroupChats();
    }, 0);
    const onMessageEvent = () => setTimeout(() => {
        void refreshSidebarChats();
        void _refreshCurrentCharGroupChats();
    }, 0);
    // Character-set changes (add / remove / rename / duplicate / edit) can alter
    // membership or names → one full charGroups rebuild (+ meta).
    const onCharSetChange = () => setTimeout(() => {
        refreshSidebarMeta();
        void _refreshCharGroupsFromState(getSidebarState());
    }, 0);
    // Pagination re-render only touches ST's own card view; the character set (and
    // thus charGroups) is unchanged — refresh just the switcher list (meta).
    const onPageLoaded = () => setTimeout(() => refreshSidebarMeta(), 0);

    _unsubscribers = [
        chatuiAdapter.subscribe(stEventKeys.CHAT_CHANGED, onChatEvent),
        chatuiAdapter.subscribe(stEventKeys.CHAT_RENAMED, onChatEvent),
        chatuiAdapter.subscribe(stEventKeys.CHAT_DELETED, onChatEvent),
        chatuiAdapter.subscribe(stEventKeys.MESSAGE_SENT, onMessageEvent),
        chatuiAdapter.subscribe(stEventKeys.MESSAGE_RECEIVED, onMessageEvent),
        chatuiAdapter.subscribe(stEventKeys.CHARACTER_EDITED, onCharSetChange),
        chatuiAdapter.subscribe(stEventKeys.CHARACTER_DELETED, onCharSetChange),
        chatuiAdapter.subscribe(stEventKeys.CHARACTER_DUPLICATED, onCharSetChange),
        chatuiAdapter.subscribe(stEventKeys.CHARACTER_RENAMED, onCharSetChange),
        chatuiAdapter.subscribe(stEventKeys.CHARACTER_PAGE_LOADED, onPageLoaded),
    ];
}

/**
 * @returns {void}
 */
export function teardownSidebarStore() {
    for (const unsubscribe of _unsubscribers) {
        unsubscribe();
    }
    _unsubscribers = [];
    for (const unsubscribe of _storeUnsubscribers) {
        unsubscribe();
    }
    _storeUnsubscribers.clear();
}
