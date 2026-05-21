/**
 * Session glue: bridges the sandbox PTY stream and the trystero peer.
 *
 * Enforces a single-viewer policy — the first browser to complete a valid
 * handshake owns the session; later joiners are politely rejected. Sharing a
 * live root shell to multiple strangers at once is strictly worse than one.
 */

import {
  PROTOCOL_VERSION,
  isHelloMessage,
  isResizeMessage,
  type ReadyMessage,
} from "@use-my-shell/protocol";
import type { HostPeer } from "./peer.ts";
import type { ShellSession } from "./sandbox.ts";
import { log } from "./logger.ts";

export interface SessionConfig {
  /** Initial terminal size advertised to the browser. */
  cols: number;
  rows: number;
  /** Shell command running in the sandbox (for the ready handshake). */
  shell: string;
  /** Sandbox image (for the ready handshake). */
  image: string;
}

export interface RunningSession {
  /** Resolves when the PTY exits or the bridge is stopped. */
  done: Promise<void>;
  /** Stop forwarding and resolve `done`. */
  stop: () => void;
}

/**
 * Wire a booted sandbox shell to a trystero peer and start forwarding.
 *
 * Host -> browser: PTY `stdout` events become `output` messages.
 * Browser -> host: `input` messages are written to the PTY stdin;
 *                  `resize` messages re-issue `stty` to the PTY.
 */
export function runSession(
  shell: ShellSession,
  peer: HostPeer,
  config: SessionConfig,
): RunningSession {
  // The single peer that currently owns the session, or null when free.
  let viewer: string | null = null;
  let stopped = false;

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    resolveDone();
  };

  // --- Browser -> host: keystrokes -------------------------------------
  peer.onInput((data, peerId) => {
    if (stopped || peerId !== viewer) return;
    void shell.stdin.write(data).catch((err: unknown) => {
      log.warn(`Failed to write keystrokes to the PTY: ${String(err)}`);
    });
  });

  // --- Browser -> host: resize -----------------------------------------
  // microsandbox exposes no PTY winsize API, so we re-issue `stty` inside
  // the shell. This updates the terminal driver for line-based programs;
  // full-screen TUI apps may not repaint until refreshed.
  peer.onResize((msg, peerId) => {
    if (stopped || peerId !== viewer || !isResizeMessage(msg)) return;
    const cols = Math.max(1, Math.floor(msg.cols));
    const rows = Math.max(1, Math.floor(msg.rows));
    void shell.stdin
      .write(`stty cols ${cols} rows ${rows}\n`)
      .catch(() => {});
  });

  // --- Handshake & single-viewer policy --------------------------------
  peer.onHello((msg, peerId) => {
    if (stopped) return;

    if (!isHelloMessage(msg) || msg.protocolVersion !== PROTOCOL_VERSION) {
      log.warn(`Rejecting peer ${peerId}: protocol mismatch.`);
      peer.sendBye({ reason: "Incompatible protocol version." }, peerId);
      return;
    }

    if (viewer && viewer !== peerId) {
      log.warn(`Rejecting peer ${peerId}: a viewer is already connected.`);
      peer.sendBye({ reason: "This shell already has a viewer." }, peerId);
      return;
    }

    viewer = peerId;
    log.success(`Browser connected (${peerId}). Streaming the shell.`);

    const ready: ReadyMessage = {
      protocolVersion: PROTOCOL_VERSION,
      cols: config.cols,
      rows: config.rows,
      shell: config.shell,
      image: config.image,
    };
    peer.sendReady(ready, peerId);
  });

  peer.onBye((msg, peerId) => {
    if (peerId === viewer) {
      log.info(`Browser closed the session: ${msg.reason}`);
      viewer = null;
    }
  });

  peer.onPeerLeave((peerId) => {
    if (peerId === viewer) {
      log.info("Browser disconnected. Waiting for a new viewer…");
      viewer = null;
    }
  });

  // --- Host -> browser: PTY output -------------------------------------
  void (async () => {
    try {
      for await (const ev of shell.handle) {
        if (stopped) break;
        if (ev.kind === "stdout" || ev.kind === "stderr") {
          if (viewer) peer.sendOutput(ev.data, viewer);
        } else if (ev.kind === "exited") {
          log.info(`Shell exited with code ${ev.code}.`);
          if (viewer) peer.sendBye({ reason: "The shell session ended." }, viewer);
          break;
        }
      }
    } catch (err) {
      log.error(`PTY stream error: ${String(err)}`);
      if (viewer) peer.sendBye({ reason: "The host encountered an error." }, viewer);
    } finally {
      stop();
    }
  })();

  return { done, stop };
}
