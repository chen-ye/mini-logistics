import { PALETTE } from './palette.js';
import {
  createWorldPipeline,
  hydrateTransferredWorld
} from './world-generator.js';
import { LogisticsSimulator } from './simulator.js';
import { MiniMotorwaysRenderer } from './renderer.js';

const canvas = document.getElementById('worldCanvas');
const renderer = new MiniMotorwaysRenderer(canvas);
let currentWorld = null;
let simulator = null;
let simSpeed = 1;
const daysOfWeek = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const fallbackPipeline = createWorldPipeline();

window.renderer = renderer;
window.currentWorld = null;
window.simulator = null;

// Dual-Worker Pipeline: `world-worker.js` (Stages 1–9) ∥ `terrain-bake-worker.js` (OffscreenCanvas -> ImageBitmap)
let worldWorker = null;
let terrainBakeWorker = null;
let workerBusy = false;
let nextRequestId = 1;
let pendingJob = null;
const inflightResolvers = new Map();

function initWorldWorker() {
  if (typeof Worker === 'undefined') return null;
  try {
    const worker = new Worker(new URL('./world-worker.js', import.meta.url), { type: 'module' });
    try {
      terrainBakeWorker = new Worker(new URL('./terrain-bake-worker.js', import.meta.url), { type: 'module' });
      const channel = new MessageChannel();
      worker.postMessage({ type: 'connectPort' }, [channel.port1]);
      terrainBakeWorker.postMessage({ type: 'connectPort' }, [channel.port2]);
    } catch (bakeErr) {
      console.warn('Could not initialize parallel TerrainBakeWorker, using in-worker OffscreenCanvas fallback:', bakeErr);
    }

    worker.addEventListener('message', async (event) => {
      const { requestId, preserveCamera, world: rawWorld } = event.data;
      const resolveList = inflightResolvers.get(requestId) || [];
      inflightResolvers.delete(requestId);

      // If a newer slider/seed request arrived while this worker job was running,
      // immediately dispatch the newest coalesced job!
      if (pendingJob) {
        const next = pendingJob;
        pendingJob = null;
        dispatchToWorker(next);
      } else {
        workerBusy = false;
      }

      const world = hydrateTransferredWorld(rawWorld);
      await applyGeneratedWorld(world, preserveCamera, true);
      for (const r of resolveList) r(world);
    });
    worker.addEventListener('error', (err) => {
      console.error('World Worker error, falling back to main thread:', err);
      workerBusy = false;
    });
    return worker;
  } catch (err) {
    console.warn('Could not initialize module Worker:', err);
    return null;
  }
}

worldWorker = initWorldWorker();

function dispatchToWorker(job) {
  workerBusy = true;
  inflightResolvers.set(job.requestId, job.resolvers);
  worldWorker.postMessage({
    requestId: job.requestId,
    config: job.config,
    preserveCamera: job.preserveCamera
  });
}

async function applyGeneratedWorld(world, preserveCamera, fromWorker = false) {
  if (world.terrainBitmap) {
    renderer.setTerrainBitmap(world.terrainBitmap);
  } else if (!world.reuseTerrainBitmap || !renderer.offscreenTerrain) {
    await renderer.bakeStaticTerrainAsync(world);
  }
  currentWorld = world;
  simulator = new LogisticsSimulator(currentWorld);
  window.currentWorld = currentWorld;
  window.simulator = simulator;

  renderer.selectedEntity = null;
  currentInspected = { type: null, entity: null };
  document.getElementById('inspectorCard').classList.add('hidden');

  if (!preserveCamera) {
    renderer.fitCamera(currentWorld);
  }
  updateTelemetryUI(currentWorld, fromWorker);
}

export function getGeneratorConfig() {
  return {
    seed: document.getElementById('seedInput').value.trim() || 'MINI-TYCOON',
    worldSize: document.getElementById('worldSizeSelect')?.value || 'standard',
    archetype: document.getElementById('archetypeSelect').value,
    terrainAlgo: document.getElementById('terrainAlgoSelect')?.value || 'tectonic-fbm',
    hydrologyAlgo: document.getElementById('hydrologyAlgoSelect')?.value || 'thalweg-astar',
    airportMix: document.getElementById('airportMixSelect').value,
    includeIntermediateRamps: document.getElementById('toggleInterRamps').checked,
    waterCoverage: parseInt(document.getElementById('sliderWater').value, 10),
    townCount: parseInt(document.getElementById('sliderTowns').value, 10),
    buildingDensity: parseInt(document.getElementById('sliderDensity').value, 10),
    airportCount: parseInt(document.getElementById('sliderAirports').value, 10),
    windAxis: parseInt(document.getElementById('sliderWind').value, 10)
  };
}

export function updateAirportSliderLabel() {
  const total = parseInt(document.getElementById('sliderAirports').value, 10);
  const mix = document.getElementById('airportMixSelect').value;
  let hubs = 1;
  let cargo = 0;
  if (mix === 'dual-hub' && total >= 2) hubs = 2;
  if (mix === 'hub-reg-cargo' && total >= 3) cargo = 1;
  const reg = Math.max(0, total - hubs - cargo);
  const parts = [`${hubs} Hub`];
  if (reg > 0) parts.push(`${reg} Reg`);
  if (cargo > 0) parts.push(`${cargo} Crg`);
  document.getElementById('valAirports').textContent = `${total} (${parts.join(', ')})`;
}

export function rebuildWorld(preserveCamera = false) {
  // Update UI synchronously for immediate visual feedback (INP best practice)
  updateAirportSliderLabel();
  const badgeEl = document.getElementById('genTimeBadge');
  if (badgeEl) badgeEl.textContent = 'Worker…';

  const cfg = getGeneratorConfig();

  if (worldWorker) {
    return new Promise((resolve) => {
      if (!workerBusy) {
        const requestId = nextRequestId++;
        dispatchToWorker({
          requestId,
          config: cfg,
          preserveCamera,
          resolvers: [resolve]
        });
      } else {
        if (pendingJob) {
          pendingJob.config = cfg;
          pendingJob.preserveCamera = pendingJob.preserveCamera && preserveCamera;
          pendingJob.resolvers.push(resolve);
        } else {
          pendingJob = {
            requestId: nextRequestId++,
            config: cfg,
            preserveCamera,
            resolvers: [resolve]
          };
        }
      }
    });
  }

  // Fallback if Worker is unavailable
  const world = fallbackPipeline(cfg);
  return applyGeneratedWorld(world, preserveCamera, false);
}

window.rebuildWorld = rebuildWorld;
window.openEntityInspector = openEntityInspector;

function updateTelemetryUI(world, fromWorker = false) {
  const gridLabelEl = document.getElementById('telemetryGridLabel');
  if (gridLabelEl) {
    gridLabelEl.textContent = `State Telemetry (${world.W}×${world.H} Grid)`;
  }
  const displayMs = world.wallTimeMs ?? world.genTimeMs;
  const cacheSuffix =
    world.reusedThroughStage > 0
      ? ` · Cached S1–S${world.reusedThroughStage}`
      : (fromWorker ? ' · 2W Parallel' : '');
  document.getElementById('genTimeBadge').textContent = `${displayMs} ms${cacheSuffix}`;
  document.getElementById('statPop').textContent = world.houses.length + world.destinations.length;
  const hubs = world.airports.filter(a => a.airportClass === 'HUB').length;
  const others = world.airports.length - hubs;
  document.getElementById('statAirports').textContent = `${hubs}H / ${others}R`;
  const clovers = world.interchanges.filter(i => i.type === 'cloverleaf' || i.type === 'trumpet').length;
  const ramps = world.interchanges.filter(i => i.type === 'diamond-ramp').length;
  document.getElementById('statBridges').textContent = `${clovers}C / ${ramps}R`;

  const logEl = document.getElementById('pipelineLog');
  logEl.innerHTML = world.logs
    .map(l => `<div class="flex items-start gap-1.5"><span class="text-pink-600 font-bold">•</span><span>${l}</span></div>`)
    .join('');
}

let currentInspected = { type: null, entity: null };

function describeBuildingDossier(d) {
  const hostTown = currentWorld ? currentWorld.towns[d.townId] : null;
  const townName = hostTown ? hostTown.name : 'Regional';
  if (d.zoneType === 'commercial') {
    return {
      stage: 'COM',
      badge: d.isCircular ? 'CBD · LANDMARK' : 'COM · ARTERIAL',
      badgeClass: 'bg-blue-700 text-white',
      shortTag: d.isCircular ? 'CBD' : 'COM',
      title: d.isCircular ? `${townName} Central Plaza` : `${townName} Commercial Exchange`,
      roleDesc: 'Final consumer & commercial destination receiving finished goods and commuter trips.'
    };
  }
  if (d.subType === 'RAW') {
    if (d.resourceType === 'MINE') {
      return {
        stage: 'RAW',
        badge: 'RAW · MINE',
        badgeClass: 'bg-amber-700 text-white',
        shortTag: 'MINE',
        title: `${townName} Foothill Quarry`,
        roleDesc: 'Out-of-town stone & ore extraction bench perched on steep foothill toes, hauling aggregate to urban factories.'
      };
    }
    if (d.resourceType === 'TIMBER') {
      return {
        stage: 'RAW',
        badge: 'RAW · TIMBER',
        badgeClass: 'bg-amber-700 text-white',
        shortTag: 'WOOD',
        title: `${townName} Forestry Camp`,
        roleDesc: 'Windward upland sawmill and cedar log yard nestled in high-fertility woodland.'
      };
    }
    if (d.resourceType === 'FARM') {
      return {
        stage: 'RAW',
        badge: 'RAW · FARM',
        badgeClass: 'bg-amber-700 text-white',
        shortTag: 'FARM',
        title: `${townName} Alluvial Farmstead`,
        roleDesc: 'Lowland agribusiness homestead with recursive BSP crop parcels, contour-hugging orchards, and broken-grid farm lanes.'
      };
    }
    return {
      stage: 'RAW',
      badge: 'RAW · CHEM',
      badgeClass: 'bg-amber-700 text-white',
      shortTag: 'CHEM',
      title: `${townName} Bulk & Chemical Works`,
      roleDesc: 'Urban-fringe chemical tank farm, pressure vats, and bulk feedstock plant supplying local manufacturing.'
    };
  }
  if (d.subType === 'LOG') {
    return {
      stage: 'LOG',
      badge: 'LOG · HUB',
      badgeClass: 'bg-purple-700 text-white',
      shortTag: 'LOG',
      title: `${townName} Cross-Dock Logistics`,
      roleDesc: 'High-throughput freight consolidation warehouse distributing manufactured goods to commercial cores.'
    };
  }
  return {
    stage: 'MFG',
    badge: 'MFG · FACTORY',
    badgeClass: 'bg-orange-700 text-white',
    shortTag: 'MFG',
    title: `${townName} Sawtooth Factory`,
    roleDesc: 'North-light sawtooth manufacturing hall converting raw feedstock into finished commercial cargo.'
  };
}

function focusCameraOnEntity(type, entity) {
  if (!currentWorld || !entity) return;
  const ts = currentWorld.tileSize;
  const targetZoom = type === 'town' ? 1.45 : (type === 'airport' ? 1.65 : 2.15);
  renderer.camera.zoom = targetZoom;
  // Offset slightly upward on mobile so the bottom sheet doesn't cover the entity
  const yBias = window.innerWidth < 640 ? canvas.height * 0.36 : canvas.height * 0.5;
  const xBias = window.innerWidth >= 640 ? canvas.width * 0.46 : canvas.width * 0.5;
  renderer.camera.x = xBias - (entity.x + 0.5) * ts * targetZoom;
  renderer.camera.y = yBias - (entity.y + 0.5) * ts * targetZoom;
}

function openEntityInspector(type, entity, shouldFocus = false) {
  const normalizedType = type === 'resource' ? 'building' : type;
  currentInspected = { type: normalizedType, entity };
  renderer.selectedEntity = entity;
  if (shouldFocus) {
    focusCameraOnEntity(normalizedType, entity);
  }

  const card = document.getElementById('inspectorCard');
  const badge = document.getElementById('inspBadge');
  const code = document.getElementById('inspCode');
  const title = document.getElementById('inspTitle');
  const body = document.getElementById('inspBody');

  card.classList.remove('hidden');

  if (normalizedType === 'airport') {
    const hostTown = currentWorld.towns[entity.hostTownId];
    badge.textContent = entity.classLabel.toUpperCase();
    badge.className = 'text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md bg-[#e85c90] text-white tracking-wide';
    code.textContent = `IATA ${entity.iata} • ${entity.runwayLabel}`;
    title.textContent = entity.name;
    body.innerHTML = `
      <div class="divide-y divide-stone-300/60 border-y border-stone-300/60">
        <div class="flex items-center justify-between py-1.5">
          <span class="text-stone-500 font-medium">Runway Configuration</span>
          <span class="mono font-bold text-[#36383e] tabular-nums">${entity.runwayCount} Parallel • ${entity.runwayLabel}</span>
        </div>
        <div class="flex items-center justify-between py-1.5">
          <span class="text-stone-500 font-medium">Approach Obstacle Cone</span>
          <span class="mono font-bold text-emerald-700 tabular-nums">${entity.approachClearance}% Clear</span>
        </div>
        <div class="flex items-center justify-between py-1.5">
          <span class="text-stone-500 font-medium">Expressway Gateway</span>
          <span class="mono font-bold text-[#36383e] tabular-nums">Motorway [${entity.motorwayId || 1}] (${entity.distToCBD} tiles)</span>
        </div>
        ${hostTown ? `
        <div class="flex items-center justify-between py-1.5">
          <span class="text-stone-500 font-medium">Host Municipality</span>
          <button type="button" data-jump-town="${hostTown.id}" class="font-bold text-[#36383e] hover:text-[#e85c90] underline underline-offset-2 transition flex items-center gap-1">
            <span>${hostTown.name} (T${hostTown.tier})</span>
            <svg class="w-3 h-3" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
          </button>
        </div>` : ''}
      </div>
      <p class="text-[11px] text-stone-600 leading-relaxed">
        Served by a grade-separated landside terminal loop road and dual-carriageway spine anchored into <b>Motorway [${entity.motorwayId || 1}]</b>.
      </p>
    `;
  } else if (normalizedType === 'building') {
    const info = describeBuildingDossier(entity);
    const hostTown = currentWorld.towns[entity.townId];
    const allLinks = currentWorld.cargoLinks || [];
    const inboundLinks = allLinks.filter(l => l.to.id === entity.id);
    const outboundLinks = allLinks.filter(l => l.from.id === entity.id);

    badge.textContent = info.badge;
    badge.className = `text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md ${info.badgeClass} tracking-wide`;
    code.textContent = `LOT #${entity.id} • (${entity.gx}, ${entity.gy})`;
    title.textContent = info.title;

    // 4-Stage Supply-Chain Pipeline Stepper (`RAW -> MFG -> LOG -> COM`)
    const stages = [
      { key: 'RAW', label: '1. RAW', tone: 'bg-amber-700 text-white border-amber-700' },
      { key: 'MFG', label: '2. MFG', tone: 'bg-orange-700 text-white border-orange-700' },
      { key: 'LOG', label: '3. LOG', tone: 'bg-purple-700 text-white border-purple-700' },
      { key: 'COM', label: '4. CBD', tone: 'bg-blue-700 text-white border-blue-700' }
    ];
    const connectedStageSet = new Set();
    for (const l of inboundLinks) connectedStageSet.add(describeBuildingDossier(l.from).stage);
    for (const l of outboundLinks) connectedStageSet.add(describeBuildingDossier(l.to).stage);

    const pipelineHtml = stages.map((st, idx) => {
      const isActive = st.key === info.stage;
      const isLinked = !isActive && connectedStageSet.has(st.key);
      const pillCls = isActive
        ? `${st.tone} shadow-xs font-extrabold`
        : (isLinked
          ? 'bg-white text-[#36383e] border-stone-400 font-bold'
          : 'bg-stone-200/60 text-stone-500 border-stone-300/70 font-semibold');
      const arrow = idx < stages.length - 1
        ? `<svg class="w-3 h-3 text-stone-400 shrink-0" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>`
        : '';
      return `
        <div class="flex items-center gap-1 flex-1 min-w-0">
          <div class="flex-1 text-center text-[10px] py-1 px-1.5 rounded-lg border ${pillCls} truncate">
            ${st.label}
          </div>
          ${arrow}
        </div>
      `;
    }).join('');

    const wT = entity.wTiles || 2;
    const hT = entity.hTiles || 2;
    let siteMetricLabel = 'Footprint & Frontage';
    let siteMetricVal = `${wT}×${hT} Tiles • Road (${entity.roadX}, ${entity.roadY})`;
    if (entity.resourceType === 'FARM' && entity.bspParcels) {
      siteMetricLabel = 'Estate Cadastral Layout';
      siteMetricVal = `${entity.bspParcels.length} Parcels • ${(entity.tractorTracks || []).length} Farm Tracks`;
    } else if (entity.resourceType === 'MINE') {
      const slopePct = Math.round((currentWorld.slopeField[currentWorld.idx(entity.gx, entity.gy)] || 0.1) * 100);
      siteMetricLabel = 'Geologic Bench';
      siteMetricVal = `${wT}×${hT} Quarry • ${slopePct}% Foothill Grade`;
    } else if (entity.resourceType === 'TIMBER') {
      const fertPct = Math.round((currentWorld.fertilityField[currentWorld.idx(entity.gx, entity.gy)] || 0.6) * 100);
      siteMetricLabel = 'Woodland Stand';
      siteMetricVal = `${wT}×${hT} Sawmill • ${fertPct}% Windward Fertility`;
    }

    const renderLinkRow = (link, dir) => {
      const partner = dir === 'in' ? link.from : link.to;
      const pInfo = describeBuildingDossier(partner);
      const distTiles = (link.points || []).length;
      const dirBadge = dir === 'in'
        ? `<span class="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 shrink-0">← IN · ${pInfo.shortTag}</span>`
        : `<span class="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 shrink-0">→ OUT · ${pInfo.shortTag}</span>`;
      return `
        <button type="button" data-jump-dest="${partner.id}" class="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-white/80 hover:bg-white border border-stone-300/70 hover:border-stone-500 text-left transition group">
          <div class="flex items-center gap-2 min-w-0">
            ${dirBadge}
            <span class="font-bold text-[#36383e] group-hover:text-[#e85c90] truncate">${pInfo.title}</span>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <span class="mono text-[10px] font-bold text-stone-500 tabular-nums">${distTiles}t</span>
            <svg class="w-3.5 h-3.5 text-stone-400 group-hover:text-[#36383e]" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
          </div>
        </button>
      `;
    };

    const allLinksHtml = [
      ...inboundLinks.map(l => renderLinkRow(l, 'in')),
      ...outboundLinks.map(l => renderLinkRow(l, 'out'))
    ].join('');

    body.innerHTML = `
      <div class="flex items-center gap-1">${pipelineHtml}</div>

      <div class="divide-y divide-stone-300/60 border-y border-stone-300/60">
        <div class="flex items-center justify-between py-1.5">
          <span class="text-stone-500 font-medium">Municipality</span>
          ${hostTown ? `
            <button type="button" data-jump-town="${hostTown.id}" class="font-bold text-[#36383e] hover:text-[#e85c90] underline underline-offset-2 transition flex items-center gap-1">
              <span>${hostTown.name} (Tier ${hostTown.tier})</span>
              <svg class="w-3 h-3" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            </button>
          ` : '<span class="font-bold text-[#36383e]">Unincorporated</span>'}
        </div>
        <div class="flex items-center justify-between py-1.5">
          <span class="text-stone-500 font-medium">Demand Channel</span>
          <span class="flex items-center gap-1.5 font-bold text-[#36383e] tabular-nums">
            <span class="w-2.5 h-2.5 rounded-xs inline-block" style="background:${entity.palette.roof}; border-bottom: 2px solid ${entity.palette.base}"></span>
            <span>${entity.palette.name} • ${entity.pinsCount} Cargo Bays</span>
          </span>
        </div>
        <div class="flex items-center justify-between py-1.5">
          <span class="text-stone-500 font-medium">${siteMetricLabel}</span>
          <span class="mono font-bold text-[#36383e] tabular-nums">${siteMetricVal}</span>
        </div>
      </div>

      ${allLinksHtml ? `
        <div class="space-y-1.5">
          <div class="flex items-center justify-between text-[11px] font-bold text-stone-600">
            <span>Connected Supply-Chain Links (${inboundLinks.length} In, ${outboundLinks.length} Out)</span>
            <span class="text-[10px] font-normal text-stone-500">Click to inspect</span>
          </div>
          <div class="space-y-1 max-h-32 overflow-y-auto drawer-scroll pr-0.5">
            ${allLinksHtml}
          </div>
        </div>
      ` : `
        <div class="py-1.5 border-b border-stone-300/60 text-[11px] text-stone-600">
          Served directly by local <b>${entity.palette.name}</b> commuter and light-delivery traffic within <b>${hostTown ? hostTown.name : 'the district'}</b>.
        </div>
      `}

      <p class="text-[11px] text-stone-600 leading-relaxed">${info.roleDesc}</p>
    `;
  } else {
    badge.textContent = `TIER ${entity.tier} · ${entity.tierTitle.toUpperCase()}`;
    badge.className = 'text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md bg-[#36383e] text-white tracking-wide';
    code.textContent = `CODE ${entity.iata} • ${entity.suitabilityScore}% ALLUVIAL FIT`;
    title.textContent = entity.name;

    const ap = entity.airportId !== null ? currentWorld.airports[entity.airportId] : null;
    const rCount = entity.housesCount || 0;
    const cCount = entity.commercialCount || 0;
    const iCount = entity.industrialCount || 0;
    const totalBld = Math.max(1, rCount + cCount + iCount);
    const rPct = Math.round((rCount / totalBld) * 100);
    const cPct = Math.round((cCount / totalBld) * 100);
    const iPct = Math.max(0, 100 - rPct - cPct);

    // Gather key industrial & landmark facilities belonging to this town so the user can jump straight into them!
    const townFacilities = currentWorld.destinations
      .filter(d => d.townId === entity.id && (d.zoneType === 'industrial' || d.isCircular))
      .sort((a, b) => (b.isRuralNiche ? 1 : 0) - (a.isRuralNiche ? 1 : 0))
      .slice(0, 6);

    const facChipsHtml = townFacilities.map(d => {
      const fInfo = describeBuildingDossier(d);
      return `
        <button type="button" data-jump-dest="${d.id}" class="flex items-center justify-between gap-1.5 px-2 py-1 rounded-lg bg-white/80 hover:bg-white border border-stone-300/70 hover:border-stone-500 text-left transition group">
          <span class="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded ${fInfo.badgeClass} shrink-0">${fInfo.shortTag}</span>
          <span class="text-[11px] font-bold text-[#36383e] group-hover:text-[#e85c90] truncate flex-1">${fInfo.title.replace(entity.name + ' ', '')}</span>
          <svg class="w-3 h-3 text-stone-400 group-hover:text-[#36383e] shrink-0" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
        </button>
      `;
    }).join('');

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

      ${facChipsHtml ? `
        <div class="space-y-1.5">
          <div class="flex items-center justify-between text-[11px] font-bold text-stone-600">
            <span>Municipal Industries &amp; Landmarks</span>
            <span class="text-[10px] font-normal text-stone-500">Click to inspect</span>
          </div>
          <div class="grid grid-cols-2 gap-1.5">
            ${facChipsHtml}
          </div>
        </div>
      ` : ''}

      <p class="text-[11px] text-stone-600 leading-relaxed">
        Multi-borough block grid (${(entity.boroughs || []).length || 1} boroughs). ${ap ? `Served by <button type="button" data-jump-ap="${ap.id}" class="font-bold text-[#36383e] hover:text-[#e85c90] underline underline-offset-2">${ap.name} (${ap.iata})</button>.` : ''}
      </p>
    `;
  }
}

// Event delegation inside `#inspBody` for Supply-Chain & Facility navigation buttons
document.getElementById('inspBody').addEventListener('click', (e) => {
  if (!currentWorld) return;
  const destBtn = e.target.closest('[data-jump-dest]');
  if (destBtn) {
    const destId = Number(destBtn.dataset.jumpDest);
    const targetDest = currentWorld.destinations.find(d => d.id === destId);
    if (targetDest) {
      openEntityInspector('building', targetDest, true);
    }
    return;
  }
  const townBtn = e.target.closest('[data-jump-town]');
  if (townBtn) {
    const townId = Number(townBtn.dataset.jumpTown);
    const targetTown = currentWorld.towns[townId];
    if (targetTown) {
      openEntityInspector('town', targetTown, true);
    }
    return;
  }
  const apBtn = e.target.closest('[data-jump-ap]');
  if (apBtn) {
    const apId = Number(apBtn.dataset.jumpAp);
    const targetAp = currentWorld.airports.find(a => a.id === apId);
    if (targetAp) {
      openEntityInspector('airport', targetAp, true);
    }
  }
});

document.getElementById('focusInspectorBtn').addEventListener('click', () => {
  if (currentInspected.entity) {
    focusCameraOnEntity(currentInspected.type, currentInspected.entity);
  }
});

function findEntityAtWorldPos(wx, wy, touchPad = 0) {
  if (!currentWorld) return null;

  // 1. Check Airports (using rotated apron bounding box so circular halos don't swallow nearby buildings)
  for (const ap of currentWorld.airports) {
    const dx = wx - ap.x;
    const dy = wy - ap.y;
    const cosA = Math.cos(-(ap.angleRad || 0));
    const sinA = Math.sin(-(ap.angleRad || 0));
    const lx = dx * cosA - dy * sinA;
    const ly = dx * sinA + dy * cosA;
    if (Math.abs(lx) <= ap.halfLen + 1.4 + touchPad && Math.abs(ly) <= ap.halfWid + 1.8 + touchPad) {
      return { type: 'airport', entity: ap };
    }
  }

  // 2. Check All Industrial & Commercial Buildings (`currentWorld.destinations`) — highest specificity!
  let bestBuilding = null;
  let bestBldDist = Infinity;
  const bldPad = 0.65 + touchPad * 0.65;
  for (const d of currentWorld.destinations) {
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
    return { type: 'building', entity: bestBuilding };
  }

  // 3. Check Sprawling Farm Field Estates (`d.bspParcels`) so clicking a farm's crop fields also selects the farm
  for (const d of currentWorld.destinations) {
    if (d.resourceType !== 'FARM' || !d.bspParcels) continue;
    for (const p of d.bspParcels) {
      if (wx >= p.x0 && wx <= p.x1 && wy >= p.y0 && wy <= p.y1) {
        return { type: 'building', entity: d };
      }
    }
  }

  // 4. Check Municipalities (`currentWorld.towns`)
  for (const t of currentWorld.towns) {
    if (Math.hypot(wx - t.x, wy - t.y) <= t.urbanRadius + touchPad) {
      return { type: 'town', entity: t };
    }
  }

  return null;
}

function handleResize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  if (currentWorld) renderer.fitCamera(currentWorld);
}
window.addEventListener('resize', handleResize);

function zoomAroundPoint(factor, centerX, centerY) {
  const newZoom = Math.max(0.16, Math.min(3.5, renderer.camera.zoom * factor));
  renderer.camera.x = centerX - (centerX - renderer.camera.x) * (newZoom / renderer.camera.zoom);
  renderer.camera.y = centerY - (centerY - renderer.camera.y) * (newZoom / renderer.camera.zoom);
  renderer.camera.zoom = newZoom;
}

// Multi-Touch Pinch-to-Zoom, Pan & Tap Inspection on Canvas
const activePointers = new Map();
let isDragging = false;
let hadMultiTouch = false;
let dragStart = { x: 0, y: 0 };
let pointerDownPos = { x: 0, y: 0 };
let lastPinchDist = 0;
let lastPinchMid = { x: 0, y: 0 };
let lastTapTime = 0;

function getTwoPointerMetrics() {
  const pts = Array.from(activePointers.values());
  const dx = pts[1].x - pts[0].x;
  const dy = pts[1].y - pts[0].y;
  return {
    dist: Math.hypot(dx, dy) || 1,
    midX: (pts[0].x + pts[1].x) * 0.5,
    midY: (pts[0].y + pts[1].y) * 0.5
  };
}

canvas.addEventListener('pointerdown', (e) => {
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch (_) {}

  if (activePointers.size === 1) {
    isDragging = true;
    hadMultiTouch = false;
    dragStart.x = e.clientX - renderer.camera.x;
    dragStart.y = e.clientY - renderer.camera.y;
    pointerDownPos = { x: e.clientX, y: e.clientY };
  } else if (activePointers.size === 2) {
    hadMultiTouch = true;
    const m = getTwoPointerMetrics();
    lastPinchDist = m.dist;
    lastPinchMid = { x: m.midX, y: m.midY };
  }
});

window.addEventListener('pointermove', (e) => {
  if (!activePointers.has(e.pointerId)) {
    if (currentWorld && e.target === canvas) {
      const wx = (e.clientX - renderer.camera.x) / (renderer.camera.zoom * currentWorld.tileSize);
      const wy = (e.clientY - renderer.camera.y) / (renderer.camera.zoom * currentWorld.tileSize);
      const hit = findEntityAtWorldPos(wx, wy, 0);
      canvas.style.cursor = hit ? 'pointer' : 'grab';
    }
    return;
  }
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 2) {
    const m = getTwoPointerMetrics();
    const scaleFactor = m.dist / (lastPinchDist || m.dist);
    const newZoom = Math.max(0.16, Math.min(3.5, renderer.camera.zoom * scaleFactor));
    renderer.camera.x = m.midX - (lastPinchMid.x - renderer.camera.x) * (newZoom / renderer.camera.zoom);
    renderer.camera.y = m.midY - (lastPinchMid.y - renderer.camera.y) * (newZoom / renderer.camera.zoom);
    renderer.camera.zoom = newZoom;
    lastPinchDist = m.dist;
    lastPinchMid = { x: m.midX, y: m.midY };
  } else if (activePointers.size === 1 && isDragging) {
    const pt = activePointers.values().next().value;
    renderer.camera.x = pt.x - dragStart.x;
    renderer.camera.y = pt.y - dragStart.y;
  }
});

function handlePointerEnd(e) {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.delete(e.pointerId);

  if (activePointers.size === 1) {
    const remaining = activePointers.values().next().value;
    dragStart.x = remaining.x - renderer.camera.x;
    dragStart.y = remaining.y - renderer.camera.y;
    return;
  }

  if (activePointers.size === 0 && isDragging) {
    isDragging = false;
    if (hadMultiTouch) return;

    const tapThreshold = e.pointerType === 'touch' ? 12 : 6;
    const moveDist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
    if (moveDist < tapThreshold && currentWorld) {
      const wx = (e.clientX - renderer.camera.x) / (renderer.camera.zoom * currentWorld.tileSize);
      const wy = (e.clientY - renderer.camera.y) / (renderer.camera.zoom * currentWorld.tileSize);
      const touchPad = e.pointerType === 'touch' ? 2.2 : 0;

      const hit = findEntityAtWorldPos(wx, wy, touchPad);
      if (hit) {
        if (window.innerWidth < 640) {
          document.getElementById('generatorDrawer').classList.add('hidden');
        }
        openEntityInspector(hit.type, hit.entity, false);
        return;
      }

      const now = performance.now();
      if (e.pointerType === 'touch' && now - lastTapTime < 300) {
        zoomAroundPoint(1.35, e.clientX, e.clientY);
        lastTapTime = 0;
        return;
      }
      lastTapTime = now;

      renderer.selectedEntity = null;
      currentInspected = { type: null, entity: null };
      document.getElementById('inspectorCard').classList.add('hidden');
      if (window.innerWidth < 640) {
        document.getElementById('generatorDrawer').classList.add('hidden');
      }
    }
  }
}

window.addEventListener('pointerup', handlePointerEnd);
window.addEventListener('pointercancel', handlePointerEnd);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
  zoomAroundPoint(zoomFactor, e.clientX, e.clientY);
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    renderer.selectedEntity = null;
    currentInspected = { type: null, entity: null };
    document.getElementById('inspectorCard').classList.add('hidden');
    return;
  }
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  const panStep = 40;
  if (e.key === 'ArrowLeft') renderer.camera.x += panStep;
  else if (e.key === 'ArrowRight') renderer.camera.x -= panStep;
  else if (e.key === 'ArrowUp') renderer.camera.y += panStep;
  else if (e.key === 'ArrowDown') renderer.camera.y -= panStep;
  else if (e.key === '+' || e.key === '=') zoomAroundPoint(1.18, canvas.width * 0.5, canvas.height * 0.5);
  else if (e.key === '-') zoomAroundPoint(0.84, canvas.width * 0.5, canvas.height * 0.5);
});

// UI Control Bindings
document.getElementById('toggleDrawerBtn').addEventListener('click', () => {
  const drawer = document.getElementById('generatorDrawer');
  drawer.classList.toggle('hidden');
  if (!drawer.classList.contains('hidden') && window.innerWidth < 640) {
    document.getElementById('inspectorCard').classList.add('hidden');
  }
});

document.getElementById('closeDrawerMobileBtn').addEventListener('click', () => {
  document.getElementById('generatorDrawer').classList.add('hidden');
});

document.getElementById('closeInspectorBtn').addEventListener('click', () => {
  renderer.selectedEntity = null;
  currentInspected = { type: null, entity: null };
  document.getElementById('inspectorCard').classList.add('hidden');
});

document.getElementById('resetViewBtn').addEventListener('click', () => {
  if (currentWorld) renderer.fitCamera(currentWorld);
  if (window.innerWidth < 640) {
    document.getElementById('generatorDrawer').classList.add('hidden');
  }
});

document.getElementById('zoomInBtn').addEventListener('click', () => {
  zoomAroundPoint(1.25, canvas.width * 0.5, canvas.height * 0.5);
});

document.getElementById('zoomOutBtn').addEventListener('click', () => {
  zoomAroundPoint(0.8, canvas.width * 0.5, canvas.height * 0.5);
});

document.getElementById('hudFitBtn').addEventListener('click', () => {
  if (currentWorld) renderer.fitCamera(currentWorld);
});

document.getElementById('randomSeedBtn').addEventListener('click', () => {
  const prefixes = ['METRO', 'DELTA', 'TYCOON', 'AIRWAY', 'VALLEY', 'HARBOR'];
  const p = prefixes[Math.floor(Math.random() * prefixes.length)];
  const num = Math.floor(100 + Math.random() * 900);
  document.getElementById('seedInput').value = `${p}-${num}`;
  rebuildWorld(false);
});

document.getElementById('seedInput').addEventListener('change', () => rebuildWorld(true));
document.getElementById('archetypeSelect').addEventListener('change', (e) => {
  if (e.target.value === 'island-hopper') {
    const apSlider = document.getElementById('sliderAirports');
    if (parseInt(apSlider.value, 10) < 5) {
      apSlider.value = '5';
      updateAirportSliderLabel();
    }
  }
  rebuildWorld(false);
});
const worldSizeDefaults = {
  compact: { towns: 14, airports: 2 },
  standard: { towns: 20, airports: 3 },
  large: { towns: 28, airports: 4 },
  huge: { towns: 36, airports: 5 }
};

document.getElementById('worldSizeSelect').addEventListener('change', (e) => {
  const def = worldSizeDefaults[e.target.value];
  if (def) {
    const tSlider = document.getElementById('sliderTowns');
    const aSlider = document.getElementById('sliderAirports');
    tSlider.value = String(def.towns);
    document.getElementById('valTowns').textContent = `${def.towns} Towns`;
    aSlider.value = String(def.airports);
    updateAirportSliderLabel();
  }
  rebuildWorld(false);
});
document.getElementById('terrainAlgoSelect').addEventListener('change', () => rebuildWorld(true));
document.getElementById('hydrologyAlgoSelect').addEventListener('change', () => rebuildWorld(true));
document.getElementById('airportMixSelect').addEventListener('change', () => rebuildWorld(true));
document.getElementById('toggleInterRamps').addEventListener('change', () => rebuildWorld(true));

const windNames = { '-1': 'Auto (Seed)', '0': '09/27 (E–W)', '1': '04/22 (NE–SW)', '2': '18/36 (N–S)', '3': '13/31 (NW–SE)' };

document.getElementById('sliderWater').addEventListener('input', (e) => {
  document.getElementById('valWater').textContent = `${e.target.value}%`;
  rebuildWorld(true);
});
document.getElementById('sliderTowns').addEventListener('input', (e) => {
  document.getElementById('valTowns').textContent = `${e.target.value} Towns`;
  rebuildWorld(true);
});
document.getElementById('sliderDensity').addEventListener('input', (e) => {
  document.getElementById('valDensity').textContent = `${e.target.value}%`;
  rebuildWorld(true);
});
document.getElementById('sliderAirports').addEventListener('input', () => {
  updateAirportSliderLabel();
  rebuildWorld(true);
});
document.getElementById('sliderWind').addEventListener('input', (e) => {
  document.getElementById('valWind').textContent = windNames[e.target.value];
  rebuildWorld(true);
});

// Layer Overlay Buttons
const layerBadges = {
  aesthetic: 'Mini Motorways View',
  rci: 'RCI Zoning & Cargo Chain',
  airport: 'Airport Solver & Cones',
  hierarchy: 'Central Place Graph',
  hydrology: 'Topography & Suitability',
  roadgrid: 'Road Grid & Vector Graph'
};
document.querySelectorAll('.layer-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderer.activeLayer = btn.dataset.layer;
    document.getElementById('activeLayerBadge').textContent = layerBadges[renderer.activeLayer];
  });
});

// Simulation Speed Buttons
document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => {
      b.classList.remove('bg-[#36383e]', 'text-[#f2efe9]');
      b.classList.add('text-stone-500');
    });
    btn.classList.remove('text-stone-500');
    btn.classList.add('bg-[#36383e]', 'text-[#f2efe9]');
    simSpeed = parseFloat(btn.dataset.speed);
  });
});

// Main Animation Loop
let lastTime = performance.now();
function animate(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (currentWorld && simulator) {
    simulator.update(dt, simSpeed);
    renderer.render(currentWorld, simulator);

    document.getElementById('tripCounter').textContent = simulator.tripsCompleted.toLocaleString();
    const clockAngle = (simulator.simTime * 24) % 360;
    document.getElementById('clockHand').style.transform = `rotate(${clockAngle}deg)`;
    const dayIdx = Math.floor((simulator.simTime * 24) / 360) % 7;
    document.getElementById('dayLabel').textContent = daysOfWeek[dayIdx];
  }
  requestAnimationFrame(animate);
}

function initApp() {
  const swatchContainer = document.getElementById('colorSwatches');
  if (swatchContainer) {
    swatchContainer.innerHTML = PALETTE.districtColors.map(c =>
      `<div class="flex items-center gap-1 bg-white/80 px-1.5 py-0.5 rounded-md border border-stone-300/60" title="${c.name} Demand Channel">
         <span class="w-2.5 h-2.5 rounded-sm" style="background:${c.roof}; border-bottom: 2px solid ${c.base}"></span>
         <span class="text-[9px] font-bold text-stone-600">${c.name.slice(0, 3)}</span>
       </div>`
    ).join('');
  }
  if (window.innerWidth < 768) {
    document.getElementById('generatorDrawer').classList.add('hidden');
  }
  handleResize();
  rebuildWorld(false);
  requestAnimationFrame(animate);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
