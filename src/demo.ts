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
const FRAME_RATE = 25;
const ENC = `-c:v libx264 -preset fast -pix_fmt yuv420p -r ${FRAME_RATE}`;

const q = (p: string) => `"${p}"`;
const norm = (p: string) => p.replace(/\\/g, "/");
// Snap to video frame grid so every timestamp maps to an actual frame
const snap = (t: number) => Math.floor(t * FRAME_RATE) / FRAME_RATE;

// 1. Parse source
const source = fs.readFileSync(testPath, "utf-8");
const sourceLines = source.split("\n");

// @say comments (each gets its own TTS audio)
const sayComments: { text: string; line: number; index: number }[] = [];
sourceLines.forEach((l, i) => {
  const m = l.match(/\/\/ @say (.+)/);
  if (m) sayComments.push({ text: m[1], line: i + 1, index: sayComments.length });
});
if (!sayComments.length) {
  console.error("No // @say comments found");
  process.exit(1);
}

// @block-exclude ranges (from marker to next empty line)
const excludedLines = new Set<number>();
{
  let inExclude = false;
  sourceLines.forEach((l, i) => {
    if (l.trim() === "// @block-exclude") {
      inExclude = true;
      return;
    }
    if (inExclude) {
      if (l.trim() === "") inExclude = false;
      else excludedLines.add(i + 1);
    }
  });
}

// Test block boundaries (for multi-test chaining)
const testBlocks: { title: string; startLine: number; endLine: number }[] = [];
{
  let depth = 0;
  let current: { title: string; startLine: number } | undefined;
  sourceLines.forEach((l, i) => {
    if (!current) {
      const m = l.match(/^\s*test\s*(?:\.\w+)?\s*\(\s*["'`](.+?)["'`]/);
      if (m) {
        current = { title: m[1], startLine: i + 1 };
        depth = 0;
      }
    }
    if (current) {
      depth += (l.match(/\{/g) || []).length;
      depth -= (l.match(/\}/g) || []).length;
      if (depth <= 0) {
        testBlocks.push({ ...current, endLine: i + 1 });
        current = undefined;
      }
    }
  });
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

// 3. Run tests with video + trace
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

// 4. Find test results (video + trace per test)
function findFile(dir: string, ext: string): string | undefined {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(full, ext); if (f) return f; }
    else if (e.name.endsWith(ext)) return full;
  }
}

type TestResult = { videoPath: string; tracePath: string; dirName: string };
const testResults: TestResult[] = [];
for (const entry of fs.readdirSync(testResultsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const subdir = path.join(testResultsDir, entry.name);
  const video = findFile(subdir, ".webm");
  const trace = findFile(subdir, "trace.zip");
  if (video && trace) testResults.push({ videoPath: video, tracePath: trace, dirName: entry.name });
}
if (!testResults.length) { console.error("No test results found"); process.exit(1); }

// Match test results to test blocks by title slug
function slugify(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }

const orderedResults = testBlocks.length === testResults.length
  ? testBlocks.map((block) => {
      const slug = slugify(block.title);
      return testResults.find((r) => r.dirName.startsWith(slug)) || testResults[0];
    })
  : testResults;

// Assign @say and excludedLines per test block
const testsToProcess = orderedResults.map((result, i) => {
  const block = testBlocks[i];
  return {
    ...result,
    says: block ? sayComments.filter((s) => s.line >= block.startLine && s.line <= block.endLine) : sayComments,
    excLines: block ? new Set([...excludedLines].filter((l) => l >= block.startLine && l <= block.endLine)) : excludedLines,
  };
});

// 5. Process each test
function parseTrace(file: string) {
  return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

type TraceAction = { line: number; startS: number; endS: number };
type FreezePoint = { timeS: number; durS: number; sayIndex?: number };
type Segment = { file: string; duration: number; sayIndex?: number };
type TimeRange = { startS: number; endS: number };

const perTestOutputs: string[] = [];

for (let ti = 0; ti < testsToProcess.length; ti++) {
  const { videoPath, tracePath, says, excLines } = testsToProcess[ti];
  console.log(`\nProcessing test ${ti + 1}/${testsToProcess.length}...`);

  const vidDurS = snap(parseFloat(
    execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${q(videoPath)}`).toString().trim()
  ));

  // Parse trace
  const traceDir = path.join(tmpDir, `trace-${ti}`);
  fs.mkdirSync(traceDir);
  if (process.platform === "win32") {
    execSync(`powershell -Command "Expand-Archive -Force -Path '${tracePath}' -DestinationPath '${traceDir}'"`, { stdio: "pipe" });
  } else {
    execSync(`unzip -o ${tracePath} -d ${traceDir}`, { stdio: "pipe" });
  }

  const testTrace = parseTrace(path.join(traceDir, "test.trace"));
  const ctxTrace = parseTrace(path.join(traceDir, "0-trace.trace"));
  const videoT0 = ctxTrace.find((e: any) => e.type === "context-options")!.monotonicTime;

  // Map stepId → source line
  const stepToLine = new Map<string, number>();
  for (const e of testTrace) {
    if (e.type === "before" && e.stack?.length) {
      const frame = e.stack.find((s: any) => norm(s.file) === norm(testPath));
      if (frame) stepToLine.set(e.stepId, frame.line);
    }
  }
  console.log(`stepToLine: ${stepToLine.size} entries`);

  // Collect trace actions
  const befores = new Map<string, any>();
  const traceActions: TraceAction[] = [];
  for (const e of ctxTrace) {
    if (e.type === "before" && e.stepId) befores.set(e.callId, e);
    if (e.type === "after" && befores.has(e.callId) && !e.error) {
      const b = befores.get(e.callId)!;
      const line = stepToLine.get(b.stepId);
      if (line) {
        traceActions.push({ line, startS: snap((b.startTime - videoT0) / 1000), endS: snap((e.endTime - videoT0) / 1000) });
      }
    }
  }
  console.log(`traceActions: ${JSON.stringify(traceActions)}`);

  // Compute excluded time ranges
  const excludedActions = traceActions.filter((a) => excLines.has(a.line));
  const excludeRanges: TimeRange[] = [];
  if (excludedActions.length) {
    let cur = { startS: excludedActions[0].startS, endS: excludedActions[0].endS };
    for (let i = 1; i < excludedActions.length; i++) {
      const a = excludedActions[i];
      if (a.startS <= cur.endS + 0.1) cur.endS = Math.max(cur.endS, a.endS);
      else { excludeRanges.push(cur); cur = { startS: a.startS, endS: a.endS }; }
    }
    excludeRanges.push(cur);
  }
  const isExcluded = (t: number) => excludeRanges.some((r) => t >= r.startS && t <= r.endS);

  // Build freeze points
  const freezePoints: FreezePoint[] = [];

  for (let si = 0; si < says.length; si++) {
    const say = says[si];
    // Find last line in contiguous @say group (so all @say in the group anchor to the same action)
    let lastLine = say.line;
    for (let j = si + 1; j < says.length && says[j].line === says[j - 1].line + 1; j++) {
      lastLine = says[j].line;
    }

    // First non-excluded action after the contiguous group
    const action = traceActions
      .filter((a) => a.line > lastLine && !excLines.has(a.line))
      .sort((a, b) => a.line - b.line)[0];

    if (action) {
      freezePoints.push({ timeS: action.startS, durS: audioDurMs[say.index] / 1000, sayIndex: say.index });
    } else {
      // Fallback: end of last non-excluded action before this @say, or near video start
      const preceding = traceActions.filter((a) => a.line <= say.line && !excLines.has(a.line));
      const fallbackT = preceding.length ? preceding[preceding.length - 1].endS : 0.5;
      freezePoints.push({ timeS: Math.min(fallbackT, vidDurS - 0.01), durS: audioDurMs[say.index] / 1000, sayIndex: say.index });
    }
  }

  for (const action of traceActions) {
    if (!isExcluded(action.endS)) {
      freezePoints.push({ timeS: action.endS, durS: ACTION_FREEZE_S });
    }
  }

  // Sort and filter: keep contiguous @say (both have sayIndex), dedupe @say vs action-end
  freezePoints.sort((a, b) => a.timeS - b.timeS || (a.sayIndex !== undefined ? -1 : 1));
  const filtered: FreezePoint[] = [];
  for (const p of freezePoints) {
    const prev = filtered[filtered.length - 1];
    if (!prev || p.timeS - prev.timeS > 0.02) {
      filtered.push(p);
    } else if (p.sayIndex !== undefined && prev.sayIndex !== undefined) {
      filtered.push(p); // keep both contiguous @say
    } else if (p.sayIndex !== undefined) {
      filtered[filtered.length - 1] = p;
    }
  }
  console.log(`freezePoints: ${filtered.length} (from ${freezePoints.length})`);

  // Build video segments
  console.log("Composing video...");
  const segDir = path.join(tmpDir, `segments-${ti}`);
  fs.mkdirSync(segDir);
  const segments: Segment[] = [];
  let cursor = 0;
  let segNum = 0;

  // Emit video from cursor to end, skipping excluded ranges
  function emitVideoTo(end: number) {
    for (const r of excludeRanges) {
      if (r.endS <= cursor || r.startS >= end) continue;
      const gapStart = Math.max(r.startS, cursor);
      if (gapStart > cursor + 0.04) {
        const f = path.join(segDir, `${String(segNum++).padStart(3, "0")}-v.mp4`);
        execSync(`ffmpeg -y -i ${q(videoPath)} -ss ${cursor} -to ${gapStart} ${ENC} -an ${q(f)}`, { stdio: "pipe" });
        segments.push({ file: f, duration: gapStart - cursor });
      }
      cursor = Math.max(cursor, r.endS);
    }
    if (end > cursor + 0.04) {
      const f = path.join(segDir, `${String(segNum++).padStart(3, "0")}-v.mp4`);
      execSync(`ffmpeg -y -i ${q(videoPath)} -ss ${cursor} -to ${end} ${ENC} -an ${q(f)}`, { stdio: "pipe" });
      segments.push({ file: f, duration: end - cursor });
    }
    cursor = Math.max(cursor, end);
  }

  for (const fp of filtered) {
    const t = Math.min(fp.timeS, vidDurS);
    if (isExcluded(t)) continue;

    emitVideoTo(t);

    const frameFile = path.join(segDir, `${segNum}-frame.png`);
    const freezeFile = path.join(segDir, `${String(segNum++).padStart(3, "0")}-f.mp4`);
    // Input seeking is fast but can miss frames; fall back to output seeking
    execSync(`ffmpeg -y -ss ${t} -i ${q(videoPath)} -frames:v 1 ${q(frameFile)}`, { stdio: "pipe" });
    if (!fs.existsSync(frameFile)) {
      execSync(`ffmpeg -y -i ${q(videoPath)} -ss ${t} -frames:v 1 ${q(frameFile)}`, { stdio: "pipe" });
    }
    execSync(`ffmpeg -y -loop 1 -i ${q(frameFile)} -t ${fp.durS} ${ENC} -an ${q(freezeFile)}`, { stdio: "pipe" });
    segments.push({ file: freezeFile, duration: fp.durS, sayIndex: fp.sayIndex });
  }

  emitVideoTo(vidDurS);

  if (!segments.length) { console.log("  No segments produced, skipping"); continue; }

  // Concat segments
  const concatList = path.join(tmpDir, `concat-${ti}.txt`);
  fs.writeFileSync(concatList, segments.map((s) => `file '${norm(s.file)}'`).join("\n"));
  const concatFile = path.join(tmpDir, `concat-${ti}.mp4`);
  execSync(`ffmpeg -y -f concat -safe 0 -i ${q(concatList)} -c copy ${q(concatFile)}`, { stdio: "pipe" });

  // Overlay audio
  const testOutput = path.join(tmpDir, `test-${ti}.mp4`);
  const audioSegs = segments.filter((s) => s.sayIndex !== undefined);
  if (audioSegs.length) {
    let cumDur = 0;
    const positions: { sayIndex: number; posMs: number }[] = [];
    for (const seg of segments) {
      if (seg.sayIndex !== undefined) positions.push({ sayIndex: seg.sayIndex, posMs: Math.round(cumDur * 1000) });
      cumDur += seg.duration;
    }

    const inputs = positions.map((a) => `-i ${q(audioFiles[a.sayIndex])}`).join(" ");
    const parts = positions.map((a, i) => `[${i + 1}]adelay=${a.posMs}|${a.posMs}[a${i}]`);
    const mix = positions.map((_, i) => `[a${i}]`).join("");
    const filter = `${parts.join("; ")}; ${mix}amix=inputs=${positions.length}:normalize=0[aout]`;
    execSync(
      `ffmpeg -y -i ${q(concatFile)} ${inputs} -filter_complex "${filter}" -map 0:v -map "[aout]" -c:v copy ${q(testOutput)}`,
      { stdio: "pipe" }
    );
  } else {
    fs.copyFileSync(concatFile, testOutput);
  }
  perTestOutputs.push(testOutput);
}

// 6. Chain per-test outputs into final video
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `${testName}.mp4`);

if (perTestOutputs.length === 1) {
  fs.renameSync(perTestOutputs[0], outputPath);
} else {
  const chainList = path.join(tmpDir, "chain.txt");
  fs.writeFileSync(chainList, perTestOutputs.map((f) => `file '${norm(f)}'`).join("\n"));
  execSync(`ffmpeg -y -f concat -safe 0 -i ${q(chainList)} -c copy ${q(outputPath)}`, { stdio: "pipe" });
}

// 7. Cleanup
fs.rmSync(tmpDir, { recursive: true });
console.log(`\nDone! Output: ${outputPath}`);
