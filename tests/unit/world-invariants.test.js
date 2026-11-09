import { describe, test, expect } from "bun:test";
import { createWorldPipeline } from "../../src/world-generator.js";
import { MiniMotorwaysRenderer } from "../../src/renderer.js";

const TERRAIN_ALGOS = ["tectonic-fbm", "quilez-erosion", "voronoi-plates"];
const HYDRO_ALGOS = ["thalweg-astar", "d8-strahler", "meandering-plain"];

describe("Hourglass 3x3 Terrain x Hydrology Solver Matrix & Domain Invariants", () => {
  test("All 3x3 Terrain x Hydrology combinations satisfy the (elevationField, seaLevel, waterMask, rivers) contract", () => {
    const pipeline = createWorldPipeline();

    for (const terrainAlgo of TERRAIN_ALGOS) {
      for (const hydrologyAlgo of HYDRO_ALGOS) {
        const world = pipeline({
          seed: "OTTD-METRO-84",
          worldSize: "compact",
          archetype: "confluence",
          terrainAlgo,
          hydrologyAlgo,
          airportMix: "hub-regional",
          includeIntermediateRamps: true,
          waterCoverage: 48,
          townCount: 14,
          buildingDensity: 200,
          airportCount: 2,
          windAxis: -1,
        });

        expect(world.W).toBe(240);
        expect(world.H).toBe(150);
        expect(world.seaLevel).toBeGreaterThanOrEqual(0.02);
        expect(world.seaLevel).toBeLessThanOrEqual(0.6);
        expect(world.rivers.length).toBeGreaterThan(0);

        for (let i = 0; i < world.elevationField.length; i++) {
          const el = world.elevationField[i];
          const wm = world.waterMask[i];
          expect(Number.isFinite(el)).toBe(true);
          expect(wm === 0 || wm === 1 || wm === 2).toBe(true);
        }

        for (const river of world.rivers) {
          expect(river.points.length).toBeGreaterThanOrEqual(4);
          const firstW = river.points[0].width ?? 0;
          const lastW = river.points[river.points.length - 1].width ?? 0;
          expect(lastW).toBeGreaterThanOrEqual(firstW);

          // Mainstem channel centers carve waterMask > 0
          const midPt = river.points[Math.floor(river.points.length * 0.5)];
          expect(world.waterMask[world.idx(midPt.x, midPt.y)]).toBeGreaterThan(
            0,
          );

          // Interior highland springs maintain a 6-tile surface road exclusion buffer around headwaterPt
          if (river.headwaterPt) {
            const { x: hx, y: hy } = river.headwaterPt;
            for (let dy = -5; dy <= 5; dy++) {
              for (let dx = -5; dx <= 5; dx++) {
                if (dx * dx + dy * dy > 25) continue;
                const gx = hx + dx;
                const gy = hy + dy;
                if (world.inBounds(gx, gy, 0)) {
                  expect(world.roadGrid[world.idx(gx, gy)]).toBe(0);
                }
              }
            }
          }
        }
      }
    }
  });

  test("Benchmark seeds satisfy Road Graph Diagnostics, Bridge Span, Driveway, Expressway, Tunnel & Diamond Ramp invariants", () => {
    const pipeline = createWorldPipeline();
    const renderer = new MiniMotorwaysRenderer(null);
    const benchmarks = [
      { seed: "OTTD-METRO-84", archetype: "confluence", worldSize: "compact" },
      { seed: "DELTA-402", archetype: "estuary", worldSize: "compact" },
      { seed: "HARBOR-305", archetype: "archipelago", worldSize: "compact" },
      { seed: "VALLEY-618", archetype: "inland", worldSize: "compact" },
      {
        seed: "ISLAND-HOP-101",
        archetype: "island-hopper",
        worldSize: "compact",
      },
    ];

    for (const bm of benchmarks) {
      const world = pipeline({
        seed: bm.seed,
        worldSize: bm.worldSize,
        archetype: bm.archetype,
        terrainAlgo: "tectonic-fbm",
        hydrologyAlgo: "thalweg-astar",
        airportMix: "hub-regional",
        includeIntermediateRamps: true,
        waterCoverage: 48,
        townCount: bm.archetype === "island-hopper" ? 16 : 14,
        buildingDensity: 220,
        airportCount: bm.archetype === "island-hopper" ? 5 : 2,
        windAxis: -1,
      });

      // 1. Road Graph Diagnostics: zero road-building overlaps, zero non-octilinear edges, zero orphan roadGrid tiles
      const diag = renderer.computeRoadGraphDiagnostics(world);
      expect(diag.anomalies).toEqual([]);

      // 2. River bridge span invariant: no road braids lengthwise along a river channel (`waterMask === 1`)
      for (const r of world.roads) {
        let consecutiveRiverBridgeSteps = 0;
        for (const pt of r.points) {
          const gx = Math.round(pt.x);
          const gy = Math.round(pt.y);
          const isRiverChannel =
            world.inBounds(gx, gy, 0) &&
            world.waterMask[world.idx(gx, gy)] === 1;
          if (pt.isBridge && isRiverChannel) {
            consecutiveRiverBridgeSteps++;
            expect(consecutiveRiverBridgeSteps).toBeLessThanOrEqual(5);
          } else {
            consecutiveRiverBridgeSteps = 0;
          }
        }
      }

      // 3. Every placed house and destination has a valid driveway on an active road tile
      for (const h of world.houses) {
        expect(world.inBounds(h.roadX, h.roadY, 0)).toBe(true);
        expect(world.roadGrid[world.idx(h.roadX, h.roadY)]).toBeGreaterThan(0);
      }
      for (const d of world.destinations) {
        expect(world.inBounds(d.roadX, d.roadY, 0)).toBe(true);
        expect(world.roadGrid[world.idx(d.roadX, d.roadY)]).toBeGreaterThan(0);
      }

      // 4. Expressway, Tunnel & Diamond Interchange geometric invariants
      for (const mw of world.motorways) {
        expect(
          world.doesPolylineCrossAirport(mw.samples, 1.8, mw.airportId),
        ).toBe(false);

        for (let i = 2; i < mw.samples.length; i++) {
          const prevDx = mw.samples[i - 1].x - mw.samples[i - 2].x;
          const prevDy = mw.samples[i - 1].y - mw.samples[i - 2].y;
          const segDx = mw.samples[i].x - mw.samples[i - 1].x;
          const segDy = mw.samples[i].y - mw.samples[i - 1].y;
          const l1 = Math.hypot(prevDx, prevDy);
          const l2 = Math.hypot(segDx, segDy);
          if (l1 > 1e-4 && l2 > 1e-4) {
            const cosTurn = (prevDx * segDx + prevDy * segDy) / (l1 * l2);
            expect(cosTurn).toBeGreaterThanOrEqual(0.34);
          }
        }

        for (const tun of mw.tunnels || []) {
          expect(tun.i1 - tun.i0).toBeGreaterThanOrEqual(6);
          for (let sIdx = tun.i0; sIdx <= tun.i1; sIdx++) {
            const sPt = mw.samples[sIdx];
            for (const ic of world.interchanges) {
              if (
                ic.type === "cloverleaf" ||
                ic.type === "trumpet" ||
                ic.type === "diamond-ramp"
              ) {
                expect(
                  Math.hypot(ic.x - sPt.x, ic.y - sPt.y),
                ).toBeGreaterThanOrEqual(11.0);
              }
            }
          }
        }
      }

      // 5. Octilinear Diamond Underpasses & 4 Flexible World-Space Slip-Ramps
      for (const ic of world.interchanges) {
        if (ic.type === "diamond-ramp") {
          const dx = ic.posTerm.x - ic.negTerm.x;
          const dy = ic.posTerm.y - ic.negTerm.y;
          const isOctilinear =
            dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy);
          expect(isOctilinear).toBe(true);
          expect(ic.ramps.length).toBe(4);
          for (const ramp of ic.ramps) {
            expect(ramp.p3.x).toBe(ramp.gridX);
            expect(ramp.p3.y).toBe(ramp.gridY);
            expect(Number.isFinite(ramp.p0.x)).toBe(true);
            expect(Number.isFinite(ramp.p1.x)).toBe(true);
            expect(Number.isFinite(ramp.p2.x)).toBe(true);
          }
        }
      }
    }
  });
});
