import { describe, expect, test } from "bun:test";
import { parseParagraphs, renderListeningText, splitForTts, splitSentences } from "../src/text";

describe("text processing", () => {
  test("splits on requested Japanese punctuation and keeps it", () => {
    expect(splitSentences("彼は言った、そうだ！「本当？」はい。残り")).toEqual([
      "彼は言った、", "そうだ！", "「本当？」", "はい。", "残り",
    ]);
  });

  test("uses blank lines as paragraph boundaries", () => {
    const paragraphs = parseParagraphs("題名\n副題\n\n本文です。\n\n次です！");
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0].sentences).toEqual(["題名", "副題"]);
  });

  test("renders the requested three-line sentence pattern", () => {
    const output = renderListeningText([{ index: 0, original: "猫だ。", sentences: ["猫だ。"], translations: ["是猫。"] }]);
    expect(output).toContain("-[猫だ。]\n-[是猫。]\n-[猫だ。]");
  });

  test("supports configurable sentence endings", () => {
    expect(splitSentences("One;Two.Three", [";", "."])).toEqual(["One;", "Two.", "Three"]);
  });

  test("tts chunks stay bounded", () => {
    expect(splitForTts("一。二。三。", 4)).toEqual(["一。二。", "三。"]);
  });
});
