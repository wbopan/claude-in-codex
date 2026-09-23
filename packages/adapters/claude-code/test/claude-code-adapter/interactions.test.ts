import { describe, expect, it } from "vitest";

import { fixture, nextEvent, nextInteraction, openSession, textTurn } from "./fixture.js";

describe("Claude Code HarnessAdapter", () => {
  it.each(["approve", "stay", "cancel"] as const)(
    "presents ExitPlanMode as an explicit plan review and maps %s to the native permission decision",
    async (choice) => {
      const { adapter, transports } = fixture();
      const session = await openSession(adapter);
      const iterator = session.outputs[Symbol.asyncIterator]();
      await session.execute(textTurn("plan-review"));
      await nextEvent(iterator);
      await nextEvent(iterator);
      await nextEvent(iterator);
      const transport = transports[0];
      if (!transport) throw new Error("Fake Claude transport was not created");
      transport.changePermissionMode("plan");
      await nextEvent(iterator);
      const plan = `# Implementation plan\n${"Read, edit, verify.\n".repeat(100)}`;
      transport.event({
        type: "interaction.requested",
        request: { type: "planApproval", requestId: "exit-plan", plan },
      });
      const interaction = await nextInteraction(iterator);
      expect(interaction).toMatchObject({
        type: "question",
        title: "Review plan",
        questions: [
          {
            id: "plan-decision",
            type: "choice",
            multiple: false,
            allowOther: false,
            optional: false,
            options: [
              { value: "stay", label: "Stay in plan mode" },
              { value: "approve", label: "Approve plan and exit plan mode" },
            ],
          },
        ],
      });
      if (interaction.type !== "question") throw new Error("Expected a plan review Question");
      expect(interaction.questions[0]?.prompt).toContain(plan);
      expect(interaction.questions[0]?.prompt).toContain(
        "restore the permission mode used before planning",
      );
      for (const response of [
        { type: "approval" as const, actionId: "allowOnce" },
        { type: "question" as const, answers: { "plan-decision": ["allowOnce"] } },
        { type: "question" as const, answers: { "plan-decision": ["approve", "stay"] } },
        { type: "question" as const, answers: {} },
      ]) {
        await expect(
          session.execute({
            type: "interaction.respond",
            interactionId: interaction.interactionId,
            response,
          }),
        ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      }
      expect(transport.respondToInteraction).not.toHaveBeenCalled();
      await expect(
        session.execute({
          type: "interaction.respond",
          interactionId: interaction.interactionId,
          response:
            choice === "cancel"
              ? { type: "question", answers: {}, cancelled: true }
              : { type: "question", answers: { "plan-decision": [choice] } },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(transport.respondToInteraction).toHaveBeenLastCalledWith({
        type: "approval",
        requestId: "exit-plan",
        decision: choice === "approve" ? "allowOnce" : "deny",
      });
      expect(transport.setPermissionMode).not.toHaveBeenCalled();
      expect(await nextEvent(iterator)).toMatchObject({
        type: "interaction.closed",
        interactionId: interaction.interactionId,
      });
      await expect(
        session.execute({
          type: "interaction.respond",
          interactionId: interaction.interactionId,
          response: { type: "question", answers: { "plan-decision": ["approve"] } },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
      transport.finish({ status: "succeeded" });
      await session.close();
    },
  );

  it("does not offer plan approval when Claude provides no plan text", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("missing-plan"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.event({
      type: "interaction.requested",
      request: { type: "planApproval", requestId: "exit-plan", plan: null },
    });
    const interaction = await nextInteraction(iterator);
    expect(interaction).toMatchObject({
      type: "question",
      questions: [{ options: [{ value: "stay" }] }],
    });
    if (interaction.type !== "question" || interaction.questions[0]?.type !== "choice")
      throw new Error("Expected plan choice");
    expect(interaction.questions[0].options).toHaveLength(1);
    expect(interaction.questions[0].prompt).toContain("did not provide plan text");
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: { "plan-decision": ["approve"] } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(transports[0]?.respondToInteraction).not.toHaveBeenCalled();
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it("maps independent native Approvals to bounded Host actions and exact responses", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("approvals"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "transport-approval-1",
      title: "Allow Edit?",
      description: "One-shot edit permission",
    });
    transports[0]?.approval({
      type: "approval",
      requestId: "transport-approval-2",
      title: "Allow Bash?",
    });
    const allowInteraction = await nextInteraction(iterator);
    const denyInteraction = await nextInteraction(iterator);
    expect(allowInteraction).toMatchObject({
      type: "approval",
      title: "Allow Edit?",
      description: "One-shot edit permission",
      subject: { type: "nativeAction" },
      actions: [
        { id: "allowOnce", label: "Allow once", effect: "allowOnce" },
        { id: "deny", label: "Deny", effect: "deny" },
      ],
    });
    expect(denyInteraction).toMatchObject({ type: "approval", title: "Allow Bash?" });
    expect(allowInteraction.interactionId).not.toBe(denyInteraction.interactionId);
    expect(JSON.stringify(allowInteraction)).not.toContain("transport-approval-1");

    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: allowInteraction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: allowInteraction.interactionId,
        response: { type: "approval", actionId: "allowForSession" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });

    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: denyInteraction.interactionId,
        response: { type: "approval", actionId: "deny" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transports[0]?.respondToInteraction).toHaveBeenLastCalledWith({
      type: "approval",
      requestId: "transport-approval-2",
      decision: "deny",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: denyInteraction.interactionId,
      reason: "responded",
    });

    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: allowInteraction.interactionId,
        response: { type: "approval", actionId: "allowOnce" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transports[0]?.respondToInteraction).toHaveBeenLastCalledWith({
      type: "approval",
      requestId: "transport-approval-1",
      decision: "allowOnce",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: allowInteraction.interactionId,
      reason: "responded",
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: allowInteraction.interactionId,
        response: { type: "approval", actionId: "allowOnce" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });

    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("maps declared native suggestion scopes without exposing suggestions", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("approval-scopes"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "session-approval",
      title: "Allow Edit?",
      suggestedScope: "session",
    });
    transports[0]?.approval({
      type: "approval",
      requestId: "always-approval",
      title: "Allow Bash?",
      suggestedScope: "always",
    });
    const sessionInteraction = await nextInteraction(iterator);
    const alwaysInteraction = await nextInteraction(iterator);
    expect(sessionInteraction).toMatchObject({
      type: "approval",
      actions: expect.arrayContaining([
        {
          id: "allowForSession",
          label: "Allow this conversation",
          effect: "allowForSession",
        },
      ]),
    });
    expect(alwaysInteraction).toMatchObject({
      type: "approval",
      actions: expect.arrayContaining([
        { id: "allowAlways", label: "Always allow", effect: "allowAlways" },
      ]),
    });
    expect(JSON.stringify([sessionInteraction, alwaysInteraction])).not.toContain(
      "session-approval",
    );

    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: sessionInteraction.interactionId,
        response: { type: "approval", actionId: "allowAlways" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await session.execute({
      type: "interaction.respond",
      interactionId: sessionInteraction.interactionId,
      response: { type: "approval", actionId: "allowForSession" },
    });
    expect(transports[0]?.respondToInteraction).toHaveBeenLastCalledWith({
      type: "approval",
      requestId: "session-approval",
      decision: "allowForSession",
    });
    await nextEvent(iterator);
    await session.execute({
      type: "interaction.respond",
      interactionId: alwaysInteraction.interactionId,
      response: { type: "approval", actionId: "allowAlways" },
    });
    expect(transports[0]?.respondToInteraction).toHaveBeenLastCalledWith({
      type: "approval",
      requestId: "always-approval",
      decision: "allowAlways",
    });
    await nextEvent(iterator);

    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("closes a pending Approval before Session-close Turn terminals", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("close-approval"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "close-approval-request",
      title: "Allow pending action?",
    });
    const interaction = await nextInteraction(iterator);

    await session.close();
    const terminalEvents = [];
    for (;;) {
      const output = await iterator.next();
      if (output.done) break;
      if (output.value.kind === "event") terminalEvents.push(output.value.event);
    }
    const closedIndex = terminalEvents.findIndex(
      (event) =>
        event.type === "interaction.closed" && event.interactionId === interaction.interactionId,
    );
    const turnIndex = terminalEvents.findIndex((event) => event.type === "turn.completed");
    expect(closedIndex).toBeGreaterThanOrEqual(0);
    expect(closedIndex).toBeLessThan(turnIndex);
    expect(
      terminalEvents.filter(
        (event) =>
          event.type === "interaction.closed" && event.interactionId === interaction.interactionId,
      ),
    ).toHaveLength(1);
    expect(transports[0]?.close).toHaveBeenCalledOnce();
  });

  it("round-trips native multiple, multi-select, and Other Questions then continues", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("question"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.question({
      type: "question",
      requestId: "question-request",
      questions: [
        {
          question: "Which path?",
          header: "Path",
          options: [
            { label: "Alpha", description: "First" },
            { label: "Beta", description: "Second" },
          ],
          multiSelect: false,
        },
        {
          question: "Which features?",
          header: "Features",
          options: [
            { label: "Search", description: "Enable search" },
            { label: "Export", description: "Enable export" },
          ],
          multiSelect: true,
        },
      ],
    });
    const interaction = await nextInteraction(iterator);
    expect(interaction).toMatchObject({
      type: "question",
      title: "Claude Code",
      questions: [
        {
          id: "question-1",
          type: "choice",
          multiple: false,
          allowOther: true,
          options: [{ value: "Alpha", description: "First" }, { value: "Beta" }],
        },
        {
          id: "question-2",
          type: "choice",
          multiple: true,
          allowOther: true,
        },
      ],
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: { "question-1": ["Alpha"] } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: {
          type: "question",
          answers: {
            "question-1": ["Alpha"],
            "question-2": ["Search", "Custom feature"],
          },
        },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transports[0]?.respondToInteraction).toHaveBeenCalledWith({
      type: "question",
      requestId: "question-request",
      answers: {
        "Which path?": "Alpha",
        "Which features?": "Search, Custom feature",
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: interaction.interactionId,
      reason: "responded",
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    await session.execute(textTurn("continued"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.delta("continued");
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    expect(transports[0]?.start).toHaveBeenCalledOnce();
    await session.close();
  });

  it("maps Desktop dismissal to native Question cancellation", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("dismissed"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.question({
      type: "question",
      requestId: "dismiss-request",
      questions: [
        {
          question: "Continue?",
          header: "Continue",
          options: [
            { label: "Yes", description: "Continue" },
            { label: "No", description: "Stop" },
          ],
          multiSelect: false,
        },
      ],
    });
    const interaction = await nextInteraction(iterator);
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transports[0]?.respondToInteraction).toHaveBeenCalledWith({
      type: "question",
      requestId: "dismiss-request",
      cancelled: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      reason: "cancelled",
    });
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });
});
