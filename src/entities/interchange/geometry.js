/** @import { DiamondSlipRamp, Motorway, Point2D, TrumpetInterchange } from '../../types.js' */

/**
 * Geometric parameters for tangent-aligned Cloverleaf interchanges.
 */
export const CLOVERLEAF_GEOMETRY = Object.freeze({
  outerDist: 3.65,
  outerCtrl: 1.75,
  leafSpan: 4.85,
  innerLoopCtrl: 4.85,
  outerCheckDist: 3.3,
  outerCheckCtrl: 2.05,
  minWaterDist: 2.6,
  rampWaterDist: 1.5,
});

/**
 * Geometric parameters for Diamond interchange slip-ramps and footprint clearance.
 */
export const DIAMOND_GEOMETRY = Object.freeze({
  walked: 2.35,
  stepReach: 2.15,
  maxTermDist: 3.6,
  clearanceRadius: 1.55,
});

/**
 * Geometric parameters for 3-way Trumpet interchanges.
 */
export const TRUMPET_GEOMETRY = Object.freeze({
  uC: -1.42,
  vC: -1.38,
  rIn: 1.25,
  rOut: 1.72,
  mainArcYellow: 3.85,
  mainArcPurple: 3.85,
  mainArcBlue: 5.65,
  spurArcPos: 3.85,
});

/**
 * Samples cubic Bezier slip-ramp curves (t = 0, 0.1, ..., 1.0) into discrete line segments.
 *
 * @param {DiamondSlipRamp[]} ramps - List of diamond slip ramp objects.
 * @returns {Array<[Point2D, Point2D]>} Array of line segments connecting consecutive sample points.
 */
export function extractDiamondRampSegments(ramps) {
  /** @type {Array<[Point2D, Point2D]>} */
  const segs = [];
  for (const ramp of ramps) {
    const { p0, p1, p2, p3 } = ramp;
    let prev = p0;
    for (let step = 1; step <= 10; step++) {
      const t = step * 0.1;
      const mt = 1 - t;
      const c0 = mt * mt * mt;
      const c1 = 3 * mt * mt * t;
      const c2 = 3 * mt * t * t;
      const c3 = t * t * t;
      const curr = {
        x: c0 * p0.x + c1 * p1.x + c2 * p2.x + c3 * p3.x,
        y: c0 * p0.y + c1 * p1.y + c2 * p2.y + c3 * p3.y,
      };
      segs.push([prev, curr]);
      prev = curr;
    }
  }
  return segs;
}

/**
 * Computes minimum squared distance from point (px, py) to a list of line segments.
 *
 * @param {Array<[Point2D, Point2D]>} segs - List of line segments.
 * @param {number} px - Point X coordinate.
 * @param {number} py - Point Y coordinate.
 * @returns {number} Minimum squared Euclidean distance.
 */
export function distSqToSegments(segs, px, py) {
  let minD2 = Infinity;
  for (let i = 0; i < segs.length; i++) {
    const [a, b] = segs[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t =
      lenSq > 1e-6
        ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq))
        : 0;
    const qx = a.x + t * dx;
    const qy = a.y + t * dy;
    const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
    if (d2 < minD2) minD2 = d2;
  }
  return minD2;
}

/**
 * @typedef {Object} CubicBezierCurve
 * @property {Point2D} p0
 * @property {Point2D} p1
 * @property {Point2D} p2
 * @property {Point2D} p3
 */

/**
 * @typedef {Object} TrumpetRampCurves
 * @property {CubicBezierCurve} yellow - C1 cubic from Mainline (-u side, +u travel) to Spur (+v side, +v travel).
 * @property {CubicBezierCurve} purple - C1 cubic from Spur (+v side, -v travel) to Mainline (+u side, +u travel).
 * @property {CubicBezierCurve[]} brown - Concentric 4-segment inner 270° loop ramp.
 * @property {CubicBezierCurve[]} blue - Concentric 4-segment outer trumpet bell ramp.
 */

/**
 * Evaluates exact cubic Bezier curves for all 4 directional ramps of an authentic 3-way Trumpet interchange.
 *
 * @param {TrumpetInterchange | { x: number, y: number, angleMain?: number, sideSign?: number, mwayMain?: number, mwaySpur?: number }} ic - Trumpet interchange configuration.
 * @param {Motorway[]} [motorways] - World motorways array to anchor ramps directly to surveyed highway samples.
 * @returns {TrumpetRampCurves} The 4 ramp cubic Bezier definitions.
 */
export function computeTrumpetRampBeziers(ic, motorways = []) {
  const sy = ic.sideSign || 1;
  const cosM = Math.cos(ic.angleMain || 0);
  const sinM = Math.sin(ic.angleMain || 0);
  const ux = sy * cosM;
  const uy = sy * sinM;
  const vx = -sy * sinM;
  const vy = sy * cosM;

  const toWorldUV = (u, v) => ({
    x: ic.x + ux * u + vx * v,
    y: ic.y + uy * u + vy * v,
  });

  const mainMw = motorways?.find((m) => m.number === ic.mwayMain) || null;
  const spurMw = motorways?.find((m) => m.number === ic.mwaySpur) || null;

  const sampleMotorwayAtArc = (mw, targetArc, dirX, dirY) => {
    const samples = mw?.samples;
    if (!samples || samples.length < 2) {
      return {
        x: ic.x + dirX * targetArc,
        y: ic.y + dirY * targetArc,
        tx: dirX,
        ty: dirY,
      };
    }
    let k0 = 0;
    let bestD = Infinity;
    for (let k = 0; k < samples.length; k++) {
      const d = Math.hypot(samples[k].x - ic.x, samples[k].y - ic.y);
      if (d < bestD) {
        bestD = d;
        k0 = k;
      }
    }
    const kNext = Math.min(samples.length - 1, k0 + 1);
    const kPrev = Math.max(0, k0 - 1);
    const fdx = samples[kNext].x - samples[kPrev].x;
    const fdy = samples[kNext].y - samples[kPrev].y;
    const stepSign = fdx * dirX + fdy * dirY >= 0 ? 1 : -1;

    let walked = 0;
    let curK = k0;
    let ptX = samples[k0].x;
    let ptY = samples[k0].y;
    while (curK + stepSign >= 0 && curK + stepSign < samples.length) {
      const nk = curK + stepSign;
      const segDx = samples[nk].x - samples[curK].x;
      const segDy = samples[nk].y - samples[curK].y;
      const segLen = Math.hypot(segDx, segDy);
      if (walked + segLen >= targetArc && segLen > 1e-4) {
        const frac = (targetArc - walked) / segLen;
        ptX = samples[curK].x + segDx * frac;
        ptY = samples[curK].y + segDy * frac;
        return {
          x: ptX,
          y: ptY,
          tx: segDx / segLen,
          ty: segDy / segLen,
        };
      }
      walked += segLen;
      curK = nk;
      ptX = samples[curK].x;
      ptY = samples[curK].y;
    }
    const prevK = Math.max(0, Math.min(samples.length - 1, curK - stepSign));
    const tdx = samples[curK].x - samples[prevK].x || dirX;
    const tdy = samples[curK].y - samples[prevK].y || dirY;
    const tLen = Math.hypot(tdx, tdy) || 1;
    return {
      x: ptX,
      y: ptY,
      tx: tdx / tLen,
      ty: tdy / tLen,
    };
  };

  const mNegYellow = sampleMotorwayAtArc(
    mainMw,
    TRUMPET_GEOMETRY.mainArcYellow,
    -ux,
    -uy,
  );
  const mPosPurple = sampleMotorwayAtArc(
    mainMw,
    TRUMPET_GEOMETRY.mainArcPurple,
    ux,
    uy,
  );
  const mNegBlue = sampleMotorwayAtArc(
    mainMw,
    TRUMPET_GEOMETRY.mainArcBlue,
    -ux,
    -uy,
  );
  const sPos = sampleMotorwayAtArc(spurMw, TRUMPET_GEOMETRY.spurArcPos, vx, vy);

  // 1. Yellow Ramp: C1 cubic from Mainline (-u side, +u travel) to Spur (+v side, +v travel)
  const yP0 = {
    x: mNegYellow.x + vx * 0.24,
    y: mNegYellow.y + vy * 0.24,
  };
  const yP1 = {
    x: mNegYellow.x + vx * 0.3 - mNegYellow.tx * 1.95,
    y: mNegYellow.y + vy * 0.3 - mNegYellow.ty * 1.95,
  };
  const yP3 = {
    x: sPos.x - ux * 0.24,
    y: sPos.y - uy * 0.24,
  };
  const yP2 = {
    x: sPos.x - ux * 0.3 - sPos.tx * 1.95,
    y: sPos.y - uy * 0.3 - sPos.ty * 1.95,
  };
  const yellow = { p0: yP0, p1: yP1, p2: yP2, p3: yP3 };

  // 2. Purple Ramp: C1 cubic from Spur (+v side, -v travel) to Mainline (+u side, +u travel)
  const pP0 = {
    x: sPos.x + ux * 0.24,
    y: sPos.y + uy * 0.24,
  };
  const pP1 = {
    x: sPos.x + ux * 0.3 - sPos.tx * 1.95,
    y: sPos.y + uy * 0.3 - sPos.ty * 1.95,
  };
  const pP3 = {
    x: mPosPurple.x + vx * 0.24,
    y: mPosPurple.y + vy * 0.24,
  };
  const pP2 = {
    x: mPosPurple.x + vx * 0.3 - mPosPurple.tx * 1.95,
    y: mPosPurple.y + vy * 0.3 - mPosPurple.ty * 1.95,
  };
  const purple = { p0: pP0, p1: pP1, p2: pP2, p3: pP3 };

  // 3. Brown Inner 270° Loop (Cloverleaf-equivalent R_inner = 1.25 loop radius, reaching 2.67x2.63 tiles)
  //    Center of concentric top arch is at (u = -1.42, v = -1.38) with R_inner = 1.25, R_outer = 1.72.
  const k90 = 0.55228475;
  const uC = TRUMPET_GEOMETRY.uC;
  const vC = TRUMPET_GEOMETRY.vC;
  const rIn = TRUMPET_GEOMETRY.rIn;
  const rOut = TRUMPET_GEOMETRY.rOut;

  // Seg 1: Mainline (-u) at (-0.20, -0.24) -> 9 o'clock (-2.67, -1.38) heading up (-v)
  const brownSeg1 = {
    p0: toWorldUV(-0.2, -0.24),
    p1: toWorldUV(-1.6, -0.28),
    p2: toWorldUV(uC - rIn, -0.52),
    p3: toWorldUV(uC - rIn, vC),
  };
  // Seg 2: 9 o'clock (-2.67, -1.38) -> 12 o'clock (-1.42, -2.63)
  const brownSeg2 = {
    p0: toWorldUV(uC - rIn, vC),
    p1: toWorldUV(uC - rIn, vC - k90 * rIn),
    p2: toWorldUV(uC - k90 * rIn, vC - rIn),
    p3: toWorldUV(uC, vC - rIn),
  };
  // Seg 3: 12 o'clock (-1.42, -2.63) -> 3 o'clock (-0.17, -1.38)
  const brownSeg3 = {
    p0: toWorldUV(uC, vC - rIn),
    p1: toWorldUV(uC + k90 * rIn, vC - rIn),
    p2: toWorldUV(uC + rIn, vC - k90 * rIn),
    p3: toWorldUV(uC + rIn, vC),
  };
  // Seg 4: 3 o'clock (-0.17, -1.38) straight down to Bridge left lane (-0.17, -0.15)
  const brownSeg4 = {
    p0: toWorldUV(uC + rIn, vC),
    p1: toWorldUV(uC + rIn, -0.95),
    p2: toWorldUV(-0.17, -0.52),
    p3: toWorldUV(-0.17, -0.15),
  };

  // 4. Blue Outer Trumpet Bell:
  //    Runs parallel/concentric (R_outer = 1.72, Δr = 0.47 tiles) with Brown from Bridge through
  //    3 o'clock (0°), 12 o'clock (90°), to 10:30 o'clock (135°), then sweeps in a broad R ≈ 4.2-tile
  //    curve into the Westbound Mainline at d = 5.65 tiles!
  // Seg 1: Bridge right lane (+0.23, -0.15) -> 3 o'clock (+0.30, -1.38)
  const blueSeg1 = {
    p0: toWorldUV(0.23, -0.15),
    p1: toWorldUV(0.25, -0.52),
    p2: toWorldUV(uC + rOut, -0.95),
    p3: toWorldUV(uC + rOut, vC),
  };
  // Seg 2: 3 o'clock (+0.30, -1.38) -> 12 o'clock (-1.42, -3.10)
  const blueSeg2 = {
    p0: toWorldUV(uC + rOut, vC),
    p1: toWorldUV(uC + rOut, vC - k90 * rOut),
    p2: toWorldUV(uC + k90 * rOut, vC - rOut),
    p3: toWorldUV(uC, vC - rOut),
  };
  // Seg 3: 12 o'clock (90°) -> 10:30 o'clock (135° diverge point on concentric circle R_outer = 1.72)
  const sweepRad = (45 * Math.PI) / 180;
  const k45 = (4 / 3) * Math.tan(sweepRad * 0.25);
  const sin45 = Math.sin(sweepRad);
  const cos45 = Math.cos(sweepRad);
  const uDiv = uC - rOut * sin45;
  const vDiv = vC - rOut * cos45;
  const tDivU = -cos45;
  const tDivV = sin45;
  const blueSeg3 = {
    p0: toWorldUV(uC, vC - rOut),
    p1: toWorldUV(uC - k45 * rOut, vC - rOut),
    p2: toWorldUV(uDiv - tDivU * k45 * rOut, vDiv - tDivV * k45 * rOut),
    p3: toWorldUV(uDiv, vDiv),
  };
  // Seg 4: Broad R ≈ 4.2-tile C1 sweep from (uDiv, vDiv) along (tDivU, tDivV) into mNegBlue (d = 5.65)
  const blP3 = {
    x: mNegBlue.x - vx * 0.24,
    y: mNegBlue.y - vy * 0.24,
  };
  const blP2 = {
    x: mNegBlue.x - vx * 0.3 - mNegBlue.tx * 1.85,
    y: mNegBlue.y - vy * 0.3 - mNegBlue.ty * 1.85,
  };
  const blueSeg4 = {
    p0: toWorldUV(uDiv, vDiv),
    p1: toWorldUV(uDiv + tDivU * 1.55, vDiv + tDivV * 1.55),
    p2: blP2,
    p3: blP3,
  };

  return {
    yellow,
    purple,
    brown: [brownSeg1, brownSeg2, brownSeg3, brownSeg4],
    blue: [blueSeg1, blueSeg2, blueSeg3, blueSeg4],
  };
}
