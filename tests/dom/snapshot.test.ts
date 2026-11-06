// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from '../../src/dom/agent';
import { resolveLocator } from '../../src/dom/locator';
import { takeSnapshot } from '../../src/dom/snapshot';
import type { AgentRequest, AgentResponse, SnapshotResult } from '../../src/core/page';

const agent = createAgent();
const run = (request: AgentRequest, budgetMs = 0): Promise<AgentResponse> => agent.run({ request, budgetMs });
const page = (html: string) => {
  document.body.innerHTML = html;
};

async function snapshot(request: Partial<Extract<AgentRequest, { op: 'snapshot' }>> = {}): Promise<SnapshotResult> {
  const response = await run({ op: 'snapshot', ...request });
  if (response.status !== 'done') throw new Error(JSON.stringify(response));
  return response.result as unknown as SnapshotResult;
}

beforeEach(() => page(''));

describe('snapshot op', () => {
  it('outlines roles and names, with a ref and a working locator per target', async () => {
    page(`
      <header><h1>Shop</h1><nav aria-label="Main"><a href="/cart">Cart</a></nav></header>
      <main>
        <form>
          <label for="email">Email</label><input id="email" value="a@b.c">
          <label>Password <input type="password" value="secret"></label>
          <label><input type="checkbox" checked> Remember me</label>
          <select aria-label="Country"><option>Bangladesh</option><option selected>Japan</option></select>
          <button disabled>Sign in</button>
        </form>
        <ul><li>Apples</li><li>Pears</li></ul>
        <p>Plain text here</p>
      </main>`);
    const result = await snapshot();
    const lines = result.snapshot.split('\n');
    expect(lines[0]).toBe('- banner');
    expect(lines).toContain('  - heading "Shop" [level=1] [ref=e1] locator=role=heading[name="Shop"]');
    expect(result.snapshot).toContain('- navigation "Main" [ref=e2] locator=');
    expect(result.snapshot).toContain('- link "Cart" [url="/cart"] [ref=e3] locator=');
    expect(result.snapshot).toContain('- textbox "Email" [value="a@b.c"] [ref=e5] locator=label="Email"');
    expect(result.snapshot).toMatch(/- textbox "Password" \[password\] \[ref=e6\] locator=/);
    expect(result.snapshot).not.toContain('secret');
    expect(result.snapshot).toMatch(/- checkbox "Remember me" \[checked\] \[ref=e7\]/);
    expect(result.snapshot).toContain('- combobox "Country" [value="Japan"] [options="Bangladesh | Japan"]');
    expect(result.snapshot).toContain('- button "Sign in" [disabled] [ref=e9] locator=role=button[name="Sign in"]');
    expect(result.snapshot).toContain('    - listitem: Apples');
    expect(result.snapshot).toContain('  - paragraph: Plain text here');
    // The label's text is the field's name, not a line of its own.
    expect(result.snapshot).not.toContain('- text: Email');
    expect(result.truncated).toBe(false);
    expect(result.lines).toBe(lines.length);
    expect(result.url).toBe(document.URL);

    const button = result.elements.find((element) => element.role === 'button');
    expect(button).toMatchObject({ ref: 'e9', name: 'Sign in', tag: 'button', disabled: true });
    expect(result.elements.find((element) => element.role === 'checkbox')).toMatchObject({ checked: true });
    expect(result.elements.find((element) => element.role === 'heading')).toMatchObject({ level: 1 });
    expect(result.elements.find((element) => element.role === 'link')?.url).toMatch(/\/cart$/);
    expect(result.elements.find((element) => element.name === 'Password')?.value).toBeUndefined();
    // Every locator finds exactly its element.
    for (const element of result.elements) {
      expect(resolveLocator(element.locator ?? '', document), element.locator).toHaveLength(1);
    }
  });

  it('skips hidden elements but keeps visible children of visibility:hidden ones', async () => {
    page(`
      <button style="display:none">Gone</button>
      <div hidden><button>Also gone</button></div>
      <div aria-hidden="true"><button>Decor</button></div>
      <div style="visibility:hidden"><button>Invisible</button><button style="visibility:visible">Shown again</button></div>
      <button>Here</button>`);
    const { snapshot: text } = await snapshot();
    expect(text).not.toMatch(/Gone|Also gone|Decor|Invisible/);
    expect(text).toContain('- button "Shown again"');
    expect(text).toContain('- button "Here"');
  });

  it('walks open shadow roots (slots filled) and marks the host', async () => {
    page('<my-card><span slot="title">Hello</span></my-card>');
    const host = document.querySelector('my-card') as HTMLElement;
    host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    (host.shadowRoot as ShadowRoot).innerHTML = '<h2><slot name="title"></slot></h2><button>Buy</button>';
    const result = await snapshot();
    expect(result.snapshot).toContain('- my-card [shadow]');
    expect(result.snapshot).toContain('  - heading "Hello" [level=2]');
    expect(result.snapshot).toMatch(/ {2}- button "Buy" \[ref=e\d+\] locator=role=button\[name="Buy"\]/);
    const buy = result.elements.find((element) => element.name === 'Buy');
    expect(buy?.inShadow).toBe(true);
    expect(resolveLocator(buy?.locator ?? '', document)).toHaveLength(1);
  });

  it('walks same-origin frames with frame= locators', async () => {
    page('<iframe id="pay" title="Payment"></iframe><button>Outside</button>');
    const frame = document.getElementById('pay') as HTMLIFrameElement;
    const inner = frame.contentDocument as Document;
    inner.body.innerHTML = '<label>Card <input name="card"></label><button>Pay</button>';
    const result = await snapshot();
    expect(result.snapshot).toMatch(/- iframe "Payment" \[frame\] \[ref=e1\] locator=frame=#pay/);
    expect(result.snapshot).toContain('  - textbox "Card"');
    const pay = result.elements.find((element) => element.name === 'Pay');
    expect(pay).toMatchObject({ inFrame: true, locator: 'frame=#pay >> role=button[name="Pay"]' });
    expect(resolveLocator(pay?.locator ?? '', document)).toEqual([inner.querySelector('button')]);
    // A part of the page inside the frame keeps the frame prefix.
    const part = await snapshot({ locator: 'frame=#pay >> button' });
    expect(part.snapshot).toBe('- button "Pay" [ref=e1] locator=frame=#pay >> role=button[name="Pay"]');
  });

  it('marks frames it cannot read as cross-origin', () => {
    page('<iframe id="ads" src="https://ads.example/x"></iframe>');
    const frame = document.getElementById('ads') as HTMLIFrameElement;
    Object.defineProperty(frame, 'contentDocument', { get: () => null });
    const result = takeSnapshot(document.body, { maxLines: 100 });
    expect(result.snapshot).toMatch(/^- iframe \[cross-origin\] \[src="https:\/\/ads.example\/x"\] \[ref=e1\] locator=frame=#ads$/);
  });

  it('caps the outline with a note', async () => {
    page(`<ul>${Array.from({ length: 100 }, (_, index) => `<li><a href="/p${index}">Product ${index}</a></li>`).join('')}</ul>`);
    const result = await snapshot({ maxLines: 50 });
    const lines = result.snapshot.split('\n');
    expect(lines).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(lines.at(-1)).toMatch(/^- … truncated at 49 lines/);
    expect(result.elements.length).toBeLessThan(50);
  });

  it('snapshots one part of the page, and waits for it when it is missing', async () => {
    page('<nav aria-label="Menu"><a href="/a">A</a></nav><main><button>Not this</button></main>');
    const result = await snapshot({ locator: 'role=navigation' });
    expect(result.snapshot.split('\n')[0]).toMatch(/^- navigation "Menu"/);
    expect(result.snapshot).not.toContain('Not this');
    expect(await run({ op: 'snapshot', locator: '#nothing' })).toMatchObject({ status: 'pending', code: 'locator.not-found' });
  });

  it('is fast enough on a big page', async () => {
    page(`<table>${Array.from({ length: 100 }, (_, row) => `<tr><td>Row ${row}</td><td><button>Edit</button></td><td><input aria-label="Qty ${row}"></td></tr>`).join('')}</table>`);
    const started = Date.now();
    const result = await snapshot();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.truncated).toBe(false);
    // 100 identical "Edit" buttons: the locator still finds exactly one each.
    const edits = result.elements.filter((element) => element.name === 'Edit');
    expect(edits).toHaveLength(100);
    expect(resolveLocator(edits[7]?.locator ?? '', document)).toHaveLength(1);
  });
});

describe('error codes', () => {
  it('strict-mode violations list the matches', async () => {
    page('<button id="a">Save</button><button id="b">Save draft</button>');
    const response = await run({ op: 'click', locator: 'role=button[name="Save"]', action: 'click' });
    expect(response).toMatchObject({ status: 'error', code: 'locator.strict', url: document.URL });
    expect(response.status === 'error' && response.matches).toEqual(['button#a "Save"', 'button#b "Save draft"']);
  });

  it('codes what the agent waited for', async () => {
    page(`
      <input id="ro" readonly>
      <select id="s"><option>A</option></select>
      <button id="b">B</button>`);
    expect(await run({ op: 'fill', locator: '#ro', value: 'x', mode: 'fill' })).toMatchObject({ status: 'pending', code: 'element.not-editable' });
    expect(await run({ op: 'select', locator: '#s', values: ['Z'] })).toMatchObject({ status: 'pending', code: 'option.not-found' });
    expect(await run({ op: 'wait', state: 'text', text: 'never' })).toMatchObject({ status: 'pending', code: 'timeout' });
    expect(await run({ op: 'wait', state: 'visible', locator: '#none' })).toMatchObject({ status: 'pending', code: 'locator.not-found' });
  });

  it('codes what can never work', async () => {
    page('<button id="b">B</button><div id="d">x</div>');
    expect(await run({ op: 'fill', locator: '#b', value: 'x', mode: 'fill' })).toMatchObject({ status: 'error', code: 'element.wrong-type' });
    expect(await run({ op: 'check', locator: '#d', checked: true })).toMatchObject({ status: 'error', code: 'element.wrong-type' });
    expect(await run({ op: 'read', locator: 'role=button[bogus]', kind: 'text' })).toMatchObject({ status: 'error', code: 'locator.invalid' });
    expect(await run({ op: 'table', locator: '#d' })).toMatchObject({ status: 'error', code: 'element.wrong-type' });
  });
});
