// test/helpers/fake-st-host.mjs
//
// Builds a disposable, deployment-shaped scratch tree so the compiled
// dist/runtime/**/*.js modules can be imported by plain `node --test`
// files without a real SillyTavern host. See the module doc comment
// below `createFakeStHost` for the full API.
//
// How it works
// ------------
// The build (scripts/build.mjs) rewrites every `@st/*` host import in
// dist/runtime/**/*.js to a *relative* path, computed as if the file were
// deployed at:
//
//   <stRoot>/public/scripts/extensions/third-party/SillyLounge/<relPath>
//
// (scripts/runtime.mjs confirms this: it copies the *contents* of
// dist/runtime straight into the extension root, and dist/root-app.mjs to
// <extensionRoot>/dist/root-app.mjs.) So to make those relative imports
// resolve, this helper mkdtemps a tree shaped the same way:
//
//   <tmp>/public/script.js
//   <tmp>/public/scripts/{extensions,chats,slash-commands,personas,
//                          st-context,utils,bookmarks,RossAscends-mods,
//                          itemized-prompts}.js
//   <tmp>/public/scripts/extensions/third-party/SillyLounge/   <- dist/runtime, copied (not symlinked)
//   <tmp>/public/scripts/extensions/third-party/SillyLounge/dist/root-app.mjs
//   <tmp>/package.json                                         <- {"type":"module"}, so the
//                                                                  copied .js files parse as ESM
//
// and writes small hand-written stub modules at every one of those host
// import targets. The set of stubbed names was produced by grepping
// dist/runtime/**/*.js for every `from "<relative path ending outside the
// extension>"` import (see the shell transcript in the PR/commit that
// introduced this file) - it is not guessed.
//
// Every stub module that exposes a *function* (isGenerating,
// getCurrentChatDetails, deleteMessage, ...) is a thin call-through into a
// single mutable `registry` object that lives in a per-host "bridge"
// module written alongside the copied runtime
// (SillyLounge/__fake_host_bridge__.mjs). Tests assign implementations
// directly onto `host.registry`:
//
//   host.registry.getCurrentChatDetails = () => ({ sessionName: 'a.jsonl' });
//
// Calling a registry function that has no implementation assigned throws
// `Error: stub not configured: <name>` — this harness never silently
// returns undefined for a host call the test didn't set up.
//
// A handful of ST exports are plain *values*, not functions
// (`swipeState`, `isChatSaving`, `isExecutingCommandsFromChatInput`,
// `user_avatar`) — ES module named exports are live bindings, so these are
// declared with `let` inside their own stub file and mutated through a
// private setter exported from that same file. createFakeStHost() grabs a
// handle on those setters at creation time and exposes them as
// `host.state.*` below.
//
// eventSource/event_types/getContext() are *not* registry passthroughs:
// they are small working fakes (a real pub/sub bus, a frozen map of event
// names, a plain mutable object) because that is what the dist code
// actually needs to function, not something a test should have to
// re-implement per test file. The one exception living inside
// getContext()'s object is `callGenericPopup` — dist code needs per-test
// control over the user's popup choice (confirm/cancel/custom-button), so
// it's the one `context.*` property that IS a registry passthrough
// (`host.registry.callGenericPopup = ...`), same rules as every other
// registry function.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DIST_RUNTIME_DIR = path.join(REPO_ROOT, 'dist', 'runtime');
const DIST_ROOT_APP_FILE = path.join(REPO_ROOT, 'dist', 'root-app.mjs');
const DIST_ROOT_APP_MAP_FILE = `${DIST_ROOT_APP_FILE}.map`;

const BRIDGE_FILENAME = '__fake_host_bridge__.mjs';
const DEFAULT_MAX_TIMER_INVOCATIONS = 1000;

// Relative path from every public/scripts/*.js stub sibling to the bridge
// module. (public/script.js needs one extra "scripts/" hop — handled
// separately below.)
const BRIDGE_FROM_SCRIPTS_SIBLING = './extensions/third-party/SillyLounge/' + BRIDGE_FILENAME;
const BRIDGE_FROM_PUBLIC_ROOT = './scripts/extensions/third-party/SillyLounge/' + BRIDGE_FILENAME;

// The full set of `stEventKeys` names dist/runtime/adapter/internals.js
// resolves through `event_types`, plus APP_READY (the one event index.js
// subscribes to directly at module-evaluation time). Grepped, not guessed.
const EVENT_TYPE_KEYS = [
    'APP_READY',
    'CHARACTER_MESSAGE_RENDERED',
    'USER_MESSAGE_RENDERED',
    'MESSAGE_SWIPED',
    'MESSAGE_SWIPE_DELETED',
    'MESSAGE_EDITED',
    'MESSAGE_UPDATED',
    'MESSAGE_DELETED',
    'MESSAGE_FILE_EMBEDDED',
    'MESSAGE_REASONING_EDITED',
    'MESSAGE_REASONING_DELETED',
    'MESSAGE_SENT',
    'MESSAGE_RECEIVED',
    'CHAT_CHANGED',
    'CHAT_RENAMED',
    'CHAT_DELETED',
    'CHAT_LOADED',
    'CHARACTER_EDITED',
    'CHARACTER_DELETED',
    'CHARACTER_DUPLICATED',
    'CHARACTER_RENAMED',
    'CHARACTER_PAGE_LOADED',
    'MORE_MESSAGES_LOADED',
    'GENERATION_STARTED',
    'GENERATION_STOPPED',
    'GENERATION_ENDED',
    'GROUP_WRAPPER_FINISHED',
    'STREAM_TOKEN_RECEIVED',
    'STREAM_REASONING_DONE',
    'PRESET_CHANGED',
    'OAI_PRESET_CHANGED_AFTER',
    'CONNECTION_PROFILE_LOADED',
    'PERSONA_CHANGED',
];

async function pathExists(p) {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------
// Stub module source generation
// ---------------------------------------------------------------------

function bridgeModuleSource() {
    return `// Generated by test/helpers/fake-st-host.mjs — do not edit by hand.
// Shared mutable state for this scratch tree's stub host modules. Every
// stub file (public/script.js, public/scripts/*.js) imports from here;
// createFakeStHost() also imports this exact file to hand the same
// objects to the test.

export const registry = Object.create(null);

export function callStub(name, args) {
    const impl = registry[name];
    if (typeof impl !== 'function') {
        throw new Error(\`stub not configured: \${name}\`);
    }
    return impl(...args);
}

export function makeStub(name) {
    return (...args) => callStub(name, args);
}

// ---- eventSource: a small real EventEmitter2-shaped pub/sub bus -------
//
// Real ST event ordering: makeFirst() handlers run before on()/subscribe()
// handlers, which run before makeLast() handlers. emit() is awaited by
// callers, so it awaits each handler's return value in registration order.

function createEventSource() {
    const first = new Map();
    const normal = new Map();
    const last = new Map();

    function bucketAdd(bucket, type, handler) {
        let handlers = bucket.get(type);
        if (!handlers) {
            handlers = [];
            bucket.set(type, handlers);
        }
        handlers.push(handler);
    }

    function removeFrom(bucket, type, handler) {
        const handlers = bucket.get(type);
        if (!handlers) return false;
        const index = handlers.indexOf(handler);
        if (index === -1) return false;
        handlers.splice(index, 1);
        return true;
    }

    return {
        on(type, handler) {
            bucketAdd(normal, type, handler);
        },
        makeFirst(type, handler) {
            bucketAdd(first, type, handler);
        },
        makeLast(type, handler) {
            bucketAdd(last, type, handler);
        },
        off(type, handler) {
            this.removeListener(type, handler);
        },
        removeListener(type, handler) {
            removeFrom(first, type, handler) || removeFrom(normal, type, handler) || removeFrom(last, type, handler);
        },
        async emit(type, ...args) {
            const handlers = [
                ...(first.get(type) ?? []),
                ...(normal.get(type) ?? []),
                ...(last.get(type) ?? []),
            ];
            const results = [];
            for (const handler of handlers) {
                results.push(await handler(...args));
            }
            return results;
        },
        listenerCount(type) {
            return (first.get(type)?.length ?? 0) + (normal.get(type)?.length ?? 0) + (last.get(type)?.length ?? 0);
        },
    };
}

export const eventSource = createEventSource();

export const event_types = Object.freeze({
${EVENT_TYPE_KEYS.map(key => `    ${key}: '${key}',`).join('\n')}
});

// ---- getContext(): a single mutable object, mutate its properties -----
// (do not reassign host.context to a new object — getContext() always
// returns this exact reference; replacing it would desync the two).

export const context = {
    chat: [],
    characters: [],
    characterId: undefined,
    groupId: undefined,
    name1: undefined,
    name2: undefined,
    extensionSettings: {},
    powerUserSettings: {},
    // Live-reference mutation target for the deleteMessage() swipe-only
    // mini-fork's \`chat_metadata.tainted = true\` write (script.js:9323's
    // deleteSwipe() does the same) — see adapter/messages.ts::_deleteSwipeById.
    chatMetadata: {},
    // Real ST values (public/scripts/popup.js) — kept exact so contract
    // tests can assert against the same constants dist code compares
    // against (e.g. \`result === POPUP_RESULT.AFFIRMATIVE\`).
    POPUP_TYPE: Object.freeze({ TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 }),
    POPUP_RESULT: Object.freeze({
        AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null,
        CUSTOM1: 1001, CUSTOM2: 1002, CUSTOM3: 1003,
    }),
    // Non-localized identity tag — real ST's \`t\` (scripts/i18n.js) applies a
    // locale lookup dist code must not depend on for its literal wording;
    // tests assert against the untranslated English strings this reproduces.
    t: (strings, ...values) => strings.reduce((acc, part, i) => acc + part + (values[i] ?? ''), ''),
    // Per-test override target for adapter/messages.ts's delete-confirmation
    // popup (getContext().callGenericPopup, re-exported from
    // public/scripts/popup.js). Registry-backed like every other stubbed
    // host function: unconfigured calls throw "stub not configured", never
    // silently resolve.
    callGenericPopup: makeStub('callGenericPopup'),
};
`;
}

function scriptJsSource() {
    return `// Generated stub for @st/script (public/script.js).
import { eventSource, event_types, makeStub } from '${BRIDGE_FROM_PUBLIC_ROOT}';

export { eventSource, event_types };

export const saveSettingsDebounced = makeStub('saveSettingsDebounced');
export const stopGeneration = makeStub('stopGeneration');
export const extractMessageBias = makeStub('extractMessageBias');
export const removeMacros = makeStub('removeMacros');
export const sendTextareaMessage = makeStub('sendTextareaMessage');
export const isGenerating = makeStub('isGenerating');
export const getCurrentChatDetails = makeStub('getCurrentChatDetails');
export const messageFormatting = makeStub('messageFormatting');
export const openCharacterChat = makeStub('openCharacterChat');
export const selectCharacterById = makeStub('selectCharacterById');
export const createOrEditCharacter = makeStub('createOrEditCharacter');
export const doNewChat = makeStub('doNewChat');
export const cancelDebouncedChatSave = makeStub('cancelDebouncedChatSave');
export const getRequestHeaders = makeStub('getRequestHeaders');
export const messageEdit = makeStub('messageEdit');
export const swipe = makeStub('swipe');
export const deleteSwipe = makeStub('deleteSwipe');
export const syncSwipeToMes = makeStub('syncSwipeToMes');
export const saveChatConditional = makeStub('saveChatConditional');
export const getThumbnailUrl = makeStub('getThumbnailUrl');
export const getPastCharacterChats = makeStub('getPastCharacterChats');

// DOM-DECOUPLING.md Tier 2 (adapter/messages.ts's _deleteFullMessageById
// fork): every one of these is a real ST host behavior this repo
// deliberately does NOT reimplement (see that function's doc comment) --
// dist code's job is only to call them with the right arguments in the right
// order, which these registry stubs let tests observe directly.
export const getFirstDisplayedMessageId = makeStub('getFirstDisplayedMessageId');
export const updateViewMessageIds = makeStub('updateViewMessageIds');
export const saveChatDebounced = makeStub('saveChatDebounced');
export const setEditedMessageId = makeStub('setEditedMessageId');
export const refreshSwipeButtons = makeStub('refreshSwipeButtons');
// _renumberRenderedRowsAfterDelete (adapter/messages.ts) calls this
// unconditionally after doing its own DOM-tolerant renumber (see that
// function's doc comment for why it owns the renumber but still delegates
// this one call to native unmodified). Real native updateEditArrowClasses
// (script.js:9427) reads jQuery's module-level chatElement, which this
// harness's fake DOM has no jQuery to back -- so, like
// getFirstDisplayedMessageId/updateViewMessageIds above, it's a
// registry-backed stub here: tests can assert it *was* called, not what it
// would have done to the DOM.
export const updateEditArrowClasses = makeStub('updateEditArrowClasses');

// Plain-value ST exports (read without calling) — live bindings, mutated
// only through the private setters below.
export let swipeState = 'none';
export function __setSwipeState(value) { swipeState = value; }

export let isChatSaving = false;
export function __setIsChatSaving(value) { isChatSaving = value; }
`;
}

function extensionsJsSource() {
    return `// Generated stub for @st/extensions (public/scripts/extensions.js).
import { makeStub } from '${BRIDGE_FROM_SCRIPTS_SIBLING}';

// A plain object whose *properties* dist code reads/writes
// (extension_settings[MODULE] = ...); never reassigned as a binding, so a
// live-binding setter isn't needed.
export const extension_settings = {};

export const cancelDebouncedMetadataSave = makeStub('cancelDebouncedMetadataSave');
`;
}

function chatsJsSource() {
    return `// Generated stub for @st/chats (public/scripts/chats.js).
import { makeStub } from '${BRIDGE_FROM_SCRIPTS_SIBLING}';

export const hasPendingFileAttachment = makeStub('hasPendingFileAttachment');
export const unhideChatMessage = makeStub('unhideChatMessage');
export const hideChatMessage = makeStub('hideChatMessage');
`;
}

function slashCommandsJsSource() {
    return `// Generated stub for @st/slash-commands (public/scripts/slash-commands.js).

// Plain-value ST export (read without calling) — live binding.
export let isExecutingCommandsFromChatInput = false;
export function __setIsExecutingCommandsFromChatInput(value) { isExecutingCommandsFromChatInput = value; }
`;
}

function personasJsSource() {
    return `// Generated stub for @st/personas (public/scripts/personas.js).
import { makeStub } from '${BRIDGE_FROM_SCRIPTS_SIBLING}';

export const setUserAvatar = makeStub('setUserAvatar');
export const getUserAvatars = makeStub('getUserAvatars');

// Plain-value ST export (read without calling) — live binding.
export let user_avatar = null;
export function __setUserAvatar(value) { user_avatar = value; }
`;
}

function stContextJsSource() {
    return `// Generated stub for @st/st-context (public/scripts/st-context.js).
import { context } from '${BRIDGE_FROM_SCRIPTS_SIBLING}';

export function getContext() {
    return context;
}
`;
}

function utilsJsSource() {
    return `// Generated stub for @st/utils (public/scripts/utils.js).
import { makeStub } from '${BRIDGE_FROM_SCRIPTS_SIBLING}';

export const copyText = makeStub('copyText');
export const timestampToMoment = makeStub('timestampToMoment');
`;
}

function bookmarksJsSource() {
    return `// Generated stub for @st/bookmarks (public/scripts/bookmarks.js).
import { makeStub } from '${BRIDGE_FROM_SCRIPTS_SIBLING}';

export const createNewBookmark = makeStub('createNewBookmark');
export const branchChat = makeStub('branchChat');
`;
}

function itemizedPromptsJsSource() {
    return `// Generated stub for @st/itemized-prompts (public/scripts/itemized-prompts.js).
import { makeStub } from '${BRIDGE_FROM_SCRIPTS_SIBLING}';

export const deleteItemizedPromptForMessage = makeStub('deleteItemizedPromptForMessage');
`;
}

function rossAscendsModsJsSource() {
    return `// Generated stub for @st/scripts/RossAscends-mods (public/scripts/RossAscends-mods.js).
import { makeStub } from '${BRIDGE_FROM_SCRIPTS_SIBLING}';

export const humanizedDateTime = makeStub('humanizedDateTime');
export const favsToHotswap = makeStub('favsToHotswap');
`;
}

// ---------------------------------------------------------------------
// window/document/localStorage/fetch fakes
// ---------------------------------------------------------------------
//
// None of dist/runtime/**/*.js touches these at module-evaluation time
// (verified by grepping for top-level, non-declaration statements — the
// only one found is index.js's top-level `eventSource.on(...)`, already
// covered above). They're still provided, unconditionally, because dist
// code *does* reach for them at call time (bare `window`, `document`,
// `requestAnimationFrame`, `MutationObserver`, `HTMLElement`, ... —
// checked by grep) and a test exercising that call time needs a
// no-op-safe stand-in rather than a ReferenceError. This is intentionally
// not a real DOM: getElementById/createElement/classList/attributes work;
// compound CSS selectors (querySelector("a b.c")) are out of scope and
// resolve to null/[]. Full DOM behaviour is covered by this repo's
// Chromium e2e harness (test/e2e/), not this unit-test harness.

class FakeClassList {
    constructor() {
        this._set = new Set();
    }
    add(...names) {
        for (const name of names) this._set.add(name);
    }
    remove(...names) {
        for (const name of names) this._set.delete(name);
    }
    toggle(name, force) {
        const has = this._set.has(name);
        const shouldHave = force === undefined ? !has : Boolean(force);
        if (shouldHave) this._set.add(name); else this._set.delete(name);
        return shouldHave;
    }
    contains(name) {
        return this._set.has(name);
    }
    toString() {
        return [...this._set].join(' ');
    }
    [Symbol.iterator]() {
        return this._set[Symbol.iterator]();
    }
}

class FakeElement extends EventTarget {
    constructor(tagName, ownerDocument) {
        super();
        this.tagName = String(tagName ?? 'div').toUpperCase();
        this.ownerDocument = ownerDocument ?? null;
        this._attributes = new Map();
        this.classList = new FakeClassList();
        this.style = {};
        this.children = [];
        this.parentElement = null;
        this.parentNode = null;
        this._text = '';
    }
    get id() {
        return this._attributes.get('id') ?? '';
    }
    set id(value) {
        this.setAttribute('id', value);
    }
    get className() {
        return this.classList.toString();
    }
    set className(value) {
        this.classList = new FakeClassList();
        String(value).split(/\\s+/).filter(Boolean).forEach(name => this.classList.add(name));
    }
    get textContent() {
        return this._text;
    }
    set textContent(value) {
        this._text = String(value);
        this.children = [];
    }
    get outerHTML() {
        return `<${this.tagName.toLowerCase()}></${this.tagName.toLowerCase()}>`;
    }
    get isConnected() {
        let node = this;
        while (node.parentElement) node = node.parentElement;
        return Boolean(this.ownerDocument) && node === this.ownerDocument.documentElement;
    }
    get nextSibling() {
        if (!this.parentElement) return null;
        const siblings = this.parentElement.children;
        return siblings[siblings.indexOf(this) + 1] ?? null;
    }
    setAttribute(name, value) {
        this._attributes.set(name, String(value));
        if (name === 'id' && this.ownerDocument) this.ownerDocument._registerId(String(value), this);
    }
    getAttribute(name) {
        return this._attributes.has(name) ? this._attributes.get(name) : null;
    }
    removeAttribute(name) {
        this._attributes.delete(name);
    }
    hasAttribute(name) {
        return this._attributes.has(name);
    }
    appendChild(child) {
        child.parentElement = this;
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index !== -1) this.children.splice(index, 1);
        child.parentElement = null;
        child.parentNode = null;
        return child;
    }
    insertBefore(child, reference) {
        const index = reference ? this.children.indexOf(reference) : -1;
        if (index === -1) return this.appendChild(child);
        this.children.splice(index, 0, child);
        child.parentElement = this;
        child.parentNode = this;
        return child;
    }
    remove() {
        if (this.parentElement) this.parentElement.removeChild(this);
    }
    // No-op-safe: only `#id` is supported, everything else resolves to
    // null/[] rather than throwing. See module doc comment above.
    querySelector(selector) {
        if (typeof selector === 'string' && /^#[\\w-]+$/.test(selector) && this.ownerDocument) {
            return this.ownerDocument.getElementById(selector.slice(1));
        }
        return null;
    }
    querySelectorAll() {
        return [];
    }
}

class FakeDocument extends EventTarget {
    constructor() {
        super();
        this._byId = new Map();
        this.documentElement = new FakeElement('html', this);
        this.body = new FakeElement('body', this);
        this.documentElement.appendChild(this.body);
    }
    _registerId(id, element) {
        if (id) this._byId.set(id, element);
    }
    createElement(tagName) {
        return new FakeElement(tagName, this);
    }
    getElementById(id) {
        return this._byId.get(id) ?? null;
    }
    querySelector(selector) {
        if (typeof selector === 'string' && /^#[\w-]+$/.test(selector)) {
            return this.getElementById(selector.slice(1));
        }
        return null;
    }
    querySelectorAll() {
        return [];
    }
}

class FakeMutationObserver {
    constructor(callback) {
        this._callback = callback;
    }
    observe() {}
    disconnect() {}
    takeRecords() {
        return [];
    }
}

class FakeMouseEvent extends Event {
    constructor(type, init = {}) {
        super(type, init);
        this.button = init.button ?? 0;
        this.clientX = init.clientX ?? 0;
        this.clientY = init.clientY ?? 0;
    }
}

function createTimerEngine(maxInvocations) {
    let nextId = 1;
    let invocationCount = 0;
    const pending = new Map();

    function schedule(fn, args) {
        invocationCount += 1;
        if (invocationCount > maxInvocations) {
            throw new Error(
                `fake-st-host: a timer/animation-frame callback was scheduled more than ${maxInvocations} times — ` +
                'this usually means a retry/refresh loop is re-scheduling itself without ever settling.',
            );
        }
        const id = nextId++;
        const handle = setImmediate(() => {
            pending.delete(id);
            fn(...args);
        });
        pending.set(id, handle);
        return id;
    }

    function cancel(id) {
        const handle = pending.get(id);
        if (handle !== undefined) {
            clearImmediate(handle);
            pending.delete(id);
        }
    }

    return { schedule, cancel };
}

class FakeWindow extends EventTarget {
    constructor(timerEngine) {
        super();
        this._timerEngine = timerEngine;
        this.location = {
            href: 'http://localhost/',
            reload: () => {},
        };
        this.this_chid = undefined;
        this.$ = undefined;
    }
    getComputedStyle(element) {
        return { display: element?.style?.display ?? '' };
    }
    setTimeout(fn, _delay, ...args) {
        return this._timerEngine.schedule(fn, args);
    }
    clearTimeout(id) {
        this._timerEngine.cancel(id);
    }
    requestAnimationFrame(fn) {
        return this._timerEngine.schedule(fn, []);
    }
    cancelAnimationFrame(id) {
        this._timerEngine.cancel(id);
    }
}

function createLocalStorage() {
    const store = new Map();
    return {
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(String(key), String(value));
        },
        removeItem(key) {
            store.delete(key);
        },
        clear() {
            store.clear();
        },
        key(index) {
            return [...store.keys()][index] ?? null;
        },
        get length() {
            return store.size;
        },
    };
}

function createFetchController() {
    const calls = [];
    let handler = null;
    async function fakeFetch(input, init) {
        calls.push({ input, init });
        if (typeof handler !== 'function') {
            const url = typeof input === 'string' ? input : (input && input.url) || String(input);
            throw new Error(`stub not configured: fetch ${url}`);
        }
        return handler(input, init);
    }
    return {
        fn: fakeFetch,
        calls,
        setHandler(fn) {
            handler = fn;
        },
        reset() {
            handler = null;
            calls.length = 0;
        },
    };
}

// ---------------------------------------------------------------------
// createFakeStHost
// ---------------------------------------------------------------------

/**
 * Build a disposable, deployment-shaped scratch tree and import compiled
 * dist/runtime modules out of it.
 *
 * @param {object} [options]
 * @param {number} [options.maxTimerInvocations] Guard threshold for the
 *   deterministic setTimeout/requestAnimationFrame fake (default 1000).
 *   Exceeding it throws synchronously from inside the offending
 *   schedule call, so a runaway retry/refresh loop fails the test with a
 *   pointed stack trace instead of hanging.
 * @returns {Promise<FakeStHost>}
 *
 * @typedef {object} FakeStHost
 * @property {string} dir Root of the mkdtemp scratch tree (dispose() removes it).
 * @property {string} extensionDir Absolute path to the copied
 *   `.../scripts/extensions/third-party/SillyLounge` directory (= dist/runtime, flattened).
 * @property {Record<string, Function>} registry Mutable call-through
 *   registry backing every plain host *function* stub (isGenerating,
 *   getCurrentChatDetails, deleteMessage, getRequestHeaders, ...). Assign
 *   directly: `host.registry.getRequestHeaders = () => ({});`. Calling an
 *   unassigned name throws `Error: stub not configured: <name>`.
 * @property {object} eventSource Working fake ST event bus with
 *   on/off/removeListener/makeFirst/makeLast/emit/listenerCount. `emit` is
 *   async and awaits each handler in first→normal→last registration
 *   order, matching how dist code awaits `eventSource.emit(...)`.
 * @property {Record<string, string>} event_types Frozen map of every
 *   `stEventKeys` name (+ APP_READY) dist code resolves through
 *   `event_types`, each mapped to its own key name as the value.
 * @property {object} context The single mutable object `getContext()`
 *   returns. Mutate its properties in place (`host.context.chat.push(...)`,
 *   `host.context.characterId = 0`) — do not reassign `host.context`
 *   itself, that would desync it from what `getContext()` hands back to
 *   already-imported modules. Includes `chatMetadata` (plain mutable
 *   object), the real-valued `POPUP_TYPE`/`POPUP_RESULT` constants, a
 *   non-localized identity `t` tag, and `callGenericPopup` — the last is
 *   registry-backed (`host.registry.callGenericPopup = (...) => ...`), not a
 *   plain property to reassign.
 * @property {{setHandler(fn): void, calls: Array<{input, init}>, reset(): void}} fetch
 *   Controls `globalThis.fetch` for this scratch tree's dist code (used by
 *   adapter/chats/{queries,delete-transaction,rename-transaction,selection-protocol}.js).
 *   No handler installed → throws `stub not configured: fetch <url>`.
 *   Every call (handled or not) is recorded in `.calls`.
 * @property {object} window The object installed as `globalThis.window`
 *   (EventTarget-based: addEventListener/removeEventListener/dispatchEvent
 *   work for real). `.setTimeout`/`.clearTimeout` and the global
 *   `requestAnimationFrame`/`cancelAnimationFrame` share one deterministic
 *   timer engine: scheduled callbacks run on the next `setImmediate` tick
 *   (no real delay, but still asynchronous — never synchronously reentrant).
 * @property {object} localStorage The object installed as
 *   `globalThis.localStorage` (in-memory Storage-alike).
 * @property {{
 *   setSwipeState(v: string): void, get swipeState(): string,
 *   setChatSaving(v: boolean): void, get isChatSaving(): boolean,
 *   setExecutingSlashCommands(v: boolean): void, get isExecutingCommandsFromChatInput(): boolean,
 *   setUserAvatar(v: string|null): void, get userAvatar(): string|null,
 * }} state Controls for the four ST exports that are plain values instead
 *   of functions (can't go through `registry` — see module doc comment).
 * @property {(relPath: string) => Promise<any>} importModule Imports a
 *   compiled module from the scratch tree, e.g.
 *   `importModule('adapter/chats/rename-transaction.js')`,
 *   `importModule('store/chat-store.js')`. Path is relative to `extensionDir`.
 * @property {() => void} activate (Re)installs this host's window/document/
 *   localStorage/fetch/requestAnimationFrame/MutationObserver/HTMLElement*
 *   globals onto `globalThis`. Called once automatically at creation. These
 *   globals are process-wide (see caveat below) — call this again before
 *   exercising a particular host's call-time DOM/window/fetch-touching code
 *   if more than one host is alive and you've exercised another one since.
 *   `registry`, `eventSource`, `event_types`, `context`, and `state` never
 *   need this: they're captured per-host through each host's own copy of
 *   the bridge module, not through globals.
 * @property {() => Promise<void>} dispose Removes the scratch directory.
 *   Idempotent. Does not touch globalThis (the last-activated host's
 *   globals are left in place; create+activate another host, or don't rely
 *   on globals after disposing the host that owns them).
 */
export async function createFakeStHost(options = {}) {
    const maxTimerInvocations = options.maxTimerInvocations ?? DEFAULT_MAX_TIMER_INVOCATIONS;

    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillylounge-fake-st-host-'));
    const publicDir = path.join(rootDir, 'public');
    const scriptsDir = path.join(publicDir, 'scripts');
    const extensionDir = path.join(scriptsDir, 'extensions', 'third-party', 'SillyLounge');

    await fs.mkdir(extensionDir, { recursive: true });

    // Copy (never symlink — Node resolves relative imports from the
    // realpath, so a symlinked dist/runtime would resolve imports against
    // the *real* repo path, not this scratch tree) the compiled runtime
    // straight into the extension root, matching scripts/runtime.mjs's
    // `{ source: 'dist/runtime', target: '.' }` mapping.
    await fs.cp(DIST_RUNTIME_DIR, extensionDir, { recursive: true });
    await fs.mkdir(path.join(extensionDir, 'dist'), { recursive: true });
    await fs.cp(DIST_ROOT_APP_FILE, path.join(extensionDir, 'dist', 'root-app.mjs'));
    if (await pathExists(DIST_ROOT_APP_MAP_FILE)) {
        await fs.cp(DIST_ROOT_APP_MAP_FILE, path.join(extensionDir, 'dist', 'root-app.mjs.map'));
    }

    // The copied dist/runtime/**/*.js files use `import`/`export` syntax
    // with no file extension hint of that other than being .js — Node
    // needs a package.json {"type":"module"} somewhere at or above them.
    await fs.writeFile(path.join(rootDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 4) + '\n');

    await fs.writeFile(path.join(extensionDir, BRIDGE_FILENAME), bridgeModuleSource());
    await fs.writeFile(path.join(publicDir, 'script.js'), scriptJsSource());
    await fs.writeFile(path.join(scriptsDir, 'extensions.js'), extensionsJsSource());
    await fs.writeFile(path.join(scriptsDir, 'chats.js'), chatsJsSource());
    await fs.writeFile(path.join(scriptsDir, 'slash-commands.js'), slashCommandsJsSource());
    await fs.writeFile(path.join(scriptsDir, 'personas.js'), personasJsSource());
    await fs.writeFile(path.join(scriptsDir, 'st-context.js'), stContextJsSource());
    await fs.writeFile(path.join(scriptsDir, 'utils.js'), utilsJsSource());
    await fs.writeFile(path.join(scriptsDir, 'bookmarks.js'), bookmarksJsSource());
    await fs.writeFile(path.join(scriptsDir, 'RossAscends-mods.js'), rossAscendsModsJsSource());
    await fs.writeFile(path.join(scriptsDir, 'itemized-prompts.js'), itemizedPromptsJsSource());

    function toFileUrl(absPath) {
        return pathToFileURL(absPath).href;
    }

    function importModule(relPath) {
        return import(toFileUrl(path.join(extensionDir, relPath)));
    }

    // Import the bridge and the two stub files that own live-binding
    // plain-value exports, so we can hand the test working handles onto
    // all of it (same module instances the copied dist code will get,
    // since imports are resolved by realpath within this one scratch tree).
    const bridge = await import(toFileUrl(path.join(extensionDir, BRIDGE_FILENAME)));
    const scriptModule = await import(toFileUrl(path.join(publicDir, 'script.js')));
    const personasModule = await import(toFileUrl(path.join(scriptsDir, 'personas.js')));
    const slashCommandsModule = await import(toFileUrl(path.join(scriptsDir, 'slash-commands.js')));

    const state = {
        setSwipeState(value) {
            scriptModule.__setSwipeState(value);
        },
        get swipeState() {
            return scriptModule.swipeState;
        },
        setChatSaving(value) {
            scriptModule.__setIsChatSaving(value);
        },
        get isChatSaving() {
            return scriptModule.isChatSaving;
        },
        setExecutingSlashCommands(value) {
            slashCommandsModule.__setIsExecutingCommandsFromChatInput(value);
        },
        get isExecutingCommandsFromChatInput() {
            return slashCommandsModule.isExecutingCommandsFromChatInput;
        },
        setUserAvatar(value) {
            personasModule.__setUserAvatar(value);
        },
        get userAvatar() {
            return personasModule.user_avatar;
        },
    };

    const timerEngine = createTimerEngine(maxTimerInvocations);
    const fakeWindow = new FakeWindow(timerEngine);
    const fakeDocument = new FakeDocument();
    const fakeLocalStorage = createLocalStorage();
    const fetchController = createFetchController();

    function activate() {
        globalThis.window = fakeWindow;
        globalThis.document = fakeDocument;
        globalThis.localStorage = fakeLocalStorage;
        globalThis.fetch = fetchController.fn;
        globalThis.requestAnimationFrame = (fn) => timerEngine.schedule(fn, []);
        globalThis.cancelAnimationFrame = (id) => timerEngine.cancel(id);
        globalThis.MutationObserver = FakeMutationObserver;
        globalThis.MouseEvent = globalThis.MouseEvent ?? FakeMouseEvent;
        // Coarse on purpose: dist code only ever does `instanceof
        // HTMLElement`-family checks to sanity-check "is this a DOM node",
        // never to distinguish element subtypes. See module doc comment.
        globalThis.HTMLElement = FakeElement;
        globalThis.HTMLSelectElement = FakeElement;
        globalThis.HTMLInputElement = FakeElement;
        globalThis.HTMLFormElement = FakeElement;
    }

    activate();

    let disposed = false;
    async function dispose() {
        if (disposed) return;
        disposed = true;
        await fs.rm(rootDir, { recursive: true, force: true });
    }

    return {
        dir: rootDir,
        extensionDir,
        registry: bridge.registry,
        eventSource: bridge.eventSource,
        event_types: bridge.event_types,
        context: bridge.context,
        fetch: fetchController,
        window: fakeWindow,
        localStorage: fakeLocalStorage,
        state,
        importModule,
        activate,
        dispose,
    };
}
