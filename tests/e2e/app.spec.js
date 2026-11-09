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

    // Wait for initial Dual-Worker world build to populate window.currentWorld
    await page.waitForFunction(
      () => Boolean(window.currentWorld && window.simulator && window.renderer),
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

    // Verify offscreen terrain bitmap was transferred to renderer
    const hasOffscreenTerrain = await page.evaluate(() =>
      Boolean(window.renderer?.offscreenTerrain),
    );
    expect(hasOffscreenTerrain).toBe(true);

    // Toggling Stage 9 Intermediate Expressway Ramps hits S1–S8 cache
    await page.locator("#toggleInterRamps").click();
    await expect(page.locator("#genTimeBadge")).toContainText("Cached S1–S8", {
      timeout: 10000,
    });

    // Switch through all 6 View Layers and verify renderer.activeLayer updates cleanly
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
      const activeLayer = await page.evaluate(
        () => window.renderer.activeLayer,
      );
      expect(activeLayer).toBe(layer);
    }

    // Open Entity Inspector on primary airport and navigate to host municipality & facility
    await page.evaluate(() => {
      const ap = window.currentWorld?.airports[0];
      if (ap) window.openEntityInspector("airport", ap, true);
    });
    await expect(page.locator("#inspectorCard")).toBeVisible();
    await expect(page.locator("#inspCode")).toContainText("IATA");

    const townJumpBtn = page.locator("#inspBody [data-jump-town]").first();
    if ((await townJumpBtn.count()) > 0) {
      await townJumpBtn.click();
      await expect(page.locator("#inspBadge")).toContainText("TIER");
    }

    // Pressing Escape closes the inspector card
    await page.keyboard.press("Escape");
    await expect(page.locator("#inspectorCard")).toBeHidden();
    expect(pageErrors).toEqual([]);
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
      () => Boolean(window.currentWorld && window.simulator),
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
});
