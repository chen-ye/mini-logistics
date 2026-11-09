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

## Verification & Testing

The repository stays 100% buildless in the browser while enforcing static formatting, linting, JSDoc typechecking against the [shared Hourglass domain schema](./src/types.d.ts#L1-L580), pure algorithmic unit/invariant tests, and real-browser Playwright E2E verification:

```sh
# Format check (native Bun formatter)
bun fmt --no-script --check src/ tests/ playwright.config.js index.html

# Lint check
bunx oxlint --deny-warnings src/ tests/

# JSDoc typecheck (native Bun TypeScript checker)
bun check --no-script

# Pure algorithmic & worldgen invariant unit tests (zero DOM mocks)
bun test --check tests/unit

# Real headless Chromium E2E tests via Playwright
bunx playwright test

# Run all static checks, unit tests, and Playwright E2E gates
bun run check
```

---

## Procedural Generation Pipeline

World synthesis runs off the main thread across the [world generation Web Worker](./src/world-worker.js#L1-L162) and the parallel [offscreen terrain bitmap baker Worker](./src/terrain-bake-worker.js#L19-L407), executing a 9-stage memoized reactive DAG orchestrated by the [procedural world pipeline](./src/world-generator.js#L10278-L10890):

1. **Prevailing Wind & Orographic Climate**: Locks a seed-deterministic [prevailing wind vector](./src/world-generator.js#L402-L429) that governs both airport runway orientation and [windward/leeward orographic moisture](./src/world-generator.js#L540-L575) across mountain slopes.
2. **Stage 2A — Pluggable Terrain Synthesis**: The [terrain heightmap and basin solver](./src/terrain-solvers.js#L14-L558) supports three live-switchable geomorphology engines behind a shared quantile sea-level calibration waist:
   - **Anisotropic Strike fBm + Ridged Multifractal Spines**: Domain-warped gradient noise rotated into a seed-unique geological strike frame with folded valleys and sharp mountain backbones.
   - **Quilez Analytic Derivative-Eroded fBm**: Uses [quintic analytic partial derivatives](./src/math.js#L155-L220) to damp high-frequency octaves on steep gradients, flattening alluvial plains and sharpening eroded crags in a single pass.
   - **Domain-Warped Voronoi Tectonic Micro-Plates**: Models 15 Poisson-spaced crustal plates whose convergent sutures buckle into cordillera ranges and divergent sutures form rift basins.
   - **Drowned-Cordillera Island Hopper**: Synthesizes curved volcanic island arcs, multi-lobe peninsular massifs, Voronoi-eroded sea straits, and trailing satellite islets.
3. **Stage 2B — Pluggable Fluvial Hydrology**: The [fluvial hydrology solver](./src/hydrology-solvers.js#L21-L968) carves physical river channels and alluvial valleys using one of three selectable engines:
   - **Basin Tree + Downhill A\* Thalwegs**: Links interior lakes to lower basins via non-bifurcating outflows and routes map-border and highland-spring rivers down valley thalwegs.
   - **Priority-Flood + D8 Strahler Tributary Networks**: Fills terrain depressions via a min-heap Priority-Flood pass and traces steepest-descent D8 rivers into converging confluences.
   - **Ikeda Floodplain Meanders**: Evolves compound sinusoidal S-bends across low-slope alluvial plains while keeping highland gorges tight.
4. **Spatial Distance & Alluvial Suitability Fields**: Computes an 8-neighbor [Euclidean water-distance transform, slope gradient field, and Connected Landmass labeling](./src/world-generator.js#L496-L720) to guide settlement and road placement.
5. **Central Place Settlement Seeding & Multi-Tier Airport Solver**: Seeds a [4-tier Christaller settlement hierarchy](./src/world-generator.js#L723-L942) (Metropolises, Regional Cities, Market Towns, and Rural Hamlets) and places [wind-aligned International Dual-Runway Hubs, Regional Airports, and Cargo Airfields](./src/world-generator.js#L945-L1519) with NIMBY noise exclusion rings and obstacle-free approach funnels.
6. **Organic Multi-Borough Grids & Regional A\* Road Network**: Carves [unphased multi-borough street grids](./src/world-generator.js#L2533-L2770) with variable `3/4/5`-tile block strides and T-junctions, then links settlements and airport terminal loops via [valley-following A\* arterials and perpendicular bank-to-bank bridges](./src/world-generator.js#L1522-L2530).
7. **Multi-Dimension RCI Zoning**: Packs city blocks with [dimensionally varied footprints](./src/world-generator.js#L2772-L5420)—concentrating Commercial high-rise rotundas, elongated arterial retail halls (`3×2` / `2×3`), and compact corner markets (`2×1` / `1×2`) along downtown boulevards, surrounding them with residential cottages/townhouses with yard breathing room, and placing peripheral Industrial extraction silos, sprawling BSP farm estates, sawtooth factories, and cross-dock warehouses.
8. **Expressways, Grade-Separated Interchanges & Mountain Tunnels**: Routes numbered expressways along a [coarse-grid A\* valley corridor smoothed with Chaikin B-splines](./src/world-generator.js#L6970-L7615), constructing [4-way Cloverleaf interchanges, 3-way Trumpet spurs, shared beltway roundabouts, octilinear diamond underpasses with flexible world-space slip-ramps, and subterranean mountain tunnel bores](./src/world-generator.js#L7618-L10005).
9. **Inter-Industrial Cargo Chain & Woodland Biomes**: Links raw extraction to factories, logistics hubs, and commercial CBDs along [paved-road and expressway freight corridors](./src/world-generator.js#L5778-L6110) and populates [orographic windward woodlands and spring headwater groves](./src/world-generator.js#L10008-L10180).

---

## Interactive Views & Simulation

The [vector canvas renderer](./src/renderer.js#L15-L4075) and [traffic/aviation simulator](./src/simulator.js#L7-L202) run at 60fps with six live-switchable inspector layers in the [UI controller](./src/main.js#L1-L1150):

- **Mini Motorways View**: Full aesthetic cartography with octilinear Marching-Squares elevation terraces, cohesive woodland canopies, multi-tier airports, elevated expressways, subterranean tunnel bores, commuter cars, articulated freight semi-trucks, and cubic-Bezier aircraft.
- **RCI & Cargo Chain View**: Highlights Residential (emerald), Commercial CBD/Arterial (royal blue), and 3-stage Industrial facilities (amber extraction silos $\rightarrow$ orange sawtooth factories $\rightarrow$ purple cross-dock hubs $\rightarrow$ blue CBD sinks) with road-routed freight flow vectors.
- **Airport Cones**: Visualizes the multi-criteria airport suitability heatmap, urban NIMBY exclusion rings, and bidirectional runway approach clearance funnels.
- **Central Place Graph**: Overlays settlement tier radii, IATA codes, and inter-city hierarchy links.
- **Topography & Hydro**: Displays latent upland elevation bands, alluvial urban suitability scores, and watershed confluences.
- **Road Grid & Graph**: Overlays [tile-grid road masks, vector road graph edges, degree $\ge 3$ junctions, and topological anomaly diagnostics](./src/renderer.js#L3551-L3805).

---

## Platform & Performance Architecture

- **Zero-Build Native ES Modules & Comment-Only JSDoc Types**: Clean separation across the [HTML shell](./index.html), [CSS containment styles](./src/styles.css), [shared domain type declarations](./src/types.d.ts), [PRNG & derivative noise math](./src/math.js), [color palette](./src/palette.js), [terrain solvers](./src/terrain-solvers.js), [hydrology solvers](./src/hydrology-solvers.js), [world generator](./src/world-generator.js), [world worker](./src/world-worker.js), [terrain bake worker](./src/terrain-bake-worker.js), [simulator](./src/simulator.js), [renderer](./src/renderer.js), and [main controller](./src/main.js).
- **Parallel Dual-Worker Pipeline + Zero-Copy Transferables**: Immediately after Stage 2B hydrology finishes on Core 1, the [world worker](./src/world-worker.js#L16-L73) streams hydrology buffers over a dedicated `MessageChannel` to the [terrain bake worker](./src/terrain-bake-worker.js#L19-L407) on Core 2 so Marching-Squares contours and rivers rasterize onto an `OffscreenCanvas` while Stages 3–9 run in parallel. All 12 spatial TypedArrays and the composed `ImageBitmap` transfer to the main thread in 0ms via [structured-clone Transferable ArrayBuffers](./src/world-generator.js#L10892-L10970).
- **50ms-Budgeted Yielding Terrain Bake Fallback**: When running on the main thread without `OffscreenCanvas`, Marching-Squares contour and river baking in the [async offscreen terrain baker](./src/renderer.js#L314-L530) yields via `scheduler.yield()` (with a `setTimeout` fallback) whenever a pass exceeds 50ms, then swaps the completed offscreen canvas atomically so live animation never drops a frame.
