/** Vite asset imports used by the research components embedded in the app. */
declare module "*?url" {
  const url: string;
  export default url;
}
declare module "*?url&no-inline" {
  const url: string;
  export default url;
}

/** Vite's ?raw suffix imports a file's source as a string (MaterialMechanism shows engine.ts). */
declare module "*?raw" {
  const source: string;
  export default source;
}
