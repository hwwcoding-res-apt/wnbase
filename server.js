require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const accounts = require('./accounts');

// token -> username, for simple session auth. Sessions are in-memory (fine
// per the single-instance deployment note in the README); the underlying
// account data itself lives in Postgres via accounts.js.
const sessions = new Map();

// username -> connection state object, for players who are logged in and
// reachable for friend requests / ranked challenges (set via the 'identify'
// WS message). This is separate from being in a game room.
const presenceSockets = new Map();
// pairKey (sorted "a|b") -> { fromUsername, toUsername } pending challenge
const pendingChallenges = new Map();

// Pushes an instant 'friend_status' update to every online friend of
// `username`, so their friends list updates the moment someone comes
// online or goes offline — instead of everyone waiting on the client's
// 15-second poll (or having to refresh the page).
async function notifyFriendsOfPresence(username, online) {
  try {
    const data = await accounts.listFriends(username);
    (data.friends || []).forEach(friendName => {
      const friendWs = presenceSockets.get(friendName);
      if (friendWs && friendWs.readyState === 1) {
        send(friendWs, { type: 'friend_status', username, online });
      }
    });
  } catch (e) {
    console.error('[presence] failed to notify friends:', e.message);
  }
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

const WIN_DIAMONDS = 2;
// The give-up reveal has two stages, both driven client-side: first a
// zoomed-out view of the whole map (so the seeker sees *where* everyone
// was relative to the level), then a close-up on each still-hidden hider
// in turn (so the seeker sees *how* they were painted in). These constants
// must match the client's — they're what the total reveal duration (and so
// the round's actual end time) is computed from.
const GIVE_UP_OVERVIEW_MS = 1400;
const GIVE_UP_PER_HIDER_MS = 1800;
const GIVE_UP_END_BUFFER_MS = 400;
const RANKED_HIDE_MS = 8000;
const RANKED_SEEK_MS = 20000;

const PORT = process.env.PORT || 8080;
const MAPS_DIR = path.join(__dirname, 'public', 'maps');
const MAP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function listMapFiles() {
  try {
    return fs.readdirSync(MAPS_DIR)
      .filter(f => MAP_EXTENSIONS.has(path.extname(f).toLowerCase()))
      .sort();
  } catch {
    return [];
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/api/maps', (req, res) => res.json({ maps: listMapFiles() }));

// ---- Accounts (username/password + diamond balance) ----
app.get('/api/accounts-enabled', (req, res) => res.json({ enabled: accounts.isEnabled() }));

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const account = await accounts.register(username, password);
    const token = makeToken();
    sessions.set(token, account.username);
    res.json({ token, account });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const account = await accounts.login(username, password);
    const token = makeToken();
    sessions.set(token, account.username);
    res.json({ token, account });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

app.get('/api/me', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    const username = sessions.get(token);
    if (!username) return res.status(401).json({ message: 'Not logged in.' });
    const account = await accounts.getAccount(username);
    if (!account) return res.status(401).json({ message: 'Account no longer exists.' });
    res.json({ account });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  const { token } = req.body || {};
  sessions.delete(token);
  res.json({ ok: true });
});

// Spend diamonds on a cosmetic/palette/power-up unlock. `key` identifies the
// item (e.g. "brush:spray", "cosmetic:tophat", "power:no_slowdown"); `cost`
// is trusted from a fixed price table on the server (not the client) — see
// SHOP_PRICES below.
const SHOP_PRICES = {
  'cosmetic:tophat': 6,
  'cosmetic:partyhat': 6,
  'cosmetic:sparkletrail': 10,
  'cosmetic:confettitrail': 10,
};

// Power-ups are *consumable* — bought fresh every match instead of unlocked
// once forever, so they go through spendDiamonds (no unlock stored) rather
// than purchaseUnlock. Priced the same as their old one-time cost.
const POWER_PRICES = {
  'power:camo_helper': 8,
  'power:no_slowdown': 2,
  'power:direction_ping': 2,
  'power:footprint_trail': 8,
};

// ---- Friends ----
function usernameFor(token) {
  return sessions.get(String(token || ''));
}

app.get('/api/friends', async (req, res) => {
  try {
    const username = usernameFor(req.query.token);
    if (!username) return res.status(401).json({ message: 'Not logged in.' });
    const data = await accounts.listFriends(username);
    const friends = data.friends.map(name => ({ username: name, online: presenceSockets.has(name) }));
    res.json({ friends, incoming: data.incoming, outgoing: data.outgoing });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/friends/request', async (req, res) => {
  try {
    const username = usernameFor((req.body || {}).token);
    if (!username) return res.status(401).json({ message: 'Not logged in.' });
    const target = String((req.body || {}).username || '').trim();
    const result = await accounts.sendFriendRequest(username, target);
    res.json(result);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

app.post('/api/friends/accept', async (req, res) => {
  try {
    const username = usernameFor((req.body || {}).token);
    if (!username) return res.status(401).json({ message: 'Not logged in.' });
    const from = String((req.body || {}).username || '').trim();
    const result = await accounts.acceptFriendRequest(username, from);
    res.json(result);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

app.post('/api/friends/decline', async (req, res) => {
  try {
    const username = usernameFor((req.body || {}).token);
    if (!username) return res.status(401).json({ message: 'Not logged in.' });
    const from = String((req.body || {}).username || '').trim();
    const result = await accounts.declineFriendRequest(username, from);
    res.json(result);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

app.post('/api/friends/remove', async (req, res) => {
  try {
    const username = usernameFor((req.body || {}).token);
    if (!username) return res.status(401).json({ message: 'Not logged in.' });
    const other = String((req.body || {}).username || '').trim();
    const result = await accounts.removeFriend(username, other);
    res.json(result);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});
app.post('/api/purchase', async (req, res) => {
  try {
    const token = String((req.body || {}).token || '');
    const key = String((req.body || {}).key || '');
    const username = sessions.get(token);
    if (!username) return res.status(401).json({ message: 'Not logged in.' });
    const cost = SHOP_PRICES[key];
    if (cost == null) return res.status(400).json({ message: 'Unknown item.' });
    const account = await accounts.purchaseUnlock(username, key, cost);
    res.json({ account });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

// Buys one *use* of an in-game power-up. Unlike /api/purchase this never
// stores an unlock — the same key can be bought again next match (or even
// again later this match), so the balance is simply spent each time.
app.post('/api/spend-power', async (req, res) => {
  try {
    const token = String((req.body || {}).token || '');
    const key = String((req.body || {}).key || '');
    const username = sessions.get(token);
    if (!username) return res.status(401).json({ message: 'Not logged in.' });
    const cost = POWER_PRICES[key];
    if (cost == null) return res.status(400).json({ message: 'Unknown power-up.' });
    const account = await accounts.spendDiamonds(username, cost);
    res.json({ account });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---- Constants shared with client (kept in sync manually with public/game.js) ----
const PALETTE = [
  '#F2ECD9', '#D8CBA8', '#8B5E3C', '#4A2E20',
  '#5C7A4A', '#7FA05C', '#2F6E68', '#4E9E96',
  '#6B3F69', '#9B7BA8', '#E3A93B', '#F0D27A',
  '#C1554D', '#E08F86', '#232946', '#5B6478'
];
const TEAM_COLORS = ['#6B3F69', '#5C7A4A', '#E3A93B', '#2F6E68'];
const COLS = 22, ROWS = 22; // bigger than a player's viewport
const HIDE_MS = 60000;
const SEEK_MS = 120000;
const MAX_PLAYERS = 4;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const TAG_RADIUS = 0.85; // in cell units — just a bit past visible touch (~0.68), to allow for the
                          // small amount of position staleness between 'move' updates, not a free 3x buffer
const HITS_TO_CATCH = 2; // a seeker has to tag a hider this many times to catch them
const TAG_COOLDOWN_MS = 2000; // minimum time between hits landing on the same hider
const HIDER_SEEK_SPEED_MULT = 0.25; // hiders move at this fraction of normal speed once seeking starts
const SKIN_SIZE = 32; // 32x32 paintable pixels per character

const rooms = new Map(); // code -> room

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// Fills in a player's shop unlocks from Postgres after the room/player
// object already exists (so room creation/join doesn't have to block on a
// DB round-trip). Only affects power-ups that are checked at
// win/round-end time server-side (e.g. the underdog bonus below) — the
// purely cosmetic/client-rendered power-ups read S.account.unlocks
// directly on the client instead.
function loadUnlocksInto(player, username) {
  accounts.getAccount(username).then(acc => {
    if (acc) player.unlocks = acc.unlocks || [];
  }).catch(() => {});
}

function makeSkin(hex) {
  return new Array(SKIN_SIZE * SKIN_SIZE).fill(hex);
}

const VALID_HATS = new Set(['', 'tophat', 'partyhat']);
const VALID_TRAILS = new Set(['', 'sparkle', 'confetti']);

function publicPlayer(p) {
  return {
    id: p.id, name: p.name, colorIndex: p.colorIndex, role: p.role,
    x: p.x, y: p.y, skin: p.skin,
    tagged: p.tagged, tagTime: p.tagTime, connected: p.connected,
    hitCount: p.hitCount || 0,
    hat: p.hat || '', trail: p.trail || ''
  };
}

function publicPlayers(room) {
  return room.order.filter(id => room.players.has(id)).map(id => publicPlayer(room.players.get(id)));
}

// While hiders are hiding, seekers must not see where they are or what
// they're painting — that's the whole game. Strip that data out for them.
function stripHidersForSeeker(players) {
  return players.map(p => (p.role === 'hider' ? { ...p, x: null, y: null, skin: null } : p));
}

// A hider's hit count is only ever meaningful to that hider — showing it
// to anyone else (especially the seeker who landed the hit) would give
// away information the game is designed to keep hidden.
function hideHitCountsExcept(players, viewerId) {
  return players.map(p => (p.id === viewerId ? p : { ...p, hitCount: 0 }));
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, excludeId) {
  const data = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id !== excludeId && p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

// Same as broadcast, but only to players matching `predicate` — used to
// keep hider movement/painting invisible to seekers during hiding.
function broadcastFiltered(room, obj, predicate, excludeId) {
  const data = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id === excludeId) continue;
    if (!predicate(p)) continue;
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

// Sends each player a room_update honoring the hiding-phase fairness rule.
function broadcastPlayers(room, extra) {
  for (const p of room.players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const players = (room.phase === 'hiding' && p.role === 'seeker')
      ? stripHidersForSeeker(publicPlayers(room))
      : publicPlayers(room);
    send(p.ws, Object.assign({ type: 'room_update', players: hideHitCountsExcept(players, p.id), hostId: room.hostId }, extra || {}));
  }
}

function clearPhaseTimer(room) {
  if (room.phaseTimeout) { clearTimeout(room.phaseTimeout); room.phaseTimeout = null; }
}

function activeHiderCount(room) {
  return [...room.players.values()].filter(p => p.role === 'hider' && !p.tagged).length;
}

// Roles are no longer picked by players — one random player becomes the
// seeker, everyone else hides, chosen fresh each time the game starts.
function assignRolesAutomatically(room) {
  const list = room.order.map(id => room.players.get(id)).filter(Boolean);
  const seekerIdx = Math.floor(Math.random() * list.length);
  list.forEach((p, i) => { p.role = (i === seekerIdx) ? 'seeker' : 'hider'; });
}

function startHiding(room) {
  clearPhaseTimer(room);
  // Client loads the host-selected map image (falls back to the first
  // available map, or a plain placeholder if none are uploaded).
  const availableMaps = listMapFiles();
  const mapFile = (room.mapFile && availableMaps.includes(room.mapFile))
    ? room.mapFile
    : (availableMaps[0] || null);
  room.map = {
    type: 'image',
    cols: COLS, rows: ROWS,
    file: mapFile
  };
  room.phase = 'hiding';

  const hiders = room.order.map(id => room.players.get(id)).filter(p => p && p.role === 'hider');
  const seekers = room.order.map(id => room.players.get(id)).filter(p => p && p.role === 'seeker');

  hiders.forEach(p => {
    p.tagged = false;
    p.tagTime = null;
    p.hitCount = 0;
    p.lastHitTime = null;
    p.usedPower = new Set();
    p.skin = makeSkin(TEAM_COLORS[p.colorIndex % TEAM_COLORS.length]);
    p.x = 2 + Math.random() * (COLS - 4);
    p.y = 2 + Math.random() * (ROWS - 4);
  });
  seekers.forEach((p, i) => {
    p.tagged = false;
    p.tagTime = null;
    p.hitCount = 0;
    p.lastHitTime = null;
    p.usedPower = new Set();
    p.skin = makeSkin(TEAM_COLORS[p.colorIndex % TEAM_COLORS.length]);
    const angle = (i / Math.max(1, seekers.length)) * Math.PI * 2;
    p.x = COLS / 2 + Math.cos(angle) * 1.4;
    p.y = ROWS / 2 + Math.sin(angle) * 1.4;
  });

  room.phaseEnd = Date.now() + HIDE_MS;
  // Seekers get a snapshot with hiders blanked out; hiders see everything.
  for (const p of room.players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const players = p.role === 'seeker' ? stripHidersForSeeker(publicPlayers(room)) : publicPlayers(room);
    send(p.ws, { type: 'phase_change', phase: 'hiding', map: room.map, players, phaseEnd: room.phaseEnd });
  }
  room.phaseTimeout = setTimeout(() => startSeeking(room), HIDE_MS);
}

function startSeeking(room) {
  clearPhaseTimer(room);
  room.phase = 'seeking';
  room.phaseEnd = Date.now() + SEEK_MS;
  // Full reveal: everyone gets everyone's real position/skin now — but
  // each hider's hit count still only goes to that hider.
  const players = publicPlayers(room);
  for (const p of room.players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    send(p.ws, { type: 'phase_change', phase: 'seeking', players: hideHitCountsExcept(players, p.id), phaseEnd: room.phaseEnd });
  }
  room.phaseTimeout = setTimeout(() => endSeekingWithReveal(room), SEEK_MS);
}

function endSeekingWithReveal(room) {
  // Shows every still-hidden hider's real position (map overview, then a
  // close-up on each in turn — see the client's give-up reveal camera),
  // then ends the round exactly as it would have anyway. Used both when
  // the seeker gives up early and when the seek timer simply runs out —
  // either way, the round is over and there's nothing left to hide.
  clearPhaseTimer(room);
  const hiders = [...room.players.values()]
    .filter(p => p.role === 'hider' && !p.tagged)
    .map(p => ({ id: p.id, x: p.x, y: p.y }));
  const revealMs = GIVE_UP_OVERVIEW_MS + Math.max(1, hiders.length) * GIVE_UP_PER_HIDER_MS + GIVE_UP_END_BUFFER_MS;
  broadcast(room, { type: 'give_up_reveal', hiders, revealMs });
  room.phaseTimeout = setTimeout(() => {
    if (room.tourney) endTourneySubround(room, false);
    else endGame(room);
  }, revealMs);
}

const UNDERDOG_BONUS = 2;

async function awardWinDiamonds(room, outcome) {
  const all = [...room.players.values()];
  // Winners: hiders who were never caught if the hiders won, or every
  // seeker if the seekers won (they collectively found everyone).
  const winners = outcome === 'hiders'
    ? all.filter(p => p.role === 'hider' && !p.tagged)
    : all.filter(p => p.role === 'seeker');
  // Underdog bonus: if the hiders won anyway despite a seeker using the
  // footprint-trail radar, that's a harder win — pay it out extra.
  const underdog = outcome === 'hiders' &&
    all.some(p => p.role === 'seeker' && p.usedPower && p.usedPower.has('power:footprint_trail'));
  for (const p of winners) {
    if (!p.account) continue; // guests (not logged in) don't earn diamonds
    const total = underdog ? WIN_DIAMONDS + UNDERDOG_BONUS : WIN_DIAMONDS;
    try {
      const account = await accounts.addDiamonds(p.account, total, { countAsWin: true });
      if (account) send(p.ws, { type: 'balance_update', account, delta: total, reason: underdog ? 'win_underdog' : 'win' });
    } catch (e) {
      console.error('[accounts] award diamonds failed:', e.message);
    }
  }
}

function endGame(room) {
  clearPhaseTimer(room);
  room.phase = 'results';
  room.rematchReady = new Set();
  const all = [...room.players.values()];
  const hiders = all.filter(p => p.role === 'hider').sort((a, b) => {
    if (a.tagged !== b.tagged) return a.tagged ? 1 : -1;
    return (b.tagTime || 0) - (a.tagTime || 0);
  }).map(publicPlayer);
  const seekers = all.filter(p => p.role === 'seeker').map(publicPlayer);
  const outcome = hiders.some(h => !h.tagged) ? 'hiders' : 'seekers';
  broadcast(room, { type: 'phase_change', phase: 'results', hiders, seekers, outcome });
  awardWinDiamonds(room, outcome);
}

function backToLobby(room) {
  clearPhaseTimer(room);
  room.phase = 'lobby';
  room.map = null;
  room.phaseEnd = null;
  for (const p of room.players.values()) {
    p.tagged = false; p.tagTime = null;
    p.hitCount = 0; p.lastHitTime = null;
    p.skin = makeSkin(TEAM_COLORS[p.colorIndex % TEAM_COLORS.length]);
  }
  broadcast(room, { type: 'phase_change', phase: 'lobby', players: publicPlayers(room), hostId: room.hostId, maps: listMapFiles(), mapFile: room.mapFile });
}

function maybeEndByNoHidersLeft(room) {
  if (room.phase !== 'seeking' || activeHiderCount(room) !== 0) return;
  if (room.tourney) endTourneySubround(room, true);
  else endGame(room);
}

// ---------- Tourney (round-robin, 2-4 players) ----------
// Any room — ranked 1v1 challenge or a normal code-joined room with up to 4
// players — plays a "tourney" once everyone readies up: a round has one
// sub-round per player, where that player seeks and everyone else hides.
// A seeker "wins" their sub-round by finding/tagging every hider before time
// runs out; a hider "wins" their sub-round by never getting tagged. Wins are
// tallied per-player, cumulatively, across every sub-round played. After a
// full round (everyone has seeked once) the tallies are checked: if exactly
// one player has the strictly highest total, they win the match. If two or
// more are tied for the lead, everyone plays another full round and the
// tallies keep accumulating, repeating until there's a single leader.
function createRankedMatch(wsA, usernameA, wsB, usernameB) {
  const code = makeCode();
  const p1Id = crypto.randomBytes(6).toString('hex');
  const p2Id = crypto.randomBytes(6).toString('hex');
  const p1 = {
    id: p1Id, ws: wsA, name: usernameA, account: usernameA, colorIndex: 0, role: 'hider',
    x: COLS / 2, y: ROWS / 2, skin: makeSkin(TEAM_COLORS[0]),
    tagged: false, tagTime: null, hitCount: 0, lastHitTime: null, connected: true,
    unlocks: []
  };
  const p2 = {
    id: p2Id, ws: wsB, name: usernameB, account: usernameB, colorIndex: 1, role: 'seeker',
    x: COLS / 2, y: ROWS / 2, skin: makeSkin(TEAM_COLORS[1]),
    tagged: false, tagTime: null, hitCount: 0, lastHitTime: null, connected: true,
    unlocks: []
  };
  loadUnlocksInto(p1, usernameA);
  loadUnlocksInto(p2, usernameB);
  const room = {
    code, hostId: p1Id, phase: 'lobby', mode: 'ranked',
    players: new Map([[p1Id, p1], [p2Id, p2]]), order: [p1Id, p2Id],
    map: null, mapFile: null, phaseEnd: null, phaseTimeout: null,
    ready: new Set(), tourney: null,
  };
  rooms.set(code, room);
  wsA.pas.roomCode = code; wsA.pas.playerId = p1Id;
  wsB.pas.roomCode = code; wsB.pas.playerId = p2Id;
  const payloadFor = (myId, opponentName) => ({
    type: 'ranked_match_start', code, playerId: myId, hostId: room.hostId,
    players: publicPlayers(room), palette: PALETTE, teamColors: TEAM_COLORS,
    maps: listMapFiles(), mapFile: room.mapFile, opponent: opponentName,
  });
  send(wsA, payloadFor(p1Id, usernameB));
  send(wsB, payloadFor(p2Id, usernameA));
  // Ranked matches now pause on a short shared lobby so both players can
  // pick the map (and their hat/trail loadout) before the first round —
  // see the 'ready' handler, which kicks off the tourney once everyone in
  // the room has confirmed.
}

function startTourney(room) {
  const order = shuffled(room.order);
  room.tourney = {
    order,
    subIndex: 0,
    roundNum: 1,
    wins: new Map(order.map(id => [id, 0])),
  };
  startTourneySubround(room);
}

function startTourneySubround(room) {
  const t = room.tourney;
  // A player may have left mid-match — skip them and keep the rotation
  // going among whoever's still here.
  t.order = t.order.filter(id => room.players.has(id));
  if (t.subIndex >= t.order.length) t.subIndex = 0;
  if (t.order.length < 2) return; // not enough players left to continue
  const seekerId = t.order[t.subIndex];
  const seeker = room.players.get(seekerId);
  if (!seeker) return;
  for (const p of room.players.values()) p.role = (p.id === seekerId) ? 'seeker' : 'hider';
  broadcast(room, {
    type: 'round_start', round: t.roundNum, subIndex: t.subIndex, subCount: t.order.length, seekerId,
  });
  startHiding(room);
}

function resetTourneyPlayers(room) {
  for (const p of room.players.values()) {
    p.tagged = false; p.tagTime = null; p.hitCount = 0; p.lastHitTime = null;
  }
}

function endTourneySubround(room, seekerSuccess) {
  clearPhaseTimer(room);
  const t = room.tourney;
  const seekerId = t.order[t.subIndex];
  if (seekerSuccess) t.wins.set(seekerId, (t.wins.get(seekerId) || 0) + 1);
  for (const p of room.players.values()) {
    if (p.role === 'hider' && !p.tagged) t.wins.set(p.id, (t.wins.get(p.id) || 0) + 1);
  }
  resetTourneyPlayers(room);
  broadcast(room, {
    type: 'subround_result', round: t.roundNum, subIndex: t.subIndex, seekerId, seekerSuccess,
    wins: [...t.wins.entries()],
  });

  t.subIndex += 1;
  if (t.subIndex < t.order.length) {
    startTourneySubround(room);
    return;
  }

  // Full round complete — check the tally.
  const maxWins = Math.max(...t.wins.values());
  const leaders = [...t.wins.entries()].filter(([, w]) => w === maxWins).map(([id]) => id);
  if (leaders.length === 1) {
    endTourneyMatch(room, leaders[0]);
    return;
  }
  t.subIndex = 0;
  t.roundNum += 1;
  broadcast(room, { type: 'round_advance', round: t.roundNum, wins: [...t.wins.entries()] });
  startTourneySubround(room);
}

async function endTourneyMatch(room, winnerId) {
  clearPhaseTimer(room);
  room.phase = 'results';
  room.rematchReady = new Set();
  const t = room.tourney;
  const winner = room.players.get(winnerId);
  broadcast(room, {
    type: 'phase_change', phase: 'results', mode: room.mode,
    winnerId, wins: [...t.wins.entries()], roundsPlayed: t.roundNum,
  });
  if (room.mode === 'ranked' && t.order.length === 2) {
    const loserId = t.order.find(id => id !== winnerId);
    const loser = room.players.get(loserId);
    if (winner?.account && loser?.account) {
      try {
        const result = await accounts.recordRankedResult(winner.account, loser.account, t.roundNum);
        if (result.winner) send(winner.ws, { type: 'balance_update', account: result.winner, delta: 6, reason: 'ranked_win' });
        if (result.loser) send(loser.ws, { type: 'balance_update', account: result.loser, reason: 'ranked_loss' });
      } catch (e) {
        console.error('[accounts] ranked result failed:', e.message);
      }
    }
  } else if (winner?.account) {
    try {
      const account = await accounts.addDiamonds(winner.account, WIN_DIAMONDS, { countAsWin: true });
      if (account) send(winner.ws, { type: 'balance_update', account, delta: WIN_DIAMONDS, reason: 'tourney_win' });
    } catch (e) {
      console.error('[accounts] tourney win award failed:', e.message);
    }
  }
}

function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;
  room.players.delete(id);
  room.order = room.order.filter(x => x !== id);
  if (room.rematchReady) room.rematchReady.delete(id);
  if (room.hostId === id) {
    room.hostId = room.order[0] || null;
  }
  if (room.players.size === 0) {
    clearPhaseTimer(room);
    setTimeout(() => {
      if (rooms.get(room.code) === room && room.players.size === 0) rooms.delete(room.code);
    }, 5 * 60 * 1000);
    return;
  }
  if (room.ready) room.ready.delete(id);
  broadcastPlayers(room);
  maybeEndByNoHidersLeft(room);
  if (room.phase === 'results' && room.rematchReady) {
    broadcast(room, { type: 'rematch_update', ready: [...room.rematchReady] });
    if (room.rematchReady.size >= room.players.size && room.players.size >= 2) {
      room.rematchReady = new Set();
      startTourney(room);
    }
  }
}

wss.on('connection', (ws) => {
  // Mutable per-connection state lives on the ws object itself (not a
  // closured `let`) so that accepting a ranked challenge — which happens
  // inside a *different* connection's message handler — can push this
  // connection straight into a new room.
  ws.pas = { roomCode: null, playerId: null, account: null };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ---- account presence (for friends list / ranked challenges) ----
    if (msg.type === 'identify') {
      const username = sessions.get(String(msg.token || ''));
      if (!username) { send(ws, { type: 'error', message: 'Not logged in.' }); return; }
      ws.pas.account = username;
      const wasOnline = presenceSockets.has(username);
      presenceSockets.set(username, ws);
      send(ws, { type: 'identified', username });
      if (!wasOnline) notifyFriendsOfPresence(username, true);
      return;
    }

    if (msg.type === 'challenge') {
      const from = ws.pas.account;
      if (!from) { send(ws, { type: 'error', message: 'Log in to send ranked challenges.' }); return; }
      const to = String(msg.username || '').trim();
      const targetWs = presenceSockets.get(to);
      if (!targetWs || targetWs.readyState !== 1) { send(ws, { type: 'error', message: `${to} isn't online right now.` }); return; }
      accounts.areFriends(from, to).then(ok => {
        if (!ok) { send(ws, { type: 'error', message: 'You can only challenge friends.' }); return; }
        const key = [from, to].sort().join('|');
        pendingChallenges.set(key, { from, to });
        send(targetWs, { type: 'challenge_received', from });
        send(ws, { type: 'challenge_sent', to });
      }).catch(() => send(ws, { type: 'error', message: 'Could not send challenge.' }));
      return;
    }

    if (msg.type === 'challenge_response') {
      const me = ws.pas.account;
      if (!me) return;
      const from = String(msg.from || '').trim();
      const key = [me, from].sort().join('|');
      const pending = pendingChallenges.get(key);
      if (!pending || pending.to !== me) { send(ws, { type: 'error', message: 'That challenge is no longer available.' }); return; }
      pendingChallenges.delete(key);
      if (!msg.accept) {
        const fromWs = presenceSockets.get(from);
        if (fromWs) send(fromWs, { type: 'challenge_declined', by: me });
        return;
      }
      const fromWs = presenceSockets.get(from);
      if (!fromWs || fromWs.readyState !== 1) { send(ws, { type: 'error', message: `${from} disconnected.` }); return; }
      createRankedMatch(fromWs, from, ws, me);
      return;
    }

    if (msg.type === 'cancel_challenge') {
      const me = ws.pas.account;
      const to = String(msg.username || '').trim();
      const key = [me, to].sort().join('|');
      pendingChallenges.delete(key);
      const toWs = presenceSockets.get(to);
      if (toWs) send(toWs, { type: 'challenge_declined', by: me });
      return;
    }

    if (msg.type === 'create') {
      const name = String(msg.name || 'Painter').slice(0, 16).trim() || 'Painter';
      const account = sessions.get(String(msg.token || '')) || null;
      const code = makeCode();
      ws.pas.playerId = crypto.randomBytes(6).toString('hex');
      const playerId = ws.pas.playerId;
      const player = {
        id: playerId, ws, name, account, colorIndex: 0, role: 'hider',
        x: COLS / 2, y: ROWS / 2, skin: makeSkin(TEAM_COLORS[0]),
        tagged: false, tagTime: null, hitCount: 0, lastHitTime: null, connected: true,
        unlocks: []
      };
      const room = {
        code, hostId: playerId, phase: 'lobby', mode: 'ffa',
        players: new Map([[playerId, player]]), order: [playerId],
        map: null, mapFile: null, phaseEnd: null, phaseTimeout: null,
        ready: new Set(), tourney: null,
      };
      rooms.set(code, room);
      ws.pas.roomCode = code;
      send(ws, { type: 'created', code, playerId, hostId: room.hostId, players: publicPlayers(room), palette: PALETTE, teamColors: TEAM_COLORS, maps: listMapFiles(), mapFile: room.mapFile });
      if (account) loadUnlocksInto(player, account);
      return;
    }

    if (msg.type === 'join') {
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { send(ws, { type: 'error', message: `No room found with code ${code}.` }); return; }
      if (room.players.size >= MAX_PLAYERS) { send(ws, { type: 'error', message: 'That room is full (4 players max).' }); return; }
      if (room.phase !== 'lobby') { send(ws, { type: 'error', message: 'That game has already started. Ask the host for a new room.' }); return; }
      const name = String(msg.name || 'Painter').slice(0, 16).trim() || 'Painter';
      const account = sessions.get(String(msg.token || '')) || null;
      ws.pas.playerId = crypto.randomBytes(6).toString('hex');
      const playerId = ws.pas.playerId;
      const colorIndex = room.order.length % TEAM_COLORS.length;
      const player = {
        id: playerId, ws, name, account, colorIndex, role: 'hider',
        x: COLS / 2, y: ROWS / 2, skin: makeSkin(TEAM_COLORS[colorIndex]),
        tagged: false, tagTime: null, hitCount: 0, lastHitTime: null, connected: true,
        unlocks: []
      };
      room.players.set(playerId, player);
      room.order.push(playerId);
      ws.pas.roomCode = code;
      send(ws, { type: 'joined', code, playerId, hostId: room.hostId, players: publicPlayers(room), phase: room.phase, palette: PALETTE, teamColors: TEAM_COLORS, maps: listMapFiles(), mapFile: room.mapFile });
      broadcastPlayers(room);
      if (account) loadUnlocksInto(player, account);
      return;
    }

    const room = rooms.get(ws.pas.roomCode);
    if (!room || !ws.pas.playerId || !room.players.has(ws.pas.playerId)) return;
    const playerId = ws.pas.playerId;
    const me = room.players.get(playerId);

    switch (msg.type) {
      case 'set_map': {
        if (room.hostId !== playerId) return;
        if (room.phase !== 'lobby') return;
        const file = String(msg.file || '');
        const available = listMapFiles();
        if (file && !available.includes(file)) return;
        room.mapFile = file || null;
        // Changing the map invalidates everyone's earlier ready-up.
        room.ready.clear();
        broadcast(room, { type: 'ready_update', ready: [] });
        broadcast(room, { type: 'map_selected', mapFile: room.mapFile });
        break;
      }
      case 'ready': {
        // Generic pre-match ready-up, used by every room (2-4 players,
        // ranked or casual): the match starts the moment everyone currently
        // in the room has readied up.
        if (room.phase !== 'lobby') return;
        if (room.ready.has(playerId)) room.ready.delete(playerId);
        else room.ready.add(playerId);
        broadcast(room, { type: 'ready_update', ready: [...room.ready] });
        if (room.players.size >= 2 && room.ready.size >= room.players.size) {
          room.ready.clear();
          startTourney(room);
        }
        break;
      }
      case 'rematch': {
        if (room.phase !== 'results') return;
        if (!room.rematchReady) room.rematchReady = new Set();
        room.rematchReady.add(playerId);
        broadcast(room, { type: 'rematch_update', ready: [...room.rematchReady] });
        if (room.rematchReady.size >= room.players.size && room.players.size >= 2) {
          room.rematchReady = new Set();
          startTourney(room);
        }
        break;
      }
      case 'give_up': {
        // The seeker concedes the round early: reveal every still-hidden
        // hider's real position, then end the round exactly as if the
        // seek timer had run out.
        if (room.phase !== 'seeking') return;
        if (me.role !== 'seeker') return;
        endSeekingWithReveal(room);
        break;
      }
      case 'power_used': {
        // Just bookkeeping (e.g. the underdog bonus above) — the diamond
        // spend already happened over REST via /api/spend-power, and the
        // actual power-up effect is applied client-side.
        if (!me.usedPower) me.usedPower = new Set();
        me.usedPower.add(String(msg.key || ''));
        break;
      }
      case 'move': {
        if (room.phase !== 'hiding' && room.phase !== 'seeking') return;
        if (room.phase === 'hiding' && me.role === 'seeker') return; // seekers are frozen while hiders hide
        const x = Number(msg.x), y = Number(msg.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          me.x = Math.max(0.3, Math.min(COLS - 0.3, x));
          me.y = Math.max(0.3, Math.min(ROWS - 0.3, y));
          if (room.phase === 'hiding') {
            broadcastFiltered(room, { type: 'player_moved', id: playerId, x: me.x, y: me.y }, p => p.role === 'hider', playerId);
          } else {
            broadcast(room, { type: 'player_moved', id: playerId, x: me.x, y: me.y }, playerId);
          }
          // Footprint-trail power: seekers never see a hider's live
          // position on screen during hiding (the client covers their
          // whole view then), but the footprint-trail power-up is allowed
          // to start tracking from the very start of the hiding phase, so
          // hider moves are also sent to seekers on this separate,
          // display-inert channel regardless of phase.
          if (me.role === 'hider') {
            broadcastFiltered(room, { type: 'hider_footprint', id: playerId, x: me.x, y: me.y }, p => p.role === 'seeker');
          }
        }
        break;
      }
      case 'paint_skin': {
        if (me.role !== 'hider') return;
        const skin = msg.skin;
        const hexRe = /^#[0-9a-fA-F]{6}$/;
        if (Array.isArray(skin) && skin.length === SKIN_SIZE * SKIN_SIZE && skin.every(h => typeof h === 'string' && hexRe.test(h))) {
          me.skin = skin;
          if (room.phase === 'hiding') {
            broadcastFiltered(room, { type: 'player_skin', id: playerId, skin: me.skin }, p => p.role === 'hider', playerId);
          } else {
            broadcast(room, { type: 'player_skin', id: playerId, skin: me.skin }, playerId);
          }
        }
        break;
      }
      case 'tag': {
        if (room.phase !== 'seeking') return;
        if (me.role !== 'seeker') return;
        const target = room.players.get(msg.targetId);
        if (!target || target.role !== 'hider' || target.tagged) return;
        const dx = target.x - me.x, dy = target.y - me.y;
        if (Math.hypot(dx, dy) > TAG_RADIUS) return;
        // Cooldown so one lingering touch doesn't rack up multiple hits —
        // the seeker has to actually tap again, ideally after some
        // separation, to land the second hit.
        const now = Date.now();
        if (target.lastHitTime && now - target.lastHitTime < TAG_COOLDOWN_MS) return;
        target.lastHitTime = now;
        target.hitCount = (target.hitCount || 0) + 1;
        if (target.hitCount >= HITS_TO_CATCH) {
          target.tagged = true;
          target.tagTime = now;
          broadcast(room, { type: 'player_tagged', id: target.id, byId: me.id, tagTime: target.tagTime });
          maybeEndByNoHidersLeft(room);
        } else {
          send(target.ws, { type: 'player_hit', id: target.id, hitCount: target.hitCount });
        }
        break;
      }
      case 'set_equipment': {
        const hat = VALID_HATS.has(msg.hat) ? msg.hat : '';
        const trail = VALID_TRAILS.has(msg.trail) ? msg.trail : '';
        const unlocks = me.unlocks || [];
        me.hat = (hat === '' || unlocks.includes(`cosmetic:${hat}`)) ? hat : '';
        const trailKey = trail === 'sparkle' ? 'cosmetic:sparkletrail' : trail === 'confetti' ? 'cosmetic:confettitrail' : null;
        me.trail = (trail === '' || (trailKey && unlocks.includes(trailKey))) ? trail : '';
        broadcast(room, { type: 'player_equipment', id: playerId, hat: me.hat, trail: me.trail });
        break;
      }
      case 'play_again': {
        if (room.hostId !== playerId) return;
        if (room.phase !== 'results') return;
        room.tourney = null;
        backToLobby(room);
        break;
      }
      case 'leave': {
        removePlayer(room, playerId);
        ws.pas.roomCode = null; ws.pas.playerId = null;
        try { ws.close(); } catch {}
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.pas.roomCode);
    if (room && ws.pas.playerId) removePlayer(room, ws.pas.playerId);
    if (ws.pas.account && presenceSockets.get(ws.pas.account) === ws) {
      presenceSockets.delete(ws.pas.account);
      notifyFriendsOfPresence(ws.pas.account, false);
    }
  });
});

accounts.initDb().catch(e => console.error('[accounts] init failed:', e.message));

server.listen(PORT, () => {
  console.log(`Paint & Seek listening on :${PORT}`);
});
