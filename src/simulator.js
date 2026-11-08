import { PALETTE } from "./palette.js";

/***************************************************************************
 * 4. LIVE TRAFFIC (CARS) & AVIATION (FLIGHTS) SIMULATION ENGINE
 ***************************************************************************/
export class LogisticsSimulator {
  constructor(world) {
    this.world = world;
    this.cars = [];
    this.planes = [];
    this.tripsCompleted = 1372;
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
      const mult = world.config.archetype === 'island-hopper' ? 3 : 2;
      const planeCount = Math.max(2, world.airports.length * mult);
      for (let i = 0; i < planeCount; i++) {
        this.spawnPlane(i / planeCount);
      }
    }
  }

  spawnCar(isFreightTruck = false) {
    const { world } = this;
    const preferMotorwayFreight = isFreightTruck && world.motorways.length > 0 && Math.random() < 0.25;
    if (isFreightTruck && !preferMotorwayFreight && world.cargoLinks && world.cargoLinks.length > 0) {
      const link = world.cargoLinks[Math.floor(Math.random() * world.cargoLinks.length)];
      if (link.points && link.points.length >= 2) {
        this.cars.push({
          mode: 'road',
          isFreightTruck: true,
          isCargoLink: true,
          cargoStage: link.stage,
          road: { points: link.points },
          segIdx: Math.floor(Math.random() * (link.points.length - 1)),
          segT: Math.random(),
          dir: Math.random() < 0.72 ? 1 : -1,
          speed: 2.8 + Math.random() * 1.4,
          color: link.color
        });
        return;
      }
    }
    const useMotorway = world.motorways.length > 0 && Math.random() < (isFreightTruck ? 0.55 : 0.28);
    if (useMotorway) {
      const mw = world.motorways[Math.floor(Math.random() * world.motorways.length)];
      const color = isFreightTruck
        ? '#ea580c'
        : PALETTE.districtColors[Math.floor(Math.random() * PALETTE.districtColors.length)].roof;
      this.cars.push({
        mode: 'motorway',
        isFreightTruck,
        mw,
        t: Math.random(),
        dir: Math.random() < 0.5 ? 1 : -1,
        speed: (isFreightTruck ? 0.14 : 0.18) + Math.random() * 0.07,
        color
      });
    } else if (world.roads.length > 0) {
      const road = world.roads[Math.floor(Math.random() * world.roads.length)];
      if (road.points.length < 3) return;
      const color = PALETTE.districtColors[Math.floor(Math.random() * PALETTE.districtColors.length)].roof;
      this.cars.push({
        mode: 'road',
        isFreightTruck: false,
        road,
        segIdx: Math.floor(Math.random() * (road.points.length - 1)),
        segT: Math.random(),
        dir: Math.random() < 0.5 ? 1 : -1,
        speed: 3.5 + Math.random() * 2.0,
        color
      });
    }
  }

  spawnPlane(initialPhase = 0) {
    const { world } = this;
    if (world.airports.length === 0) return;
    const originIdx = Math.floor(Math.random() * world.airports.length);
    const origin = world.airports[originIdx];
    let dest = null;
    if (world.airports.length > 1) {
      const destIdx = (originIdx + 1 + Math.floor(Math.random() * (world.airports.length - 1))) % world.airports.length;
      dest = world.airports[destIdx];
    } else {
      // Virtual international off-map corridor if single airport
      dest = {
        x: world.W * 0.92,
        y: world.H * 0.12,
        angleRad: origin.angleRad,
        halfLen: 6
      };
    }

    this.planes.push({
      origin,
      dest,
      progress: initialPhase, // 0..1 lifecycle (taxi/takeoff -> cruise arc -> landing rollout)
      speed: 0.048 + Math.random() * 0.015,
      color: origin.palette.roof
    });
  }

  update(dt, simSpeed) {
    if (simSpeed <= 0) return;
    const effDt = dt * simSpeed;
    this.simTime += effDt;

    // Update Cars
    for (const car of this.cars) {
      if (car.mode === 'motorway') {
        car.t += car.dir * car.speed * effDt;
        if (car.t >= 1) {
          car.t = 1;
          car.dir = -1;
          this.tripsCompleted++;
        } else if (car.t <= 0) {
          car.t = 0;
          car.dir = 1;
          this.tripsCompleted++;
        }
      } else {
        const pts = car.road.points;
        const p0 = pts[car.segIdx];
        const p1 = pts[car.segIdx + 1];
        const segLen = p0 && p1 ? Math.max(0.5, Math.hypot(p1.x - p0.x, p1.y - p0.y)) : 1.0;
        car.segT += (car.speed / segLen) * effDt;
        if (car.segT >= 1.0) {
          car.segT -= 1.0;
          car.segIdx += car.dir;
          if (car.segIdx >= car.road.points.length - 1) {
            car.segIdx = car.road.points.length - 2;
            car.dir = -1;
            this.tripsCompleted++;
          } else if (car.segIdx < 0) {
            car.segIdx = 0;
            car.dir = 1;
          }
        }
      }
    }

    // Update Aircraft
    for (const p of this.planes) {
      p.progress += p.speed * effDt;
      if (p.progress >= 1.0) {
        p.progress = 0;
        this.tripsCompleted += 6;
        // Swap origin and destination for continuous air bridge
        const tmp = p.origin;
        p.origin = p.dest.id !== undefined ? p.dest : p.origin;
        if (this.world.airports.length > 1) {
          const others = this.world.airports.filter(a => a.id !== p.origin.id);
          p.dest = others[Math.floor(Math.random() * others.length)];
        }
      }
    }
  }
}
