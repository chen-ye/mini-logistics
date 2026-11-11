/**
 * Main-thread UI shell, URL history coordinator, synchronous `CameraController` gesture handler,
 * and 3-thread `OffscreenCanvas` RPC orchestrator (`main.js` <-> `world-worker.js` <-> `render-sim-worker.js`).
 *
 * Invariants:
 * - Zero world generation, display-list recording, simulation stepping, or 2D canvas rendering on the main thread.
 * - `canvas.width` / `canvas.height` are never mutated on `main.js` after `transferControlToOffscreen()`.
 * - Synchronous `CameraController` provides zero-latency pan, pinch, wheel, and keyboard camera updates.
 * - Exposes `window.appBridge` as the sole public runtime/test bridge.
 *
 * @import {
 *   AppBridge,
 *   ControlLabels,
 *   EntityKind,
 *   EntityRef,
 *   GeneratorConfig,
 *   MainToRenderMessage,
 *   RenderToMainMessage,
 *   ViewLayer,
 *   WorldSummary,
 * } from "./types.js"
 */

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
import { parseUrlState, serializeUrlState, sanitizeSeed } from "./url-state.js";
import { CameraController } from "./camera-controller.js";

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
const cameraController = new CameraController(
  typeof window !== "undefined" ? window.innerWidth : 1280,
  typeof window !== "undefined" ? window.innerHeight : 800,
);

const DAYS_OF_WEEK = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/** @type {WorldSummary | null} */
let currentWorldSummary = null;
let displayListsReady = false;

/** @type {Worker | null} */
let worldWorker = null;
/** @type {Worker | null} */
let renderSimWorker = null;
let workerBusy = false;
let nextRequestId = 1;
let nextRpcId = 1;
let hoverInFlight = false;

/**
 * @typedef {Object} WorldBuildJob
 * @property {number} requestId
 * @property {GeneratorConfig} config
 * @property {boolean} preserveCamera
 * @property {boolean} preserveUrlHydration
 * @property {Array<(summary: WorldSummary | null) => void>} resolvers
 */

/** @type {WorldBuildJob | null} */
let pendingJob = null;
/** @type {Map<number, Array<(summary: WorldSummary | null) => void>>} */
const inflightResolvers = new Map();
/** @type {Map<number, { clientX: number, clientY: number, pointerType: string }>} */
const pendingTaps = new Map();
/** @type {Map<number, (found: boolean) => void>} */
const pendingSelectResolvers = new Map();
/** @type {Map<number, (ready: boolean) => void>} */
const pendingTestRenderResolvers = new Map();
/** @type {Map<number, (res: { tripsCompleted: number, simTime: number }) => void>} */
const pendingTestStepResolvers = new Map();

let latestBuildRequestId = 0;
let isFollowingLive = false;
let userMovedCameraDuringBuild = false;

const isInitialMobile =
  typeof window !== "undefined" && window.innerWidth < 768;
const initialUrlState =
  typeof window !== "undefined"
    ? parseUrlState(window.location.search, isInitialMobile)
    : parseUrlState("", false);

const store = createAppStore(initialUrlState.config, {
  activeLayer: initialUrlState.activeLayer,
  simSpeed: initialUrlState.simSpeed,
  drawerOpen: initialUrlState.drawerOpen,
  camera: initialUrlState.camera,
  inspected: initialUrlState.inspected,
});

let isRestoringFromHistory = false;

/**
 * Posts a typed RPC message to `render-sim-worker.js`.
 *
 * @param {MainToRenderMessage} msg
 * @param {Transferable[]} [transfer]
 */
function postToRenderWorker(msg, transfer) {
  if (!renderSimWorker) return;
  if (transfer && transfer.length > 0) {
    renderSimWorker.postMessage(msg, transfer);
  } else {
    renderSimWorker.postMessage(msg);
  }
}

/**
 * Sends current `cameraController` coordinates to `render-sim-worker.js`.
 *
 * @param {boolean} [breakFollow=true]
 */
function postCameraToWorker(breakFollow = true) {
  postToRenderWorker({
    type: "SET_CAMERA",
    x: cameraController.x,
    y: cameraController.y,
    zoom: cameraController.zoom,
    breakFollow,
  });
}

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
 * Projects `cameraController` center to world-tile coordinates and syncs to store & URL.
 *
 * @param {boolean} [push=false]
 */
function syncStoreCameraFromController(push = false) {
  if (!currentWorldSummary) return;
  const cam = cameraController.toWorldCenter(currentWorldSummary.tileSize);
  store.setCamera(cam);
  updateUrl(push);
}

/**
 * Breaks live camera follow, syncing controller center to store before tearing down.
 */
function breakLiveFollow() {
  if (isFollowingLive) {
    isFollowingLive = false;
    syncStoreCameraFromController(false);
  }
}

/**
 * Updates top-right HUD trip counter, analog clock hand, and day-of-week label.
 *
 * @param {number} tripsCompleted
 * @param {number} simTime
 */
function updateSimHud(tripsCompleted, simTime) {
  getEl("tripCounter").textContent = tripsCompleted.toLocaleString();
  const clockAngle = (simTime * 24) % 360;
  getEl("clockHand").style.transform = `rotate(${clockAngle}deg)`;
  const dayIdx = Math.floor((simTime * 24) / 360) % 7;
  getEl("dayLabel").textContent = DAYS_OF_WEEK[dayIdx];
}

/**
 * Updates pipeline telemetry badges and stage log from a `WorldSummary`.
 *
 * @param {WorldSummary} summary
 * @param {boolean} [fromWorker=true]
 */
function updateTelemetryUI(summary, fromWorker = true) {
  const gridLabelEl = document.getElementById("telemetryGridLabel");
  if (gridLabelEl) {
    gridLabelEl.textContent = `World Summary (${summary.W}×${summary.H} Grid)`;
  }
  const displayMs = summary.wallTimeMs ?? summary.genTimeMs;
  const cacheSuffix =
    summary.reusedThroughStage > 0
      ? ` · Cached S1–S${summary.reusedThroughStage}`
      : fromWorker
        ? " · 2W Parallel"
        : "";
  getEl("genTimeBadge").textContent = `${displayMs} ms${cacheSuffix}`;
  getEl("statPop").textContent = String(
    summary.housesCount + summary.destinationsCount,
  );
  const hubs = summary.airports.filter((a) => a.airportClass === "HUB").length;
  const others = summary.airports.length - hubs;
  getEl("statAirports").textContent = `${hubs} Hub · ${others} Reg`;
  getEl("statBridges").textContent =
    `${summary.systemInterchangeCount} Sys · ${summary.diamondRampCount} Ramp`;

  const logEl = getEl("pipelineLog");
  logEl.innerHTML = summary.logs
    .map(
      (l) =>
        `<div class="flex items-start gap-1.5"><span class="text-pink-600 font-bold">•</span><span>${l}</span></div>`,
    )
    .join("");
}

/**
 * Selects an entity by `{ kind, id }` via `render-sim-worker.js`, updating dossier and URL.
 *
 * @param {EntityRef | null} ref
 * @param {boolean} [shouldFocus=false]
 * @param {boolean} [pushHistory=true]
 * @param {boolean} [fromHistory=false]
 * @returns {Promise<boolean>}
 */
function selectEntityRef(
  ref,
  shouldFocus = false,
  pushHistory = true,
  fromHistory = false,
) {
  if (!renderSimWorker) return Promise.resolve(false);
  const requestId = nextRpcId++;
  return new Promise((resolve) => {
    pendingSelectResolvers.set(requestId, resolve);
    postToRenderWorker({
      type: "SELECT_REF",
      requestId,
      ref,
      shouldFocus,
      pushHistory,
      fromHistory,
      isMobile: window.innerWidth < 640,
    });
  });
}

/**
 * Clears active entity selection synchronously on store/DOM and notifies `render-sim-worker.js`.
 *
 * @param {boolean} [syncUrl=true]
 */
function clearSelection(syncUrl = true) {
  breakLiveFollow();
  store.setInspected(null, null);
  postToRenderWorker({
    type: "SET_VIEW_STATE",
    inspectedRef: null,
  });
  if (syncUrl) {
    updateUrl(false);
  }
}

// Mount Light-DOM `<ml-entity-inspector>` custom element
const inspectorCard = document.getElementById("inspectorCard");
/** @type {import("./inspector-component.js").EntityInspectorElement | null} */
let inspectorElement = null;
if (inspectorCard) {
  inspectorElement = mountEntityInspector(inspectorCard, {
    store,
    onFocus: () => {
      postToRenderWorker({
        type: "FOCUS_SELECTED",
        isMobile: window.innerWidth < 640,
      });
    },
    onJumpRef: (kind, id) => {
      void selectEntityRef({ kind, id }, true, true);
    },
    onSelectEntity: (type, entity, shouldFocus) => {
      const kind = /** @type {EntityKind} */ (
        type === "resource" ? "building" : type
      );
      if (entity && entity.id != null) {
        void selectEntityRef(
          { kind, id: entity.id },
          Boolean(shouldFocus),
          true,
        );
      }
    },
    onClose: () => {
      clearSelection(true);
      canvas.focus({ preventScroll: true });
    },
  });
}

/**
 * Dispatches a world generation job to `world-worker.js`.
 *
 * @param {WorldBuildJob} job
 */
function dispatchToWorldWorker(job) {
  if (!worldWorker) return;
  workerBusy = true;
  if (!job.preserveCamera) {
    userMovedCameraDuringBuild = false;
  }
  inflightResolvers.set(job.requestId, job.resolvers);

  worldWorker.postMessage({
    requestId: job.requestId,
    config: job.config,
    preserveCamera: job.preserveCamera,
    preserveUrlHydration: job.preserveUrlHydration,
    isMobile: typeof window !== "undefined" && window.innerWidth < 640,
  });
}

/**
 * Resolves all pending promises and resets worker state on worker failure.
 */
function settleWorkerError() {
  workerBusy = false;
  pendingJob = null;
  pendingTaps.clear();
  for (const resolvers of inflightResolvers.values()) {
    for (const resolve of resolvers) {
      resolve(null);
    }
  }
  inflightResolvers.clear();
  for (const resolve of pendingSelectResolvers.values()) {
    resolve(false);
  }
  pendingSelectResolvers.clear();
  for (const resolve of pendingTestRenderResolvers.values()) {
    resolve(false);
  }
  pendingTestRenderResolvers.clear();
  for (const resolve of pendingTestStepResolvers.values()) {
    resolve({ tripsCompleted: 0, simTime: 0 });
  }
  pendingTestStepResolvers.clear();
}

/**
 * Initializes the 3-thread `OffscreenCanvas` + `MessageChannel` worker topology.
 */
function initWorkers() {
  if (
    typeof Worker === "undefined" ||
    typeof canvas.transferControlToOffscreen !== "function"
  ) {
    return;
  }

  const initW = Math.max(1, window.innerWidth);
  const initH = Math.max(1, window.innerHeight);
  canvas.width = initW;
  canvas.height = initH;
  cameraController.setViewport(initW, initH);

  const channel = new MessageChannel();
  const offscreen = canvas.transferControlToOffscreen();

  worldWorker = new Worker(new URL("./world-worker.js", import.meta.url), {
    type: "module",
  });
  worldWorker.addEventListener("message", (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === "JOB_COMPLETE") {
      if (pendingJob) {
        const next = pendingJob;
        pendingJob = null;
        dispatchToWorldWorker(next);
      } else {
        workerBusy = false;
      }
    }
  });
  worldWorker.addEventListener("error", (err) => {
    console.error("World Worker error:", err);
    settleWorkerError();
  });
  worldWorker.postMessage({ type: "BIND_RENDER_PORT" }, [channel.port1]);

  renderSimWorker = new Worker(
    new URL("./render-sim-worker.js", import.meta.url),
    { type: "module" },
  );
  renderSimWorker.addEventListener(
    "message",
    /** @param {MessageEvent<RenderToMainMessage>} event */ (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case "SCENE_APPLIED": {
          const resolvers = inflightResolvers.get(msg.requestId) || [];
          inflightResolvers.delete(msg.requestId);
          for (const resolve of resolvers) {
            resolve(msg.worldSummary);
          }
          if (msg.requestId < latestBuildRequestId) {
            return;
          }

          currentWorldSummary = msg.worldSummary;
          displayListsReady = msg.displayListsReady;

          const userMovedCamera =
            userMovedCameraDuringBuild ||
            activePointers.size > 0 ||
            wheelEndTimer !== null;
          if (msg.preserveCamera && userMovedCamera) {
            postCameraToWorker(false);
          } else {
            cameraController.x = msg.camera.x;
            cameraController.y = msg.camera.y;
            cameraController.zoom = msg.camera.zoom;
          }

          if (msg.selectionPayload) {
            if (msg.selectionPayload.found && msg.selectionPayload.ref) {
              store.setInspectedRef(
                msg.selectionPayload.ref.kind,
                msg.selectionPayload.ref.id,
                null,
              );
              inspectorElement?.renderSnapshot(msg.selectionPayload.dossier);
              if (msg.selectionPayload.focusedCamera) {
                syncStoreCameraFromController(false);
              }
            } else {
              const hadInspect = store.getState().inspected.type !== null;
              store.setInspected(null, null);
              if (hadInspect) {
                updateUrl(false);
              }
            }
          }

          updateTelemetryUI(msg.worldSummary, true);
          updateSimHud(msg.tripsCompleted, msg.simTime);
          break;
        }

        case "CAMERA_FOLLOW_TICK": {
          isFollowingLive = true;
          if (activePointers.size === 0) {
            cameraController.x = msg.x;
            cameraController.y = msg.y;
            cameraController.zoom = msg.zoom;
          }
          break;
        }

        case "HUD_TICK": {
          updateSimHud(msg.tripsCompleted, msg.simTime);
          if (msg.livePatch) {
            inspectorElement?.applyLivePatch(msg.livePatch);
          }
          if (msg.liveCamera && activePointers.size === 0) {
            cameraController.x = msg.liveCamera.x;
            cameraController.y = msg.liveCamera.y;
            cameraController.zoom = msg.liveCamera.zoom;
          }
          break;
        }

        case "HOVER_CURSOR": {
          hoverInFlight = false;
          if (msg.cursor !== lastCursor) {
            canvas.style.cursor = msg.cursor;
            lastCursor = msg.cursor;
          }
          break;
        }

        case "TAP_RESULT": {
          const tapMeta = pendingTaps.get(msg.tapId);
          pendingTaps.delete(msg.tapId);

          if (msg.hit && msg.ref) {
            if (window.innerWidth < 640) {
              store.setDrawerOpen(false);
            }
            if (msg.ref.kind === "plane" || msg.ref.kind === "truck") {
              isFollowingLive = Boolean(msg.cameraTarget?.followLive);
            } else {
              isFollowingLive = false;
            }
            store.setInspectedRef(msg.ref.kind, msg.ref.id, null);
            inspectorElement?.renderSnapshot(msg.dossier);
            updateUrl(true);
            break;
          }

          isFollowingLive = false;
          const now = performance.now();
          if (
            tapMeta &&
            tapMeta.pointerType === "touch" &&
            now - lastTapTime < 300
          ) {
            cameraController.zoomAroundPoint(
              1.35,
              tapMeta.clientX,
              tapMeta.clientY,
            );
            postCameraToWorker(true);
            lastTapTime = 0;
            syncStoreCameraFromController(false);
            break;
          }
          lastTapTime = now;

          store.setInspected(null, null);
          updateUrl(false);
          if (window.innerWidth < 640) {
            store.setDrawerOpen(false);
          }
          break;
        }

        case "SELECTION_APPLIED": {
          if (msg.found && msg.ref) {
            if (msg.focused && msg.camera) {
              cameraController.x = msg.camera.x;
              cameraController.y = msg.camera.y;
              cameraController.zoom = msg.camera.zoom;
              if (currentWorldSummary && !msg.fromHistory) {
                store.setCamera(
                  cameraController.toWorldCenter(currentWorldSummary.tileSize),
                );
              }
            }
            if (
              msg.focused &&
              (msg.ref.kind === "plane" || msg.ref.kind === "truck")
            ) {
              isFollowingLive = true;
            }
            store.setInspectedRef(msg.ref.kind, msg.ref.id, null);
            inspectorElement?.renderSnapshot(msg.dossier);
            if (!msg.fromHistory) {
              updateUrl(msg.pushHistory);
            }
          } else {
            isFollowingLive = false;
            store.setInspected(null, null);
            if (!msg.fromHistory) {
              updateUrl(false);
            }
          }

          const selResolve = pendingSelectResolvers.get(msg.requestId);
          if (selResolve) {
            pendingSelectResolvers.delete(msg.requestId);
            selResolve(msg.found);
          }
          break;
        }

        case "CAMERA_UPDATED": {
          cameraController.x = msg.camera.x;
          cameraController.y = msg.camera.y;
          cameraController.zoom = msg.camera.zoom;
          if (msg.commitToStore) {
            syncStoreCameraFromController(false);
          }
          break;
        }

        case "TEST_RENDER_DONE": {
          displayListsReady = msg.displayListsReady;
          const rResolve = pendingTestRenderResolvers.get(msg.requestId);
          if (rResolve) {
            pendingTestRenderResolvers.delete(msg.requestId);
            rResolve(msg.displayListsReady);
          }
          break;
        }

        case "TEST_STEP_DONE": {
          updateSimHud(msg.tripsCompleted, msg.simTime);
          if (msg.livePatch) {
            inspectorElement?.applyLivePatch(msg.livePatch);
          }
          const sResolve = pendingTestStepResolvers.get(msg.requestId);
          if (sResolve) {
            pendingTestStepResolvers.delete(msg.requestId);
            sResolve({
              tripsCompleted: msg.tripsCompleted,
              simTime: msg.simTime,
            });
          }
          break;
        }
      }
    },
  );
  renderSimWorker.addEventListener("error", (err) => {
    console.error("Render/Sim Worker error:", err);
    settleWorkerError();
  });

  const st = store.getState();
  /** @type {EntityRef | null} */
  const initInspectedRef =
    st.inspected.type && st.inspected.id != null
      ? { kind: st.inspected.type, id: st.inspected.id }
      : null;

  postToRenderWorker(
    {
      type: "INIT",
      canvas: offscreen,
      worldPort: channel.port2,
      width: initW,
      height: initH,
      activeLayer: st.activeLayer,
      simSpeed: st.simSpeed,
      drawerOpen: st.drawerOpen,
      camera: st.camera,
      inspectedRef: initInspectedRef,
      isMobile: initW < 640,
    },
    [offscreen, channel.port2],
  );
}

/**
 * Populates DOM controls and labels from the generator configuration.
 *
 * @param {Partial<GeneratorConfig>} cfg
 */
export function syncDomInputsFromConfig(cfg) {
  const seedInput = getInput("seedInput");
  const seedVal = cfg.seed || DEFAULT_GENERATOR_CONFIG.seed;
  if (seedInput.value !== seedVal) seedInput.value = seedVal;

  const worldSizeSelect = getSelect("worldSizeSelect");
  const sizeVal = cfg.worldSize || DEFAULT_GENERATOR_CONFIG.worldSize;
  if (worldSizeSelect.value !== sizeVal) worldSizeSelect.value = sizeVal;

  const archetypeSelect = getSelect("archetypeSelect");
  const archVal = cfg.archetype || DEFAULT_GENERATOR_CONFIG.archetype;
  if (archetypeSelect.value !== archVal) archetypeSelect.value = archVal;

  const terrainAlgoSelect = getSelect("terrainAlgoSelect");
  const terrainVal = cfg.terrainAlgo || DEFAULT_GENERATOR_CONFIG.terrainAlgo;
  if (terrainAlgoSelect.value !== terrainVal) {
    terrainAlgoSelect.value = terrainVal;
  }

  const hydrologyAlgoSelect = getSelect("hydrologyAlgoSelect");
  const hydroVal = cfg.hydrologyAlgo || DEFAULT_GENERATOR_CONFIG.hydrologyAlgo;
  if (hydrologyAlgoSelect.value !== hydroVal) {
    hydrologyAlgoSelect.value = hydroVal;
  }

  const airportMixSelect = getSelect("airportMixSelect");
  const airMixVal = cfg.airportMix || DEFAULT_GENERATOR_CONFIG.airportMix;
  if (airportMixSelect.value !== airMixVal) airportMixSelect.value = airMixVal;

  const toggleInterRamps = getInput("toggleInterRamps");
  const rampsVal =
    cfg.includeIntermediateRamps ??
    DEFAULT_GENERATOR_CONFIG.includeIntermediateRamps;
  if (toggleInterRamps.checked !== rampsVal)
    toggleInterRamps.checked = rampsVal;

  const archPreset =
    ARCHETYPE_PARAMETER_PRESETS[archVal] ||
    ARCHETYPE_PARAMETER_PRESETS.confluence;

  /** @type {Array<[string, number]>} */
  const sliderValues = [
    [
      "sliderWater",
      cfg.waterCoverage ?? DEFAULT_GENERATOR_CONFIG.waterCoverage,
    ],
    ["sliderTowns", cfg.townCount ?? DEFAULT_GENERATOR_CONFIG.townCount],
    [
      "sliderDensity",
      cfg.buildingDensity ?? DEFAULT_GENERATOR_CONFIG.buildingDensity,
    ],
    [
      "sliderAirports",
      cfg.airportCount ?? DEFAULT_GENERATOR_CONFIG.airportCount,
    ],
    ["sliderWind", cfg.windAxis ?? DEFAULT_GENERATOR_CONFIG.windAxis],
    ["sliderRelief", cfg.terrainRelief ?? archPreset.terrainRelief],
    ["sliderIncision", cfg.valleyIncision ?? archPreset.valleyIncision],
    ["sliderEmbayment", cfg.coastalEmbayment ?? archPreset.coastalEmbayment],
    ["sliderCaldera", cfg.calderaCurvature ?? archPreset.calderaCurvature],
    [
      "sliderBarrier",
      cfg.barrierFragmentation ?? archPreset.barrierFragmentation,
    ],
    ["sliderBasins", cfg.basinCount ?? archPreset.basinCount],
  ];

  for (const [id, val] of sliderValues) {
    const inp = getInput(id);
    if (parseInt(inp.value, 10) !== val) {
      inp.value = String(val);
    }
  }

  updateAirportSliderLabel();
  syncGeomorphologyLabelsUI(cfg, deriveControlLabels(store.getState().config));
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
 * Updates airport slider label directly.
 */
export function updateAirportSliderLabel() {
  const labels = deriveControlLabels(store.getState().config);
  getEl("valAirports").textContent = labels.airportsLabel;
}

/**
 * Synchronizes the 6 geomorphology scalar readouts, modified colors, preset badge, and reset button.
 *
 * @param {Partial<GeneratorConfig>} cfg
 * @param {ControlLabels} labels
 */
function syncGeomorphologyLabelsUI(cfg, labels) {
  const archKey = cfg.archetype || DEFAULT_GENERATOR_CONFIG.archetype;
  const preset =
    ARCHETYPE_PARAMETER_PRESETS[archKey] ||
    ARCHETYPE_PARAMETER_PRESETS.confluence;

  /** @type {Array<[string, string | undefined, number, number]>} */
  const scalarRows = [
    [
      "valRelief",
      labels.reliefLabel,
      cfg.terrainRelief ?? preset.terrainRelief,
      preset.terrainRelief,
    ],
    [
      "valIncision",
      labels.incisionLabel,
      cfg.valleyIncision ?? preset.valleyIncision,
      preset.valleyIncision,
    ],
    [
      "valEmbayment",
      labels.embaymentLabel,
      cfg.coastalEmbayment ?? preset.coastalEmbayment,
      preset.coastalEmbayment,
    ],
    [
      "valCaldera",
      labels.calderaLabel,
      cfg.calderaCurvature ?? preset.calderaCurvature,
      preset.calderaCurvature,
    ],
    [
      "valBarrier",
      labels.barrierLabel,
      cfg.barrierFragmentation ?? preset.barrierFragmentation,
      preset.barrierFragmentation,
    ],
    [
      "valBasins",
      labels.basinsLabel,
      cfg.basinCount ?? preset.basinCount,
      preset.basinCount,
    ],
  ];
  for (const [id, text, cur, base] of scalarRows) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = text || (id === "valBasins" ? `${cur}` : `${cur}%`);
    el.style.color = cur !== base ? "#d94376" : "";
  }

  const geoPresetBadge = document.getElementById("geoPresetBadge");
  const resetGeoScalarsBtn = document.getElementById("resetGeoScalarsBtn");
  const modCount = labels.geoModifiedCount ?? 0;
  if (modCount > 0) {
    if (geoPresetBadge) {
      geoPresetBadge.textContent = `${modCount} Mod`;
      geoPresetBadge.className =
        "text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[#e85c90]/15 text-[#d94376]";
    }
    resetGeoScalarsBtn?.classList.remove("hidden");
  } else {
    if (geoPresetBadge) {
      geoPresetBadge.textContent = "Preset";
      geoPresetBadge.className =
        "text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-stone-200/80 text-stone-600";
    }
    resetGeoScalarsBtn?.classList.add("hidden");
  }
}

// Store subscriptions
store.subscribe(
  (s) => deriveControlLabels(s.config),
  (labels) => {
    getEl("valWater").textContent = labels.waterLabel;
    getEl("valTowns").textContent = labels.townsLabel;
    getEl("valDensity").textContent = labels.densityLabel;
    getEl("valAirports").textContent = labels.airportsLabel;
    getEl("valWind").textContent = labels.windLabel;
    syncGeomorphologyLabelsUI(store.getState().config, labels);
  },
  shallowEqual,
);

/** @param {ViewLayer} layer */
function syncLayerButtonsDom(layer) {
  document.querySelectorAll(".layer-btn").forEach((b) => {
    const btn = /** @type {HTMLElement} */ (b);
    const isActive = btn.dataset.layer === layer;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

/** @param {number} speed */
function syncSpeedButtonsDom(speed) {
  document.querySelectorAll(".speed-btn").forEach((el) => {
    const btn = /** @type {HTMLElement} */ (el);
    const isActive = parseFloat(btn.dataset.speed || "1") === speed;
    btn.classList.toggle("bg-[#36383e]", isActive);
    btn.classList.toggle("text-[#f2efe9]", isActive);
    btn.classList.toggle("text-stone-500", !isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

/** @param {boolean} open */
function syncDrawerDom(open) {
  const drawer = document.getElementById("generatorDrawer");
  if (drawer) {
    drawer.classList.toggle("hidden", !open);
    drawer.toggleAttribute("inert", !open);
  }
  document
    .getElementById("toggleDrawerBtn")
    ?.setAttribute("aria-expanded", String(open));
}

store.subscribe(
  (s) => s.activeLayer,
  (layer) => {
    postToRenderWorker({ type: "SET_VIEW_STATE", activeLayer: layer });
    syncLayerButtonsDom(layer);
  },
);

store.subscribe(
  (s) => s.simSpeed,
  (speed) => {
    postToRenderWorker({ type: "SET_VIEW_STATE", simSpeed: speed });
    syncSpeedButtonsDom(speed);
  },
);

store.subscribe(
  (s) => s.drawerOpen,
  (open) => {
    postToRenderWorker({ type: "SET_VIEW_STATE", drawerOpen: open });
    syncDrawerDom(open);
  },
);

/**
 * Triggers off-thread procedural world generation and OffscreenCanvas scene preparation.
 *
 * @param {boolean} [preserveCamera=false]
 * @param {boolean} [preserveUrlHydration=false]
 * @returns {Promise<WorldSummary | null>}
 */
export function rebuildWorld(
  preserveCamera = false,
  preserveUrlHydration = false,
) {
  updateAirportSliderLabel();
  const badgeEl = document.getElementById("genTimeBadge");
  if (badgeEl) badgeEl.textContent = "Worker…";

  const cfg = getGeneratorConfig();
  if (!worldWorker) return Promise.resolve(null);

  if (preserveUrlHydration) {
    const st = store.getState();
    /** @type {EntityRef | null} */
    const inspectedRef =
      st.inspected.type && st.inspected.id != null
        ? { kind: st.inspected.type, id: st.inspected.id }
        : null;
    postToRenderWorker({
      type: "SET_VIEW_STATE",
      hydratedCamera: st.camera,
      inspectedRef,
    });
  } else if (!preserveCamera) {
    postToRenderWorker({
      type: "SET_VIEW_STATE",
      hydratedCamera: null,
      inspectedRef: null,
    });
  }

  return new Promise((resolve) => {
    const reqId = nextRequestId++;
    latestBuildRequestId = reqId;
    if (!workerBusy) {
      dispatchToWorldWorker({
        requestId: reqId,
        config: cfg,
        preserveCamera,
        preserveUrlHydration,
        resolvers: [resolve],
      });
    } else if (pendingJob) {
      pendingJob.requestId = reqId;
      pendingJob.config = cfg;
      pendingJob.preserveCamera = pendingJob.preserveCamera && preserveCamera;
      pendingJob.preserveUrlHydration =
        pendingJob.preserveUrlHydration || preserveUrlHydration;
      pendingJob.resolvers.push(resolve);
    } else {
      pendingJob = {
        requestId: reqId,
        config: cfg,
        preserveCamera,
        preserveUrlHydration,
        resolvers: [resolve],
      };
    }
  });
}

window.rebuildWorld = rebuildWorld;

/**
 * Tracks viewport size without mutating `canvas.width` / `canvas.height` on `main.js`.
 */
function handleViewportResize() {
  breakLiveFollow();
  const nextW = Math.max(1, window.innerWidth);
  const nextH = Math.max(1, window.innerHeight);
  if (nextW === cameraController.width && nextH === cameraController.height) {
    return;
  }

  cameraController.setViewport(nextW, nextH);
  postToRenderWorker({ type: "RESIZE", width: nextW, height: nextH });

  if (currentWorldSummary) {
    const storeCam = store.getState().camera;
    if (storeCam) {
      cameraController.applyWorldCenter(
        storeCam.cx,
        storeCam.cy,
        storeCam.zoom,
        currentWorldSummary.tileSize,
      );
    } else {
      cameraController.fitToWorld(currentWorldSummary);
    }
    postCameraToWorker(false);
  }
}

window.addEventListener("resize", handleViewportResize);
if (typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(handleViewportResize);
  ro.observe(canvas);
}

// Multi-Touch Pinch-to-Zoom, Pan & Tap Inspection on Canvas
/** @type {Map<number, { x: number, y: number }>} */
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
  breakLiveFollow();
  userMovedCameraDuringBuild = true;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {}

  if (activePointers.size === 1) {
    isDragging = true;
    hadMultiTouch = false;
    dragStart.x = e.clientX - cameraController.x;
    dragStart.y = e.clientY - cameraController.y;
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
    if (currentWorldSummary && e.target === canvas && !hoverInFlight) {
      const { wx, wy } = cameraController.screenToWorld(
        e.clientX,
        e.clientY,
        currentWorldSummary.tileSize,
      );
      hoverInFlight = true;
      postToRenderWorker({ type: "HOVER_AT", wx, wy, pad: 0 });
    }
    return;
  }

  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 2) {
    userMovedCameraDuringBuild = true;
    const m = getTwoPointerMetrics();
    const scaleFactor = m.dist / (lastPinchDist || m.dist);
    const prevZoom = cameraController.zoom;
    const newZoom = Math.max(0.16, Math.min(3.5, prevZoom * scaleFactor));
    cameraController.x =
      m.midX - (lastPinchMid.x - cameraController.x) * (newZoom / prevZoom);
    cameraController.y =
      m.midY - (lastPinchMid.y - cameraController.y) * (newZoom / prevZoom);
    cameraController.zoom = newZoom;
    lastPinchDist = m.dist;
    lastPinchMid = { x: m.midX, y: m.midY };
    postCameraToWorker(true);
  } else if (activePointers.size === 1 && isDragging) {
    userMovedCameraDuringBuild = true;
    const pt = activePointers.values().next().value;
    if (pt) {
      cameraController.x = pt.x - dragStart.x;
      cameraController.y = pt.y - dragStart.y;
      postCameraToWorker(true);
    }
  }
});

/**
 * @param {PointerEvent} e
 */
function handlePointerEnd(e) {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.delete(e.pointerId);

  if (activePointers.size === 1) {
    const remaining = activePointers.values().next().value;
    if (remaining) {
      dragStart.x = remaining.x - cameraController.x;
      dragStart.y = remaining.y - cameraController.y;
    }
    return;
  }

  if (activePointers.size === 0) {
    const wasDragging = isDragging;
    const wasMultiTouch = hadMultiTouch;
    isDragging = false;
    hadMultiTouch = false;

    if (wasMultiTouch) {
      syncStoreCameraFromController(false);
      return;
    }

    if (wasDragging) {
      const tapThreshold = e.pointerType === "touch" ? 12 : 6;
      const moveDist = Math.hypot(
        e.clientX - pointerDownPos.x,
        e.clientY - pointerDownPos.y,
      );

      if (moveDist >= tapThreshold) {
        syncStoreCameraFromController(false);
        return;
      }

      if (currentWorldSummary) {
        const { wx, wy } = cameraController.screenToWorld(
          e.clientX,
          e.clientY,
          currentWorldSummary.tileSize,
        );
        const touchPad = e.pointerType === "touch" ? 2.2 : 0;
        const tapId = nextRpcId++;
        pendingTaps.set(tapId, {
          clientX: e.clientX,
          clientY: e.clientY,
          pointerType: e.pointerType,
        });
        postToRenderWorker({
          type: "TAP_AT",
          tapId,
          wx,
          wy,
          pad: touchPad,
          isMobile: window.innerWidth < 640,
        });
      }
    }
  }
}

window.addEventListener("pointerup", handlePointerEnd);
window.addEventListener("pointercancel", handlePointerEnd);

/** @type {ReturnType<typeof setTimeout> | null} */
let wheelEndTimer = null;

function cancelWheelEndTimer() {
  if (wheelEndTimer !== null) {
    clearTimeout(wheelEndTimer);
    wheelEndTimer = null;
  }
}

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    breakLiveFollow();
    userMovedCameraDuringBuild = true;

    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      dy *= 28;
    } else if (e.deltaMode === 2) {
      dy *= window.innerHeight;
    }

    if (!Number.isFinite(dy) || Math.abs(dy) < 0.001) return;

    const clampedDy = Math.max(-120, Math.min(120, dy));
    const zoomFactor = Math.exp(-clampedDy * 0.0008);
    cameraController.zoomAroundPoint(zoomFactor, e.clientX, e.clientY);
    postCameraToWorker(true);

    if (wheelEndTimer) clearTimeout(wheelEndTimer);
    wheelEndTimer = setTimeout(() => {
      wheelEndTimer = null;
      syncStoreCameraFromController(false);
    }, 150);
  },
  { passive: false },
);

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    clearSelection(true);
    return;
  }
  if (document.activeElement && document.activeElement.tagName === "INPUT") {
    return;
  }
  const panStep = 40;
  let didPanOrZoom = false;
  if (e.key === "ArrowLeft") {
    cameraController.x += panStep;
    didPanOrZoom = true;
  } else if (e.key === "ArrowRight") {
    cameraController.x -= panStep;
    didPanOrZoom = true;
  } else if (e.key === "ArrowUp") {
    cameraController.y += panStep;
    didPanOrZoom = true;
  } else if (e.key === "ArrowDown") {
    cameraController.y -= panStep;
    didPanOrZoom = true;
  } else if (e.key === "+" || e.key === "=") {
    cameraController.zoomAroundPoint(
      1.18,
      cameraController.width * 0.5,
      cameraController.height * 0.5,
    );
    didPanOrZoom = true;
  } else if (e.key === "-") {
    cameraController.zoomAroundPoint(
      0.84,
      cameraController.width * 0.5,
      cameraController.height * 0.5,
    );
    didPanOrZoom = true;
  }
  if (didPanOrZoom) {
    breakLiveFollow();
    userMovedCameraDuringBuild = true;
    postCameraToWorker(true);
    syncStoreCameraFromController(false);
  }
});

/**
 * Fits camera to world bounds and resets stored camera override.
 */
function fitCameraToWorld() {
  cancelWheelEndTimer();
  breakLiveFollow();
  userMovedCameraDuringBuild = true;
  if (currentWorldSummary) {
    cameraController.fitToWorld(currentWorldSummary);
    postCameraToWorker(true);
  } else {
    postToRenderWorker({ type: "FIT_CAMERA" });
  }
  store.setCamera(null);
  updateUrl(false);
}

// UI Control Bindings
document.getElementById("toggleDrawerBtn")?.addEventListener("click", () => {
  const nextOpen = !store.getState().drawerOpen;
  store.setDrawerOpen(nextOpen);
  updateUrl(false);
  if (nextOpen && window.innerWidth < 640) {
    clearSelection(false);
  }
});

document
  .getElementById("closeDrawerMobileBtn")
  ?.addEventListener("click", () => {
    store.setDrawerOpen(false);
    updateUrl(false);
  });

document.getElementById("resetViewBtn")?.addEventListener("click", () => {
  fitCameraToWorld();
  if (window.innerWidth < 640) {
    store.setDrawerOpen(false);
  }
});

document.getElementById("zoomInBtn")?.addEventListener("click", () => {
  breakLiveFollow();
  userMovedCameraDuringBuild = true;
  cameraController.zoomAroundPoint(
    1.25,
    cameraController.width * 0.5,
    cameraController.height * 0.5,
  );
  postCameraToWorker(true);
  syncStoreCameraFromController(false);
});

document.getElementById("zoomOutBtn")?.addEventListener("click", () => {
  breakLiveFollow();
  userMovedCameraDuringBuild = true;
  cameraController.zoomAroundPoint(
    0.8,
    cameraController.width * 0.5,
    cameraController.height * 0.5,
  );
  postCameraToWorker(true);
  syncStoreCameraFromController(false);
});

document.getElementById("hudFitBtn")?.addEventListener("click", () => {
  fitCameraToWorld();
});

getEl("randomSeedBtn").addEventListener("click", () => {
  cancelWheelEndTimer();
  const prefixes = ["METRO", "DELTA", "TYCOON", "AIRWAY", "VALLEY", "HARBOR"];
  const p = prefixes[Math.floor(Math.random() * prefixes.length)];
  const num = Math.floor(100 + Math.random() * 900);
  const newSeed = `${p}-${num}`;
  getInput("seedInput").value = newSeed;
  store.setCamera(null);
  store.setInspected(null, null);
  store.patchConfig({ seed: newSeed });
  updateUrl(true);
  void rebuildWorld(false);
});

/**
 * Commits a new seed string from `#seedInput`.
 *
 * @param {HTMLInputElement} inp
 */
function commitSeedInput(inp) {
  cancelWheelEndTimer();
  const newSeed = sanitizeSeed(inp.value);
  inp.value = newSeed;
  if (newSeed !== store.getState().config.seed) {
    store.setCamera(null);
    store.setInspected(null, null);
    store.patchConfig({ seed: newSeed });
    updateUrl(true);
    void rebuildWorld(false);
  }
}

getInput("seedInput").addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter") {
    const inp = /** @type {HTMLInputElement} */ (e.target);
    commitSeedInput(inp);
    inp.blur();
  }
});

getInput("seedInput").addEventListener("change", (e) => {
  commitSeedInput(/** @type {HTMLInputElement} */ (e.target));
});

getSelect("archetypeSelect").addEventListener("change", (e) => {
  cancelWheelEndTimer();
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  store.setCamera(null);
  store.setInspected(null, null);
  store.setArchetype(sel.value);
  syncDomInputsFromConfig(store.getState().config);
  updateUrl(true);
  void rebuildWorld(false);
});

getSelect("worldSizeSelect").addEventListener("change", (e) => {
  cancelWheelEndTimer();
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  const def = WORLD_SIZE_DEFAULTS[sel.value];
  store.setCamera(null);
  store.setInspected(null, null);
  if (def) {
    getInput("sliderTowns").value = String(def.towns);
    getInput("sliderAirports").value = String(def.airports);
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
  void rebuildWorld(false);
});

getSelect("terrainAlgoSelect").addEventListener("change", (e) => {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  store.patchConfig({ terrainAlgo: sel.value });
  updateUrl(false);
  void rebuildWorld(true);
});

getSelect("hydrologyAlgoSelect").addEventListener("change", (e) => {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  store.patchConfig({ hydrologyAlgo: sel.value });
  updateUrl(false);
  void rebuildWorld(true);
});

getSelect("airportMixSelect").addEventListener("change", (e) => {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  store.patchConfig({ airportMix: sel.value });
  updateUrl(false);
  void rebuildWorld(true);
});

getInput("toggleInterRamps").addEventListener("change", (e) => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  store.patchConfig({ includeIntermediateRamps: inp.checked });
  updateUrl(false);
  void rebuildWorld(true);
});

/** @type {Array<[string, keyof GeneratorConfig]>} */
const RANGE_SLIDER_BINDINGS = [
  ["sliderWater", "waterCoverage"],
  ["sliderTowns", "townCount"],
  ["sliderDensity", "buildingDensity"],
  ["sliderAirports", "airportCount"],
  ["sliderWind", "windAxis"],
  ["sliderRelief", "terrainRelief"],
  ["sliderIncision", "valleyIncision"],
  ["sliderEmbayment", "coastalEmbayment"],
  ["sliderCaldera", "calderaCurvature"],
  ["sliderBarrier", "barrierFragmentation"],
  ["sliderBasins", "basinCount"],
];

for (const [sliderId, configKey] of RANGE_SLIDER_BINDINGS) {
  const sliderEl = getInput(sliderId);
  sliderEl.addEventListener("input", (e) => {
    const inp = /** @type {HTMLInputElement} */ (e.target);
    store.patchConfig({ [configKey]: parseInt(inp.value, 10) });
    void rebuildWorld(true);
  });
  sliderEl.addEventListener("change", (e) => {
    const inp = /** @type {HTMLInputElement} */ (e.target);
    store.patchConfig({ [configKey]: parseInt(inp.value, 10) });
    updateUrl(false);
  });
}

document
  .getElementById("resetGeoScalarsBtn")
  ?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    store.resetArchetypeScalars();
    syncDomInputsFromConfig(store.getState().config);
    updateUrl(false);
    void rebuildWorld(true);
  });

document.querySelectorAll(".layer-btn").forEach((el) => {
  const btn = /** @type {HTMLElement} */ (el);
  btn.addEventListener("click", () => {
    const layer = /** @type {ViewLayer} */ (btn.dataset.layer || "aesthetic");
    store.setActiveLayer(layer);
    updateUrl(false);
  });
});

document.querySelectorAll(".speed-btn").forEach((el) => {
  const btn = /** @type {HTMLElement} */ (el);
  btn.addEventListener("click", () => {
    const speed = parseFloat(btn.dataset.speed || "1");
    store.setSimSpeed(speed);
    updateUrl(false);
  });
});

window.addEventListener("popstate", () => {
  cancelWheelEndTimer();
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

    /** @type {EntityRef | null} */
    const poppedRef =
      popped.inspected.type && popped.inspected.id != null
        ? { kind: popped.inspected.type, id: popped.inspected.id }
        : null;

    postToRenderWorker({
      type: "SET_VIEW_STATE",
      activeLayer: popped.activeLayer,
      simSpeed: popped.simSpeed,
      drawerOpen: popped.drawerOpen,
      hydratedCamera: popped.camera,
      inspectedRef: poppedRef,
    });

    if (configChanged) {
      void rebuildWorld(false, true);
    } else if (currentWorldSummary) {
      if (popped.camera) {
        cameraController.applyWorldCenter(
          popped.camera.cx,
          popped.camera.cy,
          popped.camera.zoom,
          currentWorldSummary.tileSize,
        );
        postCameraToWorker(true);
      } else {
        cameraController.fitToWorld(currentWorldSummary);
        postCameraToWorker(true);
      }

      if (poppedRef) {
        void selectEntityRef(poppedRef, popped.camera === null, false, true);
      } else {
        clearSelection(false);
      }
    }
  } finally {
    isRestoringFromHistory = false;
  }
});

/** @type {AppBridge} */
const appBridge = {
  isReady() {
    return Boolean(currentWorldSummary && displayListsReady);
  },
  getWorldSummary() {
    return currentWorldSummary;
  },
  getStoreState() {
    return store.getState();
  },
  getCamera() {
    const ts = currentWorldSummary?.tileSize || 12;
    const { cx, cy, zoom } = cameraController.toWorldCenter(ts);
    return {
      x: cameraController.x,
      y: cameraController.y,
      zoom,
      cx,
      cy,
    };
  },
  getActiveLayer() {
    return store.getState().activeLayer;
  },
  hasDisplayLists() {
    return displayListsReady;
  },
  async renderAtZooms(zooms) {
    if (!renderSimWorker || !currentWorldSummary) return false;
    const { W, H, tileSize } = currentWorldSummary;
    let allOk = true;
    for (const z of zooms) {
      const clampedZ = Math.max(0.16, Math.min(3.5, z));
      const x = cameraController.width * 0.5 - W * 0.5 * tileSize * clampedZ;
      const y = cameraController.height * 0.5 - H * 0.5 * tileSize * clampedZ;
      cameraController.x = x;
      cameraController.y = y;
      cameraController.zoom = clampedZ;
      const requestId = nextRpcId++;
      const ok = await new Promise((resolve) => {
        pendingTestRenderResolvers.set(requestId, resolve);
        postToRenderWorker({
          type: "TEST_RENDER_AT_CAMERA",
          requestId,
          x,
          y,
          zoom: clampedZ,
        });
      });
      if (!ok) allOk = false;
    }
    return allOk;
  },
  selectEntity(kind, id, shouldFocus = false) {
    return selectEntityRef({ kind, id }, shouldFocus, true);
  },
  stepSimulation(ticks, dt = 0.1, speed = 1.0) {
    if (!renderSimWorker) {
      return Promise.resolve({ tripsCompleted: 0, simTime: 0 });
    }
    const requestId = nextRpcId++;
    return new Promise((resolve) => {
      pendingTestStepResolvers.set(requestId, resolve);
      postToRenderWorker({
        type: "TEST_STEP_SIM",
        requestId,
        ticks,
        dt,
        speed,
      });
    });
  },
  rebuildWorld(preserveCamera = false, preserveUrlHydration = false) {
    return rebuildWorld(preserveCamera, preserveUrlHydration);
  },
};

window.appBridge = appBridge;

function initApp() {
  const st = store.getState();
  syncDomInputsFromConfig(st.config);
  syncDrawerDom(st.drawerOpen);
  syncLayerButtonsDom(st.activeLayer);
  syncSpeedButtonsDom(st.simSpeed);
  document.getElementById("inspectorCard")?.toggleAttribute("inert", true);

  initWorkers();
  void rebuildWorld(false, true);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
