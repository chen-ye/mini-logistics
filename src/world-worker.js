import {
  createWorldPipeline,
  extractWorldTransferables,
} from "./world-generator.js";
import { TerrainBitmapBaker } from "./terrain-bake-worker.js";

const workerSelf = /** @type {DedicatedWorkerGlobalScope} */ (
  /** @type {unknown} */ (self)
);

/** @type {MessagePort | null} */
let bakePort = null;
let hasSentBitmap = false;
let currentRequestId = 0;
/** @type {Promise<{ bitmap: ImageBitmap | OffscreenCanvas | HTMLCanvasElement, bakeTimeMs: number }> | null} */
let currentBakePromise = null;
/** @type {Map<number, (val: { bitmap: ImageBitmap | OffscreenCanvas | HTMLCanvasElement, bakeTimeMs: number }) => void>} */
const pendingBakeResolvers = new Map();
const localBakerFallback = new TerrainBitmapBaker();

const runWorldPipeline = createWorldPipeline({
  onHydrologyReady(s2bState, recomputed) {
    if (bakePort && recomputed) {
      // Stream Stage 2B hydrology to the parallel TerrainBakeWorker immediately (~65ms into build)
      // so Marching-Squares Path2Ds, contour terraces & rivers rasterize on Core 2 while Stages 3–7 run on Core 1!
      const elevCopy = new Float32Array(s2bState.elevationField);
      const waterCopy = new Uint8Array(s2bState.waterMask);
      bakePort.postMessage(
        {
          type: "prepareHydro",
          hydroVersion: s2bState.hydroVersion,
          W: s2bState.W,
          H: s2bState.H,
          tileSize: s2bState.tileSize,
          seaLevel: s2bState.seaLevel,
          elevationField: elevCopy,
          waterMask: waterCopy,
          rivers: s2bState.rivers,
        },
        [elevCopy.buffer, waterCopy.buffer],
      );
    }
  },
  onUrbanReady(s2bState, s67State, terrainOrUrbanChanged) {
    if (!bakePort) return;
    if (!terrainOrUrbanChanged && hasSentBitmap) {
      currentBakePromise = null;
      return;
    }
    // Stream Stage 6/7 urban blush & trees to TerrainBakeWorker BEFORE Stage 8 (Motorways) & Stage 9 (Cargo) start
    // so `composeTerrainBitmap` runs on Core 2 concurrently with Stage 8 & Stage 9 on Core 1!
    const reqId = currentRequestId;
    const zoneCopy = new Int8Array(s67State.zoneColorIdx);
    currentBakePromise = new Promise((resolve) => {
      pendingBakeResolvers.set(reqId, resolve);
    });
    bakePort.postMessage(
      {
        type: "composeTerrain",
        requestId: reqId,
        hydroVersion: s2bState.hydroVersion,
        urbanVersion: s67State.urbanVersion,
        W: s2bState.W,
        H: s2bState.H,
        tileSize: s2bState.tileSize,
        zoneColorIdx: zoneCopy,
        trees: s67State.trees,
      },
      [zoneCopy.buffer],
    );
  },
});

/** @param {MessagePort} port */
function attachBakePort(port) {
  bakePort = port;
  bakePort.onmessage = (ev) => {
    const msg = ev.data;
    if (msg?.type === "terrainReady") {
      const resolve = pendingBakeResolvers.get(msg.requestId);
      if (resolve) {
        pendingBakeResolvers.delete(msg.requestId);
        resolve(msg);
      }
    }
  };
}

workerSelf.addEventListener("message", async (event) => {
  if (event.data?.type === "connectPort" && event.ports?.[0]) {
    attachBakePort(event.ports[0]);
    return;
  }

  const { requestId, config, preserveCamera } = event.data;
  currentRequestId = requestId;
  currentBakePromise = null;

  const tWall0 = performance.now();
  const world = runWorldPipeline(config);

  let terrainBitmap = null;
  let bakeTimeMs = 0;
  let waitAfterGenMs = 0;

  if (world.terrainUnchanged && hasSentBitmap) {
    world.reuseTerrainBitmap = true;
  } else if (bakePort && currentBakePromise) {
    const tWait0 = performance.now();
    const res = await currentBakePromise;
    waitAfterGenMs = Number((performance.now() - tWait0).toFixed(1));
    terrainBitmap = res.bitmap;
    bakeTimeMs = res.bakeTimeMs;
    hasSentBitmap = true;
  } else {
    localBakerFallback.prepareHydroLayers({
      hydroVersion: world.hydroVersion,
      W: world.W,
      H: world.H,
      tileSize: world.tileSize,
      seaLevel: world.seaLevel,
      elevationField: world.elevationField,
      waterMask: world.waterMask,
      rivers: world.rivers,
    });
    const res = localBakerFallback.composeTerrainBitmap({
      hydroVersion: world.hydroVersion,
      urbanVersion: world.urbanVersion,
      W: world.W,
      H: world.H,
      tileSize: world.tileSize,
      zoneColorIdx: world.zoneColorIdx,
      trees: world.trees,
    });
    terrainBitmap = res.bitmap;
    bakeTimeMs = res.bakeTimeMs;
    hasSentBitmap = true;
  }

  world.terrainBitmap = terrainBitmap;
  world.bakeTimeMs = bakeTimeMs;
  world.waitAfterGenMs = waitAfterGenMs;
  world.wallTimeMs = Math.round(performance.now() - tWall0);

  /** @type {Transferable[]} */
  const transferList = [...extractWorldTransferables(world)];
  if (
    terrainBitmap &&
    typeof ImageBitmap !== "undefined" &&
    terrainBitmap instanceof ImageBitmap
  ) {
    transferList.push(terrainBitmap);
  }
  workerSelf.postMessage({ requestId, preserveCamera, world }, transferList);
});
