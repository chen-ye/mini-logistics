/**
 * Road Vehicle Entity Live Sprite Renderer and Selection Reticles.
 *
 * Renders commuter cars, articulated freight trucks (tractor cabs, loaded cargo trailers,
 * unloaded return flatbeds), and vehicle selection route highlights.
 *
 * Invariants:
 * - 100% Worker-safe: zero window, document, or DOM references.
 * - Supports car.pose ({ x, y, ang, zLayer }) with graceful fallback to track.cumLen interpolation.
 *
 * @import { ProceduralLogisticsWorld } from '../../world-generator.js'
 * @import { CarAgent } from '../../types.js'
 */
import { traceSmoothPath } from "../../render/road-network-layer.js";

/**
 * Draws live surface and motorway road vehicles for a specific vertical Z-pass.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} _world
 * @param {any} sim
 * @param {number} ts
 * @param {"road" | "motorway" | "motorway-lower" | "motorway-upper" | null} [zPass=null]
 */
export function drawCarsZPass(ctx, _world, sim, ts, zPass = null) {
  if (!sim || !sim.cars) return;
  const ox = ts * 0.5;
  const oy = ts * 0.5;

  for (const car of sim.cars) {
    let x, y, ang;

    if (car.pose && typeof car.pose.x === "number") {
      if (car.pose.inTunnel) continue;
      const zL = car.pose.zLayer;
      if (zPass) {
        if (zPass === "road" && zL !== "road") continue;
        if (
          zPass === "motorway" &&
          zL !== "motorway" &&
          zL !== "motorway-lower" &&
          zL !== "motorway-upper"
        )
          continue;
        if (zPass === "motorway-lower" && zL !== "motorway-lower") continue;
        if (zPass === "motorway-upper" && zL !== "motorway-upper") continue;
      }
      x = car.pose.x * ts + ox;
      y = car.pose.y * ts + oy;
      ang = car.pose.ang ?? 0;
    } else {
      const track = car.returning ? car.inboundTrack : car.outboundTrack;
      if (!track || !track.pts || track.pts.length < 2) continue;

      const idx = Math.min(car.segIdx ?? 0, track.pts.length - 2);
      const p0 = track.pts[idx];
      const p1 = track.pts[idx + 1];
      if (!p0 || !p1) continue;
      if (p0.inTunnel && p1.inTunnel) continue;

      const curMode = p0.onMotorway || p1.onMotorway ? "motorway" : "road";
      if (zPass) {
        if (zPass === "road") {
          if (curMode !== "road") continue;
        } else if (zPass === "motorway") {
          if (curMode !== "motorway") continue;
        } else if (zPass === "motorway-lower") {
          if (curMode !== "motorway" || p0.onUpperBridge || p1.onUpperBridge)
            continue;
        } else if (zPass === "motorway-upper") {
          if (
            curMode !== "motorway" ||
            (!p0.onUpperBridge && !p1.onUpperBridge)
          )
            continue;
        }
      }

      const d0 = track.cumLen?.[idx] ?? 0;
      const segLen = Math.max(1e-4, (track.cumLen?.[idx + 1] ?? 1) - d0);
      const frac = Math.max(0, Math.min(1, ((car.dist ?? 0) - d0) / segLen));

      x = (p0.x + (p1.x - p0.x) * frac) * ts + ox;
      y = (p0.y + (p1.y - p0.y) * frac) * ts + oy;
      ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    if (car.isFreightTruck) {
      // Articulated Freight Truck
      ctx.fillStyle = "#36383e";
      ctx.beginPath();
      ctx.roundRect(1.8, -2.8, 4.2, 5.6, 1.5);
      ctx.fill();
      ctx.fillStyle =
        car.isCargoLink && car.returning ? "#94a3b8" : car.color || "#ea580c";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.roundRect(-6.8, -3.0, 8.2, 6.0, 1.5);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillStyle = car.color || "#2563eb";
      ctx.beginPath();
      ctx.roundRect(-4.2, -2.4, 8.4, 4.8, 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/**
 * Draws the high-contrast selection reticle and active route corridor for a selected CarAgent.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} _world
 * @param {CarAgent} car
 * @param {number} ts
 */
export function drawTruckSelectionHighlight(ctx, _world, car, ts) {
  const ox = ts * 0.5;
  const oy = ts * 0.5;

  ctx.save();

  // 1. Draw route corridor
  const track = car.returning ? car.inboundTrack : car.outboundTrack;
  if (track && track.pts && track.pts.length >= 2) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 5.2;
    ctx.setLineDash([]);
    ctx.beginPath();
    traceSmoothPath(ctx, track.pts, ts);
    ctx.stroke();

    ctx.strokeStyle = car.color || "#2563eb";
    ctx.lineWidth = 2.8;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    traceSmoothPath(ctx, track.pts, ts);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 2. Draw selection reticle around current vehicle position
  let cx = 0;
  let cy = 0;
  if (car.pose && typeof car.pose.x === "number") {
    cx = car.pose.x * ts + ox;
    cy = car.pose.y * ts + oy;
  } else if (track && track.pts && track.pts.length >= 2) {
    const idx = Math.min(car.segIdx ?? 0, track.pts.length - 2);
    const p0 = track.pts[idx];
    const p1 = track.pts[idx + 1];
    if (p0 && p1) {
      const d0 = track.cumLen?.[idx] ?? 0;
      const segLen = Math.max(1e-4, (track.cumLen?.[idx + 1] ?? 1) - d0);
      const frac = Math.max(0, Math.min(1, ((car.dist ?? 0) - d0) / segLen));
      cx = (p0.x + (p1.x - p0.x) * frac) * ts + ox;
      cy = (p0.y + (p1.y - p0.y) * frac) * ts + oy;
    }
  }

  if (cx || cy) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4.0;
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = "#36383e";
    ctx.lineWidth = 2.0;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}
