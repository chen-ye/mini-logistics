/**
 * Single source of truth for town nucleation, hierarchy seeding, and street grid carving:
 * - Founding regional capitals & metropolitan cluster nucleation
 * - Secondary bridgehead & crossroads town co-evolution along regional trunks
 * - Independent multi-phase borough street grid carving & parallel-street inhibition
 * - Outward directional avenue & street line carving from borough centers
 *
 * @import { ProceduralLogisticsWorld } from "../../world-generator.js"
 */
import { PALETTE } from "../../palette.js";
import { WORLD_GEOMETRY } from "../../constants.js";

/**
 * Seeds founding capitals, metropolises, and regional cities (Phase 1).
 *
 * @param {ProceduralLogisticsWorld} world
 */
export function seedSettlements(world) {
  const targetCount = world.config.townCount || 20;
  const usedNames = new Set();

  const numMetros = 2;
  const numRegional = Math.min(6, Math.max(4, Math.round(targetCount * 0.3)));
  world.clusters = [];

  const sectorCenters = [
    { x: world.W * 0.24, y: world.H * 0.34 },
    { x: world.W * 0.76, y: world.H * 0.64 },
    { x: world.W * 0.74, y: world.H * 0.24 },
    { x: world.W * 0.24, y: world.H * 0.74 },
    { x: world.W * 0.5, y: world.H * 0.48 },
  ];

  const isIslandHopper = world.config.archetype === "island-hopper";
  const landmassTownCount = new Int16Array(
    Math.max(1, world.landmasses.length),
  );
  const spanScale = Math.sqrt(world.W / 360);

  // Pre-collect dry-land settlement candidate sites once (`O(N)`)
  const candidateSites = [];
  for (let y = 14; y < world.H - 14; y += 3) {
    for (let x = 14; x < world.W - 14; x += 3) {
      const id = world.idx(x, y);
      if (world.waterMask[id] > 0 || world.distToWater[id] < 2.8) continue;
      const lmId = world.landmassId[id];
      if (lmId < 0) continue;
      const lmSize = world.landmasses[lmId]?.size ?? 0;
      if (lmId > 0 && lmSize < (isIslandHopper ? 360 : 600)) continue;
      const slope = world.slopeField[id];
      if (slope > 0.48 || world.elevationField[id] > world.seaLevel + 0.42)
        continue;
      const dW = world.distToWater[id];
      candidateSites.push({
        x,
        y,
        lmId,
        slope,
        baseSuit: world.urbanSuitability[id] * 0.72,
        wfBonus13: Math.exp(-Math.pow((dW - 3.0) / 3.8, 2)) * 0.34,
        wfBonus4: Math.exp(-Math.pow((dW - 6.0) / 7.5, 2)) * 0.16,
      });
    }
  }

  const majorIslandsCount = isIslandHopper
    ? world.landmasses.filter((lm) => lm.size >= 160).length
    : 0;
  const phase1Count = Math.min(
    targetCount,
    Math.max(numRegional, isIslandHopper ? majorIslandsCount + 2 : numRegional),
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
    /** @type {{ x: number, y: number, score: number, lmId: number } | null} */
    let bestPt = null;

    for (let cIdx = 0; cIdx < candidateSites.length; cIdx++) {
      const site = candidateSites[cIdx];
      if (site.slope > maxSlope) continue;
      const { x, y, lmId } = site;

      let tooClose = false;
      for (const t of world.towns) {
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
        site.baseSuit + site.wfBonus13 + world.rng.range(-0.025, 0.025);

      if (
        isIslandHopper &&
        landmassTownCount[lmId] === 0 &&
        world.landmasses[lmId].size >= 160
      ) {
        score += 0.65;
      } else if (isClusterAnchor) {
        const sec = sectorCenters[i % sectorCenters.length];
        const dSec = Math.hypot(x - sec.x, y - sec.y);
        score += Math.exp(-Math.pow(dSec / (world.W * 0.24), 2)) * 0.42;
      }

      if (score > bestScore) {
        bestScore = score;
        bestPt = { x, y, score, lmId };
      }
    }

    if (bestPt) {
      landmassTownCount[bestPt.lmId]++;
      let clusterId = i;
      if (!isClusterAnchor && world.clusters.length > 0) {
        let minCD = Infinity;
        for (const cl of world.clusters) {
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
        commercialCount: 0,
        industrialCount: 0,
        airportId: null,
        _seededInPhase1: true,
        boroughs: [{ x: bestPt.x, y: bestPt.y, r: urbanRadius }],
      };
      world.towns.push(townObj);
      if (isClusterAnchor) {
        world.clusters.push(townObj);
      }
    }
  }
  world.logs.push(
    `Seeded <b>${world.towns.length} founding capitals & regional cities</b> (2 Metropolises, ${world.towns.length - 2} Regional Ports).`,
  );
}

/**
 * Co-evolves secondary bridgehead and crossroads settlements along regional trunks.
 *
 * @param {ProceduralLogisticsWorld} world
 */
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
      const lmSize = world.landmasses[lmId]?.size ?? 0;
      if (lmId > 0 && lmSize < (isIslandHopper ? 360 : 600)) continue;
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
        if (
          u <= ap.halfLen + (ap.approachLen || 0) + 4 &&
          v <= (ap.halfWid || 0) + 5.5
        ) {
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
    /** @type {{ x: number, y: number, score: number, lmId: number, nearTrunkPt: { x: number, y: number } | null } | null} */
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
      /** @type {{ x: number, y: number } | null} */
      let nearTrunkPt = null;
      for (let k = 0; k < trunkRoadPts.length; k++) {
        const tp = trunkRoadPts[k];
        if (
          isIslandHopper &&
          world.landmassId[world.idx(tp.x, tp.y)] !== lmId
        ) {
          continue;
        }
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
        commercialCount: 0,
        industrialCount: 0,
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
        if (
          path &&
          path.length >= 2 &&
          path.filter((p) => p.isBridge).length <= (isIslandHopper ? 14 : 18)
        ) {
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

/**
 * Carves multi-phase borough grids and boulevards around town centers.
 *
 * @param {ProceduralLogisticsWorld} world
 * @param {((town: any) => boolean) | null} [filterFn]
 */
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
      /** @type {number | null} */
      let bestBx = null;
      /** @type {number | null} */
      let bestBy = null;
      let bestScore = -1;
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
      if (bestBx !== null && bestBy !== null) {
        const bRad = Math.round(R * (b === 0 ? 0.66 : 0.54));
        boroughs.push({ x: bestBx, y: bestBy, r: bRad, isMainCBD: false });
      }
    }
    town.boroughs = boroughs;

    // Helper to generate irregular street-line offsets outward from 0 using mixed 3, 4, and 5-tile strides
    // (producing varied 2×2, 2×3, 3×2, 3×3, and 2×4 rectangular blocks instead of a uniform 2×2 waffle!)
    const buildVariableOffsets = (maxRadius, isCBD) => {
      const offs = [];
      const minMargin = maxRadius <= 11 ? 1 : 2;
      for (const dir of [-1, 1]) {
        let cur = 0;
        let idx = 0;
        while (cur < maxRadius - minMargin) {
          let stepChoice;
          if (maxRadius <= 11) {
            stepChoice = 3;
          } else if (idx === 0) {
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
      const modScale = Math.min(1.0, bR / 15.0);

      for (let dy = -bR - 2; dy <= bR + 2; dy++) {
        for (let dx = -bR - 2; dx <= bR + 2; dx++) {
          const gx = br.x + dx;
          const gy = br.y + dy;
          if (!world.inBounds(gx, gy, 2)) continue;
          const id = world.idx(gx, gy);
          if (world.waterMask[id] > 0) continue;
          const isIH = world.config.archetype === "island-hopper";
          const rawDist = Math.hypot(dx, dy);
          const elevPenalty =
            (Math.max(0, world.elevationField[id] - brElev) *
              (isIH ? 14.0 : 30.0) +
              world.slopeField[id] * (isIH ? 5.0 : 11.0)) *
            modScale;
          const nJitter =
            world.noise.fbm(gx * 0.11, gy * 0.11, 2) * 3.8 * modScale;
          const d = rawDist + elevPenalty + nJitter;
          if (d <= bR + 1.2 || rawDist <= Math.max(4.8, bR * 0.68)) {
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
          if (pass === 1 && bR > 11 && world.rng.next() < 0.25) continue;
          const chord = Math.sqrt(Math.max(0, bR * bR - dyOff * dyOff));
          // Asymmetric street spans & occasional one-sided T-intersections for organic neighborhood structure!
          const oneSided =
            bR > 11 && Math.abs(dyOff) > 4 && world.rng.next() < 0.28;
          const negSpan =
            oneSided && world.rng.next() < 0.5
              ? 0
              : Math.max(2, Math.floor(chord * world.rng.range(0.55, 0.96)));
          const posSpan =
            oneSided && negSpan > 0 && world.rng.next() < 0.5
              ? 0
              : Math.max(2, Math.floor(chord * world.rng.range(0.55, 0.96)));
          const yRow = br.y + dyOff;
          for (const probeOff of [0, ...xOffsets, -1, 1, -2, 2]) {
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
          if (pass === 1 && bR > 11 && world.rng.next() < 0.25) continue;
          const chord = Math.sqrt(Math.max(0, bR * bR - dxOff * dxOff));
          const oneSided =
            bR > 11 && Math.abs(dxOff) > 4 && world.rng.next() < 0.28;
          const negSpan =
            oneSided && world.rng.next() < 0.5
              ? 0
              : Math.max(2, Math.floor(chord * world.rng.range(0.55, 0.96)));
          const posSpan =
            oneSided && negSpan > 0 && world.rng.next() < 0.5
              ? 0
              : Math.max(2, Math.floor(chord * world.rng.range(0.55, 0.96)));
          const xCol = br.x + dxOff;
          for (const probeOff of [0, ...yOffsets, -1, 1, -2, 2]) {
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

/**
 * Carves a street line starting at `(cx, cy)` and marching outward in both `-dir` and `+dir`,
 * stopping upon hitting water, steep hillsides, an airport pad, or a parallel street within 2 tiles
 * so multi-phase borough grids meet cleanly at T-junctions without 1-tile slivers.
 *
 * @param {ProceduralLogisticsWorld} world
 * @param {number} cx
 * @param {number} cy
 * @param {number} ux
 * @param {number} uy
 * @param {number} negSteps
 * @param {number} posSteps
 * @param {boolean} [isMainBoulevard=false]
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
    !isMainBoulevard &&
    world.inBounds(cx + ux, cy + uy, 2) &&
    world.inBounds(cx - ux, cy - uy, 2) &&
    world.roadGrid[world.idx(cx, cy)] > 0 &&
    (world.roadGrid[world.idx(cx + ux, cy + uy)] > 0 ||
      world.roadGrid[world.idx(cx - ux, cy - uy)] > 0)
  ) {
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
  const isPassable = (x, y, isOrigin = false) => {
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
    for (const rObj of world.rivers) {
      if (
        rObj.headwaterPt &&
        Math.hypot(x - rObj.headwaterPt.x, y - rObj.headwaterPt.y) <
          WORLD_GEOMETRY.ELEVATION_THRESHOLDS.headwaterRoadExclusion
      ) {
        return false;
      }
    }
    if (!isOrigin && hasParallelNeighbor(x, y)) return false;
    return true;
  };
  if (!isPassable(cx, cy, isMainBoulevard)) return;

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
