/**
 * Session glue: bridges the sandbox PTY stream and the trystero peer.
 *
 * Multiple viewers are supported — every browser that completes a valid
 * handshake joins the same shared shell. PTY output is broadcast to all
 * connected viewers, and keystrokes/resizes from any viewer are forwarded
 * to the single underlying PTY. Anyone with the room code (and password)
 * gets concurrent control of the sandboxed shell.
 *
 * A bounded scrollback buffer of recent PTY output is kept so that a viewer
 * joining mid-session is replayed what is already on screen, instead of
 * staring at a blank terminal until the next keystroke.
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
 *                  stdin; `resize` messages drive `shell.resize()`, which
 *                  resizes the guest PTY out-of-band of the keystroke stream.
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

  // The guest PTY's current size. Starts at the configured default and
  // tracks the last applied resize. With multiple viewers the PTY has a
  // single size — the most recent resize from any viewer wins.
  let curCols = config.cols;
  let curRows = config.rows;

  // Apply a size to the guest PTY, but only when it actually changed —
  // each resize spawns a one-shot exec in the VM, so dropping no-ops
  // matters (the browser sends a resize on every connect).
  const applySize = (cols: number, rows: number): void => {
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    if (c === curCols && r === curRows) return;
    curCols = c;
    curRows = r;
    void shell.resize(c, r);
  };

  // --- Browser -> host: resize -----------------------------------------
  peer.onResize((msg, peerId) => {
    if (stopped || !viewers.has(peerId) || !isResizeMessage(msg)) return;
    applySize(msg.cols, msg.rows);
  });

  // --- Handshake: every valid peer becomes a viewer --------------------
  peer.onHello((msg, peerId) => {
    if (stopped) return;

    if (!isHelloMessage(msg) || msg.protocolVersion !== PROTOCOL_VERSION) {
      log.warn(`Rejecting peer ${peerId}: protocol mismatch.`);
      peer.sendBye({ reason: "Incompatible protocol version." }, peerId);
      return;
    }

    // Size the guest PTY from the joiner's reported terminal size before
    // sending `ready`, so the shell (and anything it launches) sees the
    // real dimensions instead of the hardcoded default. A zero dimension
    // means the browser had not laid out yet — it follows up with a
    // `resize` once it has.
    if (msg.cols > 0 && msg.rows > 0) {
      applySize(msg.cols, msg.rows);
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
      cols: curCols,
      rows: curRows,
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
