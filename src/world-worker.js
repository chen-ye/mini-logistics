/**
 * Dedicated procedural world generation Web Worker (`Stages 1–9`).
 *
 * Transfers zero-copy TypedArray buffers directly to `render-sim-worker.js` over a bound
 * `MessagePort` while reporting lightweight `WorldSummary` telemetry to `main.js`.
 *
 * @import { WorldSummary } from "./types.js"
 */

import {
  createWorldPipeline,
  extractWorldTransferables,
} from "./world-generator.js";

const workerSelf = /** @type {DedicatedWorkerGlobalScope} */ (
  /** @type {unknown} */ (self)
);

const runWorldPipeline = createWorldPipeline();

/** @type {MessagePort | null} */
let renderPort = null;

workerSelf.addEventListener("message", (event) => {
  if (!event.data) return;

  if (event.data.type === "BIND_RENDER_PORT") {
    const port = event.ports?.[0] || event.data.port || null;
    if (port) {
      renderPort = port;
      renderPort.start?.();
    }
    return;
  }

  if (event.data.type === "connectPort") {
    return;
  }

  const { requestId, config, preserveCamera, preserveUrlHydration, isMobile } =
    event.data;

  const tWall0 = performance.now();
  const world = runWorldPipeline(config);
  world.wallTimeMs = Math.round(performance.now() - tWall0);

  /** @type {WorldSummary} */
  const worldSummary = {
    W: world.W,
    H: world.H,
    tileSize: world.tileSize,
    seed: world.config.seed || "",
    config: world.config,
    wallTimeMs: world.wallTimeMs,
    genTimeMs: world.genTimeMs,
    reusedThroughStage: world.reusedThroughStage,
    housesCount: world.houses.length,
    destinationsCount: world.destinations.length,
    towns: world.towns.map((t) => ({
      id: t.id,
      name: t.name,
      tier: t.tier,
      x: t.x,
      y: t.y,
      urbanRadius: t.urbanRadius,
    })),
    airports: world.airports.map((a) => ({
      id: a.id,
      code: a.iata,
      name: a.name,
      tier: a.tier,
      airportClass: a.airportClass,
      x: a.x,
      y: a.y,
      halfLen: a.halfLen,
    })),
    systemInterchangeCount: world.interchanges.filter(
      (i) => i.type === "cloverleaf" || i.type === "trumpet",
    ).length,
    diamondRampCount: world.interchanges.filter(
      (i) => i.type === "diamond-ramp",
    ).length,
    logs: world.logs,
  };

  /** @type {Transferable[]} */
  const transferList = [...extractWorldTransferables(world)];

  if (renderPort) {
    renderPort.postMessage(
      {
        type: "WORLD_READY",
        requestId,
        preserveCamera,
        preserveUrlHydration,
        isMobile,
        world,
        worldSummary,
      },
      transferList,
    );
    workerSelf.postMessage({
      type: "JOB_COMPLETE",
      requestId,
      preserveCamera,
      preserveUrlHydration,
      worldSummary,
    });
    return;
  }

  workerSelf.postMessage(
    {
      requestId,
      preserveCamera,
      preserveUrlHydration,
      world,
      worldSummary,
    },
    transferList,
  );
});
