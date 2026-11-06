// e2e scenarios for M2 actions: click options, Element Action, Drag (synthetic and real input), drop zones,
// upload from data. Run alone with `npm run e2e -- m2-actions`. Fixtures: clicks.html, dnd.html, upload.html.

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, run, step, summary, workflow } = h;
  console.log('M2: click options, element actions, drag and drop, drop zones, upload from data');

  const lines = (record, id) => String(step(record, id)?.output?.value ?? '').split(';').map((line) => line.trim()).filter(Boolean);

  // --- click options, synthetic and real -------------------------------------
  for (const real of [false, true]) {
    const stepSettings = real ? { realInput: true } : {};
    const clicks = await run(workflow(`click options ${real ? 'real' : 'synthetic'}`, [
      { id: 'open', type: 'open-url', config: { url: `${base}/clicks.html`, active: false } },
      { id: 'mid', type: 'click', config: { locator: '#target', button: 'middle', modifiers: 'Shift', position: '5,6' }, step: stepSettings },
      { id: 'triple', type: 'click', config: { locator: '#target', clickCount: 3, modifiers: 'Control+Alt', position: '20,10' }, step: stepSettings },
      { id: 'right', type: 'click', config: { locator: '#target', action: 'right' }, step: stepSettings },
      { id: 'read', type: 'read-element', config: { locator: '#log', url: '' } },
      { id: 'close', type: 'close-tab' },
    ]));
    const log = lines(clicks, 'read');
    const trusted = String(real);
    const expected = [
      `auxclick 1 1 Shift 5,6 ${trusted}`,
      `click 0 1 Alt+Control 20,10 ${trusted}`,
      `click 0 2 Alt+Control 20,10 ${trusted}`,
      `dblclick 0 2 Alt+Control 20,10 ${trusted}`,
      `click 0 3 Alt+Control 20,10 ${trusted}`,
      // Chrome's own right click: contextmenu (detail 0) then auxclick. The synthetic one keeps BlockFlow's
      // historical sequence (contextmenu with detail 1, no auxclick).
      ...(real ? [`contextmenu 2 0 - 98,28 true`, `auxclick 2 1 - 98,28 true`] : [`contextmenu 2 1 - 98,28 false`]),
    ];
    check(`click options (${real ? 'real input' : 'synthetic'}): button, modifiers, position, click count`, JSON.stringify(log) === JSON.stringify(expected), `${JSON.stringify(log)} ${summary(clicks)}`);
  }

  // --- Element Action ----------------------------------------------------------
  const actions = await run(workflow('element actions', [
    { id: 'open', type: 'open-url', config: { url: `${base}/clicks.html`, active: false } },
    { id: 'focus', type: 'element-action', config: { locator: 'label=Name', action: 'focus' } },
    { id: 'r1', type: 'read-element', config: { locator: '#focus-state', url: '' } },
    { id: 'clear', type: 'element-action', config: { locator: 'label=Name', action: 'clear' } },
    { id: 'r2', type: 'read-element', config: { locator: 'label=Name', url: '', read: 'attribute', name: 'data-changed' } },
    { id: 'blur', type: 'element-action', config: { locator: 'label=Name', action: 'blur' } },
    { id: 'r3', type: 'read-element', config: { locator: '#focus-state', url: '' } },
    { id: 'event', type: 'element-action', config: { locator: '#custom-target', action: 'dispatch-event', eventType: 'my-event', detail: '{"n": 2, "who": "{{url}}"}' } },
    { id: 'r4', type: 'read-element', config: { locator: '#custom', url: '' } },
    { id: 'click', type: 'element-action', config: { locator: '#target', action: 'dispatch-event', eventType: 'click', detail: '{"shiftKey": true}' } },
    { id: 'r5', type: 'read-element', config: { locator: '#log', url: '' } },
    { id: 'scroll', type: 'element-action', config: { locator: '#far', action: 'scroll-into-view' } },
    { id: 'r6', type: 'wait-for', config: { mode: 'text', locator: '#scrolled', text: 'far' }, step: { timeoutSeconds: 5 } },
    { id: 'close', type: 'close-tab' },
  ]));
  const value = (id) => step(actions, id)?.output?.value;
  check('Element Action focus / clear / blur', value('r1') === 'focused' && value('r2') === '[]' && value('r3') === 'blurred', `${value('r1')} ${value('r2')} ${value('r3')} ${summary(actions)}`);
  check('Element Action dispatches a CustomEvent with detail', value('r4') === `custom-target {"n":2,"who":"${base}/clicks.html"}`, `${value('r4')} ${summary(actions)}`);
  check('Element Action dispatches a built-in event with its init', String(value('r5')).startsWith('click 0 0 Shift '), `${value('r5')}`);
  check('Element Action scrolls into view', step(actions, 'r6')?.status === 'passed', `${value('r6')} ${summary(actions)}`);

  // --- Drag, synthetic and real ----------------------------------------------------
  for (const real of [false, true]) {
    const stepSettings = real ? { realInput: true } : {};
    const drag = await run(workflow(`drag ${real ? 'real' : 'synthetic'}`, [
      { id: 'open', type: 'open-url', config: { url: `${base}/dnd.html`, active: false } },
      { id: 'sort', type: 'drag', config: { from: '#list >> text=Apple', to: '#list >> text=Cherry' }, step: stepSettings },
      { id: 'order', type: 'read-element', config: { locator: '#order', url: '' } },
      { id: 'slide', type: 'drag', config: { from: 'role=slider', to: '#track', toPosition: '150,10' }, step: stepSettings },
      { id: 'value', type: 'read-element', config: { locator: '#value', url: '' } },
      { id: 'trusted', type: 'read-element', config: { locator: '#slider-trusted', url: '' } },
      { id: 'log', type: 'read-element', config: { locator: '#dnd-log', url: '' } },
      { id: 'close', type: 'close-tab' },
    ]));
    const mode = (id) => step(drag, id)?.output?.dragMode;
    const label = real ? 'real input' : 'synthetic';
    check(
      `Drag (${label}): HTML5 sortable list reorders`,
      step(drag, 'order')?.output?.value === 'Banana,Cherry,Apple' && mode('sort') === 'html5',
      `${step(drag, 'order')?.output?.value} mode=${mode('sort')} log=${step(drag, 'log')?.output?.value} ${summary(drag)}`,
    );
    check(
      `Drag (${label}): pointer-events slider moves to 75`,
      step(drag, 'value')?.output?.value === '75' && mode('slide') === 'pointer' && step(drag, 'trusted')?.output?.value === String(real),
      `value=${step(drag, 'value')?.output?.value} mode=${mode('slide')} trusted=${step(drag, 'trusted')?.output?.value} ${summary(drag)}`,
    );
    if (real) check('Drag (real input): the HTML5 drag started from a trusted event', String(step(drag, 'log')?.output?.value).includes('start:true'), String(step(drag, 'log')?.output?.value));
  }

  // --- drop zone and upload from data ----------------------------------------------
  const upload = await run(workflow('drop zone and data', [
    { id: 'open', type: 'open-url', config: { url: `${base}/upload.html`, active: false } },
    { id: 'drop', type: 'upload-file', config: { locator: 'text=Drop files here', target: 'dropzone', content: 'a,b\n1,2', filename: 'rows.csv', mime: 'text/csv' } },
    { id: 'r1', type: 'read-element', config: { locator: '#dropped', url: '' } },
    { id: 'get', type: 'http-request', config: { url: `${base}/welcome.html`, responseType: 'base64' } },
    { id: 'data', type: 'upload-file', config: { locator: 'label=Upload CV', source: 'data', data: '{{body64}}', filename: 'welcome.html', mime: '{{mime}}' } },
    { id: 'r2', type: 'read-element', config: { locator: '#out', url: '' } },
    { id: 'url', type: 'upload-file', config: { locator: '#zone', target: 'dropzone', source: 'data', data: 'data:text/plain;base64,aGVsbG8=', filename: 'hi.txt' } },
    { id: 'r3', type: 'read-element', config: { locator: '#dropped', url: '' } },
    { id: 'close', type: 'close-tab' },
  ]));
  check('Upload File drops a file on a drop zone', step(upload, 'r1')?.output?.value === 'rows.csv|text/csv|a,b\n1,2' || step(upload, 'r1')?.output?.value === 'rows.csv|text/csv|a,b 1,2', `${JSON.stringify(step(upload, 'r1')?.output?.value)} ${summary(upload)}`);
  const fromData = String(step(upload, 'r2')?.output?.value ?? '');
  check('HTTP Request base64 → Upload File source "data"', fromData.startsWith('welcome.html|text/html|<!doctype html>') && Boolean(step(upload, 'get')?.output?.body64), `${fromData.slice(0, 80)} ${summary(upload)}`);
  check('Upload File from a data: URL onto a drop zone', step(upload, 'r3')?.output?.value === 'hi.txt|text/plain|hello', `${step(upload, 'r3')?.output?.value} ${summary(upload)}`);
}
