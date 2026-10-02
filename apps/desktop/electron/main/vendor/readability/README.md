# Vendored @mozilla/readability

Pinned upstream `@mozilla/readability` v0.6.0 (Apache-2.0), file
`Readability.js` unmodified (UMD: browser global `Readability`).

Used by `electron/main/web-clipper.ts` (T52.5 web clipping): the source is
injected into a hidden offscreen window's page context, where Readability
parses the live DOM. Kept as checked-in bytes so the main process never
resolves node_modules at runtime (packaging guard: runtime dependencies stay
native-only).

Upgrade = replace both files from the same upstream version, bump the pin
here, and rerun the clipper tests.
