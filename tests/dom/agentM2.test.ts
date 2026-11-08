// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from '../../src/dom/agent';
import { bestLocator, firstLocator, locatorCandidates } from '../../src/dom/bestLocator';
import { resolveLocator } from '../../src/dom/locator';
import type { AgentRequest, AgentResponse, ReadKind } from '../../src/core/page';

// M2.9 read kinds, M2.14 chords and insert-text, M2.1 has-text in generated locators.

const agent = createAgent();
const run = (request: AgentRequest, budgetMs = 0): Promise<AgentResponse> => agent.run({ request, budgetMs });
const read = async (locator: string, kind: ReadKind, name?: string) => {
  const answer = await run({ op: 'read', locator, kind, ...(name !== undefined ? { name } : {}) });
  return answer.status === 'done' ? answer.result.text : answer;
};
const page = (html: string) => {
  document.body.innerHTML = html;
};
const $ = <T extends Element = HTMLInputElement>(selector: string) => document.querySelector(selector) as T;

beforeEach(() => page(''));

describe('read kinds for Assert', () => {
  it('class, css, accessible name and description', async () => {
    page(`
      <p id="hint">Never shared</p>
      <button id="b" class="  btn   primary " style="color: rgb(255, 0, 0)" aria-describedby="hint">Save</button>
      <input id="i" aria-label="Email">
    `);
    expect(await read('#b', 'class')).toBe('btn primary');
    expect(await read('#b', 'css', 'color')).toBe('rgb(255, 0, 0)');
    expect(await read('#b', 'accessible-name')).toBe('Save');
    expect(await read('#b', 'accessible-description')).toBe('Never shared');
    expect(await read('#i', 'accessible-name')).toBe('Email');
    expect(await run({ op: 'read', locator: '#b', kind: 'css' })).toMatchObject({ status: 'error', code: 'config.invalid' });
    expect(await run({ op: 'read', locator: '#nope', kind: 'class' })).toMatchObject({ status: 'pending', code: 'locator.not-found' });
  });

  it('focused (also inside a shadow root)', async () => {
    page('<input id="a"><input id="b"><x-host id="h"></x-host>');
    $('#a').focus();
    expect(await read('#a', 'focused')).toBe('true');
    expect(await read('#b', 'focused')).toBe('false');
    expect(await read('#missing', 'focused')).toBe('false');
    const root = $('#h').attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="deep">';
    (root.querySelector('input') as HTMLInputElement).focus();
    expect(await read('x-host >>> input', 'focused')).toBe('true');
    expect(await read('#h', 'focused')).toBe('false');
  });

  it('editable: enabled, not read-only, a field', async () => {
    page(`
      <input id="ok"><input id="ro" readonly><input id="off" disabled><textarea id="t"></textarea>
      <div id="ce" contenteditable="true"></div><div id="aro" role="textbox" aria-readonly="true"></div>
      <button id="btn">x</button><select id="s"><option>a</option></select>
    `);
    const answers = await Promise.all(['#ok', '#ro', '#off', '#t', '#ce', '#aro', '#btn', '#s', '#missing'].map((id) => read(id, 'editable')));
    expect(answers).toEqual(['true', 'false', 'false', 'true', 'true', 'false', 'false', 'true', 'false']);
  });

  describe('in-viewport', () => {
    const original = (window as { IntersectionObserver?: unknown }).IntersectionObserver;
    afterEach(() => {
      (window as { IntersectionObserver?: unknown }).IntersectionObserver = original;
    });

    it('asks an IntersectionObserver once (ratio above 0)', async () => {
      page('<div id="on"></div><div id="off"></div>');
      const observed: string[] = [];
      let disconnected = 0;
      (window as { IntersectionObserver?: unknown }).IntersectionObserver = class {
        constructor(private readonly callback: (entries: { intersectionRatio: number }[]) => void) {}
        observe(element: Element) {
          observed.push(element.id);
          queueMicrotask(() => this.callback([{ intersectionRatio: element.id === 'on' ? 0.5 : 0 }]));
        }
        disconnect() {
          disconnected += 1;
        }
      };
      expect(await read('#on', 'in-viewport')).toBe('true');
      expect(await read('#off', 'in-viewport')).toBe('false');
      expect(await read('#missing', 'in-viewport')).toBe('false');
      expect(observed).toEqual(['on', 'off']);
      expect(disconnected).toBe(2);
    });
  });
});

describe('keyboard chords and insert-text', () => {
  it('modifiers go down first and up last; Shift makes a letter uppercase', async () => {
    page('<input id="a">');
    const events: string[] = [];
    for (const type of ['keydown', 'keyup']) {
      $('#a').addEventListener(type, (event) => {
        const e = event as KeyboardEvent;
        events.push(`${type}:${e.key}:${e.code}${e.ctrlKey ? ':ctrl' : ''}${e.shiftKey ? ':shift' : ''}${e.metaKey ? ':meta' : ''}`);
      });
    }
    await run({ op: 'press', locator: '#a', key: 'Control+Shift+k' });
    expect(events).toEqual([
      'keydown:Control:ControlLeft:ctrl',
      'keydown:Shift:ShiftLeft:ctrl:shift',
      'keydown:K:KeyK:ctrl:shift',
      'keyup:K:KeyK:ctrl:shift',
      'keyup:Shift:ShiftLeft:ctrl',
      'keyup:Control:ControlLeft',
    ]);
    expect($('#a').value).toBe('');

    events.length = 0;
    await run({ op: 'press', locator: '#a', key: 'Shift+a' });
    expect($('#a').value).toBe('A');
    await run({ op: 'press', locator: '#a', key: 'Meta+a' });
    expect(events.filter((event) => event.startsWith('keydown:a'))).toEqual(['keydown:a:KeyA:meta']);
  });

  it('Control+A and ControlOrMeta+A select all (not Meta+A off a Mac)', async () => {
    page('<input id="a" value="hello">');
    const field = $('#a');
    field.setSelectionRange(0, 0);
    await run({ op: 'press', locator: '#a', key: 'Meta+A' });
    expect(field.selectionEnd).toBe(0);
    await run({ op: 'press', locator: '#a', key: 'ControlOrMeta+A' });
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5]);
    field.setSelectionRange(0, 0);
    await run({ op: 'press', locator: '#a', key: 'Control+a' });
    expect(field.selectionEnd).toBe(5);
  });

  it('insert-text types at the caret, replacing the selection, with one input event and no keys', async () => {
    page('<input id="a" value="Hello world"><textarea id="t"></textarea><button id="b">x</button>');
    const field = $('#a');
    const events: string[] = [];
    for (const type of ['keydown', 'keyup', 'input']) field.addEventListener(type, () => events.push(type));
    field.focus();
    field.setSelectionRange(6, 11);
    expect(await run({ op: 'insert-text', text: 'there 👋' })).toMatchObject({ status: 'done', result: { text: 'there 👋' } });
    expect(field.value).toBe('Hello there 👋');
    expect(events).toEqual(['input']);

    await run({ op: 'insert-text', locator: '#t', text: 'line 1\nline 2' });
    expect($<HTMLTextAreaElement>('#t').value).toBe('line 1\nline 2');
    expect(document.activeElement?.id).toBe('t');

    expect(await run({ op: 'insert-text', locator: '#b', text: 'x' })).toMatchObject({ status: 'error', code: 'element.wrong-type' });
  });
});

describe('generated locators use has-text to tell repeated elements apart', () => {
  it('the Delete button of the Banana row', () => {
    page(`
      <ul>
        <li><span>Apple</span> <button>Delete</button></li>
        <li><span>Banana</span> <button>Delete</button></li>
      </ul>
    `);
    const button = document.querySelectorAll('button')[1] as Element;
    const best = bestLocator(button);
    expect(best).toBe('role=listitem >> has-text=Banana >> role=button[name="Delete"]');
    expect(resolveLocator(best)).toEqual([button]);
    expect(firstLocator(button, new Map())).toBe(best);
    expect(locatorCandidates(button).at(-1)).not.toContain('has-text');
  });

  it('unique elements keep their plain locator', () => {
    page('<ul><li><span>Apple</span> <button>Remove</button></li><li><span>Banana</span> <button>Delete</button></li></ul>');
    expect(bestLocator(document.querySelectorAll('button')[1] as Element)).toBe('role=button[name="Delete"]');
  });
});
