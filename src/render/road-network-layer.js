/**
 * Surface Road Network Vector Layer Recorder.
 *
 * Renders unified 2-pass surface road network (casings followed by fills),
 * bank-to-bank bridge guardrails over water, landscaped central roundabout islands,
 * private lot driveways, and Diamond interchange slip-ramp throats.
 *
 * Invariants:
 * - 100% Worker-safe: zero window, document, or DOM references.
 * - Unified 2-pass rendering: all casings stroked before any white asphalt fill.
 *
 * @import { ProceduralLogisticsWorld } from '../world-generator.js'
 */
import { PALETTE } from "../palette.js";

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
 * @param {any} ctx
 */
function nextPass(ctx) {
  if (typeof ctx.nextLayerPass === "function") {
    ctx.nextLayerPass();
  }
}

/**
 * Traces a smoothed quadratic Bezier path through a series of discrete grid waypoints.
 *
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {Array<{ x: number, y: number }>} pts
 * @param {number} ts
 */
export function traceSmoothPath(ctx, pts, ts) {
  if (!pts || pts.length === 0) return;
  ctx.beginPath();
  const ox = ts * 0.5;
  const oy = ts * 0.5;
  ctx.moveTo(pts[0].x * ts + ox, pts[0].y * ts + oy);
  for (let i = 1; i < pts.length - 1; i++) {
    const pPrev = pts[i - 1];
    const pCurr = pts[i];
    const pNext = pts[i + 1];
    const dx1 = pCurr.x - pPrev.x;
    const dy1 = pCurr.y - pPrev.y;
    const dx2 = pNext.x - pCurr.x;
    const dy2 = pNext.y - pCurr.y;

    // Collinear points need no curve
    if (dx1 === dx2 && dy1 === dy2) {
      ctx.lineTo(pCurr.x * ts + ox, pCurr.y * ts + oy);
      continue;
    }

    const len1 = Math.hypot(dx1, dy1) || 1;
    const len2 = Math.hypot(dx2, dy2) || 1;
    const rCorner = Math.min(0.24, len1 * 0.45, len2 * 0.45);
    const xIn = (pCurr.x - (dx1 / len1) * rCorner) * ts + ox;
    const yIn = (pCurr.y - (dy1 / len1) * rCorner) * ts + oy;
    const xOut = (pCurr.x + (dx2 / len2) * rCorner) * ts + ox;
    const yOut = (pCurr.y + (dy2 / len2) * rCorner) * ts + oy;

    ctx.lineTo(xIn, yIn);
    ctx.quadraticCurveTo(pCurr.x * ts + ox, pCurr.y * ts + oy, xOut, yOut);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x * ts + ox, last.y * ts + oy);
}

/**
 * Draws landscaped central island and perimeter curb for a modern roundabout.
 *
 * @param {any} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} rIsland
 * @param {string | null} [accentColor=null]
 */
export function drawRoundaboutCentralIsland(
  ctx,
  x,
  y,
  rIsland,
  accentColor = null,
) {
  // Inner curb casing around central landscaped island
  ctx.beginPath();
  ctx.arc(x, y, rIsland, 0, Math.PI * 2);
  setSub(ctx, 0);
  ctx.fillStyle = PALETTE.parkSageGreen;
  ctx.fill();
  setSub(ctx, 1);
  ctx.strokeStyle = PALETTE.roadCasing;
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // Lush inner turf planter ring
  setSub(ctx, 2);
  ctx.fillStyle = "#9fb99a";
  ctx.beginPath();
  ctx.arc(x, y, rIsland * 0.58, 0, Math.PI * 2);
  ctx.fill();

  // Subtle town/airport accent centerpiece
  if (accentColor) {
    setSub(ctx, 3);
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.arc(x, y, rIsland * 0.26, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Records the unified surface road network into a display list or canvas context.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 */
export function recordSurfaceRoadNetwork(ctx, world, ts) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Gather all surface roundabouts and driveways directly from world.routingGraph
  const roundabouts = world.routingGraph?.roundabouts || [];
  const driveways = world.routingGraph?.driveways || [];
  const airportLandsideGeoms = [];

  for (const ap of world.airports || []) {
    const cx = ap.x * ts + ts * 0.5;
    const cy = ap.y * ts + ts * 0.5;
    const rwyLen = ap.halfLen * 2 * ts;
    const side = ap.apronSide || 1;
    const termW = ap.isHub ? rwyLen * 0.46 : rwyLen * 0.4;
    const termH = ts * (ap.isHub ? 0.76 : 0.7);
    const termY = side * ts * (ap.isHub ? 1.66 : 1.54);
    const termOuterY = termY + side * (termH * 0.5);

    const loopW = termW * (ap.isHub ? 0.82 : 0.88);
    const loopHalfW = loopW * 0.5;
    const loopInnerY = termOuterY + side * (ts * 0.2);
    const loopOuterY = loopInnerY + side * (ts * 0.98);
    const loopTopY = Math.min(loopInnerY, loopOuterY);
    const loopBoxH = Math.abs(loopOuterY - loopInnerY);
    const loopR = loopBoxH * 0.48;

    const cosA = Math.cos(ap.angleRad);
    const sinA = Math.sin(ap.angleRad);
    const gatePx = ap.gateX * ts + ts * 0.5;
    const gatePy = ap.gateY * ts + ts * 0.5;
    const gdx = gatePx - cx;
    const gdy = gatePy - cy;
    const localGateX = gdx * cosA + gdy * sinA;
    const localGateY = -gdx * sinA + gdy * cosA;

    airportLandsideGeoms.push({
      cx,
      cy,
      angleRad: ap.angleRad,
      loopHalfW,
      loopTopY,
      loopW,
      loopBoxH,
      loopR,
      spineStartY: loopOuterY,
      localGateX,
      localGateY,
    });
  }

  // =========================================================================
  // PASS 1: UNIFIED SURFACE ROAD CASINGS
  // =========================================================================
  // Diamond slip-ramp casings (PALETTE.motorwayBorder) stroked at the start of PASS 1
  ctx.strokeStyle = PALETTE.motorwayBorder;
  ctx.lineWidth = ts * 0.36;
  ctx.beginPath();
  for (const ic of world.interchanges || []) {
    if (ic.type !== "diamond-ramp") continue;
    for (const ramp of ic.ramps || []) {
      ctx.moveTo(ramp.p0.x * ts + ts * 0.5, ramp.p0.y * ts + ts * 0.5);
      ctx.bezierCurveTo(
        ramp.p1.x * ts + ts * 0.5,
        ramp.p1.y * ts + ts * 0.5,
        ramp.p2.x * ts + ts * 0.5,
        ramp.p2.y * ts + ts * 0.5,
        ramp.p3.x * ts + ts * 0.5,
        ramp.p3.y * ts + ts * 0.5,
      );
    }
  }
  ctx.stroke();

  ctx.strokeStyle = PALETTE.roadCasing;
  ctx.lineWidth = ts * 0.42;
  ctx.beginPath();
  for (const dw of driveways) {
    ctx.moveTo(dw.x0 * ts + ts * 0.5, dw.y0 * ts + ts * 0.5);
    ctx.lineTo(dw.x1 * ts + ts * 0.5, dw.y1 * ts + ts * 0.5);
  }
  ctx.stroke();

  for (const r of world.roads || []) {
    if (
      r.points.length < 2 ||
      r.type === "airport-loop" ||
      r.type === "airport-spine"
    ) {
      continue;
    }
    ctx.strokeStyle = PALETTE.roadCasing;
    ctx.lineWidth = r.type === "street" ? ts * 0.58 : ts * 0.74;
    traceSmoothPath(ctx, r.points, ts);
    ctx.stroke();
  }

  for (const ag of airportLandsideGeoms) {
    ctx.save();
    ctx.translate(ag.cx, ag.cy);
    ctx.rotate(ag.angleRad);
    ctx.strokeStyle = PALETTE.roadCasing;
    ctx.lineWidth = ts * 0.68;
    ctx.beginPath();
    ctx.roundRect(-ag.loopHalfW, ag.loopTopY, ag.loopW, ag.loopBoxH, ag.loopR);
    ctx.moveTo(0, ag.spineStartY);
    ctx.lineTo(ag.localGateX, ag.localGateY);
    ctx.stroke();
    ctx.restore();
  }

  if (roundabouts.length > 0) {
    ctx.strokeStyle = PALETTE.roadCasing;
    ctx.lineWidth = ts * 0.68;
    ctx.beginPath();
    for (const rb of roundabouts) {
      const px = rb.x * ts + ts * 0.5;
      const py = rb.y * ts + ts * 0.5;
      const rRing = rb.rTiles * ts;
      ctx.moveTo(px + rRing, py);
      ctx.arc(px, py, rRing, 0, Math.PI * 2);
    }
    ctx.stroke();
  }

  // =========================================================================
  // PASS 2: BRIDGE GUARDRAILS OVER WATER
  // =========================================================================
  nextPass(ctx);
  const ox = ts * 0.5;
  const oy = ts * 0.5;
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  ctx.strokeStyle = PALETTE.bridgeRail;
  ctx.lineWidth = ts * 0.88;
  for (const r of world.roads || []) {
    const pts = r.points;
    if (
      !pts ||
      pts.length < 2 ||
      r.type === "airport-loop" ||
      r.type === "airport-spine"
    ) {
      continue;
    }
    let i = 0;
    while (i < pts.length - 1) {
      if (!(pts[i].isBridge || pts[i + 1].isBridge)) {
        i++;
        continue;
      }
      const eStart = i;
      while (
        i + 1 < pts.length - 1 &&
        (pts[i + 1].isBridge || pts[i + 2].isBridge)
      ) {
        i++;
      }
      const eEnd = i;
      i++;

      ctx.beginPath();
      const vStart = eStart;
      const pS0 = pts[vStart];
      const pS1 = pts[vStart + 1];
      const startFrac = !pS0.isBridge && pS1.isBridge ? 0.08 : 0.0;
      ctx.moveTo(
        (pS0.x + (pS1.x - pS0.x) * startFrac) * ts + ox,
        (pS0.y + (pS1.y - pS0.y) * startFrac) * ts + oy,
      );

      for (let v = eStart + 1; v <= eEnd; v++) {
        const pPrev = pts[v - 1];
        const pCurr = pts[v];
        const pNext = pts[v + 1];
        const dx1 = pCurr.x - pPrev.x;
        const dy1 = pCurr.y - pPrev.y;
        const dx2 = pNext.x - pCurr.x;
        const dy2 = pNext.y - pCurr.y;
        if (dx1 === dx2 && dy1 === dy2) {
          ctx.lineTo(pCurr.x * ts + ox, pCurr.y * ts + oy);
        } else {
          const len1 = Math.hypot(dx1, dy1) || 1;
          const len2 = Math.hypot(dx2, dy2) || 1;
          const rCorner = Math.min(0.24, len1 * 0.45, len2 * 0.45);
          const xIn = (pCurr.x - (dx1 / len1) * rCorner) * ts + ox;
          const yIn = (pCurr.y - (dy1 / len1) * rCorner) * ts + oy;
          const xOut = (pCurr.x + (dx2 / len2) * rCorner) * ts + ox;
          const yOut = (pCurr.y + (dy2 / len2) * rCorner) * ts + oy;
          ctx.lineTo(xIn, yIn);
          ctx.quadraticCurveTo(
            pCurr.x * ts + ox,
            pCurr.y * ts + oy,
            xOut,
            yOut,
          );
        }
      }

      const vEnd = eEnd + 1;
      const pE0 = pts[eEnd];
      const pE1 = pts[vEnd];
      const endFrac = pE0.isBridge && !pE1.isBridge ? 0.92 : 1.0;
      ctx.lineTo(
        (pE0.x + (pE1.x - pE0.x) * endFrac) * ts + ox,
        (pE0.y + (pE1.y - pE0.y) * endFrac) * ts + oy,
      );
      ctx.stroke();
    }
  }

  ctx.lineCap = "round";

  // =========================================================================
  // PASS 3: UNIFIED SURFACE ROAD & SLIP-RAMP ASPHALT FILLS
  // =========================================================================
  nextPass(ctx);
  ctx.strokeStyle = "#f48fb1";
  ctx.lineWidth = ts * 0.22;
  ctx.beginPath();
  for (const ic of world.interchanges || []) {
    if (ic.type !== "diamond-ramp") continue;
    for (const ramp of ic.ramps || []) {
      ctx.moveTo(ramp.p0.x * ts + ox, ramp.p0.y * ts + oy);
      ctx.bezierCurveTo(
        ramp.p1.x * ts + ox,
        ramp.p1.y * ts + oy,
        ramp.p2.x * ts + ox,
        ramp.p2.y * ts + oy,
        ramp.p3.x * ts + ox,
        ramp.p3.y * ts + oy,
      );
    }
  }
  ctx.stroke();

  ctx.strokeStyle = PALETTE.roadAsphalt;
  ctx.lineWidth = ts * 0.26;
  ctx.beginPath();
  for (const dw of driveways) {
    ctx.moveTo(dw.x0 * ts + ts * 0.5, dw.y0 * ts + ts * 0.5);
    ctx.lineTo(dw.x1 * ts + ts * 0.5, dw.y1 * ts + ts * 0.5);
  }
  ctx.stroke();

  for (const r of world.roads || []) {
    if (
      r.points.length < 2 ||
      r.type === "airport-loop" ||
      r.type === "airport-spine"
    ) {
      continue;
    }
    ctx.strokeStyle = PALETTE.roadAsphalt;
    ctx.lineWidth = r.type === "street" ? ts * 0.42 : ts * 0.56;
    traceSmoothPath(ctx, r.points, ts);
    ctx.stroke();
  }

  for (const ag of airportLandsideGeoms) {
    ctx.save();
    ctx.translate(ag.cx, ag.cy);
    ctx.rotate(ag.angleRad);
    ctx.strokeStyle = PALETTE.roadAsphalt;
    ctx.lineWidth = ts * 0.5;
    ctx.beginPath();
    ctx.roundRect(-ag.loopHalfW, ag.loopTopY, ag.loopW, ag.loopBoxH, ag.loopR);
    ctx.moveTo(0, ag.spineStartY);
    ctx.lineTo(ag.localGateX, ag.localGateY);
    ctx.stroke();
    ctx.restore();
  }

  if (roundabouts.length > 0) {
    ctx.strokeStyle = PALETTE.roadAsphalt;
    ctx.lineWidth = ts * 0.5;
    ctx.beginPath();
    for (const rb of roundabouts) {
      const px = rb.x * ts + ts * 0.5;
      const py = rb.y * ts + ts * 0.5;
      const rRing = rb.rTiles * ts;
      ctx.moveTo(px + rRing, py);
      ctx.arc(px, py, rRing, 0, Math.PI * 2);
    }
    ctx.stroke();
  }

  // =========================================================================
  // PASS 4: LANDSCAPED CENTRAL ROUNDABOUT ISLANDS
  // =========================================================================
  nextPass(ctx);
  for (const rb of roundabouts) {
    const px = rb.x * ts + ts * 0.5;
    const py = rb.y * ts + ts * 0.5;
    const rIsland = (rb.rIsland ?? rb.rTiles * 0.52) * ts;
    drawRoundaboutCentralIsland(
      ctx,
      px,
      py,
      rIsland,
      rb.accentColor || "#8fa989",
    );
  }
}
