/**
 * Multi-Modal Traffic & Aviation Fleet Runtime Coordinator (`LogisticsSimulator`).
 *
 * Coordinates the live multi-modal logistics simulation across three decoupled actor domains:
 * 1. **Terminal ATC Arbitrators (`AirportATCController` in `./entities/airport/atc-actor.js`)**:
 *    Single-writer actors owning gate stand occupancy/reservations, 1D leader-follower
 *    taxiway spine separation, hold-short / crossing / approach queues, runway mutual
 *    exclusion locks, and registered inbound flight indices.
 * 2. **10-State Non-Holonomic Aircraft Agents (`./entities/aircraft/plane-fsm.js` & `flight-track.js`)**:
 *    3-class aviation fleet (`WIDEBODY_FREIGHTER`, `FEEDER_TURBOPROP`, `PASSENGER_JET`)
 *    integrated at a deterministic 60Hz sub-step (`effDt <= 1/60s`) with pure-pursuit
 *    wheel-rolling/flight carrots, jerk-bounded longitudinal speed profiles, and
 *    automated international off-map corridor turnarounds.
 * 3. **Directed-Lane Road Vehicle Fleet (`./entities/road-vehicle/car-stepper.js`)**:
 *    Commuter vehicles and demand-weighted articulated freight semi-trucks advancing along
 *    committed pavement (`outboundTrack` / `inboundTrack`) with live `Pose2D` Z-layer
 *    classification (`road`, `motorway-lower`, `motorway-upper`), `CargoManifest` tracking,
 *    and multimodal `TradeGateway` landside transfer accounting.
 *
 * Invariants:
 * - 100% Worker-safe and headless-safe: zero window, document, or DOM references.
 * - Preserves deterministic `SeededRNG` consumption order across road and air fleet spawning.
 *
 * @import { Airport, CarAgent, PlaneAgent, PlaneEndpoint } from "./types.js"
 * @import { ProceduralLogisticsWorld } from "./world-generator.js"
 */
import { SIM_CONFIG } from "./constants.js";
import { SeededRNG } from "./math.js";
import { taxiSpinePosToWorld } from "./entities/airport/layout.js";
import {
  AirportATCController,
  canPushBackOntoTaxiway,
  initAirportATC,
  maintainTaxiwayOrder,
} from "./entities/airport/atc-actor.js";
import {
  buildFlightTrack,
  canWidebodyServe,
  createExternalEndpoint,
  sampleFlightTrack,
} from "./entities/aircraft/flight-track.js";
import {
  PLANE_STATE_HANDLERS,
  normalizePlanesForExternalMutations,
  spawnInitialPlanes,
  spawnPlane as spawnPlaneAgent,
  stepAviationSubStep as runAviationSubStep,
  syncPlanePose,
  transitionPlaneState,
} from "./entities/aircraft/plane-fsm.js";
import {
  spawnCar as spawnCarAgent,
  spawnFleetCars,
  stepCarAgents,
  syncCarPose,
} from "./entities/road-vehicle/car-stepper.js";

export {
  AirportATCController,
  PLANE_STATE_HANDLERS,
  buildFlightTrack,
  canPushBackOntoTaxiway,
  canWidebodyServe,
  createExternalEndpoint,
  initAirportATC,
  maintainTaxiwayOrder,
  sampleFlightTrack,
  spawnFleetCars,
  stepCarAgents,
  syncCarPose,
  syncPlanePose,
  taxiSpinePosToWorld,
  transitionPlaneState,
};

/**
 * Live Fleet & Terminal Actor Coordinator for Mini Logistics.
 */
export class LogisticsSimulator {
  /**
   * @param {ProceduralLogisticsWorld} world
   */
  constructor(world) {
    /** @type {ProceduralLogisticsWorld} */
    this.world = world;
    /** @type {Map<number, AirportATCController>} */
    this.atcControllers = new Map();
    /** @type {Map<Airport | PlaneEndpoint, AirportATCController>} */
    this._epControllers = new Map();
    /** @type {CarAgent[]} */
    this.cars = [];
    /** @type {PlaneAgent[]} */
    this.planes = [];
    /** @type {Map<string, PlaneAgent>} */
    this.planesById = new Map();
    /** @type {number} */
    this.tripsCompleted = SIM_CONFIG.FLEET.initialTrips;
    /** @type {number} */
    this.simTime = 0;
    /** @type {SeededRNG} */
    this.rng = new SeededRNG(`${world.config?.seed || "OTTD-METRO-84"}:sim`);
    /** @type {number} */
    this._nextCarId = 1;
    /** @type {number} */
    this._nextPlaneId = 0;

    this.initATCControllers();
    this.initAgents();
  }

  /**
   * Initializes single-writer `AirportATCController` actors on every placed airport
   * in `this.world.airports`, configuring into-the-wind active runway directions.
   */
  initATCControllers() {
    for (let i = 0; i < this.world.airports.length; i++) {
      const ap = this.world.airports[i];
      ap.importsCompleted ??= 0;
      ap.exportsCompleted ??= 0;
      const ctrl = new AirportATCController(ap, this.world.windVector ?? null);
      const key = typeof ap.id === "number" ? ap.id : i;
      this.atcControllers.set(key, ctrl);
      this._epControllers.set(ap, ctrl);
    }
  }

  /**
   * Allocates the next sequential 1-based vehicle identifier (`1, 2, ...`).
   *
   * @returns {number}
   */
  allocateCarId() {
    const id = this._nextCarId;
    this._nextCarId += 1;
    return id;
  }

  /**
   * Allocates the next sequential 0-based aircraft identifier (`0, 1, ...`).
   *
   * @returns {number}
   */
  allocatePlaneId() {
    return this._nextPlaneId++;
  }

  /**
   * Resolves the `AirportATCController` governing `ap`, transparently adopting
   * externally re-initialized `ap.atc` fixtures (e.g. unit test `initAirportATC` calls).
   *
   * @param {Airport | PlaneEndpoint | null | undefined} ap
   * @returns {AirportATCController | null}
   */
  getATCController(ap) {
    if (!ap || ap.isExternal || !ap.atc) return null;

    let ctrl = this._epControllers.get(ap);
    if (!ctrl && typeof ap.id === "number") {
      const byId = this.atcControllers.get(ap.id);
      if (byId && byId.airport === ap) {
        ctrl = byId;
      }
    }

    if (!ctrl) {
      ctrl = new AirportATCController(
        ap,
        this.world?.windVector ?? null,
        ap.atc,
      );
      this._epControllers.set(ap, ctrl);
      if (typeof ap.id === "number") {
        this.atcControllers.set(ap.id, ctrl);
      }
    } else if (ctrl.state !== ap.atc) {
      ctrl.adoptState(ap.atc);
    }

    ctrl.bindPlanesIndex(this.planesById);
    return ctrl;
  }

  /**
   * Resolves an `AirportATCController` by numeric `airportId`.
   *
   * @param {number} airportId
   * @returns {AirportATCController | null}
   */
  getATCControllerById(airportId) {
    const ap =
      this.world?.airports?.find((a) => a.id === airportId) ??
      this.atcControllers.get(airportId)?.airport ??
      null;
    return ap ? this.getATCController(ap) : null;
  }

  /**
   * Returns a read-only telemetry summary of live fleet & terminal counts.
   *
   * @returns {{
   *   simTime: number,
   *   tripsCompleted: number,
   *   carCount: number,
   *   freightTruckCount: number,
   *   planeCount: number,
   *   atcAirportCount: number
   * }}
   */
  getFleetSnapshot() {
    let freightTruckCount = 0;
    for (let i = 0; i < this.cars.length; i++) {
      if (this.cars[i].isFreightTruck) freightTruckCount++;
    }
    return {
      simTime: this.simTime,
      tripsCompleted: this.tripsCompleted,
      carCount: this.cars.length,
      freightTruckCount,
      planeCount: this.planes.length,
      atcAirportCount: this.atcControllers.size,
    };
  }

  /**
   * Releases any gate occupied or reserved by `planeId` across all airport ATC controllers.
   *
   * @param {number} planeId
   */
  releaseAllGatesForPlane(planeId) {
    for (const ap of this.world.airports || []) {
      const ctrl = this.getATCController(ap);
      if (ctrl) {
        ctrl.releaseGatesForPlane(planeId);
      }
    }
    for (const ctrl of this.atcControllers.values()) {
      ctrl.releaseGatesForPlane(planeId);
    }
  }

  /**
   * Rebuilds the $O(1)$ `planesById` lookup table prior to each aviation sub-step.
   */
  rebuildPlanesIndex() {
    this.planesById.clear();
    for (let i = 0; i < this.planes.length; i++) {
      const p = this.planes[i];
      const key = String(p.id ?? i);
      this.planesById.set(key, p);
    }
  }

  /**
   * Spawns the initial commuter, freight truck, and multi-class aircraft fleets
   * in exact deterministic RNG order.
   */
  initAgents() {
    spawnFleetCars(this);
    spawnInitialPlanes(this);
    this.rebuildPlanesIndex();
  }

  /**
   * Spawns a single commuter car (`false`) or freight truck (`true`).
   *
   * @param {boolean} [isFreightTruck=false]
   */
  spawnCar(isFreightTruck = false) {
    spawnCarAgent(this, isFreightTruck);
  }

  /**
   * Spawns a single aircraft agent at normalized track progress `initialProgress`.
   *
   * @param {number} [initialProgress=0]
   */
  spawnPlane(initialProgress = 0) {
    spawnPlaneAgent(this, initialProgress);
    this.rebuildPlanesIndex();
  }

  /**
   * Normalizes synthetic test fixtures and reconciles external mutations on `this.planes`.
   */
  normalizePlanesForExternalMutations() {
    normalizePlanesForExternalMutations(this);
    this.rebuildPlanesIndex();
  }

  /**
   * Executes one 60Hz sub-step of terminal ATC arbitration and aircraft kinematics.
   *
   * @param {number} effDt
   */
  stepAviationSubStep(effDt) {
    this.rebuildPlanesIndex();
    runAviationSubStep(this, effDt);
  }

  /**
   * Advances both surface/motorway road traffic and 60Hz sub-stepped aviation physics
   * by `dt * simSpeed` simulated seconds.
   *
   * @param {number} dt
   * @param {number} simSpeed
   */
  update(dt, simSpeed) {
    if (simSpeed <= 0) return;
    const totalEffDt = dt * simSpeed;
    if (totalEffDt <= 0) return;
    this.simTime += totalEffDt;

    // 1. Advance surface & motorway road vehicles and synchronize Pose2D + gateway transfers
    stepCarAgents(this, totalEffDt);

    // 2. Reconcile external plane mutations prior to 60Hz aviation sub-stepping
    this.normalizePlanesForExternalMutations();

    // 3. Internal 60Hz sub-stepping so all callers execute identical physical ODEs
    const subSteps = Math.min(
      240,
      Math.max(1, Math.ceil(totalEffDt / (1 / 60) - 1e-9)),
    );
    const effDt = totalEffDt / subSteps;
    for (let sub = 0; sub < subSteps; sub++) {
      this.stepAviationSubStep(effDt);
    }

    // 4. Snapshot last simulated dist/state/phase for external mutation detection
    for (const p of this.planes) {
      p._lastSimDist = p.dist;
      p._lastSimState = p.state;
      p._lastSimPhase = p.phase;
    }
  }
}
