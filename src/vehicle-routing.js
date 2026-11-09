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
        const dx = samples[bestK].x - fromPt.x;
        const dy = samples[bestK].y - fromPt.y;
        if (
          dx * ux + dy * uy < 0.25 &&
          bestK + dirSign >= 0 &&
          bestK + dirSign < samples.length
        ) {
          bestK += dirSign;
        }
      } else if (toPt) {
        const dx = toPt.x - samples[bestK].x;
        const dy = toPt.y - samples[bestK].y;
        if (
          dx * ux + dy * uy < 0.25 &&
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

      const uAx = Math.cos(ic.angleA);
      const uAy = Math.sin(ic.angleA);
      const uBx = Math.cos(ic.angleB);
      const uBy = Math.sin(ic.angleB);

      const signsA = ic.activeSignsA || [-1, 1];
      const signsB = ic.activeSignsB || [-1, 1];

      const outerDist = 2.95;
      const outerCtrl = 1.05;
      const leafSpan = 3.1;

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
              rNodesInner.push(
                addNode(rx, ry, true, false, false, false, true),
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
              rNodesInner.push(
                addNode(rx, ry, true, false, false, false, true),
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

      const cosM = Math.cos(ic.angleMain);
      const sinM = Math.sin(ic.angleMain);
      const toWorld = (lx, ly) => ({
        x: ic.x + lx * cosM - ly * sinM,
        y: ic.y + lx * sinM + ly * cosM,
      });

      const sy = ic.sideSign || 1;
      const oppSy = -sy;

      const pMainOuter = toWorld(-2.15, 0);
      const pSpurOuter = toWorld(0, sy * 2.15);
      const pMainInner = toWorld(0.52, 0);
      const pSpurInner = toWorld(0, 0);

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

      // Helper to evaluate cubic Bezier segment in local Trumpet coordinates
      const evalCubicSeg = (p0, p1, p2, p3, t) => {
        const mt = 1 - t;
        return {
          lx:
            mt * mt * mt * p0.lx +
            3 * mt * mt * t * p1.lx +
            3 * mt * t * t * p2.lx +
            t * t * t * p3.lx,
          ly:
            mt * mt * mt * p0.ly +
            3 * mt * mt * t * p1.ly +
            3 * mt * t * t * p2.ly +
            t * t * t * p3.ly,
        };
      };

      const seg1_p0 = { lx: 0, ly: 0 };
      const seg1_p1 = { lx: 0, ly: oppSy * 1.35 };
      const seg1_p2 = { lx: 0.38, ly: oppSy * 1.85 };
      const seg1_p3 = { lx: 1.02, ly: oppSy * 1.85 };

      const seg2_p0 = { lx: 1.02, ly: oppSy * 1.85 };
      const seg2_p1 = { lx: 1.92, ly: oppSy * 1.85 };
      const seg2_p2 = { lx: 1.92, ly: 0 };
      const seg2_p3 = { lx: 0.52, ly: 0 };

      const seg2Fwd_p0 = { lx: 1.02, ly: oppSy * 1.85 };
      const seg2Fwd_p1 = { lx: 1.85, ly: oppSy * 1.85 };
      const seg2Fwd_p2 = { lx: 1.65, ly: 0 };
      const seg2Fwd_p3 = { lx: 1.92, ly: 0 };
      const pMainEast = toWorld(1.92, 0);

      // 1. West Mainline (-lx) <-> Spur Movements (1a & 1b):
      // Route each direction along whichever of the two painted Trumpet ribbons (Outer Slip-Ramp in (-1, +sy)
      // vs. Inner Bell Loop in (+1, -sy)) sits on its right-hand carriageway side!
      if (sy === 1) {
        // Movement 1a (sy === 1): Mainline Fwd (ly > 0) -> Outer Slip-Ramp (-1, +1) -> Spur Outbound (lx < 0)
        const rNodesOut = [];
        for (const t of [0.0, 0.25, 0.5, 0.75, 1.0]) {
          const mt = 1 - t;
          const lx = mt * mt * -2.15 + 2 * mt * t * -0.72;
          const ly = 2 * mt * t * (sy * 0.72) + t * t * (sy * 2.15);
          const wPt = toWorld(lx, ly);
          rNodesOut.push(
            addNode(wPt.x, wPt.y, true, false, false, false, true),
          );
        }
        const kMO = findSampleNear(
          mainEntry.mw,
          pMainOuter.x,
          pMainOuter.y,
          null,
          nodes[rNodesOut[0]],
          1,
        );
        const kSO = findSampleNear(
          spurEntry.mw,
          pSpurOuter.x,
          pSpurOuter.y,
          nodes[rNodesOut[rNodesOut.length - 1]],
          null,
          spurEndAtIc ? -1 : 1,
        );
        const chainOut = [
          mainEntry.mNodesFwd[kMO],
          ...rNodesOut,
          spurOutboundNode[kSO],
        ];
        for (let c = 0; c < chainOut.length - 1; c++) {
          const uN = chainOut[c];
          const vN = chainOut[c + 1];
          const segD =
            Math.hypot(nodes[vN].x - nodes[uN].x, nodes[vN].y - nodes[uN].y) ||
            0.4;
          addEdge(uN, vN, segD * 0.55 + 0.1);
        }

        // Movement 1b (sy === 1): Spur Inbound (lx > 0) -> Inner Bell Loop (+1, -1) -> Mainline Rev (ly < 0, -lx)
        const rNodesBell = [];
        for (const t of [0.0, 0.33, 0.67, 1.0]) {
          const lp = evalCubicSeg(seg1_p0, seg1_p1, seg1_p2, seg1_p3, t);
          const wp = toWorld(lp.lx, lp.ly);
          rNodesBell.push(addNode(wp.x, wp.y, true, false, false, false, true));
        }
        for (const t of [0.33, 0.67, 1.0]) {
          const lp = evalCubicSeg(seg2_p0, seg2_p1, seg2_p2, seg2_p3, t);
          const wp = toWorld(lp.lx, lp.ly);
          rNodesBell.push(addNode(wp.x, wp.y, true, false, false, false, true));
        }
        const kSI = findSampleNear(
          spurEntry.mw,
          pSpurInner.x,
          pSpurInner.y,
          null,
          nodes[rNodesBell[0]],
          spurEndAtIc ? 1 : -1,
        );
        const kMI = findSampleNear(
          mainEntry.mw,
          pMainInner.x,
          pMainInner.y,
          nodes[rNodesBell[rNodesBell.length - 1]],
          null,
          -1,
        );
        const chainBell = [
          spurInboundNode[kSI],
          ...rNodesBell,
          mainEntry.mNodesRev[kMI],
        ];
        for (let c = 0; c < chainBell.length - 1; c++) {
          const uN = chainBell[c];
          const vN = chainBell[c + 1];
          const segD =
            Math.hypot(nodes[vN].x - nodes[uN].x, nodes[vN].y - nodes[uN].y) ||
            0.4;
          addEdge(uN, vN, segD * 0.55 + 0.1);
        }
      } else {
        // Movement 1a (sy === -1): Mainline Fwd (ly > 0) -> Inner Bell Loop (+1, +1) -> Spur Outbound (lx > 0)
        const rNodesBell = [];
        for (const t of [0.0, 0.33, 0.67, 1.0]) {
          const lp = evalCubicSeg(seg2_p3, seg2_p2, seg2_p1, seg2_p0, t);
          const wp = toWorld(lp.lx, lp.ly);
          rNodesBell.push(addNode(wp.x, wp.y, true, false, false, false, true));
        }
        for (const t of [0.33, 0.67, 1.0]) {
          const lp = evalCubicSeg(seg1_p3, seg1_p2, seg1_p1, seg1_p0, t);
          const wp = toWorld(lp.lx, lp.ly);
          rNodesBell.push(addNode(wp.x, wp.y, true, false, false, false, true));
        }
        const kMI = findSampleNear(
          mainEntry.mw,
          pMainInner.x,
          pMainInner.y,
          null,
          nodes[rNodesBell[0]],
          1,
        );
        const kSI = findSampleNear(
          spurEntry.mw,
          pSpurInner.x,
          pSpurInner.y,
          nodes[rNodesBell[rNodesBell.length - 1]],
          null,
          spurEndAtIc ? -1 : 1,
        );
        const chainBell = [
          mainEntry.mNodesFwd[kMI],
          ...rNodesBell,
          spurOutboundNode[kSI],
        ];
        for (let c = 0; c < chainBell.length - 1; c++) {
          const uN = chainBell[c];
          const vN = chainBell[c + 1];
          const segD =
            Math.hypot(nodes[vN].x - nodes[uN].x, nodes[vN].y - nodes[uN].y) ||
            0.4;
          addEdge(uN, vN, segD * 0.55 + 0.1);
        }

        // Movement 1b (sy === -1): Spur Inbound (lx < 0) -> Outer Slip-Ramp (-1, -1) -> Mainline Rev (ly < 0, -lx)
        const rNodesOut = [];
        for (const t of [0.0, 0.25, 0.5, 0.75, 1.0]) {
          const mt = 1 - t;
          const lx = 2 * mt * t * -0.72 + t * t * -2.15;
          const ly = mt * mt * (sy * 2.15) + 2 * mt * t * (sy * 0.72);
          const wPt = toWorld(lx, ly);
          rNodesOut.push(
            addNode(wPt.x, wPt.y, true, false, false, false, true),
          );
        }
        const kSO = findSampleNear(
          spurEntry.mw,
          pSpurOuter.x,
          pSpurOuter.y,
          null,
          nodes[rNodesOut[0]],
          spurEndAtIc ? 1 : -1,
        );
        const kMO = findSampleNear(
          mainEntry.mw,
          pMainOuter.x,
          pMainOuter.y,
          nodes[rNodesOut[rNodesOut.length - 1]],
          null,
          -1,
        );
        const chainOut = [
          spurInboundNode[kSO],
          ...rNodesOut,
          mainEntry.mNodesRev[kMO],
        ];
        for (let c = 0; c < chainOut.length - 1; c++) {
          const uN = chainOut[c];
          const vN = chainOut[c + 1];
          const segD =
            Math.hypot(nodes[vN].x - nodes[uN].x, nodes[vN].y - nodes[uN].y) ||
            0.4;
          addEdge(uN, vN, segD * 0.55 + 0.1);
        }
      }

      // 2. Inner 270° Trumpet Bell Loop in (+1, -sy) opposite quadrant:
      // Direction 2a: Spur Inbound -> Mainline Fwd (+lx)
      {
        const rNodes = [];
        for (const t of [0.0, 0.33, 0.67, 1.0]) {
          const lp = evalCubicSeg(seg1_p0, seg1_p1, seg1_p2, seg1_p3, t);
          const wp = toWorld(lp.lx, lp.ly);
          rNodes.push(addNode(wp.x, wp.y, true, false, false, false, true));
        }
        for (const t of [0.33, 0.67, 1.0]) {
          const lp = evalCubicSeg(
            seg2Fwd_p0,
            seg2Fwd_p1,
            seg2Fwd_p2,
            seg2Fwd_p3,
            t,
          );
          const wp = toWorld(lp.lx, lp.ly);
          rNodes.push(addNode(wp.x, wp.y, true, false, false, false, true));
        }
        const firstPt = nodes[rNodes[0]];
        const lastPt = nodes[rNodes[rNodes.length - 1]];
        const kSI = findSampleNear(
          spurEntry.mw,
          pSpurInner.x,
          pSpurInner.y,
          null,
          firstPt,
          spurEndAtIc ? 1 : -1,
        );
        const kME = findSampleNear(
          mainEntry.mw,
          pMainEast.x,
          pMainEast.y,
          lastPt,
          null,
          1,
        );
        const chain = [
          spurInboundNode[kSI],
          ...rNodes,
          mainEntry.mNodesFwd[kME],
        ];
        for (let c = 0; c < chain.length - 1; c++) {
          const uN = chain[c];
          const vN = chain[c + 1];
          const segD =
            Math.hypot(nodes[vN].x - nodes[uN].x, nodes[vN].y - nodes[uN].y) ||
            0.4;
          addEdge(uN, vN, segD * 0.55 + 0.1);
        }
      }

      // Direction 2b: Mainline Rev (-lx) -> Spur Outbound
      {
        const rNodes = [];
        for (const t of [0.0, 0.33, 0.67, 1.0]) {
          const lp = evalCubicSeg(seg2_p3, seg2_p2, seg2_p1, seg2_p0, t);
          const wp = toWorld(lp.lx, lp.ly);
          rNodes.push(addNode(wp.x, wp.y, true, false, false, false, true));
        }
        for (const t of [0.33, 0.67, 1.0]) {
          const lp = evalCubicSeg(seg1_p3, seg1_p2, seg1_p1, seg1_p0, t);
          const wp = toWorld(lp.lx, lp.ly);
          rNodes.push(addNode(wp.x, wp.y, true, false, false, false, true));
        }
        const firstPt = nodes[rNodes[0]];
        const lastPt = nodes[rNodes[rNodes.length - 1]];
        const kMI = findSampleNear(
          mainEntry.mw,
          pMainInner.x,
          pMainInner.y,
          null,
          firstPt,
          -1,
        );
        const kSI = findSampleNear(
          spurEntry.mw,
          pSpurInner.x,
          pSpurInner.y,
          lastPt,
          null,
          spurEndAtIc ? -1 : 1,
        );
        const chain = [
          mainEntry.mNodesRev[kMI],
          ...rNodes,
          spurOutboundNode[kSI],
        ];
        for (let c = 0; c < chain.length - 1; c++) {
          const uN = chain[c];
          const vN = chain[c + 1];
          const segD =
            Math.hypot(nodes[vN].x - nodes[uN].x, nodes[vN].y - nodes[uN].y) ||
            0.4;
          addEdge(uN, vN, segD * 0.55 + 0.1);
        }
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

  if (srcPt) {
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
      const rawSweep =
        (((thetaIn - thetaOut) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
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
        });
      }
      i = j;
    } else {
      pushSpinePt({ ...pt });
    }
  }

  const lastRaw = rawPath[rawPath.length - 1];
  if (dstPt) {
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
 * STAGE 8B: INTER-INDUSTRIAL CARGO SUPPLY CHAIN (`RAW -> MFG -> LOG -> COM`)
 * Links Primary Extraction (`RAW`), Secondary Manufacturing (`MFG`), Wholesale Logistics (`LOG`),
 * and CBD/Arterial Commercial Sinks (`COM`) into an active road-routed regional freight network.
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
    const roadPath = world.findVehicleNetworkPath(sx, sy, ex, ey);
    if (!roadPath || roadPath.length < 2) return false;
    let pathArcLen = 0;
    for (let i = 1; i < roadPath.length; i++) {
      pathArcLen += Math.hypot(
        roadPath[i].x - roadPath[i - 1].x,
        roadPath[i].y - roadPath[i - 1].y,
      );
    }
    if (pathArcLen > crowD * 3.4 + 35) return false;

    const outboundTrack = world.buildDirectedLaneTrajectory(src, dst, roadPath);
    const revRoadPath =
      world.findVehicleNetworkPath(ex, ey, sx, sy) || [...roadPath].reverse();
    const inboundTrack = world.buildDirectedLaneTrajectory(
      dst,
      src,
      revRoadPath,
    );

    world.cargoLinks.push({
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
          world.towns[a.townId]?.landmassId ===
          world.towns[src.townId]?.landmassId
            ? 0
            : 90;
        const sameB =
          world.towns[b.townId]?.landmassId ===
          world.towns[src.townId]?.landmassId
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
    if (world.cargoLinks.some((l) => l.to.id === mfg.id)) continue;
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
    if (world.cargoLinks.some((l) => l.to.id === lg.id)) continue;
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

  world.logs.push(
    `Zoned <b>${comNodes.length} Commercial</b> (CBD/Arterial) & <b>${rawNodes.length + mfgNodes.length + logNodes.length} Industrial</b> (${rawNodes.length} Raw, ${mfgNodes.length} Mfg, ${logNodes.length} Log) with <b>${world.cargoLinks.length} road freight chains</b>.`,
  );
}
