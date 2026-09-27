/**
 * canonical-json.ts — the ONE canonical serialisation of a JSON value, and the
 * fidelity digest computed over it.
 *
 * Two consumers, one form:
 *
 *  - `route-tuple`'s divergence check compares a sidecar against the payload it
 *    was handed field by field, through {@link canonicalJson}. It carried a
 *    private copy of this function until the fidelity digest needed the same
 *    form; the copy moved here unchanged, so the check's behaviour did not move.
 *  - `write-report` / `write-verdict` accept `--expect-digest <digest>` and refuse
 *    a payload whose {@link canonicalDigest} differs. The shipped driver computes
 *    that digest for each payload it hands a Scribe and renders it into the
 *    Scribe's write command, so a Scribe that re-transcribed the payload instead
 *    of copying it (a reworded judgment call, a paraphrased AC row, a field no
 *    schema declares) fails loud at the write instead of landing a paraphrase.
 *
 * **Key order is not a difference; array order is.** Two serialisations of one
 * record that differ only in key order hold the same facts, so the digest must
 * not move on a key reorder. `commitShas` and `acVerification` are ordered, so
 * an array reorder is a real change.
 *
 * **An integrity check, not a security one.** The digest detects an agent that
 * paraphrased what it was told to copy. It does not stand up to an adversary,
 * and it does not need to: nothing here trusts the Scribe to be hostile, only
 * to be imprecise. That is why it is FNV-1a (64-bit) over the UTF-8 bytes of
 * the canonical form — dependency-free, deterministic, and small enough to
 * inline verbatim into the driver script, which runs where no module can be
 * imported. The driver's copy is pinned to this one by a parity spec over a
 * shared fixture set (`canonical-json.spec.ts`); a change here without the same
 * change there fails that spec.
 */

/**
 * A JSON value rendered with object keys sorted at every depth.
 *
 * Leaves and keys go through `JSON.stringify`, so string escaping is the
 * platform's own (and a lone surrogate is always emitted as its `\u` escape,
 * never raw). Array order is preserved.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** FNV-1a 64-bit offset basis and prime (the published FNV parameters). */
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;

/**
 * FNV-1a (64-bit) over the UTF-8 encoding of `text`, as 16 lowercase hex digits.
 *
 * The UTF-8 encoding is done by hand rather than through `Buffer`/`TextEncoder`
 * so this body is the same algorithm, line for line, as the copy inlined into
 * the driver script (which has neither). A lone surrogate — unreachable from
 * {@link canonicalJson}, which escapes them — would encode as U+FFFD, the
 * replacement `TextEncoder` itself uses.
 */
function fnv1a64Hex(text: string): string {
  let hash = FNV64_OFFSET;
  const eat = (byte: number): void => {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * FNV64_PRIME);
  };
  for (const ch of text) {
    let cp = ch.codePointAt(0) as number;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) {
      eat(cp);
    } else if (cp < 0x800) {
      eat(0xc0 | (cp >> 6));
      eat(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      eat(0xe0 | (cp >> 12));
      eat(0x80 | ((cp >> 6) & 0x3f));
      eat(0x80 | (cp & 0x3f));
    } else {
      eat(0xf0 | (cp >> 18));
      eat(0x80 | ((cp >> 12) & 0x3f));
      eat(0x80 | ((cp >> 6) & 0x3f));
      eat(0x80 | (cp & 0x3f));
    }
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * The fidelity digest of a JSON value: {@link fnv1a64Hex} of its
 * {@link canonicalJson}. Independent of key order, sensitive to every value,
 * every array element and every array's order.
 */
export function canonicalDigest(value: unknown): string {
  return fnv1a64Hex(canonicalJson(value));
}

/** The shape a {@link canonicalDigest} always has — 16 lowercase hex digits. */
export const CANONICAL_DIGEST_SHAPE = /^[0-9a-f]{16}$/;
