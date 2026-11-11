/**
 * @import { ProceduralLogisticsWorld } from "./world-generator.js"
 * @import {
 *   VehicleRoutingGraph,
 *   RoadTopology
 * } from "./types.js"
 */
import { PALETTE } from "./palette.js";
import { FlatMinHeap } from "./math.js";
import { createMemoStage } from "./state.js";
import {
  ROAD_GRID,
  BUILDING_MASK,
  WORLD_GEOMETRY,
  SIM_CONFIG,
} from "./constants.js";
import {
  computeTrumpetRampBeziers,
  CLOVERLEAF_GEOMETRY,
} from "./entities/interchange/geometry.js";
import {
  MFG_SPECS,
  RAW_NICHE_SPECS,
  CARGO_STAGE_COLORS,
  nameCommercialSubType,
} from "./entities/rci-building/catalog.js";

export { computeTrumpetRampBeziers };

/**
 * Computes road topology from road segments and building mask.
 *
 * @param {number} W
 * @param {number} H
 * @param {any[]} roads
 * @param {Uint8Array} buildingMask
 * @returns {RoadTopology}
 */
export function computeRoadTopology(W, H, roads, buildingMask) {
  const total = W * H;
  const roadGrid = new Uint8Array(total);
  const roadEdges = new Set();
  const vertexDeg = new Uint8Array(total);
  const hasVertex = new Uint8Array(total);
  /** @type {import("./types.js").RoadGraphAnomaly[]} */
  const anomalies = [];
  let bridgeCount = 0;

  for (const r of roads || []) {
    if (!r.points || r.points.length < 2) continue;
    let inBridge = false;
    for (let i = 0; i < r.points.length; i++) {
      const pt = r.points[i];
      const gx = Math.round(pt.x);
      const gy = Math.round(pt.y);
      if (gx < 0 || gx >= W || gy < 0 || gy >= H) continue;
      const id = gy * W + gx;
      hasVertex[id] = 1;

      if (
        buildingMask &&
        (buildingMask[id] === BUILDING_MASK.HOUSE ||
          buildingMask[id] === BUILDING_MASK.DESTINATION)
      ) {
        anomalies.push({ x: gx, y: gy, kind: "road-building-overlap" });
      }

      if (pt.isBridge) {
        if (!inBridge && roadGrid[id] !== ROAD_GRID.BRIDGE) {
          bridgeCount++;
          inBridge = true;
        }
        roadGrid[id] = ROAD_GRID.BRIDGE;
      } else {
        inBridge = false;
        const code =
          r.type === "street" ? ROAD_GRID.STREET : ROAD_GRID.ARTERIAL;
        if (
          roadGrid[id] === ROAD_GRID.NONE ||
          (roadGrid[id] === ROAD_GRID.STREET && code === ROAD_GRID.ARTERIAL)
        ) {
          roadGrid[id] = code;
        }
      }

      if (i < r.points.length - 1) {
        const next = r.points[i + 1];
        const nx = Math.round(next.x);
        const ny = Math.round(next.y);
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const nid = ny * W + nx;
        const eKey = id < nid ? id * total + nid : nid * total + id;
        if (!roadEdges.has(eKey)) {
          roadEdges.add(eKey);
          vertexDeg[id] = Math.min(255, vertexDeg[id] + 1);
          vertexDeg[nid] = Math.min(255, vertexDeg[nid] + 1);
        }

        const dx = nx - gx;
        const dy = ny - gy;
        if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy)) {
          anomalies.push({
            x: (gx + nx) * 0.5,
            y: (gy + ny) * 0.5,
            kind: "non-octilinear-edge",
          });
        }
      }
    }
  }

  let streetTiles = 0;
  let arterialTiles = 0;
  let bridgeTiles = 0;
  let junctionCount = 0;

  for (let id = 0; id < total; id++) {
    const rg = roadGrid[id];
    if (rg === ROAD_GRID.STREET) streetTiles++;
    else if (rg === ROAD_GRID.ARTERIAL) arterialTiles++;
    else if (rg === ROAD_GRID.BRIDGE) bridgeTiles++;

    if (vertexDeg[id] >= 3) junctionCount++;
    if (rg > ROAD_GRID.NONE && hasVertex[id] === 0) {
      anomalies.push({
        x: id % W,
        y: Math.floor(id / W),
        kind: "orphan-roadgrid-tile",
      });
    }
  }

  return {
    roadGrid,
    roadEdges,
    bridgeCount,
    vertexDeg,
    edgeCount: roadEdges.size,
    streetTiles,
    arterialTiles,
    bridgeTiles,
    junctionCount,
    anomalies,
  };
}

const _memoRoadTopology = createMemoStage(
  (W, H, roads, buildingMask) => [W, H, roads, buildingMask],
  computeRoadTopology,
);

/**
 * Derives and memoizes road topology properties.
 *
 * @param {number} W
 * @param {number} H
 * @param {any[]} roads
 * @param {Uint8Array} buildingMask
 * @returns {RoadTopology}
 */
export function deriveRoadTopology(W, H, roads, buildingMask) {
  return _memoRoadTopology(W, H, roads, buildingMask).value;
}

/**
 * @param {ProceduralLogisticsWorld} world
 * @returns {VehicleRoutingGraph}
 */
export function deriveVehicleRoutingGraph(world) {
  world._vehicleGraph = null;
  return ensureVehicleRoutingGraph(world);
}

/**
 * Builds and caches a unified Multi-Modal Vehicle Routing Graph (`world._vehicleGraph`)
 * combining committed surface roads (`world.roads`), elevated expressways (`world.motorways`),
 * terminal roundabouts (`terminal-stub`), intermediate diamond slip-ramps (`diamond-ramp`),
 * and system interchanges (`cloverleaf`, `trumpet`).
 */
export function ensureVehicleRoutingGraph(world) {
  if (world._vehicleGraph) return world._vehicleGraph;
  const { W, H } = world;
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
    onUpperBridge = false,
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
      onUpperBridge,
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
    const isStreet = world.roadGrid[tid] === ROAD_GRID.STREET;
    const nid = addNode(gx, gy, false, false, isStreet, false);
    tileToNode[tid] = nid;
    return nid;
  };

  // 1. Add all committed surface road edges from `world.roads`
  for (const r of world.roads) {
    const pts = r.points;
    if (!pts || pts.length < 2) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const x0 = Math.round(pts[i].x);
      const y0 = Math.round(pts[i].y);
      const x1 = Math.round(pts[i + 1].x);
      const y1 = Math.round(pts[i + 1].y);
      if (!world.inBounds(x0, y0, 1) || !world.inBounds(x1, y1, 1)) continue;
      const u = ensureSurfaceNode(x0, y0);
      const v = ensureSurfaceNode(x1, y1);
      const dist = Math.hypot(x1 - x0, y1 - y0) || 1;
      const mult =
        nodes[u].isStreet || nodes[v].isStreet
          ? SIM_CONFIG.VEHICLE_ROUTING.edgeWeightStreet
          : SIM_CONFIG.VEHICLE_ROUTING.edgeWeightArterial;
      addBiEdge(u, v, dist * mult);
    }
  }

  const numSurfaceNodes = nodes.length;

  // Helper: connect a terminal roundabout portal strictly to the committed surface road
  const connectRoundaboutToSurface = (portalNode, rx, ry, rampCost = 0.75) => {
    const gx0 = Math.round(rx);
    const gy0 = Math.round(ry);
    if (!world.inBounds(gx0, gy0, 1)) return;
    const centerNode = ensureSurfaceNode(gx0, gy0);
    const d0 = Math.hypot(gx0 - rx, gy0 - ry);
    addBiEdge(portalNode, centerNode, d0 * 0.9 + rampCost);

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const gx = gx0 + dx;
        const gy = gy0 + dy;
        if (!world.inBounds(gx, gy, 1)) continue;
        if (world.hasRoadEdge && world.hasRoadEdge(gx0, gy0, gx, gy)) {
          const sNode = ensureSurfaceNode(gx, gy);
          const d = Math.hypot(gx - rx, gy - ry);
          addBiEdge(portalNode, sNode, d * 0.9 + rampCost);
        }
      }
    }
  };

  // 2. Add expressway spline sample nodes as two separate one-way carriageways (`mNodesFwd` for +k, `mNodesRev` for -k)
  const mwNodeLists = new Map();
  for (const mw of world.motorways || []) {
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
        addEdge(
          mNodesFwd[k - 1],
          mNodesFwd[k],
          segDist * SIM_CONFIG.VEHICLE_ROUTING.edgeWeightMotorway,
        );
        addEdge(
          mNodesRev[k],
          mNodesRev[k - 1],
          segDist * SIM_CONFIG.VEHICLE_ROUTING.edgeWeightMotorway,
        );
      }
    }
    mwNodeLists.set(mw.number, { mw, mNodesFwd, mNodesRev });

    // Connect terminal roundabout endpoints (`k = 0` and `k = last`) to surface roads
    if (!mw.prunedStart) {
      const startPortal = addNode(mw.sx, mw.sy, false, false, false, true);
      addEdge(startPortal, mNodesFwd[0], 0.65);
      addEdge(mNodesRev[0], startPortal, 0.65);
      connectRoundaboutToSurface(startPortal, mw.sx, mw.sy);
    }

    if (!mw.prunedEnd) {
      const endPortal = addNode(mw.ex, mw.ey, false, false, false, true);
      addEdge(mNodesFwd[samples.length - 1], endPortal, 0.65);
      addEdge(endPortal, mNodesRev[samples.length - 1], 0.65);
      connectRoundaboutToSurface(endPortal, mw.ex, mw.ey);
    }
  }

  /**
   * @param {import('./types.js').Motorway} targetMw
   * @param {number} targetX
   * @param {number} targetY
   * @param {{ x: number, y: number } | null} [fromPt]
   * @param {{ x: number, y: number } | null} [toPt]
   * @param {number} [dirSign]
   */
  const findSampleNear = (
    targetMw,
    targetX,
    targetY,
    fromPt = null,
    toPt = null,
    dirSign = 0,
  ) => {
    const samples = targetMw.samples;
    let bestK = 0;
    let bestD = Infinity;
    for (let k = 0; k < samples.length; k++) {
      const s = samples[k];
      const d = Math.hypot(s.x - targetX, s.y - targetY);
      if (d < bestD) {
        bestD = d;
        bestK = k;
      }
    }
    if (dirSign !== 0 && samples.length >= 2) {
      const kNext = Math.max(0, Math.min(samples.length - 1, bestK + dirSign));
      const kPrev = Math.max(0, Math.min(samples.length - 1, bestK - dirSign));
      const tx = samples[kNext].x - samples[kPrev].x || dirSign;
      const ty = samples[kNext].y - samples[kPrev].y || 0;
      const tLen = Math.hypot(tx, ty) || 1;
      const ux = tx / tLen;
      const uy = ty / tLen;
      if (fromPt) {
        while (
          (samples[bestK].x - fromPt.x) * ux +
            (samples[bestK].y - fromPt.y) * uy <
            0.35 &&
          bestK + dirSign >= 0 &&
          bestK + dirSign < samples.length
        ) {
          bestK += dirSign;
        }
      } else if (toPt) {
        while (
          (toPt.x - samples[bestK].x) * ux + (toPt.y - samples[bestK].y) * uy <
            0.35 &&
          bestK - dirSign >= 0 &&
          bestK - dirSign < samples.length
        ) {
          bestK -= dirSign;
        }
      }
    }
    return bestK;
  };

  // 3. Connect intermediate diamond slip-ramps (`diamond-ramp`) and system interchanges (`cloverleaf`, `trumpet`)
  for (const ic of world.interchanges || []) {
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
            Math.hypot(nodes[vN].x - nodes[uN].x, nodes[vN].y - nodes[uN].y) ||
            0.4;
          addEdge(uN, vN, segD * 0.55 + 0.1);
        }
      }
    } else if (ic.type === "cloverleaf") {
      const entryA = mwNodeLists.get(ic.mwayA);
      const entryB = mwNodeLists.get(ic.mwayB);
      if (!entryA || !entryB) continue;

      const upperEntry = ic.prunedBridgeB ? entryA : entryB;
      if (upperEntry?.mw?.samples) {
        for (let k = 0; k < upperEntry.mw.samples.length; k++) {
          const s = upperEntry.mw.samples[k];
          if (Math.hypot(s.x - ic.x, s.y - ic.y) <= 1.85) {
            if (nodes[upperEntry.mNodesFwd[k]]) {
              nodes[upperEntry.mNodesFwd[k]].onUpperBridge = true;
            }
            if (nodes[upperEntry.mNodesRev[k]]) {
              nodes[upperEntry.mNodesRev[k]].onUpperBridge = true;
            }
          }
        }
      }

      const uAx = Math.cos(ic.angleA);
      const uAy = Math.sin(ic.angleA);
      const uBx = Math.cos(ic.angleB);
      const uBy = Math.sin(ic.angleB);

      const signsA = ic.activeSignsA || [-1, 1];
      const signsB = ic.activeSignsB || [-1, 1];

      const outerDist = CLOVERLEAF_GEOMETRY.outerDist;
      const outerCtrl = CLOVERLEAF_GEOMETRY.outerCtrl;
      const leafSpan = CLOVERLEAF_GEOMETRY.leafSpan;

      for (const sA of signsA) {
        for (const sB of signsB) {
          const rAx = sA * uAx;
          const rAy = sA * uAy;
          const rBx = sB * uBx;
          const rBy = sB * uBy;
          const crossAB = rAx * rBy - rAy * rBx;

          // Outer Concave Right-Turn Slip-Ramp
          const pAx = ic.x + rAx * outerDist;
          const pAy = ic.y + rAy * outerDist;
          const pBx = ic.x + rBx * outerDist;
          const pBy = ic.y + rBy * outerDist;
          const pCx = ic.x + (rAx + rBx) * outerCtrl;
          const pCy = ic.y + (rAy + rBy) * outerCtrl;

          if (crossAB < 0) {
            const rNodesOuter = [];
            for (const t of [0.0, 0.25, 0.5, 0.75, 1.0]) {
              const mt = 1 - t;
              const rx = mt * mt * pAx + 2 * mt * t * pCx + t * t * pBx;
              const ry = mt * mt * pAy + 2 * mt * t * pCy + t * t * pBy;
              rNodesOuter.push(
                addNode(rx, ry, true, false, false, false, true),
              );
            }
            const firstPt = nodes[rNodesOuter[0]];
            const lastPt = nodes[rNodesOuter[rNodesOuter.length - 1]];
            const kA_outer = findSampleNear(
              entryA.mw,
              pAx,
              pAy,
              null,
              firstPt,
              sA === -1 ? 1 : -1,
            );
            const kB_outer = findSampleNear(
              entryB.mw,
              pBx,
              pBy,
              lastPt,
              null,
              sB === 1 ? 1 : -1,
            );
            const startNodeA =
              sA === -1
                ? entryA.mNodesFwd[kA_outer]
                : entryA.mNodesRev[kA_outer];
            const endNodeB =
              sB === 1
                ? entryB.mNodesFwd[kB_outer]
                : entryB.mNodesRev[kB_outer];
            const chain = [startNodeA, ...rNodesOuter, endNodeB];
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
          } else if (crossAB > 0) {
            const rNodesOuter = [];
            for (const t of [0.0, 0.25, 0.5, 0.75, 1.0]) {
              const mt = 1 - t;
              const rx = mt * mt * pBx + 2 * mt * t * pCx + t * t * pAx;
              const ry = mt * mt * pBy + 2 * mt * t * pCy + t * t * pAy;
              rNodesOuter.push(
                addNode(rx, ry, true, false, false, false, true),
              );
            }
            const firstPt = nodes[rNodesOuter[0]];
            const lastPt = nodes[rNodesOuter[rNodesOuter.length - 1]];
            const kB_outer = findSampleNear(
              entryB.mw,
              pBx,
              pBy,
              null,
              firstPt,
              sB === -1 ? 1 : -1,
            );
            const kA_outer = findSampleNear(
              entryA.mw,
              pAx,
              pAy,
              lastPt,
              null,
              sA === 1 ? 1 : -1,
            );
            const startNodeB =
              sB === -1
                ? entryB.mNodesFwd[kB_outer]
                : entryB.mNodesRev[kB_outer];
            const endNodeA =
              sA === 1
                ? entryA.mNodesFwd[kA_outer]
                : entryA.mNodesRev[kA_outer];
            const chain = [startNodeB, ...rNodesOuter, endNodeA];
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

          // Inner 270° Cloverleaf Loop Ramp
          const upperIsA = Boolean(ic.prunedBridgeB);
          if (crossAB > 0) {
            const p1x = ic.x + rAx * leafSpan;
            const p1y = ic.y + rAy * leafSpan;
            const p2x = ic.x + rBx * leafSpan;
            const p2y = ic.y + rBy * leafSpan;
            const rNodesInner = [];
            for (const t of [0.0, 0.16, 0.33, 0.5, 0.67, 0.84, 1.0]) {
              const mt = 1 - t;
              const rx =
                mt * mt * mt * ic.x +
                3 * mt * mt * t * p1x +
                3 * mt * t * t * p2x +
                t * t * t * ic.x;
              const ry =
                mt * mt * mt * ic.y +
                3 * mt * mt * t * p1y +
                3 * mt * t * t * p2y +
                t * t * t * ic.y;
              const onUpper =
                (t === 0.0 && upperIsA) || (t === 1.0 && !upperIsA);
              rNodesInner.push(
                addNode(rx, ry, true, false, false, false, true, onUpper),
              );
            }
            const firstPt = nodes[rNodesInner[0]];
            const lastPt = nodes[rNodesInner[rNodesInner.length - 1]];
            const kCrossA = findSampleNear(
              entryA.mw,
              ic.x,
              ic.y,
              null,
              firstPt,
              sA === 1 ? 1 : -1,
            );
            const kCrossB = findSampleNear(
              entryB.mw,
              ic.x,
              ic.y,
              lastPt,
              null,
              sB === -1 ? 1 : -1,
            );
            const startNodeA =
              sA === 1 ? entryA.mNodesFwd[kCrossA] : entryA.mNodesRev[kCrossA];
            const endNodeB =
              sB === -1 ? entryB.mNodesFwd[kCrossB] : entryB.mNodesRev[kCrossB];
            const chain = [startNodeA, ...rNodesInner, endNodeB];
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
          } else if (crossAB < 0) {
            const p1x = ic.x + rBx * leafSpan;
            const p1y = ic.y + rBy * leafSpan;
            const p2x = ic.x + rAx * leafSpan;
            const p2y = ic.y + rAy * leafSpan;
            const rNodesInner = [];
            for (const t of [0.0, 0.16, 0.33, 0.5, 0.67, 0.84, 1.0]) {
              const mt = 1 - t;
              const rx =
                mt * mt * mt * ic.x +
                3 * mt * mt * t * p1x +
                3 * mt * t * t * p2x +
                t * t * t * ic.x;
              const ry =
                mt * mt * mt * ic.y +
                3 * mt * mt * t * p1y +
                3 * mt * t * t * p2y +
                t * t * t * ic.y;
              const onUpper =
                (t === 0.0 && !upperIsA) || (t === 1.0 && upperIsA);
              rNodesInner.push(
                addNode(rx, ry, true, false, false, false, true, onUpper),
              );
            }
            const firstPt = nodes[rNodesInner[0]];
            const lastPt = nodes[rNodesInner[rNodesInner.length - 1]];
            const kCrossB = findSampleNear(
              entryB.mw,
              ic.x,
              ic.y,
              null,
              firstPt,
              sB === 1 ? 1 : -1,
            );
            const kCrossA = findSampleNear(
              entryA.mw,
              ic.x,
              ic.y,
              lastPt,
              null,
              sA === -1 ? 1 : -1,
            );
            const startNodeB =
              sB === 1 ? entryB.mNodesFwd[kCrossB] : entryB.mNodesRev[kCrossB];
            const endNodeA =
              sA === -1 ? entryA.mNodesFwd[kCrossA] : entryA.mNodesRev[kCrossA];
            const chain = [startNodeB, ...rNodesInner, endNodeA];
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
        }
      }
    } else if (ic.type === "trumpet") {
      const mainEntry = mwNodeLists.get(ic.mwayMain);
      const spurEntry = mwNodeLists.get(ic.mwaySpur);
      if (!mainEntry || !spurEntry) continue;

      if (spurEntry?.mw?.samples) {
        for (let k = 0; k < spurEntry.mw.samples.length; k++) {
          const s = spurEntry.mw.samples[k];
          if (Math.hypot(s.x - ic.x, s.y - ic.y) <= 1.4) {
            if (nodes[spurEntry.mNodesFwd[k]]) {
              nodes[spurEntry.mNodesFwd[k]].onUpperBridge = true;
            }
            if (nodes[spurEntry.mNodesRev[k]]) {
              nodes[spurEntry.mNodesRev[k]].onUpperBridge = true;
            }
          }
        }
      }

      const sy = ic.sideSign || 1;
      const ramps = computeTrumpetRampBeziers(ic, world.motorways);

      const spurSamples = spurEntry.mw.samples;
      const spurEndAtIc =
        Math.hypot(
          spurSamples[spurSamples.length - 1].x - ic.x,
          spurSamples[spurSamples.length - 1].y - ic.y,
        ) < Math.hypot(spurSamples[0].x - ic.x, spurSamples[0].y - ic.y);

      const spurInboundNode = spurEndAtIc
        ? spurEntry.mNodesFwd
        : spurEntry.mNodesRev;
      const spurOutboundNode = spurEndAtIc
        ? spurEntry.mNodesRev
        : spurEntry.mNodesFwd;

      // Mainline carriageways in canonical +u and -u directions (where lx = sy * u)
      const mainPosUNode = sy === 1 ? mainEntry.mNodesFwd : mainEntry.mNodesRev;
      const mainNegUNode = sy === 1 ? mainEntry.mNodesRev : mainEntry.mNodesFwd;

      const evalSeg = (seg, t) => {
        const mt = 1 - t;
        return {
          x:
            mt * mt * mt * seg.p0.x +
            3 * mt * mt * t * seg.p1.x +
            3 * mt * t * t * seg.p2.x +
            t * t * t * seg.p3.x,
          y:
            mt * mt * mt * seg.p0.y +
            3 * mt * mt * t * seg.p1.y +
            3 * mt * t * t * seg.p2.y +
            t * t * t * seg.p3.y,
        };
      };

      const connectChain = (chain) => {
        for (let c = 0; c < chain.length - 1; c++) {
          const uN = chain[c];
          const vN = chain[c + 1];
          const segD =
            Math.hypot(nodes[vN].x - nodes[uN].x, nodes[vN].y - nodes[uN].y) ||
            0.4;
          addEdge(uN, vN, segD * 0.55 + 0.1);
        }
      };

      // 1. Yellow Ramp (Left Outer Slip-Ramp): Mainline (+u) -> Spur Outbound (+v)
      {
        const rNodes = [];
        for (const t of [0.0, 0.25, 0.5, 0.75, 1.0]) {
          const wp = evalSeg(ramps.yellow, t);
          rNodes.push(
            addNode(wp.x, wp.y, true, false, false, false, true, false),
          );
        }
        const kMain = findSampleNear(
          mainEntry.mw,
          ramps.yellow.p0.x,
          ramps.yellow.p0.y,
          null,
          nodes[rNodes[0]],
          sy,
        );
        const kSpur = findSampleNear(
          spurEntry.mw,
          ramps.yellow.p3.x,
          ramps.yellow.p3.y,
          nodes[rNodes[rNodes.length - 1]],
          null,
          spurEndAtIc ? -1 : 1,
        );
        connectChain([mainPosUNode[kMain], ...rNodes, spurOutboundNode[kSpur]]);
      }

      // 2. Purple Ramp (Right Outer Slip-Ramp): Spur Inbound (-v) -> Mainline (+u)
      {
        const rNodes = [];
        for (const t of [0.0, 0.25, 0.5, 0.75, 1.0]) {
          const wp = evalSeg(ramps.purple, t);
          rNodes.push(
            addNode(wp.x, wp.y, true, false, false, false, true, false),
          );
        }
        const kSpur = findSampleNear(
          spurEntry.mw,
          ramps.purple.p0.x,
          ramps.purple.p0.y,
          null,
          nodes[rNodes[0]],
          spurEndAtIc ? 1 : -1,
        );
        const kMain = findSampleNear(
          mainEntry.mw,
          ramps.purple.p3.x,
          ramps.purple.p3.y,
          nodes[rNodes[rNodes.length - 1]],
          null,
          sy,
        );
        connectChain([spurInboundNode[kSpur], ...rNodes, mainPosUNode[kMain]]);
      }

      // 3. Brown Ramp (Inner 270° Trumpet Loop): Mainline (-u) -> 270° Loop -> Bridge -> Spur Outbound (+v)
      {
        const bSegs = ramps.brown;
        const rNodes = [];
        for (let sIdx = 0; sIdx < bSegs.length; sIdx++) {
          const seg = bSegs[sIdx];
          const ts = sIdx === 0 ? [0.0, 0.33, 0.67, 1.0] : [0.33, 0.67, 1.0];
          for (const t of ts) {
            const wp = evalSeg(seg, t);
            const onUpper =
              (sIdx === bSegs.length - 1 && t >= 0.3) ||
              Math.hypot(wp.x - ic.x, wp.y - ic.y) <= 0.95;
            rNodes.push(
              addNode(wp.x, wp.y, true, false, false, false, true, onUpper),
            );
          }
        }
        const kMain = findSampleNear(
          mainEntry.mw,
          bSegs[0].p0.x,
          bSegs[0].p0.y,
          null,
          nodes[rNodes[0]],
          -sy,
        );
        const lastBSeg = bSegs[bSegs.length - 1];
        const kSpur = findSampleNear(
          spurEntry.mw,
          lastBSeg.p3.x,
          lastBSeg.p3.y,
          nodes[rNodes[rNodes.length - 1]],
          null,
          spurEndAtIc ? -1 : 1,
        );
        connectChain([mainNegUNode[kMain], ...rNodes, spurOutboundNode[kSpur]]);
      }

      // 4. Blue Ramp (Outer Trumpet Bell): Spur Inbound (-v) -> Bridge -> Parallel Outer Bell -> Diverge into Mainline (-u)
      {
        const blSegs = ramps.blue;
        const rNodes = [];
        for (let sIdx = 0; sIdx < blSegs.length; sIdx++) {
          const seg = blSegs[sIdx];
          const ts = sIdx === 0 ? [0.0, 0.33, 0.67, 1.0] : [0.33, 0.67, 1.0];
          for (const t of ts) {
            const wp = evalSeg(seg, t);
            const onUpper =
              (sIdx === 0 && t <= 0.7) ||
              Math.hypot(wp.x - ic.x, wp.y - ic.y) <= 0.95;
            rNodes.push(
              addNode(wp.x, wp.y, true, false, false, false, true, onUpper),
            );
          }
        }
        const kSpur = findSampleNear(
          spurEntry.mw,
          blSegs[0].p0.x,
          blSegs[0].p0.y,
          null,
          nodes[rNodes[0]],
          spurEndAtIc ? 1 : -1,
        );
        const lastBlSeg = blSegs[blSegs.length - 1];
        const kMain = findSampleNear(
          mainEntry.mw,
          lastBlSeg.p3.x,
          lastBlSeg.p3.y,
          nodes[rNodes[rNodes.length - 1]],
          null,
          -sy,
        );
        connectChain([spurInboundNode[kSpur], ...rNodes, mainNegUNode[kMain]]);
      }
    }
  }

  // 4. Collect roundabout geometry for right-hand circulatory arc generation
  const roundabouts = [];
  for (const ap of world.airports || []) {
    roundabouts.push({
      x: ap.gateX,
      y: ap.gateY,
      rTiles: WORLD_GEOMETRY.ROUNDABOUT_RADII.airportGate,
      rIsland: 0.36,
      accentColor: ap.palette ? ap.palette.roof : "#e85c90",
      isAirport: true,
      isDiamondT: false,
    });
  }
  for (const ic of world.interchanges || []) {
    if (ic.type === "terminal-stub" && !ic.isAirportStub) {
      const town =
        ic.townId !== undefined && world.towns ? world.towns[ic.townId] : null;
      roundabouts.push({
        x: ic.x,
        y: ic.y,
        rTiles: WORLD_GEOMETRY.ROUNDABOUT_RADII.townStub,
        rIsland: 0.33,
        accentColor: town && town.palette ? town.palette.roof : "#8fa989",
        isAirport: false,
        isDiamondT: false,
      });
    } else if (
      ic.type === "diamond-ramp" &&
      !ic.isThroughDiamond &&
      ic.oppTermX !== undefined &&
      ic.oppTermY !== undefined
    ) {
      roundabouts.push({
        x: ic.oppTermX,
        y: ic.oppTermY,
        rTiles: WORLD_GEOMETRY.ROUNDABOUT_RADII.diamondTurnaround,
        rIsland: 0.3,
        accentColor: "#8fa989",
        isAirport: false,
        isDiamondT: true,
      });
    }
  }

  const driveways = [];
  for (const h of world.houses || []) {
    driveways.push({ x0: h.x, y0: h.y, x1: h.roadX, y1: h.roadY });
  }
  for (const d of world.destinations || []) {
    driveways.push({
      x0: d.lotX ?? d.x,
      y0: d.lotY ?? d.y,
      x1: d.roadX,
      y1: d.roadY,
    });
  }

  /** @type {import('./types.js').RampGraphEdge[]} */
  const rampEdges = [];
  /** @type {import('./types.js').RampGraphNode[]} */
  const rampNodes = [];
  for (let u = 0; u < nodes.length; u++) {
    const nu = nodes[u];
    if (nu.isSlipRamp || nu.isRoundabout) {
      rampNodes.push({
        x: nu.x,
        y: nu.y,
        isPortal: Boolean(nu.isRoundabout && !nu.isSlipRamp),
      });
    }
    const edges = adj[u];
    if (!edges) continue;
    for (let eIdx = 0; eIdx < edges.length; eIdx++) {
      const v = edges[eIdx].to;
      const nv = nodes[v];
      if (
        nu.isSlipRamp ||
        nv.isSlipRamp ||
        nu.isRoundabout ||
        nv.isRoundabout
      ) {
        rampEdges.push({
          x0: nu.x,
          y0: nu.y,
          x1: nv.x,
          y1: nv.y,
          isPortal: Boolean(
            (nu.isRoundabout || nv.isRoundabout) &&
            !nu.isSlipRamp &&
            !nv.isSlipRamp,
          ),
        });
      }
    }
  }

  const totalNodes = nodes.length;
  world._vehicleGraph = {
    nodes,
    adj,
    tileToNode,
    numSurfaceNodes,
    roundabouts,
    driveways,
    rampEdges,
    rampNodes,
    gScore: new Float64Array(totalNodes),
    parent: new Int32Array(totalNodes),
    seenGen: new Int32Array(totalNodes),
    closedGen: new Int32Array(totalNodes),
    gen: 0,
  };
  return world._vehicleGraph;
}

/**
 * Dedicated On-Network Multi-Modal Vehicle A* (`findVehicleNetworkPath`):
 * Routes strictly over committed surface road edges and grade-separated expressways
 * with realistic travel-time weights (`0.38x` expressway, `1.0x` arterial, `1.35x` local street)
 * and light intersection turn costs (`+0.30` for 45°, `+0.55` for 90°).
 */
export function findVehicleNetworkPath(world, sx, sy, ex, ey) {
  const graph = world.ensureVehicleRoutingGraph();
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
  const { W } = world;

  const findNearestSurfaceNode = (px, py) => {
    const gx0 = Math.round(px);
    const gy0 = Math.round(py);
    if (world.inBounds(gx0, gy0, 1)) {
      const direct = tileToNode[gy0 * W + gx0];
      if (direct !== -1) return direct;
    }
    let best = -1;
    let bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = gx0 + dx;
        const gy = gy0 + dy;
        if (!world.inBounds(gx, gy, 1)) continue;
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
  if (startNode === -1 || endNode === -1 || startNode === endNode) return null;

  const gen = ++graph.gen;
  const endX = nodes[endNode].x;
  const endY = nodes[endNode].y;

  const openHeap = new FlatMinHeap(256);
  openHeap.push(startNode, 0);

  seenGen[startNode] = gen;
  gScore[startNode] = 0;
  parent[startNode] = -1;

  while (openHeap.size > 0) {
    const u = openHeap.pop();
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
          onUpperBridge: Boolean(n.onUpperBridge),
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

      if (pu !== -1) {
        const dx = nv.x - nu.x;
        const dy = nv.y - nu.y;
        const lPrev = Math.hypot(prevDx, prevDy);
        const lCurr = Math.hypot(dx, dy);
        if (
          lPrev > 1e-3 &&
          lCurr > 1e-3 &&
          !nu.isRoundabout &&
          !nv.isRoundabout
        ) {
          const cosTurn = (dx * prevDx + dy * prevDy) / (lPrev * lCurr);
          if (
            !nu.onMotorway ||
            !nv.onMotorway ||
            nu.isSlipRamp ||
            nv.isSlipRamp
          ) {
            if (cosTurn < -0.75) continue;
            if (cosTurn < -0.2) stepCost += 18.0;
            else if (cosTurn < 0.2) stepCost += 0.55;
            else if (cosTurn < 0.95) stepCost += 0.3;
          }
        }
      }

      const tentativeG = gScore[u] + stepCost;
      if (seenGen[v] !== gen || tentativeG < gScore[v]) {
        seenGen[v] = gen;
        gScore[v] = tentativeG;
        parent[v] = u;
        const h = Math.hypot(endX - nv.x, endY - nv.y) * 0.36;
        openHeap.push(v, tentativeG + h);
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
export function buildDirectedLaneTrajectory(world, srcPt, dstPt, rawPath) {
  if (!rawPath || rawPath.length < 2) return null;
  const graph = world.ensureVehicleRoutingGraph();
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

  if (srcPt && !srcPt.isGatewayProxy) {
    const sx = srcPt.lotX ?? srcPt.x;
    const sy = srcPt.lotY ?? srcPt.y;
    if (Math.hypot(sx - rawPath[0].x, sy - rawPath[0].y) > 0.2) {
      pushSpinePt({
        x: rawPath[0].x + (sx - rawPath[0].x) * 0.52,
        y: rawPath[0].y + (sy - rawPath[0].y) * 0.52,
        onMotorway: false,
        inTunnel: false,
        isStreet: true,
        isDriveway: true,
        onUpperBridge: false,
      });
    }
  }

  for (let i = 0; i < rawPath.length; i++) {
    const pt = rawPath[i];
    /** @type {import('./types.js').RoundaboutSpec | null} */
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
      let rawSweep =
        (((thetaIn - thetaOut) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      if (rawSweep < 0.65) {
        rawSweep = Math.PI * 2 - 0.36;
      }
      const pad = Math.min(0.18, rawSweep * 0.28);
      const thetaStart = thetaIn - pad;
      const sweep = Math.max(0.12, rawSweep - 2 * pad);
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
          onUpperBridge: false,
        });
      }
      i = j;
    } else {
      pushSpinePt({ ...pt });
    }
  }

  const lastRaw = rawPath[rawPath.length - 1];
  if (dstPt && !dstPt.isGatewayProxy) {
    const dx = dstPt.lotX ?? dstPt.x;
    const dy = dstPt.lotY ?? dstPt.y;
    if (Math.hypot(dx - lastRaw.x, dy - lastRaw.y) > 0.2) {
      pushSpinePt({
        x: lastRaw.x + (dx - lastRaw.x) * 0.52,
        y: lastRaw.y + (dy - lastRaw.y) * 0.52,
        onMotorway: false,
        inTunnel: false,
        isStreet: true,
        isDriveway: true,
        onUpperBridge: false,
      });
    }
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

    /** @type {number} */
    let laneOff = SIM_CONFIG.VEHICLE_ROUTING.laneOffsetRoad;
    if (p.isRoundaboutArc) laneOff = 0.0;
    else if (p.isSlipRamp) {
      const prevMotorwayMainline =
        i > 0 && spine[i - 1].onMotorway && !spine[i - 1].isSlipRamp;
      const nextMotorwayMainline =
        i + 1 < spine.length &&
        spine[i + 1].onMotorway &&
        !spine[i + 1].isSlipRamp;
      laneOff =
        prevMotorwayMainline || nextMotorwayMainline
          ? SIM_CONFIG.VEHICLE_ROUTING.laneOffsetMotorway
          : SIM_CONFIG.VEHICLE_ROUTING.laneOffsetSlipRamp;
    } else if (p.isDriveway)
      laneOff = SIM_CONFIG.VEHICLE_ROUTING.laneOffsetDriveway;
    else if (p.onMotorway)
      laneOff = SIM_CONFIG.VEHICLE_ROUTING.laneOffsetMotorway;

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
    if (
      pCurr.isRoundaboutArc ||
      (pCurr.onMotorway &&
        !pCurr.isSlipRamp &&
        !pPrev.isSlipRamp &&
        !pNext.isSlipRamp)
    ) {
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
      const isRampTransition =
        pCurr.isSlipRamp || pPrev.isSlipRamp || pNext.isSlipRamp;
      const maxR = isRampTransition ? 0.35 : 0.24;
      const r = Math.min(maxR, l0 * 0.42, l1 * 0.42);
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
          onUpperBridge: pCurr.onUpperBridge,
        });
      }
    } else {
      pts.push(pCurr);
    }
  }
  pts.push(shifted[shifted.length - 1]);

  // Remove any inner-corner offset micro-backtracks (`cosTurn < -0.45`)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = pts.length - 2; i >= 1; i--) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const dx0 = p1.x - p0.x;
      const dy0 = p1.y - p0.y;
      const dx1 = p2.x - p1.x;
      const dy1 = p2.y - p1.y;
      const l0 = Math.hypot(dx0, dy0);
      const l1 = Math.hypot(dx1, dy1);
      if (
        l0 < 0.02 ||
        (l0 > 0.02 && l1 > 0.02 && (dx0 * dx1 + dy0 * dy1) / (l0 * l1) < -0.45)
      ) {
        pts.splice(i, 1);
      }
    }
  }

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
 * Builds Origin-to-Destination Commuter Routes (`world.commuterRoutes`) between
 * residential houses (`world.houses`) and Commercial/Industrial/Airport sinks
 * across both local streets and regional expressways.
 */
export function buildCommuterRoutes(world) {
  world.commuterRoutes = [];
  if (
    !world.houses ||
    world.houses.length === 0 ||
    !world.destinations ||
    world.destinations.length === 0
  ) {
    return;
  }

  const targetRoutes = Math.min(
    130,
    Math.max(60, Math.round(world.houses.length * 0.35)),
  );
  const step = Math.max(1, Math.floor(world.houses.length / targetRoutes));

  for (
    let i = 0;
    i < world.houses.length && world.commuterRoutes.length < targetRoutes;
    i += step
  ) {
    const h = world.houses[i];
    const hx = Math.round(h.roadX ?? h.x);
    const hy = Math.round(h.roadY ?? h.y);
    const wantRegional =
      world.commuterRoutes.length % 3 === 0 && world.motorways.length > 0;

    // Pick best matching destination (same color or regional expressway partner)
    /** @type {import('./types.js').Destination | null} */
    let bestDst = null;
    let bestScore = Infinity;
    for (let j = 0; j < world.destinations.length; j++) {
      const d =
        world.destinations[(i * 7 + j * 13) % world.destinations.length];
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
    const rawPath = world.findVehicleNetworkPath(hx, hy, dx, dy);
    if (!rawPath || rawPath.length < 2) continue;
    const revPath =
      world.findVehicleNetworkPath(dx, dy, hx, hy) || [...rawPath].reverse();

    const outboundTrack = world.buildDirectedLaneTrajectory(
      h,
      bestDst,
      rawPath,
    );
    const inboundTrack = world.buildDirectedLaneTrajectory(bestDst, h, revPath);
    if (!outboundTrack || !inboundTrack) continue;

    world.commuterRoutes.push({
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
 * STAGE 8B: DEMAND-DRIVEN PULL SUPPLY-CHAIN SOLVER
 *
 * Implements the 5-phase Demand-Driven Pull Supply-Chain architecture:
 * - Step 0: Post-Clearance Role Normalization (RAW, MFG, COM, LOG & Trade Gateway proxies)
 * - Step 1: Commercial (COM) Distinct Goods Pull & LOG Relative-Demand Aggregation
 * - Step 2: Direct Inter-CBD & Downtown Shipping (CBD->CBD)
 * - Step 3: Tier 3 LOG Hub Pull Proportional to relativeDemand (MFG->LOG, IMPORT->LOG)
 * - Step 4: Tier 2B (MFG->MFG) & Tier 2A (RAW->MFG / IMPORT->MFG) 2-Input Load-Balanced Pull
 * - Step 5: TradeGateway Export Pull & 100% Connectivity Sweep
 */
export function buildIndustrialCargoChain(world) {
  world._vehicleGraph = null;
  world.cargoLinks = [];

  const rawNodes = world.destinations.filter(
    (d) => d.zoneType === "industrial" && d.subType === "RAW",
  );
  const mfgNodes = world.destinations.filter(
    (d) => d.zoneType === "industrial" && d.subType === "MFG",
  );
  const logNodes = world.destinations.filter(
    (d) => d.zoneType === "industrial" && d.subType === "LOG",
  );
  const comNodes = world.destinations.filter(
    (d) => d.zoneType === "commercial",
  );

  /** @type {Map<number, number>} */
  const outboundCount = new Map();
  /** @type {Map<number, number>} */
  const inboundCount = new Map();
  const getOutbound = (id) => outboundCount.get(id) || 0;
  const getInbound = (id) => inboundCount.get(id) || 0;

  const getLandmassId = (d) =>
    d.landmassId ?? world.towns[d.townId]?.landmassId ?? -1;

  /**
   * @param {import('./types.js').Destination} src
   * @param {import('./types.js').Destination} dst
   * @param {string} stage
   * @param {string} label
   * @param {string} color
   * @param {number} [maxCrowDist=115]
   * @param {string | null} [commodity]
   * @param {number} [demandWeight=1]
   * @returns {boolean}
   */
  const connectLink = (
    src,
    dst,
    stage,
    label,
    color,
    maxCrowDist = 115,
    commodity = null,
    demandWeight = 1,
  ) => {
    if (src.id === dst.id) return false;
    if (
      world.cargoLinks.some(
        (l) =>
          l.from.id === src.id &&
          l.to.id === dst.id &&
          l.stage === stage &&
          l.commodity === commodity,
      )
    ) {
      return false;
    }
    const crowD = Math.hypot(dst.x - src.x, dst.y - src.y);
    if (crowD < 2.5 || crowD > maxCrowDist) return false;
    const sx = Math.round(src.roadX ?? src.x);
    const sy = Math.round(src.roadY ?? src.y);
    const ex = Math.round(dst.roadX ?? dst.x);
    const ey = Math.round(dst.roadY ?? dst.y);

    const roadPath = world.findVehicleNetworkPath(sx, sy, ex, ey);
    if (!roadPath || roadPath.length < 2) return false;
    let pathArcLen = 0;
    for (let i = 1; i < roadPath.length; i++) {
      pathArcLen += Math.hypot(
        roadPath[i].x - roadPath[i - 1].x,
        roadPath[i].y - roadPath[i - 1].y,
      );
    }
    if (pathArcLen > crowD * 3.6 + 45) return false;

    const outboundTrack = world.buildDirectedLaneTrajectory(src, dst, roadPath);
    const revRoadPath =
      world.findVehicleNetworkPath(ex, ey, sx, sy) || [...roadPath].reverse();
    const inboundTrack = world.buildDirectedLaneTrajectory(
      dst,
      src,
      revRoadPath,
    );
    if (!outboundTrack || !inboundTrack) return false;

    world.cargoLinks.push({
      from: src,
      to: dst,
      stage,
      label,
      color,
      commodity,
      demandWeight,
      modality: "highway",
      points: roadPath,
      usesMotorway: roadPath.some((p) => p.onMotorway),
      outboundTrack,
      inboundTrack,
    });
    outboundCount.set(src.id, getOutbound(src.id) + 1);
    inboundCount.set(dst.id, getInbound(dst.id) + 1);
    return true;
  };

  // ---------------------------------------------------------------------------
  // Step 0 — Post-Clearance Role Normalization
  // ---------------------------------------------------------------------------

  // 0A. Normalize RAW destinations
  for (const r of rawNodes) {
    if (!r.resourceType || !RAW_NICHE_SPECS[r.resourceType]) {
      r.resourceType = "CHEM";
    }
    r.outputGood = RAW_NICHE_SPECS[r.resourceType].outputGood;
  }

  // 0B. Normalize MFG destinations
  const ALL_MFG_TYPES = ["STEEL", "FOOD", "GOODS", "TECH"];

  for (let i = 0; i < mfgNodes.length; i++) {
    const m = mfgNodes[i];
    const isCompact = (m.wTiles || 2) < 2 || (m.hTiles || 2) < 2;
    if (!m.mfgType || !MFG_SPECS[m.mfgType]) {
      m.mfgType = isCompact
        ? (m.townId + i) % 2 === 0
          ? "FOOD"
          : "GOODS"
        : ALL_MFG_TYPES[(m.townId + i) % 4];
    } else if (isCompact && (m.mfgType === "STEEL" || m.mfgType === "TECH")) {
      m.mfgType = (m.townId + i) % 2 === 0 ? "FOOD" : "GOODS";
    }
  }

  if (mfgNodes.length >= 4) {
    const missingTypes = ALL_MFG_TYPES.filter(
      (t) => !mfgNodes.some((m) => m.mfgType === t),
    );
    for (const missing of missingTypes) {
      const typeCounts = new Map();
      for (const m of mfgNodes) {
        typeCounts.set(m.mfgType, (typeCounts.get(m.mfgType) || 0) + 1);
      }
      const requiresFullPad = missing === "STEEL" || missing === "TECH";
      const duplicateNode =
        mfgNodes.find(
          (m) =>
            (typeCounts.get(m.mfgType) || 0) > 1 &&
            (m.wTiles || 2) * (m.hTiles || 2) >= 6,
        ) ||
        mfgNodes.find(
          (m) =>
            (typeCounts.get(m.mfgType) || 0) > 1 &&
            (!requiresFullPad ||
              ((m.wTiles || 2) >= 2 && (m.hTiles || 2) >= 2)),
        );
      if (duplicateNode) {
        duplicateNode.mfgType = missing;
      }
    }
  }

  for (const m of mfgNodes) {
    const spec = MFG_SPECS[m.mfgType] || MFG_SPECS.STEEL;
    m.mfgTier = spec.mfgTier;
    m.requiredInputs = [...spec.requiredInputs];
    m.outputGood = spec.outputGood;
  }

  // 0C. Group surviving COM destinations by townId and assign demandedGoods without replacement
  const ALL_COMMERCIAL_GOODS = [
    "GROCERIES",
    "CONSUMER_GOODS",
    "HARDWARE",
    "ELECTRONICS",
  ];
  const comsByTown = new Map();
  for (const c of comNodes) {
    if (!comsByTown.has(c.townId)) comsByTown.set(c.townId, []);
    comsByTown.get(c.townId).push(c);
  }
  for (const [townId, townComs] of comsByTown) {
    for (let idx = 0; idx < townComs.length; idx++) {
      const com = townComs[idx];
      const g1 = ALL_COMMERCIAL_GOODS[(townId + idx) % 4];
      const g2 = ALL_COMMERCIAL_GOODS[(townId + idx + 1) % 4];
      if (com.isCircular || (com.pinsCount || 0) >= 4) {
        com.demandedGoods = [g1, g2];
      } else {
        com.demandedGoods = [g1];
      }
      const isCirc = Boolean(com.isCircular);
      com.subType = nameCommercialSubType(com.demandedGoods, isCirc);
      com.label = com.subType;
    }
  }

  // 0D. Initialize LOG destination demand profiles
  for (const lg of logNodes) {
    lg.demandProfile = {};
    lg.relativeDemand = 0.2;
  }

  // 0E. Build virtual TradeGateway proxy Destination nodes
  const rawGateways =
    world.tradeGateways && world.tradeGateways.length > 0
      ? world.tradeGateways
      : (world.airports || []).map((ap) => {
          const isHub = ap.isHub || ap.airportClass === "HUB";
          const isCrg = ap.airportClass === "CRG";
          const cap = isHub ? 3 : isCrg ? 4 : 2;
          return {
            id: "GW-AIR-" + ap.id,
            entityId: ap.id,
            modality: "air",
            name: ap.code || `Airport ${ap.id}`,
            code: ap.code || `AP${ap.id}`,
            townId: ap.townId ?? 0,
            landmassId:
              ap.landmassId ?? world.towns[ap.townId]?.landmassId ?? 0,
            x: ap.x,
            y: ap.y,
            lotX: ap.x,
            lotY: ap.y,
            roadX: ap.curbX ?? ap.x,
            roadY: ap.curbY ?? ap.y,
            importCapacity: cap,
            exportCapacity: cap,
            importedGoods: [
              "ELECTRONICS",
              "HARDWARE",
              "GROCERIES",
              "CONSUMER_GOODS",
              "CHEM",
            ],
            exportedGoods: [
              "ELECTRONICS",
              "CONSUMER_GOODS",
              "HARDWARE",
              "ORE",
              "WOOD",
              "AGRI",
            ],
            corridors: ap.externalCorridors || [],
            colorIdx: ap.colorIdx ?? 0,
            palette: ap.palette,
          };
        });

  const gatewayProxies = rawGateways.map((gw) => ({
    isGatewayProxy: true,
    id: 10000 + gw.entityId,
    airportId: gw.entityId,
    gatewayId: gw.id,
    x: gw.x,
    y: gw.y,
    gx: Math.round(gw.x),
    gy: Math.round(gw.y),
    wTiles: 2,
    hTiles: 2,
    lotX: gw.lotX,
    lotY: gw.lotY,
    roadX: gw.roadX,
    roadY: gw.roadY,
    townId: gw.townId,
    zoneType: /** @type {const} */ ("industrial"),
    subType: /** @type {const} */ ("LOG"),
    label: gw.code,
    colorIdx: gw.colorIdx,
    palette: gw.palette,
    isCircular: false,
    pinsCount: (gw.importCapacity || 2) + (gw.exportCapacity || 2),
    rawGateway: gw,
  }));

  // ---------------------------------------------------------------------------
  // Step 1 — Commercial (COM) Distinct Goods Pull & LOG Relative-Demand Aggregation
  // ---------------------------------------------------------------------------
  for (const com of comNodes) {
    const goodsToPull =
      com.demandedGoods && com.demandedGoods.length > 0
        ? com.demandedGoods.slice(0, 2)
        : ["GROCERIES"];

    for (const good of goodsToPull) {
      const demandWeight = Math.max(
        1,
        Math.min(4, Math.round((com.pinsCount || 4) / 2)),
      );

      /** @type {Array<{ node: any, stage: string, color: string, label: string, score: number, isLog: boolean }>} */
      const candidates = [];

      for (const lg of logNodes) {
        const crowD = Math.hypot(lg.x - com.x, lg.y - com.y);
        const sameLandmass = getLandmassId(lg) === getLandmassId(com);
        const score =
          crowD +
          (sameLandmass ? 0 : 35) +
          (crowD <= 95 ? 0 : 45) +
          3.5 * getOutbound(lg.id);
        candidates.push({
          node: lg,
          stage: "LOG->COM",
          color: CARGO_STAGE_COLORS["LOG->COM"],
          label: "Wholesale Goods → Commercial Sink",
          score,
          isLog: true,
        });
      }

      for (const mfg of mfgNodes) {
        if (mfg.outputGood === good) {
          const crowD = Math.hypot(mfg.x - com.x, mfg.y - com.y);
          const sameLandmass = getLandmassId(mfg) === getLandmassId(com);
          const score =
            crowD + (sameLandmass ? 0 : 35) + 28 + 11 * getOutbound(mfg.id);
          candidates.push({
            node: mfg,
            stage: "MFG->COM",
            color: CARGO_STAGE_COLORS["MFG->COM"],
            label: "Factory Direct → Commercial CBD",
            score,
            isLog: false,
          });
        }
      }

      for (const gw of gatewayProxies) {
        const crowD = Math.hypot(gw.x - com.x, gw.y - com.y);
        const sameLandmass = getLandmassId(gw) === getLandmassId(com);
        const score =
          crowD + (sameLandmass ? 0 : 35) + 30 + 12 * getOutbound(gw.id);
        candidates.push({
          node: gw,
          stage: "IMPORT->COM",
          color: CARGO_STAGE_COLORS["IMPORT->COM"],
          label: "Gateway Import → Commercial CBD",
          score,
          isLog: false,
        });
      }

      candidates.sort((a, b) => a.score - b.score);

      for (const cand of candidates) {
        if (
          connectLink(
            cand.node,
            com,
            cand.stage,
            cand.label,
            cand.color,
            120,
            good,
            demandWeight,
          )
        ) {
          if (cand.isLog) {
            cand.node.demandProfile[good] =
              (cand.node.demandProfile[good] || 0) + (com.pinsCount || 4);
          }
          break;
        }
      }
    }
  }

  // Aggregate totalLogDemand and compute relativeDemand
  let totalLogDemand = 0;
  for (const lg of logNodes) {
    const lgSum = Object.values(lg.demandProfile || {}).reduce(
      (a, b) => a + b,
      0,
    );
    totalLogDemand += lgSum;
  }
  for (const lg of logNodes) {
    const lgSum = Object.values(lg.demandProfile || {}).reduce(
      (a, b) => a + b,
      0,
    );
    lg.relativeDemand = Number(
      (lgSum / Math.max(1, totalLogDemand)).toFixed(3),
    );
  }

  // ---------------------------------------------------------------------------
  // Step 2 — Direct Inter-CBD & Downtown Shipping (CBD->CBD, color "#0284c7")
  // ---------------------------------------------------------------------------
  const primaryCbds = [];
  for (const [townId, townComs] of comsByTown) {
    const town = world.towns[townId];
    const isEligibleTown =
      !town ||
      town.tier <= 2 ||
      town.motorwayId != null ||
      townComs.some((c) => c.isCircular);
    if (!isEligibleTown && comsByTown.size > 2) continue;

    const sortedComs = [...townComs].sort(
      (a, b) =>
        (b.isCircular ? 100 : 0) +
        (b.pinsCount || 0) * 10 -
        ((a.isCircular ? 100 : 0) + (a.pinsCount || 0) * 10),
    );
    if (sortedComs.length > 0) {
      primaryCbds.push(sortedComs[0]);
    }
  }

  for (const cbd of primaryCbds) {
    const partners = primaryCbds
      .filter((p) => p.townId !== cbd.townId)
      .map((partner) => {
        const crowD = Math.hypot(partner.x - cbd.x, partner.y - cbd.y);
        const sameLandmass = getLandmassId(partner) === getLandmassId(cbd);
        const score =
          Math.abs(crowD - 75) +
          (sameLandmass ? 0 : 25) +
          10 * getOutbound(partner.id);
        return { partner, crowD, score };
      })
      .filter((p) => p.crowD >= 18 && p.crowD <= 185)
      .sort((a, b) => a.score - b.score);

    let cbdLinks = 0;
    for (const { partner } of partners) {
      if (
        connectLink(
          cbd,
          partner,
          "CBD->CBD",
          "Inter-CBD Courier & Wholesale",
          CARGO_STAGE_COLORS["CBD->CBD"],
          185,
          "B2B_PARCELS",
          3,
        )
      ) {
        cbdLinks++;
        if (cbdLinks >= 2) break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3 — Tier 3 LOG Hub Pull Proportional to relativeDemand (MFG->LOG, IMPORT->LOG)
  // ---------------------------------------------------------------------------
  for (const lg of logNodes) {
    const targetLinks = Math.max(
      2,
      Math.min(
        6,
        Math.round(2 + (lg.relativeDemand || 0.2) * logNodes.length * 2.2),
      ),
    );
    const sortedGoods = Object.keys(lg.demandProfile || {}).sort(
      (a, b) => (lg.demandProfile[b] || 0) - (lg.demandProfile[a] || 0),
    );
    const goodsPool =
      sortedGoods.length > 0 ? sortedGoods : ALL_COMMERCIAL_GOODS;

    let goodIdx = 0;
    while (getInbound(lg.id) < targetLinks && goodIdx < goodsPool.length * 2) {
      const good = goodsPool[goodIdx % goodsPool.length];
      goodIdx++;

      /** @type {Array<{ node: any, stage: string, color: string, label: string, score: number }>} */
      const cands = [];
      for (const mfg of mfgNodes) {
        if (mfg.outputGood === good) {
          const crowD = Math.hypot(mfg.x - lg.x, mfg.y - lg.y);
          const sameLandmass = getLandmassId(mfg) === getLandmassId(lg);
          const score =
            crowD + (sameLandmass ? 0 : 35) + 12 * getOutbound(mfg.id);
          cands.push({
            node: mfg,
            stage: "MFG->LOG",
            color: CARGO_STAGE_COLORS["MFG->LOG"],
            label: "Factory Output → Distribution Hub",
            score,
          });
        }
      }
      for (const gw of gatewayProxies) {
        const crowD = Math.hypot(gw.x - lg.x, gw.y - lg.y);
        const sameLandmass = getLandmassId(gw) === getLandmassId(lg);
        const score =
          crowD + (sameLandmass ? 0 : 35) + 15 + 12 * getOutbound(gw.id);
        cands.push({
          node: gw,
          stage: "IMPORT->LOG",
          color: CARGO_STAGE_COLORS["IMPORT->LOG"],
          label: "Imported Cargo → Logistics Hub",
          score,
        });
      }

      cands.sort((a, b) => a.score - b.score);
      const demandWeight = Math.max(
        1,
        Math.min(5, Math.round(1 + (lg.relativeDemand || 0.2) * 3)),
      );

      for (const c of cands) {
        if (
          connectLink(
            c.node,
            lg,
            c.stage,
            c.label,
            c.color,
            140,
            good,
            demandWeight,
          )
        ) {
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4 — Tier 2B (MFG->MFG) & Tier 2A (RAW->MFG / IMPORT->MFG) 2-Input Load-Balanced Pull
  // ---------------------------------------------------------------------------
  for (const mfg of mfgNodes) {
    const required =
      mfg.requiredInputs && mfg.requiredInputs.length > 0
        ? mfg.requiredInputs
        : ["ORE", "WOOD"];

    for (const reqGood of required) {
      /** @type {Array<{ sup: any, isHardware: boolean, isGateway: boolean }>} */
      const candidates = [];

      if (reqGood === "HARDWARE") {
        for (const otherMfg of mfgNodes) {
          if (otherMfg.id !== mfg.id && otherMfg.outputGood === "HARDWARE") {
            candidates.push({
              sup: otherMfg,
              isHardware: true,
              isGateway: false,
            });
          }
        }
        for (const gw of gatewayProxies) {
          candidates.push({ sup: gw, isHardware: false, isGateway: true });
        }
      } else {
        for (const raw of rawNodes) {
          if (raw.outputGood === reqGood) {
            candidates.push({ sup: raw, isHardware: false, isGateway: false });
          }
        }
        for (const gw of gatewayProxies) {
          candidates.push({ sup: gw, isHardware: false, isGateway: true });
        }
      }

      // Score candidates using load-balanced formula:
      // score = crowD + (sameLandmass ? 0 : 35) + 18 * outboundCount - (outboundCount === 0 ? 28 : 0) + (crowD < 14 ? 16 : 0) + (isGateway ? 24 : 0)
      const scored = candidates.map(({ sup, isHardware, isGateway }) => {
        const crowD = Math.hypot(sup.x - mfg.x, sup.y - mfg.y);
        const sameLandmass = getLandmassId(sup) === getLandmassId(mfg);
        const outCount = getOutbound(sup.id);
        const score =
          crowD +
          (sameLandmass ? 0 : 35) +
          18 * outCount -
          (outCount === 0 ? 28 : 0) +
          (crowD < 14 ? 16 : 0) +
          (isGateway ? 24 : 0);
        return { sup, isHardware, isGateway, score };
      });

      scored.sort((a, b) => a.score - b.score);

      for (const { sup, isHardware, isGateway } of scored) {
        const stage = isGateway
          ? "IMPORT->MFG"
          : isHardware
            ? "MFG->MFG"
            : "RAW->MFG";
        const label = isGateway
          ? "Raw/Intermediate Import → Factory"
          : isHardware
            ? "Intermediate Hardware & Steel"
            : "Raw Materials → Factory";
        const color = CARGO_STAGE_COLORS[stage];

        if (connectLink(sup, mfg, stage, label, color, 145, reqGood, 2)) {
          break;
        }
      }
    }

    // Fallback: If 0 inbound links, try reachable TradeGateway proxy or any reachable RAW/MFG
    if (getInbound(mfg.id) === 0) {
      const fallbackSuppliers = [...gatewayProxies, ...rawNodes, ...mfgNodes]
        .filter((s) => s.id !== mfg.id)
        .sort((a, b) => {
          const sameA = getLandmassId(a) === getLandmassId(mfg) ? 0 : 40;
          const sameB = getLandmassId(b) === getLandmassId(mfg) ? 0 : 40;
          return (
            Math.hypot(a.x - mfg.x, a.y - mfg.y) +
            sameA -
            (Math.hypot(b.x - mfg.x, b.y - mfg.y) + sameB)
          );
        });

      for (const sup of fallbackSuppliers) {
        const isGw = Boolean(sup.isGatewayProxy);
        const isM = sup.subType === "MFG";
        const stage = isGw ? "IMPORT->MFG" : isM ? "MFG->MFG" : "RAW->MFG";
        const label = isGw
          ? "Raw/Intermediate Import → Factory"
          : isM
            ? "Intermediate Hardware & Steel"
            : "Raw Materials → Factory";
        const color = CARGO_STAGE_COLORS[stage];
        const commodity = sup.outputGood || "ORE";

        if (connectLink(sup, mfg, stage, label, color, 160, commodity, 2)) {
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 5 — TradeGateway Export Pull & 100% Connectivity Sweep
  // ---------------------------------------------------------------------------
  for (const gw of gatewayProxies) {
    const maxExp = Math.max(1, Math.min(2, gw.rawGateway?.exportCapacity ?? 2));
    const exportCands = [...rawNodes, ...mfgNodes, ...logNodes]
      .map((cand) => {
        const crowD = Math.hypot(cand.x - gw.x, cand.y - gw.y);
        const sameLandmass = getLandmassId(cand) === getLandmassId(gw);
        const outCount = getOutbound(cand.id);
        const score =
          (outCount === 0 ? -50 : 0) +
          15 * outCount +
          crowD +
          (sameLandmass ? 0 : 30);
        return { cand, score };
      })
      .sort((a, b) => a.score - b.score);

    let expCount = 0;
    for (const { cand } of exportCands) {
      const stage =
        cand.subType === "RAW"
          ? "RAW->EXPORT"
          : cand.subType === "MFG"
            ? "MFG->EXPORT"
            : "LOG->EXPORT";
      const label =
        cand.subType === "RAW"
          ? "Raw Resource Export"
          : cand.subType === "MFG"
            ? "Manufactured Export"
            : "Consolidated Freight Export";
      const commodity =
        cand.outputGood || (cand.subType === "RAW" ? "ORE" : "CONSUMER_GOODS");

      if (
        connectLink(
          cand,
          gw,
          stage,
          label,
          CARGO_STAGE_COLORS[stage],
          140,
          commodity,
          3,
        )
      ) {
        expCount++;
        if (expCount >= maxExp) break;
      }
    }
  }

  // 100% Connectivity Sweep:
  // 1. Any RAW with outboundCount === 0:
  for (const raw of rawNodes) {
    if (getOutbound(raw.id) === 0) {
      const targets = [...mfgNodes, ...logNodes, ...gatewayProxies].sort(
        (a, b) => {
          const sameA = getLandmassId(a) === getLandmassId(raw) ? 0 : 40;
          const sameB = getLandmassId(b) === getLandmassId(raw) ? 0 : 40;
          return (
            Math.hypot(a.x - raw.x, a.y - raw.y) +
            sameA -
            (Math.hypot(b.x - raw.x, b.y - raw.y) + sameB)
          );
        },
      );
      for (const tgt of targets) {
        const stage = tgt.isGatewayProxy
          ? "RAW->EXPORT"
          : tgt.subType === "LOG"
            ? "RAW->LOG"
            : "RAW->MFG";
        const label = tgt.isGatewayProxy
          ? "Raw Resource Export"
          : tgt.subType === "LOG"
            ? "Bulk Feedstock → Logistics Hub"
            : "Raw Materials → Factory";
        const color = CARGO_STAGE_COLORS[stage];
        if (
          connectLink(
            raw,
            tgt,
            stage,
            label,
            color,
            160,
            raw.outputGood || "ORE",
            2,
          )
        ) {
          break;
        }
      }
    }
  }

  // 2. Any MFG with outboundCount === 0:
  for (const mfg of mfgNodes) {
    if (getOutbound(mfg.id) === 0) {
      const targets = [
        ...logNodes,
        ...mfgNodes.filter((m) => m.id !== mfg.id),
        ...comNodes,
        ...gatewayProxies,
      ].sort((a, b) => {
        const sameA = getLandmassId(a) === getLandmassId(mfg) ? 0 : 40;
        const sameB = getLandmassId(b) === getLandmassId(mfg) ? 0 : 40;
        return (
          Math.hypot(a.x - mfg.x, a.y - mfg.y) +
          sameA -
          (Math.hypot(b.x - mfg.x, b.y - mfg.y) + sameB)
        );
      });
      for (const tgt of targets) {
        const stage = tgt.isGatewayProxy
          ? "MFG->EXPORT"
          : tgt.zoneType === "commercial"
            ? "MFG->COM"
            : tgt.subType === "MFG"
              ? "MFG->MFG"
              : "MFG->LOG";
        const label = tgt.isGatewayProxy
          ? "Manufactured Export"
          : tgt.zoneType === "commercial"
            ? "Factory Direct → Commercial CBD"
            : tgt.subType === "MFG"
              ? "Intermediate Hardware & Steel"
              : "Factory Output → Distribution Hub";
        const color = CARGO_STAGE_COLORS[stage];
        if (
          connectLink(
            mfg,
            tgt,
            stage,
            label,
            color,
            160,
            mfg.outputGood || "CONSUMER_GOODS",
            2,
          )
        ) {
          break;
        }
      }
    }
  }

  // 3. Any LOG with inboundCount === 0 or outboundCount === 0:
  for (const lg of logNodes) {
    if (getInbound(lg.id) === 0) {
      const suppliers = [...mfgNodes, ...rawNodes, ...gatewayProxies].sort(
        (a, b) => {
          const sameA = getLandmassId(a) === getLandmassId(lg) ? 0 : 40;
          const sameB = getLandmassId(b) === getLandmassId(lg) ? 0 : 40;
          return (
            Math.hypot(a.x - lg.x, a.y - lg.y) +
            sameA -
            (Math.hypot(b.x - lg.x, b.y - lg.y) + sameB)
          );
        },
      );
      for (const sup of suppliers) {
        const stage = sup.isGatewayProxy
          ? "IMPORT->LOG"
          : sup.subType === "RAW"
            ? "RAW->LOG"
            : "MFG->LOG";
        const label = sup.isGatewayProxy
          ? "Imported Cargo → Logistics Hub"
          : sup.subType === "RAW"
            ? "Bulk Feedstock → Logistics Hub"
            : "Factory Output → Distribution Hub";
        const color = CARGO_STAGE_COLORS[stage];
        if (
          connectLink(
            sup,
            lg,
            stage,
            label,
            color,
            160,
            sup.outputGood || "CONSUMER_GOODS",
            2,
          )
        ) {
          break;
        }
      }
    }
    if (getOutbound(lg.id) === 0) {
      const targets = [...comNodes, ...gatewayProxies].sort((a, b) => {
        const sameA = getLandmassId(a) === getLandmassId(lg) ? 0 : 40;
        const sameB = getLandmassId(b) === getLandmassId(lg) ? 0 : 40;
        return (
          Math.hypot(a.x - lg.x, a.y - lg.y) +
          sameA -
          (Math.hypot(b.x - lg.x, b.y - lg.y) + sameB)
        );
      });
      for (const tgt of targets) {
        const stage = tgt.isGatewayProxy ? "LOG->EXPORT" : "LOG->COM";
        const label = tgt.isGatewayProxy
          ? "Consolidated Freight Export"
          : "Wholesale Goods → Commercial Sink";
        const color = CARGO_STAGE_COLORS[stage];
        if (
          connectLink(lg, tgt, stage, label, color, 160, "CONSUMER_GOODS", 2)
        ) {
          break;
        }
      }
    }
  }

  // 4. Any COM with inboundCount === 0:
  for (const com of comNodes) {
    if (getInbound(com.id) === 0) {
      const suppliers = [...logNodes, ...mfgNodes, ...gatewayProxies].sort(
        (a, b) => {
          const sameA = getLandmassId(a) === getLandmassId(com) ? 0 : 40;
          const sameB = getLandmassId(b) === getLandmassId(com) ? 0 : 40;
          return (
            Math.hypot(a.x - com.x, a.y - com.y) +
            sameA -
            (Math.hypot(b.x - com.x, b.y - com.y) + sameB)
          );
        },
      );
      for (const sup of suppliers) {
        const stage = sup.isGatewayProxy
          ? "IMPORT->COM"
          : sup.subType === "MFG"
            ? "MFG->COM"
            : "LOG->COM";
        const label = sup.isGatewayProxy
          ? "Gateway Import → Commercial CBD"
          : sup.subType === "MFG"
            ? "Factory Direct → Commercial CBD"
            : "Wholesale Goods → Commercial Sink";
        const color = CARGO_STAGE_COLORS[stage];
        const good = (com.demandedGoods && com.demandedGoods[0]) || "GROCERIES";
        if (connectLink(sup, com, stage, label, color, 160, good, 2)) {
          break;
        }
      }
    }
  }

  world.logs.push(
    `Zoned <b>${comNodes.length} Commercial</b> (CBD/Arterial) & <b>${rawNodes.length + mfgNodes.length + logNodes.length} Industrial</b> (${rawNodes.length} Raw, ${mfgNodes.length} Mfg, ${logNodes.length} Log) with <b>${world.cargoLinks.length} pull-demand freight chains</b>.`,
  );
}
