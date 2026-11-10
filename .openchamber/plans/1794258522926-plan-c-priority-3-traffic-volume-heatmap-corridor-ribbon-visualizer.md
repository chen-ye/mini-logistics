# Plan C (Priority 3): Traffic Volume Heatmap & Corridor Ribbon Visualizer

## Steps
- [ ] Step 1: Build `computeTrafficVolumeBuckets(world)` in `src/vehicle-routing.js` to aggregate route volume per directed lane & ramp segment
- [ ] Step 2: Render volume-scaled corridor ribbons & ramp heat encoding in `src/renderer.js`
- [ ] Step 3: Add UI toggle / view mode and screen legend for Traffic Volume visualization
- [ ] Step 4: Verify volume aggregation invariants and visual rendering across benchmark seeds

## Context & Goal
While individual trajectory lines show exact geometry, players and designers also want to see **where traffic concentrates**: which motorway trunks, Cloverleaf/Trumpet loops, Diamond slip-ramps, roundabouts, and arterial bridges carry the highest combined commuter + freight load.

## Implementation Details

### Step 1: Segment Volume Aggregation (`src/vehicle-routing.js`)
- Implement `computeTrafficVolumeBuckets(world)` (cached on `world._trafficVolumeCache`):
  - Quantize consecutive points `(p0 -> p1)` of every `outboundTrack` and `inboundTrack` across `world.commuterRoutes` (weight `1.0`) and `world.cargoLinks` (weight `2.0` for heavy freight) into directed spatial segment buckets `(qx0, qy0 -> qx1, qy1)` at `0.25`-tile resolution.
  - Record `totalWeight`, `commuterCount`, `cargoCount`, `isSlipRamp`, and `onMotorway` per directed bucket, plus `maxWeight` across the world.

### Step 2: Volume-Scaled Ribbon & Ramp Heat Rendering (`src/renderer.js`)
- Render each directed segment bucket with:
  - **Stroke width**: Scaled from `1.2px` (1 route) up to `5.2px` (peak corridor volume).
  - **Color ramp**: Cool sky-blue (`#0ea5e9`, low volume) → emerald (`#10b981`, moderate) → amber (`#f59e0b`, heavy arterial/ramp load) → crimson-magenta (`#e11d48`, peak bottleneck corridor).
  - **Directional flow ticks**: Spaced along high-volume corridors (`weight >= 4`).

### Step 3: UI Integration & Legend (`index.html` / `src/renderer.js`)
- Expose either as a sub-mode toggle inside `Road Grid & Graph` / `RCI & Cargo Chain` or as a dedicated layer chip in `#layerSelect`, with a bottom legend showing peak corridor load and top bottleneck interchange.

### Step 4: Verification
- Add unit tests verifying `computeTrafficVolumeBuckets(world)` conservation of route weights and run `bun run check`.