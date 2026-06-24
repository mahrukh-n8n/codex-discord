import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProject, setProjectCodexSettings, upsertSession } from "../../db/database.js";
import { L } from "../../utils/i18n.js";

type AutocompleteChoice = { name: string; value: string };

export interface CachedCodexModel {
  slug: string;
  display_name?: string;
  supported_reasoning_levels?: Array<{ effort?: string; description?: string }>;
  input_modalities?: string[];
  visibility?: string;
}

interface ModelsCache {
  models?: CachedCodexModel[];
}

const DEFAULT_REASONING_LEVELS = ["default", "low", "medium", "high", "xhigh"];
const MAX_AUTOCOMPLETE_CHOICES = 25;
const MAX_CHOICE_LENGTH = 100;

function normalizeModel(value: string | null): string | null | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") return null;
  return trimmed;
}

function normalizeReasoning(value: string | null): string | null | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "default") return null;
  return trimmed;
}

function displaySetting(value: string | null | undefined): string {
  return value ? `\`${value}\`` : "`default`";
}

function truncateChoice(value: string): string {
  return value.length <= MAX_CHOICE_LENGTH ? value : value.slice(0, MAX_CHOICE_LENGTH);
}

function getModelChoiceName(model: CachedCodexModel): string {
  const display = model.display_name?.trim();
  if (display && display !== model.slug) return `${display} (${model.slug})`;
  return model.slug;
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function loadCachedCodexModels(
  cachePath = path.join(os.homedir(), ".codex", "models_cache.json"),
): CachedCodexModel[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as ModelsCache;
    return (parsed.models ?? []).filter(
      (model) => typeof model.slug === "string" && model.slug.length > 0 && model.visibility !== "hidden",
    );
  } catch {
    return [];
  }
}

export function getModelAutocompleteChoices(
  models: CachedCodexModel[],
  focusedValue: string,
): AutocompleteChoice[] {
  const focused = focusedValue.trim().toLowerCase();
  const defaultChoice = { name: "default", value: "default" };
  const modelChoices = models
    .filter((model) => {
      if (!focused) return true;
      return (
        model.slug.toLowerCase().includes(focused) ||
        (model.display_name ?? "").toLowerCase().includes(focused)
      );
    })
    .map((model) => ({
      name: truncateChoice(getModelChoiceName(model)),
      value: truncateChoice(model.slug),
    }));

  return [defaultChoice, ...modelChoices].slice(0, MAX_AUTOCOMPLETE_CHOICES);
}

export function getReasoningAutocompleteChoices(
  models: CachedCodexModel[],
  selectedModel: string | null,
  focusedValue: string,
): AutocompleteChoice[] {
  const modelSlug = selectedModel?.trim();
  const model = modelSlug && modelSlug !== "default"
    ? models.find((candidate) => candidate.slug === modelSlug)
    : undefined;

  const levels = model?.supported_reasoning_levels?.length
    ? uniqueValues([
        "default",
        ...model.supported_reasoning_levels
          .map((level) => level.effort?.trim().toLowerCase() ?? "")
          .filter(Boolean),
      ])
    : DEFAULT_REASONING_LEVELS;

  const focused = focusedValue.trim().toLowerCase();
  return levels
    .filter((level) => !focused || level.includes(focused))
    .map((level) => ({ name: level, value: level }))
    .slice(0, MAX_AUTOCOMPLETE_CHOICES);
}

export const data = new SlashCommandBuilder()
  .setName("model")
  .setDescription("View or set the Codex model and reasoning effort for this channel")
  .addStringOption((opt) =>
    opt
      .setName("model")
      .setDescription("Model name, for example gpt-5.5. Use default to clear.")
      .setRequired(false)
      .setAutocomplete(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("reasoning")
      .setDescription("Reasoning effort for new Codex threads")
      .setRequired(false)
      .setAutocomplete(true),
  )
  .addBooleanOption((opt) =>
    opt
      .setName("new_session")
      .setDescription("Prepare a new session so the next message uses these settings")
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

  const model = normalizeModel(interaction.options.getString("model"));
  const reasoning = normalizeReasoning(interaction.options.getString("reasoning"));
  const createNewSession = interaction.options.getBoolean("new_session") ?? false;
  const changed = model !== undefined || reasoning !== undefined;

  if (changed) {
    setProjectCodexSettings(channelId, model, reasoning);
  }

  const updated = getProject(channelId) ?? project;

  if (createNewSession) {
    const { randomUUID } = await import("node:crypto");
    upsertSession(randomUUID(), channelId, null, "idle");
  }

  await interaction.editReply({
    embeds: [
      {
        title: L("Codex Model Settings", "Codex 모델 설정"),
        description: [
          `Project: \`${updated.project_path}\``,
          `${L("Model", "모델")}: ${displaySetting(updated.codex_model)}`,
          `${L("Reasoning", "추론")}: ${displaySetting(updated.reasoning_effort)}`,
          changed
            ? L("These settings apply when the next new Codex thread starts.", "이 설정은 다음 새 Codex 스레드가 시작될 때 적용됩니다.")
            : L("Run `/model model:<name> reasoning:<effort>` to change them.", "`/model model:<이름> reasoning:<수준>`으로 변경하세요."),
          createNewSession
            ? L("A new session is ready. The next message will use these settings.", "새 세션이 준비되었습니다. 다음 메시지는 이 설정을 사용합니다.")
            : L("Use `new_session:true` to force the next message into a new thread.", "`new_session:true`를 사용하면 다음 메시지를 새 스레드에서 시작합니다."),
        ].join("\n"),
        color: changed ? 0x10b981 : 0x5865f2,
      },
    ],
  });
}

export async function autocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const models = loadCachedCodexModels();

  try {
    if (focused.name === "model") {
      await interaction.respond(getModelAutocompleteChoices(models, String(focused.value ?? "")));
      return;
    }

    if (focused.name === "reasoning") {
      await interaction.respond(
        getReasoningAutocompleteChoices(
          models,
          interaction.options.getString("model"),
          String(focused.value ?? ""),
        ),
      );
      return;
    }

    await interaction.respond([]);
  } catch {
    await interaction.respond([]);
  }
}
