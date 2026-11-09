import { describe, test, expect } from "bun:test";
import {
  parseUrlState,
  serializeUrlState,
  sanitizeSeed,
  VALID_WORLD_SIZES,
  VALID_ARCHETYPES,
  VALID_TERRAIN_ALGOS,
  VALID_HYDRO_ALGOS,
  VALID_AIRPORT_MIXES,
  VALID_VIEW_LAYERS,
  VALID_SIM_SPEEDS,
} from "../../src/url-state.js";
import { DEFAULT_GENERATOR_CONFIG } from "../../src/constants.js";

describe("URL State Pure Boundary Parser & Serializer", () => {
  test("Allowlists are frozen arrays with expected values", () => {
    expect(Object.isFrozen(VALID_WORLD_SIZES)).toBe(true);
    expect(Object.isFrozen(VALID_ARCHETYPES)).toBe(true);
    expect(Object.isFrozen(VALID_TERRAIN_ALGOS)).toBe(true);
    expect(Object.isFrozen(VALID_HYDRO_ALGOS)).toBe(true);
    expect(Object.isFrozen(VALID_AIRPORT_MIXES)).toBe(true);
    expect(Object.isFrozen(VALID_VIEW_LAYERS)).toBe(true);
    expect(Object.isFrozen(VALID_SIM_SPEEDS)).toBe(true);
  });

  describe("Seed sanitization & security", () => {
    test("strips control characters and non-printable bytes", () => {
      const dirty = "TEST\x00\x08\x1F-SEED\x7F\x80\x9F";
      const clean = sanitizeSeed(dirty);
      expect(clean).toBe("TEST-SEED");
    });

    test("trims outer whitespace", () => {
      expect(sanitizeSeed("   MY-SEED-42   ")).toBe("MY-SEED-42");
    });

    test("truncates long seeds to 48 characters", () => {
      const longSeed = "A".repeat(100);
      const clean = sanitizeSeed(longSeed);
      expect(clean.length).toBe(48);
      expect(clean).toBe("A".repeat(48));
    });

    test("falls back to default seed for empty, null, or all-whitespace strings", () => {
      expect(sanitizeSeed("")).toBe(DEFAULT_GENERATOR_CONFIG.seed);
      expect(sanitizeSeed("   ")).toBe(DEFAULT_GENERATOR_CONFIG.seed);
      expect(sanitizeSeed(null)).toBe(DEFAULT_GENERATOR_CONFIG.seed);
      expect(sanitizeSeed(undefined)).toBe(DEFAULT_GENERATOR_CONFIG.seed);
    });
  });

  describe("parseUrlState defaults & invalid fallback", () => {
    test("returns frozen defaults for empty search string", () => {
      const state = parseUrlState("");
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.config)).toBe(true);
      expect(state.config).toEqual(DEFAULT_GENERATOR_CONFIG);
      expect(state.activeLayer).toBe("aesthetic");
      expect(state.simSpeed).toBe(1);
      expect(state.drawerOpen).toBe(true); // default desktop
      expect(state.camera).toBeNull();
      expect(state.inspected).toEqual({
        type: null,
        id: null,
        entity: null,
      });
    });

    test("sets drawerOpen to false by default on mobile viewport", () => {
      const desktop = parseUrlState("", false);
      expect(desktop.drawerOpen).toBe(true);

      const mobile = parseUrlState("", true);
      expect(mobile.drawerOpen).toBe(false);
    });

    test("falls back cleanly on invalid enum values", () => {
      const search =
        "?size=galactic&arch=mars&terrain=alien&hydro=dry&airMix=rocket&layer=xray&speed=99&wind=42";
      const state = parseUrlState(search);
      expect(state.config.worldSize).toBe(DEFAULT_GENERATOR_CONFIG.worldSize);
      expect(state.config.archetype).toBe(DEFAULT_GENERATOR_CONFIG.archetype);
      expect(state.config.terrainAlgo).toBe(
        DEFAULT_GENERATOR_CONFIG.terrainAlgo,
      );
      expect(state.config.hydrologyAlgo).toBe(
        DEFAULT_GENERATOR_CONFIG.hydrologyAlgo,
      );
      expect(state.config.airportMix).toBe(DEFAULT_GENERATOR_CONFIG.airportMix);
      expect(state.config.windAxis).toBe(DEFAULT_GENERATOR_CONFIG.windAxis);
      expect(state.activeLayer).toBe("aesthetic");
      expect(state.simSpeed).toBe(1);
    });

    test("falls back cleanly on invalid inspect param syntax", () => {
      expect(parseUrlState("?inspect=invalid").inspected).toEqual({
        type: null,
        id: null,
        entity: null,
      });
      expect(parseUrlState("?inspect=cat:12").inspected).toEqual({
        type: null,
        id: null,
        entity: null,
      });
      expect(parseUrlState("?inspect=airport:abc").inspected).toEqual({
        type: null,
        id: null,
        entity: null,
      });
      expect(parseUrlState("?inspect=town:-5").inspected).toEqual({
        type: null,
        id: null,
        entity: null,
      });
    });
  });

  describe("parseUrlState numeric clamping", () => {
    test("clamps waterCoverage to [20, 80]", () => {
      expect(parseUrlState("?water=999").config.waterCoverage).toBe(80);
      expect(parseUrlState("?water=-50").config.waterCoverage).toBe(20);
      expect(parseUrlState("?water=62").config.waterCoverage).toBe(62);
      expect(parseUrlState("?water=abc").config.waterCoverage).toBe(
        DEFAULT_GENERATOR_CONFIG.waterCoverage,
      );
    });

    test("clamps townCount to [8, 44]", () => {
      expect(parseUrlState("?towns=100").config.townCount).toBe(44);
      expect(parseUrlState("?towns=1").config.townCount).toBe(8);
      expect(parseUrlState("?towns=16").config.townCount).toBe(16);
    });

    test("clamps buildingDensity to [50, 350] in steps of 10", () => {
      expect(parseUrlState("?density=999").config.buildingDensity).toBe(350);
      expect(parseUrlState("?density=10").config.buildingDensity).toBe(50);
      expect(parseUrlState("?density=183").config.buildingDensity).toBe(180);
      expect(parseUrlState("?density=250").config.buildingDensity).toBe(250);
    });

    test("clamps airportCount to [1, 8]", () => {
      expect(parseUrlState("?airports=99").config.airportCount).toBe(8);
      expect(parseUrlState("?airports=0").config.airportCount).toBe(1);
      expect(parseUrlState("?airports=5").config.airportCount).toBe(5);
    });

    test("clamps camera zoom to [0.16, 3.5] and rounds coordinates", () => {
      const stateOver = parseUrlState("?cx=120.55&cy=75.04&z=99");
      expect(stateOver.camera).toEqual({
        cx: 120.6,
        cy: 75.0,
        zoom: 3.5,
      });

      const stateUnder = parseUrlState("?cx=120.5&cy=75.0&z=0.01");
      expect(stateUnder.camera?.zoom).toBe(0.16);
    });

    test("rejects partial or non-finite camera coordinates", () => {
      expect(parseUrlState("?cx=120.5").camera).toBeNull();
      expect(parseUrlState("?cx=120.5&cy=75.0").camera).toBeNull();
      expect(parseUrlState("?cy=75.0&z=1.5").camera).toBeNull();
      expect(parseUrlState("?cx=nan&cy=75.0&z=1.5").camera).toBeNull();
      expect(parseUrlState("?cx=120.5&cy=infinity&z=1.5").camera).toBeNull();
    });
  });

  describe("parseUrlState flags, enums and entities", () => {
    test("parses ramps flag", () => {
      expect(parseUrlState("?ramps=0").config.includeIntermediateRamps).toBe(
        false,
      );
      expect(
        parseUrlState("?ramps=false").config.includeIntermediateRamps,
      ).toBe(false);
      expect(parseUrlState("?ramps=1").config.includeIntermediateRamps).toBe(
        true,
      );
      expect(parseUrlState("?ramps=true").config.includeIntermediateRamps).toBe(
        true,
      );
    });

    test("parses drawer flag override", () => {
      expect(parseUrlState("?drawer=0", false).drawerOpen).toBe(false);
      expect(parseUrlState("?drawer=1", true).drawerOpen).toBe(true);
    });

    test("parses inspected entities across types", () => {
      expect(parseUrlState("?inspect=airport:2").inspected).toEqual({
        type: "airport",
        id: 2,
        entity: null,
      });
      expect(parseUrlState("?inspect=town:0").inspected).toEqual({
        type: "town",
        id: 0,
        entity: null,
      });
      expect(parseUrlState("?inspect=building:14").inspected).toEqual({
        type: "building",
        id: 14,
        entity: null,
      });
    });
  });

  describe("serializeUrlState canonical query generation", () => {
    test("serializes default state compactly with only seed by default", () => {
      const q = serializeUrlState({
        config: DEFAULT_GENERATOR_CONFIG,
        activeLayer: "aesthetic",
        simSpeed: 1,
        drawerOpen: true,
        camera: null,
        inspected: { type: null, id: null, entity: null },
      });
      expect(q).toBe(`?seed=${DEFAULT_GENERATOR_CONFIG.seed}`);
    });

    test("maintains deterministic key order", () => {
      const fullState = {
        config: {
          seed: "VALLEY-618",
          worldSize: "compact",
          archetype: "island-hopper",
          terrainAlgo: "quilez-erosion",
          hydrologyAlgo: "d8-strahler",
          airportMix: "dual-hub",
          includeIntermediateRamps: false,
          waterCoverage: 62,
          townCount: 16,
          buildingDensity: 180,
          airportCount: 5,
          windAxis: 2,
        },
        activeLayer: /** @type {const} */ ("rci"),
        simSpeed: 2.5,
        drawerOpen: false,
        camera: { cx: 120.5, cy: 75.0, zoom: 1.85 },
        inspected: { type: /** @type {const} */ ("town"), id: 0, entity: null },
      };

      const query = serializeUrlState(fullState);
      expect(query.startsWith("?seed=VALLEY-618")).toBe(true);

      // Verify deterministic key order:
      // seed -> size -> arch -> terrain -> hydro -> airMix -> ramps -> water -> towns -> density -> airports -> wind -> layer -> drawer -> cx -> cy -> z -> speed -> inspect
      const params = Array.from(new URLSearchParams(query.slice(1)).keys());
      expect(params).toEqual([
        "seed",
        "size",
        "arch",
        "terrain",
        "hydro",
        "airMix",
        "ramps",
        "water",
        "towns",
        "density",
        "airports",
        "wind",
        "layer",
        "drawer",
        "cx",
        "cy",
        "z",
        "speed",
        "inspect",
      ]);
    });

    test("supports serialize with omitDefaults: false", () => {
      const state = {
        config: DEFAULT_GENERATOR_CONFIG,
        activeLayer: /** @type {const} */ ("aesthetic"),
        simSpeed: 1,
        drawerOpen: true,
        camera: null,
        inspected: { type: null, id: null, entity: null },
      };
      const query = serializeUrlState(state, { omitDefaults: false });
      const params = new URLSearchParams(query.slice(1));
      expect(params.get("seed")).toBe(DEFAULT_GENERATOR_CONFIG.seed);
      expect(params.get("size")).toBe("standard");
      expect(params.get("arch")).toBe("confluence");
      expect(params.get("water")).toBe("48");
      expect(params.get("layer")).toBe("aesthetic");
    });
  });

  describe("Round-Trip Serialization Identity", () => {
    test("round-trips default state", () => {
      const original = parseUrlState("");
      const serialized = serializeUrlState(original);
      const restored = parseUrlState(serialized);

      expect(restored.config).toEqual(original.config);
      expect(restored.activeLayer).toBe(original.activeLayer);
      expect(restored.simSpeed).toBe(original.simSpeed);
      expect(restored.drawerOpen).toBe(original.drawerOpen);
      expect(restored.camera).toBeNull();
      expect(restored.inspected).toEqual(original.inspected);
    });

    test("round-trips comprehensive custom state across all 4 domains", () => {
      const fullState = {
        config: {
          seed: "VALLEY-618",
          worldSize: "compact",
          archetype: "island-hopper",
          terrainAlgo: "quilez-erosion",
          hydrologyAlgo: "d8-strahler",
          airportMix: "dual-hub",
          includeIntermediateRamps: false,
          waterCoverage: 62,
          townCount: 16,
          buildingDensity: 180,
          airportCount: 5,
          windAxis: 2,
        },
        activeLayer: /** @type {const} */ ("rci"),
        simSpeed: 2.5,
        drawerOpen: false,
        camera: { cx: 120.5, cy: 75.0, zoom: 1.85 },
        inspected: { type: /** @type {const} */ ("town"), id: 0, entity: null },
      };

      const serialized = serializeUrlState(fullState);
      const restored = parseUrlState(serialized);

      expect(restored.config).toEqual(fullState.config);
      expect(restored.activeLayer).toBe(fullState.activeLayer);
      expect(restored.simSpeed).toBe(fullState.simSpeed);
      expect(restored.drawerOpen).toBe(fullState.drawerOpen);
      expect(restored.camera).toEqual(fullState.camera);
      expect(restored.inspected.type).toBe(fullState.inspected.type);
      expect(restored.inspected.id).toBe(fullState.inspected.id);
    });

    test("round-trips airport and building inspected selections", () => {
      const airportState = {
        config: DEFAULT_GENERATOR_CONFIG,
        activeLayer: /** @type {const} */ ("aesthetic"),
        simSpeed: 1,
        drawerOpen: true,
        camera: null,
        inspected: {
          type: /** @type {const} */ ("airport"),
          id: 3,
          entity: null,
        },
      };
      const restoredAirport = parseUrlState(serializeUrlState(airportState));
      expect(restoredAirport.inspected.type).toBe("airport");
      expect(restoredAirport.inspected.id).toBe(3);

      const buildingState = {
        config: DEFAULT_GENERATOR_CONFIG,
        activeLayer: /** @type {const} */ ("aesthetic"),
        simSpeed: 1,
        drawerOpen: true,
        camera: null,
        inspected: {
          type: /** @type {const} */ ("building"),
          id: 42,
          entity: null,
        },
      };
      const restoredBuilding = parseUrlState(serializeUrlState(buildingState));
      expect(restoredBuilding.inspected.type).toBe("building");
      expect(restoredBuilding.inspected.id).toBe(42);
    });
  });
});
