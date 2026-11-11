/**
 * Town Entity Vector Layer Recorder and Overlays.
 *
 * Renders suburban density blush, central place hierarchy circles and cards,
 * and town selection reticles.
 *
 * Invariants:
 * - 100% Worker-safe: zero window, document, or DOM references.
 *
 * @import { ProceduralLogisticsWorld } from '../../world-generator.js'
 * @import { Town } from '../../types.js'
 */
import { drawUrbanBlushAndTrees } from "../../canvas-layer-cache.js";

/**
 * Records urban density blush into a display list or context.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 */
export function recordUrbanBlush(ctx, world, ts) {
  drawUrbanBlushAndTrees(ctx, world.W, world.H, ts, world.zoneColorIdx, null);
}

/**
 * Draws Central Place Theory hierarchical town influence circles and labels.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 */
export function drawHierarchyOverlay(ctx, world, ts) {
  ctx.save();
  for (const t of world.towns || []) {
    const cx = t.x * ts + ts * 0.5;
    const cy = t.y * ts + ts * 0.5;

    ctx.strokeStyle = t.palette?.base || "#36383e";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(cx, cy, (t.urbanRadius || 12) * ts, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = "800 11px DM Sans, Inter, sans-serif";
    const label = `${t.name} (T${t.tier})`;
    const w = ctx.measureText(label).width + 14;
    ctx.fillStyle = "#36383e";
    ctx.beginPath();
    ctx.roundRect(cx - w * 0.5, cy - 26, w, 20, 6);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, cx, cy - 16);
  }
  ctx.restore();
}

/**
 * Draws the high-contrast selection frame for an active town.
 *
 * @param {any} ctx
 * @param {any} _world
 * @param {Town} town
 * @param {number} ts
 */
export function drawTownSelectionHighlight(ctx, _world, town, ts) {
  const ox = ts * 0.5;
  const oy = ts * 0.5;
  const cx = town.x * ts + ox;
  const cy = town.y * ts + oy;
  const rad = (town.urbanRadius || 12) * 0.85 * ts;
  ctx.save();
  ctx.strokeStyle = "#36383e";
  ctx.lineWidth = 2.8;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
