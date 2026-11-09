/**
 * @import {
 *   WorldSizePreset,
 *   GeneratorConfig
 * } from './types.js'
 */

export const WATER_MASK = Object.freeze({
  DRY: 0,
  RIVER: 1,
  OPEN_WATER: 2,
});

export const ROAD_GRID = Object.freeze({
  NONE: 0,
  STREET: 1,
  ARTERIAL: 2,
  BRIDGE: 3,
});

export const BUILDING_MASK = Object.freeze({
  EMPTY: 0,
  HOUSE: 1,
  DESTINATION: 2,
  AIRPORT: 3,
  TRANSIT_RESERVE: 4,
  FARM_FIELD: 5,
});

export const WORLD_GEOMETRY = Object.freeze({
  ROUNDABOUT_RADII: Object.freeze({
    airportGate: 0.68,
    townStub: 0.64,
    diamondTurnaround: 0.56,
    clipMargin: 0.24,
  }),
  CONTOUR_TERRACES: Object.freeze([
    Object.freeze({ dh: 0.13, fill: "#ebe7de", stroke: "#dfdace" }),
    Object.freeze({ dh: 0.24, fill: "#e3ded2", stroke: "#d5cfc0" }),
    Object.freeze({ dh: 0.36, fill: "#dad4c5", stroke: "#cac3b2" }),
  ]),
  RIVER_RENDER_WIDTHS: Object.freeze({
    mainStart: 0.84,
    mainEnd: 1.44,
    tribStart: 0.56,
    tribEnd: 1.08,
    bankExtra: 1.15,
  }),
  ELEVATION_THRESHOLDS: Object.freeze({
    seaLevelDefault: 0.34,
    springMinAboveSea: 0.21,
    tunnelMinAboveSea: 0.235,
    headwaterRoadExclusion: 6.0,
  }),
  EXPRESSWAY_LIMITS: Object.freeze({
    maxStateMotorways: 6,
    maxRiverProxArc: 14.5,
    minTurnCos: 0.35,
    minWideTurnCos: 0.16,
    maxContinentalWaterArc: 9.5,
    maxIslandWaterArc: 12.5,
  }),
});

export const SIM_CONFIG = Object.freeze({
  FLEET: Object.freeze({
    commuterCars: 120,
    freightTrucks: 42,
    basePlanesPerAirport: 2,
    islandHopperPlanesPerAirport: 3,
    initialTrips: 1372,
    flightTripWeight: 6,
  }),
  VEHICLE_ROUTING: Object.freeze({
    edgeWeightMotorway: 0.38,
    edgeWeightArterial: 1.0,
    edgeWeightStreet: 1.35,
    speedMultMotorway: 1.65,
    speedMultArterial: 1.0,
    speedMultStreet: 0.82,
    laneOffsetMotorway: 0.18,
    laneOffsetRoad: 0.13,
    laneOffsetDriveway: 0.06,
    laneOffsetSlipRamp: 0.04,
  }),
  AVIATION: Object.freeze({
    taxiSpeed: 2.2,
    takeoffSpeed: 13.5,
    cruiseSpeed: 16.5,
    landingSpeed: 12.5,
    gateDwellSec: 1.2,
    holdShortLookaheadTiles: 12,
    climbOutAlt: 0.18,
    cruiseAlt: 1.0,
  }),
});

/** @type {Readonly<Record<string, WorldSizePreset>>} */
export const WORLD_SIZE_PRESETS = Object.freeze({
  compact: Object.freeze({
    W: 240,
    H: 150,
    tileSize: 15,
    label: "240×150 Grid",
  }),
  standard: Object.freeze({
    W: 360,
    H: 224,
    tileSize: 15,
    label: "360×224 Grid",
  }),
  large: Object.freeze({
    W: 540,
    H: 336,
    tileSize: 12,
    label: "540×336 Grid",
  }),
  huge: Object.freeze({
    W: 720,
    H: 448,
    tileSize: 10,
    label: "720×448 Grid",
  }),
});

/** @type {Readonly<Record<string, Readonly<{ towns: number, airports: number }>>>} */
export const WORLD_SIZE_DEFAULTS = Object.freeze({
  compact: Object.freeze({ towns: 14, airports: 2 }),
  standard: Object.freeze({ towns: 20, airports: 3 }),
  large: Object.freeze({ towns: 28, airports: 4 }),
  huge: Object.freeze({ towns: 36, airports: 5 }),
});

export const WIND_AXES = Object.freeze([
  Object.freeze({
    angleDeg: 0,
    rad: 0,
    label: "RWY 09/27 (E–W)",
    shortLabel: "09/27 (E–W)",
  }),
  Object.freeze({
    angleDeg: 45,
    rad: Math.PI / 4,
    label: "RWY 04/22 (NE–SW)",
    shortLabel: "04/22 (NE–SW)",
  }),
  Object.freeze({
    angleDeg: 90,
    rad: Math.PI / 2,
    label: "RWY 18/36 (N–S)",
    shortLabel: "18/36 (N–S)",
  }),
  Object.freeze({
    angleDeg: 135,
    rad: (3 * Math.PI) / 4,
    label: "RWY 13/31 (NW–SE)",
    shortLabel: "13/31 (NW–SE)",
  }),
]);

/** @type {Readonly<Required<GeneratorConfig>>} */
export const DEFAULT_GENERATOR_CONFIG = Object.freeze({
  seed: "OTTD-METRO-84",
  worldSize: "standard",
  archetype: "confluence",
  terrainAlgo: "tectonic-fbm",
  hydrologyAlgo: "thalweg-astar",
  airportMix: "hub-regional",
  includeIntermediateRamps: true,
  waterCoverage: 48,
  townCount: 20,
  buildingDensity: 250,
  airportCount: 3,
  windAxis: -1,
});
