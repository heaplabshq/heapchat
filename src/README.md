# src/

Backend modules extracted from the original monolithic `server.js`.

`server.js` at the repo root is now a thin bootstrap that wires these together
and starts the HTTP server. See `SERVER-REFACTOR-PLAN.md` for the target layout
and the step-by-step extraction plan.

Constraints (kept in sync by the harness wiring):
- `eval/run.js` symlinks this dir into its sandbox.
- `electron/main.js` dev-watches this dir for auto-restart.
- `package.json` `build.files` includes `src/**/*` for packaging.
