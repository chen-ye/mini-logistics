/**
 * Airport Terminal Arbitrator Actor (`AirportATCController`).
 *
 * Single-writer runtime arbitrator for airfield gate stands, 1D taxiway spine
 * leader-follower separation, runway departure/arrival/crossing mutual exclusion,
 * hold-short & approach queues, and registered inbound flight tracking.
 *
 * Invariants:
 * - 100% Worker-safe and headless-safe: zero DOM/window references.
 * - Shares `layout.js` (`computeActiveRunwaySign`, `computeAirfieldLayout`,
 *   `localToWorldAirfield`, `taxiSpinePosToWorld`) as the single airfield geometry source of truth.
 * - Exposes `this.state` on `ap.atc` with full `AirportATC` compatibility plus
 *   `isDual` and `inboundPlaneIds: Set<string>`.
 *
 * @import { Airport, AirportATC, GateSlot, PlaneAgent, PlaneEndpoint } from "../../types.js"
 */
import { SIM_CONFIG } from "../../constants.js";
import {
  computeActiveRunwaySign,
  computeAirfieldLayout,
  localToWorldAirfield,
  normalizeAngle,
  taxiSpinePosToWorld,
} from "./layout.js";

/**
 * @typedef {AirportATC & {
 *   isDual: boolean,
 *   inboundPlaneIds: Set<string>
 * }} AirportATCState
 */

/**
 * @typedef {{
 *   releaseAllGatesForPlane: (planeId: number) => void
 * }} GateReleaseCoordinator
 */

/**
 * Upgrades an existing `AirportATC` object in-place with `isDual` and `inboundPlaneIds`
 * if an external caller or test constructed or replaced `ap.atc`.
 *
 * @param {Airport | PlaneEndpoint} ap
 * @param {AirportATC} rawAtc
 * @returns {AirportATCState}
 */
function ensureATCStateFields(ap, rawAtc) {
  const isDual = Boolean(
    rawAtc.isHub ||
    ap.tier === "HUB" ||
    ap.isHub ||
    ap.airportClass === "HUB" ||
    ap.dualRunway,
  );
  /** @type {Set<string>} */
  const existingInbound =
    "inboundPlaneIds" in rawAtc && rawAtc.inboundPlaneIds instanceof Set
      ? rawAtc.inboundPlaneIds
      : new Set();
  return Object.assign(rawAtc, {
    isDual,
    inboundPlaneIds: existingInbound,
  });
}

/**
 * Builds a fresh `AirportATCState` from `computeAirfieldLayout` and binds it onto `ap.atc`.
 *
 * @param {Airport} ap
 * @param {{ x: number, y: number, rad?: number } | null} [windVector=null]
 * @returns {AirportATCState}
 */
function buildAirportATCState(ap, windVector = null) {
  const hasWind =
    windVector !== null &&
    typeof windVector === "object" &&
    typeof windVector.x === "number" &&
    typeof windVector.y === "number";
  const activeSign = hasWind
    ? computeActiveRunwaySign(ap.angleRad ?? 0, windVector)
    : (ap.activeSign ?? 1);

  ap.activeSign = activeSign;
  const prevAtc = ap.atc;
  ap.atc = undefined;
  const layout = computeAirfieldLayout(ap, windVector);
  ap.atc = prevAtc;

  const isHub = ap.isHub ?? false;
  const noseAngle = normalizeAngle(
    (ap.angleRad ?? 0) + (layout.side > 0 ? Math.PI * 0.5 : -Math.PI * 0.5),
  );

  /** @type {GateSlot[]} */
  const gates = layout.gates.map((g) => {
    const w = localToWorldAirfield(ap, g.lx, g.ly);
    return {
      id: g.id,
      lx: g.lx,
      ly: g.ly,
      taxiY: g.taxiY,
      taxiS: g.taxiS,
      worldX: w.x,
      worldY: w.y,
      noseAngle,
      state: "FREE",
      occupiedBy: null,
      reservedBy: null,
    };
  });

  /** @type {AirportATCState} */
  const atc = {
    airportId: ap.id ?? 0,
    isHub,
    isDual: layout.isDual,
    activeSign,
    rwyLen: layout.rwyLen,
    termW: layout.termW,
    taxiY: layout.taxiY,
    holdShortY: layout.holdShortY,
    exitRwyX: layout.exitCrossX,
    crossTaxiX: layout.exitCrossX,
    depCrossX: layout.depCrossX,
    holdShortS: layout.holdShortS,
    preGateHoldS: layout.preGateHoldS,
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
    inboundPlaneIds: new Set(),
  };

  ap.atc = atc;
  ap.activeSign = activeSign;
  return atc;
}

/**
 * Initializes Airport ATC, gate slots, 1D taxiway spine, and into-the-wind active runway direction.
 *
 * @param {Airport} ap
 * @param {{ x: number, y: number, rad?: number } | null} [windVector=null]
 * @returns {AirportATCState}
 */
export function initAirportATC(ap, windVector = null) {
  return buildAirportATCState(ap, windVector);
}

/**
 * Checks whether the taxiway spine behind a gate is clear of moving aircraft for pushback.
 *
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
 * Enforces FIFO non-overtaking separation (`minTaxiSeparation`) on the 1D taxiway spine.
 *
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
 * Single-writer ATC arbitrator actor managing one airport's gates, taxiway spine,
 * runway locks, crossing clearances, hold-short/approach queues, and inbound registry.
 */
export class AirportATCController {
  /**
   * @param {Airport | PlaneEndpoint} ap
   * @param {{ x: number, y: number, rad?: number } | null} [windVector=null]
   * @param {AirportATC | null} [existingState=null]
   */
  constructor(ap, windVector = null, existingState = null) {
    /** @type {Airport | PlaneEndpoint} */
    this.airport = ap;
    /** @type {AirportATCState} */
    this.state = existingState
      ? ensureATCStateFields(ap, existingState)
      : buildAirportATCState(/** @type {Airport} */ (ap), windVector);
    ap.atc = this.state;
    ap.activeSign = this.state.activeSign;
    /** @type {Map<string, PlaneAgent> | null} */
    this._planesById = null;
  }

  /**
   * Adopts an externally replaced `ap.atc` state object (e.g. when a test re-runs `initAirportATC`).
   *
   * @param {AirportATC} nextState
   */
  adoptState(nextState) {
    this.state = ensureATCStateFields(this.airport, nextState);
    this.airport.atc = this.state;
  }

  /**
   * Binds the live `planesById` lookup index for resolving numeric/string plane IDs to `PlaneAgent`s.
   *
   * @param {Map<string, PlaneAgent>} planesById
   */
  bindPlanesIndex(planesById) {
    this._planesById = planesById;
  }

  /**
   * Maps a 1D taxiway spine coordinate `s` to world `{ x, y, ang }` for this airport.
   *
   * @param {number} s
   * @returns {{ x: number, y: number, ang: number }}
   */
  spinePosToWorld(s) {
    return taxiSpinePosToWorld(this.airport, s);
  }

  /**
   * Resolves a plane identifier or `PlaneAgent` reference to its live `PlaneAgent`.
   *
   * @param {PlaneAgent | number | string | null | undefined} planeOrId
   * @param {Map<string, PlaneAgent> | null} [planesById=null]
   * @returns {PlaneAgent | null}
   */
  _resolvePlane(planeOrId, planesById = null) {
    if (planeOrId === null || planeOrId === undefined) return null;
    if (typeof planeOrId === "object") return planeOrId;
    const key = String(planeOrId);
    const map = planesById ?? this._planesById;
    if (map) {
      const hit = map.get(key);
      if (hit) return hit;
    }
    const numId = Number(planeOrId);
    for (const occ of this.state.taxiwayOccupants) {
      if (occ.id === numId || String(occ.id) === key) return occ;
    }
    for (const q of this.state.holdShortQueue) {
      if (q.id === numId || String(q.id) === key) return q;
    }
    for (const q of this.state.crossingQueue) {
      if (q.id === numId || String(q.id) === key) return q;
    }
    for (const q of this.state.approachQueue) {
      if (q.id === numId || String(q.id) === key) return q;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Gate Stand Arbitration
  // ---------------------------------------------------------------------------

  /**
   * Finds a gate suitable for departure turnaround (preferring the gate already occupied by `planeId`).
   *
   * @param {number | string} planeId
   * @returns {GateSlot | null}
   */
  findTurnaroundGate(planeId) {
    const numId = Number(planeId);
    return (
      this.state.gates.find((g) => g.occupiedBy === numId) ||
      this.state.gates.find(
        (g) => g.state === "FREE" && g.occupiedBy === null,
      ) ||
      null
    );
  }

  /**
   * Non-mutating query returning an available arrival gate (`preferredGateId` if still reserved/free,
   * otherwise the first completely free & unreserved gate).
   *
   * @param {number | string} planeId
   * @param {number | null} [preferredGateId=null]
   * @returns {GateSlot | null}
   */
  findAvailableArrivalGate(planeId, preferredGateId = null) {
    const numId = Number(planeId);
    if (preferredGateId !== null && preferredGateId !== undefined) {
      const pref = this.state.gates.find(
        (g) =>
          g.id === preferredGateId &&
          g.occupiedBy === null &&
          (g.reservedBy === numId || g.reservedBy === null),
      );
      if (pref) return pref;
    }
    return (
      this.state.gates.find(
        (g) =>
          g.state === "FREE" && g.occupiedBy === null && g.reservedBy === null,
      ) ?? null
    );
  }

  /**
   * Reserves an arrival gate for `planeId`, optionally honoring `preferredGateId` and a minimum
   * forward `taxiS` threshold for aircraft already rolling along the parallel taxiway spine.
   *
   * @param {number | string} planeId
   * @param {number | null} [preferredGateId=null]
   * @param {number} [minTaxiS=-Infinity]
   * @returns {GateSlot | null}
   */
  reserveArrivalGate(planeId, preferredGateId = null, minTaxiS = -Infinity) {
    const numId = Number(planeId);
    if (preferredGateId !== null && preferredGateId !== undefined) {
      const existing = this.state.gates.find(
        (g) =>
          g.id === preferredGateId &&
          g.occupiedBy === null &&
          (g.reservedBy === numId || g.reservedBy === null),
      );
      if (existing) {
        existing.state = "RESERVED";
        existing.reservedBy = numId;
        return existing;
      }
    }
    const freeGate = this.state.gates.find(
      (g) =>
        g.state === "FREE" &&
        g.occupiedBy === null &&
        g.reservedBy === null &&
        g.taxiS >= minTaxiS,
    );
    if (!freeGate) return null;
    freeGate.state = "RESERVED";
    freeGate.reservedBy = numId;
    return freeGate;
  }

  /**
   * Occupies a specific `gateId` (or the first free gate when `gateId` is null/omitted) for `planeId`.
   *
   * @param {number | string} planeId
   * @param {number | null} [gateId=null]
   * @returns {GateSlot | null}
   */
  occupyGate(planeId, gateId = null) {
    const numId = Number(planeId);
    /** @type {GateSlot | undefined} */
    let gate;
    if (gateId !== null && gateId !== undefined) {
      gate = this.state.gates.find(
        (g) =>
          g.id === gateId && (g.occupiedBy === null || g.occupiedBy === numId),
      );
    } else {
      gate = this.state.gates.find(
        (g) => g.state === "FREE" && g.occupiedBy === null,
      );
    }
    if (!gate) return null;
    gate.state = "OCCUPIED";
    gate.occupiedBy = numId;
    gate.reservedBy = null;
    return gate;
  }

  /**
   * Releases any gate occupied or reserved by `planeId` at this airport.
   *
   * @param {number | string} planeId
   */
  releaseGatesForPlane(planeId) {
    const numId = Number(planeId);
    for (const g of this.state.gates) {
      if (g.occupiedBy === numId || g.reservedBy === numId) {
        if (g.occupiedBy === numId) g.occupiedBy = null;
        if (g.reservedBy === numId) g.reservedBy = null;
        g.state =
          g.occupiedBy !== null
            ? "OCCUPIED"
            : g.reservedBy !== null
              ? "RESERVED"
              : "FREE";
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound Flight Registry & Single-Runway Conflict Lookahead
  // ---------------------------------------------------------------------------

  /**
   * Registers `planeId` as inbound toward this airport.
   *
   * @param {number | string} planeId
   */
  registerInbound(planeId) {
    this.state.inboundPlaneIds.add(String(planeId));
  }

  /**
   * Unregisters `planeId` from this airport's inbound flight set.
   *
   * @param {number | string} planeId
   */
  unregisterInbound(planeId) {
    this.state.inboundPlaneIds.delete(String(planeId));
  }

  /**
   * Returns true if a single-runway airport has an imminent arrival in `LANDING` / `LANDING_ROLLOUT`
   * or within `maxEtaOrDist` tiles on `CRUISE` approach (with deadlock immunity for departures
   * already holding short).
   *
   * @param {number | string | null | undefined} excludePlaneId
   * @param {Map<string, PlaneAgent>} planesById
   * @param {number} [maxEtaOrDist=SIM_CONFIG.AVIATION.holdShortLookaheadTiles]
   * @returns {boolean}
   */
  hasImminentInbound(
    excludePlaneId,
    planesById,
    maxEtaOrDist = SIM_CONFIG.AVIATION.holdShortLookaheadTiles,
  ) {
    if (this.state.isHub || this.airport.isHub) return false;
    const apId = this.airport.id;
    if (apId === undefined) return false;

    const excludeKey =
      excludePlaneId !== null && excludePlaneId !== undefined
        ? String(excludePlaneId)
        : null;
    const excludePlane =
      excludeKey !== null ? (planesById.get(excludeKey) ?? null) : null;
    const alreadyHoldingShort = excludePlane
      ? this.state.holdShortQueue.includes(excludePlane)
      : false;

    for (const inbKey of this.state.inboundPlaneIds) {
      if (inbKey === excludeKey) continue;
      const other = planesById.get(inbKey);
      if (!other || !other.dest || other.dest.id !== apId) continue;

      const landingDist =
        other.track.landingStartDist ?? other.track.totalLength;
      const distRemaining = landingDist - other.dist;
      const inCruiseApproach =
        !alreadyHoldingShort &&
        other.phase === "CRUISE" &&
        distRemaining <= maxEtaOrDist;
      if (
        other.phase === "LANDING" ||
        other.state === "LANDING_ROLLOUT" ||
        inCruiseApproach
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks whether any aircraft currently rolling out on arrival violates `minAirborneSeparation`
   * relative to `candidatePlane`.
   *
   * @param {PlaneAgent} candidatePlane
   * @param {Map<string, PlaneAgent>} planesById
   * @returns {boolean}
   */
  hasLandingSeparationConflict(candidatePlane, planesById) {
    const apId = this.airport.id;
    const candKey =
      candidatePlane.id !== undefined ? String(candidatePlane.id) : null;
    for (const inbKey of this.state.inboundPlaneIds) {
      if (inbKey === candKey) continue;
      const other = planesById.get(inbKey);
      if (!other || other === candidatePlane) continue;
      if (
        other.dest &&
        other.dest.id === apId &&
        other.state === "LANDING_ROLLOUT" &&
        Math.abs(other.dist - candidatePlane.dist) <
          SIM_CONFIG.AVIATION.minAirborneSeparation
      ) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Runway Mutual Exclusion Locks
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the departure runway is free of active takeoff/landing rolls and hub crossings.
   *
   * @returns {boolean}
   */
  canDepartRunway() {
    return this.state.isHub
      ? this.state.depRunwayBusyBy === null &&
          this.state.crossingBusyBy === null
      : this.state.runwayBusyBy === null;
  }

  /**
   * Returns true if the arrival runway is clear to accept a landing clearance.
   *
   * @returns {boolean}
   */
  canLandRunway() {
    return this.state.isHub
      ? this.state.arrRunwayBusyBy === null
      : this.state.runwayBusyBy === null &&
          this.state.holdShortQueue.length === 0;
  }

  /**
   * Acquires the departure runway lock for `planeId` if available.
   *
   * @param {number | string} planeId
   * @returns {boolean}
   */
  acquireRunwayForDeparture(planeId) {
    if (!this.canDepartRunway()) return false;
    const numId = Number(planeId);
    if (this.state.isHub) {
      this.state.depRunwayBusyBy = numId;
    } else {
      this.state.runwayBusyBy = numId;
    }
    this.state.lastOp = "DEPARTURE";
    return true;
  }

  /**
   * Acquires the arrival runway lock for `planeId` if available.
   *
   * @param {number | string} planeId
   * @returns {boolean}
   */
  acquireRunwayForLanding(planeId) {
    if (!this.canLandRunway()) return false;
    const numId = Number(planeId);
    if (this.state.isHub) {
      this.state.arrRunwayBusyBy = numId;
    } else {
      this.state.runwayBusyBy = numId;
    }
    this.state.lastOp = "ARRIVAL";
    return true;
  }

  /**
   * Marks departure runway locks as occupied during initial mid-takeoff fleet spawning.
   *
   * @param {number | string} planeId
   */
  forceOccupyDepartureRunway(planeId) {
    const numId = Number(planeId);
    this.state.runwayBusyBy = numId;
    if (this.state.isHub) {
      this.state.depRunwayBusyBy = numId;
    }
  }

  /**
   * Marks arrival runway locks as occupied during initial mid-landing fleet spawning.
   *
   * @param {number | string} planeId
   */
  forceOccupyLandingRunway(planeId) {
    const numId = Number(planeId);
    this.state.runwayBusyBy = numId;
    if (this.state.isHub) {
      this.state.arrRunwayBusyBy = numId;
    }
  }

  /**
   * Acquires the inner departure-runway crossing lock on a dual-runway hub.
   *
   * @param {number | string} planeId
   */
  acquireRunwayCrossing(planeId) {
    if (this.state.isHub) {
      this.state.crossingBusyBy = Number(planeId);
    }
  }

  /**
   * Releases any departure or arrival runway lock held by `planeId`.
   *
   * @param {number | string} planeId
   */
  releaseRunwayForPlane(planeId) {
    const numId = Number(planeId);
    if (this.state.runwayBusyBy === numId) this.state.runwayBusyBy = null;
    if (this.state.depRunwayBusyBy === numId) this.state.depRunwayBusyBy = null;
    if (this.state.arrRunwayBusyBy === numId) this.state.arrRunwayBusyBy = null;
  }

  /**
   * Evaluates whether a newly landed aircraft can proceed directly onto the taxiway spine
   * without holding short of the inner departure runway or colliding with spine traffic.
   *
   * @param {PlaneAgent} plane
   * @param {number} startS
   * @returns {boolean}
   */
  canEnterTaxiwayAfterLanding(plane, startS) {
    const depClear =
      this.state.depRunwayBusyBy === null &&
      this.state.crossingBusyBy === null &&
      this.state.holdShortQueue.length === 0;
    const entryClear = this.state.taxiwayOccupants.every(
      (o) =>
        (o.taxiS ?? 0) - startS >= 3.1 &&
        Math.hypot(o.x - plane.x, o.y - plane.y) >= 1.85,
    );
    return (!this.state.isHub || depClear) && entryClear;
  }

  // ---------------------------------------------------------------------------
  // 1D Taxiway Spine & Queue Operations
  // ---------------------------------------------------------------------------

  /**
   * Enters `planeId` onto the 1D taxiway spine and enforces leader-follower ordering.
   *
   * @param {PlaneAgent | number | string} planeId
   * @param {number} [s]
   * @param {number} [speed]
   */
  enterTaxiway(planeId, s, speed) {
    const plane = this._resolvePlane(planeId);
    if (!plane) return;
    if (typeof s === "number") plane.taxiS = s;
    if (typeof speed === "number") plane.speed = speed;
    if (!this.state.taxiwayOccupants.includes(plane)) {
      this.state.taxiwayOccupants.push(plane);
    }
    maintainTaxiwayOrder(this.state);
  }

  /**
   * Updates a plane's 1D `taxiS` and `speed` along the taxiway spine and maintains separation.
   *
   * @param {PlaneAgent | number | string} planeId
   * @param {number} s
   * @param {number} [speed]
   */
  updateTaxiwayPos(planeId, s, speed) {
    const plane = this._resolvePlane(planeId);
    if (!plane) return;
    plane.taxiS = s;
    if (typeof speed === "number") plane.speed = speed;
    if (!this.state.taxiwayOccupants.includes(plane)) {
      this.state.taxiwayOccupants.push(plane);
    }
    maintainTaxiwayOrder(this.state);
  }

  /**
   * Removes `planeId` from `taxiwayOccupants`.
   *
   * @param {PlaneAgent | number | string} planeId
   */
  leaveTaxiway(planeId) {
    const numId = typeof planeId === "object" ? planeId.id : Number(planeId);
    const strId =
      typeof planeId === "object" ? String(planeId.id) : String(planeId);
    const idx = this.state.taxiwayOccupants.findIndex(
      (o) => o === planeId || o.id === numId || String(o.id) === strId,
    );
    if (idx !== -1) {
      this.state.taxiwayOccupants.splice(idx, 1);
    }
  }

  /**
   * Enforces FIFO non-overtaking separation across all current taxiway spine occupants.
   */
  maintainOrder() {
    maintainTaxiwayOrder(this.state);
  }

  /**
   * Appends `planeId` to `holdShortQueue` if not already queued.
   *
   * @param {PlaneAgent | number | string} planeId
   */
  enqueueHoldShort(planeId) {
    const plane = this._resolvePlane(planeId);
    if (plane && !this.state.holdShortQueue.includes(plane)) {
      this.state.holdShortQueue.push(plane);
    }
  }

  /**
   * Removes `planeId` from `holdShortQueue`.
   *
   * @param {PlaneAgent | number | string} planeId
   */
  dequeueHoldShort(planeId) {
    const numId = typeof planeId === "object" ? planeId.id : Number(planeId);
    const idx = this.state.holdShortQueue.findIndex(
      (p) => p === planeId || p.id === numId,
    );
    if (idx !== -1) {
      this.state.holdShortQueue.splice(idx, 1);
    }
  }

  /**
   * Appends `planeId` to `crossingQueue` if not already queued.
   *
   * @param {PlaneAgent | number | string} planeId
   */
  enqueueCrossing(planeId) {
    const plane = this._resolvePlane(planeId);
    if (plane && !this.state.crossingQueue.includes(plane)) {
      this.state.crossingQueue.push(plane);
    }
  }

  /**
   * Appends `planeId` to `approachQueue` if not already queued.
   *
   * @param {PlaneAgent | number | string} planeId
   */
  enqueueApproach(planeId) {
    const plane = this._resolvePlane(planeId);
    if (plane && !this.state.approachQueue.includes(plane)) {
      this.state.approachQueue.push(plane);
    }
  }

  /**
   * Removes `planeId` from `approachQueue`.
   *
   * @param {PlaneAgent | number | string} planeId
   */
  dequeueApproach(planeId) {
    const numId = typeof planeId === "object" ? planeId.id : Number(planeId);
    const idx = this.state.approachQueue.findIndex(
      (p) => p === planeId || p.id === numId,
    );
    if (idx !== -1) {
      this.state.approachQueue.splice(idx, 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Sub-Step Queue Reconciliation & Clearance Arbitrator
  // ---------------------------------------------------------------------------

  /**
   * Reconciles gate occupancy/reservations, runway/crossing locks, inbound registry,
   * reverse pushback clearances, runway crossing clearances, approach queue cleanup,
   * and hold-short departure clearances for one 60Hz aviation sub-step.
   *
   * @param {Map<string, PlaneAgent>} planesById
   * @param {PlaneAgent[]} planesList
   * @param {GateReleaseCoordinator} sim
   */
  reconcileAndStepQueues(planesById, planesList, sim) {
    this._planesById = planesById;
    const atc = this.state;
    const apId = this.airport.id;

    // Prune detached/stale entries from queues and taxiway occupants when missing from planesById
    if (planesById) {
      for (let i = atc.taxiwayOccupants.length - 1; i >= 0; i--) {
        const occ = atc.taxiwayOccupants[i];
        if (!occ || !planesById.has(String(occ.id))) {
          atc.taxiwayOccupants.splice(i, 1);
        }
      }
      for (let i = atc.holdShortQueue.length - 1; i >= 0; i--) {
        const q = atc.holdShortQueue[i];
        if (
          !q ||
          !planesById.has(String(q.id)) ||
          planesById.get(String(q.id)) !== q
        ) {
          atc.holdShortQueue.splice(i, 1);
        }
      }
      for (let i = atc.crossingQueue.length - 1; i >= 0; i--) {
        const q = atc.crossingQueue[i];
        if (
          !q ||
          !planesById.has(String(q.id)) ||
          planesById.get(String(q.id)) !== q
        ) {
          atc.crossingQueue.splice(i, 1);
        }
      }
      for (let i = atc.approachQueue.length - 1; i >= 0; i--) {
        const q = atc.approachQueue[i];
        if (
          !q ||
          !planesById.has(String(q.id)) ||
          planesById.get(String(q.id)) !== q
        ) {
          atc.approachQueue.splice(i, 1);
        }
      }
    }

    // Sync inbound registry so even externally injected test planes are indexed
    atc.inboundPlaneIds.clear();
    if (apId !== undefined && Array.isArray(planesList)) {
      for (let i = 0; i < planesList.length; i++) {
        const p = planesList[i];
        if (
          p.dest &&
          p.dest.id === apId &&
          (p.state === "TAKEOFF_ROLL" ||
            p.state === "ENROUTE_CRUISE" ||
            p.state === "APPROACH_QUEUE" ||
            p.state === "LANDING_ROLLOUT" ||
            (!p.state &&
              (p.phase === "TAKEOFF" ||
                p.phase === "CRUISE" ||
                p.phase === "LANDING")))
        ) {
          atc.inboundPlaneIds.add(String(p.id ?? i));
        }
      }
    }

    // 0. Reconcile gate occupancy & reservations
    for (const gate of atc.gates) {
      if (gate.occupiedBy !== null) {
        const holder = planesById.get(String(gate.occupiedBy));
        if (
          !holder ||
          (holder.state !== "GATE_LOADING" &&
            holder.state !== "PUSHBACK_HOLD") ||
          holder.origin.id !== apId
        ) {
          gate.occupiedBy = null;
          gate.state = gate.reservedBy !== null ? "RESERVED" : "FREE";
        }
      }
      if (gate.reservedBy !== null) {
        const resHolder = planesById.get(String(gate.reservedBy));
        const validPushback =
          resHolder &&
          resHolder.origin.id === apId &&
          resHolder.state === "TAXI_TO_RUNWAY" &&
          resHolder._pushbackStage === "REVERSE" &&
          resHolder.pushbackOriginGateId === gate.id;
        const validArrival =
          resHolder &&
          resHolder.dest.id === apId &&
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
      const holder = planesById.get(String(atc.runwayBusyBy));
      if (
        !holder ||
        (holder.state !== "TAKEOFF_ROLL" && holder.state !== "LANDING_ROLLOUT")
      ) {
        atc.runwayBusyBy = null;
      }
    }
    if (atc.depRunwayBusyBy !== null) {
      const holder = planesById.get(String(atc.depRunwayBusyBy));
      if (!holder || holder.state !== "TAKEOFF_ROLL") {
        atc.depRunwayBusyBy = null;
      }
    }
    if (atc.arrRunwayBusyBy !== null) {
      const holder = planesById.get(String(atc.arrRunwayBusyBy));
      if (!holder || holder.state !== "LANDING_ROLLOUT") {
        atc.arrRunwayBusyBy = null;
      }
    }
    if (atc.crossingBusyBy !== null) {
      const holder = planesById.get(String(atc.crossingBusyBy));
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
        const plane = planesById.get(String(gate.occupiedBy));
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
            sim.releaseAllGatesForPlane(planeId);
            gate.state = "RESERVED";
            gate.reservedBy = planeId;
            plane.gateId = null;
            plane.reservedGateId = null;
            this.enterTaxiway(plane, pushEndS, 0);
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
          if (atc.isHub && crosser.id !== undefined) {
            this.acquireRunwayCrossing(crosser.id);
          }
          crosser._gatePullInS = crosser.taxiS ?? startS;
          crosser.gearDir = 1;
          this.enterTaxiway(crosser, crosser.taxiS ?? startS, crosser.speed);
          crosser.state = "TAXI_TO_GATE";
          crosser.phase = "TAXI_IN";
        }
      }
    }

    // 4. Approach queue cleanup (remove any plane no longer in APPROACH_QUEUE)
    for (let q = atc.approachQueue.length - 1; q >= 0; q--) {
      const entry = atc.approachQueue[q];
      if (
        entry.state !== "APPROACH_QUEUE" ||
        (planesById &&
          (!planesById.has(String(entry.id)) ||
            planesById.get(String(entry.id)) !== entry))
      ) {
        atc.approachQueue.splice(q, 1);
      }
    }

    // 5. Departure queue clearance (Hold-short)
    if (atc.holdShortQueue.length > 0) {
      const departer = atc.holdShortQueue[0];
      const atHoldShort =
        departer &&
        (departer.taxiS ?? 0) >= atc.holdShortS - 0.25 &&
        (departer.speed ?? 0) <= 0.05;
      if (this.canDepartRunway() && atHoldShort) {
        const arrivalInbound = this.hasImminentInbound(
          departer.id,
          planesById,
          SIM_CONFIG.AVIATION.holdShortLookaheadTiles,
        );
        if (!arrivalInbound) {
          atc.holdShortQueue.shift();
          this.leaveTaxiway(departer);
          this.acquireRunwayForDeparture(departer.id ?? 0);
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
}
