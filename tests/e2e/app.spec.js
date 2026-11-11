import { test, expect } from "@playwright/test";

test.describe("Mini Logistics — Buildless Dual-Worker E2E Suite", () => {
  test("Desktop (1600x1000): loads with zero .d.ts requests, completes 2W Parallel build, caches S1–S8, switches layers & inspects entities", async ({
    page,
  }) => {
    /** @type {string[]} */
    const pageErrors = [];
    /** @type {string[]} */
    const consoleErrors = [];
    /** @type {string[]} */
    const dtsRequests = [];
    /** @type {string[]} */
    const failedResponses = [];

    await page.setViewportSize({ width: 1600, height: 1000 });

    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("request", (req) => {
      if (req.url().endsWith(".d.ts")) {
        dtsRequests.push(req.url());
      }
    });
    page.on("response", (res) => {
      if (
        res.url().startsWith("http://127.0.0.1:8788") &&
        res.status() >= 400 &&
        !res.url().endsWith("/favicon.ico")
      ) {
        failedResponses.push(`${res.status()} ${res.url()}`);
      }
    });

    await page.goto("/index.html");

    // Wait for initial Dual-Worker world build to populate window.appBridge
    await page.waitForFunction(
      () => Boolean(window.appBridge?.isReady()),
      null,
      {
        timeout: 20000,
      },
    );

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(dtsRequests).toEqual([]);
    expect(failedResponses).toEqual([]);

    const badgeText = await page.locator("#genTimeBadge").textContent();
    expect(badgeText).toContain("2W Parallel");

    // Verify all VectorLayerRecorder Path2D display lists were built on renderer
    const hasDisplayLists = await page.evaluate(() =>
      Boolean(window.appBridge?.hasDisplayLists()),
    );
    expect(hasDisplayLists).toBe(true);

    // Toggling Stage 9 Intermediate Expressway Ramps hits S1–S8 cache
    await page.locator("#toggleInterRamps").click();
    await expect(page.locator("#genTimeBadge")).toContainText("Cached S1–S8", {
      timeout: 10000,
    });

    // Switch through all 6 View Layers and verify renderer.activeLayer & 1x / 3.5x zoom rendering
    const layers = [
      "rci",
      "airport",
      "hierarchy",
      "hydrology",
      "roadgrid",
      "aesthetic",
    ];
    for (const layer of layers) {
      await page.locator(`.layer-btn[data-layer="${layer}"]`).click();
      const activeLayer = await page.evaluate(() =>
        window.appBridge?.getActiveLayer(),
      );
      expect(activeLayer).toBe(layer);

      if (layer === "aesthetic" || layer === "rci" || layer === "roadgrid") {
        const zoomCheck = await page.evaluate(() =>
          window.appBridge?.renderAtZooms([1.0, 3.5]),
        );
        expect(zoomCheck).toBe(true);
      }
    }

    // Open Entity Inspector on primary airport and verify live taxi/landing/gate telemetry updates
    await page.evaluate(() => {
      const summary = window.appBridge?.getWorldSummary();
      const ap = summary?.airports[0];
      if (ap) window.appBridge?.selectEntity("airport", ap.id, true);
    });
    await expect(page.locator("#inspectorCard")).toBeVisible();
    await expect(page.locator("#inspCode")).toContainText("IATA");
    await expect(page.locator("#inspGateStats")).toContainText("Occupied");
    await expect(page.locator("#inspAtcStats")).toContainText("Taxiing");

    const updatedInBrowser = await page.evaluate(async () => {
      const gateEl = document.getElementById("inspGateStats");
      const atcEl = document.getElementById("inspAtcStats");
      const seen = new Set();
      for (let i = 0; i < 240; i++) {
        await window.appBridge?.stepSimulation(1, 0.1, 1.0);
        seen.add(`${gateEl?.textContent}|${atcEl?.textContent}`);
      }
      return seen.size;
    });
    expect(updatedInBrowser).toBeGreaterThan(1);

    const townJumpBtn = page.locator("#inspBody [data-jump-town]").first();
    if ((await townJumpBtn.count()) > 0) {
      await townJumpBtn.click();
      await expect(page.locator("#inspBadge")).toContainText("TIER");
    }

    // Pressing Escape closes the inspector card
    await page.keyboard.press("Escape");
    await expect(page.locator("#inspectorCard")).toBeHidden();

    // Select primary airport with focus to center camera, then close card
    await page.evaluate(() => {
      const summary = window.appBridge?.getWorldSummary();
      const ap = summary?.airports[0];
      if (ap) window.appBridge?.selectEntity("airport", ap.id, true);
    });
    await expect(page.locator("#inspectorCard")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#inspectorCard")).toBeHidden();

    // Real canvas pointer click on primary airport triggers TAP_AT -> opens #inspectorCard
    const screenCoords = await page.evaluate(() => {
      const summary = window.appBridge?.getWorldSummary();
      const cam = window.appBridge?.getCamera();
      const ap = summary?.airports[0];
      if (!summary || !cam || !ap) return null;
      const ts = summary.tileSize;
      const sx = ap.x * cam.zoom * ts + cam.x;
      const sy = ap.y * cam.zoom * ts + cam.y;
      return { sx, sy };
    });
    expect(screenCoords).not.toBeNull();
    if (screenCoords) {
      await page.mouse.click(screenCoords.sx, screenCoords.sy);
      await expect(page.locator("#inspectorCard")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("#inspectorCard")).toBeHidden();
    }

    // Select a live plane and verify live flight-strip dossier
    await page.evaluate(() => window.appBridge?.selectEntity("plane", 0, true));
    await expect(page.locator("#inspectorCard")).toBeVisible();
    await expect(page.locator("#inspPlaneState")).toBeVisible();

    // Select a live truck and verify freight/commuter vehicle dossier
    await page.evaluate(() => window.appBridge?.selectEntity("truck", 1, true));
    await expect(page.locator("#inspectorCard")).toBeVisible();
    await expect(page.locator("#inspTruckLeg")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("#inspectorCard")).toBeHidden();
    expect(pageErrors).toEqual([]);
  });

  test("Mouse wheel: proportional, controlled zoom sensitivity without wild jumps on discrete or continuous scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/index.html");
    await page.waitForFunction(
      () => Boolean(window.appBridge?.isReady()),
      null,
      { timeout: 20000 },
    );

    const initialZoom = await page.evaluate(
      () => window.appBridge?.getCamera().zoom ?? 1,
    );

    // Position mouse near center of canvas
    await page.mouse.move(640, 400);

    // Scroll down (zoom out) by standard notch (~100px)
    await page.mouse.wheel(0, 100);
    const zoomAfterOneNotchOut = await page.evaluate(
      () => window.appBridge?.getCamera().zoom ?? 1,
    );
    expect(zoomAfterOneNotchOut).toBeLessThan(initialZoom);
    // Single notch should be gentle (~6-10% decrease), not a massive jump
    const zoomRatioOut = zoomAfterOneNotchOut / initialZoom;
    expect(zoomRatioOut).toBeGreaterThan(0.88);
    expect(zoomRatioOut).toBeLessThan(0.96);

    // Scroll up (zoom in) by standard notch (-100px)
    await page.mouse.wheel(0, -100);
    const zoomRestored = await page.evaluate(
      () => window.appBridge?.getCamera().zoom ?? 1,
    );
    // Should be almost back to initial zoom (within 1%)
    expect(Math.abs(zoomRestored - initialZoom)).toBeLessThan(0.02);

    // Test continuous fine scrolling (e.g. 5 fine trackpad events of deltaY: 20)
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 20);
    }
    const zoomAfterFineScroll = await page.evaluate(
      () => window.appBridge?.getCamera().zoom ?? 1,
    );
    // Total delta is 100, so zoom should match single notch zoom within tiny tolerance
    expect(Math.abs(zoomAfterFineScroll - zoomAfterOneNotchOut)).toBeLessThan(
      0.01,
    );
  });

  test("Mobile (390x844): collapses generator drawer on boot, toggles drawer, and switches solver engines", async ({
    page,
  }) => {
    /** @type {string[]} */
    const pageErrors = [];
    await page.setViewportSize({ width: 390, height: 844 });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/index.html");
    await page.waitForFunction(
      () => Boolean(window.appBridge?.isReady()),
      null,
      {
        timeout: 20000,
      },
    );

    // Drawer starts collapsed on mobile (< 768px)
    await expect(page.locator("#generatorDrawer")).toBeHidden();

    // Open drawer, switch to Compact scale and Quilez Erosion, and verify rebuild
    await page.locator("#toggleDrawerBtn").click();
    await expect(page.locator("#generatorDrawer")).toBeVisible();

    await page.locator("#worldSizeSelect").selectOption("compact");
    await expect(page.locator("#telemetryGridLabel")).toContainText(
      "240×150 Grid",
      { timeout: 15000 },
    );

    await page.locator("#terrainAlgoSelect").selectOption("quilez-erosion");
    await expect(page.locator("#pipelineLog")).toContainText(
      "Quilez Derivative-Eroded fBm",
      { timeout: 15000 },
    );

    expect(pageErrors).toEqual([]);
  });

  test("Deep Linking & History: hydrates all 4 domains from URL query, commits user changes, and supports Back/Forward navigation", async ({
    page,
  }) => {
    /** @type {string[]} */
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.setViewportSize({ width: 1600, height: 1000 });

    const deepUrl =
      "/?seed=VALLEY-618&size=compact&arch=island-hopper&terrain=quilez-erosion&hydro=d8-strahler&water=62&towns=16&density=180&airports=5&wind=2&ramps=0&layer=rci&speed=2.5&drawer=0&cx=120.5&cy=75.0&z=1.85&inspect=town:0";

    await page.goto(deepUrl);

    // Wait for world build and hydration
    await page.waitForFunction(
      () => {
        const summary = window.appBridge?.getWorldSummary();
        return Boolean(
          window.appBridge?.isReady() &&
          summary &&
          summary.towns &&
          summary.towns.length > 0,
        );
      },
      null,
      { timeout: 20000 },
    );

    expect(pageErrors).toEqual([]);

    // 1. Verify Map Gen Inputs
    await expect(page.locator("#seedInput")).toHaveValue("VALLEY-618");
    await expect(page.locator("#worldSizeSelect")).toHaveValue("compact");
    await expect(page.locator("#archetypeSelect")).toHaveValue("island-hopper");
    await expect(page.locator("#terrainAlgoSelect")).toHaveValue(
      "quilez-erosion",
    );
    await expect(page.locator("#hydrologyAlgoSelect")).toHaveValue(
      "d8-strahler",
    );
    await expect(page.locator("#sliderWater")).toHaveValue("62");
    await expect(page.locator("#sliderTowns")).toHaveValue("16");
    await expect(page.locator("#sliderDensity")).toHaveValue("180");
    await expect(page.locator("#sliderAirports")).toHaveValue("5");
    await expect(page.locator("#sliderWind")).toHaveValue("2");
    expect(await page.locator("#toggleInterRamps").isChecked()).toBe(false);

    // 2. Verify View State & ARIA Attributes
    const activeLayer = await page.evaluate(() =>
      window.appBridge?.getActiveLayer(),
    );
    expect(activeLayer).toBe("rci");
    await expect(page.locator('.layer-btn[data-layer="rci"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await expect(page.locator('.speed-btn[data-speed="2.5"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Drawer is closed per drawer=0
    await expect(page.locator("#generatorDrawer")).toBeHidden();
    await expect(page.locator("#toggleDrawerBtn")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // 3. Verify Camera Coordinates
    const cam = await page.evaluate(
      () => window.appBridge?.getCamera() ?? null,
    );
    expect(cam).not.toBeNull();
    if (cam) {
      expect(Math.abs(cam.cx - 120.5)).toBeLessThan(0.5);
      expect(Math.abs(cam.cy - 75.0)).toBeLessThan(0.5);
      expect(Math.abs(cam.zoom - 1.85)).toBeLessThan(0.05);
    }

    // 4. Verify Inspected Entity Dossier
    const inspector = page.locator("#inspectorCard");
    await expect(inspector).toBeVisible();
    await expect(inspector).not.toHaveAttribute("inert");
    await expect(page.locator("#inspBadge")).toContainText("TIER");

    // 5. Reactive URL Synchronization: toggle drawer removes drawer=0 (default on desktop)
    await page.locator("#toggleDrawerBtn").click();
    await expect(page.locator("#generatorDrawer")).toBeVisible();
    expect(page.url()).not.toContain("drawer=0");

    // Switch view layer inside open drawer commits layer=aesthetic (omitted by default)
    await page.locator('.layer-btn[data-layer="aesthetic"]').click();
    expect(page.url()).not.toContain("layer=rci");

    // Close drawer again: commits drawer=0
    await page.locator("#toggleDrawerBtn").click();
    await expect(page.locator("#generatorDrawer")).toBeHidden();
    expect(page.url()).toContain("drawer=0");

    // 6. Navigation: submitting a new seed pushes a history state
    await page.locator("#seedInput").fill("DELTA-777");
    await page.locator("#seedInput").press("Enter");
    await page.waitForFunction(
      () => window.appBridge?.getWorldSummary()?.seed === "DELTA-777",
      null,
      { timeout: 15000 },
    );
    expect(page.url()).toContain("seed=DELTA-777");

    // 7. Browser Back Navigation (popstate) restores previous world & controls
    await page.goBack();
    await page.waitForFunction(
      () => window.appBridge?.getWorldSummary()?.seed === "VALLEY-618",
      null,
      { timeout: 15000 },
    );
    expect(page.url()).toContain("seed=VALLEY-618");
    await expect(page.locator("#seedInput")).toHaveValue("VALLEY-618");

    // 8. Browser Forward Navigation restores DELTA-777
    await page.goForward();
    await page.waitForFunction(
      () => window.appBridge?.getWorldSummary()?.seed === "DELTA-777",
      null,
      { timeout: 15000 },
    );
    expect(page.url()).toContain("seed=DELTA-777");
    await expect(page.locator("#seedInput")).toHaveValue("DELTA-777");

    expect(pageErrors).toEqual([]);
  });

  test("Deep link with explicit camera + live plane preserves explicit camera without yanking", async ({
    page,
  }) => {
    /** @type {string[]} */
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(
      "/?seed=OTTD-METRO-84&cx=150&cy=100&z=1.75&inspect=plane:0",
    );
    await page.waitForFunction(
      () => Boolean(window.appBridge?.isReady()),
      null,
      { timeout: 20000 },
    );

    await expect(page.locator("#inspectorCard")).toBeVisible();
    await page.evaluate(async () => {
      await window.appBridge?.stepSimulation(20, 1 / 30, 1.0);
    });

    const cam = await page.evaluate(
      () => window.appBridge?.getCamera() ?? null,
    );
    expect(cam).not.toBeNull();
    if (cam) {
      expect(Math.abs(cam.cx - 150)).toBeLessThan(0.5);
      expect(Math.abs(cam.cy - 100)).toBeLessThan(0.5);
      expect(Math.abs(cam.zoom - 1.75)).toBeLessThan(0.05);
    }

    expect(pageErrors).toEqual([]);
  });
});
