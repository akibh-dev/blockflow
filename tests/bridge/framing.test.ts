import { describe, expect, it } from 'vitest';
import { FrameTooLargeError, createLineSplitter, createNativeDecoder, encodeLine, encodeNative } from '../../packages/bridge/framing.mjs';
import { MAX_MESSAGE_BYTES } from '../../packages/bridge/protocol.mjs';

const collect = (maxBytes?: number) => {
  const messages: unknown[] = [];
  const errors: Error[] = [];
  const decoder = createNativeDecoder({ onMessage: (m: unknown) => messages.push(m), onError: (e: Error) => errors.push(e), maxBytes });
  return { decoder, messages, errors };
};

describe('native messaging framing', () => {
  it('encodes a 4-byte little-endian length and UTF-8 JSON', () => {
    const frame = encodeNative({ a: 'é' });
    const body = Buffer.from(JSON.stringify({ a: 'é' }), 'utf8');
    expect(frame.readUInt32LE(0)).toBe(body.length);
    expect(frame.subarray(4).equals(body)).toBe(true);
  });

  it('round-trips, byte by byte and several frames per chunk', () => {
    const items = [{ id: 1, text: 'naïve ✓' }, { id: 2 }, [1, 2, 3], 'x'.repeat(70_000)];
    const all = Buffer.concat(items.map((item) => encodeNative(item)));
    const slow = collect();
    for (const byte of all) slow.decoder.push(Buffer.from([byte]));
    expect(slow.messages).toEqual(items);
    const fast = collect();
    fast.decoder.push(all);
    expect(fast.messages).toEqual(items);
    // Split in the middle of a length prefix and of a multi-byte character.
    const odd = collect();
    odd.decoder.push(all.subarray(0, 2));
    odd.decoder.push(all.subarray(2, 19));
    odd.decoder.push(all.subarray(19));
    expect(odd.messages).toEqual(items);
    expect(odd.decoder.pending).toBe(0);
  });

  it('refuses to encode an oversize message', () => {
    expect(() => encodeNative('x'.repeat(MAX_MESSAGE_BYTES))).toThrow(FrameTooLargeError);
  });

  it('skips an oversize incoming frame and stays in step', () => {
    const { decoder, messages, errors } = collect(100);
    const big = Buffer.alloc(4 + 500, 0x20);
    big.writeUInt32LE(500, 0);
    const stream = Buffer.concat([encodeNative({ before: true }), big, encodeNative({ after: true })]);
    decoder.push(stream.subarray(0, 30));
    decoder.push(stream.subarray(30, 300));
    decoder.push(stream.subarray(300));
    expect(messages).toEqual([{ before: true }, { after: true }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(FrameTooLargeError);
  });

  it('reports a frame that is not JSON and carries on', () => {
    const { decoder, messages, errors } = collect();
    const bad = Buffer.from('nope');
    const frame = Buffer.alloc(4);
    frame.writeUInt32LE(bad.length, 0);
    decoder.push(Buffer.concat([frame, bad, encodeNative(1)]));
    expect(messages).toEqual([1]);
    expect(errors[0]?.message).toMatch(/not JSON/);
  });
});

describe('NDJSON lines', () => {
  it('splits lines across chunks, keeps UTF-8 intact, accepts CRLF, skips blanks', () => {
    const lines: string[] = [];
    const splitter = createLineSplitter({ onLine: (line: string) => lines.push(line) });
    const text = Buffer.from(`${encodeLine({ a: 'ü' })}\n\r\n{"b":2}\r\n{"c":`, 'utf8');
    for (const byte of text) splitter.push(Buffer.from([byte]));
    splitter.push('3}\n');
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ a: 'ü' }, { b: 2 }, { c: 3 }]);
  });

  it('drops a line over the limit up to its newline', () => {
    const lines: string[] = [];
    const errors: Error[] = [];
    const splitter = createLineSplitter({ onLine: (line: string) => lines.push(line), onError: (e: Error) => errors.push(e), maxBytes: 10 });
    splitter.push('{"x":"aaaa');
    splitter.push('aaaaaaaa"}\n{"ok":1}\n');
    expect(lines).toEqual(['{"ok":1}']);
    expect(errors).toHaveLength(1);
  });
});
