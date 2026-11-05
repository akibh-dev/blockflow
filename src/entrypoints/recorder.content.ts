import { browser } from 'wxt/browser';
import { startRecorder } from '../dom/recorder';
import { answerFramePathQuestions, framePath, withFramePath } from '../dom/framePath';
import type { RecorderChannel, RecorderHandle } from '../dom/recorder';
import type { RecordedStep } from '../core/recording';
import type { RecorderSyncMessage } from '../shared/messages';

/**
 * The recorder, injected on demand into every frame of the recording tab (and of the popups it opens)
 * by src/browser/recording.ts, again after every page load, since a new page starts without it.
 * Only the top frame shows the toolbar; steps recorded inside a frame get `frame=… >> ` locators.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    const holder = globalThis as { __blockflowRecorder?: RecorderHandle };
    if (holder.__blockflowRecorder) return; // single-page apps: already recording this document
    answerFramePathQuestions(window);
    // Worked out once per document; steps wait for it, in order.
    const path = framePath(window);

    const channel: RecorderChannel = {
      post: (mode) => void browser.runtime.sendMessage({ type: 'bf:recorder-sync', mode } satisfies RecorderSyncMessage).catch(() => {}),
      listen: (handler) => {
        const listener = (message: unknown) => {
          if ((message as RecorderSyncMessage | undefined)?.type === 'bf:recorder-sync') handler((message as RecorderSyncMessage).mode);
        };
        browser.runtime.onMessage.addListener(listener);
        return () => browser.runtime.onMessage.removeListener(listener);
      },
    };

    const send = (step: RecordedStep) =>
      void path
        .then((frames) => {
          // A frame that cannot say where it is (no answer from a cross-origin parent) records nothing.
          if (frames === null) return;
          const located = 'locator' in step && frames.length > 0 ? { ...step, locator: withFramePath(frames, step.locator) } : step;
          return browser.runtime.sendMessage({ type: 'bf:recorded', step: located });
        })
        .catch(() => {});

    holder.__blockflowRecorder = startRecorder({
      toolbar: window === window.top,
      channel,
      onStep: send,
      onStop: () => void browser.runtime.sendMessage({ type: 'bf:stop-recording' }).catch(() => {}),
    });
  },
});
