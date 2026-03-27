import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { getProvider } from "./tts";

const testFile = process.argv[2];
if (!testFile) {
  console.error("Usage: pnpm demo <test-file>");
  process.exit(1);
}

const testPath = path.resolve(testFile);
const testName = path.basename(testFile, ".spec.ts");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-"));
const outputDir = path.resolve("demo-output");
const ACTION_FREEZE_S = 0.5;
const ENC = "-c:v libx264 -preset fast -pix_fmt yuv420p -r 25";

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
  const dur = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${p}`).toString().trim();
  audioFiles.push(p);
  audioDurMs.push(parseFloat(dur) * 1000);
}

// 3. Run original test unmodified with video + trace
const testResultsDir = path.join(tmpDir, "test-results");
const configPath = path.join(tmpDir, "playwright.config.ts");
fs.writeFileSync(configPath, `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '${path.dirname(testPath)}',
  timeout: 120000,
  use: {
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    viewport: { width: 1280, height: 720 },
    trace: 'on',
  },
  projects: [{ name: 'chromium', use: { channel: 'chromium' } }],
  reporter: 'list',
  outputDir: '${testResultsDir}',
});
`);

console.log("Running test...");
try {
  execSync(`npx playwright test ${path.basename(testFile)} --config=${configPath}`, {
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
  execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${videoPath}`).toString().trim()
);

// 5. Parse trace for action timestamps with source lines
const traceDir = path.join(tmpDir, "trace");
fs.mkdirSync(traceDir);
execSync(`unzip -o ${tracePath} -d ${traceDir}`, { stdio: "pipe" });

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
    const frame = e.stack.find((s: any) => s.file === testPath);
    if (frame) stepToLine.set(e.stepId, frame.line);
  }
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

// 6. Build freeze points: @say (before action) + action result (after action)
type FreezePoint = { timeS: number; durS: number; sayIndex?: number };
const freezePoints: FreezePoint[] = [];

for (const say of sayComments) {
  // Find first action on a line after this @say
  const action = traceActions.filter((a) => a.line > say.line).sort((a, b) => a.line - b.line)[0];
  if (action) {
    freezePoints.push({ timeS: action.startS, durS: audioDurMs[say.index] / 1000, sayIndex: say.index });
  }
}

for (const action of traceActions) {
  freezePoints.push({ timeS: action.endS, durS: ACTION_FREEZE_S });
}

// Sort by time, skip points too close together
freezePoints.sort((a, b) => a.timeS - b.timeS);
const filtered = freezePoints.filter((p, i) => i === 0 || p.timeS - freezePoints[i - 1].timeS > 0.02);

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
    execSync(`ffmpeg -y -i ${videoPath} -ss ${cursor} -to ${t} ${ENC} -an ${f}`, { stdio: "pipe" });
    segments.push({ file: f, duration: t - cursor });
  }

  const frameFile = path.join(segDir, `${segNum}-frame.png`);
  const freezeFile = path.join(segDir, `${String(segNum++).padStart(3, "0")}-f.mp4`);
  execSync(`ffmpeg -y -ss ${t} -i ${videoPath} -frames:v 1 ${frameFile}`, { stdio: "pipe" });
  execSync(`ffmpeg -y -loop 1 -i ${frameFile} -t ${fp.durS} ${ENC} -an ${freezeFile}`, { stdio: "pipe" });
  segments.push({ file: freezeFile, duration: fp.durS, sayIndex: fp.sayIndex });
  cursor = t;
}

if (vidDurS > cursor + 0.04) {
  const f = path.join(segDir, `${String(segNum++).padStart(3, "0")}-v.mp4`);
  execSync(`ffmpeg -y -i ${videoPath} -ss ${cursor} -to ${vidDurS} ${ENC} -an ${f}`, { stdio: "pipe" });
  segments.push({ file: f, duration: vidDurS - cursor });
}

// 8. Concat segments
const concatList = path.join(tmpDir, "concat.txt");
fs.writeFileSync(concatList, segments.map((s) => `file '${s.file}'`).join("\n"));
const concatFile = path.join(tmpDir, "concat.mp4");
execSync(`ffmpeg -y -f concat -safe 0 -i ${concatList} -c copy ${concatFile}`, { stdio: "pipe" });

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

  const inputs = positions.map((a) => `-i ${audioFiles[a.sayIndex]}`).join(" ");
  const parts = positions.map((a, i) => `[${i + 1}]adelay=${a.posMs}|${a.posMs}[a${i}]`);
  const mix = positions.map((_, i) => `[a${i}]`).join("");
  const filter = `${parts.join("; ")}; ${mix}amix=inputs=${positions.length}:normalize=0[aout]`;
  execSync(
    `ffmpeg -y -i ${concatFile} ${inputs} -filter_complex "${filter}" -map 0:v -map "[aout]" -c:v copy ${outputPath}`,
    { stdio: "inherit" }
  );
} else {
  fs.copyFileSync(concatFile, outputPath);
}

// 10. Cleanup
fs.rmSync(tmpDir, { recursive: true });
console.log(`\nDone! Output: ${outputPath}`);
