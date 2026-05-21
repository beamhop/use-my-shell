/** Covers the terminal when the host leaves or the session ends. */

interface DisconnectedOverlayProps {
  detail: string | null;
  onReconnect: () => void;
}

export function DisconnectedOverlay({
  detail,
  onReconnect,
}: DisconnectedOverlayProps): React.ReactElement {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        background: "rgba(13, 17, 23, 0.92)",
        zIndex: 10,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 18, color: "#c9d1d9" }}>
        Session ended
      </h2>
      <p style={{ margin: 0, fontSize: 13, color: "#8b949e", maxWidth: 360, textAlign: "center" }}>
        {detail ?? "The host is no longer sharing this shell."}
      </p>
      <button
        type="button"
        onClick={onReconnect}
        style={{
          padding: "9px 16px",
          fontSize: 14,
          borderRadius: 6,
          border: "1px solid #30363d",
          background: "#21262d",
          color: "#c9d1d9",
          cursor: "pointer",
        }}
      >
        Try to reconnect
      </button>
    </div>
  );
}
