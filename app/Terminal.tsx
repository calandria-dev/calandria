"use client";

import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import type { Terminal as XTerm, ITheme } from "@xterm/xterm";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";
import { recordLifecycleEvent } from "./shell/useLifecycleDiagnostics";

// How long a socket may sit at CONNECTING before the shell is called dead.
// WebKit bug 308073 (iOS 26.x): after the page has been in the background for
// more than about 10 seconds, Safari closes the page's WebSocket and every
// later `new WebSocket()` hangs at CONNECTING until the page is reloaded. That
// state fires no error and no close, so without a deadline the terminal shows
// an empty pane forever with nothing to act on.
const WS_OPEN_TIMEOUT_MS = 8_000;

// Reads a CSS custom property's resolved value off <html>.
function cssVar(name: string, fallback = ""): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Resolves a color-mix()/var() expression to a literal computed color: xterm's
// theme fields need concrete values, not CSS custom properties. Browsers resolve
// color-mix() at computed-style time, so a throwaway probe element gets the
// literal color for whatever palette/mode is active without hand-maintaining a
// theme object per [data-theme] combination.
function resolveColor(expr: string, fallback = ""): string {
  if (typeof document === "undefined") return fallback;
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;color:${expr}`;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  return resolved || fallback;
}

// Builds an xterm theme from the current design-system tokens (globals.css).
// Read fresh whenever the palette or mode changes, since xterm themes are
// literal-color objects, not CSS that re-resolves on its own.
function buildXtermTheme(): ITheme {
  return {
    background: cssVar("--term", "#15140f"),
    foreground: cssVar("--ink", "#d5e4ea"),
    cursor: cssVar("--accent", "#45cabb"),
    selectionBackground: resolveColor("color-mix(in oklab, var(--accent) 30%, var(--term))", "#2b4a47"),
    black: cssVar("--term", "#15140f"),
    brightBlack: resolveColor("color-mix(in oklab, var(--dim) 65%, var(--term))", "#5e594e"),
    red: cssVar("--err", "#e0687a"),
    green: cssVar("--run", "#4ecfb2"),
    yellow: cssVar("--warn", "#d3b054"),
    blue: cssVar("--s1", "#5f8dff"),
    magenta: cssVar("--s4", "#9d7bff"),
    cyan: resolveColor("color-mix(in oklab, var(--s1) 50%, var(--run))", "#5fb0c9"),
    white: cssVar("--ink", "#d5e4ea"),
    brightWhite: resolveColor("color-mix(in oklab, var(--ink) 55%, white)", "#fbfaf6"),
  };
}

// Imperative handle the mobile terminal sheet uses to feed input (paste, Enter,
// Ctrl-C buttons) without owning the websocket itself.
export interface TermApi { send: (data: string) => void; }

export function TerminalView({ cwd, port, fontSize = 12.5, monoFontFamily, onReady, onClosed }: { cwd: string; port?: number; fontSize?: number; monoFontFamily?: string; onReady?: (api: TermApi) => void; onClosed?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddonType | null>(null);
  // Bumping this tears down the dead xterm/socket and spawns a fresh shell.
  const [session, setSession] = useState(0);
  // Read the latest font size / mono font at shell-creation time without making
  // them effect deps (which would respawn the shell); live changes apply below.
  const fontRef = useRef(fontSize);
  fontRef.current = fontSize;
  // No monoFontFamily prop wired from a caller yet (Terminal.tsx has two call
  // sites, Shell.tsx's drawer and shell/Layout.tsx's, and neither currently
  // threads prefs through); fall back to the --mono custom property
  // usePrefs.ts sets on <html>, which already tracks the selected mono font.
  const monoRef = useRef(monoFontFamily);
  monoRef.current = monoFontFamily;

  useEffect(() => {
    let term: XTerm | null = null;
    let fit: FitAddonType | null = null;
    let ws: WebSocket | null = null;
    let openTimer: number | null = null;
    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;
    let disposed = false;
    let dead = false; // shell gone (exit or sidecar drop), awaiting Enter to respawn

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      if (disposed || !hostRef.current) return;

      term = new Terminal({
        fontFamily: monoRef.current || cssVar("--mono", "'JetBrains Mono', ui-monospace, monospace"),
        fontSize: fontRef.current,
        lineHeight: 1.25,
        cursorBlink: true,
        scrollback: 8000,
        theme: buildXtermTheme(),
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      // Retheme (and, absent an explicit monoFontFamily prop, refont) live
      // whenever the palette or resolved mode flips. usePrefs.ts writes
      // data-theme/data-mode on <html>, and the --mono custom property when the
      // mono font selection changes.
      mo = new MutationObserver(() => {
        if (!term) return;
        term.options.theme = buildXtermTheme();
        if (!monoRef.current) term.options.fontFamily = cssVar("--mono", term.options.fontFamily as string);
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-mode", "style"] });
      // Tappable links: the mobile terminal's login flow depends on opening the
      // OAuth URL Claude prints, so route clicks/taps to a new tab.
      term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener,noreferrer")));
      term.open(hostRef.current);
      termRef.current = term;
      fitRef.current = fit;
      try { fit.fit(); } catch {}

      // The Next server proxies /pty to the local node-pty sidecar, so one
      // hostname carries both (works behind a tunnel). PUBLIC_BASE_URL (injected
      // by the layout) overrides the origin when the instance's public address
      // differs from what the browser sees; empty = same origin as the app.
      const baseUrl = (window as { __PUBLIC_BASE_URL?: string }).__PUBLIC_BASE_URL || window.location.origin;
      const wsBase = baseUrl.replace(/^http/, "ws");
      const portQ = port && port > 0 ? `&port=${port}` : "";
      const url = `${wsBase}/pty?cwd=${encodeURIComponent(cwd)}&cols=${term.cols}&rows=${term.rows}${portQ}`;
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";

      // A socket that never opens is reported once and the shell is called
      // dead, so Enter retries it the way it does after an ordinary
      // disconnect. A plain timer, not a reconnect loop: on an affected iOS
      // build every retry hangs the same way until the page is reloaded, so
      // retrying on the user's behalf would only hide that.
      openTimer = window.setTimeout(() => {
        openTimer = null;
        if (disposed || !ws || ws.readyState !== WebSocket.CONNECTING) return;
        recordLifecycleEvent({ kind: "ws_stuck", waitMs: WS_OPEN_TIMEOUT_MS, online: navigator.onLine });
        dead = true;
        try { ws.close(); } catch {}
        term!.write("\r\n\x1b[33m[connection never opened: press Enter to retry, or reload the app, which always fixes it]\x1b[0m\r\n");
        onClosed?.();
      }, WS_OPEN_TIMEOUT_MS);
      ws.onopen = () => {
        if (openTimer !== null) window.clearTimeout(openTimer);
        openTimer = null;
      };

      ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          try {
            const m = JSON.parse(e.data);
            if (m.type === "exit") term!.write(`\r\n\x1b[90m[process exited (${m.exitCode})]\x1b[0m\r\n`);
          } catch {}
        } else {
          term!.write(new Uint8Array(e.data));
        }
      };
      ws.onerror = () => { if (!disposed) term!.write(`\r\n\x1b[31m[terminal unreachable: is the pty-server sidecar running?]\x1b[0m\r\n`); };
      ws.onclose = () => {
        if (openTimer !== null) window.clearTimeout(openTimer);
        openTimer = null;
        // `dead` is already set when the deadline above gave up on a socket
        // stuck at CONNECTING, and closing it lands right back here: that case
        // has said its piece, so don't say it again.
        if (disposed || dead) return;
        dead = true;
        term!.write("\r\n\x1b[90m[disconnected: press Enter to start a new shell]\x1b[0m\r\n");
        onClosed?.();
      };

      // Single input path for both typed keystrokes and the mobile button-bar:
      // when the shell is dead, Enter respawns it; otherwise forward to the pty.
      const send = (d: string) => {
        if (dead) {
          if (d === "\r") setSession((s) => s + 1);
          return;
        }
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data: d }));
      };
      term.onData(send);
      onReady?.({ send });

      const syncSize = () => {
        if (!hostRef.current || hostRef.current.clientHeight < 24) return; // skip when collapsed
        try {
          fit!.fit();
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term!.cols, rows: term!.rows }));
        } catch {}
      };
      ro = new ResizeObserver(syncSize);
      ro.observe(hostRef.current);
      term.focus();
    })();

    return () => {
      disposed = true;
      if (openTimer !== null) window.clearTimeout(openTimer);
      openTimer = null;
      termRef.current = null;
      fitRef.current = null;
      try { ro?.disconnect(); } catch {}
      try { mo?.disconnect(); } catch {}
      try { ws?.close(); } catch {}
      try { term?.dispose(); } catch {}
    };
  }, [cwd, session]);

  // Live font-size changes (mobile A−/A+) without respawning the shell: retheme
  // the existing terminal and refit so the pty's cols/rows track the new metrics.
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.fontSize = fontSize;
    try { fitRef.current?.fit(); } catch {}
  }, [fontSize]);

  // Live mono-font changes via an explicit prop (no respawn needed).
  useEffect(() => {
    const t = termRef.current;
    if (!t || !monoFontFamily) return;
    t.options.fontFamily = monoFontFamily;
  }, [monoFontFamily]);

  return <div className="term-host" ref={hostRef} />;
}
