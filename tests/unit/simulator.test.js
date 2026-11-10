import { describe, test, expect } from "bun:test";
import { createWorldPipeline } from "../../src/world-generator.js";
import {
  LogisticsSimulator,
  buildFlightTrack,
  sampleFlightTrack,
  initAirportATC,
  canPushBackOntoTaxiway,
  maintainTaxiwayOrder,
  canWidebodyServe,
  createExternalEndpoint,
} from "../../src/simulator.js";
import { computeTrumpetRampBeziers } from "../../src/vehicle-routing.js";
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
 * Shortest angular difference between two angles in radians.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function angDiff(a, b) {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

/**
 * Determines closest distance from (mx, my) to interchange ramps or within interchange envelope.
 * @param {number} mx
 * @param {number} my
 * @param {any[]} interchanges
 * @returns {number}
 */
function distToInterchangeRamps(mx, my, interchanges, motorways = []) {
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
            ic.x + rAx * 3.65,
            ic.y + rAy * 3.65,
            ic.x + (rAx + rBx) * 1.75,
            ic.y + (rAy + rBy) * 1.75,
            ic.x + rBx * 3.65,
            ic.y + rBy * 3.65,
          );
          sampleCubic(
            ic.x,
            ic.y,
            ic.x + rAx * 4.85,
            ic.y + rAy * 4.85,
            ic.x + rBx * 4.85,
            ic.y + rBy * 4.85,
            ic.x,
            ic.y,
          );
        }
      }
    } else if (ic.type === "trumpet") {
      const ramps = computeTrumpetRampBeziers(ic, motorways);
      for (const seg of [
        ramps.yellow,
        ramps.purple,
        ...ramps.brown,
        ...ramps.blue,
      ]) {
        sampleCubic(
          seg.p0.x,
          seg.p0.y,
          seg.p1.x,
          seg.p1.y,
          seg.p2.x,
          seg.p2.y,
          seg.p3.x,
          seg.p3.y,
        );
      }
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
      { seed: "DELTA-402", archetype: "barrier-lagoon" },
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
            const dRamp = distToInterchangeRamps(
              mx,
              my,
              interchanges,
              world.motorways,
            );
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

        // 3. Zero Cross-Carriageway Ramp Exits/Merges: ramp transitions never cross onto the opposing motorway lane
        for (let i = 2; i < pts.length - 2; i++) {
          const isHwyExit =
            pts[i - 1].onMotorway &&
            !pts[i - 1].isSlipRamp &&
            pts[i].isSlipRamp;
          const isHwyMerge =
            pts[i - 1].isSlipRamp && pts[i].onMotorway && !pts[i].isSlipRamp;
          if (!isHwyExit && !isHwyMerge) continue;

          const mwPt = isHwyExit ? pts[i - 1] : pts[i];
          const mwOther = isHwyExit ? pts[i - 2] : pts[i + 1];
          const vx = isHwyExit ? mwPt.x - mwOther.x : mwOther.x - mwPt.x;
          const vy = isHwyExit ? mwPt.y - mwOther.y : mwOther.y - mwPt.y;
          const vLen = Math.hypot(vx, vy) || 1;

          /** @type {import("../../src/types.js").Motorway | null} */
          let bestMw = null;
          let bestMwD = Infinity;
          let isFwd = true;
          for (const mw of world.motorways) {
            for (let k = 0; k < mw.samples.length - 1; k++) {
              const ax = mw.samples[k].x;
              const ay = mw.samples[k].y;
              const bx = mw.samples[k + 1].x;
              const by = mw.samples[k + 1].y;
              const sdx = bx - ax;
              const sdy = by - ay;
              const sLen = Math.hypot(sdx, sdy) || 1;
              if (Math.abs((vx * sdx + vy * sdy) / (vLen * sLen)) < 0.7)
                continue;
              const t = Math.max(
                0,
                Math.min(
                  1,
                  ((mwPt.x - ax) * sdx + (mwPt.y - ay) * sdy) / (sLen * sLen),
                ),
              );
              const d = Math.hypot(
                mwPt.x - (ax + t * sdx),
                mwPt.y - (ay + t * sdy),
              );
              if (d < bestMwD) {
                bestMwD = d;
                bestMw = mw;
                isFwd = vx * sdx + vy * sdy >= 0;
              }
            }
          }
          if (!bestMw) continue;

          const rampIdx = isHwyExit ? i : i - 1;
          const rPt = pts[rampIdx];
          let minSegD = Infinity;
          let signedRight = 0;
          let atEnd = false;
          const s = bestMw.samples;
          for (let k = 0; k < s.length - 1; k++) {
            const ax = s[k].x;
            const ay = s[k].y;
            const bx = s[k + 1].x;
            const by = s[k + 1].y;
            const dx = bx - ax;
            const dy = by - ay;
            const l2 = dx * dx + dy * dy || 1;
            const t = Math.max(
              0,
              Math.min(1, ((rPt.x - ax) * dx + (rPt.y - ay) * dy) / l2),
            );
            const cx = ax + t * dx;
            const cy = ay + t * dy;
            const d = Math.hypot(rPt.x - cx, rPt.y - cy);
            if (d < minSegD) {
              minSegD = d;
              atEnd = (k === 0 && t === 0) || (k === s.length - 2 && t === 1);
              const len = Math.sqrt(l2) || 1;
              const dir = isFwd ? 1 : -1;
              const nRx = (-dy / len) * dir;
              const nRy = (dx / len) * dir;
              signedRight = (rPt.x - cx) * nRx + (rPt.y - cy) * nRy;
            }
          }
          if (!atEnd) {
            expect(signedRight).toBeGreaterThanOrEqual(-0.02);
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
      expect(Math.abs(p.y - hubOrigin.y - -1.72)).toBeLessThan(1e-4);
    }

    const hubLandings = trackHub.pts.filter(
      (p) => p.phase === "LANDING" && p.altitude === 0,
    );
    expect(hubLandings.length).toBeGreaterThan(0);
    for (const p of hubLandings) {
      expect(Math.abs(p.y - hubDest.y - -3.35)).toBeLessThan(1e-4);
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
      expect(Math.abs(p.y - regOrigin.y - -1.68)).toBeLessThan(1e-4);
    }

    const regLandings = trackReg.pts.filter(
      (p) => p.phase === "LANDING" && p.altitude === 0,
    );
    expect(regLandings.length).toBeGreaterThan(0);
    for (const p of regLandings) {
      expect(Math.abs(p.y - regDest.y - -1.68)).toBeLessThan(1e-4);
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

  test("AirportATC & 10-State Aircraft FSM: Zero Gate Collisions, Zero Taxiway Overtaking & Runway Mutual Exclusion over 2,000 ticks (Phase 6)", () => {
    const pipeline = createWorldPipeline();
    for (const [seed, archetype] of /** @type {const} */ ([
      ["OTTD-METRO-84", "confluence"],
      ["ISLAND-HOP-101", "island-hopper"],
    ])) {
      const world = pipeline({
        seed,
        worldSize: archetype === "island-hopper" ? "standard" : "compact",
        archetype,
        terrainAlgo: "tectonic-fbm",
        hydrologyAlgo: "thalweg-astar",
        airportMix: "hub-reg-cargo",
        includeIntermediateRamps: true,
        waterCoverage: 48,
        townCount: 14,
        buildingDensity: 200,
        airportCount: 3,
        windAxis: -1,
      });

      const sim = new LogisticsSimulator(world);
      sim.cars = [];
      expect(sim.planes.length).toBeGreaterThan(0);

      for (const ap of world.airports) {
        expect(ap.atc).toBeDefined();
        expect(ap.atc?.gates.length).toBe(ap.isHub ? 7 : 4);
        for (const g of ap.atc?.gates ?? []) {
          expect(Math.abs(g.ly - (ap.atc?.taxiY ?? 0))).toBeGreaterThanOrEqual(
            1.4,
          );
        }
      }

      const minSep = SIM_CONFIG.AVIATION.minTaxiSeparation;

      for (let tick = 0; tick < 2000; tick++) {
        const prevPos = sim.planes.map((pl) => ({ x: pl.x, y: pl.y }));
        sim.update(0.15, 1.0);
        for (let pIdx = 0; pIdx < sim.planes.length; pIdx++) {
          const stepDist = Math.hypot(
            sim.planes[pIdx].x - prevPos[pIdx].x,
            sim.planes[pIdx].y - prevPos[pIdx].y,
          );
          expect(stepDist).toBeLessThanOrEqual(3.2);
        }

        for (const ap of world.airports) {
          const atc = ap.atc;
          if (!atc) continue;

          // 1. Zero Gate Double-Occupancy & Exact GateSlot World Coordinates
          const seenGatePlanes = new Set();
          for (const g of atc.gates) {
            if (g.occupiedBy !== null) {
              expect(seenGatePlanes.has(g.occupiedBy)).toBe(false);
              seenGatePlanes.add(g.occupiedBy);
              const parkedPlane = sim.planes.find(
                (pl) => pl.id === g.occupiedBy,
              );
              expect(parkedPlane).toBeDefined();
              expect(
                parkedPlane?.state === "GATE_LOADING" ||
                  parkedPlane?.state === "PUSHBACK_HOLD",
              ).toBe(true);
              expect(
                Math.hypot(
                  (parkedPlane?.x ?? 0) - g.worldX,
                  (parkedPlane?.y ?? 0) - g.worldY,
                ),
              ).toBeLessThan(1e-3);
            }
            if (g.reservedBy !== null && g.reservedBy !== g.occupiedBy) {
              expect(seenGatePlanes.has(g.reservedBy)).toBe(false);
              seenGatePlanes.add(g.reservedBy);
            }
          }

          // 2. Zero Taxiway Overtaking or Collisions (1D taxiS AND 2D World Coordinates):
          // Parked gate planes (GATE_LOADING / PUSHBACK_HOLD) are never in taxiwayOccupants,
          // and consecutive taxiway occupants maintain >= minTaxiSeparation in taxiS and >= 1.5 tiles in (x, y).
          const occ = atc.taxiwayOccupants;
          for (let i = 0; i < occ.length; i++) {
            const p = occ[i];
            expect(
              p.state === "GATE_LOADING" || p.state === "PUSHBACK_HOLD",
            ).toBe(false);
            if (i > 0) {
              const leader = occ[i - 1];
              const leaderS = leader.taxiS ?? 0;
              const followerS = p.taxiS ?? 0;
              expect(leaderS - followerS).toBeGreaterThanOrEqual(minSep - 1e-3);
              const worldDist = Math.hypot(leader.x - p.x, leader.y - p.y);
              expect(worldDist).toBeGreaterThanOrEqual(1.45);
            }
          }

          // 3. Runway & Inter-Runway Crossing Mutual Exclusion
          if (!ap.isHub) {
            expect(
              atc.depRunwayBusyBy !== null &&
                atc.arrRunwayBusyBy !== null &&
                atc.depRunwayBusyBy !== atc.arrRunwayBusyBy,
            ).toBe(false);
          } else {
            expect(
              atc.depRunwayBusyBy !== null && atc.crossingBusyBy !== null,
            ).toBe(false);
          }
        }
      }
    }
  });

  test("Off-Spine Gate Non-Blocking & 1D Leader-Follower Taxiway Spacing", () => {
    const hubAp = /** @type {any} */ ({
      id: 0,
      x: 100,
      y: 100,
      halfLen: 14,
      halfWid: 4,
      angleRad: 0,
      apronSide: 1,
      isHub: true,
      airportClass: "HUB",
    });
    const atc = initAirportATC(hubAp, { x: -1, y: 0 });
    expect(atc.gates.length).toBe(7);

    // Park a plane at middle gate (index 3) — off the taxiway spine
    const middleGate = atc.gates[3];
    middleGate.state = "OCCUPIED";
    middleGate.occupiedBy = 99;

    // A plane on the taxiway spine can pass freely past middleGate.taxiS because gate stands are off-spine
    const leaderPlane = /** @type {any} */ ({
      id: 1,
      state: "TAXI_TO_RUNWAY",
      taxiS: middleGate.taxiS + 4.0,
    });
    const followerPlane = /** @type {any} */ ({
      id: 2,
      state: "TAXI_TO_RUNWAY",
      taxiS: middleGate.taxiS + 3.0, // Too close (1.0 < 2.4)
    });
    atc.taxiwayOccupants = [leaderPlane, followerPlane];
    maintainTaxiwayOrder(atc);

    expect(leaderPlane.taxiS - followerPlane.taxiS).toBeGreaterThanOrEqual(
      SIM_CONFIG.AVIATION.minTaxiSeparation - 1e-4,
    );

    // While followerPlane is within pushbackClearLead/Trail of middleGate.taxiS, middleGate cannot push back
    followerPlane.taxiS = middleGate.taxiS;
    expect(canPushBackOntoTaxiway(atc, middleGate.taxiS)).toBe(false);

    // Once taxiway occupants move clear of middleGate.taxiS, pushback is permitted
    leaderPlane.taxiS = middleGate.taxiS + 6.0;
    followerPlane.taxiS = middleGate.taxiS + 3.2;
    expect(canPushBackOntoTaxiway(atc, middleGate.taxiS)).toBe(true);

    // Verify smooth monotonic acceleration during TAKEOFF_ROLL from taxiSpeed (2.2) to takeoffSpeed (13.5)
    const destAp = /** @type {any} */ ({
      id: 1,
      x: 240,
      y: 100,
      halfLen: 10,
      halfWid: 3,
      angleRad: 0,
      apronSide: 1,
      isHub: false,
      airportClass: "REG",
    });
    const track = buildFlightTrack(hubAp, destAp);
    const sim = new LogisticsSimulator(
      /** @type {any} */ ({
        W: 360,
        H: 224,
        config: {},
        airports: [hubAp, destAp],
        cargoLinks: [],
        commuterRoutes: [],
      }),
    );
    sim.cars = [];
    const plane = sim.planes[0];
    plane.origin = hubAp;
    plane.dest = destAp;
    plane.track = track;
    plane.dist = track.holdShortDist;
    plane.state = "TAKEOFF_ROLL";
    plane.phase = "TAKEOFF";
    sim.planes = [plane];

    const speeds = [];
    while (plane.state === "TAKEOFF_ROLL") {
      sim.update(0.12, 1.0);
      speeds.push(plane.speed);
    }
    expect(speeds.length).toBeGreaterThanOrEqual(8);
    expect(speeds[0]).toBeLessThanOrEqual(SIM_CONFIG.AVIATION.taxiSpeed + 0.5);
    expect(speeds[speeds.length - 1]).toBeGreaterThanOrEqual(
      SIM_CONFIG.AVIATION.takeoffSpeed - 0.5,
    );
    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]).toBeGreaterThanOrEqual(speeds[i - 1] - 1e-4);
    }

    // Verify APPROACH_QUEUE flies a continuous holding pattern (never pauses in mid-air) and exits smoothly onto final
    const destAtc = initAirportATC(destAp, { x: -1, y: 0 });
    let landingStartDist = track.totalLength;
    for (let i = 0; i < track.pts.length; i++) {
      if (track.pts[i].phase === "LANDING") {
        landingStartDist = track.cumLen[i];
        break;
      }
    }
    const blockerPlane = /** @type {any} */ ({
      id: 777,
      state: "LANDING_ROLLOUT",
      phase: "LANDING",
      origin: hubAp,
      dest: destAp,
      track,
      dist: landingStartDist + 0.2,
      segIdx: 0,
      altitude: 0.1,
      x: destAp.x,
      y: destAp.y,
      ang: 0,
      speed: 0,
      dwellTimer: 0,
      holdingShort: false,
      isCargoFreighter: false,
      color: "#000000",
      progress: 0.8,
    });
    destAtc.runwayBusyBy = 777;

    plane.dist = landingStartDist - 0.2;
    plane.state = /** @type {import("../../src/types.js").PlaneFSMState} */ (
      "ENROUTE_CRUISE"
    );
    plane.phase = "CRUISE";
    const sInit = sampleFlightTrack(track, plane.dist);
    plane.x = sInit.x;
    plane.y = sInit.y;
    plane.ang = sInit.ang;
    sim.planes = [plane, blockerPlane];

    const dtHold = 0.08;
    for (let step = 0; step < 12; step++) {
      blockerPlane.dist = landingStartDist + 0.2;
      blockerPlane.state = "LANDING_ROLLOUT";
      destAtc.runwayBusyBy = 777;
      const prevX = plane.x;
      const prevY = plane.y;
      sim.update(dtHold, 1.0);
      const moved = Math.hypot(plane.x - prevX, plane.y - prevY);
      // Plane must keep moving in the air every single tick (never pause stationary)
      expect(moved).toBeGreaterThan(0.45);
      expect(moved).toBeLessThan(2.5);
    }
    expect(plane.state).toBe("APPROACH_QUEUE");

    // Release destination runway lock and verify plane completes its holding turn back to the fix and lands without teleporting
    sim.planes = [plane];
    destAtc.runwayBusyBy = null;
    for (let step = 0; step < 80 && plane.state === "APPROACH_QUEUE"; step++) {
      const prevX = plane.x;
      const prevY = plane.y;
      sim.update(dtHold, 1.0);
      const moved = Math.hypot(plane.x - prevX, plane.y - prevY);
      expect(moved).toBeGreaterThan(0.45);
      expect(moved).toBeLessThan(2.5);
    }
    expect(plane.state).toBe("LANDING_ROLLOUT");
  });

  test("All 4 directional Trumpet interchange movements route via slip-ramps without reversals and traverse onUpperBridge nodes", () => {
    const pipeline = createWorldPipeline();
    const world = pipeline({
      seed: "VALLEY-618",
      worldSize: "standard",
      archetype: "inland",
      terrainAlgo: "tectonic-fbm",
      hydrologyAlgo: "thalweg-astar",
      airportMix: "hub-regional",
      includeIntermediateRamps: true,
      waterCoverage: 48,
      townCount: 20,
      buildingDensity: 250,
      airportCount: 3,
      windAxis: -1,
    });

    const trumpet = world.interchanges.find((ic) => ic.type === "trumpet");
    expect(trumpet).toBeDefined();
    if (!trumpet || trumpet.type !== "trumpet") return;

    const mainMw = world.motorways.find((m) => m.number === trumpet.mwayMain);
    const spurMw = world.motorways.find((m) => m.number === trumpet.mwaySpur);
    expect(mainMw).toBeDefined();
    expect(spurMw).toBeDefined();
    if (!mainMw || !spurMw) return;

    const spurEndAtIc =
      Math.hypot(spurMw.ex - trumpet.x, spurMw.ey - trumpet.y) <
      Math.hypot(spurMw.sx - trumpet.x, spurMw.sy - trumpet.y);
    const spurTerminal = spurEndAtIc
      ? { x: spurMw.sx, y: spurMw.sy }
      : { x: spurMw.ex, y: spurMw.ey };
    const mainWest = { x: mainMw.sx, y: mainMw.sy };
    const mainEast = { x: mainMw.ex, y: mainMw.ey };

    const movements = [
      [mainWest, spurTerminal],
      [spurTerminal, mainWest],
      [mainEast, spurTerminal],
      [spurTerminal, mainEast],
    ];

    let traversedTrumpetUpperSlipRamp = false;
    for (const [src, dst] of movements) {
      const rawPath = world.findVehicleNetworkPath(src.x, src.y, dst.x, dst.y);
      expect(rawPath).not.toBeNull();
      if (!rawPath) continue;

      const usesTrumpetRamp = rawPath.some(
        (p) =>
          p.isSlipRamp && Math.hypot(p.x - trumpet.x, p.y - trumpet.y) < 3.5,
      );
      expect(usesTrumpetRamp).toBe(true);

      if (
        rawPath.some(
          (p) =>
            p.isSlipRamp &&
            p.onUpperBridge &&
            Math.hypot(p.x - trumpet.x, p.y - trumpet.y) < 3.5,
        )
      ) {
        traversedTrumpetUpperSlipRamp = true;
      }

      const track = world.buildDirectedLaneTrajectory(src, dst, rawPath);
      expect(track).not.toBeNull();
      if (!track) continue;

      for (let i = 1; i < track.pts.length - 1; i++) {
        const p0 = track.pts[i - 1];
        const p1 = track.pts[i];
        const p2 = track.pts[i + 1];
        const dx0 = p1.x - p0.x;
        const dy0 = p1.y - p0.y;
        const dx1 = p2.x - p1.x;
        const dy1 = p2.y - p1.y;
        const l0 = Math.hypot(dx0, dy0);
        const l1 = Math.hypot(dx1, dy1);
        if (l0 > 0.05 && l1 > 0.05) {
          const cosTurn = (dx0 * dx1 + dy0 * dy1) / (l0 * l1);
          expect(cosTurn).toBeGreaterThanOrEqual(-0.5);
        }
      }
    }

    expect(traversedTrumpetUpperSlipRamp).toBe(true);
  }, 15000);

  test("Single-Runway Deadlock Immunity & 60fps Smooth Ground Turns (Pushback, Docking & Taxi Corners)", () => {
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
      townCount: 14,
      buildingDensity: 200,
      airportCount: 3,
      windAxis: -1,
    });

    // 1. Single-runway regional airport deadlock immunity:
    // A departure in HOLD_SHORT_QUEUE and an arrival in APPROACH_QUEUE with runway clear
    // must clear planeDep into TAKEOFF_ROLL instead of circular-waiting/deadlocking.
    const regAp = world.airports.find((a) => !a.isHub);
    expect(regAp).toBeDefined();
    if (!regAp || !regAp.atc) return;

    const otherAp = world.airports.find((a) => a.id !== regAp.id);
    expect(otherAp).toBeDefined();
    if (!otherAp || !otherAp.atc) return;

    const sim = new LogisticsSimulator(world);
    sim.cars = [];

    const trackDep = buildFlightTrack(regAp, otherAp, { gateIndex: 0 });
    const sDep = sampleFlightTrack(trackDep, trackDep.holdShortDist);
    /** @type {any} */
    const planeDep = {
      id: 101,
      origin: regAp,
      dest: otherAp,
      track: trackDep,
      dist: trackDep.holdShortDist,
      segIdx: sDep.segIdx,
      phase: "TAXI_OUT",
      state: "HOLD_SHORT_QUEUE",
      holdingShort: true,
      taxiS: regAp.atc.holdShortS,
      altitude: 0,
      x: sDep.x,
      y: sDep.y,
      ang: sDep.ang,
      speed: 0,
      dwellTimer: 0,
      isCargoFreighter: false,
      color: "#e65100",
      progress: trackDep.holdShortDist / trackDep.totalLength,
    };

    const trackArr = buildFlightTrack(otherAp, regAp, { gateIndex: 1 });
    let arrLandDist = trackArr.totalLength;
    for (let i = 0; i < trackArr.pts.length; i++) {
      if (trackArr.pts[i].phase === "LANDING") {
        arrLandDist = trackArr.cumLen[i];
        break;
      }
    }
    const sArr = sampleFlightTrack(trackArr, arrLandDist);
    /** @type {any} */
    const planeArr = {
      id: 102,
      origin: otherAp,
      dest: regAp,
      track: trackArr,
      dist: arrLandDist,
      segIdx: sArr.segIdx,
      phase: "CRUISE",
      state: "APPROACH_QUEUE",
      holdingShort: false,
      holdingPatternAngle: 0,
      altitude: 0.8,
      x: sArr.x,
      y: sArr.y,
      ang: sArr.ang,
      speed: SIM_CONFIG.AVIATION.landingSpeed * 0.85,
      dwellTimer: 0,
      isCargoFreighter: false,
      color: "#3b82f6",
      progress: arrLandDist / trackArr.totalLength,
    };

    const atc = regAp.atc;
    atc.runwayBusyBy = null;
    atc.depRunwayBusyBy = null;
    atc.arrRunwayBusyBy = null;
    atc.holdShortQueue = [planeDep];
    atc.approachQueue = [planeArr];
    atc.taxiwayOccupants = [planeDep];

    sim.planes = [planeDep, planeArr];

    sim.update(0.2, 1.0);

    expect(planeDep.state).toBe("TAKEOFF_ROLL");
    expect(planeDep.holdingShort).toBe(false);
    expect(atc.runwayBusyBy).toBe(planeDep.id);
    expect(atc.holdShortQueue.length).toBe(0);

    // 2. 60fps (dt = 1/60) smooth trajectory and ground-turn verification across 600 ticks on OTTD-METRO-84
    const sim60 = new LogisticsSimulator(world);
    sim60.cars = [];
    expect(sim60.planes.length).toBeGreaterThan(0);

    const maxDeltaPos = 0.35;
    const maxDeltaAng = (10 * Math.PI) / 180 + 1e-4;

    for (let tick = 0; tick < 600; tick++) {
      const prevMap = new Map(
        sim60.planes.map((p) => [p.id ?? -1, { x: p.x, y: p.y, ang: p.ang }]),
      );
      sim60.update(1 / 60, 1.0);
      for (const p of sim60.planes) {
        const prev = prevMap.get(p.id ?? -1);
        if (!prev) continue;
        const dPos = Math.hypot(p.x - prev.x, p.y - prev.y);
        const dAng = angDiff(p.ang, prev.ang);
        expect(dPos).toBeLessThanOrEqual(maxDeltaPos);
        expect(dAng).toBeLessThanOrEqual(maxDeltaAng);
      }
    }
  });

  test("Plan 2 Wave 2A Aviation Fleet & External Corridor Invariants", () => {
    // 1. canWidebodyServe returns true for HUB, CRG, and external endpoints, and false for REG airports
    expect(canWidebodyServe({ isHub: true, airportClass: "HUB" })).toBe(true);
    expect(
      canWidebodyServe({
        isHub: false,
        airportClass: "CRG",
        acceptsWidebody: true,
      }),
    ).toBe(true);
    expect(canWidebodyServe({ isExternal: true })).toBe(true);
    expect(
      canWidebodyServe({
        isHub: false,
        airportClass: "REG",
        acceptsWidebody: false,
      }),
    ).toBe(false);
    expect(canWidebodyServe(null)).toBe(false);
    expect(canWidebodyServe(undefined)).toBe(false);

    // 2. Setup OTTD-METRO-84 with airportMix: "hub-reg-cargo", airportCount: 3
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
      townCount: 14,
      buildingDensity: 200,
      airportCount: 3,
      windAxis: -1,
    });

    expect(world.airports.length).toBe(3);
    const hubAp = world.airports.find((a) => a.airportClass === "HUB");
    const crgAp = world.airports.find((a) => a.airportClass === "CRG");
    const regAp = world.airports.find((a) => a.airportClass === "REG");
    expect(hubAp).toBeDefined();
    expect(crgAp).toBeDefined();
    expect(regAp).toBeDefined();
    if (!hubAp || !crgAp || !regAp) return;

    expect(canWidebodyServe(hubAp)).toBe(true);
    expect(canWidebodyServe(crgAp)).toBe(true);
    expect(canWidebodyServe(regAp)).toBe(false);

    const sim = new LogisticsSimulator(world);
    expect(sim.planes.length).toBeGreaterThan(0);

    // Verify 3-class AircraftType fleet members exist
    const fleetTypes = new Set(sim.planes.map((p) => p.aircraftType));
    expect(fleetTypes.has("WIDEBODY_FREIGHTER")).toBe(true);
    expect(fleetTypes.has("FEEDER_TURBOPROP")).toBe(true);
    expect(fleetTypes.has("PASSENGER_JET")).toBe(true);

    // Across 1,000 ticks, no plane with aircraftType === "WIDEBODY_FREIGHTER" ever has
    // a REG airport (!canWidebodyServe(p.origin) or !canWidebodyServe(p.dest)) as origin or dest!
    let widebodyObservedCount = 0;
    for (let tick = 0; tick < 1000; tick++) {
      sim.update(0.1, 1.0);
      for (const p of sim.planes) {
        if (p.aircraftType === "WIDEBODY_FREIGHTER") {
          widebodyObservedCount++;
          expect(canWidebodyServe(p.origin)).toBe(true);
          expect(canWidebodyServe(p.dest)).toBe(true);
          expect(p.origin?.airportClass).not.toBe("REG");
          expect(p.dest?.airportClass).not.toBe("REG");
        }
      }
    }
    expect(widebodyObservedCount).toBeGreaterThan(0);

    // 3. Verify FEEDER_TURBOPROP aircraft exist in fleet, serve REG airports,
    // and buildFlightTrack uses SIM_CONFIG.AVIATION.turbopropCruiseSpeed (13.2 tiles/sec)
    const servesReg = sim.planes.some(
      (p) =>
        p.aircraftType === "FEEDER_TURBOPROP" &&
        (!canWidebodyServe(p.origin) || !canWidebodyServe(p.dest)),
    );
    expect(servesReg).toBe(true);

    expect(SIM_CONFIG.AVIATION.turbopropCruiseSpeed).toBe(13.2);
    const turbopropTrack = buildFlightTrack(regAp, hubAp, {
      aircraftType: "FEEDER_TURBOPROP",
    });
    const turbopropCruisePts = turbopropTrack.pts.filter(
      (pt) => pt.phase === "CRUISE",
    );
    expect(turbopropCruisePts.length).toBeGreaterThan(0);
    for (const pt of turbopropCruisePts) {
      expect(pt.speed).toBe(SIM_CONFIG.AVIATION.turbopropCruiseSpeed);
    }

    // 4. External corridor flight tracks & turnaround counters
    const extEndpoint = createExternalEndpoint(hubAp);
    expect(extEndpoint.isExternal).toBe(true);
    expect(extEndpoint.acceptsWidebody).toBe(true);

    // Outbound track (dest.isExternal = true): ends in "CRUISE" at cruiseAlt, omits LANDING/TAXI_IN
    const outboundTrack = buildFlightTrack(hubAp, extEndpoint);
    expect(outboundTrack.pts.length).toBeGreaterThan(0);
    expect(outboundTrack.pts[0].phase).toBe("TAXI_OUT");
    const lastOutPt = outboundTrack.pts[outboundTrack.pts.length - 1];
    expect(lastOutPt.phase).toBe("CRUISE");
    expect(lastOutPt.altitude).toBe(SIM_CONFIG.AVIATION.cruiseAlt);
    expect(outboundTrack.pts.some((pt) => pt.phase === "LANDING")).toBe(false);
    expect(outboundTrack.pts.some((pt) => pt.phase === "TAXI_IN")).toBe(false);

    // Inbound track (origin.isExternal = true): starts directly in "CRUISE" at cruiseAlt, omits TAXI_OUT/TAKEOFF
    const inboundTrack = buildFlightTrack(extEndpoint, hubAp);
    expect(inboundTrack.pts.length).toBeGreaterThan(0);
    const firstInPt = inboundTrack.pts[0];
    expect(firstInPt.phase).toBe("CRUISE");
    expect(firstInPt.altitude).toBe(SIM_CONFIG.AVIATION.cruiseAlt);
    expect(inboundTrack.pts[inboundTrack.pts.length - 1].phase).toBe("TAXI_IN");
    expect(inboundTrack.pts.some((pt) => pt.phase === "TAXI_OUT")).toBe(false);
    expect(inboundTrack.pts.some((pt) => pt.phase === "TAKEOFF")).toBe(false);

    // Outbound external flight reaching dest.isExternal during sim.update:
    // increments exportsCompleted on origin airport and turns around as an inbound external flight
    const simTurn = new LogisticsSimulator(world);
    simTurn.cars = [];
    hubAp.exportsCompleted = 0;
    hubAp.importsCompleted = 0;

    const planeOut = simTurn.planes[0];
    planeOut.origin = hubAp;
    planeOut.dest = extEndpoint;
    planeOut.track = outboundTrack;
    planeOut.state = "ENROUTE_CRUISE";
    planeOut.phase = "CRUISE";
    planeOut.dist = outboundTrack.totalLength - 0.4;
    planeOut.isExternalFlight = true;

    simTurn.planes = [planeOut];
    simTurn.update(0.1, 1.0);

    expect(hubAp.exportsCompleted).toBe(1);
    expect(planeOut.origin?.isExternal).toBe(true);
    expect(planeOut.dest).toBeDefined();
    expect(planeOut.dest.id).toBeDefined();
    expect(planeOut.state).toBe("ENROUTE_CRUISE");
    expect(planeOut.phase).toBe("CRUISE");
    expect(planeOut.isExternalFlight).toBe(true);

    // Advance inbound flight to landing rollout exit and verify importsCompleted increments on dest airport
    let taxiInDist = 0;
    for (let i = 0; i < planeOut.track.pts.length; i++) {
      if (planeOut.track.pts[i].phase === "TAXI_IN") {
        taxiInDist = planeOut.track.cumLen[i];
        break;
      }
    }
    expect(taxiInDist).toBeGreaterThan(0);

    planeOut.state = "LANDING_ROLLOUT";
    planeOut.phase = "LANDING";
    planeOut.dist = taxiInDist - 0.5;
    planeOut._importRecorded = false;
    const arrivalDest = planeOut.dest;
    arrivalDest.importsCompleted = 0;

    for (let step = 0; step < 20; step++) {
      simTurn.update(0.1, 1.0);
      if (arrivalDest.importsCompleted > 0) break;
    }
    expect(arrivalDest.importsCompleted).toBe(1);
  });
});
