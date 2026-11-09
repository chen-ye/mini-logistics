import { describe, test, expect } from "bun:test";
import { SeededRNG, FastNoise2D } from "../../src/math.js";
import {
  createMemoStage,
  createWorldPipeline,
  extractWorldTransferables,
  hydrateTransferredWorld,
  ProceduralLogisticsWorld,
} from "../../src/world-generator.js";

describe("SeededRNG & FastNoise2D determinism and analytic derivatives", () => {
  test("SeededRNG produces identical sequences for identical seeds and diverges across seeds", () => {
    const rngA1 = new SeededRNG("OTTD-METRO-84");
    const rngA2 = new SeededRNG("OTTD-METRO-84");
    const rngB = new SeededRNG("DELTA-402");

    for (let i = 0; i < 64; i++) {
      expect(rngA1.next()).toBe(rngA2.next());
      expect(rngA1.range(-50, 120)).toBe(rngA2.range(-50, 120));
      expect(rngA1.int(0, 1000)).toBe(rngA2.int(0, 1000));
    }

    const items = ["alpha", "bravo", "charlie", "delta", "echo"];
    for (let i = 0; i < 20; i++) {
      expect(rngA1.pick(items)).toBe(rngA2.pick(items));
    }

    expect(new SeededRNG("OTTD-METRO-84").next()).not.toBe(rngB.next());
  });

  test("FastNoise2D.noise, fbm, and fbmEroded remain strictly bounded in [0, 1]", () => {
    const noise = new FastNoise2D(new SeededRNG("NOISE-BOUNDS-99"));
    const coords = [
      [0, 0],
      [0.37, 0.81],
      [-14.25, 29.6],
      [1024.5, -2048.75],
      [-0.0001, -999.99],
    ];

    for (const [x, y] of coords) {
      const n = noise.noise(x, y);
      const f = noise.fbm(x, y, 5, 0.5, 2.0);
      const e = noise.fbmEroded(x, y, 5, 1.45);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(1);
    }
  });

  test("FastNoise2D.noiseDeriv quintic fade derivatives vanish at grid corners and track slope sign", () => {
    const noise = new FastNoise2D(new SeededRNG("QUILEZ-DERIV-42"));
    // At integer lattice points (fx = 0, fy = 0), quintic C2 fade derivative 30*t^2*(t-1)^2 is strictly 0
    const atCorner = noise.noiseDeriv(4.0, -7.0);
    expect(Math.abs(atCorner.dx)).toBe(0);
    expect(Math.abs(atCorner.dy)).toBe(0);

    // Verify fade(t) derivative formula 30*t^2*(t-1)^2 against central finite difference of fade(t)
    const eps = 1e-5;
    for (const t of [0.15, 0.35, 0.5, 0.72, 0.88]) {
      const analytic = 30.0 * t * t * (t - 1.0) * (t - 1.0);
      const numeric = (noise.fade(t + eps) - noise.fade(t - eps)) / (2 * eps);
      expect(analytic).toBeCloseTo(numeric, 5);
    }
  });
});

describe("9-Stage Reactive DAG Memoization & Worker Transfer Contract", () => {
  test("createMemoStage caches by Object.is dependency tuple and increments version only on miss", () => {
    let computeCalls = 0;
    const stage = createMemoStage(
      /** @param {{ a: number, b: number, ignored: number }} cfg @returns {[number, number]} */
      (cfg) => [cfg.a, cfg.b],
      (a, b, version) => {
        computeCalls++;
        return { sum: a + b, version };
      },
    );

    const r1 = stage({ a: 2, b: 3, ignored: 1 });
    expect(r1.cached).toBe(false);
    expect(r1.version).toBe(1);
    expect(r1.value.sum).toBe(5);
    expect(Object.isFrozen(r1.value)).toBe(true);

    const r2 = stage({ a: 2, b: 3, ignored: 999 });
    expect(r2.cached).toBe(true);
    expect(r2.version).toBe(1);
    expect(r2.value).toBe(r1.value);
    expect(computeCalls).toBe(1);

    const r3 = stage({ a: 2, b: 4, ignored: 999 });
    expect(r3.cached).toBe(false);
    expect(r3.version).toBe(2);
    expect(r3.value.sum).toBe(6);
    expect(computeCalls).toBe(2);
  });

  test("createWorldPipeline selectively invalidates downstream stages and isolates scratch workspace", () => {
    let hydroCallbacks = 0;
    let urbanCallbacks = 0;
    const pipeline = createWorldPipeline({
      onHydrologyReady(_s2b, recomputed) {
        if (recomputed) hydroCallbacks++;
      },
      onUrbanReady(_s2b, _s67, changed) {
        if (changed) urbanCallbacks++;
      },
    });

    const baseCfg = {
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
    };

    const w1 = pipeline(baseCfg);
    expect(w1.reusedThroughStage).toBe(0);
    expect(w1.terrainUnchanged).toBe(false);
    expect(hydroCallbacks).toBe(1);
    expect(urbanCallbacks).toBe(1);

    // Identical config -> full cache hit through Stage 9
    const w2 = pipeline({ ...baseCfg });
    expect(w2.reusedThroughStage).toBe(9);
    expect(w2.terrainUnchanged).toBe(true);
    expect(w2.hydroVersion).toBe(w1.hydroVersion);
    expect(w2.urbanVersion).toBe(w1.urbanVersion);
    expect(hydroCallbacks).toBe(1);
    expect(urbanCallbacks).toBe(1);

    // Toggling Stage 9 `includeIntermediateRamps` -> reuses Stages 1..8
    const w3 = pipeline({ ...baseCfg, includeIntermediateRamps: false });
    expect(w3.reusedThroughStage).toBe(8);
    expect(w3.terrainUnchanged).toBe(true);
    expect(w3.hydroVersion).toBe(w1.hydroVersion);
    expect(w3.urbanVersion).toBe(w1.urbanVersion);

    // Changing Stage 6/7 `buildingDensity` -> reuses Stages 1..5
    const w4 = pipeline({ ...baseCfg, buildingDensity: 150 });
    expect(w4.reusedThroughStage).toBe(5);
    expect(w4.terrainUnchanged).toBe(false);
    expect(w4.hydroVersion).toBe(w1.hydroVersion);
    expect(w4.urbanVersion).toBe(w1.urbanVersion + 1);
    expect(urbanCallbacks).toBe(2);

    // Changing Stage 2B `hydrologyAlgo` -> reuses Stage 1A/2A (stage 1)
    const w5 = pipeline({ ...baseCfg, hydrologyAlgo: "d8-strahler" });
    expect(w5.reusedThroughStage).toBe(1);
    expect(w5.hydroVersion).toBe(w1.hydroVersion + 1);
    expect(hydroCallbacks).toBe(2);

    // Scratch workspace isolation: running seedA -> seedB -> seedA yields bit-identical output
    const freshA = createWorldPipeline()(baseCfg);
    const interleavedPipe = createWorldPipeline();
    const runA1 = interleavedPipe(baseCfg);
    interleavedPipe({
      ...baseCfg,
      seed: "HARBOR-305",
      archetype: "estuary",
      terrainAlgo: "voronoi-plates",
    });
    const runA2 = interleavedPipe(baseCfg);

    expect(Array.from(runA2.elevationField)).toEqual(
      Array.from(freshA.elevationField),
    );
    expect(Array.from(runA2.waterMask)).toEqual(Array.from(freshA.waterMask));
    expect(Array.from(runA2.roadGrid)).toEqual(Array.from(freshA.roadGrid));
    expect(Array.from(runA2.buildingMask)).toEqual(
      Array.from(freshA.buildingMask),
    );
    expect(runA2.towns.length).toBe(runA1.towns.length);
    expect(runA2.airports.length).toBe(runA1.airports.length);
    expect(runA2.motorways.length).toBe(runA1.motorways.length);
  });

  test("extractWorldTransferables clones 12 TypedArray buffers and hydrateTransferredWorld restores prototype", () => {
    const pipeline = createWorldPipeline();
    const world = pipeline({
      seed: "DELTA-402",
      worldSize: "compact",
      archetype: "confluence",
      terrainAlgo: "tectonic-fbm",
      hydrologyAlgo: "thalweg-astar",
      airportMix: "hub-regional",
      includeIntermediateRamps: true,
      waterCoverage: 48,
      townCount: 12,
      buildingDensity: 200,
      airportCount: 2,
      windAxis: -1,
    });

    const buffers = extractWorldTransferables(world);
    expect(buffers.length).toBe(12);
    for (const buf of buffers) {
      expect(buf).toBeInstanceOf(ArrayBuffer);
      expect(buf.byteLength).toBeGreaterThan(0);
    }
    expect(world.rng).toBeUndefined();
    expect(world.noise).toBeUndefined();
    expect(world.roadEdges).toBeUndefined();
    expect(world._vehicleGraph).toBeUndefined();

    const rawClone = structuredClone(world);
    Object.setPrototypeOf(rawClone, Object.prototype);
    const hydrated = hydrateTransferredWorld(rawClone);
    expect(hydrated).toBeInstanceOf(ProceduralLogisticsWorld);
    expect(hydrated.idx(5, 3)).toBe(3 * hydrated.W + 5);
    expect(hydrated.inBounds(10, 10, 2)).toBe(true);
    expect(typeof hydrated.hasRoadEdge(10, 10, 11, 10)).toBe("boolean");
  });
});
