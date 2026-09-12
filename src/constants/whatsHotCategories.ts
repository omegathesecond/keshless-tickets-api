// "What's Hot This Weekend" content categories (spec §3/§7) — 'Nearby' is a
// See All sort/filter over the viewer's opted-in location (NearbyService),
// never a stored category, so it's deliberately absent from this list.
export const WHATS_HOT_CATEGORIES = ['Events', 'Vacations', 'Nightlife', 'Music', 'Food', 'Fashion', 'Travel'] as const;
export type WhatsHotCategory = typeof WHATS_HOT_CATEGORIES[number];
