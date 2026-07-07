// accounts.js — username/password accounts + diamond balances, backed by
// Postgres. Point this at a Northflank Postgres addon (or any Postgres) via
// the DATABASE_URL env var. If DATABASE_URL isn't set, the module logs a
// warning and every call becomes a no-op / rejects, so the rest of the game
// still runs fine without accounts configured (guests only).

const crypto = require('crypto');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || '';
let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Northflank's managed Postgres typically needs SSL for external
    // connections but not for internal ones; this works either way.
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  });
} else {
  console.warn('[accounts] DATABASE_URL not set — accounts/diamonds are disabled, guests only.');
}

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      diamonds INTEGER NOT NULL DEFAULT 0,
      lifetime_diamonds INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      unlocks JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      user_a TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      user_b TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_a, user_b)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      from_username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      to_username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (from_username, to_username)
    );
  `);
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ranked_wins INTEGER NOT NULL DEFAULT 0;
  `);
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ranked_losses INTEGER NOT NULL DEFAULT 0;
  `);
  console.log('[accounts] Postgres ready.');
}

function pairKey(a, b) {
  return a < b ? [a, b] : [b, a];
}

async function sendFriendRequest(fromUsername, toUsername) {
  if (!pool) throw new Error('Accounts are not configured on this server.');
  if (fromUsername === toUsername) throw new Error("You can't friend yourself.");
  const target = await pool.query('SELECT username FROM users WHERE username = $1', [toUsername]);
  if (target.rowCount === 0) throw new Error('No account with that username.');
  const [a, b] = pairKey(fromUsername, toUsername);
  const already = await pool.query('SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2', [a, b]);
  if (already.rowCount > 0) throw new Error('You are already friends.');
  // If the other person already sent us a request, accept it instead of
  // creating a duplicate / crossed request.
  const reverse = await pool.query(
    'SELECT 1 FROM friend_requests WHERE from_username = $1 AND to_username = $2',
    [toUsername, fromUsername]
  );
  if (reverse.rowCount > 0) {
    return acceptFriendRequest(fromUsername, toUsername);
  }
  await pool.query(
    `INSERT INTO friend_requests (from_username, to_username) VALUES ($1, $2)
     ON CONFLICT (from_username, to_username) DO NOTHING`,
    [fromUsername, toUsername]
  );
  return { status: 'requested' };
}

async function acceptFriendRequest(accepterUsername, requesterUsername) {
  if (!pool) throw new Error('Accounts are not configured on this server.');
  const req = await pool.query(
    'SELECT 1 FROM friend_requests WHERE from_username = $1 AND to_username = $2',
    [requesterUsername, accepterUsername]
  );
  if (req.rowCount === 0) throw new Error('No such friend request.');
  const [a, b] = pairKey(accepterUsername, requesterUsername);
  await pool.query(
    `INSERT INTO friendships (user_a, user_b) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [a, b]
  );
  await pool.query(
    'DELETE FROM friend_requests WHERE from_username = $1 AND to_username = $2',
    [requesterUsername, accepterUsername]
  );
  return { status: 'friends' };
}

async function declineFriendRequest(declinerUsername, requesterUsername) {
  if (!pool) throw new Error('Accounts are not configured on this server.');
  await pool.query(
    'DELETE FROM friend_requests WHERE from_username = $1 AND to_username = $2',
    [requesterUsername, declinerUsername]
  );
  return { status: 'declined' };
}

async function removeFriend(username, otherUsername) {
  if (!pool) throw new Error('Accounts are not configured on this server.');
  const [a, b] = pairKey(username, otherUsername);
  await pool.query('DELETE FROM friendships WHERE user_a = $1 AND user_b = $2', [a, b]);
  return { status: 'removed' };
}

async function listFriends(username) {
  if (!pool) return { friends: [], incoming: [], outgoing: [] };
  const friendRows = await pool.query(
    `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS friend
     FROM friendships WHERE user_a = $1 OR user_b = $1`,
    [username]
  );
  const incoming = await pool.query(
    'SELECT from_username FROM friend_requests WHERE to_username = $1',
    [username]
  );
  const outgoing = await pool.query(
    'SELECT to_username FROM friend_requests WHERE from_username = $1',
    [username]
  );
  return {
    friends: friendRows.rows.map(r => r.friend),
    incoming: incoming.rows.map(r => r.from_username),
    outgoing: outgoing.rows.map(r => r.to_username),
  };
}

async function areFriends(usernameA, usernameB) {
  if (!pool) return false;
  const [a, b] = pairKey(usernameA, usernameB);
  const res = await pool.query('SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2', [a, b]);
  return res.rowCount > 0;
}

async function recordRankedResult(winnerUsername, loserUsername, roundsPlayed) {
  if (!pool) return { winner: null, loser: null };
  const winner = await pool.query(
    `UPDATE users SET ranked_wins = ranked_wins + 1,
       diamonds = diamonds + $2, lifetime_diamonds = lifetime_diamonds + $2, wins = wins + 1
     WHERE username = $1 RETURNING *`,
    [winnerUsername, RANKED_WIN_DIAMONDS]
  );
  const loser = await pool.query(
    `UPDATE users SET ranked_losses = ranked_losses + 1 WHERE username = $1 RETURNING *`,
    [loserUsername]
  );
  return {
    winner: winner.rowCount ? publicAccount(winner.rows[0]) : null,
    loser: loser.rowCount ? publicAccount(loser.rows[0]) : null,
  };
}

// ---- password hashing (scrypt, no extra native deps) ----
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function isEnabled() {
  return !!pool;
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'Usernames are 3-16 characters: letters, numbers, underscore.';
  }
  if (typeof password !== 'string' || password.length < 4 || password.length > 72) {
    return 'Passwords must be 4-72 characters.';
  }
  return null;
}

// title tiers driven by lifetime diamonds earned
const RANKS = [
  { min: 0, title: 'Novice Chameleon' },
  { min: 20, title: 'Apprentice Chameleon' },
  { min: 50, title: 'Camo Specialist' },
  { min: 100, title: 'Blend Artist' },
  { min: 200, title: 'Master Forger' },
  { min: 400, title: 'Legendary Mimic' },
];

function rankForLifetime(lifetimeDiamonds) {
  let title = RANKS[0].title;
  for (const r of RANKS) {
    if (lifetimeDiamonds >= r.min) title = r.title;
  }
  return title;
}

const RANKED_WIN_DIAMONDS = 6;

function publicAccount(row) {
  return {
    username: row.username,
    diamonds: row.diamonds,
    lifetimeDiamonds: row.lifetime_diamonds,
    wins: row.wins,
    unlocks: row.unlocks || [],
    rank: rankForLifetime(row.lifetime_diamonds),
    rankedWins: row.ranked_wins || 0,
    rankedLosses: row.ranked_losses || 0,
  };
}

async function register(username, password) {
  if (!pool) throw new Error('Accounts are not configured on this server.');
  const err = validateCredentials(username, password);
  if (err) throw new Error(err);
  const existing = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
  if (existing.rowCount > 0) throw new Error('That username is taken.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const result = await pool.query(
    `INSERT INTO users (username, password_hash, salt) VALUES ($1, $2, $3) RETURNING *`,
    [username, hash, salt]
  );
  return publicAccount(result.rows[0]);
}

async function login(username, password) {
  if (!pool) throw new Error('Accounts are not configured on this server.');
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [String(username || '')]);
  if (result.rowCount === 0) throw new Error('No account with that username.');
  const row = result.rows[0];
  const hash = hashPassword(password, row.salt);
  if (hash !== row.password_hash) throw new Error('Incorrect password.');
  return publicAccount(row);
}

async function getAccount(username) {
  if (!pool) return null;
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  if (result.rowCount === 0) return null;
  return publicAccount(result.rows[0]);
}

// Adds (or subtracts) diamonds. Only positive amounts count toward
// lifetime-earned diamonds (used for rank), win counts are optional.
async function addDiamonds(username, amount, { countAsWin = false } = {}) {
  if (!pool) return null;
  const lifetimeDelta = amount > 0 ? amount : 0;
  const result = await pool.query(
    `UPDATE users
     SET diamonds = GREATEST(0, diamonds + $2),
         lifetime_diamonds = lifetime_diamonds + $3,
         wins = wins + $4
     WHERE username = $1
     RETURNING *`,
    [username, amount, lifetimeDelta, countAsWin ? 1 : 0]
  );
  if (result.rowCount === 0) return null;
  return publicAccount(result.rows[0]);
}

// Attempts to spend diamonds on an unlock key (idempotent — buying the same
// key twice just confirms you already own it). Returns the updated public
// account, or throws if the balance is insufficient.
async function purchaseUnlock(username, key, cost) {
  if (!pool) throw new Error('Accounts are not configured on this server.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query('SELECT * FROM users WHERE username = $1 FOR UPDATE', [username]);
    if (res.rowCount === 0) throw new Error('Account not found.');
    const row = res.rows[0];
    const unlocks = row.unlocks || [];
    if (unlocks.includes(key)) {
      await client.query('COMMIT');
      return publicAccount(row);
    }
    if (row.diamonds < cost) throw new Error('Not enough diamonds.');
    const updated = await client.query(
      `UPDATE users SET diamonds = diamonds - $2, unlocks = unlocks || $3::jsonb WHERE username = $1 RETURNING *`,
      [username, cost, JSON.stringify([key])]
    );
    await client.query('COMMIT');
    return publicAccount(updated.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Spends diamonds on a *consumable* power-up (no unlock stored — the
// player can buy the same key again next match, unlike purchaseUnlock's
// once-ever unlocks). Throws if the balance is insufficient.
async function spendDiamonds(username, cost) {
  if (!pool) throw new Error('Accounts are not configured on this server.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query('SELECT * FROM users WHERE username = $1 FOR UPDATE', [username]);
    if (res.rowCount === 0) throw new Error('Account not found.');
    const row = res.rows[0];
    if (row.diamonds < cost) throw new Error('Not enough diamonds.');
    const updated = await client.query(
      `UPDATE users SET diamonds = diamonds - $2 WHERE username = $1 RETURNING *`,
      [username, cost]
    );
    await client.query('COMMIT');
    return publicAccount(updated.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  initDb, isEnabled, register, login, getAccount, addDiamonds, purchaseUnlock, spendDiamonds, rankForLifetime,
  sendFriendRequest, acceptFriendRequest, declineFriendRequest, removeFriend, listFriends, areFriends,
  recordRankedResult,
};
