/** Top-level app: composes room code → P2P session → terminal + overlays. */

import { useMemo } from "react";
import { getRoomCodeFromUrl } from "./roomCode.ts";
import { usePeerSession } from "./usePeerSession.ts";
import { TerminalView } from "./TerminalView.tsx";
import { ConnectionStatus } from "./components/ConnectionStatus.tsx";
import { PasswordPrompt } from "./components/PasswordPrompt.tsx";
import { DisconnectedOverlay } from "./components/DisconnectedOverlay.tsx";
import type { AppConfig } from "./config.ts";

interface AppProps {
  /** Runtime config loaded from `/config.json` before render. */
  config: AppConfig;
}

export function App({ config }: AppProps): React.ReactElement {
  // The URL never changes within a session, so read it once.
  const roomCode = useMemo(() => getRoomCodeFromUrl(), []);
  const session = usePeerSession(roomCode, config);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#0d1117",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid #21262d",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            padding: "6px 12px",
            fontSize: 13,
            fontWeight: 600,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            color: "#c9d1d9",
          }}
        >
          use-my-shell
        </span>
        <ConnectionStatus status={session.status} roomCode={roomCode} />
      </header>

      <main style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {roomCode === null ? (
          <NoRoomCode />
        ) : (
          <>
            <TerminalView session={session} />

            {session.status === "joining" && (
              <CenteredNote text="Connecting to the host…" />
            )}

            {session.status === "password-required" && (
              <PasswordPrompt onSubmit={session.submitPassword} />
            )}

            {(session.status === "disconnected" ||
              session.status === "error") && (
              <DisconnectedOverlay
                detail={session.detail}
                onReconnect={session.reconnect}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function NoRoomCode(): React.ReactElement {
  return (
    <CenteredNote
      text="No room code in the URL. Open the link the host shared with you — it looks like ?r=brave-otter-lake"
    />
  );
}

function CenteredNote({ text }: { text: string }): React.ReactElement {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <p
        style={{
          margin: 0,
          maxWidth: 420,
          textAlign: "center",
          fontSize: 14,
          color: "#8b949e",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}
      >
        {text}
      </p>
    </div>
  );
}
