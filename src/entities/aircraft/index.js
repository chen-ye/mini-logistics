/**
 * Aircraft holistic entity module index.
 * Unites 3-class flight track synthesis, 10-state non-holonomic FSM stepping,
 * ground/air Z-pass silhouette rendering, and live flight-strip inspection.
 *
 * @import { PlaneAgent, EntityDefinition } from "../../types.js"
 */

import { drawPlanesZPass, drawPlaneSelectionHighlight } from "./render.js";
import {
  resolveAircraft,
  hitTestAircraft,
  getAircraftCameraTarget,
  describeAircraftLivePatch,
  renderAircraftDossier,
} from "./inspect.js";

/**
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {PlaneAgent} entity
 * @param {any} world
 * @param {number} ts
 */
function drawPlaneHighlight(ctx, entity, world, ts) {
  drawPlaneSelectionHighlight(ctx, world, entity, ts);
}

/** @type {EntityDefinition<PlaneAgent>} */
export const AircraftEntity = Object.freeze({
  id: "aircraft",
  kind: "plane",
  hitPriority: 10,
  drawLiveZPass: (ctx, pass, world, sim) => {
    if (pass === "ground" || pass === "air") {
      drawPlanesZPass(
        ctx,
        world,
        sim,
        world?.tileSize || 12,
        pass,
        "aesthetic",
      );
    }
  },
  inspect: {
    resolve: resolveAircraft,
    hitTest: hitTestAircraft,
    getCameraTarget: getAircraftCameraTarget,
    drawHighlight: drawPlaneHighlight,
    renderDossier: renderAircraftDossier,
    describeLivePatch: describeAircraftLivePatch,
  },
});

export * from "./flight-track.js";
export * from "./plane-fsm.js";
export * from "./render.js";
export * from "./inspect.js";
