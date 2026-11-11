/**
 * Pure viewport <-> world-tile 2D camera controller.
 *
 * Invariants:
 * - 100% pure coordinate math: never touches DOM globals or mutates `canvas.width` / `canvas.height`.
 * - Works identically on `main.js` (with `WorldSummary`) and inside `render-sim-worker.js` (with `ProceduralLogisticsWorld`).
 *
 * @import { CameraTarget } from "./types.js"
 */

export class CameraController {
  /**
   * @param {number} [width=1280]
   * @param {number} [height=800]
   */
  constructor(width = 1280, height = 800) {
    /** @type {number} */
    this.x = 0;
    /** @type {number} */
    this.y = 0;
    /** @type {number} */
    this.zoom = 1;
    /** @type {number} */
    this.width = Math.max(1, width);
    /** @type {number} */
    this.height = Math.max(1, height);
  }

  /**
   * Updates tracked viewport dimensions without touching any canvas element.
   *
   * @param {number} width
   * @param {number} height
   */
  setViewport(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  /**
   * Fits camera zoom and translation to a world or world summary.
   * Uses metropolitan bounding box framing on portrait/mobile viewports and edge-to-edge fit on landscape.
   *
   * @param {{
   *   W: number,
   *   H: number,
   *   tileSize: number,
   *   towns?: ReadonlyArray<{ x: number, y: number, urbanRadius: number }>,
   *   airports?: ReadonlyArray<{ x: number, y: number, halfLen: number }>
   * } | null | undefined} worldOrSummary
   * @returns {{ x: number, y: number, zoom: number }}
   */
  fitToWorld(worldOrSummary) {
    if (!worldOrSummary) {
      return { x: this.x, y: this.y, zoom: this.zoom };
    }
    const ts = worldOrSummary.tileSize;
    const worldPxW = worldOrSummary.W * ts;
    const worldPxH = worldOrSummary.H * ts;
    const towns = worldOrSummary.towns || [];
    const airports = worldOrSummary.airports || [];

    if ((this.width < 640 || this.width < this.height) && towns.length > 0) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const t of towns) {
        minX = Math.min(minX, t.x - t.urbanRadius - 4);
        maxX = Math.max(maxX, t.x + t.urbanRadius + 4);
        minY = Math.min(minY, t.y - t.urbanRadius - 4);
        maxY = Math.max(maxY, t.y + t.urbanRadius + 4);
      }
      for (const ap of airports) {
        minX = Math.min(minX, ap.x - ap.halfLen - 5);
        maxX = Math.max(maxX, ap.x + ap.halfLen + 5);
        minY = Math.min(minY, ap.y - ap.halfLen - 5);
        maxY = Math.max(maxY, ap.y + ap.halfLen + 5);
      }
      const boxW = Math.max(60, maxX - minX) * ts;
      const boxH = Math.max(50, maxY - minY) * ts;
      const cx = (minX + maxX) * 0.5 * ts;
      const cy = (minY + maxY) * 0.5 * ts;
      const scaleX = (this.width * 0.92) / boxW;
      const scaleY = (this.height * 0.78) / boxH;
      this.zoom = Math.max(0.18, Math.min(1.25, Math.min(scaleX, scaleY)));
      this.x = this.width * 0.5 - cx * this.zoom;
      this.y = this.height * 0.52 - cy * this.zoom;
      return { x: this.x, y: this.y, zoom: this.zoom };
    }

    const scaleX = this.width / worldPxW;
    const scaleY = this.height / worldPxH;
    this.zoom = Math.max(scaleX, scaleY);
    this.x = (this.width - worldPxW * this.zoom) * 0.5;
    this.y = (this.height - worldPxH * this.zoom) * 0.5;
    return { x: this.x, y: this.y, zoom: this.zoom };
  }

  /**
   * Centers viewport on world-tile coordinates `(cx, cy)` at `zoom`.
   *
   * @param {number} cx
   * @param {number} cy
   * @param {number} zoom
   * @param {number} tileSize
   * @returns {{ x: number, y: number, zoom: number }}
   */
  applyWorldCenter(cx, cy, zoom, tileSize) {
    const clampedZoom = Math.max(0.16, Math.min(3.5, zoom));
    this.zoom = clampedZoom;
    this.x = this.width * 0.5 - cx * clampedZoom * tileSize;
    this.y = this.height * 0.5 - cy * clampedZoom * tileSize;
    return { x: this.x, y: this.y, zoom: this.zoom };
  }

  /**
   * Projects current screen center back to viewport-independent world-tile coordinates.
   *
   * @param {number} tileSize
   * @returns {{ cx: number, cy: number, zoom: number }}
   */
  toWorldCenter(tileSize) {
    const denom = this.zoom * tileSize || 1;
    return {
      cx: (this.width * 0.5 - this.x) / denom,
      cy: (this.height * 0.5 - this.y) / denom,
      zoom: this.zoom,
    };
  }

  /**
   * Converts client screen coordinates into world-tile coordinates.
   *
   * @param {number} clientX
   * @param {number} clientY
   * @param {number} tileSize
   * @returns {{ wx: number, wy: number }}
   */
  screenToWorld(clientX, clientY, tileSize) {
    const denom = this.zoom * tileSize || 1;
    return {
      wx: (clientX - this.x) / denom,
      wy: (clientY - this.y) / denom,
    };
  }

  /**
   * Scales camera zoom around a screen-space pivot point, clamping zoom to `[0.16, 3.5]`.
   *
   * @param {number} factor
   * @param {number} centerX
   * @param {number} centerY
   * @returns {{ x: number, y: number, zoom: number }}
   */
  zoomAroundPoint(factor, centerX, centerY) {
    const prevZoom = this.zoom;
    const nextZoom = Math.max(0.16, Math.min(3.5, prevZoom * factor));
    this.x = centerX - (centerX - this.x) * (nextZoom / prevZoom);
    this.y = centerY - (centerY - this.y) * (nextZoom / prevZoom);
    this.zoom = nextZoom;
    return { x: this.x, y: this.y, zoom: this.zoom };
  }

  /**
   * Focuses and zooms camera on an entity target with desktop/mobile inspector sheet offset bias.
   *
   * @param {CameraTarget | null | undefined} target
   * @param {number} tileSize
   * @param {boolean} [isMobileViewport=false]
   * @returns {{ x: number, y: number, zoom: number }}
   */
  focusOnTarget(target, tileSize, isMobileViewport = false) {
    if (!target) {
      return { x: this.x, y: this.y, zoom: this.zoom };
    }
    const targetZoom = Math.max(0.16, Math.min(3.5, target.zoom || 1.65));
    const ex = target.x ?? target.cx ?? 0;
    const ey = target.y ?? target.cy ?? 0;
    const yBias = isMobileViewport ? this.height * 0.36 : this.height * 0.5;
    const xBias = !isMobileViewport ? this.width * 0.46 : this.width * 0.5;
    this.zoom = targetZoom;
    this.x = xBias - (ex + 0.5) * tileSize * targetZoom;
    this.y = yBias - (ey + 0.5) * tileSize * targetZoom;
    return { x: this.x, y: this.y, zoom: this.zoom };
  }
}
