/**
 * Airport Inspection, Hit Testing, Camera Target, Live Telemetry, and Dossier Formatting.
 *
 * Invariants:
 * - 100% Worker-safe and headless-safe: zero top-level or runtime window/document/DOM calls.
 * - Operates purely on passed world and simulator data structures.
 * - Emits pure HTML strings and plain telemetry objects.
 *
 * @import { Airport, PlaneAgent } from '../../types.js'
 * @import { ProceduralLogisticsWorld } from '../../world-generator.js'
 */

import { worldToLocalAirfield } from "./layout.js";
import {
  describeBuildingDossier,
  getPartnerStageBadgeClass,
} from "../rci-building/catalog.js";

/**
 * Resolves an airport reference by ID from the world state.
 *
 * @param {number | string} id
 * @param {ProceduralLogisticsWorld | null} world
 * @returns {Airport | null}
 */
export function resolveAirport(id, world) {
  if (!world?.airports || !Array.isArray(world.airports)) return null;
  if (id === "" || id === null || id === undefined) return null;
  const raw = String(id).trim();
  if (!/^\d+$/.test(raw)) return null;
  const numId = Number(raw);
  return (
    world.airports.find((a) => a.id === numId) || world.airports[numId] || null
  );
}

/**
 * Hit-tests an airport using its rotated airfield bounding box (OBB).
 *
 * @param {number} wx
 * @param {number} wy
 * @param {number} pad
 * @param {ProceduralLogisticsWorld | null} world
 * @returns {{ kind: "airport", id: number, entity: Airport } | null}
 */
export function hitTestAirport(wx, wy, pad, world) {
  if (!world?.airports || !Array.isArray(world.airports)) return null;
  for (const ap of world.airports) {
    const { lx, ly } = worldToLocalAirfield(ap, wx, wy);
    const halfWid = ap.halfWid ?? 2.0;
    if (
      Math.abs(lx) <= ap.halfLen + 1.4 + pad &&
      Math.abs(ly) <= halfWid + 1.8 + pad
    ) {
      return { kind: "airport", id: ap.id, entity: ap };
    }
  }
  return null;
}

/**
 * Derives camera target parameters for focusing an airport.
 *
 * @param {Airport} ap
 * @returns {{ cx: number, cy: number, x: number, y: number, zoom: number, followLive: boolean }}
 */
export function getAirportCameraTarget(ap) {
  return {
    cx: ap.x,
    cy: ap.y,
    x: ap.x,
    y: ap.y,
    zoom: 1.65,
    followLive: false,
  };
}

/**
 * Computes live gate, taxiway, runway, and inbound telemetry for an inspected airport.
 * Pure calculation without window or simulator global fallbacks.
 *
 * @param {Airport} entity
 * @param {ProceduralLogisticsWorld | null} [world]
 * @param {PlaneAgent[] | null} [overridePlanes]
 * @returns {{
 *   liveAirport: Airport,
 *   activeDir: string,
 *   runwaySummary: string,
 *   occupiedGates: number,
 *   reservedGates: number,
 *   totalGates: number,
 *   gateFacilityType: string,
 *   gateSummary: string,
 *   taxiHoldCount: number,
 *   landingCount: number,
 *   departingCount: number,
 *   inboundCount: number,
 *   atcSummary: string
 * }}
 */
export function describeAirportLiveStatus(
  entity,
  world = null,
  overridePlanes = null,
) {
  const liveAirport =
    world?.airports?.find((a) => a.id === entity.id) || entity;
  const atc = liveAirport.atc;
  const planes = Array.isArray(overridePlanes) ? overridePlanes : [];

  const totalGates = atc?.gates?.length || (liveAirport.isHub ? 7 : 4);
  let occupiedGates = 0;
  let reservedGates = 0;
  if (atc?.gates && Array.isArray(atc.gates)) {
    for (const g of atc.gates) {
      if (g.state === "OCCUPIED") occupiedGates++;
      else if (g.state === "RESERVED") reservedGates++;
    }
  } else {
    occupiedGates = planes.filter((p) => {
      const isHere =
        (p.origin?.id === liveAirport.id &&
          (p.phase === "GATE_DWELL" ||
            p.state === "GATE_LOADING" ||
            p.state === "PUSHBACK_HOLD")) ||
        (p.dest?.id === liveAirport.id &&
          (p.phase === "GATE_DWELL" || p.state === "GATE_LOADING"));
      return isHere;
    }).length;
    occupiedGates = Math.min(occupiedGates, totalGates);
  }

  let taxiHoldCount = 0;
  let landingCount = 0;
  let departingCount = 0;
  let inboundCount = 0;

  if (planes.length > 0) {
    for (const p of planes) {
      const fromHere = p.origin?.id === liveAirport.id;
      const toHere = p.dest?.id === liveAirport.id;
      const st = p.state;

      if (
        (fromHere &&
          (st === "TAXI_TO_RUNWAY" ||
            st === "HOLD_SHORT_QUEUE" ||
            (!st && p.phase === "TAXI_OUT"))) ||
        (toHere &&
          (st === "HOLD_CROSSING_RUNWAY" ||
            st === "TAXI_TO_GATE" ||
            (!st && p.phase === "TAXI_IN")))
      ) {
        taxiHoldCount++;
      }

      if (
        toHere &&
        (st === "LANDING_ROLLOUT" || (!st && p.phase === "LANDING"))
      ) {
        landingCount++;
      }

      if (
        fromHere &&
        (st === "TAKEOFF_ROLL" || (!st && p.phase === "TAKEOFF"))
      ) {
        departingCount++;
      }

      if (
        toHere &&
        (st === "ENROUTE_CRUISE" ||
          st === "APPROACH_QUEUE" ||
          st === "LANDING_ROLLOUT" ||
          (!st && (p.phase === "CRUISE" || p.phase === "LANDING")))
      ) {
        inboundCount++;
      }
    }
  } else if (atc) {
    taxiHoldCount =
      (Array.isArray(atc.taxiwayOccupants) ? atc.taxiwayOccupants.length : 0) +
      (Array.isArray(atc.crossingQueue) ? atc.crossingQueue.length : 0);
    if (atc.arrRunwayBusyBy != null) landingCount = 1;
    if (atc.depRunwayBusyBy != null) departingCount = 1;
    inboundCount =
      (Array.isArray(atc.approachQueue) ? atc.approachQueue.length : 0) +
      landingCount;
  }

  const activeDir =
    (atc?.activeSign ?? liveAirport.activeSign ?? 1) === -1
      ? "Upwind Rev"
      : "Upwind Fwd";
  const gateFacilityType = liveAirport.isHub
    ? "Jetbridge"
    : liveAirport.airportClass === "CRG"
      ? "Cargo Ramp"
      : "Apron";

  const rwyCountLabel =
    liveAirport.runwayCount > 1
      ? `${liveAirport.runwayCount} Parallel`
      : "Single Runway";
  const runwaySummary = `${rwyCountLabel}, ${liveAirport.runwayLabel} (${activeDir})`;
  const gateSummary = `${occupiedGates} / ${totalGates} Occupied${reservedGates > 0 ? ` (${reservedGates} Rsv)` : ""} • ${gateFacilityType}`;

  const atcParts = [`${taxiHoldCount} Taxiing`];
  if (landingCount > 0) atcParts.push(`${landingCount} Landing`);
  if (departingCount > 0) atcParts.push(`${departingCount} Takeoff`);
  atcParts.push(`${inboundCount} Inbound`);
  const atcSummary = atcParts.join(" • ");

  return {
    liveAirport,
    activeDir,
    runwaySummary,
    occupiedGates,
    reservedGates,
    totalGates,
    gateFacilityType,
    gateSummary,
    taxiHoldCount,
    landingCount,
    departingCount,
    inboundCount,
    atcSummary,
  };
}

/**
 * Returns a live patch dictionary for updating airport telemetry elements.
 *
 * @param {Airport} ap
 * @param {ProceduralLogisticsWorld | null} [world]
 * @param {PlaneAgent[] | null} [overridePlanes]
 * @returns {{ runwaySummary: string, gateSummary: string, atcSummary: string }}
 */
export function describeAirportLivePatch(
  ap,
  world = null,
  overridePlanes = null,
) {
  const status = describeAirportLiveStatus(ap, world, overridePlanes);
  return {
    runwaySummary: status.runwaySummary,
    gateSummary: status.gateSummary,
    atcSummary: status.atcSummary,
  };
}

export const describeLivePatch = describeAirportLivePatch;

/**
 * Renders an airport entity dossier snapshot.
 *
 * @param {Airport} ap
 * @param {ProceduralLogisticsWorld | null} [world]
 * @param {PlaneAgent[]} [planes]
 * @returns {{
 *   badgeText: string,
 *   badgeClass: string,
 *   codeText: string,
 *   titleText: string,
 *   bodyHtml: string
 * }}
 */
export function renderAirportDossier(ap, world = null, planes = []) {
  const status = describeAirportLiveStatus(ap, world, planes);
  const liveEntity = status.liveAirport;
  const hostTown =
    world?.towns && liveEntity.hostTownId != null
      ? world.towns[liveEntity.hostTownId]
      : null;

  const badgeText = liveEntity.classLabel.toUpperCase();
  const badgeClass =
    "text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md bg-[#e85c90] text-white tracking-wide";
  const codeText = `IATA ${liveEntity.iata}, (${Math.round(liveEntity.x)}, ${Math.round(liveEntity.y)})`;
  const titleText = liveEntity.name;

  const acceptsWide =
    liveEntity.acceptsWidebody ??
    (liveEntity.isHub || liveEntity.airportClass === "CRG");
  const fleetCapability = acceptsWide
    ? "Wide-body, feeder, regional jet"
    : "Feeder, regional jet";
  const intlTrade = `${liveEntity.importsCompleted || 0} Imp, ${liveEntity.exportsCompleted || 0} Exp`;

  const gatewayLinks = (world?.cargoLinks || []).filter(
    (l) =>
      l.from?.airportId === liveEntity.id || l.to?.airportId === liveEntity.id,
  );

  let gatewayLinksHtml = "";
  if (gatewayLinks.length > 0) {
    const linkRows = gatewayLinks
      .map((link) => {
        const isOut = link.from?.airportId === liveEntity.id;
        const partner = isOut ? link.to : link.from;
        const pInfo = describeBuildingDossier(partner, world);
        const distTiles = (link.points || []).length;
        const badgeTone = getPartnerStageBadgeClass(pInfo, partner);
        const dirBadge = isOut
          ? `<span class="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded ${badgeTone} shrink-0">EXPORT → ${pInfo.shortTag} #${partner.id}</span>`
          : `<span class="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded ${badgeTone} shrink-0">IMPORT ← ${pInfo.shortTag} #${partner.id}</span>`;
        const commodityChip = link.commodity
          ? `<span class="mono text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-stone-200/85 text-stone-700">${link.commodity}</span>`
          : "";
        return `
        <button type="button" data-jump-bldg="${partner.id}" data-jump-dest="${partner.id}" class="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-white/80 hover:bg-white border border-stone-300/70 hover:border-stone-500 text-left transition group">
          <div class="flex items-center gap-2 min-w-0">
            ${dirBadge}
            <span class="font-bold text-[#36383e] group-hover:text-[#e85c90] truncate">${pInfo.title}</span>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            ${commodityChip}
            <span class="mono text-[10px] font-bold text-stone-500 tabular-nums">${distTiles} tiles</span>
            <svg class="w-3.5 h-3.5 text-stone-400 group-hover:text-[#36383e]" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
          </div>
        </button>
      `;
      })
      .join("");

    gatewayLinksHtml = `
    <div class="space-y-1.5 pt-2">
      <div class="flex items-center justify-between text-[11px] font-bold text-stone-600">
        <span>Landside Cargo Gateway (${gatewayLinks.length} Connections)</span>
      </div>
      <div class="space-y-1 max-h-36 overflow-y-auto drawer-scroll pr-0.5">
        ${linkRows}
      </div>
    </div>
  `;
  }

  const hostTownRow = hostTown
    ? `
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Municipality</span>
      <button type="button" data-jump-town="${hostTown.id}" class="font-bold text-[#36383e] hover:text-[#e85c90] underline underline-offset-2 transition flex items-center gap-1">
        <span>${hostTown.name} (Tier ${hostTown.tier})</span>
        <svg class="w-3 h-3" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
      </button>
    </div>`
    : "";

  const bodyHtml = `
  <div class="divide-y divide-stone-300/60 border-y border-stone-300/60">
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Runways</span>
      <span id="inspRunwayStats" class="mono font-bold text-[#36383e] tabular-nums">${status.runwaySummary}</span>
    </div>
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Gate Stands</span>
      <span id="inspGateStats" class="mono font-bold text-[#36383e] tabular-nums">${status.gateSummary}</span>
    </div>
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">ATC & Taxi Queue</span>
      <span id="inspAtcStats" class="mono font-bold text-[#36383e] tabular-nums">${status.atcSummary}</span>
    </div>
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Approach Cone</span>
      <span class="mono font-bold text-emerald-700 tabular-nums">${liveEntity.approachClearance}% Clear</span>
    </div>
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Expressway Spur</span>
      <span class="mono font-bold text-[#36383e] tabular-nums">Motorway ${liveEntity.motorwayId || 1} (${liveEntity.distToCBD} tiles to CBD)</span>
    </div>
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Fleet Capability</span>
      <span class="mono font-bold text-[#36383e] tabular-nums text-[11px]">${fleetCapability}</span>
    </div>
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Gateway Trade</span>
      <span id="inspGatewayTrade" class="mono font-bold text-[#36383e] tabular-nums text-[11px]">${intlTrade}</span>
    </div>
    ${hostTownRow}
  </div>
  ${gatewayLinksHtml}
`;

  return {
    badgeText,
    badgeClass,
    codeText,
    titleText,
    bodyHtml,
  };
}
