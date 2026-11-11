/** @import { Airport, AirportATC, PlaneEndpoint } from '../../types.js' */

/**
 * Normalizes an angle in radians to [-PI, PI].
 *
 * @param {number} a - Angle in radians.
 * @returns {number} Normalized angle in radians.
 */
export function normalizeAngle(a) {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r - Math.PI;
}

/**
 * Computes into-the-wind active runway direction sign (1 or -1) from runway angle and wind vector.
 *
 * @param {number} apAngle - Runway angle in radians.
 * @param {{ x: number, y: number } | null} [windVector] - Optional environmental wind vector.
 * @returns {1 | -1} Active runway direction sign (1: forward along angleRad, -1: reverse).
 */
export function computeActiveRunwaySign(apAngle, windVector = null) {
  if (
    windVector &&
    typeof windVector.x === "number" &&
    typeof windVector.y === "number"
  ) {
    const ang = apAngle || 0;
    const rwyCos = Math.cos(ang);
    const rwySin = Math.sin(ang);
    const headwindDot = -windVector.x * rwyCos + -windVector.y * rwySin;
    return headwindDot >= 0 ? 1 : -1;
  }
  return 1;
}

/**
 * Transforms airfield local runway-aligned coordinates (lx, ly) in tiles to world coordinates.
 *
 * @param {Airport | PlaneEndpoint | { x: number, y: number, angleRad?: number, angle?: number }} ap - Airfield origin and orientation.
 * @param {number} lx - Local offset along runway heading in tiles.
 * @param {number} ly - Local offset perpendicular to runway heading in tiles.
 * @returns {{ x: number, y: number }} World coordinates in tiles.
 */
export function localToWorldAirfield(ap, lx, ly) {
  const ang = ap.angleRad ?? ap.angle ?? 0;
  const cosA = Math.cos(ang);
  const sinA = Math.sin(ang);
  return {
    x: ap.x + lx * cosA - ly * sinA,
    y: ap.y + lx * sinA + ly * cosA,
  };
}

/**
 * Transforms world coordinates (wx, wy) in tiles to airfield local runway-aligned coordinates (lx, ly).
 *
 * @param {Airport | PlaneEndpoint | { x: number, y: number, angleRad?: number, angle?: number }} ap - Airfield origin and orientation.
 * @param {number} wx - World X coordinate in tiles.
 * @param {number} wy - World Y coordinate in tiles.
 * @returns {{ lx: number, ly: number }} Local runway-aligned coordinates in tiles.
 */
export function worldToLocalAirfield(ap, wx, wy) {
  const ang = ap.angleRad ?? ap.angle ?? 0;
  const cosA = Math.cos(ang);
  const sinA = Math.sin(ang);
  const dx = wx - ap.x;
  const dy = wy - ap.y;
  return {
    lx: dx * cosA + dy * sinA,
    ly: -dx * sinA + dy * cosA,
  };
}

/**
 * @typedef {Object} GateStandSlot
 * @property {number} id - Gate identifier (0-indexed).
 * @property {number} lx - Local X coordinate along runway axis.
 * @property {number} ly - Local Y coordinate (terminal concourse frontage).
 * @property {number} gateY - Local Y coordinate of gate stand stop position.
 * @property {number} taxiY - Local Y coordinate of connecting parallel taxiway.
 * @property {number} taxiS - 1D taxiway spine distance where pushback/taxi enters the taxiway spine.
 * @property {[number, number, number, number]} slot - Coordinate tuple [lx, ly, gateY, taxiS].
 */

/**
 * @typedef {Object} AirfieldPixelLayout
 * @property {number} rwyLen
 * @property {number} rwyWid
 * @property {number} padLen
 * @property {number} padWid
 * @property {number} termW
 * @property {number} termH
 * @property {number} termY
 * @property {number} renderTermY
 * @property {number} renderStandY
 * @property {number} taxiY
 * @property {number} holdShortY
 * @property {number} mainRwyY
 * @property {number} depRwyY
 * @property {number} outerRwyY
 * @property {number} arrRwyY
 * @property {number} exitCrossX
 * @property {number} depCrossX
 */

/**
 * @typedef {Object} AirfieldLayout
 * @property {boolean} isDual - True if dual-runway hub airfield.
 * @property {1 | -1} activeSign - Active into-the-wind departure/arrival direction sign.
 * @property {number} side - Apron side (-1 or 1).
 * @property {number} halfLen - Half runway length in tiles.
 * @property {number} halfWid - Half airfield width in tiles.
 * @property {number} rwyLen - Total primary runway length in tiles.
 * @property {number} rwyWid - Runway strip pavement width in tiles.
 * @property {number} padLen - Concrete airfield apron boundary length in tiles.
 * @property {number} padWid - Concrete airfield apron boundary width in tiles.
 * @property {number} termW - Concourse building width in tiles.
 * @property {number} termH - Concourse building depth in tiles.
 * @property {number} termY - Simulation gate parking local Y coordinate in tiles.
 * @property {number} renderTermY - Rendered concourse center local Y coordinate in tiles.
 * @property {number} renderStandY - Rendered lead-in T-bar stop line local Y coordinate in tiles.
 * @property {number} taxiY - Parallel taxiway centerline local Y coordinate in tiles.
 * @property {number} holdShortY - Departure hold-short local Y coordinate in tiles.
 * @property {number} mainRwyY - Primary runway centerline local Y coordinate in tiles.
 * @property {number} depRwyY - Departure runway centerline local Y coordinate in tiles.
 * @property {number} outerRwyY - Secondary arrival runway centerline local Y coordinate in tiles.
 * @property {number} arrRwyY - Active arrival runway centerline local Y coordinate in tiles.
 * @property {number} exitCrossX - Rapid-exit cross taxiway local X coordinate in tiles.
 * @property {number} depCrossX - Departure cross taxiway local X coordinate in tiles.
 * @property {number} crossFromY - Runway cross taxiway origin local Y coordinate in tiles.
 * @property {number} crossSpan - Span between runway crossing origin and parallel taxiway in tiles.
 * @property {number} spineLen - Length of 1D parallel taxiway spine in tiles.
 * @property {number} holdShortS - 1D distance from arrival exit to departure hold-short line in tiles.
 * @property {number} preGateHoldS - 1D distance for pre-gate holding position in tiles.
 * @property {GateStandSlot[]} gates - Gate stand slots sorted by taxiway spine distance.
 * @property {(ts: number) => AirfieldPixelLayout} toPixels - Converts tile coordinates to pixels for a given tile size.
 */

/**
 * Computes self-consistent geometric layout and operational dimensions for an airfield.
 *
 * @param {Airport | PlaneEndpoint | { tier?: string, isHub?: boolean, airportClass?: string, dualRunway?: boolean, angleRad?: number, angle?: number, halfLen?: number, halfWid?: number, apronSide?: number, activeSign?: 1 | -1, atc?: AirportATC }} ap - Airfield configuration.
 * @param {{ x: number, y: number } | null} [windVector] - Optional environmental wind vector.
 * @returns {AirfieldLayout} Complete airfield layout object.
 */
export function computeAirfieldLayout(ap, windVector = null) {
  const isDual = Boolean(
    ap.tier === "HUB" || ap.isHub || ap.airportClass === "HUB" || ap.dualRunway,
  );
  const ang = ap.angleRad ?? ap.angle ?? 0;
  const activeSign =
    ap.atc?.activeSign ??
    ap.activeSign ??
    computeActiveRunwaySign(ang, windVector);
  const side = ap.apronSide || 1;

  const halfLen =
    ap.halfLen || (isDual ? 7.4 : ap.airportClass === "CRG" ? 5.6 : 5.2);
  const halfWid =
    ap.halfWid || (isDual ? 3.8 : ap.airportClass === "CRG" ? 2.5 : 2.6);

  const rwyLen = halfLen * 2;
  const rwyWid = isDual ? 1.26 : 1.1;
  const padLen = rwyLen + 1.8;
  const padWid = halfWid * 2 + (isDual ? 2.1 : 1.9);

  const termW = rwyLen * (isDual ? 0.46 : 0.4);
  const termH = isDual ? 0.76 : 0.7;
  const termY = side * (isDual ? 0.86 : 0.8);
  const renderTermY = side * (isDual ? 1.66 : 1.54);
  const renderStandY = side * (isDual ? 1.2 : 1.12);

  const taxiY = -side * (isDual ? 0.6 : 0.62);
  const holdShortY = -side * (isDual ? 0.94 : 0.96);
  const mainRwyY = -side * (isDual ? 1.72 : 1.68);
  const depRwyY = -side * (isDual ? 1.72 : 1.68);
  const outerRwyY = -side * 3.35;
  const arrRwyY = isDual ? -side * 3.35 : -side * 1.68;

  const exitCrossX = activeSign * (isDual ? 0.41 : 0.38) * rwyLen;
  const depCrossX = -activeSign * (isDual ? 0.41 : 0.38) * rwyLen;

  const crossFromY = -side * (isDual ? 3.35 : 1.68);
  const crossSpan = Math.abs(taxiY - crossFromY);
  const spineLen = Math.abs(depCrossX - exitCrossX);
  const holdShortS = spineLen + Math.abs(taxiY - holdShortY);

  const gateConfigs = isDual
    ? [-3, -2, -1, 0, 1, 2, 3].map((g) => g * 0.12 * termW)
    : ap.airportClass === "CRG"
      ? [-0.42, -0.22, 0.22, 0.42].map((frac) => frac * termW)
      : [-0.36, -0.12, 0.12, 0.36].map((frac) => frac * termW);

  /** @type {GateStandSlot[]} */
  const gates = gateConfigs.map((lx, i) => {
    const taxiS = (exitCrossX - lx) * activeSign;
    return {
      id: i,
      lx,
      ly: termY,
      gateY: termY,
      taxiY,
      taxiS,
      slot: [lx, termY, termY, taxiS],
    };
  });
  gates.sort((a, b) => a.taxiS - b.taxiS);
  for (let i = 0; i < gates.length; i++) {
    gates[i].id = i;
  }

  const minTaxiS =
    gates.length > 0 ? Math.min(...gates.map((g) => g.taxiS)) : 1.6;
  const preGateHoldS = Math.max(0.4, minTaxiS - 1.2);

  /**
   * Converts layout dimensions from tiles to pixels for canvas rendering.
   *
   * @param {number} ts - Tile size in pixels.
   * @returns {AirfieldPixelLayout}
   */
  const toPixels = (ts) => ({
    rwyLen: rwyLen * ts,
    rwyWid: rwyWid * ts,
    padLen: padLen * ts,
    padWid: padWid * ts,
    termW: termW * ts,
    termH: termH * ts,
    termY: termY * ts,
    renderTermY: renderTermY * ts,
    renderStandY: renderStandY * ts,
    taxiY: taxiY * ts,
    holdShortY: holdShortY * ts,
    mainRwyY: mainRwyY * ts,
    depRwyY: depRwyY * ts,
    outerRwyY: outerRwyY * ts,
    arrRwyY: arrRwyY * ts,
    exitCrossX: exitCrossX * ts,
    depCrossX: depCrossX * ts,
  });

  return {
    isDual,
    activeSign,
    side,
    halfLen,
    halfWid,
    rwyLen,
    rwyWid,
    padLen,
    padWid,
    termW,
    termH,
    termY,
    renderTermY,
    renderStandY,
    taxiY,
    holdShortY,
    mainRwyY,
    depRwyY,
    outerRwyY,
    arrRwyY,
    exitCrossX,
    depCrossX,
    crossFromY,
    crossSpan,
    spineLen,
    holdShortS,
    preGateHoldS,
    gates,
    toPixels,
  };
}

/**
 * Maps 1D taxiway coordinate s to world coordinates { x, y, ang }.
 *
 * @param {Airport | PlaneEndpoint | { angleRad?: number, angle?: number, x: number, y: number, halfLen?: number, isHub?: boolean, tier?: string, airportClass?: string, dualRunway?: boolean, apronSide?: number, activeSign?: 1 | -1, atc?: AirportATC }} ap - Airfield state.
 * @param {number} s - 1D taxiway spine distance in tiles.
 * @returns {{ x: number, y: number, ang: number }} Position and orientation in world coordinates.
 */
export function taxiSpinePosToWorld(ap, s) {
  const atc = ap.atc;
  const isHub = Boolean(
    ap.tier === "HUB" || ap.isHub || ap.airportClass === "HUB" || ap.dualRunway,
  );
  const side = ap.apronSide || 1;
  const rwyLen = (ap.halfLen || (isHub ? 7.4 : 5.2)) * 2;
  const activeSign = atc?.activeSign ?? ap.activeSign ?? 1;
  const exitCrossX = atc
    ? atc.exitRwyX
    : activeSign * (isHub ? 0.41 : 0.38) * rwyLen;
  const depCrossX = atc
    ? atc.depCrossX
    : -activeSign * (isHub ? 0.41 : 0.38) * rwyLen;
  const taxiY = atc ? atc.taxiY : -side * (isHub ? 0.6 : 0.62);
  const holdShortY = atc ? atc.holdShortY : -side * (isHub ? 0.94 : 0.96);
  const spineLen = Math.abs(depCrossX - exitCrossX);
  const holdShortS = atc
    ? atc.holdShortS
    : spineLen + Math.abs(taxiY - holdShortY);

  const angRad = ap.angleRad ?? ap.angle ?? 0;
  let lx = 0;
  let ly = 0;
  let ang = 0;

  const crossFromY = -side * (isHub ? 3.35 : 1.68);
  const crossSpan = Math.abs(taxiY - crossFromY);

  const ang0 = angRad + (activeSign > 0 ? 0 : Math.PI);
  const ang1 = angRad + (side > 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
  const ang2 = angRad + (activeSign > 0 ? Math.PI : 0);
  const ang3 = angRad + (side > 0 ? -Math.PI * 0.5 : Math.PI * 0.5);

  if (s < -crossSpan) {
    lx = exitCrossX + activeSign * (s + crossSpan);
    ly = crossFromY;
    ang = ang0;
  } else if (s < 0) {
    lx = exitCrossX;
    const t = crossSpan > 1e-4 ? (s + crossSpan) / crossSpan : 1;
    ly = crossFromY + (taxiY - crossFromY) * t;
    ang = ang1;
  } else if (s <= spineLen) {
    lx = exitCrossX - activeSign * s;
    ly = taxiY;
    ang = ang2;
  } else {
    lx = depCrossX;
    const turnSpan = Math.max(1e-4, holdShortS - spineLen);
    const t = Math.max(0, (s - spineLen) / turnSpan);
    ly = taxiY + (holdShortY - taxiY) * t;
    ang = ang3;
  }

  // Smooth quadratic Bezier corner fillets at the 3 right-angle corners
  const r1 = Math.min(0.45, crossSpan * 0.45);
  const sCorn1 = -crossSpan;
  if (Math.abs(s - sCorn1) <= r1 && r1 > 1e-4) {
    const t = (s - (sCorn1 - r1)) / (2 * r1);
    const mt = 1 - t;
    const p0x = exitCrossX - activeSign * r1;
    const p0y = crossFromY;
    const p1x = exitCrossX;
    const p1y = crossFromY;
    const p2x = exitCrossX;
    const p2y =
      crossFromY + (taxiY - crossFromY) * (r1 / Math.max(1e-4, crossSpan));
    lx = mt * mt * p0x + 2 * mt * t * p1x + t * t * p2x;
    ly = mt * mt * p0y + 2 * mt * t * p1y + t * t * p2y;
    ang = ang0 + normalizeAngle(ang1 - ang0) * t;
  }

  const r2 = Math.min(0.45, crossSpan * 0.45, spineLen * 0.25);
  const sCorn2 = 0;
  if (Math.abs(s - sCorn2) <= r2 && r2 > 1e-4) {
    const t = (s - (sCorn2 - r2)) / (2 * r2);
    const mt = 1 - t;
    const p0x = exitCrossX;
    const p0y = taxiY - (taxiY - crossFromY) * (r2 / Math.max(1e-4, crossSpan));
    const p1x = exitCrossX;
    const p1y = taxiY;
    const p2x = exitCrossX - activeSign * r2;
    const p2y = taxiY;
    lx = mt * mt * p0x + 2 * mt * t * p1x + t * t * p2x;
    ly = mt * mt * p0y + 2 * mt * t * p1y + t * t * p2y;
    ang = ang1 + normalizeAngle(ang2 - ang1) * t;
  }

  const r3 = Math.min(0.28, Math.max(0.05, holdShortS - spineLen) * 0.85);
  const sCorn3 = spineLen;
  if (s >= sCorn3 - r3 && s <= sCorn3 + r3 && r3 > 1e-4) {
    const t = (s - (sCorn3 - r3)) / (2 * r3);
    const mt = 1 - t;
    const p0x = depCrossX + activeSign * r3;
    const p0y = taxiY;
    const p1x = depCrossX;
    const p1y = taxiY;
    const p2x = depCrossX;
    const p2y =
      taxiY +
      (holdShortY - taxiY) * (r3 / Math.max(1e-4, holdShortS - spineLen));
    lx = mt * mt * p0x + 2 * mt * t * p1x + t * t * p2x;
    ly = mt * mt * p0y + 2 * mt * t * p1y + t * t * p2y;
    ang = ang2 + normalizeAngle(ang3 - ang2) * t;
  }

  const w = localToWorldAirfield(ap, lx, ly);
  return { x: w.x, y: w.y, ang };
}
