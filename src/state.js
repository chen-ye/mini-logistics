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
 *   ControlLabels,
 *   GeneratorConfig,
 *   InspectedEntity,
 *   ViewLayer,
 * } from './types.js'
 */

import { DEFAULT_GENERATOR_CONFIG, WIND_AXES } from "./constants.js";

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
  (cfg) => [
    cfg.waterCoverage,
    cfg.townCount,
    cfg.buildingDensity,
    cfg.airportCount,
    cfg.airportMix,
    cfg.windAxis,
  ],
  (
    waterCoverage,
    townCount,
    buildingDensity,
    airportCount,
    airportMix,
    windAxis,
  ) => ({
    waterLabel: `${waterCoverage}%`,
    townsLabel: `${townCount} Towns`,
    densityLabel: `${buildingDensity}%`,
    airportsLabel: formatAirportBreakdown(airportCount, airportMix),
    windLabel: formatWindLabel(windAxis),
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
 * drawer state, and entity inspector selection.
 *
 * @param {Partial<GeneratorConfig>} [initialConfig]
 */
export function createAppStore(initialConfig = DEFAULT_GENERATOR_CONFIG) {
  /** @type {Readonly<Required<GeneratorConfig>>} */
  const config = Object.freeze({
    ...DEFAULT_GENERATOR_CONFIG,
    ...initialConfig,
  });

  /** @type {AppState} */
  let state = Object.freeze({
    config,
    activeLayer: "aesthetic",
    simSpeed: 1,
    drawerOpen: true,
    inspected: Object.freeze({
      type: null,
      entity: null,
    }),
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

      if (
        Object.is(state.inspected.type, nextType) &&
        Object.is(state.inspected.entity, nextEntity)
      ) {
        return false;
      }

      state = Object.freeze({
        ...state,
        inspected: Object.freeze({
          type: nextType,
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
