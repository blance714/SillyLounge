import type { createRoot } from 'preact/compat/client';
import { getChatuiState, getMessageDtoById } from '../store/chat-store.js';
import { getConfig } from '../store/config-store.js';
import { triggerChatuiMessageAction } from '../store/chat-actions.js';
import type {
    ChatListItemDto,
    CharacterSummaryDto,
    CharConversationGroupDto,
} from '../adapter/chats.js';

export type ChatuiState = ReturnType<typeof getChatuiState>;
export type ChatuiMessage = NonNullable<ReturnType<typeof getMessageDtoById>>;
export type ChatListItem = ChatListItemDto;
export type CharacterSummary = CharacterSummaryDto;
/**
 * The playbill's view of one character's conversations. Two fields the adapter
 * cannot produce are added on top of its DTO, because both are answers about
 * ChatUI's own quarantine state rather than about what is on disk:
 *
 * - `totalCount` is how many *ordinary* conversations this character has, or
 *   null while that is genuinely unknown (only the recents page has arrived,
 *   which is capped). The playbill header prints「的对话 · N」from this, so a
 *   guess would be a visible lie; `chatSize` is a byte count and answers a
 *   different question entirely.
 * - `draftChats` are the leased, quarantined new-chat files, kept apart from
 *   `chats` rather than mixed into history (DESIGN §4.2). The lease set is the
 *   authority on *which* files these are; the list metadata only decorates
 *   them, so a draft whose row has not been fetched yet still appears.
 */
export type CharConversationGroup = CharConversationGroupDto & {
    totalCount: number | null;
    draftChats: ChatListItem[];
};
export type ChatuiSidebarState = {
    header: {
        sessionName: string;
        characterName: string;
        avatarImgURL: string;
        isGroup: boolean;
    };
    characters: CharacterSummary[];
    chats: ChatListItem[];
    loading: boolean;
    error: string | null;
    charGroups: CharConversationGroup[];
    charGroupsLoading: boolean;
    charGroupsError: string | null;
    loadMoreCharacterChats: (avatar: string) => Promise<void>;
    retryCharacterChats: (avatar: string) => Promise<void>;
};
export type ChatuiConfig = ReturnType<typeof getConfig>;
export type MessageHeaderMode = ChatuiConfig['headerGroup'];
export type PlusToolId = ChatuiConfig['plusPinned'][number];
export type ChatuiAction = Parameters<typeof triggerChatuiMessageAction>[1];
export type RootApi = ReturnType<typeof createRoot>;

// Source of truth: ST_SETTINGS_ENTRIES in adapter/settings.js + CHATUI_SETTINGS_ENTRIES
// in ui/components/settings/SettingsNav.tsx.
type SettingsEntryBase = {
    label: string;
    iconClass: string;
};

export type StSettingsEntry = SettingsEntryBase & {
    id: `st:${string}`;
    section: 'st';
    drawerContentId: string;
};

export type ChatuiSettingsEntry = SettingsEntryBase & {
    id: `chatui:${string}`;
    section: 'chatui';
};

export type SettingsEntry = StSettingsEntry | ChatuiSettingsEntry;
export type SettingsSection = SettingsEntry['section'];
