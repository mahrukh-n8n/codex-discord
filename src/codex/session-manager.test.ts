import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../db/database.js", () => ({
  upsertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  getProject: vi.fn(),
  getSession: vi.fn(),
  setAutoApprove: vi.fn(),
}));

vi.mock("../utils/config.js", () => ({
  getConfig: () => ({ SHOW_COST: false }),
}));

vi.mock("../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

vi.mock("./app-server-client.js", () => ({
  codexAppServer: {
    ensureStarted: vi.fn(),
    on: vi.fn(),
    startThread: vi.fn(),
    resumeThread: vi.fn(),
    startTurn: vi.fn(),
    respond: vi.fn(),
    interruptTurn: vi.fn(),
    readThread: vi.fn(),
    readRateLimits: vi.fn(),
  },
}));

import { SessionManager, formatContextStatusFromEvent, formatLimitStatusFromEvent, formatLimitStatusFromUsage, shouldSuppressCodexStderr } from "./session-manager.js";
import { codexAppServer } from "./app-server-client.js";
import { createStopButton, splitMessage } from "./output-formatter.js";
import { getProject, getSession } from "../db/database.js";
import * as modelCommands from "../bot/commands/model.js";

function createFakeMessage() {
  return {
    edit: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SessionManager streaming output", () => {
  let now = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accumulates agent deltas instead of replacing earlier text", async () => {
    const manager = new SessionManager();
    const firstMessage = createFakeMessage();
    const channel = {
      id: "channel-1",
      send: vi.fn(),
    } as any;

    (manager as any).sessions.set("channel-1", {
      channelId: "channel-1",
      channel,
      threadId: "thread-1",
      turnId: "turn-1",
      dbId: "db-1",
    });

    (manager as any).streamState.set("channel-1", {
      buffer: "",
      messages: [firstMessage],
      lastEditTime: 0,
      stopRow: createStopButton("channel-1"),
      startedAt: 0,
      lastActivity: "Thinking...",
      toolUseCount: 0,
      heartbeat: setInterval(() => {}, 60_000),
      hasTextOutput: false,
      lastError: null,
      agentMessagePhases: new Map(),
      finalAnswerStarted: false,
      completedPlan: false,
      collaborationMode: "plan",
    });

    now = 2_000;
    await (manager as any).handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "저는 " },
    });

    now = 4_000;
    await (manager as any).handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "Codex입니다." },
    });

    expect(firstMessage.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "저는 Codex입니다." }),
    );
    expect(channel.send).not.toHaveBeenCalled();

    clearInterval((manager as any).streamState.get("channel-1").heartbeat);
  });

  it("replaces streamed commentary when the final answer starts", async () => {
    const manager = new SessionManager();
    const firstMessage = createFakeMessage();
    const channel = {
      id: "channel-final-phase",
      send: vi.fn(),
    } as any;

    (manager as any).sessions.set("channel-final-phase", {
      channelId: "channel-final-phase",
      channel,
      threadId: "thread-final-phase",
      turnId: "turn-final-phase",
      dbId: "db-final-phase",
    });

    (manager as any).streamState.set("channel-final-phase", {
      buffer: "",
      messages: [firstMessage],
      lastEditTime: 0,
      stopRow: createStopButton("channel-final-phase"),
      startedAt: 0,
      lastActivity: "Thinking...",
      toolUseCount: 0,
      heartbeat: setInterval(() => {}, 60_000),
      hasTextOutput: false,
      lastError: null,
      agentMessagePhases: new Map(),
      finalAnswerStarted: false,
    });

    await (manager as any).handleNotification({
      method: "item/started",
      params: {
        threadId: "thread-final-phase",
        item: { type: "agentMessage", id: "commentary-1", phase: "commentary" },
      },
    });

    now = 2_000;
    await (manager as any).handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-final-phase", itemId: "commentary-1", delta: "Thinking details" },
    });

    expect(firstMessage.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "Thinking details" }),
    );

    await (manager as any).handleNotification({
      method: "item/started",
      params: {
        threadId: "thread-final-phase",
        item: { type: "agentMessage", id: "final-1", phase: "final_answer" },
      },
    });

    now = 4_000;
    await (manager as any).handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-final-phase", itemId: "final-1", delta: "Final answer" },
    });

    expect(firstMessage.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "Final answer" }),
    );
    expect(firstMessage.edit).not.toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Thinking details") }),
    );

    clearInterval((manager as any).streamState.get("channel-final-phase").heartbeat);
  });

  it("renders completed plan items as final output", async () => {
    const manager = new SessionManager();
    const firstMessage = createFakeMessage();
    const channel = {
      id: "channel-plan-item",
      send: vi.fn(),
    } as any;

    (manager as any).sessions.set("channel-plan-item", {
      channelId: "channel-plan-item",
      channel,
      threadId: "thread-plan-item",
      turnId: "turn-plan-item",
      dbId: "db-plan-item",
    });

    (manager as any).streamState.set("channel-plan-item", {
      buffer: "Earlier commentary",
      messages: [firstMessage],
      lastEditTime: 0,
      stopRow: createStopButton("channel-plan-item"),
      startedAt: 0,
      lastActivity: "Thinking...",
      toolUseCount: 0,
      heartbeat: setInterval(() => {}, 60_000),
      hasTextOutput: true,
      lastError: null,
      agentMessagePhases: new Map(),
      finalAnswerStarted: false,
    });

    now = 2_000;
    await (manager as any).handleNotification({
      method: "item_completed",
      params: {
        threadId: "thread-plan-item",
        item: {
          type: "Plan",
          text: "# Final Plan\n\nBuild the thing.",
        },
      },
    });

    expect(firstMessage.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "# Final Plan\n\nBuild the thing." }),
    );
    expect(firstMessage.edit).not.toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Earlier commentary") }),
    );

    now = 3_000;
    vi.mocked(codexAppServer.readThread).mockResolvedValue({ path: null } as any);
    await (manager as any).handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-plan-item", turn: { status: "completed" } },
    });

    const finalEdit = firstMessage.edit.mock.calls.at(-1)?.[0] as any;
    expect(finalEdit.components[0].components[1].data).toMatchObject({
      custom_id: "implement-plan:channel-plan-item",
      label: "Implement Plan",
    });

    expect((manager as any).streamState.has("channel-plan-item")).toBe(false);
  });

  it("recovers proposed plan blocks from stored final messages before completing", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plan-thread-"));
    const threadPath = path.join(tempDir, "thread.jsonl");
    fs.writeFileSync(
      threadPath,
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [
              {
                type: "output_text",
                text: "<proposed_plan>\n# Stored Plan\n\nImplement the stored plan.\n</proposed_plan>",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_complete",
            last_agent_message: null,
          },
        }),
      ].join("\n") + "\n",
    );

    const manager = new SessionManager();
    const firstMessage = createFakeMessage();
    const channel = {
      id: "channel-stored-plan",
      send: vi.fn(),
    } as any;

    vi.mocked(codexAppServer.readThread).mockResolvedValue({ path: threadPath } as any);

    (manager as any).sessions.set("channel-stored-plan", {
      channelId: "channel-stored-plan",
      channel,
      threadId: "thread-stored-plan",
      turnId: "turn-stored-plan",
      dbId: "db-stored-plan",
    });

    (manager as any).streamState.set("channel-stored-plan", {
      buffer: "",
      messages: [firstMessage],
      lastEditTime: 0,
      stopRow: createStopButton("channel-stored-plan"),
      startedAt: 0,
      lastActivity: "Thinking...",
      toolUseCount: 0,
      heartbeat: setInterval(() => {}, 60_000),
      hasTextOutput: false,
      lastError: null,
      agentMessagePhases: new Map(),
      finalAnswerStarted: false,
      completedPlan: false,
      collaborationMode: "plan",
    });

    now = 5_000;
    await (manager as any).handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-stored-plan", turn: { status: "completed" } },
    });

    const finalEdit = firstMessage.edit.mock.calls.at(-1)?.[0] as any;
    expect(finalEdit.content).toContain("# Stored Plan");
    expect(finalEdit.content).not.toContain("<proposed_plan>");
    expect(finalEdit.components[0].components[1].data).toMatchObject({
      custom_id: "implement-plan:channel-stored-plan",
      label: "Implement Plan",
    });
  });

  it("does not recover an older proposed plan after an implementation turn completes", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-implementation-thread-"));
    const threadPath = path.join(tempDir, "thread.jsonl");
    fs.writeFileSync(
      threadPath,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [
            {
              type: "output_text",
              text: "<proposed_plan>\n# Old Plan\n\nDo not paste this after implementation.\n</proposed_plan>",
            },
          ],
        },
      })}\n`,
    );

    const manager = new SessionManager();
    const firstMessage = createFakeMessage();
    const channel = {
      id: "channel-code-complete",
      send: vi.fn(),
    } as any;

    vi.mocked(codexAppServer.readThread).mockResolvedValue({ path: threadPath } as any);

    (manager as any).sessions.set("channel-code-complete", {
      channelId: "channel-code-complete",
      channel,
      threadId: "thread-code-complete",
      turnId: "turn-code-complete",
      dbId: "db-code-complete",
    });

    (manager as any).streamState.set("channel-code-complete", {
      buffer: "Implemented the plan and ran tests.",
      messages: [firstMessage],
      lastEditTime: 0,
      stopRow: createStopButton("channel-code-complete"),
      startedAt: 0,
      lastActivity: "Thinking...",
      toolUseCount: 0,
      heartbeat: setInterval(() => {}, 60_000),
      hasTextOutput: true,
      lastError: null,
      agentMessagePhases: new Map(),
      finalAnswerStarted: true,
      completedPlan: false,
      collaborationMode: "code",
    });

    now = 6_000;
    await (manager as any).handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-code-complete", turn: { status: "completed" } },
    });

    const finalEdit = firstMessage.edit.mock.calls.at(-1)?.[0] as any;
    expect(finalEdit.content).toContain("Implemented the plan and ran tests.");
    expect(finalEdit.content).not.toContain("# Old Plan");
    expect(finalEdit.components[0].components).toHaveLength(1);
  });

  it("uses the current plan-mode final answer instead of an older proposed plan", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-current-final-thread-"));
    const threadPath = path.join(tempDir, "thread.jsonl");
    fs.writeFileSync(
      threadPath,
      [
        JSON.stringify({ type: "turn_context", payload: { type: "turn_context", turn_id: "turn-old" } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-old" },
            content: [
              {
                type: "output_text",
                text: "<proposed_plan>\n# Older Plan\n\nThis should not be rendered.\n</proposed_plan>",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-old", last_agent_message: null },
        }),
        JSON.stringify({ type: "turn_context", payload: { type: "turn_context", turn_id: "turn-current" } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-current" },
            content: [
              {
                type: "output_text",
                text: "Agreed. The plan should use cash/USDT settlement wording.\n\nNext decision: choose exposure source or prefer one source?",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-current",
            last_agent_message: "Agreed. The plan should use cash/USDT settlement wording.\n\nNext decision: choose exposure source or prefer one source?",
          },
        }),
      ].join("\n") + "\n",
    );

    const manager = new SessionManager();
    const firstMessage = createFakeMessage();
    const channel = {
      id: "channel-current-final",
      send: vi.fn(),
    } as any;

    vi.mocked(codexAppServer.readThread).mockResolvedValue({ path: threadPath } as any);

    (manager as any).sessions.set("channel-current-final", {
      channelId: "channel-current-final",
      channel,
      threadId: "thread-current-final",
      turnId: "turn-current",
      dbId: "db-current-final",
    });

    (manager as any).streamState.set("channel-current-final", {
      buffer: "Intermediate plan-mode commentary",
      messages: [firstMessage],
      lastEditTime: 0,
      stopRow: createStopButton("channel-current-final"),
      startedAt: 0,
      lastActivity: "Thinking...",
      toolUseCount: 0,
      heartbeat: setInterval(() => {}, 60_000),
      hasTextOutput: true,
      lastError: null,
      agentMessagePhases: new Map(),
      finalAnswerStarted: false,
      completedPlan: false,
      collaborationMode: "plan",
    });

    now = 7_000;
    await (manager as any).handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-current-final", turn: { status: "completed" } },
    });

    const finalEdit = firstMessage.edit.mock.calls.at(-1)?.[0] as any;
    expect(finalEdit.content).toContain("cash/USDT settlement wording");
    expect(finalEdit.content).toContain("Next decision");
    expect(finalEdit.content).not.toContain("# Older Plan");
    expect(finalEdit.components[0].components).toHaveLength(1);
  });

  it("keeps earlier chunks and sends only newly needed Discord messages", async () => {
    const manager = new SessionManager();
    const firstMessage = createFakeMessage();
    const sentMessages: Array<ReturnType<typeof createFakeMessage>> = [];
    const channel = {
      id: "channel-2",
      send: vi.fn().mockImplementation(async () => {
        const message = createFakeMessage();
        sentMessages.push(message);
        return message;
      }),
    } as any;

    (manager as any).sessions.set("channel-2", {
      channelId: "channel-2",
      channel,
      threadId: "thread-2",
      turnId: "turn-2",
      dbId: "db-2",
    });

    (manager as any).streamState.set("channel-2", {
      buffer: "",
      messages: [firstMessage],
      lastEditTime: 0,
      stopRow: createStopButton("channel-2"),
      startedAt: 0,
      lastActivity: "Thinking...",
      toolUseCount: 0,
      heartbeat: setInterval(() => {}, 60_000),
      hasTextOutput: false,
      lastError: null,
      agentMessagePhases: new Map(),
      finalAnswerStarted: false,
    });

    const firstDelta = "a".repeat(1890);
    const secondDelta = "\n" + "b".repeat(80);

    now = 2_000;
    await (manager as any).handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-2", delta: firstDelta },
    });

    now = 4_000;
    await (manager as any).handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-2", delta: secondDelta },
    });

    const chunks = splitMessage(firstDelta + secondDelta);
    expect(chunks).toHaveLength(2);
    expect(firstMessage.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: chunks[0] }),
    );
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(sentMessages[0].edit).not.toHaveBeenCalled();

    clearInterval((manager as any).streamState.get("channel-2").heartbeat);
  });

  it("passes project model settings when starting a new thread", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "channel-model",
      project_path: "/project",
      guild_id: "guild",
      auto_approve: 0,
      codex_model: "gpt-5.5",
      reasoning_effort: "high",
      collaboration_mode: "plan",
      created_at: "now",
    });
    vi.mocked(getSession).mockReturnValue(undefined);
    vi.mocked(codexAppServer.startThread).mockResolvedValue({ id: "thread-model" } as any);
    vi.mocked(codexAppServer.startTurn).mockResolvedValue({ id: "turn-model" });

    const manager = new SessionManager();
    const channel = {
      id: "channel-model",
      send: vi.fn().mockResolvedValue(createFakeMessage()),
    } as any;

    await manager.sendMessage(channel, {
      prompt: "hello",
      imagePaths: ["/project/.codex-uploads/image.png"],
    });

    expect(codexAppServer.startThread).toHaveBeenCalledWith("/project", {
      model: "gpt-5.5",
      reasoningEffort: "high",
      collaborationMode: "plan",
      autoApprove: false,
    });
    expect(codexAppServer.startTurn).toHaveBeenCalledWith("thread-model", {
      prompt: "hello",
      imagePaths: ["/project/.codex-uploads/image.png"],
    }, {
      model: "gpt-5.5",
      reasoningEffort: "high",
      collaborationMode: "plan",
    });
  });

  it("passes auto-approve setting when starting a new thread", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "channel-auto-approve",
      project_path: "/project",
      guild_id: "guild",
      auto_approve: 1,
      codex_model: null,
      reasoning_effort: null,
      collaboration_mode: null,
      created_at: "now",
    });
    vi.mocked(getSession).mockReturnValue(undefined);
    vi.mocked(codexAppServer.startThread).mockResolvedValue({ id: "thread-auto" } as any);
    vi.mocked(codexAppServer.startTurn).mockResolvedValue({ id: "turn-auto" });

    const manager = new SessionManager();
    const channel = {
      id: "channel-auto-approve",
      send: vi.fn().mockResolvedValue(createFakeMessage()),
    } as any;

    await manager.sendMessage(channel, "hello");

    expect(codexAppServer.startThread).toHaveBeenCalledWith("/project", {
      model: null,
      reasoningEffort: null,
      collaborationMode: null,
      autoApprove: true,
    });
  });

  it("starts a fresh thread when the saved session model cannot handle images", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thread-"));
    const threadPath = path.join(tempDir, "thread.jsonl");
    fs.writeFileSync(
      threadPath,
      `${JSON.stringify({ payload: { type: "turn_context", model: "gpt-5.3-codex-spark", reasoning_effort: "low", collaboration_mode: { mode: "default" } } })}\n`,
    );

    vi.spyOn(modelCommands, "loadCachedCodexModels").mockReturnValue([
      { slug: "gpt-5.3-codex-spark", input_modalities: ["text"] },
    ]);
    vi.mocked(getProject).mockReturnValue({
      channel_id: "channel-image-rotate",
      project_path: "/project",
      guild_id: "guild",
      auto_approve: 0,
      codex_model: "gpt-5.5",
      reasoning_effort: "high",
      collaboration_mode: null,
      created_at: "now",
    });
    vi.mocked(getSession).mockReturnValue({
      id: "db-session-1",
      channel_id: "channel-image-rotate",
      session_id: "thread-old",
      status: "idle",
      last_activity: null,
      created_at: "now",
    });
    vi.mocked(codexAppServer.readThread).mockResolvedValue({ path: threadPath } as any);
    vi.mocked(codexAppServer.startThread).mockResolvedValue({ id: "thread-new" } as any);
    vi.mocked(codexAppServer.startTurn).mockResolvedValue({ id: "turn-new" });

    const manager = new SessionManager();
    const channel = {
      id: "channel-image-rotate",
      send: vi.fn().mockResolvedValue(createFakeMessage()),
    } as any;

    await manager.sendMessage(channel, {
      prompt: "read this image",
      imagePaths: ["/project/.codex-uploads/test.png"],
    });

    expect(codexAppServer.resumeThread).not.toHaveBeenCalled();
    expect(codexAppServer.startThread).toHaveBeenCalledWith("/project", {
      model: "gpt-5.5",
      reasoningEffort: "high",
      collaborationMode: null,
      autoApprove: false,
    });
    expect(codexAppServer.startTurn).toHaveBeenCalledWith("thread-new", {
      prompt: "read this image",
      imagePaths: ["/project/.codex-uploads/test.png"],
    }, {
      model: "gpt-5.5",
      reasoningEffort: "high",
      collaborationMode: null,
    });
  });

  it("starts a fresh thread for auto-approve channels saved with restricted sandbox", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thread-"));
    const threadPath = path.join(tempDir, "thread.jsonl");
    fs.writeFileSync(
      threadPath,
      `${JSON.stringify({
        payload: {
          type: "turn_context",
          model: "gpt-5.5",
          reasoning_effort: "medium",
          approval_policy: "on-request",
          sandbox_policy: { type: "workspace-write" },
          collaboration_mode: { mode: "plan" },
        },
      })}\n`,
    );

    vi.mocked(getProject).mockReturnValue({
      channel_id: "channel-sandbox-rotate",
      project_path: "/project",
      guild_id: "guild",
      auto_approve: 1,
      codex_model: "gpt-5.5",
      reasoning_effort: "medium",
      collaboration_mode: "plan",
      created_at: "now",
    });
    vi.mocked(getSession).mockReturnValue({
      id: "db-session-sandbox",
      channel_id: "channel-sandbox-rotate",
      session_id: "thread-old",
      status: "idle",
      last_activity: null,
      created_at: "now",
    });
    vi.mocked(codexAppServer.readThread).mockResolvedValue({ path: threadPath } as any);
    vi.mocked(codexAppServer.startThread).mockResolvedValue({ id: "thread-new" } as any);
    vi.mocked(codexAppServer.startTurn).mockResolvedValue({ id: "turn-new" });

    const manager = new SessionManager();
    const channel = {
      id: "channel-sandbox-rotate",
      send: vi.fn().mockResolvedValue(createFakeMessage()),
    } as any;

    await manager.sendMessage(channel, "hello");

    expect(codexAppServer.resumeThread).not.toHaveBeenCalled();
    expect(codexAppServer.startThread).toHaveBeenCalledWith("/project", {
      model: "gpt-5.5",
      reasoningEffort: "medium",
      collaborationMode: "plan",
      autoApprove: true,
    });
  });

  it("reuses the saved session when only the project mode differs", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thread-"));
    const threadPath = path.join(tempDir, "thread.jsonl");
    fs.writeFileSync(
      threadPath,
      `${JSON.stringify({ payload: { type: "turn_context", model: "gpt-5.5", reasoning_effort: "high", collaboration_mode: { mode: "default" } } })}\n`,
    );

    vi.mocked(getProject).mockReturnValue({
      channel_id: "channel-plan-rotate",
      project_path: "/project",
      guild_id: "guild",
      auto_approve: 0,
      codex_model: "gpt-5.5",
      reasoning_effort: "high",
      collaboration_mode: "plan",
      created_at: "now",
    });
    vi.mocked(getSession).mockReturnValue({
      id: "db-session-2",
      channel_id: "channel-plan-rotate",
      session_id: "thread-old",
      status: "idle",
      last_activity: null,
      created_at: "now",
    });
    vi.mocked(codexAppServer.readThread).mockResolvedValue({ path: threadPath } as any);
    vi.mocked(codexAppServer.resumeThread).mockResolvedValue({ id: "thread-old" } as any);
    vi.mocked(codexAppServer.startTurn).mockResolvedValue({ id: "turn-plan" });

    const manager = new SessionManager();
    const channel = {
      id: "channel-plan-rotate",
      send: vi.fn().mockResolvedValue(createFakeMessage()),
    } as any;

    await manager.sendMessage(channel, "hello");

    expect(codexAppServer.resumeThread).toHaveBeenCalledWith("thread-old");
    expect(codexAppServer.startThread).not.toHaveBeenCalled();
    expect(codexAppServer.startTurn).toHaveBeenCalledWith("thread-old", { prompt: "hello" }, {
      model: "gpt-5.5",
      reasoningEffort: "high",
      collaborationMode: "plan",
    });
  });

  it("appends completion summary to the final streamed reply instead of sending a new message", async () => {
    const manager = new SessionManager();
    const firstMessage = createFakeMessage();
    const channel = {
      id: "channel-complete",
      send: vi.fn(),
    } as any;

    vi.mocked(codexAppServer.readThread).mockResolvedValue({ path: null } as any);

    (manager as any).sessions.set("channel-complete", {
      channelId: "channel-complete",
      channel,
      threadId: "thread-complete",
      turnId: "turn-complete",
      dbId: "db-complete",
    });

    (manager as any).streamState.set("channel-complete", {
      buffer: "Done output",
      messages: [firstMessage],
      lastEditTime: 0,
      stopRow: createStopButton("channel-complete"),
      startedAt: 0,
      model: "gpt-5.5",
      reasoning: "medium",
      contextStatus: "39%",
      limitStatus: "5H 81% - W 97%",
      lastActivity: "Thinking...",
      toolUseCount: 0,
      heartbeat: setInterval(() => {}, 60_000),
      hasTextOutput: true,
      lastError: null,
      agentMessagePhases: new Map(),
      finalAnswerStarted: false,
    });

    now = 34_700;
    await (manager as any).handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-complete", turn: { status: "completed" } },
    });

    expect(firstMessage.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: [
          "Done output",
          "",
          "✅ Task Complete | gpt-5.5 / medium | 34.7s",
          "Context Used | 39%",
          "Limit | 5H 81% - W 97%",
        ].join("\n"),
      }),
    );
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("responds to MCP user input requests with the app-server action field", async () => {
    const manager = new SessionManager();
    const channel = {
      id: "channel-3",
      send: vi.fn().mockResolvedValue(createFakeMessage()),
    } as any;

    (manager as any).sessions.set("channel-3", {
      channelId: "channel-3",
      channel,
      threadId: "thread-3",
      turnId: "turn-3",
      dbId: "db-3",
    });

    const request = (manager as any).handleServerRequest({
      id: 77,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-3",
        questions: [
          {
            id: "confirm",
            header: "Confirm",
            question: "Continue?",
            options: [{ label: "Yes", description: "" }],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledTimes(1));
    expect(manager.resolveQuestion("77", "Yes")).toBe(true);
    await request;

    expect(codexAppServer.respond).toHaveBeenCalledWith(77, {
      action: "accept",
      answers: { confirm: { answers: ["Yes"] } },
      content: { confirm: "Yes" },
    });
  });

  it("responds to MCP elicitation requests with content keyed by schema property", async () => {
    const manager = new SessionManager();
    const channel = {
      id: "channel-4",
      send: vi.fn().mockResolvedValue(createFakeMessage()),
    } as any;

    (manager as any).sessions.set("channel-4", {
      channelId: "channel-4",
      channel,
      threadId: "thread-4",
      turnId: "turn-4",
      dbId: "db-4",
    });

    const request = (manager as any).handleServerRequest({
      id: 99,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-4",
        message: "Deployment target",
        requestedSchema: {
          type: "object",
          properties: {
            environment: {
              title: "Environment",
              description: "Which environment?",
              enum: ["production", "staging"],
            },
          },
        },
      },
    });

    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledTimes(1));
    expect(manager.resolveQuestion("99", "production")).toBe(true);
    await request;

    expect(codexAppServer.respond).toHaveBeenCalledWith(99, {
      action: "accept",
      answers: { environment: { answers: ["production"] } },
      content: { environment: "production" },
    });
  });

  it("responds to MCP array enum elicitation requests with multi-select answers", async () => {
    const manager = new SessionManager();
    const channel = {
      id: "channel-5",
      send: vi.fn().mockResolvedValue(createFakeMessage()),
    } as any;

    (manager as any).sessions.set("channel-5", {
      channelId: "channel-5",
      channel,
      threadId: "thread-5",
      turnId: "turn-5",
      dbId: "db-5",
    });

    const request = (manager as any).handleServerRequest({
      id: 100,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-5",
        message: "Select scopes",
        requestedSchema: {
          type: "object",
          properties: {
            scopes: {
              title: "Scopes",
              description: "Which scopes?",
              type: "array",
              items: {
                type: "string",
                enum: ["read", "write"],
              },
            },
          },
        },
      },
    });

    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledTimes(1));
    const sent = channel.send.mock.calls[0][0];
    expect(sent.components[0].components[0].data.custom_id).toBe("ask-select:100");
    expect(manager.resolveQuestion("100", ["read", "write"])).toBe(true);
    await request;

    expect(codexAppServer.respond).toHaveBeenCalledWith(100, {
      action: "accept",
      answers: { scopes: { answers: ["read", "write"] } },
      content: { scopes: ["read", "write"] },
    });
  });

  it("cancels MCP user input requests that no longer map to an active session", async () => {
    const manager = new SessionManager();

    await (manager as any).handleServerRequest({
      id: 88,
      method: "item/tool/requestUserInput",
      params: { threadId: "missing-thread", questions: [] },
    });

    expect(codexAppServer.respond).toHaveBeenCalledWith(88, { action: "cancel" });
  });

  it("suppresses duplicated Codex write_stdin stderr while keeping real errors", () => {
    expect(
      shouldSuppressCodexStderr(
        "2026-06-18T05:29:27Z ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
      ),
    ).toBe(true);
    expect(
      shouldSuppressCodexStderr(
        "2026-06-17T17:05:58Z ERROR codex_core::tools::router: error=write_stdin failed: Unknown process id 25153",
      ),
    ).toBe(true);
    expect(
      shouldSuppressCodexStderr(
        "2026-06-18T05:14:00Z ERROR codex_app_server::bespoke_event_handling: failed to deserialize McpServerElicitationRequestResponse: missing field `action`",
      ),
    ).toBe(false);
  });

  it("formats token_count rate limit snapshots for completion embeds", () => {
    expect(formatLimitStatusFromEvent({
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 15, window_minutes: 300 },
          secondary: { used_percent: 2, window_minutes: 10080 },
        },
      },
    })).toBe("5H 85% - W 98%");
  });

  it("formats token_count context percentage for completion summaries", () => {
    expect(formatContextStatusFromEvent({
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { total_tokens: 47_890 },
          model_context_window: 121_600,
        },
      },
    })).toBe("39%");
  });

  it("formats cached Codex usage for completion embeds", () => {
    expect(formatLimitStatusFromUsage({
      buckets: [
        {
          title: null,
          primary: { usedPercent: 15, windowDurationMins: 300 },
          secondary: { usedPercent: 2, windowDurationMins: 10080 },
        },
      ],
    })).toBe("5H 85% - W 98%");
  });
});
