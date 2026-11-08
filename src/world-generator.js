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
export const WORLD_SIZE_PRESETS = Object.freeze({
  compact: Object.freeze({ W: 240, H: 150, tileSize: 15, label: '240×150 Grid' }),
  standard: Object.freeze({ W: 360, H: 224, tileSize: 15, label: '360×224 Grid' }),
  large: Object.freeze({ W: 540, H: 336, tileSize: 12, label: '540×336 Grid' }),
  huge: Object.freeze({ W: 720, H: 448, tileSize: 10, label: '720×448 Grid' })
});

export class ProceduralLogisticsWorld {
  constructor(config = {}) {
    this.config = config;
    this.W = 0;
    this.H = 0;
    this.tileSize = 15;
    this.seaLevel = 0.34;
    this.ensureGridSize(config.worldSize || 'standard');

    // High-level generated entities
    this.rivers = [];
    this.hydroFeatures = [];
    this.clusters = [];
    this.towns = [];
    this.airports = [];
    this.roads = [];
    this.motorways = [];
    this.interchanges = [];
    this.houses = [];
    this.destinations = [];
    this.cargoLinks = [];
    this.trees = [];
    this.logs = [];
    this.displacedBuildingsCount = 0;
    this.windAngleIndex = 0;
    this.windVector = { x: 1, y: 0, angleDeg: 0, label: '09/27 (E-W)' };
  }

  ensureGridSize(worldSize = 'standard') {
    const preset = WORLD_SIZE_PRESETS[worldSize] || WORLD_SIZE_PRESETS.standard;
    if (this.W === preset.W && this.H === preset.H && this.tileSize === preset.tileSize && this.elevationField) {
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
        this.addRoadEdge(Math.round(p0.x), Math.round(p0.y), Math.round(p1.x), Math.round(p1.y));
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
          const code = r.type === 'street' ? 1 : 2;
          if (this.roadGrid[id] === 0 || (this.roadGrid[id] === 1 && code === 2)) {
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
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

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
    return x >= margin && x < this.W - margin && y >= margin && y < this.H - margin;
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
    const fallback = 'Metro ' + (usedNames.size + 1);
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
        if (slope > 0.48 || this.elevationField[id] > this.seaLevel + 0.42) continue;
        const dW = this.distToWater[id];
        candidateSites.push({
          x,
          y,
          lmId,
          slope,
          baseSuit: this.urbanSuitability[id] * 0.72,
          wfBonus13: Math.exp(-Math.pow((dW - 3.0) / 3.8, 2)) * 0.34,
          wfBonus4: Math.exp(-Math.pow((dW - 6.0) / 7.5, 2)) * 0.16
        });
      }
    }

    const majorIslandsCount = isIslandHopper
      ? this.landmasses.filter(lm => lm.size >= 160).length
      : 0;
    const phase1Count = Math.min(
      targetCount,
      Math.max(numRegional, isIslandHopper ? majorIslandsCount + 2 : numRegional)
    );

    for (let i = 0; i < phase1Count; i++) {
      const isClusterAnchor = i < numRegional;
      const tier = i < numMetros ? 1 : (i < numRegional ? 2 : 3);
      const urbanRadius = tier === 1 ? (isIslandHopper ? 17 : 21) : (tier === 2 ? 12 : 8);
      const minSpacing =
        (tier === 1 ? (isIslandHopper ? 78 : 105) : (tier === 2 ? (isIslandHopper ? 38 : 52) : 25)) *
        (tier <= 2 ? spanScale : 1.0);
      const maxSlope = tier <= 2 ? 0.38 : 0.46;

      let bestScore = -1;
      let bestPt = null;

      for (let cIdx = 0; cIdx < candidateSites.length; cIdx++) {
        const site = candidateSites[cIdx];
        if (site.slope > maxSlope) continue;
        const { x, y, lmId } = site;

        let tooClose = false;
        for (const t of this.towns) {
          const reqDist = (tier === 1 && t.tier === 1)
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

        let score = site.baseSuit + site.wfBonus13 + this.rng.range(-0.025, 0.025);

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
        const tierTitle = tier === 1 ? 'Metropolis' : (tier === 2 ? 'Regional City' : 'Market Town');
        const name = this.generateTopographicTownName(bestPt.x, bestPt.y, usedNames);
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
          _seededInPhase1: true,
          boroughs: [{ x: bestPt.x, y: bestPt.y, r: urbanRadius }]
        };
        this.towns.push(townObj);
        if (isClusterAnchor) {
          this.clusters.push(townObj);
        }
      }
    }
    this.logs.push(
      `Seeded <b>${this.towns.length} founding capitals & regional cities</b> (2 Metropolises, ${this.towns.length - 2} Regional Ports).`
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
      const y0 = Math.max(22, hostTown.y - scanR);
      const y1 = Math.min(this.H - 22, hostTown.y + scanR);
      const x0 = Math.max(22, hostTown.x - scanR);
      const x1 = Math.min(this.W - 22, hostTown.x + scanR);

      let sumMetroX = 0, sumMetroY = 0;
      for (const otherT of this.towns) {
        sumMetroX += otherT.x;
        sumMetroY += otherT.y;
      }
      const metroCx = sumMetroX / (this.towns.length || 1);
      const metroCy = sumMetroY / (this.towns.length || 1);
      const angleTrig = angleCandidates.map(rad => ({ rad, cosA: Math.cos(rad), sinA: Math.sin(rad) }));
      const minInscribedDistToWater = isIslandHopper ? 1.8 : Math.min(4.2, halfWid + 1.0);
      const maxCenterSlope = isIslandHopper ? 0.48 : 0.40;
      const idealDist = hostTown.urbanRadius + (isHub ? 7.5 : 5.5);
      const minHostDist = hostTown.urbanRadius * (isIslandHopper ? 0.72 : 0.82);
      const maxHostDist = idealDist + 24;
      const candStubDist = isHub ? 5.8 : (isIslandHopper ? 4.0 : 4.6);

      // Hoist (cx, cy) candidate site filtering outside the angle loop so angle-independent
      // terrain, shoreline inscribed-circle, NIMBY, and airspace checks run once per cell
      for (let cy = y0; cy <= y1; cy += 2) {
        for (let cx = x0; cx <= x1; cx += 2) {
          if (cx > this.W - 56 && cy < 36) continue;
          if (cx < 88 && cy < 28) continue;
          const id = this.idx(cx, cy);
          if (this.waterMask[id] > 0) continue;
          if (this.slopeField[id] > maxCenterSlope || this.distToWater[id] < minInscribedDistToWater) continue;

          const distHost = Math.hypot(cx - hostTown.x, cy - hostTown.y);
          if (distHost < minHostDist || distHost > maxHostDist) continue;

          // NIMBY & Urban Core Exclusion against ALL towns (angle-independent)
          let nimbyViolation = false;
          for (const t of this.towns) {
            const dTown = Math.hypot(cx - t.x, cy - t.y);
            if (dTown < t.urbanRadius * (isIslandHopper ? 0.72 : 0.80) + (isHub ? 1.8 : 1.0)) {
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

          const proximityScore = Math.exp(-Math.pow((distHost - idealDist) / 11.0, 2));
          const toTownX = hostTown.x - cx;
          const toTownY = hostTown.y - cy;
          const toMetroDist = Math.hypot(metroCx - cx, metroCy - cy) || 1;

          for (const { rad, cosA, sinA } of angleTrig) {
            const dotNormal = toTownX * (-sinA) + toTownY * cosA;
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
            if (!isIslandHopper && landsideTownsCount < (isHub && this.towns.length >= 4 ? 2 : 1)) continue;
            const inwardMetroDot = ((metroCx - cx) * candLandNx + (metroCy - cy) * candLandNy) / toMetroDist;
            if (!isIslandHopper && isHub && inwardMetroDot < -0.25) continue;

            // Oriented Bounding Box Footprint & Flat-Terrain Slope Check
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
        if (stubPts.length === 0 || stubPts[stubPts.length - 1].x !== sx || stubPts[stubPts.length - 1].y !== sy) {
          stubPts.push({ x: sx, y: sy, isBridge: false });
        }
      }
    }
    for (let i = 0; i < stubPts.length - 1; i++) {
      this.addRoadEdge(stubPts[i].x, stubPts[i].y, stubPts[i + 1].x, stubPts[i + 1].y);
    }

    ap.accessStubPts = stubPts;
    if (stubPts.length >= 2) {
      this.roads.push({ points: stubPts, type: 'airport-spine', airportId: ap.id });
    }

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
          ridgePenalty += Math.max(0, this.elevationField[id] - this.seaLevel - 0.12) * 24.0 + this.slopeField[id] * 12.0;
        }
      }
      const diffCluster = a.ref.clusterId !== b.ref.clusterId ? 24 : 0;
      const waterCost =
        (riverHits > 0 ? 22 + riverHits * 3.5 : 0) +
        (seaHits > 0 ? (this.config.archetype === 'island-hopper' ? 28 + seaHits * 5.0 : 85 + seaHits * 32.0) : 0);
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
    const scaleSpan = Math.max(1, this.W / 360);
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
      const path = this.findRoadPathAStar(nodes[i].x, nodes[i].y, nodes[j].x, nodes[j].y, true);
      if (path) {
        const bridgeTiles = path.filter(pt => pt.isBridge).length;
        if (isIslandHopper && !sameLandmass && bridgeTiles > 20) continue;
        if (!isIslandHopper && bridgeTiles > 11 && sameLandmass) continue;
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
        `Routed <b>${this.roads.length} regional roads & streets</b> and <b>${this.bridgeCount} bridges</b>.`
      );
      return;
    }

    const usedNames = new Set(this.towns.map(t => t.name));
    const isIslandHopper = this.config.archetype === 'island-hopper';
    const landmassTownCount = new Int16Array(Math.max(1, this.landmasses.length));
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
          t => Math.hypot(x - t.x, y - t.y) < t.urbanRadius + 6.5
        );
        if (insidePhase1) continue;
        trunkRoadPts.push({ x, y });

        let nearBridge = false;
        for (let dy = -4; dy <= 4 && !nearBridge; dy += 2) {
          for (let dx = -4; dx <= 4; dx += 2) {
            if (this.inBounds(x + dx, y + dy, 1) && this.roadGrid[this.idx(x + dx, y + dy)] === 3) {
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
        if (slope > 0.44 || this.elevationField[id] > this.seaLevel + 0.36) continue;
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
          wfBonus4: Math.exp(-Math.pow((dW - 6.0) / 7.5, 2)) * 0.16
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
          const reqDist = Math.max(minSpacing, (t.urbanRadius + urbanRadius) * 1.28);
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
        let score = site.baseSuit + waterfrontBonus + this.rng.range(-0.025, 0.025);

        if (isIslandHopper && landmassTownCount[lmId] === 0 && this.landmasses[lmId].size >= 160) {
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
        const tierTitle = tier === 3 ? 'Market Town' : 'Rural Hamlet';
        const name = this.generateTopographicTownName(bestPt.x, bestPt.y, usedNames);
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
          _seededInPhase1: false,
          boroughs: [{ x: bestPt.x, y: bestPt.y, r: urbanRadius }]
        };

        // Immediately connect this newly nucleated town into the growing trunk road network
        // so subsequent towns & hamlets can also nucleate along its branch road & river bridges!
        if (this.roadGrid[this.idx(townObj.x, townObj.y)] === 0) {
          const tp = bestPt.nearTrunkPt;
          let path = tp ? this.findRoadPathAStar(townObj.x, townObj.y, tp.x, tp.y, true, null, true) : null;
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
              path = this.findRoadPathAStar(townObj.x, townObj.y, nearestTarget.x, nearestTarget.y, true, null, true);
            }
          }
          if (path && path.length >= 2) {
            this.commitRoadPath(path, 'arterial');
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
    this.carveTownStreetGrids(t => !t._seededInPhase1);

    this.logs.push(
      `Co-evolved <b>${this.towns.length} settlements</b> (${newTowns.length} bridgehead/crossroads towns nucleated along <b>${this.roads.length} trunk roads</b> & <b>${this.bridgeCount} bridges</b>).`
    );
  }

  findRoadPathAStar(sx, sy, ex, ey, allowWaterBridge = true, blockedFn = null, stopOnExistingRoad = false, options = null) {
    const { W } = this;
    const isInterchangeBypass = Boolean(options && options.isInterchangeBypass);
    const customTurnPenalty = options && options.turnPenalty !== undefined ? options.turnPenalty : null;
    const extraCostFn = options && options.extraCostFn ? options.extraCostFn : null;
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
      const gpid = pid !== -1 ? parent[pid] : -1;
      const gPrevDx = gpid !== -1 ? (pid % W) - (gpid % W) : 0;
      const gPrevDy = gpid !== -1 ? Math.floor(pid / W) - Math.floor(gpid / W) : 0;
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
          isInterchangeBypass || (this.buildingMask[cid] === 4 && this.buildingMask[nid] === 4);
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
          stepCost *= 0.10;
        } else if (this.roadGrid[nid] > 0) {
          stepCost *= this.roadGrid[cid] === 0 ? 0.35 : 0.65;
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
            stepCost *= crossesToBank ? 8.5 : 65.0;
          } else {
            let crossesNarrowBay = false;
            for (let s = 1; s <= 9; s++) {
              const bx = nx + dx * s;
              const by = ny + dy * s;
              if (this.inBounds(bx, by, 1) && this.waterMask[this.idx(bx, by)] === 0) {
                crossesNarrowBay = true;
                break;
              }
            }
            stepCost *= crossesNarrowBay ? 24.0 : (this.config.archetype === 'island-hopper' ? 38.0 : 95.0);
          }
          if (currIsWater && pid !== -1 && (dx !== prevDx || dy !== prevDy)) {
            stepCost += 85.0;
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
          // Topographic valley-following & contour-hugging cost:
          // Penalize both uphill and downhill grade nonlinearly (`absDeltaElev^2`) and strongly penalize
          // climbing onto upland contour terraces (`hAbove > 0.105`) so roads hug valley floors around hills!
          const hAbove = Math.max(0, this.elevationField[nid] - this.seaLevel);
          const uplandOver = Math.max(0, hAbove - 0.105);
          const absDeltaElev = Math.abs(this.elevationField[nid] - this.elevationField[cid]) / baseStep;
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
          if (this.zoneColorIdx[nid] < 0 && !isInterchangeBypass && this.noise) {
            const meanderMod = (this.noise.fbm(nx * 0.048 + 1.9, ny * 0.048 + 6.2, 2) + 0.45) * 0.68;
            stepCost += Math.max(0, meanderMod);
          }
          // Strongly prefer existing orthogonal streets inside urban zones; never carve a parallel street 1-2 tiles away!
          if (this.zoneColorIdx[nid] >= 0 && !isInterchangeBypass && this.buildingMask[nid] !== 4) {
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
          if (extraCostFn) {
            stepCost += extraCostFn(nx, ny);
          }
        }

        // Penalize direction changes (`dx !== prevDx || dy !== prevDy`) with a gentle rural bend cost (0.85)
        // plus a 2-step anti-oscillation guard (`gpid`) so roads curve around hills without 1-tile staircases!
        if (pid !== -1 && (dx !== prevDx || dy !== prevDy)) {
          if (customTurnPenalty !== null) {
            stepCost += customTurnPenalty;
          } else {
            const inUrban = this.zoneColorIdx[cid] >= 0 || this.zoneColorIdx[nid] >= 0;
            stepCost += inUrban ? 4.2 : 0.85;
            if (!inUrban && gpid !== -1 && (prevDx !== gPrevDx || prevDy !== gPrevDy)) {
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

  commitRoadPath(path, roadType = 'arterial', extraProps = null) {
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
      if (roadType === 'street' || pts.length < 3) return pts;
      const out = [pts[0]];
      for (let i = 1; i < pts.length - 1; i++) {
        const prev = out[out.length - 1];
        const curr = pts[i];
        const next = pts[i + 1];

        const isKeyNode =
          this.airports.some(a => a.gateX === curr.x && a.gateY === curr.y) ||
          this.interchanges.some(ic => ic.x === curr.x && ic.y === curr.y);
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
            (this.buildingMask[pid] === 4 || this.buildingMask[cid] === 4 || this.buildingMask[nid] === 4) &&
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
    if (roadType === 'arterial') {
      this.anchorStreetToArterialCore(Math.round(pts[0].x), Math.round(pts[0].y));
      this.anchorStreetToArterialCore(Math.round(pts[pts.length - 1].x), Math.round(pts[pts.length - 1].y));
    }

    // Emit contiguous spans of new edges (`!this.hasRoadEdge(p0, p1)`) so every new step
    // between two existing roads is preserved while shared trunk edges are never double-drawn!
    let seg = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const x0 = Math.round(p0.x), y0 = Math.round(p0.y);
      const x1 = Math.round(p1.x), y1 = Math.round(p1.y);
      if (!this.hasRoadEdge(x0, y0, x1, y1)) {
        if (seg.length === 0) seg.push({ ...p0, x: x0, y: y0 });
        seg.push({ ...p1, x: x1, y: y1 });
        this.addRoadEdge(x0, y0, x1, y1);
      } else {
        if (seg.length >= 2) {
          this.roads.push({ points: seg, type: roadType, ...(extraProps || {}) });
        }
        seg = [];
      }
    }
    if (seg.length >= 2) {
      this.roads.push({ points: seg, type: roadType, ...(extraProps || {}) });
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
          this.roadGrid[id] = roadType === 'street' ? 1 : 2;
        } else if (this.roadGrid[id] === 1 && roadType === 'arterial') {
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
    const { W, H } = this;
    const size = W * H;
    const frontageMask = new Uint8Array(size);

    for (const h of this.houses) {
      const rx = Math.round(h.roadX), ry = Math.round(h.roadY);
      if (this.inBounds(rx, ry, 1)) frontageMask[this.idx(rx, ry)] = 1;
    }
    for (const d of this.destinations) {
      const rx = Math.round(d.roadX), ry = Math.round(d.roadY);
      if (this.inBounds(rx, ry, 1)) frontageMask[this.idx(rx, ry)] = 1;
      const wT = d.wTiles || 2;
      const hT = d.hTiles || 2;
      for (let dy = -1; dy <= hT; dy++) {
        for (let dx = -1; dx <= wT; dx++) {
          const px = d.gx + dx, py = d.gy + dy;
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
    for (let id = 0; id < size; id++) {
      if (this.roadGrid[id] >= 2) {
        arterialTouch[id] = 1;
      }
    }
    for (const ic of this.interchanges) {
      if (ic.type === 'terminal-stub') {
        const gx = Math.round(ic.x), gy = Math.round(ic.y);
        if (this.inBounds(gx, gy, 1)) arterialTouch[this.idx(gx, gy)] = 1;
      } else if (ic.type === 'diamond-ramp' && ic.connectX !== undefined) {
        const gx = Math.round(ic.connectX), gy = Math.round(ic.connectY);
        if (this.inBounds(gx, gy, 1)) arterialTouch[this.idx(gx, gy)] = 1;
      }
    }
    for (const r of this.roads) {
      if (r.type !== 'street') {
        for (const pt of r.points) {
          const gx = Math.round(pt.x), gy = Math.round(pt.y);
          if (this.inBounds(gx, gy, 1)) {
            arterialTouch[this.idx(gx, gy)] = 1;
          }
          if (r.isMainBoulevard) {
            seedRoot(gx, gy);
          }
        }
      }
    }

    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
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
      if (r.type !== 'street') continue;
      for (const pt of r.points) {
        const gx = Math.round(pt.x);
        const gy = Math.round(pt.y);
        if (!this.inBounds(gx, gy, 1)) continue;
        const id = this.idx(gx, gy);
        if ((hasNearbyBuilding(gx, gy) || arterialTouch[id] === 1) && seenGen[id] === gen) {
          let cur = id;
          while (cur !== -1) {
            keepMask[cur] = 1;
            cur = parent[cur];
          }
        }
      }
    }

    // End-only trimming (`firstKeep .. lastKeep`): never punch holes in the middle of a street!
    const cleanedRoads = [];
    for (const r of this.roads) {
      if (r.type !== 'street') {
        cleanedRoads.push(r);
        continue;
      }
      const pts = r.points;
      const isVertexAnchored = (pt) => {
        const gx = Math.round(pt.x);
        const gy = Math.round(pt.y);
        const id = this.idx(gx, gy);
        return keepMask[id] === 1 || arterialTouch[id] === 1 || hasNearbyBuilding(gx, gy);
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
          points: pts.slice(firstKeep, lastKeep + 1)
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
    const dirs8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
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

    this.roads = cleanedRoads.filter(r => {
      if (r.type !== 'street') return true;
      return r.points.some(pt => reachable[this.idx(Math.round(pt.x), Math.round(pt.y))] === 1);
    });
    this.rebuildRoadGridAndEdges();
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
      if (this.waterMask[id] !== 0 || this.buildingMask[id] !== 0 || this.distToWater[id] < 2.35) return false;
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
      this.roads.push({ points: pts, type: isMainBoulevard ? 'arterial' : 'street', isMainBoulevard });
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
          const lid = this.idx(cand.gx + dx, cand.gy + dy);
          this.buildingMask[lid] = 2;
          this.zoneColorIdx[lid] = town.colorIdx;
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
        if (this.waterMask[id] > 0 || this.buildingMask[id] > 0 || this.roadGrid[id] > 0 || this.distToWater[id] < 2.35) continue;
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
      // Strictly route freight trucks along committed road edges (`this.roadEdges`)!
      const roadPath = this.findRoadPathAStar(
        sx,
        sy,
        ex,
        ey,
        true,
        (nx, ny, cx, cy) => !this.hasRoadEdge(cx, cy, nx, ny)
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
        const hid = this.idx(h.x, h.y);
        if (this.buildingMask[hid] === 1) this.buildingMask[hid] = 4;
        const t = this.towns[h.townId];
        if (t && t.housesCount > 0) t.housesCount--;
      }
      return keep;
    });

    const beforeDest = this.destinations.length;
    this.destinations = this.destinations.filter(d => {
      const keep = (d.x - cx) * (d.x - cx) + (d.y - cy) * (d.y - cy) > (radius + 1.2) * (radius + 1.2);
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
    let bestStubCost = Infinity;

    for (const rScale of radiusScales) {
      for (const aOff of angleOffsets) {
        const ang = baseAngle + aOff;
        const r = baseRadius * rScale;
        const candX = Math.max(7, Math.min(this.W - 8, Math.round(town.x + Math.cos(ang) * r)));
        const candY = Math.max(7, Math.min(this.H - 8, Math.round(town.y + Math.sin(ang) * r)));
        const cid = this.idx(candX, candY);

        if (this.waterMask[cid] > 0 || this.distToWater[cid] < 3.2) continue;
        if (this.buildingMask[cid] >= 1 && this.buildingMask[cid] <= 3) continue;
        if (this.isPointInAirportPad(candX, candY, 2.5)) continue;

        const tooCloseStub = this.interchanges.some(
          ic => Math.hypot(ic.x - candX, ic.y - candY) < 11.0
        );
        if (tooCloseStub) continue;

        // Never plant a terminal roundabout on or near the shoulder of an existing motorway (`HARBOR-305` invariant)!
        const tooCloseMotorway = this.motorways.some(mw =>
          mw.samples.some(pt => Math.hypot(pt.x - candX, pt.y - candY) < 15.0)
        );
        if (tooCloseMotorway) continue;

        const hAbove = Math.max(0, this.elevationField[cid] - this.seaLevel);
        const stubCost =
          Math.abs(aOff) * 0.45 +
          Math.abs(rScale - 1.0) * 1.2 +
          hAbove * 28.0 +
          this.slopeField[cid] * 14.0;
        if (stubCost >= bestStubCost) continue;

        const tiePath = this.findRoadPathAStar(candX, candY, town.x, town.y, false, null, true);
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
          const candX = Math.max(5, Math.min(this.W - 6, Math.round(town.x + Math.cos(ang) * r)));
          const candY = Math.max(5, Math.min(this.H - 6, Math.round(town.y + Math.sin(ang) * r)));
          const cid = this.idx(candX, candY);
          if (this.waterMask[cid] > 0 || this.distToWater[cid] < 2.2) continue;
          if (this.buildingMask[cid] >= 1 && this.buildingMask[cid] <= 3) continue;
          if (this.isPointInAirportPad(candX, candY, 2.2)) continue;
          const tooCloseMotorway = this.motorways.some(mw =>
            mw.samples.some(pt => Math.hypot(pt.x - candX, pt.y - candY) < 13.5)
          );
          if (tooCloseMotorway) continue;
          const tiePath = this.findRoadPathAStar(candX, candY, town.x, town.y, true, null, true);
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
      this.commitRoadPath(chosenTiePath, 'arterial', { stubOriginX: chosenAx, stubOriginY: chosenAy });
    }

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
    if (this.waterMask[cid] > 0 || this.distToWater[cid] < 6.0) return false;
    if (this.isPointInAirportPad(x, y, 3.8)) return false;
    // Never place a Trumpet interchange inside a town's dense core (`< urbanRadius * 0.85`)
    for (const t of this.towns) {
      if (Math.hypot(x - t.x, y - t.y) < t.urbanRadius * 0.85) return false;
    }

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

          const minCrossArm = this.motorways.length >= 2 ? 28 : 20;
          if (dStartA < 20 || dEndA < 20 || dStartB < minCrossArm || dEndB < minCrossArm) return Infinity;
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
    let tunnelRunArc = 0;
    let totalTunnelArc = 0;

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
        const dWater = this.distToWater[id];
        if (dWater < 3.6) {
          penalty += (3.8 - dWater) * 7.5 * segLen;
        }
        // Topographic valley preference & tunnel portal discipline:
        // Expressways strongly prefer incised river valleys & low passes, and only bore short perpendicular mountain tunnels!
        const hAbove = Math.max(0, this.elevationField[id] - this.seaLevel);
        const ridgeElev = Math.max(0, hAbove - 0.115);
        penalty += segLen * (hAbove * 18.0 + ridgeElev * 42.0 + this.slopeField[id] * 12.5);
        if (i > 0) {
          const prevPt = samples[i - 1];
          const prevId = this.idx(Math.round(prevPt.x), Math.round(prevPt.y));
          const dElev = Math.abs(this.elevationField[id] - this.elevationField[prevId]);
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
        if (allowTouchTrunkNum === other.number && i > samples.length - 22) continue;
        const sharedStart =
          Math.hypot(sx - other.sx, sy - other.sy) < 2.5 || Math.hypot(sx - other.ex, sy - other.ey) < 2.5;
        const sharedEnd =
          Math.hypot(ex - other.sx, ey - other.sy) < 2.5 || Math.hypot(ex - other.ex, ey - other.ey) < 2.5;
        if ((i <= 4 && sharedStart) || (i >= samples.length - 5 && sharedEnd)) continue;

        if (
          Math.hypot(pt.x - other.sx, pt.y - other.sy) < 11.5 ||
          Math.hypot(pt.x - other.ex, pt.y - other.ey) < 11.5
        ) {
          return Infinity;
        }
        for (let j = 2; j < other.samples.length - 2; j += 2) {
          const d = Math.hypot(pt.x - other.samples[j].x, pt.y - other.samples[j].y);
          // Endpoints of a non-trumpet motorway must NEVER land within 13.5 tiles of another motorway's interior!
          if ((i <= 3 || i >= samples.length - 4) && d < 13.5) {
            return Infinity;
          }
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
        if (rawPts.length < 3) return [{ x: sx, y: sy }, { x: ex, y: ey }];

        // Extract denser control points directly from the A* valley path (`every ~3 coarse steps, up to 14 points`)
        // without adding a synthetic 16-tile sine wave that pushes waypoints out of the valley onto mountain ridges!
        let maxHAbove = 0;
        for (const p of rawPts) {
          const pid = this.idx(Math.max(0, Math.min(this.W - 1, p.x)), Math.max(0, Math.min(this.H - 1, p.y)));
          const ha = Math.max(0, this.elevationField[pid] - this.seaLevel);
          if (ha > maxHAbove) maxHAbove = ha;
        }
        let outWps = [{ x: sx, y: sy }];
        const numCtrl = Math.min(14, Math.max(5, Math.floor(rawPts.length / 3)));
        // Only apply a subtle <= 2.2-tile S-curve grace when the entire corridor lies on a dead-flat lowland plain
        const flatPlainWaveAmp = maxHAbove < 0.08 ? Math.min(2.2, chordLen * 0.025) * (lateralBias >= 0 ? 1 : -1) : 0;
        for (let k = 1; k <= numCtrl; k++) {
          const frac = k / (numCtrl + 1);
          const idx = Math.floor(frac * (rawPts.length - 1));
          const wave = Math.sin(frac * Math.PI * 2) * flatPlainWaveAmp;
          const wx = rawPts[idx].x + chordNx * wave;
          const wy = rawPts[idx].y + chordNy * wave;
          if (this.inBounds(Math.round(wx), Math.round(wy), 5) && !this.isPointInAirportPad(wx, wy, 2.2, airportId)) {
            outWps.push({ x: wx, y: wy });
          } else {
            outWps.push({ x: rawPts[idx].x, y: rawPts[idx].y });
          }
        }
        outWps.push({ x: ex, y: ey });

        for (let pass = 0; pass < 4; pass++) {
          const nextWps = [outWps[0]];
          for (let i = 1; i < outWps.length - 1; i++) {
            const nx = 0.25 * outWps[i - 1].x + 0.50 * outWps[i].x + 0.25 * outWps[i + 1].x;
            const ny = 0.25 * outWps[i - 1].y + 0.50 * outWps[i].y + 0.25 * outWps[i + 1].y;
            const curId = this.idx(Math.round(outWps[i].x), Math.round(outWps[i].y));
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
      const currElev = this.inBounds(currGx, currGy, 1) ? this.elevationField[this.idx(currGx, currGy)] : this.seaLevel;
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
        const absDeltaH = Math.abs(this.elevationField[id] - currElev) / baseStep;

        let cost = baseStep * stride + baseCostTable[nid] + absDeltaH * 145.0;
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

  createMotorwayEntity(number, sx, sy, ex, ey, airportId = null, townId = null, forcedViaPt = null) {
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    const ap = airportId !== null ? this.airports[airportId] : null;
    const departPull = ap ? Math.min(20, Math.max(7.0, len * 0.30)) : 0;

    const candidateCurves = [];

    const defaultSign = number % 2 === 0 ? 1 : -1;
    const preferMag = Math.min(7.5, len * 0.09);
    const preferOff = defaultSign * preferMag;

    if (forcedViaPt && !ap) {
      // Route Cloverleaf transverse trunks (`M-2`) through two chained valley A* legs (`start -> forcedViaPt -> end`)
      // with colinear tangent alignment across `forcedViaPt` so M-2 follows topographic valleys on both sides!
      for (const bias of [0, defaultSign * 10, -defaultSign * 10]) {
        const leg1 = this.findValleyMotorwayWaypoints(sx, sy, forcedViaPt.x, forcedViaPt.y, null, bias);
        const leg2 = this.findValleyMotorwayWaypoints(forcedViaPt.x, forcedViaPt.y, ex, ey, null, -bias);
        if (leg1 && leg2 && leg1.length >= 2 && leg2.length >= 2) {
          const joined = [...leg1, ...leg2.slice(1)];
          const vIdx = leg1.length - 1;
          if (vIdx >= 1 && vIdx < joined.length - 1) {
            joined[vIdx - 1] = {
              x: 0.55 * joined[vIdx - 1].x + 0.45 * (2 * forcedViaPt.x - joined[vIdx + 1].x),
              y: 0.55 * joined[vIdx - 1].y + 0.45 * (2 * forcedViaPt.y - joined[vIdx + 1].y)
            };
          }
          candidateCurves.push({
            waypoints: joined,
            isCloverleafTarget: true,
            isValleyCorridor: true,
            off: 0,
            preferOff: 0
          });
        }
      }
      const c1x = 2 * forcedViaPt.x - 0.5 * (sx + ex);
      const c1y = 2 * forcedViaPt.y - 0.5 * (sy + ey);
      candidateCurves.push({
        waypoints: [{ x: sx, y: sy }, { x: c1x, y: c1y }, { x: ex, y: ey }],
        isCloverleafTarget: true,
        off: 0,
        preferOff: 0
      });
    }

    // 1. Terrain-Guided A* Valley Corridor B-Spline Candidates (enabled for both airport & city trunks!)
    if (len >= 28) {
      const vStartX = ap ? sx + ap.landNx * Math.min(10, len * 0.14) : sx;
      const vStartY = ap ? sy + ap.landNy * Math.min(10, len * 0.14) : sy;
      for (const bias of [defaultSign * 14, -defaultSign * 14, 0]) {
        const valleyWps = this.findValleyMotorwayWaypoints(vStartX, vStartY, ex, ey, airportId, bias);
        if (valleyWps && valleyWps.length >= 4) {
          const fullWps = ap ? [{ x: sx, y: sy }, ...valleyWps] : valleyWps;
          candidateCurves.push({
            waypoints: fullWps,
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
            off,
            preferOff
          });
        }
      }
    }

    let bestCand = null;
    let bestScore = Infinity;

    for (const cand of candidateCurves) {
      const samples = this.sampleMotorwayCurve(cand.waypoints);
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
      airportId,
      townId,
      prunedStart: false,
      prunedEnd: false
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
          y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y
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
          y: c0 * p0.y + c1 * p1.y + c2 * p2.y + c3 * p3.y
        });
      }
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

    // Resample Chaikin polyline to 45 uniform arc-length samples (matching cubic Bezier sample density)
    // so `cosTurn` and `cosWide` evaluate consistent physical curvature radii!
    const cumLen = new Float32Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
      cumLen[i] = cumLen[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
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
        y: pts[segIdx].y + (pts[segIdx + 1].y - pts[segIdx].y) * t
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
      const beforeLen = this.roads.length;
      this.roads = this.roads.filter(
        r => !(r.stubOriginX !== undefined && Math.hypot(r.stubOriginX - x, r.stubOriginY - y) < 1.5)
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
  tryBuildTrumpetSpurToTrunk(number, originX, originY, airportId = null, townId = null) {
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
        const scaleSpan = Math.max(1, this.W / 360);
        const maxChord = (ap ? (ap.isHub ? 115 : 64) : 165) * scaleSpan;
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

          const cDx = hitPt.x - originX;
          const cDy = hitPt.y - originY;
          const cLen = Math.hypot(cDx, cDy) || 1;
          const cNx = -cDy / cLen;
          const cNy = cDx / cLen;

          const spurCandidates = [{ waypoints: [p0, p1, p2, p3], isValley: false }];
          // Add lateral C-curve Bezier candidates (`p1` offset perpendicular to chord) so Trumpet spurs
          // can curve gracefully around an isolated hill (`VALLEY-618`) into the perpendicular throat `p2 -> p3`!
          if (!ap) {
            for (const latFrac of [0.18, -0.18, 0.30, -0.30]) {
              const p1Lat = {
                x: p1.x + cNx * (chord * latFrac),
                y: p1.y + cNy * (chord * latFrac)
              };
              spurCandidates.push({ waypoints: [p0, p1Lat, p2, p3], isValley: false });
            }
          }
          // For medium/long spurs (chord >= 24, every 2nd trunk sample), also test terrain-following Valley A* paths into `p2 -> p3`!
          if (chord >= 24 && i % 2 === 0) {
            const vStart = ap ? p1 : p0;
            for (const bias of [0, 10, -10]) {
              const valleyWps = this.findValleyMotorwayWaypoints(vStart.x, vStart.y, p2.x, p2.y, airportId, bias);
              if (valleyWps && valleyWps.length >= 3) {
                const fullWps = ap ? [p0, ...valleyWps, p3] : [...valleyWps, p3];
                spurCandidates.push({ waypoints: fullWps, isValley: true });
              }
            }
          }

          for (const sc of spurCandidates) {
            const waypoints = sc.waypoints;
            const samples = this.sampleMotorwayCurve(waypoints);
            const score = this.scoreMotorwaySamples(samples, originX, originY, hitPt.x, hitPt.y, airportId, 0, 0, true, trunk.number);
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

        this.displaceBuildingsInRadius(hit.x, hit.y, 5.6);
        const cloverIc = {
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
        };
        this.displaceAndRerouteRoadsAtInterchange(cloverIc, false);
        this.interchanges.push(cloverIc);
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
   * Re-aims any house or commercial/industrial building whose driveway road tile (`roadX, roadY`)
   * was displaced (`roadGrid === 0`) onto an adjacent surviving road tile (`roadGrid === 1 || 2`),
   * or displaces the building if it no longer touches any active road.
   */
  rebindOrDisplaceOrphanedFrontage() {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    this.houses = this.houses.filter(h => {
      const rx = Math.round(h.roadX), ry = Math.round(h.roadY);
      if (this.inBounds(rx, ry, 1) && (this.roadGrid[this.idx(rx, ry)] === 1 || this.roadGrid[this.idx(rx, ry)] === 2)) {
        return true;
      }
      for (const [dx, dy] of dirs) {
        const nx = h.x + dx, ny = h.y + dy;
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

    this.destinations = this.destinations.filter(d => {
      const rx = Math.round(d.roadX), ry = Math.round(d.roadY);
      if (this.inBounds(rx, ry, 1) && (this.roadGrid[this.idx(rx, ry)] === 1 || this.roadGrid[this.idx(rx, ry)] === 2)) {
        return true;
      }
      const wT = d.wTiles || 2;
      const hT = d.hTiles || 2;
      for (let dx = 0; dx < wT; dx++) {
        for (const py of [-1, hT]) {
          const nx = d.gx + dx, ny = d.gy + py;
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
          const nx = d.gx + px, ny = d.gy + dy;
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
        if (d.zoneType === 'commercial' && t.commercialCount > 0) t.commercialCount--;
        if (d.zoneType === 'industrial' && t.industrialCount > 0) t.industrialCount--;
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
    if (ic.type === 'cloverleaf') {
      isInsideCore = (px, py) => Math.hypot(px - ic.x, py - ic.y) <= 3.6;
    } else if (ic.type === 'trumpet') {
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
    } else if (ic.type === 'diamond-ramp') {
      const cosA = Math.cos(ic.angleRad);
      const sinA = Math.sin(ic.angleRad);
      const nx = -sinA * ic.connSide;
      const ny = cosA * ic.connSide;
      isInsideCore = (px, py) => {
        const gx = Math.round(px);
        const gy = Math.round(py);
        if (gx === ic.connectX && gy === ic.connectY) return false;
        const dx = px - ic.x;
        const dy = py - ic.y;
        const u = dx * cosA + dy * sinA;
        const v = dx * nx + dy * ny;
        return Math.abs(u) <= 3.5 && v >= -0.4 && v < 2.55;
      };
    } else {
      return true;
    }

    const hasAnyRoadOverlap = this.roads.some(
      r => r.type !== 'airport-loop' && r.points.some(pt => isInsideCore(pt.x, pt.y))
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
      const rx = Math.round(h.roadX), ry = Math.round(h.roadY);
      if (this.inBounds(rx, ry, 1)) frontageMask[this.idx(rx, ry)] = 1;
    }
    for (const d of this.destinations) {
      const rx = Math.round(d.roadX), ry = Math.round(d.roadY);
      if (this.inBounds(rx, ry, 1)) frontageMask[this.idx(rx, ry)] = 1;
    }

    const strippedTile = new Uint8Array(total);
    const pullDist = new Uint8Array(total);
    const pullQ = [];

    for (const r of this.roads) {
      if (r.type === 'airport-loop' || r.type === 'airport-spine') continue;
      for (let i = 0; i < r.points.length; i++) {
        const pt = r.points[i];
        const gx = Math.round(pt.x), gy = Math.round(pt.y);
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

    const maxPullback = ic.type === 'diamond-ramp' ? 10 : 18;
    let pHead = 0;
    while (pHead < pullQ.length) {
      const cid = pullQ[pHead++];
      if (pullDist[cid] >= maxPullback) continue;
      for (const nid of (fullAdj.get(cid) || [])) {
        if (strippedTile[nid] === 1) continue;
        const nx = nid % this.W;
        const ny = Math.floor(nid / this.W);
        const isKey =
          this.airports.some(a => a.gateX === nx && a.gateY === ny) ||
          this.interchanges.some(otherIc => Math.round(otherIc.x) === nx && Math.round(otherIc.y) === ny);
        if (isKey || this.roadGrid[nid] === 3) continue;
        if (frontageMask[nid] === 1 && Math.hypot(nx - ic.x, ny - ic.y) > 6.8) continue;
        // Stop at degree >= 3 junctions so the junction tile itself acts as the wide-horizon portal!
        if (preDeg[nid] >= 3) continue;
        strippedTile[nid] = 1;
        pullDist[nid] = pullDist[cid] + 1;
        pullQ.push(nid);
      }
    }

    const isInsideFootprint = (px, py) =>
      isInsideCore(px, py) || strippedTile[this.idx(Math.round(px), Math.round(py))] === 1;

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
      if (r.type === 'airport-loop' || r.type === 'airport-spine') {
        if (r.points.some(pt => isInsideFootprint(pt.x, pt.y)) && requireCleanReroute) {
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

        const x0 = Math.round(p0.x), y0 = Math.round(p0.y);
        const x1 = Math.round(p1.x), y1 = Math.round(p1.y);
        const id0 = this.idx(x0, y0);
        const id1 = this.idx(x1, y1);
        addSubEdge(id0, id1);

        if (in0) {
          const prev = insideFlags.get(id0) || { isArterial: false, isMainBoulevard: false };
          insideFlags.set(id0, {
            isArterial: prev.isArterial || r.type !== 'street',
            isMainBoulevard: prev.isMainBoulevard || Boolean(r.isMainBoulevard)
          });
        } else {
          const prev = portals.get(id0) || { x: x0, y: y0, id: id0, isArterial: false, isMainBoulevard: false };
          portals.set(id0, {
            x: x0,
            y: y0,
            id: id0,
            isArterial: prev.isArterial || r.type !== 'street',
            isMainBoulevard: prev.isMainBoulevard || Boolean(r.isMainBoulevard)
          });
        }

        if (in1) {
          const prev = insideFlags.get(id1) || { isArterial: false, isMainBoulevard: false };
          insideFlags.set(id1, {
            isArterial: prev.isArterial || r.type !== 'street',
            isMainBoulevard: prev.isMainBoulevard || Boolean(r.isMainBoulevard)
          });
        } else {
          const prev = portals.get(id1) || { x: x1, y: y1, id: id1, isArterial: false, isMainBoulevard: false };
          portals.set(id1, {
            x: x1,
            y: y1,
            id: id1,
            isArterial: prev.isArterial || r.type !== 'street',
            isMainBoulevard: prev.isMainBoulevard || Boolean(r.isMainBoulevard)
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
        for (const nb of (subAdj.get(cur) || [])) {
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
          isMainBoulevard: groupMainBoulevard
        });
      }
    }

    // 3. Strip all vertices inside `isInsideFootprint` from `this.roads`
    const survivingRoads = [];
    for (const r of this.roads) {
      if (r.type === 'airport-loop' || r.type === 'airport-spine') {
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
      const rType = group.isArterial ? 'arterial' : 'street';
      const extraProps = group.isMainBoulevard ? { isMainBoulevard: true } : null;

      if (pts.length >= 2) {
        // Order portals by angle around `(ic.x, ic.y)` starting after the widest angular gap
        const withAng = pts
          .map(p => ({ ...p, ang: Math.atan2(p.y - ic.y, p.x - ic.x) }))
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
          turnPenalty: 7.5
        };

        for (let i = 0; i < ordered.length - 1; i++) {
          const pA = ordered[i];
          const pB = ordered[i + 1];
          const detour = this.findRoadPathAStar(pA.x, pA.y, pB.x, pB.y, true, isInsideCore, false, bypassOptions);
          if (detour && detour.length >= 2) {
            this.commitRoadPath(detour, rType, extraProps);
          } else if (requireCleanReroute) {
            return false;
          }
        }
      } else if (pts.length === 1 && ic.type === 'diamond-ramp' && ic.connectX !== undefined) {
        const pA = pts[0];
        const detour = this.findRoadPathAStar(pA.x, pA.y, ic.connectX, ic.connectY, true, isInsideCore, false, {
          isInterchangeBypass: true,
          turnPenalty: 6.5
        });
        if (detour && detour.length >= 2) {
          this.commitRoadPath(detour, rType, extraProps);
        }
      }
    }

    this.rebuildRoadGridAndEdges();
    this.rebindOrDisplaceOrphanedFrontage();
    return true;
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
          const cosA = Math.cos(angleRad);
          const sinA = Math.sin(angleRad);
          const nx = -sinA;
          const ny = cosA;
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
          const startId = this.idx(startX, startY);

          if (this.waterMask[startId] > 0 || this.distToWater[startId] < 2.5) continue;
          if (this.buildingMask[startId] >= 1 && this.buildingMask[startId] <= 3) continue;
          if (this.isPointInAirportPad(termX, termY, 2.5)) continue;

          const wingClear = !this.roads.some(r =>
            r.points.some(rp => {
              const rdx = rp.x - pt.x;
              const rdy = rp.y - pt.y;
              const ru = rdx * cosA + rdy * sinA;
              const rv = (rdx * nx + rdy * ny) * connSide;
              return Math.abs(ru) <= 3.6 && rv >= 0.2 && rv < 2.55;
            })
          );

          const score = 50 - minTownDist + (wingClear ? 25 : 0);
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

          this.displaceBuildingsInRadius(x, y, 4.4);
          this.displaceBuildingsInRadius(termX, termY, 2.8);

          const diamondIc = {
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
          };
          this.displaceAndRerouteRoadsAtInterchange(diamondIc, false);

          this.commitRoadPath(connectorPath, 'arterial');
          this.roadGrid[this.idx(startX, startY)] = 2;

          this.interchanges.push(diamondIc);
        }
      }
    }
  }

  buildNumberedMotorways() {
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
    const scaleSpan = Math.max(1, this.W / 360);
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
        const minPairD = isIslandHopper ? 36 : 78;
        if (d < minPairD || d > 245 * scaleSpan) continue;
        const sameIslandBonus = isIslandHopper && tA.landmassId === tB.landmassId ? 3.5 : 1.0;
        const diffClusterBonus = tA.clusterId !== tB.clusterId ? 4.20 : 0.18;
        const metroBonus = (tA.tier === 1 ? 1.6 : 1.0) * (tB.tier === 1 ? 1.6 : 1.0);
        const spanBell = 0.70 + 0.60 * Math.exp(-Math.pow((d - 135 * scaleSpan) / (56 * scaleSpan), 2));
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

      const mw1 = this.createMotorwayEntity(mwayNumber, startX, startY, endX, endY, startApId, tB.id);
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
          if (d < 46 || d > 235 * scaleSpan) continue;
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
          const dMid = Math.hypot(pt.x - midX, pt.y - midY) + this.interchangeRoadOverlapCost(pt.x, pt.y, 4.4) * 0.45;
          if (dMid < minViaDist) {
            minViaDist = dMid;
            bestViaPt = pt;
          }
        }

        const mw2 = this.createMotorwayEntity(mwayNumber, sx, sy, ex, ey, startApId, tD.id, bestViaPt);
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
            mEnd.usedHubGate ? mEnd.ap.id : null,
            cTown.id
          );
          if (spurRes) {
            if (mEnd.usedHubGate) mEnd.ap.motorwayId = mwayNumber;
            mwayNumber++;
            this.motorways.push(spurRes.mw);
            this.displaceBuildingsInRadius(spurRes.trumpetIc.x, spurRes.trumpetIc.y, 5.2);
            this.displaceAndRerouteRoadsAtInterchange(spurRes.trumpetIc, false);
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
            if (d < (isIslandHopper ? 24 : 34) || d > 225 * scaleSpan) continue;
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

            const mwCluster = this.createMotorwayEntity(mwayNumber, startX, startY, endX, endY, startApId, hubTown.id);
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
      const spurRes = this.tryBuildTrumpetSpurToTrunk(mwayNumber, apStubForSpur.x, apStubForSpur.y, ap.id, ap.hostTownId);
      if (spurRes) {
        ap.motorwayId = mwayNumber++;
        this.motorways.push(spurRes.mw);
        if (host) townMotorwayDegree[host.id]++;
        this.displaceBuildingsInRadius(spurRes.trumpetIc.x, spurRes.trumpetIc.y, 5.2);
        this.displaceAndRerouteRoadsAtInterchange(spurRes.trumpetIc, false);
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
          if (gateDist < minSpan || gateDist > 185 * scaleSpan) continue;

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
            ap.id, targetTown.id
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
      const spurRes = this.tryBuildTrumpetSpurToTrunk(mwayNumber, stub.x, stub.y, null, uTown.id);
      if (spurRes) {
        mwayNumber++;
        this.motorways.push(spurRes.mw);
        this.displaceBuildingsInRadius(spurRes.trumpetIc.x, spurRes.trumpetIc.y, 5.2);
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
          !this.interchanges.some(ic => Math.hypot(ic.x - pt.x, ic.y - pt.y) < 11.5);

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
          ang1: Math.atan2(p1.y - p1Prev.y, p1.x - p1Prev.x)
        });
      }
    }
  }

  populateLandscapeTrees() {
    const isIslandHopper = this.config.archetype === 'island-hopper';
    // Generate coherent upland woodland groves & windward rain-shadow forests (no confetti sprinkles!)
    for (let y = 5; y < this.H - 5; y += 2.4) {
      for (let x = 5; x < this.W - 5; x += 2.4) {
        const ix = Math.round(x), iy = Math.round(y);
        const id = this.idx(ix, iy);
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
            const tx = x + this.rng.range(-1.04, 1.04);
            const ty = y + this.rng.range(-1.04, 1.04);
            const gx = Math.round(tx), gy = Math.round(ty);
            if (!this.inBounds(gx, gy, 3)) continue;
            const gid = this.idx(gx, gy);
            if (this.waterMask[gid] > 0 || this.buildingMask[gid] > 0 || this.roadGrid[gid] > 0 || this.zoneColorIdx[gid] >= 0) continue;
            this.trees.push({
              x: tx,
              y: ty,
              r: this.rng.range(0.44, 0.78),
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
        const rad = this.rng.range(1.4, 3.6);
        const tx = hx + Math.cos(ang) * rad;
        const ty = hy + Math.sin(ang) * rad;
        const gx = Math.round(tx), gy = Math.round(ty);
        if (!this.inBounds(gx, gy, 3)) continue;
        const gid = this.idx(gx, gy);
        if (this.waterMask[gid] > 0 || this.buildingMask[gid] > 0 || this.roadGrid[gid] > 0 || this.zoneColorIdx[gid] >= 0) continue;
        this.trees.push({
          x: tx,
          y: ty,
          r: this.rng.range(0.52, 0.84),
          color: this.rng.pick(PALETTE.treeDots)
        });
      }
    }
  }
}
/**
 * Pure reactive/functional memoized stage combinator:
 * Compares the dependency tuple returned by `selectDeps(...args)` via `Object.is` (`===`).
 * Returns `{ value: Readonly<T>, cached: boolean, version: number }` in O(1) on cache hit.
 */
export function createMemoStage(selectDeps, computeFn) {
  let prevDeps = null;
  let cachedOutput = null;
  let version = 0;
  return (...args) => {
    const nextDeps = selectDeps(...args);
    const hit =
      prevDeps !== null &&
      prevDeps.length === nextDeps.length &&
      nextDeps.every((val, idx) => Object.is(val, prevDeps[idx]));
    if (hit) {
      return { value: cachedOutput, cached: true, version };
    }
    prevDeps = nextDeps;
    version++;
    cachedOutput = Object.freeze(computeFn(...nextDeps, version));
    return { value: cachedOutput, cached: false, version };
  };
}

const cloneTown = (t) => ({
  ...t,
  boroughs: t.boroughs ? t.boroughs.map(b => ({ ...b })) : []
});

const cloneRoad = (r) => ({
  ...r,
  points: r.points.map(p => ({ ...p }))
});

const cloneAirport = (a) => ({
  ...a,
  demandSchedule: a.demandSchedule ? { ...a.demandSchedule } : undefined
});

const cloneDestination = (d) => ({
  ...d,
  demandPins: d.demandPins ? [...d.demandPins] : []
});

/**
 * Creates a stateful reactive memoized 9-stage world-generation DAG pipeline.
 * Each stage is a pure function of its explicit config slice + immutable upstream stage snapshots.
 * Optional `onHydrologyReady(s2bState, recomputed)` callback fires immediately after Stage 2B
 * so a parallel `TerrainBakeWorker` can begin rasterizing contours & rivers while Stages 3–9 run.
 */
export function createWorldPipeline({ onHydrologyReady = null, onUrbanReady = null } = {}) {
  // Single shared scratch workspace for stage execution (eliminates 8×16 TypedArray allocations per world)
  const w = new ProceduralLogisticsWorld({});

  const memoNoise = createMemoStage(
    (seed) => [seed],
    (seed) => new FastNoise2D(new SeededRNG(`${seed}::noise`))
  );

  // Stage 1: Prevailing Wind Vector
  const stage1_wind = createMemoStage(
    (cfg) => [cfg.seed, cfg.windAxis],
    (seed, windAxis) => {
      w.config = { seed, windAxis };
      w.logs = [];
      w.setStageRNG('stage1_wind');
      w.initPrevailingWind();
      return {
        windAngleIndex: w.windAngleIndex,
        windVector: Object.freeze({ ...w.windVector }),
        windLog: w.logs[w.logs.length - 1]
      };
    }
  );

  // Stage 2A: Terrain Heightmap & Sea Basins
  const stage2a_terrain = createMemoStage(
    (cfg, noise) => [cfg.seed, cfg.worldSize || 'standard', cfg.archetype, cfg.terrainAlgo, cfg.waterCoverage, noise],
    (seed, worldSize, archetype, terrainAlgo, waterCoverage, noise) => {
      w.ensureGridSize(worldSize);
      w.config = { seed, worldSize, archetype, terrainAlgo, waterCoverage };
      w.noise = noise;
      w.elevationField.fill(0);
      w.waterMask.fill(0);
      w.hydroFeatures = [];
      w.confluencePoint = null;
      w.setStageRNG('stage2a_terrain');
      const { basins, primarySink } = synthesizeTerrainAndBasins(w);
      return {
        worldSize,
        W: w.W,
        H: w.H,
        tileSize: w.tileSize,
        elevationField: new Float32Array(w.elevationField),
        waterMask: new Uint8Array(w.waterMask),
        seaLevel: w.seaLevel,
        basins: basins.map(b => ({ ...b })),
        primarySink: primarySink ? { ...primarySink } : null,
        hydroFeatures: w.hydroFeatures.map(f => ({ ...f }))
      };
    }
  );

  // Stage 2B: Fluvial Hydrology (Rivers, Springs & Mouths)
  const stage2b_hydrology = createMemoStage(
    (cfg, noise, s2a) => [cfg.seed, cfg.archetype, cfg.terrainAlgo, cfg.hydrologyAlgo, noise, s2a],
    (seed, archetype, terrainAlgo, hydrologyAlgo, noise, s2a, version) => {
      w.config = { seed, archetype, terrainAlgo, hydrologyAlgo };
      w.noise = noise;
      w.elevationField.set(s2a.elevationField);
      w.waterMask.set(s2a.waterMask);
      w.drainageField.fill(0);
      w.seaLevel = s2a.seaLevel;
      w.rivers = [];
      w.confluencePoint = null;
      w.hydroFeatures = s2a.hydroFeatures.map(f => ({ ...f }));
      w.setStageRNG('stage2b_hydro');
      synthesizeFluvialHydrology(
        w,
        s2a.basins.map(b => ({ ...b })),
        s2a.primarySink ? { ...s2a.primarySink } : null
      );
      const tName = terrainAlgo === 'quilez-erosion'
        ? 'Quilez Derivative-Eroded fBm'
        : (terrainAlgo === 'voronoi-plates' ? 'Voronoi Tectonic Plates' : 'Tectonic Strike fBm');
      const hName = hydrologyAlgo === 'd8-strahler'
        ? 'Priority-Flood D8 Strahler'
        : (hydrologyAlgo === 'meandering-plain' ? 'Ikeda Floodplain Meanders' : 'Downhill A* Thalwegs');
      const hydroLog = `Synthesized terrain via <b>${tName}</b> & <b>${w.rivers.length} rivers</b> via <b>${hName}</b>.`;
      return {
        hydroVersion: version,
        W: w.W,
        H: w.H,
        tileSize: w.tileSize,
        elevationField: new Float32Array(w.elevationField),
        waterMask: new Uint8Array(w.waterMask),
        drainageField: new Float32Array(w.drainageField),
        rivers: w.rivers.map(r => ({
          ...r,
          points: r.points.map(p => ({ ...p })),
          headwaterPt: r.headwaterPt ? { ...r.headwaterPt } : null
        })),
        hydroFeatures: w.hydroFeatures.map(f => ({ ...f })),
        confluencePoint: w.confluencePoint ? { ...w.confluencePoint } : null,
        seaLevel: w.seaLevel,
        hydroLog
      };
    }
  );

  // Stage 3: Slope, Distance Transform, Orographic Fertility & Landmasses
  const stage3_spatialFields = createMemoStage(
    (cfg, s1, s2b) => [cfg.archetype, s1, s2b],
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
        landmasses: w.landmasses.map(l => ({ ...l }))
      };
    }
  );

  // Stage 4: Central Place Settlement Seeding
  const stage4_settlements = createMemoStage(
    (cfg, noise, s2b, s3) => [cfg.seed, cfg.archetype, cfg.townCount, noise, s2b, s3],
    (seed, archetype, townCount, noise, s2b, s3) => {
      w.config = { seed, archetype, townCount };
      w.noise = noise;
      w.logs = [];
      w.towns = [];
      w.clusters = [];
      w.elevationField.set(s2b.elevationField);
      w.waterMask.set(s2b.waterMask);
      w.seaLevel = s2b.seaLevel;
      w.confluencePoint = s2b.confluencePoint ? { ...s2b.confluencePoint } : null;
      w.slopeField.set(s3.slopeField);
      w.fertilityField.set(s3.fertilityField);
      w.distToWater.set(s3.distToWater);
      w.urbanSuitability.set(s3.urbanSuitability);
      w.landmassId.set(s3.landmassId);
      w.landmasses = s3.landmasses.map(l => ({ ...l }));
      w.setStageRNG('stage4_settlements');
      w.seedSettlements();
      return {
        towns: w.towns.map(cloneTown),
        clusters: w.clusters.map(cloneTown),
        settlementLog: w.logs[w.logs.length - 1]
      };
    }
  );

  // Stage 5: Multi-Tier Airport Solver & Terminal Loops
  const stage5_airports = createMemoStage(
    (cfg, noise, s1, s2b, s3, s4) => [cfg.seed, cfg.archetype, cfg.airportCount, cfg.airportMix, noise, s1, s2b, s3, s4],
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
      w.landmasses = s3.landmasses.map(l => ({ ...l }));
      w.towns = s4.towns.map(cloneTown);
      w.clusters = s4.clusters.map(cloneTown);
      w.setStageRNG('stage5_airports');
      w.solveAndPlaceAirports();
      return {
        airports: w.airports.map(cloneAirport),
        towns: w.towns.map(cloneTown),
        airportHeatmap: new Float32Array(w.airportHeatmap),
        roadGrid: new Uint8Array(w.roadGrid),
        buildingMask: new Uint8Array(w.buildingMask),
        roads: w.roads.map(cloneRoad),
        airportLog: w.logs[w.logs.length - 1]
      };
    }
  );

  // Stage 6 & 7: Borough Street Grids, Regional Roads, Co-Evolved Secondary Towns, RCI Building Packing & Landscape Trees
  const stage6_7_urban = createMemoStage(
    (cfg, noise, s2b, s3, s4, s5) => [cfg.seed, cfg.archetype, cfg.townCount, cfg.buildingDensity, noise, s2b, s3, s4, s5],
    (seed, archetype, townCount, buildingDensity, noise, s2b, s3, s4, s5, version) => {
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

      w.setStageRNG('stage6a_grids');
      w.carveTownStreetGrids(t => t._seededInPhase1 !== false);
      w.setStageRNG('stage6b_roads');
      w.buildRegionalRoadNetwork();
      const roadLog = w.logs[w.logs.length - 1];
      w.setStageRNG('stage7_rci');
      w.growUrbanFabric();
      w.setStageRNG('stage9_trees');
      w.populateLandscapeTrees();

      return {
        urbanVersion: version,
        towns: w.towns.map(cloneTown),
        roadGrid: new Uint8Array(w.roadGrid),
        buildingMask: new Uint8Array(w.buildingMask),
        zoneColorIdx: new Int8Array(w.zoneColorIdx),
        roads: w.roads.map(cloneRoad),
        houses: w.houses.map(h => ({ ...h })),
        destinations: w.destinations.map(cloneDestination),
        trees: w.trees.map(tr => ({ ...tr })),
        bridgeCount: w.bridgeCount,
        roadLog
      };
    }
  );

  // Stage 8: Expressways & Cloverleaf/Trumpet System Interchanges
  const stage8_motorways = createMemoStage(
    (cfg, noise, s2b, s3, s4, s5, s67) => [cfg.seed, cfg.archetype, noise, s2b, s3, s4, s5, s67],
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
      w.houses = s67.houses.map(h => ({ ...h }));
      w.destinations = s67.destinations.map(cloneDestination);
      w.trees = s67.trees.map(tr => ({ ...tr }));
      w.bridgeCount = s67.bridgeCount;

      w.setStageRNG('stage8_motorways');
      w.buildNumberedMotorways();

      return {
        towns: w.towns.map(cloneTown),
        airports: w.airports.map(cloneAirport),
        roadGrid: new Uint8Array(w.roadGrid),
        buildingMask: new Uint8Array(w.buildingMask),
        roads: w.roads.map(cloneRoad),
        houses: w.houses.map(h => ({ ...h })),
        destinations: w.destinations.map(cloneDestination),
        trees: w.trees.map(tr => ({ ...tr })),
        motorways: w.motorways.map(m => ({
          ...m,
          waypoints: m.waypoints.map(p => ({ ...p })),
          samples: m.samples.map(p => ({ ...p })),
          tunnels: []
        })),
        interchanges: w.interchanges.map(ic => ({ ...ic })),
        displacedBuildingsCount: w.displacedBuildingsCount
      };
    }
  );

  // Stage 9: Intermediate Diamond Ramps, Mountain Tunnels, Outer Street Pruning & Cargo Chain
  const stage9_rampsAndCargo = createMemoStage(
    (cfg, noise, s2b, s3, s4, s67, s8) => [cfg.seed, cfg.archetype, cfg.includeIntermediateRamps, noise, s2b, s3, s4, s67, s8],
    (seed, archetype, includeIntermediateRamps, noise, s2b, s3, s4, s67, s8) => {
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
      w.houses = s8.houses.map(h => ({ ...h }));
      w.destinations = s8.destinations.map(cloneDestination);
      w.trees = s8.trees.map(tr => ({ ...tr }));
      w.motorways = s8.motorways.map(m => ({
        ...m,
        waypoints: m.waypoints.map(p => ({ ...p })),
        samples: m.samples.map(p => ({ ...p })),
        tunnels: []
      }));
      w.interchanges = s8.interchanges.map(ic => ({ ...ic }));
      w.displacedBuildingsCount = s8.displacedBuildingsCount;
      w.bridgeCount = s67.bridgeCount;

      w.setStageRNG('stage9_ramps');
      w.finalizeExpresswayRampsAndTunnels();
      const mwayLog = w.logs[w.logs.length - 1];

      w.setStageRNG('stage8b_cargo');
      w.buildIndustrialCargoChain();
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
        displacedBuildingsCount: w.displacedBuildingsCount,
        bridgeCount: w.bridgeCount,
        mwayLog,
        cargoLog
      };
    }
  );

  return (config, targetWorld = null) => {
    const t0 = performance.now();
    w.ensureGridSize(config.worldSize || 'standard');
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
    const s5 = stage5_airports(config, noise, s1.value, s2b.value, s3.value, s4.value);
    const s67 = stage6_7_urban(config, noise, s2b.value, s3.value, s4.value, s5.value);

    // Notify parallel TerrainBakeWorker immediately once Stage 6/7 urban blush & trees are ready
    // so `composeTerrainBitmap` runs on Core 2 in parallel with Stage 8 Motorways & Stage 9 Cargo on Core 1!
    if (onUrbanReady) {
      onUrbanReady(s2b.value, s67.value, !s2b.cached || !s67.cached);
    }

    const s8 = stage8_motorways(config, noise, s2b.value, s3.value, s4.value, s5.value, s67.value);
    const s9 = stage9_rampsAndCargo(config, noise, s2b.value, s3.value, s4.value, s67.value, s8.value);

    // Derive highest consecutive cached stage number for UI telemetry badge
    const stageHits = [
      [1, s2a.cached],
      [2, s2b.cached],
      [3, s3.cached],
      [4, s4.cached],
      [5, s5.cached],
      [7, s67.cached],
      [8, s8.cached],
      [9, s9.cached]
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
      s9.value.cargoLog
    ].filter(Boolean);
    out.genTimeMs = Math.round(performance.now() - t0);
    return out;
  };
}

export function extractWorldTransferables(world) {
  delete world.rng;
  delete world.noise;
  delete world.roadEdges;
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
  const keys = [
    ['waterMask', Uint8Array],
    ['elevationField', Float32Array],
    ['slopeField', Float32Array],
    ['drainageField', Float32Array],
    ['fertilityField', Float32Array],
    ['distToWater', Float32Array],
    ['urbanSuitability', Float32Array],
    ['airportHeatmap', Float32Array],
    ['roadGrid', Uint8Array],
    ['buildingMask', Uint8Array],
    ['zoneColorIdx', Int8Array],
    ['landmassId', Int16Array]
  ];
  const buffers = [];
  for (const [key, Ctor] of keys) {
    if (world[key]) {
      const cloned = new Ctor(world[key]);
      world[key] = cloned;
      buffers.push(cloned.buffer);
    }
  }
  return buffers;
}

export function hydrateTransferredWorld(world) {
  Object.setPrototypeOf(world, ProceduralLogisticsWorld.prototype);
  return world;
}
