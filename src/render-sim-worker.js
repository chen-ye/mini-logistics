/**
 * Dedicated 60fps `OffscreenCanvas` Renderer & 60Hz `LogisticsSimulator` Web Worker.
 *
 * Owns `MiniMotorwaysRenderer`, `Path2D` `VectorLayerRecorder` display lists,
 * `LogisticsSimulator`, entity hit-testing, dossier snapshots, and live vehicle follow-cam.
 *
 * @import {
 *   CameraTarget,
 *   DossierSnapshot,
 *   EntityRef,
 *   MainToRenderMessage,
 *   SelectionPayload,
 *   WorldSummary,
 *   WorldToRenderMessage,
 * } from "./types.js"
 * @import { ProceduralLogisticsWorld } from "./world-generator.js"
 */

import { hydrateTransferredWorld } from "./world-generator.js";
import { LogisticsSimulator } from "./simulator.js";
import { MiniMotorwaysRenderer } from "./renderer.js";
import { CameraController } from "./camera-controller.js";
import {
  getEntityCameraTarget,
  getEntityDefinition,
  hitTestEntities,
  resolveEntityByRef,
} from "./entities/index.js";

const workerSelf = /** @type {DedicatedWorkerGlobalScope} */ (
  /** @type {unknown} */ (self)
);

const GOOGLE_FONTS_CSS_URL =
  "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400..800;1,9..40,400..800&family=JetBrains+Mono:wght@500;700&display=swap";

/** @type {OffscreenCanvas | null} */
let offscreenCanvas = null;
/** @type {MiniMotorwaysRenderer | null} */
let renderer = null;
/** @type {ProceduralLogisticsWorld | null} */
let currentWorld = null;
/** @type {LogisticsSimulator | null} */
let simulator = null;
/** @type {MessagePort | null} */
let worldPort = null;

const cameraCtrl = new CameraController(1280, 800);
let simSpeed = 1;
/** @type {EntityRef | null} */
let selectedRef = null;
/** @type {CameraTarget | null} */
let hydratedCamera = null;
let followLiveActive = false;
/** @type {{ width: number, height: number } | null} */
let pendingResize = null;
let loopStarted = false;
let lastFrameTime = 0;
let lastHudTickTime = 0;

/**
 * Loads DM Sans and JetBrains Mono into `self.fonts` asynchronously when available.
 * Silently no-ops when offline or in restricted headless environments.
 */
async function loadWorkerFonts() {
  try {
    if (
      typeof FontFace === "undefined" ||
      !workerSelf.fonts ||
      typeof fetch !== "function" ||
      (typeof navigator !== "undefined" && !navigator.onLine)
    ) {
      return;
    }

    const res = await fetch(GOOGLE_FONTS_CSS_URL);
    if (!res.ok) return;
    const cssText = await res.text();
    const blockRegex = /@font-face\s*\{([^}]+)\}/g;
    /** @type {Promise<FontFace>[]} */
    const loads = [];
    let match;
    while ((match = blockRegex.exec(cssText)) !== null) {
      const block = match[1];
      const fam = block.match(/font-family:\s*['"]?([^;'"]+)['"]?/)?.[1];
      const srcUrl = block.match(/src:\s*url\(([^)]+)\)/)?.[1];
      if (!fam || !srcUrl) continue;
      const cleanUrl = srcUrl.replace(/^['"]|['"]$/g, "");
      const style = block.match(/font-style:\s*([^;]+)/)?.[1]?.trim();
      const weight = block.match(/font-weight:\s*([^;]+)/)?.[1]?.trim();
      const unicodeRange = block.match(/unicode-range:\s*([^;]+)/)?.[1]?.trim();
      /** @type {FontFaceDescriptors} */
      const descriptors = {};
      if (style) descriptors.style = style;
      if (weight) descriptors.weight = weight;
      if (unicodeRange) descriptors.unicodeRange = unicodeRange;
      const face = new FontFace(fam.trim(), `url(${cleanUrl})`, descriptors);
      loads.push(face.load());
    }

    const settled = await Promise.allSettled(loads);
    const fontSet = /** @type {any} */ (workerSelf.fonts);
    for (const item of settled) {
      if (item.status === "fulfilled" && typeof fontSet.add === "function") {
        fontSet.add(item.value);
      }
    }
  } catch {
    // Graceful no-op when offline or blocked in headless environments
  }
}

/**
 * Applies any queued resize dimensions synchronously right before drawing.
 */
function flushPendingResize() {
  if (!pendingResize) return;
  cameraCtrl.setViewport(pendingResize.width, pendingResize.height);
  if (offscreenCanvas) {
    offscreenCanvas.width = pendingResize.width;
    offscreenCanvas.height = pendingResize.height;
  }
  pendingResize = null;
}

/**
 * Copies `cameraCtrl` state into `renderer.camera`.
 */
function syncRendererCameraFromCtrl() {
  if (!renderer) return;
  renderer.camera.x = cameraCtrl.x;
  renderer.camera.y = cameraCtrl.y;
  renderer.camera.zoom = cameraCtrl.zoom;
}

/**
 * Copies `renderer.camera` state into `cameraCtrl`.
 */
function syncCtrlFromRendererCamera() {
  if (!renderer) return;
  cameraCtrl.x = renderer.camera.x;
  cameraCtrl.y = renderer.camera.y;
  cameraCtrl.zoom = renderer.camera.zoom;
}

/**
 * Checks whether all 6 retained Path2D display lists are populated on `renderer`.
 *
 * @returns {boolean}
 */
function areDisplayListsReady() {
  return Boolean(
    renderer &&
    renderer.hydroDisplayList &&
    renderer.urbanTerrainDisplayList &&
    renderer.surfaceNetworkDisplayList &&
    renderer.motorwayDisplayList &&
    renderer.overpassBridgeDisplayList &&
    renderer.airwayDisplayList,
  );
}

/**
 * Synthesizes a `WorldSummary` if one was not attached to the message.
 *
 * @param {ProceduralLogisticsWorld} world
 * @returns {WorldSummary}
 */
function buildFallbackSummary(world) {
  return {
    W: world.W,
    H: world.H,
    tileSize: world.tileSize,
    seed: world.config.seed || "",
    config: world.config,
    wallTimeMs: world.wallTimeMs ?? world.genTimeMs,
    genTimeMs: world.genTimeMs,
    reusedThroughStage: world.reusedThroughStage,
    housesCount: world.houses.length,
    destinationsCount: world.destinations.length,
    towns: world.towns.map((t) => ({
      id: t.id,
      name: t.name,
      tier: t.tier,
      x: t.x,
      y: t.y,
      urbanRadius: t.urbanRadius,
    })),
    airports: world.airports.map((a) => ({
      id: a.id,
      code: a.iata,
      name: a.name,
      tier: a.tier,
      airportClass: a.airportClass,
      x: a.x,
      y: a.y,
      halfLen: a.halfLen,
    })),
    systemInterchangeCount: world.interchanges.filter(
      (i) => i.type === "cloverleaf" || i.type === "trumpet",
    ).length,
    diamondRampCount: world.interchanges.filter(
      (i) => i.type === "diamond-ramp",
    ).length,
    logs: world.logs,
  };
}

/**
 * Resolves an `EntityRef` and builds its dossier snapshot and camera target.
 *
 * @param {EntityRef | null | undefined} ref
 * @param {ProceduralLogisticsWorld | null} world
 * @param {LogisticsSimulator | null} sim
 * @returns {{
 *   entity: any,
 *   ref: EntityRef,
 *   dossier: DossierSnapshot | null,
 *   cameraTarget: CameraTarget
 * } | null}
 */
function buildSelectionSnapshot(ref, world, sim) {
  if (!ref || !ref.kind || ref.id == null || !world) return null;
  const entity = resolveEntityByRef(ref, world, sim);
  if (!entity) return null;
  const def = getEntityDefinition(ref.kind);
  const dossier = def?.inspect?.renderDossier
    ? def.inspect.renderDossier(entity, world, sim)
    : null;
  const cameraTarget = getEntityCameraTarget(ref.kind, entity, world);
  const canonicalId = entity.id ?? ref.id;
  return {
    entity,
    ref: { kind: ref.kind, id: canonicalId },
    dossier,
    cameraTarget,
  };
}

/**
 * Computes incremental live telemetry patch for the currently selected entity.
 *
 * @param {EntityRef | null} ref
 * @param {any} entity
 * @returns {Record<string, any> | null}
 */
function computeLivePatch(ref, entity) {
  if (!ref || !entity || !currentWorld) return null;
  const def = getEntityDefinition(ref.kind);
  if (!def?.inspect?.describeLivePatch) return null;
  const patch = def.inspect.describeLivePatch(entity, currentWorld, simulator);
  return patch && Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Handles `WORLD_READY` transferred directly over `MessageChannel` from `world-worker.js`.
 *
 * @param {MessageEvent<WorldToRenderMessage>} event
 */
function handleWorldPortMessage(event) {
  const msg = event.data;
  if (!msg || msg.type !== "WORLD_READY") return;

  flushPendingResize();
  currentWorld = hydrateTransferredWorld(msg.world);
  simulator = new LogisticsSimulator(currentWorld);

  if (renderer) {
    renderer.prepareDisplayLists(currentWorld);
  }

  const effHydratedCam = hydratedCamera;

  if (msg.preserveUrlHydration && effHydratedCam) {
    cameraCtrl.applyWorldCenter(
      effHydratedCam.cx,
      effHydratedCam.cy,
      effHydratedCam.zoom,
      currentWorld.tileSize,
    );
    syncRendererCameraFromCtrl();
  } else if (!msg.preserveCamera) {
    if (renderer) {
      renderer.fitCamera(currentWorld);
      syncCtrlFromRendererCamera();
    } else {
      cameraCtrl.fitToWorld(currentWorld);
    }
  }

  const effInspectedRef = selectedRef;
  /** @type {SelectionPayload | null} */
  let selectionPayload = null;

  if (msg.preserveUrlHydration && effInspectedRef) {
    const snap = buildSelectionSnapshot(
      effInspectedRef,
      currentWorld,
      simulator,
    );
    if (snap) {
      selectedRef = snap.ref;
      const shouldFocus = effHydratedCam === null;
      followLiveActive =
        shouldFocus &&
        Boolean(snap.cameraTarget.followLive) &&
        (snap.ref.kind === "plane" || snap.ref.kind === "truck");
      if (shouldFocus) {
        const isMob = msg.isMobile ?? cameraCtrl.width < 640;
        cameraCtrl.focusOnTarget(
          snap.cameraTarget,
          currentWorld.tileSize,
          isMob,
        );
        syncRendererCameraFromCtrl();
      }
      selectionPayload = {
        found: true,
        ref: snap.ref,
        dossier: snap.dossier,
        cameraTarget: snap.cameraTarget,
        focusedCamera: shouldFocus,
      };
    } else {
      selectedRef = null;
      followLiveActive = false;
      selectionPayload = {
        found: false,
        ref: null,
        dossier: null,
        cameraTarget: null,
        focusedCamera: false,
      };
    }
  } else if (!msg.preserveCamera) {
    selectedRef = null;
    followLiveActive = false;
    selectionPayload = {
      found: false,
      ref: null,
      dossier: null,
      cameraTarget: null,
      focusedCamera: false,
    };
  } else if (selectedRef) {
    const snap = buildSelectionSnapshot(selectedRef, currentWorld, simulator);
    if (snap) {
      selectedRef = snap.ref;
      selectionPayload = {
        found: true,
        ref: snap.ref,
        dossier: snap.dossier,
        cameraTarget: snap.cameraTarget,
        focusedCamera: false,
      };
    } else {
      selectedRef = null;
      followLiveActive = false;
      selectionPayload = {
        found: false,
        ref: null,
        dossier: null,
        cameraTarget: null,
        focusedCamera: false,
      };
    }
  }

  const resolvedSel = selectedRef
    ? resolveEntityByRef(selectedRef, currentWorld, simulator)
    : null;
  if (renderer) {
    renderer.render(currentWorld, simulator, resolvedSel);
  }

  const summary = msg.worldSummary || buildFallbackSummary(currentWorld);
  workerSelf.postMessage({
    type: "SCENE_APPLIED",
    requestId: msg.requestId,
    preserveCamera: Boolean(msg.preserveCamera),
    worldSummary: summary,
    camera: {
      x: cameraCtrl.x,
      y: cameraCtrl.y,
      zoom: cameraCtrl.zoom,
    },
    displayListsReady: areDisplayListsReady(),
    tripsCompleted: simulator.tripsCompleted,
    simTime: simulator.simTime,
    selectionPayload,
  });
}

/**
 * Schedules the next frame using worker `requestAnimationFrame` with 16ms timer fallback.
 *
 * @param {(now: number) => void} cb
 */
function scheduleNextFrame(cb) {
  if (typeof workerSelf.requestAnimationFrame === "function") {
    workerSelf.requestAnimationFrame(cb);
  } else {
    setTimeout(() => cb(performance.now()), 16);
  }
}

/**
 * Runs the 60fps simulation & OffscreenCanvas rendering loop.
 *
 * @param {number} now
 */
function tickFrame(now) {
  const rawDt = lastFrameTime > 0 ? (now - lastFrameTime) / 1000 : 1 / 60;
  const dt = Math.min(0.05, Math.max(0, rawDt));
  lastFrameTime = now;

  flushPendingResize();

  if (currentWorld && simulator && renderer) {
    simulator.update(dt, simSpeed);

    const selectedEntity = selectedRef
      ? resolveEntityByRef(selectedRef, currentWorld, simulator)
      : null;

    /** @type {{ x: number, y: number, zoom: number } | null} */
    let liveCamera = null;
    if (
      selectedEntity &&
      selectedRef &&
      followLiveActive &&
      (selectedRef.kind === "plane" || selectedRef.kind === "truck")
    ) {
      const target = getEntityCameraTarget(
        selectedRef.kind,
        selectedEntity,
        currentWorld,
      );
      const ex = target.x ?? target.cx ?? 0;
      const ey = target.y ?? target.cy ?? 0;
      const isMob = cameraCtrl.width < 640;
      const yBias = isMob ? cameraCtrl.height * 0.36 : cameraCtrl.height * 0.5;
      const xBias = !isMob ? cameraCtrl.width * 0.46 : cameraCtrl.width * 0.5;
      const desiredX =
        xBias - (ex + 0.5) * currentWorld.tileSize * renderer.camera.zoom;
      const desiredY =
        yBias - (ey + 0.5) * currentWorld.tileSize * renderer.camera.zoom;
      const alpha = Math.min(1, Math.max(0.18, dt * 12));
      renderer.camera.x += (desiredX - renderer.camera.x) * alpha;
      renderer.camera.y += (desiredY - renderer.camera.y) * alpha;
      syncCtrlFromRendererCamera();
      liveCamera = {
        x: renderer.camera.x,
        y: renderer.camera.y,
        zoom: renderer.camera.zoom,
      };
      workerSelf.postMessage({
        type: "CAMERA_FOLLOW_TICK",
        x: renderer.camera.x,
        y: renderer.camera.y,
        zoom: renderer.camera.zoom,
      });
    }

    renderer.render(currentWorld, simulator, selectedEntity);

    if (now - lastHudTickTime >= 95) {
      lastHudTickTime = now;
      const livePatch = computeLivePatch(selectedRef, selectedEntity);
      workerSelf.postMessage({
        type: "HUD_TICK",
        tripsCompleted: simulator.tripsCompleted,
        simTime: simulator.simTime,
        livePatch,
        liveCamera,
      });
    }
  }

  scheduleNextFrame(tickFrame);
}

function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  lastFrameTime = performance.now();
  scheduleNextFrame(tickFrame);
}

workerSelf.addEventListener(
  "message",
  /** @param {MessageEvent<MainToRenderMessage>} event */ (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "INIT": {
        offscreenCanvas = msg.canvas;
        offscreenCanvas.width = Math.max(1, msg.width);
        offscreenCanvas.height = Math.max(1, msg.height);
        cameraCtrl.setViewport(msg.width, msg.height);

        renderer = new MiniMotorwaysRenderer(offscreenCanvas);
        renderer.activeLayer = msg.activeLayer || "aesthetic";
        renderer.drawerOpen = msg.drawerOpen ?? true;
        simSpeed = msg.simSpeed ?? 1;
        hydratedCamera = msg.camera ?? null;
        selectedRef = msg.inspectedRef ?? null;

        const port = msg.worldPort || event.ports?.[0] || null;
        if (port) {
          worldPort = port;
          worldPort.addEventListener("message", handleWorldPortMessage);
          worldPort.start();
        }

        void loadWorkerFonts();
        startLoop();
        break;
      }

      case "RESIZE": {
        pendingResize = {
          width: Math.max(1, msg.width),
          height: Math.max(1, msg.height),
        };
        cameraCtrl.setViewport(msg.width, msg.height);
        break;
      }

      case "SET_CAMERA": {
        cameraCtrl.x = msg.x;
        cameraCtrl.y = msg.y;
        cameraCtrl.zoom = msg.zoom;
        syncRendererCameraFromCtrl();
        if (msg.breakFollow !== false) {
          followLiveActive = false;
        }
        break;
      }

      case "FIT_CAMERA": {
        flushPendingResize();
        followLiveActive = false;
        if (currentWorld && renderer) {
          renderer.fitCamera(currentWorld);
          syncCtrlFromRendererCamera();
          workerSelf.postMessage({
            type: "CAMERA_UPDATED",
            requestId: msg.requestId,
            camera: {
              x: renderer.camera.x,
              y: renderer.camera.y,
              zoom: renderer.camera.zoom,
            },
          });
        }
        break;
      }

      case "SET_VIEW_STATE": {
        if (msg.activeLayer !== undefined && renderer) {
          renderer.activeLayer = msg.activeLayer;
        }
        if (msg.simSpeed !== undefined) {
          simSpeed = msg.simSpeed;
        }
        if (msg.drawerOpen !== undefined && renderer) {
          renderer.drawerOpen = msg.drawerOpen;
        }
        if (msg.hydratedCamera !== undefined) {
          hydratedCamera = msg.hydratedCamera;
        }
        if (msg.inspectedRef !== undefined) {
          selectedRef = msg.inspectedRef;
          if (!selectedRef) followLiveActive = false;
        }
        break;
      }

      case "HOVER_AT": {
        const hit = currentWorld
          ? hitTestEntities(
              msg.wx,
              msg.wy,
              msg.pad || 0,
              currentWorld,
              simulator,
            )
          : null;
        workerSelf.postMessage({
          type: "HOVER_CURSOR",
          cursor: hit ? "pointer" : "grab",
        });
        break;
      }

      case "TAP_AT": {
        const hit = currentWorld
          ? hitTestEntities(
              msg.wx,
              msg.wy,
              msg.pad || 0,
              currentWorld,
              simulator,
            )
          : null;
        if (hit && currentWorld) {
          /** @type {EntityRef} */
          const ref = { kind: hit.kind, id: hit.id };
          const snap = buildSelectionSnapshot(ref, currentWorld, simulator);
          selectedRef = snap ? snap.ref : ref;
          followLiveActive = Boolean(
            snap?.cameraTarget.followLive &&
            (ref.kind === "plane" || ref.kind === "truck"),
          );
          if (renderer && simulator) {
            flushPendingResize();
            renderer.render(currentWorld, simulator, hit.entity);
          }
          workerSelf.postMessage({
            type: "TAP_RESULT",
            tapId: msg.tapId,
            hit: true,
            ref: selectedRef,
            dossier: snap?.dossier ?? null,
            cameraTarget: snap?.cameraTarget ?? null,
          });
        } else {
          selectedRef = null;
          followLiveActive = false;
          if (currentWorld && renderer && simulator) {
            flushPendingResize();
            renderer.render(currentWorld, simulator, null);
          }
          workerSelf.postMessage({
            type: "TAP_RESULT",
            tapId: msg.tapId,
            hit: false,
            ref: null,
            dossier: null,
            cameraTarget: null,
          });
        }
        break;
      }

      case "SELECT_REF": {
        flushPendingResize();
        if (!msg.ref) {
          selectedRef = null;
          followLiveActive = false;
          if (currentWorld && renderer && simulator) {
            renderer.render(currentWorld, simulator, null);
          }
          workerSelf.postMessage({
            type: "SELECTION_APPLIED",
            requestId: msg.requestId,
            found: false,
            ref: null,
            dossier: null,
            camera: renderer
              ? {
                  x: renderer.camera.x,
                  y: renderer.camera.y,
                  zoom: renderer.camera.zoom,
                }
              : null,
            focused: false,
            pushHistory: Boolean(msg.pushHistory),
            fromHistory: Boolean(msg.fromHistory),
          });
          break;
        }

        const snap = buildSelectionSnapshot(msg.ref, currentWorld, simulator);
        if (snap && currentWorld) {
          selectedRef = snap.ref;
          const shouldFocus = Boolean(msg.shouldFocus);
          followLiveActive =
            shouldFocus &&
            Boolean(snap.cameraTarget.followLive) &&
            (snap.ref.kind === "plane" || snap.ref.kind === "truck");
          if (shouldFocus) {
            cameraCtrl.focusOnTarget(
              snap.cameraTarget,
              currentWorld.tileSize,
              Boolean(msg.isMobile),
            );
            syncRendererCameraFromCtrl();
          }
          if (renderer && simulator) {
            renderer.render(currentWorld, simulator, snap.entity);
          }
          workerSelf.postMessage({
            type: "SELECTION_APPLIED",
            requestId: msg.requestId,
            found: true,
            ref: snap.ref,
            dossier: snap.dossier,
            camera: {
              x: cameraCtrl.x,
              y: cameraCtrl.y,
              zoom: cameraCtrl.zoom,
            },
            focused: shouldFocus,
            pushHistory: Boolean(msg.pushHistory),
            fromHistory: Boolean(msg.fromHistory),
          });
        } else {
          selectedRef = null;
          followLiveActive = false;
          if (currentWorld && renderer && simulator) {
            renderer.render(currentWorld, simulator, null);
          }
          workerSelf.postMessage({
            type: "SELECTION_APPLIED",
            requestId: msg.requestId,
            found: false,
            ref: null,
            dossier: null,
            camera: renderer
              ? {
                  x: renderer.camera.x,
                  y: renderer.camera.y,
                  zoom: renderer.camera.zoom,
                }
              : null,
            focused: false,
            pushHistory: Boolean(msg.pushHistory),
            fromHistory: Boolean(msg.fromHistory),
          });
        }
        break;
      }

      case "FOCUS_SELECTED": {
        if (!selectedRef || !currentWorld) break;
        const entity = resolveEntityByRef(selectedRef, currentWorld, simulator);
        if (!entity) break;
        flushPendingResize();
        const target = getEntityCameraTarget(
          selectedRef.kind,
          entity,
          currentWorld,
        );
        followLiveActive =
          Boolean(target.followLive) &&
          (selectedRef.kind === "plane" || selectedRef.kind === "truck");
        cameraCtrl.focusOnTarget(
          target,
          currentWorld.tileSize,
          Boolean(msg.isMobile),
        );
        syncRendererCameraFromCtrl();
        if (renderer && simulator) {
          renderer.render(currentWorld, simulator, entity);
        }
        workerSelf.postMessage({
          type: "CAMERA_UPDATED",
          camera: {
            x: cameraCtrl.x,
            y: cameraCtrl.y,
            zoom: cameraCtrl.zoom,
          },
          commitToStore: true,
        });
        break;
      }

      case "TEST_RENDER_AT_CAMERA": {
        flushPendingResize();
        if (!currentWorld || !renderer || !simulator) {
          workerSelf.postMessage({
            type: "TEST_RENDER_DONE",
            requestId: msg.requestId,
            displayListsReady: false,
          });
          break;
        }
        followLiveActive = false;
        cameraCtrl.x = msg.x;
        cameraCtrl.y = msg.y;
        cameraCtrl.zoom = msg.zoom;
        syncRendererCameraFromCtrl();
        const resolvedSel = selectedRef
          ? resolveEntityByRef(selectedRef, currentWorld, simulator)
          : null;
        renderer.render(currentWorld, simulator, resolvedSel);
        workerSelf.postMessage({
          type: "TEST_RENDER_DONE",
          requestId: msg.requestId,
          displayListsReady: areDisplayListsReady(),
        });
        break;
      }

      case "TEST_STEP_SIM": {
        flushPendingResize();
        if (!currentWorld || !simulator) {
          workerSelf.postMessage({
            type: "TEST_STEP_DONE",
            requestId: msg.requestId,
            tripsCompleted: 0,
            simTime: 0,
            livePatch: null,
          });
          break;
        }
        const ticks = Math.max(0, Math.floor(msg.ticks || 0));
        const stepDt = msg.dt ?? 0.1;
        const stepSpeed = msg.speed ?? 1.0;
        for (let i = 0; i < ticks; i++) {
          simulator.update(stepDt, stepSpeed);
        }
        const resolvedSel = selectedRef
          ? resolveEntityByRef(selectedRef, currentWorld, simulator)
          : null;
        if (renderer) {
          renderer.render(currentWorld, simulator, resolvedSel);
        }
        const livePatch = computeLivePatch(selectedRef, resolvedSel);
        workerSelf.postMessage({
          type: "TEST_STEP_DONE",
          requestId: msg.requestId,
          tripsCompleted: simulator.tripsCompleted,
          simTime: simulator.simTime,
          livePatch,
        });
        break;
      }
    }
  },
);
