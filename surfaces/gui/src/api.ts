import type { Attachment, SessionInfo, WsEvent } from "./types";

declare const __OPENLOOP_DEV_TOKEN__: string;

// Endpoint resolution order: runtime-injected globals (Tauri sets `window.__OPENLOOP_HTTP__`
// for its dynamically-chosen sidecar port) → Vite env → the 127.0.0.1:8765 dev default. This
// keeps a single codebase: browser `npm run dev` hits 8765; the desktop shell hits its sidecar.
const httpBase = (): string =>
  (globalThis as any).__OPENLOOP_HTTP__ ||
  (import.meta as any).env?.VITE_OPENLOOP_HTTP ||
  "http://127.0.0.1:8765";
const wsBase = (): string =>
  (globalThis as any).__OPENLOOP_WS__ ||
  (import.meta as any).env?.VITE_OPENLOOP_WS ||
  "ws://127.0.0.1:8765";
const apiToken = (): string =>
  (globalThis as any).__OPENLOOP_API_TOKEN__ ||
  (import.meta as any).env?.VITE_OPENLOOP_API_TOKEN ||
  (typeof __OPENLOOP_DEV_TOKEN__ === "string" ? __OPENLOOP_DEV_TOKEN__ : "");

// All local REST calls pass through this module, so a module-local wrapper applies launch
// authentication without asking every endpoint helper to remember the security header.
const fetch = (
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);
  const token = apiToken();
  if (token) {
    headers.set("X-OpenLoop-Token", token);
  }
  return globalThis.fetch(input, { ...init, headers });
};

const openWebSocket = (url: string): WebSocket => {
  const token = apiToken();
  return token
    ? new WebSocket(url, ["openloop", token])
    : new WebSocket(url);
};

export interface Health {
  status: string;
  default_workspace: string | null;
  model: string;
}

export interface AgentInfo {
  name: string;
  title: string;
  needs_workspace: boolean;
  family: string;
  messaging: boolean;
  connectors: boolean;
}

export async function getAgents(): Promise<AgentInfo[]> {
  const res = await fetch(`${httpBase()}/v1/agents`);
  if (!res.ok) return [];
  return (await res.json()).agents ?? [];
}

export interface RecentWorkspace {
  path: string;
  name: string;
  exists: boolean;
}

/** A Codex-style first-class project: a named, pinned-able folder that sessions group under. */
export interface ProjectInfo {
  project_id: string;
  name: string;
  path: string;
  description?: string;
  pinned?: number | boolean;
  hidden?: boolean;
  path_exists?: boolean;
  n_sessions: number;
  unarchived_sessions?: number;
  archived_sessions?: number;
  last_used: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ArchivedSessionInfo extends SessionInfo {
  project_name?: string | null;
  project_path?: string | null;
  project_hidden?: boolean;
  project_path_exists?: boolean;
}

export interface WorkspaceCommandTrust {
  workspace: string;
  requested_commands: string[];
  trusted: boolean;
  required: boolean;
  exists?: boolean;
}

export async function getHealth(): Promise<Health> {
  const res = await fetch(`${httpBase()}/v1/health`);
  return res.json();
}

export async function getRecentWorkspaces(): Promise<RecentWorkspace[]> {
  const res = await fetch(`${httpBase()}/v1/workspaces/recent`);
  return (await res.json()).workspaces ?? [];
}

// -- projects (Codex-style first-class entities) ---------------------------------
export async function getProjects(opts: { includeHidden?: boolean } = {}): Promise<ProjectInfo[]> {
  const q = opts.includeHidden ? "?include_hidden=1" : "";
  const res = await fetch(`${httpBase()}/v1/projects${q}`);
  const d = await res.json();
  return d.projects ?? [];
}

export async function createProject(
  name: string,
  path: string,
  description = "",
): Promise<{ ok: boolean; error?: string; project?: ProjectInfo }> {
  const res = await fetch(`${httpBase()}/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, path, description }),
  });
  return res.json();
}

export async function updateProject(
  projectId: string,
  patch: { name?: string; description?: string; pinned?: boolean; hidden?: boolean; path?: string },
): Promise<{ ok: boolean; error?: string; project?: ProjectInfo }> {
  const res = await fetch(`${httpBase()}/v1/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return res.json();
}

export async function removeProject(
  projectId: string,
): Promise<{ ok: boolean; error?: string; project?: ProjectInfo }> {
  return updateProject(projectId, { hidden: true });
}

export async function reopenProject(
  projectId: string,
): Promise<{ ok: boolean; error?: string; project?: ProjectInfo }> {
  return updateProject(projectId, { hidden: false });
}

export async function relocateProject(
  projectId: string,
  path: string,
): Promise<{ ok: boolean; error?: string; project?: ProjectInfo }> {
  return updateProject(projectId, { path, hidden: false });
}

export async function deleteProject(
  projectId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/projects/${projectId}`, {
    method: "DELETE",
  });
  return res.json();
}

export async function setSessionProject(
  sessionId: string,
  projectId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/sessions/${sessionId}/project`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId }),
  });
  return res.json();
}

/** Ask the LOCAL sidecar to open the OS folder picker — the browser GUI can't obtain absolute
 * paths from web file dialogs. Blocks until the user picks or cancels; null on cancel/unavailable. */
export async function pickFolderViaServer(): Promise<string | null> {
  try {
    const res = await fetch(`${httpBase()}/v1/workspaces/pick`, { method: "POST" });
    const d = await res.json();
    return d.ok && d.path ? d.path : null;
  } catch {
    return null;
  }
}

export async function openWorkspace(
  path: string,
  create = false,
): Promise<{
  path: string;
  ok: boolean;
  error?: string;
  git_branch?: string | null;
  command_trust?: WorkspaceCommandTrust;
}> {
  const res = await fetch(`${httpBase()}/v1/workspaces/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, create }),
  });
  return res.json();
}

export async function getTrustedWorkspaces(): Promise<WorkspaceCommandTrust[]> {
  const res = await fetch(`${httpBase()}/v1/workspaces/trusted`);
  return (await res.json()).workspaces ?? [];
}

export async function setWorkspaceTrusted(
  path: string,
  trusted: boolean,
): Promise<{ ok: boolean; error?: string } & WorkspaceCommandTrust> {
  const res = await fetch(`${httpBase()}/v1/workspaces/trust`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, trusted }),
  });
  return res.json();
}

export async function getSessions(workspace?: string): Promise<SessionInfo[]> {
  const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
  const res = await fetch(`${httpBase()}/v1/sessions${q}`);
  return (await res.json()).sessions ?? [];
}

export async function getArchivedSessions(): Promise<ArchivedSessionInfo[]> {
  const res = await fetch(`${httpBase()}/v1/sessions/archived`);
  return (await res.json()).sessions ?? [];
}

// A structured connector-delivered inbound message (§3.1). Attached to the user message it framed,
// for display only — the model still sees the framed `content`; this drives the ConnectorMessageCard.
export interface MessageSource {
  connector: string; // platform id, e.g. "slack"
  kind: "channel" | "dm";
  channel_id: string; // e.g. "C0BD7KZ1AH5"
  channel_name: string; // resolved; may equal the id (e.g. "#openloop-test")
  sender_id: string;
  sender_name: string; // resolved; may equal the id
  ts: number; // epoch seconds
  text: string; // the RAW message (what the card shows)
}

// A transcript message from GET /v1/sessions/{id}/messages. Kept permissive (open shape) because
// itemsFromMessages reads several role-specific fields; `source` is the optional connector sidecar.
export interface ConversationMessage {
  role: string;
  content?: any;
  tool_calls?: any[];
  tool_call_id?: string;
  source?: MessageSource;
  // Token counts for the round-trip that produced an assistant message
  // ({model, input, output, cache_read, cache_write}); absent on older servers.
  usage?: import("./types").TurnUsage;
  [key: string]: any;
}

export async function getSessionMessages(sessionId: string): Promise<ConversationMessage[]> {
  const res = await fetch(`${httpBase()}/v1/sessions/${sessionId}/messages`);
  return (await res.json()).messages ?? [];
}

export async function renameSession(sessionId: string, title: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return res.json();
}

export async function setSessionFlags(
  sessionId: string,
  flags: { pinned?: boolean; archived?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(flags),
  });
  return res.json();
}

export async function deleteSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  return res.json();
}

export interface ArtifactInfo {
  path: string; // workspace-relative (the display/API identifier)
  abs_path?: string; // absolute — what "Copy path" copies
  name: string;
  kind: "markdown" | "html" | "image" | "code" | "text" | string;
  size: number;
  modified_at: number;
}

export interface ArtifactContent {
  ok: boolean;
  error?: string;
  path: string;
  kind: string;
  content?: string;
  data_url?: string;
  truncated?: boolean;
  // kind === "folder": a directory listing (models sometimes link a whole package dir).
  entries?: { name: string; dir: boolean; size: number }[];
}

export async function getArtifacts(sessionId: string): Promise<ArtifactInfo[]> {
  const res = await fetch(`${httpBase()}/v1/sessions/${encodeURIComponent(sessionId)}/artifacts`);
  return (await res.json()).artifacts ?? [];
}

export async function readArtifact(sessionId: string, path: string): Promise<ArtifactContent> {
  const q = new URLSearchParams({ path });
  const res = await fetch(`${httpBase()}/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/read?${q.toString()}`);
  return res.json();
}

/** Show the artifact in the OS file manager ("reveal") or open it with its default app ("open"). */
export async function revealArtifact(
  sessionId: string,
  path: string,
  mode: "reveal" | "open" = "reveal",
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, mode }),
  });
  return res.json();
}

// -- MCP servers --------------------------------------------------------------
export interface McpServer {
  name: string;
  enabled: boolean;
  transport: string;
  requires_approval: boolean;
  // "connected" | "configured" | "disabled" | and for auth:"oauth" servers:
  // "needs_auth" (no tokens yet) | "authorizing" (browser sign-in in flight)
  status: string;
  auth?: "oauth" | null;
  last_error?: string | null;
  tool_count: number | null;
  config: Record<string, any>;
}

export async function getMcpServers(): Promise<McpServer[]> {
  const res = await fetch(`${httpBase()}/v1/mcp`);
  return (await res.json()).servers ?? [];
}

export async function addMcpServer(name: string, config: Record<string, any>) {
  const res = await fetch(`${httpBase()}/v1/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, config }),
  });
  return res.json();
}

export async function patchMcpServer(name: string, changes: Record<string, any>) {
  const res = await fetch(`${httpBase()}/v1/mcp/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  return res.json();
}

export async function deleteMcpServer(name: string) {
  const res = await fetch(`${httpBase()}/v1/mcp/${encodeURIComponent(name)}`, { method: "DELETE" });
  return res.json();
}

export async function getMcpTools(
  name: string,
): Promise<{ ok: boolean; error?: string; tools: { name: string; description: string }[] }> {
  const res = await fetch(`${httpBase()}/v1/mcp/${encodeURIComponent(name)}/tools`);
  return res.json();
}

export async function reloadMcp() {
  const res = await fetch(`${httpBase()}/v1/mcp/reload`, { method: "POST" });
  return res.json();
}

/** Connect one MCP server now. For OAuth servers this opens the system browser;
 * poll getMcpServers() for the status flip (authorizing → connected / needs_auth). */
export async function connectMcp(name: string): Promise<{ ok: boolean; started?: boolean }> {
  const res = await fetch(`${httpBase()}/v1/mcp/${encodeURIComponent(name)}/connect`, {
    method: "POST",
  });
  return res.json();
}

/** Drop the connection and forget the stored OAuth tokens. */
export async function signoutMcp(name: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${httpBase()}/v1/mcp/${encodeURIComponent(name)}/signout`, {
    method: "POST",
  });
  return res.json();
}

// -- connectors ---------------------------------------------------------------
export interface ConnectorField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  help: string;
  placeholder: string;
}

// A message from a sender not (yet) on the allow-list — parked instead of dropped (§19).
export interface ParkedMessage {
  id: string;
  platform: string;
  chat_id: string;
  chat_name: string | null;
  user_id: string;
  user_name: string | null;
  chat_type: string;
  text: string;
  ts: number;
  team_id?: string | null;
}

// One connected HubSpot portal (multi-portal: `hubspot:portal:<hub_id>` profiles).
export interface HubSpotPortal {
  hub_id: string;
  name: string;
  sandbox: boolean;
  default: boolean;
  access: "read" | "write" | "";
}

// One connected Google account (multi-account: `gmail:account:<email>` /
// `google_calendar:account:<email>` profiles — same shape for both).
export interface GmailAccount {
  email: string;
  default: boolean;
  scopes: string;
  needs_reauth: boolean;
}

// "Never show agents" — enforced locally in the tool layer; agents see silent
// omissions, the user sees counts on tool cards + Activity rows.
export interface GmailFilters {
  senders: string[];
  labels: string[];
}

// One account of a generic multi-account connector (`<name>:account:<id>`
// profiles — Notion workspaces, PostHog projects, …). Gmail/Calendar predate
// the generic layer and keep their email-keyed shape above.
export interface AccountRow {
  account_id: string;
  name: string; // display identity captured at connect (workspace name, email, …)
  default: boolean;
}

export interface Connector {
  name: string;
  title: string;
  icon: string;
  blurb: string;
  // Pre-connect detail page copy (UX-DECISIONS §38): optional About paragraph
  // (empty → group omitted) + honest Access bullets.
  about?: string;
  access?: string[];
  auth: string;
  two_way: boolean;
  // Chat-platform capability, narrower than two_way: sessions can subscribe to channels.
  channels: boolean;
  available: boolean;
  fields: ConnectorField[];
  instructions: string[];
  connected: boolean;
  account: string | null;
  enabled: boolean;
  brand_color: string; // hex brand color, e.g. "#611f69" (fallback gray "#6b7280")
  logo: string; // stable logo id keyed into the frontend registry (empty → fallback glyph)
  aliases?: string[]; // extra typeahead terms ("calendar" surfaces Outlook)
  mcp?: boolean; // MCP-backed one-click with local OAuth
  allowed_users: string[];
  allowed_user_names?: Record<string, string | null>; // id → display name (people directory)
  approval_owner_ids?: string[]; // Manual Slack: humans allowed to resolve approvals
  approval_owner_names?: Record<string, string | null>;
  recent?: RecentSender[]; // recently-seen senders on a connected two-way connector
  unauthorized?: ParkedMessage[]; // parked messages from unallowed senders (§19)
  tools: ConnectorTool[];
  mode?: string; // "mcp" for a locally authorized MCP connector
  // Gmail/Calendar: email-keyed rows; generic account connectors (notion,
  // attio, posthog, …): AccountRow. The detail pages narrow by connector.
  accounts?: GmailAccount[] | AccountRow[];
  filters?: GmailFilters; // Gmail only: "Never show agents" senders/labels
  portals?: HubSpotPortal[]; // HubSpot only: connected portals (multi-portal)
  hidden_fields?: string[]; // HubSpot only: properties stripped from agent reads
}

/** One-click connect for an MCP-backed connector (monday, asana, jira): the sidecar
 * opens the vendor's sign-in in the browser (local OAuth, no cloud account needed);
 * poll getConnectors until the card flips to connected. */
export async function connectMcpBacked(name: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(
    `${httpBase()}/v1/connectors/${encodeURIComponent(name)}/mcp-connect`,
    { method: "POST" },
  );
  return res.json();
}

export interface ConnectorTool {
  name: string;
  label: string;
  kind: "read" | "write" | string;
  description: string;
  enabled: boolean;
  requires_approval: boolean;
}

export async function getConnectors(): Promise<Connector[]> {
  const res = await fetch(`${httpBase()}/v1/connectors`);
  return (await res.json()).connectors ?? [];
}

export async function connectConnector(
  name: string,
  fields: Record<string, string>,
): Promise<{ ok: boolean; account?: string; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/connectors/${encodeURIComponent(name)}/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  return res.json();
}

export async function disconnectConnector(name: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${httpBase()}/v1/connectors/${encodeURIComponent(name)}/disconnect`, {
    method: "POST",
  });
  return res.json();
}

export async function updateConnectorTools(
  name: string,
  enabled: Record<string, boolean>,
): Promise<{ ok: boolean; error?: string; tools?: Record<string, boolean> }> {
  const res = await fetch(`${httpBase()}/v1/connectors/${encodeURIComponent(name)}/tools`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  return res.json();
}

export interface AuditEvent {
  id: number;
  timestamp: string;
  session_id: string;
  agent: string;
  workspace: string;
  connector: string;
  tool: string;
  stage: string;
  status: string;
  approval: string;
  args: Record<string, any>;
  result_preview: string;
  reason: string;
  resource: string;
}

export async function getAudit(params: {
  limit?: number;
  session_id?: string;
  connector?: string;
  tool?: string;
} = {}): Promise<AuditEvent[]> {
  const q = new URLSearchParams();
  if (params.limit) q.set("limit", String(params.limit));
  if (params.session_id) q.set("session_id", params.session_id);
  if (params.connector) q.set("connector", params.connector);
  if (params.tool) q.set("tool", params.tool);
  const res = await fetch(`${httpBase()}/v1/audit${q.toString() ? "?" + q.toString() : ""}`);
  return (await res.json()).events ?? [];
}

export async function clearAudit(): Promise<{ ok: boolean }> {
  const res = await fetch(`${httpBase()}/v1/audit`, { method: "DELETE" });
  return res.json();
}

export interface BrowserState {
  open: boolean;
  url: string;
  title: string;
  status: string;
  last_action: string;
  last_result: string;
  last_error: string;
  screenshot_data_url: string;
  updated_at: string | null;
  controls: any[];
}

export async function getBrowserState(): Promise<BrowserState> {
  const res = await fetch(`${httpBase()}/v1/browser/state`);
  return res.json();
}

export async function takeBrowserScreenshot(): Promise<BrowserState & { ok?: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/browser/screenshot`, { method: "POST" });
  return res.json();
}

export async function closeBrowser(): Promise<{ ok?: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/browser/close`, { method: "POST" });
  return res.json();
}

// -- settings (model API key, default model, onboarding) ----------------------
export interface ModelSettings {
  provider: string;
  model: string;
  models: string[];
  has_key: boolean;
  model_ready: boolean; // can the default model's provider actually run (any provider)?
  source: "env" | "store" | null;
  onboarded: boolean;
  session_root: string;
  // Older backends returned scratch_base. Keep optional until the UI cleanup is complete.
  scratch_base?: string;
  // Where "New project" folder pickers open by default (absent → OS default location).
  default_dir?: string;
  secrets_path: string;  // OS-native on-disk location the server reports (not hardcoded)
  // Sidebar layout preference: chronological or grouped under OpenLoop.
  nav_layout?: "flat" | "grouped";
  // Sidebar: sessions shown per group before "Show more" (default 5, 1–50).
  sessions_peek?: number;
  // Composer: show the context-window fill bar (default FALSE; absent → the chip shows
  // the session total). The usage popover keeps both numbers regardless.
  context_bar?: boolean;
  // Curated-matrix display names ({full id → "GLM-5.2 · via Together"}); custom models absent.
  model_labels?: Record<string, string>;
  // {full id → context window in tokens}, verified matrix entries only — drives the
  // composer's context-fill meter (absent id → the meter hides). Optional for older backends.
  model_context_windows?: Record<string, number>;
  // Token savings (PDF attachments): fallback for models without native PDF support,
  // and attach-time thresholds. Optional so the GUI is robust to an older backend.
  pdf_fallback?: "text" | "images";
  pdf_max_pages?: number; // default 20, 1–100
  pdf_max_mb?: number; // default 10, 1–10
  // Auto-compaction of long histories (OPE-27): trigger = min(threshold% × context
  // window, cap tokens); model pins the summarizer ("" → the session's own model).
  // Optional so the GUI is robust to an older backend.
  compaction_threshold_pct?: number; // default 0.8, 0.10–0.95
  compaction_cap_tokens?: number; // default 250000
  compaction_model?: string;
}

export interface PdfSettings {
  pdf_fallback: "text" | "images";
  pdf_max_pages: number;
  pdf_max_mb: number;
}

/** Persist the Token-savings PDF settings (fallback mode + attach thresholds). */
export async function setPdfSettings(
  patch: Partial<PdfSettings>,
): Promise<{ ok: boolean; error?: string } & Partial<PdfSettings>> {
  const res = await fetch(`${httpBase()}/v1/settings/pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return res.json();
}

export interface CompactionSettings {
  compaction_threshold_pct: number;
  compaction_cap_tokens: number;
  compaction_model: string;
}

/** Persist the auto-compaction overrides (threshold %, token cap, summarizer model). */
export async function setCompactionSettings(
  patch: Partial<CompactionSettings>,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/settings/compaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return res.json();
}

/** Local page/size probe for a PDF data URL — the composer's attach-time threshold check. */
export async function inspectPdf(
  dataUrl: string,
): Promise<{ ok: boolean; pages?: number; bytes?: number; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/attachments/inspect-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data_url: dataUrl }),
  });
  return res.json();
}

/** Persist whether the composer shows the context-window fill bar. */
export async function setContextBar(
  shown: boolean,
): Promise<{ ok: boolean; context_bar?: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/settings/context-bar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context_bar: shown }),
  });
  return res.json();
}

/** Persist how many sessions a sidebar group shows before "Show more". */
export async function setSessionsPeek(
  n: number,
): Promise<{ ok: boolean; sessions_peek?: number; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/settings/sessions-peek`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessions_peek: n }),
  });
  return res.json();
}

export interface FolderValidation {
  ok: boolean;
  path?: string;
  exists?: boolean;
  writable?: boolean;
  error?: string;
}

export async function validateFolder(path: string): Promise<FolderValidation> {
  const res = await fetch(`${httpBase()}/v1/settings/validate-folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return res.json();
}

export async function setSessionRoot(
  path: string,
): Promise<{ ok: boolean; error?: string; session_root?: string }> {
  const res = await fetch(`${httpBase()}/v1/settings/session-root`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return res.json();
}

export async function setScratchBase(
  path: string,
): Promise<{ ok: boolean; error?: string; session_root?: string }> {
  return setSessionRoot(path);
}

/** Persist the sidebar layout preference. */
export async function setNavLayout(
  layout: "flat" | "grouped",
): Promise<{ ok: boolean; nav_layout?: "flat" | "grouped"; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/settings/nav-layout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nav_layout: layout }),
  });
  return res.json();
}

// -- Skills (SKILLS-SPEC §4) ----------------------------------------------------
// Scope = folder location: "global" (every session) or "project" (one workspace).
// The session endpoints resolve the effective menu (Settings disables + session mutes).

export interface SkillRow {
  name: string;
  description: string;
  instructions: string;
  scope: "global" | "project";
  source: string; // "local" | "uploaded"
  enabled: boolean;
  path: string;
  files?: number; // bundled resources beyond SKILL.md (§6 — rich skills are visible)
}

export interface SessionSkillRow {
  name: string;
  description: string;
  scope: "global" | "project";
  enabled: boolean; // false = muted for this session only
}

export interface SkillUploadPreview {
  ok: boolean;
  error?: string;
  token?: string;
  name?: string;
  description?: string;
  instructions?: string;
  files?: string[];
}

const skillUrl = (path = "") => `${httpBase()}/v1/skills${path}`;
const jsonPost = (body: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function listSkills(workspace?: string): Promise<SkillRow[]> {
  const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
  const res = await fetch(skillUrl(qs));
  return (await res.json()).skills ?? [];
}

export async function createSkill(body: {
  name: string;
  description: string;
  instructions: string;
  scope?: "global" | "project";
  workspace?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(skillUrl(), jsonPost(body));
  return res.json();
}

export async function updateSkill(
  name: string,
  patch: { description?: string; instructions?: string; enabled?: boolean; workspace?: string },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(skillUrl(`/${encodeURIComponent(name)}`), jsonPost(patch, "PATCH"));
  return res.json();
}

export async function revealSkill(name: string): Promise<{ ok: boolean; error?: string }> {
  // §6 "Show folder": the backend opens the skill's folder in the OS file manager.
  const res = await fetch(skillUrl(`/${encodeURIComponent(name)}/reveal`), jsonPost({}));
  return res.json();
}

export async function deleteSkill(
  name: string,
  workspace?: string,
): Promise<{ ok: boolean; error?: string }> {
  const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
  const res = await fetch(skillUrl(`/${encodeURIComponent(name)}${qs}`), { method: "DELETE" });
  return res.json();
}

export async function moveSkill(
  name: string,
  scope: "global" | "project",
  workspace?: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(skillUrl(`/${encodeURIComponent(name)}/move`), jsonPost({ scope, workspace }));
  return res.json();
}

export async function stageSkillUpload(
  dataB64: string,
  filename = "",
): Promise<SkillUploadPreview> {
  const res = await fetch(skillUrl("/upload"), jsonPost({ data_b64: dataB64, filename }));
  return res.json();
}

export async function confirmSkillUpload(
  token: string,
  scope: "global" | "project" = "global",
  workspace?: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(skillUrl("/upload/confirm"), jsonPost({ token, scope, workspace }));
  return res.json();
}


export async function sessionSkills(
  sessionId: string,
  workspace?: string,
): Promise<SessionSkillRow[]> {
  const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
  const res = await fetch(
    `${httpBase()}/v1/sessions/${encodeURIComponent(sessionId)}/skills${qs}`,
  );
  return (await res.json()).skills ?? [];
}

export async function setSessionSkill(
  sessionId: string,
  skill: string,
  enabled: boolean,
  opts: { clear?: boolean; workspace?: string } = {},
): Promise<{ skills?: SessionSkillRow[]; ok?: boolean; error?: string }> {
  const res = await fetch(
    `${httpBase()}/v1/sessions/${encodeURIComponent(sessionId)}/skills`,
    jsonPost({
      skill,
      enabled,
      ...(opts.clear ? { clear: true } : {}),
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
    }),
  );
  return res.json();
}

// -- Pending + Unattended -----------------------------------------------------
export interface InboxItem {
  id: string;
  session_id: string;
  kind: "approval" | "question" | "directory" | "plan";
  title: string;
  body: string;
  state: "pending" | "resolved";
  resolution: string | null;
  inbox: string;
  created_at: string;
  resolved_at: string | null;
  visibility?: "inline" | "inbox";
  // Question metadata (ask_user): quick-reply choices + a free-text escape.
  options?: Array<string | { value: string; label: string }>;
  allow_text?: boolean;
  multi?: boolean;
  // Kind-specific payload (directory: {path, writable}; …).
  data?: Record<string, any>;
  // Originating-session context (server-joined) so Pending is self-contained.
  session_title?: string;
  session_agent?: string | null;
  session_workspace?: string | null;
  session_exists?: boolean;
}

export async function getInbox(sessionId?: string, state?: string): Promise<InboxItem[]> {
  const q = new URLSearchParams();
  if (sessionId) q.set("session_id", sessionId);
  if (state) q.set("state", state);
  const res = await fetch(`${httpBase()}/v1/pending?${q.toString()}`);
  if (!res.ok) return [];
  return (await res.json()).items;
}

export async function resolveInboxItem(
  id: string,
  resolution: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${httpBase()}/v1/pending/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolution }),
  });
  return res.json();
}

export type QuestionResolutionStatus =
  | "accepted"
  | "accepted_replay"
  | "response_conflict"
  | "already_resolved"
  | "rejected";

export interface QuestionResolutionResult {
  status: QuestionResolutionStatus;
  item_id: string;
  response_id: string;
  error?: string;
}

export async function resolveQuestionItem(
  id: string,
  request: {
    session_id: string;
    response_id: string;
    answer: string;
    attachments?: Attachment[];
  },
): Promise<QuestionResolutionResult> {
  const res = await fetch(`${httpBase()}/v1/pending/${encodeURIComponent(id)}/resolve-question`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await res.json();
  if (res.ok) return body;
  const detail = body?.detail;
  return {
    status: detail?.status || "rejected",
    item_id: id,
    response_id: request.response_id,
    error: detail?.error || body?.error || `Request failed (${res.status})`,
  };
}

// -- channel subscriptions (view-only) ----------------------------------------
export interface Subscription {
  session_id: string;
  session_title: string;
  agent: string;
  channel: string;
  channel_name?: string | null; // resolved display name ("openloop-test"); address stays the id
  routing_target: string | null;
  collision: boolean; // inbound subscription == outbound Inbox routing on the same channel
}

export interface RecentChannel {
  channel: string;
  name?: string | null; // resolved display name, e.g. "openloop-test" (falls back to the address)
  last_from: string | null;
  last_text: string | null;
}

export async function getSubscriptions(): Promise<Subscription[]> {
  const res = await fetch(`${httpBase()}/v1/subscriptions`);
  return (await res.json()).subscriptions ?? [];
}

// -- pending routing (where Unattended approvals/questions get mirrored) --------
export interface InboxBinding {
  name: string;
  channel: string | null; // platform, e.g. "slack" (null = in-app Inbox only)
  target: string; // chat_id, e.g. "C0BEJNCQQ8Y"
}

export async function getInboxRouting(): Promise<InboxBinding[]> {
  const res = await fetch(`${httpBase()}/v1/connectors/slack/pending-routing`);
  return (await res.json()).bindings ?? [];
}

export async function setInboxBinding(
  name: string,
  channel: string | null,
  target: string,
): Promise<{ ok: boolean; bindings?: InboxBinding[]; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/connectors/slack/pending-routing/binding`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, channel, target }),
  });
  return res.json();
}

export interface UnroutedItem {
  source: string;
  sender: string;
  text: string;
  reason: string;
  ts: number;
}

export async function getUnrouted(): Promise<UnroutedItem[]> {
  const res = await fetch(`${httpBase()}/v1/unrouted`);
  return (await res.json()).items ?? [];
}

export async function getRecentChannels(): Promise<RecentChannel[]> {
  const res = await fetch(`${httpBase()}/v1/channels/recent`);
  return (await res.json()).channels ?? [];
}

export async function subscribeChannel(
  sessionId: string,
  channel: string,
): Promise<{ ok: boolean; channel?: string; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, channel }),
  });
  return res.json();
}

export async function unsubscribeChannel(
  sessionId: string,
  channel: string,
): Promise<{ ok: boolean; removed?: boolean }> {
  const res = await fetch(`${httpBase()}/v1/subscriptions/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, channel }),
  });
  return res.json();
}

export async function getUnattended(sessionId: string): Promise<boolean> {
  const res = await fetch(
    `${httpBase()}/v1/sessions/${encodeURIComponent(sessionId)}/unattended`,
  );
  return (await res.json()).unattended;
}

export async function setUnattended(
  sessionId: string,
  unattended: boolean,
): Promise<{ ok: boolean; unattended: boolean }> {
  const res = await fetch(
    `${httpBase()}/v1/sessions/${encodeURIComponent(sessionId)}/unattended`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unattended }),
    },
  );
  return res.json();
}

export async function getSettings(): Promise<ModelSettings> {
  const res = await fetch(`${httpBase()}/v1/settings`);
  return res.json();
}

export async function setModelKey(
  apiKey: string,
): Promise<{ ok: boolean; error?: string; has_key?: boolean; source?: string }> {
  const res = await fetch(`${httpBase()}/v1/settings/model-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  return res.json();
}

export async function setDefaultModel(
  model: string,
): Promise<{ ok: boolean; error?: string; model?: string }> {
  const res = await fetch(`${httpBase()}/v1/settings/default-model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  return res.json();
}

export async function addModel(model: string): Promise<ModelSettings & { ok: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/settings/models/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  return res.json();
}

export async function removeModel(model: string): Promise<ModelSettings & { ok: boolean }> {
  const res = await fetch(`${httpBase()}/v1/settings/models/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  return res.json();
}

export async function setOnboarded(value: boolean): Promise<{ ok: boolean; onboarded: boolean }> {
  const res = await fetch(`${httpBase()}/v1/settings/onboarded`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  return res.json();
}

// -- model providers (OpenAI, Ollama, …) --------------------------------------
export interface ProviderField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  help: string;
  placeholder: string;
  default?: string; // pre-filled editable value (e.g. an OpenAI-compatible vendor's endpoint)
  // Non-empty → segmented choice, not a text input. tag = tiny badge ("Easiest");
  // desc = one-liner atop the method panel; command = copyable terminal command.
  choices?: { value: string; label: string; tag?: string; desc?: string; command?: string }[];
  show_when?: Record<string, string> | null; // render only while these fields hold these values
}

export interface ProviderInfo {
  name: string;
  title: string;
  needs_key: boolean;
  fields: ProviderField[];
  configured: boolean;
  values: Record<string, string>; // non-secret stored values (e.g. base_url), for prefilling
  suggested_models: string[]; // bare model-name suggestions for the "add model" datalist
  recommended_model: string | null; // pre-filled default for this provider (e.g. qwen3-coder:30b)
  blurb?: string; // one-line note under the title ("Uses X's OpenAI-compatible API…")
  key_set_at?: string | null; // ISO date the key was last (re)saved — absent for env-only config
  last_used_at?: number | null; // epoch secs the provider last served a completion
}

export async function getProviders(): Promise<ProviderInfo[]> {
  const res = await fetch(`${httpBase()}/v1/providers`);
  return res.json();
}

export interface ProviderOrderResponse {
  providers: string[];
  revision: number;
  requestApplied: true | false | "unknown" | null;
}

export type PutProviderOrderResult =
  | {
      kind: "ok";
      providers: string[];
      revision: number;
      requestId: string;
    }
  | {
      kind: "conflict";
      providers: string[];
      revision: number;
    }
  | {
      kind: "invalid";
      error: string;
    };

export async function getProviderOrder(reconcile?: {
  requestId: string;
  baseRevision: number;
}): Promise<ProviderOrderResponse> {
  const query = reconcile
    ? `?${new URLSearchParams({
        request_id: reconcile.requestId,
        base_revision: String(reconcile.baseRevision),
      }).toString()}`
    : "";
  const res = await fetch(`${httpBase()}/v1/providers/order${query}`);
  if (!res.ok) {
    throw new Error(`Could not load provider order (${res.status})`);
  }
  const body = await res.json();
  return {
    providers: body.providers,
    revision: body.revision,
    requestApplied: body.request_applied ?? null,
  };
}

export async function putProviderOrder(request: {
  providers: string[];
  revision: number;
  requestId: string;
}): Promise<PutProviderOrderResult> {
  const res = await fetch(`${httpBase()}/v1/providers/order`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providers: request.providers,
      revision: request.revision,
      request_id: request.requestId,
    }),
  });
  const body = await res.json();
  if (res.status === 409) {
    return {
      kind: "conflict",
      providers: body.providers,
      revision: body.revision,
    };
  }
  if (res.status >= 400 && res.status < 500) {
    return {
      kind: "invalid",
      error: body.detail || body.error || "Invalid provider order.",
    };
  }
  if (!res.ok) {
    throw new Error(body.error || `Could not save provider order (${res.status})`);
  }
  return {
    kind: "ok",
    providers: body.providers,
    revision: body.revision,
    requestId: body.request_id,
  };
}

export async function setProvider(
  name: string,
  fields: Record<string, string>,
): Promise<{
  ok: boolean;
  error?: string;
  provider?: string;
  recommended_model?: string | null;
  provider_order?: string[];
  provider_order_revision?: number;
}> {
  const res = await fetch(`${httpBase()}/v1/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, fields }),
  });
  return res.json();
}

/** Forget a provider's stored config (Settings ▸ Models "Remove key…"). */
export async function removeProvider(name: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/providers/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  return res.json();
}

/** Live read-only credential check (does NOT save the key). Triggered by the user's "Test" click. */
export async function verifyProvider(
  name: string,
  fields: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/providers/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, fields }),
  });
  return res.json();
}

/** Client-side provider guess from an API key's shape (mirrors the server's detect_provider). */
export function detectProvider(apiKey: string): string | null {
  const key = (apiKey || "").trim();
  if (!key) return null;
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("sk-or-")) return "openrouter";
  if (key.startsWith("AIza")) return "gemini";
  if (key.startsWith("sk-") || key.startsWith("sk_")) return "openai";
  return null;
}

// -- super-agent --------------------------------------------------------------
export interface RecentSender {
  user_id: string;
  user_name: string | null;
  chat_id: string;
  chat_type: string;
  target: string;
  authorized: boolean;
  team_id?: string | null;
}

// -- direct-message routing ---------------------------------------------------
export async function getDmRoute(): Promise<string | null> {
  const res = await fetch(`${httpBase()}/v1/messaging/dm-route`);
  return (await res.json()).dm_session ?? null;
}

export async function setDmRoute(sessionId: string): Promise<{ ok: boolean; dm_session: string | null }> {
  const res = await fetch(`${httpBase()}/v1/messaging/dm-route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  });
  return res.json();
}

// -- automations (scheduled tasks) --------------------------------------------
export interface Automation {
  id: string;
  title: string;
  instructions: string;
  schedule: string;
  schedule_raw?: { kind: string; cron?: string | null; fire_at?: string | null; timezone?: string };
  workspace: string;
  agent: string;
  enabled: boolean;
  next_run: number | null;
  last_run: number | null;
  last_status: string | null;
  run_count: number;
  notify_on_completion: boolean;
  // UX-023 sidebar badges: runs started since the user last opened this automation's
  // detail; `unseen_failed` = the newest unseen run errored (danger tint).
  unseen_runs?: number;
  unseen_failed?: boolean;
  seen_runs_at?: number;
  // Standing scoped approvals (§25): target-bound rules this automation may exercise
  // without asking. `entry` is the raw record entry — the revoke handle; `target` is
  // null for legacy name-only entries.
  always_allowed: { entry: string; tool: string; target: string | null }[];
}

export interface AutomationRun {
  run_id: string;
  task_id: string;
  session_id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  result_text: string | null;
  artifacts: string[];
  error: string | null;
  trigger: string;
}

export async function getAutomations(): Promise<Automation[]> {
  const res = await fetch(`${httpBase()}/v1/automations`);
  return (await res.json()).tasks ?? [];
}

// Fired after any automation mutation the sidebar should reflect immediately
// (mark-seen, create, delete) — its poll covers the rest.
export const AUTOMATIONS_CHANGED = "openloop:automations-changed";
export function announceAutomationsChanged() {
  window.dispatchEvent(new CustomEvent(AUTOMATIONS_CHANGED));
}

/** App-wide event stream (/ws/events): session-independent server pushes such as
 * automation_run_started and running_state_changed. Quietly reconnects while the app is
 * open; the returned cleanup stops it for good. */
export function connectEvents(
  onEvent: (msg: { type: string; data?: Record<string, unknown> }) => void
): () => void {
  let ws: WebSocket | null = null;
  let timer: number | null = null;
  let closed = false;
  const open = () => {
    if (closed) return;
    ws = openWebSocket(`${wsBase()}/ws/events`);
    ws.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch {
        /* malformed frame — ignore */
      }
    };
    ws.onclose = () => {
      if (!closed) timer = window.setTimeout(open, 5000);
    };
  };
  open();
  return () => {
    closed = true;
    if (timer !== null) window.clearTimeout(timer);
    ws?.close();
  };
}

/** Advance the automation's seen mark — clears its unseen-runs badge (UX-023). */
export async function markAutomationSeen(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${httpBase()}/v1/automations/${id}/seen`, { method: "POST" });
  return res.json();
}

export async function createAutomation(payload: {
  title: string;
  instructions: string;
  cron?: string;
  fire_at?: string;
  timezone?: string;
  // §25 standing grants (the creating surface rendered them; submit IS the consent).
  // Only target-bound write entries survive server-side validation.
  permissions?: { tool: string; target: string; access: "read" | "write" }[];
}): Promise<{ ok: boolean; error?: string; task?: Automation }> {
  const res = await fetch(`${httpBase()}/v1/automations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function getAutomation(id: string): Promise<{ task: Automation; runs: AutomationRun[] }> {
  const res = await fetch(`${httpBase()}/v1/automations/${encodeURIComponent(id)}`);
  return res.json();
}

export async function updateAutomation(id: string, changes: Record<string, any>) {
  const res = await fetch(`${httpBase()}/v1/automations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  return res.json();
}

export async function deleteAutomation(id: string) {
  const res = await fetch(`${httpBase()}/v1/automations/${encodeURIComponent(id)}`, { method: "DELETE" });
  return res.json();
}

export interface PreparedRun {
  ok: boolean;
  error?: string;
  run_id: string;
  session_id: string;
  workspace: string;
  agent: string;
  prompt: string;
}

/** Prepare a live manual run: returns the session to open + the opening prompt to send. */
export async function runAutomation(id: string): Promise<PreparedRun> {
  const res = await fetch(`${httpBase()}/v1/automations/${encodeURIComponent(id)}/run`, { method: "POST" });
  return res.json();
}

/** Mark a manual run complete after its first turn finished. */
export async function finalizeAutomationRun(id: string, runId: string) {
  const res = await fetch(
    `${httpBase()}/v1/automations/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/finalize`,
    { method: "POST" },
  );
  return res.json();
}

export async function allowUser(
  name: string,
  userId: string,
  teamId?: string | null,
  displayName?: string,
) {
  const res = await fetch(`${httpBase()}/v1/connectors/${encodeURIComponent(name)}/allow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      ...(teamId ? { team_id: teamId } : {}),
      // Directory picks carry the display name so the chip is readable at once.
      ...(displayName ? { name: displayName } : {}),
    }),
  });
  return res.json();
}

// One workspace member from the roster (people picker; users:read, cached locally).
export interface SlackMember {
  id: string;
  name: string;
  handle: string;
  guest: boolean;
}

// One channel from the workspace roster. Private channels appear only where the
// bot is a member (Slack API constraint); is_member=false shows an invite hint.
export interface SlackChannelEntry {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
}

/** Workspace member roster for the people picker (teamId "default" = manual Socket Mode). */
export async function getSlackDirectory(
  teamId: string,
  q = "",
): Promise<{ ok: boolean; error?: string; members?: SlackMember[] }> {
  const res = await fetch(
    `${httpBase()}/v1/connectors/slack/workspaces/${encodeURIComponent(teamId)}/directory?q=${encodeURIComponent(q)}`,
  );
  return res.json();
}

/** Channel roster for the channel typeahead (name → id resolution). */
export async function getSlackChannels(
  teamId: string,
  q = "",
): Promise<{ ok: boolean; error?: string; channels?: SlackChannelEntry[] }> {
  const res = await fetch(
    `${httpBase()}/v1/connectors/slack/workspaces/${encodeURIComponent(teamId)}/channels?q=${encodeURIComponent(q)}`,
  );
  return res.json();
}

/** Resolve a parked unauthorized message (§19): dismiss / allow / allow_deliver. */
export async function resolveUnauthorized(
  name: string,
  itemId: string,
  action: "dismiss" | "allow" | "allow_deliver",
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(
    `${httpBase()}/v1/connectors/${encodeURIComponent(name)}/unauthorized/${encodeURIComponent(itemId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    },
  );
  return res.json();
}

export async function disallowUser(name: string, userId: string, teamId?: string | null) {
  const res = await fetch(`${httpBase()}/v1/connectors/${encodeURIComponent(name)}/disallow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(teamId ? { user_id: userId, team_id: teamId } : { user_id: userId }),
  });
  return res.json();
}

export async function addSlackApprovalOwner(
  userId: string,
  displayName?: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/connectors/slack/approval-owners/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      ...(displayName ? { name: displayName } : {}),
    }),
  });
  return res.json();
}

export async function removeSlackApprovalOwner(
  userId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/connectors/slack/approval-owners/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });
  return res.json();
}

/** Drop ONE Gmail mailbox; the default pointer moves to the next account. */
export async function disconnectGmailAccount(email: string): Promise<{ ok: boolean; error?: string; remaining_accounts?: number }> {
  const res = await fetch(
    `${httpBase()}/v1/connectors/gmail/accounts/${encodeURIComponent(email)}/disconnect`,
    { method: "POST" },
  );
  return res.json();
}

export async function setGmailDefaultAccount(email: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(
    `${httpBase()}/v1/connectors/gmail/accounts/${encodeURIComponent(email)}/default`,
    { method: "POST" },
  );
  return res.json();
}

/** Drop ONE Google Calendar account; the default pointer moves to the next one. */
export async function disconnectGcalAccount(email: string): Promise<{ ok: boolean; error?: string; remaining_accounts?: number }> {
  const res = await fetch(
    `${httpBase()}/v1/connectors/google_calendar/accounts/${encodeURIComponent(email)}/disconnect`,
    { method: "POST" },
  );
  return res.json();
}

export async function setGcalDefaultAccount(email: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(
    `${httpBase()}/v1/connectors/google_calendar/accounts/${encodeURIComponent(email)}/default`,
    { method: "POST" },
  );
  return res.json();
}

/** Drop ONE account of a generic multi-account connector (notion, attio,
 * posthog, …); the default pointer moves to the next account. */
export async function disconnectAccount(connector: string, accountId: string): Promise<{ ok: boolean; error?: string; remaining_accounts?: number }> {
  const res = await fetch(
    `${httpBase()}/v1/connectors/${encodeURIComponent(connector)}/accounts/${encodeURIComponent(accountId)}/disconnect`,
    { method: "POST" },
  );
  return res.json();
}

export async function setDefaultAccount(connector: string, accountId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(
    `${httpBase()}/v1/connectors/${encodeURIComponent(connector)}/accounts/${encodeURIComponent(accountId)}/default`,
    { method: "POST" },
  );
  return res.json();
}

/** Replace the "Never show agents" lists (senders and/or labels; omit to keep). */
export async function setGmailFilters(filters: { senders?: string[]; labels?: string[] }): Promise<{ ok: boolean; filters?: GmailFilters; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/connectors/gmail/filters`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(filters),
  });
  return res.json();
}

/** Drop ONE HubSpot portal; the default pointer moves to the next portal. */
export async function disconnectHubSpotPortal(hubId: string): Promise<{ ok: boolean; error?: string; remaining_portals?: number }> {
  const res = await fetch(
    `${httpBase()}/v1/connectors/hubspot/portals/${encodeURIComponent(hubId)}/disconnect`,
    { method: "POST" },
  );
  return res.json();
}

export async function setHubSpotDefaultPortal(hubId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(
    `${httpBase()}/v1/connectors/hubspot/portals/${encodeURIComponent(hubId)}/default`,
    { method: "POST" },
  );
  return res.json();
}

/** Replace the hidden-fields denylist (properties stripped from agent reads). */
export async function setHubSpotHiddenFields(fields: string[]): Promise<{ ok: boolean; hidden_fields?: string[]; error?: string }> {
  const res = await fetch(`${httpBase()}/v1/connectors/hubspot/hidden-fields`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hidden_fields: fields }),
  });
  return res.json();
}

export type Handlers = {
  onEvent: (event: WsEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

export type SessionOptions = {
  projectId?: string | null;
};

export class Session {
  private ws: WebSocket;
  // Payloads sent before the socket finished opening, replayed on `onopen`. Belt-and-suspenders
  // against the first message being dropped if the user sends in the connect window.
  private outbox: object[] = [];

  constructor(
    sessionId: string,
    workspace: string,
    _agent: string,
    handlers: Handlers,
    options: SessionOptions = {},
  ) {
    const params = new URLSearchParams({
      workspace,
    });
    if (options.projectId) params.set("project_id", options.projectId);
    const q = `?${params.toString()}`;
    this.ws = openWebSocket(`${wsBase()}/ws/session/${sessionId}${q}`);
    this.ws.onmessage = (e) => handlers.onEvent(JSON.parse(e.data));
    this.ws.onopen = () => {
      this.flush();
      handlers.onOpen?.();
    };
    this.ws.onclose = () => handlers.onClose?.();
  }

  private flush() {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const pending = this.outbox;
    this.outbox = [];
    for (const p of pending) this.ws.send(JSON.stringify(p));
  }

  private send(payload: object) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
    // Still connecting: queue and flush on open rather than silently dropping.
    else if (this.ws.readyState === WebSocket.CONNECTING) this.outbox.push(payload);
  }

  /** `model` = the composer's CURRENT selection, carried on every message so the turn uses
   * exactly what the user sees — immune to set_model races across reconnects (a new session
   * session always reconnects once to adopt its scratch dir, which could drop a queued
   * set_model and leave the engine on a stale/resumed model; found 2026-07-04). */
  userMessage(text: string, attachments?: unknown[], model?: string, skill?: string) {
    this.send({
      type: "user_message",
      text,
      ...(model ? { model } : {}),
      ...(attachments?.length ? { attachments } : {}),
      // Force-run (SKILLS-SPEC §4.1): the composer's /skill pick rides as its own field;
      // the server validates it against the session's effective menu and frames the turn.
      ...(skill ? { skill } : {}),
    });
  }

  approve(itemId: string, decision: string) {
    this.send({ type: "approval", item_id: itemId, decision });
  }

  // Reply to a `request_directory` prompt: grant a folder (with access level) or decline.
  respondDirectory(itemId: string, granted: boolean, path?: string, writable?: boolean) {
    this.send({ type: "directory_response", item_id: itemId, granted, ...(path ? { path } : {}), writable: !!writable });
  }

  // Reply to a `propose_plan` prompt: approve (choosing the execution mode) or reject with feedback.
  respondPlan(itemId: string, approved: boolean, mode?: string, feedback?: string) {
    this.send({
      type: "plan_response",
      item_id: itemId,
      approved,
      ...(mode ? { mode } : {}),
      ...(feedback ? { feedback } : {}),
    });
  }

  interrupt() {
    this.send({ type: "interrupt" });
  }

  // Re-run a turn that ended in a provider error — no new user message; the server
  // guards on the history tail so a stray frame is a no-op.
  retry() {
    this.send({ type: "retry" });
  }

  setMode(mode: string) {
    this.send({ type: "set_mode", mode });
  }

  setModel(model: string) {
    this.send({ type: "set_model", model });
  }

  close() {
    // Detach before closing: this socket's async `close` event may land AFTER the
    // successor session's `open` (observed when switching into an automation-run
    // session), and a torn-down socket must not clobber the new one's connected state.
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    this.ws.close();
  }
}
