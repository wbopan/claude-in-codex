import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseDesktopControllerArguments,
  runDesktopController,
  serializeDesktopControllerReadiness,
  type DesktopControllerDependencies,
} from "../src/production-controller.js";

const attachmentNonce = "0123456789abcdef0123456789abcdef";

function controllerOptions() {
  return {
    rendererCdpEndpoint: "http://127.0.0.1:43123",
    rendererPath: "/renderer.js",
    defaultAgent: "codex" as const,
    attachmentPort: 43124,
    attachmentNonce,
  };
}

describe("production Desktop Controller", () => {
  it("accepts only a loopback Renderer CDP endpoint, absolute Renderer path, and strict attachment fields", () => {
    const rendererPath = path.resolve("fixtures/renderer-extension.js");
    expect(
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        rendererPath,
        "--default-agent",
        "codex",
        "--attachment-port",
        "43124",
        "--attachment-nonce",
        attachmentNonce,
      ]),
    ).toEqual({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererPath,
      defaultAgent: "codex",
      attachmentPort: 43124,
      attachmentNonce,
    });
    expect(() =>
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://example.com:43123",
        "--renderer",
        "/renderer.js",
      ]),
    ).toThrow("loopback HTTP origin");
    expect(() =>
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        "renderer.js",
      ]),
    ).toThrow("absolute path");
    expect(() =>
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        rendererPath,
        "--default-agent",
        "codex",
        "--attachment-port",
        "43124",
        "--attachment-nonce",
        "bad",
      ]),
    ).toThrow("32 lowercase hexadecimal");
  });

  it("serializes only strict and bounded readiness results", () => {
    expect(
      serializeDesktopControllerReadiness({
        schemaVersion: 2,
        state: "compatible",
        issues: [],
      }),
    ).toBe('{"schemaVersion":2,"state":"compatible","issues":[]}');
    expect(() =>
      serializeDesktopControllerReadiness({
        schemaVersion: 2,
        state: "incompatible",
        issues: [],
      } as never),
    ).toThrow("readiness is invalid");
  });

  it("serves attachment and signals compatible readiness without installing a Renderer Session", async () => {
    const abort = new AbortController();
    const close = vi.fn(async () => {});
    const startAttachmentServer = vi.fn(async () => ({ close }));
    const ready = vi.fn();
    const dependencies: DesktopControllerDependencies = {
      startAttachmentServer,
      ready,
      sleep: vi.fn(async () => {
        abort.abort();
      }),
      monitorIntervalMs: 1,
    };

    await runDesktopController(controllerOptions(), abort.signal, dependencies);

    expect(startAttachmentServer).toHaveBeenCalledWith(
      expect.objectContaining({ port: 43124, nonce: attachmentNonce }),
    );
    expect(ready).toHaveBeenCalledWith({ schemaVersion: 2, state: "compatible", issues: [] });
    expect(close).toHaveBeenCalledOnce();
  });

  it("answers attachment without activating Desktop", async () => {
    const abort = new AbortController();
    let attach: (() => Promise<void>) | undefined;
    const dependencies: DesktopControllerDependencies = {
      startAttachmentServer: vi.fn(async (options) => {
        attach = options.attach;
        return { close: vi.fn(async () => {}) };
      }),
      ready: vi.fn(),
      sleep: vi.fn(async () => {
        abort.abort();
      }),
      monitorIntervalMs: 1,
    };

    await runDesktopController(controllerOptions(), abort.signal, dependencies);

    await expect(attach?.()).resolves.toBeUndefined();
  });
});
