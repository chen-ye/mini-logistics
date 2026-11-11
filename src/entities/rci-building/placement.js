/**
 * Single source of truth for RCI building placement:
 * - Rural raw resource niche extraction & farm estate integration
 * - Town commercial & industrial zoning and placement
 * - Residential neighborhood house infill & setback variation
 *
 * @import { ProceduralLogisticsWorld } from "../../world-generator.js"
 * @import { Town } from "../../types.js"
 */
import { PALETTE } from "../../palette.js";
import {
  RAW_NICHE_SPECS,
  MFG_SPECS,
  FINISHED_GOODS_ORDER,
  nameCommercialSubType,
} from "./catalog.js";

/**
 * Seeds out-of-town rural resource production sites (`MINE`, `TIMBER`, `FARM`, `FISHERY`, `CHEM`) in viable
 * physical terrain niches outside urban zones and connects each with a short rural haul road
 * to the regional trunk network so freight trucks haul raw materials into town `MFG` factories.
 *
 * @param {ProceduralLogisticsWorld} world
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
      // Check a 2×2 building pad + 2-tile clearance margin for zero roads/buildings and outside urban blush,
      // with a 1-tile dry setback (`dx, dy in [-1..2]`) so shoreline `FISHERY` wharves can sit beside the coast.
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
            world.buildingMask[pid] > 0 ||
            world.roadGrid[pid] > 0 ||
            world.zoneColorIdx[pid] >= 0
          ) {
            padOk = false;
            break;
          }
          if (dx >= -1 && dx <= 2 && dy >= -1 && dy <= 2) {
            if (world.waterMask[pid] > 0) {
              padOk = false;
              break;
            }
          }
          if (dx >= 0 && dx <= 1 && dy >= 0 && dy <= 1) {
            if (world.distToWater[pid] < 1.0) {
              padOk = false;
              break;
            }
          }
        }
      }
      if (!padOk) continue;

      const cx = gx + 0.5;
      const cy = gy + 0.5;
      if (world.isPointInAirportPad(cx, cy, 7.0)) continue;

      // Require clear rural separation outside town urban radii (`>= urbanRadius + 4.5`)
      /** @type {Town | null} */
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
      /** @type {{ x: number, y: number } | null} */
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

      // Check if open water or river is within a 4-tile radius for coastal fishery
      let hasWaterNearby = false;
      for (let wy = gy - 4; wy <= gy + 5 && !hasWaterNearby; wy++) {
        for (let wx = gx - 4; wx <= gx + 5; wx++) {
          if (world.inBounds(wx, wy, 1)) {
            const wm = world.waterMask[world.idx(wx, wy)];
            if (wm === 1 || wm === 2) {
              hasWaterNearby = true;
              break;
            }
          }
        }
      }

      // Evaluate fitness for the 5 geographic resource niches:
      // 1. `FISHERY`: coastal shoreline wharf (`dW in [1.1, 2.8]`, `hAbove <= 0.068`, `slope <= 0.25`, water nearby)
      // 2. `MINE`: foothill quarry & mine (`hAbove >= 0.115`, `dW >= 2.2`)
      // 3. `TIMBER`: upland forestry camp (`hAbove >= 0.08`, high fertility, `dW >= 2.2`)
      // 4. `FARM`: alluvial agribusiness (`hAbove <= 0.085`, low slope, `dW >= 3.5`)
      // 5. `CHEM`: peri-urban chemical plant (`hAbove <= 0.115`, slope <= 0.22, `dW >= 2.2`, minRoadDist <= 14.5)
      /** @type {"MINE" | "TIMBER" | "FARM" | "FISHERY" | "CHEM" | null} */
      let resourceType = null;
      let nicheScore = -1;

      if (
        dW >= 1.1 &&
        dW <= 2.8 &&
        hAbove <= 0.068 &&
        slope <= 0.25 &&
        hasWaterNearby
      ) {
        resourceType = "FISHERY";
        nicheScore =
          0.98 + (2.8 - dW) * 0.28 + (0.25 - slope) * 1.8 - minRoadDist * 0.03;
      } else if (
        hAbove >= 0.115 &&
        hAbove <= 0.28 &&
        slope >= 0.06 &&
        slope <= 0.36 &&
        dW >= 2.2
      ) {
        resourceType = "MINE";
        nicheScore =
          1.0 + (hAbove - 0.115) * 3.5 + slope * 1.4 - minRoadDist * 0.03;
      } else if (
        hAbove >= 0.08 &&
        hAbove <= 0.22 &&
        fert >= 0.38 &&
        slope <= 0.28 &&
        dW >= 2.2
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
      } else if (
        hAbove <= 0.115 &&
        slope <= 0.22 &&
        dW >= 2.2 &&
        minRoadDist <= 14.5
      ) {
        resourceType = "CHEM";
        nicheScore =
          0.94 +
          (0.115 - hAbove) * 2.2 +
          (0.22 - slope) * 1.5 -
          minRoadDist * 0.025;
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
    "FISHERY",
    "CHEM",
    "MINE",
    "TIMBER",
    "FARM",
    "CHEM",
    "FISHERY",
  ];
  const placedSites = [];

  for (let slotIdx = 0; slotIdx < targetSites; slotIdx++) {
    const preferredType = desiredMix[slotIdx % desiredMix.length];
    /** @type {{ gx: number, gy: number, cx: number, cy: number, resourceType: "MINE" | "TIMBER" | "FARM" | "FISHERY" | "CHEM", nicheScore: number, nearestTown: Town, nearestRoadPt: { x: number, y: number } } | null} */
    let chosenCand = null;
    /** @type {Array<{ x: number, y: number, isBridge?: boolean }> | null} */
    let chosenHaulPath = null;
    /** @type {{ lotX: number, lotY: number, rx: number, ry: number } | null} */
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

    if (!chosenCand || !chosenHaulPath || !chosenDriveway) continue;

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

    const outputGood =
      RAW_NICHE_SPECS[chosenCand.resourceType]?.outputGood || "ORE";

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
      resourceType: chosenCand.resourceType,
      outputGood,
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

/**
 * Places Commercial (`C`) and Industrial (`I`) sinks with true dimensional variation:
 * - `3×2` and `2×3` elongated rectangular halls/warehouses/sawtooth plants along arterials & industrial yards,
 * - `2×2` square CBD high-rise rotundas and `RAW` silo yards,
 * - `2×1` and `1×2` compact corner commercial blocks that fit into tighter central blocks and transition zones!
 *
 * @param {ProceduralLogisticsWorld} world
 * @param {Town} town
 * @param {number} R
 * @param {number} densityMult
 */
export function placeTownCommercialAndIndustrial(world, town, R, densityMult) {
  const boroughs =
    town.boroughs && town.boroughs.length > 0
      ? town.boroughs
      : [{ x: town.x, y: town.y, r: R }];

  const isIH = world.config.archetype === "island-hopper";
  const ihScale = isIH ? 0.68 : 1.0;
  const baseCom =
    town.tier === 1 ? 10 : town.tier === 2 ? 4 : town.tier === 3 ? 1.2 : 0.8;
  const baseInd =
    town.tier === 1 ? 5 : town.tier === 2 ? 2.5 : town.tier === 3 ? 0.8 : 0.3;
  const targetCom =
    town.tier >= 3
      ? Math.min(
          town.tier === 3 ? 2 : 1,
          Math.max(
            1,
            Math.round(baseCom * ihScale * Math.pow(densityMult, 0.45)),
          ),
        )
      : Math.max(1, Math.round(baseCom * ihScale * Math.pow(densityMult, 0.7)));
  const targetInd =
    town.tier === 4
      ? world.rng.next() < 0.35
        ? 1
        : 0
      : town.tier === 3
        ? 1
        : Math.max(
            1,
            Math.round(baseInd * ihScale * Math.pow(densityMult, 0.62)),
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
    /** @type {{ x: number, y: number, lotX: number, lotY: number } | null} */
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
  const slotsRect = [];
  const slotsCompact = [];

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

  const commitLot = (
    cand,
    zoneType,
    subType,
    isCircular,
    /** @type {Record<string, any> | null} */
    extraProps = null,
  ) => {
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

    const dest = {
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
      zoneType,
      subType,
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
    };
    if (extraProps) {
      Object.assign(dest, extraProps);
    }
    world.destinations.push(dest);
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
  // Tier 3 Market Towns & Tier 4 Hamlets use compact 2×1/1×2 Corner Markets rather than 2×2/3×2 CBD plazas
  const largeTarget =
    town.tier >= 3 ? 0 : Math.max(1, Math.round(targetCom * 0.64));
  for (const cand of comLargePool) {
    if (placedCom >= largeTarget) break;
    // Give 2×2/3×2 buildings breathing room (`minSpacing = 3.6`) so they don't tile into a solid grid
    if (!isLotFree(cand, 3.6)) continue;
    const is2x2 = cand.wTiles === 2 && cand.hTiles === 2;
    const isCBDLandmark =
      is2x2 &&
      (placedCom === 0 || (cand.minBrDist < 4.5 && world.rng.next() < 0.45));
    const g0 = FINISHED_GOODS_ORDER[(town.id + placedCom) % 4];
    const g1 = FINISHED_GOODS_ORDER[(town.id + placedCom + 1) % 4];
    const demandedGoods = [g0, g1];
    const subType = nameCommercialSubType(demandedGoods, isCBDLandmark);
    commitLot(cand, "commercial", subType, isCBDLandmark, {
      demandedGoods,
      label: subType,
    });
    placedCom++;
  }

  // Fill remaining Commercial quota with compact 2×1 / 1×2 Corner Markets in tight central & arterial blocks!
  for (const cand of comCompactPool) {
    if (placedCom >= targetCom) break;
    if (!isLotFree(cand, 2.5)) continue;
    const g0 = FINISHED_GOODS_ORDER[(town.id + placedCom) % 4];
    const demandedGoods = [g0];
    const subType = nameCommercialSubType(demandedGoods, false);
    commitLot(cand, "commercial", subType, false, {
      demandedGoods,
      label: subType,
    });
    placedCom++;
  }
  // Fallback: if a Tier-3/4 town had no 2×1/1×2 lot free, place 1 small 2×2 Corner Market so it never has 0 commercial!
  if (placedCom === 0) {
    for (const cand of slots2x2) {
      if (!isLotFree(cand, 2.5)) continue;
      const g0 = FINISHED_GOODS_ORDER[town.id % 4];
      const demandedGoods = [g0];
      const subType = nameCommercialSubType(demandedGoods, false);
      commitLot(cand, "commercial", subType, false, {
        demandedGoods,
        label: subType,
      });
      placedCom++;
      break;
    }
  }

  // 2. Place Industrial (`I`) Sinks & Producers (`3×2`/`2×3` MFG Factories & LOG Hubs + `2×2` RAW Silo Yards)
  const indRectSorted = [...slotsRect].sort((a, b) => b.indScore - a.indScore);
  const ind2x2Sorted = [...slots2x2].sort((a, b) => b.indScore - a.indScore);
  const indCompactSorted = [...slotsCompact].sort(
    (a, b) => b.indScore - a.indScore,
  );
  // Restrict LOG distribution hubs strictly to Tier 1 Metropolises & half of Tier 2 Regional Cities!
  // Tier 3 Market Towns and Tier 4 Hamlets never spawn LOG hubs.
  const tier1Roles = ["MFG", "LOG", "MFG", "MFG", "RAW", "MFG"];
  const tier2Roles =
    town.id % 2 === 0
      ? ["LOG", "MFG", "MFG", "RAW"]
      : ["MFG", "MFG", "RAW", "MFG"];
  const tier3Roles = ["MFG"];

  const mfgArchetypes = ["STEEL", "FOOD", "GOODS", "TECH"];

  let placedInd = 0;
  let mfgCount = 0;
  let rectIdx = 0;
  let sqIdx = 0;
  let compIdx = 0;
  while (
    placedInd < targetInd &&
    (rectIdx < indRectSorted.length ||
      sqIdx < ind2x2Sorted.length ||
      compIdx < indCompactSorted.length)
  ) {
    let indRole = "MFG";
    if (town.tier === 1) indRole = tier1Roles[placedInd % tier1Roles.length];
    else if (town.tier === 2)
      indRole = tier2Roles[placedInd % tier2Roles.length];
    else indRole = tier3Roles[placedInd % tier3Roles.length];

    const plannedMfgType =
      indRole === "MFG" ? mfgArchetypes[(town.id + mfgCount) % 4] : null;
    // Heavy STEEL mills always prefer 3×2/2×3 pads and never spawn on compact 2×1/1×2 lots;
    // Tier 1 & Tier 2 cities use elongated 3×2/2×3 industrial halls, while Tier 3/4 towns use compact 2×1/1×2 or 2×2 workshops.
    const preferRect =
      town.tier <= 2 &&
      (indRole === "MFG" || indRole === "LOG") &&
      (plannedMfgType === "STEEL" || world.rng.next() < 0.75);
    /** @type {{ gx: number, gy: number, wTiles: number, hTiles: number, cx: number, cy: number, roadTouch: { x: number, y: number, lotX: number, lotY: number }, touchesArterial: boolean, minBrDist: number, cbdScore: number, indScore: number } | null} */
    let chosen = null;

    if (town.tier >= 3) {
      while (compIdx < indCompactSorted.length) {
        const c = indCompactSorted[compIdx++];
        if (isLotFree(c, 2.8)) {
          chosen = c;
          break;
        }
      }
    }
    if (!chosen && preferRect) {
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

    /** @type {Record<string, any>} */
    let extraProps = {};
    if (indRole === "MFG") {
      const isCompactLot = chosen.wTiles === 1 || chosen.hTiles === 1;
      const mfgType = isCompactLot
        ? (town.id + mfgCount) % 2 === 0
          ? "FOOD"
          : "GOODS"
        : plannedMfgType || mfgArchetypes[(town.id + mfgCount) % 4];
      mfgCount++;
      const spec = MFG_SPECS[mfgType];
      extraProps = {
        mfgType,
        mfgTier: spec.mfgTier,
        requiredInputs: [...spec.requiredInputs],
        outputGood: spec.outputGood,
      };
    } else if (indRole === "LOG") {
      extraProps = {
        demandProfile: {},
        relativeDemand: 0.2,
      };
    } else if (indRole === "RAW") {
      extraProps = {
        resourceType: "CHEM",
        outputGood: "CHEM",
      };
    }

    commitLot(chosen, "industrial", indRole, false, extraProps);
    placedInd++;
  }
}

/**
 * @param {ProceduralLogisticsWorld} world
 * @param {Town} town
 * @param {number} targetHouses
 * @param {number | null} [customRadius]
 */
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
      let minBrDist = Infinity;
      for (const br of boroughs) {
        const d = Math.hypot(gx - br.x, gy - br.y);
        if (d < minBrDist) minBrDist = d;
      }
      if (
        world.zoneColorIdx[id] !== town.colorIdx &&
        !(world.zoneColorIdx[id] === -1 && minBrDist <= scanR - 2)
      ) {
        continue;
      }

      /** @type {{ x: number, y: number } | null} */
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
    const needMinHouses = town.tier >= 3 && town.housesCount < 10;
    if (adj >= 3) continue;
    if (!needMinHouses && adj === 2 && world.rng.next() < 0.72) continue;
    if (
      !needMinHouses &&
      adj === 1 &&
      world.rng.next() < 0.25 + radialFrac * 0.35
    )
      continue;

    world.buildingMask[slot.id] = 1;
    world.zoneColorIdx[slot.id] = town.colorIdx;
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
