/** Fetch itself failed: no answer from the server at all. */
export const CONNECTION_ERROR = "I couldn't reach the server. Check your connection and try again.";

/** A simple action (retry, skip) was refused: the server's words are for the logs, not the owner. */
export function requestErrorCopy(status: number): string {
  return status >= 500 ? "That didn't go through. Wait a minute and try again." : "That didn't go through. Try again.";
}
