// The Settings provider gallery (spec §Settings Gallery). Two complete rows by
// default with a quiet expand control; press-and-drag reordering that never
// steals a plain click; A/B stable swap with a two-card FLIP; keyboard
// reordering; and a polite live region. Onboarding reuses the plain fixed grid
// via the same component so the two surfaces cannot drift.
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useI18n } from "../i18n";
import {
  ProviderMark,
  relTime,
  type ProviderSetupState,
} from "./ProviderSetup";
import type { ProviderInfo } from "../api";

const DRAG_THRESHOLD = 6; // px of Euclidean travel before a press becomes a drag
const FLIP_MS = 180;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Read the grid's actual rendered column count from its computed template. */
function readColumns(grid: HTMLElement | null): number {
  if (!grid) return 1;
  const template = getComputedStyle(grid).gridTemplateColumns;
  const count = template.split(" ").filter(Boolean).length;
  return count > 0 ? count : 1;
}

type CardProps = {
  provider: ProviderInfo;
  tp: string;
  lastUsed: boolean;
  keylessRunning: boolean;
  draggable: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onPointerDown: (
    providerId: string,
    e: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onOpen: (providerId: string) => void;
  onKeyDown: (
    providerId: string,
    e: React.KeyboardEvent<HTMLButtonElement>,
  ) => void;
  renderObserver?: (providerId: string) => void;
};

// Memoized so an A/B swap re-renders only the two cards whose props change; the
// rest keep their identity, icon, and render state (spec §A/B Stable Swap).
const ProviderCard = memo(function ProviderCard({
  provider,
  tp,
  lastUsed,
  keylessRunning,
  draggable,
  dragging,
  dropTarget,
  onPointerDown,
  onOpen,
  onKeyDown,
  renderObserver,
}: CardProps) {
  const { t } = useI18n();
  renderObserver?.(provider.name);
  const base =
    "flex items-center gap-2.5 rounded-xl border bg-panel px-3 py-2.5 text-left transition-colors w-full";
  const border = dropTarget
    ? "border-ink"
    : "border-line hover:border-lineStrong";
  let status;
  if (provider.configured && provider.needs_key) {
    const used = lastUsed ? relTime(provider.last_used_at, t) : null;
    status = (
      <span className="block text-[11.5px] text-ok font-medium truncate">
        {t("✓ Connected")}
        {used ? (
          <span className="text-muted font-normal">
            {t(" · used {{time}}", { time: used })}
          </span>
        ) : null}
      </span>
    );
  } else if (!provider.needs_key) {
    status = (
      <span className="block text-[11.5px] text-faint truncate">
        {keylessRunning ? (
          <span className="text-ok font-medium">{t("✓ Running")}</span>
        ) : (
          t("No key needed")
        )}
      </span>
    );
  } else {
    status = (
      <span className="block text-[11.5px] text-faint truncate">
        {t("Not set up")}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${base} ${border}`}
      data-testid={`${tp}-provider-${provider.name}`}
      data-provider={provider.name}
      data-dragging={dragging ? "true" : undefined}
      data-drop-target={dropTarget ? "true" : undefined}
      style={dragging ? { opacity: 0.35, touchAction: "none" } : { touchAction: draggable ? "none" : undefined }}
      onPointerDown={(e) => onPointerDown(provider.name, e)}
      onClick={() => onOpen(provider.name)}
      onKeyDown={(e) => onKeyDown(provider.name, e)}
    >
      <ProviderMark name={provider.name} title={provider.title} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold leading-tight truncate">
          {provider.title}
        </span>
        {status}
      </span>
      <span className="text-faint text-[14px]" data-testid={`${tp}-chevron-${provider.name}`}>
        ›
      </span>
    </button>
  );
});

type DragState = {
  pointerId: number;
  name: string;
  startX: number;
  startY: number;
  active: boolean; // crossed the 6px threshold
  ghostX: number;
  ghostY: number;
  target: string | null;
};

export function ProviderGallery({
  ps,
  tp,
  surface,
  lastUsed = false,
  resolveColumns,
  expanded: controlledExpanded,
  onExpandedChange,
  renderObserver,
}: {
  ps: ProviderSetupState;
  tp: string;
  surface: "settings" | "onboarding";
  lastUsed?: boolean;
  // Test seam: jsdom has no layout, so column count can be injected. Production
  // reads the real rendered template through a ResizeObserver.
  resolveColumns?: () => number;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  renderObserver?: (providerId: string) => void;
}) {
  const { t } = useI18n();
  const settings = surface === "settings";
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(() => (resolveColumns ? resolveColumns() : 1));
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [announce, setAnnounce] = useState("");
  // One-shot flag: a drag that crossed the threshold suppresses exactly the next
  // synthetic click on that card (spec §Click and Drag Disambiguation).
  const suppressClickRef = useRef(false);
  const psRef = useRef(ps);
  psRef.current = ps;
  const orderRef = useRef<string[]>([]);
  orderRef.current = ps.ordered.map((provider) => provider.name);

  // Track the real column count off the rendered grid (or the injected seam).
  useLayoutEffect(() => {
    const measure = () => setColumns(resolveColumns ? resolveColumns() : readColumns(gridRef.current));
    measure();
    if (!gridRef.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(gridRef.current);
    return () => ro.disconnect();
  }, [resolveColumns]);

  const all = ps.ordered;
  const visibleCount = Math.max(columns * 2, 1);
  const overflow = settings && all.length > visibleCount;
  const visible = settings && !expanded && overflow ? all.slice(0, visibleCount) : all;
  const viewRef = useRef({ columns, expanded, overflow, visibleCount });
  viewRef.current = { columns, expanded, overflow, visibleCount };
  const toggleExpanded = useCallback(() => {
    const next = !expanded;
    if (controlledExpanded === undefined) setLocalExpanded(next);
    onExpandedChange?.(next);
  }, [controlledExpanded, expanded, onExpandedChange]);

  // Surface the save-queue notice as a polite announcement.
  useEffect(() => {
    const notice = ps.providerOrder?.notice ?? null;
    if (!notice) return;
    const message =
      notice === "missing-provider"
        ? t("A provider in your reorder no longer exists; that change was skipped.")
        : notice === "unknown"
          ? t("Your earlier reorder could not be confirmed.")
          : t("Could not save the provider order.");
    setAnnounce(message);
    psRef.current.clearProviderOrderNotice();
  }, [ps.providerOrder?.notice, t]);

  const swap = useCallback(
    (a: string, b: string) => {
      if (!a || !b || a === b) return;
      const aIndex = orderRef.current.indexOf(a);
      const bIndex = orderRef.current.indexOf(b);
      if (aIndex < 0 || bIndex < 0) return;
      const next = [...orderRef.current];
      [next[aIndex], next[bIndex]] = [next[bIndex], next[aIndex]];
      orderRef.current = next;
      psRef.current.swapProviders(a, b);
    },
    [],
  );

  // FLIP: capture the two cards' old rectangles, let React reorder, then animate
  // only those two from old→new. Reduced motion skips straight to the new layout.
  const flipRef = useRef<Map<string, DOMRect>>(new Map());
  const flipPair = useRef<[string, string] | null>(null);
  const captureFlip = useCallback((a: string, b: string) => {
    if (prefersReducedMotion() || !gridRef.current) return;
    const rects = new Map<string, DOMRect>();
    for (const name of [a, b]) {
      const el = gridRef.current.querySelector<HTMLElement>(`[data-provider="${name}"]`);
      if (el) rects.set(name, el.getBoundingClientRect());
    }
    flipRef.current = rects;
    flipPair.current = [a, b];
  }, []);

  useLayoutEffect(() => {
    const pair = flipPair.current;
    if (!pair || !gridRef.current) return;
    flipPair.current = null;
    for (const name of pair) {
      const el = gridRef.current.querySelector<HTMLElement>(`[data-provider="${name}"]`);
      const prev = flipRef.current.get(name);
      if (!el || !prev) continue;
      const next = el.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (dx === 0 && dy === 0) continue;
      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0, 0)" },
        ],
        { duration: FLIP_MS, easing: "ease-out" },
      );
    }
  });

  // Window-level pointer tracking keeps a drag alive outside the source card and
  // lets the card under the pointer become the drop target via event.target.
  useEffect(() => {
    const pointerId = drag?.pointerId;
    if (pointerId == null) return;
    const onMove = (e: PointerEvent) => {
      const current = dragRef.current;
      if (!current || e.pointerId !== current.pointerId) return;
      const dist = Math.hypot(
        e.clientX - current.startX,
        e.clientY - current.startY,
      );
      const hit =
        typeof document.elementFromPoint === "function"
          ? document.elementFromPoint(e.clientX, e.clientY)
          : (e.target as Element | null);
      const target = hit?.closest?.("[data-provider]") as HTMLElement | null;
      const targetName = target?.getAttribute("data-provider") || null;
      const next = {
        ...current,
        active: current.active || dist >= DRAG_THRESHOLD,
        ghostX: e.clientX,
        ghostY: e.clientY,
        target:
          targetName && targetName !== current.name ? targetName : null,
      };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = (e: PointerEvent) => {
      const current = dragRef.current;
      if (!current || e.pointerId !== current.pointerId) return;
      dragRef.current = null;
      setDrag(null);
      if (current.active) {
        suppressClickRef.current = true;
        if (current.target) {
          captureFlip(current.name, current.target);
          swap(current.name, current.target);
        }
        // Clear the one-shot suppression after this pointer sequence if no
        // synthetic click consumed it.
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    };
    const onCancel = (e: PointerEvent) => {
      const current = dragRef.current;
      if (!current || e.pointerId !== current.pointerId) return;
      // A canceled drag never reorders and never swallows the next independent
      // click; only suppress if it had already engaged.
      dragRef.current = null;
      setDrag(null);
      if (current.active) {
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [drag?.pointerId, swap, captureFlip]);

  const onPointerDown = useCallback(
    (name: string, e: ReactPointerEvent<HTMLButtonElement>) => {
      if (!settings || (e.button ?? 0) !== 0) return;
      // A new independent pointer sequence must not inherit suppression from a
      // canceled drag. The synthetic click for a completed drag has no new
      // pointerdown, so it remains correctly suppressed.
      suppressClickRef.current = false;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const next = {
        pointerId: e.pointerId,
        name,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        ghostX: e.clientX,
        ghostY: e.clientY,
        target: null,
      };
      dragRef.current = next;
      setDrag(next);
    },
    [settings],
  );

  const onCardClick = useCallback(
    (name: string) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      psRef.current.openProvider(name);
    },
    [],
  );

  const onCardKeyDown = useCallback(
    (name: string, e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (settings && e.altKey && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const currentPs = psRef.current;
        const view = viewRef.current;
        const order = [...orderRef.current];
        const i = order.indexOf(name);
        if (i < 0) return;
        let j = -1;
        if (e.key === "ArrowLeft") j = i - 1;
        else if (e.key === "ArrowRight") j = i + 1;
        else if (e.key === "ArrowUp") j = i - view.columns;
        else if (e.key === "ArrowDown") j = i + view.columns;
        const limit =
          view.expanded || !view.overflow ? order.length : view.visibleCount;
        if (j < 0 || j >= Math.min(order.length, limit)) return;
        captureFlip(name, order[j]);
        swap(name, order[j]);
        setAnnounce(
          t("Moved {{provider}} to position {{index}}.", {
            provider:
              currentPs.providers.find((provider) => provider.name === name)
                ?.title || name,
            index: j + 1,
          }),
        );
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        psRef.current.openProvider(name);
      }
    },
    [settings, swap, captureFlip, t],
  );

  const gridClass =
    surface === "settings"
      ? "grid grid-cols-2 xl:grid-cols-3 gap-2.5"
      : "grid grid-cols-2 gap-2.5";

  return (
    <div>
      <div ref={gridRef} className={gridClass}>
        {visible.map((p) => (
          <ProviderCard
            key={p.name}
            provider={p}
            tp={tp}
            lastUsed={lastUsed}
            keylessRunning={ps.keylessOk.has(p.name)}
            draggable={settings}
            dragging={settings && drag?.active === true && drag.name === p.name}
            dropTarget={settings && drag?.active === true && drag.target === p.name}
            onPointerDown={onPointerDown}
            onOpen={onCardClick}
            onKeyDown={onCardKeyDown}
            renderObserver={renderObserver}
          />
        ))}
      </div>

      {overflow && (
        <div className="mt-2.5 text-center">
          <button
            type="button"
            className="text-[12.5px] text-muted hover:text-ink"
            data-testid={`${tp}-expand-providers`}
            onClick={toggleExpanded}
          >
            {expanded ? t("Show less") : t("Show all {{count}}", { count: all.length })}
          </button>
        </div>
      )}

      {settings && (
        <div
          aria-live="polite"
          className="sr-only"
          data-testid={`${tp}-order-live`}
        >
          {announce}
        </div>
      )}

      {settings && drag?.active === true && (
        <DragGhost provider={all.find((p) => p.name === drag.name)} x={drag.ghostX} y={drag.ghostY} />
      )}
    </div>
  );
}

/** A fixed-layer ghost that follows the pointer while dragging (spec §A/B Stable
 * Swap). DOM order of the real cards never changes during the move. */
function DragGhost({ provider, x, y }: { provider?: ProviderInfo; x: number; y: number }) {
  if (!provider) return null;
  return (
    <div
      className="fixed z-50 pointer-events-none flex items-center gap-2.5 rounded-xl border border-ink bg-panel px-3 py-2.5 shadow-lg opacity-90"
      style={{ left: x + 12, top: y + 12, width: 220 }}
    >
      <ProviderMark name={provider.name} title={provider.title} />
      <span className="block text-[13px] font-semibold leading-tight truncate">
        {provider.title}
      </span>
    </div>
  );
}
