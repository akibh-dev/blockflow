import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';
import { toPlaywrightLocator, workflowToPlaywright } from '../../src/core/playwright';
import { flow } from '../helpers/fakeHost';

const registry = createDefaultRegistry();

describe('locators to Playwright', () => {
  it.each([
    ['#save', `page.locator("#save")`],
    ['my-app >>> button', `page.locator("my-app button")`],
    ['text=Sign in', `page.getByText("Sign in")`],
    ['text="Sign in"', `page.getByText("Sign in", { exact: true })`],
    ['text=/sign ?in/i', `page.getByText(/sign ?in/i)`],
    ['role=button[name="Save"]', `page.getByRole("button", { name: "Save" })`],
    ['role=button[name="Save"][exact]', `page.getByRole("button", { name: "Save", exact: true })`],
    ['role=heading[level=2]', `page.getByRole("heading", { level: 2 })`],
    ['role=checkbox[checked]', `page.getByRole("checkbox", { checked: true })`],
    ['label=Email', `page.getByLabel("Email")`],
    ['placeholder=you@x.co', `page.getByPlaceholder("you@x.co")`],
    ['testid=submit', `page.getByTestId("submit")`],
    ['xpath=//li[2]', `page.locator("xpath=//li[2]")`],
    ['#list >> text=Pro >> nth=1', `page.locator("#list").getByText("Pro").nth(1)`],
    ['li >> nth=-1', `page.locator("li").last()`],
    ['frame=#pay >> label=Card number', `page.frameLocator("#pay").getByLabel("Card number")`],
  ])('%s', (locator, code) => {
    expect(toPlaywrightLocator(locator, 'page')).toBe(code);
  });
});

describe('workflow to Playwright test', () => {
  it('writes a readable test with branches, errors, secrets and called workflows', () => {
    const login = flow([{ id: 'f', type: 'fill', config: { locator: 'label=Password', value: '{{secret.loginPassword}}' } }], []);
    login.name = 'Log in';
    const test = flow(
      [
        { id: 'o', type: 'open-url', config: { url: 'https://shop.test/{{path}}' } },
        { id: 'c', type: 'run-workflow', config: { workflow: login.id } },
        { id: 'w', type: 'wait-for', config: { mode: 'url', url: '/account' }, step: { onError: 'port' } },
        { id: 'a', type: 'assert', config: { subject: 'text', locator: 'h1', operator: 'contains', expected: 'Welcome' } },
        { id: 'n', type: 'notify', config: { title: 'x' } },
        { id: 'i', type: 'if', config: { left: '{{value}}', operator: 'greater', right: '3' } },
        { id: 's', type: 'stop', config: { outcome: 'fail', message: 'login broken' } },
      ],
      [['o', 'c'], ['c', 'w'], ['w', 'a'], ['w', 's', 'error'], ['a', 'i'], ['i', 'n', 'true']],
    );
    test.name = 'Checkout';
    const spec = workflowToPlaywright(test, { registry, lookup: (id) => (id === login.id ? login : undefined) });
    expect(spec).toContain(`test("Checkout", async ({ context, request }) => {`);
    expect(spec).toContain('await tabs["main"].goto(`https://shop.test/${get(data, "path")}`);');
    expect(spec).toMatch(/data = await logIn_\w+\(tabs, data, context, request\);/);
    expect(spec).toContain("await tabs[\"main\"].getByLabel(\"Password\").fill(`${process.env[\"LOGINPASSWORD\"] ?? ''}`);");
    expect(spec).toContain('// Secrets come from environment variables: LOGINPASSWORD');
    expect(spec).toContain('try {');
    expect(spec).toContain('throw new Error("login broken");');
    expect(spec).toContain('await expect(tabs["main"].locator("h1")).toContainText("Welcome");');
    expect(spec).toContain('if (compare(`${get(data, "value")}`, "greater", "3")) {');
    expect(spec).toContain('// Notify: no Playwright equivalent, skipped.');
  });
});
