# Plan B (Priority 2): Interactive Interchange, Roundabout & Building Trajectory Inspector

## Steps
- [ ] Step 1: Extend `InspectedEntity` types in `src/types.d.ts` and hit-testing in `findEntityAtWorldPos` (`src/main.js`) to support interchanges and roundabouts
- [ ] Step 2: Upgrade `drawSelectionHighlight` (`src/renderer.js`) to render dual-lane commuter + cargo trajectories for selected interchanges, buildings, and towns
- [ ] Step 3: Add Interchange & Roundabout dossier rendering in `src/inspector-component.js`
- [ ] Step 4: Verify click-to-inspect on Cloverleaf, Trumpet, Diamond, Roundabout, and Building entities in Playwright

## Context & Goal
Currently, clicking the map in [`findEntityAtWorldPos`](./src/main.js#L391-L457) only selects `airport`, `building`, or `town`:
- Clicking a **Building** in [`drawSelectionHighlight`](./src/renderer.js#L3838-L4016) only shows its industrial `cargoLinks` (`outboundTrack` only) and ignores all residential `commuterRoutes` serving that building and all return `inboundTrack` lanes.
- Clicking a **Town** only draws a dashed circle around `urbanRadius` with zero route trajectories.
- Clicking a **Cloverleaf**, **Trumpet**, **Diamond Interchange**, or **Roundabout** is not supported at all.

This plan lets players click any interchange, roundabout, building, or town to inspect every commuter and cargo trajectory (`outboundTrack` + `inboundTrack`) flowing through it.

## Implementation Details

### Step 1: Hit-Testing for Interchanges & Roundabouts (`src/main.js` & `src/types.d.ts`)
- In `findEntityAtWorldPos(wx, wy, touchPad)` (`src/main.js` lines 391–457), after checking buildings and before towns:
  - Check `currentWorld.interchanges` (`cloverleaf`, `trumpet`, `diamond-ramp`, `terminal-stub`) within a radius of `3.2 + touchPad` tiles, returning `{ type: "interchange", entity: ic }`.
- Update `InspectedEntity` and `InspectedSelection` in `src/types.d.ts` to include `MotorwayInterchange`.

### Step 2: Dual-Lane Trajectory Highlighting in `drawSelectionHighlight` (`src/renderer.js` lines 3833–4052)
- **When an Interchange/Roundabout is selected (`entity.type === "cloverleaf" | "trumpet" | "diamond-ramp" | "terminal-stub"`)**:
  - Filter all `world.commuterRoutes` and `world.cargoLinks` whose `outboundTrack.pts` or `inboundTrack.pts` pass within the interchange footprint (`<= 4.2` tiles of `(ic.x, ic.y)`).
  - Render outbound tracks in royal blue (`#0284c7`) and return tracks in warm amber (`#d97706`) with white casings and directional chevrons, plus a selection halo around the interchange pad.
- **When a Building is selected (`entity.zoneType`)**:
  - In addition to its `cargoLinks`, render the connected `commuterRoutes` (`r.dest.id === entity.id`), showing both `outboundTrack` and `inboundTrack` right-hand lanes and highlighting origin residential houses.
- **When a Town is selected (`entity.urbanRadius`)**:
  - Render all intra-town and inter-town commuter & cargo trajectories originating or terminating in `entity.id`.

### Step 3: Interchange Dossier in `src/inspector-component.js`
- Add `describeInterchangeDossier(ic, world)` in `src/inspector-component.js` displaying the interchange class badge (`SYSTEM CLOVERLEAF`, `3-WAY TRUMPET`, `DIAMOND RAMP`, `ROUNDABOUT HUB`), connected motorways (`M-1 × M-2`), and counts of commuter routes and freight links traversing its ramps.

### Step 4: Verification
- Add unit tests for `describeInterchangeDossier` and Playwright E2E coverage clicking an interchange and verifying the inspector dossier + canvas trajectory highlight.