// This runs in the popup, a normal page that happens to have the chrome.* APIs.
async function main() {
  // "the tab I was opened from": active tab of the current window.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  document.getElementById('title').textContent = tab?.title ?? '(no title)';
  document.getElementById('url').textContent = tab?.url ?? '(no address; maybe a browser page)';

  document.getElementById('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(tab?.url ?? '');
    document.getElementById('copy').textContent = 'Copied!';
  });
}

main();
