# use-my-shell

Share a shell to a browser over a direct peer-to-peer WebRTC connection — no
shell server, no SSH, no exposed ports.

The shared shell never runs on your machine directly. The CLI spawns a
lightweight VM sandbox ([microsandbox](https://microsandbox.dev)) and shares
that. A leaked room code compromises only a disposable microVM, not your host.

```
┌────────────┐   PTY bytes    ┌──────────────┐   WebRTC    ┌──────────────┐
│ microVM    │ ◀────────────▶ │ CLI (Bun)    │ ◀─────────▶ │ Browser SPA  │
│ /bin/sh    │  microsandbox  │ trystero P2P │   trystero  │ wterm        │
└────────────┘     SDK        └──────────────┘             └──────────────┘
```

## Monorepo layout

| Path                | What it is                                              |
| ------------------- | ------------------------------------------------------- |
| `packages/protocol` | Shared P2P message contract (action names, types).      |
| `apps/cli`          | Bun CLI: boots the VM, owns the PTY, runs the P2P host. |
| `apps/web`          | Static React SPA: renders the terminal, joins the room. |

## Requirements

- **[Bun](https://bun.sh)** ≥ 1.2 — the package manager *and* the runtime.
- A host that can run microsandbox VMs: **macOS (Apple Silicon)** or
  **Linux with KVM**.

## Setup

```sh
bun install
```

The first CLI run downloads the microsandbox runtime automatically.

## Usage

### Host a shell

```sh
bun run dev:cli
```

This boots a sandbox VM, prints a room code and a browser URL, and waits for a
viewer. Options:

```
--image <name>    Sandbox OCI image            (default: alpine)
--shell <path>    Shell to run in the sandbox  (default: /bin/sh)
--cpus <n>        Virtual CPUs                 (default: 1)
--memory <mib>    Memory in MiB                (default: 512)
--password <str>  Require this password to connect (optional)
--web-url <url>   Base URL of the hosted web app
                  (default: https://beamhop.github.io/use-my-shell)
```

The CLI prints a shareable link pointing at the hosted SPA. Use `--web-url` to
point at a local dev server (`--web-url http://localhost:5173`) or your own
deployment.

With `--password`, viewers must supply the same value to connect. The password
is **not** placed in the URL — share it out of band; the browser prompts for it.

### View a shared shell

The CLI prints a link to the deployed SPA — open it in a browser. To run the
SPA locally instead:

```sh
bun run dev:web      # then run the CLI with --web-url http://localhost:5173
```

Build a static bundle with `bun run build` (output in `apps/web/dist`). The
SPA auto-deploys to GitHub Pages on push to `main` via
`.github/workflows/deploy-pages.yml`.

## How it works

- **microsandbox SDK** boots the VM and runs the shell as a real PTY
  (`execStreamWith` with `tty(true)` + a piped stdin). The CLI owns the byte
  streams; the PTY itself lives inside the guest.
- **trystero** runs in the host Bun process — outside the sandbox — and is the
  WebRTC bridge. Node/Bun has no native `RTCPeerConnection`, so trystero is
  given the `werift` polyfill. Signaling uses trystero's default Nostr strategy,
  so no signaling infrastructure is needed.
- **wterm** (`@wterm/react`) renders the terminal in the browser. It is driven
  headlessly: PTY bytes from the P2P channel are pumped in via `write()`;
  keystrokes leave through `onData`. wterm's built-in WebSocket transport is
  unused.
- **Auth** uses trystero's built-in `password` option, which AES-GCM-encrypts
  the WebRTC signaling. A password mismatch means peers simply cannot connect.

## TURN relay (optional)

WebRTC connects directly via STUN on most networks. On strict/symmetric NATs
or locked-down firewalls a direct path can't be found — a **TURN server**
relays the (still end-to-end encrypted) WebRTC traffic in that case.

TURN is **optional and off by default**. With no credentials, both apps use
STUN only (STUN + TURN over UDP, TCP, and TLS once configured — see
`buildIceServers` in `packages/protocol`).

**CLI** — reads `TURN_USERNAME` / `TURN_CREDENTIAL` from the environment at
startup:

```sh
cp apps/cli/.env.example apps/cli/.env     # then fill in TURN_USERNAME / TURN_CREDENTIAL
```

**Web app** — TURN credentials are *not* baked into the bundle. The SPA
fetches `/config.json` at startup, so credentials can be rotated by editing
one file on the deploy host with **no rebuild**:

```sh
cp apps/web/public/config.example.json apps/web/public/config.json
# then fill in turn.username / turn.credential   (set "turn": null for STUN only)
```

`config.json` is git-ignored. Vite copies `public/` into `dist/` verbatim;
your deploy host provides (or overwrites) `dist/config.json` per deployment.

A free TURN service to try without running your own server:
[metered.ca](https://www.metered.ca) — sign up and use the credentials from
your dashboard. For production, self-host [coturn](https://github.com/coturn/coturn)
on a UDP-capable host and point the endpoint hosts in `buildIceServers` at it.

> The web app's TURN credentials are downloaded by every browser that loads
> the app — that is unavoidable for browser WebRTC, whether they ship in the
> bundle or in `config.json`. Use credentials with a quota. `config.json` only
> buys rotation without a rebuild; it does not make them secret.

## Known limitations

- **Terminal resize.** microsandbox's SDK exposes no PTY winsize ioctl. The
  host works around this with a one-shot exec in the same VM that runs `stty`
  on the guest PTY and sends `SIGWINCH` to the shell's process group, so
  full-screen TUI apps (vim, htop, opencode) re-layout on resize. The browser
  also reports its size in the join handshake, so the shell starts at the
  right dimensions. Resize is delivered as a signal, not a true winsize
  ioctl — a few apps that only read the size via `ioctl` may still need a
  manual refresh.
- **NAT traversal.** WebRTC uses STUN by default — fine for most networks,
  but strict/symmetric NATs or corporate firewalls may fail to connect
  directly. Configure a **TURN relay** to cover those cases (see below).
- **Shared shell.** Every browser that completes a valid handshake joins the
  same shell. PTY output is broadcast to all viewers, and keystrokes from any
  viewer go to the one underlying shell — all connected viewers share control.
- **Security.** The room code is discoverable on the public Nostr signaling
  network. Anyone with the code (and password, if set) can use the shell — but
  it is a disposable microVM, not your host. Use `--password` for anything
  non-trivial.

## Verify

```sh
bun run typecheck          # all three packages
bun run build              # builds the web SPA
bun run dev:cli            # boots a VM, prints a room code
```

End-to-end: run `dev:cli`, open the printed URL in a browser, and confirm
typing `ls`, `whoami`, `pwd` reflects the *sandbox* (you are `root` in the VM,
not your host user).
