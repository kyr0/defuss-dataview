# Architecture

Existing shadcn component demo plus standalone DataView worker. The shadcn dependency carries its own bundled query implementation; the standalone worker is pinned to the local DataView build by site-build.mjs. The Reports tab runs `defuss-dataview/compute` plans from the local `browser-compute.mjs`, whose path site-build.mjs pins the same way; each report builds a new Data Grid element with its own columns, which defuss-shadcn initializes as a grid added after load.
