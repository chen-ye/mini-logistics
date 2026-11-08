# Plan 3: Out-of-Town Geographic Resource Niches (Mines, Timber Camps & Alluvial Farms)

## Steps
- [ ] Prerequisite: Complete Plan 1 (Elevation-Reactive Routing) and Plan 2 (Two-Phase Historical Seeding)
- [ ] Classify `RAW` primary extraction facilities into 3 geographic subtypes: `RAW_MINE` (Foothill Quarry/Mine), `RAW_TIMBER` (Upland Forestry Camp), and `RAW_FARM` (Alluvial Agribusiness)
- [ ] Seed out-of-town rural resource extraction sites in authentic terrain niches during Stage 7 and route dedicated rural haul roads to the regional trunk network
- [ ] Render distinct cartographic icons/footprints for Mines, Timber Camps, and Alluvial Farms in `Mini Motorways` and `RCI & Cargo Chain` views
- [ ] Wire rural `RAW` extraction sites into `buildIndustrialCargoChain()` (`RAW -> Town MFG -> LOG -> CBD COM`) and entity inspector cards
- [ ] Verify across benchmark seeds and review with parallel Targeted + Uncued Holistic subagents

## 1. Geologically Grounded Primary Industry Placement (OpenTTD / Transport Fever 2)

### Problem
Currently, [`placeTownCommercialAndIndustrial()`](./src/world-generator.js#L1890-L1995) packs all `RAW` (Primary Extraction), `MFG` (Manufacturing), and `LOG` (Logistics) buildings inside the outer urban street blocks of towns. In real geography—and in *OpenTTD* and *Transport Fever 2*—primary extraction (`RAW`) happens out in the landscape where the raw natural resources actually exist, while `MFG` factories and `LOG` distribution warehouses sit in town industrial rings and port districts.

### Fix
1. **Three Geographically Bound Rural `RAW` Niches**:
   - **Foothill Quarries & Mines (`RAW_MINE`)**: Placed outside towns (`distToTown >= urbanRadius + 7`) along mountain ridge toes and canyon mouths (`elevationField >= seaLevel + 0.16 && elevationField <= seaLevel + 0.28`, `slopeField >= 0.12 && slopeField <= 0.36`, `waterMask === 0`).
   - **Windward Upland Timber Camps (`RAW_TIMBER`)**: Nestled inside dense upland woodland groves (`elevationField >= seaLevel + 0.11`, `fertilityField >= 0.42`, surrounded by `>= 6` trees in `world.trees`).
   - **Alluvial Floodplain Farms (`RAW_FARM`)**: Placed on flat, fertile river-valley benches and coastal plains outside urban cores (`elevationField <= seaLevel + 0.11`, `slopeField <= 0.10`, `fertilityField >= 0.45`, `distToWater >= 3.5 && distToWater <= 16.0`).
2. **Dedicated Rural Haul Roads (`commitRoadPath`)**:
   - Each rural `RAW` site routes a dedicated elevation-reactive rural haul spur (`findRoadPathAStar(siteX, siteY, hostTown.x, hostTown.y, true, null, true)`) that merges cleanly onto the nearest regional trunk highway (`stopOnExistingRoad = true`), with an anchored driveway (`roadX, roadY`) and a small clearing in `buildingMask = 2`.
3. **Cartographic Representation & Cargo Supply Chain**:
   - Render clean, minimal *Mini Motorways* × *OpenTTD* architectural silhouettes in [`src/renderer.js`](./src/renderer.js) for rural Mines (terraced quarry pit + ore hopper), Timber Camps (log yard + sawmill shed), and Farms (silo pair + field rows) with warm amber `RAW` badges in the `RCI & Cargo Chain` view.
   - Connect rural `RAW` sites to town `MFG` factories in [`buildIndustrialCargoChain()`](./src/world-generator.js#L2188-L2283) so articulated freight semi-trucks haul raw materials down from the mountains, forests, and floodplains into city factories.