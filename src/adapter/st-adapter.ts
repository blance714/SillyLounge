/**
 * SillyTavern-ChatUI · ST adapter
 *
 * Boundary module for SillyTavern runtime access.
 * UI/store modules should call this adapter instead of importing ST core files
 * or dispatching native ST DOM buttons directly.
 */

import {
    getCurrentChatKey,
    getCurrentMessageCount,
    getCurrentMessageIndexSnapshotById,
    getCurrentMessageIndexSnapshots,
    getCurrentMessageSnapshotById,
    getGenerationState,
    getIsGroupChat,
    formatMessageHtmlById,
    subscribe,
    subscribeFirst,
    subscribeLast,
} from './internals.js';
import {
    sendComposerMessage,
    stopGeneration,
} from './composer.js';
import {
    getMessageAttachmentsById,
    openMessageFile,
    openMessageMedia,
} from './media.js';
import {
    copyMessageAsPlainText,
    deleteMessageWithIntent,
    getConfirmMessageDeleteSetting,
    getDeleteEligibility,
    saveMessageEditById,
    swipeMessageById,
    swipeMessageToIndexById,
    triggerMessageActionById,
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
    queueCurrentCharacterChatDeletionFinalization,
    queueCharacterChatDraftQuarantine,
    armPendingCharacterChatDraftQuarantine,
    peekPendingCharacterChatDraftQuarantine,
    resolvePendingCharacterChatDraftQuarantine,
    getCurrentChatHeader,
    getCurrentChatIdentity,
    hasCharacterChatFile,
    listCharacterChats,
    listCharacters,
    listCharacterConversationHeaders,
    listChatsForCharacterAvatar,
    listRecentCharacterChatRows,
    newCharacterChat,
    openCharacterChatByName,
    openChatForCharacter,
    renameCharacterChat,
    selectCharacterIfNobodyIsOnStage,
    switchCharacter,
} from './chats.js';
import {
    flushSettings,
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
    getCurrentChatKey,
    getGenerationState,
    getIsGroupChat,
    getCurrentChatIdentity,
    subscribe,
    subscribeFirst,
    subscribeLast,
    messageQueries: Object.freeze({
        readIndex: getCurrentMessageIndexSnapshots,
        readIndexById: getCurrentMessageIndexSnapshotById,
        readById: getCurrentMessageSnapshotById,
        getCount: getCurrentMessageCount,
        formatHtmlById: formatMessageHtmlById,
        getAttachmentsById: getMessageAttachmentsById,
    }),
    composerActions: Object.freeze({
        sendComposerMessage,
        stopGeneration,
    }),
    mediaActions: Object.freeze({
        openMessageMedia,
        openMessageFile,
    }),
    messageActions: Object.freeze({
        copyMessageAsPlainText,
        saveMessageEditById,
        swipeMessageById,
        swipeMessageToIndexById,
        triggerMessageActionById,
        deleteMessageWithIntent,
        getConfirmMessageDeleteSetting,
        getDeleteEligibility,
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
        selectCharacterIfNobodyIsOnStage,
        listCharacterChats,
        getCurrentChatHeader,
        getCurrentChatIdentity,
        hasCharacterChatFile,
        openCharacterChatByName,
        newCharacterChat,
        renameCharacterChat,
        deleteCharacterChat,
        queueCurrentCharacterChatDeletionFinalization,
        queueCharacterChatDraftQuarantine,
        armPendingCharacterChatDraftQuarantine,
        peekPendingCharacterChatDraftQuarantine,
        resolvePendingCharacterChatDraftQuarantine,
        listCharacterConversationHeaders,
        listRecentCharacterChatRows,
        listChatsForCharacterAvatar,
        openChatForCharacter,
    }),
    configActions: Object.freeze({
        read,
        write,
        flushSettings,
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
