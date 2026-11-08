# Plan 2: Two-Phase Historical Settlement & Road Co-Evolution

## Steps
- [ ] Prerequisite: Complete Plan 1 (Elevation-Reactive Regional Road & Expressway Routing)
- [ ] Split `seedSettlements` into Phase 4A (Tier 1 Metropolises & Tier 2 Regional Cities) and Phase 6C (Tier 3 Market Towns & Tier 4 Rural Hamlets)
- [ ] Route primary inter-capital trunk arterials and bridges between Tier 1 & Tier 2 cities before seeding Tier 3 & Tier 4 settlements
- [ ] Score Tier 3 & Tier 4 settlement candidates by proximity to committed river bridgeheads, trunk road junctions, and valley passes
- [ ] Connect newly nucleated Tier 3 & Tier 4 towns into the trunk road network and generate their local borough grids
- [ ] Update reactive memoized stage DAG in `createWorldPipeline` and verify across benchmark seeds with parallel Targeted + Uncued Holistic subagents

## 1. Why Co-Evolving Capitals, Trunk Roads & Secondary Towns Matters

### Problem
Currently, [`seedSettlements()`](./src/world-generator.js#L320-L470) places all `20–36` settlements (`Tier 1` Metropolises down to `Tier 4` Rural Hamlets) in Stage 4 **before** any roads or bridges exist (`Stage 6B`). Because `Tier 3` Market Towns and `Tier 4` Hamlets are placed without knowledge of the primary inter-city valley road corridors or river bridge crossings, they frequently spawn slightly off the natural valley highway or a few tiles away from a bridgehead, requiring awkward side spurs.

### Fix (Dwarf Fortress & RimWorld Historical Sequencing)
Model the historical co-evolution of settlements and transportation corridors in two phases:
1. **Phase 1 — Founding Capitals & Regional Ports (`Tier 1` & `Tier 2`)**:
   - Seed the `numMetros` (`Tier 1`) and `numRegional - numMetros` (`Tier 2`) major cities at the highest-suitability river confluences, coastal bays, and lake outlets, and solve/place their multi-tier airports (`Stage 5`) and primary borough boulevards.
2. **Phase 2 — Ancient Valley Trunk Highways & River Bridges**:
   - Route the primary regional trunk road network (`findRoadPathAStar` with Plan 1's elevation-reactive contour/valley cost) connecting all `Tier 1` and `Tier 2` cities and airport gates. Record all **river bridgehead tiles** (dry bank tiles within `3..6` tiles of a committed river bridge) and **trunk road pass/junction tiles**.
3. **Phase 3 — Nucleating Market Towns (`Tier 3`) & Crossroads Hamlets (`Tier 4`) Along Trunk Corridors**:
   - Seed the remaining `Tier 3` Market/Bridge Towns and `Tier 4` Rural Hamlets with a strong historical nucleation bonus:
     - **`Tier 3` Market/Bridgehead Towns**: Receive a `+0.48` suitability bonus within `4..10` tiles of a committed river bridgehead or trunk road confluence, naturally forming classic bridgehead market towns straddling or anchoring river crossings.
     - **`Tier 4` Crossroads/Valley Hamlets**: Receive a `+0.38` suitability bonus within `3..9` tiles of an existing valley trunk road (or on fertile agricultural benches along the trunk corridor), so rural villages sit right on or alongside the highway rather than at dead-end spurs.
   - Carve each `Tier 3`/`Tier 4` town's compact street grid aligned to the trunk road passing through/beside it, and link any remaining off-trunk hamlets via short valley branches.