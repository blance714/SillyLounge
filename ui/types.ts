import type { createRoot } from 'preact/compat/client';
import { getChatuiState } from '../store/chat-store.js';
import { getConfig } from '../store/config-store.js';
import {
    triggerChatuiMessageAction,
    triggerChatuiShellAction,
} from '../store/chat-actions.js';

export type ChatuiState = ReturnType<typeof getChatuiState>;
export type ChatuiMessage = ChatuiState['chat']['messages'][number];
export type ChatListItem = {
    fileName: string;
    displayName: string;
    messageCount: number;
    preview: string;
    fileSize: string;
    lastMesTs: number;
    lastMesLabel: string;
    isCurrent: boolean;
};
export type CharacterSummary = {
    avatar: string;
    name: string;
    thumbnailUrl: string;
    fav: boolean;
    isCurrent: boolean;
    charId: number;
    chatSize: number;
    dateLastChatTs: number;
};
export type CharConversationGroup = {
    charId: number;
    avatar: string;
    name: string;
    thumbnailUrl: string;
    isCurrent: boolean;
    dateLastChatTs: number;
    chatSize: number;
    chats: ChatListItem[];
    visibleCount: number;
    chatsLoaded: boolean;
    fullyLoaded: boolean;
    pending: null | 'backfill' | 'more' | 'refresh' | 'error';
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
// Source of truth: MESSAGE_HEADERS / MessageHeaderValue in store/config-store.js
// (mirrors the SidebarForm literal-union pattern in components/sidebar/Sidebar.tsx).
export type MessageHeaderMode = 'icon' | 'name' | 'none';
export type ChatuiAction = Parameters<typeof triggerChatuiMessageAction>[1];
export type ShellAction = Parameters<typeof triggerChatuiShellAction>[0];
export type RootApi = ReturnType<typeof createRoot>;

// Source of truth: ST_SETTINGS_ENTRIES in adapter/settings.js + CHATUI_SETTINGS_ENTRIES
// in ui/components/settings/SettingsNav.tsx.
export type SettingsSection = 'st' | 'chatui';

export type SettingsEntry = {
    id: string;           // 'st:<drawerContentId>' or 'chatui:<key>'
    section: SettingsSection;
    label: string;        // displayed in nav
    iconClass: string;    // Font Awesome class
    drawerContentId?: string; // only for section 'st'; matches DOM id attribute
};
