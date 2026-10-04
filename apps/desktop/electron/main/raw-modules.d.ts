/** Vite `?raw` imports (build-time asset inlining) used by main-process code. */
declare module "*?raw" {
  const source: string;
  export default source;
}
