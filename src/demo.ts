import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { getProvider } from "./tts";

const testFile = process.argv[2];
if (!testFile) {
  console.error("Usage: pnpm demo <test-file>");
  process.exit(1);
}

const testPath = path.resolve(testFile);
const testName = path.basename(testFile, ".spec.ts");
const tmpBase = path.resolve(".demo-cache", "playwright");
fs.mkdirSync(tmpBase, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(tmpBase, "run-"));
const outputDir = path.resolve("demo-output");
const ACTION_FREEZE_S = 0.5;
const ENC = "-c:v libx264 -preset fast -pix_fmt yuv420p -r 25";

// Quote paths for shell commands (handles spaces and backslashes)
const q = (p: string) => `"${p}"`;
// Normalize path separators for comparison (trace files always use forward slashes)
const norm = (p: string) => p.replace(/\\/g, "/");

// 1. Parse @say comments with line numbers
const source = fs.readFileSync(testPath, "utf-8");
const sourceLines = source.split("\n");
const sayComments: { text: string; line: number; index: number }[] = [];
sourceLines.forEach((l, i) => {
  const m = l.match(/\/\/ @say (.+)/);
  if (m) sayComments.push({ text: m[1], line: i + 1, index: sayComments.length });
});
if (!sayComments.length) {
  console.error("No // @say comments found");
  process.exit(1);
}

// 2. Generate audio
const tts = getProvider();
const audioFiles: string[] = [];
const audioDurMs: number[] = [];
for (let i = 0; i < sayComments.length; i++) {
  const p = path.join(tmpDir, `say-${i}${tts.ext}`);
  tts.generate(sayComments[i].text, p);
  const dur = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${q(p)}`).toString().trim();
  audioFiles.push(p);
  audioDurMs.push(parseFloat(dur) * 1000);
}

// 3. Run original test unmodified with video + trace
const testResultsDir = path.join(tmpDir, "test-results");
const configPath = path.join(tmpDir, "playwright.config.ts");
const userConfig = path.resolve("playwright.config.ts");
fs.writeFileSync(configPath, `import { defineConfig } from '@playwright/test';
import base from ${JSON.stringify(userConfig)};
export default defineConfig(base, {
  testDir: ${JSON.stringify(path.dirname(testPath))},
  timeout: 120000,
  use: {
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    viewport: { width: 1280, height: 720 },
    trace: 'on',
  },
  projects: [{ name: 'chromium', use: { channel: 'chromium' } }],
  reporter: 'list',
  outputDir: ${JSON.stringify(testResultsDir)},
});
`);

console.log("Running test...");
try {
  execSync(`npx playwright test ${path.basename(testFile)} --config=${q(configPath)}`, {
    stdio: "inherit",
    cwd: path.dirname(testPath),
  });
} catch {
  console.error("Test failed");
  process.exit(1);
}

// 4. Find video and trace
function findFile(dir: string, ext: string): string | undefined {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(full, ext); if (f) return f; }
    else if (e.name.endsWith(ext)) return full;
  }
}

const videoPath = findFile(testResultsDir, ".webm");
const tracePath = findFile(testResultsDir, "trace.zip");
if (!videoPath || !tracePath) { console.error("Missing video or trace"); process.exit(1); }

const vidDurS = parseFloat(
  execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${q(videoPath)}`).toString().trim()
);

// 5. Parse trace for action timestamps with source lines
const traceDir = path.join(tmpDir, "trace");
fs.mkdirSync(traceDir);
if (process.platform === "win32") {
  execSync(`powershell -Command "Expand-Archive -Force -Path '${tracePath}' -DestinationPath '${traceDir}'"`, { stdio: "pipe" });
} else {
  execSync(`unzip -o ${tracePath} -d ${traceDir}`, { stdio: "pipe" });
}

function parseTrace(file: string) {
  return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// test.trace has source line info; 0-trace.trace has browser-side timing
const testTrace = parseTrace(path.join(traceDir, "test.trace"));
const ctxTrace = parseTrace(path.join(traceDir, "0-trace.trace"));

// Video t0 = context creation monotonic time (browser side)
const videoT0 = ctxTrace.find((e: any) => e.type === "context-options")!.monotonicTime;

// Map stepId → source line from test.trace
const stepToLine = new Map<string, number>();
for (const e of testTrace) {
  if (e.type === "before" && e.stack?.length) {
    const frame = e.stack.find((s: any) => norm(s.file) === norm(testPath));
    if (frame) stepToLine.set(e.stepId, frame.line);
  }
}
console.log(`stepToLine: ${stepToLine.size} entries`);
if (!stepToLine.size) {
  // Debug: show what paths are in the trace vs what we're looking for
  const tracePaths = new Set<string>();
  for (const e of testTrace) {
    if (e.type === "before" && e.stack?.length) {
      for (const s of e.stack) tracePaths.add(s.file);
    }
  }
  console.log(`  trace paths: ${[...tracePaths].join(", ")}`);
  console.log(`  looking for: ${norm(testPath)}`);
}

// Collect action start/end times from context trace, join with source lines
type TraceAction = { line: number; startS: number; endS: number };
const befores = new Map<string, any>();
const traceActions: TraceAction[] = [];

for (const e of ctxTrace) {
  if (e.type === "before" && e.stepId) befores.set(e.callId, e);
  if (e.type === "after" && befores.has(e.callId) && !e.error) {
    const b = befores.get(e.callId)!;
    const line = stepToLine.get(b.stepId);
    if (line) {
      traceActions.push({
        line,
        startS: (b.startTime - videoT0) / 1000,
        endS: (e.endTime - videoT0) / 1000,
      });
    }
  }
}
console.log(`traceActions: ${JSON.stringify(traceActions)}`);

// 6. Build freeze points: @say (before action) + action result (after action)
type FreezePoint = { timeS: number; durS: number; sayIndex?: number };
const freezePoints: FreezePoint[] = [];

for (const say of sayComments) {
  // Find first action on a line after this @say
  const action = traceActions.filter((a) => a.line > say.line).sort((a, b) => a.line - b.line)[0];
  if (action) {
    freezePoints.push({ timeS: action.startS, durS: audioDurMs[say.index] / 1000, sayIndex: say.index });
  } else {
    console.log(`  @say "${say.text}" (line ${say.line}): no matching action found`);
  }
}

for (const action of traceActions) {
  freezePoints.push({ timeS: action.endS, durS: ACTION_FREEZE_S });
}
console.log(`freezePoints (before filter): ${JSON.stringify(freezePoints)}`);

// Sort by time; when close together, prefer @say freezes over action-end freezes
freezePoints.sort((a, b) => a.timeS - b.timeS || (a.sayIndex !== undefined ? -1 : 1));
const filtered: FreezePoint[] = [];
for (const p of freezePoints) {
  const prev = filtered[filtered.length - 1];
  if (!prev || p.timeS - prev.timeS > 0.02) {
    filtered.push(p);
  } else if (p.sayIndex !== undefined && prev.sayIndex === undefined) {
    // Replace action-end freeze with @say freeze
    filtered[filtered.length - 1] = p;
  }
}
console.log(`filtered freezePoints: ${JSON.stringify(filtered)}`);
console.log(`sayComments: ${JSON.stringify(sayComments)}`);
console.log(`audioDurMs: ${JSON.stringify(audioDurMs)}`);
console.log(`vidDurS: ${vidDurS}`);

// 7. Build video segments
console.log("Composing video...");
const segDir = path.join(tmpDir, "segments");
fs.mkdirSync(segDir);

type Segment = { file: string; duration: number; sayIndex?: number };
const segments: Segment[] = [];
let cursor = 0;
let segNum = 0;

for (const fp of filtered) {
  const t = Math.min(fp.timeS, vidDurS);

  if (t > cursor + 0.04) {
    const f = path.join(segDir, `${String(segNum++).padStart(3, "0")}-v.mp4`);
    execSync(`ffmpeg -y -i ${q(videoPath)} -ss ${cursor} -to ${t} ${ENC} -an ${q(f)}`, { stdio: "pipe" });
    segments.push({ file: f, duration: t - cursor });
  }

  const frameFile = path.join(segDir, `${segNum}-frame.png`);
  const freezeFile = path.join(segDir, `${String(segNum++).padStart(3, "0")}-f.mp4`);
  execSync(`ffmpeg -y -ss ${t} -i ${q(videoPath)} -frames:v 1 ${q(frameFile)}`, { stdio: "pipe" });
  execSync(`ffmpeg -y -loop 1 -i ${q(frameFile)} -t ${fp.durS} ${ENC} -an ${q(freezeFile)}`, { stdio: "pipe" });
  segments.push({ file: freezeFile, duration: fp.durS, sayIndex: fp.sayIndex });
  cursor = t;
}

if (vidDurS > cursor + 0.04) {
  const f = path.join(segDir, `${String(segNum++).padStart(3, "0")}-v.mp4`);
  execSync(`ffmpeg -y -i ${q(videoPath)} -ss ${cursor} -to ${vidDurS} ${ENC} -an ${q(f)}`, { stdio: "pipe" });
  segments.push({ file: f, duration: vidDurS - cursor });
}

// 8. Concat segments
const concatList = path.join(tmpDir, "concat.txt");
fs.writeFileSync(concatList, segments.map((s) => `file '${norm(s.file)}'`).join("\n"));
const concatFile = path.join(tmpDir, "concat.mp4");
execSync(`ffmpeg -y -f concat -safe 0 -i ${q(concatList)} -c copy ${q(concatFile)}`, { stdio: "pipe" });

// 9. Overlay audio
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `${testName}.mp4`);

const audioSegs = segments.filter((s) => s.sayIndex !== undefined);
if (audioSegs.length) {
  let cumDur = 0;
  const positions: { sayIndex: number; posMs: number }[] = [];
  for (const seg of segments) {
    if (seg.sayIndex !== undefined) {
      positions.push({ sayIndex: seg.sayIndex, posMs: Math.round(cumDur * 1000) });
    }
    cumDur += seg.duration;
  }

  const inputs = positions.map((a) => `-i ${q(audioFiles[a.sayIndex])}`).join(" ");
  const parts = positions.map((a, i) => `[${i + 1}]adelay=${a.posMs}|${a.posMs}[a${i}]`);
  const mix = positions.map((_, i) => `[a${i}]`).join("");
  const filter = `${parts.join("; ")}; ${mix}amix=inputs=${positions.length}:normalize=0[aout]`;
  execSync(
    `ffmpeg -y -i ${q(concatFile)} ${inputs} -filter_complex "${filter}" -map 0:v -map "[aout]" -c:v copy ${q(outputPath)}`,
    { stdio: "inherit" }
  );
} else {
  fs.copyFileSync(concatFile, outputPath);
}

// 10. Cleanup
fs.rmSync(tmpDir, { recursive: true });
console.log(`\nDone! Output: ${outputPath}`);
