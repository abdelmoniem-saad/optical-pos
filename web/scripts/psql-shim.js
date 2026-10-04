#!/usr/bin/env node
/**
 * A minimal `psql`, so the pgTAP suite can run on a machine that has a Postgres
 * SERVER but no client.
 *
 * WHY THIS EXISTS. test-db.sh shells out to `psql`, and the Windows PostgreSQL
 * builds this project can obtain carry no client: the EnterpriseDB installer is
 * 403 behind this network, and the only distributable that installs cleanly from
 * npm (@embedded-postgres/windows-x64) ships initdb/pg_ctl/postgres and nothing
 * else. Without a client every gate failure costs a push to CI - the cost this
 * repository has been paying since Phase 1.
 *
 * It implements exactly the flags test-db.sh uses, and nothing more:
 *
 *   psql <url> -X -q -v ON_ERROR_STOP=1 [-tA] -f FILE
 *
 *   -X              no psqlrc            (ignored; there is none)
 *   -q              quiet                (ignored; we never print chatter)
 *   -v K=V          set a variable       (ignored; no gate uses one)
 *   ON_ERROR_STOP=1 abort the file on the first error, non-zero exit
 *   -tA             tuples only, unaligned: print each column raw, one row per line
 *   -f FILE         run FILE
 *
 * The last flag is the one that matters and the easiest to get wrong. TAP is
 * line-oriented and the runner greps for `^not ok` and `^1..N`, so a value
 * containing a newline, or a missing field separator, breaks detection in a way
 * that reads as a passing suite. Fields are therefore joined with `|` - no
 * padding, no quoting - because pgTAP returns a single text column per row and
 * its own diagnostics can contain spaces and newlines.
 *
 * Everything in the suite is plain SQL: no `\\set`, no `\\echo`, no `:name`
 * variables, which is what makes a shim viable at all. That was verified before
 * this file was written, not assumed.
 */
import fs from 'node:fs';
// pg is CommonJS; ESM default-import interop is the supported way to reach it.
import pg from 'pg';

const { Client } = pg;

const argv = process.argv.slice(2);
let url = null;
const files = [];
const commands = [];
let tuplesOnly = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-f') files.push(argv[++i]);
  else if (a === '-c') commands.push(argv[++i]);
  else if (a === '-tA' || a === '-t' || a === '-A') tuplesOnly = true;
  else if (a === '-X' || a === '-q' || a === '-v' || a === '-n') {
    // -v NAME=VALUE consumes its value; the rest take none.
    if (a === '-v') i++;
  } else if (a.startsWith('-')) {
    // Unknown flag: fail loudly rather than silently ignore something a gate
    // depends on. Silently dropping a flag is how a shim starts lying.
    process.stderr.write(`psql-shim: unsupported flag ${a}\n`);
    process.exit(2);
  } else if (!url) url = a;
}

if (files.length === 0 && commands.length === 0) {
  process.stderr.write('psql-shim: no -f FILE or -c COMMAND given\n');
  process.exit(2);
}

// psql runs -c commands BEFORE -f files, in the order given on the command line.
// Keeping that ordering matters: the wrapper recreates the database with -c and
// then loads the schema with -f, and reversing the two would fail loudly.
const units = [
  ...commands.map((c) => ({ sql: c })),
  ...files.map((f) => ({ sql: fs.readFileSync(f, 'utf8') })),
];
const client = new Client({ connectionString: url });

/**
 * Split a SQL file into individual statements.
 *
 * NOT a regex and not a naive split on ';'. Migrations and gates are full of
 * dollar-quoted function bodies ($$ ... $$) whose semicolons are not statement
 * terminators, plus single-quoted literals, quoted identifiers and both comment
 * forms. Splitting those wrongly sends half a CREATE FUNCTION to the server.
 *
 * Why split at all: PostgreSQL runs a MULTI-statement simple query inside one
 * implicit transaction, and a few statements are illegal there - DROP DATABASE,
 * CREATE DATABASE, and CREATE INDEX CONCURRENTLY. psql avoids that by sending
 * one statement per round trip, and so does this. That last one is not
 * hypothetical: a concurrent index cannot be built inside a migration applied
 * this way at all.
 */
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  // null = normal, or one of: sq (', dq ("), lc (--), bc (/* */), dq$ (dollar)
  let state = null;
  let dollarTag = '';
  let blockDepth = 0;

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (state === 'lc') {
      if (c === '\n') { state = null; buf += c; }
      i++;
      continue;
    }
    if (state === 'bc') {
      if (c === '/' && next === '*') { blockDepth++; buf += c + next; i += 2; continue; }
      if (c === '*' && next === '/') { blockDepth--; buf += c + next; i += 2; if (!blockDepth) state = null; continue; }
      buf += c; i++;
      continue;
    }
    if (state === 'sq') {
      if (c === "'" && next === "'") { buf += c + next; i += 2; continue; } // escaped ''
      buf += c; i++;
      if (c === "'") state = null;
      continue;
    }
    if (state === 'dq') {
      buf += c; i++;
      if (c === '"') state = null;
      continue;
    }
    if (state === 'dq$') {
      if (c === '$' && sql.startsWith(dollarTag, i)) { buf += dollarTag; i += dollarTag.length; state = null; continue; }
      buf += c; i++;
      continue;
    }

    // normal
    if (c === '-' && next === '-') { state = 'lc'; continue; }
    if (c === '/' && next === '*') { state = 'bc'; blockDepth = 1; buf += c + next; i += 2; continue; }
    if (c === "'") { state = 'sq'; buf += c; i++; continue; }
    if (c === '"') { state = 'dq'; buf += c; i++; continue; }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) { dollarTag = m[0]; state = 'dq$'; buf += dollarTag; i += dollarTag.length; continue; }
    }
    if (c === ';') {
      out.push(buf);
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function emit(res) {
  if (!res || !Array.isArray(res.rows)) return;
  for (const row of res.rows) {
    const vals = Object.values(row);
    if (vals.length === 0) continue;
    // Unaligned output: no padding, no quoting, one row per line.
    process.stdout.write(vals.map((v) => (v === null ? '' : String(v))).join('|') + '\n');
  }
}

(async () => {
  try {
    await client.connect();
    for (const unit of units) {
      for (const stmt of splitStatements(unit.sql)) {
        const res = await client.query(stmt);
        if (Array.isArray(res)) res.forEach(emit);
        else emit(res);
      }
    }
    await client.end();
    process.exit(0);
  } catch (err) {
    // ON_ERROR_STOP=1: report and fail, exactly as psql would.
    process.stderr.write(`${err.message}\n`);
    try { await client.end(); } catch {}
    process.exit(1);
  }
})();
