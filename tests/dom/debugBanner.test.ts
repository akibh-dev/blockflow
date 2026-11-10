// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fake = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  listeners: [] as ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[],
  sent: [] as unknown[],
}));
vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      session: { get: vi.fn(async (key: string) => (key in fake.session ? { [key]: fake.session[key] } : {})) },
      onChanged: {
        addListener: (fn: (typeof fake.listeners)[number]) => fake.listeners.push(fn),
        removeListener: (fn: (typeof fake.listeners)[number]) => fake.listeners.splice(fake.listeners.indexOf(fn), 1),
      },
    },
    runtime: { sendMessage: vi.fn(async (message: unknown) => void fake.sent.push(message)) },
  },
}));

const { DebugBanner } = await import('../../src/entrypoints/editor/components/DebugBanner');

const pause = (over: Record<string, unknown> = {}) => ({
  runId: 'r1',
  workflowId: 'wf',
  workflowName: 'Checkout',
  nodeId: 'buy',
  blockType: 'click',
  reason: 'breakpoint',
  input: { price: 12 },
  pausedAt: '2026-11-10T10:00:00.000Z',
  tabId: 4,
  locator: '#buy',
  ...over,
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe('DebugBanner (M5.2)', () => {
  it('shows a pause stored before the editor opened, follows storage, and answers', async () => {
    fake.session['bf:debug-pause'] = [pause()];
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(DebugBanner)));
    await flush();
    const text = host.textContent ?? '';
    expect(text).toContain('Checkout');
    expect(text).toContain('paused before Click');
    expect(text).toContain('at a breakpoint');
    expect(host.querySelector('pre')?.textContent).toContain('"price": 12');

    const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;
    await act(async () => button('Step').click());
    await act(async () => button('Stop').click());
    expect(fake.sent).toEqual([
      { type: 'bf:debug-answer', runId: 'r1', action: 'step' },
      { type: 'bf:debug-answer', runId: 'r1', action: 'stop' },
    ]);

    // The worker moves the pause on (pause on error), then clears it.
    await act(async () => fake.listeners.forEach((fn) => fn({ 'bf:debug-pause': { newValue: [pause({ reason: 'error', error: 'Expected "a"', nodeId: 'check' })] } }, 'session')));
    expect(host.textContent).toContain('on an error');
    expect(host.querySelector('.bf-error')?.textContent).toBe('Expected "a"');
    await act(async () => fake.listeners.forEach((fn) => fn({ 'bf:debug-pause': { newValue: [] } }, 'session')));
    expect(host.innerHTML).toBe('');
    // Other areas / keys are ignored.
    await act(async () => fake.listeners.forEach((fn) => fn({ 'bf:debug-pause': { newValue: [pause()] } }, 'local')));
    expect(host.innerHTML).toBe('');
    await act(async () => root.unmount());
    expect(fake.listeners).toHaveLength(0);
  });
});
