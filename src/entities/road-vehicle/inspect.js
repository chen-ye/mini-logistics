/**
 * Road Vehicle (Freight Truck & Commuter Car) Inspection, Hit Testing, Camera Target,
 * Live Telemetry, and Dossier Formatting.
 *
 * Invariants:
 * - 100% Worker-safe and headless-safe: zero top-level or runtime window/document/DOM calls.
 * - Operates purely on passed world and simulator vehicle agent structures.
 * - Emits pure HTML strings and plain telemetry objects.
 *
 * @import { CarAgent } from '../../types.js'
 * @import { ProceduralLogisticsWorld } from '../../world-generator.js'
 */

import {
  describeBuildingDossier,
  getPartnerStageBadgeClass,
} from "../rci-building/catalog.js";

/**
 * Derives or computes the live 2D pose coordinates for a vehicle agent.
 *
 * @param {CarAgent} c
 * @returns {{ x: number, y: number, heading: number }}
 */
export function getCarPose(c) {
  if (c.pose && typeof c.pose.x === "number" && typeof c.pose.y === "number") {
    return {
      x: c.pose.x,
      y: c.pose.y,
      heading: c.pose.ang ?? 0,
    };
  }
  const track = c.returning ? c.inboundTrack : c.outboundTrack;
  if (track && track.pts && track.pts.length >= 2) {
    const idx = Math.min(c.segIdx ?? 0, track.pts.length - 2);
    const p0 = track.pts[idx];
    const p1 = track.pts[idx + 1];
    const d0 = track.cumLen?.[idx] ?? 0;
    const segLen = Math.max(1e-4, (track.cumLen?.[idx + 1] ?? 0) - d0);
    const frac = Math.max(0, Math.min(1, ((c.dist ?? 0) - d0) / segLen));
    return {
      x: p0.x + (p1.x - p0.x) * frac,
      y: p0.y + (p1.y - p0.y) * frac,
      heading: Math.atan2(p1.y - p0.y, p1.x - p0.x),
    };
  }
  return { x: 0, y: 0, heading: 0 };
}

/**
 * Resolves a road vehicle reference by ID from the active simulation state.
 *
 * @param {number | string} id
 * @param {ProceduralLogisticsWorld | null} _world
 * @param {{ cars?: CarAgent[] } | null} [sim]
 * @returns {CarAgent | null}
 */
export function resolveRoadVehicle(id, _world = null, sim = null) {
  if (!sim || !Array.isArray(sim.cars)) return null;
  if (id === "" || id === null || id === undefined) return null;
  const raw = String(id).trim();
  if (!/^\d+$/.test(raw)) return null;
  const numId = Number(raw);
  return sim.cars.find((c) => c.id === numId) || null;
}

/**
 * Hit-tests a road vehicle agent from the simulation fleet.
 * Prioritizes freight trucks over commuter cars, and closer Euclidean distance.
 *
 * @param {number} wx
 * @param {number} wy
 * @param {number} pad
 * @param {ProceduralLogisticsWorld | null} _world
 * @param {{ cars?: CarAgent[] } | null} [sim]
 * @returns {{ kind: "truck", id: number, entity: CarAgent } | null}
 */
export function hitTestRoadVehicle(wx, wy, pad, _world = null, sim = null) {
  if (!sim || !Array.isArray(sim.cars)) return null;
  const radius = Math.max(1.25, pad);

  /** @type {CarAgent | null} */
  let bestCar = null;
  let bestScore = Infinity;

  for (let i = 0; i < sim.cars.length; i++) {
    const c = sim.cars[i];
    if (c.pose?.inTunnel) continue;
    if (!c.pose) {
      const track = c.returning ? c.inboundTrack : c.outboundTrack;
      if (track?.pts && track.pts.length >= 2) {
        const idx = Math.min(c.segIdx ?? 0, track.pts.length - 2);
        const p0 = track.pts[idx];
        const p1 = track.pts[idx + 1];
        if (p0?.inTunnel && p1?.inTunnel) continue;
      }
    }
    const pose = getCarPose(c);
    const dist = Math.hypot(wx - (pose.x + 0.5), wy - (pose.y + 0.5));
    if (dist <= radius) {
      const isTruck = c.isFreightTruck;
      const score = (isTruck ? 0 : 10) + dist;
      if (score < bestScore) {
        bestScore = score;
        bestCar = c;
      }
    }
  }

  if (bestCar) {
    const id = bestCar.id ?? sim.cars.indexOf(bestCar);
    return { kind: "truck", id, entity: bestCar };
  }
  return null;
}

/**
 * Derives camera target parameters for focusing and tracking a road vehicle live.
 *
 * @param {CarAgent} c
 * @returns {{ cx: number, cy: number, x: number, y: number, zoom: number, followLive: boolean }}
 */
export function getRoadVehicleCameraTarget(c) {
  const pose = getCarPose(c);
  return {
    cx: pose.x,
    cy: pose.y,
    x: pose.x,
    y: pose.y,
    zoom: 2.5,
    followLive: true,
  };
}

/**
 * Computes live speed, leg status, and road hierarchy layer for an inspected vehicle.
 *
 * @param {CarAgent} c
 * @returns {{
 *   speedText: string,
 *   legText: string,
 *   layerText: string
 * }}
 */
export function describeRoadVehicleLiveStatus(c) {
  const speedVal = c.pose?.speed ?? c.speed ?? 3.5;
  const speedKmH = Math.round(speedVal * 18);
  const speedText = `${speedKmH} km/h (${speedVal.toFixed(1)} tiles/s)`;
  const legText = c.returning ? "Return" : "Outbound";

  const track = c.returning ? c.inboundTrack : c.outboundTrack;
  let layerText = "Road";
  if (track?.pts && track.pts.length > 0) {
    const idx = Math.min(c.segIdx ?? 0, track.pts.length - 1);
    const pt = track.pts[idx];
    if (pt?.onUpperBridge) {
      layerText = "Overpass";
    } else if (pt?.onMotorway) {
      layerText = "Expressway";
    } else if (pt?.isStreet) {
      layerText = "Local Street";
    } else {
      layerText = "Arterial";
    }
  }

  return {
    speedText,
    legText,
    layerText,
  };
}

/**
 * Returns a live patch dictionary for updating vehicle telemetry elements.
 *
 * @param {CarAgent} c
 * @param {ProceduralLogisticsWorld | null} [_world]
 * @returns {{ legText: string, speedText: string, layerText: string }}
 */
export function describeRoadVehicleLivePatch(c, _world = null) {
  const status = describeRoadVehicleLiveStatus(c);
  return {
    legText: status.legText,
    speedText: status.speedText,
    layerText: status.layerText,
  };
}

export const describeLivePatch = describeRoadVehicleLivePatch;

/**
 * Renders a road vehicle entity dossier snapshot.
 *
 * @param {CarAgent} c
 * @param {ProceduralLogisticsWorld | null} [world]
 * @returns {{
 *   badgeText: string,
 *   badgeClass: string,
 *   codeText: string,
 *   titleText: string,
 *   bodyHtml: string
 * }}
 */
export function renderRoadVehicleDossier(c, world = null) {
  const status = describeRoadVehicleLiveStatus(c);
  const isTruck = c.isFreightTruck;

  const badgeText = isTruck ? "FREIGHT TRUCK" : "COMMUTER VEHICLE";
  const badgeClass = isTruck
    ? "text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md bg-orange-700 text-white tracking-wide"
    : "text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md bg-stone-700 text-white tracking-wide";

  const codeText = `VEH #${c.id ?? 1} • ${isTruck ? "CARGO FLEET" : "MUNICIPAL"}`;
  const titleText = isTruck
    ? c.manifest?.commodity
      ? `${c.manifest.commodity} Carrier`
      : c.cargoStage
        ? `${c.cargoStage} Freight Hauler`
        : "Freight Truck"
    : "Commuter Car";

  const commodity = c.manifest?.commodity || c.cargoStage || "";
  const commodityChip = commodity
    ? `<span class="mono text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-stone-200/85 text-stone-700">${commodity}</span>`
    : "";

  const link = c.cargoLink;
  const startDest =
    link?.from ||
    (c.manifest && world
      ? world.destinations.find((d) => d.id === c.manifest?.originId) || null
      : null);
  const endDest =
    link?.to ||
    (c.manifest && world
      ? world.destinations.find((d) => d.id === c.manifest?.destId) || null
      : null);

  /**
   * @param {string} label
   * @param {any} dest
   */
  const renderEndpointButton = (label, dest) => {
    if (!dest) {
      return `<div class="px-2.5 py-1.5 rounded-lg bg-stone-100 border border-stone-200 text-[11px] font-bold text-stone-500">${label}</div>`;
    }
    const isGateway = Boolean(dest.isGatewayProxy && dest.airportId != null);
    const jumpAttr = isGateway
      ? `data-jump-ap="${dest.airportId}"`
      : `data-jump-bldg="${dest.id}" data-jump-dest="${dest.id}"`;
    const pInfo = describeBuildingDossier(dest, world);
    const badgeTone = getPartnerStageBadgeClass(pInfo, dest);

    return `
      <button type="button" ${jumpAttr} class="flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 hover:bg-white border border-stone-300/70 hover:border-stone-500 text-left transition group">
        <div class="min-w-0">
          <span class="text-[9px] font-extrabold uppercase px-1 py-0.5 rounded ${badgeTone}">${label}</span>
          <div class="font-bold text-[#36383e] group-hover:text-[#e85c90] truncate text-[11px] mt-0.5">${pInfo.title}</div>
        </div>
        <svg class="w-3.5 h-3.5 text-stone-400 group-hover:text-[#36383e] shrink-0" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
      </button>
    `;
  };

  const endpointsHtml =
    startDest || endDest
      ? `
    <div class="space-y-1.5 pt-1">
      <div class="flex items-center justify-between text-[11px] font-bold text-stone-600">
        <span>Route Terminals</span>
      </div>
      <div class="grid grid-cols-2 gap-2">
        ${renderEndpointButton("ORIGIN", startDest)}
        ${renderEndpointButton("DESTINATION", endDest)}
      </div>
    </div>`
      : "";

  const bodyHtml = `
  <div class="divide-y divide-stone-300/60 border-y border-stone-300/60">
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Leg</span>
      <span id="inspTruckLeg" class="mono font-bold text-[#36383e] tabular-nums">${status.legText}</span>
    </div>
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Speed</span>
      <span id="inspTruckSpeed" class="mono font-bold text-[#36383e] tabular-nums">${status.speedText}</span>
    </div>
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Infrastructure</span>
      <span id="inspTruckLayer" class="mono font-bold text-[#36383e] tabular-nums">${status.layerText}</span>
    </div>
    ${
      commodityChip
        ? `
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Commodity</span>
      ${commodityChip}
    </div>`
        : ""
    }
  </div>
  ${endpointsHtml}
`;

  return {
    badgeText,
    badgeClass,
    codeText,
    titleText,
    bodyHtml,
  };
}
