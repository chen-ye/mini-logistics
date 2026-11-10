/**
 * Signal-grade immutable selector store and bounded LRU memoization stages for Mini Logistics.
 *
 * Invariants:
 * - State mutations produce frozen objects and bail out on identity equality (zero subscriber notifications).
 * - Subscribers cache their last evaluated slice and only notify when the slice changes under the comparator.
 * - `batch(fn)` defers subscriber flushes until all nested batches have completed.
 * - Memo stages retain at most `maxSize` (default 3) LRU entries.
 *
 * @import {
 *   AppState,
 *   CameraTarget,
 *   ControlLabels,
 *   GeneratorConfig,
 *   InspectedEntity,
 *   ViewLayer,
 * } from './types.js'
 */

import {
  DEFAULT_GENERATOR_CONFIG,
  WIND_AXES,
  ARCHETYPE_PARAMETER_PRESETS,
} from "./constants.js";

/**
 * Fast shallow equality check for objects, arrays/tuples, and primitives.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }

  const isArrA = Array.isArray(a);
  const isArrB = Array.isArray(b);
  if (isArrA !== isArrB) return false;

  if (isArrA && isArrB) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }

  /** @type {Record<string, unknown>} */
  const objA = /** @type {Record<string, unknown>} */ (a);
  /** @type {Record<string, unknown>} */
  const objB = /** @type {Record<string, unknown>} */ (b);
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;

  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i];
    if (
      !Object.prototype.hasOwnProperty.call(objB, k) ||
      !Object.is(objA[k], objB[k])
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Bounded LRU memoized stage combinator.
 * Maintains up to `maxSize` entries with MRU at index 0.
 *
 * @template T
 * @param {((...args: any[]) => unknown[]) | null | undefined} selectDeps
 * @param {(...args: any[]) => T} computeFn
 * @param {{ maxSize?: number }} [options]
 * @returns {(...args: any[]) => { value: T, cached: boolean, version: number }}
 */
export function createMemoStage(
  selectDeps,
  computeFn,
  options = { maxSize: 3 },
) {
  const maxSize = options?.maxSize ?? 3;
  /** @type {Array<{ deps: unknown[], value: T, version: number }>} */
  const entries = [];
  let currentVersion = 0;

  return function memoizedStage(...args) {
    const nextDeps =
      typeof selectDeps === "function" ? selectDeps(...args) : args;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.deps.length === nextDeps.length) {
        let match = true;
        for (let j = 0; j < nextDeps.length; j++) {
          if (!Object.is(entry.deps[j], nextDeps[j])) {
            match = false;
            break;
          }
        }
        if (match) {
          if (i > 0) {
            entries.splice(i, 1);
            entries.unshift(entry);
          }
          return { value: entry.value, cached: true, version: entry.version };
        }
      }
    }

    currentVersion++;
    const rawValue = computeFn(...nextDeps, currentVersion);
    const value = Object.freeze(rawValue);
    const newEntry = { deps: nextDeps, value, version: currentVersion };
    entries.unshift(newEntry);
    if (entries.length > maxSize) {
      entries.length = maxSize;
    }
    return { value, cached: false, version: currentVersion };
  };
}

/**
 * Formats airport fleet breakdown label.
 *
 * @param {number} total
 * @param {string} [mix]
 * @returns {string}
 */
export function formatAirportBreakdown(total, mix = "hub-regional") {
  if (total <= 0) return "0 (0 Hub)";
  let hubs = 1;
  let cargo = 0;
  if (mix === "dual-hub" && total >= 2) hubs = 2;
  if (mix === "hub-reg-cargo" && total >= 3) cargo = 1;
  const reg = Math.max(0, total - hubs - cargo);
  const parts = [`${hubs} Hub`];
  if (reg > 0) parts.push(`${reg} Reg`);
  if (cargo > 0) parts.push(`${cargo} Crg`);
  return `${total} (${parts.join(", ")})`;
}

/**
 * @param {number | undefined} windAxis
 * @returns {string}
 */
function formatWindLabel(windAxis) {
  if (windAxis === -1 || windAxis == null) return "Auto (Seed)";
  const axis = WIND_AXES[windAxis];
  return axis?.shortLabel || (windAxis === 0 ? "09/27 (E–W)" : "Auto (Seed)");
}

const controlLabelsStage = createMemoStage(
  /** @param {GeneratorConfig} cfg */
  (cfg) => {
    const preset =
      ARCHETYPE_PARAMETER_PRESETS[
        cfg.archetype || DEFAULT_GENERATOR_CONFIG.archetype
      ] || ARCHETYPE_PARAMETER_PRESETS.confluence;
    const relief = cfg.terrainRelief ?? preset.terrainRelief;
    const incision = cfg.valleyIncision ?? preset.valleyIncision;
    const embayment = cfg.coastalEmbayment ?? preset.coastalEmbayment;
    const caldera = cfg.calderaCurvature ?? preset.calderaCurvature;
    const barrier = cfg.barrierFragmentation ?? preset.barrierFragmentation;
    const basins = cfg.basinCount ?? preset.basinCount;

    let geoModifiedCount = 0;
    if (relief !== preset.terrainRelief) geoModifiedCount++;
    if (incision !== preset.valleyIncision) geoModifiedCount++;
    if (embayment !== preset.coastalEmbayment) geoModifiedCount++;
    if (caldera !== preset.calderaCurvature) geoModifiedCount++;
    if (barrier !== preset.barrierFragmentation) geoModifiedCount++;
    if (basins !== preset.basinCount) geoModifiedCount++;

    return [
      cfg.waterCoverage,
      cfg.townCount,
      cfg.buildingDensity,
      cfg.airportCount,
      cfg.airportMix,
      cfg.windAxis,
      relief,
      incision,
      embayment,
      caldera,
      barrier,
      basins,
      geoModifiedCount,
    ];
  },
  (
    waterCoverage,
    townCount,
    buildingDensity,
    airportCount,
    airportMix,
    windAxis,
    relief,
    incision,
    embayment,
    caldera,
    barrier,
    basins,
    geoModifiedCount,
  ) => ({
    waterLabel: `${waterCoverage}%`,
    townsLabel: `${townCount} Towns`,
    densityLabel: `${buildingDensity}%`,
    airportsLabel: formatAirportBreakdown(airportCount, airportMix),
    windLabel: formatWindLabel(windAxis),
    reliefLabel: `${relief}%`,
    incisionLabel: `${incision}%`,
    embaymentLabel: `${embayment}%`,
    calderaLabel: `${caldera}%`,
    barrierLabel: `${barrier}%`,
    basinsLabel: `${basins}`,
    geoModifiedCount,
  }),
  { maxSize: 3 },
);

/**
 * Memoized selector deriving generator control labels with 3-entry LRU cache.
 *
 * @param {GeneratorConfig} cfg
 * @returns {ControlLabels}
 */
export function deriveControlLabels(cfg) {
  return controlLabelsStage(cfg).value;
}
deriveControlLabels.stage = controlLabelsStage;

/** @type {Set<{ _flushIfPending: () => void }>} */
const activeStores = new Set();
let globalBatchDepth = 0;

/**
 * Batches store mutations across active stores, delaying subscriber notification
 * until the outermost batch scope completes.
 *
 * @param {() => void} fn
 */
export function batch(fn) {
  globalBatchDepth++;
  try {
    fn();
  } finally {
    globalBatchDepth--;
    if (globalBatchDepth === 0) {
      for (const s of activeStores) {
        s._flushIfPending();
      }
    }
  }
}

/**
 * Creates an immutable app store holding configuration, view layer, simulation speed,
 * drawer state, camera target, and entity inspector selection.
 *
 * @param {Partial<GeneratorConfig>} [initialConfig]
 * @param {{
 *   activeLayer?: ViewLayer,
 *   simSpeed?: number,
 *   drawerOpen?: boolean,
 *   camera?: CameraTarget | null,
 *   inspected?: { type?: string | null, id?: number | null, entity?: InspectedEntity | null } | null,
 * }} [initialViewAndInteraction]
 */
export function createAppStore(
  initialConfig = DEFAULT_GENERATOR_CONFIG,
  initialViewAndInteraction = {},
) {
  const archKey = initialConfig.archetype || DEFAULT_GENERATOR_CONFIG.archetype;
  const defaultArchPreset =
    ARCHETYPE_PARAMETER_PRESETS[archKey] ||
    ARCHETYPE_PARAMETER_PRESETS.confluence;

  /** @type {Readonly<Required<GeneratorConfig>>} */
  const config = Object.freeze({
    ...DEFAULT_GENERATOR_CONFIG,
    terrainRelief: defaultArchPreset.terrainRelief,
    valleyIncision: defaultArchPreset.valleyIncision,
    coastalEmbayment: defaultArchPreset.coastalEmbayment,
    calderaCurvature: defaultArchPreset.calderaCurvature,
    barrierFragmentation: defaultArchPreset.barrierFragmentation,
    basinCount: defaultArchPreset.basinCount,
    ...initialConfig,
  });

  const activeLayer = initialViewAndInteraction.activeLayer ?? "aesthetic";
  const simSpeed = initialViewAndInteraction.simSpeed ?? 1;
  const drawerOpen = initialViewAndInteraction.drawerOpen ?? true;
  const initialCamera = initialViewAndInteraction.camera
    ? Object.freeze({
        cx: initialViewAndInteraction.camera.cx,
        cy: initialViewAndInteraction.camera.cy,
        zoom: initialViewAndInteraction.camera.zoom,
      })
    : null;

  const rawInspected = initialViewAndInteraction.inspected;
  const rawType = rawInspected?.type;
  const inspectedType =
    rawType === "airport" || rawType === "building" || rawType === "town"
      ? rawType
      : rawType === "resource"
        ? /** @type {"building"} */ ("building")
        : null;
  const inspectedId =
    rawInspected?.id != null
      ? rawInspected.id
      : rawInspected?.entity?.id != null
        ? rawInspected.entity.id
        : null;
  const inspectedEntity = rawInspected?.entity ?? null;
  const inspected = Object.freeze({
    type: inspectedId == null && inspectedEntity == null ? null : inspectedType,
    id: inspectedId,
    entity: inspectedEntity,
  });

  /** @type {AppState} */
  let state = Object.freeze({
    config,
    activeLayer,
    simSpeed,
    drawerOpen,
    camera: initialCamera,
    inspected,
  });

  /**
   * @typedef {Object} SubscriptionRecord
   * @property {(s: AppState) => any} select
   * @property {(next: any, prev: any) => void} listener
   * @property {(a: any, b: any) => boolean} equals
   * @property {any} lastSlice
   */

  /** @type {Set<SubscriptionRecord>} */
  const subscribers = new Set();
  let localBatchDepth = 0;
  let hasPendingFlush = false;

  function flush() {
    hasPendingFlush = false;
    const subs = Array.from(subscribers);
    for (const sub of subs) {
      if (!subscribers.has(sub)) continue;
      const nextSlice = sub.select(state);
      if (!sub.equals(nextSlice, sub.lastSlice)) {
        const prevSlice = sub.lastSlice;
        sub.lastSlice = nextSlice;
        sub.listener(nextSlice, prevSlice);
      }
    }
  }

  function notify() {
    if (localBatchDepth > 0 || globalBatchDepth > 0) {
      hasPendingFlush = true;
      return;
    }
    flush();
  }

  const store = {
    /**
     * @returns {AppState}
     */
    getState() {
      return state;
    },

    /**
     * Updates generator config partial with identity bailout.
     *
     * @param {Partial<GeneratorConfig>} partial
     * @returns {boolean}
     */
    patchConfig(partial) {
      if (!partial || typeof partial !== "object") return false;
      const keys = Object.keys(partial);
      if (keys.length === 0) return false;
      const allSame = keys.every((k) =>
        Object.is(
          state.config[/** @type {keyof GeneratorConfig} */ (k)],
          partial[/** @type {keyof GeneratorConfig} */ (k)],
        ),
      );
      if (allSame) return false;

      state = Object.freeze({
        ...state,
        config: Object.freeze({
          ...state.config,
          ...partial,
        }),
      });
      notify();
      return true;
    },

    /**
     * Sets geography archetype, updating preset geomorphology scalars and water coverage.
     *
     * @param {string} archetype
     * @returns {boolean}
     */
    setArchetype(archetype) {
      const preset =
        ARCHETYPE_PARAMETER_PRESETS[archetype] ||
        ARCHETYPE_PARAMETER_PRESETS.confluence;
      /** @type {Partial<GeneratorConfig>} */
      const patch = {
        archetype,
        waterCoverage: preset.waterCoverage,
        terrainRelief: preset.terrainRelief,
        valleyIncision: preset.valleyIncision,
        coastalEmbayment: preset.coastalEmbayment,
        calderaCurvature: preset.calderaCurvature,
        barrierFragmentation: preset.barrierFragmentation,
        basinCount: preset.basinCount,
      };
      if (archetype === "island-hopper") {
        patch.airportCount = Math.max(state.config.airportCount, 5);
      }
      return this.patchConfig(patch);
    },

    /**
     * Resets geomorphology scalars to canonical archetype preset values.
     *
     * @returns {boolean}
     */
    resetArchetypeScalars() {
      const preset =
        ARCHETYPE_PARAMETER_PRESETS[state.config.archetype] ||
        ARCHETYPE_PARAMETER_PRESETS.confluence;
      return this.patchConfig({
        terrainRelief: preset.terrainRelief,
        valleyIncision: preset.valleyIncision,
        coastalEmbayment: preset.coastalEmbayment,
        calderaCurvature: preset.calderaCurvature,
        barrierFragmentation: preset.barrierFragmentation,
        basinCount: preset.basinCount,
      });
    },

    /**
     * @param {ViewLayer} layer
     * @returns {boolean}
     */
    setActiveLayer(layer) {
      if (Object.is(state.activeLayer, layer)) return false;
      state = Object.freeze({
        ...state,
        activeLayer: layer,
      });
      notify();
      return true;
    },

    /**
     * @param {number} speed
     * @returns {boolean}
     */
    setSimSpeed(speed) {
      if (Object.is(state.simSpeed, speed)) return false;
      state = Object.freeze({
        ...state,
        simSpeed: speed,
      });
      notify();
      return true;
    },

    /**
     * @param {boolean} open
     * @returns {boolean}
     */
    setDrawerOpen(open) {
      const nextOpen = open;
      if (Object.is(state.drawerOpen, nextOpen)) return false;
      state = Object.freeze({
        ...state,
        drawerOpen: nextOpen,
      });
      notify();
      return true;
    },

    /**
     * Sets viewport-independent camera center and zoom, bailing out on value equality.
     *
     * @param {CameraTarget | null} targetCamera
     * @returns {boolean}
     */
    setCamera(targetCamera) {
      if (targetCamera === null) {
        if (state.camera === null) return false;
        state = Object.freeze({
          ...state,
          camera: null,
        });
        notify();
        return true;
      }

      if (
        state.camera !== null &&
        Object.is(state.camera.cx, targetCamera.cx) &&
        Object.is(state.camera.cy, targetCamera.cy) &&
        Object.is(state.camera.zoom, targetCamera.zoom)
      ) {
        return false;
      }

      state = Object.freeze({
        ...state,
        camera: Object.freeze({
          cx: targetCamera.cx,
          cy: targetCamera.cy,
          zoom: targetCamera.zoom,
        }),
      });
      notify();
      return true;
    },

    /**
     * Sets inspected entity, normalizing "resource" to "building".
     *
     * @param {string | null} type
     * @param {InspectedEntity | null} entity
     * @returns {boolean}
     */
    setInspected(type, entity) {
      const normalizedType =
        type === "resource"
          ? /** @type {"building"} */ ("building")
          : (type ?? null);
      const nextEntity = entity ?? null;
      const nextType =
        nextEntity === null
          ? null
          : /** @type {"airport" | "building" | "town" | null} */ (
              normalizedType
            );
      const nextId =
        nextEntity === null
          ? null
          : nextEntity.id != null
            ? nextEntity.id
            : null;

      if (
        Object.is(state.inspected.type, nextType) &&
        Object.is(state.inspected.id, nextId) &&
        Object.is(state.inspected.entity, nextEntity)
      ) {
        return false;
      }

      state = Object.freeze({
        ...state,
        inspected: Object.freeze({
          type: nextType,
          id: nextId,
          entity: nextEntity,
        }),
      });
      notify();
      return true;
    },

    /**
     * Sets inspected entity reference by type and id, retaining selection before entity hydration.
     *
     * @param {string | null} type
     * @param {number | null} id
     * @param {InspectedEntity | null} [entity]
     * @returns {boolean}
     */
    setInspectedRef(type, id, entity = null) {
      const normalizedType =
        type === "resource"
          ? /** @type {"building"} */ ("building")
          : (type ?? null);
      const nextId = id == null ? null : id;
      const nextType =
        nextId == null
          ? null
          : /** @type {"airport" | "building" | "town" | null} */ (
              normalizedType
            );
      const nextEntity = nextId == null ? null : (entity ?? null);

      if (
        Object.is(state.inspected.type, nextType) &&
        Object.is(state.inspected.id, nextId) &&
        Object.is(state.inspected.entity, nextEntity)
      ) {
        return false;
      }

      state = Object.freeze({
        ...state,
        inspected: Object.freeze({
          type: nextType,
          id: nextId,
          entity: nextEntity,
        }),
      });
      notify();
      return true;
    },

    /**
     * Runs `fn` inside a batch, deferring subscriber flushes until depth returns to 0.
     *
     * @param {() => void} fn
     */
    batch(fn) {
      localBatchDepth++;
      try {
        fn();
      } finally {
        localBatchDepth--;
        if (
          localBatchDepth === 0 &&
          globalBatchDepth === 0 &&
          hasPendingFlush
        ) {
          flush();
        }
      }
    },

    /**
     * Subscribes a listener to a slice of state.
     *
     * @template S
     * @param {(s: AppState) => S} select
     * @param {(next: S, prev: S) => void} listener
     * @param {(a: S, b: S) => boolean} [equals]
     * @returns {() => void} Unsubscribe function
     */
    subscribe(select, listener, equals = Object.is) {
      /** @type {SubscriptionRecord} */
      const sub = {
        select,
        listener,
        equals,
        lastSlice: select(state),
      };
      subscribers.add(sub);
      return () => {
        subscribers.delete(sub);
      };
    },

    /**
     * Internal flush called when global batch scope closes.
     * @internal
     */
    _flushIfPending() {
      if (hasPendingFlush && localBatchDepth === 0 && globalBatchDepth === 0) {
        flush();
      }
    },
  };

  activeStores.add(store);
  return store;
}
