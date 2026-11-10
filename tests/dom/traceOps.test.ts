// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../../src/dom/agent';
import { resolveLocator } from '../../src/dom/locator';
import { takeSnapshot } from '../../src/dom/snapshot';
import type { AgentRequest, AgentResponse } from '../../src/core/page';

// M5.1 page ops: `box` (trace) and `highlight` (debug pauses).

const agent = createAgent();
const run = (request: AgentRequest, budgetMs = 0): Promise<AgentResponse> => agent.run({ request, budgetMs });
const result = async (request: AgentRequest) => {
  const answer = await run(request);
  if (answer.status !== 'done') throw new Error(`expected done, got ${JSON.stringify(answer)}`);
  return answer.result;
};
const rect = (element: Element, x: number, y: number, width: number, height: number) => {
  element.getBoundingClientRect = () => ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;
};
const overlays = () => Array.from(document.querySelectorAll('[data-blockflow-highlight]')) as HTMLElement[];

beforeEach(() => {
  document.body.innerHTML = '';
  for (const overlay of overlays()) overlay.remove();
});
afterEach(() => vi.useRealTimers());

describe('box', () => {
  it('answers the first match’s box, the match count and visibility, without waiting', async () => {
    document.body.innerHTML = '<button id="a">One</button><button class="b">Two</button><button class="b">Three</button>';
    rect(document.querySelector('#a')!, 10, 20, 80, 30);
    expect(await result({ op: 'box', locator: '#a' })).toEqual({ found: true, x: 10, y: 20, width: 80, height: 30, count: 1, visible: true });
    // Two matches is not a strict-mode error here: a trace only looks.
    expect(await result({ op: 'box', locator: '.b' })).toMatchObject({ found: true, count: 2 });
    const started = Date.now();
    expect(await agent.run({ request: { op: 'box', locator: '#missing' }, budgetMs: 2000 })).toEqual({ status: 'done', result: { found: false, count: 0 } });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('reports hidden elements as not visible', async () => {
    document.body.innerHTML = '<div id="h" style="display:none">x</div>';
    expect(await result({ op: 'box', locator: '#h' })).toMatchObject({ found: true, visible: false });
  });

  it('a bad locator is an error', async () => {
    expect(await run({ op: 'box', locator: 'role=' })).toMatchObject({ status: 'error', code: 'locator.invalid' });
  });
});

describe('highlight', () => {
  it('draws one overlay over the element, in document coordinates, that catches no clicks', async () => {
    document.body.innerHTML = '<button id="a">Save</button>';
    rect(document.querySelector('#a')!, 100, 50, 60, 20);
    expect(await result({ op: 'highlight', locator: '#a', label: 'Paused: Click' })).toEqual({ highlighted: true, count: 1 });
    const [overlay] = overlays();
    expect(overlay).toBeDefined();
    expect(overlay!.style.position).toBe('absolute');
    expect(overlay!.style.left).toBe(`${100 + window.scrollX - 2}px`);
    expect(overlay!.style.top).toBe(`${50 + window.scrollY - 2}px`);
    expect(overlay!.style.width).toBe('64px');
    expect(overlay!.style.pointerEvents).toBe('none');
    expect(overlay!.getAttribute('aria-hidden')).toBe('true');
  });

  it('is invisible to locators and snapshots (label in a closed shadow root)', async () => {
    document.body.innerHTML = '<button id="a">Save</button>';
    await result({ op: 'highlight', locator: '#a', label: 'Paused here' });
    expect(resolveLocator('text=Paused here', document)).toHaveLength(0);
    expect(overlays()[0]!.textContent).toBe('');
    expect(takeSnapshot(document.body, { maxLines: 100 }).snapshot).not.toContain('Paused');
  });

  it('replaces an earlier highlight and is removed by clear', async () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    await result({ op: 'highlight', locator: '#a' });
    await result({ op: 'highlight', locator: '#b' });
    expect(overlays()).toHaveLength(1);
    expect(await result({ op: 'highlight', clear: true })).toEqual({ cleared: true });
    expect(overlays()).toHaveLength(0);
  });

  it('nothing matching clears the old highlight and says so', async () => {
    document.body.innerHTML = '<button id="a">A</button>';
    await result({ op: 'highlight', locator: '#a' });
    expect(await result({ op: 'highlight', locator: '#nope' })).toEqual({ highlighted: false, count: 0 });
    expect(overlays()).toHaveLength(0);
  });

  it('goes away by itself after `ms`', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="a">A</button>';
    await result({ op: 'highlight', locator: '#a', ms: 1000 });
    expect(overlays()).toHaveLength(1);
    vi.advanceTimersByTime(1001);
    expect(overlays()).toHaveLength(0);
  });
});
