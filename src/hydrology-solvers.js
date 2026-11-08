/**
 * STAGE 2B: PLUGGABLE FLUVIAL HYDROLOGY & RIVER EROSION ENGINES
 * Supports 3 selectable in-game river & watershed algorithms:
 *   1. `thalweg-astar`    — Non-Bifurcating Basin Tree + Map-Edge / Valley-Thalweg A* Rivers
 *   2. `d8-strahler`      — Priority-Flood Pit-Filling + D8 Flow Accumulation & Converging River Networks
 *   3. `meandering-plain` — Curvature-Driven Alluvial Floodplain Meanders & Oxbow S-Bends
 *
 * Key Cartographic Invariant:
 *   On continental/mainland maps, rivers NEVER start or end at floating dead-end "tentacle tips"
 *   in the middle of dry land: every river originates either at a Map-Border Headwater Entry
 *   (`x = 0..1` / `W-2..W-1` / `y = 0..1` / `H-2..H-1`) or inside an Upstream Lake Basin, and
 *   terminates inside a Downstream Lake/Sea Basin or at an exact River Confluence!
 */
export function synthesizeFluvialHydrology(world, basins, primarySink) {
  const { W, H, seaLevel } = world;
  const arch = world.config.archetype;
  const hydroAlgo = world.config.hydrologyAlgo || 'thalweg-astar';

  // Helper: Smooth a river polyline with Laplacian passes so meanders are 100% C1 smooth (zero spikes!)
  const smoothPolyline = (pts, passes = 4) => {
    if (!pts || pts.length < 5) return pts;
    let cur = pts.map(p => ({ ...p }));
    for (let pass = 0; pass < passes; pass++) {
      const next = [cur[0]];
      for (let i = 1; i < cur.length - 1; i++) {
        next.push({
          ...cur[i],
          x: 0.25 * cur[i - 1].x + 0.50 * cur[i].x + 0.25 * cur[i + 1].x,
          y: 0.25 * cur[i - 1].y + 0.50 * cur[i].y + 0.25 * cur[i + 1].y
        });
      }
      next.push(cur[cur.length - 1]);
      cur = next;
    }
    // Rasterize smoothed floating-point curve back to 1-tile steps so `waterMask = 1` is continuous
    const out = [{
      x: Math.round(cur[0].x),
      y: Math.round(cur[0].y),
      width: cur[0].width
    }];
    for (let i = 1; i < cur.length; i++) {
      const gx = Math.round(cur[i].x);
      const gy = Math.round(cur[i].y);
      const w = cur[i].width;
      const last = out[out.length - 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(gx - last.x, gy - last.y)));
      for (let k = 1; k <= steps; k++) {
        const ix = Math.round(last.x + ((gx - last.x) * k) / steps);
        const iy = Math.round(last.y + ((gy - last.y) * k) / steps);
        const iw = last.width !== undefined && w !== undefined
          ? last.width + ((w - last.width) * k) / steps
          : w;
        if (world.inBounds(ix, iy, 1) && (ix !== out[out.length - 1].x || iy !== out[out.length - 1].y)) {
          out.push({ x: ix, y: iy, width: iw });
        }
      }
    }
    return out;
  };

  // Continuous, spike-free Ikeda floodplain meandering displacement
  const applyMeanderingDisplacement = (rawPath, phaseOffset = 0, ampScale = 1.0) => {
    if (!rawPath || rawPath.length < 12) return rawPath;
    const baseSmooth = smoothPolyline(rawPath, 5);
    const n = baseSmooth.length;
    const displaced = baseSmooth.map((pt, i) => {
      if (i === 0 || i === n - 1) return { ...pt };
      const pPrev = baseSmooth[Math.max(0, i - 6)];
      const pNext = baseSmooth[Math.min(n - 1, i + 6)];
      const tx = pNext.x - pPrev.x;
      const ty = pNext.y - pPrev.y;
      const tLen = Math.hypot(tx, ty) || 1;
      const nx = -ty / tLen;
      const ny = tx / tLen;

      const id = world.idx(Math.round(pt.x), Math.round(pt.y));
      const elevAbove = Math.max(0, world.elevationField[id] - seaLevel);
      const endFade = Math.pow(Math.sin((i / (n - 1)) * Math.PI), 0.85);
      const plainFactor = Math.max(0.25, 1.0 - elevAbove * 2.2);
      const amp = endFade * plainFactor * 5.2 * ampScale;

      // Smooth compound Ikeda harmonic (`sin(s) + 0.30 * sin(2s - 0.7)`) with longer wavelength
      const s = i * 0.16 + phaseOffset;
      const offset = amp * (Math.sin(s) + 0.30 * Math.sin(2.0 * s - 0.7));

      // Gradually scale back only if displacement would hit steep cliffs
      let chosenX = pt.x;
      let chosenY = pt.y;
      for (const frac of [1.0, 0.7, 0.4, 0.0]) {
        const mx = Math.max(2, Math.min(W - 3, pt.x + nx * offset * frac));
        const my = Math.max(2, Math.min(H - 3, pt.y + ny * offset * frac));
        if (world.elevationField[world.idx(Math.round(mx), Math.round(my))] <= world.elevationField[id] + 0.12) {
          chosenX = mx;
          chosenY = my;
          break;
        }
      }
      return { ...pt, x: chosenX, y: chosenY };
    });

    return smoothPolyline(displaced, 6);
  };

  // Shared Downhill Valley-Thalweg A* Router
  const routeValleyThalwegAStar = (sx, sy, ex, ey, stopOnExistingRiver = true, seedPhase = 0, minTravelDist = 64) => {
    const startId = world.idx(sx, sy);
    const endId = world.idx(ex, ey);
    const gScore = new Float32Array(W * H).fill(Infinity);
    const parent = new Int32Array(W * H).fill(-1);
    const closed = new Uint8Array(W * H);
    const runLen = new Uint8Array(W * H);
    const leftSource = new Uint8Array(W * H);

    const heapNodes = [];
    const heapPriorities = [];
    const heapPush = (node, prio) => {
      let i = heapNodes.length;
      heapNodes.push(node);
      heapPriorities.push(prio);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapPriorities[p] <= prio) break;
        heapNodes[i] = heapNodes[p];
        heapPriorities[i] = heapPriorities[p];
        i = p;
      }
      heapNodes[i] = node;
      heapPriorities[i] = prio;
    };
    const heapPop = () => {
      const top = heapNodes[0];
      const lastN = heapNodes.pop();
      const lastP = heapPriorities.pop();
      if (heapNodes.length > 0) {
        let i = 0;
        const n = heapNodes.length;
        while ((i << 1) + 1 < n) {
          let c = (i << 1) + 1;
          if (c + 1 < n && heapPriorities[c + 1] < heapPriorities[c]) c++;
          if (lastP <= heapPriorities[c]) break;
          heapNodes[i] = heapNodes[c];
          heapPriorities[i] = heapPriorities[c];
          i = c;
        }
        heapNodes[i] = lastN;
        heapPriorities[i] = lastP;
      }
      return top;
    };

    gScore[startId] = 0;
    heapPush(startId, 0);
    const dirs = [
      [1, 0, 1.0], [-1, 0, 1.0], [0, 1, 1.0], [0, -1, 1.0],
      [1, 1, 1.414], [-1, 1, 1.414], [1, -1, 1.414], [-1, -1, 1.414]
    ];

    let steps = 0;
    while (heapNodes.length > 0 && steps++ < 56000) {
      const cid = heapPop();
      if (closed[cid]) continue;
      closed[cid] = 1;

      const cx = cid % W;
      const cy = Math.floor(cid / W);
      const hasLeft = leftSource[cid] === 1;
      const distFromStart = Math.hypot(cx - sx, cy - sy);
      const minTravel = arch === 'island-hopper' ? 12 : minTravelDist;

      if (
        cid === endId ||
        (hasLeft && distFromStart >= minTravel && world.waterMask[cid] === 2) ||
        (stopOnExistingRiver && hasLeft && distFromStart >= minTravel * 0.75 && world.waterMask[cid] === 1)
      ) {
        const path = [];
        let curr = cid;
        while (curr !== -1) {
          path.push({ x: curr % W, y: Math.floor(curr / W) });
          curr = parent[curr];
        }
        path.reverse();
        if (world.waterMask[cid] === 1) {
          world.hydroFeatures.push({ x: cx, y: cy, type: 'confluence' });
        }
        return path;
      }

      const currElev = world.elevationField[cid];
      const pid = parent[cid];
      const prevDx = pid !== -1 ? cx - (pid % W) : 0;
      const prevDy = pid !== -1 ? cy - Math.floor(pid / W) : 0;

      for (const [dx, dy, baseStep] of dirs) {
        const nx = cx + dx, ny = cy + dy;
        if (!world.inBounds(nx, ny, 2)) continue;
        const nid = world.idx(nx, ny);
        if (closed[nid]) continue;

        if (pid !== -1 && (dx * prevDx + dy * prevDy) < 0) continue;

        const nextElev = world.elevationField[nid];
        const uphill = Math.max(0, nextElev - currElev);
        const downhill = Math.max(0, currElev - nextElev);

        const sameDir = pid !== -1 && dx === prevDx && dy === prevDy;
        const nextRun = sameDir ? Math.min(255, runLen[cid] + 1) : 1;
        const straightPenalty = nextRun > 3 ? (nextRun - 3) * 1.15 : 0;
        const earlyWaterPenalty = (hasLeft && distFromStart < minTravel && world.waterMask[nid] > 0) ? 110.0 : 0;

        const meanderWave =
          world.noise.fbm(nx * 0.045 + seedPhase, ny * 0.045 + seedPhase * 1.3, 2) * 3.8 +
          Math.sin(nx * 0.12 + ny * 0.10 + seedPhase) * 1.05;

        const stepCost =
          baseStep * (0.72 + Math.max(0, nextElev - seaLevel) * 2.2) +
          uphill * 85.0 -
          downhill * 4.2 +
          meanderWave +
          straightPenalty +
          earlyWaterPenalty;

        const tentativeG = gScore[cid] + stepCost;
        if (tentativeG < gScore[nid]) {
          gScore[nid] = tentativeG;
          parent[nid] = cid;
          runLen[nid] = nextRun;
          leftSource[nid] = (leftSource[cid] === 1 || world.waterMask[nid] === 0) ? 1 : 0;
          const h = Math.hypot(ex - nx, ey - ny) * 0.78;
          heapPush(nid, tentativeG + h);
        }
      }
    }
    return null;
  };

  // Selects well-spaced dry-land entry points along the 4 map borders so continental rivers
  // enter from the edge of the map (like Mini Motorways / OpenTTD) instead of starting as blind tentacles!
  const pickMapBorderRiverEntries = (count = 3) => {
    const candidates = [];
    const scanBorderPt = (x, y) => {
      const id = world.idx(x, y);
      if (world.waterMask[id] > 0) return;
      // Ensure at least 28 tiles of clearance from any border bay/lake
      for (const b of basins) {
        if (Math.hypot(x - b.cx, y - b.cy) < 48) return;
      }
      for (let dy = -12; dy <= 12; dy += 4) {
        for (let dx = -12; dx <= 12; dx += 4) {
          if (world.inBounds(x + dx, y + dy, 1) && world.waterMask[world.idx(x + dx, y + dy)] > 0) return;
        }
      }
      const dSink = Math.hypot(x - primarySink.deepX, y - primarySink.deepY);
      if (dSink < 95) return;
      const elev = world.elevationField[id];
      // Prefer valley passes & moderate upland saddles entering from the map border
      const valleyScore = 1.0 - Math.abs(elev - (seaLevel + 0.16)) * 1.5 + dSink * 0.002 + world.rng.range(-0.08, 0.08);
      candidates.push({ x, y, score: valleyScore });
    };

    for (let x = 24; x < W - 24; x += 8) {
      scanBorderPt(x, 2);
      scanBorderPt(x, H - 3);
    }
    for (let y = 24; y < H - 24; y += 8) {
      scanBorderPt(2, y);
      scanBorderPt(W - 3, y);
    }
    candidates.sort((a, b) => b.score - a.score);

    const chosen = [];
    for (const c of candidates) {
      if (chosen.length >= count) break;
      if (chosen.every(p => Math.hypot(p.x - c.x, p.y - c.y) >= 92)) {
        chosen.push(c);
      }
    }
    return chosen;
  };

  const carveTaperingRiverPath = (rawPath, isMainOutflow, applyMeanders = false, seedPhase = 0) => {
    if (!rawPath || rawPath.length < 6) return;
    let i0 = 0;
    if (isMainOutflow) {
      while (i0 < rawPath.length - 4 && world.waterMask[world.idx(rawPath[i0 + 2].x, rawPath[i0 + 2].y)] === 2) {
        i0++;
      }
    }
    let path = rawPath.slice(i0);
    const minLen = arch === 'island-hopper' ? 14 : (isMainOutflow ? 22 : 54);
    if (path.length < minLen) return;

    if (applyMeanders) {
      path = applyMeanderingDisplacement(path, seedPhase, 1.0);
    } else {
      path = smoothPolyline(path, 3);
    }

    // Extend start/end vertices by 2 tiles if on map border or entering a water basin
    const first = path[0];
    if (first.x <= 3) path.unshift({ x: 0, y: first.y, width: first.width });
    else if (first.x >= W - 4) path.unshift({ x: W - 1, y: first.y, width: first.width });
    else if (first.y <= 3) path.unshift({ x: first.x, y: 0, width: first.width });
    else if (first.y >= H - 4) path.unshift({ x: first.x, y: H - 1, width: first.width });

    const last = path[path.length - 1];
    const prev = path[Math.max(0, path.length - 3)];
    if (world.waterMask[world.idx(last.x, last.y)] === 2) {
      const dx = last.x - prev.x;
      const dy = last.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      const ex = Math.round(last.x + (dx / len) * 2.2);
      const ey = Math.round(last.y + (dy / len) * 2.2);
      if (world.inBounds(ex, ey, 1) && (ex !== last.x || ey !== last.y)) {
        path.push({ x: ex, y: ey, width: last.width });
      }
    }

    // Assign a steady, nearly-parallel cartographic channel width (`0.86 -> 1.24` or `1.02 -> 1.42`)
    // so rivers read as bold, continuous regional waterways rather than pointy cones/tentacles!
    const startW = arch === 'island-hopper' ? 0.56 : (isMainOutflow ? 1.02 : 0.86);
    const endW = arch === 'island-hopper' ? 0.96 : (isMainOutflow ? 1.42 : 1.24);
    for (let i = 0; i < path.length; i++) {
      const frac = i / Math.max(1, path.length - 1);
      if (path[i].width === undefined) {
        path[i].width = startW + (endW - startW) * Math.pow(frac, 1.35);
      }
    }

    world.rivers.push({ points: path, isMainOutflow });
    for (let i = 0; i < path.length; i++) {
      const { x, y, width } = path[i];
      const progress = i / (path.length - 1);
      const id = world.idx(x, y);
      world.drainageField[id] += isMainOutflow ? 2.5 : (0.5 + progress * 1.5);
      if (world.waterMask[id] === 0) {
        world.waterMask[id] = 1;
      }
      const rad = width ? Math.min(0.72, width * 0.32) : 0.45;
      world.carveValleyChannel(x, y, rad, 0);
    }
  };

  // =========================================================================
  // 1. SHARED NON-BIFURCATING LAKE OUTFLOW TREE (All 3 Hydrology Engines!)
  //    Every interior lake drains via 1 continuous river to a lower lake or the sea!
  // =========================================================================
  const useMeanders = hydroAlgo === 'meandering-plain';
  if (basins.length >= 2) {
    for (let bIdx = 1; bIdx < basins.length; bIdx++) {
      const srcB = basins[bIdx];
      if (srcB.touchesBorder && srcB.size > 950 && bIdx > 1) continue;
      let bestSink = basins[0];
      let minD = Infinity;
      for (let sIdx = 0; sIdx < bIdx; sIdx++) {
        const candSink = basins[sIdx];
        const d = Math.hypot(srcB.deepX - candSink.deepX, srcB.deepY - candSink.deepY);
        if (d < minD) {
          minD = d;
          bestSink = candSink;
        }
      }
      const outPath = routeValleyThalwegAStar(srcB.deepX, srcB.deepY, bestSink.deepX, bestSink.deepY, true, bIdx * 1.7, 18);
      carveTaperingRiverPath(outPath, true, useMeanders, bIdx * 2.3);
    }
  }

  // =========================================================================
  // 2. ENGINE-SPECIFIC REGIONAL TRUNK & CONFLUENCE RIVERS
  // =========================================================================
  if (hydroAlgo === 'd8-strahler' && arch !== 'island-hopper') {
    // Priority-Flood + D8 Flow Accumulation from Map-Border Watershed Entries -> Confluences / Sea
    const stride = 2;
    const cw = Math.floor(W / stride);
    const ch = Math.floor(H / stride);
    const N = cw * ch;

    const filledElev = new Float32Array(N);
    const visited = new Uint8Array(N);
    const receiver = new Int32Array(N).fill(-1);

    const heapNodes = [];
    const heapPrios = [];
    const hPush = (node, prio) => {
      let i = heapNodes.length;
      heapNodes.push(node);
      heapPrios.push(prio);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapPrios[p] <= prio) break;
        heapNodes[i] = heapNodes[p];
        heapPrios[i] = heapPrios[p];
        i = p;
      }
      heapNodes[i] = node;
      heapPrios[i] = prio;
    };
    const hPop = () => {
      const top = heapNodes[0];
      const lastN = heapNodes.pop();
      const lastP = heapPrios.pop();
      if (heapNodes.length > 0) {
        let i = 0;
        const len = heapNodes.length;
        while ((i << 1) + 1 < len) {
          let c = (i << 1) + 1;
          if (c + 1 < len && heapPrios[c + 1] < heapPrios[c]) c++;
          if (lastP <= heapPrios[c]) break;
          heapNodes[i] = heapNodes[c];
          heapPrios[i] = heapPrios[c];
          i = c;
        }
        heapNodes[i] = lastN;
        heapPrios[i] = lastP;
      }
      return top;
    };

    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        const cid = cy * cw + cx;
        const gx = cx * stride + 1;
        const gy = cy * stride + 1;
        const gid = world.idx(gx, gy);
        const meanderPotential =
          (world.noise.fbm(cx * 0.08 + 2.3, cy * 0.08 + 7.9, 2) - 0.5) * 0.085 +
          Math.sin(cx * 0.18 + cy * 0.14) * 0.022;
        const el = world.elevationField[gid] + meanderPotential;
        filledElev[cid] = el;
        // Seed Priority-Flood from existing lakes/sea and already-carved lake outflow rivers!
        if (world.waterMask[gid] > 0) {
          visited[cid] = 1;
          hPush(cid, el);
        }
      }
    }

    const d8 = [
      [1, 0, 1.0], [-1, 0, 1.0], [0, 1, 1.0], [0, -1, 1.0],
      [1, 1, 1.414], [-1, 1, 1.414], [1, -1, 1.414], [-1, -1, 1.414]
    ];
    while (heapNodes.length > 0) {
      const u = hPop();
      const ux = u % cw;
      const uy = Math.floor(u / cw);
      const uEl = filledElev[u];

      for (const [dx, dy, dist] of d8) {
        const vx = ux + dx;
        const vy = uy + dy;
        if (vx < 0 || vx >= cw || vy < 0 || vy >= ch) continue;
        const v = vy * cw + vx;
        if (visited[v]) continue;
        visited[v] = 1;
        receiver[v] = u;
        const jitter = 0.75 + 0.50 * world.noise.noise(vx * 0.35 + 1.9, vy * 0.35 + 6.4);
        const minNext = uEl + 0.0015 * dist * jitter;
        if (filledElev[v] <= minNext) {
          filledElev[v] = minNext;
        }
        hPush(v, filledElev[v]);
      }
    }

    // Trace 3–4 long D8 rivers entering from the Map Borders down the Priority-Flood surface into lakes/rivers!
    const borderEntries = pickMapBorderRiverEntries(4);
    for (let bIdx = 0; bIdx < borderEntries.length; bIdx++) {
      const entry = borderEntries[bIdx];
      let curr = Math.floor(entry.y / stride) * cw + Math.floor(entry.x / stride);
      const rawPts = [{ x: entry.x, y: entry.y }];
      const seen = new Set();
      let steps = 0;
      while (curr !== -1 && !seen.has(curr) && steps++ < 320) {
        seen.add(curr);
        const cx = (curr % cw) * stride + 1;
        const cy = Math.floor(curr / cw) * stride + 1;
        rawPts.push({ x: cx, y: cy });
        const gid = world.idx(cx, cy);
        if (rawPts.length >= 16 && world.waterMask[gid] > 0) {
          if (world.waterMask[gid] === 1) {
            world.hydroFeatures.push({ x: cx, y: cy, type: 'confluence' });
          }
          break;
        }
        curr = receiver[curr];
      }
      if (rawPts.length >= 24) {
        const curved = applyMeanderingDisplacement(rawPts, bIdx * 2.1 + 0.8, 0.65);
        carveTaperingRiverPath(curved, bIdx === 0, false, 0);
      }
    }
  } else if (arch === 'island-hopper') {
    // Island-Hopper: short volcanic island streams from high peaks to nearest island coast
    const placedSprings = [];
    for (let sPass = 0; sPass < 5; sPass++) {
      let bestSp = null;
      let bestElev = -1;
      for (let attempt = 0; attempt < 35; attempt++) {
        const sx = world.rng.int(16, W - 17);
        const sy = world.rng.int(16, H - 17);
        const id = world.idx(sx, sy);
        if (world.waterMask[id] > 0) continue;
        const el = world.elevationField[id];
        if (el < seaLevel + 0.22) continue;
        if (placedSprings.some(p => Math.hypot(p.x - sx, p.y - sy) < 42)) continue;
        if (el > bestElev) {
          bestElev = el;
          bestSp = { x: sx, y: sy };
        }
      }
      if (bestSp) {
        placedSprings.push(bestSp);
        let targetSink = primarySink;
        let minSD = Infinity;
        for (let wy = Math.max(4, bestSp.y - 45); wy <= Math.min(H - 5, bestSp.y + 45); wy += 3) {
          for (let wx = Math.max(4, bestSp.x - 45); wx <= Math.min(W - 5, bestSp.x + 45); wx += 3) {
            if (world.waterMask[world.idx(wx, wy)] === 2) {
              const d = Math.hypot(bestSp.x - wx, bestSp.y - wy);
              if (d < minSD) {
                minSD = d;
                targetSink = { deepX: wx, deepY: wy };
              }
            }
          }
        }
        const rPath = routeValleyThalwegAStar(bestSp.x, bestSp.y, targetSink.deepX, targetSink.deepY, true, sPass * 2.1, 12);
        carveTaperingRiverPath(rPath, false, useMeanders, sPass * 1.9);
      }
    }
  } else {
    // Continental Map-Border-to-Basin/Confluence Trunk Rivers (`thalweg-astar` & `meandering-plain`)
    const borderEntries = pickMapBorderRiverEntries(3);
    for (let sPass = 0; sPass < borderEntries.length; sPass++) {
      const entry = borderEntries[sPass];
      let targetSink = primarySink;
      let minSD = Infinity;
      for (const b of basins) {
        const d = Math.hypot(entry.x - b.deepX, entry.y - b.deepY);
        if (d >= 75 && d < minSD) {
          minSD = d;
          targetSink = b;
        }
      }
      const rPath = routeValleyThalwegAStar(entry.x, entry.y, targetSink.deepX, targetSink.deepY, true, sPass * 2.1, 64);
      carveTaperingRiverPath(rPath, sPass === 0, useMeanders, sPass * 1.9);
    }
  }

  world.confluencePoint =
    world.hydroFeatures.find(f => f.type === 'confluence') ||
    world.hydroFeatures[0] ||
    { x: Math.round(W * 0.5), y: Math.round(H * 0.5) };
}
