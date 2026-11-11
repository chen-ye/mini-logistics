/**
 * RCI Building Entity Vector Layer Recorder and Overlays.
 *
 * Renders Residential houses, Commercial CBD rotundas, arterial halls, corner markets,
 * and 5 RAW resource niches (foothill mines, timber camps, farmsteads, coastal fish wharves,
 * chemical refineries) + 4 bespoke MFG manufacturing silhouettes (Steel, Food, Tech, Goods)
 * + cross-dock Logistics hubs, RCI zone halos, supply chain flow vectors, and selection highlights.
 *
 * Invariants:
 * - 100% Worker-safe: zero window, document, or DOM references.
 * - Exact setSubLayer(0..10) batching preserved.
 *
 * @import { ProceduralLogisticsWorld } from '../../world-generator.js'
 * @import { Destination } from '../../types.js'
 */
import { PALETTE } from "../../palette.js";
import { getCargoStageColor } from "./catalog.js";
import { traceSmoothPath } from "../../render/road-network-layer.js";

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
 * Records residential houses and commercial/industrial destinations into a display list or context.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 * @param {boolean} [isRCI=false]
 */
export function recordBuildingsAndHouses(ctx, world, ts, isRCI = false) {
  // 1. Residential Houses
  for (const h of world.houses || []) {
    const cx = (h.x + (h.offX || 0)) * ts + ts * 0.5;
    const cy = (h.y + (h.offY || 0)) * ts + ts * 0.5;
    const hw = ts * (h.wScale || 0.72);
    const hh = ts * (h.hScale || 0.72);
    const baseCol = isRCI ? "#15803d" : h.palette.base;
    const roofCol = isRCI ? "#22c55e" : h.palette.roof;

    setSub(ctx, 0);
    ctx.fillStyle = PALETTE.shadowColor;
    ctx.beginPath();
    ctx.roundRect(cx - hw * 0.5 + 3.0, cy - hh * 0.5 + 3.0, hw, hh, 2.5);
    ctx.fill();

    setSub(ctx, 1);
    ctx.fillStyle = baseCol;
    ctx.beginPath();
    ctx.roundRect(cx - hw * 0.5, cy - hh * 0.5, hw, hh, 2.5);
    ctx.fill();

    setSub(ctx, 2);
    ctx.fillStyle = roofCol;
    ctx.beginPath();
    ctx.roundRect(cx - hw * 0.5, cy - hh * 0.5, hw, hh * 0.68, 2.5);
    ctx.fill();
  }

  nextPass(ctx);

  // 2. Differentiated Commercial & Industrial Multi-Dimension Sinks
  for (const d of world.destinations || []) {
    const cx = d.x * ts + ts * 0.5;
    const cy = d.y * ts + ts * 0.5;
    const wT = d.wTiles || 2;
    const hT = d.hTiles || 2;
    const lotW = (wT + 0.06) * ts;
    const lotH = (hT + 0.06) * ts;
    const bldW = (wT - 0.34) * ts;
    const bldH = (hT - 0.34) * ts;
    const isInd = d.zoneType === "industrial";

    let baseCol = d.palette.base;
    let roofCol = d.palette.roof;
    let pinCol = d.palette.pin;
    if (isRCI) {
      if (!isInd) {
        baseCol = "#1d4ed8";
        roofCol = "#3b82f6";
        pinCol = "#1e3a8a";
      } else if (d.isGatewayProxy) {
        baseCol = "#0f766e";
        roofCol = "#0d9488";
        pinCol = "#134e4a";
      } else if (d.subType === "RAW") {
        if (d.resourceType === "FISHERY") {
          baseCol = "#155e75";
          roofCol = "#0891b2";
          pinCol = "#164e63";
        } else if (d.resourceType === "CHEM") {
          baseCol = "#3f6212";
          roofCol = "#65a30d";
          pinCol = "#365314";
        } else {
          baseCol = "#b45309";
          roofCol = "#f59e0b";
          pinCol = "#78350f";
        }
      } else if (d.subType === "LOG") {
        baseCol = "#6d28d9";
        roofCol = "#a855f7";
        pinCol = "#4c1d95";
      } else {
        baseCol = "#c2410c";
        roofCol = "#ea580c";
        pinCol = "#7c2d12";
      }
    }

    if (!isInd) {
      // Commercial Sink (Rotunda, Arterial Hall, Corner Market)
      ctx.beginPath();
      ctx.roundRect(cx - lotW * 0.5, cy - lotH * 0.5, lotW, lotH, 4.5);
      setSub(ctx, 0);
      ctx.fillStyle = isRCI ? "#dbeafe" : "#eceae4";
      ctx.fill();
      setSub(ctx, 1);
      ctx.strokeStyle = isRCI ? "#60a5fa" : "#b8b5ad";
      ctx.lineWidth = 1.25;
      ctx.stroke();

      const minDim = Math.min(bldW, bldH);
      setSub(ctx, 2);
      ctx.fillStyle = PALETTE.shadowColor;
      ctx.beginPath();
      if (d.isCircular) {
        ctx.arc(cx + 5.2, cy + 5.2, minDim * 0.52, 0, Math.PI * 2);
      } else {
        ctx.roundRect(
          cx - bldW * 0.5 + 4.8,
          cy - bldH * 0.5 + 4.8,
          bldW,
          bldH,
          4,
        );
      }
      ctx.fill();

      setSub(ctx, 3);
      ctx.fillStyle = baseCol;
      ctx.beginPath();
      if (d.isCircular) {
        ctx.arc(cx, cy, minDim * 0.52, 0, Math.PI * 2);
      } else {
        ctx.roundRect(cx - bldW * 0.5, cy - bldH * 0.5, bldW, bldH, 4);
      }
      ctx.fill();

      setSub(ctx, 4);
      ctx.fillStyle = roofCol;
      ctx.beginPath();
      if (d.isCircular) {
        ctx.arc(cx, cy - 1.6, minDim * 0.45, 0, Math.PI * 2);
      } else {
        ctx.roundRect(
          cx - bldW * 0.5 + 1.4,
          cy - bldH * 0.5 + 1.4,
          bldW - 2.8,
          bldH * 0.78,
          3,
        );
      }
      ctx.fill();

      setSub(ctx, 5);
      ctx.fillStyle = "rgba(255, 255, 255, 0.36)";
      ctx.beginPath();
      if (d.isCircular) {
        ctx.arc(cx, cy - 1.6, minDim * 0.22, 0, Math.PI * 2);
      } else {
        ctx.roundRect(
          cx - bldW * 0.28,
          cy - bldH * 0.34,
          bldW * 0.56,
          bldH * 0.32,
          2,
        );
      }
      ctx.fill();

      const cols = wT >= hT ? Math.min(3, Math.max(2, wT)) : Math.min(2, wT);
      const rows = Math.ceil((d.pinsCount || 0) / cols);
      for (let p = 0; p < (d.pinsCount || 0); p++) {
        let px, py;
        if (d.isCircular) {
          const ang = (p / d.pinsCount) * Math.PI * 2;
          px = cx + Math.cos(ang) * (minDim * 0.3);
          py = cy - 1.6 + Math.sin(ang) * (minDim * 0.3);
        } else {
          const col = p % cols;
          const row = Math.floor(p / cols);
          const spanX = bldW * 0.54;
          const spanY = bldH * 0.44;
          px = cols === 1 ? cx : cx - spanX * 0.5 + (col / (cols - 1)) * spanX;
          py =
            rows <= 1
              ? cy - bldH * 0.12
              : cy - spanY * 0.55 + (row / (rows - 1)) * spanY;
        }
        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, Math.PI * 2);
        setSub(ctx, 7);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        setSub(ctx, 8);
        ctx.strokeStyle = pinCol;
        ctx.lineWidth = 1.35;
        ctx.stroke();
      }
    } else {
      // Industrial Facility (RAW, MFG, LOG)
      ctx.beginPath();
      ctx.roundRect(cx - lotW * 0.5, cy - lotH * 0.5, lotW, lotH, 3);
      setSub(ctx, 0);
      ctx.fillStyle = isRCI
        ? "#fef3c7"
        : d.resourceType === "FARM"
          ? "#e5dec9"
          : "#d5d2ca";
      ctx.fill();
      setSub(ctx, 1);
      ctx.strokeStyle = isRCI
        ? "#f59e0b"
        : d.resourceType === "FARM"
          ? "#a89f89"
          : "#8c8980";
      ctx.lineWidth = 1.45;
      ctx.stroke();

      if (d.resourceType !== "FARM") {
        ctx.fillStyle = "rgba(217, 119, 6, 0.48)";
        const stripeCount = Math.max(3, wT * 2);
        for (let s = 0; s < stripeCount; s++) {
          const sx = cx - lotW * 0.36 + (s / (stripeCount - 1)) * (lotW * 0.72);
          ctx.fillRect(sx - 2, cy + lotH * 0.36, 4, 2.8);
        }
      } else {
        ctx.fillStyle = "rgba(168, 152, 124, 0.42)";
        ctx.fillRect(cx - lotW * 0.32, cy + lotH * 0.35, lotW * 0.64, 2.4);
      }

      setSub(ctx, 2);
      ctx.fillStyle = PALETTE.shadowColor;
      ctx.beginPath();
      ctx.roundRect(
        cx - bldW * 0.5 + 4.8,
        cy - bldH * 0.5 + 4.8,
        bldW,
        bldH * 0.9,
        3,
      );
      ctx.fill();

      if (d.subType === "RAW") {
        if (d.resourceType === "MINE") {
          // Quarry & Mine
          setSub(ctx, 3);
          ctx.fillStyle = baseCol;
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.48,
            cy - bldH * 0.44,
            bldW * 0.48,
            bldH * 0.84,
            2.5,
          );
          ctx.fill();

          setSub(ctx, 4);
          ctx.fillStyle = roofCol;
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.44,
            cy - bldH * 0.4,
            bldW * 0.4,
            bldH * 0.66,
            2,
          );
          ctx.fill();

          setSub(ctx, 3);
          ctx.fillStyle = "#a8a29e";
          ctx.beginPath();
          ctx.roundRect(
            cx + bldW * 0.04,
            cy - bldH * 0.42,
            bldW * 0.44,
            bldH * 0.8,
            3,
          );
          ctx.fill();

          setSub(ctx, 4);
          ctx.fillStyle = "#78716c";
          ctx.beginPath();
          ctx.roundRect(
            cx + bldW * 0.11,
            cy - bldH * 0.3,
            bldW * 0.3,
            bldH * 0.56,
            2,
          );
          ctx.fill();

          setSub(ctx, 5);
          ctx.fillStyle = "#57534e";
          ctx.beginPath();
          ctx.roundRect(
            cx + bldW * 0.18,
            cy - bldH * 0.18,
            bldW * 0.16,
            bldH * 0.32,
            1.5,
          );
          ctx.fill();
        } else if (d.resourceType === "TIMBER") {
          // Sawmill & Timber camp
          setSub(ctx, 3);
          ctx.fillStyle = baseCol;
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.48,
            cy - bldH * 0.44,
            bldW * 0.48,
            bldH * 0.84,
            2.5,
          );
          ctx.fill();

          setSub(ctx, 4);
          ctx.fillStyle = roofCol;
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.44,
            cy - bldH * 0.4,
            bldW * 0.4,
            bldH * 0.66,
            2,
          );
          ctx.fill();

          for (const lyOff of [-bldH * 0.26, 0, bldH * 0.26]) {
            setSub(ctx, 3);
            ctx.fillStyle = "#78350f";
            ctx.beginPath();
            ctx.roundRect(
              cx + bldW * 0.06,
              cy + lyOff - bldH * 0.09,
              bldW * 0.38,
              bldH * 0.18,
              2,
            );
            ctx.fill();

            setSub(ctx, 4);
            ctx.fillStyle = "#fde68a";
            ctx.beginPath();
            ctx.arc(cx + bldW * 0.41, cy + lyOff, bldH * 0.06, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (d.resourceType === "FARM") {
          // Agribusiness Farm
          setSub(ctx, 3);
          ctx.fillStyle = "#9e3b2b";
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.48,
            cy - bldH * 0.44,
            bldW * 0.5,
            bldH * 0.84,
            2.5,
          );
          ctx.fill();

          setSub(ctx, 4);
          ctx.fillStyle = "#c85644";
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.44,
            cy - bldH * 0.4,
            bldW * 0.42,
            bldH * 0.68,
            2,
          );
          ctx.fill();

          setSub(ctx, 5);
          ctx.fillStyle = "rgba(255, 255, 255, 0.52)";
          ctx.fillRect(cx - bldW * 0.235, cy - bldH * 0.38, 1.5, bldH * 0.64);
          ctx.fillRect(cx - bldW * 0.42, cy - bldH * 0.08, bldW * 0.38, 1.4);

          const siloR = Math.min(bldW, bldH) * 0.19;
          const siloX = cx + bldW * 0.24;
          const siloY = cy - bldH * 0.22;
          setSub(ctx, 3);
          ctx.strokeStyle = "#9ca3af";
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(cx + bldW * 0.02, siloY);
          ctx.lineTo(siloX, siloY);
          ctx.stroke();

          setSub(ctx, 4);
          ctx.fillStyle = "#6b7078";
          ctx.beginPath();
          ctx.arc(siloX, siloY, siloR, 0, Math.PI * 2);
          ctx.fill();

          setSub(ctx, 5);
          ctx.fillStyle = "#f5f5f4";
          ctx.beginPath();
          ctx.arc(siloX, siloY - 0.9, siloR * 0.78, 0, Math.PI * 2);
          ctx.fill();

          const ghX = cx + bldW * 0.06;
          const ghY = cy + bldH * 0.03;
          const ghW = bldW * 0.38;
          const ghH = bldH * 0.35;
          setSub(ctx, 3);
          ctx.fillStyle = "#84a595";
          ctx.beginPath();
          ctx.roundRect(ghX, ghY, ghW, ghH, 2);
          ctx.fill();

          setSub(ctx, 4);
          ctx.fillStyle = "#d7ebe2";
          ctx.beginPath();
          ctx.roundRect(ghX + 1.2, ghY + 1.2, ghW - 2.4, ghH - 2.4, 1.5);
          ctx.fill();

          setSub(ctx, 5);
          ctx.strokeStyle = "#84a595";
          ctx.lineWidth = 0.85;
          ctx.beginPath();
          ctx.moveTo(ghX + ghW * 0.35, ghY + 1);
          ctx.lineTo(ghX + ghW * 0.35, ghY + ghH - 1);
          ctx.moveTo(ghX + ghW * 0.68, ghY + 1);
          ctx.lineTo(ghX + ghW * 0.68, ghY + ghH - 1);
          ctx.stroke();
        } else if (d.resourceType === "FISHERY") {
          // Coastal Fish Wharf
          setSub(ctx, 3);
          ctx.fillStyle = baseCol;
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.48,
            cy - bldH * 0.44,
            bldW * 0.48,
            bldH * 0.84,
            2.5,
          );
          ctx.fill();

          setSub(ctx, 4);
          ctx.fillStyle = roofCol;
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.44,
            cy - bldH * 0.4,
            bldW * 0.4,
            bldH * 0.66,
            2,
          );
          ctx.fill();

          setSub(ctx, 5);
          ctx.fillStyle = "#0284c7";
          ctx.fillRect(cx - bldW * 0.44, cy - bldH * 0.4, bldW * 0.4, 1.8);
          ctx.fillRect(cx - bldW * 0.44, cy + bldH * 0.24, bldW * 0.4, 1.4);

          const pierW = bldW * 0.42;
          const pierH = bldH * 0.22;
          const pierX = cx + bldW * 0.04;
          for (const pyOff of [-bldH * 0.22, bldH * 0.22]) {
            setSub(ctx, 3);
            ctx.fillStyle = "#78716c";
            ctx.beginPath();
            ctx.roundRect(pierX, cy + pyOff - pierH * 0.5, pierW, pierH, 1.5);
            ctx.fill();

            setSub(ctx, 4);
            ctx.fillStyle = "#d6d3d1";
            ctx.beginPath();
            ctx.roundRect(
              pierX + 1.2,
              cy + pyOff - pierH * 0.5 + 1.0,
              pierW - 2.4,
              pierH - 2.0,
              1,
            );
            ctx.fill();
          }

          const tankR = Math.min(bldW, bldH) * 0.13;
          const tankCoords = [
            [cx + bldW * 0.16, cy],
            [cx + bldW * 0.34, cy],
          ];
          for (const [tx, ty] of tankCoords) {
            setSub(ctx, 4);
            ctx.fillStyle = "#0284c7";
            ctx.beginPath();
            ctx.arc(tx, ty, tankR, 0, Math.PI * 2);
            ctx.fill();

            setSub(ctx, 5);
            ctx.fillStyle = "#0ea5e9";
            ctx.beginPath();
            ctx.arc(tx, ty - 0.7, tankR * 0.8, 0, Math.PI * 2);
            ctx.fill();

            setSub(ctx, 6);
            ctx.fillStyle = "#e0f2fe";
            ctx.beginPath();
            ctx.arc(tx - 0.5, ty - 1.0, tankR * 0.34, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          // Chemical Works & Bulk Feedstock
          setSub(ctx, 3);
          ctx.fillStyle = baseCol;
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.48,
            cy - bldH * 0.44,
            bldW * 0.48,
            bldH * 0.84,
            2.5,
          );
          ctx.fill();

          setSub(ctx, 4);
          ctx.fillStyle = roofCol;
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.44,
            cy - bldH * 0.4,
            bldW * 0.4,
            bldH * 0.65,
            2,
          );
          ctx.fill();

          const rackX = cx + bldW * 0.16;
          setSub(ctx, 3);
          ctx.strokeStyle = "#64748b";
          ctx.lineWidth = 2.0;
          ctx.beginPath();
          ctx.moveTo(cx, cy - bldH * 0.26);
          ctx.lineTo(cx + bldW * 0.36, cy - bldH * 0.26);
          ctx.moveTo(cx, cy + bldH * 0.02);
          ctx.lineTo(cx + bldW * 0.36, cy + bldH * 0.02);
          ctx.moveTo(rackX, cy - bldH * 0.32);
          ctx.lineTo(rackX, cy + bldH * 0.3);
          ctx.stroke();

          const vatR = Math.min(bldW, bldH) * 0.135;
          const vatCoords = [
            [cx + bldW * 0.15, cy - bldH * 0.26],
            [cx + bldW * 0.35, cy - bldH * 0.26],
            [cx + bldW * 0.15, cy + bldH * 0.06],
          ];
          for (const [vx, vy] of vatCoords) {
            setSub(ctx, 4);
            ctx.fillStyle = "#334155";
            ctx.beginPath();
            ctx.arc(vx, vy, vatR, 0, Math.PI * 2);
            ctx.fill();

            setSub(ctx, 5);
            ctx.fillStyle = "#64748b";
            ctx.beginPath();
            ctx.arc(vx, vy - 0.6, vatR * 0.78, 0, Math.PI * 2);
            ctx.fill();

            setSub(ctx, 6);
            ctx.fillStyle = "#cbd5e1";
            ctx.beginPath();
            ctx.arc(vx - 0.5, vy - 0.9, vatR * 0.32, 0, Math.PI * 2);
            ctx.fill();
          }

          const stX = cx + bldW * 0.34;
          const stY = cy + bldH * 0.22;
          const stR = Math.min(bldW, bldH) * 0.13;
          setSub(ctx, 4);
          ctx.fillStyle = "#1e293b";
          ctx.beginPath();
          ctx.arc(stX, stY, stR, 0, Math.PI * 2);
          ctx.fill();

          setSub(ctx, 5);
          ctx.fillStyle = "#94a3b8";
          ctx.beginPath();
          ctx.arc(stX, stY, stR * 0.65, 0, Math.PI * 2);
          ctx.fill();

          setSub(ctx, 6);
          ctx.fillStyle = "#0f172a";
          ctx.beginPath();
          ctx.arc(stX, stY, stR * 0.35, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (d.subType === "LOG") {
        // Logistics Distribution Center
        setSub(ctx, 3);
        ctx.fillStyle = baseCol;
        ctx.beginPath();
        ctx.roundRect(cx - bldW * 0.5, cy - bldH * 0.42, bldW, bldH * 0.82, 3);
        ctx.fill();

        setSub(ctx, 4);
        ctx.fillStyle = roofCol;
        ctx.beginPath();
        ctx.roundRect(
          cx - bldW * 0.46,
          cy - bldH * 0.38,
          bldW * 0.92,
          bldH * 0.66,
          2,
        );
        ctx.fill();

        setSub(ctx, 5);
        ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
        const bays = Math.max(3, wT + 1);
        for (let b = 0; b < bays; b++) {
          const bx = cx - bldW * 0.32 + (b / (bays - 1)) * (bldW * 0.64);
          ctx.fillRect(bx - 1, cy - bldH * 0.34, 2, bldH * 0.56);
        }
      } else {
        // Secondary Manufacturing (MFG)
        setSub(ctx, 3);
        ctx.fillStyle = baseCol;
        ctx.beginPath();
        ctx.roundRect(cx - bldW * 0.5, cy - bldH * 0.46, bldW, bldH * 0.9, 2.5);
        ctx.fill();

        if (d.mfgType === "STEEL") {
          setSub(ctx, 4);
          ctx.fillStyle = roofCol;
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.46,
            cy - bldH * 0.42,
            bldW * 0.48,
            bldH * 0.8,
            2,
          );
          ctx.fill();

          ctx.fillStyle = "#27272a";
          ctx.beginPath();
          ctx.roundRect(
            cx + bldW * 0.04,
            cy - bldH * 0.4,
            bldW * 0.42,
            bldH * 0.76,
            1.5,
          );
          ctx.fill();

          setSub(ctx, 5);
          const lx = cx + bldW * 0.11;
          ctx.fillStyle = "#f97316";
          ctx.fillRect(lx - 1.2, cy - bldH * 0.35, 2.4, bldH * 0.66);
          ctx.fillStyle = "#fdba74";
          ctx.fillRect(lx - 0.5, cy - bldH * 0.35, 1.0, bldH * 0.66);

          const cupR = Math.min(bldW, bldH) * 0.14;
          const coreR = Math.min(bldW, bldH) * 0.06;
          const cupX = cx + bldW * 0.26;
          const cupYs = [cy - bldH * 0.18, cy + bldH * 0.14];
          for (const cY of cupYs) {
            setSub(ctx, 5);
            ctx.fillStyle = "#36383e";
            ctx.beginPath();
            ctx.arc(cupX, cY, cupR, 0, Math.PI * 2);
            ctx.fill();

            setSub(ctx, 6);
            ctx.fillStyle = "#f97316";
            ctx.beginPath();
            ctx.arc(cupX, cY, coreR, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (d.mfgType === "FOOD") {
          setSub(ctx, 4);
          ctx.fillStyle = roofCol;
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.46,
            cy - bldH * 0.42,
            bldW * 0.92,
            bldH * 0.8,
            2,
          );
          ctx.fill();

          ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.44,
            cy - bldH * 0.4,
            bldW * 0.88,
            bldH * 0.76,
            1.5,
          );
          ctx.fill();

          setSub(ctx, 5);
          ctx.fillStyle = "#94a3b8";
          const barW = bldW * 0.38;
          const barH = Math.max(1.4, bldH * 0.08);
          const barX = cx - bldW * 0.24;
          const barYs = [cy - bldH * 0.22, cy, cy + bldH * 0.22];
          for (const by of barYs) {
            ctx.fillRect(barX - barW * 0.5, by - barH * 0.5, barW, barH);
          }

          const vatR = Math.min(bldW, bldH) * 0.13;
          const vatCoords = [
            [cx + bldW * 0.25, cy - bldH * 0.16],
            [cx + bldW * 0.25, cy + bldH * 0.14],
          ];
          for (const [vx, vy] of vatCoords) {
            setSub(ctx, 5);
            ctx.fillStyle = "#e2e8f0";
            ctx.strokeStyle = "#64748b";
            ctx.lineWidth = 1.1;
            ctx.beginPath();
            ctx.arc(vx, vy, vatR, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            setSub(ctx, 6);
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(
              vx - vatR * 0.3,
              vy - vatR * 0.3,
              vatR * 0.3,
              0,
              Math.PI * 2,
            );
            ctx.fill();
          }
        } else if (d.mfgType === "TECH") {
          setSub(ctx, 4);
          ctx.fillStyle = roofCol;
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.46,
            cy - bldH * 0.42,
            bldW * 0.92,
            bldH * 0.8,
            2,
          );
          ctx.fill();

          setSub(ctx, 5);
          const atrW = bldW * 0.52;
          const atrH = bldH * 0.44;
          ctx.fillStyle = "rgba(186, 230, 253, 0.65)";
          ctx.fillRect(cx - atrW * 0.5, cy - atrH * 0.5, atrW, atrH);
          ctx.strokeStyle = "#0284c7";
          ctx.lineWidth = 1.1;
          ctx.strokeRect(cx - atrW * 0.5, cy - atrH * 0.5, atrW, atrH);
          ctx.beginPath();
          ctx.moveTo(cx - atrW * 0.5, cy);
          ctx.lineTo(cx + atrW * 0.5, cy);
          ctx.moveTo(cx, cy - atrH * 0.5);
          ctx.lineTo(cx, cy + atrH * 0.5);
          ctx.stroke();

          setSub(ctx, 6);
          ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
          const podW = Math.max(3.2, bldW * 0.15);
          const podH = Math.max(2.2, bldH * 0.09);
          const podXs = [cx - bldW * 0.34, cx + bldW * 0.34];
          const podYs = [cy - bldH * 0.33, cy + bldH * 0.31];
          for (const px of podXs) {
            for (const py of podYs) {
              ctx.fillRect(px - podW * 0.5, py - podH * 0.5, podW, podH);
            }
          }
        } else {
          setSub(ctx, 4);
          const numBays = hT >= 3 ? 4 : 3;
          const bayH = (bldH * 0.82) / numBays;
          for (let bay = 0; bay < numBays; bay++) {
            const by = cy - bldH * 0.42 + bay * bayH;
            ctx.fillStyle = roofCol;
            ctx.fillRect(cx - bldW * 0.46, by, bldW * 0.92, bayH * 0.72);
            ctx.fillStyle = "rgba(224, 242, 254, 0.52)";
            ctx.fillRect(
              cx - bldW * 0.46,
              by + bayH * 0.72,
              bldW * 0.92,
              bayH * 0.24,
            );
          }

          setSub(ctx, 5);
          ctx.fillStyle = "#36383e";
          ctx.beginPath();
          ctx.arc(cx + bldW * 0.34, cy - bldH * 0.3, ts * 0.24, 0, Math.PI * 2);
          ctx.fill();

          setSub(ctx, 6);
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(cx + bldW * 0.34, cy - bldH * 0.3, ts * 0.1, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (wT === 1 || hT === 1) {
        const maxCrates = Math.min(2, d.pinsCount || 0);
        for (let p = 0; p < maxCrates; p++) {
          let px = cx;
          let py = cy;
          if (maxCrates === 2) {
            if (wT >= hT) {
              px = cx - bldW * 0.22 + p * (bldW * 0.44);
            } else {
              py = cy - bldH * 0.22 + p * (bldH * 0.44);
            }
          }
          setSub(ctx, 7);
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(px - 2.1, py - 2.1, 4.2, 4.2);
          setSub(ctx, 8);
          ctx.strokeStyle = pinCol;
          ctx.lineWidth = 1.25;
          ctx.strokeRect(px - 2.1, py - 2.1, 4.2, 4.2);
        }
      } else {
        const isShiftedLeft =
          d.subType === "MFG" &&
          (d.mfgType === "STEEL" || d.mfgType === "FOOD");
        const maxCrates = Math.min(wT * hT >= 6 ? 5 : 4, d.pinsCount || 0);
        const crateCols = isShiftedLeft ? 2 : wT >= 3 ? 3 : 2;
        const startX = isShiftedLeft ? cx - bldW * 0.34 : cx - bldW * 0.32;
        const stepX = isShiftedLeft ? bldW * 0.18 : bldW * 0.24;
        for (let p = 0; p < maxCrates; p++) {
          const px = startX + (p % crateCols) * stepX;
          const py =
            cy - bldH * 0.18 + Math.floor(p / crateCols) * (bldH * 0.26);
          setSub(ctx, 7);
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(px - 2.1, py - 2.1, 4.2, 4.2);
          setSub(ctx, 8);
          ctx.strokeStyle = pinCol;
          ctx.lineWidth = 1.25;
          ctx.strokeRect(px - 2.1, py - 2.1, 4.2, 4.2);
        }
      }
    }

    if (d.hasUrgentPin) {
      const bx = cx - bldW * 0.38;
      const by = cy - bldH * 0.52;
      setSub(ctx, 9);
      ctx.fillStyle = "#d9383a";
      ctx.beginPath();
      ctx.arc(bx, by, 6.5, 0, Math.PI * 2);
      ctx.fill();
      setSub(ctx, 10);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(bx, by, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * Draws soft ground underlay halos beneath RCI buildings.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 */
export function drawRCIZoneUnderlay(ctx, world, ts) {
  ctx.save();
  ctx.fillStyle = "rgba(34, 197, 94, 0.20)";
  ctx.beginPath();
  for (const h of world.houses || []) {
    ctx.rect((h.x - 0.35) * ts, (h.y - 0.35) * ts, ts * 1.7, ts * 1.7);
  }
  ctx.fill();

  for (const d of world.destinations || []) {
    const wT = d.wTiles || 2;
    const hT = d.hTiles || 2;
    const zw = (wT + 1.2) * ts;
    const zh = (hT + 1.2) * ts;
    ctx.fillStyle =
      d.zoneType === "commercial"
        ? "rgba(59, 130, 246, 0.28)"
        : "rgba(245, 158, 11, 0.28)";
    ctx.beginPath();
    ctx.roundRect(
      (d.x + 0.5) * ts - zw * 0.5,
      (d.y + 0.5) * ts - zh * 0.5,
      zw,
      zh,
      8,
    );
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Draws active supply chain flow vectors and stage badges on destination nodes.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 * @param {any} [selectedEntity=null]
 * @param {number} [zoom=1]
 */
export function drawRCICargoChainOverlay(
  ctx,
  world,
  ts,
  selectedEntity = null,
  zoom = 1,
) {
  ctx.save();
  const ox = ts * 0.5;
  const oy = ts * 0.5;

  // 1. Draw Active Inter-Industrial Supply Chain Flow Corridors
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const link of world.cargoLinks || []) {
    const pts = link.outboundTrack?.pts || link.points;
    if (!pts || pts.length < 2) continue;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.72)";
    ctx.lineWidth = 4.2;
    ctx.setLineDash([]);
    ctx.beginPath();
    traceSmoothPath(ctx, pts, ts);
    ctx.stroke();

    const linkColor = getCargoStageColor(link);
    ctx.strokeStyle = linkColor;
    ctx.lineWidth = 2.4;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    traceSmoothPath(ctx, pts, ts);
    ctx.stroke();
    ctx.setLineDash([]);

    const midIdx = Math.max(
      0,
      Math.min(pts.length - 2, Math.floor(pts.length * 0.5)),
    );
    const p0 = pts[midIdx];
    const p1 = pts[Math.min(pts.length - 1, midIdx + 2)];
    const ax = (p0.x + p1.x) * 0.5 * ts + ox;
    const ay = (p0.y + p1.y) * 0.5 * ts + oy;
    const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(ang);
    ctx.fillStyle = linkColor;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(5.5, 0);
    ctx.lineTo(-4, -4.2);
    ctx.lineTo(-4, 4.2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // 2. Draw Compact Stage Badges on Nodes
  ctx.font = "800 8.5px DM Sans, Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const suppressedBadgeIds = new Set();
  const sel = selectedEntity;
  if (
    sel &&
    "zoneType" in sel &&
    (sel.zoneType === "industrial" || sel.zoneType === "commercial")
  ) {
    suppressedBadgeIds.add(sel.id);
    if (world.cargoLinks) {
      for (const link of world.cargoLinks) {
        if (link.from?.id === sel.id && link.to?.id != null) {
          suppressedBadgeIds.add(link.to.id);
        } else if (link.to?.id === sel.id && link.from?.id != null) {
          suppressedBadgeIds.add(link.from.id);
        }
      }
    }
  }

  const badgeCandidates = [];
  for (const d of world.destinations || []) {
    if (suppressedBadgeIds.has(d.id)) continue;
    if (d.zoneType === "industrial") {
      let tag = "RAW";
      let bg = "#d97706";
      if (d.isGatewayProxy) {
        tag = d.label || "AIR";
        bg = "#0d9488";
      } else if (d.subType === "RAW") {
        if (d.resourceType === "MINE") {
          tag = "MINE";
          bg = "#d97706";
        } else if (d.resourceType === "TIMBER") {
          tag = "WOOD";
          bg = "#d97706";
        } else if (d.resourceType === "FARM") {
          tag = "FARM";
          bg = "#d97706";
        } else if (d.resourceType === "FISHERY") {
          tag = "FISH";
          bg = "#0e7490";
        } else if (d.resourceType === "CHEM") {
          tag = "CHEM";
          bg = "#4d7c0f";
        } else {
          tag = "RAW";
          bg = "#d97706";
        }
      } else if (d.subType === "LOG") {
        tag = "LOG";
        bg = "#7c3aed";
      } else if (d.subType === "MFG") {
        tag = d.mfgType || "MFG";
        bg = "#ea580c";
      } else {
        tag = d.subType || "MFG";
        bg = "#ea580c";
      }
      const prio = d.isRuralNiche
        ? 1
        : tag === "LOG" || tag === "AIR"
          ? 2
          : d.subType === "MFG"
            ? 3
            : 5;
      const bw = tag.length >= 5 ? 34 : tag.length >= 4 ? 30 : 26;
      badgeCandidates.push({
        d,
        tag,
        bg,
        bw,
        prio,
      });
    } else if (d.isCircular) {
      badgeCandidates.push({ d, tag: "CBD", bg: "#1d4ed8", bw: 26, prio: 4 });
    }
  }
  badgeCandidates.sort((a, b) => a.prio - b.prio);

  const placedBadgeRects = [];
  const currentZoom = zoom || 1;
  for (const bc of badgeCandidates) {
    const hT = bc.d.hTiles || 2;
    const cx = bc.d.x * ts + ox;
    const cy = bc.d.y * ts + oy - (hT * 0.5 + 0.38) * ts;
    const sx = cx * currentZoom;
    const sy = cy * currentZoom;
    const halfW = (bc.bw * 0.5 + 2) * currentZoom;
    const halfH = 7.5 * currentZoom;
    const collides = placedBadgeRects.some(
      (r) =>
        Math.abs(sx - r.sx) < halfW + r.halfW &&
        Math.abs(sy - r.sy) < halfH + r.halfH,
    );
    if (collides) continue;
    placedBadgeRects.push({ sx, sy, halfW, halfH });

    ctx.fillStyle = bc.bg;
    ctx.beginPath();
    ctx.roundRect(cx - bc.bw * 0.5, cy - 6.5, bc.bw, 13, 3.5);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(bc.tag, cx, cy + 0.5);
  }
  ctx.restore();
}

/**
 * Draws the high-contrast selection frame, connected freight corridors, and partner pills
 * for a selected commercial or industrial building.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {Destination} entity
 * @param {number} ts
 * @param {Path2D | null} [arableFillPath=null]
 */
export function drawBuildingSelectionHighlight(
  ctx,
  world,
  entity,
  ts,
  arableFillPath = null,
) {
  ctx.save();
  const ox = ts * 0.5;
  const oy = ts * 0.5;
  const wT = entity.wTiles || 2;
  const hT = entity.hTiles || 2;
  const cx = entity.x * ts + ox;
  const cy = entity.y * ts + oy;
  const boxW = (wT + 0.72) * ts;
  const boxH = (hT + 0.72) * ts;

  // 1A. Highlight sprawling farm estate boundary
  if (
    entity.resourceType === "FARM" &&
    entity.bspParcels &&
    entity.bspParcels.length > 0
  ) {
    ctx.save();
    if (arableFillPath) {
      ctx.clip(arableFillPath);
    }
    ctx.strokeStyle = "rgba(217, 119, 6, 0.55)";
    ctx.lineWidth = 2.0;
    ctx.setLineDash([6, 4]);
    if (entity.estateLoops && entity.estateLoops.length > 0) {
      ctx.beginPath();
      for (const loop of entity.estateLoops) {
        if (!loop || loop.length < 3) continue;
        ctx.moveTo(loop[0][0] * ts, loop[0][1] * ts);
        for (let i = 1; i < loop.length; i++) {
          ctx.lineTo(loop[i][0] * ts, loop[i][1] * ts);
        }
        ctx.closePath();
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // 1B. Highlight Connected Inbound and Outbound Cargo Corridors
  const connectedLinks = (world.cargoLinks || []).filter(
    (l) => l.from.id === entity.id || l.to.id === entity.id,
  );

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  /** @type {Map<number, { partner: any, isOutbound: boolean, col: string, comms: string[] }>} */
  const partnerGroups = new Map();
  for (const link of connectedLinks) {
    const pts = link.outboundTrack?.pts || link.points;
    if (!pts || pts.length < 2) continue;
    const isOutbound = link.from.id === entity.id;
    const partner = isOutbound ? link.to : link.from;
    const col = isOutbound ? "#2563eb" : "#d97706";

    ctx.strokeStyle = "rgba(255, 255, 255, 0.88)";
    ctx.lineWidth = 5.4;
    ctx.setLineDash([]);
    ctx.beginPath();
    traceSmoothPath(ctx, pts, ts);
    ctx.stroke();

    ctx.strokeStyle = col;
    ctx.lineWidth = 2.8;
    ctx.setLineDash([7, 4.5]);
    ctx.beginPath();
    traceSmoothPath(ctx, pts, ts);
    ctx.stroke();
    ctx.setLineDash([]);

    const midIdx = Math.max(
      0,
      Math.min(pts.length - 2, Math.floor(pts.length * 0.5)),
    );
    const p0 = pts[midIdx];
    const p1 = pts[Math.min(pts.length - 1, midIdx + 2)];
    const ax = (p0.x + p1.x) * 0.5 * ts + ox;
    const ay = (p0.y + p1.y) * 0.5 * ts + oy;
    const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(ang);
    ctx.fillStyle = col;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(6.2, 0);
    ctx.lineTo(-4.4, -4.6);
    ctx.lineTo(-4.4, 4.6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    const commShort =
      link.commodity === "CONSUMER_GOODS"
        ? "GOODS"
        : link.commodity === "GROCERIES"
          ? "FOOD"
          : link.commodity === "ELECTRONICS"
            ? "TECH"
            : link.commodity === "HARDWARE"
              ? "HDWR"
              : link.commodity === "B2B_PARCELS"
                ? "B2B"
                : link.commodity || "";
    let grp = partnerGroups.get(partner.id);
    if (!grp) {
      grp = { partner, isOutbound, col, comms: [] };
      partnerGroups.set(partner.id, grp);
    }
    if (commShort && !grp.comms.includes(commShort)) {
      grp.comms.push(commShort);
    }
  }

  // Selected building's floating pill
  const selTag = entity.isGatewayProxy
    ? entity.label || "AIR"
    : entity.resourceType
      ? `${entity.resourceType} · RAW`
      : entity.zoneType === "commercial"
        ? (entity.label || entity.subType || "").toUpperCase() ||
          (entity.isCircular ? "CBD HUB" : "COMMERCIAL")
        : entity.mfgType
          ? `${entity.mfgType} · MFG`
          : entity.subType === "RAW"
            ? "RAW"
            : entity.subType || "MFG";
  ctx.font = "800 9px Inter, sans-serif";
  const sw = ctx.measureText(selTag).width + 12;
  const sy = cy - boxH * 0.5 - 11;
  /** @type {Array<{ x: number, y: number, hw: number, hh: number }>} */
  const placedPartnerPills = [{ x: cx, y: sy, hw: sw * 0.5 + 3, hh: 8.5 }];

  ctx.font = "800 8.5px Inter, sans-serif";
  for (const { partner, isOutbound, col, comms } of partnerGroups.values()) {
    const pwT = partner.wTiles || 2;
    const phT = partner.hTiles || 2;
    const pcx = partner.x * ts + ox;
    const pcy = partner.y * ts + oy;
    const pBoxW = (pwT + 0.55) * ts;
    const pBoxH = (phT + 0.55) * ts;

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3.8;
    ctx.beginPath();
    ctx.roundRect(pcx - pBoxW * 0.5, pcy - pBoxH * 0.5, pBoxW, pBoxH, 5.5);
    ctx.stroke();

    ctx.strokeStyle = col;
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.roundRect(pcx - pBoxW * 0.5, pcy - pBoxH * 0.5, pBoxW, pBoxH, 5.5);
    ctx.stroke();

    const rawTag = partner.isGatewayProxy
      ? partner.label || "AIR"
      : partner.resourceType ||
        partner.mfgType ||
        (partner.zoneType === "commercial"
          ? partner.isCircular
            ? "CBD"
            : "COM"
          : partner.subType || "MFG");
    const commLabel = comms[0] || "";
    const pTag =
      commLabel && commLabel === rawTag ? partner.subType || "MFG" : rawTag;
    const arrow = isOutbound ? "→" : "←";
    const fullText = commLabel
      ? `${arrow} ${commLabel} · ${pTag}`
      : `${arrow} ${pTag}`;
    const compactText = `${arrow} ${commLabel || pTag}`;

    const placeBelowFirst =
      pcy > cy &&
      Math.abs(pcx - cx) < (boxW + pBoxW) * 0.65 &&
      pcy - pBoxH * 0.5 - 16 < cy + boxH * 0.5;
    const topY = pcy - pBoxH * 0.5 - 10;
    const botY = pcy + pBoxH * 0.5 + 10;
    const candidateYs = placeBelowFirst
      ? [botY, topY, pcy - pBoxH * 0.22, pcy + pBoxH * 0.22]
      : [topY, botY, pcy - pBoxH * 0.22, pcy + pBoxH * 0.22];

    const hasCloseHorizontalPartner = Array.from(partnerGroups.values()).some(
      (other) =>
        other.partner.id !== partner.id &&
        Math.abs(other.partner.x - partner.x) < 5.2 &&
        Math.abs(other.partner.y - partner.y) < 4.5,
    );
    const textOptions =
      pTag === "COM" && hasCloseHorizontalPartner
        ? [compactText]
        : [fullText, compactText];

    let chosenText = textOptions[0];
    let chosenW = ctx.measureText(chosenText).width + 8;
    let chosenY = candidateYs[0];
    let placed = false;

    for (const textOpt of textOptions) {
      const tw = ctx.measureText(textOpt).width + 8;
      const hw = tw * 0.5 + 1.5;
      const hh = 7.0;
      for (const cyOpt of candidateYs) {
        const overlaps = placedPartnerPills.some(
          (r) =>
            Math.abs(pcx - r.x) < hw + r.hw &&
            Math.abs(cyOpt - r.y) < hh + r.hh,
        );
        if (!overlaps) {
          chosenText = textOpt;
          chosenW = tw;
          chosenY = cyOpt;
          placed = true;
          break;
        }
      }
      if (placed) break;
    }

    if (placed) {
      placedPartnerPills.push({
        x: pcx,
        y: chosenY,
        hw: chosenW * 0.5 + 1.5,
        hh: 7.0,
      });
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.roundRect(pcx - chosenW * 0.5, chosenY - 6.5, chosenW, 13, 3.5);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(chosenText, pcx, chosenY + 0.5);
    }
  }

  // 1C. Precision Double-Cased Selection Frame
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 5.2;
  ctx.beginPath();
  ctx.roundRect(cx - boxW * 0.5, cy - boxH * 0.5, boxW, boxH, 6.5);
  ctx.stroke();

  ctx.strokeStyle = "#36383e";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.roundRect(cx - boxW * 0.5, cy - boxH * 0.5, boxW, boxH, 6.5);
  ctx.stroke();

  // Floating Selected Facility Stage Pill
  ctx.font = "800 9px Inter, sans-serif";
  ctx.fillStyle = "#36383e";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(cx - sw * 0.5, sy - 7, sw, 14, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#f2efe9";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(selTag, cx, sy + 0.5);

  ctx.restore();
}
