import { describe, expect, it } from "vitest";
import { buildThreadStartParams } from "./app-server-client.js";

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
