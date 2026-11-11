/**
 * Road Vehicle Fleet Spawner & Directed-Lane Trajectory Stepper (`car-stepper.js`).
 *
 * Spawns commuter cars and demand-weighted articulated freight trucks along directed
 * `outboundTrack` / `inboundTrack` lane trajectories, maintaining live `Pose2D`
 * (`road` / `motorway-lower` / `motorway-upper`), `CargoManifest` payloads, and
 * multimodal `TradeGateway` landside transfer telemetry.
 *
 * Invariants:
 * - 100% Worker-safe: zero window, document, or DOM references.
 * - Preserves exact RNG call count and order for deterministic fleet generation.
 * - Tracks multimodal gateway freight arrivals on `gw.landsideTransfersCompleted`
 *   without perturbing aviation-only `importsCompleted` / `exportsCompleted` counters.
 *
 * @import { CarAgent, CargoLink, CargoManifest, Destination, TradeGateway, VehicleZLayer } from "../../types.js"
 * @import { LogisticsSimulator } from "../../simulator.js"
 */
import { SIM_CONFIG } from "../../constants.js";

/**
 * @typedef {TradeGateway & { landsideTransfersCompleted?: number }} LiveTradeGateway
 * @typedef {Destination & { rawGateway?: LiveTradeGateway & { id?: number | string } }} GatewayCapableDestination
 */

/**
 * Resolves a numeric gateway identifier from a cargo link endpoint if backed by a `TradeGateway`.
 *
 * @param {GatewayCapableDestination | null | undefined} ep
 * @returns {number | null}
 */
function resolveManifestGatewayId(ep) {
  if (!ep) return null;
  if (typeof ep.rawGateway?.id === "number") return ep.rawGateway.id;
  if (typeof ep.rawGateway?.entityId === "number") {
    return ep.rawGateway.entityId;
  }
  if (ep.isGatewayProxy && typeof ep.airportId === "number") {
    return ep.airportId;
  }
  return null;
}

/**
 * Increments `landsideTransfersCompleted` on the associated `TradeGateway` when a freight truck
 * completes its outbound delivery leg into or out of a gateway proxy terminal.
 *
 * @param {CargoLink} link
 * @param {TradeGateway[] | undefined} tradeGateways
 */
function recordLandsideGatewayTransfer(link, tradeGateways) {
  /** @type {GatewayCapableDestination} */
  const toEp = link.to;
  /** @type {GatewayCapableDestination} */
  const fromEp = link.from;

  const isOutboundToGateway = Boolean(
    toEp.isGatewayProxy && toEp.airportId != null,
  );
  const isOutboundFromGateway = Boolean(fromEp.isGatewayProxy);
  if (!isOutboundToGateway && !isOutboundFromGateway) return;

  const gwEp = isOutboundToGateway ? toEp : fromEp;
  const rawGw = gwEp.rawGateway;
  if (rawGw) {
    rawGw.landsideTransfersCompleted =
      (rawGw.landsideTransfersCompleted || 0) + 1;
  }
  /** @type {LiveTradeGateway | undefined} */
  const worldGw = tradeGateways?.find(
    (g) => g.id === gwEp.gatewayId || g.entityId === gwEp.airportId,
  );
  if (worldGw && worldGw !== rawGw) {
    worldGw.landsideTransfersCompleted =
      (worldGw.landsideTransfersCompleted || 0) + 1;
  }
}

/**
 * Computes and updates `car.pose` (`Pose2D`) from its active `DirectedLaneTrack` segment,
 * matching the Z-pass classification in `src/entities/road-vehicle/render.js`.
 *
 * @param {CarAgent} car
 */
export function syncCarPose(car) {
  const track = car.returning ? car.inboundTrack : car.outboundTrack;
  if (!track || !track.pts || track.pts.length < 2) {
    const pt0 = track?.pts?.[0];
    const x = pt0?.x ?? 0;
    const y = pt0?.y ?? 0;
    if (car.pose) {
      car.pose.x = x;
      car.pose.y = y;
      car.pose.ang = 0;
      car.pose.zLayer = "road";
      car.pose.speed = 0;
      car.pose.altitude = 0;
      car.pose.inTunnel = false;
    } else {
      car.pose = {
        x,
        y,
        ang: 0,
        zLayer: "road",
        speed: 0,
        altitude: 0,
        inTunnel: false,
      };
    }
    return;
  }

  const idx = Math.min(car.segIdx ?? 0, track.pts.length - 2);
  const p0 = track.pts[idx];
  const p1 = track.pts[idx + 1] || p0;

  const speedMult = p0.onMotorway
    ? SIM_CONFIG.VEHICLE_ROUTING.speedMultMotorway
    : p0.isStreet
      ? SIM_CONFIG.VEHICLE_ROUTING.speedMultStreet
      : SIM_CONFIG.VEHICLE_ROUTING.speedMultArterial;
  const curSpeed = car.speed * speedMult;

  const d0 = track.cumLen?.[idx] ?? 0;
  const segLen = Math.max(1e-4, (track.cumLen?.[idx + 1] ?? d0) - d0);
  const frac = Math.max(0, Math.min(1, ((car.dist ?? 0) - d0) / segLen));

  const x = p0.x + (p1.x - p0.x) * frac;
  const y = p0.y + (p1.y - p0.y) * frac;
  const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);

  const inTunnel = Boolean(p0.inTunnel && p1.inTunnel);
  const isMotorway = Boolean(p0.onMotorway || p1.onMotorway);
  const onUpperBridge =
    isMotorway && Boolean(p0.onUpperBridge || p1.onUpperBridge);
  /** @type {VehicleZLayer} */
  const zLayer = onUpperBridge
    ? "motorway-upper"
    : isMotorway
      ? "motorway-lower"
      : "road";

  if (car.pose) {
    car.pose.x = x;
    car.pose.y = y;
    car.pose.ang = ang;
    car.pose.zLayer = zLayer;
    car.pose.speed = curSpeed;
    car.pose.altitude = 0;
    car.pose.inTunnel = inTunnel;
  } else {
    car.pose = {
      x,
      y,
      ang,
      zLayer,
      speed: curSpeed,
      altitude: 0,
      inTunnel,
    };
  }
}

/**
 * Spawns a single commuter car or demand-weighted freight truck onto `sim.cars`.
 *
 * @param {LogisticsSimulator} sim
 * @param {boolean} [isFreightTruck=false]
 */
export function spawnCar(sim, isFreightTruck = false) {
  const { world, rng } = sim;

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
      const id = sim.allocateCarId();
      /** @type {CargoManifest} */
      const manifest = {
        commodity: link.commodity || "GOODS",
        stage: link.stage || "LOG->COM",
        originId: link.from.id,
        destId: link.to.id,
        gatewayId:
          resolveManifestGatewayId(link.from) ??
          resolveManifestGatewayId(link.to) ??
          null,
        units: 1,
      };
      /** @type {CarAgent} */
      const truck = {
        id,
        cargoLink: link,
        manifest,
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
      };
      syncCarPose(truck);
      sim.cars.push(truck);
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
      const id = sim.allocateCarId();
      /** @type {CarAgent} */
      const commuter = {
        id,
        cargoLink: null,
        manifest: null,
        isFreightTruck: false,
        isCargoLink: false,
        outboundTrack: route.outboundTrack,
        inboundTrack: route.inboundTrack,
        returning,
        dist,
        segIdx,
        speed: 3.8 + rng.next() * 1.8,
        color: route.color,
      };
      syncCarPose(commuter);
      sim.cars.push(commuter);
    }
  }
}

/**
 * Spawns the full initial surface road and motorway fleet (commuter cars followed by freight trucks).
 *
 * @param {LogisticsSimulator} sim
 */
export function spawnFleetCars(sim) {
  for (let i = 0; i < SIM_CONFIG.FLEET.commuterCars; i++) {
    spawnCar(sim, false);
  }
  for (let i = 0; i < SIM_CONFIG.FLEET.freightTrucks; i++) {
    spawnCar(sim, true);
  }
}

/**
 * Advances all `CarAgent`s along their active directed lane trajectories (`outboundTrack` / `inboundTrack`)
 * by `effDt` seconds, handling leg turnarounds, trip counting, gateway transfers, and `Pose2D` updates.
 *
 * @param {LogisticsSimulator} sim
 * @param {number} effDt
 */
export function stepCarAgents(sim, effDt) {
  for (const car of sim.cars) {
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
      const completedOutbound = !car.returning;
      car.dist = 0;
      car.segIdx = 0;
      car.returning = !car.returning;
      sim.tripsCompleted++;

      if (completedOutbound && car.isFreightTruck && car.cargoLink) {
        recordLandsideGatewayTransfer(car.cargoLink, sim.world?.tradeGateways);
      }
    }

    syncCarPose(car);
  }
}
