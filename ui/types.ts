import type { createRoot } from 'preact/compat/client';
import { getChatuiState } from '../store/chat-store.js';
import { getSidebarState } from '../store/sidebar-store.js';
import {
    triggerChatuiMessageAction,
    triggerChatuiShellAction,
} from '../store/chat-actions.js';

export type ChatuiState = ReturnType<typeof getChatuiState>;
export type ChatuiMessage = ChatuiState['chat']['messages'][number];
export type ChatuiSidebarState = ReturnType<typeof getSidebarState>;
export type ChatListItem = ChatuiSidebarState['chats'][number];
export type CharacterSummary = ChatuiSidebarState['characters'][number];
export type ChatuiAction = Parameters<typeof triggerChatuiMessageAction>[1];
export type ShellAction = Parameters<typeof triggerChatuiShellAction>[0];
export type RootApi = ReturnType<typeof createRoot>;
