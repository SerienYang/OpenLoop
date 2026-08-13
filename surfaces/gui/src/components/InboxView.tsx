import { useEffect, useState } from "react";
import {
  getInbox,
  resolveInboxItem,
  resolveQuestionItem,
  type InboxItem,
} from "../api";
import { Icon } from "./Icon";
import { InboxItemCard } from "./InboxItemCard";
import { PanelHead } from "./IntegrationsView";
import { useI18n } from "../i18n";

// Pending: approvals/questions from across sessions, including unattended ones. Resolving here
// releases any agent suspended on the item. Configuration moved to connector settings.
export function InboxView({
  onOpenSession,
}: {
  onOpenSession: (sessionId: string, workspace: string, agent: string) => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<InboxItem[]>([]);

  const load = () => {
    getInbox(undefined, "pending").then(setItems).catch(() => {});
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  const resolve = async (
    id: string,
    resolution: string,
    responseId?: string,
  ) => {
    const item = items.find((candidate) => candidate.id === id);
    let result;
    if (item?.kind === "question") {
      result = await resolveQuestionItem(id, {
        session_id: item.session_id,
        response_id: responseId || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        answer: resolution,
        attachments: [],
      });
    } else {
      await resolveInboxItem(id, resolution);
    }
    load();
    return result;
  };

  // The originating-session chip links back to its OpenLoop session.
  const sessionChip = (it: InboxItem) => {
    const exists = it.session_exists !== false;
    const label = it.session_title || it.session_id;
    return (
      <button
        className="inbox-session-chip"
        title={exists ? t("Open “{{label}}”", { label }) : t("Session unavailable")}
        disabled={!exists}
        onClick={() =>
          exists && onOpenSession(it.session_id, it.session_workspace || "", it.session_agent || "openloop")
        }
      >
        <span className="inbox-chip-ico ico-openloop">
          <Icon name="diamond" size={11} />
        </span>
        <span className="inbox-chip-label">{label}</span>
        {exists && <Icon name="chevronRight" size={13} className="inbox-chip-go" />}
      </button>
    );
  };

  return (
    <main className="flex-1 min-w-0 flex bg-paper">
      <div className="flex-1 min-w-0 overflow-y-auto hairline-scroll">
        <div className="max-w-4xl mx-auto px-7 py-6">
          <PanelHead
            title={t("Pending")}
            sub={t("Approvals and questions that need you.")}
          />
          {items.length === 0 ? <div className="manage-empty">{t("Nothing pending.")}</div> : null}
          <div className="space-y-4">
            {items.map((it) => (
              <InboxItemCard key={it.id} item={it} onResolve={resolve} chip={sessionChip(it)} />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
