import type { DragEvent } from 'react';
import type { Workflow } from '../../../core/types';
import { registry } from '../registry';

export const DRAG_MIME = 'application/x-blockflow-block';

interface SidebarProps {
  workflows: Workflow[];
  activeId: string | null;
  onSelect(id: string): void;
  onCreate(): void;
  onAddBlock(type: string): void;
}

export function Sidebar({ workflows, activeId, onSelect, onCreate, onAddBlock }: SidebarProps) {
  const onDragStart = (event: DragEvent<HTMLButtonElement>, type: string) => {
    event.dataTransfer.setData(DRAG_MIME, type);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <aside className="bf-sidebar">
      <section>
        <div className="bf-section-title">
          <span>Workflows</span>
          <button type="button" className="bf-link" onClick={onCreate}>
            + New
          </button>
        </div>
        <ul className="bf-workflow-list">
          {workflows.map((workflow) => (
            <li key={workflow.id}>
              <button
                type="button"
                className={workflow.id === activeId ? 'active' : ''}
                onClick={() => onSelect(workflow.id)}
              >
                <span className={`bf-dot${workflow.enabled ? ' on' : ''}`} title={workflow.enabled ? 'Running' : 'Off'} />
                {workflow.name}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="bf-section-title">
          <span>Blocks</span>
        </div>
        <p className="bf-muted">Drag onto the canvas, or click to add.</p>
        <ul className="bf-palette">
          {registry.list().map((def) => (
            <li key={def.type}>
              <button
                type="button"
                draggable
                onDragStart={(event) => onDragStart(event, def.type)}
                onClick={() => onAddBlock(def.type)}
                style={{ borderLeftColor: def.accent }}
              >
                <strong>
                  {def.icon} {def.label}
                </strong>
                <span>{def.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
