/** @import { BakeHydroPayload, BakeComposePayload } from './types.js' */
import { PALETTE } from "./palette.js";

/**
 * @param {number} width
 * @param {number} height
 * @returns {OffscreenCanvas | HTMLCanvasElement}
 */
function createSurface(width, height) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

export class TerrainBitmapBaker {
  constructor() {
    /** @type {number} */
    this._cachedHydroVersion = -1;
    /** @type {ImageBitmap | OffscreenCanvas | HTMLCanvasElement | null} */
    this._hydroBaseBitmap = null;
    /** @type {ImageBitmap | OffscreenCanvas | HTMLCanvasElement | null} */
    this._waterOverlayBitmap = null;
  }

  /**
   * @param {number} W
   * @param {number} H
   * @param {Uint8Array} waterMask
   * @param {Float32Array} elevationField
   * @param {number} ts
   * @param {number | null} [thresh]
   * @param {Path2D | null} [outStrokePath]
   * @returns {Path2D}
   */
  buildVignelliWaterPath(
    W,
    H,
    waterMask,
    elevationField,
    ts,
    thresh = null,
    outStrokePath = null,
  ) {
    const path = new Path2D();
    const gw = W + 2;
    const gh = H + 2;
    const flags = new Uint8Array(gw * gh);

    for (let gy = 0; gy < gh; gy++) {
      const cy = Math.max(0, Math.min(H - 1, gy - 1));
      const rowOff = gy * gw;
      const wRowOff = cy * W;
      if (thresh !== null) {
        for (let gx = 0; gx < gw; gx++) {
          const cx = Math.max(0, Math.min(W - 1, gx - 1));
          const id = wRowOff + cx;
          flags[rowOff + gx] =
            waterMask[id] === 0 && elevationField[id] >= thresh ? 1 : 0;
        }
      } else {
        for (let gx = 0; gx < gw; gx++) {
          const cx = Math.max(0, Math.min(W - 1, gx - 1));
          flags[rowOff + gx] = waterMask[wRowOff + cx] === 2 ? 1 : 0;
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

    for (let y = -1; y < H; y++) {
      const r0 = (y + 1) * gw;
      const r1 = (y + 2) * gw;
      const y0 = (y + 0.5) * ts;
      const y1 = (y + 1.5) * ts;
      const ym = (y + 1.0) * ts;
      let runStart = null;

      for (let x = -1; x < W; x++) {
        const c = x + 1;
        const mask =
          (flags[r0 + c] << 3) |
          (flags[r0 + c + 1] << 2) |
          (flags[r1 + c + 1] << 1) |
          flags[r1 + c];

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
          case 1:
            poly([
              [x0, ym],
              [xm, y1],
              [x0, y1],
            ]);
            seg(x0, ym, xm, y1);
            break;
          case 2:
            poly([
              [xm, y1],
              [x1, ym],
              [x1, y1],
            ]);
            seg(xm, y1, x1, ym);
            break;
          case 4:
            poly([
              [xm, y0],
              [x1, y0],
              [x1, ym],
            ]);
            seg(xm, y0, x1, ym);
            break;
          case 8:
            poly([
              [x0, y0],
              [xm, y0],
              [x0, ym],
            ]);
            seg(x0, ym, xm, y0);
            break;
          case 3:
            poly([
              [x0, ym],
              [x1, ym],
              [x1, y1],
              [x0, y1],
            ]);
            seg(x0, ym, x1, ym);
            break;
          case 6:
            poly([
              [xm, y0],
              [x1, y0],
              [x1, y1],
              [xm, y1],
            ]);
            seg(xm, y0, xm, y1);
            break;
          case 9:
            poly([
              [x0, y0],
              [xm, y0],
              [xm, y1],
              [x0, y1],
            ]);
            seg(xm, y0, xm, y1);
            break;
          case 12:
            poly([
              [x0, y0],
              [x1, y0],
              [x1, ym],
              [x0, ym],
            ]);
            seg(x0, ym, x1, ym);
            break;
          case 5:
            poly([
              [x0, ym],
              [xm, y0],
              [x1, y0],
              [x1, ym],
              [xm, y1],
              [x0, y1],
            ]);
            seg(x0, ym, xm, y0);
            seg(xm, y1, x1, ym);
            break;
          case 10:
            poly([
              [x0, y0],
              [xm, y0],
              [x1, ym],
              [x1, y1],
              [xm, y1],
              [x0, ym],
            ]);
            seg(xm, y0, x1, ym);
            seg(x0, ym, xm, y1);
            break;
          case 7:
            poly([
              [x0, ym],
              [xm, y0],
              [x1, y0],
              [x1, y1],
              [x0, y1],
            ]);
            seg(x0, ym, xm, y0);
            break;
          case 11:
            poly([
              [x0, y0],
              [xm, y0],
              [x1, ym],
              [x1, y1],
              [x0, y1],
            ]);
            seg(xm, y0, x1, ym);
            break;
          case 13:
            poly([
              [x0, y0],
              [x1, y0],
              [x1, ym],
              [xm, y1],
              [x0, y1],
            ]);
            seg(xm, y1, x1, ym);
            break;
          case 14:
            poly([
              [x0, y0],
              [x1, y0],
              [x1, y1],
              [xm, y1],
              [x0, ym],
            ]);
            seg(x0, ym, xm, y1);
            break;
        }
      }
      if (runStart !== null) {
        path.rect((runStart + 0.5) * ts, y0, (W - runStart) * ts, ts);
      }
    }
    return path;
  }

  /**
   * Runs on Core 2 immediately after Stage 2B (~65ms into build) while `world-worker.js`
   * computes Stages 3–9 on Core 1. Eagerly flushes `_hydroBaseBitmap` and `_waterOverlayBitmap`
   * via `transferToImageBitmap()` so Skia rasterizes both layers in parallel on Core 2!
   * @param {BakeHydroPayload} payload
   */
  prepareHydroLayers({
    hydroVersion,
    W,
    H,
    tileSize,
    seaLevel,
    elevationField,
    waterMask,
    rivers,
  }) {
    if (
      this._cachedHydroVersion === hydroVersion &&
      this._hydroBaseBitmap &&
      this._waterOverlayBitmap
    ) {
      return;
    }
    const ts = tileSize;
    const pw = W * ts;
    const ph = H * ts;

    // 1. Base Hypsometric Paper & Contour Layer (`_hydroBaseBitmap`)
    const baseCanvas = createSurface(pw, ph);
    const bCtx = baseCanvas.getContext("2d");
    bCtx.fillStyle = PALETTE.bgPaper;
    bCtx.fillRect(0, 0, pw, ph);

    bCtx.strokeStyle = PALETTE.gridLine;
    bCtx.lineWidth = 1;
    const gridStep = ts * 4;
    bCtx.beginPath();
    for (let x = 0; x <= pw; x += gridStep) {
      bCtx.moveTo(x, 0);
      bCtx.lineTo(x, ph);
    }
    for (let y = 0; y <= ph; y += gridStep) {
      bCtx.moveTo(0, y);
      bCtx.lineTo(pw, y);
    }
    bCtx.stroke();

    const contourTerraces = [
      { dh: 0.13, fill: "#ebe7de", stroke: "#dfdace" },
      { dh: 0.24, fill: "#e3ded2", stroke: "#d5cfc0" },
      { dh: 0.36, fill: "#dad4c5", stroke: "#cac3b2" },
    ];
    bCtx.save();
    bCtx.lineJoin = "bevel";
    bCtx.lineWidth = 1.2;
    for (const { dh, fill, stroke } of contourTerraces) {
      const thresh = seaLevel + dh;
      const cEdgePath = new Path2D();
      const cPath = this.buildVignelliWaterPath(
        W,
        H,
        waterMask,
        elevationField,
        ts,
        thresh,
        cEdgePath,
      );
      bCtx.fillStyle = fill;
      bCtx.fill(cPath);
      bCtx.strokeStyle = stroke;
      bCtx.stroke(cEdgePath);
    }
    bCtx.restore();

    // 2. Open-Water Basin & Tapering River Overlay Layer (`_waterOverlayBitmap`)
    const waterCanvas = createSurface(pw, ph);
    const wCtx = waterCanvas.getContext("2d");

    const waterEdgePath = new Path2D();
    const waterPath = this.buildVignelliWaterPath(
      W,
      H,
      waterMask,
      elevationField,
      ts,
      null,
      waterEdgePath,
    );

    wCtx.save();
    wCtx.lineCap = "butt";
    wCtx.lineJoin = "bevel";
    wCtx.strokeStyle = PALETTE.bgPaper;
    wCtx.lineWidth = ts * 1.45;
    wCtx.stroke(waterEdgePath);
    wCtx.fillStyle = PALETTE.bgPaper;
    wCtx.fill(waterPath);

    wCtx.lineCap = "round";
    wCtx.lineJoin = "round";
    for (const pass of ["bank", "water"]) {
      wCtx.strokeStyle = pass === "bank" ? PALETTE.bgPaper : PALETTE.waterCyan;
      const bankExtra = pass === "bank" ? ts * 1.15 : 0;
      for (const rObj of rivers) {
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
          const w = p1.width ?? startW + (endW - startW) * Math.pow(frac, 0.9);
          wCtx.lineWidth = ts * w + bankExtra;
          wCtx.beginPath();
          const x0 =
            i === 0 ? (p0.x + 0.5) * ts : ((p0.x + p1.x) * 0.5 + 0.5) * ts;
          const y0 =
            i === 0 ? (p0.y + 0.5) * ts : ((p0.y + p1.y) * 0.5 + 0.5) * ts;
          const x1 = (p1.x + 0.5) * ts;
          const y1 = (p1.y + 0.5) * ts;
          const x2 =
            i === pts.length - 2
              ? (p1.x + 0.5) * ts
              : ((p1.x + p2.x) * 0.5 + 0.5) * ts;
          const y2 =
            i === pts.length - 2
              ? (p1.y + 0.5) * ts
              : ((p1.y + p2.y) * 0.5 + 0.5) * ts;
          wCtx.moveTo(x0, y0);
          wCtx.quadraticCurveTo(x1, y1, x2, y2);
          wCtx.stroke();
        }
      }
    }

    wCtx.fillStyle = PALETTE.waterCyan;
    wCtx.fill(waterPath);
    wCtx.restore();

    if (
      this._hydroBaseBitmap &&
      "close" in this._hydroBaseBitmap &&
      typeof this._hydroBaseBitmap.close === "function"
    ) {
      this._hydroBaseBitmap.close();
    }
    if (
      this._waterOverlayBitmap &&
      "close" in this._waterOverlayBitmap &&
      typeof this._waterOverlayBitmap.close === "function"
    ) {
      this._waterOverlayBitmap.close();
    }

    this._hydroBaseBitmap =
      "transferToImageBitmap" in baseCanvas
        ? baseCanvas.transferToImageBitmap()
        : baseCanvas;
    this._waterOverlayBitmap =
      "transferToImageBitmap" in waterCanvas
        ? waterCanvas.transferToImageBitmap()
        : waterCanvas;
    this._cachedHydroVersion = hydroVersion;
  }

  /**
   * Composites pre-rasterized `_hydroBaseBitmap` + `urbanBlushPink` + `_waterOverlayBitmap` + batched `trees`
   * onto a single staging OffscreenCanvas and transfers the resulting `ImageBitmap`.
   * @param {BakeComposePayload} payload
   * @returns {{ bitmap: ImageBitmap | OffscreenCanvas | HTMLCanvasElement, bakeTimeMs: number }}
   */
  composeTerrainBitmap({ W, H, tileSize, zoneColorIdx, trees }) {
    const t0 = performance.now();
    const ts = tileSize;
    const pw = W * ts;
    const ph = H * ts;

    const staging = createSurface(pw, ph);
    const ctx = staging.getContext("2d");
    ctx.drawImage(this._hydroBaseBitmap, 0, 0);

    ctx.fillStyle = PALETTE.urbanBlushPink;
    ctx.beginPath();
    for (let y = 0; y < H; y += 2) {
      const rowOff = y * W;
      for (let x = 0; x < W; x += 2) {
        if (zoneColorIdx[rowOff + x] >= 0) {
          ctx.moveTo((x + 4.5) * ts, (y + 1) * ts);
          ctx.arc((x + 1) * ts, (y + 1) * ts, 3.5 * ts, 0, Math.PI * 2);
        }
      }
    }
    ctx.fill();

    ctx.drawImage(this._waterOverlayBitmap, 0, 0);

    ctx.fillStyle = "rgba(186, 208, 181, 0.28)";
    ctx.beginPath();
    for (let i = 0; i < trees.length; i += 2) {
      const tree = trees[i];
      const tx = tree.x * ts;
      const ty = tree.y * ts;
      const tr = tree.r * ts * 2.15;
      ctx.moveTo(tx + tr, ty);
      ctx.arc(tx, ty, tr, 0, Math.PI * 2);
    }
    ctx.fill();

    ctx.fillStyle = "rgba(54, 56, 62, 0.1)";
    ctx.beginPath();
    for (const tree of trees) {
      const tx = tree.x * ts + 2.5;
      const ty = tree.y * ts + 2.5;
      const tr = tree.r * ts;
      ctx.moveTo(tx + tr, ty);
      ctx.arc(tx, ty, tr, 0, Math.PI * 2);
    }
    ctx.fill();

    for (const color of PALETTE.treeDots) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const tree of trees) {
        if (tree.color !== color) continue;
        const tx = tree.x * ts;
        const ty = tree.y * ts;
        const tr = tree.r * ts;
        ctx.moveTo(tx + tr, ty);
        ctx.arc(tx, ty, tr, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    const bitmap =
      "transferToImageBitmap" in staging
        ? staging.transferToImageBitmap()
        : staging;
    const bakeTimeMs = Number((performance.now() - t0).toFixed(1));
    return { bitmap, bakeTimeMs };
  }
}

if (
  typeof self !== "undefined" &&
  typeof self.addEventListener === "function" &&
  typeof document === "undefined"
) {
  const workerSelf = /** @type {DedicatedWorkerGlobalScope} */ (
    /** @type {unknown} */ (self)
  );
  const baker = new TerrainBitmapBaker();

  /** @param {MessagePort} port */
  const attachPort = (port) => {
    port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === "prepareHydro") {
        baker.prepareHydroLayers(msg);
      } else if (msg.type === "composeTerrain") {
        if (msg.hydroPayload) {
          baker.prepareHydroLayers(msg.hydroPayload);
        }
        const { bitmap, bakeTimeMs } = baker.composeTerrainBitmap(msg);
        const transfer =
          typeof ImageBitmap !== "undefined" && bitmap instanceof ImageBitmap
            ? [bitmap]
            : [];
        port.postMessage(
          {
            type: "terrainReady",
            requestId: msg.requestId,
            bitmap,
            bakeTimeMs,
          },
          transfer,
        );
      }
    };
  };

  workerSelf.addEventListener("message", (event) => {
    if (event.data?.type === "connectPort" && event.ports?.[0]) {
      attachPort(event.ports[0]);
    }
  });
}
