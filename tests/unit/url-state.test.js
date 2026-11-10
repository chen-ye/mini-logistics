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
import {
  DEFAULT_GENERATOR_CONFIG,
  ARCHETYPE_PARAMETER_PRESETS,
} from "../../src/constants.js";

describe("URL State Pure Boundary Parser & Serializer", () => {
  test("Allowlists are frozen arrays with expected values", () => {
    expect(Object.isFrozen(VALID_WORLD_SIZES)).toBe(true);
    expect(Object.isFrozen(VALID_ARCHETYPES)).toBe(true);
    expect(VALID_ARCHETYPES).toEqual([
      "confluence",
      "inland",
      "alpine-passes",
      "fjord-sound",
      "isthmus-strait",
      "caldera-basin",
      "barrier-lagoon",
      "canyon-gorge",
      "island-hopper",
    ]);
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

    test("falls back legacy estuary and archipelago archetypes to confluence", () => {
      const stateEstuary = parseUrlState("?arch=estuary");
      expect(stateEstuary.config.archetype).toBe("confluence");
      expect(stateEstuary.config.terrainRelief).toBe(
        ARCHETYPE_PARAMETER_PRESETS.confluence.terrainRelief,
      );

      const stateArchipelago = parseUrlState("?arch=archipelago");
      expect(stateArchipelago.config.archetype).toBe("confluence");
      expect(stateArchipelago.config.coastalEmbayment).toBe(
        ARCHETYPE_PARAMETER_PRESETS.confluence.coastalEmbayment,
      );
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

    test("clamps geomorphology scalars to valid ranges", () => {
      // relief: [20, 200]
      expect(parseUrlState("?relief=999").config.terrainRelief).toBe(200);
      expect(parseUrlState("?relief=-10").config.terrainRelief).toBe(20);
      expect(parseUrlState("?relief=135").config.terrainRelief).toBe(135);
      expect(parseUrlState("?relief=invalid").config.terrainRelief).toBe(
        ARCHETYPE_PARAMETER_PRESETS.confluence.terrainRelief,
      );

      // incision: [0, 200]
      expect(parseUrlState("?incision=999").config.valleyIncision).toBe(200);
      expect(parseUrlState("?incision=-10").config.valleyIncision).toBe(0);
      expect(parseUrlState("?incision=85").config.valleyIncision).toBe(85);

      // indent: [0, 200]
      expect(parseUrlState("?indent=999").config.coastalEmbayment).toBe(200);
      expect(parseUrlState("?indent=-10").config.coastalEmbayment).toBe(0);
      expect(parseUrlState("?indent=140").config.coastalEmbayment).toBe(140);

      // caldera: [0, 200]
      expect(parseUrlState("?caldera=999").config.calderaCurvature).toBe(200);
      expect(parseUrlState("?caldera=-10").config.calderaCurvature).toBe(0);
      expect(parseUrlState("?caldera=75").config.calderaCurvature).toBe(75);

      // barrier: [0, 200]
      expect(parseUrlState("?barrier=999").config.barrierFragmentation).toBe(
        200,
      );
      expect(parseUrlState("?barrier=-10").config.barrierFragmentation).toBe(0);
      expect(parseUrlState("?barrier=160").config.barrierFragmentation).toBe(
        160,
      );

      // basins: [1, 6]
      expect(parseUrlState("?basins=99").config.basinCount).toBe(6);
      expect(parseUrlState("?basins=-5").config.basinCount).toBe(1);
      expect(parseUrlState("?basins=4").config.basinCount).toBe(4);
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
          terrainRelief: 180,
          valleyIncision: 140,
          coastalEmbayment: 65,
          calderaCurvature: 195,
          barrierFragmentation: 55,
          basinCount: 5,
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
      // seed -> size -> arch -> terrain -> hydro -> airMix -> ramps -> water -> towns -> density -> airports -> wind -> relief -> incision -> indent -> caldera -> barrier -> basins -> layer -> drawer -> cx -> cy -> z -> speed -> inspect
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
        "relief",
        "incision",
        "indent",
        "caldera",
        "barrier",
        "basins",
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
      expect(params.get("relief")).toBe("100");
      expect(params.get("incision")).toBe("40");
      expect(params.get("indent")).toBe("100");
      expect(params.get("caldera")).toBe("0");
      expect(params.get("barrier")).toBe("0");
      expect(params.get("basins")).toBe("2");
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
          terrainRelief: 180,
          valleyIncision: 140,
          coastalEmbayment: 65,
          calderaCurvature: 195,
          barrierFragmentation: 55,
          basinCount: 5,
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

  describe("Archetype Presets & Geomorphology Scalar Serialization", () => {
    test("hydrates canonical preset scalars for all 9 archetypes when omitted from URL", () => {
      for (const arch of VALID_ARCHETYPES) {
        const state = parseUrlState(`?arch=${arch}`);
        expect(state.config.archetype).toBe(arch);
        const preset = ARCHETYPE_PARAMETER_PRESETS[arch];
        expect(state.config.terrainRelief).toBe(preset.terrainRelief);
        expect(state.config.valleyIncision).toBe(preset.valleyIncision);
        expect(state.config.coastalEmbayment).toBe(preset.coastalEmbayment);
        expect(state.config.calderaCurvature).toBe(preset.calderaCurvature);
        expect(state.config.barrierFragmentation).toBe(
          preset.barrierFragmentation,
        );
        expect(state.config.basinCount).toBe(preset.basinCount);

        // When serialized with defaults omitted, matching preset scalars are omitted
        const query = serializeUrlState(state);
        const params = new URLSearchParams(query.slice(1));
        expect(params.has("relief")).toBe(false);
        expect(params.has("incision")).toBe(false);
        expect(params.has("indent")).toBe(false);
        expect(params.has("caldera")).toBe(false);
        expect(params.has("barrier")).toBe(false);
        expect(params.has("basins")).toBe(false);
      }
    });

    test("round-trips custom scalar overrides", () => {
      const customUrl =
        "?arch=caldera-basin&relief=180&incision=140&indent=65&caldera=195&barrier=55&basins=5";
      const customState = parseUrlState(customUrl);
      expect(customState.config.archetype).toBe("caldera-basin");
      expect(customState.config.terrainRelief).toBe(180);
      expect(customState.config.valleyIncision).toBe(140);
      expect(customState.config.coastalEmbayment).toBe(65);
      expect(customState.config.calderaCurvature).toBe(195);
      expect(customState.config.barrierFragmentation).toBe(55);
      expect(customState.config.basinCount).toBe(5);

      const serialized = serializeUrlState(customState);
      expect(serialized).toContain("arch=caldera-basin");
      expect(serialized).toContain("relief=180");
      expect(serialized).toContain("incision=140");
      expect(serialized).toContain("indent=65");
      expect(serialized).toContain("caldera=195");
      expect(serialized).toContain("barrier=55");
      expect(serialized).toContain("basins=5");

      const restored = parseUrlState(serialized);
      expect(restored.config.archetype).toBe("caldera-basin");
      expect(restored.config.terrainRelief).toBe(180);
      expect(restored.config.valleyIncision).toBe(140);
      expect(restored.config.coastalEmbayment).toBe(65);
      expect(restored.config.calderaCurvature).toBe(195);
      expect(restored.config.barrierFragmentation).toBe(55);
      expect(restored.config.basinCount).toBe(5);
    });
  });
});
