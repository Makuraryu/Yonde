import type { VoiceProfile } from "./config";

export type Paragraph = {
  index: number;
  original: string;
  sentences: string[];
};

export type TranslatedParagraph = Paragraph & {
  translations: string[];
};

const DEFAULT_ENDINGS = ["。", "、", "！", "？"];

function escapeCharacterClass(value: string): string {
  return value.replace(/[\\\]\-^]/g, "\\$&");
}

export function splitSentences(paragraph: string, endings = DEFAULT_ENDINGS): string[] {
  const normalized = paragraph.replace(/\r\n?/g, "\n");
  const punctuation = endings.map(escapeCharacterClass).join("");
  const pattern = new RegExp(`[^${punctuation}\\n]+[${punctuation}]+[」』）】〉》”’"]*|[^${punctuation}\\n]+(?=\\n|$)`, "gu");
  const matches = normalized.match(pattern);
  return (matches ?? [normalized]).map((part) => part.trim()).filter(Boolean);
}

export function parseParagraphs(text: string, endings = DEFAULT_ENDINGS): Paragraph[] {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n\s*\n+/)
    .map((original) => original.trim())
    .filter(Boolean)
    .map((original, index) => ({ index, original, sentences: splitSentences(original, endings) }));
}

export function renderListeningText(
  paragraphs: TranslatedParagraph[],
  sentenceSequence = ["source", "target", "source"],
  profiles?: Record<string, VoiceProfile>,
): string {
  const sequence = profiles
    ? sentenceSequence.map((id) => profiles[id]?.text).filter((value): value is "source" | "target" => Boolean(value))
    : sentenceSequence;
  return paragraphs
    .map((paragraph) => {
      const lines = ["[段落全文]", paragraph.original, "[逐句]"];
      paragraph.sentences.forEach((sentence, index) => {
        for (const text of sequence) lines.push(`-[${text === "target" ? paragraph.translations[index] : sentence}]`);
      });
      lines.push("[/逐句]");
      return lines.join("\n");
    })
    .join("\n\n");
}

export function splitForTts(text: string, maxChars = 380, endings = DEFAULT_ENDINGS): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = splitSentences(text, endings);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) chunks.push(current);
      for (let start = 0; start < sentence.length; start += maxChars) chunks.push(sentence.slice(start, start + maxChars));
      current = "";
    } else if (current && current.length + sentence.length > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
