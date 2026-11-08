# Mini Logistics

A state-scale procedural world generator and multi-modal transportation logistics simulator inspired by **OpenTTD** (*TerraGenesis*) and **Mini Motorways** / **Mini Metro**.

The project synthesizes a 360×224-tile regional landscape—complete with emergent tectonic mountain ranges, non-bifurcating river watersheds, central-place urban hierarchies, residential/commercial/industrial (RCI) zoning, multi-tier airports, grade-separated expressway networks, and an active inter-industrial freight supply chain—entirely in native browser ES Modules and a background Web Worker with zero build steps.

---

## Quick Start

Serve the repository root over any static HTTP server so native ES Modules and the module Web Worker can load:

```sh
python3 -m http.server 8788
```

Then open `http://127.0.0.1:8788/index.html` in a modern browser.

---

## Procedural Generation Pipeline

World synthesis runs off the main thread inside the [dedicated module Web Worker](./src/world-worker.js#L1-L8) and executes a 9-stage constructive pipeline orchestrated by the [procedural world generator](./src/world-generator.js#L15-L78):

1. **Prevailing Wind & Orographic Climate**: Locks a seed-deterministic [prevailing wind vector](./src/world-generator.js#L80-L106) that governs both airport runway orientation and [windward/leeward orographic moisture](./src/world-generator.js#L215-L242) across mountain slopes.
2. **Stage 2A — Pluggable Terrain Synthesis**: The [terrain heightmap and basin solver](./src/terrain-solvers.js#L8-L410) supports three live-switchable geomorphology engines behind a shared quantile sea-level calibration waist:
   - **Anisotropic Strike fBm + Ridged Multifractal Spines**: Domain-warped gradient noise rotated into a seed-unique geological strike frame with folded valleys and sharp mountain backbones.
   - **Quilez Analytic Derivative-Eroded fBm**: Uses [quintic analytic partial derivatives](./src/math.js#L50-L115) to damp high-frequency octaves on steep gradients, flattening alluvial plains and sharpening eroded crags in a single pass.
   - **Domain-Warped Voronoi Tectonic Micro-Plates**: Models 15 Poisson-spaced crustal plates whose convergent sutures buckle into cordillera ranges and divergent sutures form rift basins.
   - **Drowned-Cordillera Island Hopper**: Synthesizes curved volcanic island arcs, multi-lobe peninsular massifs, Voronoi-eroded sea straits, and trailing satellite islets.
3. **Stage 2B — Pluggable Fluvial Hydrology**: The [fluvial hydrology solver](./src/hydrology-solvers.js#L13-L618) carves physical river channels and alluvial valleys using one of three selectable engines:
   - **Basin Tree + Downhill A\* Thalwegs**: Links interior lakes to lower basins via non-bifurcating outflows and routes map-border and highland-spring rivers down valley thalwegs.
   - **Priority-Flood + D8 Strahler Tributary Networks**: Fills terrain depressions via a min-heap Priority-Flood pass and traces steepest-descent D8 rivers into converging confluences.
   - **Ikeda Floodplain Meanders**: Evolves compound sinusoidal S-bends across low-slope alluvial plains while keeping highland gorges tight.
4. **Spatial Distance & Alluvial Suitability Fields**: Computes an 8-neighbor [Euclidean water-distance transform, slope gradient field, and Connected Landmass labeling](./src/world-generator.js#L182-L290) to guide settlement and road placement.
5. **Central Place Settlement Seeding & Multi-Tier Airport Solver**: Seeds a [4-tier Christaller settlement hierarchy](./src/world-generator.js#L292-L448) (Metropolises, Regional Cities, Market Towns, and Rural Hamlets) and places [wind-aligned International Dual-Runway Hubs, Regional Airports, and Cargo Airfields](./src/world-generator.js#L453-L685) with NIMBY noise exclusion rings and obstacle-free approach funnels.
6. **Organic Multi-Borough Grids & Regional A\* Road Network**: Carves [unphased multi-borough street grids](./src/world-generator.js#L1215-L1358) with variable `3/4/5`-tile block strides and T-junctions, then links settlements and airport terminal loops via [valley-following A\* arterials and perpendicular bank-to-bank bridges](./src/world-generator.js#L688-L1212).
7. **Multi-Dimension RCI Zoning**: Packs city blocks with [dimensionally varied footprints](./src/world-generator.js#L1515-L1845)—concentrating Commercial high-rise rotundas, elongated arterial retail halls (`3×2` / `2×3`), and compact corner markets (`2×1` / `1×2`) along downtown boulevards, surrounding them with residential cottages/townhouses with yard breathing room, and placing peripheral Industrial extraction silos, sawtooth factories, and cross-dock warehouses.
8. **Expressways, Grade-Separated Interchanges & Mountain Tunnels**: Routes numbered expressways along a [coarse-grid A\* valley corridor smoothed with Chaikin B-splines](./src/world-generator.js#L2440-L2765), constructing [4-way Cloverleaf interchanges, 3-way Trumpet spurs, shared beltway roundabouts, 1-sided diamond slip-ramps, and subterranean mountain tunnel bores](./src/world-generator.js#L2768-L3840).
9. **Inter-Industrial Cargo Chain & Woodland Biomes**: Links raw extraction to factories, logistics hubs, and commercial CBDs along [paved-road freight corridors](./src/world-generator.js#L1848-L1945) and populates [orographic windward woodlands and spring headwater groves](./src/world-generator.js#L3842-L3895).

---

## Interactive Views & Simulation

The [vector canvas renderer](./src/renderer.js#L6-L1980) and [traffic/aviation simulator](./src/simulator.js#L6-L166) run at 60fps with five live-switchable inspector layers in the [UI controller](./src/main.js#L1-L545):

- **Mini Motorways View**: Full aesthetic cartography with octilinear Marching-Squares elevation terraces, cohesive woodland canopies, multi-tier airports, elevated expressways, subterranean tunnel bores, commuter cars, articulated freight semi-trucks, and cubic-Bezier aircraft.
- **RCI & Cargo Chain View**: Highlights Residential (emerald), Commercial CBD/Arterial (royal blue), and 3-stage Industrial facilities (amber extraction silos $\rightarrow$ orange sawtooth factories $\rightarrow$ purple cross-dock hubs $\rightarrow$ blue CBD sinks) with road-routed freight flow vectors.
- **Airport Solver & Wind**: Visualizes the multi-criteria airport suitability heatmap, urban NIMBY exclusion rings, and bidirectional runway approach clearance funnels.
- **Central Place Graph**: Overlays settlement tier radii, IATA codes, and inter-city hierarchy links.
- **Topography, Hydrology & Suitability**: Displays latent upland elevation bands, alluvial urban suitability scores, and watershed confluences.

---

## Platform & Performance Architecture

- **Zero-Build Native ES Modules**: Clean separation across the [HTML shell](./index.html), [CSS containment styles](./src/styles.css), [PRNG & derivative noise math](./src/math.js), [color palette](./src/palette.js), [terrain solvers](./src/terrain-solvers.js), [hydrology solvers](./src/hydrology-solvers.js), [world generator](./src/world-generator.js), [Web Worker](./src/world-worker.js), [simulator](./src/simulator.js), [renderer](./src/renderer.js), and [main controller](./src/main.js).
- **Off-Main-Thread Worker + Zero-Copy Transferables**: All 11 spatial TypedArrays (`waterMask`, `elevationField`, `slopeField`, `drainageField`, `distToWater`, `urbanSuitability`, `airportHeatmap`, `roadGrid`, `buildingMask`, `zoneColorIdx`, `landmassId`) transfer from the Worker to the main thread in 0ms via [structured-clone Transferable ArrayBuffers](./src/world-generator.js#L3898-L3932) with automatic request coalescing on rapid slider inputs.
- **50ms-Budgeted Yielding Terrain Bake**: Main-thread Marching-Squares contour and river baking in the [async offscreen terrain baker](./src/renderer.js#L118-L270) yields via `scheduler.yield()` (with a `setTimeout` fallback) whenever a pass exceeds 50ms, then swaps the completed offscreen canvas atomically so live animation never drops a frame.
