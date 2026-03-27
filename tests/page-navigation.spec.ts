import { test, expect } from "@playwright/test";

test("test", async ({ page }) => {
  // @say Go to tailwindcss.com
  await page.goto("https://tailwindcss.com/");

  // @say click search button and input the keyword
  await page.getByRole("button", { name: "Quick search ⌘K" }).click();
  await page.getByRole("searchbox", { name: "Search" }).fill("shadow");
  await page.getByRole("link", { name: "text-shadow", exact: true }).waitFor();

  await page.getByRole("searchbox", { name: "Search" }).press("ArrowDown");
  await page.getByRole("searchbox", { name: "Search" }).press("ArrowDown");
  await page.getByRole("searchbox", { name: "Search" }).press("ArrowDown");
  // @say press enter to search
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");

  // @say you can also use keyboard shortcut
  await page.locator("body").press("ControlOrMeta+k");
  await page.getByRole("searchbox", { name: "Search" }).fill("flex");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "flex", exact: true }).waitFor();
  await page.keyboard.press("Enter");

  await page.waitForTimeout(2000);
});
