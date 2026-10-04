/**
 * Module hooks that let `node --test` import main-process TypeScript directly.
 *
 * Node strips the types itself, but the sources use bundler-style relative
 * imports: extensionless specifiers (`./plugin-mcp`) and `.js` specifiers that
 * only exist as `.ts` on disk. ESM resolution rejects both, so the exact
 * specifier is tried first and the TypeScript sibling second — a real `.js`
 * or `.mjs` file still wins, and nothing that already resolved changes.
 *
 * Register with:
 *   register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
 */
export async function resolve(specifier, context, next) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return next(specifier, context);
  }
  // Vite-style `?raw` asset imports: surface the file as a default export.
  if (specifier.endsWith("?raw")) {
    const target = specifier.slice(0, -"?raw".length);
    const resolved = await next(target.endsWith(".js") ? target : target, context);
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const contents = readFileSync(fileURLToPath(resolved.url), "utf8");
    // data: URL so the default loader uses the inlined source — resolve-only
    // hooks cannot override what the load phase reads from disk.
    return {
      format: "module",
      shortCircuit: true,
      url: `data:text/javascript,${encodeURIComponent(`export default ${JSON.stringify(contents)};`)}`,
    };
  }
  try {
    return await next(specifier, context);
  } catch (error) {
    const typescript = specifier.endsWith(".js")
      ? `${specifier.slice(0, -".js".length)}.ts`
      : /\.[a-z]+$/i.test(specifier)
        ? null
        : `${specifier}.ts`;
    if (typescript === null) throw error;
    return next(typescript, context);
  }
}
