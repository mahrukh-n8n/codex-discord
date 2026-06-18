import { Message, TextChannel, Attachment, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { getProject } from "../../db/database.js";
import { isAllowedUser, checkRateLimit } from "../../security/guard.js";
import { sessionManager } from "../../codex/session-manager.js";
import { isAudioAttachment, transcribeAudioFile } from "../../codex/audio-transcription.js";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { L } from "../../utils/i18n.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MIME_EXTENSION_MAP: Record<string, string> = {
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/wav": ".wav",
  "audio/wave": ".wav",
  "audio/webm": ".webm",
  "audio/x-m4a": ".m4a",
  "audio/x-wav": ".wav",
};
const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".msi", ".scr", ".pif",
  ".dll", ".sys", ".drv",
  ".vbs", ".vbe", ".wsf", ".wsh",
]);
const MAX_FILE_SIZE = 25 * 1024 * 1024;

async function downloadAttachment(
  attachment: Attachment,
  projectPath: string,
): Promise<{ filePath: string; isImage: boolean; isAudio: boolean; mimeType: string } | { skipped: string } | null> {
  const normalizedContentType = attachment.contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const nameExt = path.extname(attachment.name ?? "").toLowerCase();
  const ext = nameExt || MIME_EXTENSION_MAP[normalizedContentType] || "";

  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { skipped: L(`Blocked: \`${attachment.name}\` (dangerous file type)`, `차단됨: \`${attachment.name}\` (위험한 파일 형식)`) };
  }

  if (attachment.size > MAX_FILE_SIZE) {
    const sizeMB = (attachment.size / 1024 / 1024).toFixed(1);
    return { skipped: L(`Skipped: \`${attachment.name}\` (${sizeMB}MB exceeds 25MB limit)`, `건너뜀: \`${attachment.name}\` (${sizeMB}MB, 25MB 제한 초과)`) };
  }

  const uploadDir = path.join(projectPath, ".codex-uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const baseName = attachment.name?.trim() || `attachment${ext || ""}`;
  const fileName = `${Date.now()}-${baseName}`;
  const filePath = path.join(uploadDir, fileName);

  try {
    const response = await fetch(attachment.url);
    if (!response.ok || !response.body) {
      return { skipped: L(`Failed to download: \`${attachment.name}\``, `다운로드 실패: \`${attachment.name}\``) };
    }

    const fileStream = fs.createWriteStream(filePath);
    await pipeline(Readable.fromWeb(response.body as never), fileStream);
  } catch (e) {
    console.warn(`[download] Failed to download attachment ${attachment.name}:`, e instanceof Error ? e.message : e);
    return { skipped: L(`Failed to download: \`${attachment.name}\``, `다운로드 실패: \`${attachment.name}\``) };
  }

  return {
    filePath,
    isImage: IMAGE_EXTENSIONS.has(ext),
    isAudio: isAudioAttachment(baseName, normalizedContentType),
    mimeType: normalizedContentType || "application/octet-stream",
  };
}

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot || !message.guild) return;

  const project = getProject(message.channelId);
  if (!project) return;

  if (!isAllowedUser(message.author.id)) {
    await message.reply(L("You are not authorized to use this bot.", "이 봇을 사용할 권한이 없습니다."));
    return;
  }

  if (!checkRateLimit(message.author.id)) {
    await message.reply(L("Rate limit exceeded. Please wait a moment.", "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요."));
    return;
  }

  if (sessionManager.hasPendingCustomInput(message.channelId)) {
    const text = message.content.trim();
    if (text) {
      sessionManager.resolveCustomInput(message.channelId, text);
      await message.react("✅");
    }
    return;
  }

  let prompt = message.content.trim();
  const imagePaths: string[] = [];
  const filePaths: string[] = [];
  const audioTranscripts: string[] = [];
  const skippedMessages: string[] = [];

  for (const [, attachment] of message.attachments) {
    const result = await downloadAttachment(attachment, project.project_path);
    if (!result) continue;
    if ("skipped" in result) {
      skippedMessages.push(result.skipped);
      continue;
    }
    console.log(
      `[attachments] ${attachment.name ?? path.basename(result.filePath)} ` +
      `image=${result.isImage} audio=${result.isAudio} mime=${result.mimeType}`,
    );
    if (result.isImage) {
      imagePaths.push(result.filePath);
    } else if (result.isAudio) {
      try {
        console.log(`[audio] Starting transcription for ${attachment.name ?? path.basename(result.filePath)}`);
        const transcript = await transcribeAudioFile(result.filePath, result.mimeType);
        audioTranscripts.push(
          [
            `[Transcribed audio: ${attachment.name ?? path.basename(result.filePath)}]`,
            transcript,
          ].join("\n"),
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[audio] Transcription failed for ${attachment.name ?? path.basename(result.filePath)}: ${reason}`);
        skippedMessages.push(
          L(
            `Failed to transcribe: \`${attachment.name ?? path.basename(result.filePath)}\` (${reason})`,
            `전사 실패: \`${attachment.name ?? path.basename(result.filePath)}\` (${reason})`,
          ),
        );
      }
    } else {
      filePaths.push(result.filePath);
    }
  }

  if (skippedMessages.length > 0) {
    await message.reply(skippedMessages.join("\n"));
  }

  if (imagePaths.length > 0) {
    prompt += `\n\n[Attached images - inspect these local files]\n${imagePaths.join("\n")}`;
  }
  if (audioTranscripts.length > 0) {
    prompt += `\n\n[Audio transcripts]\n${audioTranscripts.join("\n\n")}`;
  }
  if (filePaths.length > 0) {
    prompt += `\n\n[Attached files - inspect these local files]\n${filePaths.join("\n")}`;
  }

  if (!prompt) return;

  const channel = message.channel as TextChannel;

  if (sessionManager.isActive(message.channelId)) {
    if (sessionManager.hasQueue(message.channelId)) {
      await message.reply(L("⏳ A message is already waiting to be queued. Please press the button first.", "⏳ 이미 큐 추가 대기 중인 메시지가 있습니다. 버튼을 먼저 눌러주세요."));
      return;
    }
    if (sessionManager.isQueueFull(message.channelId)) {
      await message.reply(L("⏳ Queue is full (max 5). Please wait for the current task to finish.", "⏳ 큐가 가득 찼습니다 (최대 5개). 현재 작업 완료를 기다려주세요."));
      return;
    }

    sessionManager.setPendingQueue(message.channelId, channel, prompt);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`queue-yes:${message.channelId}`)
        .setLabel(L("Add to Queue", "큐에 추가"))
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅"),
      new ButtonBuilder()
        .setCustomId(`queue-no:${message.channelId}`)
        .setLabel(L("Cancel", "취소"))
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("❌"),
    );

    await message.reply({
      content: L("⏳ A previous task is in progress. Process this automatically when done?", "⏳ 이전 작업이 진행 중입니다. 완료 후 자동으로 처리할까요?"),
      components: [row],
    });
    return;
  }

  await sessionManager.sendMessage(channel, prompt);
}
