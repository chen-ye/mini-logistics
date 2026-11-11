/**
 * 2D Procedural Cartography and Multi-Modal Logistics Vector Canvas Renderer.
 *
 * Horizontal Z-plane coordinator delegating entity recording, live sprite passes,
 * selection highlights, and analysis overlays to vertical domain modules.
 *
 * Invariants:
 * - 100% Worker-safe and OffscreenCanvas-compatible: zero window, document, or DOM references.
 * - Exact 13-step Z-order sequence preserved across all 6 view layers.
 * - Zero render-side mutations: never initializes or mutates ap.atc.
 *
 * @import {
 *   ViewLayer,
 *   EntityRef,
 *   InspectedEntity
 * } from './types.js'
 * @import { ProceduralLogisticsWorld } from './world-generator.js'
 */
import { PALETTE } from "./palette.js";
import { WORLD_GEOMETRY } from "./constants.js";
import { CameraController } from "./camera-controller.js";
import {
  VectorLayerRecorder,
  Path2DCtor,
  buildVignelliWaterPath,
  drawArchitectureGrid,
  drawTaperingRivers,
  drawTrees,
} from "./canvas-layer-cache.js";
import { resolveEntityByRef } from "./entities/index.js";
import {
  recordAirportGroundPads,
  recordAirportStructures,
  recordAirwayCorridors,
  drawAirportSolverOverlay,
  drawAirportSelectionHighlight,
} from "./entities/airport/render.js";
import {
  recordFarmBackgroundFields,
  getOrBuildArablePaths,
} from "./entities/farm-estate/render.js";
import {
  recordBuildingsAndHouses,
  drawRCIZoneUnderlay,
  drawRCICargoChainOverlay,
  drawBuildingSelectionHighlight,
} from "./entities/rci-building/render.js";
import {
  recordMotorwaysLower,
  recordOverpassBridges,
  traceMotorwaySamples,
  buildCoalescedGroundShadowPath,
  drawInterchangesUnderlay,
} from "./entities/interchange/render.js";
import {
  recordUrbanBlush,
  drawHierarchyOverlay,
  drawTownSelectionHighlight,
} from "./entities/town/render.js";
import {
  drawCarsZPass,
  drawTruckSelectionHighlight,
} from "./entities/road-vehicle/render.js";
import {
  drawPlanesZPass,
  drawAirplaneSilhouette,
  drawPlaneSelectionHighlight,
} from "./entities/aircraft/render.js";
import {
  recordSurfaceRoadNetwork,
  drawRoundaboutCentralIsland,
  traceSmoothPath,
} from "./render/road-network-layer.js";
import {
  drawHydrologyOverlay,
  drawRoadGridUnderlay,
  drawRoadGridGraphOverlay,
  drawRCIScreenLegend,
  drawRoadGridScreenLegend,
  computeRoadGraphDiagnostics,
} from "./render/diagnostic-overlays.js";

/***************************************************************************
 * MINI MOTORWAYS / MINI METRO CANVAS VECTOR RENDERER (Z-PLANE COORDINATOR)
 ***************************************************************************/
export class MiniMotorwaysRenderer {
  /**
   * @param {HTMLCanvasElement | OffscreenCanvas | null} [canvas=null]
   */
  constructor(canvas = null) {
    /** @type {HTMLCanvasElement | OffscreenCanvas | null} */
    this.canvas = canvas;
    /** @type {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null} */
    this.ctx = canvas ? canvas.getContext("2d") : null;
    /** @type {{ x: number, y: number, zoom: number }} */
    this.camera = { x: 0, y: 0, zoom: 1 };
    /** @type {ViewLayer | string} */
    this.activeLayer = "aesthetic";
    /** @type {boolean} */
    this.drawerOpen = true;

    /** @type {{ contourLayers: Array<{ fill: string, stroke: string, cPath: Path2D, cEdgePath: Path2D }>, waterPath: Path2D, waterEdgePath: Path2D } | null} */
    this._cachedVectorPaths = null;
    /** @type {number} */
    this._cachedVectorHydroVersion = -1;
    /** @type {{ elevRef: Float32Array | null, waterRef: Uint8Array | null, ts: number, arableFillPath: Path2D | null, arableStrokePath: Path2D | null } | null} */
    this._cachedArablePaths = null;
    /** @type {{ world: ProceduralLogisticsWorld | null, diag: any }} */
    this._cachedRoadDiagCache = { world: null, diag: null };

    // 6 Retained Vector Display Lists (`VectorLayerRecorder`)
    /** @type {{ key: string, contours: VectorLayerRecorder, water: VectorLayerRecorder, replay: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => void } | null} */
    this.hydroDisplayList = null;
    /** @type {{ worldRef: ProceduralLogisticsWorld | null, ts: number, blush: VectorLayerRecorder, treesAndFarms: VectorLayerRecorder, replay: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => void } | null} */
    this.urbanTerrainDisplayList = null;
    /** @type {{ worldRef: ProceduralLogisticsWorld | null, isRCI: boolean, ts: number, recorder: VectorLayerRecorder, replay: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => void } | null} */
    this.surfaceNetworkDisplayList = null;
    /** @type {{ worldRef: ProceduralLogisticsWorld | null, ts: number, recorder: VectorLayerRecorder, replay: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => void } | null} */
    this.motorwayDisplayList = null;
    /** @type {{ worldRef: ProceduralLogisticsWorld | null, ts: number, recorder: VectorLayerRecorder, replay: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => void } | null} */
    this.overpassBridgeDisplayList = null;
    /** @type {{ worldRef: ProceduralLogisticsWorld | null, ts: number, recorder: VectorLayerRecorder, replay: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => void } | null} */
    this.airwayDisplayList = null;

    // Cached screen-space radial vignette gradient
    /** @type {CanvasGradient | null} */
    this._vignetteGrad = null;
    /** @type {number} */
    this._vignetteW = -1;
    /** @type {number} */
    this._vignetteH = -1;
  }

  get _cachedRoadDiagWorld() {
    return this._cachedRoadDiagCache.world;
  }
  set _cachedRoadDiagWorld(w) {
    this._cachedRoadDiagCache.world = w;
  }
  get _cachedRoadDiag() {
    return this._cachedRoadDiagCache.diag;
  }
  set _cachedRoadDiag(d) {
    this._cachedRoadDiagCache.diag = d;
  }

  /**
   * Fits camera zoom and center offsets to current viewport dimensions.
   *
   * @param {ProceduralLogisticsWorld} world
   */
  fitCamera(world) {
    if (!this.canvas) return;
    const ctrl = new CameraController(this.canvas.width, this.canvas.height);
    ctrl.fitToWorld(world);
    this.camera.x = ctrl.x;
    this.camera.y = ctrl.y;
    this.camera.zoom = ctrl.zoom;
  }

  /**
   * Delegates to shared Vignelli-style 45°/90° Octilinear Marching-Squares Polygonizer.
   *
   * @param {ProceduralLogisticsWorld} world
   * @param {number} ts
   * @param {number | ((cx: number, cy: number) => boolean) | null} [customTestFn=null]
   * @param {Path2D | null} [outStrokePath=null]
   * @returns {Path2D}
   */
  buildVignelliWaterPath(world, ts, customTestFn = null, outStrokePath = null) {
    return buildVignelliWaterPath(
      world.W,
      world.H,
      world.waterMask,
      world.elevationField,
      ts,
      customTestFn,
      outStrokePath,
    );
  }

  /**
   * Builds or reuses the retained hydrology display list.
   *
   * @param {ProceduralLogisticsWorld} world
   */
  ensureHydroDisplayList(world) {
    const ts = world.tileSize;
    const pw = world.W * ts;
    const ph = world.H * ts;
    const key = `${world.hydroVersion}:${world.W}:${world.H}:${ts}:${world.seaLevel}`;
    if (this.hydroDisplayList && this.hydroDisplayList.key === key) {
      return this.hydroDisplayList;
    }

    const canReuseVectorPaths =
      this._cachedVectorPaths !== null &&
      this._cachedVectorHydroVersion === world.hydroVersion;
    let contourLayers;
    let waterPath;
    let waterEdgePath;

    if (canReuseVectorPaths && this._cachedVectorPaths) {
      ({ contourLayers, waterPath, waterEdgePath } = this._cachedVectorPaths);
    } else {
      contourLayers = [];
      for (const { dh, fill, stroke } of WORLD_GEOMETRY.CONTOUR_TERRACES) {
        const thresh = world.seaLevel + dh;
        const cEdgePath = new Path2DCtor();
        const cPath = this.buildVignelliWaterPath(world, ts, thresh, cEdgePath);
        contourLayers.push({ fill, stroke, cPath, cEdgePath });
      }
      waterEdgePath = new Path2DCtor();
      waterPath = this.buildVignelliWaterPath(world, ts, null, waterEdgePath);
      this._cachedVectorPaths = { contourLayers, waterPath, waterEdgePath };
      this._cachedVectorHydroVersion = world.hydroVersion;
    }

    const contoursRec = new VectorLayerRecorder();
    contoursRec.fillStyle = PALETTE.bgPaper;
    contoursRec.fillRect(0, 0, pw, ph);
    drawArchitectureGrid(contoursRec, pw, ph, ts);

    contoursRec.nextLayerPass();
    contoursRec.lineJoin = "bevel";
    contoursRec.lineWidth = 1.2;
    for (const { fill, stroke, cPath, cEdgePath } of contourLayers) {
      contoursRec.fillStyle = fill;
      contoursRec.fill(cPath);
      contoursRec.strokeStyle = stroke;
      contoursRec.stroke(cEdgePath);
      contoursRec.nextLayerPass();
    }

    const waterRec = new VectorLayerRecorder();
    waterRec.lineCap = "butt";
    waterRec.lineJoin = "bevel";
    waterRec.strokeStyle = PALETTE.bgPaper;
    waterRec.lineWidth = ts * 1.45;
    waterRec.stroke(waterEdgePath);
    waterRec.fillStyle = PALETTE.bgPaper;
    waterRec.fill(waterPath);

    waterRec.nextLayerPass();
    drawTaperingRivers(waterRec, world.rivers, ts);

    waterRec.nextLayerPass();
    waterRec.fillStyle = PALETTE.waterCyan;
    waterRec.fill(waterPath);

    this.hydroDisplayList = {
      key,
      contours: contoursRec,
      water: waterRec,
      replay(ctx) {
        contoursRec.replay(ctx);
        waterRec.replay(ctx);
      },
    };
    return this.hydroDisplayList;
  }

  /**
   * Builds or reuses the retained urban/woodland/farm terrain display list.
   *
   * @param {ProceduralLogisticsWorld} world
   */
  ensureUrbanTerrainDisplayList(world) {
    const ts = world.tileSize;
    if (
      this.urbanTerrainDisplayList &&
      this.urbanTerrainDisplayList.worldRef === world &&
      this.urbanTerrainDisplayList.ts === ts
    ) {
      return this.urbanTerrainDisplayList;
    }

    const blushRec = new VectorLayerRecorder();
    recordUrbanBlush(blushRec, world, ts);

    const treesAndFarmsRec = new VectorLayerRecorder();
    drawTrees(treesAndFarmsRec, world.trees, ts);
    treesAndFarmsRec.nextLayerPass();

    if (!this._cachedArablePaths) {
      this._cachedArablePaths = {
        elevRef: null,
        waterRef: null,
        ts: -1,
        arableFillPath: null,
        arableStrokePath: null,
      };
    }
    recordFarmBackgroundFields(
      treesAndFarmsRec,
      world,
      ts,
      this._cachedArablePaths,
    );

    this.urbanTerrainDisplayList = {
      worldRef: world,
      ts,
      blush: blushRec,
      treesAndFarms: treesAndFarmsRec,
      replay(ctx) {
        treesAndFarmsRec.replay(ctx);
      },
    };
    return this.urbanTerrainDisplayList;
  }

  /**
   * Builds or reuses the retained surface network display list.
   *
   * @param {ProceduralLogisticsWorld} world
   */
  ensureSurfaceNetworkDisplayList(world) {
    const ts = world.tileSize;
    const isRCI = this.activeLayer === "rci";
    if (
      this.surfaceNetworkDisplayList &&
      this.surfaceNetworkDisplayList.worldRef === world &&
      this.surfaceNetworkDisplayList.isRCI === isRCI &&
      this.surfaceNetworkDisplayList.ts === ts
    ) {
      return this.surfaceNetworkDisplayList;
    }

    const rec = new VectorLayerRecorder();
    recordAirportGroundPads(rec, world, ts);
    rec.nextLayerPass();
    recordSurfaceRoadNetwork(rec, world, ts);
    rec.nextLayerPass();
    recordBuildingsAndHouses(rec, world, ts, isRCI);
    rec.nextLayerPass();
    recordAirportStructures(rec, world, ts);

    this.surfaceNetworkDisplayList = {
      worldRef: world,
      isRCI,
      ts,
      recorder: rec,
      replay(ctx) {
        rec.replay(ctx);
      },
    };
    return this.surfaceNetworkDisplayList;
  }

  /**
   * Builds or reuses the retained motorway display list.
   *
   * @param {ProceduralLogisticsWorld} world
   */
  ensureMotorwayDisplayList(world) {
    const ts = world.tileSize;
    if (
      this.motorwayDisplayList &&
      this.motorwayDisplayList.worldRef === world &&
      this.motorwayDisplayList.ts === ts
    ) {
      return this.motorwayDisplayList;
    }

    const rec = new VectorLayerRecorder();
    recordMotorwaysLower(rec, world, ts);

    this.motorwayDisplayList = {
      worldRef: world,
      ts,
      recorder: rec,
      replay(ctx) {
        rec.replay(ctx);
      },
    };
    return this.motorwayDisplayList;
  }

  /**
   * Builds or reuses the retained overpass bridge display list.
   *
   * @param {ProceduralLogisticsWorld} world
   */
  ensureOverpassBridgeDisplayList(world) {
    const ts = world.tileSize;
    if (
      this.overpassBridgeDisplayList &&
      this.overpassBridgeDisplayList.worldRef === world &&
      this.overpassBridgeDisplayList.ts === ts
    ) {
      return this.overpassBridgeDisplayList;
    }

    const rec = new VectorLayerRecorder();
    recordOverpassBridges(rec, world, ts);

    this.overpassBridgeDisplayList = {
      worldRef: world,
      ts,
      recorder: rec,
      replay(ctx) {
        rec.replay(ctx);
      },
    };
    return this.overpassBridgeDisplayList;
  }

  /**
   * Builds or reuses the retained airway corridors display list.
   *
   * @param {ProceduralLogisticsWorld} world
   */
  ensureAirwayDisplayList(world) {
    const ts = world.tileSize;
    if (
      this.airwayDisplayList &&
      this.airwayDisplayList.worldRef === world &&
      this.airwayDisplayList.ts === ts
    ) {
      return this.airwayDisplayList;
    }

    const rec = new VectorLayerRecorder();
    recordAirwayCorridors(rec, world, ts);

    this.airwayDisplayList = {
      worldRef: world,
      ts,
      recorder: rec,
      replay(ctx) {
        rec.replay(ctx);
      },
    };
    return this.airwayDisplayList;
  }

  /**
   * Pre-builds all 6 retained display lists for `world`.
   *
   * @param {ProceduralLogisticsWorld} world
   */
  prepareDisplayLists(world) {
    this.ensureHydroDisplayList(world);
    this.ensureUrbanTerrainDisplayList(world);
    this.ensureSurfaceNetworkDisplayList(world);
    this.ensureMotorwayDisplayList(world);
    this.ensureOverpassBridgeDisplayList(world);
    this.ensureAirwayDisplayList(world);
  }

  /**
   * Renders the complete procedural logistics world and live simulation agents.
   *
   * @param {ProceduralLogisticsWorld} world
   * @param {any} sim
   * @param {InspectedEntity | EntityRef | null} [selection=null]
   */
  render(world, sim, selection = null) {
    const { ctx, canvas, camera } = this;
    if (!ctx || !canvas) return;
    const ts = world.tileSize;
    let resolvedSelection = selection;
    if (
      selection &&
      typeof selection === "object" &&
      "kind" in selection &&
      selection.kind
    ) {
      resolvedSelection = resolveEntityByRef(selection, world, sim) || null;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = PALETTE.bgPaper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    // 1 & 1B. Retained Hydrology, Urban Blush, Woodland Canopy & Farm Display Lists
    const hydroDL = this.ensureHydroDisplayList(world);
    const urbanDL = this.ensureUrbanTerrainDisplayList(world);
    hydroDL.contours.replay(ctx);
    urbanDL.blush.replay(ctx);
    hydroDL.water.replay(ctx);
    urbanDL.treesAndFarms.replay(ctx);

    // 2. Optional Diagnostic Overlay Underneath Roads/Buildings
    if (this.activeLayer === "hydrology") {
      drawHydrologyOverlay(ctx, world, ts);
    } else if (this.activeLayer === "airport") {
      drawAirportSolverOverlay(ctx, world, ts);
    } else if (this.activeLayer === "rci") {
      drawRCIZoneUnderlay(ctx, world, ts);
    } else if (this.activeLayer === "roadgrid") {
      drawRoadGridUnderlay(ctx, world, ts);
    }

    // 2B–5. Retained Surface Network Display List
    this.ensureSurfaceNetworkDisplayList(world).replay(ctx);

    // 6. Live Surface Road Vehicles & Ground-Taxiing Aircraft
    drawCarsZPass(ctx, world, sim, ts, "road");
    drawPlanesZPass(ctx, world, sim, ts, "ground", this.activeLayer);

    // 7. Retained Level-1 Motorway Display List
    this.ensureMotorwayDisplayList(world).replay(ctx);

    // 7B. Live Lower-Deck Motorway Vehicles
    drawCarsZPass(ctx, world, sim, ts, "motorway-lower");

    // 7C. Retained Level-2 Overpass Bridge Display List
    this.ensureOverpassBridgeDisplayList(world).replay(ctx);

    // 7D. Live Upper-Bridge Motorway Vehicles
    drawCarsZPass(ctx, world, sim, ts, "motorway-upper");

    // 8. Vector Graph Overlays
    if (this.activeLayer === "hierarchy") {
      drawHierarchyOverlay(ctx, world, ts);
    } else if (this.activeLayer === "rci") {
      drawRCICargoChainOverlay(ctx, world, ts, resolvedSelection, camera.zoom);
    } else if (this.activeLayer === "roadgrid") {
      drawRoadGridGraphOverlay(ctx, world, ts, this._cachedRoadDiagCache);
    }

    // 9. Retained Airway Corridors & Airborne Planes
    this.ensureAirwayDisplayList(world).replay(ctx);
    drawPlanesZPass(ctx, world, sim, ts, "air", this.activeLayer);

    // 10. Selection Highlight
    if (resolvedSelection) {
      this.drawSelectionHighlight(ctx, world, resolvedSelection, ts);
    }

    ctx.restore();

    // Soft paper vignette around screen edges
    if (
      !this._vignetteGrad ||
      this._vignetteW !== canvas.width ||
      this._vignetteH !== canvas.height
    ) {
      const grad = ctx.createRadialGradient(
        canvas.width * 0.5,
        canvas.height * 0.5,
        Math.min(canvas.width, canvas.height) * 0.38,
        canvas.width * 0.5,
        canvas.height * 0.5,
        Math.max(canvas.width, canvas.height) * 0.72,
      );
      grad.addColorStop(0, "rgba(242, 239, 233, 0)");
      grad.addColorStop(1, "rgba(54, 56, 62, 0.08)");
      this._vignetteGrad = grad;
      this._vignetteW = canvas.width;
      this._vignetteH = canvas.height;
    }
    ctx.fillStyle = this._vignetteGrad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (this.activeLayer === "rci") {
      drawRCIScreenLegend(
        ctx,
        world,
        canvas,
        this.drawerOpen,
        resolvedSelection,
      );
    } else if (this.activeLayer === "roadgrid") {
      drawRoadGridScreenLegend(
        ctx,
        world,
        canvas,
        this.drawerOpen,
        this._cachedRoadDiagCache,
      );
    }
  }

  /**
   * Highlights an inspected entity (Building, Airport, Town, Car, or Plane).
   *
   * @param {any} ctx
   * @param {ProceduralLogisticsWorld} world
   * @param {any} entityOrRef
   * @param {number} ts
   */
  drawSelectionHighlight(ctx, world, entityOrRef, ts) {
    if (!entityOrRef) return;

    let entity = entityOrRef;
    if (
      entityOrRef.kind &&
      (entityOrRef.id !== undefined || entityOrRef.entity)
    ) {
      entity =
        entityOrRef.entity ||
        resolveEntityByRef(entityOrRef, world) ||
        entityOrRef;
    }

    if (entity.zoneType === "industrial" || entity.zoneType === "commercial") {
      const arablePaths = getOrBuildArablePaths(
        world,
        ts,
        this._cachedArablePaths,
      );
      drawBuildingSelectionHighlight(
        ctx,
        world,
        entity,
        ts,
        arablePaths.arableFillPath,
      );
      return;
    }

    if (typeof entity.halfLen === "number") {
      drawAirportSelectionHighlight(ctx, world, entity, ts);
      return;
    }

    if (typeof entity.urbanRadius === "number") {
      drawTownSelectionHighlight(ctx, world, entity, ts);
      return;
    }

    if (entity.isFreightTruck !== undefined || entity.segIdx !== undefined) {
      drawTruckSelectionHighlight(ctx, world, entity, ts);
      return;
    }

    if (entity.altitude !== undefined || entity.aircraftType !== undefined) {
      drawPlaneSelectionHighlight(ctx, world, entity, ts);
    }
  }

  /**
   * Derives or retrieves road graph topology diagnostics.
   *
   * @param {ProceduralLogisticsWorld} world
   */
  computeRoadGraphDiagnostics(world) {
    return computeRoadGraphDiagnostics(world, this._cachedRoadDiagCache);
  }

  // =========================================================================
  // BACKWARD-COMPATIBLE DELEGATORS
  // =========================================================================
  drawRCIScreenLegend(ctx, world, canvas, selection = null) {
    drawRCIScreenLegend(ctx, world, canvas, this.drawerOpen, selection);
  }

  drawRoadGridScreenLegend(ctx, world, canvas) {
    drawRoadGridScreenLegend(
      ctx,
      world,
      canvas,
      this.drawerOpen,
      this._cachedRoadDiagCache,
    );
  }

  drawFarmBackgroundFields(ctx, world, ts) {
    recordFarmBackgroundFields(ctx, world, ts, this._cachedArablePaths);
  }

  _recordFarmBackgroundFields(ctx, world, ts) {
    recordFarmBackgroundFields(ctx, world, ts, this._cachedArablePaths);
  }

  drawAirportGroundPads(ctx, world, ts) {
    recordAirportGroundPads(ctx, world, ts);
  }

  drawRoadNetwork(ctx, world, ts) {
    recordSurfaceRoadNetwork(ctx, world, ts);
  }

  drawRoundaboutCentralIsland(ctx, x, y, rIsland, accentColor) {
    drawRoundaboutCentralIsland(ctx, x, y, rIsland, accentColor);
  }

  traceSmoothPath(ctx, pts, ts) {
    traceSmoothPath(ctx, pts, ts);
  }

  drawBuildings(ctx, world, ts) {
    recordBuildingsAndHouses(ctx, world, ts, this.activeLayer === "rci");
  }

  drawAirports(ctx, world, ts) {
    recordAirportStructures(ctx, world, ts);
  }

  drawMotorways(ctx, world, ts) {
    recordMotorwaysLower(ctx, world, ts);
  }

  drawOverpassBridges(ctx, world, ts) {
    recordOverpassBridges(ctx, world, ts);
  }

  drawAirwayCorridors(ctx, world, ts) {
    recordAirwayCorridors(ctx, world, ts);
  }

  drawCars(ctx, world, sim, ts, modeFilter = null) {
    drawCarsZPass(ctx, world, sim, ts, modeFilter);
  }

  drawPlanes(ctx, world, sim, ts, layerMode = null) {
    drawPlanesZPass(ctx, world, sim, ts, layerMode, this.activeLayer);
  }

  drawAirplaneSilhouette(
    ctx,
    x,
    y,
    ang,
    scale,
    fill,
    stroke = null,
    accentColor = null,
    isCargoFreighter = false,
    aircraftType = null,
  ) {
    drawAirplaneSilhouette(
      ctx,
      x,
      y,
      ang,
      scale,
      fill,
      stroke,
      accentColor,
      isCargoFreighter,
      aircraftType,
      this.activeLayer,
    );
  }

  drawAirportSolverOverlay(ctx, world, ts) {
    drawAirportSolverOverlay(ctx, world, ts);
  }

  drawRCIZoneUnderlay(ctx, world, ts) {
    drawRCIZoneUnderlay(ctx, world, ts);
  }

  drawRCICargoChainOverlay(ctx, world, ts, selection = null) {
    drawRCICargoChainOverlay(ctx, world, ts, selection, this.camera.zoom);
  }

  drawHierarchyOverlay(ctx, world, ts) {
    drawHierarchyOverlay(ctx, world, ts);
  }

  drawHydrologyOverlay(ctx, world, ts) {
    drawHydrologyOverlay(ctx, world, ts);
  }

  drawRoadGridUnderlay(ctx, world, ts) {
    drawRoadGridUnderlay(ctx, world, ts);
  }

  drawRoadGridGraphOverlay(ctx, world, ts) {
    drawRoadGridGraphOverlay(ctx, world, ts, this._cachedRoadDiagCache);
  }

  traceMotorwaySamples(ctx, samples, ts, oxOffset = 0, oyOffset = 0) {
    traceMotorwaySamples(ctx, samples, ts, oxOffset, oyOffset);
  }

  buildCoalescedGroundShadowPath(world, ts) {
    return buildCoalescedGroundShadowPath(world, ts);
  }

  drawInterchangesUnderlay(ctx, world, ts) {
    drawInterchangesUnderlay(ctx, world, ts);
  }
}
