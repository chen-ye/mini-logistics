import { describe, test, expect } from "bun:test";
import { createWorldPipeline } from "../../src/world-generator.js";
import { LogisticsSimulator } from "../../src/simulator.js";

describe("Multi-Modal Traffic & Aviation Simulation (LogisticsSimulator)", () => {
  test("Cargo links and commuter routes have valid directed trajectories and cumulative arc lengths", () => {
    const pipeline = createWorldPipeline();
    const world = pipeline({
      seed: "OTTD-METRO-84",
      worldSize: "compact",
      archetype: "confluence",
      terrainAlgo: "tectonic-fbm",
      hydrologyAlgo: "thalweg-astar",
      airportMix: "hub-reg-cargo",
      includeIntermediateRamps: true,
      waterCoverage: 48,
      townCount: 16,
      buildingDensity: 240,
      airportCount: 3,
      windAxis: -1,
    });

    expect(world.cargoLinks.length).toBeGreaterThan(0);
    expect(world.commuterRoutes.length).toBeGreaterThan(0);

    for (const link of world.cargoLinks) {
      for (const track of [link.outboundTrack, link.inboundTrack]) {
        expect(track).toBeDefined();
        expect(track.pts.length).toBeGreaterThanOrEqual(2);
        expect(track.totalLength).toBeGreaterThan(0);
        for (let i = 1; i < track.cumLen.length; i++) {
          expect(track.cumLen[i]).toBeGreaterThanOrEqual(track.cumLen[i - 1]);
        }
      }
    }

    for (const route of world.commuterRoutes) {
      for (const track of [route.outboundTrack, route.inboundTrack]) {
        expect(track).toBeDefined();
        expect(track.pts.length).toBeGreaterThanOrEqual(2);
        expect(track.totalLength).toBeGreaterThan(0);
        for (let i = 1; i < track.cumLen.length; i++) {
          expect(track.cumLen[i]).toBeGreaterThanOrEqual(track.cumLen[i - 1]);
        }
      }
    }
  });

  test("LogisticsSimulator spawns commuter cars, freight trucks, and aircraft and advances trips", () => {
    const pipeline = createWorldPipeline();
    const world = pipeline({
      seed: "OTTD-METRO-84",
      worldSize: "compact",
      archetype: "confluence",
      terrainAlgo: "tectonic-fbm",
      hydrologyAlgo: "thalweg-astar",
      airportMix: "hub-regional",
      includeIntermediateRamps: true,
      waterCoverage: 48,
      townCount: 14,
      buildingDensity: 220,
      airportCount: 2,
      windAxis: -1,
    });

    const sim = new LogisticsSimulator(world);
    expect(sim.cars.length).toBeGreaterThan(0);
    expect(sim.cars.some((c) => c.isFreightTruck)).toBe(true);
    expect(sim.cars.some((c) => !c.isFreightTruck)).toBe(true);
    expect(sim.planes.length).toBe(Math.max(2, world.airports.length * 2));

    // Paused simulation (simSpeed = 0) is a strict no-op
    const initialTrips = sim.tripsCompleted;
    sim.update(0.05, 0);
    expect(sim.simTime).toBe(0);
    expect(sim.tripsCompleted).toBe(initialTrips);

    // Advance 500 ticks and verify monotonic simTime, turnarounds, and finite agent coordinates
    for (let tick = 0; tick < 500; tick++) {
      sim.update(0.05, 1.5);
    }

    expect(sim.simTime).toBeGreaterThan(30);
    expect(sim.tripsCompleted).toBeGreaterThan(initialTrips);

    for (const car of sim.cars) {
      expect(Number.isFinite(car.dist)).toBe(true);
      expect(car.segIdx).toBeGreaterThanOrEqual(0);
    }
    for (const plane of sim.planes) {
      expect(Number.isFinite(plane.progress)).toBe(true);
      expect(plane.progress).toBeGreaterThanOrEqual(0);
      expect(plane.progress).toBeLessThan(1.0);
    }

    // Island-hopper 3x aircraft fleet multiplier
    const islandWorld = pipeline({
      seed: "ISLAND-HOP-101",
      worldSize: "standard",
      archetype: "island-hopper",
      terrainAlgo: "tectonic-fbm",
      hydrologyAlgo: "thalweg-astar",
      airportMix: "hub-regional",
      includeIntermediateRamps: true,
      waterCoverage: 48,
      townCount: 20,
      buildingDensity: 220,
      airportCount: 5,
      windAxis: -1,
    });
    expect(islandWorld.airports.length).toBeGreaterThan(0);
    const islandSim = new LogisticsSimulator(islandWorld);
    expect(islandSim.planes.length).toBe(
      Math.max(2, islandWorld.airports.length * 3),
    );

    // Single-airport virtual off-map corridor fallback
    const singleApWorld = pipeline({
      seed: "OTTD-METRO-84",
      worldSize: "compact",
      archetype: "confluence",
      terrainAlgo: "tectonic-fbm",
      hydrologyAlgo: "thalweg-astar",
      airportMix: "hub-regional",
      includeIntermediateRamps: true,
      waterCoverage: 48,
      townCount: 14,
      buildingDensity: 200,
      airportCount: 1,
      windAxis: -1,
    });
    expect(singleApWorld.airports.length).toBe(1);
    const singleApSim = new LogisticsSimulator(singleApWorld);
    expect(singleApSim.planes.length).toBe(2);
    expect(singleApSim.planes[0].dest.id).toBeUndefined();
  });
});
