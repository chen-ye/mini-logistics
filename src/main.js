/**
 * @import {
 *   GeneratorConfig,
 *   InspectedEntity,
 *   ViewLayer
 * } from './types.js'
 */
/** @import { ProceduralLogisticsWorld } from './world-generator.js' */
import {
  createWorldPipeline,
  hydrateTransferredWorld,
} from "./world-generator.js";
import { LogisticsSimulator } from "./simulator.js";
import { MiniMotorwaysRenderer } from "./renderer.js";
import {
  createAppStore,
  deriveControlLabels,
  batch,
  shallowEqual,
} from "./state.js";
import {
  WORLD_SIZE_DEFAULTS,
  DEFAULT_GENERATOR_CONFIG,
  ARCHETYPE_PARAMETER_PRESETS,
} from "./constants.js";
import { mountEntityInspector } from "./inspector-component.js";
import { parseUrlState, serializeUrlState } from "./url-state.js";

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const getEl = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element #${id}`);
  return el;
};

/**
 * @param {string} id
 * @returns {HTMLInputElement}
 */
const getInput = (id) => /** @type {HTMLInputElement} */ (getEl(id));

/**
 * @param {string} id
 * @returns {HTMLSelectElement}
 */
const getSelect = (id) => /** @type {HTMLSelectElement} */ (getEl(id));

const canvas = /** @type {HTMLCanvasElement} */ (getEl("worldCanvas"));
const renderer = new MiniMotorwaysRenderer(canvas);
/** @type {ProceduralLogisticsWorld | null} */
let currentWorld = null;
/** @type {LogisticsSimulator | null} */
let simulator = null;
let simSpeed = 1;
const daysOfWeek = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const fallbackPipeline = createWorldPipeline();

window.renderer = renderer;
window.currentWorld = null;
window.simulator = null;

// Off-Thread World Worker Pipeline (`world-worker.js` Stages 1–9 -> `VectorLayerRecorder` Path2D Display Lists)
/** @type {Worker | null} */
let worldWorker = null;
let workerBusy = false;
let nextRequestId = 1;
/** @type {{ requestId: number, config: GeneratorConfig, preserveCamera: boolean, preserveUrlHydration: boolean, resolvers: Array<(w: ProceduralLogisticsWorld) => void> } | null} */
let pendingJob = null;
/** @type {Map<number, Array<(w: ProceduralLogisticsWorld) => void>>} */
const inflightResolvers = new Map();

function initWorldWorker() {
  if (typeof Worker === "undefined") return null;
  try {
    const worker = new Worker(new URL("./world-worker.js", import.meta.url), {
      type: "module",
    });

    worker.addEventListener("message", async (event) => {
      const {
        requestId,
        preserveCamera,
        preserveUrlHydration,
        world: rawWorld,
      } = event.data;
      const resolveList = inflightResolvers.get(requestId) || [];
      inflightResolvers.delete(requestId);

      // If a newer slider/seed request arrived while this worker job was running,
      // immediately dispatch the newest coalesced job!
      if (pendingJob) {
        const next = pendingJob;
        pendingJob = null;
        dispatchToWorker(next);
      } else {
        workerBusy = false;
      }

      const world = hydrateTransferredWorld(rawWorld);
      await applyGeneratedWorld(
        world,
        preserveCamera,
        true,
        preserveUrlHydration,
      );
      for (const r of resolveList) r(world);
    });
    worker.addEventListener("error", (err) => {
      console.error("World Worker error, falling back to main thread:", err);
      workerBusy = false;
    });
    return worker;
  } catch (err) {
    console.warn("Could not initialize module Worker:", err);
    return null;
  }
}

worldWorker = initWorldWorker();

/**
 * @param {{
 *   requestId: number,
 *   config: GeneratorConfig,
 *   preserveCamera: boolean,
 *   preserveUrlHydration: boolean,
 *   resolvers: Array<(w: ProceduralLogisticsWorld) => void>,
 * }} job
 */
function dispatchToWorker(job) {
  if (!worldWorker) return;
  workerBusy = true;
  inflightResolvers.set(job.requestId, job.resolvers);
  worldWorker.postMessage({
    requestId: job.requestId,
    config: job.config,
    preserveCamera: job.preserveCamera,
    preserveUrlHydration: job.preserveUrlHydration,
  });
}

const isInitialMobile =
  typeof window !== "undefined" && window.innerWidth < 768;
const initialUrlState =
  typeof window !== "undefined"
    ? parseUrlState(window.location.search, isInitialMobile)
    : parseUrlState("", false);

// Signal-grade immutable store holding app state
const store = createAppStore(initialUrlState.config, {
  activeLayer: initialUrlState.activeLayer,
  simSpeed: initialUrlState.simSpeed,
  drawerOpen: initialUrlState.drawerOpen,
  camera: initialUrlState.camera,
  inspected: initialUrlState.inspected,
});

renderer.activeLayer = store.getState().activeLayer;
renderer.drawerOpen = store.getState().drawerOpen;
simSpeed = store.getState().simSpeed;

let isRestoringFromHistory = false;

/**
 * Updates URL history state with canonical serialized query string.
 *
 * @param {boolean} [push=false]
 */
function updateUrl(push = false) {
  if (isRestoringFromHistory) return;
  if (typeof window === "undefined" || !window.history) return;

  const isMobile = window.innerWidth < 768;
  const currentQuery = serializeUrlState(store.getState(), {
    isMobileViewport: isMobile,
  });
  const nextUrl = currentQuery
    ? `${window.location.pathname}${currentQuery}`
    : window.location.pathname;

  const currentFull = `${window.location.pathname}${window.location.search}`;
  if (currentFull === nextUrl) return;

  if (push) {
    window.history.pushState(null, "", nextUrl);
  } else {
    window.history.replaceState(null, "", nextUrl);
  }
}

/**
 * Converts renderer camera to world-tile coordinates and syncs to store and URL.
 */
function syncStoreCameraFromRenderer() {
  if (!currentWorld || !canvas) return;
  const ts = currentWorld.tileSize;
  const z = renderer.camera.zoom;
  const cx = (canvas.width * 0.5 - renderer.camera.x) / (z * ts);
  const cy = (canvas.height * 0.5 - renderer.camera.y) / (z * ts);
  store.setCamera({ cx, cy, zoom: z });
  updateUrl(false);
}

/**
 * @param {ProceduralLogisticsWorld} world
 * @param {boolean} [preserveCamera]
 * @param {boolean} [fromWorker=false]
 * @param {boolean} [preserveUrlHydration=false]
 */
async function applyGeneratedWorld(
  world,
  preserveCamera,
  fromWorker = false,
  preserveUrlHydration = false,
) {
  renderer.prepareDisplayLists(world);
  currentWorld = world;
  simulator = new LogisticsSimulator(world);
  window.currentWorld = currentWorld;
  window.simulator = simulator;

  const storeCamera = store.getState().camera;
  if (preserveUrlHydration && storeCamera) {
    renderer.camera.zoom = storeCamera.zoom;
    renderer.camera.x =
      canvas.width * 0.5 - storeCamera.cx * storeCamera.zoom * world.tileSize;
    renderer.camera.y =
      canvas.height * 0.5 - storeCamera.cy * storeCamera.zoom * world.tileSize;
  } else if (!preserveCamera) {
    renderer.fitCamera(world);
  }

  const inspectedState = store.getState().inspected;
  if (
    preserveUrlHydration &&
    inspectedState.type &&
    inspectedState.id != null
  ) {
    /** @type {InspectedEntity | null} */
    let entity = null;
    if (inspectedState.type === "airport") {
      entity =
        world.airports.find((a) => a.id === inspectedState.id) ||
        world.airports[inspectedState.id] ||
        null;
    } else if (inspectedState.type === "town") {
      entity =
        world.towns.find((t) => t.id === inspectedState.id) ||
        world.towns[inspectedState.id] ||
        null;
    } else if (inspectedState.type === "building") {
      entity =
        world.destinations.find((d) => d.id === inspectedState.id) || null;
    }

    if (entity) {
      const shouldFocus = storeCamera === null;
      openEntityInspector(inspectedState.type, entity, shouldFocus, false);
    } else {
      renderer.selectedEntity = null;
      store.setInspected(null, null);
    }
  } else if (!preserveCamera) {
    renderer.selectedEntity = null;
    store.setInspected(null, null);
  }

  updateTelemetryUI(world, fromWorker);
}

/**
 * Populates DOM controls and labels from the generator configuration.
 *
 * @param {Partial<GeneratorConfig>} cfg
 */
export function syncDomInputsFromConfig(cfg) {
  const seedInput = getInput("seedInput");
  const seedVal = cfg.seed || DEFAULT_GENERATOR_CONFIG.seed;
  if (seedInput && seedInput.value !== seedVal) {
    seedInput.value = seedVal;
  }
  const worldSizeSelect = getSelect("worldSizeSelect");
  const sizeVal = cfg.worldSize || DEFAULT_GENERATOR_CONFIG.worldSize;
  if (worldSizeSelect && worldSizeSelect.value !== sizeVal) {
    worldSizeSelect.value = sizeVal;
  }
  const archetypeSelect = getSelect("archetypeSelect");
  const archVal = cfg.archetype || DEFAULT_GENERATOR_CONFIG.archetype;
  if (archetypeSelect && archetypeSelect.value !== archVal) {
    archetypeSelect.value = archVal;
  }
  const terrainAlgoSelect = getSelect("terrainAlgoSelect");
  const terrainVal = cfg.terrainAlgo || DEFAULT_GENERATOR_CONFIG.terrainAlgo;
  if (terrainAlgoSelect && terrainAlgoSelect.value !== terrainVal) {
    terrainAlgoSelect.value = terrainVal;
  }
  const hydrologyAlgoSelect = getSelect("hydrologyAlgoSelect");
  const hydroVal = cfg.hydrologyAlgo || DEFAULT_GENERATOR_CONFIG.hydrologyAlgo;
  if (hydrologyAlgoSelect && hydrologyAlgoSelect.value !== hydroVal) {
    hydrologyAlgoSelect.value = hydroVal;
  }
  const airportMixSelect = getSelect("airportMixSelect");
  const airMixVal = cfg.airportMix || DEFAULT_GENERATOR_CONFIG.airportMix;
  if (airportMixSelect && airportMixSelect.value !== airMixVal) {
    airportMixSelect.value = airMixVal;
  }
  const toggleInterRamps = getInput("toggleInterRamps");
  const rampsVal =
    cfg.includeIntermediateRamps ??
    DEFAULT_GENERATOR_CONFIG.includeIntermediateRamps;
  if (toggleInterRamps && toggleInterRamps.checked !== rampsVal) {
    toggleInterRamps.checked = rampsVal;
  }
  const sliderWater = getInput("sliderWater");
  const waterVal = cfg.waterCoverage ?? DEFAULT_GENERATOR_CONFIG.waterCoverage;
  if (sliderWater && parseInt(sliderWater.value, 10) !== waterVal) {
    sliderWater.value = String(waterVal);
  }
  const sliderTowns = getInput("sliderTowns");
  const townsVal = cfg.townCount ?? DEFAULT_GENERATOR_CONFIG.townCount;
  if (sliderTowns && parseInt(sliderTowns.value, 10) !== townsVal) {
    sliderTowns.value = String(townsVal);
  }
  const sliderDensity = getInput("sliderDensity");
  const densityVal =
    cfg.buildingDensity ?? DEFAULT_GENERATOR_CONFIG.buildingDensity;
  if (sliderDensity && parseInt(sliderDensity.value, 10) !== densityVal) {
    sliderDensity.value = String(densityVal);
  }
  const sliderAirports = getInput("sliderAirports");
  const airportsVal = cfg.airportCount ?? DEFAULT_GENERATOR_CONFIG.airportCount;
  if (sliderAirports && parseInt(sliderAirports.value, 10) !== airportsVal) {
    sliderAirports.value = String(airportsVal);
  }
  const sliderWind = getInput("sliderWind");
  const windVal = cfg.windAxis ?? DEFAULT_GENERATOR_CONFIG.windAxis;
  if (sliderWind && parseInt(sliderWind.value, 10) !== windVal) {
    sliderWind.value = String(windVal);
  }

  const archKey = cfg.archetype || DEFAULT_GENERATOR_CONFIG.archetype;
  const archPreset =
    ARCHETYPE_PARAMETER_PRESETS[archKey] ||
    ARCHETYPE_PARAMETER_PRESETS.confluence;
  const reliefVal = cfg.terrainRelief ?? archPreset.terrainRelief;
  const incisionVal = cfg.valleyIncision ?? archPreset.valleyIncision;
  const embaymentVal = cfg.coastalEmbayment ?? archPreset.coastalEmbayment;
  const calderaVal = cfg.calderaCurvature ?? archPreset.calderaCurvature;
  const barrierVal =
    cfg.barrierFragmentation ?? archPreset.barrierFragmentation;
  const basinsVal = cfg.basinCount ?? archPreset.basinCount;

  const sliderRelief = getInput("sliderRelief");
  if (sliderRelief && parseInt(sliderRelief.value, 10) !== reliefVal) {
    sliderRelief.value = String(reliefVal);
  }
  const sliderIncision = getInput("sliderIncision");
  if (sliderIncision && parseInt(sliderIncision.value, 10) !== incisionVal) {
    sliderIncision.value = String(incisionVal);
  }
  const sliderEmbayment = getInput("sliderEmbayment");
  if (sliderEmbayment && parseInt(sliderEmbayment.value, 10) !== embaymentVal) {
    sliderEmbayment.value = String(embaymentVal);
  }
  const sliderCaldera = getInput("sliderCaldera");
  if (sliderCaldera && parseInt(sliderCaldera.value, 10) !== calderaVal) {
    sliderCaldera.value = String(calderaVal);
  }
  const sliderBarrier = getInput("sliderBarrier");
  if (sliderBarrier && parseInt(sliderBarrier.value, 10) !== barrierVal) {
    sliderBarrier.value = String(barrierVal);
  }
  const sliderBasins = getInput("sliderBasins");
  if (sliderBasins && parseInt(sliderBasins.value, 10) !== basinsVal) {
    sliderBasins.value = String(basinsVal);
  }

  updateAirportSliderLabel();
  syncGeomorphologyLabelsUI(cfg, deriveControlLabels(cfg));
}

/**
 * Returns generator configuration from the immutable store.
 *
 * @returns {GeneratorConfig}
 */
export function getGeneratorConfig() {
  return store.getState().config;
}

/**
 * Updates airport slider label directly, maintaining backwards compatibility.
 */
export function updateAirportSliderLabel() {
  const cfg = store.getState().config;
  const labels = deriveControlLabels(cfg);
  const el = getEl("valAirports");
  if (el) el.textContent = labels.airportsLabel;
}

/**
 * Synchronizes the 6 geomorphology scalar readouts, modified colors, preset badge, and reset button.
 *
 * @param {Partial<GeneratorConfig>} cfg
 * @param {import('./types.js').ControlLabels} labels
 */
function syncGeomorphologyLabelsUI(cfg, labels) {
  const archKey = cfg.archetype || DEFAULT_GENERATOR_CONFIG.archetype;
  const preset =
    ARCHETYPE_PARAMETER_PRESETS[archKey] ||
    ARCHETYPE_PARAMETER_PRESETS.confluence;

  /**
   * @param {string} id
   * @param {string | undefined} text
   * @param {boolean} isModified
   */
  const updateScalarReadout = (id, text, isModified) => {
    const el = document.getElementById(id);
    if (!el || !text) return;
    el.textContent = text;
    el.style.color = isModified ? "#d94376" : "";
  };

  const r = cfg.terrainRelief ?? preset.terrainRelief;
  const inc = cfg.valleyIncision ?? preset.valleyIncision;
  const emb = cfg.coastalEmbayment ?? preset.coastalEmbayment;
  const cal = cfg.calderaCurvature ?? preset.calderaCurvature;
  const bar = cfg.barrierFragmentation ?? preset.barrierFragmentation;
  const bas = cfg.basinCount ?? preset.basinCount;

  updateScalarReadout(
    "valRelief",
    labels.reliefLabel || `${r}%`,
    r !== preset.terrainRelief,
  );
  updateScalarReadout(
    "valIncision",
    labels.incisionLabel || `${inc}%`,
    inc !== preset.valleyIncision,
  );
  updateScalarReadout(
    "valEmbayment",
    labels.embaymentLabel || `${emb}%`,
    emb !== preset.coastalEmbayment,
  );
  updateScalarReadout(
    "valCaldera",
    labels.calderaLabel || `${cal}%`,
    cal !== preset.calderaCurvature,
  );
  updateScalarReadout(
    "valBarrier",
    labels.barrierLabel || `${bar}%`,
    bar !== preset.barrierFragmentation,
  );
  updateScalarReadout(
    "valBasins",
    labels.basinsLabel || `${bas}`,
    bas !== preset.basinCount,
  );

  const geoPresetBadge = document.getElementById("geoPresetBadge");
  const resetGeoScalarsBtn = document.getElementById("resetGeoScalarsBtn");
  const modCount = labels.geoModifiedCount ?? 0;
  if (modCount > 0) {
    if (geoPresetBadge) {
      geoPresetBadge.textContent = `${modCount} Mod`;
      geoPresetBadge.className =
        "text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[#e85c90]/15 text-[#d94376]";
    }
    if (resetGeoScalarsBtn) {
      resetGeoScalarsBtn.classList.remove("hidden");
    }
  } else {
    if (geoPresetBadge) {
      geoPresetBadge.textContent = "Preset";
      geoPresetBadge.className =
        "text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-stone-200/80 text-stone-600";
    }
    if (resetGeoScalarsBtn) {
      resetGeoScalarsBtn.classList.add("hidden");
    }
  }
}

// Subscribe generator control labels to store config updates
store.subscribe(
  (s) => deriveControlLabels(s.config),
  (labels) => {
    const valWater = getEl("valWater");
    if (valWater) valWater.textContent = labels.waterLabel;
    const valTowns = getEl("valTowns");
    if (valTowns) valTowns.textContent = labels.townsLabel;
    const valDensity = getEl("valDensity");
    if (valDensity) valDensity.textContent = labels.densityLabel;
    const valAirports = getEl("valAirports");
    if (valAirports) valAirports.textContent = labels.airportsLabel;
    const valWind = getEl("valWind");
    if (valWind) valWind.textContent = labels.windLabel;

    syncGeomorphologyLabelsUI(store.getState().config, labels);
  },
  shallowEqual,
);

// Subscribe active view layer to store
store.subscribe(
  (s) => s.activeLayer,
  (layer) => {
    renderer.activeLayer = layer;
    document.querySelectorAll(".layer-btn").forEach((b) => {
      const btn = /** @type {HTMLElement} */ (b);
      const isActive = btn.dataset.layer === layer;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });
  },
);

// Subscribe simulation speed to store
store.subscribe(
  (s) => s.simSpeed,
  (speed) => {
    simSpeed = speed;
    document.querySelectorAll(".speed-btn").forEach((el) => {
      const btn = /** @type {HTMLElement} */ (el);
      const isActive = parseFloat(btn.dataset.speed || "1") === speed;
      btn.classList.toggle("bg-[#36383e]", isActive);
      btn.classList.toggle("text-[#f2efe9]", isActive);
      btn.classList.toggle("text-stone-500", !isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });
  },
);

// Subscribe generator drawer open/closed state to store
store.subscribe(
  (s) => s.drawerOpen,
  (open) => {
    renderer.drawerOpen = open;
    const drawer = document.getElementById("generatorDrawer");
    if (drawer) {
      drawer.classList.toggle("hidden", !open);
      drawer.toggleAttribute("inert", !open);
    }
    const toggleBtn = document.getElementById("toggleDrawerBtn");
    if (toggleBtn) {
      toggleBtn.setAttribute("aria-expanded", String(open));
    }
  },
);

/**
 * @param {boolean} [preserveCamera]
 * @param {boolean} [preserveUrlHydration=false]
 * @returns {Promise<ProceduralLogisticsWorld | void>}
 */
export function rebuildWorld(
  preserveCamera = false,
  preserveUrlHydration = false,
) {
  // Update UI synchronously for immediate visual feedback (INP best practice)
  updateAirportSliderLabel();
  const badgeEl = document.getElementById("genTimeBadge");
  if (badgeEl) badgeEl.textContent = "Worker…";

  const cfg = getGeneratorConfig();

  if (worldWorker) {
    return new Promise((resolve) => {
      if (!workerBusy) {
        const requestId = nextRequestId++;
        dispatchToWorker({
          requestId,
          config: cfg,
          preserveCamera,
          preserveUrlHydration,
          resolvers: [resolve],
        });
      } else {
        if (pendingJob) {
          pendingJob.config = cfg;
          pendingJob.preserveCamera =
            pendingJob.preserveCamera && preserveCamera;
          pendingJob.preserveUrlHydration =
            pendingJob.preserveUrlHydration || preserveUrlHydration;
          pendingJob.resolvers.push(resolve);
        } else {
          pendingJob = {
            requestId: nextRequestId++,
            config: cfg,
            preserveCamera,
            preserveUrlHydration,
            resolvers: [resolve],
          };
        }
      }
    });
  }

  // Fallback if Worker is unavailable
  const world = fallbackPipeline(cfg);
  return applyGeneratedWorld(
    world,
    preserveCamera,
    false,
    preserveUrlHydration,
  );
}

window.rebuildWorld = rebuildWorld;

function updateTelemetryUI(world, fromWorker = false) {
  const gridLabelEl = document.getElementById("telemetryGridLabel");
  if (gridLabelEl) {
    gridLabelEl.textContent = `State Telemetry (${world.W}×${world.H} Grid)`;
  }
  const displayMs = world.wallTimeMs ?? world.genTimeMs;
  const cacheSuffix =
    world.reusedThroughStage > 0
      ? ` · Cached S1–S${world.reusedThroughStage}`
      : fromWorker
        ? " · 2W Parallel"
        : "";
  getEl("genTimeBadge").textContent = `${displayMs} ms${cacheSuffix}`;
  getEl("statPop").textContent = String(
    world.houses.length + world.destinations.length,
  );
  const hubs = world.airports.filter((a) => a.airportClass === "HUB").length;
  const others = world.airports.length - hubs;
  getEl("statAirports").textContent = `${hubs} Hub · ${others} Reg`;
  const clovers = world.interchanges.filter(
    (i) => i.type === "cloverleaf" || i.type === "trumpet",
  ).length;
  const ramps = world.interchanges.filter(
    (i) => i.type === "diamond-ramp",
  ).length;
  getEl("statBridges").textContent = `${clovers} Sys · ${ramps} Ramp`;

  const logEl = getEl("pipelineLog");
  logEl.innerHTML = world.logs
    .map(
      (l) =>
        `<div class="flex items-start gap-1.5"><span class="text-pink-600 font-bold">•</span><span>${l}</span></div>`,
    )
    .join("");
}

/**
 * Centers and zooms the camera on a selected entity.
 *
 * @param {string | null} type
 * @param {InspectedEntity | null} entity
 */
function focusCameraOnEntity(type, entity) {
  if (!currentWorld || !entity) return;
  const ts = currentWorld.tileSize;
  const targetZoom = type === "town" ? 1.45 : type === "airport" ? 1.65 : 2.15;
  renderer.camera.zoom = targetZoom;
  // Offset slightly upward on mobile so the bottom sheet doesn't cover the entity
  const yBias =
    window.innerWidth < 640 ? canvas.height * 0.36 : canvas.height * 0.5;
  const xBias =
    window.innerWidth >= 640 ? canvas.width * 0.46 : canvas.width * 0.5;
  renderer.camera.x = xBias - (entity.x + 0.5) * ts * targetZoom;
  renderer.camera.y = yBias - (entity.y + 0.5) * ts * targetZoom;
}

/**
 * Opens the entity inspector dossier and optionally focuses the camera.
 *
 * @param {string} type
 * @param {InspectedEntity} entity
 * @param {boolean} [shouldFocus]
 * @param {boolean} [pushHistory=true]
 */
export function openEntityInspector(
  type,
  entity,
  shouldFocus = false,
  pushHistory = true,
) {
  const normalizedType = type === "resource" ? "building" : type;
  renderer.selectedEntity = entity;
  store.setInspected(normalizedType, entity);
  if (shouldFocus) {
    focusCameraOnEntity(normalizedType, entity);
    syncStoreCameraFromRenderer();
  }
  updateUrl(pushHistory);
}

window.openEntityInspector = openEntityInspector;

// Mount the custom Light-DOM entity inspector element
const inspectorCard = document.getElementById("inspectorCard");
/** @type {import("./inspector-component.js").EntityInspectorElement | null} */
let inspectorElement = null;
if (inspectorCard) {
  inspectorElement = mountEntityInspector(inspectorCard, {
    store,
    getWorld: () => currentWorld,
    onFocus: (type, entity) => {
      focusCameraOnEntity(type, entity);
      syncStoreCameraFromRenderer();
    },
    onSelectEntity: (type, entity, shouldFocus) => {
      openEntityInspector(type, entity, shouldFocus, true);
    },
    onClose: () => {
      renderer.selectedEntity = null;
      store.setInspected(null, null);
      updateUrl(false);
      canvas.focus({ preventScroll: true });
    },
  });
}

function findEntityAtWorldPos(wx, wy, touchPad = 0) {
  if (!currentWorld) return null;

  // 1. Check Airports (using rotated apron bounding box so circular halos don't swallow nearby buildings)
  for (const ap of currentWorld.airports) {
    const dx = wx - ap.x;
    const dy = wy - ap.y;
    const cosA = Math.cos(-(ap.angleRad || 0));
    const sinA = Math.sin(-(ap.angleRad || 0));
    const lx = dx * cosA - dy * sinA;
    const ly = dx * sinA + dy * cosA;
    if (
      Math.abs(lx) <= ap.halfLen + 1.4 + touchPad &&
      Math.abs(ly) <= ap.halfWid + 1.8 + touchPad
    ) {
      return { type: "airport", entity: ap };
    }
  }

  // 2. Check All Industrial & Commercial Buildings (`currentWorld.destinations`) — highest specificity!
  /** @type {import('./types.js').Destination | null} */
  let bestBuilding = null;
  let bestBldDist = Infinity;
  const bldPad = 0.65 + touchPad * 0.65;
  for (const d of currentWorld.destinations) {
    const wT = d.wTiles || 2;
    const hT = d.hTiles || 2;
    if (
      wx >= d.gx - bldPad &&
      wx <= d.gx + wT + bldPad &&
      wy >= d.gy - bldPad &&
      wy <= d.gy + hT + bldPad
    ) {
      const dist = Math.hypot(wx - (d.x + 0.5), wy - (d.y + 0.5));
      if (dist < bestBldDist) {
        bestBldDist = dist;
        bestBuilding = d;
      }
    }
  }
  if (bestBuilding) {
    return { type: "building", entity: bestBuilding };
  }

  // 3. Check Sprawling Farm Field Estates (`d.bspParcels`) so clicking a farm's crop fields also selects the farm
  for (const d of currentWorld.destinations) {
    if (d.resourceType !== "FARM" || !d.bspParcels) continue;
    const bb = d.estateBBox;
    if (bb && (wx < bb.minX || wx > bb.maxX || wy < bb.minY || wy > bb.maxY)) {
      continue;
    }
    for (const p of d.bspParcels) {
      if (wx >= p.x0 && wx <= p.x1 && wy >= p.y0 && wy <= p.y1) {
        return { type: "building", entity: d };
      }
    }
  }

  // 4. Check Municipalities (`currentWorld.towns`)
  for (const t of currentWorld.towns) {
    if (Math.hypot(wx - t.x, wy - t.y) <= t.urbanRadius + touchPad) {
      return { type: "town", entity: t };
    }
  }

  return null;
}

function handleResize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  if (currentWorld) {
    const storeCam = store.getState().camera;
    if (storeCam) {
      renderer.camera.zoom = storeCam.zoom;
      renderer.camera.x =
        canvas.width * 0.5 -
        storeCam.cx * storeCam.zoom * currentWorld.tileSize;
      renderer.camera.y =
        canvas.height * 0.5 -
        storeCam.cy * storeCam.zoom * currentWorld.tileSize;
    } else {
      renderer.fitCamera(currentWorld);
    }
  }
}
window.addEventListener("resize", handleResize);

function zoomAroundPoint(factor, centerX, centerY) {
  const newZoom = Math.max(0.16, Math.min(3.5, renderer.camera.zoom * factor));
  renderer.camera.x =
    centerX - (centerX - renderer.camera.x) * (newZoom / renderer.camera.zoom);
  renderer.camera.y =
    centerY - (centerY - renderer.camera.y) * (newZoom / renderer.camera.zoom);
  renderer.camera.zoom = newZoom;
}

// Multi-Touch Pinch-to-Zoom, Pan & Tap Inspection on Canvas
const activePointers = new Map();
let isDragging = false;
let hadMultiTouch = false;
let dragStart = { x: 0, y: 0 };
let pointerDownPos = { x: 0, y: 0 };
let lastPinchDist = 0;
let lastPinchMid = { x: 0, y: 0 };
let lastTapTime = 0;
let lastCursor = "";

function getTwoPointerMetrics() {
  const pts = Array.from(activePointers.values());
  const dx = pts[1].x - pts[0].x;
  const dy = pts[1].y - pts[0].y;
  return {
    dist: Math.hypot(dx, dy) || 1,
    midX: (pts[0].x + pts[1].x) * 0.5,
    midY: (pts[0].y + pts[1].y) * 0.5,
  };
}

canvas.addEventListener("pointerdown", (e) => {
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {}

  if (activePointers.size === 1) {
    isDragging = true;
    hadMultiTouch = false;
    dragStart.x = e.clientX - renderer.camera.x;
    dragStart.y = e.clientY - renderer.camera.y;
    pointerDownPos = { x: e.clientX, y: e.clientY };
  } else if (activePointers.size === 2) {
    hadMultiTouch = true;
    const m = getTwoPointerMetrics();
    lastPinchDist = m.dist;
    lastPinchMid = { x: m.midX, y: m.midY };
  }
});

window.addEventListener("pointermove", (e) => {
  if (!activePointers.has(e.pointerId)) {
    if (currentWorld && e.target === canvas) {
      const wx =
        (e.clientX - renderer.camera.x) /
        (renderer.camera.zoom * currentWorld.tileSize);
      const wy =
        (e.clientY - renderer.camera.y) /
        (renderer.camera.zoom * currentWorld.tileSize);
      const hit = findEntityAtWorldPos(wx, wy, 0);
      const nextCursor = hit ? "pointer" : "grab";
      if (nextCursor !== lastCursor) {
        canvas.style.cursor = nextCursor;
        lastCursor = nextCursor;
      }
    }
    return;
  }
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 2) {
    const m = getTwoPointerMetrics();
    const scaleFactor = m.dist / (lastPinchDist || m.dist);
    const newZoom = Math.max(
      0.16,
      Math.min(3.5, renderer.camera.zoom * scaleFactor),
    );
    renderer.camera.x =
      m.midX -
      (lastPinchMid.x - renderer.camera.x) * (newZoom / renderer.camera.zoom);
    renderer.camera.y =
      m.midY -
      (lastPinchMid.y - renderer.camera.y) * (newZoom / renderer.camera.zoom);
    renderer.camera.zoom = newZoom;
    lastPinchDist = m.dist;
    lastPinchMid = { x: m.midX, y: m.midY };
  } else if (activePointers.size === 1 && isDragging) {
    const pt = activePointers.values().next().value;
    renderer.camera.x = pt.x - dragStart.x;
    renderer.camera.y = pt.y - dragStart.y;
  }
});

function handlePointerEnd(e) {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.delete(e.pointerId);

  if (activePointers.size === 1) {
    const remaining = activePointers.values().next().value;
    dragStart.x = remaining.x - renderer.camera.x;
    dragStart.y = remaining.y - renderer.camera.y;
    return;
  }

  if (activePointers.size === 0) {
    const wasDragging = isDragging;
    const wasMultiTouch = hadMultiTouch;
    isDragging = false;
    hadMultiTouch = false;

    if (wasMultiTouch) {
      syncStoreCameraFromRenderer();
      return;
    }

    if (wasDragging) {
      const tapThreshold = e.pointerType === "touch" ? 12 : 6;
      const moveDist = Math.hypot(
        e.clientX - pointerDownPos.x,
        e.clientY - pointerDownPos.y,
      );

      if (moveDist >= tapThreshold) {
        syncStoreCameraFromRenderer();
        return;
      }

      if (currentWorld) {
        const wx =
          (e.clientX - renderer.camera.x) /
          (renderer.camera.zoom * currentWorld.tileSize);
        const wy =
          (e.clientY - renderer.camera.y) /
          (renderer.camera.zoom * currentWorld.tileSize);
        const touchPad = e.pointerType === "touch" ? 2.2 : 0;

        const hit = findEntityAtWorldPos(wx, wy, touchPad);
        if (hit) {
          if (window.innerWidth < 640) {
            store.setDrawerOpen(false);
          }
          openEntityInspector(hit.type, hit.entity, false, true);
          return;
        }

        const now = performance.now();
        if (e.pointerType === "touch" && now - lastTapTime < 300) {
          zoomAroundPoint(1.35, e.clientX, e.clientY);
          lastTapTime = 0;
          syncStoreCameraFromRenderer();
          return;
        }
        lastTapTime = now;

        renderer.selectedEntity = null;
        store.setInspected(null, null);
        updateUrl(false);
        if (window.innerWidth < 640) {
          store.setDrawerOpen(false);
        }
      }
    }
  }
}

window.addEventListener("pointerup", handlePointerEnd);
window.addEventListener("pointercancel", handlePointerEnd);

/** @type {ReturnType<typeof setTimeout> | null} */
let wheelEndTimer = null;

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();

    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      // DOM_DELTA_LINE: lines to pixels (standard mouse wheel notch is 3 lines)
      dy *= 28;
    } else if (e.deltaMode === 2) {
      // DOM_DELTA_PAGE
      dy *= window.innerHeight;
    }

    if (!Number.isFinite(dy) || Math.abs(dy) < 0.001) return;

    // Clamp per-event delta to prevent extreme leaps on fast trackpad flicks or erratic wheel drivers
    const clampedDy = Math.max(-120, Math.min(120, dy));
    // Proportional exponential zoom: smooth and controlled across trackpads and notched wheels alike
    const zoomFactor = Math.exp(-clampedDy * 0.0008);
    zoomAroundPoint(zoomFactor, e.clientX, e.clientY);

    if (wheelEndTimer) clearTimeout(wheelEndTimer);
    wheelEndTimer = setTimeout(() => {
      syncStoreCameraFromRenderer();
    }, 150);
  },
  { passive: false },
);

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    renderer.selectedEntity = null;
    store.setInspected(null, null);
    updateUrl(false);
    return;
  }
  if (document.activeElement && document.activeElement.tagName === "INPUT") {
    return;
  }
  const panStep = 40;
  let didPanOrZoom = false;
  if (e.key === "ArrowLeft") {
    renderer.camera.x += panStep;
    didPanOrZoom = true;
  } else if (e.key === "ArrowRight") {
    renderer.camera.x -= panStep;
    didPanOrZoom = true;
  } else if (e.key === "ArrowUp") {
    renderer.camera.y += panStep;
    didPanOrZoom = true;
  } else if (e.key === "ArrowDown") {
    renderer.camera.y -= panStep;
    didPanOrZoom = true;
  } else if (e.key === "+" || e.key === "=") {
    zoomAroundPoint(1.18, canvas.width * 0.5, canvas.height * 0.5);
    didPanOrZoom = true;
  } else if (e.key === "-") {
    zoomAroundPoint(0.84, canvas.width * 0.5, canvas.height * 0.5);
    didPanOrZoom = true;
  }
  if (didPanOrZoom) {
    syncStoreCameraFromRenderer();
  }
});

// UI Control Bindings
document.getElementById("toggleDrawerBtn")?.addEventListener("click", () => {
  const nextOpen = !store.getState().drawerOpen;
  store.setDrawerOpen(nextOpen);
  updateUrl(false);
  if (nextOpen && window.innerWidth < 640) {
    store.setInspected(null, null);
  }
});

document
  .getElementById("closeDrawerMobileBtn")
  ?.addEventListener("click", () => {
    store.setDrawerOpen(false);
    updateUrl(false);
  });

document.getElementById("resetViewBtn")?.addEventListener("click", () => {
  if (currentWorld) renderer.fitCamera(currentWorld);
  store.setCamera(null);
  updateUrl(false);
  if (window.innerWidth < 640) {
    store.setDrawerOpen(false);
  }
});

document.getElementById("zoomInBtn")?.addEventListener("click", () => {
  zoomAroundPoint(1.25, canvas.width * 0.5, canvas.height * 0.5);
  syncStoreCameraFromRenderer();
});

document.getElementById("zoomOutBtn")?.addEventListener("click", () => {
  zoomAroundPoint(0.8, canvas.width * 0.5, canvas.height * 0.5);
  syncStoreCameraFromRenderer();
});

document.getElementById("hudFitBtn")?.addEventListener("click", () => {
  if (currentWorld) renderer.fitCamera(currentWorld);
  store.setCamera(null);
  updateUrl(false);
});

getEl("randomSeedBtn")?.addEventListener("click", () => {
  const prefixes = ["METRO", "DELTA", "TYCOON", "AIRWAY", "VALLEY", "HARBOR"];
  const p = prefixes[Math.floor(Math.random() * prefixes.length)];
  const num = Math.floor(100 + Math.random() * 900);
  const newSeed = `${p}-${num}`;
  const seedInput = getInput("seedInput");
  if (seedInput) seedInput.value = newSeed;
  store.setCamera(null);
  store.setInspected(null, null);
  store.patchConfig({ seed: newSeed });
  updateUrl(true);
  rebuildWorld(false);
});

getInput("seedInput")?.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter") {
    const inp = /** @type {HTMLInputElement} */ (e.target);
    const newSeed = inp.value.trim() || DEFAULT_GENERATOR_CONFIG.seed;
    inp.value = newSeed;
    if (newSeed !== store.getState().config.seed) {
      store.setCamera(null);
      store.setInspected(null, null);
      store.patchConfig({ seed: newSeed });
      updateUrl(true);
      rebuildWorld(false);
    }
    inp.blur();
  }
});

getInput("seedInput")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  const newSeed = inp.value.trim() || DEFAULT_GENERATOR_CONFIG.seed;
  inp.value = newSeed;
  if (newSeed !== store.getState().config.seed) {
    store.setCamera(null);
    store.setInspected(null, null);
    store.patchConfig({ seed: newSeed });
    updateUrl(true);
    rebuildWorld(false);
  }
});

getSelect("archetypeSelect")?.addEventListener("change", (e) => {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  store.setCamera(null);
  store.setInspected(null, null);
  store.setArchetype(sel.value);
  syncDomInputsFromConfig(store.getState().config);
  updateUrl(true);
  rebuildWorld(false);
});

getSelect("worldSizeSelect")?.addEventListener("change", (e) => {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  const def = WORLD_SIZE_DEFAULTS[sel.value];
  store.setCamera(null);
  store.setInspected(null, null);
  if (def) {
    const tSlider = getInput("sliderTowns");
    const aSlider = getInput("sliderAirports");
    if (tSlider) tSlider.value = String(def.towns);
    if (aSlider) aSlider.value = String(def.airports);
    batch(() => {
      store.patchConfig({
        worldSize: sel.value,
        townCount: def.towns,
        airportCount: def.airports,
      });
    });
  } else {
    store.patchConfig({ worldSize: sel.value });
  }
  updateUrl(true);
  rebuildWorld(false);
});

getSelect("terrainAlgoSelect")?.addEventListener("change", (e) => {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  store.patchConfig({ terrainAlgo: sel.value });
  updateUrl(false);
  rebuildWorld(true);
});

getSelect("hydrologyAlgoSelect")?.addEventListener("change", (e) => {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  store.patchConfig({ hydrologyAlgo: sel.value });
  updateUrl(false);
  rebuildWorld(true);
});

getSelect("airportMixSelect")?.addEventListener("change", (e) => {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  store.patchConfig({ airportMix: sel.value });
  updateUrl(false);
  rebuildWorld(true);
});

getInput("toggleInterRamps")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ includeIntermediateRamps: inp.checked });
  updateUrl(false);
  rebuildWorld(true);
});

getInput("sliderWater")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ waterCoverage: parseInt(inp.value, 10) });
  rebuildWorld(true);
});
getInput("sliderWater")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ waterCoverage: parseInt(inp.value, 10) });
  updateUrl(false);
});

getInput("sliderTowns")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ townCount: parseInt(inp.value, 10) });
  rebuildWorld(true);
});
getInput("sliderTowns")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ townCount: parseInt(inp.value, 10) });
  updateUrl(false);
});

getInput("sliderDensity")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ buildingDensity: parseInt(inp.value, 10) });
  rebuildWorld(true);
});
getInput("sliderDensity")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ buildingDensity: parseInt(inp.value, 10) });
  updateUrl(false);
});

getInput("sliderAirports")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ airportCount: parseInt(inp.value, 10) });
  rebuildWorld(true);
});
getInput("sliderAirports")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ airportCount: parseInt(inp.value, 10) });
  updateUrl(false);
});

getInput("sliderWind")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ windAxis: parseInt(inp.value, 10) });
  rebuildWorld(true);
});
getInput("sliderWind")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ windAxis: parseInt(inp.value, 10) });
  updateUrl(false);
});

getInput("sliderRelief")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ terrainRelief: parseInt(inp.value, 10) });
  rebuildWorld(true);
});
getInput("sliderRelief")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ terrainRelief: parseInt(inp.value, 10) });
  updateUrl(false);
});

getInput("sliderIncision")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ valleyIncision: parseInt(inp.value, 10) });
  rebuildWorld(true);
});
getInput("sliderIncision")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ valleyIncision: parseInt(inp.value, 10) });
  updateUrl(false);
});

getInput("sliderEmbayment")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ coastalEmbayment: parseInt(inp.value, 10) });
  rebuildWorld(true);
});
getInput("sliderEmbayment")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ coastalEmbayment: parseInt(inp.value, 10) });
  updateUrl(false);
});

getInput("sliderCaldera")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ calderaCurvature: parseInt(inp.value, 10) });
  rebuildWorld(true);
});
getInput("sliderCaldera")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ calderaCurvature: parseInt(inp.value, 10) });
  updateUrl(false);
});

getInput("sliderBarrier")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ barrierFragmentation: parseInt(inp.value, 10) });
  rebuildWorld(true);
});
getInput("sliderBarrier")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ barrierFragmentation: parseInt(inp.value, 10) });
  updateUrl(false);
});

getInput("sliderBasins")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ basinCount: parseInt(inp.value, 10) });
  rebuildWorld(true);
});
getInput("sliderBasins")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ basinCount: parseInt(inp.value, 10) });
  updateUrl(false);
});

document
  .getElementById("resetGeoScalarsBtn")
  ?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    store.resetArchetypeScalars();
    syncDomInputsFromConfig(store.getState().config);
    updateUrl(false);
    rebuildWorld(true);
  });

// Layer Overlay Buttons
document.querySelectorAll(".layer-btn").forEach((el) => {
  const btn = /** @type {HTMLElement} */ (el);
  btn.addEventListener("click", () => {
    const layer = /** @type {ViewLayer} */ (btn.dataset.layer || "aesthetic");
    store.setActiveLayer(layer);
    updateUrl(false);
  });
});

// Simulation Speed Buttons
document.querySelectorAll(".speed-btn").forEach((el) => {
  const btn = /** @type {HTMLElement} */ (el);
  btn.addEventListener("click", () => {
    const speed = parseFloat(btn.dataset.speed || "1");
    store.setSimSpeed(speed);
    updateUrl(false);
  });
});

window.addEventListener("popstate", () => {
  isRestoringFromHistory = true;
  try {
    const isMobile = window.innerWidth < 768;
    const popped = parseUrlState(window.location.search, isMobile);
    const prevConfig = store.getState().config;
    const configChanged = !shallowEqual(prevConfig, popped.config);

    batch(() => {
      store.patchConfig(popped.config);
      store.setActiveLayer(popped.activeLayer);
      store.setSimSpeed(popped.simSpeed);
      store.setDrawerOpen(popped.drawerOpen);
      store.setCamera(popped.camera);
      if (popped.inspected.type && popped.inspected.id != null) {
        store.setInspectedRef(popped.inspected.type, popped.inspected.id, null);
      } else {
        store.setInspected(null, null);
      }
    });

    syncDomInputsFromConfig(store.getState().config);

    if (configChanged) {
      rebuildWorld(false, true);
    } else if (currentWorld) {
      if (popped.camera) {
        renderer.camera.zoom = popped.camera.zoom;
        renderer.camera.x =
          canvas.width * 0.5 -
          popped.camera.cx * popped.camera.zoom * currentWorld.tileSize;
        renderer.camera.y =
          canvas.height * 0.5 -
          popped.camera.cy * popped.camera.zoom * currentWorld.tileSize;
      } else {
        renderer.fitCamera(currentWorld);
      }

      if (popped.inspected.type && popped.inspected.id != null) {
        /** @type {InspectedEntity | null} */
        let entity = null;
        if (popped.inspected.type === "airport") {
          entity =
            currentWorld.airports.find((a) => a.id === popped.inspected.id) ||
            currentWorld.airports[popped.inspected.id] ||
            null;
        } else if (popped.inspected.type === "town") {
          entity =
            currentWorld.towns.find((t) => t.id === popped.inspected.id) ||
            currentWorld.towns[popped.inspected.id] ||
            null;
        } else if (popped.inspected.type === "building") {
          entity =
            currentWorld.destinations.find(
              (d) => d.id === popped.inspected.id,
            ) || null;
        }
        if (entity) {
          openEntityInspector(popped.inspected.type, entity, false, false);
        } else {
          renderer.selectedEntity = null;
          store.setInspected(null, null);
        }
      } else {
        renderer.selectedEntity = null;
        store.setInspected(null, null);
      }
    }
  } finally {
    isRestoringFromHistory = false;
  }
});

// Main Animation Loop
let lastTime = performance.now();
function animate(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (currentWorld && simulator) {
    simulator.update(dt, simSpeed);
    renderer.render(currentWorld, simulator);
    inspectorElement?.refreshLiveStats(currentWorld, simulator.planes);

    getEl("tripCounter").textContent =
      simulator.tripsCompleted.toLocaleString();
    const clockAngle = (simulator.simTime * 24) % 360;
    getEl("clockHand").style.transform = `rotate(${clockAngle}deg)`;
    const dayIdx = Math.floor((simulator.simTime * 24) / 360) % 7;
    getEl("dayLabel").textContent = daysOfWeek[dayIdx];
  }
  requestAnimationFrame(animate);
}

function initApp() {
  syncDomInputsFromConfig(store.getState().config);

  const initialOpen = store.getState().drawerOpen;
  const drawer = document.getElementById("generatorDrawer");
  if (drawer) {
    drawer.classList.toggle("hidden", !initialOpen);
    drawer.toggleAttribute("inert", !initialOpen);
  }
  const toggleBtn = document.getElementById("toggleDrawerBtn");
  if (toggleBtn) {
    toggleBtn.setAttribute("aria-expanded", String(initialOpen));
  }

  const activeLayer = store.getState().activeLayer;
  document.querySelectorAll(".layer-btn").forEach((b) => {
    const btn = /** @type {HTMLElement} */ (b);
    const isActive = btn.dataset.layer === activeLayer;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });

  const simSpd = store.getState().simSpeed;
  document.querySelectorAll(".speed-btn").forEach((el) => {
    const btn = /** @type {HTMLElement} */ (el);
    const isActive = parseFloat(btn.dataset.speed || "1") === simSpd;
    btn.classList.toggle("bg-[#36383e]", isActive);
    btn.classList.toggle("text-[#f2efe9]", isActive);
    btn.classList.toggle("text-stone-500", !isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });

  const inspCard = document.getElementById("inspectorCard");
  if (inspCard) {
    inspCard.toggleAttribute("inert", !store.getState().inspected.entity);
  }

  handleResize();
  rebuildWorld(false, true);
  requestAnimationFrame(animate);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
