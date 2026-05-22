/**
 * Session glue: bridges per-viewer tmux PTYs and the trystero peer.
 *
 * Every browser that completes a valid handshake gets its own `tmux
 * attach-session` PTY in the guest (see sandbox.ts). They all share the one
 * underlying shell, but each renders at its own terminal size — so a laptop
 * and a phone viewing the same session both see correct output.
 *
 * No scrollback buffer is needed: a fresh tmux attach repaints the current
 * screen immediately, so a viewer joining mid-session sees the live state
 * without any host-side replay.
 */

import {
  PROTOCOL_VERSION,
  isHelloMessage,
  isResizeMessage,
  type ReadyMessage,
} from "@use-my-shell/protocol";
import type { HostPeer } from "./peer.ts";
import type { ShellSession, ViewerPty } from "./sandbox.ts";
import { log } from "./logger.ts";

export interface SessionConfig {
  /** Fallback terminal size when a viewer's hello reports none. */
  cols: number;
  rows: number;
  /** Shell command running in the sandbox (for the ready handshake). */
  shell: string;
  /** Sandbox image (for the ready handshake). */
  image: string;
}

export interface RunningSession {
  /** Resolves when the shell exits or the bridge is stopped. */
  done: Promise<void>;
  /** Stop forwarding, close every viewer PTY, and resolve `done`. */
  stop: () => Promise<void>;
}

/** Per-viewer state: the tmux attach PTY plus its last applied size. */
interface Viewer {
  pty: ViewerPty;
  cols: number;
  rows: number;
}

/**
 * Wire a booted sandbox shell to a trystero peer and start forwarding.
 *
 * Host -> browser: each viewer's tmux PTY output goes only to that viewer.
 * Browser -> host: `input` and `resize` from a viewer drive only that
 *                  viewer's PTY.
 */
export function runSession(
  shell: ShellSession,
  peer: HostPeer,
  config: SessionConfig,
): RunningSession {
  // Connected viewers, keyed by trystero peer id. Each has its own PTY.
  const viewers = new Map<string, Viewer>();
  // Peers whose attach is still being set up — used to abort an attach if
  // the peer leaves before `attachViewer` resolves.
  const pending = new Set<string>();
  let stopped = false;

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const open = [...viewers.values()];
    viewers.clear();
    await Promise.all(open.map((v) => v.pty.close().catch(() => {})));
    resolveDone();
  };

  // The shell exiting ends the whole session.
  void shell.shellExited.then(() => {
    log.info("The shell exited.");
    void stop();
  });

  // --- Browser -> host: keystrokes -------------------------------------
  peer.onInput((data, peerId) => {
    if (stopped) return;
    const viewer = viewers.get(peerId);
    if (!viewer) return;
    void viewer.pty.stdin.write(data).catch((err: unknown) => {
      log.warn(`Failed to write keystrokes to the PTY: ${String(err)}`);
    });
  });

  // --- Browser -> host: resize -----------------------------------------
  peer.onResize((msg, peerId) => {
    if (stopped || !isResizeMessage(msg)) return;
    const viewer = viewers.get(peerId);
    if (!viewer) return;
    const cols = Math.max(1, Math.floor(msg.cols));
    const rows = Math.max(1, Math.floor(msg.rows));
    // Each resize spawns a one-shot exec — skip no-ops.
    if (cols === viewer.cols && rows === viewer.rows) return;
    viewer.cols = cols;
    viewer.rows = rows;
    void viewer.pty.resize(cols, rows);
  });

  // --- Handshake: every valid peer gets its own viewer PTY -------------
  peer.onHello((msg, peerId) => {
    if (stopped) return;

    if (!isHelloMessage(msg) || msg.protocolVersion !== PROTOCOL_VERSION) {
      log.warn(`Rejecting peer ${peerId}: protocol mismatch.`);
      peer.sendBye({ reason: "Incompatible protocol version." }, peerId);
      return;
    }

    // Ignore a duplicate hello from an already-attached or attaching peer.
    if (viewers.has(peerId) || pending.has(peerId)) return;

    const cols = msg.cols > 0 ? msg.cols : config.cols;
    const rows = msg.rows > 0 ? msg.rows : config.rows;

    pending.add(peerId);
    void (async () => {
      let pty: ViewerPty;
      try {
        pty = await shell.attachViewer(peerId, cols, rows);
      } catch (err) {
        pending.delete(peerId);
        log.warn(`Failed to attach viewer ${peerId}: ${String(err)}`);
        peer.sendBye({ reason: "The host could not start your session." }, peerId);
        return;
      }

      // The peer may have left, or the session stopped, while attaching.
      if (stopped || !pending.has(peerId)) {
        pending.delete(peerId);
        void pty.close().catch(() => {});
        return;
      }
      pending.delete(peerId);
      viewers.set(peerId, { pty, cols, rows });
      log.success(
        `Browser connected (${peerId}). ${viewers.size} viewer(s) sharing the shell.`,
      );

      // Pump this viewer's PTY output to this viewer only.
      void (async () => {
        try {
          for await (const ev of pty.handle) {
            if (stopped || !viewers.has(peerId)) break;
            if (ev.kind === "stdout" || ev.kind === "stderr") {
              peer.sendOutput(ev.data, peerId);
            } else if (ev.kind === "exited") {
              break;
            }
          }
        } catch (err) {
          log.warn(`Viewer ${peerId} PTY stream error: ${String(err)}`);
        }
        // The attach ended (viewer's tmux client died) — drop just this
        // viewer; the shell and other viewers are unaffected.
        if (viewers.delete(peerId)) {
          peer.sendBye({ reason: "Your terminal session ended." }, peerId);
          void pty.close().catch(() => {});
          log.info(`Viewer ${peerId} detached (${viewers.size} left).`);
        }
      })();

      const ready: ReadyMessage = {
        protocolVersion: PROTOCOL_VERSION,
        cols,
        rows,
        shell: config.shell,
        image: config.image,
      };
      peer.sendReady(ready, peerId);
    })();
  });

  const dropViewer = (peerId: string, logLine: string): void => {
    pending.delete(peerId);
    const viewer = viewers.get(peerId);
    if (!viewer) return;
    viewers.delete(peerId);
    void viewer.pty.close().catch(() => {});
    log.info(`${logLine} (${viewers.size} viewer(s) left).`);
  };

  peer.onBye((msg, peerId) => {
    dropViewer(peerId, `Browser closed the session: ${msg.reason}`);
  });

  peer.onPeerLeave((peerId) => {
    dropViewer(peerId, "Browser disconnected");
  });

  return { done, stop };
}
