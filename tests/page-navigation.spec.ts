import { test, expect } from "@playwright/test";

test("test", async ({ page }) => {
  // @say Go to tailwindcss.com
  await page.goto("https://tailwindcss.com/");
  // @say click search button and input the keyword
  await page.getByRole("button", { name: "Quick search ⌘K" }).click();
  await page.getByRole("searchbox", { name: "Search" }).fill("shadow");
  await page.getByRole("searchbox", { name: "Search" }).press("ArrowDown");
  await page.getByRole("searchbox", { name: "Search" }).press("ArrowDown");
  await page.getByRole("searchbox", { name: "Search" }).press("ArrowDown");
  // @say press enter to search
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");

  // @say you can also use keyboard shortcut
  await page.locator("body").press("ControlOrMeta+k");
  await page.getByRole("searchbox", { name: "Search" }).fill("flex");
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
});
