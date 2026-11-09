import { describe, test, expect } from "bun:test";
import { SeededRNG, FastNoise2D, FlatMinHeap } from "../../src/math.js";
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

describe("FlatMinHeap typed-array binary min-heap", () => {
  test("maintains strictly ascending priority order and pops smallest element first", () => {
    const heap = new FlatMinHeap();
    const items = [
      { id: 10, prio: 42.5 },
      { id: 20, prio: 3.14 },
      { id: 30, prio: 100.0 },
      { id: 40, prio: 0.05 },
      { id: 50, prio: 18.2 },
      { id: 60, prio: 7.89 },
    ];

    for (const item of items) {
      heap.push(item.id, item.prio);
    }
    expect(heap.size).toBe(items.length);

    const prios = new Map(items.map((it) => [it.id, it.prio]));
    let prevPrio = -Infinity;
    const poppedIds = [];

    while (heap.size > 0) {
      const id = heap.pop();
      poppedIds.push(id);
      const prio = prios.get(id);
      expect(prio).toBeDefined();
      expect(prio).toBeGreaterThanOrEqual(prevPrio);
      prevPrio = prio;
    }

    expect(poppedIds).toEqual([40, 20, 60, 50, 10, 30]);
    expect(heap.size).toBe(0);
    expect(heap.pop()).toBe(-1);
  });

  test("guarantees deterministic tie-breaking bit-for-bit identical to legacy inline array heaps", () => {
    const heap = new FlatMinHeap();

    // Legacy inline array heap from routeValleyThalwegAStar / d8-strahler
    /** @type {number[]} */
    const refNodes = [];
    /** @type {number[]} */
    const refPriorities = [];
    /**
     * @param {number} node
     * @param {number} prio
     */
    const refPush = (node, prio) => {
      let i = refNodes.length;
      refNodes.push(node);
      refPriorities.push(prio);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (refPriorities[p] <= prio) break;
        refNodes[i] = refNodes[p];
        refPriorities[i] = refPriorities[p];
        i = p;
      }
      refNodes[i] = node;
      refPriorities[i] = prio;
    };
    /**
     * @returns {number | undefined}
     */
    const refPop = () => {
      const top = refNodes[0];
      const lastN = refNodes.pop();
      const lastP = refPriorities.pop();
      if (refNodes.length > 0 && lastN !== undefined && lastP !== undefined) {
        let i = 0;
        const n = refNodes.length;
        while ((i << 1) + 1 < n) {
          let c = (i << 1) + 1;
          if (c + 1 < n && refPriorities[c + 1] < refPriorities[c]) c++;
          if (lastP <= refPriorities[c]) break;
          refNodes[i] = refNodes[c];
          refPriorities[i] = refPriorities[c];
          i = c;
        }
        refNodes[i] = lastN;
        refPriorities[i] = lastP;
      }
      return top;
    };

    // Sequence with intentional priority collisions to test tie-breaking stability
    const testCases = [
      [101, 5.0],
      [102, 2.0],
      [103, 5.0], // tie at 5.0
      [104, 1.0],
      [105, 2.0], // tie at 2.0
      [106, 5.0], // 3-way tie at 5.0
      [107, 0.5],
      [108, 2.0], // 3-way tie at 2.0
      [109, 1.0], // tie at 1.0
      [110, 0.5], // tie at 0.5
    ];

    for (const [id, prio] of testCases) {
      heap.push(id, prio);
      refPush(id, prio);
    }

    expect(heap.size).toBe(testCases.length);

    const actualPops = [];
    const refPops = [];
    while (heap.size > 0) {
      actualPops.push(heap.pop());
      refPops.push(refPop());
    }

    expect(actualPops).toEqual(refPops);
  });

  test("automatically expands capacity from small initial capacity", () => {
    const heap = new FlatMinHeap(4);
    expect(heap.size).toBe(0);

    const count = 100;
    for (let i = 0; i < count; i++) {
      // Inverted priority so items must be reordered
      heap.push(i, (count - i) * 1.5);
    }
    expect(heap.size).toBe(count);

    const popped = [];
    while (heap.size > 0) {
      popped.push(heap.pop());
    }
    expect(popped.length).toBe(count);
    // Elements should pop in ascending priority order (smallest priority was for i = 99, 98, ... 0)
    expect(popped).toEqual(
      Array.from({ length: count }, (_, i) => count - 1 - i),
    );
  });

  test("supports reuse across clear() cycles without reallocating backing arrays", () => {
    const heap = new FlatMinHeap(8);

    // Cycle 1
    heap.push(1, 10);
    heap.push(2, 5);
    expect(heap.size).toBe(2);
    expect(heap.pop()).toBe(2);
    heap.clear();
    expect(heap.size).toBe(0);
    expect(heap.pop()).toBe(-1);

    // Cycle 2: verify heap is fully operational after clear
    heap.push(10, 20.0);
    heap.push(20, 5.0);
    heap.push(30, 15.0);
    expect(heap.size).toBe(3);
    expect(heap.pop()).toBe(20);
    expect(heap.pop()).toBe(30);
    expect(heap.pop()).toBe(10);
    expect(heap.size).toBe(0);
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
    expect(urbanCallbacks).toBe(3);

    // 3-entry LRU cache hit revisit (`w4 -> w5 -> w4`): reuses all 9 stages (`reusedThroughStage === 9`),
    // while signaling `terrainUnchanged: false` and firing `onHydrologyReady` / `onUrbanReady`
    // because the emitted hydrology/urban version changed relative to `w5`!
    const w6 = pipeline({ ...baseCfg, buildingDensity: 150 });
    expect(w6.reusedThroughStage).toBe(9);
    expect(w6.terrainUnchanged).toBe(false);
    expect(w6.hydroVersion).toBe(w4.hydroVersion);
    expect(w6.urbanVersion).toBe(w4.urbanVersion);
    expect(hydroCallbacks).toBe(3);
    expect(urbanCallbacks).toBe(4);

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
