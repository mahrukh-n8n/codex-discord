import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TextChannel } from "discord.js";
import {
  upsertSession,
  updateSessionStatus,
  getProject,
  getSession,
  setAutoApprove,
} from "../db/database.js";
import { L } from "../utils/i18n.js";
import { codexAppServer } from "./app-server-client.js";
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
  dbId: string;
}

interface QuestionPayload {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
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
    const enumValues = Array.isArray(property.enum) ? property.enum : [];
    return {
      id,
      header: getString(property.title) ?? id,
      question: getString(property.description) ?? fallbackQuestion,
      options: enumValues
        .map((value) => getString(value))
        .filter((value): value is string => Boolean(value))
        .map((label) => ({ label, description: "" })),
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
  private messageQueue = new Map<string, { channel: TextChannel; prompt: string }[]>();
  private pendingQueuePrompts = new Map<string, { channel: TextChannel; prompt: string }>();
  private streamState = new Map<string, StreamState>();

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await codexAppServer.ensureStarted();

    codexAppServer.on("notification", (msg) => {
      this.handleNotification(msg as { method: string; params?: Record<string, unknown> }).catch((error) => {
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

  async sendMessage(channel: TextChannel, prompt: string): Promise<void> {
    await this.ensureInitialized();

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
          model: project.codex_model,
          reasoningEffort: project.reasoning_effort,
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
      this.finishSession(channelId);
      return;
    }

    upsertSession(dbId, channelId, threadId, "online");

    const stopRow = createStopButton(channelId);
    const currentMessage = await channel.send({
      content: L("⏳ Thinking...", "⏳ 생각 중..."),
      components: [stopRow],
    });

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
    });

    this.sessions.set(channelId, {
      channelId,
      channel,
      threadId,
      turnId: null,
      dbId,
    });

    try {
      await codexAppServer.startTurn(threadId, prompt);
    } catch (error) {
      await channel.send(`❌ ${error instanceof Error ? error.message : "Failed to start Codex turn"}`);
      updateSessionStatus(channelId, "offline");
      this.finishSession(channelId);
    }
  }

  private async handleNotification(msg: { method: string; params?: Record<string, unknown> }): Promise<void> {
    const params = msg.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const active = threadId ? this.findActiveByThread(threadId) : undefined;
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
    const stream = this.streamState.get(channelId);
    if (stream) {
      stream.limitStatus = formatLimitStatusFromEvent(params) ?? stream.limitStatus;
      stream.contextStatus = formatContextStatusFromEvent(params) ?? stream.contextStatus;
    }

    switch (msg.method) {
      case "turn/started": {
        const turn = params.turn as { id?: string } | undefined;
        if (turn?.id) {
          active.turnId = turn.id;
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
        stream.buffer += params.delta;
        stream.hasTextOutput = true;
        await this.flushStream(channelId);
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
      case "turn/completed": {
        const turn = params.turn as { status?: string | { type?: string }; error?: { message?: string; additionalDetails?: string | null } | null } | undefined;
        const statusType =
          typeof turn?.status === "string"
            ? turn.status
            : typeof turn?.status === "object" && turn.status
              ? turn.status.type
              : undefined;

        if (statusType === "failed") {
          const message =
            turn?.error?.additionalDetails
              ? `${turn.error.message ?? "Turn failed"}\n${turn.error.additionalDetails}`
              : turn?.error?.message ?? stream?.lastError ?? "Turn failed";
          if (stream) {
            await stream.messages.at(-1)?.edit({ content: `❌ ${message}`, components: [] }).catch(() => {});
          }
          updateSessionStatus(channelId, "offline");
          this.finishSession(channelId);
          return;
        }

        if (stream) {
          const durationMs = Date.now() - stream.startedAt;
          const tokenStats = await readLatestThreadTokenStats(active.threadId);
          const limitStatus = tokenStats.limitStatus ?? stream.limitStatus ?? await fetchFreshLimitStatus();
          const contextStatus = tokenStats.contextStatus ?? stream.contextStatus;
          const completion = createCompletionSummaryText(durationMs, {
            model: stream.model,
            reasoning: stream.reasoning,
            contextStatus,
            limitStatus,
          });
          stream.buffer = stream.buffer.trimEnd()
            ? `${stream.buffer.trimEnd()}\n\n${completion}`
            : `${L("Task completed", "작업 완료")}\n\n${completion}`;
          stream.hasTextOutput = true;
          await this.flushStream(channelId, true);
        }

        updateSessionStatus(channelId, "idle");
        this.finishSession(channelId);
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
          multiSelect: false,
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

    const chunks = splitMessage(stream.buffer);
    try {
      for (let i = 0; i < chunks.length; i++) {
        const isLastChunk = i === chunks.length - 1;
        const payload = {
          content: chunks[i] || "...",
          components: isLastChunk
            ? final
              ? [createCompletedButton()]
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
    } catch {
      // ignore
    }
  }

  private findActiveByThread(threadId: string): ActiveSession | undefined {
    return [...this.sessions.values()].find((entry) => entry.threadId === threadId);
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
    this.finishSession(channelId);
    return true;
  }

  private finishSession(channelId: string): void {
    const stream = this.streamState.get(channelId);
    if (stream) {
      clearInterval(stream.heartbeat);
      this.streamState.delete(channelId);
    }

    this.sessions.delete(channelId);
    pendingCustomInputs.delete(channelId);

    const queue = this.messageQueue.get(channelId);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) this.messageQueue.delete(channelId);
      const remaining = queue.length;
      const preview = next.prompt.length > 40 ? next.prompt.slice(0, 40) + "…" : next.prompt;
      const msg = remaining > 0
        ? L(`📨 Processing queued message... (remaining: ${remaining})\n> ${preview}`, `📨 대기 중이던 메시지를 처리합니다... (남은 큐: ${remaining}개)\n> ${preview}`)
        : L(`📨 Processing queued message...\n> ${preview}`, `📨 대기 중이던 메시지를 처리합니다...\n> ${preview}`);
      next.channel.send(msg).catch(() => {});
      this.sendMessage(next.channel, next.prompt).catch((err) => {
        console.error("Queue sendMessage error:", err);
      });
    }
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

  resolveQuestion(requestId: string, answer: string): boolean {
    const id = Number(requestId);
    const pending = pendingQuestions.get(id);
    if (!pending) return false;
    pending.resolve({ [pending.questionId]: { answers: [answer] } });
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

  setPendingQueue(channelId: string, channel: TextChannel, prompt: string): void {
    this.pendingQueuePrompts.set(channelId, { channel, prompt });
  }

  confirmQueue(channelId: string): boolean {
    const pending = this.pendingQueuePrompts.get(channelId);
    if (!pending) return false;
    this.pendingQueuePrompts.delete(channelId);
    const queue = this.messageQueue.get(channelId) ?? [];
    queue.push(pending);
    this.messageQueue.set(channelId, queue);
    return true;
  }

  cancelQueue(channelId: string): void {
    this.pendingQueuePrompts.delete(channelId);
  }

  isQueueFull(channelId: string): boolean {
    const queue = this.messageQueue.get(channelId) ?? [];
    return queue.length >= SessionManager.MAX_QUEUE_SIZE;
  }

  hasQueue(channelId: string): boolean {
    return this.pendingQueuePrompts.has(channelId);
  }

  getQueueSize(channelId: string): number {
    return (this.messageQueue.get(channelId) ?? []).length;
  }

  getQueue(channelId: string): { channel: TextChannel; prompt: string }[] {
    return this.messageQueue.get(channelId) ?? [];
  }

  clearQueue(channelId: string): number {
    const queue = this.messageQueue.get(channelId) ?? [];
    const count = queue.length;
    this.messageQueue.delete(channelId);
    this.pendingQueuePrompts.delete(channelId);
    return count;
  }

  removeFromQueue(channelId: string, index: number): string | null {
    const queue = this.messageQueue.get(channelId) ?? [];
    if (index < 0 || index >= queue.length) return null;
    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) this.messageQueue.delete(channelId);
    return removed.prompt;
  }
}

export const sessionManager = new SessionManager();
