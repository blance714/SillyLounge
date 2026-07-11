import type { ChatuiMessage } from './types.js';

const CARD_EMBED_PRE_SELECTOR = '.cui-root-message-body pre, .cui-root-reasoning-body pre';
const CARD_EMBED_FRAME_CLASS = 'cui-embed-frame';
const CARD_EMBED_HEIGHT_MESSAGE_KEY = '__cuiCardEmbedHeight';

const CARD_EMBED_BOOTSTRAP_SOURCE = `(function () {
  var host = window.parent;
  var th = host && host.TavernHelper;
  if (th) {
    window.TavernHelper = th;
    for (var key in th) {
      if (Object.prototype.hasOwnProperty.call(th, key)) {
        window[key] = th[key];
      }
    }
  }
  ['SillyTavern', 'Mvu'].forEach(function (name) {
    if (host && name in host) {
      Object.defineProperty(window, name, {
        get: function () { return host[name]; },
        configurable: true,
      });
    }
  });
  ['EjsTemplate', 'YAML', 'showdown', 'toastr', 'z'].forEach(function (name) {
    if (host && name in host) {
      window[name] = host[name];
    }
  });
  window.addEventListener('pagehide', function () {
    if (typeof window.eventClearAll === 'function') {
      try { window.eventClearAll(); } catch (e) {}
    }
  });
  // Report our own height to the parent instead of having it read
  // documentElement.scrollHeight from outside: that's the root element,
  // whose scrollHeight is defined as max(current iframe height, content
  // height) — so once the parent had set a height once, that becomes a
  // floor future reads can never shrink below. Measuring body (not root)
  // from in here has no such floor, needs no reset-and-remeasure dance, and
  // ResizeObserver's own callback is inherently non-forcing.
  window.addEventListener('DOMContentLoaded', function () {
    var reportHeight = function () {
      var message = {};
      message[${JSON.stringify(CARD_EMBED_HEIGHT_MESSAGE_KEY)}] = document.body.scrollHeight;
      // srcdoc documents report location.origin as the literal string "null"
      // (an opaque origin), which postMessage rejects as an invalid target
      // origin — '*' is required here. The parent already gates on
      // event.source identity (see ensureHeightMessageListener), which pins
      // to this exact window, so this isn't loosening anything.
      host.postMessage(message, '*');
    };
    new ResizeObserver(reportHeight).observe(document.body);
    reportHeight();
  });
})();`;
// display: flow-root gives body its own block formatting context, which
// stops a child's top/bottom margin from collapsing through body and
// escaping into html — without it, body.scrollHeight silently excludes that
// escaped margin (measured live: a 20px top + 20px bottom margin escaping
// this way undercounted a real card's height by 40px). `overflow: hidden`
// looks like the obvious fix but doesn't work here: browsers propagate
// `overflow` set on <body> up to the viewport, so body's own box never
// actually gets a BFC from it (verified live — overflow:hidden on body left
// the margin still escaping). `display` isn't subject to that propagation.
const CARD_EMBED_RESET_STYLE = 'html, body { margin: 0; } body { display: flow-root; }';

let frameWindows = new WeakMap<Window, HTMLIFrameElement>();
let heightMessageListenerInstalled = false;

function handleHeightMessage(event: MessageEvent): void {
    if (!event.source) return;
    const frame = frameWindows.get(event.source as Window);
    if (!frame) return;

    const data = event.data as Record<string, unknown> | null;
    const height = data?.[CARD_EMBED_HEIGHT_MESSAGE_KEY];
    if (typeof height !== 'number' || !Number.isFinite(height)) return;

    frame.style.height = `${Math.ceil(Math.max(0, height))}px`;
}

function ensureHeightMessageListener(): void {
    if (heightMessageListenerInstalled) return;
    heightMessageListenerInstalled = true;
    window.addEventListener('message', handleHeightMessage);
}

/** Release parent-side card runtime state when ChatUI is disabled. */
export function teardownCardEmbedRuntime(): void {
    if (heightMessageListenerInstalled) {
        window.removeEventListener('message', handleHeightMessage);
        heightMessageListenerInstalled = false;
    }
    frameWindows = new WeakMap<Window, HTMLIFrameElement>();
}

export function renderCardEmbeds(
    root: HTMLElement,
    messages: ChatuiMessage[],
    isGenerating: boolean,
): void {
    const messagesById = new Map(messages.map(message => [String(message.id), message]));

    root.querySelectorAll(CARD_EMBED_PRE_SELECTOR).forEach(pre => {
        if (!(pre instanceof HTMLElement)) return;
        mountCardEmbed(pre, messagesById, isGenerating);
    });
}

function isCardEmbedSource(source: string): boolean {
    return source.includes('html>')
        || source.includes('<head>')
        || source.includes('<body');
}

function buildCardEmbedSrcdoc(cardSource: string): string {
    return '<script>' + CARD_EMBED_BOOTSTRAP_SOURCE + '</script>'
        + '<style>' + CARD_EMBED_RESET_STYLE + '</style>'
        + cardSource;
}

function mountCardEmbed(
    pre: HTMLElement,
    messagesById: ReadonlyMap<string, ChatuiMessage>,
    isGenerating: boolean,
): void {
    if (hasMountedEmbed(pre)) return;
    if (isOwnedByActiveStreamingMessage(pre, messagesById, isGenerating)) return;

    const code = getDirectCodeChild(pre);
    if (!code) return;

    const cardSource = code.textContent ?? '';
    if (!isCardEmbedSource(cardSource)) return;

    ensureHeightMessageListener();

    const frame = document.createElement('iframe');
    frame.className = CARD_EMBED_FRAME_CLASS;
    frame.srcdoc = buildCardEmbedSrcdoc(cardSource);

    pre.style.display = 'none';
    pre.after(frame);

    if (frame.contentWindow) {
        frameWindows.set(frame.contentWindow, frame);
    }
}

function hasMountedEmbed(pre: HTMLElement): boolean {
    return pre.nextElementSibling?.classList.contains(CARD_EMBED_FRAME_CLASS) === true;
}

function getDirectCodeChild(pre: HTMLElement): HTMLElement | null {
    for (const child of pre.children) {
        if (child instanceof HTMLElement && child.tagName === 'CODE') return child;
    }
    return null;
}

function isOwnedByActiveStreamingMessage(
    pre: HTMLElement,
    messagesById: ReadonlyMap<string, ChatuiMessage>,
    isGenerating: boolean,
): boolean {
    const article = pre.closest('article[data-cui-message-id]');
    const messageId = article?.getAttribute('data-cui-message-id');
    const message = messageId === null || messageId === undefined ? undefined : messagesById.get(messageId);
    return message?.ui.isLast === true && isGenerating;
}
