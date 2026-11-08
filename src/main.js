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

function openEntityInspector(type, entity) {
  const card = document.getElementById('inspectorCard');
  const badge = document.getElementById('inspBadge');
  const code = document.getElementById('inspCode');
  const title = document.getElementById('inspTitle');
  const body = document.getElementById('inspBody');

  card.classList.remove('hidden');

  if (type === 'airport') {
    badge.textContent = entity.classLabel.toUpperCase();
    badge.className = 'text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full bg-[#e85c90] text-white';
    code.textContent = `IATA: ${entity.iata} • ${entity.runwayLabel}`;
    title.textContent = entity.name;
    body.innerHTML = `
      <div class="grid grid-cols-3 gap-1.5 text-center bg-stone-200/50 p-2 rounded-xl">
        <div>
          <div class="mono font-extrabold text-[#36383e]">${entity.runwayCount} RWY</div>
          <div class="text-[10px] text-stone-500">Configuration</div>
        </div>
        <div>
          <div class="mono font-extrabold text-emerald-600">${entity.approachClearance}%</div>
          <div class="text-[10px] text-stone-500">Approach Cone</div>
        </div>
        <div>
          <div class="mono font-extrabold text-[#36383e]">${entity.distToCBD} tiles</div>
          <div class="text-[10px] text-stone-500">To Host CBD</div>
        </div>
      </div>
      <p class="text-[11px] leading-relaxed">
        Served by a dedicated <b>Landside Curbside Terminal Loop Road</b> and dual-carriageway access spine stub anchored directly into <b>Motorway [${entity.motorwayId || 1}]</b> near <b>${entity.hostTownName}</b>.
      </p>
    `;
  } else {
    badge.textContent = `TIER ${entity.tier} ${entity.tierTitle.toUpperCase()}`;
    badge.className = 'text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full bg-[#36383e] text-white';
    code.textContent = `CODE: ${entity.iata}`;
    title.textContent = entity.name;
    const ap = entity.airportId !== null ? currentWorld.airports[entity.airportId] : null;
    body.innerHTML = `
      <div class="grid grid-cols-3 gap-1.5 text-center bg-stone-200/50 p-2 rounded-xl">
        <div>
          <div class="mono font-extrabold text-emerald-700">${entity.housesCount}</div>
          <div class="text-[10px] text-stone-500">R Houses</div>
        </div>
        <div>
          <div class="mono font-extrabold text-blue-700">${entity.commercialCount || 0}</div>
          <div class="text-[10px] text-stone-500">C Commercial</div>
        </div>
        <div>
          <div class="mono font-extrabold text-amber-700">${entity.industrialCount || 0}</div>
          <div class="text-[10px] text-stone-500">I Industrial</div>
        </div>
      </div>
      <p class="text-[11px] leading-relaxed">
        Organic multi-borough block grid (${entity.suitabilityScore}% alluvial fit). Commercial sinks cluster on arterial boulevards; peripheral industries feed the regional <b>RAW → MFG → LOG → CBD</b> cargo chain. ${ap ? `Served by <b>${ap.name} (${ap.iata})</b>.` : ''}
      </p>
    `;
  }
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
  if (!activePointers.has(e.pointerId)) return;
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
      const touchPad = e.pointerType === 'touch' ? 2.5 : 0;

      for (const ap of currentWorld.airports) {
        if (Math.hypot(wx - ap.x, wy - ap.y) <= ap.halfLen + 2 + touchPad) {
          renderer.selectedEntity = ap;
          if (window.innerWidth < 640) {
            document.getElementById('generatorDrawer').classList.add('hidden');
          }
          openEntityInspector('airport', ap);
          return;
        }
      }
      for (const t of currentWorld.towns) {
        if (Math.hypot(wx - t.x, wy - t.y) <= t.urbanRadius + touchPad) {
          renderer.selectedEntity = t;
          if (window.innerWidth < 640) {
            document.getElementById('generatorDrawer').classList.add('hidden');
          }
          openEntityInspector('town', t);
          return;
        }
      }

      const now = performance.now();
      if (e.pointerType === 'touch' && now - lastTapTime < 300) {
        zoomAroundPoint(1.35, e.clientX, e.clientY);
        lastTapTime = 0;
        return;
      }
      lastTapTime = now;

      renderer.selectedEntity = null;
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

canvas.addEventListener('keydown', (e) => {
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
  hydrology: 'Topography & Suitability'
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
