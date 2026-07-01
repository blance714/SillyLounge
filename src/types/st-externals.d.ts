declare module '@st/extensions' {
    export const extension_settings: Record<string, any>;
}

declare module '@st/script' {
    export const eventSource: any;
    export const event_types: Record<string, string>;
    export const isGenerating: any;
    export const isChatSaving: any;
    export const createOrEditCharacter: any;
    export const deleteCharacterChatByName: any;
    export const deleteMessage: any;
    export const doNewChat: any;
    export const getCurrentChatDetails: any;
    export const getPastCharacterChats: any;
    export const getRequestHeaders: any;
    export const getThumbnailUrl: any;
    export const messageEdit: any;
    export const messageFormatting: any;
    export const openCharacterChat: any;
    export const renameChat: any;
    export const saveSettingsDebounced: any;
    export const selectCharacterById: any;
    export const sendTextareaMessage: any;
    export const swipe: any;
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
}

declare module '*.mjs' {
    export const initChatuiRoot: () => void;
    export const teardownChatuiRoot: () => void;
}

interface Window {
    $?: any;
    this_chid?: unknown;
}
