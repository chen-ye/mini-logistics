/**
 * @import {
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
 *   Interchange,
 *   VehicleRoutingGraph,
 *   RoadTopology,
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
  SYLLABLES_START,
  SYLLABLES_PRE,
  SYLLABLES_ROOT_VALLEY,
  SYLLABLES_ROOT_RIVER,
  SYLLABLES_ROOT_COAST,
  SYLLABLES_ROOT_HILL,
} from "./palette.js";
import { synthesizeTerrainAndBasins } from "./terrain-solvers.js";
import { synthesizeFluvialHydrology } from "./hydrology-solvers.js";
import { WORLD_SIZE_PRESETS, WIND_AXES } from "./constants.js";
import { createMemoStage } from "./state.js";

import {
  getAirportTierSpec,
  solveAndPlaceAirports,
  isPointInAirportPad,
  doesSegmentCrossAirport,
  doesPolylineCrossAirport,
  buildAirportLandsideNetwork,
} from "./entities/airport/placement.js";

import {
  buildFarmEstate,
  finalizeFarmEstateFromParcels,
  buildBrokenGridTractorTracks,
  traceSmoothEstateLoops,
} from "./entities/farm-estate/placement.js";

import {
  seedSettlements,
  seedSecondaryTownsAlongTrunks,
  carveTownStreetGrids,
  carveStreetFromCenter,
} from "./entities/town/placement.js";

import {
  seedOutOfTownResourceNiches,
  placeTownCommercialAndIndustrial,
  tryPlaceNeighborhoodHouses,
} from "./entities/rci-building/placement.js";

import {
  buildRegionalRoadNetwork,
  findRoadPathAStar,
  commitRoadPath,
  growUrbanFabric,
  pruneEmptyOuterStreets,
  populateLandscapeTrees,
} from "./urban-fabric-solver.js";

import {
  isCloverleafFootprintDry,
  isTrumpetFootprintDry,
  interchangeRoadOverlapCost,
  tryBuildTrumpetSpurToTrunk,
  detectAndBuildCloverleafs,
  displaceAndRerouteRoadsAtInterchange,
  intersectUnderpassWithMotorway,
  buildFlexibleDiamondRamps,
  findExistingOctilinearUnderpass,
  buildIntermediateExpresswayRamps,
} from "./entities/interchange/placement.js";

import {
  displaceBuildingsInRadius,
  findPassThroughStubAtTown,
  createTerminalStreetStub,
  scoreMotorwaySamples,
  ensureCoarseValleyCostTable,
  findValleyMotorwayWaypoints,
  createMotorwayEntity,
  sampleMotorwayCurve,
  polylineArcLength,
  removeOrphanedTerminalStub,
  findPolylineIntersection,
  segmentIntersection,
  rebindOrDisplaceOrphanedFrontage,
  buildNumberedMotorways,
  displaceBuildingsAlongMotorwayCorridors,
  applyRightOfWayClearance,
  detectMountainExpresswayTunnels,
  finalizeExpresswayRampsAndTunnels,
} from "./expressway-solver.js";

import {
  deriveRoadTopology,
  ensureVehicleRoutingGraph,
  findVehicleNetworkPath,
  buildDirectedLaneTrajectory,
  buildCommuterRoutes,
  buildIndustrialCargoChain,
} from "./vehicle-routing.js";

export { createMemoStage } from "./state.js";
export { WORLD_SIZE_PRESETS } from "./constants.js";
export {
  deriveRoadTopology,
  deriveVehicleRoutingGraph,
} from "./vehicle-routing.js";

/**
 * Reusable scratch buffers for A* pathfinders.
 */
export class AStarScratchPool {
  constructor(W = 0, H = 0) {
    const size = W * H;
    this._astarG = new Float32Array(size);
    this._astarParent = new Int32Array(size);
    this._astarSeenGen = new Uint32Array(size);
    this._astarClosedGen = new Uint32Array(size);
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
    this._coarseGen = 0;
  }

  ensureSize(W, H) {
    const size = W * H;
    if (this._astarG.length !== size) {
      this._astarG = new Float32Array(size);
      this._astarParent = new Int32Array(size);
      this._astarSeenGen = new Uint32Array(size);
      this._astarClosedGen = new Uint32Array(size);
      this._coarseBaseCost = null;
      this._coarseG = null;
      this._coarseParent = null;
      this._coarseSeenGen = null;
      this._coarseClosedGen = null;
    }
  }
}

/***************************************************************************
 * 3. PROCEDURAL WORLD GENERATOR CLASS
 ***************************************************************************/
export class ProceduralLogisticsWorld {
  /**
   * @param {GeneratorConfig} [config={}]
   */
  constructor(config = {}) {
    /** @type {GeneratorConfig} */
    this.config = { ...config };
    /** @type {number} */
    this.W = 240;
    /** @type {number} */
    this.H = 150;
    /** @type {number} */
    this.tileSize = 15;
    /** @type {number} */
    this.seaLevel = 0.34;

    const size = this.W * this.H;
    /** @type {Float32Array} */
    this.elevationField = new Float32Array(size);
    /** @type {Float32Array} */
    this.slopeField = new Float32Array(size);
    /** @type {Float32Array} */
    this.drainageField = new Float32Array(size);
    /** @type {Uint8Array} */
    this.waterMask = new Uint8Array(size);
    /** @type {Float32Array} */
    this.fertilityField = new Float32Array(size);
    /** @type {Float32Array} */
    this.distToWater = new Float32Array(size);
    /** @type {Float32Array} */
    this.urbanSuitability = new Float32Array(size);
    /** @type {Float32Array} */
    this.airportHeatmap = new Float32Array(size);
    /** @type {Uint8Array} */
    this.roadGrid = new Uint8Array(size);
    /** @type {Set<number>} */
    this.roadEdges = new Set();
    /** @type {Uint8Array} */
    this.buildingMask = new Uint8Array(size);
    /** @type {Int8Array} */
    this.zoneColorIdx = new Int8Array(size).fill(-1);
    /** @type {Int16Array} */
    this.landmassId = new Int16Array(size).fill(-1);
    /** @type {Landmass[]} */
    this.landmasses = [];

    this.scratchPool = new AStarScratchPool(this.W, this.H);
    this._astarG = this.scratchPool._astarG;
    this._astarParent = this.scratchPool._astarParent;
    this._astarSeenGen = this.scratchPool._astarSeenGen;
    this._astarClosedGen = this.scratchPool._astarClosedGen;
    this._astarGen = 0;

    this._coarseBaseCost = null;
    this._coarseG = null;
    this._coarseParent = null;
    this._coarseSeenGen = null;
    this._coarseClosedGen = null;
    this._coarseGen = 0;

    /** @type {SeededRNG} */
    this.rng = new SeededRNG(config.seed || "OTTD-METRO-84");
    /** @type {FastNoise2D} */
    this.noise = new FastNoise2D(this.rng);

    /** @type {RiverRibbon[]} */
    this.rivers = [];
    /** @type {HydroFeature[]} */
    this.hydroFeatures = [];
    /** @type {Point2D | HydroFeature | null} */
    this.confluencePoint = null;
    /** @type {Town[]} */
    this.towns = [];
    /** @type {Town[]} */
    this.clusters = [];
    /** @type {Airport[]} */
    this.airports = [];
    /** @type {import('./types.js').TradeGateway[]} */
    this.tradeGateways = [];
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
    this.genTimeMs = 0;
    /** @type {number} */
    this.displacedBuildingsCount = 0;
    /** @type {number} */
    this.bridgeCount = 0;
    /** @type {WindVector} */
    this.windVector = { x: 1, y: 0, angleDeg: 0, rad: 0, label: "RWY 09/27" };
    /** @type {VehicleRoutingGraph | null} */
    this._vehicleGraph = null;

    /** @type {number} */
    this.windAngleIndex = 0;
    /** @type {number} */
    this.hydroVersion = 0;
    /** @type {number} */
    this.urbanVersion = 0;
    /** @type {boolean} */
    this.terrainUnchanged = false;
    /** @type {number} */
    this.reusedThroughStage = 0;
    /** @type {number} */
    this.wallTimeMs = 0;
    /** @type {RoadTopology | undefined} */
    this.roadTopology = undefined;
    /** @type {{ roundabouts: import('./types.js').RoundaboutSpec[], driveways?: import('./types.js').DrivewaySpec[], rampEdges?: import('./types.js').RampGraphEdge[], rampNodes?: import('./types.js').RampGraphNode[] } | undefined} */
    this.routingGraph = undefined;
    /** @type {{ com: number, raw: number, mfg: number, log: number } | undefined} */
    this.rciCounts = undefined;
  }

  ensureGridSize(worldSize = "standard") {
    const preset = WORLD_SIZE_PRESETS[worldSize] || WORLD_SIZE_PRESETS.standard;
    if (this.W === preset.W && this.H === preset.H) {
      this.tileSize = preset.tileSize;
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

    this.scratchPool.ensureSize(this.W, this.H);
    this._astarG = this.scratchPool._astarG;
    this._astarParent = this.scratchPool._astarParent;
    this._astarSeenGen = this.scratchPool._astarSeenGen;
    this._astarClosedGen = this.scratchPool._astarClosedGen;
    this._coarseBaseCost = null;
    this._coarseG = null;
    this._coarseParent = null;
    this._coarseSeenGen = null;
    this._coarseClosedGen = null;
  }

  idx(x, y) {
    return y * this.W + x;
  }

  edgeKey(x1, y1, x2, y2) {
    const k1 = y1 * this.W + x1;
    const k2 = y2 * this.W + x2;
    return k1 < k2 ? k1 * (this.W * this.H) + k2 : k2 * (this.W * this.H) + k1;
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
    if (
      this.config.windAxis !== undefined &&
      this.config.windAxis >= 0 &&
      this.config.windAxis <= 3
    ) {
      this.windAngleIndex = this.config.windAxis;
    } else {
      this.windAngleIndex = this.rng.int(0, 3);
    }
    const chosen = WIND_AXES[this.windAngleIndex];
    this.windVector = {
      x: Math.cos(chosen.rad),
      y: Math.sin(chosen.rad),
      angleDeg: chosen.angleDeg,
      rad: chosen.rad,
      label: chosen.label,
    };
    this.logs.push(`Prevailing wind locked to <b>${chosen.label}</b>.`);
  }

  computeSpatialFields() {
    const { W, H } = this;
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
          const step = i < 4 ? 1.0 : Math.SQRT2;
          const nid = this.idx(nx, ny);
          if (d0 + step < this.distToWater[nid]) {
            this.distToWater[nid] = d0 + step;
            queue.push(nx, ny);
          }
        }
      }
    }

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

  seedSettlements() {
    return seedSettlements(this);
  }

  // --- Thin Delegation Methods to Extracted Stage Solvers ---

  getAirportTierSpec(aIdx) {
    return getAirportTierSpec(this, aIdx);
  }

  solveAndPlaceAirports() {
    return solveAndPlaceAirports(this);
  }

  /**
   * @param {number} px
   * @param {number} py
   * @param {number} [margin]
   * @param {number | null} [allowGateAirportId]
   * @returns {boolean}
   */
  isPointInAirportPad(px, py, margin = 1.6, allowGateAirportId = null) {
    return isPointInAirportPad(this, px, py, margin, allowGateAirportId);
  }

  /**
   * @param {number} x1
   * @param {number} y1
   * @param {number} x2
   * @param {number} y2
   * @param {number} [margin]
   * @param {number | null} [allowGateAirportId]
   * @returns {boolean}
   */
  doesSegmentCrossAirport(
    x1,
    y1,
    x2,
    y2,
    margin = 1.6,
    allowGateAirportId = null,
  ) {
    return doesSegmentCrossAirport(
      this,
      x1,
      y1,
      x2,
      y2,
      margin,
      allowGateAirportId,
    );
  }

  /**
   * @param {Array<{ x: number, y: number }>} samples
   * @param {number} [margin]
   * @param {number | null} [allowGateAirportId]
   * @returns {boolean}
   */
  doesPolylineCrossAirport(samples, margin = 1.6, allowGateAirportId = null) {
    return doesPolylineCrossAirport(this, samples, margin, allowGateAirportId);
  }

  buildAirportLandsideNetwork(ap) {
    return buildAirportLandsideNetwork(this, ap);
  }

  buildFarmEstate(fgx, fgy, fcx, fcy, slotIdx) {
    return buildFarmEstate(this, fgx, fgy, fcx, fcy, slotIdx);
  }

  finalizeFarmEstateFromParcels(
    rawParcels,
    fgx,
    fgy,
    slotIdx,
    spineAxis,
    spineCoord,
  ) {
    return finalizeFarmEstateFromParcels(
      this,
      rawParcels,
      fgx,
      fgy,
      slotIdx,
      spineAxis,
      spineCoord,
    );
  }

  buildBrokenGridTractorTracks(bspParcels, estateTileSet, fgx, fgy, slotIdx) {
    return buildBrokenGridTractorTracks(
      this,
      bspParcels,
      estateTileSet,
      fgx,
      fgy,
      slotIdx,
    );
  }

  traceSmoothEstateLoops(estateTileSet) {
    return traceSmoothEstateLoops(this, estateTileSet);
  }

  buildRegionalRoadNetwork() {
    return buildRegionalRoadNetwork(this);
  }

  seedSecondaryTownsAlongTrunks() {
    return seedSecondaryTownsAlongTrunks(this);
  }

  /**
   * @param {number} sx
   * @param {number} sy
   * @param {number} ex
   * @param {number} ey
   * @param {boolean} [allowWaterBridge]
   * @param {((nx: number, ny: number, cx: number, cy: number) => boolean) | null} [blockedFn]
   * @param {boolean} [stopOnExistingRoad]
   * @param {{ isInterchangeBypass?: boolean, turnPenalty?: number, extraCostFn?: ((nx: number, ny: number) => number) } | null} [options]
   * @returns {Array<{ x: number, y: number, isBridge?: boolean }> | null}
   */
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
    return findRoadPathAStar(
      this,
      sx,
      sy,
      ex,
      ey,
      allowWaterBridge,
      blockedFn,
      stopOnExistingRoad,
      options,
    );
  }

  /**
   * @param {Array<{ x: number, y: number, isBridge?: boolean }>} path
   * @param {"arterial" | "street" | "motorway" | "airport-spine"} [roadType="arterial"]
   * @param {Record<string, any> | null} [extraProps=null]
   */
  commitRoadPath(path, roadType = "arterial", extraProps = null) {
    return commitRoadPath(this, path, roadType, extraProps);
  }

  /**
   * @param {((town: any) => boolean) | null} [filterFn=null]
   */
  carveTownStreetGrids(filterFn = null) {
    return carveTownStreetGrids(this, filterFn);
  }

  growUrbanFabric() {
    return growUrbanFabric(this);
  }

  seedOutOfTownResourceNiches() {
    return seedOutOfTownResourceNiches(this);
  }

  pruneEmptyOuterStreets() {
    return pruneEmptyOuterStreets(this);
  }

  carveStreetFromCenter(
    cx,
    cy,
    ux,
    uy,
    negSteps,
    posSteps,
    isMainBoulevard = false,
  ) {
    return carveStreetFromCenter(
      this,
      cx,
      cy,
      ux,
      uy,
      negSteps,
      posSteps,
      isMainBoulevard,
    );
  }

  placeTownCommercialAndIndustrial(town, R, densityMult) {
    return placeTownCommercialAndIndustrial(this, town, R, densityMult);
  }

  /**
   * @param {Town} town
   * @param {number} targetHouses
   * @param {number | null} [customRadius=null]
   */
  tryPlaceNeighborhoodHouses(town, targetHouses, customRadius = null) {
    return tryPlaceNeighborhoodHouses(this, town, targetHouses, customRadius);
  }

  populateLandscapeTrees() {
    return populateLandscapeTrees(this);
  }

  displaceBuildingsInRadius(cx, cy, radius) {
    return displaceBuildingsInRadius(this, cx, cy, radius);
  }

  findPassThroughStubAtTown(town, towardX, towardY) {
    return findPassThroughStubAtTown(this, town, towardX, towardY);
  }

  createTerminalStreetStub(townOrAirport, isAirport, towardX, towardY) {
    return createTerminalStreetStub(
      this,
      townOrAirport,
      isAirport,
      towardX,
      towardY,
    );
  }

  isCloverleafFootprintDry(
    x,
    y,
    angleA,
    angleB,
    signsA = [-1, 1],
    signsB = [-1, 1],
  ) {
    return isCloverleafFootprintDry(this, x, y, angleA, angleB, signsA, signsB);
  }

  isTrumpetFootprintDry(x, y, angleMain, sideSign) {
    return isTrumpetFootprintDry(this, x, y, angleMain, sideSign);
  }

  interchangeRoadOverlapCost(cx, cy, radius = 4.2) {
    return interchangeRoadOverlapCost(this, cx, cy, radius);
  }

  /**
   * @param {Array<{ x: number, y: number }>} samples
   * @param {number} sx
   * @param {number} sy
   * @param {number} ex
   * @param {number} ey
   * @param {number | null} [airportId]
   * @param {number} [preferOff]
   * @param {number} [candidateOff]
   * @param {boolean} [forbidAnyCrossing]
   * @param {number | null} [allowTouchTrunkNum]
   * @returns {number}
   */
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
    return scoreMotorwaySamples(
      this,
      samples,
      sx,
      sy,
      ex,
      ey,
      airportId,
      preferOff,
      candidateOff,
      forbidAnyCrossing,
      allowTouchTrunkNum,
    );
  }

  ensureCoarseValleyCostTable() {
    return ensureCoarseValleyCostTable(this);
  }

  /**
   * @param {number} sx
   * @param {number} sy
   * @param {number} ex
   * @param {number} ey
   * @param {number | null} [airportId]
   * @param {number} [biasOff]
   * @returns {Array<{ x: number, y: number }> | null}
   */
  findValleyMotorwayWaypoints(sx, sy, ex, ey, airportId = null, biasOff = 0) {
    return findValleyMotorwayWaypoints(
      this,
      sx,
      sy,
      ex,
      ey,
      airportId,
      biasOff,
    );
  }

  /**
   * @param {number} number
   * @param {number} sx
   * @param {number} sy
   * @param {number} ex
   * @param {number} ey
   * @param {number | null} [airportId]
   * @param {number | null} [townId]
   * @param {{ x: number, y: number } | null} [forcedViaPt]
   * @returns {any}
   */
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
    return createMotorwayEntity(
      this,
      number,
      sx,
      sy,
      ex,
      ey,
      airportId,
      townId,
      forcedViaPt,
    );
  }

  sampleMotorwayCurve(waypoints) {
    return sampleMotorwayCurve(this, waypoints);
  }

  polylineArcLength(samples, i0, i1) {
    return polylineArcLength(this, samples, i0, i1);
  }

  removeOrphanedTerminalStub(x, y) {
    return removeOrphanedTerminalStub(this, x, y);
  }

  /**
   * @param {number} number
   * @param {number} originX
   * @param {number} originY
   * @param {number | null} [airportId]
   * @param {number | null} [townId]
   * @returns {any}
   */
  tryBuildTrumpetSpurToTrunk(
    number,
    originX,
    originY,
    airportId = null,
    townId = null,
  ) {
    return tryBuildTrumpetSpurToTrunk(
      this,
      number,
      originX,
      originY,
      airportId,
      townId,
    );
  }

  detectAndBuildCloverleafs() {
    return detectAndBuildCloverleafs(this);
  }

  findPolylineIntersection(samplesA, samplesB) {
    return findPolylineIntersection(this, samplesA, samplesB);
  }

  segmentIntersection(x1, y1, x2, y2, x3, y3, x4, y4) {
    return segmentIntersection(x1, y1, x2, y2, x3, y3, x4, y4);
  }

  rebindOrDisplaceOrphanedFrontage() {
    return rebindOrDisplaceOrphanedFrontage(this);
  }

  displaceAndRerouteRoadsAtInterchange(ic, requireCleanReroute = false) {
    return displaceAndRerouteRoadsAtInterchange(this, ic, requireCleanReroute);
  }

  intersectUnderpassWithMotorway(samples, kHint, A, B) {
    return intersectUnderpassWithMotorway(this, samples, kHint, A, B);
  }

  buildFlexibleDiamondRamps(
    mw,
    kCenter,
    _crossPt,
    posTerm,
    negTerm,
    connSide = 0,
    isThroughDiamond = false,
  ) {
    return buildFlexibleDiamondRamps(
      this,
      mw,
      kCenter,
      _crossPt,
      posTerm,
      negTerm,
      connSide,
      isThroughDiamond,
    );
  }

  findExistingOctilinearUnderpass(pt, _cosA, _sinA, nx, ny) {
    return findExistingOctilinearUnderpass(this, pt, _cosA, _sinA, nx, ny);
  }

  buildIntermediateExpresswayRamps() {
    return buildIntermediateExpresswayRamps(this);
  }

  buildNumberedMotorways() {
    return buildNumberedMotorways(this);
  }

  displaceBuildingsAlongMotorwayCorridors() {
    return displaceBuildingsAlongMotorwayCorridors(this);
  }

  applyRightOfWayClearance() {
    return applyRightOfWayClearance(this);
  }

  detectMountainExpresswayTunnels() {
    return detectMountainExpresswayTunnels(this);
  }

  finalizeExpresswayRampsAndTunnels() {
    return finalizeExpresswayRampsAndTunnels(this);
  }

  ensureVehicleRoutingGraph() {
    return ensureVehicleRoutingGraph(this);
  }

  findVehicleNetworkPath(sx, sy, ex, ey) {
    return findVehicleNetworkPath(this, sx, sy, ex, ey);
  }

  buildDirectedLaneTrajectory(srcPt, dstPt, rawPath) {
    return buildDirectedLaneTrajectory(this, srcPt, dstPt, rawPath);
  }

  buildCommuterRoutes() {
    return buildCommuterRoutes(this);
  }

  buildIndustrialCargoChain() {
    return buildIndustrialCargoChain(this);
  }
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
  externalCorridors: a.externalCorridors
    ? a.externalCorridors.map((c) => ({ ...c }))
    : undefined,
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
  estateBBox: d.estateBBox ? { ...d.estateBBox } : undefined,
  requiredInputs: d.requiredInputs ? [...d.requiredInputs] : undefined,
  demandedGoods: d.demandedGoods ? [...d.demandedGoods] : undefined,
  demandProfile: d.demandProfile ? { ...d.demandProfile } : undefined,
});

/** @param {any} gw @returns {any} */
const cloneTradeGateway = (gw) => ({
  ...gw,
  importedGoods: gw.importedGoods ? [...gw.importedGoods] : [],
  exportedGoods: gw.exportedGoods ? [...gw.exportedGoods] : [],
  corridors: gw.corridors ? gw.corridors.map((c) => ({ ...c })) : [],
});

/**
 * Creates a stateful reactive memoized 9-stage world-generation DAG pipeline.
 * Each stage is a pure function of its explicit config slice + immutable upstream stage snapshots.
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
  // Single shared scratch workspace for stage execution
  const w = new ProceduralLogisticsWorld({});

  let lastEmittedHydroVersion = -1;
  let lastEmittedUrbanVersion = -1;
  let currentTerrainOrUrbanChanged = false;

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
    /** @param {GeneratorConfig} cfg @param {FastNoise2D} noise @returns {[string | undefined, string, string | undefined, string | undefined, number | undefined, number | undefined, number | undefined, number | undefined, number | undefined, number | undefined, number | undefined, FastNoise2D]} */
    (cfg, noise) => [
      cfg.seed,
      cfg.worldSize || "standard",
      cfg.archetype,
      cfg.terrainAlgo,
      cfg.waterCoverage,
      cfg.terrainRelief,
      cfg.valleyIncision,
      cfg.coastalEmbayment,
      cfg.calderaCurvature,
      cfg.barrierFragmentation,
      cfg.basinCount,
      noise,
    ],
    /** @returns {Stage2ATerrainState} */
    (
      seed,
      worldSize,
      archetype,
      terrainAlgo,
      waterCoverage,
      terrainRelief,
      valleyIncision,
      coastalEmbayment,
      calderaCurvature,
      barrierFragmentation,
      basinCount,
      noise,
    ) => {
      w.ensureGridSize(worldSize);
      w.config = {
        seed,
        worldSize,
        archetype,
        terrainAlgo,
        waterCoverage,
        terrainRelief,
        valleyIncision,
        coastalEmbayment,
        calderaCurvature,
        barrierFragmentation,
        basinCount,
      };
      w.noise = noise;
      const size = w.W * w.H;
      w.elevationField = new Float32Array(size);
      w.waterMask = new Uint8Array(size);
      w.hydroFeatures = [];
      w.confluencePoint = null;
      w.setStageRNG("stage2a_terrain");
      const { basins, primarySink } = synthesizeTerrainAndBasins(w);
      return {
        worldSize,
        W: w.W,
        H: w.H,
        tileSize: w.tileSize,
        elevationField: w.elevationField,
        waterMask: w.waterMask,
        seaLevel: w.seaLevel,
        basins: basins.map((b) => ({ ...b })),
        primarySink: primarySink
          ? { ...primarySink }
          : {
              deepX: Math.round(w.W * 0.5),
              deepY: Math.round(w.H * 0.5),
            },
        hydroFeatures: w.hydroFeatures.map((f) => ({ ...f })),
      };
    },
  );

  // Stage 2B: Fluvial Hydrology (Rivers, Springs & Mouths)
  const stage2b_hydrology = createMemoStage(
    /** @param {GeneratorConfig} cfg @param {FastNoise2D} noise @param {Readonly<Stage2ATerrainState>} s2a @returns {[string | undefined, string | undefined, string | undefined, string | undefined, number | undefined, number | undefined, number | undefined, number | undefined, number | undefined, number | undefined, FastNoise2D, Readonly<Stage2ATerrainState>]} */
    (cfg, noise, s2a) => [
      cfg.seed,
      cfg.archetype,
      cfg.terrainAlgo,
      cfg.hydrologyAlgo,
      cfg.terrainRelief,
      cfg.valleyIncision,
      cfg.coastalEmbayment,
      cfg.calderaCurvature,
      cfg.barrierFragmentation,
      cfg.basinCount,
      noise,
      s2a,
    ],
    /** @returns {Stage2BHydrologyState} */
    (
      seed,
      archetype,
      terrainAlgo,
      hydrologyAlgo,
      terrainRelief,
      valleyIncision,
      coastalEmbayment,
      calderaCurvature,
      barrierFragmentation,
      basinCount,
      noise,
      s2a,
      version,
    ) => {
      w.config = {
        seed,
        archetype,
        terrainAlgo,
        hydrologyAlgo,
        terrainRelief,
        valleyIncision,
        coastalEmbayment,
        calderaCurvature,
        barrierFragmentation,
        basinCount,
      };
      w.noise = noise;
      const size = s2a.W * s2a.H;
      w.elevationField = new Float32Array(s2a.elevationField);
      w.waterMask = new Uint8Array(s2a.waterMask);
      w.drainageField = new Float32Array(size);
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
        elevationField: w.elevationField,
        waterMask: w.waterMask,
        drainageField: w.drainageField,
        rivers: w.rivers.map((r) => ({
          ...r,
          points: r.points.map((p) => ({ ...p })),
          headwaterPt: r.headwaterPt ? { ...r.headwaterPt } : null,
        })),
        hydroFeatures: w.hydroFeatures.map((f) => ({ ...f })),
        confluencePoint: w.confluencePoint
          ? Object.assign({}, w.confluencePoint)
          : null,
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
      w.elevationField = s2b.elevationField;
      w.waterMask = s2b.waterMask;
      w.drainageField = s2b.drainageField;
      w.seaLevel = s2b.seaLevel;
      const size = s2b.W * s2b.H;
      w.slopeField = new Float32Array(size);
      w.fertilityField = new Float32Array(size);
      w.distToWater = new Float32Array(size);
      w.urbanSuitability = new Float32Array(size);
      w.landmassId = new Int16Array(size).fill(-1);
      w.computeSpatialFields();
      return {
        slopeField: w.slopeField,
        fertilityField: w.fertilityField,
        distToWater: w.distToWater,
        urbanSuitability: w.urbanSuitability,
        landmassId: w.landmassId,
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
      w.elevationField = s2b.elevationField;
      w.waterMask = s2b.waterMask;
      w.drainageField = s2b.drainageField;
      w.seaLevel = s2b.seaLevel;
      w.confluencePoint = s2b.confluencePoint
        ? { ...s2b.confluencePoint }
        : null;
      w.slopeField = s3.slopeField;
      w.fertilityField = s3.fertilityField;
      w.distToWater = s3.distToWater;
      w.urbanSuitability = s3.urbanSuitability;
      w.landmassId = s3.landmassId;
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
      w.elevationField = s2b.elevationField;
      w.waterMask = s2b.waterMask;
      w.drainageField = s2b.drainageField;
      w.seaLevel = s2b.seaLevel;
      w.slopeField = s3.slopeField;
      w.fertilityField = s3.fertilityField;
      w.distToWater = s3.distToWater;
      w.urbanSuitability = s3.urbanSuitability;
      w.landmassId = s3.landmassId;
      w.landmasses = s3.landmasses.map((l) => ({ ...l }));
      w.towns = s4.towns.map(cloneTown);
      w.clusters = s4.clusters.map(cloneTown);
      w.tradeGateways = [];
      w.setStageRNG("stage5_airports");
      w.solveAndPlaceAirports();
      return {
        airports: w.airports.map(cloneAirport),
        tradeGateways: (w.tradeGateways || []).map(cloneTradeGateway),
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
      w.zoneColorIdx = new Int8Array(s2b.W * s2b.H).fill(-1);
      w.elevationField = s2b.elevationField;
      w.waterMask = s2b.waterMask;
      w.drainageField = s2b.drainageField;
      w.seaLevel = s2b.seaLevel;
      w.rivers = s2b.rivers;
      w.slopeField = s3.slopeField;
      w.fertilityField = s3.fertilityField;
      w.distToWater = s3.distToWater;
      w.urbanSuitability = s3.urbanSuitability;
      w.landmassId = s3.landmassId;
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
        zoneColorIdx: w.zoneColorIdx,
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
      w.elevationField = s2b.elevationField;
      w.waterMask = s2b.waterMask;
      w.drainageField = s2b.drainageField;
      w.seaLevel = s2b.seaLevel;
      w.slopeField = s3.slopeField;
      w.fertilityField = s3.fertilityField;
      w.distToWater = s3.distToWater;
      w.urbanSuitability = s3.urbanSuitability;
      w.landmassId = s3.landmassId;
      w.clusters = s4.clusters.map(cloneTown);
      w.towns = s67.towns.map(cloneTown);
      w.airports = s5.airports.map(cloneAirport);
      w.tradeGateways = (s5.tradeGateways || []).map(cloneTradeGateway);
      w.roadGrid.set(s67.roadGrid);
      w.buildingMask.set(s67.buildingMask);
      w.zoneColorIdx = s67.zoneColorIdx;
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
        tradeGateways: (w.tradeGateways || []).map(cloneTradeGateway),
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
      w.elevationField = s2b.elevationField;
      w.waterMask = s2b.waterMask;
      w.drainageField = s2b.drainageField;
      w.seaLevel = s2b.seaLevel;
      w.slopeField = s3.slopeField;
      w.fertilityField = s3.fertilityField;
      w.distToWater = s3.distToWater;
      w.urbanSuitability = s3.urbanSuitability;
      w.landmassId = s3.landmassId;
      w.clusters = s4.clusters.map(cloneTown);
      w.towns = s8.towns.map(cloneTown);
      w.airports = s8.airports.map(cloneAirport);
      w.tradeGateways = (s8.tradeGateways || []).map(cloneTradeGateway);
      w.roadGrid.set(s8.roadGrid);
      w.buildingMask.set(s8.buildingMask);
      w.zoneColorIdx = s67.zoneColorIdx;
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
      w._vehicleGraph = null;

      w.setStageRNG("stage9_ramps");
      w.finalizeExpresswayRampsAndTunnels();
      const mwayLog = w.logs[w.logs.length - 1];

      // Invoke onUrbanReady with post-clearance trees BEFORE Stage 9 cargo/commuter routing runs!
      if (onUrbanReady) {
        onUrbanReady(
          s2b,
          { ...s67, trees: w.trees.map((tr) => ({ ...tr })) },
          currentTerrainOrUrbanChanged,
        );
      }

      w.setStageRNG("stage8b_cargo");
      w.buildIndustrialCargoChain();
      w.buildCommuterRoutes();
      const cargoLog = w.logs[w.logs.length - 1];

      const roadTopology = deriveRoadTopology(
        w.W,
        w.H,
        w.roads,
        w.buildingMask,
      );
      const graph = ensureVehicleRoutingGraph(w);

      let com = 0;
      let raw = 0;
      let mfg = 0;
      let log = 0;
      for (const d of w.destinations) {
        if (d.zoneType === "commercial") {
          com++;
        } else if (d.zoneType === "industrial") {
          if (d.subType === "RAW") raw++;
          else if (d.subType === "MFG") mfg++;
          else if (d.subType === "LOG") log++;
        }
      }
      const rciCounts = { com, raw, mfg, log };

      return {
        towns: w.towns,
        airports: w.airports,
        tradeGateways: (w.tradeGateways || []).map(cloneTradeGateway),
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
        roadTopology,
        routingGraph: {
          roundabouts: graph.roundabouts,
          driveways: graph.driveways,
          rampEdges: graph.rampEdges,
          rampNodes: graph.rampNodes,
        },
        displacedBuildingsCount: w.displacedBuildingsCount,
        bridgeCount: w.bridgeCount,
        rciCounts,
        mwayLog,
        cargoLog,
      };
    },
  );

  return (config, targetWorld) => {
    const t0 = performance.now();
    w.ensureGridSize(config.worldSize || "standard");
    const noise = memoNoise(config.seed).value;
    const s1 = stage1_wind(config);
    const s2a = stage2a_terrain(config, noise);
    const s2b = stage2b_hydrology(config, noise, s2a.value);
    const hydroChanged = s2b.value.hydroVersion !== lastEmittedHydroVersion;

    // Notify parallel TerrainBakeWorker immediately once Stage 2B hydrology is ready!
    if (onHydrologyReady) {
      onHydrologyReady(s2b.value, hydroChanged);
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
    const terrainOrUrbanChanged =
      hydroChanged || s67.value.urbanVersion !== lastEmittedUrbanVersion;
    currentTerrainOrUrbanChanged = terrainOrUrbanChanged;

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

    // If Stage 9 was fully cached, invoke onUrbanReady with cached trees
    if (s9.cached && onUrbanReady) {
      onUrbanReady(
        s2b.value,
        { ...s67.value, trees: s9.value.trees },
        terrainOrUrbanChanged,
      );
    }
    lastEmittedHydroVersion = s2b.value.hydroVersion;
    lastEmittedUrbanVersion = s67.value.urbanVersion;

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
    out.tradeGateways = s9.value.tradeGateways || [];
    out.roadGrid = s9.value.roadGrid;
    out.buildingMask = s9.value.buildingMask;
    out.roads = s9.value.roads;
    out.roadEdges = s9.value.roadTopology.roadEdges || new Set();
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
    out.terrainUnchanged = !terrainOrUrbanChanged;
    out.logs = [
      s1.value.windLog,
      s2b.value.hydroLog,
      s4.value.settlementLog,
      s5.value.airportLog,
      s67.value.roadLog,
      s9.value.mwayLog,
      s9.value.cargoLog,
    ].filter(Boolean);

    out.roadTopology = s9.value.roadTopology;
    out.routingGraph = s9.value.routingGraph;
    out.rciCounts = s9.value.rciCounts;

    out.genTimeMs = Math.round(performance.now() - t0);
    return out;
  };
}

/**
 * @param {ProceduralLogisticsWorld} world
 * @returns {ArrayBufferLike[]}
 */
export function extractWorldTransferables(world) {
  Reflect.deleteProperty(world, "rng");
  Reflect.deleteProperty(world, "noise");
  Reflect.deleteProperty(world, "roadEdges");
  Reflect.deleteProperty(world, "_vehicleGraph");
  Reflect.deleteProperty(world, "_astarG");
  Reflect.deleteProperty(world, "_astarParent");
  Reflect.deleteProperty(world, "_astarSeenGen");
  Reflect.deleteProperty(world, "_astarClosedGen");
  Reflect.deleteProperty(world, "_coarseBaseCost");
  Reflect.deleteProperty(world, "_coarseG");
  Reflect.deleteProperty(world, "_coarseParent");
  Reflect.deleteProperty(world, "_coarseSeenGen");
  Reflect.deleteProperty(world, "_coarseClosedGen");

  world.routingGraph = {
    roundabouts: world.routingGraph?.roundabouts || [],
    driveways: world.routingGraph?.driveways || [],
    rampEdges: world.routingGraph?.rampEdges || [],
    rampNodes: world.routingGraph?.rampNodes || [],
  };
  if (world.roadTopology) {
    world.roadTopology = {
      vertexDeg: world.roadTopology.vertexDeg,
      edgeCount: world.roadTopology.edgeCount,
      streetTiles: world.roadTopology.streetTiles,
      arterialTiles: world.roadTopology.arterialTiles,
      bridgeTiles: world.roadTopology.bridgeTiles,
      junctionCount: world.roadTopology.junctionCount,
      anomalies: world.roadTopology.anomalies,
    };
  }

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
