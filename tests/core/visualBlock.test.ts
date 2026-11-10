import { describe, expect, it } from 'vitest';
import { screenshotBlock } from '../../src/core/blocks';
import { withDefaults } from '../../src/core/config';
import { workflowToPlaywright } from '../../src/core/playwright';
import { createDefaultRegistry } from '../../src/core/blocks';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

type Node = { id: string; type: string; config?: Record<string, unknown> };

const chain = (...nodes: Node[]) => {
  const all: Node[] = [{ id: 'open', type: 'open-url', config: { url: 'https://shop.test/account' } }, ...nodes];
  return flow(all, all.slice(1).map((node, index) => [all[index]!.id, node.id] as [string, string]));
};
const stepOf = (run: { steps: { nodeId: string }[] }, id: string) => run.steps.find((step) => step.nodeId === id) as Record<string, unknown> | undefined;
const validate = (config: Record<string, unknown>) => screenshotBlock.validate?.(withDefaults(screenshotBlock, config) as never) ?? [];

describe('Screenshot compare (M5.3)', () => {
  it('first run saves the baseline, the same look passes, a changed look fails with visual.mismatch', async () => {
    const host = new FakeHost();
    const wf = chain({ id: 'shot', type: 'screenshot', config: { compare: true, mask: [{ region: '#clock' }, { region: '0, 0, 50, 20' }] } });
    const first = await harness(wf, host).runner.runOnce();
    expect(first.status).toBe('passed');
    expect(stepOf(first, 'shot')).toMatchObject({ screenshot: 'block-shot-1', output: { visual: { status: 'baseline-saved', diffRatio: 0, comparisonId: 'cmp-1' } } });
    expect(host.visualRequests[0]).toMatchObject({
      workflowId: wf.id,
      nodeId: 'shot',
      tabId: 100,
      screenshotId: 'block-shot-1',
      area: 'visible',
      threshold: 0.2,
      maxDiffRatio: 0,
      updateBaseline: false,
      mask: [{ locator: '#clock' }, { rect: { x: 0, y: 0, width: 50, height: 20 } }],
    });

    const same = await harness(wf, host).runner.runOnce();
    expect(stepOf(same, 'shot')).toMatchObject({ status: 'passed', output: { visual: { status: 'match' } } });

    host.pageLook = 'look-2';
    const changed = await harness(wf, host).runner.runOnce();
    expect(changed.status).toBe('failed');
    expect(stepOf(changed, 'shot')).toMatchObject({ status: 'failed', code: 'visual.mismatch' });
    expect(String(stepOf(changed, 'shot')?.error)).toMatch(/25\.0% of the pixels .*more than the 0% allowed/);
  });

  it('maxDiffRatio lets a small difference pass; updateBaseline replaces the baseline', async () => {
    const host = new FakeHost();
    host.visualDiffRatio = (a, b) => (a === b ? 0 : 0.004);
    const wf = chain({ id: 'shot', type: 'screenshot', config: { compare: true, maxDiffRatio: 0.01 } });
    await harness(wf, host).runner.runOnce();
    host.pageLook = 'look-2';
    const run = await harness(wf, host).runner.runOnce();
    expect(stepOf(run, 'shot')).toMatchObject({ status: 'passed', output: { visual: { status: 'match', diffRatio: 0.004 } } });

    const update = chain({ id: 'shot', type: 'screenshot', config: { compare: true, updateBaseline: true } });
    update.id = wf.id;
    const updated = await harness(update, host).runner.runOnce();
    expect(stepOf(updated, 'shot')).toMatchObject({ status: 'passed', output: { visual: { status: 'baseline-updated' } } });
    expect(host.baselines.get(`${wf.id}/shot`)).toBe('look-2');
  });

  it('element area passes its locator; without a visual host compare is a config error', async () => {
    const host = new FakeHost();
    await harness(chain({ id: 'card', type: 'screenshot', config: { compare: true, area: 'element', locator: '#card' } }), host).runner.runOnce();
    expect(host.visualRequests[0]).toMatchObject({ area: 'element', locator: '#card' });

    const bare = new FakeHost();
    bare.visual = undefined;
    const run = await harness(chain({ id: 's', type: 'screenshot', config: { compare: true } }), bare).runner.runOnce();
    expect(stepOf(run, 's')).toMatchObject({ status: 'failed', code: 'config.invalid' });
    // Without compare nothing changes.
    const plain = await harness(chain({ id: 's', type: 'screenshot', config: {} }), bare).runner.runOnce();
    expect(plain.status).toBe('passed');
    expect((stepOf(plain, 's')?.output as Record<string, unknown>).visual).toBeUndefined();
  });

  it('validates strictly', () => {
    expect(validate({ compare: true })).toEqual([]);
    expect(validate({ compare: true, format: 'jpeg' })).toEqual([expect.objectContaining({ key: 'format' })]);
    expect(validate({ compare: true, threshold: 1.5 })).toEqual([expect.objectContaining({ key: 'threshold' })]);
    expect(validate({ compare: true, maxDiffRatio: -0.1 })).toEqual([expect.objectContaining({ key: 'maxDiffRatio' })]);
    expect(validate({ compare: true, mask: [{ region: '1,2,3' }] })).toEqual([expect.objectContaining({ key: 'mask' })]);
    expect(validate({ updateBaseline: true })).toEqual([expect.objectContaining({ key: 'updateBaseline' })]);
    expect(validate({ mask: [{ region: '#clock' }] })).toEqual([expect.objectContaining({ key: 'mask' })]);
    expect(validate({})).toEqual([]);
  });

  it('a bad setting fails the step before any picture is taken', async () => {
    const host = new FakeHost();
    const run = await harness(chain({ id: 's', type: 'screenshot', config: { compare: true, format: 'jpeg' } }), host).runner.runOnce();
    expect(stepOf(run, 's')).toMatchObject({ status: 'failed', code: 'config.invalid' });
    expect(host.screenshotRequests).toEqual([]);
  });

  it('exports to toHaveScreenshot with options', () => {
    const registry = createDefaultRegistry();
    const code = (config: Record<string, unknown>) => workflowToPlaywright(chain({ id: 'shot', type: 'screenshot', config }), { registry });
    const page = code({ compare: true, area: 'full', threshold: 0.1, maxDiffRatio: 0.01, mask: [{ region: '#clock' }, { region: '0, 0, 10, 10' }] });
    expect(page).toContain('await expect(tabs["main"]).toHaveScreenshot("shot.png", { fullPage: true, threshold: 0.1, maxDiffPixelRatio: 0.01, mask: [tabs["main"].locator("#clock")] });');
    expect(page).toContain('// BlockFlow-only: mask rectangles 0,0,10,10');
    const element = code({ compare: true, area: 'element', locator: '#card', updateBaseline: true });
    expect(element).toContain('await expect(tabs["main"].locator("#card").first()).toHaveScreenshot("shot.png");');
    expect(element).toContain('--update-snapshots');
  });
});
