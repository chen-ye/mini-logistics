/**
 * 10-State Non-Holonomic Aircraft FSM & Jerk-Bounded Flight/Taxi Physics (`plane-fsm.js`).
 *
 * Implements the pure-pursuit wheel-rolling / flight carrot integrator, overdamped
 * stopping speed envelopes, reverse tug pushback L-fillets, gate pull-in homing,
 * external international corridor turnarounds, and `PLANE_STATE_HANDLERS` dispatch
 * coordinated through `AirportATCController` single-writer arbitrators.
 *
 * Invariants:
 * - 100% Worker-safe: zero window, document, or DOM references.
 * - Guarantees `hypot(dx, dy) / effDt === p.speed`, zero ground sideslip, and zero turntable spin when stopped.
 * - Routes all terminal gate, taxiway, crossing, runway, and queue mutations through `AirportATCController`.
 *
 * @import { AircraftType, Airport, CargoManifest, FlightPhase, GateSlot, PlaneAgent, PlaneEndpoint, PlaneFSMState } from "../../types.js"
 * @import { LogisticsSimulator } from "../../simulator.js"
 */
import { SIM_CONFIG } from "../../constants.js";
import {
  localToWorldAirfield,
  normalizeAngle,
  taxiSpinePosToWorld,
  worldToLocalAirfield,
} from "../airport/layout.js";
import {
  buildFlightTrack,
  canWidebodyServe,
  createExternalEndpoint,
  projectFlightTrackDist,
  sampleFlightTrack,
} from "./flight-track.js";

/** @type { readonly ["ELECTRONICS", "HARDWARE", "CONSUMER_GOODS", "GROCERIES"] } */
const AIR_FREIGHT_COMMODITIES = [
  "ELECTRONICS",
  "HARDWARE",
  "CONSUMER_GOODS",
  "GROCERIES",
];

/**
 * Canonical mapping from each of the 10 `PlaneFSMState` states to its corresponding `FlightPhase`.
 *
 * @type {Readonly<Record<PlaneFSMState, FlightPhase>>}
 */
export const STATE_TO_PHASE = {
  GATE_LOADING: "GATE_DWELL",
  PUSHBACK_HOLD: "TAXI_OUT",
  TAXI_TO_RUNWAY: "TAXI_OUT",
  HOLD_SHORT_QUEUE: "TAXI_OUT",
  TAKEOFF_ROLL: "TAKEOFF",
  ENROUTE_CRUISE: "CRUISE",
  APPROACH_QUEUE: "CRUISE",
  LANDING_ROLLOUT: "LANDING",
  HOLD_CROSSING_RUNWAY: "TAXI_IN",
  TAXI_TO_GATE: "TAXI_IN",
};

/**
 * Transitions `p.state` and synchronizes `p.phase` deterministically.
 *
 * @param {PlaneAgent} p
 * @param {PlaneFSMState} nextState
 */
export function transitionPlaneState(p, nextState) {
  p.state = nextState;
  p.phase = STATE_TO_PHASE[nextState];
}

/**
 * Synchronizes `p.pose` (`Pose2D`) from the aircraft's current world kinematics and altitude.
 *
 * @param {PlaneAgent} p
 */
export function syncPlanePose(p) {
  const altitude = p.altitude ?? 0;
  /** @type {"air" | "ground"} */
  const zLayer = altitude > 0.04 ? "air" : "ground";
  const speed = p.speed ?? 0;
  if (p.pose) {
    p.pose.x = p.x;
    p.pose.y = p.y;
    p.pose.ang = p.ang;
    p.pose.zLayer = zLayer;
    p.pose.speed = speed;
    p.pose.altitude = altitude;
  } else {
    p.pose = {
      x: p.x,
      y: p.y,
      ang: p.ang,
      zLayer,
      speed,
      altitude,
    };
  }
}

/**
 * Builds a deterministic `CargoManifest` for air freighter flights (or `null` for passenger jets).
 * Never consumes RNG state so simulation trajectory determinism is 100% preserved.
 *
 * @param {PlaneAgent} p
 * @returns {CargoManifest | null}
 */
function buildPlaneManifest(p) {
  if (!p.isCargoFreighter && p.aircraftType !== "WIDEBODY_FREIGHTER") {
    return null;
  }
  const originIsExt = Boolean(p.origin?.isExternal);
  const destIsExt = Boolean(p.dest?.isExternal);
  const originId = typeof p.origin?.id === "number" ? p.origin.id : -1;
  const destId = typeof p.dest?.id === "number" ? p.dest.id : -1;
  const gatewayId = originIsExt
    ? destId >= 0
      ? destId
      : null
    : originId >= 0
      ? originId
      : null;
  const stage = originIsExt
    ? "IMPORT->LOG"
    : destIsExt
      ? "MFG->EXPORT"
      : "LOG->COM";
  const commodity =
    AIR_FREIGHT_COMMODITIES[
      Math.abs(p.id ?? 0) % AIR_FREIGHT_COMMODITIES.length
    ];
  const units = p.aircraftType === "WIDEBODY_FREIGHTER" ? 4 : 2;
  return {
    commodity,
    stage,
    originId,
    destId,
    gatewayId,
    units,
  };
}

/**
 * Moves a scalar value toward `target` by at most `maxDelta`.
 *
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
 * Computes an overdamped kinematic stopping speed profile for remaining distance `dRem` to a full stop.
 *
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
 *
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
 * Guarantees `hypot(dx, dy) / effDt === p.speed`, zero ground sideslip, and zero turntable spin when stopped.
 *
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
 * Evaluates the reverse tug pushback L-fillet guide path in world coordinates at arc distance `s`.
 *
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
  const w = localToWorldAirfield(ap, lx, ly);
  return { x: w.x, y: w.y, sStop };
}

/**
 * Evaluates the L-fillet gate pull-in guide path in world coordinates at arc coordinate `s`.
 *
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
  const w = localToWorldAirfield(ap, lx, ly);
  return { x: w.x, y: w.y, sTurnStart, filletLen, totalGateS };
}

/**
 * Projects `(lx, ly)` onto the L-fillet gate pull-in guide path to obtain monotonic progress `s`.
 *
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

// =============================================================================
// Fleet Initialization & External Test Mutation Reconciliation
// =============================================================================

/**
 * Spawns a single aircraft agent onto the aviation network.
 *
 * @param {LogisticsSimulator} sim
 * @param {number} [initialProgress=0]
 */
export function spawnPlane(sim, initialProgress = 0) {
  const { world, rng } = sim;
  if (world.airports.length === 0) return;

  for (const ap of world.airports) {
    ap.importsCompleted ??= 0;
    ap.exportsCompleted ??= 0;
  }

  const id =
    typeof sim.allocatePlaneId === "function"
      ? sim.allocatePlaneId()
      : sim.planes.length;
  const planeIdx = id;
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
  if (
    aircraftType === "WIDEBODY_FREIGHTER" &&
    (!canWidebodyServe(origin) || !canWidebodyServe(dest))
  ) {
    aircraftType = "FEEDER_TURBOPROP";
    isCargoFreighter = true;
  }

  // Hard Invariant: If world has any REG airports and planeCount >= 4, ensure at least one plane is FEEDER_TURBOPROP serving REG
  const hasRegAirports = world.airports.some((a) => !canWidebodyServe(a));
  if (hasRegAirports && planeCount >= 4 && planeIdx === planeCount - 1) {
    const alreadyHasFeederReg = sim.planes.some(
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

  const originCtrl = sim.getATCController(origin);
  const destCtrl = sim.getATCController(dest);
  const originAtc = originCtrl?.state ?? null;
  const destAtc = destCtrl?.state ?? null;

  /** @type {GateSlot | null} */
  const chosenOriginGate =
    originCtrl && originCtrl.state.gates.length > 0
      ? originCtrl.occupyGate(planeIdx)
      : null;
  /** @type {number | null} */
  let gateId = chosenOriginGate ? chosenOriginGate.id : null;

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
    if (chosenOriginGate && originCtrl) {
      originCtrl.releaseGatesForPlane(planeIdx);
      gateId = null;
    }
    if (sample.phase === "TAXI_OUT") {
      if (dist >= track.holdShortDist - 0.25) {
        state = "HOLD_SHORT_QUEUE";
        taxiS = originAtc?.holdShortS ?? 10;
      } else {
        state = "TAXI_TO_RUNWAY";
        const rawS = originAtc
          ? (dist / Math.max(0.01, track.holdShortDist)) * originAtc.holdShortS
          : 5;
        taxiS = originAtc
          ? Math.max(0.8, Math.min(originAtc.holdShortS - 2.4, rawS))
          : rawS;
      }
    } else if (sample.phase === "TAKEOFF") {
      state = "TAKEOFF_ROLL";
      originCtrl?.forceOccupyDepartureRunway(planeIdx);
    } else if (sample.phase === "CRUISE") {
      state = "ENROUTE_CRUISE";
    } else if (sample.phase === "LANDING") {
      state = "LANDING_ROLLOUT";
      destCtrl?.forceOccupyLandingRunway(planeIdx);
    } else if (sample.phase === "TAXI_IN") {
      state = "TAXI_TO_GATE";
      if (destCtrl && destCtrl.state.gates.length > 0) {
        const freeGate = destCtrl.reserveArrivalGate(planeIdx);
        if (freeGate) {
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
    phase: STATE_TO_PHASE[state],
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
    manifest: null,
  };
  planeAgent.manifest = buildPlaneManifest(planeAgent);

  destCtrl?.registerInbound(planeIdx);

  if (state === "TAXI_TO_RUNWAY" || state === "HOLD_SHORT_QUEUE") {
    if (originCtrl) {
      originCtrl.enterTaxiway(planeAgent, planeAgent.taxiS ?? 0);
      const wPos = originCtrl.spinePosToWorld(planeAgent.taxiS ?? 0);
      planeAgent.x = wPos.x;
      planeAgent.y = wPos.y;
      planeAgent.ang = wPos.ang;
      if (state === "HOLD_SHORT_QUEUE") {
        originCtrl.enqueueHoldShort(planeAgent);
      }
    }
  } else if (state === "TAXI_TO_GATE") {
    if (destCtrl) {
      destCtrl.enterTaxiway(planeAgent, planeAgent.taxiS ?? 0);
      const wPos = destCtrl.spinePosToWorld(planeAgent.taxiS ?? 0);
      planeAgent.x = wPos.x;
      planeAgent.y = wPos.y;
      planeAgent.ang = wPos.ang;
      planeAgent._gatePullInS = planeAgent.taxiS ?? 0;
    }
  }

  syncPlanePose(planeAgent);
  sim.planes.push(planeAgent);
  planeAgent._lastSimDist = planeAgent.dist;
  planeAgent._lastSimState = planeAgent.state;
  planeAgent._lastSimPhase = planeAgent.phase;
}

/**
 * Spawns the initial aviation fleet across all placed airports (with 3x multiplier in `island-hopper` mode).
 *
 * @param {LogisticsSimulator} sim
 */
export function spawnInitialPlanes(sim) {
  const { world } = sim;
  if (world.airports.length === 0) return;

  const mult =
    world.config.archetype === "island-hopper"
      ? SIM_CONFIG.FLEET.islandHopperPlanesPerAirport
      : SIM_CONFIG.FLEET.basePlanesPerAirport;
  const planeCount = Math.max(2, world.airports.length * mult);
  for (let i = 0; i < planeCount; i++) {
    spawnPlane(sim, i / planeCount);
  }
}

/**
 * Normalizes synthetic `PlaneAgent` fixtures and reconciles external mutations to `p.dist`, `p.state`, or `p.phase`.
 *
 * @param {LogisticsSimulator} sim
 */
export function normalizePlanesForExternalMutations(sim) {
  for (let pIdx = 0; pIdx < sim.planes.length; pIdx++) {
    const p = sim.planes[pIdx];
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
    p.isExternalFlight ??= Boolean(p.origin?.isExternal || p.dest?.isExternal);
    if (p.accel === undefined) p.accel = 0;
    if (p.steerKappa === undefined) p.steerKappa = 0;
    if (p.gearDir === undefined) p.gearDir = 1;
    if (p._groundOmega === undefined) p._groundOmega = 0;
    if (p._pushbackStage === undefined) p._pushbackStage = null;
    if (p._pushbackS === undefined) p._pushbackS = 0;
    if (p._gatePullInS === undefined) p._gatePullInS = null;
    if (p.manifest === undefined) p.manifest = buildPlaneManifest(p);
    if (!p.pose) syncPlanePose(p);

    const externallyMutated =
      p._lastSimDist === undefined ||
      Math.abs(p.dist - p._lastSimDist) > 1e-5 ||
      p.state !== p._lastSimState ||
      p.phase !== p._lastSimPhase;
    if (!externallyMutated) continue;

    // Initialize state from phase if undefined (e.g. synthetic test objects)
    if (!p.state) {
      if (p.phase === "GATE_DWELL") {
        transitionPlaneState(p, "GATE_LOADING");
      } else if (p.phase === "TAXI_OUT") {
        if (p.dist >= p.track.holdShortDist - 0.25) {
          transitionPlaneState(p, "HOLD_SHORT_QUEUE");
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
          transitionPlaneState(p, "TAXI_TO_RUNWAY");
        }
      } else if (p.phase === "TAKEOFF") {
        transitionPlaneState(p, "TAKEOFF_ROLL");
      } else if (p.phase === "CRUISE") {
        transitionPlaneState(p, "ENROUTE_CRUISE");
      } else if (p.phase === "LANDING") {
        transitionPlaneState(p, "LANDING_ROLLOUT");
      } else if (p.phase === "TAXI_IN") {
        transitionPlaneState(p, "TAXI_TO_GATE");
      } else {
        transitionPlaneState(p, "GATE_LOADING");
      }
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
        transitionPlaneState(
          p,
          p.dist >= p.track.holdShortDist - 0.25
            ? "HOLD_SHORT_QUEUE"
            : "TAXI_TO_RUNWAY",
        );
      } else if (s.phase === "TAKEOFF") {
        transitionPlaneState(p, "TAKEOFF_ROLL");
      } else if (s.phase === "CRUISE") {
        transitionPlaneState(p, "ENROUTE_CRUISE");
      } else if (s.phase === "LANDING") {
        transitionPlaneState(p, "LANDING_ROLLOUT");
      } else if (s.phase === "TAXI_IN") {
        transitionPlaneState(p, "TAXI_TO_GATE");
        const destCtrl = sim.getATCController(p.dest);
        if (destCtrl && destCtrl.state.gates.length > 0) {
          const g =
            destCtrl.state.gates.find(
              (x) => x.state === "FREE" && x.occupiedBy === null,
            ) ?? destCtrl.state.gates[0];
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
      transitionPlaneState(p, "TAXI_TO_GATE");
      sim.getATCController(p.dest)?.releaseRunwayForPlane(p.id);
    } else if (p.phase === "TAXI_OUT" && p.state === "GATE_LOADING") {
      transitionPlaneState(p, "TAXI_TO_RUNWAY");
    } else if (
      p.phase === "GATE_DWELL" &&
      p.state !== "GATE_LOADING" &&
      p.state !== "PUSHBACK_HOLD"
    ) {
      transitionPlaneState(p, "GATE_LOADING");
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

    syncPlanePose(p);
  }
}

// =============================================================================
// 10-State Aircraft FSM Step Handlers
// =============================================================================

/**
 * State 1: `GATE_LOADING` — Parked at terminal stand, dwelling for cargo/passenger turnaround.
 *
 * @param {PlaneAgent} p
 * @param {number} pIdx
 * @param {LogisticsSimulator} sim
 * @param {number} effDt
 */
export function stepGateLoading(p, pIdx, sim, effDt) {
  p.altitude = 0;
  p.speed = 0;
  p.accel = 0;
  p.steerKappa = 0;
  p._groundOmega = 0;
  p.gearDir = 1;
  p.progress = 0.999;
  transitionPlaneState(p, "GATE_LOADING");
  p.dwellTimer += effDt;

  const planeId = p.id ?? pIdx;
  const originCtrl = sim.getATCController(p.origin);
  if (originCtrl && p.gateId === null) {
    sim.releaseAllGatesForPlane(planeId);
    const freeGate = originCtrl.occupyGate(planeId);
    if (freeGate) {
      p.gateId = freeGate.id;
      p.x = freeGate.worldX;
      p.y = freeGate.worldY;
      p.ang = freeGate.noseAngle;
    }
  }

  if (p.dwellTimer < SIM_CONFIG.AVIATION.gateDwellSec) return;

  sim.tripsCompleted += SIM_CONFIG.FLEET.flightTripWeight;
  if (p.dest && p.dest.id !== undefined && p.gateId === null) {
    p.origin = p.dest;
  }
  if (p.origin?.isExternal && p.dest && !p._importRecorded) {
    p.dest.importsCompleted = (p.dest.importsCompleted || 0) + 1;
    p._importRecorded = true;
  }

  sim.getATCController(p.dest)?.unregisterInbound(planeId);

  const currentOrigin = p.origin;
  /** @type {Airport | PlaneEndpoint | null} */
  let nextDest = null;

  if (p.aircraftType === "WIDEBODY_FREIGHTER") {
    const wideOthers = sim.world.airports.filter(
      (a) => canWidebodyServe(a) && a.id !== currentOrigin.id,
    );
    const roll = sim.rng.next();
    if (
      wideOthers.length === 0 ||
      ((currentOrigin.isHub || currentOrigin.airportClass === "CRG") &&
        roll < 0.3)
    ) {
      nextDest = createExternalEndpoint(
        currentOrigin,
        (p.id ?? 0) + Math.floor(sim.simTime),
        sim.world.W,
        sim.world.H,
      );
    } else {
      nextDest = wideOthers[Math.floor(sim.rng.next() * wideOthers.length)];
    }
  } else if (
    (currentOrigin.isHub || currentOrigin.airportClass === "CRG") &&
    sim.rng.next() < 0.18
  ) {
    nextDest = createExternalEndpoint(
      currentOrigin,
      p.id ?? 0,
      sim.world.W,
      sim.world.H,
    );
  } else if (sim.world.airports.length > 1) {
    const others = sim.world.airports.filter((a) => a.id !== currentOrigin.id);
    const withCap = others.filter((a) => {
      if (!a.atc) return true;
      const activeCount = sim.planes.filter(
        (pl) =>
          pl !== p &&
          ((pl.dest.id === a.id &&
            pl.state !== "GATE_LOADING" &&
            pl.state !== "PUSHBACK_HOLD") ||
            (pl.origin.id === a.id &&
              (pl.state === "GATE_LOADING" || pl.state === "PUSHBACK_HOLD"))),
      ).length;
      return activeCount < a.atc.gates.length;
    });
    const pool = withCap.length > 0 ? withCap : others;
    nextDest = pool[Math.floor(sim.rng.next() * pool.length)];
  } else {
    nextDest = createExternalEndpoint(
      currentOrigin,
      p.id ?? 0,
      sim.world.W,
      sim.world.H,
    );
  }

  if (!nextDest) return;

  p.dest = nextDest;
  if (
    p.aircraftType === "WIDEBODY_FREIGHTER" &&
    (!canWidebodyServe(p.origin) || !canWidebodyServe(nextDest))
  ) {
    p.aircraftType = "FEEDER_TURBOPROP";
  }
  p.isCargoFreighter =
    p.aircraftType === "WIDEBODY_FREIGHTER" ||
    p.aircraftType === "FEEDER_TURBOPROP" ||
    p.origin.airportClass === "CRG" ||
    p.dest.airportClass === "CRG";
  p.isExternalFlight = Boolean(p.origin.isExternal || nextDest.isExternal);
  p._importRecorded = false;
  p.manifest = buildPlaneManifest(p);

  const newCtrl = sim.getATCController(p.origin);
  const destCtrl = sim.getATCController(p.dest);
  destCtrl?.registerInbound(planeId);

  const curGate = newCtrl ? newCtrl.findTurnaroundGate(planeId) : null;
  const destGate =
    destCtrl && destCtrl.state.gates.length > 0
      ? (destCtrl.findAvailableArrivalGate(planeId) ??
        destCtrl.state.gates[planeId % destCtrl.state.gates.length])
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

  if (newCtrl && curGate) {
    sim.releaseAllGatesForPlane(planeId);
    newCtrl.occupyGate(planeId, curGate.id);
    p.gateId = curGate.id;
    p.taxiS = curGate.taxiS;
    p.targetTaxiS = newCtrl.state.holdShortS;
    transitionPlaneState(p, "PUSHBACK_HOLD");
  } else {
    sim.releaseAllGatesForPlane(planeId);
    transitionPlaneState(p, "TAXI_TO_RUNWAY");
  }
}

/**
 * State 2: `PUSHBACK_HOLD` — Holding in gate bay awaiting ATC clearance onto parallel taxiway spine.
 *
 * @param {PlaneAgent} p
 * @param {number} _pIdx
 * @param {LogisticsSimulator} sim
 * @param {number} effDt
 */
export function stepPushbackHold(p, _pIdx, sim, effDt) {
  p.altitude = 0;
  p.speed = 0;
  p.accel = 0;
  p.steerKappa = 0;
  p._groundOmega = 0;
  p.gearDir = 1;
  transitionPlaneState(p, "PUSHBACK_HOLD");
  p.pushbackTimer = (p.pushbackTimer ?? 0) + effDt;
  if (!sim.getATCController(p.origin)) {
    transitionPlaneState(p, "TAXI_TO_RUNWAY");
  }
}

/**
 * State 3: `TAXI_TO_RUNWAY` — Stage A reverse tug pushback L-fillet followed by Stage B forward spine taxi.
 *
 * @param {PlaneAgent} p
 * @param {number} pIdx
 * @param {LogisticsSimulator} sim
 * @param {number} effDt
 */
export function stepTaxiToRunway(p, pIdx, sim, effDt) {
  transitionPlaneState(p, "TAXI_TO_RUNWAY");
  p.altitude = 0;
  const maxTaxiSpeed = SIM_CONFIG.AVIATION.taxiSpeed;
  const originCtrl = sim.getATCController(p.origin);
  const planeId = p.id ?? pIdx;

  if (originCtrl) {
    const atc = originCtrl.state;
    if (!atc.taxiwayOccupants.includes(p)) {
      if ((p.taxiS ?? 0) === 0 && p.dist > 0) {
        p.taxiS =
          (p.dist / Math.max(0.01, p.track.holdShortDist)) * atc.holdShortS;
      }
      originCtrl.enterTaxiway(p, p.taxiS);
    } else {
      originCtrl.maintainOrder();
    }

    // Stage A: Reverse Tug Pushback (p.gearDir = -1) along L-fillet onto taxiway spine
    if (p._pushbackStage === "REVERSE" && p.pushbackOriginGateId !== null) {
      const gate = atc.gates.find((g) => g.id === p.pushbackOriginGateId);
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
        originCtrl.updateTaxiwayPos(p, Math.max(0, gate.taxiS - 0.52));

        if (dRem <= 8e-4 && p.speed <= 0.015) {
          p.speed = 0;
          p.accel = 0;
          p.steerKappa = 0;
          p._groundOmega = 0;
          p.gearDir = 1;
          p._pushbackStage = "FORWARD";
          p.pushbackOriginGateId = null;
          p.pushbackOriginS = null;
          const loc = worldToLocalAirfield(p.origin, p.x, p.y);
          p.taxiS = Math.max(0, (atc.exitRwyX - loc.lx) * atc.activeSign);
          sim.releaseAllGatesForPlane(planeId);
        }
        return;
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
    const vDes = computeStopEnvelopeSpeed(dRem, p.speed, cornerCap, 2.2);
    stepLongitudinalSpeed(p, vDes, 4.0, 4.5, 18.0, effDt, 0.135, null, true);
    const ds = Math.min(dRem, p.speed * effDt);
    p.taxiS = (p.taxiS ?? 0) + ds;
    const carrot = originCtrl.spinePosToWorld(p.taxiS + 0.34);
    stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.5, 5.5);

    // Single-runway arrival inbound check at the hold-short line
    const arrivalInbound =
      !p.origin.isHub && (p.taxiS ?? 0) >= atc.holdShortS - 0.35
        ? originCtrl.hasImminentInbound(
            planeId,
            sim.planesById,
            SIM_CONFIG.AVIATION.holdShortLookaheadTiles,
          )
        : false;

    p.dist =
      (Math.max(0, p.taxiS ?? 0) / Math.max(0.01, atc.holdShortS)) *
      p.track.holdShortDist;

    if (
      (atc.holdShortS - p.taxiS <= 0.08 && p.speed <= 0.03) ||
      (arrivalInbound && p.taxiS >= atc.holdShortS - 0.25)
    ) {
      p.dist = Math.min(p.dist, p.track.holdShortDist);
      p.holdingShort = true;
      transitionPlaneState(p, "HOLD_SHORT_QUEUE");
      originCtrl.enqueueHoldShort(p);
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
    const vDes = computeStopEnvelopeSpeed(dRem, p.speed, maxTaxiSpeed, 2.2);
    stepLongitudinalSpeed(p, vDes, 4.0, 4.5, 18.0, effDt, 0.135, null, true);
    const ds = Math.min(dRem, p.speed * effDt);
    p.dist += ds;
    const carrot = sampleFlightTrack(p.track, p.dist + 0.45);
    stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.5, 5.5);
    if (dRem <= 0.08 && p.speed <= 0.03) {
      transitionPlaneState(p, "HOLD_SHORT_QUEUE");
    }
    const sample = sampleFlightTrack(p.track, p.dist);
    p.segIdx = sample.segIdx;
    p.progress = Math.min(
      0.9999,
      p.dist / Math.max(0.001, p.track.totalLength),
    );
  }
}

/**
 * State 4: `HOLD_SHORT_QUEUE` — Holding clear of active departure runway threshold awaiting ATC takeoff clearance.
 *
 * @param {PlaneAgent} p
 * @param {number} pIdx
 * @param {LogisticsSimulator} sim
 * @param {number} effDt
 */
export function stepHoldShortQueue(p, pIdx, sim, effDt) {
  transitionPlaneState(p, "HOLD_SHORT_QUEUE");
  p.altitude = 0;
  p.gearDir = 1;
  p.holdingShort = true;
  p.dist = Math.min(p.dist, p.track.holdShortDist);

  const originCtrl = sim.getATCController(p.origin);
  const planeId = p.id ?? pIdx;
  let occIdx = -1;

  if (originCtrl) {
    const atc = originCtrl.state;
    if (!atc.taxiwayOccupants.includes(p)) {
      if ((p.taxiS ?? 0) === 0) p.taxiS = atc.holdShortS;
      originCtrl.enterTaxiway(p, p.taxiS);
    }
    originCtrl.enqueueHoldShort(p);
    originCtrl.maintainOrder();

    occIdx = atc.taxiwayOccupants.indexOf(p);
    const maxAllowedS =
      occIdx > 0
        ? (atc.taxiwayOccupants[occIdx - 1].taxiS ?? 0) -
          (SIM_CONFIG.AVIATION.minTaxiSeparation + 0.08)
        : atc.holdShortS;
    const dRem = Math.max(0, maxAllowedS - (p.taxiS ?? 0));
    if (dRem > 6e-4 || p.speed > 0.01) {
      const vDes = computeStopEnvelopeSpeed(dRem, p.speed, 1.65, 2.2);
      stepLongitudinalSpeed(p, vDes, 3.8, 4.5, 18.0, effDt, 0.135, null, true);
      const ds = Math.min(dRem, p.speed * effDt);
      p.taxiS = (p.taxiS ?? 0) + ds;
      const carrot = originCtrl.spinePosToWorld(p.taxiS + 0.45);
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

  let arrivalInbound = false;
  if (originCtrl) {
    arrivalInbound = originCtrl.hasImminentInbound(
      planeId,
      sim.planesById,
      SIM_CONFIG.AVIATION.holdShortLookaheadTiles,
    );
  } else if (!p.origin.isHub && p.origin.id !== undefined) {
    for (let oIdx = 0; oIdx < sim.planes.length; oIdx++) {
      if (oIdx === pIdx) continue;
      const other = sim.planes[oIdx];
      if (other.dest && other.dest.id === p.origin.id) {
        const landingDist =
          other.track.landingStartDist ?? other.track.totalLength;
        const distRemaining = landingDist - other.dist;
        const inCruiseApproach =
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
    !originCtrl ||
    (occIdx === 0 &&
      (p.taxiS ?? 0) >= originCtrl.state.holdShortS - 0.15 &&
      p.speed <= 0.03);

  if (!arrivalInbound && isHeadOfLine) {
    const cleared = originCtrl
      ? originCtrl.acquireRunwayForDeparture(planeId)
      : true;
    if (cleared) {
      if (originCtrl) {
        originCtrl.dequeueHoldShort(p);
        originCtrl.leaveTaxiway(p);
      }
      p.holdingShort = false;
      transitionPlaneState(p, "TAKEOFF_ROLL");
      p.dist = p.track.holdShortDist;
      p.gearDir = 1;
      p.progress = Math.min(
        0.9999,
        p.dist / Math.max(0.001, p.track.totalLength),
      );
      return;
    }
  }

  p.progress = Math.min(0.9999, p.dist / Math.max(0.001, p.track.totalLength));
}

/**
 * State 5: `TAKEOFF_ROLL` — Runway lineup turn, ground acceleration roll, rotation, and initial climb-out.
 *
 * @param {PlaneAgent} p
 * @param {number} pIdx
 * @param {LogisticsSimulator} sim
 * @param {number} effDt
 */
export function stepTakeoffRoll(p, pIdx, sim, effDt) {
  transitionPlaneState(p, "TAKEOFF_ROLL");
  p.holdingShort = false;
  p.gearDir = 1;
  const lineupEndDist = p.track.lineupEndDist ?? p.track.holdShortDist + 1.2;
  const cruiseStartDist = p.track.cruiseStartDist ?? p.track.totalLength;

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
  p.progress = Math.min(0.9999, p.dist / Math.max(0.001, p.track.totalLength));

  if (
    p.dist >= cruiseStartDist ||
    sample.phase === "CRUISE" ||
    p.altitude >= SIM_CONFIG.AVIATION.climbOutAlt * 0.95
  ) {
    sim.getATCController(p.origin)?.releaseRunwayForPlane(p.id ?? pIdx);
    transitionPlaneState(p, "ENROUTE_CRUISE");
  }
}

/**
 * State 6: `ENROUTE_CRUISE` — Cruise airway flight, off-map international turnaround, and final approach entry.
 *
 * @param {PlaneAgent} p
 * @param {number} pIdx
 * @param {LogisticsSimulator} sim
 * @param {number} effDt
 */
export function stepEnrouteCruise(p, pIdx, sim, effDt) {
  transitionPlaneState(p, "ENROUTE_CRUISE");
  p.gearDir = 1;
  const isTurboprop = p.aircraftType === "FEEDER_TURBOPROP";
  const maxCruiseSpd = isTurboprop
    ? (SIM_CONFIG.AVIATION.turbopropCruiseSpeed ?? 13.2)
    : SIM_CONFIG.AVIATION.cruiseSpeed;
  const appLandSpd = isTurboprop
    ? (SIM_CONFIG.AVIATION.turbopropLandingSpeed ?? 9.8)
    : SIM_CONFIG.AVIATION.landingSpeed;
  const landingStartDist = p.track.landingStartDist ?? p.track.totalLength;
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
  stepLongitudinalSpeed(p, vDes, 5.5, 6.0, 18.0, effDt, 0.24, kinAccel, false);

  const ds = p.speed * effDt;
  const L = Math.max(1.8, p.speed * 0.22);
  const carrot = sampleFlightTrack(p.track, p.dist + L);
  stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.4, 18.0);
  p.dist = projectFlightTrackDist(p.track, p.x, p.y, p.dist, ds);

  const planeId = p.id ?? pIdx;

  // Off-map international boundary turnaround
  if (p.dest?.isExternal && p.dist >= p.track.totalLength - 0.35) {
    const prevOriginId =
      p.origin && !p.origin.isExternal ? p.origin.id : undefined;
    if (p.origin && !p.origin.isExternal) {
      p.origin.exportsCompleted = (p.origin.exportsCompleted || 0) + 1;
    }
    sim.tripsCompleted += SIM_CONFIG.FLEET.flightTripWeight;
    p.origin = p.dest;

    let candAirports = sim.world.airports;
    if (p.aircraftType === "WIDEBODY_FREIGHTER") {
      const wide = sim.world.airports.filter((a) => canWidebodyServe(a));
      if (wide.length > 0) {
        candAirports = wide;
      } else {
        candAirports = sim.world.airports;
        p.aircraftType = "FEEDER_TURBOPROP";
        p.isCargoFreighter = true;
      }
    }
    const otherCands = candAirports.filter((a) => a.id !== prevOriginId);
    const pool = otherCands.length > 0 ? otherCands : candAirports;
    const nextAp =
      pool[Math.floor(sim.rng.next() * pool.length)] || sim.world.airports[0];

    /** @type {number | undefined} */
    let destGateLx;
    const nextCtrl = sim.getATCController(nextAp);
    if (nextCtrl && nextCtrl.state.gates.length > 0) {
      const freeGate = nextCtrl.reserveArrivalGate(planeId);
      if (freeGate) {
        p.reservedGateId = freeGate.id;
        destGateLx = freeGate.lx;
      }
      nextCtrl.registerInbound(planeId);
    }

    p.track = buildFlightTrack(p.origin, nextAp, {
      isCargoFreighter: p.isCargoFreighter,
      aircraftType: p.aircraftType,
      destGateLx,
      dSign: nextAp.activeSign,
    });
    p.dest = nextAp;
    p.isExternalFlight = true;
    p.manifest = buildPlaneManifest(p);
    p.dist = 0;
    p.segIdx = 0;
    transitionPlaneState(p, "ENROUTE_CRUISE");
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
    return;
  }

  const sample = sampleFlightTrack(p.track, p.dist);
  p.altitude = sample.altitude;
  p.segIdx = sample.segIdx;
  p.progress = Math.min(0.9999, p.dist / Math.max(0.001, p.track.totalLength));

  if (p.dist >= landingStartDist || sample.phase === "LANDING") {
    const destCtrl = sim.getATCController(p.dest);
    const freeGate = destCtrl
      ? destCtrl.findAvailableArrivalGate(planeId, p.reservedGateId)
      : null;
    const rwyClear =
      !destCtrl || (freeGate !== null && destCtrl.canLandRunway());

    if (rwyClear) {
      if (destCtrl) {
        const reserved = destCtrl.reserveArrivalGate(planeId, p.reservedGateId);
        if (reserved) {
          p.reservedGateId = reserved.id;
          p.targetTaxiS = reserved.taxiS;
        }
        destCtrl.acquireRunwayForLanding(planeId);
      }
      transitionPlaneState(p, "LANDING_ROLLOUT");
    } else {
      transitionPlaneState(p, "APPROACH_QUEUE");
      p.holdingPatternAngle = 0;
      destCtrl?.enqueueApproach(p);
    }
  }
}

/**
 * State 7: `APPROACH_QUEUE` — Continuous airborne racetrack/circular holding orbit until arrival runway clears.
 *
 * @param {PlaneAgent} p
 * @param {number} pIdx
 * @param {LogisticsSimulator} sim
 * @param {number} effDt
 */
export function stepApproachQueue(p, pIdx, sim, effDt) {
  transitionPlaneState(p, "APPROACH_QUEUE");
  p.gearDir = 1;
  const sample = sampleFlightTrack(p.track, p.dist);
  const destCtrl = sim.getATCController(p.dest);
  const qIdx = destCtrl
    ? Math.max(0, destCtrl.state.approachQueue.indexOf(p))
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
  const freeGate = destCtrl
    ? destCtrl.findAvailableArrivalGate(planeId, p.reservedGateId)
    : null;
  if (qIdx === 0) {
    const arrClear =
      !destCtrl || (freeGate !== null && destCtrl.canLandRunway());
    sepOk = arrClear;
    if (
      sepOk &&
      destCtrl &&
      destCtrl.hasLandingSeparationConflict(p, sim.planesById)
    ) {
      sepOk = false;
    }
  }

  stepLongitudinalSpeed(p, holdSpeed, 5.0, 5.5, 18.0, effDt, 0.25, null, false);

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
  p.altitude = Math.max(SIM_CONFIG.AVIATION.climbOutAlt, sample.altitude);
  p.segIdx = sample.segIdx;
  p.progress = Math.min(0.9999, p.dist / Math.max(0.001, p.track.totalLength));

  if (clearingOut && thetaProg >= nextTurn) {
    if (destCtrl) {
      const reserved = destCtrl.reserveArrivalGate(planeId, p.reservedGateId);
      if (reserved) {
        p.reservedGateId = reserved.id;
        p.targetTaxiS = reserved.taxiS;
      }
      destCtrl.dequeueApproach(p);
      destCtrl.acquireRunwayForLanding(planeId);
    }
    p._holdRAlong = undefined;
    p._holdRCross = undefined;
    p.holdingPatternAngle = 0;
    transitionPlaneState(p, "LANDING_ROLLOUT");
  }
}

/**
 * State 8: `LANDING_ROLLOUT` — Final descent flare, touchdown, and braking rollout to rapid-exit taxiway.
 *
 * @param {PlaneAgent} p
 * @param {number} pIdx
 * @param {LogisticsSimulator} sim
 * @param {number} effDt
 */
export function stepLandingRollout(p, pIdx, sim, effDt) {
  transitionPlaneState(p, "LANDING_ROLLOUT");
  p.gearDir = 1;
  const taxiInStartDist = p.track.taxiInStartDist ?? p.track.totalLength;
  const destCtrl = sim.getATCController(p.dest);
  const crossSpan = destCtrl ? (destCtrl.state.isHub ? 2.75 : 1.06) : 1.06;
  const r1 = Math.min(0.45, crossSpan * 0.45);
  const exitTargetDist = taxiInStartDist - r1;
  const dToExit = Math.max(0.05, exitTargetDist - p.dist);
  const dEff = Math.max(
    0.02,
    dToExit - 0.14 * Math.max(0, p.speed - SIM_CONFIG.AVIATION.taxiSpeed),
  );
  const vBrake = Math.sqrt(SIM_CONFIG.AVIATION.taxiSpeed ** 2 + 2 * 4.5 * dEff);
  const vDes = Math.min(SIM_CONFIG.AVIATION.cruiseSpeed, vBrake);
  const kinAccel =
    p.speed > vBrake
      ? (SIM_CONFIG.AVIATION.taxiSpeed ** 2 - p.speed ** 2) / (2 * dToExit)
      : null;
  stepLongitudinalSpeed(p, vDes, 5.5, 6.2, 18.0, effDt, 0.24, kinAccel, false);

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
  p.progress = Math.min(0.9999, p.dist / Math.max(0.001, p.track.totalLength));

  if (p.dist >= exitTargetDist || sample.phase === "TAXI_IN") {
    if (p.origin?.isExternal && p.dest && !p._importRecorded) {
      p.dest.importsCompleted = (p.dest.importsCompleted || 0) + 1;
      p._importRecorded = true;
    }
    const planeId = p.id ?? pIdx;
    if (destCtrl) {
      destCtrl.releaseRunwayForPlane(planeId);
      if (p.reservedGateId === null) {
        const freeGate = destCtrl.reserveArrivalGate(planeId);
        if (freeGate) {
          p.reservedGateId = freeGate.id;
          p.targetTaxiS = freeGate.taxiS;
        }
      }
    }
    const startS = -crossSpan - r1;
    p.dist = taxiInStartDist;
    p.taxiS = destCtrl ? startS : 0;
    p._gatePullInS = destCtrl ? startS : null;
    if (destCtrl && !destCtrl.canEnterTaxiwayAfterLanding(p, startS)) {
      transitionPlaneState(p, "HOLD_CROSSING_RUNWAY");
      destCtrl.enqueueCrossing(p);
    } else {
      transitionPlaneState(p, "TAXI_TO_GATE");
      if (destCtrl) {
        destCtrl.acquireRunwayCrossing(planeId);
        destCtrl.enterTaxiway(p, p.taxiS);
      }
    }
  }
}

/**
 * State 9: `HOLD_CROSSING_RUNWAY` — Holding between outer arrival runway and inner departure runway on dual-runway hubs.
 *
 * @param {PlaneAgent} p
 * @param {number} _pIdx
 * @param {LogisticsSimulator} sim
 * @param {number} effDt
 */
export function stepHoldCrossingRunway(p, _pIdx, sim, effDt) {
  transitionPlaneState(p, "HOLD_CROSSING_RUNWAY");
  p.altitude = 0;
  p.gearDir = 1;
  const destCtrl = sim.getATCController(p.dest);
  if (!destCtrl) {
    transitionPlaneState(p, "TAXI_TO_GATE");
  } else {
    const atc = destCtrl.state;
    const qIdx = Math.max(0, atc.crossingQueue.indexOf(p));
    const holdTargetS =
      (atc.isHub ? -1.94 : -0.35) -
      qIdx * (SIM_CONFIG.AVIATION.minTaxiSeparation + 0.08);
    const curS = p.taxiS ?? (atc.isHub ? -3.2 : -1.51);
    const dRem = Math.max(0, holdTargetS - curS);
    if (dRem > 6e-4 || p.speed > 0.01) {
      const vDes = computeStopEnvelopeSpeed(dRem, p.speed, 1.55, 2.2);
      stepLongitudinalSpeed(p, vDes, 3.8, 4.5, 18.0, effDt, 0.135, null, true);
      const ds = Math.min(dRem, p.speed * effDt);
      p.taxiS = curS + ds;
      p._gatePullInS = p.taxiS;
      const carrot = destCtrl.spinePosToWorld(p.taxiS + 0.44);
      stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.5, 5.5);
    } else {
      p.speed = 0;
      p.accel = 0;
      p.steerKappa = 0;
      p._groundOmega = 0;
    }
  }
  p.progress = Math.min(0.9999, p.dist / Math.max(0.001, p.track.totalLength));
}

/**
 * State 10: `TAXI_TO_GATE` — Parallel spine taxi-in, L-fillet apron pull-in, and precision stand docking.
 *
 * @param {PlaneAgent} p
 * @param {number} pIdx
 * @param {LogisticsSimulator} sim
 * @param {number} effDt
 */
export function stepTaxiToGate(p, pIdx, sim, effDt) {
  transitionPlaneState(p, "TAXI_TO_GATE");
  p.altitude = 0;
  p.gearDir = 1;
  const maxTaxiSpeed = SIM_CONFIG.AVIATION.taxiSpeed;
  const destCtrl = sim.getATCController(p.dest);
  const planeId = p.id ?? pIdx;

  if (destCtrl) {
    const destAtc = destCtrl.state;
    destCtrl.enterTaxiway(p);

    let gate = destCtrl.reserveArrivalGate(planeId, p.reservedGateId, Infinity);
    if (!gate) {
      p.reservedGateId = null;
      gate = destCtrl.reserveArrivalGate(planeId, null, (p.taxiS ?? 0) + 0.55);
      if (gate) {
        p.reservedGateId = gate.id;
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
      const loc = worldToLocalAirfield(p.dest, p.x, p.y);
      const prevPullS = p._gatePullInS ?? p.taxiS ?? 0;
      const gGuide = sampleGatePullInWorld(p.dest, gate, prevPullS);
      const onStraightLeadIn =
        prevPullS >= gGuide.sTurnStart + gGuide.filletLen * 0.55 &&
        (loc.ly - cyF) * side >= -0.12;
      const projS = projectGatePullInS(p.dest, gate, loc.lx, loc.ly, prevPullS);
      // Leader constraint applies while on the taxiway spine before turning into the gate
      const spineBlockedNow = occIdx > 0 && maxAllowedS < gate.taxiS - 0.15;
      const standDistNow = Math.hypot(gate.worldX - p.x, gate.worldY - p.y);
      const finalHomings =
        onStraightLeadIn &&
        !spineBlockedNow &&
        (gate.ly - loc.ly) * side <= 0.4;
      const curPullS = onStraightLeadIn
        ? gGuide.totalGateS -
          (finalHomings ? standDistNow : Math.max(0, (gate.ly - loc.ly) * side))
        : Math.min(
            gGuide.sTurnStart + gGuide.filletLen,
            Math.max(prevPullS, projS),
          );
      const limitPullS = spineBlockedNow ? maxAllowedS : gGuide.totalGateS;
      const dRem = Math.max(0, limitPullS - curPullS);
      const crossSpan = destAtc.isHub ? 2.75 : 1.06;
      const nearGateTurn = curPullS >= gGuide.sTurnStart - 0.65;
      const nearCorner =
        Math.abs(curPullS - -crossSpan) < 0.95 || Math.abs(curPullS) < 0.95;
      const cornerCap = nearGateTurn ? 1.15 : nearCorner ? 1.45 : maxTaxiSpeed;
      const vDes = computeStopEnvelopeSpeed(dRem, p.speed, cornerCap, 2.2);
      stepLongitudinalSpeed(p, vDes, 4.0, 4.5, 18.0, effDt, 0.135, null, true);
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
        carrot = localToWorldAirfield(p.dest, gate.lx, loc.ly + side * L);
      } else {
        carrot = sampleGatePullInWorld(p.dest, gate, p._gatePullInS + 0.34);
      }
      stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.8, 5.8);

      const standDistAfter = Math.hypot(gate.worldX - p.x, gate.worldY - p.y);
      if (!spineBlockedNow && standDistAfter <= 7e-4 && p.speed <= 0.015) {
        destCtrl.leaveTaxiway(p);
        destCtrl.unregisterInbound(planeId);
        sim.releaseAllGatesForPlane(planeId);
        destCtrl.occupyGate(planeId, gate.id);
        p.gateId = gate.id;
        p.reservedGateId = null;
        p._gatePullInS = null;
        if (p.dest.id !== undefined) {
          p.origin = p.dest;
        }
        p.dist = p.track.totalLength;
        transitionPlaneState(p, "GATE_LOADING");
        p.altitude = 0;
        p.speed = 0;
        p.accel = 0;
        p.steerKappa = 0;
        p._groundOmega = 0;
        p.progress = 0.999;
        p.dwellTimer = 0;
        return;
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
      const vDes = computeStopEnvelopeSpeed(dRem, p.speed, cornerCap, 2.2);
      stepLongitudinalSpeed(p, vDes, 4.0, 4.5, 18.0, effDt, 0.135, null, true);
      const ds = Math.min(dRem, p.speed * effDt);
      p.taxiS = (p.taxiS ?? 0) + ds;
      p._gatePullInS = p.taxiS;
      const carrot = destCtrl.spinePosToWorld(p.taxiS + 0.44);
      stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.5, 5.5);
    }

    p.progress = Math.min(
      0.9999,
      p.dist / Math.max(0.001, p.track.totalLength),
    );
  } else {
    const dRem = Math.max(0, p.track.totalLength - p.dist);
    const vDes = computeStopEnvelopeSpeed(dRem, p.speed, maxTaxiSpeed, 2.2);
    stepLongitudinalSpeed(p, vDes, 4.0, 4.5, 18.0, effDt, 0.135, null, true);
    const ds = Math.min(dRem, p.speed * effDt);
    p.dist += ds;
    const carrot = sampleFlightTrack(p.track, p.dist + 0.44);
    stepGroundCarrot(p, carrot.x, carrot.y, effDt, 2.5, 5.5);
    if (dRem <= 6e-4 && p.speed <= 0.015) {
      p.dist = p.track.totalLength;
      transitionPlaneState(p, "GATE_LOADING");
      p.altitude = 0;
      p.speed = 0;
      p.accel = 0;
      p.steerKappa = 0;
      p._groundOmega = 0;
      p.progress = 0.999;
      p.dwellTimer = 0;
      sim.releaseAllGatesForPlane(planeId);
      if (p.dest.id !== undefined) {
        p.origin = p.dest;
      }
      return;
    }
    const sample = sampleFlightTrack(p.track, p.dist);
    p.segIdx = sample.segIdx;
    p.progress = Math.min(
      0.9999,
      p.dist / Math.max(0.001, p.track.totalLength),
    );
  }
}

/**
 * 10-state aircraft FSM dispatch table.
 *
 * @type {Readonly<Record<PlaneFSMState, (p: PlaneAgent, pIdx: number, sim: LogisticsSimulator, effDt: number) => void>>}
 */
export const PLANE_STATE_HANDLERS = {
  GATE_LOADING: stepGateLoading,
  PUSHBACK_HOLD: stepPushbackHold,
  TAXI_TO_RUNWAY: stepTaxiToRunway,
  HOLD_SHORT_QUEUE: stepHoldShortQueue,
  TAKEOFF_ROLL: stepTakeoffRoll,
  ENROUTE_CRUISE: stepEnrouteCruise,
  APPROACH_QUEUE: stepApproachQueue,
  LANDING_ROLLOUT: stepLandingRollout,
  HOLD_CROSSING_RUNWAY: stepHoldCrossingRunway,
  TAXI_TO_GATE: stepTaxiToGate,
};

/**
 * Executes one 60Hz sub-step of terminal ATC arbitration and non-holonomic / jerk-bounded aircraft physics.
 *
 * @param {LogisticsSimulator} sim
 * @param {number} effDt
 */
export function stepAviationSubStep(sim, effDt) {
  sim.rebuildPlanesIndex();

  // Pass 1: Airport ATC Queue & Lock Arbitration across all airports
  for (const ap of sim.world.airports) {
    const ctrl = sim.getATCController(ap);
    if (ctrl) {
      ctrl.reconcileAndStepQueues(sim.planesById, sim.planes, sim);
    }
  }

  // Pass 2: Aircraft Agent Physics & 10-State FSM Dispatch
  for (let pIdx = 0; pIdx < sim.planes.length; pIdx++) {
    const p = sim.planes[pIdx];
    const handler = PLANE_STATE_HANDLERS[p.state || "GATE_LOADING"];
    if (handler) {
      handler(p, pIdx, sim, effDt);
    }
    syncPlanePose(p);
  }

  // Pass 3: Enforce post-step 1D taxiway spine separation invariants
  for (const ap of sim.world.airports) {
    const ctrl = sim.getATCController(ap);
    if (ctrl) {
      ctrl.maintainOrder();
    }
  }
}
