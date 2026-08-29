import type { AppConfig } from "./config";
import { resolveApiKey } from "./config";
import type { GlossaryEntry, TranslationState } from "./state";
import { writeJson } from "./state";
import type { Paragraph, TranslatedParagraph } from "./text";

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

type ModelTranslation = {
  translations: string[];
  glossaryUpdates?: GlossaryEntry[];
};

function systemPrompt(config: AppConfig): string {
  return `你是文学翻译者。任务是把 ${config.translation.sourceLanguage} 文学片段翻译成自然、准确、适合听力学习的 ${config.translation.targetLanguage}。
必须保持叙述人称、人物称谓、专有名词和文体与已有上下文一致。不要解释，不要合并或拆分输入片段。
只输出合法 JSON：{"translations":["逐项译文"],"glossaryUpdates":[{"source":"源语言词","target":"固定目标语言译法"}]}。
translations 必须与输入 sentences 数量和顺序完全相同。glossaryUpdates 只收录值得跨段保持一致的人名、称谓、专名或反复出现的关键词。`;
}

function mergeGlossary(current: GlossaryEntry[], updates: GlossaryEntry[]): GlossaryEntry[] {
  const merged = new Map(current.map((entry) => [entry.source, entry.target]));
  for (const entry of updates) {
    if (entry?.source?.trim() && entry?.target?.trim()) merged.set(entry.source.trim(), entry.target.trim());
  }
  return [...merged].map(([source, target]) => ({ source, target })).slice(-120);
}

function parseModelJson(content: string): ModelTranslation {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("模型响应中没有 JSON 对象");
  return JSON.parse(cleaned.slice(start, end + 1)) as ModelTranslation;
}

async function translateBatch(
  paragraph: Paragraph,
  sentenceOffset: number,
  sentences: string[],
  earlierInParagraph: Array<{ text: string; translation: string }>,
  translated: TranslatedParagraph[],
  glossary: GlossaryEntry[],
  apiKey: string,
  config: AppConfig,
): Promise<ModelTranslation> {
  const context = translated.slice(-config.translation.contextParagraphs).map((item) => ({
    original: item.original,
    translations: item.translations,
  }));
  const payload = {
    model: config.translation.api.model,
    temperature: config.translation.temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt(config) },
      {
        role: "user",
        content: JSON.stringify({
          sourceLanguage: config.translation.sourceLanguage,
          targetLanguage: config.translation.targetLanguage,
          rollingBilingualContext: context,
          establishedGlossary: glossary,
          paragraph: paragraph.original,
          earlierInThisParagraph: earlierInParagraph,
          sentences: sentences.map((text, index) => ({ index: sentenceOffset + index, text })),
        }),
      },
    ],
  };

  const response = await fetch(config.translation.api.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.translation.api.timeoutMs),
  });
  const raw = await response.text();
  let body: ChatCompletionResponse;
  try { body = JSON.parse(raw) as ChatCompletionResponse; } catch { throw new Error(`翻译 API HTTP ${response.status} 返回了非 JSON 响应`); }
  if (!response.ok) throw new Error(`翻译 API HTTP ${response.status}: ${body.error?.message ?? response.statusText}`);
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("翻译 API 返回了空响应");
  const parsed = parseModelJson(content);
  if (!Array.isArray(parsed.translations) || parsed.translations.length !== sentences.length) {
    throw new Error(`译文数量不符：期望 ${sentences.length}，得到 ${parsed.translations?.length ?? 0}`);
  }
  if (parsed.translations.some((item) => typeof item !== "string" || !item.trim())) throw new Error("译文包含空项");
  return parsed;
}

async function translateOne(
  paragraph: Paragraph,
  translated: TranslatedParagraph[],
  glossary: GlossaryEntry[],
  apiKey: string,
  config: AppConfig,
): Promise<ModelTranslation> {
  const translations: string[] = [];
  const glossaryUpdates: GlossaryEntry[] = [];

  async function alignedBatch(offset: number, sentences: string[]): Promise<ModelTranslation> {
    let result: ModelTranslation | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        result = await translateBatch(
          paragraph,
          offset,
          sentences,
          paragraph.sentences.slice(0, offset).map((text, index) => ({ text, translation: translations[index] })),
          translated,
          glossary,
          apiKey,
          config,
        );
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await Bun.sleep(750);
      }
    }
    if (result) return result;
    if (sentences.length === 1) throw lastError;

    const middle = Math.ceil(sentences.length / 2);
    const left = await alignedBatch(offset, sentences.slice(0, middle));
    translations.push(...left.translations);
    glossaryUpdates.push(...(left.glossaryUpdates ?? []));
    return alignedBatch(offset + middle, sentences.slice(middle));
  }

  const batchSize = config.translation.batchSize;
  for (let offset = 0; offset < paragraph.sentences.length; offset += batchSize) {
    const result = await alignedBatch(offset, paragraph.sentences.slice(offset, offset + batchSize));
    translations.push(...result.translations);
    glossaryUpdates.push(...(result.glossaryUpdates ?? []));
  }
  return { translations, glossaryUpdates };
}

export async function translateAll(state: TranslationState, statePath: string, config: AppConfig): Promise<TranslationState> {
  const apiKey = resolveApiKey(config);
  if (!apiKey) throw new Error(`缺少 API Key；请设置环境变量 ${config.translation.api.apiKeyEnv}，或在 translation.api.api_key 中配置`);

  for (let index = state.translated.length; index < state.paragraphs.length; index += 1) {
    const paragraph = state.paragraphs[index];
    process.stdout.write(`[翻译 ${index + 1}/${state.paragraphs.length}] ${paragraph.original.slice(0, 28)}… `);
    let result: ModelTranslation | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        result = await translateOne(paragraph, state.translated, state.glossary, apiKey, config);
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 4) {
          process.stdout.write(`重试 ${attempt}/3… `);
          await Bun.sleep(1000 * 2 ** (attempt - 1));
        }
      }
    }
    if (!result) throw lastError;
    state.translated.push({ ...paragraph, translations: result.translations.map((item) => item.trim()) });
    state.glossary = mergeGlossary(state.glossary, result.glossaryUpdates ?? []);
    state.complete = state.translated.length === state.paragraphs.length;
    state.updatedAt = new Date().toISOString();
    await writeJson(statePath, state);
    console.log("完成");
  }
  return state;
}
