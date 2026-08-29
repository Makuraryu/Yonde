import { describe, expect, test } from "bun:test";
import { buildPlan } from "../src/audio";
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
});
