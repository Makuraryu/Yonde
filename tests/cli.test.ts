import { describe, expect, test } from "bun:test";
import { HELP_TEXT, parseArgs } from "../src/main";

describe("CLI arguments", () => {
  test("accepts config, stage, and output options around the input", () => {
    expect(parseArgs(["--config", "custom.toml", "book.txt", "--stage", "audio", "--output-dir", "build"])).toEqual({
      command: "run",
      input: "book.txt",
      stage: "audio",
      outputDir: "build",
      configPath: "custom.toml",
    });
  });

  test("supports init and config check commands", () => {
    expect(parseArgs(["init", "custom.toml"])).toEqual({ command: "init", path: "custom.toml" });
    expect(parseArgs(["config", "check", "--config", "custom.toml"])).toEqual({ command: "config-check", configPath: "custom.toml" });
  });

  test("documents every command and option in help", () => {
    for (const text of ["Yonde", "--stage", "--config", "--output-dir", "config check", "init", "github:Makuraryu/Yonde"]) {
      expect(HELP_TEXT).toContain(text);
    }
  });
});
