/** @import { Airport, AirportATC, CarAgent, FlightPhase, FlightTrack, FlightTrackPoint, GateSlot, PlaneAgent, PlaneEndpoint, PlaneFSMState } from './types.js' */
/** @import { ProceduralLogisticsWorld } from './world-generator.js' */
import { SIM_CONFIG } from "./constants.js";
import { SeededRNG } from "./math.js";

/**
 * Transforms local runway-aligned coordinates (lx, ly) in tiles around ap by ap's runway angle.
 * @param {Airport | PlaneEndpoint} ap
 * @param {number} lx
 * @param {number} ly
 * @returns {{ x: number, y: number }}
 */
function toWorld(ap, lx, ly) {
  const ang = ap.angleRad ?? 0;
  const cosA = Math.cos(ang);
  const sinA = Math.sin(ang);
  return {
    x: ap.x + lx * cosA - ly * sinA,
    y: ap.y + lx * sinA + ly * cosA,
  };
}

/**
 * Normalizes an angle in radians to [-PI, PI].
 * @param {number} a
 * @returns {number}
 */
function normalizeAngle(a) {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r - Math.PI;
}

/**
 * Captures the residual delta between an aircraft's current pose and a new reference target
 * so any state or curve transition is 100% C0/C1 jump-free.
 * @param {PlaneAgent} p
 * @param {number} newRefX
 * @param {number} newRefY
 * @param {number} newRefAng
 */
function capturePoseResidual(p, newRefX, newRefY, newRefAng) {
  const dx = p.x - newRefX;
  const dy = p.y - newRefY;
  if (Math.hypot(dx, dy) <= 6.0) {
    p._resX = dx;
    p._resY = dy;
    p._resAng = normalizeAngle(p.ang - newRefAng);
  } else {
    p._resX = 0;
    p._resY = 0;
    p._resAng = 0;
  }
}

/**
 * Applies exponentially damped residual offsets so the aircraft smoothly converges
 * onto (refX, refY, refAng) without 1-frame position jumps or heading snaps.
 * @param {PlaneAgent} p
 * @param {number} refX
 * @param {number} refY
 * @param {number} refAng
 * @param {number} effDt
 */
function applySmoothedPose(p, refX, refY, refAng, effDt) {
  const decayPos = Math.exp(-7.0 * effDt);
  const rx = (p._resX ?? 0) * decayPos;
  const ry = (p._resY ?? 0) * decayPos;
  p._resX = Math.abs(rx) > 1e-4 ? rx : 0;
  p._resY = Math.abs(ry) > 1e-4 ? ry : 0;
  p.x = refX + p._resX;
  p.y = refY + p._resY;

  if (typeof p.ang !== "number" || Number.isNaN(p.ang)) {
    p.ang = refAng;
  }

  if (effDt <= 0.08) {
    const da = normalizeAngle(refAng - p.ang);
    const maxTurnStep = 3.8 * effDt;
    const desiredStep = da * (1 - Math.exp(-10.0 * effDt));
    p.ang = normalizeAngle(
      p.ang + Math.max(-maxTurnStep, Math.min(maxTurnStep, desiredStep)),
    );
    p._resAng = normalizeAngle(p.ang - refAng);
  } else {
    const decayAng = Math.exp(-8.5 * effDt);
    const ra = (p._resAng ?? 0) * decayAng;
    p._resAng = Math.abs(ra) > 1e-4 ? ra : 0;
    p.ang = normalizeAngle(refAng + p._resAng);
  }
}

/**
 * Initializes Airport ATC, gate slots, 1D taxiway spine, and into-the-wind active runway direction.
 * @param {Airport} ap
 * @param {{ x: number, y: number, rad?: number } | null} [windVector]
 * @returns {AirportATC}
 */
export function initAirportATC(ap, windVector = null) {
  let activeSign = ap.activeSign ?? 1;
  if (
    windVector &&
    typeof windVector.x === "number" &&
    typeof windVector.y === "number"
  ) {
    const ang = ap.angleRad ?? 0;
    const rwyCos = Math.cos(ang);
    const rwySin = Math.sin(ang);
    const headwindDot = -windVector.x * rwyCos + -windVector.y * rwySin;
    activeSign = headwindDot >= 0 ? 1 : -1;
  }

  const side = ap.apronSide || 1;
  const isHub = ap.isHub ?? false;
  const rwyLen = ap.halfLen * 2;
  const termW = rwyLen * (isHub ? 0.46 : 0.4);
  const taxiY = -side * (isHub ? 0.6 : 0.62);
  const termY = side * (isHub ? 0.86 : 0.8);
  // Hold short on the cross-field connector clear of the runway asphalt edge
  const holdShortY = -side * (isHub ? 0.94 : 0.96);

  const exitCrossX = activeSign * (isHub ? 0.41 : 0.38) * rwyLen;
  const depCrossX = -activeSign * (isHub ? 0.41 : 0.38) * rwyLen;
  const spineLen = Math.abs(depCrossX - exitCrossX);
  const holdShortS = spineLen + Math.abs(taxiY - holdShortY);

  const gateConfigs = isHub
    ? [-3, -2, -1, 0, 1, 2, 3].map((g) => g * 0.12 * termW)
    : ap.airportClass === "CRG"
      ? [-0.42, -0.22, 0.22, 0.42].map((frac) => frac * termW)
      : [-0.36, -0.12, 0.12, 0.36].map((frac) => frac * termW);

  const noseAngle =
    (ap.angleRad ?? 0) + (side > 0 ? Math.PI * 0.5 : -Math.PI * 0.5);

  /** @type {GateSlot[]} */
  const gates = [];
  for (let i = 0; i < gateConfigs.length; i++) {
    const lx = gateConfigs[i];
    const ly = termY;
    const taxiS = (exitCrossX - lx) * activeSign;
    const w = toWorld(ap, lx, ly);
    gates.push({
      id: i,
      lx,
      ly,
      taxiY,
      taxiS,
      worldX: w.x,
      worldY: w.y,
      noseAngle,
      state: "FREE",
      occupiedBy: null,
      reservedBy: null,
    });
  }

  gates.sort((a, b) => a.taxiS - b.taxiS);
  for (let i = 0; i < gates.length; i++) {
    gates[i].id = i;
  }

  const minTaxiS =
    gates.length > 0 ? Math.min(...gates.map((g) => g.taxiS)) : 1.6;
  const preGateHoldS = Math.max(0.4, minTaxiS - 1.2);

  /** @type {AirportATC} */
  const atc = {
    airportId: ap.id ?? 0,
    isHub,
    activeSign,
    rwyLen,
    termW,
    taxiY,
    holdShortY,
    exitRwyX: exitCrossX,
    crossTaxiX: exitCrossX,
    depCrossX,
    holdShortS,
    preGateHoldS,
    gates,
    taxiwayOccupants: [],
    holdShortQueue: [],
    crossingQueue: [],
    approachQueue: [],
    runwayBusyBy: null,
    depRunwayBusyBy: null,
    arrRunwayBusyBy: null,
    crossingBusyBy: null,
    lastOp: "DEPARTURE",
  };

  ap.atc = atc;
  ap.activeSign = activeSign;
  return atc;
}

/**
 * Maps 1D taxiway coordinate s in [0, holdShortS] to world coordinates { x, y, ang }.
 * @param {Airport | PlaneEndpoint} ap
 * @param {number} s
 * @returns {{ x: number, y: number, ang: number }}
 */
export function taxiSpinePosToWorld(ap, s) {
  const atc = ap.atc;
  const isHub = Boolean(ap.isHub);
  const side = ap.apronSide || 1;
  const rwyLen = ap.halfLen * 2;
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

  const clampedS = Math.min(s, holdShortS);
  const angRad = ap.angleRad ?? 0;
  let lx = 0;
  let ly = 0;
  let ang = 0;

  const crossFromY = -side * (isHub ? 3.35 : 1.68);
  const crossSpan = Math.abs(taxiY - crossFromY);

  const ang0 = angRad + (activeSign > 0 ? 0 : Math.PI);
  const ang1 = angRad + (side > 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
  const ang2 = angRad + (activeSign > 0 ? Math.PI : 0);
  const ang3 = angRad + (side > 0 ? -Math.PI * 0.5 : Math.PI * 0.5);

  if (clampedS < -crossSpan) {
    lx = exitCrossX - activeSign * (clampedS + crossSpan);
    ly = crossFromY;
    ang = ang0;
  } else if (clampedS < 0) {
    lx = exitCrossX;
    const t = crossSpan > 1e-4 ? (clampedS + crossSpan) / crossSpan : 1;
    ly = crossFromY + (taxiY - crossFromY) * t;
    ang = ang1;
  } else if (clampedS <= spineLen) {
    lx = exitCrossX - activeSign * clampedS;
    ly = taxiY;
    ang = ang2;
  } else {
    lx = depCrossX;
    const turnSpan = holdShortS - spineLen;
    const t =
      turnSpan > 1e-4
        ? Math.max(0, Math.min(1, (clampedS - spineLen) / turnSpan))
        : 1;
    ly = taxiY + (holdShortY - taxiY) * t;
    ang = ang3;
  }

  // Smooth quadratic Bezier corner fillets at the 3 right-angle corners
  const r1 = Math.min(0.45, crossSpan * 0.45);
  const sCorn1 = -crossSpan;
  if (Math.abs(clampedS - sCorn1) <= r1 && r1 > 1e-4) {
    const t = (clampedS - (sCorn1 - r1)) / (2 * r1);
    const mt = 1 - t;
    const p0x = exitCrossX + activeSign * r1;
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
  if (Math.abs(clampedS - sCorn2) <= r2 && r2 > 1e-4) {
    const t = (clampedS - (sCorn2 - r2)) / (2 * r2);
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
  if (clampedS >= sCorn3 - r3 && clampedS <= sCorn3 + r3 && r3 > 1e-4) {
    const t = (clampedS - (sCorn3 - r3)) / (2 * r3);
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

  const w = toWorld(ap, lx, ly);
  return { x: w.x, y: w.y, ang };
}

/**
 * Computes the world pose for a taxiway occupant, smoothly turning 90 degrees
 * off the parallel taxiway along the gate lead-in line during the final 1.35 tiles of TAXI_TO_GATE.
 * @param {Airport | PlaneEndpoint} ap
 * @param {PlaneAgent} occ
 * @returns {{ x: number, y: number, ang: number }}
 */
function taxiOccupantWorldPose(ap, occ) {
  const wPos = taxiSpinePosToWorld(ap, occ.taxiS ?? 0);
  if (
    occ.state === "TAXI_TO_GATE" &&
    occ.reservedGateId !== null &&
    occ.reservedGateId !== undefined &&
    ap.atc
  ) {
    const gate = ap.atc.gates.find((g) => g.id === occ.reservedGateId);
    if (gate) {
      const remS = Math.max(0, gate.taxiS - (occ.taxiS ?? 0));
      const turnSpan = 1.35;
      if (remS <= turnSpan) {
        const t = 1 - remS / turnSpan;
        const u = t * t * (3 - 2 * t);
        return {
          x: wPos.x + (gate.worldX - wPos.x) * u,
          y: wPos.y + (gate.worldY - wPos.y) * u,
          ang: wPos.ang + normalizeAngle(gate.noseAngle - wPos.ang) * u,
        };
      }
    }
  }

  if (
    occ.state === "TAXI_TO_RUNWAY" &&
    occ.pushbackOriginGateId !== null &&
    occ.pushbackOriginGateId !== undefined &&
    ap.atc
  ) {
    const gate = ap.atc.gates.find((g) => g.id === occ.pushbackOriginGateId);
    if (gate) {
      const elapsedS = Math.max(0, (occ.taxiS ?? gate.taxiS) - gate.taxiS);
      const turnSpan = 1.35;
      if (elapsedS <= turnSpan) {
        const t = elapsedS / turnSpan;
        const u = t * t * (3 - 2 * t);
        return {
          x: gate.worldX + (wPos.x - gate.worldX) * u,
          y: gate.worldY + (wPos.y - gate.worldY) * u,
          ang: gate.noseAngle + normalizeAngle(wPos.ang - gate.noseAngle) * u,
        };
      }
      occ.pushbackOriginGateId = null;
      occ.pushbackOriginS = null;
    }
  }

  return wPos;
}

/**
 * Checks whether the taxiway spine behind a gate is clear of moving aircraft for pushback.
 * @param {AirportATC} atc
 * @param {number} gateTaxiS
 * @returns {boolean}
 */
export function canPushBackOntoTaxiway(atc, gateTaxiS) {
  const trail = SIM_CONFIG.AVIATION.pushbackClearTrail;
  const lead = SIM_CONFIG.AVIATION.pushbackClearLead;
  const sMin = gateTaxiS - trail;
  const sMax = gateTaxiS + lead;
  for (const plane of atc.taxiwayOccupants) {
    const s = plane.taxiS ?? 0;
    if (s >= sMin && s <= sMax) {
      return false;
    }
  }
  return true;
}

/**
 * Releases any gate occupied or reserved by planeId across all airports.
 * @param {ProceduralLogisticsWorld} world
 * @param {number} planeId
 */
function releaseAllGatesForPlane(world, planeId) {
  for (const ap of world.airports || []) {
    if (!ap.atc) continue;
    for (const g of ap.atc.gates) {
      if (g.occupiedBy === planeId || g.reservedBy === planeId) {
        g.occupiedBy = null;
        g.reservedBy = null;
        g.state = "FREE";
      }
    }
  }
}

/**
 * Enforces FIFO non-overtaking separation (minTaxiSeparation) on the 1D taxiway spine.
 * @param {AirportATC} atc
 */
export function maintainTaxiwayOrder(atc) {
  const occupants = atc.taxiwayOccupants;
  if (occupants.length === 0) return;

  occupants.sort((a, b) => (b.taxiS ?? 0) - (a.taxiS ?? 0));

  if ((occupants[0].taxiS ?? 0) > atc.holdShortS) {
    occupants[0].taxiS = atc.holdShortS;
  }

  const minSep = SIM_CONFIG.AVIATION.minTaxiSeparation;
  for (let i = 1; i < occupants.length; i++) {
    const prevS = occupants[i - 1].taxiS ?? 0;
    const maxAllowed = prevS - minSep;
    if ((occupants[i].taxiS ?? 0) > maxAllowed) {
      occupants[i].taxiS = maxAllowed;
    }
  }
}

/**
 * Builds an arc-length parameterized 5-phase gate-to-gate flight track in world tile coordinates.
 * @param {Airport | PlaneEndpoint} origin
 * @param {Airport | PlaneEndpoint} dest
 * @param {{ isCargoFreighter?: boolean, gateIndex?: number, gateLx?: number, destGateLx?: number, oSign?: 1 | -1, dSign?: 1 | -1 }} [options]
 * @returns {FlightTrack}
 */
export function buildFlightTrack(origin, dest, options = {}) {
  const oSide = origin.apronSide || 1;
  const dSide = dest.apronSide || 1;
  const oIsHub = Boolean(origin.isHub);
  const dIsHub = Boolean(dest.isHub);

  const dx = dest.x - origin.x;
  const dy = dest.y - origin.y;
  const oAng = origin.angleRad ?? 0;
  const dAng = dest.angleRad ?? 0;
  const oDot = dx * Math.cos(oAng) + dy * Math.sin(oAng);
  const dDot = dx * Math.cos(dAng) + dy * Math.sin(dAng);
  const oSign = options.oSign ?? origin.activeSign ?? (oDot >= 0 ? 1 : -1);
  const dSign = options.dSign ?? dest.activeSign ?? (dDot >= 0 ? 1 : -1);

  // Dual-Runway Hub & Single-Runway Alignment (Phase 2)
  const oRwyLen = origin.halfLen * 2;
  const depRwyY = oIsHub ? -oSide * 1.72 : -oSide * 1.68;

  const dBaseRwyLen = dest.halfLen * 2;
  const dRwyLen = dIsHub ? dBaseRwyLen * 0.88 : dBaseRwyLen;
  const arrRwyY = dIsHub ? -dSide * 3.35 : -dSide * 1.68;

  const oTermW = oRwyLen * (oIsHub ? 0.46 : 0.4);
  const dTermW = dBaseRwyLen * (dIsHub ? 0.46 : 0.4);
  const gateIndex = options.gateIndex ?? 0;
  const hubFracs = [-0.36, -0.24, -0.12, 0, 0.12, 0.24, 0.36];
  const crgFracs = [-0.42, -0.22, 0.22, 0.42];
  const regFracs = [-0.36, -0.12, 0.12, 0.36];

  // Origin gate and taxi geometry (matches initAirportATC & drawAirports gate stands)
  const oFracs = oIsHub
    ? hubFracs
    : origin.airportClass === "CRG"
      ? crgFracs
      : regFracs;
  const oGateX =
    options.gateLx !== undefined
      ? options.gateLx
      : oFracs[gateIndex % oFracs.length] * oTermW;
  const oTermY = oSide * (oIsHub ? 0.86 : 0.8);
  const oTaxiY = -oSide * (oIsHub ? 0.6 : 0.62);
  const oCrossTaxiX = -oSign * (oIsHub ? 0.41 : 0.38) * oRwyLen;
  const oHoldShortY = -oSide * (oIsHub ? 0.94 : 0.96);

  // Destination gate and taxi geometry (matches unscaled concourse & cross-field taxiways in drawAirports)
  const dFracs = dIsHub
    ? hubFracs
    : dest.airportClass === "CRG"
      ? crgFracs
      : regFracs;
  const dGateX =
    options.destGateLx !== undefined
      ? options.destGateLx
      : dFracs[gateIndex % dFracs.length] * dTermW;
  const dTermY = dSide * (dIsHub ? 0.86 : 0.8);
  const dTaxiY = -dSide * (dIsHub ? 0.6 : 0.62);
  const dExitRwyX = dSign * (dIsHub ? 0.41 : 0.38) * dBaseRwyLen;
  const dCrossTaxiX = dSign * (dIsHub ? 0.41 : 0.38) * dBaseRwyLen;

  /** @type {FlightTrackPoint[]} */
  const rawPts = [];
  let holdShortRawIdx = -1;

  // 1. TAXI_OUT (altitude = 0, speed = 2.2 tiles/sec)
  const taxiSpeed = SIM_CONFIG.AVIATION.taxiSpeed;
  const pGate = toWorld(origin, oGateX, oTermY);
  rawPts.push({
    x: pGate.x,
    y: pGate.y,
    altitude: 0,
    phase: "TAXI_OUT",
    speed: taxiSpeed,
  });

  const pApron = toWorld(origin, oGateX, oTaxiY);
  rawPts.push({
    x: pApron.x,
    y: pApron.y,
    altitude: 0,
    phase: "TAXI_OUT",
    speed: taxiSpeed,
  });

  const pCross = toWorld(origin, oCrossTaxiX, oTaxiY);
  rawPts.push({
    x: pCross.x,
    y: pCross.y,
    altitude: 0,
    phase: "TAXI_OUT",
    speed: taxiSpeed,
  });

  const pHoldShort = toWorld(origin, oCrossTaxiX, oHoldShortY);
  holdShortRawIdx = rawPts.length;
  rawPts.push({
    x: pHoldShort.x,
    y: pHoldShort.y,
    altitude: 0,
    phase: "TAXI_OUT",
    speed: taxiSpeed,
  });

  // Forward 4-step quarter-circle fillet lining up from hold-short onto runway centerline
  const turnR = Math.abs(depRwyY - oHoldShortY);
  for (let step = 1; step <= 4; step++) {
    const theta = (step / 4) * (Math.PI * 0.5);
    const flx = oCrossTaxiX + oSign * turnR * (1 - Math.cos(theta));
    const fly =
      step === 4 ? depRwyY : oHoldShortY - oSide * turnR * Math.sin(theta);
    const pFillet = toWorld(origin, flx, fly);
    rawPts.push({
      x: pFillet.x,
      y: pFillet.y,
      altitude: 0,
      phase: "TAXI_OUT",
      speed: taxiSpeed,
    });
  }

  // 2. TAKEOFF (altitude: 0 -> 0.18, speed: 2.2 -> 13.5 tiles/sec smooth acceleration roll)
  const takeoffSpeed = SIM_CONFIG.AVIATION.takeoffSpeed;
  const pEarlyRoll = toWorld(origin, -oSign * oRwyLen * 0.22, depRwyY);
  rawPts.push({
    x: pEarlyRoll.x,
    y: pEarlyRoll.y,
    altitude: 0,
    phase: "TAKEOFF",
    speed: taxiSpeed + (takeoffSpeed - taxiSpeed) * 0.22,
  });

  const pMidRoll = toWorld(origin, 0, depRwyY);
  rawPts.push({
    x: pMidRoll.x,
    y: pMidRoll.y,
    altitude: 0,
    phase: "TAKEOFF",
    speed: taxiSpeed + (takeoffSpeed - taxiSpeed) * 0.55,
  });

  const pLiftoff = toWorld(origin, oSign * oRwyLen * 0.32, depRwyY);
  rawPts.push({
    x: pLiftoff.x,
    y: pLiftoff.y,
    altitude: 0,
    phase: "TAKEOFF",
    speed: takeoffSpeed,
  });

  const oApproachLen = origin.approachLen || 14;
  const oClimbX = oSign * (origin.halfLen + oApproachLen * 0.65);
  const oMidClimbX = oSign * (origin.halfLen + oApproachLen * 0.32);

  const pMidClimb = toWorld(origin, oMidClimbX, depRwyY);
  rawPts.push({
    x: pMidClimb.x,
    y: pMidClimb.y,
    altitude: SIM_CONFIG.AVIATION.climbOutAlt * 0.5,
    phase: "TAKEOFF",
    speed: takeoffSpeed,
  });

  const pClimbOut = toWorld(origin, oClimbX, depRwyY);
  rawPts.push({
    x: pClimbOut.x,
    y: pClimbOut.y,
    altitude: SIM_CONFIG.AVIATION.climbOutAlt,
    phase: "TAKEOFF",
    speed: takeoffSpeed,
  });

  // 3. CRUISE (altitude: 0.18 -> 1.0 -> 0.18, speed = 16.5 tiles/sec)
  const sx = pClimbOut.x;
  const sy = pClimbOut.y;

  const dApproachLen = dest.approachLen || 14;
  const dEntryDist = dest.halfLen * (dIsHub ? 0.88 : 1.0) + dApproachLen * 0.75;
  const dEntryX = -dSign * dEntryDist;
  const pAppEntry = toWorld(dest, dEntryX, arrRwyY);
  const ex = pAppEntry.x;
  const ey = pAppEntry.y;

  const cdx = ex - sx;
  const cdy = ey - sy;
  const cDist = Math.hypot(cdx, cdy) || 1;
  const climbPull = Math.min(18, Math.max(4, cDist * 0.34));
  const oCos = Math.cos(oAng);
  const oSin = Math.sin(oAng);
  const dCos = Math.cos(dAng);
  const dSin = Math.sin(dAng);
  const nx = -cdy / cDist;
  const ny = cdx / cDist;
  const latArc = Math.min(1.5, cDist * 0.035);

  const c1x = sx + oCos * oSign * climbPull + nx * latArc;
  const c1y = sy + oSin * oSign * climbPull + ny * latArc;
  const c2x = ex - dCos * dSign * climbPull + nx * latArc;
  const c2y = ey - dSin * dSign * climbPull + ny * latArc;
  const airwayCurve = { sx, sy, c1x, c1y, c2x, c2y, ex, ey };

  const numCruiseSteps = Math.max(24, Math.ceil(cDist / 1.0));
  const cruiseSpeed = SIM_CONFIG.AVIATION.cruiseSpeed;
  for (let k = 1; k < numCruiseSteps; k++) {
    const t = k / numCruiseSteps;
    const mt = 1 - t;
    const b0 = mt * mt * mt;
    const b1 = 3 * mt * mt * t;
    const b2 = 3 * mt * t * t;
    const b3 = t * t * t;
    const bx = b0 * sx + b1 * c1x + b2 * c2x + b3 * ex;
    const by = b0 * sy + b1 * c1y + b2 * c2y + b3 * ey;
    const alt =
      SIM_CONFIG.AVIATION.climbOutAlt +
      (SIM_CONFIG.AVIATION.cruiseAlt - SIM_CONFIG.AVIATION.climbOutAlt) *
        Math.sin(t * Math.PI);
    rawPts.push({
      x: bx,
      y: by,
      altitude: alt,
      phase: "CRUISE",
      speed: cruiseSpeed,
    });
  }

  // 4. LANDING (altitude: 0.18 -> 0, speed: 12.5 -> 2.2 tiles/sec)
  const landingSpeed = SIM_CONFIG.AVIATION.landingSpeed;
  rawPts.push({
    x: pAppEntry.x,
    y: pAppEntry.y,
    altitude: SIM_CONFIG.AVIATION.climbOutAlt,
    phase: "LANDING",
    speed: landingSpeed,
  });

  const midAppDist = (dEntryDist + 0.42 * dRwyLen) * 0.5;
  const pMidApp = toWorld(dest, -dSign * midAppDist, arrRwyY);
  rawPts.push({
    x: pMidApp.x,
    y: pMidApp.y,
    altitude: SIM_CONFIG.AVIATION.climbOutAlt * 0.5,
    phase: "LANDING",
    speed: landingSpeed,
  });

  const pTouchdown = toWorld(dest, -dSign * 0.42 * dRwyLen, arrRwyY);
  rawPts.push({
    x: pTouchdown.x,
    y: pTouchdown.y,
    altitude: 0,
    phase: "LANDING",
    speed: 9.0,
  });

  const pMidRollout = toWorld(dest, 0, arrRwyY);
  rawPts.push({
    x: pMidRollout.x,
    y: pMidRollout.y,
    altitude: 0,
    phase: "LANDING",
    speed: 5.5,
  });

  const pExit = toWorld(dest, dExitRwyX, arrRwyY);
  rawPts.push({
    x: pExit.x,
    y: pExit.y,
    altitude: 0,
    phase: "TAXI_IN",
    speed: taxiSpeed,
  });

  // 5. TAXI_IN (altitude = 0, speed = 2.2 tiles/sec)
  const pTaxiCross = toWorld(dest, dCrossTaxiX, dTaxiY);
  rawPts.push({
    x: pTaxiCross.x,
    y: pTaxiCross.y,
    altitude: 0,
    phase: "TAXI_IN",
    speed: taxiSpeed,
  });

  const pTaxiGate = toWorld(dest, dGateX, dTaxiY);
  rawPts.push({
    x: pTaxiGate.x,
    y: pTaxiGate.y,
    altitude: 0,
    phase: "TAXI_IN",
    speed: taxiSpeed,
  });

  const pDestGate = toWorld(dest, dGateX, dTermY);
  rawPts.push({
    x: pDestGate.x,
    y: pDestGate.y,
    altitude: 0,
    phase: "TAXI_IN",
    speed: taxiSpeed,
  });

  // Filter consecutive duplicate points & build cumulative arc length
  /** @type {FlightTrackPoint[]} */
  const pts = [rawPts[0]];
  let holdShortFilteredIdx = 0;

  for (let i = 1; i < rawPts.length; i++) {
    const prev = pts[pts.length - 1];
    const cur = rawPts[i];
    const d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    if (d > 1e-4) {
      if (i === holdShortRawIdx) {
        holdShortFilteredIdx = pts.length;
      }
      pts.push(cur);
    } else if (i === holdShortRawIdx) {
      holdShortFilteredIdx = pts.length - 1;
    }
  }

  const n = pts.length;
  const cumLen = new Float32Array(n);
  cumLen[0] = 0;
  for (let i = 1; i < n; i++) {
    cumLen[i] =
      cumLen[i - 1] +
      Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  const totalLength = cumLen[n - 1];
  const holdShortDist = cumLen[holdShortFilteredIdx];

  return {
    pts,
    cumLen,
    totalLength,
    holdShortDist,
    airwayCurve,
  };
}

/**
 * Samples a position, tangent angle, altitude, speed, and phase along a flight track at arc distance dist.
 * @param {FlightTrack} track
 * @param {number} dist
 * @returns {{ x: number, y: number, ang: number, altitude: number, speed: number, phase: FlightPhase, segIdx: number }}
 */
export function sampleFlightTrack(track, dist) {
  const { pts, cumLen, totalLength } = track;
  const clampedDist = Math.max(0, Math.min(dist, totalLength));
  let segIdx = 0;
  while (segIdx < pts.length - 2 && cumLen[segIdx + 1] <= clampedDist) {
    segIdx++;
  }
  const p0 = pts[segIdx];
  const p1 = pts[segIdx + 1] || p0;
  const span = cumLen[segIdx + 1] - cumLen[segIdx];
  const u = span > 1e-6 ? (clampedDist - cumLen[segIdx]) / span : 0;
  const clampedU = Math.max(0, Math.min(1, u));
  const x = p0.x + (p1.x - p0.x) * clampedU;
  const y = p0.y + (p1.y - p0.y) * clampedU;
  const altitude = p0.altitude + (p1.altitude - p0.altitude) * clampedU;
  const speed = p0.speed + (p1.speed - p0.speed) * clampedU;
  const phase = clampedDist >= totalLength ? "GATE_DWELL" : p0.phase;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const ang = Math.atan2(dy, dx);
  return { x, y, ang, altitude, speed, phase, segIdx };
}

/***************************************************************************
 * 4. LIVE TRAFFIC (CARS) & AVIATION (FLIGHTS) SIMULATION ENGINE
 ***************************************************************************/
export class LogisticsSimulator {
  /**
   * @param {ProceduralLogisticsWorld} world
   */
  constructor(world) {
    /** @type {ProceduralLogisticsWorld} */
    this.world = world;
    /** @type {CarAgent[]} */
    this.cars = [];
    /** @type {PlaneAgent[]} */
    this.planes = [];
    /** @type {number} */
    this.tripsCompleted = SIM_CONFIG.FLEET.initialTrips;
    /** @type {number} */
    this.simTime = 0;
    /** @type {SeededRNG} */
    this.rng = new SeededRNG(`${world.config?.seed || "OTTD-METRO-84"}:sim`);

    // Phase 1: Initialize ATC on every airport
    for (const ap of this.world.airports) {
      initAirportATC(ap, this.world.windVector);
    }

    this.initAgents();
  }

  initAgents() {
    const { world } = this;
    // Spawn Mini Motorways commuter cars along road paths and motorways
    for (let i = 0; i < SIM_CONFIG.FLEET.commuterCars; i++) {
      this.spawnCar(false);
    }
    // Spawn Inter-Industrial Freight Trucks along the `RAW -> MFG -> LOG -> COM` cargo chain!
    for (let i = 0; i < SIM_CONFIG.FLEET.freightTrucks; i++) {
      this.spawnCar(true);
    }
    // Spawn aircraft operating between airports (with 3x air fleet in Island Hopper mode!)
    if (world.airports.length > 0) {
      const mult =
        world.config.archetype === "island-hopper"
          ? SIM_CONFIG.FLEET.islandHopperPlanesPerAirport
          : SIM_CONFIG.FLEET.basePlanesPerAirport;
      const planeCount = Math.max(2, world.airports.length * mult);
      for (let i = 0; i < planeCount; i++) {
        this.spawnPlane(i / planeCount);
      }
    }
  }

  /**
   * @param {boolean} [isFreightTruck]
   */
  spawnCar(isFreightTruck = false) {
    const { world, rng } = this;
    if (isFreightTruck && world.cargoLinks && world.cargoLinks.length > 0) {
      const mwayLinks = world.cargoLinks.filter(
        (l) => l.usesMotorway && l.outboundTrack && l.inboundTrack,
      );
      const validLinks = world.cargoLinks.filter(
        (l) => l.outboundTrack && l.inboundTrack,
      );
      const pool =
        mwayLinks.length > 0 && rng.next() < 0.45 ? mwayLinks : validLinks;
      if (pool.length > 0) {
        const link = pool[Math.floor(rng.next() * pool.length)];
        const returning = rng.next() < 0.32;
        const track = returning ? link.inboundTrack : link.outboundTrack;
        const dist = rng.next() * track.totalLength;
        let segIdx = 0;
        while (
          segIdx < track.pts.length - 2 &&
          track.cumLen[segIdx + 1] <= dist
        ) {
          segIdx++;
        }
        this.cars.push({
          isFreightTruck: true,
          isCargoLink: true,
          cargoStage: link.stage,
          outboundTrack: link.outboundTrack,
          inboundTrack: link.inboundTrack,
          returning,
          dist,
          segIdx,
          speed: 3.1 + rng.next() * 1.3,
          color: link.color,
        });
        return;
      }
    }

    if (world.commuterRoutes && world.commuterRoutes.length > 0) {
      const mwayRoutes = world.commuterRoutes.filter(
        (r) => r.usesMotorway && r.outboundTrack && r.inboundTrack,
      );
      const validRoutes = world.commuterRoutes.filter(
        (r) => r.outboundTrack && r.inboundTrack,
      );
      const pool =
        mwayRoutes.length > 0 && rng.next() < 0.42 ? mwayRoutes : validRoutes;
      if (pool.length > 0) {
        const route = pool[Math.floor(rng.next() * pool.length)];
        const returning = rng.next() < 0.5;
        const track = returning ? route.inboundTrack : route.outboundTrack;
        const dist = rng.next() * track.totalLength;
        let segIdx = 0;
        while (
          segIdx < track.pts.length - 2 &&
          track.cumLen[segIdx + 1] <= dist
        ) {
          segIdx++;
        }
        this.cars.push({
          isFreightTruck: false,
          isCargoLink: false,
          outboundTrack: route.outboundTrack,
          inboundTrack: route.inboundTrack,
          returning,
          dist,
          segIdx,
          speed: 3.8 + rng.next() * 1.8,
          color: route.color,
        });
      }
    }
  }

  /**
   * @param {number} [initialProgress]
   */
  spawnPlane(initialProgress = 0) {
    const { world, rng } = this;
    if (world.airports.length === 0) return;
    const planeIdx = this.planes.length;
    const originIdx = planeIdx % world.airports.length;
    const origin = world.airports[originIdx];
    if (!origin) return;

    /** @type {Airport | PlaneEndpoint} */
    let dest;
    if (world.airports.length > 1) {
      const destIdx =
        (originIdx + 1 + Math.floor(rng.next() * (world.airports.length - 1))) %
        world.airports.length;
      dest = world.airports[destIdx];
    } else {
      // Virtual international off-map corridor if single airport (matches drawAirwayCorridors)
      const ang = origin.angleRad ?? 0;
      dest = {
        x: origin.x + Math.cos(ang + 0.35) * 95,
        y: origin.y + Math.sin(ang + 0.35) * 95,
        angleRad: ang,
        halfLen: 6,
      };
    }

    const isCargoFreighter = Boolean(
      origin.airportClass === "CRG" ||
      dest.airportClass === "CRG" ||
      (origin.isHub && dest.isHub && planeIdx % 3 === 2),
    );

    const originAtc = origin.atc;
    const destAtc = dest.atc;
    /** @type {number | null} */
    let gateId = null;
    /** @type {GateSlot | null} */
    let chosenOriginGate = null;
    if (originAtc && originAtc.gates.length > 0) {
      const freeGate = originAtc.gates.find((g) => g.state === "FREE");
      if (freeGate) {
        freeGate.state = "OCCUPIED";
        freeGate.occupiedBy = planeIdx;
        gateId = freeGate.id;
        chosenOriginGate = freeGate;
      }
    }
    const chosenDestGate =
      destAtc && destAtc.gates.length > 0
        ? (destAtc.gates.find((g) => g.state === "FREE") ??
          destAtc.gates[planeIdx % destAtc.gates.length])
        : null;

    const track = buildFlightTrack(origin, dest, {
      isCargoFreighter,
      gateIndex: planeIdx,
      gateLx: chosenOriginGate?.lx,
      destGateLx: chosenDestGate?.lx,
      oSign: origin.activeSign,
      dSign: dest.activeSign,
    });

    const effProgress =
      initialProgress <= 0.01 && originAtc && !chosenOriginGate
        ? 0.5
        : initialProgress;
    const dist = Math.max(
      0,
      Math.min(effProgress * track.totalLength, track.totalLength * 0.999),
    );
    const sample = sampleFlightTrack(track, dist);

    /** @type {PlaneFSMState} */
    let state = "GATE_LOADING";
    let taxiS = 0;
    const targetTaxiS = originAtc?.holdShortS ?? 10;
    /** @type {number | null} */
    let reservedGateId = null;

    if (dist <= 0.01) {
      state = "GATE_LOADING";
      if (originAtc && gateId !== null) {
        const g = originAtc.gates.find((x) => x.id === gateId);
        if (g) taxiS = g.taxiS;
      }
    } else {
      if (chosenOriginGate) {
        chosenOriginGate.state = "FREE";
        chosenOriginGate.occupiedBy = null;
        gateId = null;
      }
      if (sample.phase === "TAXI_OUT") {
        if (dist >= track.holdShortDist - 0.25) {
          state = "HOLD_SHORT_QUEUE";
          taxiS = originAtc?.holdShortS ?? 10;
        } else {
          state = "TAXI_TO_RUNWAY";
          taxiS = originAtc
            ? (dist / Math.max(0.01, track.holdShortDist)) *
              originAtc.holdShortS
            : 5;
        }
      } else if (sample.phase === "TAKEOFF") {
        state = "TAKEOFF_ROLL";
        if (originAtc) {
          originAtc.runwayBusyBy = planeIdx;
          if (originAtc.isHub) originAtc.depRunwayBusyBy = planeIdx;
        }
      } else if (sample.phase === "CRUISE") {
        state = "ENROUTE_CRUISE";
      } else if (sample.phase === "LANDING") {
        state = "LANDING_ROLLOUT";
        if (destAtc) {
          destAtc.runwayBusyBy = planeIdx;
          if (destAtc.isHub) destAtc.arrRunwayBusyBy = planeIdx;
        }
      } else if (sample.phase === "TAXI_IN") {
        state = "TAXI_TO_GATE";
        if (destAtc && destAtc.gates.length > 0) {
          const freeGate = destAtc.gates.find((g) => g.state === "FREE");
          if (freeGate) {
            freeGate.state = "RESERVED";
            freeGate.reservedBy = planeIdx;
            reservedGateId = freeGate.id;
            taxiS = Math.max(0, freeGate.taxiS * 0.5);
          }
        }
      } else {
        state = "GATE_LOADING";
      }
    }

    let initX = sample.x;
    let initY = sample.y;
    let initAng = sample.ang;
    if (state === "GATE_LOADING" && chosenOriginGate) {
      initX = chosenOriginGate.worldX;
      initY = chosenOriginGate.worldY;
      initAng = chosenOriginGate.noseAngle;
    } else if (
      (state === "TAXI_TO_RUNWAY" || state === "HOLD_SHORT_QUEUE") &&
      originAtc
    ) {
      const wPos = taxiSpinePosToWorld(origin, taxiS);
      initX = wPos.x;
      initY = wPos.y;
      initAng = wPos.ang;
    } else if (state === "TAXI_TO_GATE" && destAtc) {
      const wPos = taxiSpinePosToWorld(dest, taxiS);
      initX = wPos.x;
      initY = wPos.y;
      initAng = wPos.ang;
    }

    const planeAgent = {
      id: planeIdx,
      state,
      gateId,
      reservedGateId,
      taxiS,
      targetTaxiS,
      pushbackTimer: 0,
      holdingPatternAngle: 0,
      pushbackOriginGateId: null,
      pushbackOriginS: null,
      origin,
      dest,
      track,
      dist,
      segIdx: sample.segIdx,
      phase: state === "GATE_LOADING" ? "GATE_DWELL" : sample.phase,
      altitude: sample.altitude,
      x: initX,
      y: initY,
      ang: initAng,
      speed: sample.speed,
      dwellTimer: 0,
      holdingShort: state === "HOLD_SHORT_QUEUE",
      isCargoFreighter,
      color: origin.palette?.roof || "#e65100",
      progress: Math.min(0.9999, dist / Math.max(0.001, track.totalLength)),
    };

    if (state === "TAXI_TO_RUNWAY" || state === "HOLD_SHORT_QUEUE") {
      if (originAtc) {
        originAtc.taxiwayOccupants.push(planeAgent);
        maintainTaxiwayOrder(originAtc);
        const wPos = taxiSpinePosToWorld(origin, planeAgent.taxiS ?? 0);
        planeAgent.x = wPos.x;
        planeAgent.y = wPos.y;
        planeAgent.ang = wPos.ang;
        if (state === "HOLD_SHORT_QUEUE") {
          originAtc.holdShortQueue.push(planeAgent);
        }
      }
    } else if (state === "TAXI_TO_GATE") {
      if (dest.atc) {
        dest.atc.taxiwayOccupants.push(planeAgent);
        maintainTaxiwayOrder(dest.atc);
        const wPos = taxiSpinePosToWorld(dest, planeAgent.taxiS ?? 0);
        planeAgent.x = wPos.x;
        planeAgent.y = wPos.y;
        planeAgent.ang = wPos.ang;
      }
    }

    this.planes.push(planeAgent);
  }

  /**
   * @param {number} dt
   * @param {number} simSpeed
   */
  update(dt, simSpeed) {
    if (simSpeed <= 0) return;
    const effDt = dt * simSpeed;
    this.simTime += effDt;

    // Update Cars along their directly modeled directed travel paths (`outboundTrack` / `inboundTrack`)
    for (const car of this.cars) {
      const track = car.returning ? car.inboundTrack : car.outboundTrack;
      if (!track || !track.pts || track.pts.length < 2) continue;
      const idx = Math.min(car.segIdx, track.pts.length - 2);
      const pt = track.pts[idx];
      const speedMult = pt.onMotorway
        ? SIM_CONFIG.VEHICLE_ROUTING.speedMultMotorway
        : pt.isStreet
          ? SIM_CONFIG.VEHICLE_ROUTING.speedMultStreet
          : SIM_CONFIG.VEHICLE_ROUTING.speedMultArterial;
      car.dist += car.speed * speedMult * effDt;

      while (
        car.segIdx < track.pts.length - 2 &&
        car.dist >= track.cumLen[car.segIdx + 1]
      ) {
        car.segIdx++;
      }

      if (car.dist >= track.totalLength) {
        car.dist = 0;
        car.segIdx = 0;
        car.returning = !car.returning;
        this.tripsCompleted++;
      }
    }

    // Pass 0: Normalize Plane State & Handle External Test Mutations
    for (let pIdx = 0; pIdx < this.planes.length; pIdx++) {
      const p = this.planes[pIdx];
      if (p.id === undefined) p.id = pIdx;
      if (p.pushbackTimer === undefined) p.pushbackTimer = 0;
      if (p.holdingPatternAngle === undefined) p.holdingPatternAngle = 0;
      if (p.pushbackOriginGateId === undefined) p.pushbackOriginGateId = null;
      if (p.pushbackOriginS === undefined) p.pushbackOriginS = null;
      if (p.gateId === undefined) p.gateId = null;
      if (p.reservedGateId === undefined) p.reservedGateId = null;
      if (p.taxiS === undefined) p.taxiS = 0;
      if (p.targetTaxiS === undefined) p.targetTaxiS = 0;

      // Initialize state from phase if undefined (e.g. synthetic test objects)
      if (!p.state) {
        if (p.phase === "GATE_DWELL") p.state = "GATE_LOADING";
        else if (p.phase === "TAXI_OUT") {
          p.state =
            p.dist >= p.track.holdShortDist - 0.25
              ? "HOLD_SHORT_QUEUE"
              : "TAXI_TO_RUNWAY";
        } else if (p.phase === "TAKEOFF") p.state = "TAKEOFF_ROLL";
        else if (p.phase === "CRUISE") p.state = "ENROUTE_CRUISE";
        else if (p.phase === "LANDING") p.state = "LANDING_ROLLOUT";
        else if (p.phase === "TAXI_IN") p.state = "TAXI_TO_GATE";
        else p.state = "GATE_LOADING";
      }

      // If external test modified p.dist away from gate while state was GATE_LOADING or PUSHBACK_HOLD:
      if (
        (p.state === "GATE_LOADING" || p.state === "PUSHBACK_HOLD") &&
        p.dist > 0.05
      ) {
        const s = sampleFlightTrack(p.track, p.dist);
        p.phase = s.phase;
        if (s.phase === "TAXI_OUT") {
          p.state =
            p.dist >= p.track.holdShortDist - 0.25
              ? "HOLD_SHORT_QUEUE"
              : "TAXI_TO_RUNWAY";
        } else if (s.phase === "TAKEOFF") {
          p.state = "TAKEOFF_ROLL";
        } else if (s.phase === "CRUISE") {
          p.state = "ENROUTE_CRUISE";
        } else if (s.phase === "LANDING") {
          p.state = "LANDING_ROLLOUT";
        } else if (s.phase === "TAXI_IN") {
          p.state = "TAXI_TO_GATE";
          const dAtc = p.dest.atc;
          if (dAtc && dAtc.gates.length > 0) {
            const g =
              dAtc.gates.find(
                (x) => x.state === "FREE" && x.occupiedBy === null,
              ) ?? dAtc.gates[0];
            p.reservedGateId = g.id;
            p.taxiS = Math.max(
              0,
              g.taxiS - Math.max(0, p.track.totalLength - p.dist),
            );
          }
        }
      }

      // External mutation check: test 5.4 step 2 planeArr.phase = "TAXI_IN"
      if (p.phase === "TAXI_IN" && p.state === "LANDING_ROLLOUT") {
        p.state = "TAXI_TO_GATE";
        const destAtc = p.dest.atc;
        if (destAtc) {
          if (destAtc.runwayBusyBy === p.id) destAtc.runwayBusyBy = null;
          if (destAtc.arrRunwayBusyBy === p.id) destAtc.arrRunwayBusyBy = null;
        }
      } else if (p.phase === "TAXI_OUT" && p.state === "GATE_LOADING") {
        p.state = "TAXI_TO_RUNWAY";
      } else if (
        p.phase === "GATE_DWELL" &&
        p.state !== "GATE_LOADING" &&
        p.state !== "PUSHBACK_HOLD"
      ) {
        p.state = "GATE_LOADING";
      }
    }

    // Pass 1: Airport ATC Queue Management across all airports
    for (const ap of this.world.airports) {
      const atc = ap.atc;
      if (!atc) continue;

      // 0. Reconcile gate occupancy: ensure gate holders are valid and actually at this airport's gate
      for (const gate of atc.gates) {
        if (gate.occupiedBy !== null) {
          const holder = this.planes.find((p) => p.id === gate.occupiedBy);
          if (
            !holder ||
            (holder.state !== "GATE_LOADING" &&
              holder.state !== "PUSHBACK_HOLD") ||
            holder.origin.id !== ap.id
          ) {
            gate.occupiedBy = null;
            gate.state = gate.reservedBy !== null ? "RESERVED" : "FREE";
          }
        }
      }

      // 1. Release runway locks if holding plane is no longer in roll
      if (atc.runwayBusyBy !== null) {
        const holder = this.planes.find((p) => p.id === atc.runwayBusyBy);
        if (
          !holder ||
          (holder.state !== "TAKEOFF_ROLL" &&
            holder.state !== "LANDING_ROLLOUT")
        ) {
          atc.runwayBusyBy = null;
        }
      }
      if (atc.depRunwayBusyBy !== null) {
        const holder = this.planes.find((p) => p.id === atc.depRunwayBusyBy);
        if (!holder || holder.state !== "TAKEOFF_ROLL") {
          atc.depRunwayBusyBy = null;
        }
      }
      if (atc.arrRunwayBusyBy !== null) {
        const holder = this.planes.find((p) => p.id === atc.arrRunwayBusyBy);
        if (!holder || holder.state !== "LANDING_ROLLOUT") {
          atc.arrRunwayBusyBy = null;
        }
      }
      if (atc.crossingBusyBy !== null) {
        const holder = this.planes.find((p) => p.id === atc.crossingBusyBy);
        const stillCrossing =
          holder &&
          (holder.state === "HOLD_CROSSING_RUNWAY" ||
            (holder.state === "TAXI_TO_GATE" && (holder.taxiS ?? 0) < 0));
        if (!stillCrossing) {
          atc.crossingBusyBy = null;
        }
      }

      // 2. Check pushbacks for planes at gates in PUSHBACK_HOLD
      for (const gate of atc.gates) {
        if (gate.state === "OCCUPIED" && gate.occupiedBy !== null) {
          const plane = this.planes.find((p) => p.id === gate.occupiedBy);
          if (plane && plane.state === "PUSHBACK_HOLD") {
            if (canPushBackOntoTaxiway(atc, gate.taxiS)) {
              plane.pushbackOriginGateId = gate.id;
              plane.pushbackOriginS = gate.taxiS;
              plane.taxiS = gate.taxiS;
              plane.targetTaxiS = atc.holdShortS;
              plane.speed = 0;
              plane.state = "TAXI_TO_RUNWAY";
              plane.phase = "TAXI_OUT";
              const wPos = taxiOccupantWorldPose(ap, plane);
              capturePoseResidual(plane, wPos.x, wPos.y, wPos.ang);
              releaseAllGatesForPlane(this.world, plane.id ?? 0);
              plane.gateId = null;
              plane.reservedGateId = null;
              if (!atc.taxiwayOccupants.includes(plane)) {
                atc.taxiwayOccupants.push(plane);
                maintainTaxiwayOrder(atc);
              }
            }
          }
        }
      }

      // 3. Runway crossing queue clearance (Hub & Taxiway Entry)
      // On Dual-Runway Hubs, landed outer-runway aircraft hold at the inner-runway intersection
      // until the inner departure runway has no active roll AND no aircraft holding short at the threshold.
      if (atc.crossingQueue.length > 0) {
        const depClear =
          atc.depRunwayBusyBy === null &&
          atc.crossingBusyBy === null &&
          atc.holdShortQueue.length === 0;
        const headCrosser = atc.crossingQueue[0];
        const startS = headCrosser?.taxiS ?? (atc.isHub ? -1.94 : -1.06);
        const entryClear = atc.taxiwayOccupants.every(
          (o) =>
            (o.taxiS ?? 0) - startS >= SIM_CONFIG.AVIATION.minTaxiSeparation,
        );
        if (depClear && entryClear) {
          const crosser = atc.crossingQueue.shift();
          if (crosser) {
            if (atc.isHub) {
              atc.crossingBusyBy = crosser.id ?? null;
            }
            crosser.taxiS = startS;
            const wPos = taxiSpinePosToWorld(ap, startS);
            capturePoseResidual(crosser, wPos.x, wPos.y, wPos.ang);
            if (!atc.taxiwayOccupants.includes(crosser)) {
              atc.taxiwayOccupants.push(crosser);
              maintainTaxiwayOrder(atc);
            }
            crosser.state = "TAXI_TO_GATE";
            crosser.phase = "TAXI_IN";
          }
        }
      }

      // 4. Approach queue cleanup (remove any plane no longer in APPROACH_QUEUE)
      for (let q = atc.approachQueue.length - 1; q >= 0; q--) {
        if (atc.approachQueue[q].state !== "APPROACH_QUEUE") {
          atc.approachQueue.splice(q, 1);
        }
      }

      // 5. Departure queue clearance (Hold-short)
      if (atc.holdShortQueue.length > 0) {
        const depClear = atc.isHub
          ? atc.depRunwayBusyBy === null && atc.crossingBusyBy === null
          : atc.runwayBusyBy === null;
        const departer = atc.holdShortQueue[0];
        const atHoldShort =
          departer && (departer.taxiS ?? 0) >= atc.holdShortS - 0.25;
        if (depClear && atHoldShort) {
          let arrivalInbound = false;
          if (!atc.isHub) {
            for (const other of this.planes) {
              if (other === departer) continue;
              if (other.dest && other.dest.id === ap.id) {
                let landingDist = other.track.totalLength;
                for (let i = 0; i < other.track.pts.length; i++) {
                  if (other.track.pts[i].phase === "LANDING") {
                    landingDist = other.track.cumLen[i];
                    break;
                  }
                }
                const distRemaining = landingDist - other.dist;
                const inCruiseApproach =
                  !atc.holdShortQueue.includes(departer) &&
                  other.phase === "CRUISE" &&
                  distRemaining <= SIM_CONFIG.AVIATION.holdShortLookaheadTiles;
                if (
                  other.phase === "LANDING" ||
                  other.state === "LANDING_ROLLOUT" ||
                  inCruiseApproach
                ) {
                  arrivalInbound = true;
                  break;
                }
              }
            }
          }

          if (!arrivalInbound) {
            atc.holdShortQueue.shift();
            const occIdx = atc.taxiwayOccupants.indexOf(departer);
            if (occIdx !== -1) atc.taxiwayOccupants.splice(occIdx, 1);

            if (atc.isHub) {
              atc.depRunwayBusyBy = departer.id ?? null;
            } else {
              atc.runwayBusyBy = departer.id ?? null;
            }
            atc.lastOp = "DEPARTURE";
            departer.holdingShort = false;
            departer.dist = departer.track.holdShortDist;
            const sHold = sampleFlightTrack(departer.track, departer.dist);
            capturePoseResidual(departer, sHold.x, sHold.y, sHold.ang);
            departer.state = "TAKEOFF_ROLL";
            departer.phase = "TAKEOFF";
          }
        }
      }

      // Maintain taxiway order & separation
      maintainTaxiwayOrder(atc);
    }

    // Pass 2: Agent Physics & FSM State Updates
    for (let pIdx = 0; pIdx < this.planes.length; pIdx++) {
      const p = this.planes[pIdx];

      switch (p.state) {
        case "GATE_LOADING": {
          p.altitude = 0;
          p.speed = 0;
          p.progress = 0.999;
          p.phase = "GATE_DWELL";
          p.dwellTimer += effDt;

          const planeId = p.id ?? pIdx;
          const atc = p.origin.atc;
          if (atc && p.gateId === null) {
            releaseAllGatesForPlane(this.world, planeId);
            const freeGate = atc.gates.find(
              (g) => g.state === "FREE" && g.occupiedBy === null,
            );
            if (freeGate) {
              freeGate.state = "OCCUPIED";
              freeGate.occupiedBy = planeId;
              p.gateId = freeGate.id;
            }
          }
          if (atc && p.gateId !== null) {
            const g = atc.gates.find((x) => x.id === p.gateId);
            if (g) {
              p.x = g.worldX;
              p.y = g.worldY;
              applySmoothedPose(p, g.worldX, g.worldY, g.noseAngle, effDt);
            }
          }

          if (p.dwellTimer >= SIM_CONFIG.AVIATION.gateDwellSec) {
            this.tripsCompleted += SIM_CONFIG.FLEET.flightTripWeight;
            if (p.dest && p.dest.id !== undefined && p.gateId === null) {
              p.origin = p.dest;
            }
            /** @type {Airport | PlaneEndpoint | null} */
            let nextDest = null;
            if (this.world.airports.length > 1) {
              const others = this.world.airports.filter(
                (a) => a.id !== p.origin.id,
              );
              nextDest = others[Math.floor(this.rng.next() * others.length)];
            } else {
              const ang = p.origin.angleRad ?? 0;
              nextDest = {
                x: p.origin.x + Math.cos(ang + 0.35) * 95,
                y: p.origin.y + Math.sin(ang + 0.35) * 95,
                angleRad: ang,
                halfLen: 6,
              };
            }
            if (nextDest) {
              p.dest = nextDest;
              p.isCargoFreighter = Boolean(
                p.origin.airportClass === "CRG" ||
                p.dest.airportClass === "CRG" ||
                (p.origin.isHub && p.dest.isHub && pIdx % 3 === 2),
              );

              const newAtc = p.origin.atc;
              const curGate = newAtc
                ? newAtc.gates.find((g) => g.occupiedBy === planeId) ||
                  newAtc.gates.find(
                    (g) => g.state === "FREE" && g.occupiedBy === null,
                  ) ||
                  null
                : null;
              const destGate =
                p.dest.atc && p.dest.atc.gates.length > 0
                  ? (p.dest.atc.gates.find(
                      (g) =>
                        g.state === "FREE" &&
                        g.occupiedBy === null &&
                        g.reservedBy === null,
                    ) ?? p.dest.atc.gates[pIdx % p.dest.atc.gates.length])
                  : null;

              p.track = buildFlightTrack(p.origin, p.dest, {
                isCargoFreighter: p.isCargoFreighter,
                gateIndex: pIdx,
                gateLx: curGate?.lx,
                destGateLx: destGate?.lx,
                oSign: p.origin.activeSign,
                dSign: p.dest.activeSign,
              });
              p.dist = 0;
              p.segIdx = 0;
              p.dwellTimer = 0;
              p.progress = 0;
              p.holdingShort = false;
              const sample = sampleFlightTrack(p.track, 0);
              p.x = curGate ? curGate.worldX : sample.x;
              p.y = curGate ? curGate.worldY : sample.y;
              p.ang = curGate ? curGate.noseAngle : sample.ang;
              p.altitude = sample.altitude;
              p.speed = sample.speed;

              if (newAtc && curGate) {
                releaseAllGatesForPlane(this.world, planeId);
                curGate.state = "OCCUPIED";
                curGate.occupiedBy = planeId;
                p.gateId = curGate.id;
                p.taxiS = curGate.taxiS;
                p.targetTaxiS = newAtc.holdShortS;
                p.state = "PUSHBACK_HOLD";
                p.phase = "TAXI_OUT";
              } else {
                releaseAllGatesForPlane(this.world, planeId);
                p.state = "TAXI_TO_RUNWAY";
                p.phase = "TAXI_OUT";
              }
            }
          }
          break;
        }

        case "PUSHBACK_HOLD": {
          p.altitude = 0;
          p.speed = 0;
          p.phase = "TAXI_OUT";
          p.pushbackTimer = (p.pushbackTimer ?? 0) + effDt;
          const atc = p.origin.atc;
          if (atc && p.gateId !== null) {
            const g = atc.gates.find((x) => x.id === p.gateId);
            if (g) {
              p._resX = 0;
              p._resY = 0;
              p._resAng = 0;
              p.x = g.worldX;
              p.y = g.worldY;
              p.ang = g.noseAngle;
            }
          }
          if (!atc) {
            p.state = "TAXI_TO_RUNWAY";
            p.phase = "TAXI_OUT";
          }
          break;
        }

        case "TAXI_TO_RUNWAY": {
          p.phase = "TAXI_OUT";
          p.altitude = 0;
          const maxTaxiSpeed = SIM_CONFIG.AVIATION.taxiSpeed;
          const atc = p.origin.atc;

          if (atc) {
            if (!atc.taxiwayOccupants.includes(p)) {
              if ((p.taxiS ?? 0) === 0 && p.dist > 0) {
                p.taxiS =
                  (p.dist / Math.max(0.01, p.track.holdShortDist)) *
                  atc.holdShortS;
              }
              atc.taxiwayOccupants.push(p);
            }
            maintainTaxiwayOrder(atc);
            const occIdx = atc.taxiwayOccupants.indexOf(p);
            const maxAllowedS =
              occIdx > 0
                ? (atc.taxiwayOccupants[occIdx - 1].taxiS ?? 0) -
                  SIM_CONFIG.AVIATION.minTaxiSeparation
                : atc.holdShortS;

            const gap = Math.max(0, maxAllowedS - (p.taxiS ?? 0));
            const desiredSpeed =
              occIdx > 0 ? maxTaxiSpeed * Math.min(1, gap / 1.4) : maxTaxiSpeed;
            const accel = 6.5;
            p.speed = Math.max(
              0,
              Math.min(
                maxTaxiSpeed,
                (p.speed || maxTaxiSpeed * 0.4) +
                  Math.max(
                    -accel * effDt,
                    Math.min(accel * effDt, desiredSpeed - (p.speed || 0)),
                  ),
              ),
            );
            const step = p.speed * effDt;

            // Single-runway arrival inbound check at the hold-short line
            let arrivalInbound = false;
            if (
              !p.origin.isHub &&
              (p.taxiS ?? 0) + step >= atc.holdShortS - 0.25
            ) {
              for (let oIdx = 0; oIdx < this.planes.length; oIdx++) {
                if (oIdx === pIdx) continue;
                const other = this.planes[oIdx];
                if (
                  other.dest &&
                  other.dest.id !== undefined &&
                  p.origin.id !== undefined &&
                  other.dest.id === p.origin.id
                ) {
                  let landingDist = other.track.totalLength;
                  for (let i = 0; i < other.track.pts.length; i++) {
                    if (other.track.pts[i].phase === "LANDING") {
                      landingDist = other.track.cumLen[i];
                      break;
                    }
                  }
                  const distRemaining = landingDist - other.dist;
                  const inCruiseApproach =
                    (!atc || !atc.holdShortQueue.includes(p)) &&
                    other.phase === "CRUISE" &&
                    distRemaining <=
                      SIM_CONFIG.AVIATION.holdShortLookaheadTiles;
                  if (
                    other.phase === "LANDING" ||
                    other.state === "LANDING_ROLLOUT" ||
                    inCruiseApproach
                  ) {
                    arrivalInbound = true;
                    break;
                  }
                }
              }
            }

            p.taxiS = Math.min(maxAllowedS, (p.taxiS ?? 0) + step);
            p.dist =
              (Math.max(0, p.taxiS) / Math.max(0.01, atc.holdShortS)) *
              p.track.holdShortDist;

            if (p.taxiS >= atc.holdShortS - 0.1 || arrivalInbound) {
              if (p.taxiS >= atc.holdShortS - 0.1) {
                p.taxiS = Math.min(maxAllowedS, atc.holdShortS);
              }
              p.dist = Math.min(p.dist, p.track.holdShortDist);
              p.holdingShort = true;
              p.state = "HOLD_SHORT_QUEUE";
              if (!atc.holdShortQueue.includes(p)) {
                atc.holdShortQueue.push(p);
              }
            } else {
              p.holdingShort = false;
            }

            const wPos = taxiOccupantWorldPose(p.origin, p);
            applySmoothedPose(p, wPos.x, wPos.y, wPos.ang, effDt);
            const sample = sampleFlightTrack(p.track, p.dist);
            p.segIdx = sample.segIdx;
            p.progress = Math.min(
              0.9999,
              p.dist / Math.max(0.001, p.track.totalLength),
            );
          } else {
            const step = maxTaxiSpeed * effDt;
            p.speed = maxTaxiSpeed;
            if (p.dist + step >= p.track.holdShortDist - 0.25) {
              p.dist = Math.min(p.dist, p.track.holdShortDist);
              p.state = "HOLD_SHORT_QUEUE";
            } else {
              p.dist += step;
            }
            const sample = sampleFlightTrack(p.track, p.dist);
            applySmoothedPose(p, sample.x, sample.y, sample.ang, effDt);
            p.segIdx = sample.segIdx;
            p.progress = Math.min(
              0.9999,
              p.dist / Math.max(0.001, p.track.totalLength),
            );
          }
          break;
        }

        case "HOLD_SHORT_QUEUE": {
          p.phase = "TAXI_OUT";
          p.altitude = 0;
          p.speed = 0;
          p.holdingShort = true;
          p.dist = Math.min(p.dist, p.track.holdShortDist);

          const atc = p.origin.atc;
          let occIdx = -1;
          if (atc) {
            if (!atc.taxiwayOccupants.includes(p)) {
              if ((p.taxiS ?? 0) === 0) p.taxiS = atc.holdShortS;
              atc.taxiwayOccupants.push(p);
            }
            if (!atc.holdShortQueue.includes(p)) {
              atc.holdShortQueue.push(p);
            }
            maintainTaxiwayOrder(atc);
            occIdx = atc.taxiwayOccupants.indexOf(p);
            const maxAllowedS =
              occIdx > 0
                ? (atc.taxiwayOccupants[occIdx - 1].taxiS ?? 0) -
                  SIM_CONFIG.AVIATION.minTaxiSeparation
                : atc.holdShortS;
            p.taxiS = Math.min(
              maxAllowedS,
              (p.taxiS ?? 0) + SIM_CONFIG.AVIATION.taxiSpeed * effDt,
            );
            p.dist =
              (Math.max(0, p.taxiS) / Math.max(0.01, atc.holdShortS)) *
              p.track.holdShortDist;
          }

          // Inbound arrival check (for mock / test compatibility)
          let arrivalInbound = false;
          if (!p.origin.isHub) {
            for (let oIdx = 0; oIdx < this.planes.length; oIdx++) {
              if (oIdx === pIdx) continue;
              const other = this.planes[oIdx];
              if (
                other.dest &&
                other.dest.id !== undefined &&
                p.origin.id !== undefined &&
                other.dest.id === p.origin.id
              ) {
                let landingDist = other.track.totalLength;
                for (let i = 0; i < other.track.pts.length; i++) {
                  if (other.track.pts[i].phase === "LANDING") {
                    landingDist = other.track.cumLen[i];
                    break;
                  }
                }
                const distRemaining = landingDist - other.dist;
                const inCruiseApproach =
                  (!atc || !atc.holdShortQueue.includes(p)) &&
                  other.phase === "CRUISE" &&
                  distRemaining <= SIM_CONFIG.AVIATION.holdShortLookaheadTiles;
                if (
                  other.phase === "LANDING" ||
                  other.state === "LANDING_ROLLOUT" ||
                  inCruiseApproach
                ) {
                  arrivalInbound = true;
                  break;
                }
              }
            }
          }

          const isHeadOfLine =
            !atc || (occIdx === 0 && (p.taxiS ?? 0) >= atc.holdShortS - 0.25);

          if (!arrivalInbound && isHeadOfLine) {
            const rwyClear = atc
              ? atc.isHub
                ? atc.depRunwayBusyBy === null && atc.crossingBusyBy === null
                : atc.runwayBusyBy === null
              : true;
            if (rwyClear) {
              if (atc) {
                if (atc.isHub) atc.depRunwayBusyBy = p.id ?? null;
                else atc.runwayBusyBy = p.id ?? null;
                atc.lastOp = "DEPARTURE";
                const qIdx = atc.holdShortQueue.indexOf(p);
                if (qIdx !== -1) atc.holdShortQueue.splice(qIdx, 1);
                const oIdx = atc.taxiwayOccupants.indexOf(p);
                if (oIdx !== -1) atc.taxiwayOccupants.splice(oIdx, 1);
              }
              p.holdingShort = false;
              p.state = "TAKEOFF_ROLL";
              p.phase = "TAKEOFF";
              p.dist = p.track.holdShortDist;
              const curSample = sampleFlightTrack(p.track, p.dist);
              capturePoseResidual(p, curSample.x, curSample.y, curSample.ang);
              p.speed = curSample.speed;
              p.dist += p.speed * effDt;
              const sample = sampleFlightTrack(p.track, p.dist);
              applySmoothedPose(p, sample.x, sample.y, sample.ang, effDt);
              p.speed = sample.speed;
              p.segIdx = sample.segIdx;
              p.progress = Math.min(
                0.9999,
                p.dist / Math.max(0.001, p.track.totalLength),
              );
              break;
            }
          }

          if (atc) {
            const wPos = taxiOccupantWorldPose(p.origin, p);
            applySmoothedPose(p, wPos.x, wPos.y, wPos.ang, effDt);
          } else {
            const sample = sampleFlightTrack(p.track, p.dist);
            applySmoothedPose(p, sample.x, sample.y, sample.ang, effDt);
          }
          p.speed = 0;
          p.progress = Math.min(
            0.9999,
            p.dist / Math.max(0.001, p.track.totalLength),
          );
          break;
        }

        case "TAKEOFF_ROLL": {
          p.phase = "TAKEOFF";
          p.holdingShort = false;
          const curSample = sampleFlightTrack(p.track, p.dist);
          p.speed = curSample.speed;
          p.dist += p.speed * effDt;

          const sample = sampleFlightTrack(p.track, p.dist);
          applySmoothedPose(p, sample.x, sample.y, sample.ang, effDt);
          p.altitude = sample.altitude;
          p.speed = sample.speed;
          p.segIdx = sample.segIdx;
          p.progress = Math.min(
            0.9999,
            p.dist / Math.max(0.001, p.track.totalLength),
          );

          if (
            sample.phase === "CRUISE" ||
            p.altitude >= SIM_CONFIG.AVIATION.climbOutAlt * 0.95
          ) {
            const atc = p.origin.atc;
            if (atc) {
              if (atc.runwayBusyBy === p.id) atc.runwayBusyBy = null;
              if (atc.depRunwayBusyBy === p.id) atc.depRunwayBusyBy = null;
            }
            p.state = "ENROUTE_CRUISE";
            p.phase = "CRUISE";
          }
          break;
        }

        case "ENROUTE_CRUISE": {
          p.phase = "CRUISE";
          p.speed = SIM_CONFIG.AVIATION.cruiseSpeed;
          p.dist += p.speed * effDt;

          const sample = sampleFlightTrack(p.track, p.dist);
          applySmoothedPose(p, sample.x, sample.y, sample.ang, effDt);
          p.altitude = sample.altitude;
          p.segIdx = sample.segIdx;
          p.progress = Math.min(
            0.9999,
            p.dist / Math.max(0.001, p.track.totalLength),
          );

          if (sample.phase === "LANDING") {
            const destAtc = p.dest.atc;
            // Never permit a single-runway landing while a departure is holding short at the runway threshold
            const rwyClear =
              !destAtc ||
              (destAtc.isHub
                ? destAtc.arrRunwayBusyBy === null
                : destAtc.runwayBusyBy === null &&
                  destAtc.holdShortQueue.length === 0);
            if (rwyClear) {
              if (destAtc) {
                if (destAtc.isHub) destAtc.arrRunwayBusyBy = p.id ?? null;
                else destAtc.runwayBusyBy = p.id ?? null;
                destAtc.lastOp = "ARRIVAL";
              }
              p.state = "LANDING_ROLLOUT";
              p.phase = "LANDING";
            } else {
              p.state = "APPROACH_QUEUE";
              p.phase = "CRUISE";
              p.holdingPatternAngle = 0;
              if (destAtc && !destAtc.approachQueue.includes(p)) {
                destAtc.approachQueue.push(p);
              }
            }
          }
          break;
        }

        case "APPROACH_QUEUE": {
          p.phase = "CRUISE";
          const sample = sampleFlightTrack(p.track, p.dist);
          const destAtc = p.dest.atc;
          const qIdx = destAtc
            ? Math.max(0, destAtc.approachQueue.indexOf(p))
            : 0;
          if (p._holdRAlong === undefined || p._holdRCross === undefined) {
            p._holdRAlong = 5.2 + qIdx * 1.2;
            p._holdRCross = 3.2 + qIdx * 0.9;
          }
          const rAlong = p._holdRAlong;
          const rCross = p._holdRCross;
          const holdSpeed = SIM_CONFIG.AVIATION.landingSpeed * 0.85;
          const prevTheta = p.holdingPatternAngle ?? 0;
          const ds0 = Math.max(
            1.0,
            Math.hypot(
              rAlong * Math.cos(prevTheta),
              rCross * Math.sin(prevTheta),
            ),
          );
          const midTheta = prevTheta + (0.5 * holdSpeed * effDt) / ds0;
          const dsMid = Math.max(
            1.0,
            Math.hypot(
              rAlong * Math.cos(midTheta),
              rCross * Math.sin(midTheta),
            ),
          );
          const theta = prevTheta + (holdSpeed * effDt) / dsMid;
          const nextTurn =
            prevTheta > 0
              ? Math.ceil(prevTheta / (Math.PI * 2)) * (Math.PI * 2)
              : Math.PI * 2;

          // If the aircraft completes its holding orbit back to the approach fix (theta crosses 2*PI*k)
          // and is head-of-line with a clear arrival runway (and no single-runway hold-short departure), roll out onto final!
          if (prevTheta > 0 && theta >= nextTurn && qIdx === 0) {
            const arrClear =
              !destAtc ||
              (destAtc.isHub
                ? destAtc.arrRunwayBusyBy === null
                : destAtc.runwayBusyBy === null &&
                  destAtc.holdShortQueue.length === 0);
            let sepOk = arrClear;
            if (sepOk && destAtc) {
              for (const other of this.planes) {
                if (other === p) continue;
                if (
                  other.dest &&
                  other.dest.id === p.dest.id &&
                  other.state === "LANDING_ROLLOUT" &&
                  Math.abs(other.dist - p.dist) <
                    SIM_CONFIG.AVIATION.minAirborneSeparation
                ) {
                  sepOk = false;
                  break;
                }
              }
            }
            if (sepOk) {
              if (destAtc) {
                const idx = destAtc.approachQueue.indexOf(p);
                if (idx !== -1) destAtc.approachQueue.splice(idx, 1);
                if (destAtc.isHub) destAtc.arrRunwayBusyBy = p.id ?? null;
                else destAtc.runwayBusyBy = p.id ?? null;
                destAtc.lastOp = "ARRIVAL";
              }
              const remDist = Math.max(0, (theta - nextTurn) * rAlong);
              p._holdRAlong = undefined;
              p._holdRCross = undefined;
              p.holdingPatternAngle = 0;
              p.state = "LANDING_ROLLOUT";
              p.phase = "LANDING";
              p.dist += remDist;
              const sLand = sampleFlightTrack(p.track, p.dist);
              p._resX = 0;
              p._resY = 0;
              p._resAng = 0;
              p.x = sLand.x;
              p.y = sLand.y;
              p.ang = sLand.ang;
              p.altitude = sLand.altitude;
              p.speed = sLand.speed;
              p.segIdx = sLand.segIdx;
              p.progress = Math.min(
                0.9999,
                p.dist / Math.max(0.001, p.track.totalLength),
              );
              break;
            }
          }

          p.holdingPatternAngle = theta;
          p.speed = holdSpeed;

          const ux = Math.cos(sample.ang);
          const uy = Math.sin(sample.ang);
          const turnSign = -(p.dest.apronSide || 1);
          const nx = -uy * turnSign;
          const ny = ux * turnSign;
          const uOff = rAlong * Math.sin(theta);
          const vOff = rCross * (1 - Math.cos(theta));

          const hx = sample.x + uOff * ux + vOff * nx;
          const hy = sample.y + uOff * uy + vOff * ny;
          const vx =
            rAlong * Math.cos(theta) * ux + rCross * Math.sin(theta) * nx;
          const vy =
            rAlong * Math.cos(theta) * uy + rCross * Math.sin(theta) * ny;
          const hang = Math.atan2(vy, vx);
          applySmoothedPose(p, hx, hy, hang, effDt);
          p.altitude = Math.max(
            SIM_CONFIG.AVIATION.climbOutAlt,
            sample.altitude,
          );
          p.segIdx = sample.segIdx;
          p.progress = Math.min(
            0.9999,
            p.dist / Math.max(0.001, p.track.totalLength),
          );
          break;
        }

        case "LANDING_ROLLOUT": {
          p.phase = "LANDING";
          const curSample = sampleFlightTrack(p.track, p.dist);
          p.speed = curSample.speed;
          p.dist += p.speed * effDt;

          const sample = sampleFlightTrack(p.track, p.dist);
          applySmoothedPose(p, sample.x, sample.y, sample.ang, effDt);
          p.altitude = sample.altitude;
          p.speed = sample.speed;
          p.segIdx = sample.segIdx;
          p.progress = Math.min(
            0.9999,
            p.dist / Math.max(0.001, p.track.totalLength),
          );

          // Roll all the way to the high-speed exit turnoff (sample.phase === "TAXI_IN")
          if (sample.phase === "TAXI_IN") {
            const destAtc = p.dest.atc;
            const planeId = p.id ?? pIdx;
            if (destAtc) {
              if (destAtc.runwayBusyBy === p.id) destAtc.runwayBusyBy = null;
              if (destAtc.arrRunwayBusyBy === p.id)
                destAtc.arrRunwayBusyBy = null;
              if (p.reservedGateId === null) {
                const freeGate = destAtc.gates.find(
                  (g) =>
                    g.state === "FREE" &&
                    g.occupiedBy === null &&
                    g.reservedBy === null,
                );
                if (freeGate) {
                  freeGate.state = "RESERVED";
                  freeGate.reservedBy = planeId;
                  p.reservedGateId = freeGate.id;
                  p.targetTaxiS = freeGate.taxiS;
                }
              }
            }
            const crossSpan = destAtc ? (destAtc.isHub ? 2.75 : 1.06) : 1.06;
            const entryClear = destAtc
              ? destAtc.taxiwayOccupants.every(
                  (o) =>
                    (o.taxiS ?? 0) - -crossSpan >=
                    SIM_CONFIG.AVIATION.minTaxiSeparation,
                )
              : true;
            if (destAtc && (destAtc.isHub || !entryClear)) {
              p.state = "HOLD_CROSSING_RUNWAY";
              p.phase = "TAXI_IN";
              if (!destAtc.crossingQueue.includes(p)) {
                destAtc.crossingQueue.push(p);
              }
              p.taxiS = -crossSpan;
              const wPos = taxiSpinePosToWorld(p.dest, p.taxiS);
              capturePoseResidual(p, wPos.x, wPos.y, wPos.ang);
              applySmoothedPose(p, wPos.x, wPos.y, wPos.ang, effDt);
            } else {
              p.state = "TAXI_TO_GATE";
              p.phase = "TAXI_IN";
              p.taxiS = destAtc ? -crossSpan : 0;
              if (destAtc) {
                if (!destAtc.taxiwayOccupants.includes(p)) {
                  destAtc.taxiwayOccupants.push(p);
                  maintainTaxiwayOrder(destAtc);
                }
                const wPos = taxiOccupantWorldPose(p.dest, p);
                capturePoseResidual(p, wPos.x, wPos.y, wPos.ang);
                applySmoothedPose(p, wPos.x, wPos.y, wPos.ang, effDt);
              }
            }
          }
          break;
        }

        case "HOLD_CROSSING_RUNWAY": {
          p.phase = "TAXI_IN";
          p.altitude = 0;
          const destAtc = p.dest.atc;
          if (!destAtc) {
            p.speed = 0;
            p.state = "TAXI_TO_GATE";
            p.phase = "TAXI_IN";
            const sample = sampleFlightTrack(p.track, p.dist);
            applySmoothedPose(p, sample.x, sample.y, sample.ang, effDt);
            p.segIdx = sample.segIdx;
          } else {
            const qIdx = Math.max(0, destAtc.crossingQueue.indexOf(p));
            const holdTargetS =
              (destAtc.isHub ? -1.94 : -1.06) -
              qIdx * SIM_CONFIG.AVIATION.minTaxiSeparation;
            const curS = p.taxiS ?? (destAtc.isHub ? -2.75 : -1.06);
            const maxStep = SIM_CONFIG.AVIATION.taxiSpeed * effDt;
            if (curS < holdTargetS - 1e-4) {
              p.taxiS = Math.min(holdTargetS, curS + maxStep);
              p.speed = SIM_CONFIG.AVIATION.taxiSpeed;
            } else if (curS > holdTargetS + 1e-4) {
              p.taxiS = Math.max(holdTargetS, curS - maxStep);
              p.speed = SIM_CONFIG.AVIATION.taxiSpeed;
            } else {
              p.taxiS = holdTargetS;
              p.speed = 0;
            }
            const wPos = taxiSpinePosToWorld(p.dest, p.taxiS);
            applySmoothedPose(p, wPos.x, wPos.y, wPos.ang, effDt);
          }
          p.progress = Math.min(
            0.9999,
            p.dist / Math.max(0.001, p.track.totalLength),
          );
          break;
        }

        case "TAXI_TO_GATE": {
          p.phase = "TAXI_IN";
          p.altitude = 0;
          const maxTaxiSpeed = SIM_CONFIG.AVIATION.taxiSpeed;
          const destAtc = p.dest.atc;
          const planeId = p.id ?? pIdx;

          if (destAtc) {
            if (!destAtc.taxiwayOccupants.includes(p)) {
              destAtc.taxiwayOccupants.push(p);
            }
            maintainTaxiwayOrder(destAtc);

            let gate = destAtc.gates.find(
              (g) =>
                g.id === p.reservedGateId &&
                (g.reservedBy === planeId || g.occupiedBy === null),
            );
            if (!gate) {
              const freeGate = destAtc.gates.find(
                (g) =>
                  g.state === "FREE" &&
                  g.occupiedBy === null &&
                  g.reservedBy === null,
              );
              if (freeGate) {
                freeGate.state = "RESERVED";
                freeGate.reservedBy = planeId;
                p.reservedGateId = freeGate.id;
                gate = freeGate;
              }
            }

            const occIdx = destAtc.taxiwayOccupants.indexOf(p);
            const maxAllowedS =
              occIdx > 0
                ? (destAtc.taxiwayOccupants[occIdx - 1].taxiS ?? 0) -
                  SIM_CONFIG.AVIATION.minTaxiSeparation
                : destAtc.holdShortS;
            const targetS = gate ? gate.taxiS : destAtc.preGateHoldS;
            p.targetTaxiS = targetS;
            const limitS = Math.min(maxAllowedS, targetS);
            const gap = Math.max(0, limitS - (p.taxiS ?? 0));
            const desiredSpeed =
              !gate || occIdx > 0
                ? maxTaxiSpeed * Math.min(1, gap / 1.4)
                : maxTaxiSpeed;
            const accel = 6.5;
            p.speed = Math.max(
              0,
              Math.min(
                maxTaxiSpeed,
                (p.speed || maxTaxiSpeed * 0.4) +
                  Math.max(
                    -accel * effDt,
                    Math.min(accel * effDt, desiredSpeed - (p.speed || 0)),
                  ),
              ),
            );
            const step = p.speed * effDt;
            p.taxiS = Math.min(limitS, (p.taxiS ?? 0) + step);
            const notBlockedByLeader =
              occIdx === 0 || (p.taxiS ?? 0) < maxAllowedS - 0.05;
            if (notBlockedByLeader && gate) {
              p.dist += step;
            }

            if (gate && p.taxiS >= gate.taxiS - 0.08) {
              const idx = destAtc.taxiwayOccupants.indexOf(p);
              if (idx !== -1) destAtc.taxiwayOccupants.splice(idx, 1);
              releaseAllGatesForPlane(this.world, planeId);
              gate.state = "OCCUPIED";
              gate.occupiedBy = planeId;
              gate.reservedBy = null;
              p.gateId = gate.id;
              p.reservedGateId = null;
              if (p.dest.id !== undefined) {
                p.origin = p.dest;
              }
              p.dist = p.track.totalLength;
              p.phase = "GATE_DWELL";
              p.state = "GATE_LOADING";
              p.altitude = 0;
              p.speed = 0;
              p.progress = 0.999;
              p.dwellTimer = 0;
              p._resX = 0;
              p._resY = 0;
              p.x = gate.worldX;
              p.y = gate.worldY;
              applySmoothedPose(
                p,
                gate.worldX,
                gate.worldY,
                gate.noseAngle,
                effDt,
              );
              continue;
            }

            const wPos = taxiOccupantWorldPose(p.dest, p);
            applySmoothedPose(p, wPos.x, wPos.y, wPos.ang, effDt);
            p.progress = Math.min(
              0.9999,
              p.dist / Math.max(0.001, p.track.totalLength),
            );
          } else {
            const step = maxTaxiSpeed * effDt;
            p.speed = maxTaxiSpeed;
            p.dist += step;
            if (p.dist >= p.track.totalLength) {
              p.dist = p.track.totalLength;
              p.phase = "GATE_DWELL";
              p.state = "GATE_LOADING";
              p.altitude = 0;
              p.progress = 0.999;
              p.dwellTimer = 0;
              releaseAllGatesForPlane(this.world, planeId);
              if (p.dest.id !== undefined) {
                p.origin = p.dest;
              }
              const sample = sampleFlightTrack(p.track, p.dist);
              applySmoothedPose(p, sample.x, sample.y, sample.ang, effDt);
              p.speed = sample.speed;
              p.segIdx = sample.segIdx;
              continue;
            }
            const sample = sampleFlightTrack(p.track, p.dist);
            applySmoothedPose(p, sample.x, sample.y, sample.ang, effDt);
            p.speed = sample.speed;
            p.segIdx = sample.segIdx;
            p.progress = Math.min(
              0.9999,
              p.dist / Math.max(0.001, p.track.totalLength),
            );
          }
          break;
        }
      }
    }

    // Post-Pass: Enforce 1D leader-follower non-overtaking spacing & world coordinates across all airports
    for (const ap of this.world.airports) {
      if (ap.atc) {
        maintainTaxiwayOrder(ap.atc);
        for (const occ of ap.atc.taxiwayOccupants) {
          const wPos = taxiOccupantWorldPose(ap, occ);
          occ.x = wPos.x + (occ._resX ?? 0);
          occ.y = wPos.y + (occ._resY ?? 0);
          if (effDt > 0.08) {
            occ.ang = wPos.ang + (occ._resAng ?? 0);
          }
        }
      }
    }
  }
}
