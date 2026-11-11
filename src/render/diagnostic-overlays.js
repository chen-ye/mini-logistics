/**
 * Algorithmic Diagnostic and Analysis Overlays.
 *
 * Renders hypsometric upland bands, urban suitability heatmaps, building mask footprints,
 * vector road topology graphs (directed lanes, roundabout circulatory orbits, degree >= 3
 * junctions, interchange ramp graphs, anomaly callout rings), and screen-space legends.
 *
 * Invariants:
 * - 100% Worker-safe: zero window, document, or DOM references.
 * - Screen-space legends respect canvas boundaries and drawer margins.
 *
 * @import { ProceduralLogisticsWorld } from '../world-generator.js'
 * @import { RoadGraphDiagnostics } from '../types.js'
 */
import { deriveRoadTopology } from "../vehicle-routing.js";
import { traceSmoothPath } from "./road-network-layer.js";

export { traceSmoothPath };

/**
 * Derives or retrieves road graph topology diagnostics.
 *
 * @param {ProceduralLogisticsWorld} world
 * @param {{ world?: ProceduralLogisticsWorld | null, diag?: any } | null} [cache=null]
 * @returns {RoadGraphDiagnostics & {
 *   activeTracks: number,
 *   rampTraversals: number,
 *   roundaboutOrbits: number,
 *   reversalAnomalies: number,
 * }}
 */
export function computeRoadGraphDiagnostics(world, cache = null) {
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

  if (cache && cache.world === world && cache.diag) {
    return cache.diag;
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

  if (cache) {
    cache.world = world;
    cache.diag = diag;
  }
  return diag;
}

/**
 * Draws the hydrology analysis overlay (elevation bands and urban suitability).
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 */
export function drawHydrologyOverlay(ctx, world, ts) {
  ctx.save();
  for (let y = 0; y < world.H - 1; y += 2) {
    for (let x = 0; x < world.W - 1; x += 2) {
      const id = world.idx(x, y);
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
  for (const hf of world.hydroFeatures || []) {
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
 * Draws building mask and road grid tile underlays.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 */
export function drawRoadGridUnderlay(ctx, world, ts) {
  ctx.save();
  const { W, H } = world;

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

/**
 * Draws road graph topology overlay (edges, lanes, junctions, anomaly rings).
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {number} ts
 * @param {{ world?: ProceduralLogisticsWorld | null, diag?: any } | null} [cache=null]
 */
export function drawRoadGridGraphOverlay(ctx, world, ts, cache = null) {
  ctx.save();
  const ox = ts * 0.5;
  const oy = ts * 0.5;
  const diag = computeRoadGraphDiagnostics(world, cache);
  const driveways = world.routingGraph?.driveways || [];
  const rampEdges =
    world.routingGraph?.rampEdges || world._vehicleGraph?.rampEdges || [];
  const rampNodes =
    world.routingGraph?.rampNodes || world._vehicleGraph?.rampNodes || [];

  // 1. Driveway Frontage Links
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

  // 2. Vector Road Polylines
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const r of world.roads || []) {
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

  // 2B. Directed Lane Trajectories
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
    if (rt.inboundTrack?.pts?.length >= 2) inboundTracks.push(rt.inboundTrack);
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

  // 2C. Roundabout Circulatory Orbits
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

  // 2D. Directed Interchange Ramp & Roundabout Portal Graph
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

  // 3. Vertex Degree Nodes
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

  // 4. High-Contrast Callout Rings for Topological/Geometric Anomalies
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

/**
 * Draws the RCI screen-space bottom legend pill.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {{ width: number, height: number }} canvas
 * @param {boolean} [isDrawerOpen=true]
 * @param {any} [selectedEntity=null]
 */
export function drawRCIScreenLegend(
  ctx,
  world,
  canvas,
  isDrawerOpen = true,
  selectedEntity = null,
) {
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
  const drawerOpen = canvas.width >= 640 && isDrawerOpen;
  const inspOpen = Boolean(selectedEntity);
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

/**
 * Draws the road grid graph analysis screen-space legend pill.
 *
 * @param {any} ctx
 * @param {ProceduralLogisticsWorld} world
 * @param {{ width: number, height: number }} canvas
 * @param {boolean} [isDrawerOpen=true]
 * @param {{ world?: ProceduralLogisticsWorld | null, diag?: any } | null} [cache=null]
 */
export function drawRoadGridScreenLegend(
  ctx,
  world,
  canvas,
  isDrawerOpen = true,
  cache = null,
) {
  const diag = computeRoadGraphDiagnostics(world, cache);

  ctx.save();
  const drawerOpen = canvas.width >= 640 && isDrawerOpen;
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
