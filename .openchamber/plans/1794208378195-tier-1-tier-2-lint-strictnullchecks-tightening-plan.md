# Tier 1 & Tier 2 Lint & strictNullChecks Tightening Plan

## Steps

- [x] Phase 1 (Tier 1): Enable `useUnknownInCatchVariables` in `tsconfig.json`, enable the `import` plugin in `.oxlintrc.json`, and re-enable 4 suppressed lint rules (`oxc/approx-constant`, `no-shadow`, `unicorn/prefer-add-event-listener`, `typescript/no-unnecessary-type-conversion`)
- [x] Phase 2 (Tier 2 — Schema & Leaf/Solver Null-Safety): Make scratch/transferable fields optional in `ProceduralLogisticsWorld`, initialize `world.noise` non-null, and make `terrain-solvers.js`, `hydrology-solvers.js`, `simulator.js`, `world-worker.js`, and `canvas-layer-cache.js` `strictNullChecks`-clean
- [x] Phase 3 (Tier 2 — Core Generator & Decomposed Stage Solvers Null-Safety): Add JSDoc nullable types to `let x = null` accumulators and default parameters across `src/world-generator.js`, `src/airport-solver.js`, `src/urban-fabric-solver.js`, `src/farm-estate-solver.js`, `src/expressway-solver.js`, and `src/vehicle-routing.js`
- [x] Phase 4 (Tier 2 — Renderer, State & Main UI Null-Safety): Add 2D context & canvas guards in `src/renderer.js` and route all DOM lookups through non-null `getEl`/`getInput`/`getSelect` helpers in `src/main.js` and `src/state.js`
- [x] Phase 5 (Tier 2 — Compiler & Type-Aware Lint Gate): Enable `strictNullChecks: true` in `tsconfig.json`, re-enable `typescript/no-unnecessary-boolean-literal-compare` and `typescript/no-useless-default-assignment` in `.oxlintrc.json`, and pass `bun run check`

---

## 1. Overview & Empirical Baseline

Probing the current decomposed codebase with `bun check --no-script --strictNullChecks --useUnknownInCatchVariables --all` and `bunx oxlint` shows that all **22 Tier 1 lint warnings** and **305 Tier 2 `strictNullChecks` diagnostics** collapse into a small set of mechanical, high-leverage root causes:

| Layer / File | Diagnostic Count | Root Cause |
|---|---|---|
| **Tier 1** (`hydrology-solvers.js`, `world-generator.js`, `urban-fabric-solver.js`, `expressway-solver.js`, `renderer.js`, `state.js`) | **22 warnings** | 17 hardcoded `1.414` constants (`oxc/approx-constant`), 1 shadowed `prev` variable (`no-shadow`), and 4 redundant `Boolean(...)` wrappers (`typescript/no-unnecessary-type-conversion`) |
| `src/canvas-layer-cache.js` | **1 error** | `let runStart = null` in `buildVignelliWaterPath` without `/** @type {number \| null} */` |
| `src/renderer.js` | **51 errors** | `this.ctx` and `this.canvas` typed as `... \| null`, `this._cachedVectorPaths` destructuring, `modeFilter = null` in `drawCars`, and `stroke = null` in `drawAirplaneSilhouette` |
| `src/main.js` | **13 errors** | Direct `document.getElementById(...)` calls bypassing `getEl(id)`, `bestBuilding = null`, plus `currentWorld` / `worldWorker` null guards |
| `src/terrain-solvers.js` & `src/hydrology-solvers.js` | **36 errors** | `world.noise` typed as `FastNoise2D \| null` (13 errors), `primarySink` nullable parameter, and `let bestSp = null` without `/** @type {Point2D \| null} */` |
| `src/world-generator.js` & Stage 5–9 Solvers (`airport-solver.js`, `urban-fabric-solver.js`, `farm-estate-solver.js`, `expressway-solver.js`, `vehicle-routing.js`) | **193 errors** | (a) `let best = null` local accumulators narrowed to `null`/`never` without JSDoc `@type {T \| null}`, (b) default parameters `param = null` inferred as `null \| undefined`, (c) `Town.commercialCount` / `industrialCount` / `clusterId` optionality, and (d) `delete world.rng` requiring optional properties under `strictNullChecks` |
| `src/simulator.js`, `scripts/bench.js` & `tests/` | **11 errors** | `let dest = null` in `spawnPlane`, `let lastState = null` in `dom-contract.test.js`, `prevPrio` in `math-and-pipeline.test.js`, and `mw.airportId` `number \| null` narrowing |

---

## 2. Phase 1 — Tier 1: Quick-Win Compiler & Linter Tightening

1. **`tsconfig.json`**:
   - Enable `"useUnknownInCatchVariables": true`.
2. **`.oxlintrc.json`**:
   - Add `"import"` to `"plugins": ["typescript", "unicorn", "oxc", "import"]` to catch circular dependencies, duplicate imports, and self-imports across ES modules and Web Workers.
   - Remove the suppressions for `"oxc/approx-constant"`, `"no-shadow"`, `"unicorn/prefer-add-event-listener"`, and `"typescript/no-unnecessary-type-conversion"`.
3. **Code Fixes (22 occurrences across 6 files)**:
   - [src/hydrology-solvers.js](./src/hydrology-solvers.js#L212-L215), [src/world-generator.js](./src/world-generator.js#L528), [src/urban-fabric-solver.js](./src/urban-fabric-solver.js#L591-L594), & [src/expressway-solver.js](./src/expressway-solver.js#L928-L931): Replace literal `1.414` with `Math.SQRT2`.
   - [src/hydrology-solvers.js](./src/hydrology-solvers.js#L638): Rename inner `const prev = touchedMap.get(gid)` to `const existing = touchedMap.get(gid)` to eliminate variable shadowing.
   - [src/renderer.js](./src/renderer.js#L178-L181) ([`#L484`](./src/renderer.js#L484), [`#L3557`](./src/renderer.js#L3557)) & [src/state.js](./src/state.js#L349): Remove redundant `Boolean(expr)` wrappers on already-boolean expressions or replace nullable checks with `!!(...)`.

---

## 3. Phase 2 — Tier 2: Schema, Leaf Modules, Solvers & Canvas Cache

1. **Shared Schema ([src/types.d.ts](./src/types.d.ts))**:
   - Make `Town.commercialCount`, `Town.industrialCount`, and `Town.clusterId` required `number` fields (initialized to `0` in `seedSettlements` and `coEvolveSecondarySettlements`).
   - Type `PrimarySink` as non-null in `synthesizeFluvialHydrology(world, basins, primarySink)`.
2. **`src/terrain-solvers.js` & `src/hydrology-solvers.js`**:
   - Initialize `this.noise = new FastNoise2D(this.rng)` in `ProceduralLogisticsWorld` constructor (`src/world-generator.js#L232`) so `world.noise` is always a non-null `FastNoise2D`.
   - Annotate `/** @type {Point2D | null} */ let bestSp = null;` in `pickHighlandMountainSprings` and `island-hopper` spring selection.
   - Type `smoothPolyline` and `applyMeanderingDisplacement` return values in `carveTaperingRiverPath`.
3. **`src/simulator.js` & `src/canvas-layer-cache.js`**:
   - Annotate `/** @type {Airport | PlaneEndpoint | null} */ let dest = null;` in `LogisticsSimulator.prototype.spawnPlane`.
   - Annotate `/** @type {number | null} */ let runStart = null;` at [src/canvas-layer-cache.js](./src/canvas-layer-cache.js#L839).

---

## 4. Phase 3 — Tier 2: Core World Generator & Stage 5–9 Solvers (`src/world-generator.js`, `src/*-solver.js`, `src/vehicle-routing.js`)

1. **Optional Scratch Fields for `extractWorldTransferables` (`src/world-generator.js`)**:
   - Mark the scratch properties deleted in `extractWorldTransferables(world)` (`rng?`, `noise?`, `roadEdges?`, `_vehicleGraph?`, `_astarG?`, `_astarParent?`, `_astarSeenGen?`, `_astarClosedGen?`) or assign `undefined` so `TS2790 (The operand of a 'delete' operator must be optional)` is satisfied cleanly.
2. **Default Parameters & Nullable Accumulators Across Stage 5–9 Solvers**:
   - Add explicit JSDoc `@param` types on methods with `= null` defaults (`findRoadPathAStar`, `carveTownStreetGrids`, `commitRoadPath`, `tryPlaceNeighborhoodHouses` in `src/urban-fabric-solver.js`; `isPointInAirportPad`, `doesSegmentCrossAirport`, `doesPolylineCrossAirport` in `src/airport-solver.js`; `scoreMotorwaySamples`, `findValleyMotorwayWaypoints`, `createMotorwayEntity`, `tryBuildTrumpetSpurToTrunk` in `src/expressway-solver.js`; and their delegation wrappers in `src/world-generator.js`).
   - Add `/** @type {... | null} */` annotations to local `let best... = null` accumulators in `src/world-generator.js`, `src/airport-solver.js`, `src/urban-fabric-solver.js`, `src/farm-estate-solver.js`, `src/expressway-solver.js`, and `src/vehicle-routing.js`.

---

## 5. Phase 4 — Tier 2: Renderer, State & Main UI (`src/renderer.js`, `src/main.js`, `src/state.js`)

1. **`src/renderer.js`**:
   - Guard `if (!this.ctx || !this.canvas) return;` at the top of `fitCamera` and `render`, guard `this._cachedVectorPaths` destructuring in `prepareDisplayLists`, and type `modeFilter = null` in `drawCars` and `stroke = null` in `drawAirplaneSilhouette`, eliminating all 51 nullable errors.
2. **`src/main.js` & `src/state.js`**:
   - Update `getEl(id)` to return non-null `HTMLElement` and replace remaining raw `document.getElementById(...)` calls in `src/main.js` with `getEl(...)`.
   - Add `if (!currentWorld) return;` / `if (!worldWorker) return;` guards and annotate `bestBuilding` in `src/main.js`.

---

## 6. Phase 5 — Enable `strictNullChecks: true` & Null-Aware Type-Aware Lint Rules

1. **`tsconfig.json`**:
   - Set `"strictNullChecks": true` and `"useUnknownInCatchVariables": true`.
2. **`.oxlintrc.json`**:
   - Remove `"typescript/no-unnecessary-boolean-literal-compare": "off"` and `"typescript/no-useless-default-assignment": "off"` so `oxlint-tsgolint` actively enforces both rules with `strictNullChecks` enabled, and clean up the 2 flagged redundant default assignments (`src/world-generator.js#L1887`, `src/main.js#L382`).
3. **Verification Gates**:
   - `bun fmt --no-script --check src/ tests/ scripts/ playwright.config.js index.html` exits `0`.
   - `bunx oxlint --deny-warnings src/ tests/ scripts/` (with `typeAware: true`) exits `0`.
   - `bun check --no-script` (with `strictNullChecks: true`) exits `0`.
   - `bun test --check tests/unit` exits `0`.
   - `bunx playwright test` exits `0`.