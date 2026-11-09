# VectorLayerRecorder Display-List Renderer & 60fps Farm/Terrain Optimization Plan

## Steps

- [x] Phase 1: Create `src/canvas-layer-cache.js` (`VectorLayerRecorder` built on `Path2D.prototype.addPath(subPath, domMatrix)`) and fix the 4 `drawFarmBackgroundFields` bottlenecks (global `arableFillPath` clip, single `arableStrokePath` stroke, `&& -> ||` corridor culling via `d.estateBBox`, and batched orchard/windbreak `Path2D`s)
- [x] Phase 2: Empirical A/B Benchmark Gate (Terrain `ImageBitmap` vs. Pure `Path2D` Display Lists) — measure cold build time, 60fps steady-state frame time, and continuous pan/zoom `p50`/`p95` frame time on `standard` (360×224) and `huge` (720×448) maps; only remove `terrain-bake-worker.js` / `offscreenTerrain` if pure `Path2D` replay matches or beats `ImageBitmap` on `huge` pan/zoom
- [x] Phase 3: Record `surfaceNetworkDisplayList` (keyed on `(world, activeLayer)`: airport ground pads, unified road casings/fills, bridge guardrails, roundabouts, color-batched houses, and RCI/airport structures)
- [x] Phase 4: Record `motorwayDisplayList` (keyed on `world`: cloverleaf/trumpet/diamond underlay, precomputed motorway `surfaceSpans`, tunnel bores, overpass bridges, and precomputed `shieldPt` badges)
- [x] Phase 5: Cache the screen-space vignette `CanvasGradient`, eliminate per-frame `.filter()` / DOM queries in `drawRCIScreenLegend`, and add `estateBBox` fast-rejection + cursor-change guarding in `pointermove` hit-testing
- [x] Phase 6: Update documentation (`README.md` & `AGENTS.md`), record longitudinal 60fps frame-time deltas in `benchmarks/`, and pass all `bun fmt`, `bun lint`, `bun check`, `bun test`, and Playwright E2E gates

## 1. Prerequisites & Architectural Goals

This plan assumes **Plan 1** (Linting, JSDoc Typechecking, Unit + Playwright E2E, CI) and **Plan 2** (`src/constants.js`, `FlatMinHeap`, reactive `roadTopology` & `vehicleRoutingGraph`, `src/state.js`, and Stage 5–9 solver decomposition) are in place.

### Core Principle: Benchmark Before Committing to Deleting `offscreenTerrain`
- On `huge` (`720×448`) maps with ~6,000+ woodland trees, 3 Marching-Squares contour terraces, and sprawling farm estates, re-rasterizing complex `Path2D`s on every camera pan/zoom frame in Skia may have different GPU/CPU trade-offs than blitting a pre-rasterized `ImageBitmap` (`ctx.drawImage(offscreenTerrain, 0, 0)`).
- Therefore, **Phase 1 & Phase 2** first fix the farm rendering bottlenecks and run a head-to-head Playwright/Canvas benchmark comparing:
  - **Candidate A (Hybrid Raster Base + Vector Overlay)**: Bake `drawFarmBackgroundFields` into `offscreenTerrain` (`TerrainBitmapBaker` `ImageBitmap`) and use `VectorLayerRecorder` for roads, houses, buildings, airports, and motorways.
  - **Candidate B (100% Vector `Path2D` Display Lists)**: Replace `offscreenTerrain` and `terrain-bake-worker.js` with `hydroDisplayList` + `urbanTerrainDisplayList`.
- We commit to Candidate B (deleting `terrain-bake-worker.js`) **only** if Candidate B's `p50`/`p95` frame time during active pan/zoom on `huge` (`720×448`) maps matches or beats Candidate A (`p95 <= 4.0 ms`).

---

## 2. Phase 1 — Declarative `VectorLayerRecorder` (`src/canvas-layer-cache.js`) & Farm Vector Cleanup

1. **Implement `VectorLayerRecorder` (~85 Lines, Zero Dependencies)**:
   - Tracks a `DOMMatrix` transform stack (`save()`, `restore()`, `translate()`, `rotate()`, `scale()`) and active style state (`fillStyle`, `strokeStyle`, `lineWidth`, `lineCap`, `lineJoin`, `setLineDash()`).
   - Uses `Path2D.prototype.addPath(this._subPath, this._matrix)` to merge every `fill()`, `stroke()`, `fillRect()`, and `strokeRect()` within the current z-pass into a single C++ `Path2D` bucket per unique style key.
   - Provides `nextLayerPass()` to insert an explicit z-barrier whenever painter's order requires strict layering, and `replay(ctx)` to execute all coalesced `Path2D` commands.
2. **Fix the 4 Vector Bottlenecks in `drawFarmBackgroundFields` (`src/renderer.js` lines 872–1145)**:
   - Eliminate per-farm 4-deep `ctx.clip(arableFillPath)` and per-farm full-map `ctx.stroke(arableStrokePath)` thrashing by clipping once across the union of farm estates (or pre-clipping farm parcel/furrow geometry to each farm's arable tiles `p.tiles` / `d.estateLoops`).
   - Fix the boolean `&&` bug in `strokeNearbyCorridors` (line 1064: change `&&` $\rightarrow$ `||` using `d.estateBBox`) so only roads and motorways intersecting a farm's bounding box are stroked.
   - Coalesce all orchard dots and `windbreakPts` by color into single `Path2D` passes instead of hundreds of per-dot `beginPath() + arc() + fill()` calls.

---

## 3. Phase 2 — Empirical A/B Benchmark Gate: `offscreenTerrain` (`ImageBitmap`) vs. Pure `Path2D` (`hydroDisplayList` + `urbanTerrainDisplayList`)

### Benchmark Protocol (Measured in Real Chromium via Playwright + `scripts/bench.js`)
Compare **Baseline (Current)** vs. **Candidate A (Farms Baked into `offscreenTerrain` `ImageBitmap`)** vs. **Candidate B (Pure `Path2D` `hydroDisplayList` + `urbanTerrainDisplayList`, No `ImageBitmap`)** across `standard` (`360×224`) and `huge` (`720×448`) maps:
1. **World Build + Bake / Record Time (`ms`)**: Wall-clock time from config change to first rendered frame.
2. **Steady-State 60fps Traffic Frame Time (`p50` / `p95` ms)**: 300 frames at `1.0x` and `2.5x` zoom with farms onscreen.
3. **Continuous Camera Pan + Zoom Sweep (`p50` / `p95` ms)**: 300 frames sweeping zoom `0.25x -> 3.5x -> 0.25x` while panning across dense urban + farm + forest regions (stress-testing Skia's `Path2D` tessellation cache vs. `drawImage(ImageBitmap)`).

### Decision Rule
- **If Candidate B (`Path2D`-only) achieves `p95 <= 4.0 ms` on `huge` pan/zoom and matches/beats Candidate A**: Delete `src/terrain-bake-worker.js`, `MessageChannel`, and `offscreenTerrain`, keeping the 100% vector display-list pipeline.
- **If Candidate A (`ImageBitmap` base terrain + baked farms) is significantly faster during `huge` pan/zoom**: Keep `TerrainBitmapBaker` (`offscreenTerrain` with `drawFarmBackgroundFields` baked into `composeTerrainBitmap` so farm per-frame cost is `0.0 ms`), and use `VectorLayerRecorder` for Phases 3 & 4 (`surfaceNetworkDisplayList` and `motorwayDisplayList`).

---

## 4. Phase 3 — Record `surfaceNetworkDisplayList` (`drawAirportGroundPads` + `drawRoadNetwork` + `drawBuildings` + `drawAirports`)

Record into a `VectorLayerRecorder` cached on `(world, activeLayer, tileSize)` with `nextLayerPass()` z-barriers between painter's-order stages:
1. **Airport Ground Apron Pads & Landside Islands** (`drawAirportGroundPads`).
2. **Unified Surface Road Network (`drawRoadNetwork`)**:
   - Pass 1: All driveway, street, arterial, airport loop, roundabout, and diamond slip-ramp casings (`~4` coalesced `stroke` `Path2D`s instead of ~450).
   - Pass 2: Continuous bridge guardrails (`1` coalesced `stroke` `Path2D`).
   - Pass 3: All slip-ramp, driveway, street, arterial, airport loop, and roundabout asphalt fills (`~4` coalesced `stroke` `Path2D`s instead of ~450).
   - Pass 4: Roundabout central landscaped islands (`3` coalesced `fill`/`stroke` `Path2D`s).
3. **Houses & Commercial/Industrial Buildings (`drawBuildings`)**:
   - All ~1,000 residential house drop shadows coalesce into **1 `Path2D`**, all house bases into **7 `Path2D`s** (by district color), and all house roofs into **7 `Path2D`s** (reducing ~3,000 per-frame house draw calls to 15!).
   - Multi-part Commercial/Industrial `destinations` and `drawAirports` record into the same display list via `rec.translate()` / `rec.rotate()` (`DOMMatrix`), with text badges (`IATA` pills and `RCI` stage pills) stored in a lightweight text-command array replayed with camera frustum culling.

---

## 5. Phase 4 — Record `motorwayDisplayList` (`drawInterchangesUnderlay` + `drawMotorways`)

Record into a `VectorLayerRecorder` cached on `(world, tileSize)`:
- Precompute `mw.surfaceSpans` and `mw.shieldPt` once when Stage 9 finalizes motorways (eliminating per-frame sample slicing and the $O(\text{samples} \times \text{interchanges})$ shield search).
- Record cloverleaf/trumpet/diamond ramp underlays, elevated motorway drop shadows, dashed subterranean mountain tunnel bores, pink motorway outer casings/decks/medians, tunnel portal mouths, grade-separated overpass bridge decks, and highway shield backgrounds into `motorwayDisplayList` (~18 `Path2D` commands total).

---

## 6. Phase 5 — Screen-Space Gradient Cache, Zero-Alloc Legends & Fast Pointer Hit-Testing

1. **Cache Screen-Space Vignette Gradient (`src/renderer.js` lines 773–784)**:
   - Cache `this._vignetteGrad` keyed on `(canvas.width, canvas.height)` instead of calling `ctx.createRadialGradient()` + `addColorStop()` on every 60fps frame.
2. **Zero-Alloc `drawRCIScreenLegend` & State-Driven Safe Insets (`src/renderer.js` lines 793–870, 3151–3196)**:
   - Precompute `world.rciCounts = { com, raw, mfg, log }` once at world build time instead of running 4 `world.destinations.filter(...)` passes per frame.
   - Read drawer/inspector open state from `src/state.js` instead of querying `document.getElementById(...).classList.contains('hidden')` inside the 60fps canvas render loop.
3. **Fast Bounding-Box Pre-Check & Cursor Guard in `pointermove` (`src/main.js` lines 588–646, 703–711)**:
   - Store `d.estateBBox = { minX, minY, maxX, maxY }` on each `FARM` destination so `findEntityAtWorldPos(wx, wy)` rejects far-away farms in $O(1)$ before scanning `d.bspParcels`.
   - Track `lastCursor` in `main.js` and only assign `canvas.style.cursor = nextCursor` when `nextCursor !== lastCursor`.

---

## 7. Phase 6 — Documentation, Frame-Time Benchmarks & Verification Gate

1. **Extend `scripts/bench.js`**:
   - Add a `renderFrame` benchmark measuring display-list recording time (`ms`) and 60fps `MiniMotorwaysRenderer.prototype.render(world, sim)` replay time (`p50` / `p95` ms per frame on `standard` and `huge` maps with farms onscreen) and record the longitudinal delta in `benchmarks/history.jsonl`.
2. **Update Documentation (`README.md` & `AGENTS.md`)**:
   - Replace references to `terrain-bake-worker.js` and `offscreenTerrain` with `src/canvas-layer-cache.js` (`VectorLayerRecorder`) and the 4 retained `Path2D` display lists (`hydroDisplayList`, `urbanTerrainDisplayList`, `surfaceNetworkDisplayList`, `motorwayDisplayList`).
3. **Verification Gate**:
   - Pass `bun fmt --check`, `bun lint`, `bun check --no-script`, `bun test --check tests/unit`, and `bunx playwright test` (verifying 100% visual parity across `aesthetic`, `rci`, and `roadgrid` views at both `1x` and `3.5x` zoom).