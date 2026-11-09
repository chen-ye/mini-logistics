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
import { WORLD_SIZE_DEFAULTS, DEFAULT_GENERATOR_CONFIG } from "./constants.js";
import { mountEntityInspector } from "./inspector-component.js";

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const getEl = (id) => document.getElementById(id);

/**
 * @param {string} id
 * @returns {HTMLInputElement}
 */
const getInput = (id) =>
  /** @type {HTMLInputElement} */ (document.getElementById(id));

/**
 * @param {string} id
 * @returns {HTMLSelectElement}
 */
const getSelect = (id) =>
  /** @type {HTMLSelectElement} */ (document.getElementById(id));

const canvas = /** @type {HTMLCanvasElement} */ (
  document.getElementById("worldCanvas")
);
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
/** @type {{ requestId: number, config: GeneratorConfig, preserveCamera: boolean, resolvers: Array<(w: ProceduralLogisticsWorld) => void> } | null} */
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
      const { requestId, preserveCamera, world: rawWorld } = event.data;
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
      await applyGeneratedWorld(world, preserveCamera, true);
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

function dispatchToWorker(job) {
  workerBusy = true;
  inflightResolvers.set(job.requestId, job.resolvers);
  worldWorker.postMessage({
    requestId: job.requestId,
    config: job.config,
    preserveCamera: job.preserveCamera,
  });
}

// Signal-grade immutable store holding app state
const store = createAppStore(DEFAULT_GENERATOR_CONFIG);

async function applyGeneratedWorld(world, preserveCamera, fromWorker = false) {
  renderer.prepareDisplayLists(world);
  currentWorld = world;
  simulator = new LogisticsSimulator(currentWorld);
  window.currentWorld = currentWorld;
  window.simulator = simulator;

  renderer.selectedEntity = null;
  store.setInspected(null, null);

  if (!preserveCamera) {
    renderer.fitCamera(currentWorld);
  }
  updateTelemetryUI(currentWorld, fromWorker);
}

/**
 * Synchronizes generator configuration from DOM inputs into the store
 * and returns the frozen config state.
 *
 * @returns {GeneratorConfig}
 */
export function getGeneratorConfig() {
  const cfg = {
    seed: getInput("seedInput")?.value.trim() || DEFAULT_GENERATOR_CONFIG.seed,
    worldSize:
      getSelect("worldSizeSelect")?.value || DEFAULT_GENERATOR_CONFIG.worldSize,
    archetype:
      getSelect("archetypeSelect")?.value || DEFAULT_GENERATOR_CONFIG.archetype,
    terrainAlgo:
      getSelect("terrainAlgoSelect")?.value ||
      DEFAULT_GENERATOR_CONFIG.terrainAlgo,
    hydrologyAlgo:
      getSelect("hydrologyAlgoSelect")?.value ||
      DEFAULT_GENERATOR_CONFIG.hydrologyAlgo,
    airportMix:
      getSelect("airportMixSelect")?.value ||
      DEFAULT_GENERATOR_CONFIG.airportMix,
    includeIntermediateRamps: getInput("toggleInterRamps")
      ? getInput("toggleInterRamps").checked
      : DEFAULT_GENERATOR_CONFIG.includeIntermediateRamps,
    waterCoverage: getInput("sliderWater")
      ? parseInt(getInput("sliderWater").value, 10)
      : DEFAULT_GENERATOR_CONFIG.waterCoverage,
    townCount: getInput("sliderTowns")
      ? parseInt(getInput("sliderTowns").value, 10)
      : DEFAULT_GENERATOR_CONFIG.townCount,
    buildingDensity: getInput("sliderDensity")
      ? parseInt(getInput("sliderDensity").value, 10)
      : DEFAULT_GENERATOR_CONFIG.buildingDensity,
    airportCount: getInput("sliderAirports")
      ? parseInt(getInput("sliderAirports").value, 10)
      : DEFAULT_GENERATOR_CONFIG.airportCount,
    windAxis: getInput("sliderWind")
      ? parseInt(getInput("sliderWind").value, 10)
      : DEFAULT_GENERATOR_CONFIG.windAxis,
  };
  store.patchConfig(cfg);
  return store.getState().config;
}

/**
 * Updates airport slider label directly, maintaining backwards compatibility.
 */
export function updateAirportSliderLabel() {
  const cfg = getGeneratorConfig();
  const labels = deriveControlLabels(cfg);
  const el = getEl("valAirports");
  if (el) el.textContent = labels.airportsLabel;
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
      btn.classList.toggle("active", btn.dataset.layer === layer);
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
    }
  },
);

/**
 * @param {boolean} [preserveCamera]
 * @returns {Promise<ProceduralLogisticsWorld | void>}
 */
export function rebuildWorld(preserveCamera = false) {
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
          resolvers: [resolve],
        });
      } else {
        if (pendingJob) {
          pendingJob.config = cfg;
          pendingJob.preserveCamera =
            pendingJob.preserveCamera && preserveCamera;
          pendingJob.resolvers.push(resolve);
        } else {
          pendingJob = {
            requestId: nextRequestId++,
            config: cfg,
            preserveCamera,
            resolvers: [resolve],
          };
        }
      }
    });
  }

  // Fallback if Worker is unavailable
  const world = fallbackPipeline(cfg);
  return applyGeneratedWorld(world, preserveCamera, false);
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
  document.getElementById("genTimeBadge").textContent =
    `${displayMs} ms${cacheSuffix}`;
  document.getElementById("statPop").textContent =
    world.houses.length + world.destinations.length;
  const hubs = world.airports.filter((a) => a.airportClass === "HUB").length;
  const others = world.airports.length - hubs;
  document.getElementById("statAirports").textContent =
    `${hubs} Hub · ${others} Reg`;
  const clovers = world.interchanges.filter(
    (i) => i.type === "cloverleaf" || i.type === "trumpet",
  ).length;
  const ramps = world.interchanges.filter(
    (i) => i.type === "diamond-ramp",
  ).length;
  document.getElementById("statBridges").textContent =
    `${clovers} Sys · ${ramps} Ramp`;

  const logEl = document.getElementById("pipelineLog");
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
 */
export function openEntityInspector(type, entity, shouldFocus = false) {
  const normalizedType = type === "resource" ? "building" : type;
  renderer.selectedEntity = entity;
  store.setInspected(normalizedType, entity);
  if (shouldFocus) {
    focusCameraOnEntity(normalizedType, entity);
  }
}

window.openEntityInspector = openEntityInspector;

// Mount the custom Light-DOM entity inspector element
const inspectorCard = document.getElementById("inspectorCard");
if (inspectorCard) {
  mountEntityInspector(inspectorCard, {
    store,
    getWorld: () => currentWorld,
    onFocus: (type, entity) => {
      focusCameraOnEntity(type, entity);
    },
    onSelectEntity: (type, entity, shouldFocus = false) => {
      openEntityInspector(type, entity, shouldFocus);
    },
    onClose: () => {
      renderer.selectedEntity = null;
      store.setInspected(null, null);
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
  if (currentWorld) renderer.fitCamera(currentWorld);
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

  if (activePointers.size === 0 && isDragging) {
    isDragging = false;
    if (hadMultiTouch) return;

    const tapThreshold = e.pointerType === "touch" ? 12 : 6;
    const moveDist = Math.hypot(
      e.clientX - pointerDownPos.x,
      e.clientY - pointerDownPos.y,
    );
    if (moveDist < tapThreshold && currentWorld) {
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
        openEntityInspector(hit.type, hit.entity, false);
        return;
      }

      const now = performance.now();
      if (e.pointerType === "touch" && now - lastTapTime < 300) {
        zoomAroundPoint(1.35, e.clientX, e.clientY);
        lastTapTime = 0;
        return;
      }
      lastTapTime = now;

      renderer.selectedEntity = null;
      store.setInspected(null, null);
      if (window.innerWidth < 640) {
        store.setDrawerOpen(false);
      }
    }
  }
}

window.addEventListener("pointerup", handlePointerEnd);
window.addEventListener("pointercancel", handlePointerEnd);

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
  },
  { passive: false },
);

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    renderer.selectedEntity = null;
    store.setInspected(null, null);
    return;
  }
  if (document.activeElement && document.activeElement.tagName === "INPUT") {
    return;
  }
  const panStep = 40;
  if (e.key === "ArrowLeft") renderer.camera.x += panStep;
  else if (e.key === "ArrowRight") renderer.camera.x -= panStep;
  else if (e.key === "ArrowUp") renderer.camera.y += panStep;
  else if (e.key === "ArrowDown") renderer.camera.y -= panStep;
  else if (e.key === "+" || e.key === "=") {
    zoomAroundPoint(1.18, canvas.width * 0.5, canvas.height * 0.5);
  } else if (e.key === "-") {
    zoomAroundPoint(0.84, canvas.width * 0.5, canvas.height * 0.5);
  }
});

// UI Control Bindings
document.getElementById("toggleDrawerBtn")?.addEventListener("click", () => {
  const nextOpen = !store.getState().drawerOpen;
  store.setDrawerOpen(nextOpen);
  if (nextOpen && window.innerWidth < 640) {
    store.setInspected(null, null);
  }
});

document
  .getElementById("closeDrawerMobileBtn")
  ?.addEventListener("click", () => {
    store.setDrawerOpen(false);
  });

document.getElementById("resetViewBtn")?.addEventListener("click", () => {
  if (currentWorld) renderer.fitCamera(currentWorld);
  if (window.innerWidth < 640) {
    store.setDrawerOpen(false);
  }
});

document.getElementById("zoomInBtn")?.addEventListener("click", () => {
  zoomAroundPoint(1.25, canvas.width * 0.5, canvas.height * 0.5);
});

document.getElementById("zoomOutBtn")?.addEventListener("click", () => {
  zoomAroundPoint(0.8, canvas.width * 0.5, canvas.height * 0.5);
});

document.getElementById("hudFitBtn")?.addEventListener("click", () => {
  if (currentWorld) renderer.fitCamera(currentWorld);
});

getEl("randomSeedBtn")?.addEventListener("click", () => {
  const prefixes = ["METRO", "DELTA", "TYCOON", "AIRWAY", "VALLEY", "HARBOR"];
  const p = prefixes[Math.floor(Math.random() * prefixes.length)];
  const num = Math.floor(100 + Math.random() * 900);
  const newSeed = `${p}-${num}`;
  const seedInput = getInput("seedInput");
  if (seedInput) seedInput.value = newSeed;
  store.patchConfig({ seed: newSeed });
  rebuildWorld(false);
});

getInput("seedInput")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ seed: inp.value.trim() });
  rebuildWorld(false);
});

getSelect("archetypeSelect")?.addEventListener("change", (e) => {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  if (sel.value === "island-hopper") {
    const apSlider = getInput("sliderAirports");
    if (parseInt(apSlider.value, 10) < 5) {
      apSlider.value = "5";
      batch(() => {
        store.patchConfig({
          archetype: sel.value,
          airportCount: 5,
        });
      });
      rebuildWorld(false);
      return;
    }
  }
  store.patchConfig({ archetype: sel.value });
  rebuildWorld(false);
});

getSelect("worldSizeSelect")?.addEventListener("change", (e) => {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  const def = WORLD_SIZE_DEFAULTS[sel.value];
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
  rebuildWorld(false);
});

getSelect("terrainAlgoSelect")?.addEventListener("change", (e) => {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  store.patchConfig({ terrainAlgo: sel.value });
  rebuildWorld(true);
});

getSelect("hydrologyAlgoSelect")?.addEventListener("change", (e) => {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  store.patchConfig({ hydrologyAlgo: sel.value });
  rebuildWorld(true);
});

getSelect("airportMixSelect")?.addEventListener("change", (e) => {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  store.patchConfig({ airportMix: sel.value });
  rebuildWorld(true);
});

getInput("toggleInterRamps")?.addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ includeIntermediateRamps: inp.checked });
  rebuildWorld(true);
});

getInput("sliderWater")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ waterCoverage: parseInt(inp.value, 10) });
  rebuildWorld(true);
});

getInput("sliderTowns")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ townCount: parseInt(inp.value, 10) });
  rebuildWorld(true);
});

getInput("sliderDensity")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ buildingDensity: parseInt(inp.value, 10) });
  rebuildWorld(true);
});

getInput("sliderAirports")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ airportCount: parseInt(inp.value, 10) });
  rebuildWorld(true);
});

getInput("sliderWind")?.addEventListener("input", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ windAxis: parseInt(inp.value, 10) });
  rebuildWorld(true);
});

// Layer Overlay Buttons
document.querySelectorAll(".layer-btn").forEach((el) => {
  const btn = /** @type {HTMLElement} */ (el);
  btn.addEventListener("click", () => {
    const layer = /** @type {ViewLayer} */ (btn.dataset.layer || "aesthetic");
    store.setActiveLayer(layer);
  });
});

// Simulation Speed Buttons
document.querySelectorAll(".speed-btn").forEach((el) => {
  const btn = /** @type {HTMLElement} */ (el);
  btn.addEventListener("click", () => {
    const speed = parseFloat(btn.dataset.speed || "1");
    store.setSimSpeed(speed);
  });
});

// Main Animation Loop
let lastTime = performance.now();
function animate(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (currentWorld && simulator) {
    simulator.update(dt, simSpeed);
    renderer.render(currentWorld, simulator);

    document.getElementById("tripCounter").textContent =
      simulator.tripsCompleted.toLocaleString();
    const clockAngle = (simulator.simTime * 24) % 360;
    document.getElementById("clockHand").style.transform =
      `rotate(${clockAngle}deg)`;
    const dayIdx = Math.floor((simulator.simTime * 24) / 360) % 7;
    document.getElementById("dayLabel").textContent = daysOfWeek[dayIdx];
  }
  requestAnimationFrame(animate);
}

function initApp() {
  if (window.innerWidth < 768) {
    store.setDrawerOpen(false);
  }
  handleResize();
  rebuildWorld(false);
  requestAnimationFrame(animate);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
