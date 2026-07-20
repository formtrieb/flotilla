/**
 * types.ts — shared primitive types for the wave-tools package.
 *
 * Canonical home for types that are used in more than one schema module and
 * must not be declared twice (a duplicate `export interface Foo` across two
 * re-exported modules would be a compile error in `index.ts`).
 */

/**
 * The `{ valid, errors }` shape returned by every dependency-free structural
 * validator in this package (`validateWorkerReport`, `validateReviewerVerdict`).
 * Declared once here; imported by both schema modules.
 */
export interface SchemaValidation {
  valid: boolean;
  errors: string[];
}
