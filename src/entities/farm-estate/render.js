/**
 * Farm Estate Vector Layer Recorder.
 *
 * Renders color-batched BSP agricultural crop fields (wheat, pasture, ochre, loam, orchard),
 * broken-grid unpaved tractor track networks, smooth vector road and motorway corridor slicing,
 * contour-boundary clipping, farmstead yard pads, and upland windbreak poplar rows.
 *
 * Invariants:
 * - 100% Worker-safe: zero window, document, or DOM references.
 * - Single union clip across all farm parcels.
 *
 * @import { ProceduralLogisticsWorld } from '../../world-generator.js'
 */
import { PALETTE } from "../../palette.js";
import { WATER_MASK } from "../../constants.js";
import {
  Path2DCtor,
  buildVignelliWaterPath,
} from "../../canvas-layer-cache.js";

/**
 * @param {any} ctx
 * @param {number} idx
 */
function setSub(ctx, idx) {
  if (typeof ctx.setSubLayer === "function") {
    ctx.setSubLayer(idx);
  }
}

/**
 * @typedef {Object} ArablePathsCache
 * @property {Float32Array | null} [elevRef]
 * @property {Uint8Array | null} [waterRef]
 * @property {number} [ts]
 * @property {Path2D | null} [arableFillPath]
 * @property {Path2D | null} [arableStrokePath]
 */

/**
 * Builds or reuses cached arable elevation/hydrology boundary paths for farm fields.
 *
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 * @param {ArablePathsCache | null} [cache=null]
 * @returns {{ arableFillPath: Path2D, arableStrokePath: Path2D }}
 */
export function getOrBuildArablePaths(world, ts, cache = null) {
  if (
    cache &&
    cache.elevRef === world.elevationField &&
    cache.waterRef === world.waterMask &&
    cache.ts === ts &&
    cache.arableFillPath &&
    cache.arableStrokePath
  ) {
    return {
      arableFillPath: cache.arableFillPath,
      arableStrokePath: cache.arableStrokePath,
    };
  }

  const arableStrokePath = new Path2DCtor();
  const arableFillPath = buildVignelliWaterPath(
    world.W,
    world.H,
    world.waterMask,
    world.elevationField,
    ts,
    (cx, cy) => {
      const id = cy * world.W + cx;
      return (
        world.waterMask[id] === WATER_MASK.DRY &&
        world.distToWater[id] >= 1.8 &&
        world.elevationField[id] < world.seaLevel + 0.13
      );
    },
    arableStrokePath,
  );

  if (cache) {
    cache.elevRef = world.elevationField;
    cache.waterRef = world.waterMask;
    cache.ts = ts;
    cache.arableFillPath = arableFillPath;
    cache.arableStrokePath = arableStrokePath;
  }

  return { arableFillPath, arableStrokePath };
}

/**
 * Records farm background fields, crop parcels, furrows, tracks, road slices, and windbreaks.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 * @param {ArablePathsCache | null} [arableCache=null]
 */
export function recordFarmBackgroundFields(ctx, world, ts, arableCache = null) {
  const farms = [];
  for (const d of world.destinations || []) {
    if (d.resourceType === "FARM" && d.bspParcels && d.bspParcels.length > 0) {
      farms.push(d);
    }
  }
  if (farms.length === 0) return;

  const cropStyles = {
    wheat: { fill: "#eee7d6", furrow: "#e4dcc7", border: "#dcd2ba" },
    pasture: { fill: "#e6ecdd", furrow: "#dce4d1", border: "#d4ddc7" },
    ochre: { fill: "#eee2d2", furrow: "#e4d5c1", border: "#dccab4" },
    loam: { fill: "#eae4d9", furrow: "#dfd8cc", border: "#d6cec0" },
    orchard: { fill: "#e4ebdd", furrow: "#9fb38e", border: "#d2dcc8" },
  };

  const { arableFillPath, arableStrokePath } = getOrBuildArablePaths(
    world,
    ts,
    arableCache,
  );

  // 1. Build a single union clip path across all farm BSP parcels on the map
  const allFarmsClipPath = new Path2DCtor();
  const farmBBoxes = [];
  for (let fIdx = 0; fIdx < farms.length; fIdx++) {
    const d = farms[fIdx];
    const parcels = d.bspParcels || [];
    let minX = d.gx,
      minY = d.gy,
      maxX = d.gx + 2,
      maxY = d.gy + 2;
    for (let pIdx = 0; pIdx < parcels.length; pIdx++) {
      const p = parcels[pIdx];
      if (p.x0 < minX) minX = p.x0;
      if (p.y0 < minY) minY = p.y0;
      if (p.x1 > maxX) maxX = p.x1;
      if (p.y1 > maxY) maxY = p.y1;
      allFarmsClipPath.rect(
        p.x0 * ts - 1.0,
        p.y0 * ts - 1.0,
        (p.x1 - p.x0) * ts + 2.0,
        (p.y1 - p.y0) * ts + 2.0,
      );
    }
    farmBBoxes.push(d.estateBBox || { minX, minY, maxX, maxY });
  }

  ctx.save();
  ctx.clip(allFarmsClipPath);
  ctx.clip(arableFillPath);

  for (let fIdx = 0; fIdx < farms.length; fIdx++) {
    const d = farms[fIdx];
    const parcels = d.bspParcels || [];
    const tracks = d.tractorTracks || [];
    const isNearTrackPx = (ox, oy) => {
      for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
        const tr = tracks[tIdx];
        const x0 = tr.x0 * ts,
          y0 = tr.y0 * ts;
        const x1 = tr.x1 * ts,
          y1 = tr.y1 * ts;
        const dx = x1 - x0,
          dy = y1 - y0;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq > 1e-6 ? ((ox - x0) * dx + (oy - y0) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        if (Math.hypot(ox - (x0 + t * dx), oy - (y0 + t * dy)) < 6.2)
          return true;
      }
      return false;
    };

    for (let pIdx = 0; pIdx < parcels.length; pIdx++) {
      const p = parcels[pIdx];
      const st = cropStyles[p.crop] || cropStyles.wheat;
      const px = p.x0 * ts;
      const py = p.y0 * ts;
      const pw = (p.x1 - p.x0) * ts;
      const ph = (p.y1 - p.y0) * ts;
      if (pw <= 4 || ph <= 4) continue;

      setSub(ctx, 0);
      ctx.fillStyle = st.fill;
      ctx.fillRect(px - 0.25, py - 0.25, pw + 0.5, ph + 0.5);

      setSub(ctx, 1);
      if (p.crop === "orchard") {
        const step = 6.6;
        let rowIdx = 0;
        ctx.fillStyle = st.furrow;
        ctx.beginPath();
        for (let oy = py + 5.6; oy < py + ph - 4.6; oy += step, rowIdx++) {
          const xShift = (rowIdx % 2) * (step * 0.45);
          for (let ox = px + 5.6 + xShift; ox < px + pw - 4.6; ox += step) {
            if (isNearTrackPx(ox, oy)) continue;
            ctx.moveTo(ox + 1.55, oy);
            ctx.arc(ox, oy, 1.55, 0, Math.PI * 2);
          }
        }
        ctx.fill();
      } else {
        const furrowStep = 4.8;
        ctx.strokeStyle = st.furrow;
        ctx.lineWidth = 0.95;
        ctx.beginPath();
        if (p.furrowDir === 0) {
          for (
            let fy = py + furrowStep * 0.75;
            fy < py + ph - 2.0;
            fy += furrowStep
          ) {
            ctx.moveTo(px + 2.0, fy);
            ctx.lineTo(px + pw - 2.0, fy);
          }
        } else {
          for (
            let fx = px + furrowStep * 0.75;
            fx < px + pw - 2.0;
            fx += furrowStep
          ) {
            ctx.moveTo(fx, py + 2.0);
            ctx.lineTo(fx, py + ph - 2.0);
          }
        }
        ctx.stroke();
      }

      setSub(ctx, 2);
      ctx.strokeStyle = st.border;
      ctx.lineWidth = 1.1;
      ctx.strokeRect(px, py, pw, ph);
    }

    if (tracks.length > 0) {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      setSub(ctx, 3);
      ctx.strokeStyle = "#d4cab5";
      ctx.lineWidth = 4.2;
      ctx.beginPath();
      for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
        const tr = tracks[tIdx];
        ctx.moveTo(tr.x0 * ts, tr.y0 * ts);
        ctx.lineTo(tr.x1 * ts, tr.y1 * ts);
      }
      ctx.stroke();

      setSub(ctx, 4);
      ctx.strokeStyle = PALETTE.bgPaper;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
        const tr = tracks[tIdx];
        ctx.moveTo(tr.x0 * ts, tr.y0 * ts);
        ctx.lineTo(tr.x1 * ts, tr.y1 * ts);
      }
      ctx.stroke();
    }
  }

  // Smooth vector road & expressway corridor slicing inside the clipped estates
  const isPointNearAnyFarm = (wx, wy, pad) => {
    for (let b = 0; b < farmBBoxes.length; b++) {
      const bb = farmBBoxes[b];
      if (!(
        wx < bb.minX - pad ||
        wx > bb.maxX + pad ||
        wy < bb.minY - pad ||
        wy > bb.maxY + pad
      )) {
        return true;
      }
    }
    return false;
  };

  const nearbyRoadPath = new Path2DCtor();
  let hasNearbyRoads = false;
  for (const r of world.roads || []) {
    const pts = r.points;
    if (!pts || pts.length < 2) continue;
    const p0 = pts[0];
    if (!isPointNearAnyFarm(p0.x, p0.y, 32)) continue;
    let hitsBBox = false;
    for (let i = 0; i < pts.length; i++) {
      if (isPointNearAnyFarm(pts[i].x, pts[i].y, 3)) {
        hitsBBox = true;
        break;
      }
    }
    if (!hitsBBox) continue;
    hasNearbyRoads = true;
    nearbyRoadPath.moveTo(p0.x * ts + ts * 0.5, p0.y * ts + ts * 0.5);
    for (let i = 1; i < pts.length; i++) {
      nearbyRoadPath.lineTo(pts[i].x * ts + ts * 0.5, pts[i].y * ts + ts * 0.5);
    }
  }

  const nearbyMwayPath = new Path2DCtor();
  let hasNearbyMways = false;
  if (world.motorways && world.motorways.length > 0) {
    for (const mw of world.motorways) {
      const spans = mw.surfaceSpans || [mw.samples || []];
      for (const seg of spans) {
        if (seg.length < 2) continue;
        let penDown = false;
        for (let i = 0; i < seg.length; i++) {
          const pt = seg[i];
          if (!isPointNearAnyFarm(pt.x, pt.y, 4)) {
            penDown = false;
            continue;
          }
          const sx = pt.x * ts + ts * 0.5;
          const sy = pt.y * ts + ts * 0.5;
          if (!penDown) {
            nearbyMwayPath.moveTo(sx, sy);
            penDown = true;
            hasNearbyMways = true;
          } else {
            nearbyMwayPath.lineTo(sx, sy);
          }
        }
      }
    }
  }

  const roadCasingW = ts * 0.92;
  const mwayCasingW = ts * 1.95;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  setSub(ctx, 5);
  ctx.strokeStyle = "#d4cab5";
  if (hasNearbyRoads) {
    ctx.lineWidth = roadCasingW + 4.4;
    ctx.stroke(nearbyRoadPath);
  }
  if (hasNearbyMways) {
    ctx.lineWidth = mwayCasingW + 6.4;
    ctx.stroke(nearbyMwayPath);
  }

  setSub(ctx, 6);
  ctx.strokeStyle = PALETTE.bgPaper;
  if (hasNearbyRoads) {
    ctx.lineWidth = roadCasingW + 2.2;
    ctx.stroke(nearbyRoadPath);
  }
  if (hasNearbyMways) {
    ctx.lineWidth = mwayCasingW + 4.2;
    ctx.stroke(nearbyMwayPath);
  }

  setSub(ctx, 7);
  ctx.strokeStyle = "#d4cab5";
  ctx.lineWidth = 1.8;
  ctx.stroke(arableStrokePath);

  // Frame each 2×2 farmstead yard itself with a clean rounded margin
  for (let fIdx = 0; fIdx < farms.length; fIdx++) {
    const d = farms[fIdx];
    const padX = d.gx * ts - 1.6;
    const padY = d.gy * ts - 1.6;
    const padW = (d.wTiles || 2) * ts + 3.2;
    const padH = (d.hTiles || 2) * ts + 3.2;
    ctx.beginPath();
    ctx.roundRect(padX, padY, padW, padH, 4.2);
    setSub(ctx, 8);
    ctx.strokeStyle = "#d4cab5";
    ctx.lineWidth = 2.2;
    ctx.stroke();
    setSub(ctx, 9);
    ctx.fillStyle = PALETTE.bgPaper;
    ctx.fill();
  }

  ctx.restore();

  // Sparse Foothill Windbreak Poplar Row along upland outer boundary edge
  let hasWindbreaks = false;
  for (let fIdx = 0; fIdx < farms.length; fIdx++) {
    if (farms[fIdx].windbreakPts && farms[fIdx].windbreakPts.length > 0) {
      hasWindbreaks = true;
      break;
    }
  }
  if (hasWindbreaks) {
    setSub(ctx, 0);
    ctx.fillStyle = "rgba(182, 200, 170, 0.55)";
    ctx.beginPath();
    for (let fIdx = 0; fIdx < farms.length; fIdx++) {
      const wb = farms[fIdx].windbreakPts || [];
      for (let i = 0; i < wb.length; i++) {
        const wx = wb[i][0] * ts;
        const wy = wb[i][1] * ts;
        ctx.moveTo(wx + 3.4, wy);
        ctx.arc(wx, wy, 3.4, 0, Math.PI * 2);
      }
    }
    ctx.fill();

    setSub(ctx, 1);
    ctx.fillStyle = "#97ae89";
    ctx.beginPath();
    for (let fIdx = 0; fIdx < farms.length; fIdx++) {
      const wb = farms[fIdx].windbreakPts || [];
      for (let i = 0; i < wb.length; i++) {
        const wx = wb[i][0] * ts;
        const wy = wb[i][1] * ts;
        ctx.moveTo(wx + 2.0, wy);
        ctx.arc(wx, wy, 2.0, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }
}
