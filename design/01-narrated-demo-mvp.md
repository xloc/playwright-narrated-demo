# Slice 01: End-to-End Narrated Demo

## Goal

Run a Playwright test with `// @say` comments and produce a single `.mp4` where each comment is spoken aloud *before* its corresponding browser action.

## User-Facing Behaviour

1. User runs: `pnpm demo tests/page-navigation.spec.ts`
2. A browser opens and executes the test while recording the viewport
3. When the test reaches a `// @say Go to tailwindcss.com` comment, the narration for that text is produced and placed in the timeline *before* the action that follows
4. While narration is playing, the video freezes on the current frame so the viewer can listen without the screen changing
5. After each action completes, the video freezes for 0.5s so the result is visible
6. After the test finishes, a single `./demo-output/page-navigation.mp4` is produced with the video and voiceover merged
7. The narration uses macOS `say` command

## Definition of Done

- `pnpm demo tests/page-navigation.spec.ts` runs without errors
- Output file exists at `./demo-output/page-navigation.mp4`
- Playing the file: you hear each `@say` comment spoken before its action happens on screen
- Video and audio are in sync
- Output plays in QuickTime and VLC

## Implementation

Single file: `src/demo.ts`. Pipeline:

```
parse @say comments → generate audio with `say` + get durations via `ffprobe`
→ run test with Playwright (video + trace)
→ parse trace for action timestamps + source line numbers
→ map @say comments to actions by line number → build freeze points
→ split video at freeze points, create frozen frame segments
→ concat all segments → overlay audio at correct positions → output .mp4
```

### Key decisions

**Timestamps from trace, not from test instrumentation.** Playwright's `test.trace` provides source line numbers for each action; `0-trace.trace` provides browser-side monotonic timestamps. These are joined by `stepId` and mapped to video time using the context creation time as t0.

**Post-processing for freeze frames.** The test runs at full speed (fast recording). Freeze frames are inserted in post-processing by splitting the video at action boundaries and inserting still-image segments.
