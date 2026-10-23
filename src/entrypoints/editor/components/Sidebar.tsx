import { useState } from 'react';
import type { DragEvent } from 'react';
import type { Workflow } from '../../../core/types';
import { registry } from '../registry';
import { ImportButton } from './ImportButton';
import type { WorkflowActions } from './WorkflowActions';

export const DRAG_MIME = 'application/x-blockflow-block';

interface SidebarProps extends WorkflowActions {
  workflows: Workflow[];
  activeId: string | null;
  onAddBlock(type: string): void;
}

export function Sidebar({ workflows, activeId, onAddBlock, ...actions }: SidebarProps) {
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);

  const onDragStart = (event: DragEvent<HTMLButtonElement>, type: string) => {
    event.dataTransfer.setData(DRAG_MIME, type);
    event.dataTransfer.effectAllowed = 'move';
  };

  const shown = workflows.filter((workflow) => workflow.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <aside className="bf-sidebar">
      <section>
        <div className="bf-section-title">
          <span>Workflows</span>
          <span>
            <button type="button" className="bf-link" onClick={actions.onCreate}>
              + New
            </button>
            <ImportButton className="bf-link" onFiles={actions.onImport} />
          </span>
        </div>
        {workflows.length > 4 && (
          <input
            type="text"
            className="bf-search"
            placeholder="Search…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search workflows"
          />
        )}
        <ul className="bf-workflow-list">
          {shown.map((workflow) => (
            <li key={workflow.id} className={workflow.id === activeId ? 'active' : ''}>
              <button
                type="button"
                className="bf-dot-button"
                title={workflow.enabled ? 'Running. Click to turn off' : 'Off. Click to turn on'}
                onClick={() => actions.onToggle(workflow.id, !workflow.enabled)}
              >
                <span className={`bf-dot${workflow.enabled ? ' on' : ''}`} />
              </button>
              {renaming === workflow.id ? (
                <input
                  type="text"
                  autoFocus
                  defaultValue={workflow.name}
                  aria-label="Rename workflow"
                  onFocus={(event) => event.target.select()}
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    if (name) actions.onRename(workflow.id, name);
                    setRenaming(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    if (event.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="bf-workflow-name"
                  onClick={() => actions.onOpen(workflow.id)}
                  onDoubleClick={() => setRenaming(workflow.id)}
                  title={workflow.name}
                >
                  {workflow.name}
                </button>
              )}
              <span className="bf-row-actions">
                <button type="button" title="Rename" onClick={() => setRenaming(workflow.id)}>
                  ✎
                </button>
                <button type="button" title="Duplicate" onClick={() => actions.onDuplicate(workflow.id)}>
                  ⧉
                </button>
                <button type="button" title="Export to file" onClick={() => actions.onExport([workflow.id])}>
                  ⬇
                </button>
                <button type="button" className="bf-danger" title="Delete" onClick={() => actions.onDelete(workflow.id)}>
                  🗑
                </button>
              </span>
            </li>
          ))}
          {shown.length === 0 && <li className="bf-muted">No match.</li>}
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
