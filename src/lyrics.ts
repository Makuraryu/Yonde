import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { ID3Writer } from "browser-id3-writer";

export type AudioTimelineItem = {
  kind: string;
  text?: string;
  path: string;
  startMs: number;
  endMs: number;
  durationMs: number;
};

export type LyricsCue = { text: string; startMs: number; endMs: number };

export function buildTimeline(
  items: Array<{ kind: string; text?: string; path: string }>,
  durations: ReadonlyMap<string, number>,
): AudioTimelineItem[] {
  let positionMs = 0;
  return items.map((item) => {
    const durationMs = durations.get(item.path);
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error(`无法取得音频片段时长: ${item.path}`);
    }
    const timed = { ...item, startMs: positionMs, endMs: positionMs + durationMs, durationMs };
    positionMs = timed.endMs;
    return timed;
  });
}

export function lyricsCues(items: AudioTimelineItem[]): LyricsCue[] {
  return items
    .filter((item) => item.text && /[\p{L}\p{N}]/u.test(item.text))
    .map((item) => ({ text: item.text!, startMs: item.startMs, endMs: item.endMs }));
}

function lrcTimestamp(milliseconds: number): string {
  const centiseconds = Math.floor(milliseconds / 10);
  const minutes = Math.floor(centiseconds / 6000);
  const seconds = Math.floor((centiseconds % 6000) / 100);
  const fraction = centiseconds % 100;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

export function renderLrc(cues: LyricsCue[]): string {
  return cues.map((cue) => `[${lrcTimestamp(cue.startMs)}]${cue.text}`).join("\n") + "\n";
}

export function createLyricsTag(cues: LyricsCue[]): Uint8Array {
  if (cues.length === 0) throw new Error("没有可写入 MP3 的同步文本");
  const writer = new ID3Writer(new ArrayBuffer(0));
  writer
    .setFrame("USLT", {
      language: "mul",
      description: "Yonde bilingual transcript",
      lyrics: cues.map((cue) => cue.text).join("\n"),
    })
    .setFrame("SYLT", {
      language: "mul",
      description: "Yonde bilingual transcript",
      type: 2,
      timestampFormat: 2,
      text: cues.map((cue) => [cue.text, Math.round(cue.startMs)] as const),
    });
  return new Uint8Array(writer.addTag());
}

export async function prependLyricsTag(inputPath: string, outputPath: string, cues: LyricsCue[]): Promise<void> {
  const tag = createLyricsTag(cues);
  async function* taggedAudio() {
    yield tag;
    for await (const chunk of createReadStream(inputPath)) yield chunk;
  }
  await pipeline(taggedAudio(), createWriteStream(outputPath, { flags: "wx" }));
}
