# AGENTS.md: Development and review methodology

## 1. Project vision and design goals

**Mini Logistics** is a 2D procedural world generator and multimodal transportation logistics simulator patterned after **OpenTTD** (_TerraGenesis_) and **Mini Motorways** / **Mini Metro**.

Every change to the generator, renderer, or simulation balances two complementary forces:

1. **Cartographic minimalism (_Mini Motorways_ / _Mini Metro_)**: Warm paper palettes, octilinear Marching-Squares contours, bold readable stroke weights, clear visual hierarchy, and uncluttered negative space.
2. **Geographic and engineering verisimilitude (_OpenTTD_)**: Landforms, watersheds, settlement hierarchies, RCI urban blocks, airport approach funnels, grade-separated expressways, interchanges, and industrial supply chains that follow real-world physical geography and civil or transport engineering.

---

## 2. Iterative visual development and dual-subagent review methodology

Do not develop or tune procedural generation rules blind. Inspect and compare rendered worlds visually across waves before changing algorithmic parameters.

### Step 1: First-principles visual comparison before coding

- Compare current screenshots against earlier waves and the aesthetic baseline (_Mini Motorways_ and _OpenTTD_) when refining terrain, hydrology, urban morphology, or highway layout.
- Diagnose why an artifact looks unnatural to a human viewer before changing parameters. Examples include waffle-iron grid regularity, reverse-tapering rivers that read backwards, and camera margins that make border rivers appear to stop in mid-land.

### Step 2: Real browser verification across seeds, archetypes, and engines

- Serve the app locally (`http://127.0.0.1:8788/index.html`). Capture full-viewport (`1600×1000`) and mobile (`390×844`) screenshots in a real headless browser across multiple benchmark seeds and archetypes:
  - Benchmark seeds across the 9 orthogonal landform archetypes (`confluence`, `inland`, `alpine-passes`, `fjord-sound`, `isthmus-strait`, `caldera-basin`, `barrier-lagoon`, `canyon-gorge`, `island-hopper`), the 6 continuous geomorphology scalars in [ARCHETYPE_PARAMETER_PRESETS](./src/constants.js#L207-L289), the 3 [Stage 2A Terrain Engines](./src/terrain-solvers.js#L16-L838), and the 3 [Stage 2B Hydrology Engines](./src/hydrology-solvers.js#L24-L1201).
  - Multi-island seeds (`ISLAND-HOP-101`, `ARCHIPELAGO-77`, `AEGEAN-420`, `ATOLL-808`) in the `island-hopper` scenario.
  - Continental benchmark seeds (`OTTD-METRO-84`, `DELTA-402`, `HARBOR-305`, `VALLEY-618`).
  - The **Mini Motorways view** (`aesthetic`), the **RCI and cargo chain view** (`rci`), and the **road grid and graph view** (`roadgrid`).
- When modifying code that runs inside the [world Web Worker](./src/world-worker.js#L1-L122) or [VectorLayerRecorder display-list cache](./src/canvas-layer-cache.js#L144-L759), reload the page in the browser before capturing screenshots. This reloads updated ES modules on the Worker thread and main-thread modules.
- Run the automated static and behavioral verification suite (`bun run check`: `bun fmt --no-script --check`, `bunx oxlint --deny-warnings`, `bun check --no-script`, `bun test --check tests/unit`, and `bunx playwright test`) before concluding any round.

### Step 3: Parallel dual-subagent review loop (targeted and uncued holistic reviewer)

Every major iteration requires audit by **two independent review subagents dispatched in parallel**:

1. **Targeted round reviewer**:
   - Verifies the specific invariants, bug fixes, and geometric constraints targeted in the current round.
2. **Uncued holistic rubric reviewer (mandatory in parallel)**:
   - Spawned in a separate session without cues about round implementation details to maintain unbiased review.
   - Evaluates generated world screenshots as a player, cartographer, and game designer against the **4-pillar success rubric**:
     - **Aesthetic quality**: Visual harmony, stroke weight hierarchy, contour cleanliness (no plaid grid cross-hatching), cohesive woodland canopies, and _Mini Motorways_-grade polish.
     - **Verisimilitude**: Stylized abstraction in art direction and scale grounded in real physical geography, watershed hydrology, urban land-use patterns, and highway/airport engineering.
     - **Plausibility and anti-absurdity**: Flags any unnatural artifacts. Examples include road networks that almost connect across a tiny gap, local roads wrapping in tight U-loops around river spring tips, expressways running longitudinally inside rivers or making sharp unramped V-turns, surface interchanges built on top of underground tunnels, rivers bouncing off map borders or splitting downstream, and awkward building or airport placements.
     - **Gameplay and directional fit (_OpenTTD_ × _Mini Motorways_)**: Evaluates whether the world reads as an inviting, legible, strategic transportation and cargo puzzle with clear geographic bottlenecks, distinct regional hubs, and readable RCI supply-chain flows.

### Step 4: Commit each verified round

- Commit each verified round to git with a clear message before starting the next wave. This preserves visual diffs and historical screenshots for side-by-side comparison.

---

## 3. Core architectural and domain invariants

### Pluggable hourglass and 3-thread architecture

- Keep [Stage 2A Terrain Synthesis](./src/terrain-solvers.js#L16-L838), [Stage 2B Fluvial Hydrology](./src/hydrology-solvers.js#L24-L1201), and [Stages 3-9 Urban & Transport Generation](./src/world-generator.js#L501-L2141) decoupled across the narrow `(elevationField, seaLevel, waterMask, rivers)` data contract in [src/types.d.ts](./src/types.d.ts#L1-L1368) and [src/constants.js](./src/constants.js#L1-L311). This preserves hot-swappable execution for all $3 \times 3$ Terrain $\times$ Hydrology engine combinations in-game.
- Maintain a 3-thread architecture:
  - The main UI thread ([src/main.js](./src/main.js#L1-L1526)) handles user input with [CameraController](./src/camera-controller.js#L1-L187).
  - World generation runs off-thread in [world-worker.js](./src/world-worker.js#L1-L122). It transfers [zero-copy Transferable ArrayBuffers](./src/world-generator.js#L2100-L2141) through a direct `MessageChannel` to [render-sim-worker.js](./src/render-sim-worker.js#L1-L824).
  - The render-sim worker owns the transferred `OffscreenCanvas`. It drives 60fps rendering in [MiniMotorwaysRenderer](./src/renderer.js#L48-L783) and 60Hz physics in [LogisticsSimulator](./src/simulator.js#L80-L324).
- Record static terrain, hydrology, urban, road, building, airport, motorway, and airway layers into [retained `VectorLayerRecorder` `Path2D` display lists](./src/renderer.js#L340-L460) in [src/canvas-layer-cache.js](./src/canvas-layer-cache.js#L144-L759). These lists include `hydroDisplayList`, `urbanTerrainDisplayList`, `surfaceNetworkDisplayList`, `motorwayDisplayList`, `overpassBridgeDisplayList`, and `airwayDisplayList`.

### Hydrology and landform invariants

- **Nine orthogonal landform archetypes and continuous 6-scalar geomorphology basis.** Stage 2A evaluates a continuous scalar basis parameterized by `(terrainRelief, valleyIncision, coastalEmbayment, calderaCurvature, barrierFragmentation, basinCount)` in [ARCHETYPE_PARAMETER_PRESETS](./src/constants.js#L207-L289) and [synthesizeTerrainAndBasins](./src/terrain-solvers.js#L16-L838). Border suppression on `inland` and `coastalEmbayment === 0` clamps border tiles (`x <= 3 || x >= W - 4 || y <= 3 || y >= H - 4`) to `seaLevel + 0.04` and clears `waterMask`. This preserves 100% landlocked topography with zero border-touching sea basins. In addition, `canyon-gorge` enforces plateau terrace step-flattening and canyon cliffs. `caldera-basin` models radial Somma rings, crater depressions, and resurgent domes. `island-hopper` drives volcanic island arc curvature and multi-lobe archipelago massif separation.
- **Bold cartographic river proportions.** Mainstem rivers scale from `1.85 -> 3.20` tiles wide and carve `waterMask = 1` across their full physical half-width (`chanRad >= 1.05`) in [carveTaperingRiverPath](./src/hydrology-solvers.js#L660-L890). Waterfront setbacks and bank-to-bank bridges therefore align with the rendered water ribbon.
- **Smoothed-octilinear rivers and shorelines.** Mainland rivers route along multi-tile octilinear runs (0°, 45°, 90°) between 4.2-tile sampled waypoints in [smoothPolyline](./src/hydrology-solvers.js#L62-L295). Scoring considers distance and directional alignment to eliminate 1-tile H-V-H-V staircase chatter while preserving 8-connected continuity. Coastlines and lake shorelines in [buildVignelliWaterPath](./src/canvas-layer-cache.js#L778-L1120) chain Marching-Squares segments into continuous closed loops, collapse 1-cell staircase teeth, and apply soft Bezier corner fillets. River channels extrude into closed clockwise-wound polygons with quadratic Bezier corner fillets in [extrudeRibbonToPath2D](./src/canvas-layer-cache.js#L1128-L1260) and [drawTaperingRivers](./src/canvas-layer-cache.js#L1276-L1410).
- **Clean river origins and boundaries.** Mainland trunk rivers originate at [map-border valley entries](./src/hydrology-solvers.js#L577-L658) clear of floating HUD corners, upstream lake outlets, or [wooded interior highland springs](./src/hydrology-solvers.js#L521-L575) (`0.55 -> 1.45` tiles wide). Springs sit inside forest groves with a 6-tile road exclusion buffer around `headwaterPt`. Any interior river approaching within 22 tiles of a map border snaps off-canvas. Rivers never dead-end mid-land or bounce off map borders.

### Urban, industrial, and trade gateway invariants

- **Five-phase demand-driven pull supply chain and connectivity guarantee.** The solver [buildIndustrialCargoChain](./src/vehicle-routing.js#L1502-L2389) coordinates the regional supply chain in 5 stages:
  - _Step 0_: Normalizes surviving post-highway demolition lots. Synthesizes virtual gateway proxy destinations (`id = 10000 + entityId`) from [TradeGateway](./src/types.d.ts#L129-L150) nodes.
  - _Step 1_: Commercial buildings pull matching goods from regional `LOG` hubs (`LOG->COM`, `#7c3aed`), direct `MFG` factories (`MFG->COM`, `#4f46e5`), or gateway imports (`IMPORT->COM`, `#0d9488`). The solver assigns distinct `demandedGoods` without replacement per town first. It consolidates ~50-65% of retail freight through regional `LOG` hubs and aggregates demand profiles onto `LOG` hubs.
  - _Step 2_: Direct inter-CBD wholesale shipping (`CBD->CBD`, `#0284c7`, `B2B_PARCELS`) links central downtown CBD high-rises across town pairs.
  - _Step 3_: `LOG` hubs pull inventory proportional to `relativeDemand` (`2..6` inbound links) from matching `MFG` factories (`MFG->LOG`, `#ea580c`) or gateway proxies (`IMPORT->LOG`, `#0d9488`).
  - _Step 4_: Factories pull required 2-input feedstock (`STEEL` pulls `ORE`+`WOOD`; `FOOD` pulls `AGRI`+`CHEM`; `GOODS` pulls `WOOD`+`HARDWARE`; `TECH` pulls `CHEM`+`HARDWARE`) with a regional load-balanced scoring pass. The pass falls back to gateway imports (`IMPORT->MFG`) so 100% of factories receive input.
  - _Step 5_: Trade gateways pull export links (`RAW->EXPORT`, `MFG->EXPORT`, `LOG->EXPORT`). A final topological sweep ensures every reachable raw extractor has $\ge 1$ outbound link, every factory and log hub has $\ge 1$ inbound and $\ge 1$ outbound link, and every commercial building has $\ge 1$ inbound link.
- **Five `RAW` extraction niches, four distinct `MFG` silhouettes, and RCI visual polish.** Rural resource siting in [seedOutOfTownResourceNiches](./src/entities/rci-building/placement.js#L25-L404) seeds 5 distinct `RAW` niches:
  - `MINE` ($\rightarrow$ `ORE`)
  - `TIMBER` ($\rightarrow$ `WOOD`)
  - `FARM` ($\rightarrow$ `AGRI`)
  - Coastal wharf `FISHERY` ($\rightarrow$ `AGRI`, sited on a dry `2×2` pad with a 1-tile setback and `dW in [1.1, 2.8]`, deep marine cyan `#0e7490`)
  - Peri-urban `CHEM` ($\rightarrow$ `CHEM`, olive-lime `#4d7c0f`)
    In-town industrial zoning in [placeTownCommercialAndIndustrial](./src/entities/rci-building/placement.js#L406-L833) places 4 specialized `MFG` archetypes (`STEEL`, `FOOD`, `GOODS`, `TECH`). These render with distinct architectural roof silhouettes in [src/entities/rci-building/render.js#L430-L750](./src/entities/rci-building/render.js#L430-L750). The solver places `LOG` distribution centers with relative-demand shares. It assigns commercial lots distinct [demandedGoods](./src/types.d.ts#L384). RCI badges in [drawRCICargoChainOverlay](./src/entities/rci-building/render.js#L942-L1130) anchor above each building's `hTiles` footprint. Badges suppress base pills on selected and partner buildings in [drawSelectionHighlight](./src/renderer.js#L589-L690). The [<ml-entity-inspector>](./src/inspector-component.js#L97-L587) element displays stage-colored partner link badges and monospace commodity chips.
- **Multimodal trade gateways and external corridors.** Placed airports initialize [TradeGateway](./src/types.d.ts#L129-L150) nodes with outward boundary-projected [ExternalCorridor](./src/types.d.ts#L118-L127) vectors in [solveAndPlaceAirports](./src/entities/airport/placement.js#L84-L792). Hubs and cargo airfields receive dual corridors (`HUB`/`CRG`), while regional airfields receive a single corridor (`REG`). Virtual gateway proxy destinations (`id = 10000 + entityId`) integrate into road vehicle routing for multimodal freight transfer.
- **Organic unphased boroughs and multi-size RCI lots.** Boroughs use independent grid phases with a 2-tile parallel-street inhibition guard to form natural T-junctions. The fabric uses variable `3/4/5`-tile block strides and multi-dimension footprints (`3×2`, `2×3`, `2×2`, `2×1`, `1×2`). Lots include yard breathing room and outer empty-street pruning in [growUrbanFabric](./src/urban-fabric-solver.js#L806-L1058) and [buildFarmEstate](./src/entities/farm-estate/placement.js#L16-L1341).

### Road, expressway, and aviation trajectory invariants

- **Road and expressway trajectory guards**:
  - Roads cross rivers from bank to bank within 5 steps in [findRoadPathAStar](./src/urban-fabric-solver.js#L274-L635). Roads never braid lengthwise along river channels. Downstream, [deriveRoadTopology](./src/vehicle-routing.js#L149-L155) and [ensureVehicleRoutingGraph](./src/vehicle-routing.js#L395-L954) feed [MiniMotorwaysRenderer](./src/renderer.js#L48-L783) directly. Vehicle trajectories stay on committed pavement (`<= 0.55` tiles) across topological roundabout portals and directed Cloverleaf/Trumpet Bezier ramp chains in [buildDirectedLaneTrajectory](./src/vehicle-routing.js#L1382-L1600).
  - Expressways never cross airport pads, never run longitudinally inside rivers (`riverProxArc <= 14.5`), and never make acute V-turns (`cosTurn >= 0.35`, `cosWide >= 0.44`). Expressways may only share a town beltway roundabout when departing tangents are $\ge 110^\circ$ apart (`dot <= -0.34`) in [scoreMotorwaySamples](./src/expressway-solver.js#L449-L850). Highway curves resample to uniform arc-length steps (`targetDensity = 1.25`, `steps >= 64`, average step length `<= 0.95` tiles) in [sampleMotorwayCurve](./src/expressway-solver.js#L1370-L1425).
  - Interchanges enforce 1.50-tile house corridor clearance along all 4 cubic Bezier slip-ramps in [clearBuildingsAndTreesAlongDiamondRamps](./src/entities/interchange/placement.js#L974-L996). Geometry includes resized Cloverleaf interchanges (`outerDist = 3.65`, `leafSpan = 4.85`), 4-ramp Trumpet spurs (left outer slip-ramp, right outer slip-ramp, and concentric inner 270° bell loop + outer jug-handle bell), and compacted Diamond underpasses (`walked = 2.35`, `stepReach ≈ 2.15`, terminal vertex distance `Math.hypot(posTerm - center) <= 3.6` tiles).
  - Subterranean mountain tunnels (`elevationField >= seaLevel + 0.235` per [WORLD_GEOMETRY.ELEVATION_THRESHOLDS](./src/constants.js#L48-L53)) cast zero ground shadows and render full-width dashed bore walls. Tunnels never coalesce across a surface gap that contains a Cloverleaf or Trumpet interchange in [detectMountainExpresswayTunnels](./src/expressway-solver.js#L2444-L2524).
  - **Overpass Z-order and 2-plane shadows.** Motorway ground shadows coalesce into a single unified `groundShadowUnionPath` across crossing ramps and mainlines to prevent double-dark overlap artifacts. Grade-separated overpasses render in a dedicated retained `overpassBridgeDisplayList` above crossing lower carriageways. They cast clipped lower-deck drop shadows and carry upper-deck bridge decks with parapet railings. Node tagging with `onUpperBridge` in [ensureVehicleRoutingGraph](./src/vehicle-routing.js#L395-L954) enables elevated vehicle simulation.
- **Three-class aviation fleet, ATC, and trajectory guards**:
  - Aircraft follow [into-the-wind AirportATC controllers](./src/entities/airport/atc-actor.js#L1-L1050) and [10-state aircraft agent state machines](./src/entities/aircraft/plane-fsm.js#L1-L2065) (`GATE_LOADING -> PUSHBACK_HOLD -> TAXI_TO_RUNWAY -> HOLD_SHORT_QUEUE -> TAKEOFF_ROLL -> ENROUTE_CRUISE -> APPROACH_QUEUE -> LANDING_ROLLOUT -> HOLD_CROSSING_RUNWAY -> TAXI_TO_GATE`) at calibrated world-space speeds (`tiles/sec`).
  - Parked gate aircraft stay in their dedicated apron bay (`|gate.ly - taxiY| >= 1.4` tiles) off the taxiway spine. The ATC controller enforces 1D leader-follower non-passing separation (`>= 2.4` tiles) on `taxiwayOccupants`. Dual-runway hubs separate departures (`mainRwyY = -1.72*ts`) and arrivals (`outerRwyY = -3.35*ts`). Single-runway airfields enforce hold-short locks. The renderer renders ground-taxiing versus airborne Z-layers with apron gate T-markings, district livery accents, and quad-nacelle air cargo freighters in [MiniMotorwaysRenderer](./src/renderer.js#L48-L783) and [aircraft renderers](./src/entities/aircraft/render.js#L1-L456).
  - Aircraft agents in [LogisticsSimulator](./src/simulator.js#L80-L324) operate as a 3-class fleet: `WIDEBODY_FREIGHTER`, `FEEDER_TURBOPROP`, or `PASSENGER_JET`. Enforce the wide-body eligibility guard [canWidebodyServe](./src/entities/aircraft/flight-track.js#L30-L45): wide-body freighters serve only `HUB` and `CRG` airfields or off-map external corridors. Wide-body freighters never land at or depart from `REG` spoke airports. Feeder turboprops serve all airports including `REG` at calibrated flight speeds (`10.6 / 13.2 / 9.8` tiles/sec in [SIM_CONFIG.AVIATION](./src/constants.js#L86-L103)). Off-map external flights in [buildFlightTrack](./src/entities/aircraft/flight-track.js#L70-L290) transition across map borders at cruise altitude with automated international turnaround and import/export tracking. Freight trucks spawn via demand-weighted [spawnCar(true)](./src/entities/road-vehicle/car-stepper.js#L180-L260) scaling with `cargoLink.demandWeight`.

### EntityDefinition registry and single-writer fleet invariants

- **Cross-cutting `EntityDefinition` registry.** All 7 vertical domain entities register in [src/entities/registry.js](./src/entities/registry.js#L1-L438) and [src/entities/index.js](./src/entities/index.js#L1-L36) in ascending `hitPriority` order: `aircraft` (10), `road-vehicle` (12), `airport` (20), `rci-building` (30), `farm-estate` (35), `town` (40), and `interchange` (50).
  - Static inspectable entities (`airport`, `rci-building`, `town`) combine `place`, `recordStaticZLayers`, and `inspect` (`resolve`, `hitTest`, `getCameraTarget`, `renderDossier`, `describeLivePatch`).
  - Live fleet entities (`aircraft`, `road-vehicle`) combine `drawLiveZPass` and `inspect`.
  - Static infrastructure and land-use modules (`farm-estate`, `interchange`) encapsulate procedural `place` and `recordStaticZLayers` hooks.
  - All entity modules maintain zero DOM or `window` coupling.
- **Single-writer `AirportATCController` arbitrator.** Single-writer [AirportATCController](./src/entities/airport/atc-actor.js#L1-L1050) actors govern terminal gate reservations (`occupiedBy`/`reservedBy`), approach queues, and runway occupancy (`runwayBusyBy`/`depRunwayBusyBy`/`arrRunwayBusyBy`/`inboundPlaneIds`). ATC actors maintain a 1:1 bijection with `sim.planes`.
- **`Pose2D` and `CargoManifest` fleet invariants.** All `CarAgent` and `PlaneAgent` entities maintain continuous [Pose2D](./src/types.d.ts#L988-L995) records (`x, y, ang, zLayer, speed, altitude`). This supports sub-pixel interpolation and spatial hit-testing without recalculating lane geometry. Freight semi-trucks and cargo freighters carry immutable [CargoManifest](./src/types.d.ts#L997-L1010) supply-chain manifests.

### State architecture and URL serialization invariants

- **Store as single source of truth across four domains.** Keep `seed`, map generation parameters, view state (`activeLayer`, `drawerOpen`, viewport-independent `camera: { cx, cy, zoom } | null`), and interaction state (`simSpeed`, `inspected: { type, id, entity }`) inside the selector store in [src/state.js](./src/state.js#L279-L686) and [src/types.d.ts](./src/types.d.ts#L1345-L1352). Do not scrape the DOM for application state.
- **Boundary parsing and canonical query strings.** Parse and validate all search query parameters at the system boundary in [src/url-state.js](./src/url-state.js#L1-L613). Sliders clamp to valid ranges. Invalid enum values fall back to defaults. The `camera` parameter requires complete, finite `(cx, cy, z)` triples (`z` in `[0.16, 3.5]`). The parser validates all 9 orthogonal landform archetypes (`confluence`, `inland`, `alpine-passes`, `fjord-sound`, `isthmus-strait`, `caldera-basin`, `barrier-lagoon`, `canyon-gorge`, `island-hopper`) and the 6 continuous geomorphology scalars (`relief`, `incision`, `indent`, `caldera`, `barrier`, `basins`).
- **Gesture-end commits and history navigation separation.** Drag-pan and pinch-zoom gestures mutate memory at 60fps. Coordinates commit to the store and URL upon gesture completion (`pointerup` or `pointercancel`), with a 150ms trailing debounce for `wheel` ticks in [src/main.js](./src/main.js#L157-L200). Discrete navigational changes (`seed`, `worldSize`, `archetype`, and entity inspector drill-down) commit through `history.pushState`. Continuous adjustments (slider commits on `change`, camera gestures, simulation speed, drawer state) update in place through `history.replaceState` protected by a re-entrant `popstate` guard.
