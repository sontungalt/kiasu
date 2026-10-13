import { HOUR_MS } from "../lib/clock.js";

/** Meta's customer-service window: free-form messages are allowed for 24h after my last inbound message. */
export const WINDOW_MS = 24 * HOUR_MS;
/** Treat the window as closed 5 minutes early, so a send that starts just before expiry can't land just after it. */
export const WINDOW_SAFETY_MS = 5 * 60_000;

export function isWindowOpen(lastInboundAt: string | null, now: Date): boolean {
  if (!lastInboundAt) return false;
  const last = Date.parse(lastInboundAt);
  if (Number.isNaN(last)) return false;
  return now.getTime() - last < WINDOW_MS - WINDOW_SAFETY_MS;
}
