import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message, TextChannel } from "discord.js";
import {
  upsertSession,
  updateSessionStatus,
  getProject,
  getSession,
  setAutoApprove,
} from "../db/database.js";
import { L } from "../utils/i18n.js";
import { codexAppServer, type CodexTurnInput } from "./app-server-client.js";
import { getStoredThread } from "./storage.js";
import { fetchCodexUsage, getCodexUsageRows, getUsagePercentLeft, type CodexUsageData } from "./usage.js";
import {
  createAskUserQuestionEmbed,
  createCompletedButton,
  createCompletionSummaryText,
  createStopButton,
  createToolApprovalEmbed,
  splitMessage,
} from "./output-formatter.js";

interface ActiveSession {
  channelId: string;
  channel: TextChannel;
  threadId: string;
  turnId: string | null;
  completedTurnIds?: Set<string>;
  dbId: string;
}

interface QuestionPayload {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
}

type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
type QuestionAnswers = Record<string, { answers: string[] }>;
type QuestionResponse = { action: "accept" | "cancel"; answers: QuestionAnswers; content: Record<string, string | string[]> };

type StreamMessage = Awaited<ReturnType<TextChannel["send"]>>;
type StreamState = {
  buffer: string;
  messages: StreamMessage[];
  lastEditTime: number;
  stopRow: ReturnType<typeof createStopButton>;
  startedAt: number;
  model: string | null;
  reasoning: string | null;
  contextStatus: string | null;
  limitStatus: string | null;
  lastActivity: string;
  toolUseCount: number;
  heartbeat: NodeJS.Timeout;
  hasTextOutput: boolean;
  lastError: string | null;
  agentMessagePhases: Map<string, string>;
  finalAnswerStarted: boolean;
  completedPlan: boolean;
  collaborationMode: string | null;
};

const pendingApprovals = new Map<
  number,
  {
    resolve: (decision: ApprovalDecision) => void;
    channelId: string;
  }
>();

const pendingQuestions = new Map<
  number,
  {
    resolve: (answer: QuestionAnswers) => void;
    channelId: string;
    questionId: string;
  }
>();

const pendingCustomInputs = new Map<string, { requestId: number; questionId: string }>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMcpElicitationRequest(method: string): boolean {
  return method === "item/tool/requestUserInput" || method === "mcpServer/elicitation/request";
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPercentLeft(window: unknown): number | null {
  if (!isObject(window)) return null;
  const usedPercent = getNumber(window.used_percent) ?? getNumber(window.usedPercent);
  if (usedPercent === null) return null;
  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

function readWindowMinutes(window: unknown): number | null {
  if (!isObject(window)) return null;
  return getNumber(window.window_minutes) ?? getNumber(window.windowDurationMins);
}

function formatWindowLabel(window: unknown, fallback: string): string {
  const minutes = readWindowMinutes(window);
  if (minutes === 300) return "5H";
  if (minutes === 10080) return "W";
  if (minutes && minutes % 60 === 0 && minutes < 10080) return `${minutes / 60}H`;
  if (minutes) return `${minutes}M`;
  return fallback;
}

function formatWindowLabelFromMinutes(minutes: number | undefined, fallback: string): string {
  if (minutes === 300) return "5H";
  if (minutes === 10080) return "W";
  if (minutes && minutes % 60 === 0 && minutes < 10080) return `${minutes / 60}H`;
  if (minutes) return `${minutes}M`;
  return fallback;
}

function readCodexDefaultSettings(): { model: string | null; reasoning: string | null } {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
    return {
      model: raw.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null,
      reasoning: raw.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    };
  } catch {
    return { model: null, reasoning: null };
  }
}

function normalizeCollaborationMode(mode: string | null | undefined): string {
  return mode?.trim().toLowerCase() || "default";
}

export function formatLimitStatusFromUsage(usage: CodexUsageData | null): string | null {
  if (!usage) return null;
  const rows = getCodexUsageRows(usage);
  const primary = rows.find((row) => row.window.windowDurationMins === 300)?.window ?? rows[0]?.window;
  const secondary = rows.find((row) => row.window.windowDurationMins === 10080)?.window ?? rows[1]?.window;
  const parts: string[] = [];

  if (primary) {
    parts.push(`${formatWindowLabelFromMinutes(primary.windowDurationMins, "5H")} ${getUsagePercentLeft(primary)}%`);
  }
  if (secondary) {
    parts.push(`${formatWindowLabelFromMinutes(secondary.windowDurationMins, "W")} ${getUsagePercentLeft(secondary)}%`);
  }

  return parts.length > 0 ? parts.join(" - ") : null;
}

export function formatLimitStatusFromEvent(params: Record<string, unknown>): string | null {
  const payload = isObject(params.payload) ? params.payload : params;
  if (payload.type !== "token_count" && params.type !== "token_count") return null;

  const rateLimits = isObject(payload.rate_limits)
    ? payload.rate_limits
    : isObject(payload.rateLimits)
      ? payload.rateLimits
      : null;
  if (!rateLimits) return null;

  const primary = rateLimits.primary;
  const secondary = rateLimits.secondary;
  const primaryLeft = readPercentLeft(primary);
  const secondaryLeft = readPercentLeft(secondary);
  const parts: string[] = [];

  if (primaryLeft !== null) {
    parts.push(`${formatWindowLabel(primary, "5H")} ${primaryLeft}%`);
  }
  if (secondaryLeft !== null) {
    parts.push(`${formatWindowLabel(secondary, "W")} ${secondaryLeft}%`);
  }

  return parts.length > 0 ? parts.join(" - ") : null;
}

export function formatContextStatusFromEvent(params: Record<string, unknown>): string | null {
  const payload = isObject(params.payload) ? params.payload : params;
  if (payload.type !== "token_count" && params.type !== "token_count") return null;

  const info = isObject(payload.info) ? payload.info : null;
  if (!info) return null;
  const lastUsage = isObject(info.last_token_usage)
    ? info.last_token_usage
    : isObject(info.lastTokenUsage)
      ? info.lastTokenUsage
      : null;
  if (!lastUsage) return null;

  const totalTokens = getNumber(lastUsage.total_tokens) ?? getNumber(lastUsage.totalTokens);
  const contextWindow = getNumber(info.model_context_window) ?? getNumber(info.modelContextWindow);
  if (totalTokens === null || contextWindow === null || contextWindow <= 0) return null;

  return `${Math.max(0, Math.min(100, Math.round((totalTokens / contextWindow) * 100)))}%`;
}

function readFileTail(filePath: string, maxBytes = 512 * 1024): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function formatMessageWithProposedPlan(text: string): { display: string; plan: string } | null {
  const match = text.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i);
  const plan = match?.[1]?.trim();
  if (!plan) return null;

  const before = text.slice(0, match.index).trim();
  const after = text.slice((match.index ?? 0) + match[0].length).trim();
  return {
    plan,
    display: [before, plan, after].filter(Boolean).join("\n\n"),
  };
}

function getAssistantMessageText(payload: Record<string, unknown>): string | null {
  if (payload.type !== "message" || payload.role !== "assistant" || !Array.isArray(payload.content)) {
    return null;
  }

  const parts = payload.content
    .map((part) => isObject(part) && typeof part.text === "string" ? part.text : null)
    .filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join("\n") : null;
}

function getEntryTurnId(entry: Record<string, unknown>, payload: Record<string, unknown>): string | null {
  const passthrough = isObject(payload.internal_chat_message_metadata_passthrough)
    ? payload.internal_chat_message_metadata_passthrough
    : null;
  return getString(payload.turn_id) ?? getString(entry.turn_id) ?? getString(passthrough?.turn_id);
}

function normalizeNotification(msg: {
  method: string;
  params?: Record<string, unknown>;
}): { method: string; params: Record<string, unknown> } {
  const rawParams = msg.params ?? {};
  const payload = isObject(rawParams.payload) ? rawParams.payload : null;
  const payloadType = payload ? getString(payload.type) : null;

  if (payload && payloadType && (msg.method === "event_msg" || msg.method === "response_item" || msg.method === "event")) {
    return {
      method: payloadType,
      params: { ...rawParams, ...payload },
    };
  }

  return { method: msg.method, params: rawParams };
}

async function readCurrentTurnFinalMessage(threadId: string, turnId: string | null): Promise<string | null> {
  if (!turnId) return null;

  try {
    const thread = await codexAppServer.readThread(threadId, false);
    if (!thread.path) return null;

    const lines = readFileTail(thread.path).trimEnd().split("\n").reverse();
    let inCurrentTurn = false;
    let lastAgentMessage: string | null = null;
    let fallbackAssistantMessage: string | null = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const payload = isObject(entry.payload) ? entry.payload : null;
        if (!payload) continue;
        const entryTurnId = getEntryTurnId(entry, payload);

        if (!inCurrentTurn) {
          if (payload.type !== "task_complete") continue;
          if (entryTurnId !== turnId) continue;
          inCurrentTurn = true;

          if (typeof payload.last_agent_message === "string" && payload.last_agent_message.trim()) {
            lastAgentMessage = payload.last_agent_message.trim();
          }
          continue;
        }

        if (entry.type === "turn_context" || payload.type === "turn_context") {
          if (!turnId || entryTurnId === turnId) break;
        }

        if (entryTurnId && entryTurnId !== turnId) continue;

        const item = isObject(payload.item) ? payload.item : null;
        if (payload.type === "item_completed" && item?.type === "Plan" && typeof item.text === "string" && item.text.trim()) {
          return `<proposed_plan>\n${item.text.trim()}\n</proposed_plan>`;
        }

        const assistantMessage = getAssistantMessageText(payload);
        const proposedPlanMessage = assistantMessage ? formatMessageWithProposedPlan(assistantMessage) : null;
        if (proposedPlanMessage) return assistantMessage.trim();

        if (assistantMessage && (payload.phase === "final_answer" || fallbackAssistantMessage === null)) {
          fallbackAssistantMessage = assistantMessage.trim();
        }
      } catch {
        // Continue scanning older lines.
      }
    }

    return fallbackAssistantMessage ?? lastAgentMessage;
  } catch {
    // Fall through to no recovered final message.
  }

  return null;
}

async function readLatestThreadTokenStats(
  threadId: string,
): Promise<{ contextStatus: string | null; limitStatus: string | null }> {
  try {
    const thread = await codexAppServer.readThread(threadId, false);
    if (!thread.path) return { contextStatus: null, limitStatus: null };

    const lines = readFileTail(thread.path).trimEnd().split("\n").reverse();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const payload = isObject(entry.payload) ? entry.payload : null;
        if (payload?.type !== "token_count") continue;
        return {
          contextStatus: formatContextStatusFromEvent({ payload }),
          limitStatus: formatLimitStatusFromEvent({ payload }),
        };
      } catch {
        // Continue scanning older lines.
      }
    }
  } catch {
    // Fall through to no stats.
  }

  return { contextStatus: null, limitStatus: null };
}

async function fetchFreshLimitStatus(): Promise<string | null> {
  try {
    return formatLimitStatusFromUsage(await fetchCodexUsage());
  } catch {
    return null;
  }
}

function getSchemaQuestions(params: Record<string, unknown>): QuestionPayload[] {
  if (Array.isArray(params.questions)) return params.questions as QuestionPayload[];

  const request = isObject(params.request) ? params.request : {};
  const schema =
    (isObject(params.requestedSchema) && params.requestedSchema) ||
    (isObject(params.schema) && params.schema) ||
    (isObject(request.requestedSchema) && request.requestedSchema) ||
    (isObject(request.schema) && request.schema) ||
    null;
  const properties = schema && isObject(schema.properties) ? schema.properties : null;
  const fallbackQuestion =
    getString(params.message) ??
    getString(request.message) ??
    getString(params.prompt) ??
    L("MCP server requested input.", "MCP 서버가 입력을 요청했습니다.");

  if (!properties) {
    return [
      {
        id: "response",
        header: getString(params.serverName) ?? getString(params.server_name) ?? "MCP Request",
        question: fallbackQuestion,
      },
    ];
  }

  return Object.entries(properties).map(([id, raw]) => {
    const property = isObject(raw) ? raw : {};
    const arrayItems = property.type === "array" && isObject(property.items) ? property.items : null;
    const optionSource = arrayItems ?? property;
    const enumValues = Array.isArray(optionSource.enum) ? optionSource.enum : [];
    const enumDescriptions = Array.isArray(optionSource.enumDescriptions)
      ? optionSource.enumDescriptions
      : Array.isArray(optionSource.enum_descriptions)
        ? optionSource.enum_descriptions
        : [];
    const variants = Array.isArray(optionSource.oneOf)
      ? optionSource.oneOf
      : Array.isArray(optionSource.anyOf)
        ? optionSource.anyOf
        : [];
    const options = enumValues
      .map((value, index) => {
        const label = getString(value);
        if (!label) return null;
        return {
          label,
          description: getString(enumDescriptions[index]) ?? "",
        };
      })
      .filter((value): value is { label: string; description: string } => Boolean(value));

    for (const variant of variants) {
      if (!isObject(variant)) continue;
      const value = getString(variant.const) ?? getString(variant.title);
      if (!value) continue;
      options.push({
        label: value,
        description: getString(variant.description) ?? "",
      });
    }

    if (property.type === "boolean" && options.length === 0) {
      options.push(
        { label: "Yes", description: "" },
        { label: "No", description: "" },
      );
    }

    return {
      id,
      header: getString(property.title) ?? id,
      question: getString(property.description) ?? fallbackQuestion,
      options,
      multiSelect: Boolean(arrayItems),
    };
  });
}

export function shouldSuppressCodexStderr(line: string): boolean {
  return (
    line.includes(" WARN ") ||
    (
      line.includes("codex_core::tools::router") &&
      line.includes("write_stdin failed:") &&
      (
        line.includes("stdin is closed for this session") ||
        line.includes("Unknown process id")
      )
    )
  );
}

export class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private initialized = false;
  private static readonly MAX_QUEUE_SIZE = 5;
  private pendingQueuePrompts = new Map<string, { channel: TextChannel; input: CodexTurnInput }>();
  private streamState = new Map<string, StreamState>();
  private notificationQueue: Promise<void> = Promise.resolve();

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await codexAppServer.ensureStarted();

    codexAppServer.on("notification", (msg) => {
      this.notificationQueue = this.notificationQueue
        .catch(() => {})
        .then(() => this.handleNotification(msg as { method: string; params?: Record<string, unknown> }))
        .catch((error) => {
          console.error("Codex notification error:", error);
        });
    });

    codexAppServer.on("serverRequest", (msg) => {
      this.handleServerRequest(msg as { id: number; method: string; params: Record<string, unknown> }).catch((error) => {
        console.error("Codex server request error:", error);
      });
    });

    codexAppServer.on("stderr", (line) => {
      const text = String(line);
      if (!shouldSuppressCodexStderr(text)) {
        console.warn("[codex]", text);
      }
    });

    this.initialized = true;
  }

  async sendMessage(channel: TextChannel, input: string | CodexTurnInput): Promise<void> {
    await this.ensureInitialized();
    const turnInput: CodexTurnInput = typeof input === "string" ? { prompt: input } : input;

    const channelId = channel.id;
    const project = getProject(channelId);
    if (!project) return;

    const existingSession = this.sessions.get(channelId);
    const dbSession = !existingSession ? getSession(channelId) : undefined;
    const dbId = existingSession?.dbId ?? dbSession?.id ?? randomUUID();
    let threadId = existingSession?.threadId ?? dbSession?.session_id ?? null;
    let threadModel: string | null = null;
    let threadReasoning: string | null = null;
    const defaultSettings = readCodexDefaultSettings();

    try {
      if (!threadId) {
        const thread = await codexAppServer.startThread(project.project_path, {
          model: project.codex_model ?? (project.collaboration_mode ? defaultSettings.model : null),
          reasoningEffort: project.reasoning_effort,
          collaborationMode: project.collaboration_mode,
          autoApprove: Boolean(project.auto_approve),
        });
        threadId = thread.id;
        threadModel = typeof (thread as { model?: unknown }).model === "string"
          ? (thread as { model: string }).model
          : null;
        threadReasoning = typeof (thread as { reasoning_effort?: unknown }).reasoning_effort === "string"
          ? (thread as { reasoning_effort: string }).reasoning_effort
          : null;
      } else if (!existingSession) {
        await codexAppServer.resumeThread(threadId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to prepare Codex thread";
      const isResumeFailure = Boolean(threadId) && !existingSession;
      if (isResumeFailure) {
        console.error(`[codex] Failed to resume thread ${threadId} for channel ${channelId}:`, message);
        await channel.send(
          `❌ ${L("Failed to resume the selected Codex session", "선택한 Codex 세션을 재개하지 못했습니다")}: ${message}\n` +
          L(
            "Try `/sessions` again or choose `Create New Session`.",
            "`/sessions`를 다시 열거나 `새 세션 만들기`를 선택해 보세요."
          ),
        ).catch(() => {});
      } else {
        console.error(`[codex] Failed to start thread for channel ${channelId}:`, message);
        await channel.send(`❌ ${message}`).catch(() => {});
      }
      updateSessionStatus(channelId, "offline");
      await this.finishSession(channelId);
      return;
    }

    upsertSession(dbId, channelId, threadId, "online");

    const stopRow = createStopButton(channelId);
    let currentMessage: Message<true>;
    try {
      currentMessage = await channel.send({
        content: L("⏳ Thinking...", "⏳ 생각 중..."),
        components: [stopRow],
      });
    } catch (error) {
      await codexAppServer.releaseThread(threadId);
      updateSessionStatus(channelId, "offline");
      throw error;
    }

    const startedAt = Date.now();
    const heartbeat = setInterval(async () => {
      const stream = this.streamState.get(channelId);
      if (!stream || stream.hasTextOutput) return;
      const elapsed = Math.round((Date.now() - stream.startedAt) / 1000);
      try {
        await stream.messages.at(-1)?.edit({
          content: `⏳ ${stream.lastActivity} (${elapsed}s)`,
          components: [stream.stopRow],
        });
      } catch {
        // ignore
      }
    }, 15_000);

    this.streamState.set(channelId, {
      buffer: "",
      messages: [currentMessage],
      lastEditTime: 0,
      stopRow,
      startedAt,
      model: project.codex_model ?? threadModel ?? defaultSettings.model,
      reasoning: project.reasoning_effort ?? threadReasoning ?? defaultSettings.reasoning,
      contextStatus: null,
      limitStatus: null,
      lastActivity: L("Thinking...", "생각 중..."),
      toolUseCount: 0,
      heartbeat,
      hasTextOutput: false,
      lastError: null,
      agentMessagePhases: new Map(),
      finalAnswerStarted: false,
      completedPlan: false,
      collaborationMode: project.collaboration_mode,
    });

    this.sessions.set(channelId, {
      channelId,
      channel,
      threadId,
      turnId: null,
      dbId,
    });

    try {
      const turn = await codexAppServer.startTurn(threadId, turnInput, {
        model: project.codex_model ?? (project.collaboration_mode ? defaultSettings.model : null),
        reasoningEffort: project.reasoning_effort,
        collaborationMode: project.collaboration_mode,
        autoApprove: Boolean(project.auto_approve),
      });
      const active = this.sessions.get(channelId);
      if (active && !active.turnId && typeof turn.id === "string") {
        active.turnId = turn.id;
      }
    } catch (error) {
      await channel.send(`❌ ${error instanceof Error ? error.message : "Failed to start Codex turn"}`);
      updateSessionStatus(channelId, "offline");
      await this.finishSession(channelId);
    }
  }

  private async handleNotification(msg: { method: string; params?: Record<string, unknown> }): Promise<void> {
    const { method, params } = normalizeNotification(msg);
    const passthrough = isObject(params.internal_chat_message_metadata_passthrough)
      ? params.internal_chat_message_metadata_passthrough
      : null;
    const threadId = getString(params.threadId) ?? getString(params.thread_id);
    const turnId =
      getString(params.turnId) ??
      getString(params.turn_id) ??
      getString(passthrough?.turn_id) ??
      (isObject(params.turn) ? getString(params.turn.id) : null);
    const active = threadId
      ? this.findActiveByThread(threadId)
      : turnId
        ? this.findActiveByTurn(turnId)
        : undefined;
    if (!active) {
      const limitStatus = formatLimitStatusFromEvent(params);
      const contextStatus = formatContextStatusFromEvent(params);
      if (limitStatus && this.streamState.size === 1) {
        const stream = [...this.streamState.values()][0];
        stream.limitStatus = limitStatus;
      }
      if (contextStatus && this.streamState.size === 1) {
        const stream = [...this.streamState.values()][0];
        stream.contextStatus = contextStatus;
      }
      return;
    }

    const channelId = active.channelId;
    if (turnId && !active.turnId) {
      active.turnId = turnId;
    }
    const stream = this.streamState.get(channelId);
    if (stream) {
      stream.limitStatus = formatLimitStatusFromEvent(params) ?? stream.limitStatus;
      stream.contextStatus = formatContextStatusFromEvent(params) ?? stream.contextStatus;
    }

    switch (method) {
      case "turn/started":
      case "task_started": {
        const turn = params.turn as { id?: string } | undefined;
        const startedTurnId = turn?.id ?? turnId;
        if (startedTurnId) {
          active.turnId = startedTurnId;
          updateSessionStatus(channelId, "online");
        }
        return;
      }
      case "thread/status/changed": {
        const status = params.status as { type?: string; activeFlags?: string[] } | undefined;
        if (!status) return;
        if (status.type === "active") {
          const waiting =
            Array.isArray(status.activeFlags) &&
            status.activeFlags.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput");
          updateSessionStatus(channelId, waiting ? "waiting" : "online");
        } else if (status.type === "idle") {
          updateSessionStatus(channelId, "idle");
        }
        return;
      }
      case "item/started": {
        if (!stream) return;
        const item = params.item as Record<string, unknown> | undefined;
        if (!item || typeof item.type !== "string") return;

        if (item.type !== "userMessage") {
          stream.toolUseCount++;
        }

        if (item.type === "agentMessage" && typeof item.id === "string") {
          const phase = typeof item.phase === "string" ? item.phase : "unknown";
          stream.agentMessagePhases.set(item.id, phase);
          if (phase === "final_answer" && !stream.finalAnswerStarted) {
            stream.finalAnswerStarted = true;
            stream.buffer = "";
            stream.hasTextOutput = false;
            stream.lastEditTime = 0;
          }
        }

        if (item.type === "commandExecution" && typeof item.command === "string") {
          const command = item.command.length > 80 ? item.command.slice(0, 80) + "…" : item.command;
          stream.lastActivity = `${L("Running command", "명령어 실행 중")} \`${command}\``;
        } else if (item.type === "fileChange") {
          stream.lastActivity = L("Editing files", "파일 편집 중");
        } else if (item.type === "webSearch") {
          stream.lastActivity = L("Searching web", "웹 검색 중");
        }

        if (!stream.hasTextOutput) {
          const elapsed = Math.round((Date.now() - stream.startedAt) / 1000);
          try {
            await stream.messages.at(-1)?.edit({
              content: `⏳ ${stream.lastActivity} (${elapsed}s) [${stream.toolUseCount} items]`,
              components: [stream.stopRow],
            });
          } catch {
            // ignore
          }
        }
        return;
      }
      case "item/agentMessage/delta": {
        if (!stream || typeof params.delta !== "string") return;
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        const phase = itemId ? stream.agentMessagePhases.get(itemId) : undefined;
        if (stream.finalAnswerStarted && phase !== "final_answer") return;
        stream.buffer += params.delta;
        const proposedPlanMessage = formatMessageWithProposedPlan(stream.buffer);
        if (proposedPlanMessage) {
          stream.finalAnswerStarted = true;
          stream.completedPlan = true;
          stream.buffer = proposedPlanMessage.display;
        }
        stream.hasTextOutput = true;
        await this.flushStream(channelId);
        return;
      }
      case "agent_message": {
        if (!stream || typeof params.message !== "string" || !params.message.trim()) return;
        const phase = getString(params.phase);
        if (phase && phase !== "final_answer") return;
        const proposedPlanMessage = formatMessageWithProposedPlan(params.message);
        if (!proposedPlanMessage && stream.completedPlan) return;
        stream.finalAnswerStarted = true;
        stream.completedPlan = Boolean(proposedPlanMessage);
        stream.buffer = proposedPlanMessage?.display ?? params.message.trim();
        stream.hasTextOutput = true;
        stream.lastEditTime = 0;
        await this.flushStream(channelId);
        return;
      }
      case "message": {
        if (!stream) return;
        const assistantMessage = getAssistantMessageText(params);
        if (!assistantMessage) return;
        const phase = getString(params.phase);
        if (phase && phase !== "final_answer") return;
        const proposedPlanMessage = formatMessageWithProposedPlan(assistantMessage);
        if (!proposedPlanMessage && stream.completedPlan) return;
        stream.finalAnswerStarted = true;
        stream.completedPlan = Boolean(proposedPlanMessage);
        stream.buffer = proposedPlanMessage?.display ?? assistantMessage.trim();
        stream.hasTextOutput = true;
        stream.lastEditTime = 0;
        await this.flushStream(channelId);
        return;
      }
      case "item/completed":
      case "item_completed": {
        if (!stream) return;
        const item = params.item as Record<string, unknown> | undefined;
        if (item?.type === "Plan" && typeof item.text === "string" && item.text.trim()) {
          stream.finalAnswerStarted = true;
          stream.completedPlan = true;
          stream.buffer = item.text.trim();
          stream.hasTextOutput = true;
          stream.lastEditTime = 0;
          await this.flushStream(channelId);
        }
        return;
      }
      case "error": {
        if (!stream) return;
        const error = params.error as { message?: string; additionalDetails?: string | null } | undefined;
        if (!error?.message) return;
        stream.lastError = error.additionalDetails
          ? `${error.message}\n${error.additionalDetails}`
          : error.message;
        return;
      }
      case "turn/completed":
      case "task_complete":
      case "turn_aborted": {
        if (turnId) {
          active.completedTurnIds ??= new Set();
          if (active.completedTurnIds.has(turnId)) return;
          active.completedTurnIds.add(turnId);
        }
        const turn = params.turn as { status?: string | { type?: string }; error?: { message?: string; additionalDetails?: string | null } | null } | undefined;
        const statusType =
          method === "task_complete"
            ? "completed"
            :
          typeof turn?.status === "string"
            ? turn.status
            : typeof turn?.status === "object" && turn.status
              ? turn.status.type
              : undefined;

        if (method === "turn_aborted" || statusType === "interrupted") {
          if (stream) await stream.messages.at(-1)?.edit({ content: L("⏹️ Stopped", "⏹️ 중지됨"), components: [] }).catch(() => {});
          updateSessionStatus(channelId, "idle");
          await this.finishSession(channelId);
          return;
        }
        if (statusType === "failed") {
          const message =
            turn?.error?.additionalDetails
              ? `${turn.error.message ?? "Turn failed"}\n${turn.error.additionalDetails}`
              : turn?.error?.message ?? stream?.lastError ?? "Turn failed";
          if (stream) {
            await stream.messages.at(-1)?.edit({ content: `❌ ${message}`, components: [] }).catch(() => {});
          }
          updateSessionStatus(channelId, "offline");
          await this.finishSession(channelId);
          return;
        }

        let continuingTurnId: string | null = null;
        let hasQueuedTurns = false;
        try {
          hasQueuedTurns = (await codexAppServer.listQueuedTurns(active.threadId)).length > 0;
          const thread = await codexAppServer.readThread(active.threadId, true);
          continuingTurnId = thread.turns?.find((turn) =>
            turn.id !== active.turnId &&
            (typeof turn.status === "string" ? turn.status : turn.status.type) === "inProgress")?.id ?? null;
        } catch {
          // Completion reporting remains available if queue inspection fails.
        }
        if (stream) {
          const durationMs = Date.now() - stream.startedAt;
          const canRecoverStoredPlan = normalizeCollaborationMode(stream.collaborationMode) === "plan" && Boolean(active.turnId);
          const storedFinalMessage = canRecoverStoredPlan
            ? await readCurrentTurnFinalMessage(active.threadId, active.turnId)
            : null;
          const proposedPlanMessage =
            formatMessageWithProposedPlan(stream.buffer) ??
            (!stream.completedPlan && storedFinalMessage ? formatMessageWithProposedPlan(storedFinalMessage) : null);
          if (proposedPlanMessage) {
            stream.finalAnswerStarted = true;
            stream.completedPlan = true;
            stream.buffer = proposedPlanMessage.display;
          } else if (storedFinalMessage && !stream.finalAnswerStarted) {
            stream.buffer = storedFinalMessage;
          }
          const tokenStats = await readLatestThreadTokenStats(active.threadId);
          const limitStatus = tokenStats.limitStatus ?? stream.limitStatus ?? await fetchFreshLimitStatus();
          const contextStatus = tokenStats.contextStatus ?? stream.contextStatus;
          let sessionName: string | undefined;
          try {
            sessionName = (await codexAppServer.readThread(active.threadId, false)).name?.trim() || undefined;
          } catch {
            // Keep completion reporting available if the thread metadata read fails.
          }
          sessionName ||= getStoredThread(active.threadId)?.title?.trim() || `Session ${active.threadId.slice(0, 8)}`;
          const completion = createCompletionSummaryText(durationMs, {
            model: stream.model,
            reasoning: stream.reasoning,
            contextStatus,
            limitStatus,
            sessionName,
          });
          stream.buffer = stream.buffer.trimEnd()
            ? `${stream.buffer.trimEnd()}\n\n${completion}`
            : `${L("Task completed", "작업 완료")}\n\n${completion}`;
          stream.hasTextOutput = true;
          await this.flushStream(channelId, true);
        }

        if (stream && (hasQueuedTurns || continuingTurnId)) {
          // The server dispatches queued turns itself. Keep the writer and
          // stream handler until the last queued turn completes.
          active.turnId = continuingTurnId;
          stream.buffer = "";
          stream.startedAt = Date.now();
          stream.hasTextOutput = false;
          stream.finalAnswerStarted = false;
          stream.completedPlan = false;
          stream.agentMessagePhases.clear();
          stream.lastError = null;
          stream.toolUseCount = 0;
          stream.lastEditTime = 0;
          stream.messages = [await active.channel.send({
            content: L("⏳ Thinking...", "⏳ 생각 중..."), components: [stream.stopRow],
          })];
          updateSessionStatus(channelId, "online");
          return;
        }
        updateSessionStatus(channelId, "idle");
        await this.finishSession(channelId);
      }
    }
  }

  private async handleServerRequest(msg: { id: number; method: string; params: Record<string, unknown> }): Promise<void> {
    const threadId =
      typeof msg.params.threadId === "string"
        ? msg.params.threadId
        : typeof msg.params.conversationId === "string"
          ? msg.params.conversationId
          : null;
    const active = threadId ? this.findActiveByThread(threadId) : undefined;

    if (!active) {
      const response =
        isMcpElicitationRequest(msg.method)
          ? { action: "cancel" }
          : { decision: "decline" };
      await codexAppServer.respond(msg.id, response);
      return;
    }

    if (isMcpElicitationRequest(msg.method)) {
      const response = await this.askUserInput(
        active.channel,
        active.channelId,
        msg.id,
        getSchemaQuestions(msg.params),
      );
      await codexAppServer.respond(msg.id, response);
      return;
    }

    const project = getProject(active.channelId);
    if (project?.auto_approve) {
      await codexAppServer.respond(msg.id, { decision: "acceptForSession" });
      return;
    }

    const decision = await this.requestApproval(active.channel, active.channelId, msg.id, msg.method, msg.params);
    await codexAppServer.respond(msg.id, { decision });
  }

  private async requestApproval(
    channel: TextChannel,
    channelId: string,
    requestId: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<ApprovalDecision> {
    const toolName =
      method === "item/fileChange/requestApproval"
        ? "FileChange"
        : method === "item/commandExecution/requestApproval"
          ? "Bash"
          : "CodexAction";

    const input =
      method === "item/commandExecution/requestApproval"
        ? {
            command: typeof params.command === "string"
              ? params.command
              : Array.isArray(params.command)
                ? params.command.join(" ")
                : params.reason ?? "unknown",
            description: params.reason,
          }
        : params;

    const { embed, row } = createToolApprovalEmbed(toolName, input as Record<string, unknown>, String(requestId));
    updateSessionStatus(channelId, "waiting");
    await channel.send({ embeds: [embed], components: [row] });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingApprovals.delete(requestId);
        updateSessionStatus(channelId, "online");
        resolve("cancel");
      }, 5 * 60 * 1000);

      pendingApprovals.set(requestId, {
        channelId,
        resolve: (decision) => {
          clearTimeout(timeout);
          pendingApprovals.delete(requestId);
          updateSessionStatus(channelId, "online");
          resolve(decision);
        },
      });
    });
  }

  private async askUserInput(
    channel: TextChannel,
    channelId: string,
    requestId: number,
    questions: QuestionPayload[],
  ): Promise<QuestionResponse> {
    const answers: QuestionAnswers = {};
    const content: Record<string, string | string[]> = {};
    let canceled = false;

    for (let index = 0; index < questions.length; index++) {
      const question = questions[index];
      const { embed, components } = createAskUserQuestionEmbed(
        {
          header: question.header,
          question: question.question,
          options: question.options ?? [],
          multiSelect: question.multiSelect ?? false,
        },
        String(requestId),
        index,
        questions.length,
      );

      updateSessionStatus(channelId, "waiting");
      await channel.send({ embeds: [embed], components });

      const answer = await new Promise<QuestionAnswers | null>((resolve) => {
        const timeout = setTimeout(() => {
          pendingQuestions.delete(requestId);
          pendingCustomInputs.delete(channelId);
          resolve(null);
        }, 5 * 60 * 1000);

        pendingQuestions.set(requestId, {
          channelId,
          questionId: question.id,
          resolve: (value) => {
            clearTimeout(timeout);
            pendingQuestions.delete(requestId);
            resolve(value);
          },
        });
      });

      if (!answer) {
        canceled = true;
        break;
      }

      answers[question.id] = answer[question.id] ?? { answers: [] };
      const values = answers[question.id].answers;
      content[question.id] = values.length <= 1 ? values[0] ?? "" : values;
    }

    updateSessionStatus(channelId, "online");
    return { action: canceled ? "cancel" : "accept", answers, content };
  }

  private async flushStream(channelId: string, final = false): Promise<void> {
    const stream = this.streamState.get(channelId);
    const active = this.sessions.get(channelId);
    if (!stream || !active || stream.buffer.length === 0) return;

    const now = Date.now();
    if (!final && now - stream.lastEditTime < 1500) return;
    stream.lastEditTime = now;
    if (!final) stream.stopRow = createStopButton(channelId, new Date(now));

    const chunks = splitMessage(stream.buffer);
    try {
      for (let i = 0; i < chunks.length; i++) {
        const isLastChunk = i === chunks.length - 1;
        const payload = {
          content: chunks[i] || "...",
          components: isLastChunk
            ? final
              ? [createCompletedButton(channelId, stream.completedPlan, active.threadId)]
              : [stream.stopRow]
            : [],
        };

        const existingMessage = stream.messages[i];
        if (existingMessage) {
          await existingMessage.edit(payload);
        } else {
          stream.messages.push(await active.channel.send(payload));
        }
      }
      if (stream.messages.length > chunks.length) {
        const staleMessages = stream.messages.splice(chunks.length);
        await Promise.all(staleMessages.map((message) => message.delete().catch(() => {})));
      }
    } catch {
      // ignore
    }
  }

  private findActiveByThread(threadId: string): ActiveSession | undefined {
    return [...this.sessions.values()].find((entry) => entry.threadId === threadId);
  }

  private findActiveByTurn(turnId: string): ActiveSession | undefined {
    return [...this.sessions.values()].find((entry) => entry.turnId === turnId);
  }

  async stopSession(channelId: string): Promise<boolean> {
    const session = this.sessions.get(channelId);
    if (!session || !session.turnId) return false;

    try {
      await codexAppServer.interruptTurn(session.threadId, session.turnId);
    } catch {
      // ignore
    }

    updateSessionStatus(channelId, "offline");
    await this.finishSession(channelId);
    return true;
  }

  private async finishSession(channelId: string): Promise<void> {
    const session = this.sessions.get(channelId);
    const stream = this.streamState.get(channelId);
    if (stream) {
      clearInterval(stream.heartbeat);
      this.streamState.delete(channelId);
    }

    if (session) {
      try {
        await codexAppServer.releaseThread(session.threadId);
      } catch (error) {
        console.error(`[codex] Failed to release thread ${session.threadId}:`, error);
      }
    }
    this.sessions.delete(channelId);
    pendingCustomInputs.delete(channelId);

  }

  isActive(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  resolveApproval(requestId: string, decision: "approve" | "deny" | "approve-all"): boolean {
    const id = Number(requestId);
    const pending = pendingApprovals.get(id);
    if (!pending) return false;

    if (decision === "approve-all") {
      setAutoApprove(pending.channelId, true);
      pending.resolve("acceptForSession");
    } else if (decision === "approve") {
      pending.resolve("accept");
    } else {
      pending.resolve("cancel");
    }

    return true;
  }

  resolveQuestion(requestId: string, answer: string | string[]): boolean {
    const id = Number(requestId);
    const pending = pendingQuestions.get(id);
    if (!pending) return false;
    pending.resolve({ [pending.questionId]: { answers: Array.isArray(answer) ? answer : [answer] } });
    return true;
  }

  enableCustomInput(requestId: string, channelId: string, questionId = "answer"): void {
    const id = Number(requestId);
    pendingCustomInputs.set(channelId, {
      requestId: id,
      questionId: pendingQuestions.get(id)?.questionId ?? questionId,
    });
  }

  resolveCustomInput(channelId: string, text: string): boolean {
    const ci = pendingCustomInputs.get(channelId);
    if (!ci) return false;
    pendingCustomInputs.delete(channelId);

    const pending = pendingQuestions.get(ci.requestId);
    if (!pending) return false;
    pending.resolve({ [ci.questionId]: { answers: [text] } });
    return true;
  }

  hasPendingCustomInput(channelId: string): boolean {
    return pendingCustomInputs.has(channelId);
  }

  hasPendingUserInput(channelId: string): boolean {
    if (pendingCustomInputs.has(channelId)) return true;
    return [...pendingQuestions.values()].some((pending) => pending.channelId === channelId);
  }

  resolvePendingUserInput(channelId: string, text: string): boolean {
    if (this.resolveCustomInput(channelId, text)) return true;

    for (const [, pending] of pendingQuestions) {
      if (pending.channelId !== channelId) continue;
      pending.resolve({ [pending.questionId]: { answers: [text] } });
      return true;
    }

    return false;
  }

  setPendingQueue(channelId: string, channel: TextChannel, input: string | CodexTurnInput): void {
    this.pendingQueuePrompts.set(channelId, {
      channel,
      input: typeof input === "string" ? { prompt: input } : input,
    });
  }

  async confirmQueue(channelId: string): Promise<number | null> {
    const pending = this.pendingQueuePrompts.get(channelId);
    const active = this.sessions.get(channelId);
    if (!pending || !active) return null;
    const existing = await codexAppServer.listQueuedTurns(active.threadId);
    if (existing.length >= SessionManager.MAX_QUEUE_SIZE) {
      throw new Error("Queue is full (max 5). Please wait for the current task to finish.");
    }
    const queued = await codexAppServer.queueTurn(active.threadId, pending.input);
    try {
      // Queue add normally dispatches automatically when the thread is idle and
      // waits for an active turn to finish. Starting explicitly also recovers a
      // queue that was left paused after an interruption. The app-server rejects
      // this with "busy" while a turn is active; that case is expected.
      await codexAppServer.startQueuedTurn(active.threadId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/thread already has an active or pending turn|busy/i.test(message)) {
        console.warn(`[codex] Queued submission ${queued.id} was saved but queue start failed: ${message}`);
      }
    }
    this.pendingQueuePrompts.delete(channelId);
    return existing.length + 1;
  }

  async steerPendingMessage(channelId: string): Promise<boolean> {
    const pending = this.pendingQueuePrompts.get(channelId);
    const active = this.sessions.get(channelId);
    if (!pending || !active?.turnId) return false;
    const result = await codexAppServer.steerTurn(active.threadId, active.turnId, pending.input);
    active.turnId = result.turnId;
    this.pendingQueuePrompts.delete(channelId);
    return true;
  }

  cancelQueue(channelId: string): void {
    this.pendingQueuePrompts.delete(channelId);
  }

  async isQueueFull(channelId: string): Promise<boolean> {
    const threadId = this.sessions.get(channelId)?.threadId;
    if (!threadId) return false;
    return (await codexAppServer.listQueuedTurns(threadId)).length >= SessionManager.MAX_QUEUE_SIZE;
  }

  hasQueue(channelId: string): boolean {
    return this.pendingQueuePrompts.has(channelId);
  }

  private async withQueueThread<T>(channelId: string, fallback: T, action: (threadId: string) => Promise<T>): Promise<T> {
    const active = this.sessions.get(channelId);
    const threadId = active?.threadId ?? getSession(channelId)?.session_id;
    if (!threadId) return fallback;
    if (!active) await codexAppServer.resumeThread(threadId);
    try {
      return await action(threadId);
    } finally {
      if (!this.findActiveByThread(threadId)) await codexAppServer.releaseThread(threadId);
    }
  }

  async getQueueSize(channelId: string): Promise<number> {
    return this.withQueueThread(channelId, 0, async (threadId) =>
      (await codexAppServer.listQueuedTurns(threadId)).length);
  }

  async getQueue(channelId: string): Promise<{ id: string; prompt: string }[]> {
    return this.withQueueThread(channelId, [], async (threadId) => {
      const queue = await codexAppServer.listQueuedTurns(threadId);
      return queue.map((entry) => ({
        id: entry.id,
        prompt: entry.input.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n"),
      }));
    });
  }

  async clearQueue(channelId: string): Promise<number> {
    this.pendingQueuePrompts.delete(channelId);
    return this.withQueueThread(channelId, 0, async (threadId) => {
      const queue = await codexAppServer.listQueuedTurns(threadId);
      let count = 0;
      for (const entry of queue) {
        if (await codexAppServer.deleteQueuedTurn(threadId, entry.id)) count += 1;
      }
      return count;
    });
  }

  async removeFromQueue(channelId: string, queuedSubmissionId: string): Promise<string | null> {
    return this.withQueueThread(channelId, null as string | null, async (threadId) => {
      const queue = await codexAppServer.listQueuedTurns(threadId);
      const entry = queue.find((item) => item.id === queuedSubmissionId);
      if (!entry || !(await codexAppServer.deleteQueuedTurn(threadId, entry.id))) return null;
      return entry.input.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
    });
  }

}

export const sessionManager = new SessionManager();
