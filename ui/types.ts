import type { createRoot } from 'preact/compat/client';
import { getChatuiState } from '../store/chat-store.js';
import {
    triggerChatuiMessageAction,
    triggerChatuiShellAction,
} from '../store/chat-actions.js';

export type ChatuiState = ReturnType<typeof getChatuiState>;
export type ChatuiMessage = ChatuiState['chat']['messages'][number];
export type ChatuiAction = Parameters<typeof triggerChatuiMessageAction>[1];
export type ShellAction = Parameters<typeof triggerChatuiShellAction>[0];
export type RootApi = ReturnType<typeof createRoot>;
