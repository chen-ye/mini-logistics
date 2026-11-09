/** @import { CarAgent, PlaneAgent } from './types.js' */
/** @import { ProceduralLogisticsWorld } from './world-generator.js' */

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
    this.tripsCompleted = 1372;
    /** @type {number} */
    this.simTime = 0;
    this.initAgents();
  }

  initAgents() {
    const { world } = this;
    // Spawn Mini Motorways commuter cars along road paths and motorways
    for (let i = 0; i < 120; i++) {
      this.spawnCar(false);
    }
    // Spawn Inter-Industrial Freight Trucks along the `RAW -> MFG -> LOG -> COM` cargo chain!
    for (let i = 0; i < 42; i++) {
      this.spawnCar(true);
    }
    // Spawn aircraft operating between airports (with 3x air fleet in Island Hopper mode!)
    if (world.airports.length > 0) {
      const mult = world.config.archetype === "island-hopper" ? 3 : 2;
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
   * @param {number} [initialPhase]
   */
  spawnPlane(initialPhase = 0) {
    const { world } = this;
    if (world.airports.length === 0) return;
    const originIdx = Math.floor(Math.random() * world.airports.length);
    const origin = world.airports[originIdx];
    let dest = null;
    if (world.airports.length > 1) {
      const destIdx =
        (originIdx +
          1 +
          Math.floor(Math.random() * (world.airports.length - 1))) %
        world.airports.length;
      dest = world.airports[destIdx];
    } else {
      // Virtual international off-map corridor if single airport
      dest = {
        x: world.W * 0.92,
        y: world.H * 0.12,
        angleRad: origin.angleRad,
        halfLen: 6,
      };
    }

    this.planes.push({
      origin,
      dest,
      progress: initialPhase, // 0..1 lifecycle (taxi/takeoff -> cruise arc -> landing rollout)
      speed: 0.048 + Math.random() * 0.015,
      color: origin.palette.roof,
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
      const speedMult = pt.onMotorway ? 1.65 : pt.isStreet ? 0.82 : 1.0;
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
    for (const p of this.planes) {
      p.progress += p.speed * effDt;
      if (p.progress >= 1.0) {
        p.progress = 0;
        this.tripsCompleted += 6;
        // Swap origin and destination for continuous air bridge
        p.origin = p.dest.id !== undefined ? p.dest : p.origin;
        if (this.world.airports.length > 1) {
          const others = this.world.airports.filter(
            (a) => a.id !== p.origin.id,
          );
          p.dest = others[Math.floor(Math.random() * others.length)];
        }
      }
    }
  }
}
