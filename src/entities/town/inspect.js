/**
 * Town & Municipality Inspection, Hit Testing, Camera Target, and Dossier Formatting.
 *
 * Invariants:
 * - 100% Worker-safe and headless-safe: zero top-level or runtime window/document/DOM calls.
 * - Operates purely on passed world and town data structures.
 * - Emits pure HTML strings and plain telemetry objects.
 *
 * @import { Town } from '../../types.js'
 * @import { ProceduralLogisticsWorld } from '../../world-generator.js'
 */

import { describeBuildingDossier } from "../rci-building/catalog.js";

/**
 * Resolves a town reference by ID from the world state.
 *
 * @param {number | string} id
 * @param {ProceduralLogisticsWorld | null} world
 * @returns {Town | null}
 */
export function resolveTown(id, world) {
  if (!world?.towns || !Array.isArray(world.towns)) return null;
  if (id === "" || id === null || id === undefined) return null;
  const raw = String(id).trim();
  if (!/^\d+$/.test(raw)) return null;
  const numId = Number(raw);
  return world.towns.find((t) => t.id === numId) || world.towns[numId] || null;
}

/**
 * Hit-tests a town using its urban envelope radius.
 *
 * @param {number} wx
 * @param {number} wy
 * @param {number} pad
 * @param {ProceduralLogisticsWorld | null} world
 * @returns {{ kind: "town", id: number, entity: Town } | null}
 */
export function hitTestTown(wx, wy, pad, world) {
  if (!world?.towns || !Array.isArray(world.towns)) return null;
  for (const t of world.towns) {
    if (Math.hypot(wx - t.x, wy - t.y) <= (t.urbanRadius || 5) + pad) {
      return { kind: "town", id: t.id, entity: t };
    }
  }
  return null;
}

/**
 * Derives camera target parameters for focusing a town.
 *
 * @param {Town} t
 * @returns {{ cx: number, cy: number, x: number, y: number, zoom: number, followLive: boolean }}
 */
export function getTownCameraTarget(t) {
  return {
    cx: t.x,
    cy: t.y,
    x: t.x,
    y: t.y,
    zoom: 1.45,
    followLive: false,
  };
}

/**
 * Returns a live patch dictionary for updating town telemetry elements.
 *
 * @param {Town} _t
 * @param {ProceduralLogisticsWorld | null} [_world]
 * @returns {Record<string, never>}
 */
export function describeTownLivePatch(_t, _world = null) {
  return {};
}

export const describeLivePatch = describeTownLivePatch;

/**
 * Renders a town entity dossier snapshot.
 *
 * @param {Town} entity
 * @param {ProceduralLogisticsWorld | null} [world]
 * @returns {{
 *   badgeText: string,
 *   badgeClass: string,
 *   codeText: string,
 *   titleText: string,
 *   bodyHtml: string
 * }}
 */
export function renderTownDossier(entity, world = null) {
  const badgeText = `TIER ${entity.tier} · ${entity.tierTitle.toUpperCase()}`;
  const badgeClass =
    "text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md bg-[#36383e] text-white tracking-wide";
  const codeText = `CODE ${entity.iata} • (${Math.round(entity.x)}, ${Math.round(entity.y)})`;
  const titleText = entity.name;

  const ap =
    entity.airportId !== null &&
    entity.airportId !== undefined &&
    world?.airports
      ? world.airports[entity.airportId]
      : null;
  const rCount = entity.housesCount || 0;
  const cCount = entity.commercialCount || 0;
  const iCount = entity.industrialCount || 0;
  const totalBld = Math.max(1, rCount + cCount + iCount);
  const rPct = Math.round((rCount / totalBld) * 100);
  const cPct = Math.round((cCount / totalBld) * 100);
  const iPct = Math.max(0, 100 - rPct - cPct);

  const townFacilities = (world?.destinations || [])
    .filter(
      (d) =>
        d.townId === entity.id && (d.zoneType === "industrial" || d.isCircular),
    )
    .sort((a, b) => (b.isRuralNiche ? 1 : 0) - (a.isRuralNiche ? 1 : 0))
    .slice(0, 6);

  const facChipsHtml = townFacilities
    .map((d) => {
      const fInfo = describeBuildingDossier(d, world);
      return `
      <button type="button" data-jump-bldg="${d.id}" data-jump-dest="${d.id}" class="flex items-center justify-between gap-1.5 px-2 py-1 rounded-lg bg-white/80 hover:bg-white border border-stone-300/70 hover:border-stone-500 text-left transition group">
        <span class="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded ${fInfo.badgeClass} shrink-0">${fInfo.shortTag} #${d.id}</span>
        <span class="text-[11px] font-bold text-[#36383e] group-hover:text-[#e85c90] truncate flex-1">${fInfo.typeLabel}</span>
        <svg class="w-3 h-3 text-stone-400 group-hover:text-[#36383e] shrink-0" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
      </button>
    `;
    })
    .join("");

  const bodyHtml = `
  <div class="py-2 border-y border-stone-300/60 space-y-2">
    <div class="h-2 w-full rounded-full overflow-hidden flex bg-stone-300/70">
      <div style="width:${rPct}%" class="bg-emerald-600" title="Residential (${rCount})"></div>
      <div style="width:${cPct}%" class="bg-blue-600" title="Commercial (${cCount})"></div>
      <div style="width:${iPct}%" class="bg-amber-600" title="Industrial (${iCount})"></div>
    </div>
    <div class="flex items-center justify-between text-[11px] tabular-nums">
      <span class="flex items-center gap-1 font-bold text-emerald-800"><span class="w-2 h-2 rounded-xs bg-emerald-600"></span>${rCount} Houses</span>
      <span class="flex items-center gap-1 font-bold text-blue-800"><span class="w-2 h-2 rounded-xs bg-blue-600"></span>${cCount} Commercial</span>
      <span class="flex items-center gap-1 font-bold text-amber-800"><span class="w-2 h-2 rounded-xs bg-amber-600"></span>${iCount} Industrial</span>
    </div>
  </div>

  <div class="divide-y divide-stone-300/60 border-b border-stone-300/60">
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Grid</span>
      <span class="mono font-bold text-[#36383e] tabular-nums">${(entity.boroughs || []).length || 1} Boroughs, ${entity.suitabilityScore}% Fit</span>
    </div>
    ${
      ap
        ? `
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Airport</span>
      <button type="button" data-jump-ap="${ap.id}" class="font-bold text-[#36383e] hover:text-[#e85c90] underline underline-offset-2 transition flex items-center gap-1">
        <span>${ap.name} (${ap.iata})</span>
        <svg class="w-3 h-3" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
      </button>
    </div>`
        : ""
    }
  </div>

  ${
    facChipsHtml
      ? `
    <div class="space-y-1.5">
      <div class="flex items-center justify-between text-[11px] font-bold text-stone-600">
        <span>Industries &amp; Landmarks</span>
      </div>
      <div class="grid grid-cols-2 gap-1.5">
        ${facChipsHtml}
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
