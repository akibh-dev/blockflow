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
import { migrateWorkflows } from '../../core/migrate';
import { edgePort, hasDynamicPorts, nodePorts } from '../../core/ports';
import type { StepStatus } from '../../core/runs';
import { validateWorkflow } from '../../core/validate';
import { duplicateWorkflow, exportWorkflows, parseImport, uniqueName } from '../../core/library';
import { createWorkflow, uid } from '../../core/workflow';
import type { EdgeDef, LogEntry, StepSettings, Workflow } from '../../core/types';
import type { Issue } from '../../core/issues';
import { BlockNode, IssuesContext, RunStatusContext } from './components/BlockNode';
import type { BlockFlowNode } from './components/BlockNode';
import { ConfigPanel } from './components/ConfigPanel';
import { confirmDialog, issuesDialog, promptDialog, toast } from './components/Dialogs';
import { LogPanel } from './components/LogPanel';
import { DRAG_MIME, Sidebar } from './components/Sidebar';
import type { WorkflowActions } from './components/WorkflowActions';
import { WorkflowsPage } from './components/WorkflowsPage';
import { downloadText, fileNameFor, readFiles } from './files';
import { followPortChanges, fromFlow, sameGraph, toFlow } from './flow/convert';
import { useLogs, usePrompts, useRuns, useSecretNames, useStorageValue } from './hooks';
import { recordingIntoWorkflow } from '../../core/recording';
import { workflowToPlaywright } from '../../core/playwright';
import { layoutWorkflow } from '../../core/layout';
import { decompile } from '../../core/script';
import { STORAGE_KEYS } from '../../shared/keys';
import type { RecordingState } from '../../browser/recording';
import { PromptBanner } from './components/PromptBanner';
import { ReportsPage } from './components/ReportsPage';
import { SecretsPage } from './components/SecretsPage';
import { SettingsPage } from './components/SettingsPage';
import { DebugBanner } from './components/DebugBanner';
import { HostAccessNote } from './components/HostAccessNote';
import { NO_NEED, describeNeed, missingAccess, needsAccess, requestAccess } from './hostAccess';
import type { HostNeed } from './hostAccess';
import { RunControls } from './components/RunControls';
import type { RunOptions } from '../../core/runs';
import { SuitesPage } from './components/SuitesPage';
import { TryItCard } from './components/TryItCard';
import { DataPage } from './components/DataPage';
import { registry } from './registry';
import { mergeStoredWorkflows, sameData, syncBase } from './sync';
import type { SyncBase } from './sync';

/** React Flow node renderers by node `type`; every BlockFlow node is `'block'`. Module-level so it is stable. */
const nodeTypes = { block: BlockNode };
const defaultEdgeOptions = { type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } };
/** Debounce between the last change and the write of `bf:workflows`. */
const SAVE_DELAY_MS = 400;
const HISTORY_MERGE_MS = 600;
const HISTORY_LIMIT = 100;

type Graph = Pick<Workflow, 'nodes' | 'edges'>;

/**
 * Undo/redo of one workflow: snapshots of its graph before each change. Changes less than
 * HISTORY_MERGE_MS apart (one drag reports many moves) count as one step; `restoring` keeps the change
 * an undo/redo itself makes out of the history.
 */
interface History {
  past: Graph[];
  future: Graph[];
  lastAt: number;
  restoring: boolean;
}

/** Blocks copied with Ctrl+C: kept in memory, so they can be pasted into another workflow. */
let clipboard: Graph | null = null;

/** Why a workflow cannot be switched on (its errors, or being empty), or null when it can. */
function whyNotOn(workflow: Workflow): string | null {
  const blocking = validateWorkflow(workflow, registry).filter((issue) => issue.level === 'error');
  if (blocking.length > 0) return `Cannot turn on “${workflow.name}”:\n- ${blocking.map((issue) => issue.message).join('\n- ')}`;
  if (workflow.nodes.length === 0) return `“${workflow.name}” is empty. Add a block first.`;
  return null;
}

/** The output an edge leaves from, resolving edges saved before blocks had several outputs. */
function portOfEdge(workflow: Workflow, edge: EdgeDef): string {
  const node = workflow.nodes.find((candidate) => candidate.id === edge.source);
  return edgePort(edge, nodePorts(node ? registry.get(node.type) : undefined, node ?? {}));
}

/**
 * The whole editor page: owns the workflow list and the canvas of the open workflow, and renders the
 * header, sidebar, the current view (canvas + config panel, or one of the manage/reports/data/secrets
 * pages) and the bottom log panel.
 *
 * Data flow: storage → `workflows` (loaded once) → `toFlow` → `nodes`/`edges` (React Flow state) →
 * `fromFlow` → `workflows` → debounced `saveWorkflows`. The background worker reacts to that write.
 * Runs, logs, prompts, secrets and the recorder state come in live through the hooks in `hooks.ts`.
 * Run/Stop/Record talk to the background with `runtime.sendMessage`.
 */
export function Editor() {
  const { screenToFlowPosition, fitView } = useReactFlow();
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

  // Undo/redo history per workflow id, kept while switching between workflows (in memory only).
  const histories = useRef(new Map<string, History>());
  const historyOf = useCallback((id: string): History => {
    let record = histories.current.get(id);
    if (!record) {
      record = { past: [], future: [], lastAt: 0, restoring: false };
      histories.current.set(id, record);
    }
    return record;
  }, []);

  /**
   * Put a workflow on the canvas and reset the inspected run. Its undo history stays, unless
   * `resetHistory` (the workflow was changed in another editor tab, so the snapshots are stale).
   */
  const open = useCallback((workflow: Workflow, resetHistory = false) => {
    const flow = toFlow(workflow, (edge) => portOfEdge(workflow, edge));
    setNodes(flow.nodes as BlockFlowNode[]);
    setEdges(flow.edges);
    setActiveId(workflow.id);
    setInspectedRunId(undefined);
    if (resetHistory) histories.current.delete(workflow.id);
  }, []);

  // What storage held at the last load/save, per workflow: tells this tab's own edits apart from
  // another editor tab's (see sync.ts).
  const synced = useRef<SyncBase>(new Map());

  useEffect(() => {
    let alive = true;
    void loadWorkflows().then((stored) => {
      if (!alive) return;
      synced.current = syncBase(stored);
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

  useEffect(() => {
    if (!activeId) return;
    const base = latest.current?.find((workflow) => workflow.id === activeId);
    if (!base) return;
    const next = fromFlow(base, nodes, edges);
    if (sameGraph(base, next)) return;
    const record = historyOf(activeId);
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
  }, [nodes, edges, activeId, historyOf]);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const persist = useCallback((list: Workflow[]) => {
    synced.current = syncBase(list);
    void saveWorkflows(list);
  }, []);

  useEffect(() => {
    if (!workflows) return;
    const timer = setTimeout(() => persist(workflows), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [workflows, persist]);

  // Another editor tab (or the first-install samples) changed the stored list: merge it in, keeping
  // this tab's unsaved edits, and reload the canvas if the open workflow changed there.
  useEffect(() => {
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      const change = changes[STORAGE_KEYS.workflows];
      if (area !== 'local' || !change) return;
      const theirs = migrateWorkflows((change.newValue as Workflow[] | undefined) ?? []).workflows;
      const ours = latest.current;
      if (!ours || sameData(theirs, ours)) {
        synced.current = syncBase(theirs);
        return;
      }
      const merged = mergeStoredWorkflows(ours, synced.current, theirs);
      synced.current = syncBase(theirs);
      setWorkflows(merged);
      const id = activeIdRef.current;
      const before = ours.find((workflow) => workflow.id === id);
      const after = merged.find((workflow) => workflow.id === id);
      // Reload the canvas only when the open workflow really changed elsewhere (this also resets its undo).
      if (!after) {
        if (merged[0]) open(merged[0]);
      } else if (after !== before && !sameData(after, before)) {
        open(after, true);
      }
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, [open]);

  // Do not lose the last edit if the tab is closed right away.
  useEffect(() => {
    const flush = () => {
      if (latest.current) persist(latest.current);
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [persist]);

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

  /** Add a block with its default config, selected; without a position it is cascaded near the top left. */
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
    // Outputs that depend on settings (Switch cases): connections follow a rename and go with a removal.
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    const def = node ? registry.get(node.data.blockType) : undefined;
    if (node && hasDynamicPorts(def)) {
      const before = nodePorts(def, { config: node.data.config });
      const after = nodePorts(def, { config: { ...node.data.config, ...patch } });
      setEdges((current) => followPortChanges(current, nodeId, before, after));
    }
    setNodes((current) =>
      current.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, config: { ...node.data.config, ...patch } } } : node,
      ),
    );
  }, []);

  /** Merge step settings into a node, dropping values back at their default so saved workflows stay small. */
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

  const [view, setView] = useState<'canvas' | 'manage' | 'reports' | 'suites' | 'data' | 'secrets' | 'settings'>('canvas');
  /** A message for the user, as a toast (errors stay longer). */
  const notice = useCallback((message: string, kind: 'info' | 'error' = 'info') => toast(message, kind), []);
  /** Secret names, so import can warn about `{{secret.x}}` that does not exist (values are not used).
   * Works while encrypted/locked too: `secretNames` reads names from either format. */
  const secrets = useSecretNames();

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
      const refused = enabled ? whyNotOn(target) : null;
      if (refused) {
        notice(refused, 'error');
        return false;
      }
      setWorkflows((current) => current?.map((workflow) => (workflow.id === id ? { ...workflow, enabled } : workflow)) ?? current);
      return true;
    },
    [notice],
  );

  /** "Turn all on/off": one message naming the workflows that could not be turned on. */
  const setAllEnabled = useCallback(
    (enabled: boolean) => {
      const skipped: string[] = [];
      const ids = new Set<string>();
      for (const workflow of latest.current ?? []) {
        if (workflow.enabled === enabled) continue;
        if (enabled && whyNotOn(workflow)) skipped.push(workflow.name);
        else ids.add(workflow.id);
      }
      if (ids.size > 0) setWorkflows((current) => current?.map((workflow) => (ids.has(workflow.id) ? { ...workflow, enabled } : workflow)) ?? current);
      if (skipped.length > 0) notice(`Left off until their problems are fixed: ${skipped.map((name) => `“${name}”`).join(', ')}`, 'error');
    },
    [notice],
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

  /** Removes a workflow from the list (the background then clears its timers and block state). */
  const deleteNow = useCallback(
    (id: string) => {
      if (!latest.current?.some((workflow) => workflow.id === id)) return;
      const remaining = (latest.current ?? []).filter((workflow) => workflow.id !== id);
      const next = remaining.length > 0 ? remaining : [createWorkflow('My first workflow')];
      setWorkflows(next);
      histories.current.delete(id);
      if (id === activeIdRef.current) open(next[0] as Workflow);
    },
    [open],
  );

  const removeWorkflow = useCallback(
    (id: string) => {
      const target = latest.current?.find((workflow) => workflow.id === id);
      if (!target) return;
      void confirmDialog({ title: 'Delete workflow', message: `Delete “${target.name}”? This cannot be undone.`, confirmLabel: 'Delete', danger: true }).then((ok) => {
        if (ok) deleteNow(id);
      });
    },
    [deleteNow],
  );

  const exportWorkflowsById = useCallback((ids: string[]) => {
    const chosen = (latest.current ?? []).filter((workflow) => ids.includes(workflow.id));
    if (chosen.length === 0) return;
    downloadText(fileNameFor(chosen.length === 1 ? (chosen[0] as Workflow).name : 'blockflow-workflows'), exportWorkflows(chosen));
  }, []);

  const importFiles = useCallback(
    async (files: FileList | null) => {
      const names = Array.from(files ?? [], (file) => file.name);
      const texts = await readFiles(files);
      let added: Workflow[] = [];
      const notes: Issue[] = [];
      for (const [index, text] of texts.entries()) {
        const result = parseImport(text, [...(latest.current ?? []), ...added], { secrets: Object.keys(secrets) });
        // Errors refuse the file: list every problem with its JSON path (check.ts), not just the first.
        if (!result.ok) {
          void issuesDialog({
            title: `Cannot import ${names[index] ?? 'this file'}`,
            message: 'Nothing was imported. Fix these problems in the file and import it again (paths point into the file).',
            issues: result.issues,
          });
          continue;
        }
        added = [...added, ...result.workflows];
        notes.push(...result.issues);
      }
      if (added.length === 0) return;
      setWorkflows((current) => [...(current ?? []), ...added]);
      open(added[0] as Workflow);
      setView('manage');
      const imported = `Imported ${added.length} workflow${added.length === 1 ? '' : 's'}. They are off until you turn them on.`;
      const warnings = notes.filter((issue) => issue.level === 'warning').length;
      if (notes.length === 0) notice(imported);
      else {
        const what = warnings > 0 ? `${warnings} warning${warnings === 1 ? '' : 's'}` : `${notes.length} note${notes.length === 1 ? '' : 's'}`;
        toast(`${imported}\n${what} to look at.`, 'info', {
          label: 'Details',
          run: () => void issuesDialog({ title: 'Imported, with warnings', message: 'The workflows were imported. These may stop them from working as intended:', issues: notes }),
        });
      }
    },
    [notice, open, secrets],
  );

  const exportPlaywright = useCallback((id: string) => {
    const all = latest.current ?? [];
    const workflow = all.find((candidate) => candidate.id === id);
    if (!workflow) return;
    const spec = workflowToPlaywright(workflow, { registry, lookup: (other) => all.find((candidate) => candidate.id === other) });
    downloadText(fileNameFor(workflow.name).replace('.blockflow.json', '.spec.ts'), spec, 'text/plain');
  }, []);

  /** The open workflow as a script (script.ts), or null when its graph is not a tree of steps. */
  const activeScript = useMemo(() => (active ? decompile(active, registry) : null), [active]);

  const exportScript = useCallback(() => {
    if (!active || !activeScript) return;
    downloadText(fileNameFor(active.name).replace('.blockflow.json', '.script.json'), `${JSON.stringify(activeScript, null, 2)}\n`);
  }, [active, activeScript]);

  /** "Tidy up": lay the canvas out in columns (layout.ts). A canvas change like any other, so Undo reverts it. */
  const tidyUp = useCallback(() => {
    const base = latest.current?.find((workflow) => workflow.id === activeIdRef.current);
    if (!base) return;
    const laid = layoutWorkflow(fromFlow(base, nodesRef.current, edgesRef.current), registry);
    const positions = new Map(laid.nodes.map((node) => [node.id, node.position]));
    setNodes((current) => current.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })));
    requestAnimationFrame(() => void fitView({ padding: 0.4, maxZoom: 1 }));
  }, [fitView]);

  const createFromTemplate = useCallback(
    (text: string) => {
      const result = parseImport(text, latest.current ?? []);
      if (!result.ok) {
        void issuesDialog({ title: 'Could not use the template', message: result.error, issues: result.issues });
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
    onToggle: (id, enabled) => toggleOn(id, enabled),
    onDuplicate: duplicate,
    onExport: exportWorkflowsById,
    onExportPlaywright: exportPlaywright,
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

  // Sites the open workflow uses that the browser has not granted (the store build asks per workflow).
  const [hostNeed, setHostNeed] = useState<HostNeed>(NO_NEED);
  const [hostTick, setHostTick] = useState(0);
  const refreshHostNeed = useCallback(() => setHostTick((tick) => tick + 1), []);
  useEffect(() => {
    let alive = true;
    if (!active) {
      setHostNeed(NO_NEED);
      return;
    }
    void missingAccess(active).then((need) => {
      if (alive) setHostNeed((current) => (JSON.stringify(current) === JSON.stringify(need) ? current : need));
    });
    return () => {
      alive = false;
    };
  }, [active, hostTick]);
  useEffect(() => {
    const refresh = () => setHostTick((tick) => tick + 1);
    browser.permissions.onAdded?.addListener(refresh);
    browser.permissions.onRemoved?.addListener(refresh);
    return () => {
      browser.permissions.onAdded?.removeListener(refresh);
      browser.permissions.onRemoved?.removeListener(refresh);
    };
  }, []);

  const statusByNode = useMemo(() => {
    const map = new Map<string, StepStatus>();
    for (const step of inspectedRun?.steps ?? []) map.set(step.nodeId, step.status);
    return map;
  }, [inspectedRun]);

  /** Run, Run with trace, Debug (M5) or Run from here (`startAt`). */
  const runNow = (options: RunOptions = {}) => {
    if (!active) return;
    const start = () => {
      setInspectedRunId(undefined); // follow the new run
      void browser.runtime.sendMessage({ type: 'bf:run-workflow', workflow: active, ...(Object.keys(options).length > 0 ? { options } : {}) }).catch(() => {
        toast('Could not reach the background worker. Try reloading the extension.', 'error');
      });
    };
    if (!needsAccess(hostNeed)) return start();
    // First call in the click handler: browsers only show the permission prompt for a user gesture.
    void requestAccess(hostNeed).then((granted) => {
      refreshHostNeed();
      if (granted) start();
      else toast(`BlockFlow needs access to ${describeNeed(hostNeed)} to run this workflow.`, 'error');
    });
  };

  /** The On switch: asks for the sites first (same click), then turns the workflow on. */
  const toggleOn = (id: string, enabled: boolean) => {
    if (!enabled || id !== active?.id || !needsAccess(hostNeed)) {
      setEnabledFor(id, enabled);
      return;
    }
    void requestAccess(hostNeed).then((granted) => {
      refreshHostNeed();
      if (granted) setEnabledFor(id, true);
      else toast(`BlockFlow needs access to ${describeNeed(hostNeed)} to run this workflow in the background.`, 'error');
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

  /** Put an undo/redo snapshot on the canvas; `restoring` keeps that change out of the history. */
  const showGraph = useCallback(
    (graph: Graph) => {
      const workflow = latest.current?.find((candidate) => candidate.id === activeIdRef.current);
      if (!workflow) return;
      const shown = { ...workflow, nodes: graph.nodes, edges: graph.edges };
      const flow = toFlow(shown, (edge) => portOfEdge(shown, edge));
      historyOf(workflow.id).restoring = true;
      setNodes(flow.nodes as BlockFlowNode[]);
      setEdges(flow.edges);
    },
    [historyOf],
  );

  const undo = useCallback(() => {
    const current = latest.current?.find((workflow) => workflow.id === activeIdRef.current);
    if (!current) return;
    const record = historyOf(current.id);
    const previous = record.past.at(-1);
    if (!previous) return;
    record.past = record.past.slice(0, -1);
    record.future = [...record.future, { nodes: current.nodes, edges: current.edges }];
    showGraph(previous);
  }, [showGraph, historyOf]);

  const redo = useCallback(() => {
    const current = latest.current?.find((workflow) => workflow.id === activeIdRef.current);
    if (!current) return;
    const record = historyOf(current.id);
    const next = record.future.at(-1);
    if (!next) return;
    record.future = record.future.slice(0, -1);
    record.past = [...record.past, { nodes: current.nodes, edges: current.edges }];
    showGraph(next);
  }, [showGraph, historyOf]);

  /** Copy the selected blocks and the connections between them to the module `clipboard`. False if none selected. */
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

  // Where the mouse is over the canvas (screen coordinates), for pasting there; null when outside.
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const lastPasteAt = useRef<{ x: number; y: number } | null>(null);

  /**
   * Paste the clipboard with fresh ids, selected. `atMouse`: the copy's top-left block goes where the
   * mouse is on the canvas; otherwise (mouse outside, not moved since the last paste, or Ctrl+D) it is
   * offset 40px from the copied blocks. The clipboard then holds the pasted copy.
   */
  const paste = useCallback((atMouse = true) => {
    if (!clipboard || clipboard.nodes.length === 0) return;
    let dx = 40;
    let dy = 40;
    const point = mouse.current;
    const moved = point && (point.x !== lastPasteAt.current?.x || point.y !== lastPasteAt.current?.y);
    if (atMouse && point && moved) {
      const target = screenToFlowPosition(point);
      dx = target.x - Math.min(...clipboard.nodes.map((node) => node.position.x));
      dy = target.y - Math.min(...clipboard.nodes.map((node) => node.position.y));
      lastPasteAt.current = point;
    }
    const idMap = new Map(clipboard.nodes.map((node) => [node.id, uid()]));
    const copy = {
      nodes: clipboard.nodes.map((node) => ({ ...node, id: idMap.get(node.id) as string, position: { x: node.position.x + dx, y: node.position.y + dy } })),
      edges: clipboard.edges.map((edge) => ({ ...edge, id: uid(), source: idMap.get(edge.source) as string, target: idMap.get(edge.target) as string })),
    };
    // Paste again without moving the mouse = another step down and right.
    clipboard = copy;
    const flow = toFlow({ ...createWorkflow(), ...copy }, (edge) => edge.sourcePort ?? 'out');
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...(flow.nodes as BlockFlowNode[]).map((node) => ({ ...node, selected: true }))]);
    setEdges((current) => [...current, ...flow.edges]);
  }, [screenToFlowPosition]);


  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (view !== 'canvas') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], .bf-modal') || target.isContentEditable)) return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) undo();
      else if ((key === 'z' && event.shiftKey) || key === 'y') redo();
      else if (key === 'c') {
        if (!copySelection()) return;
      } else if (key === 'v') paste();
      else if (key === 'd') {
        if (copySelection()) paste(false);
      } else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, undo, redo, copySelection, paste]);

  // --- recording ---------------------------------------------------------------

  const [recording] = useStorageValue<RecordingState | null>(STORAGE_KEYS.recording, null);

  /** Ask for a start URL (suggesting the first Open URL block's), then ask the background to record there. */
  const startRecording = () => {
    if (!active) return;
    const firstUrl = active.nodes.find((node) => node.type === 'open-url')?.config.url;
    const suggested = typeof firstUrl === 'string' && !firstUrl.includes('{{') ? firstUrl : 'https://';
    const workflowId = active.id;
    void promptDialog({
      title: 'Record',
      message: 'Record on which page? BlockFlow opens it in a new tab and records your clicks and typing.',
      defaultValue: suggested,
      confirmLabel: 'Start recording',
      validate: (value) => (/^https?:\/\/./.test(value) ? null : 'Enter a full http(s) address, like https://example.com'),
    }).then((url) => {
      if (url) void browser.runtime.sendMessage({ type: 'bf:start-recording', workflowId, url });
    });
  };

  // Read by the effect below without re-running it on every canvas change.
  const selectedIdRef = useRef<string | undefined>(undefined);
  selectedIdRef.current = nodes.find((node) => node.selected)?.id;

  // A stopped recording becomes blocks in its workflow. In an empty workflow: the recorded chain
  // (Open Tab first). Otherwise it continues after the selected block (or the last block of the main
  // path), to its right, connected to it, without a second Open Tab when the site is already opened
  // (see recordingIntoWorkflow).
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
    const blocks = recordingIntoWorkflow(target, { startUrl: recording.startUrl, steps: recording.steps }, selectedIdRef.current);
    const flow = toFlow({ ...target, nodes: blocks.nodes, edges: blocks.edges });
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...(flow.nodes as BlockFlowNode[])]);
    setEdges((current) => [...current, ...flow.edges]);
    void browser.storage.local.remove(STORAGE_KEYS.recording);
    if (blocks.secrets.length > 0) {
      toast(`Passwords were not recorded. Create a secret named “${blocks.secrets.join('”, “')}” on the Secrets page; the recorded blocks use it.`);
    }
  }, [recording, open]);

  const selectedNode = nodes.find((node) => node.selected);
  const lastStepOfSelected = selectedNode ? [...(inspectedRun?.steps ?? [])].reverse().find((step) => step.nodeId === selectedNode.id) : undefined;

  /** For the picker: the URL of the nearest Open Tab before the selected block (none when it is templated). */
  const upstreamUrl = useMemo(() => {
    const selectedId = nodes.find((node) => node.selected)?.id;
    if (!selectedId) return undefined;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const seen = new Set<string>([selectedId]);
    let frontier = [selectedId];
    while (frontier.length > 0) {
      const sources = edges.filter((edge) => frontier.includes(edge.target)).map((edge) => edge.source).filter((id) => !seen.has(id));
      for (const id of sources) {
        seen.add(id);
        const node = byId.get(id);
        const url = node?.data.blockType === 'open-url' ? node.data.config.url : undefined;
        if (typeof url === 'string' && url.trim() && !url.includes('{{')) return url.trim();
      }
      frontier = sources;
    }
    return undefined;
  }, [nodes, edges]);

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
      <DebugBanner />
      <HostAccessNote need={hostNeed} onGranted={refreshHostNeed} />
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
              onChange={(event) => toggleOn(active.id, event.target.checked)}
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
          <button type="button" onClick={tidyUp} disabled={view !== 'canvas' || active.nodes.length === 0} title="Lay the blocks out in columns, left to right (Undo puts them back)">
            Tidy up
          </button>
          <button
            type="button"
            onClick={exportScript}
            disabled={!activeScript}
            title={activeScript ? 'Download this workflow as a script (a list of steps)' : 'This workflow cannot be written as a list of steps (several start blocks, or an output feeding several blocks)'}
          >
            Export as script
          </button>
          {runningRun && (
            <button type="button" className="bf-stop" onClick={stopRun} title="Stop the run that is going on">
              ■ Stop
            </button>
          )}
          <RunControls
            onRun={runNow}
            running={Boolean(runningRun)}
            disabled={errors.length > 0 || active.nodes.length === 0}
            disabledReason={errors.length > 0 ? 'Fix the problems first' : 'Add a block first'}
          />
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
            <button type="button" className={view === 'suites' ? 'active' : ''} onClick={() => setView('suites')}>
              Suites
            </button>
            <button type="button" className={view === 'data' ? 'active' : ''} onClick={() => setView('data')}>
              Data
            </button>
            <button type="button" className={view === 'secrets' ? 'active' : ''} onClick={() => setView('secrets')}>
              Secrets
            </button>
            <button type="button" className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
              Settings
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

        {view === 'suites' && <SuitesPage />}

        {view === 'settings' && <SettingsPage />}

        {view === 'data' && <DataPage />}

        {view === 'manage' && (
          <WorkflowsPage
            workflows={workflows}
            activeId={activeId}
            runs={runs}
            errorCounts={errorCounts}
            onSetAll={setAllEnabled}
            {...actions}
          />
        )}

        {view === 'canvas' && (
        <main
          className="bf-canvas"
          onDrop={onDrop}
          onDragOver={onDragOver}
          onMouseMove={(event) => {
            mouse.current = { x: event.clientX, y: event.clientY };
          }}
          onMouseLeave={() => {
            mouse.current = null;
          }}
        >
          <ReactFlow
            key={activeId}
            nodes={nodes}
            edges={shownEdges}
            nodeTypes={nodeTypes}
            // Only the blocks in view are drawn: a 500-block workflow opens in about 2.5 s instead of 4-5 s (m6-perf).
            onlyRenderVisibleElements
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
          <TryItCard onCreate={createFromTemplate} />
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
          upstreamUrl={upstreamUrl}
          workflowId={active?.id}
          runs={activeRuns}
          running={Boolean(runningRun)}
          onRunFrom={(startAt) => runNow({ startAt })}
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
