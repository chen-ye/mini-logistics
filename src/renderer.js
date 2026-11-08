import { PALETTE } from "./palette.js";

/***************************************************************************
 * 5. MINI MOTORWAYS / MINI METRO CANVAS VECTOR RENDERER
 ***************************************************************************/
export class MiniMotorwaysRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.activeLayer = 'aesthetic'; // 'aesthetic' | 'airport' | 'hierarchy' | 'hydrology'
    this.selectedEntity = null;
    this.offscreenTerrain = document.createElement('canvas');
  }

  fitCamera(world) {
    const ts = world.tileSize;
    const worldPxW = world.W * ts;
    const worldPxH = world.H * ts;

    // On portrait or small mobile viewports, fit the camera around the active metropolitan
    // bounding box (towns + airports) so the network fills the portrait screen legibly.
    if ((this.canvas.width < 640 || this.canvas.width < this.canvas.height) && world.towns.length > 0) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
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
      const cx = ((minX + maxX) * 0.5) * ts;
      const cy = ((minY + maxY) * 0.5) * ts;
      const scaleX = (this.canvas.width * 0.92) / boxW;
      const scaleY = (this.canvas.height * 0.78) / boxH;
      this.camera.zoom = Math.max(0.18, Math.min(1.25, Math.min(scaleX, scaleY)));
      this.camera.x = this.canvas.width * 0.5 - cx * this.camera.zoom;
      this.camera.y = this.canvas.height * 0.52 - cy * this.camera.zoom;
      return;
    }

    const scaleX = this.canvas.width / worldPxW;
    const scaleY = this.canvas.height / worldPxH;
    // Fill viewport edge-to-edge on landscape screens so map-border bays & rivers bleed cleanly to the screen edge
    this.camera.zoom = Math.max(scaleX, scaleY);
    this.camera.x = (this.canvas.width - worldPxW * this.camera.zoom) * 0.5;
    this.camera.y = (this.canvas.height - worldPxH * this.camera.zoom) * 0.5;
  }

  /**
   * Pre-renders static terrain layers (Cream background, Pastel Urban Zones,
   * Cyan Water & Cream Riverbanks) onto an offscreen canvas using a true
   * Vignelli-style 45°/90° Octilinear Marching-Squares Polygonizer (zero stippling!).
   */
  buildVignelliWaterPath(world, ts, customTestFn = null, outStrokePath = null) {
    const path = new Path2D();
    const { W, H } = world;
    const gw = W + 2;
    const gh = H + 2;
    const flags = new Uint8Array(gw * gh);
    const wm = world.waterMask;

    // 1. Pre-evaluate corner flags once (`O(W * H)` typed array write instead of 4x closure calls per cell)
    for (let gy = 0; gy < gh; gy++) {
      const cy = Math.max(0, Math.min(H - 1, gy - 1));
      const rowOff = gy * gw;
      const wRowOff = cy * W;
      if (customTestFn) {
        for (let gx = 0; gx < gw; gx++) {
          const cx = Math.max(0, Math.min(W - 1, gx - 1));
          flags[rowOff + gx] = customTestFn(cx, cy) ? 1 : 0;
        }
      } else {
        for (let gx = 0; gx < gw; gx++) {
          const cx = Math.max(0, Math.min(W - 1, gx - 1));
          flags[rowOff + gx] = wm[wRowOff + cx] === 2 ? 1 : 0;
        }
      }
    }

    const poly = (pts) => {
      path.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
      path.closePath();
    };
    const seg = (ax, ay, bx, by) => {
      if (!outStrokePath) return;
      outStrokePath.moveTo(ax, ay);
      outStrokePath.lineTo(bx, by);
    };

    // 2. Scanline RLE-merged Marching Squares (`mask === 15` interior runs merge into 1 `path.rect()`,
    //    eliminating 35,000 Path2D subpaths and 1x1 interior grid hatching!)
    for (let y = -1; y < H; y++) {
      const r0 = (y + 1) * gw;
      const r1 = (y + 2) * gw;
      const y0 = (y + 0.5) * ts;
      const y1 = (y + 1.5) * ts;
      const ym = (y + 1.0) * ts;
      let runStart = null;

      for (let x = -1; x < W; x++) {
        const c = x + 1;
        const tl = flags[r0 + c];
        const tr = flags[r0 + c + 1];
        const br = flags[r1 + c + 1];
        const bl = flags[r1 + c];
        const mask = (tl << 3) | (tr << 2) | (br << 1) | bl;

        if (mask === 15) {
          if (runStart === null) runStart = x;
          continue;
        }
        if (runStart !== null) {
          path.rect((runStart + 0.5) * ts, y0, (x - runStart) * ts, ts);
          runStart = null;
        }
        if (mask === 0) continue;

        const x0 = (x + 0.5) * ts;
        const x1 = (x + 1.5) * ts;
        const xm = (x + 1.0) * ts;

        switch (mask) {
          case 1:  poly([[x0, ym], [xm, y1], [x0, y1]]); seg(x0, ym, xm, y1); break;
          case 2:  poly([[xm, y1], [x1, ym], [x1, y1]]); seg(xm, y1, x1, ym); break;
          case 4:  poly([[xm, y0], [x1, y0], [x1, ym]]); seg(xm, y0, x1, ym); break;
          case 8:  poly([[x0, y0], [xm, y0], [x0, ym]]); seg(x0, ym, xm, y0); break;
          case 3:  poly([[x0, ym], [x1, ym], [x1, y1], [x0, y1]]); seg(x0, ym, x1, ym); break;
          case 6:  poly([[xm, y0], [x1, y0], [x1, y1], [xm, y1]]); seg(xm, y0, xm, y1); break;
          case 9:  poly([[x0, y0], [xm, y0], [xm, y1], [x0, y1]]); seg(xm, y0, xm, y1); break;
          case 12: poly([[x0, y0], [x1, y0], [x1, ym], [x0, ym]]); seg(x0, ym, x1, ym); break;
          case 5:  poly([[x0, ym], [xm, y0], [x1, y0], [x1, ym], [xm, y1], [x0, y1]]); seg(x0, ym, xm, y0); seg(xm, y1, x1, ym); break;
          case 10: poly([[x0, y0], [xm, y0], [x1, ym], [x1, y1], [xm, y1], [x0, ym]]); seg(xm, y0, x1, ym); seg(x0, ym, xm, y1); break;
          case 7:  poly([[x0, ym], [xm, y0], [x1, y0], [x1, y1], [x0, y1]]); seg(x0, ym, xm, y0); break;
          case 11: poly([[x0, y0], [xm, y0], [x1, ym], [x1, y1], [x0, y1]]); seg(xm, y0, x1, ym); break;
          case 13: poly([[x0, y0], [x1, y0], [x1, ym], [xm, y1], [x0, y1]]); seg(xm, y1, x1, ym); break;
          case 14: poly([[x0, y0], [x1, y0], [x1, y1], [xm, y1], [x0, ym]]); seg(x0, ym, xm, y1); break;
        }
      }
      if (runStart !== null) {
        path.rect((runStart + 0.5) * ts, y0, (W - runStart) * ts, ts);
      }
    }
    return path;
  }

  async yieldToMainIfNeeded(deadline) {
    if (performance.now() >= deadline) {
      if ('scheduler' in window && 'yield' in window.scheduler) {
        await window.scheduler.yield();
      } else {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return performance.now() + 50;
    }
    return deadline;
  }

  setTerrainBitmap(bitmap) {
    if (
      this.offscreenTerrain &&
      this.offscreenTerrain !== bitmap &&
      typeof this.offscreenTerrain.close === 'function'
    ) {
      this.offscreenTerrain.close();
    }
    this.offscreenTerrain = bitmap;
  }

  async bakeStaticTerrainAsync(world) {
    let deadline = performance.now() + 50;
    const ts = world.tileSize;
    const pw = world.W * ts;
    const ph = world.H * ts;
    const staging = document.createElement('canvas');
    staging.width = pw;
    staging.height = ph;
    const ctx = staging.getContext('2d');

    if (world.reusedThroughStage >= 7 && this._cachedPreTreeCanvas) {
      ctx.drawImage(this._cachedPreTreeCanvas, 0, 0);
    } else {
      ctx.fillStyle = PALETTE.bgPaper;
      ctx.fillRect(0, 0, pw, ph);

      // Draw subtle architectural paper grid on the base paper sheet BEFORE elevation contours
      // so the hypsometric mountain terraces remain crisp vector steps without plaid cross-hatching!
      ctx.strokeStyle = PALETTE.gridLine;
      ctx.lineWidth = 1;
      const gridStep = ts * 4;
      ctx.beginPath();
      for (let x = 0; x <= pw; x += gridStep) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, ph);
      }
      for (let y = 0; y <= ph; y += gridStep) {
        ctx.moveTo(0, y);
        ctx.lineTo(pw, y);
      }
      ctx.stroke();

      const contourTerraces = [
        { dh: 0.13, fill: '#ebe7de', stroke: '#dfdace' },
        { dh: 0.24, fill: '#e3ded2', stroke: '#d5cfc0' },
        { dh: 0.36, fill: '#dad4c5', stroke: '#cac3b2' }
      ];
      const canReuseVectorPaths = Boolean(world.reusedThroughStage >= 2 && this._cachedVectorPaths);
      let contourLayers;
      let waterPath;
      let waterEdgePath;

      if (canReuseVectorPaths) {
        ({ contourLayers, waterPath, waterEdgePath } = this._cachedVectorPaths);
      } else {
        contourLayers = [];
        for (const { dh, fill, stroke } of contourTerraces) {
          const thresh = world.seaLevel + dh;
          const cEdgePath = new Path2D();
          const cPath = this.buildVignelliWaterPath(
            world,
            ts,
            (cx, cy) => world.waterMask[world.idx(cx, cy)] === 0 && world.elevationField[world.idx(cx, cy)] >= thresh,
            cEdgePath
          );
          contourLayers.push({ fill, stroke, cPath, cEdgePath });
          deadline = await this.yieldToMainIfNeeded(deadline);
        }
        waterEdgePath = new Path2D();
        waterPath = this.buildVignelliWaterPath(world, ts, null, waterEdgePath);
        this._cachedVectorPaths = { contourLayers, waterPath, waterEdgePath };
        deadline = await this.yieldToMainIfNeeded(deadline);
      }

      ctx.save();
      ctx.lineJoin = 'bevel';
      ctx.lineWidth = 1.2;
      for (const { fill, stroke, cPath, cEdgePath } of contourLayers) {
        ctx.fillStyle = fill;
        ctx.fill(cPath);
        ctx.strokeStyle = stroke;
        ctx.stroke(cEdgePath);
      }
      ctx.restore();

      ctx.save();
      ctx.fillStyle = PALETTE.urbanBlushPink;
      ctx.beginPath();
      for (let y = 0; y < world.H; y += 2) {
        for (let x = 0; x < world.W; x += 2) {
          if (world.zoneColorIdx[world.idx(x, y)] >= 0) {
            ctx.moveTo((x + 4.5) * ts, (y + 1) * ts);
            ctx.arc((x + 1) * ts, (y + 1) * ts, 3.5 * ts, 0, Math.PI * 2);
          }
        }
      }
      ctx.fill();

      ctx.lineCap = 'butt';
      ctx.lineJoin = 'bevel';
      ctx.strokeStyle = PALETTE.bgPaper;
      ctx.lineWidth = ts * 1.45;
      ctx.stroke(waterEdgePath);
      ctx.fillStyle = PALETTE.bgPaper;
      ctx.fill(waterPath);

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const pass of ['bank', 'water']) {
        ctx.strokeStyle = pass === 'bank' ? PALETTE.bgPaper : PALETTE.waterCyan;
        const bankExtra = pass === 'bank' ? ts * 1.15 : 0;
        for (const rObj of world.rivers) {
          const pts = Array.isArray(rObj) ? rObj : rObj.points;
          const isMain = !Array.isArray(rObj) && rObj.isMainOutflow;
          if (!pts || pts.length < 4) continue;
          const startW = isMain ? 0.84 : 0.56;
          const endW = isMain ? 1.44 : 1.08;
          for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i];
            const p1 = pts[i + 1];
            const p2 = pts[Math.min(pts.length - 1, i + 2)];
            const frac = i / (pts.length - 1);
            const w = p1.width ?? (startW + (endW - startW) * Math.pow(frac, 0.90));
            ctx.lineWidth = ts * w + bankExtra;
            ctx.beginPath();
            const x0 = i === 0 ? (p0.x + 0.5) * ts : ((p0.x + p1.x) * 0.5 + 0.5) * ts;
            const y0 = i === 0 ? (p0.y + 0.5) * ts : ((p0.y + p1.y) * 0.5 + 0.5) * ts;
            const x1 = (p1.x + 0.5) * ts;
            const y1 = (p1.y + 0.5) * ts;
            const x2 = i === pts.length - 2 ? (p1.x + 0.5) * ts : ((p1.x + p2.x) * 0.5 + 0.5) * ts;
            const y2 = i === pts.length - 2 ? (p1.y + 0.5) * ts : ((p1.y + p2.y) * 0.5 + 0.5) * ts;
            ctx.moveTo(x0, y0);
            ctx.quadraticCurveTo(x1, y1, x2, y2);
            ctx.stroke();
          }
        }
        deadline = await this.yieldToMainIfNeeded(deadline);
      }

      ctx.fillStyle = PALETTE.waterCyan;
      ctx.fill(waterPath);
      ctx.restore();

      const preTree = this._cachedPreTreeCanvas || document.createElement('canvas');
      preTree.width = pw;
      preTree.height = ph;
      preTree.getContext('2d').drawImage(staging, 0, 0);
      this._cachedPreTreeCanvas = preTree;
    }

    // Soft pastel woodland canopy underlay beneath tree clusters so forests read as cohesive groves
    ctx.fillStyle = 'rgba(186, 208, 181, 0.28)';
    ctx.beginPath();
    for (let i = 0; i < world.trees.length; i += 2) {
      const tree = world.trees[i];
      const tx = tree.x * ts;
      const ty = tree.y * ts;
      const tr = tree.r * ts * 2.15;
      ctx.moveTo(tx + tr, ty);
      ctx.arc(tx, ty, tr, 0, Math.PI * 2);
    }
    ctx.fill();

    // Batch all tree shadows into a single path fill
    ctx.fillStyle = 'rgba(54, 56, 62, 0.1)';
    ctx.beginPath();
    for (const tree of world.trees) {
      const tx = tree.x * ts + 2.5;
      const ty = tree.y * ts + 2.5;
      const tr = tree.r * ts;
      ctx.moveTo(tx + tr, ty);
      ctx.arc(tx, ty, tr, 0, Math.PI * 2);
    }
    ctx.fill();

    // Batch tree dots by palette color (3 draw calls instead of N)
    for (const color of PALETTE.treeDots) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const tree of world.trees) {
        if (tree.color !== color) continue;
        const tx = tree.x * ts;
        const ty = tree.y * ts;
        const tr = tree.r * ts;
        ctx.moveTo(tx + tr, ty);
        ctx.arc(tx, ty, tr, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    this.offscreenTerrain = staging;
  }

  bakeStaticTerrain(world) {
    const ts = world.tileSize;
    const pw = world.W * ts;
    const ph = world.H * ts;
    this.offscreenTerrain.width = pw;
    this.offscreenTerrain.height = ph;
    const ctx = this.offscreenTerrain.getContext('2d');

    // 1. Warm Paper Background
    ctx.fillStyle = PALETTE.bgPaper;
    ctx.fillRect(0, 0, pw, ph);

    // 1B. Smooth Octilinear Marching-Squares Hypsometric Elevation Contour Terraces (zero 2x2 pixel blocks!)
    const contourTerraces = [
      { dh: 0.13, fill: '#ebe7de', stroke: '#dfdace' },
      { dh: 0.24, fill: '#e3ded2', stroke: '#d5cfc0' },
      { dh: 0.36, fill: '#dad4c5', stroke: '#cac3b2' }
    ];
    ctx.save();
    ctx.lineJoin = 'bevel';
    ctx.lineWidth = 1.2;
    for (const { dh, fill, stroke } of contourTerraces) {
      const thresh = world.seaLevel + dh;
      const cEdgePath = new Path2D();
      const cPath = this.buildVignelliWaterPath(
        world,
        ts,
        (cx, cy) => world.waterMask[world.idx(cx, cy)] === 0 && world.elevationField[world.idx(cx, cy)] >= thresh,
        cEdgePath
      );
      ctx.fillStyle = fill;
      ctx.fill(cPath);
      ctx.strokeStyle = stroke;
      ctx.stroke(cEdgePath);
    }
    ctx.restore();

    // 2. Soft Pastel Contour-Hugging Urban & Waterfront Blush Zones
    ctx.save();
    ctx.fillStyle = PALETTE.urbanBlushPink;
    ctx.beginPath();
    for (let y = 0; y < world.H; y += 2) {
      for (let x = 0; x < world.W; x += 2) {
        if (world.zoneColorIdx[world.idx(x, y)] >= 0) {
          ctx.moveTo((x + 4.5) * ts, (y + 1) * ts);
          ctx.arc((x + 1) * ts, (y + 1) * ts, 3.5 * ts, 0, Math.PI * 2);
        }
      }
    }
    ctx.fill();

    // Build Vignelli 45°/90° Octilinear Marching-Squares Open-Water Basin Path (`waterMask === 2`)
    const waterEdgePath = new Path2D();
    const waterPath = this.buildVignelliWaterPath(world, ts, null, waterEdgePath);

    // Use beveled/mitered joins so 45-degree Vignelli shoreline angles stay crisp & architectural
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'bevel';

    // 3. Cream Sand/Bank Casing around Open Water Basins
    ctx.strokeStyle = PALETTE.bgPaper;
    ctx.lineWidth = ts * 1.45;
    ctx.stroke(waterEdgePath);
    ctx.fillStyle = PALETTE.bgPaper;
    ctx.fill(waterPath);

    // 4. Smooth Continuously-Tapering River Network (`world.rivers`) — Two Passes (Cream Bank + Cyan Channel)
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const pass of ['bank', 'water']) {
      ctx.strokeStyle = pass === 'bank' ? PALETTE.bgPaper : PALETTE.waterCyan;
      const bankExtra = pass === 'bank' ? ts * 1.15 : 0;
      for (const rObj of world.rivers) {
        const pts = Array.isArray(rObj) ? rObj : rObj.points;
        const isMain = !Array.isArray(rObj) && rObj.isMainOutflow;
        if (!pts || pts.length < 4) continue;
        const startW = isMain ? 0.84 : 0.56;
        const endW = isMain ? 1.44 : 1.08;
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[i];
          const p1 = pts[i + 1];
          const p2 = pts[Math.min(pts.length - 1, i + 2)];
          const frac = i / (pts.length - 1);
          const w = p1.width ?? (startW + (endW - startW) * Math.pow(frac, 0.90));
          ctx.lineWidth = ts * w + bankExtra;
          ctx.beginPath();
          const x0 = i === 0 ? (p0.x + 0.5) * ts : ((p0.x + p1.x) * 0.5 + 0.5) * ts;
          const y0 = i === 0 ? (p0.y + 0.5) * ts : ((p0.y + p1.y) * 0.5 + 0.5) * ts;
          const x1 = (p1.x + 0.5) * ts;
          const y1 = (p1.y + 0.5) * ts;
          const x2 = i === pts.length - 2 ? (p1.x + 0.5) * ts : ((p1.x + p2.x) * 0.5 + 0.5) * ts;
          const y2 = i === pts.length - 2 ? (p1.y + 0.5) * ts : ((p1.y + p2.y) * 0.5 + 0.5) * ts;
          ctx.moveTo(x0, y0);
          ctx.quadraticCurveTo(x1, y1, x2, y2);
          ctx.stroke();
        }
      }
    }

    // 4B. Crisp Cyan Open-Water Basin Fill on top of river bank casings so river mouths merge seamlessly!
    ctx.fillStyle = PALETTE.waterCyan;
    ctx.fill(waterPath);
    ctx.restore();

    // 5. Subtle Architectural Grid Lines (visible across land & water like Mini Motorways)
    ctx.strokeStyle = PALETTE.gridLine;
    ctx.lineWidth = 1;
    const gridStep = ts * 4;
    ctx.beginPath();
    for (let x = 0; x <= pw; x += gridStep) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ph);
    }
    for (let y = 0; y <= ph; y += gridStep) {
      ctx.moveTo(0, y);
      ctx.lineTo(pw, y);
    }
    ctx.stroke();

    // 6. Landscape Trees (Pastel Minimalist Dots with soft shadows)
    for (const tree of world.trees) {
      const tx = tree.x * ts;
      const ty = tree.y * ts;
      const tr = tree.r * ts;
      ctx.fillStyle = 'rgba(54, 56, 62, 0.1)';
      ctx.beginPath();
      ctx.arc(tx + 2.5, ty + 2.5, tr, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = tree.color;
      ctx.beginPath();
      ctx.arc(tx, ty, tr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  render(world, sim) {
    const { ctx, canvas, camera } = this;
    const ts = world.tileSize;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = PALETTE.bgPaper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    // 1. Draw Baked Base Terrain
    ctx.drawImage(this.offscreenTerrain, 0, 0);

    // 2. Optional Diagnostic Overlay Underneath Roads/Buildings (Hydrology / Airport Heatmap / RCI Zones / Road Grid)
    if (this.activeLayer === 'hydrology') {
      this.drawHydrologyOverlay(ctx, world, ts);
    } else if (this.activeLayer === 'airport') {
      this.drawAirportSolverOverlay(ctx, world, ts);
    } else if (this.activeLayer === 'rci') {
      this.drawRCIZoneUnderlay(ctx, world, ts);
    } else if (this.activeLayer === 'roadgrid') {
      this.drawRoadGridUnderlay(ctx, world, ts);
    }

    // 2B. Draw Ground-Level Airport Concrete Apron Pads & Landside Parking Islands
    // Drawn before the surface road network so all surface road casings and fills
    // render in a single unified pass on top of the concrete pads!
    this.drawAirportGroundPads(ctx, world, ts);

    // 3. Draw Unified Surface Road Network (All Casings -> Bridge Guardrails -> All Asphalt Fills -> Central Islands)
    this.drawRoadNetwork(ctx, world, ts);

    // 4. Draw Houses & Differentiated Commercial / Industrial Sinks (with 45° Drop Shadows & Demand Pins)
    this.drawBuildings(ctx, world, ts);

    // 5. Draw Airport Airside & Terminal Structures (Runways, Taxiways, Concourses, Control Towers & Floating Badges)
    this.drawAirports(ctx, world, ts);

    // 6. Draw Live Surface Road Vehicles (Commuter Cars + Articulated Freight Trucks on surface streets & roundabouts)
    this.drawCars(ctx, world, sim, ts, 'road');

    // 7. Draw Sweeping Pink Numbered Motorways Overpasses ([1], [2], [3])
    // Clipped outside terminal roundabout rings so roundabouts are never drawn in a second pass!
    this.drawMotorways(ctx, world, ts);

    // 7B. Draw Live Elevated Motorway Vehicles on Top of the Motorway Decks
    this.drawCars(ctx, world, sim, ts, 'motorway');

    // 8. Draw Central Place Hierarchy, RCI Cargo Chain, or Road Grid Vector Graph Overlay if active
    if (this.activeLayer === 'hierarchy') {
      this.drawHierarchyOverlay(ctx, world, ts);
    } else if (this.activeLayer === 'rci') {
      this.drawRCICargoChainOverlay(ctx, world, ts);
    } else if (this.activeLayer === 'roadgrid') {
      this.drawRoadGridGraphOverlay(ctx, world, ts);
    }

    // 9. Draw Live Aircraft & Flight Corridors
    this.drawPlanes(ctx, world, sim, ts);

    // 10. Highlight Selected Town or Airport Ring
    if (this.selectedEntity) {
      this.drawSelectionHighlight(ctx, this.selectedEntity, ts);
    }

    ctx.restore();

    // Soft paper vignette around screen edges
    const grad = ctx.createRadialGradient(
      canvas.width * 0.5, canvas.height * 0.5, Math.min(canvas.width, canvas.height) * 0.38,
      canvas.width * 0.5, canvas.height * 0.5, Math.max(canvas.width, canvas.height) * 0.72
    );
    grad.addColorStop(0, 'rgba(242, 239, 233, 0)');
    grad.addColorStop(1, 'rgba(54, 56, 62, 0.08)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (this.activeLayer === 'rci') {
      this.drawRCIScreenLegend(ctx, world, canvas);
    } else if (this.activeLayer === 'roadgrid') {
      this.drawRoadGridScreenLegend(ctx, world, canvas);
    }
  }

  drawRCIScreenLegend(ctx, world, canvas) {
    const comCount = world.destinations.filter(d => d.zoneType === 'commercial').length;
    const rawCount = world.destinations.filter(d => d.zoneType === 'industrial' && d.subType === 'RAW').length;
    const mfgCount = world.destinations.filter(d => d.zoneType === 'industrial' && d.subType === 'MFG').length;
    const logCount = world.destinations.filter(d => d.zoneType === 'industrial' && d.subType === 'LOG').length;

    ctx.save();
    const drawerEl = typeof document !== 'undefined' ? document.getElementById('generatorDrawer') : null;
    const drawerOpen = canvas.width >= 640 && drawerEl && !drawerEl.classList.contains('hidden');
    const leftSafe = drawerOpen ? 412 : 14;
    const boxW = Math.min(canvas.width - leftSafe - 14, 745);
    const boxH = 38;
    const bx = leftSafe;
    const by = canvas.height - boxH - 14;

    ctx.fillStyle = 'rgba(248, 246, 241, 0.92)';
    ctx.strokeStyle = 'rgba(54, 56, 62, 0.16)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 11);
    ctx.fill();
    ctx.stroke();

    const items = [
      { col: '#16a34a', label: `R Residential (${world.houses.length})` },
      { col: '#2563eb', label: `C CBD/Arterial (${comCount})` },
      { col: '#d97706', label: `RAW Extract (${rawCount})` },
      { col: '#ea580c', label: `MFG Factory (${mfgCount})` },
      { col: '#7c3aed', label: `LOG Hub (${logCount})` },
      { col: '#36383e', label: `${(world.cargoLinks || []).length} Freight Chains` }
    ];

    ctx.font = '700 11px Inter, sans-serif';
    ctx.textBaseline = 'middle';
    let curX = bx + 14;
    const midY = by + boxH * 0.5;
    for (const it of items) {
      if (curX + 95 > bx + boxW) break;
      ctx.fillStyle = it.col;
      ctx.beginPath();
      ctx.roundRect(curX, midY - 5, 10, 10, 3);
      ctx.fill();
      curX += 15;
      ctx.fillStyle = '#36383e';
      ctx.fillText(it.label, curX, midY + 0.5);
      curX += ctx.measureText(it.label).width + 15;
    }
    ctx.restore();
  }

  drawAirportGroundPads(ctx, world, ts) {
    for (const ap of world.airports) {
      const cx = ap.x * ts + ts * 0.5;
      const cy = ap.y * ts + ts * 0.5;
      const rwyLen = ap.halfLen * 2 * ts;
      const padLen = rwyLen + ts * 1.8;
      const padWid = ap.halfWid * 2 * ts + ts * (ap.isHub ? 1.8 : 1.2);
      const side = ap.apronSide;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ap.angleRad);

      // 1. Airport Perimeter Concrete Apron Pad
      ctx.fillStyle = '#e5e2dc';
      ctx.strokeStyle = '#b6b4ae';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(-padLen * 0.5, -padWid * 0.5, padLen, padWid, 11);
      ctx.fill();
      ctx.stroke();

      // 2. Transit / Parking Plaza Island inside the Curbside Loop
      const termW = ap.isHub ? rwyLen * 0.46 : rwyLen * 0.40;
      const termH = ts * (ap.isHub ? 1.15 : 1.02);
      const termY = side * ts * (ap.isHub ? 1.32 : 1.18);
      const termOuterY = termY + side * (termH * 0.5);
      const loopW = termW * (ap.isHub ? 0.82 : 0.88);
      const loopInnerY = termOuterY + side * (ts * 0.22);
      const loopOuterY = loopInnerY + side * (ts * 1.06);
      const loopBoxH = Math.abs(loopOuterY - loopInnerY);

      const plazaMidY = (loopInnerY + loopOuterY) * 0.5;
      const plazaW = loopW * 0.74;
      const plazaH = loopBoxH * 0.45;
      ctx.fillStyle = '#d8d5ce';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(-plazaW * 0.5, plazaMidY - plazaH * 0.5, plazaW, plazaH, 3.5);
      ctx.fill();
      ctx.stroke();

      ctx.restore();
    }
  }

  drawRoadNetwork(ctx, world, ts) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Gather all surface roundabouts (Airport Gateways + Expressway Street-Stubs + Diamond Slip-Ramp Stubs)
    // so all surface road casings and all surface road fills are stroked in unified passes!
    const roundabouts = [];
    const airportLandsideGeoms = [];

    for (const ap of world.airports) {
      const cx = ap.x * ts + ts * 0.5;
      const cy = ap.y * ts + ts * 0.5;
      const rwyLen = ap.halfLen * 2 * ts;
      const side = ap.apronSide;
      const termW = ap.isHub ? rwyLen * 0.46 : rwyLen * 0.40;
      const termH = ts * (ap.isHub ? 1.15 : 1.02);
      const termY = side * ts * (ap.isHub ? 1.32 : 1.18);
      const termOuterY = termY + side * (termH * 0.5);

      const loopW = termW * (ap.isHub ? 0.82 : 0.88);
      const loopHalfW = loopW * 0.5;
      const loopInnerY = termOuterY + side * (ts * 0.22);
      const loopOuterY = loopInnerY + side * (ts * 1.06);
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
        localGateY
      });

      roundabouts.push({
        x: gatePx,
        y: gatePy,
        rRing: ts * 0.68,
        rIsland: ts * 0.36,
        accentColor: ap.palette.roof
      });
    }

    for (const ic of world.interchanges) {
      if (ic.type === 'terminal-stub' && !ic.isAirportStub) {
        const town = ic.townId !== undefined ? world.towns[ic.townId] : null;
        roundabouts.push({
          x: ic.x * ts + ts * 0.5,
          y: ic.y * ts + ts * 0.5,
          rRing: ts * 0.64,
          rIsland: ts * 0.33,
          accentColor: town ? town.palette.roof : '#8fa989'
        });
      } else if (ic.type === 'diamond-ramp') {
        roundabouts.push({
          x: ic.termX * ts + ts * 0.5,
          y: ic.termY * ts + ts * 0.5,
          rRing: ts * 0.56,
          rIsland: ts * 0.30,
          accentColor: '#8fa989'
        });
      }
    }

    // =========================================================================
    // PASS 1: UNIFIED SURFACE ROAD CASINGS (Driveways + Streets + Arterials + Airport Loops & Spines + Roundabout Rings)
    // Every grey casing in the surface road network is stroked BEFORE any white asphalt fill is drawn!
    // =========================================================================
    ctx.strokeStyle = PALETTE.roadCasing;
    ctx.lineWidth = ts * 0.42;
    ctx.beginPath();
    for (const h of world.houses) {
      ctx.moveTo(h.x * ts + ts * 0.5, h.y * ts + ts * 0.5);
      ctx.lineTo(h.roadX * ts + ts * 0.5, h.roadY * ts + ts * 0.5);
    }
    for (const d of world.destinations) {
      const lx = d.lotX ?? d.x;
      const ly = d.lotY ?? d.y;
      ctx.moveTo(lx * ts + ts * 0.5, ly * ts + ts * 0.5);
      ctx.lineTo(d.roadX * ts + ts * 0.5, d.roadY * ts + ts * 0.5);
    }
    ctx.stroke();

    for (const r of world.roads) {
      if (r.points.length < 2 || r.type === 'airport-loop' || r.type === 'airport-spine') continue;
      ctx.strokeStyle = PALETTE.roadCasing;
      ctx.lineWidth = r.type === 'street' ? ts * 0.58 : ts * 0.74;
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
      ctx.roundRect(-ag.loopHalfW, ag.loopTopY, ag.loopW, ag.loopBoxH, ag.loopR);
      ctx.moveTo(0, ag.spineStartY);
      ctx.lineTo(ag.localGateX, ag.localGateY);
      ctx.stroke();
      ctx.restore();
    }

    if (roundabouts.length > 0) {
      ctx.strokeStyle = PALETTE.roadCasing;
      ctx.lineWidth = ts * 0.68;
      ctx.beginPath();
      for (const ic of world.interchanges) {
        if (ic.type === 'diamond-ramp' && ic.connectX !== undefined) {
          ctx.moveTo(ic.termX * ts + ts * 0.5, ic.termY * ts + ts * 0.5);
          ctx.lineTo(ic.connectX * ts + ts * 0.5, ic.connectY * ts + ts * 0.5);
        }
      }
      for (const rb of roundabouts) {
        ctx.moveTo(rb.x + rb.rRing, rb.y);
        ctx.arc(rb.x, rb.y, rb.rRing, 0, Math.PI * 2);
      }
      ctx.stroke();
    }

    // =========================================================================
    // PASS 2: BRIDGE GUARDRAILS OVER WATER (continuous smoothed spans matching `traceSmoothPath`)
    // =========================================================================
    const ox = ts * 0.5;
    const oy = ts * 0.5;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = PALETTE.bridgeRail;
    ctx.lineWidth = ts * 0.88;
    for (const r of world.roads) {
      const pts = r.points;
      if (!pts || pts.length < 2 || r.type === 'airport-loop' || r.type === 'airport-spine') continue;
      let i = 0;
      while (i < pts.length - 1) {
        if (!(pts[i].isBridge || pts[i + 1].isBridge)) {
          i++;
          continue;
        }
        const eStart = i;
        while (i + 1 < pts.length - 1 && (pts[i + 1].isBridge || pts[i + 2].isBridge)) {
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
          (pS0.y + (pS1.y - pS0.y) * startFrac) * ts + oy
        );

        // Interior bridge vertices (`eStart + 1 .. eEnd`) rounded with exact `traceSmoothPath` quadratic Beziers
        for (let v = eStart + 1; v <= eEnd; v++) {
          const pPrev = pts[v - 1];
          const pCurr = pts[v];
          const pNext = pts[v + 1];
          const dx1 = pCurr.x - pPrev.x, dy1 = pCurr.y - pPrev.y;
          const dx2 = pNext.x - pCurr.x, dy2 = pNext.y - pCurr.y;
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
            ctx.quadraticCurveTo(pCurr.x * ts + ox, pCurr.y * ts + oy, xOut, yOut);
          }
        }

        // End of continuous bridge span (`vEnd = eEnd + 1`) at the shoreline bank (`1 - 0.32` from water tile to dry tile)
        const vEnd = eEnd + 1;
        const pE0 = pts[eEnd];
        const pE1 = pts[vEnd];
        const endFrac = pE0.isBridge && !pE1.isBridge ? 0.92 : 1.0;
        ctx.lineTo(
          (pE0.x + (pE1.x - pE0.x) * endFrac) * ts + ox,
          (pE0.y + (pE1.y - pE0.y) * endFrac) * ts + oy
        );
        ctx.stroke();
      }
    }
    ctx.lineCap = 'round';

    // =========================================================================
    // PASS 3: UNIFIED SURFACE ROAD ASPHALT FILLS (Driveways + Streets + Arterials + Airport Loops & Spines + Roundabout Rings)
    // Because all white fills are drawn after all casings, every intersection, T-junction, and roundabout throat
    // merges seamlessly with zero casing overdraw or throat-patching hacks!
    // =========================================================================
    ctx.strokeStyle = PALETTE.roadAsphalt;
    ctx.lineWidth = ts * 0.26;
    ctx.beginPath();
    for (const h of world.houses) {
      ctx.moveTo(h.x * ts + ts * 0.5, h.y * ts + ts * 0.5);
      ctx.lineTo(h.roadX * ts + ts * 0.5, h.roadY * ts + ts * 0.5);
    }
    for (const d of world.destinations) {
      const lx = d.lotX ?? d.x;
      const ly = d.lotY ?? d.y;
      ctx.moveTo(lx * ts + ts * 0.5, ly * ts + ts * 0.5);
      ctx.lineTo(d.roadX * ts + ts * 0.5, d.roadY * ts + ts * 0.5);
    }
    ctx.stroke();

    for (const r of world.roads) {
      if (r.points.length < 2 || r.type === 'airport-loop' || r.type === 'airport-spine') continue;
      ctx.strokeStyle = PALETTE.roadAsphalt;
      ctx.lineWidth = r.type === 'street' ? ts * 0.42 : ts * 0.56;
      this.traceSmoothPath(ctx, r.points, ts);
      ctx.stroke();
    }

    for (const ag of airportLandsideGeoms) {
      ctx.save();
      ctx.translate(ag.cx, ag.cy);
      ctx.rotate(ag.angleRad);
      ctx.strokeStyle = PALETTE.roadAsphalt;
      ctx.lineWidth = ts * 0.50;
      ctx.beginPath();
      ctx.roundRect(-ag.loopHalfW, ag.loopTopY, ag.loopW, ag.loopBoxH, ag.loopR);
      ctx.moveTo(0, ag.spineStartY);
      ctx.lineTo(ag.localGateX, ag.localGateY);
      ctx.stroke();
      ctx.restore();
    }

    if (roundabouts.length > 0) {
      ctx.strokeStyle = PALETTE.roadAsphalt;
      ctx.lineWidth = ts * 0.50;
      ctx.beginPath();
      for (const ic of world.interchanges) {
        if (ic.type === 'diamond-ramp' && ic.connectX !== undefined) {
          ctx.moveTo(ic.termX * ts + ts * 0.5, ic.termY * ts + ts * 0.5);
          ctx.lineTo(ic.connectX * ts + ts * 0.5, ic.connectY * ts + ts * 0.5);
        }
      }
      for (const rb of roundabouts) {
        ctx.moveTo(rb.x + rb.rRing, rb.y);
        ctx.arc(rb.x, rb.y, rb.rRing, 0, Math.PI * 2);
      }
      ctx.stroke();
    }

    // =========================================================================
    // PASS 4: LANDSCAPED CENTRAL ROUNDABOUT ISLANDS
    // =========================================================================
    for (const rb of roundabouts) {
      this.drawRoundaboutCentralIsland(ctx, rb.x, rb.y, rb.rIsland, rb.accentColor);
    }
  }

  drawRoundaboutCentralIsland(ctx, x, y, rIsland, accentColor) {
    // Inner curb casing around central landscaped island
    ctx.fillStyle = PALETTE.parkSageGreen;
    ctx.strokeStyle = PALETTE.roadCasing;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(x, y, rIsland, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Lush inner turf planter ring
    ctx.fillStyle = '#9fb99a';
    ctx.beginPath();
    ctx.arc(x, y, rIsland * 0.58, 0, Math.PI * 2);
    ctx.fill();

    // Subtle town/airport accent centerpiece
    if (accentColor) {
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
    const isRCI = this.activeLayer === 'rci';

    // 1. Residential Houses (with per-house dimensional & setback variation)
    for (const h of world.houses) {
      const cx = (h.x + (h.offX || 0)) * ts + ts * 0.5;
      const cy = (h.y + (h.offY || 0)) * ts + ts * 0.5;
      const hw = ts * (h.wScale || 0.72);
      const hh = ts * (h.hScale || 0.72);
      const baseCol = isRCI ? '#15803d' : h.palette.base;
      const roofCol = isRCI ? '#22c55e' : h.palette.roof;

      ctx.fillStyle = PALETTE.shadowColor;
      ctx.beginPath();
      ctx.roundRect(cx - hw * 0.5 + 3.0, cy - hh * 0.5 + 3.0, hw, hh, 2.5);
      ctx.fill();

      ctx.fillStyle = baseCol;
      ctx.beginPath();
      ctx.roundRect(cx - hw * 0.5, cy - hh * 0.5, hw, hh, 2.5);
      ctx.fill();

      ctx.fillStyle = roofCol;
      ctx.beginPath();
      ctx.roundRect(cx - hw * 0.5, cy - hh * 0.5, hw, hh * 0.68, 2.5);
      ctx.fill();
    }

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
      const isInd = d.zoneType === 'industrial';

      let baseCol = d.palette.base;
      let roofCol = d.palette.roof;
      let pinCol = d.palette.pin;
      if (isRCI) {
        if (!isInd) {
          baseCol = '#1d4ed8';
          roofCol = '#3b82f6';
          pinCol = '#1e3a8a';
        } else if (d.subType === 'RAW') {
          baseCol = '#b45309';
          roofCol = '#f59e0b';
          pinCol = '#78350f';
        } else if (d.subType === 'LOG') {
          baseCol = '#6d28d9';
          roofCol = '#a855f7';
          pinCol = '#4c1d95';
        } else {
          baseCol = '#c2410c';
          roofCol = '#ea580c';
          pinCol = '#7c2d12';
        }
      }

      if (!isInd) {
        // =================================================================
        // COMMERCIAL SINK (2×2 Rotunda, 3×2/2×3 Arterial Hall, or 2×1/1×2 Corner Market)
        // =================================================================
        ctx.fillStyle = isRCI ? '#dbeafe' : '#eceae4';
        ctx.strokeStyle = isRCI ? '#60a5fa' : '#b8b5ad';
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.roundRect(cx - lotW * 0.5, cy - lotH * 0.5, lotW, lotH, 4.5);
        ctx.fill();
        ctx.stroke();

        // 45° Building Drop Shadow
        const minDim = Math.min(bldW, bldH);
        ctx.fillStyle = PALETTE.shadowColor;
        ctx.beginPath();
        if (d.isCircular) {
          ctx.arc(cx + 5.2, cy + 5.2, minDim * 0.52, 0, Math.PI * 2);
        } else {
          ctx.roundRect(cx - bldW * 0.5 + 4.8, cy - bldH * 0.5 + 4.8, bldW, bldH, 4);
        }
        ctx.fill();

        // Main Commercial Base & Stepped Roof
        ctx.fillStyle = baseCol;
        ctx.beginPath();
        if (d.isCircular) {
          ctx.arc(cx, cy, minDim * 0.52, 0, Math.PI * 2);
        } else {
          ctx.roundRect(cx - bldW * 0.5, cy - bldH * 0.5, bldW, bldH, 4);
        }
        ctx.fill();

        ctx.fillStyle = roofCol;
        ctx.beginPath();
        if (d.isCircular) {
          ctx.arc(cx, cy - 1.6, minDim * 0.45, 0, Math.PI * 2);
        } else {
          ctx.roundRect(cx - bldW * 0.5 + 1.4, cy - bldH * 0.5 + 1.4, bldW - 2.8, bldH * 0.78, 3);
        }
        ctx.fill();

        // Bright Glass Atrium Skylight Core
        ctx.fillStyle = 'rgba(255, 255, 255, 0.36)';
        ctx.beginPath();
        if (d.isCircular) {
          ctx.arc(cx, cy - 1.6, minDim * 0.22, 0, Math.PI * 2);
        } else {
          ctx.roundRect(cx - bldW * 0.28, cy - bldH * 0.34, bldW * 0.56, bldH * 0.32, 2);
        }
        ctx.fill();

        // Round Consumer Demand Pins scaled to rectangular or circular roof
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = pinCol;
        ctx.lineWidth = 1.35;
        const cols = wT >= hT ? Math.min(3, Math.max(2, wT)) : Math.min(2, wT);
        const rows = Math.ceil(d.pinsCount / cols);
        for (let p = 0; p < d.pinsCount; p++) {
          let px, py;
          if (d.isCircular) {
            const ang = (p / d.pinsCount) * Math.PI * 2;
            px = cx + Math.cos(ang) * (minDim * 0.30);
            py = cy - 1.6 + Math.sin(ang) * (minDim * 0.30);
          } else {
            const col = p % cols;
            const row = Math.floor(p / cols);
            const spanX = bldW * 0.54;
            const spanY = bldH * 0.44;
            px = cols === 1 ? cx : cx - spanX * 0.5 + (col / (cols - 1)) * spanX;
            py = rows <= 1 ? cy - bldH * 0.12 : cy - spanY * 0.55 + (row / (rows - 1)) * spanY;
          }
          ctx.beginPath();
          ctx.arc(px, py, 2.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } else {
        // =================================================================
        // INDUSTRIAL FACILITY (`RAW` Silos, `MFG` Sawtooth Hall, `LOG` Cross-Dock)
        // =================================================================
        ctx.fillStyle = isRCI ? '#fef3c7' : '#d5d2ca';
        ctx.strokeStyle = isRCI ? '#f59e0b' : '#8c8980';
        ctx.lineWidth = 1.45;
        ctx.beginPath();
        ctx.roundRect(cx - lotW * 0.5, cy - lotH * 0.5, lotW, lotH, 3);
        ctx.fill();
        ctx.stroke();

        // Yellow-amber freight loading apron stripes along bottom edge of industrial yard
        ctx.fillStyle = 'rgba(217, 119, 6, 0.48)';
        const stripeCount = Math.max(3, wT * 2);
        for (let s = 0; s < stripeCount; s++) {
          const sx = cx - lotW * 0.36 + (s / (stripeCount - 1)) * (lotW * 0.72);
          ctx.fillRect(sx - 2, cy + lotH * 0.36, 4, 2.8);
        }

        // 45° Industrial Shadow
        ctx.fillStyle = PALETTE.shadowColor;
        ctx.beginPath();
        ctx.roundRect(cx - bldW * 0.5 + 4.8, cy - bldH * 0.5 + 4.8, bldW, bldH * 0.90, 3);
        ctx.fill();

        if (d.subType === 'RAW') {
          // Primary Extraction (`RAW`): Hopper Headhouse + Twin Cylindrical Storage Silos
          ctx.fillStyle = baseCol;
          ctx.beginPath();
          ctx.roundRect(cx - bldW * 0.48, cy - bldH * 0.44, bldW * 0.52, bldH * 0.84, 2.5);
          ctx.fill();

          ctx.fillStyle = roofCol;
          ctx.beginPath();
          ctx.roundRect(cx - bldW * 0.44, cy - bldH * 0.40, bldW * 0.44, bldH * 0.65, 2);
          ctx.fill();

          const siloR = Math.min(bldW, bldH) * 0.20;
          for (const syOff of [-bldH * 0.22, bldH * 0.18]) {
            ctx.fillStyle = '#6b7078';
            ctx.beginPath();
            ctx.arc(cx + bldW * 0.25, cy + syOff, siloR, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#e5e2dc';
            ctx.beginPath();
            ctx.arc(cx + bldW * 0.25, cy + syOff - 1, siloR * 0.75, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (d.subType === 'LOG') {
          // Logistics Distribution Center (`LOG`): Elongated Cross-Dock Freight Terminal
          ctx.fillStyle = baseCol;
          ctx.beginPath();
          ctx.roundRect(cx - bldW * 0.50, cy - bldH * 0.42, bldW, bldH * 0.82, 3);
          ctx.fill();

          ctx.fillStyle = roofCol;
          ctx.beginPath();
          ctx.roundRect(cx - bldW * 0.46, cy - bldH * 0.38, bldW * 0.92, bldH * 0.66, 2);
          ctx.fill();

          // White roof cross-dock bay dividers along the long axis
          ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
          const bays = Math.max(3, wT + 1);
          for (let b = 0; b < bays; b++) {
            const bx = cx - bldW * 0.32 + (b / (bays - 1)) * (bldW * 0.64);
            ctx.fillRect(bx - 1, cy - bldH * 0.34, 2, bldH * 0.56);
          }
        } else {
          // Secondary Manufacturing (`MFG`): Multi-Bay Sawtooth Factory Roof + Smokestack
          ctx.fillStyle = baseCol;
          ctx.beginPath();
          ctx.roundRect(cx - bldW * 0.50, cy - bldH * 0.46, bldW, bldH * 0.90, 2.5);
          ctx.fill();

          const numBays = hT >= 3 ? 4 : 3;
          const bayH = (bldH * 0.82) / numBays;
          for (let bay = 0; bay < numBays; bay++) {
            const by = cy - bldH * 0.42 + bay * bayH;
            ctx.fillStyle = roofCol;
            ctx.fillRect(cx - bldW * 0.46, by, bldW * 0.92, bayH * 0.72);
            ctx.fillStyle = 'rgba(54, 56, 62, 0.25)';
            ctx.fillRect(cx - bldW * 0.46, by + bayH * 0.72, bldW * 0.92, bayH * 0.24);
          }

          // Corner industrial smokestack cylinder
          ctx.fillStyle = '#36383e';
          ctx.beginPath();
          ctx.arc(cx + bldW * 0.34, cy - bldH * 0.30, ts * 0.24, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(cx + bldW * 0.34, cy - bldH * 0.30, ts * 0.10, 0, Math.PI * 2);
          ctx.fill();
        }

        // Square Cargo Crate Pins on Industrial Roof
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = pinCol;
        ctx.lineWidth = 1.25;
        const maxCrates = Math.min(wT * hT >= 6 ? 5 : 4, d.pinsCount);
        const crateCols = wT >= 3 ? 3 : 2;
        for (let p = 0; p < maxCrates; p++) {
          const px = cx - bldW * 0.32 + (p % crateCols) * (bldW * 0.24);
          const py = cy - bldH * 0.18 + Math.floor(p / crateCols) * (bldH * 0.26);
          ctx.fillRect(px - 2.1, py - 2.1, 4.2, 4.2);
          ctx.strokeRect(px - 2.1, py - 2.1, 4.2, 4.2);
        }
      }

      if (d.hasUrgentPin) {
        const bx = cx - bldW * 0.38;
        const by = cy - bldH * 0.52;
        ctx.fillStyle = '#d9383a';
        ctx.beginPath();
        ctx.arc(bx, by, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
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
      const rwyWid = ts * (ap.isHub ? 1.35 : 1.15);
      const padLen = rwyLen + ts * 1.8;
      const padWid = ap.halfWid * 2 * ts + ts * (ap.isHub ? 1.8 : 1.2);
      const side = ap.apronSide;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ap.angleRad);

      if (ap.isHub) {
        // =================================================================
        // TIER 1: INTERNATIONAL DUAL-RUNWAY HUB (Parallel Runways L & R)
        // =================================================================
        const mainRwyY = -side * (ts * 0.85);
        const outerRwyY = -side * (ts * 2.55);
        const centralTaxiY = side * (ts * 0.40);

        // High-speed parallel & cross-field taxiways
        ctx.strokeStyle = '#9ca0a6';
        ctx.lineWidth = ts * 0.42;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-rwyLen * 0.41, centralTaxiY);
        ctx.lineTo(rwyLen * 0.41, centralTaxiY);
        for (const xFrac of [-0.41, -0.18, 0.18, 0.41]) {
          ctx.moveTo(rwyLen * xFrac, centralTaxiY);
          ctx.lineTo(rwyLen * (xFrac * 1.04), outerRwyY);
        }
        ctx.stroke();

        // Yellow taxiway centerlines
        ctx.strokeStyle = '#f4c24f';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(-rwyLen * 0.41, centralTaxiY);
        ctx.lineTo(rwyLen * 0.41, centralTaxiY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Render both Parallel Runways (Primary + Secondary)
        for (const [ry, rLenScale, rWidScale] of [[mainRwyY, 1.0, 1.0], [outerRwyY, 0.88, 0.86]]) {
          const curLen = rwyLen * rLenScale;
          const curWid = rwyWid * rWidScale;
          ctx.fillStyle = '#36383e';
          ctx.beginPath();
          ctx.roundRect(-curLen * 0.5, ry - curWid * 0.5, curLen, curWid, 4);
          ctx.fill();

          ctx.strokeStyle = '#f2efe9';
          ctx.lineWidth = 1.6;
          ctx.setLineDash([7, 6]);
          ctx.beginPath();
          ctx.moveTo(-curLen * 0.4, ry);
          ctx.lineTo(curLen * 0.4, ry);
          ctx.stroke();
          ctx.setLineDash([]);

          // Runway piano-key threshold markings
          ctx.fillStyle = '#f2efe9';
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
        const termH = ts * 1.15;
        const termY = side * (ts * 1.32);

        // Jetbridge fingers extending toward central apron taxiway
        ctx.strokeStyle = '#7c7f87';
        ctx.lineWidth = 3.0;
        for (let g = -3; g <= 3; g++) {
          const gx = g * (termW * 0.12);
          ctx.beginPath();
          ctx.moveTo(gx, termY);
          ctx.lineTo(gx, centralTaxiY + side * (ts * 0.25));
          ctx.stroke();
        }

        // Terminal Shadow, Base & Roof
        ctx.fillStyle = PALETTE.shadowColor;
        ctx.beginPath();
        ctx.roundRect(-termW * 0.5 + 4, termY - termH * 0.5 + 4, termW, termH, 6);
        ctx.fill();

        ctx.fillStyle = ap.palette.base;
        ctx.beginPath();
        ctx.roundRect(-termW * 0.5, termY - termH * 0.5, termW, termH, 6);
        ctx.fill();

        ctx.fillStyle = ap.palette.roof;
        ctx.beginPath();
        ctx.roundRect(-termW * 0.5 + 2, termY - termH * 0.5 + 2, termW - 4, termH * 0.76, 4);
        ctx.fill();

        // Demand Pins along Concourse Roof
        ctx.fillStyle = '#ffffff';
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
        const mainRwyY = -side * (ts * 0.58);
        const taxiY = side * (ts * 0.45);

        ctx.strokeStyle = '#9ca0a6';
        ctx.lineWidth = ts * 0.38;
        ctx.lineCap = 'round';
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
        ctx.fillStyle = '#36383e';
        ctx.beginPath();
        ctx.roundRect(-rwyLen * 0.5, mainRwyY - rwyWid * 0.5, rwyLen, rwyWid, 4);
        ctx.fill();

        ctx.strokeStyle = '#f2efe9';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(-rwyLen * 0.38, mainRwyY);
        ctx.lineTo(rwyLen * 0.38, mainRwyY);
        ctx.stroke();
        ctx.setLineDash([]);

        const termW = rwyLen * 0.40;
        const termH = ts * 1.02;
        const termY = side * (ts * 1.18);

        if (ap.airportClass === 'CRG') {
          // Cargo Airfield: Twin Modular Warehouse Sortation Pads
          for (const wSign of [-1, 1]) {
            const wx = wSign * (termW * 0.32);
            const ww = termW * 0.48;
            ctx.fillStyle = PALETTE.shadowColor;
            ctx.beginPath();
            ctx.roundRect(wx - ww * 0.5 + 4, termY - termH * 0.5 + 4, ww, termH, 4);
            ctx.fill();

            ctx.fillStyle = ap.palette.base;
            ctx.beginPath();
            ctx.roundRect(wx - ww * 0.5, termY - termH * 0.5, ww, termH, 4);
            ctx.fill();

            ctx.fillStyle = ap.palette.roof;
            ctx.beginPath();
            ctx.roundRect(wx - ww * 0.5 + 1.5, termY - termH * 0.5 + 1.5, ww - 3, termH * 0.75, 3);
            ctx.fill();
          }
        } else {
          // Regional Passenger Terminal Concourse
          ctx.fillStyle = PALETTE.shadowColor;
          ctx.beginPath();
          ctx.roundRect(-termW * 0.5 + 5, termY - termH * 0.5 + 5, termW, termH, 6);
          ctx.fill();

          ctx.fillStyle = ap.palette.base;
          ctx.beginPath();
          ctx.roundRect(-termW * 0.5, termY - termH * 0.5, termW, termH, 6);
          ctx.fill();

          ctx.fillStyle = ap.palette.roof;
          ctx.beginPath();
          ctx.roundRect(-termW * 0.5 + 2, termY - termH * 0.5 + 2, termW - 4, termH * 0.76, 5);
          ctx.fill();
        }

        // Demand Pins on Roof
        ctx.fillStyle = '#ffffff';
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
        [-padLen * 0.5, padWid * 0.5]
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
      ctx.font = '800 10px Inter, sans-serif';
      const badgePrefix = ap.airportClass === 'HUB' ? '✈ HUB' : (ap.airportClass === 'CRG' ? '📦 CRG' : '✈ REG');
      const tagText = `${badgePrefix} • ${ap.iata}`;
      const tw = ctx.measureText(tagText).width + 14;

      const badgeX = Math.max(tw * 0.5 + 10, Math.min(world.W * ts - tw * 0.5 - 10, (minX + maxX) * 0.5));
      const badgeY = minY >= 36 ? minY - 15 : maxY + 20;

      ctx.fillStyle = ap.isHub ? '#e85c90' : '#36383e';
      ctx.beginPath();
      ctx.roundRect(badgeX - tw * 0.5, badgeY - 9, tw, 18, 9);
      ctx.fill();
      ctx.fillStyle = '#f2efe9';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tagText, badgeX, badgeY);
      ctx.restore();
    }
  }

  drawAirportTower(ctx, towerX, termY, ts, accentColor) {
    ctx.fillStyle = PALETTE.shadowColor;
    ctx.beginPath();
    ctx.arc(towerX + 4, termY + 4, ts * 0.48, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#36383e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(towerX, termY, ts * 0.48, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

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
    for (let i = 1; i < samples.length; i++) {
      ctx.lineTo(samples[i].x * ts + ox, samples[i].y * ts + oy);
    }
  }

  drawInterchangesUnderlay(ctx, world, ts) {
    const ox = ts * 0.5;
    const oy = ts * 0.5;

    for (const ic of world.interchanges) {
      const cx = ic.x * ts + ox;
      const cy = ic.y * ts + oy;

      if (ic.type === 'cloverleaf') {
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

        const outerDist = ts * 2.95;
        const outerCtrl = ts * 1.05;
        const leafSpan  = ts * 3.10;

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // 1. Soft ground shadow under active cloverleaf ramp quadrants
        ctx.strokeStyle = 'rgba(54, 56, 62, 0.11)';
        ctx.lineWidth = ts * 0.42;
        for (const [sA, sB] of quadrants) {
          const rAx = sA * uAx, rAy = sA * uAy;
          const rBx = sB * uBx, rBy = sB * uBy;
          ctx.beginPath();
          ctx.moveTo(cx + rAx * outerDist + 5, cy + rAy * outerDist + 7);
          ctx.quadraticCurveTo(
            cx + (rAx + rBx) * outerCtrl + 5,
            cy + (rAy + rBy) * outerCtrl + 7,
            cx + rBx * outerDist + 5,
            cy + rBy * outerDist + 7
          );
          ctx.stroke();

          ctx.beginPath();
          ctx.moveTo(cx + 5, cy + 7);
          ctx.bezierCurveTo(
            cx + rAx * leafSpan + 5, cy + rAy * leafSpan + 7,
            cx + rBx * leafSpan + 5, cy + rBy * leafSpan + 7,
            cx + 5, cy + 7
          );
          ctx.stroke();
        }

        // 2. Outer Concave Right-Turn Slip Ramps (Casing + Pink Fill)
        for (const pass of ['border', 'fill']) {
          ctx.strokeStyle = pass === 'border' ? PALETTE.motorwayBorder : '#f48fb1';
          ctx.lineWidth = pass === 'border' ? ts * 0.36 : ts * 0.22;
          for (const [sA, sB] of quadrants) {
            const rAx = sA * uAx, rAy = sA * uAy;
            const rBx = sB * uBx, rBy = sB * uBy;
            ctx.beginPath();
            ctx.moveTo(cx + rAx * outerDist, cy + rAy * outerDist);
            ctx.quadraticCurveTo(
              cx + (rAx + rBx) * outerCtrl,
              cy + (rAy + rBy) * outerCtrl,
              cx + rBx * outerDist,
              cy + rBy * outerDist
            );
            ctx.stroke();
          }
        }

        // 3. Inner 270° Tangent Cloverleaf Loops (Casing + Pink Fill)
        for (const pass of ['border', 'fill']) {
          ctx.strokeStyle = pass === 'border' ? PALETTE.motorwayBorder : PALETTE.motorwayFill;
          ctx.lineWidth = pass === 'border' ? ts * 0.38 : ts * 0.24;
          for (const [sA, sB] of quadrants) {
            const rAx = sA * uAx, rAy = sA * uAy;
            const rBx = sB * uBx, rBy = sB * uBy;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.bezierCurveTo(
              cx + rAx * leafSpan, cy + rAy * leafSpan,
              cx + rBx * leafSpan, cy + rBy * leafSpan,
              cx, cy
            );
            ctx.stroke();
          }
        }
        ctx.restore();
      } else if (ic.type === 'trumpet') {
        // =================================================================
        // AUTHENTIC 3-WAY TRUMPET INTERCHANGE
        // - Terminating highway approaches from +sy side, with ONE concave
        //   directional slip-ramp in the (-1, +sy) quadrant.
        // - The Spur crosses OVER the Mainline at (0, 0) into a wide, open
        //   2-segment 270° Trumpet Bell Loop in the (+1, -sy) OPPOSITE quadrant,
        //   which curls around and merges tangentially into the Mainline!
        // =================================================================
        const sy = ic.sideSign || 1;
        const oppSy = -sy;
        const outerDist = ts * 2.15;
        const outerCtrl = ts * 0.72;

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.translate(cx, cy);
        ctx.rotate(ic.angleMain);

        const drawTrumpetRamps = (oxS, oyS) => {
          // 1. Single Concave Outer Directional Slip-Ramp on the Terminating Highway Side (-1, +sy)
          ctx.beginPath();
          ctx.moveTo(-outerDist + oxS, 0 + oyS);
          ctx.quadraticCurveTo(
            -outerCtrl + oxS,
            sy * outerCtrl + oyS,
            0 + oxS,
            sy * outerDist + oyS
          );
          ctx.stroke();

          // 2. Proportionate 2-Segment 270° Trumpet Bell Loop on the OPPOSITE Side (+1, -sy)
          ctx.beginPath();
          ctx.moveTo(0 + oxS, 0 + oyS);
          ctx.bezierCurveTo(
            0 + oxS, oppSy * ts * 1.35 + oyS,
            ts * 0.38 + oxS, oppSy * ts * 1.85 + oyS,
            ts * 1.02 + oxS, oppSy * ts * 1.85 + oyS
          );
          ctx.bezierCurveTo(
            ts * 1.92 + oxS, oppSy * ts * 1.85 + oyS,
            ts * 1.92 + oxS, 0 + oyS,
            ts * 0.52 + oxS, 0 + oyS
          );
          ctx.stroke();
        };

        // Ground shadow
        ctx.strokeStyle = 'rgba(54, 56, 62, 0.12)';
        ctx.lineWidth = ts * 0.42;
        drawTrumpetRamps(5, 7);

        // Casing + Pink Ramp Fill
        for (const pass of ['border', 'fill']) {
          ctx.strokeStyle = pass === 'border' ? PALETTE.motorwayBorder : '#f48fb1';
          ctx.lineWidth = pass === 'border' ? ts * 0.38 : ts * 0.24;
          drawTrumpetRamps(0, 0);
        }

        ctx.restore();
      } else if (ic.type === 'diamond-ramp') {
        // =================================================================
        // ONE-SIDED HALF-DIAMOND SLIP-RAMP TO SURFACE STUB
        // (Underpass pruned, stub-end ramps elided, peels from deck edge)
        // =================================================================
        const sySign = ic.connSide !== undefined ? ic.connSide : 1;

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.translate(cx, cy);
        ctx.rotate(ic.angleRad);

        const along = ts * 2.85;
        const across = ts * 2.65;
        const deckEdge = ts * 0.36;
        const rbY = sySign * across;
        const rbR = ts * 0.56;

        // Clip out the roundabout's asphalt ring (`rbR + ts * 0.24`) so the slip-ramps terminate
        // cleanly at the outer edge of the roundabout without needing a second-pass roundabout redraw!
        ctx.beginPath();
        ctx.rect(-ts * 12, -ts * 12, ts * 24, ts * 24);
        ctx.moveTo(rbR + ts * 0.24, rbY);
        ctx.arc(0, rbY, rbR + ts * 0.24, 0, Math.PI * 2);
        ctx.clip('evenodd');

        // Two Smooth Curved Bezier Slip-Ramps Peeling Tangentially Off the Outer Deck Edge
        for (const pass of ['border', 'fill']) {
          ctx.strokeStyle = pass === 'border' ? PALETTE.motorwayBorder : '#f48fb1';
          ctx.lineWidth = pass === 'border' ? ts * 0.36 : ts * 0.22;

          for (const sxSign of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(sxSign * along, sySign * deckEdge);
            ctx.bezierCurveTo(
              sxSign * along * 0.46, sySign * deckEdge,
              sxSign * along * 0.16, sySign * across * 0.82,
              0, sySign * across
            );
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }
  }

  drawMotorways(ctx, world, ts) {
    // 1. Draw Cloverleaf Loops & One-Sided Slip-Ramps underneath the main decks
    this.drawInterchangesUnderlay(ctx, world, ts);

    // 2. Draw Mainline Elevated Pink Expressways
    for (const mw of world.motorways) {
      const samples = mw.samples;
      if (!samples || samples.length < 2) continue;

      const sx = mw.sx * ts + ts * 0.5;
      const sy = mw.sy * ts + ts * 0.5;
      const ex = mw.ex * ts + ts * 0.5;
      const ey = mw.ey * ts + ts * 0.5;

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Clip out the non-pruned terminal roundabout asphalt rings (`rbR + ts * 0.24`) so the pink
      // expressway stops cleanly at the outer edge of each roundabout without needing a second-pass
      // roundabout layer that would clip vehicles driving through the roundabout!
      const termEndpoints = [];
      if (!mw.prunedStart) termEndpoints.push([sx, sy]);
      if (!mw.prunedEnd) termEndpoints.push([ex, ey]);
      if (termEndpoints.length > 0) {
        ctx.beginPath();
        ctx.rect(-ts * 50, -ts * 50, (world.W + 100) * ts, (world.H + 100) * ts);
        for (const [rx, ry] of termEndpoints) {
          const apGateway = world.airports.find(
            a => Math.hypot(a.gateX * ts + ts * 0.5 - rx, a.gateY * ts + ts * 0.5 - ry) < 1.0
          );
          const rbR = apGateway ? ts * 0.68 : ts * 0.64;
          const clipR = rbR + ts * 0.24;
          ctx.moveTo(rx + clipR, ry);
          ctx.arc(rx, ry, clipR, 0, Math.PI * 2);
        }
        ctx.clip('evenodd');
      }

      // Split `samples` into above-ground surface spans and subterranean tunnel spans (`mw.tunnels`)
      // so tunneled motorway sections cast ZERO ground shadows and leave mountain contours/trees untouched!
      const tunnels = mw.tunnels || [];
      const surfaceSpans = [];
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

      // 1. Soft Elevated Overpass Drop Shadow on the ground below (ONLY for above-ground surface spans!)
      ctx.strokeStyle = 'rgba(54, 56, 62, 0.14)';
      ctx.lineWidth = ts * 0.92;
      for (const seg of surfaceSpans) {
        this.traceMotorwaySamples(ctx, seg, ts, 8, 11);
        ctx.stroke();
      }

      // 2. Subterranean Mountain Tunnel Bore (Full-width dashed charcoal bore casing + bold dashed pink deck, zero drop shadow!)
      if (tunnels.length > 0) {
        ctx.lineCap = 'butt';
        ctx.strokeStyle = 'rgba(54, 56, 62, 0.42)';
        ctx.lineWidth = ts * 0.84;
        ctx.setLineDash([7, 5]);
        for (const tun of tunnels) {
          const tSamples = samples.slice(tun.i0, tun.i1 + 1);
          if (tSamples.length >= 2) {
            this.traceMotorwaySamples(ctx, tSamples, ts, 0, 0);
            ctx.stroke();
          }
        }

        ctx.strokeStyle = 'rgba(232, 92, 144, 0.72)';
        ctx.lineWidth = ts * 0.56;
        for (const tun of tunnels) {
          const tSamples = samples.slice(tun.i0, tun.i1 + 1);
          if (tSamples.length >= 2) {
            this.traceMotorwaySamples(ctx, tSamples, ts, 0, 0);
            ctx.stroke();
          }
        }
        ctx.setLineDash([]);
        ctx.lineCap = 'round';
      }

      // 3. Vibrant Pink Motorway Outer Casing (above-ground spans only)
      ctx.strokeStyle = PALETTE.motorwayBorder;
      ctx.lineWidth = ts * 0.88;
      for (const seg of surfaceSpans) {
        this.traceMotorwaySamples(ctx, seg, ts, 0, 0);
        ctx.stroke();
      }

      // 4. Translucent Pink Motorway Deck (above-ground spans only)
      ctx.strokeStyle = PALETTE.motorwayFill;
      ctx.lineWidth = ts * 0.72;
      for (const seg of surfaceSpans) {
        this.traceMotorwaySamples(ctx, seg, ts, 0, 0);
        ctx.stroke();
      }

      // 5. Crisp Median Divider Line (above-ground spans only)
      ctx.strokeStyle = PALETTE.motorwayCore;
      ctx.lineWidth = 2.0;
      for (const seg of surfaceSpans) {
        this.traceMotorwaySamples(ctx, seg, ts, 0, 0);
        ctx.stroke();
      }

      // 6. Concrete Tunnel Portal Mouths at Entry & Exit of Each Mountain Tunnel
      if (tunnels.length > 0) {
        for (const tun of tunnels) {
          for (const [px, py, ang] of [
            [tun.x0 * ts + ts * 0.5, tun.y0 * ts + ts * 0.5, tun.ang0],
            [tun.x1 * ts + ts * 0.5, tun.y1 * ts + ts * 0.5, tun.ang1 + Math.PI]
          ]) {
            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(ang);
            ctx.fillStyle = '#36383e';
            ctx.strokeStyle = '#f2efe9';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.roundRect(-3.5, -ts * 0.56, 7.0, ts * 1.12, 2.5);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#1f2024';
            ctx.beginPath();
            ctx.arc(1.5, 0, ts * 0.34, -Math.PI * 0.5, Math.PI * 0.5);
            ctx.fill();
            ctx.restore();
          }
        }
      }

      // Choose a clean Highway Shield Badge ([1], [2]) position that maximizes clearance from all interchanges & endpoints
      let shieldPt = samples[Math.floor(samples.length * 0.5)];
      let bestClearance = -Infinity;
      const iMin = Math.max(2, Math.floor(samples.length * 0.16));
      const iMax = Math.min(samples.length - 3, Math.ceil(samples.length * 0.84));
      for (let i = iMin; i <= iMax; i++) {
        const cand = samples[i];
        let minIcDist = Math.min(
          Math.hypot(cand.x - mw.sx, cand.y - mw.sy),
          Math.hypot(cand.x - mw.ex, cand.y - mw.ey)
        );
        for (const ic of world.interchanges) {
          const dIc = Math.hypot(ic.x - cand.x, ic.y - cand.y);
          if (dIc < minIcDist) minIcDist = dIc;
        }
        // Prefer central span slightly when clearance is already ample
        const centerBias = 1.0 - Math.abs(i / (samples.length - 1) - 0.5) * 0.35;
        const score = Math.min(minIcDist, 14.0) * centerBias;
        if (score > bestClearance) {
          bestClearance = score;
          shieldPt = cand;
        }
      }
      const bx = shieldPt.x * ts + ts * 0.5;
      const by = shieldPt.y * ts + ts * 0.5;

      ctx.fillStyle = '#f2efe9';
      ctx.strokeStyle = '#36383e';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      const sw = 11;
      const sh = 12;
      ctx.moveTo(bx - sw, by - sh * 0.75);
      ctx.lineTo(bx + sw, by - sh * 0.75);
      ctx.lineTo(bx + sw, by + sh * 0.15);
      ctx.quadraticCurveTo(bx, by + sh, bx, by + sh);
      ctx.quadraticCurveTo(bx, by + sh, bx - sw, by + sh * 0.15);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#36383e';
      ctx.font = '800 11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(mw.number), bx, by + 0.5);
      ctx.restore();
    }

    // 3. Draw Grade-Separated Overpass Bridge Spans at Cloverleaf & Trumpet Centers
    for (const ic of world.interchanges) {
      if (ic.type === 'cloverleaf') {
        const cx = ic.x * ts + ts * 0.5;
        const cy = ic.y * ts + ts * 0.5;
        const span = ts * 1.65;
        const bridgeAng = ic.prunedBridgeB ? ic.angleA : ic.angleB;
        const ux = Math.cos(bridgeAng);
        const uy = Math.sin(bridgeAng);
        const nx = -uy;
        const ny = ux;
        const halfDeck = ts * 0.46;

        ctx.save();
        ctx.lineCap = 'butt';

        // Upper deck shadow cast onto the lower motorway
        ctx.strokeStyle = 'rgba(54, 56, 62, 0.22)';
        ctx.lineWidth = ts * 0.96;
        ctx.beginPath();
        ctx.moveTo(cx - ux * span + 3, cy - uy * span + 4);
        ctx.lineTo(cx + ux * span + 3, cy + uy * span + 4);
        ctx.stroke();

        // Redraw the upper motorway span cleanly over the lower motorway
        ctx.strokeStyle = PALETTE.motorwayBorder;
        ctx.lineWidth = ts * 0.88;
        ctx.beginPath();
        ctx.moveTo(cx - ux * span, cy - uy * span);
        ctx.lineTo(cx + ux * span, cy + uy * span);
        ctx.stroke();

        ctx.strokeStyle = '#ee6998';
        ctx.lineWidth = ts * 0.72;
        ctx.stroke();

        ctx.strokeStyle = PALETTE.motorwayCore;
        ctx.lineWidth = 2.0;
        ctx.stroke();

        // Dark charcoal bridge parapet rails along both sides of the upper overpass deck
        ctx.strokeStyle = '#36383e';
        ctx.lineWidth = 2.2;
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(cx - ux * span + nx * halfDeck * side, cy - uy * span + ny * halfDeck * side);
          ctx.lineTo(cx + ux * span + nx * halfDeck * side, cy + uy * span + ny * halfDeck * side);
          ctx.stroke();
        }
        ctx.restore();
      } else if (ic.type === 'trumpet') {
        // In a Trumpet interchange, the terminating Spur crosses OVER the Mainline
        // perpendicular to angleMain and transitions directly into the opposite-side (-sy) loop.
        const cx = ic.x * ts + ts * 0.5;
        const cy = ic.y * ts + ts * 0.5;
        const sy = ic.sideSign || 1;
        const spurAng = ic.angleMain + Math.PI * 0.5 * sy;
        const ux = Math.cos(spurAng);
        const uy = Math.sin(spurAng);
        const nx = -uy;
        const ny = ux;
        const spanIn = ts * 0.75;
        const spanOut = ts * 0.52;
        const halfDeck = ts * 0.32;

        ctx.save();
        ctx.lineCap = 'butt';

        ctx.strokeStyle = 'rgba(54, 56, 62, 0.20)';
        ctx.lineWidth = ts * 0.64;
        ctx.beginPath();
        ctx.moveTo(cx + ux * spanIn + 3, cy + uy * spanIn + 4);
        ctx.lineTo(cx - ux * spanOut + 3, cy - uy * spanOut + 4);
        ctx.stroke();

        ctx.strokeStyle = PALETTE.motorwayBorder;
        ctx.lineWidth = ts * 0.56;
        ctx.beginPath();
        ctx.moveTo(cx + ux * spanIn, cy + uy * spanIn);
        ctx.lineTo(cx - ux * spanOut, cy - uy * spanOut);
        ctx.stroke();

        ctx.strokeStyle = '#ee6998';
        ctx.lineWidth = ts * 0.42;
        ctx.stroke();

        ctx.strokeStyle = '#36383e';
        ctx.lineWidth = 2.0;
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(cx + ux * spanIn + nx * halfDeck * side, cy + uy * spanIn + ny * halfDeck * side);
          ctx.lineTo(cx - ux * spanOut + nx * halfDeck * side, cy - uy * spanOut + ny * halfDeck * side);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  drawCars(ctx, world, sim, ts, modeFilter = null) {
    const ox = ts * 0.5;
    const oy = ts * 0.5;

    // Gather all roundabout centers & radii so vehicles follow the circulatory ring lane
    // around the central landscaped island rather than driving straight through the island!
    const roundabouts = [];
    for (const ap of world.airports) {
      roundabouts.push({ x: ap.gateX * ts + ox, y: ap.gateY * ts + oy, rRing: ts * 0.68 });
    }
    for (const ic of world.interchanges) {
      if (ic.type === 'terminal-stub' && !ic.isAirportStub) {
        roundabouts.push({ x: ic.x * ts + ox, y: ic.y * ts + oy, rRing: ts * 0.64 });
      } else if (ic.type === 'diamond-ramp') {
        roundabouts.push({ x: ic.termX * ts + ox, y: ic.termY * ts + oy, rRing: ts * 0.56 });
      }
    }

    for (const car of sim.cars) {
      if (modeFilter && car.mode !== modeFilter) continue;

      let x, y, ang;
      if (car.mode === 'motorway') {
        const samples = car.mw.samples;
        if (!samples || samples.length < 2) continue;
        const scaled = Math.max(0, Math.min(0.9999, car.t)) * (samples.length - 1);
        const idx = Math.floor(scaled);
        if (car.mw.tunnels && car.mw.tunnels.some(tun => scaled >= tun.i0 && scaled <= tun.i1)) {
          continue; // Vehicle is inside a subterranean mountain tunnel
        }
        const frac = scaled - idx;
        const p0 = samples[idx];
        const p1 = samples[idx + 1];
        x = (p0.x + (p1.x - p0.x) * frac) * ts + ox;
        y = (p0.y + (p1.y - p0.y) * frac) * ts + oy;
        ang = Math.atan2((p1.y - p0.y) * car.dir, (p1.x - p0.x) * car.dir);
      } else {
        const pts = car.road.points;
        const p0 = pts[car.segIdx];
        const p1 = pts[car.segIdx + 1];
        if (!p0 || !p1) continue;
        const u = car.dir > 0 ? car.segT : 1 - car.segT;
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const len = Math.hypot(dx, dy) || 1;

        let tx = p0.x + dx * u;
        let ty = p0.y + dy * u;
        let tanX = dx * car.dir;
        let tanY = dy * car.dir;

        // Evaluate `traceSmoothPath` quadratic Bezier corner fillet near `p0` (`segIdx > 0`)
        if (car.segIdx > 0) {
          const pPrev = pts[car.segIdx - 1];
          const dxPrev = p0.x - pPrev.x;
          const dyPrev = p0.y - pPrev.y;
          if (dxPrev !== dx || dyPrev !== dy) {
            const lenPrev = Math.hypot(dxPrev, dyPrev) || 1;
            const r0 = Math.min(0.24, lenPrev * 0.45, len * 0.45);
            const u0 = r0 / len;
            if (u < u0 && u0 > 1e-4) {
              const bT = 0.5 + 0.5 * (u / u0);
              const mt = 1 - bT;
              const ax = p0.x - (dxPrev / lenPrev) * r0;
              const ay = p0.y - (dyPrev / lenPrev) * r0;
              const cx = p0.x + (dx / len) * r0;
              const cy = p0.y + (dy / len) * r0;
              tx = mt * mt * ax + 2 * mt * bT * p0.x + bT * bT * cx;
              ty = mt * mt * ay + 2 * mt * bT * p0.y + bT * bT * cy;
              tanX = (mt * (p0.x - ax) + bT * (cx - p0.x)) * car.dir;
              tanY = (mt * (p0.y - ay) + bT * (cy - p0.y)) * car.dir;
            }
          }
        }

        // Evaluate `traceSmoothPath` quadratic Bezier corner fillet near `p1` (`segIdx + 1 < pts.length - 1`)
        if (car.segIdx + 1 < pts.length - 1) {
          const pNext = pts[car.segIdx + 2];
          const dxNext = pNext.x - p1.x;
          const dyNext = pNext.y - p1.y;
          if (dx !== dxNext || dy !== dyNext) {
            const lenNext = Math.hypot(dxNext, dyNext) || 1;
            const r1 = Math.min(0.24, len * 0.45, lenNext * 0.45);
            const u1 = r1 / len;
            if (u > 1 - u1 && u1 > 1e-4) {
              const bT = 0.5 * ((u - (1 - u1)) / u1);
              const mt = 1 - bT;
              const ax = p1.x - (dx / len) * r1;
              const ay = p1.y - (dy / len) * r1;
              const cx = p1.x + (dxNext / lenNext) * r1;
              const cy = p1.y + (dyNext / lenNext) * r1;
              tx = mt * mt * ax + 2 * mt * bT * p1.x + bT * bT * cx;
              ty = mt * mt * ay + 2 * mt * bT * p1.y + bT * bT * cy;
              tanX = (mt * (p1.x - ax) + bT * (cx - p1.x)) * car.dir;
              tanY = (mt * (p1.y - ay) + bT * (cy - p1.y)) * car.dir;
            }
          }
        }

        x = tx * ts + ox;
        y = ty * ts + oy;
        ang = Math.atan2(tanY, tanX);
      }

      // If the vehicle is within a roundabout's footprint, deflect it onto the right-hand
      // circulatory ring lane (`rRing`) so it orbits the landscaped island instead of clipping through it!
      for (const rb of roundabouts) {
        const dx = x - rb.x;
        const dy = y - rb.y;
        const dist = Math.hypot(dx, dy);
        if (dist < rb.rRing * 0.98) {
          const ux = Math.cos(ang);
          const uy = Math.sin(ang);
          const rx = -uy; // right-hand perpendicular unit vector
          const ry = ux;
          const along = dx * ux + dy * uy;
          const clampedAlong = Math.max(-rb.rRing * 0.92, Math.min(rb.rRing * 0.92, along));
          const lateral = Math.sqrt(Math.max(0, rb.rRing * rb.rRing - clampedAlong * clampedAlong));
          x = rb.x + ux * clampedAlong + rx * lateral;
          y = rb.y + uy * clampedAlong + ry * lateral;
          // Tangent angle along the counter-clockwise / right-hand circulatory arc
          const radAng = Math.atan2(y - rb.y, x - rb.x);
          ang = radAng + Math.PI * 0.5;
          break;
        }
      }

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      if (car.isFreightTruck) {
        // Articulated Freight Truck (Charcoal tractor cab + Cargo-colored trailer box)
        ctx.fillStyle = '#36383e';
        ctx.beginPath();
        ctx.roundRect(1.8, -2.8, 4.2, 5.6, 1.5);
        ctx.fill();
        ctx.fillStyle = car.color;
        ctx.strokeStyle = '#ffffff';
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

  drawPlanes(ctx, world, sim, ts) {
    const ox = ts * 0.5;
    const oy = ts * 0.5;

    for (const p of sim.planes) {
      const oSide = p.origin.apronSide || 1;
      const dSide = p.dest.apronSide || 1;
      const oRwyOff = -oSide * (p.origin.isHub ? 1.15 : 0.75) * ts;
      const dRwyOff = -dSide * (p.dest.isHub ? 1.15 : 0.75) * ts;

      const oCos = Math.cos(p.origin.angleRad || 0);
      const oSin = Math.sin(p.origin.angleRad || 0);
      const dCos = Math.cos(p.dest.angleRad || 0);
      const dSin = Math.sin(p.dest.angleRad || 0);

      const sx = p.origin.x * ts + ox - oSin * oRwyOff;
      const sy = p.origin.y * ts + oy + oCos * oRwyOff;
      const ex = p.dest.x * ts + ox - dSin * dRwyOff;
      const ey = p.dest.y * ts + oy + dCos * dRwyOff;

      const dx = ex - sx;
      const dy = ey - sy;
      const dist = Math.hypot(dx, dy) || 1;
      const climbPull = Math.min(ts * 18, dist * 0.34);

      const oSign = (dx * oCos + dy * oSin) >= 0 ? 1 : -1;
      const dSign = (dx * dCos + dy * dSin) >= 0 ? 1 : -1;

      const c1x = sx + oCos * oSign * climbPull;
      const c1y = sy + oSin * oSign * climbPull;
      const c2x = ex - dCos * dSign * climbPull;
      const c2y = ey - dSin * dSign * climbPull;

      // Draw subtle runway-aligned dashed airway arc between airports
      ctx.save();
      ctx.strokeStyle = 'rgba(54, 56, 62, 0.14)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 6]);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);

      // Evaluate aircraft position and tangent along the cubic Bezier flight path
      const t = p.progress;
      const mt = 1 - t;
      const b0 = mt * mt * mt;
      const b1 = 3 * mt * mt * t;
      const b2 = 3 * mt * t * t;
      const b3 = t * t * t;
      const px = b0 * sx + b1 * c1x + b2 * c2x + b3 * ex;
      const py = b0 * sy + b1 * c1y + b2 * c2y + b3 * ey;

      const d0 = 3 * mt * mt;
      const d1 = 6 * mt * t;
      const d2 = 3 * t * t;
      const vx = d0 * (c1x - sx) + d1 * (c2x - c1x) + d2 * (ex - c2x);
      const vy = d0 * (c1y - sy) + d1 * (c2y - c1y) + d2 * (ey - c2y);
      const ang = Math.atan2(vy, vx);
      const altitude = Math.sin(t * Math.PI); // 0 on runway, 1 at cruise apex

      // Ground shadow of aircraft
      const shadowOff = 4 + altitude * 22;
      this.drawAirplaneSilhouette(ctx, px + shadowOff, py + shadowOff, ang, 0.75 + altitude * 0.2, 'rgba(54, 56, 62, 0.18)');

      // Crisp White & Color-Accented Minimalist Aircraft
      this.drawAirplaneSilhouette(ctx, px, py, ang, 0.85 + altitude * 0.35, '#ffffff', '#36383e');
      ctx.restore();
    }
  }

  drawAirplaneSilhouette(ctx, x, y, ang, scale, fill, stroke = null) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.scale(scale, scale);

    ctx.fillStyle = fill;
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.4;
    }

    ctx.beginPath();
    // Minimalist geometric swept-wing jet
    ctx.moveTo(11, 0);
    ctx.lineTo(4, 2.2);
    ctx.lineTo(-2, 10.5);
    ctx.lineTo(-5, 10.5);
    ctx.lineTo(-2.5, 2.2);
    ctx.lineTo(-8.5, 2.0);
    ctx.lineTo(-11, 5.5);
    ctx.lineTo(-12.5, 5.5);
    ctx.lineTo(-11, 0);
    ctx.lineTo(-12.5, -5.5);
    ctx.lineTo(-11, -5.5);
    ctx.lineTo(-8.5, -2.0);
    ctx.lineTo(-2.5, -2.2);
    ctx.lineTo(-5, -10.5);
    ctx.lineTo(-2, -10.5);
    ctx.lineTo(4, -2.2);
    ctx.closePath();
    ctx.fill();
    if (stroke) ctx.stroke();
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
          ctx.fillStyle = score > 0.65
            ? `rgba(16, 185, 129, ${score * 0.55})`
            : `rgba(245, 158, 11, ${score * 0.45})`;
          ctx.fillRect(x * ts, y * ts, ts * 2, ts * 2);
        }
      }
    }

    // 2. Render NIMBY Urban Noise Exclusion Rings around Towns
    for (const t of world.towns) {
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.55)';
      ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
      ctx.lineWidth = 1.8;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(t.x * ts + ts * 0.5, t.y * ts + ts * 0.5, t.urbanRadius * 0.78 * ts, 0, Math.PI * 2);
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
        ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
        ctx.strokeStyle = '#059669';
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
    ctx.fillStyle = 'rgba(34, 197, 94, 0.20)';
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
      ctx.fillStyle = d.zoneType === 'commercial'
        ? 'rgba(59, 130, 246, 0.28)'
        : 'rgba(245, 158, 11, 0.28)';
      ctx.beginPath();
      ctx.roundRect((d.x + 0.5) * ts - zw * 0.5, (d.y + 0.5) * ts - zh * 0.5, zw, zh, 8);
      ctx.fill();
    }
    ctx.restore();
  }

  drawRCICargoChainOverlay(ctx, world, ts) {
    ctx.save();
    const ox = ts * 0.5;
    const oy = ts * 0.5;

    // 1. Draw Active Inter-Industrial Supply Chain Flow Corridors along actual A* Road Paths (`link.points`)
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const link of world.cargoLinks || []) {
      const pts = link.points;
      if (!pts || pts.length < 2) continue;

      // Subtle white halo under freight route
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
      ctx.lineWidth = 4.2;
      ctx.setLineDash([]);
      ctx.beginPath();
      this.traceSmoothPath(ctx, pts, ts);
      ctx.stroke();

      // Colored dashed supply chain corridor
      ctx.strokeStyle = link.color;
      ctx.lineWidth = 2.4;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      this.traceSmoothPath(ctx, pts, ts);
      ctx.stroke();
      ctx.setLineDash([]);

      // Directional chevron arrowhead at the midpoint of the road path
      const midIdx = Math.max(0, Math.min(pts.length - 2, Math.floor(pts.length * 0.5)));
      const p0 = pts[midIdx];
      const p1 = pts[Math.min(pts.length - 1, midIdx + 2)];
      const ax = (p0.x + p1.x) * 0.5 * ts + ox;
      const ay = (p0.y + p1.y) * 0.5 * ts + oy;
      const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(ang);
      ctx.fillStyle = link.color;
      ctx.strokeStyle = '#ffffff';
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
    ctx.font = '800 8.5px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const d of world.destinations) {
      if (d.zoneType === 'industrial') {
        const cx = d.x * ts + ox;
        const cy = d.y * ts + oy - ts * 1.25;
        const tag = d.subType || 'MFG';
        const bg = tag === 'RAW' ? '#d97706' : (tag === 'LOG' ? '#7c3aed' : '#ea580c');
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.roundRect(cx - 13, cy - 6.5, 26, 13, 3.5);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText(tag, cx, cy + 0.5);
      } else if (d.isCircular) {
        const cx = d.x * ts + ox;
        const cy = d.y * ts + oy - ts * 1.25;
        ctx.fillStyle = '#1d4ed8';
        ctx.beginPath();
        ctx.roundRect(cx - 13, cy - 6.5, 26, 13, 3.5);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText('CBD', cx, cy + 0.5);
      }
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
      ctx.font = '800 11px Inter, sans-serif';
      const label = `${t.name} (T${t.tier})`;
      const w = ctx.measureText(label).width + 14;
      ctx.fillStyle = '#36383e';
      ctx.beginPath();
      ctx.roundRect(cx - w * 0.5, cy - 26, w, 20, 6);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, cy - 16);
    }
    ctx.restore();
  }

  drawHydrologyOverlay(ctx, world, ts) {
    ctx.save();
    for (let y = 0; y < world.H; y += 2) {
      for (let x = 0; x < world.W; x += 2) {
        const id = world.idx(x, y);
        if (world.waterMask[id] === 0) {
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
      ctx.strokeStyle = hf.type === 'confluence' ? '#0284c7' : '#0d9488';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, ts * 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  computeRoadGraphDiagnostics(world) {
    if (this._roadDiagWorld === world && this._roadDiagCache) {
      return this._roadDiagCache;
    }

    const { W, H } = world;
    const total = W * H;
    const deg = new Uint8Array(total);
    const hasVertex = new Uint8Array(total);
    const edgeSet = new Set();
    const anomalies = [];

    for (const r of world.roads) {
      if (!r.points || r.points.length < 2) continue;
      for (let i = 0; i < r.points.length; i++) {
        const pt = r.points[i];
        const gx = Math.round(pt.x);
        const gy = Math.round(pt.y);
        if (!world.inBounds(gx, gy, 0)) continue;
        const id = world.idx(gx, gy);
        hasVertex[id] = 1;

        if (world.buildingMask[id] === 1 || world.buildingMask[id] === 2) {
          anomalies.push({ x: gx, y: gy, kind: 'road-building-overlap' });
        }

        if (i < r.points.length - 1) {
          const next = r.points[i + 1];
          const nx = Math.round(next.x);
          const ny = Math.round(next.y);
          if (!world.inBounds(nx, ny, 0)) continue;
          const nid = world.idx(nx, ny);
          const eKey = id < nid ? id * total + nid : nid * total + id;
          if (!edgeSet.has(eKey)) {
            edgeSet.add(eKey);
            deg[id] = Math.min(255, deg[id] + 1);
            deg[nid] = Math.min(255, deg[nid] + 1);
          }

          const dx = nx - gx;
          const dy = ny - gy;
          if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy)) {
            anomalies.push({ x: (gx + nx) * 0.5, y: (gy + ny) * 0.5, kind: 'non-octilinear-edge' });
          }
        }
      }
    }

    let streetTiles = 0;
    let arterialTiles = 0;
    let bridgeTiles = 0;
    let junctionCount = 0;

    for (let id = 0; id < total; id++) {
      const rg = world.roadGrid[id];
      if (rg === 1) streetTiles++;
      else if (rg === 2) arterialTiles++;
      else if (rg === 3) bridgeTiles++;

      if (deg[id] >= 3) junctionCount++;
      if (rg > 0 && hasVertex[id] === 0) {
        anomalies.push({ x: id % W, y: Math.floor(id / W), kind: 'orphan-roadgrid-tile' });
      }
    }

    this._roadDiagWorld = world;
    this._roadDiagCache = {
      deg,
      edgeCount: edgeSet.size,
      streetTiles,
      arterialTiles,
      bridgeTiles,
      junctionCount,
      anomalies
    };
    return this._roadDiagCache;
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
          ctx.fillStyle = bm === 1 ? 'rgba(22, 163, 74, 0.14)' : 'rgba(37, 99, 235, 0.16)';
          ctx.fillRect(x * ts + 0.5, y * ts + 0.5, ts - 1, ts - 1);
        } else if (bm === 4 && rg === 0) {
          ctx.fillStyle = 'rgba(139, 92, 246, 0.10)';
          ctx.fillRect(x * ts + 0.5, y * ts + 0.5, ts - 1, ts - 1);
        }

        if (rg > 0) {
          if (rg === 1) {
            ctx.fillStyle = 'rgba(14, 165, 233, 0.30)';
            ctx.strokeStyle = 'rgba(2, 132, 199, 0.55)';
          } else if (rg === 2) {
            ctx.fillStyle = 'rgba(245, 158, 11, 0.36)';
            ctx.strokeStyle = 'rgba(217, 119, 6, 0.65)';
          } else if (rg === 3) {
            ctx.fillStyle = 'rgba(6, 182, 212, 0.44)';
            ctx.strokeStyle = 'rgba(8, 145, 178, 0.75)';
          } else {
            ctx.fillStyle = 'rgba(139, 92, 246, 0.34)';
            ctx.strokeStyle = 'rgba(109, 40, 217, 0.65)';
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

    // 1. Driveway Frontage Links (`lotX, lotY -> roadX, roadY`)
    ctx.strokeStyle = 'rgba(22, 163, 74, 0.65)';
    ctx.lineWidth = 1.3;
    ctx.setLineDash([2.5, 2.5]);
    ctx.beginPath();
    for (const h of world.houses) {
      ctx.moveTo(h.x * ts + ox, h.y * ts + oy);
      ctx.lineTo(h.roadX * ts + ox, h.roadY * ts + oy);
    }
    for (const d of world.destinations) {
      const lx = d.lotX ?? d.x;
      const ly = d.lotY ?? d.y;
      ctx.moveTo(lx * ts + ox, ly * ts + oy);
      ctx.lineTo(d.roadX * ts + ox, d.roadY * ts + oy);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // 2. Vector Road Polylines (`world.roads`)
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const r of world.roads) {
      if (!r.points || r.points.length < 2) continue;
      ctx.strokeStyle = r.type === 'street' ? '#0284c7' : (r.type === 'airport-spine' ? '#7c3aed' : '#ea580c');
      ctx.lineWidth = r.type === 'street' ? 1.8 : 2.5;
      ctx.beginPath();
      ctx.moveTo(r.points[0].x * ts + ox, r.points[0].y * ts + oy);
      for (let i = 1; i < r.points.length; i++) {
        ctx.lineTo(r.points[i].x * ts + ox, r.points[i].y * ts + oy);
      }
      ctx.stroke();
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
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#dc2626';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.arc(px, py, 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (d === 1) {
          ctx.fillStyle = '#475569';
          ctx.beginPath();
          ctx.arc(px, py, 2.2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = '#0f172a';
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
      ctx.strokeStyle = '#e11d48';
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
    const drawerEl = typeof document !== 'undefined' ? document.getElementById('generatorDrawer') : null;
    const drawerOpen = canvas.width >= 640 && drawerEl && !drawerEl.classList.contains('hidden');
    const leftSafe = drawerOpen ? 412 : 14;
    const boxW = Math.min(canvas.width - leftSafe - 14, 790);
    const boxH = 38;
    const bx = leftSafe;
    const by = canvas.height - boxH - 14;

    ctx.fillStyle = 'rgba(248, 246, 241, 0.94)';
    ctx.strokeStyle = 'rgba(54, 56, 62, 0.18)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 11);
    ctx.fill();
    ctx.stroke();

    const anomCount = diag.anomalies.length;
    const items = [
      { col: '#0284c7', label: `Street Tiles (${diag.streetTiles})` },
      { col: '#ea580c', label: `Arterial Tiles (${diag.arterialTiles})` },
      { col: '#0891b2', label: `Bridge Tiles (${diag.bridgeTiles})` },
      { col: '#334155', label: `Vector Edges (${diag.edgeCount})` },
      { col: '#dc2626', label: `Junctions deg≥3 (${diag.junctionCount})` },
      { col: anomCount === 0 ? '#16a34a' : '#e11d48', label: `Anomalies (${anomCount})` }
    ];

    ctx.font = '700 11px Inter, sans-serif';
    ctx.textBaseline = 'middle';
    let curX = bx + 14;
    const midY = by + boxH * 0.5;
    for (const it of items) {
      if (curX + 95 > bx + boxW) break;
      ctx.fillStyle = it.col;
      ctx.beginPath();
      ctx.arc(curX + 4, midY, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#36383e';
      ctx.fillText(it.label, curX + 13, midY + 0.5);
      curX += ctx.measureText(it.label).width + 28;
    }
    ctx.restore();
  }

  drawSelectionHighlight(ctx, entity, ts) {
    const cx = entity.x * ts + ts * 0.5;
    const cy = entity.y * ts + ts * 0.5;
    const rad = (entity.urbanRadius ? entity.urbanRadius * 0.85 : entity.halfLen + 2) * ts;

    ctx.save();
    ctx.strokeStyle = '#36383e';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
