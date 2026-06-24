import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { getProject, setProjectCollaborationMode, upsertSession } from "../../db/database.js";
import type { CollaborationMode } from "../../db/types.js";
import { L } from "../../utils/i18n.js";

function normalizeMode(value: string): CollaborationMode {
  if (value === "on") return "plan";
  if (value === "off") return "code";
  return value as CollaborationMode;
}

function displayMode(mode: CollaborationMode | null | undefined): string {
  if (mode === "plan") return "`plan`";
  if (mode === "code") return "`code`";
  return "`default`";
}

export const data = new SlashCommandBuilder()
  .setName("plan")
  .setDescription("Toggle Codex plan mode for this channel")
  .addStringOption((opt) =>
    opt
      .setName("mode")
      .setDescription("Plan mode setting")
      .setRequired(true)
      .addChoices(
        { name: "on", value: "on" },
        { name: "off", value: "off" },
        { name: "default", value: "default" },
      ),
  )
  .addBooleanOption((opt) =>
    opt
      .setName("new_session")
      .setDescription("Prepare a new session so the next message starts with this mode")
      .setRequired(false),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channelId = interaction.channelId;
  const project = getProject(channelId);

  if (!project) {
    await interaction.editReply({
      content: L("This channel is not registered to any project. Use `/register` first.", "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다. 먼저 `/register`를 사용하세요."),
    });
    return;
  }

  const mode = normalizeMode(interaction.options.getString("mode", true));
  const createNewSession = interaction.options.getBoolean("new_session") ?? false;
  setProjectCollaborationMode(channelId, mode);

  if (createNewSession) {
    upsertSession(randomUUID(), channelId, null, "idle");
  }

  await interaction.editReply({
    embeds: [
      {
        title: L("Codex Plan Mode", "Codex 계획 모드"),
        description: [
          `Project: \`${project.project_path}\``,
          `${L("Mode", "모드")}: ${displayMode(mode)}`,
          createNewSession
            ? L("A new session is ready. The next message will start with this mode.", "새 세션이 준비되었습니다. 다음 메시지는 이 모드로 시작합니다.")
            : L("Saved. This applies when the next new Codex thread starts. Use `new_session:true` to force that now.", "저장되었습니다. 다음 새 Codex 스레드가 시작될 때 적용됩니다. 지금 강제하려면 `new_session:true`를 사용하세요."),
        ].join("\n"),
        color: mode === "plan" ? 0x5865f2 : 0x10b981,
      },
    ],
  });
}
