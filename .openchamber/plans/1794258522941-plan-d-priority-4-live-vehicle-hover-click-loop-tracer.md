# Plan D (Priority 4): Live Vehicle Hover & Click Loop Tracer

## Steps
- [ ] Step 1: Add `route` / `link` endpoint metadata to `CarAgent` in `src/simulator.js` and hit-testing `findVehicleAtWorldPos` in `src/main.js`
- [ ] Step 2: Render active vehicle dual-lane loop (`outboundTrack` + `inboundTrack`), live progress marker, and origin/destination badges in `src/renderer.js`
- [ ] Step 3: Support following/inspecting a clicked vehicle in `src/inspector-component.js` and `src/main.js`
- [ ] Step 4: Verify vehicle selection and loop tracing in unit and Playwright tests

## Context & Goal
Hundreds of commuter cars and freight trucks drive across the map in real time, but clicking or hovering a moving vehicle currently does nothing. Tracing a single live vehicle's complete `outboundTrack` (home → destination) and `inboundTrack` (destination → home) makes it immediately obvious how an individual agent navigates driveways, roundabouts, and interchange ramps.

## Implementation Details

### Step 1: Vehicle Metadata & Spatial Hit-Testing (`src/simulator.js` & `src/main.js`)
- In `LogisticsSimulator.prototype.spawnCar` (`src/simulator.js` lines 415–490), attach `homeEntity` / `fromEntity`, `destEntity` / `toEntity`, and `routeId` to each `CarAgent`, and maintain interpolated world coordinates `(car.wx, car.wy, car.angle)` during `update()`.
- In `findEntityAtWorldPos(wx, wy, touchPad)` (`src/main.js`), check `simulator.cars` within `0.85 + touchPad` tiles at highest priority when zoomed in (`camera.zoom >= 1.1`), returning `{ type: "vehicle", entity: car }`.

### Step 2: Live Vehicle Loop Rendering (`src/renderer.js`)
- In `drawSelectionHighlight` (`src/renderer.js`):
  - When `entity` is a `CarAgent`, draw its complete `outboundTrack.pts` (solid in the vehicle's livery color with white casing) and return `inboundTrack.pts` (dashed complementary color), highlight the active leg the vehicle is currently driving on, draw a pulsing ring around `(car.wx, car.wy)`, and frame both its origin house/facility and destination facility.

### Step 3: Vehicle Inspector Card & Optional Camera Follow (`src/inspector-component.js`)
- Render a compact dossier card for the selected commuter car or cargo truck showing its vehicle type, current speed (`tiles/s`), current road regime (`Surface Street`, `Roundabout Orbit`, `Interchange Slip-Ramp`, `Motorway M-1`, `Mountain Tunnel`), trip progress `%`, and clickable origin/destination links.

### Step 4: Verification
- Add unit tests in `tests/unit/simulator.test.js` verifying `car.wx, car.wy` tracking and endpoint references, and run `bun run check`.