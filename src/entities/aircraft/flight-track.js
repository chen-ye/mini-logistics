/**
 * Gate-to-Gate & Off-Map International Corridor Flight Track Synthesis & Sampling.
 *
 * Constructs G1-continuous Dubins-style departure arcs, enroute cubic Bezier airways,
 * arrival base-to-final turns, dual-runway hub offset tracks, and arc-length samplers.
 *
 * Invariants:
 * - 100% Worker-safe: zero window, document, or DOM references.
 * - Enforces wide-body runway eligibility (`canWidebodyServe`: `HUB`, `CRG`, or external corridors only).
 * - Shares coordinate transforms and runway sign helpers from `../airport/layout.js`.
 *
 * @import { AircraftType, Airport, FlightPhase, FlightTrack, FlightTrackPoint, PlaneEndpoint } from "../../types.js"
 */
import { SIM_CONFIG } from "../../constants.js";
import {
  computeActiveRunwaySign,
  localToWorldAirfield,
  normalizeAngle,
  taxiSpinePosToWorld,
} from "../airport/layout.js";

/**
 * Returns true if the endpoint can accommodate a 4-engine WIDEBODY_FREIGHTER
 * (`HUB`, `CRG`, or off-map `ExternalCorridor`). Regional spoke airports (`REG`)
 * never accept wide-body freighters.
 *
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
 *
 * @param {Airport | PlaneEndpoint} ap
 * @param {number} [corridorIdx=0]
 * @param {number} [W=360]
 * @param {number} [H=224]
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
 *
 * @param {Airport | PlaneEndpoint} origin
 * @param {Airport | PlaneEndpoint} dest
 * @param {{ isCargoFreighter?: boolean, aircraftType?: AircraftType, gateIndex?: number, gateLx?: number, destGateLx?: number, oSign?: 1 | -1, dSign?: 1 | -1 }} [options={}]
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
  const chordAsHeadwind = { x: -dx, y: -dy };
  const oSign =
    options.oSign ??
    origin.activeSign ??
    computeActiveRunwaySign(oAng, chordAsHeadwind);
  const dSign =
    options.dSign ??
    dest.activeSign ??
    computeActiveRunwaySign(dAng, chordAsHeadwind);

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
  const oExitCrossX = oSign * (oIsHub ? 0.41 : 0.38) * oRwyLen;
  const oCrossTaxiX = -oSign * (oIsHub ? 0.41 : 0.38) * oRwyLen;
  const oHoldShortY = -oSide * (oIsHub ? 0.94 : 0.96);
  const oHoldShortS =
    Math.abs(oCrossTaxiX - oExitCrossX) + Math.abs(oTaxiY - oHoldShortY);

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
    const pGate = localToWorldAirfield(origin, oGateX, oTermY);
    rawPts.push({
      x: pGate.x,
      y: pGate.y,
      altitude: 0,
      phase: "TAXI_OUT",
      speed: taxiSpeed,
    });

    const pApron = localToWorldAirfield(origin, oGateX, oTaxiY);
    rawPts.push({
      x: pApron.x,
      y: pApron.y,
      altitude: 0,
      phase: "TAXI_OUT",
      speed: taxiSpeed,
    });

    const pCross = localToWorldAirfield(origin, oCrossTaxiX, oTaxiY);
    rawPts.push({
      x: pCross.x,
      y: pCross.y,
      altitude: 0,
      phase: "TAXI_OUT",
      speed: taxiSpeed,
    });

    const pHoldShort = taxiSpinePosToWorld(
      {
        x: origin.x,
        y: origin.y,
        angleRad: oAng,
        halfLen: oHalfLen,
        isHub: oIsHub,
        apronSide: oSide,
        activeSign: oSign,
      },
      oHoldShortS,
    );
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
      const pFillet = localToWorldAirfield(origin, flx, fly);
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
    const pEarlyRoll = localToWorldAirfield(
      origin,
      -oSign * oRwyLen * 0.22,
      depRwyY,
    );
    rawPts.push({
      x: pEarlyRoll.x,
      y: pEarlyRoll.y,
      altitude: 0,
      phase: "TAKEOFF",
      speed: taxiSpeed + (takeoffSpeed - taxiSpeed) * 0.22,
    });

    const pMidRoll = localToWorldAirfield(origin, 0, depRwyY);
    rawPts.push({
      x: pMidRoll.x,
      y: pMidRoll.y,
      altitude: 0,
      phase: "TAKEOFF",
      speed: taxiSpeed + (takeoffSpeed - taxiSpeed) * 0.55,
    });

    const pLiftoff = localToWorldAirfield(
      origin,
      oSign * oRwyLen * 0.32,
      depRwyY,
    );
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

    const pMidClimb = localToWorldAirfield(origin, oMidClimbX, depRwyY);
    rawPts.push({
      x: pMidClimb.x,
      y: pMidClimb.y,
      altitude: SIM_CONFIG.AVIATION.climbOutAlt * 0.5,
      phase: "TAKEOFF",
      speed: takeoffSpeed,
    });

    const pClimbOut = localToWorldAirfield(origin, oClimbX, depRwyY);
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
    pAppEntry = localToWorldAirfield(dest, dEntryX, arrRwyY);
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
    const pMidApp = localToWorldAirfield(dest, -dSign * midAppDist, arrRwyY);
    rawPts.push({
      x: pMidApp.x,
      y: pMidApp.y,
      altitude: SIM_CONFIG.AVIATION.climbOutAlt * 0.5,
      phase: "LANDING",
      speed: landingSpeed,
    });

    const pTouchdown = localToWorldAirfield(
      dest,
      -dSign * 0.42 * dRwyLen,
      arrRwyY,
    );
    rawPts.push({
      x: pTouchdown.x,
      y: pTouchdown.y,
      altitude: 0,
      phase: "LANDING",
      speed: 9.0,
    });

    const pMidRollout = localToWorldAirfield(dest, 0, arrRwyY);
    rawPts.push({
      x: pMidRollout.x,
      y: pMidRollout.y,
      altitude: 0,
      phase: "LANDING",
      speed: 5.5,
    });

    const pExit = localToWorldAirfield(dest, dExitRwyX, arrRwyY);
    rawPts.push({
      x: pExit.x,
      y: pExit.y,
      altitude: 0,
      phase: "TAXI_IN",
      speed: taxiSpeed,
    });

    // 5. TAXI_IN (altitude = 0, speed = 2.2 tiles/sec)
    const pTaxiCross = localToWorldAirfield(dest, dCrossTaxiX, dTaxiY);
    rawPts.push({
      x: pTaxiCross.x,
      y: pTaxiCross.y,
      altitude: 0,
      phase: "TAXI_IN",
      speed: taxiSpeed,
    });

    const pTaxiGate = localToWorldAirfield(dest, dGateX, dTaxiY);
    rawPts.push({
      x: pTaxiGate.x,
      y: pTaxiGate.y,
      altitude: 0,
      phase: "TAXI_IN",
      speed: taxiSpeed,
    });

    const pDestGate = localToWorldAirfield(dest, dGateX, dTermY);
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
 * Samples a position, tangent angle, altitude, speed, and phase along a flight track at arc distance `dist`.
 *
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

/**
 * Projects world position `(px, py)` onto segments of `track` near `curDist` to keep arc-length `dist` synchronized.
 *
 * @param {FlightTrack} track
 * @param {number} px
 * @param {number} py
 * @param {number} curDist
 * @param {number} ds
 * @returns {number}
 */
export function projectFlightTrackDist(track, px, py, curDist, ds) {
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
