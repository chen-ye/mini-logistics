/**
 * RCI Building entity module index.
 * Encapsulates catalog specifications, procedural placement, static and overlay rendering,
 * and inspector / dossier resolution for residential, commercial, and industrial facilities.
 *
 * Invariants:
 * - 100% Worker-safe and headless-safe: zero DOM or window references.
 * - Single source of truth for RCI building domain definition and lifecycle hooks.
 *
 * @import { Destination, EntityDefinition, ViewLayer } from "../../types.js"
 */

import {
  RAW_NICHE_SPECS,
  MFG_SPECS,
  FINISHED_GOODS_ORDER,
  FINISHED_GOODS_CATALOG,
  CARGO_STAGE_COLORS,
  getCargoStageColor,
  getBuildingPillSpec,
  compassSector,
  describeCommercialLotByGoods,
  nameCommercialSubType,
  describeBuildingDossier,
  getPartnerStageBadgeClass,
} from "./catalog.js";

import { seedOutOfTownResourceNiches } from "./placement.js";

import {
  recordBuildingsAndHouses,
  drawRCIZoneUnderlay,
  drawRCICargoChainOverlay,
  drawBuildingSelectionHighlight,
} from "./render.js";

import {
  resolveBuilding,
  hitTestBuilding,
  getBuildingCameraTarget,
  describeBuildingLivePatch,
  renderBuildingDossier,
} from "./inspect.js";

/**
 * Places RCI buildings across rural resource niches and town zones.
 *
 * @param {any} specOrWorld
 * @param {any} [maybeWorld]
 * @returns {any}
 */
export function place(specOrWorld, maybeWorld) {
  const world = maybeWorld || specOrWorld;
  return seedOutOfTownResourceNiches(world);
}

const recordStaticZLayers = Object.assign(
  /**
   * @param {string} slotName
   * @param {any} rec
   * @param {any} world
   * @param {number} ts
   */
  (slotName, rec, world, ts) => {
    if (slotName === "surfaceStructures") {
      recordBuildingsAndHouses(rec, world, ts);
    }
  },
  {
    surfaceStructures: recordBuildingsAndHouses,
  },
);

const drawOverlay = Object.assign(
  /**
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
   * @param {any} world
   * @param {ViewLayer} layer
   */
  (ctx, world, layer) => {
    if (layer === "rci") {
      const ts = world?.tileSize || 12;
      drawRCIZoneUnderlay(ctx, world, ts);
      drawRCICargoChainOverlay(ctx, world, ts);
    }
  },
  {
    rciUnderlay: drawRCIZoneUnderlay,
    rciGraph: drawRCICargoChainOverlay,
  },
);

/**
 * Adapts drawBuildingSelectionHighlight to EntityInspectSpec parameter order (ctx, entity, world, ts).
 *
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {Destination} entity
 * @param {any} world
 * @param {number} ts
 */
function drawBuildingHighlight(ctx, entity, world, ts) {
  drawBuildingSelectionHighlight(ctx, world, entity, ts);
}

/** @type {EntityDefinition<Destination>} */
export const RCIBuildingEntity = Object.freeze({
  id: "rci-building",
  kind: "building",
  hitPriority: 30,
  RAW_NICHE_SPECS,
  MFG_SPECS,
  FINISHED_GOODS_ORDER,
  FINISHED_GOODS_CATALOG,
  CARGO_STAGE_COLORS,
  getCargoStageColor,
  getBuildingPillSpec,
  compassSector,
  describeCommercialLotByGoods,
  nameCommercialSubType,
  describeBuildingDossier,
  getPartnerStageBadgeClass,
  place,
  recordStaticZLayers,
  drawOverlay,
  inspect: {
    resolve: resolveBuilding,
    hitTest: hitTestBuilding,
    getCameraTarget: getBuildingCameraTarget,
    drawHighlight: drawBuildingHighlight,
    renderDossier: renderBuildingDossier,
    describeLivePatch: describeBuildingLivePatch,
  },
});

export * from "./catalog.js";
export * from "./placement.js";
export * from "./render.js";
export * from "./inspect.js";
