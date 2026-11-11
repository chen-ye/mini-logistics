/**
 * Expressway Interchange entity module index.
 * Encapsulates cloverleaf, trumpet, and diamond interchange geometry, procedural placement,
 * road network displacement, and grade-separated lower/upper static Z-layer recording.
 *
 * Invariants:
 * - 100% Worker-safe and headless-safe: zero DOM or window references.
 * - Single source of truth for expressway interchange geometry and lifecycle hooks.
 */

import {
  CLOVERLEAF_GEOMETRY,
  DIAMOND_GEOMETRY,
  TRUMPET_GEOMETRY,
} from "./geometry.js";

import {
  detectAndBuildCloverleafs,
  buildIntermediateExpresswayRamps,
} from "./placement.js";

import { recordMotorwaysLower, recordOverpassBridges } from "./render.js";

/**
 * Places expressway interchanges across the motorway trunk network.
 *
 * @param {any} specOrWorld
 * @param {any} [maybeWorld]
 */
export function place(specOrWorld, maybeWorld) {
  const world = maybeWorld || specOrWorld;
  detectAndBuildCloverleafs(world);
  buildIntermediateExpresswayRamps(world);
}

const recordStaticZLayers = Object.assign(
  /**
   * @param {string} slotName
   * @param {any} rec
   * @param {any} world
   * @param {number} ts
   */
  (slotName, rec, world, ts) => {
    if (slotName === "motorwayLower") {
      recordMotorwaysLower(rec, world, ts);
    } else if (slotName === "overpassUpper") {
      recordOverpassBridges(rec, world, ts);
    }
  },
  {
    motorwayLower: recordMotorwaysLower,
    overpassUpper: recordOverpassBridges,
  },
);

/** @type {import("../../types.js").EntityDefinition} */
export const InterchangeEntity = Object.freeze({
  id: "interchange",
  kind: "interchange",
  hitPriority: 50,
  CLOVERLEAF_GEOMETRY,
  DIAMOND_GEOMETRY,
  TRUMPET_GEOMETRY,
  place,
  recordStaticZLayers,
});

export * from "./geometry.js";
export * from "./placement.js";
export * from "./render.js";
