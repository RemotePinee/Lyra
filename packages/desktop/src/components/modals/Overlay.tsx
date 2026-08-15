import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/** Shared shell for the app's floating panels: click-outside, Escape, and a centred card. */
export function Overlay({
  children,
  onClose,
  align = "center",
  width = 460,
}: {
  children: React.ReactNode;
  onClose: () => void;
  align?: "center" | "bottom";
  width?: number;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /*
   * Rendered at the document root.
   *
   * `position: fixed` is relative to the nearest ancestor that established a containing block,
   * and `backdrop-filter` establishes one — so an overlay opened from inside a glass popover
   * was positioned and clipped by that popover instead of covering the window. A portal puts
   * it where it means to be, whoever opened it.
   */
  return createPortal(
    <div
      className={`fixed inset-0 z-[60] flex justify-center bg-black/35 px-4 sm:px-8 ${
        align === "center" ? "items-center" : "items-end pb-[120px]"
      }`}
      onMouseDown={(event) => {
        if (!cardRef.current?.contains(event.target as Node)) onClose();
      }}
    >
      <div
        ref={cardRef}
        // The width is a preference, not a promise — a 460px card does not fit a 380px window.
        style={{ width, maxWidth: "100%" }}
        className="ly-enter max-h-[80vh] overflow-hidden rounded-[14px] border border-line bg-float shadow-2xl shadow-black/50"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
