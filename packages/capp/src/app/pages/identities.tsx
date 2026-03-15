import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import {
  ArrowRight,
  ChevronRight,
  Copy,
  Link,
  RefreshCcw,
  Shield,
} from "lucide-solid";

import Button from "../components/button";
import {
  buildOpenworkWorkspaceBaseUrl,
  OpenworkServerError,
  parseOpenworkWorkspaceIdFromUrl,
} from "../lib/openwork-server";
import type {
  OpenworkServerClient,
  OpenworkOpenCodeRouterHealthSnapshot,
  OpenworkOpenCodeRouterIdentityItem,
  OpenworkOpenCodeRouterSendResult,
  OpenworkServerStatus,
  OpenworkWorkspaceFileContent,
} from "../lib/openwork-server";

export type IdentitiesViewProps = {
  busy: boolean;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  openworkServerClient: OpenworkServerClient | null;
  openworkReconnectBusy: boolean;
  reconnectOpenworkServer: () => Promise<boolean>;
  openworkServerWorkspaceId: string | null;
  activeWorkspaceRoot: string;
  developerMode: boolean;
};

const OPENCODE_ROUTER_AGENT_FILE_PATH = ".opencode/agents/opencode-router.md";
const OPENCODE_ROUTER_AGENT_FILE_TEMPLATE = `# OpenCodeRouter Messaging Agent

Use this file to define how the assistant responds in Slack/Telegram for this workspace.

Examples:
- Keep responses concise and action-oriented.
- Use tools directly; never ask end users to run router commands.
- Never expose raw peer IDs or Telegram chat IDs unless the user explicitly asks for debug output.
- Never ask end users for peer IDs or identity IDs.
- For outbound delivery, call opencode_router_status and opencode_router_send yourself.
- If Telegram says chat not found, tell the user the recipient must message the bot first (for example /start), then retry.
`;

function formatRequestError(error: unknown): string {
  if (error instanceof OpenworkServerError) {
    return `${error.message} (${error.status})`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isOpenCodeRouterSnapshot(value: unknown): value is OpenworkOpenCodeRouterHealthSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ok === "boolean" &&
    typeof record.opencode === "object" &&
    typeof record.channels === "object" &&
    typeof record.config === "object"
  );
}

function isOpenCodeRouterIdentities(value: unknown): value is { ok: boolean; items: OpenworkOpenCodeRouterIdentityItem[] } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.ok === "boolean" && Array.isArray(record.items);
}

function getTelegramUsernameFromResult(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const bot = record.bot;
  if (!bot || typeof bot !== "object") return null;
  const username = (bot as Record<string, unknown>).username;
  if (typeof username !== "string") return null;
  const normalized = username.trim().replace(/^@+/, "");
  return normalized || null;
}

/* ---- Brand channel icons ---- */

function TelegramIcon(props: { size?: number }) {
  const s = () => props.size ?? 20;
  return (
    <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" fill="#229ED9" />
      <path d="M7 12.5l2.5 2L16 8.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M9.5 14.5l-.5 3 2-1.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function SlackIcon(props: { size?: number }) {
  const s = () => props.size ?? 20;
  return (
    <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none">
      <path d="M14.5 2a2 2 0 012 2v4.5h-2a2 2 0 010-4h0V2z" fill="#E01E5A" />
      <path d="M2 9.5a2 2 0 012-2h4.5v2a2 2 0 01-4 0V9.5z" fill="#36C5F0" />
      <path d="M9.5 22a2 2 0 01-2-2v-4.5h2a2 2 0 010 4v2.5z" fill="#2EB67D" />
      <path d="M22 14.5a2 2 0 01-2 2h-4.5v-2a2 2 0 014 0h2.5z" fill="#ECB22E" />
      <path d="M8.5 9.5h2v2h-2z" fill="#36C5F0" />
      <path d="M13.5 9.5h2v2h-2z" fill="#ECB22E" />
      <path d="M8.5 14.5h2v-2h-2z" fill="#2EB67D" />
      <path d="M13.5 14.5h2v-2h-2z" fill="#E01E5A" />
    </svg>
  );
}

function DingTalkIcon(props: { size?: number }) {
  const s = () => props.size ?? 20;
  return (
    <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" fill="#0089FF" />
      <path
        d="M8 8h3v5H8V8zm5 0h3v5h-3V8zm-5 6h8v2H8v-2z"
        fill="white"
        fill-rule="evenodd"
      />
    </svg>
  );
}

/* ---- Status pill sub-component ---- */

function StatusPill(props: { label: string; value: string; ok: boolean }) {
  return (
    <div class="flex-1 rounded-lg border border-gray-4 bg-gray-1 px-3.5 py-2.5">
      <div class="text-[11px] text-gray-9 mb-0.5">{props.label}</div>
      <div class={`text-[13px] font-semibold ${props.ok ? "text-gray-12" : "text-gray-8"}`}>{props.value}</div>
    </div>
  );
}

/* ---- Main ---- */

export default function IdentitiesView(props: IdentitiesViewProps) {
  const [refreshing, setRefreshing] = createSignal(false);

  const [health, setHealth] = createSignal<OpenworkOpenCodeRouterHealthSnapshot | null>(null);
  const [healthError, setHealthError] = createSignal<string | null>(null);

  const [telegramIdentities, setTelegramIdentities] = createSignal<OpenworkOpenCodeRouterIdentityItem[]>([]);
  const [telegramIdentitiesError, setTelegramIdentitiesError] = createSignal<string | null>(null);

  const [slackIdentities, setSlackIdentities] = createSignal<OpenworkOpenCodeRouterIdentityItem[]>([]);
  const [slackIdentitiesError, setSlackIdentitiesError] = createSignal<string | null>(null);

  const [telegramToken, setTelegramToken] = createSignal("");
  const [telegramEnabled, setTelegramEnabled] = createSignal(true);
  const [telegramSaving, setTelegramSaving] = createSignal(false);
  const [telegramStatus, setTelegramStatus] = createSignal<string | null>(null);
  const [telegramError, setTelegramError] = createSignal<string | null>(null);
  const [telegramBotUsername, setTelegramBotUsername] = createSignal<string | null>(null);
  const [telegramPairingCode, setTelegramPairingCode] = createSignal<string | null>(null);

  const [slackBotToken, setSlackBotToken] = createSignal("");
  const [slackAppToken, setSlackAppToken] = createSignal("");
  const [slackEnabled, setSlackEnabled] = createSignal(true);
  const [slackSaving, setSlackSaving] = createSignal(false);
  const [slackStatus, setSlackStatus] = createSignal<string | null>(null);
  const [slackError, setSlackError] = createSignal<string | null>(null);

  const [dingtalkIdentities, setDingTalkIdentities] = createSignal<OpenworkOpenCodeRouterIdentityItem[]>([]);
  const [dingtalkIdentitiesError, setDingTalkIdentitiesError] = createSignal<string | null>(null);
  const [dingtalkClientId, setDingTalkClientId] = createSignal("");
  const [dingtalkClientSecret, setDingTalkClientSecret] = createSignal("");
  const [dingtalkEnabled, setDingTalkEnabled] = createSignal(true);
  const [dingtalkSaving, setDingTalkSaving] = createSignal(false);
  const [dingtalkStatus, setDingTalkStatus] = createSignal<string | null>(null);
  const [dingtalkError, setDingTalkError] = createSignal<string | null>(null);
  const [dingtalkPairingCode, setDingTalkPairingCode] = createSignal<string | null>(null);

  const [expandedChannel, setExpandedChannel] = createSignal<string | null>("dingtalk");
  const [activeTab, setActiveTab] = createSignal<"general" | "advanced">("general");

  const [agentLoading, setAgentLoading] = createSignal(false);
  const [agentSaving, setAgentSaving] = createSignal(false);
  const [agentExists, setAgentExists] = createSignal(false);
  const [agentContent, setAgentContent] = createSignal("");
  const [agentDraft, setAgentDraft] = createSignal("");
  const [agentBaseUpdatedAt, setAgentBaseUpdatedAt] = createSignal<number | null>(null);
  const [agentStatus, setAgentStatus] = createSignal<string | null>(null);
  const [agentError, setAgentError] = createSignal<string | null>(null);

  const [sendChannel, setSendChannel] = createSignal<"telegram" | "slack" | "dingtalk">("dingtalk");
  const [sendDirectory, setSendDirectory] = createSignal("");
  const [sendPeerId, setSendPeerId] = createSignal("");
  const [sendAutoBind, setSendAutoBind] = createSignal(true);
  const [sendText, setSendText] = createSignal("");
  const [sendBusy, setSendBusy] = createSignal(false);
  const [sendStatus, setSendStatus] = createSignal<string | null>(null);
  const [sendError, setSendError] = createSignal<string | null>(null);
  const [sendResult, setSendResult] = createSignal<OpenworkOpenCodeRouterSendResult | null>(null);

  const [reconnectStatus, setReconnectStatus] = createSignal<string | null>(null);
  const [reconnectError, setReconnectError] = createSignal<string | null>(null);

  const workspaceId = createMemo(() => {
    const explicitId = props.openworkServerWorkspaceId?.trim() ?? "";
    if (explicitId) return explicitId;
    return parseOpenworkWorkspaceIdFromUrl(props.openworkServerUrl) ?? "";
  });

  const scopedOpenworkBaseUrl = createMemo(() => {
    const baseUrl = props.openworkServerUrl.trim();
    if (!baseUrl) return "";
    return buildOpenworkWorkspaceBaseUrl(baseUrl, workspaceId()) ?? baseUrl;
  });

  const openworkServerClient = createMemo(() => props.openworkServerClient);

  const serverReady = createMemo(() => props.openworkServerStatus === "connected" && Boolean(openworkServerClient()));
  const scopedWorkspaceReady = createMemo(() => Boolean(workspaceId()));
  const defaultRoutingDirectory = createMemo(() => props.activeWorkspaceRoot.trim() || "Not set");

  let lastResetKey = "";

  const statusLabel = createMemo(() => {
    if (healthError()) return "Unavailable";
    const snapshot = health();
    if (!snapshot) return "Unknown";
    return snapshot.ok ? "Running" : "Offline";
  });

  const isWorkerOnline = createMemo(() => {
    const snapshot = health();
    return snapshot?.ok === true;
  });

  const connectedChannelCount = createMemo(() => {
    let count = 0;
    /* if (telegramIdentities().some((i) => i.enabled && i.running)) count++; */
    /* if (slackIdentities().some((i) => i.enabled && i.running)) count++; */
    if (dingtalkIdentities().some((i) => i.enabled && i.running)) count++;
    return count;
  });

  const hasTelegramConnected = createMemo(() => telegramIdentities().some((i) => i.enabled));
  const hasSlackConnected = createMemo(() => slackIdentities().some((i) => i.enabled));
  const hasDingTalkConnected = createMemo(() => dingtalkIdentities().some((i) => i.enabled));
  const telegramBotLink = createMemo(() => {
    const username = telegramBotUsername();
    if (!username) return null;
    return `https://t.me/${username}`;
  });
  const agentDirty = createMemo(() => agentDraft() !== agentContent());

  const messagesToday = createMemo(() => {
    const activity = health()?.activity;
    if (!activity) return null;
    const inbound = typeof activity.inboundToday === "number" ? activity.inboundToday : 0;
    const outbound = typeof activity.outboundToday === "number" ? activity.outboundToday : 0;
    return inbound + outbound;
  });

  const lastActivityAt = createMemo(() => {
    const ts = health()?.activity?.lastMessageAt;
    return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
  });

  const lastActivityLabel = createMemo(() => {
    const ts = lastActivityAt();
    if (!ts) return "\u2014";
    const elapsedMs = Math.max(0, Date.now() - ts);
    if (elapsedMs < 60_000) return "Just now";
    const minutes = Math.floor(elapsedMs / 60_000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  });

  const workspaceAgentStatus = createMemo(() => {
    const agent = health()?.agent;
    if (!agent) return null;
    return {
      path: agent.path,
      loaded: agent.loaded,
      selected: agent.selected ?? "",
    };
  });

  const resetAgentState = () => {
    setAgentLoading(false);
    setAgentSaving(false);
    setAgentExists(false);
    setAgentContent("");
    setAgentDraft("");
    setAgentBaseUpdatedAt(null);
    setAgentStatus(null);
    setAgentError(null);
  };

  const loadAgentFile = async () => {
    if (agentLoading()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) {
      resetAgentState();
      setAgentError("Worker scope unavailable.");
      return;
    }
    const client = openworkServerClient();
    if (!client) return;

    setAgentLoading(true);
    setAgentError(null);
    try {
      const result = (await client.readWorkspaceFile(id, OPENCODE_ROUTER_AGENT_FILE_PATH)) as OpenworkWorkspaceFileContent;
      const nextContent = result.content ?? "";
      setAgentExists(true);
      setAgentContent(nextContent);
      setAgentDraft(nextContent);
      setAgentBaseUpdatedAt(typeof result.updatedAt === "number" ? result.updatedAt : null);
    } catch (error) {
      if (error instanceof OpenworkServerError && error.status === 404) {
        setAgentExists(false);
        setAgentContent("");
        setAgentDraft("");
        setAgentBaseUpdatedAt(null);
        return;
      }
      setAgentError(formatRequestError(error));
    } finally {
      setAgentLoading(false);
    }
  };

  const createDefaultAgentFile = async () => {
    if (agentSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;

    setAgentSaving(true);
    setAgentStatus(null);
    setAgentError(null);
    try {
      const result = await client.writeWorkspaceFile(id, {
        path: OPENCODE_ROUTER_AGENT_FILE_PATH,
        content: OPENCODE_ROUTER_AGENT_FILE_TEMPLATE,
      });
      setAgentExists(true);
      setAgentContent(OPENCODE_ROUTER_AGENT_FILE_TEMPLATE);
      setAgentDraft(OPENCODE_ROUTER_AGENT_FILE_TEMPLATE);
      setAgentBaseUpdatedAt(typeof result.updatedAt === "number" ? result.updatedAt : null);
      setAgentStatus("Created default messaging agent file.");
    } catch (error) {
      setAgentError(formatRequestError(error));
    } finally {
      setAgentSaving(false);
    }
  };

  const saveAgentFile = async () => {
    if (agentSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;

    setAgentSaving(true);
    setAgentStatus(null);
    setAgentError(null);
    try {
      const result = await client.writeWorkspaceFile(id, {
        path: OPENCODE_ROUTER_AGENT_FILE_PATH,
        content: agentDraft(),
        baseUpdatedAt: agentBaseUpdatedAt(),
      });
      setAgentExists(true);
      setAgentContent(agentDraft());
      setAgentBaseUpdatedAt(typeof result.updatedAt === "number" ? result.updatedAt : null);
      setAgentStatus("Saved messaging behavior.");
    } catch (error) {
      if (error instanceof OpenworkServerError && error.status === 409) {
        setAgentError("File changed remotely. Reload and save again.");
      } else {
        setAgentError(formatRequestError(error));
      }
    } finally {
      setAgentSaving(false);
    }
  };

  const sendTestMessage = async () => {
    if (sendBusy()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;
    const text = sendText().trim();
    if (!text) return;

    setSendBusy(true);
    setSendStatus(null);
    setSendError(null);
    setSendResult(null);
    try {
      const result = await client.sendOpenCodeRouterMessage(id, {
        channel: sendChannel(),
        text,
        ...(sendDirectory().trim() ? { directory: sendDirectory().trim() } : {}),
        ...(sendPeerId().trim() ? { peerId: sendPeerId().trim() } : {}),
        ...(sendAutoBind() ? { autoBind: true } : {}),
      });
      setSendResult(result);
      const base = `Dispatched ${result.sent}/${result.attempted} messages.`;
      setSendStatus(result.reason?.trim() ? `${base} ${result.reason.trim()}` : base);
    } catch (error) {
      setSendError(formatRequestError(error));
    } finally {
      setSendBusy(false);
    }
  };

  const refreshAll = async (options?: { force?: boolean }) => {
    if (refreshing() && !options?.force) return;
    if (!serverReady()) return;
    const client = openworkServerClient();
    if (!client) return;
    const id = workspaceId();

    setRefreshing(true);
    try {
      setHealthError(null);
      setTelegramIdentitiesError(null);
      setSlackIdentitiesError(null);

      if (!id) {
        setHealth(null);
        setTelegramIdentities([]);
        setTelegramBotUsername(null);
        setTelegramPairingCode(null);
        setSlackIdentities([]);
        setDingTalkIdentities([]);
        setHealthError("Worker scope unavailable. Reconnect using a worker URL or switch to a known worker.");
        setTelegramIdentitiesError("Worker scope unavailable.");
        setSlackIdentitiesError("Worker scope unavailable.");
        setDingTalkIdentitiesError("Worker scope unavailable.");
        resetAgentState();
        setSendStatus(null);
        setSendError(null);
        setSendResult(null);
        return;
      }

      const [healthRes, tgRes, slackRes, dingtalkRes, telegramInfo] = await Promise.all([
        client.opencodeRouterHealth(),
        client.getOpenCodeRouterTelegramIdentities(id),
        client.getOpenCodeRouterSlackIdentities(id),
        client.getOpenCodeRouterDingTalkIdentities(id),
        client.getOpenCodeRouterTelegram(id).catch(() => null),
      ]);

      setTelegramBotUsername(getTelegramUsernameFromResult(telegramInfo));

      if (isOpenCodeRouterSnapshot(healthRes.json)) {
        setHealth(healthRes.json);
      } else {
        setHealth(null);
        if (!healthRes.ok) {
          const message =
            (healthRes.json && typeof (healthRes.json as any).message === "string")
              ? String((healthRes.json as any).message)
              : `OpenCodeRouter health unavailable (${healthRes.status})`;
          setHealthError(message);
        }
      }

      if (isOpenCodeRouterIdentities(tgRes)) {
        setTelegramIdentities(tgRes.items ?? []);
        if (!tgRes.items?.length) {
          setTelegramPairingCode(null);
        }
      } else {
        setTelegramIdentities([]);
        setTelegramPairingCode(null);
        setTelegramIdentitiesError("Telegram identities unavailable.");
      }

      if (isOpenCodeRouterIdentities(slackRes)) {
        setSlackIdentities(slackRes.items ?? []);
      } else {
        setSlackIdentities([]);
        setSlackIdentitiesError("Slack identities unavailable.");
      }

      if (isOpenCodeRouterIdentities(dingtalkRes)) {
        setDingTalkIdentities(dingtalkRes.items ?? []);
        if (!dingtalkRes.items?.length) {
          setDingTalkPairingCode(null);
        }
      } else {
        setDingTalkIdentities([]);
        setDingTalkPairingCode(null);
        setDingTalkIdentitiesError("钉钉身份不可用");
      }

      if (!agentDirty() && !agentSaving()) {
        void loadAgentFile();
      }
    } catch (error) {
      const message = formatRequestError(error);
      setHealth(null);
      setTelegramIdentities([]);
      setTelegramBotUsername(null);
      setSlackIdentities([]);
      setDingTalkIdentities([]);
      setHealthError(message);
      setTelegramIdentitiesError(message);
      setSlackIdentitiesError(message);
      setDingTalkIdentitiesError(message);
    } finally {
      setRefreshing(false);
    }
  };

  const repairAndReconnect = async () => {
    if (props.openworkReconnectBusy) return;
    setReconnectStatus(null);
    setReconnectError(null);

    const ok = await props.reconnectOpenworkServer();
    if (!ok) {
      setReconnectError("Reconnect failed. Check OpenWork URL/token and try again.");
      return;
    }

    setReconnectStatus("Reconnected. Refreshing worker state...");
    await refreshAll({ force: true });
    setReconnectStatus("Reconnected.");
  };

  const upsertTelegram = async (access: "public" | "private") => {
    if (telegramSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;

    const token = telegramToken().trim();
    if (!token) return;

    setTelegramSaving(true);
    setTelegramStatus(null);
    setTelegramError(null);
    try {
      const result = await client.upsertOpenCodeRouterTelegramIdentity(id, {
        token,
        enabled: telegramEnabled(),
        access,
      });
      if (result.ok) {
        const pairingCode = typeof result.telegram?.pairingCode === "string" ? result.telegram.pairingCode.trim() : "";
        if (access === "private" && pairingCode) {
          setTelegramPairingCode(pairingCode);
          setTelegramStatus(`Private bot saved. Pair via /pair ${pairingCode}`);
        } else {
          setTelegramPairingCode(null);
        }
        const username = (result.telegram as any)?.bot?.username;
        if (username) {
          const normalized = String(username).trim().replace(/^@+/, "");
          setTelegramBotUsername(normalized || null);
          if (access !== "private" || !pairingCode) {
            setTelegramStatus(`Saved (@${normalized || String(username)})`);
          }
        } else {
          if (access !== "private" || !pairingCode) {
            setTelegramStatus(result.applied === false ? "Saved (pending apply)." : "Saved.");
          }
        }
      } else {
        setTelegramError("Failed to save.");
      }
      if (typeof result.applyError === "string" && result.applyError.trim()) {
        setTelegramError(result.applyError.trim());
      }
      setTelegramToken("");
      void refreshAll({ force: true });
    } catch (error) {
      setTelegramError(formatRequestError(error));
    } finally {
      setTelegramSaving(false);
    }
  };

  const deleteTelegram = async (identityId: string) => {
    if (telegramSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;
    if (!identityId.trim()) return;

    setTelegramSaving(true);
    setTelegramStatus(null);
    setTelegramError(null);
    try {
      const result = await client.deleteOpenCodeRouterTelegramIdentity(id, identityId);
      if (result.ok) {
        setTelegramBotUsername(null);
        setTelegramPairingCode(null);
        setTelegramStatus(result.applied === false ? "Deleted (pending apply)." : "Deleted.");
      } else {
        setTelegramError("Failed to delete.");
      }
      if (typeof result.applyError === "string" && result.applyError.trim()) {
        setTelegramError(result.applyError.trim());
      }
      void refreshAll({ force: true });
    } catch (error) {
      setTelegramError(formatRequestError(error));
    } finally {
      setTelegramSaving(false);
    }
  };

  const copyTelegramPairingCode = async () => {
    const code = telegramPairingCode();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setTelegramStatus("Pairing code copied.");
    } catch {
      setTelegramError("Could not copy pairing code. Copy it manually.");
    }
  };

  const upsertSlack = async () => {
    if (slackSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;

    const botToken = slackBotToken().trim();
    const appToken = slackAppToken().trim();
    if (!botToken || !appToken) return;

    setSlackSaving(true);
    setSlackStatus(null);
    setSlackError(null);
    try {
      const result = await client.upsertOpenCodeRouterSlackIdentity(id, { botToken, appToken, enabled: slackEnabled() });
      if (result.ok) {
        setSlackStatus(result.applied === false ? "Saved (pending apply)." : "Saved.");
      } else {
        setSlackError("Failed to save.");
      }
      if (typeof result.applyError === "string" && result.applyError.trim()) {
        setSlackError(result.applyError.trim());
      }
      setSlackBotToken("");
      setSlackAppToken("");
      void refreshAll({ force: true });
    } catch (error) {
      setSlackError(formatRequestError(error));
    } finally {
      setSlackSaving(false);
    }
  };

  const deleteSlack = async (identityId: string) => {
    if (slackSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;
    if (!identityId.trim()) return;

    setSlackSaving(true);
    setSlackStatus(null);
    setSlackError(null);
    try {
      const result = await client.deleteOpenCodeRouterSlackIdentity(id, identityId);
      if (result.ok) {
        setSlackStatus(result.applied === false ? "Deleted (pending apply)." : "Deleted.");
      } else {
        setSlackError("Failed to delete.");
      }
      if (typeof result.applyError === "string" && result.applyError.trim()) {
        setSlackError(result.applyError.trim());
      }
      void refreshAll({ force: true });
    } catch (error) {
      setSlackError(formatRequestError(error));
    } finally {
      setSlackSaving(false);
    }
  };

  const upsertDingTalk = async (access: "public" | "private") => {
    if (dingtalkSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;

    const clientId = dingtalkClientId().trim();
    const clientSecret = dingtalkClientSecret().trim();
    if (!clientId || !clientSecret) return;

    setDingTalkSaving(true);
    setDingTalkStatus(null);
    setDingTalkError(null);
    try {
      const result = await client.upsertOpenCodeRouterDingTalkIdentity(id, {
        clientId,
        clientSecret,
        enabled: dingtalkEnabled(),
        access,
      });
      if (result.ok) {
        const pairingCode = typeof result.dingtalk?.pairingCode === "string" ? result.dingtalk.pairingCode.trim() : "";
        if (access === "private" && pairingCode) {
          setDingTalkPairingCode(pairingCode);
          setDingTalkStatus(`已保存私密机器人。配对命令：/pair ${pairingCode}`);
        } else {
          setDingTalkPairingCode(null);
        }
        if (access !== "private" || !pairingCode) {
          setDingTalkStatus(result.applied === false ? "已保存（等待应用）" : "已保存");
        }
      } else {
        setDingTalkError("保存失败");
      }
      if (typeof result.applyError === "string" && result.applyError.trim()) {
        setDingTalkError(result.applyError.trim());
      }
      setDingTalkClientId("");
      setDingTalkClientSecret("");
      void refreshAll({ force: true });
    } catch (error) {
      setDingTalkError(formatRequestError(error));
    } finally {
      setDingTalkSaving(false);
    }
  };

  const deleteDingTalk = async (identityId: string) => {
    if (dingtalkSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;
    if (!identityId.trim()) return;

    setDingTalkSaving(true);
    setDingTalkStatus(null);
    setDingTalkError(null);
    try {
      const result = await client.deleteOpenCodeRouterDingTalkIdentity(id, identityId);
      if (result.ok) {
        setDingTalkPairingCode(null);
        setDingTalkStatus(result.applied === false ? "已删除（等待应用）" : "已删除");
      } else {
        setDingTalkError("删除失败");
      }
      if (typeof result.applyError === "string" && result.applyError.trim()) {
        setDingTalkError(result.applyError.trim());
      }
      void refreshAll({ force: true });
    } catch (error) {
      setDingTalkError(formatRequestError(error));
    } finally {
      setDingTalkSaving(false);
    }
  };

  const copyDingTalkPairingCode = async () => {
    const code = dingtalkPairingCode();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setDingTalkStatus("配对码已复制");
    } catch {
      setDingTalkError("无法复制配对码，请手动复制");
    }
  };

  createEffect(() => {
    const baseUrl = scopedOpenworkBaseUrl().trim();
    const id = workspaceId();
    const nextKey = `${baseUrl}|${id}`;
    if (nextKey === lastResetKey) return;
    lastResetKey = nextKey;

    setHealth(null);
    setHealthError(null);
    setTelegramIdentities([]);
    setTelegramIdentitiesError(null);
    setTelegramBotUsername(null);
    setTelegramPairingCode(null);
    setSlackIdentities([]);
    setSlackIdentitiesError(null);
    setDingTalkIdentities([]);
    setDingTalkIdentitiesError(null);
    setDingTalkPairingCode(null);
    resetAgentState();
    setSendStatus(null);
    setSendError(null);
    setSendResult(null);
    setReconnectStatus(null);
    setReconnectError(null);
    setActiveTab("general");
    setExpandedChannel("dingtalk");
  });

  onMount(() => {
    void refreshAll({ force: true });
    const interval = window.setInterval(() => void refreshAll(), 10_000);
    onCleanup(() => window.clearInterval(interval));
  });

  const toggleExpand = (channel: string) => {
    setExpandedChannel((prev) => (prev === channel ? null : channel));
  };

  return (
    <div class="space-y-6 max-w-[680px]">

      {/* ---- Header ---- */}
      <div>
        <div class="flex items-center justify-between mb-1.5">
          <h1 class="text-lg font-bold text-gray-12 tracking-tight">消息通道</h1>
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              class="h-8 px-3 text-xs"
              onClick={() => void repairAndReconnect()}
              disabled={props.busy || props.openworkReconnectBusy}
            >
              <RefreshCcw size={14} class={props.openworkReconnectBusy ? "animate-spin" : ""} />
              <span class="ml-1.5">修复并重连</span>
            </Button>
            <Button
              variant="outline"
              class="h-8 px-3 text-xs"
              onClick={() => refreshAll({ force: true })}
              disabled={!serverReady() || refreshing()}
            >
              <RefreshCcw size={14} class={refreshing() ? "animate-spin" : ""} />
              <span class="ml-1.5">刷新</span>
            </Button>
          </div>
        </div>
        <p class="text-sm text-gray-9 leading-relaxed">
          通过即时通讯连接你的 Worker。接入通道后，Worker 将自动收发消息。
        </p>
        <div class="mt-1.5 text-[11px] text-gray-8 font-mono break-all">
          工作区范围：{scopedOpenworkBaseUrl().trim() || props.openworkServerUrl.trim() || "未设置"}
        </div>
        <Show when={reconnectStatus()}>
          {(value) => <div class="mt-1 text-[11px] text-gray-9">{value()}</div>}
        </Show>
        <Show when={reconnectError()}>
          {(value) => <div class="mt-1 text-[11px] text-red-12">{value()}</div>}
        </Show>
      </div>

      {/* ---- Not connected to server ---- */}
      <Show when={!serverReady()}>
        <div class="rounded-xl border border-gray-4 bg-gray-1 p-5">
          <div class="text-sm font-semibold text-gray-12">连接 OpenWork 服务端</div>
          <div class="mt-1 text-xs text-gray-10">
            连接 OpenWork 主机（<code class="text-[11px] font-mono bg-gray-3 px-1 py-0.5 rounded">openwork</code>）后可管理身份与通道。
          </div>
        </div>
      </Show>

      <Show when={serverReady()}>
        <Show when={!scopedWorkspaceReady()}>
          <div class="rounded-xl border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">
            管理身份需要工作区 ID。请使用带工作区 URL 重连（例如 <code class="text-[11px]">/w/&lt;workspace-id&gt;</code>）或选择本机已映射的工作区。
          </div>
        </Show>

        <div class="flex items-center gap-2 rounded-xl border border-gray-4 bg-gray-1 p-1">
          <button
            class={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
              activeTab() === "general"
                ? "bg-gray-12 text-gray-1"
                : "text-gray-10 hover:bg-gray-2"
            }`}
            onClick={() => setActiveTab("general")}
          >
            概览
          </button>
          <button
            class={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
              activeTab() === "advanced"
                ? "bg-gray-12 text-gray-1"
                : "text-gray-10 hover:bg-gray-2"
            }`}
            onClick={() => setActiveTab("advanced")}
          >
            高级
          </button>
        </div>

        <Show when={activeTab() === "general"}>

        {/* ---- Worker status card ---- */}
        <div class="rounded-xl border border-gray-4 bg-gray-1 p-4 space-y-3.5">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2.5">
              <Show
                when={isWorkerOnline()}
                fallback={
                  <div class="w-2.5 h-2.5 rounded-full bg-gray-8" />
                }
              >
                <div class="w-2.5 h-2.5 rounded-full bg-emerald-9 animate-pulse" />
              </Show>
              <span class="text-[15px] font-semibold text-gray-12">
                {isWorkerOnline() ? "Worker 在线" : healthError() ? "Worker 不可用" : "Worker 离线"}
              </span>
            </div>
            <span
              class={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                isWorkerOnline()
                  ? "border-emerald-7/25 bg-emerald-1/40 text-emerald-11"
                  : healthError()
                    ? "border-red-7/20 bg-red-1/40 text-red-12"
                    : "border-amber-7/25 bg-amber-1/40 text-amber-12"
              }`}
            >
              {statusLabel()}
            </span>
          </div>

          <Show when={healthError()}>
            {(value) => (
              <div class="rounded-lg border border-red-7/20 bg-red-1/30 px-3 py-2 text-xs text-red-12">{value()}</div>
            )}
          </Show>

          <div class="flex gap-3">
            <StatusPill
              label="已连接通道"
              value={`${connectedChannelCount()} 个`}
              ok={connectedChannelCount() > 0}
            />
            <StatusPill
              label="今日消息"
              value={messagesToday() == null ? "\u2014" : String(messagesToday())}
              ok={(messagesToday() ?? 0) > 0}
            />
            <StatusPill
              label="最近活动"
              value={lastActivityLabel()}
              ok={Boolean(lastActivityAt())}
            />
          </div>
        </div>

        {/* ---- Available channels ---- */}
        <div>
          <div class="text-[11px] font-semibold text-gray-9 uppercase tracking-wider mb-3">
            可用通道
          </div>

          <div class="flex flex-col gap-2.5">

            {/* ---- DingTalk channel card ---- */}
            <div
              class={`rounded-xl border overflow-hidden transition-colors ${
                hasDingTalkConnected()
                  ? "border-emerald-7/30 bg-emerald-1/20"
                  : "border-gray-4 bg-gray-1"
              }`}
            >
              <button
                class="w-full flex items-center gap-3.5 px-4 py-3.5 text-left hover:bg-gray-2/50 transition-colors"
                onClick={() => toggleExpand("dingtalk")}
              >
                <DingTalkIcon size={28} />
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-[15px] font-semibold text-gray-12">钉钉 DingTalk</span>
                    <Show when={hasDingTalkConnected()}>
                      <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-emerald-1/40 text-emerald-11">
                        已连接
                      </span>
                    </Show>
                  </div>
                  <div class="text-[13px] text-gray-9 mt-0.5 leading-snug">
                    支持公开机器人（任何人可聊）或私密机器人（需先发送 /pair &lt;配对码&gt; 才能使用）。
                  </div>
                </div>
                <ChevronRight
                  size={16}
                  class={`text-gray-8 transition-transform flex-shrink-0 ${
                    expandedChannel() === "dingtalk" ? "rotate-90" : ""
                  }`}
                />
              </button>

              <Show when={expandedChannel() === "dingtalk"}>
                <div class="border-t border-gray-4 px-4 py-4 space-y-3 animate-[fadeUp_0.2s_ease-out]">
                  <Show when={dingtalkIdentitiesError()}>
                    {(value) => (
                      <div class="rounded-lg border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">{value()}</div>
                    )}
                  </Show>

                  <Show when={dingtalkIdentities().length > 0}>
                    <div class="space-y-2">
                      <For each={dingtalkIdentities()}>
                        {(item) => (
                          <div class="flex items-center justify-between gap-3 rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5">
                            <div class="min-w-0">
                              <div class="flex items-center gap-2">
                                <div class={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${item.running ? "bg-emerald-9" : "bg-gray-8"}`} />
                                <span class="text-[13px] font-semibold text-gray-12 truncate">
                                  <span class="font-mono text-[12px]">{item.id}</span>
                                </span>
                              </div>
                              <div class="text-[11px] text-gray-9 mt-0.5 pl-3.5">
                                {item.enabled ? "已启用" : "已禁用"} · {item.running ? "运行中" : "已停止"} · {item.access === "private" ? "私密" : "公开"}
                              </div>
                            </div>
                            <div class="flex items-center gap-2 flex-shrink-0">
                              <Button
                                variant="outline"
                                class="h-7 px-2.5 text-[11px]"
                                disabled={dingtalkSaving() || item.id === "env" || !workspaceId()}
                                onClick={() => void deleteDingTalk(item.id)}
                              >
                                断开
                              </Button>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>

                    <div class="flex gap-2.5">
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">状态</div>
                        <div class="flex items-center gap-1.5">
                          <div class={`w-1.5 h-1.5 rounded-full ${
                            dingtalkIdentities().some((i) => i.running) ? "bg-emerald-9" : "bg-gray-8"
                          }`} />
                          <span class={`text-[13px] font-semibold ${
                            dingtalkIdentities().some((i) => i.running) ? "text-emerald-11" : "text-gray-10"
                          }`}>
                            {dingtalkIdentities().some((i) => i.running) ? "运行中" : "已停止"}
                          </span>
                        </div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">身份数</div>
                        <div class="text-[13px] font-semibold text-gray-12">{dingtalkIdentities().length} 个</div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">通道</div>
                        <div class="text-[13px] font-semibold text-gray-12">
                          {health()?.channels.dingtalk ? "开" : "关"}
                        </div>
                      </div>
                    </div>

                    <Show when={dingtalkStatus()}>
                      {(value) => <div class="text-[11px] text-gray-9">{value()}</div>}
                    </Show>
                    <Show when={dingtalkError()}>
                      {(value) => <div class="text-[11px] text-red-12">{value()}</div>}
                    </Show>
                  </Show>

                  <div class="space-y-2.5">
                    <Show when={dingtalkIdentities().length === 0}>
                      <div class="rounded-xl border border-gray-4 bg-gray-2/60 px-3.5 py-3 space-y-2.5">
                        <div class="text-[12px] font-semibold text-gray-12">快速配置</div>
                        <ol class="space-y-2 text-[12px] text-gray-10 leading-relaxed">
                          <li class="flex items-start gap-2">
                            <span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">1</span>
                            <span>在钉钉开放平台创建应用，开通机器人能力（Stream 模式），获取 AppKey 与 AppSecret。</span>
                          </li>
                          <li class="flex items-start gap-2">
                            <span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">2</span>
                            <span>将 AppKey、AppSecret 填入下方。</span>
                          </li>
                          <li class="flex items-start gap-2">
                            <span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">3</span>
                            <span>选择<strong class="text-gray-12">公开</strong>（任何人可聊）或<strong class="text-gray-12">私密</strong>（需先发送 <code class="rounded bg-gray-3 px-1 py-0.5 font-mono text-[11px]">/pair &lt;配对码&gt;</code>）。</span>
                          </li>
                        </ol>
                      </div>
                    </Show>

                    <div>
                      <label class="text-[12px] text-gray-9 block mb-1">AppKey（Client ID）</label>
                      <input
                        class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                        placeholder="钉钉应用 AppKey"
                        type="text"
                        value={dingtalkClientId()}
                        onInput={(e) => setDingTalkClientId(e.currentTarget.value)}
                      />
                    </div>
                    <div>
                      <label class="text-[12px] text-gray-9 block mb-1">AppSecret（Client Secret）</label>
                      <input
                        class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                        placeholder="钉钉应用 AppSecret"
                        type="password"
                        value={dingtalkClientSecret()}
                        onInput={(e) => setDingTalkClientSecret(e.currentTarget.value)}
                      />
                    </div>

                    <label class="flex items-center gap-2 text-xs text-gray-11">
                      <input
                        type="checkbox"
                        checked={dingtalkEnabled()}
                        onChange={(e) => setDingTalkEnabled(e.currentTarget.checked)}
                      />
                      启用
                    </label>

                    <div class="rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2 text-[11px] text-gray-10 leading-relaxed">
                      公开：首次会话自动绑定。私密：需先发送 <code class="font-mono">/pair &lt;配对码&gt;</code> 才能使用。
                    </div>

                    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <button
                        onClick={() => void upsertDingTalk("public")}
                        disabled={dingtalkSaving() || !workspaceId() || !dingtalkClientId().trim() || !dingtalkClientSecret().trim()}
                        class={`flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors ${
                          dingtalkSaving() || !workspaceId() || !dingtalkClientId().trim() || !dingtalkClientSecret().trim()
                            ? "cursor-not-allowed border-gray-5 bg-gray-3 text-gray-8"
                            : "cursor-pointer border-gray-6 bg-gray-12 text-gray-1 hover:bg-gray-11"
                        }`}
                      >
                        <Show
                          when={!dingtalkSaving()}
                          fallback={
                            <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          }
                        >
                          <Link size={15} />
                        </Show>
                        {dingtalkSaving() ? "连接中…" : "创建公开机器人"}
                      </button>

                      <button
                        onClick={() => void upsertDingTalk("private")}
                        disabled={dingtalkSaving() || !workspaceId() || !dingtalkClientId().trim() || !dingtalkClientSecret().trim()}
                        class={`flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white border-none transition-opacity ${
                          dingtalkSaving() || !workspaceId() || !dingtalkClientId().trim() || !dingtalkClientSecret().trim()
                            ? "opacity-50 cursor-not-allowed"
                            : "opacity-100 cursor-pointer hover:opacity-90"
                        }`}
                        style={{ background: "#0089FF" }}
                      >
                        <Show
                          when={!dingtalkSaving()}
                          fallback={
                            <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          }
                        >
                          <Shield size={15} />
                        </Show>
                        {dingtalkSaving() ? "连接中…" : "创建私密机器人"}
                      </button>
                    </div>

                    <Show when={dingtalkPairingCode()}>
                      {(code) => (
                        <div class="rounded-xl border border-sky-7/25 bg-sky-1/40 px-3.5 py-3 space-y-2">
                          <div class="text-[12px] font-semibold text-sky-11">私密配对码</div>
                          <div class="rounded-md border border-sky-7/20 bg-sky-2/80 px-3 py-2 font-mono text-[13px] tracking-[0.08em] text-sky-12">
                            {code()}
                          </div>
                          <div class="text-[11px] text-sky-11/90 leading-relaxed">
                            在钉钉中打开要与该 Worker 绑定的会话，发送 <code class="rounded bg-sky-3/60 px-1 py-0.5 font-mono text-[10px]">/pair {code()}</code>。
                          </div>
                          <div class="flex items-center gap-2">
                            <Button variant="outline" class="h-7 px-2.5 text-[11px]" onClick={() => void copyDingTalkPairingCode()}>
                              <Copy size={12} />
                              <span class="ml-1">复制配对码</span>
                            </Button>
                            <Button variant="outline" class="h-7 px-2.5 text-[11px]" onClick={() => setDingTalkPairingCode(null)}>
                              隐藏
                            </Button>
                          </div>
                        </div>
                      )}
                    </Show>

                    <Show when={dingtalkIdentities().length === 0}>
                      <Show when={dingtalkStatus()}>
                        {(value) => <div class="text-[11px] text-gray-9">{value()}</div>}
                      </Show>
                      <Show when={dingtalkError()}>
                        {(value) => <div class="text-[11px] text-red-12">{value()}</div>}
                      </Show>
                    </Show>
                  </div>
                </div>
              </Show>
            </div>

            {/* Telegram 模块已注释：仅展示钉钉 */}
            {false && (
            <div
              class={`rounded-xl border overflow-hidden transition-colors ${
                hasTelegramConnected()
                  ? "border-emerald-7/30 bg-emerald-1/20"
                  : "border-gray-4 bg-gray-1"
              }`}
            >
              <button
                class="w-full flex items-center gap-3.5 px-4 py-3.5 text-left hover:bg-gray-2/50 transition-colors"
                onClick={() => toggleExpand("telegram")}
              >
                <TelegramIcon size={28} />
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-[15px] font-semibold text-gray-12">Telegram</span>
                    <Show when={hasTelegramConnected()}>
                      <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-emerald-1/40 text-emerald-11">
                        Connected
                      </span>
                    </Show>
                  </div>
                  <div class="text-[13px] text-gray-9 mt-0.5 leading-snug">
                    Connect a Telegram bot in public mode (open inbox) or private mode (pairing code required).
                  </div>
                </div>
                <ChevronRight
                  size={16}
                  class={`text-gray-8 transition-transform flex-shrink-0 ${
                    expandedChannel() === "telegram" ? "rotate-90" : ""
                  }`}
                />
              </button>

              {/* Expanded section */}
              <Show when={expandedChannel() === "telegram"}>
                <div class="border-t border-gray-4 px-4 py-4 space-y-3 animate-[fadeUp_0.2s_ease-out]">
                  <Show when={telegramIdentitiesError()}>
                    {(value) => (
                      <div class="rounded-lg border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">{value()}</div>
                    )}
                  </Show>

                  {/* Existing identities */}
                  <Show when={telegramIdentities().length > 0}>
                    <div class="space-y-2">
                      <For each={telegramIdentities()}>
                        {(item) => (
                          <div class="flex items-center justify-between gap-3 rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5">
                            <div class="min-w-0">
                              <div class="flex items-center gap-2">
                                <div class={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${item.running ? "bg-emerald-9" : "bg-gray-8"}`} />
                                <span class="text-[13px] font-semibold text-gray-12 truncate">
                                  <span class="font-mono text-[12px]">{item.id}</span>
                                </span>
                              </div>
                              <div class="text-[11px] text-gray-9 mt-0.5 pl-3.5">
                                {item.enabled ? "Enabled" : "Disabled"} · {item.running ? "Running" : "Stopped"} · {item.access === "private" ? "Private" : "Public"}
                              </div>
                            </div>
                            <div class="flex items-center gap-2 flex-shrink-0">
                              <Button
                                variant="outline"
                                class="h-7 px-2.5 text-[11px]"
                                disabled={telegramSaving() || item.id === "env" || !workspaceId()}
                                onClick={() => void deleteTelegram(item.id)}
                              >
                                Disconnect
                              </Button>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>

                    {/* Connected stats summary */}
                    <div class="flex gap-2.5">
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">Status</div>
                        <div class="flex items-center gap-1.5">
                          <div class={`w-1.5 h-1.5 rounded-full ${
                            telegramIdentities().some((i) => i.running) ? "bg-emerald-9" : "bg-gray-8"
                          }`} />
                          <span class={`text-[13px] font-semibold ${
                            telegramIdentities().some((i) => i.running) ? "text-emerald-11" : "text-gray-10"
                          }`}>
                            {telegramIdentities().some((i) => i.running) ? "Active" : "Stopped"}
                          </span>
                        </div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">Identities</div>
                        <div class="text-[13px] font-semibold text-gray-12">{telegramIdentities().length} configured</div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">Channel</div>
                        <div class="text-[13px] font-semibold text-gray-12">
                          {health()?.channels.telegram ? "On" : "Off"}
                        </div>
                      </div>
                    </div>

                    <Show when={telegramStatus()}>
                      {(value) => <div class="text-[11px] text-gray-9">{value()}</div>}
                    </Show>
                    <Show when={telegramError()}>
                      {(value) => <div class="text-[11px] text-red-12">{value()}</div>}
                    </Show>
                  </Show>

                  {/* Add new identity form */}
                  <div class="space-y-2.5">
                    <Show when={telegramIdentities().length === 0}>
                      <div class="rounded-xl border border-gray-4 bg-gray-2/60 px-3.5 py-3 space-y-2.5">
                        <div class="text-[12px] font-semibold text-gray-12">Quick setup</div>
                        <ol class="space-y-2 text-[12px] text-gray-10 leading-relaxed">
                          <li class="flex items-start gap-2">
                            <span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">1</span>
                            <span>
                              Open <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" class="font-medium text-gray-12 underline">@BotFather</a> and run <code class="rounded bg-gray-3 px-1 py-0.5 font-mono text-[11px]">/newbot</code>.
                            </span>
                          </li>
                          <li class="flex items-start gap-2">
                            <span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">2</span>
                            <span>Copy the bot token and paste it below.</span>
                          </li>
                          <li class="flex items-start gap-2">
                            <span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">3</span>
                            <span>Choose <span class="font-medium text-gray-12">Public</span> for open inbox or <span class="font-medium text-gray-12">Private</span> to require <code class="rounded bg-gray-3 px-1 py-0.5 font-mono text-[11px]">/pair &lt;code&gt;</code>.</span>
                          </li>
                        </ol>
                      </div>
                    </Show>

                    <div>
                      <label class="text-[12px] text-gray-9 block mb-1">Bot token</label>
                      <input
                        class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                        placeholder="Paste Telegram bot token from @BotFather"
                        type="password"
                        value={telegramToken()}
                        onInput={(e) => setTelegramToken(e.currentTarget.value)}
                      />
                    </div>

                    <label class="flex items-center gap-2 text-xs text-gray-11">
                      <input
                        type="checkbox"
                        checked={telegramEnabled()}
                        onChange={(e) => setTelegramEnabled(e.currentTarget.checked)}
                      />
                      Enabled
                    </label>

                    <div class="rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2 text-[11px] text-gray-10 leading-relaxed">
                      Public bot: first Telegram chat auto-links. Private bot: requires a pairing code before any messages run tools.
                    </div>

                    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <button
                        onClick={() => void upsertTelegram("public")}
                        disabled={telegramSaving() || !workspaceId() || !telegramToken().trim()}
                        class={`flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors ${
                          telegramSaving() || !workspaceId() || !telegramToken().trim()
                            ? "cursor-not-allowed border-gray-5 bg-gray-3 text-gray-8"
                            : "cursor-pointer border-gray-6 bg-gray-12 text-gray-1 hover:bg-gray-11"
                        }`}
                      >
                        <Show
                          when={!telegramSaving()}
                          fallback={
                            <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          }
                        >
                          <Link size={15} />
                        </Show>
                        {telegramSaving() ? "Connecting..." : "Create public bot"}
                      </button>

                      <button
                        onClick={() => void upsertTelegram("private")}
                        disabled={telegramSaving() || !workspaceId() || !telegramToken().trim()}
                        class={`flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white border-none transition-opacity ${
                          telegramSaving() || !workspaceId() || !telegramToken().trim()
                            ? "opacity-50 cursor-not-allowed"
                            : "opacity-100 cursor-pointer hover:opacity-90"
                        }`}
                        style={{ background: "#229ED9" }}
                      >
                        <Show
                          when={!telegramSaving()}
                          fallback={
                            <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          }
                        >
                          <Shield size={15} />
                        </Show>
                        {telegramSaving() ? "Connecting..." : "Create private bot"}
                      </button>
                    </div>

                    <Show when={telegramPairingCode()}>
                      {(code) => (
                        <div class="rounded-xl border border-sky-7/25 bg-sky-1/40 px-3.5 py-3 space-y-2">
                          <div class="text-[12px] font-semibold text-sky-11">Private pairing code</div>
                          <div class="rounded-md border border-sky-7/20 bg-sky-2/80 px-3 py-2 font-mono text-[13px] tracking-[0.08em] text-sky-12">
                            {code()}
                          </div>
                          <div class="text-[11px] text-sky-11/90 leading-relaxed">
                            In Telegram, open the chat that should control this worker and send <code class="rounded bg-sky-3/60 px-1 py-0.5 font-mono text-[10px]">/pair {code()}</code>.
                          </div>
                          <div class="flex items-center gap-2">
                            <Button variant="outline" class="h-7 px-2.5 text-[11px]" onClick={() => void copyTelegramPairingCode()}>
                              <Copy size={12} />
                              <span class="ml-1">Copy code</span>
                            </Button>
                            <Button variant="outline" class="h-7 px-2.5 text-[11px]" onClick={() => setTelegramPairingCode(null)}>
                              Hide
                            </Button>
                          </div>
                        </div>
                      )}
                    </Show>

                    <Show when={telegramBotLink()}>
                      {(value) => (
                        <a
                          href={value()}
                          target="_blank"
                          rel="noreferrer"
                          class="inline-flex items-center gap-2 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2 text-[12px] font-medium text-gray-11 hover:bg-gray-2"
                        >
                          <Link size={14} />
                          Open @{telegramBotUsername()} in Telegram
                        </a>
                      )}
                    </Show>

                    <Show when={telegramIdentities().length === 0}>
                      <Show when={telegramStatus()}>
                        {(value) => <div class="text-[11px] text-gray-9">{value()}</div>}
                      </Show>
                      <Show when={telegramError()}>
                        {(value) => <div class="text-[11px] text-red-12">{value()}</div>}
                      </Show>
                    </Show>
                  </div>
                </div>
              </Show>
            </div>
            )}

            {/* Slack 模块已注释：仅展示钉钉 */}
            {false && (
            <div
              class={`rounded-xl border overflow-hidden transition-colors ${
                hasSlackConnected()
                  ? "border-emerald-7/30 bg-emerald-1/20"
                  : "border-gray-4 bg-gray-1"
              }`}
            >
              <button
                class="w-full flex items-center gap-3.5 px-4 py-3.5 text-left hover:bg-gray-2/50 transition-colors"
                onClick={() => toggleExpand("slack")}
              >
                <SlackIcon size={28} />
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-[15px] font-semibold text-gray-12">Slack</span>
                    <Show when={hasSlackConnected()}>
                      <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-emerald-1/40 text-emerald-11">
                        Connected
                      </span>
                    </Show>
                  </div>
                  <div class="text-[13px] text-gray-9 mt-0.5 leading-snug">
                    Your worker appears as a bot in Slack channels. Team members can message it directly or mention it in threads.
                  </div>
                </div>
                <ChevronRight
                  size={16}
                  class={`text-gray-8 transition-transform flex-shrink-0 ${
                    expandedChannel() === "slack" ? "rotate-90" : ""
                  }`}
                />
              </button>

              {/* Expanded section */}
              <Show when={expandedChannel() === "slack"}>
                <div class="border-t border-gray-4 px-4 py-4 space-y-3 animate-[fadeUp_0.2s_ease-out]">
                  <Show when={slackIdentitiesError()}>
                    {(value) => (
                      <div class="rounded-lg border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">{value()}</div>
                    )}
                  </Show>

                  {/* Existing identities */}
                  <Show when={slackIdentities().length > 0}>
                    <div class="space-y-2">
                      <For each={slackIdentities()}>
                        {(item) => (
                          <div class="flex items-center justify-between gap-3 rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5">
                            <div class="min-w-0">
                              <div class="flex items-center gap-2">
                                <div class={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${item.running ? "bg-emerald-9" : "bg-gray-8"}`} />
                                <span class="text-[13px] font-semibold text-gray-12 truncate">
                                  <span class="font-mono text-[12px]">{item.id}</span>
                                </span>
                              </div>
                              <div class="text-[11px] text-gray-9 mt-0.5 pl-3.5">
                                {item.enabled ? "Enabled" : "Disabled"} · {item.running ? "Running" : "Stopped"}
                              </div>
                            </div>
                            <div class="flex items-center gap-2 flex-shrink-0">
                              <Button
                                variant="outline"
                                class="h-7 px-2.5 text-[11px]"
                                disabled={slackSaving() || item.id === "env" || !workspaceId()}
                                onClick={() => void deleteSlack(item.id)}
                              >
                                Disconnect
                              </Button>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>

                    {/* Connected stats summary */}
                    <div class="flex gap-2.5">
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">Status</div>
                        <div class="flex items-center gap-1.5">
                          <div class={`w-1.5 h-1.5 rounded-full ${
                            slackIdentities().some((i) => i.running) ? "bg-emerald-9" : "bg-gray-8"
                          }`} />
                          <span class={`text-[13px] font-semibold ${
                            slackIdentities().some((i) => i.running) ? "text-emerald-11" : "text-gray-10"
                          }`}>
                            {slackIdentities().some((i) => i.running) ? "Active" : "Stopped"}
                          </span>
                        </div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">Identities</div>
                        <div class="text-[13px] font-semibold text-gray-12">{slackIdentities().length} configured</div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">Channel</div>
                        <div class="text-[13px] font-semibold text-gray-12">
                          {health()?.channels.slack ? "On" : "Off"}
                        </div>
                      </div>
                    </div>

                    <Show when={slackStatus()}>
                      {(value) => <div class="text-[11px] text-gray-9">{value()}</div>}
                    </Show>
                    <Show when={slackError()}>
                      {(value) => <div class="text-[11px] text-red-12">{value()}</div>}
                    </Show>
                  </Show>

                  {/* Add new identity form */}
                  <div class="space-y-2.5">
                    <Show when={slackIdentities().length === 0}>
                      <p class="text-[13px] text-gray-10 leading-relaxed">
                        Connect your Slack workspace to let team members interact with this worker in channels and DMs.
                      </p>
                    </Show>

                    <div class="space-y-2">
                      <div>
                        <label class="text-[12px] text-gray-9 block mb-1">Bot token</label>
                        <input
                          class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                          placeholder="xoxb-..."
                          type="password"
                          value={slackBotToken()}
                          onInput={(e) => setSlackBotToken(e.currentTarget.value)}
                        />
                      </div>
                      <div>
                        <label class="text-[12px] text-gray-9 block mb-1">App token</label>
                        <input
                          class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                          placeholder="xapp-..."
                          type="password"
                          value={slackAppToken()}
                          onInput={(e) => setSlackAppToken(e.currentTarget.value)}
                        />
                      </div>
                    </div>

                    <label class="flex items-center gap-2 text-xs text-gray-11">
                      <input
                        type="checkbox"
                        checked={slackEnabled()}
                        onChange={(e) => setSlackEnabled(e.currentTarget.checked)}
                      />
                      Enabled
                    </label>

                    <button
                      onClick={() => void upsertSlack()}
                      disabled={slackSaving() || !workspaceId() || !slackBotToken().trim() || !slackAppToken().trim()}
                      class={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white border-none transition-opacity ${
                        slackSaving() || !workspaceId() || !slackBotToken().trim() || !slackAppToken().trim()
                          ? "opacity-50 cursor-not-allowed"
                          : "opacity-100 cursor-pointer hover:opacity-90"
                      }`}
                      style={{ background: "#4A154B" }}
                    >
                      <Show
                        when={!slackSaving()}
                        fallback={
                          <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        }
                      >
                        <Link size={15} />
                      </Show>
                      {slackSaving() ? "Connecting..." : "Connect Slack"}
                    </button>

                    <Show when={slackIdentities().length === 0}>
                      <Show when={slackStatus()}>
                        {(value) => <div class="text-[11px] text-gray-9">{value()}</div>}
                      </Show>
                      <Show when={slackError()}>
                        {(value) => <div class="text-[11px] text-red-12">{value()}</div>}
                      </Show>
                    </Show>
                  </div>
                </div>
              </Show>
            </div>
            )}
          </div>
        </div>

        </Show>

        <Show when={activeTab() === "advanced"}>

        {/* ---- Message routing ---- */}
        <div>
          <div class="text-[11px] font-semibold text-gray-9 uppercase tracking-wider mb-2">
            消息路由
          </div>
          <p class="text-[13px] text-gray-9 leading-relaxed mb-3">
            控制会话对应的工作区目录。未单独设置时，消息将发往 Worker 默认目录。
          </p>

          <div class="rounded-xl border border-gray-4 bg-gray-2/50 px-4 py-3.5 space-y-3">
            <div class="flex items-center gap-2">
              <Shield size={16} class="text-gray-9" />
              <span class="text-[13px] font-medium text-gray-11">默认路由</span>
            </div>
            <div class="flex items-center gap-2 pl-6">
              <span class="rounded-md bg-gray-4 px-2.5 py-1 text-[12px] font-medium text-gray-11">
                全部通道
              </span>
              <ArrowRight size={14} class="text-gray-8" />
              <span class="rounded-md bg-dls-accent/10 px-2.5 py-1 text-[12px] font-medium text-dls-accent">
                {defaultRoutingDirectory()}
              </span>
            </div>
          </div>

          <div class="text-xs text-gray-10 mt-2.5">
            高级：在钉钉中回复 <code class="text-[11px] font-mono bg-gray-3 px-1 py-0.5 rounded">/dir &lt;路径&gt;</code> 可覆盖该会话的目录（限于当前工作区根下）。
          </div>
        </div>

        {/* ---- Messaging agent behavior ---- */}
        <div class="rounded-xl border border-gray-4 bg-gray-1 p-4 space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-[13px] font-semibold text-gray-12">Messaging agent behavior</div>
              <div class="text-[12px] text-gray-9 mt-0.5">
                One file per workspace. Add optional first line <code class="font-mono">@agent &lt;id&gt;</code> to route via a specific OpenCode agent.
              </div>
            </div>
            <span class="rounded-md border border-gray-4 bg-gray-2/50 px-2 py-1 text-[11px] font-mono text-gray-10">
              {OPENCODE_ROUTER_AGENT_FILE_PATH}
            </span>
          </div>

          <Show when={workspaceAgentStatus()}>
            {(value) => (
              <div class="rounded-lg border border-gray-4 bg-gray-2/40 px-3 py-2 text-[11px] text-gray-10">
                Active scope: workspace · status: {value().loaded ? "loaded" : "missing"} · selected agent: {value().selected || "(none)"}
              </div>
            )}
          </Show>

          <Show when={agentLoading()}>
            <div class="text-[11px] text-gray-9">Loading agent file…</div>
          </Show>

          <Show when={!agentExists() && !agentLoading()}>
            <div class="rounded-lg border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">
              Agent file not found in this workspace yet.
            </div>
          </Show>

          <textarea
            class="min-h-[220px] w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-[13px] font-mono text-gray-12 placeholder:text-gray-8"
            placeholder="Add messaging behavior instructions for opencodeRouter here..."
            value={agentDraft()}
            onInput={(e) => setAgentDraft(e.currentTarget.value)}
          />

          <div class="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              class="h-8 px-3 text-xs"
              onClick={() => void loadAgentFile()}
              disabled={agentLoading() || !workspaceId()}
            >
              Reload
            </Button>
            <Show when={!agentExists()}>
              <Button
                variant="outline"
                class="h-8 px-3 text-xs"
                onClick={() => void createDefaultAgentFile()}
                disabled={agentSaving() || !workspaceId()}
              >
                Create default file
              </Button>
            </Show>
            <Button
              variant="secondary"
              class="h-8 px-3 text-xs"
              onClick={() => void saveAgentFile()}
              disabled={agentSaving() || !workspaceId() || !agentDirty()}
            >
              {agentSaving() ? "Saving..." : "Save behavior"}
            </Button>
            <Show when={agentDirty() && !agentSaving()}>
              <span class="text-[11px] text-gray-9">Unsaved changes</span>
            </Show>
          </div>

          <Show when={agentStatus()}>
            {(value) => <div class="text-[11px] text-gray-9">{value()}</div>}
          </Show>
          <Show when={agentError()}>
            {(value) => <div class="text-[11px] text-red-12">{value()}</div>}
          </Show>
        </div>

        {/* ---- Outbound send test ---- */}
        <div class="rounded-xl border border-gray-4 bg-gray-1 p-4 space-y-3">
          <div>
            <div class="text-[13px] font-semibold text-gray-12">Send test message</div>
            <div class="text-[12px] text-gray-9 mt-0.5">
              Validate outbound wiring. Use a peer ID for direct send, or leave peer ID empty to fan out by bindings in a directory.
            </div>
          </div>

          <div class="grid gap-2 sm:grid-cols-2">
            <div>
              <label class="text-[12px] text-gray-9 block mb-1">Channel</label>
              <select
                class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12"
                value={sendChannel()}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setSendChannel(v === "slack" ? "slack" : v === "dingtalk" ? "dingtalk" : "telegram");
                }}
              >
                <option value="telegram">Telegram</option>
                <option value="slack">Slack</option>
                <option value="dingtalk">钉钉 DingTalk</option>
              </select>
            </div>
            <div>
              <label class="text-[12px] text-gray-9 block mb-1">Peer ID (optional)</label>
              <input
                class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8"
                placeholder={sendChannel() === "telegram" ? "Telegram chat id (e.g. 123456789)" : "Slack peer id (e.g. D12345678|thread_ts)"}
                value={sendPeerId()}
                onInput={(e) => setSendPeerId(e.currentTarget.value)}
              />
            </div>
          </div>

          <div class="grid gap-2 sm:grid-cols-2">
            <div>
              <label class="text-[12px] text-gray-9 block mb-1">Directory (optional)</label>
              <input
                class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8"
                placeholder={defaultRoutingDirectory()}
                value={sendDirectory()}
                onInput={(e) => setSendDirectory(e.currentTarget.value)}
              />
            </div>
            <div class="flex items-end pb-1">
              <label class="flex items-center gap-2 text-xs text-gray-11">
                <input
                  type="checkbox"
                  checked={sendAutoBind()}
                  onChange={(e) => setSendAutoBind(e.currentTarget.checked)}
                />
                Auto-bind peer to directory on direct send
              </label>
            </div>
          </div>

          <div>
            <label class="text-[12px] text-gray-9 block mb-1">Message</label>
            <textarea
              class="min-h-[90px] w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8"
              placeholder="Test message content"
              value={sendText()}
              onInput={(e) => setSendText(e.currentTarget.value)}
            />
          </div>

          <div class="flex items-center gap-2">
            <Button
              variant="secondary"
              class="h-8 px-3 text-xs"
              onClick={() => void sendTestMessage()}
              disabled={sendBusy() || !workspaceId() || !sendText().trim()}
            >
              {sendBusy() ? "Sending..." : "Send test message"}
            </Button>
            <Show when={sendStatus()}>
              {(value) => <span class="text-[11px] text-gray-9">{value()}</span>}
            </Show>
          </div>

          <Show when={sendError()}>
            {(value) => <div class="text-[11px] text-red-12">{value()}</div>}
          </Show>
          <Show when={sendResult()}>
            {(value) => (
              <div class="rounded-lg border border-gray-4 bg-gray-2/40 px-3 py-2 text-[11px] text-gray-10 font-mono space-y-1">
                <div>
                  sent={value().sent} attempted={value().attempted}
                  <Show when={value().failures?.length}>
                    {(failures) => ` failures=${failures()}`}
                  </Show>
                  <Show when={value().reason?.trim()}>
                    {(reason) => ` reason=${reason()}`}
                  </Show>
                </div>
                <Show when={value().failures?.length}>
                  <For each={value().failures ?? []}>
                    {(failure) => (
                      <div class="text-red-11">
                        {failure.identityId}/{failure.peerId}: {failure.error}
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            )}
          </Show>
        </div>

        </Show>

      </Show>
    </div>
  );
}
