/**
 * @import { ProceduralLogisticsWorld } from "./world-generator.js"
 * @import {
 *   Point2D,
 *   Motorway,
 *   CloverleafInterchange,
 *   DiamondSlipRamp,
 *   DiamondRampInterchange
 * } from "./types.js"
 */
import { FlatMinHeap } from "./math.js";
import {
  WATER_MASK,
  ROAD_GRID,
  BUILDING_MASK,
  WORLD_GEOMETRY,
} from "./constants.js";

/**
 * @param {ProceduralLogisticsWorld} world
 */
export function applyRightOfWayClearance(world) {
  world.displaceBuildingsAlongMotorwayCorridors();
  world.pruneEmptyOuterStreets();
}

/*************************************************************************
 * STAGE 8: REALISTIC EXPRESSWAYS, CLOVERLEAFS, STREET-STUB TERMINALS & RAMPS
 *************************************************************************/
export function displaceBuildingsInRadius(world, cx, cy, radius) {
  const r2 = radius * radius;
  const rCeil = Math.ceil(radius);
  for (let dy = -rCeil; dy <= rCeil; dy++) {
    for (let dx = -rCeil; dx <= rCeil; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const gx = Math.round(cx + dx);
      const gy = Math.round(cy + dy);
      if (
        world.inBounds(gx, gy, 1) &&
        world.buildingMask[world.idx(gx, gy)] !== 3
      ) {
        world.buildingMask[world.idx(gx, gy)] = 4;
      }
    }
  }

  const beforeHouses = world.houses.length;
  world.houses = world.houses.filter((h) => {
    const keep = (h.x - cx) * (h.x - cx) + (h.y - cy) * (h.y - cy) > r2;
    if (!keep) {
      const hid = world.idx(h.x, h.y);
      if (world.buildingMask[hid] === 1) world.buildingMask[hid] = 4;
      const t = world.towns[h.townId];
      if (t && t.housesCount > 0) t.housesCount--;
    }
    return keep;
  });

  const beforeDest = world.destinations.length;
  world.destinations = world.destinations.filter((d) => {
    const keep =
      (d.x - cx) * (d.x - cx) + (d.y - cy) * (d.y - cy) >
      (radius + 1.2) * (radius + 1.2);
    if (!keep) {
      for (let dy = 0; dy < (d.hTiles || 1); dy++) {
        for (let dx = 0; dx < (d.wTiles || 1); dx++) {
          const did = world.idx(d.gx + dx, d.gy + dy);
          if (world.buildingMask[did] === 2) world.buildingMask[did] = 4;
        }
      }
      const t = world.towns[d.townId];
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

  world.trees = world.trees.filter(
    (tr) => (tr.x - cx) * (tr.x - cx) + (tr.y - cy) * (tr.y - cy) > r2,
  );
  world.displacedBuildingsCount +=
    beforeHouses -
    world.houses.length +
    (beforeDest - world.destinations.length);
}

export function findPassThroughStubAtTown(world, town, towardX, towardY) {
  const baseAngle = Math.atan2(towardY - town.y, towardX - town.x);
  return (
    world.interchanges.find((ic) => {
      if (
        ic.type !== "terminal-stub" ||
        ic.isAirportStub ||
        ic.townId !== town.id
      )
        return false;
      const attachedCount = world.motorways.filter(
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

export function createTerminalStreetStub(
  world,
  townOrAirport,
  isAirport,
  towardX,
  towardY,
) {
  if (isAirport) {
    const ap = townOrAirport;
    world.displaceBuildingsInRadius(ap.gateX, ap.gateY, 3.2);
    const stubAngle = Math.atan2(ap.landNy, ap.landNx);
    const existing = world.interchanges.find(
      (ic) =>
        ic.type === "terminal-stub" &&
        ic.isAirportStub &&
        ic.x === ap.gateX &&
        ic.y === ap.gateY,
    );
    if (!existing) {
      world.interchanges.push({
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
  const existingPassThrough = world.findPassThroughStubAtTown(
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
        Math.min(world.W - 8, Math.round(town.x + Math.cos(ang) * r)),
      );
      const candY = Math.max(
        7,
        Math.min(world.H - 8, Math.round(town.y + Math.sin(ang) * r)),
      );
      const cid = world.idx(candX, candY);

      if (world.waterMask[cid] > 0 || world.distToWater[cid] < 3.2) continue;
      if (world.buildingMask[cid] >= 1 && world.buildingMask[cid] <= 3)
        continue;
      if (world.isPointInAirportPad(candX, candY, 2.5)) continue;

      const tooCloseStub = world.interchanges.some(
        (ic) => Math.hypot(ic.x - candX, ic.y - candY) < 11.0,
      );
      if (tooCloseStub) continue;

      // Never plant a terminal roundabout on or near the shoulder of an existing motorway (`HARBOR-305` invariant)!
      const tooCloseMotorway = world.motorways.some((mw) =>
        mw.samples.some((pt) => Math.hypot(pt.x - candX, pt.y - candY) < 15.0),
      );
      if (tooCloseMotorway) continue;

      const hAbove = Math.max(0, world.elevationField[cid] - world.seaLevel);
      const stubCost =
        Math.abs(aOff) * 0.45 +
        Math.abs(rScale - 1.0) * 1.2 +
        hAbove * 28.0 +
        world.slopeField[cid] * 14.0;
      if (stubCost >= bestStubCost) continue;

      const tiePath = world.findRoadPathAStar(
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
          Math.min(world.W - 6, Math.round(town.x + Math.cos(ang) * r)),
        );
        const candY = Math.max(
          5,
          Math.min(world.H - 6, Math.round(town.y + Math.sin(ang) * r)),
        );
        const cid = world.idx(candX, candY);
        if (world.waterMask[cid] > 0 || world.distToWater[cid] < 2.2) continue;
        if (world.buildingMask[cid] >= 1 && world.buildingMask[cid] <= 3)
          continue;
        if (world.isPointInAirportPad(candX, candY, 2.2)) continue;
        const tooCloseMotorway = world.motorways.some((mw) =>
          mw.samples.some(
            (pt) => Math.hypot(pt.x - candX, pt.y - candY) < 13.5,
          ),
        );
        if (tooCloseMotorway) continue;
        const tiePath = world.findRoadPathAStar(
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
  world.displaceBuildingsInRadius(chosenAx, chosenAy, 3.0);
  if (chosenTiePath && chosenTiePath.length >= 2) {
    world.commitRoadPath(chosenTiePath, "arterial", {
      stubOriginX: chosenAx,
      stubOriginY: chosenAy,
    });
  }

  const secondPt =
    chosenTiePath && chosenTiePath.length > 1
      ? chosenTiePath[1]
      : { x: town.x, y: town.y };
  world.interchanges.push({
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
  if (world.waterMask[cid] > 0 || world.distToWater[cid] < 2.6) return false;
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
        { px: x + rAx * 2.8, py: y + rAy * 2.8 },
        { px: x + rBx * 2.8, py: y + rBy * 2.8 },
        { px: x + (rAx + rBx) * 1.85, py: y + (rAy + rBy) * 1.85 },
      ];
      for (const { px, py } of checkPts) {
        const rx = Math.round(px);
        const ry = Math.round(py);
        if (!world.inBounds(rx, ry, 4)) return false;
        const rid = world.idx(rx, ry);
        if (world.waterMask[rid] > 0 || world.distToWater[rid] < 1.5)
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
    if (!world.inBounds(rx, ry, 4)) return false;
    const rid = world.idx(rx, ry);
    if (world.waterMask[rid] > 0 || world.distToWater[rid] < 2.6) return false;
    if (world.isPointInAirportPad(px, py, 2.2)) return false;
  }
  return true;
}

/**
 * Computes a soft siting penalty when a candidate Cloverleaf or Trumpet interchange footprint
 * overlaps existing surface roads, bridges, or buildings, steering interchanges into open pockets
 * beside arterials when available.
 */
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

export function scoreMotorwaySamples(
  world,
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
    if (!world.inBounds(Math.round(pt.x), Math.round(pt.y), 4)) return Infinity;
  }

  // Hard invariant 2: Expressways must NEVER route over any airport pad
  if (world.doesPolylineCrossAirport(samples, 1.8, airportId)) {
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
        if (cosTurn < WORLD_GEOMETRY.EXPRESSWAY_LIMITS.minTurnCos)
          return Infinity;
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
  for (const other of world.motorways) {
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

    const hit = world.findPolylineIntersection(other.samples, samples);
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

        const dStartA = world.polylineArcLength(other.samples, 0, hit.idxA);
        const dEndA = world.polylineArcLength(
          other.samples,
          hit.idxA,
          other.samples.length - 1,
        );
        const dStartB = world.polylineArcLength(samples, 0, hit.idxB);
        const dEndB = world.polylineArcLength(
          samples,
          hit.idxB,
          samples.length - 1,
        );

        const minCrossArm = world.motorways.length >= 2 ? 28 : 20;
        if (
          dStartA < 20 ||
          dEndA < 20 ||
          dStartB < minCrossArm ||
          dEndB < minCrossArm
        )
          return Infinity;
        // Reject candidates that come within 12 tiles of two existing motorways (cross-brace prevention)
        for (const other2 of world.motorways) {
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
        const nearMajorIc = world.interchanges.some(
          (ic) =>
            (ic.type === "cloverleaf" || ic.type === "trumpet") &&
            Math.hypot(ic.x - hit.x, ic.y - hit.y) < 28.0,
        );
        if (nearMajorIc) return Infinity;
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
    const id = world.idx(gx, gy);
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
      if (cosTurn < WORLD_GEOMETRY.EXPRESSWAY_LIMITS.minTurnCos)
        return Infinity;
    }
    if (i >= 5 && i <= samples.length - 6) {
      const vx1 = pt.x - samples[i - 5].x;
      const vy1 = pt.y - samples[i - 5].y;
      const vx2 = samples[i + 5].x - pt.x;
      const vy2 = samples[i + 5].y - pt.y;
      const l1 = Math.hypot(vx1, vy1) || 1;
      const l2 = Math.hypot(vx2, vy2) || 1;
      const cosWide = (vx1 * vx2 + vy1 * vy2) / (l1 * l2);
      if (cosWide < WORLD_GEOMETRY.EXPRESSWAY_LIMITS.minWideTurnCos)
        return Infinity;
    }

    if (world.waterMask[id] === WATER_MASK.RIVER) {
      riverProxArc += segLen;
      // Never allow an expressway to run longitudinally inside a river channel (> 2 perpendicular river crossings)
      if (riverProxArc > WORLD_GEOMETRY.EXPRESSWAY_LIMITS.maxRiverProxArc)
        return Infinity;
    }

    if (world.waterMask[id] > WATER_MASK.DRY) {
      tunnelRunArc = 0;
      const wWeight =
        world.waterMask[id] === WATER_MASK.OPEN_WATER ? 1.35 : 0.72;
      waterArc += segLen * wWeight;
      totalWaterArc += segLen * wWeight;
      // Hard invariant 6: Never build causeways across open lakes/bays on continental maps (`<= 9.5` weighted tiles),
      // and only allow narrow-strait causeways (`<= 12.5` weighted tiles) in `island-hopper`!
      const isIH = world.config.archetype === "island-hopper";
      if (
        waterArc >
          (isIH
            ? WORLD_GEOMETRY.EXPRESSWAY_LIMITS.maxIslandWaterArc
            : WORLD_GEOMETRY.EXPRESSWAY_LIMITS.maxContinentalWaterArc) ||
        totalWaterArc > (isIH ? 15.5 : 13.5)
      ) {
        return Infinity;
      }
      penalty += segLen * (world.waterMask[id] === 2 ? 7.5 : 3.4);
    } else {
      // In `island-hopper`, never use a tiny uninhabited skerry (`landmassId < 0`) as a motorway bridge pier!
      if (
        world.config.archetype === "island-hopper" &&
        world.landmassId[id] < 0
      ) {
        return Infinity;
      }
      waterArc = 0;
      const dWater = world.distToWater[id];
      if (dWater < 3.6) {
        penalty += (3.8 - dWater) * 7.5 * segLen;
      }
      // Topographic valley preference & tunnel portal discipline:
      // Expressways strongly prefer incised river valleys & low passes, and only bore short perpendicular mountain tunnels!
      const hAbove = Math.max(0, world.elevationField[id] - world.seaLevel);
      const ridgeElev = Math.max(0, hAbove - 0.115);
      penalty +=
        segLen *
        (hAbove * 18.0 + ridgeElev * 42.0 + world.slopeField[id] * 12.5);
      // Penalize running expressways collinearly through urban street grids outside terminal stubs
      if (i >= 5 && i <= samples.length - 6) {
        if (world.zoneColorIdx[id] >= 0) penalty += segLen * 8.5;
        if (world.roadGrid[id] > 0) penalty += segLen * 14.0;
      }
      if (i > 0) {
        const prevPt = samples[i - 1];
        const prevId = world.idx(Math.round(prevPt.x), Math.round(prevPt.y));
        const dElev = Math.abs(
          world.elevationField[id] - world.elevationField[prevId],
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
    for (const ap of world.airports) {
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
    for (const other of world.motorways) {
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
export function ensureCoarseValleyCostTable(world) {
  if (world._coarseBaseCost) return;
  const stride = 3;
  const cw = Math.ceil(world.W / stride);
  const ch = Math.ceil(world.H / stride);
  const table = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    const gy = cy * stride;
    for (let cx = 0; cx < cw; cx++) {
      const gx = cx * stride;
      const cid = cy * cw + cx;
      if (!world.inBounds(gx, gy, 1)) {
        table[cid] = 1e6;
        continue;
      }
      const id = world.idx(gx, gy);
      const wm = world.waterMask[id];
      let c = world.noise.fbm(gx * 0.035 + 4.1, gy * 0.035 + 7.3, 2) * 6.5;
      if (wm === 1) {
        c += 22.0;
      } else if (wm === 0) {
        const hAbove = Math.max(0, world.elevationField[id] - world.seaLevel);
        const slope = world.slopeField[id];
        const dW = world.distToWater[id];
        if (dW < 3.8) c += (4.0 - dW) * 14.0;
        c += hAbove * 115.0 + hAbove * hAbove * 240.0 + slope * 56.0;
        if (world.zoneColorIdx[id] >= 0) c += 12.0;
        if (world.roadGrid[id] > 0) c += 16.0;
        for (const t of world.towns) {
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
  world._coarseBaseCost = table;
  world._coarseG = new Float32Array(cw * ch);
  world._coarseParent = new Int32Array(cw * ch);
  world._coarseSeenGen = new Uint32Array(cw * ch);
  world._coarseClosedGen = new Uint32Array(cw * ch);
  world._coarseGen = 0;
}

export function findValleyMotorwayWaypoints(
  world,
  sx,
  sy,
  ex,
  ey,
  airportId = null,
  lateralBias = 0,
) {
  world.ensureCoarseValleyCostTable();
  const stride = 3;
  const cw = Math.ceil(world.W / stride);
  const ch = Math.ceil(world.H / stride);
  const scx = Math.max(1, Math.min(cw - 2, Math.round(sx / stride)));
  const scy = Math.max(1, Math.min(ch - 2, Math.round(sy / stride)));
  const ecx = Math.max(1, Math.min(cw - 2, Math.round(ex / stride)));
  const ecy = Math.max(1, Math.min(ch - 2, Math.round(ey / stride)));

  const startId = scy * cw + scx;
  const endId = ecy * cw + ecx;
  const gen = ++world._coarseGen;
  const baseCostTable = world._coarseBaseCost;
  const gScore = world._coarseG;
  const parent = world._coarseParent;
  const seenGen = world._coarseSeenGen;
  const closedGen = world._coarseClosedGen;

  const chordDx = ex - sx;
  const chordDy = ey - sy;
  const chordLen = Math.hypot(chordDx, chordDy) || 1;
  const chordNx = -chordDy / chordLen;
  const chordNy = chordDx / chordLen;

  const openHeap = new FlatMinHeap(256);
  openHeap.push(startId, 0);

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
  while (openHeap.size > 0 && iterCount++ < maxValleyIter) {
    const cid = openHeap.pop();
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
        const pid = world.idx(
          Math.max(0, Math.min(world.W - 1, p.x)),
          Math.max(0, Math.min(world.H - 1, p.y)),
        );
        const ha = Math.max(0, world.elevationField[pid] - world.seaLevel);
        if (ha > maxHAbove) maxHAbove = ha;
      }
      let outWps = [{ x: sx, y: sy }];
      const numCtrl = Math.min(14, Math.max(5, Math.floor(rawPts.length / 3)));
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
          world.inBounds(Math.round(wx), Math.round(wy), 5) &&
          !world.isPointInAirportPad(wx, wy, 2.2, airportId)
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
            0.25 * outWps[i - 1].x + 0.5 * outWps[i].x + 0.25 * outWps[i + 1].x;
          const ny =
            0.25 * outWps[i - 1].y + 0.5 * outWps[i].y + 0.25 * outWps[i + 1].y;
          const curId = world.idx(
            Math.round(outWps[i].x),
            Math.round(outWps[i].y),
          );
          const newId = world.idx(Math.round(nx), Math.round(ny));
          // Accept smoothed position unless it enters water/airport pad or climbs onto a steep mountain wall
          if (
            !world.isPointInAirportPad(nx, ny, 2.2, airportId) &&
            world.waterMask[newId] === 0 &&
            world.elevationField[newId] <= world.elevationField[curId] + 0.08
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
    const currElev = world.inBounds(currGx, currGy, 1)
      ? world.elevationField[world.idx(currGx, currGy)]
      : world.seaLevel;
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
      if (world.isPointInAirportPad(gx, gy, 2.2, airportId)) continue;

      const id = world.idx(gx, gy);
      const wm = world.waterMask[id];
      const absDeltaH =
        Math.abs(world.elevationField[id] - currElev) / baseStep;

      let cost = baseStep * stride + baseCostTable[nid] + absDeltaH * 145.0;
      if (wm === 2) {
        // Distinguish narrow strait crossings (land within 12 tiles ahead) from deep open lakes/bays
        const aheadX = gx + dx * stride * 4;
        const aheadY = gy + dy * stride * 4;
        const isNarrowStrait =
          world.inBounds(aheadX, aheadY, 2) &&
          world.waterMask[world.idx(aheadX, aheadY)] === 0;
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
        openHeap.push(nid, tentativeG + h);
      }
    }
  }
  return null;
}

export function createMotorwayEntity(
  world,
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

  const ap = airportId !== null ? world.airports[airportId] : null;
  const departPull = ap ? Math.min(20, Math.max(7.0, len * 0.3)) : 0;

  const candidateCurves = [];

  const defaultSign = number % 2 === 0 ? 1 : -1;
  const preferMag = Math.min(7.5, len * 0.09);
  const preferOff = defaultSign * preferMag;

  if (forcedViaPt && !ap) {
    // Route Cloverleaf transverse trunks (`M-2`) through two chained valley A* legs (`start -> forcedViaPt -> end`)
    // with colinear tangent alignment across `forcedViaPt` so M-2 follows topographic valleys on both sides!
    for (const bias of [0, defaultSign * 10, -defaultSign * 10]) {
      const leg1 = world.findValleyMotorwayWaypoints(
        sx,
        sy,
        forcedViaPt.x,
        forcedViaPt.y,
        null,
        bias,
      );
      const leg2 = world.findValleyMotorwayWaypoints(
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
      const valleyWps = world.findValleyMotorwayWaypoints(
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
    const samples = world.sampleMotorwayCurve(cand.waypoints);
    const rawScore = world.scoreMotorwaySamples(
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
      (cand.isCloverleafTarget ? 35.0 : 0) + (cand.isValleyCorridor ? 15.0 : 0);
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

export function sampleMotorwayCurve(_world, waypoints) {
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

export function polylineArcLength(_world, samples, i0, i1) {
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

export function removeOrphanedTerminalStub(world, x, y) {
  const stillUsed = world.motorways.some(
    (m) =>
      (Math.hypot(m.sx - x, m.sy - y) < 1.5 && !m.prunedStart) ||
      (Math.hypot(m.ex - x, m.ey - y) < 1.5 && !m.prunedEnd),
  );
  if (!stillUsed) {
    world.interchanges = world.interchanges.filter(
      (ic) =>
        !(
          ic.type === "terminal-stub" &&
          !ic.isAirportStub &&
          Math.hypot(ic.x - x, ic.y - y) < 1.5
        ),
    );
    const beforeLen = world.roads.length;
    world.roads = world.roads.filter(
      (r) =>
        !(
          r.stubOriginX !== undefined &&
          Math.hypot(r.stubOriginX - x, r.stubOriginY - y) < 1.5
        ),
    );
    if (world.roads.length !== beforeLen) {
      world.rebuildRoadGridAndEdges();
    }
  }
}

/**
 * Attempts to build a 3-way Trumpet Spur Motorway from `(originX, originY)` (an airport gate
 * or unserved town beltway stub) directly into a dry interior point on an existing trunk motorway,
 * terminating at the trumpet throat with a perpendicular arrival tangent.
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
  let bestResult = null;
  let bestScore = Infinity;

  for (const trunk of world.motorways) {
    if (trunk.prunedStart || trunk.prunedEnd) continue;
    const tSamples = trunk.samples;
    if (!tSamples || tSamples.length < 14) continue;
    const trunkLen = world.polylineArcLength(tSamples, 0, tSamples.length - 1);
    if (trunkLen < 24) continue;

    const iStart = Math.floor(tSamples.length * 0.14);
    const iEnd = Math.ceil(tSamples.length * 0.86);

    for (let i = iStart; i <= iEnd; i++) {
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
                ? [p0, ...valleyWps, p2Throat, p3]
                : [...valleyWps, p2Throat, p3];
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

      world.displaceBuildingsInRadius(hit.x, hit.y, 5.6);
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

export function findPolylineIntersection(world, samplesA, samplesB) {
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
      const pt = world.segmentIntersection(
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

export function segmentIntersection(x1, y1, x2, y2, x3, y3, x4, y4) {
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
export function rebindOrDisplaceOrphanedFrontage(world) {
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  world.houses = world.houses.filter((h) => {
    const rx = Math.round(h.roadX),
      ry = Math.round(h.roadY);
    if (
      world.inBounds(rx, ry, 1) &&
      (world.roadGrid[world.idx(rx, ry)] === 1 ||
        world.roadGrid[world.idx(rx, ry)] === 2)
    ) {
      return true;
    }
    for (const [dx, dy] of dirs) {
      const nx = h.x + dx,
        ny = h.y + dy;
      if (world.inBounds(nx, ny, 1)) {
        const rg = world.roadGrid[world.idx(nx, ny)];
        if (rg === 1 || rg === 2) {
          h.roadX = nx;
          h.roadY = ny;
          return true;
        }
      }
    }
    const hid = world.idx(h.x, h.y);
    if (world.buildingMask[hid] === 1) world.buildingMask[hid] = 0;
    const t = world.towns[h.townId];
    if (t && t.housesCount > 0) t.housesCount--;
    world.displacedBuildingsCount++;
    return false;
  });

  world.destinations = world.destinations.filter((d) => {
    const rx = Math.round(d.roadX),
      ry = Math.round(d.roadY);
    if (
      world.inBounds(rx, ry, 1) &&
      (world.roadGrid[world.idx(rx, ry)] === 1 ||
        world.roadGrid[world.idx(rx, ry)] === 2)
    ) {
      return true;
    }
    const wT = d.wTiles || 2;
    const hT = d.hTiles || 2;
    for (let dx = 0; dx < wT; dx++) {
      for (const py of [-1, hT]) {
        const nx = d.gx + dx,
          ny = d.gy + py;
        if (world.inBounds(nx, ny, 1)) {
          const rg = world.roadGrid[world.idx(nx, ny)];
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
        if (world.inBounds(nx, ny, 1)) {
          const rg = world.roadGrid[world.idx(nx, ny)];
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
        const did = world.idx(d.gx + dx, d.gy + dy);
        if (world.buildingMask[did] === 2) world.buildingMask[did] = 0;
      }
    }
    const t = world.towns[d.townId];
    if (t) {
      if (t.destinationsCount > 0) t.destinationsCount--;
      if (d.zoneType === "commercial" && t.commercialCount > 0)
        t.commercialCount--;
      if (d.zoneType === "industrial" && t.industrialCount > 0)
        t.industrialCount--;
    }
    world.displacedBuildingsCount++;
    return false;
  });
}

/**
 * Displaces surface roads (`street` and `arterial`) from the footprint of a newly placed
 * `cloverleaf`, `trumpet`, or `diamond-ramp` interchange and actively reroutes both
 * through-roads (`pEntry -> pExit`) and severed branch junctions (`pOut -> bypass`)
 * around the interchange perimeter via octilinear A*.
 * Returns `false` without mutating `world.roads` if `requireCleanReroute` is true and any
 * affected road cannot be cleanly rerouted.
 */
export function displaceAndRerouteRoadsAtInterchange(
  world,
  ic,
  requireCleanReroute = false,
) {
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
 * @param {ProceduralLogisticsWorld} _world
 * @param {Motorway} mw
 * @param {number} kCenter
 * @param {Point2D} _crossPt
 * @param {Point2D} posTerm
 * @param {Point2D} negTerm
 * @param {number} connSide
 * @param {boolean} isThroughDiamond
 * @returns {DiamondSlipRamp[]}
 */
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
 * octilinear surface road (`world.roads`). If so, returns the unaltered road's integer
 * terminal vertices `{ posTerm, negTerm, crossX, crossY }` on both sides of the expressway.
 * @param {ProceduralLogisticsWorld} world
 * @param {Point2D} pt
 * @param {number} _cosA
 * @param {number} _sinA
 * @param {number} nx
 * @param {number} ny
 */
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
            !world.inBounds(nx2, ny2, 4) ||
            !world.hasRoadEdge(cx, cy, nx2, ny2)
          )
            break;
          if (world.waterMask[world.idx(nx2, ny2)] > 0) break;
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
      let bestCandidate = null;
      let bestScore = -Infinity;

      const iStart = Math.floor(samples.length * 0.2);
      const iEnd = Math.ceil(samples.length * 0.8);

      for (let i = iStart; i <= iEnd; i++) {
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
            ? Math.max(2, Math.round(2.85 / (bestDir.len * alignCos)))
            : Math.max(3, Math.round(2.85 / alignCos));

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
          let oppConnectorPath = null;
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

export function buildNumberedMotorways(world) {
  let mwayNumber = 1;
  const maxStateMotorways = WORLD_GEOMETRY.EXPRESSWAY_LIMITS.maxStateMotorways;

  const townPop = (t) =>
    (t.housesCount + t.destinationsCount * 3 + 16) *
    (t.airportId !== null ? 1.35 : 1) *
    (t.tier === 1 ? 1.45 : 1.0);
  const townMotorwayDegree = new Int8Array(world.towns.length);
  const connectedClusters = new Set();

  const isTownNearAnyMotorway = (town, maxDist = 22) => {
    for (const mw of world.motorways) {
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
    const ap = town.airportId !== null ? world.airports[town.airportId] : null;
    if (allowHub && ap && ap.isHub && ap.motorwayId === null) {
      const dGate = Math.hypot(towardX - ap.gateX, towardY - ap.gateY) || 1;
      const alignGate =
        ((towardX - ap.gateX) * ap.landNx + (towardY - ap.gateY) * ap.landNy) /
        dGate;
      if (alignGate >= -0.62) {
        return {
          stub: world.createTerminalStreetStub(ap, true, towardX, towardY),
          ap,
          usedHubGate: true,
        };
      }
    }
    return {
      stub: world.createTerminalStreetStub(town, false, towardX, towardY),
      ap: null,
      usedHubGate: false,
    };
  };

  const isIslandHopper = world.config.archetype === "island-hopper";
  const scaleSpan = Math.max(1, world.W / 360);
  // Only Tier-1 Metropolises, Tier-2 Regional Cities, and Airport Host Cities serve as motorway termini
  const isMajorMotorwayHub = (t) =>
    t.tier <= 2 || t.airportId !== null || (isIslandHopper && t.tier <= 3);

  // 1A. Primary Inter-Cluster Interstate Spine (M-1) between the two highest-gravity Metropolises/Cities
  const pairs = [];
  for (let i = 0; i < world.towns.length; i++) {
    const tA = world.towns[i];
    if (!isMajorMotorwayHub(tA)) continue;
    for (let j = i + 1; j < world.towns.length; j++) {
      const tB = world.towns[j];
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
        0.6 * Math.exp(-Math.pow((d - 135 * scaleSpan) / (56 * scaleSpan), 2));
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
        world.removeOrphanedTerminalStub(endA.stub.x, endA.stub.y);
      if (!endB.usedHubGate)
        world.removeOrphanedTerminalStub(endB.stub.x, endB.stub.y);
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

    const mw1 = world.createMotorwayEntity(
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
      world.motorways.push(mw1);
      townMotorwayDegree[tA.id]++;
      townMotorwayDegree[tB.id]++;
      connectedClusters.add(tA.clusterId);
      connectedClusters.add(tB.clusterId);
      primaryPair = cand;
      break;
    } else {
      if (!endA.usedHubGate)
        world.removeOrphanedTerminalStub(endA.stub.x, endA.stub.y);
      if (!endB.usedHubGate)
        world.removeOrphanedTerminalStub(endB.stub.x, endB.stub.y);
    }
  }

  // 1B. Transverse Cross-Axis Interstate Trunk (M-2) Forming a 4-Way Cloverleaf Interchange (M-1 × M-2)
  //     Connects two major hubs on opposite sides of M-1 through a dry interior Cloverleaf site on M-1!
  if (world.motorways.length === 1 && !isIslandHopper) {
    const mw1 = world.motorways[0];
    const mDx = mw1.ex - mw1.sx;
    const mDy = mw1.ey - mw1.sy;
    const mLen = Math.hypot(mDx, mDy) || 1;
    const mNx = -mDy / mLen;
    const mNy = mDx / mLen;

    const crossPairs = [];
    for (let i = 0; i < world.towns.length; i++) {
      const tC = world.towns[i];
      if (tC.tier > 3 || townMotorwayDegree[tC.id] >= 1) continue;
      const sideC = (tC.x - mw1.sx) * mNx + (tC.y - mw1.sy) * mNy;
      if (Math.abs(sideC) < 16) continue;
      for (let j = i + 1; j < world.towns.length; j++) {
        const tD = world.towns[j];
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
      const endD = resolveTownOrHubEndpoint(tD, tC.x, tC.y, !endC.usedHubGate);
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
          !world.isCloverleafFootprintDry(
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
          world.interchangeRoadOverlapCost(pt.x, pt.y, 4.4) * 0.45;
        if (dMid < minViaDist) {
          minViaDist = dMid;
          bestViaPt = pt;
        }
      }

      const mw2 = world.createMotorwayEntity(
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
        world.findPolylineIntersection(mw1.samples, mw2.samples) !== null;
      if (mw2 && crossesM1) {
        if (endC.usedHubGate) endC.ap.motorwayId = mwayNumber;
        if (endD.usedHubGate) endD.ap.motorwayId = mwayNumber;
        mwayNumber++;
        world.motorways.push(mw2);
        townMotorwayDegree[tC.id]++;
        townMotorwayDegree[tD.id]++;
        connectedClusters.add(tC.clusterId);
        connectedClusters.add(tD.clusterId);
        world.detectAndBuildCloverleafs();
        break;
      } else {
        if (!endC.usedHubGate)
          world.removeOrphanedTerminalStub(endC.stub.x, endC.stub.y);
        if (!endD.usedHubGate)
          world.removeOrphanedTerminalStub(endD.stub.x, endD.stub.y);
      }
    }
  }

  // 2. Connect All Remaining Metropolitan Clusters into the State Interstate Network
  //    (via 3-way Trumpet Spurs onto existing trunks, shared pass-through beltways, or Cloverleafs)
  const clusterMetros = [...world.clusters].sort(
    (a, b) => townPop(b) - townPop(a),
  );
  for (
    let pass = 0;
    pass < 2 && world.motorways.length < maxStateMotorways;
    pass++
  ) {
    for (const metro of clusterMetros) {
      if (world.motorways.length >= maxStateMotorways) break;
      if (
        connectedClusters.has(metro.clusterId) ||
        isTownNearAnyMotorway(metro, 26)
      ) {
        connectedClusters.add(metro.clusterId);
        continue;
      }

      // 2A. Try a 3-way Trumpet Spur from world Cluster Metropolis (or any Tier-1/2 city in its cluster) into an existing trunk
      const clusterTowns = [
        metro,
        ...world.towns
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
        let bestTargetPt = { x: world.W * 0.5, y: world.H * 0.5 };
        let minD = Infinity;
        for (const mw of world.motorways) {
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
          const spurRes = world.tryBuildTrumpetSpurToTrunk(
            mwayNumber,
            mEnd.stub.x,
            mEnd.stub.y,
            mEnd.usedHubGate ? mEnd.ap.id : null,
            cTown.id,
          );
          if (spurRes) {
            if (mEnd.usedHubGate) mEnd.ap.motorwayId = mwayNumber;
            mwayNumber++;
            world.motorways.push(spurRes.mw);
            world.displaceBuildingsInRadius(
              spurRes.trumpetIc.x,
              spurRes.trumpetIc.y,
              5.2,
            );
            world.displaceAndRerouteRoadsAtInterchange(
              spurRes.trumpetIc,
              false,
            );
            world.interchanges.push(spurRes.trumpetIc);
            townMotorwayDegree[cTown.id]++;
            connectedClusters.add(metro.clusterId);
            linkedCluster = true;
            break;
          } else if (!mEnd.usedHubGate) {
            world.removeOrphanedTerminalStub(mEnd.stub.x, mEnd.stub.y);
          } else {
            world.interchanges = world.interchanges.filter(
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
        const hubCandidates = world.towns
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
            world.findPassThroughStubAtTown(hubTown, cTown.x, cTown.y) !== null;
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
              world.removeOrphanedTerminalStub(endA.stub.x, endA.stub.y);
            if (!endB.usedHubGate)
              world.removeOrphanedTerminalStub(endB.stub.x, endB.stub.y);
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

          const mwCluster = world.createMotorwayEntity(
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
            world.motorways.some(
              (m) =>
                world.findPolylineIntersection(m.samples, mwCluster.samples) !==
                null,
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
            world.motorways.push(mwCluster);
            townMotorwayDegree[cTown.id]++;
            townMotorwayDegree[hubTown.id]++;
            connectedClusters.add(metro.clusterId);
            connectedClusters.add(hubTown.clusterId);
            world.detectAndBuildCloverleafs();
            linkedCluster = true;
            break;
          } else {
            if (!endA.usedHubGate)
              world.removeOrphanedTerminalStub(endA.stub.x, endA.stub.y);
            if (!endB.usedHubGate)
              world.removeOrphanedTerminalStub(endB.stub.x, endB.stub.y);
          }
        }
      }
    }
  }

  // 3. International Hub & Regional Airport Expressways
  const sortedAirports = [...world.airports].sort(
    (a, b) => (b.isHub ? 1 : 0) - (a.isHub ? 1 : 0),
  );
  for (const ap of sortedAirports) {
    if (ap.motorwayId !== null) continue;
    if (!ap.isHub && world.motorways.length >= maxStateMotorways) continue;
    const host = world.towns[ap.hostTownId];
    if (!ap.isHub && host && isTownNearAnyMotorway(host, 24)) continue;

    let builtApMotorway = false;

    // 3A. Try connecting the airport gate directly into an existing trunk motorway via a 3-way Trumpet Interchange
    const apStubForSpur = world.createTerminalStreetStub(
      ap,
      true,
      ap.x + ap.landNx * 35,
      ap.y + ap.landNy * 35,
    );
    const spurRes = world.tryBuildTrumpetSpurToTrunk(
      mwayNumber,
      apStubForSpur.x,
      apStubForSpur.y,
      ap.id,
      ap.hostTownId,
    );
    if (spurRes) {
      ap.motorwayId = mwayNumber++;
      world.motorways.push(spurRes.mw);
      if (host) townMotorwayDegree[host.id]++;
      world.displaceBuildingsInRadius(
        spurRes.trumpetIc.x,
        spurRes.trumpetIc.y,
        5.2,
      );
      world.displaceAndRerouteRoadsAtInterchange(spurRes.trumpetIc, false);
      world.interchanges.push(spurRes.trumpetIc);
      builtApMotorway = true;
    }

    // 3B. Otherwise connect the airport gate to a major landside city hub that links into the trunk network
    const minAlignPasses = ap.isHub ? [0.32, -0.05] : [0.4];
    for (const minAlign of minAlignPasses) {
      if (builtApMotorway) break;
      const townCandidates = [];
      for (const t of world.towns) {
        if (!isMajorMotorwayHub(t)) continue;
        if (townMotorwayDegree[t.id] >= 2) continue;
        const canSharePassThrough =
          townMotorwayDegree[t.id] === 1 &&
          world.findPassThroughStubAtTown(t, ap.gateX, ap.gateY) !== null;
        if (townMotorwayDegree[t.id] >= 1 && !canSharePassThrough) continue;
        if (
          primaryPair &&
          ((primaryPair.tA.id === ap.hostTownId &&
            primaryPair.tB.id === t.id) ||
            (primaryPair.tB.id === ap.hostTownId && primaryPair.tA.id === t.id))
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

      for (const { town: targetTown, canSharePassThrough } of townCandidates) {
        const apStub = world.createTerminalStreetStub(
          ap,
          true,
          targetTown.x,
          targetTown.y,
        );
        const townStub = world.createTerminalStreetStub(
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
          world.removeOrphanedTerminalStub(townStub.x, townStub.y);
          continue;
        }

        const mwAp = world.createMotorwayEntity(
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
          (world.motorways.length === 0 ||
            canSharePassThrough ||
            world.motorways.some(
              (m) =>
                world.findPolylineIntersection(m.samples, mwAp.samples) !==
                null,
            ) ||
            (ap.isHub && minAlign < 0));
        if (mwAp && connectsToTrunk) {
          ap.motorwayId = mwayNumber++;
          world.motorways.push(mwAp);
          townMotorwayDegree[targetTown.id]++;
          if (host) townMotorwayDegree[host.id]++;
          builtApMotorway = true;
          world.detectAndBuildCloverleafs();
          break;
        } else {
          world.removeOrphanedTerminalStub(townStub.x, townStub.y);
        }
      }
    }

    // If no motorway connected, the airport gateway plaza stub remains as the arterial gateway plaza
  }

  // 4. Additional Regional Spurs for Underserved Tier-1/2 Cities (up to maxStateMotorways)
  const underservedTowns = [...world.towns]
    .filter(
      (t) =>
        isMajorMotorwayHub(t) &&
        townMotorwayDegree[t.id] === 0 &&
        !isTownNearAnyMotorway(t, 24),
    )
    .sort((a, b) => townPop(b) - townPop(a));

  for (const uTown of underservedTowns) {
    if (world.motorways.length >= maxStateMotorways) break;
    let targetPt = { x: world.W * 0.5, y: world.H * 0.5 };
    let minTrunkD = Infinity;
    for (const mw of world.motorways) {
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
    const stub = world.createTerminalStreetStub(
      uTown,
      false,
      targetPt.x,
      targetPt.y,
    );
    const spurRes = world.tryBuildTrumpetSpurToTrunk(
      mwayNumber,
      stub.x,
      stub.y,
      null,
      uTown.id,
    );
    if (spurRes) {
      mwayNumber++;
      world.motorways.push(spurRes.mw);
      world.displaceBuildingsInRadius(
        spurRes.trumpetIc.x,
        spurRes.trumpetIc.y,
        5.2,
      );
      world.displaceAndRerouteRoadsAtInterchange(spurRes.trumpetIc, false);
      world.interchanges.push(spurRes.trumpetIc);
      townMotorwayDegree[uTown.id]++;
    } else {
      world.removeOrphanedTerminalStub(stub.x, stub.y);
    }
  }

  world.detectAndBuildCloverleafs();
}

export function finalizeExpresswayRampsAndTunnels(world) {
  world.buildIntermediateExpresswayRamps();
  world.detectMountainExpresswayTunnels();
  applyRightOfWayClearance(world);

  // Precompute `mw.surfaceSpans` and `mw.shieldPt` once when Stage 9 finalizes motorways
  for (const mw of world.motorways) {
    const samples = mw.samples || [];
    const tunnels = mw.tunnels || [];
    /** @type {Array<Array<{ x: number, y: number }>>} */
    const surfaceSpans = [];
    let curStart = 0;
    for (const tun of tunnels) {
      if (tun.i0 >= curStart) {
        const seg = samples.slice(curStart, tun.i0 + 1);
        if (seg.length >= 2) surfaceSpans.push(seg);
      }
      curStart = tun.i1;
    }
    if (curStart < samples.length - 1) {
      const tail = samples.slice(curStart);
      if (tail.length >= 2) surfaceSpans.push(tail);
    }
    mw.surfaceSpans = surfaceSpans;

    if (samples.length >= 2) {
      let shieldPt = samples[Math.floor(samples.length * 0.5)];
      let bestClearance = -Infinity;
      const iMin = Math.max(2, Math.floor(samples.length * 0.16));
      const iMax = Math.min(
        samples.length - 3,
        Math.ceil(samples.length * 0.84),
      );
      for (let i = iMin; i <= iMax; i++) {
        const cand = samples[i];
        let minIcDist = Math.min(
          Math.hypot(cand.x - mw.sx, cand.y - mw.sy),
          Math.hypot(cand.x - mw.ex, cand.y - mw.ey),
        );
        for (const ic of world.interchanges) {
          const dIc = Math.hypot(ic.x - cand.x, ic.y - cand.y);
          if (dIc < minIcDist) minIcDist = dIc;
        }
        const centerBias =
          1.0 - Math.abs(i / (samples.length - 1) - 0.5) * 0.35;
        const score = Math.min(minIcDist, 14.0) * centerBias;
        if (score > bestClearance) {
          bestClearance = score;
          shieldPt = cand;
        }
      }
      mw.shieldPt = { x: shieldPt.x, y: shieldPt.y };
    }
  }

  const cloverCount = world.interchanges.filter(
    (i) => i.type === "cloverleaf" || i.type === "trumpet",
  ).length;
  const rampCount = world.interchanges.filter(
    (i) => i.type === "diamond-ramp",
  ).length;
  const tunnelCount = world.motorways.reduce(
    (acc, m) => acc + (m.tunnels ? m.tunnels.length : 0),
    0,
  );
  world.logs.push(
    `Built <b>${world.motorways.length} expressways</b>, <b>${cloverCount} system interchanges</b>, <b>${rampCount} ramps</b>${tunnelCount > 0 ? ` & <b>${tunnelCount} mountain tunnels</b>` : ""} (displaced ${world.displacedBuildingsCount} buildings).`,
  );
}

/**
 * Clears any houses or urban commercial/industrial building lots whose footprints intersect
 * the surface right-of-way of a numbered expressway (excluding subterranean mountain tunnel spans)
 * so elevated expressway decks never overlap underlying building roofs in close-up zoom.
 */
export function displaceBuildingsAlongMotorwayCorridors(world) {
  const surfacePts = [];
  const surfaceSegs = [];
  for (const mw of world.motorways) {
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

  const beforeHouses = world.houses.length;
  world.houses = world.houses.filter((h) => {
    const hit = distSqToSurface(h.x, h.y) <= 1.85 * 1.85;
    if (hit) {
      const hid = world.idx(h.x, h.y);
      if (world.buildingMask[hid] === 1) world.buildingMask[hid] = 0;
      const t = world.towns[h.townId];
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

  const beforeDest = world.destinations.length;
  world.destinations = world.destinations.filter((d) => {
    if (d.resourceType === "FARM" && d.bspParcels && d.bspParcels.length > 0) {
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
        const rebuilt = world.finalizeFarmEstateFromParcels(
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
        d.estateBBox = rebuilt.estateBBox;
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
          const lid = world.idx(d.gx + dx, d.gy + dy);
          if (world.buildingMask[lid] === 2) world.buildingMask[lid] = 0;
        }
      }
      const t = world.towns[d.townId];
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

  world.displacedBuildingsCount +=
    beforeHouses -
    world.houses.length +
    (beforeDest - world.destinations.length);
}

/**
 * Scans interior spans of all numbered expressways for high-elevation mountain ridge crossings
 * (`elevationField >= seaLevel + 0.21`) and marks subterranean tunnel portals (`mw.tunnels`).
 */
export function detectMountainExpresswayTunnels(world) {
  const tunnelThresh =
    world.seaLevel + WORLD_GEOMETRY.ELEVATION_THRESHOLDS.tunnelMinAboveSea;
  for (const mw of world.motorways) {
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
      if (!world.inBounds(gx, gy, 2)) continue;
      const id = world.idx(gx, gy);
      const isHighRidge =
        world.waterMask[id] === 0 &&
        world.elevationField[id] >= tunnelThresh &&
        !world.interchanges.some(
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
            world.interchanges.some(
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
