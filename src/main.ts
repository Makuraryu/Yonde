#!/usr/bin/env bun
import { mkdir, open } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { buildAudio } from "./audio";
import { DEFAULT_CONFIG_TOML, loadConfig, translationFingerprint } from "./config";
import { atomicWrite, readJson, writeJson, type TranslationState } from "./state";
import { parseParagraphs, renderListeningText } from "./text";
import { translateAll } from "./translate";

type Stage = "translate" | "audio" | "all";
type RunArgs = { command: "run"; input: string; stage: Stage; outputDir?: string; configPath?: string };
type CliArgs = RunArgs | { command: "init"; path: string } | { command: "config-check"; configPath?: string } | { command: "help" } | { command: "version" };

const VERSION = "0.3.3";

export const HELP_TEXT = `Yonde ${VERSION} — 配置驱动的双语听力材料生成器

用法:
  yonde <输入.txt> [选项]
  yonde init [配置文件]
  yonde config check [--config <配置文件>]

命令:
  <输入.txt>       翻译文本并生成双语听力稿与 MP3
  init             创建配置模板（默认: ./yonde.toml，不覆盖已有文件）
  config check     发现、合并并校验配置，但不生成内容

选项:
  --stage <阶段>       执行阶段: translate、audio 或 all（默认: all）
  --config <文件>      使用指定 TOML 配置；优先于项目和用户配置
  --output-dir <目录>  输出目录（默认: 输入文件旁的 output/）
  -h, --help           显示帮助
  -v, --version        显示版本

配置优先级（高 → 低）:
  CLI 选项 > 环境变量 > --config 文件 > ./yonde.toml
  > ~/.config/yonde/config.toml > 内置默认值

示例:
  bunx github:Makuraryu/Yonde input.txt
  bunx github:Makuraryu/Yonde input.txt --stage translate
  bunx github:Makuraryu/Yonde input.txt --config ./yonde.toml
  bunx github:Makuraryu/Yonde config check
  bunx github:Makuraryu/Yonde init

环境变量:
  YONDE_API_KEY          默认翻译 API Key
  YONDE_API_ENDPOINT     覆盖翻译 API 地址
  YONDE_MODEL            覆盖翻译模型
  YONDE_TTS_CONCURRENCY  覆盖 TTS 并发数

API Key 优先级:
  translation.api.api_key > api_key_env 明确指定的环境变量
  默认 api_key_env 为 YONDE_API_KEY；不会读取其他 Key 变量`;

function usage(exitCode = 1): never {
  const output = exitCode === 0 ? console.log : console.error;
  output(HELP_TEXT);
  process.exit(exitCode);
}

function optionValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

export function parseArgs(args: string[]): CliArgs {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { command: "help" };
  if (args.includes("--version") || args.includes("-v")) return { command: "version" };
  if (args[0] === "init") {
    if (args.length > 2 || args[1]?.startsWith("--")) usage();
    return { command: "init", path: args[1] ?? "yonde.toml" };
  }
  if (args[0] === "config") {
    if (args[1] !== "check") usage();
    let configPath: string | undefined;
    for (let index = 2; index < args.length; index += 1) {
      if (args[index] === "--config") configPath = optionValue(args, index++);
      else usage();
    }
    return { command: "config-check", configPath };
  }

  let input: string | undefined;
  let stage: Stage = "all";
  let outputDir: string | undefined;
  let configPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--stage") stage = optionValue(args, index++) as Stage;
    else if (arg === "--output-dir") outputDir = optionValue(args, index++);
    else if (arg === "--config") configPath = optionValue(args, index++);
    else if (!arg.startsWith("--") && !input) input = arg;
    else usage();
  }
  if (!input || !["translate", "audio", "all"].includes(stage)) usage();
  return { command: "run", input, stage, outputDir, configPath };
}

async function initialize(path: string): Promise<void> {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  let handle;
  try {
    handle = await open(output, "wx", 0o600);
    await handle.writeFile(DEFAULT_CONFIG_TOML, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`不会覆盖已有文件: ${output}`);
    throw error;
  } finally {
    await handle?.close();
  }
  console.log(`已创建配置: ${output}`);
}

async function checkConfig(configPath?: string): Promise<void> {
  const loaded = await loadConfig(configPath);
  for (const warning of loaded.warnings) console.warn(`警告: ${warning}`);
  console.log(`配置有效: ${loaded.path ?? "内置默认配置"}`);
  console.log(`翻译: ${loaded.config.translation.sourceLanguage} → ${loaded.config.translation.targetLanguage}`);
  console.log(`API: ${loaded.config.translation.api.endpoint} (${loaded.config.translation.api.model})`);
  console.log(`段落顺序: ${loaded.config.audio.paragraphSequence.join(" → ")}`);
  console.log(`逐句顺序: ${loaded.config.audio.sentenceSequence.join(" → ")}`);
}

function stateIsValid(state: unknown, paragraphs: ReturnType<typeof parseParagraphs>, inputHash: string, configHash: string): state is TranslationState {
  if (!state || typeof state !== "object") return false;
  const candidate = state as Partial<TranslationState>;
  if (candidate.version !== 2 || candidate.inputHash !== inputHash || candidate.configHash !== configHash) return false;
  if (!Array.isArray(candidate.paragraphs) || JSON.stringify(candidate.paragraphs) !== JSON.stringify(paragraphs)) return false;
  if (!Array.isArray(candidate.translated) || candidate.translated.length > paragraphs.length) return false;
  for (let index = 0; index < candidate.translated.length; index += 1) {
    const item = candidate.translated[index];
    if (!item || item.index !== paragraphs[index].index || item.original !== paragraphs[index].original) return false;
    if (JSON.stringify(item.sentences) !== JSON.stringify(paragraphs[index].sentences)) return false;
    if (!Array.isArray(item.translations) || item.translations.length !== item.sentences.length || item.translations.some((text) => typeof text !== "string")) return false;
  }
  if (!Array.isArray(candidate.glossary) || candidate.glossary.some((entry) => !entry || typeof entry.source !== "string" || typeof entry.target !== "string")) return false;
  if (typeof candidate.complete !== "boolean" || candidate.complete !== (candidate.translated.length === paragraphs.length)) return false;
  return typeof candidate.updatedAt === "string";
}

async function run(args: RunArgs): Promise<void> {
  const loaded = await loadConfig(args.configPath);
  for (const warning of loaded.warnings) console.warn(`警告: ${warning}`);
  const { config } = loaded;
  const inputPath = resolve(args.input);
  const inputFile = Bun.file(inputPath);
  if (!(await inputFile.exists())) throw new Error(`找不到输入文件: ${inputPath}`);
  const inputText = await inputFile.text();
  const inputHash = new Bun.CryptoHasher("sha256").update(inputText).digest("hex");
  const configHash = translationFingerprint(config);
  const stem = basename(inputPath).replace(/\.txt$/i, "");
  const outputDir = resolve(args.outputDir ?? join(dirname(inputPath), "output"));
  const stateDir = join(outputDir, ".state", `${stem}-${inputHash.slice(0, 10)}-${configHash.slice(0, 10)}`);
  const statePath = join(stateDir, "translation.json");
  const textOutput = join(outputDir, `${stem}.listening.txt`);
  const audioOutput = join(outputDir, `${stem}.listening.mp3`);
  await mkdir(stateDir, { recursive: true });

  const parsedParagraphs = parseParagraphs(inputText, config.text.sentenceEndings);
  const savedState = await readJson<unknown>(statePath);
  let state: TranslationState;
  if (!savedState) {
    state = {
      version: 2,
      inputPath,
      inputHash,
      configHash,
      paragraphs: parsedParagraphs,
      translated: [],
      glossary: [],
      complete: false,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(statePath, state);
  } else if (!stateIsValid(savedState, parsedParagraphs, inputHash, configHash)) {
    throw new Error(`检查点格式无效，或与当前输入/配置不匹配: ${statePath}`);
  } else {
    state = savedState;
  }
  console.log(`输入: ${inputPath}`);
  console.log(`配置: ${loaded.path ?? "内置默认配置"}`);
  console.log(`语言: ${config.translation.sourceLanguage} → ${config.translation.targetLanguage}`);
  console.log(`段落: ${state.paragraphs.length}，已翻译: ${state.translated.length}`);
  console.log(`检查点: ${statePath}`);

  if (args.stage === "translate" || args.stage === "all") {
    state = await translateAll(state, statePath, config);
    await atomicWrite(textOutput, `${renderListeningText(state.translated, config.audio.sentenceSequence, config.audio.profiles)}\n`);
    console.log(`听力文本: ${textOutput}`);
  }

  if (args.stage === "audio" || args.stage === "all") {
    if (!state.complete) throw new Error("翻译尚未完成；请先运行 --stage translate（会从检查点续跑）");
    if (!(await Bun.file(textOutput).exists())) {
      await atomicWrite(textOutput, `${renderListeningText(state.translated, config.audio.sentenceSequence, config.audio.profiles)}\n`);
    }
    await buildAudio(state.translated, audioOutput, stateDir, config);
    console.log(`MP3: ${audioOutput}`);
  }
  console.log("完成。");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") usage(0);
  if (args.command === "version") return console.log(VERSION);
  if (args.command === "init") return initialize(args.path);
  if (args.command === "config-check") return checkConfig(args.configPath);
  return run(args);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
