import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@wterm/react/css";
import "./global.css";
import { App } from "./App.tsx";
import { loadConfig } from "./config.ts";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element in index.html");
}

// Load runtime config (`/config.json`) before the first render so the P2P
// session has TURN credentials available immediately. loadConfig never
// rejects — a missing file falls back to STUN only.
const config = await loadConfig();

createRoot(root).render(
  <StrictMode>
    <App config={config} />
  </StrictMode>,
);
