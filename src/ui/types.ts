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
export type CharConversationGroup = CharConversationGroupDto;
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
