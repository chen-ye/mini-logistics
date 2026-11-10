# Mini Logistics

A state-scale procedural world generator and multi-modal transportation logistics simulator inspired by **OpenTTD** (*TerraGenesis*) and **Mini Motorways** / **Mini Metro**.

The project synthesizes a 360×224-tile regional landscape—complete with emergent tectonic mountain ranges, non-bifurcating river watersheds, central-place urban hierarchies, residential/commercial/industrial (RCI) zoning, multi-tier airports, grade-separated expressway networks, and an active inter-industrial freight supply chain—entirely in native browser ES Modules, an off-thread Web Worker pipeline, and retained `Path2D` vector display lists with zero build steps.

---

## Quick Start

Serve the repository root over the static development server so native ES Modules and the module Web Workers can load:

```sh
bun run dev
```

Then open `http://127.0.0.1:8788/index.html` in a modern browser.

---

## Verification, Git Hooks & Longitudinal Benchmarking

The repository stays 100% buildless in the browser while enforcing static formatting, linting, JSDoc typechecking (`strictNullChecks: true`) against the [shared Hourglass domain schema](./src/types.d.ts#L1-L802) and [centralized grid & geometry constants](./src/constants.js#L1-L175), pure algorithmic/worldgen invariant tests, static HTML-to-JS DOM contract checks, longitudinal performance delta benchmarks, and real-browser Playwright E2E verification:

```sh
# Format check (native Bun formatter)
bun fmt --no-script --check src/ tests/ playwright.config.js index.html

# Lint check
bunx oxlint --deny-warnings src/ tests/

# JSDoc typecheck (native Bun TypeScript checker)
bun check --no-script

# Pure algorithmic, worldgen invariant & DOM contract unit tests (zero DOM mocks)
bun test --check tests/unit

# Longitudinal per-stage & end-to-end performance delta benchmark vs baseline
bun run bench --compare benchmarks/baseline.json --markdown

# Real headless Chromium E2E tests via Playwright
bunx playwright test

# Run all static checks, unit tests, and Playwright E2E gates
bun run check
```

Running `bun install` automatically configures versioned Git hooks via `"prepare": "git config core.hooksPath .githooks"` in [package.json](./package.json#L11-L24), running the [pre-commit formatting, staged lint, and JSDoc typecheck gate](./.githooks/pre-commit#L1-L6) and the [pre-push unit & worldgen invariant gate](./.githooks/pre-push#L1-L4).

---

## Procedural Generation Pipeline

World synthesis runs off the main thread inside the [world generation Web Worker](./src/world-worker.js#L1-L29), executing a 9-stage memoized reactive DAG backed by a [3-entry bounded LRU stage combinator](./src/state.js#L81-L125) and orchestrated by the [procedural world pipeline](./src/world-generator.js#L1354-L2020):

1. **Prevailing Wind & Orographic Climate**: Locks a seed-deterministic [prevailing wind vector](./src/world-generator.js#L484-L499) from [shared runway wind axes](./src/constants.js#L124-L150) that governs both airport runway orientation and [windward/leeward orographic moisture](./src/world-generator.js#L544-L612) across mountain slopes.
2. **Stage 2A — Pluggable Terrain Synthesis**: The [terrain heightmap and basin solver](./src/terrain-solvers.js#L14-L574) supports three live-switchable geomorphology engines behind a shared quantile sea-level calibration waist:
   - **Anisotropic Strike fBm + Ridged Multifractal Spines**: Domain-warped gradient noise rotated into a seed-unique geological strike frame with folded valleys and sharp mountain backbones.
   - **Quilez Analytic Derivative-Eroded fBm**: Uses [quintic analytic partial derivatives](./src/math.js#L155-L223) to damp high-frequency octaves on steep gradients, flattening alluvial plains and sharpening eroded crags in a single pass.
   - **Domain-Warped Voronoi Tectonic Micro-Plates**: Models 15 Poisson-spaced crustal plates whose convergent sutures buckle into cordillera ranges and divergent sutures form rift basins.
   - **Drowned-Cordillera Island Hopper**: Synthesizes curved volcanic island arcs, multi-lobe peninsular massifs, Voronoi-eroded sea straits, and trailing satellite islets.
3. **Stage 2B — Pluggable Fluvial Hydrology**: The [fluvial hydrology solver](./src/hydrology-solvers.js#L24-L913) carves physical river channels and alluvial valleys using a shared [flat typed-array binary min-heap](./src/math.js#L233-L328) across three selectable engines:
   - **Basin Tree + Downhill A\* Thalwegs**: Links interior lakes to lower basins via non-bifurcating outflows and routes map-border and highland-spring rivers down valley thalwegs.
   - **Priority-Flood + D8 Strahler Tributary Networks**: Fills terrain depressions via a min-heap Priority-Flood pass and traces steepest-descent D8 rivers into converging confluences.
   - **Ikeda Floodplain Meanders**: Evolves compound sinusoidal S-bends across low-slope alluvial plains while keeping highland gorges tight.
4. **Spatial Distance & Alluvial Suitability Fields**: Computes an 8-neighbor [Euclidean water-distance transform, slope gradient field, and Connected Landmass labeling](./src/world-generator.js#L501-L667) to guide settlement and road placement.
5. **Central Place Settlement Seeding & Multi-Tier Airport Solver**: Seeds a [4-tier Christaller settlement hierarchy](./src/world-generator.js#L715-L894) (Metropolises, Regional Cities, Market Towns, and Rural Hamlets) and places [wind-aligned International Dual-Runway Hubs, Regional Airports, and Cargo Airfields](./src/airport-solver.js#L3-L625) with NIMBY noise exclusion rings and obstacle-free approach funnels.
6. **Organic Multi-Borough Grids & Regional A\* Road Network**: Carves [unphased multi-borough street grids](./src/urban-fabric-solver.js#L1021-L1256) with variable `3/4/5`-tile block strides and T-junctions, then links settlements and airport terminal loops via [valley-following A\* arterials and perpendicular bank-to-bank bridges](./src/urban-fabric-solver.js#L7-L1019) using pooled [A\* pathfinding scratch buffers](./src/world-generator.js#L128-L164).
7. **Multi-Dimension RCI Zoning & Agricultural Estates**: Packs city blocks with [dimensionally varied footprints](./src/urban-fabric-solver.js#L1258-L2371)—concentrating Commercial high-rise rotundas, elongated arterial retail halls (`3×2` / `2×3`), and compact corner markets (`2×1` / `1×2`) along downtown boulevards, surrounding them with residential cottages/townhouses with yard breathing room, and placing peripheral Industrial extraction silos, [recursive BSP farm estates with contour-clipped crop strips and broken-grid tractor tracks](./src/farm-estate-solver.js#L10-L1260), sawtooth factories, and cross-dock warehouses.
8. **Expressways, Grade-Separated Interchanges, Mountain Tunnels & Right-of-Way Clearance**: Routes numbered expressways along a [coarse-grid A\* valley corridor smoothed with Chaikin B-splines](./src/expressway-solver.js#L810-L1351), constructing [4-way Cloverleaf interchanges, 3-way Trumpet spurs, shared beltway roundabouts, octilinear diamond underpasses with flexible world-space slip-ramps, subterranean mountain tunnel bores, and unified eminent-domain right-of-way clearance](./src/expressway-solver.js#L1387-L3845).
9. **Reactive Road/Route Graph, Cargo Chain & Woodland Biomes**: Derives the [memoized road topology and multi-modal vehicle routing graph](./src/vehicle-routing.js#L27-L954) with geometry-accurate Cloverleaf/Trumpet Bezier ramp chains and topological roundabout portals, links raw extraction to factories, logistics hubs, and commercial CBDs along [paved-road and expressway freight corridors](./src/vehicle-routing.js#L956-L1508), and populates [orographic windward woodlands and spring headwater groves](./src/urban-fabric-solver.js#L2440-L2600).

---

## Interactive Views, Reactive State & Simulation

The [vector canvas renderer](./src/renderer.js#L46-L4052), [traffic and 5-phase gate-to-gate aviation simulator](./src/simulator.js#L29-L743), [signal-grade immutable selector store](./src/state.js#L28-L454), and [Light-DOM entity inspector custom element](./src/inspector-component.js#L28-L776) run at 60fps with six live-switchable inspector layers in the [UI controller](./src/main.js#L1-L861):

- **Mini Motorways View**: Full aesthetic cartography with octilinear Marching-Squares elevation terraces, cohesive woodland canopies, multi-tier airports with [into-the-wind AirportATC controllers and 10-state aircraft agent state machines](./src/simulator.js#L28-L1320) (`GATE_LOADING -> PUSHBACK_HOLD -> TAXI_TO_RUNWAY -> HOLD_SHORT_QUEUE -> TAKEOFF_ROLL -> ENROUTE_CRUISE -> APPROACH_QUEUE -> LANDING_ROLLOUT -> HOLD_CROSSING_RUNWAY -> TAXI_TO_GATE`), off-spine gate stands, 1D collision-free taxiway queuing, dual-runway hub separation, [district-livery passenger jets and quad-nacelle air cargo freighters](./src/renderer.js#L3105-L3330), elevated expressways, subterranean tunnel bores, commuter cars, and articulated freight semi-trucks.
- **RCI & Cargo Chain View**: Highlights Residential (emerald), Commercial CBD/Arterial (royal blue), and 3-stage Industrial facilities (amber extraction silos $\rightarrow$ orange sawtooth factories $\rightarrow$ purple cross-dock hubs $\rightarrow$ blue CBD sinks) with road-routed freight flow vectors.
- **Airport Cones**: Visualizes the multi-criteria airport suitability heatmap, urban NIMBY exclusion rings, and bidirectional runway approach clearance funnels.
- **Central Place Graph**: Overlays settlement tier radii, IATA codes, and inter-city hierarchy links.
- **Topography & Hydro**: Displays latent upland elevation bands, alluvial urban suitability scores, and watershed confluences.
- **Road Grid & Graph**: Overlays [tile-grid road masks, vector road graph edges, directed right-hand lane trajectories, roundabout orbits, interchange ramp graphs, degree $\ge 3$ junctions, and topological anomaly diagnostics](./src/renderer.js#L3643-L4035) directly downstream of the derived [road topology](./src/vehicle-routing.js#L27-L155).
- **Bidirectional URL State Serialization & Deep Linking**: Pure boundary parsing and canonical query serialization in [src/url-state.js](./src/url-state.js#L1-L450) and reactive store-to-history synchronization in [src/main.js](./src/main.js#L140-L1280) make every generated world, camera vantage, inspector layer, and inspected facility deep-linkable and shareable:
  - **Deterministic Query Schema**: `seed` (sanitized printable string $\le 48$ chars), `size` (`compact|standard|large|huge`), `arch` (`confluence|estuary|archipelago|inland|island-hopper`), `terrain` (`tectonic-fbm|quilez-erosion|voronoi-plates`), `hydro` (`thalweg-astar|d8-strahler|meandering-plain`), `airMix` (`hub-regional|hub-reg-cargo|dual-hub`), `ramps` (`1|0`), `water` (`20..80`), `towns` (`8..44`), `density` (`50..350`), `airports` (`1..8`), `wind` (`-1..3`), `layer` (`aesthetic|rci|airport|hierarchy|hydrology|roadgrid`), `drawer` (`1|0`), `cx`, `cy`, `z` (viewport-independent world-tile center and zoom in `0.16..3.5`), `speed` (`0|1|2.5`), and `inspect` (`airport:<id>|town:<id>|building:<id>`).
  - **Gesture-End Commit Discipline**: Zero-overhead 60fps canvas dragging and multi-touch pinch-to-zoom; camera world-tile coordinates `(cx, cy, z)` commit to the store and URL strictly when the gesture finishes on `pointerup`/`pointercancel` (and on a 150ms trailing debounce for `wheel` zoom notches).
  - **Push vs. Replace History Semantics**: Discrete transitions (new seed submission, scale presets, archetype switches, entity inspector drill-down jumps) push browser history entries (`history.pushState`), while continuous slider commits (`change`), camera gestures, simulation speeds, and drawer toggles update in place (`history.replaceState`), protected by a re-entrant `popstate` guard.

---

## Platform & Performance Architecture

- **Zero-Build Native ES Modules & Deep-Module Decomposition**: Clean separation across the [HTML shell](./index.html), [CSS containment styles](./src/styles.css), [shared domain type declarations](./src/types.d.ts), [centralized constants & enums](./src/constants.js), [PRNG, derivative noise & flat min-heap math](./src/math.js), [color palette](./src/palette.js), [immutable selector store & 3-entry LRU memoizer](./src/state.js), [entity inspector Web Component](./src/inspector-component.js), [terrain solvers](./src/terrain-solvers.js), [hydrology solvers](./src/hydrology-solvers.js), [airport solver](./src/airport-solver.js), [urban fabric solver](./src/urban-fabric-solver.js), [farm estate solver](./src/farm-estate-solver.js), [expressway solver](./src/expressway-solver.js), [vehicle routing & cargo chain solver](./src/vehicle-routing.js), [world pipeline orchestrator](./src/world-generator.js), [world worker](./src/world-worker.js), [declarative VectorLayerRecorder & Marching-Squares polygonizer](./src/canvas-layer-cache.js), [simulator](./src/simulator.js), [renderer](./src/renderer.js), [main controller](./src/main.js), and [longitudinal benchmark harness](./scripts/bench.js).
- **Retained `VectorLayerRecorder` `Path2D` Display-List Pipeline (`~0.4 ms` / Frame at 60fps)**: Static world geometry is recorded once per world/layer into [retained `VectorLayerRecorder` display lists](./src/renderer.js#L175-L410) (`hydroDisplayList`, `urbanTerrainDisplayList`, `surfaceNetworkDisplayList`, `motorwayDisplayList`, and deduplicated [airway corridors](./src/renderer.js#L368-L395)) built on `Path2D.prototype.addPath(subPath, domMatrix)` in [src/canvas-layer-cache.js](./src/canvas-layer-cache.js#L144-L759), coalescing ~4,500+ fine-grained Canvas2D calls (including ~1,000 houses, multi-part RCI facilities, contour-clipped farm estates, grade-separated interchanges, and dashed cubic-Bezier airways) into native C++ `Path2D` batches that replay in `~0.4 ms` (`p50`) on both `standard` (`360×224`) and `huge` (`720×448`) maps while staying 100% crisp vector at any zoom level (`0.25x–3.5x`).
- **Zero-Copy Worker Transfer**: All 12 spatial TypedArrays transfer from the [world worker](./src/world-worker.js#L1-L29) to the main thread in 0ms via [structured-clone Transferable ArrayBuffers](./src/world-generator.js#L2025-L2110).
