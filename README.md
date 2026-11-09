# Mini Logistics

A state-scale procedural world generator and multi-modal transportation logistics simulator inspired by **OpenTTD** (*TerraGenesis*) and **Mini Motorways** / **Mini Metro**.

The project synthesizes a 360×224-tile regional landscape—complete with emergent tectonic mountain ranges, non-bifurcating river watersheds, central-place urban hierarchies, residential/commercial/industrial (RCI) zoning, multi-tier airports, grade-separated expressway networks, and an active inter-industrial freight supply chain—entirely in native browser ES Modules and a parallel dual-worker pipeline with zero build steps.

---

## Quick Start

Serve the repository root over the static development server so native ES Modules and the module Web Workers can load:

```sh
bun run dev
```

Then open `http://127.0.0.1:8788/index.html` in a modern browser.

---

## Verification, Git Hooks & Longitudinal Benchmarking

The repository stays 100% buildless in the browser while enforcing static formatting, linting, JSDoc typechecking against the [shared Hourglass domain schema](./src/types.d.ts#L1-L769) and [centralized grid & geometry constants](./src/constants.js#L1-L166), pure algorithmic/worldgen invariant tests, static HTML-to-JS DOM contract checks, longitudinal performance delta benchmarks, and real-browser Playwright E2E verification:

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

World synthesis runs off the main thread across the [world generation Web Worker](./src/world-worker.js#L1-L156) and the parallel [offscreen terrain bitmap baker Worker](./src/terrain-bake-worker.js#L44-L676), executing a 9-stage memoized reactive DAG backed by a [3-entry bounded LRU stage combinator](./src/state.js#L81-L125) and orchestrated by the [procedural world pipeline](./src/world-generator.js#L1354-L2015):

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
9. **Reactive Road/Route Graph, Cargo Chain & Woodland Biomes**: Derives the [memoized road topology and multi-modal vehicle routing graph](./src/vehicle-routing.js#L22-L578), links raw extraction to factories, logistics hubs, and commercial CBDs along [paved-road and expressway freight corridors](./src/vehicle-routing.js#L580-L1113), and populates [orographic windward woodlands and spring headwater groves](./src/urban-fabric-solver.js#L2373-L2537).

---

## Interactive Views, Reactive State & Simulation

The [vector canvas renderer](./src/renderer.js#L23-L3492), [traffic/aviation simulator](./src/simulator.js#L8-L219), [signal-grade immutable selector store](./src/state.js#L28-L455), and [Light-DOM entity inspector custom element](./src/inspector-component.js#L28-L774) run at 60fps with six live-switchable inspector layers in the [UI controller](./src/main.js#L1-L858):

- **Mini Motorways View**: Full aesthetic cartography with octilinear Marching-Squares elevation terraces, cohesive woodland canopies, multi-tier airports, elevated expressways, subterranean tunnel bores, commuter cars, articulated freight semi-trucks, and cubic-Bezier aircraft.
- **RCI & Cargo Chain View**: Highlights Residential (emerald), Commercial CBD/Arterial (royal blue), and 3-stage Industrial facilities (amber extraction silos $\rightarrow$ orange sawtooth factories $\rightarrow$ purple cross-dock hubs $\rightarrow$ blue CBD sinks) with road-routed freight flow vectors.
- **Airport Cones**: Visualizes the multi-criteria airport suitability heatmap, urban NIMBY exclusion rings, and bidirectional runway approach clearance funnels.
- **Central Place Graph**: Overlays settlement tier radii, IATA codes, and inter-city hierarchy links.
- **Topography & Hydro**: Displays latent upland elevation bands, alluvial urban suitability scores, and watershed confluences.
- **Road Grid & Graph**: Overlays [tile-grid road masks, vector road graph edges, degree $\ge 3$ junctions, and topological anomaly diagnostics](./src/renderer.js#L3076-L3269) directly downstream of the derived [road topology](./src/vehicle-routing.js#L22-L142).

---

## Platform & Performance Architecture

- **Zero-Build Native ES Modules & Deep-Module Decomposition**: Clean separation across the [HTML shell](./index.html), [CSS containment styles](./src/styles.css), [shared domain type declarations](./src/types.d.ts), [centralized constants & enums](./src/constants.js), [PRNG, derivative noise & flat min-heap math](./src/math.js), [color palette](./src/palette.js), [immutable selector store & 3-entry LRU memoizer](./src/state.js), [entity inspector Web Component](./src/inspector-component.js), [terrain solvers](./src/terrain-solvers.js), [hydrology solvers](./src/hydrology-solvers.js), [airport solver](./src/airport-solver.js), [urban fabric solver](./src/urban-fabric-solver.js), [farm estate solver](./src/farm-estate-solver.js), [expressway solver](./src/expressway-solver.js), [vehicle routing & cargo chain solver](./src/vehicle-routing.js), [world pipeline orchestrator](./src/world-generator.js), [world worker](./src/world-worker.js), [shared Marching-Squares & terrain bake worker](./src/terrain-bake-worker.js), [simulator](./src/simulator.js), [renderer](./src/renderer.js), [main controller](./src/main.js), and [longitudinal benchmark harness](./scripts/bench.js).
- **Parallel Dual-Worker Pipeline + Post-Clearance Terrain Composition**: Immediately after Stage 2B hydrology finishes on Core 1, the [world worker](./src/world-worker.js#L21-L72) streams hydrology buffers over a dedicated `MessageChannel` to the [terrain bake worker](./src/terrain-bake-worker.js#L443-L676) on Core 2 so Marching-Squares contours and rivers rasterize onto an `OffscreenCanvas` while Stages 3–8 run in parallel. Once Stage 9 right-of-way clearance removes trees underneath expressway decks and interchanges, Core 2 composes the final `ImageBitmap` concurrently with Stage 9 freight and commuter routing on Core 1, and all 12 spatial TypedArrays transfer to the main thread in 0ms via [structured-clone Transferable ArrayBuffers](./src/world-generator.js#L2021-L2107).
- **50ms-Budgeted Yielding Terrain Bake Fallback**: When running on the main thread without `OffscreenCanvas`, Marching-Squares contour and river baking in the [async offscreen terrain baker](./src/renderer.js#L128-L253) shares the [unified Marching-Squares polygonizer](./src/terrain-bake-worker.js#L44-L276) and yields via `scheduler.yield()` (with a `setTimeout` fallback) whenever a pass exceeds 50ms, swapping the completed offscreen canvas atomically so live animation never drops a frame.
