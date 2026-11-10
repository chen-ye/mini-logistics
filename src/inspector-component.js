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
 * Derives a goods-specific commercial lot name, badge, short tag, and subtitle from `demandedGoods`.
 *
 * @param {string[] | null | undefined} demandedGoods
 * @param {boolean} [isCircular=false]
 * @returns {{ name: string, badge: string, shortTag: string, subtitle: string }}
 */
export function describeCommercialLotByGoods(
  demandedGoods,
  isCircular = false,
) {
  const goods = Array.isArray(demandedGoods)
    ? demandedGoods.filter(Boolean)
    : [];
  if (goods.length === 1) {
    const g = goods[0];
    if (g === "GROCERIES") {
      return {
        name: isCircular ? "CBD Food Hall" : "Grocery Market",
        badge: isCircular ? "CBD · FOOD HALL" : "COM · GROCERY",
        shortTag: isCircular ? "CBD" : "GROC",
        subtitle: "Fresh Groceries & Produce Retail Market",
      };
    }
    if (g === "CONSUMER_GOODS") {
      return {
        name: isCircular ? "CBD Grand Galleria" : "Department Store",
        badge: isCircular ? "CBD · GALLERIA" : "COM · RETAIL",
        shortTag: isCircular ? "CBD" : "DEPT",
        subtitle: "Consumer Goods & Household Merchandise Store",
      };
    }
    if (g === "HARDWARE") {
      return {
        name: isCircular ? "CBD Builders Exchange" : "Hardware Depot",
        badge: isCircular ? "CBD · HARDWARE" : "COM · HARDWARE",
        shortTag: isCircular ? "CBD" : "HDWR",
        subtitle: "Building Materials, Tools & Hardware Store",
      };
    }
    if (g === "ELECTRONICS") {
      return {
        name: isCircular ? "CBD Tech Plaza" : "Tech Showroom",
        badge: isCircular ? "CBD · TECH" : "COM · ELECTRONICS",
        shortTag: isCircular ? "CBD" : "ELEC",
        subtitle: "Consumer Electronics & Digital Retail Showroom",
      };
    }
  }

  if (goods.length >= 2) {
    const set = new Set(goods);
    if (set.has("GROCERIES") && set.has("CONSUMER_GOODS")) {
      return {
        name: isCircular
          ? "CBD Food & Retail Rotunda"
          : "Supermarket & Galleria",
        badge: isCircular ? "CBD · FOOD & GOODS" : "COM · SUPERCENTER",
        shortTag: isCircular ? "CBD" : "MART",
        subtitle: isCircular
          ? "Downtown High-Rise Food Hall & Retail Exchange"
          : "Arterial Groceries & Consumer Goods Supercenter",
      };
    }
    if (set.has("CONSUMER_GOODS") && set.has("HARDWARE")) {
      return {
        name: isCircular
          ? "CBD Home & Commerce Rotunda"
          : "Home & Lifestyle Mart",
        badge: isCircular ? "CBD · HOME & GOODS" : "COM · HOME MART",
        shortTag: isCircular ? "CBD" : "HOME",
        subtitle: isCircular
          ? "Downtown High-Rise Retail, Hardware & B2B Plaza"
          : "Arterial Consumer Goods & Hardware Retail Plaza",
      };
    }
    if (set.has("HARDWARE") && set.has("ELECTRONICS")) {
      return {
        name: isCircular ? "CBD Tech & Trade Tower" : "Tech & Hardware Mart",
        badge: isCircular ? "CBD · TECH & HDWR" : "COM · TRADE MART",
        shortTag: isCircular ? "CBD" : "TRDE",
        subtitle: isCircular
          ? "Downtown High-Rise Electronics, Hardware & B2B Hub"
          : "Arterial Hardware, Tools & Electronics Retail Plaza",
      };
    }
    if (set.has("ELECTRONICS") && set.has("GROCERIES")) {
      return {
        name: isCircular ? "CBD Metro Exchange" : "Metro Hypermarket",
        badge: isCircular ? "CBD · FOOD & TECH" : "COM · HYPERMARKET",
        shortTag: isCircular ? "CBD" : "HYPR",
        subtitle: isCircular
          ? "Downtown High-Rise Groceries, Electronics & B2B Hub"
          : "Arterial Groceries & Electronics Hypermarket",
      };
    }
    if (set.has("GROCERIES") && set.has("HARDWARE")) {
      return {
        name: isCircular
          ? "CBD Provision & Trade Hall"
          : "Farm & Builders Supply",
        badge: isCircular ? "CBD · FOOD & HDWR" : "COM · SUPPLY MART",
        shortTag: isCircular ? "CBD" : "SPLY",
        subtitle: isCircular
          ? "Downtown High-Rise Groceries, Hardware & B2B Hall"
          : "Arterial Groceries & Hardware Supply Plaza",
      };
    }
    if (set.has("CONSUMER_GOODS") && set.has("ELECTRONICS")) {
      return {
        name: isCircular
          ? "CBD Lifestyle & Tech Plaza"
          : "Lifestyle & Tech Galleria",
        badge: isCircular ? "CBD · GOODS & TECH" : "COM · GALLERIA",
        shortTag: isCircular ? "CBD" : "GALR",
        subtitle: isCircular
          ? "Downtown High-Rise Retail, Electronics & B2B Plaza"
          : "Arterial Consumer Goods & Electronics Galleria",
      };
    }
  }

  return {
    name: isCircular ? "CBD Plaza" : "Commercial",
    badge: isCircular ? "CBD · LANDMARK" : "COM · ARTERIAL",
    shortTag: isCircular ? "CBD" : "COM",
    subtitle: isCircular
      ? "Downtown High-Rise & Central Retail Sink"
      : "Arterial Commercial Retail & Services",
  };
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
 *   title: string,
 *   subtitle?: string,
 *   townName?: string
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

  if (d.isGatewayProxy) {
    return {
      stage: "LOG",
      badge: "AIR · GATEWAY",
      badgeClass: "bg-teal-700 text-white",
      shortTag: d.label || "AIR",
      typeLabel: "Trade Gateway",
      title: `${d.label || "Airport"} Cargo Gateway`,
      subtitle: "Multi-Modal Import/Export Terminal",
      townName,
    };
  }

  if (d.zoneType === "commercial") {
    const comSpec = describeCommercialLotByGoods(d.demandedGoods, d.isCircular);
    return {
      stage: "COM",
      badge: comSpec.badge,
      badgeClass: "bg-blue-700 text-white",
      shortTag: comSpec.shortTag,
      typeLabel: `${comSpec.name} (${sec})`,
      title: `${townName} ${comSpec.name} (${sec})`,
      subtitle: comSpec.subtitle,
      townName,
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
        subtitle: "Foothill Aggregate & Ore Extraction",
        townName,
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
        subtitle: "Forestry Timber Stand & Lumber Camp",
        townName,
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
        subtitle: "Alluvial Grain Estate & Agricultural Silos",
        townName,
      };
    }
    if (d.resourceType === "FISHERY") {
      return {
        stage: "RAW",
        badge: "RAW · FISHERY",
        badgeClass: "bg-cyan-800 text-white",
        shortTag: "FISH",
        typeLabel: `Fishery (${sec})`,
        title: `${townName} Fishery (${sec})`,
        subtitle: "Coastal Cold-Storage & Catch Wharf",
        townName,
      };
    }
    return {
      stage: "RAW",
      badge: "RAW · CHEM",
      badgeClass: "bg-lime-800 text-white",
      shortTag: "CHEM",
      typeLabel: `Chem (${sec})`,
      title: `${townName} Chemical Plant (${sec})`,
      subtitle: "Industrial Feedstock & Refining Works",
      townName,
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
      subtitle: "Cross-Dock Freight Distribution Terminal",
      townName,
    };
  }
  if (d.mfgType) {
    const mfgNames = {
      STEEL: "Steel Mill",
      FOOD: "Food Processing Plant",
      GOODS: "Consumer Goods Factory",
      TECH: "Tech Foundry",
    };
    const plantName = mfgNames[d.mfgType] || `${d.mfgType} Plant`;
    return {
      stage: "MFG",
      badge: `MFG · ${d.mfgType}`,
      badgeClass: "bg-orange-700 text-white",
      shortTag: d.mfgType,
      typeLabel: `${plantName} (${sec})`,
      title: `${townName} ${plantName} (${sec})`,
      subtitle: `${d.mfgType} Specialized Manufacturing Plant`,
      townName,
    };
  }
  return {
    stage: "MFG",
    badge: "MFG · FACTORY",
    badgeClass: "bg-orange-700 text-white",
    shortTag: "MFG",
    typeLabel: `Factory (${sec})`,
    title: `${townName} Factory (${sec})`,
    subtitle: "Heavy & Light Manufacturing Plant",
    townName,
  };
}

/**
 * Returns Tailwind badge classes for a cargo link partner building based on stage and resource type.
 *
 * @param {{ stage?: string, badge?: string, shortTag?: string } | string} pInfoOrStage
 * @param {Destination | { resourceType?: string | null, isGatewayProxy?: boolean | null } | string | null} [partner]
 * @returns {string}
 */
export function getPartnerStageBadgeClass(pInfoOrStage, partner = null) {
  const stage =
    typeof pInfoOrStage === "string" ? pInfoOrStage : pInfoOrStage?.stage;
  const pObj =
    typeof pInfoOrStage === "object" && pInfoOrStage !== null
      ? pInfoOrStage
      : null;
  const partnerObj =
    typeof partner === "object" && partner !== null ? partner : null;
  const resourceType =
    typeof partner === "string" ? partner : partnerObj?.resourceType;
  if (
    stage === "AIR" ||
    Boolean(partnerObj?.isGatewayProxy) ||
    pObj?.badge === "AIR · GATEWAY" ||
    pObj?.shortTag === "AIR"
  ) {
    return "bg-teal-100 text-teal-900";
  }
  if (stage === "RAW") {
    if (resourceType === "FISHERY" || pObj?.shortTag === "FISH") {
      return "bg-cyan-100 text-cyan-900";
    }
    if (resourceType === "CHEM" || pObj?.shortTag === "CHEM") {
      return "bg-lime-100 text-lime-900";
    }
    return "bg-amber-100 text-amber-900";
  }
  if (stage === "MFG") {
    return "bg-orange-100 text-orange-900";
  }
  if (stage === "LOG") {
    return "bg-purple-100 text-purple-900";
  }
  if (stage === "COM") {
    return "bg-blue-100 text-blue-900";
  }
  return "bg-amber-100 text-amber-900";
}

/**
 * Computes live gate, taxiway, runway, and inbound telemetry for an inspected airport.
 *
 * @param {Airport} entity
 * @param {ProceduralLogisticsWorld | null} [world]
 * @param {any[] | null} [overridePlanes]
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
  const effectiveWorld =
    world || (typeof window !== "undefined" ? window.currentWorld : null);
  const liveAirport =
    effectiveWorld?.airports?.find((a) => a.id === entity.id) || entity;
  /** @type {any} */
  const atc = /** @type {any} */ (liveAirport).atc;
  /** @type {any[]} */
  const planes = Array.isArray(overridePlanes)
    ? overridePlanes
    : typeof window !== "undefined" &&
        Array.isArray(/** @type {any} */ (window).simulator?.planes)
      ? /** @type {any} */ (window).simulator.planes
      : [];

  const totalGates = atc?.gates?.length || (liveAirport.isHub ? 7 : 4);
  let occupiedGates = 0;
  let reservedGates = 0;
  if (atc?.gates && Array.isArray(atc.gates)) {
    for (const g of atc.gates) {
      if (g.state === "OCCUPIED") occupiedGates++;
      else if (g.state === "RESERVED") reservedGates++;
    }
  } else {
    occupiedGates = planes.filter((/** @type {any} */ p) => {
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
      (Array.isArray(atc.crossingQueue)
        ? atc.crossingQueue.length
        : Array.isArray(atc.runwayCrossQueue)
          ? atc.runwayCrossQueue.length
          : 0);
    if (atc.arrRunwayBusyBy != null) landingCount = 1;
    if (atc.depRunwayBusyBy != null) departingCount = 1;
    inboundCount =
      (Array.isArray(atc.approachQueue)
        ? atc.approachQueue.length
        : Array.isArray(atc.inboundQueue)
          ? atc.inboundQueue.length
          : 0) + landingCount;
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

  const runwaySummary = `${liveAirport.runwayCount} Parallel • ${liveAirport.runwayLabel} (${activeDir})`;
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
   * Updates live telemetry spans inside an open airport inspector card without rebuilding the DOM.
   *
   * @param {ProceduralLogisticsWorld | null} [world]
   * @param {any[] | null} [overridePlanes]
   */
  refreshLiveStats(world = null, overridePlanes = null) {
    const inspected = this.options?.store?.getState().inspected;
    if (!inspected || inspected.type !== "airport" || !inspected.entity) return;

    const effectiveWorld =
      world || (this.options?.getWorld ? this.options.getWorld() : null);
    const status = describeAirportLiveStatus(
      /** @type {Airport} */ (inspected.entity),
      effectiveWorld,
      overridePlanes,
    );

    const rwyEl = this.querySelector("#inspRunwayStats");
    if (rwyEl && rwyEl.textContent !== status.runwaySummary) {
      rwyEl.textContent = status.runwaySummary;
    }
    const gateEl = this.querySelector("#inspGateStats");
    if (gateEl && gateEl.textContent !== status.gateSummary) {
      gateEl.textContent = status.gateSummary;
    }
    const atcEl = this.querySelector("#inspAtcStats");
    if (atcEl && atcEl.textContent !== status.atcSummary) {
      atcEl.textContent = status.atcSummary;
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
    const status = describeAirportLiveStatus(entity, world);
    const liveEntity = status.liveAirport;
    const hostTown =
      world?.towns && liveEntity.hostTownId != null
        ? world.towns[liveEntity.hostTownId]
        : null;
    if (badge) {
      badge.textContent = liveEntity.classLabel.toUpperCase();
      badge.className =
        "text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md bg-[#e85c90] text-white tracking-wide";
    }
    if (code) {
      code.textContent = `IATA ${liveEntity.iata} • (${Math.round(liveEntity.x)}, ${Math.round(liveEntity.y)})`;
    }
    if (title) {
      title.textContent = liveEntity.name;
    }
    if (body) {
      const acceptsWide =
        liveEntity.acceptsWidebody ??
        (liveEntity.isHub || liveEntity.airportClass === "CRG");
      const fleetCapability = acceptsWide
        ? "Wide-Body Freighter + Feeder + Jet"
        : "Feeder Turboprop + Regional Jet (No Wide-Body)";
      const intlTrade = `Intl Trade: ${liveEntity.importsCompleted || 0} Imp · ${liveEntity.exportsCompleted || 0} Exp`;

      const gatewayLinks = (world?.cargoLinks || []).filter(
        (l) =>
          l.from?.airportId === liveEntity.id ||
          l.to?.airportId === liveEntity.id,
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
            <button type="button" data-jump-dest="${partner.id}" class="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-white/80 hover:bg-white border border-stone-300/70 hover:border-stone-500 text-left transition group">
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
            <span class="text-[10px] font-normal text-stone-500">Click to jump</span>
          </div>
          <div class="space-y-1 max-h-36 overflow-y-auto drawer-scroll pr-0.5">
            ${linkRows}
          </div>
        </div>
      `;
      }

      body.innerHTML = `
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
          <span class="mono font-bold text-[#36383e] tabular-nums text-[11px]">${intlTrade}</span>
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
      ${gatewayLinksHtml}
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
        : `data-jump-dest="${partner.id}"`;
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
        ${commodityRowHtml}
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
