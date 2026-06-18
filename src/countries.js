/**
 * GROUP STAGE COUNTRY FILTER
 * ==========================
 * Only matches involving these teams will be tracked during the group stage.
 * All knockout stage matches are always tracked regardless of this list.
 *
 * To follow ALL group stage matches: delete this file entirely.
 * Names must match exactly how API-Football returns them (check /teams endpoint
 * if a country isn't being picked up).
 */

export const FOLLOWED_COUNTRIES = [
  "Spain",
  "France",
  "England",
  "Argentina",
  "Portugal",
  "United States", // API-Football uses "United States" not "USA"
];
