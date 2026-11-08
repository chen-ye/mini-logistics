import {
  ProceduralLogisticsWorld,
  extractWorldTransferables,
  computeEarliestChangedStage
} from './world-generator.js';

const ckptStore = {};
let prevConfig = null;

self.addEventListener('message', (event) => {
  const { requestId, config, preserveCamera } = event.data;
  const startStage = computeEarliestChangedStage(prevConfig, config);
  prevConfig = { ...config };
  const world = new ProceduralLogisticsWorld(config).generate(startStage, ckptStore);
  const transferList = extractWorldTransferables(world);
  self.postMessage({ requestId, preserveCamera, world }, transferList);
});
