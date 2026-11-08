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

    // 2. Optional Diagnostic Overlay Underneath Roads/Buildings (Hydrology / Airport Heatmap / RCI Zones)
    if (this.activeLayer === 'hydrology') {
      this.drawHydrologyOverlay(ctx, world, ts);
    } else if (this.activeLayer === 'airport') {
      this.drawAirportSolverOverlay(ctx, world, ts);
    } else if (this.activeLayer === 'rci') {
      this.drawRCIZoneUnderlay(ctx, world, ts);
    }

    // 3. Draw Driveways & Road Network (Grey Casing + Crisp White Asphalt + Bridges)
    this.drawRoadNetwork(ctx, world, ts);

    // 4. Draw Houses & Differentiated Commercial / Industrial Sinks (with 45° Drop Shadows & Demand Pins)
    this.drawBuildings(ctx, world, ts);

    // 5. Draw Airports (Apron, Runway Markings, Terminal Building, Control Tower & Windsock)
    this.drawAirports(ctx, world, ts);

    // 6. Draw Live Ground Vehicles (Commuter Cars + Articulated Freight Trucks)
    this.drawCars(ctx, world, sim, ts);

    // 7. Draw Sweeping Pink Numbered Motorways Overpasses ([1], [2], [3])
    this.drawMotorways(ctx, world, ts);

    // 8. Draw Central Place Hierarchy or RCI Cargo Chain Overlay if active
    if (this.activeLayer === 'hierarchy') {
      this.drawHierarchyOverlay(ctx, world, ts);
    } else if (this.activeLayer === 'rci') {
      this.drawRCICargoChainOverlay(ctx, world, ts);
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
    }
  }

  drawRCIScreenLegend(ctx, world, canvas) {
    const comCount = world.destinations.filter(d => d.zoneType === 'commercial').length;
    const rawCount = world.destinations.filter(d => d.zoneType === 'industrial' && d.subType === 'RAW').length;
    const mfgCount = world.destinations.filter(d => d.zoneType === 'industrial' && d.subType === 'MFG').length;
    const logCount = world.destinations.filter(d => d.zoneType === 'industrial' && d.subType === 'LOG').length;

    ctx.save();
    const boxW = Math.min(canvas.width - 28, 745);
    const boxH = 38;
    const bx = 14;
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

  drawRoadNetwork(ctx, world, ts) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Pass A: House & Destination Driveways
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

    // Pass B: Road Outer Casing (Grey)
    for (const r of world.roads) {
      if (r.points.length < 2) continue;
      ctx.strokeStyle = PALETTE.roadCasing;
      ctx.lineWidth = r.type === 'street' ? ts * 0.58 : (r.type === 'airport-loop' ? ts * 0.66 : ts * 0.74);
      this.traceSmoothPath(ctx, r.points, ts);
      ctx.stroke();
    }

    // Pass C: Bridge Dark Guardrails Over Water (butt-capped so rails terminate flush at the shoreline)
    ctx.lineCap = 'butt';
    for (const r of world.roads) {
      ctx.strokeStyle = PALETTE.bridgeRail;
      ctx.lineWidth = ts * 0.88;
      ctx.beginPath();
      for (let i = 0; i < r.points.length - 1; i++) {
        if (r.points[i].isBridge || r.points[i + 1].isBridge) {
          ctx.moveTo(r.points[i].x * ts + ts * 0.5, r.points[i].y * ts + ts * 0.5);
          ctx.lineTo(r.points[i + 1].x * ts + ts * 0.5, r.points[i + 1].y * ts + ts * 0.5);
        }
      }
      ctx.stroke();
    }
    ctx.lineCap = 'round';

    // Pass D: Crisp White Road Asphalt Fill (both Houses AND Destinations!)
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
      if (r.points.length < 2) continue;
      ctx.strokeStyle = PALETTE.roadAsphalt;
      ctx.lineWidth = r.type === 'street' ? ts * 0.42 : (r.type === 'airport-loop' ? ts * 0.48 : ts * 0.56);
      this.traceSmoothPath(ctx, r.points, ts);
      ctx.stroke();
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

      // 1. Airport Perimeter Concrete Apron Pad
      ctx.fillStyle = '#e5e2dc';
      ctx.strokeStyle = '#b6b4ae';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(-padLen * 0.5, -padWid * 0.5, padLen, padWid, 11);
      ctx.fill();
      ctx.stroke();

      // 1B. Landside Curbside Terminal Loop Road & Access Avenue Stub (drawn on top of pad)
      const loopHalfW = (ap.isHub ? 3.0 : 2.1) * ts;
      const loopInnerY = side * (ap.isHub ? 2.05 : 1.60) * ts;
      const loopOuterY = side * (ap.isHub ? 3.45 : 2.65) * ts;
      const loopTopY = Math.min(loopInnerY, loopOuterY);
      const loopBoxH = Math.abs(loopOuterY - loopInnerY);
      const stubEndY = side * (ap.stubDist || (ap.isHub ? 5.8 : 4.6)) * ts;

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const [stroke, lw] of [[PALETTE.roadCasing, ts * 0.58], [PALETTE.roadAsphalt, ts * 0.40]]) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.roundRect(-loopHalfW, loopTopY, loopHalfW * 2, loopBoxH, loopBoxH * 0.48);
        ctx.moveTo(0, loopOuterY);
        ctx.lineTo(0, stubEndY);
        ctx.stroke();
      }

      // Short-Term Parking & Transit Plaza Island inside the Curbside Loop
      const plazaMidY = (loopInnerY + loopOuterY) * 0.5;
      const plazaW = loopHalfW * 1.22;
      const plazaH = Math.max(ts * 0.45, loopBoxH * 0.45);
      ctx.fillStyle = '#d8d5ce';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(-plazaW * 0.5, plazaMidY - plazaH * 0.5, plazaW, plazaH, 4);
      ctx.fill();
      ctx.stroke();

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

      // Floating Minimalist IATA & Tier Pill Tag
      ctx.save();
      ctx.font = '800 10px Inter, sans-serif';
      const badgePrefix = ap.airportClass === 'HUB' ? '✈ HUB' : (ap.airportClass === 'CRG' ? '📦 CRG' : '✈ REG');
      const tagText = `${badgePrefix} • ${ap.iata}`;
      const tw = ctx.measureText(tagText).width + 14;
      ctx.fillStyle = ap.isHub ? '#e85c90' : '#36383e';
      ctx.beginPath();
      ctx.roundRect(cx - tw * 0.5, cy - ts * (ap.isHub ? 3.2 : 2.5), tw, 18, 9);
      ctx.fill();
      ctx.fillStyle = '#f2efe9';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tagText, cx, cy - ts * (ap.isHub ? 3.2 : 2.5) + 9);
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

        // 1. Two Smooth Curved Bezier Slip-Ramps Peeling Tangentially Off the Outer Deck Edge
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

        // 2. Single Crisp Surface Roundabout Ring at the Connected Stub Terminal
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#36383e';
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.arc(0, sySign * across, ts * 0.34, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
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

      // Grade-Separated Roundabout Interchange Rings at non-pruned Street-Stub Terminations
      const termEndpoints = [];
      if (!mw.prunedStart) termEndpoints.push([sx, sy]);
      if (!mw.prunedEnd) termEndpoints.push([ex, ey]);
      for (const [rx, ry] of termEndpoints) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#36383e';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(rx, ry, ts * 0.44, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
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
        const span = ts * 1.15;
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

  drawCars(ctx, world, sim, ts) {
    const ox = ts * 0.5;
    const oy = ts * 0.5;

    for (const car of sim.cars) {
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
        const p0 = car.road.points[car.segIdx];
        const p1 = car.road.points[car.segIdx + 1];
        if (!p0 || !p1) continue;
        const t = car.dir > 0 ? car.segT : 1 - car.segT;
        x = (p0.x + (p1.x - p0.x) * t) * ts + ox;
        y = (p0.y + (p1.y - p0.y) * t) * ts + oy;
        ang = Math.atan2((p1.y - p0.y) * car.dir, (p1.x - p0.x) * car.dir);
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
