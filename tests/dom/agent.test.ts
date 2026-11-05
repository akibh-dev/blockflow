// @vitest-environment jsdom
import { createElement, useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from '../../src/dom/agent';
import type { AgentRequest, AgentResponse } from '../../src/core/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = createAgent();
const run = (request: AgentRequest, budgetMs = 0): Promise<AgentResponse> => agent.run({ request, budgetMs });
const page = (html: string) => {
  document.body.innerHTML = html;
};
const $ = <T extends Element = HTMLInputElement>(selector: string) => document.querySelector(selector) as T;

beforeEach(() => page(''));

describe('click', () => {
  it('fires the full mouse sequence and the default action', async () => {
    page('<button id="b">Go</button><input id="c" type="checkbox">');
    const events: string[] = [];
    for (const type of ['mouseover', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      $('#b').addEventListener(type, () => events.push(type));
    }
    expect(await run({ op: 'click', locator: '#b', action: 'click' })).toMatchObject({ status: 'done' });
    expect(events).toEqual(['mouseover', 'mousedown', 'mouseup', 'click']);
    expect(document.activeElement?.id).toBe('b');

    events.length = 0;
    await run({ op: 'click', locator: '#b', action: 'double' });
    expect(events.filter((type) => type === 'click')).toHaveLength(2);
    expect(events.at(-1)).toBe('dblclick');

    await run({ op: 'click', locator: '#c', action: 'click' });
    expect($('#c').checked).toBe(true);
  });

  it('is strict: two matches is an error that says how to fix it', async () => {
    page('<button>A</button><button>B</button>');
    const response = await run({ op: 'click', locator: 'button', action: 'click' });
    expect(response.status).toBe('error');
    expect(response.status === 'error' && response.message).toContain('matches 2 elements');
    expect(response.status === 'error' && response.message).toContain('nth=0');
  });

  it('waits for a missing, hidden or disabled element, and says what it waited for', async () => {
    page('<button id="b" disabled>Go</button><button id="h" style="display:none">Hidden</button>');
    expect(await run({ op: 'click', locator: '#nope', action: 'click' })).toEqual({
      status: 'pending',
      reason: 'waiting for #nope: no element matches',
    });
    expect(await run({ op: 'click', locator: '#b', action: 'click' })).toMatchObject({ reason: expect.stringContaining('to be enabled') });
    expect(await run({ op: 'click', locator: '#h', action: 'click' })).toMatchObject({ reason: expect.stringContaining('to be visible') });
  });

  it('keeps retrying inside the page until the element shows up', async () => {
    page('<div id="root"></div>');
    setTimeout(() => {
      $('#root').innerHTML = '<button id="late">Late</button>';
    }, 120);
    expect(await run({ op: 'click', locator: '#late', action: 'click' }, 1000)).toMatchObject({ status: 'done' });
  });

  it('force skips the checks', async () => {
    page('<button id="b" disabled>Go</button>');
    expect(await run({ op: 'click', locator: '#b', action: 'click', force: true })).toMatchObject({ status: 'done' });
  });
});

describe('fill and type', () => {
  it('fills inputs and textareas with input + change events', async () => {
    page('<input id="i"><textarea id="t"></textarea>');
    const events: string[] = [];
    $('#i').addEventListener('input', () => events.push('input'));
    $('#i').addEventListener('change', () => events.push('change'));
    await run({ op: 'fill', locator: '#i', value: 'hello', mode: 'fill' });
    await run({ op: 'fill', locator: '#t', value: 'multi\nline', mode: 'fill' });
    expect($('#i').value).toBe('hello');
    expect($<HTMLTextAreaElement>('#t').value).toBe('multi\nline');
    expect(events).toEqual(['input', 'change']);
  });

  it('types key by key, replacing what was there', async () => {
    page('<input id="i" value="old">');
    const keys: string[] = [];
    $('#i').addEventListener('keydown', (event) => keys.push((event as KeyboardEvent).key));
    await run({ op: 'fill', locator: '#i', value: 'abc', mode: 'type' });
    expect($('#i').value).toBe('abc');
    expect(keys).toEqual(['a', 'b', 'c']);
  });

  it('refuses read-only fields (waits) and non-text fields (error)', async () => {
    page('<input id="r" readonly><input id="c" type="checkbox"><div id="d">x</div>');
    expect(await run({ op: 'fill', locator: '#r', value: 'x', mode: 'fill' })).toMatchObject({ status: 'pending' });
    expect(await run({ op: 'fill', locator: '#c', value: 'x', mode: 'fill' })).toMatchObject({ status: 'error' });
    expect(await run({ op: 'fill', locator: '#d', value: 'x', mode: 'fill' })).toMatchObject({ status: 'error' });
  });

  it('updates a React controlled input (React ignores plain value assignment)', async () => {
    const seen: string[] = [];
    function Form() {
      const [email, setEmail] = useState('');
      const [agree, setAgree] = useState(false);
      const [plan, setPlan] = useState('free');
      seen.push(`${email}|${agree}|${plan}`);
      return createElement(
        'form',
        null,
        createElement('input', { id: 'email', value: email, onChange: (e: { target: HTMLInputElement }) => setEmail(e.target.value) }),
        createElement('input', { id: 'agree', type: 'checkbox', checked: agree, onChange: (e: { target: HTMLInputElement }) => setAgree(e.target.checked) }),
        createElement(
          'select',
          { id: 'plan', value: plan, onChange: (e: { target: HTMLSelectElement }) => setPlan(e.target.value) },
          createElement('option', { value: 'free' }, 'Free'),
          createElement('option', { value: 'pro' }, 'Pro plan'),
        ),
        createElement('output', { id: 'out' }, `${email}|${agree}|${plan}`),
      );
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(Form)));

    await act(async () => {
      await run({ op: 'set-field', locator: '#email', value: 'a@b.co' });
      await run({ op: 'set-field', locator: '#agree', value: 'true' });
      await run({ op: 'set-field', locator: '#plan', value: 'Pro plan' });
    });
    expect($('#out').textContent).toBe('a@b.co|true|pro');
    await act(async () => root.unmount());
  });
});

describe('select, check, press', () => {
  it('selects by value or label, waits for a missing option', async () => {
    page('<select id="s"><option value="bd">Bangladesh</option><option value="us">United States</option></select>');
    expect(await run({ op: 'select', locator: '#s', values: ['United States'] })).toMatchObject({ status: 'done', result: { selected: ['us'] } });
    expect($<HTMLSelectElement>('#s').value).toBe('us');
    expect(await run({ op: 'select', locator: '#s', values: ['fr'] })).toMatchObject({ status: 'pending', reason: expect.stringContaining('option "fr"') });
  });

  it('checks and unchecks; no-op when already in that state; ARIA switches too', async () => {
    page('<input id="c" type="checkbox"><div id="sw" role="switch" aria-checked="false" tabindex="0"></div>');
    $('#sw').addEventListener('click', () => $('#sw').setAttribute('aria-checked', String($('#sw').getAttribute('aria-checked') !== 'true')));
    expect(await run({ op: 'check', locator: '#c', checked: true })).toMatchObject({ result: { changed: true } });
    expect(await run({ op: 'check', locator: '#c', checked: true })).toMatchObject({ result: { changed: false } });
    expect(await run({ op: 'check', locator: '#sw', checked: true })).toMatchObject({ result: { changed: true } });
    expect($('#sw').getAttribute('aria-checked')).toBe('true');
  });

  it('Enter in a field submits its form; Tab moves focus; letters type', async () => {
    page('<form id="f"><input id="a"><input id="b"></form>');
    let submitted = 0;
    $('#f').addEventListener('submit', (event) => {
      event.preventDefault();
      submitted += 1;
    });
    await run({ op: 'press', locator: '#a', key: 'x' });
    expect($('#a').value).toBe('x');
    await run({ op: 'press', locator: '#a', key: 'Tab' });
    expect(document.activeElement?.id).toBe('b');
    await run({ op: 'press', key: 'Enter' });
    expect(submitted).toBe(1);
  });
});

describe('read, wait, detect-form', () => {
  it('reads text, value, attribute, count', async () => {
    page('<p class="m">Hello</p><p class="m">Bye</p><input id="i" value="v">');
    expect(await run({ op: 'read', locator: '.m', kind: 'text' })).toMatchObject({ result: { text: 'Hello', count: 2 } });
    expect(await run({ op: 'read', locator: '#i', kind: 'value' })).toMatchObject({ result: { text: 'v' } });
    expect(await run({ op: 'read', locator: '.none', kind: 'count' })).toMatchObject({ result: { text: '0' } });
  });

  it('waits for states and text', async () => {
    page('<div id="msg" hidden>Saved!</div>');
    expect(await run({ op: 'wait', state: 'hidden', locator: '#msg' })).toMatchObject({ status: 'done' });
    expect(await run({ op: 'wait', state: 'visible', locator: '#msg' })).toMatchObject({ status: 'pending' });
    expect(await run({ op: 'wait', state: 'attached', locator: '#msg' })).toMatchObject({ status: 'done' });
    setTimeout(() => $('#msg').removeAttribute('hidden'), 60);
    expect(await run({ op: 'wait', state: 'visible', locator: '#msg' }, 1000)).toMatchObject({ status: 'done' });
    expect(await run({ op: 'wait', state: 'text', text: 'saved' })).toMatchObject({ status: 'done' });
    expect(await run({ op: 'wait', state: 'no-text', text: 'saved' })).toMatchObject({ status: 'pending' });
  });

  it('detects a form\'s fields with readable locators', async () => {
    page(`<form id="f">
      <label for="e">Email</label><input id="e" type="email">
      <input name="phone" placeholder="Phone">
      <select name="country"><option value="">Pick</option><option value="bd">Bangladesh</option></select>
      <label><input type="checkbox" name="tos"> I agree</label>
      <input type="hidden" name="csrf"><button>Send</button>
    </form>`);
    const response = await run({ op: 'detect-form', locator: '#e' });
    expect(response.status).toBe('done');
    const fields = response.status === 'done' ? (response.result.fields as { locator: string; hint: string }[]) : [];
    expect(fields.map((field) => field.locator)).toEqual(['label="Email"', 'placeholder="Phone"', 'select[name="country"]', 'label="I agree"']);
    expect(fields[2]?.hint).toContain('select: Bangladesh');
    expect(fields[3]?.hint).toContain('checkbox');
  });
});

describe('scraping', () => {
  const shop = `
    <ul id="products">
      <li class="p"><h2>Kettle</h2><span class="price">$25</span><a href="/p/kettle">more</a></li>
      <li class="p"><h2>Toaster</h2><span class="price">$40</span><a href="/p/toaster">more</a></li>
      <li class="p"><h2>Mug</h2><a href="/p/mug">more</a></li>
    </ul>
    <table id="t"><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></tbody></table>`;

  it('extracts a list of objects; links become absolute; missing fields are empty', async () => {
    page(shop);
    const response = await run({
      op: 'extract',
      locator: 'li.p',
      fields: [
        { name: 'title', locator: 'h2' },
        { name: 'price', locator: '.price' },
        { name: 'link', locator: 'a', attribute: 'href' },
      ],
      limit: 2,
    });
    expect(response).toEqual({
      status: 'done',
      result: {
        count: 2,
        columns: ['title', 'price', 'link'],
        values: [
          ['Kettle', '$25', `${location.origin}/p/kettle`],
          ['Toaster', '$40', `${location.origin}/p/toaster`],
        ],
      },
    });
    expect(await run({ op: 'extract', locator: '.none', fields: [] })).toMatchObject({ status: 'pending' });
  });

  it('reads tables by their headers', async () => {
    page(shop);
    expect(await run({ op: 'table', locator: '#t' })).toEqual({ status: 'done', result: { count: 2, columns: ['Name', 'Qty'], values: [['A', '1'], ['B', '2']] } });
  });

  it('page info, storage, cookies', async () => {
    document.head.innerHTML = '<title>Shop</title><meta name="description" content="Kettles"><link rel="canonical" href="/home"><script type="application/ld+json">{"@type":"Product"}</script>';
    localStorage.setItem('theme', 'dark');
    document.cookie = 'session=abc';
    const info = await run({ op: 'page-info' });
    expect(info).toMatchObject({ result: { title: 'Shop', description: 'Kettles', canonical: `${location.origin}/home`, jsonLd: [{ '@type': 'Product' }] } });
    expect(await run({ op: 'storage', area: 'local', key: 'theme' })).toMatchObject({ result: { value: 'dark' } });
    expect(await run({ op: 'storage', area: 'cookies', key: 'session' })).toMatchObject({ result: { value: 'abc' } });
    document.head.innerHTML = '';
  });

  it('works on HTML that is parsed, not displayed', async () => {
    const parsed = new DOMParser().parseFromString(`<base href="https://shop.test/">${shop}`, 'text/html');
    const offscreen = createAgent(window as never, parsed);
    const response = await offscreen.run({ request: { op: 'extract', locator: 'li.p >> nth=0', fields: [{ name: 'link', locator: 'a', attribute: 'href' }] }, budgetMs: 0 });
    expect(response).toMatchObject({ result: { columns: ['link'], values: [['https://shop.test/p/kettle']] } });
  });
});

describe('frames', () => {
  it('frame= reaches into same-origin iframes', async () => {
    page('<iframe id="f"></iframe>');
    const frame = $<HTMLIFrameElement>('#f');
    frame.contentDocument?.open();
    frame.contentDocument?.write('<button id="inner">Pay</button>');
    frame.contentDocument?.close();
    let clicked = 0;
    frame.contentDocument?.getElementById('inner')?.addEventListener('click', () => (clicked += 1));
    expect(await run({ op: 'click', locator: 'frame=#f >> role=button[name="Pay"]', action: 'click' })).toMatchObject({ status: 'done' });
    expect(clicked).toBe(1);
  });

  it('reports a frame from another site, with the rest of the locator', async () => {
    page('<iframe id="pay" src="https://pay.example.com/card"></iframe>');
    // jsdom cannot load it; like a cross-origin frame, its document is not reachable.
    Object.defineProperty($('#pay'), 'contentDocument', { get: () => null });
    expect(await run({ op: 'fill', locator: 'frame=#pay >> label=Card number', value: '4242', mode: 'fill' })).toEqual({
      status: 'frame',
      src: 'https://pay.example.com/card',
      rest: 'label=Card number',
    });
  });

  it('tries every matching frame: a same-origin match wins over a cross-origin frame', async () => {
    page('<iframe class="f" id="other" src="https://pay.example.com/card"></iframe><iframe class="f" id="same"></iframe>');
    Object.defineProperty($('#other'), 'contentDocument', { get: () => null });
    const same = $<HTMLIFrameElement>('#same');
    same.contentDocument?.open();
    same.contentDocument?.write('<p id="here">Inside</p>');
    same.contentDocument?.close();
    expect(await run({ op: 'read', locator: 'frame=.f >> #here', kind: 'text' })).toMatchObject({ status: 'done', result: { text: 'Inside' } });
    // Nothing in the same-origin frame: hand over to the other one.
    expect(await run({ op: 'read', locator: 'frame=.f >> #elsewhere', kind: 'text' })).toEqual({ status: 'frame', src: 'https://pay.example.com/card', rest: 'css=#elsewhere' });
  });

  it('locate adds the offsets of same-origin frames, and says where a cross-origin frame starts', async () => {
    const box = (left: number, top: number, width = 0, height = 0) => () => ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;
    page('<iframe id="same" style="padding: 4px 0 0 6px"></iframe><iframe id="other" src="https://pay.example.com/card"></iframe>');
    const same = $<HTMLIFrameElement>('#same');
    same.contentDocument?.open();
    same.contentDocument?.write('<button id="pay">Pay</button>');
    same.contentDocument?.close();
    same.getBoundingClientRect = box(100, 50);
    (same.contentDocument?.getElementById('pay') as Element).getBoundingClientRect = box(10, 20, 20, 10);
    expect(await run({ op: 'locate', locator: 'frame=#same >> #pay', purpose: 'click' })).toMatchObject({ status: 'done', result: { x: 100 + 6 + 20, y: 50 + 4 + 25 } });

    const other = $<HTMLIFrameElement>('#other');
    Object.defineProperty(other, 'contentDocument', { get: () => null });
    other.getBoundingClientRect = box(300, 40);
    expect(await run({ op: 'locate', locator: 'frame=#other >> #pay', purpose: 'click' })).toEqual({ status: 'frame', src: 'https://pay.example.com/card', rest: 'css=#pay', offset: { x: 300, y: 40 } });
  });
});

describe('read kinds', () => {
  it('reads text, attributes, classes, existence and counts', async () => {
    page('<button aria-pressed="true" class="on">x</button><a class="p"></a><a class="p"></a>');
    expect(await run({ op: 'read', locator: 'button', kind: 'attribute', name: 'aria-pressed' })).toMatchObject({ result: { text: 'true' } });
    expect(await run({ op: 'read', locator: 'button', kind: 'attribute', name: 'nope' })).toMatchObject({ result: { text: '' } });
    expect(await run({ op: 'read', locator: 'button', kind: 'has-class', name: 'on' })).toMatchObject({ result: { text: 'true' } });
    expect(await run({ op: 'read', locator: 'button', kind: 'has-class', name: 'off' })).toMatchObject({ result: { text: 'false' } });
    expect(await run({ op: 'read', locator: '.p', kind: 'count' })).toMatchObject({ result: { text: '2' } });
    expect(await run({ op: 'read', locator: '.none', kind: 'exists' })).toMatchObject({ result: { text: 'false' } });
    expect(await run({ op: 'read', locator: '.p', kind: 'exists' })).toMatchObject({ result: { text: 'true' } });
  });

  it('reports an invalid selector as an error instead of waiting', async () => {
    expect(await run({ op: 'read', locator: '!!!', kind: 'text' })).toMatchObject({ status: 'error', message: expect.stringContaining('Invalid CSS') });
  });
});

describe('upload and locate', () => {
  // Setting files needs DataTransfer, which jsdom lacks: the success path runs in npm run e2e.
  it('finds a hidden file input by its label, and refuses other elements', async () => {
    page('<label for="f">Upload CV</label><input id="f" type="file" hidden><button id="b">x</button>');
    expect(await run({ op: 'upload', locator: 'label=Upload CV', files: [{ name: 'cv.txt', type: 'text/plain', base64: btoa('hello') }] })).toEqual({
      status: 'error',
      message: 'This page cannot receive files (no DataTransfer)',
    });
    expect(await run({ op: 'upload', locator: '#b', files: [] })).toMatchObject({ status: 'error', message: expect.stringContaining('is not a file input') });
    // Fill Form on a file input points at the Upload File block.
    page('<input id="v" type="file">');
    expect(await run({ op: 'set-field', locator: '#v', value: 'cv.txt' })).toMatchObject({ status: 'error', message: expect.stringContaining('use the Upload File block') });
  });

  it('locate says what kind of field it found (geometry needs a real browser)', async () => {
    page('<select id="s"><option>a</option></select><input id="t">');
    expect(await run({ op: 'locate', locator: '#s', purpose: 'set-field' })).toMatchObject({ status: 'done', result: { kind: 'select' } });
    expect(await run({ op: 'locate', locator: '#t', purpose: 'fill' })).toMatchObject({ status: 'done', result: { kind: 'text' } });
  });
});
