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
import { useLogs, usePrompts, useRuns, useStorageValue } from './hooks';
import { recordingToBlocks } from '../../core/recording';
import { STORAGE_KEYS } from '../../shared/keys';
import type { RecordingState } from '../../browser/recording';
import { PromptBanner } from './components/PromptBanner';
import { ReportsPage } from './components/ReportsPage';
import { SecretsPage } from './components/SecretsPage';
import { DataPage } from './components/DataPage';
import { registry } from './registry';

const nodeTypes = { block: BlockNode };
const defaultEdgeOptions = { type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } };
const SAVE_DELAY_MS = 400;
const HISTORY_MERGE_MS = 600;
const HISTORY_LIMIT = 100;

type Graph = Pick<Workflow, 'nodes' | 'edges'>;

/** Blocks copied with Ctrl+C: kept in memory, so they can be pasted into another workflow. */
let clipboard: Graph | null = null;

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
    history.current = { past: [], future: [], lastAt: 0, restoring: false };
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
  const latest = useRef<Workflow[] | null>(null);
  latest.current = workflows;

  // Undo/redo: snapshots of the graph before each change. Changes less than HISTORY_MERGE_MS apart
  // (one drag reports many moves) count as one step.
  const history = useRef<{ past: Graph[]; future: Graph[]; lastAt: number; restoring: boolean }>({ past: [], future: [], lastAt: 0, restoring: false });

  useEffect(() => {
    if (!activeId) return;
    const base = latest.current?.find((workflow) => workflow.id === activeId);
    if (!base) return;
    const next = fromFlow(base, nodes, edges);
    if (sameGraph(base, next)) return;
    const record = history.current;
    if (record.restoring) record.restoring = false;
    else {
      const now = Date.now();
      if (now - record.lastAt > HISTORY_MERGE_MS) {
        record.past = [...record.past.slice(-(HISTORY_LIMIT - 1)), { nodes: base.nodes, edges: base.edges }];
        record.future = [];
      }
      record.lastAt = now;
    }
    setWorkflows((previous) => previous?.map((workflow) => (workflow.id === activeId ? next : workflow)) ?? previous);
  }, [nodes, edges, activeId]);
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

  const createFromTemplate = useCallback(
    (text: string) => {
      const result = parseImport(text, latest.current ?? []);
      if (!result.ok) {
        notice(`Could not use the template: ${result.error}`);
        return;
      }
      setWorkflows((current) => [...(current ?? []), ...result.workflows]);
      open(result.workflows.at(-1) as Workflow);
      setView('canvas');
    },
    [notice, open],
  );

  const actions: WorkflowActions = {
    onOpen: select,
    onCreate: createNew,
    onCreateFromTemplate: createFromTemplate,
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

  // --- undo / redo / copy / paste --------------------------------------------

  const showGraph = useCallback(
    (graph: Graph) => {
      const workflow = latest.current?.find((candidate) => candidate.id === activeIdRef.current);
      if (!workflow) return;
      const shown = { ...workflow, nodes: graph.nodes, edges: graph.edges };
      const flow = toFlow(shown, (edge) => portOfEdge(shown, edge));
      history.current.restoring = true;
      setNodes(flow.nodes as BlockFlowNode[]);
      setEdges(flow.edges);
    },
    [],
  );

  const undo = useCallback(() => {
    const record = history.current;
    const previous = record.past.at(-1);
    const current = latest.current?.find((workflow) => workflow.id === activeIdRef.current);
    if (!previous || !current) return;
    record.past = record.past.slice(0, -1);
    record.future = [...record.future, { nodes: current.nodes, edges: current.edges }];
    showGraph(previous);
  }, [showGraph]);

  const redo = useCallback(() => {
    const record = history.current;
    const next = record.future.at(-1);
    const current = latest.current?.find((workflow) => workflow.id === activeIdRef.current);
    if (!next || !current) return;
    record.future = record.future.slice(0, -1);
    record.past = [...record.past, { nodes: current.nodes, edges: current.edges }];
    showGraph(next);
  }, [showGraph]);

  const copySelection = useCallback(() => {
    const picked = nodesRef.current.filter((node) => node.selected);
    if (picked.length === 0) return false;
    const ids = new Set(picked.map((node) => node.id));
    const current = latest.current?.find((workflow) => workflow.id === activeIdRef.current);
    if (!current) return false;
    clipboard = {
      nodes: current.nodes.filter((node) => ids.has(node.id)),
      edges: current.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    };
    return true;
  }, []);

  const paste = useCallback(() => {
    if (!clipboard) return;
    const idMap = new Map(clipboard.nodes.map((node) => [node.id, uid()]));
    const copy = {
      nodes: clipboard.nodes.map((node) => ({ ...node, id: idMap.get(node.id) as string, position: { x: node.position.x + 40, y: node.position.y + 40 } })),
      edges: clipboard.edges.map((edge) => ({ ...edge, id: uid(), source: idMap.get(edge.source) as string, target: idMap.get(edge.target) as string })),
    };
    // Paste again = another step down and right.
    clipboard = copy;
    const flow = toFlow({ ...createWorkflow(), ...copy }, (edge) => edge.sourcePort ?? 'out');
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...(flow.nodes as BlockFlowNode[]).map((node) => ({ ...node, selected: true }))]);
    setEdges((current) => [...current, ...flow.edges]);
  }, []);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (view !== 'canvas') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)) return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) undo();
      else if ((key === 'z' && event.shiftKey) || key === 'y') redo();
      else if (key === 'c') {
        if (!copySelection()) return;
      } else if (key === 'v') paste();
      else if (key === 'd') {
        if (copySelection()) paste();
      } else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, undo, redo, copySelection, paste]);

  // --- recording ---------------------------------------------------------------

  const [recording] = useStorageValue<RecordingState | null>(STORAGE_KEYS.recording, null);

  const startRecording = () => {
    if (!active) return;
    const firstUrl = active.nodes.find((node) => node.type === 'open-url')?.config.url;
    const suggested = typeof firstUrl === 'string' && !firstUrl.includes('{{') ? firstUrl : 'https://';
    const url = window.prompt('Record on which page? BlockFlow opens it in a new tab and records your clicks and typing.', suggested);
    if (!url || !/^https?:\/\/./.test(url.trim())) return;
    void browser.runtime.sendMessage({ type: 'bf:start-recording', workflowId: active.id, url: url.trim() });
  };

  // A stopped recording becomes blocks in its workflow, to the right of what is there.
  useEffect(() => {
    if (!recording || recording.status !== 'stopped') return;
    const target = latest.current?.find((workflow) => workflow.id === recording.workflowId);
    if (!target) {
      void browser.storage.local.remove(STORAGE_KEYS.recording);
      return;
    }
    if (activeIdRef.current !== target.id) {
      open(target);
      return; // runs again once that workflow is on the canvas
    }
    const right = Math.max(0, ...target.nodes.map((node) => node.position.x + 240));
    const top = target.nodes.length > 0 ? Math.max(...target.nodes.map((node) => node.position.y)) + 160 : 120;
    const blocks = recordingToBlocks({ startUrl: recording.startUrl, steps: recording.steps }, { x: target.nodes.length > 0 ? 60 : right + 60, y: top });
    const flow = toFlow({ ...target, nodes: blocks.nodes, edges: blocks.edges });
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...(flow.nodes as BlockFlowNode[])]);
    setEdges((current) => [...current, ...flow.edges]);
    void browser.storage.local.remove(STORAGE_KEYS.recording);
    if (blocks.secrets.length > 0) {
      window.alert(`Passwords were not recorded. Create a secret named “${blocks.secrets.join('”, “')}” on the Secrets page; the recorded blocks use it.`);
    }
  }, [recording, open]);

  const selectedNode = nodes.find((node) => node.selected);
  const [secrets] = useStorageValue<Record<string, string>>(STORAGE_KEYS.secrets, {});
  const lastStepOfSelected = selectedNode ? [...(inspectedRun?.steps ?? [])].reverse().find((step) => step.nodeId === selectedNode.id) : undefined;

  /** What {{ can offer in the selected block: outputs of blocks before it, keys seen in its last run, secrets. */
  const suggestions = useMemo(() => {
    if (!active || !selectedNode) return [];
    const names = new Set<string>();
    const seen = new Set<string>([selectedNode.id]);
    const queue = [selectedNode.id];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const edge of active.edges) {
        if (edge.target !== id || seen.has(edge.source)) continue;
        seen.add(edge.source);
        queue.push(edge.source);
        const node = active.nodes.find((candidate) => candidate.id === edge.source);
        for (const output of (node && registry.get(node.type)?.outputs) || []) if (!output.key.startsWith('(')) names.add(output.key);
      }
    }
    for (const [key, value] of Object.entries(lastStepOfSelected?.input ?? {})) {
      if (key.startsWith('$')) continue;
      names.add(key);
      if (value && typeof value === 'object' && !Array.isArray(value)) for (const inner of Object.keys(value).slice(0, 12)) names.add(`${key}.${inner}`);
    }
    for (const name of Object.keys(secrets)) names.add(`secret.${name}`);
    return [...names].sort();
  }, [active, selectedNode, lastStepOfSelected, secrets]);

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
          {recording?.status === 'recording' ? (
            <button type="button" className="bf-stop" onClick={() => void browser.runtime.sendMessage({ type: 'bf:stop-recording' })} title="Stop recording and add the blocks">
              ■ Stop recording ({recording.steps.length})
            </button>
          ) : (
            <button type="button" onClick={startRecording} title="Record your clicks and typing on a page as blocks">
              ● Record
            </button>
          )}
          <button type="button" onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo">
            ↶
          </button>
          <button type="button" onClick={redo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
            ↷
          </button>
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
          lastStep={lastStepOfSelected}
          suggestions={suggestions}
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
