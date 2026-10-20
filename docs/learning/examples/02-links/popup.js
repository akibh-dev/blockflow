const status = document.getElementById('status');

async function send(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // Nobody is listening: a chrome:// page, the Web Store, or a tab opened before the extension loaded.
    return null;
  }
}

async function main() {
  const reply = await send({ type: 'count-links' });
  status.textContent = reply
    ? `${reply.count} links on "${reply.title}"`
    : 'Cannot reach this page. Try an ordinary website and reload it once.';
}

document.getElementById('on').addEventListener('click', async () => {
  const reply = await send({ type: 'highlight-links' });
  if (reply) status.textContent = `Highlighted ${reply.count} links`;
});
document.getElementById('off').addEventListener('click', () => send({ type: 'clear-highlight' }));

main();
