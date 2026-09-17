"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { jget, jsend } from "./api";
import { isDesktopShell } from "./useNotifications";
import { updateTargets, type UpdateTarget } from "./updateTargets";
import type { DesktopUpdateDetail, UpdateState } from "@/lib/updates/types";

/** The version the desktop shell puts in its user agent. */
const SHELL_VERSION = /\bCalandria-Desktop\/(\d+\.\d+\.\d+)/;

export type ShellInfo = { kind: "desktop" | "browser"; version: string | null };

export type Updates = {
  state: UpdateState | null;
  desktop: DesktopUpdateDetail | null;
  shell: ShellInfo;
  targets: UpdateTarget[];
  loading: boolean;
  checking: boolean;
  reload: () => Promise<void>;
  checkNow: () => Promise<void>;
  install: () => void;
  skip: () => Promise<void>;
  unskip: () => Promise<void>;
};

function readShell(): ShellInfo {
  if (typeof navigator === "undefined") return { kind: "browser", version: null };
  const ua = navigator.userAgent;
  return { kind: isDesktopShell(ua) ? "desktop" : "browser", version: SHELL_VERSION.exec(ua)?.[1] ?? null };
}

/**
 * The update pill's whole model: what the server found, what the desktop
 * updater is doing, and which shell the page is in.
 *
 * The server is the only thing that talks to github.com, so this reads
 * GET /api/updates and nothing else. It refetches on `calandria:updates`,
 * which useGlobalEvents raises from the `updates_changed` wire event, so a
 * check finishing or a skip in another tab reaches every open window.
 *
 * The desktop half arrives as `calandria:desktop-update`, pushed into the page
 * by the Electron main process (desktop/main.js). There is no preload and no
 * IPC, so requests back go out as `calandria-desktop:` URLs that main
 * intercepts in its navigation hooks.
 */
export function useUpdates(): Updates {
  const [state, setState] = useState<UpdateState | null>(null);
  const [desktop, setDesktop] = useState<DesktopUpdateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const shell = useMemo(readShell, []);

  const reload = useCallback(async () => {
    try {
      setState(await jget<UpdateState>("/api/updates"));
    } catch {
      // The pill is not worth an error banner: it reappears on the next event.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onChanged = () => void reload();
    window.addEventListener("calandria:updates", onChanged);
    return () => window.removeEventListener("calandria:updates", onChanged);
  }, [reload]);

  useEffect(() => {
    const onDesktop = (e: Event) => setDesktop((e as CustomEvent<DesktopUpdateDetail>).detail);
    window.addEventListener("calandria:desktop-update", onDesktop);
    return () => window.removeEventListener("calandria:desktop-update", onDesktop);
  }, []);

  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      setState(await jsend<UpdateState>("/api/updates/check", "POST"));
      // The shell has its own feed and its own cadence, so ask it too.
      if (shell.kind === "desktop") window.open("calandria-desktop://update/check");
    } catch {
      // Same reason as reload: the state already carries the last error.
    } finally {
      setChecking(false);
    }
  }, [shell.kind]);

  const install = useCallback(() => {
    window.open("calandria-desktop://update/install");
  }, []);

  const patch = useCallback(
    async (value: string) => {
      await jsend("/api/settings", "PATCH", { update_dismissed: value });
      await reload();
    },
    [reload],
  );

  const skip = useCallback(async () => {
    if (state?.latest) await patch(state.latest.version);
  }, [patch, state?.latest]);

  const unskip = useCallback(() => patch(""), [patch]);

  const targets = useMemo(() => updateTargets({ server: state, desktop, shell }), [state, desktop, shell]);

  return { state, desktop, shell, targets, loading, checking, reload, checkNow, install, skip, unskip };
}
