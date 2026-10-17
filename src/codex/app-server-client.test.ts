import { describe, expect, it, vi } from "vitest";
import { buildThreadStartParams, CodexAppServerClient } from "./app-server-client.js";

describe("buildThreadStartParams", () => {
  it("starts threads without the workspace sandbox that fails in the user service", () => {
    expect(buildThreadStartParams("/project")).toMatchObject({
      cwd: "/project",
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      modelProvider: "openai",
    });
  });

  it("uses Codex never approval policy when channel auto-approve is enabled", () => {
    expect(buildThreadStartParams("/project", { autoApprove: true })).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("uses a current Codex model for collaboration mode unless one is selected", () => {
    expect(buildThreadStartParams("/project", { collaborationMode: "plan" })).toMatchObject({
      collaborationMode: { settings: { model: "gpt-5.6-sol" } },
    });
    expect(buildThreadStartParams("/project", { collaborationMode: "plan", model: "gpt-6-astra" })).toMatchObject({
      collaborationMode: { settings: { model: "gpt-6-astra" } },
    });
  });
});

describe("startTurn", () => {
  it("keeps the unrestricted sandbox and approval policy on resumed turns", async () => {
    const client = new CodexAppServerClient();
    const request = vi.spyOn(client, "request").mockResolvedValue({ turn: { id: "turn-1" } });

    await client.startTurn("thread-1", "run pwd", { autoApprove: true });

    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      sandboxPolicy: { type: "dangerFullAccess" },
      approvalPolicy: "never",
    }));
  });
});

 describe("thread settings and ownership", () => {
  it("sends model and effort on ordinary resumed turns", async () => {
    const client = new CodexAppServerClient();
    const request = vi.spyOn(client, "request").mockResolvedValue({ turn: { id: "turn" } });
    await client.startTurn("saved-thread", "continue", { model: "gpt-6-astra", reasoningEffort: "high" });
    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      threadId: "saved-thread", model: "gpt-6-astra", effort: "high",
    }));
  });
});

describe("thread writer isolation", () => {
  it("releases one writer while another channel keeps running", async () => {
    const client = new CodexAppServerClient();
    const owners: CodexAppServerClient[] = [];
    const ensureStarted = vi.spyOn(CodexAppServerClient.prototype, "ensureStarted").mockResolvedValue();
    const request = vi.spyOn(CodexAppServerClient.prototype as any, "requestWithProcess")
      .mockImplementation(function (this: CodexAppServerClient, ...args: unknown[]) {
        owners.push(this);
        const params = args[1] as { threadId: string };
        return Promise.resolve({ thread: { id: params.threadId } });
      });
    const close = vi.spyOn(CodexAppServerClient.prototype as any, "close").mockResolvedValue(undefined);
    try {
      await client.resumeThread("thread-a");
      await client.resumeThread("thread-b");
      expect(owners[0]).not.toBe(owners[1]);
      await client.releaseThread("thread-a");
      expect(close).toHaveBeenCalledTimes(1);
      expect(close.mock.instances[0]).toBe(owners[0]);
      await client.readThread("thread-b");
      expect(owners[2]).toBe(owners[1]);
      await client.resumeThread("thread-a");
      expect(owners[3]).not.toBe(owners[0]);
    } finally {
      ensureStarted.mockRestore(); request.mockRestore(); close.mockRestore();
    }
  });
});
