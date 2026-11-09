/**
 * Pure URL state boundary parsing, validation, and canonical serialization for Mini Logistics.
 *
 * Invariants:
 * - All external search query parameters are parsed and validated strictly at the boundary.
 * - Out-of-range numbers clamp to valid bounds; invalid enum strings fall back cleanly to defaults.
 * - Camera target (cx, cy, z) is parsed only as a complete, finite triple.
 * - Serializer produces deterministic query strings with `seed` always leading.
 *
 * @import {
 *   AppState,
 *   CameraTarget,
 *   GeneratorConfig,
 *   InspectedSelection,
 *   ViewLayer,
 * } from './types.js'
 */

import { DEFAULT_GENERATOR_CONFIG } from "./constants.js";

/** @type {ReadonlyArray<string>} */
export const VALID_WORLD_SIZES = Object.freeze([
  "compact",
  "standard",
  "large",
  "huge",
]);

/** @type {ReadonlyArray<string>} */
export const VALID_ARCHETYPES = Object.freeze([
  "confluence",
  "estuary",
  "archipelago",
  "inland",
  "island-hopper",
]);

/** @type {ReadonlyArray<string>} */
export const VALID_TERRAIN_ALGOS = Object.freeze([
  "tectonic-fbm",
  "quilez-erosion",
  "voronoi-plates",
]);

/** @type {ReadonlyArray<string>} */
export const VALID_HYDRO_ALGOS = Object.freeze([
  "thalweg-astar",
  "d8-strahler",
  "meandering-plain",
]);

/** @type {ReadonlyArray<string>} */
export const VALID_AIRPORT_MIXES = Object.freeze([
  "hub-regional",
  "hub-reg-cargo",
  "dual-hub",
]);

/** @type {ReadonlyArray<ViewLayer>} */
export const VALID_VIEW_LAYERS = Object.freeze([
  "aesthetic",
  "rci",
  "airport",
  "hierarchy",
  "hydrology",
  "roadgrid",
]);

/** @type {ReadonlyArray<number>} */
export const VALID_SIM_SPEEDS = Object.freeze([0, 1, 2.5]);

/**
 * Clamps a number to [min, max], falling back to fallback if NaN or infinite.
 *
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(val, min, max, fallback) {
  if (!Number.isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}

/**
 * Sanitizes external seed string: removes control characters, trims, limits to 48 chars.
 *
 * @param {string | null | undefined} raw
 * @param {string} fallback
 * @returns {string}
 */
export function sanitizeSeed(raw, fallback = DEFAULT_GENERATOR_CONFIG.seed) {
  if (typeof raw !== "string") return fallback;
  // Strip control characters (< 32 or 127-159)
  const clean = Array.from(raw)
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 32 && code !== 127 && (code < 128 || code > 159);
    })
    .join("")
    .trim();
  if (clean.length === 0) return fallback;
  return clean.slice(0, 48);
}

/**
 * Parses a URL search string into a validated, deeply frozen partial AppState.
 *
 * @param {string | URLSearchParams} search
 * @param {boolean} [isMobileViewport=false]
 * @returns {{
 *   config: Readonly<Required<GeneratorConfig>>,
 *   activeLayer: ViewLayer,
 *   simSpeed: number,
 *   drawerOpen: boolean,
 *   camera: CameraTarget | null,
 *   inspected: InspectedSelection,
 * }}
 */
export function parseUrlState(search, isMobileViewport = false) {
  const params =
    typeof search === "string"
      ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
      : search instanceof URLSearchParams
        ? search
        : new URLSearchParams();

  // 1. Seed
  const rawSeed = params.get("seed");
  const seed = sanitizeSeed(rawSeed, DEFAULT_GENERATOR_CONFIG.seed);

  // 2. Map Gen Enums & Presets
  const rawSize = params.get("size");
  const worldSize =
    rawSize && VALID_WORLD_SIZES.includes(rawSize)
      ? rawSize
      : DEFAULT_GENERATOR_CONFIG.worldSize;

  const rawArch = params.get("arch");
  const archetype =
    rawArch && VALID_ARCHETYPES.includes(rawArch)
      ? rawArch
      : DEFAULT_GENERATOR_CONFIG.archetype;

  const rawTerrain = params.get("terrain");
  const terrainAlgo =
    rawTerrain && VALID_TERRAIN_ALGOS.includes(rawTerrain)
      ? rawTerrain
      : DEFAULT_GENERATOR_CONFIG.terrainAlgo;

  const rawHydro = params.get("hydro");
  const hydrologyAlgo =
    rawHydro && VALID_HYDRO_ALGOS.includes(rawHydro)
      ? rawHydro
      : DEFAULT_GENERATOR_CONFIG.hydrologyAlgo;

  const rawAirMix = params.get("airMix");
  const airportMix =
    rawAirMix && VALID_AIRPORT_MIXES.includes(rawAirMix)
      ? rawAirMix
      : DEFAULT_GENERATOR_CONFIG.airportMix;

  // 3. Map Gen Sliders & Flags
  const rawRamps = params.get("ramps");
  const includeIntermediateRamps =
    rawRamps === "0" || rawRamps === "false"
      ? false
      : rawRamps === "1" || rawRamps === "true"
        ? true
        : DEFAULT_GENERATOR_CONFIG.includeIntermediateRamps;

  const rawWater = params.get("water");
  const waterCoverage =
    rawWater !== null
      ? clampNumber(
          parseInt(rawWater, 10),
          20,
          80,
          DEFAULT_GENERATOR_CONFIG.waterCoverage,
        )
      : DEFAULT_GENERATOR_CONFIG.waterCoverage;

  const rawTowns = params.get("towns");
  const townCount =
    rawTowns !== null
      ? clampNumber(
          parseInt(rawTowns, 10),
          8,
          44,
          DEFAULT_GENERATOR_CONFIG.townCount,
        )
      : DEFAULT_GENERATOR_CONFIG.townCount;

  const rawDensity = params.get("density");
  const parsedDensity =
    rawDensity !== null
      ? clampNumber(
          parseInt(rawDensity, 10),
          50,
          350,
          DEFAULT_GENERATOR_CONFIG.buildingDensity,
        )
      : DEFAULT_GENERATOR_CONFIG.buildingDensity;
  const buildingDensity = Math.round(parsedDensity / 10) * 10;

  const rawAirports = params.get("airports");
  const airportCount =
    rawAirports !== null
      ? clampNumber(
          parseInt(rawAirports, 10),
          1,
          8,
          DEFAULT_GENERATOR_CONFIG.airportCount,
        )
      : DEFAULT_GENERATOR_CONFIG.airportCount;

  const rawWind = params.get("wind");
  const parsedWind = rawWind !== null ? parseInt(rawWind, 10) : -1;
  const windAxis = [-1, 0, 1, 2, 3].includes(parsedWind)
    ? parsedWind
    : DEFAULT_GENERATOR_CONFIG.windAxis;

  /** @type {Readonly<Required<GeneratorConfig>>} */
  const config = Object.freeze({
    seed,
    worldSize,
    archetype,
    terrainAlgo,
    hydrologyAlgo,
    airportMix,
    includeIntermediateRamps,
    waterCoverage,
    townCount,
    buildingDensity,
    airportCount,
    windAxis,
  });

  // 4. View State
  const rawLayer = params.get("layer");
  const activeLayer =
    rawLayer && VALID_VIEW_LAYERS.includes(/** @type {ViewLayer} */ (rawLayer))
      ? /** @type {ViewLayer} */ (rawLayer)
      : "aesthetic";

  const rawDrawer = params.get("drawer");
  const drawerOpen =
    rawDrawer === "0" || rawDrawer === "false"
      ? false
      : rawDrawer === "1" || rawDrawer === "true"
        ? true
        : !isMobileViewport;

  // Camera: only valid if cx, cy, and z are all present and finite
  /** @type {CameraTarget | null} */
  let camera = null;
  if (params.has("cx") && params.has("cy") && params.has("z")) {
    const rawCx = parseFloat(params.get("cx") || "");
    const rawCy = parseFloat(params.get("cy") || "");
    const rawZ = parseFloat(params.get("z") || "");
    if (
      Number.isFinite(rawCx) &&
      Number.isFinite(rawCy) &&
      Number.isFinite(rawZ)
    ) {
      const cx = Number((Math.round(rawCx * 10) / 10).toFixed(1));
      const cy = Number((Math.round(rawCy * 10) / 10).toFixed(1));
      const zoom = Number(
        (Math.round(Math.max(0.16, Math.min(3.5, rawZ)) * 100) / 100).toFixed(
          2,
        ),
      );
      camera = Object.freeze({ cx, cy, zoom });
    }
  }

  // 5. Interaction State
  const rawSpeed = params.get("speed");
  const parsedSpeed = rawSpeed !== null ? parseFloat(rawSpeed) : 1;
  const simSpeed = VALID_SIM_SPEEDS.includes(parsedSpeed) ? parsedSpeed : 1;

  /** @type {InspectedSelection} */
  let inspected = Object.freeze({
    type: null,
    id: null,
    entity: null,
  });
  const rawInspect = params.get("inspect");
  if (rawInspect) {
    const match = rawInspect.match(/^(airport|town|building):(\d+)$/);
    if (match) {
      inspected = Object.freeze({
        type: /** @type {"airport" | "building" | "town"} */ (match[1]),
        id: parseInt(match[2], 10),
        entity: null,
      });
    }
  }

  return Object.freeze({
    config,
    activeLayer,
    simSpeed,
    drawerOpen,
    camera,
    inspected,
  });
}

/**
 * Serializes AppState into a canonical query string.
 *
 * @param {Partial<AppState>} state
 * @param {{
 *   omitDefaults?: boolean,
 *   isMobileViewport?: boolean,
 * }} [options]
 * @returns {string} Query string with leading '?' or empty string
 */
export function serializeUrlState(state, options = {}) {
  const omitDefaults = options.omitDefaults ?? true;
  const cfg = state.config || DEFAULT_GENERATOR_CONFIG;
  const params = new URLSearchParams();

  // 1. Seed (always first)
  params.set("seed", cfg.seed || DEFAULT_GENERATOR_CONFIG.seed);

  // 2. Map Gen Parameters (in deterministic key order)
  if (!omitDefaults || cfg.worldSize !== DEFAULT_GENERATOR_CONFIG.worldSize) {
    if (VALID_WORLD_SIZES.includes(cfg.worldSize)) {
      params.set("size", cfg.worldSize);
    }
  }
  if (!omitDefaults || cfg.archetype !== DEFAULT_GENERATOR_CONFIG.archetype) {
    if (VALID_ARCHETYPES.includes(cfg.archetype)) {
      params.set("arch", cfg.archetype);
    }
  }
  if (
    !omitDefaults ||
    cfg.terrainAlgo !== DEFAULT_GENERATOR_CONFIG.terrainAlgo
  ) {
    if (VALID_TERRAIN_ALGOS.includes(cfg.terrainAlgo)) {
      params.set("terrain", cfg.terrainAlgo);
    }
  }
  if (
    !omitDefaults ||
    cfg.hydrologyAlgo !== DEFAULT_GENERATOR_CONFIG.hydrologyAlgo
  ) {
    if (VALID_HYDRO_ALGOS.includes(cfg.hydrologyAlgo)) {
      params.set("hydro", cfg.hydrologyAlgo);
    }
  }
  if (!omitDefaults || cfg.airportMix !== DEFAULT_GENERATOR_CONFIG.airportMix) {
    if (VALID_AIRPORT_MIXES.includes(cfg.airportMix)) {
      params.set("airMix", cfg.airportMix);
    }
  }
  if (
    !omitDefaults ||
    cfg.includeIntermediateRamps !==
      DEFAULT_GENERATOR_CONFIG.includeIntermediateRamps
  ) {
    params.set("ramps", cfg.includeIntermediateRamps ? "1" : "0");
  }
  if (
    !omitDefaults ||
    cfg.waterCoverage !== DEFAULT_GENERATOR_CONFIG.waterCoverage
  ) {
    params.set("water", String(cfg.waterCoverage));
  }
  if (!omitDefaults || cfg.townCount !== DEFAULT_GENERATOR_CONFIG.townCount) {
    params.set("towns", String(cfg.townCount));
  }
  if (
    !omitDefaults ||
    cfg.buildingDensity !== DEFAULT_GENERATOR_CONFIG.buildingDensity
  ) {
    params.set("density", String(cfg.buildingDensity));
  }
  if (
    !omitDefaults ||
    cfg.airportCount !== DEFAULT_GENERATOR_CONFIG.airportCount
  ) {
    params.set("airports", String(cfg.airportCount));
  }
  if (!omitDefaults || cfg.windAxis !== DEFAULT_GENERATOR_CONFIG.windAxis) {
    params.set("wind", String(cfg.windAxis));
  }

  // 3. View State
  const activeLayer = state.activeLayer ?? "aesthetic";
  if (!omitDefaults || activeLayer !== "aesthetic") {
    if (VALID_VIEW_LAYERS.includes(activeLayer)) {
      params.set("layer", activeLayer);
    }
  }

  const drawerOpen = state.drawerOpen;
  if (drawerOpen !== undefined) {
    const isMobile = options.isMobileViewport ?? false;
    const defaultDrawer = !isMobile;
    if (!omitDefaults || drawerOpen !== defaultDrawer) {
      params.set("drawer", drawerOpen ? "1" : "0");
    }
  }

  if (
    state.camera &&
    Number.isFinite(state.camera.cx) &&
    Number.isFinite(state.camera.cy) &&
    Number.isFinite(state.camera.zoom)
  ) {
    const cx = Number((Math.round(state.camera.cx * 10) / 10).toFixed(1));
    const cy = Number((Math.round(state.camera.cy * 10) / 10).toFixed(1));
    const z = Number(
      (
        Math.round(Math.max(0.16, Math.min(3.5, state.camera.zoom)) * 100) / 100
      ).toFixed(2),
    );
    params.set("cx", String(cx));
    params.set("cy", String(cy));
    params.set("z", String(z));
  }

  // 4. Interaction State
  const speed = state.simSpeed ?? 1;
  if (!omitDefaults || speed !== 1) {
    if (VALID_SIM_SPEEDS.includes(speed)) {
      params.set("speed", String(speed));
    }
  }

  const inspected = state.inspected;
  if (inspected && inspected.type && inspected.id != null) {
    const rawType =
      /** @type {string} */ (inspected.type) === "resource"
        ? "building"
        : inspected.type;
    if (rawType === "airport" || rawType === "town" || rawType === "building") {
      params.set("inspect", `${rawType}:${inspected.id}`);
    }
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}
