/**
 * STAGE 2A: PLUGGABLE TERRAIN HEIGHTMAP & BASIN SYNTHESIS ENGINES
 * Supports 3 selectable in-game terrain generation algorithms:
 *   1. `tectonic-fbm`   — Anisotropic Strike fBm + Ridged Multifractal Spines
 *   2. `quilez-erosion` — Inigo Quilez Analytic Derivative Gradient-Eroded fBm (`1 / (1 + k|∇H|²)`)
 *   3. `voronoi-plates` — Polygonal Voronoi Micro-Plates with Convergent Orogeny & Divergent Rift Valleys
 */
export function synthesizeTerrainAndBasins(world) {
  const { W, H } = world;
  const waterRatio = world.config.waterCoverage / 100;
  const arch = world.config.archetype;
  const terrainAlgo = world.config.terrainAlgo || 'tectonic-fbm';

  world.hydroFeatures = [];
  world.rivers = [];
  world.drainageField.fill(0);

  // Seed-unique geological strike axis & primary coastal drainage direction
  const strikeAng = world.rng.range(-0.85, 0.85);
  const cosS = Math.cos(strikeAng);
  const sinS = Math.sin(strikeAng);
  const coastAng = world.rng.pick([0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) + world.rng.range(-0.38, 0.38);
  const cosC = Math.cos(coastAng);
  const sinC = Math.sin(coastAng);
  const offX = world.rng.range(10, 90);
  const offY = world.rng.range(10, 90);
  const foldPhase = world.rng.range(0, Math.PI * 2);

  // Emergent Tectonic Archipelago Spine, Multi-Lobe Massifs & Satellite Skerries for `island-hopper`
  const islandMassifs = [];
  const islandBites = [];
  if (arch === 'island-hopper') {
    const baseTheta = world.rng.range(-Math.PI, Math.PI);
    const arcCurvature = (world.rng.next() < 0.5 ? 1 : -1) * world.rng.range(0.28, 0.52);

    const sampleArcPoint = (t) => {
      const s = t * 0.82;
      const n = (arcCurvature * (t * t - 0.09)) + Math.sin(t * Math.PI * 2.0 + foldPhase) * 0.05;
      return {
        x: Math.max(-0.39, Math.min(0.39, s * Math.cos(baseTheta) - n * Math.sin(baseTheta))),
        y: Math.max(-0.37, Math.min(0.37, s * Math.sin(baseTheta) + n * Math.cos(baseTheta))),
        tangent: baseTheta + 2 * arcCurvature * t
      };
    };

    const majorCenters = [];
    const arcTs = [
      -0.38 + world.rng.range(-0.03, 0.03),
      -0.13 + world.rng.range(-0.04, 0.04),
      0.13 + world.rng.range(-0.04, 0.04),
      0.38 + world.rng.range(-0.03, 0.03)
    ];
    for (let idx = 0; idx < arcTs.length; idx++) {
      const pt = sampleArcPoint(arcTs[idx]);
      const isMain = idx === 1 || idx === 2;
      majorCenters.push({
        x: Math.max(-0.35, Math.min(0.35, pt.x + world.rng.range(-0.03, 0.03))),
        y: Math.max(-0.33, Math.min(0.33, pt.y + world.rng.range(-0.03, 0.03))),
        ang: pt.tangent + world.rng.range(-0.55, 0.55),
        scale: isMain ? world.rng.range(0.96, 1.12) : world.rng.range(0.74, 0.88),
        height: isMain ? world.rng.range(0.92, 1.00) : world.rng.range(0.80, 0.90)
      });
    }

    for (const sideMul of [1, -1]) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const rDist = world.rng.range(0.24, 0.36);
        const ang = baseTheta + sideMul * Math.PI * 0.5 + world.rng.range(-0.55, 0.55) + (attempt > 15 ? world.rng.range(-1.0, 1.0) : 0);
        const fx = Math.max(-0.35, Math.min(0.35, Math.cos(ang) * rDist));
        const fy = Math.max(-0.33, Math.min(0.33, Math.sin(ang) * rDist));
        const minSep = attempt < 18 ? 0.24 : 0.19;
        if (majorCenters.every(mc => Math.hypot(mc.x - fx, mc.y - fy) >= minSep)) {
          majorCenters.push({
            x: fx,
            y: fy,
            ang: ang + world.rng.range(-0.7, 0.7),
            scale: world.rng.range(0.80, 0.98),
            height: world.rng.range(0.82, 0.94)
          });
          break;
        }
      }
    }

    for (let mIdx = 0; mIdx < majorCenters.length; mIdx++) {
      const mc = majorCenters[mIdx];
      const lobeCount = mc.scale > 0.92 ? 3 : 2;
      for (let l = 0; l < lobeCount; l++) {
        const lobeAng = mc.ang + (l === 0 ? 0 : (l === 1 ? world.rng.range(0.65, 1.40) : world.rng.range(-1.40, -0.65)));
        const lobeOff = l === 0 ? 0 : mc.scale * world.rng.range(0.026, 0.046);
        const lx = mc.x + Math.cos(lobeAng) * lobeOff;
        const ly = mc.y + Math.sin(lobeAng) * lobeOff;
        const rx = (l === 0 ? 0.092 : 0.062) * mc.scale * world.rng.range(0.90, 1.16);
        const ry = (l === 0 ? 0.050 : 0.038) * mc.scale * world.rng.range(0.86, 1.14);
        islandMassifs.push({
          group: mIdx,
          x: lx,
          y: ly,
          rx,
          ry,
          ang: lobeAng,
          height: mc.height * (l === 0 ? 1.0 : world.rng.range(0.82, 0.95)),
          isIslet: false
        });
      }

      const biteAng = mc.ang + Math.PI * 0.5 * (world.rng.next() < 0.5 ? 1 : -1) + world.rng.range(-0.4, 0.4);
      const biteDist = mc.scale * world.rng.range(0.036, 0.056);
      islandBites.push({
        x: mc.x + Math.cos(biteAng) * biteDist,
        y: mc.y + Math.sin(biteAng) * biteDist,
        r: mc.scale * world.rng.range(0.030, 0.046),
        depth: world.rng.range(0.22, 0.34)
      });
    }

    for (let s = 0; s < 14; s++) {
      const host = world.rng.pick(majorCenters);
      const tailAng = host.ang + (world.rng.next() < 0.5 ? 0 : Math.PI) + world.rng.range(-0.75, 0.75);
      const tailDist = host.scale * world.rng.range(0.088, 0.145);
      const ix = Math.max(-0.41, Math.min(0.41, host.x + Math.cos(tailAng) * tailDist));
      const iy = Math.max(-0.39, Math.min(0.39, host.y + Math.sin(tailAng) * tailDist));
      if (majorCenters.some(mc => Math.hypot(mc.x - ix, mc.y - iy) < 0.072)) continue;
      islandMassifs.push({
        group: 100 + s,
        x: ix,
        y: iy,
        rx: world.rng.range(0.020, 0.036),
        ry: world.rng.range(0.013, 0.024),
        ang: tailAng + world.rng.range(-0.5, 0.5),
        height: world.rng.range(0.62, 0.78),
        isIslet: true
      });
    }
  }

  // Precompute Voronoi Micro-Plates when `terrainAlgo === 'voronoi-plates'`
  const voronoiPlates = [];
  if (terrainAlgo === 'voronoi-plates') {
    for (let p = 0; p < 15; p++) {
      for (let attempt = 0; attempt < 25; attempt++) {
        const px = world.rng.range(-0.46, 0.46);
        const py = world.rng.range(-0.46, 0.46);
        if (voronoiPlates.every(vp => Math.hypot(vp.x - px, vp.y - py) >= 0.17 || attempt > 18)) {
          const velAng = world.rng.range(0, Math.PI * 2);
          voronoiPlates.push({
            x: px,
            y: py,
            vx: Math.cos(velAng),
            vy: Math.sin(velAng),
            baseElev: world.rng.range(0.24, 0.68)
          });
          break;
        }
      }
    }
  }

  // Synthesize Heightmap (`world.elevationField`)
  const sampleElevs = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = (x / W) - 0.5;
      const ny = (y / H) - 0.5;

      const warpU = world.noise.fbm((nx + 0.5) * 1.9 + offX, (ny + 0.5) * 1.9 + offY, 2) * 0.18 - 0.09;
      const warpV = world.noise.fbm((nx + 0.5) * 1.9 + offY, (ny + 0.5) * 1.9 + offX, 2) * 0.18 - 0.09;
      const wx = nx + warpU;
      const wy = ny + warpV;

      const uStrike = wx * cosS + wy * sinS;
      const vStrike = -wx * sinS + wy * cosS;

      const macroPlate = world.noise.fbm(uStrike * 2.1 + offX * 0.3, vStrike * 2.8 + offY * 0.3, 3);
      const foldValleys = Math.cos(vStrike * Math.PI * 3.4 + foldPhase + macroPlate * 2.1) * 0.14;
      const ridgeRaw = world.noise.noise(uStrike * 3.8 + 13.7, vStrike * 4.4 + 9.2);
      const ridgedSpines = Math.pow(Math.max(0, 1.0 - Math.abs(2.0 * ridgeRaw - 1.0)), 1.6) * 0.24;
      const fineDetail = world.noise.fbm((x / 32) + offX, (y / 32) + offY, 2) * 0.10;

      const cProj = nx * cosC + ny * sinC;
      const coastDepth = Math.max(0, (cProj - 0.14) / 0.42);
      const bayIndent = Math.exp(-Math.pow(vStrike / 0.18, 2)) * Math.pow(coastDepth, 1.25) * 0.48;

      const lakeWell1 = Math.exp(-Math.pow((uStrike + 0.18) / 0.16, 2) - Math.pow((vStrike - 0.08) / 0.11, 2)) * 0.28;
      const lakeWell2 = Math.exp(-Math.pow((uStrike - 0.22) / 0.15, 2) - Math.pow((vStrike + 0.14) / 0.10, 2)) * 0.26;

      let baseRelief;
      if (terrainAlgo === 'quilez-erosion') {
        // Engine 2: Inigo Quilez Analytic Derivative Gradient-Eroded fBm (`1 / (1 + k * |∇H|²)`)
        // Suppresses high-frequency crags on steep slopes -> wide flat alluvial plains & sharp eroded ridges!
        const erodedMain = world.noise.fbmEroded(uStrike * 2.6 + offX * 0.25, vStrike * 3.1 + offY * 0.25, 5, 2.15);
        const dRidge = world.noise.noiseDeriv(uStrike * 4.2 + 7.1, vStrike * 4.6 + 3.8);
        const gradMag2 = dRidge.dx * dRidge.dx + dRidge.dy * dRidge.dy;
        const sharpCrest = Math.pow(Math.max(0, 1.0 - Math.abs(2.0 * dRidge.val - 1.0)), 2.2) / (1.0 + 1.8 * gradMag2);
        // Nonlinear terrace flattening on low elevations + sharp dendritic mountain crests
        const valleyFlat = Math.pow(erodedMain, 1.38) * 0.68;
        baseRelief = valleyFlat + sharpCrest * 0.34 + foldValleys * 0.42;
      } else if (terrainAlgo === 'voronoi-plates') {
        // Engine 3: Polygonal Voronoi Tectonic Micro-Plates (Convergent Orogeny + Divergent Rift Basins)
        let d1 = Infinity, d2 = Infinity;
        let p1 = voronoiPlates[0], p2 = voronoiPlates[0];
        for (const vp of voronoiPlates) {
          const dist = Math.hypot(wx - vp.x, wy - vp.y);
          if (dist < d1) {
            d2 = d1; p2 = p1;
            d1 = dist; p1 = vp;
          } else if (dist < d2) {
            d2 = dist; p2 = vp;
          }
        }
        const boundaryDist = d2 - d1;
        // Relative convergence/divergence along the plate-pair normal
        const nxP = (p2.x - p1.x) / (Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1);
        const nyP = (p2.y - p1.y) / (Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1);
        const convergence = (p1.vx - p2.vx) * nxP + (p1.vy - p2.vy) * nyP;

        const blendT = Math.min(1, Math.max(0, 0.5 + boundaryDist / 0.14));
        const cratonElev = p1.baseElev * blendT + p2.baseElev * (1 - blendT);
        const boundaryPulse = Math.exp(-Math.pow(boundaryDist / 0.052, 2));
        // Convergent fault -> folded mountain belt; Divergent fault -> deep rift lake/valley trough!
        const faultRelief = convergence >= 0
          ? boundaryPulse * (0.28 + ridgedSpines * 0.85)
          : -boundaryPulse * 0.26;
        const cratonNoise = world.noise.fbmEroded(uStrike * 2.4 + offX * 0.2, vStrike * 2.4 + offY * 0.2, 4, 1.4) * 0.28;
        baseRelief = cratonElev * 0.62 + faultRelief + cratonNoise;
      } else {
        // Engine 1: Default Anisotropic Strike fBm + Ridged Spines
        baseRelief = macroPlate * 0.52 + foldValleys * 0.75 + ridgedSpines + fineDetail;
      }

      let elev = baseRelief;

      if (arch === 'island-hopper') {
        const coveU = (world.noise.fbm(nx * 5.6 + offX * 0.7, ny * 5.6 + offY * 0.7, 2) - 0.5) * 0.085;
        const coveV = (world.noise.fbm(nx * 5.6 + offY * 0.7, ny * 5.6 + offX * 0.7, 2) - 0.5) * 0.085;
        const ixW = nx + warpU * 0.52 + coveU;
        const iyW = ny + warpV * 0.52 + coveV;

        let bestVal = 0;
        let bestGroup = -1;
        let sameGroupSecond = 0;
        let diffGroupSecond = 0;
        for (const m of islandMassifs) {
          const dxI = ixW - m.x;
          const dyI = iyW - m.y;
          const cI = Math.cos(m.ang), sI = Math.sin(m.ang);
          const uI = (dxI * cI + dyI * sI) / m.rx;
          const vI = (-dxI * sI + dyI * cI) / m.ry;
          const d2 = uI * uI + vI * vI;
          if (d2 > 9.5) continue;
          const val = Math.exp(-d2 * (m.isIslet ? 2.4 : 1.95)) * m.height;
          if (val > bestVal) {
            if (bestGroup === m.group) {
              sameGroupSecond = Math.max(sameGroupSecond, bestVal);
            } else if (bestGroup !== -1) {
              diffGroupSecond = Math.max(diffGroupSecond, bestVal);
            }
            bestVal = val;
            bestGroup = m.group;
          } else if (m.group === bestGroup) {
            if (val > sameGroupSecond) sameGroupSecond = val;
          } else {
            if (val > diffGroupSecond) diffGroupSecond = val;
          }
        }

        let massifShelf = bestVal + sameGroupSecond * 0.22 - diffGroupSecond * 0.90;
        for (const bite of islandBites) {
          const db2 = (Math.pow(ixW - bite.x, 2) + Math.pow(iyW - bite.y, 2)) / (bite.r * bite.r);
          if (db2 < 4.0) {
            massifShelf -= Math.exp(-db2 * 1.65) * bite.depth;
          }
        }
        massifShelf = Math.max(0, massifShelf);

        const shelfEnvelope = Math.min(1.0, Math.pow(massifShelf * 2.5, 1.10));
        const coastalFractal = (baseRelief - 0.48) * 0.65;
        const interiorSpine = ridgedSpines * Math.min(1.1, massifShelf * 1.40) * 1.15;
        elev = Math.max(0, massifShelf * 0.74 + coastalFractal * shelfEnvelope + interiorSpine);
      } else if (arch === 'estuary') {
        elev += -coastDepth * 0.22 - bayIndent * 1.15 - lakeWell1 * 0.95 - lakeWell2 * 0.85;
      } else if (arch === 'archipelago') {
        const straitWave = Math.cos(uStrike * Math.PI * 2.8 + offX) * Math.sin(vStrike * Math.PI * 2.4 + offY) * 0.22;
        elev += straitWave - bayIndent * 0.90 - lakeWell1 - lakeWell2;
      } else if (arch === 'inland') {
        const lakeWell3 = Math.exp(-Math.pow(uStrike / 0.18, 2) - Math.pow((vStrike - 0.22) / 0.11, 2)) * 0.28;
        elev += -lakeWell1 * 1.15 - lakeWell2 * 1.15 - lakeWell3 * 1.10;
      } else {
        elev += -coastDepth * 0.18 - bayIndent - lakeWell1 - lakeWell2;
      }

      const id = world.idx(x, y);
      world.elevationField[id] = elev;
      world.waterMask[id] = 0;
      if ((x & 1) === 0 && (y & 1) === 0) {
        sampleElevs.push(elev);
      }
    }
  }

  // Normalize `elevationField` to [0.02 .. 0.98] and quantile-calibrate `seaLevel`
  sampleElevs.sort((a, b) => a - b);
  const minE = sampleElevs[0];
  const maxE = sampleElevs[sampleElevs.length - 1] || (minE + 1);
  const spanE = Math.max(0.01, maxE - minE);
  for (let i = 0; i < W * H; i++) {
    world.elevationField[i] = 0.02 + ((world.elevationField[i] - minE) / spanE) * 0.96;
  }

  const baseFrac = arch === 'island-hopper'
    ? 0.71
    : (arch === 'archipelago' ? 0.22 : (arch === 'estuary' ? 0.19 : (arch === 'inland' ? 0.14 : 0.17)));
  const maxFrac = arch === 'island-hopper' ? 0.78 : 0.32;
  const targetWaterFrac = Math.max(0.10, Math.min(maxFrac, baseFrac * (0.68 + waterRatio * 0.65)));
  const qIdx = Math.floor(sampleElevs.length * targetWaterFrac);
  const rawSeaLevel = 0.02 + ((sampleElevs[qIdx] - minE) / spanE) * 0.96;
  const seaLevel = arch === 'island-hopper' ? Math.max(0.068, rawSeaLevel) : rawSeaLevel;
  world.seaLevel = seaLevel;

  for (let i = 0; i < W * H; i++) {
    if (world.elevationField[i] < seaLevel) {
      world.waterMask[i] = 2;
    }
  }

  // 2-pass Cellular Automata cleanup on `waterMask === 2`
  for (let pass = 0; pass < 2; pass++) {
    const nextMask = new Uint8Array(world.waterMask);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        let waterNeighbors = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (world.waterMask[world.idx(x + dx, y + dy)] > 0) waterNeighbors++;
          }
        }
        const curr = world.waterMask[world.idx(x, y)];
        if (curr > 0 && waterNeighbors <= 2) nextMask[world.idx(x, y)] = 0;
        else if (curr === 0 && waterNeighbors >= 6) nextMask[world.idx(x, y)] = 2;
      }
    }
    world.waterMask = nextMask;
  }

  // Identify Emergent Water Basins (`waterMask === 2` components) and Remove Tiny Puddles (< 85 tiles)
  const basins = [];
  const visitedW2 = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const startId = world.idx(x, y);
      if (world.waterMask[startId] !== 2 || visitedW2[startId]) continue;
      const comp = [startId];
      visitedW2[startId] = 1;
      let sumX = 0, sumY = 0, touchesBorder = false, minElev = Infinity, deepX = x, deepY = y;
      for (let h = 0; h < comp.length; h++) {
        const cid = comp[h];
        const cx = cid % W;
        const cy = Math.floor(cid / W);
        sumX += cx;
        sumY += cy;
        if (cx <= 2 || cx >= W - 3 || cy <= 2 || cy >= H - 3) touchesBorder = true;
        if (world.elevationField[cid] < minElev) {
          minElev = world.elevationField[cid];
          deepX = cx;
          deepY = cy;
        }
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (world.inBounds(nx, ny)) {
            const nid = world.idx(nx, ny);
            if (world.waterMask[nid] === 2 && !visitedW2[nid]) {
              visitedW2[nid] = 1;
              comp.push(nid);
            }
          }
        }
      }
      if (comp.length < 85) {
        for (const cid of comp) {
          world.waterMask[cid] = 0;
          world.elevationField[cid] = Math.max(world.elevationField[cid], seaLevel + 0.03);
        }
      } else {
        const bx = Math.round(sumX / comp.length);
        const by = Math.round(sumY / comp.length);
        basins.push({
          id: basins.length,
          size: comp.length,
          cx: bx,
          cy: by,
          deepX,
          deepY,
          minElev,
          touchesBorder
        });
        world.hydroFeatures.push({
          x: bx,
          y: by,
          type: touchesBorder ? 'bay' : 'lake'
        });
      }
    }
  }

  basins.sort((a, b) => (Number(b.touchesBorder) - Number(a.touchesBorder)) || (b.size - a.size));
  const primarySink = basins[0] || {
    deepX: Math.round((0.5 + cosC * 0.42) * W),
    deepY: Math.round((0.5 + sinC * 0.42) * H)
  };

  return { basins, primarySink };
}
