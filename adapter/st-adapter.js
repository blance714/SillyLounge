/**
 * SillyTavern-ChatUI · ST adapter
 *
 * Boundary module for SillyTavern runtime access.
 * UI/store modules should call this adapter instead of importing ST core files
 * or dispatching native ST DOM buttons directly.
 */

import {
    formatMessageHtml,
    getCharacters,
    getContext,
    getCurrentChat,
    getCurrentChatKey,
    getGenerationState,
    getIsGroupChat,
    getMessageByElement,
    getMessageById,
    getMessageElementById,
    scrollChatToBottom,
    subscribe,
} from './internals.js';
import {
    getNativeComposerTextarea,
    sendComposerMessage,
    setNativeComposerText,
    stopGeneration,
} from './composer.js';
import {
    triggerShellAction,
} from './shell.js';
import {
    getMessageAttachments,
    openMessageFile,
    openMessageMedia,
} from './media.js';
import {
    copyMessage,
    createBranch,
    createCheckpoint,
    deleteMessage,
    editMessage,
    getSwipeLabel,
    isOverflowActionVisible,
    regenerateLast,
    regenerateMessage,
    saveMessageEditById,
    swipeMessage,
    swipeMessageById,
    toggleHideMessage,
    triggerMessageAction,
    triggerMessageActionById,
    triggerOverflowAction,
} from './messages.js';
import {
    clearAttachmentPickerRestore,
    continueMessage,
    getPendingAttachments,
    impersonateMessage,
    listWandItems,
    openAttachmentPicker,
    openDeleteMessageMode,
    regenerateFromPlusMenu,
    removePendingAttachment,
    subscribePendingChanged,
    triggerOptionsAction,
    triggerWandAction,
    triggerWandItem,
} from './menu.js';
import {
    getSelectedSelector,
    getSelectorOptions,
    selectSelector,
} from './selectors.js';
import {
    deleteCharacterChat,
    deleteChatFileIfSafe,
    getCurrentChatHeader,
    getCurrentChatIdentity,
    listCharacterChats,
    listCharacters,
    listCharacterConversations,
    listChatsForCharacter,
    newCharacterChat,
    openCharacterChatByName,
    openChatForCharacter,
    renameCharacterChat,
    switchCharacter,
} from './chats.js';
import {
    read,
    write,
} from './config.js';
import {
    listQuickReplies,
    triggerQuickReply,
    subscribeQuickReplies,
} from './qr.js';
import {
    mountStDrawer,
    unmountStDrawer,
    listStSettingsEntries,
} from './settings.js';

export { stEventKeys } from './internals.js';

export const chatuiAdapter = Object.freeze({
    getContext,
    getCurrentChat,
    getCurrentChatKey,
    getCharacters,
    getMessageById,
    getMessageByElement,
    getMessageElementById,
    formatMessageHtml,
    getGenerationState,
    getIsGroupChat,
    getCurrentChatIdentity,
    subscribe,
    scrollChatToBottom,
    composerActions: Object.freeze({
        getNativeComposerTextarea,
        setNativeComposerText,
        sendComposerMessage,
        stopGeneration,
    }),
    shellActions: Object.freeze({
        triggerShellAction,
    }),
    mediaActions: Object.freeze({
        getMessageAttachments,
        openMessageMedia,
        openMessageFile,
    }),
    messageActions: Object.freeze({
        copyMessage,
        regenerateMessage,
        regenerateLast,
        editMessage,
        saveMessageEditById,
        createBranch,
        createCheckpoint,
        toggleHideMessage,
        deleteMessage,
        swipeMessage,
        swipeMessageById,
        triggerMessageAction,
        triggerMessageActionById,
        getSwipeLabel,
        isOverflowActionVisible,
        triggerOverflowAction,
    }),
    menuActions: Object.freeze({
        triggerOptionsAction,
        regenerateFromPlusMenu,
        continueMessage,
        impersonateMessage,
        openDeleteMessageMode,
        openAttachmentPicker,
        clearAttachmentPickerRestore,
        triggerWandAction,
        listWandItems,
        triggerWandItem,
        getPendingAttachments,
        removePendingAttachment,
        subscribePendingChanged,
    }),
    selectorActions: Object.freeze({
        getSelectorOptions,
        getSelectedSelector,
        selectSelector,
    }),
    sidebarActions: Object.freeze({
        listCharacters,
        switchCharacter,
        listCharacterChats,
        getCurrentChatHeader,
        getCurrentChatIdentity,
        openCharacterChatByName,
        newCharacterChat,
        renameCharacterChat,
        deleteCharacterChat,
        deleteChatFileIfSafe,
        listCharacterConversations,
        listChatsForCharacter,
        openChatForCharacter,
    }),
    configActions: Object.freeze({
        read,
        write,
    }),
    qrActions: Object.freeze({
        listQuickReplies,
        triggerQuickReply,
        subscribeQuickReplies,
    }),
    settingsActions: Object.freeze({
        mountDrawer: mountStDrawer,
        unmountDrawer: unmountStDrawer,
        listEntries: listStSettingsEntries,
    }),
});
