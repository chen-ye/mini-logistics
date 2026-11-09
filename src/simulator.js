/** @import { Airport, CarAgent, FlightPhase, FlightTrack, FlightTrackPoint, PlaneAgent, PlaneEndpoint } from './types.js' */
/** @import { ProceduralLogisticsWorld } from './world-generator.js' */
import { SIM_CONFIG } from "./constants.js";

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
 * Builds an arc-length parameterized 5-phase gate-to-gate flight track in world tile coordinates.
 * @param {Airport | PlaneEndpoint} origin
 * @param {Airport | PlaneEndpoint} dest
 * @param {{ isCargoFreighter?: boolean, gateIndex?: number }} [options]
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
  const oSign = oDot >= 0 ? 1 : -1;
  const dDot = dx * Math.cos(dAng) + dy * Math.sin(dAng);
  const dSign = dDot >= 0 ? 1 : -1;

  // Dual-Runway Hub & Single-Runway Alignment (Phase 2)
  const oRwyLen = origin.halfLen * 2;
  const depRwyY = oIsHub ? -oSide * 0.85 : -oSide * 0.58;

  const dBaseRwyLen = dest.halfLen * 2;
  const dRwyLen = dIsHub ? dBaseRwyLen * 0.88 : dBaseRwyLen;
  const arrRwyY = dIsHub ? -dSide * 2.55 : -dSide * 0.58;

  const oTermW = oRwyLen * (oIsHub ? 0.46 : 0.4);
  const dTermW = dBaseRwyLen * (dIsHub ? 0.46 : 0.4);
  const gateIndex = options.gateIndex ?? 0;
  const gateSlotFrac = ((gateIndex % 5) - 2) * 0.12;
  const crgPadSign = gateIndex % 2 === 0 ? 1 : -1;

  // Origin gate and taxi geometry
  const oGateX =
    origin.airportClass === "CRG"
      ? crgPadSign * oTermW * 0.32
      : gateSlotFrac * oTermW;
  const oTermY = oSide * (oIsHub ? 1.05 : 0.95);
  const oTaxiY = oSide * (oIsHub ? 0.4 : 0.45);
  const oCrossTaxiX = -oSign * (oIsHub ? 0.41 : 0.38) * oRwyLen;
  const oHoldShortY = depRwyY + oSide * 0.28;

  // Destination gate and taxi geometry (matches unscaled concourse & cross-field taxiways in drawAirports)
  const dGateX =
    dest.airportClass === "CRG"
      ? crgPadSign * dTermW * 0.32
      : gateSlotFrac * dTermW;
  const dTermY = dSide * (dIsHub ? 1.05 : 0.95);
  const dTaxiY = dSide * (dIsHub ? 0.4 : 0.45);
  const dExitRwyX = dSign * (dIsHub ? 0.41 * 1.04 : 0.38) * dBaseRwyLen;
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

  const pThreshold = toWorld(origin, -oSign * oRwyLen * 0.44, depRwyY);
  rawPts.push({
    x: pThreshold.x,
    y: pThreshold.y,
    altitude: 0,
    phase: "TAXI_OUT",
    speed: taxiSpeed,
  });

  // 2. TAKEOFF (altitude: 0 -> 0.18, speed: 2.2 -> 13.5 tiles/sec)
  const takeoffSpeed = SIM_CONFIG.AVIATION.takeoffSpeed;
  const pMidRoll = toWorld(origin, 0, depRwyY);
  rawPts.push({
    x: pMidRoll.x,
    y: pMidRoll.y,
    altitude: 0,
    phase: "TAKEOFF",
    speed: (taxiSpeed + takeoffSpeed) * 0.5,
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

  const numCruiseSteps = Math.max(8, Math.ceil(cDist / 2.5));
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
    phase: "LANDING",
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
    const { world } = this;
    if (isFreightTruck && world.cargoLinks && world.cargoLinks.length > 0) {
      const mwayLinks = world.cargoLinks.filter(
        (l) => l.usesMotorway && l.outboundTrack && l.inboundTrack,
      );
      const validLinks = world.cargoLinks.filter(
        (l) => l.outboundTrack && l.inboundTrack,
      );
      const pool =
        mwayLinks.length > 0 && Math.random() < 0.45 ? mwayLinks : validLinks;
      if (pool.length > 0) {
        const link = pool[Math.floor(Math.random() * pool.length)];
        const returning = Math.random() < 0.32;
        const track = returning ? link.inboundTrack : link.outboundTrack;
        const dist = Math.random() * track.totalLength;
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
          speed: 3.1 + Math.random() * 1.3,
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
        mwayRoutes.length > 0 && Math.random() < 0.42
          ? mwayRoutes
          : validRoutes;
      if (pool.length > 0) {
        const route = pool[Math.floor(Math.random() * pool.length)];
        const returning = Math.random() < 0.5;
        const track = returning ? route.inboundTrack : route.outboundTrack;
        const dist = Math.random() * track.totalLength;
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
          speed: 3.8 + Math.random() * 1.8,
          color: route.color,
        });
      }
    }
  }

  /**
   * @param {number} [initialProgress]
   */
  spawnPlane(initialProgress = 0) {
    const { world } = this;
    if (world.airports.length === 0) return;
    const originIdx = Math.floor(Math.random() * world.airports.length);
    const origin = world.airports[originIdx];
    if (!origin) return;

    /** @type {Airport | PlaneEndpoint} */
    let dest;
    if (world.airports.length > 1) {
      const destIdx =
        (originIdx +
          1 +
          Math.floor(Math.random() * (world.airports.length - 1))) %
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

    const planeIdx = this.planes.length;
    const isCargoFreighter = Boolean(
      origin.airportClass === "CRG" ||
      dest.airportClass === "CRG" ||
      (origin.isHub && dest.isHub && planeIdx % 3 === 2),
    );

    const track = buildFlightTrack(origin, dest, {
      isCargoFreighter,
      gateIndex: planeIdx,
    });

    const dist = Math.max(
      0,
      Math.min(initialProgress * track.totalLength, track.totalLength * 0.999),
    );
    const sample = sampleFlightTrack(track, dist);

    this.planes.push({
      origin,
      dest,
      track,
      dist,
      segIdx: sample.segIdx,
      phase: sample.phase,
      altitude: sample.altitude,
      x: sample.x,
      y: sample.y,
      ang: sample.ang,
      speed: sample.speed,
      dwellTimer: 0,
      holdingShort: false,
      isCargoFreighter,
      color: origin.palette?.roof || "#e65100",
      progress: Math.min(0.9999, dist / Math.max(0.001, track.totalLength)),
    });
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

    // Update Aircraft
    for (let pIdx = 0; pIdx < this.planes.length; pIdx++) {
      const p = this.planes[pIdx];

      if (p.phase === "GATE_DWELL") {
        p.altitude = 0;
        p.progress = 0.999;
        p.dwellTimer += effDt;
        if (p.dwellTimer >= SIM_CONFIG.AVIATION.gateDwellSec) {
          this.tripsCompleted += SIM_CONFIG.FLEET.flightTripWeight;
          const newOrigin = p.dest.id !== undefined ? p.dest : p.origin;
          p.origin = newOrigin;
          /** @type {Airport | PlaneEndpoint | null} */
          let nextDest = null;
          if (this.world.airports.length > 1) {
            const others = this.world.airports.filter(
              (a) => a.id !== p.origin.id,
            );
            nextDest = others[Math.floor(Math.random() * others.length)];
          } else {
            const ang = p.origin.angleRad ?? 0;
            nextDest = {
              x: p.origin.x + Math.cos(ang + 0.35) * 95,
              y: p.origin.y + Math.sin(ang + 0.35) * 95,
              angleRad: ang,
              halfLen: 6,
            };
          }
          if (!nextDest) continue;
          p.dest = nextDest;
          p.isCargoFreighter = Boolean(
            p.origin.airportClass === "CRG" ||
            p.dest.airportClass === "CRG" ||
            (p.origin.isHub && p.dest.isHub && pIdx % 3 === 2),
          );
          p.track = buildFlightTrack(p.origin, p.dest, {
            isCargoFreighter: p.isCargoFreighter,
            gateIndex: pIdx,
          });
          p.dist = 0;
          p.segIdx = 0;
          p.dwellTimer = 0;
          p.progress = 0;
          p.holdingShort = false;
          const sample = sampleFlightTrack(p.track, 0);
          p.x = sample.x;
          p.y = sample.y;
          p.ang = sample.ang;
          p.altitude = sample.altitude;
          p.speed = sample.speed;
          p.phase = sample.phase;
        }
        continue;
      }

      const step = p.speed * effDt;

      // Single-Runway Hold-Short Traffic Control (Phase 2.2)
      if (
        !p.origin.isHub &&
        p.phase === "TAXI_OUT" &&
        p.dist <= p.track.holdShortDist &&
        p.dist + step >= p.track.holdShortDist - 0.25
      ) {
        let arrivalInbound = false;
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
            if (
              other.phase === "LANDING" ||
              (other.phase === "CRUISE" &&
                distRemaining <= SIM_CONFIG.AVIATION.holdShortLookaheadTiles)
            ) {
              arrivalInbound = true;
              break;
            }
          }
        }

        if (arrivalInbound) {
          p.dist = Math.min(p.dist, p.track.holdShortDist);
          p.holdingShort = true;
          const sample = sampleFlightTrack(p.track, p.dist);
          p.x = sample.x;
          p.y = sample.y;
          p.ang = sample.ang;
          p.altitude = sample.altitude;
          p.speed = sample.speed;
          p.phase = "TAXI_OUT";
          p.segIdx = sample.segIdx;
          p.progress = Math.min(
            0.9999,
            p.dist / Math.max(0.001, p.track.totalLength),
          );
          continue;
        }
      }

      p.holdingShort = false;
      p.dist += step;

      if (p.dist >= p.track.totalLength) {
        p.dist = p.track.totalLength;
        p.phase = "GATE_DWELL";
        p.altitude = 0;
        p.progress = 0.999;
        p.dwellTimer = 0;
        const sample = sampleFlightTrack(p.track, p.dist);
        p.x = sample.x;
        p.y = sample.y;
        p.ang = sample.ang;
        p.speed = sample.speed;
        p.segIdx = sample.segIdx;
        continue;
      }

      const sample = sampleFlightTrack(p.track, p.dist);
      p.x = sample.x;
      p.y = sample.y;
      p.ang = sample.ang;
      p.altitude = sample.altitude;
      p.speed = sample.speed;
      p.phase = sample.phase;
      p.segIdx = sample.segIdx;
      p.progress = Math.min(
        0.9999,
        p.dist / Math.max(0.001, p.track.totalLength),
      );
    }
  }
}
