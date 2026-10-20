import { uid } from './id';
import type { Workflow } from './types';

/**
 * Example workflows created on first install. All start disabled so nothing runs until the
 * user turns it on.
 */
export function sampleWorkflows(): Workflow[] {
  const timerId = uid();
  const openId = uid();
  const timerFlow: Workflow = {
    schemaVersion: 1,
    id: uid(),
    name: 'Example: open a page every 5 minutes',
    enabled: false,
    nodes: [
      {
        id: timerId,
        type: 'timer',
        position: { x: 60, y: 120 },
        config: { seconds: 300, repeat: true },
      },
      {
        id: openId,
        type: 'open-url',
        position: { x: 380, y: 120 },
        config: { url: 'https://example.com', newTab: true, active: true },
      },
    ],
    edges: [{ id: uid(), source: timerId, target: openId }],
  };

  const watchId = uid();
  const openChangedId = uid();
  const watchFlow: Workflow = {
    schemaVersion: 1,
    id: uid(),
    name: 'Example: open the page when part of it changes',
    enabled: false,
    nodes: [
      {
        id: watchId,
        type: 'watch-element',
        position: { x: 60, y: 120 },
        config: {
          url: 'https://example.com',
          selector: 'h1',
          intervalSeconds: 60,
          reload: true,
          emitOnFirstRead: false,
        },
      },
      {
        id: openChangedId,
        type: 'open-url',
        position: { x: 420, y: 120 },
        config: { url: '{{url}}', newTab: true, active: true },
      },
    ],
    edges: [{ id: uid(), source: watchId, target: openChangedId }],
  };

  return [timerFlow, watchFlow];
}
