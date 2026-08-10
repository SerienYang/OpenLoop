import { useState } from "react";
import { type Connector } from "../../api";
import { ConnectorBadge } from "../../connectors/ConnectorIcon";
import { AddConnectionModal } from "./AddConnectionModal";
import { FOOT, GRP, GRP_H, PILL_ACCENT, ROW, TAG_QUIET } from "./ui";
import { translateDynamic, useI18n } from "../../i18n";

// Pre-connect detail page (UX-DECISIONS §38): what a connector is for and what
// access it gets, BEFORE any credentials exist. About paragraph, honest Access
// bullets, and the tool list behind a collapsed disclosure (advanced-reader
// detail — no enable/disable pre-connect; that lever lives on the connected
// page). Connect opens the same add-connection modal as the list's pill.

export function AvailableDetail({
  c,
  onChanged,
}: {
  c: Connector;
  onChanged: () => void;
}) {
  const { lang, t } = useI18n();
  const [connecting, setConnecting] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const tools = c.tools || [];
  const access =
    lang === "zh-CN"
      ? [
          t("Access is limited by the connected account's permissions."),
          ...(tools.some((tool) => tool.kind === "read")
            ? [t("Read operations can run directly.")]
            : []),
          ...(tools.some((tool) => tool.kind !== "read")
            ? [t("Write operations ask for approval before they run.")]
            : []),
        ]
      : c.access || [];

  return (
    <div data-testid="available-detail">
      <div className="flex items-center gap-3.5 mb-5">
        <ConnectorBadge connector={c} size={44} title={c.title} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[20px] font-semibold tracking-tight leading-tight">{c.title}</h2>
          <div className="text-[12.5px] text-muted">
            {translateDynamic(
              c.blurb,
              lang,
              t("Connect and use {{title}}.", { title: c.title }),
            )}
          </div>
        </div>
        <button
          className={PILL_ACCENT}
          data-testid="available-connect"
          onClick={() => setConnecting(true)}
        >
          {t("Connect")}
        </button>
      </div>

      {c.about && (
        <p className="text-[13px] text-ink/90 leading-relaxed mb-1 px-0.5">
          {translateDynamic(
            c.about,
            lang,
            t(
              "After connecting {{title}}, its supported content and actions are available in OpenLoop.",
              { title: c.title },
            ),
          )}
        </p>
      )}

      {access.length > 0 && (
        <>
          <div className={GRP_H}>{t("Access")}</div>
          <div className={GRP} data-testid="available-access">
            {access.map((line) => (
              <div key={line} className={ROW + " !min-h-[36px] !py-2 text-[13px]"}>
                {line}
              </div>
            ))}
          </div>
          <div className={FOOT}>
            {t("Keys and tokens are stored only on this computer. Disconnect anytime.")}
          </div>
        </>
      )}

      {tools.length > 0 && (
        <>
          <div className={GRP_H}>{t("Tools")}</div>
          <div className={GRP}>
            <button
              className={ROW + " w-full text-left hover:bg-paper/60 text-[13px]"}
              data-testid="available-tools-toggle"
              onClick={() => setShowTools((v) => !v)}
            >
              <span className="min-w-0 flex-1 text-muted">
                {tools.length === 1
                  ? t("{{count}} tool this connector adds", { count: tools.length })
                  : t("{{count}} tools this connector adds", { count: tools.length })}
              </span>
              <span className="text-faint text-[13px] shrink-0">{showTools ? t("Hide") : t("View")}</span>
            </button>
            {showTools &&
              tools.map((tool) => (
                <div key={tool.name} className={ROW + " !min-h-[38px]"}>
                  <span className="min-w-0 flex-1">
                    <span className="text-[13px]">
                      {translateDynamic(tool.label, lang, tool.name)}
                    </span>
                    <span className="block text-[12px] text-muted">
                      {translateDynamic(
                        tool.description,
                        lang,
                        tool.kind === "read"
                          ? t("Read data from the connected service.")
                          : t("Change data in the connected service after approval."),
                      )}
                    </span>
                  </span>
                  {tool.kind !== "read" && <span className={TAG_QUIET}>{t("asks first")}</span>}
                </div>
              ))}
          </div>
        </>
      )}

      {connecting && (
        <AddConnectionModal
          c={c}
          onClose={() => setConnecting(false)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}
