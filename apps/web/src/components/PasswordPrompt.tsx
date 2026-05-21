/**
 * Shown when the host did not appear within the timeout — the likely cause is
 * a password-protected room. The user enters the password shared out-of-band
 * by the host, which triggers a fresh join attempt.
 */

import { useState } from "react";

interface PasswordPromptProps {
  onSubmit: (password: string) => void;
}

export function PasswordPrompt({
  onSubmit,
}: PasswordPromptProps): React.ReactElement {
  const [value, setValue] = useState("");

  return (
    <Overlay>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
        style={{ display: "flex", flexDirection: "column", gap: 14, width: 320 }}
      >
        <h2 style={{ margin: 0, fontSize: 18, color: "#c9d1d9" }}>
          This shell is password-protected
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: "#8b949e" }}>
          Enter the password the host shared with you. If you reached this
          screen by mistake, double-check the room link.
        </p>
        <input
          type="password"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          placeholder="Password"
          style={inputStyle}
        />
        <button type="submit" style={buttonStyle}>
          Connect
        </button>
      </form>
    </Overlay>
  );
}

function Overlay({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(13, 17, 23, 0.92)",
        zIndex: 10,
      }}
    >
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "9px 12px",
  fontSize: 14,
  borderRadius: 6,
  border: "1px solid #30363d",
  background: "#0d1117",
  color: "#c9d1d9",
  outline: "none",
};

const buttonStyle: React.CSSProperties = {
  padding: "9px 12px",
  fontSize: 14,
  borderRadius: 6,
  border: "1px solid #238636",
  background: "#238636",
  color: "#fff",
  cursor: "pointer",
};
