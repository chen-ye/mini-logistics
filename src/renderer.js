/**
 * @import {
 *   ViewLayer,
 *   InspectedEntity,
 *   RoadGraphDiagnostics,
 *   PlaneEndpoint
 * } from './types.js'
 */
/** @import { ProceduralLogisticsWorld } from './world-generator.js' */
import { PALETTE } from "./palette.js";
import { WATER_MASK, WORLD_GEOMETRY } from "./constants.js";
import {
  VectorLayerRecorder,
  Path2DCtor,
  buildVignelliWaterPath,
  drawArchitectureGrid,
  drawTaperingRivers,
  drawTrees,
  drawUrbanBlushAndTrees,
  extrudeRibbonToPath2D,
} from "./canvas-layer-cache.js";
import {
  deriveRoadTopology,
  computeTrumpetRampBeziers,
} from "./vehicle-routing.js";
import { buildFlightTrack, initAirportATC } from "./simulator.js";

/**
 * @param {any} ctx
 * @param {number} idx
 */
function setSub(ctx, idx) {
  if (typeof ctx.setSubLayer === "function") {
    ctx.setSubLayer(idx);
  }
}

/**
 * @param {any} ctx
 */
function nextPass(ctx) {
  if (typeof ctx.nextLayerPass === "function") {
    ctx.nextLayerPass();
  }
}

/***************************************************************************
 * 5. MINI MOTORWAYS / MINI METRO CANVAS VECTOR RENDERER
 ***************************************************************************/
export class MiniMotorwaysRenderer {
  /**
   * @param {HTMLCanvasElement | null} [canvas]
   */
  constructor(canvas = null) {
    /** @type {HTMLCanvasElement | null} */
    this.canvas = canvas;
    /** @type {CanvasRenderingContext2D | null} */
    this.ctx = canvas ? canvas.getContext("2d") : null;
    /** @type {{ x: number, y: number, zoom: number }} */
    this.camera = { x: 0, y: 0, zoom: 1 };
    /** @type {ViewLayer | string} */
    this.activeLayer = "aesthetic";
    /** @type {InspectedEntity | null} */
    this.selectedEntity = null;
    /** @type {boolean} */
    this.drawerOpen = true;
    /** @type {{ contourLayers: Array<{ fill: string, stroke: string, cPath: Path2D, cEdgePath: Path2D }>, waterPath: Path2D, waterEdgePath: Path2D } | null} */
    this._cachedVectorPaths = null;
    /** @type {number} */
    this._cachedVectorHydroVersion = -1;
    /** @type {{ elevRef: Float32Array, waterRef: Uint8Array, ts: number, arableFillPath: Path2D, arableStrokePath: Path2D } | null} */
    this._cachedArablePaths = null;
    /** @type {ProceduralLogisticsWorld | null} */
    this._cachedRoadDiagWorld = null;
    /** @type {any} */
    this._cachedRoadDiag = null;

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

  /**
   * @param {ProceduralLogisticsWorld} world
   */
  fitCamera(world) {
    if (!this.canvas) return;
    const canvas = this.canvas;
    const ts = world.tileSize;
    const worldPxW = world.W * ts;
    const worldPxH = world.H * ts;

    // On portrait or small mobile viewports, fit the camera around the active metropolitan
    // bounding box (towns + airports) so the network fills the portrait screen legibly.
    if (
      (canvas.width < 640 || canvas.width < canvas.height) &&
      world.towns.length > 0
    ) {
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      for (const t of world.towns) {
        minX = Math.min(minX, t.x - t.urbanRadius - 4);
        maxX = Math.max(maxX, t.x + t.urbanRadius + 4);
        minY = Math.min(minY, t.y - t.urbanRadius - 4);
        maxY = Math.max(maxY, t.y + t.urbanRadius + 4);
      }
      for (const ap of world.airports) {
        minX = Math.min(minX, ap.x - ap.halfLen - 5);
        maxX = Math.max(maxX, ap.x + ap.halfLen + 5);
        minY = Math.min(minY, ap.y - ap.halfLen - 5);
        maxY = Math.max(maxY, ap.y + ap.halfLen + 5);
      }
      const boxW = Math.max(60, maxX - minX) * ts;
      const boxH = Math.max(50, maxY - minY) * ts;
      const cx = (minX + maxX) * 0.5 * ts;
      const cy = (minY + maxY) * 0.5 * ts;
      const scaleX = (canvas.width * 0.92) / boxW;
      const scaleY = (canvas.height * 0.78) / boxH;
      this.camera.zoom = Math.max(
        0.18,
        Math.min(1.25, Math.min(scaleX, scaleY)),
      );
      this.camera.x = canvas.width * 0.5 - cx * this.camera.zoom;
      this.camera.y = canvas.height * 0.52 - cy * this.camera.zoom;
      return;
    }

    const scaleX = canvas.width / worldPxW;
    const scaleY = canvas.height / worldPxH;
    // Fill viewport edge-to-edge on landscape screens so map-border bays & rivers bleed cleanly to the screen edge
    this.camera.zoom = Math.max(scaleX, scaleY);
    this.camera.x = (canvas.width - worldPxW * this.camera.zoom) * 0.5;
    this.camera.y = (canvas.height - worldPxH * this.camera.zoom) * 0.5;
  }

  /**
   * Pre-renders static terrain layers onto an offscreen canvas using a true
   * Vignelli-style 45°/90° Octilinear Marching-Squares Polygonizer (zero stippling!).
   * Delegates to the shared `buildVignelliWaterPath` implementation.
   *
   * @param {ProceduralLogisticsWorld} world
   * @param {number} ts
   * @param {number | ((cx: number, cy: number) => boolean) | null} [customTestFn]
   * @param {Path2D | null} [outStrokePath]
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
   * Builds or reuses the retained hydrology display list (`hydroDisplayList`:
   * paper grid + hypsometric contour terraces + open water & tapering rivers).
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
   * Builds or reuses the retained urban/woodland/farm terrain display list (`urbanTerrainDisplayList`).
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
    drawUrbanBlushAndTrees(
      blushRec,
      world.W,
      world.H,
      ts,
      world.zoneColorIdx,
      null,
    );

    const treesAndFarmsRec = new VectorLayerRecorder();
    drawTrees(treesAndFarmsRec, world.trees, ts);
    treesAndFarmsRec.nextLayerPass();
    this._recordFarmBackgroundFields(treesAndFarmsRec, world, ts);

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
   * Builds or reuses the retained surface network display list (`surfaceNetworkDisplayList`:
   * airport ground pads, unified road casings/guardrails/fills/roundabouts, houses, RCI buildings & airports).
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
    this.drawAirportGroundPads(rec, world, ts);
    rec.nextLayerPass();
    this.drawRoadNetwork(rec, world, ts);
    rec.nextLayerPass();
    this.drawBuildings(rec, world, ts);
    rec.nextLayerPass();
    this.drawAirports(rec, world, ts);

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
   * Builds or reuses the retained motorway display list (`motorwayDisplayList`:
   * cloverleaf/trumpet/diamond underlays, elevated motorway shadows/bores/decks/portals/shields, and overpass bridges).
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
    this.drawMotorways(rec, world, ts);

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
   * Builds or reuses the retained overpass bridge display list (`overpassBridgeDisplayList`:
   * clipped lower-deck drop shadows, upper bridge decks, core medians, and parapet rails for Cloverleaf & Trumpet overpasses).
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
    this.drawOverpassBridges(rec, world, ts);

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
   * Builds or reuses the retained airway corridors display list (`airwayDisplayList`:
   * subtle runway-aligned dashed airway arcs between airport pairs).
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
    this.drawAirwayCorridors(rec, world, ts);

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
   * Pre-builds all 6 retained `VectorLayerRecorder` display lists for `world`.
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

  render(world, sim) {
    const { ctx, canvas, camera } = this;
    if (!ctx || !canvas) return;
    const ts = world.tileSize;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = PALETTE.bgPaper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    // 1 & 1B. Replay Retained Hydrology, Urban Blush, Woodland Canopy & Farm Display Lists
    const hydroDL = this.ensureHydroDisplayList(world);
    const urbanDL = this.ensureUrbanTerrainDisplayList(world);
    hydroDL.contours.replay(ctx);
    urbanDL.blush.replay(ctx);
    hydroDL.water.replay(ctx);
    urbanDL.treesAndFarms.replay(ctx);

    // 2. Optional Diagnostic Overlay Underneath Roads/Buildings (Hydrology / Airport Heatmap / RCI Zones / Road Grid)
    if (this.activeLayer === "hydrology") {
      this.drawHydrologyOverlay(ctx, world, ts);
    } else if (this.activeLayer === "airport") {
      this.drawAirportSolverOverlay(ctx, world, ts);
    } else if (this.activeLayer === "rci") {
      this.drawRCIZoneUnderlay(ctx, world, ts);
    } else if (this.activeLayer === "roadgrid") {
      this.drawRoadGridUnderlay(ctx, world, ts);
    }

    // 2B–5. Replay Retained Surface Network Display List
    // (Airport Ground Aprons -> Unified Road Network -> Batched Houses & RCI Sinks -> Airports)
    this.ensureSurfaceNetworkDisplayList(world).replay(ctx);

    // 6. Draw Live Surface Road Vehicles (Commuter Cars + Articulated Freight Trucks on surface streets & roundabouts)
    this.drawCars(ctx, world, sim, ts, "road");
    this.drawPlanes(ctx, world, sim, ts, "ground");

    // 7. Replay Retained Level-1 Motorway Display List (Coalesced Ground Shadows, Ramps, Mainlines, Tunnels & Shields)
    this.ensureMotorwayDisplayList(world).replay(ctx);

    // 7B. Draw Live Lower-Deck Motorway Vehicles
    this.drawCars(ctx, world, sim, ts, "motorway-lower");

    // 7C. Replay Retained Level-2 Overpass Bridge Display List (Clipped Lower-Deck Shadow + Upper Bridge Deck & Parapets)
    this.ensureOverpassBridgeDisplayList(world).replay(ctx);

    // 7D. Draw Live Upper-Bridge Motorway Vehicles on Top of Overpass Bridges
    this.drawCars(ctx, world, sim, ts, "motorway-upper");

    // 8. Draw Central Place Hierarchy, RCI Cargo Chain, or Road Grid Vector Graph Overlay if active
    if (this.activeLayer === "hierarchy") {
      this.drawHierarchyOverlay(ctx, world, ts);
    } else if (this.activeLayer === "rci") {
      this.drawRCICargoChainOverlay(ctx, world, ts);
    } else if (this.activeLayer === "roadgrid") {
      this.drawRoadGridGraphOverlay(ctx, world, ts);
    }

    // 9. Draw Live Aircraft & Flight Corridors
    this.ensureAirwayDisplayList(world).replay(ctx);
    this.drawPlanes(ctx, world, sim, ts, "air");

    // 10. Highlight Selected Building, Farm Estate, Town or Airport + Active Supply-Chain Corridors
    if (this.selectedEntity) {
      this.drawSelectionHighlight(ctx, world, this.selectedEntity, ts);
    }

    ctx.restore();

    // Soft paper vignette around screen edges (cached on canvas dimensions)
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
      this.drawRCIScreenLegend(ctx, world, canvas);
    } else if (this.activeLayer === "roadgrid") {
      this.drawRoadGridScreenLegend(ctx, world, canvas);
    }
  }

  drawRCIScreenLegend(ctx, world, canvas) {
    const rci = world.rciCounts;
    const comCount = rci
      ? rci.com
      : world.destinations.filter((d) => d.zoneType === "commercial").length;
    const rawCount = rci
      ? rci.raw
      : world.destinations.filter(
          (d) => d.zoneType === "industrial" && d.subType === "RAW",
        ).length;
    const mfgCount = rci
      ? rci.mfg
      : world.destinations.filter(
          (d) => d.zoneType === "industrial" && d.subType === "MFG",
        ).length;
    const logCount = rci
      ? rci.log
      : world.destinations.filter(
          (d) => d.zoneType === "industrial" && d.subType === "LOG",
        ).length;

    ctx.save();
    const drawerOpen = canvas.width >= 640 && this.drawerOpen;
    const inspOpen = Boolean(this.selectedEntity);
    if (canvas.width < 640 && inspOpen) {
      ctx.restore();
      return;
    }
    const leftSafe = drawerOpen ? 412 : 14;
    const rightSafe = inspOpen ? 428 : 14;
    const boxW = Math.min(canvas.width - leftSafe - rightSafe, 960);
    if (boxW < 220) {
      ctx.restore();
      return;
    }
    const boxH = 38;
    const bx = leftSafe;
    const by = canvas.height - boxH - 14;

    ctx.fillStyle = "rgba(248, 246, 241, 0.92)";
    ctx.strokeStyle = "rgba(54, 56, 62, 0.16)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 11);
    ctx.fill();
    ctx.stroke();

    const links = world.cargoLinks || [];
    const cbdCount = links.filter((l) => l.stage === "CBD->CBD").length;
    const tradeCount = links.filter(
      (l) => l.stage?.includes("IMPORT") || l.stage?.includes("EXPORT"),
    ).length;

    const items = [
      { col: "#16a34a", label: `R Residential (${world.houses.length})` },
      { col: "#2563eb", label: `C CBD/Arterial (${comCount})` },
      { col: "#d97706", label: `RAW Extract (${rawCount})` },
      { col: "#ea580c", label: `MFG Factory (${mfgCount})` },
      { col: "#7c3aed", label: `LOG Hub (${logCount})` },
    ];
    if (cbdCount > 0) {
      items.push({ col: "#0284c7", label: `CBD B2B (${cbdCount})` });
    }
    if (tradeCount > 0) {
      items.push({ col: "#0d9488", label: `Trade Gateway (${tradeCount})` });
    }
    items.push({
      col: "#36383e",
      label: `${links.length} Freight Chains`,
    });

    ctx.font = "700 11px Inter, sans-serif";
    ctx.textBaseline = "middle";
    let curX = bx + 14;
    const midY = by + boxH * 0.5;
    for (const it of items) {
      if (curX + 95 > bx + boxW) break;
      ctx.fillStyle = it.col;
      ctx.beginPath();
      ctx.roundRect(curX, midY - 5, 10, 10, 3);
      ctx.fill();
      curX += 15;
      ctx.fillStyle = "#36383e";
      ctx.fillText(it.label, curX, midY + 0.5);
      curX += ctx.measureText(it.label).width + 15;
    }
    ctx.restore();
  }

  drawFarmBackgroundFields(ctx, world, ts) {
    if (ctx instanceof VectorLayerRecorder) {
      this._recordFarmBackgroundFields(ctx, world, ts);
      return;
    }
    const rec = new VectorLayerRecorder();
    this._recordFarmBackgroundFields(rec, world, ts);
    rec.replay(ctx);
  }

  /**
   * Records farm background fields into a `VectorLayerRecorder` with:
   * 1) A single global `(allFarmsClipPath ∩ arableFillPath)` clip across all farm estates,
   * 2) A single `arableStrokePath` stroke across all farms,
   * 3) `||` bounding-box corridor culling against each farm's `estateBBox`,
   * 4) Color-batched `Path2D`s for parcel fills, furrows, orchard dots, borders, tractor tracks, and windbreaks.
   *
   * @param {VectorLayerRecorder | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
   * @param {ProceduralLogisticsWorld} world
   * @param {number} ts
   */
  _recordFarmBackgroundFields(ctx, world, ts) {
    const farms = [];
    for (const d of world.destinations) {
      if (
        d.resourceType === "FARM" &&
        d.bspParcels &&
        d.bspParcels.length > 0
      ) {
        farms.push(d);
      }
    }
    if (farms.length === 0) return;

    const cropStyles = {
      wheat: { fill: "#eee7d6", furrow: "#e4dcc7", border: "#dcd2ba" },
      pasture: { fill: "#e6ecdd", furrow: "#dce4d1", border: "#d4ddc7" },
      ochre: { fill: "#eee2d2", furrow: "#e4d5c1", border: "#dccab4" },
      loam: { fill: "#eae4d9", furrow: "#dfd8cc", border: "#d6cec0" },
      orchard: { fill: "#e4ebdd", furrow: "#9fb38e", border: "#d2dcc8" },
    };

    if (
      !this._cachedArablePaths ||
      this._cachedArablePaths.elevRef !== world.elevationField ||
      this._cachedArablePaths.waterRef !== world.waterMask ||
      this._cachedArablePaths.ts !== ts
    ) {
      const arableStrokePath = new Path2DCtor();
      const arableFillPath = this.buildVignelliWaterPath(
        world,
        ts,
        (cx, cy) => {
          const id = cy * world.W + cx;
          return (
            world.waterMask[id] === WATER_MASK.DRY &&
            world.distToWater[id] >= 1.8 &&
            world.elevationField[id] < world.seaLevel + 0.13
          );
        },
        arableStrokePath,
      );
      this._cachedArablePaths = {
        elevRef: world.elevationField,
        waterRef: world.waterMask,
        ts,
        arableFillPath,
        arableStrokePath,
      };
    }
    const { arableFillPath, arableStrokePath } = this._cachedArablePaths;

    // 1. Build a single union clip path across all farm BSP parcels on the map
    const allFarmsClipPath = new Path2DCtor();
    const farmBBoxes = [];
    for (let fIdx = 0; fIdx < farms.length; fIdx++) {
      const d = farms[fIdx];
      const parcels = d.bspParcels || [];
      let minX = d.gx,
        minY = d.gy,
        maxX = d.gx + 2,
        maxY = d.gy + 2;
      for (let pIdx = 0; pIdx < parcels.length; pIdx++) {
        const p = parcels[pIdx];
        if (p.x0 < minX) minX = p.x0;
        if (p.y0 < minY) minY = p.y0;
        if (p.x1 > maxX) maxX = p.x1;
        if (p.y1 > maxY) maxY = p.y1;
        allFarmsClipPath.rect(
          p.x0 * ts - 1.0,
          p.y0 * ts - 1.0,
          (p.x1 - p.x0) * ts + 2.0,
          (p.y1 - p.y0) * ts + 2.0,
        );
      }
      farmBBoxes.push(d.estateBBox || { minX, minY, maxX, maxY });
    }

    ctx.save();
    ctx.clip(allFarmsClipPath);
    ctx.clip(arableFillPath);

    for (let fIdx = 0; fIdx < farms.length; fIdx++) {
      const d = farms[fIdx];
      const parcels = d.bspParcels || [];
      const tracks = d.tractorTracks || [];
      const isNearTrackPx = (ox, oy) => {
        for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
          const tr = tracks[tIdx];
          const x0 = tr.x0 * ts,
            y0 = tr.y0 * ts;
          const x1 = tr.x1 * ts,
            y1 = tr.y1 * ts;
          const dx = x1 - x0,
            dy = y1 - y0;
          const lenSq = dx * dx + dy * dy;
          let t = lenSq > 1e-6 ? ((ox - x0) * dx + (oy - y0) * dy) / lenSq : 0;
          t = Math.max(0, Math.min(1, t));
          if (Math.hypot(ox - (x0 + t * dx), oy - (y0 + t * dy)) < 6.2)
            return true;
        }
        return false;
      };

      for (let pIdx = 0; pIdx < parcels.length; pIdx++) {
        const p = parcels[pIdx];
        const st = cropStyles[p.crop] || cropStyles.wheat;
        const px = p.x0 * ts;
        const py = p.y0 * ts;
        const pw = (p.x1 - p.x0) * ts;
        const ph = (p.y1 - p.y0) * ts;
        if (pw <= 4 || ph <= 4) continue;

        setSub(ctx, 0);
        ctx.fillStyle = st.fill;
        ctx.fillRect(px - 0.25, py - 0.25, pw + 0.5, ph + 0.5);

        setSub(ctx, 1);
        if (p.crop === "orchard") {
          const step = 6.6;
          let rowIdx = 0;
          ctx.fillStyle = st.furrow;
          ctx.beginPath();
          for (let oy = py + 5.6; oy < py + ph - 4.6; oy += step, rowIdx++) {
            const xShift = (rowIdx % 2) * (step * 0.45);
            for (let ox = px + 5.6 + xShift; ox < px + pw - 4.6; ox += step) {
              if (isNearTrackPx(ox, oy)) continue;
              ctx.moveTo(ox + 1.55, oy);
              ctx.arc(ox, oy, 1.55, 0, Math.PI * 2);
            }
          }
          ctx.fill();
        } else {
          const furrowStep = 4.8;
          ctx.strokeStyle = st.furrow;
          ctx.lineWidth = 0.95;
          ctx.beginPath();
          if (p.furrowDir === 0) {
            for (
              let fy = py + furrowStep * 0.75;
              fy < py + ph - 2.0;
              fy += furrowStep
            ) {
              ctx.moveTo(px + 2.0, fy);
              ctx.lineTo(px + pw - 2.0, fy);
            }
          } else {
            for (
              let fx = px + furrowStep * 0.75;
              fx < px + pw - 2.0;
              fx += furrowStep
            ) {
              ctx.moveTo(fx, py + 2.0);
              ctx.lineTo(fx, py + ph - 2.0);
            }
          }
          ctx.stroke();
        }

        // (#4) Crisp shared recursive BSP parcel boundary (forming X & Y T-junctions inside the estate)
        setSub(ctx, 2);
        ctx.strokeStyle = st.border;
        ctx.lineWidth = 1.1;
        ctx.strokeRect(px, py, pw, ph);
      }

      // (#6a) Broken-Grid Unpaved Farm Track Network (`d.tractorTracks`)
      if (tracks.length > 0) {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        setSub(ctx, 3);
        ctx.strokeStyle = "#d4cab5";
        ctx.lineWidth = 4.2;
        ctx.beginPath();
        for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
          const tr = tracks[tIdx];
          ctx.moveTo(tr.x0 * ts, tr.y0 * ts);
          ctx.lineTo(tr.x1 * ts, tr.y1 * ts);
        }
        ctx.stroke();

        setSub(ctx, 4);
        ctx.strokeStyle = PALETTE.bgPaper;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
          const tr = tracks[tIdx];
          ctx.moveTo(tr.x0 * ts, tr.y0 * ts);
          ctx.lineTo(tr.x1 * ts, tr.y1 * ts);
        }
        ctx.stroke();
      }
    }

    // Smooth vector road & expressway corridor slicing inside the clipped estates (with `||` estateBBox culling)
    const isPointNearAnyFarm = (wx, wy, pad) => {
      for (let b = 0; b < farmBBoxes.length; b++) {
        const bb = farmBBoxes[b];
        if (!(
          wx < bb.minX - pad ||
          wx > bb.maxX + pad ||
          wy < bb.minY - pad ||
          wy > bb.maxY + pad
        )) {
          return true;
        }
      }
      return false;
    };

    const nearbyRoadPath = new Path2DCtor();
    let hasNearbyRoads = false;
    for (const r of world.roads) {
      const pts = r.points;
      if (!pts || pts.length < 2) continue;
      const p0 = pts[0];
      if (!isPointNearAnyFarm(p0.x, p0.y, 32)) continue;
      let hitsBBox = false;
      for (let i = 0; i < pts.length; i++) {
        if (isPointNearAnyFarm(pts[i].x, pts[i].y, 3)) {
          hitsBBox = true;
          break;
        }
      }
      if (!hitsBBox) continue;
      hasNearbyRoads = true;
      nearbyRoadPath.moveTo(p0.x * ts + ts * 0.5, p0.y * ts + ts * 0.5);
      for (let i = 1; i < pts.length; i++) {
        nearbyRoadPath.lineTo(
          pts[i].x * ts + ts * 0.5,
          pts[i].y * ts + ts * 0.5,
        );
      }
    }

    const nearbyMwayPath = new Path2DCtor();
    let hasNearbyMways = false;
    if (world.motorways && world.motorways.length > 0) {
      for (const mw of world.motorways) {
        const spans = mw.surfaceSpans || [mw.samples || []];
        for (const seg of spans) {
          if (seg.length < 2) continue;
          let penDown = false;
          for (let i = 0; i < seg.length; i++) {
            const pt = seg[i];
            if (!isPointNearAnyFarm(pt.x, pt.y, 4)) {
              penDown = false;
              continue;
            }
            const sx = pt.x * ts + ts * 0.5;
            const sy = pt.y * ts + ts * 0.5;
            if (!penDown) {
              nearbyMwayPath.moveTo(sx, sy);
              penDown = true;
              hasNearbyMways = true;
            } else {
              nearbyMwayPath.lineTo(sx, sy);
            }
          }
        }
      }
    }

    const roadCasingW = ts * 0.92;
    const mwayCasingW = ts * 1.95;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    setSub(ctx, 5);
    ctx.strokeStyle = "#d4cab5";
    if (hasNearbyRoads) {
      ctx.lineWidth = roadCasingW + 4.4;
      ctx.stroke(nearbyRoadPath);
    }
    if (hasNearbyMways) {
      ctx.lineWidth = mwayCasingW + 6.4;
      ctx.stroke(nearbyMwayPath);
    }

    setSub(ctx, 6);
    ctx.strokeStyle = PALETTE.bgPaper;
    if (hasNearbyRoads) {
      ctx.lineWidth = roadCasingW + 2.2;
      ctx.stroke(nearbyRoadPath);
    }
    if (hasNearbyMways) {
      ctx.lineWidth = mwayCasingW + 4.2;
      ctx.stroke(nearbyMwayPath);
    }

    // Stroke the octilinear Marching-Squares contour/riverbank clip boundary ONCE across all estates
    setSub(ctx, 7);
    ctx.strokeStyle = "#d4cab5";
    ctx.lineWidth = 1.8;
    ctx.stroke(arableStrokePath);

    // Frame each 2×2 farmstead yard itself with a clean rounded margin
    for (let fIdx = 0; fIdx < farms.length; fIdx++) {
      const d = farms[fIdx];
      const padX = d.gx * ts - 1.6;
      const padY = d.gy * ts - 1.6;
      const padW = (d.wTiles || 2) * ts + 3.2;
      const padH = (d.hTiles || 2) * ts + 3.2;
      ctx.beginPath();
      ctx.roundRect(padX, padY, padW, padH, 4.2);
      setSub(ctx, 8);
      ctx.strokeStyle = "#d4cab5";
      ctx.lineWidth = 2.2;
      ctx.stroke();
      setSub(ctx, 9);
      ctx.fillStyle = PALETTE.bgPaper;
      ctx.fill();
    }

    ctx.restore();

    // (#6b) Sparse Foothill Windbreak Poplar Row along the upland outer boundary edge (batched into 2 Path2Ds)
    let hasWindbreaks = false;
    for (let fIdx = 0; fIdx < farms.length; fIdx++) {
      if (farms[fIdx].windbreakPts && farms[fIdx].windbreakPts.length > 0) {
        hasWindbreaks = true;
        break;
      }
    }
    if (hasWindbreaks) {
      setSub(ctx, 0);
      ctx.fillStyle = "rgba(182, 200, 170, 0.55)";
      ctx.beginPath();
      for (let fIdx = 0; fIdx < farms.length; fIdx++) {
        const wb = farms[fIdx].windbreakPts || [];
        for (let i = 0; i < wb.length; i++) {
          const wx = wb[i][0] * ts;
          const wy = wb[i][1] * ts;
          ctx.moveTo(wx + 3.4, wy);
          ctx.arc(wx, wy, 3.4, 0, Math.PI * 2);
        }
      }
      ctx.fill();

      setSub(ctx, 1);
      ctx.fillStyle = "#97ae89";
      ctx.beginPath();
      for (let fIdx = 0; fIdx < farms.length; fIdx++) {
        const wb = farms[fIdx].windbreakPts || [];
        for (let i = 0; i < wb.length; i++) {
          const wx = wb[i][0] * ts;
          const wy = wb[i][1] * ts;
          ctx.moveTo(wx + 2.0, wy);
          ctx.arc(wx, wy, 2.0, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
  }

  drawAirportGroundPads(ctx, world, ts) {
    for (const ap of world.airports) {
      const cx = ap.x * ts + ts * 0.5;
      const cy = ap.y * ts + ts * 0.5;
      const rwyLen = ap.halfLen * 2 * ts;
      const padLen = rwyLen + ts * 1.8;
      const padWid = ap.halfWid * 2 * ts + ts * (ap.isHub ? 2.1 : 1.9);
      const side = ap.apronSide;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ap.angleRad);

      // 1. Airport Perimeter Concrete Apron Pad
      ctx.beginPath();
      ctx.roundRect(-padLen * 0.5, -padWid * 0.5, padLen, padWid, 11);
      setSub(ctx, 0);
      ctx.fillStyle = "#e5e2dc";
      ctx.fill();
      setSub(ctx, 1);
      ctx.strokeStyle = "#b6b4ae";
      ctx.lineWidth = 2;
      ctx.stroke();

      // 2. Dedicated Apron Gate Parking Ramp Bay (recessed off the parallel taxiway)
      const termW = ap.isHub ? rwyLen * 0.46 : rwyLen * 0.4;
      const termH = ts * (ap.isHub ? 0.76 : 0.7);
      const termY = side * ts * (ap.isHub ? 1.66 : 1.54);
      const apronInnerY = ap.isHub ? -side * ts * 0.6 : side * ts * 0.22;
      const apronRampW = termW * (ap.isHub ? 0.92 : 1.02);
      const apronTopY = Math.min(apronInnerY, termY);
      const apronBoxH = Math.abs(termY - apronInnerY);
      ctx.beginPath();
      ctx.roundRect(-apronRampW * 0.5, apronTopY, apronRampW, apronBoxH, 4);
      setSub(ctx, 2);
      ctx.fillStyle = "#d9d5cd";
      ctx.fill();

      // 3. Transit / Parking Plaza Island inside the Curbside Loop
      const termOuterY = termY + side * (termH * 0.5);
      const loopW = termW * (ap.isHub ? 0.82 : 0.88);
      const loopInnerY = termOuterY + side * (ts * 0.2);
      const loopOuterY = loopInnerY + side * (ts * 0.98);
      const loopBoxH = Math.abs(loopOuterY - loopInnerY);

      const plazaMidY = (loopInnerY + loopOuterY) * 0.5;
      const plazaW = loopW * 0.74;
      const plazaH = loopBoxH * 0.45;
      ctx.beginPath();
      ctx.roundRect(
        -plazaW * 0.5,
        plazaMidY - plazaH * 0.5,
        plazaW,
        plazaH,
        3.5,
      );
      setSub(ctx, 2);
      ctx.fillStyle = "#d8d5ce";
      ctx.fill();
      setSub(ctx, 3);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.2;
      ctx.stroke();

      ctx.restore();
    }
  }

  drawRoadNetwork(ctx, world, ts) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Gather all surface roundabouts (Airport Gateways + Expressway Street-Stubs + Diamond Slip-Ramp Stubs)
    // and driveways directly from world.routingGraph so all casings and fills are stroked in unified passes!
    const roundabouts = world.routingGraph?.roundabouts || [];
    const driveways = world.routingGraph?.driveways || [];
    const airportLandsideGeoms = [];

    for (const ap of world.airports || []) {
      const cx = ap.x * ts + ts * 0.5;
      const cy = ap.y * ts + ts * 0.5;
      const rwyLen = ap.halfLen * 2 * ts;
      const side = ap.apronSide;
      const termW = ap.isHub ? rwyLen * 0.46 : rwyLen * 0.4;
      const termH = ts * (ap.isHub ? 0.76 : 0.7);
      const termY = side * ts * (ap.isHub ? 1.66 : 1.54);
      const termOuterY = termY + side * (termH * 0.5);

      const loopW = termW * (ap.isHub ? 0.82 : 0.88);
      const loopHalfW = loopW * 0.5;
      const loopInnerY = termOuterY + side * (ts * 0.2);
      const loopOuterY = loopInnerY + side * (ts * 0.98);
      const loopTopY = Math.min(loopInnerY, loopOuterY);
      const loopBoxH = Math.abs(loopOuterY - loopInnerY);
      const loopR = loopBoxH * 0.48;

      const cosA = Math.cos(ap.angleRad);
      const sinA = Math.sin(ap.angleRad);
      const gatePx = ap.gateX * ts + ts * 0.5;
      const gatePy = ap.gateY * ts + ts * 0.5;
      const gdx = gatePx - cx;
      const gdy = gatePy - cy;
      const localGateX = gdx * cosA + gdy * sinA;
      const localGateY = -gdx * sinA + gdy * cosA;

      airportLandsideGeoms.push({
        cx,
        cy,
        angleRad: ap.angleRad,
        loopHalfW,
        loopTopY,
        loopW,
        loopBoxH,
        loopR,
        spineStartY: loopOuterY,
        localGateX,
        localGateY,
      });
    }

    // =========================================================================
    // PASS 1: UNIFIED SURFACE ROAD CASINGS (Driveways + Streets + Arterials + Airport Loops & Spines + Roundabout Rings)
    // Every grey casing in the surface road network is stroked BEFORE any white asphalt fill is drawn!
    // =========================================================================
    // Diamond slip-ramp casings (`PALETTE.motorwayBorder`) stroked at the very start of PASS 1
    // before surface road and roundabout `PALETTE.roadCasing` strokes so the surface road casing and fill cleanly receive the ramp throat!
    ctx.strokeStyle = PALETTE.motorwayBorder;
    ctx.lineWidth = ts * 0.36;
    ctx.beginPath();
    for (const ic of world.interchanges) {
      if (ic.type !== "diamond-ramp") continue;
      for (const ramp of ic.ramps || []) {
        ctx.moveTo(ramp.p0.x * ts + ts * 0.5, ramp.p0.y * ts + ts * 0.5);
        ctx.bezierCurveTo(
          ramp.p1.x * ts + ts * 0.5,
          ramp.p1.y * ts + ts * 0.5,
          ramp.p2.x * ts + ts * 0.5,
          ramp.p2.y * ts + ts * 0.5,
          ramp.p3.x * ts + ts * 0.5,
          ramp.p3.y * ts + ts * 0.5,
        );
      }
    }
    ctx.stroke();

    ctx.strokeStyle = PALETTE.roadCasing;
    ctx.lineWidth = ts * 0.42;
    ctx.beginPath();
    for (const dw of driveways) {
      ctx.moveTo(dw.x0 * ts + ts * 0.5, dw.y0 * ts + ts * 0.5);
      ctx.lineTo(dw.x1 * ts + ts * 0.5, dw.y1 * ts + ts * 0.5);
    }
    ctx.stroke();

    for (const r of world.roads) {
      if (
        r.points.length < 2 ||
        r.type === "airport-loop" ||
        r.type === "airport-spine"
      )
        continue;
      ctx.strokeStyle = PALETTE.roadCasing;
      ctx.lineWidth = r.type === "street" ? ts * 0.58 : ts * 0.74;
      this.traceSmoothPath(ctx, r.points, ts);
      ctx.stroke();
    }

    for (const ag of airportLandsideGeoms) {
      ctx.save();
      ctx.translate(ag.cx, ag.cy);
      ctx.rotate(ag.angleRad);
      ctx.strokeStyle = PALETTE.roadCasing;
      ctx.lineWidth = ts * 0.68;
      ctx.beginPath();
      ctx.roundRect(
        -ag.loopHalfW,
        ag.loopTopY,
        ag.loopW,
        ag.loopBoxH,
        ag.loopR,
      );
      ctx.moveTo(0, ag.spineStartY);
      ctx.lineTo(ag.localGateX, ag.localGateY);
      ctx.stroke();
      ctx.restore();
    }

    if (roundabouts.length > 0) {
      ctx.strokeStyle = PALETTE.roadCasing;
      ctx.lineWidth = ts * 0.68;
      ctx.beginPath();
      for (const rb of roundabouts) {
        const px = rb.x * ts + ts * 0.5;
        const py = rb.y * ts + ts * 0.5;
        const rRing = rb.rTiles * ts;
        ctx.moveTo(px + rRing, py);
        ctx.arc(px, py, rRing, 0, Math.PI * 2);
      }
      ctx.stroke();
    }

    // =========================================================================
    // PASS 2: BRIDGE GUARDRAILS OVER WATER (continuous smoothed spans matching `traceSmoothPath`)
    // =========================================================================
    nextPass(ctx);
    const ox = ts * 0.5;
    const oy = ts * 0.5;
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
    ctx.strokeStyle = PALETTE.bridgeRail;
    ctx.lineWidth = ts * 0.88;
    for (const r of world.roads) {
      const pts = r.points;
      if (
        !pts ||
        pts.length < 2 ||
        r.type === "airport-loop" ||
        r.type === "airport-spine"
      )
        continue;
      let i = 0;
      while (i < pts.length - 1) {
        if (!(pts[i].isBridge || pts[i + 1].isBridge)) {
          i++;
          continue;
        }
        const eStart = i;
        while (
          i + 1 < pts.length - 1 &&
          (pts[i + 1].isBridge || pts[i + 2].isBridge)
        ) {
          i++;
        }
        const eEnd = i;
        i++;

        ctx.beginPath();
        // Start of continuous bridge span (`vStart = eStart`) at the shoreline bank (`t = 0.32` from dry tile to water tile)
        const vStart = eStart;
        const pS0 = pts[vStart];
        const pS1 = pts[vStart + 1];
        const startFrac = !pS0.isBridge && pS1.isBridge ? 0.08 : 0.0;
        ctx.moveTo(
          (pS0.x + (pS1.x - pS0.x) * startFrac) * ts + ox,
          (pS0.y + (pS1.y - pS0.y) * startFrac) * ts + oy,
        );

        // Interior bridge vertices (`eStart + 1 .. eEnd`) rounded with exact `traceSmoothPath` quadratic Beziers
        for (let v = eStart + 1; v <= eEnd; v++) {
          const pPrev = pts[v - 1];
          const pCurr = pts[v];
          const pNext = pts[v + 1];
          const dx1 = pCurr.x - pPrev.x,
            dy1 = pCurr.y - pPrev.y;
          const dx2 = pNext.x - pCurr.x,
            dy2 = pNext.y - pCurr.y;
          if (dx1 === dx2 && dy1 === dy2) {
            ctx.lineTo(pCurr.x * ts + ox, pCurr.y * ts + oy);
          } else {
            const len1 = Math.hypot(dx1, dy1) || 1;
            const len2 = Math.hypot(dx2, dy2) || 1;
            const rCorner = Math.min(0.24, len1 * 0.45, len2 * 0.45);
            const xIn = (pCurr.x - (dx1 / len1) * rCorner) * ts + ox;
            const yIn = (pCurr.y - (dy1 / len1) * rCorner) * ts + oy;
            const xOut = (pCurr.x + (dx2 / len2) * rCorner) * ts + ox;
            const yOut = (pCurr.y + (dy2 / len2) * rCorner) * ts + oy;
            ctx.lineTo(xIn, yIn);
            ctx.quadraticCurveTo(
              pCurr.x * ts + ox,
              pCurr.y * ts + oy,
              xOut,
              yOut,
            );
          }
        }

        // End of continuous bridge span (`vEnd = eEnd + 1`) at the shoreline bank (`1 - 0.32` from water tile to dry tile)
        const vEnd = eEnd + 1;
        const pE0 = pts[eEnd];
        const pE1 = pts[vEnd];
        const endFrac = pE0.isBridge && !pE1.isBridge ? 0.92 : 1.0;
        ctx.lineTo(
          (pE0.x + (pE1.x - pE0.x) * endFrac) * ts + ox,
          (pE0.y + (pE1.y - pE0.y) * endFrac) * ts + oy,
        );
        ctx.stroke();
      }
    }
    ctx.lineCap = "round";

    // =========================================================================
    // PASS 3: UNIFIED SURFACE ROAD & SLIP-RAMP ASPHALT FILLS
    // Because all fills are drawn in a single unified pass after all casings, every
    // slip-ramp mouth, T-junction, and roundabout throat merges with zero clip masks!
    // =========================================================================
    nextPass(ctx);
    ctx.strokeStyle = "#f48fb1";
    ctx.lineWidth = ts * 0.22;
    ctx.beginPath();
    for (const ic of world.interchanges) {
      if (ic.type !== "diamond-ramp") continue;
      for (const ramp of ic.ramps || []) {
        ctx.moveTo(ramp.p0.x * ts + ox, ramp.p0.y * ts + oy);
        ctx.bezierCurveTo(
          ramp.p1.x * ts + ox,
          ramp.p1.y * ts + oy,
          ramp.p2.x * ts + ox,
          ramp.p2.y * ts + oy,
          ramp.p3.x * ts + ox,
          ramp.p3.y * ts + oy,
        );
      }
    }
    ctx.stroke();

    ctx.strokeStyle = PALETTE.roadAsphalt;
    ctx.lineWidth = ts * 0.26;
    ctx.beginPath();
    for (const dw of driveways) {
      ctx.moveTo(dw.x0 * ts + ts * 0.5, dw.y0 * ts + ts * 0.5);
      ctx.lineTo(dw.x1 * ts + ts * 0.5, dw.y1 * ts + ts * 0.5);
    }
    ctx.stroke();

    for (const r of world.roads) {
      if (
        r.points.length < 2 ||
        r.type === "airport-loop" ||
        r.type === "airport-spine"
      )
        continue;
      ctx.strokeStyle = PALETTE.roadAsphalt;
      ctx.lineWidth = r.type === "street" ? ts * 0.42 : ts * 0.56;
      this.traceSmoothPath(ctx, r.points, ts);
      ctx.stroke();
    }

    for (const ag of airportLandsideGeoms) {
      ctx.save();
      ctx.translate(ag.cx, ag.cy);
      ctx.rotate(ag.angleRad);
      ctx.strokeStyle = PALETTE.roadAsphalt;
      ctx.lineWidth = ts * 0.5;
      ctx.beginPath();
      ctx.roundRect(
        -ag.loopHalfW,
        ag.loopTopY,
        ag.loopW,
        ag.loopBoxH,
        ag.loopR,
      );
      ctx.moveTo(0, ag.spineStartY);
      ctx.lineTo(ag.localGateX, ag.localGateY);
      ctx.stroke();
      ctx.restore();
    }

    if (roundabouts.length > 0) {
      ctx.strokeStyle = PALETTE.roadAsphalt;
      ctx.lineWidth = ts * 0.5;
      ctx.beginPath();
      for (const rb of roundabouts) {
        const px = rb.x * ts + ts * 0.5;
        const py = rb.y * ts + ts * 0.5;
        const rRing = rb.rTiles * ts;
        ctx.moveTo(px + rRing, py);
        ctx.arc(px, py, rRing, 0, Math.PI * 2);
      }
      ctx.stroke();
    }

    // =========================================================================
    // PASS 4: LANDSCAPED CENTRAL ROUNDABOUT ISLANDS
    // =========================================================================
    nextPass(ctx);
    for (const rb of roundabouts) {
      const px = rb.x * ts + ts * 0.5;
      const py = rb.y * ts + ts * 0.5;
      const rIsland = (rb.rIsland ?? rb.rTiles * 0.52) * ts;
      this.drawRoundaboutCentralIsland(
        ctx,
        px,
        py,
        rIsland,
        rb.accentColor || "#8fa989",
      );
    }
  }

  drawRoundaboutCentralIsland(ctx, x, y, rIsland, accentColor) {
    // Inner curb casing around central landscaped island
    ctx.beginPath();
    ctx.arc(x, y, rIsland, 0, Math.PI * 2);
    setSub(ctx, 0);
    ctx.fillStyle = PALETTE.parkSageGreen;
    ctx.fill();
    setSub(ctx, 1);
    ctx.strokeStyle = PALETTE.roadCasing;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Lush inner turf planter ring
    setSub(ctx, 2);
    ctx.fillStyle = "#9fb99a";
    ctx.beginPath();
    ctx.arc(x, y, rIsland * 0.58, 0, Math.PI * 2);
    ctx.fill();

    // Subtle town/airport accent centerpiece
    if (accentColor) {
      setSub(ctx, 3);
      ctx.fillStyle = accentColor;
      ctx.beginPath();
      ctx.arc(x, y, rIsland * 0.26, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  traceSmoothPath(ctx, pts, ts) {
    ctx.beginPath();
    const ox = ts * 0.5;
    const oy = ts * 0.5;
    ctx.moveTo(pts[0].x * ts + ox, pts[0].y * ts + oy);
    for (let i = 1; i < pts.length - 1; i++) {
      const pPrev = pts[i - 1];
      const pCurr = pts[i];
      const pNext = pts[i + 1];
      const dx1 = pCurr.x - pPrev.x;
      const dy1 = pCurr.y - pPrev.y;
      const dx2 = pNext.x - pCurr.x;
      const dy2 = pNext.y - pCurr.y;

      // Collinear points need no curve
      if (dx1 === dx2 && dy1 === dy2) {
        ctx.lineTo(pCurr.x * ts + ox, pCurr.y * ts + oy);
        continue;
      }

      const len1 = Math.hypot(dx1, dy1) || 1;
      const len2 = Math.hypot(dx2, dy2) || 1;
      const rCorner = Math.min(0.24, len1 * 0.45, len2 * 0.45);
      const xIn = (pCurr.x - (dx1 / len1) * rCorner) * ts + ox;
      const yIn = (pCurr.y - (dy1 / len1) * rCorner) * ts + oy;
      const xOut = (pCurr.x + (dx2 / len2) * rCorner) * ts + ox;
      const yOut = (pCurr.y + (dy2 / len2) * rCorner) * ts + oy;

      ctx.lineTo(xIn, yIn);
      ctx.quadraticCurveTo(pCurr.x * ts + ox, pCurr.y * ts + oy, xOut, yOut);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x * ts + ox, last.y * ts + oy);
  }

  drawBuildings(ctx, world, ts) {
    const isRCI = this.activeLayer === "rci";

    // 1. Residential Houses (coalesced into 1 shadow Path2D + 7 base Path2Ds + 7 roof Path2Ds!)
    for (const h of world.houses) {
      const cx = (h.x + (h.offX || 0)) * ts + ts * 0.5;
      const cy = (h.y + (h.offY || 0)) * ts + ts * 0.5;
      const hw = ts * (h.wScale || 0.72);
      const hh = ts * (h.hScale || 0.72);
      const baseCol = isRCI ? "#15803d" : h.palette.base;
      const roofCol = isRCI ? "#22c55e" : h.palette.roof;

      setSub(ctx, 0);
      ctx.fillStyle = PALETTE.shadowColor;
      ctx.beginPath();
      ctx.roundRect(cx - hw * 0.5 + 3.0, cy - hh * 0.5 + 3.0, hw, hh, 2.5);
      ctx.fill();

      setSub(ctx, 1);
      ctx.fillStyle = baseCol;
      ctx.beginPath();
      ctx.roundRect(cx - hw * 0.5, cy - hh * 0.5, hw, hh, 2.5);
      ctx.fill();

      setSub(ctx, 2);
      ctx.fillStyle = roofCol;
      ctx.beginPath();
      ctx.roundRect(cx - hw * 0.5, cy - hh * 0.5, hw, hh * 0.68, 2.5);
      ctx.fill();
    }

    nextPass(ctx);

    // 2. Differentiated Commercial (CBD/Arterial/Corner) & Industrial (RAW/MFG/LOG) Multi-Dimension Sinks
    for (const d of world.destinations) {
      const cx = d.x * ts + ts * 0.5;
      const cy = d.y * ts + ts * 0.5;
      const wT = d.wTiles || 2;
      const hT = d.hTiles || 2;
      const lotW = (wT + 0.06) * ts;
      const lotH = (hT + 0.06) * ts;
      const bldW = (wT - 0.34) * ts;
      const bldH = (hT - 0.34) * ts;
      const isInd = d.zoneType === "industrial";

      let baseCol = d.palette.base;
      let roofCol = d.palette.roof;
      let pinCol = d.palette.pin;
      if (isRCI) {
        if (!isInd) {
          baseCol = "#1d4ed8";
          roofCol = "#3b82f6";
          pinCol = "#1e3a8a";
        } else if (d.isGatewayProxy) {
          baseCol = "#0f766e";
          roofCol = "#0d9488";
          pinCol = "#134e4a";
        } else if (d.subType === "RAW") {
          if (d.resourceType === "FISHERY") {
            baseCol = "#155e75";
            roofCol = "#0891b2";
            pinCol = "#164e63";
          } else if (d.resourceType === "CHEM") {
            baseCol = "#3f6212";
            roofCol = "#65a30d";
            pinCol = "#365314";
          } else {
            baseCol = "#b45309";
            roofCol = "#f59e0b";
            pinCol = "#78350f";
          }
        } else if (d.subType === "LOG") {
          baseCol = "#6d28d9";
          roofCol = "#a855f7";
          pinCol = "#4c1d95";
        } else {
          baseCol = "#c2410c";
          roofCol = "#ea580c";
          pinCol = "#7c2d12";
        }
      }

      if (!isInd) {
        // =================================================================
        // COMMERCIAL SINK (2×2 Rotunda, 3×2/2×3 Arterial Hall, or 2×1/1×2 Corner Market)
        // =================================================================
        ctx.beginPath();
        ctx.roundRect(cx - lotW * 0.5, cy - lotH * 0.5, lotW, lotH, 4.5);
        setSub(ctx, 0);
        ctx.fillStyle = isRCI ? "#dbeafe" : "#eceae4";
        ctx.fill();
        setSub(ctx, 1);
        ctx.strokeStyle = isRCI ? "#60a5fa" : "#b8b5ad";
        ctx.lineWidth = 1.25;
        ctx.stroke();

        // 45° Building Drop Shadow
        const minDim = Math.min(bldW, bldH);
        setSub(ctx, 2);
        ctx.fillStyle = PALETTE.shadowColor;
        ctx.beginPath();
        if (d.isCircular) {
          ctx.arc(cx + 5.2, cy + 5.2, minDim * 0.52, 0, Math.PI * 2);
        } else {
          ctx.roundRect(
            cx - bldW * 0.5 + 4.8,
            cy - bldH * 0.5 + 4.8,
            bldW,
            bldH,
            4,
          );
        }
        ctx.fill();

        // Main Commercial Base & Stepped Roof
        setSub(ctx, 3);
        ctx.fillStyle = baseCol;
        ctx.beginPath();
        if (d.isCircular) {
          ctx.arc(cx, cy, minDim * 0.52, 0, Math.PI * 2);
        } else {
          ctx.roundRect(cx - bldW * 0.5, cy - bldH * 0.5, bldW, bldH, 4);
        }
        ctx.fill();

        setSub(ctx, 4);
        ctx.fillStyle = roofCol;
        ctx.beginPath();
        if (d.isCircular) {
          ctx.arc(cx, cy - 1.6, minDim * 0.45, 0, Math.PI * 2);
        } else {
          ctx.roundRect(
            cx - bldW * 0.5 + 1.4,
            cy - bldH * 0.5 + 1.4,
            bldW - 2.8,
            bldH * 0.78,
            3,
          );
        }
        ctx.fill();

        // Bright Glass Atrium Skylight Core
        setSub(ctx, 5);
        ctx.fillStyle = "rgba(255, 255, 255, 0.36)";
        ctx.beginPath();
        if (d.isCircular) {
          ctx.arc(cx, cy - 1.6, minDim * 0.22, 0, Math.PI * 2);
        } else {
          ctx.roundRect(
            cx - bldW * 0.28,
            cy - bldH * 0.34,
            bldW * 0.56,
            bldH * 0.32,
            2,
          );
        }
        ctx.fill();

        // Round Consumer Demand Pins scaled to rectangular or circular roof
        const cols = wT >= hT ? Math.min(3, Math.max(2, wT)) : Math.min(2, wT);
        const rows = Math.ceil(d.pinsCount / cols);
        for (let p = 0; p < d.pinsCount; p++) {
          let px, py;
          if (d.isCircular) {
            const ang = (p / d.pinsCount) * Math.PI * 2;
            px = cx + Math.cos(ang) * (minDim * 0.3);
            py = cy - 1.6 + Math.sin(ang) * (minDim * 0.3);
          } else {
            const col = p % cols;
            const row = Math.floor(p / cols);
            const spanX = bldW * 0.54;
            const spanY = bldH * 0.44;
            px =
              cols === 1 ? cx : cx - spanX * 0.5 + (col / (cols - 1)) * spanX;
            py =
              rows <= 1
                ? cy - bldH * 0.12
                : cy - spanY * 0.55 + (row / (rows - 1)) * spanY;
          }
          ctx.beginPath();
          ctx.arc(px, py, 2.2, 0, Math.PI * 2);
          setSub(ctx, 7);
          ctx.fillStyle = "#ffffff";
          ctx.fill();
          setSub(ctx, 8);
          ctx.strokeStyle = pinCol;
          ctx.lineWidth = 1.35;
          ctx.stroke();
        }
      } else {
        // =================================================================
        // INDUSTRIAL FACILITY (`RAW` Silos, `MINE`, `TIMBER`, `FARM`, `MFG`, `LOG`)
        // =================================================================
        ctx.beginPath();
        ctx.roundRect(cx - lotW * 0.5, cy - lotH * 0.5, lotW, lotH, 3);
        setSub(ctx, 0);
        ctx.fillStyle = isRCI
          ? "#fef3c7"
          : d.resourceType === "FARM"
            ? "#e5dec9"
            : "#d5d2ca";
        ctx.fill();
        setSub(ctx, 1);
        ctx.strokeStyle = isRCI
          ? "#f59e0b"
          : d.resourceType === "FARM"
            ? "#a89f89"
            : "#8c8980";
        ctx.lineWidth = 1.45;
        ctx.stroke();

        // Yellow-amber freight loading apron stripes on heavy industrial yards (omitted on rural farmsteads)
        if (d.resourceType !== "FARM") {
          ctx.fillStyle = "rgba(217, 119, 6, 0.48)";
          const stripeCount = Math.max(3, wT * 2);
          for (let s = 0; s < stripeCount; s++) {
            const sx =
              cx - lotW * 0.36 + (s / (stripeCount - 1)) * (lotW * 0.72);
            ctx.fillRect(sx - 2, cy + lotH * 0.36, 4, 2.8);
          }
        } else {
          // Warm timber/gravel barnyard gate apron on rural farmsteads
          ctx.fillStyle = "rgba(168, 152, 124, 0.42)";
          ctx.fillRect(cx - lotW * 0.32, cy + lotH * 0.35, lotW * 0.64, 2.4);
        }

        // 45° Industrial Shadow
        setSub(ctx, 2);
        ctx.fillStyle = PALETTE.shadowColor;
        ctx.beginPath();
        ctx.roundRect(
          cx - bldW * 0.5 + 4.8,
          cy - bldH * 0.5 + 4.8,
          bldW,
          bldH * 0.9,
          3,
        );
        ctx.fill();

        if (d.subType === "RAW") {
          if (d.resourceType === "MINE") {
            // Foothill Quarry & Mine (`MINE`): Ore Crusher Headhouse on Left (under pins) + Stepped Stone Quarry Pit on Right
            setSub(ctx, 3);
            ctx.fillStyle = baseCol;
            ctx.beginPath();
            ctx.roundRect(
              cx - bldW * 0.48,
              cy - bldH * 0.44,
              bldW * 0.48,
              bldH * 0.84,
              2.5,
            );
            ctx.fill();

            setSub(ctx, 4);
            ctx.fillStyle = roofCol;
            ctx.beginPath();
            ctx.roundRect(
              cx - bldW * 0.44,
              cy - bldH * 0.4,
              bldW * 0.4,
              bldH * 0.66,
              2,
            );
            ctx.fill();

            // Stepped stone excavation benches on right half
            setSub(ctx, 3);
            ctx.fillStyle = "#a8a29e";
            ctx.beginPath();
            ctx.roundRect(
              cx + bldW * 0.04,
              cy - bldH * 0.42,
              bldW * 0.44,
              bldH * 0.8,
              3,
            );
            ctx.fill();

            setSub(ctx, 4);
            ctx.fillStyle = "#78716c";
            ctx.beginPath();
            ctx.roundRect(
              cx + bldW * 0.11,
              cy - bldH * 0.3,
              bldW * 0.3,
              bldH * 0.56,
              2,
            );
            ctx.fill();

            setSub(ctx, 5);
            ctx.fillStyle = "#57534e";
            ctx.beginPath();
            ctx.roundRect(
              cx + bldW * 0.18,
              cy - bldH * 0.18,
              bldW * 0.16,
              bldH * 0.32,
              1.5,
            );
            ctx.fill();
          } else if (d.resourceType === "TIMBER") {
            // Upland Forestry Camp (`TIMBER`): Cedar Sawmill Shed on Left + Stacked Timber Log Bunks on Right
            setSub(ctx, 3);
            ctx.fillStyle = baseCol;
            ctx.beginPath();
            ctx.roundRect(
              cx - bldW * 0.48,
              cy - bldH * 0.44,
              bldW * 0.48,
              bldH * 0.84,
              2.5,
            );
            ctx.fill();

            setSub(ctx, 4);
            ctx.fillStyle = roofCol;
            ctx.beginPath();
            ctx.roundRect(
              cx - bldW * 0.44,
              cy - bldH * 0.4,
              bldW * 0.4,
              bldH * 0.66,
              2,
            );
            ctx.fill();

            // 3 Stacked Cedar Log Bunks on right half of timber yard
            for (const lyOff of [-bldH * 0.26, 0, bldH * 0.26]) {
              setSub(ctx, 3);
              ctx.fillStyle = "#78350f";
              ctx.beginPath();
              ctx.roundRect(
                cx + bldW * 0.06,
                cy + lyOff - bldH * 0.09,
                bldW * 0.38,
                bldH * 0.18,
                2,
              );
              ctx.fill();

              setSub(ctx, 4);
              ctx.fillStyle = "#fde68a";
              ctx.beginPath();
              ctx.arc(
                cx + bldW * 0.41,
                cy + lyOff,
                bldH * 0.06,
                0,
                Math.PI * 2,
              );
              ctx.fill();
            }
          } else if (d.resourceType === "FARM") {
            // Alluvial Agribusiness Farm (`FARM`):
            setSub(ctx, 3);
            ctx.fillStyle = "#9e3b2b";
            ctx.beginPath();
            ctx.roundRect(
              cx - bldW * 0.48,
              cy - bldH * 0.44,
              bldW * 0.5,
              bldH * 0.84,
              2.5,
            );
            ctx.fill();

            setSub(ctx, 4);
            ctx.fillStyle = "#c85644";
            ctx.beginPath();
            ctx.roundRect(
              cx - bldW * 0.44,
              cy - bldH * 0.4,
              bldW * 0.42,
              bldH * 0.68,
              2,
            );
            ctx.fill();

            // White cross-gable barn roof ridges (`+`)
            setSub(ctx, 5);
            ctx.fillStyle = "rgba(255, 255, 255, 0.52)";
            ctx.fillRect(cx - bldW * 0.235, cy - bldH * 0.38, 1.5, bldH * 0.64);
            ctx.fillRect(cx - bldW * 0.42, cy - bldH * 0.08, bldW * 0.38, 1.4);

            // Top-Right: Single White Domed Grain Tower Silo + Auger Chute
            const siloR = Math.min(bldW, bldH) * 0.19;
            const siloX = cx + bldW * 0.24;
            const siloY = cy - bldH * 0.22;
            setSub(ctx, 3);
            ctx.strokeStyle = "#9ca3af";
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(cx + bldW * 0.02, siloY);
            ctx.lineTo(siloX, siloY);
            ctx.stroke();

            setSub(ctx, 4);
            ctx.fillStyle = "#6b7078";
            ctx.beginPath();
            ctx.arc(siloX, siloY, siloR, 0, Math.PI * 2);
            ctx.fill();

            setSub(ctx, 5);
            ctx.fillStyle = "#f5f5f4";
            ctx.beginPath();
            ctx.arc(siloX, siloY - 0.9, siloR * 0.78, 0, Math.PI * 2);
            ctx.fill();

            // Bottom-Right: Glazed Farm Greenhouse / Nursery Bay
            const ghX = cx + bldW * 0.06;
            const ghY = cy + bldH * 0.03;
            const ghW = bldW * 0.38;
            const ghH = bldH * 0.35;
            setSub(ctx, 3);
            ctx.fillStyle = "#84a595";
            ctx.beginPath();
            ctx.roundRect(ghX, ghY, ghW, ghH, 2);
            ctx.fill();

            setSub(ctx, 4);
            ctx.fillStyle = "#d7ebe2";
            ctx.beginPath();
            ctx.roundRect(ghX + 1.2, ghY + 1.2, ghW - 2.4, ghH - 2.4, 1.5);
            ctx.fill();

            // Glass roof mullions
            setSub(ctx, 5);
            ctx.strokeStyle = "#84a595";
            ctx.lineWidth = 0.85;
            ctx.beginPath();
            ctx.moveTo(ghX + ghW * 0.35, ghY + 1);
            ctx.lineTo(ghX + ghW * 0.35, ghY + ghH - 1);
            ctx.moveTo(ghX + ghW * 0.68, ghY + 1);
            ctx.lineTo(ghX + ghW * 0.68, ghY + ghH - 1);
            ctx.stroke();
          } else if (d.resourceType === "FISHERY") {
            // Coastal Cold-Storage Catch Wharf (`FISHERY`):
            // Left half: Slate-blue cold-storage wharf hall (`baseCol` / `roofCol` with `#0284c7` maritime trim)
            setSub(ctx, 3);
            ctx.fillStyle = baseCol;
            ctx.beginPath();
            ctx.roundRect(
              cx - bldW * 0.48,
              cy - bldH * 0.44,
              bldW * 0.48,
              bldH * 0.84,
              2.5,
            );
            ctx.fill();

            setSub(ctx, 4);
            ctx.fillStyle = roofCol;
            ctx.beginPath();
            ctx.roundRect(
              cx - bldW * 0.44,
              cy - bldH * 0.4,
              bldW * 0.4,
              bldH * 0.66,
              2,
            );
            ctx.fill();

            // Maritime blue roof eaves & trim
            setSub(ctx, 5);
            ctx.fillStyle = "#0284c7";
            ctx.fillRect(cx - bldW * 0.44, cy - bldH * 0.4, bldW * 0.4, 1.8);
            ctx.fillRect(cx - bldW * 0.44, cy + bldH * 0.24, bldW * 0.4, 1.4);

            // Right half: Two parallel timber/concrete pier fingers extending across the right half
            const pierW = bldW * 0.42;
            const pierH = bldH * 0.22;
            const pierX = cx + bldW * 0.04;
            for (const pyOff of [-bldH * 0.22, bldH * 0.22]) {
              setSub(ctx, 3);
              ctx.fillStyle = "#78716c";
              ctx.beginPath();
              ctx.roundRect(pierX, cy + pyOff - pierH * 0.5, pierW, pierH, 1.5);
              ctx.fill();

              setSub(ctx, 4);
              ctx.fillStyle = "#d6d3d1";
              ctx.beginPath();
              ctx.roundRect(
                pierX + 1.2,
                cy + pyOff - pierH * 0.5 + 1.0,
                pierW - 2.4,
                pierH - 2.0,
                1,
              );
              ctx.fill();
            }

            // Two circular cyan/white cold-brine holding tanks
            const tankR = Math.min(bldW, bldH) * 0.13;
            const tankCoords = [
              [cx + bldW * 0.16, cy],
              [cx + bldW * 0.34, cy],
            ];
            for (const [tx, ty] of tankCoords) {
              setSub(ctx, 4);
              ctx.fillStyle = "#0284c7";
              ctx.beginPath();
              ctx.arc(tx, ty, tankR, 0, Math.PI * 2);
              ctx.fill();

              setSub(ctx, 5);
              ctx.fillStyle = "#0ea5e9";
              ctx.beginPath();
              ctx.arc(tx, ty - 0.7, tankR * 0.8, 0, Math.PI * 2);
              ctx.fill();

              setSub(ctx, 6);
              ctx.fillStyle = "#e0f2fe";
              ctx.beginPath();
              ctx.arc(tx - 0.5, ty - 1.0, tankR * 0.34, 0, Math.PI * 2);
              ctx.fill();
            }
          } else {
            // Urban Bulk Feedstock & Chemical Works (`RAW`):
            setSub(ctx, 3);
            ctx.fillStyle = baseCol;
            ctx.beginPath();
            ctx.roundRect(
              cx - bldW * 0.48,
              cy - bldH * 0.44,
              bldW * 0.48,
              bldH * 0.84,
              2.5,
            );
            ctx.fill();

            setSub(ctx, 4);
            ctx.fillStyle = roofCol;
            ctx.beginPath();
            ctx.roundRect(
              cx - bldW * 0.44,
              cy - bldH * 0.4,
              bldW * 0.4,
              bldH * 0.65,
              2,
            );
            ctx.fill();

            // Steel Pipe-Rack Gantry Manifold on right half
            const rackX = cx + bldW * 0.16;
            setSub(ctx, 3);
            ctx.strokeStyle = "#64748b";
            ctx.lineWidth = 2.0;
            ctx.beginPath();
            ctx.moveTo(cx, cy - bldH * 0.26);
            ctx.lineTo(cx + bldW * 0.36, cy - bldH * 0.26);
            ctx.moveTo(cx, cy + bldH * 0.02);
            ctx.lineTo(cx + bldW * 0.36, cy + bldH * 0.02);
            ctx.moveTo(rackX, cy - bldH * 0.32);
            ctx.lineTo(rackX, cy + bldH * 0.3);
            ctx.stroke();

            // 3 Dark-Steel Spherical Pressure Vats (`2×1` + `1×1` Chemical/Refinery Tank Farm)
            const vatR = Math.min(bldW, bldH) * 0.135;
            const vatCoords = [
              [cx + bldW * 0.15, cy - bldH * 0.26],
              [cx + bldW * 0.35, cy - bldH * 0.26],
              [cx + bldW * 0.15, cy + bldH * 0.06],
            ];
            for (const [vx, vy] of vatCoords) {
              setSub(ctx, 4);
              ctx.fillStyle = "#334155";
              ctx.beginPath();
              ctx.arc(vx, vy, vatR, 0, Math.PI * 2);
              ctx.fill();

              setSub(ctx, 5);
              ctx.fillStyle = "#64748b";
              ctx.beginPath();
              ctx.arc(vx, vy - 0.6, vatR * 0.78, 0, Math.PI * 2);
              ctx.fill();

              setSub(ctx, 6);
              ctx.fillStyle = "#cbd5e1";
              ctx.beginPath();
              ctx.arc(vx - 0.5, vy - 0.9, vatR * 0.32, 0, Math.PI * 2);
              ctx.fill();
            }

            // Bottom-Right: Heavy Industrial Flue Smokestack with dark-slate collar
            const stX = cx + bldW * 0.34;
            const stY = cy + bldH * 0.22;
            const stR = Math.min(bldW, bldH) * 0.13;
            setSub(ctx, 4);
            ctx.fillStyle = "#1e293b";
            ctx.beginPath();
            ctx.arc(stX, stY, stR, 0, Math.PI * 2);
            ctx.fill();

            setSub(ctx, 5);
            ctx.fillStyle = "#94a3b8";
            ctx.beginPath();
            ctx.arc(stX, stY, stR * 0.65, 0, Math.PI * 2);
            ctx.fill();

            setSub(ctx, 6);
            ctx.fillStyle = "#0f172a";
            ctx.beginPath();
            ctx.arc(stX, stY, stR * 0.35, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (d.subType === "LOG") {
          // Logistics Distribution Center (`LOG`): Elongated Cross-Dock Freight Terminal
          setSub(ctx, 3);
          ctx.fillStyle = baseCol;
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.5,
            cy - bldH * 0.42,
            bldW,
            bldH * 0.82,
            3,
          );
          ctx.fill();

          setSub(ctx, 4);
          ctx.fillStyle = roofCol;
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.46,
            cy - bldH * 0.38,
            bldW * 0.92,
            bldH * 0.66,
            2,
          );
          ctx.fill();

          // White roof cross-dock bay dividers along the long axis
          setSub(ctx, 5);
          ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
          const bays = Math.max(3, wT + 1);
          for (let b = 0; b < bays; b++) {
            const bx = cx - bldW * 0.32 + (b / (bays - 1)) * (bldW * 0.64);
            ctx.fillRect(bx - 1, cy - bldH * 0.34, 2, bldH * 0.56);
          }
        } else {
          // Secondary Manufacturing (`MFG`)
          setSub(ctx, 3);
          ctx.fillStyle = baseCol;
          ctx.beginPath();
          ctx.roundRect(
            cx - bldW * 0.5,
            cy - bldH * 0.46,
            bldW,
            bldH * 0.9,
            2.5,
          );
          ctx.fill();

          if (d.mfgType === "STEEL") {
            // Heavy foundry hall on left half
            setSub(ctx, 4);
            ctx.fillStyle = roofCol;
            ctx.beginPath();
            ctx.roundRect(
              cx - bldW * 0.46,
              cy - bldH * 0.42,
              bldW * 0.48,
              bldH * 0.8,
              2,
            );
            ctx.fill();

            // Recessed dark slag-yard apron on right half
            ctx.fillStyle = "#27272a";
            ctx.beginPath();
            ctx.roundRect(
              cx + bldW * 0.04,
              cy - bldH * 0.4,
              bldW * 0.42,
              bldH * 0.76,
              1.5,
            );
            ctx.fill();

            // Glowing orange molten-metal launder channel down slag apron
            setSub(ctx, 5);
            const lx = cx + bldW * 0.11;
            ctx.fillStyle = "#f97316";
            ctx.fillRect(lx - 1.2, cy - bldH * 0.35, 2.4, bldH * 0.66);
            ctx.fillStyle = "#fdba74";
            ctx.fillRect(lx - 0.5, cy - bldH * 0.35, 1.0, bldH * 0.66);

            // Twin circular blast-furnace cupolas on right bay
            const cupR = Math.min(bldW, bldH) * 0.14;
            const coreR = Math.min(bldW, bldH) * 0.06;
            const cupX = cx + bldW * 0.26;
            const cupYs = [cy - bldH * 0.18, cy + bldH * 0.14];
            for (const cY of cupYs) {
              setSub(ctx, 5);
              ctx.fillStyle = "#36383e";
              ctx.beginPath();
              ctx.arc(cupX, cY, cupR, 0, Math.PI * 2);
              ctx.fill();

              setSub(ctx, 6);
              ctx.fillStyle = "#f97316";
              ctx.beginPath();
              ctx.arc(cupX, cY, coreR, 0, Math.PI * 2);
              ctx.fill();
            }
          } else if (d.mfgType === "FOOD") {
            // Crisp insulated white cold-storage roof deck over roofCol trim
            setSub(ctx, 4);
            ctx.fillStyle = roofCol;
            ctx.beginPath();
            ctx.roundRect(
              cx - bldW * 0.46,
              cy - bldH * 0.42,
              bldW * 0.92,
              bldH * 0.8,
              2,
            );
            ctx.fill();

            ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
            ctx.beginPath();
            ctx.roundRect(
              cx - bldW * 0.44,
              cy - bldH * 0.4,
              bldW * 0.88,
              bldH * 0.76,
              1.5,
            );
            ctx.fill();

            // 3 parallel rooftop chiller condenser bars on left bay
            setSub(ctx, 5);
            ctx.fillStyle = "#94a3b8";
            const barW = bldW * 0.38;
            const barH = Math.max(1.4, bldH * 0.08);
            const barX = cx - bldW * 0.24;
            const barYs = [cy - bldH * 0.22, cy, cy + bldH * 0.22];
            for (const by of barYs) {
              ctx.fillRect(barX - barW * 0.5, by - barH * 0.5, barW, barH);
            }

            // Twin cylindrical stainless-steel processing vats on right bay
            const vatR = Math.min(bldW, bldH) * 0.13;
            const vatCoords = [
              [cx + bldW * 0.25, cy - bldH * 0.16],
              [cx + bldW * 0.25, cy + bldH * 0.14],
            ];
            for (const [vx, vy] of vatCoords) {
              setSub(ctx, 5);
              ctx.fillStyle = "#e2e8f0";
              ctx.strokeStyle = "#64748b";
              ctx.lineWidth = 1.1;
              ctx.beginPath();
              ctx.arc(vx, vy, vatR, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();

              setSub(ctx, 6);
              ctx.fillStyle = "#ffffff";
              ctx.beginPath();
              ctx.arc(
                vx - vatR * 0.3,
                vy - vatR * 0.3,
                vatR * 0.3,
                0,
                Math.PI * 2,
              );
              ctx.fill();
            }
          } else if (d.mfgType === "TECH") {
            // Precision cleanroom wafer-fab deck
            setSub(ctx, 4);
            ctx.fillStyle = roofCol;
            ctx.beginPath();
            ctx.roundRect(
              cx - bldW * 0.46,
              cy - bldH * 0.42,
              bldW * 0.92,
              bldH * 0.8,
              2,
            );
            ctx.fill();

            // Inset sky-lit glass atrium
            setSub(ctx, 5);
            const atrW = bldW * 0.52;
            const atrH = bldH * 0.44;
            ctx.fillStyle = "rgba(186, 230, 253, 0.65)";
            ctx.fillRect(cx - atrW * 0.5, cy - atrH * 0.5, atrW, atrH);
            ctx.strokeStyle = "#0284c7";
            ctx.lineWidth = 1.1;
            ctx.strokeRect(cx - atrW * 0.5, cy - atrH * 0.5, atrW, atrH);
            ctx.beginPath();
            ctx.moveTo(cx - atrW * 0.5, cy);
            ctx.lineTo(cx + atrW * 0.5, cy);
            ctx.moveTo(cx, cy - atrH * 0.5);
            ctx.lineTo(cx, cy + atrH * 0.5);
            ctx.stroke();

            // 4 symmetrical perimeter cleanroom air-handler pods
            setSub(ctx, 6);
            ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
            const podW = Math.max(3.2, bldW * 0.15);
            const podH = Math.max(2.2, bldH * 0.09);
            const podXs = [cx - bldW * 0.34, cx + bldW * 0.34];
            const podYs = [cy - bldH * 0.33, cy + bldH * 0.31];
            for (const px of podXs) {
              for (const py of podYs) {
                ctx.fillRect(px - podW * 0.5, py - podH * 0.5, podW, podH);
              }
            }
          } else {
            // Multi-bay north-light sawtooth factory roof (GOODS or fallback)
            setSub(ctx, 4);
            const numBays = hT >= 3 ? 4 : 3;
            const bayH = (bldH * 0.82) / numBays;
            for (let bay = 0; bay < numBays; bay++) {
              const by = cy - bldH * 0.42 + bay * bayH;
              ctx.fillStyle = roofCol;
              ctx.fillRect(cx - bldW * 0.46, by, bldW * 0.92, bayH * 0.72);
              ctx.fillStyle = "rgba(224, 242, 254, 0.52)";
              ctx.fillRect(
                cx - bldW * 0.46,
                by + bayH * 0.72,
                bldW * 0.92,
                bayH * 0.24,
              );
            }

            // Compact corner exhaust stack
            setSub(ctx, 5);
            ctx.fillStyle = "#36383e";
            ctx.beginPath();
            ctx.arc(
              cx + bldW * 0.34,
              cy - bldH * 0.3,
              ts * 0.24,
              0,
              Math.PI * 2,
            );
            ctx.fill();

            setSub(ctx, 6);
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(
              cx + bldW * 0.34,
              cy - bldH * 0.3,
              ts * 0.1,
              0,
              Math.PI * 2,
            );
            ctx.fill();
          }
        }

        // Square Cargo Crate Pins on Industrial Roof
        if (wT === 1 || hT === 1) {
          const maxCrates = Math.min(2, d.pinsCount || 0);
          for (let p = 0; p < maxCrates; p++) {
            let px = cx;
            let py = cy;
            if (maxCrates === 2) {
              if (wT >= hT) {
                px = cx - bldW * 0.22 + p * (bldW * 0.44);
              } else {
                py = cy - bldH * 0.22 + p * (bldH * 0.44);
              }
            }
            setSub(ctx, 7);
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(px - 2.1, py - 2.1, 4.2, 4.2);
            setSub(ctx, 8);
            ctx.strokeStyle = pinCol;
            ctx.lineWidth = 1.25;
            ctx.strokeRect(px - 2.1, py - 2.1, 4.2, 4.2);
          }
        } else {
          const isShiftedLeft =
            d.subType === "MFG" &&
            (d.mfgType === "STEEL" || d.mfgType === "FOOD");
          const maxCrates = Math.min(wT * hT >= 6 ? 5 : 4, d.pinsCount || 0);
          const crateCols = isShiftedLeft ? 2 : wT >= 3 ? 3 : 2;
          const startX = isShiftedLeft ? cx - bldW * 0.34 : cx - bldW * 0.32;
          const stepX = isShiftedLeft ? bldW * 0.18 : bldW * 0.24;
          for (let p = 0; p < maxCrates; p++) {
            const px = startX + (p % crateCols) * stepX;
            const py =
              cy - bldH * 0.18 + Math.floor(p / crateCols) * (bldH * 0.26);
            setSub(ctx, 7);
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(px - 2.1, py - 2.1, 4.2, 4.2);
            setSub(ctx, 8);
            ctx.strokeStyle = pinCol;
            ctx.lineWidth = 1.25;
            ctx.strokeRect(px - 2.1, py - 2.1, 4.2, 4.2);
          }
        }
      }

      if (d.hasUrgentPin) {
        const bx = cx - bldW * 0.38;
        const by = cy - bldH * 0.52;
        setSub(ctx, 9);
        ctx.fillStyle = "#d9383a";
        ctx.beginPath();
        ctx.arc(bx, by, 6.5, 0, Math.PI * 2);
        ctx.fill();
        setSub(ctx, 10);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(bx, by, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /*************************************************************************
   * DRAW MULTI-TIER AIRPORTS & LANDSIDE TERMINAL CURBSIDE ROADS
   *************************************************************************/
  drawAirports(ctx, world, ts) {
    for (const ap of world.airports) {
      const cx = ap.x * ts + ts * 0.5;
      const cy = ap.y * ts + ts * 0.5;
      const rwyLen = ap.halfLen * 2 * ts;
      const rwyWid = ts * (ap.isHub ? 1.26 : 1.1);
      const padLen = rwyLen + ts * 1.8;
      const padWid = ap.halfWid * 2 * ts + ts * (ap.isHub ? 2.1 : 1.9);
      const side = ap.apronSide;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ap.angleRad);

      if (ap.isHub) {
        // =================================================================
        // TIER 1: INTERNATIONAL DUAL-RUNWAY HUB (Parallel Runways L & R)
        // =================================================================
        const mainRwyY = -side * (ts * 1.72);
        const outerRwyY = -side * (ts * 3.35);
        const centralTaxiY = -side * (ts * 0.6);

        // High-speed parallel & cross-field taxiways
        setSub(ctx, 0);
        ctx.strokeStyle = "#9ca0a6";
        ctx.lineWidth = ts * 0.36;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(-rwyLen * 0.41, centralTaxiY);
        ctx.lineTo(rwyLen * 0.41, centralTaxiY);
        for (const xFrac of [-0.41, -0.18, 0.18, 0.41]) {
          ctx.moveTo(rwyLen * xFrac, centralTaxiY);
          ctx.lineTo(rwyLen * (xFrac * 1.04), outerRwyY);
        }
        ctx.stroke();

        // Yellow taxiway centerlines
        setSub(ctx, 1);
        ctx.strokeStyle = "#f4c24f";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(-rwyLen * 0.41, centralTaxiY);
        ctx.lineTo(rwyLen * 0.41, centralTaxiY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Render both Parallel Runways (Primary + Secondary)
        for (const [ry, rLenScale, rWidScale] of [
          [mainRwyY, 1.0, 1.0],
          [outerRwyY, 0.88, 0.86],
        ]) {
          const curLen = rwyLen * rLenScale;
          const curWid = rwyWid * rWidScale;
          setSub(ctx, 2);
          ctx.fillStyle = "#36383e";
          ctx.beginPath();
          ctx.roundRect(-curLen * 0.5, ry - curWid * 0.5, curLen, curWid, 4);
          ctx.fill();

          setSub(ctx, 3);
          ctx.strokeStyle = "#f2efe9";
          ctx.lineWidth = 1.6;
          ctx.setLineDash([7, 6]);
          ctx.beginPath();
          ctx.moveTo(-curLen * 0.4, ry);
          ctx.lineTo(curLen * 0.4, ry);
          ctx.stroke();
          ctx.setLineDash([]);

          // Runway piano-key threshold markings
          ctx.fillStyle = "#f2efe9";
          for (const endSign of [-1, 1]) {
            const tx = endSign * (curLen * 0.44);
            for (let b = -2; b <= 2; b++) {
              if (b === 0) continue;
              ctx.fillRect(tx - 3, ry + b * (curWid * 0.16) - 1, 6, 1.8);
            }
          }
        }

        // Multi-Wing International Terminal Concourse + Jetbridges
        const termW = rwyLen * 0.46;
        const termH = ts * 0.76;
        const termY = side * (ts * 1.66);
        const termInnerY = termY - side * (termH * 0.5);

        // Jetbridge fingers extending from concourse front wall to parked aircraft nose doors
        setSub(ctx, 3);
        ctx.strokeStyle = "#7c7f87";
        ctx.lineWidth = 3.0;
        for (let g = -3; g <= 3; g++) {
          const gx = g * (termW * 0.12);
          ctx.beginPath();
          ctx.moveTo(gx, termY);
          ctx.lineTo(gx, termInnerY - side * (ts * 0.08));
          ctx.stroke();
        }

        // Apron gate stand lead-in lines & T-markings extending from the taxiway centerline
        setSub(ctx, 1);
        ctx.strokeStyle = "#f4c24f";
        ctx.lineWidth = 1.2;
        const hubStandY = side * (ts * 1.2);
        const hubStopBarHalf = ts * 0.16;
        ctx.beginPath();
        for (let g = -3; g <= 3; g++) {
          const gx = g * (termW * 0.12);
          ctx.moveTo(gx, centralTaxiY);
          ctx.lineTo(gx, hubStandY);
          ctx.moveTo(gx - hubStopBarHalf, hubStandY);
          ctx.lineTo(gx + hubStopBarHalf, hubStandY);
        }
        ctx.stroke();

        // Terminal Shadow, Base & Roof
        setSub(ctx, 4);
        ctx.fillStyle = PALETTE.shadowColor;
        ctx.beginPath();
        ctx.roundRect(
          -termW * 0.5 + 4,
          termY - termH * 0.5 + 4,
          termW,
          termH,
          6,
        );
        ctx.fill();

        setSub(ctx, 5);
        ctx.fillStyle = ap.palette.base;
        ctx.beginPath();
        ctx.roundRect(-termW * 0.5, termY - termH * 0.5, termW, termH, 6);
        ctx.fill();

        setSub(ctx, 6);
        ctx.fillStyle = ap.palette.roof;
        ctx.beginPath();
        ctx.roundRect(
          -termW * 0.5 + 2,
          termY - termH * 0.5 + 2,
          termW - 4,
          termH * 0.76,
          4,
        );
        ctx.fill();

        // Demand Pins along Concourse Roof
        setSub(ctx, 7);
        ctx.fillStyle = "#ffffff";
        for (let p = 0; p < ap.demandPins; p++) {
          const px = -termW * 0.38 + (p / (ap.demandPins - 1)) * (termW * 0.76);
          ctx.beginPath();
          ctx.arc(px, termY, 2.3, 0, Math.PI * 2);
          ctx.fill();
        }

        // ATC Control Tower
        const towerX = termW * 0.5 + ts * 0.62;
        this.drawAirportTower(ctx, towerX, termY, ts, ap.palette.roof);
      } else {
        // =================================================================
        // TIER 2 & 3: REGIONAL COMMERCIAL ('REG') OR AIR CARGO ('CRG')
        // =================================================================
        const mainRwyY = -side * (ts * 1.68);
        const taxiY = -side * (ts * 0.62);

        setSub(ctx, 0);
        ctx.strokeStyle = "#9ca0a6";
        ctx.lineWidth = ts * 0.34;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(-rwyLen * 0.38, taxiY);
        ctx.lineTo(rwyLen * 0.38, taxiY);
        ctx.moveTo(-rwyLen * 0.38, taxiY);
        ctx.lineTo(-rwyLen * 0.43, mainRwyY);
        ctx.moveTo(0, taxiY);
        ctx.lineTo(0, mainRwyY);
        ctx.moveTo(rwyLen * 0.38, taxiY);
        ctx.lineTo(rwyLen * 0.43, mainRwyY);
        ctx.stroke();

        // Main Asphalt Runway Strip
        setSub(ctx, 2);
        ctx.fillStyle = "#36383e";
        ctx.beginPath();
        ctx.roundRect(
          -rwyLen * 0.5,
          mainRwyY - rwyWid * 0.5,
          rwyLen,
          rwyWid,
          4,
        );
        ctx.fill();

        setSub(ctx, 3);
        ctx.strokeStyle = "#f2efe9";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(-rwyLen * 0.38, mainRwyY);
        ctx.lineTo(rwyLen * 0.38, mainRwyY);
        ctx.stroke();
        ctx.setLineDash([]);

        const termW = rwyLen * 0.4;
        const termH = ts * 0.7;
        const termY = side * (ts * 1.54);

        // Compact short yellow gate stand T-markings in the regional/cargo apron bay
        setSub(ctx, 1);
        ctx.strokeStyle = "#f4c24f";
        ctx.lineWidth = 1.2;
        const regFracs =
          ap.airportClass === "CRG"
            ? [-0.42, -0.22, 0.22, 0.42]
            : [-0.36, -0.12, 0.12, 0.36];
        const regStandStartY = side * (ts * 0.68);
        const regStandY = side * (ts * 1.12);
        const regStopBarHalf = ts * 0.14;
        ctx.beginPath();
        for (const frac of regFracs) {
          const gx = frac * termW;
          ctx.moveTo(gx, regStandStartY);
          ctx.lineTo(gx, regStandY);
          ctx.moveTo(gx - regStopBarHalf, regStandY);
          ctx.lineTo(gx + regStopBarHalf, regStandY);
        }
        ctx.stroke();

        if (ap.airportClass === "CRG") {
          // Cargo Airfield: Twin Modular Warehouse Sortation Pads
          for (const wSign of [-1, 1]) {
            const wx = wSign * (termW * 0.32);
            const ww = termW * 0.48;
            setSub(ctx, 4);
            ctx.fillStyle = PALETTE.shadowColor;
            ctx.beginPath();
            ctx.roundRect(
              wx - ww * 0.5 + 4,
              termY - termH * 0.5 + 4,
              ww,
              termH,
              4,
            );
            ctx.fill();

            setSub(ctx, 5);
            ctx.fillStyle = ap.palette.base;
            ctx.beginPath();
            ctx.roundRect(wx - ww * 0.5, termY - termH * 0.5, ww, termH, 4);
            ctx.fill();

            setSub(ctx, 6);
            ctx.fillStyle = ap.palette.roof;
            ctx.beginPath();
            ctx.roundRect(
              wx - ww * 0.5 + 1.5,
              termY - termH * 0.5 + 1.5,
              ww - 3,
              termH * 0.75,
              3,
            );
            ctx.fill();
          }
        } else {
          // Regional Passenger Terminal Concourse
          setSub(ctx, 4);
          ctx.fillStyle = PALETTE.shadowColor;
          ctx.beginPath();
          ctx.roundRect(
            -termW * 0.5 + 5,
            termY - termH * 0.5 + 5,
            termW,
            termH,
            6,
          );
          ctx.fill();

          setSub(ctx, 5);
          ctx.fillStyle = ap.palette.base;
          ctx.beginPath();
          ctx.roundRect(-termW * 0.5, termY - termH * 0.5, termW, termH, 6);
          ctx.fill();

          setSub(ctx, 6);
          ctx.fillStyle = ap.palette.roof;
          ctx.beginPath();
          ctx.roundRect(
            -termW * 0.5 + 2,
            termY - termH * 0.5 + 2,
            termW - 4,
            termH * 0.76,
            5,
          );
          ctx.fill();
        }

        // Demand Pins on Roof
        setSub(ctx, 7);
        ctx.fillStyle = "#ffffff";
        for (let p = 0; p < ap.demandPins; p++) {
          const px = -termW * 0.34 + (p / (ap.demandPins - 1)) * (termW * 0.68);
          ctx.beginPath();
          ctx.arc(px, termY, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }

        const towerX = termW * 0.5 + ts * 0.65;
        this.drawAirportTower(ctx, towerX, termY, ts, ap.palette.roof);
      }

      ctx.restore();

      const cosA = Math.cos(ap.angleRad);
      const sinA = Math.sin(ap.angleRad);
      const gatePy = ap.gateY * ts + ts * 0.5;

      // Floating Minimalist IATA & Tier Pill Tag (floating cleanly above the northernmost facility bounds)
      const corners = [
        [-padLen * 0.5, -padWid * 0.5],
        [padLen * 0.5, -padWid * 0.5],
        [padLen * 0.5, padWid * 0.5],
        [-padLen * 0.5, padWid * 0.5],
      ];
      let minY = Infinity;
      let maxY = -Infinity;
      let minX = Infinity;
      let maxX = -Infinity;
      for (const [u, v] of corners) {
        const wx = cx + u * cosA - v * sinA;
        const wy = cy + u * sinA + v * cosA;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
      }
      if (gatePy < minY) minY = gatePy;
      if (gatePy > maxY) maxY = gatePy;

      ctx.save();
      ctx.font = "800 10px Inter, sans-serif";
      const badgePrefix =
        ap.airportClass === "HUB"
          ? "✈ HUB"
          : ap.airportClass === "CRG"
            ? "📦 CRG"
            : "✈ REG";
      const tagText = `${badgePrefix} • ${ap.iata}`;
      const tw = ctx.measureText(tagText).width + 14;

      const badgeX = Math.max(
        tw * 0.5 + 10,
        Math.min(world.W * ts - tw * 0.5 - 10, (minX + maxX) * 0.5),
      );
      const badgeY = minY >= 36 ? minY - 15 : maxY + 20;

      setSub(ctx, 8);
      ctx.fillStyle = ap.isHub ? "#e85c90" : "#36383e";
      ctx.beginPath();
      ctx.roundRect(badgeX - tw * 0.5, badgeY - 9, tw, 18, 9);
      ctx.fill();
      ctx.fillStyle = "#f2efe9";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tagText, badgeX, badgeY);
      ctx.restore();
    }
  }

  drawAirportTower(ctx, towerX, termY, ts, accentColor) {
    setSub(ctx, 4);
    ctx.fillStyle = PALETTE.shadowColor;
    ctx.beginPath();
    ctx.arc(towerX + 4, termY + 4, ts * 0.48, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(towerX, termY, ts * 0.48, 0, Math.PI * 2);
    setSub(ctx, 5);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    setSub(ctx, 6);
    ctx.strokeStyle = "#36383e";
    ctx.lineWidth = 2;
    ctx.stroke();

    setSub(ctx, 7);
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.arc(towerX, termY, ts * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }

  /*************************************************************************
   * DRAW SWEEPING PINK MOTORWAYS, CLOVERLEAFS, STREET-STUBS & DIAMOND RAMPS
   *************************************************************************/
  traceMotorwaySamples(ctx, samples, ts, oxOffset = 0, oyOffset = 0) {
    if (!samples || samples.length < 2) return;
    const ox = ts * 0.5 + oxOffset;
    const oy = ts * 0.5 + oyOffset;
    ctx.beginPath();
    ctx.moveTo(samples[0].x * ts + ox, samples[0].y * ts + oy);
    if (samples.length === 2) {
      ctx.lineTo(samples[1].x * ts + ox, samples[1].y * ts + oy);
    } else {
      for (let i = 1; i <= samples.length - 2; i++) {
        const p1 = samples[i];
        const p2 = samples[i + 1];
        ctx.quadraticCurveTo(
          p1.x * ts + ox,
          p1.y * ts + oy,
          (p1.x + p2.x) * 0.5 * ts + ox,
          (p1.y + p2.y) * 0.5 * ts + oy,
        );
      }
      const last = samples[samples.length - 1];
      ctx.lineTo(last.x * ts + ox, last.y * ts + oy);
    }
  }

  /**
   * Builds the unified Level-1 coalesced ground drop shadow path (z = 0.5) covering all above-ground
   * motorway surface spans, cloverleaf slip-ramps & loops, trumpet ramps, and tapering diamond slip-ramps.
   *
   * @param {ProceduralLogisticsWorld} world
   * @param {number} ts
   * @returns {Path2D}
   */
  buildCoalescedGroundShadowPath(world, ts) {
    const groundShadowUnionPath = new Path2DCtor();
    const ox = ts * 0.5;
    const oy = ts * 0.5;

    // 1. All elevated motorway surface spans
    for (const mw of world.motorways || []) {
      const samples = mw.samples;
      if (!samples || samples.length < 2) continue;

      const tunnels = mw.tunnels || [];
      let surfaceSpans = mw.surfaceSpans;
      if (!surfaceSpans) {
        surfaceSpans = [];
        let curStart = 0;
        for (const tun of tunnels) {
          if (tun.i0 >= curStart) {
            const seg = samples.slice(curStart, tun.i0 + 1);
            if (seg.length >= 2) surfaceSpans.push(seg);
          }
          curStart = tun.i1;
        }
        if (curStart < samples.length - 1) {
          const tail = samples.slice(curStart);
          if (tail.length >= 2) surfaceSpans.push(tail);
        }
      }

      const termPts = [];
      if (!mw.prunedStart) termPts.push({ x: mw.sx, y: mw.sy });
      if (!mw.prunedEnd) termPts.push({ x: mw.ex, y: mw.ey });
      const portalPts = [];
      for (const tun of tunnels) {
        portalPts.push({ x: tun.x0, y: tun.y0 }, { x: tun.x1, y: tun.y1 });
      }
      const evalShadowElevation = (pt) => {
        let h = 1.0;
        for (const tp of termPts) {
          const d = Math.hypot(pt.x - tp.x, pt.y - tp.y);
          const f = Math.max(0, Math.min(1, (d - 1.5) / 3.6));
          if (f < h) h = f;
        }
        for (const pp of portalPts) {
          const d = Math.hypot(pt.x - pp.x, pt.y - pp.y);
          const f = Math.max(0, Math.min(1, d / 2.6));
          if (f < h) h = f;
        }
        return h * h * (3 - 2 * h);
      };

      for (const seg of surfaceSpans) {
        const ribbonPts = seg.map((pt) => {
          const sh = evalShadowElevation(pt);
          return {
            x: pt.x * ts + ox + 3.5 * sh,
            y: pt.y * ts + oy + 4.8 * sh,
            halfW: ts * (0.22 + 0.2 * sh),
          };
        });
        extrudeRibbonToPath2D(groundShadowUnionPath, ribbonPts, true);
      }
    }

    // 2. All Cloverleaf, Trumpet, and Diamond interchange ramps
    for (const ic of world.interchanges || []) {
      const cx = ic.x * ts + ox;
      const cy = ic.y * ts + oy;

      if (ic.type === "cloverleaf") {
        const uAx = Math.cos(ic.angleA);
        const uAy = Math.sin(ic.angleA);
        const uBx = Math.cos(ic.angleB);
        const uBy = Math.sin(ic.angleB);

        const signsA = ic.activeSignsA || [-1, 1];
        const signsB = ic.activeSignsB || [-1, 1];
        const quadrants = [];
        for (const sA of signsA) {
          for (const sB of signsB) {
            quadrants.push([sA, sB]);
          }
        }

        const outerDist = ts * 3.65;
        const outerCtrl = ts * 1.75;
        const leafSpan = ts * 4.85;

        for (const [sA, sB] of quadrants) {
          const rAx = sA * uAx;
          const rAy = sA * uAy;
          const rBx = sB * uBx;
          const rBy = sB * uBy;

          // Outer quadratic slip-ramp (outerDist = ts * 3.65, outerCtrl = ts * 1.75, 12 steps, offset +3.5, +4.8, halfW = ts * 0.19)
          const pStart = { x: cx + rAx * outerDist, y: cy + rAy * outerDist };
          const pCtrl = {
            x: cx + (rAx + rBx) * outerCtrl,
            y: cy + (rAy + rBy) * outerCtrl,
          };
          const pEnd = { x: cx + rBx * outerDist, y: cy + rBy * outerDist };

          const outerPts = [];
          for (let step = 0; step <= 12; step++) {
            const t = step / 12;
            const mt = 1 - t;
            const px =
              mt * mt * pStart.x + 2 * mt * t * pCtrl.x + t * t * pEnd.x;
            const py =
              mt * mt * pStart.y + 2 * mt * t * pCtrl.y + t * t * pEnd.y;
            outerPts.push({
              x: px + 3.5,
              y: py + 4.8,
              halfW: ts * 0.19,
            });
          }
          extrudeRibbonToPath2D(groundShadowUnionPath, outerPts, true);

          // Inner cubic 270° loop (leafSpan = ts * 4.85), split into TWO open halves
          // (t in [0, 0.5] and t in [0.5, 1.0], 10 steps each, offset +3.5, +4.8, halfW = ts * 0.20)
          const p0 = { x: cx, y: cy };
          const p1 = { x: cx + rAx * leafSpan, y: cy + rAy * leafSpan };
          const p2 = { x: cx + rBx * leafSpan, y: cy + rBy * leafSpan };
          const p3 = { x: cx, y: cy };

          const half1Pts = [];
          for (let step = 0; step <= 10; step++) {
            const t = (step / 10) * 0.5;
            const mt = 1 - t;
            const px =
              mt * mt * mt * p0.x +
              3 * mt * mt * t * p1.x +
              3 * mt * t * t * p2.x +
              t * t * t * p3.x;
            const py =
              mt * mt * mt * p0.y +
              3 * mt * mt * t * p1.y +
              3 * mt * t * t * p2.y +
              t * t * t * p3.y;
            half1Pts.push({
              x: px + 3.5,
              y: py + 4.8,
              halfW: ts * 0.2,
            });
          }
          extrudeRibbonToPath2D(groundShadowUnionPath, half1Pts, true);

          const half2Pts = [];
          for (let step = 0; step <= 10; step++) {
            const t = 0.5 + (step / 10) * 0.5;
            const mt = 1 - t;
            const px =
              mt * mt * mt * p0.x +
              3 * mt * mt * t * p1.x +
              3 * mt * t * t * p2.x +
              t * t * t * p3.x;
            const py =
              mt * mt * mt * p0.y +
              3 * mt * mt * t * p1.y +
              3 * mt * t * t * p2.y +
              t * t * t * p3.y;
            half2Pts.push({
              x: px + 3.5,
              y: py + 4.8,
              halfW: ts * 0.2,
            });
          }
          extrudeRibbonToPath2D(groundShadowUnionPath, half2Pts, true);
        }
      } else if (ic.type === "trumpet") {
        const ramps = computeTrumpetRampBeziers(ic, world.motorways);
        const sampleSegShadow = (seg) => {
          const pts = [];
          for (let step = 0; step <= 12; step++) {
            const t = step / 12;
            const mt = 1 - t;
            const wx =
              mt * mt * mt * seg.p0.x +
              3 * mt * mt * t * seg.p1.x +
              3 * mt * t * t * seg.p2.x +
              t * t * t * seg.p3.x;
            const wy =
              mt * mt * mt * seg.p0.y +
              3 * mt * mt * t * seg.p1.y +
              3 * mt * t * t * seg.p2.y +
              t * t * t * seg.p3.y;
            pts.push({
              x: wx * ts + ox + 3.5,
              y: wy * ts + oy + 4.8,
              halfW: ts * 0.19,
            });
          }
          extrudeRibbonToPath2D(groundShadowUnionPath, pts, true);
        };

        sampleSegShadow(ramps.yellow);
        sampleSegShadow(ramps.purple);
        for (const seg of ramps.brown) sampleSegShadow(seg);
        for (const seg of ramps.blue) sampleSegShadow(seg);
      } else if (ic.type === "diamond-ramp") {
        for (const ramp of ic.ramps || []) {
          const rampPts = [];
          for (let step = 0; step <= 10; step++) {
            const t = step / 10;
            const mt = 1 - t;
            const bx =
              mt * mt * mt * ramp.p0.x +
              3 * mt * mt * t * ramp.p1.x +
              3 * mt * t * t * ramp.p2.x +
              t * t * t * ramp.p3.x;
            const by =
              mt * mt * mt * ramp.p0.y +
              3 * mt * mt * t * ramp.p1.y +
              3 * mt * t * t * ramp.p2.y +
              t * t * t * ramp.p3.y;
            const rawH = 1 - t;
            const sh = rawH * rawH * (3 - 2 * rawH);
            rampPts.push({
              x: bx * ts + ox + 3.5 * sh,
              y: by * ts + oy + 4.8 * sh,
              halfW: ts * (0.08 + 0.1 * sh),
            });
          }
          extrudeRibbonToPath2D(groundShadowUnionPath, rampPts, true);
        }
      }
    }

    return groundShadowUnionPath;
  }

  drawInterchangesUnderlay(ctx, world, ts) {
    const ox = ts * 0.5;
    const oy = ts * 0.5;

    for (const ic of world.interchanges) {
      const cx = ic.x * ts + ox;
      const cy = ic.y * ts + oy;

      if (ic.type === "cloverleaf") {
        // =================================================================
        // TANGENT-ALIGNED CLOVERLEAF / 3-WAY TRUMPET INTERCHANGE
        // (Elides ramps toward any pruned stub end)
        // =================================================================
        const uAx = Math.cos(ic.angleA);
        const uAy = Math.sin(ic.angleA);
        const uBx = Math.cos(ic.angleB);
        const uBy = Math.sin(ic.angleB);

        const signsA = ic.activeSignsA || [-1, 1];
        const signsB = ic.activeSignsB || [-1, 1];
        const quadrants = [];
        for (const sA of signsA) {
          for (const sB of signsB) {
            quadrants.push([sA, sB]);
          }
        }

        const outerDist = ts * 3.65;
        const outerCtrl = ts * 1.75;
        const leafSpan = ts * 4.85;

        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        // 1. Outer Concave Right-Turn Slip Ramps (Casing + Pink Fill)
        for (const pass of ["border", "fill"]) {
          setSub(ctx, pass === "border" ? 0 : 1);
          ctx.strokeStyle =
            pass === "border" ? PALETTE.motorwayBorder : "#f48fb1";
          ctx.lineWidth = pass === "border" ? ts * 0.36 : ts * 0.22;
          for (const [sA, sB] of quadrants) {
            const rAx = sA * uAx,
              rAy = sA * uAy;
            const rBx = sB * uBx,
              rBy = sB * uBy;
            ctx.beginPath();
            ctx.moveTo(cx + rAx * outerDist, cy + rAy * outerDist);
            ctx.quadraticCurveTo(
              cx + (rAx + rBx) * outerCtrl,
              cy + (rAy + rBy) * outerCtrl,
              cx + rBx * outerDist,
              cy + rBy * outerDist,
            );
            ctx.stroke();
          }
        }

        // 2. Inner 270° Tangent Cloverleaf Loops (Casing + Pink Fill)
        for (const pass of ["border", "fill"]) {
          setSub(ctx, pass === "border" ? 2 : 3);
          ctx.strokeStyle =
            pass === "border" ? PALETTE.motorwayBorder : PALETTE.motorwayFill;
          ctx.lineWidth = pass === "border" ? ts * 0.38 : ts * 0.24;
          for (const [sA, sB] of quadrants) {
            const rAx = sA * uAx,
              rAy = sA * uAy;
            const rBx = sB * uBx,
              rBy = sB * uBy;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.bezierCurveTo(
              cx + rAx * leafSpan,
              cy + rAy * leafSpan,
              cx + rBx * leafSpan,
              cy + rBy * leafSpan,
              cx,
              cy,
            );
            ctx.stroke();
          }
        }
        ctx.restore();
      } else if (ic.type === "trumpet") {
        // =================================================================
        // AUTHENTIC 3-WAY TRUMPET INTERCHANGE (Curve-Anchored C1 4-Ramp Layout)
        // =================================================================
        const ramps = computeTrumpetRampBeziers(ic, world.motorways);

        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        const strokeCubicChain = (segs) => {
          ctx.beginPath();
          ctx.moveTo(segs[0].p0.x * ts + ox, segs[0].p0.y * ts + oy);
          for (const seg of segs) {
            ctx.bezierCurveTo(
              seg.p1.x * ts + ox,
              seg.p1.y * ts + oy,
              seg.p2.x * ts + ox,
              seg.p2.y * ts + oy,
              seg.p3.x * ts + ox,
              seg.p3.y * ts + oy,
            );
          }
          ctx.stroke();
        };

        // Casing + Pink Ramp Fill (all 4 ramps)
        for (const pass of ["border", "fill"]) {
          setSub(ctx, pass === "border" ? 0 : 1);
          ctx.strokeStyle =
            pass === "border" ? PALETTE.motorwayBorder : "#f48fb1";
          ctx.lineWidth = pass === "border" ? ts * 0.34 : ts * 0.21;
          strokeCubicChain([ramps.yellow]);
          strokeCubicChain([ramps.purple]);
          strokeCubicChain(ramps.brown);
          strokeCubicChain(ramps.blue);
        }

        ctx.restore();
      } else if (ic.type === "diamond-ramp") {
        // =================================================================
        // DIAMOND INTERCHANGE OVERPASS BRIDGE PARAPETS
        // =================================================================
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(ic.angleRad);
        setSub(ctx, 0);
        ctx.lineCap = "butt";
        ctx.strokeStyle = "#36383e";
        ctx.lineWidth = ts * 1.04;
        ctx.beginPath();
        ctx.moveTo(-ts * 0.68, 0);
        ctx.lineTo(ts * 0.68, 0);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  drawMotorways(ctx, world, ts) {
    // 0. Unified Coalesced Ground Shadow Plane (z = 0.5)
    const groundShadowUnionPath = this.buildCoalescedGroundShadowPath(
      world,
      ts,
    );
    setSub(ctx, 0);
    ctx.fillStyle = "rgba(45, 42, 38, 0.12)";
    ctx.fill(groundShadowUnionPath, "nonzero");
    nextPass(ctx);

    // 1. Draw Cloverleaf Loops & Trumpet Slip-Ramps underneath the main decks
    this.drawInterchangesUnderlay(ctx, world, ts);
    nextPass(ctx);

    const roundabouts = world.routingGraph?.roundabouts || [];

    // 2. Draw Mainline Elevated Pink Expressways
    for (const mw of world.motorways) {
      const samples = mw.samples;
      if (!samples || samples.length < 2) continue;

      const sx = mw.sx * ts + ts * 0.5;
      const sy = mw.sy * ts + ts * 0.5;
      const ex = mw.ex * ts + ts * 0.5;
      const ey = mw.ey * ts + ts * 0.5;

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Clip out the non-pruned terminal roundabout asphalt rings (`rbR + ts * clipMargin`) so the pink
      // expressway stops cleanly at the outer edge of each roundabout without needing a second-pass
      // roundabout layer that would clip vehicles driving through the roundabout!
      const termEndpoints = [];
      if (!mw.prunedStart) termEndpoints.push([sx, sy]);
      if (!mw.prunedEnd) termEndpoints.push([ex, ey]);
      if (termEndpoints.length > 0) {
        ctx.beginPath();
        ctx.rect(
          -ts * 50,
          -ts * 50,
          (world.W + 100) * ts,
          (world.H + 100) * ts,
        );
        for (const [rx, ry] of termEndpoints) {
          const matchedRb = roundabouts.find(
            (rb) =>
              Math.hypot(rb.x * ts + ts * 0.5 - rx, rb.y * ts + ts * 0.5 - ry) <
              1.0,
          );
          const rbRadius = matchedRb
            ? matchedRb.rTiles
            : WORLD_GEOMETRY.ROUNDABOUT_RADII.townStub;
          const clipR =
            (rbRadius + WORLD_GEOMETRY.ROUNDABOUT_RADII.clipMargin) * ts;
          ctx.moveTo(rx + clipR, ry);
          ctx.arc(rx, ry, clipR, 0, Math.PI * 2);
        }
        ctx.clip("evenodd");
      }

      // Use precomputed `mw.surfaceSpans` when available (with fallback for synthetic tests)
      const tunnels = mw.tunnels || [];
      let surfaceSpans = mw.surfaceSpans;
      if (!surfaceSpans) {
        surfaceSpans = [];
        let curStart = 0;
        for (const tun of tunnels) {
          if (tun.i0 >= curStart) {
            const seg = samples.slice(curStart, tun.i0 + 1);
            if (seg.length >= 2) surfaceSpans.push(seg);
          }
          curStart = tun.i1;
        }
        if (curStart < samples.length - 1) {
          const tail = samples.slice(curStart);
          if (tail.length >= 2) surfaceSpans.push(tail);
        }
      }

      // 1. Subterranean Mountain Tunnel Bore (Full-width dashed charcoal bore casing + bold dashed pink deck, zero drop shadow!)
      if (tunnels.length > 0) {
        setSub(ctx, 1);
        ctx.lineCap = "butt";
        ctx.strokeStyle = "rgba(54, 56, 62, 0.42)";
        ctx.lineWidth = ts * 0.84;
        ctx.setLineDash([7, 5]);
        for (const tun of tunnels) {
          const tSamples = samples.slice(tun.i0, tun.i1 + 1);
          if (tSamples.length >= 2) {
            this.traceMotorwaySamples(ctx, tSamples, ts, 0, 0);
            ctx.stroke();
          }
        }

        setSub(ctx, 2);
        ctx.strokeStyle = "rgba(232, 92, 144, 0.72)";
        ctx.lineWidth = ts * 0.56;
        for (const tun of tunnels) {
          const tSamples = samples.slice(tun.i0, tun.i1 + 1);
          if (tSamples.length >= 2) {
            this.traceMotorwaySamples(ctx, tSamples, ts, 0, 0);
            ctx.stroke();
          }
        }
        ctx.setLineDash([]);
        ctx.lineCap = "round";
      }

      // 2. Vibrant Pink Motorway Outer Casing (above-ground spans only)
      setSub(ctx, 3);
      ctx.strokeStyle = PALETTE.motorwayBorder;
      ctx.lineWidth = ts * 0.88;
      for (const seg of surfaceSpans) {
        this.traceMotorwaySamples(ctx, seg, ts, 0, 0);
        ctx.stroke();
      }

      // 3. Translucent Pink Motorway Deck (above-ground spans only)
      setSub(ctx, 4);
      ctx.strokeStyle = PALETTE.motorwayFill;
      ctx.lineWidth = ts * 0.72;
      for (const seg of surfaceSpans) {
        this.traceMotorwaySamples(ctx, seg, ts, 0, 0);
        ctx.stroke();
      }

      // 4. Crisp Median Divider Line (above-ground spans only)
      setSub(ctx, 5);
      ctx.strokeStyle = PALETTE.motorwayCore;
      ctx.lineWidth = 2.0;
      for (const seg of surfaceSpans) {
        this.traceMotorwaySamples(ctx, seg, ts, 0, 0);
        ctx.stroke();
      }

      // 5. Concrete Tunnel Portal Mouths at Entry & Exit of Each Mountain Tunnel
      if (tunnels.length > 0) {
        for (const tun of tunnels) {
          for (const [px, py, ang] of [
            [tun.x0 * ts + ts * 0.5, tun.y0 * ts + ts * 0.5, tun.ang0],
            [
              tun.x1 * ts + ts * 0.5,
              tun.y1 * ts + ts * 0.5,
              tun.ang1 + Math.PI,
            ],
          ]) {
            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(ang);
            ctx.beginPath();
            ctx.roundRect(-3.5, -ts * 0.56, 7.0, ts * 1.12, 2.5);
            setSub(ctx, 6);
            ctx.fillStyle = "#36383e";
            ctx.fill();
            setSub(ctx, 7);
            ctx.strokeStyle = "#f2efe9";
            ctx.lineWidth = 1.4;
            ctx.stroke();
            setSub(ctx, 8);
            ctx.fillStyle = "#1f2024";
            ctx.beginPath();
            ctx.arc(1.5, 0, ts * 0.34, -Math.PI * 0.5, Math.PI * 0.5);
            ctx.fill();
            ctx.restore();
          }
        }
      }

      // Use precomputed Highway Shield Badge (`mw.shieldPt`) position
      let shieldPt = mw.shieldPt;
      if (!shieldPt) {
        shieldPt = samples[Math.floor(samples.length * 0.5)];
        let bestClearance = -Infinity;
        const iMin = Math.max(2, Math.floor(samples.length * 0.16));
        const iMax = Math.min(
          samples.length - 3,
          Math.ceil(samples.length * 0.84),
        );
        for (let i = iMin; i <= iMax; i++) {
          const cand = samples[i];
          let minIcDist = Math.min(
            Math.hypot(cand.x - mw.sx, cand.y - mw.sy),
            Math.hypot(cand.x - mw.ex, cand.y - mw.ey),
          );
          for (const ic of world.interchanges) {
            const dIc = Math.hypot(ic.x - cand.x, ic.y - cand.y);
            if (dIc < minIcDist) minIcDist = dIc;
          }
          const centerBias =
            1.0 - Math.abs(i / (samples.length - 1) - 0.5) * 0.35;
          const score = Math.min(minIcDist, 14.0) * centerBias;
          if (score > bestClearance) {
            bestClearance = score;
            shieldPt = cand;
          }
        }
      }
      const bx = shieldPt.x * ts + ts * 0.5;
      const by = shieldPt.y * ts + ts * 0.5;

      ctx.beginPath();
      const sw = 11;
      const sh = 12;
      ctx.moveTo(bx - sw, by - sh * 0.75);
      ctx.lineTo(bx + sw, by - sh * 0.75);
      ctx.lineTo(bx + sw, by + sh * 0.15);
      ctx.quadraticCurveTo(bx, by + sh, bx, by + sh);
      ctx.quadraticCurveTo(bx, by + sh, bx - sw, by + sh * 0.15);
      ctx.closePath();
      setSub(ctx, 9);
      ctx.fillStyle = "#f2efe9";
      ctx.fill();
      setSub(ctx, 10);
      ctx.strokeStyle = "#36383e";
      ctx.lineWidth = 2.2;
      ctx.stroke();

      ctx.fillStyle = "#36383e";
      ctx.font = "800 11px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(mw.number), bx, by + 0.5);
      ctx.restore();
    }
  }

  /**
   * Draws Level-2 overpass bridge spans (clipped lower-deck drop shadows, upper bridge decks, core medians, and parapet rails)
   * for Cloverleaf and Trumpet interchanges.
   *
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | VectorLayerRecorder} ctx
   * @param {ProceduralLogisticsWorld} world
   * @param {number} ts
   */
  drawOverpassBridges(ctx, world, ts) {
    const ox = ts * 0.5;
    const oy = ts * 0.5;

    for (const ic of world.interchanges || []) {
      if (ic.type === "cloverleaf") {
        const cx = ic.x * ts + ox;
        const cy = ic.y * ts + oy;
        const span = ts * 1.32;
        const bridgeAng = ic.prunedBridgeB ? ic.angleA : ic.angleB;
        const lowerAng = ic.prunedBridgeB ? ic.angleB : ic.angleA;
        const ux = Math.cos(bridgeAng);
        const uy = Math.sin(bridgeAng);
        const nx = -uy;
        const ny = ux;
        const halfDeck = ts * 0.46;
        const lux = Math.cos(lowerAng);
        const luy = Math.sin(lowerAng);

        const lowerClip = new Path2DCtor();
        extrudeRibbonToPath2D(
          lowerClip,
          [
            {
              x: cx - lux * 2.2 * ts,
              y: cy - luy * 2.2 * ts,
              halfW: ts * 0.44,
            },
            {
              x: cx + lux * 2.2 * ts,
              y: cy + luy * 2.2 * ts,
              halfW: ts * 0.44,
            },
          ],
          false,
        );

        ctx.save();
        ctx.clip(lowerClip);
        setSub(ctx, 0);
        ctx.lineCap = "butt";
        ctx.strokeStyle = "rgba(45, 42, 38, 0.20)";
        ctx.lineWidth = ts * 0.92;
        ctx.beginPath();
        ctx.moveTo(cx - ux * span + 3.2, cy - uy * span + 4.4);
        ctx.lineTo(cx + ux * span + 3.2, cy + uy * span + 4.4);
        ctx.stroke();
        ctx.restore();
        nextPass(ctx);

        // Upper bridge span (±1.32 * ts, lineCap = "butt")
        ctx.save();
        ctx.lineCap = "butt";

        setSub(ctx, 1);
        ctx.strokeStyle = PALETTE.motorwayBorder;
        ctx.lineWidth = ts * 0.88;
        ctx.beginPath();
        ctx.moveTo(cx - ux * span, cy - uy * span);
        ctx.lineTo(cx + ux * span, cy + uy * span);
        ctx.stroke();

        setSub(ctx, 2);
        ctx.strokeStyle = "#ee6998";
        ctx.lineWidth = ts * 0.72;
        ctx.beginPath();
        ctx.moveTo(cx - ux * span, cy - uy * span);
        ctx.lineTo(cx + ux * span, cy + uy * span);
        ctx.stroke();

        setSub(ctx, 3);
        ctx.strokeStyle = PALETTE.motorwayCore;
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.moveTo(cx - ux * span, cy - uy * span);
        ctx.lineTo(cx + ux * span, cy + uy * span);
        ctx.stroke();

        setSub(ctx, 4);
        ctx.strokeStyle = "#36383e";
        ctx.lineWidth = 2.2;
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(
            cx - ux * span + nx * halfDeck * side,
            cy - uy * span + ny * halfDeck * side,
          );
          ctx.lineTo(
            cx + ux * span + nx * halfDeck * side,
            cy + uy * span + ny * halfDeck * side,
          );
          ctx.stroke();
        }
        ctx.restore();
        nextPass(ctx);
      } else if (ic.type === "trumpet") {
        const cx = ic.x * ts + ox;
        const cy = ic.y * ts + oy;
        const sy = ic.sideSign || 1;
        const spurAng = ic.angleMain + Math.PI * 0.5 * sy;
        const ux = Math.cos(spurAng);
        const uy = Math.sin(spurAng);
        const nx = -uy;
        const ny = ux;
        const spanIn = ts * 0.56;
        const spanOut = ts * 0.44;
        const halfDeck = ts * 0.45;
        const lux = Math.cos(ic.angleMain);
        const luy = Math.sin(ic.angleMain);

        const lowerClip = new Path2DCtor();
        extrudeRibbonToPath2D(
          lowerClip,
          [
            {
              x: cx - lux * 2.0 * ts,
              y: cy - luy * 2.0 * ts,
              halfW: ts * 0.44,
            },
            {
              x: cx + lux * 2.0 * ts,
              y: cy + luy * 2.0 * ts,
              halfW: ts * 0.44,
            },
          ],
          false,
        );

        ctx.save();
        ctx.clip(lowerClip);
        setSub(ctx, 0);
        ctx.lineCap = "butt";
        ctx.strokeStyle = "rgba(45, 42, 38, 0.20)";
        ctx.lineWidth = ts * 0.84;
        ctx.beginPath();
        ctx.moveTo(cx + ux * spanIn + 3.2, cy + uy * spanIn + 4.4);
        ctx.lineTo(cx - ux * spanOut + 3.2, cy - uy * spanOut + 4.4);
        ctx.stroke();
        ctx.restore();
        nextPass(ctx);

        // Upper Trumpet bridge span (lineCap = "butt")
        ctx.save();
        ctx.lineCap = "butt";

        setSub(ctx, 1);
        ctx.strokeStyle = PALETTE.motorwayBorder;
        ctx.lineWidth = ts * 0.86;
        ctx.beginPath();
        ctx.moveTo(cx + ux * spanIn, cy + uy * spanIn);
        ctx.lineTo(cx - ux * spanOut, cy - uy * spanOut);
        ctx.stroke();

        setSub(ctx, 2);
        ctx.strokeStyle = "#ee6998";
        ctx.lineWidth = ts * 0.7;
        ctx.beginPath();
        ctx.moveTo(cx + ux * spanIn, cy + uy * spanIn);
        ctx.lineTo(cx - ux * spanOut, cy - uy * spanOut);
        ctx.stroke();

        setSub(ctx, 3);
        ctx.strokeStyle = PALETTE.motorwayCore;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(cx + ux * spanIn, cy + uy * spanIn);
        ctx.lineTo(cx - ux * spanOut, cy - uy * spanOut);
        ctx.stroke();

        setSub(ctx, 4);
        ctx.strokeStyle = "#36383e";
        ctx.lineWidth = 2.0;
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(
            cx + ux * spanIn + nx * halfDeck * side,
            cy + uy * spanIn + ny * halfDeck * side,
          );
          ctx.lineTo(
            cx - ux * spanOut + nx * halfDeck * side,
            cy - uy * spanOut + ny * halfDeck * side,
          );
          ctx.stroke();
        }
        ctx.restore();
        nextPass(ctx);
      }
    }
  }

  /**
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
   * @param {ProceduralLogisticsWorld} _world
   * @param {any} sim
   * @param {number} ts
   * @param {"road" | "motorway" | "motorway-lower" | "motorway-upper" | null} [modeFilter=null]
   */
  drawCars(ctx, _world, sim, ts, modeFilter = null) {
    const ox = ts * 0.5;
    const oy = ts * 0.5;

    for (const car of sim.cars) {
      const track = car.returning ? car.inboundTrack : car.outboundTrack;
      if (!track || !track.pts || track.pts.length < 2) continue;

      const idx = Math.min(car.segIdx, track.pts.length - 2);
      const p0 = track.pts[idx];
      const p1 = track.pts[idx + 1];
      if (!p0 || !p1) continue;
      if (p0.inTunnel && p1.inTunnel) continue;

      const curMode = p0.onMotorway || p1.onMotorway ? "motorway" : "road";
      if (modeFilter) {
        if (modeFilter === "road") {
          if (curMode !== "road") continue;
        } else if (modeFilter === "motorway") {
          if (curMode !== "motorway") continue;
        } else if (modeFilter === "motorway-lower") {
          if (curMode !== "motorway" || p0.onUpperBridge || p1.onUpperBridge)
            continue;
        } else if (modeFilter === "motorway-upper") {
          if (
            curMode !== "motorway" ||
            (!p0.onUpperBridge && !p1.onUpperBridge)
          )
            continue;
        }
      }

      const d0 = track.cumLen[idx];
      const segLen = Math.max(1e-4, track.cumLen[idx + 1] - d0);
      const frac = Math.max(0, Math.min(1, (car.dist - d0) / segLen));

      const x = (p0.x + (p1.x - p0.x) * frac) * ts + ox;
      const y = (p0.y + (p1.y - p0.y) * frac) * ts + oy;
      const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      if (car.isFreightTruck) {
        // Articulated Freight Truck (Charcoal tractor cab + Cargo-colored loaded trailer or neutral unloaded return flatbed)
        ctx.fillStyle = "#36383e";
        ctx.beginPath();
        ctx.roundRect(1.8, -2.8, 4.2, 5.6, 1.5);
        ctx.fill();
        ctx.fillStyle =
          car.isCargoLink && car.returning ? "#94a3b8" : car.color;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.roundRect(-6.8, -3.0, 8.2, 6.0, 1.5);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillStyle = car.color;
        ctx.beginPath();
        ctx.roundRect(-4.2, -2.4, 8.4, 4.8, 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /**
   * Records or draws subtle runway-aligned dashed airway arcs between airports.
   *
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | VectorLayerRecorder} ctx
   * @param {ProceduralLogisticsWorld} world
   * @param {number} ts
   */
  drawAirwayCorridors(ctx, world, ts) {
    if (!world.airports || world.airports.length === 0) return;

    for (const ap of world.airports) {
      if (!ap.atc) {
        initAirportATC(ap, world.windVector || null);
      }
    }

    ctx.save();
    ctx.strokeStyle = "rgba(54, 56, 62, 0.12)";
    ctx.lineWidth = 1.1;
    ctx.setLineDash([5, 6]);

    const halfTs = ts * 0.5;
    if (world.airports.length >= 2) {
      for (const apA of world.airports) {
        for (const apB of world.airports) {
          if (apA.id === apB.id) continue;
          const track = buildFlightTrack(apA, apB, {
            oSign: apA.activeSign,
            dSign: apB.activeSign,
          });
          const { sx, sy, c1x, c1y, c2x, c2y, ex, ey } = track.airwayCurve;
          ctx.beginPath();
          ctx.moveTo(sx * ts + halfTs, sy * ts + halfTs);
          ctx.bezierCurveTo(
            c1x * ts + halfTs,
            c1y * ts + halfTs,
            c2x * ts + halfTs,
            c2y * ts + halfTs,
            ex * ts + halfTs,
            ey * ts + halfTs,
          );
          ctx.stroke();
        }
      }
    } else if (world.airports.length === 1) {
      const ap = world.airports[0];
      if (ap) {
        const ang = ap.angleRad ?? 0;
        /** @type {PlaneEndpoint} */
        const dest = {
          x: ap.x + Math.cos(ang + 0.35) * 95,
          y: ap.y + Math.sin(ang + 0.35) * 95,
          angleRad: ang,
          halfLen: 6,
        };
        const track = buildFlightTrack(ap, dest);
        const { sx, sy, c1x, c1y, c2x, c2y, ex, ey } = track.airwayCurve;
        ctx.beginPath();
        ctx.moveTo(sx * ts + halfTs, sy * ts + halfTs);
        ctx.bezierCurveTo(
          c1x * ts + halfTs,
          c1y * ts + halfTs,
          c2x * ts + halfTs,
          c2y * ts + halfTs,
          ex * ts + halfTs,
          ey * ts + halfTs,
        );
        ctx.stroke();
      }
    }

    // External trade airway corridors to map-border entry points
    for (const ap of world.airports) {
      for (const corr of ap.externalCorridors || []) {
        const sx = ap.x;
        const sy = ap.y;
        const ex = corr.entryX;
        const ey = corr.entryY;
        const cdx = ex - sx;
        const cdy = ey - sy;
        const cDist = Math.hypot(cdx, cdy) || 1;
        const ang = ap.angleRad ?? 0;
        const cosAng = Math.cos(ang);
        const sinAng = Math.sin(ang);
        const dot = cdx * cosAng + cdy * sinAng;
        const sign = dot >= 0 ? 1 : -1;
        const pull = Math.min(24, Math.max(6, cDist * 0.35));
        const c1x = sx + cosAng * sign * pull;
        const c1y = sy + sinAng * sign * pull;
        const corrAng = corr.angleRad ?? Math.atan2(cdy, cdx);
        const c2x = ex - Math.cos(corrAng) * (pull * 0.7);
        const c2y = ey - Math.sin(corrAng) * (pull * 0.7);

        ctx.beginPath();
        ctx.moveTo(sx * ts + halfTs, sy * ts + halfTs);
        ctx.bezierCurveTo(
          c1x * ts + halfTs,
          c1y * ts + halfTs,
          c2x * ts + halfTs,
          c2y * ts + halfTs,
          ex * ts + halfTs,
          ey * ts + halfTs,
        );
        ctx.stroke();
      }
    }

    ctx.setLineDash([]);
    ctx.restore();
  }

  /**
   * Draws live aircraft in either ground taxi/gate phase or airborne cruise/takeoff/landing phase.
   *
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
   * @param {ProceduralLogisticsWorld} _world
   * @param {any} sim
   * @param {number} ts
   * @param {"ground" | "air" | null} [layerMode=null]
   */
  drawPlanes(ctx, _world, sim, ts, layerMode = null) {
    if (!sim || !sim.planes) return;

    for (const p of sim.planes) {
      const alt = p.altitude ?? 0;
      const isGround = alt <= 0.001;

      if (layerMode === "ground" && !isGround) continue;
      if (layerMode === "air" && isGround) continue;

      const px = p.x * ts + ts * 0.5;
      const py = p.y * ts + ts * 0.5;
      const ang = p.ang ?? 0;
      const isCargo = Boolean(
        p.isCargoFreighter || p.aircraftType === "WIDEBODY_FREIGHTER",
      );
      const accent = p.color || null;

      const shadowOff = isGround ? 1.2 : 1.5 + alt * 22;
      const bodyScale = isGround ? 0.85 : 0.85 + alt * 0.35;
      const shadowScale = isGround ? 0.85 : 0.75 + alt * 0.2;

      // Ground contact or parallax shadow
      this.drawAirplaneSilhouette(
        ctx,
        px + shadowOff,
        py + shadowOff,
        ang,
        shadowScale,
        "rgba(18, 22, 28, 0.18)",
        null,
        null,
        isCargo,
        p.aircraftType || null,
      );

      // Crisp White & Color-Accented Minimalist Aircraft Body
      this.drawAirplaneSilhouette(
        ctx,
        px,
        py,
        ang,
        bodyScale,
        "#ffffff",
        "#36383e",
        accent,
        isCargo,
        p.aircraftType || null,
      );

      // Active ATC hold indicator for grounded aircraft
      const planeState = p.state;
      const isHolding =
        isGround &&
        Boolean(
          p.holdingShort ||
          planeState === "HOLD_SHORT_QUEUE" ||
          planeState === "HOLD_CROSSING_RUNWAY" ||
          planeState === "PUSHBACK_HOLD",
        );

      if (isHolding) {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang);
        const noseX =
          (p.aircraftType === "FEEDER_TURBOPROP"
            ? 8.0
            : isCargo
              ? 14.0
              : 11.0) *
            bodyScale +
          2.6;

        // Subtle amber hold-bar indicator perpendicular to heading
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 1.6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(noseX, -3.2);
        ctx.lineTo(noseX, 3.2);
        ctx.stroke();

        // Subtle amber beacon dot near nose
        ctx.fillStyle = "#f59e0b";
        ctx.beginPath();
        ctx.arc(noseX - 1.0, 0, 1.3, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
      }
    }
  }

  /**
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} ang
   * @param {number} scale
   * @param {string} fill
   * @param {string | null} [stroke=null]
   * @param {string | null} [accentColor=null]
   * @param {boolean} [isCargoFreighter=false]
   * @param {string | null} [aircraftType=null]
   */
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
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.scale(scale, scale);

    const isShadow = fill === "rgba(18, 22, 28, 0.18)";

    ctx.fillStyle = fill;
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.4;
    }

    if (aircraftType === "FEEDER_TURBOPROP") {
      // -------------------------------------------------------------
      // Feeder Turboprop — Cessna 208 Caravan / Super Cargomaster
      // Compact single-engine utility turboprop with visible nose propeller & spinner
      // -------------------------------------------------------------
      // 1. Nose Propeller Assembly (compact ±2.05 span ahead of cowling stroke)
      ctx.save();
      ctx.lineCap = "round";
      ctx.strokeStyle = isShadow ? fill : "#1f242d";
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      ctx.moveTo(7.55, -2.05);
      ctx.lineTo(7.55, 2.05);
      ctx.stroke();
      ctx.restore();

      // 2. Unified fuselage + utility Caravan wing (span ±7.4, sturdy chord) + horizontal tailplane
      ctx.beginPath();
      // Flat-shouldered PT6A turboprop cowling & cabin
      ctx.moveTo(5.9, -0.9);
      ctx.lineTo(5.9, 0.9);
      ctx.quadraticCurveTo(5.8, 1.35, 4.5, 1.48);
      ctx.lineTo(2.1, 1.52);
      // Right utility straight wing (sturdy 5.2:1 aspect ratio, unswept leading edge + tapered outer trailing edge)
      ctx.lineTo(2.1, 7.4);
      ctx.lineTo(-0.05, 7.4);
      ctx.lineTo(-1.05, 3.5);
      ctx.lineTo(-1.05, 1.52);
      // Tapered aft fuselage & horizontal tailplane
      ctx.lineTo(-5.1, 1.05);
      ctx.lineTo(-5.7, 3.35);
      ctx.lineTo(-7.3, 3.35);
      ctx.lineTo(-7.7, 0);
      // Left horizontal tailplane & aft fuselage
      ctx.lineTo(-7.3, -3.35);
      ctx.lineTo(-5.7, -3.35);
      ctx.lineTo(-5.1, -1.05);
      // Left wing
      ctx.lineTo(-1.05, -1.52);
      ctx.lineTo(-1.05, -3.5);
      ctx.lineTo(-0.05, -7.4);
      ctx.lineTo(2.1, -7.4);
      ctx.lineTo(2.1, -1.52);
      // Left forward cabin & cowling shoulder
      ctx.lineTo(4.5, -1.48);
      ctx.quadraticCurveTo(5.8, -1.35, 5.9, -0.9);
      ctx.closePath();
      ctx.fill();
      if (stroke) {
        ctx.stroke();
      }

      // 3. Center Nose Spinner Cone (projects from cowling x = 5.9 through prop hub to x = 8.35)
      ctx.beginPath();
      ctx.moveTo(8.35, 0);
      ctx.quadraticCurveTo(7.7, 0.42, 5.9, 0.42);
      ctx.lineTo(5.9, -0.42);
      ctx.quadraticCurveTo(7.7, -0.42, 8.35, 0);
      ctx.closePath();
      ctx.fillStyle = isShadow ? fill : "#36383e";
      ctx.fill();

      // Caravan wingtip tabs & vertical tail fin livery accents
      if (!isShadow) {
        const propColor =
          this && this.activeLayer === "rci"
            ? "#0284c7"
            : accentColor || "#0284c7";

        ctx.fillStyle = propColor;
        ctx.beginPath();
        ctx.moveTo(2.1, 7.4);
        ctx.lineTo(-0.05, 7.4);
        ctx.lineTo(-0.28, 5.9);
        ctx.lineTo(2.1, 5.9);
        ctx.closePath();
        ctx.moveTo(2.1, -7.4);
        ctx.lineTo(-0.05, -7.4);
        ctx.lineTo(-0.28, -5.9);
        ctx.lineTo(2.1, -5.9);
        ctx.closePath();
        ctx.moveTo(-4.7, 0);
        ctx.lineTo(-7.4, 0.82);
        ctx.lineTo(-7.4, -0.82);
        ctx.closePath();
        ctx.fill();
      }
    } else if (isCargoFreighter || aircraftType === "WIDEBODY_FREIGHTER") {
      // -------------------------------------------------------------
      // Wide-Body Air Cargo Freighter — Boeing 767-300F
      // Twin under-wing high-bypass turbofans (drawn UNDER the wing first) + wide-body cylindrical fuselage
      // -------------------------------------------------------------
      // 1. Under-wing twin high-bypass turbofan nacelles (Z-ordered underneath the wing!)
      const nacelles = [-5.5, 5.5];
      for (const ny of nacelles) {
        ctx.beginPath();
        ctx.roundRect(1.4, ny - 1.35, 4.4, 2.7, 0.95);
        ctx.fill();
        if (stroke) {
          ctx.stroke();
        }
      }

      // 2. Unified wide-body fuselage + swept wings + swept empennage silhouette
      ctx.beginPath();
      // Rounded 767 radome nose & cylindrical wide-body forward fuselage
      ctx.moveTo(14.0, 0);
      ctx.bezierCurveTo(14.0, 1.35, 12.4, 2.45, 9.6, 2.45);
      ctx.lineTo(4.8, 2.45);
      // Right swept wing (31.5° leading-edge sweep + Yehudi trailing-edge root fillet)
      ctx.lineTo(-2.4, 13.8);
      ctx.lineTo(-4.6, 13.8);
      ctx.lineTo(-1.8, 5.8);
      ctx.lineTo(-1.2, 2.45);
      // Cylindrical rear wide-body fuselage & tapered tailcone
      ctx.lineTo(-8.2, 2.3);
      ctx.lineTo(-10.0, 1.65);
      // Right swept horizontal stabilizer
      ctx.lineTo(-13.0, 6.6);
      ctx.lineTo(-14.4, 6.6);
      ctx.lineTo(-12.8, 0.85);
      ctx.lineTo(-14.0, 0);
      // Left swept horizontal stabilizer
      ctx.lineTo(-12.8, -0.85);
      ctx.lineTo(-14.4, -6.6);
      ctx.lineTo(-13.0, -6.6);
      ctx.lineTo(-10.0, -1.65);
      ctx.lineTo(-8.2, -2.3);
      // Left swept wing
      ctx.lineTo(-1.2, -2.45);
      ctx.lineTo(-1.8, -5.8);
      ctx.lineTo(-4.6, -13.8);
      ctx.lineTo(-2.4, -13.8);
      ctx.lineTo(4.8, -2.45);
      // Left forward fuselage & rounded radome nose
      ctx.lineTo(9.6, -2.45);
      ctx.bezierCurveTo(12.4, -2.45, 14.0, -1.35, 14.0, 0);
      ctx.closePath();
      ctx.fill();
      if (stroke) {
        ctx.stroke();
      }

      // Livery accents when drawing aircraft body (not shadow)
      if (!isShadow) {
        const cargoColor =
          this && this.activeLayer === "rci"
            ? "#8b5cf6"
            : accentColor || "#d97706";
        ctx.fillStyle = cargoColor;

        // Wingtip cargo winglets (left & right)
        ctx.beginPath();
        ctx.moveTo(-2.4, 13.8);
        ctx.lineTo(-4.6, 13.8);
        ctx.lineTo(-4.0, 11.6);
        ctx.lineTo(-1.9, 11.6);
        ctx.closePath();
        ctx.moveTo(-2.4, -13.8);
        ctx.lineTo(-4.6, -13.8);
        ctx.lineTo(-4.0, -11.6);
        ctx.lineTo(-1.9, -11.6);
        ctx.closePath();
        ctx.fill();

        // Swept vertical tail fin & stabilizer tips
        ctx.beginPath();
        ctx.moveTo(-8.4, 0);
        ctx.lineTo(-13.6, 1.75);
        ctx.lineTo(-13.6, -1.75);
        ctx.closePath();
        ctx.moveTo(-13.0, 6.6);
        ctx.lineTo(-14.4, 6.6);
        ctx.lineTo(-13.8, 5.0);
        ctx.lineTo(-12.4, 5.0);
        ctx.closePath();
        ctx.moveTo(-13.0, -6.6);
        ctx.lineTo(-14.4, -6.6);
        ctx.lineTo(-13.8, -5.0);
        ctx.lineTo(-12.4, -5.0);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      // -------------------------------------------------------------
      // Passenger Jet — Bombardier CRJ700 Regional Jet
      // Slender stretched forward cabin + clean swept wings + twin rear fuselage-mounted CF34 engine pods
      // -------------------------------------------------------------
      // 1. Twin Rear Fuselage-Mounted CF34 Turbofan Pods (Z-ordered behind fuselage, clear of wing & T-tail)
      const rearPods = [-2.85, 2.85];
      for (const py of rearPods) {
        ctx.beginPath();
        ctx.roundRect(-6.7, py - 1.05, 3.5, 2.1, 0.85);
        ctx.fill();
        if (stroke) {
          ctx.stroke();
        }
      }

      // 2. Unified CRJ700 slender fuselage + clean swept wing + swept T-tail silhouette
      ctx.beginPath();
      // Pointed CRJ radome & long stretched forward cabin
      ctx.moveTo(11.6, 0);
      ctx.quadraticCurveTo(10.5, 1.25, 7.8, 1.52);
      ctx.lineTo(2.2, 1.52);
      // Right clean swept wing (canted CRJ winglet tip)
      ctx.lineTo(-2.4, 9.6);
      ctx.lineTo(-4.4, 9.6);
      ctx.lineTo(-1.9, 1.52);
      // Aft fuselage (flanked by the twin CF34 engine pods) & swept T-tail stabilizer
      ctx.lineTo(-8.8, 1.28);
      ctx.lineTo(-11.4, 4.8);
      ctx.lineTo(-12.8, 4.8);
      ctx.lineTo(-11.8, 0);
      // Left swept T-tail stabilizer & aft fuselage
      ctx.lineTo(-12.8, -4.8);
      ctx.lineTo(-11.4, -4.8);
      ctx.lineTo(-8.8, -1.28);
      // Left clean swept wing
      ctx.lineTo(-1.9, -1.52);
      ctx.lineTo(-4.4, -9.6);
      ctx.lineTo(-2.4, -9.6);
      ctx.lineTo(2.2, -1.52);
      // Left forward cabin & radome
      ctx.lineTo(7.8, -1.52);
      ctx.quadraticCurveTo(10.5, -1.25, 11.6, 0);
      ctx.closePath();
      ctx.fill();
      if (stroke) ctx.stroke();

      // Livery accents when drawing aircraft body (not shadow)
      if (!isShadow && accentColor) {
        ctx.fillStyle = accentColor;

        // Canted CRJ wingtip winglets (left and right)
        ctx.beginPath();
        ctx.moveTo(-2.4, 9.6);
        ctx.lineTo(-4.4, 9.6);
        ctx.lineTo(-3.9, 8.0);
        ctx.lineTo(-2.1, 8.0);
        ctx.closePath();
        ctx.moveTo(-2.4, -9.6);
        ctx.lineTo(-4.4, -9.6);
        ctx.lineTo(-3.9, -8.0);
        ctx.lineTo(-2.1, -8.0);
        ctx.closePath();
        ctx.fill();

        // Swept T-tail fin & horizontal stabilizer tips
        ctx.beginPath();
        ctx.moveTo(-8.6, 0);
        ctx.lineTo(-12.6, 1.55);
        ctx.lineTo(-12.6, -1.55);
        ctx.closePath();
        ctx.moveTo(-11.4, 4.8);
        ctx.lineTo(-12.8, 4.8);
        ctx.lineTo(-12.3, 3.5);
        ctx.lineTo(-11.1, 3.5);
        ctx.closePath();
        ctx.moveTo(-11.4, -4.8);
        ctx.lineTo(-12.8, -4.8);
        ctx.lineTo(-12.3, -3.5);
        ctx.lineTo(-11.1, -3.5);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();
  }

  /*************************************************************************
   * ALGORITHMIC INSPECTION OVERLAYS
   *************************************************************************/
  drawAirportSolverOverlay(ctx, world, ts) {
    ctx.save();
    // 1. Render Multi-Criteria Airport Candidate Suitability Heatmap
    for (let y = 0; y < world.H; y += 2) {
      for (let x = 0; x < world.W; x += 2) {
        const score = world.airportHeatmap[world.idx(x, y)];
        if (score > 0.05) {
          ctx.fillStyle =
            score > 0.65
              ? `rgba(16, 185, 129, ${score * 0.55})`
              : `rgba(245, 158, 11, ${score * 0.45})`;
          ctx.fillRect(x * ts, y * ts, ts * 2, ts * 2);
        }
      }
    }

    // 2. Render NIMBY Urban Noise Exclusion Rings around Towns
    for (const t of world.towns) {
      ctx.strokeStyle = "rgba(239, 68, 68, 0.55)";
      ctx.fillStyle = "rgba(239, 68, 68, 0.08)";
      ctx.lineWidth = 1.8;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(
        t.x * ts + ts * 0.5,
        t.y * ts + ts * 0.5,
        t.urbanRadius * 0.78 * ts,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // 3. Render Trapezoidal Approach Obstacle-Clearance Funnels on Both Runway Ends
    for (const ap of world.airports) {
      const cx = ap.x * ts + ts * 0.5;
      const cy = ap.y * ts + ts * 0.5;
      const rwyHalf = ap.halfLen * ts;
      const appLen = ap.approachLen * ts;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ap.angleRad);

      for (const sign of [-1, 1]) {
        ctx.fillStyle = "rgba(16, 185, 129, 0.22)";
        ctx.strokeStyle = "#059669";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(sign * rwyHalf, -ts * 0.9);
        ctx.lineTo(sign * (rwyHalf + appLen), -ts * 3.6);
        ctx.lineTo(sign * (rwyHalf + appLen), ts * 3.6);
        ctx.lineTo(sign * rwyHalf, ts * 0.9);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  drawRCIZoneUnderlay(ctx, world, ts) {
    ctx.save();
    // Paint SimCity-style R / C / I zone ground halos beneath buildings
    ctx.fillStyle = "rgba(34, 197, 94, 0.20)";
    ctx.beginPath();
    for (const h of world.houses) {
      ctx.rect((h.x - 0.35) * ts, (h.y - 0.35) * ts, ts * 1.7, ts * 1.7);
    }
    ctx.fill();

    for (const d of world.destinations) {
      const wT = d.wTiles || 2;
      const hT = d.hTiles || 2;
      const zw = (wT + 1.2) * ts;
      const zh = (hT + 1.2) * ts;
      ctx.fillStyle =
        d.zoneType === "commercial"
          ? "rgba(59, 130, 246, 0.28)"
          : "rgba(245, 158, 11, 0.28)";
      ctx.beginPath();
      ctx.roundRect(
        (d.x + 0.5) * ts - zw * 0.5,
        (d.y + 0.5) * ts - zh * 0.5,
        zw,
        zh,
        8,
      );
      ctx.fill();
    }
    ctx.restore();
  }

  drawRCICargoChainOverlay(ctx, world, ts) {
    ctx.save();
    const ox = ts * 0.5;
    const oy = ts * 0.5;

    // 1. Draw Active Inter-Industrial Supply Chain Flow Corridors along actual A* Road Paths (`link.points`)
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const link of world.cargoLinks || []) {
      const pts = link.outboundTrack?.pts || link.points;
      if (!pts || pts.length < 2) continue;

      // Subtle white halo under freight route
      ctx.strokeStyle = "rgba(255, 255, 255, 0.72)";
      ctx.lineWidth = 4.2;
      ctx.setLineDash([]);
      ctx.beginPath();
      this.traceSmoothPath(ctx, pts, ts);
      ctx.stroke();

      // Colored dashed supply chain corridor
      const linkColor =
        link.color ||
        (link.stage === "CBD->CBD"
          ? "#0284c7"
          : link.stage?.includes("IMPORT") || link.stage?.includes("EXPORT")
            ? "#0d9488"
            : link.stage === "MFG->MFG"
              ? "#e11d48"
              : link.stage === "MFG->LOG"
                ? "#ea580c"
                : link.stage === "RAW->MFG" || link.stage === "RAW->LOG"
                  ? "#d97706"
                  : link.stage === "MFG->COM"
                    ? "#4f46e5"
                    : link.stage === "LOG->COM"
                      ? "#7c3aed"
                      : "#ea580c");
      ctx.strokeStyle = linkColor;
      ctx.lineWidth = 2.4;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      this.traceSmoothPath(ctx, pts, ts);
      ctx.stroke();
      ctx.setLineDash([]);

      // Directional chevron arrowhead at the midpoint of the road path
      const midIdx = Math.max(
        0,
        Math.min(pts.length - 2, Math.floor(pts.length * 0.5)),
      );
      const p0 = pts[midIdx];
      const p1 = pts[Math.min(pts.length - 1, midIdx + 2)];
      const ax = (p0.x + p1.x) * 0.5 * ts + ox;
      const ay = (p0.y + p1.y) * 0.5 * ts + oy;
      const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(ang);
      ctx.fillStyle = linkColor;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(5.5, 0);
      ctx.lineTo(-4, -4.2);
      ctx.lineTo(-4, 4.2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // 2. Draw Compact Stage Badges on Industrial Nodes (`RAW`, `MFG`, `LOG`) & CBD Commercial Landmarks (`CBD`)
    //    with screen-space collision culling so adjacent pills never overlap at low zoom!
    ctx.font = "800 8.5px DM Sans, Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const suppressedBadgeIds = new Set();
    const sel = this.selectedEntity;
    if (
      sel &&
      "zoneType" in sel &&
      (sel.zoneType === "industrial" || sel.zoneType === "commercial")
    ) {
      suppressedBadgeIds.add(sel.id);
      if (world.cargoLinks) {
        for (const link of world.cargoLinks) {
          if (link.from?.id === sel.id && link.to?.id != null) {
            suppressedBadgeIds.add(link.to.id);
          } else if (link.to?.id === sel.id && link.from?.id != null) {
            suppressedBadgeIds.add(link.from.id);
          }
        }
      }
    }

    const badgeCandidates = [];
    for (const d of world.destinations) {
      if (suppressedBadgeIds.has(d.id)) continue;
      if (d.zoneType === "industrial") {
        let tag = "RAW";
        let bg = "#d97706";
        if (d.isGatewayProxy) {
          tag = d.label || "AIR";
          bg = "#0d9488";
        } else if (d.subType === "RAW") {
          if (d.resourceType === "MINE") {
            tag = "MINE";
            bg = "#d97706";
          } else if (d.resourceType === "TIMBER") {
            tag = "WOOD";
            bg = "#d97706";
          } else if (d.resourceType === "FARM") {
            tag = "FARM";
            bg = "#d97706";
          } else if (d.resourceType === "FISHERY") {
            tag = "FISH";
            bg = "#0e7490";
          } else if (d.resourceType === "CHEM") {
            tag = "CHEM";
            bg = "#4d7c0f";
          } else {
            tag = "RAW";
            bg = "#d97706";
          }
        } else if (d.subType === "LOG") {
          tag = "LOG";
          bg = "#7c3aed";
        } else if (d.subType === "MFG") {
          tag = d.mfgType || "MFG";
          bg = "#ea580c";
        } else {
          tag = d.subType || "MFG";
          bg = "#ea580c";
        }
        const prio = d.isRuralNiche
          ? 1
          : tag === "LOG" || tag === "AIR"
            ? 2
            : d.subType === "MFG"
              ? 3
              : 5;
        const bw = tag.length >= 5 ? 34 : tag.length >= 4 ? 30 : 26;
        badgeCandidates.push({
          d,
          tag,
          bg,
          bw,
          prio,
        });
      } else if (d.isCircular) {
        badgeCandidates.push({ d, tag: "CBD", bg: "#1d4ed8", bw: 26, prio: 4 });
      }
    }
    badgeCandidates.sort((a, b) => a.prio - b.prio);

    const placedBadgeRects = [];
    const zoom = this.camera.zoom || 1;
    for (const bc of badgeCandidates) {
      const hT = bc.d.hTiles || 2;
      const cx = bc.d.x * ts + ox;
      const cy = bc.d.y * ts + oy - (hT * 0.5 + 0.38) * ts;
      const sx = cx * zoom;
      const sy = cy * zoom;
      const halfW = (bc.bw * 0.5 + 2) * zoom;
      const halfH = 7.5 * zoom;
      const collides = placedBadgeRects.some(
        (r) =>
          Math.abs(sx - r.sx) < halfW + r.halfW &&
          Math.abs(sy - r.sy) < halfH + r.halfH,
      );
      if (collides) continue;
      placedBadgeRects.push({ sx, sy, halfW, halfH });

      ctx.fillStyle = bc.bg;
      ctx.beginPath();
      ctx.roundRect(cx - bc.bw * 0.5, cy - 6.5, bc.bw, 13, 3.5);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(bc.tag, cx, cy + 0.5);
    }
    ctx.restore();
  }

  drawHierarchyOverlay(ctx, world, ts) {
    ctx.save();
    // Draw Logistics Graph Edges & Town Hierarchy Badges
    for (const t of world.towns) {
      const cx = t.x * ts + ts * 0.5;
      const cy = t.y * ts + ts * 0.5;

      ctx.strokeStyle = t.palette.base;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, t.urbanRadius * ts, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Town Label Card
      ctx.font = "800 11px DM Sans, Inter, sans-serif";
      const label = `${t.name} (T${t.tier})`;
      const w = ctx.measureText(label).width + 14;
      ctx.fillStyle = "#36383e";
      ctx.beginPath();
      ctx.roundRect(cx - w * 0.5, cy - 26, w, 20, 6);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, cy - 16);
    }
    ctx.restore();
  }

  drawHydrologyOverlay(ctx, world, ts) {
    ctx.save();
    for (let y = 0; y < world.H - 1; y += 2) {
      for (let x = 0; x < world.W - 1; x += 2) {
        const id = world.idx(x, y);
        // Ensure all 4 sub-tiles of the 2×2 cell are dry land clear of riverbanks so squares don't bleed onto water!
        if (
          world.waterMask[id] === 0 &&
          world.waterMask[world.idx(x + 1, y)] === 0 &&
          world.waterMask[world.idx(x, y + 1)] === 0 &&
          world.waterMask[world.idx(x + 1, y + 1)] === 0 &&
          world.distToWater[id] >= 1.5
        ) {
          const elev = world.elevationField[id];
          const hAbove = Math.max(0, elev - world.seaLevel);
          if (hAbove > 0.16) {
            // Latent upland hill/ridge elevation contour band
            const band = Math.floor(hAbove * 18) / 18;
            ctx.fillStyle = `rgba(120, 113, 108, ${Math.min(0.45, band * 0.85)})`;
            ctx.fillRect(x * ts, y * ts, ts * 2, ts * 2);
          } else {
            const u = world.urbanSuitability[id];
            ctx.fillStyle = `rgba(59, 130, 246, ${u * 0.48})`;
            ctx.fillRect(x * ts, y * ts, ts * 2, ts * 2);
          }
        }
      }
    }
    // Highlight regional hydro features (confluences, lakes, firths)
    for (const hf of world.hydroFeatures) {
      const cx = hf.x * ts;
      const cy = hf.y * ts;
      ctx.strokeStyle = hf.type === "confluence" ? "#0284c7" : "#0d9488";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, ts * 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Derives or retrieves road graph topology diagnostics directly from the precomputed
   * world road topology or via the memoized vehicle routing topology solver.
   *
   * @param {ProceduralLogisticsWorld} world
   * @returns {RoadGraphDiagnostics & {
   *   activeTracks: number,
   *   rampTraversals: number,
   *   roundaboutOrbits: number,
   *   reversalAnomalies: number,
   * }}
   */
  computeRoadGraphDiagnostics(world) {
    if (!world || !world.roads) {
      return {
        deg: new Uint8Array(0),
        edgeCount: 0,
        streetTiles: 0,
        arterialTiles: 0,
        bridgeTiles: 0,
        junctionCount: 0,
        rampEdgeCount: 0,
        laneTrackCount: 0,
        activeTracks: 0,
        rampTraversals: 0,
        roundaboutOrbits: 0,
        reversalAnomalies: 0,
        anomalies: [],
      };
    }

    if (this._cachedRoadDiagWorld === world && this._cachedRoadDiag) {
      return this._cachedRoadDiag;
    }

    const topo =
      world.roadTopology ||
      deriveRoadTopology(world.W, world.H, world.roads, world.buildingMask);
    const rampEdges =
      world.routingGraph?.rampEdges || world._vehicleGraph?.rampEdges || [];

    const allTracks = [];
    for (const rt of world.commuterRoutes || []) {
      if (rt.outboundTrack?.pts?.length >= 2) allTracks.push(rt.outboundTrack);
      if (rt.inboundTrack?.pts?.length >= 2) allTracks.push(rt.inboundTrack);
    }
    for (const lk of world.cargoLinks || []) {
      if (lk.outboundTrack?.pts?.length >= 2) allTracks.push(lk.outboundTrack);
      if (lk.inboundTrack?.pts?.length >= 2) allTracks.push(lk.inboundTrack);
    }

    const activeTracks = allTracks.length;
    let rampTraversals = 0;
    let roundaboutOrbits = 0;
    let reversalAnomalies = 0;

    for (const tr of allTracks) {
      const pts = tr.pts;
      let hasRamp = false;
      let hasRoundabout = false;

      for (let i = 0; i < pts.length; i++) {
        const pt = pts[i];
        if (pt.isSlipRamp) hasRamp = true;
        if (pt.isRoundabout || pt.isRoundaboutArc) hasRoundabout = true;

        if (i >= 1 && i < pts.length - 1) {
          const pPrev = pts[i - 1];
          const pCurr = pt;
          const pNext = pts[i + 1];
          const dx1 = pCurr.x - pPrev.x;
          const dy1 = pCurr.y - pPrev.y;
          const dx2 = pNext.x - pCurr.x;
          const dy2 = pNext.y - pCurr.y;
          const len1 = Math.hypot(dx1, dy1);
          const len2 = Math.hypot(dx2, dy2);
          if (len1 > 1e-4 && len2 > 1e-4) {
            const cosTurn = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
            if (cosTurn < -0.5) {
              reversalAnomalies++;
            }
          }
        }
      }

      if (hasRamp) rampTraversals++;
      if (hasRoundabout) roundaboutOrbits++;
    }

    const diag = {
      deg: topo.vertexDeg,
      edgeCount: topo.edgeCount,
      streetTiles: topo.streetTiles,
      arterialTiles: topo.arterialTiles,
      bridgeTiles: topo.bridgeTiles,
      junctionCount: topo.junctionCount,
      rampEdgeCount: rampEdges.length,
      laneTrackCount: activeTracks,
      activeTracks,
      rampTraversals,
      roundaboutOrbits,
      reversalAnomalies,
      anomalies: topo.anomalies,
    };

    this._cachedRoadDiagWorld = world;
    this._cachedRoadDiag = diag;
    return diag;
  }

  drawRoadGridUnderlay(ctx, world, ts) {
    ctx.save();
    const { W, H } = world;

    // 1. Building Mask Footprint Outlines (`1 = house`, `2 = commercial/industrial`, `3 = airport`, `4 = transit reserve`)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const id = world.idx(x, y);
        const bm = world.buildingMask[id];
        const rg = world.roadGrid[id];

        if (bm === 1 || bm === 2) {
          ctx.fillStyle =
            bm === 1 ? "rgba(22, 163, 74, 0.14)" : "rgba(37, 99, 235, 0.16)";
          ctx.fillRect(x * ts + 0.5, y * ts + 0.5, ts - 1, ts - 1);
        } else if (bm === 4 && rg === 0) {
          ctx.fillStyle = "rgba(139, 92, 246, 0.10)";
          ctx.fillRect(x * ts + 0.5, y * ts + 0.5, ts - 1, ts - 1);
        }

        if (rg > 0) {
          if (rg === 1) {
            ctx.fillStyle = "rgba(14, 165, 233, 0.30)";
            ctx.strokeStyle = "rgba(2, 132, 199, 0.55)";
          } else if (rg === 2) {
            ctx.fillStyle = "rgba(245, 158, 11, 0.36)";
            ctx.strokeStyle = "rgba(217, 119, 6, 0.65)";
          } else if (rg === 3) {
            ctx.fillStyle = "rgba(6, 182, 212, 0.44)";
            ctx.strokeStyle = "rgba(8, 145, 178, 0.75)";
          } else {
            ctx.fillStyle = "rgba(139, 92, 246, 0.34)";
            ctx.strokeStyle = "rgba(109, 40, 217, 0.65)";
          }
          ctx.lineWidth = 1.0;
          ctx.fillRect(x * ts + 0.5, y * ts + 0.5, ts - 1, ts - 1);
          ctx.strokeRect(x * ts + 0.5, y * ts + 0.5, ts - 1, ts - 1);
        }
      }
    }
    ctx.restore();
  }

  drawRoadGridGraphOverlay(ctx, world, ts) {
    ctx.save();
    const ox = ts * 0.5;
    const oy = ts * 0.5;
    const diag = this.computeRoadGraphDiagnostics(world);
    const driveways = world.routingGraph?.driveways || [];
    const rampEdges =
      world.routingGraph?.rampEdges || world._vehicleGraph?.rampEdges || [];
    const rampNodes =
      world.routingGraph?.rampNodes || world._vehicleGraph?.rampNodes || [];

    // 1. Driveway Frontage Links (`lotX, lotY -> roadX, roadY`)
    ctx.strokeStyle = "rgba(22, 163, 74, 0.65)";
    ctx.lineWidth = 1.3;
    ctx.setLineDash([2.5, 2.5]);
    ctx.beginPath();
    for (const dw of driveways) {
      ctx.moveTo(dw.x0 * ts + ox, dw.y0 * ts + oy);
      ctx.lineTo(dw.x1 * ts + ox, dw.y1 * ts + oy);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // 2. Vector Road Polylines (`world.roads`)
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const r of world.roads) {
      if (!r.points || r.points.length < 2) continue;
      ctx.strokeStyle =
        r.type === "street"
          ? "#0284c7"
          : r.type === "airport-spine"
            ? "#7c3aed"
            : "#ea580c";
      ctx.lineWidth = r.type === "street" ? 1.8 : 2.5;
      ctx.beginPath();
      ctx.moveTo(r.points[0].x * ts + ox, r.points[0].y * ts + oy);
      for (let i = 1; i < r.points.length; i++) {
        ctx.lineTo(r.points[i].x * ts + ox, r.points[i].y * ts + oy);
      }
      ctx.stroke();
    }

    // 2B. Directed Lane Trajectories (`outboundTrack` in emerald #10b981, `inboundTrack` in indigo #6366f1)
    const outboundTracks = [];
    const inboundTracks = [];
    for (const link of world.cargoLinks || []) {
      if (link.outboundTrack?.pts?.length >= 2)
        outboundTracks.push(link.outboundTrack);
      if (link.inboundTrack?.pts?.length >= 2)
        inboundTracks.push(link.inboundTrack);
    }
    const commuterList = world.commuterRoutes || [];
    const commuterStep = Math.max(1, Math.floor(commuterList.length / 45));
    for (let i = 0; i < commuterList.length; i += commuterStep) {
      const rt = commuterList[i];
      if (rt.outboundTrack?.pts?.length >= 2)
        outboundTracks.push(rt.outboundTrack);
      if (rt.inboundTrack?.pts?.length >= 2)
        inboundTracks.push(rt.inboundTrack);
    }

    for (const [trackGroup, strokeCol, fillCol] of /** @type {const} */ ([
      [outboundTracks, "rgba(16, 185, 129, 0.55)", "#059669"],
      [inboundTracks, "rgba(99, 102, 241, 0.50)", "#4f46e5"],
    ])) {
      if (trackGroup.length === 0) continue;
      ctx.strokeStyle = strokeCol;
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      for (const tr of trackGroup) {
        const pts = tr.pts;
        ctx.moveTo(pts[0].x * ts + ox, pts[0].y * ts + oy);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x * ts + ox, pts[i].y * ts + oy);
        }
      }
      ctx.stroke();

      // Directional flow chevrons along directed lane trajectories
      ctx.fillStyle = fillCol;
      ctx.beginPath();
      for (const tr of trackGroup) {
        const pts = tr.pts;
        let accum = 0;
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[i];
          const p1 = pts[i + 1];
          const dx = p1.x - p0.x;
          const dy = p1.y - p0.y;
          const segLen = Math.hypot(dx, dy);
          accum += segLen;
          if (accum >= 7.5 && segLen > 0.12) {
            accum = 0;
            const mx = (p0.x + p1.x) * 0.5 * ts + ox;
            const my = (p0.y + p1.y) * 0.5 * ts + oy;
            const ux = dx / segLen;
            const uy = dy / segLen;
            const nx = -uy;
            const ny = ux;
            const tipLen = 3.2;
            const wingW = 2.1;
            ctx.moveTo(mx + ux * tipLen, my + uy * tipLen);
            ctx.lineTo(
              mx - ux * tipLen * 0.65 + nx * wingW,
              my - uy * tipLen * 0.65 + ny * wingW,
            );
            ctx.lineTo(
              mx - ux * tipLen * 0.65 - nx * wingW,
              my - uy * tipLen * 0.65 - ny * wingW,
            );
            ctx.closePath();
          }
        }
      }
      ctx.fill();
    }

    // 2C. Roundabout Circulatory Orbits (`isRoundaboutArc` in emerald-teal #0d9488)
    ctx.strokeStyle = "rgba(13, 148, 136, 0.85)";
    ctx.lineWidth = 1.9;
    ctx.beginPath();
    for (const tr of [...outboundTracks, ...inboundTracks]) {
      const pts = tr.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        if (pts[i].isRoundaboutArc || pts[i + 1].isRoundaboutArc) {
          ctx.moveTo(pts[i].x * ts + ox, pts[i].y * ts + oy);
          ctx.lineTo(pts[i + 1].x * ts + ox, pts[i + 1].y * ts + oy);
        }
      }
    }
    ctx.stroke();

    // 2D. Directed Interchange Ramp & Roundabout Portal Graph (`rampEdges` & `rampNodes`)
    if (rampEdges.length > 0) {
      for (const [isPortalFlag, edgeCol, arrowCol] of /** @type {const} */ ([
        [true, "rgba(13, 148, 136, 0.82)", "#0f766e"],
        [false, "rgba(219, 39, 119, 0.90)", "#be185d"],
      ])) {
        ctx.strokeStyle = edgeCol;
        ctx.lineWidth = isPortalFlag ? 1.6 : 2.1;
        ctx.beginPath();
        for (const e of rampEdges) {
          if (Boolean(e.isPortal) !== isPortalFlag) continue;
          ctx.moveTo(e.x0 * ts + ox, e.y0 * ts + oy);
          ctx.lineTo(e.x1 * ts + ox, e.y1 * ts + oy);
        }
        ctx.stroke();

        // Directed arrowheads on interchange ramp graph edges
        ctx.fillStyle = arrowCol;
        ctx.beginPath();
        for (const e of rampEdges) {
          if (Boolean(e.isPortal) !== isPortalFlag) continue;
          const dx = (e.x1 - e.x0) * ts;
          const dy = (e.y1 - e.y0) * ts;
          const len = Math.hypot(dx, dy);
          if (len < 3.5) continue;
          const ux = dx / len;
          const uy = dy / len;
          const nx = -uy;
          const ny = ux;
          const mx = e.x0 * ts + ox + dx * 0.58;
          const my = e.y0 * ts + oy + dy * 0.58;
          const tip = 3.6;
          const wing = 2.4;
          ctx.moveTo(mx + ux * tip, my + uy * tip);
          ctx.lineTo(
            mx - ux * tip * 0.6 + nx * wing,
            my - uy * tip * 0.6 + ny * wing,
          );
          ctx.lineTo(
            mx - ux * tip * 0.6 - nx * wing,
            my - uy * tip * 0.6 - ny * wing,
          );
          ctx.closePath();
        }
        ctx.fill();
      }

      for (const rn of rampNodes) {
        const px = rn.x * ts + ox;
        const py = rn.y * ts + oy;
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = rn.isPortal ? "#0f766e" : "#be185d";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, rn.isPortal ? 2.6 : 2.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // 3. Vertex Degree Nodes (`deg 1` terminal, `deg 2` through-node, `deg >= 3` junction)
    const { W, H } = world;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = diag.deg[world.idx(x, y)];
        if (d === 0) continue;
        const px = x * ts + ox;
        const py = y * ts + oy;
        if (d >= 3) {
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = "#dc2626";
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.arc(px, py, 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (d === 1) {
          ctx.fillStyle = "#475569";
          ctx.beginPath();
          ctx.arc(px, py, 2.2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = "#0f172a";
          ctx.beginPath();
          ctx.arc(px, py, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 4. High-Contrast Callout Rings for Any Topological/Geometric Anomaly
    for (const anom of diag.anomalies) {
      const ax = anom.x * ts + ox;
      const ay = anom.y * ts + oy;
      ctx.strokeStyle = "#e11d48";
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(ax, ay, ts * 0.65, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  drawRoadGridScreenLegend(ctx, world, canvas) {
    const diag = this.computeRoadGraphDiagnostics(world);

    ctx.save();
    const drawerOpen = canvas.width >= 640 && this.drawerOpen;
    const leftSafe = drawerOpen ? 412 : 14;
    const boxW = Math.min(canvas.width - leftSafe - 14, 1080);
    const boxH = 38;
    const bx = leftSafe;
    const by = canvas.height - boxH - 14;

    ctx.fillStyle = "rgba(248, 246, 241, 0.94)";
    ctx.strokeStyle = "rgba(54, 56, 62, 0.18)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 11);
    ctx.fill();
    ctx.stroke();

    const anomCount = diag.anomalies.length;
    const items = [
      { col: "#0284c7", label: `Street Tiles (${diag.streetTiles})` },
      { col: "#ea580c", label: `Arterial Tiles (${diag.arterialTiles})` },
      { col: "#dc2626", label: `Junctions deg≥3 (${diag.junctionCount})` },
      { col: "#10b981", label: `Lane Tracks (${diag.activeTracks})` },
      { col: "#db2777", label: `Ramp Flows (${diag.rampTraversals})` },
      { col: "#0d9488", label: `Roundabout Orbits (${diag.roundaboutOrbits})` },
      {
        col: anomCount === 0 ? "#16a34a" : "#e11d48",
        label: `Anomalies (${anomCount})`,
      },
    ];

    ctx.font = "700 11px Inter, sans-serif";
    ctx.textBaseline = "middle";
    let curX = bx + 14;
    const midY = by + boxH * 0.5;
    for (const it of items) {
      if (curX + 85 > bx + boxW) break;
      ctx.fillStyle = it.col;
      ctx.beginPath();
      ctx.arc(curX + 4, midY, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#36383e";
      ctx.fillText(it.label, curX + 12, midY + 0.5);
      curX += ctx.measureText(it.label).width + 20;
    }
    ctx.restore();
  }

  drawSelectionHighlight(ctx, world, entity, ts) {
    ctx.save();
    const ox = ts * 0.5;
    const oy = ts * 0.5;

    // Case 1: Industrial or Commercial Building (`entity.zoneType`)
    if (entity.zoneType === "industrial" || entity.zoneType === "commercial") {
      const wT = entity.wTiles || 2;
      const hT = entity.hTiles || 2;
      const cx = entity.x * ts + ox;
      const cy = entity.y * ts + oy;
      const boxW = (wT + 0.72) * ts;
      const boxH = (hT + 0.72) * ts;

      // 1A. If this is a FARM with a sprawling estate, highlight the outer estate boundary
      if (
        entity.resourceType === "FARM" &&
        entity.bspParcels &&
        entity.bspParcels.length > 0
      ) {
        ctx.save();
        if (this._cachedArablePaths && this._cachedArablePaths.arableFillPath) {
          ctx.clip(this._cachedArablePaths.arableFillPath);
        }
        ctx.strokeStyle = "rgba(217, 119, 6, 0.55)";
        ctx.lineWidth = 2.0;
        ctx.setLineDash([6, 4]);
        if (entity.estateLoops && entity.estateLoops.length > 0) {
          ctx.beginPath();
          for (const loop of entity.estateLoops) {
            if (!loop || loop.length < 3) continue;
            ctx.moveTo(loop[0][0] * ts, loop[0][1] * ts);
            for (let i = 1; i < loop.length; i++) {
              ctx.lineTo(loop[i][0] * ts, loop[i][1] * ts);
            }
            ctx.closePath();
          }
          ctx.stroke();
        }
        ctx.restore();
      }

      // 1B. Highlight all Upstream (Inbound) and Downstream (Outbound) Cargo Corridors connected to `entity`
      const connectedLinks = (world.cargoLinks || []).filter(
        (l) => l.from.id === entity.id || l.to.id === entity.id,
      );

      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      /** @type {Map<number, { partner: any, isOutbound: boolean, col: string, comms: string[] }>} */
      const partnerGroups = new Map();
      for (const link of connectedLinks) {
        const pts = link.outboundTrack?.pts || link.points;
        if (!pts || pts.length < 2) continue;
        const isOutbound = link.from.id === entity.id;
        const partner = isOutbound ? link.to : link.from;
        const col = isOutbound ? "#2563eb" : "#d97706";

        // Crisp white corridor casing
        ctx.strokeStyle = "rgba(255, 255, 255, 0.88)";
        ctx.lineWidth = 5.4;
        ctx.setLineDash([]);
        ctx.beginPath();
        this.traceSmoothPath(ctx, pts, ts);
        ctx.stroke();

        // Directional dashed freight vector
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.8;
        ctx.setLineDash([7, 4.5]);
        ctx.beginPath();
        this.traceSmoothPath(ctx, pts, ts);
        ctx.stroke();
        ctx.setLineDash([]);

        // Midpoint directional chevron arrowhead
        const midIdx = Math.max(
          0,
          Math.min(pts.length - 2, Math.floor(pts.length * 0.5)),
        );
        const p0 = pts[midIdx];
        const p1 = pts[Math.min(pts.length - 1, midIdx + 2)];
        const ax = (p0.x + p1.x) * 0.5 * ts + ox;
        const ay = (p0.y + p1.y) * 0.5 * ts + oy;
        const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(ang);
        ctx.fillStyle = col;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(6.2, 0);
        ctx.lineTo(-4.4, -4.6);
        ctx.lineTo(-4.4, 4.6);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        const commShort =
          link.commodity === "CONSUMER_GOODS"
            ? "GOODS"
            : link.commodity === "GROCERIES"
              ? "FOOD"
              : link.commodity === "ELECTRONICS"
                ? "TECH"
                : link.commodity === "HARDWARE"
                  ? "HDWR"
                  : link.commodity === "B2B_PARCELS"
                    ? "B2B"
                    : link.commodity || "";
        let grp = partnerGroups.get(partner.id);
        if (!grp) {
          grp = { partner, isOutbound, col, comms: [] };
          partnerGroups.set(partner.id, grp);
        }
        if (commShort && !grp.comms.includes(commShort)) {
          grp.comms.push(commShort);
        }
      }

      // Compute selected building's floating pill first so partner pills avoid colliding with it
      const selTag = entity.isGatewayProxy
        ? entity.label || "AIR"
        : entity.resourceType
          ? `${entity.resourceType} · RAW`
          : entity.zoneType === "commercial"
            ? entity.isCircular
              ? "CBD HUB"
              : "COMMERCIAL"
            : entity.mfgType
              ? `${entity.mfgType} · MFG`
              : entity.subType === "RAW"
                ? "RAW"
                : entity.subType || "MFG";
      ctx.font = "800 9px Inter, sans-serif";
      const sw = ctx.measureText(selTag).width + 12;
      const sy = cy - boxH * 0.5 - 11;
      /** @type {Array<{ x: number, y: number, hw: number, hh: number }>} */
      const placedPartnerPills = [{ x: cx, y: sy, hw: sw * 0.5 + 3, hh: 8.5 }];

      ctx.font = "800 8.5px Inter, sans-serif";
      for (const {
        partner,
        isOutbound,
        col,
        comms,
      } of partnerGroups.values()) {
        // Highlight connected partner building pad once per unique partner
        const pwT = partner.wTiles || 2;
        const phT = partner.hTiles || 2;
        const pcx = partner.x * ts + ox;
        const pcy = partner.y * ts + oy;
        const pBoxW = (pwT + 0.55) * ts;
        const pBoxH = (phT + 0.55) * ts;

        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 3.8;
        ctx.beginPath();
        ctx.roundRect(pcx - pBoxW * 0.5, pcy - pBoxH * 0.5, pBoxW, pBoxH, 5.5);
        ctx.stroke();

        ctx.strokeStyle = col;
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.roundRect(pcx - pBoxW * 0.5, pcy - pBoxH * 0.5, pBoxW, pBoxH, 5.5);
        ctx.stroke();

        const rawTag = partner.isGatewayProxy
          ? partner.label || "AIR"
          : partner.resourceType ||
            partner.mfgType ||
            (partner.zoneType === "commercial"
              ? partner.isCircular
                ? "CBD"
                : "COM"
              : partner.subType || "MFG");
        const commLabel = comms[0] || "";
        const pTag =
          commLabel && commLabel === rawTag ? partner.subType || "MFG" : rawTag;
        const arrow = isOutbound ? "→" : "←";
        const fullText = commLabel
          ? `${arrow} ${commLabel} · ${pTag}`
          : `${arrow} ${pTag}`;
        const compactText = `${arrow} ${commLabel || pTag}`;

        const placeBelowFirst =
          pcy > cy &&
          Math.abs(pcx - cx) < (boxW + pBoxW) * 0.65 &&
          pcy - pBoxH * 0.5 - 16 < cy + boxH * 0.5;
        const topY = pcy - pBoxH * 0.5 - 10;
        const botY = pcy + pBoxH * 0.5 + 10;
        const candidateYs = placeBelowFirst
          ? [botY, topY, pcy - pBoxH * 0.22, pcy + pBoxH * 0.22]
          : [topY, botY, pcy - pBoxH * 0.22, pcy + pBoxH * 0.22];

        // In dense commercial blocks (`pTag === "COM"`), prefer the concise commodity pill (`→ TECH`, `→ GOODS`)
        // if another partner building is within 5.2 tiles horizontally so adjacent CBD pills never touch.
        const hasCloseHorizontalPartner = Array.from(
          partnerGroups.values(),
        ).some(
          (other) =>
            other.partner.id !== partner.id &&
            Math.abs(other.partner.x - partner.x) < 5.2 &&
            Math.abs(other.partner.y - partner.y) < 4.5,
        );
        const textOptions =
          pTag === "COM" && hasCloseHorizontalPartner
            ? [compactText]
            : [fullText, compactText];

        let chosenText = textOptions[0];
        let chosenW = ctx.measureText(chosenText).width + 8;
        let chosenY = candidateYs[0];
        let placed = false;

        for (const textOpt of textOptions) {
          const tw = ctx.measureText(textOpt).width + 8;
          const hw = tw * 0.5 + 1.5;
          const hh = 7.0;
          for (const cyOpt of candidateYs) {
            const overlaps = placedPartnerPills.some(
              (r) =>
                Math.abs(pcx - r.x) < hw + r.hw &&
                Math.abs(cyOpt - r.y) < hh + r.hh,
            );
            if (!overlaps) {
              chosenText = textOpt;
              chosenW = tw;
              chosenY = cyOpt;
              placed = true;
              break;
            }
          }
          if (placed) break;
        }

        if (placed) {
          placedPartnerPills.push({
            x: pcx,
            y: chosenY,
            hw: chosenW * 0.5 + 1.5,
            hh: 7.0,
          });
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.roundRect(pcx - chosenW * 0.5, chosenY - 6.5, chosenW, 13, 3.5);
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(chosenText, pcx, chosenY + 0.5);
        }
      }

      // 1C. Precision double-cased selection frame around the selected building itself

      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 5.2;
      ctx.beginPath();
      ctx.roundRect(cx - boxW * 0.5, cy - boxH * 0.5, boxW, boxH, 6.5);
      ctx.stroke();

      ctx.strokeStyle = "#36383e";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.roundRect(cx - boxW * 0.5, cy - boxH * 0.5, boxW, boxH, 6.5);
      ctx.stroke();

      // Floating Selected Facility Stage Pill above building
      ctx.font = "800 9px Inter, sans-serif";
      ctx.fillStyle = "#36383e";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(cx - sw * 0.5, sy - 7, sw, 14, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#f2efe9";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(selTag, cx, sy + 0.5);

      ctx.restore();
      return;
    }

    // Case 2: Airport (`entity.halfLen`)
    if (typeof entity.halfLen === "number") {
      const cx = entity.x * ts + ox;
      const cy = entity.y * ts + oy;
      const padLen = (entity.halfLen * 2 + 2.4) * ts;
      const padWid = (entity.halfWid * 2 + (entity.isHub ? 2.4 : 1.8)) * ts;
      ctx.translate(cx, cy);
      ctx.rotate(entity.angleRad || 0);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 5.0;
      ctx.beginPath();
      ctx.roundRect(-padLen * 0.5, -padWid * 0.5, padLen, padWid, 12);
      ctx.stroke();
      ctx.strokeStyle = "#e85c90";
      ctx.lineWidth = 2.6;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      ctx.roundRect(-padLen * 0.5, -padWid * 0.5, padLen, padWid, 12);
      ctx.stroke();
      ctx.restore();
      return;
    }

    // Case 3: Town (`entity.urbanRadius`)
    const cx = entity.x * ts + ox;
    const cy = entity.y * ts + oy;
    const rad = (entity.urbanRadius || 12) * 0.85 * ts;
    ctx.strokeStyle = "#36383e";
    ctx.lineWidth = 2.8;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
