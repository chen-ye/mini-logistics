/**
 * @import {
 *   WorldSizePreset,
 *   GeneratorConfig,
 *   Point2D,
 *   WindVector,
 *   HydroFeature,
 *   RiverRibbon,
 *   Landmass,
 *   Town,
 *   Airport,
 *   RoadSegment,
 *   House,
 *   Destination,
 *   TreeDot,
 *   Motorway,
 *   DiamondSlipRamp,
 *   CloverleafInterchange,
 *   DiamondRampInterchange,
 *   Interchange,
 *   VehicleRoutingGraph,
 *   CargoLink,
 *   CommuterRoute,
 *   Stage1WindState,
 *   Stage2ATerrainState,
 *   Stage2BHydrologyState,
 *   Stage3SpatialState,
 *   Stage4SettlementsState,
 *   Stage5AirportsState,
 *   Stage67UrbanState,
 *   Stage8MotorwaysState,
 *   Stage9RampsAndCargoState
 * } from './types.js'
 */
import { SeededRNG, FastNoise2D } from "./math.js";
import {
  PALETTE,
  SYLLABLES_START,
  SYLLABLES_PRE,
  SYLLABLES_ROOT_VALLEY,
  SYLLABLES_ROOT_RIVER,
  SYLLABLES_ROOT_COAST,
  SYLLABLES_ROOT_HILL,
} from "./palette.js";
import { synthesizeTerrainAndBasins } from "./terrain-solvers.js";
import { synthesizeFluvialHydrology } from "./hydrology-solvers.js";

/***************************************************************************
 * 3. PROCEDURAL WORLD GENERATOR CLASS
 ***************************************************************************/
/** @type {Readonly<Record<string, WorldSizePreset>>} */
export const WORLD_SIZE_PRESETS = Object.freeze({
  compact: Object.freeze({
    W: 240,
    H: 150,
    tileSize: 15,
    label: "240×150 Grid",
  }),
  standard: Object.freeze({
    W: 360,
    H: 224,
    tileSize: 15,
    label: "360×224 Grid",
  }),
  large: Object.freeze({ W: 540, H: 336, tileSize: 12, label: "540×336 Grid" }),
  huge: Object.freeze({ W: 720, H: 448, tileSize: 10, label: "720×448 Grid" }),
});

export class ProceduralLogisticsWorld {
  /**
   * @param {GeneratorConfig} [config]
   */
  constructor(config = {}) {
    /** @type {GeneratorConfig} */
    this.config = config;
    /** @type {number} */
    this.W = 0;
    /** @type {number} */
    this.H = 0;
    /** @type {number} */
    this.tileSize = 15;
    /** @type {number} */
    this.seaLevel = 0.34;

    /** @type {Float32Array} */
    this.elevationField = new Float32Array(0);
    /** @type {Float32Array} */
    this.slopeField = new Float32Array(0);
    /** @type {Float32Array} */
    this.drainageField = new Float32Array(0);
    /** @type {Uint8Array} */
    this.waterMask = new Uint8Array(0);
    /** @type {Float32Array} */
    this.fertilityField = new Float32Array(0);
    /** @type {Float32Array} */
    this.distToWater = new Float32Array(0);
    /** @type {Float32Array} */
    this.urbanSuitability = new Float32Array(0);
    /** @type {Float32Array} */
    this.airportHeatmap = new Float32Array(0);
    /** @type {Uint8Array} */
    this.roadGrid = new Uint8Array(0);
    /** @type {Set<number>} */
    this.roadEdges = new Set();
    /** @type {Uint8Array} */
    this.buildingMask = new Uint8Array(0);
    /** @type {Int8Array} */
    this.zoneColorIdx = new Int8Array(0);
    /** @type {Int16Array} */
    this.landmassId = new Int16Array(0);
    /** @type {Landmass[]} */
    this.landmasses = [];

    /** @type {Float32Array} */
    this._astarG = new Float32Array(0);
    /** @type {Int32Array} */
    this._astarParent = new Int32Array(0);
    /** @type {Uint32Array} */
    this._astarSeenGen = new Uint32Array(0);
    /** @type {Uint32Array} */
    this._astarClosedGen = new Uint32Array(0);
    /** @type {number} */
    this._astarGen = 0;
    /** @type {Float32Array | null} */
    this._coarseBaseCost = null;
    /** @type {Float32Array | null} */
    this._coarseG = null;
    /** @type {Int32Array | null} */
    this._coarseParent = null;
    /** @type {Uint32Array | null} */
    this._coarseSeenGen = null;
    /** @type {Uint32Array | null} */
    this._coarseClosedGen = null;
    /** @type {number} */
    this._coarseGen = 0;

    this.ensureGridSize(config.worldSize || "standard");

    /** @type {SeededRNG} */
    this.rng = new SeededRNG(config.seed || "MINI-TYCOON");
    /** @type {FastNoise2D | null} */
    this.noise = null;

    // High-level generated entities
    /** @type {RiverRibbon[]} */
    this.rivers = [];
    /** @type {HydroFeature[]} */
    this.hydroFeatures = [];
    /** @type {Point2D | HydroFeature | null} */
    this.confluencePoint = null;
    /** @type {Town[]} */
    this.clusters = [];
    /** @type {Town[]} */
    this.towns = [];
    /** @type {Airport[]} */
    this.airports = [];
    /** @type {RoadSegment[]} */
    this.roads = [];
    /** @type {Motorway[]} */
    this.motorways = [];
    /** @type {Interchange[]} */
    this.interchanges = [];
    /** @type {House[]} */
    this.houses = [];
    /** @type {Destination[]} */
    this.destinations = [];
    /** @type {CargoLink[]} */
    this.cargoLinks = [];
    /** @type {CommuterRoute[]} */
    this.commuterRoutes = [];
    /** @type {TreeDot[]} */
    this.trees = [];
    /** @type {string[]} */
    this.logs = [];
    /** @type {number} */
    this.displacedBuildingsCount = 0;
    /** @type {number} */
    this.bridgeCount = 0;
    /** @type {number} */
    this.windAngleIndex = 0;
    /** @type {WindVector} */
    this.windVector = { x: 1, y: 0, angleDeg: 0, label: "09/27 (E-W)" };
    /** @type {VehicleRoutingGraph | null} */
    this._vehicleGraph = null;

    /** @type {number} */
    this.hydroVersion = 0;
    /** @type {number} */
    this.urbanVersion = 0;
    /** @type {number} */
    this.reusedThroughStage = 0;
    /** @type {boolean} */
    this.terrainUnchanged = false;
    /** @type {number} */
    this.genTimeMs = 0;
    /** @type {number} */
    this.wallTimeMs = 0;
    /** @type {number} */
    this.bakeTimeMs = 0;
    /** @type {number} */
    this.waitAfterGenMs = 0;
    /** @type {ImageBitmap | OffscreenCanvas | HTMLCanvasElement | null} */
    this.terrainBitmap = null;
    /** @type {boolean} */
    this.reuseTerrainBitmap = false;
  }

  /**
   * @param {string} [worldSize]
   */
  ensureGridSize(worldSize = "standard") {
    const preset = WORLD_SIZE_PRESETS[worldSize] || WORLD_SIZE_PRESETS.standard;
    if (
      this.W === preset.W &&
      this.H === preset.H &&
      this.tileSize === preset.tileSize &&
      this.elevationField
    ) {
      return;
    }
    this.W = preset.W;
    this.H = preset.H;
    this.tileSize = preset.tileSize;
    const size = this.W * this.H;
    this.elevationField = new Float32Array(size);
    this.slopeField = new Float32Array(size);
    this.drainageField = new Float32Array(size);
    this.waterMask = new Uint8Array(size);
    this.fertilityField = new Float32Array(size);
    this.distToWater = new Float32Array(size);
    this.urbanSuitability = new Float32Array(size);
    this.airportHeatmap = new Float32Array(size);
    this.roadGrid = new Uint8Array(size);
    this.roadEdges = new Set();
    this.buildingMask = new Uint8Array(size);
    this.zoneColorIdx = new Int8Array(size).fill(-1);
    this.landmassId = new Int16Array(size).fill(-1);
    this.landmasses = [];

    this._astarG = new Float32Array(size);
    this._astarParent = new Int32Array(size);
    this._astarSeenGen = new Uint32Array(size);
    this._astarClosedGen = new Uint32Array(size);
    this._astarGen = 0;
    this._coarseBaseCost = null;
  }

  idx(x, y) {
    return y * this.W + x;
  }

  edgeKey(x1, y1, x2, y2) {
    const total = this.W * this.H;
    const a = this.idx(x1, y1);
    const b = this.idx(x2, y2);
    return a < b ? a * total + b : b * total + a;
  }

  hasRoadEdge(x1, y1, x2, y2) {
    if (!this.roadEdges) this.syncRoadEdgesFromRoads();
    return this.roadEdges.has(this.edgeKey(x1, y1, x2, y2));
  }

  addRoadEdge(x1, y1, x2, y2) {
    if (!this.roadEdges) this.roadEdges = new Set();
    this.roadEdges.add(this.edgeKey(x1, y1, x2, y2));
  }

  syncRoadEdgesFromRoads() {
    if (!this.roadEdges) this.roadEdges = new Set();
    else this.roadEdges.clear();
    for (const r of this.roads) {
      if (!r.points || r.points.length < 2) continue;
      for (let i = 0; i < r.points.length - 1; i++) {
        const p0 = r.points[i];
        const p1 = r.points[i + 1];
        this.addRoadEdge(
          Math.round(p0.x),
          Math.round(p0.y),
          Math.round(p1.x),
          Math.round(p1.y),
        );
      }
    }
  }

  rebuildRoadGridAndEdges() {
    this.roadGrid.fill(0);
    if (!this.roadEdges) this.roadEdges = new Set();
    else this.roadEdges.clear();
    this.bridgeCount = 0;
    for (const r of this.roads) {
      if (!r.points || r.points.length < 2) continue;
      let inBridge = false;
      for (let i = 0; i < r.points.length; i++) {
        const pt = r.points[i];
        const gx = Math.round(pt.x);
        const gy = Math.round(pt.y);
        if (!this.inBounds(gx, gy, 0)) continue;
        const id = this.idx(gx, gy);
        if (pt.isBridge) {
          if (!inBridge && this.roadGrid[id] !== 3) {
            this.bridgeCount++;
            inBridge = true;
          }
          this.roadGrid[id] = 3;
        } else {
          inBridge = false;
          const code = r.type === "street" ? 1 : 2;
          if (
            this.roadGrid[id] === 0 ||
            (this.roadGrid[id] === 1 && code === 2)
          ) {
            this.roadGrid[id] = code;
          }
        }
        if (i < r.points.length - 1) {
          const next = r.points[i + 1];
          this.addRoadEdge(gx, gy, Math.round(next.x), Math.round(next.y));
        }
      }
    }
  }

  /**
   * When an arterial or connector terminates on an existing town street tile (`roadGrid === 1`),
   * traces the shortest path along committed `this.roadEdges` from `(sx, sy)` to the town's
   * arterial core (`roadGrid >= 2`) and upgrades every tile along that street path to `roadGrid = 2`
   * so `pruneEmptyOuterStreets()` never severs the street between the connector and the town core.
   */
  anchorStreetToArterialCore(sx, sy) {
    if (!this.inBounds(sx, sy, 1)) return;
    const startId = this.idx(sx, sy);
    if (this.roadGrid[startId] !== 1) return;

    const { W } = this;
    const gen = ++this._astarGen;
    const seenGen = this._astarSeenGen;
    const parent = this._astarParent;
    const queue = [startId];
    seenGen[startId] = gen;
    parent[startId] = -1;
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];

    let head = 0;
    let foundCoreId = -1;
    while (head < queue.length) {
      const cid = queue[head++];
      const cx = cid % W;
      const cy = Math.floor(cid / W);
      for (const [dx, dy] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.inBounds(nx, ny, 1)) continue;
        if (!this.hasRoadEdge(cx, cy, nx, ny)) continue;
        const nid = this.idx(nx, ny);
        if (seenGen[nid] === gen) continue;
        seenGen[nid] = gen;
        parent[nid] = cid;
        if (this.roadGrid[nid] >= 2) {
          foundCoreId = nid;
          break;
        }
        queue.push(nid);
      }
      if (foundCoreId !== -1) break;
    }

    if (foundCoreId !== -1) {
      let cur = parent[foundCoreId];
      while (cur !== -1) {
        if (this.roadGrid[cur] === 1) this.roadGrid[cur] = 2;
        cur = parent[cur];
      }
    }
  }

  inBounds(x, y, margin = 0) {
    return (
      x >= margin && x < this.W - margin && y >= margin && y < this.H - margin
    );
  }

  setStageRNG(stageTag) {
    this.rng = new SeededRNG(`${this.config.seed}::${stageTag}`);
  }

  generate() {
    const pipeline = createWorldPipeline();
    return pipeline(this.config, this);
  }

  initPrevailingWind() {
    const axisLabels = [
      { angleDeg: 0, rad: 0, label: "RWY 09/27 (E–W)" },
      { angleDeg: 45, rad: Math.PI / 4, label: "RWY 04/22 (NE–SW)" },
      { angleDeg: 90, rad: Math.PI / 2, label: "RWY 18/36 (N–S)" },
      { angleDeg: 135, rad: (3 * Math.PI) / 4, label: "RWY 13/31 (NW–SE)" },
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
      label: chosen.label,
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
    const tName =
      this.config.terrainAlgo === "quilez-erosion"
        ? "Quilez Derivative-Eroded fBm"
        : this.config.terrainAlgo === "voronoi-plates"
          ? "Voronoi Tectonic Plates"
          : "Tectonic Strike fBm";
    const hName =
      this.config.hydrologyAlgo === "d8-strahler"
        ? "Priority-Flood D8 Strahler"
        : this.config.hydrologyAlgo === "meandering-plain"
          ? "Ikeda Floodplain Meanders"
          : "Downhill A* Thalwegs";
    this.logs.push(
      `Synthesized terrain via <b>${tName}</b> & <b>${this.rivers.length} rivers</b> via <b>${hName}</b>.`,
    );
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
            this.elevationField[id] = Math.min(
              this.elevationField[id],
              this.seaLevel - 0.04,
            );
          }
        } else if (!keepHighlandElevation) {
          // Smoothly grade the surrounding terrain down toward a flat alluvial river terrace
          const t = (Math.sqrt(d2) - radius) / (valleyRad - radius);
          const terraceElev = this.seaLevel + 0.04 + t * 0.07;
          this.elevationField[id] =
            this.elevationField[id] * (0.35 + 0.65 * t) +
            terraceElev * (0.65 * (1 - t));
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
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
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
        const xm = Math.max(0, x - 2),
          xp = Math.min(W - 1, x + 2);
        const ym = Math.max(0, y - 2),
          yp = Math.min(H - 1, y + 2);
        const dzdx =
          (this.elevationField[this.idx(xp, y)] -
            this.elevationField[this.idx(xm, y)]) *
          3.8;
        const dzdy =
          (this.elevationField[this.idx(x, yp)] -
            this.elevationField[this.idx(x, ym)]) *
          3.8;
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
        const lowValleyBonus = Math.exp(
          -Math.pow((heightAboveSea - 0.04) / 0.16, 2),
        );
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
        const orographicDot =
          dzdx * this.windVector.x + dzdy * this.windVector.y;
        const rainShadowMod = Math.max(
          -0.22,
          Math.min(0.26, orographicDot * 0.45),
        );

        this.fertilityField[id] = Math.min(
          1,
          Math.max(
            0,
            flatBonus * 0.42 +
              riverBonus * 0.35 +
              lowValleyBonus * 0.2 +
              rainShadowMod,
          ),
        );
        this.urbanSuitability[id] = Math.min(
          1,
          (flatBonus * 0.32 +
            lowValleyBonus * 0.22 +
            riverBonus * 0.32 +
            featureBonus * 0.14) *
            borderFactor,
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
        let sumX = 0,
          sumY = 0;
        for (let h = 0; h < comp.length; h++) {
          const cid = comp[h];
          const cx = cid % W;
          const cy = Math.floor(cid / W);
          sumX += cx;
          sumY += cy;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const nx = cx + dx,
              ny = cy + dy;
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
            cy: Math.round(sumY / comp.length),
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

  generateTopographicTownName(gx, gy, usedNames) {
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
      const prefix =
        this.rng.next() < 0.24 ? this.rng.pick(SYLLABLES_START) : "";
      const rootA = this.rng.pick(SYLLABLES_PRE);
      let rootPool = SYLLABLES_ROOT_VALLEY;
      if (dW < 10 && nearRiver && this.rng.next() < 0.65)
        rootPool = SYLLABLES_ROOT_RIVER;
      else if (dW < 10 && nearSeaOrLake && this.rng.next() < 0.65)
        rootPool = SYLLABLES_ROOT_COAST;
      else if (elev > this.seaLevel + 0.16 && this.rng.next() < 0.65)
        rootPool = SYLLABLES_ROOT_HILL;

      const rootB = this.rng.pick(rootPool);
      const suffix =
        nearSeaOrLake && dW < 9 && !prefix && this.rng.next() < 0.18
          ? "-on-Sea"
          : "";
      const name = (prefix + rootA + rootB + suffix).replace(/\b\w/g, (c) =>
        c.toUpperCase(),
      );
      if (!usedNames.has(name)) {
        usedNames.add(name);
        return name;
      }
    }
    const fallback = "Metro " + (usedNames.size + 1);
    usedNames.add(fallback);
    return fallback;
  }

  /**
   * Phase 1 of Two-Phase Historical Settlement Co-Evolution (Stage 4):
   * Seeds the founding Tier-1 Metropolises & Tier-2 Regional Cities at primary river confluences,
   * harbor bays, and island anchors BEFORE airports and ancient valley trunk highways are routed.
   * Secondary Tier-3 Market/Bridgehead Towns & Tier-4 Crossroads Hamlets nucleate in Stage 6C
   * along the resulting trunk highways and river bridgeheads!
   */
  seedSettlements() {
    const targetCount = this.config.townCount || 20;
    const usedNames = new Set();

    const numMetros = 2;
    const numRegional = Math.min(6, Math.max(4, Math.round(targetCount * 0.3)));
    this.clusters = [];

    const sectorCenters = [
      { x: this.W * 0.24, y: this.H * 0.34 },
      { x: this.W * 0.76, y: this.H * 0.64 },
      { x: this.W * 0.74, y: this.H * 0.24 },
      { x: this.W * 0.24, y: this.H * 0.74 },
      { x: this.W * 0.5, y: this.H * 0.48 },
    ];

    const isIslandHopper = this.config.archetype === "island-hopper";
    const landmassTownCount = new Int16Array(
      Math.max(1, this.landmasses.length),
    );
    const spanScale = Math.sqrt(this.W / 360);

    // Pre-collect dry-land settlement candidate sites once (`O(N)`)
    const candidateSites = [];
    for (let y = 14; y < this.H - 14; y += 3) {
      for (let x = 14; x < this.W - 14; x += 3) {
        const id = this.idx(x, y);
        if (this.waterMask[id] > 0 || this.distToWater[id] < 2.8) continue;
        const lmId = this.landmassId[id];
        if (lmId < 0) continue;
        const slope = this.slopeField[id];
        if (slope > 0.48 || this.elevationField[id] > this.seaLevel + 0.42)
          continue;
        const dW = this.distToWater[id];
        candidateSites.push({
          x,
          y,
          lmId,
          slope,
          baseSuit: this.urbanSuitability[id] * 0.72,
          wfBonus13: Math.exp(-Math.pow((dW - 3.0) / 3.8, 2)) * 0.34,
          wfBonus4: Math.exp(-Math.pow((dW - 6.0) / 7.5, 2)) * 0.16,
        });
      }
    }

    const majorIslandsCount = isIslandHopper
      ? this.landmasses.filter((lm) => lm.size >= 160).length
      : 0;
    const phase1Count = Math.min(
      targetCount,
      Math.max(
        numRegional,
        isIslandHopper ? majorIslandsCount + 2 : numRegional,
      ),
    );

    for (let i = 0; i < phase1Count; i++) {
      const isClusterAnchor = i < numRegional;
      const tier = i < numMetros ? 1 : i < numRegional ? 2 : 3;
      const urbanRadius =
        tier === 1 ? (isIslandHopper ? 17 : 21) : tier === 2 ? 12 : 8;
      const minSpacing =
        (tier === 1
          ? isIslandHopper
            ? 78
            : 105
          : tier === 2
            ? isIslandHopper
              ? 38
              : 52
            : 25) * (tier <= 2 ? spanScale : 1.0);
      const maxSlope = tier <= 2 ? 0.38 : 0.46;

      let bestScore = -1;
      let bestPt = null;

      for (let cIdx = 0; cIdx < candidateSites.length; cIdx++) {
        const site = candidateSites[cIdx];
        if (site.slope > maxSlope) continue;
        const { x, y, lmId } = site;

        let tooClose = false;
        for (const t of this.towns) {
          const reqDist =
            tier === 1 && t.tier === 1
              ? (isIslandHopper ? 78 : 105) * spanScale
              : Math.max(minSpacing, (t.urbanRadius + urbanRadius) * 1.38);
          const dx = x - t.x;
          const dy = y - t.y;
          if (dx * dx + dy * dy < reqDist * reqDist) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;

        let score =
          site.baseSuit + site.wfBonus13 + this.rng.range(-0.025, 0.025);

        if (
          isIslandHopper &&
          landmassTownCount[lmId] === 0 &&
          this.landmasses[lmId].size >= 160
        ) {
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
        const colorIdx =
          (isClusterAnchor ? i : clusterId + (i % 2)) %
          PALETTE.districtColors.length;
        const tierTitle =
          tier === 1
            ? "Metropolis"
            : tier === 2
              ? "Regional City"
              : "Market Town";
        const name = this.generateTopographicTownName(
          bestPt.x,
          bestPt.y,
          usedNames,
        );
        const iata = name
          .replace(/[^A-Za-z]/g, "")
          .slice(0, 3)
          .toUpperCase();

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
          _seededInPhase1: true,
          boroughs: [{ x: bestPt.x, y: bestPt.y, r: urbanRadius }],
        };
        this.towns.push(townObj);
        if (isClusterAnchor) {
          this.clusters.push(townObj);
        }
      }
    }
    this.logs.push(
      `Seeded <b>${this.towns.length} founding capitals & regional cities</b> (2 Metropolises, ${this.towns.length - 2} Regional Ports).`,
    );
  }

  /*************************************************************************
   * STAGE 5: MULTI-TIER AIRPORT SITE-SELECTION & LANDSIDE TERMINAL ROAD NETWORK
   *************************************************************************/
  getAirportTierSpec(aIdx) {
    const mix = this.config.airportMix || "hub-regional";
    if (aIdx === 0 || (mix === "dual-hub" && aIdx === 1)) {
      return {
        airportClass: "HUB",
        classLabel: "International Hub (Dual-Runway)",
        isHub: true,
        runwayCount: 2,
        halfLen: 7.4,
        halfWid: 3.8,
        approachLen: 15,
        demandPins: 7,
      };
    }
    if (mix === "hub-reg-cargo" && aIdx >= 2) {
      return {
        airportClass: "CRG",
        classLabel: "Air Cargo & Logistics Airfield",
        isHub: false,
        runwayCount: 1,
        halfLen: 4.6,
        halfWid: 2.3,
        approachLen: 10,
        demandPins: 4,
      };
    }
    return {
      airportClass: "REG",
      classLabel: "Regional Commercial Airport",
      isHub: false,
      runwayCount: 1,
      halfLen: 5.2,
      halfWid: 2.6,
      approachLen: 12,
      demandPins: 4,
    };
  }

  solveAndPlaceAirports() {
    const isIslandHopper = this.config.archetype === "island-hopper";
    const effectiveApCount = isIslandHopper
      ? Math.max(this.config.airportCount, 5)
      : this.config.airportCount;
    const targetAirports = Math.min(effectiveApCount, this.towns.length);
    const baseRad = this.windVector.rad;

    this.airportHeatmap.fill(0);

    // Sort candidate host cities by tier & population priority;
    // in `island-hopper`, prioritize placing 1 airport on each distinct island (`landmassId`) first!
    const byTier = [...this.towns].sort(
      (a, b) => a.tier - b.tier || b.suitabilityScore - a.suitabilityScore,
    );
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

    for (
      let tIdx = 0;
      tIdx < candidateTowns.length && this.airports.length < targetAirports;
      tIdx++
    ) {
      const hostTown = candidateTowns[tIdx];
      if (!hostTown) break;
      // In `island-hopper`, avoid placing 2 airports on the same island while other islands still need one
      if (
        isIslandHopper &&
        tIdx < candidateTowns.length - 2 &&
        this.airports.some(
          (ap) => this.towns[ap.hostTownId].landmassId === hostTown.landmassId,
        )
      ) {
        continue;
      }

      const aIdx = this.airports.length;
      const spec = this.getAirportTierSpec(aIdx);
      const {
        halfLen,
        halfWid,
        approachLen,
        isHub,
        airportClass,
        classLabel,
        runwayCount,
        demandPins,
      } = spec;

      // Allow regional & island airfields to align with local valley or coastal peninsula shelves
      const angleCandidates = isIslandHopper
        ? [
            baseRad,
            baseRad + Math.PI / 6,
            baseRad - Math.PI / 6,
            baseRad + Math.PI / 3,
            baseRad - Math.PI / 3,
            baseRad + Math.PI * 0.5,
          ]
        : isHub
          ? [baseRad]
          : [
              baseRad,
              baseRad + Math.PI / 7,
              baseRad - Math.PI / 7,
              baseRad + Math.PI / 4,
            ];

      let bestSite = null;
      let bestScore = -1;

      const scanR = Math.round(hostTown.urbanRadius + (isHub ? 36 : 28));
      const y0 = Math.max(22, hostTown.y - scanR);
      const y1 = Math.min(this.H - 22, hostTown.y + scanR);
      const x0 = Math.max(22, hostTown.x - scanR);
      const x1 = Math.min(this.W - 22, hostTown.x + scanR);

      let sumMetroX = 0,
        sumMetroY = 0;
      for (const otherT of this.towns) {
        sumMetroX += otherT.x;
        sumMetroY += otherT.y;
      }
      const metroCx = sumMetroX / (this.towns.length || 1);
      const metroCy = sumMetroY / (this.towns.length || 1);
      const angleTrig = angleCandidates.map((rad) => ({
        rad,
        cosA: Math.cos(rad),
        sinA: Math.sin(rad),
      }));
      const minInscribedDistToWater = isIslandHopper
        ? 1.8
        : Math.min(4.2, halfWid + 1.0);
      const maxCenterSlope = isIslandHopper ? 0.48 : 0.4;
      const idealDist = hostTown.urbanRadius + (isHub ? 7.5 : 5.5);
      const minHostDist = hostTown.urbanRadius * (isIslandHopper ? 0.72 : 0.82);
      const maxHostDist = idealDist + 24;
      const candStubDist = isHub ? 5.8 : isIslandHopper ? 4.0 : 4.6;

      // Hoist (cx, cy) candidate site filtering outside the angle loop so angle-independent
      // terrain, shoreline inscribed-circle, NIMBY, and airspace checks run once per cell
      for (let cy = y0; cy <= y1; cy += 2) {
        for (let cx = x0; cx <= x1; cx += 2) {
          if (cx > this.W - 56 && cy < 36) continue;
          if (cx < 88 && cy < 28) continue;
          const id = this.idx(cx, cy);
          if (this.waterMask[id] > 0) continue;
          if (
            this.slopeField[id] > maxCenterSlope ||
            this.distToWater[id] < minInscribedDistToWater
          )
            continue;

          const distHost = Math.hypot(cx - hostTown.x, cy - hostTown.y);
          if (distHost < minHostDist || distHost > maxHostDist) continue;

          // NIMBY & Urban Core Exclusion against ALL towns (angle-independent)
          let nimbyViolation = false;
          for (const t of this.towns) {
            const dTown = Math.hypot(cx - t.x, cy - t.y);
            if (
              dTown <
              t.urbanRadius * (isIslandHopper ? 0.72 : 0.8) +
                (isHub ? 1.8 : 1.0)
            ) {
              nimbyViolation = true;
              break;
            }
          }
          if (nimbyViolation) continue;

          // Minimum airspace separation from already placed airports (angle-independent)
          let tooCloseToAirport = false;
          for (const ap of this.airports) {
            if (Math.hypot(cx - ap.x, cy - ap.y) < (isIslandHopper ? 34 : 42)) {
              tooCloseToAirport = true;
              break;
            }
          }
          if (tooCloseToAirport) continue;

          const proximityScore = Math.exp(
            -Math.pow((distHost - idealDist) / 11.0, 2),
          );
          const toTownX = hostTown.x - cx;
          const toTownY = hostTown.y - cy;
          const toMetroDist = Math.hypot(metroCx - cx, metroCy - cy) || 1;

          for (const { rad, cosA, sinA } of angleTrig) {
            const dotNormal = toTownX * -sinA + toTownY * cosA;
            const broadsideAlignment = Math.abs(dotNormal) / (distHost || 1);
            if (broadsideAlignment < (isIslandHopper ? 0.18 : 0.34)) continue;
            const candidateApronSide = dotNormal >= 0 ? 1 : -1;
            const candLandNx = -sinA * candidateApronSide;
            const candLandNy = cosA * candidateApronSide;

            let landsideTownsCount = 0;
            for (const otherT of this.towns) {
              const odx = otherT.x - cx;
              const ody = otherT.y - cy;
              const odist = Math.hypot(odx, ody);
              const oLandV = odx * candLandNx + ody * candLandNy;
              if (oLandV >= 4.0 && odist >= 16 && odist <= 185) {
                landsideTownsCount++;
              }
            }
            if (
              !isIslandHopper &&
              landsideTownsCount < (isHub && this.towns.length >= 4 ? 2 : 1)
            )
              continue;
            const inwardMetroDot =
              ((metroCx - cx) * candLandNx + (metroCy - cy) * candLandNy) /
              toMetroDist;
            if (!isIslandHopper && isHub && inwardMetroDot < -0.25) continue;

            // Oriented Bounding Box Footprint & Flat-Terrain Slope Check
            let landOk = true;
            let slopeSum = 0;
            let obbCount = 0;
            const obbPad = isIslandHopper ? 0.8 : 2.0;
            for (let u = -halfLen - obbPad; u <= halfLen + obbPad; u += 1.5) {
              for (
                let v = -halfWid - obbPad;
                v <= candStubDist + obbPad;
                v += 1.5
              ) {
                const gx = Math.round(cx + u * cosA + v * candLandNx);
                const gy = Math.round(cy + u * sinA + v * candLandNy);
                if (
                  !this.inBounds(gx, gy, 5) ||
                  this.waterMask[this.idx(gx, gy)] > 0
                ) {
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
            if (
              !this.inBounds(candGateX, candGateY, 6) ||
              this.distToWater[this.idx(candGateX, candGateY)] <
                (isIslandHopper ? 1.4 : 2.6)
            ) {
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

            const waterApproachBonus =
              sampleCount > 0 ? (waterUnderApproach / sampleCount) * 0.2 : 0;
            const flatTerrainBonus = Math.max(0, 1.0 - avgSlope * 2.4) * 0.14;
            const broadsideBonus = broadsideAlignment * 0.14;
            const regionalReachBonus =
              Math.min(0.16, landsideTownsCount * 0.045) +
              Math.max(0, inwardMetroDot) * 0.12;
            const totalScore = Math.min(
              1.0,
              proximityScore * 0.42 +
                approachScore * 0.18 +
                waterApproachBonus +
                flatTerrainBonus +
                broadsideBonus +
                regionalReachBonus,
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
                approachClearance: Math.min(
                  100,
                  Math.round((approachScore + waterApproachBonus) * 100),
                ),
                distHost: Math.round(distHost),
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
        const dotNormal = toTownX * -sinA + toTownY * cosA;
        const apronSide = dotNormal >= 0 ? 1 : -1;

        const landNx = -sinA * apronSide;
        const landNy = cosA * apronSide;

        const outerDist = isHub ? 3.2 : 2.9;
        const stubDist = isHub ? 5.8 : 4.6;

        const gateX = Math.max(
          6,
          Math.min(this.W - 7, Math.round(bestSite.cx + landNx * stubDist)),
        );
        const gateY = Math.max(
          6,
          Math.min(this.H - 7, Math.round(bestSite.cy + landNy * stubDist)),
        );
        const curbX = Math.max(
          6,
          Math.min(this.W - 7, Math.round(bestSite.cx + landNx * outerDist)),
        );
        const curbY = Math.max(
          6,
          Math.min(this.H - 7, Math.round(bestSite.cy + landNy * outerDist)),
        );

        const nameMap = {
          HUB: `${hostTown.name} International Hub`,
          REG: `${hostTown.name} Regional Airport`,
          CRG: `${hostTown.name} Cargo Airfield`,
        };
        const suffixMap = { HUB: "X", REG: "R", CRG: "C" };

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
          runwayLabel: isHub
            ? `${this.windVector.label} L/R`
            : this.windVector.label,
          suitabilityScore: Math.round(bestSite.score * 100),
          approachClearance: bestSite.approachClearance,
          distToCBD: bestSite.distHost,
          colorIdx: hostTown.colorIdx,
          palette: hostTown.palette,
          demandPins,
          motorwayId: null,
          landsideLoopPts: [],
          accessStubPts: [],
        };

        hostTown.airportId = airport.id;
        this.airports.push(airport);

        // Reserve Airfield + Landside Terminal Plaza in buildingMask over exact OBB integer tiles
        const boundR = Math.ceil(Math.hypot(halfLen + 3, stubDist + 3));
        for (
          let gy = Math.max(1, bestSite.cy - boundR);
          gy <= Math.min(this.H - 2, bestSite.cy + boundR);
          gy++
        ) {
          for (
            let gx = Math.max(1, bestSite.cx - boundR);
            gx <= Math.min(this.W - 2, bestSite.cx + boundR);
            gx++
          ) {
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

    const hubCount = this.airports.filter(
      (a) => a.airportClass === "HUB",
    ).length;
    const regCount = this.airports.filter(
      (a) => a.airportClass === "REG",
    ).length;
    const crgCount = this.airports.filter(
      (a) => a.airportClass === "CRG",
    ).length;
    this.logs.push(
      `Placed <b>${this.airports.length} airports</b> (${hubCount} Intl Hub, ${regCount} Regional${crgCount ? `, ${crgCount} Cargo` : ""}) with terminal loop roads.`,
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
      const padLandV =
        ap.id === allowGateAirportId
          ? ap.isHub
            ? 3.8
            : 3.0
          : Math.max(
              ap.halfWid + (ap.isHub ? 1.1 : 0.75) + margin,
              (ap.stubDist || 5.2) + 0.5,
            );
      if (Math.abs(u) <= padU && v >= -padAirV && v <= padLandV) {
        return true;
      }
    }
    return false;
  }

  doesSegmentCrossAirport(
    x1,
    y1,
    x2,
    y2,
    margin = 1.6,
    allowGateAirportId = null,
  ) {
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
      if (
        this.doesSegmentCrossAirport(
          samples[i].x,
          samples[i].y,
          samples[i + 1].x,
          samples[i + 1].y,
          margin,
          allowGateAirportId,
        )
      ) {
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
    const boundHalfSpan = ap.isHub ? 3.6 : 2.5;
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

    // Rasterize the airport access avenue spine on roadGrid & roadEdges for vehicle navigation
    const stubPts = [];
    const dxSpine = ap.gateX - ap.curbX;
    const dySpine = ap.gateY - ap.curbY;
    const spineSteps = Math.max(Math.abs(dxSpine), Math.abs(dySpine));
    const uxSpine = Math.sign(dxSpine);
    const uySpine = Math.sign(dySpine);
    for (let s = 0; s <= spineSteps; s++) {
      const sx = ap.curbX + uxSpine * Math.min(s, Math.abs(dxSpine));
      const sy = ap.curbY + uySpine * Math.min(s, Math.abs(dySpine));
      if (this.inBounds(sx, sy, 2)) {
        this.roadGrid[this.idx(sx, sy)] = 2;
        this.buildingMask[this.idx(sx, sy)] = 4;
        if (
          stubPts.length === 0 ||
          stubPts[stubPts.length - 1].x !== sx ||
          stubPts[stubPts.length - 1].y !== sy
        ) {
          stubPts.push({ x: sx, y: sy, isBridge: false });
        }
      }
    }
    for (let i = 0; i < stubPts.length - 1; i++) {
      this.addRoadEdge(
        stubPts[i].x,
        stubPts[i].y,
        stubPts[i + 1].x,
        stubPts[i + 1].y,
      );
    }

    ap.accessStubPts = stubPts;
    if (stubPts.length >= 2) {
      this.roads.push({
        points: stubPts,
        type: "airport-spine",
        airportId: ap.id,
      });
    }

    // Always register the Airport Gateway Entrance Roundabout Interchange at `(gateX, gateY)`
    this.interchanges.push({
      type: "terminal-stub",
      isAirportStub: true,
      airportId: ap.id,
      x: ap.gateX,
      y: ap.gateY,
      stubEndX: ap.curbX,
      stubEndY: ap.curbY,
      angleRad: Math.atan2(ny, nx),
      label: `${ap.iata} Gateway Plaza`,
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
    const nodes = this.towns.map((t) => ({
      x: t.x,
      y: t.y,
      type: "town",
      ref: t,
    }));
    const connected = new Set([0]);
    const edges = [];

    const riverAwareEdgeCost = (a, b) => {
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      let riverHits = 0;
      let seaHits = 0;
      let ridgePenalty = 0;
      const steps = 22;
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const sx = Math.round(a.x + (b.x - a.x) * t);
        const sy = Math.round(a.y + (b.y - a.y) * t);
        if (this.inBounds(sx, sy, 1)) {
          const id = this.idx(sx, sy);
          const wm = this.waterMask[id];
          if (wm === 1) riverHits++;
          else if (wm === 2) seaHits++;
          if (this.buildingMask[id] === 3) riverHits += 4;
          ridgePenalty +=
            Math.max(0, this.elevationField[id] - this.seaLevel - 0.12) * 24.0 +
            this.slopeField[id] * 12.0;
        }
      }
      const diffCluster = a.ref.clusterId !== b.ref.clusterId ? 24 : 0;
      const waterCost =
        (riverHits > 0 ? 22 + riverHits * 3.5 : 0) +
        (seaHits > 0
          ? this.config.archetype === "island-hopper"
            ? 28 + seaHits * 5.0
            : 85 + seaHits * 32.0
          : 0);
      return d + diffCluster + ridgePenalty + waterCost;
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

    const isIslandHopper = this.config.archetype === "island-hopper";
    const scaleSpan = Math.max(1, this.W / 360);

    // Add up to `Math.max(2, Math.floor(nodes.length * 0.45))` regional valley loop chords
    // between nearby towns (`d <= 88 * scaleSpan`) whose current graph distance exceeds `1.65 * d`.
    if (nodes.length >= 4) {
      const maxChords = Math.max(2, Math.floor(nodes.length * 0.45));
      const computeGraphDist = (src, dst) => {
        const dist = new Float64Array(nodes.length).fill(Infinity);
        const visited = new Uint8Array(nodes.length);
        dist[src] = 0;
        for (let step = 0; step < nodes.length; step++) {
          let u = -1;
          let bestD = Infinity;
          for (let k = 0; k < nodes.length; k++) {
            if (!visited[k] && dist[k] < bestD) {
              bestD = dist[k];
              u = k;
            }
          }
          if (u === -1 || u === dst) break;
          visited[u] = 1;
          for (const [ea, eb] of edges) {
            const v = ea === u ? eb : eb === u ? ea : -1;
            if (v !== -1 && !visited[v]) {
              const w = Math.hypot(
                nodes[u].x - nodes[v].x,
                nodes[u].y - nodes[v].y,
              );
              if (dist[u] + w < dist[v]) dist[v] = dist[u] + w;
            }
          }
        }
        return dist[dst];
      };

      for (let c = 0; c < maxChords; c++) {
        let bestChord = null;
        let bestScore = Infinity;
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const already = edges.some(
              (e) => (e[0] === i && e[1] === j) || (e[0] === j && e[1] === i),
            );
            if (already) continue;
            const d = Math.hypot(
              nodes[i].x - nodes[j].x,
              nodes[i].y - nodes[j].y,
            );
            if (d > 88 * scaleSpan) continue;
            if (computeGraphDist(i, j) <= 1.65 * d) continue;
            const cost = riverAwareEdgeCost(nodes[i], nodes[j]);
            if (cost < bestScore) {
              bestScore = cost;
              bestChord = [i, j];
            }
          }
        }
        if (!bestChord) break;
        edges.push(bestChord);
      }
    }

    // Commit surface arterial roads within urban clusters or regional valley neighbors (<= 112 tiles);
    // in `island-hopper`, only connect towns on the same island or across narrow straits (<= 54 tiles)
    // so deep ocean channels between outer islands are served by the aircraft fleet!
    const townRoadDegree = new Int8Array(nodes.length);
    const skippedEdges = [];
    for (const [i, j] of edges) {
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      const sameLandmass = nodes[i].ref.landmassId === nodes[j].ref.landmassId;
      const sameCluster = nodes[i].ref.clusterId === nodes[j].ref.clusterId;
      if (isIslandHopper && !sameLandmass && d > 54 * scaleSpan) {
        continue;
      }
      if (!sameCluster && d > 112 * scaleSpan) {
        skippedEdges.push([i, j]);
        continue;
      }
      const path = this.findRoadPathAStar(
        nodes[i].x,
        nodes[i].y,
        nodes[j].x,
        nodes[j].y,
        true,
      );
      if (path) {
        const bridgeTiles = path.filter((pt) => pt.isBridge).length;
        if (isIslandHopper && !sameLandmass && bridgeTiles > 20) continue;
        if (!isIslandHopper && bridgeTiles > 11 && sameLandmass) continue;
        this.commitRoadPath(path, "arterial");
        townRoadDegree[i]++;
        townRoadDegree[j]++;
      }
    }
    if (!isIslandHopper) {
      for (const [i, j] of skippedEdges) {
        if (townRoadDegree[i] === 0 || townRoadDegree[j] === 0) {
          const path = this.findRoadPathAStar(
            nodes[i].x,
            nodes[i].y,
            nodes[j].x,
            nodes[j].y,
            true,
          );
          if (path) {
            this.commitRoadPath(path, "arterial");
            townRoadDegree[i]++;
            townRoadDegree[j]++;
          }
        }
      }
    }

    for (const ap of this.airports) {
      const host = this.towns[ap.hostTownId];
      if (host) {
        let path = this.findRoadPathAStar(
          ap.gateX,
          ap.gateY,
          host.x,
          host.y,
          false,
          null,
          true,
        );
        if (!path) {
          path = this.findRoadPathAStar(
            ap.gateX,
            ap.gateY,
            host.x,
            host.y,
            true,
            null,
            true,
          );
        }
        if (path) this.commitRoadPath(path, "arterial");
      }
    }

    // Phase 2 of Historical Co-Evolution (Stage 6C & 6D):
    // Nucleate Tier-3 Market/Bridgehead Towns & Tier-4 Crossroads Hamlets along the ancient trunk
    // highways, river bridgeheads, and unserved river valleys, then carve their grids & connect!
    this.seedSecondaryTownsAlongTrunks();
  }

  seedSecondaryTownsAlongTrunks() {
    const targetCount = this.config.townCount || 20;
    const startCount = this.towns.length;
    if (startCount >= targetCount) {
      this.logs.push(
        `Routed <b>${this.roads.length} regional roads & streets</b> and <b>${this.bridgeCount} bridges</b>.`,
      );
      return;
    }

    const usedNames = new Set(this.towns.map((t) => t.name));
    const isIslandHopper = this.config.archetype === "island-hopper";
    const landmassTownCount = new Int16Array(
      Math.max(1, this.landmasses.length),
    );
    for (const t of this.towns) {
      if (t.landmassId >= 0 && t.landmassId < landmassTownCount.length) {
        landmassTownCount[t.landmassId]++;
      }
    }

    // 1. Collect river bridgeheads (`roadGrid === 2` within 1..5 tiles of `roadGrid === 3`)
    //    and rural trunk highway tiles (`roadGrid === 2` outside existing Phase-1 city envelopes)
    const bridgeheadPts = [];
    const trunkRoadPts = [];
    for (let y = 8; y < this.H - 8; y += 2) {
      for (let x = 8; x < this.W - 8; x += 2) {
        const id = this.idx(x, y);
        if (this.roadGrid[id] !== 2 || this.waterMask[id] !== 0) continue;
        const insidePhase1 = this.towns.some(
          (t) => Math.hypot(x - t.x, y - t.y) < t.urbanRadius + 6.5,
        );
        if (insidePhase1) continue;
        trunkRoadPts.push({ x, y });

        let nearBridge = false;
        for (let dy = -4; dy <= 4 && !nearBridge; dy += 2) {
          for (let dx = -4; dx <= 4; dx += 2) {
            if (
              this.inBounds(x + dx, y + dy, 1) &&
              this.roadGrid[this.idx(x + dx, y + dy)] === 3
            ) {
              nearBridge = true;
              break;
            }
          }
        }
        if (nearBridge) {
          bridgeheadPts.push({ x, y });
        }
      }
    }

    // 2. Collect candidate sites with pre-evaluated distances to bridgeheads and trunk highways
    const candidateSites = [];
    for (let y = 16; y < this.H - 16; y += 3) {
      for (let x = 16; x < this.W - 16; x += 3) {
        const id = this.idx(x, y);
        if (this.waterMask[id] > 0 || this.distToWater[id] < 2.8) continue;
        const lmId = this.landmassId[id];
        if (lmId < 0) continue;
        const slope = this.slopeField[id];
        if (slope > 0.44 || this.elevationField[id] > this.seaLevel + 0.36)
          continue;
        if (this.isPointInAirportPad(x, y, 7.5)) continue;

        // Exclude airport low-altitude runway approach cones so secondary towns never spawn under flight paths
        let inApproachCone = false;
        for (const ap of this.airports) {
          const adx = x - ap.x;
          const ady = y - ap.y;
          const cosA = Math.cos(ap.angleRad);
          const sinA = Math.sin(ap.angleRad);
          const u = Math.abs(adx * cosA + ady * sinA);
          const v = Math.abs(-adx * sinA + ady * cosA);
          if (u <= ap.halfLen + ap.approachLen + 4 && v <= ap.halfWid + 5.5) {
            inApproachCone = true;
            break;
          }
        }
        if (inApproachCone) continue;

        const dW = this.distToWater[id];
        candidateSites.push({
          x,
          y,
          lmId,
          slope,
          dW,
          baseSuit: this.urbanSuitability[id] * 0.68,
          wfBonus13: Math.exp(-Math.pow((dW - 3.0) / 3.8, 2)) * 0.32,
          wfBonus4: Math.exp(-Math.pow((dW - 6.0) / 7.5, 2)) * 0.16,
        });
      }
    }

    const newTowns = [];
    for (let i = startCount; i < targetCount; i++) {
      const tier = i < Math.round(targetCount * 0.65) ? 3 : 4;
      const urbanRadius = tier === 3 ? 8 : 5;
      const minSpacing = tier === 3 ? 21 : 14;

      let bestScore = -1;
      let bestPt = null;

      for (let cIdx = 0; cIdx < candidateSites.length; cIdx++) {
        const site = candidateSites[cIdx];
        const { x, y, lmId, dW } = site;

        let tooClose = false;
        for (const t of this.towns) {
          const reqDist = Math.max(
            minSpacing,
            (t.urbanRadius + urbanRadius) * 1.28,
          );
          const dx = x - t.x;
          const dy = y - t.y;
          if (dx * dx + dy * dy < reqDist * reqDist) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;

        let minBridgeD = Infinity;
        for (const bp of bridgeheadPts) {
          const d = Math.hypot(x - bp.x, y - bp.y);
          if (d < minBridgeD) minBridgeD = d;
        }
        let minTrunkD = Infinity;
        let nearTrunkPt = null;
        for (let k = 0; k < trunkRoadPts.length; k++) {
          const tp = trunkRoadPts[k];
          const d = Math.hypot(x - tp.x, y - tp.y);
          if (d < minTrunkD) {
            minTrunkD = d;
            nearTrunkPt = tp;
          }
        }
        if (!isIslandHopper && minTrunkD > (tier === 3 ? 52.0 : 14.0)) continue;

        const waterfrontBonus = tier === 3 ? site.wfBonus13 : site.wfBonus4;
        let score =
          site.baseSuit + waterfrontBonus + this.rng.range(-0.025, 0.025);

        if (
          isIslandHopper &&
          landmassTownCount[lmId] === 0 &&
          this.landmasses[lmId].size >= 160
        ) {
          score += 0.65;
        } else if (tier === 3) {
          // Tier 3 Market / Bridgehead Towns strongly nucleate at river bridgeheads, trunk crossroads,
          // or unserved river valleys within 52 tiles of the growing trunk network!
          if (minBridgeD <= 12.0) {
            score += Math.exp(-Math.pow((minBridgeD - 3.5) / 4.8, 2)) * 0.62;
          }
          if (minTrunkD <= 12.0) {
            score += Math.exp(-Math.pow((minTrunkD - 2.5) / 4.5, 2)) * 0.44;
          } else if (dW <= 6.0 && minTrunkD <= 48.0) {
            score += 0.18;
          }
        } else {
          // Tier 4 Crossroads / Valley Hamlets nucleate directly along the growing valley trunk & branch network
          if (minTrunkD <= 8.5) {
            score += Math.exp(-Math.pow((minTrunkD - 2.0) / 3.6, 2)) * 0.62;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestPt = { x, y, score, lmId, nearTrunkPt };
        }
      }

      if (bestPt) {
        landmassTownCount[bestPt.lmId]++;
        let clusterId = 0;
        let minCD = Infinity;
        for (const cl of this.clusters) {
          const cd = Math.hypot(bestPt.x - cl.x, bestPt.y - cl.y);
          if (cd < minCD) {
            minCD = cd;
            clusterId = cl.clusterId;
          }
        }
        const colorIdx = (clusterId + (i % 2)) % PALETTE.districtColors.length;
        const tierTitle = tier === 3 ? "Market Town" : "Rural Hamlet";
        const name = this.generateTopographicTownName(
          bestPt.x,
          bestPt.y,
          usedNames,
        );
        const iata = name
          .replace(/[^A-Za-z]/g, "")
          .slice(0, 3)
          .toUpperCase();

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
          _seededInPhase1: false,
          boroughs: [{ x: bestPt.x, y: bestPt.y, r: urbanRadius }],
        };

        // Immediately connect this newly nucleated town into the growing trunk road network
        // so subsequent towns & hamlets can also nucleate along its branch road & river bridges!
        if (this.roadGrid[this.idx(townObj.x, townObj.y)] === 0) {
          const tp = bestPt.nearTrunkPt;
          let path = tp
            ? this.findRoadPathAStar(
                townObj.x,
                townObj.y,
                tp.x,
                tp.y,
                true,
                null,
                true,
              )
            : null;
          if (!path || path.length < 2) {
            let nearestTarget = this.towns[0];
            let minD = Infinity;
            for (const other of this.towns) {
              const sameLm = other.landmassId === townObj.landmassId;
              if (isIslandHopper && !sameLm) continue;
              const d = Math.hypot(other.x - townObj.x, other.y - townObj.y);
              if (d < minD) {
                minD = d;
                nearestTarget = other;
              }
            }
            if (nearestTarget) {
              path = this.findRoadPathAStar(
                townObj.x,
                townObj.y,
                nearestTarget.x,
                nearestTarget.y,
                true,
                null,
                true,
              );
            }
          }
          if (path && path.length >= 2) {
            this.commitRoadPath(path, "arterial");
            for (let pIdx = 0; pIdx < path.length; pIdx += 2) {
              const pt = path[pIdx];
              if (!pt.isBridge) {
                trunkRoadPts.push({ x: pt.x, y: pt.y });
                if (
                  (pIdx > 0 && path[pIdx - 1].isBridge) ||
                  (pIdx + 1 < path.length && path[pIdx + 1].isBridge)
                ) {
                  bridgeheadPts.push({ x: pt.x, y: pt.y });
                }
              }
            }
          }
        }

        this.towns.push(townObj);
        newTowns.push(townObj);
      }
    }

    // 3. Carve local street grids for the newly nucleated Tier-3 & Tier-4 towns around their trunk connection!
    this.carveTownStreetGrids((t) => !t._seededInPhase1);

    this.logs.push(
      `Co-evolved <b>${this.towns.length} settlements</b> (${newTowns.length} bridgehead/crossroads towns nucleated along <b>${this.roads.length} trunk roads</b> & <b>${this.bridgeCount} bridges</b>).`,
    );
  }

  findRoadPathAStar(
    sx,
    sy,
    ex,
    ey,
    allowWaterBridge = true,
    blockedFn = null,
    stopOnExistingRoad = false,
    options = null,
  ) {
    const { W, H } = this;
    const isInterchangeBypass = Boolean(options && options.isInterchangeBypass);
    const customTurnPenalty =
      options && options.turnPenalty !== undefined ? options.turnPenalty : null;
    const extraCostFn =
      options && options.extraCostFn ? options.extraCostFn : null;
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
      [1, 0, 1.0],
      [-1, 0, 1.0],
      [0, 1, 1.0],
      [0, -1, 1.0],
      [1, 1, 1.414],
      [-1, 1, 1.414],
      [1, -1, 1.414],
      [-1, -1, 1.414],
    ];

    while (heapId.length > 0) {
      const cid = heapPopId();
      const distFromStart = Math.hypot(
        (cid % W) - sx,
        Math.floor(cid / W) - sy,
      );
      if (
        cid === endId ||
        (stopOnExistingRoad &&
          distFromStart >= 3.0 &&
          this.buildingMask[cid] !== 4 &&
          (this.roadGrid[cid] === 1 || this.roadGrid[cid] === 2))
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
      const gpid = pid !== -1 ? parent[pid] : -1;
      const gPrevDx = gpid !== -1 ? (pid % W) - (gpid % W) : 0;
      const gPrevDy =
        gpid !== -1 ? Math.floor(pid / W) - Math.floor(gpid / W) : 0;
      const currIsWater = this.waterMask[cid] > 0;

      for (const [dx, dy, baseStep] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.inBounds(nx, ny, 3)) continue;
        const nid = this.idx(nx, ny);
        if (closedGen[nid] === gen) continue;

        // Never tunnel through any placed building (house, commercial/industrial lot, or airport runway!)
        if (this.buildingMask[nid] >= 1 && this.buildingMask[nid] <= 3) {
          continue;
        }
        if (blockedFn && nid !== startId && blockedFn(nx, ny, cx, cy)) continue;

        const isWater = this.waterMask[nid] > 0;
        if (isWater && !allowWaterBridge) continue;

        // Inside urban town zones (`zoneColorIdx >= 0`) or adjacent to buildings, strictly enforce
        // orthogonal (0°/90°) movement so city streets never slice 45° diagonal wedges across orthogonal
        // blocks or clip building corners, while rural roads (`zoneColorIdx === -1`) and interchange
        // bypass rings (`buildingMask === 4`) can freely take 45° diagonal steps!
        const c1Id = this.idx(cx + dx, cy);
        const c2Id = this.idx(cx, cy + dy);
        const inInterchangeRing =
          isInterchangeBypass ||
          (this.buildingMask[cid] === 4 && this.buildingMask[nid] === 4);
        if (
          dx !== 0 &&
          dy !== 0 &&
          !this.hasRoadEdge(cx, cy, nx, ny) &&
          ((!inInterchangeRing &&
            (this.zoneColorIdx[cid] >= 0 ||
              this.zoneColorIdx[nid] >= 0 ||
              this.zoneColorIdx[c1Id] >= 0 ||
              this.zoneColorIdx[c2Id] >= 0)) ||
            (this.buildingMask[c1Id] >= 1 && this.buildingMask[c1Id] <= 3) ||
            (this.buildingMask[c2Id] >= 1 && this.buildingMask[c2Id] <= 3))
        ) {
          continue;
        }

        let stepCost = baseStep;
        if (this.hasRoadEdge(cx, cy, nx, ny)) {
          stepCost *= 0.06;
        } else if (this.roadGrid[nid] > 0) {
          stepCost *= this.roadGrid[cid] === 0 ? 0.35 : 0.65;
        } else if (isWater) {
          // Bridge Spacing Guard (`16` tiles): add a `+240.0` surcharge when stepping onto water
          // within 16 tiles of an existing bridge (`roadGrid === 3`) so nearby routes share the existing bridgehead.
          if (!currIsWater) {
            let nearExistingBridge = false;
            const rMinY = Math.max(0, ny - 16);
            const rMaxY = Math.min(H - 1, ny + 16);
            const rMinX = Math.max(0, nx - 16);
            const rMaxX = Math.min(W - 1, nx + 16);
            for (let by = rMinY; by <= rMaxY && !nearExistingBridge; by++) {
              const dyB = by - ny;
              const rowOff = by * W;
              for (let bx = rMinX; bx <= rMaxX; bx++) {
                const dxB = bx - nx;
                if (
                  dxB * dxB + dyB * dyB <= 256 &&
                  this.roadGrid[rowOff + bx] === 3
                ) {
                  nearExistingBridge = true;
                  break;
                }
              }
            }
            if (nearExistingBridge) {
              stepCost += 240.0;
            }
          }
          // River bridges (`waterMask === 1`) must cross from bank to bank (dry land within 1..5 steps ahead along `dx, dy`),
          // NEVER walk lengthwise down the middle of a river channel!
          if (this.waterMask[nid] === 1) {
            let crossesToBank = false;
            for (let s = 1; s <= 5; s++) {
              const bx = nx + dx * s;
              const by = ny + dy * s;
              if (
                this.inBounds(bx, by, 1) &&
                this.waterMask[this.idx(bx, by)] === 0
              ) {
                crossesToBank = true;
                break;
              }
            }
            stepCost *= crossesToBank ? 8.5 : 65.0;
          } else {
            let crossesNarrowBay = false;
            for (let s = 1; s <= 9; s++) {
              const bx = nx + dx * s;
              const by = ny + dy * s;
              if (
                this.inBounds(bx, by, 1) &&
                this.waterMask[this.idx(bx, by)] === 0
              ) {
                crossesNarrowBay = true;
                break;
              }
            }
            stepCost *= crossesNarrowBay
              ? 24.0
              : this.config.archetype === "island-hopper"
                ? 38.0
                : 95.0;
          }
          if (currIsWater && pid !== -1 && (dx !== prevDx || dy !== prevDy)) {
            stepCost += 85.0;
          }
        } else {
          // Never wrap a road in a tight U-loop around an interior mountain spring headwater (`r.headwaterPt`)!
          for (const rObj of this.rivers) {
            if (
              rObj.headwaterPt &&
              Math.hypot(nx - rObj.headwaterPt.x, ny - rObj.headwaterPt.y) < 6.0
            ) {
              stepCost += 65.0;
              break;
            }
          }
          // Keep dry-land arterials set back from the 1-tile cream riverbank border
          const dW = this.distToWater[nid];
          if (dW < 2.5 && !currIsWater) {
            stepCost += (2.6 - dW) * 2.5;
          }
          // Topographic valley-following & contour-hugging cost:
          // Penalize both uphill and downhill grade nonlinearly (`absDeltaElev^2`) and strongly penalize
          // climbing onto upland contour terraces (`hAbove > 0.105`) so roads hug valley floors around hills!
          const hAbove = Math.max(0, this.elevationField[nid] - this.seaLevel);
          const uplandOver = Math.max(0, hAbove - 0.105);
          const absDeltaElev =
            Math.abs(this.elevationField[nid] - this.elevationField[cid]) /
            baseStep;
          const terraceStepPenalty = hAbove >= 0.115 ? 5.5 : 0;
          const gradeCost =
            absDeltaElev * 64.0 +
            absDeltaElev * absDeltaElev * 1350.0 +
            this.slopeField[nid] * 22.0 +
            hAbove * 14.0 +
            uplandOver * 46.0 +
            uplandOver * uplandOver * 140.0 +
            terraceStepPenalty;
          stepCost += gradeCost;
          // Valley-bench discount only below the first hill contour (`hAbove <= 0.11`)
          if (absDeltaElev < 0.0035 && hAbove <= 0.11) {
            stepCost *= 0.86;
          }
          // Subtle low-frequency topographic meander bias on rural dry land so long valley arterials
          // gently follow micro-topography instead of forming 45-tile dead-straight CAD ruler lines
          if (
            this.zoneColorIdx[nid] < 0 &&
            !isInterchangeBypass &&
            this.noise
          ) {
            const meanderMod =
              (this.noise.fbm(nx * 0.048 + 1.9, ny * 0.048 + 6.2, 2) + 0.45) *
              0.68;
            stepCost += Math.max(0, meanderMod);
          }
          // Strongly prefer existing orthogonal streets inside urban zones
          if (
            this.zoneColorIdx[nid] >= 0 &&
            !isInterchangeBypass &&
            this.buildingMask[nid] !== 4
          ) {
            stepCost *= 4.5;
          }
          // Universal Parallel-Road Inhibition (rural + urban): when off-road (`roadGrid[cid] === 0 && roadGrid[nid] === 0`),
          // penalize running parallel within 1..3 tiles of an existing road so nearby routes merge into a shared trunk.
          if (
            this.roadGrid[cid] === 0 &&
            !isInterchangeBypass &&
            this.buildingMask[nid] !== 4
          ) {
            const pnx = -dy;
            const pny = dx;
            let parallelPenalty = 0;
            for (const s of [-3, -2, -1, 1, 2, 3]) {
              const sx2 = nx + pnx * s;
              const sy2 = ny + pny * s;
              if (
                this.inBounds(sx2, sy2, 1) &&
                this.roadGrid[this.idx(sx2, sy2)] > 0
              ) {
                const pen = Math.abs(s) <= 2 ? 34.0 : 16.0;
                if (pen > parallelPenalty) parallelPenalty = pen;
              }
            }
            stepCost += parallelPenalty;
          }
          if (extraCostFn) {
            stepCost += extraCostFn(nx, ny);
          }
        }

        // Angle-Graded Rural Turn Costs: charge `+0.85` for 45° chamfers (`dot > 0`) vs. `+7.5` for
        // raw 90° corners (`dot === 0`) outside urban zones, plus a 2-step anti-oscillation guard (`gpid`).
        if (pid !== -1 && (dx !== prevDx || dy !== prevDy)) {
          if (customTurnPenalty !== null) {
            stepCost += customTurnPenalty;
          } else {
            const inUrban =
              this.zoneColorIdx[cid] >= 0 || this.zoneColorIdx[nid] >= 0;
            const dot = dx * prevDx + dy * prevDy;
            stepCost += inUrban ? 4.2 : dot > 0 ? 0.85 : 7.5;
            if (
              !inUrban &&
              gpid !== -1 &&
              (prevDx !== gPrevDx || prevDy !== gPrevDy)
            ) {
              stepCost += 4.5;
            }
          }
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

  commitRoadPath(path, roadType = "arterial", extraProps = null) {
    if (!path || path.length < 2) return;

    const isNearAnyTownEnvelope = (x, y) => {
      for (const t of this.towns) {
        const envR = (t.effectiveR || t.urbanRadius || 12) + 3.5;
        if (Math.hypot(x - t.x, y - t.y) <= envR) return true;
        if (t.boroughs) {
          for (const br of t.boroughs) {
            if (Math.hypot(x - br.x, y - br.y) <= envR) return true;
          }
        }
      }
      return false;
    };

    // Collapse 1-tile rural staircase jogs BEFORE writing `this.roadGrid`:
    // Only collapse two perpendicular 1-tile cardinal steps (`|dx1|+|dy1| === 1`, `|dx2|+|dy2| === 1`,
    // `dx1*dx2 + dy1*dy2 === 0`) outside town envelopes where `roadGrid === 0` and `buildingMask === 0`,
    // guaranteeing that `prev -> next` is strictly a 1-tile 45° diagonal step and never chains into a 2:1 knight's move!
    const simplifyRuralStaircase = (pts) => {
      if (roadType === "street" || pts.length < 3) return pts;
      const out = [pts[0]];
      for (let i = 1; i < pts.length - 1; i++) {
        const prev = out[out.length - 1];
        const curr = pts[i];
        const next = pts[i + 1];

        const isKeyNode =
          this.airports.some((a) => a.gateX === curr.x && a.gateY === curr.y) ||
          this.interchanges.some((ic) => ic.x === curr.x && ic.y === curr.y);
        if (isKeyNode) {
          out.push(curr);
          continue;
        }

        const dx1 = curr.x - prev.x;
        const dy1 = curr.y - prev.y;
        const dx2 = next.x - curr.x;
        const dy2 = next.y - curr.y;

        if (
          Math.abs(dx1) + Math.abs(dy1) === 1 &&
          Math.abs(dx2) + Math.abs(dy2) === 1 &&
          dx1 * dx2 + dy1 * dy2 === 0 &&
          !prev.isBridge &&
          !curr.isBridge &&
          !next.isBridge
        ) {
          const pid = this.idx(prev.x, prev.y);
          const cid = this.idx(curr.x, curr.y);
          const nid = this.idx(next.x, next.y);
          const c1Id = this.idx(prev.x, next.y);
          const c2Id = this.idx(next.x, prev.y);
          const isBypassRing =
            (this.buildingMask[pid] === 4 ||
              this.buildingMask[cid] === 4 ||
              this.buildingMask[nid] === 4) &&
            (this.buildingMask[pid] === 0 || this.buildingMask[pid] === 4) &&
            (this.buildingMask[cid] === 0 || this.buildingMask[cid] === 4) &&
            (this.buildingMask[nid] === 0 || this.buildingMask[nid] === 4) &&
            (this.buildingMask[c1Id] === 0 || this.buildingMask[c1Id] === 4) &&
            (this.buildingMask[c2Id] === 0 || this.buildingMask[c2Id] === 4);

          if (
            this.roadGrid[cid] === 0 &&
            this.waterMask[c1Id] === 0 &&
            this.waterMask[c2Id] === 0 &&
            (isBypassRing ||
              (this.zoneColorIdx[pid] < 0 &&
                this.zoneColorIdx[cid] < 0 &&
                this.zoneColorIdx[nid] < 0 &&
                this.zoneColorIdx[c1Id] < 0 &&
                this.zoneColorIdx[c2Id] < 0 &&
                this.buildingMask[pid] === 0 &&
                this.buildingMask[cid] === 0 &&
                this.buildingMask[nid] === 0 &&
                this.buildingMask[c1Id] === 0 &&
                this.buildingMask[c2Id] === 0 &&
                !isNearAnyTownEnvelope(prev.x, prev.y) &&
                !isNearAnyTownEnvelope(curr.x, curr.y) &&
                !isNearAnyTownEnvelope(next.x, next.y)))
          ) {
            continue;
          }
        }
        out.push(curr);
      }
      out.push(pts[pts.length - 1]);
      return out;
    };

    const pts = simplifyRuralStaircase(path);
    if (pts.length < 2) return;

    // If an arterial starts or terminates on an existing town street (`roadGrid === 1`),
    // anchor the connecting street path into the town's arterial core (`roadGrid = 2`) BEFORE
    // overwriting `pts` on `roadGrid` so `pruneEmptyOuterStreets()` never severs the street!
    if (roadType === "arterial") {
      this.anchorStreetToArterialCore(
        Math.round(pts[0].x),
        Math.round(pts[0].y),
      );
      this.anchorStreetToArterialCore(
        Math.round(pts[pts.length - 1].x),
        Math.round(pts[pts.length - 1].y),
      );
    }

    // Emit contiguous spans of new edges (`!this.hasRoadEdge(p0, p1)`) so every new step
    // between two existing roads is preserved while shared trunk edges are never double-drawn!
    let seg = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const x0 = Math.round(p0.x),
        y0 = Math.round(p0.y);
      const x1 = Math.round(p1.x),
        y1 = Math.round(p1.y);
      if (!this.hasRoadEdge(x0, y0, x1, y1)) {
        if (seg.length === 0) seg.push({ ...p0, x: x0, y: y0 });
        seg.push({ ...p1, x: x1, y: y1 });
        this.addRoadEdge(x0, y0, x1, y1);
      } else {
        if (seg.length >= 2) {
          this.roads.push({ points: seg, type: roadType, ...extraProps });
        }
        seg = [];
      }
    }
    if (seg.length >= 2) {
      this.roads.push({ points: seg, type: roadType, ...extraProps });
    }

    // Populate `this.roadGrid` exclusively from the simplified vertices (`pts`) so zero ghost road tiles exist!
    let inBridge = false;
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      const id = this.idx(Math.round(pt.x), Math.round(pt.y));
      if (pt.isBridge) {
        if (!inBridge && this.roadGrid[id] !== 3) {
          this.bridgeCount++;
          inBridge = true;
        }
        this.roadGrid[id] = 3;
      } else {
        inBridge = false;
        if (this.roadGrid[id] === 0) {
          this.roadGrid[id] = roadType === "street" ? 1 : 2;
        } else if (this.roadGrid[id] === 1 && roadType === "arterial") {
          this.roadGrid[id] = 2;
        }
      }
    }
  }

  /*************************************************************************
   * STAGE 6A & 7: ORGANIC MULTI-BOROUGH GRIDS, VARIED BLOCK SIZES & RCI PACKER
   *************************************************************************/
  carveTownStreetGrids(filterFn = null) {
    const densityMult = (this.config.buildingDensity || 250) / 100;

    for (const town of this.towns) {
      if (filterFn && !filterFn(town)) continue;
      const R = Math.round(
        town.urbanRadius * (0.78 + 0.18 * Math.sqrt(densityMult)),
      );
      const townElev = this.elevationField[this.idx(town.x, town.y)];
      town.effectiveR = R;
      town.commercialCount = 0;
      town.industrialCount = 0;

      // 6A-1. Build Organic Multi-Nuclei Boroughs at their natural topographic optima (NOT locked to a global modulo grid!)
      //       Each borough has its own independent phase and variable block cadence so transitions form natural T-junctions.
      const boroughs = [{ x: town.x, y: town.y, r: R, isMainCBD: true }];
      const numExtraBoroughs = town.tier === 1 ? 3 : town.tier === 2 ? 2 : 0;

      for (let b = 0; b < numExtraBoroughs; b++) {
        let bestBx = null,
          bestBy = null,
          bestScore = -1;
        for (let a = 0; a < 16; a++) {
          const ang =
            (a / 16) * Math.PI * 2 + b * 0.45 + this.rng.range(-0.12, 0.12);
          const dist = Math.round(R * this.rng.range(0.54, 0.88));
          const cx = town.x + Math.round(Math.cos(ang) * dist);
          const cy = town.y + Math.round(Math.sin(ang) * dist);
          if (!this.inBounds(cx, cy, 8)) continue;
          const cid = this.idx(cx, cy);
          if (
            this.waterMask[cid] > 0 ||
            this.buildingMask[cid] === 3 ||
            this.distToWater[cid] < 2.0
          )
            continue;
          if (
            this.slopeField[cid] > 0.38 ||
            Math.abs(this.elevationField[cid] - townElev) > 0.14
          )
            continue;
          if (
            boroughs.some((eb) => Math.hypot(eb.x - cx, eb.y - cy) < R * 0.44)
          )
            continue;

          let crossesRiver = false;
          for (let s = 1; s < 8; s++) {
            const mx = Math.round(town.x + (cx - town.x) * (s / 8));
            const my = Math.round(town.y + (cy - town.y) * (s / 8));
            if (
              this.inBounds(mx, my, 1) &&
              this.waterMask[this.idx(mx, my)] === 1
            ) {
              crossesRiver = true;
              break;
            }
          }
          const score =
            this.urbanSuitability[cid] +
            (crossesRiver ? 0.38 : 0) +
            this.rng.range(-0.05, 0.05);
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
              stepChoice = this.rng.next() < 0.5 ? 3 : 4;
            } else {
              const r = this.rng.next();
              stepChoice = r < 0.32 ? 3 : r < 0.78 ? 4 : 5;
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
            const isIH = this.config.archetype === "island-hopper";
            const elevPenalty =
              Math.max(0, this.elevationField[id] - brElev) *
                (isIH ? 14.0 : 30.0) +
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
        this.carveStreetFromCenter(
          br.x,
          br.y,
          1,
          0,
          mainNegX,
          mainPosX,
          br.isMainCBD,
        );
        this.carveStreetFromCenter(
          br.x,
          br.y,
          0,
          1,
          mainNegY,
          mainPosY,
          br.isMainCBD,
        );

        const yOffsets = buildVariableOffsets(bR, br.isMainCBD);
        const xOffsets = buildVariableOffsets(bR, br.isMainCBD);

        for (let pass = 0; pass < 2; pass++) {
          for (const dyOff of yOffsets) {
            if (pass === 1 && this.rng.next() < 0.25) continue;
            const chord = Math.sqrt(Math.max(0, bR * bR - dyOff * dyOff));
            // Asymmetric street spans & occasional one-sided T-intersections for organic neighborhood structure!
            const oneSided = Math.abs(dyOff) > 4 && this.rng.next() < 0.28;
            const negSpan =
              oneSided && this.rng.next() < 0.5
                ? 0
                : Math.floor(chord * this.rng.range(0.48, 0.96));
            const posSpan =
              oneSided && negSpan > 0 && this.rng.next() < 0.5
                ? 0
                : Math.floor(chord * this.rng.range(0.48, 0.96));
            const yRow = br.y + dyOff;
            for (const probeOff of [0, ...xOffsets]) {
              const probeX = br.x + probeOff;
              if (
                Math.abs(probeOff) <= Math.max(negSpan, posSpan) &&
                this.inBounds(probeX, yRow, 4) &&
                this.roadGrid[this.idx(probeX, yRow)] > 0
              ) {
                this.carveStreetFromCenter(
                  probeX,
                  yRow,
                  1,
                  0,
                  negSpan,
                  posSpan,
                  false,
                );
                break;
              }
            }
          }

          for (const dxOff of xOffsets) {
            if (pass === 1 && this.rng.next() < 0.25) continue;
            const chord = Math.sqrt(Math.max(0, bR * bR - dxOff * dxOff));
            const oneSided = Math.abs(dxOff) > 4 && this.rng.next() < 0.28;
            const negSpan =
              oneSided && this.rng.next() < 0.5
                ? 0
                : Math.floor(chord * this.rng.range(0.48, 0.96));
            const posSpan =
              oneSided && negSpan > 0 && this.rng.next() < 0.5
                ? 0
                : Math.floor(chord * this.rng.range(0.48, 0.96));
            const xCol = br.x + dxOff;
            for (const probeOff of [0, ...yOffsets]) {
              const probeY = br.y + probeOff;
              if (
                Math.abs(probeOff) <= Math.max(negSpan, posSpan) &&
                this.inBounds(xCol, probeY, 4) &&
                this.roadGrid[this.idx(xCol, probeY)] > 0
              ) {
                this.carveStreetFromCenter(
                  xCol,
                  probeY,
                  0,
                  1,
                  negSpan,
                  posSpan,
                  false,
                );
                break;
              }
            }
          }
        }
      }

      // 6A-3. Connect Secondary Boroughs to the Main CBD
      for (let b = 1; b < boroughs.length; b++) {
        const br = boroughs[b];
        const linkPath = this.findRoadPathAStar(
          br.x,
          br.y,
          town.x,
          town.y,
          true,
        );
        if (linkPath) this.commitRoadPath(linkPath, "arterial");
      }
    }
  }

  growUrbanFabric() {
    const densityMult = (this.config.buildingDensity || 250) / 100;

    for (const town of this.towns) {
      const R =
        town.effectiveR ||
        Math.round(town.urbanRadius * (0.78 + 0.18 * Math.sqrt(densityMult)));

      // 7A. Place Differentiated Commercial (CBD & Arterial) and Industrial (Peripheral / Freight) Multi-Size Sinks
      this.placeTownCommercialAndIndustrial(town, R, densityMult);

      // 7B. Place Residential Houses with Organic Sparseness, Yard Breathing Room & Dimensional Variation
      const baseHouses =
        town.tier === 1 ? 66 : town.tier === 2 ? 34 : town.tier === 3 ? 16 : 7;
      const targetHouses = Math.max(4, Math.round(baseHouses * densityMult));
      this.tryPlaceNeighborhoodHouses(town, targetHouses, R);
    }

    // 7B-2. Seed Out-of-Town Geographic Resource Niches (`MINE` Quarries, `TIMBER` Forestry Camps, `FARM` Agribusiness)
    //       with dedicated rural haul roads BEFORE outer street pruning so contacted streets remain anchored!
    this.seedOutOfTownResourceNiches();

    // 7C. Trim far-flung empty street tails while preserving natural neighborhood block loops
    this.pruneEmptyOuterStreets();
  }

  /**
   * STAGE 7B-2: OUT-OF-TOWN GEOGRAPHIC RESOURCE NICHES (OpenTTD / Transport Fever 2)
   * Places primary `RAW` extraction facilities (`MINE`, `TIMBER`, `FARM`) out in their authentic
   * physical terrain niches outside urban zones and connects each with a short rural haul road
   * to the regional trunk network so freight trucks haul raw materials into town `MFG` factories.
   */
  seedOutOfTownResourceNiches() {
    const isIslandHopper = this.config.archetype === "island-hopper";
    const targetSites = Math.min(
      10,
      Math.max(5, Math.round(this.towns.length * 0.36)),
    );

    // Collect rural arterial/street road tiles (`roadGrid >= 1`) as haul-road targets
    const roadTargets = [];
    for (let y = 10; y < this.H - 10; y += 2) {
      for (let x = 10; x < this.W - 10; x += 2) {
        const id = this.idx(x, y);
        if (
          (this.roadGrid[id] === 1 || this.roadGrid[id] === 2) &&
          this.waterMask[id] === 0
        ) {
          roadTargets.push({ x, y });
        }
      }
    }
    if (roadTargets.length === 0) return;

    const candidates = [];
    for (let gy = 14; gy < this.H - 16; gy += 3) {
      for (let gx = 14; gx < this.W - 16; gx += 3) {
        // Check a 2×2 building pad + 2-tile clearance margin for dry land, zero roads/buildings, and outside urban blush
        let padOk = true;
        for (let dy = -2; dy <= 3 && padOk; dy++) {
          for (let dx = -2; dx <= 3; dx++) {
            const px = gx + dx,
              py = gy + dy;
            if (!this.inBounds(px, py, 4)) {
              padOk = false;
              break;
            }
            const pid = this.idx(px, py);
            if (
              this.waterMask[pid] > 0 ||
              this.buildingMask[pid] > 0 ||
              this.roadGrid[pid] > 0 ||
              this.zoneColorIdx[pid] >= 0 ||
              this.distToWater[pid] < 3.2
            ) {
              padOk = false;
              break;
            }
          }
        }
        if (!padOk) continue;

        const cx = gx + 0.5;
        const cy = gy + 0.5;
        if (this.isPointInAirportPad(cx, cy, 7.0)) continue;

        // Require clear rural separation outside town urban radii (`>= urbanRadius + 4.5`)
        let nearestTown = null;
        let minTownDist = Infinity;
        let tooCloseToTown = false;
        for (const t of this.towns) {
          const d = Math.hypot(cx - t.x, cy - t.y);
          if (d < (t.effectiveR || t.urbanRadius) + 4.5) {
            tooCloseToTown = true;
            break;
          }
          if (d < minTownDist) {
            minTownDist = d;
            nearestTown = t;
          }
        }
        if (tooCloseToTown || !nearestTown || minTownDist > 42) continue;

        // Find nearest paved road tile within 5..18 tiles for a crisp rural haul spur
        let nearestRoadPt = null;
        let minRoadDist = Infinity;
        for (let k = 0; k < roadTargets.length; k++) {
          const rp = roadTargets[k];
          const d = Math.hypot(cx - rp.x, cy - rp.y);
          if (d < minRoadDist) {
            minRoadDist = d;
            nearestRoadPt = rp;
          }
        }
        if (!nearestRoadPt || minRoadDist < 4.5 || minRoadDist > 17.5) continue;

        const id = this.idx(gx, gy);
        const hAbove = Math.max(0, this.elevationField[id] - this.seaLevel);
        const slope = this.slopeField[id];
        const fert = this.fertilityField[id];
        const dW = this.distToWater[id];

        // Evaluate fitness for the 3 geographic resource niches:
        // 1. `MINE` (Foothill Quarry & Mine): elevated ridge toes & canyon mouths (`hAbove >= 0.115`)
        // 2. `TIMBER` (Upland Forestry Camp): moist wooded hills (`hAbove >= 0.085`, high `fertilityField`)
        // 3. `FARM` (Alluvial Agribusiness): flat fertile valley floors (`hAbove <= 0.085`, low `slope`)
        let resourceType = null;
        let nicheScore = -1;

        if (
          hAbove >= 0.115 &&
          hAbove <= 0.28 &&
          slope >= 0.06 &&
          slope <= 0.36
        ) {
          resourceType = "MINE";
          nicheScore =
            1.0 + (hAbove - 0.115) * 3.5 + slope * 1.4 - minRoadDist * 0.03;
        } else if (
          hAbove >= 0.08 &&
          hAbove <= 0.22 &&
          fert >= 0.38 &&
          slope <= 0.28
        ) {
          resourceType = "TIMBER";
          nicheScore = 0.95 + fert * 0.85 + hAbove * 1.8 - minRoadDist * 0.03;
        } else if (
          hAbove <= 0.085 &&
          slope <= 0.1 &&
          fert >= 0.4 &&
          dW >= 3.5 &&
          dW <= 16.0
        ) {
          resourceType = "FARM";
          nicheScore =
            0.92 + fert * 0.95 + (0.1 - slope) * 2.5 - minRoadDist * 0.03;
        }
        if (!resourceType) continue;

        candidates.push({
          gx,
          gy,
          cx,
          cy,
          resourceType,
          nicheScore: nicheScore + this.rng.range(-0.06, 0.06),
          nearestTown,
          nearestRoadPt,
        });
      }
    }

    candidates.sort((a, b) => b.nicheScore - a.nicheScore);

    const desiredMix = [
      "MINE",
      "TIMBER",
      "FARM",
      "MINE",
      "TIMBER",
      "FARM",
      "MINE",
      "FARM",
      "TIMBER",
      "MINE",
    ];
    const placedSites = [];

    for (let slotIdx = 0; slotIdx < targetSites; slotIdx++) {
      const preferredType = desiredMix[slotIdx % desiredMix.length];
      let chosenCand = null;
      let chosenHaulPath = null;
      let chosenDriveway = null;

      for (const passPrefer of [true, false]) {
        for (const cand of candidates) {
          if (passPrefer && cand.resourceType !== preferredType) continue;
          if (
            placedSites.some(
              (p) =>
                Math.hypot(p.cx - cand.cx, p.cy - cand.cy) <
                (isIslandHopper ? 18 : 25),
            )
          ) {
            continue;
          }
          // Re-verify 2×2 pad is still clear of any haul road committed in an earlier iteration
          let stillClear = true;
          for (let dy = -1; dy <= 2 && stillClear; dy++) {
            for (let dx = -1; dx <= 2; dx++) {
              const lid = this.idx(cand.gx + dx, cand.gy + dy);
              if (this.buildingMask[lid] > 0 || this.roadGrid[lid] > 0) {
                stillClear = false;
                break;
              }
            }
          }
          if (!stillClear) continue;

          // Pick the cardinal perimeter driveway tile facing `nearestRoadPt`
          const perimeterCandidates = [
            { lotX: cand.gx, lotY: cand.gy, rx: cand.gx - 1, ry: cand.gy },
            { lotX: cand.gx + 1, lotY: cand.gy, rx: cand.gx + 2, ry: cand.gy },
            { lotX: cand.gx, lotY: cand.gy, rx: cand.gx, ry: cand.gy - 1 },
            { lotX: cand.gx, lotY: cand.gy + 1, rx: cand.gx, ry: cand.gy + 2 },
          ].sort(
            (a, b) =>
              Math.hypot(
                a.rx - cand.nearestRoadPt.x,
                a.ry - cand.nearestRoadPt.y,
              ) -
              Math.hypot(
                b.rx - cand.nearestRoadPt.x,
                b.ry - cand.nearestRoadPt.y,
              ),
          );

          const drv = perimeterCandidates[0];
          const blockLotFn = (nx, ny) =>
            nx >= cand.gx &&
            nx <= cand.gx + 1 &&
            ny >= cand.gy &&
            ny <= cand.gy + 1;
          const haulPath = this.findRoadPathAStar(
            drv.rx,
            drv.ry,
            cand.nearestRoadPt.x,
            cand.nearestRoadPt.y,
            false,
            blockLotFn,
            true,
          );
          if (haulPath && haulPath.length >= 2 && haulPath.length <= 24) {
            chosenCand = cand;
            chosenHaulPath = haulPath;
            chosenDriveway = drv;
            break;
          }
        }
        if (chosenCand) break;
      }

      if (!chosenCand) continue;

      this.commitRoadPath(chosenHaulPath, "arterial");
      const contactPt = chosenHaulPath[chosenHaulPath.length - 1];
      this.anchorStreetToArterialCore(
        Math.round(contactPt.x),
        Math.round(contactPt.y),
      );

      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          this.buildingMask[this.idx(chosenCand.gx + dx, chosenCand.gy + dy)] =
            2;
        }
      }

      // For `FARM` sites, build a sprawling, contiguous agricultural estate combining:
      // (#3) Smooth contour- & riverbank-hugging outer perimeter loops (`estateLoops`),
      // (#4) Recursive X/Y Binary Space Partitioning (`bspParcels`) with T-junction seams in both axes,
      // (#5) Micro-geographic crop zoning (riparian pasture -> flat alluvial wheat/ochre/loam -> foothill orchards),
      // (#6) A broken-grid farm road network (`tractorTracks`) serving every field & stopping fractionally in terminal fields,
      //      plus an upland windbreak poplar row (`windbreakPts`).
      let bspParcels = [];
      let estateLoops = [];
      let tractorTracks = [];
      let windbreakPts = [];
      if (chosenCand.resourceType === "FARM") {
        const estate = this.buildFarmEstate(
          chosenCand.gx,
          chosenCand.gy,
          chosenCand.cx,
          chosenCand.cy,
          slotIdx,
        );
        bspParcels = estate.bspParcels;
        estateLoops = estate.estateLoops;
        tractorTracks = estate.tractorTracks;
        windbreakPts = estate.windbreakPts;
      }

      const hostTown = chosenCand.nearestTown;
      const colorIdx = (hostTown.colorIdx + 1) % PALETTE.districtColors.length;
      this.destinations.push({
        id: this.destinations.length,
        x: chosenCand.cx,
        y: chosenCand.cy,
        gx: chosenCand.gx,
        gy: chosenCand.gy,
        wTiles: 2,
        hTiles: 2,
        lotX: chosenDriveway.lotX,
        lotY: chosenDriveway.lotY,
        roadX: chosenDriveway.rx,
        roadY: chosenDriveway.ry,
        townId: hostTown.id,
        zoneType: "industrial",
        subType: "RAW",
        resourceType: chosenCand.resourceType, // 'MINE' | 'TIMBER' | 'FARM'
        bspParcels,
        estateLoops,
        tractorTracks,
        windbreakPts,
        isRuralNiche: true,
        isCircular: false,
        hasUrgentPin: false,
        pinsCount: 4,
        colorIdx,
        palette: PALETTE.districtColors[colorIdx],
      });
      hostTown.destinationsCount++;
      hostTown.industrialCount++;
      placedSites.push(chosenCand);
    }
  }

  /**
   * Builds a sprawling, contiguous agricultural estate around a 2×2 farmstead `(fgx, fgy)` combining:
   * - (#4) Recursive X/Y Binary Space Partitioning (`bspParcels`) with natural T-junction seams,
   * - (#3) Contour- & riverbank-hugging outer perimeter loops (`estateLoops`),
   * - (#5) Micro-geographic crop zoning (riparian pasture -> flat alluvial wheat/ochre/loam -> foothill orchards),
   * - (#6) An internal unpaved tractor spine lane (`tractorSpine`) & upland windbreak poplar row (`windbreakPts`).
   */
  buildFarmEstate(fgx, fgy, fcx, fcy, slotIdx) {
    // Physical geography check (hillside contour `dh = 0.13` & riverbanks):
    // The ONLY per-tile clip allowed inside a kept BSP parcel, so outer edges curve ONLY along real contours & rivers!
    const isPhysicallyArable = (tx, ty) => {
      if (!this.inBounds(tx, ty, 3)) return false;
      if (tx >= fgx && tx <= fgx + 1 && ty >= fgy && ty <= fgy + 1) return true;
      const tid = this.idx(tx, ty);
      if (
        this.waterMask[tid] > 0 ||
        this.distToWater[tid] < 2.0 ||
        this.elevationField[tid] >= this.seaLevel + 0.13 ||
        this.slopeField[tid] > 0.16
      ) {
        return false;
      }
      return true;
    };

    // Whole-box urban & road clearance check: any BSP leaf box touching an urban building/house, pastel town zone,
    // or paved road (`roadGrid > 0`, outside the 2×2 farmstead and its immediate driveway tile) is trimmed
    // orthogonally (0°/90°) so farm parcels never cross over paved haul roads or overlap town halos!
    const boxHitsUrbanBuilding = (x0, y0, x1, y1) => {
      for (let ty = y0 - 1; ty <= y1; ty++) {
        for (let tx = x0 - 1; tx <= x1; tx++) {
          if (!this.inBounds(tx, ty, 1)) continue;
          if (tx >= fgx && tx <= fgx + 1 && ty >= fgy && ty <= fgy + 1)
            continue;
          const tid = this.idx(tx, ty);
          const bm = this.buildingMask[tid];
          if (bm >= 1 && bm <= 4) return true;
          if (tx >= x0 && tx < x1 && ty >= y0 && ty < y1) {
            if (this.zoneColorIdx[tid] >= 0) return true;
            if (this.roadGrid[tid] > 0 && Math.hypot(tx - fcx, ty - fcy) > 1.8)
              return true;
          }
        }
      }
      return false;
    };

    // Trim a BSP leaf box orthogonally (0°/90°) from whichever outer edge overlaps an urban building
    // while keeping edges that actually touch the 2×2 farmstead `[fgx, fgx+2) × [fgy, fgy+2)` locked!
    const fitBoxClearOfUrban = (x0, y0, x1, y1) => {
      let rx0 = x0,
        ry0 = y0,
        rx1 = x1,
        ry1 = y1;
      for (let iter = 0; iter < 14; iter++) {
        if (rx1 - rx0 < 3 || ry1 - ry0 < 3) return null;
        if (!boxHitsUrbanBuilding(rx0, ry0, rx1, ry1)) {
          return { x0: rx0, y0: ry0, x1: rx1, y1: ry1 };
        }
        let badL = 0,
          badR = 0,
          badT = 0,
          badB = 0;
        for (let ty = ry0 - 1; ty <= ry1; ty++) {
          if (boxHitsUrbanBuilding(rx0, ty, rx0 + 1, ty + 1)) badL++;
          if (boxHitsUrbanBuilding(rx1 - 1, ty, rx1, ty + 1)) badR++;
        }
        for (let tx = rx0 - 1; tx <= rx1; tx++) {
          if (boxHitsUrbanBuilding(tx, ry0, tx + 1, ry0 + 1)) badT++;
          if (boxHitsUrbanBuilding(tx, ry1 - 1, tx + 1, ry1)) badB++;
        }
        const yOverlapsFarm = Math.min(ry1, fgy + 2) - Math.max(ry0, fgy) >= 1;
        const xOverlapsFarm = Math.min(rx1, fgx + 2) - Math.max(rx0, fgx) >= 1;
        if (yOverlapsFarm && rx1 === fgx) badR = 0;
        if (yOverlapsFarm && rx0 === fgx + 2) badL = 0;
        if (xOverlapsFarm && ry1 === fgy) badB = 0;
        if (xOverlapsFarm && ry0 === fgy + 2) badT = 0;

        const maxBad = Math.max(badL, badR, badT, badB);
        if (maxBad === 0) return null;
        if (badR === maxBad) rx1--;
        else if (badB === maxBad) ry1--;
        else if (badT === maxBad) ry0++;
        else rx0++;
      }
      return rx1 - rx0 >= 3 &&
        ry1 - ry0 >= 3 &&
        !boxHitsUrbanBuilding(rx0, ry0, rx1, ry1)
        ? { x0: rx0, y0: ry0, x1: rx1, y1: ry1 }
        : null;
    };

    // 1. Recursive X/Y Binary Space Partitioning (BSP) across the alluvial basin around `(fgx, fgy)`
    const isInsideAnyTownHalo = (px, py, mult = 0.65) =>
      this.towns.some(
        (t) =>
          Math.hypot(px - t.x, py - t.y) <
          (t.effectiveR || t.urbanRadius || 12) * mult,
      );

    let wValid = 0,
      eValid = 0,
      nValid = 0,
      sValid = 0;
    for (let dy = -16; dy <= 17; dy++) {
      for (let dx = -18; dx <= 19; dx++) {
        const tx = fgx + dx,
          ty = fgy + dy;
        if (!isPhysicallyArable(tx, ty)) continue;
        if (isInsideAnyTownHalo(tx, ty, 0.72)) continue;
        if (dx < 0) wValid++;
        else eValid++;
        if (dy < 0) nValid++;
        else sValid++;
      }
    }

    const rootX0 = fgx - (wValid > eValid * 1.2 ? 23 : 15);
    const rootX1 = fgx + (eValid > wValid * 1.2 ? 25 : 17);
    const rootY0 = fgy - (nValid > sValid * 1.2 ? 19 : 14);
    const rootY1 = fgy + (sValid > nValid * 1.2 ? 21 : 16);
    const bspLeaves = [];

    const splitBox = (x0, y0, x1, y1, depth, prefAxis) => {
      const w = x1 - x0;
      const h = y1 - y0;
      if (depth >= 6 || (w <= 8 && h <= 8)) {
        bspLeaves.push({ x0, y0, x1, y1 });
        return;
      }
      let axis = prefAxis;
      if (depth >= 2 || w >= h * 1.35 || h >= w * 1.35) {
        axis = w >= h ? "x" : "y";
      } else if (!axis) {
        axis = depth % 2 === 0 ? "x" : "y";
      }
      if (axis === "x" && w < 8) axis = "y";
      if (axis === "y" && h < 8) axis = "x";

      if (axis === "x" && w >= 8) {
        let sx;
        if (fgx >= x0 + 4 && fgx <= x1 - 4) sx = fgx;
        else if (fgx + 2 >= x0 + 4 && fgx + 2 <= x1 - 4) sx = fgx + 2;
        else sx = x0 + Math.floor(w * 0.35 + this.rng.next() * (w * 0.3));
        sx = Math.max(x0 + 4, Math.min(x1 - 4, sx));
        splitBox(x0, y0, sx, y1, depth + 1, "y");
        splitBox(sx, y0, x1, y1, depth + 1, "y");
      } else if (h >= 8) {
        let sy;
        if (fgy >= y0 + 4 && fgy <= y1 - 4) sy = fgy;
        else if (fgy + 2 >= y0 + 4 && fgy + 2 <= y1 - 4) sy = fgy + 2;
        else sy = y0 + Math.floor(h * 0.35 + this.rng.next() * (h * 0.3));
        sy = Math.max(y0 + 4, Math.min(y1 - 4, sy));
        splitBox(x0, y0, x1, sy, depth + 1, "x");
        splitBox(x0, sy, x1, y1, depth + 1, "x");
      } else {
        bspLeaves.push({ x0, y0, x1, y1 });
      }
    };

    // Root split (`depth = 0`) defines the primary Tractor Spine seam abutting the 2×2 farmstead
    let spineAxis =
      Math.abs(wValid - eValid) <= Math.abs(nValid - sValid) ? "x" : "y";
    let spineCoord =
      spineAxis === "x"
        ? wValid >= eValid
          ? fgx
          : fgx + 2
        : nValid >= sValid
          ? fgy
          : fgy + 2;
    if (spineAxis === "x") {
      splitBox(rootX0, rootY0, spineCoord, rootY1, 1, "y");
      splitBox(spineCoord, rootY0, rootX1, rootY1, 1, "y");
    } else {
      splitBox(rootX0, rootY0, rootX1, spineCoord, 1, "x");
      splitBox(rootX0, spineCoord, rootX1, rootY1, 1, "x");
    }

    // 2. Collect valid terrain tiles per BSP leaf box:
    // - Urban buildings & town cores reject whole BSP boxes (`boxHitsUrbanBuilding`) so town-facing edges stay 100% straight!
    // - Physical contours (`elevationField >= seaLevel + 0.130`) and riverbanks (`distToWater < 2.0`) clip individual tiles
    //   so contour-facing and river-facing outer edges hug the terrain contour curve!
    const rawParcels = [];
    for (let i = 0; i < bspLeaves.length; i++) {
      const b = bspLeaves[i];
      const bcx = (b.x0 + b.x1) * 0.5;
      const bcy = (b.y0 + b.y1) * 0.5;
      const boxWarp =
        this.noise.fbm(bcx * 0.1 + slotIdx * 3.1, bcy * 0.1 + 2.7, 2) * 3.5;
      // Allow wider reach toward the open basin side (away from town) so fields reach & hug the hillside contour line
      const openSideBonus =
        (wValid > eValid * 1.2 && bcx < fcx) ||
        (eValid > wValid * 1.2 && bcx > fcx)
          ? 8.2
          : 0;
      if (Math.hypot(bcx - fcx, bcy - fcy) + boxWarp > 14.5 + openSideBonus)
        continue;

      const touchesFarmstead =
        b.x0 <= fgx + 2 && b.x1 >= fgx && b.y0 <= fgy + 2 && b.y1 >= fgy;
      if (!touchesFarmstead && isInsideAnyTownHalo(bcx, bcy, 0.68)) {
        continue;
      }
      const cleanBox = fitBoxClearOfUrban(b.x0, b.y0, b.x1, b.y1);
      if (!cleanBox) continue;

      const validTiles = [];
      for (let ty = cleanBox.y0; ty < cleanBox.y1; ty++) {
        for (let tx = cleanBox.x0; tx < cleanBox.x1; tx++) {
          if (tx >= fgx && tx <= fgx + 1 && ty >= fgy && ty <= fgy + 1)
            continue;
          if (isPhysicallyArable(tx, ty)) {
            validTiles.push([tx, ty]);
          }
        }
      }
      if (validTiles.length >= 8) {
        rawParcels.push({ ...cleanBox, tiles: validTiles });
      }
    }

    return this.finalizeFarmEstateFromParcels(
      rawParcels,
      fgx,
      fgy,
      slotIdx,
      spineAxis,
      spineCoord,
    );
  }

  /**
   * Given raw BSP parcels around `(fgx, fgy)`, filters to the 4-connected component attached to the
   * 2×2 farmstead, assigns micro-geographic crops (`#5`), traces smooth contour-hugging outer boundary
   * loops (`#3`), and extracts the unpaved tractor spine (`#6a`) & foothill windbreak poplars (`#6b`).
   */
  finalizeFarmEstateFromParcels(
    rawParcels,
    fgx,
    fgy,
    slotIdx,
    spineAxis,
    spineCoord,
  ) {
    const padKeys = [
      fgx * 10000 + fgy,
      (fgx + 1) * 10000 + fgy,
      fgx * 10000 + (fgy + 1),
      (fgx + 1) * 10000 + (fgy + 1),
    ];
    const allCandSet = new Set(padKeys);
    for (const p of rawParcels) {
      for (const [tx, ty] of p.tiles) {
        allCandSet.add(tx * 10000 + ty);
      }
    }

    // 4-connected BFS from the 2×2 farmstead pad
    const connectedSet = new Set(padKeys);
    const queue = [
      [fgx, fgy],
      [fgx + 1, fgy],
      [fgx, fgy + 1],
      [fgx + 1, fgy + 1],
    ];
    while (queue.length > 0) {
      const [cx, cy] = queue.shift();
      for (const [nx, ny] of [
        [cx - 1, cy],
        [cx + 1, cy],
        [cx, cy - 1],
        [cx, cy + 1],
      ]) {
        const k = nx * 10000 + ny;
        if (allCandSet.has(k) && !connectedSet.has(k)) {
          connectedSet.add(k);
          queue.push([nx, ny]);
        }
      }
    }

    const bspParcels = [];
    for (const p of rawParcels) {
      const tiles = p.tiles.filter(([tx, ty]) =>
        connectedSet.has(tx * 10000 + ty),
      );
      if (tiles.length < 10) continue;
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      let sumElev = 0,
        sumSlope = 0,
        sumWater = 0;
      for (const [tx, ty] of tiles) {
        if (tx < minX) minX = tx;
        if (tx + 1 > maxX) maxX = tx + 1;
        if (ty < minY) minY = ty;
        if (ty + 1 > maxY) maxY = ty + 1;
        const tid = this.idx(tx, ty);
        sumElev += Math.max(0, this.elevationField[tid] - this.seaLevel);
        sumSlope += this.slopeField[tid];
        sumWater += this.distToWater[tid];
      }
      // Reject skinny `< 4` tile contour slivers so outer parcels have substantial width & height
      if (maxX - minX < 4 || maxY - minY < 4) continue;
      const n = tiles.length;
      // Preserve the full BSP rectangle `[p.x0, p.x1) × [p.y0, p.y1)` so internal seams stay 100% flush
      // and the renderer's octilinear Marching-Squares `arableLandPath` clips contour/river edges pixel-for-pixel!
      bspParcels.push({
        x0: p.x0,
        x1: p.x1,
        y0: p.y0,
        y1: p.y1,
        meanElev: sumElev / n,
        meanSlope: sumSlope / n,
        meanWater: sumWater / n,
        crop: "wheat",
        furrowDir: p.x1 - p.x0 >= p.y1 - p.y0 ? 0 : 1,
        spineAxis,
        spineCoord,
        slotIdx,
        tiles,
      });
    }

    // Require parcel-level shared edge overlap (`>= 3` tiles) from the farmstead so no parcel hangs by a narrow corner
    if (bspParcels.length > 1) {
      const shareSubstantialEdge = (a, b) => {
        const xOv = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const yOv = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        return (
          (xOv >= 3 && (a.y0 === b.y1 || a.y1 === b.y0)) ||
          (yOv >= 3 && (a.x0 === b.x1 || a.x1 === b.x0)) ||
          (xOv > 0 && yOv > 0)
        );
      };
      const rootIndices = [];
      for (let i = 0; i < bspParcels.length; i++) {
        const p = bspParcels[i];
        if (p.x0 <= fgx + 2 && p.x1 >= fgx && p.y0 <= fgy + 2 && p.y1 >= fgy) {
          rootIndices.push(i);
        }
      }
      if (rootIndices.length > 0) {
        const pVisited = new Set(rootIndices);
        const pQueue = [...rootIndices];
        while (pQueue.length > 0) {
          const curr = pQueue.shift();
          for (let i = 0; i < bspParcels.length; i++) {
            if (
              !pVisited.has(i) &&
              shareSubstantialEdge(bspParcels[curr], bspParcels[i])
            ) {
              pVisited.add(i);
              pQueue.push(i);
            }
          }
        }
        bspParcels.splice(
          0,
          bspParcels.length,
          ...bspParcels.filter((_, idx) => pVisited.has(idx)),
        );
      }
    }

    // Rebuild exact estate tile set from surviving parcels + 2×2 farmstead pad
    const estateTileSet = new Set(padKeys);
    for (const p of bspParcels) {
      for (const [tx, ty] of p.tiles) {
        estateTileSet.add(tx * 10000 + ty);
        this.buildingMask[this.idx(tx, ty)] = 5;
      }
    }

    // (#5) Micro-Geographic Crop Zoning + Neighbor Adjacency Contrast
    for (let i = 0; i < bspParcels.length; i++) {
      const p = bspParcels[i];
      let prefs;
      if (p.meanElev >= 0.08 || p.meanSlope >= 0.058) {
        // Upper Foothill Toe-Slope / Treeline Fringe -> Orchards & Loam
        prefs = ["orchard", "loam", "ochre", "wheat", "pasture"];
      } else if (p.meanWater <= 7.5 || p.meanElev <= 0.036) {
        // Riparian / Moist Alluvial Bottomland -> Pasture & Loam
        prefs = ["pasture", "loam", "wheat", "ochre", "orchard"];
      } else {
        // Flat Alluvial Mid-Bench -> Golden Wheat, Harvest Ochre & Loam
        const bench = ["wheat", "ochre", "loam", "pasture", "orchard"];
        const shift = (i + slotIdx) % 3;
        prefs = [...bench.slice(shift), ...bench.slice(0, shift)];
      }

      // Check already-assigned edge neighbors to avoid identical adjacent crop + furrowDir
      const neighborCrops = new Set();
      const neighborDirs = new Set();
      for (let j = 0; j < i; j++) {
        const q = bspParcels[j];
        const xOv = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
        const yOv = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
        if (
          (xOv >= 2 && (p.y0 === q.y1 || p.y1 === q.y0)) ||
          (yOv >= 2 && (p.x0 === q.x1 || p.x1 === q.x0))
        ) {
          neighborCrops.add(q.crop);
          neighborDirs.add(q.furrowDir);
        }
      }
      p.crop = prefs.find((c) => !neighborCrops.has(c)) || prefs[0];
      if (neighborDirs.has(p.furrowDir) && neighborDirs.size === 1) {
        p.furrowDir = 1 - p.furrowDir;
      } else {
        p.furrowDir = (i + slotIdx) % 2;
      }
    }

    // (#3) Trace Smooth Contour- & Riverbank-Hugging Outer Estate Boundary Loops
    const estateLoops = this.traceSmoothEstateLoops(estateTileSet);

    // (#6a) Build Broken-Grid Farm Track Network (`tractorTracks`) serving every field & stopping fractionally in terminal fields
    const tractorTracks = this.buildBrokenGridTractorTracks(
      bspParcels,
      estateTileSet,
      fgx,
      fgy,
      slotIdx,
    );

    const distPointToTrack = (px, py) => {
      let minD = Infinity;
      for (const tr of tractorTracks) {
        const dx = tr.x1 - tr.x0;
        const dy = tr.y1 - tr.y0;
        const lenSq = dx * dx + dy * dy;
        let t =
          lenSq > 1e-6 ? ((px - tr.x0) * dx + (py - tr.y0) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(px - (tr.x0 + t * dx), py - (tr.y0 + t * dy));
        if (d < minD) minD = d;
      }
      return minD;
    };

    // (#6b) Place a sparse row of Windbreak Poplars (`windbreakPts`) along the highest upland outer boundary segment,
    // strictly >= 2.8 tiles clear of any farm road (`tractorTracks`) or paved road!
    const windbreakPts = [];
    if (estateLoops.length > 0) {
      const mainLoop = estateLoops[0];
      let bestSegStart = -1;
      let bestScore = -Infinity;
      const winLen = Math.min(10, Math.floor(mainLoop.length * 0.25));
      if (winLen >= 3) {
        for (let i = 0; i < mainLoop.length; i++) {
          let elevSum = 0;
          let invalidSeg = false;
          for (let k = 0; k < winLen; k++) {
            const pt = mainLoop[(i + k) % mainLoop.length];
            const gx = Math.round(pt[0]),
              gy = Math.round(pt[1]);
            if (!this.inBounds(gx, gy, 2)) {
              invalidSeg = true;
              break;
            }
            const tid = this.idx(gx, gy);
            const touchesOrchard = bspParcels.some(
              (p) =>
                p.crop === "orchard" &&
                pt[0] >= p.x0 - 1 &&
                pt[0] <= p.x1 + 1 &&
                pt[1] >= p.y0 - 1 &&
                pt[1] <= p.y1 + 1,
            );
            if (
              touchesOrchard ||
              this.roadGrid[tid] > 0 ||
              distPointToTrack(pt[0], pt[1]) < 2.8
            ) {
              invalidSeg = true;
              break;
            }
            elevSum += this.elevationField[tid];
          }
          if (!invalidSeg && elevSum > bestScore) {
            bestScore = elevSum;
            bestSegStart = i;
          }
        }
        if (bestSegStart >= 0) {
          for (let k = 0; k < winLen; k++) {
            const a = mainLoop[(bestSegStart + k) % mainLoop.length];
            const b = mainLoop[(bestSegStart + k + 1) % mainLoop.length];
            const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const steps = Math.max(1, Math.round(segLen / 0.85));
            for (let s = 0; s < steps; s++) {
              const t = s / steps;
              const wx = a[0] + t * (b[0] - a[0]);
              const wy = a[1] + t * (b[1] - a[1]);
              if (distPointToTrack(wx, wy) >= 2.6) {
                windbreakPts.push([wx, wy]);
              }
            }
          }
        }
      }
    }

    return { bspParcels, estateLoops, tractorTracks, windbreakPts };
  }

  /**
   * Builds a connected, broken-grid unpaved farm road network along internal BSP parcel seams
   * that reaches and serves every parcel in `bspParcels` and terminates at a random fractional
   * distance (`36%–76%`) along terminal field seams without touching outer boundaries or trees.
   */
  buildBrokenGridTractorTracks(bspParcels, estateTileSet, fgx, fgy, slotIdx) {
    if (!bspParcels || bspParcels.length === 0) return [];

    // 1. Collect shared seams between adjacent BSP parcels + the 4 root edges of the 2×2 farmstead pad
    const rawSeams = [
      { axis: "h", y: fgy, a: fgx, b: fgx + 2, parcels: [], isPad: true },
      { axis: "h", y: fgy + 2, a: fgx, b: fgx + 2, parcels: [], isPad: true },
      { axis: "v", x: fgx, a: fgy, b: fgy + 2, parcels: [], isPad: true },
      { axis: "v", x: fgx + 2, a: fgy, b: fgy + 2, parcels: [], isPad: true },
    ];

    for (let i = 0; i < bspParcels.length; i++) {
      const p = bspParcels[i];
      // Connect any parcel touching the 2×2 farmstead `[fgx, fgx+2] × [fgy, fgy+2]`both along AND across the parcel
      // so tracks leaving the barn yard always reach the interior BSP seams!
      const touchesFarm =
        p.x0 <= fgx + 2 && p.x1 >= fgx && p.y0 <= fgy + 2 && p.y1 >= fgy;
      if (touchesFarm) {
        for (const py of [fgy, fgy + 2]) {
          if (py >= p.y0 && py <= p.y1) {
            rawSeams.push({
              axis: "h",
              y: py,
              a: Math.min(p.x0, fgx),
              b: Math.max(p.x1, fgx + 2),
              parcels: [i],
              isPad: false,
            });
          }
        }
        for (const px of [fgx, fgx + 2]) {
          if (px >= p.x0 && px <= p.x1) {
            rawSeams.push({
              axis: "v",
              x: px,
              a: Math.min(p.y0, fgy),
              b: Math.max(p.y1, fgy + 2),
              parcels: [i],
              isPad: false,
            });
          }
        }
      }

      for (let j = i + 1; j < bspParcels.length; j++) {
        const q = bspParcels[j];
        if (p.y1 === q.y0 || p.y0 === q.y1) {
          const sy = p.y1 === q.y0 ? p.y1 : p.y0;
          const xA = Math.max(p.x0, q.x0);
          const xB = Math.min(p.x1, q.x1);
          if (xB - xA >= 1) {
            rawSeams.push({
              axis: "h",
              y: sy,
              a: xA,
              b: xB,
              parcels: [i, j],
              isPad: false,
            });
          }
        }
        if (p.x1 === q.x0 || p.x0 === q.x1) {
          const sx = p.x1 === q.x0 ? p.x1 : p.x0;
          const yA = Math.max(p.y0, q.y0);
          const yB = Math.min(p.y1, q.y1);
          if (yB - yA >= 1) {
            rawSeams.push({
              axis: "v",
              x: sx,
              a: yA,
              b: yB,
              parcels: [i, j],
              isPad: false,
            });
          }
        }
      }
    }

    // 2. Collect all split coordinates along each seam line (endpoints + T-junction intersections)
    const hSeams = rawSeams.filter((s) => s.axis === "h");
    const vSeams = rawSeams.filter((s) => s.axis === "v");

    const vKey = (x, y) => `${x},${y}`;
    const vertices = new Map();
    const ensureVertex = (x, y) => {
      const k = vKey(x, y);
      let v = vertices.get(k);
      if (!v) {
        const isPadVert = x >= fgx && x <= fgx + 2 && y >= fgy && y <= fgy + 2;
        // A vertex is strictly interior if all 4 surrounding grid cells belong to `estateTileSet`
        // AND lie well below the `dh = 0.13` hillside forest contour (`< seaLevel + 0.118`)
        let isInterior = isPadVert;
        if (!isPadVert) {
          isInterior = true;
          for (const [dx, dy] of [
            [-1, -1],
            [0, -1],
            [-1, 0],
            [0, 0],
          ]) {
            const gx = x + dx,
              gy = y + dy;
            if (
              !estateTileSet.has(gx * 10000 + gy) ||
              !this.inBounds(gx, gy, 2)
            ) {
              isInterior = false;
              break;
            }
            const tid = this.idx(gx, gy);
            if (
              this.elevationField[tid] >= this.seaLevel + 0.13 ||
              this.distToWater[tid] < 1.8
            ) {
              isInterior = false;
              break;
            }
          }
        }
        v = { k, x, y, isPadVert, isInterior, edges: [] };
        vertices.set(k, v);
      }
      return v;
    };

    const edgeMap = new Map();
    const addAtomicEdge = (x0, y0, x1, y1, axis, parcels, isPad) => {
      if (x0 === x1 && y0 === y1) return;
      // Skip any non-pad segment whose midpoint is outside the arable flatland (`dh < 0.13`)
      if (!isPad) {
        const mx = Math.floor((x0 + x1) * 0.5);
        const my = Math.floor((y0 + y1) * 0.5);
        if (!this.inBounds(mx, my, 2)) return;
        const midId = this.idx(mx, my);
        if (
          this.elevationField[midId] >= this.seaLevel + 0.13 ||
          this.distToWater[midId] < 1.8
        )
          return;
        // Both sides of an internal seam at its midpoint must belong to `estateTileSet`
        const cellA =
          axis === "h" ? mx * 10000 + (y0 - 1) : (x0 - 1) * 10000 + my;
        const cellB = axis === "h" ? mx * 10000 + y0 : x0 * 10000 + my;
        if (!estateTileSet.has(cellA) || !estateTileSet.has(cellB)) return;
      }

      const u = ensureVertex(x0, y0);
      const v = ensureVertex(x1, y1);
      const eKey = u.k < v.k ? `${u.k}|${v.k}` : `${v.k}|${u.k}`;
      let e = edgeMap.get(eKey);
      if (!e) {
        e = {
          id: eKey,
          u: u.k,
          v: v.k,
          x0: u.x,
          y0: u.y,
          x1: v.x,
          y1: v.y,
          axis,
          len: Math.hypot(v.x - u.x, v.y - u.y),
          parcels: new Set(),
          isPad: Boolean(isPad),
        };
        edgeMap.set(eKey, e);
        u.edges.push(e);
        v.edges.push(e);
      }
      if (isPad) e.isPad = true;
      for (const pIdx of parcels) e.parcels.add(pIdx);
    };

    for (const hs of hSeams) {
      const xs = new Set([hs.a, hs.b]);
      for (const os of hSeams) {
        if (os.y === hs.y) {
          if (os.a >= hs.a && os.a <= hs.b) xs.add(os.a);
          if (os.b >= hs.a && os.b <= hs.b) xs.add(os.b);
        }
      }
      for (const vs of vSeams) {
        if (vs.x >= hs.a && vs.x <= hs.b && hs.y >= vs.a && hs.y <= vs.b) {
          xs.add(vs.x);
        }
      }
      const sortedX = [...xs].sort((a, b) => a - b);
      for (let k = 0; k < sortedX.length - 1; k++) {
        addAtomicEdge(
          sortedX[k],
          hs.y,
          sortedX[k + 1],
          hs.y,
          "h",
          hs.parcels,
          hs.isPad,
        );
      }
    }

    for (const vs of vSeams) {
      const ys = new Set([vs.a, vs.b]);
      for (const os of vSeams) {
        if (os.x === vs.x) {
          if (os.a >= vs.a && os.a <= vs.b) ys.add(os.a);
          if (os.b >= vs.a && os.b <= vs.b) ys.add(os.b);
        }
      }
      for (const hs of hSeams) {
        if (hs.y >= vs.a && hs.y <= vs.b && vs.x >= hs.a && vs.x <= hs.b) {
          ys.add(hs.y);
        }
      }
      const sortedY = [...ys].sort((a, b) => a - b);
      for (let k = 0; k < sortedY.length - 1; k++) {
        addAtomicEdge(
          vs.x,
          sortedY[k],
          vs.x,
          sortedY[k + 1],
          "v",
          vs.parcels,
          vs.isPad,
        );
      }
    }

    // Associate each atomic edge with all BSP parcels whose boundary contains the segment
    const allEdges = [...edgeMap.values()];
    for (const e of allEdges) {
      if (e.isPad) continue;
      for (let pIdx = 0; pIdx < bspParcels.length; pIdx++) {
        const p = bspParcels[pIdx];
        if (e.axis === "h" && (e.y0 === p.y0 || e.y0 === p.y1)) {
          const xMin = Math.min(e.x0, e.x1),
            xMax = Math.max(e.x0, e.x1);
          if (xMin >= p.x0 && xMax <= p.x1) e.parcels.add(pIdx);
        } else if (e.axis === "v" && (e.x0 === p.x0 || e.x0 === p.x1)) {
          const yMin = Math.min(e.y0, e.y1),
            yMax = Math.max(e.y0, e.y1);
          if (yMin >= p.y0 && yMax <= p.y1) e.parcels.add(pIdx);
        }
      }
    }

    // 3. Grow a Broken-Grid Spanning Tree from the 2×2 farmstead pad
    const treeVerts = new Set();
    const selectedEdges = new Set();
    const vertInAxis = new Map();
    for (const v of vertices.values()) {
      if (v.isPadVert) treeVerts.add(v.k);
    }
    for (const e of allEdges) {
      if (e.isPad) selectedEdges.add(e);
    }

    // Step 3A: Prim's broken-grid expansion over interior vertices (`isInterior === true`)
    // Preferring 90° orthogonal turns (`turnDiscount = 0.62`) creates staggered broken-grid jogs!
    let grew = true;
    while (grew) {
      grew = false;
      let bestEdge = null;
      let bestTo = null;
      let bestCost = Infinity;

      for (const uKey of treeVerts) {
        const u = vertices.get(uKey);
        if (!u) continue;
        const inAx = vertInAxis.get(uKey);
        for (const e of u.edges) {
          if (selectedEdges.has(e)) continue;
          const otherKey = e.u === uKey ? e.v : e.u;
          if (treeVerts.has(otherKey)) continue;
          const otherV = vertices.get(otherKey);
          if (!otherV || !otherV.isInterior) continue;

          const hash =
            ((u.x * 31 +
              u.y * 17 +
              otherV.x * 13 +
              otherV.y * 7 +
              slotIdx * 19) &
              15) /
            15;
          const turnMult = inAx && inAx !== e.axis ? 0.62 : 1.18;
          const cost = e.len * (0.85 + hash * 0.35) * turnMult;
          if (cost < bestCost) {
            bestCost = cost;
            bestEdge = e;
            bestTo = otherKey;
          }
        }
      }

      if (bestEdge) {
        selectedEdges.add(bestEdge);
        treeVerts.add(bestTo);
        vertInAxis.set(bestTo, bestEdge.axis);
        grew = true;
      }
    }

    // Step 3B: Ensure EVERY parcel (`0 .. bspParcels.length - 1`) is served by at least one non-pad edge,
    // and add radial terminal seam spurs (`u_inner -> v_outer`) between outer fields!
    const getServedParcels = () => {
      const s = new Set();
      for (const e of selectedEdges) {
        if (e.isPad) continue;
        for (const pIdx of e.parcels) s.add(pIdx);
      }
      return s;
    };

    // Add radial terminal seam spurs `(u_inner in treeVerts -> v_outer on perimeter)` so outer fields
    // get dedicated dead-end spurs that stop fractionally along their shared seams!
    for (const uKey of Array.from(treeVerts)) {
      const u = vertices.get(uKey);
      if (!u || !u.isInterior) continue;
      for (const e of u.edges) {
        if (selectedEdges.has(e) || e.isPad) continue;
        const otherKey = e.u === uKey ? e.v : e.u;
        if (treeVerts.has(otherKey)) continue;
        const otherV = vertices.get(otherKey);
        if (!otherV || otherV.isInterior) continue;
        if (e.len >= 3.0) {
          selectedEdges.add(e);
          treeVerts.add(otherKey);
        }
      }
    }

    // Shortest-path augmentation for any parcel still unserved
    for (let pIdx = 0; pIdx < bspParcels.length; pIdx++) {
      const served = getServedParcels();
      if (served.has(pIdx)) continue;

      // Dijkstra from `treeVerts` to any edge serving `pIdx`
      const dist = new Map();
      const prevEdge = new Map();
      const prevVert = new Map();
      const pq = [];
      for (const tk of treeVerts) {
        dist.set(tk, 0);
        pq.push({ k: tk, d: 0 });
      }
      let targetVert = null;
      let targetLeafEdge = null;

      while (pq.length > 0) {
        pq.sort((a, b) => a.d - b.d);
        const curr = pq.shift();
        if (curr.d > (dist.get(curr.k) ?? Infinity)) continue;
        const u = vertices.get(curr.k);
        if (!u) continue;

        for (const e of u.edges) {
          if (e.parcels.has(pIdx) && !e.isPad) {
            targetVert = curr.k;
            targetLeafEdge = e;
            break;
          }
          const nk = e.u === curr.k ? e.v : e.u;
          const nv = vertices.get(nk);
          if (!nv) continue;
          const stepCost = e.len + (nv.isInterior ? 0 : 25);
          const nd = curr.d + stepCost;
          if (nd < (dist.get(nk) ?? Infinity)) {
            dist.set(nk, nd);
            prevEdge.set(nk, e);
            prevVert.set(nk, curr.k);
            pq.push({ k: nk, d: nd });
          }
        }
        if (targetLeafEdge) break;
      }

      if (targetLeafEdge) {
        selectedEdges.add(targetLeafEdge);
        const otherK =
          targetLeafEdge.u === targetVert ? targetLeafEdge.v : targetLeafEdge.u;
        treeVerts.add(otherK);
        let cur = targetVert;
        while (cur) {
          treeVerts.add(cur);
          const pe = prevEdge.get(cur);
          if (!pe) break;
          selectedEdges.add(pe);
          cur = prevVert.get(cur);
        }
      }
    }

    // 4. Orient the selected graph as a directed tree rooted at `padVerts`, merge collinear
    // degree-2 terminal chains, and truncate all leaf/terminal edges at a random fraction `t ∈ [0.38, 0.76]`!
    const visitedV = new Set();
    const bfsQueue = [];
    for (const v of vertices.values()) {
      if (v.isPadVert) {
        visitedV.add(v.k);
        bfsQueue.push(v.k);
      }
    }

    const directedEdges = [];
    const childrenMap = new Map();
    while (bfsQueue.length > 0) {
      const uk = bfsQueue.shift();
      const u = vertices.get(uk);
      if (!u) continue;
      for (const e of u.edges) {
        if (!selectedEdges.has(e)) continue;
        const vk = e.u === uk ? e.v : e.u;
        if (visitedV.has(vk)) continue;
        visitedV.add(vk);
        bfsQueue.push(vk);
        if (!e.isPad) {
          const v = vertices.get(vk);
          const de = {
            uk,
            vk,
            x0: u.x,
            y0: u.y,
            x1: v.x,
            y1: v.y,
            axis: e.axis,
            vInterior: v.isInterior,
            parcels: e.parcels,
          };
          directedEdges.push(de);
          let ch = childrenMap.get(uk);
          if (!ch) {
            ch = [];
            childrenMap.set(uk, ch);
          }
          ch.push(de);
        }
      }
    }

    // Merge collinear degree-2 chains ending at a leaf (`u -> w -> v_leaf` on same axis)
    // so fractional truncation `t` applies across the entire straight terminal seam!
    const absorbed = new Set();
    for (const de of directedEdges) {
      if (absorbed.has(de)) continue;
      let ch = childrenMap.get(de.vk);
      while (ch && ch.length === 1 && ch[0].axis === de.axis) {
        const nextDe = ch[0];
        const grandCh = childrenMap.get(nextDe.vk);
        if (!grandCh || grandCh.length === 0) {
          de.vk = nextDe.vk;
          de.x1 = nextDe.x1;
          de.y1 = nextDe.y1;
          de.vInterior = nextDe.vInterior;
          for (const pIdx of nextDe.parcels) de.parcels.add(pIdx);
          absorbed.add(nextDe);
          childrenMap.set(de.uk, [de]);
          childrenMap.delete(nextDe.uk);
          break;
        }
        break;
      }
    }

    const finalTracks = [];
    for (let i = 0; i < directedEdges.length; i++) {
      const de = directedEdges[i];
      if (absorbed.has(de)) continue;
      const ch = childrenMap.get(de.vk);
      const isLeaf = !ch || ch.length === 0 || !de.vInterior;

      if (isLeaf) {
        // Stop fractionally randomly (`t ∈ [0.38, 0.76]`) through the terminal field seam!
        const hash =
          Math.abs(
            de.x0 * 37 +
              de.y0 * 53 +
              de.x1 * 19 +
              de.y1 * 29 +
              slotIdx * 13 +
              i * 7,
          ) % 39;
        let t = 0.38 + hash / 100;
        const segLen = Math.hypot(de.x1 - de.x0, de.y1 - de.y0);
        // Ensure at least 1.8 tiles of visible spur and at least 1.6 tiles of margin before an outer contour/fence
        if (segLen > 3.2) {
          t = Math.max(1.8 / segLen, Math.min((segLen - 1.6) / segLen, t));
        } else {
          t = 0.55;
        }
        finalTracks.push({
          x0: de.x0,
          y0: de.y0,
          x1: de.x0 + (de.x1 - de.x0) * t,
          y1: de.y0 + (de.y1 - de.y0) * t,
          isLeaf: true,
        });
      } else {
        finalTracks.push({
          x0: de.x0,
          y0: de.y0,
          x1: de.x1,
          y1: de.y1,
          isLeaf: false,
        });
      }
    }

    // For any outer terminal parcel (`w >= 5 && h >= 5`) not yet directly bordered by a track segment,
    // branch a connected fractional spur strictly from an existing point on `finalTracks` that touches `p`!
    const pointOnAnyTrack = (px, py) => {
      for (const tr of finalTracks) {
        const minX = Math.min(tr.x0, tr.x1) - 0.05,
          maxX = Math.max(tr.x0, tr.x1) + 0.05;
        const minY = Math.min(tr.y0, tr.y1) - 0.05,
          maxY = Math.max(tr.y0, tr.y1) + 0.05;
        if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
          const dx = tr.x1 - tr.x0,
            dy = tr.y1 - tr.y0;
          if (Math.abs(dx) < 0.05 && Math.abs(px - tr.x0) < 0.1) return true;
          if (Math.abs(dy) < 0.05 && Math.abs(py - tr.y0) < 0.1) return true;
        }
      }
      return false;
    };

    for (let pIdx = 0; pIdx < bspParcels.length; pIdx++) {
      const p = bspParcels[pIdx];
      const pw = p.x1 - p.x0;
      const ph = p.y1 - p.y0;
      if (pw < 5 || ph < 5) continue;

      // Check if any segment in `finalTracks` already runs along or inside `p` for >= 1.5 tiles
      let servedLen = 0;
      for (const tr of finalTracks) {
        const ox0 = Math.max(p.x0, Math.min(tr.x0, tr.x1));
        const ox1 = Math.min(p.x1, Math.max(tr.x0, tr.x1));
        const oy0 = Math.max(p.y0, Math.min(tr.y0, tr.y1));
        const oy1 = Math.min(p.y1, Math.max(tr.y0, tr.y1));
        if (ox1 >= ox0 - 0.05 && oy1 >= oy0 - 0.05) {
          servedLen = Math.max(servedLen, Math.hypot(ox1 - ox0, oy1 - oy0));
        }
      }
      if (servedLen >= 1.8) continue;

      const frac = 0.42 + ((pIdx * 17 + slotIdx * 11) % 28) / 100;
      const midX = Math.round((p.x0 + p.x1) * 0.5);
      const midY = Math.round((p.y0 + p.y1) * 0.5);
      if (pointOnAnyTrack(midX, p.y0)) {
        finalTracks.push({
          x0: midX,
          y0: p.y0,
          x1: midX,
          y1: p.y0 + ph * frac,
          isLeaf: true,
        });
      } else if (pointOnAnyTrack(midX, p.y1)) {
        finalTracks.push({
          x0: midX,
          y0: p.y1,
          x1: midX,
          y1: p.y1 - ph * frac,
          isLeaf: true,
        });
      } else if (pointOnAnyTrack(p.x0, midY)) {
        finalTracks.push({
          x0: p.x0,
          y0: midY,
          x1: p.x0 + pw * frac,
          y1: midY,
          isLeaf: true,
        });
      } else if (pointOnAnyTrack(p.x1, midY)) {
        finalTracks.push({
          x0: p.x1,
          y0: midY,
          x1: p.x1 - pw * frac,
          y1: midY,
          isLeaf: true,
        });
      }
    }

    return finalTracks;
  }

  /**
   * Traces the directed outer perimeter loop(s) of `estateTileSet` and applies selective
   * Chaikin corner-smoothing on contour/river staircase steps while keeping long open-plain
   * cadastral edges (`>= 4` tiles) crisp and straight.
   */
  traceSmoothEstateLoops(estateTileSet) {
    // Collect directed unit boundary edges around every tile in `estateTileSet`
    const adj = new Map();
    const addEdge = (x0, y0, x1, y1) => {
      const k0 = `${x0},${y0}`;
      let list = adj.get(k0);
      if (!list) {
        list = [];
        adj.set(k0, list);
      }
      list.push({ x0, y0, x1, y1, used: false });
    };

    for (const key of estateTileSet) {
      const tx = Math.floor(key / 10000);
      const ty = key % 10000;
      if (!estateTileSet.has(tx * 10000 + (ty - 1)))
        addEdge(tx, ty, tx + 1, ty);
      if (!estateTileSet.has((tx + 1) * 10000 + ty))
        addEdge(tx + 1, ty, tx + 1, ty + 1);
      if (!estateTileSet.has(tx * 10000 + (ty + 1)))
        addEdge(tx + 1, ty + 1, tx, ty + 1);
      if (!estateTileSet.has((tx - 1) * 10000 + ty))
        addEdge(tx, ty + 1, tx, ty);
    }

    const rawLoops = [];
    for (const edges of adj.values()) {
      for (const startEdge of edges) {
        if (startEdge.used) continue;
        startEdge.used = true;
        const loop = [[startEdge.x0, startEdge.y0]];
        let currX = startEdge.x1;
        let currY = startEdge.y1;
        let prevDx = startEdge.x1 - startEdge.x0;
        let prevDy = startEdge.y1 - startEdge.y0;
        let guard = 0;
        while (
          (currX !== startEdge.x0 || currY !== startEdge.y0) &&
          guard++ < 2000
        ) {
          loop.push([currX, currY]);
          const nextEdges = adj.get(`${currX},${currY}`);
          if (!nextEdges) break;
          // Prefer rightmost turn to keep loops simple and non-self-intersecting
          let chosen = null;
          for (const e of nextEdges) {
            if (!e.used) {
              chosen = e;
              if (e.x1 - e.x0 === prevDx && e.y1 - e.y0 === prevDy) break;
            }
          }
          if (!chosen) break;
          chosen.used = true;
          prevDx = chosen.x1 - chosen.x0;
          prevDy = chosen.y1 - chosen.y0;
          currX = chosen.x1;
          currY = chosen.y1;
        }
        if (loop.length >= 4) rawLoops.push(loop);
      }
    }

    // Sort largest loop first
    rawLoops.sort((a, b) => b.length - a.length);

    const smoothLoop = (unitLoop) => {
      // 1. Merge collinear unit edges into corner vertices
      const corners = [];
      const n = unitLoop.length;
      for (let i = 0; i < n; i++) {
        const pPrev = unitLoop[(i - 1 + n) % n];
        const pCurr = unitLoop[i];
        const pNext = unitLoop[(i + 1) % n];
        const dx1 = Math.sign(pCurr[0] - pPrev[0]),
          dy1 = Math.sign(pCurr[1] - pPrev[1]);
        const dx2 = Math.sign(pNext[0] - pCurr[0]),
          dy2 = Math.sign(pNext[1] - pCurr[1]);
        if (dx1 !== dx2 || dy1 !== dy2) {
          corners.push(pCurr);
        }
      }
      if (corners.length < 4) return corners;

      const isNaturalContourVertex = (pt) => {
        const gx = Math.round(pt[0]),
          gy = Math.round(pt[1]);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!this.inBounds(gx + dx, gy + dy, 2)) continue;
            const tid = this.idx(gx + dx, gy + dy);
            if (
              this.elevationField[tid] >= this.seaLevel + 0.118 ||
              this.distToWater[tid] < 3.2 ||
              this.waterMask[tid] > 0
            ) {
              return true;
            }
          }
        }
        return false;
      };

      // 2. Insert straight-edge anchor points:
      // - On cadastral/urban edges (not bordering a contour or riverbank), place tight 0.22-tile anchors on all segments (`len >= 1.5`)
      //   so cadastral steps stay crisp 0°/90° lines with subtle 3px rounded corners!
      // - On physical contour/riverbank edges (`isNaturalContourVertex`), only anchor segments `len >= 4.0`
      //   so 1–3 tile contour staircases smooth into a continuous contour-hugging curve!
      let pts = [];
      for (let i = 0; i < corners.length; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % corners.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const naturalEdge =
          isNaturalContourVertex(a) && isNaturalContourVertex(b);
        pts.push(a);
        if (!naturalEdge && len >= 1.5) {
          const ux = (b[0] - a[0]) / len;
          const uy = (b[1] - a[1]) / len;
          const pin = Math.min(0.24, len * 0.25);
          pts.push([a[0] + ux * pin, a[1] + uy * pin]);
          pts.push([b[0] - ux * pin, b[1] - uy * pin]);
        } else if (naturalEdge && len >= 4.0) {
          const ux = (b[0] - a[0]) / len;
          const uy = (b[1] - a[1]) / len;
          pts.push([a[0] + ux * 0.65, a[1] + uy * 0.65]);
          pts.push([b[0] - ux * 0.65, b[1] - uy * 0.65]);
        }
      }

      // 3. Apply 2 passes of closed-loop Chaikin corner cutting (`0.25 / 0.75`)
      for (let pass = 0; pass < 2; pass++) {
        const nextPts = [];
        for (let i = 0; i < pts.length; i++) {
          const p0 = pts[i];
          const p1 = pts[(i + 1) % pts.length];
          nextPts.push([
            p0[0] * 0.75 + p1[0] * 0.25,
            p0[1] * 0.75 + p1[1] * 0.25,
          ]);
          nextPts.push([
            p0[0] * 0.25 + p1[0] * 0.75,
            p0[1] * 0.25 + p1[1] * 0.75,
          ]);
        }
        pts = nextPts;
      }
      return pts;
    };

    return rawLoops.slice(0, 1).map(smoothLoop);
  }

  pruneEmptyOuterStreets() {
    const { W, H } = this;
    const size = W * H;
    const frontageMask = new Uint8Array(size);

    for (const h of this.houses) {
      const rx = Math.round(h.roadX),
        ry = Math.round(h.roadY);
      if (this.inBounds(rx, ry, 1)) frontageMask[this.idx(rx, ry)] = 1;
    }
    for (const d of this.destinations) {
      const rx = Math.round(d.roadX),
        ry = Math.round(d.roadY);
      if (this.inBounds(rx, ry, 1)) frontageMask[this.idx(rx, ry)] = 1;
      const wT = d.wTiles || 2;
      const hT = d.hTiles || 2;
      for (let dy = -1; dy <= hT; dy++) {
        for (let dx = -1; dx <= wT; dx++) {
          const px = d.gx + dx,
            py = d.gy + dy;
          if (this.inBounds(px, py, 1)) frontageMask[this.idx(px, py)] = 1;
        }
      }
    }

    const hasNearbyBuilding = (x, y) => {
      if (!this.inBounds(x, y, 1)) return false;
      return frontageMask[this.idx(x, y)] === 1;
    };

    // Multi-source BFS from town centers & main boulevards along `this.roadEdges`
    // so every street vertex serving a building OR touched by an arterial/stub connector traces
    // its entire street path (`keepMask[cur] = 1`) back to the town core!
    const keepMask = new Uint8Array(size);
    const arterialTouch = new Uint8Array(size);
    const parent = this._astarParent;
    const seenGen = this._astarSeenGen;
    const gen = ++this._astarGen;
    const queue = [];

    const seedRoot = (gx, gy) => {
      if (!this.inBounds(gx, gy, 1)) return;
      const id = this.idx(gx, gy);
      if (seenGen[id] !== gen) {
        seenGen[id] = gen;
        parent[id] = -1;
        keepMask[id] = 1;
        queue.push(id);
      }
    };

    for (const t of this.towns) {
      seedRoot(t.x, t.y);
    }
    for (const ic of this.interchanges) {
      if (ic.type === "terminal-stub") {
        const gx = Math.round(ic.x),
          gy = Math.round(ic.y);
        if (this.inBounds(gx, gy, 1)) arterialTouch[this.idx(gx, gy)] = 1;
      } else if (ic.type === "diamond-ramp") {
        for (const term of [
          ic.posTerm,
          ic.negTerm,
          { x: ic.connectX, y: ic.connectY },
        ]) {
          if (term && term.x !== undefined && term.y !== undefined) {
            const gx = Math.round(term.x),
              gy = Math.round(term.y);
            if (this.inBounds(gx, gy, 1)) arterialTouch[this.idx(gx, gy)] = 1;
          }
        }
      }
    }
    for (const r of this.roads) {
      if (r.type !== "street" && !r.isMainBoulevard) {
        for (const pt of r.points) {
          const gx = Math.round(pt.x),
            gy = Math.round(pt.y);
          if (this.inBounds(gx, gy, 1)) {
            arterialTouch[this.idx(gx, gy)] = 1;
          }
        }
      } else if (r.isMainBoulevard && r.points.length > 0) {
        // Seed only the central midpoint of a borough boulevard as a root so empty outer boulevard tails can be trimmed!
        const midPt = r.points[Math.floor(r.points.length * 0.5)];
        seedRoot(Math.round(midPt.x), Math.round(midPt.y));
      }
    }

    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
    let head = 0;
    while (head < queue.length) {
      const cid = queue[head++];
      const cx = cid % W;
      const cy = Math.floor(cid / W);
      for (const [dx, dy] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.inBounds(nx, ny, 1)) continue;
        if (!this.hasRoadEdge(cx, cy, nx, ny)) continue;
        const nid = this.idx(nx, ny);
        if (seenGen[nid] === gen) continue;
        seenGen[nid] = gen;
        parent[nid] = cid;
        queue.push(nid);
      }
    }

    for (const r of this.roads) {
      if (r.type !== "street" && !r.isMainBoulevard) continue;
      for (const pt of r.points) {
        const gx = Math.round(pt.x);
        const gy = Math.round(pt.y);
        if (!this.inBounds(gx, gy, 1)) continue;
        const id = this.idx(gx, gy);
        if (
          (hasNearbyBuilding(gx, gy) || arterialTouch[id] === 1) &&
          seenGen[id] === gen
        ) {
          let cur = id;
          while (cur !== -1) {
            keepMask[cur] = 1;
            cur = parent[cur];
          }
        }
      }
    }

    // End-only trimming (`firstKeep .. lastKeep`): trims both local streets AND empty outer tails of `isMainBoulevard`!
    const cleanedRoads = [];
    for (const r of this.roads) {
      if (r.type !== "street" && !r.isMainBoulevard) {
        cleanedRoads.push(r);
        continue;
      }
      const pts = r.points;
      const isVertexAnchored = (pt) => {
        const gx = Math.round(pt.x);
        const gy = Math.round(pt.y);
        const id = this.idx(gx, gy);
        return (
          keepMask[id] === 1 ||
          arterialTouch[id] === 1 ||
          hasNearbyBuilding(gx, gy)
        );
      };

      let firstKeep = -1;
      let lastKeep = -1;
      for (let i = 0; i < pts.length; i++) {
        if (isVertexAnchored(pts[i])) {
          if (firstKeep === -1) firstKeep = i;
          lastKeep = i;
        }
      }

      if (firstKeep !== -1 && lastKeep > firstKeep) {
        cleanedRoads.push({
          ...r,
          points: pts.slice(firstKeep, lastKeep + 1),
        });
      }
    }

    // Flood-fill from all arterial/bridge/loop tiles (`roadGrid >= 2`) and town centers so any
    // orphaned 2-tile street island severed from the town grid is cleanly removed!
    const reachable = new Uint8Array(this.W * this.H);
    const rQueue = [];
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        const id = this.idx(x, y);
        if (this.roadGrid[id] >= 2) {
          reachable[id] = 1;
          rQueue.push(x, y);
        }
      }
    }
    for (const t of this.towns) {
      const tid = this.idx(t.x, t.y);
      if (this.roadGrid[tid] > 0 && !reachable[tid]) {
        reachable[tid] = 1;
        rQueue.push(t.x, t.y);
      }
    }
    let rHead = 0;
    const dirs8 = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
    while (rHead < rQueue.length) {
      const cx = rQueue[rHead++];
      const cy = rQueue[rHead++];
      for (const [dx, dy] of dirs8) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.inBounds(nx, ny, 1)) continue;
        const nid = this.idx(nx, ny);
        if (this.roadGrid[nid] > 0 && !reachable[nid]) {
          reachable[nid] = 1;
          rQueue.push(nx, ny);
        }
      }
    }

    this.roads = cleanedRoads.filter((r) => {
      if (r.type !== "street") return true;
      return r.points.some(
        (pt) => reachable[this.idx(Math.round(pt.x), Math.round(pt.y))] === 1,
      );
    });
    this.rebuildRoadGridAndEdges();
  }

  /**
   * Carves a street line starting at `(cx, cy)` and marching outward in both `-dir` and `+dir`,
   * stopping upon hitting water, steep hillsides, an airport pad, or a parallel street within 2 tiles
   * so multi-phase borough grids meet cleanly at T-junctions without 1-tile slivers.
   */
  carveStreetFromCenter(
    cx,
    cy,
    ux,
    uy,
    negSteps,
    posSteps,
    isMainBoulevard = false,
  ) {
    const baseElev = this.inBounds(cx, cy, 1)
      ? this.elevationField[this.idx(cx, cy)]
      : this.seaLevel;
    const nx = -uy;
    const ny = ux;

    if (
      this.inBounds(cx + ux, cy + uy, 2) &&
      this.inBounds(cx - ux, cy - uy, 2) &&
      this.roadGrid[this.idx(cx, cy)] > 0 &&
      (this.roadGrid[this.idx(cx + ux, cy + uy)] > 0 ||
        this.roadGrid[this.idx(cx - ux, cy - uy)] > 0)
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
          const hasR =
            this.inBounds(tx, ty, 1) && this.roadGrid[this.idx(tx, ty)] > 0;
          if (hasR && prevHasRoad) return true;
          if (
            Math.abs(s) === 1 &&
            hasR &&
            t === 0 &&
            this.roadGrid[this.idx(x, y)] === 0
          )
            return true;
          prevHasRoad = hasR;
        }
      }
      return false;
    };

    const isIH = this.config.archetype === "island-hopper";
    const isPassable = (x, y) => {
      if (!this.inBounds(x, y, 3)) return false;
      const id = this.idx(x, y);
      if (
        this.waterMask[id] !== 0 ||
        this.buildingMask[id] !== 0 ||
        this.distToWater[id] < 2.35
      )
        return false;
      if (
        this.slopeField[id] > (isIH ? 0.58 : 0.46) ||
        this.elevationField[id] - baseElev > (isIH ? 0.22 : 0.14)
      )
        return false;
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
      for (let i = 0; i < pts.length; i++) {
        const pt = pts[i];
        const id = this.idx(pt.x, pt.y);
        if (isMainBoulevard) {
          this.roadGrid[id] = 2;
        } else if (this.roadGrid[id] === 0) {
          this.roadGrid[id] = 1;
        }
        if (i < pts.length - 1) {
          this.addRoadEdge(pt.x, pt.y, pts[i + 1].x, pts[i + 1].y);
        }
      }
      this.roads.push({
        points: pts,
        type: isMainBoulevard ? "arterial" : "street",
        isMainBoulevard,
      });
    }
  }

  /**
   * Places Commercial (`C`) and Industrial (`I`) sinks with true dimensional variation:
   * - `3×2` and `2×3` elongated rectangular halls/warehouses/sawtooth plants along arterials & industrial yards,
   * - `2×2` square CBD high-rise rotundas and `RAW` silo yards,
   * - `2×1` and `1×2` compact corner commercial blocks that fit into tighter central blocks and transition zones!
   */
  placeTownCommercialAndIndustrial(town, R, densityMult) {
    const boroughs =
      town.boroughs && town.boroughs.length > 0
        ? town.boroughs
        : [{ x: town.x, y: town.y, r: R }];

    const isIH = this.config.archetype === "island-hopper";
    const ihScale = isIH ? 0.68 : 1.0;
    const baseCom =
      town.tier === 1 ? 11 : town.tier === 2 ? 5 : town.tier === 3 ? 2 : 1;
    const baseInd =
      town.tier === 1 ? 6 : town.tier === 2 ? 3 : town.tier === 3 ? 2 : 1;
    const targetCom = Math.max(
      1,
      Math.round(baseCom * ihScale * Math.pow(densityMult, 0.7)),
    );
    const targetInd = Math.max(
      1,
      Math.round(baseInd * ihScale * Math.pow(densityMult, 0.66)),
    );

    // Asymmetric directional sector angle for industrial zoning (so industrial districts form distinct clusters/yards)
    const indSectorAngle = this.rng.range(0, Math.PI * 2);
    const indDirX = Math.cos(indSectorAngle);
    const indDirY = Math.sin(indSectorAngle);

    const scanR = R + 5;
    const evaluateFootprint = (gx, gy, wTiles, hTiles) => {
      if (
        !this.inBounds(gx, gy, 5) ||
        !this.inBounds(gx + wTiles - 1, gy + hTiles - 1, 5)
      )
        return null;
      for (let dy = 0; dy < hTiles; dy++) {
        for (let dx = 0; dx < wTiles; dx++) {
          const id = this.idx(gx + dx, gy + dy);
          if (
            this.waterMask[id] > 0 ||
            this.buildingMask[id] > 0 ||
            this.roadGrid[id] > 0 ||
            this.distToWater[id] < 2.35 ||
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
            if (!roadTouch)
              roadTouch = { x: rx, y: ry, lotX: rx, lotY: lotTileY };
          } else if (rg === 1) {
            streetCount++;
            if (!roadTouch)
              roadTouch = { x: rx, y: ry, lotX: rx, lotY: lotTileY };
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
            if (!roadTouch)
              roadTouch = { x: rx, y: ry, lotX: lotTileX, lotY: ry };
          } else if (rg === 1) {
            streetCount++;
            if (!roadTouch)
              roadTouch = { x: rx, y: ry, lotX: lotTileX, lotY: ry };
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
      const transitionNoise =
        this.noise.fbm(cx * 0.09 + 1.7, cy * 0.09 + 4.3, 2) * 11.5;

      const cbdScore =
        (touchesArterial ? 22.0 + arterialCount * 3.8 : streetCount * 1.4) -
        minBrDist * 2.1 -
        distTownCenter * 0.75 +
        transitionNoise +
        this.rng.range(-3.2, 3.2);

      const vecLen = Math.max(1, distTownCenter);
      const sectorAlign =
        ((cx - town.x) * indDirX + (cy - town.y) * indDirY) / vecLen;
      const dW = this.distToWater[this.idx(gx, gy)];
      const indRingBonus =
        minBrDist >= R * (0.34 + this.rng.range(-0.08, 0.1)) ? 16.0 : -18.0;
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
        indScore,
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
          if (this.buildingMask[this.idx(cand.gx + dx, cand.gy + dy)] > 0)
            return false;
        }
      }
      for (const d of this.destinations) {
        if (
          d.townId === town.id &&
          Math.hypot(d.x - cand.cx, d.y - cand.cy) < minSpacing
        ) {
          return false;
        }
      }
      return true;
    };

    const commitLot = (cand, zoneType, subType, isCircular) => {
      for (let dy = 0; dy < cand.hTiles; dy++) {
        for (let dx = 0; dx < cand.wTiles; dx++) {
          const lid = this.idx(cand.gx + dx, cand.gy + dy);
          this.buildingMask[lid] = 2;
          this.zoneColorIdx[lid] = town.colorIdx;
        }
      }
      const colorIdx =
        zoneType === "commercial"
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
        subType, // 'CBD High-Rise' | 'Arterial Plaza' | 'Corner Market' | 'RAW' | 'MFG' | 'LOG'
        isCircular,
        hasUrgentPin: this.rng.next() < 0.16,
        pinsCount:
          area >= 6
            ? this.rng.int(5, 7)
            : area === 4
              ? this.rng.int(3, 5)
              : this.rng.int(2, 3),
        colorIdx,
        palette: PALETTE.districtColors[colorIdx],
      });
      town.destinationsCount++;
      if (zoneType === "commercial") town.commercialCount++;
      else town.industrialCount++;
    };

    // 1. Place Commercial (`C`) Sinks with Dimensional Mix:
    //    - Flagship 2×2 CBD Rotundas + 3×2/2×3 Arterial Plazas + 2×1/1×2 Corner Markets!
    const comLargePool = [
      ...slots2x2,
      ...slotsRect.map((s) => ({
        ...s,
        cbdScore: s.cbdScore + (s.touchesArterial ? 4.5 : -1.5),
      })),
    ].sort((a, b) => b.cbdScore - a.cbdScore);
    const comCompactPool = [...slotsCompact].sort(
      (a, b) => b.cbdScore - a.cbdScore,
    );

    let placedCom = 0;
    const largeTarget = Math.max(1, Math.round(targetCom * 0.64));
    for (const cand of comLargePool) {
      if (placedCom >= largeTarget) break;
      // Give 2×2/3×2 buildings breathing room (`minSpacing = 3.6`) so they don't tile into a solid grid
      if (!isLotFree(cand, 3.6)) continue;
      const is2x2 = cand.wTiles === 2 && cand.hTiles === 2;
      const isCBDLandmark =
        is2x2 &&
        (placedCom === 0 || (cand.minBrDist < 4.5 && this.rng.next() < 0.45));
      const subType = isCBDLandmark ? "CBD High-Rise" : "Arterial Retail Plaza";
      commitLot(cand, "commercial", subType, isCBDLandmark);
      placedCom++;
    }

    // Fill remaining Commercial quota with compact 2×1 / 1×2 Corner Markets in tight central & arterial blocks!
    for (const cand of comCompactPool) {
      if (placedCom >= targetCom) break;
      if (!isLotFree(cand, 2.5)) continue;
      commitLot(cand, "commercial", "Corner Market", false);
      placedCom++;
    }

    // 2. Place Industrial (`I`) Sinks & Producers (`3×2`/`2×3` MFG Factories & LOG Hubs + `2×2` RAW Silo Yards)
    const indRectSorted = [...slotsRect].sort(
      (a, b) => b.indScore - a.indScore,
    );
    const ind2x2Sorted = [...slots2x2].sort((a, b) => b.indScore - a.indScore);
    const tier1Roles = ["MFG", "LOG", "RAW", "MFG", "LOG", "MFG"];
    const tier2Roles = ["MFG", "LOG", "MFG", "RAW", "LOG"];
    const tier3Roles = ["MFG", "LOG", "RAW"];

    let placedInd = 0;
    let rectIdx = 0;
    let sqIdx = 0;
    while (
      placedInd < targetInd &&
      (rectIdx < indRectSorted.length || sqIdx < ind2x2Sorted.length)
    ) {
      let indRole = "RAW";
      if (town.tier === 1) indRole = tier1Roles[placedInd % tier1Roles.length];
      else if (town.tier === 2)
        indRole = tier2Roles[placedInd % tier2Roles.length];
      else indRole = tier3Roles[placedInd % tier3Roles.length];

      // `MFG` and `LOG` strongly prefer elongated `3×2` or `2×3` rectangular halls when available!
      const preferRect =
        (indRole === "MFG" || indRole === "LOG") && this.rng.next() < 0.75;
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

      commitLot(chosen, "industrial", indRole, false);
      placedInd++;
    }
  }

  tryPlaceNeighborhoodHouses(town, targetHouses, customRadius = null) {
    const boroughs =
      town.boroughs && town.boroughs.length > 0
        ? town.boroughs
        : [{ x: town.x, y: town.y, r: customRadius || town.urbanRadius }];
    const secondaryColorIdx =
      (town.colorIdx + 2) % PALETTE.districtColors.length;
    const clusterOffset = {
      x: town.x + this.rng.range(-8, 8),
      y: town.y + this.rng.range(-8, 8),
    };

    const scanR = (customRadius || town.urbanRadius) + 3;
    const houseSlots = [];
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];

    for (let gy = town.y - scanR; gy <= town.y + scanR; gy++) {
      for (let gx = town.x - scanR; gx <= town.x + scanR; gx++) {
        if (!this.inBounds(gx, gy, 3)) continue;
        const id = this.idx(gx, gy);
        if (
          this.waterMask[id] > 0 ||
          this.buildingMask[id] > 0 ||
          this.roadGrid[id] > 0 ||
          this.distToWater[id] < 2.35
        )
          continue;
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
        const patchNoise =
          this.noise.fbm(gx * 0.14 + 5.2, gy * 0.14 + 2.9, 2) * 5.5;
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
      if (this.buildingMask[slot.id] > 0 || this.roadGrid[slot.id] > 0)
        continue;

      // Prevent 4-house "waffle blocks": leave yard/courtyard breathing room inside blocks!
      const adj = countAdjacentHouses(slot.gx, slot.gy);
      const radialFrac = Math.min(1, slot.minBrDist / Math.max(6, scanR));
      if (adj >= 3) continue;
      if (adj === 2 && this.rng.next() < 0.72) continue;
      if (adj === 1 && this.rng.next() < 0.25 + radialFrac * 0.35) continue;

      this.buildingMask[slot.id] = 1;
      const useSecondary =
        Math.hypot(slot.gx - clusterOffset.x, slot.gy - clusterOffset.y) <
        scanR * 0.36;
      const colorIdx = useSecondary ? secondaryColorIdx : town.colorIdx;

      // Dimensional variation for individual houses (cottages, L-townhouses, varied setbacks)
      const wScale = this.rng.range(0.6, 0.84);
      const hScale = this.rng.range(0.6, 0.84);
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
        palette: PALETTE.districtColors[colorIdx],
      });
      town.housesCount++;
    }
  }

  /**
   * Builds and caches a unified Multi-Modal Vehicle Routing Graph (`this._vehicleGraph`)
   * combining committed surface roads (`this.roads`), elevated expressways (`this.motorways`),
   * terminal roundabouts (`terminal-stub`), intermediate diamond slip-ramps (`diamond-ramp`),
   * and system interchanges (`cloverleaf`, `trumpet`).
   */
  ensureVehicleRoutingGraph() {
    if (this._vehicleGraph) return this._vehicleGraph;
    const { W, H } = this;
    const nodes = [];
    const adj = [];
    const tileToNode = new Int32Array(W * H).fill(-1);

    const addNode = (
      x,
      y,
      onMotorway = false,
      inTunnel = false,
      isStreet = false,
      isRoundabout = false,
      isSlipRamp = false,
    ) => {
      const id = nodes.length;
      nodes.push({
        x,
        y,
        onMotorway,
        inTunnel,
        isStreet,
        isRoundabout,
        isSlipRamp,
      });
      adj.push([]);
      return id;
    };

    const addEdge = (u, v, cost) => {
      if (u === v || u < 0 || v < 0) return;
      const listU = adj[u];
      for (let i = 0; i < listU.length; i++) {
        if (listU[i].to === v) {
          if (cost < listU[i].cost) listU[i].cost = cost;
          return;
        }
      }
      listU.push({ to: v, cost });
    };

    const addBiEdge = (u, v, cost) => {
      addEdge(u, v, cost);
      addEdge(v, u, cost);
    };

    const ensureSurfaceNode = (gx, gy) => {
      const tid = gy * W + gx;
      if (tileToNode[tid] !== -1) return tileToNode[tid];
      const isStreet = this.roadGrid[tid] === 1;
      const nid = addNode(gx, gy, false, false, isStreet, false);
      tileToNode[tid] = nid;
      return nid;
    };

    // 1. Add all committed surface road edges from `this.roads`
    for (const r of this.roads) {
      const pts = r.points;
      if (!pts || pts.length < 2) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        const x0 = Math.round(pts[i].x);
        const y0 = Math.round(pts[i].y);
        const x1 = Math.round(pts[i + 1].x);
        const y1 = Math.round(pts[i + 1].y);
        if (!this.inBounds(x0, y0, 1) || !this.inBounds(x1, y1, 1)) continue;
        const u = ensureSurfaceNode(x0, y0);
        const v = ensureSurfaceNode(x1, y1);
        const dist = Math.hypot(x1 - x0, y1 - y0) || 1;
        const mult = nodes[u].isStreet || nodes[v].isStreet ? 1.35 : 1.0;
        addBiEdge(u, v, dist * mult);
      }
    }

    const numSurfaceNodes = nodes.length;

    // Helper: connect a portal node to all nearby surface road nodes within `maxR`
    const connectToNearbySurfaceNodes = (
      portalNode,
      px,
      py,
      maxR,
      rampCost = 0.85,
    ) => {
      const rCeil = Math.ceil(maxR);
      const gx0 = Math.round(px);
      const gy0 = Math.round(py);
      for (let dy = -rCeil; dy <= rCeil; dy++) {
        for (let dx = -rCeil; dx <= rCeil; dx++) {
          const gx = gx0 + dx;
          const gy = gy0 + dy;
          if (!this.inBounds(gx, gy, 1)) continue;
          const sNode = tileToNode[gy * W + gx];
          if (sNode === -1) continue;
          const d = Math.hypot(gx - px, gy - py);
          if (d <= maxR) {
            addBiEdge(portalNode, sNode, d * 0.9 + rampCost);
          }
        }
      }
    };

    // 2. Add expressway spline sample nodes as two separate one-way carriageways (`mNodesFwd` for +k, `mNodesRev` for -k)
    const mwNodeLists = new Map();
    for (const mw of this.motorways || []) {
      const samples = mw.samples;
      if (!samples || samples.length < 2) continue;
      const mNodesFwd = new Int32Array(samples.length);
      const mNodesRev = new Int32Array(samples.length);
      for (let k = 0; k < samples.length; k++) {
        const pt = samples[k];
        const inTunnel = Boolean(
          mw.tunnels && mw.tunnels.some((tun) => k >= tun.i0 && k <= tun.i1),
        );
        mNodesFwd[k] = addNode(pt.x, pt.y, true, inTunnel, false, false);
        mNodesRev[k] = addNode(pt.x, pt.y, true, inTunnel, false, false);
        if (k > 0) {
          const prevPt = samples[k - 1];
          const segDist = Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y) || 0.5;
          addEdge(mNodesFwd[k - 1], mNodesFwd[k], segDist * 0.38);
          addEdge(mNodesRev[k], mNodesRev[k - 1], segDist * 0.38);
        }
      }
      mwNodeLists.set(mw.number, { mw, mNodesFwd, mNodesRev });

      // Connect terminal roundabout endpoints (`k = 0` and `k = last`) to surface roads
      const startPortal = addNode(mw.sx, mw.sy, false, false, false, true);
      addEdge(startPortal, mNodesFwd[0], 0.65);
      addEdge(mNodesRev[0], startPortal, 0.65);
      connectToNearbySurfaceNodes(startPortal, mw.sx, mw.sy, 2.4, 0.75);

      const endPortal = addNode(mw.ex, mw.ey, false, false, false, true);
      addEdge(mNodesFwd[samples.length - 1], endPortal, 0.65);
      addEdge(endPortal, mNodesRev[samples.length - 1], 0.65);
      connectToNearbySurfaceNodes(endPortal, mw.ex, mw.ey, 2.4, 0.75);
    }

    // 3. Connect intermediate diamond slip-ramps (`diamond-ramp`) and system interchanges (`cloverleaf`, `trumpet`)
    for (const ic of this.interchanges || []) {
      if (ic.type === "diamond-ramp") {
        const entry = mwNodeLists.get(ic.mwayNumber);
        if (!entry) continue;
        const { mNodesFwd, mNodesRev } = entry;
        const posX = Math.round(ic.posTerm?.x ?? ic.termX);
        const posY = Math.round(ic.posTerm?.y ?? ic.termY);
        const negX = Math.round(ic.negTerm?.x ?? ic.oppTermX);
        const negY = Math.round(ic.negTerm?.y ?? ic.oppTermY);

        const posNode = ensureSurfaceNode(posX, posY);
        const negNode = ensureSurfaceNode(negX, negY);
        const underpassMidNode = addNode(
          ic.x,
          ic.y,
          false,
          false,
          false,
          false,
        );
        addBiEdge(
          posNode,
          underpassMidNode,
          Math.hypot(posX - ic.x, posY - ic.y) * 0.92,
        );
        addBiEdge(
          underpassMidNode,
          negNode,
          Math.hypot(negX - ic.x, negY - ic.y) * 0.92,
        );
        connectToNearbySurfaceNodes(posNode, posX, posY, 1.6, 0.25);
        connectToNearbySurfaceNodes(negNode, negX, negY, 1.6, 0.25);

        for (const ramp of ic.ramps || []) {
          const termNode = ramp.sySign === 1 ? posNode : negNode;
          const mCarriageway = ramp.sySign === 1 ? mNodesFwd : mNodesRev;
          const evalRamp = (t) => {
            const mt = 1 - t;
            return {
              x:
                mt * mt * mt * ramp.p0.x +
                3 * mt * mt * t * ramp.p1.x +
                3 * mt * t * t * ramp.p2.x +
                t * t * t * ramp.p3.x,
              y:
                mt * mt * mt * ramp.p0.y +
                3 * mt * mt * t * ramp.p1.y +
                3 * mt * t * t * ramp.p2.y +
                t * t * t * ramp.p3.y,
            };
          };

          const bNodes = [];
          for (const t of [0.22, 0.5, 0.76]) {
            const rPt = evalRamp(t);
            bNodes.push(addNode(rPt.x, rPt.y, true, false, false, false, true));
          }
          const chain = [
            mCarriageway[ramp.kRamp],
            bNodes[0],
            bNodes[1],
            bNodes[2],
            termNode,
          ];
          if (!ramp.isOffRamp) chain.reverse();
          for (let c = 0; c < chain.length - 1; c++) {
            const uN = chain[c];
            const vN = chain[c + 1];
            const segD =
              Math.hypot(
                nodes[vN].x - nodes[uN].x,
                nodes[vN].y - nodes[uN].y,
              ) || 0.4;
            addEdge(uN, vN, segD * 0.55 + 0.1);
          }
        }
      } else if (ic.type === "cloverleaf" || ic.type === "trumpet") {
        const xferNode = addNode(ic.x, ic.y, true, false, false, false);
        for (const { mw, mNodesFwd, mNodesRev } of mwNodeLists.values()) {
          let bestK = -1;
          let bestD = Infinity;
          for (let k = 0; k < mw.samples.length; k++) {
            const d = Math.hypot(
              mw.samples[k].x - ic.x,
              mw.samples[k].y - ic.y,
            );
            if (d < bestD) {
              bestD = d;
              bestK = k;
            }
          }
          if (bestK !== -1 && bestD <= 6.5) {
            addBiEdge(xferNode, mNodesFwd[bestK], bestD * 0.55 + 0.8);
            addBiEdge(xferNode, mNodesRev[bestK], bestD * 0.55 + 0.8);
          }
        }
      }
    }

    // 4. Collect roundabout geometry for right-hand circulatory arc generation
    const roundabouts = [];
    for (const ap of this.airports || []) {
      roundabouts.push({ x: ap.gateX, y: ap.gateY, rTiles: 0.68 });
    }
    for (const ic of this.interchanges || []) {
      if (ic.type === "terminal-stub" && !ic.isAirportStub) {
        roundabouts.push({ x: ic.x, y: ic.y, rTiles: 0.64 });
      } else if (
        ic.type === "diamond-ramp" &&
        !ic.isThroughDiamond &&
        ic.oppTermX !== undefined &&
        ic.oppTermY !== undefined
      ) {
        roundabouts.push({ x: ic.oppTermX, y: ic.oppTermY, rTiles: 0.56 });
      }
    }

    const totalNodes = nodes.length;
    this._vehicleGraph = {
      nodes,
      adj,
      tileToNode,
      numSurfaceNodes,
      roundabouts,
      gScore: new Float64Array(totalNodes),
      parent: new Int32Array(totalNodes),
      seenGen: new Int32Array(totalNodes),
      closedGen: new Int32Array(totalNodes),
      gen: 0,
    };
    return this._vehicleGraph;
  }

  /**
   * Dedicated On-Network Multi-Modal Vehicle A* (`findVehicleNetworkPath`):
   * Routes strictly over committed surface road edges and grade-separated expressways
   * with realistic travel-time weights (`0.38x` expressway, `1.0x` arterial, `1.35x` local street)
   * and light intersection turn costs (`+0.30` for 45°, `+0.55` for 90°).
   */
  findVehicleNetworkPath(sx, sy, ex, ey) {
    const graph = this.ensureVehicleRoutingGraph();
    const {
      nodes,
      adj,
      tileToNode,
      numSurfaceNodes,
      gScore,
      parent,
      seenGen,
      closedGen,
    } = graph;
    if (numSurfaceNodes < 2) return null;
    const { W } = this;

    const findNearestSurfaceNode = (px, py) => {
      const gx0 = Math.round(px);
      const gy0 = Math.round(py);
      if (this.inBounds(gx0, gy0, 1)) {
        const direct = tileToNode[gy0 * W + gx0];
        if (direct !== -1) return direct;
      }
      let best = -1;
      let bestD = Infinity;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const gx = gx0 + dx;
          const gy = gy0 + dy;
          if (!this.inBounds(gx, gy, 1)) continue;
          const nid = tileToNode[gy * W + gx];
          if (nid !== -1) {
            const d = Math.hypot(gx - px, gy - py);
            if (d < bestD) {
              bestD = d;
              best = nid;
            }
          }
        }
      }
      return best;
    };

    const startNode = findNearestSurfaceNode(sx, sy);
    const endNode = findNearestSurfaceNode(ex, ey);
    if (startNode === -1 || endNode === -1 || startNode === endNode)
      return null;

    const gen = ++graph.gen;
    const endX = nodes[endNode].x;
    const endY = nodes[endNode].y;

    const heapId = [startNode];
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
    const heapPop = () => {
      const top = heapId[0];
      const lastId = heapId.pop();
      const lastF = heapF.pop();
      if (heapId.length > 0) {
        let i = 0;
        const len = heapId.length;
        while ((i << 1) + 1 < len) {
          let c = (i << 1) + 1;
          if (c + 1 < len && heapF[c + 1] < heapF[c]) c++;
          if (lastF <= heapF[c]) break;
          heapId[i] = heapId[c];
          heapF[i] = heapF[c];
          i = c;
        }
        heapId[i] = lastId;
        heapF[i] = lastF;
      }
      return top;
    };

    seenGen[startNode] = gen;
    gScore[startNode] = 0;
    parent[startNode] = -1;

    while (heapId.length > 0) {
      const u = heapPop();
      if (u === endNode) {
        const out = [];
        let cur = u;
        while (cur !== -1) {
          const n = nodes[cur];
          out.push({
            x: n.x,
            y: n.y,
            onMotorway: n.onMotorway,
            inTunnel: n.inTunnel,
            isStreet: n.isStreet,
            isRoundabout: n.isRoundabout,
            isSlipRamp: n.isSlipRamp,
          });
          cur = parent[cur];
        }
        return out.reverse();
      }

      if (closedGen[u] === gen) continue;
      closedGen[u] = gen;

      const nu = nodes[u];
      const pu = parent[u];
      const prevDx = pu !== -1 ? nu.x - nodes[pu].x : 0;
      const prevDy = pu !== -1 ? nu.y - nodes[pu].y : 0;

      const edges = adj[u];
      for (let i = 0; i < edges.length; i++) {
        const { to: v, cost: baseCost } = edges[i];
        if (closedGen[v] === gen) continue;
        const nv = nodes[v];
        let stepCost = baseCost;

        if (pu !== -1 && !nu.onMotorway && !nv.onMotorway) {
          const dx = nv.x - nu.x;
          const dy = nv.y - nu.y;
          if (dx !== prevDx || dy !== prevDy) {
            const dot = dx * prevDx + dy * prevDy;
            stepCost += dot > 0 ? 0.3 : dot === 0 ? 0.55 : 3.5;
          }
        }

        const tentativeG = gScore[u] + stepCost;
        if (seenGen[v] !== gen || tentativeG < gScore[v]) {
          seenGen[v] = gen;
          gScore[v] = tentativeG;
          parent[v] = u;
          const h = Math.hypot(endX - nv.x, endY - nv.y) * 0.36;
          heapPush(v, tentativeG + h);
        }
      }
    }
    return null;
  }

  /**
   * Directly models a directed right-hand vehicle lane trajectory (`pts`, `cumLen`, `totalLength`)
   * from `srcPt` to `dstPt` along `rawPath`, embedding driveway pull-out/in, counter-clockwise
   * roundabout circulatory arcs, quadratic corner fillets, and right-hand carriageway lanes.
   */
  buildDirectedLaneTrajectory(srcPt, dstPt, rawPath) {
    if (!rawPath || rawPath.length < 2) return null;
    const graph = this.ensureVehicleRoutingGraph();
    const roundabouts = graph.roundabouts || [];

    // 1. Build centerline spine with origin/destination driveways and right-hand roundabout arcs
    const spine = [];
    const pushSpinePt = (pt) => {
      if (spine.length > 0) {
        const last = spine[spine.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) < 0.04) return;
      }
      spine.push(pt);
    };

    if (
      srcPt &&
      Math.hypot(srcPt.x - rawPath[0].x, srcPt.y - rawPath[0].y) > 0.2
    ) {
      pushSpinePt({
        x: rawPath[0].x + (srcPt.x - rawPath[0].x) * 0.52,
        y: rawPath[0].y + (srcPt.y - rawPath[0].y) * 0.52,
        onMotorway: false,
        inTunnel: false,
        isStreet: true,
        isDriveway: true,
      });
    }

    for (let i = 0; i < rawPath.length; i++) {
      const pt = rawPath[i];
      let matchedRb = null;
      if (i > 0 && i < rawPath.length - 1) {
        for (let r = 0; r < roundabouts.length; r++) {
          const rb = roundabouts[r];
          if (Math.hypot(pt.x - rb.x, pt.y - rb.y) <= rb.rTiles * 1.18) {
            matchedRb = rb;
            break;
          }
        }
      }

      if (matchedRb) {
        let j = i;
        while (
          j + 1 < rawPath.length - 1 &&
          Math.hypot(
            rawPath[j + 1].x - matchedRb.x,
            rawPath[j + 1].y - matchedRb.y,
          ) <=
            matchedRb.rTiles * 1.18
        ) {
          j++;
        }
        const pIn = spine.length > 0 ? spine[spine.length - 1] : rawPath[i - 1];
        const pOut = rawPath[Math.min(rawPath.length - 1, j + 1)];
        const thetaIn = Math.atan2(pIn.y - matchedRb.y, pIn.x - matchedRb.x);
        const thetaOut = Math.atan2(pOut.y - matchedRb.y, pOut.x - matchedRb.x);
        const thetaStart = thetaIn - 0.18;
        const thetaEnd = thetaOut + 0.18;
        let sweep =
          (((thetaStart - thetaEnd) % (Math.PI * 2)) + Math.PI * 2) %
          (Math.PI * 2);
        if (sweep < 0.22) sweep = 0.22;
        if (sweep > Math.PI * 1.82) sweep = Math.PI * 0.45;
        const arcSteps = Math.max(3, Math.ceil(sweep / 0.42));
        for (let s = 0; s <= arcSteps; s++) {
          const ang = thetaStart - sweep * (s / arcSteps);
          pushSpinePt({
            x: matchedRb.x + Math.cos(ang) * matchedRb.rTiles,
            y: matchedRb.y + Math.sin(ang) * matchedRb.rTiles,
            onMotorway: false,
            inTunnel: false,
            isStreet: false,
            isRoundaboutArc: true,
          });
        }
        i = j;
      } else {
        pushSpinePt({ ...pt });
      }
    }

    const lastRaw = rawPath[rawPath.length - 1];
    if (dstPt && Math.hypot(dstPt.x - lastRaw.x, dstPt.y - lastRaw.y) > 0.2) {
      pushSpinePt({
        x: lastRaw.x + (dstPt.x - lastRaw.x) * 0.52,
        y: lastRaw.y + (dstPt.y - lastRaw.y) * 0.52,
        onMotorway: false,
        inTunnel: false,
        isStreet: true,
        isDriveway: true,
      });
    }

    if (spine.length < 2) return null;

    // 2. Shift spine vertices into their directed right-hand travel lane (`(-ty, tx)`)
    const shifted = Array.from({ length: spine.length });
    for (let i = 0; i < spine.length; i++) {
      const p = spine[i];
      let tx = 0,
        ty = 0;
      if (i > 0) {
        const dx0 = p.x - spine[i - 1].x;
        const dy0 = p.y - spine[i - 1].y;
        const l0 = Math.hypot(dx0, dy0) || 1;
        tx += dx0 / l0;
        ty += dy0 / l0;
      }
      if (i + 1 < spine.length) {
        const dx1 = spine[i + 1].x - p.x;
        const dy1 = spine[i + 1].y - p.y;
        const l1 = Math.hypot(dx1, dy1) || 1;
        tx += dx1 / l1;
        ty += dy1 / l1;
      }
      const tLen = Math.hypot(tx, ty) || 1;
      tx /= tLen;
      ty /= tLen;
      const rx = -ty;
      const ry = tx;

      let laneOff = 0.13;
      if (p.isRoundaboutArc) laneOff = 0.0;
      else if (p.isSlipRamp) laneOff = 0.04;
      else if (p.isDriveway) laneOff = 0.06;
      else if (p.onMotorway) laneOff = 0.18;

      shifted[i] = {
        ...p,
        x: p.x + rx * laneOff,
        y: p.y + ry * laneOff,
      };
    }

    // 3. Fillet surface road turns with quadratic Bezier samples so the path curve is smooth
    const pts = [shifted[0]];
    for (let i = 1; i < shifted.length - 1; i++) {
      const pPrev = shifted[i - 1];
      const pCurr = shifted[i];
      const pNext = shifted[i + 1];
      if (pCurr.onMotorway || pCurr.isRoundaboutArc) {
        pts.push(pCurr);
        continue;
      }
      const dx0 = pCurr.x - pPrev.x;
      const dy0 = pCurr.y - pPrev.y;
      const dx1 = pNext.x - pCurr.x;
      const dy1 = pNext.y - pCurr.y;
      const l0 = Math.hypot(dx0, dy0) || 1;
      const l1 = Math.hypot(dx1, dy1) || 1;
      const cross = Math.abs((dx0 / l0) * (dy1 / l1) - (dy0 / l0) * (dx1 / l1));
      if (cross > 0.08) {
        const r = Math.min(0.24, l0 * 0.42, l1 * 0.42);
        const ax = pCurr.x - (dx0 / l0) * r;
        const ay = pCurr.y - (dy0 / l0) * r;
        const cx = pCurr.x + (dx1 / l1) * r;
        const cy = pCurr.y + (dy1 / l1) * r;
        for (const t of [0.15, 0.5, 0.85]) {
          const mt = 1 - t;
          pts.push({
            ...pCurr,
            x: mt * mt * ax + 2 * mt * t * pCurr.x + t * t * cx,
            y: mt * mt * ay + 2 * mt * t * pCurr.y + t * t * cy,
          });
        }
      } else {
        pts.push(pCurr);
      }
    }
    pts.push(shifted[shifted.length - 1]);

    // 4. Precompute cumulative arc-length parameterization
    const cumLen = new Float32Array(pts.length);
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      cumLen[i] = acc;
    }

    return {
      pts,
      cumLen,
      totalLength: Math.max(0.01, acc),
    };
  }

  /**
   * Builds Origin-to-Destination Commuter Routes (`this.commuterRoutes`) between
   * residential houses (`this.houses`) and Commercial/Industrial/Airport sinks
   * across both local streets and regional expressways.
   */
  buildCommuterRoutes() {
    this.commuterRoutes = [];
    if (
      !this.houses ||
      this.houses.length === 0 ||
      !this.destinations ||
      this.destinations.length === 0
    ) {
      return;
    }

    const targetRoutes = Math.min(
      130,
      Math.max(60, Math.round(this.houses.length * 0.35)),
    );
    const step = Math.max(1, Math.floor(this.houses.length / targetRoutes));

    for (
      let i = 0;
      i < this.houses.length && this.commuterRoutes.length < targetRoutes;
      i += step
    ) {
      const h = this.houses[i];
      const hx = Math.round(h.roadX ?? h.x);
      const hy = Math.round(h.roadY ?? h.y);
      const wantRegional =
        this.commuterRoutes.length % 3 === 0 && this.motorways.length > 0;

      // Pick best matching destination (same color or regional expressway partner)
      let bestDst = null;
      let bestScore = Infinity;
      for (let j = 0; j < this.destinations.length; j++) {
        const d =
          this.destinations[(i * 7 + j * 13) % this.destinations.length];
        const crowD = Math.hypot(d.x - h.x, d.y - h.y);
        if (crowD < 3.5) continue;
        if (wantRegional && crowD < 34) continue;
        if (!wantRegional && crowD > 68) continue;
        const sameColor = d.colorIdx === h.colorIdx ? -14 : 0;
        const score = (wantRegional ? Math.abs(crowD - 62) : crowD) + sameColor;
        if (score < bestScore) {
          bestScore = score;
          bestDst = d;
          if (!wantRegional && sameColor < 0 && crowD <= 28) break;
        }
      }
      if (!bestDst) continue;

      const dx = Math.round(bestDst.roadX ?? bestDst.x);
      const dy = Math.round(bestDst.roadY ?? bestDst.y);
      const rawPath = this.findVehicleNetworkPath(hx, hy, dx, dy);
      if (!rawPath || rawPath.length < 2) continue;

      const outboundTrack = this.buildDirectedLaneTrajectory(
        h,
        bestDst,
        rawPath,
      );
      const inboundTrack = this.buildDirectedLaneTrajectory(
        bestDst,
        h,
        [...rawPath].reverse(),
      );
      if (!outboundTrack || !inboundTrack) continue;

      this.commuterRoutes.push({
        color:
          h.palette?.roof ||
          PALETTE.districtColors[
            Math.max(0, h.colorIdx || 0) % PALETTE.districtColors.length
          ].roof,
        usesMotorway: rawPath.some((p) => p.onMotorway),
        outboundTrack,
        inboundTrack,
      });
    }
  }

  /**
   * STAGE 8B: INTER-INDUSTRIAL CARGO SUPPLY CHAIN (`RAW -> MFG -> LOG -> COM`)
   * Links Primary Extraction (`RAW`), Secondary Manufacturing (`MFG`), Wholesale Logistics (`LOG`),
   * and CBD/Arterial Commercial Sinks (`COM`) into an active road-routed regional freight network.
   */
  buildIndustrialCargoChain() {
    this._vehicleGraph = null;
    this.cargoLinks = [];
    const rawNodes = this.destinations.filter(
      (d) => d.zoneType === "industrial" && d.subType === "RAW",
    );
    const mfgNodes = this.destinations.filter(
      (d) => d.zoneType === "industrial" && d.subType === "MFG",
    );
    const logNodes = this.destinations.filter(
      (d) => d.zoneType === "industrial" && d.subType === "LOG",
    );
    const comNodes = this.destinations.filter(
      (d) => d.zoneType === "commercial",
    );

    const tryAddFreightLink = (
      src,
      dst,
      stage,
      label,
      color,
      maxCrowDist = 115,
    ) => {
      const crowD = Math.hypot(dst.x - src.x, dst.y - src.y);
      if (crowD < 2.5 || crowD > maxCrowDist) return false;
      const sx = Math.round(src.roadX || src.x);
      const sy = Math.round(src.roadY || src.y);
      const ex = Math.round(dst.roadX || dst.x);
      const ey = Math.round(dst.roadY || dst.y);
      // Route freight trucks across the unified surface + expressway vehicle network!
      const roadPath = this.findVehicleNetworkPath(sx, sy, ex, ey);
      if (!roadPath || roadPath.length < 2) return false;
      let pathArcLen = 0;
      for (let i = 1; i < roadPath.length; i++) {
        pathArcLen += Math.hypot(
          roadPath[i].x - roadPath[i - 1].x,
          roadPath[i].y - roadPath[i - 1].y,
        );
      }
      if (pathArcLen > crowD * 3.4 + 35) return false;

      const outboundTrack = this.buildDirectedLaneTrajectory(
        src,
        dst,
        roadPath,
      );
      const inboundTrack = this.buildDirectedLaneTrajectory(
        dst,
        src,
        [...roadPath].reverse(),
      );

      this.cargoLinks.push({
        from: src,
        to: dst,
        stage, // 'RAW->MFG' | 'MFG->LOG' | 'MFG->COM' | 'LOG->COM'
        label,
        color,
        points: roadPath,
        usesMotorway: roadPath.some((p) => p.onMotorway),
        outboundTrack,
        inboundTrack,
      });
      return true;
    };

    // 1. Stage 1: Raw Materials (`RAW`) -> Nearest Road-Connected Manufacturing Plant (`MFG`)
    const rankByLandmassAndDist = (src, list) =>
      [...list]
        .filter((item) => item.id !== src.id)
        .sort((a, b) => {
          const sameA =
            this.towns[a.townId]?.landmassId ===
            this.towns[src.townId]?.landmassId
              ? 0
              : 90;
          const sameB =
            this.towns[b.townId]?.landmassId ===
            this.towns[src.townId]?.landmassId
              ? 0
              : 90;
          return (
            Math.hypot(a.x - src.x, a.y - src.y) +
            sameA -
            (Math.hypot(b.x - src.x, b.y - src.y) + sameB)
          );
        });

    const rankComTargets = (src) =>
      [...comNodes].sort((a, b) => {
        const bonusA =
          (a.isCircular ? -16 : 0) - (a.wTiles || 2) * (a.hTiles || 2);
        const bonusB =
          (b.isCircular ? -16 : 0) - (b.wTiles || 2) * (b.hTiles || 2);
        return (
          Math.hypot(a.x - src.x, a.y - src.y) +
          bonusA -
          (Math.hypot(b.x - src.x, b.y - src.y) + bonusB)
        );
      });

    for (const raw of rawNodes) {
      const candidates = rankByLandmassAndDist(raw, mfgNodes).slice(0, 4);
      let linked = false;
      for (const mfg of candidates) {
        if (
          tryAddFreightLink(
            raw,
            mfg,
            "RAW->MFG",
            "Raw Materials → Factory",
            "#d97706",
            120,
          )
        ) {
          linked = true;
          break;
        }
      }
      // Fallback for isolated rural/island RAW extractors: ship bulk materials to nearest LOG hub
      if (!linked) {
        for (const lg of rankByLandmassAndDist(raw, logNodes).slice(0, 3)) {
          if (
            tryAddFreightLink(
              raw,
              lg,
              "RAW->LOG",
              "Bulk Feedstock → Logistics Hub",
              "#d97706",
              110,
            )
          ) {
            break;
          }
        }
      }
    }

    // Backfill Stage 1: Ensure every MFG factory has at least 1 inbound RAW supplier!
    for (const mfg of mfgNodes) {
      if (this.cargoLinks.some((l) => l.to.id === mfg.id)) continue;
      for (const raw of rankByLandmassAndDist(mfg, rawNodes).slice(0, 5)) {
        if (
          tryAddFreightLink(
            raw,
            mfg,
            "RAW->MFG",
            "Raw Materials → Factory",
            "#d97706",
            140,
          )
        ) {
          break;
        }
      }
    }

    // 2. Stage 2: Manufacturing (`MFG`) -> Nearest Logistics Hub (`LOG`) or Local Commercial CBD (`COM`)
    for (const mfg of mfgNodes) {
      let linkedToLog = false;
      const logCands = rankByLandmassAndDist(mfg, logNodes).slice(0, 3);
      for (const lg of logCands) {
        if (
          tryAddFreightLink(
            mfg,
            lg,
            "MFG->LOG",
            "Factory Output → Distribution Hub",
            "#ea580c",
            85,
          )
        ) {
          linkedToLog = true;
          break;
        }
      }

      // Also supply the flagship Commercial CBD sink in the factory's town (or nearest town)
      const comCands = rankComTargets(mfg).slice(0, linkedToLog ? 2 : 3);
      for (const com of comCands) {
        if (
          tryAddFreightLink(
            mfg,
            com,
            "MFG->COM",
            "Wholesale Goods → Commercial CBD",
            "#2563eb",
            65,
          )
        ) {
          break;
        }
      }
    }

    // Backfill Stage 2: Ensure every LOG warehouse has at least 1 inbound MFG (or RAW) supplier!
    for (const lg of logNodes) {
      if (this.cargoLinks.some((l) => l.to.id === lg.id)) continue;
      for (const mfg of rankByLandmassAndDist(lg, mfgNodes).slice(0, 5)) {
        if (
          tryAddFreightLink(
            mfg,
            lg,
            "MFG->LOG",
            "Factory Output → Distribution Hub",
            "#ea580c",
            120,
          )
        ) {
          break;
        }
      }
    }

    // 3. Stage 3: Logistics Warehouses (`LOG`) -> High-Demand Commercial CBD Sinks (`COM`) (local + inter-town regional)
    for (const lg of logNodes) {
      const nearComs = rankComTargets(lg).slice(0, 4);
      let count = 0;
      for (const com of nearComs) {
        if (
          tryAddFreightLink(
            lg,
            com,
            "LOG->COM",
            "Last-Mile Freight → Commercial Sink",
            "#7c3aed",
            65,
          )
        ) {
          count++;
          if (count >= 2) break;
        }
      }
      // Regional inter-town wholesale corridor (`com.townId !== lg.townId`) across expressways/arterials
      const regionalComs = rankComTargets(lg)
        .filter(
          (c) =>
            c.townId !== lg.townId && Math.hypot(c.x - lg.x, c.y - lg.y) >= 30,
        )
        .slice(0, 4);
      for (const rCom of regionalComs) {
        if (
          tryAddFreightLink(
            lg,
            rCom,
            "LOG->COM",
            "Regional Wholesale → Metro CBD",
            "#7c3aed",
            135,
          )
        ) {
          break;
        }
      }
    }

    this.logs.push(
      `Zoned <b>${comNodes.length} Commercial</b> (CBD/Arterial) & <b>${rawNodes.length + mfgNodes.length + logNodes.length} Industrial</b> (${rawNodes.length} Raw, ${mfgNodes.length} Mfg, ${logNodes.length} Log) with <b>${this.cargoLinks.length} road freight chains</b>.`,
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
        if (
          this.inBounds(gx, gy, 1) &&
          this.buildingMask[this.idx(gx, gy)] !== 3
        ) {
          this.buildingMask[this.idx(gx, gy)] = 4;
        }
      }
    }

    const beforeHouses = this.houses.length;
    this.houses = this.houses.filter((h) => {
      const keep = (h.x - cx) * (h.x - cx) + (h.y - cy) * (h.y - cy) > r2;
      if (!keep) {
        const hid = this.idx(h.x, h.y);
        if (this.buildingMask[hid] === 1) this.buildingMask[hid] = 4;
        const t = this.towns[h.townId];
        if (t && t.housesCount > 0) t.housesCount--;
      }
      return keep;
    });

    const beforeDest = this.destinations.length;
    this.destinations = this.destinations.filter((d) => {
      const keep =
        (d.x - cx) * (d.x - cx) + (d.y - cy) * (d.y - cy) >
        (radius + 1.2) * (radius + 1.2);
      if (!keep) {
        for (let dy = 0; dy < (d.hTiles || 1); dy++) {
          for (let dx = 0; dx < (d.wTiles || 1); dx++) {
            const did = this.idx(d.gx + dx, d.gy + dy);
            if (this.buildingMask[did] === 2) this.buildingMask[did] = 4;
          }
        }
        const t = this.towns[d.townId];
        if (t) {
          if (t.destinationsCount > 0) t.destinationsCount--;
          if (d.zoneType === "commercial" && t.commercialCount > 0)
            t.commercialCount--;
          if (d.zoneType === "industrial" && t.industrialCount > 0)
            t.industrialCount--;
        }
      }
      return keep;
    });

    this.trees = this.trees.filter(
      (tr) => (tr.x - cx) * (tr.x - cx) + (tr.y - cy) * (tr.y - cy) > r2,
    );
    this.displacedBuildingsCount +=
      beforeHouses -
      this.houses.length +
      (beforeDest - this.destinations.length);
  }

  findPassThroughStubAtTown(town, towardX, towardY) {
    const baseAngle = Math.atan2(towardY - town.y, towardX - town.x);
    return (
      this.interchanges.find((ic) => {
        if (
          ic.type !== "terminal-stub" ||
          ic.isAirportStub ||
          ic.townId !== town.id
        )
          return false;
        const attachedCount = this.motorways.filter(
          (m) =>
            (Math.hypot(m.sx - ic.x, m.sy - ic.y) < 1.5 && !m.prunedStart) ||
            (Math.hypot(m.ex - ic.x, m.ey - ic.y) < 1.5 && !m.prunedEnd),
        ).length;
        if (attachedCount >= 2) return false;
        const angDiff = Math.abs(
          Math.atan2(
            Math.sin(ic.angleRad - baseAngle),
            Math.cos(ic.angleRad - baseAngle),
          ),
        );
        return angDiff >= 2.05; // Require >= 117° wide pass-through angle (never an acute V-point!)
      }) || null
    );
  }

  createTerminalStreetStub(townOrAirport, isAirport, towardX, towardY) {
    if (isAirport) {
      const ap = townOrAirport;
      this.displaceBuildingsInRadius(ap.gateX, ap.gateY, 3.2);
      const stubAngle = Math.atan2(ap.landNy, ap.landNx);
      const existing = this.interchanges.find(
        (ic) =>
          ic.type === "terminal-stub" &&
          ic.isAirportStub &&
          ic.x === ap.gateX &&
          ic.y === ap.gateY,
      );
      if (!existing) {
        this.interchanges.push({
          type: "terminal-stub",
          isAirportStub: true,
          airportId: ap.id,
          x: ap.gateX,
          y: ap.gateY,
          stubEndX: ap.curbX,
          stubEndY: ap.curbY,
          angleRad: stubAngle,
          label: `${ap.iata} Terminal Interchange`,
        });
      }
      return { x: ap.gateX, y: ap.gateY };
    }

    const town = townOrAirport;
    const baseAngle = Math.atan2(towardY - town.y, towardX - town.x);

    // Share an existing town terminal-stub when the new corridor arrives at a wide pass-through
    // angle (>= 100° apart) so the two motorways form a connected beltway hub rather than
    // spawning two disconnected roundabouts in the same town.
    const existingPassThrough = this.findPassThroughStubAtTown(
      town,
      towardX,
      towardY,
    );
    if (existingPassThrough) {
      return { x: existingPassThrough.x, y: existingPassThrough.y };
    }

    const dist = Math.hypot(towardX - town.x, towardY - town.y) || 1;
    const baseRadius = Math.min(
      town.urbanRadius * 0.65,
      Math.max(5.5, dist * 0.34),
    );
    const angleOffsets = [
      0, 0.28, -0.28, 0.55, -0.55, 0.85, -0.85, 1.15, -1.15, 1.45, -1.45,
    ];
    const radiusScales = [1.0, 0.84, 1.16];

    let chosenAx = town.x;
    let chosenAy = town.y;
    let chosenTiePath = null;
    let chosenAngle = baseAngle;
    let bestStubCost = Infinity;

    for (const rScale of radiusScales) {
      for (const aOff of angleOffsets) {
        const ang = baseAngle + aOff;
        const r = baseRadius * rScale;
        const candX = Math.max(
          7,
          Math.min(this.W - 8, Math.round(town.x + Math.cos(ang) * r)),
        );
        const candY = Math.max(
          7,
          Math.min(this.H - 8, Math.round(town.y + Math.sin(ang) * r)),
        );
        const cid = this.idx(candX, candY);

        if (this.waterMask[cid] > 0 || this.distToWater[cid] < 3.2) continue;
        if (this.buildingMask[cid] >= 1 && this.buildingMask[cid] <= 3)
          continue;
        if (this.isPointInAirportPad(candX, candY, 2.5)) continue;

        const tooCloseStub = this.interchanges.some(
          (ic) => Math.hypot(ic.x - candX, ic.y - candY) < 11.0,
        );
        if (tooCloseStub) continue;

        // Never plant a terminal roundabout on or near the shoulder of an existing motorway (`HARBOR-305` invariant)!
        const tooCloseMotorway = this.motorways.some((mw) =>
          mw.samples.some(
            (pt) => Math.hypot(pt.x - candX, pt.y - candY) < 15.0,
          ),
        );
        if (tooCloseMotorway) continue;

        const hAbove = Math.max(0, this.elevationField[cid] - this.seaLevel);
        const stubCost =
          Math.abs(aOff) * 0.45 +
          Math.abs(rScale - 1.0) * 1.2 +
          hAbove * 28.0 +
          this.slopeField[cid] * 14.0;
        if (stubCost >= bestStubCost) continue;

        const tiePath = this.findRoadPathAStar(
          candX,
          candY,
          town.x,
          town.y,
          false,
          null,
          true,
        );
        if (tiePath && tiePath.length >= 2) {
          bestStubCost = stubCost;
          chosenAx = candX;
          chosenAy = candY;
          chosenTiePath = tiePath;
          chosenAngle = ang;
        }
      }
    }

    if (!chosenTiePath) {
      for (const rScale of [0.7, 1.0, 1.3]) {
        for (const aOff of angleOffsets) {
          const ang = baseAngle + aOff;
          const r = baseRadius * rScale;
          const candX = Math.max(
            5,
            Math.min(this.W - 6, Math.round(town.x + Math.cos(ang) * r)),
          );
          const candY = Math.max(
            5,
            Math.min(this.H - 6, Math.round(town.y + Math.sin(ang) * r)),
          );
          const cid = this.idx(candX, candY);
          if (this.waterMask[cid] > 0 || this.distToWater[cid] < 2.2) continue;
          if (this.buildingMask[cid] >= 1 && this.buildingMask[cid] <= 3)
            continue;
          if (this.isPointInAirportPad(candX, candY, 2.2)) continue;
          const tooCloseMotorway = this.motorways.some((mw) =>
            mw.samples.some(
              (pt) => Math.hypot(pt.x - candX, pt.y - candY) < 13.5,
            ),
          );
          if (tooCloseMotorway) continue;
          const tiePath = this.findRoadPathAStar(
            candX,
            candY,
            town.x,
            town.y,
            true,
            null,
            true,
          );
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
    }
    this.displaceBuildingsInRadius(chosenAx, chosenAy, 3.0);
    if (chosenTiePath && chosenTiePath.length >= 2) {
      this.commitRoadPath(chosenTiePath, "arterial", {
        stubOriginX: chosenAx,
        stubOriginY: chosenAy,
      });
    }

    const secondPt =
      chosenTiePath && chosenTiePath.length > 1
        ? chosenTiePath[1]
        : { x: town.x, y: town.y };
    this.interchanges.push({
      type: "terminal-stub",
      isAirportStub: false,
      townId: town.id,
      x: chosenAx,
      y: chosenAy,
      stubEndX: secondPt.x,
      stubEndY: secondPt.y,
      angleRad: chosenAngle,
      label: `${town.name} Beltway Stub`,
    });

    return { x: chosenAx, y: chosenAy };
  }

  findRingInterchangePoint(town, towardX, towardY) {
    return this.createTerminalStreetStub(town, false, towardX, towardY);
  }

  isCloverleafFootprintDry(
    x,
    y,
    angleA,
    angleB,
    signsA = [-1, 1],
    signsB = [-1, 1],
  ) {
    const gx = Math.round(x);
    const gy = Math.round(y);
    if (!this.inBounds(gx, gy, 6)) return false;
    const cid = this.idx(gx, gy);
    if (this.waterMask[cid] > 0 || this.distToWater[cid] < 2.6) return false;
    if (this.isPointInAirportPad(x, y, 3.4)) return false;

    const uAx = Math.cos(angleA),
      uAy = Math.sin(angleA);
    const uBx = Math.cos(angleB),
      uBy = Math.sin(angleB);

    for (const sA of signsA) {
      for (const sB of signsB) {
        const rAx = sA * uAx,
          rAy = sA * uAy;
        const rBx = sB * uBx,
          rBy = sB * uBy;
        const checkPts = [
          { px: x + rAx * 2.8, py: y + rAy * 2.8 },
          { px: x + rBx * 2.8, py: y + rBy * 2.8 },
          { px: x + (rAx + rBx) * 1.85, py: y + (rAy + rBy) * 1.85 },
        ];
        for (const { px, py } of checkPts) {
          const rx = Math.round(px);
          const ry = Math.round(py);
          if (!this.inBounds(rx, ry, 4)) return false;
          const rid = this.idx(rx, ry);
          if (this.waterMask[rid] > 0 || this.distToWater[rid] < 1.5)
            return false;
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
    // Never place a Trumpet interchange inside a town's dense core (`< urbanRadius * 0.85`)
    for (const t of this.towns) {
      if (Math.hypot(x - t.x, y - t.y) < t.urbanRadius * 0.85) return false;
    }

    const ux = Math.cos(angleMain),
      uy = Math.sin(angleMain);
    const nx = -uy * sideSign,
      ny = ux * sideSign;

    // Check both the directional slip-ramps on the terminating highway side (+sideSign),
    // the spur approach throat (+4.2..+5.8), the mainline ramp merge toes (±3.4),
    // AND the 270° trumpet loop on the OPPOSITE side (-sideSign).
    const localPts = [
      [-3.4, 0],
      [3.4, 0],
      [-2.8, 0.4],
      [2.8, 0.4],
      [0, 2.8],
      [0, 4.2],
      [0, 5.8],
      [-1.8, 3.4],
      [1.8, 3.4],
      [-1.4, 1.5],
      [1.4, 1.5],
      [0, -2.2],
      [1.8, -1.8],
      [2.2, -1.0],
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

  /**
   * Computes a soft siting penalty when a candidate Cloverleaf or Trumpet interchange footprint
   * overlaps existing surface roads, bridges, or buildings, steering interchanges into open pockets
   * beside arterials when available.
   */
  interchangeRoadOverlapCost(cx, cy, radius = 4.2) {
    const rCeil = Math.ceil(radius);
    const r2 = radius * radius;
    let cost = 0;
    for (let dy = -rCeil; dy <= rCeil; dy++) {
      for (let dx = -rCeil; dx <= rCeil; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const gx = Math.round(cx + dx);
        const gy = Math.round(cy + dy);
        if (!this.inBounds(gx, gy, 1)) continue;
        const id = this.idx(gx, gy);
        const rg = this.roadGrid[id];
        if (rg === 3) cost += 35.0;
        else if (rg === 2) cost += 4.5;
        else if (rg === 1) cost += 2.2;
        const bm = this.buildingMask[id];
        if (bm === 1 || bm === 2) cost += 3.0;
      }
    }
    return cost;
  }

  scoreMotorwaySamples(
    samples,
    sx,
    sy,
    ex,
    ey,
    airportId = null,
    preferOff = 0,
    candidateOff = 0,
    forbidAnyCrossing = false,
    allowTouchTrunkNum = null,
  ) {
    if (!samples || samples.length < 2) return Infinity;
    const chord = Math.hypot(ex - sx, ey - sy) || 1;
    if (chord < 16) return Infinity;

    // Hard invariant 1: Never go out of bounds
    for (const pt of samples) {
      if (!this.inBounds(Math.round(pt.x), Math.round(pt.y), 4))
        return Infinity;
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
    if (arcLen < 22 || arcLen / chord > 1.85) return Infinity;

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

      if (
        !checkShared(
          sx,
          sy,
          startDirX / startLen,
          startDirY / startLen,
          other.sx,
          other.sy,
          oStartDirX / oStartLen,
          oStartDirY / oStartLen,
        )
      )
        return Infinity;
      if (
        !checkShared(
          sx,
          sy,
          startDirX / startLen,
          startDirY / startLen,
          other.ex,
          other.ey,
          oEndDirX / oEndLen,
          oEndDirY / oEndLen,
        )
      )
        return Infinity;
      if (
        !checkShared(
          ex,
          ey,
          endDirX / endLen,
          endDirY / endLen,
          other.sx,
          other.sy,
          oStartDirX / oStartLen,
          oStartDirY / oStartLen,
        )
      )
        return Infinity;
      if (
        !checkShared(
          ex,
          ey,
          endDirX / endLen,
          endDirY / endLen,
          other.ex,
          other.ey,
          oEndDirX / oEndLen,
          oEndDirY / oEndLen,
        )
      )
        return Infinity;

      // Hard invariant 5: Prevent parallel duplicate corridors & check interior crossings
      const candAng = Math.atan2(ey - sy, ex - sx);
      const otherAng = Math.atan2(other.ey - other.sy, other.ex - other.sx);
      const chordSinDiff = Math.abs(Math.sin(candAng - otherAng));
      const midCand = samples[Math.floor(samples.length * 0.5)];
      const midOther = oS[Math.floor(oS.length * 0.5)];
      if (
        chordSinDiff < 0.55 &&
        Math.hypot(midCand.x - midOther.x, midCand.y - midOther.y) < 48
      ) {
        return Infinity; // Reject parallel duplicate motorways in the same corridor
      }

      const hit = this.findPolylineIntersection(other.samples, samples);
      if (hit) {
        if (hit.multiple) return Infinity; // Never allow two motorways to cross each other twice!
        const isTrumpetTargetTouch =
          allowTouchTrunkNum === other.number &&
          Math.hypot(hit.x - ex, hit.y - ey) < 4.5;
        if (!isTrumpetTargetTouch) {
          if (forbidAnyCrossing) return Infinity;
          crossCount++;
          if (crossCount > 1) return Infinity;
          const crossSin = Math.abs(Math.sin(hit.angleA - hit.angleB));
          if (crossSin < 0.64) return Infinity;

          const dStartA = this.polylineArcLength(other.samples, 0, hit.idxA);
          const dEndA = this.polylineArcLength(
            other.samples,
            hit.idxA,
            other.samples.length - 1,
          );
          const dStartB = this.polylineArcLength(samples, 0, hit.idxB);
          const dEndB = this.polylineArcLength(
            samples,
            hit.idxB,
            samples.length - 1,
          );

          const minCrossArm = this.motorways.length >= 2 ? 28 : 20;
          if (
            dStartA < 20 ||
            dEndA < 20 ||
            dStartB < minCrossArm ||
            dEndB < minCrossArm
          )
            return Infinity;
          // Reject candidates that come within 12 tiles of two existing motorways (cross-brace prevention)
          for (const other2 of this.motorways) {
            if (other2.number === other.number || !other2.samples) continue;
            for (let k2 = 0; k2 < other2.samples.length; k2 += 2) {
              if (
                Math.hypot(
                  other2.samples[k2].x - hit.x,
                  other2.samples[k2].y - hit.y,
                ) < 12.0
              ) {
                return Infinity;
              }
            }
          }
          const nearMajorIc = this.interchanges.some(
            (ic) =>
              (ic.type === "cloverleaf" || ic.type === "trumpet") &&
              Math.hypot(ic.x - hit.x, ic.y - hit.y) < 28.0,
          );
          if (nearMajorIc) return Infinity;
          if (
            !this.isCloverleafFootprintDry(
              hit.x,
              hit.y,
              hit.angleA,
              hit.angleB,
              [-1, 1],
              [-1, 1],
            )
          ) {
            return Infinity;
          }
        }
      }
    }

    let penalty =
      Math.abs(candidateOff - preferOff) * 0.25 + Math.abs(candidateOff) * 0.12;
    let waterArc = 0;
    let totalWaterArc = 0;
    let riverProxArc = 0;
    let tunnelRunArc = 0;
    let totalTunnelArc = 0;

    for (let i = 0; i < samples.length; i++) {
      const pt = samples[i];
      const gx = Math.round(pt.x);
      const gy = Math.round(pt.y);
      const id = this.idx(gx, gy);
      const segLen =
        i > 0
          ? Math.hypot(pt.x - samples[i - 1].x, pt.y - samples[i - 1].y)
          : 1.0;

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
        if (cosWide < 0.16) return Infinity;
      }

      if (this.waterMask[id] === 1) {
        riverProxArc += segLen;
        // Never allow an expressway to run longitudinally inside a river channel (> 2 perpendicular river crossings)
        if (riverProxArc > 14.5) return Infinity;
      }

      if (this.waterMask[id] > 0) {
        tunnelRunArc = 0;
        const wWeight = this.waterMask[id] === 2 ? 1.35 : 0.72;
        waterArc += segLen * wWeight;
        totalWaterArc += segLen * wWeight;
        // Hard invariant 6: Never build causeways across open lakes/bays on continental maps (`<= 9.5` weighted tiles),
        // and only allow narrow-strait causeways (`<= 12.5` weighted tiles) in `island-hopper`!
        const isIH = this.config.archetype === "island-hopper";
        if (
          waterArc > (isIH ? 12.5 : 9.5) ||
          totalWaterArc > (isIH ? 15.5 : 13.5)
        ) {
          return Infinity;
        }
        penalty += segLen * (this.waterMask[id] === 2 ? 7.5 : 3.4);
      } else {
        // In `island-hopper`, never use a tiny uninhabited skerry (`landmassId < 0`) as a motorway bridge pier!
        if (
          this.config.archetype === "island-hopper" &&
          this.landmassId[id] < 0
        ) {
          return Infinity;
        }
        waterArc = 0;
        const dWater = this.distToWater[id];
        if (dWater < 3.6) {
          penalty += (3.8 - dWater) * 7.5 * segLen;
        }
        // Topographic valley preference & tunnel portal discipline:
        // Expressways strongly prefer incised river valleys & low passes, and only bore short perpendicular mountain tunnels!
        const hAbove = Math.max(0, this.elevationField[id] - this.seaLevel);
        const ridgeElev = Math.max(0, hAbove - 0.115);
        penalty +=
          segLen *
          (hAbove * 18.0 + ridgeElev * 42.0 + this.slopeField[id] * 12.5);
        // Penalize running expressways collinearly through urban street grids outside terminal stubs
        if (i >= 5 && i <= samples.length - 6) {
          if (this.zoneColorIdx[id] >= 0) penalty += segLen * 8.5;
          if (this.roadGrid[id] > 0) penalty += segLen * 14.0;
        }
        if (i > 0) {
          const prevPt = samples[i - 1];
          const prevId = this.idx(Math.round(prevPt.x), Math.round(prevPt.y));
          const dElev = Math.abs(
            this.elevationField[id] - this.elevationField[prevId],
          );
          penalty += dElev * 75.0;
        }
        if (hAbove >= 0.235) {
          if (tunnelRunArc === 0) {
            // Fixed tunnel portal entry surcharge so isolated hills are always bypassed via the valley floor!
            penalty += 68.0;
          }
          tunnelRunArc += segLen;
          totalTunnelArc += segLen;
          penalty += segLen * 16.0;
          if (tunnelRunArc > 42.0 || totalTunnelArc > 52.0) return Infinity;
          if (tunnelRunArc > 20.0) {
            penalty += (tunnelRunArc - 20.0) * 4.5 * segLen;
          }
        } else {
          tunnelRunArc = 0;
        }
      }

      // Penalize crossing directly through an airport's low-altitude runway approach funnel
      for (const ap of this.airports) {
        if (ap.id === airportId && i < 10) continue;
        const adx = pt.x - ap.x;
        const ady = pt.y - ap.y;
        const cosA = Math.cos(ap.angleRad);
        const sinA = Math.sin(ap.angleRad);
        const u = Math.abs(adx * cosA + ady * sinA);
        const v = Math.abs(-adx * sinA + ady * cosA);
        if (u > ap.halfLen && u <= ap.halfLen + 15.0 && v <= ap.halfWid + 3.2) {
          penalty += segLen * 18.0;
        }
      }

      // Hard reject passing near an existing motorway's endpoints or running parallel/colliding with its interior
      for (const other of this.motorways) {
        if (allowTouchTrunkNum === other.number && i > samples.length - 22)
          continue;
        const sharedStart =
          Math.hypot(sx - other.sx, sy - other.sy) < 2.5 ||
          Math.hypot(sx - other.ex, sy - other.ey) < 2.5;
        const sharedEnd =
          Math.hypot(ex - other.sx, ey - other.sy) < 2.5 ||
          Math.hypot(ex - other.ex, ey - other.ey) < 2.5;
        if ((i <= 4 && sharedStart) || (i >= samples.length - 5 && sharedEnd))
          continue;

        if (
          Math.hypot(pt.x - other.sx, pt.y - other.sy) < 11.5 ||
          Math.hypot(pt.x - other.ex, pt.y - other.ey) < 11.5
        ) {
          return Infinity;
        }
        for (let j = 2; j < other.samples.length - 2; j += 2) {
          const d = Math.hypot(
            pt.x - other.samples[j].x,
            pt.y - other.samples[j].y,
          );
          // Endpoints of a non-trumpet motorway must NEVER land within 13.5 tiles of another motorway's interior!
          if ((i <= 3 || i >= samples.length - 4) && d < 13.5) {
            return Infinity;
          }
          if (d < 16.0) {
            const a1 = Math.atan2(
              samples[Math.min(samples.length - 1, i + 1)].y -
                samples[Math.max(0, i - 1)].y,
              samples[Math.min(samples.length - 1, i + 1)].x -
                samples[Math.max(0, i - 1)].x,
            );
            const a2 = Math.atan2(
              other.samples[Math.min(other.samples.length - 1, j + 1)].y -
                other.samples[Math.max(0, j - 1)].y,
              other.samples[Math.min(other.samples.length - 1, j + 1)].x -
                other.samples[Math.max(0, j - 1)].x,
            );
            const sinCross = Math.abs(Math.sin(a1 - a2));
            if (sinCross < 0.72) {
              return Infinity;
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
          const dW = this.distToWater[id];
          if (dW < 3.8) c += (4.0 - dW) * 14.0;
          c += hAbove * 115.0 + hAbove * hAbove * 240.0 + slope * 56.0;
          if (this.zoneColorIdx[id] >= 0) c += 12.0;
          if (this.roadGrid[id] > 0) c += 16.0;
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

  findValleyMotorwayWaypoints(
    sx,
    sy,
    ex,
    ey,
    airportId = null,
    lateralBias = 0,
  ) {
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
      [1, 0, 1.0],
      [-1, 0, 1.0],
      [0, 1, 1.0],
      [0, -1, 1.0],
      [1, 1, 1.414],
      [-1, 1, 1.414],
      [1, -1, 1.414],
      [-1, -1, 1.414],
    ];

    let iterCount = 0;
    const maxValleyIter = Math.max(4500, Math.round(cw * ch * 0.55));
    while (heapId.length > 0 && iterCount++ < maxValleyIter) {
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
        if (rawPts.length < 3)
          return [
            { x: sx, y: sy },
            { x: ex, y: ey },
          ];

        // Extract denser control points directly from the A* valley path (`every ~3 coarse steps, up to 14 points`)
        // without adding a synthetic 16-tile sine wave that pushes waypoints out of the valley onto mountain ridges!
        let maxHAbove = 0;
        for (const p of rawPts) {
          const pid = this.idx(
            Math.max(0, Math.min(this.W - 1, p.x)),
            Math.max(0, Math.min(this.H - 1, p.y)),
          );
          const ha = Math.max(0, this.elevationField[pid] - this.seaLevel);
          if (ha > maxHAbove) maxHAbove = ha;
        }
        let outWps = [{ x: sx, y: sy }];
        const numCtrl = Math.min(
          14,
          Math.max(5, Math.floor(rawPts.length / 3)),
        );
        // Only apply a subtle <= 2.2-tile S-curve grace when the entire corridor lies on a dead-flat lowland plain
        const flatPlainWaveAmp =
          maxHAbove < 0.08
            ? Math.min(2.2, chordLen * 0.025) * (lateralBias >= 0 ? 1 : -1)
            : 0;
        for (let k = 1; k <= numCtrl; k++) {
          const frac = k / (numCtrl + 1);
          const idx = Math.floor(frac * (rawPts.length - 1));
          const wave = Math.sin(frac * Math.PI * 2) * flatPlainWaveAmp;
          const wx = rawPts[idx].x + chordNx * wave;
          const wy = rawPts[idx].y + chordNy * wave;
          if (
            this.inBounds(Math.round(wx), Math.round(wy), 5) &&
            !this.isPointInAirportPad(wx, wy, 2.2, airportId)
          ) {
            outWps.push({ x: wx, y: wy });
          } else {
            outWps.push({ x: rawPts[idx].x, y: rawPts[idx].y });
          }
        }
        outWps.push({ x: ex, y: ey });

        for (let pass = 0; pass < 4; pass++) {
          const nextWps = [outWps[0]];
          for (let i = 1; i < outWps.length - 1; i++) {
            const nx =
              0.25 * outWps[i - 1].x +
              0.5 * outWps[i].x +
              0.25 * outWps[i + 1].x;
            const ny =
              0.25 * outWps[i - 1].y +
              0.5 * outWps[i].y +
              0.25 * outWps[i + 1].y;
            const curId = this.idx(
              Math.round(outWps[i].x),
              Math.round(outWps[i].y),
            );
            const newId = this.idx(Math.round(nx), Math.round(ny));
            // Accept smoothed position unless it enters water/airport pad or climbs onto a steep mountain wall
            if (
              !this.isPointInAirportPad(nx, ny, 2.2, airportId) &&
              this.waterMask[newId] === 0 &&
              this.elevationField[newId] <= this.elevationField[curId] + 0.08
            ) {
              nextWps.push({ x: nx, y: ny });
            } else {
              nextWps.push(outWps[i]);
            }
          }
          nextWps.push(outWps[outWps.length - 1]);
          outWps = nextWps;
        }
        return outWps;
      }

      if (closedGen[cid] === gen) continue;
      closedGen[cid] = gen;

      const cx = cid % cw;
      const cy = Math.floor(cid / cw);
      const currGx = cx * stride;
      const currGy = cy * stride;
      const currElev = this.inBounds(currGx, currGy, 1)
        ? this.elevationField[this.idx(currGx, currGy)]
        : this.seaLevel;
      const pid = parent[cid];
      const prevDx = pid !== -1 ? cx - (pid % cw) : 0;
      const prevDy = pid !== -1 ? cy - Math.floor(pid / cw) : 0;

      for (const [dx, dy, baseStep] of dirs) {
        const ncx = cx + dx;
        const ncy = cy + dy;
        if (ncx < 2 || ncx >= cw - 2 || ncy < 2 || ncy >= ch - 2) continue;
        const nid = ncy * cw + ncx;
        if (closedGen[nid] === gen) continue;

        if (pid !== -1 && dx * prevDx + dy * prevDy < 0) continue; // Forbid sharp reversals

        const gx = ncx * stride;
        const gy = ncy * stride;
        if (this.isPointInAirportPad(gx, gy, 2.2, airportId)) continue;

        const id = this.idx(gx, gy);
        const wm = this.waterMask[id];
        const absDeltaH =
          Math.abs(this.elevationField[id] - currElev) / baseStep;

        let cost = baseStep * stride + baseCostTable[nid] + absDeltaH * 145.0;
        if (wm === 2) {
          // Distinguish narrow strait crossings (land within 12 tiles ahead) from deep open lakes/bays
          const aheadX = gx + dx * stride * 4;
          const aheadY = gy + dy * stride * 4;
          const isNarrowStrait =
            this.inBounds(aheadX, aheadY, 2) &&
            this.waterMask[this.idx(aheadX, aheadY)] === 0;
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

  createMotorwayEntity(
    number,
    sx,
    sy,
    ex,
    ey,
    airportId = null,
    townId = null,
    forcedViaPt = null,
  ) {
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    const ap = airportId !== null ? this.airports[airportId] : null;
    const departPull = ap ? Math.min(20, Math.max(7.0, len * 0.3)) : 0;

    const candidateCurves = [];

    const defaultSign = number % 2 === 0 ? 1 : -1;
    const preferMag = Math.min(7.5, len * 0.09);
    const preferOff = defaultSign * preferMag;

    if (forcedViaPt && !ap) {
      // Route Cloverleaf transverse trunks (`M-2`) through two chained valley A* legs (`start -> forcedViaPt -> end`)
      // with colinear tangent alignment across `forcedViaPt` so M-2 follows topographic valleys on both sides!
      for (const bias of [0, defaultSign * 10, -defaultSign * 10]) {
        const leg1 = this.findValleyMotorwayWaypoints(
          sx,
          sy,
          forcedViaPt.x,
          forcedViaPt.y,
          null,
          bias,
        );
        const leg2 = this.findValleyMotorwayWaypoints(
          forcedViaPt.x,
          forcedViaPt.y,
          ex,
          ey,
          null,
          -bias,
        );
        if (leg1 && leg2 && leg1.length >= 2 && leg2.length >= 2) {
          const joined = [...leg1, ...leg2.slice(1)];
          const vIdx = leg1.length - 1;
          if (vIdx >= 1 && vIdx < joined.length - 1) {
            joined[vIdx - 1] = {
              x:
                0.55 * joined[vIdx - 1].x +
                0.45 * (2 * forcedViaPt.x - joined[vIdx + 1].x),
              y:
                0.55 * joined[vIdx - 1].y +
                0.45 * (2 * forcedViaPt.y - joined[vIdx + 1].y),
            };
          }
          candidateCurves.push({
            waypoints: joined,
            isCloverleafTarget: true,
            isValleyCorridor: true,
            off: 0,
            preferOff: 0,
          });
        }
      }
      const c1x = 2 * forcedViaPt.x - 0.5 * (sx + ex);
      const c1y = 2 * forcedViaPt.y - 0.5 * (sy + ey);
      candidateCurves.push({
        waypoints: [
          { x: sx, y: sy },
          { x: c1x, y: c1y },
          { x: ex, y: ey },
        ],
        isCloverleafTarget: true,
        off: 0,
        preferOff: 0,
      });
    }

    // 1. Terrain-Guided A* Valley Corridor B-Spline Candidates (enabled for both airport & city trunks!)
    if (len >= 28) {
      const vStartX = ap ? sx + ap.landNx * Math.min(10, len * 0.14) : sx;
      const vStartY = ap ? sy + ap.landNy * Math.min(10, len * 0.14) : sy;
      for (const bias of [defaultSign * 14, -defaultSign * 14, 0]) {
        const valleyWps = this.findValleyMotorwayWaypoints(
          vStartX,
          vStartY,
          ex,
          ey,
          airportId,
          bias,
        );
        if (valleyWps && valleyWps.length >= 4) {
          const fullWps = ap ? [{ x: sx, y: sy }, ...valleyWps] : valleyWps;
          candidateCurves.push({
            waypoints: fullWps,
            isValleyCorridor: true,
            off: preferOff,
            preferOff,
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
      -defaultSign * 0.28,
    ];

    for (const frac of offsetFracs) {
      const off = Math.max(-32, Math.min(32, len * frac));
      if (ap) {
        for (const pullScale of [1.0, 0.68, 0.45]) {
          const p1 = {
            x: sx + ap.landNx * (departPull * pullScale) + nx * (off * 0.45),
            y: sy + ap.landNy * (departPull * pullScale) + ny * (off * 0.45),
          };
          // C-curve & gentle S-curve p2 options
          for (const sSign of [1.0, -0.75]) {
            const p2 = {
              x: sx + dx * 0.66 + nx * (off * sSign),
              y: sy + dy * 0.66 + ny * (off * sSign),
            };
            candidateCurves.push({
              waypoints: [{ x: sx, y: sy }, p1, p2, { x: ex, y: ey }],
              off,
              preferOff,
            });
          }
        }
      } else {
        for (const sSign of [1.0, -0.8]) {
          const p1 = {
            x: sx + dx * 0.33 + nx * off,
            y: sy + dy * 0.33 + ny * off,
          };
          const p2 = {
            x: sx + dx * 0.67 + nx * (off * sSign),
            y: sy + dy * 0.67 + ny * (off * sSign),
          };
          candidateCurves.push({
            waypoints: [{ x: sx, y: sy }, p1, p2, { x: ex, y: ey }],
            off,
            preferOff,
          });
        }
      }
    }

    let bestCand = null;
    let bestScore = Infinity;

    for (const cand of candidateCurves) {
      const samples = this.sampleMotorwayCurve(cand.waypoints);
      const rawScore = this.scoreMotorwaySamples(
        samples,
        sx,
        sy,
        ex,
        ey,
        airportId,
        cand.preferOff,
        cand.off,
      );
      const bonus =
        (cand.isCloverleafTarget ? 35.0 : 0) +
        (cand.isValleyCorridor ? 15.0 : 0);
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
      sx,
      sy,
      ex,
      ey,
      waypoints: bestCand.waypoints,
      samples: bestCand.samples,
      airportId,
      townId,
      prunedStart: false,
      prunedEnd: false,
    };
  }

  sampleMotorwayCurve(waypoints) {
    if (waypoints.length === 3) {
      const [p0, p1, p2] = waypoints;
      const out = [];
      const steps = 42;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        out.push({
          x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
          y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
        });
      }
      return out;
    }

    if (waypoints.length === 4) {
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
          y: c0 * p0.y + c1 * p1.y + c2 * p2.y + c3 * p3.y,
        });
      }
      return out;
    }

    let pts = waypoints.map((p) => ({ x: p.x, y: p.y }));
    for (let iter = 0; iter < 3; iter++) {
      const next = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        next.push({
          x: 0.75 * p0.x + 0.25 * p1.x,
          y: 0.75 * p0.y + 0.25 * p1.y,
        });
        next.push({
          x: 0.25 * p0.x + 0.75 * p1.x,
          y: 0.25 * p0.y + 0.75 * p1.y,
        });
      }
      next.push(pts[pts.length - 1]);
      pts = next;
    }

    // Resample Chaikin polyline to 45 uniform arc-length samples (matching cubic Bezier sample density)
    // so `cosTurn` and `cosWide` evaluate consistent physical curvature radii!
    const cumLen = new Float32Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
      cumLen[i] =
        cumLen[i - 1] +
        Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    const totalLen = cumLen[pts.length - 1];
    if (totalLen < 1e-3) return pts;

    const steps = 44;
    const resampled = [pts[0]];
    let segIdx = 0;
    for (let s = 1; s < steps; s++) {
      const targetD = (s / steps) * totalLen;
      while (segIdx < pts.length - 2 && cumLen[segIdx + 1] < targetD) {
        segIdx++;
      }
      const d0 = cumLen[segIdx];
      const d1 = cumLen[segIdx + 1];
      const t = d1 > d0 ? (targetD - d0) / (d1 - d0) : 0;
      resampled.push({
        x: pts[segIdx].x + (pts[segIdx + 1].x - pts[segIdx].x) * t,
        y: pts[segIdx].y + (pts[segIdx + 1].y - pts[segIdx].y) * t,
      });
    }
    resampled.push(pts[pts.length - 1]);
    return resampled;
  }

  polylineArcLength(samples, i0, i1) {
    let len = 0;
    const start = Math.max(0, Math.min(i0, i1));
    const end = Math.min(samples.length - 1, Math.max(i0, i1));
    for (let i = start; i < end; i++) {
      len += Math.hypot(
        samples[i + 1].x - samples[i].x,
        samples[i + 1].y - samples[i].y,
      );
    }
    return len;
  }

  removeOrphanedTerminalStub(x, y) {
    const stillUsed = this.motorways.some(
      (m) =>
        (Math.hypot(m.sx - x, m.sy - y) < 1.5 && !m.prunedStart) ||
        (Math.hypot(m.ex - x, m.ey - y) < 1.5 && !m.prunedEnd),
    );
    if (!stillUsed) {
      this.interchanges = this.interchanges.filter(
        (ic) =>
          !(
            ic.type === "terminal-stub" &&
            !ic.isAirportStub &&
            Math.hypot(ic.x - x, ic.y - y) < 1.5
          ),
      );
      const beforeLen = this.roads.length;
      this.roads = this.roads.filter(
        (r) =>
          !(
            r.stubOriginX !== undefined &&
            Math.hypot(r.stubOriginX - x, r.stubOriginY - y) < 1.5
          ),
      );
      if (this.roads.length !== beforeLen) {
        this.rebuildRoadGridAndEdges();
      }
    }
  }

  /**
   * Attempts to build a 3-way Trumpet Spur Motorway from `(originX, originY)` (an airport gate
   * or unserved town beltway stub) directly into a dry interior point on an existing trunk motorway,
   * terminating at the trumpet throat with a perpendicular arrival tangent.
   */
  tryBuildTrumpetSpurToTrunk(
    number,
    originX,
    originY,
    airportId = null,
    townId = null,
  ) {
    const ap = airportId !== null ? this.airports[airportId] : null;
    let bestResult = null;
    let bestScore = Infinity;

    for (const trunk of this.motorways) {
      if (trunk.prunedStart || trunk.prunedEnd) continue;
      const tSamples = trunk.samples;
      if (!tSamples || tSamples.length < 14) continue;
      const trunkLen = this.polylineArcLength(tSamples, 0, tSamples.length - 1);
      if (trunkLen < 24) continue;

      const iStart = Math.floor(tSamples.length * 0.14);
      const iEnd = Math.ceil(tSamples.length * 0.86);

      for (let i = iStart; i <= iEnd; i++) {
        const hitPt = tSamples[i];
        if (Math.hypot(hitPt.x - trunk.sx, hitPt.y - trunk.sy) < 12.0) continue;
        if (Math.hypot(hitPt.x - trunk.ex, hitPt.y - trunk.ey) < 12.0) continue;

        const nearOtherMway = this.motorways.some(
          (m) =>
            m.number !== trunk.number &&
            m.samples &&
            m.samples.some(
              (sp) => Math.hypot(sp.x - hitPt.x, sp.y - hitPt.y) < 12.0,
            ),
        );
        if (nearOtherMway) continue;

        const nearOtherIc = this.interchanges.some(
          (ic) =>
            (ic.type === "cloverleaf" || ic.type === "trumpet") &&
            Math.hypot(ic.x - hitPt.x, ic.y - hitPt.y) < 24.0,
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
        const sideSign = toOrigX * nx + toOrigY * ny >= 0 ? 1 : -1;
        const outNx = nx * sideSign;
        const outNy = ny * sideSign;

        if (!this.isTrumpetFootprintDry(hitPt.x, hitPt.y, angleMain, sideSign))
          continue;

        const chord = Math.hypot(hitPt.x - originX, hitPt.y - originY);
        const scaleSpan = Math.max(1, this.W / 360);
        const maxChord = (ap ? (ap.isHub ? 165 : 85) : 165) * scaleSpan;
        if (chord < 11 || chord > maxChord) continue;

        // Ensure the origin lies beside the trunk (not collinearly far beyond its endpoints)
        const tDx = trunk.ex - trunk.sx;
        const tDy = trunk.ey - trunk.sy;
        const tLen = Math.hypot(tDx, tDy) || 1;
        const projT =
          ((originX - trunk.sx) * tDx + (originY - trunk.sy) * tDy) /
          (tLen * tLen);
        const perpDist =
          Math.abs((originX - trunk.sx) * -tDy + (originY - trunk.sy) * tDx) /
          tLen;
        if (projT < -0.6 || projT > 1.6 || perpDist < 7.5) continue;

        // Ensure the origin lies comfortably on the sideSign half-space of the trunk so Trumpet merges aren't acute
        const cosPerp =
          ((originX - hitPt.x) * outNx + (originY - hitPt.y) * outNy) /
          (chord || 1);
        if (cosPerp < 0.45) continue;

        // If departing an airport gate, ensure the trumpet target is reachable from the landside gate
        if (ap) {
          const alignGate =
            ((hitPt.x - originX) * ap.landNx +
              (hitPt.y - originY) * ap.landNy) /
            chord;
          if (alignGate < (ap.isHub ? -0.58 : 0.12)) continue;
        }

        const pullScales = ap ? [0.34, 0.2] : [0.34];
        for (const pScale of pullScales) {
          const pullStart = ap
            ? Math.min(26, Math.max(5.5, chord * pScale))
            : chord * 0.34;
          const pullEnd = Math.min(28, Math.max(9.0, chord * 0.38));
          const p0 = { x: originX, y: originY };
          const p1 = ap
            ? {
                x: originX + ap.landNx * pullStart,
                y: originY + ap.landNy * pullStart,
              }
            : {
                x: originX + (hitPt.x - originX) * 0.34,
                y: originY + (hitPt.y - originY) * 0.34,
              };
          // Lock P2 along outNx, outNy from hitPt so the spur arrives strictly perpendicular (90°) to the trunk
          const p2 = {
            x: hitPt.x + outNx * pullEnd,
            y: hitPt.y + outNy * pullEnd,
          };
          const p3 = { x: hitPt.x, y: hitPt.y };

          const cDx = hitPt.x - originX;
          const cDy = hitPt.y - originY;
          const cLen = Math.hypot(cDx, cDy) || 1;
          const cNx = -cDy / cLen;
          const cNy = cDx / cLen;

          const spurCandidates = [
            { waypoints: [p0, p1, p2, p3], isValley: false },
          ];
          // Add lateral C-curve Bezier candidates (`p1` offset perpendicular to chord) so Trumpet spurs
          // can curve gracefully around an isolated hill (`VALLEY-618`) into the perpendicular throat `p2 -> p3`!
          if (!ap) {
            for (const latFrac of [0.18, -0.18, 0.3, -0.3]) {
              const p1Lat = {
                x: p1.x + cNx * (chord * latFrac),
                y: p1.y + cNy * (chord * latFrac),
              };
              spurCandidates.push({
                waypoints: [p0, p1Lat, p2, p3],
                isValley: false,
              });
            }
          }
          // For medium/long spurs (chord >= 24, every 2nd trunk sample), also test terrain-following Valley A* paths
          // terminating in a compact 8.5-tile perpendicular throat `p2Valley -> p3`!
          if (chord >= 24 && i % 2 === 0) {
            const vStart = ap
              ? {
                  x: originX + ap.landNx * Math.min(8.5, chord * 0.14),
                  y: originY + ap.landNy * Math.min(8.5, chord * 0.14),
                }
              : p0;
            const p2Valley = {
              x: hitPt.x + outNx * Math.min(11.0, Math.max(7.5, chord * 0.14)),
              y: hitPt.y + outNy * Math.min(11.0, Math.max(7.5, chord * 0.14)),
            };
            const p2Throat = {
              x: hitPt.x + outNx * 4.2,
              y: hitPt.y + outNy * 4.2,
            };
            for (const bias of [0, 10, -10]) {
              const valleyWps = this.findValleyMotorwayWaypoints(
                vStart.x,
                vStart.y,
                p2Valley.x,
                p2Valley.y,
                airportId,
                bias,
              );
              if (valleyWps && valleyWps.length >= 3) {
                const fullWps = ap
                  ? [p0, ...valleyWps, p2Throat, p3]
                  : [...valleyWps, p2Throat, p3];
                spurCandidates.push({ waypoints: fullWps, isValley: true });
              }
            }
          }

          for (const sc of spurCandidates) {
            const waypoints = sc.waypoints;
            const samples = this.sampleMotorwayCurve(waypoints);
            // Verify that the final sampled arrival tangent at `p3` is within <= 22° of `(-outNx, -outNy)`
            const sLast = samples[samples.length - 1];
            const sPrev = samples[Math.max(0, samples.length - 3)];
            const arrDx = sLast.x - sPrev.x;
            const arrDy = sLast.y - sPrev.y;
            const arrLen = Math.hypot(arrDx, arrDy) || 1;
            const arrDot = (arrDx * -outNx + arrDy * -outNy) / arrLen;
            if (arrDot < 0.92) continue;

            const score = this.scoreMotorwaySamples(
              samples,
              originX,
              originY,
              hitPt.x,
              hitPt.y,
              airportId,
              0,
              0,
              true,
              trunk.number,
            );
            if (!Number.isFinite(score)) continue;

            const totalScore =
              score -
              (sc.isValley ? 18.0 : 0) +
              chord * 0.45 +
              (1.0 - cosPerp) * 18 +
              this.interchangeRoadOverlapCost(hitPt.x, hitPt.y, 4.0) * 0.55;
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
                  airportId,
                  townId,
                  prunedStart: false,
                  prunedEnd: true,
                },
                trumpetIc: {
                  type: "trumpet",
                  x: hitPt.x,
                  y: hitPt.y,
                  angleMain,
                  sideSign,
                  mwayMain: trunk.number,
                  mwaySpur: number,
                  label: `M-${trunk.number} × M-${number} Trumpet Interchange`,
                },
              };
            }
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
        if (crossSin < 0.6) continue;

        if (
          !this.isCloverleafFootprintDry(
            hit.x,
            hit.y,
            hit.angleA,
            hit.angleB,
            [-1, 1],
            [-1, 1],
          )
        ) {
          continue;
        }

        const tooClose = this.interchanges.some(
          (ic) =>
            (ic.type === "cloverleaf" || ic.type === "trumpet") &&
            Math.hypot(ic.x - hit.x, ic.y - hit.y) < 14,
        );
        if (tooClose) continue;

        this.displaceBuildingsInRadius(hit.x, hit.y, 5.6);
        /** @type {CloverleafInterchange} */
        const cloverIc = {
          type: "cloverleaf",
          x: hit.x,
          y: hit.y,
          angleA: hit.angleA,
          angleB: hit.angleB,
          activeSignsA: [-1, 1],
          activeSignsB: [-1, 1],
          prunedBridgeB: false,
          mwayA: mA.number,
          mwayB: mB.number,
          label: `M-${mA.number} × M-${mB.number} Cloverleaf`,
        };
        this.displaceAndRerouteRoadsAtInterchange(cloverIc, false);
        this.interchanges.push(cloverIc);
      }
    }
  }

  findPolylineIntersection(samplesA, samplesB) {
    if (!samplesA || !samplesB || samplesA.length < 2 || samplesB.length < 2)
      return null;
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
        const pt = this.segmentIntersection(
          a1.x,
          a1.y,
          a2.x,
          a2.y,
          b1.x,
          b1.y,
          b2.x,
          b2.y,
        );
        if (pt) {
          // Ignore intentional shared terminal roundabouts where both motorways meet at the same endpoint
          const nearAEnd =
            Math.min(
              Math.hypot(pt.x - aStart.x, pt.y - aStart.y),
              Math.hypot(pt.x - aEnd.x, pt.y - aEnd.y),
            ) < 2.2;
          const nearBEnd =
            Math.min(
              Math.hypot(pt.x - bStart.x, pt.y - bStart.y),
              Math.hypot(pt.x - bEnd.x, pt.y - bEnd.y),
            ) < 2.2;
          if (nearAEnd && nearBEnd) continue;
          if (hits.some((h) => Math.hypot(h.x - pt.x, h.y - pt.y) < 5.5))
            continue;
          hits.push({
            x: pt.x,
            y: pt.y,
            idxA: i,
            idxB: j,
            angleA: Math.atan2(a2.y - a1.y, a2.x - a1.x),
            angleB: Math.atan2(b2.y - b1.y, b2.x - b1.x),
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
        y: y1 + t * (y2 - y1),
      };
    }
    return null;
  }

  /**
   * Re-aims any house or commercial/industrial building whose driveway road tile (`roadX, roadY`)
   * was displaced (`roadGrid === 0`) onto an adjacent surviving road tile (`roadGrid === 1 || 2`),
   * or displaces the building if it no longer touches any active road.
   */
  rebindOrDisplaceOrphanedFrontage() {
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    this.houses = this.houses.filter((h) => {
      const rx = Math.round(h.roadX),
        ry = Math.round(h.roadY);
      if (
        this.inBounds(rx, ry, 1) &&
        (this.roadGrid[this.idx(rx, ry)] === 1 ||
          this.roadGrid[this.idx(rx, ry)] === 2)
      ) {
        return true;
      }
      for (const [dx, dy] of dirs) {
        const nx = h.x + dx,
          ny = h.y + dy;
        if (this.inBounds(nx, ny, 1)) {
          const rg = this.roadGrid[this.idx(nx, ny)];
          if (rg === 1 || rg === 2) {
            h.roadX = nx;
            h.roadY = ny;
            return true;
          }
        }
      }
      const hid = this.idx(h.x, h.y);
      if (this.buildingMask[hid] === 1) this.buildingMask[hid] = 0;
      const t = this.towns[h.townId];
      if (t && t.housesCount > 0) t.housesCount--;
      this.displacedBuildingsCount++;
      return false;
    });

    this.destinations = this.destinations.filter((d) => {
      const rx = Math.round(d.roadX),
        ry = Math.round(d.roadY);
      if (
        this.inBounds(rx, ry, 1) &&
        (this.roadGrid[this.idx(rx, ry)] === 1 ||
          this.roadGrid[this.idx(rx, ry)] === 2)
      ) {
        return true;
      }
      const wT = d.wTiles || 2;
      const hT = d.hTiles || 2;
      for (let dx = 0; dx < wT; dx++) {
        for (const py of [-1, hT]) {
          const nx = d.gx + dx,
            ny = d.gy + py;
          if (this.inBounds(nx, ny, 1)) {
            const rg = this.roadGrid[this.idx(nx, ny)];
            if (rg === 1 || rg === 2) {
              d.roadX = nx;
              d.roadY = ny;
              d.lotX = nx;
              d.lotY = py === -1 ? d.gy : d.gy + hT - 1;
              return true;
            }
          }
        }
      }
      for (let dy = 0; dy < hT; dy++) {
        for (const px of [-1, wT]) {
          const nx = d.gx + px,
            ny = d.gy + dy;
          if (this.inBounds(nx, ny, 1)) {
            const rg = this.roadGrid[this.idx(nx, ny)];
            if (rg === 1 || rg === 2) {
              d.roadX = nx;
              d.roadY = ny;
              d.lotX = px === -1 ? d.gx : d.gx + wT - 1;
              d.lotY = ny;
              return true;
            }
          }
        }
      }
      for (let dy = 0; dy < hT; dy++) {
        for (let dx = 0; dx < wT; dx++) {
          const did = this.idx(d.gx + dx, d.gy + dy);
          if (this.buildingMask[did] === 2) this.buildingMask[did] = 0;
        }
      }
      const t = this.towns[d.townId];
      if (t) {
        if (t.destinationsCount > 0) t.destinationsCount--;
        if (d.zoneType === "commercial" && t.commercialCount > 0)
          t.commercialCount--;
        if (d.zoneType === "industrial" && t.industrialCount > 0)
          t.industrialCount--;
      }
      this.displacedBuildingsCount++;
      return false;
    });
  }

  /**
   * Displaces surface roads (`street` and `arterial`) from the footprint of a newly placed
   * `cloverleaf`, `trumpet`, or `diamond-ramp` interchange and actively reroutes both
   * through-roads (`pEntry -> pExit`) and severed branch junctions (`pOut -> bypass`)
   * around the interchange perimeter via octilinear A*.
   * Returns `false` without mutating `this.roads` if `requireCleanReroute` is true and any
   * affected road cannot be cleanly rerouted.
   */
  displaceAndRerouteRoadsAtInterchange(ic, requireCleanReroute = false) {
    let isInsideCore;
    if (ic.type === "cloverleaf") {
      isInsideCore = (px, py) => Math.hypot(px - ic.x, py - ic.y) <= 3.6;
    } else if (ic.type === "trumpet") {
      const cosA = Math.cos(ic.angleMain);
      const sinA = Math.sin(ic.angleMain);
      const nx = -sinA * (ic.sideSign || 1);
      const ny = cosA * (ic.sideSign || 1);
      isInsideCore = (px, py) => {
        const dx = px - ic.x;
        const dy = py - ic.y;
        const u = dx * cosA + dy * sinA;
        const v = dx * nx + dy * ny;
        return Math.abs(u) <= 3.3 && v >= -2.4 && v <= 3.3;
      };
    } else if (ic.type === "diamond-ramp") {
      const cosA = Math.cos(ic.angleRad);
      const sinA = Math.sin(ic.angleRad);
      const nx = -sinA * ic.connSide;
      const ny = cosA * ic.connSide;
      isInsideCore = (px, py) => {
        const gx = Math.round(px);
        const gy = Math.round(py);
        if (gx === ic.connectX && gy === ic.connectY) return false;
        if (
          ic.oppConnectX !== undefined &&
          gx === ic.oppConnectX &&
          gy === ic.oppConnectY
        )
          return false;
        const dx = px - ic.x;
        const dy = py - ic.y;
        const u = dx * cosA + dy * sinA;
        const v = dx * nx + dy * ny;
        return Math.abs(u) <= 3.5 && Math.abs(v) < 2.55;
      };
    } else {
      return true;
    }

    const hasAnyRoadOverlap = this.roads.some(
      (r) =>
        r.type !== "airport-loop" &&
        r.points.some((pt) => isInsideCore(pt.x, pt.y)),
    );
    if (!hasAnyRoadOverlap) return true;

    // 0. Expand the stripped zone outward along degree-2 unanchored road segments (up to `maxPullback` tiles)
    //    until reaching real corridor anchors (`deg >= 3` junctions, building driveways, or bridges)
    //    so realigned roads sweep smoothly from anchor to anchor instead of forming a tight 4-bend U-blister!
    const total = this.W * this.H;
    const preDeg = new Uint8Array(total);
    const frontageMask = new Uint8Array(total);
    const fullAdj = new Map();
    const addFullEdge = (u, v) => {
      if (!fullAdj.has(u)) fullAdj.set(u, []);
      if (!fullAdj.has(v)) fullAdj.set(v, []);
      const lu = fullAdj.get(u);
      if (!lu.includes(v)) {
        lu.push(v);
        fullAdj.get(v).push(u);
        preDeg[u] = Math.min(255, preDeg[u] + 1);
        preDeg[v] = Math.min(255, preDeg[v] + 1);
      }
    };

    for (const h of this.houses) {
      const rx = Math.round(h.roadX),
        ry = Math.round(h.roadY);
      if (this.inBounds(rx, ry, 1)) frontageMask[this.idx(rx, ry)] = 1;
    }
    for (const d of this.destinations) {
      const rx = Math.round(d.roadX),
        ry = Math.round(d.roadY);
      if (this.inBounds(rx, ry, 1)) frontageMask[this.idx(rx, ry)] = 1;
    }

    const strippedTile = new Uint8Array(total);
    const pullDist = new Uint8Array(total);
    const pullQ = [];

    for (const r of this.roads) {
      if (r.type === "airport-loop" || r.type === "airport-spine") continue;
      for (let i = 0; i < r.points.length; i++) {
        const pt = r.points[i];
        const gx = Math.round(pt.x),
          gy = Math.round(pt.y);
        const id = this.idx(gx, gy);
        if (isInsideCore(pt.x, pt.y) && strippedTile[id] === 0) {
          strippedTile[id] = 1;
          pullQ.push(id);
        }
        if (i < r.points.length - 1) {
          const next = r.points[i + 1];
          addFullEdge(id, this.idx(Math.round(next.x), Math.round(next.y)));
        }
      }
    }

    const maxPullback = ic.type === "diamond-ramp" ? 10 : 18;
    let pHead = 0;
    while (pHead < pullQ.length) {
      const cid = pullQ[pHead++];
      if (pullDist[cid] >= maxPullback) continue;
      for (const nid of fullAdj.get(cid) || []) {
        if (strippedTile[nid] === 1) continue;
        const nx = nid % this.W;
        const ny = Math.floor(nid / this.W);
        const isKey =
          this.airports.some((a) => a.gateX === nx && a.gateY === ny) ||
          this.interchanges.some(
            (otherIc) =>
              Math.round(otherIc.x) === nx && Math.round(otherIc.y) === ny,
          );
        if (isKey || this.roadGrid[nid] === 3) continue;
        if (frontageMask[nid] === 1 && Math.hypot(nx - ic.x, ny - ic.y) > 6.8)
          continue;
        // Stop at degree >= 3 junctions so the junction tile itself acts as the wide-horizon portal!
        if (preDeg[nid] >= 3) continue;
        strippedTile[nid] = 1;
        pullDist[nid] = pullDist[cid] + 1;
        pullQ.push(nid);
      }
    }

    const isInsideFootprint = (px, py) =>
      isInsideCore(px, py) ||
      strippedTile[this.idx(Math.round(px), Math.round(py))] === 1;

    // 1. Build the subgraph of road edges touching `isInsideFootprint` and identify all
    //    boundary portal vertices (vertices just outside `isInsideFootprint` connected to an inside vertex).
    const subAdj = new Map();
    const addSubEdge = (u, v) => {
      if (!subAdj.has(u)) subAdj.set(u, []);
      if (!subAdj.has(v)) subAdj.set(v, []);
      subAdj.get(u).push(v);
      subAdj.get(v).push(u);
    };
    const portals = new Map();
    const insideFlags = new Map();

    for (const r of this.roads) {
      if (r.type === "airport-loop" || r.type === "airport-spine") {
        if (
          r.points.some((pt) => isInsideFootprint(pt.x, pt.y)) &&
          requireCleanReroute
        ) {
          return false;
        }
        continue;
      }
      const pts = r.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        const in0 = isInsideFootprint(p0.x, p0.y);
        const in1 = isInsideFootprint(p1.x, p1.y);
        if (!in0 && !in1) continue;

        const x0 = Math.round(p0.x),
          y0 = Math.round(p0.y);
        const x1 = Math.round(p1.x),
          y1 = Math.round(p1.y);
        const id0 = this.idx(x0, y0);
        const id1 = this.idx(x1, y1);
        addSubEdge(id0, id1);

        if (in0) {
          const prev = insideFlags.get(id0) || {
            isArterial: false,
            isMainBoulevard: false,
          };
          insideFlags.set(id0, {
            isArterial: prev.isArterial || r.type !== "street",
            isMainBoulevard: prev.isMainBoulevard || Boolean(r.isMainBoulevard),
          });
        } else {
          const prev = portals.get(id0) || {
            x: x0,
            y: y0,
            id: id0,
            isArterial: false,
            isMainBoulevard: false,
          };
          portals.set(id0, {
            x: x0,
            y: y0,
            id: id0,
            isArterial: prev.isArterial || r.type !== "street",
            isMainBoulevard: prev.isMainBoulevard || Boolean(r.isMainBoulevard),
          });
        }

        if (in1) {
          const prev = insideFlags.get(id1) || {
            isArterial: false,
            isMainBoulevard: false,
          };
          insideFlags.set(id1, {
            isArterial: prev.isArterial || r.type !== "street",
            isMainBoulevard: prev.isMainBoulevard || Boolean(r.isMainBoulevard),
          });
        } else {
          const prev = portals.get(id1) || {
            x: x1,
            y: y1,
            id: id1,
            isArterial: false,
            isMainBoulevard: false,
          };
          portals.set(id1, {
            x: x1,
            y: y1,
            id: id1,
            isArterial: prev.isArterial || r.type !== "street",
            isMainBoulevard: prev.isMainBoulevard || Boolean(r.isMainBoulevard),
          });
        }
      }
    }

    // 2. Group boundary portals by their connected component through `isInsideFootprint`
    const visitedSub = new Set();
    const portalGroups = [];
    for (const [startId, flag] of insideFlags.entries()) {
      if (visitedSub.has(startId)) continue;
      visitedSub.add(startId);
      const q = [startId];
      const groupMap = new Map();
      let groupArterial = flag.isArterial;
      let groupMainBoulevard = flag.isMainBoulevard;

      while (q.length > 0) {
        const cur = q.pop();
        const f = insideFlags.get(cur);
        if (f) {
          if (f.isArterial) groupArterial = true;
          if (f.isMainBoulevard) groupMainBoulevard = true;
        }
        for (const nb of subAdj.get(cur) || []) {
          if (portals.has(nb)) {
            const pObj = portals.get(nb);
            groupMap.set(nb, pObj);
            if (pObj.isArterial) groupArterial = true;
            if (pObj.isMainBoulevard) groupMainBoulevard = true;
          } else if (!visitedSub.has(nb)) {
            visitedSub.add(nb);
            q.push(nb);
          }
        }
      }
      if (groupMap.size > 0) {
        portalGroups.push({
          portals: [...groupMap.values()],
          isArterial: groupArterial,
          isMainBoulevard: groupMainBoulevard,
        });
      }
    }

    // 3. Strip all vertices inside `isInsideFootprint` from `this.roads`
    const survivingRoads = [];
    for (const r of this.roads) {
      if (r.type === "airport-loop" || r.type === "airport-spine") {
        survivingRoads.push(r);
        continue;
      }
      let seg = [];
      for (const pt of r.points) {
        if (!isInsideFootprint(pt.x, pt.y)) {
          seg.push(pt);
        } else {
          if (seg.length >= 2) {
            survivingRoads.push({ ...r, points: seg });
          }
          seg = [];
        }
      }
      if (seg.length >= 2) {
        survivingRoads.push({ ...r, points: seg });
      }
    }

    this.roads = survivingRoads;
    this.rebuildRoadGridAndEdges();

    // 4. Reroute each portal group around the interchange perimeter via octilinear A*
    for (const group of portalGroups) {
      const pts = group.portals;
      const rType = group.isArterial ? "arterial" : "street";
      const extraProps = group.isMainBoulevard
        ? { isMainBoulevard: true }
        : null;

      if (ic.type === "diamond-ramp") {
        const cosA = Math.cos(ic.angleRad || 0);
        const sinA = Math.sin(ic.angleRad || 0);
        const nx = -sinA;
        const ny = cosA;
        const oppCx = Math.round(ic.oppTermX ?? ic.x - nx * ic.connSide * 2.65);
        const oppCy = Math.round(ic.oppTermY ?? ic.y - ny * ic.connSide * 2.65);

        for (const pA of pts) {
          const sideV = ((pA.x - ic.x) * nx + (pA.y - ic.y) * ny) * ic.connSide;
          const targetX = sideV >= 0 ? ic.connectX : oppCx;
          const targetY = sideV >= 0 ? ic.connectY : oppCy;
          if (targetX === undefined || targetY === undefined) continue;
          const detour = this.findRoadPathAStar(
            pA.x,
            pA.y,
            targetX,
            targetY,
            true,
            isInsideCore,
            false,
            {
              isInterchangeBypass: true,
              turnPenalty: 6.5,
            },
          );
          if (detour && detour.length >= 2) {
            this.commitRoadPath(detour, rType, extraProps);
            if (sideV < 0) {
              ic.oppConnectX = oppCx;
              ic.oppConnectY = oppCy;
              ic.isThroughDiamond = true;
            }
          }
        }
      } else if (pts.length >= 2) {
        // Order portals by angle around `(ic.x, ic.y)` starting after the widest angular gap
        const withAng = pts
          .map((p) => ({ ...p, ang: Math.atan2(p.y - ic.y, p.x - ic.x) }))
          .sort((a, b) => a.ang - b.ang);
        let maxGap = -1;
        let startIdx = 0;
        for (let i = 0; i < withAng.length; i++) {
          const next = withAng[(i + 1) % withAng.length];
          let gap = next.ang - withAng[i].ang;
          if (gap < 0) gap += Math.PI * 2;
          if (gap > maxGap) {
            maxGap = gap;
            startIdx = (i + 1) % withAng.length;
          }
        }
        const ordered = [];
        for (let i = 0; i < withAng.length; i++) {
          ordered.push(withAng[(startIdx + i) % withAng.length]);
        }

        const bypassOptions = {
          isInterchangeBypass: true,
          turnPenalty: 7.5,
        };

        for (let i = 0; i < ordered.length - 1; i++) {
          const pA = ordered[i];
          const pB = ordered[i + 1];
          const detour = this.findRoadPathAStar(
            pA.x,
            pA.y,
            pB.x,
            pB.y,
            true,
            isInsideCore,
            false,
            bypassOptions,
          );
          if (detour && detour.length >= 2) {
            this.commitRoadPath(detour, rType, extraProps);
          } else if (requireCleanReroute) {
            return false;
          }
        }
      }
    }

    this.rebuildRoadGridAndEdges();
    this.rebindOrDisplaceOrphanedFrontage();
    return true;
  }

  intersectUnderpassWithMotorway(samples, kHint, A, B) {
    const rdx = B.x - A.x;
    const rdy = B.y - A.y;
    const kMin = Math.max(0, kHint - 6);
    const kMax = Math.min(samples.length - 2, kHint + 6);
    let bestPt = samples[kHint];
    let bestAngle = 0;
    let bestDist = Infinity;

    for (let k = kMin; k <= kMax; k++) {
      const s0 = samples[k];
      const s1 = samples[k + 1];
      const sdx = s1.x - s0.x;
      const sdy = s1.y - s0.y;
      const denom = sdx * rdy - sdy * rdx;
      if (Math.abs(denom) > 1e-5) {
        const t = ((A.x - s0.x) * rdy - (A.y - s0.y) * rdx) / denom;
        const clampedT = Math.max(0, Math.min(1, t));
        const ix = s0.x + sdx * clampedT;
        const iy = s0.y + sdy * clampedT;
        const err = Math.abs(t - clampedT);
        if (err < bestDist) {
          bestDist = err;
          bestPt = { x: ix, y: iy, k };
          bestAngle = Math.atan2(sdy, sdx);
        }
      }
    }
    return {
      x: bestPt.x,
      y: bestPt.y,
      k: bestPt.k ?? kHint,
      angleRad: bestAngle,
    };
  }

  /**
   * @param {Motorway} mw
   * @param {number} kCenter
   * @param {Point2D} _crossPt
   * @param {Point2D} posTerm
   * @param {Point2D} negTerm
   * @param {number} connSide
   * @param {boolean} isThroughDiamond
   * @returns {DiamondSlipRamp[]}
   */
  buildFlexibleDiamondRamps(
    mw,
    kCenter,
    _crossPt,
    posTerm,
    negTerm,
    connSide,
    isThroughDiamond,
  ) {
    const samples = mw.samples;
    /** @type {DiamondSlipRamp[]} */
    const ramps = [];
    for (const sySign of /** @type {const} */ ([-1, 1])) {
      const rawT = sySign === 1 ? posTerm : negTerm;
      const p3 = { x: rawT.x, y: rawT.y };

      let kProj = kCenter;
      let bestProjD = Infinity;
      const kMin = Math.max(2, kCenter - 5);
      const kMax = Math.min(samples.length - 3, kCenter + 5);
      for (let k = kMin; k <= kMax; k++) {
        const d = Math.hypot(samples[k].x - p3.x, samples[k].y - p3.y);
        if (d < bestProjD) {
          bestProjD = d;
          kProj = k;
        }
      }

      for (const sxSign of /** @type {const} */ ([-1, 1])) {
        let kRamp =
          sxSign > 0 ? Math.max(kCenter, kProj) : Math.min(kCenter, kProj);
        let walked = 0;
        while (
          kRamp + sxSign >= 1 &&
          kRamp + sxSign < samples.length - 1 &&
          walked < 3.15
        ) {
          const nextK = kRamp + sxSign;
          walked += Math.hypot(
            samples[nextK].x - samples[kRamp].x,
            samples[nextK].y - samples[kRamp].y,
          );
          kRamp = nextK;
        }

        const rPt = samples[kRamp];
        const rPrev = samples[Math.max(0, kRamp - 1)];
        const rNext = samples[Math.min(samples.length - 1, kRamp + 1)];
        const rLen = Math.hypot(rNext.x - rPrev.x, rNext.y - rPrev.y) || 1;
        const rTanX = (rNext.x - rPrev.x) / rLen;
        const rTanY = (rNext.y - rPrev.y) / rLen;
        const rNormX = -rTanY;
        const rNormY = rTanX;

        // Start `p0` inside the expressway carriageway (`0.18` tiles off-center) with `p1` purely
        // tangential to the expressway (`v1 = 0`) so the ramp feathers out with zero border bulge!
        const p0 = {
          x: rPt.x + rNormX * sySign * 0.18,
          y: rPt.y + rNormY * sySign * 0.18,
        };

        const dx = p3.x - p0.x;
        const dy = p3.y - p0.y;
        const uAxisX = -sxSign * rTanX;
        const uAxisY = -sxSign * rTanY;
        const vAxisX = sySign * rNormX;
        const vAxisY = sySign * rNormY;
        const u3 = Math.max(1.8, dx * uAxisX + dy * uAxisY);
        const v3 = Math.max(1.4, dx * vAxisX + dy * vAxisY);

        const p1 = {
          x: p0.x + uAxisX * (u3 * 0.52),
          y: p0.y + uAxisY * (u3 * 0.52),
        };

        const isFarRoundaboutT = !isThroughDiamond && sySign !== connSide;
        let p2;
        if (isFarRoundaboutT) {
          // Join into the far-side roundabout from left and right along `uAxis`, perpendicular to the underpass stem (as a T!)
          p2 = {
            x: p3.x - uAxisX * (u3 * 0.44),
            y: p3.y - uAxisY * (u3 * 0.44),
          };
        } else {
          // Approach the octilinear surface road smoothly without overshooting outward past `p3`
          p2 = {
            x: p3.x - vAxisX * (v3 * 0.54) - uAxisX * (u3 * 0.2),
            y: p3.y - vAxisY * (v3 * 0.54) - uAxisY * (u3 * 0.2),
          };
        }

        ramps.push({
          sySign,
          sxSign,
          isOffRamp: sxSign * sySign < 0,
          kRamp,
          p0,
          p1,
          p2,
          p3,
          gridX: rawT.x,
          gridY: rawT.y,
        });
      }
    }
    return ramps;
  }

  /**
   * Checks if `mw` at sample `pt` (`_cosA, _sinA`, normal `nx, ny`) crosses over an existing
   * octilinear surface road (`this.roads`). If so, returns the unaltered road's integer
   * terminal vertices `{ posTerm, negTerm, crossX, crossY }` on both sides of the expressway.
   * @param {Point2D} pt
   * @param {number} _cosA
   * @param {number} _sinA
   * @param {number} nx
   * @param {number} ny
   */
  findExistingOctilinearUnderpass(pt, _cosA, _sinA, nx, ny) {
    for (const r of this.roads) {
      if (r.type === "airport-loop" || r.type === "airport-spine") continue;
      const pts = r.points;
      if (!pts || pts.length < 4) continue;
      for (let idx = 1; idx < pts.length - 1; idx++) {
        const rp = pts[idx];
        const rx0 = Math.round(rp.x);
        const ry0 = Math.round(rp.y);
        if (Math.hypot(rx0 - pt.x, ry0 - pt.y) > 1.55) continue;
        if (this.waterMask[this.idx(rx0, ry0)] > 0) continue;

        const ux = Math.sign(Math.round(pts[idx + 1].x) - rx0);
        const uy = Math.sign(Math.round(pts[idx + 1].y) - ry0);
        if (ux === 0 && uy === 0) continue;
        const uLen = Math.hypot(ux, uy);
        const alignNormal = Math.abs((ux / uLen) * nx + (uy / uLen) * ny);
        if (alignNormal < 0.68) continue;

        let posTerm = null;
        let bestPosErr = Infinity;
        let negTerm = null;
        let bestNegErr = Infinity;

        for (const stepDir of [-1, 1]) {
          let cx = rx0;
          let cy = ry0;
          for (let s = 1; s <= 5; s++) {
            const nx2 = cx + ux * stepDir;
            const ny2 = cy + uy * stepDir;
            if (
              !this.inBounds(nx2, ny2, 4) ||
              !this.hasRoadEdge(cx, cy, nx2, ny2)
            )
              break;
            if (this.waterMask[this.idx(nx2, ny2)] > 0) break;
            cx = nx2;
            cy = ny2;
            const v = (cx - pt.x) * nx + (cy - pt.y) * ny;
            if (v >= 2.55 && v <= 4.1) {
              const err = Math.abs(v - 3.0);
              if (err < bestPosErr) {
                bestPosErr = err;
                posTerm = { x: cx, y: cy };
              }
            } else if (v <= -2.55 && v >= -4.1) {
              const err = Math.abs(Math.abs(v) - 3.0);
              if (err < bestNegErr) {
                bestNegErr = err;
                negTerm = { x: cx, y: cy };
              }
            }
          }
        }
        if (posTerm && negTerm) {
          return {
            posTerm,
            negTerm,
            crossX: rx0,
            crossY: ry0,
          };
        }
      }
    }
    return null;
  }

  buildIntermediateExpresswayRamps() {
    if (!this.config.includeIntermediateRamps) return;

    const octDirs = [
      { dx: 1, dy: 0, len: 1, weight: 1.08 },
      { dx: 0, dy: 1, len: 1, weight: 1.08 },
      { dx: 1, dy: 1, len: Math.SQRT2, weight: 1.0 },
      { dx: 1, dy: -1, len: Math.SQRT2, weight: 1.0 },
    ];

    for (const mw of this.motorways) {
      const samples = mw.samples;
      if (!samples || samples.length < 14) continue;
      const arcLen = this.polylineArcLength(samples, 0, samples.length - 1);
      if (arcLen < 38) continue;

      const hasMajorIc = this.interchanges.some(
        (ic) =>
          (ic.type === "cloverleaf" || ic.type === "trumpet") &&
          (ic.mwayA === mw.number ||
            ic.mwayB === mw.number ||
            ic.mwayMain === mw.number ||
            ic.mwaySpur === mw.number),
      );
      if (hasMajorIc && arcLen < 48) continue;

      const maxRampsForMw = arcLen >= 88 ? 2 : 1;
      for (let rPass = 0; rPass < maxRampsForMw; rPass++) {
        let bestCandidate = null;
        let bestScore = -Infinity;

        const iStart = Math.floor(samples.length * 0.2);
        const iEnd = Math.ceil(samples.length * 0.8);

        for (let i = iStart; i <= iEnd; i++) {
          const pt = samples[i];
          const gx = Math.round(pt.x);
          const gy = Math.round(pt.y);
          if (!this.inBounds(gx, gy, 6)) continue;
          const id = this.idx(gx, gy);
          if (this.waterMask[id] > 0 || this.distToWater[id] < 3.4) continue;
          if (
            this.buildingMask[id] === 3 ||
            this.isPointInAirportPad(pt.x, pt.y, 3.8)
          )
            continue;

          if (Math.hypot(pt.x - mw.sx, pt.y - mw.sy) < 16) continue;
          if (Math.hypot(pt.x - mw.ex, pt.y - mw.ey) < 16) continue;

          const nearExisting = this.interchanges.some(
            (ic) => Math.hypot(ic.x - pt.x, ic.y - pt.y) < 22,
          );
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

          const pPrev = samples[Math.max(0, i - 1)];
          const pNext = samples[Math.min(samples.length - 1, i + 1)];
          const angleRad = Math.atan2(pNext.y - pPrev.y, pNext.x - pPrev.x);
          const cosA = Math.cos(angleRad);
          const sinA = Math.sin(angleRad);
          const nx = -sinA;
          const ny = cosA;

          // Case A1: Does `mw` cross directly over an existing octilinear surface road here?
          const existingUnderpass = this.findExistingOctilinearUnderpass(
            pt,
            cosA,
            sinA,
            nx,
            ny,
          );
          if (existingUnderpass) {
            const { posTerm, negTerm } = existingUnderpass;
            const dPos = Math.hypot(
              posTerm.x - nearestTown.x,
              posTerm.y - nearestTown.y,
            );
            const dNeg = Math.hypot(
              negTerm.x - nearestTown.x,
              negTerm.y - nearestTown.y,
            );
            const connSide = dPos <= dNeg ? 1 : -1;
            const score = 95 - minTownDist;
            if (score > bestScore) {
              bestScore = score;
              bestCandidate = {
                kCenter: i,
                x: pt.x,
                y: pt.y,
                angleRad,
                connSide,
                posTerm,
                negTerm,
                existingUnderpass: true,
                nearestTown,
              };
            }
            continue;
          }

          // Case T1: New octilinear surface underpass stem (`0°/45°/90°` integer grid) for an unserved town
          const townAlreadyServed = this.interchanges.some(
            (ic) =>
              ic.townId === nearestTown.id ||
              ic.townName === nearestTown.name ||
              (ic.isAirportStub &&
                this.airports[ic.airportId]?.hostTownId === nearestTown.id),
          );
          if (townAlreadyServed) continue;

          // Pick the octilinear step `(sdx, sdy)` closest to the expressway normal `(nx, ny)`
          let bestDir = octDirs[0];
          let bestAlign = -1;
          let dirSign = 1;
          for (const od of octDirs) {
            const dot = (od.dx * nx + od.dy * ny) / od.len;
            const scoreAlign = Math.abs(dot) * od.weight;
            if (scoreAlign > bestAlign) {
              bestAlign = scoreAlign;
              bestDir = od;
              dirSign = dot >= 0 ? 1 : -1;
            }
          }
          const sdx = bestDir.dx * dirSign;
          const sdy = bestDir.dy * dirSign;
          const alignCos = Math.max(
            0.65,
            Math.abs((sdx * nx + sdy * ny) / bestDir.len),
          );
          const stepReach =
            sdx !== 0 && sdy !== 0
              ? Math.max(2, Math.round(2.85 / (bestDir.len * alignCos)))
              : Math.max(3, Math.round(2.85 / alignCos));

          const posTerm = { x: gx + sdx * stepReach, y: gy + sdy * stepReach };
          const negTerm = { x: gx - sdx * stepReach, y: gy - sdy * stepReach };
          if (
            !this.inBounds(posTerm.x, posTerm.y, 5) ||
            !this.inBounds(negTerm.x, negTerm.y, 5)
          )
            continue;

          let stemDry = true;
          for (let s = -stepReach; s <= stepReach; s++) {
            const sx2 = gx + sdx * s;
            const sy2 = gy + sdy * s;
            const sid = this.idx(sx2, sy2);
            if (
              this.waterMask[sid] > 0 ||
              this.distToWater[sid] < 2.2 ||
              this.buildingMask[sid] === 3 ||
              this.isPointInAirportPad(sx2, sy2, 2.5)
            ) {
              stemDry = false;
              break;
            }
          }
          if (!stemDry) continue;

          const dPos = Math.hypot(
            posTerm.x - nearestTown.x,
            posTerm.y - nearestTown.y,
          );
          const dNeg = Math.hypot(
            negTerm.x - nearestTown.x,
            negTerm.y - nearestTown.y,
          );
          const connSide = dPos <= dNeg ? 1 : -1;
          const farTermCand = connSide === 1 ? negTerm : posTerm;

          // Check if the opposite side (`-connSide`) has a reachable road or town within 28 tiles
          let hasOppositeRoad = false;
          for (let dy = -20; dy <= 20 && !hasOppositeRoad; dy += 2) {
            for (let dx = -20; dx <= 20; dx += 2) {
              const rx = farTermCand.x + dx;
              const ry = farTermCand.y + dy;
              if (
                !this.inBounds(rx, ry, 2) ||
                this.roadGrid[this.idx(rx, ry)] === 0
              )
                continue;
              const sideV = ((rx - gx) * nx + (ry - gy) * ny) * -connSide;
              if (sideV >= 3.0 && Math.hypot(dx, dy) <= 22) {
                hasOppositeRoad = true;
                break;
              }
            }
          }

          // Cap pure one-sided Diamond-T interchanges (`!hasOppositeRoad`) to at most 1 per expressway
          const existingOneSidedOnMw = this.interchanges.some(
            (ic) =>
              ic.type === "diamond-ramp" &&
              ic.mwayNumber === mw.number &&
              !ic.isThroughDiamond,
          );
          if (!hasOppositeRoad && existingOneSidedOnMw) continue;

          const wingClear = !this.roads.some((r) =>
            r.points.some((rp) => Math.hypot(rp.x - pt.x, rp.y - pt.y) < 3.6),
          );
          if (!wingClear) continue;

          const score = 50 - minTownDist + (hasOppositeRoad ? 32 : 0);
          if (score > bestScore) {
            bestScore = score;
            bestCandidate = {
              kCenter: i,
              x: gx,
              y: gy,
              angleRad,
              connSide,
              posTerm,
              negTerm,
              sdx,
              sdy,
              stepReach,
              existingUnderpass: false,
              nearestTown,
            };
          }
        }

        if (bestCandidate) {
          const {
            kCenter,
            x,
            y,
            angleRad,
            connSide,
            posTerm,
            negTerm,
            sdx,
            sdy,
            stepReach,
            existingUnderpass,
            nearestTown,
          } = bestCandidate;
          const cosA = Math.cos(angleRad);
          const sinA = Math.sin(angleRad);
          const nx = -sinA;
          const ny = cosA;

          const nearTerm = connSide === 1 ? posTerm : negTerm;
          const farTerm = connSide === 1 ? negTerm : posTerm;

          let isThroughDiamond = Boolean(existingUnderpass);

          if (!existingUnderpass) {
            const makeSideBlockFn = (sideSign, termPt) => (tx, ty) => {
              const dx = tx - x;
              const dy = ty - y;
              const u = dx * cosA + dy * sinA;
              const v = (dx * nx + dy * ny) * sideSign;
              if (Math.abs(u) < 16 && v < 1.8) return true;
              if (termPt && Math.hypot(tx - termPt.x, ty - termPt.y) <= 4.5) {
                const outDot =
                  (tx - termPt.x) * (sdx * sideSign) +
                  (ty - termPt.y) * (sdy * sideSign);
                if (outDot < 0) return true;
              }
              for (let s = 0; s < samples.length; s += 2) {
                if (Math.hypot(tx - samples[s].x, ty - samples[s].y) < 1.6)
                  return true;
              }
              return false;
            };

            const connectorPath = this.findRoadPathAStar(
              nearTerm.x,
              nearTerm.y,
              nearestTown.x,
              nearestTown.y,
              false,
              makeSideBlockFn(connSide, nearTerm),
              true,
            );
            if (!connectorPath || connectorPath.length < 2) continue;

            // Also check if `farTerm` on `-connSide` can connect to a road or town within 28 tiles (`A1 Through-Diamond`)
            let oppConnectorPath = null;
            let oppTargetPt = null;
            let bestOppD = 28;
            for (const t of this.towns) {
              const sideV = ((t.x - x) * nx + (t.y - y) * ny) * -connSide;
              const d = Math.hypot(t.x - farTerm.x, t.y - farTerm.y);
              if (sideV >= 3.0 && d < bestOppD) {
                bestOppD = d;
                oppTargetPt = { x: t.x, y: t.y };
              }
            }
            if (!oppTargetPt) {
              for (let dy = -22; dy <= 22; dy += 2) {
                for (let dx = -22; dx <= 22; dx += 2) {
                  const rx = farTerm.x + dx;
                  const ry = farTerm.y + dy;
                  if (
                    !this.inBounds(rx, ry, 2) ||
                    this.roadGrid[this.idx(rx, ry)] === 0
                  )
                    continue;
                  const sideV = ((rx - x) * nx + (ry - y) * ny) * -connSide;
                  const d = Math.hypot(dx, dy);
                  if (sideV >= 3.2 && d >= 2.0 && d < bestOppD) {
                    bestOppD = d;
                    oppTargetPt = { x: rx, y: ry };
                  }
                }
              }
            }
            if (oppTargetPt) {
              const candOpp = this.findRoadPathAStar(
                farTerm.x,
                farTerm.y,
                oppTargetPt.x,
                oppTargetPt.y,
                false,
                makeSideBlockFn(-connSide, farTerm),
                true,
              );
              if (candOpp && candOpp.length >= 2 && candOpp.length <= 28) {
                oppConnectorPath = candOpp;
                isThroughDiamond = true;
              }
            }

            this.displaceBuildingsInRadius(x, y, 4.2);
            this.displaceBuildingsInRadius(posTerm.x, posTerm.y, 2.5);
            this.displaceBuildingsInRadius(negTerm.x, negTerm.y, 2.5);

            // Commit the straight octilinear underpass stem from `farTerm` through `(x, y)` to `nearTerm`
            const stemPts = [];
            for (let s = -stepReach; s <= stepReach; s++) {
              const stepSign = connSide * s;
              stemPts.push({
                x: x + sdx * stepSign,
                y: y + sdy * stepSign,
                isBridge: false,
              });
            }
            this.commitRoadPath(stemPts, "arterial", {
              isUnderpassStem: !isThroughDiamond,
            });
            this.commitRoadPath(connectorPath, "arterial");
            if (oppConnectorPath) {
              this.commitRoadPath(oppConnectorPath, "arterial");
            }
          } else {
            // Existing octilinear surface road underpass (`A1`): keep the road course 100% unaltered,
            // only clearing buildings/trees underneath the 4 flexible slip-ramps!
            this.displaceBuildingsInRadius(x, y, 3.8);
          }

          this.trees = this.trees.filter((tr) => {
            const dx = tr.x - x;
            const dy = tr.y - y;
            const u = Math.abs(dx * cosA + dy * sinA);
            const v = Math.abs(dx * nx + dy * ny);
            return !(u <= 4.1 && v <= 3.7);
          });

          const crossPt = this.intersectUnderpassWithMotorway(
            samples,
            kCenter,
            negTerm,
            posTerm,
          );
          const ramps = this.buildFlexibleDiamondRamps(
            mw,
            crossPt.k,
            crossPt,
            posTerm,
            negTerm,
            connSide,
            isThroughDiamond,
          );

          /** @type {DiamondRampInterchange} */
          const diamondIc = {
            type: "diamond-ramp",
            x: crossPt.x,
            y: crossPt.y,
            connSide,
            posTerm,
            negTerm,
            termX: nearTerm.x,
            termY: nearTerm.y,
            oppTermX: farTerm.x,
            oppTermY: farTerm.y,
            connectX: nearTerm.x,
            connectY: nearTerm.y,
            isThroughDiamond,
            ramps,
            angleRad: crossPt.angleRad,
            mwayNumber: mw.number,
            townName: nearestTown.name,
            label: isThroughDiamond
              ? `M-${mw.number} / ${nearestTown.name} Diamond Interchange`
              : `M-${mw.number} / ${nearestTown.name} Diamond-T Interchange`,
          };

          this.interchanges.push(diamondIc);
        }
      }
    }
  }

  buildNumberedMotorways() {
    let mwayNumber = 1;
    const maxStateMotorways = 6;

    const townPop = (t) =>
      (t.housesCount + t.destinationsCount * 3 + 16) *
      (t.airportId !== null ? 1.35 : 1) *
      (t.tier === 1 ? 1.45 : 1.0);
    const townMotorwayDegree = new Int8Array(this.towns.length);
    const connectedClusters = new Set();

    const isTownNearAnyMotorway = (town, maxDist = 22) => {
      for (const mw of this.motorways) {
        for (let i = 0; i < mw.samples.length; i += 2) {
          if (
            Math.hypot(town.x - mw.samples[i].x, town.y - mw.samples[i].y) <
            maxDist
          ) {
            return true;
          }
        }
      }
      return false;
    };

    // Helper: If `town` hosts an unserved International Hub Airport whose landside gate
    // faces `towardX, towardY`, anchor the expressway directly to `(ap.gateX, ap.gateY)`
    // so the International Hub is never stranded 12-16 tiles away from its own city's stub!
    const resolveTownOrHubEndpoint = (
      town,
      towardX,
      towardY,
      allowHub = true,
    ) => {
      const ap = town.airportId !== null ? this.airports[town.airportId] : null;
      if (allowHub && ap && ap.isHub && ap.motorwayId === null) {
        const dGate = Math.hypot(towardX - ap.gateX, towardY - ap.gateY) || 1;
        const alignGate =
          ((towardX - ap.gateX) * ap.landNx +
            (towardY - ap.gateY) * ap.landNy) /
          dGate;
        if (alignGate >= -0.62) {
          return {
            stub: this.createTerminalStreetStub(ap, true, towardX, towardY),
            ap,
            usedHubGate: true,
          };
        }
      }
      return {
        stub: this.createTerminalStreetStub(town, false, towardX, towardY),
        ap: null,
        usedHubGate: false,
      };
    };

    const isIslandHopper = this.config.archetype === "island-hopper";
    const scaleSpan = Math.max(1, this.W / 360);
    // Only Tier-1 Metropolises, Tier-2 Regional Cities, and Airport Host Cities serve as motorway termini
    const isMajorMotorwayHub = (t) =>
      t.tier <= 2 || t.airportId !== null || (isIslandHopper && t.tier <= 3);

    // 1A. Primary Inter-Cluster Interstate Spine (M-1) between the two highest-gravity Metropolises/Cities
    const pairs = [];
    for (let i = 0; i < this.towns.length; i++) {
      const tA = this.towns[i];
      if (!isMajorMotorwayHub(tA)) continue;
      for (let j = i + 1; j < this.towns.length; j++) {
        const tB = this.towns[j];
        if (!isMajorMotorwayHub(tB)) continue;
        const d = Math.hypot(tA.x - tB.x, tA.y - tB.y);
        const minPairD = isIslandHopper ? 36 : 78;
        if (d < minPairD || d > 245 * scaleSpan) continue;
        const sameIslandBonus =
          isIslandHopper && tA.landmassId === tB.landmassId ? 3.5 : 1.0;
        const diffClusterBonus = tA.clusterId !== tB.clusterId ? 4.2 : 0.18;
        const metroBonus =
          (tA.tier === 1 ? 1.6 : 1.0) * (tB.tier === 1 ? 1.6 : 1.0);
        const spanBell =
          0.7 +
          0.6 *
            Math.exp(-Math.pow((d - 135 * scaleSpan) / (56 * scaleSpan), 2));
        const gravity =
          ((townPop(tA) * townPop(tB)) / Math.pow(d, 0.38)) *
          diffClusterBonus *
          metroBonus *
          spanBell *
          sameIslandBonus;
        pairs.push({ tA, tB, gravity, d });
      }
    }
    pairs.sort((a, b) => b.gravity - a.gravity);

    let primaryPair = null;

    for (const cand of pairs) {
      const { tA, tB } = cand;
      const endA = resolveTownOrHubEndpoint(tA, tB.x, tB.y, true);
      const endB = resolveTownOrHubEndpoint(tB, tA.x, tA.y, !endA.usedHubGate);

      if (
        Math.hypot(endB.stub.x - endA.stub.x, endB.stub.y - endA.stub.y) <
        (isIslandHopper ? 24 : 38)
      ) {
        if (!endA.usedHubGate)
          this.removeOrphanedTerminalStub(endA.stub.x, endA.stub.y);
        if (!endB.usedHubGate)
          this.removeOrphanedTerminalStub(endB.stub.x, endB.stub.y);
        continue;
      }
      const startX = endB.usedHubGate ? endB.stub.x : endA.stub.x;
      const startY = endB.usedHubGate ? endB.stub.y : endA.stub.y;
      const endX = endB.usedHubGate ? endA.stub.x : endB.stub.x;
      const endY = endB.usedHubGate ? endA.stub.y : endB.stub.y;
      const startApId = endA.usedHubGate
        ? endA.ap.id
        : endB.usedHubGate
          ? endB.ap.id
          : null;

      const mw1 = this.createMotorwayEntity(
        mwayNumber,
        startX,
        startY,
        endX,
        endY,
        startApId,
        tB.id,
      );
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
        if (!endA.usedHubGate)
          this.removeOrphanedTerminalStub(endA.stub.x, endA.stub.y);
        if (!endB.usedHubGate)
          this.removeOrphanedTerminalStub(endB.stub.x, endB.stub.y);
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
          if (d < 46 || d > 235 * scaleSpan) continue;
          const tierWeight =
            (tC.tier <= 2 ? 1.8 : 1.0) * (tD.tier <= 2 ? 1.8 : 1.0);
          const score =
            ((townPop(tC) * townPop(tD)) / Math.pow(d, 0.35)) * tierWeight;
          crossPairs.push({ tC, tD, score });
        }
      }
      crossPairs.sort((a, b) => b.score - a.score);

      for (const { tC, tD } of crossPairs) {
        const endC = resolveTownOrHubEndpoint(tC, tD.x, tD.y, true);
        const endD = resolveTownOrHubEndpoint(
          tD,
          tC.x,
          tC.y,
          !endC.usedHubGate,
        );
        const sx = endD.usedHubGate ? endD.stub.x : endC.stub.x;
        const sy = endD.usedHubGate ? endD.stub.y : endC.stub.y;
        const ex = endD.usedHubGate ? endC.stub.x : endD.stub.x;
        const ey = endD.usedHubGate ? endC.stub.y : endD.stub.y;
        const startApId = endC.usedHubGate
          ? endC.ap.id
          : endD.usedHubGate
            ? endD.ap.id
            : null;

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
          if (
            !this.isCloverleafFootprintDry(
              pt.x,
              pt.y,
              mAng,
              crossAng,
              [-1, 1],
              [-1, 1],
            )
          )
            continue;
          const dMid =
            Math.hypot(pt.x - midX, pt.y - midY) +
            this.interchangeRoadOverlapCost(pt.x, pt.y, 4.4) * 0.45;
          if (dMid < minViaDist) {
            minViaDist = dMid;
            bestViaPt = pt;
          }
        }

        const mw2 = this.createMotorwayEntity(
          mwayNumber,
          sx,
          sy,
          ex,
          ey,
          startApId,
          tD.id,
          bestViaPt,
        );
        const crossesM1 =
          mw2 &&
          this.findPolylineIntersection(mw1.samples, mw2.samples) !== null;
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
          if (!endC.usedHubGate)
            this.removeOrphanedTerminalStub(endC.stub.x, endC.stub.y);
          if (!endD.usedHubGate)
            this.removeOrphanedTerminalStub(endD.stub.x, endD.stub.y);
        }
      }
    }

    // 2. Connect All Remaining Metropolitan Clusters into the State Interstate Network
    //    (via 3-way Trumpet Spurs onto existing trunks, shared pass-through beltways, or Cloverleafs)
    const clusterMetros = [...this.clusters].sort(
      (a, b) => townPop(b) - townPop(a),
    );
    for (
      let pass = 0;
      pass < 2 && this.motorways.length < maxStateMotorways;
      pass++
    ) {
      for (const metro of clusterMetros) {
        if (this.motorways.length >= maxStateMotorways) break;
        if (
          connectedClusters.has(metro.clusterId) ||
          isTownNearAnyMotorway(metro, 26)
        ) {
          connectedClusters.add(metro.clusterId);
          continue;
        }

        // 2A. Try a 3-way Trumpet Spur from this Cluster Metropolis (or any Tier-1/2 city in its cluster) into an existing trunk
        const clusterTowns = [
          metro,
          ...this.towns
            .filter(
              (t) =>
                t.clusterId === metro.clusterId &&
                t.id !== metro.id &&
                t.tier <= 3,
            )
            .sort((a, b) => a.tier - b.tier),
        ];
        let linkedCluster = false;

        for (const cTown of clusterTowns) {
          if (linkedCluster) break;
          let bestTargetPt = { x: this.W * 0.5, y: this.H * 0.5 };
          let minD = Infinity;
          for (const mw of this.motorways) {
            for (
              let s = Math.floor(mw.samples.length * 0.16);
              s <= Math.ceil(mw.samples.length * 0.84);
              s += 3
            ) {
              const d = Math.hypot(
                cTown.x - mw.samples[s].x,
                cTown.y - mw.samples[s].y,
              );
              if (d < minD) {
                minD = d;
                bestTargetPt = mw.samples[s];
              }
            }
          }

          for (const tryHub of [true, false]) {
            if (linkedCluster) break;
            const mEnd = resolveTownOrHubEndpoint(
              cTown,
              bestTargetPt.x,
              bestTargetPt.y,
              tryHub,
            );
            if (!tryHub && mEnd.usedHubGate) continue;
            const spurRes = this.tryBuildTrumpetSpurToTrunk(
              mwayNumber,
              mEnd.stub.x,
              mEnd.stub.y,
              mEnd.usedHubGate ? mEnd.ap.id : null,
              cTown.id,
            );
            if (spurRes) {
              if (mEnd.usedHubGate) mEnd.ap.motorwayId = mwayNumber;
              mwayNumber++;
              this.motorways.push(spurRes.mw);
              this.displaceBuildingsInRadius(
                spurRes.trumpetIc.x,
                spurRes.trumpetIc.y,
                5.2,
              );
              this.displaceAndRerouteRoadsAtInterchange(
                spurRes.trumpetIc,
                false,
              );
              this.interchanges.push(spurRes.trumpetIc);
              townMotorwayDegree[cTown.id]++;
              connectedClusters.add(metro.clusterId);
              linkedCluster = true;
              break;
            } else if (!mEnd.usedHubGate) {
              this.removeOrphanedTerminalStub(mEnd.stub.x, mEnd.stub.y);
            } else {
              this.interchanges = this.interchanges.filter(
                (ic) =>
                  !(
                    ic.type === "terminal-stub" &&
                    ic.isAirportStub &&
                    ic.airportId === mEnd.ap.id
                  ),
              );
            }
          }
        }
        if (linkedCluster) continue;

        // 2B. Otherwise link `cTown` to an already-connected hub town via a shared beltway stub or Cloverleaf crossing
        //     (or on pass 1 for a Tier-1 Metropolis separated by a wide marine sound, link to the nearest Tier-1/2 city on its landmass)
        for (const cTown of clusterTowns) {
          if (linkedCluster) break;
          const hubCandidates = this.towns
            .filter(
              (t) =>
                t.id !== cTown.id &&
                isMajorMotorwayHub(t) &&
                (townMotorwayDegree[t.id] === 1 ||
                  connectedClusters.has(t.clusterId) ||
                  (pass === 1 && (metro.tier === 1 || isIslandHopper))),
            )
            .sort((a, b) => {
              if (isIslandHopper) {
                const sameLm =
                  (b.landmassId === cTown.landmassId ? 1 : 0) -
                  (a.landmassId === cTown.landmassId ? 1 : 0);
                if (sameLm !== 0) return sameLm;
              }
              const degDiff =
                (townMotorwayDegree[b.id] === 1 ? 1 : 0) -
                (townMotorwayDegree[a.id] === 1 ? 1 : 0);
              if (degDiff !== 0) return degDiff;
              return (
                Math.hypot(a.x - cTown.x, a.y - cTown.y) -
                Math.hypot(b.x - cTown.x, b.y - cTown.y)
              );
            });

          for (const hubTown of hubCandidates) {
            if (townMotorwayDegree[hubTown.id] >= 2) continue;
            const d = Math.hypot(hubTown.x - cTown.x, hubTown.y - cTown.y);
            if (d < (isIslandHopper ? 24 : 34) || d > 225 * scaleSpan) continue;
            const canShare =
              townMotorwayDegree[hubTown.id] === 1 &&
              this.findPassThroughStubAtTown(hubTown, cTown.x, cTown.y) !==
                null;
            if (townMotorwayDegree[hubTown.id] >= 1 && !canShare) continue;

            const endA = resolveTownOrHubEndpoint(
              cTown,
              hubTown.x,
              hubTown.y,
              true,
            );
            const endB = resolveTownOrHubEndpoint(
              hubTown,
              cTown.x,
              cTown.y,
              !endA.usedHubGate,
            );
            const stubSpan = Math.hypot(
              endB.stub.x - endA.stub.x,
              endB.stub.y - endA.stub.y,
            );
            if (stubSpan < 22) {
              if (!endA.usedHubGate)
                this.removeOrphanedTerminalStub(endA.stub.x, endA.stub.y);
              if (!endB.usedHubGate)
                this.removeOrphanedTerminalStub(endB.stub.x, endB.stub.y);
              continue;
            }
            const startX = endB.usedHubGate ? endB.stub.x : endA.stub.x;
            const startY = endB.usedHubGate ? endB.stub.y : endA.stub.y;
            const endX = endB.usedHubGate ? endA.stub.x : endB.stub.x;
            const endY = endB.usedHubGate ? endA.stub.y : endB.stub.y;
            const startApId = endA.usedHubGate
              ? endA.ap.id
              : endB.usedHubGate
                ? endB.ap.id
                : null;

            const mwCluster = this.createMotorwayEntity(
              mwayNumber,
              startX,
              startY,
              endX,
              endY,
              startApId,
              hubTown.id,
            );
            const crossesExisting =
              mwCluster &&
              this.motorways.some(
                (m) =>
                  this.findPolylineIntersection(
                    m.samples,
                    mwCluster.samples,
                  ) !== null,
              );
            const allowStandalonePass1 =
              pass === 1 &&
              (metro.tier === 1 || (isIslandHopper && stubSpan >= 36));
            if (
              mwCluster &&
              (canShare || crossesExisting || allowStandalonePass1)
            ) {
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
              if (!endA.usedHubGate)
                this.removeOrphanedTerminalStub(endA.stub.x, endA.stub.y);
              if (!endB.usedHubGate)
                this.removeOrphanedTerminalStub(endB.stub.x, endB.stub.y);
            }
          }
        }
      }
    }

    // 3. International Hub & Regional Airport Expressways
    const sortedAirports = [...this.airports].sort(
      (a, b) => (b.isHub ? 1 : 0) - (a.isHub ? 1 : 0),
    );
    for (const ap of sortedAirports) {
      if (ap.motorwayId !== null) continue;
      if (!ap.isHub && this.motorways.length >= maxStateMotorways) continue;
      const host = this.towns[ap.hostTownId];
      if (!ap.isHub && host && isTownNearAnyMotorway(host, 24)) continue;

      let builtApMotorway = false;

      // 3A. Try connecting the airport gate directly into an existing trunk motorway via a 3-way Trumpet Interchange
      const apStubForSpur = this.createTerminalStreetStub(
        ap,
        true,
        ap.x + ap.landNx * 35,
        ap.y + ap.landNy * 35,
      );
      const spurRes = this.tryBuildTrumpetSpurToTrunk(
        mwayNumber,
        apStubForSpur.x,
        apStubForSpur.y,
        ap.id,
        ap.hostTownId,
      );
      if (spurRes) {
        ap.motorwayId = mwayNumber++;
        this.motorways.push(spurRes.mw);
        if (host) townMotorwayDegree[host.id]++;
        this.displaceBuildingsInRadius(
          spurRes.trumpetIc.x,
          spurRes.trumpetIc.y,
          5.2,
        );
        this.displaceAndRerouteRoadsAtInterchange(spurRes.trumpetIc, false);
        this.interchanges.push(spurRes.trumpetIc);
        builtApMotorway = true;
      }

      // 3B. Otherwise connect the airport gate to a major landside city hub that links into the trunk network
      const minAlignPasses = ap.isHub ? [0.32, -0.05] : [0.4];
      for (const minAlign of minAlignPasses) {
        if (builtApMotorway) break;
        const townCandidates = [];
        for (const t of this.towns) {
          if (!isMajorMotorwayHub(t)) continue;
          if (townMotorwayDegree[t.id] >= 2) continue;
          const canSharePassThrough =
            townMotorwayDegree[t.id] === 1 &&
            this.findPassThroughStubAtTown(t, ap.gateX, ap.gateY) !== null;
          if (townMotorwayDegree[t.id] >= 1 && !canSharePassThrough) continue;
          if (
            primaryPair &&
            ((primaryPair.tA.id === ap.hostTownId &&
              primaryPair.tB.id === t.id) ||
              (primaryPair.tB.id === ap.hostTownId &&
                primaryPair.tA.id === t.id))
          ) {
            continue;
          }
          const dx = t.x - ap.x;
          const dy = t.y - ap.y;
          const landV = dx * ap.landNx + dy * ap.landNy;
          if (landV < 3.0) continue;

          const gateDist = Math.hypot(t.x - ap.gateX, t.y - ap.gateY);
          const minSpan =
            canSharePassThrough || townMotorwayDegree[t.id] >= 1
              ? ap.isHub
                ? 18
                : 26
              : 44;
          if (gateDist < minSpan || gateDist > 185 * scaleSpan) continue;

          const alignCos =
            ((t.x - ap.gateX) * ap.landNx + (t.y - ap.gateY) * ap.landNy) /
            (gateDist || 1);
          if (alignCos < minAlign) continue;

          const isHost = t.id === ap.hostTownId;
          const networkLinkBonus = canSharePassThrough
            ? 5.0
            : connectedClusters.has(t.clusterId)
              ? 1.8
              : 0.85;
          const score =
            (townPop(t) / Math.pow(gateDist, 0.58)) *
            (0.55 + 0.65 * Math.max(0, alignCos)) *
            (isHost ? 1.15 : 1.0) *
            networkLinkBonus;
          townCandidates.push({ town: t, score, canSharePassThrough });
        }

        townCandidates.sort((a, b) => b.score - a.score);

        for (const {
          town: targetTown,
          canSharePassThrough,
        } of townCandidates) {
          const apStub = this.createTerminalStreetStub(
            ap,
            true,
            targetTown.x,
            targetTown.y,
          );
          const townStub = this.createTerminalStreetStub(
            targetTown,
            false,
            ap.gateX,
            ap.gateY,
          );
          const stubChord = Math.hypot(
            townStub.x - apStub.x,
            townStub.y - apStub.y,
          );
          if (stubChord < (ap.isHub ? 18 : 24)) {
            this.removeOrphanedTerminalStub(townStub.x, townStub.y);
            continue;
          }

          const mwAp = this.createMotorwayEntity(
            mwayNumber,
            apStub.x,
            apStub.y,
            townStub.x,
            townStub.y,
            ap.id,
            targetTown.id,
          );
          const connectsToTrunk =
            mwAp &&
            (this.motorways.length === 0 ||
              canSharePassThrough ||
              this.motorways.some(
                (m) =>
                  this.findPolylineIntersection(m.samples, mwAp.samples) !==
                  null,
              ) ||
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
      .filter(
        (t) =>
          isMajorMotorwayHub(t) &&
          townMotorwayDegree[t.id] === 0 &&
          !isTownNearAnyMotorway(t, 24),
      )
      .sort((a, b) => townPop(b) - townPop(a));

    for (const uTown of underservedTowns) {
      if (this.motorways.length >= maxStateMotorways) break;
      let targetPt = { x: this.W * 0.5, y: this.H * 0.5 };
      let minTrunkD = Infinity;
      for (const mw of this.motorways) {
        for (
          let s = Math.floor(mw.samples.length * 0.2);
          s <= Math.ceil(mw.samples.length * 0.8);
          s += 3
        ) {
          const d = Math.hypot(
            uTown.x - mw.samples[s].x,
            uTown.y - mw.samples[s].y,
          );
          if (d < minTrunkD) {
            minTrunkD = d;
            targetPt = mw.samples[s];
          }
        }
      }
      const stub = this.createTerminalStreetStub(
        uTown,
        false,
        targetPt.x,
        targetPt.y,
      );
      const spurRes = this.tryBuildTrumpetSpurToTrunk(
        mwayNumber,
        stub.x,
        stub.y,
        null,
        uTown.id,
      );
      if (spurRes) {
        mwayNumber++;
        this.motorways.push(spurRes.mw);
        this.displaceBuildingsInRadius(
          spurRes.trumpetIc.x,
          spurRes.trumpetIc.y,
          5.2,
        );
        this.displaceAndRerouteRoadsAtInterchange(spurRes.trumpetIc, false);
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
    this.displaceBuildingsAlongMotorwayCorridors();
    this.pruneEmptyOuterStreets();

    const cloverCount = this.interchanges.filter(
      (i) => i.type === "cloverleaf" || i.type === "trumpet",
    ).length;
    const rampCount = this.interchanges.filter(
      (i) => i.type === "diamond-ramp",
    ).length;
    const tunnelCount = this.motorways.reduce(
      (acc, m) => acc + (m.tunnels ? m.tunnels.length : 0),
      0,
    );
    this.logs.push(
      `Built <b>${this.motorways.length} expressways</b>, <b>${cloverCount} system interchanges</b>, <b>${rampCount} ramps</b>${tunnelCount > 0 ? ` & <b>${tunnelCount} mountain tunnels</b>` : ""} (displaced ${this.displacedBuildingsCount} buildings).`,
    );
  }

  /**
   * Clears any houses or urban commercial/industrial building lots whose footprints intersect
   * the surface right-of-way of a numbered expressway (excluding subterranean mountain tunnel spans)
   * so elevated expressway decks never overlap underlying building roofs in close-up zoom.
   */
  displaceBuildingsAlongMotorwayCorridors() {
    const surfacePts = [];
    const surfaceSegs = [];
    for (const mw of this.motorways) {
      const samples = mw.samples || [];
      const tunnels = mw.tunnels || [];
      for (let i = 0; i < samples.length; i++) {
        const inTunnel = tunnels.some((t) => i >= t.i0 && i <= t.i1);
        if (!inTunnel) {
          surfacePts.push(samples[i]);
          if (i < samples.length - 1) {
            const nextInTunnel = tunnels.some(
              (t) => i + 1 >= t.i0 && i + 1 <= t.i1,
            );
            if (!nextInTunnel) {
              surfaceSegs.push([samples[i], samples[i + 1]]);
            }
          }
        }
      }
    }
    if (surfacePts.length === 0) return;

    const distSqToSurface = (px, py) => {
      let minD2 = Infinity;
      for (let i = 0; i < surfaceSegs.length; i++) {
        const [a, b] = surfaceSegs[i];
        const dx = b.x - a.x,
          dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq > 1e-6 ? ((px - a.x) * dx + (py - a.y) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const qx = a.x + t * dx,
          qy = a.y + t * dy;
        const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
        if (d2 < minD2) minD2 = d2;
      }
      return minD2;
    };

    const beforeHouses = this.houses.length;
    this.houses = this.houses.filter((h) => {
      const hit = distSqToSurface(h.x, h.y) <= 1.85 * 1.85;
      if (hit) {
        const hid = this.idx(h.x, h.y);
        if (this.buildingMask[hid] === 1) this.buildingMask[hid] = 0;
        const t = this.towns[h.townId];
        if (t && t.housesCount > 0) t.housesCount--;
        return false;
      }
      return true;
    });

    const isAcrossExpressway = (fx, fy, tx, ty) => {
      const dx = tx - fx;
      const dy = ty - fy;
      const lenSq = dx * dx + dy * dy;
      if (lenSq <= 1.0) return false;
      for (let i = 0; i < surfacePts.length; i++) {
        const sp = surfacePts[i];
        // Ray-segment check: if the expressway passes between the farmstead `(fx, fy)` and tile `(tx, ty)`
        const t = ((sp.x - fx) * dx + (sp.y - fy) * dy) / lenSq;
        if (t > 0.06 && t < 1.02) {
          const px = fx + t * dx;
          const py = fy + t * dy;
          if (
            (sp.x - px) * (sp.x - px) + (sp.y - py) * (sp.y - py) <=
            1.65 * 1.65
          )
            return true;
        }
      }
      return false;
    };

    const beforeDest = this.destinations.length;
    this.destinations = this.destinations.filter((d) => {
      if (
        d.resourceType === "FARM" &&
        d.bspParcels &&
        d.bspParcels.length > 0
      ) {
        const p0 = d.bspParcels[0];
        let anyClipped = false;
        const filteredRaw = d.bspParcels.map((p) => {
          const keptTiles = p.tiles.filter(
            ([tx, ty]) => !isAcrossExpressway(d.x, d.y, tx + 0.5, ty + 0.5),
          );
          if (keptTiles.length !== p.tiles.length) anyClipped = true;
          return { ...p, tiles: keptTiles };
        });
        if (anyClipped) {
          const rebuilt = this.finalizeFarmEstateFromParcels(
            filteredRaw,
            d.gx,
            d.gy,
            p0.slotIdx || 0,
            p0.spineAxis,
            p0.spineCoord,
          );
          d.bspParcels = rebuilt.bspParcels;
          d.estateLoops = rebuilt.estateLoops;
          d.tractorTracks = rebuilt.tractorTracks;
          d.windbreakPts = rebuilt.windbreakPts;
        }
      }
      if (d.isRuralNiche) return true;
      const wT = d.wTiles || 2;
      const hT = d.hTiles || 2;
      const cx = d.gx + (wT - 1) * 0.5;
      const cy = d.gy + (hT - 1) * 0.5;
      const rad = Math.max(wT, hT) * 0.5 + 1.25;
      const hit = distSqToSurface(cx, cy) <= rad * rad;
      if (hit) {
        for (let dy = 0; dy < hT; dy++) {
          for (let dx = 0; dx < wT; dx++) {
            const lid = this.idx(d.gx + dx, d.gy + dy);
            if (this.buildingMask[lid] === 2) this.buildingMask[lid] = 0;
          }
        }
        const t = this.towns[d.townId];
        if (t) {
          if (t.destinationsCount > 0) t.destinationsCount--;
          if (d.zoneType === "commercial" && t.commercialCount > 0)
            t.commercialCount--;
          if (d.zoneType === "industrial" && t.industrialCount > 0)
            t.industrialCount--;
        }
        return false;
      }
      return true;
    });

    this.displacedBuildingsCount +=
      beforeHouses -
      this.houses.length +
      (beforeDest - this.destinations.length);
  }

  /**
   * Scans interior spans of all numbered expressways for high-elevation mountain ridge crossings
   * (`elevationField >= seaLevel + 0.21`) and marks subterranean tunnel portals (`mw.tunnels`).
   */
  detectMountainExpresswayTunnels() {
    const tunnelThresh = this.seaLevel + 0.235;
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
          !this.interchanges.some(
            (ic) => Math.hypot(ic.x - pt.x, ic.y - pt.y) < 11.5,
          );

        if (isHighRidge && !inTunnel) {
          inTunnel = true;
          startIdx = i;
        } else if (!isHighRidge && inTunnel) {
          if (i - 1 - startIdx >= 5) {
            rawSpans.push({ i0: startIdx, i1: i - 1 });
          }
          inTunnel = false;
        }
      }
      if (inTunnel && samples.length - 7 - startIdx >= 5) {
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
            if (
              this.interchanges.some(
                (ic) => Math.hypot(ic.x - gpt.x, ic.y - gpt.y) < 12.5,
              )
            ) {
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
        if (i1 - i0 < 6) continue;
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
          ang1: Math.atan2(p1.y - p1Prev.y, p1.x - p1Prev.x),
        });
      }
    }
  }

  populateLandscapeTrees() {
    const isIslandHopper = this.config.archetype === "island-hopper";
    // Keep woodland tree canopies strictly clear of farm fields (`buildingMask === 5`) and farm roads (`tractorTracks`)
    const isNearFarmOrTrack = (tx, ty) => {
      const gx = Math.round(tx),
        gy = Math.round(ty);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (
            this.inBounds(gx + dx, gy + dy, 1) &&
            this.buildingMask[this.idx(gx + dx, gy + dy)] === 5
          ) {
            return true;
          }
        }
      }
      for (const d of this.destinations) {
        if (d.resourceType !== "FARM" || !d.tractorTracks) continue;
        for (const tr of d.tractorTracks) {
          const sdx = tr.x1 - tr.x0,
            sdy = tr.y1 - tr.y0;
          const lenSq = sdx * sdx + sdy * sdy;
          let t =
            lenSq > 1e-6
              ? ((tx - tr.x0) * sdx + (ty - tr.y0) * sdy) / lenSq
              : 0;
          t = Math.max(0, Math.min(1, t));
          if (Math.hypot(tx - (tr.x0 + t * sdx), ty - (tr.y0 + t * sdy)) < 2.8)
            return true;
        }
      }
      return false;
    };

    // Generate coherent upland woodland groves & windward rain-shadow forests (no confetti sprinkles!)
    for (let y = 5; y < this.H - 5; y += 2.4) {
      for (let x = 5; x < this.W - 5; x += 2.4) {
        const ix = Math.round(x),
          iy = Math.round(y);
        const id = this.idx(ix, iy);
        if (
          this.waterMask[id] > 0 ||
          this.buildingMask[id] > 0 ||
          this.roadGrid[id] > 0
        )
          continue;
        if (this.zoneColorIdx[id] >= 0) continue;
        const dWater = this.distToWater[id];
        const isSmallIslet = isIslandHopper && this.landmassId[id] < 0;
        if (dWater < (isSmallIslet ? 1.5 : 4.2)) continue;

        const hillHeight = Math.max(0, this.elevationField[id] - this.seaLevel);
        // True windward orographic moisture (`∇H · windVector`) + capped elevation boost
        // so high alpine crests (`+0.24` / `+0.36` contours) and leeward slopes preserve open negative space!
        const dzdx =
          (this.elevationField[this.idx(ix + 1, iy)] -
            this.elevationField[this.idx(ix - 1, iy)]) *
          0.5;
        const dzdy =
          (this.elevationField[this.idx(ix, iy + 1)] -
            this.elevationField[this.idx(ix, iy - 1)]) *
          0.5;
        const windUpslope = -(
          dzdx * this.windVector.x +
          dzdy * this.windVector.y
        );
        const moistureBias = Math.max(-0.18, Math.min(0.24, windUpslope * 5.5));
        const elevBoost =
          Math.min(0.23, hillHeight * 0.72) -
          Math.max(0, hillHeight - 0.3) * 0.55;
        const forestPatch =
          this.noise.fbm(x * 0.055 + 3.1, y * 0.055 + 8.4, 2) + moistureBias;
        if (
          (hillHeight > 0.12 && forestPatch + elevBoost > 0.58) ||
          (isSmallIslet && forestPatch > 0.4)
        ) {
          const groveCount = isSmallIslet
            ? this.rng.int(1, 3)
            : moistureBias > 0.05
              ? this.rng.int(2, 4)
              : this.rng.int(1, 3);
          for (let g = 0; g < groveCount; g++) {
            const tx = x + this.rng.range(-1.04, 1.04);
            const ty = y + this.rng.range(-1.04, 1.04);
            const gx = Math.round(tx),
              gy = Math.round(ty);
            if (!this.inBounds(gx, gy, 3)) continue;
            const gid = this.idx(gx, gy);
            if (
              this.waterMask[gid] > 0 ||
              this.buildingMask[gid] > 0 ||
              this.roadGrid[gid] > 0 ||
              this.zoneColorIdx[gid] >= 0
            )
              continue;
            if (isNearFarmOrTrack(tx, ty)) continue;
            this.trees.push({
              x: tx,
              y: ty,
              r: this.rng.range(0.44, 0.78),
              color: this.rng.pick(PALETTE.treeDots),
            });
          }
        }
      }
    }

    // Nestle interior mountain spring headwaters (`r.headwaterPt`) inside a lush highland forest grove
    // spanning `rad = 1.2..4.9` so it bridges seamlessly across the `dWater < 4.2` riparian setback!
    for (const rObj of this.rivers) {
      if (!rObj.headwaterPt) continue;
      const hx = rObj.headwaterPt.x;
      const hy = rObj.headwaterPt.y;
      for (let g = 0; g < 22; g++) {
        const ang = (g / 22) * Math.PI * 2 + this.rng.range(-0.25, 0.25);
        const rad = this.rng.range(1.2, 4.9);
        const tx = hx + Math.cos(ang) * rad;
        const ty = hy + Math.sin(ang) * rad;
        const gx = Math.round(tx),
          gy = Math.round(ty);
        if (!this.inBounds(gx, gy, 3)) continue;
        const gid = this.idx(gx, gy);
        if (
          this.waterMask[gid] > 0 ||
          this.buildingMask[gid] > 0 ||
          this.roadGrid[gid] > 0 ||
          this.zoneColorIdx[gid] >= 0
        )
          continue;
        this.trees.push({
          x: tx,
          y: ty,
          r: this.rng.range(0.52, 0.84),
          color: this.rng.pick(PALETTE.treeDots),
        });
      }
    }

    // Nestle out-of-town `TIMBER` Forestry Camps inside a lush woodland grove!
    for (const d of this.destinations) {
      if (d.resourceType !== "TIMBER") continue;
      for (let g = 0; g < 10; g++) {
        const ang = (g / 10) * Math.PI * 2 + this.rng.range(-0.28, 0.28);
        const rad = this.rng.range(2.1, 4.4);
        const tx = d.x + Math.cos(ang) * rad;
        const ty = d.y + Math.sin(ang) * rad;
        const gx = Math.round(tx),
          gy = Math.round(ty);
        if (!this.inBounds(gx, gy, 3)) continue;
        const gid = this.idx(gx, gy);
        if (
          this.waterMask[gid] > 0 ||
          this.buildingMask[gid] > 0 ||
          this.roadGrid[gid] > 0 ||
          this.zoneColorIdx[gid] >= 0
        )
          continue;
        this.trees.push({
          x: tx,
          y: ty,
          r: this.rng.range(0.48, 0.78),
          color: this.rng.pick(PALETTE.treeDots),
        });
      }
    }
  }
}
/**
 * Pure reactive/functional memoized stage combinator:
 * Compares the dependency tuple returned by `selectDeps(...args)` via `Object.is` (`===`).
 * Returns `{ value: Readonly<Out>, cached: boolean, version: number }` in O(1) on cache hit.
 *
 * @template {readonly unknown[]} Args
 * @template {readonly unknown[]} Deps
 * @template Out
 * @param {(...args: Args) => Deps} selectDeps
 * @param {(...depsAndVersion: [...Deps, number]) => Out} computeFn
 * @returns {(...args: Args) => { value: Readonly<Out>, cached: boolean, version: number }}
 */
export function createMemoStage(selectDeps, computeFn) {
  /** @type {Deps | null} */
  let prevDeps = null;
  /** @type {Readonly<Out> | null} */
  let cachedOutput = null;
  let version = 0;
  return (...args) => {
    const nextDeps = selectDeps(...args);
    const hit =
      prevDeps !== null &&
      cachedOutput !== null &&
      prevDeps.length === nextDeps.length &&
      prevDeps.every((val, idx) => Object.is(val, nextDeps[idx]));
    if (hit) {
      return {
        value: /** @type {Readonly<Out>} */ (cachedOutput),
        cached: true,
        version,
      };
    }
    prevDeps = nextDeps;
    version++;
    cachedOutput = Object.freeze(computeFn(...nextDeps, version));
    return { value: cachedOutput, cached: false, version };
  };
}

/** @param {Town} t @returns {Town} */
const cloneTown = (t) => ({
  ...t,
  boroughs: t.boroughs ? t.boroughs.map((b) => ({ ...b })) : [],
});

/** @param {RoadSegment} r @returns {RoadSegment} */
const cloneRoad = (r) => ({
  ...r,
  points: r.points.map((p) => ({ ...p })),
});

/** @param {Airport} a @returns {Airport} */
const cloneAirport = (a) => ({
  ...a,
  demandSchedule: a.demandSchedule ? { ...a.demandSchedule } : undefined,
});

/** @param {Destination['bspParcels']} list @returns {Destination['bspParcels']} */
const cloneParcelList = (list) =>
  list
    ? list.map((p) => ({
        ...p,
        tiles: p.tiles.map(
          (t) => /** @type {[number, number]} */ ([t[0], t[1]]),
        ),
        poly: p.poly
          ? p.poly.map((pt) => /** @type {[number, number]} */ ([pt[0], pt[1]]))
          : undefined,
      }))
    : undefined;

/** @param {Destination} d @returns {Destination} */
const cloneDestination = (d) => ({
  ...d,
  demandPins: d.demandPins ? [...d.demandPins] : [],
  bspParcels: cloneParcelList(d.bspParcels),
  estateLoops: d.estateLoops
    ? d.estateLoops.map((loop) =>
        loop.map((pt) => /** @type {[number, number]} */ ([pt[0], pt[1]])),
      )
    : undefined,
  tractorTracks: d.tractorTracks
    ? d.tractorTracks.map((tr) => ({ ...tr }))
    : undefined,
  windbreakPts: d.windbreakPts
    ? d.windbreakPts.map(
        (pt) => /** @type {[number, number]} */ ([pt[0], pt[1]]),
      )
    : undefined,
});

/**
 * Creates a stateful reactive memoized 9-stage world-generation DAG pipeline.
 * Each stage is a pure function of its explicit config slice + immutable upstream stage snapshots.
 * Optional `onHydrologyReady(s2bState, recomputed)` callback fires immediately after Stage 2B
 * so a parallel `TerrainBakeWorker` can begin rasterizing contours & rivers while Stages 3–9 run.
 *
 * @param {{
 *   onHydrologyReady?: ((s2bState: Readonly<Stage2BHydrologyState>, recomputed: boolean) => void) | null,
 *   onUrbanReady?: ((s2bState: Readonly<Stage2BHydrologyState>, s67State: Readonly<Stage67UrbanState>, terrainOrUrbanChanged: boolean) => void) | null
 * }} [options]
 * @returns {(config: GeneratorConfig, targetWorld?: ProceduralLogisticsWorld | null) => ProceduralLogisticsWorld}
 */
export function createWorldPipeline({
  onHydrologyReady = null,
  onUrbanReady = null,
} = {}) {
  // Single shared scratch workspace for stage execution (eliminates 8×16 TypedArray allocations per world)
  const w = new ProceduralLogisticsWorld({});

  const memoNoise = createMemoStage(
    /** @param {string | undefined} seed @returns {[string | undefined]} */
    (seed) => [seed],
    (seed) => new FastNoise2D(new SeededRNG(`${seed}::noise`)),
  );

  // Stage 1: Prevailing Wind Vector
  const stage1_wind = createMemoStage(
    /** @param {GeneratorConfig} cfg @returns {[string | undefined, number | undefined]} */
    (cfg) => [cfg.seed, cfg.windAxis],
    /** @returns {Stage1WindState} */
    (seed, windAxis) => {
      w.config = { seed, windAxis };
      w.logs = [];
      w.setStageRNG("stage1_wind");
      w.initPrevailingWind();
      return {
        windAngleIndex: w.windAngleIndex,
        windVector: Object.freeze({ ...w.windVector }),
        windLog: w.logs[w.logs.length - 1],
      };
    },
  );

  // Stage 2A: Terrain Heightmap & Sea Basins
  const stage2a_terrain = createMemoStage(
    /** @param {GeneratorConfig} cfg @param {FastNoise2D} noise @returns {[string | undefined, string, string | undefined, string | undefined, number | undefined, FastNoise2D]} */
    (cfg, noise) => [
      cfg.seed,
      cfg.worldSize || "standard",
      cfg.archetype,
      cfg.terrainAlgo,
      cfg.waterCoverage,
      noise,
    ],
    /** @returns {Stage2ATerrainState} */
    (seed, worldSize, archetype, terrainAlgo, waterCoverage, noise) => {
      w.ensureGridSize(worldSize);
      w.config = { seed, worldSize, archetype, terrainAlgo, waterCoverage };
      w.noise = noise;
      w.elevationField.fill(0);
      w.waterMask.fill(0);
      w.hydroFeatures = [];
      w.confluencePoint = null;
      w.setStageRNG("stage2a_terrain");
      const { basins, primarySink } = synthesizeTerrainAndBasins(w);
      return {
        worldSize,
        W: w.W,
        H: w.H,
        tileSize: w.tileSize,
        elevationField: new Float32Array(w.elevationField),
        waterMask: new Uint8Array(w.waterMask),
        seaLevel: w.seaLevel,
        basins: basins.map((b) => ({ ...b })),
        primarySink: primarySink ? { ...primarySink } : null,
        hydroFeatures: w.hydroFeatures.map((f) => ({ ...f })),
      };
    },
  );

  // Stage 2B: Fluvial Hydrology (Rivers, Springs & Mouths)
  const stage2b_hydrology = createMemoStage(
    /** @param {GeneratorConfig} cfg @param {FastNoise2D} noise @param {Readonly<Stage2ATerrainState>} s2a @returns {[string | undefined, string | undefined, string | undefined, string | undefined, FastNoise2D, Readonly<Stage2ATerrainState>]} */
    (cfg, noise, s2a) => [
      cfg.seed,
      cfg.archetype,
      cfg.terrainAlgo,
      cfg.hydrologyAlgo,
      noise,
      s2a,
    ],
    /** @returns {Stage2BHydrologyState} */
    (seed, archetype, terrainAlgo, hydrologyAlgo, noise, s2a, version) => {
      w.config = { seed, archetype, terrainAlgo, hydrologyAlgo };
      w.noise = noise;
      w.elevationField.set(s2a.elevationField);
      w.waterMask.set(s2a.waterMask);
      w.drainageField.fill(0);
      w.seaLevel = s2a.seaLevel;
      w.rivers = [];
      w.confluencePoint = null;
      w.hydroFeatures = s2a.hydroFeatures.map((f) => ({ ...f }));
      w.setStageRNG("stage2b_hydro");
      synthesizeFluvialHydrology(
        w,
        s2a.basins.map((b) => ({ ...b })),
        s2a.primarySink ? { ...s2a.primarySink } : null,
      );
      const tName =
        terrainAlgo === "quilez-erosion"
          ? "Quilez Derivative-Eroded fBm"
          : terrainAlgo === "voronoi-plates"
            ? "Voronoi Tectonic Plates"
            : "Tectonic Strike fBm";
      const hName =
        hydrologyAlgo === "d8-strahler"
          ? "Priority-Flood D8 Strahler"
          : hydrologyAlgo === "meandering-plain"
            ? "Ikeda Floodplain Meanders"
            : "Downhill A* Thalwegs";
      const hydroLog = `Synthesized terrain via <b>${tName}</b> & <b>${w.rivers.length} rivers</b> via <b>${hName}</b>.`;
      return {
        hydroVersion: version,
        W: w.W,
        H: w.H,
        tileSize: w.tileSize,
        elevationField: new Float32Array(w.elevationField),
        waterMask: new Uint8Array(w.waterMask),
        drainageField: new Float32Array(w.drainageField),
        rivers: w.rivers.map((r) => ({
          ...r,
          points: r.points.map((p) => ({ ...p })),
          headwaterPt: r.headwaterPt ? { ...r.headwaterPt } : null,
        })),
        hydroFeatures: w.hydroFeatures.map((f) => ({ ...f })),
        confluencePoint: w.confluencePoint ? { ...w.confluencePoint } : null,
        seaLevel: w.seaLevel,
        hydroLog,
      };
    },
  );

  // Stage 3: Slope, Distance Transform, Orographic Fertility & Landmasses
  const stage3_spatialFields = createMemoStage(
    /** @param {GeneratorConfig} cfg @param {Readonly<Stage1WindState>} s1 @param {Readonly<Stage2BHydrologyState>} s2b @returns {[string | undefined, Readonly<Stage1WindState>, Readonly<Stage2BHydrologyState>]} */
    (cfg, s1, s2b) => [cfg.archetype, s1, s2b],
    /** @returns {Stage3SpatialState} */
    (archetype, s1, s2b) => {
      w.config = { archetype };
      w.windAngleIndex = s1.windAngleIndex;
      w.windVector = s1.windVector;
      w.elevationField.set(s2b.elevationField);
      w.waterMask.set(s2b.waterMask);
      w.drainageField.set(s2b.drainageField);
      w.seaLevel = s2b.seaLevel;
      w.computeSpatialFields();
      return {
        slopeField: new Float32Array(w.slopeField),
        fertilityField: new Float32Array(w.fertilityField),
        distToWater: new Float32Array(w.distToWater),
        urbanSuitability: new Float32Array(w.urbanSuitability),
        landmassId: new Int16Array(w.landmassId),
        landmasses: w.landmasses.map((l) => ({ ...l })),
      };
    },
  );

  // Stage 4: Central Place Settlement Seeding
  const stage4_settlements = createMemoStage(
    /** @param {GeneratorConfig} cfg @param {FastNoise2D} noise @param {Readonly<Stage2BHydrologyState>} s2b @param {Readonly<Stage3SpatialState>} s3 @returns {[string | undefined, string | undefined, number | undefined, FastNoise2D, Readonly<Stage2BHydrologyState>, Readonly<Stage3SpatialState>]} */
    (cfg, noise, s2b, s3) => [
      cfg.seed,
      cfg.archetype,
      cfg.townCount,
      noise,
      s2b,
      s3,
    ],
    /** @returns {Stage4SettlementsState} */
    (seed, archetype, townCount, noise, s2b, s3) => {
      w.config = { seed, archetype, townCount };
      w.noise = noise;
      w.logs = [];
      w.towns = [];
      w.clusters = [];
      w.elevationField.set(s2b.elevationField);
      w.waterMask.set(s2b.waterMask);
      w.seaLevel = s2b.seaLevel;
      w.confluencePoint = s2b.confluencePoint
        ? { ...s2b.confluencePoint }
        : null;
      w.slopeField.set(s3.slopeField);
      w.fertilityField.set(s3.fertilityField);
      w.distToWater.set(s3.distToWater);
      w.urbanSuitability.set(s3.urbanSuitability);
      w.landmassId.set(s3.landmassId);
      w.landmasses = s3.landmasses.map((l) => ({ ...l }));
      w.setStageRNG("stage4_settlements");
      w.seedSettlements();
      return {
        towns: w.towns.map(cloneTown),
        clusters: w.clusters.map(cloneTown),
        settlementLog: w.logs[w.logs.length - 1],
      };
    },
  );

  // Stage 5: Multi-Tier Airport Solver & Terminal Loops
  const stage5_airports = createMemoStage(
    /** @param {GeneratorConfig} cfg @param {FastNoise2D} noise @param {Readonly<Stage1WindState>} s1 @param {Readonly<Stage2BHydrologyState>} s2b @param {Readonly<Stage3SpatialState>} s3 @param {Readonly<Stage4SettlementsState>} s4 @returns {[string | undefined, string | undefined, number | undefined, string | undefined, FastNoise2D, Readonly<Stage1WindState>, Readonly<Stage2BHydrologyState>, Readonly<Stage3SpatialState>, Readonly<Stage4SettlementsState>]} */
    (cfg, noise, s1, s2b, s3, s4) => [
      cfg.seed,
      cfg.archetype,
      cfg.airportCount,
      cfg.airportMix,
      noise,
      s1,
      s2b,
      s3,
      s4,
    ],
    /** @returns {Stage5AirportsState} */
    (seed, archetype, airportCount, airportMix, noise, s1, s2b, s3, s4) => {
      w.config = { seed, archetype, airportCount, airportMix };
      w.noise = noise;
      w.logs = [];
      w.airports = [];
      w.interchanges = [];
      w.roads = [];
      w.roadGrid.fill(0);
      w.roadEdges.clear();
      w.buildingMask.fill(0);
      w.airportHeatmap.fill(0);
      w.bridgeCount = 0;
      w.windAngleIndex = s1.windAngleIndex;
      w.windVector = s1.windVector;
      w.elevationField.set(s2b.elevationField);
      w.waterMask.set(s2b.waterMask);
      w.seaLevel = s2b.seaLevel;
      w.slopeField.set(s3.slopeField);
      w.distToWater.set(s3.distToWater);
      w.urbanSuitability.set(s3.urbanSuitability);
      w.landmassId.set(s3.landmassId);
      w.landmasses = s3.landmasses.map((l) => ({ ...l }));
      w.towns = s4.towns.map(cloneTown);
      w.clusters = s4.clusters.map(cloneTown);
      w.setStageRNG("stage5_airports");
      w.solveAndPlaceAirports();
      return {
        airports: w.airports.map(cloneAirport),
        towns: w.towns.map(cloneTown),
        airportHeatmap: new Float32Array(w.airportHeatmap),
        roadGrid: new Uint8Array(w.roadGrid),
        buildingMask: new Uint8Array(w.buildingMask),
        roads: w.roads.map(cloneRoad),
        airportLog: w.logs[w.logs.length - 1],
      };
    },
  );

  // Stage 6 & 7: Borough Street Grids, Regional Roads, Co-Evolved Secondary Towns, RCI Building Packing & Landscape Trees
  const stage6_7_urban = createMemoStage(
    /** @param {GeneratorConfig} cfg @param {FastNoise2D} noise @param {Readonly<Stage2BHydrologyState>} s2b @param {Readonly<Stage3SpatialState>} s3 @param {Readonly<Stage4SettlementsState>} s4 @param {Readonly<Stage5AirportsState>} s5 @returns {[string | undefined, string | undefined, number | undefined, number | undefined, FastNoise2D, Readonly<Stage2BHydrologyState>, Readonly<Stage3SpatialState>, Readonly<Stage4SettlementsState>, Readonly<Stage5AirportsState>]} */
    (cfg, noise, s2b, s3, s4, s5) => [
      cfg.seed,
      cfg.archetype,
      cfg.townCount,
      cfg.buildingDensity,
      noise,
      s2b,
      s3,
      s4,
      s5,
    ],
    /** @returns {Stage67UrbanState} */
    (
      seed,
      archetype,
      townCount,
      buildingDensity,
      noise,
      s2b,
      s3,
      s4,
      s5,
      version,
    ) => {
      w.config = { seed, archetype, townCount, buildingDensity };
      w.noise = noise;
      w.logs = [];
      w.houses = [];
      w.destinations = [];
      w.trees = [];
      w.bridgeCount = 0;
      w.zoneColorIdx.fill(-1);
      w.elevationField.set(s2b.elevationField);
      w.waterMask.set(s2b.waterMask);
      w.seaLevel = s2b.seaLevel;
      w.rivers = s2b.rivers;
      w.slopeField.set(s3.slopeField);
      w.fertilityField.set(s3.fertilityField);
      w.distToWater.set(s3.distToWater);
      w.urbanSuitability.set(s3.urbanSuitability);
      w.landmassId.set(s3.landmassId);
      w.landmasses = s3.landmasses;
      w.clusters = s4.clusters.map(cloneTown);
      w.towns = s5.towns.map(cloneTown);
      w.airports = s5.airports.map(cloneAirport);
      w.roadGrid.set(s5.roadGrid);
      w.buildingMask.set(s5.buildingMask);
      w.roads = s5.roads.map(cloneRoad);
      w.syncRoadEdgesFromRoads();

      w.setStageRNG("stage6a_grids");
      w.carveTownStreetGrids((t) => t._seededInPhase1 !== false);
      w.setStageRNG("stage6b_roads");
      w.buildRegionalRoadNetwork();
      const roadLog = w.logs[w.logs.length - 1];
      w.setStageRNG("stage7_rci");
      w.growUrbanFabric();
      w.setStageRNG("stage9_trees");
      w.populateLandscapeTrees();

      return {
        urbanVersion: version,
        towns: w.towns.map(cloneTown),
        roadGrid: new Uint8Array(w.roadGrid),
        buildingMask: new Uint8Array(w.buildingMask),
        zoneColorIdx: new Int8Array(w.zoneColorIdx),
        roads: w.roads.map(cloneRoad),
        houses: w.houses.map((h) => ({ ...h })),
        destinations: w.destinations.map(cloneDestination),
        trees: w.trees.map((tr) => ({ ...tr })),
        bridgeCount: w.bridgeCount,
        roadLog,
      };
    },
  );

  // Stage 8: Expressways & Cloverleaf/Trumpet System Interchanges
  const stage8_motorways = createMemoStage(
    /** @param {GeneratorConfig} cfg @param {FastNoise2D} noise @param {Readonly<Stage2BHydrologyState>} s2b @param {Readonly<Stage3SpatialState>} s3 @param {Readonly<Stage4SettlementsState>} s4 @param {Readonly<Stage5AirportsState>} s5 @param {Readonly<Stage67UrbanState>} s67 @returns {[string | undefined, string | undefined, FastNoise2D, Readonly<Stage2BHydrologyState>, Readonly<Stage3SpatialState>, Readonly<Stage4SettlementsState>, Readonly<Stage5AirportsState>, Readonly<Stage67UrbanState>]} */
    (cfg, noise, s2b, s3, s4, s5, s67) => [
      cfg.seed,
      cfg.archetype,
      noise,
      s2b,
      s3,
      s4,
      s5,
      s67,
    ],
    /** @returns {Stage8MotorwaysState} */
    (seed, archetype, noise, s2b, s3, s4, s5, s67) => {
      w.config = { seed, archetype };
      w.noise = noise;
      w.logs = [];
      w.motorways = [];
      w.interchanges = [];
      w.displacedBuildingsCount = 0;
      w._coarseBaseCost = null;
      w.elevationField.set(s2b.elevationField);
      w.waterMask.set(s2b.waterMask);
      w.seaLevel = s2b.seaLevel;
      w.slopeField.set(s3.slopeField);
      w.distToWater.set(s3.distToWater);
      w.landmassId.set(s3.landmassId);
      w.clusters = s4.clusters.map(cloneTown);
      w.towns = s67.towns.map(cloneTown);
      w.airports = s5.airports.map(cloneAirport);
      w.roadGrid.set(s67.roadGrid);
      w.buildingMask.set(s67.buildingMask);
      w.zoneColorIdx.set(s67.zoneColorIdx);
      w.roads = s67.roads.map(cloneRoad);
      w.syncRoadEdgesFromRoads();
      w.houses = s67.houses.map((h) => ({ ...h }));
      w.destinations = s67.destinations.map(cloneDestination);
      w.trees = s67.trees.map((tr) => ({ ...tr }));
      w.bridgeCount = s67.bridgeCount;

      w.setStageRNG("stage8_motorways");
      w.buildNumberedMotorways();

      return {
        towns: w.towns.map(cloneTown),
        airports: w.airports.map(cloneAirport),
        roadGrid: new Uint8Array(w.roadGrid),
        buildingMask: new Uint8Array(w.buildingMask),
        roads: w.roads.map(cloneRoad),
        houses: w.houses.map((h) => ({ ...h })),
        destinations: w.destinations.map(cloneDestination),
        trees: w.trees.map((tr) => ({ ...tr })),
        motorways: w.motorways.map((m) => ({
          ...m,
          waypoints: m.waypoints.map((p) => ({ ...p })),
          samples: m.samples.map((p) => ({ ...p })),
          tunnels: [],
        })),
        interchanges: w.interchanges.map((ic) => ({ ...ic })),
        displacedBuildingsCount: w.displacedBuildingsCount,
      };
    },
  );

  // Stage 9: Intermediate Diamond Ramps, Mountain Tunnels, Outer Street Pruning & Cargo Chain
  const stage9_rampsAndCargo = createMemoStage(
    /** @param {GeneratorConfig} cfg @param {FastNoise2D} noise @param {Readonly<Stage2BHydrologyState>} s2b @param {Readonly<Stage3SpatialState>} s3 @param {Readonly<Stage4SettlementsState>} s4 @param {Readonly<Stage67UrbanState>} s67 @param {Readonly<Stage8MotorwaysState>} s8 @returns {[string | undefined, string | undefined, boolean | undefined, FastNoise2D, Readonly<Stage2BHydrologyState>, Readonly<Stage3SpatialState>, Readonly<Stage4SettlementsState>, Readonly<Stage67UrbanState>, Readonly<Stage8MotorwaysState>]} */
    (cfg, noise, s2b, s3, s4, s67, s8) => [
      cfg.seed,
      cfg.archetype,
      cfg.includeIntermediateRamps,
      noise,
      s2b,
      s3,
      s4,
      s67,
      s8,
    ],
    /** @returns {Stage9RampsAndCargoState} */
    (
      seed,
      archetype,
      includeIntermediateRamps,
      noise,
      s2b,
      s3,
      s4,
      s67,
      s8,
    ) => {
      w.config = { seed, archetype, includeIntermediateRamps };
      w.noise = noise;
      w.logs = [];
      w.cargoLinks = [];
      w.elevationField.set(s2b.elevationField);
      w.waterMask.set(s2b.waterMask);
      w.seaLevel = s2b.seaLevel;
      w.slopeField.set(s3.slopeField);
      w.distToWater.set(s3.distToWater);
      w.landmassId.set(s3.landmassId);
      w.clusters = s4.clusters.map(cloneTown);
      w.towns = s8.towns.map(cloneTown);
      w.airports = s8.airports.map(cloneAirport);
      w.roadGrid.set(s8.roadGrid);
      w.buildingMask.set(s8.buildingMask);
      w.zoneColorIdx.set(s67.zoneColorIdx);
      w.roads = s8.roads.map(cloneRoad);
      w.syncRoadEdgesFromRoads();
      w.houses = s8.houses.map((h) => ({ ...h }));
      w.destinations = s8.destinations.map(cloneDestination);
      w.trees = s8.trees.map((tr) => ({ ...tr }));
      w.motorways = s8.motorways.map((m) => ({
        ...m,
        waypoints: m.waypoints.map((p) => ({ ...p })),
        samples: m.samples.map((p) => ({ ...p })),
        tunnels: [],
      }));
      w.interchanges = s8.interchanges.map((ic) => ({ ...ic }));
      w.displacedBuildingsCount = s8.displacedBuildingsCount;
      w.bridgeCount = s67.bridgeCount;

      w.setStageRNG("stage9_ramps");
      w.finalizeExpresswayRampsAndTunnels();
      const mwayLog = w.logs[w.logs.length - 1];

      w.setStageRNG("stage8b_cargo");
      w.buildIndustrialCargoChain();
      w.buildCommuterRoutes();
      const cargoLog = w.logs[w.logs.length - 1];

      return {
        towns: w.towns,
        airports: w.airports,
        roadGrid: new Uint8Array(w.roadGrid),
        buildingMask: new Uint8Array(w.buildingMask),
        roads: w.roads,
        houses: w.houses,
        destinations: w.destinations,
        trees: w.trees,
        motorways: w.motorways,
        interchanges: w.interchanges,
        cargoLinks: w.cargoLinks,
        commuterRoutes: w.commuterRoutes,
        displacedBuildingsCount: w.displacedBuildingsCount,
        bridgeCount: w.bridgeCount,
        mwayLog,
        cargoLog,
      };
    },
  );

  return (config, targetWorld = null) => {
    const t0 = performance.now();
    w.ensureGridSize(config.worldSize || "standard");
    const noise = memoNoise(config.seed).value;
    const s1 = stage1_wind(config);
    const s2a = stage2a_terrain(config, noise);
    const s2b = stage2b_hydrology(config, noise, s2a.value);

    // Notify parallel TerrainBakeWorker immediately once Stage 2B hydrology is ready!
    if (onHydrologyReady) {
      onHydrologyReady(s2b.value, !s2b.cached);
    }

    const s3 = stage3_spatialFields(config, s1.value, s2b.value);
    const s4 = stage4_settlements(config, noise, s2b.value, s3.value);
    const s5 = stage5_airports(
      config,
      noise,
      s1.value,
      s2b.value,
      s3.value,
      s4.value,
    );
    const s67 = stage6_7_urban(
      config,
      noise,
      s2b.value,
      s3.value,
      s4.value,
      s5.value,
    );

    // Notify parallel TerrainBakeWorker immediately once Stage 6/7 urban blush & trees are ready
    // so `composeTerrainBitmap` runs on Core 2 in parallel with Stage 8 Motorways & Stage 9 Cargo on Core 1!
    if (onUrbanReady) {
      onUrbanReady(s2b.value, s67.value, !s2b.cached || !s67.cached);
    }

    const s8 = stage8_motorways(
      config,
      noise,
      s2b.value,
      s3.value,
      s4.value,
      s5.value,
      s67.value,
    );
    const s9 = stage9_rampsAndCargo(
      config,
      noise,
      s2b.value,
      s3.value,
      s4.value,
      s67.value,
      s8.value,
    );

    // Derive highest consecutive cached stage number for UI telemetry badge
    /** @type {Array<[number, boolean]>} */
    const stageHits = [
      [1, s2a.cached],
      [2, s2b.cached],
      [3, s3.cached],
      [4, s4.cached],
      [5, s5.cached],
      [7, s67.cached],
      [8, s8.cached],
      [9, s9.cached],
    ];
    let reusedThroughStage = 0;
    for (const [stNum, hit] of stageHits) {
      if (hit) reusedThroughStage = stNum;
      else break;
    }

    const out = targetWorld || new ProceduralLogisticsWorld(config);
    out.config = { ...config };
    out.W = s2b.value.W;
    out.H = s2b.value.H;
    out.tileSize = s2b.value.tileSize;
    out.windAngleIndex = s1.value.windAngleIndex;
    out.windVector = s1.value.windVector;
    out.elevationField = s2b.value.elevationField;
    out.waterMask = s2b.value.waterMask;
    out.drainageField = s2b.value.drainageField;
    out.rivers = s2b.value.rivers;
    out.hydroFeatures = s2b.value.hydroFeatures;
    out.confluencePoint = s2b.value.confluencePoint;
    out.seaLevel = s2b.value.seaLevel;
    out.slopeField = s3.value.slopeField;
    out.fertilityField = s3.value.fertilityField;
    out.distToWater = s3.value.distToWater;
    out.urbanSuitability = s3.value.urbanSuitability;
    out.landmassId = s3.value.landmassId;
    out.landmasses = s3.value.landmasses;
    out.clusters = s4.value.clusters;
    out.airportHeatmap = s5.value.airportHeatmap;
    out.zoneColorIdx = s67.value.zoneColorIdx;
    out.bridgeCount = s9.value.bridgeCount;
    out.towns = s9.value.towns;
    out.airports = s9.value.airports;
    out.roadGrid = s9.value.roadGrid;
    out.buildingMask = s9.value.buildingMask;
    out.roads = s9.value.roads;
    out.syncRoadEdgesFromRoads();
    out.houses = s9.value.houses;
    out.destinations = s9.value.destinations;
    out.trees = s9.value.trees;
    out.motorways = s9.value.motorways;
    out.interchanges = s9.value.interchanges;
    out.cargoLinks = s9.value.cargoLinks;
    out.commuterRoutes = s9.value.commuterRoutes;
    out.displacedBuildingsCount = s9.value.displacedBuildingsCount;
    out.hydroVersion = s2b.value.hydroVersion;
    out.urbanVersion = s67.value.urbanVersion;
    out.reusedThroughStage = reusedThroughStage;
    out.terrainUnchanged = reusedThroughStage >= 7;
    out.logs = [
      s1.value.windLog,
      s2b.value.hydroLog,
      s4.value.settlementLog,
      s5.value.airportLog,
      s67.value.roadLog,
      s9.value.mwayLog,
      s9.value.cargoLog,
    ].filter(Boolean);
    out.genTimeMs = Math.round(performance.now() - t0);
    return out;
  };
}

/**
 * @param {ProceduralLogisticsWorld} world
 * @returns {ArrayBufferLike[]}
 */
export function extractWorldTransferables(world) {
  delete world.rng;
  delete world.noise;
  delete world.roadEdges;
  delete world._vehicleGraph;
  delete world._astarG;
  delete world._astarParent;
  delete world._astarSeenGen;
  delete world._astarClosedGen;
  delete world._coarseBaseCost;
  delete world._coarseG;
  delete world._coarseParent;
  delete world._coarseSeenGen;
  delete world._coarseClosedGen;

  // Clone TypedArrays before detaching their ArrayBuffers for zero-copy transfer
  // so the Worker's memoized stage cache retains its immutable buffers intact!
  /** @type {ArrayBufferLike[]} */
  const buffers = [];
  if (world.waterMask) {
    world.waterMask = new Uint8Array(world.waterMask);
    buffers.push(world.waterMask.buffer);
  }
  if (world.elevationField) {
    world.elevationField = new Float32Array(world.elevationField);
    buffers.push(world.elevationField.buffer);
  }
  if (world.slopeField) {
    world.slopeField = new Float32Array(world.slopeField);
    buffers.push(world.slopeField.buffer);
  }
  if (world.drainageField) {
    world.drainageField = new Float32Array(world.drainageField);
    buffers.push(world.drainageField.buffer);
  }
  if (world.fertilityField) {
    world.fertilityField = new Float32Array(world.fertilityField);
    buffers.push(world.fertilityField.buffer);
  }
  if (world.distToWater) {
    world.distToWater = new Float32Array(world.distToWater);
    buffers.push(world.distToWater.buffer);
  }
  if (world.urbanSuitability) {
    world.urbanSuitability = new Float32Array(world.urbanSuitability);
    buffers.push(world.urbanSuitability.buffer);
  }
  if (world.airportHeatmap) {
    world.airportHeatmap = new Float32Array(world.airportHeatmap);
    buffers.push(world.airportHeatmap.buffer);
  }
  if (world.roadGrid) {
    world.roadGrid = new Uint8Array(world.roadGrid);
    buffers.push(world.roadGrid.buffer);
  }
  if (world.buildingMask) {
    world.buildingMask = new Uint8Array(world.buildingMask);
    buffers.push(world.buildingMask.buffer);
  }
  if (world.zoneColorIdx) {
    world.zoneColorIdx = new Int8Array(world.zoneColorIdx);
    buffers.push(world.zoneColorIdx.buffer);
  }
  if (world.landmassId) {
    world.landmassId = new Int16Array(world.landmassId);
    buffers.push(world.landmassId.buffer);
  }
  return buffers;
}

/**
 * @param {ProceduralLogisticsWorld} world
 * @returns {ProceduralLogisticsWorld}
 */
export function hydrateTransferredWorld(world) {
  Object.setPrototypeOf(world, ProceduralLogisticsWorld.prototype);
  return world;
}
