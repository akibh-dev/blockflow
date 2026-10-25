import { browser } from 'wxt/browser';
import { startRecorder } from '../dom/recorder';
import type { RecorderHandle } from '../dom/recorder';

/**
 * The recorder, injected on demand into the recording tab by src/browser/recording.ts (again after
 * every page load, since a new page starts without it).
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    const holder = globalThis as { __blockflowRecorder?: RecorderHandle };
    if (holder.__blockflowRecorder) return; // single-page apps: already recording this document
    holder.__blockflowRecorder = startRecorder({
      onStep: (step) => void browser.runtime.sendMessage({ type: 'bf:recorded', step }).catch(() => {}),
      onStop: () => void browser.runtime.sendMessage({ type: 'bf:stop-recording' }).catch(() => {}),
    });
  },
});
