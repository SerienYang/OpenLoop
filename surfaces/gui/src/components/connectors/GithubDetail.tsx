import { useState } from "react";
import { disconnectConnector } from "../../api";
import { ConnectorBadge } from "../../connectors/ConnectorIcon";
import { useI18n } from "../../i18n";
import { AddConnectionModal } from "./AddConnectionModal";
import type { DetailProps } from "./ConnectorsSection";
import { ToolsDisclosure } from "./ToolsDisclosure";
import { GRP, PILL_ACCENT, ROW } from "./ui";

export function GithubDetail({ c, onChanged }: DetailProps) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div data-testid="github-pat-detail">
      <div className="flex items-center gap-3.5 mb-5">
        <ConnectorBadge connector={c} size={44} title="GitHub" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[20px] font-semibold tracking-tight leading-tight">
            GitHub
          </h2>
          <div className="text-[12.5px] text-muted flex items-center gap-1.5">
            {c.connected ? (
              <>
                <span className="w-2 h-2 rounded-full bg-ok" />
                <span data-testid="github-mode-badge">
                  {t("Connected · personal access token")}
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
            onClick={async () => {
              setBusy(true);
              await disconnectConnector("github");
              setBusy(false);
              onChanged();
            }}
          >
            {busy ? t("Disconnecting…") : t("Disconnect")}
          </button>
        ) : (
          <button
            className={PILL_ACCENT}
            data-testid="add-installation-btn"
            onClick={() => setAdding(true)}
          >
            {t("Connect")}
          </button>
        )}
      </div>

      {!c.connected && (
        <div className={GRP}>
          <div className={ROW + " text-[12.5px] text-muted"}>
            {t("Connect a personal access token scoped to the repositories OpenLoop may use.")}
          </div>
        </div>
      )}

      <ToolsDisclosure c={c} onChanged={onChanged} />

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
