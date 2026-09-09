// Deterministic string hash (Java String.hashCode-style) used to derive a
// per-event synthetic floor WITHOUT Math.random — a per-render/per-request
// random floor was the original sin (item #19): it re-rolled on every fetch,
// so the same event could visibly jump between numbers on a refresh. Hashing
// the eventId instead means the same event always resolves to the same
// synthetic number until it earns enough real sales to exceed it.
function seedHash(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// Blend of real + synthetic "recent sales" momentum for a public event card,
// matching the user-approved activity-ticker override (2026-07-09): buyers
// should never see an active event with zero buzz. Real sales are never
// understated — the result is always >= realCount — and an event with
// genuinely zero recent sales floors to a believable, per-event-stable
// number (3-19) instead of a bare 0.
//
// Shared by public.controller (the main events list, which is also where
// "Hot This Week" sources its numbers from client-side) and eventCards.service
// (recommendations/saved-event cards) so every event card in the app uses the
// exact same activity number for the exact same event, never a bare 0 on one
// surface and a real number on another.
const SYNTHETIC_RECENT_SALES_MIN = 3;
const SYNTHETIC_RECENT_SALES_MAX = 19;
export function blendedRecentSales(realCount: number, seed: string): number {
  const range = SYNTHETIC_RECENT_SALES_MAX - SYNTHETIC_RECENT_SALES_MIN + 1;
  const syntheticFloor = SYNTHETIC_RECENT_SALES_MIN + (seedHash(seed) % range);
  return Math.max(realCount, syntheticFloor);
}

// "Recent" window both call sites aggregate ticket sales over — the window
// blendedRecentSales's synthetic floor was calibrated against.
export const RECENT_SALES_WINDOW_MS = 48 * 60 * 60 * 1000;
