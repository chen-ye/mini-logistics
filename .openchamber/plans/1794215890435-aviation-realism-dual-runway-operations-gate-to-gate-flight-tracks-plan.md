# Aviation Realism, Dual-Runway Operations & Gate-to-Gate Flight Tracks Plan

## Steps

- [x] Phase 1: Replace raw `t`-space midpoint-to-midpoint Bezier flights with arc-length parameterized 5-phase gate-to-gate tracks (`TAXI_OUT -> TAKEOFF -> CRUISE -> LANDING -> TAXI_IN -> GATE_DWELL`) moving at consistent world-space speeds (`tiles/sec`)
- [x] Phase 2: Implement Dual-Runway Hub separation (inner runway `mainRwyY = -0.85*ts` for departures, outer runway `outerRwyY = -2.55*ts` for arrivals) and single-runway hold-short separation so departing planes wait when an arrival is on short final
- [x] Phase 3: Differentiate Passenger Jets (painted with `origin.palette.roof` tail/wingtip livery accents) from Air Cargo Freighters (`CRG` sortation pad operations & inter-island / inter-metro `LOG` freight bridges)
- [x] Phase 4: Precompute deduplicated Airway Corridors into `VectorLayerRecorder` (eliminating redundant per-plane dashed Bezier strokes) and split ground-taxiing vs. airborne Z-layers
- [x] Phase 5: Add unit tests in `tests/unit/simulator.test.js` (arc-length speed invariance, 5-phase lifecycle, dual-runway separation, hold-short lock) and verify in Playwright E2E
- [x] Phase 6: Update documentation (`README.md` & `AGENTS.md`) with source-fragment links to the aviation track builder and simulator

## 1. Current Limitations Identified in `src/simulator.js` & `src/renderer.js`

1. **Midpoint Teleportation (No Takeoff Roll, Landing Rollout, or Taxiing)**:
   - `drawPlanes` (`src/renderer.js` lines 3142–3145) anchors both `(sx, sy)` and `(ex, ey)` at the **center midpoint** of each runway. Planes spawn in the middle of the runway at `t = 0`, and at `t = 1` they touch down at the midpoint of the destination runway and immediately launch from that same point without rolling down the runway or taxiing to the terminal gates.
2. **Misaligned Hub Runway Offset**:
   - `drawAirports` (`src/renderer.js` lines 1747–1748) renders two parallel runways on Tier-1 International Hubs (`mainRwyY = -side * 0.85 * ts` and `outerRwyY = -side * 2.55 * ts`) and `mainRwyY = -side * 0.58 * ts` on Regional/Cargo airports, but `drawPlanes` (line 3134) hardcodes `-side * (isHub ? 1.15 : 0.75) * ts`, which sits between the two hub runways rather than on either centerline!
3. **Normalized `t`-Space Speed Distortion**:
   - `p.progress += p.speed * effDt` (`src/simulator.js` line 195) advances `t in [0, 1]` at a fixed rate regardless of chord distance, so a 300-tile cross-map flight travels 6x faster in world space than a 50-tile island hop, and slows down unnaturally inside tight Bezier turns.
4. **Unused `p.color` & Missing Air Cargo Differentiation**:
   - `PlaneAgent.color` (`origin.palette.roof`, line 156) is stored on every plane but never used in `drawPlanes`, and `CRG` Cargo Airfields spawn identical passenger jets instead of cargo freighters serving the twin sortation warehouse pads.
5. **Per-Plane Redundant Airway Strokes**:
   - Every plane re-strokes its own dashed cubic Bezier airway line on every 60fps frame (`src/renderer.js` lines 3160–3169), over-darkening routes shared by multiple aircraft.

---

## 2. Phase 1 — Arc-Length Parameterized 5-Phase Gate-to-Gate Flight Tracks (`buildFlightTrack`)

Model aircraft trajectories using the same arc-length parameterized `pts` + `cumLen` + `totalLength` pattern used by road vehicles, divided into 5 physical phases:

1. **`TAXI_OUT` (`altitude = 0`, `speed = 2.2 tiles/sec`)**:
   - Starts at a terminal concourse gate bay (or `CRG` warehouse sortation pad) at `termY = side * (isHub ? 1.05 : 0.95)`, follows the cross-field taxiway (`xFrac = -oSign * (isHub ? 0.41 : 0.38)`) to the hold-short line, and turns onto the departure runway piano-key threshold (`x = -oSign * rwyLen * 0.44`).
2. **`TAKEOFF` (`altitude: 0 -> 0.18`, `speed: 2.2 -> 13.5 tiles/sec`)**:
   - Accelerates smoothly along the exact runway centerline from the departure threshold (`-oSign * 0.44 * rwyLen`) through rotation/liftoff (`+oSign * 0.32 * rwyLen`) and climbs straight out through the departure obstacle-clearance funnel (`+oSign * (halfLen + approachLen * 0.65)`).
3. **`CRUISE` (`altitude: 0.18 -> 1.0 -> 0.18`, `speed = 16.5 tiles/sec`)**:
   - Uniformly resampled cubic Bezier curve from the departure climb-out point to the destination's **approach funnel entry** (`-dSign * (dest.halfLen + dest.approachLen * 0.75)`), guaranteeing that every arriving aircraft lines up strictly along the destination runway axis inside the green approach cone before crossing the threshold.
4. **`LANDING` (`altitude: 0.18 -> 0`, `speed: 12.5 -> 2.2 tiles/sec`)**:
   - Touches down at the destination piano-key threshold (`-dSign * 0.42 * rwyLen`) and decelerates along the runway centerline to the exit taxiway turnoff (`+dSign * 0.38 * rwyLen`).
5. **`TAXI_IN` & `GATE_DWELL` (`altitude = 0`, `speed = 2.2 tiles/sec`, `dwell = 1.2s`)**:
   - Exits the runway via the cross-field taxiway into an available terminal gate / cargo bay, holds for `1.2s` while unloading/boarding (`tripsCompleted += 6`), and then dispatches its next gate-to-gate flight track.

---

## 3. Phase 2 — Dual-Runway Hub Operations & Single-Runway Hold-Short Locks

1. **Exact Runway Centerline Alignment (`drawAirports` <-> `buildFlightTrack`)**:
   - **Tier-1 International Hubs (`ap.isHub === true`)**:
     - **Departures** use the **inner runway** (`mainRwyY = -side * 0.85 * ts`, closest to the terminal concourse).
     - **Arrivals** use the **outer parallel runway** (`outerRwyY = -side * 2.55 * ts`, length scale `0.88`), taxiing across the cross-field connector taxiways to the concourse.
   - **Regional (`REG`) & Air Cargo (`CRG`) Airports (`ap.isHub === false`)**:
     - Both departures and arrivals align with `mainRwyY = -side * 0.58 * ts`.
2. **Single-Runway Hold-Short Traffic Control**:
   - Track per-runway occupancy on single-runway airports: if an arriving aircraft is in `LANDING` (or late `CRUISE` within `12` tiles of threshold), a plane in `TAXI_OUT` holds short at the taxiway hold line before entering the active runway.

---

## 4. Phase 3 — Airline Livery Accents & Dedicated Air Cargo Freighters (`CRG`)

1. **Airline Livery Accents on Passenger Jets**:
   - Render `p.color` (`origin.palette.roof`) on the swept tail fin and wingtips of passenger aircraft in `drawAirplaneSilhouette` so each aircraft visually carries its hub's *Mini Motorways* district color.
2. **Air Cargo Freighter Silhouette & RCI Supply-Chain Integration**:
   - Flights originating at or destined for a `CRG` Cargo Airfield (or dedicated inter-hub cargo flights) set `isCargoFreighter = true`.
   - Render cargo freighters with a slightly broader high-wing freighter fuselage, wing-mounted quad nacelles, and amber/purple cargo accents in `rci` view (parking directly at the twin `CRG` sortation warehouse pads at `wx = ±termW * 0.32`).

---

## 5. Phase 4 — Deduplicated Airway Corridors & Z-Layer Split

1. **Deduplicated Airway Corridors in `VectorLayerRecorder`**:
   - Precompute the unique airport-pair airway curves once per world and record the subtle dashed airway lines (`rgba(54, 56, 62, 0.12)`) into a static display list so shared air corridors are stroked once per frame rather than once per plane.
2. **Ground vs. Airborne Z-Layering**:
   - Render aircraft with `altitude === 0` (`TAXI_OUT`, `TAXI_IN`, `GATE_DWELL`) in the surface vehicle pass (with zero ground shadow offset), and render airborne/rolling aircraft (`altitude > 0`) in the top aviation pass with smooth parallax shadow offset `shadowOff = 1.5 + altitude * 22`.

---

## 6. Phase 5 & 6 — Verification Suite & Documentation Updates

1. **Unit Tests (`tests/unit/simulator.test.js`)**:
   - Verify that `buildFlightTrack` produces monotonically increasing `cumLen` and that aircraft world-space cruise speed (`tiles/sec`) is invariant across short (40-tile) and long (250-tile) airport pairs.
   - Verify 5-phase state transitions (`TAXI_OUT -> TAKEOFF -> CRUISE -> LANDING -> TAXI_IN -> GATE_DWELL`), dual-runway hub offset separation (`mainRwyY` vs. `outerRwyY`), and single-runway hold-short behavior.
2. **Playwright E2E & Visual Verification**:
   - Verify aircraft taxi, takeoff, approach-cone alignment, and landing rollout in headless Chromium across `OTTD-METRO-84` and `ISLAND-HOP-101`.
3. **Documentation (`README.md` & `AGENTS.md`)**:
   - Document the 5-phase gate-to-gate aviation model, dual-runway hub operations, and air-cargo freighter visuals with updated source-fragment links.