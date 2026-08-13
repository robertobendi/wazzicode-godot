import { useEffect, useState, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api } from "@/api";
import { useAttachmentsStore } from "@/stores/useAttachmentsStore";

/**
 * OS file drag-and-drop over the chat column.
 *
 * With Tauri's native drag-drop, the OS file drop never reaches HTML5 `ondrop`
 * — it surfaces as `tauri://drag-drop` window events carrying the real paths.
 * We listen globally and hit-test the drop position (physical px) against
 * `regionRef`'s rect (CSS px) so only drops over the chat column are staged.
 *
 * Dropped files are staged into the project inbox and added as pending
 * attachments. Returns `dragActive` for a "drop here" overlay.
 */
export function useResourceDnd(
  project: string | null,
  regionRef: RefObject<HTMLElement | null>,
): boolean {
  const [dragActive, setDragActive] = useState(false);
  const add = useAttachmentsStore((s) => s.add);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    const inside = (pos?: { x: number; y: number }): boolean => {
      const el = regionRef.current;
      if (!el || !pos) return false;
      const dpr = window.devicePixelRatio || 1;
      const x = pos.x / dpr;
      const y = pos.y / dpr;
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload as {
          type: string;
          position?: { x: number; y: number };
          paths?: string[];
        };
        if (p.type === "drop") {
          setDragActive(false);
          if (project && inside(p.position) && p.paths?.length) {
            void api
              .stagePaths(project, p.paths)
              .then((staged) => add(staged))
              .catch(() => {
                // Staging failed (missing file / over cap); surfaced elsewhere.
              });
          }
        } else if (p.type === "over" || p.type === "enter") {
          setDragActive(!!project && inside(p.position));
        } else {
          setDragActive(false);
        }
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [project, regionRef, add]);

  return dragActive;
}
