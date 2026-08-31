import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTimeline, createLyricsTag, lyricsCues, prependLyricsTag, renderLrc } from "../src/lyrics";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("synchronised lyrics", () => {
  test("builds cues from the actual audio order and advances across separators", () => {
    const timeline = buildTimeline([
      { kind: "source", text: "猫だ。", path: "source.mp3" },
      { kind: "separator", path: "separator.mp3" },
      { kind: "punctuation", text: "。", path: "punctuation.mp3" },
      { kind: "target", text: "是猫。", path: "target.mp3" },
    ], new Map([
      ["source.mp3", 1250.5],
      ["separator.mp3", 200],
      ["punctuation.mp3", 700],
      ["target.mp3", 800],
    ]));

    expect(timeline.map((item) => [item.startMs, item.endMs])).toEqual([
      [0, 1250.5],
      [1250.5, 1450.5],
      [1450.5, 2150.5],
      [2150.5, 2950.5],
    ]);
    expect(lyricsCues(timeline)).toEqual([
      { text: "猫だ。", startMs: 0, endMs: 1250.5 },
      { text: "是猫。", startMs: 2150.5, endMs: 2950.5 },
    ]);
  });

  test("renders LRC timestamps for recordings longer than one hour", () => {
    expect(renderLrc([
      { text: "开头", startMs: 0, endMs: 1000 },
      { text: "继续", startMs: 3_723_456, endMs: 3_724_000 },
    ])).toBe("[00:00.00]开头\n[62:03.45]继续\n");
  });

  test("writes real USLT and SYLT frames and preserves the MP3 bytes", async () => {
    const cues = [
      { text: "猫だ。", startMs: 0, endMs: 1000 },
      { text: "是猫。", startMs: 1200, endMs: 2000 },
    ];
    const tag = Buffer.from(createLyricsTag(cues));
    expect(tag.subarray(0, 5)).toEqual(Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00]));
    expect(tag.indexOf("USLT")).toBeGreaterThanOrEqual(10);
    expect(tag.indexOf("SYLT")).toBeGreaterThanOrEqual(10);
    expect(tag.indexOf("TXXX")).toBe(-1);

    const directory = await mkdtemp(join(tmpdir(), "yonde-lyrics-"));
    temporaryDirectories.push(directory);
    const input = join(directory, "input.mp3");
    const output = join(directory, "output.mp3");
    const audio = Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);
    await writeFile(input, audio);
    await prependLyricsTag(input, output, cues);
    const tagged = await readFile(output);
    const tagSize = 10 + ((tagged[6] & 0x7f) << 21) + ((tagged[7] & 0x7f) << 14)
      + ((tagged[8] & 0x7f) << 7) + (tagged[9] & 0x7f);
    expect(tagged.subarray(tagSize)).toEqual(audio);
  });

  test("rejects missing or invalid segment durations", () => {
    expect(() => buildTimeline([{ kind: "source", text: "猫", path: "missing.mp3" }], new Map()))
      .toThrow("无法取得音频片段时长");
  });
});
