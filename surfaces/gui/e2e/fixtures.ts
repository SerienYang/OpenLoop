import { test as base, expect, type Page } from "@playwright/test";

// The app-wide /ws/events socket each page opened (UX-026 toast et al.) — specs
// push server events through it via sendAppEvent below.
const eventSockets = new WeakMap<Page, { send: (data: string) => void }>();

/** Push an app-wide event exactly as the server would over /ws/events. Waits for
 * the GUI to have connected its socket first. */
export async function sendAppEvent(page: Page, obj: unknown): Promise<void> {
  for (let i = 0; i < 50 && !eventSockets.get(page); i++) await page.waitForTimeout(100);
  const ws = eventSockets.get(page);
  if (!ws) throw new Error("the app never opened /ws/events");
  ws.send(JSON.stringify(obj));
}

// Hermetic API mock. Every /v1 request the GUI makes is fulfilled from the fixtures below (shapes
// mirrored from the real backend), and the event WebSocket is a SCRIPTED FAKE AGENT (ready on
// connect; user_message → turn_start/deltas/assistant_message/turn_done; "run a tool" triggers the
// approval flow), so specs run with no Python server and never touch real state. Mutations
// (sessions, inbox, routing, channel subscriptions) are held in per-test in-memory state
// so add/remove/toggle reflect through the real UI on re-fetch.

const HEALTH = { status: "ok", default_workspace: null, model: "anthropic:claude-opus-4-8" };

const SETTINGS = {
  provider: "openai",
  model: "anthropic:claude-opus-4-8",
  models: ["anthropic:claude-opus-4-8", "gpt-5.5", "gpt-4o", "gpt-4o-mini", "o3-mini"],
  has_key: true,
  model_ready: true,
  source: "store",
  onboarded: true,
  experimental_connectors: false,
  nav_layout: "grouped",
  session_root: "~/OpenLoop",
  secrets_path: "/Users/test/.config/openloop/secrets.json",
  sessions_peek: 5,
  // Token savings (PDF attachments): 2-page limit keeps the composer threshold test's
  // fixture PDF small; the real default is 20.
  pdf_fallback: "text",
  pdf_max_pages: 2,
  pdf_max_mb: 10,
  // Curated-matrix display names (subset — mirrors /v1/settings.model_labels).
  model_labels: {
    "anthropic:claude-opus-4-8": "Claude Opus 4.8 · Anthropic",
    "zai:glm-5.2": "GLM-5.2 · Z AI",
    "opencode-go:grok-4.5": "Grok 4.5 · OpenCode Go",
    "opencode-go:glm-5.2": "GLM-5.2 · OpenCode Go",
    "opencode-go:glm-5.1": "GLM-5.1 · OpenCode Go",
    "opencode-go:gpt-5.6-luna": "GPT-5.6 Luna · OpenCode Go",
    "opencode-go:kimi-k3": "Kimi K3 · OpenCode Go",
    "opencode-go:kimi-k2.7-code": "Kimi K2.7 Code · OpenCode Go",
    "opencode-go:kimi-k2.6": "Kimi K2.6 · OpenCode Go",
    "opencode-go:mimo-v2.5": "MiMo-V2.5 · OpenCode Go",
    "opencode-go:mimo-v2.5-pro": "MiMo-V2.5-Pro · OpenCode Go",
    "opencode-go:minimax-m3": "MiniMax M3 · OpenCode Go",
    "opencode-go:minimax-m2.7": "MiniMax M2.7 · OpenCode Go",
    "opencode-go:minimax-m2.5": "MiniMax M2.5 · OpenCode Go",
    "opencode-go:qwen3.8-max": "Qwen3.8 Max · OpenCode Go",
    "opencode-go:qwen3.7-max": "Qwen3.7 Max · OpenCode Go",
    "opencode-go:qwen3.7-plus": "Qwen3.7 Plus · OpenCode Go",
    "opencode-go:qwen3.6-plus": "Qwen3.6 Plus · OpenCode Go",
    "opencode-go:deepseek-v4-pro": "DeepSeek V4 Pro · OpenCode Go",
    "opencode-go:deepseek-v4-flash": "DeepSeek V4 Flash · OpenCode Go",
    "opencode-go:hy3": "Hy3 · OpenCode Go",
  },
  // Context windows (subset — mirrors /v1/settings.model_context_windows); drives the
  // composer usage chip's context-fill meter.
  model_context_windows: {
    "anthropic:claude-opus-4-8": 200_000,
  },
};

// The boot-resume target (most recent updated_at) — existing specs open it by title.
const PINNED_SESSION = {
  session_id: "pinned-openloop-1",
  title: "Draft the launch note",
  workspace: "/Users/test/OpenLoop/launch-note",
  agent: "openloop",
  model: "anthropic:claude-opus-4-8",
  mode: "interactive",
  updated_at: "2026-07-01 09:00:00",
  messages: 2,
  pinned: true,
  archived: false,
  attention: 0,
  liveness: "idle",
  subscriptions: [],
};

// Seven unpinned OpenLoop sessions exercise the sidebar peek cap.
// wp-3 carries the pending Inbox approval below (attention badge parity). All OLDER than the
// pinned session so boot-resume stays deterministic.
const EXTRA_SESSIONS = Array.from({ length: 7 }, (_, i) => ({
  session_id: `wp-${i + 1}`,
  title: `Weekly plan ${i + 1}`,
  workspace: "",
  agent: "openloop",
  model: "anthropic:claude-opus-4-8",
  mode: "interactive",
  updated_at: `2026-06-2${8 - Math.min(i, 7)} 10:00:00`,
  messages: 3,
  pinned: false,
  archived: false,
  attention: i + 1 === 3 ? 1 : 0,
  liveness: "idle",
  subscriptions: [],
}));

// One older operational session keeps boot-resume deterministic.
const OPS_SESSION = {
  session_id: "ops-1",
  title: "Ops triage",
  workspace: "/Users/test/OpenLoop/ops-triage",
  agent: "openloop",
  model: "anthropic:claude-opus-4-8",
  mode: "interactive",
  updated_at: "2026-06-15 10:00:00",
  messages: 4,
  pinned: false,
  archived: false,
  attention: 0,
  liveness: "idle",
  subscriptions: [],
};

// §31: a mention-spawned session — lives in the sidebar's collapsed "From Slack" group, never
// in Recent. Older than everything else so boot-resume stays deterministic.
const SLACK_SESSION = {
  session_id: "slack-thread-1",
  title: "#general — check the deploy?",
  workspace: "",
  agent: "openloop",
  model: "anthropic:claude-opus-4-8",
  mode: "interactive",
  updated_at: "2026-06-10 10:00:00",
  messages: 2,
  pinned: false,
  archived: false,
  attention: 0,
  liveness: "idle",
  subscriptions: [],
  origin: "slack",
  origin_label: "#general",
};

const CONNECTORS = {
  connectors: [
    { name: "browser", title: "Browser", icon: "B", blurb: "Headless browser.", auth: "none", two_way: false, channels: false, available: true, brand_color: "#6b7280", logo: "", fields: [], instructions: [], connected: true, account: null, enabled: true, allowed_users: [], tools: [] },
    { name: "telegram", title: "Telegram", icon: "T", blurb: "Two-way Telegram messaging.", auth: "bot_token", two_way: true, channels: true, available: true, brand_color: "#229ed9", logo: "telegram", fields: [{ key: "bot_token", label: "Bot token", secret: true, required: true, help: "", placeholder: "123456:ABC…" }], instructions: [], connected: false, account: null, enabled: false, allowed_users: [], tools: [] },
    // Manual OAuth token connector with pre-connect detail copy.
    { name: "gmail", title: "Gmail", icon: "✉", blurb: "Search, summarize, draft, and send email.", about: "Search, summarize, and send over your Gmail.", access: ["Reads and searches your mail.", "Sends email as you.", "Never deletes mail or changes account settings."], auth: "oauth", two_way: false, channels: false, available: true, brand_color: "#ea4335", logo: "gmail", fields: [{ key: "access_token", label: "OAuth access token", secret: true, required: true, help: "", placeholder: "" }], instructions: [], connected: false, account: null, enabled: false, allowed_users: [], tools: [{ name: "gmail_search", label: "Search mail", kind: "read", description: "Search messages.", enabled: true, requires_approval: false }, { name: "gmail_send", label: "Send email", kind: "write", description: "Send a message.", enabled: true, requires_approval: true }] },
    { name: "google_calendar", title: "Google Calendar", icon: "◷", blurb: "Read availability, summarize schedules, and create events.", auth: "oauth", two_way: false, channels: false, available: true, brand_color: "#4285f4", logo: "google_calendar", fields: [{ key: "access_token", label: "OAuth access token", secret: true, required: true, help: "", placeholder: "" }], instructions: [], connected: false, account: null, enabled: false, allowed_users: [], tools: [] },
    // HubSpot private-app token.
    { name: "hubspot", title: "HubSpot", icon: "⊚", blurb: "Search CRM records; log notes and tasks, update records. No deletes.", auth: "token", two_way: false, channels: false, available: true, brand_color: "#ff7a59", logo: "hubspot", fields: [{ key: "token", label: "Private app token", secret: true, required: true, help: "", placeholder: "pat-…" }], instructions: [], connected: false, account: null, enabled: false, allowed_users: [], tools: [] },
    // Generic multi-account connector (accounts.py layer).
    { name: "notion", title: "Notion", icon: "◰", blurb: "Search pages, read content, query databases, create pages.", auth: "oauth", two_way: false, channels: false, available: true, brand_color: "#1f2328", logo: "", fields: [{ key: "access_token", label: "Integration secret", secret: true, required: true, help: "", placeholder: "ntn_…" }], instructions: [], connected: false, account: null, enabled: false, allowed_users: [], tools: [] },
    // Email-keyed multi-account connector (Outlook).
    { name: "outlook", title: "Outlook", icon: "◎", blurb: "Microsoft 365 mail and calendar: search, draft, and send email; manage events and respond to invites.", aliases: ["calendar", "email", "mail", "microsoft", "office"], auth: "oauth", two_way: false, channels: false, available: true, brand_color: "#0078d4", logo: "outlook", fields: [{ key: "access_token", label: "OAuth access token", secret: true, required: true, help: "", placeholder: "" }], instructions: [], connected: false, account: null, enabled: false, allowed_users: [], tools: [] },
    // Sixth active card in the onboarding gallery (promoted 2026-07-19 to even the grid).
    { name: "attio", title: "Attio", icon: "▣", blurb: "Search and read Attio CRM records; log notes.", auth: "oauth", two_way: false, channels: false, available: true, brand_color: "#2d6ae0", logo: "attio", fields: [{ key: "access_token", label: "OAuth access token", secret: true, required: true, help: "", placeholder: "" }], instructions: [], connected: false, account: null, enabled: false, allowed_users: [], tools: [] },
    // MCP-BACKED connectors (§42): vendor-hosted MCP + local OAuth, pinned tool subset.
    // monday uses local OAuth only; jira also has a manual token path.
    { name: "monday", title: "monday.com", icon: "▦", blurb: "Read boards and items, track work, create items and post updates.", aliases: ["project management", "tasks", "boards"], auth: "oauth", two_way: false, channels: false, available: true, brand_color: "#6161ff", logo: "monday", mcp: true, fields: [], instructions: ["One click connects via monday.com sign-in in your browser.", "Sign-in is fully local — tokens stay on this computer."], connected: false, account: null, enabled: false, allowed_users: [], tools: [{ name: "mcp__monday__get_board_info", label: "Read board", kind: "read", description: "Read a board's columns and groups.", enabled: true, requires_approval: false }, { name: "mcp__monday__create_item", label: "Create item", kind: "write", description: "Create an item on a board.", enabled: true, requires_approval: true }] },
    { name: "jira", title: "Jira", icon: "◆", blurb: "Search, summarize, create, and update issues.", aliases: ["issues", "tickets", "atlassian"], auth: "api_token", two_way: false, channels: false, available: true, brand_color: "#0052cc", logo: "jira", mcp: true, fields: [{ key: "base_url", label: "Atlassian site URL", secret: false, required: true, help: "", placeholder: "" }, { key: "email", label: "Account email", secret: false, required: true, help: "", placeholder: "" }, { key: "api_token", label: "API token", secret: true, required: true, help: "", placeholder: "" }], instructions: [], connected: false, account: null, enabled: false, allowed_users: [], tools: [] },
  ],
};

// Two pending items drive the kind tabs and resolve-removes-card behavior.
const INBOX_ITEMS = [
  {
    id: "inb-approval-1",
    session_id: "wp-3",
    kind: "approval",
    title: "Approve: run_shell",
    body: "rm -rf build/",
    state: "pending",
    resolution: null,
    inbox: "default",
    created_at: "2026-07-01 08:00:00",
    resolved_at: null,
    session_title: "Weekly plan 3",
    session_agent: "openloop",
    session_workspace: "",
    session_exists: true,
  },
  {
    id: "inb-question-1",
    session_id: "ops-1",
    kind: "question",
    title: "Which environment should I restart?",
    body: "",
    options: ["staging", "production"],
    allow_text: true,
    multi: false,
    state: "pending",
    resolution: null,
    inbox: "default",
    created_at: "2026-07-01 08:05:00",
    resolved_at: null,
    session_title: "Investigate alerts",
    session_agent: "openloop",
    session_workspace: "",
    session_exists: true,
  },
];

// One scheduled automation with a running run: its session id uses the real `__run__` convention
// so the session view's run banner (detection is id-based) can be exercised end-to-end.
const AUTOMATION = {
  id: "task-1",
  title: "Daily AI News",
  instructions: "Fetch the latest AI news and produce an HTML+Tailwind presentation.",
  schedule: "Every day at ~5:40 PM",
  schedule_raw: { kind: "cron", cron: "40 17 * * *", fire_at: null, timezone: "local" },
  workspace: "",
  agent: "openloop",
  enabled: true,
  next_run: Math.floor(Date.now() / 1000) + 3600,
  last_run: Math.floor(Date.now() / 1000) - 60,
  last_status: "running",
  run_count: 1,
  notify_on_completion: false,
  // One standing scoped approval (§25) so the detail page's revoke list has content.
  always_allowed: [
    { entry: "send_message slack:C1", tool: "send_message", target: "slack:C1" },
  ],
  // UX-023 sidebar badges: two unopened runs, the newest of them failed.
  unseen_runs: 2,
  unseen_failed: true,
  seen_runs_at: 0,
};
// A second, quiet automation so the Scheduled band shows badge-less rows too.
const AUTOMATION_CLEAN = {
  ...AUTOMATION,
  id: "task-2",
  title: "Weekly CRM digest",
  schedule: "Every Monday at ~9:00 AM",
  last_status: "ok",
  unseen_runs: 0,
  unseen_failed: false,
  always_allowed: [],
};
const AUTOMATION_RUNS = [
  {
    run_id: "r1",
    task_id: "task-1",
    session_id: "__run__r1",
    started_at: Math.floor(Date.now() / 1000) - 60,
    finished_at: null,
    status: "running",
    result_text: null,
    artifacts: [],
    error: null,
    trigger: "schedule",
  },
];

const PRIMARY_ROOT = { path: "/Users/test/OpenLoop/launch-note", writable: true, label: "scratch", primary: true, exists: true };
const baseName = (p: string) => p.split("/").filter(Boolean).pop() || p;

const PROVIDERS = [
  // openai: configured + used (drives the "Last used" sub-line and the status dot).
  { name: "openai", title: "OpenAI", needs_key: true, fields: [{ key: "api_key", label: "OpenAI API key", secret: true, required: true, help: "", placeholder: "sk-…" }], configured: true, values: {}, suggested_models: ["gpt-5.5"], key_set_at: "2026-06-12", last_used_at: Math.floor(Date.now() / 1000) - 7200 },
  // anthropic: configured but never used ("Not used yet").
  { name: "anthropic", title: "Claude (Anthropic)", needs_key: true, fields: [{ key: "api_key", label: "API key", secret: true, required: true, help: "", placeholder: "sk-…" }], configured: true, values: {}, suggested_models: ["claude-opus-4-8"], key_set_at: null, last_used_at: null },
  // zai: an OpenAI-compatible vendor — unconfigured, with a prefilled editable endpoint + blurb.
  { name: "zai", title: "Z AI (GLM)", needs_key: true, blurb: "Uses Z AI's OpenAI-compatible API — the endpoint is prefilled, just add your key.", fields: [{ key: "api_key", label: "Z AI API key", secret: true, required: true, help: "", placeholder: "" }, { key: "base_url", label: "Endpoint", secret: false, required: false, help: "Prefilled with Z AI's international endpoint.", placeholder: "https://api.z.ai/api/paas/v4", default: "https://api.z.ai/api/paas/v4" }], configured: false, values: {}, suggested_models: ["glm-5.2"], key_set_at: null, last_used_at: null },
  // ollama: keyless local provider — "configured" without proving anything runs; the
  // onboarding gallery shows "No key needed" and its form is endpoint + Detect (§39).
  { name: "ollama", title: "Ollama (local models)", needs_key: false, fields: [{ key: "base_url", label: "Endpoint", secret: false, required: false, help: "", placeholder: "http://127.0.0.1:11434", default: "http://127.0.0.1:11434" }], configured: true, values: {}, suggested_models: ["qwen3-coder:30b"], key_set_at: null, last_used_at: null },
  {
    name: "opencode-go",
    title: "OpenCode Go",
    needs_key: true,
    fields: [{ key: "api_key", label: "OpenCode Go API key", secret: true, required: true, help: "Get a workspace API key at https://opencode.ai/auth", placeholder: "" }],
    configured: false,
    values: {},
    suggested_models: [
      "grok-4.5",
      "glm-5.2",
      "glm-5.1",
      "gpt-5.6-luna",
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "minimax-m3",
      "minimax-m2.7",
      "minimax-m2.5",
      "qwen3.8-max",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-plus",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "hy3",
    ],
    recommended_model: "deepseek-v4-flash",
    key_set_at: null,
    last_used_at: null,
  },
  { name: "gemini", title: "Gemini (Google)", needs_key: true, fields: [{ key: "api_key", label: "Gemini API key", secret: true, required: true, help: "", placeholder: "" }], configured: false, values: {}, suggested_models: ["gemini-2.5-pro"], key_set_at: null, last_used_at: null },
  { name: "xai", title: "xAI (Grok)", needs_key: true, fields: [{ key: "api_key", label: "xAI API key", secret: true, required: true, help: "", placeholder: "" }], configured: false, values: {}, suggested_models: ["grok-4"], key_set_at: null, last_used_at: null },
  { name: "deepseek", title: "DeepSeek", needs_key: true, fields: [{ key: "api_key", label: "DeepSeek API key", secret: true, required: true, help: "", placeholder: "" }], configured: false, values: {}, suggested_models: ["deepseek-chat"], key_set_at: null, last_used_at: null },
];

/** Install the API + WebSocket mocks on a page. Returns handles for assertions/seed data. */
export async function mockApi(page: import("@playwright/test").Page) {
  const subscriptions: any[] = [
    { session_id: "wp-1", session_title: "Weekly plan 1", agent: "openloop", channel: "slack:C0AAA111", channel_name: "openloop-test", routing_target: null, collision: false },
  ];
  // Parked unauthorized messages (§19) — mutable so Allow/Dismiss round-trip through the UI.
  const parked: any[] = [
    { id: "pk1", platform: "slack", chat_id: "C0AAA111", chat_name: "#openloop-test", user_id: "U0NEW", user_name: "Maya", chat_type: "channel", text: "can you summarize this thread?", ts: Date.now() / 1000 - 120, team_id: null },
  ];
  // Slack connector — one manually configured Socket Mode workspace.
  const slackState = {
    connected: true,
    account: "deeplearning.ai",
    allowed_users: ["U_ME"] as string[],
    approval_owner_ids: ["U_ME"] as string[],
  };
  const slackConnector = () => ({
    name: "slack", title: "Slack", icon: "#", blurb: "Two-way Slack messaging.",
    auth: "socket_app", two_way: true, channels: true, available: true, brand_color: "#611f69", logo: "slack",
    fields: [
      { key: "bot_token", label: "Bot token", secret: true, required: true, help: "", placeholder: "xoxb-…" },
      { key: "app_token", label: "App token", secret: true, required: true, help: "", placeholder: "xapp-…" },
    ],
    instructions: [], connected: slackState.connected,
    account: slackState.account, enabled: slackState.connected,
    allowed_users: [...slackState.allowed_users],
    approval_owner_ids: [...slackState.approval_owner_ids],
    approval_owner_names: { U_ME: "Rohit Prasad" },
    tools: [], mode: "",
    unauthorized: parked.map((x) => ({ ...x })),
  });
  const githubConnector = () => ({
    name: "github", title: "GitHub", icon: "⌘", blurb: "Work with issues, pull requests, repository files, and CI status.",
    auth: "token", two_way: false, channels: false, available: true, brand_color: "#1f2328", logo: "github",
    fields: [{ key: "token", label: "Personal access token", secret: true, required: true, help: "", placeholder: "" }],
    instructions: [], connected: true,
    account: "personal access token",
    enabled: true, allowed_users: [], tools: [], mode: "",
  });
  // Gmail — per-test local account state.
  const gmailState = {
    accounts: [] as {
      email: string; default: boolean; scopes: string; needs_reauth: boolean;
    }[],
    filters: { senders: [] as string[], labels: [] as string[] },
  };
  const gmailConnector = () => {
    const base = CONNECTORS.connectors.find((c: any) => c.name === "gmail");
    return {
      ...base,
      connected: gmailState.accounts.length > 0,
      enabled: gmailState.accounts.length > 0,
      account: gmailState.accounts.find((a) => a.default)?.email ?? null,
      accounts: gmailState.accounts.map((a) => ({ ...a })),
      filters: { senders: [...gmailState.filters.senders], labels: [...gmailState.filters.labels] },
    };
  };
  // Google Calendar — PER-TEST multi-account state (gmail's shape, no filters).
  const gcalState = {
    accounts: [] as {
      email: string; default: boolean; scopes: string; needs_reauth: boolean;
    }[],
  };
  const gcalConnector = () => {
    const base = CONNECTORS.connectors.find((c: any) => c.name === "google_calendar");
    return {
      ...base,
      connected: gcalState.accounts.length > 0,
      enabled: gcalState.accounts.length > 0,
      account: gcalState.accounts.find((a) => a.default)?.email ?? null,
      accounts: gcalState.accounts.map((a) => ({ ...a })),
    };
  };
  // Notion — PER-TEST generic multi-account state (accounts.py layer: AccountRow shape).
  const notionState = {
    accounts: [] as { account_id: string; name: string; default: boolean }[],
  };
  const notionConnector = () => {
    const base = CONNECTORS.connectors.find((c: any) => c.name === "notion");
    return {
      ...base,
      connected: notionState.accounts.length > 0,
      enabled: notionState.accounts.length > 0,
      account: notionState.accounts.find((a) => a.default)?.name ?? null,
      accounts: notionState.accounts.map((a) => ({ ...a })),
    };
  };
  // Outlook — email-keyed local accounts.
  const outlookState = {
    accounts: [] as { account_id: string; name: string; default: boolean }[],
  };
  // MCP-backed connectors (§42) — per-test connect state; the mock "browser flow"
  // completes instantly so the modal's poll picks it up.
  const mcpState = { monday: false, jira: false };
  const mcpConnector = (name: "monday" | "jira") => {
    const base = CONNECTORS.connectors.find((c: any) => c.name === name);
    return {
      ...base,
      connected: mcpState[name],
      enabled: mcpState[name],
      mode: mcpState[name] ? "mcp" : "",
    };
  };
  const outlookConnector = () => {
    const base = CONNECTORS.connectors.find((c: any) => c.name === "outlook");
    return {
      ...base,
      connected: outlookState.accounts.length > 0,
      enabled: outlookState.accounts.length > 0,
      account: outlookState.accounts.find((a) => a.default)?.name ?? null,
      accounts: outlookState.accounts.map((a) => ({ ...a })),
    };
  };
  // HubSpot — per-test local private-app portal state.
  const hubspotState = {
    portals: [] as {
      hub_id: string; name: string; sandbox: boolean; default: boolean;
      access: string;
    }[],
    hidden_fields: [] as string[],
  };
  const hubspotConnector = () => {
    const base = CONNECTORS.connectors.find((c: any) => c.name === "hubspot");
    return {
      ...base,
      connected: hubspotState.portals.length > 0,
      enabled: hubspotState.portals.length > 0,
      account: hubspotState.portals.find((p) => p.default)?.name ?? null,
      portals: hubspotState.portals.map((p) => ({ ...p })),
      hidden_fields: [...hubspotState.hidden_fields],
    };
  };
  // Sessions — mutable so archive (PATCH), rename (PATCH), and delete round-trip.
  const sessions: any[] = [
    { ...PINNED_SESSION },
    ...EXTRA_SESSIONS.map((s) => ({ ...s })),
    {
      session_id: "content-session-1",
      title: "OpenLoop 目录与项目管理",
      workspace: "/Users/test/content",
      agent: "openloop",
      model: "anthropic:claude-opus-4-8",
      mode: "interactive",
      updated_at: "2026-06-09 10:00:00",
      messages: 2,
      pinned: false,
      archived: false,
      attention: 0,
      liveness: "idle",
      subscriptions: [],
      project_id: "p-content",
    },
    {
      session_id: "weekly-2",
      title: "Weekly plan 2",
      workspace: "/Users/test/content",
      agent: "openloop",
      model: "anthropic:claude-opus-4-8",
      mode: "interactive",
      updated_at: "2026-06-08 10:00:00",
      messages: 3,
      pinned: false,
      archived: true,
      attention: 0,
      liveness: "idle",
      subscriptions: [],
      project_id: "p-content",
    },
    {
      session_id: "regular-archived",
      title: "普通归档",
      workspace: "",
      agent: "openloop",
      model: "anthropic:claude-opus-4-8",
      mode: "interactive",
      updated_at: "2026-06-07 10:00:00",
      messages: 1,
      pinned: false,
      archived: true,
      attention: 0,
      liveness: "idle",
      subscriptions: [],
    },
    { ...OPS_SESSION },
    { ...SLACK_SESSION },
  ];
  const projects: any[] = [
    {
      project_id: "p-content",
      name: "内容策略平台",
      path: "/Users/test/content",
      description: "",
      pinned: false,
      hidden: true,
      path_exists: true,
      n_sessions: 2,
      unarchived_sessions: 1,
      archived_sessions: 1,
      last_used: "2026-06-09 10:00:00",
    },
    {
      project_id: "p-missing",
      name: "旧素材实验",
      path: "/Users/test/missing",
      description: "",
      pinned: false,
      hidden: true,
      path_exists: false,
      n_sessions: 1,
      unarchived_sessions: 1,
      archived_sessions: 0,
      last_used: "2026-05-01 10:00:00",
    },
  ];
  // Inbox items + the outbound routing binding — mutable for resolve + the inline Slack config.
  const inbox: any[] = INBOX_ITEMS.map((i) => ({ ...i }));
  const routing: { name: string; channel: string | null; target: string } = {
    name: "default",
    channel: null,
    target: "",
  };
  // Session roots — the primary (writable, non-removable) scratch plus any added folders. Mutable so
  // the RO/RW add/toggle round-trips through the real UI. POST upserts by path (a toggle re-adds).
  const roots: any[] = [{ ...PRIMARY_ROOT }];
  // Providers — mutable so save (POST) flips `configured` and stamps key_set_at, matching the
  // backend's set_provider. verify (POST) never mutates: it's a live read-only credential check.
  const providers: any[] = PROVIDERS.map((p) => ({ ...p }));
  let providerOrder = providers.map((p) => p.name);
  let providerOrderRevision = 1;
  const appliedProviderOrderRequests = new Set<string>();
  // Automations — mutable so Run now appends a run, enable/disable toggles, and delete removes.
  const automations: any[] = [{ ...AUTOMATION }, { ...AUTOMATION_CLEAN }];
  const settings: any = {
    ...SETTINGS,
    surfaces: { ...SETTINGS.surfaces },
    model_labels: { ...SETTINGS.model_labels },
  };
  // MCP servers (empty by default; the granola OAuth quick-add test populates it).
  const mcpServers: any[] = [];
  const automationRuns: any[] = AUTOMATION_RUNS.map((r) => ({ ...r }));
  // Per-session unattended flag — mutable so the composer's "Send to Inbox" toggle persists and
  // the app reads it back (which is what gates parking approvals to the Inbox vs an inline card).
  const unattended: Record<string, boolean> = {};
  // Skills (SKILLS-SPEC) — mutable folder-is-truth mirror: Settings CRUD, the enabled flag,
  // staged uploads (stage → preview → confirm), and the composer's per-session menu all
  // round-trip through this one list.
  const skills: any[] = [
    { name: "weekly-report", description: "Monday status report", instructions: "1. Collect updates\n2. Write it up", scope: "global", source: "local", enabled: true, path: "/state/skills/weekly-report", files: 0 },
    { name: "html-to-markdown", description: "Convert an HTML document or fragment to clean markdown.", instructions: "Convert the given HTML to markdown, preserving structure.", scope: "global", source: "uploaded", enabled: true, path: "/state/skills/html-to-markdown", files: 2 },
  ];
  let stagedSkill: any = null;

  // The scripted fake agent behind the session WebSocket. Speaks the real event protocol
  // ({type, data}), so the full send → stream → render loop and the approval round-trip run
  // through the production code paths:
  //   · on connect: `ready`
  //   · user_message: turn_start (with input, exercising the foreground dedupe) → two
  //     assistant_deltas → assistant_message "Echo: <text>" → turn_done
  //   · a message containing "run a tool": tool_proposed + permission_required, then the turn
  //     SUSPENDS until the client's approval decision arrives (deny → skipped; else → ran)
  // App-wide event stream: register the socket so sendAppEvent can push into it.
  await page.routeWebSocket(/\/ws\/events$/, (ws) => {
    eventSockets.set(page, ws);
  });

  await page.routeWebSocket(/\/ws\/session\//, (ws) => {
    const send = (type: string, data: Record<string, unknown> = {}) =>
      ws.send(JSON.stringify({ type, data }));
    send("ready");
    let pendingTool = "run_shell"; // which proposal the next approval decision resolves
    let epicTimer: ReturnType<typeof setInterval> | null = null; // the slow stream, stoppable via interrupt
    let hadTurn = false; // a user_message landed — set_model is now a mid-session switch
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === "user_message") {
        hadTurn = true;
        // Force-run (SKILLS-SPEC §6): like the real server, TURN_START ships the user's
        // literal "/name …" line as `display` so the client dedupes on what the user sees.
        send("turn_start", {
          input: msg.text,
          ...(msg.skill ? { display: `/${msg.skill}${msg.text ? ` ${msg.text}` : ""}` } : {}),
        });
        if (/run a tool/i.test(msg.text)) {
          pendingTool = "run_shell";
          send("tool_proposed", { name: "run_shell", arguments: { command: "ls" } });
          send("permission_required", {
            name: "run_shell",
            arguments: { command: "ls" },
            reason: "OpenLoop wants to run a command.",
          });
          send("pending_registered", { id: "pending-run-shell", kind: "approval" });
          return; // suspended on the approval
        }
        // §35 compact row: a routine workspace write (content rides in the args).
        if (/write a file/i.test(msg.text)) {
          pendingTool = "write_file";
          const args = {
            path: "src/fetch_data.py",
            content: "import json\nimport urllib.request\n\ncompanies = [\"NVDA\", \"AMD\"]\nprint(len(companies))\ndone = True",
          };
          send("tool_proposed", { name: "write_file", arguments: args });
          send("permission_required", { name: "write_file", arguments: args, reason: "" });
          send("pending_registered", { id: "pending-write-file", kind: "approval" });
          return; // suspended on the approval
        }
        // A one-paragraph digest with NO newlines — the owner-repro shape that once
        // ballooned the card to full-transcript height (char clamp, 2026-07-15).
        if (/post the long digest/i.test(msg.text)) {
          pendingTool = "send_message";
          const args = {
            target: "slack:C1",
            text:
              "aisuite — last 24 hours of work (through Jul 15): 5 PRs merged covering chat-completion streaming with unified chunks across providers, multimodal input conversion, Slack collaboration improvements, human attribution for outbound posts, and repo-wide formatting. ".repeat(
                6,
              ),
          };
          send("tool_proposed", { name: "send_message", arguments: args });
          send("permission_required", { name: "send_message", arguments: args, reason: "", category: "messaging" });
          send("pending_registered", { id: "pending-long-digest", kind: "approval" });
          return;
        }
        // Standing scoped approvals (§25): an eligible connector-ish write — the event
        // carries the pinnable target, exactly like the real engine computes it.
        if (/post the digest/i.test(msg.text)) {
          pendingTool = "send_message";
          send("tool_proposed", {
            name: "send_message",
            arguments: { target: "slack:C1", text: "Weekly digest ready" },
          });
          send("permission_required", {
            name: "send_message",
            arguments: { target: "slack:C1", text: "Weekly digest ready" },
            reason: "",
            category: "messaging",
            standing_target: "slack:C1",
          });
          send("pending_registered", { id: "pending-digest", kind: "approval" });
          return;
        }
        // §25 consent card: the agent proposes the automation's permission set on the
        // gated create call; the existing approval card renders disclosure/grant lines.
        if (/create an automation/i.test(msg.text)) {
          pendingTool = "create_scheduled_task";
          send("tool_proposed", { name: "create_scheduled_task", arguments: {} });
          send("permission_required", {
            name: "create_scheduled_task",
            arguments: {
              title: "Weekly digest",
              instructions: "Summarize the week and post it.",
              cron: "0 9 * * 1",
              permissions: [
                { tool: "send_message", target: "slack:C1", access: "write" },
                { tool: "github_list_commits", target: "rohit/agent-platform", access: "read" },
              ],
            },
            reason: "",
            category: "automation",
          });
          send("pending_registered", { id: "pending-automation", kind: "approval" });
          return;
        }
        // A reasoning model's turn: thinking deltas tick in slowly, then the answer —
        // the assistant_message carries the full trace like the real engine's payload.
        if (/think hard/i.test(msg.text)) {
          const thoughts = ["Weighing options. ", "Comparing tradeoffs. ", "Settling it. "];
          let tick = 0;
          const timer = setInterval(() => {
            if (tick < thoughts.length) {
              send("reasoning_delta", { text: thoughts[tick] });
              tick += 1;
              return;
            }
            clearInterval(timer);
            send("assistant_delta", { text: "Decision made." });
            send("assistant_message", {
              text: "Decision made.",
              reasoning: thoughts.join(""),
            });
            send("turn_done");
          }, 120);
          return;
        }
        // Auto-compaction (OPE-27): the server signals `compacting` (the transient
        // spinner label), summarizes for a beat, then emits the marker and the turn
        // continues normally — the divider must render inline.
        if (/compact the context/i.test(msg.text)) {
          send("compacting", {});
          setTimeout(() => {
            send("compacted", { text: "Context compacted — earlier turns were summarized" });
            send("assistant_message", { text: "Still on it — continuing where I left off." });
            send("turn_done");
          }, 400);
          return;
        }
        // A turn that dies on a provider error; the follow-up {type:"retry"} recovers.
        if (/fail the turn/i.test(msg.text)) {
          send("error", { error: "model unreachable" });
          send("turn_done");
          return;
        }
        // A deliberately SLOW multi-second stream (~40 ticks × 120ms) so specs can
        // interact mid-turn — the follow/pin scroll contract (FB-004) is untestable
        // against the instant echo below.
        if (/stream the epic/i.test(msg.text)) {
          let ticks = 0;
          const line = "The epic scrolls ever onward, line upon line upon line. ";
          epicTimer = setInterval(() => {
            ticks += 1;
            send("assistant_delta", { text: line.repeat(3) + "\n\n" });
            if (ticks >= 40) {
              clearInterval(epicTimer!);
              epicTimer = null;
              send("assistant_message", { text: ("The epic concludes. " + line).repeat(20) });
              send("turn_done");
            }
          }, 120);
          return;
        }
        send("assistant_delta", { text: "Echo: " });
        send("assistant_delta", { text: msg.text });
        // Echo the model the message carried — pins the model-per-message contract (the
        // composer's visible model must ride on every user_message; 2026-07-04 fix).
        // Same for `skill`: the force-run pick must ride as its OWN FIELD, never as text.
        // `usage` mirrors the real engine's assistant_message sidecar (OPE-42): fixed
        // counts per turn so the usage-chip specs can assert exact accumulation.
        send("assistant_message", {
          text: `Echo: ${msg.text} [model=${msg.model || "none"}]${msg.skill ? ` [skill=${msg.skill}]` : ""}`,
          usage: {
            model: msg.model || "anthropic:claude-opus-4-8",
            input: 1_000,
            output: 200,
            cache_read: 8_000,
            cache_write: 800,
          },
        });
        send("turn_done");
      } else if (msg.type === "approval") {
        if (pendingTool === "run_shell") {
          if (msg.decision === "deny") {
            send("tool_finished", { name: "run_shell", status: "denied" });
            send("assistant_message", { text: "Understood — skipped the command." });
          } else {
            send("tool_finished", { name: "run_shell", status: "done", result_preview: "README.md" });
            send("assistant_message", { text: "The command ran; 1 file found." });
          }
        } else if (msg.decision === "deny") {
          send("tool_finished", { name: pendingTool, status: "denied" });
          send("assistant_message", { text: "Understood — skipped it." });
        } else {
          send("tool_finished", { name: pendingTool, status: "done", result_preview: "ok" });
          // The decision echoes back so specs can pin what rode the wire (e.g. always_task).
          send("assistant_message", { text: `Done via ${pendingTool} [decision=${msg.decision}]` });
        }
        send("turn_done");
      } else if (msg.type === "interrupt") {
        // Stop mid-stream: like the real engine, end the turn with `interrupted` and
        // NO assistant_message — the client owns promoting the partial into the transcript.
        if (epicTimer) {
          clearInterval(epicTimer);
          epicTimer = null;
        }
        send("interrupted", {});
        send("turn_done");
      } else if (msg.type === "set_model") {
        // Mid-session switch: the server applies it and broadcasts the persisted marker.
        // Like the real server, the FIRST bind (fresh session) is silent.
        if (hadTurn)
          send("model_changed", {
            model: msg.model,
            text: `Model switched to ${msg.model}`,
          });
      } else if (msg.type === "retry") {
        // Like the real engine: re-runs with NO new user message (turn_start input is empty).
        send("turn_start", { input: "" });
        send("assistant_message", { text: "Recovered after retry." });
        send("turn_done");
      }
    });
  });

  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const m = req.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (/\/v1\/sessions\/[^/]+\/roots$/.test(p)) {
      if (m === "POST") {
        const b = req.postDataJSON();
        const existing = roots.find((r) => r.path === b.path);
        if (existing) existing.writable = !!b.writable;
        else roots.push({ path: b.path, writable: !!b.writable, label: baseName(b.path), primary: false, exists: true });
        return json({ ok: true, roots });
      }
      if (m === "DELETE") {
        const rp = new URL(req.url()).searchParams.get("path");
        const i = roots.findIndex((r) => r.path === rp && !r.primary);
        if (i >= 0) roots.splice(i, 1);
        return json({ ok: true, roots });
      }
      return json({ roots });
    }
    if (p.endsWith("/v1/sessions/archived")) {
      return json({
        sessions: sessions
          .filter((s) => s.archived && !s.session_id.startsWith("__"))
          .map((s) => {
            const project = projects.find((p) => p.project_id === s.project_id);
            return {
              ...s,
              project_name: project?.name ?? null,
              project_path: project?.path ?? null,
              project_hidden: !!project?.hidden,
              project_path_exists: project?.path_exists ?? true,
            };
          }),
      });
    }
    if (p.endsWith("/v1/sessions")) {
      const hiddenProjectIds = new Set(projects.filter((project) => project.hidden).map((project) => project.project_id));
      return json({ sessions: sessions.filter((s) => !s.project_id || !hiddenProjectIds.has(s.project_id)) });
    }
    if (/\/v1\/sessions\/[^/]+\/messages$/.test(p)) return json({ messages: [] });
    if (/\/v1\/sessions\/[^/]+\/unattended$/.test(p)) {
      const id = decodeURIComponent(p.split("/").slice(-2)[0]);
      if (m === "POST") {
        unattended[id] = !!req.postDataJSON().unattended;
        return json({ ok: true, unattended: unattended[id] });
      }
      return json({ unattended: !!unattended[id] });
    }
    if (/\/v1\/sessions\/[^/]+$/.test(p)) {
      const id = decodeURIComponent(p.split("/").pop()!);
      const i = sessions.findIndex((s) => s.session_id === id);
      if (m === "PATCH") {
        if (i >= 0) Object.assign(sessions[i], req.postDataJSON());
        return json({ ok: true });
      }
      if (m === "DELETE") {
        if (i >= 0) sessions.splice(i, 1);
        return json({ ok: true });
      }
      return json(i >= 0 ? sessions[i] : PINNED_SESSION);
    }

    // Skills (SKILLS-SPEC §5/§6). Order matters: upload/confirm before the {name} regexes.
    if (/\/v1\/sessions\/[^/]+\/skills$/.test(p)) {
      // The composer's live menu: every Settings-enabled skill (§4 — disabled = invisible).
      return json({
        skills: skills
          .filter((s) => s.enabled)
          .map((s) => ({ name: s.name, description: s.description, scope: s.scope, enabled: true })),
      });
    }
    if (p.endsWith("/v1/skills/upload/confirm") && m === "POST") {
      const b = req.postDataJSON() || {};
      if (!stagedSkill || b.token !== stagedSkill.token)
        return json({ ok: false, error: "Upload expired — pick the file again." });
      skills.push({
        name: stagedSkill.name, description: stagedSkill.description,
        instructions: stagedSkill.instructions, scope: "global", source: "uploaded",
        enabled: true, path: `/state/skills/${stagedSkill.name}`, files: stagedSkill.files.length,
      });
      stagedSkill = null;
      return json({ ok: true });
    }
    if (p.endsWith("/v1/skills/upload") && m === "POST") {
      // Stage → preview; nothing lands until confirm. Fixed parse (the mock reads no zips).
      stagedSkill = {
        token: "stage-1", name: "greet", description: "says hello",
        instructions: "Say hello warmly.", files: ["notes.txt"],
      };
      return json({ ok: true, ...stagedSkill });
    }
    {
      const mr = p.match(/\/v1\/skills\/([^/]+)\/reveal$/);
      if (mr && m === "POST") {
        return json(
          skills.some((s) => s.name === decodeURIComponent(mr[1]))
            ? { ok: true }
            : { ok: false, error: `Unknown skill: ${decodeURIComponent(mr[1])}` },
        );
      }
    }
    if (/\/v1\/skills\/[^/]+$/.test(p) && (m === "PATCH" || m === "DELETE")) {
      const name = decodeURIComponent(p.split("/").pop()!);
      const i = skills.findIndex((s) => s.name === name);
      if (i < 0) return json({ ok: false, error: `Unknown skill: ${name}` });
      if (m === "DELETE") {
        skills.splice(i, 1);
        return json({ ok: true });
      }
      const b = req.postDataJSON() || {};
      if (typeof b.enabled === "boolean") skills[i].enabled = b.enabled;
      if (typeof b.description === "string") skills[i].description = b.description;
      if (typeof b.instructions === "string") skills[i].instructions = b.instructions;
      return json({ ok: true });
    }
    if (p.endsWith("/v1/skills") && m === "POST") {
      const b = req.postDataJSON() || {};
      if (!b.name || !(b.instructions || "").trim())
        return json({ ok: false, error: "Skill name and instructions are required." });
      if (skills.some((s) => s.name === b.name))
        return json({ ok: false, error: `A skill named '${b.name}' already exists in that scope.` });
      skills.push({
        name: b.name, description: b.description || "", instructions: b.instructions,
        scope: "global", source: "local", enabled: true, path: `/state/skills/${b.name}`, files: 0,
      });
      return json({ ok: true });
    }
    if (p.endsWith("/v1/skills")) return json({ skills });

    if (p.endsWith("/v1/health")) return json(HEALTH);
    if (p.endsWith("/v1/settings")) return json(settings);
    if (p.endsWith("/v1/settings/context-bar") && m === "POST") {
      Object.assign(settings, req.postDataJSON());
      return json({ ok: true, context_bar: settings.context_bar });
    }
    if (p.endsWith("/v1/settings/validate-folder") && m === "POST") {
      const b = req.postDataJSON() || {};
      return json({ ok: !!b.path, path: b.path, writable: !!b.path });
    }
    if ((p.endsWith("/v1/settings/session-root") || p.endsWith("/v1/settings/scratch-base")) && m === "POST") {
      const b = req.postDataJSON() || {};
      if (!b.path) return json({ ok: false, error: "empty path" });
      settings.session_root = b.path;
      return json({ ok: true, session_root: settings.session_root });
    }
    if (p.endsWith("/v1/settings/pdf") && m === "POST") {
      Object.assign(settings, req.postDataJSON());
      return json({
        ok: true,
        pdf_fallback: settings.pdf_fallback,
        pdf_max_pages: settings.pdf_max_pages,
        pdf_max_mb: settings.pdf_max_mb,
      });
    }
    if (p.endsWith("/v1/attachments/inspect-pdf") && m === "POST") {
      // Page count for the composer threshold check: the tests encode it in the PDF body
      // as "%%pages=N" (the mock doesn't parse real PDFs).
      const data = String(req.postDataJSON()?.data_url || "");
      const match = /%%pages=(\d+)/.exec(atob(data.split(",")[1] || "") || "");
      return json({ ok: true, pages: match ? Number(match[1]) : 1, bytes: data.length });
    }
    if (p.endsWith("/v1/workspaces/recent")) return json({ workspaces: [] });
    if (p.endsWith("/v1/workspaces/pick") && m === "POST") {
      return json({ ok: true, path: "/tmp/picked-folder" });
    }
    if (p.endsWith("/v1/workspaces/open") && m === "POST") {
      const b = req.postDataJSON();
      return json({ ok: true, path: b.path, git_branch: "main" });
    }
    if (p.endsWith("/v1/projects")) {
      const includeHidden = url.searchParams.get("include_hidden") === "1";
      return json({ projects: includeHidden ? projects : projects.filter((project) => !project.hidden) });
    }
    if (/\/v1\/projects\/[^/]+$/.test(p) && m === "PATCH") {
      const id = decodeURIComponent(p.split("/").pop()!);
      const i = projects.findIndex((project) => project.project_id === id);
      if (i >= 0) Object.assign(projects[i], req.postDataJSON());
      return json({ ok: i >= 0, project: projects[i] });
    }
    if (/\/v1\/connectors\/slack\/unauthorized\/[^/]+$/.test(p) && m === "POST") {
      const id = p.split("/").pop();
      const i = parked.findIndex((x) => x.id === id);
      if (i < 0) return json({ ok: false, error: "unknown item" });
      const b = req.postDataJSON();
      const item = parked.splice(i, 1)[0];
      if (b.action === "allow" || b.action === "allow_deliver") {
        const pool = slackState.allowed_users;
        if (pool && !pool.includes(item.user_id)) pool.push(item.user_id);
      }
      return json({ ok: true });
    }
    // Flat allow/disallow for the Socket Mode workspace.
    if (/\/v1\/connectors\/slack\/(allow|disallow)$/.test(p) && m === "POST") {
      const b = req.postDataJSON();
      const add = p.endsWith("/allow");
      const pool = slackState.allowed_users;
      const i = pool.indexOf(b.user_id);
      if (add && i < 0) pool.push(b.user_id);
      if (!add && i >= 0) pool.splice(i, 1);
      return json({ ok: true, allowed_users: [...pool], team_id: null });
    }
    if (p.endsWith("/v1/connectors/slack/approval-owners/add") && m === "POST") {
      const b = req.postDataJSON();
      if (!slackState.approval_owner_ids.includes(b.user_id))
        slackState.approval_owner_ids.push(b.user_id);
      if (!slackState.allowed_users.includes(b.user_id))
        slackState.allowed_users.push(b.user_id);
      return json({
        ok: true,
        approval_owner_ids: [...slackState.approval_owner_ids],
        allowed_users: [...slackState.allowed_users],
      });
    }
    if (p.endsWith("/v1/connectors/slack/approval-owners/remove") && m === "POST") {
      const b = req.postDataJSON();
      const i = slackState.approval_owner_ids.indexOf(b.user_id);
      if (i >= 0) slackState.approval_owner_ids.splice(i, 1);
      return json({ ok: true, approval_owner_ids: [...slackState.approval_owner_ids] });
    }
    // Workspace rosters for the pickers (users.list / conversations.list, mocked).
    if (/\/v1\/connectors\/slack\/workspaces\/[^/]+\/directory$/.test(p) && m === "GET") {
      const q = (new URL(req.url()).searchParams.get("q") || "").toLowerCase();
      const members = [
        { id: "U9MAYA", name: "Maya Chen", handle: "maya", guest: false },
        { id: "U8ROHIT", name: "Rohit Prasad", handle: "rohit", guest: false },
        { id: "U7CAL", name: "Contractor Cal", handle: "cal", guest: true },
      ].filter((mem) => !q || mem.name.toLowerCase().includes(q) || mem.handle.includes(q));
      return json({ ok: true, members });
    }
    if (/\/v1\/connectors\/slack\/workspaces\/[^/]+\/channels$/.test(p) && m === "GET") {
      const team = decodeURIComponent(p.split("/workspaces/")[1].split("/")[0]);
      const q = (new URL(req.url()).searchParams.get("q") || "").toLowerCase();
      const channels = [
        { id: "C9LAUNCH", name: "launch-team", is_private: false, is_member: true },
        { id: "C8LEADS", name: "leads", is_private: true, is_member: true },
        { id: "C7LOBBY", name: "lobby", is_private: false, is_member: false },
      ].filter((c) => !q || c.name.includes(q));
      return json({ ok: true, channels, team });
    }
    // Gmail multi-account management (M3.6 Step 3): per-account disconnect/default
    // + the "Never show agents" filter lists.
    if (/\/v1\/connectors\/gmail\/accounts\/[^/]+\/disconnect$/.test(p) && m === "POST") {
      const email = decodeURIComponent(p.split("/").slice(-2)[0]);
      const i = gmailState.accounts.findIndex((a) => a.email === email);
      if (i < 0) return json({ ok: false, error: "account not connected" });
      const wasDefault = gmailState.accounts[i].default;
      gmailState.accounts.splice(i, 1);
      if (wasDefault && gmailState.accounts[0]) gmailState.accounts[0].default = true;
      return json({ ok: true, remaining_accounts: gmailState.accounts.length });
    }
    if (/\/v1\/connectors\/google_calendar\/accounts\/[^/]+\/disconnect$/.test(p) && m === "POST") {
      const email = decodeURIComponent(p.split("/accounts/")[1].split("/")[0]);
      const i = gcalState.accounts.findIndex((a) => a.email === email);
      if (i < 0) return json({ ok: false, error: "account not connected" });
      const wasDefault = gcalState.accounts[i].default;
      gcalState.accounts.splice(i, 1);
      if (wasDefault && gcalState.accounts[0]) gcalState.accounts[0].default = true;
      return json({ ok: true, remaining_accounts: gcalState.accounts.length });
    }
    if (/\/v1\/connectors\/google_calendar\/accounts\/[^/]+\/default$/.test(p) && m === "POST") {
      const email = decodeURIComponent(p.split("/accounts/")[1].split("/")[0]);
      if (!gcalState.accounts.some((a) => a.email === email))
        return json({ ok: false, error: "account not connected" });
      for (const a of gcalState.accounts) a.default = a.email === email;
      return json({ ok: true, default_account: email });
    }
    if (/\/v1\/connectors\/gmail\/accounts\/[^/]+\/default$/.test(p) && m === "POST") {
      const email = decodeURIComponent(p.split("/").slice(-2)[0]);
      if (!gmailState.accounts.some((a) => a.email === email))
        return json({ ok: false, error: "account not connected" });
      for (const a of gmailState.accounts) a.default = a.email === email;
      return json({ ok: true, default_account: email });
    }
    if (p.endsWith("/v1/connectors/gmail/filters") && m === "PATCH") {
      const b = req.postDataJSON() || {};
      if (Array.isArray(b.senders)) gmailState.filters.senders = b.senders;
      if (Array.isArray(b.labels)) gmailState.filters.labels = b.labels;
      return json({ ok: true, filters: { ...gmailState.filters } });
    }
    // Generic multi-account management (accounts.py layer; notion in fixtures).
    if (/\/v1\/connectors\/notion\/accounts\/[^/]+\/disconnect$/.test(p) && m === "POST") {
      const id = decodeURIComponent(p.split("/accounts/")[1].split("/")[0]);
      const i = notionState.accounts.findIndex((a) => a.account_id === id);
      if (i < 0) return json({ ok: false, error: "account not connected" });
      const wasDefault = notionState.accounts[i].default;
      notionState.accounts.splice(i, 1);
      if (wasDefault && notionState.accounts[0]) notionState.accounts[0].default = true;
      return json({ ok: true, remaining_accounts: notionState.accounts.length });
    }
    if (/\/v1\/connectors\/notion\/accounts\/[^/]+\/default$/.test(p) && m === "POST") {
      const id = decodeURIComponent(p.split("/accounts/")[1].split("/")[0]);
      if (!notionState.accounts.some((a) => a.account_id === id))
        return json({ ok: false, error: "account not connected" });
      for (const a of notionState.accounts) a.default = a.account_id === id;
      return json({ ok: true, default_account: id });
    }
    // HubSpot multi-portal management (M3.6 Step 4).
    if (/\/v1\/connectors\/hubspot\/portals\/[^/]+\/disconnect$/.test(p) && m === "POST") {
      const hub = decodeURIComponent(p.split("/").slice(-2)[0]);
      const i = hubspotState.portals.findIndex((x) => x.hub_id === hub);
      if (i < 0) return json({ ok: false, error: "portal not connected" });
      const wasDefault = hubspotState.portals[i].default;
      hubspotState.portals.splice(i, 1);
      if (wasDefault && hubspotState.portals[0]) hubspotState.portals[0].default = true;
      return json({ ok: true, remaining_portals: hubspotState.portals.length });
    }
    if (/\/v1\/connectors\/hubspot\/portals\/[^/]+\/default$/.test(p) && m === "POST") {
      const hub = decodeURIComponent(p.split("/").slice(-2)[0]);
      if (!hubspotState.portals.some((x) => x.hub_id === hub))
        return json({ ok: false, error: "portal not connected" });
      for (const x of hubspotState.portals) x.default = x.hub_id === hub;
      return json({ ok: true, default_portal: hub });
    }
    if (p.endsWith("/v1/connectors/hubspot/hidden-fields") && m === "PATCH") {
      const b = req.postDataJSON() || {};
      if (Array.isArray(b.hidden_fields))
        hubspotState.hidden_fields = b.hidden_fields.map((f: string) => f.trim().toLowerCase());
      return json({ ok: true, hidden_fields: [...hubspotState.hidden_fields] });
    }
    if (p.endsWith("/v1/connectors"))
      return json({
        connectors: [
          slackConnector(),
          githubConnector(),
          ...CONNECTORS.connectors.map((c: any) =>
            c.name === "gmail"
              ? gmailConnector()
              : c.name === "google_calendar"
                ? gcalConnector()
                : c.name === "hubspot"
                  ? hubspotConnector()
                  : c.name === "notion"
                    ? notionConnector()
                    : c.name === "outlook"
                      ? outlookConnector()
                      : c.name === "monday" || c.name === "jira"
                        ? mcpConnector(c.name)
                        : { ...c },
          ),
        ],
      });
    if (/\/v1\/connectors\/[^/]+\/mcp-connect$/.test(p) && m === "POST") {
      // Local MCP OAuth flow — no cloud sign-in required; completes instantly here.
      const name = p.match(/\/v1\/connectors\/([^/]+)\/mcp-connect$/)?.[1] as
        | "monday"
        | "jira";
      if (name in mcpState) {
        mcpState[name] = true;
        return json({ ok: true, started: true });
      }
      return json({ ok: false, error: `${name} has no MCP connect path` });
    }
    if (p.endsWith("/v1/providers/order") && m === "GET") {
      const requestId = url.searchParams.get("request_id");
      const baseRevision = Number(url.searchParams.get("base_revision"));
      const requestApplied =
        requestId == null
          ? null
          : appliedProviderOrderRequests.has(requestId)
            ? true
            : baseRevision === providerOrderRevision
              ? false
              : "unknown";
      return json({
        providers: [...providerOrder],
        revision: providerOrderRevision,
        request_applied: requestApplied,
      });
    }
    if (p.endsWith("/v1/providers/order") && m === "PUT") {
      const body = req.postDataJSON();
      const requested = Array.isArray(body.providers) ? body.providers : [];
      const known = new Set(providers.map((provider) => provider.name));
      const valid =
        requested.length === known.size &&
        new Set(requested).size === requested.length &&
        requested.every((name: string) => known.has(name));
      if (!valid) return json({ detail: "Invalid provider order." }, 422);
      if (appliedProviderOrderRequests.has(body.request_id)) {
        return json({
          providers: [...providerOrder],
          revision: providerOrderRevision,
          request_id: body.request_id,
        });
      }
      if (body.revision !== providerOrderRevision) {
        return json(
          {
            providers: [...providerOrder],
            revision: providerOrderRevision,
          },
          409,
        );
      }
      providerOrder = [...requested];
      providerOrderRevision += 1;
      appliedProviderOrderRequests.add(body.request_id);
      return json({
        providers: [...providerOrder],
        revision: providerOrderRevision,
        request_id: body.request_id,
      });
    }
    // provider credential check (read-only) — an api_key containing "bad" fails, else ok.
    if (p.endsWith("/v1/providers/verify") && m === "POST") {
      const key = String(req.postDataJSON()?.fields?.api_key || "");
      return /bad/i.test(key)
        ? json({ ok: false, error: "Invalid API key." })
        : json({ ok: true });
    }
    // save a provider key — flips `configured`, stamps key_set_at (backend set_provider parity).
    if (p.endsWith("/v1/providers") && m === "POST") {
      const b = req.postDataJSON();
      const prov = providers.find((x) => x.name === b.name);
      if (!prov) return json({ ok: false, error: `unknown provider: ${b.name}` });
      const wasConfigured = !!prov.configured;
      if (b.fields?.api_key) {
        prov.configured = true;
        prov.key_set_at = "2026-07-05";
      }
      // Backend parity: non-secret fields merge into `values` (empty clears them).
      for (const [k, v] of Object.entries(b.fields || {})) {
        if (k === "api_key") continue;
        if (v) prov.values = { ...prov.values, [k]: v };
        else if (prov.values) delete prov.values[k];
      }
      if (!wasConfigured && prov.configured) {
        const promoted = [
          prov.name,
          ...providerOrder.filter((name) => name !== prov.name),
        ];
        if (promoted.some((name, index) => name !== providerOrder[index])) {
          providerOrder = promoted;
          providerOrderRevision += 1;
        }
      }
      return json({
        ok: true,
        provider: b.name,
        recommended_model: prov.recommended_model ?? null,
        provider_order: [...providerOrder],
        provider_order_revision: providerOrderRevision,
      });
    }
    // forget a provider's stored config (Settings ▸ Models "Remove key…").
    if (/\/v1\/providers\/[^/]+$/.test(p) && m === "DELETE") {
      const name = p.split("/").pop()!;
      const prov = providers.find((x) => x.name === name);
      if (!prov) return json({ ok: false, error: `unknown provider: ${name}` });
      prov.configured = !prov.needs_key; // keyless (ollama) stays "configured"
      prov.key_set_at = null;
      return json({ ok: true, provider: name });
    }
    if (p.endsWith("/v1/providers")) {
      const byName = new Map(providers.map((provider) => [provider.name, provider]));
      return json(providerOrder.map((name) => byName.get(name)).filter(Boolean));
    }
    if (p.endsWith("/v1/channels/recent"))
      return json({
        channels: [
          { channel: "slack:C0AAA111", name: "openloop-test", last_from: "amy", last_text: "standup at 10" },
          { channel: "slack:C0BBB222", last_from: "bob", last_text: "deploy failed" },
        ],
      });

    // inbox: pending items + the outbound routing binding (inline Slack config)
    if (/\/v1\/pending\/[^/]+\/resolve-question$/.test(p) && m === "POST") {
      const id = decodeURIComponent(p.split("/")[p.split("/").length - 2]);
      const it = inbox.find((x) => x.id === id);
      const body = req.postDataJSON();
      if (it?.kind === "question" && it.session_id === body.session_id) {
        it.state = "resolved";
        it.resolution = body.answer;
        return json({
          status: "accepted",
          item_id: id,
          response_id: body.response_id,
        });
      }
      return json(
        {
          detail: {
            status: "rejected",
            error: "question mismatch",
          },
        },
        400,
      );
    }
    if (/\/v1\/pending\/[^/]+\/resolve$/.test(p) && m === "POST") {
      const id = decodeURIComponent(p.split("/")[p.split("/").length - 2]);
      const it = inbox.find((x) => x.id === id);
      if (it) {
        it.state = "resolved";
        it.resolution = req.postDataJSON().resolution;
      }
      return json({ ok: true });
    }
    if (p.endsWith("/v1/connectors/slack/pending-routing/binding") && m === "POST") {
      const b = req.postDataJSON();
      routing.channel = b.channel;
      routing.target = b.target;
      return json({ ok: true, bindings: [{ ...routing }] });
    }
    if (p.endsWith("/v1/connectors/slack/pending-routing")) return json({ bindings: [{ ...routing }] });
    if (p.endsWith("/v1/pending")) {
      const q = new URL(req.url()).searchParams;
      const sid = q.get("session_id");
      const state = q.get("state");
      return json({
        items: inbox.filter(
          (i) => (!sid || i.session_id === sid) && (!state || i.state === state),
        ),
      });
    }

    // automations: one scheduled task with a running run (drives the Automations detail page
    // and the run-session banner + Back-to-runs flow). Mutable: Run now appends a run and opens
    // its live session; the enable toggle (PATCH) and delete (DELETE) round-trip through the UI.
    if (/\/v1\/automations\/[^/]+\/seen$/.test(p) && m === "POST") {
      const id = p.split("/").slice(-2)[0];
      const task = automations.find((t) => t.id === id);
      if (task) {
        task.unseen_runs = 0;
        task.unseen_failed = false;
        task.seen_runs_at = Math.floor(Date.now() / 1000);
      }
      return json({ ok: !!task });
    }
    if (/\/v1\/automations\/[^/]+\/run$/.test(p) && m === "POST") {
      const id = p.split("/").slice(-2)[0];
      const task = automations.find((t) => t.id === id);
      if (!task) return json({ ok: false, error: "unknown task" });
      const runId = `r${automationRuns.length + 1}`;
      automationRuns.unshift({
        run_id: runId,
        task_id: id,
        session_id: `__run__${runId}`,
        started_at: Math.floor(Date.now() / 1000),
        finished_at: null,
        status: "running",
        result_text: null,
        artifacts: [],
        error: null,
        trigger: "manual",
      });
      return json({
        ok: true,
        run_id: runId,
        session_id: `__run__${runId}`,
        workspace: task.workspace,
        agent: task.agent,
        prompt: task.instructions,
      });
    }
    if (/\/v1\/automations\/[^/]+$/.test(p) && m === "GET") {
      const id = p.split("/").pop();
      const task = automations.find((t) => t.id === id) ?? automations[0];
      return json({ task, runs: automationRuns.filter((r) => r.task_id === task?.id) });
    }
    if (/\/v1\/automations\/[^/]+$/.test(p) && m === "PATCH") {
      const id = p.split("/").pop();
      const task = automations.find((t) => t.id === id);
      const body = req.postDataJSON() ?? {};
      if (task && body.revoke) {
        // Standing-rule revocation (§25): remove the entry; `revoke` is a command,
        // not a field to Object.assign onto the task.
        task.always_allowed = (task.always_allowed || []).filter(
          (r: any) => r.entry !== body.revoke,
        );
        return json({ ok: true, task });
      }
      if (task) Object.assign(task, body);
      return json({ ok: true, task });
    }
    if (/\/v1\/automations\/[^/]+$/.test(p) && m === "DELETE") {
      const id = p.split("/").pop();
      const i = automations.findIndex((t) => t.id === id);
      if (i >= 0) automations.splice(i, 1);
      return json({ ok: true });
    }
    if (p.endsWith("/v1/automations") && m === "POST") {
      // GUI/onboarding-recipe create (§24) — mirrors the server: title+instructions+cron
      // required; §25 permissions become always_allowed entries (write grants only).
      const body = req.postDataJSON() || {};
      if (!body.title || !body.instructions || !(body.cron || body.fire_at))
        return json({ ok: false, error: "missing fields" });
      const grants = (body.permissions || [])
        .filter((g: any) => g && g.access === "write" && g.tool && g.target)
        .map((g: any) => ({ entry: `${g.tool} ${g.target}`, tool: g.tool, target: g.target }));
      const task = {
        ...AUTOMATION,
        id: `task-ob-${automations.length}`,
        title: body.title,
        instructions: body.instructions,
        schedule: body.cron || body.fire_at,
        always_allowed: grants,
        run_count: 0,
      };
      automations.push(task);
      return json({ ok: true, task });
    }
    if (p.endsWith("/v1/automations")) return json({ tasks: automations });
    if (p.endsWith("/v1/settings/onboarded") && m === "POST") {
      return json({ ok: true, onboarded: !!(req.postDataJSON() || {}).value });
    }
    // MCP servers — mutable so the OAuth quick-add (granola) flow reflects through the
    // UI: add → needs_auth, connect → authorizing, next poll → connected (6 tools).
    if (p.endsWith("/v1/mcp") && m === "GET") {
      for (const s2 of mcpServers) {
        if (s2.status === "authorizing" && s2._flip) {
          s2.status = "connected";
          s2.tool_count = 6;
        }
        if (s2.status === "authorizing") s2._flip = true;
      }
      return json({ servers: mcpServers.map(({ _flip, ...s2 }) => s2) });
    }
    if (p.endsWith("/v1/mcp") && m === "POST") {
      const b = req.postDataJSON();
      mcpServers.push({
        name: b.name,
        enabled: true,
        transport: b.config?.url ? "http" : "stdio",
        requires_approval: true,
        auth: b.config?.auth === "oauth" ? "oauth" : null,
        status: b.config?.auth === "oauth" ? "needs_auth" : "configured",
        last_error: null,
        tool_count: null,
        config: b.config || {},
      });
      return json({ ok: true, name: b.name });
    }
    {
      const mc = p.match(/\/v1\/mcp\/([^/]+)\/connect$/);
      if (mc && m === "POST") {
        const s2 = mcpServers.find((x) => x.name === decodeURIComponent(mc[1]));
        if (s2) s2.status = "authorizing";
        return json({ ok: true, started: true });
      }
      const ms = p.match(/\/v1\/mcp\/([^/]+)\/signout$/);
      if (ms && m === "POST") {
        const s2 = mcpServers.find((x) => x.name === decodeURIComponent(ms[1]));
        if (s2) {
          s2.status = "needs_auth";
          s2.tool_count = null;
          s2._flip = false;
        }
        return json({ ok: true });
      }
    }
    if (p.endsWith("/v1/unrouted")) return json([]);

    // channel subscriptions — mutable so add/remove reflect through the UI
    if (p.endsWith("/v1/subscriptions") && m === "GET") return json({ subscriptions });
    if (p.endsWith("/v1/subscriptions") && m === "POST") {
      const b = req.postDataJSON();
      // Backend parity with resolve_channel: Copy-link URLs resolve to the id; bare #names
      // can't be looked up and are rejected with the same hint the server gives.
      const raw = String(b.channel || "").trim();
      if (raw.startsWith("#"))
        return json({
          ok: false,
          error:
            "Channel names can't be looked up — paste the channel ID (channel name ▸ About) or the channel's Copy-link URL.",
        });
      const link = raw.match(/slack\.com\/archives\/([A-Za-z0-9]+)/);
      const channel = link ? `slack:${link[1].toUpperCase()}` : raw;
      subscriptions.push({ session_id: b.session_id, session_title: "", agent: "", channel, routing_target: null, collision: false });
      return json({ ok: true, channel });
    }
    if (p.endsWith("/v1/subscriptions/remove") && m === "POST") {
      const b = req.postDataJSON();
      const i = subscriptions.findIndex((s) => s.session_id === b.session_id && s.channel === b.channel);
      if (i >= 0) subscriptions.splice(i, 1);
      return json({ ok: true });
    }

    // Anything else: an empty-but-valid body. GET list endpoints read `?? []`/`?? {}` fallbacks.
    return json({});
  });
}

// A `test` whose page has the API mocked before navigation.
export const test = base.extend({
  page: async ({ page }, use) => {
    await mockApi(page);
    await use(page);
  },
});

export { expect };
