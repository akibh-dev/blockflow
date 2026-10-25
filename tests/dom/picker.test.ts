// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startPicker } from '../../src/dom/picker';
import type { PickResult, PickerHandle } from '../../src/dom/picker';

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
});
