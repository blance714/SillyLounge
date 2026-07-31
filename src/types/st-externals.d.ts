declare module '@st/extensions' {
    export function cancelDebouncedMetadataSave(): void;
    export const extension_settings: Record<string, any>;
}

declare module '@st/script' {
    export function cancelDebouncedChatSave(): void;
    export const eventSource: {
        on(type: string, handler: (...args: any[]) => void): void;
        makeFirst(type: string, handler: (...args: any[]) => void): void;
        makeLast(type: string, handler: (...args: any[]) => void): void;
        removeListener(type: string, handler: (...args: any[]) => void): void;
        emit(type: string, ...args: any[]): Promise<void>;
    };
    export const event_types: Record<string, string>;
    export const isGenerating: any;
    export const isChatSaving: any;
    export const createOrEditCharacter: any;
    export const doNewChat: any;
    export const getCurrentChatDetails: any;
    export function ensureSwipes(message: any): boolean;
    export function extractMessageBias(message: string): string;
    export function getFirstDisplayedMessageId(): number;
    export const getPastCharacterChats: any;
    export const getRequestHeaders: any;
    export const getThumbnailUrl: any;
    export const messageEdit: any;
    export const messageFormatting: any;
    export function refreshSwipeButtons(updateCounters?: boolean, fade?: boolean): void;
    export function removeMacros(text: string): string;
    export function saveChatConditional(): Promise<void>;
    export function saveChatDebounced(): void;
    export const openCharacterChat: any;
    export const renameChat: any;
    export const saveSettingsDebounced: any;
    export function saveSettings(): Promise<void>;
    export const selectCharacterById: any;
    export function setActiveCharacter(entityOrKey?: object | number | string | null): void;
    export function setActiveGroup(entityOrKey?: object | number | string | null): void;
    export function sendTextareaMessage(): Promise<unknown>;
    export function setEditedMessageId(value: number | undefined): void;
    export function stopGeneration(): boolean;
    export function substituteParams(content: string, options?: Record<string, unknown>): string;
    export const swipe: any;
    export const swipeState: string;
    export const syncSwipeToMes: any;
    export const system_message_types: Record<string, string>;
    export function updateViewMessageIds(startIndex?: number | null): void;
    export function updateEditArrowClasses(): void;
}

declare module '@st/itemized-prompts' {
    export function deleteItemizedPromptForMessage(messageId: number): void;
}

declare module '@st/regex-engine' {
    export function getRegexedString(rawString: string, placement: number, params?: {
        characterOverride?: string;
        isMarkdown?: boolean;
        isPrompt?: boolean;
        isEdit?: boolean;
        depth?: number;
    }): string;
    export const regex_placement: {
        MD_DISPLAY: number;
        USER_INPUT: number;
        AI_OUTPUT: number;
        SLASH_COMMAND: number;
        WORLD_INFO: number;
        REASONING: number;
    };
}

declare module '@st/slash-commands' {
    export const isExecutingCommandsFromChatInput: boolean;
}

declare module '@st/st-context' {
    export function getContext(): any;
}

declare module '@st/utils' {
    export const copyText: any;
    export const timestampToMoment: any;
}

declare module '@st/bookmarks' {
    export const branchChat: any;
    export const createNewBookmark: any;
}

declare module '@st/chats' {
    export function hasPendingFileAttachment(): boolean;
    export const hideChatMessage: any;
    export const unhideChatMessage: any;
}

declare module '@st/personas' {
    export const getUserAvatars: any;
    export const setUserAvatar: any;
    export const user_avatar: any;
}

declare module '@st/scripts/RossAscends-mods' {
    export const favsToHotswap: any;
    export function humanizedDateTime(timestamp?: number): string;
}

declare module '*.mjs' {
    export const initChatuiRoot: () => void;
    export const teardownChatuiRoot: () => void;
}

interface Window {
    $?: any;
    this_chid?: unknown;
}
