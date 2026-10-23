import { browser } from 'wxt/browser';
import { createExtensionHost } from '../browser/host';
import { createBrowserScheduler } from '../browser/scheduler';
import { cancelPicking, finishPicking, startPicking } from '../browser/picking';
import { appendLog, loadWorkflows, saveRun, saveWorkflows, updateRuns } from '../browser/stores';
import { createDefaultRegistry } from '../core/blocks';
import { WorkflowRunner } from '../core/engine';
import { markInterrupted } from '../core/runs';
import type { RunRecord } from '../core/runs';
import { sampleWorkflows } from '../core/samples';
import { parseTimerKey, workflowTimerPrefix } from '../core/timerKey';
import { diffWorkflows } from '../core/workflow';
import { STORAGE_KEYS } from '../shared/keys';
import { isExtensionMessage } from '../shared/messages';
import type { Workflow } from '../core/types';

/**
 * Background worker: runs enabled workflows.
 *
 * It can be put to sleep at any time (Chrome) or run as an event page (Firefox/Safari), so
 * it keeps no important state in memory. Everything a workflow needs lives in storage and
 * browser alarms; a runner is rebuilt whenever an alarm fires.
 */
export default defineBackground(() => {
  // Short timers (under 30s) fire from memory; longer ones from alarms. Both end up in onAlarm.
  const scheduler = createBrowserScheduler((key) => {
    void onAlarm(key).catch(report('timer'));
  });
  const host = createExtensionHost(scheduler);
  const registry = createDefaultRegistry();

  // Runs going on in this worker, and the ones the user asked to stop.
  const liveRuns = new Map<string, Pick<RunRecord, 'workflowId' | 'trigger'>>();
  const cancelRequests = new Set<string>();

  const onRun = (run: RunRecord) => {
    if (run.status === 'running') {
      liveRuns.set(run.id, { workflowId: run.workflowId, trigger: run.trigger });
    } else {
      liveRuns.delete(run.id);
      cancelRequests.delete(run.id);
    }
    saveRun(run);
  };

  const newRunner = (workflow: Workflow) =>
    new WorkflowRunner({
      workflow,
      registry,
      host,
      log: (entry) => void appendLog(entry),
      onRun,
      isCancelled: (runId) => cancelRequests.has(runId),
    });

  // A run still marked "running" from a previous worker can never finish: say so.
  void updateRuns((runs) => markInterrupted(runs, new Set(liveRuns.keys()), new Date().toISOString()));

  async function startWorkflow(id: string): Promise<void> {
    const workflow = (await loadWorkflows()).find((candidate) => candidate.id === id);
    if (workflow?.enabled) await newRunner(workflow).start();
  }

  async function stopWorkflow(id: string): Promise<void> {
    await host.scheduler.clearPrefix(workflowTimerPrefix(id));
    // Turning a workflow off also stops its background runs (not a run started with the Run button).
    for (const [runId, run] of liveRuns) {
      if (run.workflowId === id && run.trigger !== 'manual') cancelRequests.add(runId);
    }
  }

  async function startAllEnabled(): Promise<void> {
    for (const workflow of await loadWorkflows()) {
      if (workflow.enabled) await newRunner(workflow).start();
    }
  }

  async function onAlarm(name: string): Promise<void> {
    const parsed = parseTimerKey(name);
    if (!parsed) return; // not one of ours
    const workflow = (await loadWorkflows()).find((candidate) => candidate.id === parsed.workflowId);
    if (!workflow || !workflow.enabled) {
      await host.scheduler.clear(name); // orphaned alarm
      return;
    }
    await newRunner(workflow).handleTimer(name);
  }

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
  });

  browser.runtime.onInstalled.addListener((details) => {
    void (async () => {
      if (details.reason === 'install' && (await loadWorkflows()).length === 0) {
        await saveWorkflows(sampleWorkflows());
      }
      await startAllEnabled();
    })().catch(report('install'));
  });

  // The editor saves workflows to storage; reacting to that keeps the editor and the worker decoupled.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change = changes[STORAGE_KEYS.workflows];
    if (!change) return;
    const { start, stop } = diffWorkflows(
      change.oldValue as Workflow[] | undefined,
      change.newValue as Workflow[] | undefined,
    );
    void (async () => {
      for (const id of stop) await stopWorkflow(id);
      for (const id of start) await startWorkflow(id);
    })().catch(report('workflow change'));
  });

  browser.action.onClicked.addListener(() => {
    void openEditor().catch(report('open editor'));
  });

  browser.runtime.onMessage.addListener((message, sender) => {
    if (!isExtensionMessage(message)) return;
    switch (message.type) {
      case 'bf:start-pick':
        void startPicking(sender.tab?.id, message.url, message.mode).catch(report('start picking'));
        break;
      case 'bf:picked':
        void finishPicking(message, sender.tab?.id).catch(report('finish picking'));
        break;
      case 'bf:pick-cancelled':
        void cancelPicking().catch(report('cancel picking'));
        break;
      case 'bf:run-workflow':
        void newRunner(message.workflow).runOnce().catch(report('run'));
        break;
      case 'bf:stop-run':
        cancelRequests.add(message.runId);
        break;
      default:
        break; // pick-result / pick-error are for the editor
    }
  });
});
