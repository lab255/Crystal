import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTerminals, type TerminalTab } from "@crystal/client";

/** Theme token → concrete color (xterm can't consume CSS variables). */
function cssColor(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * PTY-backed terminal view: a real xterm.js emulator wired to a shared server
 * terminal. Keystrokes stream raw to the PTY (the PTY echoes), output chunks
 * append by seq (replay + live share one stream), and fit-to-container
 * resizes propagate to the server so every connected client renders the same
 * session — a resize elsewhere is applied here via the tab's cols/rows.
 */
export function XtermView({ tab }: { tab: TerminalTab }) {
  const chunks = useTerminals((s) => s.chunksByTab[tab.id]);
  const write = useTerminals((s) => s.write);
  const resize = useTerminals((s) => s.resize);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastSeqRef = useRef(-1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const term = new Terminal({
      cols: tab.cols ?? 100,
      rows: tab.rows ?? 30,
      fontSize: 12,
      fontFamily: getComputedStyle(el).fontFamily,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: cssColor("--color-surface-1", "#10131a"),
        foreground: cssColor("--color-ink", "#e7eaf3"),
        cursor: cssColor("--color-crystal-400", "#9d8cfc"),
        cursorAccent: cssColor("--color-surface-1", "#10131a"),
        selectionBackground: cssColor("--color-surface-active", "#232a3a"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    lastSeqRef.current = -1;

    const keystrokes = term.onData((data) => {
      // Exited terminals reject writes — swallow, the transcript stays readable.
      void write(tab.id, data).catch(() => {});
    });

    const fitToContainer = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      fit.fit();
      void resize(tab.id, term.cols, term.rows).catch(() => {});
    };
    fitToContainer();
    term.focus();
    const observer = new ResizeObserver(fitToContainer);
    observer.observe(el);

    return () => {
      observer.disconnect();
      keystrokes.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // The terminal instance lives as long as the tab (the panel keys views by tab id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // Feed replay + live chunks in seq order, exactly once each.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !chunks) return;
    for (const chunk of chunks) {
      if (chunk.seq <= lastSeqRef.current) continue;
      lastSeqRef.current = chunk.seq;
      term.write(chunk.text);
    }
  }, [chunks]);

  // A resize made by another client: mirror the authoritative PTY size.
  useEffect(() => {
    const term = termRef.current;
    if (!term || tab.cols == null || tab.rows == null) return;
    if (term.cols !== tab.cols || term.rows !== tab.rows) {
      term.resize(tab.cols, tab.rows);
    }
  }, [tab.cols, tab.rows]);

  return <div ref={containerRef} className="h-full min-h-0 w-full font-mono" />;
}
