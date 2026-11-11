/**
 * Light-DOM Entity Inspector Custom Element and Dossier Formatting for Mini Logistics.
 *
 * Invariants:
 * - Operates strictly in Light DOM without Shadow DOM encapsulation so Tailwind CSS rules apply.
 * - Subscribes to the app store's `inspected` slice via `shallowEqual` comparator.
 * - Handles navigation event delegation for supply-chain links, towns, airports, planes, and trucks.
 * - 100% free of `window.currentWorld` and `window.simulator` global fallbacks.
 *
 * @import {
 *   Airport,
 *   Destination,
 *   EntityKind,
 *   InspectedEntity,
 *   InspectedSelection,
 *   Town,
 *   PlaneAgent,
 *   CarAgent,
 * } from './types.js'
 * @import { ProceduralLogisticsWorld } from './world-generator.js'
 */

import { shallowEqual } from "./state.js";
import {
  describeAirportLivePatch,
  renderAirportDossier,
  resolveAirport,
} from "./entities/airport/inspect.js";
import {
  renderBuildingDossier,
  resolveBuilding,
} from "./entities/rci-building/inspect.js";
import { renderTownDossier, resolveTown } from "./entities/town/inspect.js";
import {
  renderAircraftDossier,
  resolveAircraft,
  describeAircraftLivePatch,
} from "./entities/aircraft/inspect.js";
import {
  renderRoadVehicleDossier,
  resolveRoadVehicle,
  describeRoadVehicleLivePatch,
} from "./entities/road-vehicle/inspect.js";

// Re-export catalog and inspect utilities for contract and invariant tests
export {
  compassSector,
  describeCommercialLotByGoods,
  describeBuildingDossier,
  getPartnerStageBadgeClass,
} from "./entities/rci-building/catalog.js";
export {
  describeAirportLiveStatus,
  describeAirportLivePatch,
  renderAirportDossier,
  resolveAirport,
  hitTestAirport,
  getAirportCameraTarget,
} from "./entities/airport/inspect.js";
export {
  renderBuildingDossier,
  resolveBuilding,
  hitTestBuilding,
  getBuildingCameraTarget,
} from "./entities/rci-building/inspect.js";
export {
  renderTownDossier,
  resolveTown,
  hitTestTown,
  getTownCameraTarget,
} from "./entities/town/inspect.js";
export {
  renderAircraftDossier,
  resolveAircraft,
  hitTestAircraft,
  getAircraftCameraTarget,
  describeAircraftLiveStatus,
  describeAircraftLivePatch,
} from "./entities/aircraft/inspect.js";
export {
  renderRoadVehicleDossier,
  resolveRoadVehicle,
  hitTestRoadVehicle,
  getRoadVehicleCameraTarget,
  describeRoadVehicleLiveStatus,
  describeRoadVehicleLivePatch,
} from "./entities/road-vehicle/inspect.js";

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
     *   getPlanes?: () => PlaneAgent[],
     *   getSim?: () => any,
     *   onFocus?: (type: string | null, entity: InspectedEntity | null) => void,
     *   onSelectEntity?: (type: string, entity: InspectedEntity, shouldFocus?: boolean) => void,
     *   onJumpRef?: (kind: EntityKind, id: number | string) => void,
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
   *   getPlanes?: () => PlaneAgent[],
   *   getSim?: () => any,
   *   onFocus?: (type: string | null, entity: InspectedEntity | null) => void,
   *   onSelectEntity?: (type: string, entity: InspectedEntity, shouldFocus?: boolean) => void,
   *   onJumpRef?: (kind: EntityKind, id: number | string) => void,
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
    this.closeBtn =
      this.querySelector("#closeInspectorBtn") ||
      this.querySelector("#inspCloseBtn");

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
   * Internal navigation dispatcher for jump buttons.
   *
   * @param {string} type
   * @param {any} entity
   */
  _jumpTo(type, entity) {
    if (!entity) return;
    if (this.options?.onSelectEntity) {
      this.options.onSelectEntity(type, entity, true);
    } else if (this.options?.store) {
      this.options.store.setInspected(type, entity);
      if (this.options?.onFocus) this.options.onFocus(type, entity);
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

    if (target.closest("#closeInspectorBtn, #inspCloseBtn")) {
      if (this.options?.onClose) {
        this.options.onClose();
      } else if (this.options?.store) {
        this.options.store.setInspected(null, null);
      }
      return;
    }

    if (target.closest("#focusInspectorBtn")) {
      const inspected = this.options?.store?.getState().inspected;
      if (this.options?.onFocus && (inspected?.entity || inspected?.type)) {
        this.options.onFocus(inspected.type, inspected.entity);
      }
      return;
    }

    const bldgBtn = /** @type {HTMLElement | null} */ (
      target.closest("[data-jump-bldg], [data-jump-dest]")
    );
    if (bldgBtn) {
      const bldgId = Number(
        bldgBtn.dataset.jumpBldg || bldgBtn.dataset.jumpDest,
      );
      if (this.options?.onJumpRef) {
        this.options.onJumpRef("building", bldgId);
        return;
      }
      const world = this.options?.getWorld ? this.options.getWorld() : null;
      this._jumpTo("building", resolveBuilding(bldgId, world));
      return;
    }

    const townBtn = /** @type {HTMLElement | null} */ (
      target.closest("[data-jump-town]")
    );
    if (townBtn) {
      const townId = Number(townBtn.dataset.jumpTown);
      if (this.options?.onJumpRef) {
        this.options.onJumpRef("town", townId);
        return;
      }
      const world = this.options?.getWorld ? this.options.getWorld() : null;
      this._jumpTo("town", resolveTown(townId, world));
      return;
    }

    const apBtn = /** @type {HTMLElement | null} */ (
      target.closest("[data-jump-ap]")
    );
    if (apBtn) {
      const apId = Number(apBtn.dataset.jumpAp);
      if (this.options?.onJumpRef) {
        this.options.onJumpRef("airport", apId);
        return;
      }
      const world = this.options?.getWorld ? this.options.getWorld() : null;
      this._jumpTo("airport", resolveAirport(apId, world));
      return;
    }

    const planeBtn = /** @type {HTMLElement | null} */ (
      target.closest("[data-jump-plane]")
    );
    if (planeBtn) {
      const planeId = planeBtn.dataset.jumpPlane;
      if (planeId != null) {
        if (this.options?.onJumpRef) {
          this.options.onJumpRef(
            "plane",
            /^\d+$/.test(planeId) ? Number(planeId) : planeId,
          );
          return;
        }
        const world = this.options?.getWorld ? this.options.getWorld() : null;
        const sim = this.options?.getSim ? this.options.getSim() : null;
        this._jumpTo("plane", resolveAircraft(planeId, world, sim));
      }
      return;
    }

    const truckBtn = /** @type {HTMLElement | null} */ (
      target.closest("[data-jump-truck]")
    );
    if (truckBtn) {
      const truckId = truckBtn.dataset.jumpTruck;
      if (truckId != null) {
        if (this.options?.onJumpRef) {
          this.options.onJumpRef(
            "truck",
            /^\d+$/.test(truckId) ? Number(truckId) : truckId,
          );
          return;
        }
        const world = this.options?.getWorld ? this.options.getWorld() : null;
        const sim = this.options?.getSim ? this.options.getSim() : null;
        this._jumpTo("truck", resolveRoadVehicle(truckId, world, sim));
      }
    }
  }

  /**
   * Directly renders a pre-computed dossier snapshot into the element markup.
   *
   * @param {{
   *   badgeText?: string,
   *   badgeClass?: string,
   *   codeText?: string,
   *   titleText?: string,
   *   bodyHtml?: string
   * } | null} dossier
   */
  renderSnapshot(dossier) {
    const card =
      this.cardEl ||
      this.closest("#inspectorCard") ||
      (typeof document !== "undefined"
        ? document.getElementById("inspectorCard")
        : null);
    if (!dossier) {
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
    const badge = this.badgeEl || this.querySelector("#inspBadge");
    const code = this.codeEl || this.querySelector("#inspCode");
    const title = this.titleEl || this.querySelector("#inspTitle");
    const body = this.bodyEl || this.querySelector("#inspBody");

    if (badge) {
      badge.textContent = dossier.badgeText || "";
      if (dossier.badgeClass) badge.className = dossier.badgeClass;
    }
    if (code) code.textContent = dossier.codeText || "";
    if (title) title.textContent = dossier.titleText || "";
    if (body) body.innerHTML = dossier.bodyHtml || "";
  }

  /**
   * Applies an incremental patch dictionary to live telemetry spans in the card.
   *
   * @param {Record<string, any>} patch
   */
  applyLivePatch(patch) {
    if (!patch || typeof patch !== "object") return;
    const keys = [
      ["runwaySummary", "#inspRunwayStats"],
      ["gateSummary", "#inspGateStats"],
      ["atcSummary", "#inspAtcStats"],
      ["stateText", "#inspPlaneState"],
      ["kinematicsText", "#inspPlaneKinematics"],
      ["manifestText", "#inspPlaneManifest"],
      ["gateText", "#inspPlaneGate"],
      ["progressText", "#inspPlaneProgress"],
      ["legText", "#inspTruckLeg"],
      ["speedText", "#inspTruckSpeed"],
      ["layerText", "#inspTruckLayer"],
    ];
    for (const [prop, selector] of keys) {
      if (patch[prop] != null) {
        const el = this.querySelector(selector);
        if (el && el.textContent !== patch[prop]) el.textContent = patch[prop];
      }
    }

    if (patch.titleText != null) {
      const titleEl = this.titleEl || this.querySelector("#inspTitle");
      if (titleEl && titleEl.textContent !== patch.titleText) {
        titleEl.textContent = patch.titleText;
      }
    }
    if (patch.codeText != null) {
      const codeEl = this.codeEl || this.querySelector("#inspCode");
      if (codeEl && codeEl.textContent !== patch.codeText) {
        codeEl.textContent = patch.codeText;
      }
    }
    if (patch.badgeText != null) {
      const badgeEl = this.badgeEl || this.querySelector("#inspBadge");
      if (badgeEl) {
        if (badgeEl.textContent !== patch.badgeText) {
          badgeEl.textContent = patch.badgeText;
        }
        if (patch.badgeClass && badgeEl.className !== patch.badgeClass) {
          badgeEl.className = patch.badgeClass;
        }
      }
    }
    if (patch.terminalsKey != null) {
      const termEl = this.querySelector("#inspPlaneTerminals");
      if (
        termEl &&
        termEl.getAttribute("data-terminals-key") !== patch.terminalsKey
      ) {
        termEl.setAttribute("data-terminals-key", patch.terminalsKey);
        if (patch.terminalsHtml) {
          termEl.innerHTML = patch.terminalsHtml;
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
      (typeof document !== "undefined"
        ? document.getElementById("inspectorCard")
        : null);

    if (!inspected || (!inspected.entity && !inspected.type)) {
      if (card) {
        card.classList.add("hidden");
        card.toggleAttribute("inert", true);
      }
      return;
    }

    if (!inspected.entity) {
      return;
    }

    if (card) {
      card.classList.remove("hidden");
      card.toggleAttribute("inert", false);
    }

    const effectiveWorld =
      world || (this.options?.getWorld ? this.options.getWorld() : null);
    const entity = inspected.entity;
    const rawType = /** @type {string | null} */ (inspected.type);
    const normalizedType = rawType === "resource" ? "building" : rawType;

    /** @type {Record<string, () => any>} */
    const renderers = {
      airport: () =>
        renderAirportDossier(
          /** @type {Airport} */ (entity),
          effectiveWorld,
          this.options?.getPlanes ? this.options.getPlanes() : [],
        ),
      building: () =>
        renderBuildingDossier(
          /** @type {Destination} */ (entity),
          effectiveWorld,
        ),
      town: () =>
        renderTownDossier(/** @type {Town} */ (entity), effectiveWorld),
      plane: () =>
        renderAircraftDossier(
          /** @type {PlaneAgent} */ (entity),
          effectiveWorld,
        ),
      truck: () =>
        renderRoadVehicleDossier(
          /** @type {CarAgent} */ (entity),
          effectiveWorld,
        ),
    };

    const dossier = renderers[normalizedType || ""]?.();
    if (dossier) this.renderSnapshot(dossier);
  }

  /**
   * Updates live telemetry spans inside an open inspector card without rebuilding the DOM.
   *
   * @param {ProceduralLogisticsWorld | null} [world]
   * @param {PlaneAgent[] | null} [overridePlanes]
   */
  refreshLiveStats(world = null, overridePlanes = null) {
    const inspected = this.options?.store?.getState().inspected;
    if (!inspected || !inspected.entity) return;

    const effectiveWorld =
      world || (this.options?.getWorld ? this.options.getWorld() : null);
    const entity = inspected.entity;

    /** @type {Record<string, () => any>} */
    const patchers = {
      airport: () =>
        describeAirportLivePatch(
          /** @type {Airport} */ (entity),
          effectiveWorld,
          overridePlanes ||
            (this.options?.getPlanes ? this.options.getPlanes() : null),
        ),
      plane: () =>
        describeAircraftLivePatch(
          /** @type {PlaneAgent} */ (entity),
          effectiveWorld,
        ),
      truck: () =>
        describeRoadVehicleLivePatch(
          /** @type {CarAgent} */ (entity),
          effectiveWorld,
        ),
    };

    const patch = patchers[inspected.type || ""]?.();
    if (patch) this.applyLivePatch(patch);
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
 *   getPlanes?: () => PlaneAgent[],
 *   getSim?: () => any,
 *   onFocus?: (type: string | null, entity: InspectedEntity | null) => void,
 *   onSelectEntity?: (type: string, entity: InspectedEntity, shouldFocus?: boolean) => void,
 *   onJumpRef?: (kind: EntityKind, id: number | string) => void,
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
