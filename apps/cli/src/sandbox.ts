/**
 * microsandbox VM lifecycle and the interactive PTY shell stream.
 *
 * The microsandbox SDK is a native NAPI addon. This module loads it lazily so
 * that a load failure under Bun produces a clear, actionable error instead of
 * an opaque crash at import time. By project decision the CLI is Bun-only —
 * there is no Node fallback.
 */

import type { ExecHandle, ExecSink, Sandbox } from "microsandbox";
import { log } from "./logger.ts";

/** Prefix for every sandbox this CLI creates — used to sweep stale ones. */
const SANDBOX_PREFIX = "use-my-shell-";

export interface SandboxOptions {
  /** OCI image for the sandbox VM. */
  image: string;
  /** Shell command to run as the interactive process. */
  shell: string;
  /** Virtual CPUs. */
  cpus: number;
  /** Memory in MiB. */
  memoryMiB: number;
}

export interface ShellSession {
  sandbox: Sandbox;
  /** Async-iterable stream of PTY events (`stdout` / `exited`). */
  handle: ExecHandle;
  /** Writable stdin of the PTY — keystrokes and `stty` resize commands. */
  stdin: ExecSink;
}

/**
 * Dynamically import the microsandbox SDK. Surfaces a precise error if the
 * native addon cannot be loaded by the current Bun runtime.
 */
/** Cached SDK module so teardown can reach the static `Sandbox.remove`. */
let sdkModule: typeof import("microsandbox") | null = null;

async function loadSdk(): Promise<typeof import("microsandbox")> {
  if (sdkModule) return sdkModule;
  try {
    sdkModule = await import("microsandbox");
    return sdkModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      "Failed to load the microsandbox native addon under Bun.\n" +
        `  Underlying error: ${detail}\n` +
        "  use-my-shell requires Bun with working N-API support, and a host\n" +
        "  that can run microsandbox VMs (macOS Apple Silicon, or Linux with KVM).\n" +
        "  Try `bun install` again, or run `bunx microsandbox install` manually.",
    );
  }
}

/**
 * Boot a microsandbox VM and start an interactive PTY shell inside it.
 *
 * The PTY is allocated *inside the guest* by the SDK (`.tty(true)`); this host
 * process only owns the byte streams. `stdinPipe()` gives us a writable stdin
 * so the browser's keystrokes can be forwarded in.
 */
export async function bootSandbox(opts: SandboxOptions): Promise<ShellSession> {
  const sdk = await loadSdk();
  const { Sandbox, isInstalled, install, MiB } = sdk;

  if (!isInstalled()) {
    log.info("microsandbox runtime not found — installing (one-time setup)…");
    await install();
    log.success("microsandbox runtime installed.");
  }

  // Sweep sandboxes left behind by previous crashed runs of this CLI. A
  // clean exit removes its own sandbox; this catches the unclean ones.
  // Handles from `Sandbox.list()` are read-only, so removal goes through
  // the static `Sandbox.remove(name)`.
  try {
    const stale = (await Sandbox.list()).filter((h) =>
      h.name.startsWith(SANDBOX_PREFIX),
    );
    for (const handle of stale) {
      await Sandbox.remove(handle.name).catch(() => {});
    }
    if (stale.length > 0) {
      log.info(`Cleaned up ${stale.length} stale sandbox(es) from a prior run.`);
    }
  } catch {
    // Listing is best-effort; a failure here must not block a new session.
  }

  // Unique name per run; `.replace()` evicts any stale sandbox with the
  // same name left behind by a crashed previous run.
  const name = `${SANDBOX_PREFIX}${process.pid}-${Date.now().toString(36)}`;

  log.info(`Booting sandbox VM (${opts.image}, ${opts.cpus} vCPU, ${opts.memoryMiB} MiB)…`);
  const sandbox = await Sandbox.builder(name)
    .image(opts.image)
    .cpus(opts.cpus)
    .memory(MiB(opts.memoryMiB))
    .replace()
    .create();
  log.success("Sandbox VM is up.");

  // Start the interactive shell as a real PTY. `-l -i` request a login,
  // interactive shell so prompts and job control behave as expected.
  const handle = await sandbox.execStreamWith(opts.shell, (e) =>
    e
      .args(["-l", "-i"])
      .env("TERM", "xterm-256color")
      .tty(true)
      .stdinPipe(),
  );

  const stdin = await handle.takeStdin();
  if (!stdin) {
    // Should never happen — stdinPipe() was requested and takeStdin() is
    // called exactly once.
    await sandbox.kill().catch(() => {});
    throw new Error("microsandbox did not provide a writable stdin for the PTY.");
  }

  return { sandbox, handle, stdin };
}

/** Race a promise against a timeout; resolves either way, never rejects. */
function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([
    p.then(() => undefined).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

/**
 * Tear down a shell session. Idempotent and best-effort.
 *
 * Ordering matters: `handle.kill()` is what makes the PTY event stream end
 * (an idle stream otherwise parks forever). It can itself hang, so it is
 * only awaited with a short timeout — but it still takes effect, unblocking
 * the iterator. `stopAndWait()` then blocks until the VM is actually down,
 * which `Sandbox.remove` requires before it will delete the database entry.
 * These sandboxes are ephemeral; a clean exit leaves nothing behind.
 */
export async function teardownSandbox(session: ShellSession): Promise<void> {
  const name = session.sandbox.name;
  await settleWithin(session.stdin.close(), 1000);
  await settleWithin(session.handle.kill(), 2000);
  await settleWithin(session.sandbox.stopAndWait(), 5000);
  if (sdkModule) {
    await settleWithin(sdkModule.Sandbox.remove(name), 5000);
  }
}
