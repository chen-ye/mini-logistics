/**
 * Airport holistic entity module index.
 * Unites airfield layout geometry, procedural placement, landside road connection,
 * static Path2D Z-layer recording, single-writer AirportATCController runtime actor,
 * and interactive OBB hit-testing / dossier inspection.
 *
 * @import { Airport, EntityDefinition, ViewLayer } from "../../types.js"
 */

import { computeAirfieldLayout } from "./layout.js";
import {
  solveAndPlaceAirports,
  buildAirportLandsideNetwork,
} from "./placement.js";
import { AirportATCController } from "./atc-actor.js";
import {
  recordAirportGroundPads,
  recordAirportStructures,
  recordAirwayCorridors,
  drawAirportSolverOverlay,
  drawAirportSelectionHighlight,
} from "./render.js";
import {
  resolveAirport,
  hitTestAirport,
  getAirportCameraTarget,
  describeAirportLivePatch,
  renderAirportDossier,
} from "./inspect.js";

const recordStaticZLayers = Object.assign(
  /**
   * @param {string} slotName
   * @param {any} rec
   * @param {any} world
   * @param {number} ts
   */
  (slotName, rec, world, ts) => {
    if (slotName === "surfacePad") {
      recordAirportGroundPads(rec, world, ts);
    } else if (slotName === "surfaceStructures") {
      recordAirportStructures(rec, world, ts);
    } else if (slotName === "airways") {
      recordAirwayCorridors(rec, world, ts);
    }
  },
  {
    surfacePad: recordAirportGroundPads,
    surfaceStructures: recordAirportStructures,
    airways: recordAirwayCorridors,
  },
);

const drawOverlay = Object.assign(
  /**
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
   * @param {any} world
   * @param {ViewLayer} layer
   */
  (ctx, world, layer) => {
    if (layer === "airport") {
      drawAirportSolverOverlay(ctx, world, world?.tileSize || 12);
    }
  },
  {
    airport: drawAirportSolverOverlay,
  },
);

/**
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {Airport} entity
 * @param {any} world
 * @param {number} ts
 */
function drawAirportHighlight(ctx, entity, world, ts) {
  drawAirportSelectionHighlight(ctx, world, entity, ts);
}

/** @type {EntityDefinition<Airport, AirportATCController>} */
export const AirportEntity = Object.freeze({
  id: "airport",
  kind: "airport",
  hitPriority: 20,
  computeLayout: computeAirfieldLayout,
  place: solveAndPlaceAirports,
  connectRoadNet: (ap, world) => buildAirportLandsideNetwork(world, ap),
  recordStaticZLayers,
  createActor: (ap, world) =>
    new AirportATCController(ap, world?.windVector ?? null),
  drawOverlay,
  inspect: {
    resolve: resolveAirport,
    hitTest: hitTestAirport,
    getCameraTarget: getAirportCameraTarget,
    drawHighlight: drawAirportHighlight,
    renderDossier: (ap, world, sim) =>
      renderAirportDossier(ap, world, sim?.planes ?? []),
    describeLivePatch: (ap, world, sim) =>
      describeAirportLivePatch(ap, world, sim?.planes ?? null),
  },
});

export * from "./layout.js";
export * from "./placement.js";
export * from "./atc-actor.js";
export * from "./render.js";
export * from "./inspect.js";
