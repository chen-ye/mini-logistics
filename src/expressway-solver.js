/**
 * @import { ProceduralLogisticsWorld } from "./world-generator.js"
 * @import {
 *   Point2D,
 *   Town
 * } from "./types.js"
 */
import { FlatMinHeap } from "./math.js";
import { WATER_MASK, WORLD_GEOMETRY, BUILDING_MASK } from "./constants.js";
import { demolishBuildingsWhere } from "./entities/registry.js";
import { extractDiamondRampSegments } from "./entities/interchange/geometry.js";
import {
  isCloverleafFootprintDry,
  isTrumpetFootprintDry,
  interchangeRoadOverlapCost,
  tryBuildTrumpetSpurToTrunk,
  detectAndBuildCloverleafs,
  displaceAndRerouteRoadsAtInterchange,
  intersectUnderpassWithMotorway,
  buildFlexibleDiamondRamps,
  clearBuildingsAndTreesAlongDiamondRamps,
  findExistingOctilinearUnderpass,
  buildIntermediateExpresswayRamps,
} from "./entities/interchange/placement.js";

export {
  isCloverleafFootprintDry,
  isTrumpetFootprintDry,
  interchangeRoadOverlapCost,
  tryBuildTrumpetSpurToTrunk,
  detectAndBuildCloverleafs,
  displaceAndRerouteRoadsAtInterchange,
  intersectUnderpassWithMotorway,
  buildFlexibleDiamondRamps,
  clearBuildingsAndTreesAlongDiamondRamps,
  findExistingOctilinearUnderpass,
  buildIntermediateExpresswayRamps,
};

/**
 * @param {ProceduralLogisticsWorld} world
 */
export function applyRightOfWayClearance(world) {
  world.displaceBuildingsAlongMotorwayCorridors();
  world.pruneEmptyOuterStreets();
  world.rebindOrDisplaceOrphanedFrontage();
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

  demolishBuildingsWhere(
    world,
    (h) => (h.x - cx) * (h.x - cx) + (h.y - cy) * (h.y - cy) <= r2,
    (d) =>
      (d.x - cx) * (d.x - cx) + (d.y - cy) * (d.y - cy) <=
      (radius + 1.2) * (radius + 1.2),
    BUILDING_MASK.TRANSIT_RESERVE,
  );

  world.trees = world.trees.filter(
    (tr) => (tr.x - cx) * (tr.x - cx) + (tr.y - cy) * (tr.y - cy) > r2,
  );
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
  /** @type {Array<{ x: number, y: number, isBridge?: boolean }> | null} */
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

/**
 * @param {ProceduralLogisticsWorld} world
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
      // allow intermediate narrow-strait bridge budget (`<= 11.5` weighted tiles) for straits, lagoons, calderas, and fjords,
      // and only allow narrow-strait causeways (`<= 12.5` weighted tiles) in `island-hopper`!
      const arch = world.config.archetype;
      const isIH = arch === "island-hopper";
      const isNarrowStraitArch =
        arch === "isthmus-strait" ||
        arch === "barrier-lagoon" ||
        arch === "caldera-basin" ||
        arch === "fjord-sound";
      const maxWaterArc = isIH
        ? WORLD_GEOMETRY.EXPRESSWAY_LIMITS.maxIslandWaterArc
        : isNarrowStraitArch
          ? 11.5
          : WORLD_GEOMETRY.EXPRESSWAY_LIMITS.maxContinentalWaterArc;
      const maxTotalWater = isIH ? 15.5 : isNarrowStraitArch ? 14.5 : 13.5;

      if (waterArc > maxWaterArc || totalWaterArc > maxTotalWater) {
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
      const jStride = Math.max(2, Math.round(other.samples.length / 22));
      for (let j = 2; j < other.samples.length - 2; j += jStride) {
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

/**
 * @param {ProceduralLogisticsWorld} world
 * @param {number} sx
 * @param {number} sy
 * @param {number} ex
 * @param {number} ey
 * @param {number | null} [airportId]
 * @param {number} [lateralBias]
 * @returns {Array<{ x: number, y: number }> | null}
 */
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
    [1, 1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
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

/**
 * @param {ProceduralLogisticsWorld} world
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

  /** @type {{ waypoints: Array<{ x: number, y: number }>, samples: Array<{ x: number, y: number }> } | null} */
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

/**
 * Resamples a polyline to uniform arc-length steps.
 * @param {Point2D[]} pts
 * @param {number} [targetDensity=1.25] samples per tile
 * @param {number} [minSteps=64] minimum step count
 * @returns {Point2D[]}
 */
export function resamplePolylineUniform(
  pts,
  targetDensity = 1.25,
  minSteps = 64,
) {
  if (!pts || pts.length < 2) return pts || [];
  const cumLen = new Float32Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    cumLen[i] =
      cumLen[i - 1] +
      Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  const totalLen = cumLen[pts.length - 1];
  if (totalLen < 1e-3) return pts;

  const steps = Math.max(minSteps, Math.ceil(totalLen * targetDensity));
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

export function sampleMotorwayCurve(_world, waypoints) {
  if (waypoints.length === 3) {
    const [p0, p1, p2] = waypoints;
    const dense = [];
    const denseSteps = 128;
    for (let i = 0; i <= denseSteps; i++) {
      const t = i / denseSteps;
      const mt = 1 - t;
      dense.push({
        x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
        y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
      });
    }
    return resamplePolylineUniform(dense);
  }

  if (waypoints.length === 4) {
    const [p0, p1, p2, p3] = waypoints;
    const dense = [];
    const denseSteps = 128;
    for (let i = 0; i <= denseSteps; i++) {
      const t = i / denseSteps;
      const mt = 1 - t;
      const c0 = mt * mt * mt;
      const c1 = 3 * mt * mt * t;
      const c2 = 3 * mt * t * t;
      const c3 = t * t * t;
      dense.push({
        x: c0 * p0.x + c1 * p1.x + c2 * p2.x + c3 * p3.x,
        y: c0 * p0.y + c1 * p1.y + c2 * p2.y + c3 * p3.y,
      });
    }
    return resamplePolylineUniform(dense);
  }

  let pts = waypoints.map((p) => ({ x: p.x, y: p.y }));
  for (let iter = 0; iter < 4; iter++) {
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

  // Resample Chaikin polyline to uniform arc-length samples (~1.25 samples/tile, min 64)
  // so `cosTurn` and `cosWide` evaluate consistent physical curvature radii!
  return resamplePolylineUniform(pts);
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

export function findPolylineIntersection(world, samplesA, samplesB) {
  if (!samplesA || !samplesB || samplesA.length < 2 || samplesB.length < 2)
    return null;

  let minAX = Infinity,
    maxAX = -Infinity,
    minAY = Infinity,
    maxAY = -Infinity;
  for (let i = 0; i < samplesA.length; i++) {
    const p = samplesA[i];
    if (p.x < minAX) minAX = p.x;
    if (p.x > maxAX) maxAX = p.x;
    if (p.y < minAY) minAY = p.y;
    if (p.y > maxAY) maxAY = p.y;
  }
  let minBX = Infinity,
    maxBX = -Infinity,
    minBY = Infinity,
    maxBY = -Infinity;
  for (let j = 0; j < samplesB.length; j++) {
    const p = samplesB[j];
    if (p.x < minBX) minBX = p.x;
    if (p.x > maxBX) maxBX = p.x;
    if (p.y < minBY) minBY = p.y;
    if (p.y > maxBY) maxBY = p.y;
  }
  if (maxAX < minBX || minAX > maxBX || maxAY < minBY || minAY > maxBY) {
    return null;
  }

  const aStart = samplesA[0];
  const aEnd = samplesA[samplesA.length - 1];
  const bStart = samplesB[0];
  const bEnd = samplesB[samplesB.length - 1];
  const hits = [];

  for (let i = 0; i < samplesA.length - 1; i++) {
    const a1 = samplesA[i];
    const a2 = samplesA[i + 1];
    const sMinX = a1.x < a2.x ? a1.x : a2.x;
    const sMaxX = a1.x > a2.x ? a1.x : a2.x;
    const sMinY = a1.y < a2.y ? a1.y : a2.y;
    const sMaxY = a1.y > a2.y ? a1.y : a2.y;
    if (sMaxX < minBX || sMinX > maxBX || sMaxY < minBY || sMinY > maxBY) {
      continue;
    }
    for (let j = 0; j < samplesB.length - 1; j++) {
      const b1 = samplesB[j];
      const b2 = samplesB[j + 1];
      if (
        (b1.x < sMinX && b2.x < sMinX) ||
        (b1.x > sMaxX && b2.x > sMaxX) ||
        (b1.y < sMinY && b2.y < sMinY) ||
        (b1.y > sMaxY && b2.y > sMaxY)
      ) {
        continue;
      }
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

  const housePredicate = (h) => {
    const rx = Math.round(h.roadX),
      ry = Math.round(h.roadY);
    if (
      world.inBounds(rx, ry, 1) &&
      (world.roadGrid[world.idx(rx, ry)] === 1 ||
        world.roadGrid[world.idx(rx, ry)] === 2)
    ) {
      return false;
    }
    for (const [dx, dy] of dirs) {
      const nx = h.x + dx,
        ny = h.y + dy;
      if (world.inBounds(nx, ny, 1)) {
        const rg = world.roadGrid[world.idx(nx, ny)];
        if (rg === 1 || rg === 2) {
          h.roadX = nx;
          h.roadY = ny;
          return false;
        }
      }
    }
    return true;
  };

  const destPredicate = (d) => {
    const rx = Math.round(d.roadX),
      ry = Math.round(d.roadY);
    if (
      world.inBounds(rx, ry, 1) &&
      (world.roadGrid[world.idx(rx, ry)] === 1 ||
        world.roadGrid[world.idx(rx, ry)] === 2)
    ) {
      return false;
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
            return false;
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
            return false;
          }
        }
      }
    }
    return true;
  };

  demolishBuildingsWhere(world, housePredicate, destPredicate);
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

  /** @type {{ tA: Town, tB: Town, gravity: number, d: number } | null} */
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
      /** @type {{ x: number, y: number } | null} */
      let bestViaPt = null;
      let minViaDist = Infinity;
      const midX = (sx + ex) * 0.5;
      const midY = (sy + ey) * 0.5;
      const crossAng = Math.atan2(ey - sy, ex - sx);
      const s0 = Math.floor(mw1.samples.length * 0.22);
      const s1 = Math.ceil(mw1.samples.length * 0.78);
      const sStride = Math.max(2, Math.round(mw1.samples.length / 22));
      for (let s = s0; s <= s1; s += sStride) {
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
          world.interchangeRoadOverlapCost(pt.x, pt.y, 5.0) * 0.45;
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
  const allDiamondRampSegs = [];
  for (const ic of world.interchanges) {
    if (ic.type === "diamond-ramp" && ic.ramps) {
      allDiamondRampSegs.push(...extractDiamondRampSegments(ic.ramps));
    }
  }
  if (allDiamondRampSegs.length > 0) {
    clearBuildingsAndTreesAlongDiamondRamps(world, allDiamondRampSegs);
  }

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

  const housePredicate = (h) => distSqToSurface(h.x, h.y) <= 1.85 * 1.85;

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

  const destPredicate = (d) => {
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
    if (d.isRuralNiche) return false;
    const wT = d.wTiles || 2;
    const hT = d.hTiles || 2;
    const cx = d.gx + (wT - 1) * 0.5;
    const cy = d.gy + (hT - 1) * 0.5;
    const rad = Math.max(wT, hT) * 0.5 + 1.25;
    const hit = distSqToSurface(cx, cy) <= rad * rad;
    if (hit) {
      const t = world.towns[d.townId];
      // Preserve a town's last remaining commercial building if it sits outside the physical motorway deck (> 1.45 tiles)
      if (
        t &&
        d.zoneType === "commercial" &&
        t.commercialCount <= 1 &&
        distSqToSurface(cx, cy) > 2.1
      ) {
        return false;
      }
      return true;
    }
    return false;
  };

  demolishBuildingsWhere(world, housePredicate, destPredicate);
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
