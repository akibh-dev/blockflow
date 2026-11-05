import { generateSelector } from './selector';

/**
 * Which iframe a frame is, seen from the top page: the picker and recorder run in every frame and
 * turn a frame's own locator into `frame=<iframe css> >> … >> <locator>`. Runs inside pages: DOM only.
 *
 * Same-origin parents are read directly (`window.frameElement`). A cross-origin parent cannot be
 * read, so the frame asks it with `postMessage`: the parent's own copy of this module (installed with
 * {@link answerFramePathQuestions}) finds the `<iframe>` whose `contentWindow` sent the question,
 * works out its own path the same way and answers.
 */

const ASK = 'blockflow:frame-path?';
const ANSWER = 'blockflow:frame-path';

interface Question {
  type: typeof ASK;
  id: string;
}
interface Answer {
  type: typeof ANSWER;
  id: string;
  path: string[] | null;
}

/** Every `<iframe>`/`<frame>` in `doc`, including inside open shadow roots. */
function framesIn(root: ParentNode): Element[] {
  const found: Element[] = [];
  for (const element of Array.from(root.querySelectorAll('*'))) {
    if (element.localName === 'iframe' || element.localName === 'frame') found.push(element);
    if (element.shadowRoot) found.push(...framesIn(element.shadowRoot));
  }
  return found;
}

/** The frame element in `doc` whose window is `source` (null if none). */
export function frameElementFor(doc: Document, source: unknown): Element | null {
  if (!source) return null;
  return framesIn(doc).find((frame) => (frame as HTMLIFrameElement).contentWindow === source) ?? null;
}

/**
 * CSS selectors of the frames from the top page down to `win` (`[]` in the top frame), or null when a
 * parent did not answer within `timeoutMs` (it has no BlockFlow script, or the page blocks messages).
 */
export async function framePath(win: Window, timeoutMs = 3_000): Promise<string[] | null> {
  if (win.parent === win || !win.parent) return [];
  let element: Element | null = null;
  try {
    element = win.frameElement;
  } catch {
    element = null;
  }
  if (element) {
    const outer = element.ownerDocument.defaultView;
    const path = outer ? await framePath(outer, timeoutMs) : [];
    return path ? [...path, generateSelector(element)] : null;
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const ask = () => win.parent.postMessage({ type: ASK, id } satisfies Question, '*');
    const done = (path: string[] | null) => {
      win.clearTimeout(timer);
      win.clearInterval(again);
      win.removeEventListener('message', onMessage);
      resolve(path);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as Answer | undefined;
      if (data?.type !== ANSWER || data.id !== id) return;
      done(Array.isArray(data.path) ? data.path.map(String) : null);
    };
    const timer = win.setTimeout(() => done(null), timeoutMs);
    // The parent's script may be injected a moment after ours: ask again until it answers.
    const again = win.setInterval(ask, 250);
    win.addEventListener('message', onMessage);
    ask();
  });
}

/** Turns a locator found inside a frame into one that starts at the top page. */
export function withFramePath(path: string[], locator: string): string {
  return [...path.map((css) => `frame=${css}`), locator].join(' >> ');
}

/**
 * Lets child frames ask this window which iframe they are (see {@link framePath}). Installed once per
 * window; returns a function that removes it.
 */
export function answerFramePathQuestions(win: Window): () => void {
  const holder = win as Window & { __blockflowFramePath?: () => void };
  if (holder.__blockflowFramePath) return holder.__blockflowFramePath;
  const onMessage = (event: MessageEvent) => {
    const data = event.data as Question | undefined;
    if (data?.type !== ASK || typeof data.id !== 'string') return;
    const frame = frameElementFor(win.document, event.source);
    if (!frame) return;
    const source = event.source as Window;
    void framePath(win).then((path) => {
      source.postMessage({ type: ANSWER, id: data.id, path: path ? [...path, generateSelector(frame)] : null } satisfies Answer, '*');
    });
  };
  win.addEventListener('message', onMessage);
  holder.__blockflowFramePath = () => {
    win.removeEventListener('message', onMessage);
    holder.__blockflowFramePath = undefined;
  };
  return holder.__blockflowFramePath;
}
