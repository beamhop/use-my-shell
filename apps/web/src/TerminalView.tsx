/**
 * The terminal surface. Wraps `@wterm/react` and drives it headlessly:
 * incoming PTY bytes are pumped in via `write()`, keystrokes leave via
 * `onData`. wterm's built-in WebSocket transport is not used — the transport
 * here is the trystero P2P data channel.
 */

import { useEffect, useRef } from "react";
import { Terminal } from "@wterm/react";
import type { PeerSession } from "./usePeerSession.ts";

interface TerminalViewProps {
  session: PeerSession;
}

/** Debounce window for resize events sent to the host. */
const RESIZE_DEBOUNCE_MS = 200;

const encoder = new TextEncoder();

export function TerminalView({ session }: TerminalViewProps): React.ReactElement {
  const handleRef = useRef<React.ElementRef<typeof Terminal>>(null);
  const resizeTimer = useRef<number | null>(null);

  // Pipe PTY output from the P2P channel straight into the terminal.
  useEffect(() => {
    session.onOutput((bytes) => {
      handleRef.current?.write(bytes);
    });
  }, [session]);

  return (
    <Terminal
      ref={handleRef}
      // autoResize lets wterm size its character grid to fill the container,
      // so the terminal spans the full viewport. The host has no PTY winsize
      // API, so onResize forwards the new size and the host re-issues `stty`
      // to keep the guest's terminal driver in step.
      autoResize
      cursorBlink
      theme="monokai"
      onData={(data) => {
        session.sendInput(encoder.encode(data));
      }}
      onResize={(nextCols, nextRows) => {
        if (resizeTimer.current !== null) {
          window.clearTimeout(resizeTimer.current);
        }
        resizeTimer.current = window.setTimeout(() => {
          session.sendResize({ cols: nextCols, rows: nextRows });
        }, RESIZE_DEBOUNCE_MS);
      }}
      onReady={() => {
        handleRef.current?.focus();
      }}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
