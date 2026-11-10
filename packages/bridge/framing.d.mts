export declare class FrameTooLargeError extends Error {
  constructor(size: number, limit: number);
  size: number;
  limit: number;
}
export declare function encodeNative(message: unknown, maxBytes?: number): Buffer;
export declare function createNativeDecoder(handlers: {
  onMessage: (message: unknown) => void;
  onError?: (error: Error) => void;
  maxBytes?: number;
}): { push(chunk: Buffer | Uint8Array | string): void; readonly pending: number };
export declare function encodeLine(message: unknown): string;
export declare function createLineSplitter(handlers: {
  onLine: (line: string) => void;
  onError?: (error: Error) => void;
  maxBytes?: number;
}): { push(chunk: Buffer | Uint8Array | string): void };
