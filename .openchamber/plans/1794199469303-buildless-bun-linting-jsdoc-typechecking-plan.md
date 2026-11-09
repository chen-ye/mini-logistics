# Buildless Bun Linting, JSDoc Typechecking, Testing & GitHub Actions Plan

## Steps

- [x] Phase 1: Configure native Bun tooling (`package.json`, `.oxlintrc.json`, `tsconfig.json`) and `oxlint` devDependency (while `bun lint` is gated in Bun v1.4.4)
- [x] Phase 2: Author shared Hourglass domain schema in `src/types.d.ts` for comment-only `@import` consumption
- [x] Phase 3: Add JSDoc type annotations to leaf modules, solvers, simulator, and dual Web Workers (`palette.js`, `math.js`, `terrain-solvers.js`, `hydrology-solvers.js`, `simulator.js`, `world-worker.js`, `terrain-bake-worker.js`)
- [x] Phase 4: Declare `ProceduralLogisticsWorld` constructor fields and type the 9-stage memoized DAG pipeline in `src/world-generator.js`
- [x] Phase 5: Annotate `MiniMotorwaysRenderer` in `src/renderer.js` and DOM/Inspector bindings in `src/main.js`
- [x] Phase 6: Implement pure algorithmic `bun:test` suites (`tests/unit/`) and real-browser Playwright E2E suites (`tests/e2e/`) with zero DOM mocking
- [x] Phase 7: Add GitHub Actions CI workflow (`.github/workflows/ci.yml`) running `bun fmt --no-script --check`, `bunx oxlint --deny-warnings`, `bun check --no-script`, `bun test --check`, and Playwright E2E tests
- [x] Phase 8: Update documentation (`README.md` and `AGENTS.md`) with accurate source fragment links, Dual-Worker architecture details, and static check/test commands
- [x] Phase 9: Pass all local static, unit/invariant, and Playwright browser verification gates

## 1. Architectural Invariants & Goals

1. **100% Static & Buildless Runtime**:
   - `index.html` continues loading `./src/main.js` directly via native browser `<script type="module">`, and `src/main.js` continues spawning `./world-worker.js` and `./terrain-bake-worker.js` as native module Web Workers.
   - Zero bundling, zero transpilation, and zero build output directory.
   - All shared domain types live in `src/types.d.ts` and are referenced inside `.js` files strictly via JSDoc `/** @import { ... } from './types.js' */` comments so the browser parser ignores them and makes **zero extra HTTP requests** at runtime.
2. **Native Bun Toolchain + `oxlint` (until Bun v1.4.5 un-gates `bun lint`)**:
   - **Linter**: `bunx oxlint --deny-warnings src/ tests/` configured via `.oxlintrc.json` (which both `oxlint` and `bun lint` read natively).
   - **Typechecker**: `bun check --no-script` configured via `tsconfig.json` (`allowJs: true`, `checkJs: true`, `noEmit: true`, Pragmatic Strict flags) using Bun's built-in TypeScript 7 checker and bundled `lib.dom.d.ts` / `lib.webworker.d.ts` definitions.
   - **Formatter**: `bun fmt --no-script` (`bun fmt --no-script --check src/ tests/ playwright.config.js index.html`).
   - **Test Runner**: `bun test --check` using `bun:test` directly against the pure ES modules in `src/` with zero DOM mocks required for the core generator, solvers, and simulator.

---

## 2. Phase 1 — Native Bun Configuration Files

### 2.1 `package.json`
Add `"type": "module"` so `oxlint`, `bun check`, and `bun test` parse all `.js` files as ES modules, and register check/test scripts:

```json
{
  "name": "mini-logistics",
  "version": "1.0.0",
  "description": "2D procedural world generator and multi-modal transportation logistics simulator inspired by OpenTTD and Mini Motorways",
  "private": true,
  "type": "module",
  "repository": {
    "type": "git",
    "url": "https://github.com/chen-ye/mini-logistics.git"
  },
  "scripts": {
    "dev": "bunx serve . -p 8788",
    "start": "bunx serve . -p 8788",
    "lint": "bunx oxlint --deny-warnings src/ tests/",
    "lint:fix": "bunx oxlint --fix src/ tests/",
    "typecheck": "bun check --no-script",
    "test:unit": "bun test tests/unit",
    "test:e2e": "bunx playwright test",
    "test": "bun test tests/unit && bunx playwright test",
    "fmt": "bun fmt --no-script src/ tests/ playwright.config.js index.html",
    "fmt:check": "bun fmt --no-script --check src/ tests/ playwright.config.js index.html",
    "check": "bun fmt --no-script --check src/ tests/ playwright.config.js index.html && bunx oxlint --deny-warnings src/ tests/ && bun check --no-script && bun test --check tests/unit && bunx playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.52.0",
    "oxlint": "^1.0.0",
    "serve": "^14.2.4"
  }
}
```

### 2.2 `.oxlintrc.json`
Initialized via `bunx oxlint --init` with `"options": { "typeAware": true }` powered by `oxlint-tsgolint` (read natively by both `oxlint` today and `bun lint` in Bun v1.4.5+):

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["typescript", "unicorn", "oxc"],
  "options": {
    "typeAware": true
  },
  "categories": {
    "correctness": "error",
    "suspicious": "warn"
  },
  "rules": {
    "eqeqeq": ["error", "smart"],
    "no-unused-vars": "error",
    "@typescript-eslint/no-floating-promises": "off",
    "typescript/no-unnecessary-boolean-literal-compare": "off",
    "typescript/no-unnecessary-type-conversion": "off",
    "typescript/no-unsafe-type-assertion": "off",
    "typescript/no-useless-default-assignment": "off",
    "no-underscore-dangle": "off",
    "no-shadow": "off",
    "oxc/approx-constant": "off",
    "unicorn/consistent-function-scoping": "off",
    "unicorn/no-array-reverse": "off",
    "unicorn/no-array-sort": "off",
    "unicorn/prefer-add-event-listener": "off",
    "unicorn/require-post-message-target-origin": "off"
  },
  "ignorePatterns": ["node_modules/"],
  "env": {
    "builtin": true,
    "browser": true,
    "worker": true,
    "es2024": true
  }
}
```

### 2.3 `tsconfig.json`
Configure TypeScript 7-compatible Pragmatic Strict settings (`checkJs: true`, `noImplicitThis: true`, `strictFunctionTypes: true`, `strictNullChecks: false`) and omit deprecated TS 5 options (`baseUrl`, `esModuleInterop`, `alwaysStrict`):

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable", "WebWorker"],
    "types": [],
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": false,
    "noImplicitThis": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "allowUnreachableCode": false,
    "skipLibCheck": true
  },
  "include": ["src/**/*.js", "src/**/*.d.ts", "tests/**/*.js"]
}
```

---

## 3. Phase 2 — Shared Domain Type Schema (`src/types.d.ts`)

Define the Hourglass data contracts across all 9 worldgen stages, worker messages, renderer overlays, and simulation entities:

1. **Configuration & Palette Primitives**:
   - `WorldSizeKey` (`'compact' | 'standard' | 'large' | 'huge'`), `WorldSizePreset`
   - `ArchetypeKey` (`'confluence' | 'estuary' | 'archipelago' | 'inland' | 'island-hopper'`)
   - `TerrainAlgoKey` (`'tectonic-fbm' | 'quilez-erosion' | 'voronoi-plates'`)
   - `HydrologyAlgoKey` (`'thalweg-astar' | 'd8-strahler' | 'meandering-plain'`)
   - `AirportMixKey` (`'hub-regional' | 'hub-reg-cargo' | 'dual-hub'`)
   - `ViewLayer` (`'aesthetic' | 'rci' | 'airport' | 'hierarchy' | 'hydrology' | 'roadgrid'`)
   - `GeneratorConfig`, `WindVector`, `DistrictColor`, `Palette`
2. **Stage 2A & 2B Hydrology Contracts**:
   - `WaterBasin`, `PrimarySink`, `HydroFeature`, `RiverPoint`, `RiverRibbon`
   - `Stage1WindState`, `Stage2ATerrainState`, `Stage2BHydrologyState`, `Stage3SpatialState`
3. **Stages 4–7 Settlements, Airports & Urban Fabric**:
   - `Landmass`, `Borough`, `Town`, `Airport`, `RoadPoint`, `RoadSegment` (including `isMainBoulevard?`, `isUnderpassStem?`, `stubOriginX?`, `stubOriginY?`), `House`, `TreeDot`
   - `FarmParcel`, `TractorTrack`, `Destination` (`zoneType: 'commercial' | 'industrial'`, `subType`, `resourceType?: 'MINE' | 'TIMBER' | 'FARM'`, `bspParcels?`, `estateLoops?`, `tractorTracks?`, `windbreakPts?`)
4. **Stages 8–9 Expressways, Discriminated Interchanges & Multi-Modal Routing**:
   - `MotorwayTunnel`, `Motorway`, `DiamondSlipRamp` (`{ sySign: -1 | 1, sxSign: -1 | 1, isOffRamp: boolean, kRamp: number, p0: Point2D, p1: Point2D, p2: Point2D, p3: Point2D, gridX: number, gridY: number }`)
   - Discriminated `Interchange` union:
     - `CloverleafInterchange` (`type: 'cloverleaf'`, `angleA`, `angleB`, `mwayA`, `mwayB`, `activeSignsA`, `activeSignsB`, `prunedBridgeB`)
     - `TrumpetInterchange` (`type: 'trumpet'`, `angleMain`, `sideSign`, `mwayMain`, `mwaySpur`)
     - `DiamondRampInterchange` (`type: 'diamond-ramp'`, `angleRad`, `connSide`, `posTerm: Point2D`, `negTerm: Point2D`, `termX`, `termY`, `oppTermX`, `oppTermY`, `connectX`, `connectY`, `isThroughDiamond`, `ramps: DiamondSlipRamp[]`, `mwayNumber`, `townName`)
     - `TerminalStubInterchange` (`type: 'terminal-stub'`, `isAirportStub`, `stubEndX`, `stubEndY`, `angleRad`, `airportId?`, `townId?`)
   - `VehicleGraphNode`, `VehicleRoutingGraph`, `DirectedLanePoint`, `DirectedLaneTrack`, `CargoLink`, `CommuterRoute`
5. **Workers, Simulator & Global Window Augmentation**:
   - `BakeHydroPayload`, `BakeComposePayload`, `WorldWorkerRequest`, `WorldWorkerResponse`
   - `CarAgent`, `PlaneAgent`, `RoadGraphAnomaly`, `RoadGraphDiagnostics`, `InspectedEntity`
   - Global `Window` interface extension (`renderer`, `currentWorld`, `simulator`, `rebuildWorld`, `openEntityInspector`)

---

## 4. Phase 3 — Leaf Modules, Solvers & Dual-Worker Pipeline

1. **`src/palette.js` (41 lines)**:
   - Import `Palette` from `./types.js` via `/** @import { Palette } from './types.js' */` and annotate `PALETTE`.
2. **`src/math.js` (152 lines)**:
   - Annotate `SeededRNG` (`seedStr: string`, `range(min: number, max: number): number`, `int(min: number, max: number): number`, and generic `@template T @param {readonly T[]} arr @returns {T}` on `pick(arr)`).
   - Annotate `FastNoise2D` (`rng: SeededRNG`, `noise`, `fbm`, `noiseDeriv` returning `{ val: number, dx: number, dy: number }`, `fbmEroded`).
3. **`src/terrain-solvers.js` (416 lines) & `src/hydrology-solvers.js` (743 lines)**:
   - Annotate `synthesizeTerrainAndBasins(world)` (`@param {ProceduralLogisticsWorld} world @returns {{ basins: WaterBasin[], primarySink: PrimarySink }}`).
   - Annotate `synthesizeFluvialHydrology(world, basins, primarySink)` and internal closures (`smoothPolyline`, `applyMeanderingDisplacement`, `routeValleyThalwegAStar`, `carveTaperingRiverPath`, `pickMapBorderRiverEntries`, `pickHighlandMountainSprings`).
4. **`src/world-worker.js` (139 lines) & `src/terrain-bake-worker.js` (330 lines)**:
   - Bind `const workerSelf = /** @type {DedicatedWorkerGlobalScope} */ (/** @type {unknown} */ (self))` in worker listener sections so `workerSelf.postMessage(payload, transferList)` resolves to `DedicatedWorkerGlobalScope.postMessage` rather than `Window.postMessage`.
   - Annotate `createSurface(width, height)` in `src/terrain-bake-worker.js` as returning `OffscreenCanvas | HTMLCanvasElement` and type `TerrainBitmapBaker` methods (`buildVignelliWaterPath`, `prepareHydroLayers`, `composeTerrainBitmap`).
5. **`src/simulator.js` (165 lines)**:
   - Annotate `LogisticsSimulator` fields (`world: ProceduralLogisticsWorld`, `cars: CarAgent[]`, `planes: PlaneAgent[]`, `tripsCompleted: number`, `simTime: number`) and methods (`initAgents`, `spawnCar`, `spawnPlane`, `update`).

---

## 5. Phase 4 — Core World Generator & Memoized DAG (`src/world-generator.js`, 8,252 lines)

1. **Constructor Field Declarations on `ProceduralLogisticsWorld`**:
   - Explicitly initialize or declare all instance properties in `constructor()` so `checkJs` recognizes every property assigned in `ensureGridSize()` and Stages 1–9:
     - Grid & elevation buffers: `elevationField`, `slopeField`, `drainageField`, `waterMask`, `fertilityField`, `distToWater`, `urbanSuitability`, `airportHeatmap`, `roadGrid`, `roadEdges`, `buildingMask`, `zoneColorIdx`, `landmassId`, `landmasses`
     - A* & coarse pathfinder scratch buffers: `_astarG`, `_astarParent`, `_astarSeenGen`, `_astarClosedGen`, `_astarGen`, `_coarseBaseCost`, `_coarseG`, `_coarseParent`, `_coarseSeenGen`, `_coarseClosedGen`, `_coarseGen`
     - Stage & telemetry properties: `rng`, `noise`, `confluencePoint`, `bridgeCount`, `commuterRoutes`, `_vehicleGraph`, `hydroVersion`, `urbanVersion`, `reusedThroughStage`, `terrainUnchanged`, `genTimeMs`, `wallTimeMs`, `bakeTimeMs`, `waitAfterGenMs`, `terrainBitmap`, `reuseTerrainBitmap`
2. **Typed `createMemoStage` Combinator**:
   - Annotate `createMemoStage(selectDeps, computeFn)` with `@template {readonly unknown[]} Args`, `@template {readonly unknown[]} Deps`, `@template Out` so `stage1_wind` through `stage9_rampsAndCargo` infer their strongly typed stage snapshots.
3. **Method & Helper Signatures**:
   - Annotate key methods on `ProceduralLogisticsWorld` (`setStageRNG`, `inBounds`, `idx`, `findRoadPathAStar`, `commitRoadPath`, `solveAndPlaceAirports`, `growUrbanFabric`, `ensureVehicleRoutingGraph`, `findVehicleNetworkPath`, `buildDirectedLaneTrajectory`, `scoreMotorwaySamples`, `findValleyMotorwayWaypoints`, `createMotorwayEntity`, `tryBuildTrumpetSpurToTrunk`, `displaceAndRerouteRoadsAtInterchange`, `intersectUnderpassWithMotorway`, `buildFlexibleDiamondRamps`, `findExistingOctilinearUnderpass`, `buildIntermediateExpresswayRamps`, `extractWorldTransferables`, `hydrateTransferredWorld`).

---

## 6. Phase 5 — Canvas Renderer & Main-Thread UI (`src/renderer.js`, `src/main.js`)

1. **`src/renderer.js` (3,401 lines)**:
   - Annotate `MiniMotorwaysRenderer` constructor properties (`canvas`, `ctx`, `camera`, `activeLayer: ViewLayer`, `selectedEntity`, `offscreenTerrain`, `_cachedArablePaths`, `_roadDiagWorld`, `_roadDiagCache`).
   - Annotate `fitCamera`, `buildVignelliWaterPath`, `setTerrainBitmap`, `bakeStaticTerrainAsync`, `render`, `drawBuildings`, `drawAirports`, `drawInterchangesUnderlay`, `drawMotorways`, `drawCars`, `drawPlanes`, `computeRoadGraphDiagnostics`, and `drawSelectionHighlight` (narrowing `Destination | Airport | Town`).
2. **`src/main.js` (964 lines)**:
   - Introduce small typed DOM lookup helpers (`getEl(id)`, `getInput(id)`, `getSelect(id)`) so reading `.value`, `.checked`, and `.textContent` across all UI controls is type-safe without repetitive inline JSDoc casts.
   - Annotate `getGeneratorConfig(): GeneratorConfig`, `rebuildWorld(preserveCamera?: boolean): Promise<ProceduralLogisticsWorld | void>`, `describeBuildingDossier(d: Destination)`, `openEntityInspector(type, entity, shouldFocus)`, `findEntityAtWorldPos(wx, wy, touchPad)`, and `PointerEvent` / `WheelEvent` / `KeyboardEvent` listeners.

---

## 7. Phase 6 — Two-Tier Behavioral Testing Strategy (`bun:test` + Playwright, Zero DOM Mocks)

### 7.1 Testing Philosophy (`principle-test-behavior-not-implementation` & Zero DOM Mocking)
- **Never use synthetic DOM mocks (`jsdom`, `happy-dom`, or fake Canvas stubs)**:
  - **Pure algorithmic modules** (`src/math.js`, `src/palette.js`, `src/terrain-solvers.js`, `src/hydrology-solvers.js`, `src/world-generator.js`, `src/simulator.js`, and `MiniMotorwaysRenderer.prototype.computeRoadGraphDiagnostics`) do not touch the DOM at all; they run directly in `bun test tests/unit` as plain JS modules.
  - **Browser, DOM, Canvas 2D, `OffscreenCanvas`, `ImageBitmap`, and Dual-Worker (`world-worker.js` ∥ `terrain-bake-worker.js`) interactions** (`src/main.js`, `src/renderer.js`, `src/world-worker.js`, `src/terrain-bake-worker.js`, `index.html`) run in **real headless Chromium via Playwright (`@playwright/test`)** in `tests/e2e/app.spec.js`.

### 7.2 Unit Suite 1: Deterministic Math, Reactive DAG Memoization & Worker Transfer (`tests/unit/math-and-pipeline.test.js`)
1. **Deterministic PRNG & Analytic Noise Derivatives (`src/math.js`)**:
   - Same seed string produces identical sequences across `next()`, `range()`, `int()`, and `pick()`; distinct seeds diverge immediately.
   - `FastNoise2D.prototype.noise(x, y)` and `fbmEroded(x, y)` remain strictly bounded in `[0, 1]` across extreme and negative coordinates.
   - `FastNoise2D.prototype.noiseDeriv(x, y)` analytic partial derivatives `(dx, dy)` match central finite-difference approximations `(val(x+ε, y) - val(x-ε, y)) / (2ε)` within `1e-3`.
2. **9-Stage Reactive DAG Cache Invalidation (`createMemoStage` & `createWorldPipeline`)**:
   - Running `pipeline(cfg)` twice with identical `cfg` hits cache on all stages (`reusedThroughStage === 9`, `terrainUnchanged === true`).
   - Toggling `includeIntermediateRamps` (Stage 9) reuses Stages 1–8 (`reusedThroughStage === 8`, `terrainUnchanged === true`) and preserves identical `hydroVersion` and `urbanVersion`.
   - Changing `buildingDensity` (Stage 6/7) reuses Stages 1–5 (`reusedThroughStage === 5`), increments `urbanVersion`, and keeps `hydroVersion` unchanged.
   - Changing `hydrologyAlgo` (Stage 2B) reuses Stage 1 (`reusedThroughStage === 1`), increments `hydroVersion`, and recomputes downstream stages.
   - **Scratch Workspace Isolation**: Running `pipeline(seedA)` → `pipeline(seedB)` → `pipeline(seedA)` produces bit-for-bit identical `elevationField`, `waterMask`, `roadGrid`, `buildingMask`, `towns`, `airports`, and `motorways` on both `seedA` runs.
3. **Zero-Copy Worker Transfer Contract (`extractWorldTransferables` & `hydrateTransferredWorld`)**:
   - `extractWorldTransferables(world)` returns 12 `ArrayBuffer` transferables, strips non-cloneable scratch fields (`rng`, `noise`, `roadEdges`, `_vehicleGraph`), and clones `TypedArray`s so cached upstream stage buffers remain un-detached.
   - `hydrateTransferredWorld(rawWorld)` restores `ProceduralLogisticsWorld.prototype` methods (`idx()`, `inBounds()`, `hasRoadEdge()`).

### 7.3 Unit Suite 2: Pluggable Solver Matrix & `AGENTS.md` Domain Invariants (`tests/unit/world-invariants.test.js`)
Evaluates benchmark seeds (`OTTD-METRO-84`, `DELTA-402`, `HARBOR-305`, `VALLEY-618`, `ISLAND-HOP-101`) across `compact` and `standard` grid scales:
1. **$3 \times 3$ Hourglass Solver Matrix**:
   - All 9 combinations of `terrainAlgo` (`tectonic-fbm`, `quilez-erosion`, `voronoi-plates`) $\times$ `hydrologyAlgo` (`thalweg-astar`, `d8-strahler`, `meandering-plain`) plus `island-hopper` satisfy the `(elevationField, seaLevel, waterMask, rivers)` contract: `elevationField` values are finite in `[0.02, 0.98]`, `waterMask` values are in `{0, 1, 2}`, and every river polyline has $\ge 4$ in-bounds points with downstream width $\ge$ upstream width.
2. **Hydrology & Headwater Setback Invariants**:
   - Mainstem river channel centers carve `waterMask > 0`.
   - Every interior highland spring (`river.headwaterPt`) maintains the 6-tile surface road exclusion buffer (`roadGrid === 0`) around its tip.
3. **Topological & Geometric Road Grid Invariants (`computeRoadGraphDiagnostics`)**:
   - `MiniMotorwaysRenderer.prototype.computeRoadGraphDiagnostics(world).anomalies` reports **zero** `'road-building-overlap'`, **zero** `'non-octilinear-edge'`, and **zero** `'orphan-roadgrid-tile'` defects.
   - No road polyline crosses water for $> 5$ consecutive bridge steps.
   - Every placed `house` and `destination` has a valid `roadX, roadY` driveway on an active surface road tile (`roadGrid === 1 || roadGrid === 2`).
4. **Expressway, Interchange & Mountain Tunnel Invariants**:
   - Expressways (`world.motorways`) never cross any airport pad (`world.doesPolylineCrossAirport(mw.samples, 1.8, mw.airportId) === false`).
   - Expressways never make acute hairpin turns (`cosTurn >= 0.35`) or run longitudinally inside river channels (`riverProxArc <= 14.5`).
   - Subterranean mountain tunnels (`mw.tunnels`) only occur where `elevationField >= seaLevel + 0.21` and never coalesce across a surface gap containing a `cloverleaf`, `trumpet`, or `diamond-ramp` interchange.
   - **Octilinear Diamond Underpasses & Flexible World-Space Slip-Ramps**: Every `diamond-ramp` interchange preserves a strictly octilinear (`0°/45°/90°`) integer-grid surface underpass vector between `ic.posTerm` and `ic.negTerm` (`dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)`) and defines exactly 4 world-space cubic Bezier slip-ramps (`ic.ramps.length === 4`) bridging `mw.samples[ramp.kRamp]` (`p0`) to the integer-grid terminal (`p3`).

### 7.4 Unit Suite 3: Multi-Modal Traffic & Aviation Simulation (`tests/unit/simulator.test.js`)
1. **Supply Chain & Commuter Track Integrity**:
   - Every `cargoLink` (`RAW->MFG`, `MFG->LOG`, `MFG->COM`, `LOG->COM`, `RAW->LOG`) and `commuterRoute` has non-empty `outboundTrack` and `inboundTrack` with strictly non-decreasing `cumLen` and `totalLength > 0`.
2. **Agent Lifecycle & Turnaround Behavior (`LogisticsSimulator`)**:
   - Spawns commuter cars, freight trucks, and aircraft (including the `3x` aircraft fleet multiplier in `island-hopper` mode and virtual off-map corridor fallback when `airportCount === 1`).
   - Advancing `simulator.update(0.05, 1.0)` over 500 ticks monotonically advances `simTime`, flips vehicle `returning` flags upon reaching `track.totalLength`, increments `tripsCompleted` (+1 per car/truck trip, +6 per flight leg), and keeps all agent positions/progress finite.
   - `simulator.update(0.05, 0)` is a strict no-op when paused (`simSpeed === 0`).

### 7.5 Real-Browser E2E Suite: Playwright (`playwright.config.js` & `tests/e2e/app.spec.js`)
Configures `webServer: { command: 'bun run dev', url: 'http://127.0.0.1:8788/index.html', reuseExistingServer: !process.env.CI }` and verifies in real headless Chromium across desktop (`1600×1000`) and mobile (`390×844`) viewports:
1. **Buildless Network & Dual-Worker Initialization**:
   - Zero `pageerror` or `console.error` events on boot and across seed/slider changes.
   - Network waterfall requests only `.html`, `.css`, `.js`, and font assets—**zero HTTP `404`s and zero requests for `.d.ts` files** (proving JSDoc `@import` comments remain completely invisible to the browser).
   - Dual-Worker pipeline (`world-worker.js` ∥ `terrain-bake-worker.js`) completes initial build (`#genTimeBadge` displays `<N> ms · 2W Parallel`), populates `window.currentWorld`, `window.simulator`, and `window.renderer`, and transfers an `ImageBitmap` to `renderer.offscreenTerrain`.
2. **UI Controls, Partial Stage Caching & View Layer Switching**:
   - Toggling `#toggleInterRamps` triggers a partial worker rebuild that hits the Stage 1–8 cache (`#genTimeBadge` displays `Cached S1–S8`).
   - Switching `#terrainAlgoSelect`, `#hydrologyAlgoSelect`, `#archetypeSelect` (`island-hopper`), and `.layer-btn` (`aesthetic`, `rci`, `airport`, `hierarchy`, `hydrology`, `roadgrid`) updates `renderer.activeLayer` and re-renders `#worldCanvas` cleanly.
3. **Canvas Hit-Testing & Entity Inspector Dossier (`#inspectorCard`)**:
   - Invoking `window.openEntityInspector('airport', window.currentWorld.airports[0], true)` or clicking an airport/building/town on `#worldCanvas` opens `#inspectorCard`, populates `#inspTitle`, `#inspBadge`, `#inspCode`, and `#inspBody`, and clicking `[data-jump-town]` / `[data-jump-dest]` navigates across linked supply-chain entities; pressing `Escape` closes the dossier.

---

## 8. Phase 7 — GitHub Actions CI Pipeline (`.github/workflows/ci.yml`)

Create `.github/workflows/ci.yml` using `oven-sh/setup-bun@v2` and Playwright Chromium so every push and pull request runs formatting, linting, JSDoc typechecking, `bun test`, and real-browser Playwright E2E verification:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check-and-test:
    name: Format, Lint, Typecheck, Unit & Playwright E2E
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Check formatting (bun fmt)
        run: bun fmt --no-script --check src/ tests/ playwright.config.js index.html

      - name: Run linter (oxlint)
        run: bunx oxlint --deny-warnings src/ tests/

      - name: Run JSDoc typecheck (bun check)
        run: bun check --no-script

      - name: Run unit & worldgen invariant tests (bun test)
        run: bun test --check tests/unit

      - name: Install Playwright Chromium
        run: bunx playwright install --with-deps chromium

      - name: Run Playwright E2E browser tests
        run: bunx playwright test
```

---

## 9. Phase 8 — Update Documentation (`README.md` & `AGENTS.md`)

1. **`README.md`**:
   - Update **Quick Start** and add a **Verification & Testing** section documenting `bun run dev`, `bun fmt --check`, `bun lint`, `bun check --no-script`, `bun test tests/unit`, `bunx playwright test`, and `bun run check`.
   - Refresh all source-fragment links (`./src/...#L...`) so they point to the current line numbers after JSDoc annotations are added, and linkprose to [src/types.d.ts](./src/types.d.ts), [src/terrain-bake-worker.js](./src/terrain-bake-worker.js), and the 6th inspector layer (**Road Grid & Graph**).
2. **`AGENTS.md`**:
   - Refresh source-fragment line numbers across §2 and §3 to match the JSDoc-annotated modules.
   - Add the static verification & test gates (`bun fmt --check`, `bun lint --max-warnings 0`, `bun check --no-script`, `bun test --check tests/unit`, and `bunx playwright test`) to the development and verification workflow.

---

## 10. Phase 9 — Local Verification Gates

1. **Formatter Gate**: `bun fmt --no-script --check src/ tests/ playwright.config.js index.html` exits `0`.
2. **Linter Gate**: `bunx oxlint --deny-warnings src/ tests/` exits `0`.
3. **Typecheck Gate**: `bun check --no-script` exits `0` across all `.js` modules, `src/types.d.ts`, `playwright.config.js`, and `tests/`.
4. **Unit & Invariant Test Gate**: `bun test --check tests/unit` exits `0`.
5. **Playwright E2E Browser Gate**: `bunx playwright test` exits `0` against `http://127.0.0.1:8788/index.html`.