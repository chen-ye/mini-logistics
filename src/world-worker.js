import {
  createWorldPipeline,
  extractWorldTransferables,
} from "./world-generator.js";

const workerSelf = /** @type {DedicatedWorkerGlobalScope} */ (
  /** @type {unknown} */ (self)
);

const runWorldPipeline = createWorldPipeline();

workerSelf.addEventListener("message", (event) => {
  if (!event.data || event.data.type === "connectPort") {
    return;
  }

  const { requestId, config, preserveCamera, preserveUrlHydration } =
    event.data;

  const tWall0 = performance.now();
  const world = runWorldPipeline(config);
  world.wallTimeMs = Math.round(performance.now() - tWall0);

  /** @type {Transferable[]} */
  const transferList = [...extractWorldTransferables(world)];
  workerSelf.postMessage(
    { requestId, preserveCamera, preserveUrlHydration, world },
    transferList,
  );
});
