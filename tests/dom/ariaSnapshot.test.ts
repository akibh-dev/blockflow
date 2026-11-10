// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from '../../src/dom/agent';
import { matchAriaSnapshot, parseAriaOutline, parseAriaTemplate } from '../../src/core/ariaSnapshot';
import type { AgentRequest, SnapshotResult } from '../../src/core/page';

// The real `snapshot` page op on a fixture DOM, matched against templates as Assert aria-snapshot does.
const agent = createAgent();

async function outlineOf(locator?: string) {
  const request: AgentRequest = { op: 'snapshot', ...(locator ? { locator } : {}) };
  const response = await agent.run({ request, budgetMs: 0 });
  if (response.status !== 'done') throw new Error(JSON.stringify(response));
  const result = response.result as unknown as SnapshotResult;
  return parseAriaOutline(result.snapshot, result.elements);
}

async function check(template: string, locator?: string) {
  return matchAriaSnapshot(await outlineOf(locator), parseAriaTemplate(template));
}

beforeEach(() => {
  document.body.innerHTML = `
    <header><h1>Shop</h1><nav aria-label="Main"><a href="/cart">Cart</a> <a href="/join">Sign up</a></nav></header>
    <main>
      <form aria-label="Login">
        <label for="email">Email</label><input id="email" type="email" required value="a@b.c">
        <label>Password <input type="password" value="secret"></label>
        <label><input type="checkbox" checked> Remember me</label>
        <button disabled>Sign in</button>
        <button aria-expanded="false">More</button>
      </form>
      <h2>Fruit</h2>
      <ul id="fruit"><li>Apples</li><li>Pears</li><li><a href="/plums">Plums</a></li></ul>
      <p>Total: <b>3</b> items</p>
    </main>`;
});

describe('aria-snapshot against the real outline', () => {
  it('matches a partial template of the whole page', async () => {
    const result = await check(`
      - banner:
        - heading "Shop" [level=1]
        - navigation "Main":
          - link /Sign (in|up)/:
            - /url: /join
      - main:
        - form "Login":
          - textbox "Email" [required]: a@b.c
          - checkbox "Remember me" [checked]
          - button "Sign in" [disabled]
          - button "More" [expanded=false]
        - heading "Fruit" [level=2]
        - list:
          - listitem: Apples
          - listitem:
            - link "Plums"
        - paragraph: "Total: 3 items"
    `);
    expect(result.message).toBe('');
    expect(result.pass).toBe(true);
    // Refs and locator hints are not part of what is compared or shown.
    expect(result.actual).not.toMatch(/ref=|locator=/);
    expect(result.actual).not.toContain('secret');
  });

  it('a part of the page (locator) is its own root', async () => {
    expect((await check('- listitem: Pears', '#fruit')).pass).toBe(true);
    expect((await check('- list:\n  - listitem: Apples\n  - listitem: Pears', '#fruit')).pass).toBe(true);
    expect((await check('- heading "Shop"', '#fruit')).pass).toBe(false);
  });

  it('fails on order, a wrong name or state, and says where', async () => {
    expect((await check('- button "More"\n- button "Sign in"')).pass).toBe(false);
    const wrong = await check('- form "Login":\n  - button "Sign in" [disabled=false]');
    expect(wrong.pass).toBe(false);
    expect(wrong.message).toContain('template line 2 found nothing on the page:\n  - button "Sign in" [disabled=false]');
    expect(wrong.message).toContain('Closest on the page: - button "Sign in" [disabled] (it does not have [disabled=false])');
    expect(wrong.message).toContain('Looked for it in:\n  - form "Login":');
  });

  it('follows the page as it changes', async () => {
    expect((await check('- listitem: Kiwis')).pass).toBe(false);
    document.querySelector('#fruit')!.insertAdjacentHTML('beforeend', '<li>Kiwis</li>');
    expect((await check('- listitem: Kiwis')).pass).toBe(true);
  });
});
