/**
 * SillyTavern-ChatUI · chat adapter compatibility facade
 *
 * Keep this public module stable while the implementation is split by query,
 * navigation, durable-selection, and mutation-transaction responsibilities.
 */

export type {
    ChatListItemDto,
    CharConversationGroupDto,
    CharacterSummaryDto,
    CurrentChatHeaderDto,
    CurrentChatIdentityDto,
    DeleteCharacterChatResultDto,
    RenameCharacterChatResultDto,
} from './chats/state.js';


export {
    getCurrentChatHeader,
    getCurrentChatIdentity,
} from './chats/state.js';

export {
    listRecentCharacterChatRows,
    listChatsForCharacterAvatar,
    listCharacters,
} from './chats/queries.js';

export {
    openChatForCharacter,
    switchCharacter,
    selectCharacterIfNobodyIsOnStage,
    openCharacterChatByName,
    newCharacterChat,
} from './chats/navigation.js';

export { renameCharacterChat } from './chats/rename-transaction.js';
export { deleteCharacterChat } from './chats/delete-transaction.js';

export {
    queueCurrentCharacterChatDeletionFinalization,
    finalizePendingCharacterChatDeletion,
    queueCharacterChatLanding,
    armPendingCharacterChatLanding,
} from './chats/deletion-finalization.js';
