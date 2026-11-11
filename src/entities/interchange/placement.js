/**
 * Single source of truth for interchange siting, ramp generation, and road network connection:
 * - Cloverleaf & Trumpet dry footprint and overlap cost evaluation
 * - Diamond slip-ramp curve synthesis and footprint clearance
 * - Octilinear surface road displacement & A* bypass rerouting at interchanges
 * - Intermediate expressway ramp placement & underpass detection
 *
 * @import { CloverleafInterchange, DiamondRampInterchange, DiamondSlipRamp, Town } from "../../types.js"
 * @import { ProceduralLogisticsWorld } from "../../world-generator.js"
 */
import { ROAD_GRID, BUILDING_MASK } from "../../constants.js";
import { demolishBuildingsWhere } from "../registry.js";
import {
  extractDiamondRampSegments,
  distSqToSegments,
  CLOVERLEAF_GEOMETRY,
  DIAMOND_GEOMETRY,
} from "./geometry.js";

export function isCloverleafFootprintDry(
  world,
  x,
  y,
  angleA,
  angleB,
  signsA = [-1, 1],
  signsB = [-1, 1],
) {
  const gx = Math.round(x);
  const gy = Math.round(y);
  if (!world.inBounds(gx, gy, 6)) return false;
  const cid = world.idx(gx, gy);
  if (
    world.waterMask[cid] > 0 ||
    world.distToWater[cid] < CLOVERLEAF_GEOMETRY.minWaterDist
  )
    return false;
  if (world.isPointInAirportPad(x, y, 3.4)) return false;

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
        {
          px: x + rAx * CLOVERLEAF_GEOMETRY.outerCheckDist,
          py: y + rAy * CLOVERLEAF_GEOMETRY.outerCheckDist,
        },
        {
          px: x + rBx * CLOVERLEAF_GEOMETRY.outerCheckDist,
          py: y + rBy * CLOVERLEAF_GEOMETRY.outerCheckDist,
        },
        {
          px: x + (rAx + rBx) * CLOVERLEAF_GEOMETRY.outerCheckCtrl,
          py: y + (rAy + rBy) * CLOVERLEAF_GEOMETRY.outerCheckCtrl,
        },
      ];
      for (const { px, py } of checkPts) {
        const rx = Math.round(px);
        const ry = Math.round(py);
        if (!world.inBounds(rx, ry, 4)) return false;
        const rid = world.idx(rx, ry);
        if (
          world.waterMask[rid] > 0 ||
          world.distToWater[rid] < CLOVERLEAF_GEOMETRY.rampWaterDist
        )
          return false;
        if (world.isPointInAirportPad(px, py, 2.2)) return false;
      }
    }
  }
  return true;
}

export function isTrumpetFootprintDry(world, x, y, angleMain, sideSign) {
  const gx = Math.round(x);
  const gy = Math.round(y);
  if (!world.inBounds(gx, gy, 6)) return false;
  const cid = world.idx(gx, gy);
  if (world.waterMask[cid] > 0 || world.distToWater[cid] < 4.5) return false;
  if (world.isPointInAirportPad(x, y, 3.8)) return false;
  // Never place a Trumpet interchange inside a town's dense core (`< urbanRadius * 0.85`)
  for (const t of world.towns) {
    if (Math.hypot(x - t.x, y - t.y) < t.urbanRadius * 0.85) return false;
  }

  const ux = Math.cos(angleMain),
    uy = Math.sin(angleMain);
  const nx = -uy * sideSign,
    ny = ux * sideSign;

  // Check both the Yellow/Purple outer slip-ramps on the terminating highway side (+sideSign),
  // the spur approach throat (+2.45..+5.8), the mainline ramp merge toes (-2.85*sideSign, +2.45*sideSign),
  // AND the concentric Brown 270° inner loop + Blue outer bell on the OPPOSITE side (-sideSign).
  const localPts = [
    [-4.65 * sideSign, 0],
    [-3.55 * sideSign, 0],
    [3.55 * sideSign, 0],
    [0, 3.55],
    [0, 4.8],
    [0, 5.8],
    [-1.4, 1.5],
    [1.4, 1.5],
    [0, -2.65],
    [-1.1 * sideSign, -2.65],
    [-2.5 * sideSign, -1.6],
  ];
  for (const [lu, lv] of localPts) {
    const px = x + ux * lu + nx * lv;
    const py = y + uy * lu + ny * lv;
    const rx = Math.round(px);
    const ry = Math.round(py);
    if (!world.inBounds(rx, ry, 4)) return false;
    const rid = world.idx(rx, ry);
    if (world.waterMask[rid] > 0 || world.distToWater[rid] < 2.6) return false;
    if (world.isPointInAirportPad(px, py, 2.2)) return false;
  }
  return true;
}

export function interchangeRoadOverlapCost(world, cx, cy, radius = 4.2) {
  const rCeil = Math.ceil(radius);
  const r2 = radius * radius;
  let cost = 0;
  for (let dy = -rCeil; dy <= rCeil; dy++) {
    for (let dx = -rCeil; dx <= rCeil; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const gx = Math.round(cx + dx);
      const gy = Math.round(cy + dy);
      if (!world.inBounds(gx, gy, 1)) continue;
      const id = world.idx(gx, gy);
      const rg = world.roadGrid[id];
      if (rg === ROAD_GRID.BRIDGE) cost += 35.0;
      else if (rg === ROAD_GRID.ARTERIAL) cost += 4.5;
      else if (rg === ROAD_GRID.STREET) cost += 2.2;
      const bm = world.buildingMask[id];
      if (bm === BUILDING_MASK.HOUSE || bm === BUILDING_MASK.DESTINATION)
        cost += 3.0;
    }
  }
  return cost;
}

/**
 * @param {ProceduralLogisticsWorld} world
 * @param {number} number
 * @param {number} originX
 * @param {number} originY
 * @param {number | null} [airportId=null]
 * @param {number | null} [townId=null]
 */
export function tryBuildTrumpetSpurToTrunk(
  world,
  number,
  originX,
  originY,
  airportId = null,
  townId = null,
) {
  const ap = airportId !== null ? world.airports[airportId] : null;
  /** @type {{ mw: import('../../types.js').Motorway, trumpetIc: import('../../types.js').Interchange } | null} */
  let bestResult = null;
  let bestScore = Infinity;

  for (const trunk of world.motorways) {
    if (trunk.prunedStart || trunk.prunedEnd) continue;
    if (
      Math.hypot(originX - trunk.sx, originY - trunk.sy) < 28.0 ||
      Math.hypot(originX - trunk.ex, originY - trunk.ey) < 28.0
    ) {
      continue;
    }
    const tSamples = trunk.samples;
    if (!tSamples || tSamples.length < 14) continue;
    const trunkLen = world.polylineArcLength(tSamples, 0, tSamples.length - 1);
    if (trunkLen < 24) continue;

    const iStart = Math.floor(tSamples.length * 0.14);
    const iEnd = Math.ceil(tSamples.length * 0.86);
    const iStride = Math.max(1, Math.round(tSamples.length / 44));

    for (let i = iStart, stepNum = 0; i <= iEnd; i += iStride, stepNum++) {
      const hitPt = tSamples[i];
      if (Math.hypot(hitPt.x - trunk.sx, hitPt.y - trunk.sy) < 12.0) continue;
      if (Math.hypot(hitPt.x - trunk.ex, hitPt.y - trunk.ey) < 12.0) continue;

      const nearOtherMway = world.motorways.some(
        (m) =>
          m.number !== trunk.number &&
          m.samples &&
          m.samples.some(
            (sp) => Math.hypot(sp.x - hitPt.x, sp.y - hitPt.y) < 12.0,
          ),
      );
      if (nearOtherMway) continue;

      const nearOtherIc = world.interchanges.some(
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

      if (!world.isTrumpetFootprintDry(hitPt.x, hitPt.y, angleMain, sideSign))
        continue;

      const chord = Math.hypot(hitPt.x - originX, hitPt.y - originY);
      const scaleSpan = Math.max(1, world.W / 360);
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
          ((hitPt.x - originX) * ap.landNx + (hitPt.y - originY) * ap.landNy) /
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
        if (chord >= 24 && stepNum % 2 === 0) {
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
            x: hitPt.x + outNx * 5.6,
            y: hitPt.y + outNy * 5.6,
          };
          const p2Collar = {
            x: hitPt.x + outNx * 3.15,
            y: hitPt.y + outNy * 3.15,
          };
          for (const bias of [0, 10, -10]) {
            const valleyWps = world.findValleyMotorwayWaypoints(
              vStart.x,
              vStart.y,
              p2Valley.x,
              p2Valley.y,
              airportId,
              bias,
            );
            if (valleyWps && valleyWps.length >= 3) {
              const fullWps = ap
                ? [p0, ...valleyWps, p2Throat, p2Collar, p3]
                : [...valleyWps, p2Throat, p2Collar, p3];
              spurCandidates.push({ waypoints: fullWps, isValley: true });
            }
          }
        }

        for (const sc of spurCandidates) {
          const waypoints = sc.waypoints;
          const samples = world.sampleMotorwayCurve(waypoints);
          // Verify that the final sampled arrival tangent at `p3` is within <= 22° of `(-outNx, -outNy)`
          const sLast = samples[samples.length - 1];
          const sPrev = samples[Math.max(0, samples.length - 3)];
          const arrDx = sLast.x - sPrev.x;
          const arrDy = sLast.y - sPrev.y;
          const arrLen = Math.hypot(arrDx, arrDy) || 1;
          const arrDot = (arrDx * -outNx + arrDy * -outNy) / arrLen;
          if (arrDot < 0.92) continue;

          const score = world.scoreMotorwaySamples(
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
            world.interchangeRoadOverlapCost(hitPt.x, hitPt.y, 4.0) * 0.55;
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

export function detectAndBuildCloverleafs(world) {
  for (let i = 0; i < world.motorways.length; i++) {
    for (let j = i + 1; j < world.motorways.length; j++) {
      const mA = world.motorways[i];
      const mB = world.motorways[j];
      const hit = world.findPolylineIntersection(mA.samples, mB.samples);
      if (!hit) continue;

      const crossSin = Math.abs(Math.sin(hit.angleA - hit.angleB));
      if (crossSin < 0.6) continue;

      if (
        !world.isCloverleafFootprintDry(
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

      const tooClose = world.interchanges.some(
        (ic) =>
          (ic.type === "cloverleaf" || ic.type === "trumpet") &&
          Math.hypot(ic.x - hit.x, ic.y - hit.y) < 14,
      );
      if (tooClose) continue;

      world.displaceBuildingsInRadius(hit.x, hit.y, 6.0);
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
      world.displaceAndRerouteRoadsAtInterchange(cloverIc, false);
      world.interchanges.push(cloverIc);
    }
  }
}

export function displaceAndRerouteRoadsAtInterchange(
  world,
  ic,
  requireCleanReroute = false,
) {
  let isInsideCore;
  if (ic.type === "cloverleaf") {
    isInsideCore = (px, py) => Math.hypot(px - ic.x, py - ic.y) <= 4.0;
  } else if (ic.type === "trumpet") {
    const sy = ic.sideSign || 1;
    const cosA = Math.cos(ic.angleMain);
    const sinA = Math.sin(ic.angleMain);
    const nx = -sinA * sy;
    const ny = cosA * sy;
    isInsideCore = (px, py) => {
      const dx = px - ic.x;
      const dy = py - ic.y;
      const u = (dx * cosA + dy * sinA) * sy;
      const v = dx * nx + dy * ny;
      return u >= -5.85 && u <= 4.05 && v >= -3.45 && v <= 4.05;
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
      return Math.abs(u) <= 2.75 && Math.abs(v) < 1.85;
    };
  } else {
    return true;
  }

  const hasAnyRoadOverlap = world.roads.some(
    (r) =>
      r.type !== "airport-loop" &&
      r.points.some((pt) => isInsideCore(pt.x, pt.y)),
  );
  if (!hasAnyRoadOverlap) return true;

  // 0. Expand the stripped zone outward along degree-2 unanchored road segments (up to `maxPullback` tiles)
  //    until reaching real corridor anchors (`deg >= 3` junctions, building driveways, or bridges)
  //    so realigned roads sweep smoothly from anchor to anchor instead of forming a tight 4-bend U-blister!
  const total = world.W * world.H;
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

  for (const h of world.houses) {
    const rx = Math.round(h.roadX),
      ry = Math.round(h.roadY);
    if (world.inBounds(rx, ry, 1)) frontageMask[world.idx(rx, ry)] = 1;
  }
  for (const d of world.destinations) {
    const rx = Math.round(d.roadX),
      ry = Math.round(d.roadY);
    if (world.inBounds(rx, ry, 1)) frontageMask[world.idx(rx, ry)] = 1;
  }

  const strippedTile = new Uint8Array(total);
  const pullDist = new Uint8Array(total);
  const pullQ = [];

  for (const r of world.roads) {
    if (r.type === "airport-loop" || r.type === "airport-spine") continue;
    for (let i = 0; i < r.points.length; i++) {
      const pt = r.points[i];
      const gx = Math.round(pt.x),
        gy = Math.round(pt.y);
      const id = world.idx(gx, gy);
      if (isInsideCore(pt.x, pt.y) && strippedTile[id] === 0) {
        strippedTile[id] = 1;
        pullQ.push(id);
      }
      if (i < r.points.length - 1) {
        const next = r.points[i + 1];
        addFullEdge(id, world.idx(Math.round(next.x), Math.round(next.y)));
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
      const nx = nid % world.W;
      const ny = Math.floor(nid / world.W);
      const isKey =
        world.airports.some((a) => a.gateX === nx && a.gateY === ny) ||
        world.interchanges.some(
          (otherIc) =>
            Math.round(otherIc.x) === nx && Math.round(otherIc.y) === ny,
        );
      if (isKey || world.roadGrid[nid] === 3) continue;
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
    strippedTile[world.idx(Math.round(px), Math.round(py))] === 1;

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

  for (const r of world.roads) {
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
      const id0 = world.idx(x0, y0);
      const id1 = world.idx(x1, y1);
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

  // 3. Strip all vertices inside `isInsideFootprint` from `world.roads`
  const survivingRoads = [];
  for (const r of world.roads) {
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

  world.roads = survivingRoads;
  world.rebuildRoadGridAndEdges();

  // 4. Reroute each portal group around the interchange perimeter via octilinear A*
  for (const group of portalGroups) {
    const pts = group.portals;
    const rType = group.isArterial ? "arterial" : "street";
    const extraProps = group.isMainBoulevard ? { isMainBoulevard: true } : null;

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
        const detour = world.findRoadPathAStar(
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
          world.commitRoadPath(detour, rType, extraProps);
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
        const detour = world.findRoadPathAStar(
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
          world.commitRoadPath(detour, rType, extraProps);
        } else if (requireCleanReroute) {
          return false;
        }
      }
    }
  }

  world.rebuildRoadGridAndEdges();
  world.rebindOrDisplaceOrphanedFrontage();
  return true;
}

export function intersectUnderpassWithMotorway(_world, samples, kHint, A, B) {
  const rdx = B.x - A.x;
  const rdy = B.y - A.y;
  const kMin = Math.max(0, kHint - 8);
  const kMax = Math.min(samples.length - 2, kHint + 8);
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

export function buildFlexibleDiamondRamps(
  _world,
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
    const kMin = Math.max(2, kCenter - 8);
    const kMax = Math.min(samples.length - 3, kCenter + 8);
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
        walked < DIAMOND_GEOMETRY.walked
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
      const u3 = Math.max(1.35, dx * uAxisX + dy * uAxisY);
      const v3 = Math.max(1.15, dx * vAxisX + dy * vAxisY);

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

export function clearBuildingsAndTreesAlongDiamondRamps(world, rampSegs) {
  if (!rampSegs || rampSegs.length === 0) return;

  const houseR2 =
    DIAMOND_GEOMETRY.clearanceRadius * DIAMOND_GEOMETRY.clearanceRadius;
  demolishBuildingsWhere(
    world,
    (h) => distSqToSegments(rampSegs, h.x, h.y) <= houseR2,
    (d) => {
      if (d.isRuralNiche) return false;
      const wT = d.wTiles || 2;
      const hT = d.hTiles || 2;
      const cx = d.gx + (wT - 1) * 0.5;
      const cy = d.gy + (hT - 1) * 0.5;
      const rad = Math.max(wT, hT) * 0.5 + 1.25;
      return distSqToSegments(rampSegs, cx, cy) <= rad * rad;
    },
  );

  const treeR2 = 1.35 * 1.35;
  world.trees = world.trees.filter(
    (tr) => distSqToSegments(rampSegs, tr.x, tr.y) > treeR2,
  );
}

export function findExistingOctilinearUnderpass(
  world,
  pt,
  _cosA,
  _sinA,
  nx,
  ny,
) {
  for (const r of world.roads) {
    if (r.type === "airport-loop" || r.type === "airport-spine") continue;
    const pts = r.points;
    if (!pts || pts.length < 4) continue;
    for (let idx = 1; idx < pts.length - 1; idx++) {
      const rp = pts[idx];
      const rx0 = Math.round(rp.x);
      const ry0 = Math.round(rp.y);
      if (Math.hypot(rx0 - pt.x, ry0 - pt.y) > 1.55) continue;
      if (world.waterMask[world.idx(rx0, ry0)] > 0) continue;

      const ux = Math.sign(Math.round(pts[idx + 1].x) - rx0);
      const uy = Math.sign(Math.round(pts[idx + 1].y) - ry0);
      if (ux === 0 && uy === 0) continue;
      const uLen = Math.hypot(ux, uy);
      const alignNormal = Math.abs((ux / uLen) * nx + (uy / uLen) * ny);
      if (alignNormal < 0.68) continue;

      /** @type {{ x: number, y: number } | null} */
      let posTerm = null;
      let bestPosErr = Infinity;
      /** @type {{ x: number, y: number } | null} */
      let negTerm = null;
      let bestNegErr = Infinity;

      for (const stepDir of [-1, 1]) {
        let cx = rx0;
        let cy = ry0;
        for (let s = 1; s <= 5; s++) {
          const nx2 = cx + ux * stepDir;
          const ny2 = cy + uy * stepDir;
          if (
            !world.inBounds(nx2, ny2, 4) ||
            !world.hasRoadEdge(cx, cy, nx2, ny2)
          )
            break;
          if (world.waterMask[world.idx(nx2, ny2)] > 0) break;
          cx = nx2;
          cy = ny2;
          const v = (cx - pt.x) * nx + (cy - pt.y) * ny;
          if (v >= 1.85 && v <= 3.1) {
            const err = Math.abs(v - DIAMOND_GEOMETRY.stepReach);
            if (err < bestPosErr) {
              bestPosErr = err;
              posTerm = { x: cx, y: cy };
            }
          } else if (v <= -1.85 && v >= -3.1) {
            const err = Math.abs(Math.abs(v) - DIAMOND_GEOMETRY.stepReach);
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

export function buildIntermediateExpresswayRamps(world) {
  if (!world.config.includeIntermediateRamps) return;

  const octDirs = [
    { dx: 1, dy: 0, len: 1, weight: 1.08 },
    { dx: 0, dy: 1, len: 1, weight: 1.08 },
    { dx: 1, dy: 1, len: Math.SQRT2, weight: 1.0 },
    { dx: 1, dy: -1, len: Math.SQRT2, weight: 1.0 },
  ];

  for (const mw of world.motorways) {
    const samples = mw.samples;
    if (!samples || samples.length < 14) continue;
    const arcLen = world.polylineArcLength(samples, 0, samples.length - 1);
    if (arcLen < 38) continue;

    const hasMajorIc = world.interchanges.some(
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
      /** @type {{ kCenter: number, x: number, y: number, angleRad: number, connSide: number, posTerm: { x: number, y: number }, negTerm: { x: number, y: number }, sdx: number, sdy: number, stepReach: number, existingUnderpass: boolean, nearestTown: Town } | null} */
      let bestCandidate = null;
      let bestScore = -Infinity;

      const iStart = Math.floor(samples.length * 0.2);
      const iEnd = Math.ceil(samples.length * 0.8);
      const iStride = Math.max(1, Math.round(samples.length / 44));

      for (let i = iStart; i <= iEnd; i += iStride) {
        const pt = samples[i];
        const gx = Math.round(pt.x);
        const gy = Math.round(pt.y);
        if (!world.inBounds(gx, gy, 6)) continue;
        const id = world.idx(gx, gy);
        if (world.waterMask[id] > 0 || world.distToWater[id] < 3.4) continue;
        if (
          world.buildingMask[id] === 3 ||
          world.isPointInAirportPad(pt.x, pt.y, 3.8)
        )
          continue;

        if (Math.hypot(pt.x - mw.sx, pt.y - mw.sy) < 16) continue;
        if (Math.hypot(pt.x - mw.ex, pt.y - mw.ey) < 16) continue;

        const nearExisting = world.interchanges.some(
          (ic) => Math.hypot(ic.x - pt.x, ic.y - pt.y) < 22,
        );
        if (nearExisting) continue;

        /** @type {Town | null} */
        let nearestTown = null;
        let minTownDist = Infinity;
        for (const t of world.towns) {
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
        const existingUnderpass = world.findExistingOctilinearUnderpass(
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
              sdx: 0,
              sdy: 0,
              stepReach: 0,
              existingUnderpass: true,
              nearestTown,
            };
          }
          continue;
        }

        // Case T1: New octilinear surface underpass stem (`0°/45°/90°` integer grid) for an unserved town
        const townAlreadyServed = world.interchanges.some(
          (ic) =>
            ic.townId === nearestTown.id ||
            ic.townName === nearestTown.name ||
            (ic.isAirportStub &&
              world.airports[ic.airportId]?.hostTownId === nearestTown.id),
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
            ? Math.max(
                2,
                Math.round(
                  DIAMOND_GEOMETRY.stepReach / (bestDir.len * alignCos),
                ),
              )
            : Math.max(2, Math.round(DIAMOND_GEOMETRY.stepReach / alignCos));

        const posTerm = { x: gx + sdx * stepReach, y: gy + sdy * stepReach };
        const negTerm = { x: gx - sdx * stepReach, y: gy - sdy * stepReach };
        if (
          !world.inBounds(posTerm.x, posTerm.y, 5) ||
          !world.inBounds(negTerm.x, negTerm.y, 5)
        )
          continue;

        let stemDry = true;
        for (let s = -stepReach; s <= stepReach; s++) {
          const sx2 = gx + sdx * s;
          const sy2 = gy + sdy * s;
          const sid = world.idx(sx2, sy2);
          if (
            world.waterMask[sid] > 0 ||
            world.distToWater[sid] < 2.2 ||
            world.buildingMask[sid] === 3 ||
            world.isPointInAirportPad(sx2, sy2, 2.5)
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
              !world.inBounds(rx, ry, 2) ||
              world.roadGrid[world.idx(rx, ry)] === 0
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
        const existingOneSidedOnMw = world.interchanges.some(
          (ic) =>
            ic.type === "diamond-ramp" &&
            ic.mwayNumber === mw.number &&
            !ic.isThroughDiamond,
        );
        if (!hasOppositeRoad && existingOneSidedOnMw) continue;

        const wingClear = !world.roads.some((r) =>
          r.points.some(
            (rp) =>
              Math.hypot(rp.x - pt.x, rp.y - pt.y) <
              DIAMOND_GEOMETRY.maxTermDist,
          ),
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

        let isThroughDiamond = existingUnderpass;

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

          const connectorPath = world.findRoadPathAStar(
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
          /** @type {Array<{ x: number, y: number, isBridge?: boolean }> | null} */
          let oppConnectorPath = null;
          /** @type {{ x: number, y: number } | null} */
          let oppTargetPt = null;
          let bestOppD = 28;
          for (const t of world.towns) {
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
                  !world.inBounds(rx, ry, 2) ||
                  world.roadGrid[world.idx(rx, ry)] === 0
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
            const candOpp = world.findRoadPathAStar(
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

          world.displaceBuildingsInRadius(x, y, 4.2);
          world.displaceBuildingsInRadius(posTerm.x, posTerm.y, 2.5);
          world.displaceBuildingsInRadius(negTerm.x, negTerm.y, 2.5);

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
          world.commitRoadPath(stemPts, "arterial", {
            isUnderpassStem: !isThroughDiamond,
          });
          world.commitRoadPath(connectorPath, "arterial");
          if (oppConnectorPath) {
            world.commitRoadPath(oppConnectorPath, "arterial");
          }
        } else {
          // Existing octilinear surface road underpass (`A1`): keep the road course 100% unaltered,
          // only clearing buildings/trees underneath the 4 flexible slip-ramps!
          world.displaceBuildingsInRadius(x, y, 3.8);
        }

        world.trees = world.trees.filter((tr) => {
          const dx = tr.x - x;
          const dy = tr.y - y;
          const u = Math.abs(dx * cosA + dy * sinA);
          const v = Math.abs(dx * nx + dy * ny);
          return !(u <= 4.1 && v <= 3.7);
        });

        const crossPt = world.intersectUnderpassWithMotorway(
          samples,
          kCenter,
          negTerm,
          posTerm,
        );
        const ramps = world.buildFlexibleDiamondRamps(
          mw,
          crossPt.k,
          crossPt,
          posTerm,
          negTerm,
          connSide,
          isThroughDiamond,
        );

        const rampSegs = extractDiamondRampSegments(ramps);
        clearBuildingsAndTreesAlongDiamondRamps(world, rampSegs);

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

        world.interchanges.push(diamondIc);
      }
    }
  }
}
