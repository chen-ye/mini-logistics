import { ProceduralLogisticsWorld, extractWorldTransferables } from './world-generator.js';

self.addEventListener('message', (event) => {
  const { requestId, config, preserveCamera } = event.data;
  const world = new ProceduralLogisticsWorld(config).generate();
  const transferList = extractWorldTransferables(world);
  self.postMessage({ requestId, preserveCamera, world }, transferList);
});
