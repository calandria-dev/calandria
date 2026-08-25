"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { LS, loadPersist } from "./persist";
import { reconcileHistory, closeOneLevel, type NavSel } from "./navHistory";
import {
  DEFAULT_APPEARANCE, DEFAULT_SETTINGS, DEFAULT_LAYOUT, TEXT_WIDTH, MONO_FONTS, PROMPT_FONTS,
  type Appearance, type Settings, type Layout, type View, type TaskView,
} from "./types";

// Legacy (pre-rebrand) persisted shape: a binary theme instead of palette+mode.
type LegacyAppearance = { theme?: "light" | "dark" };

// Migrates a persisted `appearance` blob — of any vintage — onto the current
// Appearance shape. Missing fields fall back to DEFAULT_APPEARANCE; the old
// `theme: "light"|"dark"` field (no palette concept existed yet) becomes
// palette "cherenkov" (the only palette that used to exist) + that mode.
function migrateAppearance(persisted: Partial<Appearance> & LegacyAppearance): Appearance {
  const { theme, ...rest } = persisted;
  const migrated: Appearance = { ...DEFAULT_APPEARANCE, ...rest };
  if (theme && !persisted.mode) migrated.mode = theme;
  return migrated;
}

// Resolves "system" against the OS preference; defaults to dark before the
// media query can be read (SSR / first paint).
function resolveMode(mode: Appearance["mode"]): "light" | "dark" {
  if (mode !== "system") return mode;
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Mirror of Orchestrator's mobile breakpoint — the Back-button trap only arms on
// mobile (single-pane), since on desktop every column is visible and Back should
// not be hijacked to close a panel.
const MOBILE_QUERY = "(max-width: 760px)";

// Owns the cosmetic/client-only preferences (appearance, settings, layout) and the
// active work-area view, plus the hydrate-once + persist/URL-sync effects. The
// open project/task are passed in so they get mirrored into localStorage + URL
// alongside the prefs (URL keeps a refresh landing where you were). The setters
// are passed in so the Back button (popstate) can close one pane level — on
// mobile this is the only way to step session → tasks → projects (and project
// home → tasks, the level the Runbooks/Schedules pane adds).
export function usePrefs({ selProj, selTask, projectHome, urlSelRef, setSelProj, setSelTask, setProjectHome }: {
  selProj: string | null;
  selTask: string | null;
  /** The project home pane is showing — its own Back level (see navHistory). */
  projectHome: boolean;
  urlSelRef: MutableRefObject<{ project?: string; task?: string; view?: string; home?: boolean } | null>;
  setSelProj: (id: string | null) => void;
  setSelTask: (id: string | null) => void;
  setProjectHome: (on: boolean) => void;
}) {
  const [view, setView] = useState<View>("workspace");
  const [taskView, setTaskView] = useState<TaskView>("list");
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [hydrated, setHydrated] = useState(false);

  // Latest selection, read by the once-attached popstate handler without
  // re-subscribing. Updated every render (cheap, and refs are render-safe here).
  const selRef = useRef<NavSel>({ proj: selProj, task: selTask, home: projectHome, view });
  selRef.current = { proj: selProj, task: selTask, home: projectHome, view };

  // hydrate persisted prefs once
  useEffect(() => {
    const p = loadPersist();
    if (p.appearance) setAppearance(migrateAppearance(p.appearance));
    if (p.settings) setSettings({ ...DEFAULT_SETTINGS, ...p.settings });
    if (p.layout) setLayout({ ...DEFAULT_LAYOUT, ...p.layout });
    if (p.taskView === "board") setTaskView("board");
    const urlView = urlSelRef.current?.view;
    if (urlView === "settings" || urlView === "insights") setView(urlView);
    setHydrated(true);
  }, [urlSelRef]);

  // persist + apply appearance
  useEffect(() => {
    if (!hydrated) return;

    const applyTheme = () => {
      const resolved = resolveMode(appearance.mode);
      document.documentElement.setAttribute("data-theme", `${appearance.palette}-${resolved}`);
      document.documentElement.setAttribute("data-mode", resolved);
      document.documentElement.style.setProperty("--density", appearance.density);
      document.documentElement.style.setProperty("--text-width", appearance.wide === "1" ? TEXT_WIDTH.full : TEXT_WIDTH.reading);
      const mono = MONO_FONTS[appearance.monoFont] ?? MONO_FONTS["jetbrains-mono"];
      document.documentElement.style.setProperty("--mono", mono.cssFamily);
      document.documentElement.style.setProperty("--font-mono", mono.cssFamily);
      const prompt = PROMPT_FONTS[appearance.promptFont] ?? PROMPT_FONTS["source-sans"];
      document.documentElement.style.setProperty("--font-prompt", prompt.cssFamily);
    };
    applyTheme();

    localStorage.setItem(LS, JSON.stringify({ selProj, selTask, appearance, settings, layout, taskView }));

    // Mirror the open project/task + active view into the URL (refresh-restore)
    // and, on mobile, keep a single Back-trap entry on top while a pane is open
    // so the device Back button steps session → tasks → projects. (See navHistory.)
    const armTrap = window.matchMedia(MOBILE_QUERY).matches;
    reconcileHistory(window.history, window.location.pathname, { proj: selProj, task: selTask, home: projectHome, view }, armTrap);

    // "system" mode tracks the OS live — re-resolve dark/light on every flip
    // without waiting for the user to touch a setting.
    if (appearance.mode !== "system" || typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", applyTheme);
    return () => mq.removeEventListener("change", applyTheme);
  }, [appearance, settings, layout, taskView, selProj, selTask, projectHome, view, hydrated]);

  // Back button: consume the trap and close exactly one pane level. The setState
  // calls re-run the persist effect, which re-arms the trap if a pane is still
  // open (pushState fires no popstate, so no loop). Driving off the live
  // selection — not the popped URL — makes this immune to the task list churning
  // selTask, which would otherwise leave stale duplicate history entries.
  useEffect(() => {
    const onPop = () => {
      const next = closeOneLevel(selRef.current);
      setSelProj(next.proj);
      setSelTask(next.task);
      setProjectHome(next.home);
      setView(next.view);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [setSelProj, setSelTask, setProjectHome]);

  const setAppearanceKey = (k: keyof Appearance, v: string) => setAppearance((a) => ({ ...a, [k]: v }));
  const setSetting = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  return { view, setView, taskView, setTaskView, appearance, setAppearance: setAppearanceKey, settings, setSetting, setSettings, layout, setLayout, hydrated };
}
