/** Pure, collision-free chat identity codec shared by adapter and stores. */

function encodeChatKey(scope: 'group' | 'character' | 'none', id: string, session: string): string {
    return JSON.stringify([scope, id, session]);
}

export function createConversationLocator(session: string): string {
    // Filename is the only host coordinate that distinguishes a branch or
    // checkpoint from the source chat. ST copies chat_metadata (including its
    // integrity slug) into those new files, and legacy chats may receive a new
    // unsaved integrity slug on every load. Rename is handled explicitly by
    // migrating ChatUI-owned state from the old key to the server-confirmed
    // filename instead of pretending integrity is a unique conversation id.
    return `session:${session}`;
}

export function createCharacterChatKey(avatar: string, conversationLocator: string): string {
    return encodeChatKey('character', avatar, conversationLocator);
}

export function createGroupChatKey(groupId: string, conversationLocator: string): string {
    return encodeChatKey('group', groupId, conversationLocator);
}

export function createUnscopedChatKey(conversationLocator: string): string {
    return encodeChatKey('none', '', conversationLocator);
}
