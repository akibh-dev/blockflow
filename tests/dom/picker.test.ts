// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PICKER_HINTS, startPicker } from '../../src/dom/picker';
import type { PickResult, PickerChannel, PickerHandle, PickerSync } from '../../src/dom/picker';

let handle: PickerHandle | null = null;
let picked: PickResult[] = [];
let cancelled = 0;

function page(html: string): void {
  document.body.innerHTML = html;
}

function start(): PickerHandle {
  picked = [];
  cancelled = 0;
  handle = startPicker({
    onPick: (result) => picked.push(result),
    onCancel: () => {
      cancelled += 1;
    },
  });
  return handle;
}

function fire(target: EventTarget, type: string): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true });
  target.dispatchEvent(event);
  return event;
}

function key(name: string): Event {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event;
}

const el = (selector: string) => document.querySelector(selector) as Element;
const pickerHost = () => document.getElementById('blockflow-picker-host');
const pickerButton = (name: string) =>
  pickerHost()?.shadowRoot?.querySelector(`[data-act="${name}"]`) as HTMLElement;

beforeEach(() => {
  page('<div id="shop"><p class="name">Widget</p><span class="price">$10</span></div>');
});

afterEach(() => {
  handle?.stop();
  handle = null;
  document.body.innerHTML = '';
});

describe('element picker', () => {
  it('shows its toolbar and removes everything when stopped', () => {
    start();
    expect(pickerHost()).toBeTruthy();
    handle?.stop();
    expect(pickerHost()).toBeNull();
    expect(picked).toHaveLength(0);
    expect(cancelled).toBe(0);
  });

  it('hovering highlights but does not lock a choice', () => {
    start();
    fire(el('.price'), 'mousemove');
    expect(handle?.state()).toEqual({ selector: null, matches: 0, locked: false });
  });

  it('clicking locks the element and works out its selector', () => {
    start();
    fire(el('.price'), 'click');
    expect(handle?.state()).toEqual({ selector: 'span.price', matches: 1, locked: true });
  });

  it('keeps the page from reacting to the click', () => {
    let pageSawClick = false;
    el('.price').addEventListener('click', () => {
      pageSawClick = true;
    });
    start();
    const event = fire(el('.price'), 'click');
    expect(pageSawClick).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Enter confirms and reports selector, page URL and sample text', () => {
    start();
    fire(el('.price'), 'click');
    key('Enter');
    expect(picked).toEqual([{ selector: 'span.price', candidates: ['text="$10"', 'span.price'], url: window.location.href, sample: '$10' }]);
    expect(pickerHost()).toBeNull();
  });

  it('Escape cancels', () => {
    start();
    fire(el('.price'), 'click');
    key('Escape');
    expect(cancelled).toBe(1);
    expect(picked).toHaveLength(0);
    expect(pickerHost()).toBeNull();
  });

  it('arrow keys broaden and narrow the pick', () => {
    start();
    fire(el('.price'), 'click');
    key('ArrowUp');
    expect(handle?.state().selector).toBe('#shop');
    key('ArrowDown');
    expect(handle?.state().selector).toBe('span.price');
  });

  it('clicking a different element re-targets the pick', () => {
    start();
    fire(el('.price'), 'click');
    fire(el('.name'), 'click');
    expect(handle?.state().selector).toBe('p.name');
  });

  it('toolbar buttons work and are not swallowed as page clicks', () => {
    start();
    fire(el('.price'), 'click');
    fire(pickerButton('broaden'), 'click');
    expect(handle?.state().selector).toBe('#shop');
    fire(pickerButton('confirm'), 'click');
    expect(picked.map((result) => result.selector)).toEqual(['#shop']);
  });

  it('the cancel button cancels', () => {
    start();
    fire(pickerButton('cancel'), 'click');
    expect(cancelled).toBe(1);
  });

  it('ignores keys before anything is picked, except Escape', () => {
    start();
    key('Enter');
    key('ArrowUp');
    expect(picked).toHaveLength(0);
    expect(pickerHost()).toBeTruthy();
    key('Escape');
    expect(cancelled).toBe(1);
  });

  it('the hint fits what the pick is for', () => {
    const hintOf = () => pickerHost()?.shadowRoot?.querySelector('.hint')?.textContent;
    start();
    expect(hintOf()).toBe(PICKER_HINTS.watch);
    handle?.stop();
    for (const mode of ['action', 'form'] as const) {
      handle = startPicker({ mode, onPick: () => {}, onCancel: () => {} });
      expect(hintOf()).toBe(PICKER_HINTS[mode]);
      handle.stop();
    }
  });
});

describe('element picker and shadow DOM', () => {
  it('picks the element inside an open shadow root, with a >>> selector, and broadens out to the host', () => {
    page('<x-card id="card"></x-card>');
    const root = (el('#card') as HTMLElement).attachShadow({ mode: 'open' });
    root.innerHTML = '<div class="body"><button class="buy">Buy now</button></div>';
    start();
    fire(root.querySelector('.buy') as Element, 'click');
    expect(handle?.state()).toEqual({ selector: '#card >>> button.buy', matches: 1, locked: true });
    key('ArrowUp');
    expect(handle?.state().selector).toBe('#card >>> div.body');
    key('ArrowUp');
    expect(handle?.state().selector).toBe('#card');
    key('ArrowDown');
    key('ArrowDown');
    key('Enter');
    expect(picked[0]).toMatchObject({ selector: '#card >>> button.buy', candidates: ['role=button[name="Buy now"]', 'role=button[name="Buy now"][exact]', 'text="Buy now"', '#card >>> button.buy'] });
  });
});

describe('element picker in frames', () => {
  /** A bus like the background's relay: every message reaches every picker (they ignore their own). */
  function bus(): PickerChannel {
    const handlers = new Set<(message: PickerSync) => void>();
    return {
      post: (message) => queueMicrotask(() => handlers.forEach((handler) => handler(message))),
      listen: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('a frame without a toolbar shows its pick on the top toolbar, and follows its buttons and keys', async () => {
    page('<iframe id="f"></iframe><p id="top">Top</p>');
    const frame = el('#f') as HTMLIFrameElement;
    const inner = frame.contentDocument as Document;
    inner.body.innerHTML = '<div id="pay"><button id="go">Pay</button></div>';
    const channel = bus();
    const framePicks: PickResult[] = [];
    start();
    handle?.stop();
    handle = startPicker({ onPick: (result) => picked.push(result), onCancel: () => (cancelled += 1), channel });
    const framePicker = startPicker({ document: inner, toolbar: false, channel, onPick: (result) => framePicks.push(result), onCancel: () => {} });
    expect(inner.querySelector('#blockflow-picker-host')?.shadowRoot?.querySelector('.bar')).toBeNull();

    fire(inner.getElementById('go') as Element, 'click');
    await flush();
    const selText = () => pickerHost()?.shadowRoot?.querySelector('.sel')?.textContent;
    expect(selText()).toBe('(in a frame) #go');
    expect(pickerButton('confirm').hasAttribute('disabled')).toBe(false);

    // The top toolbar's Broader button runs in the frame.
    fire(pickerButton('broaden'), 'click');
    await flush();
    expect(framePicker.state().selector).toBe('#pay');
    expect(selText()).toBe('(in a frame) #pay');

    // Locking on the top page takes the pick back from the frame.
    fire(el('#top'), 'click');
    await flush();
    expect(framePicker.state().locked).toBe(false);
    expect(handle?.state().selector).toBe('#top');

    // Lock in the frame again; Enter pressed on the top page confirms there.
    fire(inner.getElementById('go') as Element, 'click');
    await flush();
    expect(handle?.state().locked).toBe(false);
    key('Enter');
    await flush();
    expect(framePicks.map((result) => result.selector)).toEqual(['#go']);
    expect(picked).toHaveLength(0);
  });

  it('Esc in a frame cancels through the top picker', async () => {
    page('<iframe id="f"></iframe>');
    const inner = (el('#f') as HTMLIFrameElement).contentDocument as Document;
    const channel = bus();
    start();
    handle?.stop();
    handle = startPicker({ onPick: () => {}, onCancel: () => (cancelled += 1), channel });
    const framePicker = startPicker({ document: inner, toolbar: false, channel, onPick: () => {}, onCancel: () => {} });
    inner.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flush();
    expect(cancelled).toBe(1);
    framePicker.stop();
  });
});
