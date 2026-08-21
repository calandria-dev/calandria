"use client";

import { useCallback } from "react";
import type { MutableRefObject } from "react";
import type { NotificationPayload } from "@/lib/notifications/types";

/**
 * The one client-side suppression, kept pure so it can be pinned by a test.
 *
 * The server already decided this is worth interrupting somebody for; the
 * browser knows exactly one thing the server cannot, which is whether the user
 * is looking at the very task being announced. Everything else — a background
 * tab, another task selected, a second monitor — is a case where a toast is the
 * whole point, so the rule is deliberately narrow rather than "notify only when
 * the tab is hidden".
 */
export function shouldDisplay(
  payload: NotificationPayload,
  ctx: { visible: boolean; selectedTaskId: string | null },
): boolean {
  if (!payload.taskId) return true; // a test send belongs to no task
  return !(ctx.visible && ctx.selectedTaskId === payload.taskId);
}

/** Is this browser able to show a notification right now? */
export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/**
 * The browser channel. Renders a payload the SERVER composed — the wording, the
 * suppression rules and the dedupe all happened before this hook saw it, so a
 * webhook delivering the same payload says the same thing.
 */
export function useNotifications({ selTaskRef }: { selTaskRef: MutableRefObject<string | null> }) {
  // The ref object is stable, so the returned callback is too — which is what
  // keeps useGlobalEvents from re-subscribing its EventSource on every render.
  return useCallback((payload: NotificationPayload) => {
    if (notificationPermission() !== "granted") return;
    if (!shouldDisplay(payload, {
      visible: document.visibilityState === "visible",
      selectedTaskId: selTaskRef.current,
    })) return;
    try {
      // `tag` is the payload id — stable per (kind, task) — so a second
      // notification about the same task replaces the first rather than
      // stacking toasts on a screen nobody is watching.
      const n = new Notification(payload.title, { body: payload.body, tag: payload.id });
      n.onclick = () => {
        window.focus();
        n.close();
        if (!payload.taskId) return;
        // Routed through a window event rather than a callback prop: this hook
        // is wired before goToTask exists in useOrchestrator, and the app
        // already uses this pattern for cross-cutting facts (orch:runbooks).
        window.dispatchEvent(new CustomEvent("orch:goto-task", {
          detail: { projectId: payload.projectId, taskId: payload.taskId },
        }));
      };
    } catch {
      // Some browsers throw on construction (notably iOS Safari outside a
      // service worker). A failed toast must never break the event stream.
    }
  }, [selTaskRef]);
}
