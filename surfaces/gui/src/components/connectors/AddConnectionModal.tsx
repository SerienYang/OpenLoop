import { useEffect } from "react";
import type { Connector } from "../../api";
import { ConnectorBadge } from "../../connectors/ConnectorIcon";
import { useI18n } from "../../i18n";
import { ConnectSetup } from "../ManageTabs";

export function AddConnectionModal({
  c,
  title,
  onClose,
  onChanged,
}: {
  c: Connector;
  title?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40" data-testid="add-connection-modal">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        className="absolute left-1/2 top-[14%] -translate-x-1/2 w-[480px] max-w-[calc(100vw-2rem)] bg-panel rounded-2xl border border-line shadow-2xl"
        role="dialog"
        aria-label={title || t("Connect {{title}}", { title: c.title })}
      >
        <div className="flex items-center gap-3 px-5 pt-5">
          <ConnectorBadge connector={c} size={34} title={c.title} />
          <div className="flex-1 font-semibold text-[16px] tracking-tight">
            {title || t("Connect {{title}}", { title: c.title })}
          </div>
          <button
            className="text-faint hover:text-ink text-[18px] leading-none"
            onClick={onClose}
            title={t("Close")}
          >
            ×
          </button>
        </div>
        <div className="px-1.5 pb-2">
          <ConnectSetup
            c={c}
            onConnected={() => {
              onChanged();
              onClose();
            }}
          />
        </div>
      </div>
    </div>
  );
}
