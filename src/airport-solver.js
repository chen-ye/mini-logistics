/**
 * @import { ProceduralLogisticsWorld } from "./world-generator.js"
 */
import { ROAD_GRID, BUILDING_MASK } from "./constants.js";

/**
 * @param {ProceduralLogisticsWorld} world
 * @param {number} aIdx
 */
export function getAirportTierSpec(world, aIdx) {
  const mix = world.config.airportMix || "hub-regional";
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

export function solveAndPlaceAirports(world) {
  const isIslandHopper = world.config.archetype === "island-hopper";
  const effectiveApCount = isIslandHopper
    ? Math.max(world.config.airportCount, 5)
    : world.config.airportCount;
  const targetAirports = Math.min(effectiveApCount, world.towns.length);
  const baseRad = world.windVector.rad;

  world.airportHeatmap.fill(0);

  // Sort candidate host cities by tier & population priority;
  // in `island-hopper`, prioritize placing 1 airport on each distinct island (`landmassId`) first!
  const byTier = [...world.towns].sort(
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
    tIdx < candidateTowns.length && world.airports.length < targetAirports;
    tIdx++
  ) {
    const hostTown = candidateTowns[tIdx];
    if (!hostTown) break;
    // In `island-hopper`, avoid placing 2 airports on the same island while other islands still need one
    if (
      isIslandHopper &&
      tIdx < candidateTowns.length - 2 &&
      world.airports.some(
        (ap) => world.towns[ap.hostTownId].landmassId === hostTown.landmassId,
      )
    ) {
      continue;
    }

    const aIdx = world.airports.length;
    const spec = world.getAirportTierSpec(aIdx);
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
    const y1 = Math.min(world.H - 22, hostTown.y + scanR);
    const x0 = Math.max(22, hostTown.x - scanR);
    const x1 = Math.min(world.W - 22, hostTown.x + scanR);

    let sumMetroX = 0,
      sumMetroY = 0;
    for (const otherT of world.towns) {
      sumMetroX += otherT.x;
      sumMetroY += otherT.y;
    }
    const metroCx = sumMetroX / (world.towns.length || 1);
    const metroCy = sumMetroY / (world.towns.length || 1);
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
        if (cx > world.W - 56 && cy < 36) continue;
        if (cx < 88 && cy < 28) continue;
        const id = world.idx(cx, cy);
        if (world.waterMask[id] > 0) continue;
        if (
          world.slopeField[id] > maxCenterSlope ||
          world.distToWater[id] < minInscribedDistToWater
        )
          continue;

        const distHost = Math.hypot(cx - hostTown.x, cy - hostTown.y);
        if (distHost < minHostDist || distHost > maxHostDist) continue;

        // NIMBY & Urban Core Exclusion against ALL towns (angle-independent)
        let nimbyViolation = false;
        for (const t of world.towns) {
          const dTown = Math.hypot(cx - t.x, cy - t.y);
          if (
            dTown <
            t.urbanRadius * (isIslandHopper ? 0.72 : 0.8) + (isHub ? 1.8 : 1.0)
          ) {
            nimbyViolation = true;
            break;
          }
        }
        if (nimbyViolation) continue;

        // Minimum airspace separation from already placed airports (angle-independent)
        let tooCloseToAirport = false;
        for (const ap of world.airports) {
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
          for (const otherT of world.towns) {
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
            landsideTownsCount < (isHub && world.towns.length >= 4 ? 2 : 1)
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
                !world.inBounds(gx, gy, 5) ||
                world.waterMask[world.idx(gx, gy)] > 0
              ) {
                landOk = false;
                break;
              }
              slopeSum += world.slopeField[world.idx(gx, gy)];
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
            !world.inBounds(candGateX, candGateY, 6) ||
            world.distToWater[world.idx(candGateX, candGateY)] <
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
              if (!world.inBounds(fx, fy, 1)) continue;
              sampleCount++;
              if (world.waterMask[world.idx(fx, fy)] > 0) {
                waterUnderApproach++;
              }
              for (const t of world.towns) {
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
              const hid = world.idx(cx + dx, cy + dy);
              if (totalScore > world.airportHeatmap[hid]) {
                world.airportHeatmap[hid] = totalScore;
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
        Math.min(world.W - 7, Math.round(bestSite.cx + landNx * stubDist)),
      );
      const gateY = Math.max(
        6,
        Math.min(world.H - 7, Math.round(bestSite.cy + landNy * stubDist)),
      );
      const curbX = Math.max(
        6,
        Math.min(world.W - 7, Math.round(bestSite.cx + landNx * outerDist)),
      );
      const curbY = Math.max(
        6,
        Math.min(world.H - 7, Math.round(bestSite.cy + landNy * outerDist)),
      );

      const nameMap = {
        HUB: `${hostTown.name} International Hub`,
        REG: `${hostTown.name} Regional Airport`,
        CRG: `${hostTown.name} Cargo Airfield`,
      };
      const suffixMap = { HUB: "X", REG: "R", CRG: "C" };

      const airport = {
        id: world.airports.length,
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
          ? `${world.windVector.label} L/R`
          : world.windVector.label,
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
      world.airports.push(airport);

      // Reserve Airfield + Landside Terminal Plaza in buildingMask over exact OBB integer tiles
      const boundR = Math.ceil(Math.hypot(halfLen + 3, stubDist + 3));
      for (
        let gy = Math.max(1, bestSite.cy - boundR);
        gy <= Math.min(world.H - 2, bestSite.cy + boundR);
        gy++
      ) {
        for (
          let gx = Math.max(1, bestSite.cx - boundR);
          gx <= Math.min(world.W - 2, bestSite.cx + boundR);
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
            world.buildingMask[world.idx(gx, gy)] = 3; // 3 = Airport runway airside exclusion zone
          } else if (
            Math.abs(u) <= (isHub ? 3.8 : 2.8) &&
            v > halfWid &&
            v <= stubDist + 1.2
          ) {
            world.buildingMask[world.idx(gx, gy)] = 4; // 4 = Landside transit/road reserve (blocks buildings, permits access)
          }
        }
      }

      // Construct the realistic Landside Terminal Curbside Loop & Access Street Stub
      world.buildAirportLandsideNetwork(airport);
    }
  }

  const hubCount = world.airports.filter(
    (a) => a.airportClass === "HUB",
  ).length;
  const regCount = world.airports.filter(
    (a) => a.airportClass === "REG",
  ).length;
  const crgCount = world.airports.filter(
    (a) => a.airportClass === "CRG",
  ).length;
  world.logs.push(
    `Placed <b>${world.airports.length} airports</b> (${hubCount} Intl Hub, ${regCount} Regional${crgCount ? `, ${crgCount} Cargo` : ""}) with terminal loop roads.`,
  );
}

export function isPointInAirportPad(
  world,
  px,
  py,
  margin = 1.6,
  allowGateAirportId = null,
) {
  for (const ap of world.airports) {
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

export function doesSegmentCrossAirport(
  world,
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
    if (world.isPointInAirportPad(px, py, margin, allowGateAirportId)) {
      return true;
    }
  }
  return false;
}

export function doesPolylineCrossAirport(
  world,
  samples,
  margin = 1.6,
  allowGateAirportId = null,
) {
  if (!samples || samples.length < 2) return false;
  for (let i = 0; i < samples.length - 1; i++) {
    if (
      world.doesSegmentCrossAirport(
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
export function buildAirportLandsideNetwork(world, ap) {
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
      if (world.inBounds(gx, gy, 2)) {
        const id = world.idx(gx, gy);
        if (world.buildingMask[id] === BUILDING_MASK.EMPTY) {
          world.buildingMask[id] = BUILDING_MASK.TRANSIT_RESERVE; // Road/transit reserve: keeps building-free, permits road access
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
    if (world.inBounds(sx, sy, 2)) {
      world.roadGrid[world.idx(sx, sy)] = ROAD_GRID.ARTERIAL;
      world.buildingMask[world.idx(sx, sy)] = BUILDING_MASK.TRANSIT_RESERVE;
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
    world.addRoadEdge(
      stubPts[i].x,
      stubPts[i].y,
      stubPts[i + 1].x,
      stubPts[i + 1].y,
    );
  }

  ap.accessStubPts = stubPts;
  if (stubPts.length >= 2) {
    world.roads.push({
      points: stubPts,
      type: "airport-spine",
      airportId: ap.id,
    });
  }

  // Always register the Airport Gateway Entrance Roundabout Interchange at `(gateX, gateY)`
  world.interchanges.push({
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
