/**
 * Airport Entity Vector Layer Recorder and Overlays.
 *
 * Renders multi-tier concrete ground pads, dual/single runways, taxiways, gate stand T-markings,
 * terminal concourses, ATC control towers, floating IATA badge pills, airway corridors,
 * candidate suitability heatmaps, and airport selection reticles.
 *
 * Invariants:
 * - 100% Worker-safe: zero window, document, or DOM references.
 * - Zero render-side mutations: never initializes or mutates ap.atc.
 *
 * @import { ProceduralLogisticsWorld } from '../../world-generator.js'
 * @import { Airport, FlightTrack, PlaneEndpoint } from '../../types.js'
 */
import { PALETTE } from "../../palette.js";
import { computeActiveRunwaySign } from "./layout.js";
import { buildFlightTrack } from "../../simulator.js";

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
 * Draws the cylindrical airport control tower with base, casing, and accent dome.
 *
 * @param {any} ctx
 * @param {number} towerX
 * @param {number} termY
 * @param {number} ts
 * @param {string} accentColor
 */
export function drawAirportTower(ctx, towerX, termY, ts, accentColor) {
  setSub(ctx, 4);
  ctx.fillStyle = PALETTE.shadowColor;
  ctx.beginPath();
  ctx.arc(towerX + 4, termY + 4, ts * 0.48, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(towerX, termY, ts * 0.48, 0, Math.PI * 2);
  setSub(ctx, 5);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  setSub(ctx, 6);
  ctx.strokeStyle = "#36383e";
  ctx.lineWidth = 2;
  ctx.stroke();

  setSub(ctx, 7);
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.arc(towerX, termY, ts * 0.22, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Records airport concrete ground pads, gate bays, and curbside loop plazas.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 */
export function recordAirportGroundPads(ctx, world, ts) {
  for (const ap of world.airports || []) {
    const cx = ap.x * ts + ts * 0.5;
    const cy = ap.y * ts + ts * 0.5;
    const rwyLen = ap.halfLen * 2 * ts;
    const padLen = rwyLen + ts * 1.8;
    const padWid = ap.halfWid * 2 * ts + ts * (ap.isHub ? 2.1 : 1.9);
    const side = ap.apronSide || 1;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ap.angleRad || 0);

    // 1. Airport Perimeter Concrete Apron Pad
    ctx.beginPath();
    ctx.roundRect(-padLen * 0.5, -padWid * 0.5, padLen, padWid, 11);
    setSub(ctx, 0);
    ctx.fillStyle = "#e5e2dc";
    ctx.fill();
    setSub(ctx, 1);
    ctx.strokeStyle = "#b6b4ae";
    ctx.lineWidth = 2;
    ctx.stroke();

    // 2. Dedicated Apron Gate Parking Ramp Bay (recessed off the parallel taxiway)
    const termW = ap.isHub ? rwyLen * 0.46 : rwyLen * 0.4;
    const termH = ts * (ap.isHub ? 0.76 : 0.7);
    const termY = side * ts * (ap.isHub ? 1.66 : 1.54);
    const apronInnerY = ap.isHub ? -side * ts * 0.6 : side * ts * 0.22;
    const apronRampW = termW * (ap.isHub ? 0.92 : 1.02);
    const apronTopY = Math.min(apronInnerY, termY);
    const apronBoxH = Math.abs(termY - apronInnerY);
    ctx.beginPath();
    ctx.roundRect(-apronRampW * 0.5, apronTopY, apronRampW, apronBoxH, 4);
    setSub(ctx, 2);
    ctx.fillStyle = "#d9d5cd";
    ctx.fill();

    // 3. Transit / Parking Plaza Island inside the Curbside Loop
    const termOuterY = termY + side * (termH * 0.5);
    const loopW = termW * (ap.isHub ? 0.82 : 0.88);
    const loopInnerY = termOuterY + side * (ts * 0.2);
    const loopOuterY = loopInnerY + side * (ts * 0.98);
    const loopBoxH = Math.abs(loopOuterY - loopInnerY);

    const plazaMidY = (loopInnerY + loopOuterY) * 0.5;
    const plazaW = loopW * 0.74;
    const plazaH = loopBoxH * 0.45;
    ctx.beginPath();
    ctx.roundRect(-plazaW * 0.5, plazaMidY - plazaH * 0.5, plazaW, plazaH, 3.5);
    setSub(ctx, 2);
    ctx.fillStyle = "#d8d5ce";
    ctx.fill();
    setSub(ctx, 3);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.restore();
  }
}

/**
 * Records airport surface structures (runways, taxiways, gate stand T-markings,
 * concourses, control towers, and floating IATA badge pills).
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 */
export function recordAirportStructures(ctx, world, ts) {
  for (const ap of world.airports || []) {
    const cx = ap.x * ts + ts * 0.5;
    const cy = ap.y * ts + ts * 0.5;
    const rwyLen = ap.halfLen * 2 * ts;
    const rwyWid = ts * (ap.isHub ? 1.26 : 1.1);
    const padLen = rwyLen + ts * 1.8;
    const padWid = ap.halfWid * 2 * ts + ts * (ap.isHub ? 2.1 : 1.9);
    const side = ap.apronSide || 1;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ap.angleRad || 0);

    if (ap.isHub) {
      // =================================================================
      // TIER 1: INTERNATIONAL DUAL-RUNWAY HUB (Parallel Runways L & R)
      // =================================================================
      const mainRwyY = -side * (ts * 1.72);
      const outerRwyY = -side * (ts * 3.35);
      const centralTaxiY = -side * (ts * 0.6);

      // High-speed parallel & cross-field taxiways
      setSub(ctx, 0);
      ctx.strokeStyle = "#9ca0a6";
      ctx.lineWidth = ts * 0.36;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-rwyLen * 0.41, centralTaxiY);
      ctx.lineTo(rwyLen * 0.41, centralTaxiY);
      for (const xFrac of [-0.41, -0.18, 0.18, 0.41]) {
        ctx.moveTo(rwyLen * xFrac, centralTaxiY);
        ctx.lineTo(rwyLen * (xFrac * 1.04), outerRwyY);
      }
      ctx.stroke();

      // Yellow taxiway centerlines
      setSub(ctx, 1);
      ctx.strokeStyle = "#f4c24f";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(-rwyLen * 0.41, centralTaxiY);
      ctx.lineTo(rwyLen * 0.41, centralTaxiY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Render both Parallel Runways (Primary + Secondary)
      for (const [ry, rLenScale, rWidScale] of [
        [mainRwyY, 1.0, 1.0],
        [outerRwyY, 0.88, 0.86],
      ]) {
        const curLen = rwyLen * rLenScale;
        const curWid = rwyWid * rWidScale;
        setSub(ctx, 2);
        ctx.fillStyle = "#36383e";
        ctx.beginPath();
        ctx.roundRect(-curLen * 0.5, ry - curWid * 0.5, curLen, curWid, 4);
        ctx.fill();

        setSub(ctx, 3);
        ctx.strokeStyle = "#f2efe9";
        ctx.lineWidth = 1.6;
        ctx.setLineDash([7, 6]);
        ctx.beginPath();
        ctx.moveTo(-curLen * 0.4, ry);
        ctx.lineTo(curLen * 0.4, ry);
        ctx.stroke();
        ctx.setLineDash([]);

        // Runway piano-key threshold markings
        ctx.fillStyle = "#f2efe9";
        for (const endSign of [-1, 1]) {
          const tx = endSign * (curLen * 0.44);
          for (let b = -2; b <= 2; b++) {
            if (b === 0) continue;
            ctx.fillRect(tx - 3, ry + b * (curWid * 0.16) - 1, 6, 1.8);
          }
        }
      }

      // Multi-Wing International Terminal Concourse + Jetbridges
      const termW = rwyLen * 0.46;
      const termH = ts * 0.76;
      const termY = side * (ts * 1.66);
      const termInnerY = termY - side * (termH * 0.5);

      // Jetbridge fingers
      setSub(ctx, 3);
      ctx.strokeStyle = "#7c7f87";
      ctx.lineWidth = 3.0;
      for (let g = -3; g <= 3; g++) {
        const gx = g * (termW * 0.12);
        ctx.beginPath();
        ctx.moveTo(gx, termY);
        ctx.lineTo(gx, termInnerY - side * (ts * 0.08));
        ctx.stroke();
      }

      // Apron gate stand lead-in lines & T-markings
      setSub(ctx, 1);
      ctx.strokeStyle = "#f4c24f";
      ctx.lineWidth = 1.2;
      const hubStandY = side * (ts * 1.2);
      const hubStopBarHalf = ts * 0.16;
      ctx.beginPath();
      for (let g = -3; g <= 3; g++) {
        const gx = g * (termW * 0.12);
        ctx.moveTo(gx, centralTaxiY);
        ctx.lineTo(gx, hubStandY);
        ctx.moveTo(gx - hubStopBarHalf, hubStandY);
        ctx.lineTo(gx + hubStopBarHalf, hubStandY);
      }
      ctx.stroke();

      // Terminal Shadow, Base & Roof
      setSub(ctx, 4);
      ctx.fillStyle = PALETTE.shadowColor;
      ctx.beginPath();
      ctx.roundRect(-termW * 0.5 + 4, termY - termH * 0.5 + 4, termW, termH, 6);
      ctx.fill();

      setSub(ctx, 5);
      ctx.fillStyle = ap.palette.base;
      ctx.beginPath();
      ctx.roundRect(-termW * 0.5, termY - termH * 0.5, termW, termH, 6);
      ctx.fill();

      setSub(ctx, 6);
      ctx.fillStyle = ap.palette.roof;
      ctx.beginPath();
      ctx.roundRect(
        -termW * 0.5 + 2,
        termY - termH * 0.5 + 2,
        termW - 4,
        termH * 0.76,
        4,
      );
      ctx.fill();

      // Demand Pins along Concourse Roof
      setSub(ctx, 7);
      ctx.fillStyle = "#ffffff";
      const hubPins = ap.demandPins || 0;
      for (let p = 0; p < hubPins; p++) {
        const px =
          -termW * 0.38 + (p / Math.max(1, hubPins - 1)) * (termW * 0.76);
        ctx.beginPath();
        ctx.arc(px, termY, 2.3, 0, Math.PI * 2);
        ctx.fill();
      }

      // ATC Control Tower
      const towerX = termW * 0.5 + ts * 0.62;
      drawAirportTower(ctx, towerX, termY, ts, ap.palette.roof);
    } else {
      // =================================================================
      // TIER 2 & 3: REGIONAL COMMERCIAL ('REG') OR AIR CARGO ('CRG')
      // =================================================================
      const mainRwyY = -side * (ts * 1.68);
      const taxiY = -side * (ts * 0.62);

      setSub(ctx, 0);
      ctx.strokeStyle = "#9ca0a6";
      ctx.lineWidth = ts * 0.34;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-rwyLen * 0.38, taxiY);
      ctx.lineTo(rwyLen * 0.38, taxiY);
      ctx.moveTo(-rwyLen * 0.38, taxiY);
      ctx.lineTo(-rwyLen * 0.43, mainRwyY);
      ctx.moveTo(0, taxiY);
      ctx.lineTo(0, mainRwyY);
      ctx.moveTo(rwyLen * 0.38, taxiY);
      ctx.lineTo(rwyLen * 0.43, mainRwyY);
      ctx.stroke();

      // Main Asphalt Runway Strip
      setSub(ctx, 2);
      ctx.fillStyle = "#36383e";
      ctx.beginPath();
      ctx.roundRect(-rwyLen * 0.5, mainRwyY - rwyWid * 0.5, rwyLen, rwyWid, 4);
      ctx.fill();

      setSub(ctx, 3);
      ctx.strokeStyle = "#f2efe9";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(-rwyLen * 0.38, mainRwyY);
      ctx.lineTo(rwyLen * 0.38, mainRwyY);
      ctx.stroke();
      ctx.setLineDash([]);

      const termW = rwyLen * 0.4;
      const termH = ts * 0.7;
      const termY = side * (ts * 1.54);

      // Compact short yellow gate stand T-markings
      setSub(ctx, 1);
      ctx.strokeStyle = "#f4c24f";
      ctx.lineWidth = 1.2;
      const regFracs =
        ap.airportClass === "CRG"
          ? [-0.42, -0.22, 0.22, 0.42]
          : [-0.36, -0.12, 0.12, 0.36];
      const regStandStartY = side * (ts * 0.68);
      const regStandY = side * (ts * 1.12);
      const regStopBarHalf = ts * 0.14;
      ctx.beginPath();
      for (const frac of regFracs) {
        const gx = frac * termW;
        ctx.moveTo(gx, regStandStartY);
        ctx.lineTo(gx, regStandY);
        ctx.moveTo(gx - regStopBarHalf, regStandY);
        ctx.lineTo(gx + regStopBarHalf, regStandY);
      }
      ctx.stroke();

      if (ap.airportClass === "CRG") {
        // Cargo Airfield: Twin Modular Warehouse Sortation Pads
        for (const wSign of [-1, 1]) {
          const wx = wSign * (termW * 0.32);
          const ww = termW * 0.48;
          setSub(ctx, 4);
          ctx.fillStyle = PALETTE.shadowColor;
          ctx.beginPath();
          ctx.roundRect(
            wx - ww * 0.5 + 4,
            termY - termH * 0.5 + 4,
            ww,
            termH,
            4,
          );
          ctx.fill();

          setSub(ctx, 5);
          ctx.fillStyle = ap.palette.base;
          ctx.beginPath();
          ctx.roundRect(wx - ww * 0.5, termY - termH * 0.5, ww, termH, 4);
          ctx.fill();

          setSub(ctx, 6);
          ctx.fillStyle = ap.palette.roof;
          ctx.beginPath();
          ctx.roundRect(
            wx - ww * 0.5 + 1.5,
            termY - termH * 0.5 + 1.5,
            ww - 3,
            termH * 0.75,
            3,
          );
          ctx.fill();
        }
      } else {
        // Regional Passenger Terminal Concourse
        setSub(ctx, 4);
        ctx.fillStyle = PALETTE.shadowColor;
        ctx.beginPath();
        ctx.roundRect(
          -termW * 0.5 + 5,
          termY - termH * 0.5 + 5,
          termW,
          termH,
          6,
        );
        ctx.fill();

        setSub(ctx, 5);
        ctx.fillStyle = ap.palette.base;
        ctx.beginPath();
        ctx.roundRect(-termW * 0.5, termY - termH * 0.5, termW, termH, 6);
        ctx.fill();

        setSub(ctx, 6);
        ctx.fillStyle = ap.palette.roof;
        ctx.beginPath();
        ctx.roundRect(
          -termW * 0.5 + 2,
          termY - termH * 0.5 + 2,
          termW - 4,
          termH * 0.76,
          5,
        );
        ctx.fill();
      }

      // Demand Pins on Roof
      setSub(ctx, 7);
      ctx.fillStyle = "#ffffff";
      const regPins = ap.demandPins || 0;
      for (let p = 0; p < regPins; p++) {
        const px =
          -termW * 0.34 + (p / Math.max(1, regPins - 1)) * (termW * 0.68);
        ctx.beginPath();
        ctx.arc(px, termY, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      const towerX = termW * 0.5 + ts * 0.65;
      drawAirportTower(ctx, towerX, termY, ts, ap.palette.roof);
    }

    ctx.restore();

    const cosA = Math.cos(ap.angleRad || 0);
    const sinA = Math.sin(ap.angleRad || 0);
    const gatePy = ap.gateY * ts + ts * 0.5;

    // Floating Minimalist IATA & Tier Pill Tag
    const corners = [
      [-padLen * 0.5, -padWid * 0.5],
      [padLen * 0.5, -padWid * 0.5],
      [padLen * 0.5, padWid * 0.5],
      [-padLen * 0.5, padWid * 0.5],
    ];
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const [u, v] of corners) {
      const wx = cx + u * cosA - v * sinA;
      const wy = cy + u * sinA + v * cosA;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
    }
    if (gatePy < minY) minY = gatePy;
    if (gatePy > maxY) maxY = gatePy;

    ctx.save();
    ctx.font = "800 10px Inter, sans-serif";
    const badgePrefix =
      ap.airportClass === "HUB"
        ? "✈ HUB"
        : ap.airportClass === "CRG"
          ? "📦 CRG"
          : "✈ REG";
    const tagText = `${badgePrefix} • ${ap.iata}`;
    const tw = ctx.measureText(tagText).width + 14;

    const badgeX = Math.max(
      tw * 0.5 + 10,
      Math.min(world.W * ts - tw * 0.5 - 10, (minX + maxX) * 0.5),
    );
    const badgeY = minY >= 36 ? minY - 15 : maxY + 20;

    setSub(ctx, 8);
    ctx.fillStyle = ap.isHub ? "#e85c90" : "#36383e";
    ctx.beginPath();
    ctx.roundRect(badgeX - tw * 0.5, badgeY - 9, tw, 18, 9);
    ctx.fill();
    ctx.fillStyle = "#f2efe9";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(tagText, badgeX, badgeY);
    ctx.restore();
  }
}

/**
 * Records airway corridors between airports and external entry points.
 * CRITICAL FIX: NEVER mutates ap.atc!
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 */
export function recordAirwayCorridors(ctx, world, ts) {
  if (!world.airports || world.airports.length === 0) return;

  ctx.save();
  ctx.strokeStyle = "rgba(54, 56, 62, 0.12)";
  ctx.lineWidth = 1.1;
  ctx.setLineDash([5, 6]);

  const halfTs = ts * 0.5;

  /**
   * Strokes the complete airborne corridor.
   * @param {FlightTrack} track
   */
  const strokeTrackAirway = (track) => {
    const { pts } = track;
    let firstCruise = -1;
    let lastCruise = -1;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].phase === "CRUISE") {
        if (firstCruise === -1) firstCruise = i;
        lastCruise = i;
      }
    }
    if (firstCruise === -1) return;
    const i0 = Math.max(0, firstCruise - 1);
    const i1 = Math.min(pts.length - 1, lastCruise + 1);
    ctx.beginPath();
    ctx.moveTo(pts[i0].x * ts + halfTs, pts[i0].y * ts + halfTs);
    for (let i = i0 + 1; i <= i1; i++) {
      ctx.lineTo(pts[i].x * ts + halfTs, pts[i].y * ts + halfTs);
    }
    ctx.stroke();
  };

  if (world.airports.length >= 2) {
    for (const apA of world.airports) {
      for (const apB of world.airports) {
        if (apA.id === apB.id) continue;
        const oSign =
          apA.atc?.activeSign ??
          computeActiveRunwaySign(
            apA.angleRad ?? apA.angle ?? 0,
            world.windVector || null,
          );
        const dSign =
          apB.atc?.activeSign ??
          computeActiveRunwaySign(
            apB.angleRad ?? apB.angle ?? 0,
            world.windVector || null,
          );
        const track = buildFlightTrack(apA, apB, { oSign, dSign });
        strokeTrackAirway(track);
      }
    }
  } else if (world.airports.length === 1) {
    const ap = world.airports[0];
    if (ap) {
      const ang = ap.angleRad ?? ap.angle ?? 0;
      /** @type {PlaneEndpoint} */
      const dest = {
        x: ap.x + Math.cos(ang + 0.35) * 95,
        y: ap.y + Math.sin(ang + 0.35) * 95,
        angleRad: ang,
        halfLen: 6,
      };
      const oSign =
        ap.atc?.activeSign ??
        computeActiveRunwaySign(ang, world.windVector || null);
      const track = buildFlightTrack(ap, dest, { oSign });
      strokeTrackAirway(track);
    }
  }

  // External trade airway corridors to map-border entry points
  for (const ap of world.airports) {
    for (const corr of ap.externalCorridors || []) {
      const sx = ap.x;
      const sy = ap.y;
      const ex = corr.entryX;
      const ey = corr.entryY;
      const cdx = ex - sx;
      const cdy = ey - sy;
      const cDist = Math.hypot(cdx, cdy) || 1;
      const ang = ap.angleRad ?? ap.angle ?? 0;
      const cosAng = Math.cos(ang);
      const sinAng = Math.sin(ang);
      const dot = cdx * cosAng + cdy * sinAng;
      const sign = dot >= 0 ? 1 : -1;
      const pull = Math.min(24, Math.max(6, cDist * 0.35));
      const c1x = sx + cosAng * sign * pull;
      const c1y = sy + sinAng * sign * pull;
      const corrAng = corr.angleRad ?? Math.atan2(cdy, cdx);
      const c2x = ex - Math.cos(corrAng) * (pull * 0.7);
      const c2y = ey - Math.sin(corrAng) * (pull * 0.7);

      ctx.beginPath();
      ctx.moveTo(sx * ts + halfTs, sy * ts + halfTs);
      ctx.bezierCurveTo(
        c1x * ts + halfTs,
        c1y * ts + halfTs,
        c2x * ts + halfTs,
        c2y * ts + halfTs,
        ex * ts + halfTs,
        ey * ts + halfTs,
      );
      ctx.stroke();
    }
  }

  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Draws the airport candidate suitability heatmap, NIMBY noise rings, and approach obstacle funnels.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 */
export function drawAirportSolverOverlay(ctx, world, ts) {
  ctx.save();
  // 1. Render Multi-Criteria Airport Candidate Suitability Heatmap
  if (world.airportHeatmap) {
    for (let y = 0; y < world.H; y += 2) {
      for (let x = 0; x < world.W; x += 2) {
        const score = world.airportHeatmap[world.idx(x, y)];
        if (score > 0.05) {
          ctx.fillStyle =
            score > 0.65
              ? `rgba(16, 185, 129, ${score * 0.55})`
              : `rgba(245, 158, 11, ${score * 0.45})`;
          ctx.fillRect(x * ts, y * ts, ts * 2, ts * 2);
        }
      }
    }
  }

  // 2. Render NIMBY Urban Noise Exclusion Rings around Towns
  for (const t of world.towns || []) {
    ctx.strokeStyle = "rgba(239, 68, 68, 0.55)";
    ctx.fillStyle = "rgba(239, 68, 68, 0.08)";
    ctx.lineWidth = 1.8;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.arc(
      t.x * ts + ts * 0.5,
      t.y * ts + ts * 0.5,
      t.urbanRadius * 0.78 * ts,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 3. Render Trapezoidal Approach Obstacle-Clearance Funnels on Both Runway Ends
  for (const ap of world.airports || []) {
    const cx = ap.x * ts + ts * 0.5;
    const cy = ap.y * ts + ts * 0.5;
    const rwyHalf = ap.halfLen * ts;
    const appLen = (ap.approachLen || 12) * ts;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ap.angleRad || 0);

    for (const sign of [-1, 1]) {
      ctx.fillStyle = "rgba(16, 185, 129, 0.22)";
      ctx.strokeStyle = "#059669";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(sign * rwyHalf, -ts * 0.9);
      ctx.lineTo(sign * (rwyHalf + appLen), -ts * 3.6);
      ctx.lineTo(sign * (rwyHalf + appLen), ts * 3.6);
      ctx.lineTo(sign * rwyHalf, ts * 0.9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

/**
 * Draws the high-contrast selection frame for an active airport.
 *
 * @param {any} ctx
 * @param {any} _world
 * @param {Airport} ap
 * @param {number} ts
 */
export function drawAirportSelectionHighlight(ctx, _world, ap, ts) {
  const ox = ts * 0.5;
  const oy = ts * 0.5;
  const cx = ap.x * ts + ox;
  const cy = ap.y * ts + oy;
  const padLen = (ap.halfLen * 2 + 2.4) * ts;
  const padWid = (ap.halfWid * 2 + (ap.isHub ? 2.4 : 1.8)) * ts;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ap.angleRad || 0);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 5.0;
  ctx.beginPath();
  ctx.roundRect(-padLen * 0.5, -padWid * 0.5, padLen, padWid, 12);
  ctx.stroke();

  ctx.strokeStyle = "#e85c90";
  ctx.lineWidth = 2.6;
  ctx.setLineDash([8, 5]);
  ctx.beginPath();
  ctx.roundRect(-padLen * 0.5, -padWid * 0.5, padLen, padWid, 12);
  ctx.stroke();
  ctx.restore();
}
