// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from '../../src/dom/agent';
import type { AgentRequest, AgentResponse } from '../../src/core/page';

// M2 page abilities: click options, element actions, drag and drop, drop zones.
const agent = createAgent();
const run = (request: AgentRequest, budgetMs = 0): Promise<AgentResponse> => agent.run({ request, budgetMs });
const page = (html: string) => {
  document.body.innerHTML = html;
};
const $ = <T extends Element = HTMLInputElement>(selector: string) => document.querySelector(selector) as T;

/** Records `type:button:detail:modifiers:clientX,clientY` for each listed event on the element. */
function log(element: Element, types: string[]): string[] {
  const seen: string[] = [];
  for (const type of types) {
    element.addEventListener(type, (event) => {
      const e = event as MouseEvent;
      const keys = [e.altKey && 'Alt', e.ctrlKey && 'Control', e.metaKey && 'Meta', e.shiftKey && 'Shift'].filter(Boolean).join('+');
      seen.push(`${type}:${e.button}:${e.detail}:${keys}:${e.clientX},${e.clientY}`);
    });
  }
  return seen;
}

beforeEach(() => page(''));

describe('click options', () => {
  it('middle button fires auxclick, not click', async () => {
    page('<button id="b">Go</button>');
    const seen = log($('#b'), ['mousedown', 'click', 'auxclick', 'contextmenu']);
    expect(await run({ op: 'click', locator: '#b', action: 'click', button: 'middle' })).toMatchObject({ status: 'done' });
    expect(seen).toEqual(['mousedown:1:1::0,0', 'auxclick:1:1::0,0']);
  });

  it('right button via button or action fires contextmenu', async () => {
    page('<button id="b">Go</button>');
    const seen = log($('#b'), ['click', 'contextmenu']);
    await run({ op: 'click', locator: '#b', action: 'click', button: 'right' });
    await run({ op: 'click', locator: '#b', action: 'right' });
    expect(seen).toEqual(['contextmenu:2:1::0,0', 'contextmenu:2:1::0,0']);
  });

  it('modifiers, position and click count reach the events', async () => {
    page('<button id="b">Go</button>');
    const seen = log($('#b'), ['click', 'dblclick', 'mousemove']);
    await run({ op: 'click', locator: '#b', action: 'click', modifiers: ['Control', 'Shift'], position: { x: 7, y: 3 }, clickCount: 3 });
    expect(seen).toEqual([
      'mousemove:0:0:Control+Shift:7,3',
      'click:0:1:Control+Shift:7,3',
      'click:0:2:Control+Shift:7,3',
      'dblclick:0:2:Control+Shift:7,3',
      'click:0:3:Control+Shift:7,3',
    ]);
  });

  it('a hover holds modifiers but presses nothing', async () => {
    page('<button id="b">Go</button>');
    const seen = log($('#b'), ['mouseover', 'mousedown']);
    await run({ op: 'click', locator: '#b', action: 'hover', modifiers: ['Alt'] });
    expect(seen).toEqual(['mouseover:0:0:Alt:0,0']);
  });
});

describe('element actions', () => {
  it('focus and blur', async () => {
    page('<input id="a"><button id="b">B</button>');
    const events: string[] = [];
    $('#a').addEventListener('focus', () => events.push('focus'));
    $('#a').addEventListener('blur', () => events.push('blur'));
    expect(await run({ op: 'focus', locator: '#a' })).toMatchObject({ status: 'done' });
    expect(document.activeElement?.id).toBe('a');
    expect(await run({ op: 'blur', locator: '#a' })).toMatchObject({ status: 'done' });
    expect(document.activeElement).toBe(document.body);
    // Blurring an element without focus does nothing.
    $('#b').focus();
    await run({ op: 'blur', locator: '#a' });
    expect(document.activeElement?.id).toBe('b');
    expect(events).toEqual(['focus', 'blur']);
  });

  it('focus waits for a hidden element', async () => {
    page('<input id="a" hidden>');
    expect(await run({ op: 'focus', locator: '#a' })).toMatchObject({ status: 'pending', code: 'element.not-visible' });
  });

  it('clear empties fields with input and change events, and refuses buttons', async () => {
    page('<input id="a" value="old"><div id="e" contenteditable="true">text</div><button id="b">B</button><input id="r" value="x" readonly>');
    const events: string[] = [];
    $('#a').addEventListener('input', () => events.push('input'));
    $('#a').addEventListener('change', () => events.push('change'));
    expect(await run({ op: 'clear', locator: '#a' })).toMatchObject({ status: 'done', result: { value: '' } });
    expect($('#a').value).toBe('');
    expect(events).toEqual(['input', 'change']);
    await run({ op: 'clear', locator: '#e' });
    expect($('#e').textContent).toBe('');
    expect(await run({ op: 'clear', locator: '#b' })).toMatchObject({ status: 'error', code: 'element.wrong-type' });
    expect(await run({ op: 'clear', locator: '#r' })).toMatchObject({ status: 'pending', code: 'element.not-editable' });
  });

  it('dispatch: custom events carry detail, built-in types get their class and init', async () => {
    page('<div id="w"><button id="b">B</button></div>');
    let custom: CustomEvent | undefined;
    let key: KeyboardEvent | undefined;
    $('#w').addEventListener('my-event', (event) => {
      custom = event as CustomEvent;
      event.preventDefault();
    });
    $('#b').addEventListener('keydown', (event) => {
      key = event as KeyboardEvent;
    });
    expect(await run({ op: 'dispatch', locator: '#b', eventType: 'my-event', detail: { n: 1 } })).toEqual({
      status: 'done',
      result: { dispatched: 'my-event', defaultPrevented: true },
    });
    expect(custom?.detail).toEqual({ n: 1 });
    expect(custom?.bubbles && custom.composed).toBe(true);
    await run({ op: 'dispatch', locator: '#b', eventType: 'keydown', detail: { key: 'Enter', shiftKey: true } });
    expect(key).toBeInstanceOf(KeyboardEvent);
    expect([key?.key, key?.shiftKey]).toEqual(['Enter', true]);
    expect(await run({ op: 'dispatch', locator: '#b', eventType: ' ' })).toMatchObject({ status: 'error', code: 'config.invalid' });
  });
});

describe('drag', () => {
  it('HTML5: dragstart → dragenter/dragover → drop → dragend with one shared DataTransfer', async () => {
    page('<ul><li id="a" draggable="true">A</li><li id="b" draggable="true">B</li></ul><div id="bin">bin</div>');
    const events: string[] = [];
    let dropped = '';
    $('#a').addEventListener('dragstart', (event) => {
      events.push('dragstart');
      (event as DragEvent).dataTransfer?.setData('text/plain', 'a');
    });
    $('#a').addEventListener('dragend', (event) => events.push(`dragend:${(event as DragEvent).dataTransfer?.dropEffect}`));
    $('#a').addEventListener('pointercancel', () => events.push('pointercancel'));
    $('#a').addEventListener('mouseup', () => events.push('mouseup'));
    $('#bin').addEventListener('dragenter', () => events.push('dragenter'));
    $('#bin').addEventListener('dragover', (event) => {
      events.push('dragover');
      event.preventDefault();
    });
    $('#bin').addEventListener('drop', (event) => {
      events.push('drop');
      dropped = (event as DragEvent).dataTransfer?.getData('text/plain') ?? '';
      event.preventDefault();
    });
    expect(await run({ op: 'drag', locator: '#a', to: '#bin' })).toMatchObject({ status: 'done', result: { mode: 'html5', dropped: true } });
    expect(events).toEqual(['dragstart', 'dragenter', 'dragover', 'drop', 'dragend:move']);
    expect(dropped).toBe('a');
  });

  it('HTML5: no drop when the target does not cancel dragover', async () => {
    page('<div id="a" draggable="true">A</div><div id="t">T</div>');
    const events: string[] = [];
    for (const type of ['dragleave', 'drop', 'dragend']) $('#t').parentElement?.addEventListener(type, () => events.push(type));
    expect(await run({ op: 'drag', locator: '#a', to: '#t' })).toMatchObject({ status: 'done', result: { mode: 'html5', dropped: false } });
    expect(events).toEqual(['dragleave', 'dragend']);
  });

  it('pointer: a slider handle follows pointer moves to the target point', async () => {
    page('<div id="track"><div id="handle"></div></div><output id="v"></output>');
    let dragging = false;
    const moves: number[] = [];
    const done = new AbortController();
    $('#handle').addEventListener('mousedown', () => {
      dragging = true;
    });
    document.addEventListener('mousemove', (event) => {
      if (dragging && (event as MouseEvent).buttons === 1) moves.push((event as MouseEvent).clientX);
    }, done);
    document.addEventListener('mouseup', (event) => {
      dragging = false;
      $('#v').textContent = String((event as MouseEvent).clientX);
    }, done);
    expect(await run({ op: 'drag', locator: '#handle', to: '#track', fromPosition: { x: 0, y: 0 }, toPosition: { x: 100, y: 0 } })).toMatchObject({
      status: 'done',
      result: { mode: 'pointer' },
    });
    expect(moves).toEqual([20, 40, 60, 80, 100]);
    expect($('#v').textContent).toBe('100');
    done.abort();
  });

  it('a draggable whose dragstart is cancelled is dragged with the pointer instead', async () => {
    page('<div id="a" draggable="true">A</div><div id="t">T</div>');
    $('#a').addEventListener('dragstart', (event) => event.preventDefault());
    expect(await run({ op: 'drag', locator: '#a', to: '#t' })).toMatchObject({ result: { mode: 'pointer' } });
  });

  it('waits for both elements', async () => {
    page('<div id="a">A</div>');
    expect(await run({ op: 'drag', locator: '#a', to: '#nope' })).toMatchObject({ status: 'pending', code: 'locator.not-found' });
  });
});

describe('drop zones', () => {
  it('drops files with dragenter, dragover and drop', async () => {
    page('<div id="zone">Drop files here</div><p id="out"></p>');
    const events: string[] = [];
    $('#zone').addEventListener('dragenter', () => events.push('dragenter'));
    $('#zone').addEventListener('dragover', (event) => {
      events.push(`dragover:${(event as DragEvent).dataTransfer?.types.join(',')}`);
      event.preventDefault();
    });
    $('#zone').addEventListener('drop', (event) => {
      event.preventDefault();
      const file = (event as DragEvent).dataTransfer?.files[0];
      events.push(`drop:${file?.name}:${file?.type}:${file?.size}`);
    });
    expect(await run({ op: 'upload', locator: '#zone', dropzone: true, files: [{ name: 'a.txt', type: 'text/plain', base64: btoa('hello') }] })).toEqual({
      status: 'done',
      result: { files: ['a.txt'], dropped: true },
    });
    expect(events).toEqual(['dragenter', 'dragover:Files', 'drop:a.txt:text/plain:5']);
  });

  it('waits while nothing accepts the drop', async () => {
    page('<div id="zone">Not a drop zone</div>');
    expect(await run({ op: 'upload', locator: '#zone', dropzone: true, files: [{ name: 'a.txt', type: 'text/plain', base64: '' }] })).toMatchObject({
      status: 'pending',
      code: 'element.wrong-type',
      reason: expect.stringContaining('to accept dropped files'),
    });
  });
});

describe('locate for real input', () => {
  it('answers a position inside the element, and drop targets need not be enabled', async () => {
    page('<button id="b" disabled>B</button>');
    $('#b').getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 40, right: 110, bottom: 60, x: 10, y: 20, toJSON: () => ({}) }) as DOMRect;
    expect(await run({ op: 'locate', locator: '#b', purpose: 'drop', position: { x: 5, y: 6 } })).toMatchObject({ status: 'done', result: { x: 15, y: 26 } });
    expect(await run({ op: 'locate', locator: '#b', purpose: 'drop' })).toMatchObject({ status: 'done', result: { x: 60, y: 40 } });
    expect(await run({ op: 'locate', locator: '#b', purpose: 'click' })).toMatchObject({ status: 'pending', code: 'element.disabled' });
  });
});
