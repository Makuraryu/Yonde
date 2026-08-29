import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type VoiceProfile = {
  text: "source" | "target";
  voice: string;
  language: string;
  rate: string;
  pitch: string;
};

export type AppConfig = {
  version: 1;
  translation: {
    sourceLanguage: string;
    targetLanguage: string;
    contextParagraphs: number;
    batchSize: number;
    temperature: number;
    api: {
      endpoint: string;
      model: string;
      apiKeyEnv: string;
      apiKey?: string;
      timeoutMs: number;
    };
  };
  text: { sentenceEndings: string[] };
  audio: {
    concurrency: number;
    maxChunkChars: number;
    paragraphSequence: string[];
    sentenceSequence: string[];
    profiles: Record<string, VoiceProfile>;
    separator: { enabled: boolean; packageAsset: string };
  };
};

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  translation: {
    sourceLanguage: "ja",
    targetLanguage: "zh-Hans",
    contextParagraphs: 6,
    batchSize: 12,
    temperature: 0.2,
    api: {
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-chat",
      apiKeyEnv: "YONDE_API_KEY",
      timeoutMs: 120_000,
    },
  },
  text: { sentenceEndings: ["。", "、", "！", "？"] },
  audio: {
    concurrency: 8,
    maxChunkChars: 380,
    paragraphSequence: ["source_full", "sentences", "separator"],
    sentenceSequence: ["source_slow", "target_normal", "source_repeat"],
    profiles: {
      source_full: { text: "source", voice: "ja-JP-KeitaNeural", language: "ja-JP", rate: "+0%", pitch: "-5%" },
      source_slow: { text: "source", voice: "ja-JP-KeitaNeural", language: "ja-JP", rate: "-20%", pitch: "-5%" },
      target_normal: { text: "target", voice: "zh-CN-YunxiNeural", language: "zh-CN", rate: "+0%", pitch: "+0Hz" },
      source_repeat: { text: "source", voice: "ja-JP-NanamiNeural", language: "ja-JP", rate: "+0%", pitch: "+0Hz" },
    },
    separator: { enabled: true, packageAsset: "uisfx/sounds/cinematic/select.mp3" },
  },
};

export const DEFAULT_CONFIG_TOML = `version = 1

[translation]
source_language = "ja"
target_language = "zh-Hans"
context_paragraphs = 6
batch_size = 12
temperature = 0.2

[translation.api]
endpoint = "https://api.deepseek.com/chat/completions"
model = "deepseek-chat"
api_key_env = "YONDE_API_KEY"
# api_key = "不推荐：优先使用上面的环境变量"
timeout_ms = 120000

[text]
sentence_endings = ["。", "、", "！", "？"]

[audio]
concurrency = 8
max_chunk_chars = 380
paragraph_sequence = ["source_full", "sentences", "separator"]
sentence_sequence = ["source_slow", "target_normal", "source_repeat"]

[audio.profiles.source_full]
text = "source"
voice = "ja-JP-KeitaNeural"
language = "ja-JP"
rate = "+0%"
pitch = "-5%"

[audio.profiles.source_slow]
text = "source"
voice = "ja-JP-KeitaNeural"
language = "ja-JP"
rate = "-20%"
pitch = "-5%"

[audio.profiles.target_normal]
text = "target"
voice = "zh-CN-YunxiNeural"
language = "zh-CN"
rate = "+0%"
pitch = "+0Hz"

[audio.profiles.source_repeat]
text = "source"
voice = "ja-JP-NanamiNeural"
language = "ja-JP"
rate = "+0%"
pitch = "+0Hz"

[audio.separator]
enabled = true
package_asset = "uisfx/sounds/cinematic/select.mp3"
`;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function camelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const normalized = camelKey(key);
    if (["__proto__", "prototype", "constructor"].includes(normalized)) throw new Error(`禁止的配置项: ${key}`);
    return [normalized, normalizeKeys(child)];
  }));
}

function merge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override;
  const result: UnknownRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? merge(result[key], value) : value;
  }
  return result;
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} 必须是非空字符串`);
}

function requireNumber(value: unknown, path: string, minimum: number, maximum: number): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${path} 必须是 ${minimum} 到 ${maximum} 之间的数字`);
  }
}

function requireStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${path} 必须是非空字符串数组`);
  }
}

function rejectUnknown(record: UnknownRecord, allowed: string[], path: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`未知配置项: ${path}${unknown}`);
}

export function validateConfig(value: unknown): AppConfig {
  if (!isRecord(value)) throw new Error("配置根节点必须是 TOML 表");
  rejectUnknown(value, ["version", "translation", "text", "audio"], "");
  if (isRecord(value.translation)) rejectUnknown(value.translation, ["sourceLanguage", "targetLanguage", "contextParagraphs", "batchSize", "temperature", "api"], "translation.");
  if (isRecord(value.translation) && isRecord(value.translation.api)) rejectUnknown(value.translation.api, ["endpoint", "model", "apiKeyEnv", "apiKey", "timeoutMs"], "translation.api.");
  if (isRecord(value.text)) rejectUnknown(value.text, ["sentenceEndings"], "text.");
  if (isRecord(value.audio)) rejectUnknown(value.audio, ["concurrency", "maxChunkChars", "paragraphSequence", "sentenceSequence", "profiles", "separator"], "audio.");
  if (isRecord(value.audio) && isRecord(value.audio.separator)) rejectUnknown(value.audio.separator, ["enabled", "packageAsset"], "audio.separator.");
  if (isRecord(value.audio) && isRecord(value.audio.profiles)) {
    for (const [id, profile] of Object.entries(value.audio.profiles)) {
      if (isRecord(profile)) rejectUnknown(profile, ["text", "voice", "language", "rate", "pitch"], `audio.profiles.${id}.`);
    }
  }
  const config = value as unknown as AppConfig;
  if (config.version !== 1) throw new Error("仅支持 version = 1");
  if (!config.translation || !config.translation.api) throw new Error("缺少 [translation] 或 [translation.api]");
  requireString(config.translation.sourceLanguage, "translation.source_language");
  requireString(config.translation.targetLanguage, "translation.target_language");
  requireNumber(config.translation.contextParagraphs, "translation.context_paragraphs", 0, 100);
  requireNumber(config.translation.batchSize, "translation.batch_size", 1, 100);
  requireNumber(config.translation.temperature, "translation.temperature", 0, 2);
  requireString(config.translation.api.endpoint, "translation.api.endpoint");
  let endpoint: URL;
  try { endpoint = new URL(config.translation.api.endpoint); } catch { throw new Error("translation.api.endpoint 必须是有效 URL"); }
  const localHttp = endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !localHttp) throw new Error("translation.api.endpoint 必须使用 HTTPS（本机 localhost 可使用 HTTP）");
  if (endpoint.username || endpoint.password) throw new Error("translation.api.endpoint 不得包含用户名或密码");
  requireString(config.translation.api.model, "translation.api.model");
  requireString(config.translation.api.apiKeyEnv, "translation.api.api_key_env");
  if (config.translation.api.apiKey !== undefined) requireString(config.translation.api.apiKey, "translation.api.api_key");
  requireNumber(config.translation.api.timeoutMs, "translation.api.timeout_ms", 1000, 600_000);
  requireStringArray(config.text?.sentenceEndings, "text.sentence_endings");
  if (config.text.sentenceEndings.some((ending) => [...ending].length !== 1)) throw new Error("text.sentence_endings 中每项必须是单个字符");
  requireNumber(config.audio?.concurrency, "audio.concurrency", 1, 64);
  requireNumber(config.audio?.maxChunkChars, "audio.max_chunk_chars", 20, 5000);
  requireStringArray(config.audio?.paragraphSequence, "audio.paragraph_sequence");
  requireStringArray(config.audio?.sentenceSequence, "audio.sentence_sequence");
  if (!isRecord(config.audio.profiles) || Object.keys(config.audio.profiles).length === 0) throw new Error("audio.profiles 至少需要一个 profile");
  for (const [id, profile] of Object.entries(config.audio.profiles)) {
    if (!isRecord(profile) || !["source", "target"].includes(String(profile.text))) throw new Error(`audio.profiles.${id}.text 必须是 source 或 target`);
    requireString(profile.voice, `audio.profiles.${id}.voice`);
    requireString(profile.language, `audio.profiles.${id}.language`);
    requireString(profile.rate, `audio.profiles.${id}.rate`);
    requireString(profile.pitch, `audio.profiles.${id}.pitch`);
  }
  for (const token of config.audio.paragraphSequence) {
    if (token !== "sentences" && token !== "separator" && !Object.hasOwn(config.audio.profiles, token)) throw new Error(`audio.paragraph_sequence 引用了未知项: ${token}`);
  }
  if (config.audio.paragraphSequence.every((token) => token === "separator")) throw new Error("audio.paragraph_sequence 至少需要一个 profile 或 sentences");
  for (const token of config.audio.sentenceSequence) {
    if (!Object.hasOwn(config.audio.profiles, token)) throw new Error(`audio.sentence_sequence 引用了未知 profile: ${token}`);
  }
  if (!config.audio.separator || typeof config.audio.separator.enabled !== "boolean") throw new Error("audio.separator.enabled 必须是布尔值");
  requireString(config.audio.separator.packageAsset, "audio.separator.package_asset");
  if (!/^uisfx\/sounds\/[a-zA-Z0-9_/-]+\.mp3$/.test(config.audio.separator.packageAsset) || config.audio.separator.packageAsset.includes("..")) {
    throw new Error("audio.separator.package_asset 只允许 uisfx/sounds/ 下的 MP3 资源");
  }
  return config;
}

function environmentOverrides(): UnknownRecord {
  const api: UnknownRecord = {};
  const translation: UnknownRecord = { api };
  const audio: UnknownRecord = {};
  if (process.env.YONDE_API_ENDPOINT) api.endpoint = process.env.YONDE_API_ENDPOINT;
  if (process.env.YONDE_MODEL) api.model = process.env.YONDE_MODEL;
  if (process.env.YONDE_TTS_CONCURRENCY) audio.concurrency = Number(process.env.YONDE_TTS_CONCURRENCY);
  return { translation, audio };
}

async function existing(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

export async function loadConfig(explicitPath?: string, cwd = process.cwd()): Promise<{ config: AppConfig; path?: string; warnings: string[] }> {
  const userPath = join(homedir(), ".config", "yonde", "config.toml");
  const projectPath = join(cwd, "yonde.toml");
  let combined: unknown = DEFAULT_CONFIG;
  let loadedPath: string | undefined;

  const candidates = [userPath, projectPath];
  if (explicitPath) candidates.push(resolve(cwd, explicitPath));
  for (const candidate of [...new Set(candidates)]) {
    if (!(await existing(candidate))) {
      if (explicitPath && candidate === resolve(cwd, explicitPath)) throw new Error(`找不到配置文件: ${candidate}`);
      continue;
    }
    const parsed = normalizeKeys(Bun.TOML.parse(await Bun.file(candidate).text()));
    combined = merge(combined, parsed);
    loadedPath = candidate;
  }
  combined = merge(combined, environmentOverrides());
  const config = validateConfig(combined);
  const warnings: string[] = [];
  if (config.translation.api.apiKey && loadedPath) {
    try {
      const mode = (await stat(loadedPath)).mode & 0o777;
      if ((mode & 0o077) !== 0) warnings.push(`配置内含 api_key，但 ${loadedPath} 权限为 ${mode.toString(8)}；建议 chmod 600`);
      else warnings.push("配置内含明文 api_key；建议改用 api_key_env 指定的环境变量");
    } catch {
      warnings.push("配置内含明文 api_key；建议改用环境变量");
    }
  }
  return { config, path: loadedPath, warnings };
}

export function resolveApiKey(config: AppConfig): string | undefined {
  return config.translation.api.apiKey
    ?? process.env[config.translation.api.apiKeyEnv];
}

export function translationFingerprint(config: AppConfig): string {
  const safe = {
    sourceLanguage: config.translation.sourceLanguage,
    targetLanguage: config.translation.targetLanguage,
    contextParagraphs: config.translation.contextParagraphs,
    batchSize: config.translation.batchSize,
    temperature: config.translation.temperature,
    endpoint: config.translation.api.endpoint,
    model: config.translation.api.model,
    sentenceEndings: config.text.sentenceEndings,
    promptVersion: 2,
  };
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(safe)).digest("hex");
}
