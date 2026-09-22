import { randomUUID } from "node:crypto";

import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

/** Mirrors the official `QueuedSubmission` wire shape plus the text the Host will send. */
export interface QueuedSubmission {
  id: string;
  input: JsonObject[];
  clientUserMessageId: string;
  text: string;
}

export class ExternalQueueError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** Official Codex bounds the per-Thread queue; the Host keeps the same defensive cap. */
export const EXTERNAL_QUEUE_CAPACITY = 64;

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text of a Desktop `input` array, validated the way `turn/steer` validates it. */
export function queuedInputText(input: JsonValue | undefined): {
  input: JsonObject[];
  text: string;
} {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ExternalQueueError(-32602, "Queued submissions require input");
  }
  const items = input.map((item) => {
    if (!isRecord(item)) {
      throw new ExternalQueueError(-32602, "Queued submissions require text input");
    }
    return item;
  });
  const text = items
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  if (!text.trim()) {
    throw new ExternalQueueError(-32602, "Queued submissions require text input");
  }
  return { input: items, text };
}

function submissionView(submission: QueuedSubmission): JsonObject {
  return {
    id: submission.id,
    input: submission.input,
    clientUserMessageId: submission.clientUserMessageId,
  };
}

/**
 * Host-owned per-Thread queue of user messages for external Harnesses that run one Turn at a
 * time. The Host drains it after a Turn completes; nothing native to the Harness is involved.
 */
export class ExternalThreadQueue {
  readonly #queues = new Map<string, QueuedSubmission[]>();

  constructor(readonly capacity = EXTERNAL_QUEUE_CAPACITY) {}

  size(threadId: string): number {
    return this.#queues.get(threadId)?.length ?? 0;
  }

  add(threadId: string, params: JsonObject): QueuedSubmission {
    const clientUserMessageId = params.clientUserMessageId;
    if (typeof clientUserMessageId !== "string" || !clientUserMessageId.trim()) {
      throw new ExternalQueueError(-32602, "Queued submissions require clientUserMessageId");
    }
    const { input, text } = queuedInputText(params.input);
    const queue = this.#queue(threadId);
    if (queue.length >= this.capacity) {
      throw new ExternalQueueError(-32602, "External Thread message queue is full");
    }
    const submission: QueuedSubmission = { id: randomUUID(), input, text, clientUserMessageId };
    queue.push(submission);
    return submission;
  }

  list(threadId: string, params: JsonObject): { data: JsonObject[]; nextCursor: string | null } {
    const cursor = params.cursor;
    let offset = 0;
    if (cursor !== undefined && cursor !== null) {
      offset = typeof cursor === "string" && /^\d+$/u.test(cursor) ? Number(cursor) : Number.NaN;
      if (!Number.isSafeInteger(offset)) {
        throw new ExternalQueueError(-32602, "Queue pagination cursor is invalid");
      }
    }
    const limitParam = params.limit;
    let limit = DEFAULT_PAGE_SIZE;
    if (limitParam !== undefined && limitParam !== null) {
      if (!Number.isSafeInteger(limitParam) || (limitParam as number) < 0) {
        throw new ExternalQueueError(-32602, "Queue page limit must be a non-negative integer");
      }
      limit = Math.min(MAX_PAGE_SIZE, Math.max(1, limitParam as number));
    }
    const queue = this.#queues.get(threadId) ?? [];
    const page = queue.slice(offset, offset + limit);
    return {
      data: page.map(submissionView),
      nextCursor: offset + limit < queue.length ? String(offset + limit) : null,
    };
  }

  update(threadId: string, params: JsonObject): QueuedSubmission {
    const submission = this.#find(threadId, params.queuedSubmissionId);
    const { input, text } = queuedInputText(params.input);
    submission.input = input;
    submission.text = text;
    return submission;
  }

  delete(threadId: string, queuedSubmissionId: JsonValue | undefined): boolean {
    if (typeof queuedSubmissionId !== "string") {
      throw new ExternalQueueError(-32602, "Queue operations require queuedSubmissionId");
    }
    const queue = this.#queues.get(threadId);
    if (!queue) return false;
    const index = queue.findIndex((submission) => submission.id === queuedSubmissionId);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (queue.length === 0) this.#queues.delete(threadId);
    return true;
  }

  reorder(threadId: string, queuedSubmissionIds: JsonValue | undefined): void {
    const queue = this.#queues.get(threadId) ?? [];
    const ids = Array.isArray(queuedSubmissionIds) ? queuedSubmissionIds : null;
    const valid =
      ids !== null &&
      ids.length === queue.length &&
      new Set(ids).size === ids.length &&
      ids.every((id) => typeof id === "string" && queue.some((entry) => entry.id === id));
    if (!valid) {
      throw new ExternalQueueError(
        -32602,
        "queue reorder must include every queued submission exactly once",
      );
    }
    if (queue.length === 0) return;
    const byId = new Map(queue.map((submission) => [submission.id, submission]));
    const reordered = ids.flatMap((id) => {
      const submission = byId.get(id as string);
      return submission ? [submission] : [];
    });
    queue.splice(0, queue.length, ...reordered);
  }

  /** Removes and returns the head, or the named submission. */
  take(threadId: string, queuedSubmissionId?: JsonValue): QueuedSubmission | undefined {
    const queue = this.#queues.get(threadId);
    if (!queue || queue.length === 0) {
      if (queuedSubmissionId !== undefined && queuedSubmissionId !== null) {
        throw new ExternalQueueError(-32602, "queued submission not found");
      }
      return undefined;
    }
    let index = 0;
    if (queuedSubmissionId !== undefined && queuedSubmissionId !== null) {
      index = queue.findIndex((submission) => submission.id === queuedSubmissionId);
      if (index < 0) throw new ExternalQueueError(-32602, "queued submission not found");
    }
    const [submission] = queue.splice(index, 1);
    if (queue.length === 0) this.#queues.delete(threadId);
    return submission;
  }

  /** Puts a submission back at the head after a start that did not reach the Harness. */
  restore(threadId: string, submission: QueuedSubmission): void {
    this.#queue(threadId).unshift(submission);
  }

  clear(threadId: string): void {
    this.#queues.delete(threadId);
  }

  view(submission: QueuedSubmission): JsonObject {
    return submissionView(submission);
  }

  #queue(threadId: string): QueuedSubmission[] {
    let queue = this.#queues.get(threadId);
    if (!queue) {
      queue = [];
      this.#queues.set(threadId, queue);
    }
    return queue;
  }

  #find(threadId: string, queuedSubmissionId: JsonValue | undefined): QueuedSubmission {
    if (typeof queuedSubmissionId !== "string") {
      throw new ExternalQueueError(-32602, "Queue operations require queuedSubmissionId");
    }
    const submission = this.#queues.get(threadId)?.find((entry) => entry.id === queuedSubmissionId);
    if (!submission) throw new ExternalQueueError(-32602, "queued submission not found");
    return submission;
  }
}
