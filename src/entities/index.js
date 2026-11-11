/**
 * Holistic Entity Registry Bootstrap.
 * Imports and registers all 7 vertical domain entity definitions in ascending hitPriority order.
 */

import { registerEntityDefinitions } from "./registry.js";
import { AircraftEntity } from "./aircraft/index.js";
import { RoadVehicleEntity } from "./road-vehicle/index.js";
import { AirportEntity } from "./airport/index.js";
import { RCIBuildingEntity } from "./rci-building/index.js";
import { FarmEstateEntity } from "./farm-estate/index.js";
import { TownEntity } from "./town/index.js";
import { InterchangeEntity } from "./interchange/index.js";

export const ALL_ENTITY_DEFINITIONS = Object.freeze([
  AircraftEntity,
  RoadVehicleEntity,
  AirportEntity,
  RCIBuildingEntity,
  FarmEstateEntity,
  TownEntity,
  InterchangeEntity,
]);

registerEntityDefinitions(ALL_ENTITY_DEFINITIONS);

export {
  AircraftEntity,
  RoadVehicleEntity,
  AirportEntity,
  RCIBuildingEntity,
  FarmEstateEntity,
  TownEntity,
  InterchangeEntity,
};
export * from "./registry.js";
