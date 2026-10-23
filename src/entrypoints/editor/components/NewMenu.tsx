import { useEffect, useRef, useState } from 'react';
import { templates } from '../templates';

/** "+ New" with a small menu: a blank workflow, or one of the templates. */
export function NewMenu({ onBlank, onTemplate, plain = false }: { onBlank(): void; onTemplate(text: string): void; plain?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <span className="bf-menu" ref={box}>
      <button type="button" className={plain ? '' : 'bf-link'} onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open}>
        + New ▾
      </button>
      {open && (
        <div className="bf-menu-list" role="menu">
          <button type="button" role="menuitem" onClick={() => pick(onBlank)}>
            <strong>Blank workflow</strong>
          </button>
          <div className="bf-menu-heading">From a template</div>
          {templates.map((template) => (
            <button type="button" role="menuitem" key={template.id} onClick={() => pick(() => onTemplate(template.text))}>
              {template.name}
              {template.workflows > 1 && <span className="bf-muted"> · {template.workflows} workflows</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
