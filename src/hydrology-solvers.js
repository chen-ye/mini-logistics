/**
 * STAGE 2B: PLUGGABLE FLUVIAL HYDROLOGY & RIVER EROSION ENGINES
 * Supports 3 selectable in-game river & watershed algorithms:
 *   1. `thalweg-astar`    — Non-Bifurcating Basin Tree + Downhill A* Thalwegs
 *   2. `d8-strahler`      — Priority-Flood Pit-Filling + D8 Flow Accumulation & Dendritic Tributary Trees (`w ∝ √A`)
 *   3. `meandering-plain` — Curvature-Driven Alluvial Floodplain Meanders & Oxbow S-Bends
 */
export function synthesizeFluvialHydrology(world, basins, primarySink) {
  const { W, H, seaLevel } = world;
  const arch = world.config.archetype;
  const hydroAlgo = world.config.hydrologyAlgo || 'thalweg-astar';

  // Shared Downhill Valley-Thalweg A* Router
  const routeValleyThalwegAStar = (sx, sy, ex, ey, stopOnExistingRiver = true, seedPhase = 0) => {
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
    while (heapNodes.length > 0 && steps++ < 48000) {
      const cid = heapPop();
      if (closed[cid]) continue;
      closed[cid] = 1;

      const cx = cid % W;
      const cy = Math.floor(cid / W);
      const hasLeft = leftSource[cid] === 1;

      if (
        cid === endId ||
        (hasLeft && world.waterMask[cid] === 2) ||
        (stopOnExistingRiver && hasLeft && world.waterMask[cid] === 1)
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
        if (!world.inBounds(nx, ny, 4)) continue;
        const nid = world.idx(nx, ny);
        if (closed[nid]) continue;

        if (pid !== -1 && (dx * prevDx + dy * prevDy) < 0) continue;

        const nextElev = world.elevationField[nid];
        const uphill = Math.max(0, nextElev - currElev);
        const downhill = Math.max(0, currElev - nextElev);

        const sameDir = pid !== -1 && dx === prevDx && dy === prevDy;
        const nextRun = sameDir ? Math.min(255, runLen[cid] + 1) : 1;
        const straightPenalty = nextRun > 3 ? (nextRun - 3) * 1.15 : 0;

        const meanderWave =
          world.noise.fbm(nx * 0.048 + seedPhase, ny * 0.048 + seedPhase * 1.3, 2) * 3.6 +
          Math.sin(nx * 0.14 + ny * 0.11 + seedPhase) * 0.95;

        const stepCost =
          baseStep * (0.72 + Math.max(0, nextElev - seaLevel) * 2.4) +
          uphill * 95.0 -
          downhill * 4.2 +
          meanderWave +
          straightPenalty;

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

  const applyMeanderingDisplacement = (rawPath, phaseOffset = 0) => {
    if (!rawPath || rawPath.length < 10) return rawPath;
    const out = [rawPath[0]];
    const n = rawPath.length;
    for (let i = 1; i < n - 1; i++) {
      const pPrev = rawPath[Math.max(0, i - 3)];
      const pNext = rawPath[Math.min(n - 1, i + 3)];
      const tx = pNext.x - pPrev.x;
      const ty = pNext.y - pPrev.y;
      const tLen = Math.hypot(tx, ty) || 1;
      const nx = -ty / tLen;
      const ny = tx / tLen;

      const pt = rawPath[i];
      const id = world.idx(Math.round(pt.x), Math.round(pt.y));
      const elevAbove = Math.max(0, world.elevationField[id] - seaLevel);
      // Floodplain meandering is strongest on low alluvial plains (`elevAbove < 0.18`) and tapers at endpoints
      const endFade = Math.sin((i / (n - 1)) * Math.PI);
      const plainFactor = Math.max(0.15, 1.0 - elevAbove * 3.2);
      const amp = endFade * plainFactor * 4.8;
      // Compound Ikeda harmonic (`sin(ωs) + 0.35 * sin(2ωs - φ)`) produces asymmetric gooseneck bends!
      const s = i * 0.34 + phaseOffset;
      const offset = amp * (Math.sin(s) + 0.32 * Math.sin(2 * s - 0.8));

      const mx = Math.round(pt.x + nx * offset);
      const my = Math.round(pt.y + ny * offset);
      if (
        world.inBounds(mx, my, 5) &&
        world.elevationField[world.idx(mx, my)] <= world.elevationField[id] + 0.08
      ) {
        const prev = out[out.length - 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(mx - prev.x, my - prev.y)));
        for (let k = 1; k <= steps; k++) {
          const ix = Math.round(prev.x + ((mx - prev.x) * k) / steps);
          const iy = Math.round(prev.y + ((my - prev.y) * k) / steps);
          if (ix !== out[out.length - 1].x || iy !== out[out.length - 1].y) {
            out.push({ x: ix, y: iy });
          }
        }
      } else {
        out.push(pt);
      }
    }
    out.push(rawPath[n - 1]);
    return out;
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
    if (path.length < 5) return;
    if (applyMeanders) {
      path = applyMeanderingDisplacement(path, seedPhase);
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
      const endPt = path[path.length - 1];
      if (progress > 0.88 && world.waterMask[world.idx(endPt.x, endPt.y)] === 2) {
        const flareRad = 0.85 + ((progress - 0.88) / 0.12) * 1.15;
        world.carveValleyChannel(x, y, flareRad, 2);
      } else {
        const rad = width ? Math.min(0.85, width * 0.35) : 0.45;
        world.carveValleyChannel(x, y, rad, 0);
      }
    }
  };

  // =========================================================================
  // ENGINE 2: PRIORITY-FLOOD + D8 STRAHLER DENDRITIC TRIBUTARY TREE (`d8-strahler`)
  // =========================================================================
  if (hydroAlgo === 'd8-strahler') {
    const stride = 2;
    const cw = Math.floor(W / stride);
    const ch = Math.floor(H / stride);
    const N = cw * ch;

    const filledElev = new Float32Array(N);
    const visited = new Uint8Array(N);
    const receiver = new Int32Array(N).fill(-1);
    const topoOrder = [];

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

    // 1. Identify the global lowest sink basin (`basins[0]`, the sea or primary lake)
    //    Only `basins[0]` is seeded as a terminal sink in Priority-Flood so all higher interior lakes
    //    automatically fill to their natural topographic spill saddle and drain via D8 mainstem rivers!
    const isPrimarySinkTile = new Uint8Array(W * H);
    if (basins.length > 0) {
      const b0 = basins[0];
      const q = [world.idx(b0.deepX, b0.deepY)];
      isPrimarySinkTile[q[0]] = 1;
      for (let h = 0; h < q.length; h++) {
        const cid = q[h];
        const cx = cid % W, cy = Math.floor(cid / W);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (world.inBounds(nx, ny)) {
            const nid = world.idx(nx, ny);
            if (world.waterMask[nid] === 2 && !isPrimarySinkTile[nid]) {
              isPrimarySinkTile[nid] = 1;
              q.push(nid);
            }
          }
        }
      }
    }

    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        const cid = cy * cw + cx;
        const gx = cx * stride + 1;
        const gy = cy * stride + 1;
        const gid = world.idx(gx, gy);
        const meanderPotential =
          (world.noise.fbm(cx * 0.10 + 2.3, cy * 0.10 + 7.9, 2) - 0.5) * 0.075 +
          Math.sin(cx * 0.24 + cy * 0.17) * 0.018;
        const el = world.elevationField[gid] + meanderPotential;
        filledElev[cid] = el;
        if (
          isPrimarySinkTile[gid] ||
          (arch === 'island-hopper' && world.waterMask[gid] === 2) ||
          cx <= 1 || cx >= cw - 2 || cy <= 1 || cy >= ch - 2
        ) {
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
      topoOrder.push(u);
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
        const minNext = uEl + 0.0014 * dist * jitter;
        if (filledElev[v] <= minNext) {
          filledElev[v] = minNext;
        }
        hPush(v, filledElev[v]);
      }
    }

    // 1B. Refine `receiver[u]` to steepest downhill neighbor where terrain has natural slope
    for (let u = 0; u < N; u++) {
      const ux = u % cw;
      const uy = Math.floor(u / cw);
      const gx = ux * stride + 1;
      const gy = uy * stride + 1;
      if (isPrimarySinkTile[world.idx(gx, gy)]) continue;
      const uEl = filledElev[u];
      let bestSlope = 0;
      let bestRec = receiver[u];
      for (const [dx, dy, dist] of d8) {
        const vx = ux + dx;
        const vy = uy + dy;
        if (vx < 0 || vx >= cw || vy < 0 || vy >= ch) continue;
        const v = vy * cw + vx;
        const drop = uEl - filledElev[v];
        if (drop > 0.002) {
          const slope = (drop / dist) * (0.85 + 0.30 * world.noise.noise(vx * 0.22 + uy * 0.13, vy * 0.22 + ux * 0.17));
          if (slope > bestSlope) {
            bestSlope = slope;
            bestRec = v;
          }
        }
      }
      receiver[u] = bestRec;
    }

    // 2. Accumulate D8 Upstream Drainage Area `flowArea` in reverse topological order (peaks -> sea)
    const flowArea = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const gx = (i % cw) * stride + 1;
      const gy = Math.floor(i / cw) * stride + 1;
      const gid = world.idx(gx, gy);
      if (world.waterMask[gid] === 0) {
        const hAbove = Math.max(0, world.elevationField[gid] - seaLevel);
        flowArea[i] = 1.0 + hAbove * 3.5;
      } else if (!isPrimarySinkTile[gid] && world.waterMask[gid] === 2) {
        // Interior high-elevation lakes contribute strong outflow discharge at their spill saddle!
        flowArea[i] = 2.2;
      }
    }

    const sortedByElev = Array.from({ length: N }, (_, idx) => idx).sort((a, b) => filledElev[b] - filledElev[a]);
    for (const u of sortedByElev) {
      const rec = receiver[u];
      if (rec !== -1) {
        flowArea[rec] += flowArea[u];
      }
    }

    // 3. Seed Dendritic River Trunks from:
    //    (a) Spill outlets of interior lakes (`basins[1..k]`), and
    //    (b) Well-separated upland watershed channel heads (`flowArea >= flowThresh`)
    const flowThresh = arch === 'island-hopper' ? 32.0 : 62.0;
    const heads = [];
    for (let u = 0; u < N; u++) {
      const gx = (u % cw) * stride + 1;
      const gy = Math.floor(u / cw) * stride + 1;
      if (flowArea[u] >= flowThresh && world.waterMask[world.idx(gx, gy)] === 0) {
        heads.push(u);
      }
    }
    // Prioritize highest-elevation channel heads of major drainage basins
    heads.sort((a, b) => (filledElev[b] + Math.sqrt(flowArea[b]) * 0.015) - (filledElev[a] + Math.sqrt(flowArea[a]) * 0.015));

    const carvedCell = new Uint8Array(N);
    const carvedX = new Float32Array(N);
    const carvedY = new Float32Array(N);
    const placedHeads = [];
    const maxBranches = arch === 'island-hopper' ? 9 : 11;
    let branchCount = 0;

    for (const head of heads) {
      if (branchCount >= maxBranches) break;
      if (carvedCell[head]) continue;
      const hx = (head % cw) * stride + 1;
      const hy = Math.floor(head / cw) * stride + 1;
      if (placedHeads.some(ph => Math.hypot(ph.x - hx, ph.y - hy) < (arch === 'island-hopper' ? 20 : 34))) {
        continue;
      }

      const rawCells = [];
      let curr = head;
      let steps = 0;
      let hitConfluence = false;
      let confluenceTarget = null;
      const visitedInTrace = new Set();

      while (curr !== -1 && !visitedInTrace.has(curr) && steps++ < 260) {
        visitedInTrace.add(curr);
        const cx = (curr % cw) * stride + 1;
        const cy = Math.floor(curr / cw) * stride + 1;
        const gid = world.idx(cx, cy);

        // Trim any initial cells that are still inside an upstream interior lake
        if (world.waterMask[gid] === 2 && rawCells.length < 3 && !isPrimarySinkTile[gid]) {
          curr = receiver[curr];
          continue;
        }

        const w = Math.min(2.15, 0.38 + Math.sqrt(flowArea[curr]) * 0.048);
        rawCells.push({ x: cx, y: cy, width: w, cellId: curr });

        if (world.waterMask[gid] === 2 && rawCells.length >= 4) break;
        if (carvedCell[curr] && rawCells.length >= 5) {
          hitConfluence = true;
          confluenceTarget = { x: carvedX[curr], y: carvedY[curr] };
          world.hydroFeatures.push({ x: Math.round(carvedX[curr]), y: Math.round(carvedY[curr]), type: 'confluence' });
          break;
        }
        curr = receiver[curr];
      }

      if (rawCells.length < (hitConfluence ? 6 : 10)) continue;
      placedHeads.push({ x: hx, y: hy });

      // Lock the final vertex to the exact smoothed confluence point on the parent river!
      if (hitConfluence && confluenceTarget) {
        rawCells[rawCells.length - 1].x = confluenceTarget.x;
        rawCells[rawCells.length - 1].y = confluenceTarget.y;
      }

      // First smooth the D8 grid staircase with 5 passes of endpoint-pinned Laplacian smoothing
      let smoothPts = rawCells.map(p => ({ x: p.x, y: p.y, width: p.width, cellId: p.cellId }));
      for (let pass = 0; pass < 5; pass++) {
        const nextPts = [smoothPts[0]];
        for (let i = 1; i < smoothPts.length - 1; i++) {
          nextPts.push({
            x: 0.25 * smoothPts[i - 1].x + 0.50 * smoothPts[i].x + 0.25 * smoothPts[i + 1].x,
            y: 0.25 * smoothPts[i - 1].y + 0.50 * smoothPts[i].y + 0.25 * smoothPts[i + 1].y,
            width: smoothPts[i].width,
            cellId: smoothPts[i].cellId
          });
        }
        nextPts.push(smoothPts[smoothPts.length - 1]);
        smoothPts = nextPts;
      }

      // Second, apply a gentle perpendicular meander wave (after Laplacian smoothing so it isn't damped out!)
      const n = smoothPts.length;
      const meanderedPts = smoothPts.map((p, i) => {
        if (i === 0 || i === n - 1) return p;
        const pPrev = smoothPts[Math.max(0, i - 2)];
        const pNext = smoothPts[Math.min(n - 1, i + 2)];
        const tx = pNext.x - pPrev.x;
        const ty = pNext.y - pPrev.y;
        const tLen = Math.hypot(tx, ty) || 1;
        const nx = -ty / tLen;
        const ny = tx / tLen;
        const env = Math.sin((i / (n - 1)) * Math.PI);
        const s = i * 0.36 + branchCount * 2.1;
        const offset = env * 2.4 * (Math.sin(s) + 0.30 * Math.cos(1.8 * s));
        return {
          x: Math.max(5, Math.min(W - 6, p.x + nx * offset)),
          y: Math.max(5, Math.min(H - 6, p.y + ny * offset)),
          width: p.width,
          cellId: p.cellId
        };
      });

      // Record exact post-meander coordinates per cell so child tributaries join with 0px gap!
      for (const mp of meanderedPts) {
        carvedCell[mp.cellId] = 1;
        carvedX[mp.cellId] = mp.x;
        carvedY[mp.cellId] = mp.y;
      }

      const finalPts = [{
        x: Math.round(meanderedPts[0].x),
        y: Math.round(meanderedPts[0].y),
        width: meanderedPts[0].width
      }];
      for (let i = 1; i < meanderedPts.length; i++) {
        const gx = Math.round(meanderedPts[i].x);
        const gy = Math.round(meanderedPts[i].y);
        const w = meanderedPts[i].width;
        const last = finalPts[finalPts.length - 1];
        const segSteps = Math.max(1, Math.ceil(Math.hypot(gx - last.x, gy - last.y)));
        for (let k = 1; k <= segSteps; k++) {
          const ix = Math.round(last.x + ((gx - last.x) * k) / segSteps);
          const iy = Math.round(last.y + ((gy - last.y) * k) / segSteps);
          const iw = last.width + ((w - last.width) * k) / segSteps;
          if (world.inBounds(ix, iy, 3) && (ix !== finalPts[finalPts.length - 1].x || iy !== finalPts[finalPts.length - 1].y)) {
            finalPts.push({ x: ix, y: iy, width: iw });
          }
        }
      }

      if (finalPts.length >= 6) {
        carveTaperingRiverPath(finalPts, branchCount < 3 && !hitConfluence, false, 0);
        branchCount++;
      }
    }
  } else {
    // =========================================================================
    // ENGINE 1 (`thalweg-astar`) & ENGINE 3 (`meandering-plain`)
    // =========================================================================
    const useMeanders = hydroAlgo === 'meandering-plain';

    // 1. Non-Bifurcating Lake Drainage: Each interior lake drains via at most ONE outflow river
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
        const outPath = routeValleyThalwegAStar(srcB.deepX, srcB.deepY, bestSink.deepX, bestSink.deepY, true, bIdx * 1.7);
        carveTaperingRiverPath(outPath, true, useMeanders, bIdx * 2.3);
      }
    }

    // 2. Seed 9 Upland Springs on Highland Ridges and Route Downhill
    const placedSprings = [];
    for (let sPass = 0; sPass < 9; sPass++) {
      let bestSp = null;
      let bestElev = -1;
      for (let attempt = 0; attempt < 35; attempt++) {
        const sx = world.rng.int(16, W - 17);
        const sy = world.rng.int(16, H - 17);
        const id = world.idx(sx, sy);
        if (world.waterMask[id] > 0) continue;
        const el = world.elevationField[id];
        if (el < seaLevel + 0.18) continue;
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
        if (arch === 'island-hopper') {
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
        } else {
          for (const b of basins) {
            const d = Math.hypot(bestSp.x - b.deepX, bestSp.y - b.deepY);
            if (d < minSD) {
              minSD = d;
              targetSink = b;
            }
          }
        }
        const rPath = routeValleyThalwegAStar(bestSp.x, bestSp.y, targetSink.deepX, targetSink.deepY, true, sPass * 2.1);
        carveTaperingRiverPath(rPath, sPass < 2 && arch !== 'island-hopper', useMeanders, sPass * 1.9);
      }
    }
  }

  world.confluencePoint =
    world.hydroFeatures.find(f => f.type === 'confluence') ||
    world.hydroFeatures[0] ||
    { x: Math.round(W * 0.5), y: Math.round(H * 0.5) };
}
