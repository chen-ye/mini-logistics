/**
 * Single Source of Truth for RCI Building Archetypes, Commodities, Lot Naming,
 * Stage Colors, Building Dossiers, and Badge Classifications.
 *
 * Invariants:
 * - 100% Worker-safe and headless-safe: zero references to window, document, or DOM APIs.
 * - Centralizes RAW resource niches, MFG archetypes, finished goods catalogs, and cargo stage colors.
 * - Provides building dossiers and partner badge classes matching dom-contract and world-invariants specs.
 *
 * @import {
 *   Destination,
 *   CargoLink,
 *   RawGood,
 *   FinishedGood,
 *   TradeGood,
 *   MfgArchetypeKey,
 * } from "../../types.js"
 * @import { ProceduralLogisticsWorld } from "../../world-generator.js"
 */

import { MFG_ARCHETYPES, FINISHED_GOODS_ORDER } from "../../constants.js";

export { MFG_ARCHETYPES, FINISHED_GOODS_ORDER };

/**
 * @typedef {{
 *   key: "MINE" | "TIMBER" | "FARM" | "FISHERY" | "CHEM",
 *   resourceType: "MINE" | "TIMBER" | "FARM" | "FISHERY" | "CHEM",
 *   producesGood: RawGood,
 *   outputGood: RawGood,
 *   pillLabel: string,
 *   fillColor: string,
 *   baseColor: string,
 *   roofAccent: string,
 *   roofColor: string,
 *   pinColor: string,
 *   badgeBg: string,
 *   defaultName: string,
 *   typeLabel: string,
 *   subType: "RAW",
 *   badge: string,
 *   badgeClass: string,
 *   partnerBadgeClass: string,
 * }} RawNicheSpec
 */

/**
 * Frozen catalog for rural RAW resource extraction niches.
 *
 * @type {Readonly<Record<"MINE" | "TIMBER" | "FARM" | "FISHERY" | "CHEM", RawNicheSpec>>}
 */
export const RAW_NICHE_SPECS = Object.freeze({
  MINE: Object.freeze({
    key: "MINE",
    resourceType: "MINE",
    producesGood: "ORE",
    outputGood: "ORE",
    pillLabel: "MINE",
    fillColor: "#b45309",
    baseColor: "#b45309",
    roofAccent: "#f59e0b",
    roofColor: "#f59e0b",
    pinColor: "#78350f",
    badgeBg: "#d97706",
    defaultName: "Quarry",
    typeLabel: "Quarry",
    subType: "RAW",
    badge: "RAW · MINE",
    badgeClass: "bg-amber-700 text-white",
    partnerBadgeClass: "bg-amber-100 text-amber-900",
  }),
  TIMBER: Object.freeze({
    key: "TIMBER",
    resourceType: "TIMBER",
    producesGood: "WOOD",
    outputGood: "WOOD",
    pillLabel: "WOOD",
    fillColor: "#b45309",
    baseColor: "#b45309",
    roofAccent: "#f59e0b",
    roofColor: "#f59e0b",
    pinColor: "#78350f",
    badgeBg: "#d97706",
    defaultName: "Sawmill",
    typeLabel: "Sawmill",
    subType: "RAW",
    badge: "RAW · TIMBER",
    badgeClass: "bg-amber-700 text-white",
    partnerBadgeClass: "bg-amber-100 text-amber-900",
  }),
  FARM: Object.freeze({
    key: "FARM",
    resourceType: "FARM",
    producesGood: "AGRI",
    outputGood: "AGRI",
    pillLabel: "FARM",
    fillColor: "#b45309",
    baseColor: "#b45309",
    roofAccent: "#f59e0b",
    roofColor: "#f59e0b",
    pinColor: "#78350f",
    badgeBg: "#d97706",
    defaultName: "Farm",
    typeLabel: "Farm",
    subType: "RAW",
    badge: "RAW · FARM",
    badgeClass: "bg-amber-700 text-white",
    partnerBadgeClass: "bg-amber-100 text-amber-900",
  }),
  FISHERY: Object.freeze({
    key: "FISHERY",
    resourceType: "FISHERY",
    producesGood: "AGRI",
    outputGood: "AGRI",
    pillLabel: "FISH",
    fillColor: "#155e75",
    baseColor: "#155e75",
    roofAccent: "#0891b2",
    roofColor: "#0891b2",
    pinColor: "#164e63",
    badgeBg: "#0e7490",
    defaultName: "Fishery",
    typeLabel: "Fishery",
    subType: "RAW",
    badge: "RAW · FISHERY",
    badgeClass: "bg-cyan-800 text-white",
    partnerBadgeClass: "bg-cyan-100 text-cyan-900",
  }),
  CHEM: Object.freeze({
    key: "CHEM",
    resourceType: "CHEM",
    producesGood: "CHEM",
    outputGood: "CHEM",
    pillLabel: "CHEM",
    fillColor: "#3f6212",
    baseColor: "#3f6212",
    roofAccent: "#65a30d",
    roofColor: "#65a30d",
    pinColor: "#365314",
    badgeBg: "#4d7c0f",
    defaultName: "Chemical Plant",
    typeLabel: "Chem",
    subType: "RAW",
    badge: "RAW · CHEM",
    badgeClass: "bg-lime-800 text-white",
    partnerBadgeClass: "bg-lime-100 text-lime-900",
  }),
});

/**
 * Freezes an array of trade goods with strict typing.
 *
 * @param {readonly TradeGood[]} items
 * @returns {readonly TradeGood[]}
 */
function freezeTradeGoods(items) {
  return Object.freeze(items);
}

/**
 * Creates an array of plant names with custom string conversion.
 *
 * @param {readonly string[]} names
 * @returns {readonly string[]}
 */
function createPlantNamesArray(names) {
  const arr = [...names];
  Object.defineProperty(arr, "toString", {
    value() {
      return arr[0] || "";
    },
    writable: false,
    enumerable: false,
  });
  return Object.freeze(arr);
}

/**
 * @typedef {{
 *   key: MfgArchetypeKey,
 *   mfgType: MfgArchetypeKey,
 *   tier: 1 | 2,
 *   mfgTier: 1 | 2,
 *   inputs: readonly TradeGood[],
 *   requiredInputs: readonly TradeGood[],
 *   output: FinishedGood,
 *   outputGood: FinishedGood,
 *   pillLabel: string,
 *   fillColor: string,
 *   baseColor: string,
 *   roofAccent: string,
 *   roofColor: string,
 *   pinColor: string,
 *   badgeBg: string,
 *   plantNames: readonly string[],
 *   plantName: string,
 *   defaultName: string,
 *   label: string,
 *   badge: string,
 *   badgeClass: string,
 *   partnerBadgeClass: string,
 * }} MfgSpec
 */

/**
 * Frozen catalog for manufacturing factory archetypes.
 *
 * @type {Readonly<Record<MfgArchetypeKey, MfgSpec>>}
 */
export const MFG_SPECS = Object.freeze({
  STEEL: Object.freeze({
    key: "STEEL",
    mfgType: "STEEL",
    tier: 1,
    mfgTier: 1,
    inputs: freezeTradeGoods(["ORE", "WOOD"]),
    requiredInputs: freezeTradeGoods(["ORE", "WOOD"]),
    output: "HARDWARE",
    outputGood: "HARDWARE",
    pillLabel: "STEEL",
    fillColor: "#c2410c",
    baseColor: "#c2410c",
    roofAccent: "#ea580c",
    roofColor: "#ea580c",
    pinColor: "#7c2d12",
    badgeBg: "#ea580c",
    plantNames: createPlantNamesArray([
      "Steel Mill",
      "Steel & Hardware Foundry",
    ]),
    plantName: "Steel Mill",
    defaultName: "Steel Mill",
    label: "Steel & Hardware Foundry",
    badge: "MFG · STEEL",
    badgeClass: "bg-orange-700 text-white",
    partnerBadgeClass: "bg-orange-100 text-orange-900",
  }),
  FOOD: Object.freeze({
    key: "FOOD",
    mfgType: "FOOD",
    tier: 1,
    mfgTier: 1,
    inputs: freezeTradeGoods(["AGRI", "CHEM"]),
    requiredInputs: freezeTradeGoods(["AGRI", "CHEM"]),
    output: "GROCERIES",
    outputGood: "GROCERIES",
    pillLabel: "FOOD",
    fillColor: "#c2410c",
    baseColor: "#c2410c",
    roofAccent: "#ea580c",
    roofColor: "#ea580c",
    pinColor: "#7c2d12",
    badgeBg: "#ea580c",
    plantNames: createPlantNamesArray(["Food Processing Plant"]),
    plantName: "Food Processing Plant",
    defaultName: "Food Processing Plant",
    label: "Food Processing Plant",
    badge: "MFG · FOOD",
    badgeClass: "bg-orange-700 text-white",
    partnerBadgeClass: "bg-orange-100 text-orange-900",
  }),
  GOODS: Object.freeze({
    key: "GOODS",
    mfgType: "GOODS",
    tier: 2,
    mfgTier: 2,
    inputs: freezeTradeGoods(["WOOD", "HARDWARE"]),
    requiredInputs: freezeTradeGoods(["WOOD", "HARDWARE"]),
    output: "CONSUMER_GOODS",
    outputGood: "CONSUMER_GOODS",
    pillLabel: "GOODS",
    fillColor: "#c2410c",
    baseColor: "#c2410c",
    roofAccent: "#ea580c",
    roofColor: "#ea580c",
    pinColor: "#7c2d12",
    badgeBg: "#ea580c",
    plantNames: createPlantNamesArray(["Consumer Goods Factory"]),
    plantName: "Consumer Goods Factory",
    defaultName: "Consumer Goods Factory",
    label: "Consumer Goods Factory",
    badge: "MFG · GOODS",
    badgeClass: "bg-orange-700 text-white",
    partnerBadgeClass: "bg-orange-100 text-orange-900",
  }),
  TECH: Object.freeze({
    key: "TECH",
    mfgType: "TECH",
    tier: 2,
    mfgTier: 2,
    inputs: freezeTradeGoods(["CHEM", "HARDWARE"]),
    requiredInputs: freezeTradeGoods(["CHEM", "HARDWARE"]),
    output: "ELECTRONICS",
    outputGood: "ELECTRONICS",
    pillLabel: "TECH",
    fillColor: "#c2410c",
    baseColor: "#c2410c",
    roofAccent: "#ea580c",
    roofColor: "#ea580c",
    pinColor: "#7c2d12",
    badgeBg: "#ea580c",
    plantNames: createPlantNamesArray(["Tech Foundry", "Electronics Assembly"]),
    plantName: "Tech Foundry",
    defaultName: "Tech Foundry",
    label: "Electronics Assembly",
    badge: "MFG · TECH",
    badgeClass: "bg-orange-700 text-white",
    partnerBadgeClass: "bg-orange-100 text-orange-900",
  }),
});

/**
 * @typedef {{
 *   key: FinishedGood,
 *   label: string,
 *   shortTag: string,
 *   commShort: string,
 *   comName: string,
 *   cbdName: string,
 *   singleBadge: string,
 *   cbdBadge: string,
 * }} FinishedGoodSpec
 */

/**
 * Catalog for retail finished goods, retail naming, and commercial badges.
 *
 * @type {Readonly<Record<FinishedGood, FinishedGoodSpec>>}
 */
export const FINISHED_GOODS_CATALOG = Object.freeze({
  GROCERIES: Object.freeze({
    key: "GROCERIES",
    label: "Fresh Groceries",
    shortTag: "GROC",
    commShort: "FOOD",
    comName: "Grocery Market",
    cbdName: "CBD Food Hall",
    singleBadge: "COM · GROCERY",
    cbdBadge: "CBD · FOOD HALL",
  }),
  CONSUMER_GOODS: Object.freeze({
    key: "CONSUMER_GOODS",
    label: "Consumer Goods",
    shortTag: "DEPT",
    commShort: "GOODS",
    comName: "Department Store",
    cbdName: "CBD Grand Galleria",
    singleBadge: "COM · RETAIL",
    cbdBadge: "CBD · GALLERIA",
  }),
  HARDWARE: Object.freeze({
    key: "HARDWARE",
    label: "Hardware & Tools",
    shortTag: "HDWR",
    commShort: "HDWR",
    comName: "Hardware Depot",
    cbdName: "CBD Builders Exchange",
    singleBadge: "COM · HARDWARE",
    cbdBadge: "CBD · HARDWARE",
  }),
  ELECTRONICS: Object.freeze({
    key: "ELECTRONICS",
    label: "Electronics",
    shortTag: "ELEC",
    commShort: "TECH",
    comName: "Tech Showroom",
    cbdName: "CBD Tech Plaza",
    singleBadge: "COM · ELECTRONICS",
    cbdBadge: "CBD · TECH",
  }),
});

/**
 * Explicit color mapping across freight stages.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const CARGO_STAGE_COLORS = Object.freeze({
  "LOG->COM": "#7c3aed",
  "MFG->COM": "#4f46e5",
  "CBD->CBD": "#0284c7",
  "MFG->LOG": "#ea580c",
  "MFG->MFG": "#e11d48",
  "RAW->MFG": "#d97706",
  "RAW->LOG": "#d97706",
  "IMPORT->COM": "#0d9488",
  "IMPORT->LOG": "#0d9488",
  "IMPORT->MFG": "#0d9488",
  "RAW->EXPORT": "#0d9488",
  "MFG->EXPORT": "#0d9488",
  "LOG->EXPORT": "#0d9488",
});

/**
 * Resolves the display hex color for a cargo freight link stage.
 *
 * @param {string | CargoLink | null | undefined} stageOrLink
 * @returns {string}
 */
export function getCargoStageColor(stageOrLink) {
  const stage =
    typeof stageOrLink === "string" ? stageOrLink : stageOrLink?.stage;
  const linkColor =
    typeof stageOrLink === "object" && stageOrLink !== null
      ? stageOrLink.color
      : null;
  if (linkColor) return linkColor;
  if (!stage) return "#ea580c";
  if (CARGO_STAGE_COLORS[stage]) return CARGO_STAGE_COLORS[stage];
  if (stage === "CBD->CBD") return "#0284c7";
  if (stage.includes("IMPORT") || stage.includes("EXPORT")) return "#0d9488";
  if (stage === "MFG->MFG") return "#e11d48";
  if (stage === "MFG->LOG") return "#ea580c";
  if (stage === "RAW->MFG" || stage === "RAW->LOG") return "#d97706";
  if (stage === "MFG->COM") return "#4f46e5";
  if (stage === "LOG->COM") return "#7c3aed";
  return "#ea580c";
}

/**
 * @typedef {{
 *   label: string,
 *   bg: string,
 *   fg: string,
 *   border: string,
 *   width: number,
 * }} BuildingPillSpec
 */

/**
 * Derives the visual pill badge specification (label, background, foreground, border, width)
 * for a destination building, matching the renderer's RCI overlay and selection highlights.
 *
 * @param {Destination | null | undefined} dest
 * @returns {BuildingPillSpec}
 */
export function getBuildingPillSpec(dest) {
  if (!dest) {
    return {
      label: "BLD",
      bg: "#475569",
      fg: "#ffffff",
      border: "#334155",
      width: 26,
    };
  }

  if (dest.isGatewayProxy) {
    const label = dest.label || "AIR";
    return {
      label,
      bg: "#0d9488",
      fg: "#ffffff",
      border: "#0f766e",
      width: label.length >= 5 ? 34 : label.length >= 4 ? 30 : 26,
    };
  }

  if (dest.zoneType === "commercial") {
    if (dest.isCircular) {
      return {
        label: "CBD",
        bg: "#1d4ed8",
        fg: "#ffffff",
        border: "#1e40af",
        width: 26,
      };
    }
    return {
      label: "COM",
      bg: "#1d4ed8",
      fg: "#ffffff",
      border: "#1e40af",
      width: 26,
    };
  }

  if (dest.subType === "RAW") {
    const res = dest.resourceType;
    if (res === "MINE") {
      return {
        label: "MINE",
        bg: "#d97706",
        fg: "#ffffff",
        border: "#b45309",
        width: 30,
      };
    }
    if (res === "TIMBER") {
      return {
        label: "WOOD",
        bg: "#d97706",
        fg: "#ffffff",
        border: "#b45309",
        width: 30,
      };
    }
    if (res === "FARM") {
      return {
        label: "FARM",
        bg: "#d97706",
        fg: "#ffffff",
        border: "#b45309",
        width: 30,
      };
    }
    if (res === "FISHERY") {
      return {
        label: "FISH",
        bg: "#0e7490",
        fg: "#ffffff",
        border: "#155e75",
        width: 30,
      };
    }
    if (res === "CHEM") {
      return {
        label: "CHEM",
        bg: "#4d7c0f",
        fg: "#ffffff",
        border: "#3f6212",
        width: 30,
      };
    }
    return {
      label: "RAW",
      bg: "#d97706",
      fg: "#ffffff",
      border: "#b45309",
      width: 26,
    };
  }

  if (dest.subType === "LOG") {
    return {
      label: "LOG",
      bg: "#7c3aed",
      fg: "#ffffff",
      border: "#6d28d9",
      width: 26,
    };
  }

  if (dest.subType === "MFG" || dest.zoneType === "industrial") {
    const label = dest.mfgType || dest.subType || "MFG";
    return {
      label,
      bg: "#ea580c",
      fg: "#ffffff",
      border: "#c2410c",
      width: label.length >= 5 ? 34 : label.length >= 4 ? 30 : 26,
    };
  }

  const label = dest.subType || dest.zoneType || "BLD";
  return {
    label,
    bg: "#ea580c",
    fg: "#ffffff",
    border: "#c2410c",
    width: label.length >= 5 ? 34 : label.length >= 4 ? 30 : 26,
  };
}

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
 * @typedef {{
 *   name: string,
 *   badge: string,
 *   shortTag: string,
 * }} CommercialLotDescription
 */

/**
 * Derives a goods-specific commercial lot name, badge, and short tag from `demandedGoods`.
 * Supports both `(demandedGoods, isCircular)` and `(goods, seedVal, isCBD)`.
 *
 * @param {string[] | null | undefined} demandedGoods
 * @param {boolean | number} [isCircularOrSeedVal=false]
 * @param {boolean} [isCBD=false]
 * @returns {CommercialLotDescription}
 */
export function describeCommercialLotByGoods(
  demandedGoods,
  isCircularOrSeedVal = false,
  isCBD = false,
) {
  const isCircular =
    typeof isCircularOrSeedVal === "boolean" ? isCircularOrSeedVal : isCBD;

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
      };
    }
    if (g === "CONSUMER_GOODS") {
      return {
        name: isCircular ? "CBD Grand Galleria" : "Department Store",
        badge: isCircular ? "CBD · GALLERIA" : "COM · RETAIL",
        shortTag: isCircular ? "CBD" : "DEPT",
      };
    }
    if (g === "HARDWARE") {
      return {
        name: isCircular ? "CBD Builders Exchange" : "Hardware Depot",
        badge: isCircular ? "CBD · HARDWARE" : "COM · HARDWARE",
        shortTag: isCircular ? "CBD" : "HDWR",
      };
    }
    if (g === "ELECTRONICS") {
      return {
        name: isCircular ? "CBD Tech Plaza" : "Tech Showroom",
        badge: isCircular ? "CBD · TECH" : "COM · ELECTRONICS",
        shortTag: isCircular ? "CBD" : "ELEC",
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
      };
    }
    if (set.has("CONSUMER_GOODS") && set.has("HARDWARE")) {
      return {
        name: isCircular
          ? "CBD Home & Commerce Rotunda"
          : "Home & Lifestyle Mart",
        badge: isCircular ? "CBD · HOME & GOODS" : "COM · HOME MART",
        shortTag: isCircular ? "CBD" : "HOME",
      };
    }
    if (set.has("HARDWARE") && set.has("ELECTRONICS")) {
      return {
        name: isCircular ? "CBD Tech & Trade Tower" : "Tech & Hardware Mart",
        badge: isCircular ? "CBD · TECH & HDWR" : "COM · TRADE MART",
        shortTag: isCircular ? "CBD" : "TRDE",
      };
    }
    if (set.has("ELECTRONICS") && set.has("GROCERIES")) {
      return {
        name: isCircular ? "CBD Metro Exchange" : "Metro Hypermarket",
        badge: isCircular ? "CBD · FOOD & TECH" : "COM · HYPERMARKET",
        shortTag: isCircular ? "CBD" : "HYPR",
      };
    }
    if (set.has("GROCERIES") && set.has("HARDWARE")) {
      return {
        name: isCircular
          ? "CBD Provision & Trade Hall"
          : "Farm & Builders Supply",
        badge: isCircular ? "CBD · FOOD & HDWR" : "COM · SUPPLY MART",
        shortTag: isCircular ? "CBD" : "SPLY",
      };
    }
    if (set.has("CONSUMER_GOODS") && set.has("ELECTRONICS")) {
      return {
        name: isCircular
          ? "CBD Lifestyle & Tech Plaza"
          : "Lifestyle & Tech Galleria",
        badge: isCircular ? "CBD · GOODS & TECH" : "COM · GALLERIA",
        shortTag: isCircular ? "CBD" : "GALR",
      };
    }
  }

  return {
    name: isCircular ? "CBD Plaza" : "Commercial",
    badge: isCircular ? "CBD · LANDMARK" : "COM · ARTERIAL",
    shortTag: isCircular ? "CBD" : "COM",
  };
}

/**
 * Derives the commercial subtype lot name for urban fabric planning.
 *
 * @param {string[] | null | undefined} demandedGoods
 * @param {boolean} [isCircular=false]
 * @returns {string}
 */
export function nameCommercialSubType(demandedGoods, isCircular = false) {
  return describeCommercialLotByGoods(demandedGoods, isCircular).name;
}

/**
 * @typedef {{
 *   stage: "RAW" | "MFG" | "LOG" | "COM",
 *   badge: string,
 *   badgeClass: string,
 *   shortTag: string,
 *   typeLabel: string,
 *   title: string,
 *   townName?: string,
 * }} BuildingDossier
 */

/**
 * Describes building dossier metadata, badges, and display titles.
 * CRITICAL: Zero fallback to global window / document; purely uses the passed world parameter.
 *
 * @param {Destination} d
 * @param {ProceduralLogisticsWorld | null} [world]
 * @returns {BuildingDossier}
 */
export function describeBuildingDossier(d, world = null) {
  const hostTown =
    world?.towns && d.townId != null ? world.towns[d.townId] : null;
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
      townName,
    };
  }

  if (d.mfgType) {
    const spec = MFG_SPECS[d.mfgType];
    const plantName =
      spec?.plantName ||
      (Array.isArray(spec?.plantNames)
        ? spec.plantNames[0]
        : spec?.plantNames) ||
      `${d.mfgType} Plant`;
    return {
      stage: "MFG",
      badge: `MFG · ${d.mfgType}`,
      badgeClass: "bg-orange-700 text-white",
      shortTag: d.mfgType,
      typeLabel: `${plantName} (${sec})`,
      title: `${townName} ${plantName} (${sec})`,
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
