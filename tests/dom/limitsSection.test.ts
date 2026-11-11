// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { LimitsSection } from '../../src/entrypoints/editor/components/LimitsSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(settings: Record<string, unknown>) {
  const container = document.createElement('div');
  document.body.append(container);
  const onSave = vi.fn();
  const root = createRoot(container);
  act(() => root.render(createElement(LimitsSection, { settings: { outsideControl: false, ...settings } as never, onSave })));
  const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const blurWith = (label: string, value: string) =>
    act(() => {
      const field = input(label);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(field, value);
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
  return { container, onSave, input, blurWith, unmount: () => act(() => root.unmount()) };
}

describe('Settings → Limits', () => {
  it('shows defaults for unset limits and stored values for set ones', () => {
    const view = mount({ runHistory: 100 });
    expect(view.input('Runs kept in the history').value).toBe('100');
    expect(view.input('Run log lines kept').value).toBe('300');
    expect(view.input('Screenshots kept').value).toBe('150');
    expect(view.input('Blocks per run (loop guard)').value).toBe('1000');
    view.unmount();
  });

  it('saves a changed value into the settings, keeping the other settings', () => {
    const view = mount({ outsideControl: true });
    view.blurWith('Screenshots kept', '300');
    expect(view.onSave).toHaveBeenCalledWith({ outsideControl: true, screenshots: 300 });
    view.unmount();
  });

  it('clamps out-of-range input and shows the clamped number', () => {
    const view = mount({});
    view.blurWith('Runs kept in the history', '5000');
    expect(view.onSave).toHaveBeenCalledWith({ outsideControl: false, runHistory: 500 });
    expect(view.input('Runs kept in the history').value).toBe('500');
    view.unmount();
  });

  it('does not save when nothing changed, and an empty field falls back to the default', () => {
    const view = mount({});
    view.blurWith('Run log lines kept', '300');
    expect(view.onSave).not.toHaveBeenCalled();
    view.blurWith('Run log lines kept', '');
    expect(view.onSave).not.toHaveBeenCalled();
    expect(view.input('Run log lines kept').value).toBe('300');
    view.unmount();
  });
});
