/** Vite (WXT, Vitest, vite-node) imports a file's text with `?raw`. Used by playwrightRuntime.ts. */
declare module '*?raw' {
  const source: string;
  export default source;
}
