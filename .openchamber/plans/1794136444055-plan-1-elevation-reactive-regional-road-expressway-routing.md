# Plan 1: Elevation-Reactive Regional Road & Expressway Routing

## Steps
- [ ] Penalize uphill and downhill grade nonlinearly in `findRoadPathAStar` and add a contour-bench discount
- [ ] Lower rural turn penalty in `findRoadPathAStar` with anti-zigzag hysteresis so roads curve around hills without staircasing
- [ ] Remove synthetic sine-wave displacement in `findValleyMotorwayWaypoints` and add directional grade cost to coarse valley A*
- [ ] Route Cloverleaf `forcedViaPt` trunks (`M-2`) and Trumpet spurs (`tryBuildTrumpetSpurToTrunk`) through `findValleyMotorwayWaypoints`
- [ ] Penalize long continuous mountain tunnel spans in `scoreMotorwaySamples` so expressways prefer valley passes over 80-tile diagonal bores
- [ ] Verify across benchmark seeds (`HARBOR-305`, `DELTA-402`, `VALLEY-618`, `OTTD-METRO-84`) and review with parallel Targeted + Uncued Holistic subagents

## 1. Grade-Squared Contour-Hugging Regional Road A* (`findRoadPathAStar`)

### Problem
In [`findRoadPathAStar()`](./src/world-generator.js#L1383-L1407), the elevation/grade penalty is `slopeField * 3.8 + max(0, dElev) * 16.0 + max(0, elev - seaLevel - 0.14) * 2.2`, while the rural direction-change penalty is `+2.4` per bend:
1. Across a typical 20-tile hill (`Δelev = 0.20`, `dElev = 0.01/tile`), climbing straight over the hill adds only `~0.46/tile` (`+9.2` total)—whereas detouring 6 tiles around the base of the hill with 2 octilinear bends costs `6.0 + 2 × 2.4 = +10.8`.
2. `dElev = Math.max(0, elev[nid] - elev[cid])` only penalizes uphill steps and gives zero penalty to steep downhill plunges, so A* shoots dead-straight horizontal or 45° diagonal ruler lines right across the `+0.13` and `+0.24` contour terraces (visible in `DELTA-402` and `HARBOR-305`).

### Fix
- In [`findRoadPathAStar()`](./src/world-generator.js#L1383-L1407):
  1. Compute symmetric step grade `absDeltaElev = Math.abs(this.elevationField[nid] - this.elevationField[cid]) / baseStep`.
  2. Apply a nonlinear grade + terrace elevation cost:
     `gradeCost = absDeltaElev * 45.0 + (absDeltaElev * absDeltaElev) * 980.0 + this.slopeField[nid] * 14.0 + hAbove * 14.0 + (hAbove * hAbove) * 48.0`.
  3. Apply a **contour-bench discount** (`stepCost *= 0.88`) when `absDeltaElev < 0.0035` on dry land above sea level so roads naturally contour parallel to hillside terraces and follow incised river valley benches.
  4. Reduce the rural turn penalty from `2.4` to `0.85` (keeping `4.2` inside urban zones `zoneColorIdx >= 0`), and add a 2-step anti-oscillation check (`grandParentId`) that penalizes alternating `A -> B -> A` direction flips (`+4.5`) so rural roads curve smoothly around foothills without 1-tile staircases.

---

## 2. True Terrain-Following Expressway Valley A* (`findValleyMotorwayWaypoints`)

### Problem
1. In [`findValleyMotorwayWaypoints()`](./src/world-generator.js#L3088-L3103), after the coarse 3-tile-stride A* finds a valley path `rawPts`, it subsamples `numCtrl = 4..9` points and adds a synthetic perpendicular sine wave (`waveAmp = Math.min(16.0, chordLen * 0.11)`), pushing control points up to 16 tiles out of the incised valley floor and onto adjacent mountain ridges.
2. In [`ensureCoarseValleyCostTable()`](./src/world-generator.js#L2975-L2980), `hAbove >= 0.205` receives a marginal cost discount (`14.0` vs. `38.0`), and per-step directional grade `|Δh|` is not penalized.

### Fix
- In [`ensureCoarseValleyCostTable()`](./src/world-generator.js#L2975-L2980) and [`findValleyMotorwayWaypoints()`](./src/world-generator.js#L3140-L3165):
  1. Increase upland elevation and slope weights (`hAbove * 95.0 + (hAbove * hAbove) * 180.0 + slope * 48.0`) and add a per-step directional grade penalty `Math.abs(elev[nid] - elev[cid]) * 145.0` in the neighbor expansion loop.
  2. Remove the synthetic `waveAmp` sine displacement onto ridge walls; extract denser control points (every `~3` coarse steps, up to `14` control points) directly from `rawPts` with 2-pass interior Laplacian smoothing (applying only a subtle `<= 2.2` tile S-curve grace when the entire path lies on a flat plain `maxHAbove < 0.08`).

---

## 3. Valley-Routed Cloverleaf Trunks (`M-2`) & Trumpet Spurs (`M-3..M-6`)

### Problem
1. When `forcedViaPt` is passed to [`createMotorwayEntity()`](./src/world-generator.js#L3187-L3196) for the transverse Cloverleaf trunk `M-2`, it only constructs a 3-point quadratic Bezier chord with a `+35.0` score bonus, while `findValleyMotorwayWaypoints` ignores `forcedViaPt`.
2. [`tryBuildTrumpetSpurToTrunk()`](./src/world-generator.js#L3340-L3365) never calls `findValleyMotorwayWaypoints()` at all—it only tests a single 4-point cubic Bezier chord from `(originX, originY)` to `hitPt`.

### Fix
- In [`createMotorwayEntity()`](./src/world-generator.js#L3187-L3218):
  - When `forcedViaPt` is provided, run two chained valley A* legs: `leg1 = findValleyMotorwayWaypoints(vStartX, vStartY, forcedViaPt.x, forcedViaPt.y)` and `leg2 = findValleyMotorwayWaypoints(forcedViaPt.x, forcedViaPt.y, ex, ey)`, concatenate them through `forcedViaPt`, and include them as `isCloverleafTarget: true, isValleyCorridor: true` candidates.
- In [`tryBuildTrumpetSpurToTrunk()`](./src/world-generator.js#L3340-L3365):
  - Define `throatApproachPt = { x: hitPt.x + outNx * pullEnd, y: hitPt.y + outNy * pullEnd }` (preserving the strict 90° perpendicular arrival tangent into the trumpet throat) and generate valley-routed candidate waypoints `[...findValleyMotorwayWaypoints(originX, originY, throatApproachPt.x, throatApproachPt.y, airportId, bias), { x: hitPt.x, y: hitPt.y }]` alongside the Bezier candidate.

---

## 4. Long-Tunnel Discipline & Valley S-Bend Tolerance (`scoreMotorwaySamples`)

### Problem
In [`scoreMotorwaySamples()`](./src/world-generator.js#L2875-L2913):
1. `cosWide < 0.44` (over a 10-sample window) rejects any valley-following expressway that bends more than `63°` around a mountain nose, forcing fallback to a straight Bezier chord over the mountain.
2. High-ridge samples (`elev >= seaLevel + 0.21`) only pay `ridgeElev * 6.5`, with no penalty on continuous tunnel length—allowing 75–90 tile diagonal tunnels lengthwise under mountain massifs (`HARBOR-305`).

### Fix
- Relax `cosWide` in [`scoreMotorwaySamples()`](./src/world-generator.js#L2883) from `0.44` to `0.16` (`~80°` over 10 samples) while keeping the 4-sample `cosTurn >= 0.35` hairpin guard intact.
- Track contiguous `tunnelRunArc` and `totalTunnelArc` (`elevationField[id] >= this.seaLevel + 0.21`):
  - Add `segLen * (ridgeElev * 28.0 + this.slopeField[id] * 8.5)` for all upland samples.
  - When `tunnelRunArc > 24`, add a quadratic surcharge `(tunnelRunArc - 24) * 3.5 * segLen`, and reject (`return Infinity`) if `tunnelRunArc > 46` so tunnels only pierce narrow mountain ridges perpendicularly rather than boring diagonally under an entire range.