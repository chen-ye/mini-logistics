/** @import { WaterBasin, PrimarySink, RiverPoint, Point2D } from './types.js' */
/** @import { ProceduralLogisticsWorld } from './world-generator.js' */

import { FlatMinHeap } from "./math.js";
import { WATER_MASK, WORLD_GEOMETRY } from "./constants.js";

/**
 * STAGE 2B: PLUGGABLE FLUVIAL HYDROLOGY & RIVER EROSION ENGINES
 * Supports 3 selectable in-game river & watershed algorithms:
 *   1. `thalweg-astar`    — Non-Bifurcating Basin Tree + Map-Edge / Valley-Thalweg A* Rivers
 *   2. `d8-strahler`      — Priority-Flood Pit-Filling + D8 Flow Accumulation & Converging River Networks
 *   3. `meandering-plain` — Curvature-Driven Alluvial Floodplain Meanders & Oxbow S-Bends
 *
 * Key Cartographic Invariant:
 *   On continental/mainland maps, rivers NEVER start or end at floating dead-end "tentacle tips"
 *   in the middle of dry land: every river originates either at a Map-Border Headwater Entry
 *   (`x = 0..1` / `W-2..W-1` / `y = 0..1` / `H-2..H-1`) or inside an Upstream Lake Basin, and
 *   terminates inside a Downstream Lake/Sea Basin or at an exact River Confluence!
 *
 * @param {ProceduralLogisticsWorld} world
 * @param {WaterBasin[]} basins
 * @param {PrimarySink | null} primarySink
 */
export function synthesizeFluvialHydrology(world, basins, primarySink) {
  const { W, H, seaLevel } = world;
  const arch = world.config.archetype;
  const hydroAlgo = world.config.hydrologyAlgo || "thalweg-astar";
  const baseElevation = new Float32Array(world.elevationField);

  /**
   * Smooth a river polyline with Laplacian passes so meanders are 100% C1 smooth (zero spikes!).
   * @param {RiverPoint[]} pts
   * @param {number} [passes]
   * @returns {RiverPoint[]}
   */
  const smoothPolyline = (pts, passes = 4) => {
    if (!pts || pts.length < 5) return pts;
    let cur = pts.map((p) => ({ ...p }));
    for (let pass = 0; pass < passes; pass++) {
      const next = [cur[0]];
      for (let i = 1; i < cur.length - 1; i++) {
        next.push({
          ...cur[i],
          x: 0.25 * cur[i - 1].x + 0.5 * cur[i].x + 0.25 * cur[i + 1].x,
          y: 0.25 * cur[i - 1].y + 0.5 * cur[i].y + 0.25 * cur[i + 1].y,
        });
      }
      next.push(cur[cur.length - 1]);
      cur = next;
    }
    // Rasterize smoothed floating-point curve back to 1-tile steps so `waterMask = 1` is continuous
    const out = [
      {
        x: Math.round(cur[0].x),
        y: Math.round(cur[0].y),
        width: cur[0].width,
      },
    ];
    for (let i = 1; i < cur.length; i++) {
      const gx = Math.round(cur[i].x);
      const gy = Math.round(cur[i].y);
      const w = cur[i].width;
      const last = out[out.length - 1];
      const steps = Math.max(
        1,
        Math.ceil(Math.hypot(gx - last.x, gy - last.y)),
      );
      for (let k = 1; k <= steps; k++) {
        const ix = Math.round(last.x + ((gx - last.x) * k) / steps);
        const iy = Math.round(last.y + ((gy - last.y) * k) / steps);
        const iw =
          last.width !== undefined && w !== undefined
            ? last.width + ((w - last.width) * k) / steps
            : w;
        if (
          world.inBounds(ix, iy, 1) &&
          (ix !== out[out.length - 1].x || iy !== out[out.length - 1].y)
        ) {
          out.push({ x: ix, y: iy, width: iw });
        }
      }
    }
    return out;
  };

  /**
   * Continuous, spike-free Ikeda floodplain meandering displacement.
   * @param {RiverPoint[]} rawPath
   * @param {number} [phaseOffset]
   * @param {number} [ampScale]
   * @returns {RiverPoint[]}
   */
  const applyMeanderingDisplacement = (
    rawPath,
    phaseOffset = 0,
    ampScale = 1.0,
  ) => {
    if (!rawPath || rawPath.length < 12) return rawPath;
    const baseSmooth = smoothPolyline(rawPath, 5);
    const n = baseSmooth.length;
    const displaced = baseSmooth.map((pt, i) => {
      if (i === 0 || i === n - 1) return { ...pt };
      const pPrev = baseSmooth[Math.max(0, i - 6)];
      const pNext = baseSmooth[Math.min(n - 1, i + 6)];
      const tx = pNext.x - pPrev.x;
      const ty = pNext.y - pPrev.y;
      const tLen = Math.hypot(tx, ty) || 1;
      const nx = -ty / tLen;
      const ny = tx / tLen;

      const id = world.idx(Math.round(pt.x), Math.round(pt.y));
      const elevAbove = Math.max(0, world.elevationField[id] - seaLevel);
      const endFade = Math.pow(Math.sin((i / (n - 1)) * Math.PI), 0.85);
      const plainFactor = Math.max(0.25, 1.0 - elevAbove * 2.2);
      const amp = endFade * plainFactor * 5.2 * ampScale;

      // Smooth compound Ikeda harmonic (`sin(s) + 0.30 * sin(2s - 0.7)`) with longer wavelength
      const s = i * 0.16 + phaseOffset;
      const offset = amp * (Math.sin(s) + 0.3 * Math.sin(2.0 * s - 0.7));

      // Gradually scale back only if displacement would hit steep cliffs
      let chosenX = pt.x;
      let chosenY = pt.y;
      for (const frac of [1.0, 0.7, 0.4, 0.0]) {
        const mx = Math.max(2, Math.min(W - 3, pt.x + nx * offset * frac));
        const my = Math.max(2, Math.min(H - 3, pt.y + ny * offset * frac));
        if (
          world.elevationField[world.idx(Math.round(mx), Math.round(my))] <=
          world.elevationField[id] + 0.12
        ) {
          chosenX = mx;
          chosenY = my;
          break;
        }
      }
      return { ...pt, x: chosenX, y: chosenY };
    });

    return smoothPolyline(displaced, 6);
  };

  /**
   * Shared Downhill Valley-Thalweg A* Router.
   * @param {number} sx
   * @param {number} sy
   * @param {number} ex
   * @param {number} ey
   * @param {boolean} [stopOnExistingRiver]
   * @param {number} [seedPhase]
   * @param {number} [minTravelDist]
   * @returns {RiverPoint[] | null}
   */
  const routeValleyThalwegAStar = (
    sx,
    sy,
    ex,
    ey,
    stopOnExistingRiver = true,
    seedPhase = 0,
    minTravelDist = 64,
  ) => {
    const startId = world.idx(sx, sy);
    const endId = world.idx(ex, ey);
    const gScore = new Float32Array(W * H).fill(Infinity);
    const parent = new Int32Array(W * H).fill(-1);
    const closed = new Uint8Array(W * H);
    const runLen = new Uint8Array(W * H);
    const leftSource = new Uint8Array(W * H);
    const drySteps = new Float32Array(W * H);

    // If starting inside a lake/water basin (`waterMask === 2`), flood-fill `sourceBasinMask`
    // so the A* path never re-enters or terminates inside its own starting lake!
    const sourceBasinMask = new Uint8Array(W * H);
    if (world.waterMask[startId] === WATER_MASK.OPEN_WATER) {
      const bq = [startId];
      sourceBasinMask[startId] = 1;
      let head = 0;
      while (head < bq.length) {
        const cur = bq[head++];
        const bx = cur % W,
          by = Math.floor(cur / W);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = bx + dx,
            ny = by + dy;
          if (!world.inBounds(nx, ny, 1)) continue;
          const nid = world.idx(nx, ny);
          if (
            !sourceBasinMask[nid] &&
            world.waterMask[nid] === WATER_MASK.OPEN_WATER
          ) {
            sourceBasinMask[nid] = 1;
            bq.push(nid);
          }
        }
      }
    }

    const openHeap = new FlatMinHeap(1024);

    gScore[startId] = 0;
    openHeap.push(startId, 0);
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

    let steps = 0;
    const maxAStarSteps = Math.max(56000, Math.round(W * H * 0.72));
    while (openHeap.size > 0 && steps++ < maxAStarSteps) {
      const cid = openHeap.pop();
      if (closed[cid]) continue;
      closed[cid] = 1;

      const cx = cid % W;
      const cy = Math.floor(cid / W);
      const hasLeft = leftSource[cid] === 1;
      const distFromShore = drySteps[cid];
      const minTravel = arch === "island-hopper" ? 7 : minTravelDist;

      if (
        cid === endId ||
        (hasLeft &&
          sourceBasinMask[cid] === 0 &&
          distFromShore >= Math.min(8, minTravel) &&
          world.waterMask[cid] === WATER_MASK.OPEN_WATER) ||
        (stopOnExistingRiver &&
          hasLeft &&
          distFromShore >= minTravel * 0.65 &&
          world.waterMask[cid] === WATER_MASK.RIVER)
      ) {
        const path = [];
        let curr = cid;
        while (curr !== -1) {
          path.push({ x: curr % W, y: Math.floor(curr / W) });
          curr = parent[curr];
        }
        path.reverse();
        if (world.waterMask[cid] === WATER_MASK.RIVER) {
          world.hydroFeatures.push({ x: cx, y: cy, type: "confluence" });
        }
        return path;
      }

      const currElev = world.elevationField[cid];
      const pid = parent[cid];
      const prevDx = pid !== -1 ? cx - (pid % W) : 0;
      const prevDy = pid !== -1 ? cy - Math.floor(pid / W) : 0;

      for (const [dx, dy, baseStep] of dirs) {
        const nx = cx + dx,
          ny = cy + dy;
        if (!world.inBounds(nx, ny, 2)) continue;
        const nid = world.idx(nx, ny);
        if (closed[nid]) continue;

        if (pid !== -1 && dx * prevDx + dy * prevDy < 0) continue;
        // Once the path has exited the starting lake (`hasLeft`), never re-enter `sourceBasinMask`!
        if (hasLeft && sourceBasinMask[nid] === 1) continue;

        const nextElev = world.elevationField[nid];
        const uphill = Math.max(0, nextElev - currElev);
        const downhill = Math.max(0, currElev - nextElev);

        const sameDir = pid !== -1 && dx === prevDx && dy === prevDy;
        const nextRun = sameDir ? Math.min(255, runLen[cid] + 1) : 1;
        const straightPenalty = nextRun > 3 ? (nextRun - 3) * 1.15 : 0;
        const earlyWaterPenalty =
          hasLeft &&
          distFromShore < Math.min(8, minTravel) &&
          world.waterMask[nid] > WATER_MASK.DRY
            ? 110.0
            : 0;

        const meanderWave =
          world.noise.fbm(
            nx * 0.045 + seedPhase,
            ny * 0.045 + seedPhase * 1.3,
            2,
          ) *
            3.8 +
          Math.sin(nx * 0.12 + ny * 0.1 + seedPhase) * 1.05;

        const stepCost =
          !hasLeft && world.waterMask[nid] === WATER_MASK.OPEN_WATER
            ? baseStep * 0.14
            : baseStep * (0.72 + Math.max(0, nextElev - seaLevel) * 2.2) +
              uphill * 85.0 -
              downhill * 4.2 +
              meanderWave +
              straightPenalty +
              earlyWaterPenalty;

        const tentativeG = gScore[cid] + stepCost;
        if (tentativeG < gScore[nid]) {
          gScore[nid] = tentativeG;
          parent[nid] = cid;
          runLen[nid] = nextRun;
          const nextLeft =
            hasLeft ||
            (sourceBasinMask[nid] === 0 &&
              world.waterMask[nid] === WATER_MASK.DRY)
              ? 1
              : 0;
          leftSource[nid] = nextLeft;
          drySteps[nid] = nextLeft ? drySteps[cid] + baseStep : 0;
          const h = Math.hypot(ex - nx, ey - ny) * 0.78;
          openHeap.push(nid, tentativeG + h);
        }
      }
    }
    return null;
  };

  /**
   * Pick well-spaced Highland Mountain Springs (`elevation >= seaLevel + 0.21`, far from lakes).
   * @param {number} [count]
   * @returns {Point2D[]}
   */
  const pickHighlandMountainSprings = (count = 2) => {
    const springs = [];
    for (let s = 0; s < count; s++) {
      /** @type {Point2D | null} */
      let bestSp = null;
      let bestScore = -1;
      for (let attempt = 0; attempt < 55; attempt++) {
        // Keep interior mountain springs in the central highland core (>= 48 tiles inside map borders)
        const sx = world.rng.int(48, W - 49);
        const sy = world.rng.int(38, H - 39);
        const id = world.idx(sx, sy);
        if (world.waterMask[id] > WATER_MASK.DRY) continue;
        const el = world.elevationField[id];
        if (
          el <
          seaLevel + WORLD_GEOMETRY.ELEVATION_THRESHOLDS.springMinAboveSea
        )
          continue;
        if (springs.some((p) => Math.hypot(p.x - sx, p.y - sy) < 82)) continue;

        let minBasinD = Infinity;
        for (const b of basins) {
          const d = Math.hypot(sx - b.cx, sy - b.cy);
          if (d < minBasinD) minBasinD = d;
        }
        if (minBasinD < 64) continue;

        const score = el + Math.min(140, minBasinD) * 0.003;
        if (score > bestScore) {
          bestScore = score;
          bestSp = { x: sx, y: sy };
        }
      }
      if (bestSp) springs.push(bestSp);
    }
    return springs;
  };

  /**
   * Selects well-spaced dry-land entry points along the 4 map borders so continental rivers
   * enter from the edge of the map instead of starting as blind tentacles.
   * @param {number} [count]
   * @returns {Array<{ x: number, y: number, score: number }>}
   */
  const pickMapBorderRiverEntries = (count = 2) => {
    const candidates = [];
    const scanBorderPt = (x, y) => {
      // Avoid placing border river entries directly underneath the top-left Seed HUD or top-right Zoom/Playback HUD!
      if ((x <= 105 && y <= 24) || (x >= W - 22 && y <= 88)) return;
      const id = world.idx(x, y);
      if (world.waterMask[id] > WATER_MASK.DRY) return;
      for (const b of basins) {
        if (Math.hypot(x - b.cx, y - b.cy) < 52) return;
      }
      for (let dy = -14; dy <= 14; dy += 4) {
        for (let dx = -14; dx <= 14; dx += 4) {
          if (
            world.inBounds(x + dx, y + dy, 1) &&
            world.waterMask[world.idx(x + dx, y + dy)] > WATER_MASK.DRY
          )
            return;
        }
      }
      const dSink = primarySink
        ? Math.hypot(x - primarySink.deepX, y - primarySink.deepY)
        : 999;
      if (primarySink && dSink < 105) return;
      const elev = world.elevationField[id];
      const valleyScore =
        1.0 -
        Math.abs(elev - (seaLevel + 0.16)) * 1.5 +
        dSink * 0.002 +
        world.rng.range(-0.08, 0.08);
      candidates.push({ x, y, score: valleyScore });
    };

    for (let x = 28; x < W - 28; x += 8) {
      scanBorderPt(x, 2);
      scanBorderPt(x, H - 3);
    }
    for (let y = 28; y < H - 28; y += 8) {
      scanBorderPt(2, y);
      scanBorderPt(W - 3, y);
    }
    candidates.sort((a, b) => b.score - a.score);

    const chosen = [];
    for (const c of candidates) {
      if (chosen.length >= count) break;
      if (chosen.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= 115)) {
        chosen.push(c);
      }
    }
    return chosen;
  };

  /**
   * @param {RiverPoint[] | null} rawPath
   * @param {boolean} isMainOutflow
   * @param {boolean} [applyMeanders]
   * @param {number} [seedPhase]
   */
  const carveTaperingRiverPath = (
    rawPath,
    isMainOutflow,
    applyMeanders = false,
    seedPhase = 0,
  ) => {
    if (!rawPath || rawPath.length < 6) return;
    let i0 = 0;
    if (isMainOutflow) {
      while (
        i0 < rawPath.length - 4 &&
        world.waterMask[world.idx(rawPath[i0 + 2].x, rawPath[i0 + 2].y)] ===
          WATER_MASK.OPEN_WATER
      ) {
        i0++;
      }
    }
    let path = rawPath.slice(i0);
    const minLen = arch === "island-hopper" ? 8 : isMainOutflow ? 10 : 54;
    if (path.length < minLen) return;

    if (applyMeanders) {
      path = applyMeanderingDisplacement(path, seedPhase, 1.0);
    } else {
      path = applyMeanderingDisplacement(path, seedPhase, 0.42);
    }

    // If an interior river approaches within 8 tiles of a map border before its final 12 points,
    // interpolate 1-tile steps cleanly to the map border so it exits off-canvas without an uncarved jump!
    if (
      path[0].x > 3 &&
      path[0].x < W - 4 &&
      path[0].y > 3 &&
      path[0].y < H - 4
    ) {
      const buildBorderBridge = (bx, by, tx, ty) => {
        const steps = Math.max(1, Math.ceil(Math.hypot(tx - bx, ty - by)));
        const bridge = [];
        for (let s = 0; s < steps; s++) {
          bridge.push({
            x: Math.round(bx + ((tx - bx) * s) / steps),
            y: Math.round(by + ((ty - by) * s) / steps),
          });
        }
        return bridge;
      };
      for (let i = 0; i < path.length - 12; i++) {
        const pt = path[i];
        if (pt.x >= W - 9) {
          path = [
            ...buildBorderBridge(W - 1, pt.y, pt.x, pt.y),
            ...path.slice(i),
          ];
          break;
        } else if (pt.x <= 8) {
          path = [...buildBorderBridge(0, pt.y, pt.x, pt.y), ...path.slice(i)];
          break;
        } else if (pt.y >= H - 9) {
          path = [
            ...buildBorderBridge(pt.x, H - 1, pt.x, pt.y),
            ...path.slice(i),
          ];
          break;
        } else if (pt.y <= 8) {
          path = [...buildBorderBridge(pt.x, 0, pt.x, pt.y), ...path.slice(i)];
          break;
        }
      }
    }

    // Extend start/end vertices by 2 tiles if on map border or entering a water basin
    const first = path[0];
    if (first.x <= 3) path.unshift({ x: 0, y: first.y, width: first.width });
    else if (first.x >= W - 4)
      path.unshift({ x: W - 1, y: first.y, width: first.width });
    else if (first.y <= 3)
      path.unshift({ x: first.x, y: 0, width: first.width });
    else if (first.y >= H - 4)
      path.unshift({ x: first.x, y: H - 1, width: first.width });

    // Extend final vertex into the receiving water basin / parent river so confluences & mouths join seamlessly!
    const last = path[path.length - 1];
    const prev = path[Math.max(0, path.length - 3)];
    if (world.waterMask[world.idx(last.x, last.y)] > WATER_MASK.DRY) {
      const dx = last.x - prev.x;
      const dy = last.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      const ex = Math.round(last.x + (dx / len) * 2.6);
      const ey = Math.round(last.y + (dy / len) * 2.6);
      if (world.inBounds(ex, ey, 1) && (ex !== last.x || ey !== last.y)) {
        path.push({ x: ex, y: ey, width: last.width });
      }
    }

    // Determine if this river starts at an interior mountain spring (vs. map border or upstream lake)
    const startsAtBorder =
      path[0].x <= 3 ||
      path[0].x >= W - 4 ||
      path[0].y <= 3 ||
      path[0].y >= H - 4;
    const startsInLake =
      world.waterMask[world.idx(path[0].x, path[0].y)] ===
      WATER_MASK.OPEN_WATER;
    const isInteriorSpring = !startsAtBorder && !startsInLake && !isMainOutflow;

    // Assign bold, Mini Motorways-scale cartographic channel widths:
    // - Mainstems / border trunks: `1.85 -> 3.20` tiles (or `1.35 -> 2.40` for secondary border rivers)
    // - Interior mountain springs: `0.55 -> 1.45` tiles (clearly subordinate tributary creeks!)
    const startW =
      arch === "island-hopper"
        ? 0.65
        : isMainOutflow
          ? 1.85
          : isInteriorSpring
            ? 0.55
            : 1.35;
    const endW =
      arch === "island-hopper"
        ? 1.65
        : isMainOutflow
          ? 3.2
          : isInteriorSpring
            ? 1.45
            : 2.4;
    for (let i = 0; i < path.length; i++) {
      const frac = i / Math.max(1, path.length - 1);
      if (path[i].width === undefined) {
        const curveExp = isInteriorSpring ? 0.78 : 1.12;
        path[i].width = startW + (endW - startW) * Math.pow(frac, curveExp);
      }
    }

    world.rivers.push({
      points: path,
      isMainOutflow,
      headwaterPt: isInteriorSpring ? { x: path[0].x, y: path[0].y } : null,
    });

    // Build a monotonically descending thalweg bank profile (`thalwegBankElev`) from headwater to mouth
    // and bind each valley tile to its nearest perpendicular river station (`nearestStationIdx`) so
    // downstream stations never back-scoop upstream points and contour terraces (`+0.36`, `+0.24`, `+0.13`)
    // bend upstream into crisp cartographic V-notches ("the Rule of Vs")!
    const nPts = path.length;
    const thalwegBankElev = new Float32Array(nPts);
    const chanRadii = new Float32Array(nPts);
    const valleyRadii = new Float32Array(nPts);
    const shapeExps = new Float32Array(nPts);
    const srcNaturalElev = Math.max(
      seaLevel + 0.06,
      baseElevation[world.idx(path[0].x, path[0].y)],
    );
    const mouthTargetElev = seaLevel + 0.025;

    for (let i = 0; i < nPts; i++) {
      const progress = i / Math.max(1, nPts - 1);
      const { x, y, width } = path[i];
      const id = world.idx(x, y);
      world.drainageField[id] += isMainOutflow ? 2.5 : 0.5 + progress * 1.5;

      const localNatural = baseElevation[id];
      const gradedCurve =
        mouthTargetElev +
        (srcNaturalElev - mouthTargetElev) *
          Math.pow(1 - progress, isInteriorSpring ? 1.18 : 1.38);
      // Interior springs emerge at 0 incision at progress = 0 and deepen progressively downstream
      const inciseEnv = isInteriorSpring
        ? Math.pow(Math.sin(Math.pow(progress, 0.58) * Math.PI * 0.88), 1.15)
        : 0.45 + 0.55 * Math.sin(Math.pow(progress, 0.65) * Math.PI);
      const incisionDepth = (isMainOutflow ? 0.145 : 0.115) * inciseEnv;
      const incisedLocal = Math.max(
        mouthTargetElev,
        localNatural - incisionDepth,
      );
      const rawBank = 0.55 * gradedCurve + 0.45 * incisedLocal;
      thalwegBankElev[i] =
        i === 0 ? rawBank : Math.min(rawBank, thalwegBankElev[i - 1]);

      const chanRad = Math.max(
        isInteriorSpring && progress < 0.15 ? 0.75 : 1.05,
        (width || 1.5) * 0.56,
      );
      chanRadii[i] = chanRad;
      const startValleyW = isInteriorSpring ? 2.2 : 9.5;
      const endValleyW = isMainOutflow ? 19.5 : 15.0;
      valleyRadii[i] =
        chanRad +
        startValleyW +
        (endValleyW - startValleyW) *
          Math.pow(progress, isInteriorSpring ? 0.7 : 0.85);
      shapeExps[i] = 1.18 + 1.02 * Math.pow(progress, 0.9);
    }

    // Pass 1: Assign each tile in the river's corridor to its nearest river station `i*`
    const touchedMap = new Map();
    for (let i = 0; i < nPts; i++) {
      const { x, y } = path[i];
      const vRad = valleyRadii[i];
      const rCeil = Math.ceil(vRad);
      const v2 = vRad * vRad;
      const ix0 = Math.max(0, Math.floor(x - rCeil));
      const ix1 = Math.min(W - 1, Math.ceil(x + rCeil));
      const iy0 = Math.max(0, Math.floor(y - rCeil));
      const iy1 = Math.min(H - 1, Math.ceil(y + rCeil));

      for (let gy = iy0; gy <= iy1; gy++) {
        for (let gx = ix0; gx <= ix1; gx++) {
          const d2 = (gx - x) * (gx - x) + (gy - y) * (gy - y);
          if (d2 > v2) continue;
          const gid = world.idx(gx, gy);
          const existing = touchedMap.get(gid);
          if (!existing || d2 < existing.d2) {
            touchedMap.set(gid, { d2, i });
          }
        }
      }
    }

    // Pass 2: Carve channel & lateral valley wall from each tile's true perpendicular station `i*`
    for (const [gid, { d2, i }] of touchedMap.entries()) {
      const chanRad = chanRadii[i];
      const valleyRad = valleyRadii[i];
      const bankElev = thalwegBankElev[i];
      if (d2 <= chanRad * chanRad) {
        if (world.waterMask[gid] === WATER_MASK.DRY)
          world.waterMask[gid] = WATER_MASK.RIVER;
        world.elevationField[gid] = Math.min(
          world.elevationField[gid],
          bankElev - 0.015,
        );
      } else {
        const d = Math.sqrt(d2);
        const u = Math.min(
          1,
          (d - chanRad) / Math.max(0.5, valleyRad - chanRad),
        );
        const gorgeU = Math.pow(u, shapeExps[i]);
        const smoothRimU = u * u * (3 - 2 * u);
        const rimBlend = Math.max(0, Math.min(1, (u - 0.58) / 0.42));
        const profileU = gorgeU * (1 - rimBlend) + smoothRimU * rimBlend;
        const hillElev = baseElevation[gid];
        if (hillElev > bankElev) {
          const targetElev = bankElev + (hillElev - bankElev) * profileU;
          if (targetElev < world.elevationField[gid]) {
            world.elevationField[gid] = targetElev;
          }
        }
      }
    }
  };

  // =========================================================================
  // 1. SHARED NON-BIFURCATING LAKE OUTFLOW TREE (All 3 Hydrology Engines!)
  //    Every interior lake drains via 1 continuous river to a lower lake or the sea!
  // =========================================================================
  const useMeanders = hydroAlgo === "meandering-plain";
  if (basins.length >= 2) {
    for (let bIdx = 1; bIdx < basins.length; bIdx++) {
      const srcB = basins[bIdx];
      if (srcB.touchesBorder && srcB.size > 950 && bIdx > 1) continue;
      let bestSink = basins[0];
      let minD = Infinity;
      for (let sIdx = 0; sIdx < bIdx; sIdx++) {
        const candSink = basins[sIdx];
        const d = Math.hypot(
          srcB.deepX - candSink.deepX,
          srcB.deepY - candSink.deepY,
        );
        if (d < minD) {
          minD = d;
          bestSink = candSink;
        }
      }
      const outPath = routeValleyThalwegAStar(
        srcB.deepX,
        srcB.deepY,
        bestSink.deepX,
        bestSink.deepY,
        true,
        bIdx * 1.7,
        18,
      );
      carveTaperingRiverPath(outPath, true, useMeanders, bIdx * 2.3);
    }
  }

  // =========================================================================
  // 2. ENGINE-SPECIFIC REGIONAL TRUNK & CONFLUENCE RIVERS
  // =========================================================================
  if (hydroAlgo === "d8-strahler" && arch !== "island-hopper") {
    // Priority-Flood + D8 Flow Accumulation from Map-Border Watershed Entries -> Confluences / Sea
    const stride = 2;
    const cw = Math.floor(W / stride);
    const ch = Math.floor(H / stride);
    const N = cw * ch;

    const filledElev = new Float32Array(N);
    const visited = new Uint8Array(N);
    const receiver = new Int32Array(N).fill(-1);

    const pfHeap = new FlatMinHeap(1024);

    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        const cid = cy * cw + cx;
        const gx = cx * stride + 1;
        const gy = cy * stride + 1;
        const gid = world.idx(gx, gy);
        const meanderPotential =
          (world.noise.fbm(cx * 0.08 + 2.3, cy * 0.08 + 7.9, 2) - 0.5) * 0.085 +
          Math.sin(cx * 0.18 + cy * 0.14) * 0.022;
        const el = world.elevationField[gid] + meanderPotential;
        filledElev[cid] = el;
        // Seed Priority-Flood from existing lakes/sea and already-carved lake outflow rivers!
        if (world.waterMask[gid] > WATER_MASK.DRY) {
          visited[cid] = 1;
          pfHeap.push(cid, el);
        }
      }
    }

    const d8 = [
      [1, 0, 1.0],
      [-1, 0, 1.0],
      [0, 1, 1.0],
      [0, -1, 1.0],
      [1, 1, Math.SQRT2],
      [-1, 1, Math.SQRT2],
      [1, -1, Math.SQRT2],
      [-1, -1, Math.SQRT2],
    ];
    while (pfHeap.size > 0) {
      const u = pfHeap.pop();
      const ux = u % cw;
      const uy = Math.floor(u / cw);
      const uEl = filledElev[u];

      for (const [dx, dy, dist] of d8) {
        const vx = ux + dx;
        const vy = uy + dy;
        if (vx < 0 || vx >= cw || vy < 0 || vy >= ch) continue;
        const v = vy * cw + vx;
        if (visited[v]) continue;
        visited[v] = 1;
        receiver[v] = u;
        const jitter =
          0.75 + 0.5 * world.noise.noise(vx * 0.35 + 1.9, vy * 0.35 + 6.4);
        const minNext = uEl + 0.0015 * dist * jitter;
        if (filledElev[v] <= minNext) {
          filledElev[v] = minNext;
        }
        pfHeap.push(v, filledElev[v]);
      }
    }

    // Trace 2–3 long D8 rivers entering from the Map Borders down the Priority-Flood surface into lakes/rivers!
    // Trace 2–3 long D8 rivers from Map Borders + 2 Highland Mountain Springs down the Priority-Flood surface!
    const d8Sources = [
      ...pickMapBorderRiverEntries(2),
      ...pickHighlandMountainSprings(2),
    ];
    for (let bIdx = 0; bIdx < d8Sources.length; bIdx++) {
      const entry = d8Sources[bIdx];
      let curr =
        Math.floor(entry.y / stride) * cw + Math.floor(entry.x / stride);
      const rawPts = [{ x: entry.x, y: entry.y }];
      const seen = new Set();
      let steps = 0;
      const maxD8Steps = Math.max(320, cw + ch);
      while (curr !== -1 && !seen.has(curr) && steps++ < maxD8Steps) {
        seen.add(curr);
        const cx = (curr % cw) * stride + 1;
        const cy = Math.floor(curr / cw) * stride + 1;
        rawPts.push({ x: cx, y: cy });
        const gid = world.idx(cx, cy);
        if (rawPts.length >= 16 && world.waterMask[gid] > WATER_MASK.DRY) {
          if (world.waterMask[gid] === WATER_MASK.RIVER) {
            world.hydroFeatures.push({ x: cx, y: cy, type: "confluence" });
          }
          break;
        }
        curr = receiver[curr];
      }
      if (rawPts.length >= 26) {
        const curved = applyMeanderingDisplacement(
          rawPts,
          bIdx * 2.1 + 0.8,
          0.65,
        );
        carveTaperingRiverPath(curved, bIdx === 0, false, 0);
      }
    }
  } else if (arch === "island-hopper") {
    // Island-Hopper: short volcanic island streams from high peaks to nearest island coast
    const placedSprings = [];
    for (let sPass = 0; sPass < 5; sPass++) {
      /** @type {Point2D | null} */
      let bestSp = null;
      let bestElev = -1;
      for (let attempt = 0; attempt < 35; attempt++) {
        const sx = world.rng.int(16, W - 17);
        const sy = world.rng.int(16, H - 17);
        const id = world.idx(sx, sy);
        if (world.waterMask[id] > WATER_MASK.DRY) continue;
        const el = world.elevationField[id];
        if (el < seaLevel + 0.16) continue;
        if (placedSprings.some((p) => Math.hypot(p.x - sx, p.y - sy) < 34))
          continue;
        if (el > bestElev) {
          bestElev = el;
          bestSp = { x: sx, y: sy };
        }
      }
      if (bestSp) {
        placedSprings.push(bestSp);
        let targetSink = primarySink || {
          deepX: Math.round(W * 0.5),
          deepY: Math.round(H * 0.5),
        };
        let minSD = Infinity;
        for (
          let wy = Math.max(4, bestSp.y - 45);
          wy <= Math.min(H - 5, bestSp.y + 45);
          wy += 3
        ) {
          for (
            let wx = Math.max(4, bestSp.x - 45);
            wx <= Math.min(W - 5, bestSp.x + 45);
            wx += 3
          ) {
            if (world.waterMask[world.idx(wx, wy)] === WATER_MASK.OPEN_WATER) {
              const d = Math.hypot(bestSp.x - wx, bestSp.y - wy);
              if (d < minSD) {
                minSD = d;
                targetSink = { deepX: wx, deepY: wy };
              }
            }
          }
        }
        const rPath = routeValleyThalwegAStar(
          bestSp.x,
          bestSp.y,
          targetSink.deepX,
          targetSink.deepY,
          true,
          sPass * 2.1,
          12,
        );
        carveTaperingRiverPath(rPath, false, useMeanders, sPass * 1.9);
      }
    }
  } else {
    // Continental Map-Border + Highland Mountain-Spring Trunk Rivers (`thalweg-astar` & `meandering-plain`)
    const allSources = [
      ...pickMapBorderRiverEntries(2),
      ...pickHighlandMountainSprings(2),
    ];
    for (let sPass = 0; sPass < allSources.length; sPass++) {
      const entry = allSources[sPass];
      let targetSink =
        primarySink ||
        (basins[0]
          ? { deepX: basins[0].deepX, deepY: basins[0].deepY }
          : { deepX: Math.round(W * 0.5), deepY: Math.round(H * 0.5) });
      let minSD = Infinity;
      for (const b of basins) {
        const d = Math.hypot(entry.x - b.deepX, entry.y - b.deepY);
        if (d >= 75 && d < minSD) {
          minSD = d;
          targetSink = b;
        }
      }
      const rPath = routeValleyThalwegAStar(
        entry.x,
        entry.y,
        targetSink.deepX,
        targetSink.deepY,
        true,
        sPass * 2.1,
        58,
      );
      carveTaperingRiverPath(rPath, sPass === 0, useMeanders, sPass * 1.9);
    }
  }

  world.confluencePoint = world.hydroFeatures.find(
    (f) => f.type === "confluence",
  ) ||
    world.hydroFeatures[0] || {
      x: Math.round(W * 0.5),
      y: Math.round(H * 0.5),
    };
}
