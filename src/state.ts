import { open, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Paragraph, TranslatedParagraph } from "./text";

export type GlossaryEntry = { source: string; target: string };

export type TranslationState = {
  version: 2;
  inputPath: string;
  inputHash: string;
  configHash: string;
  paragraphs: Paragraph[];
  translated: TranslatedParagraph[];
  glossary: GlossaryEntry[];
  complete: boolean;
  updatedAt: string;
};

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return (await Bun.file(path).json()) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}
