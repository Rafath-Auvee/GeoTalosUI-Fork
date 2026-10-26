/**
 * Interactive annotation mode — tunables.
 *
 * PROVISIONAL: the scale presets, AOI cap, mask cap and throughput numbers are
 * placeholders until real values are chosen (they were left as open decisions
 * in the design brief). Everything reads from here so changing one is a
 * one-line edit.
 */

/** Selectable tile scales (metres) — drone-resolution objects. */
export const SCALE_LADDER_M = [5, 10, 20, 40, 80, 160] as const;

/** A tile should be ~this fraction object: sets the scale an object of a given size reads best at. */
export const TARGET_OBJECT_FRAC = 0.3;

/** Interactive mode is for small AOIs; larger ones are refused up front. */
export const MAX_AOI_HECTARES = 50; // matches geoops.interactive_tasks.MAX_AOI_HECTARES

/** Hard cap on draft masks kept in the browser. */
export const MAX_MASKS = 5000;

/** Default for the loose↔strict quality filter (0–1). */
export const DEFAULT_STRICTNESS = 0.5;

/** Run-cost estimate (shown before a run): SAM 3 reads one tile (plus margin) at a time. */
export const SECONDS_PER_TILE = 1;
/** Matches the backend limit (geoops.interactive_tasks.MAX_TILES). */
export const MAX_TILES = 2500;
/** Point-prompt grid per tile side sent to SAM 3 (16 → 256 prompts per tile). */
export const POINTS_PER_SIDE = 16;

/** Draft autosave debounce. */
export const AUTOSAVE_DEBOUNCE_MS = 800;

/** Most masks that can be grouped in one go (matches the backend limit). */
export const MAX_GROUP_MASKS = 6000;
/** Number of groups at the start; the "fewer ↔ finer" slider moves it. */
export const DEFAULT_GROUPS = 6;
/** A mask this far (z-score) from its group's centre is flagged as an outlier. */
export const OUTLIER_Z = 2.5;
/**
 * Group colours: categorical and colour-blind-safe (Okabe–Ito plus extras), each paired
 * with a letter so colour is never the only cue. They are data colours, brighter than the
 * muted UI palette, so they read on drone imagery.
 */
export const GROUP_COLORS = [
  '#e69f00', '#56b4e9', '#2fbf8f', '#f0e442', '#d55e00', '#cc79a7',
  '#9fa8ff', '#b6e354', '#ff7f7f', '#7fd8d0', '#c49a6c', '#c0c0c0',
] as const;
