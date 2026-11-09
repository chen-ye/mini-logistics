/**
 * Declarative Canvas2D Vector Display-List Recorder (`VectorLayerRecorder`)
 * and Octilinear Marching-Squares / Vector Terrain Polygonizers.
 *
 * Coalesces fine-grained Canvas2D path operations (`beginPath`, `moveTo`, `lineTo`,
 * `arc`, `rect`, `roundRect`, `fillRect`, `strokeRect`, `translate`, `rotate`, `scale`)
 * into style-batched native C++ `Path2D` objects via `Path2D.prototype.addPath(subPath, domMatrix)`.
 *
 * Preserves painter's-order invariants across explicit z-barriers (`nextLayerPass()`)
 * and intra-pass vertical sub-layers (`setSubLayer(index)`).
 *
 * @import { RiverRibbon, TreeDot } from "./types.js"
 */
import { PALETTE } from "./palette.js";
import { WATER_MASK, WORLD_GEOMETRY } from "./constants.js";

const HasNativePath2D = typeof Path2D !== "undefined";
const HasNativeDOMMatrix = typeof DOMMatrix !== "undefined";

/**
 * Lightweight fallback Path2D used only when running inside headless CLI/unit-test
 * environments (such as `bun test` or `scripts/bench.js`) where browser `Path2D` is absent.
 */
class HeadlessPath2D {
  constructor() {
    this.ops = 0;
  }
  /**
   * @param {HeadlessPath2D} [other]
   */
  addPath(other) {
    this.ops += (other?.ops || 0) + 1;
  }
  moveTo() {
    this.ops++;
  }
  lineTo() {
    this.ops++;
  }
  quadraticCurveTo() {
    this.ops++;
  }
  bezierCurveTo() {
    this.ops++;
  }
  arc() {
    this.ops++;
  }
  rect() {
    this.ops++;
  }
  roundRect() {
    this.ops++;
  }
  closePath() {
    this.ops++;
  }
}

export const Path2DCtor = /** @type {typeof Path2D} */ (
  HasNativePath2D ? Path2D : /** @type {unknown} */ (HeadlessPath2D)
);

/** @type {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null} */
let sharedMeasureCtx = null;

/**
 * @param {string} font
 * @param {string} text
 * @returns {{ width: number }}
 */
function measureTextFallback(font, text) {
  if (!sharedMeasureCtx) {
    if (typeof OffscreenCanvas !== "undefined") {
      sharedMeasureCtx = new OffscreenCanvas(1, 1).getContext("2d");
    } else if (typeof document !== "undefined") {
      const c = document.createElement("canvas");
      c.width = 1;
      c.height = 1;
      sharedMeasureCtx = c.getContext("2d");
    }
  }
  if (sharedMeasureCtx) {
    sharedMeasureCtx.font = font;
    return sharedMeasureCtx.measureText(text);
  }
  const sizeMatch = /(\d+(?:\.\d+)?)px/.exec(font);
  const px = sizeMatch ? parseFloat(sizeMatch[1]) : 10;
  return { width: text.length * px * 0.58 };
}

/**
 * @typedef {Object} TransformState
 * @property {number} a
 * @property {number} b
 * @property {number} c
 * @property {number} d
 * @property {number} e
 * @property {number} f
 * @property {boolean} isIdentity
 * @property {DOMMatrix | DOMMatrix2DInit | null} matrixObj
 */

/**
 * @typedef {Object} ClipSpec
 * @property {Path2D} path
 * @property {CanvasFillRule} fillRule
 */

/**
 * @typedef {Object} DrawBucket
 * @property {"fill" | "stroke"} op
 * @property {Path2D} path
 * @property {string} fillStyle
 * @property {CanvasFillRule} fillRule
 * @property {string} strokeStyle
 * @property {number} lineWidth
 * @property {CanvasLineCap} lineCap
 * @property {CanvasLineJoin} lineJoin
 * @property {number[]} lineDash
 * @property {string} dashKey
 */

/**
 * @typedef {Object} TextCommand
 * @property {string} text
 * @property {number} x
 * @property {number} y
 * @property {string} font
 * @property {string} fillStyle
 * @property {CanvasTextAlign} textAlign
 * @property {CanvasTextBaseline} textBaseline
 */

/**
 * @typedef {Object} LayerPass
 * @property {number} clipId
 * @property {ClipSpec[]} clips
 * @property {Array<Map<string, DrawBucket>>} subLayerMaps
 * @property {Array<DrawBucket[]>} subLayers
 * @property {TextCommand[]} texts
 */

export class VectorLayerRecorder {
  constructor() {
    /** @type {string} */
    this.fillStyle = "#000000";
    /** @type {string} */
    this.strokeStyle = "#000000";
    /** @type {number} */
    this.lineWidth = 1;
    /** @type {CanvasLineCap} */
    this.lineCap = "butt";
    /** @type {CanvasLineJoin} */
    this.lineJoin = "miter";
    /** @type {string} */
    this.font = "10px sans-serif";
    /** @type {CanvasTextAlign} */
    this.textAlign = "start";
    /** @type {CanvasTextBaseline} */
    this.textBaseline = "alphabetic";

    /** @type {number[]} */
    this._lineDash = [];
    /** @type {string} */
    this._dashKey = "";

    /** @type {TransformState} */
    this._xf = {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
      isIdentity: true,
      matrixObj: null,
    };

    /** @type {number} */
    this._clipCounter = 0;
    /** @type {number} */
    this._activeClipId = 0;
    /** @type {ClipSpec[]} */
    this._activeClips = [];

    /**
     * @type {Array<{
     *   fillStyle: string,
     *   strokeStyle: string,
     *   lineWidth: number,
     *   lineCap: CanvasLineCap,
     *   lineJoin: CanvasLineJoin,
     *   font: string,
     *   textAlign: CanvasTextAlign,
     *   textBaseline: CanvasTextBaseline,
     *   lineDash: number[],
     *   dashKey: string,
     *   xf: TransformState,
     *   clipId: number,
     *   clips: ClipSpec[],
     *   subLayer: number
     * }>}
     */
    this._stack = [];

    /** @type {Path2D} */
    this._subPath = new Path2DCtor();
    /** @type {number} */
    this._currentSubLayer = 0;
    /** @type {LayerPass[]} */
    this._passes = [];
    /** @type {LayerPass} */
    this._currentPass = this._createPass();
    this._passes.push(this._currentPass);
  }

  /**
   * @returns {LayerPass}
   */
  _createPass() {
    return {
      clipId: this._activeClipId,
      clips: this._activeClips.slice(),
      subLayerMaps: [new Map()],
      subLayers: [[]],
      texts: [],
    };
  }

  /**
   * Inserts an explicit z-order barrier so all subsequent draw calls render
   * strictly above all previously recorded draw calls.
   */
  nextLayerPass() {
    this._currentSubLayer = 0;
    const cur = this._currentPass;
    const isEmpty =
      cur.texts.length === 0 &&
      cur.subLayers.every((buckets) => !buckets || buckets.length === 0);
    if (isEmpty) {
      cur.clipId = this._activeClipId;
      cur.clips = this._activeClips.slice();
      return;
    }
    this._currentPass = this._createPass();
    this._passes.push(this._currentPass);
  }

  /**
   * Selects a vertical sub-layer slot (`0, 1, 2, ...`) within the current pass.
   * Allows a single entity loop (e.g., houses or buildings) to record shadows into
   * slot 0, bases into slot 1, and roofs into slot 2 without breaking batching.
   *
   * @param {number} subLayerIdx
   */
  setSubLayer(subLayerIdx) {
    this._currentSubLayer = subLayerIdx;
    const pass = this._currentPass;
    while (pass.subLayers.length <= subLayerIdx) {
      pass.subLayerMaps.push(new Map());
      pass.subLayers.push([]);
    }
  }

  /**
   * Ensures the current pass matches the active clip state.
   */
  _syncClipPass() {
    if (this._currentPass.clipId === this._activeClipId) return;
    const savedSubLayer = this._currentSubLayer;
    this.nextLayerPass();
    this.setSubLayer(savedSubLayer);
  }

  /**
   * @returns {DOMMatrix | DOMMatrix2DInit}
   */
  _getMatrixObj() {
    const xf = this._xf;
    if (!xf.matrixObj) {
      xf.matrixObj = HasNativeDOMMatrix
        ? new DOMMatrix([xf.a, xf.b, xf.c, xf.d, xf.e, xf.f])
        : { a: xf.a, b: xf.b, c: xf.c, d: xf.d, e: xf.e, f: xf.f };
    }
    return xf.matrixObj;
  }

  /**
   * @param {Path2D} targetPath
   * @param {Path2D} sourcePath
   */
  _appendTransformedPath(targetPath, sourcePath) {
    if (this._xf.isIdentity) {
      targetPath.addPath(sourcePath);
    } else {
      targetPath.addPath(sourcePath, this._getMatrixObj());
    }
  }

  save() {
    this._stack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      lineDash: this._lineDash,
      dashKey: this._dashKey,
      xf: { ...this._xf },
      clipId: this._activeClipId,
      clips: this._activeClips.slice(),
      subLayer: this._currentSubLayer,
    });
  }

  restore() {
    const st = this._stack.pop();
    if (!st) return;
    this.fillStyle = st.fillStyle;
    this.strokeStyle = st.strokeStyle;
    this.lineWidth = st.lineWidth;
    this.lineCap = st.lineCap;
    this.lineJoin = st.lineJoin;
    this.font = st.font;
    this.textAlign = st.textAlign;
    this.textBaseline = st.textBaseline;
    this._lineDash = st.lineDash;
    this._dashKey = st.dashKey;
    this._xf = st.xf;
    this._activeClipId = st.clipId;
    this._activeClips = st.clips;
    this.setSubLayer(st.subLayer);
  }

  /**
   * @param {number} tx
   * @param {number} ty
   */
  translate(tx, ty) {
    if (tx === 0 && ty === 0) return;
    const xf = this._xf;
    xf.e += xf.a * tx + xf.c * ty;
    xf.f += xf.b * tx + xf.d * ty;
    xf.isIdentity =
      xf.a === 1 &&
      xf.b === 0 &&
      xf.c === 0 &&
      xf.d === 1 &&
      xf.e === 0 &&
      xf.f === 0;
    xf.matrixObj = null;
  }

  /**
   * @param {number} angleRad
   */
  rotate(angleRad) {
    if (angleRad === 0) return;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const xf = this._xf;
    const a = xf.a;
    const b = xf.b;
    const c = xf.c;
    const d = xf.d;
    xf.a = a * cos + c * sin;
    xf.b = b * cos + d * sin;
    xf.c = c * cos - a * sin;
    xf.d = d * cos - b * sin;
    xf.isIdentity = false;
    xf.matrixObj = null;
  }

  /**
   * @param {number} sx
   * @param {number} sy
   */
  scale(sx, sy) {
    if (sx === 1 && sy === 1) return;
    const xf = this._xf;
    xf.a *= sx;
    xf.b *= sx;
    xf.c *= sy;
    xf.d *= sy;
    xf.isIdentity = false;
    xf.matrixObj = null;
  }

  /**
   * @param {number[]} segments
   */
  setLineDash(segments) {
    if (!segments || segments.length === 0) {
      this._lineDash = [];
      this._dashKey = "";
    } else {
      this._lineDash = segments.slice();
      this._dashKey = this._lineDash.join(",");
    }
  }

  /**
   * @returns {number[]}
   */
  getLineDash() {
    return this._lineDash.slice();
  }

  beginPath() {
    this._subPath = new Path2DCtor();
  }

  closePath() {
    this._subPath.closePath();
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  moveTo(x, y) {
    this._subPath.moveTo(x, y);
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  lineTo(x, y) {
    this._subPath.lineTo(x, y);
  }

  /**
   * @param {number} cpx
   * @param {number} cpy
   * @param {number} x
   * @param {number} y
   */
  quadraticCurveTo(cpx, cpy, x, y) {
    this._subPath.quadraticCurveTo(cpx, cpy, x, y);
  }

  /**
   * @param {number} cp1x
   * @param {number} cp1y
   * @param {number} cp2x
   * @param {number} cp2y
   * @param {number} x
   * @param {number} y
   */
  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
    this._subPath.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {number} startAngle
   * @param {number} endAngle
   * @param {boolean} [counterclockwise]
   */
  arc(x, y, radius, startAngle, endAngle, counterclockwise = false) {
    this._subPath.arc(x, y, radius, startAngle, endAngle, counterclockwise);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   */
  rect(x, y, w, h) {
    this._subPath.rect(x, y, w, h);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number | DOMPointInit | Array<number | DOMPointInit>} [radii]
   */
  roundRect(x, y, w, h, radii = 0) {
    this._subPath.roundRect(x, y, w, h, radii);
  }

  /**
   * @param {Path2D | CanvasFillRule} [pathOrRule]
   * @param {CanvasFillRule} [fillRule]
   */
  clip(pathOrRule, fillRule) {
    /** @type {Path2D} */
    let srcPath = this._subPath;
    /** @type {CanvasFillRule} */
    let rule = "nonzero";
    if (typeof pathOrRule === "string") {
      rule = pathOrRule;
    } else if (pathOrRule && typeof pathOrRule === "object") {
      srcPath = pathOrRule;
      if (typeof fillRule === "string") rule = fillRule;
    }
    const worldClip = new Path2DCtor();
    this._appendTransformedPath(worldClip, srcPath);
    this._activeClips = [
      ...this._activeClips,
      { path: worldClip, fillRule: rule },
    ];
    this._activeClipId = ++this._clipCounter;
  }

  /**
   * @param {Path2D} srcPath
   * @param {CanvasFillRule} fillRule
   */
  _recordFill(srcPath, fillRule) {
    this._syncClipPass();
    const pass = this._currentPass;
    const subIdx = this._currentSubLayer;
    const map = pass.subLayerMaps[subIdx];
    const key =
      fillRule === "nonzero"
        ? `F|${this.fillStyle}`
        : `F|${this.fillStyle}|${fillRule}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = {
        op: "fill",
        path: new Path2DCtor(),
        fillStyle: this.fillStyle,
        fillRule,
        strokeStyle: "",
        lineWidth: 1,
        lineCap: "butt",
        lineJoin: "miter",
        lineDash: [],
        dashKey: "",
      };
      map.set(key, bucket);
      pass.subLayers[subIdx].push(bucket);
    }
    this._appendTransformedPath(bucket.path, srcPath);
  }

  /**
   * @param {Path2D} srcPath
   */
  _recordStroke(srcPath) {
    this._syncClipPass();
    const pass = this._currentPass;
    const subIdx = this._currentSubLayer;
    const map = pass.subLayerMaps[subIdx];
    const key = `S|${this.strokeStyle}|${this.lineWidth}|${this.lineCap}|${this.lineJoin}|${this._dashKey}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = {
        op: "stroke",
        path: new Path2DCtor(),
        fillStyle: "",
        fillRule: "nonzero",
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        lineCap: this.lineCap,
        lineJoin: this.lineJoin,
        lineDash: this._lineDash,
        dashKey: this._dashKey,
      };
      map.set(key, bucket);
      pass.subLayers[subIdx].push(bucket);
    }
    this._appendTransformedPath(bucket.path, srcPath);
  }

  /**
   * @param {Path2D | CanvasFillRule} [pathOrRule]
   * @param {CanvasFillRule} [fillRule]
   */
  fill(pathOrRule, fillRule) {
    /** @type {Path2D} */
    let srcPath = this._subPath;
    /** @type {CanvasFillRule} */
    let rule = "nonzero";
    if (typeof pathOrRule === "string") {
      rule = pathOrRule;
    } else if (pathOrRule && typeof pathOrRule === "object") {
      srcPath = pathOrRule;
      if (typeof fillRule === "string") rule = fillRule;
    }
    this._recordFill(srcPath, rule);
  }

  /**
   * @param {Path2D} [path]
   */
  stroke(path) {
    const srcPath = path && typeof path === "object" ? path : this._subPath;
    this._recordStroke(srcPath);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   */
  fillRect(x, y, w, h) {
    const tmp = new Path2DCtor();
    tmp.rect(x, y, w, h);
    this._recordFill(tmp, "nonzero");
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   */
  strokeRect(x, y, w, h) {
    const tmp = new Path2DCtor();
    tmp.rect(x, y, w, h);
    this._recordStroke(tmp);
  }

  /**
   * @param {string} text
   * @returns {{ width: number }}
   */
  measureText(text) {
    return measureTextFallback(this.font, text);
  }

  /**
   * @param {string} text
   * @param {number} x
   * @param {number} y
   */
  fillText(text, x, y) {
    this._syncClipPass();
    const xf = this._xf;
    const wx = xf.isIdentity ? x : xf.a * x + xf.c * y + xf.e;
    const wy = xf.isIdentity ? y : xf.b * x + xf.d * y + xf.f;
    this._currentPass.texts.push({
      text,
      x: wx,
      y: wy,
      font: this.font,
      fillStyle: this.fillStyle,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
    });
  }

  /**
   * Replays all recorded passes, sub-layers, coalesced Path2Ds, and text commands
   * onto a target 2D rendering context.
   *
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
   */
  replay(ctx) {
    const passes = this._passes;
    let lastDashKey = "";

    for (let p = 0; p < passes.length; p++) {
      const pass = passes[p];
      const clips = pass.clips;
      const hasClips = clips.length > 0;
      if (hasClips) {
        ctx.save();
        for (let c = 0; c < clips.length; c++) {
          ctx.clip(clips[c].path, clips[c].fillRule);
        }
      }

      const subLayers = pass.subLayers;
      for (let s = 0; s < subLayers.length; s++) {
        const buckets = subLayers[s];
        if (!buckets) continue;
        for (let b = 0; b < buckets.length; b++) {
          const cmd = buckets[b];
          if (cmd.op === "fill") {
            if (ctx.fillStyle !== cmd.fillStyle) {
              ctx.fillStyle = cmd.fillStyle;
            }
            if (cmd.fillRule !== "nonzero") {
              ctx.fill(cmd.path, cmd.fillRule);
            } else {
              ctx.fill(cmd.path);
            }
          } else {
            if (ctx.strokeStyle !== cmd.strokeStyle) {
              ctx.strokeStyle = cmd.strokeStyle;
            }
            if (ctx.lineWidth !== cmd.lineWidth) {
              ctx.lineWidth = cmd.lineWidth;
            }
            if (ctx.lineCap !== cmd.lineCap) {
              ctx.lineCap = cmd.lineCap;
            }
            if (ctx.lineJoin !== cmd.lineJoin) {
              ctx.lineJoin = cmd.lineJoin;
            }
            if (lastDashKey !== cmd.dashKey) {
              ctx.setLineDash(cmd.lineDash);
              lastDashKey = cmd.dashKey;
            }
            ctx.stroke(cmd.path);
          }
        }
      }

      const texts = pass.texts;
      for (let t = 0; t < texts.length; t++) {
        const txt = texts[t];
        if (ctx.font !== txt.font) ctx.font = txt.font;
        if (ctx.fillStyle !== txt.fillStyle) ctx.fillStyle = txt.fillStyle;
        if (ctx.textAlign !== txt.textAlign) ctx.textAlign = txt.textAlign;
        if (ctx.textBaseline !== txt.textBaseline) {
          ctx.textBaseline = txt.textBaseline;
        }
        ctx.fillText(txt.text, txt.x, txt.y);
      }

      if (hasClips) {
        ctx.restore();
        lastDashKey = "";
      }
    }

    if (lastDashKey !== "") {
      ctx.setLineDash([]);
    }
  }

  /**
   * Returns diagnostic statistics about the recorded display list.
   *
   * @returns {{ passCount: number, commandCount: number, textCount: number }}
   */
  getStats() {
    let commandCount = 0;
    let textCount = 0;
    for (let p = 0; p < this._passes.length; p++) {
      const pass = this._passes[p];
      textCount += pass.texts.length;
      for (let s = 0; s < pass.subLayers.length; s++) {
        commandCount += pass.subLayers[s]?.length || 0;
      }
    }
    return {
      passCount: this._passes.length,
      commandCount,
      textCount,
    };
  }
}

/**
 * Vignelli-style 45°/90° Octilinear Marching-Squares Polygonizer (zero stippling!).
 * Scanline RLE-merged Marching Squares (`mask === 15` interior runs merge into 1 `path.rect()`,
 * eliminating tens of thousands of subpaths and 1x1 interior grid hatching).
 *
 * @param {number} W - Grid width in tiles
 * @param {number} H - Grid height in tiles
 * @param {Uint8Array} waterMask - Grid water mask array
 * @param {Float32Array} elevationField - Elevation values per cell
 * @param {number} ts - Tile size in pixels
 * @param {number | ((cx: number, cy: number) => boolean) | null} [threshOrFn]
 *   - null: tests waterMask[id] === WATER_MASK.OPEN_WATER
 *   - number: tests waterMask[id] === WATER_MASK.DRY && elevationField[id] >= threshOrFn
 *   - function: tests threshOrFn(cx, cy)
 * @param {Path2D | null} [outStrokePath] - Optional path collecting boundary stroke segments
 * @returns {Path2D}
 */
export function buildVignelliWaterPath(
  W,
  H,
  waterMask,
  elevationField,
  ts,
  threshOrFn = null,
  outStrokePath = null,
) {
  const path = new Path2DCtor();
  const gw = W + 2;
  const gh = H + 2;
  const flags = new Uint8Array(gw * gh);

  const isFn = typeof threshOrFn === "function";
  const isNum = typeof threshOrFn === "number";

  for (let gy = 0; gy < gh; gy++) {
    const cy = Math.max(0, Math.min(H - 1, gy - 1));
    const rowOff = gy * gw;
    const wRowOff = cy * W;
    if (isFn) {
      for (let gx = 0; gx < gw; gx++) {
        const cx = Math.max(0, Math.min(W - 1, gx - 1));
        flags[rowOff + gx] = threshOrFn(cx, cy) ? 1 : 0;
      }
    } else if (isNum) {
      for (let gx = 0; gx < gw; gx++) {
        const cx = Math.max(0, Math.min(W - 1, gx - 1));
        const id = wRowOff + cx;
        flags[rowOff + gx] =
          waterMask[id] === WATER_MASK.DRY && elevationField[id] >= threshOrFn
            ? 1
            : 0;
      }
    } else {
      for (let gx = 0; gx < gw; gx++) {
        const cx = Math.max(0, Math.min(W - 1, gx - 1));
        flags[rowOff + gx] =
          waterMask[wRowOff + cx] === WATER_MASK.OPEN_WATER ? 1 : 0;
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
 * Draws the subtle architectural paper grid on the canvas surface.
 * @param {VectorLayerRecorder | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {number} pw - Total pixel width (W * ts)
 * @param {number} ph - Total pixel height (H * ts)
 * @param {number} ts - Tile size in pixels
 */
export function drawArchitectureGrid(ctx, pw, ph, ts) {
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
}

/**
 * Draws the two-pass ("bank", "water") tapering quadratic-curve river network.
 * @param {VectorLayerRecorder | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {RiverRibbon[]} rivers
 * @param {number} ts
 */
export function drawTaperingRivers(ctx, rivers, ts) {
  const {
    mainStart,
    mainEnd,
    tribStart,
    tribEnd,
    bankExtra: bankExtraScale,
  } = WORLD_GEOMETRY.RIVER_RENDER_WIDTHS;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const pass of ["bank", "water"]) {
    if (
      pass === "water" &&
      "nextLayerPass" in ctx &&
      typeof ctx.nextLayerPass === "function"
    ) {
      ctx.nextLayerPass();
    }
    ctx.strokeStyle = pass === "bank" ? PALETTE.bgPaper : PALETTE.waterCyan;
    const bankExtra = pass === "bank" ? ts * bankExtraScale : 0;
    for (const rObj of rivers) {
      const pts = Array.isArray(rObj) ? rObj : rObj.points;
      const isMain = !Array.isArray(rObj) && rObj.isMainOutflow;
      if (!pts || pts.length < 4) continue;
      const startW = isMain ? mainStart : tribStart;
      const endW = isMain ? mainEnd : tribEnd;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        const p2 = pts[Math.min(pts.length - 1, i + 2)];
        const frac = i / (pts.length - 1);
        const w = p1.width ?? startW + (endW - startW) * Math.pow(frac, 0.9);
        ctx.lineWidth = Math.round((ts * w + bankExtra) * 2) * 0.5;
        ctx.beginPath();
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
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(x1, y1, x2, y2);
        ctx.stroke();
      }
    }
  }
}

/**
 * Draws the 3-stage batched tree canopy, shadows, and color-coded dots.
 * @param {VectorLayerRecorder | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {TreeDot[]} trees
 * @param {number} ts
 */
export function drawTrees(ctx, trees, ts) {
  if (!trees || trees.length === 0) return;

  // 1. Soft pastel woodland canopy underlay beneath tree clusters so forests read as cohesive groves
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

  // 2. Batch all tree shadows into a single path fill
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

  // 3. Batch tree dots by palette color (3 draw calls instead of N)
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
}

/**
 * Draws urban blush circles and optional 3-stage batched tree canopy/shadow/dot passes.
 * @param {VectorLayerRecorder | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {number} W
 * @param {number} H
 * @param {number} ts
 * @param {Int8Array | null} [zoneColorIdx]
 * @param {TreeDot[] | null} [trees]
 */
export function drawUrbanBlushAndTrees(
  ctx,
  W,
  H,
  ts,
  zoneColorIdx = null,
  trees = null,
) {
  if (zoneColorIdx) {
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
  }

  if (trees && trees.length > 0) {
    drawTrees(ctx, trees, ts);
  }
}
