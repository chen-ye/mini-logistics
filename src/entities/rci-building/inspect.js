/**
 * RCI Building & Destination Inspection, Hit Testing, Camera Target, and Dossier Formatting.
 *
 * Invariants:
 * - 100% Worker-safe and headless-safe: zero top-level or runtime window/document/DOM calls.
 * - Operates purely on passed world and destination data structures.
 * - Emits pure HTML strings and plain telemetry objects.
 *
 * @import { Destination, CargoLink } from '../../types.js'
 * @import { ProceduralLogisticsWorld } from '../../world-generator.js'
 */

import {
  describeBuildingDossier,
  getPartnerStageBadgeClass,
} from "./catalog.js";

/**
 * Resolves a destination/building reference by ID from the world state.
 *
 * @param {number | string} id
 * @param {ProceduralLogisticsWorld | null} world
 * @returns {Destination | null}
 */
export function resolveBuilding(id, world) {
  if (!world?.destinations || !Array.isArray(world.destinations)) return null;
  const numId = Number(id);
  return world.destinations.find((d) => d.id === numId) || null;
}

/**
 * Hit-tests an industrial, commercial, or rural raw resource destination lot.
 * Supports standard AABB lots as well as sprawling FARM BSP parcel polygons.
 *
 * @param {number} wx
 * @param {number} wy
 * @param {number} pad
 * @param {ProceduralLogisticsWorld | null} world
 * @returns {{ kind: "building", id: number, entity: Destination } | null}
 */
export function hitTestBuilding(wx, wy, pad, world) {
  if (!world?.destinations || !Array.isArray(world.destinations)) return null;

  /** @type {Destination | null} */
  let bestBuilding = null;
  let bestBldDist = Infinity;
  const bldPad = 0.65 + pad * 0.65;

  for (const d of world.destinations) {
    const wT = d.wTiles || 2;
    const hT = d.hTiles || 2;
    if (
      wx >= d.gx - bldPad &&
      wx <= d.gx + wT + bldPad &&
      wy >= d.gy - bldPad &&
      wy <= d.gy + hT + bldPad
    ) {
      const dist = Math.hypot(wx - (d.x + 0.5), wy - (d.y + 0.5));
      if (dist < bestBldDist) {
        bestBldDist = dist;
        bestBuilding = d;
      }
    }
  }

  if (bestBuilding) {
    return { kind: "building", id: bestBuilding.id, entity: bestBuilding };
  }

  // Sprawling farm field estates (BSP parcels)
  for (const d of world.destinations) {
    if (d.resourceType !== "FARM" || !d.bspParcels) continue;
    const bb = d.estateBBox;
    const estatePad = pad || 0;
    if (
      bb &&
      (wx < bb.minX - estatePad ||
        wx > bb.maxX + estatePad ||
        wy < bb.minY - estatePad ||
        wy > bb.maxY + estatePad)
    ) {
      continue;
    }
    for (const p of d.bspParcels) {
      if (
        wx >= p.x0 - estatePad &&
        wx <= p.x1 + estatePad &&
        wy >= p.y0 - estatePad &&
        wy <= p.y1 + estatePad
      ) {
        return { kind: "building", id: d.id, entity: d };
      }
    }
  }

  return null;
}

/**
 * Derives camera target parameters for focusing a building.
 *
 * @param {Destination} d
 * @returns {{ cx: number, cy: number, x: number, y: number, zoom: number, followLive: boolean }}
 */
export function getBuildingCameraTarget(d) {
  return {
    cx: d.x,
    cy: d.y,
    x: d.x,
    y: d.y,
    zoom: 2.15,
    followLive: false,
  };
}

/**
 * Returns a live patch dictionary for updating building telemetry elements.
 *
 * @param {Destination} _d
 * @param {ProceduralLogisticsWorld | null} [_world]
 * @returns {Record<string, never>}
 */
export function describeBuildingLivePatch(_d, _world = null) {
  return {};
}

export const describeLivePatch = describeBuildingLivePatch;

/**
 * Renders a building/destination entity dossier snapshot.
 *
 * @param {Destination} entity
 * @param {ProceduralLogisticsWorld | null} [world]
 * @returns {{
 *   badgeText: string,
 *   badgeClass: string,
 *   codeText: string,
 *   titleText: string,
 *   bodyHtml: string
 * }}
 */
export function renderBuildingDossier(entity, world = null) {
  const info = describeBuildingDossier(entity, world);
  const hostTown =
    world?.towns && entity.townId != null ? world.towns[entity.townId] : null;
  const allLinks = world?.cargoLinks || [];
  const inboundLinks = allLinks.filter((l) => l.to.id === entity.id);
  const outboundLinks = allLinks.filter((l) => l.from.id === entity.id);

  const badgeText = info.badge;
  const badgeClass = `text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md ${info.badgeClass} tracking-wide`;
  const codeText = `LOT #${entity.id} • (${entity.gx}, ${entity.gy})`;
  const titleText = info.title;

  const stages = [
    {
      key: "RAW",
      label: "1. RAW",
      tone: "bg-amber-700 text-white border-amber-700",
    },
    {
      key: "MFG",
      label: "2. MFG",
      tone: "bg-orange-700 text-white border-orange-700",
    },
    {
      key: "LOG",
      label: "3. LOG",
      tone: "bg-purple-700 text-white border-purple-700",
    },
    {
      key: "COM",
      label: "4. COM",
      tone: "bg-blue-700 text-white border-blue-700",
    },
  ];
  const connectedStageSet = new Set();
  for (const l of inboundLinks) {
    connectedStageSet.add(describeBuildingDossier(l.from, world).stage);
  }
  for (const l of outboundLinks) {
    connectedStageSet.add(describeBuildingDossier(l.to, world).stage);
  }

  const pipelineHtml = stages
    .map((st, idx) => {
      const isActive = st.key === info.stage;
      const isLinked = !isActive && connectedStageSet.has(st.key);
      const pillCls = isActive
        ? `${st.tone} shadow-xs font-extrabold`
        : isLinked
          ? "bg-white text-[#36383e] border-stone-400 font-bold"
          : "bg-stone-200/60 text-stone-500 border-stone-300/70 font-semibold";
      const arrow =
        idx < stages.length - 1
          ? `<svg class="w-3 h-3 text-stone-400 shrink-0" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>`
          : "";
      return `
      <div class="flex items-center gap-1 flex-1 min-w-0">
        <div class="flex-1 text-center text-[10px] py-1 px-1.5 rounded-lg border ${pillCls} truncate">
          ${st.label}
        </div>
        ${arrow}
      </div>
    `;
    })
    .join("");

  const wT = entity.wTiles || 2;
  const hT = entity.hTiles || 2;
  let siteMetricLabel = "Footprint";
  let siteMetricVal = `${wT}×${hT} Tiles • Road (${entity.roadX}, ${entity.roadY})`;
  if (entity.resourceType === "FARM" && entity.bspParcels) {
    siteMetricLabel = "Estate Layout";
    siteMetricVal = `${entity.bspParcels.length} Parcels • ${(entity.tractorTracks || []).length} Tracks`;
  } else if (entity.resourceType === "MINE") {
    const slopeVal =
      world?.slopeField && world?.idx
        ? world.slopeField[world.idx(entity.gx, entity.gy)]
        : 0.1;
    const slopePct = Math.round((slopeVal || 0.1) * 100);
    siteMetricLabel = "Foothill Bench";
    siteMetricVal = `${wT}×${hT} Tiles • ${slopePct}% Slope`;
  } else if (entity.resourceType === "TIMBER") {
    const fertVal =
      world?.fertilityField && world?.idx
        ? world.fertilityField[world.idx(entity.gx, entity.gy)]
        : 0.6;
    const fertPct = Math.round((fertVal || 0.6) * 100);
    siteMetricLabel = "Forest Stand";
    siteMetricVal = `${wT}×${hT} Tiles • ${fertPct}% Fertility`;
  }

  /**
   * @param {CargoLink} link
   * @param {"in" | "out"} dir
   */
  const renderLinkRow = (link, dir) => {
    const partner = dir === "in" ? link.from : link.to;
    const pInfo = describeBuildingDossier(partner, world);
    const distTiles = (link.points || []).length;
    const badgeTone = getPartnerStageBadgeClass(pInfo, partner);
    const dirBadge =
      dir === "in"
        ? `<span class="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded ${badgeTone} shrink-0">← ${pInfo.shortTag} #${partner.id}</span>`
        : `<span class="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded ${badgeTone} shrink-0">→ ${pInfo.shortTag} #${partner.id}</span>`;
    const commodityChip = link.commodity
      ? `<span class="mono text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-stone-200/85 text-stone-700">${link.commodity}</span>`
      : "";
    const isGateway = Boolean(
      partner.isGatewayProxy && partner.airportId != null,
    );
    const jumpAttr = isGateway
      ? `data-jump-ap="${partner.airportId}"`
      : `data-jump-bldg="${partner.id}" data-jump-dest="${partner.id}"`;
    return `
      <button type="button" ${jumpAttr} class="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-white/80 hover:bg-white border border-stone-300/70 hover:border-stone-500 text-left transition group">
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
  };

  const allLinksHtml = [
    ...inboundLinks.map((l) => renderLinkRow(l, "in")),
    ...outboundLinks.map((l) => renderLinkRow(l, "out")),
  ].join("");

  let commodityRowHtml = "";
  if (
    entity.requiredInputs &&
    entity.requiredInputs.length > 0 &&
    entity.outputGood
  ) {
    commodityRowHtml = `
      <div class="flex items-center justify-between py-1.5">
        <span class="text-stone-500 font-medium">Commodity Flow</span>
        <span class="mono font-bold text-[#36383e] tabular-nums text-[11px]">${entity.requiredInputs.join(" + ")} → ${entity.outputGood}</span>
      </div>`;
  } else if (entity.outputGood) {
    commodityRowHtml = `
      <div class="flex items-center justify-between py-1.5">
        <span class="text-stone-500 font-medium">Output Good</span>
        <span class="mono font-bold text-[#36383e] tabular-nums text-[11px]">${entity.outputGood}</span>
      </div>`;
  } else if (entity.demandedGoods && entity.demandedGoods.length > 0) {
    commodityRowHtml = `
      <div class="flex items-center justify-between py-1.5">
        <span class="text-stone-500 font-medium">Demanded Goods</span>
        <span class="mono font-bold text-[#36383e] tabular-nums text-[11px]">${entity.demandedGoods.join(", ")}</span>
      </div>`;
  } else if (entity.relativeDemand != null) {
    commodityRowHtml = `
      <div class="flex items-center justify-between py-1.5">
        <span class="text-stone-500 font-medium">Regional Demand Share</span>
        <span class="mono font-bold text-[#36383e] tabular-nums text-[11px]">${Math.round(entity.relativeDemand * 100)}%</span>
      </div>`;
  }

  const demandChannelHtml = entity.palette
    ? `
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Demand Channel</span>
      <span class="flex items-center gap-1.5 font-bold text-[#36383e] tabular-nums">
        <span class="w-2.5 h-2.5 rounded-xs inline-block" style="background:${entity.palette.roof}; border-bottom: 2px solid ${entity.palette.base}"></span>
        <span>${entity.palette.name} • ${entity.pinsCount} Bays</span>
      </span>
    </div>`
    : "";

  const municipalityHtml = hostTown
    ? `
    <button type="button" data-jump-town="${hostTown.id}" class="font-bold text-[#36383e] hover:text-[#e85c90] underline underline-offset-2 transition flex items-center gap-1">
      <span>${hostTown.name} (Tier ${hostTown.tier})</span>
      <svg class="w-3 h-3" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
    </button>`
    : '<span class="font-bold text-[#36383e]">Unincorporated</span>';

  const bodyHtml = `
  <div class="flex items-center gap-1">${pipelineHtml}</div>

  <div class="divide-y divide-stone-300/60 border-y border-stone-300/60">
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Municipality</span>
      ${municipalityHtml}
    </div>
    ${demandChannelHtml}
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">${siteMetricLabel}</span>
      <span class="mono font-bold text-[#36383e] tabular-nums">${siteMetricVal}</span>
    </div>
    ${commodityRowHtml}
  </div>

  ${
    allLinksHtml
      ? `
    <div class="space-y-1.5">
      <div class="flex items-center justify-between text-[11px] font-bold text-stone-600">
        <span>Cargo Links (${inboundLinks.length} In, ${outboundLinks.length} Out)</span>
      </div>
      <div class="space-y-1 max-h-36 overflow-y-auto drawer-scroll pr-0.5">
        ${allLinksHtml}
      </div>
    </div>
  `
      : ""
  }
`;

  return {
    badgeText,
    badgeClass,
    codeText,
    titleText,
    bodyHtml,
  };
}
