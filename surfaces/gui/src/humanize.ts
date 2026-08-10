// UX-015 (§33): tool calls render as English one-liners. The model does NOT emit a purpose
// per call — the stream is name+args+result — so the sentence is synthesized here from
// per-tool templates. `run_shell` is the exception: its optional `description` argument is
// model-written intent and is preferred when present. Fallback: "Used <tool> — <short args>".

import { shortArgs } from "./components/ApprovalCard";

// A one-line sentence in three segments so the UI can emphasize the object:
// "Read " + <b>runbook.md</b> + " from the shared folder".
export interface HumanLine {
  pre: string;
  obj?: string;
  post?: string;
}

export type Translator = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

const tr = (
  translate: Translator | undefined,
  key: string,
  vars?: Record<string, string | number>,
) => {
  if (translate) return translate(key, vars);
  let out = key;
  for (const [name, value] of Object.entries(vars || {})) {
    out = out.split(`{{${name}}}`).join(String(value));
  }
  return out;
};

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

// send_message targets are "platform:chat" or "platform:chat:thread" — show the platform
// by name and the last human-ish segment of the chat id.
function messageTarget(target: string): { platform: string; tail: string } {
  const [platform, ...rest] = String(target).split(":");
  const chat = rest[0] || "";
  const tail = chat.includes("/") ? chat.split("/").pop() || chat : chat;
  const names: Record<string, string> = { slack: "Slack", telegram: "Telegram" };
  return { platform: names[platform] || platform, tail };
}

export function humanizeTool(name: string, args: any, translate?: Translator): HumanLine {
  const a = args && typeof args === "object" ? args : {};
  switch (name) {
    case "run_shell": {
      const cmd = trunc(String(a.command ?? ""), 60);
      const desc = typeof a.description === "string" && a.description.trim() ? a.description.trim() : "";
      const pre = a.run_in_background
        ? tr(translate, "Started in the background: ")
        : tr(translate, "Ran ");
      return {
        pre,
        obj: cmd,
        ...(desc ? { post: ` — ${desc.charAt(0).toLowerCase()}${desc.slice(1)}` } : {}),
      };
    }
    case "shell_task_output":
      return { pre: tr(translate, "Checked on a background command") };
    case "shell_task_kill":
      return { pre: tr(translate, "Stopped a background command") };
    case "read_file":
      return { pre: tr(translate, "Read "), obj: baseName(String(a.path ?? tr(translate, "a file"))) };
    case "write_file":
      return { pre: tr(translate, "Wrote "), obj: baseName(String(a.path ?? tr(translate, "a file"))) };
    case "replace_in_file":
    case "apply_patch":
    case "apply_unified_diff":
      return { pre: tr(translate, "Edited "), obj: a.path ? baseName(String(a.path)) : tr(translate, "files") };
    case "grep":
      return { pre: tr(translate, "Searched the code for "), obj: `“${trunc(String(a.pattern ?? ""), 40)}”` };
    case "git_log":
      return { pre: tr(translate, "Looked through recent git history") };
    case "todo_write": {
      // `todos` is current; `items` renders histories from before the rename (the old
      // key breaks Together's GLM-5.2 chat template — see the todo tool implementation).
      const items = Array.isArray(a.todos) ? a.todos : Array.isArray(a.items) ? a.items : [];
      if (items.length === 1) {
        const it = items[0] || {};
        const status = String(it.status || "").replace(/_/g, " ");
        return {
          pre: tr(translate, "Updated the plan — "),
          obj: `“${trunc(String(it.content ?? ""), 70)}”`,
          ...(status ? { post: ` → ${tr(translate, status)}` } : {}),
        };
      }
      return { pre: tr(translate, "Updated the plan — {{count}} items", { count: items.length }) };
    }
    case "send_message": {
      const { platform, tail } = messageTarget(String(a.target ?? ""));
      if (!tail) return { pre: tr(translate, "Sent a message") };
      return { pre: tr(translate, "Sent a {{platform}} message to ", { platform }), obj: tail };
    }
    case "web_search":
      return { pre: tr(translate, "Searched the web — "), obj: `“${trunc(String(a.query ?? ""), 60)}”` };
    case "web_fetch": {
      let host = String(a.url ?? "");
      try {
        host = new URL(host).host || host;
      } catch {
        /* keep raw */
      }
      return { pre: tr(translate, "Read a web page — "), obj: trunc(host, 50) };
    }
    case "explore":
      return { pre: tr(translate, "Sent a sub-agent to explore — "), obj: `“${trunc(String(a.task ?? a.prompt ?? ""), 60)}”` };
    case "load_skill":
      // SKILLS-SPEC §4.1 #4 — the trust line: the transcript always shows the moment a
      // skill's instructions were picked up, model-invoked or forced via /skill.
      return { pre: tr(translate, "Used skill: "), obj: String(a.name ?? "") };
    case "ask_user":
      return { pre: tr(translate, "Asked you a question") };
    case "propose_plan":
      return { pre: tr(translate, "Proposed a plan") };
    case "request_directory":
      return { pre: tr(translate, "Asked for folder access — "), obj: String(a.path ?? "") };
    default: {
      const rest = trunc(shortArgs(a), 80);
      return { pre: tr(translate, "Used {{name}}", { name }), ...(rest ? { post: ` — ${rest}` } : {}) };
    }
  }
}

// The approval card's headline (§35): the ask, phrased as the action being decided.
// run_shell leads with the model's own description ("Run a command — fetch stock data").
export function humanizeApprovalTitle(name: string, args: any, translate?: Translator): HumanLine {
  const a = args && typeof args === "object" ? args : {};
  switch (name) {
    case "write_file":
      return { pre: tr(translate, "Write "), obj: baseName(String(a.path ?? tr(translate, "a file"))) };
    case "replace_in_file":
    case "apply_patch":
    case "apply_unified_diff":
      return { pre: tr(translate, "Edit "), obj: a.path ? baseName(String(a.path)) : tr(translate, "files") };
    case "run_shell": {
      const desc = typeof a.description === "string" && a.description.trim() ? a.description.trim() : "";
      return {
        pre: tr(translate, "Run a command"),
        ...(desc ? { post: ` — ${desc.charAt(0).toLowerCase()}${desc.slice(1)}` } : {}),
      };
    }
    case "send_message": {
      const { tail } = messageTarget(String(a.target ?? ""));
      return tail ? { pre: tr(translate, "Send a message to "), obj: tail } : { pre: tr(translate, "Send a message") };
    }
    case "send_file": {
      const { tail } = messageTarget(String(a.target ?? ""));
      return tail ? { pre: tr(translate, "Send a file to "), obj: tail } : { pre: tr(translate, "Send a file") };
    }
    case "create_scheduled_task":
      return a.title
        ? { pre: tr(translate, "Create the automation "), obj: `“${trunc(String(a.title), 60)}”` }
        : { pre: tr(translate, "Create an automation") };
    case "save_skill":
      // SKILLS-SPEC §5.2/§7: "Add", never "install"; destination is "your skills".
      return a.name
        ? { pre: tr(translate, "Add skill "), obj: String(a.name), post: tr(translate, " to your skills") }
        : { pre: tr(translate, "Add a skill to your skills") };
    default:
      return { pre: tr(translate, "Use {{name}}", { name }) };
  }
}

// Approvals with no executed tool call (typically declined): the ask, phrased as intent.
export function humanizeAsk(name: string, args: any, translate?: Translator): HumanLine {
  const a = args && typeof args === "object" ? args : {};
  switch (name) {
    case "run_shell":
      return { pre: tr(translate, "Wanted to run "), obj: trunc(String(a.command ?? ""), 60) };
    case "write_file":
      return { pre: tr(translate, "Wanted to write "), obj: baseName(String(a.path ?? tr(translate, "a file"))) };
    case "replace_in_file":
    case "apply_patch":
    case "apply_unified_diff":
      return { pre: tr(translate, "Wanted to edit "), obj: a.path ? baseName(String(a.path)) : tr(translate, "files") };
    case "send_message": {
      const { platform, tail } = messageTarget(String(a.target ?? ""));
      if (!tail) return { pre: tr(translate, "Wanted to send a message") };
      return { pre: tr(translate, "Wanted to message "), obj: tail, post: tr(translate, " on {{platform}}", { platform }) };
    }
    default:
      return { pre: tr(translate, "Wanted to use {{name}}", { name }) };
  }
}
