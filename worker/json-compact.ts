// Width-aware compact JSON serializer.
//
// Pretty-printing (JSON.stringify(x, null, 2)) is readable but ~40% of a plan
// file is whitespace, and the coach reads + edits the plan on every run. This
// printer keeps the structure readable where it helps — metadata, agent_guidance
// and the weeks array stay indented — but collapses any value whose one-line form
// fits within maxLength onto a single line. For a training plan that means each
// day object becomes one line: smaller to read, and a unique, unambiguous anchor
// for the built-in Edit tool (a day line is unique via its date).
//
// Output is always valid JSON: JSON.parse(compactJson(x)) deep-equals x for any
// plain JSON value, so the persist round-trip (read -> JSON.parse -> validate) is
// unaffected.

export type CompactJsonOptions = {
  // A value whose compact form fits within this many columns (including its
  // leading indent) is emitted on one line. Larger -> more collapsing.
  maxLength?: number;
  // Spaces per indent level for values that must expand.
  indent?: number;
};

export function compactJson(value: unknown, options: CompactJsonOptions = {}): string {
  // 500 collapses every day object in a typical plan onto one line (~37% smaller
  // than 2-space pretty) while staying well under the smallest week object
  // (~1400 chars), so weeks always stay multi-line and readable.
  const maxLength = options.maxLength ?? 500;
  const indentUnit = ' '.repeat(options.indent ?? 2);

  function render(val: unknown, currentIndent: string): string {
    const oneLine = JSON.stringify(val);
    // undefined / function / symbol — JSON.stringify drops these in objects and
    // turns them into null in arrays. Reaching here means an array position.
    if (oneLine === undefined) return 'null';
    if (!oneLine.includes('\n') && currentIndent.length + oneLine.length <= maxLength) {
      return oneLine;
    }

    const childIndent = currentIndent + indentUnit;

    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      const items = val.map((item) => childIndent + render(item, childIndent));
      return `[\n${items.join(',\n')}\n${currentIndent}]`;
    }

    if (val !== null && typeof val === 'object') {
      const entries = Object.entries(val as Record<string, unknown>).filter(
        ([, v]) => JSON.stringify(v) !== undefined,
      );
      if (entries.length === 0) return '{}';
      const items = entries.map(
        ([key, v]) => `${childIndent}${JSON.stringify(key)}: ${render(v, childIndent)}`,
      );
      return `{\n${items.join(',\n')}\n${currentIndent}}`;
    }

    // A scalar (usually a long string) that overflows maxLength — keep it inline.
    return oneLine;
  }

  return render(value, '');
}
