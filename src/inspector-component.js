/**
 * Light-DOM Entity Inspector Custom Element and Dossier Formatting for Mini Logistics.
 *
 * Invariants:
 * - Operates strictly in Light DOM without Shadow DOM encapsulation so Tailwind CSS rules apply.
 * - Subscribes to the app store's `inspected` slice via `shallowEqual` comparator.
 * - Handles navigation event delegation for supply-chain links, towns, and airports.
 *
 * @import {
 *   Airport,
 *   Destination,
 *   InspectedEntity,
 *   InspectedSelection,
 *   Town,
 * } from './types.js'
 * @import { ProceduralLogisticsWorld } from './world-generator.js'
 */

import { shallowEqual } from "./state.js";

/**
 * Derives octant compass sector relative to a host origin point.
 *
 * @param {number} dx
 * @param {number} dy
 * @returns {string}
 */
export function compassSector(dx, dy) {
  if (Math.hypot(dx, dy) < 2.5) return "Core";
  const dirs = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
  const ang = Math.atan2(dy, dx);
  const idx =
    Math.round(((ang + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 0.25)) % 8;
  return dirs[idx];
}

/**
 * Describes building dossier metadata, badges, and display titles.
 *
 * @param {Destination} d
 * @param {ProceduralLogisticsWorld | null} [world]
 * @returns {{
 *   stage: "RAW" | "MFG" | "LOG" | "COM",
 *   badge: string,
 *   badgeClass: string,
 *   shortTag: string,
 *   typeLabel: string,
 *   title: string
 * }}
 */
export function describeBuildingDossier(d, world = null) {
  const effectiveWorld =
    world || (typeof window !== "undefined" ? window.currentWorld : null);
  const hostTown =
    effectiveWorld?.towns && d.townId != null
      ? effectiveWorld.towns[d.townId]
      : null;
  const townName = hostTown ? hostTown.name : "Regional";
  const sec = hostTown
    ? compassSector(d.x - hostTown.x, d.y - hostTown.y)
    : `#${d.id}`;

  if (d.zoneType === "commercial") {
    return {
      stage: "COM",
      badge: d.isCircular ? "CBD · LANDMARK" : "COM · ARTERIAL",
      badgeClass: "bg-blue-700 text-white",
      shortTag: d.isCircular ? "CBD" : "COM",
      typeLabel: d.isCircular ? `CBD Plaza (${sec})` : `Commercial (${sec})`,
      title: d.isCircular
        ? `${townName} CBD Plaza (${sec})`
        : `${townName} Commercial (${sec})`,
    };
  }
  if (d.subType === "RAW") {
    if (d.resourceType === "MINE") {
      return {
        stage: "RAW",
        badge: "RAW · MINE",
        badgeClass: "bg-amber-700 text-white",
        shortTag: "MINE",
        typeLabel: `Quarry (${sec})`,
        title: `${townName} Quarry (${sec})`,
      };
    }
    if (d.resourceType === "TIMBER") {
      return {
        stage: "RAW",
        badge: "RAW · TIMBER",
        badgeClass: "bg-amber-700 text-white",
        shortTag: "WOOD",
        typeLabel: `Sawmill (${sec})`,
        title: `${townName} Sawmill (${sec})`,
      };
    }
    if (d.resourceType === "FARM") {
      return {
        stage: "RAW",
        badge: "RAW · FARM",
        badgeClass: "bg-amber-700 text-white",
        shortTag: "FARM",
        typeLabel: `Farm (${sec})`,
        title: `${townName} Farm (${sec})`,
      };
    }
    return {
      stage: "RAW",
      badge: "RAW · CHEM",
      badgeClass: "bg-amber-700 text-white",
      shortTag: "CHEM",
      typeLabel: `Chem (${sec})`,
      title: `${townName} Chemical Plant (${sec})`,
    };
  }
  if (d.subType === "LOG") {
    return {
      stage: "LOG",
      badge: "LOG · HUB",
      badgeClass: "bg-purple-700 text-white",
      shortTag: "LOG",
      typeLabel: `Depot (${sec})`,
      title: `${townName} Logistics Hub (${sec})`,
    };
  }
  return {
    stage: "MFG",
    badge: "MFG · FACTORY",
    badgeClass: "bg-orange-700 text-white",
    shortTag: "MFG",
    typeLabel: `Factory (${sec})`,
    title: `${townName} Factory (${sec})`,
  };
}

const BaseElement =
  typeof HTMLElement !== "undefined"
    ? HTMLElement
    : /** @type {typeof HTMLElement} */ (/** @type {unknown} */ (Object));

/**
 * Custom Element wrapping and managing the Entity Inspector card.
 */
export class EntityInspectorElement extends BaseElement {
  constructor() {
    super();
    /** @type {HTMLElement | null} */
    this.cardEl = null;
    /** @type {HTMLElement | null} */
    this.badgeEl = null;
    /** @type {HTMLElement | null} */
    this.codeEl = null;
    /** @type {HTMLElement | null} */
    this.titleEl = null;
    /** @type {HTMLElement | null} */
    this.bodyEl = null;
    /** @type {HTMLElement | null} */
    this.focusBtn = null;
    /** @type {HTMLElement | null} */
    this.closeBtn = null;
    /** @type {(() => void) | null} */
    this._unsubscribe = null;
    /** @type {{
     *   store?: {
     *     getState: () => import('./types.js').AppState,
     *     setInspected: (type: string | null, entity: InspectedEntity | null) => boolean,
     *     subscribe: (select: (s: import('./types.js').AppState) => any, listener: (next: any, prev: any) => void, equals?: (a: any, b: any) => boolean) => () => void
     *   },
     *   getWorld?: () => ProceduralLogisticsWorld | null,
     *   onFocus?: (type: string | null, entity: InspectedEntity | null) => void,
     *   onSelectEntity?: (type: string, entity: InspectedEntity, shouldFocus?: boolean) => void,
     *   onClose?: () => void
     * } | null} */
    this.options = null;

    /** @type {(e: Event) => void} */
    this._onClick = (e) => {
      this._handleClick(e);
    };
  }

  /**
   * Attaches store and container options to the custom element.
   *
   * @param {HTMLElement} cardEl
   * @param {{
   *   store?: {
   *     getState: () => import('./types.js').AppState,
   *     setInspected: (type: string | null, entity: InspectedEntity | null) => boolean,
   *     subscribe: (select: (s: import('./types.js').AppState) => any, listener: (next: any, prev: any) => void, equals?: (a: any, b: any) => boolean) => () => void
   *   },
   *   getWorld?: () => ProceduralLogisticsWorld | null,
   *   onFocus?: (type: string | null, entity: InspectedEntity | null) => void,
   *   onSelectEntity?: (type: string, entity: InspectedEntity, shouldFocus?: boolean) => void,
   *   onClose?: () => void
   * }} options
   */
  attachHost(cardEl, options) {
    this.cardEl = cardEl;
    this.options = options;

    this.badgeEl = this.querySelector("#inspBadge");
    this.codeEl = this.querySelector("#inspCode");
    this.titleEl = this.querySelector("#inspTitle");
    this.bodyEl = this.querySelector("#inspBody");
    this.focusBtn = this.querySelector("#focusInspectorBtn");
    this.closeBtn = this.querySelector("#closeInspectorBtn");

    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }

    if (options.store) {
      this._unsubscribe = options.store.subscribe(
        (s) => s.inspected,
        (inspected) => {
          this.render(inspected, options.getWorld ? options.getWorld() : null);
        },
        shallowEqual,
      );

      const initial = options.store.getState().inspected;
      this.render(initial, options.getWorld ? options.getWorld() : null);
    }
  }

  connectedCallback() {
    this.addEventListener("click", this._onClick);
  }

  disconnectedCallback() {
    this.removeEventListener("click", this._onClick);
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  /**
   * Delegated click handler for inspector controls and jump links.
   *
   * @param {Event} e
   */
  _handleClick(e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    if (target.closest("#closeInspectorBtn")) {
      if (this.options?.onClose) {
        this.options.onClose();
      } else if (this.options?.store) {
        this.options.store.setInspected(null, null);
      }
      return;
    }

    if (target.closest("#focusInspectorBtn")) {
      const inspected = this.options?.store?.getState().inspected;
      if (inspected?.entity && this.options?.onFocus) {
        this.options.onFocus(inspected.type, inspected.entity);
      }
      return;
    }

    const destBtn = /** @type {HTMLElement | null} */ (
      target.closest("[data-jump-dest]")
    );
    if (destBtn) {
      const destId = Number(destBtn.dataset.jumpDest);
      const world = this.options?.getWorld ? this.options.getWorld() : null;
      const targetDest = world?.destinations?.find((d) => d.id === destId);
      if (targetDest) {
        if (this.options?.onSelectEntity) {
          this.options.onSelectEntity("building", targetDest, true);
        } else if (this.options?.store) {
          this.options.store.setInspected("building", targetDest);
          if (this.options?.onFocus)
            this.options.onFocus("building", targetDest);
        }
      }
      return;
    }

    const townBtn = /** @type {HTMLElement | null} */ (
      target.closest("[data-jump-town]")
    );
    if (townBtn) {
      const townId = Number(townBtn.dataset.jumpTown);
      const world = this.options?.getWorld ? this.options.getWorld() : null;
      const targetTown = world?.towns ? world.towns[townId] : null;
      if (targetTown) {
        if (this.options?.onSelectEntity) {
          this.options.onSelectEntity("town", targetTown, true);
        } else if (this.options?.store) {
          this.options.store.setInspected("town", targetTown);
          if (this.options?.onFocus) this.options.onFocus("town", targetTown);
        }
      }
      return;
    }

    const apBtn = /** @type {HTMLElement | null} */ (
      target.closest("[data-jump-ap]")
    );
    if (apBtn) {
      const apId = Number(apBtn.dataset.jumpAp);
      const world = this.options?.getWorld ? this.options.getWorld() : null;
      const targetAp = world?.airports?.find((a) => a.id === apId);
      if (targetAp) {
        if (this.options?.onSelectEntity) {
          this.options.onSelectEntity("airport", targetAp, true);
        } else if (this.options?.store) {
          this.options.store.setInspected("airport", targetAp);
          if (this.options?.onFocus) this.options.onFocus("airport", targetAp);
        }
      }
    }
  }

  /**
   * Renders the inspected entity dossier.
   *
   * @param {InspectedSelection | null} inspected
   * @param {ProceduralLogisticsWorld | null} [world]
   */
  render(inspected, world = null) {
    const card =
      this.cardEl ||
      this.closest("#inspectorCard") ||
      document.getElementById("inspectorCard");
    const badge = this.badgeEl || this.querySelector("#inspBadge");
    const code = this.codeEl || this.querySelector("#inspCode");
    const title = this.titleEl || this.querySelector("#inspTitle");
    const body = this.bodyEl || this.querySelector("#inspBody");

    if (!inspected || !inspected.entity) {
      if (card) {
        card.classList.add("hidden");
        card.toggleAttribute("inert", true);
      }
      return;
    }

    if (card) {
      card.classList.remove("hidden");
      card.toggleAttribute("inert", false);
    }

    const entity = inspected.entity;
    const rawType = /** @type {string | null} */ (inspected.type);
    const normalizedType = rawType === "resource" ? "building" : rawType;

    if (normalizedType === "airport") {
      this._renderAirport(
        /** @type {Airport} */ (entity),
        world,
        badge,
        code,
        title,
        body,
      );
    } else if (normalizedType === "building") {
      this._renderBuilding(
        /** @type {Destination} */ (entity),
        world,
        badge,
        code,
        title,
        body,
      );
    } else if (normalizedType === "town") {
      this._renderTown(
        /** @type {Town} */ (entity),
        world,
        badge,
        code,
        title,
        body,
      );
    }
  }

  /**
   * @param {Airport} entity
   * @param {ProceduralLogisticsWorld | null} world
   * @param {HTMLElement | null} badge
   * @param {HTMLElement | null} code
   * @param {HTMLElement | null} title
   * @param {HTMLElement | null} body
   */
  _renderAirport(entity, world, badge, code, title, body) {
    const hostTown =
      world?.towns && entity.hostTownId != null
        ? world.towns[entity.hostTownId]
        : null;
    if (badge) {
      badge.textContent = entity.classLabel.toUpperCase();
      badge.className =
        "text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md bg-[#e85c90] text-white tracking-wide";
    }
    if (code) {
      code.textContent = `IATA ${entity.iata} • (${Math.round(entity.x)}, ${Math.round(entity.y)})`;
    }
    if (title) {
      title.textContent = entity.name;
    }
    if (body) {
      body.innerHTML = `
      <div class="divide-y divide-stone-300/60 border-y border-stone-300/60">
        <div class="flex items-center justify-between py-1.5">
          <span class="text-stone-500 font-medium">Runways</span>
          <span class="mono font-bold text-[#36383e] tabular-nums">${entity.runwayCount} Parallel • ${entity.runwayLabel}</span>
        </div>
        <div class="flex items-center justify-between py-1.5">
          <span class="text-stone-500 font-medium">Approach Cone</span>
          <span class="mono font-bold text-emerald-700 tabular-nums">${entity.approachClearance}% Clear</span>
        </div>
        <div class="flex items-center justify-between py-1.5">
          <span class="text-stone-500 font-medium">Expressway Spur</span>
          <span class="mono font-bold text-[#36383e] tabular-nums">Motorway ${entity.motorwayId || 1} (${entity.distToCBD} tiles to CBD)</span>
        </div>
        ${
          hostTown
            ? `
        <div class="flex items-center justify-between py-1.5">
          <span class="text-stone-500 font-medium">Municipality</span>
          <button type="button" data-jump-town="${hostTown.id}" class="font-bold text-[#36383e] hover:text-[#e85c90] underline underline-offset-2 transition flex items-center gap-1">
            <span>${hostTown.name} (Tier ${hostTown.tier})</span>
            <svg class="w-3 h-3" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
          </button>
        </div>`
            : ""
        }
      </div>
    `;
    }
  }

  /**
   * @param {Destination} entity
   * @param {ProceduralLogisticsWorld | null} world
   * @param {HTMLElement | null} badge
   * @param {HTMLElement | null} code
   * @param {HTMLElement | null} title
   * @param {HTMLElement | null} body
   */
  _renderBuilding(entity, world, badge, code, title, body) {
    const info = describeBuildingDossier(entity, world);
    const hostTown =
      world?.towns && entity.townId != null ? world.towns[entity.townId] : null;
    const allLinks = world?.cargoLinks || [];
    const inboundLinks = allLinks.filter((l) => l.to.id === entity.id);
    const outboundLinks = allLinks.filter((l) => l.from.id === entity.id);

    if (badge) {
      badge.textContent = info.badge;
      badge.className = `text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md ${info.badgeClass} tracking-wide`;
    }
    if (code) {
      code.textContent = `LOT #${entity.id} • (${entity.gx}, ${entity.gy})`;
    }
    if (title) {
      title.textContent = info.title;
    }

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
    let siteMetricLabel = "Footprint & Access";
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
     * @param {import('./types.js').CargoLink} link
     * @param {"in" | "out"} dir
     */
    const renderLinkRow = (link, dir) => {
      const partner = dir === "in" ? link.from : link.to;
      const pInfo = describeBuildingDossier(partner, world);
      const distTiles = (link.points || []).length;
      const dirBadge =
        dir === "in"
          ? `<span class="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 shrink-0">← ${pInfo.shortTag} #${partner.id}</span>`
          : `<span class="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 shrink-0">→ ${pInfo.shortTag} #${partner.id}</span>`;
      return `
        <button type="button" data-jump-dest="${partner.id}" class="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-white/80 hover:bg-white border border-stone-300/70 hover:border-stone-500 text-left transition group">
          <div class="flex items-center gap-2 min-w-0">
            ${dirBadge}
            <span class="font-bold text-[#36383e] group-hover:text-[#e85c90] truncate">${pInfo.title}</span>
          </div>
          <div class="flex items-center gap-1 shrink-0">
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

    if (body) {
      body.innerHTML = `
      <div class="flex items-center gap-1">${pipelineHtml}</div>

      <div class="divide-y divide-stone-300/60 border-y border-stone-300/60">
        <div class="flex items-center justify-between py-1.5">
          <span class="text-stone-500 font-medium">Municipality</span>
          ${
            hostTown
              ? `
            <button type="button" data-jump-town="${hostTown.id}" class="font-bold text-[#36383e] hover:text-[#e85c90] underline underline-offset-2 transition flex items-center gap-1">
              <span>${hostTown.name} (Tier ${hostTown.tier})</span>
              <svg class="w-3 h-3" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            </button>
          `
              : '<span class="font-bold text-[#36383e]">Unincorporated</span>'
          }
        </div>
        <div class="flex items-center justify-between py-1.5">
          <span class="text-stone-500 font-medium">Demand Channel</span>
          <span class="flex items-center gap-1.5 font-bold text-[#36383e] tabular-nums">
            <span class="w-2.5 h-2.5 rounded-xs inline-block" style="background:${entity.palette.roof}; border-bottom: 2px solid ${entity.palette.base}"></span>
            <span>${entity.palette.name} • ${entity.pinsCount} Bays</span>
          </span>
        </div>
        <div class="flex items-center justify-between py-1.5">
          <span class="text-stone-500 font-medium">${siteMetricLabel}</span>
          <span class="mono font-bold text-[#36383e] tabular-nums">${siteMetricVal}</span>
        </div>
      </div>

      ${
        allLinksHtml
          ? `
        <div class="space-y-1.5">
          <div class="flex items-center justify-between text-[11px] font-bold text-stone-600">
            <span>Cargo Links (${inboundLinks.length} In, ${outboundLinks.length} Out)</span>
            <span class="text-[10px] font-normal text-stone-500">Click to jump</span>
          </div>
          <div class="space-y-1 max-h-36 overflow-y-auto drawer-scroll pr-0.5">
            ${allLinksHtml}
          </div>
        </div>
      `
          : `
        <div class="text-[11px] text-stone-500">
          Local <b>${entity.palette.name}</b> commuter &amp; retail destination in <b>${hostTown ? hostTown.name : "the district"}</b>.
        </div>
      `
      }
    `;
    }
  }

  /**
   * @param {Town} entity
   * @param {ProceduralLogisticsWorld | null} world
   * @param {HTMLElement | null} badge
   * @param {HTMLElement | null} code
   * @param {HTMLElement | null} title
   * @param {HTMLElement | null} body
   */
  _renderTown(entity, world, badge, code, title, body) {
    if (badge) {
      badge.textContent = `TIER ${entity.tier} · ${entity.tierTitle.toUpperCase()}`;
      badge.className =
        "text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md bg-[#36383e] text-white tracking-wide";
    }
    if (code) {
      code.textContent = `CODE ${entity.iata} • (${Math.round(entity.x)}, ${Math.round(entity.y)})`;
    }
    if (title) {
      title.textContent = entity.name;
    }

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
          d.townId === entity.id &&
          (d.zoneType === "industrial" || d.isCircular),
      )
      .sort((a, b) => (b.isRuralNiche ? 1 : 0) - (a.isRuralNiche ? 1 : 0))
      .slice(0, 6);

    const facChipsHtml = townFacilities
      .map((d) => {
        const fInfo = describeBuildingDossier(d, world);
        return `
        <button type="button" data-jump-dest="${d.id}" class="flex items-center justify-between gap-1.5 px-2 py-1 rounded-lg bg-white/80 hover:bg-white border border-stone-300/70 hover:border-stone-500 text-left transition group">
          <span class="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded ${fInfo.badgeClass} shrink-0">${fInfo.shortTag} #${d.id}</span>
          <span class="text-[11px] font-bold text-[#36383e] group-hover:text-[#e85c90] truncate flex-1">${fInfo.typeLabel}</span>
          <svg class="w-3 h-3 text-stone-400 group-hover:text-[#36383e] shrink-0" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
        </button>
      `;
      })
      .join("");

    if (body) {
      body.innerHTML = `
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
          <span class="text-stone-500 font-medium">Urban Grid &amp; Fit</span>
          <span class="mono font-bold text-[#36383e] tabular-nums">${(entity.boroughs || []).length || 1} Boroughs • ${entity.suitabilityScore}% Fit</span>
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
            <span class="text-[10px] font-normal text-stone-500">Click to jump</span>
          </div>
          <div class="grid grid-cols-2 gap-1.5">
            ${facChipsHtml}
          </div>
        </div>
      `
          : ""
      }
    `;
    }
  }
}

if (
  typeof customElements !== "undefined" &&
  !customElements.get("ml-entity-inspector")
) {
  customElements.define("ml-entity-inspector", EntityInspectorElement);
}

/**
 * Mounts `<ml-entity-inspector>` inside `#inspectorCard`, wrapping its inner content
 * and subscribing it to store state.
 *
 * @param {HTMLElement} cardEl
 * @param {{
 *   store?: {
 *     getState: () => import('./types.js').AppState,
 *     setInspected: (type: string | null, entity: InspectedEntity | null) => boolean,
 *     subscribe: (select: (s: import('./types.js').AppState) => any, listener: (next: any, prev: any) => void, equals?: (a: any, b: any) => boolean) => () => void
 *   },
 *   getWorld?: () => ProceduralLogisticsWorld | null,
 *   onFocus?: (type: string | null, entity: InspectedEntity | null) => void,
 *   onSelectEntity?: (type: string, entity: InspectedEntity, shouldFocus?: boolean) => void,
 *   onClose?: () => void
 * }} options
 * @returns {EntityInspectorElement}
 */
export function mountEntityInspector(cardEl, options) {
  let inspector = /** @type {EntityInspectorElement | null} */ (
    cardEl.querySelector("ml-entity-inspector")
  );
  if (!inspector) {
    inspector = /** @type {EntityInspectorElement} */ (
      document.createElement("ml-entity-inspector")
    );
    inspector.style.display = "contents";
    while (cardEl.firstChild) {
      inspector.appendChild(cardEl.firstChild);
    }
    cardEl.appendChild(inspector);
  }
  inspector.attachHost(cardEl, options);
  return inspector;
}
