/** @import { ProceduralLogisticsWorld } from "./world-generator.js" */
import { PALETTE } from "./palette.js";
import { ROAD_GRID, BUILDING_MASK, WORLD_GEOMETRY } from "./constants.js";

/*************************************************************************
 * STAGE 6: REGIONAL A* ROAD & PERPENDICULAR BRIDGE NETWORK
 *************************************************************************/
/**
 * @param {ProceduralLogisticsWorld} world
 */
export function buildRegionalRoadNetwork(world) {
  world.bridgeCount = 0;

  // Pre-seed each town's primary cardinal cross-avenues outward from the town center
  // so inter-town A* arterials snap onto the orthogonal urban street grid without creating
  // disconnected street islands across rivers or airport pads.
  for (const town of world.towns) {
    const span = Math.round(town.urbanRadius * 0.65);
    world.carveStreetFromCenter(town.x, town.y, 1, 0, span, span);
    world.carveStreetFromCenter(town.x, town.y, 0, 1, span, span);
  }

  // Connect Towns in a River-Aware Minimum Spanning Tree + 1 regional loop chord.
  // Penalizing water crossings in edge selection connects same-bank towns along continuous
  // valley corridors first and places bridges only at strategic cross-river links.
  const nodes = world.towns.map((t) => ({
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
      if (world.inBounds(sx, sy, 1)) {
        const id = world.idx(sx, sy);
        const wm = world.waterMask[id];
        if (wm === 1) riverHits++;
        else if (wm === 2) seaHits++;
        if (world.buildingMask[id] === 3) riverHits += 4;
        ridgePenalty +=
          Math.max(0, world.elevationField[id] - world.seaLevel - 0.12) * 24.0 +
          world.slopeField[id] * 12.0;
      }
    }
    const diffCluster = a.ref.clusterId !== b.ref.clusterId ? 24 : 0;
    const waterCost =
      (riverHits > 0 ? 22 + riverHits * 3.5 : 0) +
      (seaHits > 0
        ? world.config.archetype === "island-hopper"
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

  const isIslandHopper = world.config.archetype === "island-hopper";
  const scaleSpan = Math.max(1, world.W / 360);

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
    const path = world.findRoadPathAStar(
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
      world.commitRoadPath(path, "arterial");
      townRoadDegree[i]++;
      townRoadDegree[j]++;
    }
  }
  if (!isIslandHopper) {
    for (const [i, j] of skippedEdges) {
      if (townRoadDegree[i] === 0 || townRoadDegree[j] === 0) {
        const path = world.findRoadPathAStar(
          nodes[i].x,
          nodes[i].y,
          nodes[j].x,
          nodes[j].y,
          true,
        );
        if (path) {
          world.commitRoadPath(path, "arterial");
          townRoadDegree[i]++;
          townRoadDegree[j]++;
        }
      }
    }
  }

  for (const ap of world.airports) {
    const host = world.towns[ap.hostTownId];
    if (host) {
      let path = world.findRoadPathAStar(
        ap.gateX,
        ap.gateY,
        host.x,
        host.y,
        false,
        null,
        true,
      );
      if (!path) {
        path = world.findRoadPathAStar(
          ap.gateX,
          ap.gateY,
          host.x,
          host.y,
          true,
          null,
          true,
        );
      }
      if (path) world.commitRoadPath(path, "arterial");
    }
  }

  // Phase 2 of Historical Co-Evolution (Stage 6C & 6D):
  // Nucleate Tier-3 Market/Bridgehead Towns & Tier-4 Crossroads Hamlets along the ancient trunk
  // highways, river bridgeheads, and unserved river valleys, then carve their grids & connect!
  world.seedSecondaryTownsAlongTrunks();
}

export function seedSecondaryTownsAlongTrunks(world) {
  const targetCount = world.config.townCount || 20;
  const startCount = world.towns.length;
  if (startCount >= targetCount) {
    world.logs.push(
      `Routed <b>${world.roads.length} regional roads & streets</b> and <b>${world.bridgeCount} bridges</b>.`,
    );
    return;
  }

  const usedNames = new Set(world.towns.map((t) => t.name));
  const isIslandHopper = world.config.archetype === "island-hopper";
  const landmassTownCount = new Int16Array(
    Math.max(1, world.landmasses.length),
  );
  for (const t of world.towns) {
    if (t.landmassId >= 0 && t.landmassId < landmassTownCount.length) {
      landmassTownCount[t.landmassId]++;
    }
  }

  // 1. Collect river bridgeheads (`roadGrid === 2` within 1..5 tiles of `roadGrid === 3`)
  //    and rural trunk highway tiles (`roadGrid === 2` outside existing Phase-1 city envelopes)
  const bridgeheadPts = [];
  const trunkRoadPts = [];
  for (let y = 8; y < world.H - 8; y += 2) {
    for (let x = 8; x < world.W - 8; x += 2) {
      const id = world.idx(x, y);
      if (world.roadGrid[id] !== 2 || world.waterMask[id] !== 0) continue;
      const insidePhase1 = world.towns.some(
        (t) => Math.hypot(x - t.x, y - t.y) < t.urbanRadius + 6.5,
      );
      if (insidePhase1) continue;
      trunkRoadPts.push({ x, y });

      let nearBridge = false;
      for (let dy = -4; dy <= 4 && !nearBridge; dy += 2) {
        for (let dx = -4; dx <= 4; dx += 2) {
          if (
            world.inBounds(x + dx, y + dy, 1) &&
            world.roadGrid[world.idx(x + dx, y + dy)] === 3
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
  for (let y = 16; y < world.H - 16; y += 3) {
    for (let x = 16; x < world.W - 16; x += 3) {
      const id = world.idx(x, y);
      if (world.waterMask[id] > 0 || world.distToWater[id] < 2.8) continue;
      const lmId = world.landmassId[id];
      if (lmId < 0) continue;
      const slope = world.slopeField[id];
      if (slope > 0.44 || world.elevationField[id] > world.seaLevel + 0.36)
        continue;
      if (world.isPointInAirportPad(x, y, 7.5)) continue;

      // Exclude airport low-altitude runway approach cones so secondary towns never spawn under flight paths
      let inApproachCone = false;
      for (const ap of world.airports) {
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

      const dW = world.distToWater[id];
      candidateSites.push({
        x,
        y,
        lmId,
        slope,
        dW,
        baseSuit: world.urbanSuitability[id] * 0.68,
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
      for (const t of world.towns) {
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
        site.baseSuit + waterfrontBonus + world.rng.range(-0.025, 0.025);

      if (
        isIslandHopper &&
        landmassTownCount[lmId] === 0 &&
        world.landmasses[lmId].size >= 160
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
      for (const cl of world.clusters) {
        const cd = Math.hypot(bestPt.x - cl.x, bestPt.y - cl.y);
        if (cd < minCD) {
          minCD = cd;
          clusterId = cl.clusterId;
        }
      }
      const colorIdx = (clusterId + (i % 2)) % PALETTE.districtColors.length;
      const tierTitle = tier === 3 ? "Market Town" : "Rural Hamlet";
      const name = world.generateTopographicTownName(
        bestPt.x,
        bestPt.y,
        usedNames,
      );
      const iata = name
        .replace(/[^A-Za-z]/g, "")
        .slice(0, 3)
        .toUpperCase();

      const townObj = {
        id: world.towns.length,
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

      // Immediately connect world newly nucleated town into the growing trunk road network
      // so subsequent towns & hamlets can also nucleate along its branch road & river bridges!
      if (world.roadGrid[world.idx(townObj.x, townObj.y)] === 0) {
        const tp = bestPt.nearTrunkPt;
        let path = tp
          ? world.findRoadPathAStar(
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
          let nearestTarget = world.towns[0];
          let minD = Infinity;
          for (const other of world.towns) {
            const sameLm = other.landmassId === townObj.landmassId;
            if (isIslandHopper && !sameLm) continue;
            const d = Math.hypot(other.x - townObj.x, other.y - townObj.y);
            if (d < minD) {
              minD = d;
              nearestTarget = other;
            }
          }
          if (nearestTarget) {
            path = world.findRoadPathAStar(
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
          world.commitRoadPath(path, "arterial");
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

      world.towns.push(townObj);
      newTowns.push(townObj);
    }
  }

  // 3. Carve local street grids for the newly nucleated Tier-3 & Tier-4 towns around their trunk connection!
  world.carveTownStreetGrids((t) => !t._seededInPhase1);

  world.logs.push(
    `Co-evolved <b>${world.towns.length} settlements</b> (${newTowns.length} bridgehead/crossroads towns nucleated along <b>${world.roads.length} trunk roads</b> & <b>${world.bridgeCount} bridges</b>).`,
  );
}

export function findRoadPathAStar(
  world,
  sx,
  sy,
  ex,
  ey,
  allowWaterBridge = true,
  blockedFn = null,
  stopOnExistingRoad = false,
  options = null,
) {
  const { W, H } = world;
  const isInterchangeBypass = Boolean(options && options.isInterchangeBypass);
  const customTurnPenalty =
    options && options.turnPenalty !== undefined ? options.turnPenalty : null;
  const extraCostFn =
    options && options.extraCostFn ? options.extraCostFn : null;
  const startId = world.idx(sx, sy);
  const endId = world.idx(ex, ey);
  const gen = ++world._astarGen;
  const gScore = world._astarG;
  const parent = world._astarParent;
  const seenGen = world._astarSeenGen;
  const closedGen = world._astarClosedGen;

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
    const distFromStart = Math.hypot((cid % W) - sx, Math.floor(cid / W) - sy);
    if (
      cid === endId ||
      (stopOnExistingRoad &&
        distFromStart >= 3.0 &&
        world.buildingMask[cid] !== 4 &&
        (world.roadGrid[cid] === 1 || world.roadGrid[cid] === 2))
    ) {
      const path = [];
      let trace = cid;
      while (trace !== -1) {
        const py = Math.floor(trace / W);
        const px = trace % W;
        path.push({ x: px, y: py, isBridge: world.waterMask[trace] > 0 });
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
    const currIsWater = world.waterMask[cid] > 0;

    for (const [dx, dy, baseStep] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!world.inBounds(nx, ny, 3)) continue;
      const nid = world.idx(nx, ny);
      if (closedGen[nid] === gen) continue;

      // Never tunnel through any placed building (house, commercial/industrial lot, or airport runway!)
      if (world.buildingMask[nid] >= 1 && world.buildingMask[nid] <= 3) {
        continue;
      }
      if (blockedFn && nid !== startId && blockedFn(nx, ny, cx, cy)) continue;

      const isWater = world.waterMask[nid] > 0;
      if (isWater && !allowWaterBridge) continue;

      // Inside urban town zones (`zoneColorIdx >= 0`) or adjacent to buildings, strictly enforce
      // orthogonal (0°/90°) movement so city streets never slice 45° diagonal wedges across orthogonal
      // blocks or clip building corners, while rural roads (`zoneColorIdx === -1`) and interchange
      // bypass rings (`buildingMask === 4`) can freely take 45° diagonal steps!
      const c1Id = world.idx(cx + dx, cy);
      const c2Id = world.idx(cx, cy + dy);
      const inInterchangeRing =
        isInterchangeBypass ||
        (world.buildingMask[cid] === 4 && world.buildingMask[nid] === 4);
      if (
        dx !== 0 &&
        dy !== 0 &&
        !world.hasRoadEdge(cx, cy, nx, ny) &&
        ((!inInterchangeRing &&
          (world.zoneColorIdx[cid] >= 0 ||
            world.zoneColorIdx[nid] >= 0 ||
            world.zoneColorIdx[c1Id] >= 0 ||
            world.zoneColorIdx[c2Id] >= 0)) ||
          (world.buildingMask[c1Id] >= 1 && world.buildingMask[c1Id] <= 3) ||
          (world.buildingMask[c2Id] >= 1 && world.buildingMask[c2Id] <= 3))
      ) {
        continue;
      }

      let stepCost = baseStep;
      if (world.hasRoadEdge(cx, cy, nx, ny)) {
        stepCost *= 0.06;
      } else if (world.roadGrid[nid] > 0) {
        stepCost *= world.roadGrid[cid] === 0 ? 0.35 : 0.65;
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
                world.roadGrid[rowOff + bx] === 3
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
        if (world.waterMask[nid] === 1) {
          let crossesToBank = false;
          for (let s = 1; s <= 5; s++) {
            const bx = nx + dx * s;
            const by = ny + dy * s;
            if (
              world.inBounds(bx, by, 1) &&
              world.waterMask[world.idx(bx, by)] === 0
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
              world.inBounds(bx, by, 1) &&
              world.waterMask[world.idx(bx, by)] === 0
            ) {
              crossesNarrowBay = true;
              break;
            }
          }
          stepCost *= crossesNarrowBay
            ? 24.0
            : world.config.archetype === "island-hopper"
              ? 38.0
              : 95.0;
        }
        if (currIsWater && pid !== -1 && (dx !== prevDx || dy !== prevDy)) {
          stepCost += 85.0;
        }
      } else {
        // Never wrap a road in a tight U-loop around an interior mountain spring headwater (`r.headwaterPt`)!
        for (const rObj of world.rivers) {
          if (
            rObj.headwaterPt &&
            Math.hypot(nx - rObj.headwaterPt.x, ny - rObj.headwaterPt.y) <
              WORLD_GEOMETRY.ELEVATION_THRESHOLDS.headwaterRoadExclusion
          ) {
            stepCost += 65.0;
            break;
          }
        }
        // Keep dry-land arterials set back from the 1-tile cream riverbank border
        const dW = world.distToWater[nid];
        if (dW < 2.5 && !currIsWater) {
          stepCost += (2.6 - dW) * 2.5;
        }
        // Topographic valley-following & contour-hugging cost:
        // Penalize both uphill and downhill grade nonlinearly (`absDeltaElev^2`) and strongly penalize
        // climbing onto upland contour terraces (`hAbove > 0.105`) so roads hug valley floors around hills!
        const hAbove = Math.max(0, world.elevationField[nid] - world.seaLevel);
        const uplandOver = Math.max(0, hAbove - 0.105);
        const absDeltaElev =
          Math.abs(world.elevationField[nid] - world.elevationField[cid]) /
          baseStep;
        const terraceStepPenalty = hAbove >= 0.115 ? 5.5 : 0;
        const gradeCost =
          absDeltaElev * 64.0 +
          absDeltaElev * absDeltaElev * 1350.0 +
          world.slopeField[nid] * 22.0 +
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
          world.zoneColorIdx[nid] < 0 &&
          !isInterchangeBypass &&
          world.noise
        ) {
          const meanderMod =
            (world.noise.fbm(nx * 0.048 + 1.9, ny * 0.048 + 6.2, 2) + 0.45) *
            0.68;
          stepCost += Math.max(0, meanderMod);
        }
        // Strongly prefer existing orthogonal streets inside urban zones
        if (
          world.zoneColorIdx[nid] >= 0 &&
          !isInterchangeBypass &&
          world.buildingMask[nid] !== 4
        ) {
          stepCost *= 4.5;
        }
        // Universal Parallel-Road Inhibition (rural + urban): when off-road (`roadGrid[cid] === 0 && roadGrid[nid] === 0`),
        // penalize running parallel within 1..3 tiles of an existing road so nearby routes merge into a shared trunk.
        if (
          world.roadGrid[cid] === 0 &&
          !isInterchangeBypass &&
          world.buildingMask[nid] !== 4
        ) {
          const pnx = -dy;
          const pny = dx;
          let parallelPenalty = 0;
          for (const s of [-3, -2, -1, 1, 2, 3]) {
            const sx2 = nx + pnx * s;
            const sy2 = ny + pny * s;
            if (
              world.inBounds(sx2, sy2, 1) &&
              world.roadGrid[world.idx(sx2, sy2)] > 0
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
            world.zoneColorIdx[cid] >= 0 || world.zoneColorIdx[nid] >= 0;
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

export function commitRoadPath(
  world,
  path,
  roadType = "arterial",
  extraProps = null,
) {
  if (!path || path.length < 2) return;

  const isNearAnyTownEnvelope = (x, y) => {
    for (const t of world.towns) {
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

  // Collapse 1-tile rural staircase jogs BEFORE writing `world.roadGrid`:
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
        world.airports.some((a) => a.gateX === curr.x && a.gateY === curr.y) ||
        world.interchanges.some((ic) => ic.x === curr.x && ic.y === curr.y);
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
        const pid = world.idx(prev.x, prev.y);
        const cid = world.idx(curr.x, curr.y);
        const nid = world.idx(next.x, next.y);
        const c1Id = world.idx(prev.x, next.y);
        const c2Id = world.idx(next.x, prev.y);
        const isBypassRing =
          (world.buildingMask[pid] === 4 ||
            world.buildingMask[cid] === 4 ||
            world.buildingMask[nid] === 4) &&
          (world.buildingMask[pid] === 0 || world.buildingMask[pid] === 4) &&
          (world.buildingMask[cid] === 0 || world.buildingMask[cid] === 4) &&
          (world.buildingMask[nid] === 0 || world.buildingMask[nid] === 4) &&
          (world.buildingMask[c1Id] === 0 || world.buildingMask[c1Id] === 4) &&
          (world.buildingMask[c2Id] === 0 || world.buildingMask[c2Id] === 4);

        if (
          world.roadGrid[cid] === 0 &&
          world.waterMask[c1Id] === 0 &&
          world.waterMask[c2Id] === 0 &&
          (isBypassRing ||
            (world.zoneColorIdx[pid] < 0 &&
              world.zoneColorIdx[cid] < 0 &&
              world.zoneColorIdx[nid] < 0 &&
              world.zoneColorIdx[c1Id] < 0 &&
              world.zoneColorIdx[c2Id] < 0 &&
              world.buildingMask[pid] === 0 &&
              world.buildingMask[cid] === 0 &&
              world.buildingMask[nid] === 0 &&
              world.buildingMask[c1Id] === 0 &&
              world.buildingMask[c2Id] === 0 &&
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
    world.anchorStreetToArterialCore(
      Math.round(pts[0].x),
      Math.round(pts[0].y),
    );
    world.anchorStreetToArterialCore(
      Math.round(pts[pts.length - 1].x),
      Math.round(pts[pts.length - 1].y),
    );
  }

  // Emit contiguous spans of new edges (`!world.hasRoadEdge(p0, p1)`) so every new step
  // between two existing roads is preserved while shared trunk edges are never double-drawn!
  let seg = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const x0 = Math.round(p0.x),
      y0 = Math.round(p0.y);
    const x1 = Math.round(p1.x),
      y1 = Math.round(p1.y);
    if (!world.hasRoadEdge(x0, y0, x1, y1)) {
      if (seg.length === 0) seg.push({ ...p0, x: x0, y: y0 });
      seg.push({ ...p1, x: x1, y: y1 });
      world.addRoadEdge(x0, y0, x1, y1);
    } else {
      if (seg.length >= 2) {
        world.roads.push({ points: seg, type: roadType, ...extraProps });
      }
      seg = [];
    }
  }
  if (seg.length >= 2) {
    world.roads.push({ points: seg, type: roadType, ...extraProps });
  }

  // Populate `world.roadGrid` exclusively from the simplified vertices (`pts`) so zero ghost road tiles exist!
  let inBridge = false;
  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i];
    const id = world.idx(Math.round(pt.x), Math.round(pt.y));
    if (pt.isBridge) {
      if (!inBridge && world.roadGrid[id] !== ROAD_GRID.BRIDGE) {
        world.bridgeCount++;
        inBridge = true;
      }
      world.roadGrid[id] = ROAD_GRID.BRIDGE;
    } else {
      inBridge = false;
      if (world.roadGrid[id] === ROAD_GRID.NONE) {
        world.roadGrid[id] =
          roadType === "street" ? ROAD_GRID.STREET : ROAD_GRID.ARTERIAL;
      } else if (
        world.roadGrid[id] === ROAD_GRID.STREET &&
        roadType === "arterial"
      ) {
        world.roadGrid[id] = ROAD_GRID.ARTERIAL;
      }
    }
  }
}

/*************************************************************************
 * STAGE 6A & 7: ORGANIC MULTI-BOROUGH GRIDS, VARIED BLOCK SIZES & RCI PACKER
 *************************************************************************/
export function carveTownStreetGrids(world, filterFn = null) {
  const densityMult = (world.config.buildingDensity || 250) / 100;

  for (const town of world.towns) {
    if (filterFn && !filterFn(town)) continue;
    const R = Math.round(
      town.urbanRadius * (0.78 + 0.18 * Math.sqrt(densityMult)),
    );
    const townElev = world.elevationField[world.idx(town.x, town.y)];
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
          (a / 16) * Math.PI * 2 + b * 0.45 + world.rng.range(-0.12, 0.12);
        const dist = Math.round(R * world.rng.range(0.54, 0.88));
        const cx = town.x + Math.round(Math.cos(ang) * dist);
        const cy = town.y + Math.round(Math.sin(ang) * dist);
        if (!world.inBounds(cx, cy, 8)) continue;
        const cid = world.idx(cx, cy);
        if (
          world.waterMask[cid] > 0 ||
          world.buildingMask[cid] === 3 ||
          world.distToWater[cid] < 2.0
        )
          continue;
        if (
          world.slopeField[cid] > 0.38 ||
          Math.abs(world.elevationField[cid] - townElev) > 0.14
        )
          continue;
        if (boroughs.some((eb) => Math.hypot(eb.x - cx, eb.y - cy) < R * 0.44))
          continue;

        let crossesRiver = false;
        for (let s = 1; s < 8; s++) {
          const mx = Math.round(town.x + (cx - town.x) * (s / 8));
          const my = Math.round(town.y + (cy - town.y) * (s / 8));
          if (
            world.inBounds(mx, my, 1) &&
            world.waterMask[world.idx(mx, my)] === 1
          ) {
            crossesRiver = true;
            break;
          }
        }
        const score =
          world.urbanSuitability[cid] +
          (crossesRiver ? 0.38 : 0) +
          world.rng.range(-0.05, 0.05);
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
            stepChoice = isCBD && world.rng.next() < 0.65 ? 3 : 4;
          } else if (idx === 1) {
            stepChoice = world.rng.next() < 0.5 ? 3 : 4;
          } else {
            const r = world.rng.next();
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
      const brElev = world.elevationField[world.idx(br.x, br.y)];

      for (let dy = -bR - 2; dy <= bR + 2; dy++) {
        for (let dx = -bR - 2; dx <= bR + 2; dx++) {
          const gx = br.x + dx;
          const gy = br.y + dy;
          if (!world.inBounds(gx, gy, 2)) continue;
          const id = world.idx(gx, gy);
          if (world.waterMask[id] > 0) continue;
          const isIH = world.config.archetype === "island-hopper";
          const elevPenalty =
            Math.max(0, world.elevationField[id] - brElev) *
              (isIH ? 14.0 : 30.0) +
            world.slopeField[id] * (isIH ? 5.0 : 11.0);
          const nJitter = world.noise.fbm(gx * 0.11, gy * 0.11, 2) * 3.8;
          const d = Math.hypot(dx, dy) + elevPenalty + nJitter;
          if (d <= bR + 1.2) {
            world.zoneColorIdx[id] = town.colorIdx;
          }
        }
      }

      // Carve primary borough cross-avenues as arterial boulevards (`roadGrid = 2`)
      const mainNegX = Math.round(bR * world.rng.range(0.75, 1.02));
      const mainPosX = Math.round(bR * world.rng.range(0.75, 1.02));
      const mainNegY = Math.round(bR * world.rng.range(0.75, 1.02));
      const mainPosY = Math.round(bR * world.rng.range(0.75, 1.02));
      world.carveStreetFromCenter(
        br.x,
        br.y,
        1,
        0,
        mainNegX,
        mainPosX,
        br.isMainCBD,
      );
      world.carveStreetFromCenter(
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
          if (pass === 1 && world.rng.next() < 0.25) continue;
          const chord = Math.sqrt(Math.max(0, bR * bR - dyOff * dyOff));
          // Asymmetric street spans & occasional one-sided T-intersections for organic neighborhood structure!
          const oneSided = Math.abs(dyOff) > 4 && world.rng.next() < 0.28;
          const negSpan =
            oneSided && world.rng.next() < 0.5
              ? 0
              : Math.floor(chord * world.rng.range(0.48, 0.96));
          const posSpan =
            oneSided && negSpan > 0 && world.rng.next() < 0.5
              ? 0
              : Math.floor(chord * world.rng.range(0.48, 0.96));
          const yRow = br.y + dyOff;
          for (const probeOff of [0, ...xOffsets]) {
            const probeX = br.x + probeOff;
            if (
              Math.abs(probeOff) <= Math.max(negSpan, posSpan) &&
              world.inBounds(probeX, yRow, 4) &&
              world.roadGrid[world.idx(probeX, yRow)] > 0
            ) {
              world.carveStreetFromCenter(
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
          if (pass === 1 && world.rng.next() < 0.25) continue;
          const chord = Math.sqrt(Math.max(0, bR * bR - dxOff * dxOff));
          const oneSided = Math.abs(dxOff) > 4 && world.rng.next() < 0.28;
          const negSpan =
            oneSided && world.rng.next() < 0.5
              ? 0
              : Math.floor(chord * world.rng.range(0.48, 0.96));
          const posSpan =
            oneSided && negSpan > 0 && world.rng.next() < 0.5
              ? 0
              : Math.floor(chord * world.rng.range(0.48, 0.96));
          const xCol = br.x + dxOff;
          for (const probeOff of [0, ...yOffsets]) {
            const probeY = br.y + probeOff;
            if (
              Math.abs(probeOff) <= Math.max(negSpan, posSpan) &&
              world.inBounds(xCol, probeY, 4) &&
              world.roadGrid[world.idx(xCol, probeY)] > 0
            ) {
              world.carveStreetFromCenter(
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
      const linkPath = world.findRoadPathAStar(
        br.x,
        br.y,
        town.x,
        town.y,
        true,
      );
      if (linkPath) world.commitRoadPath(linkPath, "arterial");
    }
  }
}

export function growUrbanFabric(world) {
  const densityMult = (world.config.buildingDensity || 250) / 100;

  for (const town of world.towns) {
    const R =
      town.effectiveR ||
      Math.round(town.urbanRadius * (0.78 + 0.18 * Math.sqrt(densityMult)));

    // 7A. Place Differentiated Commercial (CBD & Arterial) and Industrial (Peripheral / Freight) Multi-Size Sinks
    world.placeTownCommercialAndIndustrial(town, R, densityMult);

    // 7B. Place Residential Houses with Organic Sparseness, Yard Breathing Room & Dimensional Variation
    const baseHouses =
      town.tier === 1 ? 66 : town.tier === 2 ? 34 : town.tier === 3 ? 16 : 7;
    const targetHouses = Math.max(4, Math.round(baseHouses * densityMult));
    world.tryPlaceNeighborhoodHouses(town, targetHouses, R);
  }

  // 7B-2. Seed Out-of-Town Geographic Resource Niches (`MINE` Quarries, `TIMBER` Forestry Camps, `FARM` Agribusiness)
  //       with dedicated rural haul roads BEFORE outer street pruning so contacted streets remain anchored!
  world.seedOutOfTownResourceNiches();

  // 7C. Trim far-flung empty street tails while preserving natural neighborhood block loops
  world.pruneEmptyOuterStreets();
}

/**
 * STAGE 7B-2: OUT-OF-TOWN GEOGRAPHIC RESOURCE NICHES (OpenTTD / Transport Fever 2)
 * Places primary `RAW` extraction facilities (`MINE`, `TIMBER`, `FARM`) out in their authentic
 * physical terrain niches outside urban zones and connects each with a short rural haul road
 * to the regional trunk network so freight trucks haul raw materials into town `MFG` factories.
 */
export function seedOutOfTownResourceNiches(world) {
  const isIslandHopper = world.config.archetype === "island-hopper";
  const targetSites = Math.min(
    10,
    Math.max(5, Math.round(world.towns.length * 0.36)),
  );

  // Collect rural arterial/street road tiles (`roadGrid >= 1`) as haul-road targets
  const roadTargets = [];
  for (let y = 10; y < world.H - 10; y += 2) {
    for (let x = 10; x < world.W - 10; x += 2) {
      const id = world.idx(x, y);
      if (
        (world.roadGrid[id] === 1 || world.roadGrid[id] === 2) &&
        world.waterMask[id] === 0
      ) {
        roadTargets.push({ x, y });
      }
    }
  }
  if (roadTargets.length === 0) return;

  const candidates = [];
  for (let gy = 14; gy < world.H - 16; gy += 3) {
    for (let gx = 14; gx < world.W - 16; gx += 3) {
      // Check a 2×2 building pad + 2-tile clearance margin for dry land, zero roads/buildings, and outside urban blush
      let padOk = true;
      for (let dy = -2; dy <= 3 && padOk; dy++) {
        for (let dx = -2; dx <= 3; dx++) {
          const px = gx + dx,
            py = gy + dy;
          if (!world.inBounds(px, py, 4)) {
            padOk = false;
            break;
          }
          const pid = world.idx(px, py);
          if (
            world.waterMask[pid] > 0 ||
            world.buildingMask[pid] > 0 ||
            world.roadGrid[pid] > 0 ||
            world.zoneColorIdx[pid] >= 0 ||
            world.distToWater[pid] < 3.2
          ) {
            padOk = false;
            break;
          }
        }
      }
      if (!padOk) continue;

      const cx = gx + 0.5;
      const cy = gy + 0.5;
      if (world.isPointInAirportPad(cx, cy, 7.0)) continue;

      // Require clear rural separation outside town urban radii (`>= urbanRadius + 4.5`)
      let nearestTown = null;
      let minTownDist = Infinity;
      let tooCloseToTown = false;
      for (const t of world.towns) {
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

      const id = world.idx(gx, gy);
      const hAbove = Math.max(0, world.elevationField[id] - world.seaLevel);
      const slope = world.slopeField[id];
      const fert = world.fertilityField[id];
      const dW = world.distToWater[id];

      // Evaluate fitness for the 3 geographic resource niches:
      // 1. `MINE` (Foothill Quarry & Mine): elevated ridge toes & canyon mouths (`hAbove >= 0.115`)
      // 2. `TIMBER` (Upland Forestry Camp): moist wooded hills (`hAbove >= 0.085`, high `fertilityField`)
      // 3. `FARM` (Alluvial Agribusiness): flat fertile valley floors (`hAbove <= 0.085`, low `slope`)
      let resourceType = null;
      let nicheScore = -1;

      if (hAbove >= 0.115 && hAbove <= 0.28 && slope >= 0.06 && slope <= 0.36) {
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
        nicheScore: nicheScore + world.rng.range(-0.06, 0.06),
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
            const lid = world.idx(cand.gx + dx, cand.gy + dy);
            if (world.buildingMask[lid] > 0 || world.roadGrid[lid] > 0) {
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
        const haulPath = world.findRoadPathAStar(
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

    world.commitRoadPath(chosenHaulPath, "arterial");
    const contactPt = chosenHaulPath[chosenHaulPath.length - 1];
    world.anchorStreetToArterialCore(
      Math.round(contactPt.x),
      Math.round(contactPt.y),
    );

    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        world.buildingMask[world.idx(chosenCand.gx + dx, chosenCand.gy + dy)] =
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
    /** @type {{ minX: number, minY: number, maxX: number, maxY: number } | undefined} */
    let estateBBox = undefined;
    if (chosenCand.resourceType === "FARM") {
      const estate = world.buildFarmEstate(
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
      estateBBox = estate.estateBBox;
    }

    const hostTown = chosenCand.nearestTown;
    const colorIdx = (hostTown.colorIdx + 1) % PALETTE.districtColors.length;
    world.destinations.push({
      id: world.destinations.length,
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
      estateBBox,
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

export function pruneEmptyOuterStreets(world) {
  const { W, H } = world;
  const size = W * H;
  const frontageMask = new Uint8Array(size);

  for (const h of world.houses) {
    const rx = Math.round(h.roadX),
      ry = Math.round(h.roadY);
    if (world.inBounds(rx, ry, 1)) frontageMask[world.idx(rx, ry)] = 1;
  }
  for (const d of world.destinations) {
    const rx = Math.round(d.roadX),
      ry = Math.round(d.roadY);
    if (world.inBounds(rx, ry, 1)) frontageMask[world.idx(rx, ry)] = 1;
    const wT = d.wTiles || 2;
    const hT = d.hTiles || 2;
    for (let dy = -1; dy <= hT; dy++) {
      for (let dx = -1; dx <= wT; dx++) {
        const px = d.gx + dx,
          py = d.gy + dy;
        if (world.inBounds(px, py, 1)) frontageMask[world.idx(px, py)] = 1;
      }
    }
  }

  const hasNearbyBuilding = (x, y) => {
    if (!world.inBounds(x, y, 1)) return false;
    return frontageMask[world.idx(x, y)] === 1;
  };

  // Multi-source BFS from town centers & main boulevards along `world.roadEdges`
  // so every street vertex serving a building OR touched by an arterial/stub connector traces
  // its entire street path (`keepMask[cur] = 1`) back to the town core!
  const keepMask = new Uint8Array(size);
  const arterialTouch = new Uint8Array(size);
  const parent = world._astarParent;
  const seenGen = world._astarSeenGen;
  const gen = ++world._astarGen;
  const queue = [];

  const seedRoot = (gx, gy) => {
    if (!world.inBounds(gx, gy, 1)) return;
    const id = world.idx(gx, gy);
    if (seenGen[id] !== gen) {
      seenGen[id] = gen;
      parent[id] = -1;
      keepMask[id] = 1;
      queue.push(id);
    }
  };

  for (const t of world.towns) {
    seedRoot(t.x, t.y);
  }
  for (const ic of world.interchanges) {
    if (ic.type === "terminal-stub") {
      const gx = Math.round(ic.x),
        gy = Math.round(ic.y);
      if (world.inBounds(gx, gy, 1)) arterialTouch[world.idx(gx, gy)] = 1;
    } else if (ic.type === "diamond-ramp") {
      for (const term of [
        ic.posTerm,
        ic.negTerm,
        { x: ic.connectX, y: ic.connectY },
      ]) {
        if (term && term.x !== undefined && term.y !== undefined) {
          const gx = Math.round(term.x),
            gy = Math.round(term.y);
          if (world.inBounds(gx, gy, 1)) arterialTouch[world.idx(gx, gy)] = 1;
        }
      }
    }
  }
  for (const r of world.roads) {
    if (r.type !== "street" && !r.isMainBoulevard) {
      for (const pt of r.points) {
        const gx = Math.round(pt.x),
          gy = Math.round(pt.y);
        if (world.inBounds(gx, gy, 1)) {
          arterialTouch[world.idx(gx, gy)] = 1;
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
      if (!world.inBounds(nx, ny, 1)) continue;
      if (!world.hasRoadEdge(cx, cy, nx, ny)) continue;
      const nid = world.idx(nx, ny);
      if (seenGen[nid] === gen) continue;
      seenGen[nid] = gen;
      parent[nid] = cid;
      queue.push(nid);
    }
  }

  for (const r of world.roads) {
    if (r.type !== "street" && !r.isMainBoulevard) continue;
    for (const pt of r.points) {
      const gx = Math.round(pt.x);
      const gy = Math.round(pt.y);
      if (!world.inBounds(gx, gy, 1)) continue;
      const id = world.idx(gx, gy);
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
  for (const r of world.roads) {
    if (r.type !== "street" && !r.isMainBoulevard) {
      cleanedRoads.push(r);
      continue;
    }
    const pts = r.points;
    const isVertexAnchored = (pt) => {
      const gx = Math.round(pt.x);
      const gy = Math.round(pt.y);
      const id = world.idx(gx, gy);
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
  const reachable = new Uint8Array(world.W * world.H);
  const rQueue = [];
  for (let y = 0; y < world.H; y++) {
    for (let x = 0; x < world.W; x++) {
      const id = world.idx(x, y);
      if (world.roadGrid[id] >= 2) {
        reachable[id] = 1;
        rQueue.push(x, y);
      }
    }
  }
  for (const t of world.towns) {
    const tid = world.idx(t.x, t.y);
    if (world.roadGrid[tid] > 0 && !reachable[tid]) {
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
      if (!world.inBounds(nx, ny, 1)) continue;
      const nid = world.idx(nx, ny);
      if (world.roadGrid[nid] > 0 && !reachable[nid]) {
        reachable[nid] = 1;
        rQueue.push(nx, ny);
      }
    }
  }

  world.roads = cleanedRoads.filter((r) => {
    if (r.type !== "street") return true;
    return r.points.some(
      (pt) => reachable[world.idx(Math.round(pt.x), Math.round(pt.y))] === 1,
    );
  });
  world.rebuildRoadGridAndEdges();
}

/**
 * Carves a street line starting at `(cx, cy)` and marching outward in both `-dir` and `+dir`,
 * stopping upon hitting water, steep hillsides, an airport pad, or a parallel street within 2 tiles
 * so multi-phase borough grids meet cleanly at T-junctions without 1-tile slivers.
 */
export function carveStreetFromCenter(
  world,
  cx,
  cy,
  ux,
  uy,
  negSteps,
  posSteps,
  isMainBoulevard = false,
) {
  const baseElev = world.inBounds(cx, cy, 1)
    ? world.elevationField[world.idx(cx, cy)]
    : world.seaLevel;
  const nx = -uy;
  const ny = ux;

  if (
    world.inBounds(cx + ux, cy + uy, 2) &&
    world.inBounds(cx - ux, cy - uy, 2) &&
    world.roadGrid[world.idx(cx, cy)] > 0 &&
    (world.roadGrid[world.idx(cx + ux, cy + uy)] > 0 ||
      world.roadGrid[world.idx(cx - ux, cy - uy)] > 0)
  ) {
    if (isMainBoulevard) {
      world.roadGrid[world.idx(cx, cy)] = 2;
    }
    return;
  }

  // Enforce a strict >= 2-tile clear block gap (`|s| >= 3`) between parallel streets across all boroughs
  const hasParallelNeighbor = (x, y) => {
    for (const s of [-2, -1, 1, 2]) {
      const px = x + nx * s;
      const py = y + ny * s;
      if (!world.inBounds(px, py, 2)) continue;
      // Check a 5-tile window `t in [-2..2]` along `(ux, uy)`: if any two consecutive tiles have roadGrid > 0,
      // there is a parallel street at sideways distance `s`!
      let prevHasRoad = false;
      for (let t = -2; t <= 2; t++) {
        const tx = px + ux * t;
        const ty = py + uy * t;
        const hasR =
          world.inBounds(tx, ty, 1) && world.roadGrid[world.idx(tx, ty)] > 0;
        if (hasR && prevHasRoad) return true;
        if (
          Math.abs(s) === 1 &&
          hasR &&
          t === 0 &&
          world.roadGrid[world.idx(x, y)] === 0
        )
          return true;
        prevHasRoad = hasR;
      }
    }
    return false;
  };

  const isIH = world.config.archetype === "island-hopper";
  const isPassable = (x, y) => {
    if (!world.inBounds(x, y, 3)) return false;
    const id = world.idx(x, y);
    if (
      world.waterMask[id] !== 0 ||
      world.buildingMask[id] !== 0 ||
      world.distToWater[id] < 2.35
    )
      return false;
    if (
      world.slopeField[id] > (isIH ? 0.58 : 0.46) ||
      world.elevationField[id] - baseElev > (isIH ? 0.22 : 0.14)
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
      const id = world.idx(pt.x, pt.y);
      if (isMainBoulevard) {
        world.roadGrid[id] = 2;
      } else if (world.roadGrid[id] === 0) {
        world.roadGrid[id] = 1;
      }
      if (i < pts.length - 1) {
        world.addRoadEdge(pt.x, pt.y, pts[i + 1].x, pts[i + 1].y);
      }
    }
    world.roads.push({
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
export function placeTownCommercialAndIndustrial(world, town, R, densityMult) {
  const boroughs =
    town.boroughs && town.boroughs.length > 0
      ? town.boroughs
      : [{ x: town.x, y: town.y, r: R }];

  const isIH = world.config.archetype === "island-hopper";
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
  const indSectorAngle = world.rng.range(0, Math.PI * 2);
  const indDirX = Math.cos(indSectorAngle);
  const indDirY = Math.sin(indSectorAngle);

  const scanR = R + 5;
  const evaluateFootprint = (gx, gy, wTiles, hTiles) => {
    if (
      !world.inBounds(gx, gy, 5) ||
      !world.inBounds(gx + wTiles - 1, gy + hTiles - 1, 5)
    )
      return null;
    for (let dy = 0; dy < hTiles; dy++) {
      for (let dx = 0; dx < wTiles; dx++) {
        const id = world.idx(gx + dx, gy + dy);
        if (
          world.waterMask[id] > 0 ||
          world.buildingMask[id] > 0 ||
          world.roadGrid[id] > 0 ||
          world.distToWater[id] < 2.35 ||
          world.isPointInAirportPad(gx + dx, gy + dy, 2.0)
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
        const rg = world.roadGrid[world.idx(rx, ry)];
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
        const rg = world.roadGrid[world.idx(rx, ry)];
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
      world.noise.fbm(cx * 0.09 + 1.7, cy * 0.09 + 4.3, 2) * 11.5;

    const cbdScore =
      (touchesArterial ? 22.0 + arterialCount * 3.8 : streetCount * 1.4) -
      minBrDist * 2.1 -
      distTownCenter * 0.75 +
      transitionNoise +
      world.rng.range(-3.2, 3.2);

    const vecLen = Math.max(1, distTownCenter);
    const sectorAlign =
      ((cx - town.x) * indDirX + (cy - town.y) * indDirY) / vecLen;
    const dW = world.distToWater[world.idx(gx, gy)];
    const indRingBonus =
      minBrDist >= R * (0.34 + world.rng.range(-0.08, 0.1)) ? 16.0 : -18.0;
    const indScore =
      indRingBonus +
      minBrDist * 1.15 +
      sectorAlign * 9.5 +
      (touchesArterial ? 13.5 : 0) +
      (dW < 6.5 ? 7.0 : 0) -
      transitionNoise * 0.6 +
      world.rng.range(-3.0, 3.0);

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
        if (world.buildingMask[world.idx(cand.gx + dx, cand.gy + dy)] > 0)
          return false;
      }
    }
    for (const d of world.destinations) {
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
        const lid = world.idx(cand.gx + dx, cand.gy + dy);
        world.buildingMask[lid] = 2;
        world.zoneColorIdx[lid] = town.colorIdx;
      }
    }
    const colorIdx =
      zoneType === "commercial"
        ? town.colorIdx
        : (town.colorIdx + 1) % PALETTE.districtColors.length;
    const area = cand.wTiles * cand.hTiles;

    world.destinations.push({
      id: world.destinations.length,
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
      hasUrgentPin: world.rng.next() < 0.16,
      pinsCount:
        area >= 6
          ? world.rng.int(5, 7)
          : area === 4
            ? world.rng.int(3, 5)
            : world.rng.int(2, 3),
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
      (placedCom === 0 || (cand.minBrDist < 4.5 && world.rng.next() < 0.45));
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
  const indRectSorted = [...slotsRect].sort((a, b) => b.indScore - a.indScore);
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
      (indRole === "MFG" || indRole === "LOG") && world.rng.next() < 0.75;
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

export function tryPlaceNeighborhoodHouses(
  world,
  town,
  targetHouses,
  customRadius = null,
) {
  const boroughs =
    town.boroughs && town.boroughs.length > 0
      ? town.boroughs
      : [{ x: town.x, y: town.y, r: customRadius || town.urbanRadius }];
  const secondaryColorIdx = (town.colorIdx + 2) % PALETTE.districtColors.length;
  const clusterOffset = {
    x: town.x + world.rng.range(-8, 8),
    y: town.y + world.rng.range(-8, 8),
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
      if (!world.inBounds(gx, gy, 3)) continue;
      const id = world.idx(gx, gy);
      if (
        world.waterMask[id] > 0 ||
        world.buildingMask[id] > 0 ||
        world.roadGrid[id] > 0 ||
        world.distToWater[id] < 2.35
      )
        continue;
      if (world.zoneColorIdx[id] !== town.colorIdx) continue;

      let driveway = null;
      for (const [dx, dy] of dirs) {
        const rx = gx + dx;
        const ry = gy + dy;
        const rid = world.idx(rx, ry);
        if (world.roadGrid[rid] === 1 || world.roadGrid[rid] === 2) {
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
        world.noise.fbm(gx * 0.14 + 5.2, gy * 0.14 + 2.9, 2) * 5.5;
      const priority = minBrDist + patchNoise + world.rng.range(0, 6.5);
      houseSlots.push({ gx, gy, id, driveway, minBrDist, priority });
    }
  }

  houseSlots.sort((a, b) => a.priority - b.priority);

  const countAdjacentHouses = (gx, gy) => {
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (world.buildingMask[world.idx(gx + dx, gy + dy)] === 1) count++;
      }
    }
    return count;
  };

  for (const slot of houseSlots) {
    if (town.housesCount >= targetHouses) break;
    if (world.buildingMask[slot.id] > 0 || world.roadGrid[slot.id] > 0)
      continue;

    // Prevent 4-house "waffle blocks": leave yard/courtyard breathing room inside blocks!
    const adj = countAdjacentHouses(slot.gx, slot.gy);
    const radialFrac = Math.min(1, slot.minBrDist / Math.max(6, scanR));
    if (adj >= 3) continue;
    if (adj === 2 && world.rng.next() < 0.72) continue;
    if (adj === 1 && world.rng.next() < 0.25 + radialFrac * 0.35) continue;

    world.buildingMask[slot.id] = 1;
    const useSecondary =
      Math.hypot(slot.gx - clusterOffset.x, slot.gy - clusterOffset.y) <
      scanR * 0.36;
    const colorIdx = useSecondary ? secondaryColorIdx : town.colorIdx;

    // Dimensional variation for individual houses (cottages, L-townhouses, varied setbacks)
    const wScale = world.rng.range(0.6, 0.84);
    const hScale = world.rng.range(0.6, 0.84);
    const offX = world.rng.range(-0.08, 0.08);
    const offY = world.rng.range(-0.08, 0.08);

    world.houses.push({
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

export function populateLandscapeTrees(world) {
  const isIslandHopper = world.config.archetype === "island-hopper";
  // Keep woodland tree canopies strictly clear of farm fields (`buildingMask === 5`) and farm roads (`tractorTracks`)
  const isNearFarmOrTrack = (tx, ty) => {
    const gx = Math.round(tx),
      gy = Math.round(ty);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (
          world.inBounds(gx + dx, gy + dy, 1) &&
          world.buildingMask[world.idx(gx + dx, gy + dy)] ===
            BUILDING_MASK.FARM_FIELD
        ) {
          return true;
        }
      }
    }
    for (const d of world.destinations) {
      if (d.resourceType !== "FARM" || !d.tractorTracks) continue;
      for (const tr of d.tractorTracks) {
        const sdx = tr.x1 - tr.x0,
          sdy = tr.y1 - tr.y0;
        const lenSq = sdx * sdx + sdy * sdy;
        let t =
          lenSq > 1e-6 ? ((tx - tr.x0) * sdx + (ty - tr.y0) * sdy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        if (Math.hypot(tx - (tr.x0 + t * sdx), ty - (tr.y0 + t * sdy)) < 2.8)
          return true;
      }
    }
    return false;
  };

  // Generate coherent upland woodland groves & windward rain-shadow forests (no confetti sprinkles!)
  for (let y = 5; y < world.H - 5; y += 2.4) {
    for (let x = 5; x < world.W - 5; x += 2.4) {
      const ix = Math.round(x),
        iy = Math.round(y);
      const id = world.idx(ix, iy);
      if (
        world.waterMask[id] > 0 ||
        world.buildingMask[id] > 0 ||
        world.roadGrid[id] > 0
      )
        continue;
      if (world.zoneColorIdx[id] >= 0) continue;
      const dWater = world.distToWater[id];
      const isSmallIslet = isIslandHopper && world.landmassId[id] < 0;
      if (dWater < (isSmallIslet ? 1.5 : 4.2)) continue;

      const hillHeight = Math.max(0, world.elevationField[id] - world.seaLevel);
      // True windward orographic moisture (`∇H · windVector`) + capped elevation boost
      // so high alpine crests (`+0.24` / `+0.36` contours) and leeward slopes preserve open negative space!
      const dzdx =
        (world.elevationField[world.idx(ix + 1, iy)] -
          world.elevationField[world.idx(ix - 1, iy)]) *
        0.5;
      const dzdy =
        (world.elevationField[world.idx(ix, iy + 1)] -
          world.elevationField[world.idx(ix, iy - 1)]) *
        0.5;
      const windUpslope = -(
        dzdx * world.windVector.x +
        dzdy * world.windVector.y
      );
      const moistureBias = Math.max(-0.18, Math.min(0.24, windUpslope * 5.5));
      const elevBoost =
        Math.min(0.23, hillHeight * 0.72) -
        Math.max(0, hillHeight - 0.3) * 0.55;
      const forestPatch =
        world.noise.fbm(x * 0.055 + 3.1, y * 0.055 + 8.4, 2) + moistureBias;
      if (
        (hillHeight > 0.12 && forestPatch + elevBoost > 0.58) ||
        (isSmallIslet && forestPatch > 0.4)
      ) {
        const groveCount = isSmallIslet
          ? world.rng.int(1, 3)
          : moistureBias > 0.05
            ? world.rng.int(2, 4)
            : world.rng.int(1, 3);
        for (let g = 0; g < groveCount; g++) {
          const tx = x + world.rng.range(-1.04, 1.04);
          const ty = y + world.rng.range(-1.04, 1.04);
          const gx = Math.round(tx),
            gy = Math.round(ty);
          if (!world.inBounds(gx, gy, 3)) continue;
          const gid = world.idx(gx, gy);
          if (
            world.waterMask[gid] > 0 ||
            world.buildingMask[gid] > 0 ||
            world.roadGrid[gid] > 0 ||
            world.zoneColorIdx[gid] >= 0
          )
            continue;
          if (isNearFarmOrTrack(tx, ty)) continue;
          world.trees.push({
            x: tx,
            y: ty,
            r: world.rng.range(0.44, 0.78),
            color: world.rng.pick(PALETTE.treeDots),
          });
        }
      }
    }
  }

  // Nestle interior mountain spring headwaters (`r.headwaterPt`) inside a lush highland forest grove
  // spanning `rad = 1.2..4.9` so it bridges seamlessly across the `dWater < 4.2` riparian setback!
  for (const rObj of world.rivers) {
    if (!rObj.headwaterPt) continue;
    const hx = rObj.headwaterPt.x;
    const hy = rObj.headwaterPt.y;
    for (let g = 0; g < 22; g++) {
      const ang = (g / 22) * Math.PI * 2 + world.rng.range(-0.25, 0.25);
      const rad = world.rng.range(1.2, 4.9);
      const tx = hx + Math.cos(ang) * rad;
      const ty = hy + Math.sin(ang) * rad;
      const gx = Math.round(tx),
        gy = Math.round(ty);
      if (!world.inBounds(gx, gy, 3)) continue;
      const gid = world.idx(gx, gy);
      if (
        world.waterMask[gid] > 0 ||
        world.buildingMask[gid] > 0 ||
        world.roadGrid[gid] > 0 ||
        world.zoneColorIdx[gid] >= 0
      )
        continue;
      world.trees.push({
        x: tx,
        y: ty,
        r: world.rng.range(0.52, 0.84),
        color: world.rng.pick(PALETTE.treeDots),
      });
    }
  }

  // Nestle out-of-town `TIMBER` Forestry Camps inside a lush woodland grove!
  for (const d of world.destinations) {
    if (d.resourceType !== "TIMBER") continue;
    for (let g = 0; g < 10; g++) {
      const ang = (g / 10) * Math.PI * 2 + world.rng.range(-0.28, 0.28);
      const rad = world.rng.range(2.1, 4.4);
      const tx = d.x + Math.cos(ang) * rad;
      const ty = d.y + Math.sin(ang) * rad;
      const gx = Math.round(tx),
        gy = Math.round(ty);
      if (!world.inBounds(gx, gy, 3)) continue;
      const gid = world.idx(gx, gy);
      if (
        world.waterMask[gid] > 0 ||
        world.buildingMask[gid] > 0 ||
        world.roadGrid[gid] > 0 ||
        world.zoneColorIdx[gid] >= 0
      )
        continue;
      world.trees.push({
        x: tx,
        y: ty,
        r: world.rng.range(0.48, 0.78),
        color: world.rng.pick(PALETTE.treeDots),
      });
    }
  }
}
