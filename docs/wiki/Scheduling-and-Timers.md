# Scheduling and Timers

How a block's `ctx.timers.set(...)` turns into something that fires reliably in a background worker that
the browser stops whenever it likes. Read this before touching timer code, adding a block with
`onTimer`, or debugging "my 5 s timer paused for 30 s".

**Source:** [hybridScheduler.ts](../../src/browser/hybridScheduler.ts),
[scheduler.ts](../../src/browser/scheduler.ts), [timerKey.ts](../../src/core/timerKey.ts),
[background.ts](../../src/entrypoints/background.ts) (alarm wiring),
[hybridScheduler.test.ts](../../tests/browser/hybridScheduler.test.ts)

The reasoning is in [Architecture: Surviving the background worker sleeping](../ARCHITECTURE.md#surviving-the-background-worker-sleeping);
this page is the reference.

## The pieces

```text
 block: ctx.timers.set(name, {delayMs, periodMs?}, data?)
   └─ engine: scheduler.set(makeTimerKey(workflowId, nodeId, name), options, data)
        └─ HybridScheduler
             ├─ store   → storage.local  bf:timer:<key>  (StoredTimer)
             ├─ alarms  → browser.alarms <key>            (real schedule, or 30 s heartbeat)
             └─ clock   → setTimeout for short timers, setInterval for the keep-alive ping
 due:
   alarm  ── alarms.onAlarm ── scheduler.handleAlarm(name)? ──no──▶ onAlarm(name) ─▶ new runner.handleTimer(key)
   memory ── tick() ── fire(key) ───────────────────────────────────▶ onAlarm(key) ─▶ new runner.handleTimer(key)
                                                    handleTimer ─▶ scheduler.take(key) ─▶ block.onTimer(ctx, timer)
```

## Timer keys

From [timerKey.ts](../../src/core/timerKey.ts) (see also [Core Modules](Core-Modules.md)):

| Function | Result |
| --- | --- |
| `makeTimerKey(workflowId, nodeId, name)` | `bf::<workflowId>::<nodeId>::<name>` |
| `workflowTimerPrefix(workflowId)` | `bf::<workflowId>::` (used by `clearPrefix`) |
| `parseTimerKey(key)` | `{workflowId, nodeId, name}` or null (anything else is "not ours") |

The same string is the alarm name and, prefixed with `bf:timer:`, the storage key. Note the different
prefixes: `bf::` (key) vs `bf:timer:` (storage).

## The <30 s rule

Packed extensions cannot get alarms under 30 s (`ALARM_MIN_MS = 30_000`). A timer is **short** when
`delayMs < 30 000` **or** `periodMs < 30 000`; exactly 30 s counts as long.

| | Long timer (≥ 30 s) | Short timer (< 30 s) |
| --- | --- | --- |
| Who fires it | the alarm (`when = dueAt`, `periodInMinutes = period/60000` if periodic) | in-memory `setTimeout` (`tick`) |
| Alarm role | the real schedule | heartbeat: `when = now + 30 s`, every 0.5 min |
| Worker kept awake | no | yes: `runtime.getPlatformInfo()` every 20 s (`PING_EVERY_MS`) while ≥ 1 short timer is armed |
| After the worker dies | alarm wakes it on time | heartbeat wakes it within 30 s; `handleAlarm` re-arms the timer |
| Cost | none | battery while enabled; expect up to a 30 s gap after a crash |

Blocks never choose: they call `ctx.timers.set` and the scheduler decides. Do not use `setTimeout` in
blocks (CLAUDE.md); only `hybridScheduler.ts` uses timers, through its injected `Clock`.

## StoredTimer (`bf:timer:<key>`)

```ts
interface StoredTimer {
  data?: Payload;       // payload the block wants back in onTimer (must be JSON)
  periodic: boolean;    // periodMs was given
  delayMs: number;
  periodMs?: number;
  dueAt: number;        // epoch ms of the first fire; never updated afterwards
  short: boolean;
}
```

## HybridScheduler API

`new HybridScheduler({ alarms, store, clock, fire, ping, minAlarmMs?, pingEveryMs? })`. All browser access
comes through the ports, so the tests use a fake clock and fake alarms.

| Port | Real implementation (`createBrowserScheduler` in scheduler.ts) |
| --- | --- |
| `AlarmPort.create/clear/names` | `browser.alarms.create`, `.clear`, `.getAll().map(name)` |
| `TimerStore.get/set/remove/keys` | `storage.local` under `bf:timer:`; `keys()` reads **all** of `storage.local` and filters |
| `Clock` | `Date.now`, global `setTimeout`/`setInterval` |
| `fire(key)` | background: `onAlarm(key)` |
| `ping()` | `browser.runtime.getPlatformInfo()` |

### `Scheduler` interface (used by the engine)

| Method | Behaviour |
| --- | --- |
| `set(key, {delayMs, periodMs?}, data?)` | Disarm any old in-memory timer for the key, store the record, create the alarm (`alarmFor`), arm in memory if short. Setting a key again replaces it. |
| `clear(key)` | Disarm, clear alarm, remove record. |
| `clearPrefix(prefix)` | Same for every armed timer, alarm and record whose key starts with `prefix`. |
| `take(key)` | Called by `handleTimer` when a timer fires. No record → clear any stray alarm, return undefined (engine ignores the fire). One-shot → disarm, remove the record, clear the alarm if it was a short timer's heartbeat. Periodic → left in place. Returns `{periodic, data?}`. |

### Background-only methods

| Method | Behaviour |
| --- | --- |
| `handleAlarm(name): Promise<boolean>` | True if `name` is a short timer's heartbeat (re-arms it if this worker has not); false for a real alarm, which the caller then treats as a fire. |
| `restoreAll()` | On every worker start: recreate missing alarms (`alarmFor(record, restoring = true)`) and arm short timers not yet armed. |
| `isArmed(key)`, `armedCount()` | Introspection for tests. |

### Restart rules

| Timer | After a restart |
| --- | --- |
| Long, not yet due | alarm recreated at the original `dueAt` |
| Long periodic, overdue | next fire one full period from now (no burst of catch-up fires) |
| Long one-shot, overdue | fires 1 s from now |
| Short periodic | re-armed; first fire a full period after re-arming |
| Short one-shot | fires at `dueAt`, or immediately if overdue |

### Internals

- `tick(key)`: a periodic timer re-arms *before* calling `fire`, so a slow handler does not make it drift;
  a one-shot removes itself and may stop the ping. Errors from `fire` and `ping` are swallowed: a failing
  handler must never stop the scheduler.
- `syncPing()` starts the keep-alive interval (and pings once immediately) when the first short timer is
  armed, and stops it when the last one is disarmed.

## How blocks use it

Blocks only see `ctx.timers` and `onTimer` (see [Block Internals](Block-Internals.md)):

- **Timer** as a start block: `start` sets `tick` (periodic when Repeat is on); `onTimer` counts ticks in
  `ctx.state` and emits. Mid-flow: `run` sets a one-shot `delay:<uid>` carrying the input payload, returns
  `null`, and `onTimer` emits that payload later.
- **Schedule**: computes the next local time (`src/core/schedule.ts`) and sets a one-shot; each fire plans
  the next before emitting.
- **Watch Element**: periodic `poll` timer (`delayMs = periodMs`), last value in `ctx.state`.

`start()` and `stop()` of a workflow both call `clearPrefix(workflowTimerPrefix(id))`, so restarting a
workflow never doubles its timers. The background also clears timers whose workflow is deleted or
disabled when they fire ([Background Worker](Background-Worker.md)).

## Testing

`tests/browser/hybridScheduler.test.ts` drives `HybridScheduler` with a fake clock, fake alarms and a fake
store: long vs short, the 30 s boundary, heartbeat, keep-alive start/stop, one-shot cleanup, replacing a
key, failing handlers, `clearPrefix`, `take` on stale keys, and every restart rule above, plus end-to-end
scenarios with a real `WorkflowRunner` (Timer → Open URL, Watch Element). Core tests fire timers by
calling `runner.handleTimer` directly ([Testing](Testing.md)).

## Gotchas

- `dueAt` is never advanced for periodic timers; restart logic relies on "overdue periodic waits a full
  period" instead.
- A timer with a short delay but long period (`delayMs: 5000, periodMs: 60000`) is short forever, so it keeps
  the worker awake for its whole life.
- `TimerStore.keys()` loads all of `storage.local` (including logs and runs) on every `clearPrefix` and
  `restoreAll`. Fine at current sizes.
- Firefox/Safari event pages may be suspended differently; short timers there are untested (README
  "Known limitations").

## See also

- [Background Worker](Background-Worker.md): where alarms and `fire` land.
- [Core Engine](Core-Engine.md): `handleTimer`, `start`, `stop`.
- [Storage Keys](Storage-Keys.md): `bf:timer:*`, `bf:state:*`.
- [Block Internals](Block-Internals.md): `ctx.timers`, `onTimer`, `ctx.state`.
