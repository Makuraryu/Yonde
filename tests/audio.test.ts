import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioMergeFingerprint, buildPlan, mergeStateCanRecover, profileForText } from "../src/audio";
import { DEFAULT_CONFIG } from "../src/config";

describe("audio planning", () => {
  test("follows configurable paragraph and sentence order", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.audio.paragraphSequence = ["sentences", "source_full"];
    config.audio.sentenceSequence = ["target_normal", "source_slow"];
    const plan = buildPlan([{
      index: 0,
      original: "猫だ。",
      sentences: ["猫だ。"],
      translations: ["是猫。"],
    }], config);
    expect(plan.map((item) => item.type === "separator" ? "separator" : `${item.spec.kind}:${item.spec.text}`)).toEqual([
      "target_normal:是猫。",
      "source_slow:猫だ。",
      "source_full:猫だ。",
    ]);
  });

  test("allows repeating a profile", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.audio.paragraphSequence = ["sentences"];
    config.audio.sentenceSequence = ["source_slow", "source_slow"];
    const plan = buildPlan([{ index: 0, original: "猫。", sentences: ["猫。"], translations: ["猫。"] }], config);
    expect(plan).toHaveLength(2);
  });

  test("uses a Japanese voice for kana-only text unsupported by a target voice", () => {
    const target = DEFAULT_CONFIG.audio.profiles.target_normal;
    const selected = profileForText(target, "ひたぎ，", DEFAULT_CONFIG.audio.profiles);
    expect(selected.language).toBe("ja-JP");
    expect(selected.voice).toBe(DEFAULT_CONFIG.audio.profiles.source_full.voice);
    expect(selected.rate).toBe(target.rate);
    expect(profileForText(target, "战场原同学，", DEFAULT_CONFIG.audio.profiles)).toBe(target);
  });

  test("fingerprints merge order and only recovers completed matching output", () => {
    const body = {
      profiles: DEFAULT_CONFIG.audio.profiles,
      paragraphSequence: DEFAULT_CONFIG.audio.paragraphSequence,
      sentenceSequence: DEFAULT_CONFIG.audio.sentenceSequence,
      separator: DEFAULT_CONFIG.audio.separator,
      items: [
        { kind: "source_full", text: "猫。", path: "/tmp/cat.mp3", startMs: 0, endMs: 1000, durationMs: 1000 },
        { kind: "source_slow", text: "犬。", path: "/tmp/dog.mp3", startMs: 1000, endMs: 2200, durationMs: 1200 },
      ],
    };
    const fingerprint = audioMergeFingerprint(body);
    expect(audioMergeFingerprint({ ...body, items: [...body.items].reverse() })).not.toBe(fingerprint);
    expect(audioMergeFingerprint({ ...body, items: [...body.items, { ...body.items[0], text: "鳥。" }] })).not.toBe(fingerprint);
    expect(audioMergeFingerprint({ ...body, items: body.items.map((item, index) => index === 1 ? { ...item, endMs: 2300, durationMs: 1300 } : item) })).not.toBe(fingerprint);
    expect(mergeStateCanRecover({
      version: 1,
      fingerprint,
      temporary: join(tmpdir(), "yonde-merge-test", "book.mp3.tmp.mp3"),
      status: "complete",
      expectedSeconds: 10,
    }, fingerprint, "/tmp/book.mp3")).toBe(true);
    expect(mergeStateCanRecover({
      version: 1,
      fingerprint,
      temporary: join(tmpdir(), "yonde-merge-test", "book.mp3.tmp.mp3"),
      status: "merging",
      expectedSeconds: 10,
    }, fingerprint, "/tmp/book.mp3")).toBe(false);
  });
});
