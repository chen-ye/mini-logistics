import { describe, test, expect } from "bun:test";
import { createWorldPipeline } from "../../src/world-generator.js";
import { MiniMotorwaysRenderer } from "../../src/renderer.js";
import {
  describeBuildingDossier,
  getPartnerStageBadgeClass,
} from "../../src/inspector-component.js";
import {
  ALL_ENTITY_DEFINITIONS,
  hitTestEntities,
  resolveEntityByRef,
  getEntityCameraTarget,
  getEntityDefinition,
} from "../../src/entities/index.js";
import { LogisticsSimulator } from "../../src/simulator.js";
import { BUILDING_MASK } from "../../src/constants.js";
import { displaceBuildingsInRadius } from "../../src/expressway-solver.js";
import { hitTestRoadVehicle } from "../../src/entities/road-vehicle/inspect.js";

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

          // Smoothed-octilinear river run simplification: multi-tile octilinear runs without 1-tile H-V-H-V alternating chatter
          const pts = river.points;
          let runLen = 1;
          const runLengths = [];
          for (let i = 1; i < pts.length - 2; i++) {
            const dx = pts[i + 1].x - pts[i].x;
            const dy = pts[i + 1].y - pts[i].y;
            const isOctilinearStep =
              (Math.abs(dx) === 1 && dy === 0) ||
              (dx === 0 && Math.abs(dy) === 1) ||
              (Math.abs(dx) === 1 && Math.abs(dy) === 1);
            expect(isOctilinearStep).toBe(true);

            if (i > 1) {
              const prevDx = pts[i].x - pts[i - 1].x;
              const prevDy = pts[i].y - pts[i - 1].y;
              if (dx === prevDx && dy === prevDy) {
                runLen++;
              } else {
                runLengths.push(runLen);
                runLen = 1;
              }
            }
          }
          runLengths.push(runLen);
          const maxRun = Math.max(...runLengths);
          const avgRun =
            runLengths.reduce((sum, r) => sum + r, 0) / runLengths.length;
          expect(maxRun).toBeGreaterThanOrEqual(3);
          expect(avgRun).toBeGreaterThan(1.5);

          for (let i = 0; i < pts.length - 3; i++) {
            const s0x = pts[i + 1].x - pts[i].x;
            const s0y = pts[i + 1].y - pts[i].y;
            const s1x = pts[i + 2].x - pts[i + 1].x;
            const s1y = pts[i + 2].y - pts[i + 1].y;
            const s2x = pts[i + 3].x - pts[i + 2].x;
            const s2y = pts[i + 3].y - pts[i + 2].y;
            const isH0 = Math.abs(s0x) === 1 && s0y === 0;
            const isV0 = s0x === 0 && Math.abs(s0y) === 1;
            const isH1 = Math.abs(s1x) === 1 && s1y === 0;
            const isV1 = s1x === 0 && Math.abs(s1y) === 1;
            const isH2 = Math.abs(s2x) === 1 && s2y === 0;
            const isV2 = s2x === 0 && Math.abs(s2y) === 1;
            const isAlternatingHVHV =
              (isH0 && isV1 && isH2) || (isV0 && isH1 && isV2);
            expect(isAlternatingHVHV).toBe(false);
          }

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
  }, 15000);

  test("Benchmark seeds satisfy Road Graph Diagnostics, Bridge Span, Driveway, Expressway, Tunnel & Diamond Ramp invariants", () => {
    const pipeline = createWorldPipeline();
    const renderer = new MiniMotorwaysRenderer(null);
    const benchmarks = [
      { seed: "OTTD-METRO-84", archetype: "confluence", worldSize: "compact" },
      { seed: "DELTA-402", archetype: "fjord-sound", worldSize: "compact" },
      { seed: "HARBOR-305", archetype: "isthmus-strait", worldSize: "compact" },
      { seed: "LAGOON-714", archetype: "barrier-lagoon", worldSize: "compact" },
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

        // Highway sample density: uniform arc-length sampling >= 64 samples, avg step <= 0.95 tiles
        expect(mw.samples.length).toBeGreaterThanOrEqual(64);
        let totalStepLen = 0;
        for (let i = 1; i < mw.samples.length; i++) {
          totalStepLen += Math.hypot(
            mw.samples[i].x - mw.samples[i - 1].x,
            mw.samples[i].y - mw.samples[i - 1].y,
          );
        }
        const avgStepLen = totalStepLen / (mw.samples.length - 1);
        expect(avgStepLen).toBeLessThanOrEqual(0.95);

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

          // Compacted Diamond interchange bounds: reach from center <= 3.6 tiles
          expect(
            Math.hypot(ic.posTerm.x - ic.x, ic.posTerm.y - ic.y),
          ).toBeLessThanOrEqual(3.6);

          // House clearance along all 4 Diamond Bezier ramp curves: zero houses within 1.50 tiles
          for (const ramp of ic.ramps) {
            for (let step = 0; step < 10; step++) {
              const t0 = step / 10;
              const t1 = (step + 1) / 10;
              const mt0 = 1 - t0;
              const mt1 = 1 - t1;
              const segA = {
                x:
                  mt0 * mt0 * mt0 * ramp.p0.x +
                  3 * mt0 * mt0 * t0 * ramp.p1.x +
                  3 * mt0 * t0 * t0 * ramp.p2.x +
                  t0 * t0 * t0 * ramp.p3.x,
                y:
                  mt0 * mt0 * mt0 * ramp.p0.y +
                  3 * mt0 * mt0 * t0 * ramp.p1.y +
                  3 * mt0 * t0 * t0 * ramp.p2.y +
                  t0 * t0 * t0 * ramp.p3.y,
              };
              const segB = {
                x:
                  mt1 * mt1 * mt1 * ramp.p0.x +
                  3 * mt1 * mt1 * t1 * ramp.p1.x +
                  3 * mt1 * t1 * t1 * ramp.p2.x +
                  t1 * t1 * t1 * ramp.p3.x,
                y:
                  mt1 * mt1 * mt1 * ramp.p0.y +
                  3 * mt1 * mt1 * t1 * ramp.p1.y +
                  3 * mt1 * t1 * t1 * ramp.p2.y +
                  t1 * t1 * t1 * ramp.p3.y,
              };
              const sDx = segB.x - segA.x;
              const sDy = segB.y - segA.y;
              const lenSq = sDx * sDx + sDy * sDy;
              for (const h of world.houses) {
                const u =
                  lenSq > 1e-6
                    ? Math.max(
                        0,
                        Math.min(
                          1,
                          ((h.x - segA.x) * sDx + (h.y - segA.y) * sDy) / lenSq,
                        ),
                      )
                    : 0;
                const qx = segA.x + u * sDx;
                const qy = segA.y + u * sDy;
                const d = Math.hypot(h.x - qx, h.y - qy);
                expect(d).toBeGreaterThanOrEqual(1.5);
              }
            }
          }
        }
      }

      // 6. Precomputed RCI counts, Farm estateBBox, Motorway surfaceSpans/shieldPt & VectorLayerRecorder display lists
      expect(world.rciCounts).toBeDefined();
      expect(
        (world.rciCounts?.com || 0) +
          (world.rciCounts?.raw || 0) +
          (world.rciCounts?.mfg || 0) +
          (world.rciCounts?.log || 0),
      ).toBe(world.destinations.length);

      for (const d of world.destinations) {
        if (
          d.resourceType === "FARM" &&
          d.bspParcels &&
          d.bspParcels.length > 0
        ) {
          expect(d.estateBBox).toBeDefined();
          expect(d.estateBBox?.maxX).toBeGreaterThan(d.estateBBox?.minX ?? 0);
          expect(d.estateBBox?.maxY).toBeGreaterThan(d.estateBBox?.minY ?? 0);
        }
      }

      for (const mw of world.motorways) {
        expect(Array.isArray(mw.surfaceSpans)).toBe(true);
        expect(mw.shieldPt).toBeDefined();
      }

      renderer.prepareDisplayLists(world);
      expect(
        renderer.hydroDisplayList?.contours.getStats().commandCount,
      ).toBeGreaterThan(0);
      expect(
        renderer.hydroDisplayList?.water.getStats().commandCount,
      ).toBeGreaterThan(0);
      expect(
        renderer.urbanTerrainDisplayList?.treesAndFarms.getStats().commandCount,
      ).toBeGreaterThan(0);
      expect(
        renderer.surfaceNetworkDisplayList?.recorder.getStats().commandCount,
      ).toBeGreaterThan(0);
      expect(renderer.overpassBridgeDisplayList).not.toBeNull();
      const hasCloverleafOrTrumpet = world.interchanges.some(
        (ic) => ic.type === "cloverleaf" || ic.type === "trumpet",
      );
      if (hasCloverleafOrTrumpet) {
        expect(
          renderer.overpassBridgeDisplayList?.recorder.getStats().commandCount,
        ).toBeGreaterThan(0);
      }

      const roadDiag = renderer.computeRoadGraphDiagnostics(world);
      expect(roadDiag.activeTracks).toBeGreaterThan(0);
      if (
        world.cargoLinks.some((l) =>
          l.outboundTrack?.pts?.some((p) => p.isSlipRamp),
        )
      ) {
        expect(roadDiag.rampTraversals).toBeGreaterThan(0);
      }
      expect(roadDiag.anomalies.length).toBe(0);

      // 7. Zero Non-Road Surface Steps & Zero Trajectory Reversal Invariants:
      // Every surface-to-surface step (!a.onMotorway && !b.onMotorway) must lie on the same tile or a committed road edge,
      // and no directed vehicle track (cargoLinks or commuterRoutes) may contain a sharp reversal / snap-back (cosTurn < -0.5).
      for (const link of world.cargoLinks) {
        const pts = link.points;
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          if (!a.onMotorway && !b.onMotorway) {
            const gxA = Math.round(a.x);
            const gyA = Math.round(a.y);
            const gxB = Math.round(b.x);
            const gyB = Math.round(b.y);
            const valid =
              (gxA === gxB && gyA === gyB) ||
              world.hasRoadEdge(gxA, gyA, gxB, gyB);
            expect(valid).toBe(true);
          }
        }
      }

      const allTracks = [
        ...world.cargoLinks.flatMap((l) => [l.outboundTrack, l.inboundTrack]),
        ...world.commuterRoutes.flatMap((r) => [
          r.outboundTrack,
          r.inboundTrack,
        ]),
      ];
      for (const track of allTracks) {
        const pts = track.pts;
        for (let i = 1; i < pts.length - 1; i++) {
          const p0 = pts[i - 1];
          const p1 = pts[i];
          const p2 = pts[i + 1];
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

      // 8. Vehicle Routing Graph & Interchange Upper-Bridge Tagging:
      // Whenever a Cloverleaf or Trumpet interchange is present, upper-deck bridge nodes are tagged with onUpperBridge
      const routingGraph = world.ensureVehicleRoutingGraph();
      if (hasCloverleafOrTrumpet) {
        expect(routingGraph.nodes.some((n) => Boolean(n.onUpperBridge))).toBe(
          true,
        );
      }
    }
  }, 15000);

  test("All 9 landform archetypes and custom geomorphology scalar overrides satisfy geographic & elevation invariants", () => {
    const pipeline = createWorldPipeline();
    const allArchetypes = [
      "confluence",
      "inland",
      "alpine-passes",
      "fjord-sound",
      "isthmus-strait",
      "caldera-basin",
      "barrier-lagoon",
      "canyon-gorge",
      "island-hopper",
    ];

    const continentalArchetypes = allArchetypes.filter(
      (a) => a !== "island-hopper",
    );

    for (const archetype of allArchetypes) {
      const world = pipeline({
        seed: "OTTD-METRO-84",
        worldSize: "compact",
        archetype,
        terrainAlgo: "tectonic-fbm",
        hydrologyAlgo: "thalweg-astar",
        airportMix: "hub-regional",
        includeIntermediateRamps: true,
        townCount: 14,
        buildingDensity: 200,
        airportCount: 2,
        windAxis: -1,
      });

      // Assert every continental archetype generates world.rivers.length >= 1, world.towns.length >= 8, and world.airports.length >= 1
      if (continentalArchetypes.includes(archetype)) {
        expect(world.rivers.length).toBeGreaterThanOrEqual(1);
        expect(world.towns.length).toBeGreaterThanOrEqual(8);
        expect(world.airports.length).toBeGreaterThanOrEqual(1);
      } else {
        expect(world.towns.length).toBeGreaterThanOrEqual(1);
      }

      // Assert "inland" produces zero border-touching sea basins
      if (archetype === "inland") {
        expect(world.hydroFeatures.some((f) => f.type === "bay")).toBe(false);
        for (let x = 0; x < world.W; x++) {
          expect(world.waterMask[world.idx(x, 0)]).not.toBe(2);
          expect(world.waterMask[world.idx(x, world.H - 1)]).not.toBe(2);
        }
        for (let y = 0; y < world.H; y++) {
          expect(world.waterMask[world.idx(0, y)]).not.toBe(2);
          expect(world.waterMask[world.idx(world.W - 1, y)]).not.toBe(2);
        }
      }
    }

    // Assert explicit coastalEmbayment: 0 produces zero border-touching sea basins
    const worldZeroEmbayment = pipeline({
      seed: "OTTD-METRO-84",
      worldSize: "compact",
      archetype: "confluence",
      coastalEmbayment: 0,
      townCount: 14,
      airportCount: 2,
    });
    expect(worldZeroEmbayment.hydroFeatures.some((f) => f.type === "bay")).toBe(
      false,
    );
    for (let x = 0; x < worldZeroEmbayment.W; x++) {
      expect(
        worldZeroEmbayment.waterMask[worldZeroEmbayment.idx(x, 0)],
      ).not.toBe(2);
      expect(
        worldZeroEmbayment.waterMask[
          worldZeroEmbayment.idx(x, worldZeroEmbayment.H - 1)
        ],
      ).not.toBe(2);
    }
    for (let y = 0; y < worldZeroEmbayment.H; y++) {
      expect(
        worldZeroEmbayment.waterMask[worldZeroEmbayment.idx(0, y)],
      ).not.toBe(2);
      expect(
        worldZeroEmbayment.waterMask[
          worldZeroEmbayment.idx(worldZeroEmbayment.W - 1, y)
        ],
      ).not.toBe(2);
    }

    // Assert custom geomorphology scalar overrides (terrainRelief, valleyIncision, coastalEmbayment, calderaCurvature, barrierFragmentation, basinCount)
    const customWorld = pipeline({
      seed: "OTTD-METRO-84",
      worldSize: "compact",
      archetype: "confluence",
      terrainRelief: 150,
      valleyIncision: 120,
      coastalEmbayment: 80,
      calderaCurvature: 60,
      barrierFragmentation: 50,
      basinCount: 4,
      townCount: 14,
      airportCount: 2,
    });
    expect(customWorld.rivers.length).toBeGreaterThanOrEqual(1);
    expect(customWorld.towns.length).toBeGreaterThanOrEqual(8);
    expect(customWorld.airports.length).toBeGreaterThanOrEqual(1);

    // Assert changing a geomorphology scalar (terrainRelief: 180 vs terrainRelief: 40) invalidates Stage 2A and alters elevationField
    const worldHighRelief = pipeline({
      seed: "OTTD-METRO-84",
      worldSize: "compact",
      archetype: "confluence",
      terrainRelief: 180,
      valleyIncision: 40,
      coastalEmbayment: 100,
      calderaCurvature: 0,
      barrierFragmentation: 0,
      basinCount: 2,
      townCount: 14,
      airportCount: 2,
    });
    const highReliefElev = new Float32Array(worldHighRelief.elevationField);

    const worldLowRelief = pipeline({
      seed: "OTTD-METRO-84",
      worldSize: "compact",
      archetype: "confluence",
      terrainRelief: 40,
      valleyIncision: 40,
      coastalEmbayment: 100,
      calderaCurvature: 0,
      barrierFragmentation: 0,
      basinCount: 2,
      townCount: 14,
      airportCount: 2,
    });

    let alteredElevationCount = 0;
    for (let i = 0; i < worldLowRelief.elevationField.length; i++) {
      if (
        Math.abs(worldLowRelief.elevationField[i] - highReliefElev[i]) > 0.005
      ) {
        alteredElevationCount++;
      }
    }
    expect(alteredElevationCount).toBeGreaterThan(
      worldLowRelief.elevationField.length * 0.5,
    );
  }, 15000);

  test("Plan 2 Specialized Pull-Based Industrial Supply Chain & TradeGateway invariants on OTTD-METRO-84", () => {
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

    const validRawTypes = new Set([
      "MINE",
      "TIMBER",
      "FARM",
      "FISHERY",
      "CHEM",
    ]);
    const validRawOutputs = {
      MINE: "ORE",
      TIMBER: "WOOD",
      FARM: "AGRI",
      FISHERY: "AGRI",
      CHEM: "CHEM",
    };
    const validMfgTypes = new Set(["STEEL", "FOOD", "GOODS", "TECH"]);
    const expectedMfgSpecs = {
      STEEL: { requiredInputs: ["ORE", "WOOD"], outputGood: "HARDWARE" },
      FOOD: { requiredInputs: ["AGRI", "CHEM"], outputGood: "GROCERIES" },
      GOODS: {
        requiredInputs: ["WOOD", "HARDWARE"],
        outputGood: "CONSUMER_GOODS",
      },
      TECH: {
        requiredInputs: ["CHEM", "HARDWARE"],
        outputGood: "ELECTRONICS",
      },
    };

    // 1. Every RAW destination has a valid resourceType ("MINE" | "TIMBER" | "FARM" | "FISHERY" | "CHEM") and outputGood
    const rawDestinations = world.destinations.filter(
      (d) => d.subType === "RAW",
    );
    expect(rawDestinations.length).toBeGreaterThan(0);
    for (const raw of rawDestinations) {
      const rType = raw.resourceType ?? "";
      expect(validRawTypes.has(rType)).toBe(true);
      expect(raw.outputGood).toBe(
        validRawOutputs[/** @type {keyof typeof validRawOutputs} */ (rType)],
      );
    }

    // 2. Every MFG destination has a valid mfgType ("STEEL" | "FOOD" | "GOODS" | "TECH"), requiredInputs, and outputGood, and receives >= 1 inbound cargo link
    const mfgDestinations = world.destinations.filter(
      (d) => d.subType === "MFG",
    );
    expect(mfgDestinations.length).toBeGreaterThan(0);
    for (const mfg of mfgDestinations) {
      const mType = mfg.mfgType ?? "";
      expect(validMfgTypes.has(mType)).toBe(true);
      const spec =
        expectedMfgSpecs[/** @type {keyof typeof expectedMfgSpecs} */ (mType)];
      expect(mfg.requiredInputs).toEqual(spec.requiredInputs);
      expect(mfg.outputGood).toBe(spec.outputGood);

      const inbound = world.cargoLinks.filter((l) => l.to.id === mfg.id);
      expect(inbound.length).toBeGreaterThanOrEqual(1);
    }

    // 3. Every LOG destination has relativeDemand > 0 and receives >= 1 inbound and >= 1 outbound cargo link
    const logDestinations = world.destinations.filter(
      (d) => d.subType === "LOG",
    );
    expect(logDestinations.length).toBeGreaterThan(0);
    for (const log of logDestinations) {
      expect(typeof log.relativeDemand).toBe("number");
      expect(log.relativeDemand).toBeGreaterThan(0);

      const inbound = world.cargoLinks.filter((l) => l.to.id === log.id);
      expect(inbound.length).toBeGreaterThanOrEqual(1);

      const outbound = world.cargoLinks.filter((l) => l.from.id === log.id);
      expect(outbound.length).toBeGreaterThanOrEqual(1);
    }

    // 4. Every COM destination has demandedGoods.length >= 1 (with distinct goods within each town before repeats) and receives >= 1 inbound cargo link
    const comDestinations = world.destinations.filter(
      (d) => d.zoneType === "commercial",
    );
    expect(comDestinations.length).toBeGreaterThan(0);

    const comsByTown = new Map();
    for (const com of comDestinations) {
      const goods = com.demandedGoods ?? [];
      expect(Array.isArray(com.demandedGoods)).toBe(true);
      expect(goods.length).toBeGreaterThanOrEqual(1);

      const uniqueGoodsOnBuilding = new Set(goods);
      expect(uniqueGoodsOnBuilding.size).toBe(goods.length);

      const inbound = world.cargoLinks.filter((l) => l.to.id === com.id);
      expect(inbound.length).toBeGreaterThanOrEqual(1);

      if (!comsByTown.has(com.townId)) {
        comsByTown.set(com.townId, []);
      }
      comsByTown.get(com.townId).push(com);
    }

    for (const [, townComs] of comsByTown) {
      const firstGoods = townComs
        .slice(0, 4)
        .map((c) => (c.demandedGoods ?? [])[0]);
      const uniqueFirstGoods = new Set(firstGoods);
      expect(uniqueFirstGoods.size).toBe(firstGoods.length);
    }

    // 5. world.cargoLinks includes "MFG->MFG", "CBD->CBD", and TradeGateway "IMPORT->..." or "...->EXPORT" links, and world.tradeGateways.length === world.airports.length
    const stages = new Set(world.cargoLinks.map((l) => l.stage));
    expect(stages.has("MFG->MFG")).toBe(true);
    expect(stages.has("CBD->CBD")).toBe(true);
    const hasImportLink = world.cargoLinks.some((l) =>
      l.stage.startsWith("IMPORT->"),
    );
    const hasExportLink = world.cargoLinks.some((l) =>
      l.stage.endsWith("->EXPORT"),
    );
    expect(hasImportLink || hasExportLink).toBe(true);

    expect(world.tradeGateways.length).toBe(world.airports.length);
    expect(world.tradeGateways.length).toBeGreaterThan(0);

    // 6. Every airport has typeof ap.acceptsWidebody === "boolean" (true for HUB/CRG, false for REG) and ap.externalCorridors.length >= 1
    for (const ap of world.airports) {
      expect(typeof ap.acceptsWidebody).toBe("boolean");
      if (ap.isHub || ap.airportClass === "HUB" || ap.airportClass === "CRG") {
        expect(ap.acceptsWidebody).toBe(true);
      } else if (ap.airportClass === "REG") {
        expect(ap.acceptsWidebody).toBe(false);
      }
      const corridors = ap.externalCorridors ?? [];
      expect(Array.isArray(ap.externalCorridors)).toBe(true);
      expect(corridors.length).toBeGreaterThanOrEqual(1);
    }
  }, 15000);

  test("Shoreline FISHERY siting, stage color semantics, LOG consolidation & inspector stage/commodity telemetry", () => {
    const pipeline = createWorldPipeline();
    const expectedStageColors = {
      "LOG->COM": "#7c3aed",
      "MFG->COM": "#4f46e5",
      "RAW->MFG": "#d97706",
      "RAW->LOG": "#d97706",
      "MFG->MFG": "#e11d48",
      "MFG->LOG": "#ea580c",
      "CBD->CBD": "#0284c7",
      "IMPORT->COM": "#0d9488",
      "IMPORT->LOG": "#0d9488",
      "IMPORT->MFG": "#0d9488",
      "RAW->EXPORT": "#0d9488",
      "MFG->EXPORT": "#0d9488",
      "LOG->EXPORT": "#0d9488",
    };

    for (const seed of ["OTTD-METRO-84", "HARBOR-305"]) {
      const world = pipeline({
        seed,
        worldSize: "standard",
        archetype: "confluence",
        terrainAlgo: "tectonic-fbm",
        hydrologyAlgo: "thalweg-astar",
        airportMix: "hub-regional",
        includeIntermediateRamps: true,
        waterCoverage: 48,
        townCount: 18,
        buildingDensity: 200,
        airportCount: 3,
        windAxis: -1,
      });

      // 1. Shoreline FISHERY placement: at least 1 rural FISHERY sits on a dry 2x2 pad with shoreline dW in [1.0, 2.8]
      const fisheries = world.destinations.filter(
        (d) => d.subType === "RAW" && d.resourceType === "FISHERY",
      );
      expect(fisheries.length).toBeGreaterThanOrEqual(1);
      const ruralFisheries = fisheries.filter((d) => d.isRuralNiche);
      expect(ruralFisheries.length).toBeGreaterThanOrEqual(1);
      for (const f of ruralFisheries) {
        const originDw = world.distToWater[world.idx(f.gx, f.gy)];
        expect(originDw).toBeGreaterThanOrEqual(1.0);
        expect(originDw).toBeLessThanOrEqual(2.8);
        for (let dy = 0; dy <= 1; dy++) {
          for (let dx = 0; dx <= 1; dx++) {
            const pid = world.idx(f.gx + dx, f.gy + dy);
            expect(world.waterMask[pid]).toBe(0);
          }
        }
      }

      // 2. Stage color semantics & explicit commodity tags on every cargo link
      for (const link of world.cargoLinks) {
        const expectedCol =
          expectedStageColors[
            /** @type {keyof typeof expectedStageColors} */ (link.stage)
          ];
        expect(expectedCol).toBeDefined();
        expect(link.color).toBe(expectedCol);
        expect(typeof link.commodity).toBe("string");
        expect((link.commodity ?? "").length).toBeGreaterThan(0);
      }

      // 3. LOG hub consolidation share & STEEL mill footprint guard (never 2x1/1x2)
      const steelMills = world.destinations.filter(
        (d) => d.subType === "MFG" && d.mfgType === "STEEL",
      );
      expect(steelMills.length).toBeGreaterThanOrEqual(1);
      for (const sm of steelMills) {
        expect(sm.wTiles).toBeGreaterThanOrEqual(2);
        expect(sm.hTiles).toBeGreaterThanOrEqual(2);
      }

      const comRetailLinks = world.cargoLinks.filter(
        (l) =>
          l.stage === "LOG->COM" ||
          l.stage === "MFG->COM" ||
          l.stage === "IMPORT->COM",
      );
      const logToComLinks = comRetailLinks.filter(
        (l) => l.stage === "LOG->COM",
      );
      expect(comRetailLinks.length).toBeGreaterThan(0);
      const logShare = logToComLinks.length / comRetailLinks.length;
      expect(logShare).toBeGreaterThanOrEqual(0.45);
    }

    // 4. Inspector stage-colored dossier & partner link badge classes
    const mockWorld = /** @type {any} */ ({
      towns: [{ id: 0, name: "Harborview", x: 50, y: 50 }],
    });
    const fisheryInfo = describeBuildingDossier(
      /** @type {any} */ ({
        id: 1,
        townId: 0,
        x: 52,
        y: 50,
        zoneType: "industrial",
        subType: "RAW",
        resourceType: "FISHERY",
      }),
      mockWorld,
    );
    expect(fisheryInfo.badgeClass).toBe("bg-cyan-800 text-white");
    expect(getPartnerStageBadgeClass(fisheryInfo)).toBe(
      "bg-cyan-100 text-cyan-900",
    );

    const chemInfo = describeBuildingDossier(
      /** @type {any} */ ({
        id: 2,
        townId: 0,
        x: 52,
        y: 50,
        zoneType: "industrial",
        subType: "RAW",
        resourceType: "CHEM",
      }),
      mockWorld,
    );
    expect(chemInfo.badgeClass).toBe("bg-lime-800 text-white");
    expect(getPartnerStageBadgeClass(chemInfo)).toBe(
      "bg-lime-100 text-lime-900",
    );

    expect(getPartnerStageBadgeClass("RAW", "MINE")).toBe(
      "bg-amber-100 text-amber-900",
    );
    expect(getPartnerStageBadgeClass("MFG")).toBe(
      "bg-orange-100 text-orange-900",
    );
    expect(getPartnerStageBadgeClass("LOG")).toBe(
      "bg-purple-100 text-purple-900",
    );
    expect(getPartnerStageBadgeClass("COM")).toBe("bg-blue-100 text-blue-900");
    expect(getPartnerStageBadgeClass("AIR")).toBe("bg-teal-100 text-teal-900");

    // 5. Commercial lot naming based on demandedGoods
    const groceryCom = describeBuildingDossier(
      /** @type {any} */ ({
        id: 30,
        townId: 0,
        x: 54,
        y: 50,
        zoneType: "commercial",
        isCircular: false,
        demandedGoods: ["GROCERIES"],
      }),
      mockWorld,
    );
    expect(groceryCom.badge).toBe("COM · GROCERY");
    expect(groceryCom.title).toContain("Harborview Grocery Market");

    const techTradeMart = describeBuildingDossier(
      /** @type {any} */ ({
        id: 31,
        townId: 0,
        x: 54,
        y: 50,
        zoneType: "commercial",
        isCircular: false,
        demandedGoods: ["HARDWARE", "ELECTRONICS"],
      }),
      mockWorld,
    );
    expect(techTradeMart.badge).toBe("COM · TRADE MART");
    expect(techTradeMart.title).toContain("Harborview Tech & Hardware Mart");

    const cbdFoodRetail = describeBuildingDossier(
      /** @type {any} */ ({
        id: 32,
        townId: 0,
        x: 50,
        y: 50,
        zoneType: "commercial",
        isCircular: true,
        demandedGoods: ["GROCERIES", "CONSUMER_GOODS"],
      }),
      mockWorld,
    );
    expect(cbdFoodRetail.badge).toBe("CBD · FOOD & GOODS");
    expect(cbdFoodRetail.title).toContain(
      "Harborview CBD Food & Retail Rotunda",
    );
  }, 20000);

  test("Holistic ALL_ENTITY_DEFINITIONS Registry & Inspection Round-Trip across 5 domains with zero window globals", () => {
    // 1. Verify all 7 definitions registered in ascending hitPriority order (10, 12, 20, 30, 35, 40, 50)
    expect(ALL_ENTITY_DEFINITIONS.length).toBe(7);
    const priorities = ALL_ENTITY_DEFINITIONS.map((d) => d.hitPriority);
    expect(priorities).toEqual([10, 12, 20, 30, 35, 40, 50]);
    for (let i = 0; i < ALL_ENTITY_DEFINITIONS.length - 1; i++) {
      expect(ALL_ENTITY_DEFINITIONS[i].hitPriority).toBeLessThan(
        ALL_ENTITY_DEFINITIONS[i + 1].hitPriority,
      );
    }

    // 2. Synthesize benchmark world
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

    expect(world.airports.length).toBeGreaterThan(0);
    for (const ap of world.airports) {
      expect(ap.atc).toBeUndefined();
    }

    // 3. Verify prepareDisplayLists / recordAirwayCorridors does NOT mutate world.airports[i].atc
    const mockCanvas = /** @type {any} */ ({
      width: 1600,
      height: 1000,
      getContext: () => null,
    });
    const renderer = new MiniMotorwaysRenderer(mockCanvas);
    renderer.prepareDisplayLists(world);

    for (const ap of world.airports) {
      expect(ap.atc).toBeUndefined();
    }

    // 4. Instantiate LogisticsSimulator and test inspection round-trips
    const sim = new LogisticsSimulator(world);

    // Verify resolve -> hitTest -> getCameraTarget -> renderDossier -> describeLivePatch
    // across airport, building, town, plane, truck
    const kinds = /** @type {const} */ ([
      "airport",
      "building",
      "town",
      "plane",
      "truck",
    ]);

    for (const kind of kinds) {
      const def = getEntityDefinition(kind);
      expect(def).not.toBeNull();
      if (!def || !def.inspect) continue;

      let ref;
      let targetWx = 0;
      let targetWy = 0;

      if (kind === "airport") {
        const ap = world.airports[0];
        ref = { kind, id: ap.id };
        targetWx = ap.x;
        targetWy = ap.y;
      } else if (kind === "building") {
        const b = world.destinations[0];
        ref = { kind, id: b.id };
        targetWx = b.gx + (b.wTiles || 2) * 0.5;
        targetWy = b.gy + (b.hTiles || 2) * 0.5;
      } else if (kind === "town") {
        const t = world.towns[0];
        ref = { kind, id: t.id };
        targetWx = t.x;
        targetWy = t.y;
      } else if (kind === "plane") {
        const p = sim.planes[0];
        ref = { kind, id: p.id };
        targetWx = (p.pose?.x ?? p.x) + 0.5;
        targetWy = (p.pose?.y ?? p.y) + 0.5;
      } else if (kind === "truck") {
        const c = sim.cars.find((car) => !car.pose?.inTunnel) || sim.cars[0];
        ref = { kind, id: c.id };
        targetWx = (c.pose?.x ?? 0) + 0.5;
        targetWy = (c.pose?.y ?? 0) + 0.5;
      }

      // Step A: resolveEntityByRef
      const resolved = resolveEntityByRef(ref, world, sim);
      expect(resolved).not.toBeNull();
      expect(resolved.id).toBe(ref.id);

      // Step B: hitTest
      const hit = hitTestEntities(targetWx, targetWy, 2.0, world, sim);
      expect(hit).not.toBeNull();
      expect(hit?.entity).toBeDefined();

      const directHit = def.inspect.hitTest
        ? def.inspect.hitTest(targetWx, targetWy, 2.0, world, sim)
        : null;
      expect(directHit).not.toBeNull();
      expect(directHit?.entity).toBe(resolved);

      // Step C: getEntityCameraTarget
      const camTarget = getEntityCameraTarget(kind, resolved, world);
      expect(camTarget).toBeDefined();
      expect(Number.isFinite(camTarget.cx)).toBe(true);
      expect(Number.isFinite(camTarget.cy)).toBe(true);
      expect(Number.isFinite(camTarget.zoom)).toBe(true);
      expect(camTarget.zoom).toBeGreaterThan(0);

      // Step D: renderDossier
      expect(typeof def.inspect.renderDossier).toBe("function");
      if (typeof def.inspect.renderDossier === "function") {
        const dossier = def.inspect.renderDossier(resolved, world, sim);
        expect(dossier).toBeDefined();
        expect(typeof dossier.titleText).toBe("string");
        expect(dossier.titleText.length).toBeGreaterThan(0);
        expect(typeof dossier.badgeText).toBe("string");
        expect(dossier.badgeText.length).toBeGreaterThan(0);
        expect(typeof dossier.badgeClass).toBe("string");
      }

      // Step E: describeLivePatch
      expect(typeof def.inspect.describeLivePatch).toBe("function");
      if (typeof def.inspect.describeLivePatch === "function") {
        const patch = def.inspect.describeLivePatch(resolved, world, sim);
        expect(patch).not.toBeNull();
        expect(typeof patch).toBe("object");
      }
    }

    // Verify that a CarAgent with pose.inTunnel = true is NEVER returned by hitTestRoadVehicle or hitTestEntities
    const realCar = sim.cars[0];
    expect(realCar?.pose).toBeDefined();
    if (realCar && realCar.pose) {
      const origTunnel = realCar.pose.inTunnel;
      realCar.pose.inTunnel = true;
      const testSim = { cars: [realCar], planes: [] };
      const truckHit = hitTestRoadVehicle(
        realCar.pose.x + 0.5,
        realCar.pose.y + 0.5,
        2.0,
        world,
        testSim,
      );
      expect(truckHit).toBeNull();
      const entityHit = hitTestEntities(
        realCar.pose.x + 0.5,
        realCar.pose.y + 0.5,
        2.0,
        world,
        testSim,
      );
      expect(entityHit?.entity).not.toBe(realCar);
      realCar.pose.inTunnel = origTunnel;
    }

    // Verify displaceBuildingsInRadius sets demolished destination perimeter tiles to BUILDING_MASK.TRANSIT_RESERVE (4), not 0
    const testWorld = {
      W: 20,
      H: 20,
      idx: (x, y) => y * 20 + x,
      inBounds: (x, y, margin = 0) =>
        x >= margin && x < 20 - margin && y >= margin && y < 20 - margin,
      houses: [],
      destinations: [
        { id: 1, x: 10, y: 10, gx: 9, gy: 9, wTiles: 2, hTiles: 2, townId: 0 },
      ],
      towns: [{ id: 0, destinationsCount: 1, housesCount: 0 }],
      buildingMask: new Uint8Array(400),
      trees: [],
    };
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        testWorld.buildingMask[testWorld.idx(9 + dx, 9 + dy)] =
          BUILDING_MASK.DESTINATION;
      }
    }
    displaceBuildingsInRadius(testWorld, 10, 10, 1.5);
    expect(testWorld.destinations.length).toBe(0);
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        expect(testWorld.buildingMask[testWorld.idx(9 + dx, 9 + dy)]).toBe(
          BUILDING_MASK.TRANSIT_RESERVE,
        );
      }
    }
  });
});
