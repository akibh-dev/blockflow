const answer = document.getElementById('answer');
document.getElementById('send').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'send', text: document.getElementById('text').value });
});
// The worker stores each answer; show it as it arrives.
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.lastAnswer) answer.textContent = JSON.stringify(changes.lastAnswer.newValue, null, 2);
});
