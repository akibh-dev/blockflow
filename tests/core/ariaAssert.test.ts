import { describe, expect, it } from 'vitest';
import { assertBlock, createDefaultRegistry } from '../../src/core/blocks';
import { withDefaults } from '../../src/core/config';
import { parseImport } from '../../src/core/library';
import { workflowToPlaywright } from '../../src/core/playwright';
import { FakeHost, flow, harness } from '../helpers/fakeHost';
import type { AgentRequest } from '../../src/core/page';

const registry = createDefaultRegistry();
const OUTLINE = [
  '- heading "Welcome" [level=1] [ref=e1] locator=role=heading[name="Welcome"]',
  '- form "Login" [ref=e2] locator=role=form[name="Login"]',
  '  - textbox "Email" [required] [ref=e3] locator=label="Email"',
  '  - button "Sign in" [ref=e4] locator=role=button[name="Sign in"]',
].join('\n');

/** A page agent that answers `snapshot` with `outlines` in turn (the last one stays). */
function pageWith(...outlines: string[]) {
  const host = new FakeHost();
  const requests: AgentRequest[] = [];
  host.agent = async (_tab, request) => {
    requests.push(request);
    const snapshot = outlines.length > 1 ? (outlines.shift() as string) : (outlines[0] as string);
    return { snapshot, elements: [], url: 'https://shop.test/', title: '', lines: snapshot.split('\n').length, truncated: false };
  };
  return { host, requests };
}

function run(host: FakeHost, config: Record<string, unknown>, timeoutSeconds = 2) {
  return harness(
    flow([{ id: 'open', type: 'open-url', config: { url: 'https://shop.test/' } }, { id: 'a', type: 'assert', config: { subject: 'aria-snapshot', ...config }, step: { timeoutSeconds } }], [['open', 'a']]),
    host,
  ).runner.runOnce();
}

describe('Assert aria-snapshot', () => {
  it('passes on a matching template, asking for the whole page or the locator part', async () => {
    const { host, requests } = pageWith(OUTLINE);
    const record = await run(host, { expected: '- heading "Welcome" [level=1]\n- form:\n  - button /Sign (in|up)/' });
    expect(record.status).toBe('passed');
    expect(requests[0]).toEqual({ op: 'snapshot', maxLines: 1500 });

    const part = pageWith(OUTLINE);
    expect((await run(part.host, { locator: 'role=form', expected: '- textbox "Email"' })).status).toBe('passed');
    expect(part.requests[0]).toMatchObject({ op: 'snapshot', locator: 'role=form' });
  });

  it('retries until the page matches', async () => {
    const { host, requests } = pageWith('- heading "Loading" [level=1]', '- heading "Loading" [level=1]', OUTLINE);
    const record = await run(host, { expected: '- heading "Welcome"' }, 5);
    expect(record.status).toBe('passed');
    expect(requests.length).toBe(3);
  });

  it('fails with assert.failed and the explanation, the custom message first', async () => {
    const { host } = pageWith(OUTLINE);
    const record = await run(host, { expected: '- form "Login":\n  - button "Sign up"', message: 'Login form changed' }, 1);
    expect(record.status).toBe('failed');
    const step = record.steps.find((candidate) => candidate.nodeId === 'a');
    expect(step?.code).toBe('assert.failed');
    expect(step?.error).toContain('Login form changed\nARIA snapshot does not match: template line 2');
    expect(step?.error).toContain('Closest on the page: - button "Sign in"');
  });

  it('a missing locator part fails as not found; soft records and goes on', async () => {
    const host = new FakeHost();
    host.agent = async () => {
      throw new Error('Timed out after 0.3s: waiting for #nope');
    };
    const record = await run(host, { locator: '#nope', expected: '- button', soft: true }, 1);
    expect(record.status).toBe('failed');
    const step = record.steps.find((candidate) => candidate.nodeId === 'a');
    expect(step?.error).toContain('no element matches #nope');
  });

  it('a bad template is a config error with the line and column', async () => {
    const { host } = pageWith(OUTLINE);
    const record = await run(host, { expected: '- heading "x"\n- button [bogus]' });
    const step = record.steps.find((candidate) => candidate.nodeId === 'a');
    expect(step?.code).toBe('config.invalid');
    expect(step?.error).toContain('line 2, column 11: unknown state [bogus]');
  });
});

describe('Assert aria-snapshot validation', () => {
  type Config = Parameters<NonNullable<typeof assertBlock.validate>>[0];
  const problems = (config: Partial<Config>) => assertBlock.validate!(withDefaults(assertBlock, config) as unknown as Config);

  it('needs no element, needs a template, reports its line', () => {
    expect(problems({ subject: 'aria-snapshot', expected: '- heading "Welcome"' })).toEqual([]);
    expect(problems({ subject: 'aria-snapshot', expected: '' })).toEqual([expect.objectContaining({ key: 'expected', code: 'config.required' })]);
    expect(problems({ subject: 'aria-snapshot', expected: '- list:\n  - listitem [level=x]' })).toEqual([
      { key: 'expected', code: 'config.value', message: 'Expected ARIA snapshot, line 2, column 21: [level=x]: the value must be a number (heading level 1 to 6)' },
    ]);
    // Templated ones are checked when they run.
    expect(problems({ subject: 'aria-snapshot', expected: '- heading "{{name}}" [' })).toEqual([]);
  });

  it('import checking reports it at config/expected', () => {
    const text = JSON.stringify({
      format: 'blockflow-script',
      version: 1,
      name: 'Aria',
      steps: [{ id: 'open', open: { url: 'https://example.com' } }, { id: 'a', assert: { subject: 'aria-snapshot', expected: '- heading "x" [lvl=1]' } }],
    });
    const result = parseImport(text, []);
    const issue = result.issues.find((candidate) => candidate.path.endsWith('/expected'));
    expect(issue?.message).toContain('line 1, column 16: unknown state [lvl]');
  });
});

describe('Assert aria-snapshot → Playwright', () => {
  const exported = (config: Record<string, unknown>) =>
    workflowToPlaywright(flow([{ id: 'open', type: 'open-url', config: { url: 'https://shop.test/' } }, { id: 'a', type: 'assert', config: { subject: 'aria-snapshot', ...config } }], [['open', 'a']]), { registry });

  it('toMatchAriaSnapshot on the body or the element, template in Playwright form', () => {
    const page = exported({ expected: '- heading "Welcome" [level=1] [ref=e1] locator=role=heading[name="Welcome"]\n- textbox "Email" [required]' });
    expect(page).toContain('// BlockFlow-only: [required] not checked by Playwright\'s toMatchAriaSnapshot.');
    expect(page).toContain('await expect(tabs["main"].locator(\'body\')).toMatchAriaSnapshot(`\n    - heading "Welcome" [level=1]\n    - textbox "Email"\n  `);');

    const part = exported({ locator: 'role=form', expected: '- button /Sign (in|up)/\n- text: "a `b` ${c}"', message: 'Form changed' });
    expect(part).toContain('await expect(tabs["main"].getByRole("form").first(), "Form changed").toMatchAriaSnapshot(`\n    - button /Sign (in|up)/\n    - text: "a \\`b\\` \\${c}"\n  `);');
  });

  it('a templated expected is rendered at run time', () => {
    expect(exported({ expected: '- heading "{{name}}"' })).toContain('toMatchAriaSnapshot(render("- heading \\"{{name}}\\"", data));');
  });
});
