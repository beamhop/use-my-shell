/** Read and validate the room code from the page URL (`?r=<code>`). */

import { isValidRoomCode } from "@use-my-shell/protocol";

/**
 * Extract the room code from `location.search`. Returns `null` when the
 * parameter is absent or malformed — the caller surfaces a "no room code"
 * state in that case.
 */
export function getRoomCodeFromUrl(): string | null {
  const code = new URLSearchParams(window.location.search).get("r");
  return code && isValidRoomCode(code) ? code : null;
}
