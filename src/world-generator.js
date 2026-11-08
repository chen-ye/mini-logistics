import { SeededRNG, FastNoise2D } from "./math.js";
import {
  PALETTE,
  SYLLABLES_START,
  SYLLABLES_PRE,
  SYLLABLES_ROOT_VALLEY,
  SYLLABLES_ROOT_RIVER,
  SYLLABLES_ROOT_COAST,
  SYLLABLES_ROOT_HILL
} from "./palette.js";
import { synthesizeTerrainAndBasins } from "./terrain-solvers.js";
import { synthesizeFluvialHydrology } from "./hydrology-solvers.js";

/***************************************************************************
 * 3. PROCEDURAL WORLD GENERATOR CLASS
 ***************************************************************************/
export class ProceduralLogisticsWorld {
  constructor(config) {
    this.config = config;
    this.W = 360; // OpenTTD State/Region scale width in tiles
    this.H = 224; // OpenTTD State/Region scale height in tiles
    this.tileSize = 15; // Base world pixel size per tile

    // Flat TypedArrays for fast spatial & topographic fields
    const size = this.W * this.H;
    this.elevationField = new Float32Array(size); // [0..1] Latent OpenTTD heightmap (sea, plains, valleys, ridges)
    this.slopeField = new Float32Array(size);     // [0..1] Local topographic gradient magnitude
    this.drainageField = new Float32Array(size);  // Downhill watershed flow accumulation
    this.seaLevel = 0.34;
    this.waterMask = new Uint8Array(size);        // 0 = Land, 1 = River, 2 = Sea/Lake
    this.fertilityField = new Float32Array(size); // [0..1] Alluvial & valley fertility score
    this.distToWater = new Float32Array(size);    // Euclidean distance to nearest water tile
    this.urbanSuitability = new Float32Array(size); // Topography + Central Place Theory suitability
    this.airportHeatmap = new Float32Array(size);   // Multi-criteria airport suitability score
    this.roadGrid = new Uint8Array(size);         // 0 = none, 1 = street, 2 = arterial, 3 = bridge, 4 = airport-loop
    this.buildingMask = new Uint8Array(size);     // 0 = free, 1 = house, 2 = destination, 3 = airport, 4 = interchange/ramp reserve
    this.zoneColorIdx = new Int8Array(size).fill(-1);
    this.landmassId = new Int16Array(size).fill(-1); // Connected dry-land island ID (0 = largest mainland)
    this.landmasses = [];

    // High-level generated entities
    this.rivers = [];
    this.hydroFeatures = []; // Multiple regional hydro landmarks (confluences, bays, lake basins)
    this.clusters = [];      // Metropolitan conurbation clusters across the state
    this.towns = [];
    this.airports = [];
    this.roads = [];        // Graph edges for vector rendering & pathfinding
    this.motorways = [];    // Numbered expressways
    this.interchanges = []; // Cloverleafs, Trumpets, Street-Stubs & Intermediate Diamond Ramps
    this.houses = [];
    this.destinations = [];
    this.cargoLinks = [];   // Inter-industrial supply chain routes (RAW -> MFG -> LOG -> COM)
    this.trees = [];
    this.logs = [];
    this.displacedBuildingsCount = 0;
    this.windAngleIndex = 0; // 0: E-W (0°), 1: NE-SW (45°), 2: N-S (90°), 3: NW-SE (135°)
    this.windVector = { x: 1, y: 0, angleDeg: 0, label: '09/27 (E-W)' };

    // Pre-allocated generation-tagged A* scratch buffers (eliminates ~205 TypedArray allocations & .fill() calls per world)
    this._astarG = new Float32Array(size);
    this._astarParent = new Int32Array(size);
    this._astarSeenGen = new Uint32Array(size);
    this._astarClosedGen = new Uint32Array(size);
    this._astarGen = 0;
  }

  idx(x, y) {
    return y * this.W + x;
  }

  inBounds(x, y, margin = 0) {
    return x >= margin && x < this.W - margin && y >= margin && y < this.H - margin;
  }

  setStageRNG(stageTag) {
    this.rng = new SeededRNG(`${this.config.seed}::${stageTag}`);
  }

  generate(startStage = 1, ckptStore = null) {
    const t0 = performance.now();
    this.rng = new SeededRNG(this.config.seed);
    if (!this.noise || startStage === 1) {
      this.noise = new FastNoise2D(new SeededRNG(`${this.config.seed}::noise`));
    }
    this.terrainUnchanged = startStage >= 8;
    this.reusedThroughStage = startStage > 1 ? startStage - 1 : 0;

    // Step 1: Prevailing Wind Vector
    this.setStageRNG('stage1_wind');
    this.initPrevailingWind();
    const windLog = this.logs[this.logs.length - 1];

    // Step 2A & 2B: Terrain Heightmap & Fluvial Hydrology
    if (startStage <= 2) {
      if (startStage === 1 || !ckptStore?.post2A) {
        this.setStageRNG('stage2a_terrain');
        const { basins, primarySink } = synthesizeTerrainAndBasins(this);
        if (ckptStore) {
          ckptStore.post2A = {
            elevationField: new Float32Array(this.elevationField),
            waterMask: new Uint8Array(this.waterMask),
            seaLevel: this.seaLevel,
            basins: structuredClone(basins),
            primarySink: structuredClone(primarySink),
            hydroFeatures: structuredClone(this.hydroFeatures)
          };
        }
        this.setStageRNG('stage2b_hydro');
        synthesizeFluvialHydrology(this, basins, primarySink);
      } else {
        // Reuse Stage 2A Terrain & Basins (`startStage === 2`, e.g. `hydrologyAlgo` changed)
        this.elevationField.set(ckptStore.post2A.elevationField);
        this.waterMask.set(ckptStore.post2A.waterMask);
        this.seaLevel = ckptStore.post2A.seaLevel;
        this.hydroFeatures = structuredClone(ckptStore.post2A.hydroFeatures);
        this.rivers = [];
        this.drainageField.fill(0);
        this.setStageRNG('stage2b_hydro');
        synthesizeFluvialHydrology(
          this,
          structuredClone(ckptStore.post2A.basins),
          structuredClone(ckptStore.post2A.primarySink)
        );
      }
      const tName = this.config.terrainAlgo === 'quilez-erosion'
        ? 'Quilez Derivative-Eroded fBm'
        : (this.config.terrainAlgo === 'voronoi-plates' ? 'Voronoi Tectonic Plates' : 'Tectonic Strike fBm');
      const hName = this.config.hydrologyAlgo === 'd8-strahler'
        ? 'Priority-Flood D8 Strahler'
        : (this.config.hydrologyAlgo === 'meandering-plain' ? 'Ikeda Floodplain Meanders' : 'Downhill A* Thalwegs');
      this.hydroLog = `Synthesized terrain via <b>${tName}</b> & <b>${this.rivers.length} rivers</b> via <b>${hName}</b>.`;

      if (ckptStore) {
        ckptStore.post2B = {
          elevationField: new Float32Array(this.elevationField),
          waterMask: new Uint8Array(this.waterMask),
          drainageField: new Float32Array(this.drainageField),
          rivers: structuredClone(this.rivers),
          hydroFeatures: structuredClone(this.hydroFeatures),
          confluencePoint: structuredClone(this.confluencePoint),
          seaLevel: this.seaLevel,
          hydroLog: this.hydroLog
        };
      }
    } else if (startStage === 3 && ckptStore?.post2B) {
      // Reuse Stage 2A Terrain + Stage 2B Fluvial Hydrology (`windAxis` changed)
      const c2b = ckptStore.post2B;
      this.elevationField.set(c2b.elevationField);
      this.waterMask.set(c2b.waterMask);
      this.drainageField.set(c2b.drainageField);
      this.rivers = structuredClone(c2b.rivers);
      this.hydroFeatures = structuredClone(c2b.hydroFeatures);
      this.confluencePoint = structuredClone(c2b.confluencePoint);
      this.seaLevel = c2b.seaLevel;
      this.hydroLog = c2b.hydroLog;
    }

    // Step 3: Slope Gradients, Distance Transforms & Valley/Alluvial Suitability
    if (startStage <= 3) {
      this.computeSpatialFields();
      if (ckptStore) {
        ckptStore.post3 = {
          elevationField: new Float32Array(this.elevationField),
          waterMask: new Uint8Array(this.waterMask),
          slopeField: new Float32Array(this.slopeField),
          drainageField: new Float32Array(this.drainageField),
          fertilityField: new Float32Array(this.fertilityField),
          distToWater: new Float32Array(this.distToWater),
          urbanSuitability: new Float32Array(this.urbanSuitability),
          landmassId: new Int16Array(this.landmassId),
          landmasses: structuredClone(this.landmasses),
          rivers: structuredClone(this.rivers),
          hydroFeatures: structuredClone(this.hydroFeatures),
          confluencePoint: structuredClone(this.confluencePoint),
          seaLevel: this.seaLevel,
          hydroLog: this.hydroLog
        };
      }
    } else if (ckptStore?.post3) {
      const c3 = ckptStore.post3;
      this.elevationField.set(c3.elevationField);
      this.waterMask.set(c3.waterMask);
      this.slopeField.set(c3.slopeField);
      this.drainageField.set(c3.drainageField);
      this.fertilityField.set(c3.fertilityField);
      this.distToWater.set(c3.distToWater);
      this.urbanSuitability.set(c3.urbanSuitability);
      this.landmassId.set(c3.landmassId);
      this.landmasses = structuredClone(c3.landmasses);
      this.rivers = structuredClone(c3.rivers);
      this.hydroFeatures = structuredClone(c3.hydroFeatures);
      this.confluencePoint = structuredClone(c3.confluencePoint);
      this.seaLevel = c3.seaLevel;
      this.hydroLog = c3.hydroLog;
    }

    // Step 4: Central Place Settlement Seeding
    if (startStage <= 4) {
      this.towns = [];
      this.clusters = [];
      this.setStageRNG('stage4_settlements');
      this.seedSettlements();
      this.settlementLog = this.logs[this.logs.length - 1];
      if (ckptStore) {
        ckptStore.post4 = {
          towns: structuredClone(this.towns),
          clusters: structuredClone(this.clusters),
          settlementLog: this.settlementLog
        };
      }
    } else if (ckptStore?.post4) {
      this.towns = structuredClone(ckptStore.post4.towns);
      this.clusters = structuredClone(ckptStore.post4.clusters);
      this.settlementLog = ckptStore.post4.settlementLog;
    }

    // Step 5: Multi-Tier Airport Solver & Terminal Loops
    if (startStage <= 5) {
      this.airports = [];
      this.roads = [];
      this.roadGrid.fill(0);
      this.buildingMask.fill(0);
      this.zoneColorIdx.fill(-1);
      this.bridgeCount = 0;
      for (const t of this.towns) t.airportId = null;
      this.setStageRNG('stage5_airports');
      this.solveAndPlaceAirports();
      this.airportLog = this.logs[this.logs.length - 1];
      if (ckptStore) {
        ckptStore.post5 = {
          airports: structuredClone(this.airports),
          towns: structuredClone(this.towns),
          airportHeatmap: new Float32Array(this.airportHeatmap),
          roadGrid: new Uint8Array(this.roadGrid),
          buildingMask: new Uint8Array(this.buildingMask),
          roads: structuredClone(this.roads),
          airportLog: this.airportLog
        };
      }
    } else if (ckptStore?.post5) {
      const c5 = ckptStore.post5;
      this.airports = structuredClone(c5.airports);
      this.towns = structuredClone(c5.towns);
      this.airportHeatmap.set(c5.airportHeatmap);
      this.roadGrid.set(c5.roadGrid);
      this.buildingMask.set(c5.buildingMask);
      this.zoneColorIdx.fill(-1);
      this.roads = structuredClone(c5.roads);
      this.bridgeCount = 0;
      this.airportLog = c5.airportLog;
    }

    // Step 6A, 6B & 7: Street Grids, Regional Roads & RCI Buildings
    if (startStage <= 7) {
      this.houses = [];
      this.destinations = [];
      this.setStageRNG('stage6a_grids');
      this.carveTownStreetGrids();
      this.setStageRNG('stage6b_roads');
      this.buildRegionalRoadNetwork();
      this.roadLog = this.logs[this.logs.length - 1];
      this.setStageRNG('stage7_rci');
      this.growUrbanFabric();
      this.trees = [];
      this.setStageRNG('stage9_trees');
      this.populateLandscapeTrees();

      if (ckptStore) {
        ckptStore.post7 = {
          towns: structuredClone(this.towns),
          roadGrid: new Uint8Array(this.roadGrid),
          buildingMask: new Uint8Array(this.buildingMask),
          zoneColorIdx: new Int8Array(this.zoneColorIdx),
          roads: structuredClone(this.roads),
          houses: structuredClone(this.houses),
          destinations: structuredClone(this.destinations),
          trees: structuredClone(this.trees),
          bridgeCount: this.bridgeCount,
          roadLog: this.roadLog
        };
      }
    } else if (ckptStore?.post7) {
      const c7 = ckptStore.post7;
      this.towns = structuredClone(c7.towns);
      this.roadGrid.set(c7.roadGrid);
      this.buildingMask.set(c7.buildingMask);
      this.zoneColorIdx.set(c7.zoneColorIdx);
      this.roads = structuredClone(c7.roads);
      this.houses = structuredClone(c7.houses);
      this.destinations = structuredClone(c7.destinations);
      this.trees = structuredClone(c7.trees);
      this.bridgeCount = c7.bridgeCount;
      this.roadLog = c7.roadLog;
    }

    // Step 8A: Expressways & Cloverleaf/Trumpet System Interchanges
    if (startStage <= 8) {
      this.motorways = [];
      this.interchanges = [];
      this.displacedBuildingsCount = 0;
      for (const ap of this.airports) ap.motorwayId = null;
      this.setStageRNG('stage8_motorways');
      this.buildNumberedMotorways();
      if (ckptStore) {
        ckptStore.post8 = {
          towns: structuredClone(this.towns),
          airports: structuredClone(this.airports),
          roadGrid: new Uint8Array(this.roadGrid),
          buildingMask: new Uint8Array(this.buildingMask),
          roads: structuredClone(this.roads),
          houses: structuredClone(this.houses),
          destinations: structuredClone(this.destinations),
          trees: structuredClone(this.trees),
          motorways: structuredClone(this.motorways),
          interchanges: structuredClone(this.interchanges),
          displacedBuildingsCount: this.displacedBuildingsCount
        };
      }
    } else if (ckptStore?.post8) {
      const c8 = ckptStore.post8;
      this.towns = structuredClone(c8.towns);
      this.airports = structuredClone(c8.airports);
      this.roadGrid.set(c8.roadGrid);
      this.buildingMask.set(c8.buildingMask);
      this.roads = structuredClone(c8.roads);
      this.houses = structuredClone(c8.houses);
      this.destinations = structuredClone(c8.destinations);
      this.trees = structuredClone(c8.trees);
      this.motorways = structuredClone(c8.motorways);
      this.interchanges = structuredClone(c8.interchanges);
      this.displacedBuildingsCount = c8.displacedBuildingsCount;
    }

    // Step 9: Intermediate Diamond Ramps, Mountain Tunnels, Outer Street Pruning & Industrial Cargo Chain
    this.setStageRNG('stage9_ramps');
    this.finalizeExpresswayRampsAndTunnels();
    const mwayLog = this.logs[this.logs.length - 1];

    this.setStageRNG('stage8b_cargo');
    this.buildIndustrialCargoChain();
    const cargoLog = this.logs[this.logs.length - 1];

    this.logs = [
      windLog,
      this.hydroLog,
      this.settlementLog,
      this.airportLog,
      this.roadLog,
      mwayLog,
      cargoLog
    ].filter(Boolean);

    this.genTimeMs = Math.round(performance.now() - t0);
    return this;
  }

  initPrevailingWind() {
    const axisLabels = [
      { angleDeg: 0,   rad: 0,             label: 'RWY 09/27 (E–W)' },
      { angleDeg: 45,  rad: Math.PI / 4,   label: 'RWY 04/22 (NE–SW)' },
      { angleDeg: 90,  rad: Math.PI / 2,   label: 'RWY 18/36 (N–S)' },
      { angleDeg: 135, rad: 3 * Math.PI/4, label: 'RWY 13/31 (NW–SE)' }
    ];
    if (this.config.windAxis >= 0 && this.config.windAxis <= 3) {
      this.windAngleIndex = this.config.windAxis;
    } else {
      this.windAngleIndex = this.rng.int(0, 3);
    }
    const chosen = axisLabels[this.windAngleIndex];
    this.windVector = {
      x: Math.cos(chosen.rad),
      y: Math.sin(chosen.rad),
      angleDeg: chosen.angleDeg,
      rad: chosen.rad,
      label: chosen.label
    };
    this.logs.push(`Prevailing wind locked to <b>${chosen.label}</b>.`);
  }

  /**
   * Emergent Tectonic TerraGenesis Heightmap (`elevationField`), Quantile-Calibrated Sea/Lake
   * Flooding (`waterMask === 2`), and Non-Bifurcating Downhill Watershed Hydrology.
   * - Zero hardcoded 4-blob Gaussian stamps: every seed generates a unique tectonic strike angle,
   *   coastal embayment orientation, folded mountain/valley relief, and natural contour basins.
   * - Interior lakes drain via a single downhill outflow river to the sea; upland springs
   *   trace downhill along valley thalwegs and taper continuously from thin rills to estuaries.
   */
  generateHydrology() {
    const { basins, primarySink } = synthesizeTerrainAndBasins(this);
    synthesizeFluvialHydrology(this, basins, primarySink);
    const tName = this.config.terrainAlgo === "quilez-erosion"
      ? "Quilez Derivative-Eroded fBm"
      : (this.config.terrainAlgo === "voronoi-plates" ? "Voronoi Tectonic Plates" : "Tectonic Strike fBm");
    const hName = this.config.hydrologyAlgo === "d8-strahler"
      ? "Priority-Flood D8 Strahler"
      : (this.config.hydrologyAlgo === "meandering-plain" ? "Ikeda Floodplain Meanders" : "Downhill A* Thalwegs");
    this.logs.push(`Synthesized terrain via <b>${tName}</b> & <b>${this.rivers.length} rivers</b> via <b>${hName}</b>.`);
  }

  /**
   * Carves a river channel disk of radius `radius` and simultaneously erodes a wider
   * flat-floored alluvial valley trough into `elevationField` so towns and roads naturally
   * follow the river valley floor.
   */
  carveValleyChannel(cx, cy, radius, type = 1, keepHighlandElevation = false) {
    const valleyRad = keepHighlandElevation ? radius + 2.5 : radius + 8.5;
    const rCeil = Math.ceil(valleyRad);
    const r2 = radius * radius;
    const v2 = valleyRad * valleyRad;
    const ix0 = Math.max(0, Math.floor(cx - rCeil));
    const ix1 = Math.min(this.W - 1, Math.ceil(cx + rCeil));
    const iy0 = Math.max(0, Math.floor(cy - rCeil));
    const iy1 = Math.min(this.H - 1, Math.ceil(cy + rCeil));
    for (let y = iy0; y <= iy1; y++) {
      for (let x = ix0; x <= ix1; x++) {
        const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d2 > v2) continue;
        const id = this.idx(x, y);
        if (d2 <= r2) {
          if (this.waterMask[id] === 0) this.waterMask[id] = type;
          if (!keepHighlandElevation) {
            this.elevationField[id] = Math.min(this.elevationField[id], this.seaLevel - 0.04);
          }
        } else if (!keepHighlandElevation) {
          // Smoothly grade the surrounding terrain down toward a flat alluvial river terrace
          const t = (Math.sqrt(d2) - radius) / (valleyRad - radius);
          const terraceElev = this.seaLevel + 0.04 + t * 0.07;
          this.elevationField[id] = this.elevationField[id] * (0.35 + 0.65 * t) + terraceElev * (0.65 * (1 - t));
        }
      }
    }
  }

  carveDisk(cx, cy, radius, type = 1) {
    this.carveValleyChannel(cx, cy, radius, type);
  }

  computeSpatialFields() {
    const { W, H } = this;
    // 1. BFS Distance Transform from water tiles
    const queue = [];
    this.distToWater.fill(999);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const id = this.idx(x, y);
        if (this.waterMask[id] > 0) {
          this.distToWater[id] = 0;
          queue.push(x, y);
        }
      }
    }

    let head = 0;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
    while (head < queue.length) {
      const x = queue[head++];
      const y = queue[head++];
      const d0 = this.distToWater[this.idx(x, y)];
      for (let i = 0; i < dirs.length; i++) {
        const nx = x + dirs[i][0];
        const ny = y + dirs[i][1];
        if (this.inBounds(nx, ny)) {
          const step = i < 4 ? 1.0 : 1.414;
          const nid = this.idx(nx, ny);
          if (d0 + step < this.distToWater[nid]) {
            this.distToWater[nid] = d0 + step;
            queue.push(nx, ny);
          }
        }
      }
    }

    // 2. Compute Topographic Slope Field (`slopeField`) & Valley-Guided Urban Suitability
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const id = this.idx(x, y);
        const xm = Math.max(0, x - 2), xp = Math.min(W - 1, x + 2);
        const ym = Math.max(0, y - 2), yp = Math.min(H - 1, y + 2);
        const dzdx = (this.elevationField[this.idx(xp, y)] - this.elevationField[this.idx(xm, y)]) * 3.8;
        const dzdy = (this.elevationField[this.idx(x, yp)] - this.elevationField[this.idx(x, ym)]) * 3.8;
        const slope = Math.min(1.0, Math.hypot(dzdx, dzdy));
        this.slopeField[id] = slope;

        if (this.waterMask[id] > 0) {
          this.fertilityField[id] = 0;
          this.urbanSuitability[id] = 0;
          continue;
        }
        const dWater = this.distToWater[id];
        const elev = this.elevationField[id];
        const heightAboveSea = Math.max(0, elev - this.seaLevel);

        // Flat valley floors, harbor fronts, and river crossings have top suitability
        const flatBonus = Math.exp(-Math.pow(slope / 0.28, 2));
        const lowValleyBonus = Math.exp(-Math.pow((heightAboveSea - 0.04) / 0.16, 2));
        const riverBonus = Math.exp(-Math.pow((dWater - 3.2) / 6.5, 2));

        let featureBonus = 0;
        for (const hf of this.hydroFeatures) {
          const dFeat = Math.hypot(x - hf.x, y - hf.y);
          featureBonus = Math.max(featureBonus, Math.exp(-dFeat / 44.0) * 0.35);
        }

        const borderDist = Math.min(x, W - 1 - x, y, H - 1 - y);
        const borderFactor = Math.min(1, Math.max(0, (borderDist - 12) / 12));

        // Orographic Windward/Leeward Moisture: wind blowing upslope (`dzdx * wx + dzdy * wy > 0`)
        // creates moist windward slopes; leeward downslopes create rain shadows!
        const orographicDot = dzdx * this.windVector.x + dzdy * this.windVector.y;
        const rainShadowMod = Math.max(-0.22, Math.min(0.26, orographicDot * 0.45));

        this.fertilityField[id] = Math.min(1, Math.max(0, flatBonus * 0.42 + riverBonus * 0.35 + lowValleyBonus * 0.20 + rainShadowMod));
        this.urbanSuitability[id] = Math.min(
          1,
          (flatBonus * 0.32 + lowValleyBonus * 0.22 + riverBonus * 0.32 + featureBonus * 0.14) * borderFactor
        );
      }
    }

    // 3. Connected Dry-Land Landmass / Island Labeling (`this.landmassId`)
    this.landmassId.fill(-1);
    this.landmasses = [];
    const rawLandmasses = [];
    const visitedLand = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const startId = this.idx(x, y);
        if (this.waterMask[startId] > 0 || visitedLand[startId]) continue;
        const comp = [startId];
        visitedLand[startId] = 1;
        let sumX = 0, sumY = 0;
        for (let h = 0; h < comp.length; h++) {
          const cid = comp[h];
          const cx = cid % W;
          const cy = Math.floor(cid / W);
          sumX += cx;
          sumY += cy;
          for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (this.inBounds(nx, ny)) {
              const nid = this.idx(nx, ny);
              if (this.waterMask[nid] === 0 && !visitedLand[nid]) {
                visitedLand[nid] = 1;
                comp.push(nid);
              }
            }
          }
        }
        if (comp.length >= 60) {
          rawLandmasses.push({
            tiles: comp,
            size: comp.length,
            cx: Math.round(sumX / comp.length),
            cy: Math.round(sumY / comp.length)
          });
        }
      }
    }
    rawLandmasses.sort((a, b) => b.size - a.size);
    for (let lmIdx = 0; lmIdx < rawLandmasses.length; lmIdx++) {
      const lm = rawLandmasses[lmIdx];
      for (const cid of lm.tiles) {
        this.landmassId[cid] = lmIdx;
      }
      this.landmasses.push({ id: lmIdx, size: lm.size, cx: lm.cx, cy: lm.cy });
    }
  }

  seedSettlements() {
    const targetCount = this.config.townCount;
    const usedNames = new Set();

    const generateTopographicTownName = (gx, gy) => {
      const id = this.idx(gx, gy);
      const dW = this.distToWater[id];
      const elev = this.elevationField[id];
      let nearRiver = false;
      let nearSeaOrLake = false;
      for (let dy = -8; dy <= 8; dy += 4) {
        for (let dx = -8; dx <= 8; dx += 4) {
          if (this.inBounds(gx + dx, gy + dy, 1)) {
            const wm = this.waterMask[this.idx(gx + dx, gy + dy)];
            if (wm === 1) nearRiver = true;
            else if (wm === 2) nearSeaOrLake = true;
          }
        }
      }

      for (let attempt = 0; attempt < 45; attempt++) {
        const prefix = this.rng.next() < 0.24 ? this.rng.pick(SYLLABLES_START) : '';
        const rootA = this.rng.pick(SYLLABLES_PRE);
        let rootPool = SYLLABLES_ROOT_VALLEY;
        if (dW < 10 && nearRiver && this.rng.next() < 0.65) rootPool = SYLLABLES_ROOT_RIVER;
        else if (dW < 10 && nearSeaOrLake && this.rng.next() < 0.65) rootPool = SYLLABLES_ROOT_COAST;
        else if (elev > this.seaLevel + 0.16 && this.rng.next() < 0.65) rootPool = SYLLABLES_ROOT_HILL;

        const rootB = this.rng.pick(rootPool);
        const suffix = (nearSeaOrLake && dW < 9 && !prefix && this.rng.next() < 0.18) ? '-on-Sea' : '';
        const name = (prefix + rootA + rootB + suffix).replace(/\b\w/g, c => c.toUpperCase());
        if (!usedNames.has(name)) {
          usedNames.add(name);
          return name;
        }
      }
      return 'Metro ' + (usedNames.size + 1);
    };

    // True 4-Tier Regional Settlement Hierarchy (10x Area Span):
    // - Tier 1 (2 Regional Metropolises, R=21): Multi-borough harbor/confluence conurbations
    // - Tier 2 (4 Regional Cities, R=13): Secondary bay ports & valley junctions
    // - Tier 3 (7 Market/Bridge Towns, R=8): River bridgeheads & lake towns
    // - Tier 4 (Remaining Rural Villages/Hamlets, R=5): Compact agricultural/foothill crossroad hamlets
    const numMetros = 2;
    const numRegional = Math.min(6, Math.max(4, Math.round(targetCount * 0.30)));
    this.clusters = [];

    const sectorCenters = [
      { x: this.W * 0.24, y: this.H * 0.34 },
      { x: this.W * 0.76, y: this.H * 0.64 },
      { x: this.W * 0.74, y: this.H * 0.24 },
      { x: this.W * 0.24, y: this.H * 0.74 },
      { x: this.W * 0.50, y: this.H * 0.48 }
    ];

    const isIslandHopper = this.config.archetype === 'island-hopper';
    const landmassTownCount = new Int16Array(Math.max(1, this.landmasses.length));

    for (let i = 0; i < targetCount; i++) {
      const isClusterAnchor = i < numRegional;
      const tier = i < numMetros ? 1 : (i < numRegional ? 2 : (i < Math.round(targetCount * 0.65) ? 3 : 4));
      const urbanRadius = tier === 1 ? (isIslandHopper ? 17 : 21) : (tier === 2 ? 12 : (tier === 3 ? 8 : 5));
      const minSpacing = tier === 1 ? (isIslandHopper ? 78 : 105) : (tier === 2 ? (isIslandHopper ? 38 : 52) : (tier === 3 ? 25 : 18));

      let bestScore = -1;
      let bestPt = null;

      for (let y = 14; y < this.H - 14; y += 3) {
        for (let x = 14; x < this.W - 14; x += 3) {
          const id = this.idx(x, y);
          // Allow waterfront-hugging cities right up to 2.8 tiles from the shoreline (preserving riverbank esplanades!)
          if (this.waterMask[id] > 0 || this.distToWater[id] < 2.8) continue;
          const lmId = this.landmassId[id];
          if (lmId < 0) continue;
          if (this.slopeField[id] > (tier <= 2 ? 0.38 : 0.48) || this.elevationField[id] > this.seaLevel + 0.42) continue;

          let tooClose = false;
          for (const t of this.towns) {
            const d = Math.hypot(x - t.x, y - t.y);
            const reqDist = (tier === 1 && t.tier === 1)
              ? (isIslandHopper ? 78 : 105)
              : Math.max(minSpacing, (t.urbanRadius + urbanRadius) * 1.38);
            if (d < reqDist) {
              tooClose = true;
              break;
            }
          }
          if (tooClose) continue;

          const dW = this.distToWater[id];
          const waterfrontBonus = tier <= 3
            ? Math.exp(-Math.pow((dW - 3.0) / 3.8, 2)) * 0.34
            : Math.exp(-Math.pow((dW - 6.0) / 7.5, 2)) * 0.16;

          let score = this.urbanSuitability[id] * 0.72 + waterfrontBonus + this.rng.range(-0.025, 0.025);

          // In `island-hopper`, guarantee every island gets seeded with settlements!
          if (isIslandHopper && landmassTownCount[lmId] === 0 && this.landmasses[lmId].size >= 160) {
            score += 0.65;
          } else if (isClusterAnchor) {
            const sec = sectorCenters[i % sectorCenters.length];
            const dSec = Math.hypot(x - sec.x, y - sec.y);
            score += Math.exp(-Math.pow(dSec / (this.W * 0.24), 2)) * 0.42;
          }

          if (score > bestScore) {
            bestScore = score;
            bestPt = { x, y, score, lmId };
          }
        }
      }

      if (bestPt) {
        landmassTownCount[bestPt.lmId]++;
        let clusterId = i;
        if (!isClusterAnchor && this.clusters.length > 0) {
          let minCD = Infinity;
          for (const cl of this.clusters) {
            const cd = Math.hypot(bestPt.x - cl.x, bestPt.y - cl.y);
            if (cd < minCD) {
              minCD = cd;
              clusterId = cl.clusterId;
            }
          }
        }
        const colorIdx = (isClusterAnchor ? i : clusterId + (i % 2)) % PALETTE.districtColors.length;
        const tierTitle = tier === 1
          ? 'Metropolis'
          : (tier === 2 ? 'Regional City' : (tier === 3 ? 'Market Town' : 'Rural Hamlet'));
        const name = generateTopographicTownName(bestPt.x, bestPt.y);
        const iata = name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();

        const townObj = {
          id: this.towns.length,
          clusterId,
          landmassId: bestPt.lmId,
          name,
          iata,
          tier,
          tierTitle,
          x: bestPt.x,
          y: bestPt.y,
          urbanRadius,
          colorIdx,
          palette: PALETTE.districtColors[colorIdx],
          suitabilityScore: Math.round(Math.min(99, bestPt.score * 100)),
          housesCount: 0,
          destinationsCount: 0,
          airportId: null,
          boroughs: [{ x: bestPt.x, y: bestPt.y, r: urbanRadius }]
        };
        this.towns.push(townObj);
        if (isClusterAnchor) {
          this.clusters.push(townObj);
        }
      }
    }
    this.logs.push(
      `Seeded <b>${this.towns.length} settlements</b> (2 Metropolises, ${this.towns.filter(t => t.tier === 2).length} Cities, ${this.towns.filter(t => t.tier >= 3).length} Towns/Hamlets).`
    );
  }

  /*************************************************************************
   * STAGE 5: MULTI-TIER AIRPORT SITE-SELECTION & LANDSIDE TERMINAL ROAD NETWORK
   *************************************************************************/
  getAirportTierSpec(aIdx) {
    const mix = this.config.airportMix || 'hub-regional';
    if (aIdx === 0 || (mix === 'dual-hub' && aIdx === 1)) {
      return {
        airportClass: 'HUB',
        classLabel: 'International Hub (Dual-Runway)',
        isHub: true,
        runwayCount: 2,
        halfLen: 7.4,
        halfWid: 3.8,
        approachLen: 15,
        demandPins: 7
      };
    }
    if (mix === 'hub-reg-cargo' && aIdx >= 2) {
      return {
        airportClass: 'CRG',
        classLabel: 'Air Cargo & Logistics Airfield',
        isHub: false,
        runwayCount: 1,
        halfLen: 4.6,
        halfWid: 2.3,
        approachLen: 10,
        demandPins: 4
      };
    }
    return {
      airportClass: 'REG',
      classLabel: 'Regional Commercial Airport',
      isHub: false,
      runwayCount: 1,
      halfLen: 5.2,
      halfWid: 2.6,
      approachLen: 12,
      demandPins: 4
    };
  }

  solveAndPlaceAirports() {
    const isIslandHopper = this.config.archetype === 'island-hopper';
    const effectiveApCount = isIslandHopper ? Math.max(this.config.airportCount, 5) : this.config.airportCount;
    const targetAirports = Math.min(effectiveApCount, this.towns.length);
    const baseRad = this.windVector.rad;

    this.airportHeatmap.fill(0);

    // Sort candidate host cities by tier & population priority;
    // in `island-hopper`, prioritize placing 1 airport on each distinct island (`landmassId`) first!
    const byTier = [...this.towns].sort((a, b) => a.tier - b.tier || b.suitabilityScore - a.suitabilityScore);
    let candidateTowns = byTier;
    if (isIslandHopper) {
      const seenIslands = new Set();
      const firstPerIsland = [];
      const rest = [];
      for (const t of byTier) {
        if (!seenIslands.has(t.landmassId)) {
          seenIslands.add(t.landmassId);
          firstPerIsland.push(t);
        } else {
          rest.push(t);
        }
      }
      candidateTowns = [...firstPerIsland, ...rest];
    }

    for (let tIdx = 0; tIdx < candidateTowns.length && this.airports.length < targetAirports; tIdx++) {
      const hostTown = candidateTowns[tIdx];
      if (!hostTown) break;
      // In `island-hopper`, avoid placing 2 airports on the same island while other islands still need one
      if (
        isIslandHopper &&
        tIdx < candidateTowns.length - 2 &&
        this.airports.some(ap => this.towns[ap.hostTownId].landmassId === hostTown.landmassId)
      ) {
        continue;
      }

      const aIdx = this.airports.length;
      const spec = this.getAirportTierSpec(aIdx);
      const { halfLen, halfWid, approachLen, isHub, airportClass, classLabel, runwayCount, demandPins } = spec;

      // Allow regional & island airfields to align with local valley or coastal peninsula shelves
      const angleCandidates = isIslandHopper
        ? [
            baseRad,
            baseRad + Math.PI / 6,
            baseRad - Math.PI / 6,
            baseRad + Math.PI / 3,
            baseRad - Math.PI / 3,
            baseRad + Math.PI * 0.5
          ]
        : isHub
          ? [baseRad]
          : [baseRad, baseRad + Math.PI / 7, baseRad - Math.PI / 7, baseRad + Math.PI / 4];

      let bestSite = null;
      let bestScore = -1;

      const scanR = Math.round(hostTown.urbanRadius + (isHub ? 36 : 28));
      const y0 = Math.max(10, hostTown.y - scanR);
      const y1 = Math.min(this.H - 10, hostTown.y + scanR);
      const x0 = Math.max(10, hostTown.x - scanR);
      const x1 = Math.min(this.W - 10, hostTown.x + scanR);

      for (const rad of angleCandidates) {
        const cosA = Math.cos(rad);
        const sinA = Math.sin(rad);

        for (let cy = y0; cy <= y1; cy += 2) {
          for (let cx = x0; cx <= x1; cx += 2) {
            const id = this.idx(cx, cy);
            if (this.waterMask[id] > 0) continue;
            if (this.slopeField[id] > (isIslandHopper ? 0.48 : 0.40) || this.distToWater[id] < (isIslandHopper ? 1.8 : 2.8)) continue;

            const distHost = Math.hypot(cx - hostTown.x, cy - hostTown.y);
            const idealDist = hostTown.urbanRadius + (isHub ? 7.5 : 5.5);
            if (distHost < hostTown.urbanRadius * (isIslandHopper ? 0.72 : 0.82) || distHost > idealDist + 24) continue;
            const proximityScore = Math.exp(-Math.pow((distHost - idealDist) / 11.0, 2));

            const toTownX = hostTown.x - cx;
            const toTownY = hostTown.y - cy;
            const dotNormal = toTownX * (-sinA) + toTownY * cosA;
            const broadsideAlignment = Math.abs(dotNormal) / (distHost || 1);
            if (broadsideAlignment < (isIslandHopper ? 0.18 : 0.34)) continue;
            const candidateApronSide = dotNormal >= 0 ? 1 : -1;
            const candLandNx = -sinA * candidateApronSide;
            const candLandNy = cosA * candidateApronSide;
            const candStubDist = isHub ? 5.8 : (isIslandHopper ? 4.0 : 4.6);

            let landsideTownsCount = 0;
            let sumMetroX = 0, sumMetroY = 0;
            for (const otherT of this.towns) {
              sumMetroX += otherT.x;
              sumMetroY += otherT.y;
              const odx = otherT.x - cx;
              const ody = otherT.y - cy;
              const odist = Math.hypot(odx, ody);
              const oLandV = odx * candLandNx + ody * candLandNy;
              if (oLandV >= 4.0 && odist >= 16 && odist <= 185) {
                landsideTownsCount++;
              }
            }
            if (!isIslandHopper && landsideTownsCount < (isHub && this.towns.length >= 4 ? 2 : 1)) continue;
            const metroCx = sumMetroX / (this.towns.length || 1);
            const metroCy = sumMetroY / (this.towns.length || 1);
            const toMetroDist = Math.hypot(metroCx - cx, metroCy - cy) || 1;
            const inwardMetroDot = ((metroCx - cx) * candLandNx + (metroCy - cy) * candLandNy) / toMetroDist;
            if (!isIslandHopper && isHub && inwardMetroDot < -0.25) continue;

            // 2. NIMBY & Urban Core Exclusion against ALL towns
            let nimbyViolation = false;
            for (const t of this.towns) {
              const dTown = Math.hypot(cx - t.x, cy - t.y);
              if (dTown < t.urbanRadius * (isIslandHopper ? 0.72 : 0.80) + (isHub ? 1.8 : 1.0)) {
                nimbyViolation = true;
                break;
              }
            }
            if (nimbyViolation) continue;

            // 3. Minimum airspace separation from already placed airports
            let tooCloseToAirport = false;
            for (const ap of this.airports) {
              if (Math.hypot(cx - ap.x, cy - ap.y) < (isIslandHopper ? 34 : 42)) {
                tooCloseToAirport = true;
                break;
              }
            }
            if (tooCloseToAirport) continue;

            // 4. Oriented Bounding Box Footprint & Flat-Terrain Slope Check
            let landOk = true;
            let slopeSum = 0;
            let obbCount = 0;
            const obbPad = isIslandHopper ? 0.8 : 2.0;
            for (let u = -halfLen - obbPad; u <= halfLen + obbPad; u += 1.5) {
              for (let v = -halfWid - obbPad; v <= candStubDist + obbPad; v += 1.5) {
                const gx = Math.round(cx + u * cosA + v * candLandNx);
                const gy = Math.round(cy + u * sinA + v * candLandNy);
                if (!this.inBounds(gx, gy, 5) || this.waterMask[this.idx(gx, gy)] > 0) {
                  landOk = false;
                  break;
                }
                slopeSum += this.slopeField[this.idx(gx, gy)];
                obbCount++;
              }
              if (!landOk) break;
            }
            if (!landOk) continue;
            const avgSlope = obbCount > 0 ? slopeSum / obbCount : 0;
            if (avgSlope > (isIslandHopper ? 0.44 : 0.36)) continue;

            const candGateX = Math.round(cx + candLandNx * candStubDist);
            const candGateY = Math.round(cy + candLandNy * candStubDist);
            if (!this.inBounds(candGateX, candGateY, 6) || this.distToWater[this.idx(candGateX, candGateY)] < (isIslandHopper ? 1.4 : 2.6)) {
              continue;
            }

            // 5. Bidirectional Flight Approach Funnel Check
            let approachScore = 1.0;
            let waterUnderApproach = 0;
            let sampleCount = 0;
            for (const sign of [-1, 1]) {
              for (let d = halfLen + 2; d <= halfLen + approachLen; d += 2.5) {
                const fx = Math.round(cx + sign * d * cosA);
                const fy = Math.round(cy + sign * d * sinA);
                if (!this.inBounds(fx, fy, 1)) continue;
                sampleCount++;
                if (this.waterMask[this.idx(fx, fy)] > 0) {
                  waterUnderApproach++;
                }
                for (const t of this.towns) {
                  const distCore = Math.hypot(fx - t.x, fy - t.y);
                  if (distCore < t.urbanRadius * 0.6) {
                    approachScore -= 0.45;
                  }
                }
              }
            }
            if (approachScore <= 0.2) continue;

            const waterApproachBonus = sampleCount > 0 ? (waterUnderApproach / sampleCount) * 0.20 : 0;
            const flatTerrainBonus = Math.max(0, 1.0 - avgSlope * 2.4) * 0.14;
            const broadsideBonus = broadsideAlignment * 0.14;
            const regionalReachBonus = Math.min(0.16, landsideTownsCount * 0.045) + Math.max(0, inwardMetroDot) * 0.12;
            const totalScore = Math.min(
              1.0,
              proximityScore * 0.42 + approachScore * 0.18 + waterApproachBonus + flatTerrainBonus + broadsideBonus + regionalReachBonus
            );

            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const hid = this.idx(cx + dx, cy + dy);
                if (totalScore > this.airportHeatmap[hid]) {
                  this.airportHeatmap[hid] = totalScore;
                }
              }
            }

            if (totalScore > bestScore) {
              bestScore = totalScore;
              bestSite = {
                cx,
                cy,
                rad,
                score: totalScore,
                proximityScore,
                approachClearance: Math.min(100, Math.round((approachScore + waterApproachBonus) * 100)),
                distHost: Math.round(distHost)
              };
            }
          }
        }
      }

      if (bestSite) {
        const siteRad = bestSite.rad;
        const cosA = Math.cos(siteRad);
        const sinA = Math.sin(siteRad);
        const toTownX = hostTown.x - bestSite.cx;
        const toTownY = hostTown.y - bestSite.cy;
        const dotNormal = toTownX * (-sinA) + toTownY * cosA;
        const apronSide = dotNormal >= 0 ? 1 : -1;

        const landNx = -sinA * apronSide;
        const landNy = cosA * apronSide;

        const outerDist = isHub ? 3.2 : 2.9;
        const stubDist = isHub ? 5.8 : 4.6;

        const gateX = Math.max(6, Math.min(this.W - 7, Math.round(bestSite.cx + landNx * stubDist)));
        const gateY = Math.max(6, Math.min(this.H - 7, Math.round(bestSite.cy + landNy * stubDist)));
        const curbX = Math.max(6, Math.min(this.W - 7, Math.round(bestSite.cx + landNx * outerDist)));
        const curbY = Math.max(6, Math.min(this.H - 7, Math.round(bestSite.cy + landNy * outerDist)));

        const nameMap = {
          HUB: `${hostTown.name} International Hub`,
          REG: `${hostTown.name} Regional Airport`,
          CRG: `${hostTown.name} Cargo Airfield`
        };
        const suffixMap = { HUB: 'X', REG: 'R', CRG: 'C' };

        const airport = {
          id: this.airports.length,
          name: nameMap[airportClass],
          iata: hostTown.iata + suffixMap[airportClass],
          airportClass,
          classLabel,
          isHub,
          runwayCount,
          hostTownId: hostTown.id,
          hostTownName: hostTown.name,
          x: bestSite.cx,
          y: bestSite.cy,
          curbX,
          curbY,
          gateX,
          gateY,
          stubDist,
          landNx,
          landNy,
          halfLen,
          halfWid,
          approachLen,
          apronSide,
          angleRad: siteRad,
          runwayLabel: isHub ? `${this.windVector.label} L/R` : this.windVector.label,
          suitabilityScore: Math.round(bestSite.score * 100),
          approachClearance: bestSite.approachClearance,
          distToCBD: bestSite.distHost,
          colorIdx: hostTown.colorIdx,
          palette: hostTown.palette,
          demandPins,
          motorwayId: null,
          landsideLoopPts: [],
          accessStubPts: []
        };

        hostTown.airportId = airport.id;
        this.airports.push(airport);

        // Reserve Airfield + Landside Terminal Plaza in buildingMask over exact OBB integer tiles
        const boundR = Math.ceil(Math.hypot(halfLen + 3, stubDist + 3));
        for (let gy = Math.max(1, bestSite.cy - boundR); gy <= Math.min(this.H - 2, bestSite.cy + boundR); gy++) {
          for (let gx = Math.max(1, bestSite.cx - boundR); gx <= Math.min(this.W - 2, bestSite.cx + boundR); gx++) {
            const dx = gx - bestSite.cx;
            const dy = gy - bestSite.cy;
            const u = dx * cosA + dy * sinA;
            const v = dx * landNx + dy * landNy;
            if (
              Math.abs(u) <= halfLen + 2.0 &&
              v >= -(halfWid + (isHub ? 1.8 : 1.4)) &&
              v <= halfWid + (isHub ? 1.8 : 1.4)
            ) {
              this.buildingMask[this.idx(gx, gy)] = 3; // 3 = Airport runway airside exclusion zone
            } else if (
              Math.abs(u) <= (isHub ? 3.8 : 2.8) &&
              v > halfWid &&
              v <= stubDist + 1.2
            ) {
              this.buildingMask[this.idx(gx, gy)] = 4; // 4 = Landside transit/road reserve (blocks buildings, permits access)
            }
          }
        }

        // Construct the realistic Landside Terminal Curbside Loop & Access Street Stub
        this.buildAirportLandsideNetwork(airport);
      }
    }

    const hubCount = this.airports.filter(a => a.airportClass === 'HUB').length;
    const regCount = this.airports.filter(a => a.airportClass === 'REG').length;
    const crgCount = this.airports.filter(a => a.airportClass === 'CRG').length;
    this.logs.push(
      `Placed <b>${this.airports.length} airports</b> (${hubCount} Intl Hub, ${regCount} Regional${crgCount ? `, ${crgCount} Cargo` : ''}) with terminal loop roads.`
    );
  }

  isPointInAirportPad(px, py, margin = 1.6, allowGateAirportId = null) {
    for (const ap of this.airports) {
      const cosA = Math.cos(ap.angleRad);
      const sinA = Math.sin(ap.angleRad);
      const dx = px - ap.x;
      const dy = py - ap.y;
      const u = dx * cosA + dy * sinA;
      const v = dx * ap.landNx + dy * ap.landNy;
      const padU = ap.halfLen + 1.15 + margin;
      const padAirV = ap.halfWid + (ap.isHub ? 1.1 : 0.75) + margin;
      const padLandV = ap.id === allowGateAirportId
        ? (ap.isHub ? 3.8 : 3.0)
        : Math.max(ap.halfWid + (ap.isHub ? 1.1 : 0.75) + margin, (ap.stubDist || 5.2) + 0.5);
      if (Math.abs(u) <= padU && v >= -padAirV && v <= padLandV) {
        return true;
      }
    }
    return false;
  }

  doesSegmentCrossAirport(x1, y1, x2, y2, margin = 1.6, allowGateAirportId = null) {
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(2, Math.ceil(dist * 2.5));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x1 + (x2 - x1) * t;
      const py = y1 + (y2 - y1) * t;
      if (this.isPointInAirportPad(px, py, margin, allowGateAirportId)) {
        return true;
      }
    }
    return false;
  }

  doesPolylineCrossAirport(samples, margin = 1.6, allowGateAirportId = null) {
    if (!samples || samples.length < 2) return false;
    for (let i = 0; i < samples.length - 1; i++) {
      if (this.doesSegmentCrossAirport(samples[i].x, samples[i].y, samples[i + 1].x, samples[i + 1].y, margin, allowGateAirportId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Builds a realistic Landside Terminal Curbside Loop Road (Departures/Arrivals ring)
   * in front of the airport terminal and an Access Avenue Stub extending out to `gateX, gateY`.
   */
  buildAirportLandsideNetwork(ap) {
    const cosA = Math.cos(ap.angleRad);
    const sinA = Math.sin(ap.angleRad);
    const nx = ap.landNx;
    const ny = ap.landNy;

    // Reserve airport loop and landside access footprint on roadGrid & buildingMask
    // so urban grid streets and buildings do not encroach on the airport terminal grounds
    const boundDist = ap.stubDist + 1.2;
    const boundHalfSpan = (ap.isHub ? 3.6 : 2.5);
    for (let u = -boundHalfSpan; u <= boundHalfSpan; u += 1.0) {
      for (let v = 1.0; v <= boundDist; v += 1.0) {
        const gx = Math.round(ap.x + u * cosA + v * nx);
        const gy = Math.round(ap.y + u * sinA + v * ny);
        if (this.inBounds(gx, gy, 2)) {
          const id = this.idx(gx, gy);
          if (this.buildingMask[id] === 0) {
            this.buildingMask[id] = 4; // Road/transit reserve: keeps building-free, permits road access
          }
        }
      }
    }

    // Rasterize the airport access avenue spine on roadGrid for vehicle navigation
    const spineSteps = Math.max(2, Math.round(Math.hypot(ap.gateX - ap.curbX, ap.gateY - ap.curbY)));
    for (let s = 0; s <= spineSteps; s++) {
      const sx = Math.round(ap.curbX + (ap.gateX - ap.curbX) * (s / spineSteps));
      const sy = Math.round(ap.curbY + (ap.gateY - ap.curbY) * (s / spineSteps));
      if (this.inBounds(sx, sy, 2)) {
        this.roadGrid[this.idx(sx, sy)] = 2;
        this.buildingMask[this.idx(sx, sy)] = 4;
      }
    }

    const stubPts = [
      { x: ap.curbX, y: ap.curbY, isBridge: false },
      { x: ap.gateX, y: ap.gateY, isBridge: false }
    ];
    ap.accessStubPts = stubPts;
    this.roads.push({ points: stubPts, type: 'airport-spine' });

    // Always register the Airport Gateway Entrance Roundabout Interchange at `(gateX, gateY)`
    this.interchanges.push({
      type: 'terminal-stub',
      isAirportStub: true,
      airportId: ap.id,
      x: ap.gateX,
      y: ap.gateY,
      stubEndX: ap.curbX,
      stubEndY: ap.curbY,
      angleRad: Math.atan2(ny, nx),
      label: `${ap.iata} Gateway Plaza`
    });
  }

  /*************************************************************************
   * STAGE 6: REGIONAL A* ROAD & PERPENDICULAR BRIDGE NETWORK
   *************************************************************************/
  buildRegionalRoadNetwork() {
    this.bridgeCount = 0;

    // Pre-seed each town's primary cardinal cross-avenues outward from the town center
    // so inter-town A* arterials snap onto the orthogonal urban street grid without creating
    // disconnected street islands across rivers or airport pads.
    for (const town of this.towns) {
      const span = Math.round(town.urbanRadius * 0.65);
      this.carveStreetFromCenter(town.x, town.y, 1, 0, span, span);
      this.carveStreetFromCenter(town.x, town.y, 0, 1, span, span);
    }

    // Connect Towns in a River-Aware Minimum Spanning Tree + 1 regional loop chord.
    // Penalizing water crossings in edge selection connects same-bank towns along continuous
    // valley corridors first and places bridges only at strategic cross-river links.
    const nodes = this.towns.map(t => ({ x: t.x, y: t.y, type: 'town', ref: t }));
    const connected = new Set([0]);
    const edges = [];

    const riverAwareEdgeCost = (a, b) => {
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      let waterHits = 0;
      let ridgePenalty = 0;
      const steps = 18;
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const sx = Math.round(a.x + (b.x - a.x) * t);
        const sy = Math.round(a.y + (b.y - a.y) * t);
        if (this.inBounds(sx, sy, 1)) {
          const id = this.idx(sx, sy);
          if (this.waterMask[id] > 0) waterHits++;
          if (this.buildingMask[id] === 3) waterHits += 4;
          ridgePenalty += Math.max(0, this.elevationField[id] - this.seaLevel - 0.14) * 18.0 + this.slopeField[id] * 10.0;
        }
      }
      const diffCluster = a.ref.clusterId !== b.ref.clusterId ? 24 : 0;
      return d + diffCluster + ridgePenalty + (waterHits > 0 ? 22 + waterHits * 3.5 : 0);
    };

    while (connected.size < nodes.length) {
      let bestEdge = null;
      let bestCost = Infinity;
      for (const i of connected) {
        for (let j = 0; j < nodes.length; j++) {
          if (connected.has(j)) continue;
          const cost = riverAwareEdgeCost(nodes[i], nodes[j]);
          if (cost < bestCost) {
            bestCost = cost;
            bestEdge = [i, j];
          }
        }
      }
      if (!bestEdge) break;
      connected.add(bestEdge[1]);
      edges.push(bestEdge);
    }

    // Add 1 extra intra-cluster/regional chord connection for realistic valley redundancy
    if (nodes.length >= 4) {
      let bestChord = null;
      let bestScore = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const already = edges.some(e => (e[0] === i && e[1] === j) || (e[0] === j && e[1] === i));
          if (already) continue;
          if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) > 76) continue;
          const cost = riverAwareEdgeCost(nodes[i], nodes[j]);
          if (cost < bestScore) {
            bestScore = cost;
            bestChord = [i, j];
          }
        }
      }
      if (bestChord) edges.push(bestChord);
    }

    // Commit surface arterial roads within urban clusters or regional valley neighbors (<= 112 tiles);
    // in `island-hopper`, only connect towns on the same island or across narrow straits (<= 54 tiles)
    // so deep ocean channels between outer islands are served by the aircraft fleet!
    const isIslandHopper = this.config.archetype === 'island-hopper';
    const townRoadDegree = new Int8Array(nodes.length);
    const skippedEdges = [];
    for (const [i, j] of edges) {
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      const sameLandmass = nodes[i].ref.landmassId === nodes[j].ref.landmassId;
      const sameCluster = nodes[i].ref.clusterId === nodes[j].ref.clusterId;
      if (isIslandHopper && !sameLandmass && d > 54) {
        continue;
      }
      if (!sameCluster && d > 112) {
        skippedEdges.push([i, j]);
        continue;
      }
      const path = this.findRoadPathAStar(nodes[i].x, nodes[i].y, nodes[j].x, nodes[j].y, true);
      if (path) {
        const bridgeTiles = path.filter(pt => pt.isBridge).length;
        if (isIslandHopper && !sameLandmass && bridgeTiles > 20) continue;
        this.commitRoadPath(path, 'arterial');
        townRoadDegree[i]++;
        townRoadDegree[j]++;
      }
    }
    if (!isIslandHopper) {
      for (const [i, j] of skippedEdges) {
        if (townRoadDegree[i] === 0 || townRoadDegree[j] === 0) {
          const path = this.findRoadPathAStar(nodes[i].x, nodes[i].y, nodes[j].x, nodes[j].y, true);
          if (path) {
            this.commitRoadPath(path, 'arterial');
            townRoadDegree[i]++;
            townRoadDegree[j]++;
          }
        }
      }
    }

    for (const ap of this.airports) {
      const host = this.towns[ap.hostTownId];
      if (host) {
        let path = this.findRoadPathAStar(ap.gateX, ap.gateY, host.x, host.y, false, null, true);
        if (!path) {
          path = this.findRoadPathAStar(ap.gateX, ap.gateY, host.x, host.y, true, null, true);
        }
        if (path) this.commitRoadPath(path, 'arterial');
      }
    }
  }

  findRoadPathAStar(sx, sy, ex, ey, allowWaterBridge = true, blockedFn = null, stopOnExistingRoad = false) {
    const { W } = this;
    const startId = this.idx(sx, sy);
    const endId = this.idx(ex, ey);
    const gen = ++this._astarGen;
    const gScore = this._astarG;
    const parent = this._astarParent;
    const seenGen = this._astarSeenGen;
    const closedGen = this._astarClosedGen;

    const heapId = [startId];
    const heapF = [0];
    const heapPush = (id, f) => {
      let i = heapId.length;
      heapId.push(id);
      heapF.push(f);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapF[p] <= f) break;
        heapId[i] = heapId[p];
        heapF[i] = heapF[p];
        i = p;
      }
      heapId[i] = id;
      heapF[i] = f;
    };
    const heapPopId = () => {
      const topId = heapId[0];
      const lastId = heapId.pop();
      const lastF = heapF.pop();
      const n = heapId.length;
      if (n > 0) {
        let i = 0;
        while ((i << 1) + 1 < n) {
          let c = (i << 1) + 1;
          if (c + 1 < n && heapF[c + 1] < heapF[c]) c++;
          if (lastF <= heapF[c]) break;
          heapId[i] = heapId[c];
          heapF[i] = heapF[c];
          i = c;
        }
        heapId[i] = lastId;
        heapF[i] = lastF;
      }
      return topId;
    };

    seenGen[startId] = gen;
    gScore[startId] = 0;
    parent[startId] = -1;

    const dirs = [
      [1, 0, 1.0], [-1, 0, 1.0], [0, 1, 1.0], [0, -1, 1.0],
      [1, 1, 1.414], [-1, 1, 1.414], [1, -1, 1.414], [-1, -1, 1.414]
    ];

    while (heapId.length > 0) {
      const cid = heapPopId();
      const distFromStart = Math.hypot((cid % W) - sx, Math.floor(cid / W) - sy);
      if (
        cid === endId ||
        (stopOnExistingRoad && distFromStart >= 3.0 && this.buildingMask[cid] !== 4 && (this.roadGrid[cid] === 1 || this.roadGrid[cid] === 2))
      ) {
        const path = [];
        let trace = cid;
        while (trace !== -1) {
          const py = Math.floor(trace / W);
          const px = trace % W;
          path.push({ x: px, y: py, isBridge: this.waterMask[trace] > 0 });
          trace = parent[trace];
        }
        return path.reverse();
      }

      if (closedGen[cid] === gen) continue;
      closedGen[cid] = gen;

      const cx = cid % W;
      const cy = Math.floor(cid / W);
      const pid = parent[cid];
      const prevDx = pid !== -1 ? cx - (pid % W) : 0;
      const prevDy = pid !== -1 ? cy - Math.floor(pid / W) : 0;
      const currIsWater = this.waterMask[cid] > 0;

      for (const [dx, dy, baseStep] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.inBounds(nx, ny, 3)) continue;
        const nid = this.idx(nx, ny);
        if (closedGen[nid] === gen) continue;

        // Never tunnel through any placed building (house, commercial/industrial lot, or airport runway!)
        if (
          (this.buildingMask[nid] === 1 || this.buildingMask[nid] === 2 || this.buildingMask[nid] === 3) &&
          nid !== startId &&
          nid !== endId
        ) {
          continue;
        }
        if (blockedFn && nid !== startId && nid !== endId && blockedFn(nx, ny)) continue;

        const isWater = this.waterMask[nid] > 0;
        if (isWater && !allowWaterBridge) continue;

        // Inside urban town zones (`zoneColorIdx >= 0`), strictly enforce orthogonal (0°/90°) movement
        // so city streets never slice 45° diagonal wedges across orthogonal blocks, while rural roads
        // (`zoneColorIdx === -1`) can freely take 45° diagonal steps and share existing diagonal highways!
        if (
          dx !== 0 &&
          dy !== 0 &&
          (this.zoneColorIdx[cid] >= 0 || this.zoneColorIdx[nid] >= 0)
        ) {
          continue;
        }

        let stepCost = baseStep;
        if (this.roadGrid[nid] > 0) {
          stepCost *= 0.12;
        } else if (isWater) {
          // River bridges (`waterMask === 1`) must cross from bank to bank (dry land within 1..5 steps ahead along `dx, dy`),
          // NEVER walk lengthwise down the middle of a river channel!
          if (this.waterMask[nid] === 1) {
            let crossesToBank = false;
            for (let s = 1; s <= 5; s++) {
              const bx = nx + dx * s;
              const by = ny + dy * s;
              if (this.inBounds(bx, by, 1) && this.waterMask[this.idx(bx, by)] === 0) {
                crossesToBank = true;
                break;
              }
            }
            stepCost *= crossesToBank ? 2.4 : 45.0;
          } else {
            stepCost *= 19.5;
          }
          if (currIsWater && pid !== -1 && (dx !== prevDx || dy !== prevDy)) {
            stepCost += 34.0;
          }
        } else {
          // Never wrap a road in a tight U-loop around an interior mountain spring headwater (`r.headwaterPt`)!
          for (const rObj of this.rivers) {
            if (rObj.headwaterPt && Math.hypot(nx - rObj.headwaterPt.x, ny - rObj.headwaterPt.y) < 6.0) {
              stepCost += 65.0;
              break;
            }
          }
          // Keep dry-land arterials set back from the 1-tile cream riverbank border
          const dW = this.distToWater[nid];
          if (dW < 2.5 && !currIsWater) {
            stepCost += (2.6 - dW) * 2.5;
          }
          // Topographic valley-following cost: avoid steep slopes and high mountain ridges
          const dElev = Math.max(0, this.elevationField[nid] - this.elevationField[cid]);
          stepCost += this.slopeField[nid] * 3.8 + dElev * 16.0 + Math.max(0, this.elevationField[nid] - this.seaLevel - 0.14) * 2.2;
          // Strongly prefer existing orthogonal streets inside urban zones; never carve a parallel street 1-2 tiles away!
          if (this.zoneColorIdx[nid] >= 0) {
            stepCost *= 4.5;
            const pnx = -dy;
            const pny = dx;
            for (const s of [-2, -1, 1, 2]) {
              const sx2 = nx + pnx * s;
              const sy2 = ny + pny * s;
              if (this.inBounds(sx2, sy2, 1) && this.roadGrid[this.idx(sx2, sy2)] > 0) {
                stepCost += 28.0;
                break;
              }
            }
          }
        }

        // Penalize direction changes (`dx !== prevDx || dy !== prevDy`) so A* marches in clean octilinear runs
        // instead of 1-tile staircases or caterpillar zig-zags!
        if (pid !== -1 && (dx !== prevDx || dy !== prevDy)) {
          const inUrban = this.zoneColorIdx[cid] >= 0 || this.zoneColorIdx[nid] >= 0;
          stepCost += inUrban ? 4.2 : 2.4;
        }

        const tentativeG = gScore[cid] + stepCost;
        if (seenGen[nid] !== gen || tentativeG < gScore[nid]) {
          seenGen[nid] = gen;
          gScore[nid] = tentativeG;
          parent[nid] = cid;
          const h = Math.hypot(ex - nx, ey - ny) * 0.95;
          heapPush(nid, tentativeG + h);
        }
      }
    }
    return null;
  }

  commitRoadPath(path, roadType = 'arterial') {
    if (!path || path.length < 2) return;
    let inBridge = false;
    const isNewTile = new Uint8Array(path.length);

    for (let i = 0; i < path.length; i++) {
      const pt = path[i];
      const id = this.idx(pt.x, pt.y);
      const alreadyRoad = this.roadGrid[id] > 0;
      isNewTile[i] = alreadyRoad ? 0 : 1;

      if (pt.isBridge) {
        if (!inBridge && this.roadGrid[id] !== 3) {
          this.bridgeCount++;
          inBridge = true;
        }
        this.roadGrid[id] = 3;
      } else {
        inBridge = false;
        if (this.roadGrid[id] === 0) {
          this.roadGrid[id] = roadType === 'street' ? 1 : 2;
        } else if (this.roadGrid[id] === 1 && roadType === 'arterial') {
          this.roadGrid[id] = 2;
        }
      }
    }

    // Collapse 1-tile rural staircase jogs (`pPrev -> pCurr -> pNext` changing direction on consecutive 1-tile steps
    // outside town grids) so rural highways render as smooth octilinear/diagonal chords without caterpillar bumps!
    const simplifyRuralStaircase = (pts) => {
      if (roadType === 'street' || pts.length < 3) return pts;
      const out = [pts[0]];
      for (let i = 1; i < pts.length - 1; i++) {
        const prev = out[out.length - 1];
        const curr = pts[i];
        const next = pts[i + 1];

        // Never skip an airport gateway plaza or interchange node!
        const isKeyNode = this.airports.some(a => a.gateX === curr.x && a.gateY === curr.y) ||
                          this.interchanges.some(ic => ic.x === curr.x && ic.y === curr.y);
        if (isKeyNode) {
          out.push(curr);
          continue;
        }

        const cid = this.idx(curr.x, curr.y);
        if (
          !curr.isBridge &&
          !prev.isBridge &&
          !next.isBridge &&
          this.zoneColorIdx[cid] < 0 &&
          Math.hypot(curr.x - prev.x, curr.y - prev.y) <= 1.5 &&
          Math.hypot(next.x - curr.x, next.y - curr.y) <= 1.5
        ) {
          const dx1 = curr.x - prev.x, dy1 = curr.y - prev.y;
          const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
          if (dx1 !== dx2 || dy1 !== dy2) {
            // Skip `curr` so `prev -> next` forms a clean diagonal/knight chord without a 1-tile bump!
            continue;
          }
        }
        out.push(curr);
      }
      out.push(pts[pts.length - 1]);
      return out;
    };

    // Always preserve start/end points if they are an airport gateway plaza or interchange!
    const isStartKey = this.airports.some(a => a.gateX === path[0].x && a.gateY === path[0].y) ||
                       this.interchanges.some(ic => ic.x === path[0].x && ic.y === path[0].y);
    const lastIdx = path.length - 1;
    const isEndKey = this.airports.some(a => a.gateX === path[lastIdx].x && a.gateY === path[lastIdx].y) ||
                     this.interchanges.some(ic => ic.x === path[lastIdx].x && ic.y === path[lastIdx].y);
    if (isStartKey) isNewTile[0] = 1;
    if (isEndKey) isNewTile[lastIdx] = 1;

    // Only emit new road sub-paths (including 1 anchor point where a new branch leaves/joins an existing road)
    // so shared trunk corridors are never double-drawn or offset-scalloped!
    let seg = [];
    for (let i = 0; i < path.length; i++) {
      const keep =
        isNewTile[i] === 1 ||
        (i > 0 && isNewTile[i - 1] === 1) ||
        (i < path.length - 1 && isNewTile[i + 1] === 1);
      if (keep) {
        seg.push(path[i]);
      } else {
        if (seg.length >= 2) {
          this.roads.push({ points: simplifyRuralStaircase(seg), type: roadType });
        }
        seg = [];
      }
    }
    if (seg.length >= 2) {
      this.roads.push({ points: simplifyRuralStaircase(seg), type: roadType });
    }
  }

  /*************************************************************************
   * STAGE 6A & 7: ORGANIC MULTI-BOROUGH GRIDS, VARIED BLOCK SIZES & RCI PACKER
   *************************************************************************/
  carveTownStreetGrids() {
    const densityMult = (this.config.buildingDensity || 250) / 100;

    for (const town of this.towns) {
      const R = Math.round(town.urbanRadius * (0.78 + 0.18 * Math.sqrt(densityMult)));
      const townElev = this.elevationField[this.idx(town.x, town.y)];
      town.effectiveR = R;
      town.commercialCount = 0;
      town.industrialCount = 0;

      // 6A-1. Build Organic Multi-Nuclei Boroughs at their natural topographic optima (NOT locked to a global modulo grid!)
      //       Each borough has its own independent phase and variable block cadence so transitions form natural T-junctions.
      const boroughs = [{ x: town.x, y: town.y, r: R, isMainCBD: true }];
      const numExtraBoroughs = town.tier === 1 ? 3 : (town.tier === 2 ? 2 : 0);

      for (let b = 0; b < numExtraBoroughs; b++) {
        let bestBx = null, bestBy = null, bestScore = -1;
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2 + b * 0.45 + this.rng.range(-0.12, 0.12);
          const dist = Math.round(R * this.rng.range(0.54, 0.88));
          const cx = town.x + Math.round(Math.cos(ang) * dist);
          const cy = town.y + Math.round(Math.sin(ang) * dist);
          if (!this.inBounds(cx, cy, 8)) continue;
          const cid = this.idx(cx, cy);
          if (this.waterMask[cid] > 0 || this.buildingMask[cid] === 3 || this.distToWater[cid] < 2.0) continue;
          if (this.slopeField[cid] > 0.38 || Math.abs(this.elevationField[cid] - townElev) > 0.14) continue;
          if (boroughs.some(eb => Math.hypot(eb.x - cx, eb.y - cy) < R * 0.44)) continue;

          let crossesRiver = false;
          for (let s = 1; s < 8; s++) {
            const mx = Math.round(town.x + (cx - town.x) * (s / 8));
            const my = Math.round(town.y + (cy - town.y) * (s / 8));
            if (this.inBounds(mx, my, 1) && this.waterMask[this.idx(mx, my)] === 1) {
              crossesRiver = true;
              break;
            }
          }
          const score = this.urbanSuitability[cid] + (crossesRiver ? 0.38 : 0) + this.rng.range(-0.05, 0.05);
          if (score > bestScore) {
            bestScore = score;
            bestBx = cx;
            bestBy = cy;
          }
        }
        if (bestBx !== null) {
          const bRad = Math.round(R * (b === 0 ? 0.66 : 0.54));
          boroughs.push({ x: bestBx, y: bestBy, r: bRad, isMainCBD: false });
        }
      }
      town.boroughs = boroughs;

      // Helper to generate irregular street-line offsets outward from 0 using mixed 3, 4, and 5-tile strides
      // (producing varied 2×2, 2×3, 3×2, 3×3, and 2×4 rectangular blocks instead of a uniform 2×2 waffle!)
      const buildVariableOffsets = (maxRadius, isCBD) => {
        const offs = [];
        for (const dir of [-1, 1]) {
          let cur = 0;
          let idx = 0;
          while (cur < maxRadius - 2) {
            let stepChoice;
            if (idx === 0) {
              stepChoice = isCBD && this.rng.next() < 0.65 ? 3 : 4;
            } else if (idx === 1) {
              stepChoice = this.rng.next() < 0.50 ? 3 : 4;
            } else {
              const r = this.rng.next();
              stepChoice = r < 0.32 ? 3 : (r < 0.78 ? 4 : 5);
            }
            cur += stepChoice;
            if (cur <= maxRadius) offs.push(dir * cur);
            idx++;
          }
        }
        return offs;
      };

      // 6A-2. Paint Contour-Hugging Urban Zone & Carve Irregular Rectangular Block Grids
      for (const br of boroughs) {
        const bR = br.r;
        const brElev = this.elevationField[this.idx(br.x, br.y)];

        for (let dy = -bR - 2; dy <= bR + 2; dy++) {
          for (let dx = -bR - 2; dx <= bR + 2; dx++) {
            const gx = br.x + dx;
            const gy = br.y + dy;
            if (!this.inBounds(gx, gy, 2)) continue;
            const id = this.idx(gx, gy);
            if (this.waterMask[id] > 0) continue;
            const isIH = this.config.archetype === 'island-hopper';
            const elevPenalty =
              Math.max(0, this.elevationField[id] - brElev) * (isIH ? 14.0 : 30.0) +
              this.slopeField[id] * (isIH ? 5.0 : 11.0);
            const nJitter = this.noise.fbm(gx * 0.11, gy * 0.11, 2) * 3.8;
            const d = Math.hypot(dx, dy) + elevPenalty + nJitter;
            if (d <= bR + 1.2) {
              this.zoneColorIdx[id] = town.colorIdx;
            }
          }
        }

        // Carve primary borough cross-avenues as arterial boulevards (`roadGrid = 2`)
        const mainNegX = Math.round(bR * this.rng.range(0.75, 1.02));
        const mainPosX = Math.round(bR * this.rng.range(0.75, 1.02));
        const mainNegY = Math.round(bR * this.rng.range(0.75, 1.02));
        const mainPosY = Math.round(bR * this.rng.range(0.75, 1.02));
        this.carveStreetFromCenter(br.x, br.y, 1, 0, mainNegX, mainPosX, br.isMainCBD);
        this.carveStreetFromCenter(br.x, br.y, 0, 1, mainNegY, mainPosY, br.isMainCBD);

        const yOffsets = buildVariableOffsets(bR, br.isMainCBD);
        const xOffsets = buildVariableOffsets(bR, br.isMainCBD);

        for (let pass = 0; pass < 2; pass++) {
          for (const dyOff of yOffsets) {
            if (pass === 1 && this.rng.next() < 0.25) continue;
            const chord = Math.sqrt(Math.max(0, bR * bR - dyOff * dyOff));
            // Asymmetric street spans & occasional one-sided T-intersections for organic neighborhood structure!
            const oneSided = Math.abs(dyOff) > 4 && this.rng.next() < 0.28;
            const negSpan = oneSided && this.rng.next() < 0.5 ? 0 : Math.floor(chord * this.rng.range(0.48, 0.96));
            const posSpan = oneSided && negSpan > 0 && this.rng.next() < 0.5 ? 0 : Math.floor(chord * this.rng.range(0.48, 0.96));
            const yRow = br.y + dyOff;
            for (const probeOff of [0, ...xOffsets]) {
              const probeX = br.x + probeOff;
              if (Math.abs(probeOff) <= Math.max(negSpan, posSpan) && this.inBounds(probeX, yRow, 4) && this.roadGrid[this.idx(probeX, yRow)] > 0) {
                this.carveStreetFromCenter(probeX, yRow, 1, 0, negSpan, posSpan, false);
                break;
              }
            }
          }

          for (const dxOff of xOffsets) {
            if (pass === 1 && this.rng.next() < 0.25) continue;
            const chord = Math.sqrt(Math.max(0, bR * bR - dxOff * dxOff));
            const oneSided = Math.abs(dxOff) > 4 && this.rng.next() < 0.28;
            const negSpan = oneSided && this.rng.next() < 0.5 ? 0 : Math.floor(chord * this.rng.range(0.48, 0.96));
            const posSpan = oneSided && negSpan > 0 && this.rng.next() < 0.5 ? 0 : Math.floor(chord * this.rng.range(0.48, 0.96));
            const xCol = br.x + dxOff;
            for (const probeOff of [0, ...yOffsets]) {
              const probeY = br.y + probeOff;
              if (Math.abs(probeOff) <= Math.max(negSpan, posSpan) && this.inBounds(xCol, probeY, 4) && this.roadGrid[this.idx(xCol, probeY)] > 0) {
                this.carveStreetFromCenter(xCol, probeY, 0, 1, negSpan, posSpan, false);
                break;
              }
            }
          }
        }
      }

      // 6A-3. Connect Secondary Boroughs to the Main CBD
      for (let b = 1; b < boroughs.length; b++) {
        const br = boroughs[b];
        const linkPath = this.findRoadPathAStar(br.x, br.y, town.x, town.y, true);
        if (linkPath) this.commitRoadPath(linkPath, 'arterial');
      }
    }
  }

  growUrbanFabric() {
    const densityMult = (this.config.buildingDensity || 250) / 100;

    for (const town of this.towns) {
      const R = town.effectiveR || Math.round(town.urbanRadius * (0.78 + 0.18 * Math.sqrt(densityMult)));

      // 7A. Place Differentiated Commercial (CBD & Arterial) and Industrial (Peripheral / Freight) Multi-Size Sinks
      this.placeTownCommercialAndIndustrial(town, R, densityMult);

      // 7B. Place Residential Houses with Organic Sparseness, Yard Breathing Room & Dimensional Variation
      const baseHouses = town.tier === 1 ? 66 : (town.tier === 2 ? 34 : (town.tier === 3 ? 16 : 7));
      const targetHouses = Math.max(4, Math.round(baseHouses * densityMult));
      this.tryPlaceNeighborhoodHouses(town, targetHouses, R);
    }

    // 7C. Trim far-flung empty street tails while preserving natural neighborhood block loops
    this.pruneEmptyOuterStreets();
  }

  pruneEmptyOuterStreets() {
    const hasNearbyBuilding = (x, y) => {
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (!this.inBounds(nx, ny, 1)) continue;
          const bm = this.buildingMask[this.idx(nx, ny)];
          if (bm === 1 || bm === 2 || bm === 3) return true;
        }
      }
      return false;
    };

    const cleanedRoads = [];
    for (const r of this.roads) {
      if (r.type !== 'street') {
        cleanedRoads.push(r);
        continue;
      }
      let currentSeg = [];
      for (const pt of r.points) {
        const id = this.idx(pt.x, pt.y);
        if (this.roadGrid[id] >= 2 || hasNearbyBuilding(pt.x, pt.y)) {
          currentSeg.push(pt);
        } else {
          if (this.roadGrid[id] === 1) this.roadGrid[id] = 0;
          if (currentSeg.length >= 2) {
            cleanedRoads.push({ points: currentSeg, type: 'street' });
          }
          currentSeg = [];
        }
      }
      if (currentSeg.length >= 2) {
        cleanedRoads.push({ points: currentSeg, type: 'street' });
      } else if (currentSeg.length === 1) {
        const id = this.idx(currentSeg[0].x, currentSeg[0].y);
        if (this.roadGrid[id] === 1) this.roadGrid[id] = 0;
      }
    }
    this.roads = cleanedRoads;
  }

  /**
   * Carves a street line starting at `(cx, cy)` and marching outward in both `-dir` and `+dir`,
   * stopping upon hitting water, steep hillsides, an airport pad, or a parallel street within 2 tiles
   * so multi-phase borough grids meet cleanly at T-junctions without 1-tile slivers.
   */
  carveStreetFromCenter(cx, cy, ux, uy, negSteps, posSteps, isMainBoulevard = false) {
    const baseElev = this.inBounds(cx, cy, 1) ? this.elevationField[this.idx(cx, cy)] : this.seaLevel;
    const nx = -uy;
    const ny = ux;

    if (
      this.inBounds(cx + ux, cy + uy, 2) &&
      this.inBounds(cx - ux, cy - uy, 2) &&
      this.roadGrid[this.idx(cx, cy)] > 0 &&
      (this.roadGrid[this.idx(cx + ux, cy + uy)] > 0 || this.roadGrid[this.idx(cx - ux, cy - uy)] > 0)
    ) {
      if (isMainBoulevard) {
        this.roadGrid[this.idx(cx, cy)] = 2;
      }
      return;
    }

    // Enforce a strict >= 2-tile clear block gap (`|s| >= 3`) between parallel streets across all boroughs
    const hasParallelNeighbor = (x, y) => {
      for (const s of [-2, -1, 1, 2]) {
        const px = x + nx * s;
        const py = y + ny * s;
        if (!this.inBounds(px, py, 2)) continue;
        // Check a 5-tile window `t in [-2..2]` along `(ux, uy)`: if any two consecutive tiles have roadGrid > 0,
        // there is a parallel street at sideways distance `s`!
        let prevHasRoad = false;
        for (let t = -2; t <= 2; t++) {
          const tx = px + ux * t;
          const ty = py + uy * t;
          const hasR = this.inBounds(tx, ty, 1) && this.roadGrid[this.idx(tx, ty)] > 0;
          if (hasR && prevHasRoad) return true;
          if (Math.abs(s) === 1 && hasR && t === 0 && this.roadGrid[this.idx(x, y)] === 0) return true;
          prevHasRoad = hasR;
        }
      }
      return false;
    };

    const isIH = this.config.archetype === 'island-hopper';
    const isPassable = (x, y) => {
      if (!this.inBounds(x, y, 3)) return false;
      const id = this.idx(x, y);
      if (this.waterMask[id] !== 0 || this.buildingMask[id] !== 0 || this.distToWater[id] < 2.1) return false;
      if (this.slopeField[id] > (isIH ? 0.58 : 0.46) || this.elevationField[id] - baseElev > (isIH ? 0.22 : 0.14)) return false;
      if (hasParallelNeighbor(x, y)) return false;
      return true;
    };
    if (!isPassable(cx, cy)) return;

    const negPts = [];
    for (let s = 1; s <= negSteps; s++) {
      const x = cx - ux * s;
      const y = cy - uy * s;
      if (!isPassable(x, y)) break;
      negPts.push({ x, y, isBridge: false });
    }
    negPts.reverse();

    const posPts = [];
    for (let s = 1; s <= posSteps; s++) {
      const x = cx + ux * s;
      const y = cy + uy * s;
      if (!isPassable(x, y)) break;
      posPts.push({ x, y, isBridge: false });
    }

    const pts = [...negPts, { x: cx, y: cy, isBridge: false }, ...posPts];
    if (pts.length >= 3) {
      for (const pt of pts) {
        const id = this.idx(pt.x, pt.y);
        if (isMainBoulevard) {
          this.roadGrid[id] = 2;
        } else if (this.roadGrid[id] === 0) {
          this.roadGrid[id] = 1;
        }
      }
      this.roads.push({ points: pts, type: isMainBoulevard ? 'arterial' : 'street' });
    }
  }

  /**
   * Places Commercial (`C`) and Industrial (`I`) sinks with true dimensional variation:
   * - `3×2` and `2×3` elongated rectangular halls/warehouses/sawtooth plants along arterials & industrial yards,
   * - `2×2` square CBD high-rise rotundas and `RAW` silo yards,
   * - `2×1` and `1×2` compact corner commercial blocks that fit into tighter central blocks and transition zones!
   */
  placeTownCommercialAndIndustrial(town, R, densityMult) {
    const boroughs = town.boroughs && town.boroughs.length > 0
      ? town.boroughs
      : [{ x: town.x, y: town.y, r: R }];

    const isIH = this.config.archetype === 'island-hopper';
    const ihScale = isIH ? 0.68 : 1.0;
    const baseCom = town.tier === 1 ? 11 : (town.tier === 2 ? 5 : (town.tier === 3 ? 2 : 1));
    const baseInd = town.tier === 1 ? 6 : (town.tier === 2 ? 3 : (town.tier === 3 ? 2 : 1));
    const targetCom = Math.max(1, Math.round(baseCom * ihScale * Math.pow(densityMult, 0.70)));
    const targetInd = Math.max(1, Math.round(baseInd * ihScale * Math.pow(densityMult, 0.66)));

    // Asymmetric directional sector angle for industrial zoning (so industrial districts form distinct clusters/yards)
    const indSectorAngle = this.rng.range(0, Math.PI * 2);
    const indDirX = Math.cos(indSectorAngle);
    const indDirY = Math.sin(indSectorAngle);

    const scanR = R + 5;
    const evaluateFootprint = (gx, gy, wTiles, hTiles) => {
      if (!this.inBounds(gx, gy, 5) || !this.inBounds(gx + wTiles - 1, gy + hTiles - 1, 5)) return null;
      for (let dy = 0; dy < hTiles; dy++) {
        for (let dx = 0; dx < wTiles; dx++) {
          const id = this.idx(gx + dx, gy + dy);
          if (
            this.waterMask[id] > 0 ||
            this.buildingMask[id] > 0 ||
            this.roadGrid[id] > 0 ||
            this.distToWater[id] < 2.0 ||
            this.isPointInAirportPad(gx + dx, gy + dy, 2.0)
          ) {
            return null;
          }
        }
      }

      // Scan perimeter around `[gx..gx+wTiles-1, gy..gy+hTiles-1]` for street & arterial frontage
      let roadTouch = null;
      let touchesArterial = false;
      let arterialCount = 0;
      let streetCount = 0;

      for (let dx = 0; dx < wTiles; dx++) {
        for (const py of [-1, hTiles]) {
          const rx = gx + dx;
          const ry = gy + py;
          const rg = this.roadGrid[this.idx(rx, ry)];
          const lotTileY = py === -1 ? gy : gy + hTiles - 1;
          if (rg === 2) {
            touchesArterial = true;
            arterialCount++;
            if (!roadTouch) roadTouch = { x: rx, y: ry, lotX: rx, lotY: lotTileY };
          } else if (rg === 1) {
            streetCount++;
            if (!roadTouch) roadTouch = { x: rx, y: ry, lotX: rx, lotY: lotTileY };
          }
        }
      }
      for (let dy = 0; dy < hTiles; dy++) {
        for (const px of [-1, wTiles]) {
          const rx = gx + px;
          const ry = gy + dy;
          const rg = this.roadGrid[this.idx(rx, ry)];
          const lotTileX = px === -1 ? gx : gx + wTiles - 1;
          if (rg === 2) {
            touchesArterial = true;
            arterialCount++;
            if (!roadTouch) roadTouch = { x: rx, y: ry, lotX: lotTileX, lotY: ry };
          } else if (rg === 1) {
            streetCount++;
            if (!roadTouch) roadTouch = { x: rx, y: ry, lotX: lotTileX, lotY: ry };
          }
        }
      }
      if (!roadTouch) return null;

      const cx = gx + (wTiles - 1) * 0.5;
      const cy = gy + (hTiles - 1) * 0.5;
      let minBrDist = Infinity;
      for (const br of boroughs) {
        const d = Math.hypot(cx - br.x, cy - br.y);
        if (d < minBrDist) minBrDist = d;
      }
      if (minBrDist > R + 2.5) return null;

      const distTownCenter = Math.hypot(cx - town.x, cy - town.y);
      // Organic transition noise so C/R/I boundaries undulate instead of forming rigid concentric rings
      const transitionNoise = this.noise.fbm(cx * 0.09 + 1.7, cy * 0.09 + 4.3, 2) * 11.5;

      const cbdScore =
        (touchesArterial ? 22.0 + arterialCount * 3.8 : streetCount * 1.4) -
        minBrDist * 2.1 -
        distTownCenter * 0.75 +
        transitionNoise +
        this.rng.range(-3.2, 3.2);

      const vecLen = Math.max(1, distTownCenter);
      const sectorAlign = ((cx - town.x) * indDirX + (cy - town.y) * indDirY) / vecLen;
      const dW = this.distToWater[this.idx(gx, gy)];
      const indRingBonus = minBrDist >= R * (0.34 + this.rng.range(-0.08, 0.10)) ? 16.0 : -18.0;
      const indScore =
        indRingBonus +
        minBrDist * 1.15 +
        sectorAlign * 9.5 +
        (touchesArterial ? 13.5 : 0) +
        (dW < 6.5 ? 7.0 : 0) -
        transitionNoise * 0.6 +
        this.rng.range(-3.0, 3.0);

      return {
        gx,
        gy,
        wTiles,
        hTiles,
        cx,
        cy,
        roadTouch,
        touchesArterial,
        minBrDist,
        cbdScore,
        indScore
      };
    };

    const slots2x2 = [];
    const slotsRect = []; // 3×2 and 2×3 elongated lots
    const slotsCompact = []; // 2×1 and 1×2 corner/boutique commercial lots

    for (let gy = town.y - scanR; gy <= town.y + scanR; gy++) {
      for (let gx = town.x - scanR; gx <= town.x + scanR; gx++) {
        const s22 = evaluateFootprint(gx, gy, 2, 2);
        if (s22) slots2x2.push(s22);
        const s32 = evaluateFootprint(gx, gy, 3, 2);
        if (s32) slotsRect.push(s32);
        const s23 = evaluateFootprint(gx, gy, 2, 3);
        if (s23) slotsRect.push(s23);
        const s21 = evaluateFootprint(gx, gy, 2, 1);
        if (s21) slotsCompact.push(s21);
        const s12 = evaluateFootprint(gx, gy, 1, 2);
        if (s12) slotsCompact.push(s12);
      }
    }

    const isLotFree = (cand, minSpacing) => {
      for (let dy = 0; dy < cand.hTiles; dy++) {
        for (let dx = 0; dx < cand.wTiles; dx++) {
          if (this.buildingMask[this.idx(cand.gx + dx, cand.gy + dy)] > 0) return false;
        }
      }
      for (const d of this.destinations) {
        if (d.townId === town.id && Math.hypot(d.x - cand.cx, d.y - cand.cy) < minSpacing) {
          return false;
        }
      }
      return true;
    };

    const commitLot = (cand, zoneType, subType, isCircular) => {
      for (let dy = 0; dy < cand.hTiles; dy++) {
        for (let dx = 0; dx < cand.wTiles; dx++) {
          this.buildingMask[this.idx(cand.gx + dx, cand.gy + dy)] = 2;
        }
      }
      const colorIdx = zoneType === 'commercial'
        ? town.colorIdx
        : (town.colorIdx + 1) % PALETTE.districtColors.length;
      const area = cand.wTiles * cand.hTiles;

      this.destinations.push({
        id: this.destinations.length,
        x: cand.cx,
        y: cand.cy,
        gx: cand.gx,
        gy: cand.gy,
        wTiles: cand.wTiles,
        hTiles: cand.hTiles,
        lotX: cand.roadTouch.lotX ?? cand.cx,
        lotY: cand.roadTouch.lotY ?? cand.cy,
        roadX: cand.roadTouch.x,
        roadY: cand.roadTouch.y,
        townId: town.id,
        zoneType, // 'commercial' | 'industrial'
        subType,  // 'CBD High-Rise' | 'Arterial Plaza' | 'Corner Market' | 'RAW' | 'MFG' | 'LOG'
        isCircular,
        hasUrgentPin: this.rng.next() < 0.16,
        pinsCount: area >= 6 ? this.rng.int(5, 7) : (area === 4 ? this.rng.int(3, 5) : this.rng.int(2, 3)),
        colorIdx,
        palette: PALETTE.districtColors[colorIdx]
      });
      town.destinationsCount++;
      if (zoneType === 'commercial') town.commercialCount++;
      else town.industrialCount++;
    };

    // 1. Place Commercial (`C`) Sinks with Dimensional Mix:
    //    - Flagship 2×2 CBD Rotundas + 3×2/2×3 Arterial Plazas + 2×1/1×2 Corner Markets!
    const comLargePool = [
      ...slots2x2,
      ...slotsRect.map(s => ({ ...s, cbdScore: s.cbdScore + (s.touchesArterial ? 4.5 : -1.5) }))
    ].sort((a, b) => b.cbdScore - a.cbdScore);
    const comCompactPool = [...slotsCompact].sort((a, b) => b.cbdScore - a.cbdScore);

    let placedCom = 0;
    const largeTarget = Math.max(1, Math.round(targetCom * 0.64));
    for (const cand of comLargePool) {
      if (placedCom >= largeTarget) break;
      // Give 2×2/3×2 buildings breathing room (`minSpacing = 3.6`) so they don't tile into a solid grid
      if (!isLotFree(cand, 3.6)) continue;
      const is2x2 = cand.wTiles === 2 && cand.hTiles === 2;
      const isCBDLandmark = is2x2 && (placedCom === 0 || (cand.minBrDist < 4.5 && this.rng.next() < 0.45));
      const subType = isCBDLandmark ? 'CBD High-Rise' : 'Arterial Retail Plaza';
      commitLot(cand, 'commercial', subType, isCBDLandmark);
      placedCom++;
    }

    // Fill remaining Commercial quota with compact 2×1 / 1×2 Corner Markets in tight central & arterial blocks!
    for (const cand of comCompactPool) {
      if (placedCom >= targetCom) break;
      if (!isLotFree(cand, 2.5)) continue;
      commitLot(cand, 'commercial', 'Corner Market', false);
      placedCom++;
    }

    // 2. Place Industrial (`I`) Sinks & Producers (`3×2`/`2×3` MFG Factories & LOG Hubs + `2×2` RAW Silo Yards)
    const indRectSorted = [...slotsRect].sort((a, b) => b.indScore - a.indScore);
    const ind2x2Sorted = [...slots2x2].sort((a, b) => b.indScore - a.indScore);
    const tier1Roles = ['MFG', 'LOG', 'RAW', 'MFG', 'LOG', 'RAW'];
    const tier2Roles = ['MFG', 'RAW', 'LOG', 'MFG', 'RAW'];
    const tier3Roles = ['RAW', 'MFG', 'RAW'];

    let placedInd = 0;
    let rectIdx = 0;
    let sqIdx = 0;
    while (placedInd < targetInd && (rectIdx < indRectSorted.length || sqIdx < ind2x2Sorted.length)) {
      let indRole = 'RAW';
      if (town.tier === 1) indRole = tier1Roles[placedInd % tier1Roles.length];
      else if (town.tier === 2) indRole = tier2Roles[placedInd % tier2Roles.length];
      else indRole = tier3Roles[placedInd % tier3Roles.length];

      // `MFG` and `LOG` strongly prefer elongated `3×2` or `2×3` rectangular halls when available!
      const preferRect = (indRole === 'MFG' || indRole === 'LOG') && this.rng.next() < 0.75;
      let chosen = null;

      if (preferRect) {
        while (rectIdx < indRectSorted.length) {
          const c = indRectSorted[rectIdx++];
          if (isLotFree(c, 4.1)) {
            chosen = c;
            break;
          }
        }
      }
      if (!chosen) {
        while (sqIdx < ind2x2Sorted.length) {
          const c = ind2x2Sorted[sqIdx++];
          if (isLotFree(c, 3.8)) {
            chosen = c;
            break;
          }
        }
      }
      if (!chosen) break;

      commitLot(chosen, 'industrial', indRole, false);
      placedInd++;
    }
  }

  tryPlaceNeighborhoodHouses(town, targetHouses, customRadius = null) {
    const boroughs = town.boroughs && town.boroughs.length > 0
      ? town.boroughs
      : [{ x: town.x, y: town.y, r: customRadius || town.urbanRadius }];
    const secondaryColorIdx = (town.colorIdx + 2) % PALETTE.districtColors.length;
    const clusterOffset = {
      x: town.x + this.rng.range(-8, 8),
      y: town.y + this.rng.range(-8, 8)
    };

    const scanR = (customRadius || town.urbanRadius) + 3;
    const houseSlots = [];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    for (let gy = town.y - scanR; gy <= town.y + scanR; gy++) {
      for (let gx = town.x - scanR; gx <= town.x + scanR; gx++) {
        if (!this.inBounds(gx, gy, 3)) continue;
        const id = this.idx(gx, gy);
        if (this.waterMask[id] > 0 || this.buildingMask[id] > 0 || this.roadGrid[id] > 0 || this.distToWater[id] < 1.9) continue;
        if (this.zoneColorIdx[id] !== town.colorIdx) continue;

        let driveway = null;
        for (const [dx, dy] of dirs) {
          const rx = gx + dx;
          const ry = gy + dy;
          const rid = this.idx(rx, ry);
          if (this.roadGrid[rid] === 1 || this.roadGrid[rid] === 2) {
            driveway = { x: rx, y: ry };
            break;
          }
        }
        if (!driveway) continue;

        let minBrDist = Infinity;
        for (const br of boroughs) {
          const d = Math.hypot(gx - br.x, gy - br.y);
          if (d < minBrDist) minBrDist = d;
        }
        // Add spatial noise & wide random jitter to transition points so density feathers organically!
        const patchNoise = this.noise.fbm(gx * 0.14 + 5.2, gy * 0.14 + 2.9, 2) * 5.5;
        const priority = minBrDist + patchNoise + this.rng.range(0, 6.5);
        houseSlots.push({ gx, gy, id, driveway, minBrDist, priority });
      }
    }

    houseSlots.sort((a, b) => a.priority - b.priority);

    const countAdjacentHouses = (gx, gy) => {
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (this.buildingMask[this.idx(gx + dx, gy + dy)] === 1) count++;
        }
      }
      return count;
    };

    for (const slot of houseSlots) {
      if (town.housesCount >= targetHouses) break;
      if (this.buildingMask[slot.id] > 0 || this.roadGrid[slot.id] > 0) continue;

      // Prevent 4-house "waffle blocks": leave yard/courtyard breathing room inside blocks!
      const adj = countAdjacentHouses(slot.gx, slot.gy);
      const radialFrac = Math.min(1, slot.minBrDist / Math.max(6, scanR));
      if (adj >= 3) continue;
      if (adj === 2 && this.rng.next() < 0.72) continue;
      if (adj === 1 && this.rng.next() < 0.25 + radialFrac * 0.35) continue;

      this.buildingMask[slot.id] = 1;
      const useSecondary = Math.hypot(slot.gx - clusterOffset.x, slot.gy - clusterOffset.y) < scanR * 0.36;
      const colorIdx = useSecondary ? secondaryColorIdx : town.colorIdx;

      // Dimensional variation for individual houses (cottages, L-townhouses, varied setbacks)
      const wScale = this.rng.range(0.60, 0.84);
      const hScale = this.rng.range(0.60, 0.84);
      const offX = this.rng.range(-0.08, 0.08);
      const offY = this.rng.range(-0.08, 0.08);

      this.houses.push({
        x: slot.gx,
        y: slot.gy,
        wScale,
        hScale,
        offX,
        offY,
        roadX: slot.driveway.x,
        roadY: slot.driveway.y,
        townId: town.id,
        colorIdx,
        palette: PALETTE.districtColors[colorIdx]
      });
      town.housesCount++;
    }
  }

  /**
   * STAGE 8B: INTER-INDUSTRIAL CARGO SUPPLY CHAIN (`RAW -> MFG -> LOG -> COM`)
   * Links Primary Extraction (`RAW`), Secondary Manufacturing (`MFG`), Wholesale Logistics (`LOG`),
   * and CBD/Arterial Commercial Sinks (`COM`) into an active road-routed regional freight network.
   */
  buildIndustrialCargoChain() {
    this.cargoLinks = [];
    const rawNodes = this.destinations.filter(d => d.zoneType === 'industrial' && d.subType === 'RAW');
    const mfgNodes = this.destinations.filter(d => d.zoneType === 'industrial' && d.subType === 'MFG');
    const logNodes = this.destinations.filter(d => d.zoneType === 'industrial' && d.subType === 'LOG');
    const comNodes = this.destinations.filter(d => d.zoneType === 'commercial');

    const tryAddFreightLink = (src, dst, stage, label, color, maxCrowDist = 115) => {
      const crowD = Math.hypot(dst.x - src.x, dst.y - src.y);
      if (crowD < 2.5 || crowD > maxCrowDist) return false;
      const sx = Math.round(src.roadX || src.x);
      const sy = Math.round(src.roadY || src.y);
      const ex = Math.round(dst.roadX || dst.x);
      const ey = Math.round(dst.roadY || dst.y);
      // Strictly route freight trucks along existing paved roads & bridges (`roadGrid > 0`)!
      const roadPath = this.findRoadPathAStar(
        sx,
        sy,
        ex,
        ey,
        true,
        (nx, ny) => this.roadGrid[this.idx(nx, ny)] === 0
      );
      if (!roadPath || roadPath.length < 2 || roadPath.length > crowD * 3.4 + 35) return false;

      this.cargoLinks.push({
        from: src,
        to: dst,
        stage, // 'RAW->MFG' | 'MFG->LOG' | 'MFG->COM' | 'LOG->COM'
        label,
        color,
        points: roadPath
      });
      return true;
    };

    // 1. Stage 1: Raw Materials (`RAW`) -> Nearest Road-Connected Manufacturing Plant (`MFG`)
    for (const raw of rawNodes) {
      const candidates = [...mfgNodes]
        .filter(mfg => mfg.id !== raw.id)
        .sort((a, b) => {
          const sameA = this.towns[a.townId].landmassId === this.towns[raw.townId].landmassId ? 0 : 90;
          const sameB = this.towns[b.townId].landmassId === this.towns[raw.townId].landmassId ? 0 : 90;
          return (Math.hypot(a.x - raw.x, a.y - raw.y) + sameA) - (Math.hypot(b.x - raw.x, b.y - raw.y) + sameB);
        })
        .slice(0, 3);

      for (const mfg of candidates) {
        if (tryAddFreightLink(raw, mfg, 'RAW->MFG', 'Raw Materials → Factory', '#d97706', 110)) {
          break;
        }
      }
    }

    // 2. Stage 2: Manufacturing (`MFG`) -> Nearest Logistics Hub (`LOG`) or Local Commercial CBD (`COM`)
    for (const mfg of mfgNodes) {
      let linkedToLog = false;
      const logCands = [...logNodes]
        .sort((a, b) => Math.hypot(a.x - mfg.x, a.y - mfg.y) - Math.hypot(b.x - mfg.x, b.y - mfg.y))
        .slice(0, 2);
      for (const lg of logCands) {
        if (tryAddFreightLink(mfg, lg, 'MFG->LOG', 'Factory Output → Distribution Hub', '#ea580c', 75)) {
          linkedToLog = true;
          break;
        }
      }

      // Also supply the flagship Commercial CBD sink in the factory's town (or nearest town)
      const comCands = [...comNodes]
        .sort((a, b) => Math.hypot(a.x - mfg.x, a.y - mfg.y) - Math.hypot(b.x - mfg.x, b.y - mfg.y))
        .slice(0, linkedToLog ? 1 : 2);
      for (const com of comCands) {
        if (tryAddFreightLink(mfg, com, 'MFG->COM', 'Wholesale Goods → Commercial CBD', '#2563eb', 55)) {
          break;
        }
      }
    }

    // 3. Stage 3: Logistics Warehouses (`LOG`) -> High-Demand Commercial CBD Sinks (`COM`)
    for (const lg of logNodes) {
      const nearComs = [...comNodes]
        .sort((a, b) => Math.hypot(a.x - lg.x, a.y - lg.y) - Math.hypot(b.x - lg.x, b.y - lg.y))
        .slice(0, 3);
      let count = 0;
      for (const com of nearComs) {
        if (tryAddFreightLink(lg, com, 'LOG->COM', 'Last-Mile Freight → Commercial Sink', '#7c3aed', 50)) {
          count++;
          if (count >= 2) break;
        }
      }
    }

    this.logs.push(
      `Zoned <b>${comNodes.length} Commercial</b> (CBD/Arterial) & <b>${rawNodes.length + mfgNodes.length + logNodes.length} Industrial</b> (${rawNodes.length} Raw, ${mfgNodes.length} Mfg, ${logNodes.length} Log) with <b>${this.cargoLinks.length} road freight chains</b>.`
    );
  }

  /*************************************************************************
   * STAGE 8: REALISTIC EXPRESSWAYS, CLOVERLEAFS, STREET-STUB TERMINALS & RAMPS
   *************************************************************************/
  displaceBuildingsInRadius(cx, cy, radius) {
    const r2 = radius * radius;
    const rCeil = Math.ceil(radius);
    for (let dy = -rCeil; dy <= rCeil; dy++) {
      for (let dx = -rCeil; dx <= rCeil; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const gx = Math.round(cx + dx);
        const gy = Math.round(cy + dy);
        if (this.inBounds(gx, gy, 1) && this.buildingMask[this.idx(gx, gy)] !== 3) {
          this.buildingMask[this.idx(gx, gy)] = 4;
        }
      }
    }

    const beforeHouses = this.houses.length;
    this.houses = this.houses.filter(h => {
      const keep = (h.x - cx) * (h.x - cx) + (h.y - cy) * (h.y - cy) > r2;
      if (!keep) {
        const t = this.towns[h.townId];
        if (t && t.housesCount > 0) t.housesCount--;
      }
      return keep;
    });

    const beforeDest = this.destinations.length;
    this.destinations = this.destinations.filter(d => {
      const keep = (d.x - cx) * (d.x - cx) + (d.y - cy) * (d.y - cy) > (radius + 1.2) * (radius + 1.2);
      if (!keep) {
        const t = this.towns[d.townId];
        if (t) {
          if (t.destinationsCount > 0) t.destinationsCount--;
          if (d.zoneType === 'commercial' && t.commercialCount > 0) t.commercialCount--;
          if (d.zoneType === 'industrial' && t.industrialCount > 0) t.industrialCount--;
        }
      }
      return keep;
    });

    this.trees = this.trees.filter(tr => (tr.x - cx) * (tr.x - cx) + (tr.y - cy) * (tr.y - cy) > r2);
    this.displacedBuildingsCount += (beforeHouses - this.houses.length) + (beforeDest - this.destinations.length);
  }

  findPassThroughStubAtTown(town, towardX, towardY) {
    const baseAngle = Math.atan2(towardY - town.y, towardX - town.x);
    return this.interchanges.find(ic => {
      if (ic.type !== 'terminal-stub' || ic.isAirportStub || ic.townId !== town.id) return false;
      const attachedCount = this.motorways.filter(
        m => (Math.hypot(m.sx - ic.x, m.sy - ic.y) < 1.5 && !m.prunedStart) ||
             (Math.hypot(m.ex - ic.x, m.ey - ic.y) < 1.5 && !m.prunedEnd)
      ).length;
      if (attachedCount >= 2) return false;
      const angDiff = Math.abs(Math.atan2(Math.sin(ic.angleRad - baseAngle), Math.cos(ic.angleRad - baseAngle)));
      return angDiff >= 2.05; // Require >= 117° wide pass-through angle (never an acute V-point!)
    }) || null;
  }

  createTerminalStreetStub(townOrAirport, isAirport, towardX, towardY) {
    if (isAirport) {
      const ap = townOrAirport;
      this.displaceBuildingsInRadius(ap.gateX, ap.gateY, 3.2);
      const stubAngle = Math.atan2(ap.landNy, ap.landNx);
      const existing = this.interchanges.find(
        ic => ic.type === 'terminal-stub' && ic.isAirportStub && ic.x === ap.gateX && ic.y === ap.gateY
      );
      if (!existing) {
        this.interchanges.push({
          type: 'terminal-stub',
          isAirportStub: true,
          airportId: ap.id,
          x: ap.gateX,
          y: ap.gateY,
          stubEndX: ap.curbX,
          stubEndY: ap.curbY,
          angleRad: stubAngle,
          label: `${ap.iata} Terminal Interchange`
        });
      }
      return { x: ap.gateX, y: ap.gateY };
    }

    const town = townOrAirport;
    const baseAngle = Math.atan2(towardY - town.y, towardX - town.x);

    // Share an existing town terminal-stub when the new corridor arrives at a wide pass-through
    // angle (>= 100° apart) so the two motorways form a connected beltway hub rather than
    // spawning two disconnected roundabouts in the same town.
    const existingPassThrough = this.findPassThroughStubAtTown(town, towardX, towardY);
    if (existingPassThrough) {
      return { x: existingPassThrough.x, y: existingPassThrough.y };
    }

    const dist = Math.hypot(towardX - town.x, towardY - town.y) || 1;
    const baseRadius = Math.min(town.urbanRadius * 0.65, Math.max(5.5, dist * 0.34));
    const angleOffsets = [0, 0.28, -0.28, 0.55, -0.55, 0.85, -0.85, 1.15, -1.15, 1.45, -1.45];
    const radiusScales = [1.0, 0.84, 1.16];

    let chosenAx = town.x;
    let chosenAy = town.y;
    let chosenTiePath = null;
    let chosenAngle = baseAngle;

    for (const rScale of radiusScales) {
      for (const aOff of angleOffsets) {
        const ang = baseAngle + aOff;
        const r = baseRadius * rScale;
        const candX = Math.max(7, Math.min(this.W - 8, Math.round(town.x + Math.cos(ang) * r)));
        const candY = Math.max(7, Math.min(this.H - 8, Math.round(town.y + Math.sin(ang) * r)));
        const cid = this.idx(candX, candY);

        if (this.waterMask[cid] > 0 || this.distToWater[cid] < 3.0) continue;
        if (this.isPointInAirportPad(candX, candY, 2.5)) continue;

        const tooCloseStub = this.interchanges.some(
          ic => ic.type === 'terminal-stub' && Math.hypot(ic.x - candX, ic.y - candY) < 8.5
        );
        if (tooCloseStub) continue;

        const tiePath = this.findRoadPathAStar(candX, candY, town.x, town.y, false, null, true);
        if (tiePath && tiePath.length >= 2) {
          chosenAx = candX;
          chosenAy = candY;
          chosenTiePath = tiePath;
          chosenAngle = ang;
          break;
        }
      }
      if (chosenTiePath) break;
    }

    if (!chosenTiePath) {
      chosenTiePath = this.findRoadPathAStar(chosenAx, chosenAy, town.x, town.y, true, null, true);
    }
    if (chosenTiePath) {
      this.commitRoadPath(chosenTiePath, 'arterial');
    }
    this.roadGrid[this.idx(chosenAx, chosenAy)] = 2;
    this.displaceBuildingsInRadius(chosenAx, chosenAy, 3.0);

    const secondPt = chosenTiePath && chosenTiePath.length > 1 ? chosenTiePath[1] : { x: town.x, y: town.y };
    this.interchanges.push({
      type: 'terminal-stub',
      isAirportStub: false,
      townId: town.id,
      x: chosenAx,
      y: chosenAy,
      stubEndX: secondPt.x,
      stubEndY: secondPt.y,
      angleRad: chosenAngle,
      label: `${town.name} Beltway Stub`
    });

    return { x: chosenAx, y: chosenAy };
  }

  findRingInterchangePoint(town, towardX, towardY) {
    return this.createTerminalStreetStub(town, false, towardX, towardY);
  }

  buildVignelliOctilinearWaypoints(sx, sy, ex, ey, bendSign = 1) {
    const dx = ex - sx;
    const dy = ey - sy;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    const diag = Math.min(adx, ady);

    let k1x, k1y, k2x, k2y;
    if (bendSign === 1) {
      k1x = sx + Math.sign(dx) * diag * 0.5;
      k1y = sy + Math.sign(dy) * diag * 0.5;
      k2x = sx + Math.sign(dx) * diag;
      k2y = sy + Math.sign(dy) * diag;
    } else if (bendSign === -1) {
      if (adx > ady) {
        const straight = adx - diag;
        k1x = sx + Math.sign(dx) * straight;
        k1y = sy;
        k2x = sx + Math.sign(dx) * (straight + diag * 0.5);
        k2y = sy + Math.sign(dy) * (diag * 0.5);
      } else {
        const straight = ady - diag;
        k1x = sx;
        k1y = sy + Math.sign(dy) * straight;
        k2x = sx + Math.sign(dx) * (diag * 0.5);
        k2y = sy + Math.sign(dy) * (straight + diag * 0.5);
      }
    } else {
      if (adx > ady) {
        const halfStraight = (adx - diag) * 0.5;
        k1x = sx + Math.sign(dx) * halfStraight;
        k1y = sy;
        k2x = ex - Math.sign(dx) * halfStraight;
        k2y = ey;
      } else {
        const halfStraight = (ady - diag) * 0.5;
        k1x = sx;
        k1y = sy + Math.sign(dy) * halfStraight;
        k2x = ex;
        k2y = ey - Math.sign(dy) * halfStraight;
      }
    }
    return [
      { x: sx, y: sy },
      { x: k1x, y: k1y },
      { x: k2x, y: k2y },
      { x: ex, y: ey }
    ];
  }

  isCloverleafFootprintDry(x, y, angleA, angleB, signsA = [-1, 1], signsB = [-1, 1]) {
    const gx = Math.round(x);
    const gy = Math.round(y);
    if (!this.inBounds(gx, gy, 6)) return false;
    const cid = this.idx(gx, gy);
    if (this.waterMask[cid] > 0 || this.distToWater[cid] < 2.6) return false;
    if (this.isPointInAirportPad(x, y, 3.4)) return false;

    const uAx = Math.cos(angleA), uAy = Math.sin(angleA);
    const uBx = Math.cos(angleB), uBy = Math.sin(angleB);

    for (const sA of signsA) {
      for (const sB of signsB) {
        const rAx = sA * uAx, rAy = sA * uAy;
        const rBx = sB * uBx, rBy = sB * uBy;
        const checkPts = [
          { px: x + rAx * 2.8, py: y + rAy * 2.8 },
          { px: x + rBx * 2.8, py: y + rBy * 2.8 },
          { px: x + (rAx + rBx) * 1.85, py: y + (rAy + rBy) * 1.85 }
        ];
        for (const { px, py } of checkPts) {
          const rx = Math.round(px);
          const ry = Math.round(py);
          if (!this.inBounds(rx, ry, 4)) return false;
          const rid = this.idx(rx, ry);
          if (this.waterMask[rid] > 0 || this.distToWater[rid] < 1.5) return false;
          if (this.isPointInAirportPad(px, py, 2.2)) return false;
        }
      }
    }
    return true;
  }

  isTrumpetFootprintDry(x, y, angleMain, sideSign) {
    const gx = Math.round(x);
    const gy = Math.round(y);
    if (!this.inBounds(gx, gy, 6)) return false;
    const cid = this.idx(gx, gy);
    if (this.waterMask[cid] > 0 || this.distToWater[cid] < 4.5) return false;
    if (this.isPointInAirportPad(x, y, 3.8)) return false;

    const ux = Math.cos(angleMain), uy = Math.sin(angleMain);
    const nx = -uy * sideSign, ny = ux * sideSign;

    // Check both the directional slip-ramps on the terminating highway side (+sideSign),
    // the spur approach throat (+4.2..+5.8), the mainline ramp merge toes (±3.4),
    // AND the 270° trumpet loop on the OPPOSITE side (-sideSign).
    const localPts = [
      [-3.4, 0], [3.4, 0],
      [-2.8, 0.4], [2.8, 0.4], [0, 2.8], [0, 4.2], [0, 5.8], [-1.8, 3.4], [1.8, 3.4], [-1.4, 1.5], [1.4, 1.5],
      [0, -2.2], [1.8, -1.8], [2.2, -1.0]
    ];
    for (const [lu, lv] of localPts) {
      const px = x + ux * lu + nx * lv;
      const py = y + uy * lu + ny * lv;
      const rx = Math.round(px);
      const ry = Math.round(py);
      if (!this.inBounds(rx, ry, 4)) return false;
      const rid = this.idx(rx, ry);
      if (this.waterMask[rid] > 0 || this.distToWater[rid] < 2.6) return false;
      if (this.isPointInAirportPad(px, py, 2.2)) return false;
    }
    return true;
  }

  scoreMotorwaySamples(samples, sx, sy, ex, ey, airportId = null, preferOff = 0, candidateOff = 0, forbidAnyCrossing = false, allowTouchTrunkNum = null) {
    if (!samples || samples.length < 2) return Infinity;
    const chord = Math.hypot(ex - sx, ey - sy) || 1;
    if (chord < 16) return Infinity;

    // Hard invariant 1: Never go out of bounds
    for (const pt of samples) {
      if (!this.inBounds(Math.round(pt.x), Math.round(pt.y), 4)) return Infinity;
    }

    // Hard invariant 2: Expressways must NEVER route over any airport pad
    if (this.doesPolylineCrossAirport(samples, 1.8, airportId)) {
      return Infinity;
    }

    // Hard invariant 3: Prevent hairpin loops or sharp reversals along the polyline
    let arcLen = 0;
    for (let i = 1; i < samples.length; i++) {
      const segDx = samples[i].x - samples[i - 1].x;
      const segDy = samples[i].y - samples[i - 1].y;
      arcLen += Math.hypot(segDx, segDy);
      if (i >= 2) {
        const prevDx = samples[i - 1].x - samples[i - 2].x;
        const prevDy = samples[i - 1].y - samples[i - 2].y;
        const l1 = Math.hypot(prevDx, prevDy);
        const l2 = Math.hypot(segDx, segDy);
        if (l1 > 1e-4 && l2 > 1e-4) {
          const cosTurn = (prevDx * segDx + prevDy * segDy) / (l1 * l2);
          if (cosTurn < 0.35) return Infinity;
        }
      }
    }
    if (arcLen / chord > 1.85) return Infinity;

    // Hard invariant 4: Never form an acute V-spike (< 115°) when sharing an endpoint with an existing motorway
    const nS = samples.length;
    const startDirX = samples[Math.min(3, nS - 1)].x - samples[0].x;
    const startDirY = samples[Math.min(3, nS - 1)].y - samples[0].y;
    const startLen = Math.hypot(startDirX, startDirY) || 1;
    const endDirX = samples[Math.max(0, nS - 4)].x - samples[nS - 1].x;
    const endDirY = samples[Math.max(0, nS - 4)].y - samples[nS - 1].y;
    const endLen = Math.hypot(endDirX, endDirY) || 1;

    let crossCount = 0;
    for (const other of this.motorways) {
      const oS = other.samples;
      if (!oS || oS.length < 4) continue;
      const oStartDirX = oS[3].x - oS[0].x;
      const oStartDirY = oS[3].y - oS[0].y;
      const oStartLen = Math.hypot(oStartDirX, oStartDirY) || 1;
      const oEndDirX = oS[oS.length - 4].x - oS[oS.length - 1].x;
      const oEndDirY = oS[oS.length - 4].y - oS[oS.length - 1].y;
      const oEndLen = Math.hypot(oEndDirX, oEndDirY) || 1;

      const checkShared = (myX, myY, myUx, myUy, otX, otY, otUx, otUy) => {
        if (Math.hypot(myX - otX, myY - otY) < 8.5) {
          const dot = myUx * otUx + myUy * otUy;
          // Require departing tangents at a shared endpoint to be >= 110° apart (`dot <= -0.34`) so they never form a V-point!
          if (dot > -0.34) return false;
        }
        return true;
      };

      if (!checkShared(sx, sy, startDirX / startLen, startDirY / startLen, other.sx, other.sy, oStartDirX / oStartLen, oStartDirY / oStartLen)) return Infinity;
      if (!checkShared(sx, sy, startDirX / startLen, startDirY / startLen, other.ex, other.ey, oEndDirX / oEndLen, oEndDirY / oEndLen)) return Infinity;
      if (!checkShared(ex, ey, endDirX / endLen, endDirY / endLen, other.sx, other.sy, oStartDirX / oStartLen, oStartDirY / oStartLen)) return Infinity;
      if (!checkShared(ex, ey, endDirX / endLen, endDirY / endLen, other.ex, other.ey, oEndDirX / oEndLen, oEndDirY / oEndLen)) return Infinity;

      // Hard invariant 5: Prevent parallel duplicate corridors & check interior crossings
      const candAng = Math.atan2(ey - sy, ex - sx);
      const otherAng = Math.atan2(other.ey - other.sy, other.ex - other.sx);
      const chordSinDiff = Math.abs(Math.sin(candAng - otherAng));
      const midCand = samples[Math.floor(samples.length * 0.5)];
      const midOther = oS[Math.floor(oS.length * 0.5)];
      if (chordSinDiff < 0.55 && Math.hypot(midCand.x - midOther.x, midCand.y - midOther.y) < 48) {
        return Infinity; // Reject parallel duplicate motorways in the same corridor
      }

      const hit = this.findPolylineIntersection(other.samples, samples);
      if (hit) {
        if (hit.multiple) return Infinity; // Never allow two motorways to cross each other twice!
        const isTrumpetTargetTouch =
          allowTouchTrunkNum === other.number && Math.hypot(hit.x - ex, hit.y - ey) < 4.5;
        if (!isTrumpetTargetTouch) {
          if (forbidAnyCrossing) return Infinity;
          crossCount++;
          if (crossCount > 1) return Infinity;
          const crossSin = Math.abs(Math.sin(hit.angleA - hit.angleB));
          if (crossSin < 0.64) return Infinity;

          const dStartA = this.polylineArcLength(other.samples, 0, hit.idxA);
          const dEndA = this.polylineArcLength(other.samples, hit.idxA, other.samples.length - 1);
          const dStartB = this.polylineArcLength(samples, 0, hit.idxB);
          const dEndB = this.polylineArcLength(samples, hit.idxB, samples.length - 1);

          if (dStartA < 20 || dEndA < 20 || dStartB < 20 || dEndB < 20) return Infinity;
          const nearMajorIc = this.interchanges.some(
            ic => (ic.type === 'cloverleaf' || ic.type === 'trumpet') && Math.hypot(ic.x - hit.x, ic.y - hit.y) < 28.0
          );
          if (nearMajorIc) return Infinity;
          if (!this.isCloverleafFootprintDry(hit.x, hit.y, hit.angleA, hit.angleB, [-1, 1], [-1, 1])) {
            return Infinity;
          }
        }
      }
    }

    let penalty = Math.abs(candidateOff - preferOff) * 0.25 + Math.abs(candidateOff) * 0.12;
    let waterArc = 0;
    let totalWaterArc = 0;
    let riverProxArc = 0;

    for (let i = 0; i < samples.length; i++) {
      const pt = samples[i];
      const gx = Math.round(pt.x);
      const gy = Math.round(pt.y);
      const id = this.idx(gx, gy);
      const segLen = i > 0 ? Math.hypot(pt.x - samples[i - 1].x, pt.y - samples[i - 1].y) : 1.0;

      // Forbid acute hairpin turns (> 70° bend over a 4-sample window) and 90° L-corners (over a 10-sample window)
      if (i >= 2 && i <= samples.length - 3) {
        const vx1 = pt.x - samples[i - 2].x;
        const vy1 = pt.y - samples[i - 2].y;
        const vx2 = samples[i + 2].x - pt.x;
        const vy2 = samples[i + 2].y - pt.y;
        const l1 = Math.hypot(vx1, vy1) || 1;
        const l2 = Math.hypot(vx2, vy2) || 1;
        const cosTurn = (vx1 * vx2 + vy1 * vy2) / (l1 * l2);
        if (cosTurn < 0.35) return Infinity;
      }
      if (i >= 5 && i <= samples.length - 6) {
        const vx1 = pt.x - samples[i - 5].x;
        const vy1 = pt.y - samples[i - 5].y;
        const vx2 = samples[i + 5].x - pt.x;
        const vy2 = samples[i + 5].y - pt.y;
        const l1 = Math.hypot(vx1, vy1) || 1;
        const l2 = Math.hypot(vx2, vy2) || 1;
        const cosWide = (vx1 * vx2 + vy1 * vy2) / (l1 * l2);
        if (cosWide < 0.44) return Infinity;
      }

      if (this.waterMask[id] === 1) {
        riverProxArc += segLen;
        // Never allow an expressway to run longitudinally inside a river channel (> 2 perpendicular river crossings)
        if (riverProxArc > 14.5) return Infinity;
      }

      if (this.waterMask[id] > 0) {
        const wWeight = this.waterMask[id] === 2 ? 1.35 : 0.72;
        waterArc += segLen * wWeight;
        totalWaterArc += segLen * wWeight;
        // Hard invariant 6: Never build causeways across open lakes/bays on continental maps (`<= 9.5` weighted tiles),
        // and only allow narrow-strait causeways (`<= 12.5` weighted tiles) in `island-hopper`!
        const isIH = this.config.archetype === 'island-hopper';
        if (waterArc > (isIH ? 12.5 : 9.5) || totalWaterArc > (isIH ? 15.5 : 13.5)) {
          return Infinity;
        }
        penalty += segLen * (this.waterMask[id] === 2 ? 7.5 : 3.4);
      } else {
        // In `island-hopper`, never use a tiny uninhabited skerry (`landmassId < 0`) as a motorway bridge pier!
        if (this.config.archetype === 'island-hopper' && this.landmassId[id] < 0) {
          return Infinity;
        }
        waterArc = 0;
        if (this.distToWater[id] < 2.2) penalty += segLen * 2.2;
        // Topographic valley preference (weighted by segLen so sample density never biases the score!)
        const ridgeElev = Math.max(0, this.elevationField[id] - this.seaLevel - 0.14);
        penalty += segLen * (ridgeElev * 6.5 + this.slopeField[id] * 2.5);
      }

      // Hard reject passing near an existing motorway's endpoints or running parallel nearby
      if (i > 3 && i < samples.length - 4) {
        for (const other of this.motorways) {
          if (allowTouchTrunkNum === other.number && i > samples.length - 22) continue;
          if (
            Math.hypot(pt.x - other.sx, pt.y - other.sy) < 11.5 ||
            Math.hypot(pt.x - other.ex, pt.y - other.ey) < 11.5
          ) {
            return Infinity;
          }
          for (let j = 2; j < other.samples.length - 2; j += 2) {
            const d = Math.hypot(pt.x - other.samples[j].x, pt.y - other.samples[j].y);
            if (d < 16.0) {
              const a1 = Math.atan2(
                samples[Math.min(samples.length - 1, i + 1)].y - samples[Math.max(0, i - 1)].y,
                samples[Math.min(samples.length - 1, i + 1)].x - samples[Math.max(0, i - 1)].x
              );
              const a2 = Math.atan2(
                other.samples[Math.min(other.samples.length - 1, j + 1)].y - other.samples[Math.max(0, j - 1)].y,
                other.samples[Math.min(other.samples.length - 1, j + 1)].x - other.samples[Math.max(0, j - 1)].x
              );
              const sinCross = Math.abs(Math.sin(a1 - a2));
              if (sinCross < 0.72) {
                return Infinity;
              }
            }
          }
        }
      }
    }

    return penalty;
  }

  /**
   * Coarse-grid (3-tile stride) A* Valley Corridor Pathfinder for Expressways.
   * Routes freeways through low-slope topographic valleys, around open lakes/bays and airport pads,
   * and tangent to intermediate settlements, then extracts control waypoints for B-spline smoothing.
   */
  ensureCoarseValleyCostTable() {
    if (this._coarseBaseCost) return;
    const stride = 3;
    const cw = Math.ceil(this.W / stride);
    const ch = Math.ceil(this.H / stride);
    const table = new Float32Array(cw * ch);
    for (let cy = 0; cy < ch; cy++) {
      const gy = cy * stride;
      for (let cx = 0; cx < cw; cx++) {
        const gx = cx * stride;
        const cid = cy * cw + cx;
        if (!this.inBounds(gx, gy, 1)) {
          table[cid] = 1e6;
          continue;
        }
        const id = this.idx(gx, gy);
        const wm = this.waterMask[id];
        let c = this.noise.fbm(gx * 0.035 + 4.1, gy * 0.035 + 7.3, 2) * 6.5;
        if (wm === 1) {
          c += 22.0;
        } else if (wm === 0) {
          const hAbove = Math.max(0, this.elevationField[id] - this.seaLevel);
          const slope = this.slopeField[id];
          if (this.distToWater[id] < 2.2) c += 26.0;
          c += hAbove >= 0.205
            ? (0.205 * 38.0 + (hAbove - 0.205) * 14.0 + slope * 10.0)
            : (hAbove * 38.0 + slope * 22.0);
          for (const t of this.towns) {
            const dt = Math.hypot(gx - t.x, gy - t.y);
            if (dt >= 7 && dt <= 16) {
              c -= 2.8;
              break;
            }
          }
        }
        table[cid] = c;
      }
    }
    this._coarseBaseCost = table;
    this._coarseG = new Float32Array(cw * ch);
    this._coarseParent = new Int32Array(cw * ch);
    this._coarseSeenGen = new Uint32Array(cw * ch);
    this._coarseClosedGen = new Uint32Array(cw * ch);
    this._coarseGen = 0;
  }

  findValleyMotorwayWaypoints(sx, sy, ex, ey, airportId = null, lateralBias = 0) {
    this.ensureCoarseValleyCostTable();
    const stride = 3;
    const cw = Math.ceil(this.W / stride);
    const ch = Math.ceil(this.H / stride);
    const scx = Math.max(1, Math.min(cw - 2, Math.round(sx / stride)));
    const scy = Math.max(1, Math.min(ch - 2, Math.round(sy / stride)));
    const ecx = Math.max(1, Math.min(cw - 2, Math.round(ex / stride)));
    const ecy = Math.max(1, Math.min(ch - 2, Math.round(ey / stride)));

    const startId = scy * cw + scx;
    const endId = ecy * cw + ecx;
    const gen = ++this._coarseGen;
    const baseCostTable = this._coarseBaseCost;
    const gScore = this._coarseG;
    const parent = this._coarseParent;
    const seenGen = this._coarseSeenGen;
    const closedGen = this._coarseClosedGen;

    const chordDx = ex - sx;
    const chordDy = ey - sy;
    const chordLen = Math.hypot(chordDx, chordDy) || 1;
    const chordNx = -chordDy / chordLen;
    const chordNy = chordDx / chordLen;

    const heapId = [startId];
    const heapF = [0];
    const heapPush = (id, f) => {
      let i = heapId.length;
      heapId.push(id);
      heapF.push(f);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapF[p] <= f) break;
        heapId[i] = heapId[p];
        heapF[i] = heapF[p];
        i = p;
      }
      heapId[i] = id;
      heapF[i] = f;
    };
    const heapPopId = () => {
      const topId = heapId[0];
      const lastId = heapId.pop();
      const lastF = heapF.pop();
      const n = heapId.length;
      if (n > 0) {
        let i = 0;
        while ((i << 1) + 1 < n) {
          let c = (i << 1) + 1;
          if (c + 1 < n && heapF[c + 1] < heapF[c]) c++;
          if (lastF <= heapF[c]) break;
          heapId[i] = heapId[c];
          heapF[i] = heapF[c];
          i = c;
        }
        heapId[i] = lastId;
        heapF[i] = lastF;
      }
      return topId;
    };

    seenGen[startId] = gen;
    gScore[startId] = 0;
    parent[startId] = -1;
    const dirs = [
      [1, 0, 1.0], [-1, 0, 1.0], [0, 1, 1.0], [0, -1, 1.0],
      [1, 1, 1.414], [-1, 1, 1.414], [1, -1, 1.414], [-1, -1, 1.414]
    ];

    let iterCount = 0;
    while (heapId.length > 0 && iterCount++ < 4500) {
      const cid = heapPopId();
      if (cid === endId) {
        const rawPts = [];
        let trace = cid;
        while (trace !== -1) {
          const tx = (trace % cw) * stride;
          const ty = Math.floor(trace / cw) * stride;
          rawPts.push({ x: tx, y: ty });
          trace = parent[trace];
        }
        rawPts.reverse();
        if (rawPts.length < 3) return [{ x: sx, y: sy }, { x: ex, y: ey }];

        // Subsample control points every ~4 coarse steps and apply 1 gentle smoothing pass + S-curve/valley wave
        // so the B-spline curves gracefully through valley passes without flattening into a straight ruler!
        let outWps = [{ x: sx, y: sy }];
        const numCtrl = Math.min(9, Math.max(4, Math.floor(rawPts.length / 4)));
        const waveAmp = Math.min(16.0, chordLen * 0.11) * (lateralBias >= 0 ? 1 : -1);
        for (let k = 1; k <= numCtrl; k++) {
          const frac = k / (numCtrl + 1);
          const idx = Math.floor(frac * (rawPts.length - 1));
          const wave = (Math.sin(frac * Math.PI) * 0.65 + Math.sin(frac * Math.PI * 2) * 0.35) * waveAmp;
          const wx = rawPts[idx].x + chordNx * wave * 0.82;
          const wy = rawPts[idx].y + chordNy * wave * 0.82;
          if (this.inBounds(Math.round(wx), Math.round(wy), 5) && !this.isPointInAirportPad(wx, wy, 2.2, airportId)) {
            outWps.push({ x: wx, y: wy });
          } else {
            outWps.push({ x: rawPts[idx].x, y: rawPts[idx].y });
          }
        }
        outWps.push({ x: ex, y: ey });

        const nextWps = [outWps[0]];
        for (let i = 1; i < outWps.length - 1; i++) {
          const nx = 0.20 * outWps[i - 1].x + 0.60 * outWps[i].x + 0.20 * outWps[i + 1].x;
          const ny = 0.20 * outWps[i - 1].y + 0.60 * outWps[i].y + 0.20 * outWps[i + 1].y;
          if (!this.isPointInAirportPad(nx, ny, 2.2, airportId)) {
            nextWps.push({ x: nx, y: ny });
          } else {
            nextWps.push(outWps[i]);
          }
        }
        nextWps.push(outWps[outWps.length - 1]);
        return nextWps;
      }

      if (closedGen[cid] === gen) continue;
      closedGen[cid] = gen;

      const cx = cid % cw;
      const cy = Math.floor(cid / cw);
      const pid = parent[cid];
      const prevDx = pid !== -1 ? cx - (pid % cw) : 0;
      const prevDy = pid !== -1 ? cy - Math.floor(pid / cw) : 0;

      for (const [dx, dy, baseStep] of dirs) {
        const ncx = cx + dx;
        const ncy = cy + dy;
        if (ncx < 2 || ncx >= cw - 2 || ncy < 2 || ncy >= ch - 2) continue;
        const nid = ncy * cw + ncx;
        if (closedGen[nid] === gen) continue;

        if (pid !== -1 && (dx * prevDx + dy * prevDy) < 0) continue; // Forbid sharp reversals

        const gx = ncx * stride;
        const gy = ncy * stride;
        if (this.isPointInAirportPad(gx, gy, 2.2, airportId)) continue;

        const id = this.idx(gx, gy);
        const wm = this.waterMask[id];

        let cost = baseStep * stride + baseCostTable[nid];
        if (wm === 2) {
          // Distinguish narrow strait crossings (land within 12 tiles ahead) from deep open lakes/bays
          const aheadX = gx + dx * stride * 4;
          const aheadY = gy + dy * stride * 4;
          const isNarrowStrait =
            this.inBounds(aheadX, aheadY, 2) && this.waterMask[this.idx(aheadX, aheadY)] === 0;
          cost += isNarrowStrait ? 24.0 : 125.0;
        }

        // Gentle lateral preference so alternative candidates explore both sides of an obstacle
        const lat = (gx - sx) * chordNx + (gy - sy) * chordNy;
        cost += Math.abs(lat - lateralBias) * 0.04;

        if (pid !== -1 && (dx !== prevDx || dy !== prevDy)) {
          cost += 1.2;
        }

        const tentativeG = gScore[cid] + cost;
        if (seenGen[nid] !== gen || tentativeG < gScore[nid]) {
          seenGen[nid] = gen;
          gScore[nid] = tentativeG;
          parent[nid] = cid;
          const h = Math.hypot(ecx - ncx, ecy - ncy) * stride * 0.92;
          heapPush(nid, tentativeG + h);
        }
      }
    }
    return null;
  }

  createMotorwayEntity(number, sx, sy, ex, ey, algo, airportId = null, townId = null, forcedViaPt = null) {
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    const ap = airportId !== null ? this.airports[airportId] : null;
    const departPull = ap ? Math.min(20, Math.max(7.0, len * 0.30)) : 0;

    const candidateCurves = [];

    if (forcedViaPt && !ap) {
      const c1x = 2 * forcedViaPt.x - 0.5 * (sx + ex);
      const c1y = 2 * forcedViaPt.y - 0.5 * (sy + ey);
      candidateCurves.push({
        waypoints: [{ x: sx, y: sy }, { x: c1x, y: c1y }, { x: ex, y: ey }],
        isOctilinear: false,
        isCloverleafTarget: true,
        off: 0,
        preferOff: 0
      });
    }

    if (algo === 'vignelli-octilinear') {
      const octStart = ap
        ? { x: sx + ap.landNx * Math.min(7, len * 0.20), y: sy + ap.landNy * Math.min(7, len * 0.20) }
        : { x: sx, y: sy };
      for (const bSign of [0, number % 2 === 0 ? 1 : -1, number % 2 === 0 ? -1 : 1]) {
        const octWps = this.buildVignelliOctilinearWaypoints(octStart.x, octStart.y, ex, ey, bSign);
        const fullWps = ap ? [{ x: sx, y: sy }, ...octWps] : octWps;
        candidateCurves.push({ waypoints: fullWps, isOctilinear: true, off: 0, preferOff: 0 });
      }
    }

    const defaultSign = number % 2 === 0 ? 1 : -1;
    const preferMag = algo === 'classic-bezier'
      ? Math.min(12, len * 0.12)
      : (algo === 'terrain-parkway' ? Math.min(10, len * 0.10) : Math.min(7.5, len * 0.09));
    const preferOff = defaultSign * preferMag;

    // 1. Terrain-Guided A* Valley Corridor B-Spline Candidates (enabled for both airport & city trunks!)
    if (len >= 32) {
      const vStartX = ap ? sx + ap.landNx * Math.min(10, len * 0.14) : sx;
      const vStartY = ap ? sy + ap.landNy * Math.min(10, len * 0.14) : sy;
      for (const bias of [defaultSign * 14, -defaultSign * 14, 0]) {
        const valleyWps = this.findValleyMotorwayWaypoints(vStartX, vStartY, ex, ey, airportId, bias);
        if (valleyWps && valleyWps.length >= 4) {
          const fullWps = ap ? [{ x: sx, y: sy }, ...valleyWps] : valleyWps;
          candidateCurves.push({
            waypoints: fullWps,
            isOctilinear: false,
            isValleyCorridor: true,
            off: preferOff,
            preferOff
          });
        }
      }
    }

    // 2. Graceful Topographic C-Curve & S-Curve Bezier Candidates (no dead-straight rulers!)
    const offsetFracs = [
      defaultSign * 0.16,
      -defaultSign * 0.16,
      defaultSign * 0.22,
      -defaultSign * 0.22,
      defaultSign * 0.28,
      -defaultSign * 0.28
    ];

    for (const frac of offsetFracs) {
      const off = Math.max(-32, Math.min(32, len * frac));
      if (ap) {
        for (const pullScale of [1.0, 0.68, 0.45]) {
          const p1 = {
            x: sx + ap.landNx * (departPull * pullScale) + nx * (off * 0.45),
            y: sy + ap.landNy * (departPull * pullScale) + ny * (off * 0.45)
          };
          // C-curve & gentle S-curve p2 options
          for (const sSign of [1.0, -0.75]) {
            const p2 = {
              x: sx + dx * 0.66 + nx * (off * sSign),
              y: sy + dy * 0.66 + ny * (off * sSign)
            };
            candidateCurves.push({
              waypoints: [{ x: sx, y: sy }, p1, p2, { x: ex, y: ey }],
              isOctilinear: false,
              off,
              preferOff
            });
          }
        }
      } else {
        for (const sSign of [1.0, -0.80]) {
          const p1 = {
            x: sx + dx * 0.33 + nx * off,
            y: sy + dy * 0.33 + ny * off
          };
          const p2 = {
            x: sx + dx * 0.67 + nx * (off * sSign),
            y: sy + dy * 0.67 + ny * (off * sSign)
          };
          candidateCurves.push({
            waypoints: [{ x: sx, y: sy }, p1, p2, { x: ex, y: ey }],
            isOctilinear: false,
            off,
            preferOff
          });
        }
      }
    }

    let bestCand = null;
    let bestScore = Infinity;

    for (const cand of candidateCurves) {
      const samples = this.sampleMotorwayCurve(cand.waypoints, cand.isOctilinear);
      const rawScore = this.scoreMotorwaySamples(samples, sx, sy, ex, ey, airportId, cand.preferOff, cand.off);
      const bonus = (cand.isCloverleafTarget ? 35.0 : 0) + (cand.isValleyCorridor ? 15.0 : 0);
      const score = rawScore - bonus;
      if (score < bestScore) {
        bestScore = score;
        bestCand = { waypoints: cand.waypoints, samples };
      }
    }

    if (!bestCand || !Number.isFinite(bestScore)) {
      return null;
    }

    return {
      number,
      sx, sy,
      ex, ey,
      waypoints: bestCand.waypoints,
      samples: bestCand.samples,
      algo,
      airportId,
      townId,
      prunedStart: false,
      prunedEnd: false
    };
  }

  sampleMotorwayCurve(waypoints, isOctilinear = false) {
    if (waypoints.length === 3 && !isOctilinear) {
      const [p0, p1, p2] = waypoints;
      const out = [];
      const steps = 42;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        out.push({
          x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
          y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y
        });
      }
      return out;
    }

    if (waypoints.length === 4 && !isOctilinear) {
      const [p0, p1, p2, p3] = waypoints;
      const out = [];
      const steps = 44;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        const c0 = mt * mt * mt;
        const c1 = 3 * mt * mt * t;
        const c2 = 3 * mt * t * t;
        const c3 = t * t * t;
        out.push({
          x: c0 * p0.x + c1 * p1.x + c2 * p2.x + c3 * p3.x,
          y: c0 * p0.y + c1 * p1.y + c2 * p2.y + c3 * p3.y
        });
      }
      return out;
    }

    if (isOctilinear) {
      // Round octilinear corners slightly with 1-pass beveling so transit lines look crisp
      const out = [];
      const stepsPerSeg = 14;
      for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i];
        const b = waypoints[i + 1];
        for (let s = 0; s < stepsPerSeg; s++) {
          const t = s / stepsPerSeg;
          out.push({
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t
          });
        }
      }
      out.push(waypoints[waypoints.length - 1]);
      return out;
    }

    let pts = waypoints.map(p => ({ x: p.x, y: p.y }));
    for (let iter = 0; iter < 3; iter++) {
      const next = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        next.push({ x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y });
        next.push({ x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y });
      }
      next.push(pts[pts.length - 1]);
      pts = next;
    }
    return pts;
  }

  polylineArcLength(samples, i0, i1) {
    let len = 0;
    const start = Math.max(0, Math.min(i0, i1));
    const end = Math.min(samples.length - 1, Math.max(i0, i1));
    for (let i = start; i < end; i++) {
      len += Math.hypot(samples[i + 1].x - samples[i].x, samples[i + 1].y - samples[i].y);
    }
    return len;
  }

  removeOrphanedTerminalStub(x, y) {
    const stillUsed = this.motorways.some(
      m => (Math.hypot(m.sx - x, m.sy - y) < 1.5 && !m.prunedStart) ||
           (Math.hypot(m.ex - x, m.ey - y) < 1.5 && !m.prunedEnd)
    );
    if (!stillUsed) {
      this.interchanges = this.interchanges.filter(
        ic => !(ic.type === 'terminal-stub' && !ic.isAirportStub && Math.hypot(ic.x - x, ic.y - y) < 1.5)
      );
    }
  }

  /**
   * Attempts to build a 3-way Trumpet Spur Motorway from `(originX, originY)` (an airport gate
   * or unserved town beltway stub) directly into a dry interior point on an existing trunk motorway,
   * terminating at the trumpet throat with a perpendicular arrival tangent.
   */
  tryBuildTrumpetSpurToTrunk(number, originX, originY, algo, airportId = null, townId = null) {
    const ap = airportId !== null ? this.airports[airportId] : null;
    let bestResult = null;
    let bestScore = Infinity;

    for (const trunk of this.motorways) {
      const tSamples = trunk.samples;
      if (!tSamples || tSamples.length < 14) continue;
      const trunkLen = this.polylineArcLength(tSamples, 0, tSamples.length - 1);
      if (trunkLen < 24) continue;

      const iStart = Math.floor(tSamples.length * 0.14);
      const iEnd = Math.ceil(tSamples.length * 0.86);

      for (let i = iStart; i <= iEnd; i++) {
        const hitPt = tSamples[i];
        if (Math.hypot(hitPt.x - trunk.sx, hitPt.y - trunk.sy) < 9.5) continue;
        if (Math.hypot(hitPt.x - trunk.ex, hitPt.y - trunk.ey) < 9.5) continue;

        const nearOtherIc = this.interchanges.some(
          ic => (ic.type === 'cloverleaf' || ic.type === 'trumpet') && Math.hypot(ic.x - hitPt.x, ic.y - hitPt.y) < 24.0
        );
        if (nearOtherIc) continue;

        const pPrev = tSamples[Math.max(0, i - 1)];
        const pNext = tSamples[Math.min(tSamples.length - 1, i + 1)];
        const angleMain = Math.atan2(pNext.y - pPrev.y, pNext.x - pPrev.x);
        const ux = Math.cos(angleMain);
        const uy = Math.sin(angleMain);
        const nx = -uy;
        const ny = ux;

        const toOrigX = originX - hitPt.x;
        const toOrigY = originY - hitPt.y;
        const sideSign = (toOrigX * nx + toOrigY * ny) >= 0 ? 1 : -1;
        const outNx = nx * sideSign;
        const outNy = ny * sideSign;

        if (!this.isTrumpetFootprintDry(hitPt.x, hitPt.y, angleMain, sideSign)) continue;

        const chord = Math.hypot(hitPt.x - originX, hitPt.y - originY);
        const maxChord = ap ? (ap.isHub ? 115 : 64) : 165;
        if (chord < 11 || chord > maxChord) continue;

        // Ensure the origin lies beside the trunk (not collinearly far beyond its endpoints)
        const tDx = trunk.ex - trunk.sx;
        const tDy = trunk.ey - trunk.sy;
        const tLen = Math.hypot(tDx, tDy) || 1;
        const projT = ((originX - trunk.sx) * tDx + (originY - trunk.sy) * tDy) / (tLen * tLen);
        const perpDist = Math.abs((originX - trunk.sx) * (-tDy) + (originY - trunk.sy) * tDx) / tLen;
        if (projT < -0.60 || projT > 1.60 || perpDist < 7.5) continue;

        // Ensure the origin lies on the sideSign half-space of the trunk
        const cosPerp = ((originX - hitPt.x) * outNx + (originY - hitPt.y) * outNy) / (chord || 1);
        if (cosPerp < 0.22) continue;

        // If departing an airport gate, ensure the trumpet target is reachable from the landside gate
        if (ap) {
          const alignGate = ((hitPt.x - originX) * ap.landNx + (hitPt.y - originY) * ap.landNy) / chord;
          if (alignGate < (ap.isHub ? -0.58 : 0.12)) continue;
        }

        const pullScales = ap ? [0.34, 0.20] : [0.34];
        for (const pScale of pullScales) {
          const pullStart = ap ? Math.min(26, Math.max(5.5, chord * pScale)) : chord * 0.34;
          const pullEnd = Math.min(28, Math.max(9.0, chord * 0.38));
          const p0 = { x: originX, y: originY };
          const p1 = ap
            ? { x: originX + ap.landNx * pullStart, y: originY + ap.landNy * pullStart }
            : { x: originX + (hitPt.x - originX) * 0.34, y: originY + (hitPt.y - originY) * 0.34 };
          // Lock P2 along outNx, outNy from hitPt so the spur arrives strictly perpendicular (90°) to the trunk
          const p2 = { x: hitPt.x + outNx * pullEnd, y: hitPt.y + outNy * pullEnd };
          const p3 = { x: hitPt.x, y: hitPt.y };

          const waypoints = [p0, p1, p2, p3];
          const samples = this.sampleMotorwayCurve(waypoints, false);
          const score = this.scoreMotorwaySamples(samples, originX, originY, hitPt.x, hitPt.y, airportId, 0, 0, true, trunk.number);
          if (!Number.isFinite(score)) continue;

          const totalScore = score + chord * 0.45 + (1.0 - cosPerp) * 18;
          if (totalScore < bestScore) {
            bestScore = totalScore;
            bestResult = {
              mw: {
                number,
                sx: originX,
                sy: originY,
                ex: hitPt.x,
                ey: hitPt.y,
                waypoints,
                samples,
                algo,
                airportId,
                townId,
                prunedStart: false,
                prunedEnd: true
              },
              trumpetIc: {
                type: 'trumpet',
                x: hitPt.x,
                y: hitPt.y,
                angleMain,
                sideSign,
                mwayMain: trunk.number,
                mwaySpur: number,
                label: `M-${trunk.number} × M-${number} Trumpet Interchange`
              }
            };
          }
        }
      }
    }

    return bestResult;
  }

  detectAndBuildCloverleafs() {
    for (let i = 0; i < this.motorways.length; i++) {
      for (let j = i + 1; j < this.motorways.length; j++) {
        const mA = this.motorways[i];
        const mB = this.motorways[j];
        const hit = this.findPolylineIntersection(mA.samples, mB.samples);
        if (!hit) continue;

        const crossSin = Math.abs(Math.sin(hit.angleA - hit.angleB));
        if (crossSin < 0.60) continue;

        if (!this.isCloverleafFootprintDry(hit.x, hit.y, hit.angleA, hit.angleB, [-1, 1], [-1, 1])) {
          continue;
        }

        const tooClose = this.interchanges.some(
          ic => (ic.type === 'cloverleaf' || ic.type === 'trumpet') && Math.hypot(ic.x - hit.x, ic.y - hit.y) < 14
        );
        if (tooClose) continue;

        this.displaceBuildingsInRadius(hit.x, hit.y, 5.2);
        this.interchanges.push({
          type: 'cloverleaf',
          x: hit.x,
          y: hit.y,
          angleA: hit.angleA,
          angleB: hit.angleB,
          activeSignsA: [-1, 1],
          activeSignsB: [-1, 1],
          prunedBridgeB: false,
          mwayA: mA.number,
          mwayB: mB.number,
          label: `M-${mA.number} × M-${mB.number} Cloverleaf`
        });
      }
    }
  }

  findPolylineIntersection(samplesA, samplesB) {
    if (!samplesA || !samplesB || samplesA.length < 2 || samplesB.length < 2) return null;
    const aStart = samplesA[0];
    const aEnd = samplesA[samplesA.length - 1];
    const bStart = samplesB[0];
    const bEnd = samplesB[samplesB.length - 1];
    const hits = [];

    for (let i = 0; i < samplesA.length - 1; i++) {
      const a1 = samplesA[i];
      const a2 = samplesA[i + 1];
      for (let j = 0; j < samplesB.length - 1; j++) {
        const b1 = samplesB[j];
        const b2 = samplesB[j + 1];
        const pt = this.segmentIntersection(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y, b2.x, b2.y);
        if (pt) {
          // Ignore intentional shared terminal roundabouts where both motorways meet at the same endpoint
          const nearAEnd = Math.min(Math.hypot(pt.x - aStart.x, pt.y - aStart.y), Math.hypot(pt.x - aEnd.x, pt.y - aEnd.y)) < 2.2;
          const nearBEnd = Math.min(Math.hypot(pt.x - bStart.x, pt.y - bStart.y), Math.hypot(pt.x - bEnd.x, pt.y - bEnd.y)) < 2.2;
          if (nearAEnd && nearBEnd) continue;
          if (hits.some(h => Math.hypot(h.x - pt.x, h.y - pt.y) < 5.5)) continue;
          hits.push({
            x: pt.x,
            y: pt.y,
            idxA: i,
            idxB: j,
            angleA: Math.atan2(a2.y - a1.y, a2.x - a1.x),
            angleB: Math.atan2(b2.y - b1.y, b2.x - b1.x)
          });
        }
      }
    }
    if (hits.length === 0) return null;
    return { ...hits[0], multiple: hits.length > 1 };
  }

  segmentIntersection(x1, y1, x2, y2, x3, y3, x4, y4) {
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-5) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return {
        x: x1 + t * (x2 - x1),
        y: y1 + t * (y2 - y1)
      };
    }
    return null;
  }

  /**
   * Prunes any pre-existing surface street / arterial segments that cross underneath
   * the expressway or poke under the slip-ramps at a one-sided intermediate ramp
   * so only a single clean connector stub enters the roundabout terminal.
   */
  pruneUnderpassRoadsAtRamp(cx, cy, angleRad, connSide) {
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);
    const nx = -sinA;
    const ny = cosA;

    const isInsideRampPruneBox = (px, py) => {
      const dx = px - cx;
      const dy = py - cy;
      const u = dx * cosA + dy * sinA;
      const v = (dx * nx + dy * ny) * connSide;
      return Math.abs(u) <= 4.2 && v >= -3.8 && v < 2.65;
    };

    const updatedRoads = [];
    for (const r of this.roads) {
      if (r.type === 'airport-loop') {
        updatedRoads.push(r);
        continue;
      }
      let currentSeg = [];
      for (let i = 0; i < r.points.length; i++) {
        const pt = r.points[i];
        if (isInsideRampPruneBox(pt.x, pt.y)) {
          const gx = Math.round(pt.x);
          const gy = Math.round(pt.y);
          if (this.inBounds(gx, gy, 1) && this.roadGrid[this.idx(gx, gy)] !== 3) {
            this.roadGrid[this.idx(gx, gy)] = 0;
          }
          if (currentSeg.length >= 2) {
            updatedRoads.push({ points: currentSeg, type: r.type });
          }
          currentSeg = [];
        } else {
          currentSeg.push(pt);
        }
      }
      if (currentSeg.length >= 2) {
        updatedRoads.push({ points: currentSeg, type: r.type });
      }
    }
    this.roads = updatedRoads;

    // Remove any houses whose driveway road tile was pruned inside the ramp box
    this.houses = this.houses.filter(h => !isInsideRampPruneBox(h.roadX, h.roadY));
  }

  buildIntermediateExpresswayRamps() {
    if (!this.config.includeIntermediateRamps) return;

    for (const mw of this.motorways) {
      const samples = mw.samples;
      if (!samples || samples.length < 14) continue;
      const arcLen = this.polylineArcLength(samples, 0, samples.length - 1);
      if (arcLen < 38) continue;

      const hasMajorIc = this.interchanges.some(
        ic => (ic.type === 'cloverleaf' || ic.type === 'trumpet') &&
              (ic.mwayA === mw.number || ic.mwayB === mw.number || ic.mwayMain === mw.number || ic.mwaySpur === mw.number)
      );
      if (hasMajorIc && arcLen < 48) continue;

      // Long cross-state interstates (>= 88 tiles) can host up to 2 intermediate slip-ramps
      const maxRampsForMw = arcLen >= 88 ? 2 : 1;
      for (let rPass = 0; rPass < maxRampsForMw; rPass++) {
        let bestCandidate = null;
        let bestScore = -Infinity;

        const iStart = Math.floor(samples.length * 0.22);
        const iEnd = Math.ceil(samples.length * 0.78);

        for (let i = iStart; i <= iEnd; i += 2) {
          const pt = samples[i];
          const gx = Math.round(pt.x);
          const gy = Math.round(pt.y);
          if (!this.inBounds(gx, gy, 6)) continue;
          const id = this.idx(gx, gy);
          if (this.waterMask[id] > 0 || this.distToWater[id] < 3.4) continue;
          if (this.buildingMask[id] === 3 || this.isPointInAirportPad(pt.x, pt.y, 3.8)) continue;

          if (Math.hypot(pt.x - mw.sx, pt.y - mw.sy) < 16) continue;
          if (Math.hypot(pt.x - mw.ex, pt.y - mw.ey) < 16) continue;

          const nearExisting = this.interchanges.some(ic => Math.hypot(ic.x - pt.x, ic.y - pt.y) < 22);
          if (nearExisting) continue;

          let nearestTown = null;
          let minTownDist = Infinity;
          for (const t of this.towns) {
            const d = Math.hypot(pt.x - t.x, pt.y - t.y);
            if (d < minTownDist) {
              minTownDist = d;
              nearestTown = t;
            }
          }
          if (!nearestTown || minTownDist > 42) continue;
          // Never place an intermediate diamond slip-ramp for a town that ALREADY has a motorway endpoint or slip-ramp!
          const townAlreadyServed = this.interchanges.some(
            ic => ic.townId === nearestTown.id ||
                  ic.townName === nearestTown.name ||
                  (ic.isAirportStub && this.airports[ic.airportId]?.hostTownId === nearestTown.id)
          );
          if (townAlreadyServed) continue;

          const pPrev = samples[Math.max(0, i - 1)];
          const pNext = samples[Math.min(samples.length - 1, i + 1)];
          const angleRad = Math.atan2(pNext.y - pPrev.y, pNext.x - pPrev.x);
          const nx = -Math.sin(angleRad);
          const ny = Math.cos(angleRad);
          const crossHalf = 2.65;

          const c1x = pt.x + nx * crossHalf;
          const c1y = pt.y + ny * crossHalf;
          const c2x = pt.x - nx * crossHalf;
          const c2y = pt.y - ny * crossHalf;
          const d1 = Math.hypot(c1x - nearestTown.x, c1y - nearestTown.y);
          const d2 = Math.hypot(c2x - nearestTown.x, c2y - nearestTown.y);
          const connSide = d1 <= d2 ? 1 : -1;
          const termX = connSide > 0 ? c1x : c2x;
          const termY = connSide > 0 ? c1y : c2y;
          const startX = Math.max(5, Math.min(this.W - 6, Math.round(termX)));
          const startY = Math.max(5, Math.min(this.H - 6, Math.round(termY)));

          if (this.waterMask[this.idx(startX, startY)] > 0 || this.distToWater[this.idx(startX, startY)] < 2.5) continue;
          if (this.isPointInAirportPad(termX, termY, 2.5)) continue;

          const score = 50 - minTownDist;
          if (score > bestScore) {
            bestScore = score;
            bestCandidate = {
              x: pt.x,
              y: pt.y,
              angleRad,
              connSide,
              termX,
              termY,
              startX,
              startY,
              nearestTown
            };
          }
        }

        if (bestCandidate) {
          const { x, y, angleRad, connSide, termX, termY, startX, startY, nearestTown } = bestCandidate;
          const cosA = Math.cos(angleRad);
          const sinA = Math.sin(angleRad);
          const nx = -sinA;
          const ny = cosA;

          this.pruneUnderpassRoadsAtRamp(x, y, angleRad, connSide);

          const blockUnderpassFn = (tx, ty) => {
            const dx = tx - x;
            const dy = ty - y;
            const u = dx * cosA + dy * sinA;
            const v = (dx * nx + dy * ny) * connSide;
            if (Math.abs(u) < 16 && v < 1.6) return true;
            for (let s = 0; s < samples.length; s += 2) {
              if (Math.hypot(tx - samples[s].x, ty - samples[s].y) < 1.6) return true;
            }
            return false;
          };

          const connectorPath = this.findRoadPathAStar(startX, startY, nearestTown.x, nearestTown.y, false, blockUnderpassFn, true);
          if (!connectorPath || connectorPath.length < 2) continue;

          this.displaceBuildingsInRadius(x, y, 3.4);
          this.displaceBuildingsInRadius(termX, termY, 2.5);

          const fullStubPath = [{ x: termX, y: termY, isBridge: false }, ...connectorPath];
          this.commitRoadPath(fullStubPath, 'arterial');

          this.interchanges.push({
            type: 'diamond-ramp',
            x,
            y,
            connSide,
            termX,
            termY,
            connectX: startX,
            connectY: startY,
            angleRad,
            mwayNumber: mw.number,
            townName: nearestTown.name,
            label: `M-${mw.number} / ${nearestTown.name} Slip-Ramp`
          });
        }
      }
    }
  }

  buildNumberedMotorways() {
    const algo = this.config.expresswayAlgo || 'gravity-ring';
    let mwayNumber = 1;
    const maxStateMotorways = 6;

    const townPop = (t) => (t.housesCount + t.destinationsCount * 3 + 16) * (t.airportId !== null ? 1.35 : 1) * (t.tier === 1 ? 1.45 : 1.0);
    const townMotorwayDegree = new Int8Array(this.towns.length);
    const connectedClusters = new Set();

    const isTownNearAnyMotorway = (town, maxDist = 22) => {
      for (const mw of this.motorways) {
        for (let i = 0; i < mw.samples.length; i += 2) {
          if (Math.hypot(town.x - mw.samples[i].x, town.y - mw.samples[i].y) < maxDist) {
            return true;
          }
        }
      }
      return false;
    };

    // Helper: If `town` hosts an unserved International Hub Airport whose landside gate
    // faces `towardX, towardY`, anchor the expressway directly to `(ap.gateX, ap.gateY)`
    // so the International Hub is never stranded 12-16 tiles away from its own city's stub!
    const resolveTownOrHubEndpoint = (town, towardX, towardY, allowHub = true) => {
      const ap = town.airportId !== null ? this.airports[town.airportId] : null;
      if (allowHub && ap && ap.isHub && ap.motorwayId === null) {
        const dGate = Math.hypot(towardX - ap.gateX, towardY - ap.gateY) || 1;
        const alignGate = ((towardX - ap.gateX) * ap.landNx + (towardY - ap.gateY) * ap.landNy) / dGate;
        if (alignGate >= -0.62) {
          return {
            stub: this.createTerminalStreetStub(ap, true, towardX, towardY),
            ap,
            usedHubGate: true
          };
        }
      }
      return {
        stub: this.createTerminalStreetStub(town, false, towardX, towardY),
        ap: null,
        usedHubGate: false
      };
    };

    const isIslandHopper = this.config.archetype === 'island-hopper';
    // Only Tier-1 Metropolises, Tier-2 Regional Cities, and Airport Host Cities serve as motorway termini
    const isMajorMotorwayHub = (t) => t.tier <= 2 || t.airportId !== null || (isIslandHopper && t.tier <= 3);

    // 1A. Primary Inter-Cluster Interstate Spine (M-1) between the two highest-gravity Metropolises/Cities
    const pairs = [];
    for (let i = 0; i < this.towns.length; i++) {
      const tA = this.towns[i];
      if (!isMajorMotorwayHub(tA)) continue;
      for (let j = i + 1; j < this.towns.length; j++) {
        const tB = this.towns[j];
        if (!isMajorMotorwayHub(tB)) continue;
        const d = Math.hypot(tA.x - tB.x, tA.y - tB.y);
        const minPairD = isIslandHopper ? 30 : 58;
        if (d < minPairD || d > 245) continue;
        const sameIslandBonus = isIslandHopper && tA.landmassId === tB.landmassId ? 3.5 : 1.0;
        const diffClusterBonus = tA.clusterId !== tB.clusterId ? 2.40 : 0.45;
        const metroBonus = (tA.tier === 1 ? 1.6 : 1.0) * (tB.tier === 1 ? 1.6 : 1.0);
        const spanBell = 0.70 + 0.60 * Math.exp(-Math.pow((d - 135) / 56, 2));
        const gravity = ((townPop(tA) * townPop(tB)) / Math.pow(d, 0.38)) * diffClusterBonus * metroBonus * spanBell * sameIslandBonus;
        pairs.push({ tA, tB, gravity, d });
      }
    }
    pairs.sort((a, b) => b.gravity - a.gravity);

    let primaryPair = null;

    for (const cand of pairs) {
      const { tA, tB } = cand;
      const endA = resolveTownOrHubEndpoint(tA, tB.x, tB.y, true);
      const endB = resolveTownOrHubEndpoint(tB, tA.x, tA.y, !endA.usedHubGate);

      if (Math.hypot(endB.stub.x - endA.stub.x, endB.stub.y - endA.stub.y) < (isIslandHopper ? 24 : 38)) {
        if (!endA.usedHubGate) this.removeOrphanedTerminalStub(endA.stub.x, endA.stub.y);
        if (!endB.usedHubGate) this.removeOrphanedTerminalStub(endB.stub.x, endB.stub.y);
        continue;
      }
      const startX = endB.usedHubGate ? endB.stub.x : endA.stub.x;
      const startY = endB.usedHubGate ? endB.stub.y : endA.stub.y;
      const endX = endB.usedHubGate ? endA.stub.x : endB.stub.x;
      const endY = endB.usedHubGate ? endA.stub.y : endB.stub.y;
      const startApId = endA.usedHubGate ? endA.ap.id : (endB.usedHubGate ? endB.ap.id : null);

      const mw1 = this.createMotorwayEntity(mwayNumber, startX, startY, endX, endY, algo, startApId, tB.id);
      if (mw1) {
        if (endA.usedHubGate) endA.ap.motorwayId = mwayNumber;
        if (endB.usedHubGate) endB.ap.motorwayId = mwayNumber;
        mwayNumber++;
        this.motorways.push(mw1);
        townMotorwayDegree[tA.id]++;
        townMotorwayDegree[tB.id]++;
        connectedClusters.add(tA.clusterId);
        connectedClusters.add(tB.clusterId);
        primaryPair = cand;
        break;
      } else {
        if (!endA.usedHubGate) this.removeOrphanedTerminalStub(endA.stub.x, endA.stub.y);
        if (!endB.usedHubGate) this.removeOrphanedTerminalStub(endB.stub.x, endB.stub.y);
      }
    }

    // 1B. Transverse Cross-Axis Interstate Trunk (M-2) Forming a 4-Way Cloverleaf Interchange (M-1 × M-2)
    //     Connects two major hubs on opposite sides of M-1 through a dry interior Cloverleaf site on M-1!
    if (this.motorways.length === 1 && !isIslandHopper) {
      const mw1 = this.motorways[0];
      const mDx = mw1.ex - mw1.sx;
      const mDy = mw1.ey - mw1.sy;
      const mLen = Math.hypot(mDx, mDy) || 1;
      const mNx = -mDy / mLen;
      const mNy = mDx / mLen;

      const crossPairs = [];
      for (let i = 0; i < this.towns.length; i++) {
        const tC = this.towns[i];
        if (tC.tier > 3 || townMotorwayDegree[tC.id] >= 1) continue;
        const sideC = (tC.x - mw1.sx) * mNx + (tC.y - mw1.sy) * mNy;
        if (Math.abs(sideC) < 16) continue;
        for (let j = i + 1; j < this.towns.length; j++) {
          const tD = this.towns[j];
          if (tD.tier > 3 || townMotorwayDegree[tD.id] >= 1) continue;
          if (!isMajorMotorwayHub(tC) && !isMajorMotorwayHub(tD)) continue;
          const sideD = (tD.x - mw1.sx) * mNx + (tD.y - mw1.sy) * mNy;
          if (Math.abs(sideD) < 16 || sideC * sideD >= 0) continue; // Must sit on opposite sides of M-1!
          const d = Math.hypot(tD.x - tC.x, tD.y - tC.y);
          if (d < 46 || d > 235) continue;
          const tierWeight = (tC.tier <= 2 ? 1.8 : 1.0) * (tD.tier <= 2 ? 1.8 : 1.0);
          const score = ((townPop(tC) * townPop(tD)) / Math.pow(d, 0.35)) * tierWeight;
          crossPairs.push({ tC, tD, score });
        }
      }
      crossPairs.sort((a, b) => b.score - a.score);

      for (const { tC, tD } of crossPairs) {
        const endC = resolveTownOrHubEndpoint(tC, tD.x, tD.y, true);
        const endD = resolveTownOrHubEndpoint(tD, tC.x, tC.y, !endC.usedHubGate);
        const sx = endD.usedHubGate ? endD.stub.x : endC.stub.x;
        const sy = endD.usedHubGate ? endD.stub.y : endC.stub.y;
        const ex = endD.usedHubGate ? endC.stub.x : endD.stub.x;
        const ey = endD.usedHubGate ? endC.stub.y : endD.stub.y;
        const startApId = endC.usedHubGate ? endC.ap.id : (endD.usedHubGate ? endD.ap.id : null);

        // Find the best dry Cloverleaf crossing point along the middle 56% of M-1
        let bestViaPt = null;
        let minViaDist = Infinity;
        const midX = (sx + ex) * 0.5;
        const midY = (sy + ey) * 0.5;
        const crossAng = Math.atan2(ey - sy, ex - sx);
        const s0 = Math.floor(mw1.samples.length * 0.22);
        const s1 = Math.ceil(mw1.samples.length * 0.78);
        for (let s = s0; s <= s1; s += 2) {
          const pt = mw1.samples[s];
          const pPrev = mw1.samples[Math.max(0, s - 1)];
          const pNext = mw1.samples[Math.min(mw1.samples.length - 1, s + 1)];
          const mAng = Math.atan2(pNext.y - pPrev.y, pNext.x - pPrev.x);
          if (Math.abs(Math.sin(mAng - crossAng)) < 0.64) continue;
          if (!this.isCloverleafFootprintDry(pt.x, pt.y, mAng, crossAng, [-1, 1], [-1, 1])) continue;
          const dMid = Math.hypot(pt.x - midX, pt.y - midY);
          if (dMid < minViaDist) {
            minViaDist = dMid;
            bestViaPt = pt;
          }
        }

        const mw2 = this.createMotorwayEntity(mwayNumber, sx, sy, ex, ey, algo, startApId, tD.id, bestViaPt);
        const crossesM1 = mw2 && this.findPolylineIntersection(mw1.samples, mw2.samples) !== null;
        if (mw2 && crossesM1) {
          if (endC.usedHubGate) endC.ap.motorwayId = mwayNumber;
          if (endD.usedHubGate) endD.ap.motorwayId = mwayNumber;
          mwayNumber++;
          this.motorways.push(mw2);
          townMotorwayDegree[tC.id]++;
          townMotorwayDegree[tD.id]++;
          connectedClusters.add(tC.clusterId);
          connectedClusters.add(tD.clusterId);
          this.detectAndBuildCloverleafs();
          break;
        } else {
          if (!endC.usedHubGate) this.removeOrphanedTerminalStub(endC.stub.x, endC.stub.y);
          if (!endD.usedHubGate) this.removeOrphanedTerminalStub(endD.stub.x, endD.stub.y);
        }
      }
    }

    // 2. Connect All Remaining Metropolitan Clusters into the State Interstate Network
    //    (via 3-way Trumpet Spurs onto existing trunks, shared pass-through beltways, or Cloverleafs)
    const clusterMetros = [...this.clusters].sort((a, b) => townPop(b) - townPop(a));
    for (let pass = 0; pass < 2 && this.motorways.length < maxStateMotorways; pass++) {
      for (const metro of clusterMetros) {
        if (this.motorways.length >= maxStateMotorways) break;
        if (connectedClusters.has(metro.clusterId) || isTownNearAnyMotorway(metro, 26)) {
          connectedClusters.add(metro.clusterId);
          continue;
        }

        // 2A. Try a 3-way Trumpet Spur from this Cluster Metropolis (or any Tier-1/2 city in its cluster) into an existing trunk
        const clusterTowns = [
          metro,
          ...this.towns.filter(t => t.clusterId === metro.clusterId && t.id !== metro.id && isMajorMotorwayHub(t))
        ];
        let linkedCluster = false;

        for (const cTown of clusterTowns) {
          if (linkedCluster) break;
          let bestTargetPt = { x: this.W * 0.5, y: this.H * 0.5 };
          let minD = Infinity;
          for (const mw of this.motorways) {
            for (let s = Math.floor(mw.samples.length * 0.16); s <= Math.ceil(mw.samples.length * 0.84); s += 3) {
              const d = Math.hypot(cTown.x - mw.samples[s].x, cTown.y - mw.samples[s].y);
              if (d < minD) {
                minD = d;
                bestTargetPt = mw.samples[s];
              }
            }
          }

          const mEnd = resolveTownOrHubEndpoint(cTown, bestTargetPt.x, bestTargetPt.y, true);
          const spurRes = this.tryBuildTrumpetSpurToTrunk(
            mwayNumber,
            mEnd.stub.x,
            mEnd.stub.y,
            algo,
            mEnd.usedHubGate ? mEnd.ap.id : null,
            cTown.id
          );
          if (spurRes) {
            if (mEnd.usedHubGate) mEnd.ap.motorwayId = mwayNumber;
            mwayNumber++;
            this.motorways.push(spurRes.mw);
            this.displaceBuildingsInRadius(spurRes.trumpetIc.x, spurRes.trumpetIc.y, 4.6);
            this.pruneUnderpassRoadsAtRamp(spurRes.trumpetIc.x, spurRes.trumpetIc.y, spurRes.trumpetIc.angleMain, -spurRes.trumpetIc.sideSign);
            this.interchanges.push(spurRes.trumpetIc);
            townMotorwayDegree[cTown.id]++;
            connectedClusters.add(metro.clusterId);
            linkedCluster = true;
            break;
          } else if (!mEnd.usedHubGate) {
            this.removeOrphanedTerminalStub(mEnd.stub.x, mEnd.stub.y);
          }
        }
        if (linkedCluster) continue;

        // 2B. Otherwise link `cTown` to an already-connected hub town via a shared beltway stub or Cloverleaf crossing
        //     (or on pass 1 for a Tier-1 Metropolis separated by a wide marine sound, link to the nearest Tier-1/2 city on its landmass)
        for (const cTown of clusterTowns) {
          if (linkedCluster) break;
          const hubCandidates = this.towns
            .filter(t => t.id !== cTown.id && isMajorMotorwayHub(t) && (townMotorwayDegree[t.id] === 1 || connectedClusters.has(t.clusterId) || (pass === 1 && (metro.tier === 1 || isIslandHopper))))
            .sort((a, b) => {
              if (isIslandHopper) {
                const sameLm = (b.landmassId === cTown.landmassId ? 1 : 0) - (a.landmassId === cTown.landmassId ? 1 : 0);
                if (sameLm !== 0) return sameLm;
              }
              const degDiff = (townMotorwayDegree[b.id] === 1 ? 1 : 0) - (townMotorwayDegree[a.id] === 1 ? 1 : 0);
              if (degDiff !== 0) return degDiff;
              return Math.hypot(a.x - cTown.x, a.y - cTown.y) - Math.hypot(b.x - cTown.x, b.y - cTown.y);
            });

          for (const hubTown of hubCandidates) {
            if (townMotorwayDegree[hubTown.id] >= 2) continue;
            const d = Math.hypot(hubTown.x - cTown.x, hubTown.y - cTown.y);
            if (d < (isIslandHopper ? 24 : 34) || d > 225) continue;
            const canShare =
              townMotorwayDegree[hubTown.id] === 1 &&
              this.findPassThroughStubAtTown(hubTown, cTown.x, cTown.y) !== null;
            if (townMotorwayDegree[hubTown.id] >= 1 && !canShare) continue;

            const endA = resolveTownOrHubEndpoint(cTown, hubTown.x, hubTown.y, true);
            const endB = resolveTownOrHubEndpoint(hubTown, cTown.x, cTown.y, !endA.usedHubGate);
            const startX = endB.usedHubGate ? endB.stub.x : endA.stub.x;
            const startY = endB.usedHubGate ? endB.stub.y : endA.stub.y;
            const endX = endB.usedHubGate ? endA.stub.x : endB.stub.x;
            const endY = endB.usedHubGate ? endA.stub.y : endB.stub.y;
            const startApId = endA.usedHubGate ? endA.ap.id : (endB.usedHubGate ? endB.ap.id : null);

            const mwCluster = this.createMotorwayEntity(mwayNumber, startX, startY, endX, endY, algo, startApId, hubTown.id);
            const crossesExisting =
              mwCluster && this.motorways.some(m => this.findPolylineIntersection(m.samples, mwCluster.samples) !== null);
            if (mwCluster && (canShare || crossesExisting || (pass === 1 && (metro.tier === 1 || isIslandHopper)))) {
              if (endA.usedHubGate) endA.ap.motorwayId = mwayNumber;
              if (endB.usedHubGate) endB.ap.motorwayId = mwayNumber;
              mwayNumber++;
              this.motorways.push(mwCluster);
              townMotorwayDegree[cTown.id]++;
              townMotorwayDegree[hubTown.id]++;
              connectedClusters.add(metro.clusterId);
              connectedClusters.add(hubTown.clusterId);
              this.detectAndBuildCloverleafs();
              linkedCluster = true;
              break;
            } else {
              if (!endA.usedHubGate) this.removeOrphanedTerminalStub(endA.stub.x, endA.stub.y);
              if (!endB.usedHubGate) this.removeOrphanedTerminalStub(endB.stub.x, endB.stub.y);
            }
          }
        }
      }
    }

    // 3. International Hub & Regional Airport Expressways
    const sortedAirports = [...this.airports].sort((a, b) => (b.isHub ? 1 : 0) - (a.isHub ? 1 : 0));
    for (const ap of sortedAirports) {
      if (ap.motorwayId !== null) continue;
      if (!ap.isHub && this.motorways.length >= maxStateMotorways) continue;
      const host = this.towns[ap.hostTownId];
      if (!ap.isHub && host && isTownNearAnyMotorway(host, 24)) continue;

      let builtApMotorway = false;

      // 3A. Try connecting the airport gate directly into an existing trunk motorway via a 3-way Trumpet Interchange
      const apStubForSpur = this.createTerminalStreetStub(ap, true, ap.x + ap.landNx * 35, ap.y + ap.landNy * 35);
      const spurRes = this.tryBuildTrumpetSpurToTrunk(mwayNumber, apStubForSpur.x, apStubForSpur.y, algo, ap.id, ap.hostTownId);
      if (spurRes) {
        ap.motorwayId = mwayNumber++;
        this.motorways.push(spurRes.mw);
        if (host) townMotorwayDegree[host.id]++;
        this.displaceBuildingsInRadius(spurRes.trumpetIc.x, spurRes.trumpetIc.y, 4.6);
        this.pruneUnderpassRoadsAtRamp(spurRes.trumpetIc.x, spurRes.trumpetIc.y, spurRes.trumpetIc.angleMain, -spurRes.trumpetIc.sideSign);
        this.interchanges.push(spurRes.trumpetIc);
        builtApMotorway = true;
      }

      // 3B. Otherwise connect the airport gate to a major landside city hub that links into the trunk network
      const minAlignPasses = ap.isHub ? [0.32, -0.05] : [0.40];
      for (const minAlign of minAlignPasses) {
        if (builtApMotorway) break;
        const townCandidates = [];
        for (const t of this.towns) {
          if (!isMajorMotorwayHub(t)) continue;
          if (townMotorwayDegree[t.id] >= 2) continue;
          const canSharePassThrough =
            townMotorwayDegree[t.id] === 1 && this.findPassThroughStubAtTown(t, ap.gateX, ap.gateY) !== null;
          if (townMotorwayDegree[t.id] >= 1 && !canSharePassThrough) continue;
          if (
            primaryPair &&
            ((primaryPair.tA.id === ap.hostTownId && primaryPair.tB.id === t.id) ||
             (primaryPair.tB.id === ap.hostTownId && primaryPair.tA.id === t.id))
          ) {
            continue;
          }
          const dx = t.x - ap.x;
          const dy = t.y - ap.y;
          const landV = dx * ap.landNx + dy * ap.landNy;
          if (landV < 3.0) continue;

          const gateDist = Math.hypot(t.x - ap.gateX, t.y - ap.gateY);
          const minSpan = (canSharePassThrough || townMotorwayDegree[t.id] >= 1) ? (ap.isHub ? 18 : 26) : 44;
          if (gateDist < minSpan || gateDist > 185) continue;

          const alignCos = ((t.x - ap.gateX) * ap.landNx + (t.y - ap.gateY) * ap.landNy) / (gateDist || 1);
          if (alignCos < minAlign) continue;

          const isHost = t.id === ap.hostTownId;
          const networkLinkBonus = canSharePassThrough ? 5.0 : (connectedClusters.has(t.clusterId) ? 1.8 : 0.85);
          const score =
            (townPop(t) / Math.pow(gateDist, 0.58)) *
            (0.55 + 0.65 * Math.max(0, alignCos)) *
            (isHost ? 1.15 : 1.0) *
            networkLinkBonus;
          townCandidates.push({ town: t, score, canSharePassThrough });
        }

        townCandidates.sort((a, b) => b.score - a.score);

        for (const { town: targetTown, canSharePassThrough } of townCandidates) {
          const apStub = this.createTerminalStreetStub(ap, true, targetTown.x, targetTown.y);
          const townStub = this.createTerminalStreetStub(targetTown, false, ap.gateX, ap.gateY);
          const stubChord = Math.hypot(townStub.x - apStub.x, townStub.y - apStub.y);
          if (stubChord < (ap.isHub ? 18 : 24)) {
            this.removeOrphanedTerminalStub(townStub.x, townStub.y);
            continue;
          }

          const mwAp = this.createMotorwayEntity(
            mwayNumber,
            apStub.x, apStub.y,
            townStub.x, townStub.y,
            algo, ap.id, targetTown.id
          );
          const connectsToTrunk =
            mwAp &&
            (this.motorways.length === 0 ||
              canSharePassThrough ||
              this.motorways.some(m => this.findPolylineIntersection(m.samples, mwAp.samples) !== null) ||
              (ap.isHub && minAlign < 0));
          if (mwAp && connectsToTrunk) {
            ap.motorwayId = mwayNumber++;
            this.motorways.push(mwAp);
            townMotorwayDegree[targetTown.id]++;
            if (host) townMotorwayDegree[host.id]++;
            builtApMotorway = true;
            this.detectAndBuildCloverleafs();
            break;
          } else {
            this.removeOrphanedTerminalStub(townStub.x, townStub.y);
          }
        }
      }

      // If no motorway connected, the airport gateway plaza stub remains as the arterial gateway plaza
    }

    // 4. Additional Regional Spurs for Underserved Tier-1/2 Cities (up to maxStateMotorways)
    const underservedTowns = [...this.towns]
      .filter(t => isMajorMotorwayHub(t) && townMotorwayDegree[t.id] === 0 && !isTownNearAnyMotorway(t, 24))
      .sort((a, b) => townPop(b) - townPop(a));

    for (const uTown of underservedTowns) {
      if (this.motorways.length >= maxStateMotorways) break;
      let targetPt = { x: this.W * 0.5, y: this.H * 0.5 };
      let minTrunkD = Infinity;
      for (const mw of this.motorways) {
        for (let s = Math.floor(mw.samples.length * 0.2); s <= Math.ceil(mw.samples.length * 0.8); s += 3) {
          const d = Math.hypot(uTown.x - mw.samples[s].x, uTown.y - mw.samples[s].y);
          if (d < minTrunkD) {
            minTrunkD = d;
            targetPt = mw.samples[s];
          }
        }
      }
      const stub = this.createTerminalStreetStub(uTown, false, targetPt.x, targetPt.y);
      const spurRes = this.tryBuildTrumpetSpurToTrunk(mwayNumber, stub.x, stub.y, algo, null, uTown.id);
      if (spurRes) {
        mwayNumber++;
        this.motorways.push(spurRes.mw);
        this.displaceBuildingsInRadius(spurRes.trumpetIc.x, spurRes.trumpetIc.y, 4.6);
        this.pruneUnderpassRoadsAtRamp(spurRes.trumpetIc.x, spurRes.trumpetIc.y, spurRes.trumpetIc.angleMain, -spurRes.trumpetIc.sideSign);
        this.interchanges.push(spurRes.trumpetIc);
        townMotorwayDegree[uTown.id]++;
      } else {
        this.removeOrphanedTerminalStub(stub.x, stub.y);
      }
    }

    this.detectAndBuildCloverleafs();
  }

  finalizeExpresswayRampsAndTunnels() {
    this.buildIntermediateExpresswayRamps();
    this.detectMountainExpresswayTunnels();
    this.pruneEmptyOuterStreets();

    const cloverCount = this.interchanges.filter(i => i.type === 'cloverleaf' || i.type === 'trumpet').length;
    const rampCount = this.interchanges.filter(i => i.type === 'diamond-ramp').length;
    const tunnelCount = this.motorways.reduce((acc, m) => acc + (m.tunnels ? m.tunnels.length : 0), 0);
    this.logs.push(
      `Built <b>${this.motorways.length} expressways</b>, <b>${cloverCount} system interchanges</b>, <b>${rampCount} ramps</b>${tunnelCount > 0 ? ` & <b>${tunnelCount} mountain tunnels</b>` : ''} (displaced ${this.displacedBuildingsCount} buildings).`
    );
  }

  /**
   * Scans interior spans of all numbered expressways for high-elevation mountain ridge crossings
   * (`elevationField >= seaLevel + 0.21`) and marks subterranean tunnel portals (`mw.tunnels`).
   */
  detectMountainExpresswayTunnels() {
    const tunnelThresh = this.seaLevel + 0.21;
    for (const mw of this.motorways) {
      mw.tunnels = [];
      const samples = mw.samples;
      if (!samples || samples.length < 16) continue;

      const rawSpans = [];
      let inTunnel = false;
      let startIdx = -1;
      for (let i = 6; i <= samples.length - 7; i++) {
        const pt = samples[i];
        const gx = Math.round(pt.x);
        const gy = Math.round(pt.y);
        if (!this.inBounds(gx, gy, 2)) continue;
        const id = this.idx(gx, gy);
        const isHighRidge =
          this.waterMask[id] === 0 &&
          this.elevationField[id] >= tunnelThresh &&
          !this.interchanges.some(ic => Math.hypot(ic.x - pt.x, ic.y - pt.y) < 11.5);

        if (isHighRidge && !inTunnel) {
          inTunnel = true;
          startIdx = i;
        } else if (!isHighRidge && inTunnel) {
          if (i - 1 - startIdx >= 3) {
            rawSpans.push({ i0: startIdx, i1: i - 1 });
          }
          inTunnel = false;
        }
      }
      if (inTunnel && samples.length - 7 - startIdx >= 3) {
        rawSpans.push({ i0: startIdx, i1: samples.length - 7 });
      }

      // Coalesce adjacent tunnel spans separated by a short (< 10 sample) surface speck ONLY if no interchange lies in the gap!
      const mergedSpans = [];
      for (const sp of rawSpans) {
        const prev = mergedSpans[mergedSpans.length - 1];
        let gapHasInterchange = false;
        if (prev && sp.i0 - prev.i1 <= 10) {
          for (let g = prev.i1; g <= sp.i0; g++) {
            const gpt = samples[g];
            if (this.interchanges.some(ic => Math.hypot(ic.x - gpt.x, ic.y - gpt.y) < 12.5)) {
              gapHasInterchange = true;
              break;
            }
          }
        }
        if (prev && sp.i0 - prev.i1 <= 10 && !gapHasInterchange) {
          prev.i1 = sp.i1;
        } else {
          mergedSpans.push({ ...sp });
        }
      }

      for (const { i0, i1 } of mergedSpans) {
        if (i1 - i0 < 4) continue;
        const p0 = samples[i0];
        const p0Next = samples[i0 + 1];
        const p1 = samples[i1];
        const p1Prev = samples[i1 - 1];
        mw.tunnels.push({
          i0,
          i1,
          x0: p0.x,
          y0: p0.y,
          x1: p1.x,
          y1: p1.y,
          ang0: Math.atan2(p0Next.y - p0.y, p0Next.x - p0.x),
          ang1: Math.atan2(p1.y - p1Prev.y, p1.x - p1Prev.x)
        });
      }
    }
  }

  populateLandscapeTrees() {
    const isIslandHopper = this.config.archetype === 'island-hopper';
    // Generate coherent upland woodland groves & windward rain-shadow forests (no confetti sprinkles!)
    for (let y = 5; y < this.H - 5; y += 3) {
      for (let x = 5; x < this.W - 5; x += 3) {
        const id = this.idx(x, y);
        if (this.waterMask[id] > 0 || this.buildingMask[id] > 0 || this.roadGrid[id] > 0) continue;
        if (this.zoneColorIdx[id] >= 0) continue;
        const dWater = this.distToWater[id];
        const isSmallIslet = isIslandHopper && this.landmassId[id] < 0;
        if (dWater < (isSmallIslet ? 1.5 : 4.2)) continue;

        const hillHeight = Math.max(0, this.elevationField[id] - this.seaLevel);
        // Orographic windward bonus (`fertilityField` encodes windward upslope moisture!)
        const moistureBias = (this.fertilityField[id] - 0.35) * 0.45;
        const forestPatch = this.noise.fbm(x * 0.055 + 3.1, y * 0.055 + 8.4, 2) + moistureBias;
        if ((hillHeight > 0.12 && forestPatch + hillHeight * 1.15 > 0.60) || (isSmallIslet && forestPatch > 0.40)) {
          const groveCount = isSmallIslet ? this.rng.int(1, 3) : (moistureBias > 0.06 ? this.rng.int(3, 5) : this.rng.int(1, 3));
          for (let g = 0; g < groveCount; g++) {
            const tx = x + this.rng.range(-1.3, 1.3);
            const ty = y + this.rng.range(-1.3, 1.3);
            const gx = Math.round(tx), gy = Math.round(ty);
            if (!this.inBounds(gx, gy, 3)) continue;
            const gid = this.idx(gx, gy);
            if (this.waterMask[gid] > 0 || this.buildingMask[gid] > 0 || this.roadGrid[gid] > 0 || this.zoneColorIdx[gid] >= 0) continue;
            this.trees.push({
              x: tx,
              y: ty,
              r: this.rng.range(0.55, 0.98),
              color: this.rng.pick(PALETTE.treeDots)
            });
          }
        }
      }
    }

    // Nestle interior mountain spring headwaters (`r.headwaterPt`) inside a lush highland forest grove!
    for (const rObj of this.rivers) {
      if (!rObj.headwaterPt) continue;
      const hx = rObj.headwaterPt.x;
      const hy = rObj.headwaterPt.y;
      for (let g = 0; g < 11; g++) {
        const ang = (g / 11) * Math.PI * 2 + this.rng.range(-0.3, 0.3);
        const rad = this.rng.range(1.6, 4.2);
        const tx = hx + Math.cos(ang) * rad;
        const ty = hy + Math.sin(ang) * rad;
        const gx = Math.round(tx), gy = Math.round(ty);
        if (!this.inBounds(gx, gy, 3)) continue;
        const gid = this.idx(gx, gy);
        if (this.waterMask[gid] > 0 || this.buildingMask[gid] > 0 || this.roadGrid[gid] > 0 || this.zoneColorIdx[gid] >= 0) continue;
        this.trees.push({
          x: tx,
          y: ty,
          r: this.rng.range(0.65, 1.05),
          color: this.rng.pick(PALETTE.treeDots)
        });
      }
    }
  }
}
export function extractWorldTransferables(world) {
  // Drop internal PRNG/Noise & pathfinding scratch buffers before structured clone transfer
  delete world.rng;
  delete world.noise;
  delete world._astarG;
  delete world._astarParent;
  delete world._astarSeenGen;
  delete world._astarClosedGen;
  delete world._coarseBaseCost;
  delete world._coarseG;
  delete world._coarseParent;
  delete world._coarseSeenGen;
  delete world._coarseClosedGen;
  const typedArrays = [
    world.waterMask,
    world.elevationField,
    world.slopeField,
    world.drainageField,
    world.distToWater,
    world.urbanSuitability,
    world.airportHeatmap,
    world.roadGrid,
    world.buildingMask,
    world.zoneColorIdx,
    world.landmassId
  ];
  const buffers = [];
  const seen = new Set();
  for (const arr of typedArrays) {
    if (arr && arr.buffer && !seen.has(arr.buffer)) {
      seen.add(arr.buffer);
      buffers.push(arr.buffer);
    }
  }
  return buffers;
}

export function computeEarliestChangedStage(prev, next) {
  if (
    !prev ||
    prev.seed !== next.seed ||
    prev.archetype !== next.archetype ||
    prev.terrainAlgo !== next.terrainAlgo ||
    prev.waterCoverage !== next.waterCoverage
  ) {
    return 1;
  }
  if (prev.hydrologyAlgo !== next.hydrologyAlgo) return 2;
  if (prev.windAxis !== next.windAxis) return 3;
  if (prev.townCount !== next.townCount) return 4;
  if (prev.airportCount !== next.airportCount || prev.airportMix !== next.airportMix) return 5;
  if (prev.buildingDensity !== next.buildingDensity) return 6;
  if (prev.expresswayAlgo !== next.expresswayAlgo) return 8;
  if (prev.includeIntermediateRamps !== next.includeIntermediateRamps) return 9;
  return 1;
}

export function hydrateTransferredWorld(world) {
  Object.setPrototypeOf(world, ProceduralLogisticsWorld.prototype);
  return world;
}
