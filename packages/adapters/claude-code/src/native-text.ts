/**
 * The text Claude Code shows for an Assistant message, as opposed to what the model streamed.
 *
 * Claude Code rewrites the complete Assistant message it reports over the SDK and keeps the raw
 * model output in its transcript: it removes the `<cc-memory>` tags the model uses to cite a
 * memory file, but only after streaming them as ordinary text deltas. Every path that shows
 * Claude text (live deltas, the complete message, and history read from the transcript) passes
 * it through this module so all three agree. The tag names and the 1024-character attribute
 * bound mirror Claude Code's own rule.
 */

const MEMORY_TAG_NAMES = [
  "cc-memory",
  "cc_memory",
  "ccmemory",
  "CC-MEMORY",
  "CC_MEMORY",
  "CCMEMORY",
];
const TAG_NAME = `(?:${MEMORY_TAG_NAMES.join("|")})`;
const TAG_ATTRIBUTES = "[^>]{0,1024}";
const TAG_NAME_PREFIX = `(?:${MEMORY_TAG_NAMES.flatMap((name) =>
  Array.from(name, (_character, index) => name.slice(0, index + 1)),
).join("|")})`;

const memoryTagPattern = new RegExp(`</?${TAG_NAME}(?=[\\s/>])${TAG_ATTRIBUTES}>`, "g");
/** A trailing fragment that could still grow into a memory tag once more text arrives. */
const partialMemoryTagPattern = new RegExp(
  `</?(?:${TAG_NAME}(?![^\\s/>])${TAG_ATTRIBUTES}|${TAG_NAME_PREFIX})?$`,
);

/** The text Claude Code shows for a complete Assistant text or thinking block. */
export function visibleClaudeText(text: string): string {
  return text.replace(memoryTagPattern, "");
}

/**
 * Applies {@link visibleClaudeText} to a stream of deltas. A delta that ends inside what may
 * become a memory tag is held back until the next delta settles it, so a tag split across
 * deltas never reaches the user.
 */
export class ClaudeVisibleTextStream {
  #held = "";

  push(delta: string): string {
    const text = visibleClaudeText(this.#held + delta);
    const partial = partialMemoryTagPattern.exec(text);
    const visibleLength = partial ? partial.index : text.length;
    this.#held = text.slice(visibleLength);
    return text.slice(0, visibleLength);
  }
}

/**
 * Where streamed text and the complete message part ways, described by length and character
 * class only so the Host log shows the shape of the difference (a stray tag, a dropped
 * suffix) without recording what Claude said.
 */
export function describeTextDivergence(streamed: string, complete: string): string {
  let offset = 0;
  while (
    offset < streamed.length &&
    offset < complete.length &&
    streamed[offset] === complete[offset]
  ) {
    offset += 1;
  }
  const around = (text: string) => JSON.stringify(textShape(text.slice(offset, offset + 40)));
  return (
    `streamed ${streamed.length} chars, complete ${complete.length} chars, ` +
    `first difference at ${offset}: streamed ${around(streamed)}, complete ${around(complete)}`
  );
}

function textShape(text: string): string {
  return text.replace(/\p{L}/gu, "a").replace(/\p{N}/gu, "9").replace(/\s/gu, " ");
}
