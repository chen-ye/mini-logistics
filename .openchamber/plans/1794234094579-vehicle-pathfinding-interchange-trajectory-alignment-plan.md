# Vehicle Pathfinding & Interchange Trajectory Alignment Plan

## Steps

- [x] Step 1: Eliminate synthetic off-road proximity jumps at roundabouts and diamond underpasses in `src/vehicle-routing.js` (`connectToNearbySurfaceNodes`, `!mw.prunedStart`/`!mw.prunedEnd` guards, and removal of `underpassMidNode`)
- [x] Step 2: Model geometry-accurate Cloverleaf and Trumpet ramp trajectories in `ensureVehicleRoutingGraph` and `buildDirectedLaneTrajectory` (`src/vehicle-routing.js`), preventing highway U-turns and grass-cutting shortcut chords
- [x] Step 3: Rebind or displace orphaned building frontages after Stage 9 `pruneEmptyOuterStreets` in `src/expressway-solver.js` and tighten `findNearestSurfaceNode` in `src/vehicle-routing.js`
- [x] Step 4: Add automated trajectory-on-pavement invariants in `tests/unit/simulator.test.js` and `tests/unit/world-invariants.test.js` and verify in headless Chromium across benchmark seeds

---

## 1. Problem Summary

Although Stage 1 of [`ensureVehicleRoutingGraph`](./src/vehicle-routing.js#L225-L243) populates surface road nodes strictly from committed `world.roads` segments, four downstream graph-construction shortcuts in [`src/vehicle-routing.js`](./src/vehicle-routing.js#L248-L697) and [`src/expressway-solver.js`](./src/expressway-solver.js#L16-L19) cause vehicles to drive across empty grass or cut across interchange quadrants:

1. **Radial Proximity "Air-Jump" Edges (`connectToNearbySurfaceNodes`, lines 248–271, 308, 313, 340–341)**:
   - `connectToNearbySurfaceNodes(portalNode, px, py, 2.4)` connects a terminal roundabout portal to **every** surface road tile within `d <= 2.4` tiles—including unconnected streets `2.0–2.24` tiles away (such as `(-1, -2)` knight's-move jumps from `(299, 56) -> (298, 54)` and `(189, 125) -> (190, 123)` in `OTTD-METRO-84` where `world.hasRoadEdge(...) === false`).
   - At `diamond-ramp` interchanges (lines 329–341), `underpassMidNode` adds a floating-point shortcut `posNode -> (ic.x, ic.y) -> negNode` with a `0.92x` cost discount that pulls through-traffic off the integer underpass road, while `connectToNearbySurfaceNodes(negNode, negX, negY, 1.6)` links dead-end Diamond-T turnaround roundabouts across empty space to adjacent streets.
2. **Unchecked `mw.prunedStart` / `mw.prunedEnd` Motorway Portals (lines 305–314)**:
   - `ensureVehicleRoutingGraph` creates surface roundabout portals at `(mw.sx, mw.sy)` and `(mw.ex, mw.ey)` without checking `!mw.prunedStart` or `!mw.prunedEnd`. On 3-way Trumpet spurs (`prunedEnd: true`) and pruned Cloverleaf arms, this connects the elevated highway junction directly to any ground street passing within `2.4` tiles of the overpass.
3. **Cloverleaf & Trumpet `xferNode` Shortcut Chords & Highway U-Turns (lines 384–401)**:
   - Instead of following the rendered outer quadratic slip-ramps or inner 270° loop ramps, `ensureVehicleRoutingGraph` creates a single point `xferNode(ic.x, ic.y)` and links it via undirected `addBiEdge` to the nearest motorway sample `bestK` within `6.5` tiles.
   - Because motorway samples are spaced `~2.5–4.0` tiles apart, transferring vehicles cut straight diagonal chords (`sampleA -> ic -> sampleB`) across the grass quadrants, and undirected edges to both `mNodesFwd[bestK]` and `mNodesRev[bestK]` on the same motorway allow illegal 180° U-turns on divided expressways.
4. **Post-Pruning Orphaned Frontages & `[-3..3]` Surface Node Fallback (lines 499–524, 619–631, 688–697)**:
   - [`applyRightOfWayClearance`](./src/expressway-solver.js#L16-L19) runs `pruneEmptyOuterStreets(world)` in Stage 9 without running `rebindOrDisplaceOrphanedFrontage(world)` afterward. Any building whose street was trimmed falls back to `findNearestSurfaceNode`'s `[-3..3]` search window (up to `4.24` tiles away) and interpolates a straight driveway across empty land.

---

## 2. Step-by-Step Design

### Step 1 — Eliminate Synthetic Off-Road Proximity Jumps at Roundabouts & Diamond Underpasses (`src/vehicle-routing.js`)

1. **Guard Terminal Motorway Portals by `!mw.prunedStart` and `!mw.prunedEnd`**:
   - In [`ensureVehicleRoutingGraph`](./src/vehicle-routing.js#L304-L314), only create `startPortal` when `!mw.prunedStart`, and only create `endPortal` when `!mw.prunedEnd`.
2. **Replace Radial `connectToNearbySurfaceNodes(..., 2.4)` with Exact Topological Roundabout Binding**:
   - At a non-pruned terminal roundabout `(rx, ry)` (`gx0 = Math.round(rx), gy0 = Math.round(ry)`), connect the portal strictly to `ensureSurfaceNode(gx0, gy0)` (the exact integer tile where the airport spine or town terminal stub was committed in `world.roads`), plus any 8-neighbor tile `(|dx| <= 1, |dy| <= 1)` that shares a committed road edge `world.hasRoadEdge(gx0, gy0, gx0 + dx, gy0 + dy)`.
   - Never jump across `d > 1.42` tiles or to tiles lacking a committed road edge into the roundabout.
3. **Remove `underpassMidNode` and Proximity Jumps at Diamond Interchanges (`ic.type === "diamond-ramp"`)**:
   - In [`ensureVehicleRoutingGraph`](./src/vehicle-routing.js#L318-L342), both new underpass stems (`commitRoadPath(stemPts, "arterial")`) and existing octilinear underpasses (`existingUnderpass`) are already committed in `world.roads`, so `posNode = ensureSurfaceNode(posX, posY)` and `negNode = ensureSurfaceNode(negX, negY)` are already connected along the exact integer underpass tiles.
   - Delete `underpassMidNode` and delete the `connectToNearbySurfaceNodes(posNode, ...)` / `connectToNearbySurfaceNodes(negNode, ...)` calls so underpass traffic stays 100% on the octilinear underpass road and dead-end Diamond-T turnarounds never leak across empty space to neighboring streets.

---

### Step 2 — Geometry-Accurate Cloverleaf & Trumpet Interchange Ramp Routing (`src/vehicle-routing.js`)

Replace the single-point `xferNode(ic.x, ic.y)` block ([lines 384–401](./src/vehicle-routing.js#L384-L401)) with directed ramp chains that match the exact Bezier curves drawn in [`drawInterchangesUnderlay`](./src/renderer.js#L2062-L2233):

1. **Motorway Sample Anchoring Helper (`findSampleAtOffset`)**:
   - For a motorway `mw` passing through `(ic.x, ic.y)`, find the closest crossing index `kCross` and helper `findSampleNear(mw, targetX, targetY)` so ramps attach at the motorway samples nearest to the physical ramp mouths rather than jumping from `kCross` across empty grass.
2. **4-Way Cloverleaf Directed Ramp Chains (`ic.type === "cloverleaf"`)**:
   - Let `uA = (cos(ic.angleA), sin(ic.angleA))` (along `mwayA`'s `+k` forward direction) and `uB = (cos(ic.angleB), sin(ic.angleB))` (along `mwayB`'s `+k` forward direction).
   - In screen coordinates (`+y` down), right-hand travel along direction `u = (ux, uy)` sits on the right-hand normal `nR = (-uy, ux)`.
   - For each active quadrant `(sA, sB)` (`sA ∈ ic.activeSignsA`, `sB ∈ ic.activeSignsB`):
     - Determine the 2D cross product `crossAB = (sA * uAx) * (sB * uBy) - (sA * uAy) * (sB * uBx)`:
       - **Outer Concave Right-Turn Slip-Ramp** (`outerDist = 2.95`, `outerCtrl = 1.05`):
         - Sample 3 intermediate ramp nodes (`t ∈ [0.25, 0.5, 0.75]`, `onMotorway: true, isSlipRamp: true`) along the quadratic Bezier from `P0 = ic + sA * uA * outerDist` through `P1 = ic + (sA * uA + sB * uB) * outerCtrl` to `P2 = ic + sB * uB * outerDist`.
         - Connect the directed carriageway approaching `P0` on the right-hand side to the directed carriageway departing `P2` on the right-hand side (1-way directed chain, preventing U-turns).
       - **Inner 270° Cloverleaf Loop Ramp** (`leafSpan = 3.1`):
         - Sample 5 intermediate ramp nodes (`t ∈ [0.16, 0.33, 0.5, 0.67, 0.84]`, `onMotorway: true, isSlipRamp: true`) along the cubic Bezier `B(t)` with `P0 = ic`, `P1 = ic + sA * uA * leafSpan`, `P2 = ic + sB * uB * leafSpan`, `P3 = ic`.
         - Connect the directed carriageway of `mwayA` / `mwayB` entering the loop at `ic` around the 270° leaf to the perpendicular motorway's departing carriageway at `ic`.
3. **3-Way Trumpet Directed Ramp Chains (`ic.type === "trumpet"`)**:
   - Use the local Trumpet frame centered at `(ic.x, ic.y)` rotated by `ic.angleMain` with `sy = ic.sideSign || 1` and `oppSy = -sy` (matching [`drawInterchangesUnderlay` lines 2175–2218](./src/renderer.js#L2175-L2218)):
     - **Outer Concave Slip-Ramp** in the `(-1, +sy)` quadrant: quadratic Bezier between mainline `(-2.15, 0)` and spur `(0, sy * 2.15)` via control point `(-0.72, sy * 0.72)`, sampled at `t ∈ [0.25, 0.5, 0.75]` (`onMotorway: true, isSlipRamp: true`).
     - **Inner 270° Trumpet Bell Loop** in the `(+1, -sy)` opposite quadrant: two-segment cubic Bezier between `(0, 0)` (spur overpass) and `(0.52, 0)` (mainline merge) through `(0, oppSy * 1.35)`, `(0.38, oppSy * 1.85)`, `(1.02, oppSy * 1.85)` and `(1.92, oppSy * 1.85)`, `(1.92, 0)`, `(0.52, 0)`, sampled at 6 intermediate points (`onMotorway: true, isSlipRamp: true`).
   - Connect the terminating spur's inbound and outbound carriageways (`mwaySpur`) through the two ramps into the two mainline carriageways (`mwayMain`) so vehicles never make 180° U-turns or cut across grass.
4. **Smooth Trajectory Filleting & Lane Offset on Interchange Ramps (`buildDirectedLaneTrajectory`)**:
   - In [`buildDirectedLaneTrajectory`](./src/vehicle-routing.js#L746-L778), allow light corner filleting at transitions into/out of `isSlipRamp` nodes and keep `laneOffsetSlipRamp = 0.04` so cars track the center of the pink ramp ribbons smoothly.

---

### Step 3 — Post-Pruning Frontage Rebinding & Strict Surface Node Lookup (`src/expressway-solver.js`, `src/vehicle-routing.js`)

1. **Run `rebindOrDisplaceOrphanedFrontage` After Stage 9 Street Pruning**:
   - In [`applyRightOfWayClearance`](./src/expressway-solver.js#L16-L19), call `world.rebindOrDisplaceOrphanedFrontage()` immediately after `world.pruneEmptyOuterStreets()` so any house or destination whose street was removed during final outer-street/island pruning is rebound to a valid adjacent road tile (`roadGrid > 0`) or displaced.
2. **Tighten `findNearestSurfaceNode` Search Radius**:
   - In [`findNearestSurfaceNode`](./src/vehicle-routing.js#L499-L524), restrict the fallback neighborhood search from `[-3..3]` (`4.24` tiles) to `[-1..1]` (`<= 1.42` tiles) so a route never jumps across empty lots to a street 3 tiles away.

---

### Step 4 — Automated Trajectory-on-Pavement Invariants & Visual Verification (`tests/unit/simulator.test.js`, `tests/unit/world-invariants.test.js`)

1. **Zero Non-Road Surface Steps Invariant**:
   - In `tests/unit/world-invariants.test.js`, assert across all 5 benchmark seeds (`OTTD-METRO-84`, `DELTA-402`, `HARBOR-305`, `VALLEY-618`, `ISLAND-HOP-101`) that every surface-to-surface step `(!a.onMotorway && !b.onMotorway)` in `world.cargoLinks` satisfies `world.hasRoadEdge(Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y)) === true` (or lies on a registered roundabout ring).
2. **Full Trajectory Pavement Coverage Invariant**:
   - In `tests/unit/simulator.test.js`, verify that every sampled segment midpoint along every `outboundTrack` and `inboundTrack` in `world.cargoLinks` and `world.commuterRoutes` lies within `<= 0.55` tiles of a rendered road, driveway, roundabout ring, motorway carriageway, or interchange ramp Bezier curve, and that no trajectory makes an illegal 180° U-turn on a motorway.
3. **Real-Browser Playwright Verification**:
   - Run `bun run check` and inspect close-up screenshots of Cloverleaf, Trumpet, Diamond, and Roundabout traffic in headless Chromium.