import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { vi } from "vitest";
import type { HarnessSessionState } from "@claude-in-codex/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@claude-in-codex/harness-adapter/testing";
import { MappingStore } from "@claude-in-codex/mapping-store";
import { harnessIdSchema } from "@claude-in-codex/shared-contracts";

export class FakeOfficialProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.stdout.end();
    this.emit("exit", null, signal);
    return true;
  });

  constructor(exitOnInputEnd = true) {
    super();
    this.stdin.once("finish", () => {
      if (!exitOnInputEnd) return;
      this.stdout.end();
      this.emit("exit", 0, null);
    });
  }
}

export class FailingArchiveMappingStore extends MappingStore {
  override setArchived(): Promise<never> {
    return Promise.reject(new Error("Synthetic archive write failure"));
  }
}

export class FailingListMappingStore extends MappingStore {
  override listThreads(): Promise<never> {
    return Promise.reject(new Error("Synthetic list read failure"));
  }
}

export function rollbackCapableAdapter(): FakeHarnessAdapter {
  return new FakeHarnessAdapter(
    harnessIdSchema.parse("pi"),
    undefined,
    true,
    true,
    null,
    undefined,
    true,
  );
}

export class ResumeStateRollbackAdapter extends FakeHarnessAdapter {
  rollbackReplacementStateAtFirstRead: HarnessSessionState | undefined;

  override async open(input: Parameters<FakeHarnessAdapter["open"]>[0]) {
    const opened = await super.open(input);
    if (
      input.kind === "rollbackLastTurn" &&
      opened.ok &&
      opened.value instanceof FakeHarnessSession
    ) {
      const session = opened.value;
      const nativeRef = session.initialState.nativeRef;
      if (nativeRef) session.setStateForSnapshot({ nativeRef });
      const readSnapshot = session.readSnapshot.bind(session);
      session.readSnapshot = async () => {
        this.rollbackReplacementStateAtFirstRead ??= session.state;
        return readSnapshot();
      };
    }
    return opened;
  }
}
