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
import { browser } from 'wxt/browser';
import { clearLogs, clearRuns, loadWorkflows, saveWorkflows } from '../../browser/stores';
import { edgePort, nodePorts } from '../../core/ports';
import type { StepStatus } from '../../core/runs';
import { validateWorkflow } from '../../core/validate';
import { duplicateWorkflow, exportWorkflows, parseImport, uniqueName } from '../../core/library';
import { createWorkflow, uid } from '../../core/workflow';
import type { EdgeDef, LogEntry, StepSettings, Workflow } from '../../core/types';
import { BlockNode, IssuesContext, RunStatusContext } from './components/BlockNode';
import type { BlockFlowNode } from './components/BlockNode';
import { ConfigPanel } from './components/ConfigPanel';
import { LogPanel } from './components/LogPanel';
import { DRAG_MIME, Sidebar } from './components/Sidebar';
import type { WorkflowActions } from './components/WorkflowActions';
import { WorkflowsPage } from './components/WorkflowsPage';
import { downloadText, fileNameFor, readFiles } from './files';
import { fromFlow, sameGraph, toFlow } from './flow/convert';
import { useLogs, usePrompts, useRuns } from './hooks';
import { PromptBanner } from './components/PromptBanner';
import { ReportsPage } from './components/ReportsPage';
import { SecretsPage } from './components/SecretsPage';
import { DataPage } from './components/DataPage';
import { registry } from './registry';

const nodeTypes = { block: BlockNode };
const defaultEdgeOptions = { type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } };
const SAVE_DELAY_MS = 400;

/** The output an edge leaves from, resolving edges saved before blocks had several outputs. */
function portOfEdge(workflow: Workflow, edge: EdgeDef): string {
  const node = workflow.nodes.find((candidate) => candidate.id === edge.source);
  return edgePort(edge, nodePorts(node ? registry.get(node.type) : undefined, node ?? {}));
}

export function Editor() {
  const { screenToFlowPosition } = useReactFlow();
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<BlockFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [showAllLogs, setShowAllLogs] = useState(false);
  const logs = useLogs();
  const runs = useRuns();
  const prompts = usePrompts();
  const [inspectedRunId, setInspectedRunId] = useState<string | undefined>();

  const active = useMemo(
    () => workflows?.find((workflow) => workflow.id === activeId) ?? null,
    [workflows, activeId],
  );

  // --- loading -----------------------------------------------------------

  const open = useCallback((workflow: Workflow) => {
    const flow = toFlow(workflow, (edge) => portOfEdge(workflow, edge));
    setNodes(flow.nodes as BlockFlowNode[]);
    setEdges(flow.edges);
    setActiveId(workflow.id);
    setInspectedRunId(undefined);
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
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

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
        (edge) =>
          edge.source === connection.source &&
          edge.target === connection.target &&
          (edge.sourceHandle ?? null) === (connection.sourceHandle ?? null),
      );
      return exists
        ? current
        : [...current, { id: uid(), source: connection.source, target: connection.target, sourceHandle: connection.sourceHandle }];
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

  const updateStep = useCallback((nodeId: string, patch: Partial<StepSettings>) => {
    setNodes((current) =>
      current.map((node) => {
        if (node.id !== nodeId) return node;
        const step: StepSettings = { ...node.data.step, ...patch };
        // Keep saved workflows small: drop settings that are back to their default.
        for (const key of Object.keys(step) as (keyof StepSettings)[]) {
          const value = step[key];
          if (value === undefined || value === '' || value === false || value === 0 || value === 'stop' || (key === 'screenshot' && value === 'error')) delete step[key];
        }
        return { ...node, data: { ...node.data, step } };
      }),
    );
    // Removing the error output must also remove connections from it.
    if (patch.onError !== undefined && patch.onError !== 'port') {
      setEdges((current) => current.filter((edge) => !(edge.source === nodeId && edge.sourceHandle === 'error')));
    }
  }, []);

  const deleteBlock = useCallback((nodeId: string) => {
    setNodes((current) => current.filter((node) => node.id !== nodeId));
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
  }, []);

  // --- workflow list actions (all by id, so the sidebar and the manager page share them) ---

  const [view, setView] = useState<'canvas' | 'manage' | 'reports' | 'data' | 'secrets'>('canvas');
  const notice = useCallback((message: string) => window.alert(message), []);

  const createNew = useCallback(() => {
    const workflow = createWorkflow(uniqueName(`Workflow ${(latest.current?.length ?? 0) + 1}`, (latest.current ?? []).map((w) => w.name)));
    setWorkflows((current) => [...(current ?? []), workflow]);
    open(workflow);
    setView('canvas');
  }, [open]);

  const select = useCallback(
    (id: string) => {
      const workflow = latest.current?.find((candidate) => candidate.id === id);
      if (workflow) open(workflow);
      setView('canvas');
    },
    [open],
  );

  const renameWorkflow = useCallback((id: string, name: string) => {
    setWorkflows((current) => current?.map((workflow) => (workflow.id === id ? { ...workflow, name } : workflow)) ?? current);
  }, []);

  /** Turning on a workflow with errors is refused, with the reason. Turning off always works. */
  const setEnabledFor = useCallback(
    (id: string, enabled: boolean): boolean => {
      const target = latest.current?.find((workflow) => workflow.id === id);
      if (!target) return false;
      if (enabled) {
        const blocking = validateWorkflow(target, registry).filter((issue) => issue.level === 'error');
        if (blocking.length > 0) {
          notice(`Cannot turn on “${target.name}”:\n- ${blocking.map((issue) => issue.message).join('\n- ')}`);
          return false;
        }
        if (target.nodes.length === 0) {
          notice(`“${target.name}” is empty. Add a block first.`);
          return false;
        }
      }
      setWorkflows((current) => current?.map((workflow) => (workflow.id === id ? { ...workflow, enabled } : workflow)) ?? current);
      return true;
    },
    [notice],
  );

  const setAllEnabled = useCallback(
    (enabled: boolean) => {
      for (const workflow of latest.current ?? []) {
        if (workflow.enabled !== enabled) setEnabledFor(workflow.id, enabled);
      }
    },
    [setEnabledFor],
  );

  const duplicate = useCallback(
    (id: string) => {
      const source = latest.current?.find((workflow) => workflow.id === id);
      if (!source) return;
      const copy = duplicateWorkflow(source, latest.current ?? []);
      setWorkflows((current) => [...(current ?? []), copy]);
      open(copy);
      setView('canvas');
    },
    [open],
  );

  const removeWorkflow = useCallback(
    (id: string) => {
      const target = latest.current?.find((workflow) => workflow.id === id);
      if (!target || !window.confirm(`Delete “${target.name}”? This cannot be undone.`)) return;
      const remaining = (latest.current ?? []).filter((workflow) => workflow.id !== id);
      const next = remaining.length > 0 ? remaining : [createWorkflow('My first workflow')];
      setWorkflows(next);
      if (id === activeIdRef.current) open(next[0] as Workflow);
    },
    [open],
  );

  const exportWorkflowsById = useCallback((ids: string[]) => {
    const chosen = (latest.current ?? []).filter((workflow) => ids.includes(workflow.id));
    if (chosen.length === 0) return;
    downloadText(fileNameFor(chosen.length === 1 ? (chosen[0] as Workflow).name : 'blockflow-workflows'), exportWorkflows(chosen));
  }, []);

  const importFiles = useCallback(
    async (files: FileList | null) => {
      const texts = await readFiles(files);
      let added: Workflow[] = [];
      for (const text of texts) {
        const result = parseImport(text, [...(latest.current ?? []), ...added]);
        if (!result.ok) {
          notice(`Import failed: ${result.error}`);
          continue;
        }
        added = [...added, ...result.workflows];
      }
      if (added.length === 0) return;
      setWorkflows((current) => [...(current ?? []), ...added]);
      open(added[0] as Workflow);
      setView('manage');
      notice(`Imported ${added.length} workflow${added.length === 1 ? '' : 's'}. They are off until you turn them on.`);
    },
    [notice, open],
  );

  const actions: WorkflowActions = {
    onOpen: select,
    onCreate: createNew,
    onRename: renameWorkflow,
    onToggle: (id, enabled) => void setEnabledFor(id, enabled),
    onDuplicate: duplicate,
    onExport: exportWorkflowsById,
    onDelete: removeWorkflow,
    onImport: (files) => void importFiles(files),
  };

  const errorCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const workflow of workflows ?? []) {
      map.set(workflow.id, validateWorkflow(workflow, registry).filter((issue) => issue.level === 'error').length);
    }
    return map;
  }, [workflows]);

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

  // --- runs --------------------------------------------------------------

  const visibleRuns = useMemo(
    () => (showAllLogs ? runs : runs.filter((run) => run.workflowId === activeId)),
    [runs, showAllLogs, activeId],
  );
  const activeRuns = useMemo(() => runs.filter((run) => run.workflowId === activeId), [runs, activeId]);
  const inspectedRun = activeRuns.find((run) => run.id === inspectedRunId) ?? activeRuns.at(-1);
  const runningRun = [...activeRuns].reverse().find((run) => run.status === 'running');

  const statusByNode = useMemo(() => {
    const map = new Map<string, StepStatus>();
    for (const step of inspectedRun?.steps ?? []) map.set(step.nodeId, step.status);
    return map;
  }, [inspectedRun]);

  const runNow = () => {
    if (!active) return;
    setInspectedRunId(undefined); // follow the new run
    void browser.runtime.sendMessage({ type: 'bf:run-workflow', workflow: active }).catch(() => {
      window.alert('Could not reach the background worker. Try reloading the extension.');
    });
  };

  const stopRun = () => {
    if (runningRun) void browser.runtime.sendMessage({ type: 'bf:stop-run', runId: runningRun.id });
  };

  // Label edges that leave from a named output ("true", "false", "error").
  const shownEdges = useMemo(
    () =>
      edges.map((edge) =>
        edge.sourceHandle && edge.sourceHandle !== 'out'
          ? { ...edge, label: edge.sourceHandle, className: `port-${edge.sourceHandle}` }
          : edge,
      ),
    [edges],
  );

  const selectedNode = nodes.find((node) => node.selected);

  if (!workflows || !active) return <div className="bf-loading">Loading…</div>;

  return (
    <IssuesContext.Provider value={issuesByNode}>
      <RunStatusContext.Provider value={statusByNode}>
      <PromptBanner prompts={prompts} />
      <div className="bf-app">
        <header className="bf-header">
          <strong className="bf-brand">BlockFlow</strong>
          <input
            className="bf-name"
            value={active.name}
            onChange={(event) => renameWorkflow(active.id, event.target.value)}
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
              onChange={(event) => void setEnabledFor(active.id, event.target.checked)}
            />
            <span>{active.enabled ? 'On' : 'Off'}</span>
          </label>
          {runningRun ? (
            <button type="button" className="bf-stop" onClick={stopRun} title="Stop the run that is going on">
              ■ Stop
            </button>
          ) : (
            <button
              type="button"
              className="bf-run"
              onClick={runNow}
              disabled={errors.length > 0 || active.nodes.length === 0}
              title={errors.length > 0 ? 'Fix the problems first' : 'Run the workflow once, now (it does not need to be On)'}
            >
              ▶ Run
            </button>
          )}
          {inspectedRun && !runningRun && (
            <span className={`bf-run-status ${inspectedRun.status}`} title={inspectedRun.error ?? ''}>
              {inspectedRun.status}
            </span>
          )}
          {errors.length > 0 && <span className="bf-error">{errors.length} problem{errors.length === 1 ? '' : 's'}</span>}
          <span className="bf-spacer" />
          <nav className="bf-tabs" aria-label="View">
            <button type="button" className={view === 'canvas' ? 'active' : ''} onClick={() => setView('canvas')}>
              Canvas
            </button>
            <button type="button" className={view === 'manage' ? 'active' : ''} onClick={() => setView('manage')}>
              All workflows ({workflows.length})
            </button>
            <button type="button" className={view === 'reports' ? 'active' : ''} onClick={() => setView('reports')}>
              Reports
            </button>
            <button type="button" className={view === 'data' ? 'active' : ''} onClick={() => setView('data')}>
              Data
            </button>
            <button type="button" className={view === 'secrets' ? 'active' : ''} onClick={() => setView('secrets')}>
              Secrets
            </button>
          </nav>
        </header>

        <Sidebar workflows={workflows} activeId={activeId} onAddBlock={addBlock} {...actions} />

        {view === 'reports' && (
          <ReportsPage
            runs={runs}
            onClear={() => void clearRuns()}
            onShowOnCanvas={(run) => {
              select(run.workflowId);
              setInspectedRunId(run.id);
            }}
          />
        )}

        {view === 'secrets' && <SecretsPage />}

        {view === 'data' && <DataPage />}

        {view === 'manage' && (
          <WorkflowsPage
            workflows={workflows}
            activeId={activeId}
            logs={logs}
            errorCounts={errorCounts}
            onSetAll={setAllEnabled}
            {...actions}
          />
        )}

        {view === 'canvas' && (
        <main className="bf-canvas" onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            key={activeId}
            nodes={nodes}
            edges={shownEdges}
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
        )}

        {view === 'canvas' && (
        <ConfigPanel
          node={selectedNode}
          problems={selectedNode ? (issuesByNode.get(selectedNode.id) ?? []) : []}
          onChange={updateConfig}
          onStepChange={updateStep}
          onDelete={deleteBlock}
          workflows={workflows.filter((workflow) => workflow.id !== activeId)}
          lastStep={selectedNode ? [...(inspectedRun?.steps ?? [])].reverse().find((step) => step.nodeId === selectedNode.id) : undefined}
        />
        )}

        <LogPanel
          entries={visibleLogs}
          labelFor={labelFor}
          showAll={showAllLogs}
          onToggleAll={setShowAllLogs}
          onClear={() => void clearLogs()}
          runs={visibleRuns}
          inspectedRunId={inspectedRun?.id}
          onInspect={(runId) => {
            const run = runs.find((candidate) => candidate.id === runId);
            if (run && run.workflowId !== activeId) select(run.workflowId);
            setInspectedRunId(runId);
          }}
          onClearRuns={() => void clearRuns()}
          workflowName={(id) => workflows.find((workflow) => workflow.id === id)?.name ?? 'Deleted workflow'}
        />
      </div>
      </RunStatusContext.Provider>
    </IssuesContext.Provider>
  );
}
