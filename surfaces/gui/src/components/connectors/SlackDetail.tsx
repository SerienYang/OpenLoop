import { useState } from "react";
import {
  addSlackApprovalOwner,
  disconnectConnector,
  removeSlackApprovalOwner,
} from "../../api";
import { ConnectorBadge } from "../../connectors/ConnectorIcon";
import { useI18n } from "../../i18n";
import {
  AllowlistBlock,
  ConnectorTools,
  ListeningSessionsBlock,
  UnauthorizedBlock,
} from "../ManageTabs";
import { AddConnectionModal } from "./AddConnectionModal";
import type { DetailProps } from "./ConnectorsSection";
import { GRP, GRP_H, PILL_ACCENT, ROW, XBTN } from "./ui";

export function SlackDetail({ c, onChanged }: DetailProps) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const [ownerId, setOwnerId] = useState("");
  const [busy, setBusy] = useState(false);

  const disconnect = async () => {
    setBusy(true);
    await disconnectConnector("slack");
    setBusy(false);
    onChanged();
  };

  return (
    <div data-testid="slack-manual-detail">
      <div className="flex items-center gap-3.5 mb-5">
        <ConnectorBadge connector={c} size={44} title="Slack" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[20px] font-semibold tracking-tight leading-tight">Slack</h2>
          <div className="text-[12.5px] text-muted flex items-center gap-1.5">
            {c.connected ? (
              <>
                <span className="w-2 h-2 rounded-full bg-ok" />
                <span data-testid="slack-mode-badge">
                  {t("Connected · Socket Mode")}
                </span>
              </>
            ) : (
              <span>{t("Not connected")}</span>
            )}
          </div>
        </div>
        {c.connected ? (
          <button
            className="text-[12.5px] text-danger/80 hover:text-danger"
            disabled={busy}
            onClick={disconnect}
          >
            {busy ? t("Disconnecting…") : t("Disconnect")}
          </button>
        ) : (
          <button
            className={PILL_ACCENT}
            data-testid="add-workspace-btn"
            onClick={() => setAdding(true)}
          >
            {t("Connect")}
          </button>
        )}
      </div>

      {!c.connected && (
        <div className={GRP}>
          <div className={ROW + " text-[12.5px] text-muted"}>
            {t("Connect your own Slack app with a bot token and Socket Mode app token.")}
          </div>
        </div>
      )}

      {c.connected && (
        <>
          <div className={GRP}>
            <AllowlistBlock c={c} onChanged={onChanged} />
            <UnauthorizedBlock c={c} onChanged={onChanged} />
            <ListeningSessionsBlock c={c} />
          </div>
          <div className={GRP_H}>{t("Approval owners")}</div>
          <div className={GRP} data-testid="slack-approval-owners">
            <div className={ROW}>
              <span className="min-w-0 flex-1 flex flex-wrap gap-1.5">
                {(c.approval_owner_ids ?? []).map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-2 py-0.5 text-[12.5px]"
                  >
                    {c.approval_owner_names?.[id] || id}
                    <button
                      className={XBTN}
                      title={t("remove approval owner")}
                      onClick={async () => {
                        await removeSlackApprovalOwner(id);
                        onChanged();
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  className="min-w-[150px] flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
                  placeholder={t("Slack user ID")}
                  value={ownerId}
                  onChange={(event) => setOwnerId(event.target.value)}
                  onKeyDown={async (event) => {
                    if (event.key !== "Enter" || !ownerId.trim()) return;
                    await addSlackApprovalOwner(ownerId.trim());
                    setOwnerId("");
                    onChanged();
                  }}
                />
              </span>
            </div>
          </div>
          <div className={GRP + " mt-4"}>
            <ConnectorTools c={c} onChanged={onChanged} />
          </div>
        </>
      )}

      {adding && (
        <AddConnectionModal
          c={c}
          onClose={() => setAdding(false)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}
