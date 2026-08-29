import { EdgeTTS } from "node-edge-tts";
import { copyFile, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, VoiceProfile } from "./config";
import type { TranslatedParagraph } from "./text";
import { splitForTts } from "./text";
import { atomicWrite, writeJson } from "./state";

type AudioItem = { kind: string; text?: string; path: string };
type AudioSpec = { kind: string; text: string; profile: VoiceProfile };
type PlannedItem = { type: "audio"; spec: AudioSpec } | { type: "separator" };

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

async function synthesize(spec: AudioSpec, cacheDir: string, ffmpegPath: string): Promise<string> {
  const hash = specHash(spec);
  const safeId = spec.kind.replace(/[^a-zA-Z0-9_-]/g, "_");
  const output = join(cacheDir, `${safeId}-${hash}.mp3`);
  if (await fileIsUsable(output)) return output;

  const temporary = `${output}.${process.pid}.${randomUUID()}.part.mp3`;
  if (!/[\p{L}\p{N}]/u.test(spec.text)) {
    const silence = Bun.spawn([
      ffmpegPath, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
      "anullsrc=r=24000:cl=mono", "-t", "0.7", "-c:a", "libmp3lame", "-b:a", "96k", temporary,
    ]);
    if (await silence.exited !== 0) throw new Error(`无法为纯标点片段生成静音: ${spec.text}`);
    await rename(temporary, output);
    return output;
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
      return output;
    } catch (error) {
      await rm(temporary, { force: true });
      if (attempt === 6) throw new Error(`${spec.kind} 生成失败（${spec.text.slice(0, 40)}）: ${error instanceof Error ? error.message : String(error)}`);
      await Bun.sleep(Math.min(12_000, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw new Error("无法生成语音");
}

async function runPool<T>(jobs: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  let completed = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= jobs.length) return;
      results[index] = await jobs[index]();
      completed += 1;
      process.stdout.write(`\r[TTS] ${completed}/${jobs.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  if (jobs.length) process.stdout.write("\n");
  return results;
}

function escapeConcatPath(path: string): string {
  return path.replace(/'/g, "'\\''");
}

async function runFfmpeg(items: AudioItem[], outputPath: string, stateDir: string, ffmpegPath: string): Promise<void> {
  const listPath = join(stateDir, "concat.txt");
  const paths = items.map((item) => relative(stateDir, item.path));
  if (paths.some((path) => path.startsWith("..") || /[\r\n\0]/.test(path))) throw new Error("音频缓存路径超出状态目录或含控制字符");
  await atomicWrite(listPath, paths.map((path) => `file '${escapeConcatPath(path)}'`).join("\n") + "\n");
  const temporary = `${outputPath}.${process.pid}.${randomUUID()}.tmp.mp3`;
  await rm(temporary, { force: true });
  const processResult = Bun.spawn([
    ffmpegPath, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "1", "-i", listPath,
    "-af", "aresample=24000,aformat=sample_fmts=s16:channel_layouts=mono",
    "-c:a", "libmp3lame", "-b:a", "96k", temporary,
  ], { stdout: "inherit", stderr: "inherit" });
  const exitCode = await processResult.exited;
  if (exitCode !== 0) {
    await rm(temporary, { force: true });
    throw new Error(`ffmpeg 合并失败，退出码 ${exitCode}`);
  }
  await rename(temporary, outputPath);
}

function profileText(profile: VoiceProfile, source: string, target: string): string {
  return profile.text === "target" ? target : source;
}

function addProfile(plan: PlannedItem[], id: string, source: string, target: string, config: AppConfig): void {
  if (!Object.hasOwn(config.audio.profiles, id)) throw new Error(`未知音频 profile: ${id}`);
  const profile = config.audio.profiles[id];
  const text = profileText(profile, source, target);
  for (const chunk of splitForTts(text, config.audio.maxChunkChars, config.text.sentenceEndings)) {
    plan.push({ type: "audio", spec: { kind: id, text: chunk, profile } });
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
  const cacheDir = join(stateDir, "audio-cache");
  await mkdir(cacheDir, { recursive: true });
  for (const entry of await readdir(cacheDir)) if (entry.endsWith(".part.mp3")) await rm(join(cacheDir, entry), { force: true });
  const outputDir = dirname(outputPath);
  await mkdir(outputDir, { recursive: true });
  const stalePrefix = `${basename(outputPath)}.`;
  for (const entry of await readdir(outputDir)) {
    if (entry.startsWith(stalePrefix) && entry.endsWith(".tmp.mp3")) await rm(join(outputDir, entry), { force: true });
  }

  const plan = buildPlan(paragraphs, config);
  const uniqueSpecs = new Map<string, AudioSpec>();
  for (const item of plan) if (item.type === "audio") uniqueSpecs.set(specHash(item.spec), item.spec);
  if (uniqueSpecs.size === 0) throw new Error("音频顺序没有产生任何可朗读片段");

  let separatorPath: string | undefined;
  if (plan.some((item) => item.type === "separator")) {
    separatorPath = join(stateDir, "separator.mp3");
    if (!(await fileIsUsable(separatorPath))) {
      const source = resolveSeparatorAsset(config.audio.separator.packageAsset);
      if (!(await fileIsUsable(source))) throw new Error(`找不到可用的分隔音效: ${source}`);
      const temporarySeparator = `${separatorPath}.${randomUUID()}.tmp`;
      try {
        await copyFile(source, temporarySeparator);
        await rename(temporarySeparator, separatorPath);
      } catch (error) {
        await rm(temporarySeparator, { force: true });
        throw error;
      }
    }
  }

  const entries = [...uniqueSpecs.entries()];
  console.log(`[TTS] ${entries.length} 个唯一片段，并发 ${config.audio.concurrency}（已有缓存会跳过）`);
  const paths = await runPool(entries.map(([, spec]) => () => synthesize(spec, cacheDir, ffmpegPath)), config.audio.concurrency);
  const generated = new Map(entries.map(([hash], index) => [hash, paths[index]]));
  const items: AudioItem[] = plan.map((item) => item.type === "separator"
    ? { kind: "separator", path: separatorPath! }
    : { kind: item.spec.kind, text: item.spec.text, path: generated.get(specHash(item.spec))! });

  await writeJson(join(stateDir, "audio-manifest.json"), {
    version: 2,
    profiles: config.audio.profiles,
    paragraphSequence: config.audio.paragraphSequence,
    sentenceSequence: config.audio.sentenceSequence,
    separator: config.audio.separator,
    items,
  });
  console.log(`[合并] ${items.length} 个音频片段`);
  await runFfmpeg(items, outputPath, stateDir, ffmpegPath);
}
