/** A plain JSON object: not null, not an array. */
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The text of a caught value, whatever was thrown. */
/** The value a map keyed by names from outside (a repository folder) holds for `key` itself: never an inherited one (`constructor`, `toString`). */
export const ownValue = <T>(map: Readonly<Record<string, T>> | undefined, key: string): T | undefined => (map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined);
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
