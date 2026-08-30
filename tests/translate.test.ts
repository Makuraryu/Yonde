import { describe, expect, test } from "bun:test";
import { coalesceSingletonTranslations } from "../src/translate";

describe("translation alignment repair", () => {
  test("coalesces a model-split singleton translation in order", () => {
    expect(coalesceSingletonTranslations(["相对来说，", "就是这样。"])).toBe("相对来说，就是这样。");
  });

  test("rejects empty, invalid, and already aligned values", () => {
    expect(coalesceSingletonTranslations([])).toBeUndefined();
    expect(coalesceSingletonTranslations(["完整译文"])).toBeUndefined();
    expect(coalesceSingletonTranslations(["译文", ""])).toBeUndefined();
    expect(coalesceSingletonTranslations(["译文", 2])).toBeUndefined();
  });
});
