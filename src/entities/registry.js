import { BUILDING_MASK } from "../constants.js";

/**
 * @import {
 *   EntityKind,
 *   EntityRef,
 *   EntityDefinition,
 *   CameraTarget,
 *   House,
 *   Destination,
 *   Airport,
 *   Town,
 *   CarAgent,
 *   PlaneAgent
 * } from '../types.js'
 */

/** @type {EntityDefinition[]} */
const ENTITY_DEFINITIONS = [];

/**
 * Registers one or more entity definitions into the global registry.
 * Maintains ascending sort order by hitPriority.
 *
 * @param {EntityDefinition | readonly EntityDefinition[]} defs
 */
export function registerEntityDefinitions(defs) {
  const list = Array.isArray(defs) ? defs : [defs];
  for (const def of list) {
    if (!def || !def.kind) continue;
    const key = def.id || def.kind;
    const existingIndex = ENTITY_DEFINITIONS.findIndex(
      (d) => (d.id || d.kind) === key,
    );
    if (existingIndex >= 0) {
      ENTITY_DEFINITIONS[existingIndex] = def;
    } else {
      ENTITY_DEFINITIONS.push(def);
    }
  }
  ENTITY_DEFINITIONS.sort((a, b) => a.hitPriority - b.hitPriority);
}

/**
 * Returns a shallow copy of all registered entity definitions in ascending hitPriority order.
 *
 * @returns {EntityDefinition[]}
 */
export function getEntityDefinitions() {
  return [...ENTITY_DEFINITIONS];
}

/**
 * Retrieves a registered entity definition by its kind.
 *
 * @param {EntityKind} kind
 * @returns {EntityDefinition | null}
 */
export function getEntityDefinition(kind) {
  return (
    ENTITY_DEFINITIONS.find((d) => d.kind === kind && Boolean(d.inspect)) ??
    ENTITY_DEFINITIONS.find((d) => d.kind === kind) ??
    null
  );
}

/**
 * Resolves an entity reference to its concrete domain object.
 *
 * @param {EntityRef | null | undefined} ref
 * @param {any} world
 * @param {any} [sim]
 * @returns {any}
 */
export function resolveEntityByRef(ref, world, sim = null) {
  if (!ref || !ref.kind || !world) return null;

  const def = getEntityDefinition(ref.kind);
  if (def && def.inspect && typeof def.inspect.resolve === "function") {
    const custom = def.inspect.resolve(ref.id, world, sim);
    if (custom) return custom;
  }

  const numId = typeof ref.id === "number" ? ref.id : Number(ref.id);
  switch (ref.kind) {
    case "airport":
      return (
        world.airports?.find(
          /** @param {Airport} a */ (a) => a.id === ref.id || a.id === numId,
        ) ?? null
      );
    case "building":
      return (
        world.destinations?.find(
          /** @param {Destination} d */ (d) =>
            d.id === ref.id || d.id === numId,
        ) ?? null
      );
    case "town":
      return (
        world.towns?.find(
          /** @param {Town} t */ (t) => t.id === ref.id || t.id === numId,
        ) ?? null
      );
    case "plane":
      return (
        sim?.planes?.find(
          /** @param {PlaneAgent} p */ (p) => p.id === ref.id || p.id === numId,
        ) ?? null
      );
    case "truck":
      return (
        sim?.cars?.find(
          /** @param {CarAgent} c */ (c) => c.id === ref.id || c.id === numId,
        ) ?? null
      );
    default:
      return null;
  }
}

/**
 * Internal fallback hit-tester for canonical entity kinds.
 *
 * @param {EntityKind} kind
 * @param {number} wx
 * @param {number} wy
 * @param {number} pad
 * @param {any} world
 * @param {any} [sim]
 * @returns {{ kind: EntityKind, id: number | string, entity: any } | null}
 */
function defaultHitTestForKind(kind, wx, wy, pad, world, sim = null) {
  if (kind === "airport" && Array.isArray(world.airports)) {
    for (const ap of world.airports) {
      const dx = wx - ap.x;
      const dy = wy - ap.y;
      const cosA = Math.cos(-(ap.angleRad || 0));
      const sinA = Math.sin(-(ap.angleRad || 0));
      const lx = dx * cosA - dy * sinA;
      const ly = dx * sinA + dy * cosA;
      if (
        Math.abs(lx) <= ap.halfLen + 1.4 + pad &&
        Math.abs(ly) <= (ap.halfWid || 2.0) + 1.8 + pad
      ) {
        return { kind: "airport", id: ap.id, entity: ap };
      }
    }
  }

  if (kind === "building" && Array.isArray(world.destinations)) {
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

    // Sprawling farm field parcels
    for (const d of world.destinations) {
      if (d.resourceType !== "FARM" || !d.bspParcels) continue;
      const bb = d.estateBBox;
      if (
        bb &&
        (wx < bb.minX - pad ||
          wx > bb.maxX + pad ||
          wy < bb.minY - pad ||
          wy > bb.maxY + pad)
      ) {
        continue;
      }
      for (const p of d.bspParcels) {
        if (
          wx >= p.x0 - pad &&
          wx <= p.x1 + pad &&
          wy >= p.y0 - pad &&
          wy <= p.y1 + pad
        ) {
          return { kind: "building", id: d.id, entity: d };
        }
      }
    }
  }

  if (kind === "town" && Array.isArray(world.towns)) {
    for (const t of world.towns) {
      if (Math.hypot(wx - t.x, wy - t.y) <= t.urbanRadius + pad) {
        return { kind: "town", id: t.id, entity: t };
      }
    }
  }

  if (kind === "plane" && sim && Array.isArray(sim.planes)) {
    for (const p of sim.planes) {
      if (Math.hypot(wx - (p.x + 0.5), wy - (p.y + 0.5)) <= 1.5 + pad) {
        return { kind: "plane", id: p.id ?? 0, entity: p };
      }
    }
  }

  if (kind === "truck" && sim && Array.isArray(sim.cars)) {
    for (const c of sim.cars) {
      if (c.pose) {
        if (c.pose.inTunnel) continue;
        if (
          Math.hypot(wx - (c.pose.x + 0.5), wy - (c.pose.y + 0.5)) <=
          1.2 + pad
        ) {
          return { kind: "truck", id: c.id ?? 0, entity: c };
        }
      }
    }
  }

  return null;
}

/**
 * Hit tests entities at world position (wx, wy), returning the highest priority hit.
 * Iterates registered definitions sorted ascending by hitPriority.
 *
 * @param {number} wx
 * @param {number} wy
 * @param {number} pad
 * @param {any} world
 * @param {any} [sim]
 * @returns {{ kind: EntityKind, id: number | string, entity: any } | null}
 */
export function hitTestEntities(wx, wy, pad, world, sim = null) {
  if (!world) return null;

  for (const def of ENTITY_DEFINITIONS) {
    if (!def.inspect || def.kind === "interchange") continue;
    if (typeof def.inspect.hitTest === "function") {
      const hit = def.inspect.hitTest(wx, wy, pad, world, sim);
      if (hit && hit.entity) {
        return {
          kind: def.kind,
          id: hit.id ?? hit.entity.id,
          entity: hit.entity,
        };
      }
    } else {
      const hit = defaultHitTestForKind(def.kind, wx, wy, pad, world, sim);
      if (hit) return hit;
    }
  }

  if (ENTITY_DEFINITIONS.length === 0) {
    /** @type {EntityKind[]} */
    const fallbackKinds = ["airport", "building", "town", "plane", "truck"];
    for (const kind of fallbackKinds) {
      const hit = defaultHitTestForKind(kind, wx, wy, pad, world, sim);
      if (hit) return hit;
    }
  }

  return null;
}

/**
 * Calculates camera target coordinates and zoom level for an entity.
 *
 * @param {EntityKind} kind
 * @param {any} entity
 * @param {any} world
 * @returns {CameraTarget}
 */
export function getEntityCameraTarget(kind, entity, world) {
  if (!entity) {
    return { x: 0, y: 0, cx: 0, cy: 0, zoom: 1.0, followLive: false };
  }

  const def = getEntityDefinition(kind);
  if (def && def.inspect && typeof def.inspect.getCameraTarget === "function") {
    return def.inspect.getCameraTarget(entity, world);
  }

  const targetZoom =
    kind === "town"
      ? 1.45
      : kind === "airport"
        ? 1.65
        : kind === "plane" || kind === "truck"
          ? 2.5
          : 2.15;

  let tx = entity.x ?? 0;
  let ty = entity.y ?? 0;
  if (kind === "building" && entity.gx != null && entity.gy != null) {
    tx = entity.gx + (entity.wTiles || 1) * 0.5;
    ty = entity.gy + (entity.hTiles || 1) * 0.5;
  } else if (entity.pose) {
    tx = entity.pose.x;
    ty = entity.pose.y;
  }

  const followLive = kind === "plane" || kind === "truck";

  return {
    x: tx,
    y: ty,
    cx: tx,
    cy: ty,
    zoom: targetZoom,
    followLive,
  };
}

/**
 * Invokes recordStaticZLayers across registered entity definitions for a specific Z-layer slot.
 *
 * @param {string} slotName
 * @param {any} rec
 * @param {any} world
 * @param {number} ts
 */
export function recordStaticZSlot(slotName, rec, world, ts) {
  for (const def of ENTITY_DEFINITIONS) {
    if (typeof def.recordStaticZLayers === "function") {
      def.recordStaticZLayers(slotName, rec, world, ts);
    }
  }
}

/**
 * Authoritative right-of-way demolition helper.
 * Filters world.houses and world.destinations based on demolition predicates,
 * updating buildingMask, town property counts, and world.displacedBuildingsCount.
 *
 * @param {any} world
 * @param {((house: House) => boolean) | null} [housePredicate] - Return true to demolish house
 * @param {((dest: Destination) => boolean) | null} [destPredicate] - Return true to demolish destination
 * @param {number} [clearedMask=BUILDING_MASK.EMPTY] - Mask value to write for cleared tiles
 * @returns {number} Number of buildings displaced in this pass
 */
export function demolishBuildingsWhere(
  world,
  housePredicate = null,
  destPredicate = null,
  clearedMask = BUILDING_MASK.EMPTY,
) {
  if (!world) return 0;

  let housesRemoved = 0;
  if (typeof housePredicate === "function" && Array.isArray(world.houses)) {
    const beforeHouses = world.houses.length;
    world.houses = world.houses.filter(
      /** @param {House} h */ (h) => {
        const shouldDemolish = housePredicate(h);
        if (shouldDemolish) {
          const hx = h.x;
          const hy = h.y;
          if (hx >= 0 && hx < world.W && hy >= 0 && hy < world.H) {
            const hid = world.idx(hx, hy);
            if (world.buildingMask[hid] === BUILDING_MASK.HOUSE) {
              world.buildingMask[hid] = clearedMask;
            }
          }
          if (Array.isArray(world.towns)) {
            const t = world.towns[h.townId];
            if (t && t.housesCount > 0) t.housesCount--;
          }
          return false;
        }
        return true;
      },
    );
    housesRemoved = beforeHouses - world.houses.length;
  }

  let destRemoved = 0;
  if (
    typeof destPredicate === "function" &&
    Array.isArray(world.destinations)
  ) {
    const beforeDest = world.destinations.length;
    world.destinations = world.destinations.filter(
      /** @param {Destination} d */ (d) => {
        const shouldDemolish = destPredicate(d);
        if (shouldDemolish) {
          const wT = d.wTiles || 1;
          const hT = d.hTiles || 1;
          for (let dy = 0; dy < hT; dy++) {
            for (let dx = 0; dx < wT; dx++) {
              const gx = d.gx + dx;
              const gy = d.gy + dy;
              if (gx >= 0 && gx < world.W && gy >= 0 && gy < world.H) {
                const did = world.idx(gx, gy);
                if (world.buildingMask[did] === BUILDING_MASK.DESTINATION) {
                  world.buildingMask[did] = clearedMask;
                }
              }
            }
          }
          if (Array.isArray(world.towns)) {
            const t = world.towns[d.townId];
            if (t) {
              if (t.destinationsCount > 0) t.destinationsCount--;
              if (d.zoneType === "commercial" && t.commercialCount > 0) {
                t.commercialCount--;
              }
              if (d.zoneType === "industrial" && t.industrialCount > 0) {
                t.industrialCount--;
              }
            }
          }
          return false;
        }
        return true;
      },
    );
    destRemoved = beforeDest - world.destinations.length;
  }

  const totalDisplaced = housesRemoved + destRemoved;
  world.displacedBuildingsCount =
    (world.displacedBuildingsCount || 0) + totalDisplaced;
  return totalDisplaced;
}
