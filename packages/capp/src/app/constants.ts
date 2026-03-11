import type { ModelRef, SuggestedPlugin } from "./types";

export const MODEL_PREF_KEY = "openwork.defaultModel";
export const SESSION_MODEL_PREF_KEY = "openwork.sessionModels";
export const THINKING_PREF_KEY = "openwork.showThinking";
export const VARIANT_PREF_KEY = "openwork.modelVariant";
export const LANGUAGE_PREF_KEY = "openwork.language";
export const HIDE_TITLEBAR_PREF_KEY = "openwork.hideTitlebar";
export const AUTO_COMPACT_CONTEXT_PREF_KEY = "openwork.autoCompactContext";

export const DEFAULT_MODEL: ModelRef = {
  providerID: "opencode",
  modelID: "big-pickle",
};

export const SUGGESTED_PLUGINS: SuggestedPlugin[] = [
  {
    name: "opencode-scheduler",
    packageName: "opencode-scheduler",
    description: "使用 OpenCode 调度插件运行定时任务。",
    tags: ["automation", "jobs"],
    installMode: "simple",
  },
];

export type McpDirectoryInfo = {
  name: string;
  description: string;
  url?: string;
  type?: "remote" | "local";
  command?: string[];
  oauth: boolean;
};

export const MCP_QUICK_CONNECT: McpDirectoryInfo[] = [
  {
    name: "Notion",
    description: "同步页面、数据库和项目文档。",
    url: "https://mcp.notion.com/mcp",
    type: "remote",
    oauth: true,
  },
  {
    name: "Linear",
    description: "规划迭代并更快完成工单。",
    url: "https://mcp.linear.app/mcp",
    type: "remote",
    oauth: true,
  },
  {
    name: "Sentry",
    description: "跟踪发布并解决线上错误。",
    url: "https://mcp.sentry.dev/mcp",
    type: "remote",
    oauth: true,
  },
  {
    name: "Stripe",
    description: "查看支付、发票和订阅记录。",
    url: "https://mcp.stripe.com",
    type: "remote",
    oauth: true,
  },
  {
    name: "HubSpot",
    description: "管理 CRM 记录、公司和销售流程状态。",
    url: "https://mcp.hubspot.com/anthropic",
    type: "remote",
    oauth: true,
  },
  {
    name: "Context7",
    description: "以更丰富的上下文搜索产品文档。",
    url: "https://mcp.context7.com/mcp",
    type: "remote",
    oauth: false,
  },
  {
    name: "Control Chrome",
    description: "通过浏览器自动化控制 Chrome 标签页。",
    type: "local",
    command: ["chrome-devtools-mcp"],
    oauth: false,
  },
];
