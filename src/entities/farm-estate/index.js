/**
 * Farm Estate entity module index.
 * Encapsulates procedural placement of agricultural estate parcels, tractor tracks,
 * smooth boundary tracing, and background arable field rendering.
 *
 * Invariants:
 * - 100% Worker-safe and headless-safe: zero DOM or window references.
 * - Single source of truth for farm estate domain definition and lifecycle hooks.
 *
 * @import { Destination, EntityDefinition } from "../../types.js"
 */

import { buildFarmEstate } from "./placement.js";
import { recordFarmBackgroundFields } from "./render.js";

const recordStaticZLayers = Object.assign(
  /**
   * @param {string} slotName
   * @param {any} rec
   * @param {any} world
   * @param {number} ts
   */
  (slotName, rec, world, ts) => {
    if (slotName === "treesAndFarms") {
      recordFarmBackgroundFields(rec, world, ts);
    }
  },
  {
    treesAndFarms: recordFarmBackgroundFields,
  },
);

/**
 * Adapts buildFarmEstate to the EntityDefinition place contract while preserving direct multi-arg calls.
 *
 * @param {any} worldOrSpec
 * @param {any} [fgxOrWorld]
 * @param {number} [fgy]
 * @param {number} [fcx]
 * @param {number} [fcy]
 * @param {number} [slotIdx]
 * @returns {any}
 */
export const place = (
  worldOrSpec,
  fgxOrWorld = 0,
  fgy = 0,
  fcx = 0,
  fcy = 0,
  slotIdx = 0,
) => {
  if (typeof fgxOrWorld === "number") {
    return buildFarmEstate(worldOrSpec, fgxOrWorld, fgy, fcx, fcy, slotIdx);
  }
  const spec = worldOrSpec || {};
  const world = fgxOrWorld;
  return buildFarmEstate(
    world,
    spec.fgx ?? 0,
    spec.fgy ?? 0,
    spec.fcx ?? 0,
    spec.fcy ?? 0,
    spec.slotIdx ?? 0,
  );
};

/** @type {EntityDefinition<Destination>} */
export const FarmEstateEntity = Object.freeze({
  id: "farm-estate",
  kind: "building",
  hitPriority: 35,
  place,
  recordStaticZLayers,
});

export * from "./placement.js";
export * from "./render.js";
