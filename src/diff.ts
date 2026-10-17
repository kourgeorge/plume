export interface DiffLine {
  t: 'same' | 'add' | 'del' | 'gap';
  line: string;
}

/**
 * Line-by-line difference between two texts (longest common subsequence), for showing a proposed
 * document change. Unchanged stretches longer than `context * 2` lines collapse into one "gap" line.
 */
export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
  // A trailing newline is not a line of content; ignoring it keeps "one line changed" looking like one line.
  const a = before.replace(/\n+$/, '').split('\n');
  const b = after.replace(/\n+$/, '').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const out: DiffLine[] = a.slice(0, start).map((line) => ({ t: 'same' as const, line }));

  if (midA.length * midB.length > 4_000_000) {
    // Too big to compare line by line: show it as replaced.
    out.push(...midA.map((line) => ({ t: 'del' as const, line })), ...midB.map((line) => ({ t: 'add' as const, line })));
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp = new Int32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * (m + 1) + j] = midA[i] === midB[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ t: 'same', line: midA[i] });
        i++;
        j++;
      } else if (i < n && (j >= m || dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1])) {
        // On a tie, removed lines come first: "old line, then its replacement" reads naturally.
        out.push({ t: 'del', line: midA[i] });
        i++;
      } else {
        out.push({ t: 'add', line: midB[j] });
        j++;
      }
    }
  }
  out.push(...a.slice(endA).map((line) => ({ t: 'same' as const, line })));
  return collapse(out, context);
}

/** Shorten long unchanged runs, keeping `context` lines next to each change. */
function collapse(lines: DiffLine[], context: number): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].t !== 'same') {
      out.push(lines[i++]);
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].t === 'same') j++;
    const run = lines.slice(i, j);
    const head = i === 0 ? 0 : context; // keep lines after the previous change
    const tail = j === lines.length ? 0 : context; // keep lines before the next change
    if (run.length > head + tail + 1) {
      out.push(...run.slice(0, head), { t: 'gap', line: `${run.length - head - tail} unchanged lines` }, ...run.slice(run.length - tail));
    } else out.push(...run);
    i = j;
  }
  return out;
}

/** Counts for a short summary ("+3 −1 lines"). */
export function diffStats(d: DiffLine[]): { added: number; removed: number } {
  return { added: d.filter((l) => l.t === 'add').length, removed: d.filter((l) => l.t === 'del').length };
}
