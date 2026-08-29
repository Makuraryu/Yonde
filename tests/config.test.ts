import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, loadConfig, translationFingerprint, validateConfig } from "../src/config";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("configuration", () => {
  test("loads TOML overrides on top of defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yonde-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "custom.toml");
    await Bun.write(path, `version = 1\n[translation]\nsource_language = "en"\ntarget_language = "fr"\n[audio]\nsentence_sequence = ["target_normal"]\n`);
    const { config } = await loadConfig(path, directory);
    expect(config.translation.sourceLanguage).toBe("en");
    expect(config.translation.targetLanguage).toBe("fr");
    expect(config.audio.sentenceSequence).toEqual(["target_normal"]);
    expect(config.audio.profiles.target_normal.voice).toBe("zh-CN-YunxiNeural");
  });

  test("discovers project-local configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yonde-project-"));
    temporaryDirectories.push(directory);
    await Bun.write(join(directory, "yonde.toml"), `version = 1\n[translation]\ntarget_language = "en"\n`);
    const { config, path } = await loadConfig(undefined, directory);
    expect(config.translation.targetLanguage).toBe("en");
    expect(path).toBe(join(directory, "yonde.toml"));
  });

  test("explicit config overrides project config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yonde-priority-"));
    temporaryDirectories.push(directory);
    await Bun.write(join(directory, "yonde.toml"), `version = 1\n[translation]\ntarget_language = "en"\n`);
    await Bun.write(join(directory, "custom.toml"), `version = 1\n[translation]\ntarget_language = "ko"\n`);
    const { config, path } = await loadConfig("custom.toml", directory);
    expect(config.translation.targetLanguage).toBe("ko");
    expect(path).toBe(join(directory, "custom.toml"));
  });

  test("rejects references to unknown voice profiles", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.audio.sentenceSequence = ["missing"];
    expect(() => validateConfig(config)).toThrow("未知 profile");
  });

  test("rejects misspelled configuration keys", () => {
    const config = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
    (config.translation as Record<string, unknown>).targetLanguge = "en";
    expect(() => validateConfig(config)).toThrow("translation.targetLanguge");
  });

  test("rejects insecure endpoints, traversal assets, and prototype profile names", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.translation.api.endpoint = "http://example.com/chat/completions";
    expect(() => validateConfig(config)).toThrow("HTTPS");
    config.translation.api.endpoint = "https://example.com/chat/completions";
    config.audio.separator.packageAsset = "uisfx/sounds/../LICENSE.mp3";
    expect(() => validateConfig(config)).toThrow("uisfx/sounds");
    config.audio.separator.packageAsset = "uisfx/sounds/cinematic/select.mp3";
    config.audio.sentenceSequence = ["toString"];
    expect(() => validateConfig(config)).toThrow("未知 profile");
  });

  test("translation fingerprint excludes API keys and audio order", () => {
    const left = structuredClone(DEFAULT_CONFIG);
    const right = structuredClone(DEFAULT_CONFIG);
    left.translation.api.apiKey = "one";
    right.translation.api.apiKey = "two";
    right.audio.sentenceSequence.reverse();
    expect(translationFingerprint(left)).toBe(translationFingerprint(right));
    right.translation.targetLanguage = "en";
    expect(translationFingerprint(left)).not.toBe(translationFingerprint(right));
  });
});
