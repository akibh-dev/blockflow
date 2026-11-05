import { browser } from 'wxt/browser';
import { startPicker } from '../dom/picker';
import { answerFramePathQuestions, framePath, withFramePath } from '../dom/framePath';
import type { PickerChannel, PickerHandle, PickerMode } from '../dom/picker';
import type { PickerSyncMessage } from '../shared/messages';

/**
 * The element picker. Not injected automatically: the background worker injects it on demand
 * (registration: 'runtime') into every frame of the tab when the user presses "Pick on page" in the
 * editor, after setting `__blockflowPickerMode`. Only the top frame shows the toolbar; the pickers of
 * the frames talk through `bf:picker-sync` messages that the background relays to the whole tab.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    const holder = window as unknown as { __blockflowPicker?: PickerHandle; __blockflowPickerMode?: PickerMode };
    // Pressing "Pick" twice should restart the picker, not stack two of them.
    holder.__blockflowPicker?.stop();
    // Child frames ask their parent which iframe they are.
    answerFramePathQuestions(window);

    const channel: PickerChannel = {
      post: (sync) => void browser.runtime.sendMessage({ type: 'bf:picker-sync', sync } satisfies PickerSyncMessage).catch(() => {}),
      listen: (handler) => {
        const listener = (message: unknown) => {
          if ((message as PickerSyncMessage | undefined)?.type === 'bf:picker-sync') handler((message as PickerSyncMessage).sync);
        };
        browser.runtime.onMessage.addListener(listener);
        return () => browser.runtime.onMessage.removeListener(listener);
      },
    };

    holder.__blockflowPicker = startPicker({
      mode: holder.__blockflowPickerMode ?? 'watch',
      toolbar: window === window.top,
      channel,
      onPick: (result) => {
        holder.__blockflowPicker = undefined;
        void (async () => {
          // Inside a frame: locators that start at the top page.
          const path = await framePath(window);
          if (path === null) {
            // The editor shows it; the background ends the pick.
            await browser.runtime.sendMessage({ type: 'bf:pick-error', message: 'Could not work out which frame this element is in. Write the frame= locator by hand.' });
            return;
          }
          await browser.runtime.sendMessage({
            type: 'bf:picked',
            ...result,
            selector: withFramePath(path, result.selector),
            candidates: result.candidates.map((candidate) => withFramePath(path, candidate)),
          });
        })().catch(() => {});
      },
      onCancel: () => {
        holder.__blockflowPicker = undefined;
        void browser.runtime.sendMessage({ type: 'bf:pick-cancelled' }).catch(() => {});
      },
    });
  },
});
