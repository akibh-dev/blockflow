import { describe, expect, it } from 'vitest';
import { flow, harness } from '../helpers/fakeHost';

describe('engine with locked secrets', () => {
  it('locked + workflow uses secrets → run fails with the locked message and zero steps', async () => {
    const h = harness(flow([{ id: 'l', type: 'log', config: { message: '{{secret.loginPassword}}', level: 'info' } }], []));
    h.host.secretsState = 'locked';
    await h.runner.start();
    const last = h.lastRun();
    expect(last!.status).toBe('failed');
    expect(last!.error).toContain('Secrets are locked');
    expect(last!.steps).toHaveLength(0);
  });

  it('locked + workflow does not use secrets → passes', async () => {
    const h = harness(flow([{ id: 'l', type: 'log', config: { message: 'hello', level: 'info' } }], []));
    h.host.secretsState = 'locked';
    await h.runner.start();
    const last = h.lastRun();
    expect(last!.status).toBe('passed');
  });

  it('unlocked + workflow uses secrets → passes', async () => {
    const h = harness(flow([{ id: 'l', type: 'log', config: { message: '{{secret.loginPassword}}', level: 'info' } }], []));
    h.host.secretsState = 'unlocked';
    h.host.secretValues = { loginPassword: 'hunter2' };
    await h.runner.start();
    const last = h.lastRun();
    expect(last!.status).toBe('passed');
  });

  it('plain + workflow uses secrets → passes (today\'s behaviour)', async () => {
    const h = harness(flow([{ id: 'l', type: 'log', config: { message: '{{secret.loginPassword}}', level: 'info' } }], []));
    h.host.secretsState = 'plain';
    h.host.secretValues = { loginPassword: 'hunter2' };
    await h.runner.start();
    const last = h.lastRun();
    expect(last!.status).toBe('passed');
  });
});
