#!/usr/bin/env bun
/**
 * use-my-shell CLI — share a sandboxed shell to a browser over P2P WebRTC.
 *
 * Boots a microsandbox VM, opens an interactive PTY shell inside it, joins a
 * trystero room, and bridges the PTY to a browser. The shared shell runs in a
 * disposable microVM, never on the host directly.
 */

import { parseArgs } from "node:util";
import { bootSandbox, teardownSandbox, type ShellSession } from "./sandbox.ts";
import { createHostPeer, type HostPeer } from "./peer.ts";
import { runSession, type RunningSession } from "./session.ts";
import { makeRoomCode, makeShareUrl } from "./url.ts";
import { color, log } from "./logger.ts";

const DEFAULT_WEB_URL = "https://beamhop.github.io/use-my-shell";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

interface CliOptions {
  image: string;
  shell: string;
  cpus: number;
  memoryMiB: number;
  password?: string;
  webUrl: string;
}

function printHelp(): void {
  console.error(`use-my-shell — share a sandboxed shell to a browser over P2P WebRTC

Usage: use-my-shell [options]

Options:
  --image <name>      Sandbox OCI image            (default: alpine)
  --shell <path>      Shell to run in the sandbox  (default: /bin/sh)
  --cpus <n>          Virtual CPUs                 (default: 1)
  --memory <mib>      Memory in MiB                (default: 512)
  --password <str>    Require this password to connect (optional)
  --web-url <url>     Base URL of the hosted web app   (default: ${DEFAULT_WEB_URL})
  -h, --help          Show this help
`);
}

function parseCliOptions(): CliOptions {
  const { values } = parseArgs({
    options: {
      image: { type: "string" },
      shell: { type: "string" },
      cpus: { type: "string" },
      memory: { type: "string" },
      password: { type: "string" },
      "web-url": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const cpus = values.cpus ? Number.parseInt(values.cpus, 10) : 1;
  const memoryMiB = values.memory ? Number.parseInt(values.memory, 10) : 512;

  if (!Number.isInteger(cpus) || cpus < 1) {
    log.error("--cpus must be a positive integer.");
    process.exit(1);
  }
  if (!Number.isInteger(memoryMiB) || memoryMiB < 128) {
    log.error("--memory must be an integer >= 128 (MiB).");
    process.exit(1);
  }

  return {
    image: values.image ?? "alpine",
    shell: values.shell ?? "/bin/sh",
    cpus,
    memoryMiB,
    password: values.password,
    webUrl: values["web-url"] ?? DEFAULT_WEB_URL,
  };
}

function printSessionBanner(
  roomCode: string,
  shareUrl: string,
  hasPassword: boolean,
): void {
  log.plain();
  log.plain(color.bold("  Your shell is being shared."));
  log.plain();
  log.plain(`  Room code:  ${color.cyan(roomCode)}`);
  log.plain(`  Open this:  ${color.cyan(shareUrl)}`);
  if (hasPassword) {
    log.plain(`  Password:   ${color.yellow("required")} — share it separately, out of band`);
  } else {
    log.plain(`  Password:   ${color.dim("none")}`);
  }
  log.plain();
  log.plain(
    color.yellow("  ⚠  Anyone with the room code") +
      (hasPassword ? color.yellow(" and password") : "") +
      color.yellow(" can use this shell."),
  );
  log.plain(color.dim("     It runs inside a disposable microVM, not on your machine."));
  log.plain();
  log.plain(color.dim("  Waiting for a browser to connect…  (Ctrl+C to stop)"));
  log.plain();
}

async function main(): Promise<void> {
  const opts = parseCliOptions();
  const roomCode = makeRoomCode();
  const shareUrl = makeShareUrl(opts.webUrl, roomCode);

  let shell: ShellSession | undefined;
  let peer: HostPeer | undefined;
  let session: RunningSession | undefined;
  let cleaningUp = false;

  // Idempotent, timeout-bounded teardown. The sandbox teardown and the P2P
  // leave run concurrently with independent budgets so a slow WebRTC
  // shutdown cannot starve the sandbox removal (or vice versa).
  const cleanup = async (exitCode: number): Promise<void> => {
    if (cleaningUp) return;
    cleaningUp = true;
    log.plain();
    log.info("Shutting down…");

    const withTimeout = (p: Promise<unknown>, ms: number): Promise<void> =>
      Promise.race([
        p.then(() => undefined).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, ms)),
      ]);

    // Notify the browser first (fire-and-forget), then tear down. The
    // sandbox teardown is internally time-bounded; the P2P leave gets its
    // own budget. They run concurrently so neither can starve the other.
    if (peer) peer.sendBye({ reason: "The host stopped sharing." });

    // Close the per-viewer tmux PTYs (owned by the session), then kill the
    // tmux server and the VM.
    if (session) await withTimeout(session.stop(), 4000);

    await Promise.all([
      shell ? teardownSandbox(shell) : Promise.resolve(),
      peer ? withTimeout(peer.leave(), 4000) : Promise.resolve(),
    ]);

    log.success("Stopped.");
    process.exit(exitCode);
  };

  process.on("SIGINT", () => void cleanup(0));
  process.on("SIGTERM", () => void cleanup(0));
  process.on("unhandledRejection", (reason) => {
    log.error(`Unhandled error: ${String(reason)}`);
    void cleanup(1);
  });

  try {
    shell = await bootSandbox({
      image: opts.image,
      shell: opts.shell,
      cpus: opts.cpus,
      memoryMiB: opts.memoryMiB,
    });

    peer = createHostPeer({ roomCode, password: opts.password });

    peer.onPeerJoin((peerId) => {
      log.info(`A browser joined the room (${peerId}). Awaiting handshake…`);
    });

    session = runSession(shell, peer, {
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      shell: opts.shell,
      image: opts.image,
    });

    printSessionBanner(roomCode, shareUrl, opts.password !== undefined);

    // Run until the shell exits.
    await session.done;
    await cleanup(0);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    await cleanup(1);
  }
}

void main();
