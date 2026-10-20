const $ = (id) => document.getElementById(id);

async function render() {
  const { watch, status, history = [] } = await chrome.storage.local.get(['watch', 'status', 'history']);

  // Fill the form only once, so rewriting storage never overwrites what you are typing.
  if (watch && !$('url').dataset.filled) {
    $('url').value = watch.url;
    $('selector').value = watch.selector;
    $('minutes').value = watch.minutes;
    $('url').dataset.filled = '1';
  }

  const state = watch?.enabled ? 'Watching' : 'Stopped';
  if (status?.error) {
    $('status').textContent = `${state}. Last check failed: ${status.error}`;
    $('status').className = 'muted error';
  } else {
    const when = status?.at ? new Date(status.at).toLocaleTimeString() : 'never';
    $('status').textContent = `${state}. Last check ${when}${status?.value !== undefined ? `, value: "${status.value}"` : ''}`;
    $('status').className = 'muted';
  }

  const list = $('history');
  list.replaceChildren(
    ...history.map((item) => {
      const li = document.createElement('li');
      const time = new Date(item.at).toLocaleTimeString();
      li.textContent =
        item.kind === 'baseline' ? `${time}  started at "${item.to}"` : `${time}  "${item.from}" → "${item.to}"`;
      return li;
    }),
  );
}

$('start').addEventListener('click', async () => {
  await chrome.storage.local.set({
    watch: { url: $('url').value.trim(), selector: $('selector').value.trim(), minutes: Number($('minutes').value), enabled: true },
  });
});

$('stop').addEventListener('click', async () => {
  const { watch } = await chrome.storage.local.get('watch');
  if (watch) await chrome.storage.local.set({ watch: { ...watch, enabled: false } });
});

chrome.storage.onChanged.addListener(render);
chrome.action.setBadgeText({ text: '' }); // opening the popup counts as "seen"
render();
