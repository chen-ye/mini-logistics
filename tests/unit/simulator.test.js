import { describe, test, expect } from "bun:test";
import { createWorldPipeline } from "../../src/world-generator.js";
import {
  LogisticsSimulator,
  buildFlightTrack,
  sampleFlightTrack,
} from "../../src/simulator.js";
import { SIM_CONFIG } from "../../src/constants.js";

/**
 * Calculates perpendicular Euclidean distance from point (px, py) to line segment (x1, y1)-(x2, y2).
 * @param {number} px
 * @param {number} py
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {number}
 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Determines closest distance from (mx, my) to interchange ramps or within interchange envelope.
 * @param {number} mx
 * @param {number} my
 * @param {any[]} interchanges
 * @returns {number}
 */
function distToInterchangeRamps(mx, my, interchanges) {
  let minD = Infinity;
  const sampleQuad = (x0, y0, cx, cy, x1, y1) => {
    for (let s = 0; s <= 16; s++) {
      const t = s / 16;
      const mt = 1 - t;
      const rx = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
      const ry = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
      const d = Math.hypot(mx - rx, my - ry);
      if (d < minD) minD = d;
    }
  };
  const sampleCubic = (x0, y0, c1x, c1y, c2x, c2y, x1, y1) => {
    for (let s = 0; s <= 20; s++) {
      const t = s / 20;
      const mt = 1 - t;
      const rx =
        mt * mt * mt * x0 +
        3 * mt * mt * t * c1x +
        3 * mt * t * t * c2x +
        t * t * t * x1;
      const ry =
        mt * mt * mt * y0 +
        3 * mt * mt * t * c1y +
        3 * mt * t * t * c2y +
        t * t * t * y1;
      const d = Math.hypot(mx - rx, my - ry);
      if (d < minD) minD = d;
    }
  };

  for (const ic of interchanges || []) {
    if (ic.type === "cloverleaf") {
      const uAx = Math.cos(ic.angleA ?? 0);
      const uAy = Math.sin(ic.angleA ?? 0);
      const uBx = Math.cos(ic.angleB ?? 0);
      const uBy = Math.sin(ic.angleB ?? 0);
      const signsA = ic.activeSignsA || [-1, 1];
      const signsB = ic.activeSignsB || [-1, 1];
      for (const sA of signsA) {
        for (const sB of signsB) {
          const rAx = sA * uAx;
          const rAy = sA * uAy;
          const rBx = sB * uBx;
          const rBy = sB * uBy;
          sampleQuad(
            ic.x + rAx * 2.95,
            ic.y + rAy * 2.95,
            ic.x + (rAx + rBx) * 1.05,
            ic.y + (rAy + rBy) * 1.05,
            ic.x + rBx * 2.95,
            ic.y + rBy * 2.95,
          );
          sampleCubic(
            ic.x,
            ic.y,
            ic.x + rAx * 3.1,
            ic.y + rAy * 3.1,
            ic.x + rBx * 3.1,
            ic.y + rBy * 3.1,
            ic.x,
            ic.y,
          );
        }
      }
    } else if (ic.type === "trumpet") {
      const cosM = Math.cos(ic.angleMain ?? 0);
      const sinM = Math.sin(ic.angleMain ?? 0);
      const sy = ic.sideSign || 1;
      const oppSy = -sy;
      const toW = (lx, ly) => [
        ic.x + lx * cosM - ly * sinM,
        ic.y + lx * sinM + ly * cosM,
      ];
      const [ox0, oy0] = toW(-2.15, 0);
      const [ocx, ocy] = toW(-0.72, sy * 0.72);
      const [ox1, oy1] = toW(0, sy * 2.15);
      sampleQuad(ox0, oy0, ocx, ocy, ox1, oy1);

      const [b0x, b0y] = toW(0, 0);
      const [b1x, b1y] = toW(0, oppSy * 1.35);
      const [b2x, b2y] = toW(0.38, oppSy * 1.85);
      const [b3x, b3y] = toW(1.02, oppSy * 1.85);
      const [b4x, b4y] = toW(1.92, oppSy * 1.85);
      const [b5x, b5y] = toW(1.92, 0);
      const [b6x, b6y] = toW(0.52, 0);
      sampleCubic(b0x, b0y, b1x, b1y, b2x, b2y, b3x, b3y);
      sampleCubic(b3x, b3y, b4x, b4y, b5x, b5y, b6x, b6y);
    } else if (ic.type === "diamond-ramp" && ic.ramps) {
      for (const ramp of ic.ramps) {
        sampleCubic(
          ramp.p0.x,
          ramp.p0.y,
          ramp.p1.x,
          ramp.p1.y,
          ramp.p2.x,
          ramp.p2.y,
          ramp.p3.x,
          ramp.p3.y,
        );
      }
    }
    if (minD <= 0.25) return minD;
  }
  return minD;
}

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

  test("Full Trajectory Pavement Coverage & Zero Motorway U-Turn Invariants (Plan A Step 4.2)", () => {
    const pipeline = createWorldPipeline();
    const benchmarkSeeds = [
      { seed: "OTTD-METRO-84", archetype: "confluence" },
      { seed: "DELTA-402", archetype: "estuary" },
    ];

    for (const bm of benchmarkSeeds) {
      const world = pipeline({
        seed: bm.seed,
        worldSize: "compact",
        archetype: bm.archetype,
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

      const tracks = [];
      for (const link of world.cargoLinks) {
        if (link.outboundTrack) tracks.push(link.outboundTrack);
        if (link.inboundTrack) tracks.push(link.inboundTrack);
      }
      for (const route of world.commuterRoutes) {
        if (route.outboundTrack) tracks.push(route.outboundTrack);
        if (route.inboundTrack) tracks.push(route.inboundTrack);
      }

      expect(tracks.length).toBeGreaterThan(0);

      // Pre-gather pavement geometry references
      const roadSegs = [];
      for (const r of world.roads) {
        if (!r.points || r.points.length < 2) continue;
        for (let i = 0; i < r.points.length - 1; i++) {
          roadSegs.push([
            r.points[i].x,
            r.points[i].y,
            r.points[i + 1].x,
            r.points[i + 1].y,
          ]);
        }
      }

      const driveways = world.routingGraph?.driveways || [];
      const roundabouts = world.routingGraph?.roundabouts || [];

      const mwSegs = [];
      for (const mw of world.motorways) {
        if (!mw.samples || mw.samples.length < 2) continue;
        for (let i = 0; i < mw.samples.length - 1; i++) {
          mwSegs.push([
            mw.samples[i].x,
            mw.samples[i].y,
            mw.samples[i + 1].x,
            mw.samples[i + 1].y,
          ]);
        }
      }

      const interchanges = world.interchanges || [];

      for (const track of tracks) {
        const pts = track.pts;

        // 1. Pavement coverage: every segment midpoint lies within <= 0.55 tiles of valid pavement
        for (let i = 0; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i + 1].x) * 0.5;
          const my = (pts[i].y + pts[i + 1].y) * 0.5;

          let minD = Infinity;

          // Check surface roads
          for (const seg of roadSegs) {
            const d = distToSegment(mx, my, seg[0], seg[1], seg[2], seg[3]);
            if (d < minD) minD = d;
            if (minD <= 0.25) break;
          }

          // Check motorway carriageways
          if (minD > 0.55) {
            for (const seg of mwSegs) {
              const d = distToSegment(mx, my, seg[0], seg[1], seg[2], seg[3]);
              if (d < minD) minD = d;
              if (minD <= 0.25) break;
            }
          }

          // Check driveways
          if (minD > 0.55) {
            for (const dw of driveways) {
              const d = distToSegment(mx, my, dw.x0, dw.y0, dw.x1, dw.y1);
              if (d < minD) minD = d;
              if (minD <= 0.25) break;
            }
          }

          // Check roundabout rings
          if (minD > 0.55) {
            for (const rb of roundabouts) {
              const rad = rb.rTiles ?? 1.0;
              const dRing = Math.abs(Math.hypot(mx - rb.x, my - rb.y) - rad);
              if (dRing < minD) minD = dRing;
              if (minD <= 0.25) break;
            }
          }

          // Check interchange ramps
          if (minD > 0.55) {
            const dRamp = distToInterchangeRamps(mx, my, interchanges);
            if (dRamp < minD) minD = dRamp;
          }

          expect(minD).toBeLessThanOrEqual(0.55);
        }

        // 2. Zero Motorway U-Turns: onMotorway && !isSlipRamp consecutive segments never reverse with cos < -0.85
        for (let i = 1; i < pts.length - 1; i++) {
          const pPrev = pts[i - 1];
          const pCurr = pts[i];
          const pNext = pts[i + 1];
          if (
            pPrev.onMotorway &&
            !pPrev.isSlipRamp &&
            pCurr.onMotorway &&
            !pCurr.isSlipRamp &&
            pNext.onMotorway &&
            !pNext.isSlipRamp
          ) {
            const d1x = pCurr.x - pPrev.x;
            const d1y = pCurr.y - pPrev.y;
            const d2x = pNext.x - pCurr.x;
            const d2y = pNext.y - pCurr.y;
            const l1 = Math.hypot(d1x, d1y);
            const l2 = Math.hypot(d2x, d2y);
            if (l1 >= 0.15 && l2 >= 0.15) {
              const cos = (d1x * d2x + d1y * d2y) / (l1 * l2);
              expect(cos).toBeGreaterThanOrEqual(-0.85);
            }
          }
        }
      }
    }
  });

  test("Arc-Length Monotonicity & World-Space Cruise Speed Invariance (Plan B Phase 5.1)", () => {
    const originShort = {
      x: 50,
      y: 50,
      halfLen: 10,
      angleRad: 0,
      apronSide: 1,
      isHub: false,
      airportClass: "REG",
    };
    const destShort = {
      x: 95,
      y: 50,
      halfLen: 10,
      angleRad: 0,
      apronSide: 1,
      isHub: false,
      airportClass: "REG",
    };

    const originLong = {
      x: 20,
      y: 50,
      halfLen: 14,
      angleRad: 0,
      apronSide: 1,
      isHub: true,
      airportClass: "HUB",
    };
    const destLong = {
      x: 260,
      y: 50,
      halfLen: 14,
      angleRad: 0,
      apronSide: 1,
      isHub: true,
      airportClass: "HUB",
    };

    const trackShort = buildFlightTrack(originShort, destShort);
    const trackLong = buildFlightTrack(originLong, destLong);

    expect(trackShort.totalLength).toBeGreaterThan(0);
    expect(trackLong.totalLength).toBeGreaterThan(0);

    for (const track of [trackShort, trackLong]) {
      for (let i = 1; i < track.cumLen.length; i++) {
        expect(track.cumLen[i]).toBeGreaterThan(track.cumLen[i - 1]);
      }
    }

    const dt = 0.01;
    const distStep = SIM_CONFIG.AVIATION.cruiseSpeed * dt;

    // Sample trackShort in CRUISE phase
    let cruiseShortIdx = -1;
    for (let i = 0; i < trackShort.pts.length; i++) {
      if (trackShort.pts[i].phase === "CRUISE") {
        cruiseShortIdx = i;
        break;
      }
    }
    expect(cruiseShortIdx).toBeGreaterThanOrEqual(0);
    const dShort =
      (trackShort.cumLen[cruiseShortIdx] +
        trackShort.cumLen[cruiseShortIdx + 1]) *
      0.5;
    const sS0 = sampleFlightTrack(trackShort, dShort);
    const sS1 = sampleFlightTrack(trackShort, dShort + distStep);
    expect(sS0.phase).toBe("CRUISE");
    const moveShort = Math.hypot(sS1.x - sS0.x, sS1.y - sS0.y);
    const speedShort = moveShort / dt;

    // Sample trackLong in CRUISE phase
    const dLong = trackLong.totalLength * 0.5;
    const sL0 = sampleFlightTrack(trackLong, dLong);
    const sL1 = sampleFlightTrack(trackLong, dLong + distStep);
    expect(sL0.phase).toBe("CRUISE");
    const moveLong = Math.hypot(sL1.x - sL0.x, sL1.y - sL0.y);
    const speedLong = moveLong / dt;

    expect(speedShort).toBeGreaterThanOrEqual(
      SIM_CONFIG.AVIATION.cruiseSpeed * 0.98,
    );
    expect(speedShort).toBeLessThanOrEqual(
      SIM_CONFIG.AVIATION.cruiseSpeed * 1.02,
    );
    expect(speedLong).toBeGreaterThanOrEqual(
      SIM_CONFIG.AVIATION.cruiseSpeed * 0.98,
    );
    expect(speedLong).toBeLessThanOrEqual(
      SIM_CONFIG.AVIATION.cruiseSpeed * 1.02,
    );
    expect(Math.abs(speedShort - speedLong)).toBeLessThanOrEqual(
      SIM_CONFIG.AVIATION.cruiseSpeed * 0.02,
    );
  });

  test("5-Phase Gate-to-Gate Lifecycle (TAXI_OUT -> TAKEOFF -> CRUISE -> LANDING -> TAXI_IN -> GATE_DWELL) (Plan B Phase 5.2)", () => {
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
    const plane = sim.planes[0];
    const track = plane.track;

    // 1. Verify track.pts visits all 5 track phases in order
    const orderedPhases = [];
    for (const pt of track.pts) {
      if (
        orderedPhases.length === 0 ||
        orderedPhases[orderedPhases.length - 1] !== pt.phase
      ) {
        orderedPhases.push(pt.phase);
      }
    }
    expect(orderedPhases).toEqual([
      "TAXI_OUT",
      "TAKEOFF",
      "CRUISE",
      "LANDING",
      "TAXI_IN",
    ]);

    // 2. Altitude checks: 0 during TAXI_OUT and TAXI_IN, > 0 during CRUISE
    for (const pt of track.pts) {
      if (pt.phase === "TAXI_OUT" || pt.phase === "TAXI_IN") {
        expect(pt.altitude).toBe(0);
      } else if (pt.phase === "CRUISE") {
        expect(pt.altitude).toBeGreaterThan(0);
      }
    }

    // 3. Step simulator forward until plane reaches end of track and enters GATE_DWELL
    sim.cars = [];
    sim.planes = [plane];
    plane.dist = track.totalLength - 0.1;
    sim.update(0.1, 1.0);

    expect(plane.phase).toBe("GATE_DWELL");
    expect(plane.altitude).toBe(0);
    expect(plane.dwellTimer).toBeGreaterThanOrEqual(0);

    // 4. Step while in GATE_DWELL and advance through gate dwell (zero lateral gate jump on turnaround)
    const dwellGateX = plane.x;
    const dwellGateY = plane.y;
    const prevTrips = sim.tripsCompleted;
    sim.update(SIM_CONFIG.AVIATION.gateDwellSec + 0.1, 1.0);

    expect(sim.tripsCompleted - prevTrips).toBe(
      SIM_CONFIG.FLEET.flightTripWeight,
    );
    expect(plane.phase).toBe("TAXI_OUT");
    expect(plane.dist).toBe(0);
    expect(Math.hypot(plane.x - dwellGateX, plane.y - dwellGateY)).toBeLessThan(
      1e-4,
    );
  });

  test("Dual-Runway Hub Offset Separation (Plan B Phase 5.3)", () => {
    const hubOrigin = {
      x: 50,
      y: 100,
      halfLen: 14,
      angleRad: 0,
      apronSide: 1,
      isHub: true,
      airportClass: "HUB",
    };
    const hubDest = {
      x: 200,
      y: 100,
      halfLen: 14,
      angleRad: 0,
      apronSide: 1,
      isHub: true,
      airportClass: "HUB",
    };

    const trackHub = buildFlightTrack(hubOrigin, hubDest);
    const hubTakeoffs = trackHub.pts.filter(
      (p) => p.phase === "TAKEOFF" && p.altitude === 0,
    );
    expect(hubTakeoffs.length).toBeGreaterThan(0);
    for (const p of hubTakeoffs) {
      expect(Math.abs(p.y - hubOrigin.y - -0.85)).toBeLessThan(1e-4);
    }

    const hubLandings = trackHub.pts.filter(
      (p) => p.phase === "LANDING" && p.altitude === 0,
    );
    expect(hubLandings.length).toBeGreaterThan(0);
    for (const p of hubLandings) {
      expect(Math.abs(p.y - hubDest.y - -2.55)).toBeLessThan(1e-4);
    }

    const regOrigin = {
      x: 50,
      y: 100,
      halfLen: 10,
      angleRad: 0,
      apronSide: 1,
      isHub: false,
      airportClass: "REG",
    };
    const regDest = {
      x: 200,
      y: 100,
      halfLen: 10,
      angleRad: 0,
      apronSide: 1,
      isHub: false,
      airportClass: "REG",
    };

    const trackReg = buildFlightTrack(regOrigin, regDest);
    const regTakeoffs = trackReg.pts.filter(
      (p) => p.phase === "TAKEOFF" && p.altitude === 0,
    );
    expect(regTakeoffs.length).toBeGreaterThan(0);
    for (const p of regTakeoffs) {
      expect(Math.abs(p.y - regOrigin.y - -0.58)).toBeLessThan(1e-4);
    }

    const regLandings = trackReg.pts.filter(
      (p) => p.phase === "LANDING" && p.altitude === 0,
    );
    expect(regLandings.length).toBeGreaterThan(0);
    for (const p of regLandings) {
      expect(Math.abs(p.y - regDest.y - -0.58)).toBeLessThan(1e-4);
    }
  });

  test("Single-Runway Hold-Short Separation Lock (Plan B Phase 5.4)", () => {
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
      buildingDensity: 200,
      airportCount: 2,
      windAxis: -1,
    });

    const regAp = world.airports.find((a) => !a.isHub);
    expect(regAp).toBeDefined();
    if (!regAp) return;
    const otherAp = world.airports.find((a) => a.id !== regAp.id);
    expect(otherAp).toBeDefined();
    if (!otherAp) return;

    const sim = new LogisticsSimulator(world);
    sim.cars = [];

    // Departing plane from single-runway regional airport
    const trackDep = buildFlightTrack(regAp, otherAp, { gateIndex: 0 });
    const distDep = trackDep.holdShortDist - 0.15;
    const sampleDep = sampleFlightTrack(trackDep, distDep);
    const planeDep = {
      origin: regAp,
      dest: otherAp,
      track: trackDep,
      dist: distDep,
      segIdx: sampleDep.segIdx,
      phase: sampleDep.phase,
      altitude: sampleDep.altitude,
      x: sampleDep.x,
      y: sampleDep.y,
      ang: sampleDep.ang,
      speed: sampleDep.speed,
      dwellTimer: 0,
      holdingShort: false,
      isCargoFreighter: false,
      color: "#e65100",
      progress: distDep / trackDep.totalLength,
    };

    // Arriving plane at single-runway airport on short final (LANDING phase)
    const trackArr = buildFlightTrack(otherAp, regAp, { gateIndex: 1 });
    let arrLandDist = trackArr.totalLength;
    for (let i = 0; i < trackArr.pts.length; i++) {
      if (trackArr.pts[i].phase === "LANDING") {
        arrLandDist = trackArr.cumLen[i];
        break;
      }
    }
    const distArr = arrLandDist + 0.5;
    const sampleArr = sampleFlightTrack(trackArr, distArr);
    const planeArr = {
      origin: otherAp,
      dest: regAp,
      track: trackArr,
      dist: distArr,
      segIdx: sampleArr.segIdx,
      phase: sampleArr.phase,
      altitude: sampleArr.altitude,
      x: sampleArr.x,
      y: sampleArr.y,
      ang: sampleArr.ang,
      speed: sampleArr.speed,
      dwellTimer: 0,
      holdingShort: false,
      isCargoFreighter: false,
      color: "#e65100",
      progress: distArr / trackArr.totalLength,
    };

    sim.planes = [planeDep, planeArr];

    // 1. Assert departing plane holds short while arrival is landing
    sim.update(0.2, 1.0);
    expect(planeDep.holdingShort).toBe(true);
    expect(planeDep.dist).toBeLessThanOrEqual(trackDep.holdShortDist);

    // 2. Clear runway by advancing arriving plane to TAXI_IN
    let taxiInDist = trackArr.totalLength;
    for (let i = 0; i < trackArr.pts.length; i++) {
      if (trackArr.pts[i].phase === "TAXI_IN") {
        taxiInDist = trackArr.cumLen[i];
        break;
      }
    }
    planeArr.dist = taxiInDist + 0.5;
    planeArr.phase = "TAXI_IN";

    // 3. Assert departing plane releases hold-short and advances onto runway
    sim.update(0.2, 1.0);
    expect(planeDep.holdingShort).toBe(false);
    expect(planeDep.dist).toBeGreaterThan(trackDep.holdShortDist);
  });
});
