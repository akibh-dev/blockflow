import { browser } from 'wxt/browser';
import { initialiseDebuggerSessions } from '../browser/cdp';
import { initialiseRoutes } from '../browser/routes';
import { createExtensionHost } from '../browser/host';
import { secretNames, type StoredSecrets } from '../browser/secretVault';
import { createBrowserScheduler } from '../browser/scheduler';
import { cancelPicking, finishPicking, relayPickerSync, snapshotForEditor, startPicking } from '../browser/picking';
import { answerPrompt, clearStalePrompts, promptRunId } from '../browser/prompts';
import { answerDebug, clearStaleDebugPauses } from '../browser/debugChannel';
import { acceptBaseline, deleteBaselines } from '../browser/visual';
import { migrateWorkflow, migrateWorkflows } from '../core/migrate';
import { appendLog, clearWorkflowState, loadRuns, loadWorkflows, migrateStoredWorkflows, saveRun, saveWorkflows, updateRuns } from '../browser/stores';
import { createDefaultRegistry } from '../core/blocks';
import { menuClickPayload, menuItemFor, parseMenuItemId } from '../core/blocks/contextMenu';
import { WorkflowRunner } from '../core/engine';
import { markInterrupted } from '../core/runs';
import { withSessionTab } from '../core/session';
import { urlMatches } from '../core/urlPattern';
import { isOwnTab } from '../browser/ownTabs';
import { recordPopup } from '../browser/popups';
import { onRecordedPopup, onRecordedTabUpdated, recordStep, relayRecorderSync, startRecording, stopRecording } from '../browser/recording';
import type { RunRecord } from '../core/runs';
import { sampleWorkflows } from '../core/samples';
import { parseTimerKey, workflowTimerPrefix } from '../core/timerKey';
import { diffWorkflows } from '../core/workflow';
import { STORAGE_KEYS } from '../shared/keys';
import { isExtensionMessage } from '../shared/messages';
import type { SuiteProgressMessage, SuiteResultMessage } from '../shared/messages';
import type { Workflow } from '../core/types';
import { forgetLegacyWatchTabs } from '../browser/pageReader';
import {
  after,
  appendBridgeLog,
  bridgeSnapshot,
  connectNativeHost,
  createBridgeConnection,
  hasNativeMessaging,
  loadBridgeSettings,
  nativeDisconnectReason,
  writeBridgeStatus,
} from '../browser/bridge';
import { createBridgeHandlers, withRunOverlay } from '../browser/bridgeHandlers';
import type { RunWorkflowOptions } from '../browser/bridgeHandlers';
import { loadScreenshot } from '../browser/blobStore';
import { loadSuites, runSuite } from '../browser/suites';
import { BRIDGE_STORAGE_KEYS } from '../core/bridgeProtocol';

/**
 * Background worker: runs enabled workflows.
 *
 * It can be put to sleep at any time (Chrome) or run as an event page (Firefox/Safari), so
 * it keeps no important state in memory. Everything a workflow needs lives in storage and
 * browser alarms; a runner is rebuilt whenever an alarm fires.
 */
export default defineBackground(() => {
  initialiseDebuggerSessions();
  void initialiseRoutes().catch((error) => console.error('BlockFlow: could not clear stale route rules', error));
  // e2e builds only: a bridge content script on the local fixture server, for the Firefox e2e runner.
  if (import.meta.env.BF_E2E) {
    void browser.scripting
      .registerContentScripts([{ id: 'bf-e2e-bridge', matches: ['http://127.0.0.1/*'], js: ['content-scripts/e2e-bridge.js'], runAt: 'document_start' }])
      .catch(() => {}); // already registered
  }
  // Short timers (under 30s) fire from memory; longer ones from alarms. Both end up in onAlarm.
  const scheduler = createBrowserScheduler((key) => {
    void onAlarm(key).catch(report('timer'));
  });
  const host = createExtensionHost(scheduler);
  const registry = createDefaultRegistry();

  // Runs going on in this worker, and the ones the user asked to stop.
  const liveRuns = new Map<string, Pick<RunRecord, 'workflowId' | 'trigger'>>();
  const cancelRequests = new Set<string>();

  /** Every run update from any runner: track live runs, then persist (coalesced) to `bf:runs`. */
  const onRun = (run: RunRecord) => {
    if (run.status === 'running') {
      liveRuns.set(run.id, { workflowId: run.workflowId, trigger: run.trigger });
      // Stay awake for the whole run, even while it waits (Manual Step, slow pages, delays).
      scheduler.hold(`run:${run.id}`);
    } else {
      liveRuns.delete(run.id);
      cancelRequests.delete(run.id);
      scheduler.release(`run:${run.id}`);
    }
    saveRun(run);
  };

  /** A fresh runner per event: runners are cheap and hold no state worth keeping across events. */
  const newRunner = (workflow: Workflow) =>
    new WorkflowRunner({
      workflow,
      registry,
      host,
      log: (entry) => void appendLog(entry),
      onRun,
      isCancelled: (runId) => cancelRequests.has(runId),
    });

  /**
   * Runs a workflow once, like the Run button, and resolves with its finished record. `secrets` overlay
   * the stored ones for this run only (never stored; still masked), `workflows` are unsaved workflows
   * its Run Workflow blocks may call. Used by the bridge (`run`, `suite.run`) and suites.
   */
  function runWorkflow(workflow: Workflow, options: RunWorkflowOptions = {}): Promise<RunRecord> {
    return new WorkflowRunner({
      workflow: migrateWorkflow(workflow),
      registry,
      host: withRunOverlay(host, options),
      log: (entry) => void appendLog(entry),
      onRun: (run) => {
        onRun(run);
        options.onRun?.(run);
      },
      isCancelled: (runId) => cancelRequests.has(runId),
    }).runOnce();
  }

  /** The Stop button's path: also declines a Manual Step the run waits on and ends a debug pause. */
  function cancelRun(runId: string): void {
    cancelRequests.add(runId);
    answerPrompt(runId, false);
    answerDebug(runId, 'stop');
  }

  // M4 bridge: while "Allow outside control" is on, a native port to the BlockFlow host stays open.
  let outsideControl = false;
  const bridgeHandlers = createBridgeHandlers({
    isEnabled: () => outsideControl,
    info: () => ({ extensionVersion: browser.runtime.getManifest().version, browser: import.meta.env.BROWSER, extensionId: browser.runtime.id }),
    loadWorkflows,
    saveWorkflows,
    secretNames: async () => {
      const stored = await browser.storage.local.get(STORAGE_KEYS.secrets);
      return secretNames(stored[STORAGE_KEYS.secrets] as StoredSecrets | undefined);
    },
    loadRuns,
    runWorkflow,
    cancelRun,
    isRunLive: (runId) => liveRuns.has(runId),
    snapshot: bridgeSnapshot,
    loadScreenshot: async (id) => (await loadScreenshot(id))?.dataUrl,
    loadSuites,
    runSuite: (input, deps) => runSuite(input, { ...deps, loadScreenshot: async (id) => (await loadScreenshot(id))?.dataUrl, registry }),
    blockLabel: (type) => registry.get(type)?.label ?? type,
    appendLog: appendBridgeLog,
    after,
  });
  const bridge = createBridgeConnection({
    connect: connectNativeHost,
    disconnectReason: nativeDisconnectReason,
    respond: bridgeHandlers.respond,
    setStatus: writeBridgeStatus,
    after,
  });

  /** Connects or disconnects the bridge to match `bf:settings` and the nativeMessaging permission. */
  let bridgeSync: Promise<void> = Promise.resolve();
  function syncBridge(): void {
    bridgeSync = bridgeSync
      .then(async () => {
        const wanted = (await loadBridgeSettings()).outsideControl && (await hasNativeMessaging());
        outsideControl = wanted;
        if (wanted) bridge.enable();
        else bridge.disable();
      })
      .catch(report('bridge'));
  }

  // A run still marked "running" from a previous worker can never finish: say so.
  void updateRuns((runs) => markInterrupted(runs, new Set(liveRuns.keys()), new Date().toISOString()));
  void clearStalePrompts().catch(() => {});
  void clearStaleDebugPauses().catch(() => {});
  void forgetLegacyWatchTabs().catch(() => {});

  /**
   * (Re)starts an enabled workflow: `start()` clears its timers and calls its start blocks. Plain
   * start blocks (no trigger of their own) run only when the user has just switched it on.
   */
  async function startWorkflow(id: string, runPlainRoots: boolean): Promise<void> {
    const workflow = (await loadWorkflows()).find((candidate) => candidate.id === id);
    if (workflow?.enabled) await newRunner(workflow).start({ runPlainRoots });
  }

  /** Clears a workflow's timers and asks its non-manual live runs to stop. */
  async function stopWorkflow(id: string): Promise<void> {
    await host.scheduler.clearPrefix(workflowTimerPrefix(id));
    // Turning a workflow off also stops its background runs (not a run started with the Run button).
    for (const [runId, run] of liveRuns) {
      if (run.workflowId === id && run.trigger !== 'manual') cancelRequests.add(runId);
    }
  }

  /** On install/update and browser startup: re-arm every enabled workflow's triggers (plain start blocks do not run). */
  async function startAllEnabled(): Promise<void> {
    for (const workflow of await loadWorkflows()) {
      if (workflow.enabled) await newRunner(workflow).start({ runPlainRoots: false });
    }
  }

  /** A timer is due (alarm or short in-memory timer): hand it to a fresh runner, or clear it if orphaned. */
  async function onAlarm(name: string): Promise<void> {
    const parsed = parseTimerKey(name);
    if (!parsed) return; // not one of ours
    const workflow = (await loadWorkflows()).find((candidate) => candidate.id === parsed.workflowId);
    // A long delay started by the Run button continues even when the workflow is off; switching a
    // workflow off clears its timers, so anything left for a disabled workflow is such a delay.
    const isDelay = parsed.name.startsWith('delay:');
    if (!workflow || (!workflow.enabled && !isDelay)) {
      await host.scheduler.clear(name); // orphaned alarm
      return;
    }
    await newRunner(workflow).handleTimer(name);
  }

  /** Start blocks of enabled workflows that react to outside events (page visits, right-click menu). */
  async function eventRoots(type: string): Promise<{ workflow: Workflow; nodeId: string; config: Record<string, unknown> }[]> {
    const found: { workflow: Workflow; nodeId: string; config: Record<string, unknown> }[] = [];
    for (const workflow of await loadWorkflows()) {
      if (!workflow.enabled) continue;
      const fed = new Set(workflow.edges.map((edge) => edge.target));
      for (const node of workflow.nodes) {
        if (node.type === type && !fed.has(node.id)) found.push({ workflow, nodeId: node.id, config: node.config });
      }
    }
    return found;
  }

  /** Page Visited trigger: top-frame loads (and SPA route changes when `when: any`) of tabs BlockFlow did not open. */
  async function onPageVisited(tabId: number, url: string, kind: 'load' | 'route'): Promise<void> {
    if (!/^https?:/.test(url) || (await isOwnTab(tabId))) return;
    for (const { workflow, nodeId, config } of await eventRoots('page-visited')) {
      if (kind === 'route' && config.when !== 'any') continue;
      let matches = false;
      try {
        matches = urlMatches(url, String(config.url ?? ''));
      } catch {
        matches = false;
      }
      if (!matches) continue;
      const tab = await browser.tabs.get(tabId).catch(() => undefined);
      void newRunner(workflow)
        .handleEvent(nodeId, withSessionTab({ url, title: tab?.title ?? '', tabId }, 'main', tabId))
        .catch(report('page visited'));
    }
  }

  let menuSync: Promise<void> = Promise.resolve();

  /** One right-click menu item per Context Menu start block of an enabled workflow. */
  function syncContextMenus(): void {
    menuSync = menuSync
      .then(async () => {
        await browser.contextMenus.removeAll();
        for (const { workflow, nodeId, config } of await eventRoots('context-menu')) {
          browser.contextMenus.create(menuItemFor(workflow, nodeId, config));
        }
      })
      .catch(report('context menus'));
  }

  /** Context Menu trigger: item id `bf-menu::<workflowId>::<nodeId>`. */
  async function onMenuClicked(menuItemId: string, info: { pageUrl?: string; selectionText?: string; linkUrl?: string; srcUrl?: string }, tabId: number | undefined): Promise<void> {
    const item = parseMenuItemId(menuItemId);
    if (!item) return;
    const workflow = (await loadWorkflows()).find((candidate) => candidate.id === item.workflowId);
    if (!workflow) return;
    await newRunner(workflow).handleEvent(item.nodeId, menuClickPayload(info, tabId));
  }

  /** Toolbar button: focus the editor tab if open, else open it. */
  async function openEditor(): Promise<void> {
    const url = browser.runtime.getURL('/editor.html');
    const [existing] = await browser.tabs.query({ url });
    if (existing?.id !== undefined) {
      await browser.tabs.update(existing.id, { active: true });
      if (existing.windowId !== undefined) await browser.windows.update(existing.windowId, { focused: true });
    } else {
      await browser.tabs.create({ url });
    }
  }

  const report = (what: string) => (error: unknown) => {
    console.error(`[BlockFlow] ${what} failed`, error);
  };

  // Listeners are registered synchronously, as service workers require.

  browser.alarms.onAlarm.addListener((alarm) => {
    void (async () => {
      // A short timer's alarm is only a heartbeat that re-arms its in-memory timer.
      if (await scheduler.handleAlarm(alarm.name)) return;
      await onAlarm(alarm.name);
    })().catch(report('alarm'));
  });

  // Every time the worker starts (not just at browser startup): re-arm short timers and
  // recreate alarms the browser may have dropped.
  void scheduler.restoreAll().catch(report('restore timers'));

  browser.runtime.onStartup.addListener(() => {
    void startAllEnabled().catch(report('startup'));
    syncContextMenus();
  });

  browser.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId === 0) void onPageVisited(details.tabId, details.url, 'load').catch(report('page visited'));
  });
  browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId === 0) void onPageVisited(details.tabId, details.url, 'route').catch(report('page visited'));
  });

  // Tabs opened by pages (window.open, target=_blank), for Wait for Popup. Not tabs.onCreated:
  // Chrome leaves openerTabId empty for popup windows, and for a link in a background tab names the
  // active tab instead. onCreatedNavigationTarget always names the page that opened it.
  browser.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    void recordPopup(details.tabId, details.sourceTabId).catch(report('popup'));
    void onRecordedPopup(details.tabId, details.sourceTabId, details.url).catch(report('recording'));
  });

  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url || change.status === 'complete') void onRecordedTabUpdated(tabId, change).catch(report('recording'));
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    void onMenuClicked(String(info.menuItemId), info, tab?.id).catch(report('context menu'));
  });

  browser.runtime.onInstalled.addListener((details) => {
    void (async () => {
      if (details.reason === 'install' && (await loadWorkflows()).length === 0) {
        await saveWorkflows(sampleWorkflows());
      }
      // An update may bring a new workflow schema version: rewrite the stored list once (migrate.ts).
      await migrateStoredWorkflows();
      await startAllEnabled();
      syncContextMenus();
    })().catch(report('install'));
  });

  // The editor saves workflows to storage; reacting to that keeps the editor and the worker decoupled.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[BRIDGE_STORAGE_KEYS.settings]) syncBridge();
    const change = changes[STORAGE_KEYS.workflows];
    if (!change) return;
    // Both sides migrated, so the one-time rewrite to a new schema version restarts nothing.
    const migrated = (list: unknown) => (Array.isArray(list) ? migrateWorkflows(list as Workflow[]).workflows : undefined);
    const { start, restart, stop, removed } = diffWorkflows(migrated(change.oldValue), migrated(change.newValue));
    void (async () => {
      for (const id of stop) await stopWorkflow(id);
      // A deleted workflow leaves nothing behind: timers (also a Run-button delay of a workflow
      // that was off) and the block state its blocks kept.
      for (const id of removed) {
        await host.scheduler.clearPrefix(workflowTimerPrefix(id));
        await clearWorkflowState(id);
        // M5.3: its visual baselines go with it.
        await deleteBaselines(id).catch(report('delete baselines'));
      }
      for (const id of start) await startWorkflow(id, true);
      for (const id of restart) await startWorkflow(id, false);
    })().catch(report('workflow change'));
    if (start.length > 0 || restart.length > 0 || stop.length > 0) syncContextMenus();
  });

  // Manual Step answers from the notification (Chrome has buttons; Firefox: a click means Continue).
  browser.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    const runId = promptRunId(notificationId);
    if (runId) answerPrompt(runId, buttonIndex === 0);
  });
  browser.notifications.onClicked.addListener((notificationId) => {
    const runId = promptRunId(notificationId);
    if (runId) answerPrompt(runId, true);
  });

  // Granting or revoking nativeMessaging (Settings page, browser's extension page) changes what the bridge may do.
  browser.permissions.onAdded.addListener(() => syncBridge());
  browser.permissions.onRemoved.addListener(() => syncBridge());
  // Every worker start: reconnect when outside control is on (the open port keeps the worker alive).
  syncBridge();

  browser.action.onClicked.addListener(() => {
    void openEditor().catch(report('open editor'));
  });

  browser.runtime.onMessage.addListener((message, sender) => {
    // e2e builds only (BF_E2E=1; compiled out otherwise): an automated browser cannot open the
    // right-click menu, so tests/e2e "click" a Context Menu item with this message.
    if (import.meta.env.BF_E2E && (message as { type?: unknown })?.type === 'bf:e2e-menu-click') {
      const { menuItemId, info, tabId } = message as { menuItemId: string; info: Record<string, string>; tabId?: number };
      void onMenuClicked(menuItemId, info, tabId).catch(report('e2e menu click'));
      return;
    }
    // e2e builds only: Firefox content scripts cannot read storage.session, so the Firefox runner's bridge
    // content script asks here (the answer is the listener's promise, which Firefox supports).
    if (import.meta.env.BF_E2E && (message as { type?: unknown })?.type === 'bf:e2e-session-get') {
      return browser.storage.session.get((message as { key: string }).key);
    }
    if (!isExtensionMessage(message)) return;
    switch (message.type) {
      case 'bf:start-pick':
        void startPicking(sender.tab?.id, message.url, message.mode, message.urlFrom).catch(report('start picking'));
        break;
      case 'bf:picked':
        void finishPicking(message, { tabId: sender.tab?.id, frameId: sender.frameId, tabUrl: sender.tab?.url }).catch(report('finish picking'));
        break;
      case 'bf:pick-cancelled':
        void cancelPicking(sender.tab?.id).catch(report('cancel picking'));
        break;
      case 'bf:pick-error':
        // Only a picker in a page sends this here (the editor shows it too): end the pick.
        if (sender.tab?.id !== undefined) void cancelPicking(sender.tab.id).catch(report('cancel picking'));
        break;
      case 'bf:snapshot-page':
        void snapshotForEditor(sender.tab?.id, message.url).catch(report('snapshot'));
        break;
      case 'bf:picker-sync':
        void relayPickerSync(message, sender.tab?.id).catch(report('picker'));
        break;
      case 'bf:recorder-sync':
        void relayRecorderSync(message, sender.tab?.id).catch(report('recording'));
        break;
      case 'bf:run-workflow':
        void newRunner(migrateWorkflow(message.workflow)).runOnce(message.options).catch(report('run'));
        break;
      case 'bf:stop-run':
        cancelRun(message.runId);
        break;
      case 'bf:run-suite': {
        // Editor Suites page: run a saved suite; progress and the result go back as broadcasts.
        const { suiteId, workflowIds } = message;
        const send = (reply: SuiteProgressMessage | SuiteResultMessage) => void browser.runtime.sendMessage(reply).catch(() => {});
        void (async () => {
          try {
            const suite = (await loadSuites()).find((item) => item.id === suiteId);
            if (!suite) throw new Error('That suite no longer exists.');
            const { result } = await runSuite({ suite, ...(workflowIds ? { only: workflowIds } : {}) }, {
              loadWorkflows,
              runWorkflow: (workflow, options) => runWorkflow(workflow, options),
              onProgress: (progress) => send({ type: 'bf:suite-progress', suiteId, ...progress }),
              loadScreenshot: async (id) => (await loadScreenshot(id))?.dataUrl,
              registry,
            });
            send({ type: 'bf:suite-result', suiteId, result });
          } catch (error) {
            send({ type: 'bf:suite-result', suiteId, error: error instanceof Error ? error.message : String(error) });
          }
        })().catch(report('suite'));
        break;
      }
      case 'bf:answer-prompt':
        answerPrompt(message.runId, message.ok);
        break;
      case 'bf:debug-answer':
        // M5.2 DebugBanner: Continue / Step / Stop. Stop goes the Stop button's way (also cancels the run).
        if (message.action === 'stop') cancelRun(message.runId);
        else answerDebug(message.runId, message.action);
        break;
      case 'bf:accept-baseline': {
        // M5.3 Visual compare panel: this comparison's screenshot becomes the block's baseline.
        const { comparisonId } = message;
        void acceptBaseline(comparisonId)
          .then(() => ({ type: 'bf:baseline-accepted' as const, comparisonId }))
          .catch((error: unknown) => ({ type: 'bf:baseline-accepted' as const, comparisonId, error: error instanceof Error ? error.message : String(error) }))
          .then((reply) => browser.runtime.sendMessage(reply).catch(() => {}));
        break;
      }
      case 'bf:start-recording':
        void startRecording(message.workflowId, message.url).catch(report('start recording'));
        break;
      case 'bf:stop-recording':
        void stopRecording().catch(report('stop recording'));
        break;
      case 'bf:recorded':
        void recordStep(message.step, sender.tab?.id).catch(report('record'));
        break;
      default:
        break; // pick-result / pick-error are for the editor
    }
  });
});
