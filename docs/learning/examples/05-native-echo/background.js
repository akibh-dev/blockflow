// One long-lived port. While it is open, Chrome keeps this service worker awake.
let port = null;

function connect() {
  port = chrome.runtime.connectNative('dev.example.echo');
  port.onMessage.addListener((message) => {
    chrome.storage.session.set({ lastAnswer: message });
  });
  port.onDisconnect.addListener(() => {
    // lastError says why: host not found, not allowed, or the program exited.
    chrome.storage.session.set({ lastAnswer: { error: chrome.runtime.lastError?.message ?? 'disconnected' } });
    port = null;
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'send') return;
  if (!port) connect();
  port.postMessage({ text: message.text, at: Date.now() });
});
