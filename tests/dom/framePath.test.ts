// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerFramePathQuestions, frameElementFor, framePath, withFramePath } from '../../src/dom/framePath';
import { generateSelector } from '../../src/dom/selector';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('frame paths', () => {
  it('the top frame has an empty path; a locator gets frame= steps in front', async () => {
    expect(await framePath(window)).toEqual([]);
    expect(withFramePath([], '#a')).toBe('#a');
    expect(withFramePath(['#outer', 'iframe.pay'], 'label="Card"')).toBe('frame=#outer >> frame=iframe.pay >> label="Card"');
  });

  it('same-origin frames are read directly, nested ones too', async () => {
    document.body.innerHTML = '<iframe id="outer"></iframe>';
    const outer = document.getElementById('outer') as HTMLIFrameElement;
    const outerDoc = outer.contentDocument as Document;
    outerDoc.body.innerHTML = '<p>x</p><iframe class="pay"></iframe>';
    const inner = outerDoc.querySelector('iframe') as HTMLIFrameElement;
    expect(await framePath(inner.contentWindow as Window)).toEqual(['#outer', 'iframe.pay']);
  });

  it('finds the frame element for a window, also inside shadow roots', () => {
    document.body.innerHTML = '<iframe id="a"></iframe><x-shell></x-shell>';
    const root = (document.querySelector('x-shell') as HTMLElement).attachShadow({ mode: 'open' });
    root.innerHTML = '<iframe id="b"></iframe>';
    const b = root.getElementById('b') as HTMLIFrameElement;
    // jsdom gives frames in shadow trees no window; stand one in.
    const standIn = {};
    Object.defineProperty(b, 'contentWindow', { get: () => standIn });
    expect(frameElementFor(document, standIn)).toBe(b);
    expect(frameElementFor(document, window)).toBeNull();
    expect(generateSelector(b)).toBe('x-shell >>> #b');
  });

  it('answers a cross-origin child that asks which frame it is', async () => {
    document.body.innerHTML = '<iframe id="first"></iframe><iframe id="pay"></iframe>';
    const child = (document.getElementById('pay') as HTMLIFrameElement).contentWindow as Window;
    const posted = vi.spyOn(child, 'postMessage').mockImplementation(() => {});
    const remove = answerFramePathQuestions(window);
    // jsdom's postMessage leaves out `source`, so the question is dispatched by hand.
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'blockflow:frame-path?', id: 'q1' }, source: child }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted).toHaveBeenCalledWith({ type: 'blockflow:frame-path', id: 'q1', path: ['#pay'] }, '*');
    remove();
  });

  it('a child of a cross-origin parent asks it, and gives up after the timeout', async () => {
    document.body.innerHTML = '<iframe id="x"></iframe>';
    const child = (document.getElementById('x') as HTMLIFrameElement).contentWindow as Window;
    // Pretend the parent is cross-origin: frameElement reads as null.
    Object.defineProperty(child, 'frameElement', { get: () => null });
    // (In jsdom `child.parent` is the real jsdom window, not the test's globalThis.)
    const asked = vi.spyOn(child.parent, 'postMessage').mockImplementation((data: unknown) => {
      const question = data as { id: string };
      child.dispatchEvent(new MessageEvent('message', { data: { type: 'blockflow:frame-path', id: question.id, path: ['#x'] } }));
    });
    expect(await framePath(child)).toEqual(['#x']);
    asked.mockImplementation(() => {});
    expect(await framePath(child, 20)).toBeNull();
    asked.mockRestore();
  });
});
