const ALARM = 'tick';

// Alarms can be forgotten (browser restart, update), so make sure it exists every time the worker starts.
async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) {
    // 0.5 minutes = 30 seconds, the smallest period a published extension may use.
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  }
}

// Top-level, synchronous listener registration (see "three habits").
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  // Never keep the count in a variable: read it from storage, change it, write it back.
  const { count = 0 } = await chrome.storage.local.get('count');
  await chrome.storage.local.set({ count: count + 1, lastTickAt: Date.now() });
  await chrome.action.setBadgeText({ text: String(count + 1) });
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ count: 0 });
  await ensureAlarm();
});

// Runs every time the worker starts. Count how often that is, to SEE the lifecycle.
(async () => {
  const { starts = 0 } = await chrome.storage.local.get('starts');
  await chrome.storage.local.set({ starts: starts + 1 });
  await ensureAlarm();
})();
