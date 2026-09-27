"""PRD rung census — the command behind the #1024 re-score (§8.0, §11.0a, §0).

Reads every story row of docs/PRD-v5-as-built.md §5 and §8 and prints, per
section: row count, median printed rung, the rung distribution, and every row
not at 5 with its printed rung cell. A "4−" counts as 3.75 for the median.
Split cells ("4 (T1) / 3 (T0)") are read by their FIRST rung — the census is a
lower bound on nothing and an upper bound on nothing; it restates what §8
prints, so a disagreement with a row is a row to fix, not a census to trust.

Also prints the two close-out falsifiers #1024 names:
  * total rows (must be 124),
  * rows whose Confirm cell carries no command (a runner command, a `D:`/`U:`/
    `W:`/`E:`/`S:` prefix, or a cited *.test.ts / *.spec.ts file).

Usage (repo root):  python3 docs/audit/tooling/prd-rung-census.py [--rows]
"""
import collections
import re
import sys

P = 'docs/PRD-v5-as-built.md'
ID = re.compile(r'\*\*((?:\d+\.\d+[ab]?)|(?:I\d+[a-z]?′?)|C5)\*\*')
CMD = re.compile(
    r'\*\*[DUWES]:\*\*|\b[DUWES]: `|`[^`]*(vitest|playwright|npm|npx|grep|node)[^`]*`|`[^`]*\.(test|spec)\.tsx?`'
)


def census():
    rows, section = [], None
    for i, line in enumerate(open(P).read().split('\n')):
        m = re.match(r'^### (8\.\d+) ', line)
        if m:
            section = m.group(1)
        elif line.startswith('## 5.'):
            section = '5'
        elif line.startswith('## 6.') or line.startswith('## 9.'):
            section = None
        if section is None or not line.startswith('| '):
            continue
        cells = line.split('|')
        if len(cells) < 7:
            continue
        idm = ID.fullmatch(cells[1].strip())
        if not idm:
            continue
        rung_cell = cells[4].strip()
        rm = re.search(r'\*\*\s*(\d)\s*(−)?\s*\*\*', rung_cell) or re.search(r'(\d)(−)?', rung_cell)
        rung = float(rm.group(1)) - (0.25 if rm.group(2) else 0) if rm else None
        rows.append({
            'line': i + 1,
            'section': section,
            'id': idm.group(1),
            'rung': rung,
            'cell': rung_cell,
            'has_cmd': bool(CMD.search('|'.join(cells[5:-1]))),
        })
    return rows


def fmt(r):
    return '4−' if r == 3.75 else ('—' if r is None else str(int(r)))


def main():
    rows = census()
    by = collections.defaultdict(list)
    for r in rows:
        by[r['section']].append(r)
    order = sorted(by, key=lambda s: (s != '5', [int(p) for p in s.split('.')]))
    print('| § | Rows | Median | At 6 | At 5 | At 4 / 4− | At ≤3 |')
    print('|---|---|---|---|---|---|---|')
    for s in order:
        vals = sorted(r['rung'] for r in by[s] if r['rung'] is not None)
        n = len(vals)
        med = vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2
        med_s = fmt(med) if med in (3.75,) or med == int(med) else f'{med:g}'
        print(f"| {s} | {len(by[s])} | {med_s} | {sum(v == 6 for v in vals)} | {sum(v == 5 for v in vals)} | "
              f"{sum(3.75 <= v < 5 for v in vals)} | {sum(v < 3.75 for v in vals)} |")
    print(f'\nTOTAL rows: {len(rows)}')
    print('Rows at rung 6:', sum(r['rung'] == 6 for r in rows))
    no_cmd = [r['id'] for r in rows if not r['has_cmd']]
    print('Rows with no command in the Confirm cell:', ', '.join(no_cmd) or 'none')
    if '--rows' in sys.argv:
        for s in order:
            for r in by[s]:
                if r['rung'] != 5:
                    print(f"{s}\t{r['id']}\t{fmt(r['rung'])}\t{r['cell'][:160]}")


if __name__ == '__main__':
    main()
