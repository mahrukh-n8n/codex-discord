import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { isAllowedUser } from "../../security/guard.js";
import { sessionManager } from "../../codex/session-manager.js";
import { upsertSession, getSession, setProjectCollaborationMode } from "../../db/database.js";
import { codexAppServer } from "../../codex/app-server-client.js";
import { deleteStoredThread, getStoredThread } from "../../codex/storage.js";
import { L } from "../../utils/i18n.js";

export async function handleButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: L("You are not authorized.", "권한이 없습니다."),
      ephemeral: true,
    });
    return;
  }

  const customId = interaction.customId;
  const colonIndex = customId.indexOf(":");
  const action = colonIndex === -1 ? customId : customId.slice(0, colonIndex);
  const requestId = colonIndex === -1 ? "" : customId.slice(colonIndex + 1);

  if (!requestId) {
    await interaction.reply({
      content: L("Invalid button interaction.", "잘못된 버튼 상호작용입니다."),
      ephemeral: true,
    });
    return;
  }

  if (action === "stop") {
    const stopped = await sessionManager.stopSession(requestId);
    await interaction.update({
      content: L("⏹️ Task has been stopped.", "⏹️ 작업이 중지되었습니다."),
      components: [],
    });
    if (!stopped) {
      await interaction.followUp({
        content: L("No active session.", "활성 세션이 없습니다."),
        ephemeral: true,
      });
    }
    return;
  }

  if (action === "queue-yes") {
    try {
      const queueSize = await sessionManager.confirmQueue(requestId);
      if (queueSize === null) {
        await interaction.update({
          content: L("⏳ Queue request expired because the task is no longer active.", "⏳ 작업이 더 이상 활성 상태가 아니어서 요청이 만료되었습니다."),
          components: [],
        });
        return;
      }
      await interaction.update({
        content: L(`📨 Message saved in Codex queue (${queueSize}/5). It will run after the current task.`, `📨 메시지가 Codex 대기열에 저장되었습니다 (${queueSize}/5). 현재 작업 후 실행됩니다.`),
        components: [],
      });
    } catch (error) {
      await interaction.update({
        content: `❌ ${error instanceof Error ? error.message : "Failed to add message to Codex queue."}`,
      });
    }
    return;
  }

  if (action === "queue-steer") {
    try {
      const sent = await sessionManager.steerPendingMessage(requestId);
      await interaction.update({
        content: sent
          ? L("➡️ Sent to the active Codex task. It will be handled at the next safe point.", "➡️ 진행 중인 Codex 작업에 전달했습니다. 다음 안전한 시점에 처리됩니다.")
          : L("⏳ The task is no longer active. Send your message again.", "⏳ 작업이 더 이상 활성 상태가 아닙니다. 메시지를 다시 보내주세요."),
        components: [],
      });
    } catch (error) {
      await interaction.update({
        content: `❌ ${error instanceof Error ? error.message : "Failed to send to the active Codex task."}`,
      });
    }
    return;
  }

  if (action === "queue-no") {
    sessionManager.cancelQueue(requestId);
    await interaction.update({
      content: L("Cancelled.", "취소되었습니다."),
      components: [],
    });
    return;
  }

  if (action === "implement-plan") {
    setProjectCollaborationMode(requestId, "code");
    await interaction.update({
      content: L("Implementation started from the approved plan.", "승인된 계획을 기반으로 구현을 시작했습니다."),
      components: [],
    });

    if (interaction.channel?.isTextBased()) {
      await sessionManager.sendMessage(interaction.channel as any, {
        prompt: [
          "Switch out of planning and implement the proposed plan from the previous turn.",
          "Use the plan already present in this Codex thread as the implementation spec.",
          "Make the code changes, run the relevant checks, and report the result.",
        ].join("\n"),
      });
    }
    return;
  }

  if (action === "session-resume") {
    const sessionId = requestId;
    const channelId = interaction.channelId;
    const { randomUUID } = await import("node:crypto");
    upsertSession(randomUUID(), channelId, sessionId, "idle");

    await interaction.update({
      embeds: [
        {
          title: L("Session Selected", "세션 선택됨"),
          description: L(
            `Session: \`${sessionId.slice(0, 8)}...\`\n\nNext message you send will resume this Codex thread.`,
            `세션: \`${sessionId.slice(0, 8)}...\`\n\n다음 메시지부터 이 Codex 스레드가 재개됩니다.`
          ),
          color: 0x00ff00,
        },
      ],
      components: [],
    });
    return;
  }

  if (action === "session-rename") {
    const storedName = getStoredThread(requestId)?.title?.replace(/\s+/g, " ").trim() ?? "";
    const currentName = Array.from(storedName).slice(0, 100).join("");
    const nameInput = new TextInputBuilder()
      .setCustomId("name")
      .setLabel(L("Session name", "세션 이름"))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(100);
    if (currentName) nameInput.setValue(currentName);

    const modal = new ModalBuilder()
      .setCustomId(`session-rename-submit:${requestId}`)
      .setTitle(L("Rename Session", "세션 이름 변경"))
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput));
    try {
      await interaction.showModal(modal);
    } catch (error) {
      console.error("Failed to open session rename form:", error);
      await interaction.reply({
        content: L("Couldn't open the rename form. Please try again.", "이름 변경 양식을 열 수 없습니다. 다시 시도해 주세요."),
        ephemeral: true,
      });
    }
    return;
  }

  if (action === "session-cancel") {
    await interaction.update({
      content: L("Cancelled.", "취소되었습니다."),
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "ask-opt") {
    const lastColon = requestId.lastIndexOf(":");
    const actualRequestId = requestId.slice(0, lastColon);
    const selectedLabel = ("label" in interaction.component ? interaction.component.label : null) ?? "Unknown";

    const resolved = sessionManager.resolveQuestion(actualRequestId, selectedLabel);
    if (!resolved) {
      await interaction.reply({ content: L("This question has expired.", "이 질문은 만료되었습니다."), ephemeral: true });
      return;
    }

    await interaction.update({
      content: L(`✅ Selected: **${selectedLabel}**`, `✅ 선택됨: **${selectedLabel}**`),
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "ask-other") {
    sessionManager.enableCustomInput(requestId, interaction.channelId);
    await interaction.update({
      content: L("✏️ Type your answer...", "✏️ 답변을 입력하세요..."),
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "queue-clear") {
    const cleared = await sessionManager.clearQueue(requestId);
    await interaction.update({
      embeds: [
        {
          title: L("Queue Cleared", "큐 초기화됨"),
          description: L(`Cleared ${cleared} queued message(s).`, `${cleared}개의 대기 중이던 메시지를 취소했습니다.`),
          color: 0xff6600,
        },
      ],
      components: [],
    });
    return;
  }

  if (action === "queue-remove") {
    const lastColon = requestId.lastIndexOf(":");
    const channelId = requestId.slice(0, lastColon);
    const queuedSubmissionId = requestId.slice(lastColon + 1);
    const removed = await sessionManager.removeFromQueue(channelId, queuedSubmissionId);

    if (!removed) {
      await interaction.update({
        content: L("This item is no longer in the queue.", "이 항목은 이미 큐에 없습니다."),
        embeds: [],
        components: [],
      });
      return;
    }

    const preview = removed.length > 60 ? removed.slice(0, 60) + "…" : removed;
    const queue = await sessionManager.getQueue(channelId);
    if (queue.length === 0) {
      await interaction.update({
        embeds: [
          {
            title: L("Message Removed", "메시지 취소됨"),
            description: L(`Removed: ${preview}\n\nQueue is now empty.`, `취소됨: ${preview}\n\n큐가 비었습니다.`),
            color: 0xff6600,
          },
        ],
        components: [],
      });
      return;
    }

    const list = queue
      .map((item: { prompt: string }, idx: number) => {
        const p = item.prompt.length > 100 ? item.prompt.slice(0, 100) + "…" : item.prompt;
        return `**${idx + 1}.** ${p}`;
      })
      .join("\n\n");

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    const itemButtons = queue.map((_: unknown, idx: number) =>
      new ButtonBuilder()
        .setCustomId(`queue-remove:${channelId}:${queue[idx].id}`)
        .setLabel(`❌ ${idx + 1}`)
        .setStyle(ButtonStyle.Secondary)
    );
    const clearButton = new ButtonBuilder()
      .setCustomId(`queue-clear:${channelId}`)
      .setLabel(L("Clear All", "모두 취소"))
      .setStyle(ButtonStyle.Danger);

    const allButtons = [...itemButtons.slice(0, 19), clearButton];
    for (let i = 0; i < allButtons.length; i += 5) {
      const chunk = allButtons.slice(i, i + 5);
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...chunk));
    }

    await interaction.update({
      embeds: [
        {
          title: L(`📋 Message Queue (${queue.length})`, `📋 메시지 큐 (${queue.length}개)`),
          description: `~~${preview}~~ ${L("removed", "취소됨")}\n\n${list}`,
          color: 0x5865f2,
        },
      ],
      components: rows,
    });
    return;
  }

  if (action === "session-delete") {
    const channelId = interaction.channelId;
    const deleted = deleteStoredThread(requestId);
    if (deleted) {
      const dbSession = getSession(channelId);
      if (dbSession?.session_id === requestId) {
        const { randomUUID } = await import("node:crypto");
        upsertSession(randomUUID(), channelId, null, "idle");
      }

      await interaction.update({
        embeds: [
          {
            title: L("Session Deleted", "세션 삭제됨"),
            description: L(
              `Session \`${requestId.slice(0, 8)}...\` has been deleted.\nYour next message will start a new conversation.`,
              `세션 \`${requestId.slice(0, 8)}...\`이(가) 삭제되었습니다.\n다음 메시지부터 새로운 대화가 시작됩니다.`
            ),
            color: 0xff6b6b,
          },
        ],
        components: [],
      });
    } else {
      await interaction.update({
        content: L("Failed to delete session.", "세션 삭제에 실패했습니다."),
        embeds: [],
        components: [],
      });
    }
    return;
  }

  let decision: "approve" | "deny" | "approve-all";
  if (action === "approve") {
    decision = "approve";
  } else if (action === "deny") {
    decision = "deny";
  } else if (action === "approve-all") {
    decision = "approve-all";
  } else {
    return;
  }

  const resolved = sessionManager.resolveApproval(requestId, decision);
  if (!resolved) {
    await interaction.reply({
      content: L("This approval request has expired.", "이 승인 요청은 만료되었습니다."),
      ephemeral: true,
    });
    return;
  }

  const labels: Record<string, string> = {
    approve: L("✅ Approved", "✅ 승인됨"),
    deny: L("❌ Denied", "❌ 거부됨"),
    "approve-all": L("⚡ Auto-approve enabled for this channel", "⚡ 이 채널에서 자동 승인이 활성화되었습니다"),
  };

  await interaction.update({
    content: labels[decision],
    components: [],
  });
}

export async function handleSelectMenuInteraction(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: L("You are not authorized.", "권한이 없습니다."),
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId.startsWith("ask-select:")) {
    const askRequestId = interaction.customId.slice("ask-select:".length);
    const options = (interaction.component as any).options ?? [];
    const selectedLabels = interaction.values.map((val: string) => {
      const opt = options.find((o: any) => o.value === val);
      return opt?.label ?? val;
    });
    const answer = selectedLabels.join(", ");

    const resolved = sessionManager.resolveQuestion(askRequestId, selectedLabels);
    if (!resolved) {
      await interaction.reply({ content: L("This question has expired.", "이 질문은 만료되었습니다."), ephemeral: true });
      return;
    }

    await interaction.update({
      content: L(`✅ Selected: **${answer}**`, `✅ 선택됨: **${answer}**`),
      embeds: [],
      components: [],
    });
    return;
  }

  if (interaction.customId !== "session-select") return;

  const selectedSessionId = interaction.values[0];

  if (selectedSessionId === "__new_session__") {
    const channelId = interaction.channelId;
    const { randomUUID } = await import("node:crypto");
    upsertSession(randomUUID(), channelId, null, "idle");

    await interaction.update({
      embeds: [
        {
          title: L("✨ New Session", "✨ 새 세션"),
          description: L("New session is ready.\nA new conversation will start from your next message.", "새 세션이 준비되었습니다.\n다음 메시지부터 새로운 대화가 시작됩니다."),
          color: 0x00ff00,
        },
      ],
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();
  const thread = await codexAppServer.readThread(selectedSessionId, true);
  let lastMessage = "";
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        lastMessage = item.text.trim();
      }
    }
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`session-resume:${selectedSessionId}`)
      .setLabel(L("Resume", "재개"))
      .setStyle(ButtonStyle.Success)
      .setEmoji("▶️"),
    new ButtonBuilder()
      .setCustomId(`session-rename:${selectedSessionId}`)
      .setLabel(L("Rename", "이름 변경"))
      .setStyle(ButtonStyle.Primary)
      .setEmoji("✏️"),
    new ButtonBuilder()
      .setCustomId(`session-delete:${selectedSessionId}`)
      .setLabel(L("Delete", "삭제"))
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🗑️"),
    new ButtonBuilder()
      .setCustomId(`session-cancel:${selectedSessionId}`)
      .setLabel(L("Cancel", "취소"))
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({
    embeds: [
      {
        title: L("Codex Session", "Codex 세션"),
        description: [
          `ID: \`${selectedSessionId.slice(0, 8)}...\``,
          lastMessage ? `${L("Last response", "마지막 응답")}:\n> ${lastMessage.slice(0, 800)}` : L("No assistant response yet.", "아직 assistant 응답이 없습니다."),
        ].join("\n\n"),
        color: 0x5865f2,
      },
    ],
    components: [row],
  });
}

export async function handleModalSubmitInteraction(
  interaction: import("discord.js").ModalSubmitInteraction,
): Promise<void> {
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({ content: L("You are not authorized.", "권한이 없습니다."), ephemeral: true });
    return;
  }

  const prefix = "session-rename-submit:";
  if (!interaction.customId.startsWith(prefix)) return;

  const threadId = interaction.customId.slice(prefix.length);
  const name = interaction.fields.getTextInputValue("name").replace(/\s+/g, " ").trim();
  if (!name) {
    await interaction.reply({ content: L("Session name cannot be empty.", "세션 이름은 비워둘 수 없습니다."), ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    await codexAppServer.setThreadName(threadId, name);
    if (interaction.isFromMessage() && interaction.message) {
      const updatedContent = interaction.message.content.replace(/^(?:Session|세션) \|.*$/m, `Session | ${name}`);
      if (updatedContent !== interaction.message.content) {
        await interaction.message.edit({ content: updatedContent });
      }
    }
    await interaction.editReply(L(`✅ Session renamed to: ${name}`, `✅ 세션 이름을 변경했습니다: ${name}`));
  } catch (error) {
    await interaction.editReply(`❌ ${error instanceof Error ? error.message : "Failed to rename session."}`);
  }
}
