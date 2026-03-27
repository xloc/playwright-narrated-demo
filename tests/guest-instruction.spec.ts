import { test, expect } from "@playwright/test";

test("guest view demo", async ({ page }) => {
  // the next line means: don't include the next block of code (separated by an empty line) in the generated video
  // @block-exclude
  await page.goto("https://172.16.80.106/");
  await page.getByRole("textbox", { name: "Username" }).click();
  await page.getByRole("textbox", { name: "Username" }).fill("g1");
  await page.getByRole("textbox", { name: "Password" }).click();
  await page.getByRole("textbox", { name: "Password" }).fill("['");
  await page.getByRole("button", { name: "Log In" }).click();
  await page.getByText("ins aaa 10.1.1.1 Unix Account").click();

  // make sure to support contiguous multi-line `@say` like below
  // also it result in an ffmpeg error when `@say` before an `waitForTimeout`
  // Error opening input file [...]\.demo-cache\playwright\run-JWRD61\segments\13-frame.png.
  // Error opening input files: No such file or directory

  // @say The guest instruction feature allows administrators to set up per-secret descriptions.
  // @say The instructions are shown to guest and invited users in their secret grid view.
  await page.waitForTimeout(2000);
});

// when multiple tests are available, they need to be chained together in the final video
test("setup instruction profile", async ({ page }) => {
  // @say To configure guest instructions, an instruction profile should be created and then attached to secrets.
  await page.goto("https://172.16.80.106/remote/login?lang=en");
  await page.getByRole("textbox", { name: "Username" }).click();
  await page.getByRole("textbox", { name: "Username" }).fill("admin");
  await page.getByRole("textbox", { name: "Password" }).click();
  await page.getByRole("textbox", { name: "Password" }).fill("['");
  await page.getByRole("button", { name: "Log In" }).click();
  await page.getByRole("button", { name: "user-lock icon Secrets" }).click();
  await page
    .getByRole("button", { name: "user-cog icon Secret Settings" })
    .click();
  await page.getByRole("link", { name: "common::instruction_profile" }).click();
  // @say It is designed this way so that the instructions can be reused in multiple secrets.
  // @say When editing the rich-text content, text can be styled in the following ways:
  await page.getByText("ins1").dblclick();
  await page.waitForTimeout(2000);
});
