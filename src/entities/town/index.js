/**
 * Town entity module index.
 * Encapsulates settlement hierarchy generation, street grid network carving,
 * urban blush background rendering, settlement hierarchy overlay, and town inspection/dossier.
 *
 * Invariants:
 * - 100% Worker-safe and headless-safe: zero DOM or window references.
 * - Single source of truth for town domain definition and lifecycle hooks.
 *
 * @import { EntityDefinition, Town, ViewLayer } from "../../types.js"
 */

import { seedSettlements, carveTownStreetGrids } from "./placement.js";

import {
  recordUrbanBlush,
  drawHierarchyOverlay,
  drawTownSelectionHighlight,
} from "./render.js";

import {
  resolveTown,
  hitTestTown,
  getTownCameraTarget,
  describeTownLivePatch,
  renderTownDossier,
} from "./inspect.js";

const recordStaticZLayers = Object.assign(
  /**
   * @param {string} slotName
   * @param {any} rec
   * @param {any} world
   * @param {number} ts
   */
  (slotName, rec, world, ts) => {
    if (slotName === "urbanBlush") {
      recordUrbanBlush(rec, world, ts);
    }
  },
  {
    urbanBlush: recordUrbanBlush,
  },
);

const drawOverlay = Object.assign(
  /**
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
   * @param {any} world
   * @param {ViewLayer} layer
   */
  (ctx, world, layer) => {
    if (layer === "hierarchy") {
      drawHierarchyOverlay(ctx, world, world?.tileSize || 12);
    }
  },
  {
    hierarchy: drawHierarchyOverlay,
  },
);

/**
 * Adapts drawTownSelectionHighlight to EntityInspectSpec parameter order (ctx, entity, world, ts).
 *
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {Town} entity
 * @param {any} world
 * @param {number} ts
 */
function drawTownHighlight(ctx, entity, world, ts) {
  if (entity && typeof entity.urbanRadius === "number") {
    drawTownSelectionHighlight(ctx, world, entity, ts);
  } else {
    drawTownSelectionHighlight(ctx, entity, world, ts);
  }
}

/**
 * Adapts carveTownStreetGrids to the EntityDefinition connectRoadNet contract (entity, world)
 * while supporting legacy direct calls (world, filterFn).
 *
 * @param {any} entityOrWorld
 * @param {any} [worldOrFilter]
 * @returns {any}
 */
export function connectRoadNet(entityOrWorld, worldOrFilter) {
  if (
    entityOrWorld &&
    (entityOrWorld.W !== undefined || entityOrWorld.config !== undefined)
  ) {
    return carveTownStreetGrids(entityOrWorld, worldOrFilter);
  }
  const entity = entityOrWorld;
  const world = worldOrFilter;
  return carveTownStreetGrids(world, entity ? (t) => t.id === entity.id : null);
}

/** @type {EntityDefinition<Town>} */
export const TownEntity = Object.freeze({
  id: "town",
  kind: "town",
  hitPriority: 40,
  place: seedSettlements,
  connectRoadNet,
  recordStaticZLayers,
  drawOverlay,
  inspect: {
    resolve: resolveTown,
    hitTest: hitTestTown,
    getCameraTarget: getTownCameraTarget,
    drawHighlight: drawTownHighlight,
    renderDossier: renderTownDossier,
    describeLivePatch: describeTownLivePatch,
  },
});

export * from "./placement.js";
export * from "./render.js";
export * from "./inspect.js";
