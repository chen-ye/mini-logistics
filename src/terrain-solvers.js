/** @import { WaterBasin, PrimarySink } from './types.js' */
/** @import { ProceduralLogisticsWorld } from './world-generator.js' */

import { ARCHETYPE_PARAMETER_PRESETS } from "./constants.js";

/**
 * STAGE 2A: PLUGGABLE TERRAIN HEIGHTMAP & BASIN SYNTHESIS ENGINES
 * Supports 3 selectable in-game terrain generation algorithms:
 *   1. `tectonic-fbm`   — Anisotropic Strike fBm + Ridged Multifractal Spines
 *   2. `quilez-erosion` — Inigo Quilez Analytic Derivative Gradient-Eroded fBm (`1 / (1 + k|∇H|²)`)
 *   3. `voronoi-plates` — Polygonal Voronoi Micro-Plates with Convergent Orogeny & Divergent Rift Valleys
 *
 * @param {ProceduralLogisticsWorld} world
 * @returns {{ basins: WaterBasin[], primarySink: PrimarySink }}
 */
export function synthesizeTerrainAndBasins(world) {
  const { W, H } = world;
  const arch = world.config.archetype || "confluence";
  const preset =
    ARCHETYPE_PARAMETER_PRESETS[arch] || ARCHETYPE_PARAMETER_PRESETS.confluence;

  const waterRatio =
    (world.config.waterCoverage !== undefined
      ? world.config.waterCoverage
      : preset.waterCoverage) / 100;
  const terrainAlgo = world.config.terrainAlgo || "tectonic-fbm";

  const reliefW =
    (world.config.terrainRelief !== undefined
      ? world.config.terrainRelief
      : preset.terrainRelief) / 100;
  const incisionW =
    (world.config.valleyIncision !== undefined
      ? world.config.valleyIncision
      : preset.valleyIncision) / 100;
  const embayW =
    (world.config.coastalEmbayment !== undefined
      ? world.config.coastalEmbayment
      : preset.coastalEmbayment) / 100;
  const calderaW =
    (world.config.calderaCurvature !== undefined
      ? world.config.calderaCurvature
      : preset.calderaCurvature) / 100;
  const barrierW =
    (world.config.barrierFragmentation !== undefined
      ? world.config.barrierFragmentation
      : preset.barrierFragmentation) / 100;
  const basinCnt = Math.max(
    1,
    Math.min(
      6,
      Math.round(
        world.config.basinCount !== undefined
          ? world.config.basinCount
          : preset.basinCount,
      ),
    ),
  );

  world.hydroFeatures = [];
  world.rivers = [];
  world.drainageField.fill(0);

  // Seed-unique geological strike axis & primary coastal drainage direction
  const strikeAng = world.rng.range(-0.85, 0.85);
  const cosS = Math.cos(strikeAng);
  const sinS = Math.sin(strikeAng);
  const coastAng =
    world.rng.pick([0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) +
    world.rng.range(-0.38, 0.38);
  const cosC = Math.cos(coastAng);
  const sinC = Math.sin(coastAng);
  const offX = world.rng.range(10, 90);
  const offY = world.rng.range(10, 90);
  const foldPhase = world.rng.range(0, Math.PI * 2);

  // Deterministic interior lake well depressions seeded from basinCnt
  const lakeWells = [];
  for (let b = 0; b < basinCnt; b++) {
    const uOffset =
      ((b + 0.5) / basinCnt - 0.5) * 0.44 + world.rng.range(-0.04, 0.04);
    const vOffset = world.rng.range(-0.16, 0.16);
    lakeWells.push({
      u: uOffset,
      v: vOffset,
      ru: world.rng.range(0.12, 0.18),
      rv: world.rng.range(0.09, 0.14),
      depth: world.rng.range(0.25, 0.32),
    });
  }

  // Emergent Tectonic Archipelago Spine, Multi-Lobe Massifs & Satellite Skerries for `island-hopper`
  const islandMassifs = [];
  const islandBites = [];
  if (arch === "island-hopper") {
    const baseTheta = world.rng.range(-Math.PI, Math.PI);
    const arcCurvature =
      (world.rng.next() < 0.5 ? 1 : -1) *
      world.rng.range(0.28, 0.52) *
      (0.55 + calderaW * 0.52);

    const sampleArcPoint = (t) => {
      const s = t * 0.82;
      const n =
        arcCurvature * (t * t - 0.09) +
        Math.sin(t * Math.PI * 2.0 + foldPhase) * 0.05;
      return {
        x: Math.max(
          -0.39,
          Math.min(0.39, s * Math.cos(baseTheta) - n * Math.sin(baseTheta)),
        ),
        y: Math.max(
          -0.37,
          Math.min(0.37, s * Math.sin(baseTheta) + n * Math.cos(baseTheta)),
        ),
        tangent: baseTheta + 2 * arcCurvature * t,
      };
    };

    const majorCenters = [];
    const arcTs = [
      -0.38 + world.rng.range(-0.03, 0.03),
      -0.13 + world.rng.range(-0.04, 0.04),
      0.13 + world.rng.range(-0.04, 0.04),
      0.38 + world.rng.range(-0.03, 0.03),
    ];
    for (let idx = 0; idx < arcTs.length; idx++) {
      const pt = sampleArcPoint(arcTs[idx]);
      const isMain = idx === 1 || idx === 2;
      majorCenters.push({
        x: Math.max(-0.35, Math.min(0.35, pt.x + world.rng.range(-0.03, 0.03))),
        y: Math.max(-0.33, Math.min(0.33, pt.y + world.rng.range(-0.03, 0.03))),
        ang: pt.tangent + world.rng.range(-0.55, 0.55),
        scale: isMain
          ? world.rng.range(0.96, 1.12)
          : world.rng.range(0.74, 0.88),
        height: isMain ? world.rng.range(0.92, 1.0) : world.rng.range(0.8, 0.9),
      });
    }

    for (const sideMul of [1, -1]) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const rDist = world.rng.range(0.24, 0.36);
        const ang =
          baseTheta +
          sideMul * Math.PI * 0.5 +
          world.rng.range(-0.55, 0.55) +
          (attempt > 15 ? world.rng.range(-1.0, 1.0) : 0);
        const fx = Math.max(-0.35, Math.min(0.35, Math.cos(ang) * rDist));
        const fy = Math.max(-0.33, Math.min(0.33, Math.sin(ang) * rDist));
        const minSep = attempt < 18 ? 0.24 : 0.19;
        if (
          majorCenters.every((mc) => Math.hypot(mc.x - fx, mc.y - fy) >= minSep)
        ) {
          majorCenters.push({
            x: fx,
            y: fy,
            ang: ang + world.rng.range(-0.7, 0.7),
            scale: world.rng.range(0.8, 0.98),
            height: world.rng.range(0.82, 0.94),
          });
          break;
        }
      }
    }

    for (let mIdx = 0; mIdx < majorCenters.length; mIdx++) {
      const mc = majorCenters[mIdx];
      const lobeCount = mc.scale > 0.92 ? 3 : 2;
      for (let l = 0; l < lobeCount; l++) {
        const lobeAng =
          mc.ang +
          (l === 0
            ? 0
            : l === 1
              ? world.rng.range(0.65, 1.4)
              : world.rng.range(-1.4, -0.65));
        const lobeOff = l === 0 ? 0 : mc.scale * world.rng.range(0.026, 0.046);
        const lx = mc.x + Math.cos(lobeAng) * lobeOff;
        const ly = mc.y + Math.sin(lobeAng) * lobeOff;
        const rx =
          (l === 0 ? 0.092 : 0.062) * mc.scale * world.rng.range(0.9, 1.16);
        const ry =
          (l === 0 ? 0.05 : 0.038) * mc.scale * world.rng.range(0.86, 1.14);
        islandMassifs.push({
          group: mIdx,
          x: lx,
          y: ly,
          rx,
          ry,
          ang: lobeAng,
          height: mc.height * (l === 0 ? 1.0 : world.rng.range(0.82, 0.95)),
          isIslet: false,
        });
      }

      const biteAng =
        mc.ang +
        Math.PI * 0.5 * (world.rng.next() < 0.5 ? 1 : -1) +
        world.rng.range(-0.4, 0.4);
      const biteDist = mc.scale * world.rng.range(0.036, 0.056);
      islandBites.push({
        x: mc.x + Math.cos(biteAng) * biteDist,
        y: mc.y + Math.sin(biteAng) * biteDist,
        r: mc.scale * world.rng.range(0.03, 0.046),
        depth: world.rng.range(0.22, 0.34),
      });
    }

    for (let s = 0; s < 14; s++) {
      const host = world.rng.pick(majorCenters);
      const tailAng =
        host.ang +
        (world.rng.next() < 0.5 ? 0 : Math.PI) +
        world.rng.range(-0.75, 0.75);
      const tailDist = host.scale * world.rng.range(0.088, 0.145);
      const ix = Math.max(
        -0.41,
        Math.min(0.41, host.x + Math.cos(tailAng) * tailDist),
      );
      const iy = Math.max(
        -0.39,
        Math.min(0.39, host.y + Math.sin(tailAng) * tailDist),
      );
      if (majorCenters.some((mc) => Math.hypot(mc.x - ix, mc.y - iy) < 0.072))
        continue;
      islandMassifs.push({
        group: 100 + s,
        x: ix,
        y: iy,
        rx: world.rng.range(0.02, 0.036),
        ry: world.rng.range(0.013, 0.024),
        ang: tailAng + world.rng.range(-0.5, 0.5),
        height: world.rng.range(0.62, 0.78),
        isIslet: true,
      });
    }
  }

  // Precompute Voronoi Micro-Plates when `terrainAlgo === 'voronoi-plates'`
  const voronoiPlates = [];
  if (terrainAlgo === "voronoi-plates") {
    for (let p = 0; p < 15; p++) {
      for (let attempt = 0; attempt < 25; attempt++) {
        const px = world.rng.range(-0.46, 0.46);
        const py = world.rng.range(-0.46, 0.46);
        if (
          voronoiPlates.every(
            (vp) => Math.hypot(vp.x - px, vp.y - py) >= 0.17 || attempt > 18,
          )
        ) {
          const velAng = world.rng.range(0, Math.PI * 2);
          voronoiPlates.push({
            x: px,
            y: py,
            vx: Math.cos(velAng),
            vy: Math.sin(velAng),
            baseElev: world.rng.range(0.24, 0.68),
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
      const nx = x / W - 0.5;
      const ny = y / H - 0.5;

      const warpU =
        world.noise.fbm((nx + 0.5) * 1.9 + offX, (ny + 0.5) * 1.9 + offY, 2) *
          0.18 -
        0.09;
      const warpV =
        world.noise.fbm((nx + 0.5) * 1.9 + offY, (ny + 0.5) * 1.9 + offX, 2) *
          0.18 -
        0.09;
      const wx = nx + warpU;
      const wy = ny + warpV;

      const uStrike = wx * cosS + wy * sinS;
      const vStrike = -wx * sinS + wy * cosS;

      const macroPlate = world.noise.fbm(
        uStrike * 2.1 + offX * 0.3,
        vStrike * 2.8 + offY * 0.3,
        3,
      );
      const foldValleys =
        Math.cos(vStrike * Math.PI * 3.4 + foldPhase + macroPlate * 2.1) * 0.14;
      const ridgeRaw = world.noise.noise(
        uStrike * 3.8 + 13.7,
        vStrike * 4.4 + 9.2,
      );
      const ridgedSpines =
        Math.pow(Math.max(0, 1.0 - Math.abs(2.0 * ridgeRaw - 1.0)), 1.6) * 0.24;
      const fineDetail = world.noise.fbm(x / 32 + offX, y / 32 + offY, 2) * 0.1;

      let baseRelief;
      if (terrainAlgo === "quilez-erosion") {
        // Engine 2: Inigo Quilez Analytic Derivative Gradient-Eroded fBm (`1 / (1 + k * |∇H|²)`)
        // Suppresses high-frequency crags on steep slopes -> wide flat alluvial plains & sharp eroded ridges!
        const erodedMain = world.noise.fbmEroded(
          uStrike * 2.6 + offX * 0.25,
          vStrike * 3.1 + offY * 0.25,
          5,
          2.15,
        );
        const dRidge = world.noise.noiseDeriv(
          uStrike * 4.2 + 7.1,
          vStrike * 4.6 + 3.8,
        );
        const gradMag2 = dRidge.dx * dRidge.dx + dRidge.dy * dRidge.dy;
        const sharpCrest =
          Math.pow(Math.max(0, 1.0 - Math.abs(2.0 * dRidge.val - 1.0)), 2.2) /
          (1.0 + 1.8 * gradMag2);
        // Nonlinear terrace flattening on low elevations + sharp dendritic mountain crests
        const valleyFlat = Math.pow(erodedMain, 1.38) * 0.68;
        baseRelief =
          valleyFlat +
          sharpCrest * 0.34 * reliefW +
          foldValleys * 0.42 * reliefW;
      } else if (terrainAlgo === "voronoi-plates") {
        // Engine 3: Domain-Warped Tectonic Micro-Plates (Sinuous Continental Sutures & Fold Belts)
        const vwx = wx + (macroPlate - 0.5) * 0.28 + (fineDetail - 0.05) * 0.85;
        const vwy = wy + foldValleys * 1.05 + (macroPlate - 0.5) * 0.22;
        let d1 = Infinity,
          d2 = Infinity;
        let p1 = voronoiPlates[0],
          p2 = voronoiPlates[0];
        for (const vp of voronoiPlates) {
          const dist = Math.hypot(vwx - vp.x, vwy - vp.y);
          if (dist < d1) {
            d2 = d1;
            p2 = p1;
            d1 = dist;
            p1 = vp;
          } else if (dist < d2) {
            d2 = dist;
            p2 = vp;
          }
        }
        const boundaryDist = d2 - d1;
        const nxP = (p2.x - p1.x) / (Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1);
        const nyP = (p2.y - p1.y) / (Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1);
        const convergence = (p1.vx - p2.vx) * nxP + (p1.vy - p2.vy) * nyP;

        const blendT = Math.min(1, Math.max(0, 0.5 + boundaryDist / 0.18));
        const cratonElev = p1.baseElev * blendT + p2.baseElev * (1 - blendT);
        const boundaryPulse = Math.exp(-Math.pow(boundaryDist / 0.068, 2));
        // Convergent sutures buckle upward into warped cordillera ranges; divergent sutures form broad valleys
        const faultRelief =
          convergence >= -0.05
            ? boundaryPulse * (0.24 + ridgedSpines * 0.95 * reliefW)
            : -boundaryPulse * 0.14 * macroPlate;
        const cratonNoise =
          world.noise.fbmEroded(
            uStrike * 2.3 + offX * 0.2,
            vStrike * 2.6 + offY * 0.2,
            4,
            1.5,
          ) * 0.46;
        baseRelief =
          cratonElev * 0.54 +
          faultRelief +
          cratonNoise +
          foldValleys * 0.35 * reliefW;
      } else {
        // Engine 1: Default Anisotropic Strike fBm + Ridged Spines
        baseRelief =
          macroPlate * 0.52 +
          foldValleys * 0.75 * reliefW +
          ridgedSpines * reliefW +
          fineDetail;
      }

      // Alpine Passes: Prominent central cordillera spine along uStrike with glacial saddle passes across vStrike
      if (arch === "alpine-passes" || reliefW > 1.3) {
        const spineEnvelope = Math.exp(-Math.pow(vStrike / 0.15, 2));
        let passCut = 0;
        for (let p = 0; p < basinCnt; p++) {
          const passU = -0.3 + (0.6 / (basinCnt + 1)) * (p + 1);
          const notch =
            Math.exp(-Math.pow((uStrike - passU) / 0.065, 2)) *
            Math.exp(-Math.pow(vStrike / 0.22, 2));
          passCut += notch * 0.36 * Math.min(1.5, incisionW);
        }
        const cordilleraSpine = Math.max(
          0,
          spineEnvelope * 0.34 * (reliefW - 0.8) - passCut,
        );
        baseRelief += cordilleraSpine;
      }

      // Canyon Plateau Terracing + Deep Sinuous Central Gorge & Side-Canyon Grade Ramps
      if (incisionW > 0.3) {
        const terraceSteps = 7;
        const terraced = Math.round(baseRelief * terraceSteps) / terraceSteps;
        const terraceBlend = Math.min(0.55, (incisionW - 0.3) * 0.32);
        baseRelief = baseRelief * (1 - terraceBlend) + terraced * terraceBlend;
      }
      if (arch === "canyon-gorge" || incisionW > 1.4) {
        const gorgeV =
          Math.sin(uStrike * Math.PI * 3.2 + foldPhase) * 0.08 +
          Math.cos(uStrike * Math.PI * 6.5 + offX) * 0.03;
        const distGorge = Math.abs(vStrike - gorgeV);
        const gorgeDepth = Math.min(0.42, (incisionW - 0.4) * 0.26);
        const inGorge = Math.exp(-Math.pow(distGorge / 0.045, 2)) * gorgeDepth;
        let sideRamp = 0;
        for (let b = 0; b < basinCnt; b++) {
          const sideU = -0.28 + (0.56 / (basinCnt + 1)) * (b + 1);
          sideRamp +=
            Math.exp(-Math.pow((uStrike - sideU) / 0.04, 2)) *
            Math.exp(-Math.pow((vStrike - gorgeV) / 0.18, 2)) *
            (gorgeDepth * 0.6);
        }
        baseRelief -= inGorge + sideRamp;
      }
      if (
        foldValleys < 0 &&
        (arch === "fjord-sound" || arch === "alpine-passes" || incisionW > 1.2)
      ) {
        baseRelief -= Math.abs(foldValleys) * incisionW * 0.4;
      }

      let elev = baseRelief;

      if (arch === "island-hopper") {
        const coveU =
          (world.noise.fbm(nx * 5.6 + offX * 0.7, ny * 5.6 + offY * 0.7, 2) -
            0.5) *
          0.085;
        const coveV =
          (world.noise.fbm(nx * 5.6 + offY * 0.7, ny * 5.6 + offX * 0.7, 2) -
            0.5) *
          0.085;
        const ixW = nx + warpU * 0.52 + coveU;
        const iyW = ny + warpV * 0.52 + coveV;

        let bestVal = 0;
        let bestGroup = -1;
        let sameGroupSecond = 0;
        let diffGroupSecond = 0;
        for (const m of islandMassifs) {
          const dxI = ixW - m.x;
          const dyI = iyW - m.y;
          const cI = Math.cos(m.ang),
            sI = Math.sin(m.ang);
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

        let massifShelf =
          bestVal +
          sameGroupSecond * 0.22 -
          diffGroupSecond * (0.6 + barrierW * 0.35);
        for (const bite of islandBites) {
          const db2 =
            (Math.pow(ixW - bite.x, 2) + Math.pow(iyW - bite.y, 2)) /
            (bite.r * bite.r);
          if (db2 < 4.0) {
            massifShelf -= Math.exp(-db2 * 1.65) * bite.depth;
          }
        }
        massifShelf = Math.max(0, massifShelf);

        const shelfEnvelope = Math.min(1.0, Math.pow(massifShelf * 2.5, 1.1));
        const coastalFractal = (baseRelief - 0.48) * 0.65;
        const interiorSpine =
          ridgedSpines * reliefW * Math.min(1.1, massifShelf * 1.4) * 1.15;
        elev = Math.max(
          0,
          massifShelf * 0.74 + coastalFractal * shelfEnvelope + interiorSpine,
        );
      } else {
        // Continental Archetypes: Modulated by the 6 orthogonal geomorphology scalars
        const sProj = -nx * sinC + ny * cosC;
        const cProjW =
          wx * cosC +
          wy * sinC +
          Math.sin(sProj * Math.PI * 2.1 + foldPhase) * 0.04;
        const coastDepth = Math.max(0, (cProjW - 0.14) / 0.42);
        const bayIndent =
          Math.exp(-Math.pow(vStrike / 0.18, 2)) *
          Math.pow(coastDepth, 1.25) *
          0.48;

        let effCoastCut = (coastDepth * 0.18 + bayIndent) * embayW;

        // Isthmus pinch: two opposing coastal bays pinching inward along uStrike ≈ 0 toward center
        if (
          arch === "isthmus-strait" ||
          (embayW > 1.5 && arch !== "fjord-sound")
        ) {
          const bayPinch =
            Math.exp(-Math.pow(uStrike / 0.2, 2)) *
            Math.pow(Math.max(0, (Math.abs(vStrike) - 0.036) / 0.24), 1.2) *
            0.64 *
            Math.min(1.8, embayW);
          effCoastCut += bayPinch;
        }

        // Fjord fingers: basinCnt deep branching glacial fjord fingers
        if (arch === "fjord-sound" || (embayW > 1.4 && incisionW > 1.2)) {
          let fjordCut = 0;
          for (let f = 0; f < basinCnt; f++) {
            const fjordS = -0.28 + (0.56 / (basinCnt + 1)) * (f + 1);
            const distF = Math.abs(
              sProj + Math.sin(cProjW * Math.PI * 3.0 + f) * 0.035 - fjordS,
            );
            const fjordReach = Math.max(0, (cProjW + 0.22) / 0.44);
            fjordCut +=
              Math.exp(-Math.pow(distF / 0.038, 2)) *
              Math.pow(fjordReach, 1.1) *
              0.44 *
              Math.min(1.8, embayW);
          }
          effCoastCut += fjordCut;
        }

        elev -= effCoastCut;

        // Somma Caldera, Crater Lake & Emergent Central Resurgent Volcanic Island
        if (calderaW > 0.05) {
          const rCenter = Math.hypot(wx * 0.92, wy * 0.92);
          const thetaCenter = Math.atan2(wy, wx);
          const sommaRidge =
            Math.exp(-Math.pow((rCenter - 0.3) / 0.055, 2)) * 0.42;
          const craterDepression =
            Math.max(0, 1.0 - Math.pow(rCenter / 0.22, 2)) * 0.48;
          const resurgentDome = Math.exp(-Math.pow(rCenter / 0.072, 2)) * 0.78;
          const breachDiff = Math.abs(
            Math.atan2(
              Math.sin(thetaCenter - coastAng),
              Math.cos(thetaCenter - coastAng),
            ),
          );
          const breachNotch =
            rCenter >= 0.14 && breachDiff < 0.22
              ? Math.exp(-Math.pow(breachDiff / 0.1, 2)) * 0.46
              : 0;
          const calderaMod =
            (sommaRidge - craterDepression + resurgentDome - breachNotch) *
            calderaW;
          elev += calderaMod;
        }

        // Coastal Barrier Lagoon & Outer Spit (warped organic shoreline spit + inner lagoon)
        if (barrierW > 0.05 && arch !== "caldera-basin") {
          const lagoonWell =
            Math.exp(-Math.pow((cProjW - 0.04) / 0.055, 2)) * 0.36;
          const outerSeaCut = Math.max(0, (cProjW - 0.2) / 0.25) * 0.42;
          let inletCut = 0;
          for (let inIdx = 0; inIdx < 2; inIdx++) {
            const inletS = -0.16 + inIdx * 0.32;
            inletCut += Math.exp(-Math.pow((sProj - inletS) / 0.028, 2));
          }
          const barrierSpit =
            Math.exp(-Math.pow((cProjW - 0.135) / 0.036, 2)) *
            Math.max(0, 1.0 - inletCut * 0.92) *
            0.44;
          const barrierMod =
            (barrierSpit - lagoonWell - outerSeaCut) * barrierW;
          elev += barrierMod;
        }

        // Interior Lake Wells (suppressed inside caldera ring or high-incision canyon/alpine spines)
        let lakeWellCut = 0;
        for (let b = 0; b < lakeWells.length; b++) {
          const lw = lakeWells[b];
          const du = (uStrike - lw.u) / lw.ru;
          const dv = (vStrike - lw.v) / lw.rv;
          lakeWellCut += Math.exp(-du * du - dv * dv) * lw.depth;
        }
        if (arch === "inland") {
          lakeWellCut *= 1.15;
        } else if (arch === "caldera-basin" || calderaW > 0.8) {
          lakeWellCut *= 0.15;
        } else if (arch === "canyon-gorge" || arch === "alpine-passes") {
          lakeWellCut *= 0.28;
        }
        elev -= lakeWellCut;
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
  const maxE = sampleElevs[sampleElevs.length - 1] || minE + 1;
  const spanE = Math.max(0.01, maxE - minE);
  for (let i = 0; i < W * H; i++) {
    world.elevationField[i] =
      0.02 + ((world.elevationField[i] - minE) / spanE) * 0.96;
  }

  let baseFrac = 0.17;
  let maxFrac = 0.35;

  if (arch === "island-hopper") {
    baseFrac = 0.71;
    maxFrac = 0.78;
  } else if (arch === "inland") {
    baseFrac = 0.13;
    maxFrac = 0.24;
  } else if (arch === "alpine-passes" || arch === "canyon-gorge") {
    baseFrac = 0.12;
    maxFrac = 0.25;
  } else if (arch === "fjord-sound") {
    baseFrac = 0.24;
    maxFrac = 0.38;
  } else if (arch === "isthmus-strait") {
    baseFrac = 0.26;
    maxFrac = 0.4;
  } else if (arch === "caldera-basin") {
    baseFrac = 0.22;
    maxFrac = 0.36;
  } else if (arch === "barrier-lagoon") {
    baseFrac = 0.25;
    maxFrac = 0.38;
  }

  const targetWaterFrac = Math.max(
    0.08,
    Math.min(maxFrac, baseFrac * (0.68 + waterRatio * 0.65)),
  );
  const qIdx = Math.floor(sampleElevs.length * targetWaterFrac);
  const rawSeaLevel = 0.02 + ((sampleElevs[qIdx] - minE) / spanE) * 0.96;
  const seaLevel =
    arch === "island-hopper" ? Math.max(0.068, rawSeaLevel) : rawSeaLevel;
  world.seaLevel = seaLevel;

  for (let i = 0; i < W * H; i++) {
    if (world.elevationField[i] < seaLevel) {
      world.waterMask[i] = 2;
    }
  }

  // For inland maps (or when embayW === 0): force border tiles above seaLevel + 0.04
  // so inland maps are 100% landlocked with zero border-touching water basins!
  if (arch === "inland" || embayW === 0) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (x <= 3 || x >= W - 4 || y <= 3 || y >= H - 4) {
          const id = world.idx(x, y);
          if (world.elevationField[id] < seaLevel + 0.04) {
            world.elevationField[id] = seaLevel + 0.04;
            world.waterMask[id] = 0;
          }
        }
      }
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
            if (world.waterMask[world.idx(x + dx, y + dy)] > 0)
              waterNeighbors++;
          }
        }
        const curr = world.waterMask[world.idx(x, y)];
        if (curr > 0 && waterNeighbors <= 2) nextMask[world.idx(x, y)] = 0;
        else if (curr === 0 && waterNeighbors >= 6)
          nextMask[world.idx(x, y)] = 2;
      }
    }
    world.waterMask = nextMask;
  }

  // Identify Emergent Water Basins (`waterMask === 2` components) and Remove Tiny Puddles (< 85 tiles)
  const basins = [];
  const visitedW2 = new Uint8Array(W * H);
  /** @type {Array<{ id: number, size: number, cx: number, cy: number, deepX: number, deepY: number, minElev: number, touchesBorder: boolean, comp: number[] }>} */
  const rawComps = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const startId = world.idx(x, y);
      if (world.waterMask[startId] !== 2 || visitedW2[startId]) continue;
      const comp = [startId];
      visitedW2[startId] = 1;
      let sumX = 0,
        sumY = 0,
        touchesBorder = false,
        minElev = Infinity,
        deepX = x,
        deepY = y;
      for (let h = 0; h < comp.length; h++) {
        const cid = comp[h];
        const cx = cid % W;
        const cy = Math.floor(cid / W);
        sumX += cx;
        sumY += cy;
        if (cx <= 2 || cx >= W - 3 || cy <= 2 || cy >= H - 3)
          touchesBorder = true;
        if (world.elevationField[cid] < minElev) {
          minElev = world.elevationField[cid];
          deepX = cx;
          deepY = cy;
        }
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = cx + dx,
            ny = cy + dy;
          if (world.inBounds(nx, ny)) {
            const nid = world.idx(nx, ny);
            if (world.waterMask[nid] === 2 && !visitedW2[nid]) {
              visitedW2[nid] = 1;
              comp.push(nid);
            }
          }
        }
      }
      const bx = Math.round(sumX / comp.length);
      const by = Math.round(sumY / comp.length);
      rawComps.push({
        id: rawComps.length,
        size: comp.length,
        cx: bx,
        cy: by,
        deepX,
        deepY,
        minElev,
        touchesBorder,
        comp,
      });
    }
  }

  // Filter components: retain basins larger than minBasinSize
  const minBorderBasin = 620;
  const minLakeBasin = 380;
  for (const rc of rawComps) {
    const minSize =
      arch === "island-hopper"
        ? 140
        : rc.touchesBorder
          ? minBorderBasin
          : minLakeBasin;
    if (rc.size < minSize) {
      for (const cid of rc.comp) {
        world.waterMask[cid] = 0;
        world.elevationField[cid] = Math.max(
          world.elevationField[cid],
          seaLevel + 0.03,
        );
      }
    } else {
      basins.push({
        id: basins.length,
        size: rc.size,
        cx: rc.cx,
        cy: rc.cy,
        deepX: rc.deepX,
        deepY: rc.deepY,
        minElev: rc.minElev,
        touchesBorder: rc.touchesBorder,
      });
      world.hydroFeatures.push({
        x: rc.cx,
        y: rc.cy,
        type: rc.touchesBorder ? "bay" : "lake",
      });
    }
  }

  // If no basin met the threshold, retain the largest component so basins is never empty
  if (basins.length === 0 && rawComps.length > 0) {
    rawComps.sort((a, b) => b.size - a.size);
    const largest = rawComps[0];
    for (const cid of largest.comp) {
      world.waterMask[cid] = 2;
    }
    basins.push({
      id: 0,
      size: largest.size,
      cx: largest.cx,
      cy: largest.cy,
      deepX: largest.deepX,
      deepY: largest.deepY,
      minElev: largest.minElev,
      touchesBorder: largest.touchesBorder,
    });
    world.hydroFeatures.push({
      x: largest.cx,
      y: largest.cy,
      type: largest.touchesBorder ? "bay" : "lake",
    });
  }

  basins.sort(
    (a, b) =>
      Number(b.touchesBorder) - Number(a.touchesBorder) || b.size - a.size,
  );
  const primarySink = basins[0] || {
    deepX: Math.round((0.5 + cosC * 0.42) * W),
    deepY: Math.round((0.5 + sinC * 0.42) * H),
  };

  return { basins, primarySink };
}
