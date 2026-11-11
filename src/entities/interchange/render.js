/**
 * Interchange and Elevated Motorway Vector Layer Recorder.
 *
 * Renders Level-1 coalesced ground drop shadows, Cloverleaf/Trumpet/Diamond ramp underlays,
 * elevated pink expressways, subterranean mountain tunnel bores and portals, highway shield badges,
 * and Level-2 grade-separated overpass bridges with clipped lower-deck shadows.
 *
 * Invariants:
 * - 100% Worker-safe: zero window, document, or DOM references.
 * - Coalesced ground shadow plane eliminates double-dark overlap artifacts.
 *
 * @import { ProceduralLogisticsWorld } from '../../world-generator.js'
 */
import { PALETTE } from "../../palette.js";
import { WORLD_GEOMETRY } from "../../constants.js";
import { Path2DCtor, extrudeRibbonToPath2D } from "../../canvas-layer-cache.js";
import { CLOVERLEAF_GEOMETRY, computeTrumpetRampBeziers } from "./geometry.js";

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
 * Traces a smoothed quadratic Bezier curve through motorway sample points.
 *
 * @param {any} ctx
 * @param {Array<{ x: number, y: number }>} samples
 * @param {number} ts
 * @param {number} [oxOffset=0]
 * @param {number} [oyOffset=0]
 */
export function traceMotorwaySamples(
  ctx,
  samples,
  ts,
  oxOffset = 0,
  oyOffset = 0,
) {
  if (!samples || samples.length < 2) return;
  const ox = ts * 0.5 + oxOffset;
  const oy = ts * 0.5 + oyOffset;
  ctx.beginPath();
  ctx.moveTo(samples[0].x * ts + ox, samples[0].y * ts + oy);
  if (samples.length === 2) {
    ctx.lineTo(samples[1].x * ts + ox, samples[1].y * ts + oy);
  } else {
    for (let i = 1; i <= samples.length - 2; i++) {
      const p1 = samples[i];
      const p2 = samples[i + 1];
      ctx.quadraticCurveTo(
        p1.x * ts + ox,
        p1.y * ts + oy,
        (p1.x + p2.x) * 0.5 * ts + ox,
        (p1.y + p2.y) * 0.5 * ts + oy,
      );
    }
    const last = samples[samples.length - 1];
    ctx.lineTo(last.x * ts + ox, last.y * ts + oy);
  }
}

/**
 * Builds the unified Level-1 coalesced ground drop shadow path (z = 0.5).
 *
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 * @returns {Path2D}
 */
export function buildCoalescedGroundShadowPath(world, ts) {
  const groundShadowUnionPath = new Path2DCtor();
  const ox = ts * 0.5;
  const oy = ts * 0.5;

  // 1. All elevated motorway surface spans
  for (const mw of world.motorways || []) {
    const samples = mw.samples;
    if (!samples || samples.length < 2) continue;

    const tunnels = mw.tunnels || [];
    let surfaceSpans = mw.surfaceSpans;
    if (!surfaceSpans) {
      surfaceSpans = [];
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
    }

    const termPts = [];
    if (!mw.prunedStart) termPts.push({ x: mw.sx, y: mw.sy });
    if (!mw.prunedEnd) termPts.push({ x: mw.ex, y: mw.ey });
    const portalPts = [];
    for (const tun of tunnels) {
      portalPts.push({ x: tun.x0, y: tun.y0 }, { x: tun.x1, y: tun.y1 });
    }
    const evalShadowElevation = (pt) => {
      let h = 1.0;
      for (const tp of termPts) {
        const d = Math.hypot(pt.x - tp.x, pt.y - tp.y);
        const f = Math.max(0, Math.min(1, (d - 1.5) / 3.6));
        if (f < h) h = f;
      }
      for (const pp of portalPts) {
        const d = Math.hypot(pt.x - pp.x, pt.y - pp.y);
        const f = Math.max(0, Math.min(1, d / 2.6));
        if (f < h) h = f;
      }
      return h * h * (3 - 2 * h);
    };

    for (const seg of surfaceSpans) {
      const ribbonPts = seg.map((pt) => {
        const sh = evalShadowElevation(pt);
        return {
          x: pt.x * ts + ox + 3.5 * sh,
          y: pt.y * ts + oy + 4.8 * sh,
          halfW: ts * (0.22 + 0.2 * sh),
        };
      });
      extrudeRibbonToPath2D(groundShadowUnionPath, ribbonPts, true);
    }
  }

  // 2. All Cloverleaf, Trumpet, and Diamond interchange ramps
  for (const ic of world.interchanges || []) {
    const cx = ic.x * ts + ox;
    const cy = ic.y * ts + oy;

    if (ic.type === "cloverleaf") {
      const uAx = Math.cos(ic.angleA || 0);
      const uAy = Math.sin(ic.angleA || 0);
      const uBx = Math.cos(ic.angleB || 0);
      const uBy = Math.sin(ic.angleB || 0);

      const signsA = ic.activeSignsA || [-1, 1];
      const signsB = ic.activeSignsB || [-1, 1];
      const quadrants = [];
      for (const sA of signsA) {
        for (const sB of signsB) {
          quadrants.push([sA, sB]);
        }
      }

      const outerDist = ts * CLOVERLEAF_GEOMETRY.outerDist;
      const outerCtrl = ts * CLOVERLEAF_GEOMETRY.outerCtrl;
      const leafSpan = ts * CLOVERLEAF_GEOMETRY.leafSpan;

      for (const [sA, sB] of quadrants) {
        const rAx = sA * uAx;
        const rAy = sA * uAy;
        const rBx = sB * uBx;
        const rBy = sB * uBy;

        const pStart = { x: cx + rAx * outerDist, y: cy + rAy * outerDist };
        const pCtrl = {
          x: cx + (rAx + rBx) * outerCtrl,
          y: cy + (rAy + rBy) * outerCtrl,
        };
        const pEnd = { x: cx + rBx * outerDist, y: cy + rBy * outerDist };

        const outerPts = [];
        for (let step = 0; step <= 12; step++) {
          const t = step / 12;
          const mt = 1 - t;
          const px = mt * mt * pStart.x + 2 * mt * t * pCtrl.x + t * t * pEnd.x;
          const py = mt * mt * pStart.y + 2 * mt * t * pCtrl.y + t * t * pEnd.y;
          outerPts.push({
            x: px + 3.5,
            y: py + 4.8,
            halfW: ts * 0.19,
          });
        }
        extrudeRibbonToPath2D(groundShadowUnionPath, outerPts, true);

        const p0 = { x: cx, y: cy };
        const p1 = { x: cx + rAx * leafSpan, y: cy + rAy * leafSpan };
        const p2 = { x: cx + rBx * leafSpan, y: cy + rBy * leafSpan };
        const p3 = { x: cx, y: cy };

        const half1Pts = [];
        for (let step = 0; step <= 10; step++) {
          const t = (step / 10) * 0.5;
          const mt = 1 - t;
          const px =
            mt * mt * mt * p0.x +
            3 * mt * mt * t * p1.x +
            3 * mt * t * t * p2.x +
            t * t * t * p3.x;
          const py =
            mt * mt * mt * p0.y +
            3 * mt * mt * t * p1.y +
            3 * mt * t * t * p2.y +
            t * t * t * p3.y;
          half1Pts.push({
            x: px + 3.5,
            y: py + 4.8,
            halfW: ts * 0.2,
          });
        }
        extrudeRibbonToPath2D(groundShadowUnionPath, half1Pts, true);

        const half2Pts = [];
        for (let step = 0; step <= 10; step++) {
          const t = 0.5 + (step / 10) * 0.5;
          const mt = 1 - t;
          const px =
            mt * mt * mt * p0.x +
            3 * mt * mt * t * p1.x +
            3 * mt * t * t * p2.x +
            t * t * t * p3.x;
          const py =
            mt * mt * mt * p0.y +
            3 * mt * mt * t * p1.y +
            3 * mt * t * t * p2.y +
            t * t * t * p3.y;
          half2Pts.push({
            x: px + 3.5,
            y: py + 4.8,
            halfW: ts * 0.2,
          });
        }
        extrudeRibbonToPath2D(groundShadowUnionPath, half2Pts, true);
      }
    } else if (ic.type === "trumpet") {
      const ramps = computeTrumpetRampBeziers(ic, world.motorways);
      const sampleSegShadow = (seg) => {
        const pts = [];
        for (let step = 0; step <= 12; step++) {
          const t = step / 12;
          const mt = 1 - t;
          const wx =
            mt * mt * mt * seg.p0.x +
            3 * mt * mt * t * seg.p1.x +
            3 * mt * t * t * seg.p2.x +
            t * t * t * seg.p3.x;
          const wy =
            mt * mt * mt * seg.p0.y +
            3 * mt * mt * t * seg.p1.y +
            3 * mt * t * t * seg.p2.y +
            t * t * t * seg.p3.y;
          pts.push({
            x: wx * ts + ox + 3.5,
            y: wy * ts + oy + 4.8,
            halfW: ts * 0.19,
          });
        }
        extrudeRibbonToPath2D(groundShadowUnionPath, pts, true);
      };

      sampleSegShadow(ramps.yellow);
      sampleSegShadow(ramps.purple);
      for (const seg of ramps.brown) sampleSegShadow(seg);
      for (const seg of ramps.blue) sampleSegShadow(seg);
    } else if (ic.type === "diamond-ramp") {
      for (const ramp of ic.ramps || []) {
        const rampPts = [];
        for (let step = 0; step <= 10; step++) {
          const t = step / 10;
          const mt = 1 - t;
          const bx =
            mt * mt * mt * ramp.p0.x +
            3 * mt * mt * t * ramp.p1.x +
            3 * mt * t * t * ramp.p2.x +
            t * t * t * ramp.p3.x;
          const by =
            mt * mt * mt * ramp.p0.y +
            3 * mt * mt * t * ramp.p1.y +
            3 * mt * t * t * ramp.p2.y +
            t * t * t * ramp.p3.y;
          const rawH = 1 - t;
          const sh = rawH * rawH * (3 - 2 * rawH);
          rampPts.push({
            x: bx * ts + ox + 3.5 * sh,
            y: by * ts + oy + 4.8 * sh,
            halfW: ts * (0.08 + 0.1 * sh),
          });
        }
        extrudeRibbonToPath2D(groundShadowUnionPath, rampPts, true);
      }
    }
  }

  return groundShadowUnionPath;
}

/**
 * Draws interchange slip-ramps and loops underneath the elevated mainlines.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 */
export function drawInterchangesUnderlay(ctx, world, ts) {
  const ox = ts * 0.5;
  const oy = ts * 0.5;

  for (const ic of world.interchanges || []) {
    const cx = ic.x * ts + ox;
    const cy = ic.y * ts + oy;

    if (ic.type === "cloverleaf") {
      const uAx = Math.cos(ic.angleA || 0);
      const uAy = Math.sin(ic.angleA || 0);
      const uBx = Math.cos(ic.angleB || 0);
      const uBy = Math.sin(ic.angleB || 0);

      const signsA = ic.activeSignsA || [-1, 1];
      const signsB = ic.activeSignsB || [-1, 1];
      const quadrants = [];
      for (const sA of signsA) {
        for (const sB of signsB) {
          quadrants.push([sA, sB]);
        }
      }

      const outerDist = ts * CLOVERLEAF_GEOMETRY.outerDist;
      const outerCtrl = ts * CLOVERLEAF_GEOMETRY.outerCtrl;
      const leafSpan = ts * CLOVERLEAF_GEOMETRY.leafSpan;

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // 1. Outer Concave Right-Turn Slip Ramps (Casing + Pink Fill)
      for (const pass of ["border", "fill"]) {
        setSub(ctx, pass === "border" ? 0 : 1);
        ctx.strokeStyle =
          pass === "border" ? PALETTE.motorwayBorder : "#f48fb1";
        ctx.lineWidth = pass === "border" ? ts * 0.36 : ts * 0.22;
        for (const [sA, sB] of quadrants) {
          const rAx = sA * uAx;
          const rAy = sA * uAy;
          const rBx = sB * uBx;
          const rBy = sB * uBy;
          ctx.beginPath();
          ctx.moveTo(cx + rAx * outerDist, cy + rAy * outerDist);
          ctx.quadraticCurveTo(
            cx + (rAx + rBx) * outerCtrl,
            cy + (rAy + rBy) * outerCtrl,
            cx + rBx * outerDist,
            cy + rBy * outerDist,
          );
          ctx.stroke();
        }
      }

      // 2. Inner 270° Tangent Cloverleaf Loops (Casing + Pink Fill)
      for (const pass of ["border", "fill"]) {
        setSub(ctx, pass === "border" ? 2 : 3);
        ctx.strokeStyle =
          pass === "border" ? PALETTE.motorwayBorder : PALETTE.motorwayFill;
        ctx.lineWidth = pass === "border" ? ts * 0.38 : ts * 0.24;
        for (const [sA, sB] of quadrants) {
          const rAx = sA * uAx;
          const rAy = sA * uAy;
          const rBx = sB * uBx;
          const rBy = sB * uBy;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.bezierCurveTo(
            cx + rAx * leafSpan,
            cy + rAy * leafSpan,
            cx + rBx * leafSpan,
            cy + rBy * leafSpan,
            cx,
            cy,
          );
          ctx.stroke();
        }
      }
      ctx.restore();
    } else if (ic.type === "trumpet") {
      const ramps = computeTrumpetRampBeziers(ic, world.motorways);

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      const strokeCubicChain = (segs) => {
        ctx.beginPath();
        ctx.moveTo(segs[0].p0.x * ts + ox, segs[0].p0.y * ts + oy);
        for (const seg of segs) {
          ctx.bezierCurveTo(
            seg.p1.x * ts + ox,
            seg.p1.y * ts + oy,
            seg.p2.x * ts + ox,
            seg.p2.y * ts + oy,
            seg.p3.x * ts + ox,
            seg.p3.y * ts + oy,
          );
        }
        ctx.stroke();
      };

      for (const pass of ["border", "fill"]) {
        setSub(ctx, pass === "border" ? 0 : 1);
        ctx.strokeStyle =
          pass === "border" ? PALETTE.motorwayBorder : "#f48fb1";
        ctx.lineWidth = pass === "border" ? ts * 0.34 : ts * 0.21;
        strokeCubicChain([ramps.yellow]);
        strokeCubicChain([ramps.purple]);
        strokeCubicChain(ramps.brown);
        strokeCubicChain(ramps.blue);
      }

      ctx.restore();
    } else if (ic.type === "diamond-ramp") {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ic.angleRad || 0);
      setSub(ctx, 0);
      ctx.lineCap = "butt";
      ctx.strokeStyle = "#36383e";
      ctx.lineWidth = ts * 1.04;
      ctx.beginPath();
      ctx.moveTo(-ts * 0.68, 0);
      ctx.lineTo(ts * 0.68, 0);
      ctx.stroke();
      ctx.restore();
    }
  }
}

/**
 * Records the Level-1 elevated motorways, ground shadows, tunnel bores, and highway shields.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 */
export function recordMotorwaysLower(ctx, world, ts) {
  // 0. Unified Coalesced Ground Shadow Plane (z = 0.5)
  const groundShadowUnionPath = buildCoalescedGroundShadowPath(world, ts);
  setSub(ctx, 0);
  ctx.fillStyle = "rgba(45, 42, 38, 0.12)";
  ctx.fill(groundShadowUnionPath, "nonzero");
  nextPass(ctx);

  // 1. Draw Cloverleaf Loops & Trumpet Slip-Ramps underneath main decks
  drawInterchangesUnderlay(ctx, world, ts);
  nextPass(ctx);

  const roundabouts = world.routingGraph?.roundabouts || [];

  // 2. Draw Mainline Elevated Pink Expressways
  for (const mw of world.motorways || []) {
    const samples = mw.samples;
    if (!samples || samples.length < 2) continue;

    const sx = mw.sx * ts + ts * 0.5;
    const sy = mw.sy * ts + ts * 0.5;
    const ex = mw.ex * ts + ts * 0.5;
    const ey = mw.ey * ts + ts * 0.5;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const termEndpoints = [];
    if (!mw.prunedStart) termEndpoints.push([sx, sy]);
    if (!mw.prunedEnd) termEndpoints.push([ex, ey]);
    if (termEndpoints.length > 0) {
      ctx.beginPath();
      ctx.rect(-ts * 50, -ts * 50, (world.W + 100) * ts, (world.H + 100) * ts);
      for (const [rx, ry] of termEndpoints) {
        const matchedRb = roundabouts.find(
          (rb) =>
            Math.hypot(rb.x * ts + ts * 0.5 - rx, rb.y * ts + ts * 0.5 - ry) <
            1.0,
        );
        const rbRadius = matchedRb
          ? matchedRb.rTiles
          : WORLD_GEOMETRY.ROUNDABOUT_RADII.townStub;
        const clipR =
          (rbRadius + WORLD_GEOMETRY.ROUNDABOUT_RADII.clipMargin) * ts;
        ctx.moveTo(rx + clipR, ry);
        ctx.arc(rx, ry, clipR, 0, Math.PI * 2);
      }
      ctx.clip("evenodd");
    }

    const tunnels = mw.tunnels || [];
    let surfaceSpans = mw.surfaceSpans;
    if (!surfaceSpans) {
      surfaceSpans = [];
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
    }

    // 1. Subterranean Mountain Tunnel Bore
    if (tunnels.length > 0) {
      setSub(ctx, 1);
      ctx.lineCap = "butt";
      ctx.strokeStyle = "rgba(54, 56, 62, 0.42)";
      ctx.lineWidth = ts * 0.84;
      ctx.setLineDash([7, 5]);
      for (const tun of tunnels) {
        const tSamples = samples.slice(tun.i0, tun.i1 + 1);
        if (tSamples.length >= 2) {
          traceMotorwaySamples(ctx, tSamples, ts, 0, 0);
          ctx.stroke();
        }
      }

      setSub(ctx, 2);
      ctx.strokeStyle = "rgba(232, 92, 144, 0.72)";
      ctx.lineWidth = ts * 0.56;
      for (const tun of tunnels) {
        const tSamples = samples.slice(tun.i0, tun.i1 + 1);
        if (tSamples.length >= 2) {
          traceMotorwaySamples(ctx, tSamples, ts, 0, 0);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      ctx.lineCap = "round";
    }

    // 2. Outer Casing
    setSub(ctx, 3);
    ctx.strokeStyle = PALETTE.motorwayBorder;
    ctx.lineWidth = ts * 0.88;
    for (const seg of surfaceSpans) {
      traceMotorwaySamples(ctx, seg, ts, 0, 0);
      ctx.stroke();
    }

    // 3. Pink Deck
    setSub(ctx, 4);
    ctx.strokeStyle = PALETTE.motorwayFill;
    ctx.lineWidth = ts * 0.72;
    for (const seg of surfaceSpans) {
      traceMotorwaySamples(ctx, seg, ts, 0, 0);
      ctx.stroke();
    }

    // 4. Median Divider Line
    setSub(ctx, 5);
    ctx.strokeStyle = PALETTE.motorwayCore;
    ctx.lineWidth = 2.0;
    for (const seg of surfaceSpans) {
      traceMotorwaySamples(ctx, seg, ts, 0, 0);
      ctx.stroke();
    }

    // 5. Tunnel Portal Mouths
    if (tunnels.length > 0) {
      for (const tun of tunnels) {
        for (const [px, py, ang] of [
          [tun.x0 * ts + ts * 0.5, tun.y0 * ts + ts * 0.5, tun.ang0],
          [tun.x1 * ts + ts * 0.5, tun.y1 * ts + ts * 0.5, tun.ang1 + Math.PI],
        ]) {
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(ang);
          ctx.beginPath();
          ctx.roundRect(-3.5, -ts * 0.56, 7.0, ts * 1.12, 2.5);
          setSub(ctx, 6);
          ctx.fillStyle = "#36383e";
          ctx.fill();
          setSub(ctx, 7);
          ctx.strokeStyle = "#f2efe9";
          ctx.lineWidth = 1.4;
          ctx.stroke();
          setSub(ctx, 8);
          ctx.fillStyle = "#1f2024";
          ctx.beginPath();
          ctx.arc(1.5, 0, ts * 0.34, -Math.PI * 0.5, Math.PI * 0.5);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    // 6. Highway Shield Badge
    let shieldPt = mw.shieldPt;
    if (!shieldPt) {
      shieldPt = samples[Math.floor(samples.length * 0.5)];
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
        for (const ic of world.interchanges || []) {
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
    }
    const bx = shieldPt.x * ts + ts * 0.5;
    const by = shieldPt.y * ts + ts * 0.5;

    ctx.beginPath();
    const sw = 11;
    const sh = 12;
    ctx.moveTo(bx - sw, by - sh * 0.75);
    ctx.lineTo(bx + sw, by - sh * 0.75);
    ctx.lineTo(bx + sw, by + sh * 0.15);
    ctx.quadraticCurveTo(bx, by + sh, bx, by + sh);
    ctx.quadraticCurveTo(bx, by + sh, bx - sw, by + sh * 0.15);
    ctx.closePath();
    setSub(ctx, 9);
    ctx.fillStyle = "#f2efe9";
    ctx.fill();
    setSub(ctx, 10);
    ctx.strokeStyle = "#36383e";
    ctx.lineWidth = 2.2;
    ctx.stroke();

    ctx.fillStyle = "#36383e";
    ctx.font = "800 11px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(mw.number), bx, by + 0.5);
    ctx.restore();
  }
}

/**
 * Records Level-2 overpass bridge spans (clipped drop shadows, upper bridge decks, and parapet railings).
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 */
export function recordOverpassBridges(ctx, world, ts) {
  const ox = ts * 0.5;
  const oy = ts * 0.5;

  for (const ic of world.interchanges || []) {
    if (ic.type === "cloverleaf") {
      const cx = ic.x * ts + ox;
      const cy = ic.y * ts + oy;
      const span = ts * 1.32;
      const bridgeAng = ic.prunedBridgeB ? ic.angleA : ic.angleB;
      const lowerAng = ic.prunedBridgeB ? ic.angleB : ic.angleA;
      const ux = Math.cos(bridgeAng);
      const uy = Math.sin(bridgeAng);
      const nx = -uy;
      const ny = ux;
      const halfDeck = ts * 0.46;
      const lux = Math.cos(lowerAng);
      const luy = Math.sin(lowerAng);

      const lowerClip = new Path2DCtor();
      extrudeRibbonToPath2D(
        lowerClip,
        [
          {
            x: cx - lux * 2.2 * ts,
            y: cy - luy * 2.2 * ts,
            halfW: ts * 0.44,
          },
          {
            x: cx + lux * 2.2 * ts,
            y: cy + luy * 2.2 * ts,
            halfW: ts * 0.44,
          },
        ],
        false,
      );

      ctx.save();
      ctx.clip(lowerClip);
      setSub(ctx, 0);
      ctx.lineCap = "butt";
      ctx.strokeStyle = "rgba(45, 42, 38, 0.20)";
      ctx.lineWidth = ts * 0.92;
      ctx.beginPath();
      ctx.moveTo(cx - ux * span + 3.2, cy - uy * span + 4.4);
      ctx.lineTo(cx + ux * span + 3.2, cy + uy * span + 4.4);
      ctx.stroke();
      ctx.restore();
      nextPass(ctx);

      ctx.save();
      ctx.lineCap = "butt";

      setSub(ctx, 1);
      ctx.strokeStyle = PALETTE.motorwayBorder;
      ctx.lineWidth = ts * 0.88;
      ctx.beginPath();
      ctx.moveTo(cx - ux * span, cy - uy * span);
      ctx.lineTo(cx + ux * span, cy + uy * span);
      ctx.stroke();

      setSub(ctx, 2);
      ctx.strokeStyle = "#ee6998";
      ctx.lineWidth = ts * 0.72;
      ctx.beginPath();
      ctx.moveTo(cx - ux * span, cy - uy * span);
      ctx.lineTo(cx + ux * span, cy + uy * span);
      ctx.stroke();

      setSub(ctx, 3);
      ctx.strokeStyle = PALETTE.motorwayCore;
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(cx - ux * span, cy - uy * span);
      ctx.lineTo(cx + ux * span, cy + uy * span);
      ctx.stroke();

      setSub(ctx, 4);
      ctx.strokeStyle = "#36383e";
      ctx.lineWidth = 2.2;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(
          cx - ux * span + nx * halfDeck * side,
          cy - uy * span + ny * halfDeck * side,
        );
        ctx.lineTo(
          cx + ux * span + nx * halfDeck * side,
          cy + uy * span + ny * halfDeck * side,
        );
        ctx.stroke();
      }
      ctx.restore();
      nextPass(ctx);
    } else if (ic.type === "trumpet") {
      const cx = ic.x * ts + ox;
      const cy = ic.y * ts + oy;
      const sy = ic.sideSign || 1;
      const spurAng = ic.angleMain + Math.PI * 0.5 * sy;
      const ux = Math.cos(spurAng);
      const uy = Math.sin(spurAng);
      const nx = -uy;
      const ny = ux;
      const spanIn = ts * 0.56;
      const spanOut = ts * 0.44;
      const halfDeck = ts * 0.45;
      const lux = Math.cos(ic.angleMain);
      const luy = Math.sin(ic.angleMain);

      const lowerClip = new Path2DCtor();
      extrudeRibbonToPath2D(
        lowerClip,
        [
          {
            x: cx - lux * 2.0 * ts,
            y: cy - luy * 2.0 * ts,
            halfW: ts * 0.44,
          },
          {
            x: cx + lux * 2.0 * ts,
            y: cy + luy * 2.0 * ts,
            halfW: ts * 0.44,
          },
        ],
        false,
      );

      ctx.save();
      ctx.clip(lowerClip);
      setSub(ctx, 0);
      ctx.lineCap = "butt";
      ctx.strokeStyle = "rgba(45, 42, 38, 0.20)";
      ctx.lineWidth = ts * 0.84;
      ctx.beginPath();
      ctx.moveTo(cx + ux * spanIn + 3.2, cy + uy * spanIn + 4.4);
      ctx.lineTo(cx - ux * spanOut + 3.2, cy - uy * spanOut + 4.4);
      ctx.stroke();
      ctx.restore();
      nextPass(ctx);

      ctx.save();
      ctx.lineCap = "butt";

      setSub(ctx, 1);
      ctx.strokeStyle = PALETTE.motorwayBorder;
      ctx.lineWidth = ts * 0.86;
      ctx.beginPath();
      ctx.moveTo(cx + ux * spanIn, cy + uy * spanIn);
      ctx.lineTo(cx - ux * spanOut, cy - uy * spanOut);
      ctx.stroke();

      setSub(ctx, 2);
      ctx.strokeStyle = "#ee6998";
      ctx.lineWidth = ts * 0.7;
      ctx.beginPath();
      ctx.moveTo(cx + ux * spanIn, cy + uy * spanIn);
      ctx.lineTo(cx - ux * spanOut, cy - uy * spanOut);
      ctx.stroke();

      setSub(ctx, 3);
      ctx.strokeStyle = PALETTE.motorwayCore;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(cx + ux * spanIn, cy + uy * spanIn);
      ctx.lineTo(cx - ux * spanOut, cy - uy * spanOut);
      ctx.stroke();

      setSub(ctx, 4);
      ctx.strokeStyle = "#36383e";
      ctx.lineWidth = 2.0;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(
          cx + ux * spanIn + nx * halfDeck * side,
          cy + uy * spanIn + ny * halfDeck * side,
        );
        ctx.lineTo(
          cx - ux * spanOut + nx * halfDeck * side,
          cy - uy * spanOut + ny * halfDeck * side,
        );
        ctx.stroke();
      }
      ctx.restore();
      nextPass(ctx);
    }
  }
}
