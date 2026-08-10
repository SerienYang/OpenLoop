import { Icon } from "./Icon";
import { useI18n } from "../i18n";

// Empty-state for a fresh OpenLoop session: the Composer is the only action surface.

export function SessionIntro(_props: {
  sessionId?: string;
  onOpenSessionSettings?: () => void;
  onPrefill?: (text: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="intro">
      <div className="intro-head">
        <h1 className="greeting">
          <span className="intro-title-logo" aria-hidden="true">
            <Icon name="logo" size={42} />
          </span>
          <span>{t("What should OpenLoop move forward today?")}</span>
        </h1>
      </div>
    </div>
  );
}
