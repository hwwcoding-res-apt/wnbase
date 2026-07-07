# Paint & Seek

A 2D hide-and-seek game where hiders paint their character to camouflage into
the walls, floor, and furniture around them. Up to 4 players per room, joined
by a 4-letter room code. Real-time sync runs over WebSockets, with the Node
server as the source of truth for room state, phase timers, and tag
validation.

## How it plays

1. One player creates a room and shares the 4-letter code.
2. Up to 3 more players join with that code (max 4 per room).
3. Host hits **Start**. A **15s hiding phase** begins — everyone spreads out
   and paints their character on a little 8x8 pixel canvas, using any mix of
   colors, to match the wall, rug, or furniture around them. **Sample & fill**
   grabs the dominant color under your feet, **Match pattern** auto-paints an
   approximation of the stripes/dots/checker/etc. at your spot, and you can
   always draw by hand for a pixel-perfect blend. There's no outline drawn
   around anyone but yourself (as a faint dashed ring only you can see) — a
   truly well-matched paint job is genuinely invisible to everyone else.
4. A **90s seeking phase** follows — movement and tagging are both live.
   Tap/click near another player's blob to tag them. Names are hidden for
   everyone but yourself during this phase, so it's genuinely about spotting
   camouflage, not reading labels.
5. Game ends when time runs out or only one un-tagged player remains.
   Results screen ranks everyone by how long they stayed hidden; host can
   start a new round in the same room.

## Project layout

```
server.js         Express + ws server, authoritative game/room state
public/index.html Game shell
public/style.css  Visual design (paint-studio theme)
public/game.js    Canvas rendering, input, WebSocket client
Dockerfile         Container build for Northflank (or any Docker host)
```

## Run locally

```bash
npm install
npm start
# open http://localhost:8080 in a few browser tabs/devices
```

## Deploy on Northflank

1. Push this project to a Git repo (GitHub/GitLab/Bitbucket) that Northflank
   can access, or use Northflank's "upload" build source if offered.
2. In Northflank: **Create new → Service → Deployment**, point it at the
   repo, and choose **Dockerfile** as the build method (the included
   `Dockerfile` needs no extra config).
3. Set the service's **public port** to `8080` (matches `EXPOSE 8080` /
   `ENV PORT=8080` in the Dockerfile) and enable **HTTP** with **public
   internet access** so the WebSocket upgrade on `/ws` works.
4. No environment variables or database are required — everything is
   in-memory per instance.
5. **Important:** keep this service at a single replica/instance. Rooms live
   in server memory, so if Northflank scales to multiple instances, players
   in the same room could land on different instances and never see each
   other. (A future improvement would be to back room state with Redis for
   horizontal scaling — not needed for a 4-player casual game.)
6. Once deployed, Northflank gives you a public HTTPS domain — the client
   auto-detects `https:` and upgrades to `wss://` for the socket connection,
   so no URL configuration is needed in the frontend.

## Accounts & diamonds

Players can create a username/password account from the home screen (or just
play as a guest with a name, same as before). Logged-in players earn **+2
💎 diamonds** for every match their side wins:

- Hiders: only the hiders who were never caught earn diamonds.
- Seekers: everyone on the seeker side earns diamonds when they catch every
  hider.

Guests don't earn diamonds — there's no account to save the balance to.

### Setting it up on Northflank

Accounts and balances live in Postgres (not the in-memory room state), so
they persist across restarts and multiple server instances.

1. Add a **Postgres addon** to your Northflank project (or point at any
   Postgres instance you already have).
2. Give the game service an environment variable **`DATABASE_URL`** with the
   Postgres connection string Northflank gives you for the addon.
3. Deploy — on boot the server automatically creates a `users` table if it
   doesn't exist yet (`username`, hashed password, `diamonds`,
   `lifetime_diamonds`, `wins`, `unlocks`).
4. If `DATABASE_URL` isn't set, the server still runs fine — the account
   endpoints just return an error and everyone plays as a guest.

Sessions (the token issued on login) are kept in memory, matching the rest
of this project's single-instance design — see the note above about keeping
this service at one replica.

### API surface added for this

- `POST /api/register` `{ username, password }` → `{ token, account }`
- `POST /api/login` `{ username, password }` → `{ token, account }`
- `GET /api/me?token=...` → `{ account }`
- `POST /api/logout` `{ token }`
- `POST /api/purchase` `{ token, key }` → spends diamonds on an unlock from
  the server-side `SHOP_PRICES` table in `server.js` (already priced for the
  hider/seeker power-ups, brushes, palettes, and cosmetics described in the
  project notes — wiring those into actual gameplay is the next step, the
  purchase/balance plumbing is in place).
- WebSocket `create`/`join` now accept an optional `token` field; matching
  players are credited automatically when their side wins, and everyone at
  the table gets a `balance_update` message with their fresh balance/rank.

### Rank titles

Titles are based on **lifetime diamonds earned** (not current balance, so
spending diamonds doesn't demote you): Novice Chameleon → Apprentice
Chameleon → Camo Specialist → Blend Artist → Master Forger → Legendary
Mimic. Thresholds live in `RANKS` in `accounts.js`.

## Ranked 1v1

Logged-in players can add each other as friends and challenge an online
friend to a **ranked 1v1** match, worth 6 💎 to the winner.

**Turn structure:** each round has two sub-rounds — round *N*A (player 1
seeks, player 2 hides) and round *N*B (player 2 seeks, player 1 hides). A
round only counts once both halves are played.

**Redemption rule:** the match doesn't end just because someone fails their
seek — it only ends when the two sub-rounds of the same round *disagree*:

- Both seekers find their hider, or both fail → tied, everyone advances to
  round *N*+1.
- One seeker finds their hider and the other doesn't → the successful
  seeker wins the match outright.

This is implemented in `server.js` (`createRankedMatch`, `startRankedRound`,
`endRankedSubround`, `endRankedMatch`) as a 2-player room with `mode:
'ranked'` layered on top of the same map/hide/seek/tag mechanics as a normal
match — it just overrides what happens when a seek phase ends instead of
going straight to a shared results screen.

### Friends & challenges

- `GET /api/friends?token=...` → friends (with online status), incoming and
  outgoing requests
- `POST /api/friends/request` / `/accept` / `/decline` / `/remove`
  `{ token, username }`
- WebSocket: `identify {token}` registers your connection as "online" for
  friends/challenges (sent automatically once you're logged in);
  `challenge {username}` (must be friends and that friend online);
  `challenge_response {from, accept}`.

## Notes / things you could extend

- Movement is client-reported and trusted; tag attempts are still checked
  server-side against last known positions so you can't tag from across the
  map, but there's no full anti-cheat — fine for a casual game with friends.
- If a socket drops mid-game there's no reconnect flow yet; the player would
  need to refresh and rejoin a new room. Worth adding if this becomes a
  regular hangout game.
- The 16-color palette used to paint the map is defined in both
  `server.js` and referenced by the client via the `palette` field sent on
  join, so they always match — no need to hand-edit two copies of a color
  list if you tweak the palette, just change it in `server.js`.
- The map is built from textured two-color patches (`stripes-h`, `stripes-d`,
  `dots`, `checker`, `grain`, `blotch`, `solid` — see `PATTERNS` in
  `server.js`) over a woodgrain base, so there's always more than a single
  flat color to try to match. Character paint is an 8x8 grid of pixels
  (`SKIN_SIZE` in `server.js`), sent to the server as `paint_skin` messages
  and validated there (64 entries, each a valid `#rrggbb`) before being
  relayed to everyone else in the room.
