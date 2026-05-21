/** A small status pill reflecting the P2P session state. */

import type { SessionStatus } from "../usePeerSession.ts";

interface ConnectionStatusProps {
  status: SessionStatus;
  roomCode: string | null;
}

const LABELS: Record<SessionStatus, string> = {
  joining: "Connecting…",
  "password-required": "Password required",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error",
};

const DOT_COLORS: Record<SessionStatus, string> = {
  joining: "#e0b341",
  "password-required": "#e0b341",
  connected: "#3fb950",
  disconnected: "#f85149",
  error: "#f85149",
};

export function ConnectionStatus({
  status,
  roomCode,
}: ConnectionStatusProps): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#c9d1d9",
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: DOT_COLORS[status],
          flexShrink: 0,
        }}
      />
      <span>{LABELS[status]}</span>
      {roomCode && (
        <span style={{ color: "#6e7681" }}>· room {roomCode}</span>
      )}
    </div>
  );
}
