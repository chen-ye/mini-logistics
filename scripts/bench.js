#!/usr/bin/env bun
/**
 * Longitudinal performance benchmark runner for Mini Logistics.
 *
 * Measures:
 * 1. Per-stage breakdown (s1_wind -> s9_rampsAndCargo + total) across benchmark seeds.
 * 2. Cold build scenarios (compact, standard, huge).
 * 3. Incremental / reactive cache scenarios (stage9_rampsToggle, stage67_densityChange, revisit_ABA_engineSwitch).
 * 4. Simulation throughput (simulationUsPerTick over 1,000 ticks).
 *
 * Supports:
 * - --save <label> [--update-baseline]: records benchmark into benchmarks/history.jsonl
 * - --compare [baselinePathOrLabel] [--markdown]: prints comparison against baseline
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  createWorldPipeline,
  ProceduralLogisticsWorld,
} from "../src/world-generator.js";
import { synthesizeTerrainAndBasins } from "../src/terrain-solvers.js";
import { synthesizeFluvialHydrology } from "../src/hydrology-solvers.js";
import { SeededRNG, FastNoise2D } from "../src/math.js";
import { LogisticsSimulator } from "../src/simulator.js";
import { MiniMotorwaysRenderer } from "../src/renderer.js";
import { DEFAULT_GENERATOR_CONFIG } from "../src/constants.js";

/**
 * @typedef {Object} StatSummary
 * @property {number} p50
 * @property {number} p95
 * @property {number} min
 * @property {number} iqr
 */

/**
 * Computes min, p50, p95, and interquartile range (IQR) from numeric samples.
 *
 * @param {number[]} samples
 * @returns {StatSummary}
 */
export function computeStats(samples) {
  if (!samples || samples.length === 0) {
    return { p50: 0, p95: 0, min: 0, iqr: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0];

  /**
   * @param {number} p
   * @returns {number}
   */
  function quantile(p) {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  const p50 = quantile(0.5);
  const p95 = quantile(0.95);
  const p25 = quantile(0.25);
  const p75 = quantile(0.75);
  const iqr = p75 - p25;

  const round3 = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;

  return {
    p50: round3(p50),
    p95: round3(p95),
    min: round3(min),
    iqr: round3(iqr),
  };
}

/**
 * Measures per-stage execution durations for a single cold pipeline run.
 *
 * @param {Record<string, unknown>} config
 * @returns {Record<string, number>}
 */
function measureStagesOnce(config) {
  const fullConfig = { ...DEFAULT_GENERATOR_CONFIG, ...config };
  const w = new ProceduralLogisticsWorld(fullConfig);
  const tTotal0 = performance.now();
  w.ensureGridSize(fullConfig.worldSize || "standard");
  w.noise = new FastNoise2D(new SeededRNG(`${fullConfig.seed}::noise`));

  let t0 = performance.now();
  w.setStageRNG("stage1_wind");
  w.initPrevailingWind();
  const s1_wind = performance.now() - t0;

  t0 = performance.now();
  w.setStageRNG("stage2a_terrain");
  const { basins, primarySink } = synthesizeTerrainAndBasins(w);
  const s2a_terrain = performance.now() - t0;

  t0 = performance.now();
  w.setStageRNG("stage2b_hydro");
  synthesizeFluvialHydrology(w, basins, primarySink);
  const s2b_hydrology = performance.now() - t0;

  t0 = performance.now();
  w.computeSpatialFields();
  const s3_spatial = performance.now() - t0;

  t0 = performance.now();
  w.setStageRNG("stage4_settlements");
  w.seedSettlements();
  const s4_settlements = performance.now() - t0;

  t0 = performance.now();
  w.setStageRNG("stage5_airports");
  w.solveAndPlaceAirports();
  const s5_airports = performance.now() - t0;

  t0 = performance.now();
  w.setStageRNG("stage6a_grids");
  w.carveTownStreetGrids((t) => t._seededInPhase1 !== false);
  w.setStageRNG("stage6b_roads");
  w.buildRegionalRoadNetwork();
  w.setStageRNG("stage7_rci");
  w.growUrbanFabric();
  w.setStageRNG("stage9_trees");
  w.populateLandscapeTrees();
  const s6_7_urban = performance.now() - t0;

  t0 = performance.now();
  w.setStageRNG("stage8_motorways");
  w.buildNumberedMotorways();
  const s8_motorways = performance.now() - t0;

  t0 = performance.now();
  w.setStageRNG("stage9_ramps");
  w.finalizeExpresswayRampsAndTunnels();
  w.setStageRNG("stage8b_cargo");
  w.buildIndustrialCargoChain();
  w.buildCommuterRoutes();
  const s9_rampsAndCargo = performance.now() - t0;
  const total = performance.now() - tTotal0;

  return {
    s1_wind,
    s2a_terrain,
    s2b_hydrology,
    s3_spatial,
    s4_settlements,
    s5_airports,
    s6_7_urban,
    s8_motorways,
    s9_rampsAndCargo,
    total,
  };
}

/**
 * Runs repeated cold builds across a configuration to collect stage metrics.
 *
 * @param {Record<string, unknown>} config
 * @param {number} timedRuns
 * @returns {Record<string, StatSummary>}
 */
function benchmarkStageBreakdown(config, timedRuns = 5) {
  // Warmup run
  measureStagesOnce(config);

  const stageKeys = [
    "s1_wind",
    "s2a_terrain",
    "s2b_hydrology",
    "s3_spatial",
    "s4_settlements",
    "s5_airports",
    "s6_7_urban",
    "s8_motorways",
    "s9_rampsAndCargo",
    "total",
  ];

  /** @type {Record<string, number[]>} */
  const samples = {};
  for (const k of stageKeys) samples[k] = [];

  for (let i = 0; i < timedRuns; i++) {
    const run = measureStagesOnce(config);
    for (const k of stageKeys) {
      samples[k].push(run[k] || 0);
    }
  }

  /** @type {Record<string, StatSummary>} */
  const result = {};
  for (const k of stageKeys) {
    result[k] = computeStats(samples[k]);
  }
  return result;
}

/**
 * Benchmarks cold pipeline builds for a world size.
 *
 * @param {string} worldSize
 * @param {number} timedRuns
 * @returns {StatSummary}
 */
function benchmarkColdBuild(worldSize, timedRuns = 5) {
  const cfg = { ...DEFAULT_GENERATOR_CONFIG, worldSize };

  // Warmup
  createWorldPipeline()(cfg);

  const samples = [];
  for (let i = 0; i < timedRuns; i++) {
    const p = createWorldPipeline();
    const t0 = performance.now();
    p(cfg);
    samples.push(performance.now() - t0);
  }
  return computeStats(samples);
}

/**
 * Benchmarks incremental / reactive cache scenarios.
 *
 * @returns {Record<string, StatSummary>}
 */
function benchmarkIncremental() {
  // 1. stage9_rampsToggle (includeIntermediateRamps toggle, reusedThroughStage === 8)
  const rampSamples = [];
  for (let i = 0; i < 5; i++) {
    const p = createWorldPipeline();
    p(DEFAULT_GENERATOR_CONFIG);
    const t0 = performance.now();
    p({ ...DEFAULT_GENERATOR_CONFIG, includeIntermediateRamps: false });
    rampSamples.push(performance.now() - t0);
  }

  // 2. stage67_densityChange (buildingDensity change, reusedThroughStage === 5)
  const densitySamples = [];
  for (let i = 0; i < 5; i++) {
    const p = createWorldPipeline();
    p(DEFAULT_GENERATOR_CONFIG);
    const t0 = performance.now();
    p({ ...DEFAULT_GENERATOR_CONFIG, buildingDensity: 200 });
    densitySamples.push(performance.now() - t0);
  }

  // 3. revisit_ABA_engineSwitch (measuring 3-entry LRU cache hit < 0.5ms)
  const pABA = createWorldPipeline();
  const cfgA = {
    ...DEFAULT_GENERATOR_CONFIG,
    terrainAlgo: "tectonic-fbm",
    hydrologyAlgo: "thalweg-astar",
  };
  const cfgB = {
    ...DEFAULT_GENERATOR_CONFIG,
    terrainAlgo: "quilez-erosion",
    hydrologyAlgo: "d8-strahler",
  };

  pABA(cfgA);
  pABA(cfgB);

  const abaSamples = [];
  for (let i = 0; i < 10; i++) {
    pABA(cfgA);
    pABA(cfgB);
    const t0 = performance.now();
    pABA(cfgA);
    abaSamples.push(performance.now() - t0);
  }

  return {
    stage9_rampsToggle: computeStats(rampSamples),
    stage67_densityChange: computeStats(densitySamples),
    revisit_ABA_engineSwitch: computeStats(abaSamples),
  };
}

/**
 * Benchmarks simulation tick update throughput (microseconds per tick).
 *
 * @returns {StatSummary}
 */
function benchmarkSimulation() {
  const p = createWorldPipeline();
  const world = p(DEFAULT_GENERATOR_CONFIG);
  const sim = new LogisticsSimulator(world);

  // Warmup
  for (let i = 0; i < 300; i++) sim.update(0.05, 1.0);

  const samples = [];
  const TICKS = 1000;
  for (let b = 0; b < 10; b++) {
    const t0 = performance.now();
    for (let t = 0; t < TICKS; t++) {
      sim.update(0.05, 1.0);
    }
    const dtMs = performance.now() - t0;
    const usPerTick = (dtMs / TICKS) * 1000;
    samples.push(usPerTick);
  }
  return computeStats(samples);
}

/**
 * Benchmarks VectorLayerRecorder display-list recording time (ms) and 60fps
 * `MiniMotorwaysRenderer.prototype.render(world, sim)` replay frame time (ms)
 * across `standard` (360×224) and `huge` (720×448) maps.
 *
 * @returns {Record<string, StatSummary>}
 */
function benchmarkRenderFrame() {
  const createStubCanvas = () => {
    const noop = () => {};
    const grad = { addColorStop: noop };
    const ctx = {
      fillStyle: "#000",
      strokeStyle: "#000",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      font: "10px sans-serif",
      textAlign: "start",
      textBaseline: "alphabetic",
      clearRect: noop,
      fillRect: noop,
      strokeRect: noop,
      save: noop,
      restore: noop,
      translate: noop,
      rotate: noop,
      scale: noop,
      beginPath: noop,
      closePath: noop,
      moveTo: noop,
      lineTo: noop,
      quadraticCurveTo: noop,
      bezierCurveTo: noop,
      arc: noop,
      rect: noop,
      roundRect: noop,
      clip: noop,
      fill: noop,
      stroke: noop,
      setLineDash: noop,
      fillText: noop,
      measureText: (/** @type {string} */ t) => ({ width: t.length * 6 }),
      createRadialGradient: () => grad,
    };
    return {
      width: 1600,
      height: 1000,
      getContext: () => ctx,
    };
  };

  /**
   * @param {"standard" | "huge"} worldSize
   * @param {number} recordRuns
   */
  const measureSize = (worldSize, recordRuns) => {
    const p = createWorldPipeline();
    const world = p({ ...DEFAULT_GENERATOR_CONFIG, worldSize });
    const sim = new LogisticsSimulator(world);
    const renderer = new MiniMotorwaysRenderer(
      /** @type {any} */ (createStubCanvas()),
    );
    renderer.fitCamera(world);

    // Warmup
    renderer.prepareDisplayLists(world);
    renderer.render(world, sim);

    const recordSamples = [];
    for (let i = 0; i < recordRuns; i++) {
      renderer.hydroDisplayList = null;
      renderer.urbanTerrainDisplayList = null;
      renderer.surfaceNetworkDisplayList = null;
      renderer.motorwayDisplayList = null;
      renderer._cachedVectorPaths = null;
      renderer._cachedArablePaths = null;
      const t0 = performance.now();
      renderer.prepareDisplayLists(world);
      recordSamples.push(performance.now() - t0);
    }

    const replaySamples = [];
    for (let i = 0; i < 300; i++) {
      sim.update(0.016, 1.0);
      const t0 = performance.now();
      renderer.render(world, sim);
      replaySamples.push(performance.now() - t0);
    }

    return {
      record: computeStats(recordSamples),
      replay: computeStats(replaySamples),
    };
  };

  const std = measureSize("standard", 5);
  const huge = measureSize("huge", 3);

  return {
    recordStandardMs: std.record,
    replayStandardMs: std.replay,
    recordHugeMs: huge.record,
    replayHugeMs: huge.replay,
  };
}

/**
 * Runs the full benchmark suite.
 *
 * @param {string} [label="current-run"]
 * @returns {Record<string, unknown>}
 */
export function runFullBenchmark(label = "current-run") {
  let gitSha = "unknown";
  try {
    gitSha = execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
    }).trim();
  } catch {
    // fallback if git is unavailable
  }

  process.stderr.write(`Running benchmark [${label}] (git: ${gitSha})…\n`);

  process.stderr.write("  Benchmarking OTTD-METRO-84…\n");
  const ottdMetro = benchmarkStageBreakdown({ seed: "OTTD-METRO-84" }, 5);

  process.stderr.write("  Benchmarking DELTA-402…\n");
  const delta402 = benchmarkStageBreakdown(
    { seed: "DELTA-402", archetype: "estuary" },
    5,
  );

  process.stderr.write("  Benchmarking ISLAND-HOP-101 (island-hopper)…\n");
  const islandHop = benchmarkStageBreakdown(
    { seed: "ISLAND-HOP-101", archetype: "island-hopper", airportCount: 5 },
    5,
  );

  process.stderr.write(
    "  Benchmarking cold builds (compact, standard, huge)…\n",
  );
  const compactBuild = benchmarkColdBuild("compact", 5);
  const standardBuild = benchmarkColdBuild("standard", 5);
  const hugeBuild = benchmarkColdBuild("huge", 3);

  process.stderr.write("  Benchmarking incremental cache scenarios…\n");
  const incremental = benchmarkIncremental();

  process.stderr.write(
    "  Benchmarking simulation step throughput (us/tick)…\n",
  );
  const simulationUsPerTick = benchmarkSimulation();

  process.stderr.write(
    "  Benchmarking VectorLayerRecorder display-list record & 60fps replay…\n",
  );
  const renderFrame = benchmarkRenderFrame();

  return {
    label,
    gitSha,
    timestamp: new Date().toISOString(),
    stageBreakdown: {
      "OTTD-METRO-84": ottdMetro,
      "DELTA-402": delta402,
      "ISLAND-HOP-101": islandHop,
    },
    coldBuilds: {
      compact: compactBuild,
      standard: standardBuild,
      huge: hugeBuild,
    },
    incremental,
    simulationUsPerTick,
    renderFrame,
  };
}

/**
 * Formats delta comparisons into a clean Markdown table.
 *
 * @param {Record<string, any>} baseline
 * @param {Record<string, any>} current
 * @returns {string}
 */
export function formatComparisonMarkdown(baseline, current) {
  const lines = [];
  lines.push(
    `### Performance Benchmark Delta: \`${baseline.label || "baseline"}\` (${baseline.gitSha || "prev"}) → \`${current.label || "current"}\` (${current.gitSha || "now"})`,
  );
  lines.push("");
  lines.push("| Metric / Stage | Baseline p50 | Current p50 | Δ ms | Δ % |");
  lines.push("| :--- | ---: | ---: | ---: | ---: |");

  /**
   * @param {string} metric
   * @param {number} bVal
   * @param {number} cVal
   * @param {string} [unit="ms"]
   */
  function addRow(metric, bVal, cVal, unit = "ms") {
    const diff = cVal - bVal;
    const diffPct = bVal > 0 ? (diff / bVal) * 100 : 0;
    const diffSign = diff > 0 ? "+" : diff < 0 ? "-" : "";
    const pctSign = diffPct > 0 ? "+" : diffPct < 0 ? "-" : "";

    const bStr = `${bVal.toFixed(3)} ${unit}`;
    const cStr = `${cVal.toFixed(3)} ${unit}`;
    const dStr =
      diff === 0
        ? `0.000 ${unit}`
        : `${diffSign}${Math.abs(diff).toFixed(3)} ${unit}`;
    const pctStr =
      diffPct === 0 ? "0.0%" : `${pctSign}${Math.abs(diffPct).toFixed(1)}%`;

    lines.push(`| ${metric} | ${bStr} | ${cStr} | ${dStr} | ${pctStr} |`);
  }

  // 1. Stage Breakdowns
  const seeds = ["OTTD-METRO-84", "DELTA-402", "ISLAND-HOP-101"];
  const stages = [
    "s1_wind",
    "s2a_terrain",
    "s2b_hydrology",
    "s3_spatial",
    "s4_settlements",
    "s5_airports",
    "s6_7_urban",
    "s8_motorways",
    "s9_rampsAndCargo",
    "total",
  ];

  for (const seed of seeds) {
    for (const st of stages) {
      const bP50 = baseline.stageBreakdown?.[seed]?.[st]?.p50;
      const cP50 = current.stageBreakdown?.[seed]?.[st]?.p50;
      if (bP50 != null && cP50 != null) {
        addRow(`${seed}: ${st}`, bP50, cP50, "ms");
      }
    }
  }

  // 2. Cold Builds
  const worldSizes = [
    ["compact", "compact (240×150)"],
    ["standard", "standard (360×224)"],
    ["huge", "huge (720×448)"],
  ];
  for (const [key, label] of worldSizes) {
    const bP50 = baseline.coldBuilds?.[key]?.p50;
    const cP50 = current.coldBuilds?.[key]?.p50;
    if (bP50 != null && cP50 != null) {
      addRow(`Cold Build: ${label}`, bP50, cP50, "ms");
    }
  }

  // 3. Incremental
  const incKeys = [
    ["stage9_rampsToggle", "Incremental: stage9_rampsToggle"],
    ["stage67_densityChange", "Incremental: stage67_densityChange"],
    ["revisit_ABA_engineSwitch", "Incremental: revisit_ABA_engineSwitch"],
  ];
  for (const [key, label] of incKeys) {
    const bP50 = baseline.incremental?.[key]?.p50;
    const cP50 = current.incremental?.[key]?.p50;
    if (bP50 != null && cP50 != null) {
      addRow(label, bP50, cP50, "ms");
    }
  }

  // 4. Simulation Throughput
  const bSim = baseline.simulationUsPerTick?.p50;
  const cSim = current.simulationUsPerTick?.p50;
  if (bSim != null && cSim != null) {
    addRow("Simulation: us/tick", bSim, cSim, "µs");
  }

  // 5. Render Frame & Display-List Recording
  const renderKeys = [
    ["recordStandardMs", "Render: Display-List Record (standard)"],
    ["replayStandardMs", "Render: 60fps Frame Replay (standard)"],
    ["recordHugeMs", "Render: Display-List Record (huge)"],
    ["replayHugeMs", "Render: 60fps Frame Replay (huge)"],
  ];
  for (const [key, label] of renderKeys) {
    const bP50 = baseline.renderFrame?.[key]?.p50;
    const cP50 = current.renderFrame?.[key]?.p50;
    if (bP50 != null && cP50 != null) {
      addRow(label, bP50, cP50, "ms");
    }
  }

  return lines.join("\n");
}

/**
 * Loads baseline benchmark record from a file path or history label.
 *
 * @param {string} [target]
 * @returns {Record<string, any>}
 */
function loadBaseline(target) {
  const baselineFile = path.resolve(
    process.cwd(),
    target && fs.existsSync(target) ? target : "benchmarks/baseline.json",
  );
  if (fs.existsSync(baselineFile)) {
    try {
      return JSON.parse(fs.readFileSync(baselineFile, "utf8"));
    } catch {
      // fallback
    }
  }

  // Try finding by label in history.jsonl
  const historyFile = path.resolve(process.cwd(), "benchmarks/history.jsonl");
  if (fs.existsSync(historyFile)) {
    const lines = fs
      .readFileSync(historyFile, "utf8")
      .split("\n")
      .filter(Boolean);
    if (target) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const item = JSON.parse(lines[i]);
        if (item.label === target) return item;
      }
    }
    if (lines.length > 0) {
      return JSON.parse(lines[0]);
    }
  }

  throw new Error(
    `Could not find baseline benchmark for: ${target || "default"}`,
  );
}

// CLI Execution Entry Point
function main() {
  const args = process.argv.slice(2);

  const saveIdx = args.indexOf("--save");
  const saveLabel =
    saveIdx !== -1 && args[saveIdx + 1] ? args[saveIdx + 1] : null;

  const compareIdx = args.indexOf("--compare");
  const hasCompare = compareIdx !== -1;
  const compareTarget =
    hasCompare && args[compareIdx + 1] && !args[compareIdx + 1].startsWith("--")
      ? args[compareIdx + 1]
      : null;

  const updateBaseline = args.includes("--update-baseline");
  const markdownMode = args.includes("--markdown");

  const currentRun = runFullBenchmark(saveLabel || "current-run");

  // Handle --save
  if (saveLabel) {
    const benchDir = path.resolve(process.cwd(), "benchmarks");
    if (!fs.existsSync(benchDir)) {
      fs.mkdirSync(benchDir, { recursive: true });
    }
    const historyPath = path.join(benchDir, "history.jsonl");
    fs.appendFileSync(historyPath, JSON.stringify(currentRun) + "\n", "utf8");

    const baselinePath = path.join(benchDir, "baseline.json");
    if (updateBaseline || !fs.existsSync(baselinePath)) {
      fs.writeFileSync(
        baselinePath,
        JSON.stringify(currentRun, null, 2) + "\n",
        "utf8",
      );
      process.stderr.write(`Updated baseline at ${baselinePath}\n`);
    }
    process.stderr.write(`Saved benchmark [${saveLabel}] to ${historyPath}\n`);
  }

  // Handle --compare
  if (hasCompare || markdownMode) {
    const baseline = loadBaseline(compareTarget || undefined);
    const md = formatComparisonMarkdown(baseline, currentRun);
    console.log(md);
  } else if (!saveLabel) {
    // Default output if neither save nor compare: print JSON
    console.log(JSON.stringify(currentRun, null, 2));
  }
}

if (import.meta.main) {
  main();
}
