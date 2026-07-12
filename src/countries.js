/**
 * GROUP STAGE COUNTRY FILTER
 * ==========================
 * Only matches involving these teams will be tracked during the group stage.
 * All knockout stage matches are always tracked regardless of this list.
 *
 * To follow ALL group stage matches: delete this file entirely.
 * Names must match exactly how ESPN returns them (check the scoreboard endpoint
 * if a team isn't being picked up — ESPN uses full official names).
 *
 * Verified ESPN display names for WC 2026:
 *   "France", "Spain", "England", "Argentina", "Portugal", "United States"
 */

export const FOLLOWED_COUNTRIES = [
  "Spain",
  "France",
  "England",
  "Argentina",
  "Portugal",
  "United States",
];
