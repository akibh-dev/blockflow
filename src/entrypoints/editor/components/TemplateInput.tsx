import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

interface TemplateInputProps {
  value: string;
  onChange(value: string): void;
  /** Names offered after typing {{ (data keys, secret.x). */
  suggestions: string[];
  placeholder?: string | undefined;
  multiline?: boolean | undefined;
  ariaLabel?: string | undefined;
  title?: string | undefined;
}

interface Menu {
  items: string[];
  /** Where the name being typed starts (just after {{). */
  start: number;
  active: number;
}

/** A text field that suggests data names after `{{`, like an IDE. */
export function TemplateInput({ value, onChange, suggestions, placeholder, multiline, ariaLabel, title }: TemplateInputProps) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<Menu | null>(null);

  /** Open the menu when the caret is inside an unclosed `{{` and the typed name matches suggestions. */
  const look = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const open = before.lastIndexOf('{{');
    if (open < 0 || before.slice(open).includes('}}')) return setMenu(null);
    const typed = before.slice(open + 2).trimStart();
    if (/[^\w.$-]/.test(typed)) return setMenu(null);
    const lower = typed.toLowerCase();
    const items = suggestions.filter((item) => item.toLowerCase().startsWith(lower) && item !== typed).slice(0, 8);
    setMenu(items.length > 0 ? { items, start: caret - typed.length, active: 0 } : null);
  };

  /** Replace the typed name with `item}}` (swallowing an existing `}}`) and put the caret after it. */
  const insert = (item: string) => {
    const field = ref.current;
    if (!field || !menu) return;
    const caret = field.selectionStart ?? value.length;
    const rest = value.slice(caret).replace(/^\s*\}\}/, '');
    const next = `${value.slice(0, menu.start)}${item}}}${rest}`;
    onChange(next);
    setMenu(null);
    const position = menu.start + item.length + 2;
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(position, position);
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!menu) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setMenu({ ...menu, active: (menu.active + step + menu.items.length) % menu.items.length });
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      insert(menu.items[menu.active] as string);
    } else if (event.key === 'Escape') setMenu(null);
  };

  const common = {
    ref,
    value,
    placeholder,
    spellCheck: false,
    'aria-label': ariaLabel,
    title,
    onKeyDown,
    onBlur: () => setTimeout(() => setMenu(null), 150),
    onChange: (event: { target: HTMLInputElement | HTMLTextAreaElement }) => {
      onChange(event.target.value);
      look(event.target.value, event.target.selectionStart ?? event.target.value.length);
    },
  };

  return (
    <span className="bf-template-input">
      {multiline ? <textarea rows={4} {...common} /> : <input type="text" {...common} />}
      {menu && (
        <ul className="bf-suggest" role="listbox">
          {menu.items.map((item, index) => (
            <li key={item} role="option" aria-selected={index === menu.active}>
              <button type="button" className={index === menu.active ? 'active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => insert(item)}>
                {`{{${item}}}`}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
