# AGENTS.md — Development & Review Methodology

## 1. Project Vision & North Star

**Mini Logistics** is a 2D procedural world generator and multi-modal transportation logistics simulator patterned after **OpenTTD** (*TerraGenesis*) and **Mini Motorways** / **Mini Metro**.

Every change to the generator, renderer, or simulation must balance two complementary forces:
1. **Cartographic Minimalism (*Mini Motorways* / *Mini Metro*)**: Warm paper palettes, octilinear Marching-Squares contours, bold readable stroke weights, clear visual hierarchy, and uncluttered negative space.
2. **Geographic & Engineering Verisimilitude (*OpenTTD*)**: Landforms, watersheds, settlement hierarchies, RCI urban blocks, airport approach funnels, grade-separated expressways, interchanges, and industrial supply chains that behave according to real-world physical geography and civil/transport engineering.

---

## 2. Iterative Visual Development & Dual-Subagent Review Methodology

Never develop or tune procedural generation rules blind, and never approach visual problems purely algorithmically without first inspecting and comparing rendered worlds across waves.

### Step 1 — First-Principles Visual Comparison Before Coding
- When refining terrain, hydrology, urban morphology, or highway layout, start by visually comparing current screenshots against earlier waves and against the aesthetic baseline (*Mini Motorways* and *OpenTTD*).
- Diagnose why an artifact looks unnatural to a human viewer (e.g., waffle-iron grid regularity, reverse-tapering rivers that read backwards, or camera margins that make border rivers appear to stop in mid-land) before changing parameters.

### Step 2 — Real Browser Verification Across Seeds, Archetypes & Engines
- Serve the app locally (`http://127.0.0.1:8788/index.html`) and capture full-viewport (`1600×1000`) and mobile (`390×844`) screenshots in a real headless browser across multiple benchmark seeds and archetypes:
  - Continental seeds (`OTTD-METRO-84`, `DELTA-402`, `HARBOR-305`, `VALLEY-618`) across the 3 [Stage 2A Terrain Engines](./src/terrain-solvers.js#L8-L410) and 3 [Stage 2B Hydrology Engines](./src/hydrology-solvers.js#L13-L618).
  - Multi-island seeds (`ISLAND-HOP-101`, `ARCHIPELAGO-77`, `AEGEAN-420`, `ATOLL-808`) in the `island-hopper` scenario.
  - Both the **Mini Motorways View** (`aesthetic`) and the **RCI & Cargo Chain View** (`rci`).
- When modifying code that runs inside the [Web Worker](./src/world-worker.js#L1-L8), always reload the page in the browser before capturing screenshots so the Worker thread reloads updated ES modules.

### Step 3 — Parallel Dual-Subagent Review Loop (Targeted + Uncued Holistic Reviewer)
Every major iteration must be audited by **two independent review subagents dispatched in parallel**:

1. **Targeted Round Reviewer**:
   - Verifies the specific invariants, bug fixes, and geometric constraints targeted in the current round.
2. **Uncued Holistic Rubric Reviewer (Mandatory in Parallel)**:
   - Spawned in a separate session **without** being over-cued on the specific round's code changes or implementation details, so its eyes remain completely unbiased.
   - Evaluates the generated world screenshots purely as a player, cartographer, and game designer against the **4-Pillar Success Rubric**:
     - **Aesthetic Quality**: Visual harmony, stroke weight hierarchy, contour cleanliness (no plaid grid cross-hatching), cohesive woodland canopies, and *Mini Motorways*-grade polish.
     - **Verisimilitude**: Stylized abstraction in art direction and scale that remains grounded in real physical geography, watershed hydrology, urban land-use patterns, and highway/airport engineering.
     - **Plausibility & Anti-Absurdity**: Hunts specifically for anything that looks absurd or broken to a human observer—such as road networks that *almost* connect across a tiny gap, local roads wrapping in tight U-loops around river spring tips, expressways running longitudinally inside rivers or making sharp un-ramped V-turns, surface interchanges built on top of underground tunnels, rivers bouncing off map borders or splitting downstream, or awkward building/airport placements.
     - **Gameplay & Directional Fit (*OpenTTD* × *Mini Motorways*)**: Evaluates whether the world reads as an inviting, legible, strategic transportation and cargo puzzle with clear geographic bottlenecks, distinct regional hubs, and readable RCI supply-chain flows.

### Step 4 — Commit Each Verified Round
- Commit each verified round to git with a clear message before starting the next wave so visual diffs and historical screenshots can be compared side-by-side.

---

## 3. Core Architectural & Domain Invariants

### Pluggable Hourglass Architecture
- Keep [Stage 2A Terrain Synthesis](./src/terrain-solvers.js#L8-L410), [Stage 2B Fluvial Hydrology](./src/hydrology-solvers.js#L13-L618), and [Stages 3–9 Urban & Transport Generation](./src/world-generator.js#L180-L3895) decoupled across the narrow `(elevationField, seaLevel, waterMask, rivers)` data contract so all $3 \times 3$ Terrain $\times$ Hydrology combinations remain hot-swappable in-game.
- Keep world generation off the main thread in the [module Web Worker](./src/world-worker.js#L1-L8) using [zero-copy Transferable ArrayBuffers](./src/world-generator.js#L3898-L3932), and keep main-thread terrain baking inside the [50ms yielding budget](./src/renderer.js#L118-L138) (`scheduler.yield()` with a `setTimeout` fallback).

### Hydrology & Landform Invariants
- **Bold Cartographic River Proportions**: Mainstem rivers scale from `1.85 → 3.20` tiles wide and carve `waterMask = 1` across their full physical half-width (`chanRad >= 1.05`) in [carveTaperingRiverPath](./src/hydrology-solvers.js#L350-L405) so waterfront setbacks and bank-to-bank bridges align with the rendered water ribbon.
- **No Mid-Land Dead-End Tentacles or Border Bounce-Backs**: Mainland trunk rivers originate at [map-border valley entries](./src/hydrology-solvers.js#L272-L312) (clear of floating HUD corners), upstream lake outlets, or [wooded interior highland springs](./src/hydrology-solvers.js#L238-L270) (`0.55 → 1.45` tiles wide, nestled inside forest groves with a 6-tile road exclusion buffer around `headwaterPt`). Any interior river approaching within 22 tiles of a map border snaps cleanly off-canvas.

### Urban, Airport & Expressway Invariants
- **Organic Unphased Boroughs & Multi-Size RCI Lots**: Boroughs use independent grid phases with a 2-tile parallel-street inhibition guard (forming natural T-junctions), variable `3/4/5`-tile block strides, and multi-dimension footprints (`3×2`, `2×3`, `2×2`, `2×1`, `1×2`) with yard breathing room and outer empty-street pruning in [growUrbanFabric](./src/world-generator.js#L1360-L1845).
- **Road & Expressway Collision Guards**:
  - Roads must cross rivers from bank to bank within 5 steps in [findRoadPathAStar](./src/world-generator.js#L1150-L1195) and never braid lengthwise along river channels.
  - Expressways must never cross airport pads, must never run longitudinally inside rivers (`riverProxArc <= 14.5`), must never make acute V-turns (`cosTurn >= 0.35`, `cosWide >= 0.44`), and may only share a town beltway roundabout when departing tangents are $\ge 110^\circ$ apart (`dot <= -0.34`) in [scoreMotorwaySamples](./src/world-generator.js#L2325-L2425).
  - Subterranean mountain tunnels (`elevationField >= seaLevel + 0.21`) must cast zero ground shadows, render full-width dashed bore walls, and never coalesce across a surface gap that contains a Cloverleaf or Trumpet interchange in [detectMountainExpresswayTunnels](./src/world-generator.js#L3760-L3838).
