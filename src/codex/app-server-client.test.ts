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
