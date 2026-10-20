import { browser } from 'wxt/browser';
import { startPicker } from '../dom/picker';
import type { PickerHandle } from '../dom/picker';

/**
 * The element picker. Not injected automatically: the background worker injects it on demand
 * (registration: 'runtime') when the user presses "Pick on page" in the editor.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    const holder = window as unknown as { __blockflowPicker?: PickerHandle };
    // Pressing "Pick" twice should restart the picker, not stack two of them.
    holder.__blockflowPicker?.stop();

    holder.__blockflowPicker = startPicker({
      onPick: (result) => {
        holder.__blockflowPicker = undefined;
        void browser.runtime.sendMessage({ type: 'bf:picked', ...result });
      },
      onCancel: () => {
        holder.__blockflowPicker = undefined;
        void browser.runtime.sendMessage({ type: 'bf:pick-cancelled' });
      },
    });
  },
});
