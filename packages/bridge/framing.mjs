// The two wire formats of the bridge.
//
//   Native messaging (host <-> browser, on stdin/stdout): every message is a 4-byte little-endian length
//   followed by that many bytes of UTF-8 JSON. Chunks from a pipe can hold part of a frame or several.
//   NDJSON (client <-> host, on the local socket): one JSON message per line.
import { MAX_MESSAGE_BYTES } from './protocol.mjs';

/** Thrown (or passed to `onError`) when a message is over the size limit. */
export class FrameTooLargeError extends Error {
  /** @param {number} size @param {number} limit */
  constructor(size, limit) {
    super(`Message of ${size} bytes is over the ${limit} byte limit`);
    this.name = 'FrameTooLargeError';
    this.size = size;
    this.limit = limit;
  }
}

/**
 * One native message: length prefix + UTF-8 JSON.
 * @param {unknown} message
 * @param {number} [maxBytes]
 * @returns {Buffer}
 */
export function encodeNative(message, maxBytes = MAX_MESSAGE_BYTES) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > maxBytes) throw new FrameTooLargeError(body.length, maxBytes);
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/**
 * Stream parser for native messages. Feed it chunks with `push`; it calls `onMessage` once per complete
 * frame. A frame over `maxBytes` is skipped (its bytes are still consumed, so the stream stays in step) and
 * reported to `onError`; a frame that is not JSON is reported too.
 * @param {{ onMessage: (message: unknown) => void, onError?: (error: Error) => void, maxBytes?: number }} handlers
 */
export function createNativeDecoder({ onMessage, onError = () => {}, maxBytes = MAX_MESSAGE_BYTES }) {
  /** @type {Buffer} */
  let buffered = Buffer.alloc(0);
  /** Bytes of an oversize frame still to throw away. */
  let skipping = 0;
  return {
    /** @param {Buffer | Uint8Array | string} chunk */
    push(chunk) {
      let data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      if (skipping > 0) {
        const dropped = Math.min(skipping, data.length);
        skipping -= dropped;
        data = data.subarray(dropped);
      }
      buffered = buffered.length ? Buffer.concat([buffered, data]) : data;
      while (buffered.length >= 4) {
        const size = buffered.readUInt32LE(0);
        if (size > maxBytes) {
          const available = buffered.length - 4;
          skipping = Math.max(0, size - available);
          buffered = buffered.subarray(4 + Math.min(size, available));
          onError(new FrameTooLargeError(size, maxBytes));
          continue;
        }
        if (buffered.length < 4 + size) break;
        const body = buffered.subarray(4, 4 + size).toString('utf8');
        buffered = buffered.subarray(4 + size);
        let message;
        try {
          message = JSON.parse(body);
        } catch (error) {
          onError(new Error(`Native message is not JSON: ${/** @type {Error} */ (error).message}`));
          continue;
        }
        onMessage(message);
      }
    },
    /** Bytes held while waiting for the rest of a frame. */
    get pending() {
      return buffered.length;
    },
  };
}

/**
 * One NDJSON line (JSON + "\n").
 * @param {unknown} message
 */
export function encodeLine(message) {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Splits a byte stream into lines (UTF-8 safe across chunk boundaries; `\r\n` accepted; blank lines
 * skipped). A line longer than `maxBytes` is dropped up to its newline and reported to `onError`.
 * @param {{ onLine: (line: string) => void, onError?: (error: Error) => void, maxBytes?: number }} handlers
 */
export function createLineSplitter({ onLine, onError = () => {}, maxBytes = MAX_MESSAGE_BYTES }) {
  /** @type {Buffer[]} */
  let parts = [];
  let size = 0;
  let discarding = false;
  return {
    /** @param {Buffer | Uint8Array | string} chunk */
    push(chunk) {
      let data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      while (data.length) {
        const newline = data.indexOf(0x0a);
        const piece = newline === -1 ? data : data.subarray(0, newline);
        if (!discarding) {
          parts.push(piece);
          size += piece.length;
          if (size > maxBytes) {
            onError(new FrameTooLargeError(size, maxBytes));
            parts = [];
            size = 0;
            discarding = true;
          }
        }
        if (newline === -1) break;
        if (!discarding) {
          let line = Buffer.concat(parts).toString('utf8');
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line.trim()) onLine(line);
        }
        parts = [];
        size = 0;
        discarding = false;
        data = data.subarray(newline + 1);
      }
    },
  };
}
