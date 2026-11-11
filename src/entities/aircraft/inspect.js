/**
 * Aircraft Inspection, Hit Testing, Camera Target, Live Telemetry, and Dossier Formatting.
 *
 * Invariants:
 * - 100% Worker-safe and headless-safe: zero top-level or runtime window/document/DOM calls.
 * - Operates purely on passed world and simulator flight agent structures.
 * - Emits pure HTML strings and plain telemetry objects.
 *
 * @import { PlaneAgent } from '../../types.js'
 * @import { ProceduralLogisticsWorld } from '../../world-generator.js'
 */

/**
 * Resolves an aircraft reference by ID from the active simulation state.
 *
 * @param {number | string} id
 * @param {ProceduralLogisticsWorld | null} _world
 * @param {{ planes?: PlaneAgent[] } | null} [sim]
 * @returns {PlaneAgent | null}
 */
export function resolveAircraft(id, _world = null, sim = null) {
  if (id === "" || id === null || id === undefined) return null;
  if (!sim || !Array.isArray(sim.planes)) return null;
  const strId = String(id).trim();
  const m = /(\d+)$/.exec(strId);
  const parsedNum = m ? Number(m[1]) : Number(strId);
  return (
    sim.planes.find(
      (p) =>
        p.id === parsedNum ||
        p.id === Number(strId) ||
        String(p.id) === strId ||
        p.id === id,
    ) || null
  );
}

/**
 * Hit-tests an aircraft agent from the simulation fleet.
 * Prioritizes airborne planes over taxiing/parked aircraft, and closer Euclidean distance.
 *
 * @param {number} wx
 * @param {number} wy
 * @param {number} pad
 * @param {ProceduralLogisticsWorld | null} _world
 * @param {{ planes?: PlaneAgent[] } | null} [sim]
 * @returns {{ kind: "plane", id: number, entity: PlaneAgent } | null}
 */
export function hitTestAircraft(wx, wy, pad, _world = null, sim = null) {
  if (!sim || !Array.isArray(sim.planes)) return null;
  const radius = Math.max(1.8, pad * 1.35);

  /** @type {PlaneAgent | null} */
  let bestPlane = null;
  let bestScore = Infinity;

  for (const p of sim.planes) {
    const dist = Math.hypot(wx - (p.x + 0.5), wy - (p.y + 0.5));
    if (dist <= radius) {
      const isAirborne =
        p.phase === "CRUISE" ||
        p.phase === "TAKEOFF" ||
        p.phase === "LANDING" ||
        p.state === "ENROUTE_CRUISE";
      const score = (isAirborne ? 0 : 10) + dist;
      if (score < bestScore) {
        bestScore = score;
        bestPlane = p;
      }
    }
  }

  if (bestPlane) {
    const id = bestPlane.id ?? sim.planes.indexOf(bestPlane);
    return { kind: "plane", id, entity: bestPlane };
  }
  return null;
}

/**
 * Derives camera target parameters for focusing and tracking an aircraft live.
 *
 * @param {PlaneAgent} p
 * @returns {{ cx: number, cy: number, x: number, y: number, zoom: number, followLive: boolean }}
 */
export function getAircraftCameraTarget(p) {
  return {
    cx: p.x,
    cy: p.y,
    x: p.x,
    y: p.y,
    zoom: 2.35,
    followLive: true,
  };
}

/**
 * Computes live flight status, kinematics, and gate telemetry for an inspected aircraft.
 *
 * @param {PlaneAgent} p
 * @param {ProceduralLogisticsWorld | null} [_world]
 * @returns {{
 *   stateText: string,
 *   speedKt: number,
 *   altitudeFt: number,
 *   progressPct: number,
 *   gateText: string
 * }}
 */
export function describeAircraftLiveStatus(p, _world = null) {
  const stateRaw = p.state || p.phase || "ENROUTE_CRUISE";
  const stateText = stateRaw.replace(/_/g, " ");
  const isGround =
    p.phase === "TAXI_OUT" ||
    p.phase === "TAXI_IN" ||
    p.phase === "GATE_DWELL" ||
    p.state === "GATE_LOADING" ||
    p.state === "PUSHBACK_HOLD" ||
    p.state === "TAXI_TO_RUNWAY" ||
    p.state === "HOLD_SHORT_QUEUE" ||
    p.state === "HOLD_CROSSING_RUNWAY" ||
    p.state === "TAXI_TO_GATE";
  const rawSpeed = typeof p.speed === "number" ? p.speed : 0;
  const speedKt = Math.round(rawSpeed * (isGround ? 14 : 35));
  const altitudeFt = isGround ? 0 : Math.round((p.altitude ?? 0) * 32000);
  const trackLen = p.track?.totalLength || 1;
  const rawProgress =
    typeof p.dist === "number" ? p.dist / trackLen : (p.progress ?? 0);
  const progressPct = Math.min(100, Math.max(0, Math.round(rawProgress * 100)));
  const gateText =
    p.gateId != null
      ? `Gate #${p.gateId + 1}`
      : p.reservedGateId != null
        ? `Reserved Gate #${p.reservedGateId + 1}`
        : "Enroute";

  return {
    stateText,
    speedKt,
    altitudeFt,
    progressPct,
    gateText,
  };
}

/**
 * Derives badge styling and label for an aircraft.
 *
 * @param {PlaneAgent} p
 * @returns {{ badgeText: string, badgeClass: string }}
 */
function getAircraftBadge(p) {
  let badgeText = "PASSENGER JET";
  let badgeClass =
    "text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md bg-blue-700 text-white tracking-wide";
  if (p.aircraftType === "WIDEBODY_FREIGHTER") {
    badgeText = "WIDE-BODY FREIGHTER";
    badgeClass =
      "text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md bg-purple-700 text-white tracking-wide";
  } else if (p.aircraftType === "FEEDER_TURBOPROP") {
    badgeText = "FEEDER TURBOPROP";
    badgeClass =
      "text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md bg-amber-700 text-white tracking-wide";
  }
  return { badgeText, badgeClass };
}

/**
 * Derives route and origin/destination info for an aircraft.
 *
 * @param {PlaneAgent} p
 * @returns {{
 *   origApId: number | null,
 *   destApId: number | null,
 *   origIata: string,
 *   destIata: string,
 *   codeText: string,
 *   titleText: string,
 *   terminalsKey: string
 * }}
 */
function getAircraftRouteInfo(p) {
  const origApId =
    p.origin && "id" in p.origin && typeof p.origin.id === "number"
      ? p.origin.id
      : null;
  const destApId =
    p.dest && "id" in p.dest && typeof p.dest.id === "number"
      ? p.dest.id
      : null;
  const origIata =
    ("iata" in p.origin && p.origin.iata) ||
    ("isExternal" in p.origin ? "INTL" : "ORIG");
  const destIata =
    ("iata" in p.dest && p.dest.iata) ||
    ("isExternal" in p.dest ? "INTL" : "DEST");

  const codeText = `FLT #${p.id ?? 0}, ${p.isExternalFlight ? "INTL" : "REGIONAL"}`;
  const titleText = `${origIata} → ${destIata}`;
  const terminalsKey = `${origIata}->${destIata}:${origApId}:${destApId}`;
  return {
    origApId,
    destApId,
    origIata,
    destIata,
    codeText,
    titleText,
    terminalsKey,
  };
}

/**
 * Formats origin and destination airfield jump buttons HTML.
 *
 * @param {string} origIata
 * @param {string} destIata
 * @param {number | null} origApId
 * @param {number | null} destApId
 * @returns {string}
 */
export function buildAircraftTerminalsHtml(
  origIata,
  destIata,
  origApId,
  destApId,
) {
  const origBtnHtml =
    origApId != null
      ? `<button type="button" data-jump-ap="${origApId}" class="flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 hover:bg-white border border-stone-300/70 hover:border-stone-500 text-left transition group">
          <div class="min-w-0">
            <span class="text-[9px] font-extrabold uppercase px-1 py-0.5 rounded bg-stone-200 text-stone-700">ORIGIN</span>
            <div class="font-bold text-[#36383e] group-hover:text-[#e85c90] truncate text-[11px] mt-0.5">${origIata}</div>
          </div>
          <svg class="w-3.5 h-3.5 text-stone-400 group-hover:text-[#36383e] shrink-0" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
        </button>`
      : `<div class="px-2.5 py-1.5 rounded-lg bg-stone-100 border border-stone-200 text-[11px] font-bold text-stone-500">${origIata}</div>`;

  const destBtnHtml =
    destApId != null
      ? `<button type="button" data-jump-ap="${destApId}" class="flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 hover:bg-white border border-stone-300/70 hover:border-stone-500 text-left transition group">
          <div class="min-w-0">
            <span class="text-[9px] font-extrabold uppercase px-1 py-0.5 rounded bg-stone-200 text-stone-700">DEST</span>
            <div class="font-bold text-[#36383e] group-hover:text-[#e85c90] truncate text-[11px] mt-0.5">${destIata}</div>
          </div>
          <svg class="w-3.5 h-3.5 text-stone-400 group-hover:text-[#36383e] shrink-0" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
        </button>`
      : `<div class="px-2.5 py-1.5 rounded-lg bg-stone-100 border border-stone-200 text-[11px] font-bold text-stone-500">${destIata}</div>`;

  return `${origBtnHtml}\n      ${destBtnHtml}`;
}

/**
 * Returns a live patch dictionary for updating aircraft telemetry elements.
 *
 * @param {PlaneAgent} p
 * @param {ProceduralLogisticsWorld | null} [world]
 * @returns {{
 *   stateText: string,
 *   kinematicsText: string,
 *   manifestText: string,
 *   gateText: string,
 *   progressText: string,
 *   speedKt: number,
 *   altitudeFt: number,
 *   progressPct: number,
 *   titleText: string,
 *   codeText: string,
 *   badgeText: string,
 *   badgeClass: string,
 *   origIata: string,
 *   destIata: string,
 *   origApId: number | null,
 *   destApId: number | null,
 *   terminalsKey: string,
 *   terminalsHtml: string
 * }}
 */
export function describeAircraftLivePatch(p, world = null) {
  const status = describeAircraftLiveStatus(p, world);
  const altLabel =
    status.altitudeFt <= 0
      ? "GND (0 ft)"
      : `FL${String(Math.round(status.altitudeFt / 100)).padStart(3, "0")} (${status.altitudeFt.toLocaleString()} ft)`;
  const kinematicsText = `${status.speedKt} kt • ${altLabel}`;
  const manifestText =
    p.manifest?.commodity ||
    (p.isCargoFreighter ? "Air Freight" : "Passengers + Cargo");

  const { badgeText, badgeClass } = getAircraftBadge(p);
  const {
    origApId,
    destApId,
    origIata,
    destIata,
    codeText,
    titleText,
    terminalsKey,
  } = getAircraftRouteInfo(p);
  const terminalsHtml = buildAircraftTerminalsHtml(
    origIata,
    destIata,
    origApId,
    destApId,
  );

  return {
    stateText: status.stateText,
    kinematicsText,
    manifestText,
    gateText: status.gateText,
    progressText: `${status.progressPct}%`,
    speedKt: status.speedKt,
    altitudeFt: status.altitudeFt,
    progressPct: status.progressPct,
    titleText,
    codeText,
    badgeText,
    badgeClass,
    origIata,
    destIata,
    origApId,
    destApId,
    terminalsKey,
    terminalsHtml,
  };
}

export const describeLivePatch = describeAircraftLivePatch;

/**
 * Renders an aircraft entity flight-strip dossier snapshot.
 *
 * @param {PlaneAgent} p
 * @param {ProceduralLogisticsWorld | null} [world]
 * @returns {{
 *   badgeText: string,
 *   badgeClass: string,
 *   codeText: string,
 *   titleText: string,
 *   bodyHtml: string
 * }}
 */
export function renderAircraftDossier(p, world = null) {
  const status = describeAircraftLiveStatus(p, world);
  const patch = describeAircraftLivePatch(p, world);

  const { badgeText, badgeClass } = getAircraftBadge(p);
  const {
    origApId,
    destApId,
    origIata,
    destIata,
    codeText,
    titleText,
    terminalsKey,
  } = getAircraftRouteInfo(p);

  const terminalsHtml = buildAircraftTerminalsHtml(
    origIata,
    destIata,
    origApId,
    destApId,
  );

  const bodyHtml = `
  <div class="divide-y divide-stone-300/60 border-y border-stone-300/60">
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Flight Status</span>
      <span id="inspPlaneState" class="mono font-bold text-[#36383e] tabular-nums uppercase">${status.stateText}</span>
    </div>
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Kinematics</span>
      <span id="inspPlaneKinematics" class="mono font-bold text-[#36383e] tabular-nums">${patch.kinematicsText}</span>
    </div>
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Cargo Manifest</span>
      <span id="inspPlaneManifest" class="mono font-bold text-[#36383e] tabular-nums text-[11px]">${patch.manifestText}</span>
    </div>
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Gate Position</span>
      <span id="inspPlaneGate" class="mono font-bold text-[#36383e] tabular-nums">${patch.gateText}</span>
    </div>
    <div class="flex items-center justify-between py-1.5">
      <span class="text-stone-500 font-medium">Route Progress</span>
      <span id="inspPlaneProgress" class="mono font-bold text-emerald-700 tabular-nums">${patch.progressText}</span>
    </div>
  </div>

  <div class="space-y-1.5 pt-1">
    <div class="flex items-center justify-between text-[11px] font-bold text-stone-600">
      <span>Airfield Terminals</span>
    </div>
    <div id="inspPlaneTerminals" data-terminals-key="${terminalsKey}" class="grid grid-cols-2 gap-2">
      ${terminalsHtml}
    </div>
  </div>
`;

  return {
    badgeText,
    badgeClass,
    codeText,
    titleText,
    bodyHtml,
  };
}
