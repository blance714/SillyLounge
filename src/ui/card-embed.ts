import type { ChatuiMessage } from './types.js';

const CARD_EMBED_PRE_SELECTOR = '.cui-root-message-body pre, .cui-root-reasoning-body pre';
const CARD_EMBED_FRAME_CLASS = 'cui-embed-frame';

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
})();`;
const CARD_EMBED_RESET_STYLE = 'html, body { margin: 0; }';

const frameObservers = new WeakMap<HTMLIFrameElement, ResizeObserver>();

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

    const frame = document.createElement('iframe');
    frame.className = CARD_EMBED_FRAME_CLASS;
    frame.addEventListener('load', () => observeFrameHeight(frame));
    frame.srcdoc = buildCardEmbedSrcdoc(cardSource);

    pre.style.display = 'none';
    pre.after(frame);
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

function observeFrameHeight(frame: HTMLIFrameElement): void {
    const body = frame.contentDocument?.body;
    if (!body) return;

    frameObservers.get(frame)?.disconnect();

    const setHeight = (height: number): void => {
        const clamped = Math.ceil(Math.max(0, height));
        frame.style.height = `${clamped}px`;
        const trueHeight = frame.contentDocument?.documentElement.scrollHeight;
        if (trueHeight !== undefined && trueHeight > clamped) {
            frame.style.height = `${trueHeight}px`;
        }
    };
    const observer = new ResizeObserver(entries => {
        const entry = entries[0];
        if (!entry) return;
        setHeight(entry.contentRect.height);
    });

    observer.observe(body);
    frameObservers.set(frame, observer);
    setHeight(body.getBoundingClientRect().height);
}
