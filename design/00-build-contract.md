# Build Contract: Demo Video Generator

## Goal

Build a CLI tool that runs a Playwright test script and produces a narrated demo video — browser viewport recording with TTS voiceover generated from `// @say` comments.

## User Stories

As a user, I can:

1. Run a single command that takes a `.spec.ts` file and outputs a narrated `.mp4` video
2. Hear TTS voiceover from `@say` comments synced to the browser actions, with configurable timing (before the action, or alongside it)
3. See actual browser interaction in the video (not screenshots)
4. Choose a TTS voice/provider

## Milestones

1. End-to-end working demo — narration *before* each action, macOS `say` for TTS
2. Add OpenAI TTS as an alternative provider
3. Add "alongside" narration mode (voice overlaps with the action)

## Definition of Done

- Running `pnpm demo <test-file>` produces a `.mp4` with synced voiceover
- Output video plays in standard players (QuickTime, VLC)
- Output goes to `./demo-output/<test-name>.mp4`

## Constraints

- TypeScript / Node.js (matches existing project)
- Use Playwright's built-in video recording
- FFmpeg for video/audio post-processing (assumed installed)

## Not Doing

- Real-time narration during recording (post-process only)
- Subtitle/caption overlay
- GUI or web UI
- Multi-browser output (one browser per run is fine)
- CI support
- Custom video resolution/quality settings beyond Playwright defaults
