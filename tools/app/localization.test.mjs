import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const localization = path.join(root, "apps/macos/localization");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const unescape = (text) =>
  text.replace(/\\(.)/gu, (_, character) => (character === "n" ? "\n" : character));
const literals = (source, pattern) =>
  [...source.matchAll(pattern)].map((match) => unescape(match[1]));

/** The English source text: every tr("…") key in the App, and the feature problems the Host sends. */
const appKeys = new Set(literals(read("apps/macos/main.swift"), /\btr\("((?:[^"\\]|\\.)*)"/gu));
const hostKeys = new Set(
  literals(
    read("packages/host-runtime/src/hot-attach/features.ts"),
    /(?:return|\?|:)\s*"((?:[^"\\]|\\.)* (?:[^"\\]|\\.)*)"/gu,
  ),
);
const sourceKeys = new Set([...appKeys, ...hostKeys]);

/** A .strings table as key and value pairs. */
function strings(file) {
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  return new Map(
    [...text.matchAll(/^"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)";$/gmu)].map((match) => [
      unescape(match[1]),
      unescape(match[2]),
    ]),
  );
}
const specifiers = (text) => (text.replaceAll("%%", "").match(/%(?:\d+\$)?[@d]/gu) ?? []).sort();

const translations = readdirSync(localization)
  .filter((language) => language !== "en.lproj")
  .map((language) => [language, strings(path.join(localization, language, "Localizable.strings"))]);

describe("App localization", () => {
  it("finds the source text", () => {
    expect(appKeys.size).toBeGreaterThan(50);
    expect(hostKeys).toContain("Codex's memory summary is empty");
    expect(translations.map(([language]) => language)).toContain("zh-Hans.lproj");
  });

  it.each(translations)("%s translates every source text and nothing else", (_, table) => {
    expect([...sourceKeys].filter((key) => !table.has(key))).toEqual([]);
    expect([...table.keys()].filter((key) => !sourceKeys.has(key))).toEqual([]);
  });

  it.each(translations)("%s keeps each text's format arguments", (_, table) => {
    for (const [key, value] of table) expect(specifiers(value), key).toEqual(specifiers(key));
  });

  it("gives English plurals only for text the App uses", () => {
    const plurals = read("apps/macos/localization/en.lproj/Localizable.stringsdict");
    const keys = literals(plurals, /^\t<key>([^<]+)<\/key>$/gmu);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !appKeys.has(key))).toEqual([]);
  });
});
