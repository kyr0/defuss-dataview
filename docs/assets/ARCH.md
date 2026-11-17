# Architecture

Website UI scripts/styles and attributed measurements. `bun run build` copies the versioned DataView bundles from `dist/` into `defuss-dataview@<version>/` through `scripts/site-build.mjs`, which also removes older versions; they are excluded from lint. site.js uses the current local query module; metrics are refreshed after verification.
