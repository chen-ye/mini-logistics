/** @import { ProceduralLogisticsWorld } from "./world-generator.js" */

/**
 * Builds a sprawling, contiguous agricultural estate around a 2×2 farmstead `(fgx, fgy)` combining:
 * - (#4) Recursive X/Y Binary Space Partitioning (`bspParcels`) with natural T-junction seams,
 * - (#3) Contour- & riverbank-hugging outer perimeter loops (`estateLoops`),
 * - (#5) Micro-geographic crop zoning (riparian pasture -> flat alluvial wheat/ochre/loam -> foothill orchards),
 * - (#6) An internal unpaved tractor spine lane (`tractorSpine`) & upland windbreak poplar row (`windbreakPts`).
 * @param {ProceduralLogisticsWorld} world
 * @param {number} fgx
 * @param {number} fgy
 * @param {number} fcx
 * @param {number} fcy
 * @param {number} slotIdx
 */
export function buildFarmEstate(world, fgx, fgy, fcx, fcy, slotIdx) {
  // Physical geography check (hillside contour `dh = 0.13` & riverbanks):
  // The ONLY per-tile clip allowed inside a kept BSP parcel, so outer edges curve ONLY along real contours & rivers!
  const isPhysicallyArable = (tx, ty) => {
    if (!world.inBounds(tx, ty, 3)) return false;
    if (tx >= fgx && tx <= fgx + 1 && ty >= fgy && ty <= fgy + 1) return true;
    const tid = world.idx(tx, ty);
    if (
      world.waterMask[tid] > 0 ||
      world.distToWater[tid] < 2.0 ||
      world.elevationField[tid] >= world.seaLevel + 0.13 ||
      world.slopeField[tid] > 0.16
    ) {
      return false;
    }
    return true;
  };

  // Whole-box urban & road clearance check: any BSP leaf box touching an urban building/house, pastel town zone,
  // or paved road (`roadGrid > 0`, outside the 2×2 farmstead and its immediate driveway tile) is trimmed
  // orthogonally (0°/90°) so farm parcels never cross over paved haul roads or overlap town halos!
  const boxHitsUrbanBuilding = (x0, y0, x1, y1) => {
    for (let ty = y0 - 1; ty <= y1; ty++) {
      for (let tx = x0 - 1; tx <= x1; tx++) {
        if (!world.inBounds(tx, ty, 1)) continue;
        if (tx >= fgx && tx <= fgx + 1 && ty >= fgy && ty <= fgy + 1) continue;
        const tid = world.idx(tx, ty);
        const bm = world.buildingMask[tid];
        if (bm >= 1 && bm <= 4) return true;
        if (tx >= x0 && tx < x1 && ty >= y0 && ty < y1) {
          if (world.zoneColorIdx[tid] >= 0) return true;
          if (world.roadGrid[tid] > 0 && Math.hypot(tx - fcx, ty - fcy) > 1.8)
            return true;
        }
      }
    }
    return false;
  };

  // Trim a BSP leaf box orthogonally (0°/90°) from whichever outer edge overlaps an urban building
  // while keeping edges that actually touch the 2×2 farmstead `[fgx, fgx+2) × [fgy, fgy+2)` locked!
  const fitBoxClearOfUrban = (x0, y0, x1, y1) => {
    let rx0 = x0,
      ry0 = y0,
      rx1 = x1,
      ry1 = y1;
    for (let iter = 0; iter < 14; iter++) {
      if (rx1 - rx0 < 3 || ry1 - ry0 < 3) return null;
      if (!boxHitsUrbanBuilding(rx0, ry0, rx1, ry1)) {
        return { x0: rx0, y0: ry0, x1: rx1, y1: ry1 };
      }
      let badL = 0,
        badR = 0,
        badT = 0,
        badB = 0;
      for (let ty = ry0 - 1; ty <= ry1; ty++) {
        if (boxHitsUrbanBuilding(rx0, ty, rx0 + 1, ty + 1)) badL++;
        if (boxHitsUrbanBuilding(rx1 - 1, ty, rx1, ty + 1)) badR++;
      }
      for (let tx = rx0 - 1; tx <= rx1; tx++) {
        if (boxHitsUrbanBuilding(tx, ry0, tx + 1, ry0 + 1)) badT++;
        if (boxHitsUrbanBuilding(tx, ry1 - 1, tx + 1, ry1)) badB++;
      }
      const yOverlapsFarm = Math.min(ry1, fgy + 2) - Math.max(ry0, fgy) >= 1;
      const xOverlapsFarm = Math.min(rx1, fgx + 2) - Math.max(rx0, fgx) >= 1;
      if (yOverlapsFarm && rx1 === fgx) badR = 0;
      if (yOverlapsFarm && rx0 === fgx + 2) badL = 0;
      if (xOverlapsFarm && ry1 === fgy) badB = 0;
      if (xOverlapsFarm && ry0 === fgy + 2) badT = 0;

      const maxBad = Math.max(badL, badR, badT, badB);
      if (maxBad === 0) return null;
      if (badR === maxBad) rx1--;
      else if (badB === maxBad) ry1--;
      else if (badT === maxBad) ry0++;
      else rx0++;
    }
    return rx1 - rx0 >= 3 &&
      ry1 - ry0 >= 3 &&
      !boxHitsUrbanBuilding(rx0, ry0, rx1, ry1)
      ? { x0: rx0, y0: ry0, x1: rx1, y1: ry1 }
      : null;
  };

  // 1. Recursive X/Y Binary Space Partitioning (BSP) across the alluvial basin around `(fgx, fgy)`
  const isInsideAnyTownHalo = (px, py, mult = 0.65) =>
    world.towns.some(
      (t) =>
        Math.hypot(px - t.x, py - t.y) <
        (t.effectiveR || t.urbanRadius || 12) * mult,
    );

  let wValid = 0,
    eValid = 0,
    nValid = 0,
    sValid = 0;
  for (let dy = -16; dy <= 17; dy++) {
    for (let dx = -18; dx <= 19; dx++) {
      const tx = fgx + dx,
        ty = fgy + dy;
      if (!isPhysicallyArable(tx, ty)) continue;
      if (isInsideAnyTownHalo(tx, ty, 0.72)) continue;
      if (dx < 0) wValid++;
      else eValid++;
      if (dy < 0) nValid++;
      else sValid++;
    }
  }

  const rootX0 = fgx - (wValid > eValid * 1.2 ? 23 : 15);
  const rootX1 = fgx + (eValid > wValid * 1.2 ? 25 : 17);
  const rootY0 = fgy - (nValid > sValid * 1.2 ? 19 : 14);
  const rootY1 = fgy + (sValid > nValid * 1.2 ? 21 : 16);
  const bspLeaves = [];

  const splitBox = (x0, y0, x1, y1, depth, prefAxis) => {
    const w = x1 - x0;
    const h = y1 - y0;
    if (depth >= 6 || (w <= 8 && h <= 8)) {
      bspLeaves.push({ x0, y0, x1, y1 });
      return;
    }
    let axis = prefAxis;
    if (depth >= 2 || w >= h * 1.35 || h >= w * 1.35) {
      axis = w >= h ? "x" : "y";
    } else if (!axis) {
      axis = depth % 2 === 0 ? "x" : "y";
    }
    if (axis === "x" && w < 8) axis = "y";
    if (axis === "y" && h < 8) axis = "x";

    if (axis === "x" && w >= 8) {
      let sx;
      if (fgx >= x0 + 4 && fgx <= x1 - 4) sx = fgx;
      else if (fgx + 2 >= x0 + 4 && fgx + 2 <= x1 - 4) sx = fgx + 2;
      else sx = x0 + Math.floor(w * 0.35 + world.rng.next() * (w * 0.3));
      sx = Math.max(x0 + 4, Math.min(x1 - 4, sx));
      splitBox(x0, y0, sx, y1, depth + 1, "y");
      splitBox(sx, y0, x1, y1, depth + 1, "y");
    } else if (h >= 8) {
      let sy;
      if (fgy >= y0 + 4 && fgy <= y1 - 4) sy = fgy;
      else if (fgy + 2 >= y0 + 4 && fgy + 2 <= y1 - 4) sy = fgy + 2;
      else sy = y0 + Math.floor(h * 0.35 + world.rng.next() * (h * 0.3));
      sy = Math.max(y0 + 4, Math.min(y1 - 4, sy));
      splitBox(x0, y0, x1, sy, depth + 1, "x");
      splitBox(x0, sy, x1, y1, depth + 1, "x");
    } else {
      bspLeaves.push({ x0, y0, x1, y1 });
    }
  };

  // Root split (`depth = 0`) defines the primary Tractor Spine seam abutting the 2×2 farmstead
  let spineAxis =
    Math.abs(wValid - eValid) <= Math.abs(nValid - sValid) ? "x" : "y";
  let spineCoord =
    spineAxis === "x"
      ? wValid >= eValid
        ? fgx
        : fgx + 2
      : nValid >= sValid
        ? fgy
        : fgy + 2;
  if (spineAxis === "x") {
    splitBox(rootX0, rootY0, spineCoord, rootY1, 1, "y");
    splitBox(spineCoord, rootY0, rootX1, rootY1, 1, "y");
  } else {
    splitBox(rootX0, rootY0, rootX1, spineCoord, 1, "x");
    splitBox(rootX0, spineCoord, rootX1, rootY1, 1, "x");
  }

  // 2. Collect valid terrain tiles per BSP leaf box:
  // - Urban buildings & town cores reject whole BSP boxes (`boxHitsUrbanBuilding`) so town-facing edges stay 100% straight!
  // - Physical contours (`elevationField >= seaLevel + 0.130`) and riverbanks (`distToWater < 2.0`) clip individual tiles
  //   so contour-facing and river-facing outer edges hug the terrain contour curve!
  const rawParcels = [];
  for (let i = 0; i < bspLeaves.length; i++) {
    const b = bspLeaves[i];
    const bcx = (b.x0 + b.x1) * 0.5;
    const bcy = (b.y0 + b.y1) * 0.5;
    const boxWarp =
      world.noise.fbm(bcx * 0.1 + slotIdx * 3.1, bcy * 0.1 + 2.7, 2) * 3.5;
    // Allow wider reach toward the open basin side (away from town) so fields reach & hug the hillside contour line
    const openSideBonus =
      (wValid > eValid * 1.2 && bcx < fcx) ||
      (eValid > wValid * 1.2 && bcx > fcx)
        ? 8.2
        : 0;
    if (Math.hypot(bcx - fcx, bcy - fcy) + boxWarp > 14.5 + openSideBonus)
      continue;

    const touchesFarmstead =
      b.x0 <= fgx + 2 && b.x1 >= fgx && b.y0 <= fgy + 2 && b.y1 >= fgy;
    if (!touchesFarmstead && isInsideAnyTownHalo(bcx, bcy, 0.68)) {
      continue;
    }
    const cleanBox = fitBoxClearOfUrban(b.x0, b.y0, b.x1, b.y1);
    if (!cleanBox) continue;

    const validTiles = [];
    for (let ty = cleanBox.y0; ty < cleanBox.y1; ty++) {
      for (let tx = cleanBox.x0; tx < cleanBox.x1; tx++) {
        if (tx >= fgx && tx <= fgx + 1 && ty >= fgy && ty <= fgy + 1) continue;
        if (isPhysicallyArable(tx, ty)) {
          validTiles.push([tx, ty]);
        }
      }
    }
    if (validTiles.length >= 8) {
      rawParcels.push({ ...cleanBox, tiles: validTiles });
    }
  }

  return world.finalizeFarmEstateFromParcels(
    rawParcels,
    fgx,
    fgy,
    slotIdx,
    spineAxis,
    spineCoord,
  );
}

/**
 * Given raw BSP parcels around `(fgx, fgy)`, filters to the 4-connected component attached to the
 * 2×2 farmstead, assigns micro-geographic crops (`#5`), traces smooth contour-hugging outer boundary
 * loops (`#3`), and extracts the unpaved tractor spine (`#6a`) & foothill windbreak poplars (`#6b`).
 */
export function finalizeFarmEstateFromParcels(
  world,
  rawParcels,
  fgx,
  fgy,
  slotIdx,
  spineAxis,
  spineCoord,
) {
  const padKeys = [
    fgx * 10000 + fgy,
    (fgx + 1) * 10000 + fgy,
    fgx * 10000 + (fgy + 1),
    (fgx + 1) * 10000 + (fgy + 1),
  ];
  const allCandSet = new Set(padKeys);
  for (const p of rawParcels) {
    for (const [tx, ty] of p.tiles) {
      allCandSet.add(tx * 10000 + ty);
    }
  }

  // 4-connected BFS from the 2×2 farmstead pad
  const connectedSet = new Set(padKeys);
  const queue = [
    [fgx, fgy],
    [fgx + 1, fgy],
    [fgx, fgy + 1],
    [fgx + 1, fgy + 1],
  ];
  while (queue.length > 0) {
    const [cx, cy] = queue.shift();
    for (const [nx, ny] of [
      [cx - 1, cy],
      [cx + 1, cy],
      [cx, cy - 1],
      [cx, cy + 1],
    ]) {
      const k = nx * 10000 + ny;
      if (allCandSet.has(k) && !connectedSet.has(k)) {
        connectedSet.add(k);
        queue.push([nx, ny]);
      }
    }
  }

  const bspParcels = [];
  for (const p of rawParcels) {
    const tiles = p.tiles.filter(([tx, ty]) =>
      connectedSet.has(tx * 10000 + ty),
    );
    if (tiles.length < 10) continue;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    let sumElev = 0,
      sumSlope = 0,
      sumWater = 0;
    for (const [tx, ty] of tiles) {
      if (tx < minX) minX = tx;
      if (tx + 1 > maxX) maxX = tx + 1;
      if (ty < minY) minY = ty;
      if (ty + 1 > maxY) maxY = ty + 1;
      const tid = world.idx(tx, ty);
      sumElev += Math.max(0, world.elevationField[tid] - world.seaLevel);
      sumSlope += world.slopeField[tid];
      sumWater += world.distToWater[tid];
    }
    // Reject skinny `< 4` tile contour slivers so outer parcels have substantial width & height
    if (maxX - minX < 4 || maxY - minY < 4) continue;
    const n = tiles.length;
    // Preserve the full BSP rectangle `[p.x0, p.x1) × [p.y0, p.y1)` so internal seams stay 100% flush
    // and the renderer's octilinear Marching-Squares `arableLandPath` clips contour/river edges pixel-for-pixel!
    bspParcels.push({
      x0: p.x0,
      x1: p.x1,
      y0: p.y0,
      y1: p.y1,
      meanElev: sumElev / n,
      meanSlope: sumSlope / n,
      meanWater: sumWater / n,
      crop: "wheat",
      furrowDir: p.x1 - p.x0 >= p.y1 - p.y0 ? 0 : 1,
      spineAxis,
      spineCoord,
      slotIdx,
      tiles,
    });
  }

  // Require parcel-level shared edge overlap (`>= 3` tiles) from the farmstead so no parcel hangs by a narrow corner
  if (bspParcels.length > 1) {
    const shareSubstantialEdge = (a, b) => {
      const xOv = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const yOv = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      return (
        (xOv >= 3 && (a.y0 === b.y1 || a.y1 === b.y0)) ||
        (yOv >= 3 && (a.x0 === b.x1 || a.x1 === b.x0)) ||
        (xOv > 0 && yOv > 0)
      );
    };
    const rootIndices = [];
    for (let i = 0; i < bspParcels.length; i++) {
      const p = bspParcels[i];
      if (p.x0 <= fgx + 2 && p.x1 >= fgx && p.y0 <= fgy + 2 && p.y1 >= fgy) {
        rootIndices.push(i);
      }
    }
    if (rootIndices.length > 0) {
      const pVisited = new Set(rootIndices);
      const pQueue = [...rootIndices];
      while (pQueue.length > 0) {
        const curr = pQueue.shift();
        for (let i = 0; i < bspParcels.length; i++) {
          if (
            !pVisited.has(i) &&
            shareSubstantialEdge(bspParcels[curr], bspParcels[i])
          ) {
            pVisited.add(i);
            pQueue.push(i);
          }
        }
      }
      bspParcels.splice(
        0,
        bspParcels.length,
        ...bspParcels.filter((_, idx) => pVisited.has(idx)),
      );
    }
  }

  // Rebuild exact estate tile set from surviving parcels + 2×2 farmstead pad
  const estateTileSet = new Set(padKeys);
  for (const p of bspParcels) {
    for (const [tx, ty] of p.tiles) {
      estateTileSet.add(tx * 10000 + ty);
      world.buildingMask[world.idx(tx, ty)] = 5;
    }
  }

  // (#5) Micro-Geographic Crop Zoning + Neighbor Adjacency Contrast
  for (let i = 0; i < bspParcels.length; i++) {
    const p = bspParcels[i];
    let prefs;
    if (p.meanElev >= 0.08 || p.meanSlope >= 0.058) {
      // Upper Foothill Toe-Slope / Treeline Fringe -> Orchards & Loam
      prefs = ["orchard", "loam", "ochre", "wheat", "pasture"];
    } else if (p.meanWater <= 7.5 || p.meanElev <= 0.036) {
      // Riparian / Moist Alluvial Bottomland -> Pasture & Loam
      prefs = ["pasture", "loam", "wheat", "ochre", "orchard"];
    } else {
      // Flat Alluvial Mid-Bench -> Golden Wheat, Harvest Ochre & Loam
      const bench = ["wheat", "ochre", "loam", "pasture", "orchard"];
      const shift = (i + slotIdx) % 3;
      prefs = [...bench.slice(shift), ...bench.slice(0, shift)];
    }

    // Check already-assigned edge neighbors to avoid identical adjacent crop + furrowDir
    const neighborCrops = new Set();
    const neighborDirs = new Set();
    for (let j = 0; j < i; j++) {
      const q = bspParcels[j];
      const xOv = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
      const yOv = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
      if (
        (xOv >= 2 && (p.y0 === q.y1 || p.y1 === q.y0)) ||
        (yOv >= 2 && (p.x0 === q.x1 || p.x1 === q.x0))
      ) {
        neighborCrops.add(q.crop);
        neighborDirs.add(q.furrowDir);
      }
    }
    p.crop = prefs.find((c) => !neighborCrops.has(c)) || prefs[0];
    if (neighborDirs.has(p.furrowDir) && neighborDirs.size === 1) {
      p.furrowDir = 1 - p.furrowDir;
    } else {
      p.furrowDir = (i + slotIdx) % 2;
    }
  }

  // (#3) Trace Smooth Contour- & Riverbank-Hugging Outer Estate Boundary Loops
  const estateLoops = world.traceSmoothEstateLoops(estateTileSet);

  // (#6a) Build Broken-Grid Farm Track Network (`tractorTracks`) serving every field & stopping fractionally in terminal fields
  const tractorTracks = world.buildBrokenGridTractorTracks(
    bspParcels,
    estateTileSet,
    fgx,
    fgy,
    slotIdx,
  );

  const distPointToTrack = (px, py) => {
    let minD = Infinity;
    for (const tr of tractorTracks) {
      const dx = tr.x1 - tr.x0;
      const dy = tr.y1 - tr.y0;
      const lenSq = dx * dx + dy * dy;
      let t =
        lenSq > 1e-6 ? ((px - tr.x0) * dx + (py - tr.y0) * dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (tr.x0 + t * dx), py - (tr.y0 + t * dy));
      if (d < minD) minD = d;
    }
    return minD;
  };

  // (#6b) Place a sparse row of Windbreak Poplars (`windbreakPts`) along the highest upland outer boundary segment,
  // strictly >= 2.8 tiles clear of any farm road (`tractorTracks`) or paved road!
  const windbreakPts = [];
  if (estateLoops.length > 0) {
    const mainLoop = estateLoops[0];
    let bestSegStart = -1;
    let bestScore = -Infinity;
    const winLen = Math.min(10, Math.floor(mainLoop.length * 0.25));
    if (winLen >= 3) {
      for (let i = 0; i < mainLoop.length; i++) {
        let elevSum = 0;
        let invalidSeg = false;
        for (let k = 0; k < winLen; k++) {
          const pt = mainLoop[(i + k) % mainLoop.length];
          const gx = Math.round(pt[0]),
            gy = Math.round(pt[1]);
          if (!world.inBounds(gx, gy, 2)) {
            invalidSeg = true;
            break;
          }
          const tid = world.idx(gx, gy);
          const touchesOrchard = bspParcels.some(
            (p) =>
              p.crop === "orchard" &&
              pt[0] >= p.x0 - 1 &&
              pt[0] <= p.x1 + 1 &&
              pt[1] >= p.y0 - 1 &&
              pt[1] <= p.y1 + 1,
          );
          if (
            touchesOrchard ||
            world.roadGrid[tid] > 0 ||
            distPointToTrack(pt[0], pt[1]) < 2.8
          ) {
            invalidSeg = true;
            break;
          }
          elevSum += world.elevationField[tid];
        }
        if (!invalidSeg && elevSum > bestScore) {
          bestScore = elevSum;
          bestSegStart = i;
        }
      }
      if (bestSegStart >= 0) {
        for (let k = 0; k < winLen; k++) {
          const a = mainLoop[(bestSegStart + k) % mainLoop.length];
          const b = mainLoop[(bestSegStart + k + 1) % mainLoop.length];
          const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const steps = Math.max(1, Math.round(segLen / 0.85));
          for (let s = 0; s < steps; s++) {
            const t = s / steps;
            const wx = a[0] + t * (b[0] - a[0]);
            const wy = a[1] + t * (b[1] - a[1]);
            if (distPointToTrack(wx, wy) >= 2.6) {
              windbreakPts.push([wx, wy]);
            }
          }
        }
      }
    }
  }

  let bboxMinX = fgx,
    bboxMinY = fgy,
    bboxMaxX = fgx + 2,
    bboxMaxY = fgy + 2;
  for (const p of bspParcels) {
    if (p.x0 < bboxMinX) bboxMinX = p.x0;
    if (p.y0 < bboxMinY) bboxMinY = p.y0;
    if (p.x1 > bboxMaxX) bboxMaxX = p.x1;
    if (p.y1 > bboxMaxY) bboxMaxY = p.y1;
  }
  const estateBBox = {
    minX: bboxMinX,
    minY: bboxMinY,
    maxX: bboxMaxX,
    maxY: bboxMaxY,
  };

  return {
    bspParcels,
    estateLoops,
    tractorTracks,
    windbreakPts,
    estateBBox,
  };
}

/**
 * Builds a connected, broken-grid unpaved farm road network along internal BSP parcel seams
 * that reaches and serves every parcel in `bspParcels` and terminates at a random fractional
 * distance (`36%–76%`) along terminal field seams without touching outer boundaries or trees.
 */
export function buildBrokenGridTractorTracks(
  world,
  bspParcels,
  estateTileSet,
  fgx,
  fgy,
  slotIdx,
) {
  if (!bspParcels || bspParcels.length === 0) return [];

  // 1. Collect shared seams between adjacent BSP parcels + the 4 root edges of the 2×2 farmstead pad
  const rawSeams = [
    { axis: "h", y: fgy, a: fgx, b: fgx + 2, parcels: [], isPad: true },
    { axis: "h", y: fgy + 2, a: fgx, b: fgx + 2, parcels: [], isPad: true },
    { axis: "v", x: fgx, a: fgy, b: fgy + 2, parcels: [], isPad: true },
    { axis: "v", x: fgx + 2, a: fgy, b: fgy + 2, parcels: [], isPad: true },
  ];

  for (let i = 0; i < bspParcels.length; i++) {
    const p = bspParcels[i];
    // Connect any parcel touching the 2×2 farmstead `[fgx, fgx+2] × [fgy, fgy+2]`both along AND across the parcel
    // so tracks leaving the barn yard always reach the interior BSP seams!
    const touchesFarm =
      p.x0 <= fgx + 2 && p.x1 >= fgx && p.y0 <= fgy + 2 && p.y1 >= fgy;
    if (touchesFarm) {
      for (const py of [fgy, fgy + 2]) {
        if (py >= p.y0 && py <= p.y1) {
          rawSeams.push({
            axis: "h",
            y: py,
            a: Math.min(p.x0, fgx),
            b: Math.max(p.x1, fgx + 2),
            parcels: [i],
            isPad: false,
          });
        }
      }
      for (const px of [fgx, fgx + 2]) {
        if (px >= p.x0 && px <= p.x1) {
          rawSeams.push({
            axis: "v",
            x: px,
            a: Math.min(p.y0, fgy),
            b: Math.max(p.y1, fgy + 2),
            parcels: [i],
            isPad: false,
          });
        }
      }
    }

    for (let j = i + 1; j < bspParcels.length; j++) {
      const q = bspParcels[j];
      if (p.y1 === q.y0 || p.y0 === q.y1) {
        const sy = p.y1 === q.y0 ? p.y1 : p.y0;
        const xA = Math.max(p.x0, q.x0);
        const xB = Math.min(p.x1, q.x1);
        if (xB - xA >= 1) {
          rawSeams.push({
            axis: "h",
            y: sy,
            a: xA,
            b: xB,
            parcels: [i, j],
            isPad: false,
          });
        }
      }
      if (p.x1 === q.x0 || p.x0 === q.x1) {
        const sx = p.x1 === q.x0 ? p.x1 : p.x0;
        const yA = Math.max(p.y0, q.y0);
        const yB = Math.min(p.y1, q.y1);
        if (yB - yA >= 1) {
          rawSeams.push({
            axis: "v",
            x: sx,
            a: yA,
            b: yB,
            parcels: [i, j],
            isPad: false,
          });
        }
      }
    }
  }

  // 2. Collect all split coordinates along each seam line (endpoints + T-junction intersections)
  const hSeams = rawSeams.filter((s) => s.axis === "h");
  const vSeams = rawSeams.filter((s) => s.axis === "v");

  const vKey = (x, y) => `${x},${y}`;
  const vertices = new Map();
  const ensureVertex = (x, y) => {
    const k = vKey(x, y);
    let v = vertices.get(k);
    if (!v) {
      const isPadVert = x >= fgx && x <= fgx + 2 && y >= fgy && y <= fgy + 2;
      // A vertex is strictly interior if all 4 surrounding grid cells belong to `estateTileSet`
      // AND lie well below the `dh = 0.13` hillside forest contour (`< seaLevel + 0.118`)
      let isInterior = isPadVert;
      if (!isPadVert) {
        isInterior = true;
        for (const [dx, dy] of [
          [-1, -1],
          [0, -1],
          [-1, 0],
          [0, 0],
        ]) {
          const gx = x + dx,
            gy = y + dy;
          if (
            !estateTileSet.has(gx * 10000 + gy) ||
            !world.inBounds(gx, gy, 2)
          ) {
            isInterior = false;
            break;
          }
          const tid = world.idx(gx, gy);
          if (
            world.elevationField[tid] >= world.seaLevel + 0.13 ||
            world.distToWater[tid] < 1.8
          ) {
            isInterior = false;
            break;
          }
        }
      }
      v = { k, x, y, isPadVert, isInterior, edges: [] };
      vertices.set(k, v);
    }
    return v;
  };

  const edgeMap = new Map();
  const addAtomicEdge = (x0, y0, x1, y1, axis, parcels, isPad) => {
    if (x0 === x1 && y0 === y1) return;
    // Skip any non-pad segment whose midpoint is outside the arable flatland (`dh < 0.13`)
    if (!isPad) {
      const mx = Math.floor((x0 + x1) * 0.5);
      const my = Math.floor((y0 + y1) * 0.5);
      if (!world.inBounds(mx, my, 2)) return;
      const midId = world.idx(mx, my);
      if (
        world.elevationField[midId] >= world.seaLevel + 0.13 ||
        world.distToWater[midId] < 1.8
      )
        return;
      // Both sides of an internal seam at its midpoint must belong to `estateTileSet`
      const cellA =
        axis === "h" ? mx * 10000 + (y0 - 1) : (x0 - 1) * 10000 + my;
      const cellB = axis === "h" ? mx * 10000 + y0 : x0 * 10000 + my;
      if (!estateTileSet.has(cellA) || !estateTileSet.has(cellB)) return;
    }

    const u = ensureVertex(x0, y0);
    const v = ensureVertex(x1, y1);
    const eKey = u.k < v.k ? `${u.k}|${v.k}` : `${v.k}|${u.k}`;
    let e = edgeMap.get(eKey);
    if (!e) {
      e = {
        id: eKey,
        u: u.k,
        v: v.k,
        x0: u.x,
        y0: u.y,
        x1: v.x,
        y1: v.y,
        axis,
        len: Math.hypot(v.x - u.x, v.y - u.y),
        parcels: new Set(),
        isPad: Boolean(isPad),
      };
      edgeMap.set(eKey, e);
      u.edges.push(e);
      v.edges.push(e);
    }
    if (isPad) e.isPad = true;
    for (const pIdx of parcels) e.parcels.add(pIdx);
  };

  for (const hs of hSeams) {
    const xs = new Set([hs.a, hs.b]);
    for (const os of hSeams) {
      if (os.y === hs.y) {
        if (os.a >= hs.a && os.a <= hs.b) xs.add(os.a);
        if (os.b >= hs.a && os.b <= hs.b) xs.add(os.b);
      }
    }
    for (const vs of vSeams) {
      if (vs.x >= hs.a && vs.x <= hs.b && hs.y >= vs.a && hs.y <= vs.b) {
        xs.add(vs.x);
      }
    }
    const sortedX = [...xs].sort((a, b) => a - b);
    for (let k = 0; k < sortedX.length - 1; k++) {
      addAtomicEdge(
        sortedX[k],
        hs.y,
        sortedX[k + 1],
        hs.y,
        "h",
        hs.parcels,
        hs.isPad,
      );
    }
  }

  for (const vs of vSeams) {
    const ys = new Set([vs.a, vs.b]);
    for (const os of vSeams) {
      if (os.x === vs.x) {
        if (os.a >= vs.a && os.a <= vs.b) ys.add(os.a);
        if (os.b >= vs.a && os.b <= vs.b) ys.add(os.b);
      }
    }
    for (const hs of hSeams) {
      if (hs.y >= vs.a && hs.y <= vs.b && vs.x >= hs.a && vs.x <= hs.b) {
        ys.add(hs.y);
      }
    }
    const sortedY = [...ys].sort((a, b) => a - b);
    for (let k = 0; k < sortedY.length - 1; k++) {
      addAtomicEdge(
        vs.x,
        sortedY[k],
        vs.x,
        sortedY[k + 1],
        "v",
        vs.parcels,
        vs.isPad,
      );
    }
  }

  // Associate each atomic edge with all BSP parcels whose boundary contains the segment
  const allEdges = [...edgeMap.values()];
  for (const e of allEdges) {
    if (e.isPad) continue;
    for (let pIdx = 0; pIdx < bspParcels.length; pIdx++) {
      const p = bspParcels[pIdx];
      if (e.axis === "h" && (e.y0 === p.y0 || e.y0 === p.y1)) {
        const xMin = Math.min(e.x0, e.x1),
          xMax = Math.max(e.x0, e.x1);
        if (xMin >= p.x0 && xMax <= p.x1) e.parcels.add(pIdx);
      } else if (e.axis === "v" && (e.x0 === p.x0 || e.x0 === p.x1)) {
        const yMin = Math.min(e.y0, e.y1),
          yMax = Math.max(e.y0, e.y1);
        if (yMin >= p.y0 && yMax <= p.y1) e.parcels.add(pIdx);
      }
    }
  }

  // 3. Grow a Broken-Grid Spanning Tree from the 2×2 farmstead pad
  const treeVerts = new Set();
  const selectedEdges = new Set();
  const vertInAxis = new Map();
  for (const v of vertices.values()) {
    if (v.isPadVert) treeVerts.add(v.k);
  }
  for (const e of allEdges) {
    if (e.isPad) selectedEdges.add(e);
  }

  // Step 3A: Prim's broken-grid expansion over interior vertices (`isInterior === true`)
  // Preferring 90° orthogonal turns (`turnDiscount = 0.62`) creates staggered broken-grid jogs!
  let grew = true;
  while (grew) {
    grew = false;
    let bestEdge = null;
    let bestTo = null;
    let bestCost = Infinity;

    for (const uKey of treeVerts) {
      const u = vertices.get(uKey);
      if (!u) continue;
      const inAx = vertInAxis.get(uKey);
      for (const e of u.edges) {
        if (selectedEdges.has(e)) continue;
        const otherKey = e.u === uKey ? e.v : e.u;
        if (treeVerts.has(otherKey)) continue;
        const otherV = vertices.get(otherKey);
        if (!otherV || !otherV.isInterior) continue;

        const hash =
          ((u.x * 31 + u.y * 17 + otherV.x * 13 + otherV.y * 7 + slotIdx * 19) &
            15) /
          15;
        const turnMult = inAx && inAx !== e.axis ? 0.62 : 1.18;
        const cost = e.len * (0.85 + hash * 0.35) * turnMult;
        if (cost < bestCost) {
          bestCost = cost;
          bestEdge = e;
          bestTo = otherKey;
        }
      }
    }

    if (bestEdge) {
      selectedEdges.add(bestEdge);
      treeVerts.add(bestTo);
      vertInAxis.set(bestTo, bestEdge.axis);
      grew = true;
    }
  }

  // Step 3B: Ensure EVERY parcel (`0 .. bspParcels.length - 1`) is served by at least one non-pad edge,
  // and add radial terminal seam spurs (`u_inner -> v_outer`) between outer fields!
  const getServedParcels = () => {
    const s = new Set();
    for (const e of selectedEdges) {
      if (e.isPad) continue;
      for (const pIdx of e.parcels) s.add(pIdx);
    }
    return s;
  };

  // Add radial terminal seam spurs `(u_inner in treeVerts -> v_outer on perimeter)` so outer fields
  // get dedicated dead-end spurs that stop fractionally along their shared seams!
  for (const uKey of Array.from(treeVerts)) {
    const u = vertices.get(uKey);
    if (!u || !u.isInterior) continue;
    for (const e of u.edges) {
      if (selectedEdges.has(e) || e.isPad) continue;
      const otherKey = e.u === uKey ? e.v : e.u;
      if (treeVerts.has(otherKey)) continue;
      const otherV = vertices.get(otherKey);
      if (!otherV || otherV.isInterior) continue;
      if (e.len >= 3.0) {
        selectedEdges.add(e);
        treeVerts.add(otherKey);
      }
    }
  }

  // Shortest-path augmentation for any parcel still unserved
  for (let pIdx = 0; pIdx < bspParcels.length; pIdx++) {
    const served = getServedParcels();
    if (served.has(pIdx)) continue;

    // Dijkstra from `treeVerts` to any edge serving `pIdx`
    const dist = new Map();
    const prevEdge = new Map();
    const prevVert = new Map();
    const pq = [];
    for (const tk of treeVerts) {
      dist.set(tk, 0);
      pq.push({ k: tk, d: 0 });
    }
    let targetVert = null;
    let targetLeafEdge = null;

    while (pq.length > 0) {
      pq.sort((a, b) => a.d - b.d);
      const curr = pq.shift();
      if (curr.d > (dist.get(curr.k) ?? Infinity)) continue;
      const u = vertices.get(curr.k);
      if (!u) continue;

      for (const e of u.edges) {
        if (e.parcels.has(pIdx) && !e.isPad) {
          targetVert = curr.k;
          targetLeafEdge = e;
          break;
        }
        const nk = e.u === curr.k ? e.v : e.u;
        const nv = vertices.get(nk);
        if (!nv) continue;
        const stepCost = e.len + (nv.isInterior ? 0 : 25);
        const nd = curr.d + stepCost;
        if (nd < (dist.get(nk) ?? Infinity)) {
          dist.set(nk, nd);
          prevEdge.set(nk, e);
          prevVert.set(nk, curr.k);
          pq.push({ k: nk, d: nd });
        }
      }
      if (targetLeafEdge) break;
    }

    if (targetLeafEdge) {
      selectedEdges.add(targetLeafEdge);
      const otherK =
        targetLeafEdge.u === targetVert ? targetLeafEdge.v : targetLeafEdge.u;
      treeVerts.add(otherK);
      let cur = targetVert;
      while (cur) {
        treeVerts.add(cur);
        const pe = prevEdge.get(cur);
        if (!pe) break;
        selectedEdges.add(pe);
        cur = prevVert.get(cur);
      }
    }
  }

  // 4. Orient the selected graph as a directed tree rooted at `padVerts`, merge collinear
  // degree-2 terminal chains, and truncate all leaf/terminal edges at a random fraction `t ∈ [0.38, 0.76]`!
  const visitedV = new Set();
  const bfsQueue = [];
  for (const v of vertices.values()) {
    if (v.isPadVert) {
      visitedV.add(v.k);
      bfsQueue.push(v.k);
    }
  }

  const directedEdges = [];
  const childrenMap = new Map();
  while (bfsQueue.length > 0) {
    const uk = bfsQueue.shift();
    const u = vertices.get(uk);
    if (!u) continue;
    for (const e of u.edges) {
      if (!selectedEdges.has(e)) continue;
      const vk = e.u === uk ? e.v : e.u;
      if (visitedV.has(vk)) continue;
      visitedV.add(vk);
      bfsQueue.push(vk);
      if (!e.isPad) {
        const v = vertices.get(vk);
        const de = {
          uk,
          vk,
          x0: u.x,
          y0: u.y,
          x1: v.x,
          y1: v.y,
          axis: e.axis,
          vInterior: v.isInterior,
          parcels: e.parcels,
        };
        directedEdges.push(de);
        let ch = childrenMap.get(uk);
        if (!ch) {
          ch = [];
          childrenMap.set(uk, ch);
        }
        ch.push(de);
      }
    }
  }

  // Merge collinear degree-2 chains ending at a leaf (`u -> w -> v_leaf` on same axis)
  // so fractional truncation `t` applies across the entire straight terminal seam!
  const absorbed = new Set();
  for (const de of directedEdges) {
    if (absorbed.has(de)) continue;
    const ch = childrenMap.get(de.vk);
    if (ch && ch.length === 1 && ch[0].axis === de.axis) {
      const nextDe = ch[0];
      const grandCh = childrenMap.get(nextDe.vk);
      if (!grandCh || grandCh.length === 0) {
        de.vk = nextDe.vk;
        de.x1 = nextDe.x1;
        de.y1 = nextDe.y1;
        de.vInterior = nextDe.vInterior;
        for (const pIdx of nextDe.parcels) de.parcels.add(pIdx);
        absorbed.add(nextDe);
        childrenMap.set(de.uk, [de]);
        childrenMap.delete(nextDe.uk);
      }
    }
  }

  const finalTracks = [];
  for (let i = 0; i < directedEdges.length; i++) {
    const de = directedEdges[i];
    if (absorbed.has(de)) continue;
    const ch = childrenMap.get(de.vk);
    const isLeaf = !ch || ch.length === 0 || !de.vInterior;

    if (isLeaf) {
      // Stop fractionally randomly (`t ∈ [0.38, 0.76]`) through the terminal field seam!
      const hash =
        Math.abs(
          de.x0 * 37 +
            de.y0 * 53 +
            de.x1 * 19 +
            de.y1 * 29 +
            slotIdx * 13 +
            i * 7,
        ) % 39;
      let t = 0.38 + hash / 100;
      const segLen = Math.hypot(de.x1 - de.x0, de.y1 - de.y0);
      // Ensure at least 1.8 tiles of visible spur and at least 1.6 tiles of margin before an outer contour/fence
      if (segLen > 3.2) {
        t = Math.max(1.8 / segLen, Math.min((segLen - 1.6) / segLen, t));
      } else {
        t = 0.55;
      }
      finalTracks.push({
        x0: de.x0,
        y0: de.y0,
        x1: de.x0 + (de.x1 - de.x0) * t,
        y1: de.y0 + (de.y1 - de.y0) * t,
        isLeaf: true,
      });
    } else {
      finalTracks.push({
        x0: de.x0,
        y0: de.y0,
        x1: de.x1,
        y1: de.y1,
        isLeaf: false,
      });
    }
  }

  // For any outer terminal parcel (`w >= 5 && h >= 5`) not yet directly bordered by a track segment,
  // branch a connected fractional spur strictly from an existing point on `finalTracks` that touches `p`!
  const pointOnAnyTrack = (px, py) => {
    for (const tr of finalTracks) {
      const minX = Math.min(tr.x0, tr.x1) - 0.05,
        maxX = Math.max(tr.x0, tr.x1) + 0.05;
      const minY = Math.min(tr.y0, tr.y1) - 0.05,
        maxY = Math.max(tr.y0, tr.y1) + 0.05;
      if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
        const dx = tr.x1 - tr.x0,
          dy = tr.y1 - tr.y0;
        if (Math.abs(dx) < 0.05 && Math.abs(px - tr.x0) < 0.1) return true;
        if (Math.abs(dy) < 0.05 && Math.abs(py - tr.y0) < 0.1) return true;
      }
    }
    return false;
  };

  for (let pIdx = 0; pIdx < bspParcels.length; pIdx++) {
    const p = bspParcels[pIdx];
    const pw = p.x1 - p.x0;
    const ph = p.y1 - p.y0;
    if (pw < 5 || ph < 5) continue;

    // Check if any segment in `finalTracks` already runs along or inside `p` for >= 1.5 tiles
    let servedLen = 0;
    for (const tr of finalTracks) {
      const ox0 = Math.max(p.x0, Math.min(tr.x0, tr.x1));
      const ox1 = Math.min(p.x1, Math.max(tr.x0, tr.x1));
      const oy0 = Math.max(p.y0, Math.min(tr.y0, tr.y1));
      const oy1 = Math.min(p.y1, Math.max(tr.y0, tr.y1));
      if (ox1 >= ox0 - 0.05 && oy1 >= oy0 - 0.05) {
        servedLen = Math.max(servedLen, Math.hypot(ox1 - ox0, oy1 - oy0));
      }
    }
    if (servedLen >= 1.8) continue;

    const frac = 0.42 + ((pIdx * 17 + slotIdx * 11) % 28) / 100;
    const midX = Math.round((p.x0 + p.x1) * 0.5);
    const midY = Math.round((p.y0 + p.y1) * 0.5);
    if (pointOnAnyTrack(midX, p.y0)) {
      finalTracks.push({
        x0: midX,
        y0: p.y0,
        x1: midX,
        y1: p.y0 + ph * frac,
        isLeaf: true,
      });
    } else if (pointOnAnyTrack(midX, p.y1)) {
      finalTracks.push({
        x0: midX,
        y0: p.y1,
        x1: midX,
        y1: p.y1 - ph * frac,
        isLeaf: true,
      });
    } else if (pointOnAnyTrack(p.x0, midY)) {
      finalTracks.push({
        x0: p.x0,
        y0: midY,
        x1: p.x0 + pw * frac,
        y1: midY,
        isLeaf: true,
      });
    } else if (pointOnAnyTrack(p.x1, midY)) {
      finalTracks.push({
        x0: p.x1,
        y0: midY,
        x1: p.x1 - pw * frac,
        y1: midY,
        isLeaf: true,
      });
    }
  }

  return finalTracks;
}

/**
 * Traces the directed outer perimeter loop(s) of `estateTileSet` and applies selective
 * Chaikin corner-smoothing on contour/river staircase steps while keeping long open-plain
 * cadastral edges (`>= 4` tiles) crisp and straight.
 */
export function traceSmoothEstateLoops(world, estateTileSet) {
  // Collect directed unit boundary edges around every tile in `estateTileSet`
  const adj = new Map();
  const addEdge = (x0, y0, x1, y1) => {
    const k0 = `${x0},${y0}`;
    let list = adj.get(k0);
    if (!list) {
      list = [];
      adj.set(k0, list);
    }
    list.push({ x0, y0, x1, y1, used: false });
  };

  for (const key of estateTileSet) {
    const tx = Math.floor(key / 10000);
    const ty = key % 10000;
    if (!estateTileSet.has(tx * 10000 + (ty - 1))) addEdge(tx, ty, tx + 1, ty);
    if (!estateTileSet.has((tx + 1) * 10000 + ty))
      addEdge(tx + 1, ty, tx + 1, ty + 1);
    if (!estateTileSet.has(tx * 10000 + (ty + 1)))
      addEdge(tx + 1, ty + 1, tx, ty + 1);
    if (!estateTileSet.has((tx - 1) * 10000 + ty)) addEdge(tx, ty + 1, tx, ty);
  }

  const rawLoops = [];
  for (const edges of adj.values()) {
    for (const startEdge of edges) {
      if (startEdge.used) continue;
      startEdge.used = true;
      const loop = [[startEdge.x0, startEdge.y0]];
      let currX = startEdge.x1;
      let currY = startEdge.y1;
      let prevDx = startEdge.x1 - startEdge.x0;
      let prevDy = startEdge.y1 - startEdge.y0;
      let guard = 0;
      while (
        (currX !== startEdge.x0 || currY !== startEdge.y0) &&
        guard++ < 2000
      ) {
        loop.push([currX, currY]);
        const nextEdges = adj.get(`${currX},${currY}`);
        if (!nextEdges) break;
        // Prefer rightmost turn to keep loops simple and non-self-intersecting
        let chosen = null;
        for (const e of nextEdges) {
          if (!e.used) {
            chosen = e;
            if (e.x1 - e.x0 === prevDx && e.y1 - e.y0 === prevDy) break;
          }
        }
        if (!chosen) break;
        chosen.used = true;
        prevDx = chosen.x1 - chosen.x0;
        prevDy = chosen.y1 - chosen.y0;
        currX = chosen.x1;
        currY = chosen.y1;
      }
      if (loop.length >= 4) rawLoops.push(loop);
    }
  }

  // Sort largest loop first
  rawLoops.sort((a, b) => b.length - a.length);

  const smoothLoop = (unitLoop) => {
    // 1. Merge collinear unit edges into corner vertices
    const corners = [];
    const n = unitLoop.length;
    for (let i = 0; i < n; i++) {
      const pPrev = unitLoop[(i - 1 + n) % n];
      const pCurr = unitLoop[i];
      const pNext = unitLoop[(i + 1) % n];
      const dx1 = Math.sign(pCurr[0] - pPrev[0]),
        dy1 = Math.sign(pCurr[1] - pPrev[1]);
      const dx2 = Math.sign(pNext[0] - pCurr[0]),
        dy2 = Math.sign(pNext[1] - pCurr[1]);
      if (dx1 !== dx2 || dy1 !== dy2) {
        corners.push(pCurr);
      }
    }
    if (corners.length < 4) return corners;

    const isNaturalContourVertex = (pt) => {
      const gx = Math.round(pt[0]),
        gy = Math.round(pt[1]);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!world.inBounds(gx + dx, gy + dy, 2)) continue;
          const tid = world.idx(gx + dx, gy + dy);
          if (
            world.elevationField[tid] >= world.seaLevel + 0.118 ||
            world.distToWater[tid] < 3.2 ||
            world.waterMask[tid] > 0
          ) {
            return true;
          }
        }
      }
      return false;
    };

    // 2. Insert straight-edge anchor points:
    // - On cadastral/urban edges (not bordering a contour or riverbank), place tight 0.22-tile anchors on all segments (`len >= 1.5`)
    //   so cadastral steps stay crisp 0°/90° lines with subtle 3px rounded corners!
    // - On physical contour/riverbank edges (`isNaturalContourVertex`), only anchor segments `len >= 4.0`
    //   so 1–3 tile contour staircases smooth into a continuous contour-hugging curve!
    let pts = [];
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const naturalEdge =
        isNaturalContourVertex(a) && isNaturalContourVertex(b);
      pts.push(a);
      if (!naturalEdge && len >= 1.5) {
        const ux = (b[0] - a[0]) / len;
        const uy = (b[1] - a[1]) / len;
        const pin = Math.min(0.24, len * 0.25);
        pts.push([a[0] + ux * pin, a[1] + uy * pin]);
        pts.push([b[0] - ux * pin, b[1] - uy * pin]);
      } else if (naturalEdge && len >= 4.0) {
        const ux = (b[0] - a[0]) / len;
        const uy = (b[1] - a[1]) / len;
        pts.push([a[0] + ux * 0.65, a[1] + uy * 0.65]);
        pts.push([b[0] - ux * 0.65, b[1] - uy * 0.65]);
      }
    }

    // 3. Apply 2 passes of closed-loop Chaikin corner cutting (`0.25 / 0.75`)
    for (let pass = 0; pass < 2; pass++) {
      const nextPts = [];
      for (let i = 0; i < pts.length; i++) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % pts.length];
        nextPts.push([
          p0[0] * 0.75 + p1[0] * 0.25,
          p0[1] * 0.75 + p1[1] * 0.25,
        ]);
        nextPts.push([
          p0[0] * 0.25 + p1[0] * 0.75,
          p0[1] * 0.25 + p1[1] * 0.75,
        ]);
      }
      pts = nextPts;
    }
    return pts;
  };

  return rawLoops.slice(0, 1).map(smoothLoop);
}
