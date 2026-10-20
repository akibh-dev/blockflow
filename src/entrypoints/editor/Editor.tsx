import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react';
import type { Connection, Edge, EdgeChange, NodeChange } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { clearLogs, loadWorkflows, saveWorkflows } from '../../browser/stores';
import { validateWorkflow } from '../../core/validate';
import { createWorkflow, uid } from '../../core/workflow';
import type { LogEntry, Workflow } from '../../core/types';
import { BlockNode, IssuesContext } from './components/BlockNode';
import type { BlockFlowNode } from './components/BlockNode';
import { ConfigPanel } from './components/ConfigPanel';
import { LogPanel } from './components/LogPanel';
import { DRAG_MIME, Sidebar } from './components/Sidebar';
import { fromFlow, sameGraph, toFlow } from './flow/convert';
import { useLogs } from './hooks';
import { registry } from './registry';

const nodeTypes = { block: BlockNode };
const defaultEdgeOptions = { type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } };
const SAVE_DELAY_MS = 400;

export function Editor() {
  const { screenToFlowPosition } = useReactFlow();
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<BlockFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [showAllLogs, setShowAllLogs] = useState(false);
  const logs = useLogs();

  const active = useMemo(
    () => workflows?.find((workflow) => workflow.id === activeId) ?? null,
    [workflows, activeId],
  );

  // --- loading -----------------------------------------------------------

  const open = useCallback((workflow: Workflow) => {
    const flow = toFlow(workflow);
    setNodes(flow.nodes as BlockFlowNode[]);
    setEdges(flow.edges);
    setActiveId(workflow.id);
  }, []);

  useEffect(() => {
    let alive = true;
    void loadWorkflows().then((stored) => {
      if (!alive) return;
      const list = stored.length > 0 ? stored : [createWorkflow('My first workflow')];
      setWorkflows(list);
      open(list[0] as Workflow);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  // --- canvas → workflow → storage ---------------------------------------

  // Copy what is on the canvas into the workflow list, but only when something real changed
  // (React Flow also reports selection and measurement changes).
  useEffect(() => {
    if (!activeId) return;
    setWorkflows((previous) => {
      const base = previous?.find((workflow) => workflow.id === activeId);
      if (!previous || !base) return previous;
      const next = fromFlow(base, nodes, edges);
      return sameGraph(base, next) ? previous : previous.map((workflow) => (workflow.id === activeId ? next : workflow));
    });
  }, [nodes, edges, activeId]);

  const latest = useRef<Workflow[] | null>(null);
  latest.current = workflows;

  useEffect(() => {
    if (!workflows) return;
    const timer = setTimeout(() => void saveWorkflows(workflows), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [workflows]);

  // Do not lose the last edit if the tab is closed right away.
  useEffect(() => {
    const flush = () => {
      if (latest.current) void saveWorkflows(latest.current);
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  // --- validation --------------------------------------------------------

  const issues = useMemo(() => (active ? validateWorkflow(active, registry) : []), [active]);
  const errors = issues.filter((issue) => issue.level === 'error');
  const issuesByNode = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const issue of issues) {
      if (!issue.nodeId) continue;
      map.set(issue.nodeId, [...(map.get(issue.nodeId) ?? []), issue.message]);
    }
    return map;
  }, [issues]);

  // --- canvas events -----------------------------------------------------

  const onNodesChange = useCallback((changes: NodeChange<BlockFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source === connection.target) return;
    setEdges((current) => {
      const exists = current.some(
        (edge) => edge.source === connection.source && edge.target === connection.target,
      );
      return exists ? current : [...current, { id: uid(), source: connection.source, target: connection.target }];
    });
  }, []);

  const addBlock = useCallback((type: string, position?: { x: number; y: number }) => {
    const def = registry.get(type);
    if (!def) return;
    setNodes((current) => {
      const offset = (current.length % 6) * 36;
      const node: BlockFlowNode = {
        id: uid(),
        type: 'block',
        position: position ?? { x: 120 + offset, y: 100 + offset },
        data: { blockType: type, config: { ...def.defaultConfig } },
        selected: true,
      };
      return [...current.map((existing) => ({ ...existing, selected: false })), node];
    });
  }, []);

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData(DRAG_MIME);
      if (!type) return;
      addBlock(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [addBlock, screenToFlowPosition],
  );

  const updateConfig = useCallback((nodeId: string, patch: Record<string, unknown>) => {
    setNodes((current) =>
      current.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, config: { ...node.data.config, ...patch } } } : node,
      ),
    );
  }, []);

  const deleteBlock = useCallback((nodeId: string) => {
    setNodes((current) => current.filter((node) => node.id !== nodeId));
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
  }, []);

  // --- workflow list actions ---------------------------------------------

  const createNew = useCallback(() => {
    const workflow = createWorkflow(`Workflow ${(latest.current?.length ?? 0) + 1}`);
    setWorkflows((current) => [...(current ?? []), workflow]);
    open(workflow);
  }, [open]);

  const select = useCallback(
    (id: string) => {
      const workflow = latest.current?.find((candidate) => candidate.id === id);
      if (workflow) open(workflow);
    },
    [open],
  );

  const rename = (name: string) =>
    setWorkflows((current) => current?.map((workflow) => (workflow.id === activeId ? { ...workflow, name } : workflow)) ?? current);

  const setEnabled = (enabled: boolean) =>
    setWorkflows((current) => current?.map((workflow) => (workflow.id === activeId ? { ...workflow, enabled } : workflow)) ?? current);

  const removeActive = () => {
    if (!active || !window.confirm(`Delete “${active.name}”? This cannot be undone.`)) return;
    const remaining = (workflows ?? []).filter((workflow) => workflow.id !== active.id);
    const next = remaining.length > 0 ? remaining : [createWorkflow('My first workflow')];
    setWorkflows(next);
    open(next[0] as Workflow);
  };

  // --- logs --------------------------------------------------------------

  const visibleLogs = useMemo(
    () => (showAllLogs ? logs : logs.filter((entry) => entry.workflowId === activeId)),
    [logs, showAllLogs, activeId],
  );

  const labelFor = useCallback(
    (entry: LogEntry) => {
      const workflow = workflows?.find((candidate) => candidate.id === entry.workflowId);
      const node = workflow?.nodes.find((candidate) => candidate.id === entry.nodeId);
      const block = node ? (registry.get(node.type)?.label ?? node.type) : '';
      if (showAllLogs) return [workflow?.name ?? 'Deleted workflow', block].filter(Boolean).join(' · ');
      return block;
    },
    [workflows, showAllLogs],
  );

  const selectedNode = nodes.find((node) => node.selected);

  if (!workflows || !active) return <div className="bf-loading">Loading…</div>;

  return (
    <IssuesContext.Provider value={issuesByNode}>
      <div className="bf-app">
        <header className="bf-header">
          <strong className="bf-brand">BlockFlow</strong>
          <input
            className="bf-name"
            value={active.name}
            onChange={(event) => rename(event.target.value)}
            aria-label="Workflow name"
          />
          <label
            className="bf-switch"
            title={errors.length > 0 ? 'Fix the errors first' : active.enabled ? 'Running in the background' : 'Turn on to run'}
          >
            <input
              type="checkbox"
              checked={active.enabled}
              disabled={errors.length > 0 && !active.enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>{active.enabled ? 'On' : 'Off'}</span>
          </label>
          {errors.length > 0 && <span className="bf-error">{errors.length} problem{errors.length === 1 ? '' : 's'}</span>}
          <span className="bf-spacer" />
          <button type="button" className="bf-link" onClick={removeActive}>
            Delete workflow
          </button>
        </header>

        <Sidebar workflows={workflows} activeId={activeId} onSelect={select} onCreate={createNew} onAddBlock={addBlock} />

        <main className="bf-canvas" onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            key={activeId}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            defaultEdgeOptions={defaultEdgeOptions}
            deleteKeyCode={['Backspace', 'Delete']}
            colorMode="system"
            fitView
            fitViewOptions={{ padding: 0.4, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
          {active.nodes.length === 0 && (
            <p className="bf-empty">Add blocks from the left, then drag from one block’s right dot to another block’s left dot to connect them.</p>
          )}
        </main>

        <ConfigPanel
          node={selectedNode}
          problems={selectedNode ? (issuesByNode.get(selectedNode.id) ?? []) : []}
          onChange={updateConfig}
          onDelete={deleteBlock}
        />

        <LogPanel
          entries={visibleLogs}
          labelFor={labelFor}
          showAll={showAllLogs}
          onToggleAll={setShowAllLogs}
          onClear={() => void clearLogs()}
        />
      </div>
    </IssuesContext.Provider>
  );
}
