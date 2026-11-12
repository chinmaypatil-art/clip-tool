/**
 * Returns one value per server process, shared by every bundle that imports
 * it. Next.js dev (Webpack) bundles each route separately, so a module-level
 * `new Map()` is a different map in the pipeline that writes status and in the
 * route the UI polls — the page then shows "extracting transcript" forever.
 */
export function processSingleton<T>(key: string, create: () => T): T {
  const store = globalThis as unknown as Record<string, T | undefined>;
  const slot = `__clipTool_${key}`;
  return (store[slot] ??= create());
}
