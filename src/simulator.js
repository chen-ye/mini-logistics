/** @import { AircraftType, Airport, AirportATC, CarAgent, FlightPhase, FlightTrack, FlightTrackPoint, GateSlot, PlaneAgent, PlaneEndpoint, PlaneFSMState } from './types.js' */
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
 * Transforms world coordinates (wx, wy) to local runway-aligned coordinates (lx, ly) around ap.
 * @param {Airport | PlaneEndpoint} ap
 * @param {number} wx
 * @param {number} wy
 * @returns {{ lx: number, ly: number }}
 */
function toLocal(ap, wx, wy) {
  const ang = ap.angleRad ?? 0;
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
 * Moves a scalar value toward target by at most maxDelta.
 * @param {number} cur
 * @param {number} target
 * @param {number} maxDelta
 * @returns {number}
 */
function moveTowards(cur, target, maxDelta) {
  if (Math.abs(target - cur) <= maxDelta) return target;
  return cur + Math.sign(target - cur) * maxDelta;
}

/**
 * Computes an overdamped kinematic stopping speed profile for remaining distance dRem to a full stop.
 * @param {number} dRem
 * @param {number} currentSpeed
 * @param {number} maxSpeed
 * @param {number} aBrake
 * @returns {number}
 */
function computeStopEnvelopeSpeed(dRem, currentSpeed, maxSpeed, aBrake) {
  const kp = 1.65;
  const dKnee = aBrake / (2 * kp * kp);
  const dEff = Math.max(0, dRem - 0.035 * currentSpeed);
  const vStop =
    dEff <= 2 * dKnee ? kp * dEff : Math.sqrt(2 * aBrake * (dEff - dKnee));
  return Math.min(maxSpeed, Math.max(0, vStop));
}

/**
 * Jerk-bounded longitudinal speed and acceleration integrator.
 * @param {PlaneAgent} p
 * @param {number} targetSpeed
 * @param {number} maxAccel
 * @param {number} maxDecel
 * @param {number} maxJerk
 * @param {number} effDt
 * @param {number} [tau=0.22]
 * @param {number | null} [kinematicFloorAccel=null]
 * @param {boolean} [flareToZero=false]
 */
function stepLongitudinalSpeed(
  p,
  targetSpeed,
  maxAccel,
  maxDecel,
  maxJerk,
  effDt,
  tau = 0.22,
  kinematicFloorAccel = null,
  flareToZero = false,
) {
  const curSpeed = p.speed ?? 0;
  let aCmd = (targetSpeed - curSpeed) / tau;
  if (kinematicFloorAccel !== null) {
    aCmd = Math.min(aCmd, kinematicFloorAccel);
  }
  if (flareToZero) {
    const maxFlare = Math.sqrt(2 * (maxJerk * 0.85) * Math.max(0, curSpeed));
    aCmd = Math.max(-Math.min(maxDecel, maxFlare), Math.min(maxAccel, aCmd));
  } else {
    aCmd = Math.max(-maxDecel, Math.min(maxAccel, aCmd));
  }
  const nextAccel = moveTowards(p.accel ?? 0, aCmd, maxJerk * effDt);
  if (curSpeed + nextAccel * effDt <= 0) {
    p.accel = -curSpeed / effDt;
    p.speed = 0;
  } else {
    p.accel = nextAccel;
    p.speed = curSpeed + nextAccel * effDt;
  }
}

/**
 * Non-holonomic pure-pursuit wheel-rolling / flight carrot integrator.
 * Guarantees hypot(dx, dy)/effDt === p.speed, zero ground sideslip, and zero turntable spin when stopped.
 * @param {PlaneAgent} p
 * @param {number} carrotX
 * @param {number} carrotY
 * @param {number} effDt
 * @param {number} [maxKappa=2.6]
 * @param {number} [maxKappaRate=5.5]
 */
function stepGroundCarrot(
  p,
  carrotX,
  carrotY,
  effDt,
  maxKappa = 2.6,
  maxKappaRate = 5.5,
) {
  const gearDir = p.gearDir ?? 1;
  const isAirborne = (p.altitude ?? 0) > 0;
  const effMaxKappa = isAirborne
    ? Math.min(maxKappa, 0.38, 32.0 / Math.max(4.0, (p.speed ?? 0) ** 2))
    : maxKappa;
  const motionAng = gearDir < 0 ? normalizeAngle(p.ang + Math.PI) : p.ang;
  const alpha = normalizeAngle(
    Math.atan2(carrotY - p.y, carrotX - p.x) - motionAng,
  );
  const dCarrot = Math.hypot(carrotX - p.x, carrotY - p.y);
  const rawKappa =
    dCarrot > 1e-3 ? (2 * Math.sin(alpha)) / Math.max(0.28, dCarrot) : 0;
  const targetKappa = Math.max(
    -effMaxKappa,
    Math.min(effMaxKappa, gearDir * rawKappa),
  );
  let nextKappa = moveTowards(
    p.steerKappa ?? 0,
    targetKappa,
    maxKappaRate * effDt,
  );
  const prevOmega = p._groundOmega ?? 0;
  if (p.speed > 1e-3) {
    const maxAngAccel = isAirborne ? 14.0 : 11.5;
    const limOmega = maxAngAccel * effDt;
    const desiredOmega = nextKappa * gearDir * p.speed;
    const clampedOmega = Math.max(
      prevOmega - limOmega,
      Math.min(prevOmega + limOmega, desiredOmega),
    );
    nextKappa = Math.max(
      -effMaxKappa,
      Math.min(effMaxKappa, clampedOmega / (gearDir * p.speed)),
    );
  }
  p.steerKappa = nextKappa;
  const ds = p.speed * effDt;
  if (ds <= 1e-9) {
    p._groundOmega = 0;
    return;
  }
  const dAng = p.steerKappa * gearDir * ds;
  const midAng = p.ang + 0.5 * dAng;
  const prevX = p.x;
  const prevY = p.y;
  p.x += Math.cos(midAng) * gearDir * ds;
  p.y += Math.sin(midAng) * gearDir * ds;
  if (p.x === prevX && p.y === prevY) {
    p._groundOmega = 0;
    return;
  }
  p.ang = normalizeAngle(p.ang + dAng);
  p._groundOmega = dAng / effDt;
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

  const noseAngle = normalizeAngle(
    (ap.angleRad ?? 0) + (side > 0 ? Math.PI * 0.5 : -Math.PI * 0.5),
  );

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
 * Maps 1D taxiway coordinate s to world coordinates { x, y, ang }.
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

  const w = toWorld(ap, lx, ly);
  return { x: w.x, y: w.y, ang };
}

/**
 * Evaluates the reverse tug pushback L-fillet guide path in world coordinates at arc distance s.
 * @param {Airport | PlaneEndpoint} ap
 * @param {GateSlot} gate
 * @param {number} s
 * @returns {{ x: number, y: number, sStop: number }}
 */
function sampleReversePushbackWorld(ap, gate, s) {
  const side = ap.apronSide || 1;
  const activeSign = ap.atc?.activeSign ?? ap.activeSign ?? 1;
  const rPush = 0.52;
  const cyF = gate.taxiY + side * rPush;
  const cxF = gate.lx + activeSign * rPush;
  const len1 = Math.abs(gate.ly - cyF);
  const len2 = rPush * Math.PI * 0.5;
  const sStop = len1 + len2 + 0.28;

  let lx = gate.lx;
  let ly = gate.ly;
  if (s <= len1) {
    lx = gate.lx;
    ly = gate.ly - side * Math.max(0, s);
  } else if (s <= len1 + len2) {
    const theta = (s - len1) / rPush;
    lx = gate.lx + activeSign * rPush * (1 - Math.cos(theta));
    ly = gate.taxiY + side * rPush * (1 - Math.sin(theta));
  } else {
    lx = cxF + activeSign * (s - len1 - len2);
    ly = gate.taxiY;
  }
  const w = toWorld(ap, lx, ly);
  return { x: w.x, y: w.y, sStop };
}

/**
 * Evaluates the L-fillet gate pull-in guide path in world coordinates at arc coordinate s.
 * @param {Airport | PlaneEndpoint} ap
 * @param {GateSlot} gate
 * @param {number} s
 * @returns {{ x: number, y: number, sTurnStart: number, filletLen: number, totalGateS: number }}
 */
function sampleGatePullInWorld(ap, gate, s) {
  const side = ap.apronSide || 1;
  const activeSign = ap.atc?.activeSign ?? ap.activeSign ?? 1;
  const rGate = 0.52;
  const sTurnStart = gate.taxiS - rGate;
  const filletLen = rGate * Math.PI * 0.5;
  const leadInLen = Math.abs(gate.ly - (gate.taxiY + side * rGate));
  const totalGateS = sTurnStart + filletLen + leadInLen;

  if (s <= sTurnStart) {
    const w = taxiSpinePosToWorld(ap, s);
    return { x: w.x, y: w.y, sTurnStart, filletLen, totalGateS };
  }
  const ds = s - sTurnStart;
  let lx = gate.lx;
  let ly = gate.ly;
  if (ds <= filletLen) {
    const theta = ds / rGate;
    lx = gate.lx + activeSign * rGate * (1 - Math.sin(theta));
    ly = gate.taxiY + side * rGate * (1 - Math.cos(theta));
  } else {
    const dLead = ds - filletLen;
    lx = gate.lx;
    ly = gate.taxiY + side * rGate + side * dLead;
  }
  const w = toWorld(ap, lx, ly);
  return { x: w.x, y: w.y, sTurnStart, filletLen, totalGateS };
}

/**
 * Projects (lx, ly) onto the L-fillet gate pull-in guide path to obtain monotonic progress s.
 * @param {Airport | PlaneEndpoint} ap
 * @param {GateSlot} gate
 * @param {number} lx
 * @param {number} ly
 * @param {number} prevS
 * @returns {number}
 */
function projectGatePullInS(ap, gate, lx, ly, prevS) {
  const atc = ap.atc;
  const isHub = Boolean(ap.isHub);
  const side = ap.apronSide || 1;
  const rwyLen = ap.halfLen * 2;
  const activeSign = atc?.activeSign ?? ap.activeSign ?? 1;
  const exitCrossX = atc
    ? atc.exitRwyX
    : activeSign * (isHub ? 0.41 : 0.38) * rwyLen;
  const taxiY = atc ? atc.taxiY : -side * (isHub ? 0.6 : 0.62);
  const crossFromY = -side * (isHub ? 3.35 : 1.68);
  const crossSpan = Math.abs(taxiY - crossFromY);
  const r1 = Math.min(0.45, crossSpan * 0.45);
  const r2 = Math.min(0.45, crossSpan * 0.45);

  const rGate = 0.52;
  const sTurnStart = gate.taxiS - rGate;
  const filletLen = rGate * Math.PI * 0.5;
  const cxF = gate.lx + activeSign * rGate;
  const cyF = gate.taxiY + side * rGate;

  if (prevS >= sTurnStart - 0.1) {
    if ((ly - cyF) * side >= 0) {
      return Math.max(prevS, sTurnStart + filletLen + (ly - cyF) * side);
    }
    const dx = (cxF - lx) * activeSign;
    const dy = (cyF - ly) * side;
    if (dx >= 0) {
      const theta = Math.max(
        0,
        Math.min(Math.PI * 0.5, Math.atan2(dx, Math.max(1e-6, dy))),
      );
      return Math.max(prevS, sTurnStart + rGate * theta);
    }
  }
  if (prevS >= -r2) {
    return Math.max(prevS, (exitCrossX - lx) * activeSign);
  }
  if (prevS >= -crossSpan - r1 * 0.2) {
    return Math.max(prevS, -crossSpan + Math.abs(ly - crossFromY));
  }
  return Math.max(prevS, -crossSpan + (lx - exitCrossX) * activeSign);
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
 * Returns true if the endpoint can accommodate a 4-engine WIDEBODY_FREIGHTER (HUB, CRG, or off-map ExternalCorridor).
 * Regional spoke airports ('REG') never accept wide-body freighters.
 * @param {Partial<Airport & PlaneEndpoint> | null | undefined} ep
 * @returns {boolean}
 */
export function canWidebodyServe(ep) {
  if (!ep) return false;
  if (ep.isExternal) return true;
  if (typeof ep.acceptsWidebody === "boolean") return ep.acceptsWidebody;
  return (
    ep.isHub === true || ep.airportClass === "HUB" || ep.airportClass === "CRG"
  );
}

/**
 * Creates an off-map external corridor endpoint for international air traffic.
 * @param {Airport | PlaneEndpoint} ap
 * @param {number} [corridorIdx]
 * @param {number} [W]
 * @param {number} [H]
 * @returns {PlaneEndpoint}
 */
export function createExternalEndpoint(ap, corridorIdx = 0, W = 360, H = 224) {
  if (ap.externalCorridors && ap.externalCorridors.length > 0) {
    const corr =
      ap.externalCorridors[corridorIdx % ap.externalCorridors.length];
    return {
      x: corr.entryX,
      y: corr.entryY,
      angleRad: corr.angleRad,
      halfLen: 6,
      isExternal: true,
      acceptsWidebody: true,
      corridorId: corr.id,
      label: corr.label,
    };
  }

  const ang = ap.angleRad ?? 0;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const minX = -42;
  const minY = -42;
  const maxX = W + 42;
  const maxY = H + 42;
  let t = 160;
  const tx =
    cos > 1e-4
      ? (maxX - ap.x) / cos
      : cos < -1e-4
        ? (minX - ap.x) / cos
        : Infinity;
  const ty =
    sin > 1e-4
      ? (maxY - ap.y) / sin
      : sin < -1e-4
        ? (minY - ap.y) / sin
        : Infinity;
  const tBorder = Math.min(tx > 0 ? tx : Infinity, ty > 0 ? ty : Infinity);
  if (Number.isFinite(tBorder) && tBorder > 0) {
    t = Math.min(t, tBorder);
  }
  const x = Math.max(minX, Math.min(maxX, ap.x + cos * t));
  const y = Math.max(minY, Math.min(maxY, ap.y + sin * t));
  return {
    x,
    y,
    angleRad: ang,
    halfLen: 6,
    isExternal: true,
    acceptsWidebody: true,
    label: "INTL CORRIDOR",
  };
}

/**
 * Builds an arc-length parameterized 5-phase gate-to-gate flight track in world tile coordinates.
 * @param {Airport | PlaneEndpoint} origin
 * @param {Airport | PlaneEndpoint} dest
 * @param {{ isCargoFreighter?: boolean, aircraftType?: AircraftType, gateIndex?: number, gateLx?: number, destGateLx?: number, oSign?: 1 | -1, dSign?: 1 | -1 }} [options]
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
  const oHalfLen = origin.halfLen || 14;
  const oRwyLen = oHalfLen * 2;
  const depRwyY = oIsHub ? -oSide * 1.72 : -oSide * 1.68;

  const dHalfLen = dest.halfLen || 14;
  const dBaseRwyLen = dHalfLen * 2;
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

  const isTurboprop = options.aircraftType === "FEEDER_TURBOPROP";
  const taxiSpeed = SIM_CONFIG.AVIATION.taxiSpeed;
  const takeoffSpeed = isTurboprop
    ? (SIM_CONFIG.AVIATION.turbopropTakeoffSpeed ?? 10.6)
    : SIM_CONFIG.AVIATION.takeoffSpeed;
  const cruiseSpeed = isTurboprop
    ? (SIM_CONFIG.AVIATION.turbopropCruiseSpeed ?? 13.2)
    : SIM_CONFIG.AVIATION.cruiseSpeed;
  const landingSpeed = isTurboprop
    ? (SIM_CONFIG.AVIATION.turbopropLandingSpeed ?? 9.8)
    : SIM_CONFIG.AVIATION.landingSpeed;

  /** @type {FlightTrackPoint[]} */
  const rawPts = [];
  let holdShortRawIdx = -1;
  let lineupEndRawIdx = -1;

  let sx = 0;
  let sy = 0;

  if (origin.isExternal) {
    sx = origin.x;
    sy = origin.y;
    holdShortRawIdx = 0;
    lineupEndRawIdx = 0;
    rawPts.push({
      x: origin.x,
      y: origin.y,
      altitude: SIM_CONFIG.AVIATION.cruiseAlt,
      phase: "CRUISE",
      speed: cruiseSpeed,
    });
  } else {
    // 1. TAXI_OUT (altitude = 0, speed = 2.2 tiles/sec)
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

    // Forward 8-step quarter-circle fillet lining up from hold-short onto runway centerline
    const turnR = Math.abs(depRwyY - oHoldShortY);
    lineupEndRawIdx = holdShortRawIdx;
    for (let step = 1; step <= 8; step++) {
      const theta = (step / 8) * (Math.PI * 0.5);
      const flx = oCrossTaxiX + oSign * turnR * (1 - Math.cos(theta));
      const fly =
        step === 8 ? depRwyY : oHoldShortY - oSide * turnR * Math.sin(theta);
      const pFillet = toWorld(origin, flx, fly);
      if (step === 8) lineupEndRawIdx = rawPts.length;
      rawPts.push({
        x: pFillet.x,
        y: pFillet.y,
        altitude: 0,
        phase: "TAXI_OUT",
        speed: taxiSpeed,
      });
    }

    // 2. TAKEOFF (altitude: 0 -> 0.18, speed: 2.2 -> 13.5 tiles/sec smooth acceleration roll)
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
    const oClimbX = oSign * (oHalfLen + oApproachLen * 0.65);
    const oMidClimbX = oSign * (oHalfLen + oApproachLen * 0.32);

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

    sx = pClimbOut.x;
    sy = pClimbOut.y;
  }

  // 3. CRUISE (Dubins-style G1 departure turn arc + collinear enroute Bezier + arrival base-to-final turn arc)
  const rawSx = sx;
  const rawSy = sy;
  let rawEx = dest.x;
  let rawEy = dest.y;
  /** @type {{ x: number, y: number } | null} */
  let pAppEntry = null;

  if (!dest.isExternal) {
    const dApproachLen = dest.approachLen || 14;
    const dEntryDist = dHalfLen * (dIsHub ? 0.88 : 1.0) + dApproachLen * 0.75;
    const dEntryX = -dSign * dEntryDist;
    pAppEntry = toWorld(dest, dEntryX, arrRwyY);
    rawEx = pAppEntry.x;
    rawEy = pAppEntry.y;
  }

  const oCos = Math.cos(oAng);
  const oSin = Math.sin(oAng);
  const dCos = Math.cos(dAng);
  const dSin = Math.sin(dAng);
  const thetaO = Math.atan2(oSin * oSign, oCos * oSign);
  const thetaD = Math.atan2(dSin * dSign, dCos * dSign);
  const rawD = Math.hypot(rawEx - rawSx, rawEy - rawSy) || 1;
  const thetaChord = Math.atan2(rawEy - rawSy, rawEx - rawSx);

  const rDep = Math.min(7.5, rawD * 0.25);
  const rArr = Math.min(7.5, rawD * 0.25);
  const maxTurn =
    rawD < 24
      ? Math.min(0.72 * Math.PI, (rawD / 24) * 0.25 * Math.PI)
      : 0.72 * Math.PI;

  let deltaDep = 0;
  if (!origin.isExternal) {
    let dThetaDep = normalizeAngle(thetaChord - thetaO);
    if (Math.abs(dThetaDep) > 0.78 * Math.PI) {
      dThetaDep = -oSide * oSign * Math.abs(dThetaDep);
    }
    if (Math.abs(dThetaDep) > 0.08) {
      deltaDep = Math.max(-maxTurn, Math.min(maxTurn, dThetaDep));
    }
  }

  let deltaArr = 0;
  if (!dest.isExternal) {
    let dThetaArr = normalizeAngle(thetaD - thetaChord);
    if (Math.abs(dThetaArr) > 0.78 * Math.PI) {
      dThetaArr = -dSide * dSign * Math.abs(dThetaArr);
    }
    if (Math.abs(dThetaArr) > 0.08) {
      deltaArr = Math.max(-maxTurn, Math.min(maxTurn, dThetaArr));
    }
  }

  const climbAlt = SIM_CONFIG.AVIATION.climbOutAlt;
  const maxAlt = SIM_CONFIG.AVIATION.cruiseAlt;
  const hasDepArc = !origin.isExternal && Math.abs(deltaDep) > 0;
  const hasArrArc = !dest.isExternal && Math.abs(deltaArr) > 0;
  const depEndAlt = hasDepArc
    ? climbAlt + (maxAlt - climbAlt) * 0.16
    : origin.isExternal
      ? maxAlt
      : climbAlt;
  const arrStartAlt = hasArrArc
    ? climbAlt + (maxAlt - climbAlt) * 0.16
    : dest.isExternal
      ? maxAlt
      : climbAlt;

  if (hasDepArc) {
    const depArcLen = rDep * Math.abs(deltaDep);
    const depSteps = Math.max(
      2,
      Math.ceil(Math.max(depArcLen / 0.85, Math.abs(deltaDep) / 0.11)),
    );
    const sDep = Math.sign(deltaDep);
    for (let i = 1; i <= depSteps; i++) {
      const u = i / depSteps;
      const ang = thetaO + u * deltaDep;
      const ax = rawSx + rDep * sDep * (Math.sin(ang) - Math.sin(thetaO));
      const ay = rawSy - rDep * sDep * (Math.cos(ang) - Math.cos(thetaO));
      rawPts.push({
        x: ax,
        y: ay,
        altitude: climbAlt + (depEndAlt - climbAlt) * u,
        phase: "CRUISE",
        speed: cruiseSpeed,
      });
    }
    sx =
      rawSx +
      rDep *
        Math.sign(deltaDep) *
        (Math.sin(thetaO + deltaDep) - Math.sin(thetaO));
    sy =
      rawSy -
      rDep *
        Math.sign(deltaDep) *
        (Math.cos(thetaO + deltaDep) - Math.cos(thetaO));
  }

  let ex = rawEx;
  let ey = rawEy;
  if (hasArrArc) {
    const sArr = Math.sign(deltaArr);
    ex = rawEx + rArr * sArr * (Math.sin(thetaD - deltaArr) - Math.sin(thetaD));
    ey = rawEy - rArr * sArr * (Math.cos(thetaD - deltaArr) - Math.cos(thetaD));
  }

  const cdx = ex - sx;
  const cdy = ey - sy;
  const cDist = Math.hypot(cdx, cdy) || 1;
  const ux = cdx / cDist;
  const uy = cdy / cDist;
  const nx = -uy;
  const ny = ux;

  const tDepAng = origin.isExternal ? Math.atan2(uy, ux) : thetaO + deltaDep;
  const tArrAng = dest.isExternal ? Math.atan2(uy, ux) : thetaD - deltaArr;
  const tDepX = Math.cos(tDepAng);
  const tDepY = Math.sin(tDepAng);
  const tArrX = Math.cos(tArrAng);
  const tArrY = Math.sin(tArrAng);

  const lPull = Math.min(18, Math.max(1.5, cDist * 0.3));
  const oExtLat = origin.isExternal ? Math.min(3.5, cDist * 0.04) : 0;
  const dExtLat = dest.isExternal ? Math.min(3.5, cDist * 0.04) : 0;

  const c1x = sx + lPull * tDepX + nx * oExtLat;
  const c1y = sy + lPull * tDepY + ny * oExtLat;
  const c2x = ex - lPull * tArrX + nx * dExtLat;
  const c2y = ey - lPull * tArrY + ny * dExtLat;
  const airwayCurve = { sx, sy, c1x, c1y, c2x, c2y, ex, ey };

  const numCruiseSteps = Math.max(36, Math.ceil(cDist * 1.25));
  const endStep =
    dest.isExternal || hasArrArc ? numCruiseSteps : numCruiseSteps - 1;

  for (let k = 1; k <= endStep; k++) {
    const t = k / numCruiseSteps;
    const mt = 1 - t;
    const b0 = mt * mt * mt;
    const b1 = 3 * mt * mt * t;
    const b2 = 3 * mt * t * t;
    const b3 = t * t * t;
    const bx = b0 * sx + b1 * c1x + b2 * c2x + b3 * ex;
    const by = b0 * sy + b1 * c1y + b2 * c2y + b3 * ey;

    let alt = maxAlt;
    if (origin.isExternal && dest.isExternal) {
      alt = maxAlt;
    } else if (origin.isExternal) {
      alt = arrStartAlt + (maxAlt - arrStartAlt) * Math.cos(t * Math.PI * 0.5);
    } else if (dest.isExternal) {
      alt =
        depEndAlt +
        (maxAlt - depEndAlt) * Math.sin(Math.min(1, t * 1.5) * Math.PI * 0.5);
    } else {
      const baseAlt = depEndAlt * (1 - t) + arrStartAlt * t;
      alt = baseAlt + (maxAlt - baseAlt) * Math.sin(t * Math.PI);
    }

    rawPts.push({
      x: bx,
      y: by,
      altitude: alt,
      phase: "CRUISE",
      speed: cruiseSpeed,
    });
  }

  if (hasArrArc) {
    const arrArcLen = rArr * Math.abs(deltaArr);
    const arrSteps = Math.max(
      2,
      Math.ceil(Math.max(arrArcLen / 0.85, Math.abs(deltaArr) / 0.11)),
    );
    const sArr = Math.sign(deltaArr);
    for (let i = 1; i < arrSteps; i++) {
      const u = i / arrSteps;
      const ang = thetaD - (1 - u) * deltaArr;
      const ax = rawEx + rArr * sArr * (Math.sin(ang) - Math.sin(thetaD));
      const ay = rawEy - rArr * sArr * (Math.cos(ang) - Math.cos(thetaD));
      rawPts.push({
        x: ax,
        y: ay,
        altitude: arrStartAlt + (climbAlt - arrStartAlt) * u,
        phase: "CRUISE",
        speed: cruiseSpeed,
      });
    }
  }

  if (!dest.isExternal && pAppEntry) {
    // 4. LANDING (altitude: 0.18 -> 0, speed: 12.5 -> 2.2 tiles/sec)
    rawPts.push({
      x: pAppEntry.x,
      y: pAppEntry.y,
      altitude: SIM_CONFIG.AVIATION.climbOutAlt,
      phase: "LANDING",
      speed: landingSpeed,
    });

    const dApproachLen = dest.approachLen || 14;
    const dEntryDist = dHalfLen * (dIsHub ? 0.88 : 1.0) + dApproachLen * 0.75;
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
  }

  // Filter consecutive duplicate points & build cumulative arc length
  /** @type {FlightTrackPoint[]} */
  const pts = [rawPts[0]];
  let holdShortFilteredIdx = 0;
  let lineupEndFilteredIdx = 0;

  for (let i = 1; i < rawPts.length; i++) {
    const prev = pts[pts.length - 1];
    const cur = rawPts[i];
    const d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    if (d > 1e-4) {
      if (i === holdShortRawIdx) {
        holdShortFilteredIdx = pts.length;
      }
      if (i === lineupEndRawIdx) {
        lineupEndFilteredIdx = pts.length;
      }
      pts.push(cur);
    } else {
      if (i === holdShortRawIdx) {
        holdShortFilteredIdx = pts.length - 1;
      }
      if (i === lineupEndRawIdx) {
        lineupEndFilteredIdx = pts.length - 1;
      }
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
  const lineupEndDist = cumLen[lineupEndFilteredIdx];

  let cruiseStartDist = totalLength;
  let landingStartDist = totalLength;
  let taxiInStartDist = totalLength;
  for (let i = 0; i < n; i++) {
    if (cruiseStartDist === totalLength && pts[i].phase === "CRUISE") {
      cruiseStartDist = cumLen[i];
    }
    if (landingStartDist === totalLength && pts[i].phase === "LANDING") {
      landingStartDist = cumLen[i];
    }
    if (taxiInStartDist === totalLength && pts[i].phase === "TAXI_IN") {
      taxiInStartDist = cumLen[i];
    }
  }

  return {
    pts,
    cumLen,
    totalLength,
    holdShortDist,
    lineupEndDist,
    cruiseStartDist,
    landingStartDist,
    taxiInStartDist,
    airwayCurve,
  };
}

/**
 * Projects world position (px, py) onto segments of track near curDist to keep arc-length dist synchronized.
 * @param {FlightTrack} track
 * @param {number} px
 * @param {number} py
 * @param {number} curDist
 * @param {number} ds
 * @returns {number}
 */
function projectFlightTrackDist(track, px, py, curDist, ds) {
  const { pts, cumLen, totalLength } = track;
  const curS = sampleFlightTrack(track, curDist);
  const i0 = Math.max(0, curS.segIdx - 1);
  const i1 = Math.min(pts.length - 2, curS.segIdx + 10);
  let bestD = Infinity;
  let bestArc = curDist;
  for (let i = i0; i <= i1; i++) {
    const ax = pts[i].x;
    const ay = pts[i].y;
    const bx = pts[i + 1].x;
    const by = pts[i + 1].y;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy || 1e-8;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    const arc = cumLen[i] + t * (cumLen[i + 1] - cumLen[i]);
    if (d < bestD && arc >= curDist - 0.02) {
      bestD = d;
      bestArc = arc;
    }
  }
  return Math.min(
    totalLength,
    Math.max(curDist, Math.min(curDist + ds * 1.45 + 1e-4, bestArc)),
  );
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
  const phase =
    clampedDist >= totalLength
      ? p0.phase === "CRUISE"
        ? "CRUISE"
        : "GATE_DWELL"
      : p0.phase;
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
      ap.importsCompleted ??= 0;
      ap.exportsCompleted ??= 0;
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
        let totalWeight = 0;
        for (let i = 0; i < pool.length; i++) {
          totalWeight += Math.max(1, pool[i].demandWeight || 1);
        }
        let roll = rng.next() * totalWeight;
        let link = pool[0];
        for (let i = 0; i < pool.length; i++) {
          const w = Math.max(1, pool[i].demandWeight || 1);
          if (roll < w) {
            link = pool[i];
            break;
          }
          roll -= w;
        }
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

    for (const ap of world.airports) {
      ap.importsCompleted ??= 0;
      ap.exportsCompleted ??= 0;
    }

    const planeIdx = this.planes.length;
    const mult =
      world.config.archetype === "island-hopper"
        ? SIM_CONFIG.FLEET.islandHopperPlanesPerAirport
        : SIM_CONFIG.FLEET.basePlanesPerAirport;
    const planeCount = Math.max(2, world.airports.length * mult);

    const originIdx = planeIdx % world.airports.length;
    let origin = world.airports[originIdx];
    if (!origin) return;

    /** @type {Airport | PlaneEndpoint} */
    let dest;

    const otherWidebodyAps = world.airports.filter(
      (a) => a.id !== origin.id && canWidebodyServe(a),
    );
    const wantsWidebody =
      canWidebodyServe(origin) &&
      (origin.airportClass === "CRG" || planeIdx % 3 === 2);
    const noOtherWidebody = wantsWidebody && otherWidebodyAps.length === 0;

    const shouldPickExternal =
      world.airports.length === 1 ||
      noOtherWidebody ||
      ((origin.isHub || origin.airportClass === "CRG") && rng.next() < 0.22);

    if (shouldPickExternal) {
      dest = createExternalEndpoint(origin, planeIdx, world.W, world.H);
    } else {
      const destIdx =
        (originIdx + 1 + Math.floor(rng.next() * (world.airports.length - 1))) %
        world.airports.length;
      dest = world.airports[destIdx];
    }

    /** @type {AircraftType} */
    let aircraftType = "PASSENGER_JET";
    let isCargoFreighter = false;

    if (
      canWidebodyServe(origin) &&
      canWidebodyServe(dest) &&
      (origin.airportClass === "CRG" ||
        dest.airportClass === "CRG" ||
        dest.isExternal ||
        origin.isExternal ||
        planeIdx % 3 === 2)
    ) {
      aircraftType = "WIDEBODY_FREIGHTER";
      isCargoFreighter = true;
    } else if (
      (!canWidebodyServe(origin) || !canWidebodyServe(dest)) &&
      (planeIdx % 2 === 0 || world.config.archetype === "island-hopper")
    ) {
      aircraftType = "FEEDER_TURBOPROP";
      isCargoFreighter = true;
    } else if (
      planeIdx % 3 === 2 &&
      (!canWidebodyServe(origin) || !canWidebodyServe(dest))
    ) {
      aircraftType = "FEEDER_TURBOPROP";
      isCargoFreighter = true;
    } else {
      aircraftType = "PASSENGER_JET";
      isCargoFreighter = false;
    }

    // Hard Invariant: If aircraftType === "WIDEBODY_FREIGHTER", neither origin nor dest may EVER be a REG airport (!canWidebodyServe)
    if (aircraftType === "WIDEBODY_FREIGHTER") {
      if (!canWidebodyServe(origin) || !canWidebodyServe(dest)) {
        aircraftType = "FEEDER_TURBOPROP";
        isCargoFreighter = true;
      }
    }

    // Hard Invariant: If world has any REG airports and planeCount >= 4, ensure at least one plane is FEEDER_TURBOPROP serving REG
    const hasRegAirports = world.airports.some((a) => !canWidebodyServe(a));
    if (hasRegAirports && planeCount >= 4 && planeIdx === planeCount - 1) {
      const alreadyHasFeederReg = this.planes.some(
        (p) =>
          p.aircraftType === "FEEDER_TURBOPROP" &&
          (!canWidebodyServe(p.origin) || !canWidebodyServe(p.dest)),
      );
      if (!alreadyHasFeederReg) {
        const regAp = world.airports.find((a) => !canWidebodyServe(a));
        if (regAp) {
          origin = regAp;
          const otherAps = world.airports.filter((a) => a.id !== regAp.id);
          dest =
            otherAps.length > 0
              ? otherAps[Math.floor(rng.next() * otherAps.length)]
              : createExternalEndpoint(regAp, planeIdx, world.W, world.H);
          aircraftType = "FEEDER_TURBOPROP";
          isCargoFreighter = true;
        }
      }
    }

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
      aircraftType,
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
          const rawS = originAtc
            ? (dist / Math.max(0.01, track.holdShortDist)) *
              originAtc.holdShortS
            : 5;
          taxiS = originAtc
            ? Math.max(0.8, Math.min(originAtc.holdShortS - 2.4, rawS))
            : rawS;
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
            taxiS = Math.max(
              0.6,
              Math.min(freeGate.taxiS - 2.2, freeGate.taxiS * 0.4),
            );
          }
        }
      } else {
        state = "GATE_LOADING";
      }
    }

    let initX = sample.x;
    let initY = sample.y;
    let initAng = sample.ang;
    let initSpeed = sample.speed;
    let initAccel = 0;
    const lineupEndDist = track.lineupEndDist ?? track.holdShortDist + 1.2;
    const landingStartDist = track.landingStartDist ?? track.totalLength;
    const taxiInStartDist = track.taxiInStartDist ?? track.totalLength;

    const isTurboprop = aircraftType === "FEEDER_TURBOPROP";
    const maxCruiseSpd = isTurboprop
      ? (SIM_CONFIG.AVIATION.turbopropCruiseSpeed ?? 13.2)
      : SIM_CONFIG.AVIATION.cruiseSpeed;
    const appLandSpd = isTurboprop
      ? (SIM_CONFIG.AVIATION.turbopropLandingSpeed ?? 9.8)
      : SIM_CONFIG.AVIATION.landingSpeed;

    if (state === "GATE_LOADING") {
      if (chosenOriginGate) {
        initX = chosenOriginGate.worldX;
        initY = chosenOriginGate.worldY;
        initAng = chosenOriginGate.noseAngle;
      }
      initSpeed = 0;
      initAccel = 0;
    } else if (
      (state === "TAXI_TO_RUNWAY" || state === "HOLD_SHORT_QUEUE") &&
      originAtc
    ) {
      const wPos = taxiSpinePosToWorld(origin, taxiS);
      initX = wPos.x;
      initY = wPos.y;
      initAng = wPos.ang;
      initSpeed =
        state === "HOLD_SHORT_QUEUE" ? 0 : SIM_CONFIG.AVIATION.taxiSpeed;
      initAccel = 0;
    } else if (state === "TAXI_TO_GATE" && destAtc) {
      const wPos = taxiSpinePosToWorld(dest, taxiS);
      initX = wPos.x;
      initY = wPos.y;
      initAng = wPos.ang;
      initSpeed = SIM_CONFIG.AVIATION.taxiSpeed;
      initAccel = 0;
    } else if (state === "TAKEOFF_ROLL") {
      if (dist < lineupEndDist) {
        initSpeed = 2.4;
        initAccel = 2.0;
      } else {
        initSpeed = Math.min(
          maxCruiseSpd,
          Math.sqrt(2.8 * 2.8 + 2 * 5.2 * (dist - lineupEndDist)),
        );
        initAccel = initSpeed < maxCruiseSpd ? 5.2 : 0;
      }
    } else if (state === "ENROUTE_CRUISE") {
      if (dest.isExternal) {
        initSpeed = maxCruiseSpd;
        initAccel = 0;
      } else {
        const dToLand = Math.max(0.05, landingStartDist - dist);
        const vBrake = Math.sqrt(appLandSpd ** 2 + 2 * 4.2 * dToLand);
        initSpeed = Math.min(maxCruiseSpd, vBrake);
        initAccel = initSpeed < maxCruiseSpd ? -4.2 : 0;
      }
    } else if (state === "LANDING_ROLLOUT") {
      const dToExit = Math.max(0.05, taxiInStartDist - 0.45 - dist);
      initSpeed = Math.min(
        appLandSpd,
        Math.sqrt(SIM_CONFIG.AVIATION.taxiSpeed ** 2 + 2 * 4.5 * dToExit),
      );
      initAccel = -4.5;
    }

    /** @type {PlaneAgent} */
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
      accel: initAccel,
      steerKappa: 0,
      gearDir: 1,
      _groundOmega: 0,
      _pushbackStage: null,
      _pushbackS: 0,
      _gatePullInS: state === "TAXI_TO_GATE" ? taxiS : null,
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
      speed: initSpeed,
      dwellTimer: 0,
      holdingShort: state === "HOLD_SHORT_QUEUE",
      isCargoFreighter,
      aircraftType,
      isExternalFlight: Boolean(origin.isExternal || dest.isExternal),
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
        planeAgent._gatePullInS = planeAgent.taxiS ?? 0;
      }
    }

    this.planes.push(planeAgent);
    planeAgent._lastSimDist = planeAgent.dist;
    planeAgent._lastSimState = planeAgent.state;
    planeAgent._lastSimPhase = planeAgent.phase;
  }

  /**
   * @param {number} dt
   * @param {number} simSpeed
   */
  update(dt, simSpeed) {
    if (simSpeed <= 0) return;
    const totalEffDt = dt * simSpeed;
    if (totalEffDt <= 0) return;
    this.simTime += totalEffDt;

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
      car.dist += car.speed * speedMult * totalEffDt;

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
    this.normalizePlanesForExternalMutations();

    // Internal 60Hz sub-stepping so all callers execute the exact same physical ODEs
    const subSteps = Math.min(
      240,
      Math.max(1, Math.ceil(totalEffDt / (1 / 60) - 1e-9)),
    );
    const effDt = totalEffDt / subSteps;
    for (let sub = 0; sub < subSteps; sub++) {
      this.stepAviationSubStep(effDt);
    }

    for (const p of this.planes) {
      p._lastSimDist = p.dist;
      p._lastSimState = p.state;
      p._lastSimPhase = p.phase;
    }
  }

  normalizePlanesForExternalMutations() {
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
      if (!p.aircraftType) {
        if (
          canWidebodyServe(p.origin) &&
          canWidebodyServe(p.dest) &&
          (p.origin?.airportClass === "CRG" ||
            p.dest?.airportClass === "CRG" ||
            pIdx % 3 === 2)
        ) {
          p.aircraftType = "WIDEBODY_FREIGHTER";
        } else if (!canWidebodyServe(p.origin) || !canWidebodyServe(p.dest)) {
          p.aircraftType = "FEEDER_TURBOPROP";
        } else {
          p.aircraftType = p.isCargoFreighter
            ? "FEEDER_TURBOPROP"
            : "PASSENGER_JET";
        }
      }
      p.isExternalFlight ??= Boolean(
        p.origin?.isExternal || p.dest?.isExternal,
      );
      if (p.accel === undefined) p.accel = 0;
      if (p.steerKappa === undefined) p.steerKappa = 0;
      if (p.gearDir === undefined) p.gearDir = 1;
      if (p._groundOmega === undefined) p._groundOmega = 0;
      if (p._pushbackStage === undefined) p._pushbackStage = null;
      if (p._pushbackS === undefined) p._pushbackS = 0;
      if (p._gatePullInS === undefined) p._gatePullInS = null;

      const externallyMutated =
        p._lastSimDist === undefined ||
        Math.abs(p.dist - p._lastSimDist) > 1e-5 ||
        p.state !== p._lastSimState ||
        p.phase !== p._lastSimPhase;
      if (!externallyMutated) continue;

      // Initialize state from phase if undefined (e.g. synthetic test objects)
      if (!p.state) {
        if (p.phase === "GATE_DWELL") p.state = "GATE_LOADING";
        else if (p.phase === "TAXI_OUT") {
          if (p.dist >= p.track.holdShortDist - 0.25) {
            p.state = "HOLD_SHORT_QUEUE";
            p.taxiS = p.origin.atc ? p.origin.atc.holdShortS : 10;
            p.speed = 0;
            p.accel = 0;
            if (p.origin.atc) {
              const wPos = taxiSpinePosToWorld(p.origin, p.taxiS);
              p.x = wPos.x;
              p.y = wPos.y;
              p.ang = wPos.ang;
            }
          } else {
            p.state = "TAXI_TO_RUNWAY";
          }
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
        p.x = s.x;
        p.y = s.y;
        p.ang = s.ang;
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
            const rem = Math.max(0, p.track.totalLength - p.dist);
            const gInfo = sampleGatePullInWorld(p.dest, g, g.taxiS);
            const pullRem = rem <= 0.25 ? 4e-4 : rem;
            p._gatePullInS = Math.max(0, gInfo.totalGateS - pullRem);
            const wPt = sampleGatePullInWorld(p.dest, g, p._gatePullInS);
            p.x = wPt.x;
            p.y = wPt.y;
            p.ang = g.noseAngle;
            p.speed = rem <= 0.25 ? 0.005 : SIM_CONFIG.AVIATION.taxiSpeed;
            p.accel = 0;
            p.taxiS = Math.max(0, g.taxiS - pullRem);
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

      // Sync pose if external test jumped p.dist or p.state onto track
      if (
        p.state === "TAKEOFF_ROLL" ||
        p.state === "ENROUTE_CRUISE" ||
        p.state === "LANDING_ROLLOUT"
      ) {
        const s = sampleFlightTrack(p.track, p.dist);
        if (Math.hypot(p.x - s.x, p.y - s.y) > 2.0) {
          p.x = s.x;
          p.y = s.y;
          p.ang = s.ang;
          p.steerKappa = 0;
          if ((p.speed ?? 0) < 1.0 && p.state !== "TAKEOFF_ROLL") {
            p.speed = s.speed;
            p.accel = 0;
          }
        }
      }
    }
  }

  /**
   * Executes one sub-step of ATC queue management and non-holonomic / jerk-bounded aircraft physics.
   * @param {number} effDt
   */
  stepAviationSubStep(effDt) {
    // Pass 1: Airport ATC Queue Management across all airports
    for (const ap of this.world.airports) {
      const atc = ap.atc;
      if (!atc) continue;

      // 0. Reconcile gate occupancy & reservations
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
        if (gate.reservedBy !== null) {
          const resHolder = this.planes.find((p) => p.id === gate.reservedBy);
          const validPushback =
            resHolder &&
            resHolder.origin.id === ap.id &&
            resHolder.state === "TAXI_TO_RUNWAY" &&
            resHolder._pushbackStage === "REVERSE" &&
            resHolder.pushbackOriginGateId === gate.id;
          const validArrival =
            resHolder &&
            resHolder.dest.id === ap.id &&
            resHolder.reservedGateId === gate.id &&
            resHolder.state !== "GATE_LOADING" &&
            resHolder.state !== "PUSHBACK_HOLD";
          if (!validPushback && !validArrival) {
            gate.reservedBy = null;
            if (gate.occupiedBy === null) gate.state = "FREE";
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

      // 2. Check pushbacks for planes at gates in PUSHBACK_HOLD (Stage A reverse tug pushback)
      for (const gate of atc.gates) {
        if (gate.state === "OCCUPIED" && gate.occupiedBy !== null) {
          const plane = this.planes.find((p) => p.id === gate.occupiedBy);
          if (
            plane &&
            plane.state === "PUSHBACK_HOLD" &&
            (plane.pushbackTimer ?? 0) >= 0.25
          ) {
            const pushEndS = Math.max(0, gate.taxiS - 0.52);
            const uTurnClear = atc.taxiwayOccupants.every(
              (o) => (o.taxiS ?? 0) >= 0 || pushEndS - (o.taxiS ?? 0) >= 3.2,
            );
            if (
              uTurnClear &&
              canPushBackOntoTaxiway(atc, gate.taxiS) &&
              canPushBackOntoTaxiway(atc, pushEndS)
            ) {
              const planeId = plane.id ?? 0;
              plane.pushbackOriginGateId = gate.id;
              plane.pushbackOriginS = gate.taxiS;
              plane.taxiS = pushEndS;
              plane.targetTaxiS = atc.holdShortS;
              plane.speed = 0;
              plane.accel = 0;
              plane.steerKappa = 0;
              plane._groundOmega = 0;
              plane.gearDir = -1;
              plane._pushbackStage = "REVERSE";
              plane._pushbackS = 0;
              plane.state = "TAXI_TO_RUNWAY";
              plane.phase = "TAXI_OUT";
              releaseAllGatesForPlane(this.world, planeId);
              gate.state = "RESERVED";
              gate.reservedBy = planeId;
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
      if (atc.crossingQueue.length > 0) {
        const depClear =
          atc.depRunwayBusyBy === null &&
          atc.crossingBusyBy === null &&
          atc.holdShortQueue.length === 0;
        const headCrosser = atc.crossingQueue[0];
        const startS = headCrosser?.taxiS ?? (atc.isHub ? -1.94 : -0.35);
        const entryClear = atc.taxiwayOccupants.every(
          (o) =>
            (o.taxiS ?? 0) - startS >= 3.1 &&
            (!headCrosser ||
              Math.hypot(o.x - headCrosser.x, o.y - headCrosser.y) >= 1.85),
        );
        if (depClear && entryClear) {
          const crosser = atc.crossingQueue.shift();
          if (crosser) {
            if (atc.isHub) {
              atc.crossingBusyBy = crosser.id ?? null;
            }
            crosser._gatePullInS = crosser.taxiS ?? startS;
            crosser.gearDir = 1;
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
          departer &&
          (departer.taxiS ?? 0) >= atc.holdShortS - 0.25 &&
          (departer.speed ?? 0) <= 0.05;
        if (depClear && atHoldShort) {
          let arrivalInbound = false;
          if (!atc.isHub) {
            for (const other of this.planes) {
              if (other === departer) continue;
              if (other.dest && other.dest.id === ap.id) {
                const landingDist =
                  other.track.landingStartDist ?? other.track.totalLength;
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
            departer.gearDir = 1;
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
          p.accel = 0;
          p.steerKappa = 0;
          p._groundOmega = 0;
          p.gearDir = 1;
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
              p.x = freeGate.worldX;
              p.y = freeGate.worldY;
              p.ang = freeGate.noseAngle;
            }
          }

          if (p.dwellTimer >= SIM_CONFIG.AVIATION.gateDwellSec) {
            this.tripsCompleted += SIM_CONFIG.FLEET.flightTripWeight;
            if (p.dest && p.dest.id !== undefined && p.gateId === null) {
              p.origin = p.dest;
            }
            if (p.origin?.isExternal && p.dest && !p._importRecorded) {
              p.dest.importsCompleted = (p.dest.importsCompleted || 0) + 1;
              p._importRecorded = true;
            }

            const currentOrigin = p.origin;
            /** @type {Airport | PlaneEndpoint | null} */
            let nextDest = null;

            if (p.aircraftType === "WIDEBODY_FREIGHTER") {
              const wideOthers = this.world.airports.filter(
                (a) => canWidebodyServe(a) && a.id !== currentOrigin.id,
              );
              const roll = this.rng.next();
              if (
                wideOthers.length === 0 ||
                ((currentOrigin.isHub ||
                  currentOrigin.airportClass === "CRG") &&
                  roll < 0.3)
              ) {
                nextDest = createExternalEndpoint(
                  currentOrigin,
                  (p.id ?? 0) + Math.floor(this.simTime),
                  this.world.W,
                  this.world.H,
                );
              } else {
                nextDest =
                  wideOthers[Math.floor(this.rng.next() * wideOthers.length)];
              }
            } else if (
              (currentOrigin.isHub || currentOrigin.airportClass === "CRG") &&
              this.rng.next() < 0.18
            ) {
              nextDest = createExternalEndpoint(
                currentOrigin,
                p.id ?? 0,
                this.world.W,
                this.world.H,
              );
            } else if (this.world.airports.length > 1) {
              const others = this.world.airports.filter(
                (a) => a.id !== currentOrigin.id,
              );
              const withCap = others.filter((a) => {
                if (!a.atc) return true;
                const activeCount = this.planes.filter(
                  (pl) =>
                    pl !== p &&
                    ((pl.dest.id === a.id &&
                      pl.state !== "GATE_LOADING" &&
                      pl.state !== "PUSHBACK_HOLD") ||
                      (pl.origin.id === a.id &&
                        (pl.state === "GATE_LOADING" ||
                          pl.state === "PUSHBACK_HOLD"))),
                ).length;
                return activeCount < a.atc.gates.length;
              });
              const pool = withCap.length > 0 ? withCap : others;
              nextDest = pool[Math.floor(this.rng.next() * pool.length)];
            } else {
              nextDest = createExternalEndpoint(
                currentOrigin,
                p.id ?? 0,
                this.world.W,
                this.world.H,
              );
            }

            if (nextDest) {
              p.dest = nextDest;
              if (p.aircraftType === "WIDEBODY_FREIGHTER") {
                if (
                  !canWidebodyServe(p.origin) ||
                  !canWidebodyServe(nextDest)
                ) {
                  p.aircraftType = "FEEDER_TURBOPROP";
                }
              }
              p.isCargoFreighter =
                p.aircraftType === "WIDEBODY_FREIGHTER" ||
                p.aircraftType === "FEEDER_TURBOPROP" ||
                p.origin.airportClass === "CRG" ||
                p.dest.airportClass === "CRG";
              p.isExternalFlight = Boolean(
                p.origin.isExternal || nextDest.isExternal,
              );
              p._importRecorded = false;

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
                    ) ?? p.dest.atc.gates[planeId % p.dest.atc.gates.length])
                  : null;

              p.track = buildFlightTrack(p.origin, p.dest, {
                isCargoFreighter: p.isCargoFreighter,
                aircraftType: p.aircraftType,
                gateIndex: planeId,
                gateLx: curGate?.lx,
                destGateLx: destGate?.lx,
                oSign: p.origin.activeSign,
                dSign: p.dest.activeSign,
              });
              p.dist = 0;
              p.segIdx = 0;
              p.dwellTimer = 0;
              p.pushbackTimer = 0;
              p.progress = 0;
              p.holdingShort = false;
              p.altitude = 0;
              p.speed = 0;
              p.accel = 0;
              p.steerKappa = 0;
              p._groundOmega = 0;
              p.gearDir = 1;

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
          p.accel = 0;
          p.steerKappa = 0;
          p._groundOmega = 0;
          p.gearDir = 1;
          p.phase = "TAXI_OUT";
          p.pushbackTimer = (p.pushbackTimer ?? 0) + effDt;
          const atc = p.origin.atc;
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
          const planeId = p.id ?? pIdx;

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

            // Stage A: Reverse Tug Pushback (p.gearDir = -1) along L-fillet onto taxiway spine
            if (
              p._pushbackStage === "REVERSE" &&
              p.pushbackOriginGateId !== null
            ) {
              const gate = atc.gates.find(
                (g) => g.id === p.pushbackOriginGateId,
              );
              if (gate) {
                p.gearDir = -1;
                const revCur = sampleReversePushbackWorld(
                  p.origin,
                  gate,
                  p._pushbackS ?? 0,
                );
                const dRem = Math.max(0, revCur.sStop - (p._pushbackS ?? 0));
                const vDes = computeStopEnvelopeSpeed(dRem, p.speed, 1.25, 1.6);
                stepLongitudinalSpeed(
                  p,
                  vDes,
                  2.8,
                  3.5,
                  18.0,
                  effDt,
                  0.135,
                  null,
                  true,
                );
                const ds = Math.min(dRem, p.speed * effDt);
                p._pushbackS = (p._pushbackS ?? 0) + ds;
                const carrot = sampleReversePushbackWorld(
                  p.origin,
                  gate,
                  p._pushbackS + 0.46,
                );
                stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.4, 5.2);
                p.taxiS = Math.max(0, gate.taxiS - 0.52);
                maintainTaxiwayOrder(atc);

                if (dRem <= 8e-4 && p.speed <= 0.015) {
                  p.speed = 0;
                  p.accel = 0;
                  p.steerKappa = 0;
                  p._groundOmega = 0;
                  p.gearDir = 1;
                  p._pushbackStage = "FORWARD";
                  p.pushbackOriginGateId = null;
                  p.pushbackOriginS = null;
                  const loc = toLocal(p.origin, p.x, p.y);
                  p.taxiS = Math.max(
                    0,
                    (atc.exitRwyX - loc.lx) * atc.activeSign,
                  );
                  releaseAllGatesForPlane(this.world, planeId);
                }
                break;
              }
            }

            // Stage B: Forward Taxi along taxiway spine toward holdShortS (p.gearDir = +1)
            p.gearDir = 1;
            const occIdx = atc.taxiwayOccupants.indexOf(p);
            const maxAllowedS =
              occIdx > 0
                ? (atc.taxiwayOccupants[occIdx - 1].taxiS ?? 0) -
                  (SIM_CONFIG.AVIATION.minTaxiSeparation + 0.08)
                : atc.holdShortS;
            const dRem = Math.max(0, maxAllowedS - (p.taxiS ?? 0));
            const spineLen = Math.abs(atc.depCrossX - atc.exitRwyX);
            const nearCorner3 = Math.abs((p.taxiS ?? 0) - spineLen) < 0.85;
            const cornerCap = nearCorner3 ? 1.65 : maxTaxiSpeed;
            const vDes = computeStopEnvelopeSpeed(
              dRem,
              p.speed,
              cornerCap,
              2.2,
            );
            stepLongitudinalSpeed(
              p,
              vDes,
              4.0,
              4.5,
              18.0,
              effDt,
              0.135,
              null,
              true,
            );
            const ds = Math.min(dRem, p.speed * effDt);
            p.taxiS = (p.taxiS ?? 0) + ds;
            const carrot = taxiSpinePosToWorld(p.origin, p.taxiS + 0.34);
            stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.5, 5.5);

            // Single-runway arrival inbound check at the hold-short line
            let arrivalInbound = false;
            if (!p.origin.isHub && (p.taxiS ?? 0) >= atc.holdShortS - 0.35) {
              for (let oIdx = 0; oIdx < this.planes.length; oIdx++) {
                if (oIdx === pIdx) continue;
                const other = this.planes[oIdx];
                if (
                  other.dest &&
                  other.dest.id !== undefined &&
                  p.origin.id !== undefined &&
                  other.dest.id === p.origin.id
                ) {
                  const landingDist =
                    other.track.landingStartDist ?? other.track.totalLength;
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

            p.dist =
              (Math.max(0, p.taxiS ?? 0) / Math.max(0.01, atc.holdShortS)) *
              p.track.holdShortDist;

            if (
              (atc.holdShortS - p.taxiS <= 0.08 && p.speed <= 0.03) ||
              (arrivalInbound && p.taxiS >= atc.holdShortS - 0.25)
            ) {
              p.dist = Math.min(p.dist, p.track.holdShortDist);
              p.holdingShort = true;
              p.state = "HOLD_SHORT_QUEUE";
              if (!atc.holdShortQueue.includes(p)) {
                atc.holdShortQueue.push(p);
              }
            } else {
              p.holdingShort = false;
            }

            const sample = sampleFlightTrack(p.track, p.dist);
            p.segIdx = sample.segIdx;
            p.progress = Math.min(
              0.9999,
              p.dist / Math.max(0.001, p.track.totalLength),
            );
          } else {
            p.gearDir = 1;
            const dRem = Math.max(0, p.track.holdShortDist - p.dist);
            const vDes = computeStopEnvelopeSpeed(
              dRem,
              p.speed,
              maxTaxiSpeed,
              2.2,
            );
            stepLongitudinalSpeed(
              p,
              vDes,
              4.0,
              4.5,
              18.0,
              effDt,
              0.135,
              null,
              true,
            );
            const ds = Math.min(dRem, p.speed * effDt);
            p.dist += ds;
            const carrot = sampleFlightTrack(p.track, p.dist + 0.45);
            stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.5, 5.5);
            if (dRem <= 0.08 && p.speed <= 0.03) {
              p.state = "HOLD_SHORT_QUEUE";
            }
            const sample = sampleFlightTrack(p.track, p.dist);
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
          p.gearDir = 1;
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
                  (SIM_CONFIG.AVIATION.minTaxiSeparation + 0.08)
                : atc.holdShortS;
            const dRem = Math.max(0, maxAllowedS - (p.taxiS ?? 0));
            if (dRem > 6e-4 || p.speed > 0.01) {
              const vDes = computeStopEnvelopeSpeed(dRem, p.speed, 1.65, 2.2);
              stepLongitudinalSpeed(
                p,
                vDes,
                3.8,
                4.5,
                18.0,
                effDt,
                0.135,
                null,
                true,
              );
              const ds = Math.min(dRem, p.speed * effDt);
              p.taxiS = (p.taxiS ?? 0) + ds;
              const carrot = taxiSpinePosToWorld(p.origin, p.taxiS + 0.45);
              stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.5, 5.5);
            } else {
              p.speed = 0;
              p.accel = 0;
              p.steerKappa = 0;
              p._groundOmega = 0;
            }
            p.dist =
              (Math.max(0, p.taxiS ?? 0) / Math.max(0.01, atc.holdShortS)) *
              p.track.holdShortDist;
          } else {
            p.speed = 0;
            p.accel = 0;
            p.steerKappa = 0;
            p._groundOmega = 0;
          }

          // Inbound arrival check
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
                const landingDist =
                  other.track.landingStartDist ?? other.track.totalLength;
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
            !atc ||
            (occIdx === 0 &&
              (p.taxiS ?? 0) >= atc.holdShortS - 0.15 &&
              p.speed <= 0.03);

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
              p.gearDir = 1;
              p.progress = Math.min(
                0.9999,
                p.dist / Math.max(0.001, p.track.totalLength),
              );
              break;
            }
          }

          p.progress = Math.min(
            0.9999,
            p.dist / Math.max(0.001, p.track.totalLength),
          );
          break;
        }

        case "TAKEOFF_ROLL": {
          p.phase = "TAKEOFF";
          p.holdingShort = false;
          p.gearDir = 1;
          const lineupEndDist =
            p.track.lineupEndDist ?? p.track.holdShortDist + 1.2;
          const cruiseStartDist =
            p.track.cruiseStartDist ?? p.track.totalLength;

          if (p.dist < lineupEndDist) {
            stepLongitudinalSpeed(p, 3.0, 2.2, 4.0, 18.0, effDt, 0.25);
          } else {
            const targetCruise =
              p.aircraftType === "FEEDER_TURBOPROP"
                ? (SIM_CONFIG.AVIATION.turbopropCruiseSpeed ?? 13.2)
                : SIM_CONFIG.AVIATION.cruiseSpeed;
            stepLongitudinalSpeed(p, targetCruise, 6.2, 4.0, 18.0, effDt, 0.35);
          }

          const ds = p.speed * effDt;
          const L =
            p.altitude === 0
              ? Math.max(0.35, p.speed * 0.1)
              : Math.max(1.8, p.speed * 0.22);
          const carrot = sampleFlightTrack(p.track, p.dist + L);
          stepGroundCarrot(
            p,
            carrot.x,
            carrot.y,
            effDt,
            p.altitude === 0 ? 2.5 : 2.4,
            p.altitude === 0 ? 5.5 : 18.0,
          );
          p.dist = projectFlightTrackDist(p.track, p.x, p.y, p.dist, ds);
          const sample = sampleFlightTrack(p.track, p.dist);
          p.altitude = sample.altitude;
          p.segIdx = sample.segIdx;
          p.progress = Math.min(
            0.9999,
            p.dist / Math.max(0.001, p.track.totalLength),
          );

          if (
            p.dist >= cruiseStartDist ||
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
          p.gearDir = 1;
          const isTurboprop = p.aircraftType === "FEEDER_TURBOPROP";
          const maxCruiseSpd = isTurboprop
            ? (SIM_CONFIG.AVIATION.turbopropCruiseSpeed ?? 13.2)
            : SIM_CONFIG.AVIATION.cruiseSpeed;
          const appLandSpd = isTurboprop
            ? (SIM_CONFIG.AVIATION.turbopropLandingSpeed ?? 9.8)
            : SIM_CONFIG.AVIATION.landingSpeed;
          const landingStartDist =
            p.track.landingStartDist ?? p.track.totalLength;
          /** @type {number} */
          let vDes = maxCruiseSpd;
          /** @type {number | null} */
          let kinAccel = null;
          if (!p.dest?.isExternal) {
            const dToLand = Math.max(0.05, landingStartDist - p.dist);
            const dEff = Math.max(
              0.02,
              dToLand - 0.14 * Math.max(0, p.speed - appLandSpd),
            );
            const vBrake = Math.sqrt(appLandSpd ** 2 + 2 * 4.2 * dEff);
            vDes = Math.min(maxCruiseSpd, vBrake);
            if (p.speed > vBrake) {
              kinAccel = (appLandSpd ** 2 - p.speed ** 2) / (2 * dToLand);
            }
          }
          stepLongitudinalSpeed(
            p,
            vDes,
            5.5,
            6.0,
            18.0,
            effDt,
            0.24,
            kinAccel,
            false,
          );

          const ds = p.speed * effDt;
          const L = Math.max(1.8, p.speed * 0.22);
          const carrot = sampleFlightTrack(p.track, p.dist + L);
          stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.4, 18.0);
          p.dist = projectFlightTrackDist(p.track, p.x, p.y, p.dist, ds);

          if (p.dest?.isExternal && p.dist >= p.track.totalLength - 0.35) {
            const prevOriginId =
              p.origin && !p.origin.isExternal ? p.origin.id : undefined;
            if (p.origin && !p.origin.isExternal) {
              p.origin.exportsCompleted = (p.origin.exportsCompleted || 0) + 1;
            }
            this.tripsCompleted += SIM_CONFIG.FLEET.flightTripWeight;
            p.origin = p.dest;

            let candAirports = this.world.airports;
            if (p.aircraftType === "WIDEBODY_FREIGHTER") {
              const wide = this.world.airports.filter((a) =>
                canWidebodyServe(a),
              );
              if (wide.length > 0) {
                candAirports = wide;
              } else {
                candAirports = this.world.airports;
                p.aircraftType = "FEEDER_TURBOPROP";
                p.isCargoFreighter = true;
              }
            }
            const otherCands = candAirports.filter(
              (a) => a.id !== prevOriginId,
            );
            const pool = otherCands.length > 0 ? otherCands : candAirports;
            const nextAp =
              pool[Math.floor(this.rng.next() * pool.length)] ||
              this.world.airports[0];

            /** @type {number | undefined} */
            let destGateLx;
            if (nextAp?.atc && nextAp.atc.gates.length > 0) {
              const freeGate = nextAp.atc.gates.find(
                (g) =>
                  g.state === "FREE" &&
                  g.occupiedBy === null &&
                  g.reservedBy === null,
              );
              if (freeGate) {
                freeGate.state = "RESERVED";
                freeGate.reservedBy = p.id ?? pIdx;
                p.reservedGateId = freeGate.id;
                destGateLx = freeGate.lx;
              }
            }

            p.track = buildFlightTrack(p.origin, nextAp, {
              isCargoFreighter: p.isCargoFreighter,
              aircraftType: p.aircraftType,
              destGateLx,
              dSign: nextAp.activeSign,
            });
            p.dest = nextAp;
            p.isExternalFlight = true;
            p.dist = 0;
            p.segIdx = 0;
            p.state = "ENROUTE_CRUISE";
            p.phase = "CRUISE";
            p.altitude = SIM_CONFIG.AVIATION.cruiseAlt;
            const s0 = sampleFlightTrack(p.track, 0);
            p.x = s0.x;
            p.y = s0.y;
            p.ang = s0.ang;
            p.speed = s0.speed;
            p.accel = 0;
            p.steerKappa = 0;
            p.progress = 0;
            p._importRecorded = false;
            break;
          }
          const sample = sampleFlightTrack(p.track, p.dist);
          p.altitude = sample.altitude;
          p.segIdx = sample.segIdx;
          p.progress = Math.min(
            0.9999,
            p.dist / Math.max(0.001, p.track.totalLength),
          );

          if (p.dist >= landingStartDist || sample.phase === "LANDING") {
            const destAtc = p.dest.atc;
            const planeId = p.id ?? pIdx;
            /** @type {GateSlot | null} */
            let freeGate = null;
            if (destAtc) {
              freeGate =
                destAtc.gates.find(
                  (g) =>
                    g.id === p.reservedGateId &&
                    g.occupiedBy === null &&
                    (g.reservedBy === planeId || g.reservedBy === null),
                ) ??
                destAtc.gates.find(
                  (g) =>
                    g.state === "FREE" &&
                    g.occupiedBy === null &&
                    g.reservedBy === null,
                ) ??
                null;
            }
            const rwyClear =
              !destAtc ||
              (freeGate !== null &&
                (destAtc.isHub
                  ? destAtc.arrRunwayBusyBy === null
                  : destAtc.runwayBusyBy === null &&
                    destAtc.holdShortQueue.length === 0));
            if (rwyClear) {
              if (destAtc) {
                if (freeGate) {
                  freeGate.state = "RESERVED";
                  freeGate.reservedBy = planeId;
                  p.reservedGateId = freeGate.id;
                  p.targetTaxiS = freeGate.taxiS;
                }
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
          p.gearDir = 1;
          const sample = sampleFlightTrack(p.track, p.dist);
          const destAtc = p.dest.atc;
          const qIdx = destAtc
            ? Math.max(0, destAtc.approachQueue.indexOf(p))
            : 0;
          const isTurboprop = p.aircraftType === "FEEDER_TURBOPROP";
          const appLandSpd = isTurboprop
            ? (SIM_CONFIG.AVIATION.turbopropLandingSpeed ?? 9.8)
            : SIM_CONFIG.AVIATION.landingSpeed;
          if (p._holdRAlong === undefined || p._holdRCross === undefined) {
            p._holdRAlong = 4.6 + qIdx * 0.85;
            p._holdRCross = 4.6 + qIdx * 0.85;
          }
          const rHold = p._holdRCross;
          const holdSpeed = appLandSpd * 0.82;
          const ux = Math.cos(sample.ang);
          const uy = Math.sin(sample.ang);
          const turnSign = -(p.dest.apronSide || 1);
          const nx = -uy * turnSign;
          const ny = ux * turnSign;
          const prevTheta = p.holdingPatternAngle ?? 0;
          const thetaProg = prevTheta + (p.speed * effDt) / rHold;
          const nextTurn =
            prevTheta > 0.05
              ? Math.ceil(prevTheta / (Math.PI * 2)) * (Math.PI * 2)
              : Math.PI * 2;

          let sepOk = false;
          const planeId = p.id ?? pIdx;
          /** @type {GateSlot | null} */
          let freeGate = null;
          if (destAtc) {
            freeGate =
              destAtc.gates.find(
                (g) =>
                  g.id === p.reservedGateId &&
                  g.occupiedBy === null &&
                  (g.reservedBy === planeId || g.reservedBy === null),
              ) ??
              destAtc.gates.find(
                (g) =>
                  g.state === "FREE" &&
                  g.occupiedBy === null &&
                  g.reservedBy === null,
              ) ??
              null;
          }
          if (qIdx === 0) {
            const arrClear =
              !destAtc ||
              (freeGate !== null &&
                (destAtc.isHub
                  ? destAtc.arrRunwayBusyBy === null
                  : destAtc.runwayBusyBy === null &&
                    destAtc.holdShortQueue.length === 0));
            sepOk = arrClear;
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
          }

          stepLongitudinalSpeed(
            p,
            holdSpeed,
            5.0,
            5.5,
            18.0,
            effDt,
            0.25,
            null,
            false,
          );

          const clearingOut = sepOk && thetaProg >= nextTurn - 0.55;
          let carrotX = sample.x;
          let carrotY = sample.y;
          if (clearingOut) {
            const lookSample = sampleFlightTrack(
              p.track,
              p.dist + Math.max(1.8, p.speed * 0.2),
            );
            carrotX = lookSample.x;
            carrotY = lookSample.y;
          } else {
            const lookTheta = thetaProg + 0.52;
            carrotX =
              sample.x +
              rHold * Math.sin(lookTheta) * ux +
              rHold * (1 - Math.cos(lookTheta)) * nx;
            carrotY =
              sample.y +
              rHold * Math.sin(lookTheta) * uy +
              rHold * (1 - Math.cos(lookTheta)) * ny;
          }

          stepGroundCarrot(p, carrotX, carrotY, effDt, 2.4, 18.0);
          p.holdingPatternAngle = thetaProg;
          p.altitude = Math.max(
            SIM_CONFIG.AVIATION.climbOutAlt,
            sample.altitude,
          );
          p.segIdx = sample.segIdx;
          p.progress = Math.min(
            0.9999,
            p.dist / Math.max(0.001, p.track.totalLength),
          );

          if (clearingOut && thetaProg >= nextTurn) {
            if (destAtc) {
              if (freeGate) {
                freeGate.state = "RESERVED";
                freeGate.reservedBy = planeId;
                p.reservedGateId = freeGate.id;
                p.targetTaxiS = freeGate.taxiS;
              }
              const idx = destAtc.approachQueue.indexOf(p);
              if (idx !== -1) destAtc.approachQueue.splice(idx, 1);
              if (destAtc.isHub) destAtc.arrRunwayBusyBy = p.id ?? null;
              else destAtc.runwayBusyBy = p.id ?? null;
              destAtc.lastOp = "ARRIVAL";
            }
            p._holdRAlong = undefined;
            p._holdRCross = undefined;
            p.holdingPatternAngle = 0;
            p.state = "LANDING_ROLLOUT";
            p.phase = "LANDING";
          }
          break;
        }

        case "LANDING_ROLLOUT": {
          p.phase = "LANDING";
          p.gearDir = 1;
          const taxiInStartDist =
            p.track.taxiInStartDist ?? p.track.totalLength;
          const destAtc = p.dest.atc;
          const crossSpan = destAtc ? (destAtc.isHub ? 2.75 : 1.06) : 1.06;
          const r1 = Math.min(0.45, crossSpan * 0.45);
          const exitTargetDist = taxiInStartDist - r1;
          const dToExit = Math.max(0.05, exitTargetDist - p.dist);
          const dEff = Math.max(
            0.02,
            dToExit -
              0.14 * Math.max(0, p.speed - SIM_CONFIG.AVIATION.taxiSpeed),
          );
          const vBrake = Math.sqrt(
            SIM_CONFIG.AVIATION.taxiSpeed ** 2 + 2 * 4.5 * dEff,
          );
          const vDes = Math.min(SIM_CONFIG.AVIATION.cruiseSpeed, vBrake);
          const kinAccel =
            p.speed > vBrake
              ? (SIM_CONFIG.AVIATION.taxiSpeed ** 2 - p.speed ** 2) /
                (2 * dToExit)
              : null;
          stepLongitudinalSpeed(
            p,
            vDes,
            5.5,
            6.2,
            18.0,
            effDt,
            0.24,
            kinAccel,
            false,
          );

          const ds = p.speed * effDt;
          const L =
            p.altitude === 0
              ? Math.max(0.35, p.speed * 0.1)
              : Math.max(1.8, p.speed * 0.22);
          const carrot = sampleFlightTrack(p.track, p.dist + L);
          stepGroundCarrot(
            p,
            carrot.x,
            carrot.y,
            effDt,
            p.altitude === 0 ? 2.5 : 2.4,
            p.altitude === 0 ? 5.5 : 18.0,
          );
          p.dist = projectFlightTrackDist(p.track, p.x, p.y, p.dist, ds);
          const sample = sampleFlightTrack(p.track, p.dist);
          p.altitude = sample.altitude;
          p.segIdx = sample.segIdx;
          p.progress = Math.min(
            0.9999,
            p.dist / Math.max(0.001, p.track.totalLength),
          );

          if (p.dist >= exitTargetDist || sample.phase === "TAXI_IN") {
            if (p.origin?.isExternal && p.dest && !p._importRecorded) {
              p.dest.importsCompleted = (p.dest.importsCompleted || 0) + 1;
              p._importRecorded = true;
            }
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
            const startS = -crossSpan - r1;
            p.dist = taxiInStartDist;
            p.taxiS = destAtc ? startS : 0;
            p._gatePullInS = destAtc ? startS : null;
            const depClear = destAtc
              ? destAtc.depRunwayBusyBy === null &&
                destAtc.crossingBusyBy === null &&
                destAtc.holdShortQueue.length === 0
              : true;
            const entryClear = destAtc
              ? destAtc.taxiwayOccupants.every(
                  (o) =>
                    (o.taxiS ?? 0) - startS >= 3.1 &&
                    Math.hypot(o.x - p.x, o.y - p.y) >= 1.85,
                )
              : true;
            if (destAtc && ((destAtc.isHub && !depClear) || !entryClear)) {
              p.state = "HOLD_CROSSING_RUNWAY";
              p.phase = "TAXI_IN";
              if (!destAtc.crossingQueue.includes(p)) {
                destAtc.crossingQueue.push(p);
              }
            } else {
              p.state = "TAXI_TO_GATE";
              p.phase = "TAXI_IN";
              if (destAtc) {
                if (destAtc.isHub) {
                  destAtc.crossingBusyBy = p.id ?? null;
                }
                if (!destAtc.taxiwayOccupants.includes(p)) {
                  destAtc.taxiwayOccupants.push(p);
                  maintainTaxiwayOrder(destAtc);
                }
              }
            }
          }
          break;
        }

        case "HOLD_CROSSING_RUNWAY": {
          p.phase = "TAXI_IN";
          p.altitude = 0;
          p.gearDir = 1;
          const destAtc = p.dest.atc;
          if (!destAtc) {
            p.state = "TAXI_TO_GATE";
            p.phase = "TAXI_IN";
          } else {
            const qIdx = Math.max(0, destAtc.crossingQueue.indexOf(p));
            const holdTargetS =
              (destAtc.isHub ? -1.94 : -0.35) -
              qIdx * (SIM_CONFIG.AVIATION.minTaxiSeparation + 0.08);
            const curS = p.taxiS ?? (destAtc.isHub ? -3.2 : -1.51);
            const dRem = Math.max(0, holdTargetS - curS);
            if (dRem > 6e-4 || p.speed > 0.01) {
              const vDes = computeStopEnvelopeSpeed(dRem, p.speed, 1.55, 2.2);
              stepLongitudinalSpeed(
                p,
                vDes,
                3.8,
                4.5,
                18.0,
                effDt,
                0.135,
                null,
                true,
              );
              const ds = Math.min(dRem, p.speed * effDt);
              p.taxiS = curS + ds;
              p._gatePullInS = p.taxiS;
              const carrot = taxiSpinePosToWorld(p.dest, p.taxiS + 0.44);
              stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.5, 5.5);
            } else {
              p.speed = 0;
              p.accel = 0;
              p.steerKappa = 0;
              p._groundOmega = 0;
            }
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
          p.gearDir = 1;
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
                g.occupiedBy === null &&
                (g.reservedBy === planeId || g.reservedBy === null),
            );
            if (gate && gate.reservedBy === null) {
              gate.state = "RESERVED";
              gate.reservedBy = planeId;
            }
            if (!gate) {
              p.reservedGateId = null;
              const freeGate = destAtc.gates.find(
                (g) =>
                  g.state === "FREE" &&
                  g.occupiedBy === null &&
                  g.reservedBy === null &&
                  g.taxiS >= (p.taxiS ?? 0) + 0.55,
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
                  (SIM_CONFIG.AVIATION.minTaxiSeparation + 0.08)
                : destAtc.holdShortS;

            if (gate) {
              const side = p.dest.apronSide || 1;
              const rGate = 0.52;
              const cyF = gate.taxiY + side * rGate;
              const loc = toLocal(p.dest, p.x, p.y);
              const prevPullS = p._gatePullInS ?? p.taxiS ?? 0;
              const gGuide = sampleGatePullInWorld(p.dest, gate, prevPullS);
              const onStraightLeadIn =
                prevPullS >= gGuide.sTurnStart + gGuide.filletLen * 0.55 &&
                (loc.ly - cyF) * side >= -0.12;
              const projS = projectGatePullInS(
                p.dest,
                gate,
                loc.lx,
                loc.ly,
                prevPullS,
              );
              // Leader constraint applies while on the taxiway spine before turning into the gate
              const spineBlockedNow =
                occIdx > 0 && maxAllowedS < gate.taxiS - 0.15;
              const standDistNow = Math.hypot(
                gate.worldX - p.x,
                gate.worldY - p.y,
              );
              const finalHomings =
                onStraightLeadIn &&
                !spineBlockedNow &&
                (gate.ly - loc.ly) * side <= 0.4;
              const curPullS = onStraightLeadIn
                ? gGuide.totalGateS -
                  (finalHomings
                    ? standDistNow
                    : Math.max(0, (gate.ly - loc.ly) * side))
                : Math.min(
                    gGuide.sTurnStart + gGuide.filletLen,
                    Math.max(prevPullS, projS),
                  );
              const limitPullS = spineBlockedNow
                ? maxAllowedS
                : gGuide.totalGateS;
              const dRem = Math.max(0, limitPullS - curPullS);
              const crossSpan = destAtc.isHub ? 2.75 : 1.06;
              const nearGateTurn = curPullS >= gGuide.sTurnStart - 0.65;
              const nearCorner =
                Math.abs(curPullS - -crossSpan) < 0.95 ||
                Math.abs(curPullS) < 0.95;
              const cornerCap = nearGateTurn
                ? 1.15
                : nearCorner
                  ? 1.45
                  : maxTaxiSpeed;
              const vDes = computeStopEnvelopeSpeed(
                dRem,
                p.speed,
                cornerCap,
                2.2,
              );
              stepLongitudinalSpeed(
                p,
                vDes,
                4.0,
                4.5,
                18.0,
                effDt,
                0.135,
                null,
                true,
              );
              const ds = Math.min(dRem, p.speed * effDt);
              p._gatePullInS = onStraightLeadIn
                ? curPullS + ds
                : Math.min(limitPullS, curPullS + ds);
              p.taxiS = Math.min(gate.taxiS, p._gatePullInS);
              p.targetTaxiS = gate.taxiS;
              if (!spineBlockedNow) {
                p.dist = Math.min(p.track.totalLength, p.dist + ds);
              }

              let carrot;
              if (finalHomings) {
                carrot = { x: gate.worldX, y: gate.worldY };
              } else if (onStraightLeadIn) {
                const L = Math.max(0.22, Math.min(0.34, dRem * 0.45 + 0.14));
                carrot = toWorld(p.dest, gate.lx, loc.ly + side * L);
              } else {
                carrot = sampleGatePullInWorld(
                  p.dest,
                  gate,
                  p._gatePullInS + 0.34,
                );
              }
              stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.8, 5.8);

              const standDistAfter = Math.hypot(
                gate.worldX - p.x,
                gate.worldY - p.y,
              );
              if (
                !spineBlockedNow &&
                standDistAfter <= 7e-4 &&
                p.speed <= 0.015
              ) {
                const idx = destAtc.taxiwayOccupants.indexOf(p);
                if (idx !== -1) destAtc.taxiwayOccupants.splice(idx, 1);
                releaseAllGatesForPlane(this.world, planeId);
                gate.state = "OCCUPIED";
                gate.occupiedBy = planeId;
                gate.reservedBy = null;
                p.gateId = gate.id;
                p.reservedGateId = null;
                p._gatePullInS = null;
                if (p.dest.id !== undefined) {
                  p.origin = p.dest;
                }
                p.dist = p.track.totalLength;
                p.phase = "GATE_DWELL";
                p.state = "GATE_LOADING";
                p.altitude = 0;
                p.speed = 0;
                p.accel = 0;
                p.steerKappa = 0;
                p._groundOmega = 0;
                p.progress = 0.999;
                p.dwellTimer = 0;
                continue;
              }
            } else {
              // Waiting for a gate to open: hold smoothly at preGateHoldS
              const limitS = Math.min(maxAllowedS, destAtc.preGateHoldS);
              p.targetTaxiS = destAtc.preGateHoldS;
              const dRem = Math.max(0, limitS - (p.taxiS ?? 0));
              const crossSpan = destAtc.isHub ? 2.75 : 1.06;
              const nearCorner =
                Math.abs((p.taxiS ?? 0) - -crossSpan) < 0.95 ||
                Math.abs(p.taxiS ?? 0) < 0.95;
              const cornerCap = nearCorner ? 1.45 : maxTaxiSpeed;
              const vDes = computeStopEnvelopeSpeed(
                dRem,
                p.speed,
                cornerCap,
                2.2,
              );
              stepLongitudinalSpeed(
                p,
                vDes,
                4.0,
                4.5,
                18.0,
                effDt,
                0.135,
                null,
                true,
              );
              const ds = Math.min(dRem, p.speed * effDt);
              p.taxiS = (p.taxiS ?? 0) + ds;
              p._gatePullInS = p.taxiS;
              const carrot = taxiSpinePosToWorld(p.dest, p.taxiS + 0.44);
              stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.5, 5.5);
            }

            p.progress = Math.min(
              0.9999,
              p.dist / Math.max(0.001, p.track.totalLength),
            );
          } else {
            const dRem = Math.max(0, p.track.totalLength - p.dist);
            const vDes = computeStopEnvelopeSpeed(
              dRem,
              p.speed,
              maxTaxiSpeed,
              2.2,
            );
            stepLongitudinalSpeed(
              p,
              vDes,
              4.0,
              4.5,
              18.0,
              effDt,
              0.135,
              null,
              true,
            );
            const ds = Math.min(dRem, p.speed * effDt);
            p.dist += ds;
            const carrot = sampleFlightTrack(p.track, p.dist + 0.44);
            stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.5, 5.5);
            if (dRem <= 6e-4 && p.speed <= 0.015) {
              p.dist = p.track.totalLength;
              p.phase = "GATE_DWELL";
              p.state = "GATE_LOADING";
              p.altitude = 0;
              p.speed = 0;
              p.accel = 0;
              p.steerKappa = 0;
              p._groundOmega = 0;
              p.progress = 0.999;
              p.dwellTimer = 0;
              releaseAllGatesForPlane(this.world, planeId);
              if (p.dest.id !== undefined) {
                p.origin = p.dest;
              }
              continue;
            }
            const sample = sampleFlightTrack(p.track, p.dist);
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

    for (const ap of this.world.airports) {
      if (ap.atc) {
        maintainTaxiwayOrder(ap.atc);
      }
    }
  }
}
