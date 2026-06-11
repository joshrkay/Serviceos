/**
 * Test/util: resolve the authoritative `CHECK (<column> IN (...))` value set for
 * a given table+column from the schema.ts migration blob.
 *
 * schema.ts is an append-only list of idempotent migrations, so an old
 * CREATE TABLE constraint stays in the file even after a later migration
 * DROPs + ADDs a replacement (e.g. proposals' status gains 'executing' and
 * 'undone' in later ALTERs). Matching *any* historical set would let a drifted
 * schema pass by matching a stale constraint, so we associate each CHECK with
 * the nearest preceding CREATE/ALTER TABLE <table> and return the LAST
 * (highest file position) set for that table+column — the one actually in force.
 *
 * Pure (no fs): callers pass the schema source so this stays a harmless util.
 */
export function resolveDbCheckSet(
  source: string,
  table: string,
  column: string,
): Set<string> {
  const tableStmts: Array<{ pos: number; table: string }> = [];
  const tableRe = /(?:CREATE TABLE(?:\s+IF NOT EXISTS)?|ALTER TABLE)\s+(\w+)/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tableRe.exec(source)) !== null) {
    tableStmts.push({ pos: tm.index, table: tm[1] });
  }

  const checkRe = new RegExp(`CHECK\\s*\\(\\s*\\b${column}\\b\\s+IN\\s*\\(([^)]*)\\)`, 'gi');
  let best: { pos: number; set: Set<string> } | null = null;
  let cm: RegExpExecArray | null;
  while ((cm = checkRe.exec(source)) !== null) {
    // Owning table = the nearest CREATE/ALTER TABLE preceding this CHECK.
    let owner = '';
    for (const ts of tableStmts) {
      if (ts.pos < cm.index) owner = ts.table;
      else break;
    }
    if (owner !== table) continue;
    const set = new Set([...cm[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
    if (best === null || cm.index > best.pos) best = { pos: cm.index, set };
  }

  if (best === null) {
    throw new Error(`No CHECK (${column} IN ...) found for table ${table} in schema source`);
  }
  return best.set;
}
