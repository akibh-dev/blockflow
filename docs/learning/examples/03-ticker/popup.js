async function render() {
  const { count = 0, lastTickAt, starts = 0 } = await chrome.storage.local.get(['count', 'lastTickAt', 'starts']);
  document.getElementById('count').textContent = String(count);
  document.getElementById('last').textContent = lastTickAt
    ? `last tick ${Math.round((Date.now() - lastTickAt) / 1000)}s ago`
    : 'no tick yet (wait up to 30s)';
  document.getElementById('starts').textContent = `worker has started ${starts} time(s)`;
}

// Storage is the shared "database": when the worker writes, every open popup hears about it.
chrome.storage.onChanged.addListener(render);

document.getElementById('reset').addEventListener('click', async () => {
  await chrome.storage.local.set({ count: 0 });
  await chrome.action.setBadgeText({ text: '' });
});

render();
