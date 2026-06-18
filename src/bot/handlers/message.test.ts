import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/database.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("../../security/guard.js", () => ({
  isAllowedUser: vi.fn(() => true),
  checkRateLimit: vi.fn(() => true),
}));

vi.mock("../../codex/session-manager.js", () => ({
  sessionManager: {
    hasPendingCustomInput: vi.fn(() => false),
    resolveCustomInput: vi.fn(),
    hasQueue: vi.fn(() => false),
    isQueueFull: vi.fn(() => false),
    setPendingQueue: vi.fn(),
    isActive: vi.fn(() => false),
    sendMessage: vi.fn(),
  },
}));

vi.mock("../../codex/audio-transcription.js", () => ({
  isAudioAttachment: vi.fn(() => true),
  transcribeAudioFile: vi.fn(async () => "hello from audio"),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMessage } from "./message.js";
import { getProject } from "../../db/database.js";
import { sessionManager } from "../../codex/session-manager.js";

describe("handleMessage audio transcription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProject).mockReturnValue({
      channel_id: "chan-1",
      project_path: fs.mkdtempSync(path.join(os.tmpdir(), "discord-audio-")),
      guild_id: "guild-1",
      auto_approve: 0,
      codex_model: null,
      reasoning_effort: null,
      created_at: "now",
    });
  });

  it("prepends transcribed audio text before sending to Codex", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    })));

    const message = {
      author: { bot: false, id: "user-1" },
      guild: { id: "guild-1" },
      channelId: "chan-1",
      content: "please summarize this",
      attachments: new Map([
        [
          "a1",
          {
            name: "voice.ogg",
            size: 4,
            url: "https://files.example.test/voice.ogg",
            contentType: "audio/ogg",
          },
        ],
      ]),
      channel: { id: "chan-1" },
      reply: vi.fn(),
      react: vi.fn(),
    } as any;

    await handleMessage(message);

    expect(sessionManager.sendMessage).toHaveBeenCalledWith(
      message.channel,
      expect.stringContaining("[Audio transcripts]\n[Transcribed audio: voice.ogg]\nhello from audio"),
    );
    expect(sessionManager.sendMessage).toHaveBeenCalledWith(
      message.channel,
      expect.stringContaining("please summarize this"),
    );
  });
});
