import { readFile } from "node:fs/promises";
import type { Logger } from "pino";

import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";

import type { Config, DingTalkIdentity } from "./config.js";
import { classifyDeliveryError, withDeliveryRetry } from "./delivery.js";
import type {
  InboundMessagePart,
  MediaKind,
  MessageDeliveryResult,
  OutboundMessagePart,
} from "./media.js";
import type { MediaStore } from "./media-store.js";
import { chunkText } from "./text.js";

export type InboundMessage = {
  channel: "dingtalk";
  identityId: string;
  peerId: string;
  text: string;
  parts?: InboundMessagePart[];
  raw: unknown;
  fromMe?: boolean;
};

export type MessageHandler = (message: InboundMessage) => Promise<void> | void;

export type DingTalkAdapter = {
  name: "dingtalk";
  identityId: string;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(peerId: string, message: { parts: OutboundMessagePart[] }): Promise<MessageDeliveryResult>;
  sendText(peerId: string, text: string): Promise<void>;
};

const MAX_TEXT_LENGTH = 5000;

const DINGTALK_DOWNLOAD_API = "https://api.dingtalk.com/v1.0/robot/messageFiles/download";
/** 使用旧版 oapi 上传接口（新版 robot oToMessages/files/upload 易返回 404 InvalidAction.NotFound） */
const DINGTALK_UPLOAD_API = "https://oapi.dingtalk.com/media/upload";
const DINGTALK_MEDIA_DOWNLOAD_URL_PREFIX = "https://oapi.dingtalk.com/media/downloadFile";

type DingTalkDeps = {
  fetchImpl?: typeof fetch;
};

export function createDingTalkAdapter(
  identity: DingTalkIdentity,
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
  mediaStore?: MediaStore,
  deps: DingTalkDeps = {},
): DingTalkAdapter {
  const streamClientId = identity.clientId?.trim() ?? "";
  const streamClientSecret = identity.clientSecret?.trim() ?? "";
  if (!streamClientId || !streamClientSecret) {
    throw new Error("DingTalk Stream Mode requires clientId and clientSecret");
  }

  const log = logger.child({ channel: "dingtalk", identityId: identity.id });
  const fetchImpl = deps.fetchImpl ?? fetch;

  const sessionWebhooks = new Map<string, { url: string; expiresAt?: number }>();
  /** Dedupe by msgId to avoid handling the same message twice (e.g. DingTalk stream retry). */
  const seenMsgIds = new Map<string, number>();
  /** Dedupe by (peerId, text) in case DingTalk delivers the same user message twice with different msgIds. */
  const seenContentKeys = new Map<string, number>();
  /** 2 min: DingTalk may re-deliver the same event (same msgId) ~60s later; keep dedupe window long enough to skip it. */
  const DEDUPE_TTL_MS = 120_000;
  const pruneSeenMsgIds = () => {
    const now = Date.now();
    for (const [id, at] of seenMsgIds) {
      if (now - at > DEDUPE_TTL_MS) seenMsgIds.delete(id);
    }
  };
  const pruneSeenContentKeys = () => {
    const now = Date.now();
    for (const [key, at] of seenContentKeys) {
      if (now - at > DEDUPE_TTL_MS) seenContentKeys.delete(key);
    }
  };

  const sendTextInternal = async (targetWebhook: string, text: string, accessToken?: string) => {
    const body = {
      msgtype: "markdown",
      markdown: { title: "消息", text },
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken?.trim()) {
      headers["x-acs-dingtalk-access-token"] = accessToken.trim();
    }
    const res = await fetchImpl(targetWebhook, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`DingTalk sessionWebhook HTTP ${res.status}`);
    }
  };

  const resolveReplyWebhook = (peerId: string) => {
    const cached = sessionWebhooks.get(peerId);
    if (!cached) return null;
    if (typeof cached.expiresAt === "number" && cached.expiresAt > 0 && Date.now() > cached.expiresAt) {
      sessionWebhooks.delete(peerId);
      return null;
    }
    return cached.url;
  };

  /** Download file from DingTalk using downloadCode (for inbound picture/file/voice/video). robotCode is required by the API. */
  const downloadDingTalkFile = async (
    accessToken: string,
    downloadCode: string,
    peerId: string,
    kind: MediaKind,
    robotCodeFromPayloadOrIdentity: string | undefined,
    filename?: string,
    mimeType?: string,
  ): Promise<InboundMessagePart> => {
    if (!mediaStore) {
      log.warn(
        { peerId, kind, downloadCodePrefix: downloadCode.slice(0, 12) },
        "dingtalk inbound media: media store unavailable, cannot save file",
      );
      return {
        type: "media",
        media: {
          id: downloadCode,
          kind,
          source: "dingtalk",
          status: "failed",
          error: "media store unavailable",
        },
      };
    }
    if (!robotCodeFromPayloadOrIdentity?.trim()) {
      log.warn(
        { peerId, kind },
        "dingtalk inbound media: robotCode missing (set DINGTALK_ROBOT_CODE or robotCode in config); download API will fail",
      );
    }
    log.info(
      { peerId, kind, downloadCodePrefix: downloadCode.slice(0, 12), hasRobotCode: Boolean(robotCodeFromPayloadOrIdentity?.trim()), hasFilename: Boolean(filename) },
      "dingtalk inbound media: calling download API",
    );
    try {
      const body = robotCodeFromPayloadOrIdentity?.trim()
        ? { downloadCode, robotCode: robotCodeFromPayloadOrIdentity.trim() }
        : { downloadCode };
      const res = await fetchImpl(DINGTALK_DOWNLOAD_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": accessToken.trim(),
        },
        body: JSON.stringify(body),
      });
      const resText = await res.text();
      if (!res.ok) {
        log.warn(
          { peerId, kind, status: res.status, bodyPreview: resText.slice(0, 200) },
          "dingtalk inbound media: download API returned error",
        );
        throw new Error(`DingTalk download API ${res.status}: ${resText}`);
      }
      let data: { downloadUrl?: string; code?: string; message?: string };
      try {
        data = JSON.parse(resText) as typeof data;
      } catch {
        log.warn({ peerId, kind, bodyPreview: resText.slice(0, 100) }, "dingtalk inbound media: download API response not JSON");
        throw new Error(`DingTalk download API returned invalid JSON`);
      }
      const downloadUrl = typeof data?.downloadUrl === "string" ? data.downloadUrl.trim() : "";
      if (!downloadUrl) {
        const msg = data?.message ? String(data.message) : "DingTalk download API returned no downloadUrl";
        log.warn({ peerId, kind, responseKeys: data ? Object.keys(data) : [] }, "dingtalk inbound media: no downloadUrl in response");
        throw new Error(msg);
      }
      log.debug({ peerId, kind, urlPreview: downloadUrl.slice(0, 60) }, "dingtalk inbound media: got downloadUrl, fetching file");
      const stored = await mediaStore.downloadInbound({
        channel: "dingtalk",
        identityId: identity.id,
        peerId,
        kind,
        url: downloadUrl,
        ...(filename ? { filename } : {}),
        ...(mimeType ? { mimeType } : {}),
      });
      log.info(
        { peerId, kind, filePath: stored.filePath, sizeBytes: stored.sizeBytes },
        "dingtalk inbound media: file saved",
      );
      return {
        type: "media",
        media: {
          id: downloadCode,
          kind,
          source: "dingtalk",
          status: "ready",
          filePath: stored.filePath,
          filename: stored.filename,
          ...(stored.mimeType ? { mimeType: stored.mimeType } : {}),
          sizeBytes: stored.sizeBytes,
          providerFileId: downloadCode,
        },
      };
    } catch (error) {
      const classified = classifyDeliveryError(error);
      const errMsg = `${classified.code}: ${classified.message}`;
      log.warn(
        { peerId, kind, downloadCodePrefix: downloadCode.slice(0, 12), error: errMsg },
        "dingtalk inbound media: download failed",
      );
      return {
        type: "media",
        media: {
          id: downloadCode,
          kind,
          source: "dingtalk",
          status: "failed",
          providerFileId: downloadCode,
          error: errMsg,
        },
      };
    }
  };

  /** Upload local file to DingTalk and return media_id (for outbound image/file). Uses oapi.dingtalk.com/media/upload (query: access_token, type; body: form field "media"). */
  const uploadDingTalkMedia = async (
    accessToken: string,
    filePath: string,
    filename: string,
    type: "image" | "voice" | "video" | "file",
  ): Promise<string> => {
    const buf = await readFile(filePath);
    const form = new FormData();
    const blob = new Blob([buf], { type: type === "image" ? "image/jpeg" : "application/octet-stream" });
    form.append("media", blob, filename);

    const url = `${DINGTALK_UPLOAD_API}?access_token=${encodeURIComponent(accessToken.trim())}&type=${encodeURIComponent(type)}`;
    const res = await fetchImpl(url, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`DingTalk upload API ${res.status}: ${errText}`);
    }
    const data = (await res.json()) as { media_id?: string; mediaId?: string; errcode?: number; errmsg?: string };
    const mediaId = typeof data?.media_id === "string" ? data.media_id : typeof data?.mediaId === "string" ? data.mediaId : "";
    if (!mediaId) {
      if (data?.errcode && data.errcode !== 0) {
        throw new Error(data?.errmsg ? String(data.errmsg) : `DingTalk upload API errcode ${data.errcode}`);
      }
      throw new Error("DingTalk upload API returned no media_id");
    }
    return mediaId;
  };

  const sendMessageInternal = async (peerId: string, message: { parts: OutboundMessagePart[] }): Promise<MessageDeliveryResult> => {
    const partResults: MessageDeliveryResult["partResults"] = [];
    let sentParts = 0;

    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      try {
        if (part.type === "text") {
          const chunks = chunkText(part.text, MAX_TEXT_LENGTH);
          for (const chunk of chunks) {
            const replyWebhook = resolveReplyWebhook(peerId);
            if (!replyWebhook) {
              log.error(
                { peerId },
                "dingtalk reply failed: no sessionWebhook for this peer (message was received without sessionWebhook or cache expired)",
              );
            }
            if (replyWebhook) {
              const accessToken = await withDeliveryRetry("dingtalk.getAccessToken", () => client.getAccessToken(), {
                logger: log,
              });
              await withDeliveryRetry(
                "dingtalk.sendBySessionWebhook",
                () => sendTextInternal(replyWebhook, chunk, String(accessToken ?? "")),
                { logger: log },
              );
            } else {
              const error = new Error(
                "DingTalk Stream-only mode can only reply using sessionWebhook. Send a message to the bot first to establish a session.",
              ) as Error & { status?: number };
              error.status = 400;
              throw error;
            }
          }
        } else if (part.type === "image" || part.type === "audio" || part.type === "file") {
          const replyWebhook = resolveReplyWebhook(peerId);
          if (!replyWebhook) {
            const error = new Error(
              "DingTalk Stream-only mode can only reply using sessionWebhook. Send a message to the bot first to establish a session.",
            ) as Error & { status?: number };
            error.status = 400;
            throw error;
          }
          const accessToken = await withDeliveryRetry("dingtalk.getAccessToken", () => client.getAccessToken(), {
            logger: log,
          });
          const dingtalkType = part.type === "image" ? "image" : part.type === "audio" ? "voice" : "file";
          const filename = part.filename || part.filePath.split(/[/\\]/).pop() || "file";
          const mediaId = await withDeliveryRetry(
            "dingtalk.uploadMedia",
            () =>
              uploadDingTalkMedia(String(accessToken ?? ""), part.filePath, filename, dingtalkType),
            { logger: log },
          );
          const mediaUrl = `${DINGTALK_MEDIA_DOWNLOAD_URL_PREFIX}?access_token=${encodeURIComponent(String(accessToken ?? ""))}&media_id=${encodeURIComponent(mediaId)}`;
          const caption = part.caption?.trim() || "";
          const markdown =
            part.type === "image"
              ? caption ? `![](${mediaUrl})\n\n${caption}` : `![](${mediaUrl})`
              : `[${filename}](${mediaUrl})${caption ? `\n\n${caption}` : ""}`;
          await withDeliveryRetry(
            "dingtalk.sendBySessionWebhook",
            () => sendTextInternal(replyWebhook, markdown, String(accessToken ?? "")),
            { logger: log },
          );
        } else {
          throw new Error(`DingTalk adapter does not support media type: ${part.type}`);
        }

        sentParts += 1;
        partResults.push({ index, type: part.type, sent: true });
      } catch (error) {
        const classified = classifyDeliveryError(error);
        partResults.push({
          index,
          type: part.type,
          sent: false,
          error: classified.message,
          code: classified.code,
          retryable: classified.retryable,
        });
      }
    }

    return {
      attemptedParts: message.parts.length,
      sentParts,
      partResults,
    };
  };

  const client = new DWClient({
    clientId: streamClientId,
    clientSecret: streamClientSecret,
  });

  let started = false;

  type ParsedMedia = { downloadCode: string; kind: MediaKind; filename?: string; mimeType?: string };

  const parseRobotMessage = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return null;
    const record = raw as any;
    const conversationId = typeof record.conversationId === "string" ? record.conversationId.trim() : "";
    const conversationType = typeof record.conversationType === "string" ? record.conversationType.trim() : "";
    const msgtype = typeof record.msgtype === "string" ? record.msgtype.trim() : "";
    const isInAtList = record.isInAtList === true;
    const sessionWebhook = typeof record.sessionWebhook === "string" ? record.sessionWebhook.trim() : "";
    const sessionWebhookExpiredTime =
      typeof record.sessionWebhookExpiredTime === "number" ? record.sessionWebhookExpiredTime : undefined;
    const senderStaffId = typeof record.senderStaffId === "string" ? record.senderStaffId.trim() : "";
    const msgId = typeof record.msgId === "string" ? record.msgId.trim() : "";
    const robotCode = typeof record.robotCode === "string" ? record.robotCode.trim() : undefined;

    let text = "";
    let media: ParsedMedia | null = null;

    if (msgtype === "text") {
      text = typeof record.text?.content === "string" ? String(record.text.content).trim() : "";
    } else if (msgtype === "audio" || msgtype === "voice") {
      text = typeof record.content?.recognition === "string" ? String(record.content.recognition).trim() : "";
      const code = typeof record.content?.downloadCode === "string" ? record.content.downloadCode.trim() : "";
      if (code) {
        media = { downloadCode: code, kind: "audio" };
      }
    } else if (msgtype === "picture" || msgtype === "image") {
      const code =
        typeof record.content?.downloadCode === "string"
          ? record.content.downloadCode.trim()
          : typeof record.downloadCode === "string"
            ? record.downloadCode.trim()
            : "";
      if (code) {
        media = { downloadCode: code, kind: "image" };
      }
    } else if (msgtype === "file" || msgtype === "video") {
      const code =
        typeof record.content?.downloadCode === "string"
          ? record.content.downloadCode.trim()
          : typeof record.downloadCode === "string"
            ? record.downloadCode.trim()
            : "";
      if (code) {
        const kind: MediaKind = msgtype === "video" ? "file" : "file";
        const filename = typeof record.content?.fileName === "string" ? record.content.fileName.trim() : undefined;
        media = { downloadCode: code, kind, filename };
      }
    }

    if (!conversationId) return null;
    return {
      peerId: conversationId,
      conversationType,
      msgtype,
      isInAtList,
      senderStaffId,
      sessionWebhook,
      sessionWebhookExpiredTime,
      msgId,
      robotCode,
      text,
      media,
      raw: record,
    };
  };

  return {
    name: "dingtalk",
    identityId: identity.id,
    maxTextLength: MAX_TEXT_LENGTH,
    async start() {
      if (started) return;
      started = true;

      client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
        try {
          const payload = JSON.parse(res?.data ?? "{}");
          const parsed = parseRobotMessage(payload);
          if (!parsed) return;

          log.info(
            {
              msgId: parsed.msgId || "(none)",
              peerId: parsed.peerId,
              msgtype: parsed.msgtype,
              hasMedia: Boolean(parsed.media),
              mediaKind: parsed.media?.kind,
              textPreview: parsed.text.length > 60 ? `${parsed.text.slice(0, 60)}…` : parsed.text,
              textLength: parsed.text.length,
            },
            "dingtalk stream event received (every delivery from DingTalk)",
          );

          const isGroup = parsed.conversationType === "2";
          if (isGroup && !config.groupsEnabled) {
            log.debug({ peerId: parsed.peerId }, "dingtalk message ignored (groups disabled)");
            return;
          }

          // 群聊里只有被@才会推送；这里再做一次保险过滤
          if (isGroup && !parsed.isInAtList) {
            log.debug({ peerId: parsed.peerId }, "dingtalk message ignored (not @mentioned)");
            return;
          }

          if (parsed.sessionWebhook) {
            sessionWebhooks.set(parsed.peerId, {
              url: parsed.sessionWebhook,
              ...(typeof parsed.sessionWebhookExpiredTime === "number"
                ? { expiresAt: parsed.sessionWebhookExpiredTime }
                : {}),
            });
            log.debug({ peerId: parsed.peerId }, "dingtalk sessionWebhook cached for reply");
          } else {
            log.warn(
              { peerId: parsed.peerId, conversationType: parsed.conversationType },
              "dingtalk message has no sessionWebhook; replies to this conversation will fail",
            );
          }

          const isMediaMsgType = ["picture", "image", "file", "video", "audio", "voice"].includes(parsed.msgtype);
          if (isMediaMsgType && !parsed.media) {
            log.warn(
              { peerId: parsed.peerId, msgtype: parsed.msgtype, msgId: parsed.msgId },
              "dingtalk message: msgtype is media but no downloadCode found in payload (check content.downloadCode)",
            );
          }
          if (!parsed.text && !parsed.media) {
            log.debug(
              { peerId: parsed.peerId, msgtype: parsed.msgtype, msgId: parsed.msgId },
              "dingtalk message ignored: no text and no media (empty or unsupported msgtype)",
            );
            return;
          }

          if (parsed.msgId) {
            pruneSeenMsgIds();
            if (seenMsgIds.has(parsed.msgId)) {
              log.debug({ msgId: parsed.msgId }, "dingtalk message ignored (duplicate msgId)");
              return;
            }
            seenMsgIds.set(parsed.msgId, Date.now());
          }

          const contentKey = `${parsed.peerId}\0${parsed.text || parsed.media?.downloadCode || parsed.msgId || ""}`;
          pruneSeenContentKeys();
          if (seenContentKeys.has(contentKey)) {
            log.info(
              {
                msgId: parsed.msgId || "(none)",
                peerId: parsed.peerId,
              },
              "dingtalk message ignored (duplicate content in window); if msgId differs from first delivery, the duplicate was pushed by DingTalk",
            );
            return;
          }
          seenContentKeys.set(contentKey, Date.now());

          const parts: InboundMessagePart[] = [];
          if (parsed.text) {
            parts.push({ type: "text", text: parsed.text });
          }
          if (parsed.media) {
            log.info(
              { peerId: parsed.peerId, kind: parsed.media.kind, downloadCodePrefix: parsed.media.downloadCode.slice(0, 12) },
              "dingtalk inbound: downloading media",
            );
            const accessToken = await withDeliveryRetry("dingtalk.getAccessToken", () => client.getAccessToken(), {
              logger: log,
            });
            const robotCodeForDownload = parsed.robotCode?.trim() || identity.robotCode?.trim();
            const mediaPart = await downloadDingTalkFile(
              String(accessToken ?? ""),
              parsed.media.downloadCode,
              parsed.peerId,
              parsed.media.kind,
              robotCodeForDownload,
              parsed.media.filename,
              parsed.media.mimeType,
            );
            const status = mediaPart.type === "media" ? mediaPart.media.status : "unknown";
            const err = mediaPart.type === "media" ? mediaPart.media.error : undefined;
            if (status === "ready") {
              log.info(
                { peerId: parsed.peerId, kind: parsed.media.kind, filePath: (mediaPart as any).media?.filePath },
                "dingtalk inbound: media part ready",
              );
            } else {
              log.warn(
                { peerId: parsed.peerId, kind: parsed.media.kind, error: err },
                "dingtalk inbound: media part failed",
              );
            }
            parts.push(mediaPart);
          }

          const textForPrompt = parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n")
            .trim();

          await onMessage({
            channel: "dingtalk",
            identityId: identity.id,
            peerId: parsed.peerId,
            text: textForPrompt || (parsed.media ? "[1 media attachment]" : ""),
            parts: parts.length > 0 ? parts : undefined,
            raw: parsed.raw,
          });
        } catch (error) {
          log.error({ error }, "dingtalk stream inbound handler failed");
        }
      });

      client.connect();
      log.info("dingtalk adapter started (stream mode)");
    },
    async stop() {
      if (!started) return;
      started = false;
      sessionWebhooks.clear();
      seenMsgIds.clear();
      seenContentKeys.clear();
      try {
        const downstream = (client as any)?.downStream as any;
        if (downstream?.ws?.readyState === 1) {
          downstream.ws.close();
        } else if (typeof (client as any)?.disconnect === "function") {
          await (client as any).disconnect();
        }
      } catch (error) {
        log.warn({ error }, "dingtalk adapter stop failed");
      }
      log.info("dingtalk adapter stopped");
    },
    async sendMessage(_peerId: string, message: { parts: OutboundMessagePart[] }) {
      return sendMessageInternal(_peerId, message);
    },
    async sendText(peerId: string, text: string) {
      const result = await sendMessageInternal(peerId, {
        parts: [{ type: "text", text }],
      });
      if (result.sentParts === 0) {
        const firstError = result.partResults.find((part) => !part.sent)?.error;
        throw new Error(firstError || "Failed to deliver DingTalk text message");
      }
    },
  };
}

