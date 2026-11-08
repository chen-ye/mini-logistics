# Fix Road Continuity, Octilinear Geometry, Bridge Parapets & Vehicle Pathing

## Steps
- [x] Enforce strict octilinear road simplification and prevent road-building intersections in `commitRoadPath`
- [x] Replace vertex-based road deduplication with edge-based deduplication and synchronize `roadGrid` with simplified polylines
- [x] Prevent mid-road severing under interchanges and outer streets via end-only street trimming and underpass A* rerouting
- [x] Render bridge guardrails as continuous smoothed spans matching `traceSmoothPath` corner geometry
- [x] Route freight trucks along committed `this.roads` edges and align vehicle corner interpolation with `traceSmoothPath`
- [x] Add a Road Grid & Graph Inspector Layer (`roadgrid`) to `index.html`, `src/main.js`, and `src/renderer.js`
- [x] Verify across benchmark seeds and review with parallel Targeted + Uncued Holistic subagents

## 1. Strict Octilinear Road Simplification & Building Clearance (`image-5.png`)

### Problem
In [`commitRoadPath()`](./src/world-generator.js#L1280-L1316), `simplifyRuralStaircase(pts)` sets `prev = out[out.length - 1]` (the already-simplified output vertex) and allows skipping `curr` whenever `Math.hypot(curr - prev) <= 1.5` and `Math.hypot(next - curr) <= 1.5`:
1. Because `1.5 >= Math.SQRT2`, combining a cardinal step (`1.0`) with a 45° diagonal step (`1.414`)—or skipping two consecutive orthogonal steps in a row—produces `(±2, ±1)` and `(±1, ±2)` **knight's-move chords** (`26.57°` / `63.43°`) that violate octilinear (`0°`/`45°`/`90°`) geometry.
2. Because [`carveTownStreetGrids()`](./src/world-generator.js#L1441-L1448) paints `zoneColorIdx` with elevation/noise jitter while [`placeTownCommercialAndIndustrial()`](./src/world-generator.js#L1678-L1744) places multi-tile buildings up to `R + 2.5` without checking `zoneColorIdx`, `simplifyRuralStaircase` can collapse corners inside a town's building envelope where `zoneColorIdx === -1`. Since `roadGrid` was only marked on the unsimplified orthogonal tiles, Stage 7 places `2×3` / `3×2` buildings right on top of the shortcut chord.

### Fix
- Restrict `simplifyRuralStaircase(pts)` in [`src/world-generator.js`](./src/world-generator.js#L1280-L1316) so a vertex `curr = pts[i]` can **only** be collapsed when:
  1. Both incoming and outgoing steps from the unsimplified neighbors are 1-tile **perpendicular cardinal** steps (`|dx1| + |dy1| === 1`, `|dx2| + |dy2| === 1`, and `dx1 * dx2 + dy1 * dy2 === 0`), guaranteeing that `next - prev` is strictly a 1-tile `45°` ordinal step (`|dx| === 1 && |dy| === 1`) and never chains into a `2:1` knight's move.
  2. `prev`, `curr`, and `next` all have `zoneColorIdx < 0`, `buildingMask === 0`, `roadGrid === 0` (never skip an existing junction tile), and lie outside every town's urban building envelope (`hypot(pt - town) > town.effectiveR + 3.5`).
  3. Both swept corner tiles `(prev.x, next.y)` and `(next.x, prev.y)` have `waterMask === 0` and `buildingMask === 0`.
- Also paint `zoneColorIdx[id] = town.colorIdx` under every placed Commercial/Industrial lot in [`commitLot()`](./src/world-generator.js#L1817-L1822) so no urban building lot sits on `zoneColorIdx === -1`.

---

## 2. Edge-Based Road Deduplication & `roadGrid` Synchronization (`image-2.png`, `image-3.png`)

### Problem
In [`commitRoadPath()`](./src/world-generator.js#L1256-L1346):
1. `this.roadGrid[id]` is populated from the **unsimplified** `path` before `simplifyRuralStaircase` strips vertices. Skipped vertices remain in `this.roadGrid` as **ghost road tiles** ~1 tile away from the rendered road polyline. Later calls to `findRoadPathAStar(..., stopOnExistingRoad = true)` or joining arterials terminate on those ghost tiles—stopping 1 tile short of the rendered road (`image-3.png`).
2. Sub-path splitting uses vertex occupancy (`isNewTile[i] = this.roadGrid[id] > 0 ? 0 : 1`). When a path steps directly between two adjacent tiles that **both** already have `roadGrid > 0` (e.g., stepping between two neighboring roads that lack a connecting edge), `isNewTile` is `0` on both vertices and `commitRoadPath` drops the connecting edge between them (`image-2.png`, `image-3.png`).

### Fix
- In [`commitRoadPath()`](./src/world-generator.js#L1251-L1347):
  1. Run `simplifyRuralStaircase(path)` **first**, before writing `this.roadGrid`, so `this.roadGrid` only marks vertices that actually exist on rendered road polylines (zero ghost road tiles).
  2. Maintain an undirected edge set (`this.roadEdges`) keyed by canonical tile-pair IDs `min(idA, idB) * totalTiles + max(idA, idB)` (also populated in [`carveStreetFromCenter()`](./src/world-generator.js#L1641-L1652)).
  3. Emit contiguous runs of **new edges** (`!this.hasRoadEdge(pts[i], pts[i + 1])`) rather than filtering by `isNewTile[i]`. Every new step between two existing roads is guaranteed to emit its connecting segment, while shared trunk edges are never double-drawn.

---

## 3. Continuous Through-Roads Under Interchanges & Safe Outer Street Trimming (`image-1.png`, `image-2.png`)

### Problem
1. In Stage 8, [`detectAndBuildCloverleafs()`](./src/world-generator.js#L3207) calls `displaceBuildingsInRadius(hit.x, hit.y, 5.2)`, clearing all buildings under the cloverleaf. In Stage 9, [`finalizeExpresswayRampsAndTunnels()`](./src/world-generator.js#L3914) calls [`pruneEmptyOuterStreets()`](./src/world-generator.js#L1527-L1568), which iterates over **all interior vertices** of every `'street'` and deletes any vertex with `roadGrid[id] < 2 && !hasNearbyBuilding(pt.x, pt.y)`—punching a ~4-tile hole right through the middle of any street passing under a cloverleaf (`image-1.png`) or severing an outer street between a tip house/connector and the town core (`image-2.png`).
2. [`pruneUnderpassRoadsAtRamp()`](./src/world-generator.js#L3280-L3325) is called on highway-to-highway Trumpet interchanges ([`lines 3704, 3791, 3900`](./src/world-generator.js#L3704)) and intermediate Diamond slip-ramps ([`line 3430`](./src/world-generator.js#L3430)), deleting vertices inside the ramp box from both `'arterial'` and `'street'` roads without rerouting the severed ends.

### Fix
- **End-only trimming in [`pruneEmptyOuterStreets()`](./src/world-generator.js#L1527-L1568)**:
  - Never delete interior vertices from the middle of a street. For each `'street'` polyline, find the first and last **anchored** vertex (`firstKeep .. lastKeep`), where a vertex is anchored if `roadGrid[id] >= 2`, `hasNearbyBuilding(pt.x, pt.y)`, it is within `6.5` tiles of any interchange in `this.interchanges`, or it intersects another active road at an interior junction.
  - Trim only unanchored dead-end prefixes (`0 .. firstKeep - 1`) and suffixes (`lastKeep + 1 .. len - 1`), keeping the entire span `pts.slice(firstKeep, lastKeep + 1)` continuous, then rebuild `roadGrid` and `roadEdges` from the surviving `this.roads`.
- **When `stopOnExistingRoad = true` connects an airport, terminal stub, or slip-ramp to a town street**:
  - Upgrade the connected street path from the contact tile into the town's arterial core to `roadGrid = 2` (or require `stopOnExistingRoad` to reach a main connected street/arterial) so the connector is permanently anchored.
- **Stop severing through-roads at interchanges ([`pruneUnderpassRoadsAtRamp()`](./src/world-generator.js#L3280-L3325))**:
  - Remove the `pruneUnderpassRoadsAtRamp()` calls on grade-separated Trumpet overpasses ([`lines 3704, 3791, 3900`](./src/world-generator.js#L3704)), which have no surface roundabout and pass over surface roads on elevated decks just like Cloverleafs.
  - For surface `diamond-ramp` roundabouts ([`buildIntermediateExpresswayRamps()`](./src/world-generator.js#L3423-L3452)), if a road passes through the slip-ramp footprint between an entry vertex `pEntry` and exit vertex `pExit`, reroute the severed span around the ramp footprint (or through the roundabout terminal `(startX, startY)`) via `findRoadPathAStar`; if no clean reroute exists, skip that candidate slip-ramp site instead of leaving a broken arterial.

---

## 4. Seamless Bridge Guardrail Casings on Curved Bends (`image-4.png`)

### Problem
In [`src/renderer.js`](./src/renderer.js#L800-L815), Pass 2 (`PALETTE.bridgeRail`) loops over individual edges `i -> i + 1` and calls `ctx.moveTo(p[i])` + `ctx.lineTo(p[i + 1])` with `ctx.lineCap = 'butt'`. Consecutive bridge segments are drawn as disconnected butt-capped rectangles with straight vertices, whereas Pass 1 (`roadCasing`) and Pass 3 (`roadAsphalt`) use [`traceSmoothPath()`](./src/renderer.js#L903-L936) with quadratic Bezier corner fillets (`rCorner = 0.24`). At any bridge bend, the disconnected butt caps open a wedge gap on the outside of the turn exposing the grey `roadCasing` underneath.

### Fix
- In [`drawRoads()` Pass 2](./src/renderer.js#L800-L815):
  - Group contiguous bridge edges (`r.points[i].isBridge || r.points[i + 1].isBridge`) into continuous vertex spans along `r.points`.
  - Trace each continuous bridge span using the exact same quadratic-Bezier corner rounding as `traceSmoothPath()` (computing corner fillets from the parent road's `pPrev, pCurr, pNext` context) with `ctx.lineJoin = 'round'` and `ctx.lineCap = 'butt'` at the shoreline start/end points.

---

## 5. Exact Road-Edge Freight Routing & Smooth Corner Vehicle Tracking (`image-5.png`)

### Problem
1. In [`buildIndustrialCargoChain()`](./src/world-generator.js#L2044-L2060), freight links run `findRoadPathAStar` with `blockedFn: (nx, ny) => this.roadGrid[this.idx(nx, ny)] === 0`. Because `findRoadPathAStar` checks tile occupancy (`roadGrid > 0`) rather than road edges, whenever `zoneColorIdx < 0` at an orthogonal street corner `(x, y+1) -> (x, y) -> (x+1, y)`, A* steps diagonally at `45°` directly from `(x, y+1)` to `(x+1, y)` across the building lot/corner where no road edge exists.
2. In [`src/simulator.js`](./src/simulator.js#L134-L146) and [`src/renderer.js`](./src/renderer.js#L2022-L2029), vehicles advance `segT` without normalizing by segment length `hypot(p1 - p0)` and linearly interpolate straight between `pts[segIdx]` and `pts[segIdx + 1]` instead of following the `traceSmoothPath` quadratic corner curve.

### Fix
- In [`buildIndustrialCargoChain()`](./src/world-generator.js#L2044-L2060), restrict freight A* transitions so every step `(cx, cy) -> (nx, ny)` must traverse an actual committed road edge in `this.roadEdges` (`!this.hasRoadEdge(cx, cy, nx, ny)`). Freight trucks will only ever travel along rendered road segments.
- In [`src/simulator.js`](./src/simulator.js#L134-L146), normalize `segT` progression by segment length `Math.hypot(p1.x - p0.x, p1.y - p0.y)`.
- In [`drawCars()`](./src/renderer.js#L2022-L2029), evaluate the same `rCorner = Math.min(0.24, len1 * 0.45, len2 * 0.45)` quadratic Bezier corner fillet and tangent angle near interior vertices so cars and semi-trucks track the exact centerline of the rendered asphalt around bends.

---

## 6. Road Grid & Graph Inspector Layer (`roadgrid`)

### Goal
Provide a dedicated **Road Grid & Graph** inspector mode (`activeLayer === 'roadgrid'`) to make spatial tile occupancy (`world.roadGrid` & `world.buildingMask`), vector road polylines (`world.roads`), vertex degree/junctions, and any grid-vs-graph discrepancies immediately visible in-app.

### Implementation
- **UI Controls ([`index.html:69-90`](./index.html#L69-L90), [`src/main.js:502-508`](./src/main.js#L502-L508))**:
  - Add a 6th inspector button `data-layer="roadgrid"` (`Road Grid & Graph`) in the 2-column inspector grid (balancing the 6 buttons into a clean `3 × 2` grid) and register `roadgrid: 'Road Grid & Vector Graph'` in `layerBadges`.
- **Underlay — Spatial Tile Occupancy (`drawRoadGridUnderlay(ctx, world, ts)` in [`src/renderer.js`](./src/renderer.js#L512-L520))**:
  - Render crisp tile-grid cells for all `world.roadGrid` values (`1 = street` in slate/sky blue, `2 = arterial` in amber/orange, `3 = bridge` in cyan/teal, `4 = airport-loop` in violet) and subtle footprint outlines for `world.buildingMask` (`1 = house`, `2 = destination`, `3 = airport`, `4 = interchange reserve`).
- **Overlay — Vector Polyline Graph & Topology Diagnostics (`drawRoadGridGraphOverlay(ctx, world, ts)` in [`src/renderer.js`](./src/renderer.js#L541-L547))**:
  - Render directed/undirected vector segments from `world.roads`, driveway connectors (`lotX, lotY -> roadX, roadY`), and color-coded vertex nodes by graph degree (`deg 1` terminal, `deg 2` through-vertex, `deg >= 3` intersection/junction).
  - Automatically highlight any topological/geometric invariant violation (orphan `roadGrid > 0` tile without a road vertex, non-octilinear segment, or unanchored arterial dead-end) with a high-contrast diagnostic callout ring.
- **HUD Legend (`drawRoadGridScreenLegend(ctx, world, canvas)` in [`src/renderer.js`](./src/renderer.js#L568-L570))**:
  - Render a bottom HUD summary bar reporting counts of Street tiles, Arterial tiles, Bridge tiles, Vector Edges, Junctions (`deg >= 3`), and Invariant Anomalies.

---

## 7. Verification & Dual-Subagent Visual Audit
- Reload the app in a headless browser at `http://127.0.0.1:8788/index.html` so the Web Worker loads updated ES modules.
- Run a deterministic invariant check script scanning generated worlds across benchmark seeds (`OTTD-METRO-84`, `DELTA-402`, `HARBOR-305`, `VALLEY-618`, `ISLAND-HOP-101`, `ARCHIPELAGO-77`, `AEGEAN-420`, `ATOLL-808`) and all `3 × 3` Terrain × Hydrology combinations to assert:
  - Zero non-octilinear road segments (`dx !== 0 && dy !== 0 && |dx| !== |dy|`),
  - Zero road segments intersecting `buildingMask === 1 || 2` lots,
  - Zero severed underpass roads at Cloverleaf, Trumpet, or Diamond interchanges,
  - Zero ghost `roadGrid` tiles lacking a matching vertex in `this.roads`,
  - Zero `cargoLinks` steps lacking a matching edge in `this.roads`.
- Capture `1600×1000` and `390×844` screenshots (including the new **Road Grid & Graph** inspector view) and run parallel **Targeted** + **Uncued Holistic Rubric** review subagents.