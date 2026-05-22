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
import { runSession } from "./session.ts";
import { makeRoomCode, makeShareUrl } from "./url.ts";
import { color, log } from "./logger.ts";

const DEFAULT_WEB_URL = "https://beamhop.github.io/use-my-shell";
/** Default fixed terminal grid; viewers scale their rendering to fit. */
const DEFAULT_SIZE = "100x30";

interface CliOptions {
  image: string;
  shell: string;
  cpus: number;
  memoryMiB: number;
  /** Fixed terminal grid size — the PTY never resizes after boot. */
  cols: number;
  rows: number;
  password?: string;
  webUrl: string;
}

/**
 * Parse a `<cols>x<rows>` size string. Bounds keep the grid usable: below
 * 20x10 most TUIs break; the upper bound keeps a scaled-down grid legible.
 */
function parseSize(raw: string): { cols: number; rows: number } {
  const m = /^(\d+)x(\d+)$/i.exec(raw.trim());
  if (!m) {
    log.error(`--size must be <cols>x<rows>, e.g. 100x30 (got "${raw}").`);
    process.exit(1);
  }
  const cols = Number.parseInt(m[1]!, 10);
  const rows = Number.parseInt(m[2]!, 10);
  if (cols < 20 || cols > 300 || rows < 10 || rows > 100) {
    log.error("--size out of range: cols 20–300, rows 10–100.");
    process.exit(1);
  }
  return { cols, rows };
}

function printHelp(): void {
  console.error(`use-my-shell — share a sandboxed shell to a browser over P2P WebRTC

Usage: use-my-shell [options]

Options:
  --image <name>      Sandbox OCI image            (default: alpine)
  --shell <path>      Shell to run in the sandbox  (default: /bin/sh)
  --cpus <n>          Virtual CPUs                 (default: 1)
  --memory <mib>      Memory in MiB                (default: 512)
  --size <WxH>        Fixed terminal grid size     (default: ${DEFAULT_SIZE})
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
      size: { type: "string" },
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

  const { cols, rows } = parseSize(values.size ?? DEFAULT_SIZE);

  return {
    image: values.image ?? "alpine",
    shell: values.shell ?? "/bin/sh",
    cpus,
    memoryMiB,
    cols,
    rows,
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
      cols: opts.cols,
      rows: opts.rows,
    });

    peer = createHostPeer({ roomCode, password: opts.password });

    peer.onPeerJoin((peerId) => {
      log.info(`A browser joined the room (${peerId}). Awaiting handshake…`);
    });

    const session = runSession(shell, peer, {
      cols: opts.cols,
      rows: opts.rows,
      shell: opts.shell,
      image: opts.image,
    });

    printSessionBanner(roomCode, shareUrl, opts.password !== undefined);

    // Run until the PTY exits.
    await session.done;
    await cleanup(0);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    await cleanup(1);
  }
}

void main();
