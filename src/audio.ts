import { EdgeTTS } from "node-edge-tts";
import { copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, VoiceProfile } from "./config";
import type { TranslatedParagraph } from "./text";
import { splitForTts } from "./text";
import { ProgressBar } from "./progress";
import { buildTimeline, lyricsCues, prependLyricsTag, renderLrc, type AudioTimelineItem, type LyricsCue } from "./lyrics";
import { atomicWrite, readJson, writeJson } from "./state";

type AudioItem = { kind: string; text?: string; path: string };
type AudioSpec = { kind: string; text: string; profile: VoiceProfile };
type PlannedItem = { type: "audio"; spec: AudioSpec } | { type: "separator" };
type SynthesisResult = { path: string; cached: boolean };
type AudioManifest = {
  version: 4;
  mergeFingerprint: string;
  profiles: AppConfig["audio"]["profiles"];
  paragraphSequence: string[];
  sentenceSequence: string[];
  separator: AppConfig["audio"]["separator"];
  items: AudioTimelineItem[];
};
type MergeState = {
  version: 1;
  fingerprint: string;
  temporary: string;
  status: "merging" | "complete";
  expectedSeconds: number;
};

async function fileIsUsable(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 512) return false;
    const header = new Uint8Array(await Bun.file(path).slice(0, 3).arrayBuffer());
    return (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33)
      || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
  } catch { return false; }
}

function specHash(spec: AudioSpec): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ content: spec.text, profile: spec.profile, outputFormat: "audio-24khz-96kbitrate-mono-mp3" }))
    .digest("hex")
    .slice(0, 24);
}

async function synthesize(
  spec: AudioSpec,
  cacheDir: string,
  ffmpegPath: string,
  existingCacheNames: ReadonlySet<string>,
): Promise<SynthesisResult> {
  const hash = specHash(spec);
  const safeId = spec.kind.replace(/[^a-zA-Z0-9_-]/g, "_");
  const output = join(cacheDir, `${safeId}-${hash}.mp3`);
  // Cache files are atomically renamed after a successful synthesis. A single
  // directory listing avoids thousands of slow per-file metadata reads on iCloud.
  if (existingCacheNames.has(basename(output))) return { path: output, cached: true };

  const temporary = `${output}.${process.pid}.${randomUUID()}.part.mp3`;
  if (!/[\p{L}\p{N}]/u.test(spec.text)) {
    const silence = Bun.spawn([
      ffmpegPath, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
      "anullsrc=r=24000:cl=mono", "-t", "0.7", "-c:a", "libmp3lame", "-b:a", "96k", temporary,
    ]);
    if (await silence.exited !== 0) throw new Error(`无法为纯标点片段生成静音: ${spec.text}`);
    await rename(temporary, output);
    return { path: output, cached: false };
  }
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await rm(temporary, { force: true });
      const tts = new EdgeTTS({
        voice: spec.profile.voice,
        lang: spec.profile.language,
        outputFormat: "audio-24khz-96kbitrate-mono-mp3",
        saveSubtitles: false,
        rate: spec.profile.rate,
        pitch: spec.profile.pitch,
        timeout: 60_000,
      });
      await tts.ttsPromise(spec.text, temporary);
      if (!(await fileIsUsable(temporary))) throw new Error("TTS 输出为空");
      await rename(temporary, output);
      return { path: output, cached: false };
    } catch (error) {
      await rm(temporary, { force: true });
      if (attempt === 6) throw new Error(`${spec.kind} 生成失败（${spec.text.slice(0, 40)}）: ${error instanceof Error ? error.message : String(error)}`);
      await Bun.sleep(Math.min(12_000, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw new Error("无法生成语音");
}

async function runPool<T>(jobs: Array<() => Promise<T>>, concurrency: number, onCompleted: (value: T) => void): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= jobs.length) return;
      results[index] = await jobs[index]();
      onCompleted(results[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

async function audioDurationMs(path: string, ffprobePath: string): Promise<number> {
  const probe = Bun.spawn([
    ffprobePath, "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", path,
  ], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    probe.exited,
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
  ]);
  const seconds = Number(stdout.trim());
  if (exitCode !== 0 || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`无法读取音频片段时长（${path}）: ${stderr.trim() || stdout.trim() || `退出码 ${exitCode}`}`);
  }
  return seconds * 1000;
}

function escapeConcatPath(path: string): string {
  return path.replace(/'/g, "'\\''");
}

export function audioMergeFingerprint(value: Omit<AudioManifest, "version" | "mergeFingerprint">): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
}

function mergeTemporaryIsSafe(value: unknown, outputPath: string): value is MergeState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<MergeState>;
  return typeof state.temporary === "string"
    && dirname(dirname(state.temporary)) === tmpdir()
    && basename(dirname(state.temporary)).startsWith("yonde-merge-")
    && basename(state.temporary) === `${basename(outputPath)}.tmp.mp3`;
}

export function mergeStateCanRecover(value: unknown, fingerprint: string, outputPath: string): value is MergeState {
  if (!mergeTemporaryIsSafe(value, outputPath)) return false;
  const state = value as Partial<MergeState>;
  return state.version === 1
    && state.status === "complete"
    && state.fingerprint === fingerprint
    && typeof state.expectedSeconds === "number";
}

async function temporaryOutputs(outputPath: string): Promise<string[]> {
  const prefix = `${basename(outputPath)}.`;
  return (await readdir(dirname(outputPath)))
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp.mp3"))
    .map((entry) => join(dirname(outputPath), entry));
}

async function estimateDurationSeconds(items: AudioItem[]): Promise<number> {
  const sizes = new Map<string, number>();
  let bytes = 0;
  for (const item of items) {
    let size = sizes.get(item.path);
    if (size === undefined) {
      size = (await lstat(item.path)).size;
      sizes.set(item.path, size);
    }
    bytes += size;
  }
  return Math.max(1, bytes * 8 / 96_000);
}

async function installMergedOutput(source: string, outputPath: string, cues: LyricsCue[]): Promise<void> {
  const staged = `${outputPath}.${process.pid}.${randomUUID()}.tmp.mp3`;
  try {
    if (cues.length > 0) await prependLyricsTag(source, staged, cues);
    else await copyFile(source, staged);
    await rename(staged, outputPath);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

async function recoverCompletedMerge(outputPath: string, stateDir: string, fingerprint: string, cues: LyricsCue[]): Promise<boolean> {
  const statePath = join(stateDir, "audio-merge-state.json");
  const state = await readJson<unknown>(statePath);
  if (!mergeStateCanRecover(state, fingerprint, outputPath) || !(await fileIsUsable(state.temporary))) return false;
  await installMergedOutput(state.temporary, outputPath, cues);
  await rm(dirname(state.temporary), { recursive: true, force: true });
  await rm(statePath, { force: true });
  for (const stale of await temporaryOutputs(outputPath)) await rm(stale, { force: true });
  const progress = new ProgressBar("恢复", 1);
  progress.finish("已恢复完成的合并结果");
  return true;
}

async function discardStaleMerge(outputPath: string, stateDir: string): Promise<void> {
  const statePath = join(stateDir, "audio-merge-state.json");
  const state = await readJson<unknown>(statePath);
  if (mergeTemporaryIsSafe(state, outputPath)) await rm(dirname(state.temporary), { recursive: true, force: true });
  await rm(statePath, { force: true });
}

async function readFfmpegProgress(stream: ReadableStream<Uint8Array>, progress: ProgressBar, totalSeconds: number): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("out_time_us=")) continue;
      const seconds = Number(line.slice("out_time_us=".length)) / 1_000_000;
      if (Number.isFinite(seconds)) progress.update(Math.min(seconds, totalSeconds), `音频 ${Math.floor(seconds / 60)} 分钟`);
    }
  }
}

async function runFfmpeg(
  items: AudioItem[],
  outputPath: string,
  stateDir: string,
  ffmpegPath: string,
  fingerprint: string,
  cues: LyricsCue[],
): Promise<void> {
  const listPath = join(stateDir, "concat.txt");
  const paths = items.map((item) => relative(stateDir, item.path));
  if (paths.some((path) => path.startsWith("..") || /[\r\n\0]/.test(path))) throw new Error("音频缓存路径超出状态目录或含控制字符");
  await atomicWrite(listPath, paths.map((path) => `file '${escapeConcatPath(path)}'`).join("\n") + "\n");
  const temporaryDir = await mkdtemp(join(tmpdir(), "yonde-merge-"));
  const temporary = join(temporaryDir, `${basename(outputPath)}.tmp.mp3`);
  const mergeStatePath = join(stateDir, "audio-merge-state.json");
  const expectedSeconds = await estimateDurationSeconds(items);
  const progress = new ProgressBar("合并", expectedSeconds);
  await rm(temporary, { force: true });
  await writeJson(mergeStatePath, {
    version: 1,
    fingerprint,
    temporary,
    status: "merging",
    expectedSeconds,
  } satisfies MergeState);
  const processResult = Bun.spawn([
    ffmpegPath, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "1", "-i", listPath,
    "-c:a", "copy", "-id3v2_version", "0", "-progress", "pipe:1", "-nostats", temporary,
  ], { stdout: "pipe", stderr: "pipe" });
  const progressReader = readFfmpegProgress(processResult.stdout, progress, expectedSeconds);
  const stderrReader = new Response(processResult.stderr).text();
  const exitCode = await processResult.exited;
  await progressReader;
  const stderr = await stderrReader;
  if (exitCode !== 0) {
    progress.fail(`退出码 ${exitCode}`);
    await rm(temporaryDir, { recursive: true, force: true });
    await rm(mergeStatePath, { force: true });
    const detail = stderr.trim().split("\n").at(-1);
    throw new Error(`ffmpeg 合并失败，退出码 ${exitCode}${detail ? `: ${detail}` : ""}`);
  }
  await writeJson(mergeStatePath, {
    version: 1,
    fingerprint,
    temporary,
    status: "complete",
    expectedSeconds,
  } satisfies MergeState);
  progress.finish(`${items.length} 个片段`);
  await installMergedOutput(temporary, outputPath, cues);
  await rm(temporaryDir, { recursive: true, force: true });
  await rm(mergeStatePath, { force: true });
}

function profileText(profile: VoiceProfile, source: string, target: string): string {
  return profile.text === "target" ? target : source;
}

export function profileForText(
  profile: VoiceProfile,
  text: string,
  profiles: Record<string, VoiceProfile>,
): VoiceProfile {
  const kanaOnly = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) && !/\p{Script=Han}/u.test(text);
  if (!kanaOnly || profile.language.toLowerCase().startsWith("ja")) return profile;
  const japanese = Object.values(profiles).find((candidate) => candidate.language.toLowerCase().startsWith("ja"));
  return japanese ? { ...profile, voice: japanese.voice, language: japanese.language } : profile;
}

function addProfile(plan: PlannedItem[], id: string, source: string, target: string, config: AppConfig): void {
  if (!Object.hasOwn(config.audio.profiles, id)) throw new Error(`未知音频 profile: ${id}`);
  const profile = config.audio.profiles[id];
  const text = profileText(profile, source, target);
  for (const chunk of splitForTts(text, config.audio.maxChunkChars, config.text.sentenceEndings)) {
    plan.push({ type: "audio", spec: { kind: id, text: chunk, profile: profileForText(profile, chunk, config.audio.profiles) } });
  }
}

export function buildPlan(paragraphs: TranslatedParagraph[], config: AppConfig): PlannedItem[] {
  const plan: PlannedItem[] = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const token of config.audio.paragraphSequence) {
      if (token === "sentences") {
        paragraph.sentences.forEach((sentence, sentenceIndex) => {
          for (const id of config.audio.sentenceSequence) addProfile(plan, id, sentence, paragraph.translations[sentenceIndex], config);
        });
      } else if (token === "separator") {
        if (config.audio.separator.enabled && paragraphIndex < paragraphs.length - 1) plan.push({ type: "separator" });
      } else {
        addProfile(plan, token, paragraph.original, paragraph.translations.join(""), config);
      }
    }
  });
  return plan;
}

function resolveSeparatorAsset(specifier: string): string {
  const url = import.meta.resolve(specifier);
  if (!url.startsWith("file:")) throw new Error(`分隔音效不是本地文件: ${specifier}`);
  return fileURLToPath(url);
}

export async function buildAudio(
  paragraphs: TranslatedParagraph[],
  outputPath: string,
  stateDir: string,
  config: AppConfig,
): Promise<void> {
  const ffmpegPath = Bun.which("ffmpeg");
  if (!ffmpegPath) throw new Error("找不到 ffmpeg；请先安装 ffmpeg，或仅运行 --stage translate");
  const ffprobePath = Bun.which("ffprobe");
  if (!ffprobePath) throw new Error("找不到 ffprobe；请安装完整的 ffmpeg 工具包，或仅运行 --stage translate");
  const cacheDir = join(stateDir, "audio-cache");
  await mkdir(cacheDir, { recursive: true });
  const cacheEntries = await readdir(cacheDir);
  for (const entry of cacheEntries) if (entry.endsWith(".part.mp3")) await rm(join(cacheDir, entry), { force: true });
  const existingCacheNames = new Set(cacheEntries.filter((entry) => entry.endsWith(".mp3")));
  const outputDir = dirname(outputPath);
  await mkdir(outputDir, { recursive: true });

  const plan = buildPlan(paragraphs, config);
  const uniqueSpecs = new Map<string, AudioSpec>();
  for (const item of plan) if (item.type === "audio") uniqueSpecs.set(specHash(item.spec), item.spec);
  if (uniqueSpecs.size === 0) throw new Error("音频顺序没有产生任何可朗读片段");

  let separatorPath: string | undefined;
  if (plan.some((item) => item.type === "separator")) {
    separatorPath = join(stateDir, "separator-24khz-96k-mono.mp3");
    if (!(await fileIsUsable(separatorPath))) {
      const source = resolveSeparatorAsset(config.audio.separator.packageAsset);
      if (!(await fileIsUsable(source))) throw new Error(`找不到可用的分隔音效: ${source}`);
      const temporarySeparator = `${separatorPath}.${randomUUID()}.tmp.mp3`;
      try {
        const conversion = Bun.spawn([
          ffmpegPath, "-hide_banner", "-loglevel", "error", "-y", "-i", source,
          "-ar", "24000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "96k", temporarySeparator,
        ], { stdout: "ignore", stderr: "pipe" });
        const stderrReader = new Response(conversion.stderr).text();
        const exitCode = await conversion.exited;
        const stderr = await stderrReader;
        if (exitCode !== 0 || !(await fileIsUsable(temporarySeparator))) {
          const detail = stderr.trim().split("\n").at(-1);
          throw new Error(`分隔音效标准化失败${detail ? `: ${detail}` : ""}`);
        }
        await rename(temporarySeparator, separatorPath);
      } catch (error) {
        await rm(temporarySeparator, { force: true });
        throw error;
      }
    }
  }

  const entries = [...uniqueSpecs.entries()];
  const synthesisProgress = new ProgressBar("语音", entries.length);
  let completed = 0;
  let cached = 0;
  let results: SynthesisResult[];
  try {
    results = await runPool(
      entries.map(([, spec]) => () => synthesize(spec, cacheDir, ffmpegPath, existingCacheNames)),
      config.audio.concurrency,
      (result) => {
        completed += 1;
        if (result.cached) cached += 1;
        if (completed < entries.length) synthesisProgress.update(completed, `缓存 ${cached} · 新生成 ${completed - cached}`);
      },
    );
    synthesisProgress.finish(`缓存 ${cached} · 新生成 ${completed - cached}`);
  } catch (error) {
    synthesisProgress.fail(`完成 ${completed}/${entries.length}`);
    throw error;
  }
  const generated = new Map(entries.map(([hash], index) => [hash, results[index].path]));
  const items: AudioItem[] = plan.map((item) => item.type === "separator"
    ? { kind: "separator", path: separatorPath! }
    : { kind: item.spec.kind, text: item.spec.text, path: generated.get(specHash(item.spec))! });

  const uniquePaths = [...new Set(items.map((item) => item.path))];
  const timelineProgress = new ProgressBar("时轴", uniquePaths.length);
  let measured = 0;
  let durationValues: number[];
  try {
    durationValues = await runPool(
      uniquePaths.map((path) => () => audioDurationMs(path, ffprobePath)),
      Math.min(config.audio.concurrency, 16),
      () => {
        measured += 1;
        if (measured < uniquePaths.length) timelineProgress.update(measured, `${measured}/${uniquePaths.length} 个片段`);
      },
    );
    timelineProgress.finish(`${uniquePaths.length} 个片段`);
  } catch (error) {
    timelineProgress.fail(`完成 ${measured}/${uniquePaths.length}`);
    throw error;
  }
  const timeline = buildTimeline(items, new Map(uniquePaths.map((path, index) => [path, durationValues[index]])));
  const cues = lyricsCues(timeline);

  const manifestBody = {
    profiles: config.audio.profiles,
    paragraphSequence: config.audio.paragraphSequence,
    sentenceSequence: config.audio.sentenceSequence,
    separator: config.audio.separator,
    items: timeline,
  };
  const mergeFingerprint = audioMergeFingerprint(manifestBody);
  const lrcPath = /\.mp3$/i.test(outputPath) ? outputPath.replace(/\.mp3$/i, ".lrc") : `${outputPath}.lrc`;
  if (await recoverCompletedMerge(outputPath, stateDir, mergeFingerprint, cues)) {
    await atomicWrite(lrcPath, renderLrc(cues));
    console.log(`同步文本: ${lrcPath}`);
    return;
  }
  await discardStaleMerge(outputPath, stateDir);
  const stale = await temporaryOutputs(outputPath);
  if (stale.length) console.warn(`发现 ${stale.length} 个未完成的合并临时文件，将保留语音缓存并重新合并。`);
  for (const path of stale) await rm(path, { force: true });
  const manifest: AudioManifest = { version: 4, mergeFingerprint, ...manifestBody };
  await writeJson(join(stateDir, "audio-manifest.json"), manifest);
  await runFfmpeg(items, outputPath, stateDir, ffmpegPath, mergeFingerprint, cues);
  await atomicWrite(lrcPath, renderLrc(cues));
  console.log(`同步文本: ${lrcPath}`);
}
