/**
 * Session glue: bridges the sandbox PTY stream and the trystero peer.
 *
 * Multiple viewers are supported — every browser that completes a valid
 * handshake joins the same shared shell. PTY output is broadcast to all
 * connected viewers, and keystrokes from any viewer are forwarded to the
 * single underlying PTY. Anyone with the room code (and password) gets
 * concurrent control of the sandboxed shell.
 *
 * The PTY size is fixed at boot and never changes: one TUI process can only
 * render at one size, so the host picks the grid and every viewer scales its
 * rendering to fit. Inbound `resize` messages are therefore ignored.
 *
 * A bounded scrollback buffer of recent PTY output is kept so that a viewer
 * joining mid-session is replayed what is already on screen, instead of
 * staring at a blank terminal until the next keystroke.
 */

import {
  PROTOCOL_VERSION,
  isHelloMessage,
  type ReadyMessage,
} from "@use-my-shell/protocol";
import type { HostPeer } from "./peer.ts";
import type { ShellSession } from "./sandbox.ts";
import { log } from "./logger.ts";

export interface SessionConfig {
  /** Fixed terminal size — set at boot, advertised to every viewer, never changes. */
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
 * Max bytes of PTY output retained for replay to late-joining viewers.
 * 256 KiB comfortably covers a full screen of escape-heavy TUI output while
 * staying small enough to send in one burst on join.
 */
const SCROLLBACK_LIMIT_BYTES = 256 * 1024;

/**
 * Wire a booted sandbox shell to a trystero peer and start forwarding.
 *
 * Host -> browser: PTY `stdout` events become `output` messages, broadcast
 *                  to every connected viewer.
 * Browser -> host: `input` messages from any viewer are written to the PTY
 *                  stdin. `resize` messages are ignored — the PTY size is
 *                  fixed (see the module comment).
 */
export function runSession(
  shell: ShellSession,
  peer: HostPeer,
  config: SessionConfig,
): RunningSession {
  // Every browser peer that has completed a valid handshake. All of them
  // share the one underlying PTY.
  const viewers = new Set<string>();
  let stopped = false;

  // Recent PTY output, oldest first, replayed to viewers joining mid-session.
  // Bounded by total byte count — the oldest chunks are dropped once the
  // running total exceeds SCROLLBACK_LIMIT_BYTES.
  const scrollback: Uint8Array[] = [];
  let scrollbackBytes = 0;

  const recordOutput = (data: Uint8Array): void => {
    scrollback.push(data);
    scrollbackBytes += data.byteLength;
    while (scrollbackBytes > SCROLLBACK_LIMIT_BYTES && scrollback.length > 1) {
      const dropped = scrollback.shift();
      if (dropped) scrollbackBytes -= dropped.byteLength;
    }
  };

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
    if (stopped || !viewers.has(peerId)) return;
    void shell.stdin.write(data).catch((err: unknown) => {
      log.warn(`Failed to write keystrokes to the PTY: ${String(err)}`);
    });
  });

  // --- Browser -> host: resize -----------------------------------------
  // The PTY size is fixed at boot; viewers scale their own rendering to fit.
  // The handler stays registered for trystero action-set parity, but a
  // resize from a viewer has no effect on the shared PTY.
  peer.onResize(() => {});

  // --- Handshake: every valid peer becomes a viewer --------------------
  peer.onHello((msg, peerId) => {
    if (stopped) return;

    if (!isHelloMessage(msg) || msg.protocolVersion !== PROTOCOL_VERSION) {
      log.warn(`Rejecting peer ${peerId}: protocol mismatch.`);
      peer.sendBye({ reason: "Incompatible protocol version." }, peerId);
      return;
    }

    // Replay the scrollback *before* adding the peer to `viewers`. Sends on
    // the `output` action to one peer are FIFO-ordered, so the buffered
    // bytes are queued ahead of any live output the broadcast loop emits
    // once this peer is a viewer — the screen reconstructs in order.
    for (const chunk of scrollback) peer.sendOutput(chunk, peerId);

    viewers.add(peerId);
    log.success(
      `Browser connected (${peerId}). ${viewers.size} viewer(s) sharing the shell.`,
    );

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
    if (viewers.delete(peerId)) {
      log.info(
        `Browser closed the session: ${msg.reason} (${viewers.size} viewer(s) left).`,
      );
    }
  });

  peer.onPeerLeave((peerId) => {
    if (viewers.delete(peerId)) {
      log.info(
        `Browser disconnected (${viewers.size} viewer(s) left).`,
      );
    }
  });

  // --- Host -> browser: PTY output -------------------------------------
  void (async () => {
    try {
      for await (const ev of shell.handle) {
        if (stopped) break;
        if (ev.kind === "stdout" || ev.kind === "stderr") {
          recordOutput(ev.data);
          for (const peerId of viewers) peer.sendOutput(ev.data, peerId);
        } else if (ev.kind === "exited") {
          log.info(`Shell exited with code ${ev.code}.`);
          for (const peerId of viewers) {
            peer.sendBye({ reason: "The shell session ended." }, peerId);
          }
          break;
        }
      }
    } catch (err) {
      log.error(`PTY stream error: ${String(err)}`);
      for (const peerId of viewers) {
        peer.sendBye({ reason: "The host encountered an error." }, peerId);
      }
    } finally {
      stop();
    }
  })();

  return { done, stop };
}
