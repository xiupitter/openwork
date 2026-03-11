import type { Logger } from "pino";

import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";

import type { Config, DingTalkIdentity } from "./config.js";
import { classifyDeliveryError, withDeliveryRetry } from "./delivery.js";
import type { MessageDeliveryResult, OutboundMessagePart } from "./media.js";
import { chunkText } from "./text.js";

export type InboundMessage = {
  channel: "dingtalk";
  identityId: string;
  peerId: string;
  text: string;
  parts?: never;
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

type DingTalkDeps = {
  fetchImpl?: typeof fetch;
};

export function createDingTalkAdapter(
  identity: DingTalkIdentity,
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
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

    let text = "";
    if (msgtype === "text") {
      text = typeof record.text?.content === "string" ? String(record.text.content).trim() : "";
    } else if (msgtype === "audio") {
      text = typeof record.content?.recognition === "string" ? String(record.content.recognition).trim() : "";
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
      text,
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

          if (!parsed.text) return;

          if (parsed.msgId) {
            pruneSeenMsgIds();
            if (seenMsgIds.has(parsed.msgId)) {
              log.debug({ msgId: parsed.msgId }, "dingtalk message ignored (duplicate msgId)");
              return;
            }
            seenMsgIds.set(parsed.msgId, Date.now());
          }

          const contentKey = `${parsed.peerId}\0${parsed.text}`;
          pruneSeenContentKeys();
          if (seenContentKeys.has(contentKey)) {
            log.info(
              {
                msgId: parsed.msgId || "(none)",
                peerId: parsed.peerId,
                textLength: parsed.text.length,
              },
              "dingtalk message ignored (duplicate content in window); if msgId differs from first delivery, the duplicate was pushed by DingTalk",
            );
            return;
          }
          seenContentKeys.set(contentKey, Date.now());

          await onMessage({
            channel: "dingtalk",
            identityId: identity.id,
            peerId: parsed.peerId,
            text: parsed.text,
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

