import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import {
  createAppStore,
  shallowEqual,
  batch,
  deriveControlLabels,
  createMemoStage,
} from "../../src/state.js";
import {
  compassSector,
  describeBuildingDossier,
} from "../../src/inspector-component.js";
import {
  WORLD_SIZE_PRESETS,
  DEFAULT_GENERATOR_CONFIG,
} from "../../src/constants.js";

// Read index.html purely via static file analysis (never mock DOM with jsdom or happy-dom!)
const indexPath = new URL("../../index.html", import.meta.url).pathname;
const indexHtml = fs.readFileSync(indexPath, "utf8");

/**
 * Extracts all option values from a <select id="..."> element.
 *
 * @param {string} html
 * @param {string} selectId
 * @returns {string[]}
 */
function getSelectOptionValues(html, selectId) {
  const selectRegex = new RegExp(
    `<select[^>]*id=["']${selectId}["'][^>]*>([\\s\\S]*?)<\\/select>`,
    "i",
  );
  const match = html.match(selectRegex);
  if (!match) return [];
  const optionsBlock = match[1];
  const optionRegex = /<option[^>]*value=["']([^"']+)["']/gi;
  const values = [];
  let m;
  while ((m = optionRegex.exec(optionsBlock)) !== null) {
    values.push(m[1]);
  }
  return values;
}

/**
 * Extracts data-layer values for all .layer-btn buttons.
 *
 * @param {string} html
 * @returns {string[]}
 */
function getLayerButtonValues(html) {
  const allButtons = html.match(/<button[^>]*>/gi) || [];
  const layerButtons = [];
  for (const btn of allButtons) {
    if (/class=["'][^"']*\blayer-btn\b[^"']*["']/i.test(btn)) {
      const m = btn.match(/data-layer=["']([^"']+)["']/i);
      if (m) layerButtons.push(m[1]);
    }
  }
  return layerButtons;
}

describe("HTML ↔ JS DOM Contract Static Verification", () => {
  const REQUIRED_DOM_IDS = [
    "worldCanvas",
    "toggleDrawerBtn",
    "drawerIconOpen",
    "seedInput",
    "randomSeedBtn",
    "generatorDrawer",
    "resetViewBtn",
    "closeDrawerMobileBtn",
    "archetypeSelect",
    "worldSizeSelect",
    "terrainAlgoSelect",
    "hydrologyAlgoSelect",
    "airportMixSelect",
    "toggleInterRamps",
    "valWater",
    "sliderWater",
    "valTowns",
    "sliderTowns",
    "valDensity",
    "sliderDensity",
    "valAirports",
    "sliderAirports",
    "valWind",
    "sliderWind",
    "telemetryGridLabel",
    "genTimeBadge",
    "statPop",
    "statAirports",
    "statBridges",
    "pipelineLog",
    "tripCounter",
    "dayLabel",
    "clockHand",
    "zoomInBtn",
    "zoomOutBtn",
    "hudFitBtn",
    "inspectorCard",
    "inspTitle",
    "inspBadge",
    "inspCode",
    "focusInspectorBtn",
    "closeInspectorBtn",
    "inspBody",
  ];

  test("verifies every required DOM element ID exists in index.html", () => {
    const missingIds = [];
    for (const id of REQUIRED_DOM_IDS) {
      const idPattern = new RegExp(`\\bid=["']${id}["']`);
      if (!idPattern.test(indexHtml)) {
        missingIds.push(id);
      }
    }
    expect(missingIds).toEqual([]);
  });

  test("verifies #worldSizeSelect options match WORLD_SIZE_PRESETS keys", () => {
    const actual = getSelectOptionValues(indexHtml, "worldSizeSelect");
    const expected = Object.keys(WORLD_SIZE_PRESETS);
    expect(actual).toEqual(expected);
  });

  test("verifies #archetypeSelect options match ArchetypeKey domain enum", () => {
    const actual = getSelectOptionValues(indexHtml, "archetypeSelect");
    const expected = [
      "confluence",
      "estuary",
      "archipelago",
      "inland",
      "island-hopper",
    ];
    expect(actual).toEqual(expected);
  });

  test("verifies #terrainAlgoSelect options match TerrainAlgoKey domain enum", () => {
    const actual = getSelectOptionValues(indexHtml, "terrainAlgoSelect");
    const expected = ["tectonic-fbm", "quilez-erosion", "voronoi-plates"];
    expect(actual).toEqual(expected);
  });

  test("verifies #hydrologyAlgoSelect options match HydrologyAlgoKey domain enum", () => {
    const actual = getSelectOptionValues(indexHtml, "hydrologyAlgoSelect");
    const expected = ["thalweg-astar", "d8-strahler", "meandering-plain"];
    expect(actual).toEqual(expected);
  });

  test("verifies #airportMixSelect options match AirportMixKey domain enum", () => {
    const actual = getSelectOptionValues(indexHtml, "airportMixSelect");
    const expected = ["hub-regional", "hub-reg-cargo", "dual-hub"];
    expect(actual).toEqual(expected);
  });

  test("verifies .layer-btn[data-layer] options match ViewLayer domain enum", () => {
    const actual = getLayerButtonValues(indexHtml);
    const expected = [
      "aesthetic",
      "rci",
      "airport",
      "hierarchy",
      "hydrology",
      "roadgrid",
    ];
    expect(actual).toEqual(expected);
  });
});

describe("Signal-Grade App Store & Memoization (src/state.js)", () => {
  test("patchConfig identity no-op bailout preserves state reference and fires 0 subscribers", () => {
    const store = createAppStore({ seed: "TEST-SEED-1" });
    const initialState = store.getState();
    const initialConfig = initialState.config;

    let subscriberNotifications = 0;
    const unsubscribe = store.subscribe(
      (s) => s.config,
      () => {
        subscriberNotifications++;
      },
    );

    // Patch with identical values -> must bailout
    const bailResult = store.patchConfig({ seed: "TEST-SEED-1" });
    expect(bailResult).toBe(false);
    expect(store.getState()).toBe(initialState);
    expect(store.getState().config).toBe(initialConfig);
    expect(subscriberNotifications).toBe(0);

    // Empty partial -> must bailout
    expect(store.patchConfig({})).toBe(false);
    expect(subscriberNotifications).toBe(0);

    // Patch with new value -> must update config reference and notify
    const updateResult = store.patchConfig({ seed: "TEST-SEED-2" });
    expect(updateResult).toBe(true);
    expect(store.getState()).not.toBe(initialState);
    expect(store.getState().config.seed).toBe("TEST-SEED-2");
    expect(subscriberNotifications).toBe(1);

    unsubscribe();
  });

  test("shallowEqual comparator correctly compares primitives, tuples, and objects", () => {
    // Identical references & primitives
    expect(shallowEqual(42, 42)).toBe(true);
    expect(shallowEqual("a", "a")).toBe(true);
    expect(shallowEqual(true, true)).toBe(true);
    expect(shallowEqual(null, null)).toBe(true);
    expect(shallowEqual(undefined, undefined)).toBe(true);
    expect(shallowEqual(NaN, NaN)).toBe(true);

    // Primitives vs objects or differing types
    expect(shallowEqual(42, "42")).toBe(false);
    expect(shallowEqual(null, {})).toBe(false);
    expect(shallowEqual({}, null)).toBe(false);
    expect(shallowEqual([], {})).toBe(false);

    // Arrays / Tuples
    expect(shallowEqual([1, 2, "3"], [1, 2, "3"])).toBe(true);
    expect(shallowEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(shallowEqual([1, 2], [1, 3])).toBe(false);

    // Objects
    expect(shallowEqual({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
    expect(shallowEqual({ a: 1, b: "x" }, { a: 1, b: "y" })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(shallowEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);

    // Prevents false-positive notifications for derived tuple slices
    const store = createAppStore();
    let notificationCount = 0;
    store.subscribe(
      (s) => [s.config.townCount, s.config.airportCount],
      () => {
        notificationCount++;
      },
      shallowEqual,
    );

    // Mutating unrelated field: seed changes, derived tuple is structurally equal
    store.patchConfig({ seed: "DIFFERENT-SEED" });
    expect(notificationCount).toBe(0);

    // Mutating townCount: derived tuple differs
    store.patchConfig({ townCount: 25 });
    expect(notificationCount).toBe(1);
  });

  test("batch(fn) coalesces multiple store mutations into a single subscriber flush", () => {
    const store = createAppStore();
    let notifyCount = 0;
    let lastState =
      /** @type {import('../../src/types.js').AppState | null} */ (null);

    store.subscribe(
      (s) => s,
      (s) => {
        notifyCount++;
        lastState = s;
      },
    );

    batch(() => {
      store.patchConfig({ townCount: 22 });
      store.setActiveLayer("roadgrid");
      store.setSimSpeed(2.5);
      store.patchConfig({ waterCoverage: 55 });
      // Notifications must be deferred during batch execution
      expect(notifyCount).toBe(0);
    });

    // Exactly 1 subscriber flush on outermost scope resolution
    expect(notifyCount).toBe(1);
    expect(lastState?.config.townCount).toBe(22);
    expect(lastState?.config.waterCoverage).toBe(55);
    expect(lastState?.activeLayer).toBe("roadgrid");
    expect(lastState?.simSpeed).toBe(2.5);

    // Nested batch support
    notifyCount = 0;
    batch(() => {
      store.patchConfig({ buildingDensity: 300 });
      batch(() => {
        store.setActiveLayer("rci");
      });
      expect(notifyCount).toBe(0);
    });
    expect(notifyCount).toBe(1);
  });

  test("createMemoStage 3-entry LRU cache retains 3 configurations without recomputation", () => {
    let computeRuns = 0;
    const memo = createMemoStage(
      (config) => [config.algo, config.size],
      (algo, size) => {
        computeRuns++;
        return { result: `${algo}::${size}` };
      },
      { maxSize: 3 },
    );

    const cfgA = { algo: "fbm", size: "std" };
    const cfgB = { algo: "quilez", size: "std" };
    const cfgC = { algo: "voronoi", size: "huge" };
    const cfgD = { algo: "meander", size: "compact" };

    // Initial evaluation A -> B -> C (3 distinct entries)
    const resA1 = memo(cfgA);
    expect(resA1.cached).toBe(false);
    expect(computeRuns).toBe(1);

    const resB1 = memo(cfgB);
    expect(resB1.cached).toBe(false);
    expect(computeRuns).toBe(2);

    const resC1 = memo(cfgC);
    expect(resC1.cached).toBe(false);
    expect(computeRuns).toBe(3);

    // Revisit A: A -> B -> C -> A
    // Must hit 3-entry LRU cache without recomputing!
    const resA2 = memo(cfgA);
    expect(resA2.cached).toBe(true);
    expect(resA2.value).toBe(resA1.value);
    expect(computeRuns).toBe(3);

    // Revisit B: MRU is now A, then C, then B
    const resB2 = memo(cfgB);
    expect(resB2.cached).toBe(true);
    expect(computeRuns).toBe(3);

    // Adding 4th configuration D should evict C (LRU)
    // MRU before D: B, A, C. C is at the tail.
    const resD1 = memo(cfgD);
    expect(resD1.cached).toBe(false);
    expect(computeRuns).toBe(4);

    // B and A should still hit cache
    expect(memo(cfgB).cached).toBe(true);
    expect(memo(cfgA).cached).toBe(true);
    expect(computeRuns).toBe(4);

    // C should miss cache and recompute
    const resC2 = memo(cfgC);
    expect(resC2.cached).toBe(false);
    expect(computeRuns).toBe(5);
  });

  test("deriveControlLabels returns identical frozen reference when unrelated config fields change", () => {
    const cfg1 = {
      ...DEFAULT_GENERATOR_CONFIG,
      seed: "SEED-ALPHA",
      worldSize: "standard",
      archetype: "confluence",
      waterCoverage: 48,
      townCount: 20,
      buildingDensity: 250,
      airportCount: 3,
      airportMix: "hub-regional",
      windAxis: -1,
    };

    const labels1 = deriveControlLabels(cfg1);
    expect(labels1.waterLabel).toBe("48%");
    expect(labels1.townsLabel).toBe("20 Towns");
    expect(labels1.densityLabel).toBe("250%");
    expect(labels1.airportsLabel).toBe("3 (1 Hub, 2 Reg)");
    expect(labels1.windLabel).toBe("Auto (Seed)");

    // Modify unrelated config fields: seed, worldSize, archetype, includeIntermediateRamps
    const cfg2 = {
      ...cfg1,
      seed: "SEED-BETA",
      worldSize: "huge",
      archetype: "archipelago",
      terrainAlgo: "voronoi-plates",
      hydrologyAlgo: "d8-strahler",
      includeIntermediateRamps: false,
    };

    const labels2 = deriveControlLabels(cfg2);
    // Must return the exact same frozen reference from 3-entry LRU cache!
    expect(labels2).toBe(labels1);

    // Modify a relevant label field (waterCoverage)
    const cfg3 = { ...cfg2, waterCoverage: 60 };
    const labels3 = deriveControlLabels(cfg3);
    expect(labels3).not.toBe(labels1);
    expect(labels3.waterLabel).toBe("60%");
  });
});

describe("Entity Inspector & Building Dossier (src/inspector-component.js)", () => {
  test("compassSector derives accurate 8-octant compass headings and core zone", () => {
    // Within 2.5 unit distance -> "Core"
    expect(compassSector(0, 0)).toBe("Core");
    expect(compassSector(1.2, -1.1)).toBe("Core");
    expect(compassSector(-2.0, 0)).toBe("Core");

    // Compass headings (y axis is positive downward in canvas space)
    expect(compassSector(10, 0)).toBe("E");
    expect(compassSector(10, 10)).toBe("SE");
    expect(compassSector(0, 10)).toBe("S");
    expect(compassSector(-10, 10)).toBe("SW");
    expect(compassSector(-10, 0)).toBe("W");
    expect(compassSector(-10, -10)).toBe("NW");
    expect(compassSector(0, -10)).toBe("N");
    expect(compassSector(10, -10)).toBe("NE");
  });

  test("describeBuildingDossier formats accurate metadata across all 8 facility types", () => {
    const mockWorld = {
      towns: [{ id: 0, name: "Metropolis", x: 50, y: 50 }],
    };

    // 1. CBD Landmark (circular commercial)
    const cbd = describeBuildingDossier(
      /** @type {any} */ ({
        id: 1,
        townId: 0,
        x: 50,
        y: 50,
        zoneType: "commercial",
        isCircular: true,
      }),
      /** @type {any} */ (mockWorld),
    );
    expect(cbd.stage).toBe("COM");
    expect(cbd.badge).toBe("CBD · LANDMARK");
    expect(cbd.shortTag).toBe("CBD");
    expect(cbd.title).toContain("Metropolis CBD Plaza (Core)");

    // 2. Commercial Arterial
    const com = describeBuildingDossier(
      /** @type {any} */ ({
        id: 2,
        townId: 0,
        x: 60,
        y: 50,
        zoneType: "commercial",
        isCircular: false,
      }),
      /** @type {any} */ (mockWorld),
    );
    expect(com.stage).toBe("COM");
    expect(com.badge).toBe("COM · ARTERIAL");
    expect(com.shortTag).toBe("COM");
    expect(com.title).toContain("Metropolis Commercial (E)");

    // 3. Raw Mine / Quarry
    const mine = describeBuildingDossier(
      /** @type {any} */ ({
        id: 3,
        townId: 0,
        x: 50,
        y: 40,
        zoneType: "industrial",
        subType: "RAW",
        resourceType: "MINE",
      }),
      /** @type {any} */ (mockWorld),
    );
    expect(mine.stage).toBe("RAW");
    expect(mine.badge).toBe("RAW · MINE");
    expect(mine.shortTag).toBe("MINE");
    expect(mine.typeLabel).toContain("Quarry");

    // 4. Raw Timber Sawmill
    const timber = describeBuildingDossier(
      /** @type {any} */ ({
        id: 4,
        townId: 0,
        x: 40,
        y: 50,
        zoneType: "industrial",
        subType: "RAW",
        resourceType: "TIMBER",
      }),
      /** @type {any} */ (mockWorld),
    );
    expect(timber.stage).toBe("RAW");
    expect(timber.badge).toBe("RAW · TIMBER");
    expect(timber.shortTag).toBe("WOOD");
    expect(timber.typeLabel).toContain("Sawmill");

    // 5. Raw Agricultural Farm
    const farm = describeBuildingDossier(
      /** @type {any} */ ({
        id: 5,
        townId: 0,
        x: 50,
        y: 60,
        zoneType: "industrial",
        subType: "RAW",
        resourceType: "FARM",
      }),
      /** @type {any} */ (mockWorld),
    );
    expect(farm.stage).toBe("RAW");
    expect(farm.badge).toBe("RAW · FARM");
    expect(farm.shortTag).toBe("FARM");
    expect(farm.typeLabel).toContain("Farm");

    // 6. Raw Chemical Plant
    const chem = describeBuildingDossier(
      /** @type {any} */ ({
        id: 6,
        townId: 0,
        x: 60,
        y: 60,
        zoneType: "industrial",
        subType: "RAW",
        resourceType: null,
      }),
      /** @type {any} */ (mockWorld),
    );
    expect(chem.stage).toBe("RAW");
    expect(chem.badge).toBe("RAW · CHEM");
    expect(chem.shortTag).toBe("CHEM");
    expect(chem.title).toContain("Metropolis Chemical Plant (SE)");

    // 7. Logistics Hub
    const log = describeBuildingDossier(
      /** @type {any} */ ({
        id: 7,
        townId: 0,
        x: 40,
        y: 40,
        zoneType: "industrial",
        subType: "LOG",
      }),
      /** @type {any} */ (mockWorld),
    );
    expect(log.stage).toBe("LOG");
    expect(log.badge).toBe("LOG · HUB");
    expect(log.shortTag).toBe("LOG");
    expect(log.title).toContain("Metropolis Logistics Hub (NW)");

    // 8. Manufacturing Factory
    const mfg = describeBuildingDossier(
      /** @type {any} */ ({
        id: 8,
        townId: 0,
        x: 60,
        y: 40,
        zoneType: "industrial",
        subType: "MFG",
      }),
      /** @type {any} */ (mockWorld),
    );
    expect(mfg.stage).toBe("MFG");
    expect(mfg.badge).toBe("MFG · FACTORY");
    expect(mfg.shortTag).toBe("MFG");
    expect(mfg.title).toContain("Metropolis Factory (NE)");

    // Fallback when world is null -> Regional title with #id
    const regional = describeBuildingDossier(
      /** @type {any} */ ({
        id: 99,
        townId: null,
        x: 10,
        y: 10,
        zoneType: "industrial",
        subType: "MFG",
      }),
      null,
    );
    expect(regional.title).toBe("Regional Factory (#99)");
  });
});
