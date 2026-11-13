import { Database } from "bun:sqlite"

// Money is an integer in the currency's minor unit (cents), so sums stay exact.
// In an account's own ledger a negative amount leaves the account and a
// positive one enters it; a card purchase is negative, a card payment positive.
// A balance is what the account is worth to its owner: a card's debt is negative.
export function openDb(path: string) {
  const db = new Database(path, { create: true, strict: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(`
    create table if not exists sessions (
      token_hash text primary key,
      sid text not null,
      created_at integer not null,
      expires_at integer not null
    );
    create table if not exists spent_tokens (jti text primary key, expires_at integer not null);

    create table if not exists accounts (
      id text primary key,
      name text not null,
      kind text not null check (kind in ('deposit', 'investment', 'card', 'loan')),
      institution text not null default '',
      currency text not null default 'TWD',
      created_at integer not null
    );
    create table if not exists balances (
      account_id text not null references accounts(id),
      date text not null,
      amount integer not null,
      primary key (account_id, date)
    );
    create table if not exists statements (
      account_id text not null references accounts(id),
      period text not null,
      closing_date text not null,
      due_date text,
      amount_due integer not null,
      primary key (account_id, period)
    );
    create table if not exists transactions (
      id integer primary key,
      account_id text not null references accounts(id),
      date text not null,
      posted_date text,
      amount integer not null,
      description text not null,
      merchant text not null,
      kind text not null check (kind in ('expense', 'income', 'transfer', 'fee')),
      category text,
      -- 'rule' came from the built-in rules, 'model' from Claude, 'merchant' from a hand-set row of the same merchant;
      -- 'user' was set by hand and never changes again.
      category_source text,
      external_id text not null,
      source text not null default '',
      created_at integer not null,
      unique (account_id, external_id)
    );
    create index if not exists transactions_date on transactions(date);
    create index if not exists transactions_merchant on transactions(merchant);
  `)
  // Until 2026-11 a model's answer waited in a `suggestion` column for a person to accept it.
  // The model now files its answers itself: apply the ones still waiting, then drop the column.
  // A row someone set by hand (category_source = 'user') keeps what they chose.
  const columns = db.query("select name from pragma_table_info('transactions')").all() as { name: string }[]
  if (columns.some(c => c.name === "suggestion")) {
    // One transaction: either the answers are applied and the column is gone, or nothing changed.
    db.transaction(() => {
      db.run("update transactions set kind = 'transfer', category_source = 'model' where suggestion = 'Transfer' and kind in ('expense', 'income') and category is null and category_source is null")
      db.run("update transactions set category = suggestion, category_source = 'model' where suggestion is not null and kind in ('expense', 'income') and category is null and category_source is null")
      db.run("alter table transactions drop column suggestion")
    })()
  }
  return db
}

export type Db = ReturnType<typeof openDb>

/** Marks an auth token id spent; false if it already was. A token works once, even across a restart. */
export function spendToken(db: Db, jti: string, expiresAt: number) {
  db.query("delete from spent_tokens where expires_at < ?").run(Date.now())
  return db.query("insert or ignore into spent_tokens (jti, expires_at) values (?, ?)").run(jti, expiresAt).changes === 1
}
