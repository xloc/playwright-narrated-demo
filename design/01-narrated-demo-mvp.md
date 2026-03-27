# Slice 01: End-to-End Narrated Demo

## Goal

Run a Playwright test with `// @say` comments and produce a single `.mp4` where each comment is spoken aloud *before* its corresponding browser action.

## User-Facing Behaviour

1. User runs: `pnpm demo tests/page-navigation.spec.ts`
2. A browser opens and executes the test while recording the viewport
3. When the test reaches a `// @say Go to tailwindcss.com` comment, the narration for that text is produced and placed in the timeline *before* the action that follows
4. While narration is playing, the video freezes on the current frame so the viewer can listen without the screen changing
5. Each action's result is visible for at least 1 second before the next narration or action begins
6. After the test finishes, a single `./demo-output/page-navigation.mp4` is produced with the video and voiceover merged
5. The narration uses macOS `say` command

## Definition of Done

- `pnpm demo tests/page-navigation.spec.ts` runs without errors
- Output file exists at `./demo-output/page-navigation.mp4`
- Playing the file: you hear each `@say` comment spoken before its action happens on screen
- Video and audio are in sync
- Output plays in QuickTime and VLC

## Open Questions

- How to capture the timestamp of each `@say` comment during the test run? Options include: instrumenting the test at runtime, parsing + wrapping the test file, or using Playwright's tracing/event hooks. Decision should go in `01-implementation-details.md` if needed.
