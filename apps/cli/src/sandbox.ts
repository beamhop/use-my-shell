/**
 * microsandbox VM lifecycle and per-viewer tmux terminal multiplexing.
 *
 * The microsandbox SDK is a native NAPI addon. This module loads it lazily so
 * that a load failure under Bun produces a clear, actionable error instead of
 * an opaque crash at import time. By project decision the CLI is Bun-only —
 * there is no Node fallback.
 *
 * Multiple browser viewers can have different screen sizes, but a single PTY
 * has a single size — so the guest runs a tmux server with one detached
 * session hosting the real shell, and each viewer attaches through its own
 * *grouped* session. Grouped sessions share the same windows/panes but each
 * has an independent size, so tmux re-renders the shared shell correctly for
 * every viewer's terminal at once.
 */

import type { ExecHandle, ExecSink, Sandbox } from "microsandbox";
import { log } from "./logger.ts";

/** Prefix for every sandbox this CLI creates — used to sweep stale ones. */
const SANDBOX_PREFIX = "use-my-shell-";

/** Name of the primary (detached) tmux session hosting the real shell. */
const TMUX_SESSION = "ums";

/**
 * Initial size of the primary tmux session. Viewers attach through grouped
 * sessions sized to their own terminals; this is only the size the shell
 * starts at before the first viewer connects.
 */
const TMUX_INIT_COLS = 120;
const TMUX_INIT_ROWS = 32;

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

/**
 * One viewer's attachment to the shared shell: an independent guest PTY
 * running `tmux attach-session` against that viewer's grouped session.
 */
export interface ViewerPty {
  /** Async-iterable stream of this viewer's PTY events. */
  handle: ExecHandle;
  /** Writable stdin of this viewer's PTY — that viewer's keystrokes. */
  stdin: ExecSink;
  /** Resize only this viewer's terminal. */
  resize: (cols: number, rows: number) => Promise<void>;
  /** Detach this viewer and kill its grouped session. */
  close: () => Promise<void>;
}

export interface ShellSession {
  sandbox: Sandbox;
  /**
   * Attach a new viewer to the shared shell. Creates a tmux grouped session
   * sized to the viewer's terminal and an exec running `tmux attach-session`
   * against it. `peerId` makes the grouped-session name unique.
   */
  attachViewer: (
    peerId: string,
    cols: number,
    rows: number,
  ) => Promise<ViewerPty>;
  /** Resolves when the shell inside the tmux session exits. */
  shellExited: Promise<void>;
}

/**
 * Build the POSIX-sh script that resizes a single viewer's PTY.
 *
 * microsandbox has no PTY winsize API, so the size is applied with `stty` on
 * the viewer's tmux client tty and a `SIGWINCH` is sent to that client's
 * process. The tmux client re-reads its winsize and renegotiates the size of
 * its grouped session with the server — leaving other viewers untouched.
 *
 * The client is located by `tmux list-clients` filtered to the viewer's own
 * grouped session, so exactly one pts device and one pid are targeted.
 * `cols`/`rows` are interpolated as already-validated integers.
 */
function buildResizeScript(
  groupedSession: string,
  cols: number,
  rows: number,
): string {
  return [
    // client_tty + client_pid for the one client on this grouped session.
    `info=$(tmux list-clients -t ${groupedSession} -F '#{client_tty} #{client_pid}' 2>/dev/null | head -n1)`,
    `[ -n "$info" ] || exit 0`,
    `tty=\${info% *}`,
    `pid=\${info#* }`,
    `stty -F "$tty" rows ${rows} cols ${cols} 2>/dev/null || true`,
    `kill -WINCH "$pid" 2>/dev/null || true`,
  ].join("\n");
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
 * Ensure tmux is available inside the guest, installing it if needed.
 *
 * The default image (alpine) has no tmux. A boot-time install keeps the
 * zero-config experience: `apk` first, then apt/dnf/yum for other images.
 * Throws an actionable error if tmux cannot be made available.
 */
async function ensureTmux(sandbox: Sandbox): Promise<void> {
  const present = await sandbox.shell("command -v tmux >/dev/null 2>&1");
  if (present.success) return;

  log.info("tmux not found in the sandbox image — installing…");
  await sandbox.shell(
    "apk add --no-cache tmux 2>/dev/null || " +
      "(apt-get update && apt-get install -y tmux) 2>/dev/null || " +
      "dnf install -y tmux 2>/dev/null || " +
      "yum install -y tmux 2>/dev/null || true",
  );

  const recheck = await sandbox.shell("command -v tmux >/dev/null 2>&1");
  if (!recheck.success) {
    throw new Error(
      "tmux is required inside the sandbox but could not be installed.\n" +
        "  The image has no usable package manager (apk/apt/dnf/yum).\n" +
        "  Pass --image with an image that bundles tmux.",
    );
  }
  log.success("tmux installed in the sandbox.");
}

/**
 * Boot a microsandbox VM and start the shared shell inside a tmux session.
 *
 * The shell runs in a *detached* tmux session; viewers attach later through
 * `attachViewer`. The host process owns only byte streams — the PTYs are
 * allocated inside the guest by the SDK (`.tty(true)`).
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

  await ensureTmux(sandbox);

  // Start the real shell inside a detached tmux session. `-l -i` keep the
  // login/interactive semantics; `-x/-y` give the session a definite size
  // before any viewer attaches. `window-size latest` + `aggressive-resize`
  // let each attached (grouped) session render at its own size.
  const shellArg = opts.shell.replace(/'/g, "'\\''");
  const setup = await sandbox.shell(
    `tmux new-session -d -s ${TMUX_SESSION} ` +
      `-x ${TMUX_INIT_COLS} -y ${TMUX_INIT_ROWS} '${shellArg} -l -i' && ` +
      `tmux set-option -g window-size latest && ` +
      `tmux set-option -g aggressive-resize on && ` +
      `tmux has-session -t ${TMUX_SESSION}`,
  );
  if (!setup.success) {
    await sandbox.kill().catch(() => {});
    throw new Error(
      `Failed to start the tmux session in the sandbox: ${setup.stderr()}`,
    );
  }
  log.success("Shell is running in a tmux session.");

  // Watch for the shell exiting. When the last process in the session ends,
  // tmux tears the session down — `has-session` then fails. Poll for it.
  let resolveExited!: () => void;
  const shellExited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const exitPoll = setInterval(() => {
    void sandbox
      .shell(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`)
      .then((res) => {
        if (!res.success) {
          clearInterval(exitPoll);
          resolveExited();
        }
      })
      .catch(() => {
        // A transient exec failure must not be mistaken for shell exit.
      });
  }, 2000);

  const attachViewer = async (
    peerId: string,
    cols: number,
    rows: number,
  ): Promise<ViewerPty> => {
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    // A grouped session shares the windows/panes of the primary session but
    // has its own, independent size. Sanitize the peer id to a tmux-safe name.
    const grouped = `${TMUX_SESSION}-${peerId.replace(/[^A-Za-z0-9_-]/g, "")}`;

    const created = await sandbox.shell(
      `tmux new-session -d -t ${TMUX_SESSION} -s ${grouped} -x ${c} -y ${r}`,
    );
    if (!created.success) {
      throw new Error(
        `Failed to create a tmux session for the viewer: ${created.stderr()}`,
      );
    }

    // Attach to the grouped session as a real PTY. This exec's PTY size is
    // what the grouped session renders at.
    const handle = await sandbox.execStreamWith("tmux", (e) =>
      e
        .args(["attach-session", "-t", grouped])
        .env("TERM", "xterm-256color")
        .tty(true)
        .stdinPipe(),
    );

    const stdin = await handle.takeStdin();
    if (!stdin) {
      await handle.kill().catch(() => {});
      await sandbox.shell(`tmux kill-session -t ${grouped}`).catch(() => {});
      throw new Error("microsandbox did not provide a writable stdin for the PTY.");
    }

    const resize = async (
      nextCols: number,
      nextRows: number,
    ): Promise<void> => {
      const rc = Math.max(1, Math.floor(nextCols));
      const rr = Math.max(1, Math.floor(nextRows));
      try {
        await sandbox.shell(buildResizeScript(grouped, rc, rr));
      } catch (err) {
        log.warn(`Failed to resize a viewer's PTY: ${String(err)}`);
      }
    };

    const close = async (): Promise<void> => {
      await settleWithin(stdin.close(), 1000);
      await settleWithin(handle.kill(), 2000);
      // Killing the grouped session detaches this viewer without touching
      // the primary session or any other viewer.
      await settleWithin(
        sandbox.shell(`tmux kill-session -t ${grouped}`),
        2000,
      );
    };

    return { handle, stdin, resize, close };
  };

  return { sandbox, attachViewer, shellExited };
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
 * Per-viewer attach execs are owned and closed by `runSession`; this kills
 * the tmux server and the VM. `stopAndWait()` blocks until the VM is down,
 * which `Sandbox.remove` requires before it will delete the database entry.
 * These sandboxes are ephemeral; a clean exit leaves nothing behind.
 */
export async function teardownSandbox(session: ShellSession): Promise<void> {
  const name = session.sandbox.name;
  await settleWithin(session.sandbox.shell("tmux kill-server"), 2000);
  await settleWithin(session.sandbox.stopAndWait(), 5000);
  if (sdkModule) {
    await settleWithin(sdkModule.Sandbox.remove(name), 5000);
  }
}
