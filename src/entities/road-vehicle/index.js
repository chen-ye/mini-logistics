/**
 * Road Vehicle (Freight Truck & Commuter Car) holistic entity module index.
 * Unites Pose2D & CargoManifest cursor stepping, Z-pass sprite rendering,
 * and live freight manifest inspection.
 *
 * @import { CarAgent, EntityDefinition } from "../../types.js"
 */

import { drawCarsZPass, drawTruckSelectionHighlight } from "./render.js";
import {
  resolveRoadVehicle,
  hitTestRoadVehicle,
  getRoadVehicleCameraTarget,
  describeRoadVehicleLivePatch,
  renderRoadVehicleDossier,
} from "./inspect.js";

/**
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {CarAgent} entity
 * @param {any} world
 * @param {number} ts
 */
function drawVehicleHighlight(ctx, entity, world, ts) {
  drawTruckSelectionHighlight(ctx, world, entity, ts);
}

/** @type {EntityDefinition<CarAgent>} */
export const RoadVehicleEntity = Object.freeze({
  id: "road-vehicle",
  kind: "truck",
  hitPriority: 12,
  drawLiveZPass: (ctx, pass, world, sim) => {
    if (
      pass === "road" ||
      pass === "motorway-lower" ||
      pass === "motorway-upper"
    ) {
      drawCarsZPass(ctx, world, sim, world?.tileSize || 12, pass);
    }
  },
  inspect: {
    resolve: resolveRoadVehicle,
    hitTest: hitTestRoadVehicle,
    getCameraTarget: getRoadVehicleCameraTarget,
    drawHighlight: drawVehicleHighlight,
    renderDossier: renderRoadVehicleDossier,
    describeLivePatch: describeRoadVehicleLivePatch,
  },
});

export * from "./car-stepper.js";
export * from "./render.js";
export * from "./inspect.js";
