/**
 * The terminal surface. Wraps `@wterm/react` and drives it headlessly:
 * incoming PTY bytes are pumped in via `write()`, keystrokes leave via
 * `onData`. wterm's built-in WebSocket transport is not used — the transport
 * here is the trystero P2P data channel.
 *
 * The terminal renders at the host's fixed grid size (from `ready`), never
 * `autoResize`. Each viewer then scales the whole terminal with a CSS
 * transform so the fixed grid fits its own viewport — so a laptop and a
 * phone viewing the same shell both see the identical, correct render, just
 * at different sizes. The browser never asks the host to resize the PTY.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@wterm/react";
import type { PeerSession } from "./usePeerSession.ts";

interface TerminalViewProps {
  session: PeerSession;
}

/**
 * Smallest CSS scale applied to the terminal. Below this the grid is
 * unreadable; the terminal is allowed to overflow (and the viewport to
 * scroll) rather than shrinking further.
 */
const MIN_SCALE = 0.3;

const encoder = new TextEncoder();

export function TerminalView({ session }: TerminalViewProps): React.ReactElement | null {
  const handleRef = useRef<React.ElementRef<typeof Terminal>>(null);
  /** The outer (viewport) box the terminal is scaled to fit. */
  const containerRef = useRef<HTMLDivElement>(null);
  /** The terminal's own DOM element, set once it has rendered. */
  const termElRef = useRef<HTMLElement | null>(null);
  /** Observes the viewport box and the terminal element for size changes. */
  const observerRef = useRef<ResizeObserver | null>(null);
  const [scale, setScale] = useState(1);

  const ready = session.ready;

  // Recompute the scale so the fixed-size terminal fits the viewport box.
  // The terminal's natural size is read fresh from its layout box
  // (`offsetWidth/Height` ignore the ancestor CSS `transform`).
  const recomputeScale = useCallback(() => {
    const container = containerRef.current;
    const el = termElRef.current;
    if (!container || !el) return;
    const termW = el.offsetWidth;
    const termH = el.offsetHeight;
    if (termW === 0 || termH === 0) return;
    const fit = Math.min(
      container.clientWidth / termW,
      container.clientHeight / termH,
      1, // never up-scale — keep text crisp
    );
    setScale(Math.max(fit, MIN_SCALE));
  }, []);

  // Pipe PTY output from the P2P channel straight into the terminal.
  useEffect(() => {
    session.onOutput((bytes) => {
      handleRef.current?.write(bytes);
    });
  }, [session]);

  // Recompute scale whenever the viewport box changes (window resize,
  // device rotation, header height). The terminal element itself is added
  // to this observer in `onReady`, once it exists.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => recomputeScale());
    observer.observe(container);
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [recomputeScale, ready]);

  // The terminal needs the host's fixed grid size before it can render.
  // Until `ready` arrives, App.tsx shows a "Connecting…" overlay.
  if (!ready) return null;

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          transform: `scale(${scale})`,
          transformOrigin: "center center",
        }}
      >
        <Terminal
          ref={handleRef}
          // Fixed grid — the host owns the size; no autoResize, no onResize.
          cols={ready.cols}
          rows={ready.rows}
          cursorBlink
          theme="monokai"
          onData={(data) => {
            session.sendInput(encoder.encode(data));
          }}
          onReady={(wt) => {
            handleRef.current?.focus();
            // The terminal has rendered — remember its element, start
            // watching it for font-reflow size changes, and fit it now.
            termElRef.current = wt.element;
            observerRef.current?.observe(wt.element);
            recomputeScale();
          }}
          style={{ display: "block" }}
        />
      </div>
    </div>
  );
}
