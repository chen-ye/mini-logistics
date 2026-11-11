/**
 * Aircraft Entity Live Sprite Renderer and Selection Reticles.
 *
 * Renders 3-class aircraft fleet silhouettes:
 * 1. Single-engine utility FEEDER_TURBOPROP (Cessna 208 Caravan) with nose propeller & spinner,
 * 2. Twin under-wing high-bypass turbofan WIDEBODY_FREIGHTER (Boeing 767-300F) with winglets,
 * 3. Slender twin-fuselage CF34 PASSENGER_JET (CRJ700) with T-tail,
 * along with ground contact / parallax altitude shadows, hold-bar indicators, and selection reticles.
 *
 * Invariants:
 * - 100% Worker-safe: zero window, document, or DOM references.
 *
 * @import { ProceduralLogisticsWorld } from '../../world-generator.js'
 * @import { PlaneAgent } from '../../types.js'
 */

/**
 * Draws 3-class aircraft silhouettes with landing gear / parallax shadows and livery trim.
 *
 * @param {any} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} ang
 * @param {number} scale
 * @param {string} fill
 * @param {string | null} [stroke=null]
 * @param {string | null} [accentColor=null]
 * @param {boolean} [isCargoFreighter=false]
 * @param {string | null} [aircraftType=null]
 * @param {string} [activeLayer="aesthetic"]
 */
export function drawAirplaneSilhouette(
  ctx,
  x,
  y,
  ang,
  scale,
  fill,
  stroke = null,
  accentColor = null,
  isCargoFreighter = false,
  aircraftType = null,
  activeLayer = "aesthetic",
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.scale(scale, scale);

  const isShadow = fill === "rgba(18, 22, 28, 0.18)";

  ctx.fillStyle = fill;
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.4;
  }

  if (aircraftType === "FEEDER_TURBOPROP") {
    // -------------------------------------------------------------
    // Feeder Turboprop — Cessna 208 Caravan / Super Cargomaster
    // -------------------------------------------------------------
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = isShadow ? fill : "#1f242d";
    ctx.lineWidth = 1.15;
    ctx.beginPath();
    ctx.moveTo(7.55, -2.05);
    ctx.lineTo(7.55, 2.05);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(5.9, -0.9);
    ctx.lineTo(5.9, 0.9);
    ctx.quadraticCurveTo(5.8, 1.35, 4.5, 1.48);
    ctx.lineTo(2.1, 1.52);
    ctx.lineTo(2.1, 7.4);
    ctx.lineTo(-0.05, 7.4);
    ctx.lineTo(-1.05, 3.5);
    ctx.lineTo(-1.05, 1.52);
    ctx.lineTo(-5.1, 1.05);
    ctx.lineTo(-5.7, 3.35);
    ctx.lineTo(-7.3, 3.35);
    ctx.lineTo(-7.7, 0);
    ctx.lineTo(-7.3, -3.35);
    ctx.lineTo(-5.7, -3.35);
    ctx.lineTo(-5.1, -1.05);
    ctx.lineTo(-1.05, -1.52);
    ctx.lineTo(-1.05, -3.5);
    ctx.lineTo(-0.05, -7.4);
    ctx.lineTo(2.1, -7.4);
    ctx.lineTo(2.1, -1.52);
    ctx.lineTo(4.5, -1.48);
    ctx.quadraticCurveTo(5.8, -1.35, 5.9, -0.9);
    ctx.closePath();
    ctx.fill();
    if (stroke) {
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(8.35, 0);
    ctx.quadraticCurveTo(7.7, 0.42, 5.9, 0.42);
    ctx.lineTo(5.9, -0.42);
    ctx.quadraticCurveTo(7.7, -0.42, 8.35, 0);
    ctx.closePath();
    ctx.fillStyle = isShadow ? fill : "#36383e";
    ctx.fill();

    if (!isShadow) {
      const propColor =
        activeLayer === "rci" ? "#0284c7" : accentColor || "#0284c7";

      ctx.fillStyle = propColor;
      ctx.beginPath();
      ctx.moveTo(2.1, 7.4);
      ctx.lineTo(-0.05, 7.4);
      ctx.lineTo(-0.28, 5.9);
      ctx.lineTo(2.1, 5.9);
      ctx.closePath();
      ctx.moveTo(2.1, -7.4);
      ctx.lineTo(-0.05, -7.4);
      ctx.lineTo(-0.28, -5.9);
      ctx.lineTo(2.1, -5.9);
      ctx.closePath();
      ctx.moveTo(-4.7, 0);
      ctx.lineTo(-7.4, 0.82);
      ctx.lineTo(-7.4, -0.82);
      ctx.closePath();
      ctx.fill();
    }
  } else if (isCargoFreighter || aircraftType === "WIDEBODY_FREIGHTER") {
    // -------------------------------------------------------------
    // Wide-Body Air Cargo Freighter — Boeing 767-300F
    // -------------------------------------------------------------
    const nacelles = [-5.5, 5.5];
    for (const ny of nacelles) {
      ctx.beginPath();
      ctx.roundRect(1.4, ny - 1.35, 4.4, 2.7, 0.95);
      ctx.fill();
      if (stroke) {
        ctx.stroke();
      }
    }

    ctx.beginPath();
    ctx.moveTo(14.0, 0);
    ctx.bezierCurveTo(14.0, 1.35, 12.4, 2.45, 9.6, 2.45);
    ctx.lineTo(4.8, 2.45);
    ctx.lineTo(-2.4, 13.8);
    ctx.lineTo(-4.6, 13.8);
    ctx.lineTo(-1.8, 5.8);
    ctx.lineTo(-1.2, 2.45);
    ctx.lineTo(-8.2, 2.3);
    ctx.lineTo(-10.0, 1.65);
    ctx.lineTo(-13.0, 6.6);
    ctx.lineTo(-14.4, 6.6);
    ctx.lineTo(-12.8, 0.85);
    ctx.lineTo(-14.0, 0);
    ctx.lineTo(-12.8, -0.85);
    ctx.lineTo(-14.4, -6.6);
    ctx.lineTo(-13.0, -6.6);
    ctx.lineTo(-10.0, -1.65);
    ctx.lineTo(-8.2, -2.3);
    ctx.lineTo(-1.2, -2.45);
    ctx.lineTo(-1.8, -5.8);
    ctx.lineTo(-4.6, -13.8);
    ctx.lineTo(-2.4, -13.8);
    ctx.lineTo(4.8, -2.45);
    ctx.lineTo(9.6, -2.45);
    ctx.bezierCurveTo(12.4, -2.45, 14.0, -1.35, 14.0, 0);
    ctx.closePath();
    ctx.fill();
    if (stroke) {
      ctx.stroke();
    }

    if (!isShadow) {
      const cargoColor =
        activeLayer === "rci" ? "#8b5cf6" : accentColor || "#d97706";
      ctx.fillStyle = cargoColor;

      ctx.beginPath();
      ctx.moveTo(-2.4, 13.8);
      ctx.lineTo(-4.6, 13.8);
      ctx.lineTo(-4.0, 11.6);
      ctx.lineTo(-1.9, 11.6);
      ctx.closePath();
      ctx.moveTo(-2.4, -13.8);
      ctx.lineTo(-4.6, -13.8);
      ctx.lineTo(-4.0, -11.6);
      ctx.lineTo(-1.9, -11.6);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(-8.4, 0);
      ctx.lineTo(-13.6, 1.75);
      ctx.lineTo(-13.6, -1.75);
      ctx.closePath();
      ctx.moveTo(-13.0, 6.6);
      ctx.lineTo(-14.4, 6.6);
      ctx.lineTo(-13.8, 5.0);
      ctx.lineTo(-12.4, 5.0);
      ctx.closePath();
      ctx.moveTo(-13.0, -6.6);
      ctx.lineTo(-14.4, -6.6);
      ctx.lineTo(-13.8, -5.0);
      ctx.lineTo(-12.4, -5.0);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    // -------------------------------------------------------------
    // Passenger Jet — Bombardier CRJ700 Regional Jet
    // -------------------------------------------------------------
    const rearPods = [-2.85, 2.85];
    for (const py of rearPods) {
      ctx.beginPath();
      ctx.roundRect(-6.7, py - 1.05, 3.5, 2.1, 0.85);
      ctx.fill();
      if (stroke) {
        ctx.stroke();
      }
    }

    ctx.beginPath();
    ctx.moveTo(11.6, 0);
    ctx.quadraticCurveTo(10.5, 1.25, 7.8, 1.52);
    ctx.lineTo(2.2, 1.52);
    ctx.lineTo(-2.4, 9.6);
    ctx.lineTo(-4.4, 9.6);
    ctx.lineTo(-1.9, 1.52);
    ctx.lineTo(-8.8, 1.28);
    ctx.lineTo(-11.4, 4.8);
    ctx.lineTo(-12.8, 4.8);
    ctx.lineTo(-11.8, 0);
    ctx.lineTo(-12.8, -4.8);
    ctx.lineTo(-11.4, -4.8);
    ctx.lineTo(-8.8, -1.28);
    ctx.lineTo(-1.9, -1.52);
    ctx.lineTo(-4.4, -9.6);
    ctx.lineTo(-2.4, -9.6);
    ctx.lineTo(2.2, -1.52);
    ctx.lineTo(7.8, -1.52);
    ctx.quadraticCurveTo(10.5, -1.25, 11.6, 0);
    ctx.closePath();
    ctx.fill();
    if (stroke) ctx.stroke();

    if (!isShadow && accentColor) {
      ctx.fillStyle = accentColor;

      ctx.beginPath();
      ctx.moveTo(-2.4, 9.6);
      ctx.lineTo(-4.4, 9.6);
      ctx.lineTo(-3.9, 8.0);
      ctx.lineTo(-2.1, 8.0);
      ctx.closePath();
      ctx.moveTo(-2.4, -9.6);
      ctx.lineTo(-4.4, -9.6);
      ctx.lineTo(-3.9, -8.0);
      ctx.lineTo(-2.1, -8.0);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(-8.6, 0);
      ctx.lineTo(-12.6, 1.55);
      ctx.lineTo(-12.6, -1.55);
      ctx.closePath();
      ctx.moveTo(-11.4, 4.8);
      ctx.lineTo(-12.8, 4.8);
      ctx.lineTo(-12.3, 3.5);
      ctx.lineTo(-11.1, 3.5);
      ctx.closePath();
      ctx.moveTo(-11.4, -4.8);
      ctx.lineTo(-12.8, -4.8);
      ctx.lineTo(-12.3, -3.5);
      ctx.lineTo(-11.1, -3.5);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.restore();
}

/**
 * Draws live aircraft in either ground taxi/gate phase or airborne cruise/takeoff/landing phase.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} _world
 * @param {any} sim
 * @param {number} ts
 * @param {"ground" | "air" | null} [layerMode=null]
 * @param {string} [activeLayer="aesthetic"]
 */
export function drawPlanesZPass(
  ctx,
  _world,
  sim,
  ts,
  layerMode = null,
  activeLayer = "aesthetic",
) {
  if (!sim || !sim.planes) return;

  for (const p of sim.planes) {
    const alt = p.altitude ?? 0;
    const isGround = alt <= 0.001;

    if (layerMode === "ground" && !isGround) continue;
    if (layerMode === "air" && isGround) continue;

    const px = p.x * ts + ts * 0.5;
    const py = p.y * ts + ts * 0.5;
    const ang = p.ang ?? 0;
    const isCargo = Boolean(
      p.isCargoFreighter || p.aircraftType === "WIDEBODY_FREIGHTER",
    );
    const accent = p.color || null;

    const shadowOff = isGround ? 1.2 : 1.5 + alt * 22;
    const bodyScale = isGround ? 0.85 : 0.85 + alt * 0.35;
    const shadowScale = isGround ? 0.85 : 0.75 + alt * 0.2;

    drawAirplaneSilhouette(
      ctx,
      px + shadowOff,
      py + shadowOff,
      ang,
      shadowScale,
      "rgba(18, 22, 28, 0.18)",
      null,
      null,
      isCargo,
      p.aircraftType || null,
      activeLayer,
    );

    drawAirplaneSilhouette(
      ctx,
      px,
      py,
      ang,
      bodyScale,
      "#ffffff",
      "#36383e",
      accent,
      isCargo,
      p.aircraftType || null,
      activeLayer,
    );

    const planeState = p.state;
    const isHolding =
      isGround &&
      Boolean(
        p.holdingShort ||
        planeState === "HOLD_SHORT_QUEUE" ||
        planeState === "HOLD_CROSSING_RUNWAY" ||
        planeState === "PUSHBACK_HOLD",
      );

    if (isHolding) {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang);
      const noseX =
        (p.aircraftType === "FEEDER_TURBOPROP" ? 8.0 : isCargo ? 14.0 : 11.0) *
          bodyScale +
        2.6;

      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1.6;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(noseX, -3.2);
      ctx.lineTo(noseX, 3.2);
      ctx.stroke();

      ctx.fillStyle = "#f59e0b";
      ctx.beginPath();
      ctx.arc(noseX - 1.0, 0, 1.3, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }
}

/**
 * Draws the high-contrast selection reticle and active flight corridor for a selected PlaneAgent.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} _world
 * @param {PlaneAgent} plane
 * @param {number} ts
 */
export function drawPlaneSelectionHighlight(ctx, _world, plane, ts) {
  const ox = ts * 0.5;
  const oy = ts * 0.5;
  const px = plane.x * ts + ox;
  const py = plane.y * ts + oy;

  ctx.save();

  // 1. Draw active flight track corridor if present
  if (plane.track && plane.track.pts && plane.track.pts.length >= 2) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 4.2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(plane.track.pts[0].x * ts + ox, plane.track.pts[0].y * ts + oy);
    for (let i = 1; i < plane.track.pts.length; i++) {
      ctx.lineTo(
        plane.track.pts[i].x * ts + ox,
        plane.track.pts[i].y * ts + oy,
      );
    }
    ctx.stroke();

    ctx.strokeStyle = plane.color || "#0284c7";
    ctx.lineWidth = 2.2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(plane.track.pts[0].x * ts + ox, plane.track.pts[0].y * ts + oy);
    for (let i = 1; i < plane.track.pts.length; i++) {
      ctx.lineTo(
        plane.track.pts[i].x * ts + ox,
        plane.track.pts[i].y * ts + oy,
      );
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 2. Selection reticle around plane
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 4.2;
  ctx.beginPath();
  ctx.arc(px, py, 14, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "#36383e";
  ctx.lineWidth = 2.0;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.arc(px, py, 14, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}
