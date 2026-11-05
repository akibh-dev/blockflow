// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRecorder } from '../../src/dom/recorder';
import type { RecorderHandle } from '../../src/dom/recorder';
import type { RecordedStep } from '../../src/core/recording';

let steps: RecordedStep[] = [];
let stopped = 0;
let recorder: RecorderHandle;

const $ = <T extends Element = HTMLInputElement>(selector: string) => document.querySelector(selector) as T;
const type = (selector: string, value: string) => {
  const field = $(selector);
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
};
const change = (selector: string) => $(selector).dispatchEvent(new Event('change', { bubbles: true }));
const toolbar = (act: string) =>
  (document.querySelector('blockflow-recorder')?.shadowRoot?.querySelector(`[data-act="${act}"]`) as HTMLButtonElement).click();

beforeEach(() => {
  document.body.innerHTML = `
    <form><label for="e">Email</label><input id="e">
    <label for="p">Password</label><input id="p" type="password">
    <label><input type="checkbox" id="c"> Remember me</label>
    <label for="s">Plan</label><select id="s"><option value="f">Free</option><option value="p">Pro</option></select>
    <button type="button" id="go">Sign <b>in</b></button></form>
    <h1 id="h">Welcome</h1>`;
  steps = [];
  stopped = 0;
  recorder = startRecorder({ onStep: (step) => steps.push(step), onStop: () => (stopped += 1) });
});
afterEach(() => recorder.stop());

describe('recorder', () => {
  it('records typing once per field, passwords as secrets, selects, checkboxes and clicks', () => {
    type('#e', 'm');
    type('#e', 'me@x.co');
    type('#p', 'hunter22');
    change('#p');
    change('#p'); // blur reports it again: still one step
    $('#c').click();
    $<HTMLSelectElement>('#s').value = 'p';
    change('#s');
    $('#go b').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(steps).toEqual([
      { kind: 'fill', locator: 'label="Email"', value: 'me@x.co' },
      { kind: 'fill', locator: 'label="Password"', value: '', secret: true, field: 'Password' },
      { kind: 'check', locator: 'label="Remember me"', checked: true },
      { kind: 'select', locator: 'label="Plan"', value: 'Pro' },
      { kind: 'click', locator: 'role=button[name="Sign in"]', text: 'Sign in' },
    ]);
  });

  it('Enter in a field records the value and the key', () => {
    type('#e', 'kettle');
    $('#e').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(steps).toEqual([
      { kind: 'fill', locator: 'label="Email"', value: 'kettle' },
      { kind: 'press', locator: 'label="Email"', key: 'Enter' },
    ]);
  });

  it('assert mode records a check instead of clicking, then goes back to recording', () => {
    let clicked = 0;
    $('#h').addEventListener('click', () => (clicked += 1));
    toolbar('assert-text');
    $('#h').click();
    toolbar('assert-visible');
    $('#go').click();
    expect(steps).toEqual([
      { kind: 'assert-text', locator: 'role=heading[name="Welcome"]', text: 'Welcome' },
      { kind: 'assert-visible', locator: 'role=button[name="Sign in"]' },
    ]);
    expect(clicked).toBe(0);
  });

  it('the toolbar is not recorded; Stop reports', () => {
    toolbar('stop');
    expect(steps).toEqual([]);
    expect(stopped).toBe(1);
  });
});

describe('recorder and shadow DOM', () => {
  it('records the element inside an open shadow root, not its host', () => {
    const host = document.createElement('x-login');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<div class="row"><label for="u">User name</label><input id="u"></div><div class="row"><button class="go"><span>Log in</span></button></div><input id="code" class="code">';
    const user = root.getElementById('u') as HTMLInputElement;
    user.value = 'akib';
    user.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    user.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    (root.querySelector('.go span') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const code = root.getElementById('code') as HTMLInputElement;
    code.value = '42';
    code.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    expect(steps).toEqual([
      { kind: 'fill', locator: 'label="User name"', value: 'akib' },
      { kind: 'click', locator: 'role=button[name="Log in"]', text: 'Log in' },
      // No readable locator: CSS that pierces the shadow root.
      { kind: 'fill', locator: 'x-login >>> #code', value: '42' },
    ]);
  });
});

describe('recorder in a frame', () => {
  it('has no toolbar, and follows the assert mode chosen on the top toolbar', () => {
    recorder.stop();
    let listener: ((mode: 'record' | 'assert-text' | 'assert-visible') => void) | undefined;
    const posted: string[] = [];
    recorder = startRecorder({
      onStep: (step) => steps.push(step),
      onStop: () => (stopped += 1),
      toolbar: false,
      channel: {
        post: (mode) => posted.push(mode),
        listen: (handler) => {
          listener = handler;
          return () => (listener = undefined);
        },
      },
    });
    expect(document.querySelector('blockflow-recorder')).toBeNull();
    listener?.('assert-text');
    $('#h').click();
    expect(steps).toEqual([{ kind: 'assert-text', locator: 'role=heading[name="Welcome"]', text: 'Welcome' }]);
    // Back to recording, and the other frames are told.
    expect(posted).toEqual(['record']);
    $('#go').click();
    expect(steps.at(-1)).toMatchObject({ kind: 'click' });
  });
});
