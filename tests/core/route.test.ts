import { describe, expect, it, vi } from 'vitest';
import { parseRouteRules, routeBlock } from '../../src/core/blocks/route';
import { withDefaults } from '../../src/core/config';
import { createDefaultRegistry } from '../../src/core/blocks';
import { WorkflowRunner } from '../../src/core/engine';
import { FakeHost, flow } from '../helpers/fakeHost';

const config = (patch: Record<string, unknown>) => withDefaults(routeBlock, patch) as never;
describe('Route block', () => {
  it('validates malformed JSON, unknown rule keys, invalid patterns and invalid header/status values', () => {
    for (const rules of ['not json', '{}', '[]', '[{"url":"/api","action":"unknown"}]', '[{"url":"/api","action":"fulfill","statuz":200}]', '[{"url":"/[/","action":"abort"}]', '[{"url":"/api","action":"fulfill","status":999}]', '[{"url":"/api","action":"fulfill","headers":{"X-Test":"bad\\nheader"}}]']) {
      expect(routeBlock.validate?.(config({ rules }))).toContainEqual(expect.objectContaining({ key: 'rules' }));
    }
  });
  it('rejects unsupported combinations instead of silently dropping settings', () => {
    for (const rule of [
      { url: '/api', action: 'abort', body: 'oops' }, { url: '/api', action: 'continue', headers: { X: 'a' } },
      { url: '/api', action: 'redirect', redirectUrl: 'javascript:alert(1)' }, { url: '/api', action: 'modify' },
      { url: '/api', action: 'abort', delayMs: -1 },
    ]) expect(() => parseRouteRules([rule])).toThrow();
    expect(routeBlock.validate?.(config({ action: 'clear', rules: 'ignored' }))).toEqual([]);
    expect(routeBlock.validate?.(config({ backend: 'dnr', rules: '[{"url":"/api","action":"fulfill"}]' }))).toContainEqual(expect.objectContaining({ key: 'rules' }));
  });
  it('preserves valid templates and normalizes methods', () => {
    expect(parseRouteRules('[{"url":"**/api/**","action":"fulfill","method":"post","body":"{{token}}"}]')).toEqual([{ url: '**/api/**', action: 'fulfill', method: 'POST', body: '{{token}}' }]);
  });
  it('reports the intended permission for auto and explicit backends', () => {
    const permissions = routeBlock.permissions as (value: unknown) => string[];
    expect(permissions(config({ rules: '[{"url":"/api","action":"abort"}]' }))).toEqual(['declarativeNetRequest']);
    expect(permissions(config({ rules: '[{"url":"/api","action":"fulfill"}]' }))).toEqual(['debugger']);
    expect(permissions(config({ action: 'clear' }))).toEqual([]);
  });
  it('passes rendered rule content to the browser Host and exposes installation details', async () => {
    const host = new FakeHost();
    const route = vi.fn(async () => ({ rules: 1, backend: 'cdp' as const }));
    host.network.route = route;
    const registry = createDefaultRegistry(); if (!registry.has('route')) registry.register(routeBlock);
    const workflow = flow([
      { id: 'open', type: 'open-url', config: { url: 'https://shop.test' } },
      { id: 'value', type: 'set-variable', config: { name: 'message', value: 'mocked' } },
      { id: 'route', type: 'route', config: { backend: 'cdp', rules: '[{"url":"**/api/**","action":"fulfill","body":"{{message}}"}]' } },
    ], [['open', 'value'], ['value', 'route']]);
    const record = await new WorkflowRunner({ workflow, host, registry }).runOnce();
    expect(record.status).toBe('passed');
    expect(route).toHaveBeenCalledWith(100, { action: 'add', backend: 'cdp', rules: [{ url: '**/api/**', action: 'fulfill', body: 'mocked' }] });
    expect(record.steps.at(-1)?.output?.route).toEqual({ rules: 1, backend: 'cdp' });
  });
});
