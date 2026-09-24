import { describe, expect, it } from "vitest";

import { feedUrl, releaseVersion, repository } from "./distribution.mjs";
import { appcast, releaseNotes } from "./release.mjs";

const root = new URL("../..", import.meta.url).pathname;

describe("App release", () => {
  it("reads the release version from package.json", async () => {
    expect(await releaseVersion(root)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("has CHANGELOG notes for the current version", async () => {
    const notes = await releaseNotes(await releaseVersion(root));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes).not.toMatch(/^## /m);
  });

  it("rejects a version the CHANGELOG does not describe", async () => {
    await expect(releaseNotes("99.0.0")).rejects.toThrow(/## 99\.0\.0/);
  });

  it("reads the appcast of the latest release on the repository", () => {
    expect(feedUrl).toBe(`https://github.com/${repository}/releases/latest/download/appcast.xml`);
  });

  it("writes one signed item with escaped attributes and intact Markdown notes", () => {
    const xml = appcast({
      version: "1.2.3",
      url: "https://example.com/a.zip?x=1&y=2",
      length: 42,
      signature: "c2lnbmF0dXJl",
      notes: "- one <b>\n- ends ]]> here",
      date: new Date("2026-09-23T00:00:00Z"),
    });
    expect(xml).toContain("<sparkle:version>1.2.3</sparkle:version>");
    expect(xml).toContain("<sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>");
    expect(xml).toContain('url="https://example.com/a.zip?x=1&amp;y=2"');
    expect(xml).toContain('length="42"');
    expect(xml).toContain('sparkle:edSignature="c2lnbmF0dXJl"');
    expect(xml).toContain("<pubDate>Wed, 23 Sep 2026 00:00:00 GMT</pubDate>");
    // A "]]>" in the notes splits the CDATA section instead of ending it early.
    const cdata = [...xml.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((match) => match[1]);
    expect(cdata.join("")).toBe("- one <b>\n- ends ]]> here");
  });
});
