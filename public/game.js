(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---------- Constants ----------
  const COLS = 22, ROWS = 22, CELL = 50; // bigger than what you can see at once
  const SKIN = 32; // 32x32 paintable pixels per character
  const MOVE_SPEED = 3.4; // cells / second
  const STAGE_ZOOM = 5; // how much closer the paint view is than the normal camera
  const CHAR_WORLD_R = CELL * 0.34; // character radius in world (map-pixel) units, constant regardless of zoom
  const HISTORY_LIMIT = 40;
  const TOUCH_RADIUS = (CHAR_WORLD_R * 2) / CELL; // grid-unit distance at which two characters visibly overlap
  const TAG_RESEND_MS = 400; // how often we'll re-attempt a tag against the same target while overlapping
  const GIVE_UP_OVERVIEW_MS = 1400; // stage 1: zoom out to the whole map
  const GIVE_UP_PER_HIDER_MS = 1800; // stage 2: close-up on each still-hidden hider in turn

  let PALETTE = [];
  let TEAM_COLORS = ['#6B3F69', '#5C7A4A', '#E3A93B', '#2F6E68'];

  function loadEquipment() {
    try { return JSON.parse(localStorage.getItem('pas_equipment') || '{}'); } catch { return {}; }
  }
  function saveEquipment() {
    try { localStorage.setItem('pas_equipment', JSON.stringify(S.equipment)); } catch {}
  }

  const S = {
    ws: null,
    code: null,
    playerId: null,
    hostId: null,
    phase: 'home', // home | lobby | hiding | seeking | results
    players: new Map(), // id -> {..., renderX, renderY, skin, skinCanvas}
    map: null,
    mapCanvas: null,
    availableMaps: [],
    mapFile: null,
    phaseEnd: null,
    keys: {},
    lastSent: { x: null, y: null },
    // Camera: a single unified camera drives both normal play and the
    // zoomed-in paint view, so "painting" is just zooming the same camera
    // in on the player rather than opening a separate view.
    viewScale: 1,
    camCenterX: (COLS * CELL) / 2,
    camCenterY: (ROWS * CELL) / 2,
    brush: '#6B3F69',
    brushSize: 1,
    skinDirty: false,
    painting: false,
    paintMode: false,
    keyCursor: null, // { gx, gy } — keyboard-controlled brush cursor position in skin-grid units, used by WASD/Space painting
    paintSource: null, // 'mouse' | 'key' — which input is currently driving an active paint stroke
    hoverWorld: null, // {x,y} in world px — where the brush-size preview is shown
    history: [], // undo/redo stack of skin snapshots
    historyIndex: -1,
    loopHandle: null,
    tagAttempts: new Map(), // targetId -> timestamp of our last tag attempt, so overlap doesn't spam the server
    hudInterval: null,
    account: null, // { username, diamonds, lifetimeDiamonds, wins, unlocks, rank } | null when playing as guest
    authToken: null,
    rankedMode: false,
    lobbyReady: new Set(), // Set of playerIds who've readied up in the pre-match lobby (any room mode)
    rematchReady: new Set(), // Set of playerIds who've clicked Rematch on the results screen
    rematchClicked: false, // whether *I've* clicked Rematch this results screen
    specCamX: null, specCamY: null, // free-look camera position while spectating (tagged hider)
    opponent: null,
    brushType: 'pencil', // pencil | sponge | spray — all three are free to use in-game
    equipment: { hat: '', trail: '' }, // hat/trail cosmetic keys (require unlocks)
    footprints: null, // Map(hiderId -> [{x,y}]) — see footprint_trail power-up
    pingWedge: null, // { centerAngle, until } — see direction_ping power-up
    giveUpReveal: null, // { hiders: [{id,x,y}], until } — see give_up flow
    // Power-ups are bought per-round with diamonds (see buyPower). `active`
    // tracks ones that, once bought, apply for the rest of the round
    // (no_slowdown, footprint_trail); one-shot ones (camo_helper,
    // direction_ping) don't need a flag since they just fire immediately.
    powers: { no_slowdown: false, footprint_trail: false },
    usedOnce: null, // Set of instant_once power keys already spent this round
    powerBusy: false, // guards against double-clicking a power-up button mid-request
    invertColors: false, // press C to toggle — accessibility/preference view, purely visual
    paintHoldTimer: null, // sponge/spray gradually deepen while the pointer stays down
  };
  S.equipment = Object.assign(S.equipment, loadEquipment());

  function myRole() {
    const me = S.players.get(S.playerId);
    return me ? me.role : null;
  }

  // A tagged hider has nothing left to do for the rest of the round —
  // instead of standing frozen, they get a free-roaming camera so they can
  // watch the rest of the chase play out.
  function isSpectator() {
    const me = S.players.get(S.playerId);
    return !!(me && me.role === 'hider' && me.tagged && S.phase === 'seeking');
  }

  // ---------- Toast ----------
  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast-item';
    el.textContent = msg;
    $('toast').appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ---------- Screens ----------
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    $('screen-' + name).classList.remove('hidden');
  }

  // ---------- WebSocket ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    S.ws = new WebSocket(`${proto}://${location.host}/ws`);
    S.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    });
    S.ws.addEventListener('close', () => toast('Disconnected from server.'));
    return new Promise((resolve, reject) => {
      S.ws.addEventListener('open', () => {
        if (S.authToken) send({ type: 'identify', token: S.authToken });
        resolve();
      }, { once: true });
      S.ws.addEventListener('error', reject, { once: true });
    });
  }

  function send(obj) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'created':
      case 'joined': {
        S.code = msg.code;
        S.playerId = msg.playerId;
        S.hostId = msg.hostId;
        PALETTE = msg.palette;
        TEAM_COLORS = msg.teamColors;
        setPlayers(msg.players);
        buildSwatches();
        S.availableMaps = msg.maps || [];
        S.mapFile = msg.mapFile || null;
        S.phase = msg.phase || 'lobby';
        if (S.footprints) S.footprints.clear();
        S.footprintReveal = null;
        showScreen('lobby');
        updateLobby();
        if (S.equipment.hat || S.equipment.trail) {
          send({ type: 'set_equipment', hat: S.equipment.hat || '', trail: S.equipment.trail || '' });
        }
        break;
      }
      case 'map_selected': {
        S.mapFile = msg.mapFile || null;
        updateLobby();
        break;
      }
      case 'error': {
        toast(msg.message);
        break;
      }
      case 'room_update': {
        S.hostId = msg.hostId;
        setPlayers(msg.players);
        if (S.phase === 'lobby') updateLobby();
        break;
      }
      case 'phase_change': {
        S.phase = msg.phase;
        if (msg.hostId) S.hostId = msg.hostId;
        if (msg.phase === 'lobby') {
          setPlayers(msg.players);
          if (msg.maps) S.availableMaps = msg.maps;
          S.mapFile = msg.mapFile || null;
          if (S.footprints) S.footprints.clear();
          S.footprintReveal = null;
          showScreen('lobby');
          updateLobby();
          stopGameLoop();
        } else if (msg.phase === 'hiding') {
          S.map = msg.map;
          buildMapCanvas();
          setPlayers(msg.players);
          // Every round starts with a fresh spawn position from the server.
          // renderX/renderY are only ever nudged by movement input, so
          // without this they'd stay wherever they were left last round —
          // showing up in the wrong spot (on your own screen and everyone
          // else's) until you actually move. Snap them to the real spawn.
          S.players.forEach(p => { p.renderX = p.x; p.renderY = p.y; });
          S.phaseEnd = msg.phaseEnd;
          S.powers = { no_slowdown: false, footprint_trail: false };
          S.usedOnce = new Set();
          S.giveUpReveal = null;
          showScreen('game');
          exitPaintMode(true);
          resetCameraImmediate();
          updateControlsForRole();
          renderPowersPanel();
          resetHistory();
          setBanner(myRole() === 'hider' ? 'Find a spot and paint yourself to match!' : null);
          startGameLoop();
        } else if (msg.phase === 'seeking') {
          setPlayers(msg.players);
          S.tagAttempts.clear();
          S.phaseEnd = msg.phaseEnd;
          updateControlsForRole();
          renderPowersPanel();
          setBanner(myRole() === 'seeker' ? 'Go find them!' : 'Stay hidden — or run!');
          startGameLoop();
        } else if (msg.phase === 'results') {
          stopGameLoop();
          exitPaintMode(true);
          showScreen('results');
          renderTourneyResults(msg.winnerId, msg.wins, msg.roundsPlayed, msg.mode === 'ranked');
          S.rankedMode = false;
        }
        break;
      }
      case 'player_moved': {
        const p = S.players.get(msg.id);
        if (p) { p.x = msg.x; p.y = msg.y; }
        break;
      }
      case 'hider_footprint': {
        // Display-inert: only ever used to build the footprint-trail
        // power's data, never to move/reveal anything on screen. Sent by
        // the server from the very start of the hiding phase onward, so
        // the trail already has hiding-phase history once seeking begins.
        if (myRole() === 'seeker') recordFootprint(msg.id, msg.x, msg.y);
        break;
      }
      case 'player_skin': {
        const p = S.players.get(msg.id);
        if (p) { p.skin = msg.skin; buildSkinCanvas(p); }
        break;
      }
      case 'player_hit': {
        const p = S.players.get(msg.id);
        if (p) p.hitCount = msg.hitCount;
        toast('Grazed! One more and you\'re caught.');
        break;
      }
      case 'player_tagged': {
        const p = S.players.get(msg.id);
        if (p) { p.tagged = true; p.tagTime = msg.tagTime; }
        if (msg.id === S.playerId) {
          toast('You were spotted! Spectating now — free-look with WASD/arrows.');
          const me = S.players.get(S.playerId);
          S.specCamX = me && me.renderX != null ? me.renderX * CELL : (COLS * CELL) / 2;
          S.specCamY = me && me.renderY != null ? me.renderY * CELL : (ROWS * CELL) / 2;
          updateControlsForRole();
        } else if (msg.byId === S.playerId) toast('Found one!');
        break;
      }
      case 'balance_update': {
        S.account = msg.account;
        updateAccountUI();
        if (msg.reason === 'win_underdog') toast(`+${msg.delta} 💎 — underdog bonus for outlasting a radar-using seeker!`);
        else if (msg.delta) toast(`+${msg.delta} 💎 for winning!`);
        else if (msg.reason === 'ranked_loss') toast('Ranked match lost — better luck next time!');
        break;
      }
      case 'identified': {
        refreshFriends();
        break;
      }
      case 'friend_status': {
        // Pushed the instant a friend comes online/offline (see server's
        // notifyFriendsOfPresence) — refresh right away instead of
        // waiting on the 15-second poll.
        if (S.authToken) refreshFriends();
        break;
      }
      case 'challenge_received': {
        handleChallengeReceived(msg.from);
        break;
      }
      case 'challenge_sent': {
        toast(`Waiting for ${msg.to} to respond...`);
        break;
      }
      case 'challenge_declined': {
        toast(`${msg.by} declined the challenge.`);
        break;
      }
      case 'ranked_match_start': {
        S.rankedMode = true;
        S.lobbyReady = new Set();
        S.code = msg.code;
        S.playerId = msg.playerId;
        S.hostId = msg.hostId;
        S.opponent = msg.opponent;
        PALETTE = msg.palette;
        TEAM_COLORS = msg.teamColors;
        setPlayers(msg.players);
        buildSwatches();
        S.availableMaps = msg.maps || [];
        S.mapFile = msg.mapFile || null;
        S.phase = 'lobby';
        showScreen('lobby');
        updateLobby();
        toast(`Ranked match found! You vs ${msg.opponent}`);
        break;
      }
      case 'ready_update': {
        S.lobbyReady = new Set(msg.ready || []);
        if (S.phase === 'lobby') updateLobby();
        break;
      }
      case 'rematch_update': {
        S.rematchReady = new Set(msg.ready || []);
        if (S.phase === 'results') renderRematchStatus();
        break;
      }
      case 'give_up_reveal': {
        const revealMs = msg.revealMs || (GIVE_UP_OVERVIEW_MS + Math.max(1, (msg.hiders || []).length) * GIVE_UP_PER_HIDER_MS);
        S.giveUpReveal = { hiders: msg.hiders || [], startedAt: performance.now(), until: performance.now() + revealMs };
        $('btn-give-up').classList.add('hidden');
        toast('Giving up — here\'s where they were hiding!');
        break;
      }
      case 'round_start': {
        const iAmSeeker = msg.seekerId === S.playerId;
        const seeker = S.players.get(msg.seekerId);
        const seekerName = seeker ? (iAmSeeker ? 'You are' : `${seeker.name} is`) : 'Someone is';
        toast(`Round ${msg.round}, turn ${msg.subIndex + 1}/${msg.subCount} — ${seekerName} seeking`);
        break;
      }
      case 'subround_result': {
        const seeker = S.players.get(msg.seekerId);
        const seekerName = seeker ? (msg.seekerId === S.playerId ? 'You' : seeker.name) : 'The seeker';
        toast(`${seekerName} ${msg.seekerSuccess ? 'found everyone!' : 'ran out of time.'}`);
        break;
      }
      case 'player_equipment': {
        const p = S.players.get(msg.id);
        if (p) { p.hat = msg.hat; p.trail = msg.trail; }
        break;
      }
      case 'round_advance': {
        toast(`Tied! Advancing to round ${msg.round}.`);
        break;
      }
    }
  }

  // ---------- Players ----------
  function setPlayers(list) {
    const seen = new Set();
    list.forEach(p => {
      seen.add(p.id);
      const existing = S.players.get(p.id);
      if (existing) {
        Object.assign(existing, p);
        if (p.x == null) { existing.renderX = null; existing.renderY = null; }
        if (p.skin) buildSkinCanvas(existing);
      } else {
        const fresh = { ...p, renderX: p.x, renderY: p.y, wobbleSeed: Math.random() * 1000 };
        S.players.set(p.id, fresh);
        if (p.skin) buildSkinCanvas(fresh);
      }
    });
    [...S.players.keys()].forEach(id => { if (!seen.has(id)) S.players.delete(id); });
  }

  // Tiny off-DOM canvas used as a fast image source for drawing a player's
  // painted skin onto their blob (scaled up, no smoothing = crisp
  // hand-painted pixel look).
  function buildSkinCanvas(p) {
    if (!p.skin || p.skin.length !== SKIN * SKIN) return;
    if (!p.skinCanvas) p.skinCanvas = document.createElement('canvas');
    p.skinCanvas.width = SKIN;
    p.skinCanvas.height = SKIN;
    const c = p.skinCanvas.getContext('2d');
    for (let y = 0; y < SKIN; y++) {
      for (let x = 0; x < SKIN; x++) {
        c.fillStyle = p.skin[y * SKIN + x];
        c.fillRect(x, y, 1, 1);
      }
    }
  }

  // ---------- Lobby ----------
  function updateLobby() {
    $('lobby-code').textContent = S.code;
    const wrap = $('lobby-players');
    wrap.innerHTML = '';
    [...S.players.values()].forEach(p => {
      const isReady = S.lobbyReady.has(p.id);
      const chip = document.createElement('div');
      chip.className = 'player-chip' + (p.id === S.hostId ? ' chip-host' : '') + (isReady ? ' chip-ready' : '');
      const dot = document.createElement('span');
      dot.className = 'chip-dot';
      dot.style.background = TEAM_COLORS[p.colorIndex];
      const name = document.createElement('span');
      name.textContent = p.name + (p.id === S.playerId ? ' (you)' : '');
      chip.append(dot, name);
      if (isReady) {
        const check = document.createElement('span');
        check.className = 'chip-ready-check';
        check.textContent = '✓';
        chip.append(check);
      }
      wrap.appendChild(chip);
    });

    const isHost = S.hostId === S.playerId;
    const readyBtn = $('btn-ranked-ready');
    const hint = $('lobby-hint');
    const iAmReady = S.lobbyReady.has(S.playerId);
    const readyCount = S.lobbyReady.size;
    const totalCount = S.players.size;
    readyBtn.classList.remove('hidden');
    readyBtn.textContent = iAmReady ? '✓ Ready' : 'Ready up';
    readyBtn.classList.toggle('selected', iAmReady);
    if (iAmReady) {
      hint.textContent = readyCount >= totalCount
        ? 'Starting…'
        : `Waiting on the rest of the room: ${readyCount}/${totalCount} ready…`;
    } else {
      hint.textContent = (isHost
        ? `Pick a map, then ready up — the match starts once everyone is. `
        : `Ready up whenever you're set. `) + `(${readyCount}/${totalCount} ready)`;
    }
    updateMapPicker(isHost);
    updateLoadoutCard();
  }
  $('btn-ranked-ready').addEventListener('click', () => send({ type: 'ready' }));

  // ---------- Loadout: brush type, palette, cosmetics ----------
  function updateLoadoutCard() {
    const card = $('loadout-card');
    const anyUnlock = hasUnlock('cosmetic:tophat') || hasUnlock('cosmetic:partyhat') ||
      hasUnlock('cosmetic:sparkletrail') || hasUnlock('cosmetic:confettitrail');
    card.classList.toggle('hidden', !anyUnlock);
    if (anyUnlock) {
      document.querySelectorAll('#hat-row .loadout-btn').forEach(b => {
        const key = b.dataset.hat;
        const owned = key === '' || hasUnlock(`cosmetic:${key}`);
        b.classList.toggle('hidden', !owned);
        b.classList.toggle('selected', S.equipment.hat === key);
      });
      document.querySelectorAll('#trail-row .loadout-btn').forEach(b => {
        const key = b.dataset.trail;
        const trailUnlockKey = key === 'sparkle' ? 'cosmetic:sparkletrail' : key === 'confetti' ? 'cosmetic:confettitrail' : null;
        const owned = key === '' || hasUnlock(trailUnlockKey);
        b.classList.toggle('hidden', !owned);
        b.classList.toggle('selected', S.equipment.trail === key);
      });
    }
    updateIngameBrushRow();
  }

  // All three brush types (pencil/sponge/spray) are usable in-game by
  // everyone — no shop unlock needed anymore, so this just reflects which
  // one is currently active.
  function updateIngameBrushRow() {
    document.querySelectorAll('#ingame-brush-type-row .size-btn').forEach(b => {
      const key = b.dataset.brush;
      b.classList.toggle('selected', activeBrushType() === key);
    });
  }

  function selectBrushType(key) {
    S.brushType = key;
    updateLoadoutCard();
  }

  document.querySelectorAll('#ingame-brush-type-row .size-btn').forEach(b => {
    b.addEventListener('click', () => selectBrushType(b.dataset.brush));
  });
  document.querySelectorAll('#hat-row .loadout-btn').forEach(b => {
    b.addEventListener('click', () => {
      const key = b.dataset.hat;
      if (key && !hasUnlock(`cosmetic:${key}`)) return;
      S.equipment.hat = key;
      saveEquipment();
      updateLoadoutCard();
      send({ type: 'set_equipment', hat: S.equipment.hat || '', trail: S.equipment.trail || '' });
    });
  });
  document.querySelectorAll('#trail-row .loadout-btn').forEach(b => {
    b.addEventListener('click', () => {
      const key = b.dataset.trail;
      const trailUnlockKey = key === 'sparkle' ? 'cosmetic:sparkletrail' : key === 'confetti' ? 'cosmetic:confettitrail' : null;
      if (key && !hasUnlock(trailUnlockKey)) return;
      S.equipment.trail = key;
      saveEquipment();
      updateLoadoutCard();
      send({ type: 'set_equipment', hat: S.equipment.hat || '', trail: S.equipment.trail || '' });
    });
  });

  // ---------- Map picker (lobby) ----------
  function updateMapPicker(isHost) {
    const wrap = $('map-picker');
    if (!wrap) return;
    const select = $('map-select');
    const grid = $('map-preview-grid');
    const note = $('map-picker-note');
    wrap.classList.toggle('hidden', !isHost && S.availableMaps.length === 0);

    if (S.availableMaps.length === 0) {
      select.classList.add('hidden');
      grid.classList.add('hidden');
      note.classList.remove('hidden');
      note.textContent = 'No maps uploaded yet — a plain room will be used.';
      return;
    }
    note.classList.add('hidden');
    select.classList.add('hidden'); // superseded by the thumbnail grid below, kept in sync for wiring
    grid.classList.remove('hidden');

    const optionValues = ['', ...S.availableMaps];
    const currentOptions = [...select.options].map(o => o.value);
    if (currentOptions.join('|') !== optionValues.join('|')) {
      select.innerHTML = '';
      optionValues.forEach(file => {
        const opt = document.createElement('option');
        opt.value = file;
        opt.textContent = file ? mapDisplayName(file) : 'Random map';
        select.appendChild(opt);
      });
    }
    select.value = S.mapFile || '';

    // Thumbnail grid: one tile per uploaded map (showing the actual map
    // image) plus a "Random" tile. Rebuilt only when the map list itself
    // changes — selection/lock state is patched in-place every call so
    // this doesn't re-fetch images on every lobby update.
    const gridValues = optionValues.join('|');
    if (grid.dataset.values !== gridValues) {
      grid.dataset.values = gridValues;
      grid.innerHTML = '';
      optionValues.forEach(file => {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'map-tile';
        tile.dataset.file = file;
        if (file) {
          const img = document.createElement('img');
          img.src = `/maps/${encodeURIComponent(file)}`;
          img.alt = mapDisplayName(file);
          tile.appendChild(img);
        } else {
          const placeholder = document.createElement('div');
          placeholder.className = 'map-tile-random';
          placeholder.textContent = '🎲';
          tile.appendChild(placeholder);
        }
        const label = document.createElement('span');
        label.className = 'map-tile-label';
        label.textContent = file ? mapDisplayName(file) : 'Random';
        tile.appendChild(label);
        tile.addEventListener('click', () => {
          if (!isHost) return;
          chooseMap(file);
        });
        grid.appendChild(tile);
      });
    }
    [...grid.children].forEach(tile => {
      tile.classList.toggle('selected', tile.dataset.file === (S.mapFile || ''));
      tile.classList.toggle('locked', !isHost);
      tile.disabled = !isHost;
    });
  }
  function mapDisplayName(file) {
    return file.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  }
  function chooseMap(file) {
    send({ type: 'set_map', file: file || '' });
  }
  const mapSelectEl = $('map-select');
  if (mapSelectEl) {
    mapSelectEl.addEventListener('change', () => {
      chooseMap(mapSelectEl.value);
    });
  }

  // ---------- Account (login/register/guest) ----------
  function updateAccountUI() {
    const loggedIn = !!S.account;
    $('account-logged-out').classList.toggle('hidden', loggedIn);
    $('account-logged-in').classList.toggle('hidden', !loggedIn);
    if (loggedIn) {
      $('account-name').textContent = S.account.username;
      $('account-balance').textContent = `💎 ${S.account.diamonds}`;
      $('account-rank').textContent = `${S.account.rank} · ${S.account.wins} win${S.account.wins === 1 ? '' : 's'}`;
    } else {
      $('shop-card').classList.add('hidden');
      document.querySelector('.brandmark').classList.remove('hidden');
    }
    const nameInput = $('name-input');
    if (loggedIn) {
      nameInput.value = S.account.username;
      nameInput.disabled = true;
      nameInput.placeholder = S.account.username;
    } else {
      nameInput.disabled = false;
      nameInput.value = '';
      nameInput.placeholder = 'Rembrandt';
    }
    const diamondHud = $('hud-diamonds');
    if (diamondHud) {
      diamondHud.classList.toggle('hidden', !loggedIn);
      if (loggedIn) diamondHud.textContent = `💎 ${S.account.diamonds}`;
    }
    const lobbyDiamonds = $('lobby-diamonds');
    if (lobbyDiamonds) {
      lobbyDiamonds.classList.toggle('hidden', !loggedIn);
      if (loggedIn) lobbyDiamonds.textContent = `💎 ${S.account.diamonds}`;
    }
    $('friends-card').classList.toggle('hidden', !loggedIn);
    if (loggedIn) {
      refreshFriends();
      if (!S.friendsPoll) S.friendsPoll = setInterval(refreshFriends, 15000);
    } else if (S.friendsPoll) {
      clearInterval(S.friendsPoll);
      S.friendsPoll = null;
    }
  }

  // ---------- Friends & ranked challenges ----------
  async function refreshFriends() {
    if (!S.authToken) return;
    try {
      const res = await fetch(`/api/friends?token=${encodeURIComponent(S.authToken)}`);
      if (!res.ok) return;
      const data = await res.json();
      renderFriends(data);
    } catch { /* server unreachable — leave whatever was last shown */ }
  }

  function renderFriends(data) {
    const reqBox = $('friend-requests');
    reqBox.innerHTML = '';
    (data.incoming || []).forEach(name => {
      const row = document.createElement('div');
      row.className = 'friend-request-row';
      row.innerHTML = `<span>${name} wants to be friends</span>`;
      const actions = document.createElement('div');
      actions.className = 'friend-actions';
      const accept = document.createElement('button');
      accept.className = 'btn btn-primary btn-small';
      accept.textContent = 'Accept';
      accept.addEventListener('click', () => friendAction('/api/friends/accept', name));
      const decline = document.createElement('button');
      decline.className = 'btn btn-ghost btn-small';
      decline.textContent = 'Decline';
      decline.addEventListener('click', () => friendAction('/api/friends/decline', name));
      actions.appendChild(accept); actions.appendChild(decline);
      row.appendChild(actions);
      reqBox.appendChild(row);
    });

    const listBox = $('friend-list');
    listBox.innerHTML = '';
    if ((data.friends || []).length === 0) {
      const p = document.createElement('p');
      p.className = 'hint-inline';
      p.textContent = 'No friends yet — add one by username above.';
      listBox.appendChild(p);
    }
    (data.friends || []).forEach(f => {
      const row = document.createElement('div');
      row.className = 'friend-row';
      const name = document.createElement('span');
      name.className = 'friend-name';
      name.innerHTML = `<span class="friend-online-dot${f.online ? ' online' : ''}"></span>${f.username}`;
      const actions = document.createElement('div');
      actions.className = 'friend-actions';
      const challenge = document.createElement('button');
      challenge.className = 'btn btn-primary btn-small';
      challenge.textContent = 'Challenge';
      challenge.disabled = !f.online;
      challenge.addEventListener('click', () => sendChallenge(f.username));
      actions.appendChild(challenge);
      row.appendChild(name);
      row.appendChild(actions);
      listBox.appendChild(row);
    });
  }

  async function friendAction(path, username) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: S.authToken, username }),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.message || 'Something went wrong.'); return; }
      refreshFriends();
    } catch { toast('Could not reach the server.'); }
  }

  $('btn-friend-add').addEventListener('click', () => {
    const username = $('friend-add-input').value.trim();
    if (!username) return;
    friendAction('/api/friends/request', username).then(() => { $('friend-add-input').value = ''; toast('Friend request sent!'); });
  });

  async function sendChallenge(username) {
    try { await ensureConnected(); } catch { return; }
    send({ type: 'challenge', username });
    toast(`Challenge sent to ${username}...`);
  }

  const challengeQueue = [];
  function handleChallengeReceived(from) {
    challengeQueue.push(from);
    showNextChallengeModal();
  }
  function showNextChallengeModal() {
    const modal = $('challenge-modal');
    if (!modal.classList.contains('hidden')) return; // one at a time — next shows when this one resolves
    const from = challengeQueue[0];
    if (!from) return;
    $('challenge-modal-text').textContent = `${from} is challenging you to a ranked 1v1!`;
    modal.classList.remove('hidden');
  }
  function resolveChallengeModal(accept) {
    const from = challengeQueue.shift();
    $('challenge-modal').classList.add('hidden');
    if (from) send({ type: 'challenge_response', from, accept });
    showNextChallengeModal();
  }
  $('challenge-accept').addEventListener('click', () => resolveChallengeModal(true));
  $('challenge-decline').addEventListener('click', () => resolveChallengeModal(false));

  async function restoreSession() {
    const token = localStorage.getItem('pas_token');
    if (!token) return;
    try {
      const res = await fetch(`/api/me?token=${encodeURIComponent(token)}`);
      if (!res.ok) { localStorage.removeItem('pas_token'); return; }
      const data = await res.json();
      S.authToken = token;
      S.account = data.account;
      updateAccountUI();
      try { await ensureConnected(); send({ type: 'identify', token: S.authToken }); } catch { /* will retry when they interact */ }
    } catch { /* server unreachable yet — ignore, home screen still works */ }
  }
  restoreSession();

  async function authRequest(path) {
    const username = $('auth-username').value.trim();
    const password = $('auth-password').value;
    if (!username || !password) { toast('Enter a username and password.'); return; }
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.message || 'Something went wrong.'); return; }
      S.authToken = data.token;
      S.account = data.account;
      localStorage.setItem('pas_token', data.token);
      $('auth-password').value = '';
      updateAccountUI();
      try { await ensureConnected(); send({ type: 'identify', token: S.authToken }); } catch { /* will retry when they interact */ }
      toast(`Welcome, ${data.account.username}!`);
    } catch {
      toast('Could not reach the server.');
    }
  }
  $('btn-login').addEventListener('click', () => authRequest('/api/login'));
  $('btn-register').addEventListener('click', () => authRequest('/api/register'));
  $('btn-logout').addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: S.authToken }) }); } catch {}
    localStorage.removeItem('pas_token');
    S.authToken = null;
    S.account = null;
    updateAccountUI();
  });

  // ---------- Shop ----------
  // Mirrors server.js SHOP_PRICES — prices are still trusted from the
  // server on actual purchase, this list is just for display.
  const SHOP_ITEMS = [
    { key: 'cosmetic:tophat', label: '🎩 Top hat', price: 6, desc: 'Cosmetic — hides automatically while you\u2019re actively hiding.' },
    { key: 'cosmetic:partyhat', label: '🥳 Party hat', price: 6, desc: 'Cosmetic — hides automatically while you\u2019re actively hiding.' },
    { key: 'cosmetic:sparkletrail', label: '✨ Sparkle trail', price: 10, desc: 'Cosmetic movement trail — hides automatically while hiding.' },
    { key: 'cosmetic:confettitrail', label: '🎊 Confetti trail', price: 10, desc: 'Cosmetic movement trail — hides automatically while hiding.' },
  ];

  function renderShop() {
    const list = $('shop-list');
    list.innerHTML = '';
    const owned = (S.account && S.account.unlocks) || [];
    SHOP_ITEMS.forEach(item => {
      const row = document.createElement('div');
      row.className = 'friend-row';
      const info = document.createElement('span');
      info.innerHTML = `<strong>${item.label}</strong><br><span class="hint-inline">${item.desc}</span>`;
      const actions = document.createElement('div');
      actions.className = 'friend-actions';
      const isOwned = owned.includes(item.key);
      const btn = document.createElement('button');
      btn.className = 'btn btn-small ' + (isOwned ? 'btn-ghost' : 'btn-primary');
      btn.textContent = isOwned ? 'Owned' : `Buy · 💎${item.price}`;
      btn.disabled = isOwned || !S.account || S.account.diamonds < item.price;
      btn.addEventListener('click', () => buyItem(item.key));
      actions.appendChild(btn);
      row.appendChild(info);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  async function buyItem(key) {
    if (!S.authToken) return;
    try {
      const res = await fetch('/api/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: S.authToken, key }),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.message || 'Purchase failed.'); return; }
      S.account = data.account;
      updateAccountUI();
      renderShop();
      updateLoadoutCard();
      toast('Unlocked!');
    } catch { toast('Could not reach the server.'); }
  }

  $('btn-open-shop').addEventListener('click', () => {
    const shopOpen = !$('shop-card').classList.contains('hidden');
    if (shopOpen) {
      $('shop-card').classList.add('hidden');
      document.querySelector('.brandmark').classList.remove('hidden');
    } else {
      renderShop();
      $('shop-card').classList.remove('hidden');
      document.querySelector('.brandmark').classList.add('hidden');
    }
  });

  // ---------- Home screen ----------
  $('btn-show-create').addEventListener('click', () => {
    $('home-actions').classList.remove('hidden');
    $('join-fields').classList.add('hidden');
    doCreate();
  });
  $('btn-show-join').addEventListener('click', () => {
    $('join-fields').classList.remove('hidden');
  });
  $('btn-cancel-join').addEventListener('click', () => {
    $('join-fields').classList.add('hidden');
  });
  $('btn-join').addEventListener('click', () => doJoin());
  $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  $('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

  async function ensureConnected() {
    if (!S.ws || S.ws.readyState !== 1) {
      try { await connect(); } catch { toast('Could not reach the server.'); throw new Error('no-conn'); }
    }
  }

  function currentDisplayName() {
    if (S.account) return S.account.username;
    const typed = $('name-input').value.trim() || 'Painter';
    return typed.startsWith('Guest ') ? typed : `Guest ${typed}`;
  }

  async function doCreate() {
    try { await ensureConnected(); } catch { return; }
    send({ type: 'create', name: currentDisplayName(), token: S.authToken || undefined });
  }

  async function doJoin() {
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 4) { toast('Enter a 4-letter room code.'); return; }
    try { await ensureConnected(); } catch { return; }
    send({ type: 'join', code, name: currentDisplayName(), token: S.authToken || undefined });
  }

  $('btn-copy-code').addEventListener('click', () => {
    navigator.clipboard?.writeText(S.code).then(() => toast('Code copied!')).catch(() => {});
  });

  $('btn-leave-lobby').addEventListener('click', leaveRoom);
  $('btn-leave-results').addEventListener('click', leaveRoom);
  function leaveRoom() {
    send({ type: 'leave' });
    stopGameLoop();
    S.players.clear();
    S.phase = 'home';
    showScreen('home');
  }

  $('btn-play-again').addEventListener('click', () => send({ type: 'play_again' }));

  // Power-up: direction ping — shows a wide 120°-wide wedge toward the
  // hider rather than a precise arrow: the wedge's center is offset by a
  // random amount up to ±60° from the true bearing, and the wedge itself
  // spans ±60° around that center, so the true direction always falls
  // somewhere inside it, but never at a knowable exact angle. One-time use
  // — bought fresh each ping from the left power-up panel (see buyPower).
  const PING_SHOW_MS = 1000;
  const PING_WEDGE_HALF = Math.PI / 3; // 60° either side of center = 120° total
  function fireDirectionPing() {
    const me = S.players.get(S.playerId);
    if (!me || me.renderX == null) return false;
    let best = null, bestDist = Infinity;
    S.players.forEach(p => {
      if (p.role !== 'hider' || p.tagged || p.renderX == null) return;
      const d = Math.hypot(p.renderX - me.renderX, p.renderY - me.renderY);
      if (d < bestDist) { bestDist = d; best = p; }
    });
    if (!best) { toast('No hiders left to ping.'); return false; }
    const trueAngle = Math.atan2(best.renderY - me.renderY, best.renderX - me.renderX);
    const offsetDeg = (Math.random() * 2 - 1) * 60; // ±60° — wedge center offset from the true bearing
    const centerAngle = trueAngle + offsetDeg * (Math.PI / 180);
    S.pingWedge = { centerAngle, until: performance.now() + PING_SHOW_MS };
    return true;
  }

  function drawPingWedge() {
    if (!S.pingWedge) return;
    if (performance.now() > S.pingWedge.until) { S.pingWedge = null; return; }
    const me = S.players.get(S.playerId);
    if (!me || me.x == null) return;
    const meWorldX = (me.renderX != null ? me.renderX : me.x) * CELL;
    const meWorldY = (me.renderY != null ? me.renderY : me.y) * CELL;
    const { x: sx, y: sy } = worldToScreen(meWorldX, meWorldY);
    const r = Math.max(canvas.width, canvas.height) * 1.3;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.arc(sx, sy, r, S.pingWedge.centerAngle - PING_WEDGE_HALF, S.pingWedge.centerAngle + PING_WEDGE_HALF);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ---------- Power-up: footprint trail (seeker) ----------
  // Recording starts the moment the hiding phase begins, not when seeking
  // does — hider positions are never shown on a seeker's screen during
  // hiding (the client covers the whole view then), but the server sends
  // hider moves to seekers on a separate, display-inert 'hider_footprint'
  // channel (see case 'hider_footprint' above) purely so this power-up's
  // data can start accumulating early. The trail is kept in FULL for the
  // ENTIRE MATCH (no cap/trimming, and not reset between rounds — only
  // cleared when a fresh match/lobby begins). Each purchase plays the
  // entire recorded trail through EXACTLY ONCE, in order from oldest to
  // newest (one quick flash per footprint), and then stops — it does not
  // loop. Buying again queues a fresh single playback of the (now longer)
  // trail, so this is a repeatable, multi-purchase power.
  const FOOTPRINT_MIN_DIST = 0.35; // cells — don't log a new footprint for tiny jitters
  const FOOTPRINT_STEP_MS_BASE = 130; // spacing between footprints in a short trail (2x speed)
  const FOOTPRINT_REVEAL_MAX_MS = 3000; // cap total playback time for very long trails (2x speed)
  const FOOTPRINT_FLASH_MS = 50; // each footprint flashes at full brightness for exactly this long
  const FOOTPRINT_FADE_MS = 110; // ...then rapidly fades into the background

  function recordFootprint(id, x, y) {
    if (!S.footprints) S.footprints = new Map();
    let trail = S.footprints.get(id);
    if (!trail) { trail = []; S.footprints.set(id, trail); }
    const last = trail[trail.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < FOOTPRINT_MIN_DIST) return;
    trail.push({ x, y }); // kept forever (for the round) — no trimming
  }

  // Triggered by a purchase: snapshots each hider's FULL currently-recorded
  // trail (every footprint since seeking began, nothing dropped) and
  // schedules a single one-shot playback starting now, oldest to newest.
  function fireFootprintTrail() {
    if (!S.footprints || !S.footprints.size) { toast('No footprints recorded yet.'); return false; }
    const now = performance.now();
    const reveal = new Map();
    S.footprints.forEach((trail, id) => {
      if (!trail.length) return;
      // Adaptive spacing: short trails flash at the normal pace; long
      // trails compress their spacing (down to a floor) so the whole
      // ordered sequence still finishes within a bounded time.
      const stepMs = Math.max(
        FOOTPRINT_FLASH_MS + 20,
        Math.min(FOOTPRINT_STEP_MS_BASE, FOOTPRINT_REVEAL_MAX_MS / trail.length)
      );
      reveal.set(id, { trail: trail.slice(), startedAt: now, stepMs });
    });
    if (!reveal.size) { toast('No footprints recorded yet.'); return false; }
    S.footprintReveal = reveal;
    return true;
  }

  function drawFootprints(t) {
    if (!S.footprintReveal || S.phase !== 'seeking' || myRole() !== 'seeker') return;
    const now = performance.now();
    S.footprintReveal.forEach((entry, id) => {
      const { trail, startedAt, stepMs } = entry;
      const p = S.players.get(id);
      const totalMs = trail.length * stepMs;
      const elapsed = now - startedAt;
      if (!p || p.tagged || !trail.length || elapsed >= totalMs) {
        S.footprintReveal.delete(id); // played through once, in full — done, no looping
        return;
      }
      const idx = Math.floor(elapsed / stepMs);
      const within = elapsed - idx * stepMs;
      let alpha = 0;
      if (within < FOOTPRINT_FLASH_MS) {
        alpha = 1;
      } else if (within < FOOTPRINT_FLASH_MS + FOOTPRINT_FADE_MS) {
        alpha = 1 - (within - FOOTPRINT_FLASH_MS) / FOOTPRINT_FADE_MS;
      }
      if (alpha <= 0) return;
      const fp = trail[idx];
      const { x: sx, y: sy } = worldToScreen(fp.x * CELL, fp.y * CELL);
      ctx.save();
      // A soft glowing decal rather than a flat dot — reads as a quick
      // digitized "ping" flash rather than a lingering footprint mark.
      const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, 9 * S.viewScale);
      grad.addColorStop(0, `rgba(240,210,122,${alpha})`);
      grad.addColorStop(1, `rgba(240,210,122,0)`);
      ctx.globalAlpha = 1;
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(sx, sy, 9 * S.viewScale, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#F0D27A';
      ctx.beginPath();
      ctx.arc(sx, sy, 4 * S.viewScale, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  // ---------- Map rendering: image-based maps ----------
  // The host picks a map image (from the server's /maps folder); every
  // client just loads that same image and stretches it to fill the fixed
  // world size (cols x rows cells). No procedural generation, no per-client
  // drift — everyone loads the same file.
  const FALLBACK_MAP_COLOR = '#3A3F4A';
  const mapImageCache = new Map(); // url -> HTMLImageElement (loaded)

  function loadMapImage(url) {
    if (mapImageCache.has(url)) return Promise.resolve(mapImageCache.get(url));
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { mapImageCache.set(url, img); resolve(img); };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  async function buildMapCanvas() {
    const w = S.map.cols * CELL, h = S.map.rows * CELL;
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const c = off.getContext('2d');
    S.mapCanvas = off;

    // Draw a plain placeholder immediately so the game is playable even
    // before (or if) the image finishes loading.
    c.fillStyle = FALLBACK_MAP_COLOR;
    c.fillRect(0, 0, w, h);

    const file = S.map && S.map.file;
    if (!file) return;
    const img = await loadMapImage(`/maps/${encodeURIComponent(file)}`);
    // Bail out if a newer map has since been loaded (fast phase changes).
    if (S.mapCanvas !== off) return;
    if (img) c.drawImage(img, 0, 0, w, h);
  }

  // Reads the actual rendered color of the map at a given point in map
  // pixel-space. Works no matter how the background was generated.
  function sampleMapPixel(mapPx, mapPy) {
    if (!S.mapCanvas) return '#888888';
    const c = S.mapCanvas.getContext('2d');
    const x = Math.max(0, Math.min(S.mapCanvas.width - 1, Math.floor(mapPx)));
    const y = Math.max(0, Math.min(S.mapCanvas.height - 1, Math.floor(mapPy)));
    const d = c.getImageData(x, y, 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  // ---------- Paint controls ----------
  function activePalette() {
    return PALETTE;
  }

  function buildSwatches() {
    const wrap = $('swatches');
    wrap.innerHTML = '';
    activePalette().forEach(hex => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = hex;
      b.title = hex;
      b.addEventListener('click', () => setBrush(hex));
      wrap.appendChild(b);
    });
    setBrush(S.brush);
  }

  function setBrush(hex) {
    S.brush = hex;
    $('brush-preview').style.background = hex;
    $('color-picker').value = hex;
    document.querySelectorAll('.swatch').forEach(el => {
      el.classList.toggle('selected', el.style.background === hexToRgbStr(hex) || el.title.toLowerCase() === hex.toLowerCase());
    });
  }

  function hexToRgbStr(hex) {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  }

  $('color-picker').addEventListener('input', (e) => setBrush(e.target.value));

  document.querySelectorAll('#brush-size-row .size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      S.brushSize = parseInt(btn.dataset.size, 10);
      document.querySelectorAll('#brush-size-row .size-btn').forEach(b => b.classList.toggle('selected', b === btn));
    });
  });

  function fillSkin(hex) {
    const me = S.players.get(S.playerId);
    if (!me) return;
    me.skin = new Array(SKIN * SKIN).fill(hex);
    buildSkinCanvas(me);
    flushSkinNow();
    historyPush();
  }

  $('btn-reset-skin').addEventListener('click', () => {
    const me = S.players.get(S.playerId);
    if (!me) return;
    fillSkin(TEAM_COLORS[me.colorIndex % TEAM_COLORS.length]);
  });

  // Power-up: "auto-blend" — picks up to CAMO_MAX_PARTS colors straight
  // out of the background palette under the character (the actual sampled
  // colors, not blended averages), chosen to be as far apart from each
  // other as possible (greedy farthest-point sampling in RGB space).
  // Colors that don't actually differ enough from one already picked
  // (within CAMO_MERGE_THRESHOLD) are merged away rather than kept as a
  // near-duplicate — so a fairly uniform background collapses down to as
  // few as 1 color, while a busy, varied one keeps up to CAMO_MAX_PARTS.
  // Every skin cell is then recolored to whichever surviving color it's
  // closest to. Bought fresh each use from the left power-up panel (see
  // buyPower).
  const CAMO_MAX_PARTS = 5; // never more than this many color regions
  const CAMO_MERGE_THRESHOLD = 45; // colors closer than this (0-441 scale) count as "the same"
  const colorDist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // Greedily picks up to `k` colors from `rgb` that are maximally spread
  // apart: starts from the color farthest from the overall average, then
  // keeps adding whichever remaining color has the largest distance to
  // its nearest already-chosen color. Any candidate that ends up within
  // `mergeThreshold` of a color already kept is dropped instead of added,
  // so the final palette can end up smaller than k if the background
  // doesn't actually have that many distinct colors in it.
  function pickSpreadColors(rgb, k, mergeThreshold) {
    const n = rgb.length;
    const mean = [0, 0, 0];
    rgb.forEach(c => { mean[0] += c[0]; mean[1] += c[1]; mean[2] += c[2]; });
    mean[0] /= n; mean[1] /= n; mean[2] /= n;

    let firstIdx = 0, bestD = -1;
    for (let i = 0; i < n; i++) {
      const d = colorDist3(rgb[i], mean);
      if (d > bestD) { bestD = d; firstIdx = i; }
    }
    const kept = [rgb[firstIdx]];
    const nearestKeptDist = rgb.map(c => colorDist3(c, kept[0]));

    while (kept.length < k) {
      let idx = -1, best = -1;
      for (let i = 0; i < n; i++) {
        if (nearestKeptDist[i] > best) { best = nearestKeptDist[i]; idx = i; }
      }
      if (idx === -1 || best < mergeThreshold) break; // nothing left differs enough — stop, don't pad with near-duplicates
      kept.push(rgb[idx]);
      for (let i = 0; i < n; i++) {
        const d = colorDist3(rgb[i], kept[kept.length - 1]);
        if (d < nearestKeptDist[i]) nearestKeptDist[i] = d;
      }
    }
    return kept;
  }

  function fireCamoHelper() {
    const me = S.players.get(S.playerId);
    if (!me || me.x == null || !S.mapCanvas) return false;
    const meWorldX = (me.renderX != null ? me.renderX : me.x) * CELL;
    const meWorldY = (me.renderY != null ? me.renderY : me.y) * CELL;
    const px2world = (CHAR_WORLD_R * 2) / SKIN;

    // Sample the real background color at every skin cell's own world
    // position, as [r,g,b] for distance comparisons.
    const rgb = new Array(SKIN * SKIN);
    for (let gy = 0; gy < SKIN; gy++) {
      for (let gx = 0; gx < SKIN; gx++) {
        const wx = meWorldX - CHAR_WORLD_R + (gx + 0.5) * px2world;
        const wy = meWorldY - CHAR_WORLD_R + (gy + 0.5) * px2world;
        const n = parseInt(sampleMapPixel(wx, wy).slice(1), 16);
        rgb[gy * SKIN + gx] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      }
    }

    // Choose up to CAMO_MAX_PARTS spread-apart real colors from the
    // sampled palette (fewer if the background is too uniform for that
    // many to actually differ), then paint every cell with whichever
    // surviving color it's nearest to — a palette swap, not a blend.
    const anchors = pickSpreadColors(rgb, CAMO_MAX_PARTS, CAMO_MERGE_THRESHOLD);
    const anchorHex = anchors.map(c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join(''));

    const skin = new Array(SKIN * SKIN);
    for (let idx = 0; idx < SKIN * SKIN; idx++) {
      let best = 0, bestD = Infinity;
      for (let a = 0; a < anchors.length; a++) {
        const d = colorDist3(rgb[idx], anchors[a]);
        if (d < bestD) { bestD = d; best = a; }
      }
      skin[idx] = anchorHex[best];
    }

    me.skin = skin;
    buildSkinCanvas(me);
    flushSkinNow();
    historyPush();
    toast(`Auto-blended — simplified into ${anchors.length} color part${anchors.length === 1 ? '' : 's'}.`);
    return true;
  }


  let lastSkinSend = 0;
  function flushSkinNow() {
    const me = S.players.get(S.playerId);
    if (!me || !me.skin) return;
    S.skinDirty = false;
    lastSkinSend = performance.now();
    send({ type: 'paint_skin', skin: me.skin });
  }

  // ---------- Undo / redo ----------
  function resetHistory() {
    S.history = [];
    S.historyIndex = -1;
    const me = S.players.get(S.playerId);
    if (me && me.skin) historyPush();
    else updateUndoRedoButtons();
  }
  function historyPush() {
    const me = S.players.get(S.playerId);
    if (!me || !me.skin) return;
    S.history = S.history.slice(0, S.historyIndex + 1);
    S.history.push(me.skin.slice());
    if (S.history.length > HISTORY_LIMIT) S.history.shift();
    S.historyIndex = S.history.length - 1;
    updateUndoRedoButtons();
  }
  function historyUndo() {
    if (S.historyIndex <= 0) return;
    S.historyIndex--;
    applyHistorySkin(S.history[S.historyIndex]);
  }
  function historyRedo() {
    if (S.historyIndex >= S.history.length - 1) return;
    S.historyIndex++;
    applyHistorySkin(S.history[S.historyIndex]);
  }
  function applyHistorySkin(skin) {
    const me = S.players.get(S.playerId);
    if (!me) return;
    me.skin = skin.slice();
    buildSkinCanvas(me);
    flushSkinNow();
    updateUndoRedoButtons();
  }
  function updateUndoRedoButtons() {
    $('btn-undo').disabled = S.historyIndex <= 0;
    $('btn-redo').disabled = S.historyIndex >= S.history.length - 1;
  }
  $('btn-undo').addEventListener('click', historyUndo);
  $('btn-redo').addEventListener('click', historyRedo);

  // ---------- Paint mode: zoom into the player to paint, in place ----------
  // There's no separate modal — "painting" is the same camera zoomed in on
  // the player, with controls sliding into the side margin. Clicking the
  // paint button again zooms back out.
  function hasUnlock(key) {
    return !!(S.account && Array.isArray(S.account.unlocks) && S.account.unlocks.includes(key));
  }

  function updateControlsForRole() {
    const role = myRole();
    const me = S.players.get(S.playerId);
    const iAmHider = role === 'hider' && !(me && me.tagged);
    $('btn-open-paint').classList.toggle('hidden', !iAmHider);
    $('btn-give-up').classList.toggle('hidden', !(role === 'seeker' && S.phase === 'seeking'));
    if (myRole() !== 'seeker' || S.phase !== 'seeking') S.pingWedge = null;
    updateIngameBrushRow();
    renderPowersPanel();
  }

  $('btn-give-up').addEventListener('click', () => {
    if (myRole() !== 'seeker' || S.phase !== 'seeking') return;
    $('btn-give-up').classList.add('hidden');
    send({ type: 'give_up' });
  });

  // ---------- Power-ups (left panel, in-game, per-round consumable) ----------
  // Each costs diamonds *every* time it's used (not a one-time account
  // unlock) — buying camo_helper/direction_ping fires them immediately;
  // no_slowdown/footprint_trail turn on for the rest of the round.
  const POWER_DEFS = [
    { key: 'power:camo_helper', role: 'hider', label: '🌫️ Auto-blend', price: 8, kind: 'instant',
      desc: 'Picks up to 5 spread-apart colors from your surroundings and wears them.' },
    { key: 'power:no_slowdown', role: 'hider', label: '🏃 No slowdown', price: 2, kind: 'round',
      desc: 'Keep full movement speed once seeking starts, for the rest of this round.' },
    { key: 'power:direction_ping', role: 'seeker', label: '🧭 Direction ping', price: 2, kind: 'instant_once',
      desc: 'A 120°-wide shaded wedge toward the nearest hider for 1 second — the true direction is somewhere inside it. One use per round.' },
    { key: 'power:footprint_trail', role: 'seeker', label: '👣 Footprint trail', price: 8, kind: 'instant',
      desc: 'Reveals a hider\u2019s entire path this round, in order, one quick flash at a time. Buy again for another look.' },
  ];
  const powerShortKey = (key) => key.split(':')[1];

  function renderPowersPanel() {
    const list = $('powers-list');
    if (!list) return;
    const role = myRole();
    list.innerHTML = '';
    if (isSpectator()) return; // nothing to buy once you're just watching
    POWER_DEFS.filter(def => def.role === role).forEach(def => {
      const short = powerShortKey(def.key);
      const isActive = def.kind === 'round' && S.powers[short];
      const isUsedUp = def.kind === 'instant_once' && S.usedOnce && S.usedOnce.has(def.key);
      const card = document.createElement('div');
      card.className = 'power-card' + (isActive ? ' active' : '');
      const title = document.createElement('div');
      title.className = 'power-card-title';
      title.textContent = def.label;
      const desc = document.createElement('p');
      desc.className = 'hint-inline';
      desc.textContent = def.desc;
      const btn = document.createElement('button');
      btn.className = 'btn btn-small ' + ((isActive || isUsedUp) ? 'btn-ghost' : 'btn-primary');
      if (isActive) {
        btn.textContent = 'Active this round';
        btn.disabled = true;
      } else if (isUsedUp) {
        btn.textContent = 'Used this round';
        btn.disabled = true;
      } else {
        btn.textContent = `Buy · 💎${def.price}`;
        btn.disabled = S.powerBusy || !S.account || S.account.diamonds < def.price;
        btn.addEventListener('click', () => buyPower(def));
      }
      card.appendChild(title);
      card.appendChild(desc);
      card.appendChild(btn);
      list.appendChild(card);
    });
  }

  async function buyPower(def) {
    if (S.powerBusy || !S.authToken) { if (!S.authToken) toast('Log in to use power-ups.'); return; }
    if (def.kind === 'instant_once' && S.usedOnce && S.usedOnce.has(def.key)) return;
    S.powerBusy = true;
    renderPowersPanel();
    try {
      const res = await fetch('/api/spend-power', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: S.authToken, key: def.key }),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.message || 'Could not buy that.'); return; }
      S.account = data.account;
      updateAccountUI();
      const short = powerShortKey(def.key);
      if (def.kind === 'instant_once') {
        if (!S.usedOnce) S.usedOnce = new Set();
        S.usedOnce.add(def.key);
      }
      if (def.key === 'power:footprint_trail') {
        send({ type: 'power_used', key: def.key });
        const revealed = fireFootprintTrail();
        if (revealed) toast(`${def.label} revealed!`);
      } else if (def.kind === 'round') {
        S.powers[short] = true;
        toast(`${def.label} active for the rest of the round!`);
      } else if (def.key === 'power:camo_helper') {
        fireCamoHelper();
      } else if (def.key === 'power:direction_ping') {
        fireDirectionPing();
      }
    } catch {
      toast('Could not reach the server.');
    } finally {
      S.powerBusy = false;
      renderPowersPanel();
    }
  }

  $('btn-open-paint').addEventListener('click', () => {
    if (S.paintMode) exitPaintMode(); else enterPaintMode();
  });

  function enterPaintMode() {
    S.paintMode = true;
    S.hoverWorld = null;
    S.keyCursor = { gx: Math.floor(SKIN / 2), gy: Math.floor(SKIN / 2) };
    syncHoverFromKeyCursor();
    $('panel-paint').classList.add('panel-visible');
    $('btn-open-paint').textContent = '🔍 Zoom back out';
    $('btn-open-paint').classList.add('painting');
    $('move-hint').classList.add('hidden');
  }
  function exitPaintMode(snapCamera) {
    S.paintMode = false;
    S.painting = false;
    stopPaintHold();
    S.hoverWorld = null;
    S.keyCursor = null;
    $('panel-paint').classList.remove('panel-visible');
    $('btn-open-paint').textContent = '🎨 Paint yourself';
    $('btn-open-paint').classList.remove('painting');
    $('move-hint').classList.remove('hidden');
    if (snapCamera) { S.viewScale = 1; }
  }
  function resetCameraImmediate() {
    const target = cameraTarget(S.viewScale);
    S.camCenterX = target.x;
    S.camCenterY = target.y;
  }

  // ---------- Game canvas / unified camera ----------
  const canvas = $('game-canvas');
  const ctx = canvas.getContext('2d');
  const canvasWrap = document.querySelector('.canvas-wrap-full');

  function resizeCanvas() {
    const rect = canvasWrap.getBoundingClientRect();
    const w = Math.max(200, Math.round(rect.width));
    const h = Math.max(200, Math.round(rect.height));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  if (window.ResizeObserver) new ResizeObserver(resizeCanvas).observe(canvasWrap);
  else window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function clampCenter(target, viewSize, mapSize) {
    if (viewSize >= mapSize) return mapSize / 2;
    return Math.max(viewSize / 2, Math.min(mapSize - viewSize / 2, target));
  }

  // Where the camera wants to be for a given zoom scale: normal play tracks
  // the player loosely (clamped to the map edges); paint mode tracks the
  // player exactly, since the whole point is to center them for painting.
  function cameraTarget(scale) {
    const mapW = COLS * CELL, mapH = ROWS * CELL;
    const viewW = canvas.width / scale, viewH = canvas.height / scale;
    if (isSpectator() && S.specCamX != null) {
      return { x: clampCenter(S.specCamX, viewW, mapW), y: clampCenter(S.specCamY, viewH, mapH) };
    }
    const me = S.players.get(S.playerId);
    const px = me && me.renderX != null ? me.renderX * CELL : (COLS * CELL) / 2;
    const py = me && me.renderY != null ? me.renderY * CELL : (ROWS * CELL) / 2;
    return { x: clampCenter(px, viewW, mapW), y: clampCenter(py, viewH, mapH) };
  }

  // Give-up reveal camera: stage 1 pulls all the way out to show the whole
  // map (so the seeker sees *where* everyone was relative to the level),
  // then stage 2 pushes in close on each still-hidden hider in turn (so
  // they can actually see how well each one blended in). Returns null when
  // no reveal is in progress, so the normal camera takes over as usual.
  function giveUpCameraTarget() {
    const reveal = S.giveUpReveal;
    if (!reveal) return null;
    const hiders = reveal.hiders.filter(h => h.x != null && h.y != null);
    const mapW = COLS * CELL, mapH = ROWS * CELL;
    const elapsed = performance.now() - reveal.startedAt;

    if (elapsed < GIVE_UP_OVERVIEW_MS || hiders.length === 0) {
      const fitScale = Math.min(canvas.width / mapW, canvas.height / mapH) * 0.9;
      return { scale: fitScale, x: mapW / 2, y: mapH / 2 };
    }
    const idx = Math.min(hiders.length - 1, Math.floor((elapsed - GIVE_UP_OVERVIEW_MS) / GIVE_UP_PER_HIDER_MS));
    const h = hiders[idx];
    return { scale: STAGE_ZOOM * 0.8, x: h.x * CELL, y: h.y * CELL };
  }

  function updateCamera(dt) {
    const giveUp = giveUpCameraTarget();
    const targetScale = giveUp ? giveUp.scale : (S.paintMode ? STAGE_ZOOM : (isSpectator() ? 0.62 : 1));
    const ease = Math.min(1, dt * 7);
    S.viewScale += (targetScale - S.viewScale) * ease;
    if (Math.abs(targetScale - S.viewScale) < 0.01) S.viewScale = targetScale;
    const target = giveUp ? { x: giveUp.x, y: giveUp.y } : cameraTarget(S.viewScale);
    S.camCenterX += (target.x - S.camCenterX) * ease;
    S.camCenterY += (target.y - S.camCenterY) * ease;
  }

  function worldToScreen(wx, wy) {
    return {
      x: (wx - S.camCenterX) * S.viewScale + canvas.width / 2,
      y: (wy - S.camCenterY) * S.viewScale + canvas.height / 2
    };
  }
  function screenToWorld(px, py) {
    return {
      x: (px - canvas.width / 2) / S.viewScale + S.camCenterX,
      y: (py - canvas.height / 2) / S.viewScale + S.camCenterY
    };
  }

  function blobPath(cx, cy, baseR) {
    const path = new Path2D();
    path.arc(cx, cy, baseR, 0, Math.PI * 2);
    return path;
  }

  function drawTrail(p) {
    // Cosmetic trails give away a hider's position just as much as a hat
    // does — keep them hidden the whole time a hider is uncaught (hiding
    // AND seeking phases), not just during the initial hiding phase.
    if (!p.trail || !p._trailPts || !p._trailPts.length) return;
    if (p.role === 'hider' && !p.tagged && S.phase !== 'results') return;
    const glyph = p.trail === 'confetti' ? '🎊' : '✨';
    p._trailPts.forEach((pt, i) => {
      const alpha = ((i + 1) / p._trailPts.length) * 0.7;
      const { x, y } = worldToScreen(pt.x * CELL, pt.y * CELL);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `${14 * S.viewScale}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(glyph, x, y);
      ctx.restore();
    });
  }

  function drawHat(cx, cy, baseR, p) {
    if (!p.hat) return;
    if (p.role === 'hider' && !p.tagged && S.phase !== 'results') return;
    const glyph = p.hat === 'partyhat' ? '🥳' : '🎩';
    ctx.save();
    ctx.font = `${baseR * 1.3}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(glyph, cx, cy - baseR * 0.9);
    ctx.restore();
  }

  function drawPlayer(p, t) {
    if (p.renderX == null || p.renderY == null) return; // hidden from us right now
    drawTrail(p);
    const { x: cx, y: cy } = worldToScreen(p.renderX * CELL, p.renderY * CELL);
    const baseR = CHAR_WORLD_R * S.viewScale;
    if (cx < -baseR - 60 || cy < -baseR - 60 || cx > canvas.width + baseR + 60 || cy > canvas.height + baseR + 60) return;
    const isMe = p.id === S.playerId;
    const spectating = isSpectator();
    const showName = isMe || S.phase !== 'seeking' || S.phase === 'results' || spectating;
    const path = blobPath(cx, cy, baseR);

    ctx.save();
    if (p.tagged) ctx.globalAlpha = 0.35;

    ctx.save();
    ctx.clip(path);
    ctx.imageSmoothingEnabled = false;
    if (p.skinCanvas) {
      ctx.drawImage(p.skinCanvas, cx - baseR, cy - baseR, baseR * 2, baseR * 2);
    } else {
      ctx.fillStyle = TEAM_COLORS[p.colorIndex] || '#888';
      ctx.fillRect(cx - baseR, cy - baseR, baseR * 2, baseR * 2);
    }
    ctx.restore();

    if ((isMe || (spectating && p.role === 'hider')) && !p.tagged) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(35,41,70,0.9)';
      ctx.stroke(path);
      ctx.restore();
    }

    if (p.tagged) {
      ctx.strokeStyle = '#C1554D';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx - baseR * 0.6, cy - baseR * 0.6);
      ctx.lineTo(cx + baseR * 0.6, cy + baseR * 0.6);
      ctx.moveTo(cx + baseR * 0.6, cy - baseR * 0.6);
      ctx.lineTo(cx - baseR * 0.6, cy + baseR * 0.6);
      ctx.stroke();
    }
    ctx.restore();

    if (showName && !p.tagged) {
      ctx.save();
      ctx.font = '600 11px "Space Grotesk", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(35,41,70,0.55)';
      ctx.fillText(p.name + (isMe ? ' (you)' : ''), cx, cy - baseR - 8);
      ctx.restore();
    }
    if (!p.tagged) drawHat(cx, cy, baseR, p);
  }

  // Shows the paintbrush footprint on the character before you click, so
  // you always know exactly how big a stroke you're about to make.
  function drawBrushPreview() {
    const me = S.players.get(S.playerId);
    if (!me || me.x == null) return;
    const meWorldX = me.renderX != null ? me.renderX * CELL : me.x * CELL;
    const meWorldY = me.renderY != null ? me.renderY * CELL : me.y * CELL;
    const hover = S.hoverWorld || { x: meWorldX, y: meWorldY };
    const { gx, gy, inside } = skinCoordAt(hover.x, hover.y, meWorldX, meWorldY);
    if (!inside && S.hoverWorld) return; // hovering outside the character — no footprint to show
    const bs = S.brushSize || 1;
    const half = Math.floor((bs - 1) / 2);
    const px2world = (CHAR_WORLD_R * 2) / SKIN;
    const wx0 = meWorldX - CHAR_WORLD_R + (gx - half) * px2world;
    const wy0 = meWorldY - CHAR_WORLD_R + (gy - half) * px2world;
    const size = bs * px2world;
    const p0 = worldToScreen(wx0, wy0);
    const p1 = worldToScreen(wx0 + size, wy0 + size);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = S.brush;
    ctx.fillStyle = S.brush;
    ctx.globalAlpha = 0.28;
    ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    ctx.globalAlpha = 0.9;
    ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    ctx.restore();
  }

  // ---------- Give up: reveal marker ----------
  // Draws an obvious pin over every still-hidden hider's real position
  // once the seeker gives up. Uses the coordinates the server sent in
  // 'give_up_reveal' — not renderX/renderY — since the round is ending
  // and there's no need to wait for movement interpolation.
  function drawGiveUpReveal(t) {
    const reveal = S.giveUpReveal;
    if (!reveal) return;
    if (performance.now() > reveal.until) { S.giveUpReveal = null; return; }
    const bob = Math.sin(t / 160) * 5;
    reveal.hiders.forEach(h => {
      if (h.x == null || h.y == null) return;
      const { x: sx, y: sy } = worldToScreen(h.x * CELL, h.y * CELL);
      const py = sy - 34 + bob;
      ctx.save();
      ctx.fillStyle = '#C1554D';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, py, 9, 0, Math.PI * 2);
      ctx.moveTo(sx, py + 9);
      ctx.lineTo(sx, py + 26);
      ctx.stroke();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx, py, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.restore();
    });
  }

  function draw(t, dt) {
    updateCamera(dt);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (S.mapCanvas) {
      const viewW = canvas.width / S.viewScale, viewH = canvas.height / S.viewScale;
      const srcX = S.camCenterX - viewW / 2, srcY = S.camCenterY - viewH / 2;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(S.mapCanvas, srcX, srcY, viewW, viewH, 0, 0, canvas.width, canvas.height);
    }
    // Hiders always draw first (i.e. behind everyone else). If a seeker
    // walks over a hider, the hider's blob must stay underneath so no
    // z-order pop-up gives away the touch before the tag is confirmed.
    const drawOrder = [...S.players.values()].sort((a, b) => {
      const aTop = a.role === 'hider' ? 0 : 1;
      const bTop = b.role === 'hider' ? 0 : 1;
      return aTop - bTop;
    });
    drawOrder.forEach(p => drawPlayer(p, t));
    drawFootprints(t);
    drawPingWedge();
    drawGiveUpReveal(t);
    if (S.paintMode) drawBrushPreview();
  }

  // ---------- Painting on the character, in place ----------
  // Given a world point, returns the skin-pixel coordinate it falls on
  // (relative to `meWorldX/Y`, the character's own world position) and
  // whether that point actually lands inside the character.
  function skinCoordAt(worldX, worldY, meWorldX, meWorldY) {
    const ox = worldX - meWorldX, oy = worldY - meWorldY;
    const inside = Math.hypot(ox, oy) <= CHAR_WORLD_R;
    const gx = Math.floor(((ox + CHAR_WORLD_R) / (CHAR_WORLD_R * 2)) * SKIN);
    const gy = Math.floor(((oy + CHAR_WORLD_R) / (CHAR_WORLD_R * 2)) * SKIN);
    return { gx, gy, inside };
  }

  // Converts a skin-grid cell (gx,gy) back into world coordinates relative
  // to the character's current position — the inverse of skinCoordAt.
  // Used to drive S.hoverWorld from the keyboard cursor (WASD) the same
  // way it's normally driven by the mouse.
  function skinGridToWorld(gx, gy, meWorldX, meWorldY) {
    const px2world = (CHAR_WORLD_R * 2) / SKIN;
    return {
      x: meWorldX - CHAR_WORLD_R + (gx + 0.5) * px2world,
      y: meWorldY - CHAR_WORLD_R + (gy + 0.5) * px2world,
    };
  }

  function syncHoverFromKeyCursor() {
    if (!S.keyCursor) return;
    const me = S.players.get(S.playerId);
    if (!me || me.x == null) return;
    const meWorldX = me.renderX != null ? me.renderX * CELL : me.x * CELL;
    const meWorldY = me.renderY != null ? me.renderY * CELL : me.y * CELL;
    S.hoverWorld = skinGridToWorld(S.keyCursor.gx, S.keyCursor.gy, meWorldX, meWorldY);
  }

  function mixHex(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255;
    const br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255;
    const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
    return '#' + [r, g, bl].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  // All three brush types are free to use — this just tracks which one is
  // currently active (switching is always allowed, mid-match too).
  function activeBrushType() {
    if (S.brushType === 'sponge') return 'sponge';
    if (S.brushType === 'spray') return 'spray';
    return 'pencil';
  }

  function paintAtWorld(worldX, worldY) {
    const me = S.players.get(S.playerId);
    if (!me || !me.skin || me.x == null) return;
    const meWorldX = me.renderX != null ? me.renderX * CELL : me.x * CELL;
    const meWorldY = me.renderY != null ? me.renderY * CELL : me.y * CELL;
    const { gx, gy } = skinCoordAt(worldX, worldY, meWorldX, meWorldY);
    const bs = S.brushSize || 1;
    const half = Math.floor((bs - 1) / 2);
    const brushType = activeBrushType();
    let changed = false;

    // Sponge: blend every pixel under the brush toward the *average* color
    // of everything currently under the brush (not the pick color) — hold
    // it down and repeated dabs pull the whole area closer to that average
    // each time, until it eventually settles there.
    let avgHex = null;
    if (brushType === 'sponge') {
      let tr = 0, tg = 0, tb = 0, count = 0;
      for (let yy = gy - half; yy < gy - half + bs; yy++) {
        for (let xx = gx - half; xx < gx - half + bs; xx++) {
          if (xx < 0 || xx >= SKIN || yy < 0 || yy >= SKIN) continue;
          const hex = me.skin[yy * SKIN + xx];
          const n = parseInt(hex.slice(1), 16);
          tr += (n >> 16) & 255; tg += (n >> 8) & 255; tb += n & 255;
          count++;
        }
      }
      if (count > 0) {
        avgHex = '#' + [Math.round(tr / count), Math.round(tg / count), Math.round(tb / count)]
          .map(v => v.toString(16).padStart(2, '0')).join('');
      }
    }

    for (let yy = gy - half; yy < gy - half + bs; yy++) {
      for (let xx = gx - half; xx < gx - half + bs; xx++) {
        if (xx < 0 || xx >= SKIN || yy < 0 || yy >= SKIN) continue;
        const idx = yy * SKIN + xx;
        let next;
        if (brushType === 'sponge' && avgHex) {
          // Nudge toward the area's average color — repeated dabs (or
          // holding it down) gradually converge every pixel on that same
          // average, which is what "sponging" a blotchy paint job does.
          next = mixHex(me.skin[idx], avgHex, 0.22);
        } else if (brushType === 'spray') {
          // A thin, semi-transparent pass of the *selected* brush color —
          // one tap barely tints the pixel; repeated passes (or holding it
          // down) gradually deepen it toward the full brush color, like a
          // real spray can building up a coat.
          next = mixHex(me.skin[idx], S.brush, 0.1);
        } else {
          next = S.brush;
        }
        if (me.skin[idx] !== next) { me.skin[idx] = next; changed = true; }
      }
    }
    if (changed) { buildSkinCanvas(me); S.skinDirty = true; }
  }

  function eyedropAtWorld(worldX, worldY) {
    setBrush(sampleMapPixel(worldX, worldY));
    toast('Color picked!');
  }

  const PAINT_HOLD_INTERVAL_MS = 90; // how often a held-down pointer re-applies sponge/spray

  function startPaintHold() {
    stopPaintHold();
    S.paintHoldTimer = setInterval(() => {
      if (!S.painting || !S.hoverWorld) return;
      paintAtWorld(S.hoverWorld.x, S.hoverWorld.y);
    }, PAINT_HOLD_INTERVAL_MS);
  }
  function stopPaintHold() {
    if (S.paintHoldTimer) { clearInterval(S.paintHoldTimer); S.paintHoldTimer = null; }
  }

  // ---------- Keyboard painting (WASD moves cursor, Space paints) ----------
  function moveKeyCursor(k) {
    if (!S.keyCursor) return;
    let { gx, gy } = S.keyCursor;
    if (k === 'w') gy -= 1;
    else if (k === 's') gy += 1;
    else if (k === 'a') gx -= 1;
    else if (k === 'd') gx += 1;
    gx = Math.max(0, Math.min(SKIN - 1, gx));
    gy = Math.max(0, Math.min(SKIN - 1, gy));
    // Keep the cursor within the character's circular blob (the skin's
    // square corners fall outside the visible circle) so it never wanders
    // somewhere you can't actually see yourself painting.
    const cx = SKIN / 2 - 0.5, cy = SKIN / 2 - 0.5;
    if (Math.hypot(gx - cx, gy - cy) > SKIN / 2) return;
    S.keyCursor = { gx, gy };
    syncHoverFromKeyCursor();
  }

  function startKeyPaint() {
    if (!S.keyCursor) return;
    syncHoverFromKeyCursor();
    if (!S.hoverWorld) return;
    S.painting = true;
    S.paintSource = 'key';
    paintAtWorld(S.hoverWorld.x, S.hoverWorld.y);
    if (activeBrushType() !== 'pencil') startPaintHold();
  }
  function stopKeyPaint() {
    if (S.painting && S.paintSource === 'key') {
      S.painting = false;
      stopPaintHold();
      flushSkinNow();
      historyPush();
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!S.paintMode) return; // outside paint mode, clicking the canvas does nothing —
                               // tagging happens automatically by walking into a hider
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX, py = (e.clientY - rect.top) * scaleY;
    const world = screenToWorld(px, py);

    e.preventDefault();
    const me = S.players.get(S.playerId);
    if (!me || me.x == null) return;
    const meWorldX = me.renderX != null ? me.renderX * CELL : me.x * CELL;
    const meWorldY = me.renderY != null ? me.renderY * CELL : me.y * CELL;
    S.hoverWorld = world;
    const { gx, gy, inside } = skinCoordAt(world.x, world.y, meWorldX, meWorldY);
    if (S.keyCursor) S.keyCursor = { gx: Math.max(0, Math.min(SKIN - 1, gx)), gy: Math.max(0, Math.min(SKIN - 1, gy)) };
    if (inside) {
      S.painting = true;
      S.paintSource = 'mouse';
      paintAtWorld(world.x, world.y);
      // Sponge/spray keep working on a held-but-stationary pointer, slowly
      // deepening toward the average / full brush color the longer it's
      // held — pencil doesn't need this since a static dab never changes.
      if (activeBrushType() !== 'pencil') startPaintHold();
    } else {
      eyedropAtWorld(world.x, world.y);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!S.paintMode) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX, py = (e.clientY - rect.top) * scaleY;
    S.hoverWorld = screenToWorld(px, py);
    if (S.keyCursor) {
      const me = S.players.get(S.playerId);
      if (me && me.x != null) {
        const meWorldX = me.renderX != null ? me.renderX * CELL : me.x * CELL;
        const meWorldY = me.renderY != null ? me.renderY * CELL : me.y * CELL;
        const { gx, gy } = skinCoordAt(S.hoverWorld.x, S.hoverWorld.y, meWorldX, meWorldY);
        S.keyCursor = { gx: Math.max(0, Math.min(SKIN - 1, gx)), gy: Math.max(0, Math.min(SKIN - 1, gy)) };
      }
    }
    if (S.painting && S.paintSource === 'mouse') { e.preventDefault(); paintAtWorld(S.hoverWorld.x, S.hoverWorld.y); }
  });
  canvas.addEventListener('pointerleave', () => { S.hoverWorld = null; });
  window.addEventListener('pointerup', () => {
    if (S.painting && S.paintSource === 'mouse') { S.painting = false; stopPaintHold(); flushSkinNow(); historyPush(); }
  });

  // ---------- Movement ----------
  function isTypingInField() {
    const el = document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  }

  window.addEventListener('keydown', (e) => {
    if (isTypingInField()) return; // never steal keystrokes from a text field
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(k)) e.preventDefault();
    if (k === 'c' && !e.repeat) toggleInvertedColors();

    // In paint mode, WASD moves the keyboard brush cursor one skin-pixel
    // per press (discrete — held-down auto-repeat is ignored) instead of
    // walking around, and Space paints at the cursor exactly like holding
    // the mouse button down would.
    if (S.paintMode) {
      if (['w', 'a', 's', 'd'].includes(k) && !e.repeat) {
        moveKeyCursor(k);
      } else if ((e.code === 'Space' || k === ' ') && !e.repeat) {
        e.preventDefault();
        startKeyPaint();
      }
    }

    S.keys[k] = true;
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (S.paintMode && (e.code === 'Space' || k === ' ')) {
      e.preventDefault();
      stopKeyPaint();
    }
    S.keys[k] = false;
  });

  function toggleInvertedColors() {
    S.invertColors = !S.invertColors;
    $('screen-game').classList.toggle('inverted-colors', S.invertColors);
    toast(S.invertColors ? 'Inverted colors on (press C to undo)' : 'Inverted colors off');
  }

  function getMoveVector() {
    let dx = 0, dy = 0;
    if (S.keys['arrowup'] || S.keys['w']) dy -= 1;
    if (S.keys['arrowdown'] || S.keys['s']) dy += 1;
    if (S.keys['arrowleft'] || S.keys['a']) dx -= 1;
    if (S.keys['arrowright'] || S.keys['d']) dx += 1;
    const len = Math.hypot(dx, dy);
    if (len > 0) { dx /= len; dy /= len; }
    return { dx, dy };
  }

  // ---------- HUD ----------
  function setBanner(text) {
    const el = $('banner');
    if (!text) { el.classList.add('hidden'); return; }
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function updateHud() {
    $('game-code').textContent = S.code;
    $('game-phase').textContent = S.phase === 'hiding' ? 'Hiding' : S.phase === 'seeking' ? 'Seeking' : S.phase;
    const role = myRole();
    $('hud-role').textContent = isSpectator() ? '👻 Spectating' : (role ? (role === 'seeker' ? 'You: Seeker 🔍' : 'You: Hider 🙈') : '');
    const hidersLeft = [...S.players.values()].filter(p => p.role === 'hider' && !p.tagged).length;
    $('game-remaining').textContent = hidersLeft;

    let remainMs = 0;
    if (S.phaseEnd) remainMs = Math.max(0, S.phaseEnd - Date.now());
    const secs = Math.ceil(remainMs / 1000);
    $('game-timer').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

    const cover = $('hiding-cover');
    const showCover = S.phase === 'hiding' && role === 'seeker';
    cover.classList.toggle('hidden', !showCover);
    if (showCover) $('hiding-cover-timer').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

    const strip = $('player-strip');
    strip.innerHTML = '';
    [...S.players.values()].forEach(p => {
      const chip = document.createElement('div');
      chip.className = 'player-chip' + (p.tagged ? ' chip-tagged' : '');
      const dot = document.createElement('span');
      dot.className = 'chip-dot';
      dot.style.background = TEAM_COLORS[p.colorIndex];
      const roleIcon = document.createElement('span');
      roleIcon.className = 'chip-role';
      roleIcon.textContent = p.role === 'seeker' ? '🔍' : '🙈';
      const name = document.createElement('span');
      name.textContent = p.name;
      chip.append(dot, roleIcon, name);
      strip.appendChild(chip);
    });
  }

  // Tagging happens by walking into a hider — no click needed. We check
  // every frame while seeking and fire a `tag` message the moment our
  // circle overlaps theirs, throttled per-target so a lingering overlap
  // doesn't flood the server (the server itself also enforces a longer
  // cooldown per hit, plus a hit count before anyone is actually caught).
  function checkTouchTags(t) {
    if (S.phase !== 'seeking' || myRole() !== 'seeker') return;
    const me = S.players.get(S.playerId);
    if (!me || me.tagged || me.x == null || me.y == null) return;
    S.players.forEach(p => {
      if (p.id === S.playerId || p.role !== 'hider' || p.tagged || p.x == null || p.y == null) return;
      const d = Math.hypot(me.x - p.x, me.y - p.y);
      if (d > TOUCH_RADIUS) return;
      const last = S.tagAttempts.get(p.id) || 0;
      if (t - last < TAG_RESEND_MS) return;
      S.tagAttempts.set(p.id, t);
      send({ type: 'tag', targetId: p.id });
    });
  }

  // ---------- Game loop ----------
  let lastTime = 0, lastMoveSend = 0, wasMoving = false;
  function frame(t) {
    const dt = lastTime ? Math.min(0.05, (t - lastTime) / 1000) : 0;
    lastTime = t;

    const me = S.players.get(S.playerId);
    const role = myRole();
    const canMove = me && !me.tagged && !S.paintMode &&
      (S.phase === 'seeking' || (S.phase === 'hiding' && role === 'hider'));

    let moving = false;
    if (canMove) {
      const { dx, dy } = getMoveVector();
      moving = !!(dx || dy);
      if (moving) {
        const speedMult = (S.phase === 'seeking' && role === 'hider' && !S.powers.no_slowdown) ? 0.25 : 1;
        const speed = MOVE_SPEED * speedMult;
        me.renderX = Math.max(0.3, Math.min(COLS - 0.3, (me.renderX ?? me.x) + dx * speed * dt));
        me.renderY = Math.max(0.3, Math.min(ROWS - 0.3, (me.renderY ?? me.y) + dy * speed * dt));
        me.x = me.renderX; me.y = me.renderY;
        // While actively moving, a periodic update is enough — other
        // clients smooth between positions, so this doesn't need to be
        // frequent.
        if (t - lastMoveSend > 70) {
          lastMoveSend = t;
          send({ type: 'move', x: me.x, y: me.y });
        }
      }
    }
    // The moment movement stops, send the exact final position right away
    // instead of waiting for the next throttled tick. Otherwise the last
    // few pixels of motion between the previous send and the stop never
    // reach other clients, and that player stays visibly offset on their
    // screens until they move again.
    if (wasMoving && !moving && me) {
      lastMoveSend = t;
      send({ type: 'move', x: me.x, y: me.y });
    }
    wasMoving = moving;
    if (me) { me.renderX = me.renderX ?? me.x; me.renderY = me.renderY ?? me.y; }

    if (isSpectator()) {
      const { dx, dy } = getMoveVector();
      if (dx || dy) {
        const panSpeed = MOVE_SPEED * 2.2; // faster than normal play — covering the whole map is the point
        S.specCamX = Math.max(0, Math.min(COLS * CELL, S.specCamX + dx * panSpeed * CELL * dt));
        S.specCamY = Math.max(0, Math.min(ROWS * CELL, S.specCamY + dy * panSpeed * CELL * dt));
      }
    }

    S.players.forEach(p => {
      if (p.id === S.playerId || p.x == null) return;
      if (p.renderX == null) {
        p.renderX = p.x; p.renderY = p.y;
      } else {
        const dist = Math.hypot(p.x - p.renderX, p.y - p.renderY);
        if (dist > 1.5) {
          // Way off (reconnect, teleport, a dropped update, etc) — snap
          // instead of smoothing, so it doesn't spend a long stretch
          // rubber-banding across the map while both screens disagree
          // about where this player actually is.
          p.renderX = p.x; p.renderY = p.y;
        } else {
          const catchUp = Math.min(1, dt * 14);
          p.renderX += (p.x - p.renderX) * catchUp;
          p.renderY += (p.y - p.renderY) * catchUp;
        }
      }
    });

    // Cosmetic movement trails — only while actively playing (not while
    // hiders are still hiding, per the design: cosmetics should never give
    // away a well-blended hider's position).
    if (S.phase !== 'hiding') {
      S.players.forEach(p => {
        if (!p.trail || p.renderX == null || p.tagged) return;
        if (!p._trailPts) p._trailPts = [];
        const last = p._trailPts[p._trailPts.length - 1];
        if (!last || Math.hypot(p.renderX - last.x, p.renderY - last.y) > 0.15) {
          p._trailPts.push({ x: p.renderX, y: p.renderY });
          if (p._trailPts.length > 10) p._trailPts.shift();
        }
      });
    }

    if (S.skinDirty && t - lastSkinSend > 180) flushSkinNow();

    checkTouchTags(t);
    draw(t, dt);
    updateHud();

    S.loopHandle = requestAnimationFrame(frame);
  }

  function startGameLoop() {
    if (S.loopHandle) return;
    lastTime = 0;
    S.loopHandle = requestAnimationFrame(frame);
  }
  function stopGameLoop() {
    if (S.loopHandle) cancelAnimationFrame(S.loopHandle);
    S.loopHandle = null;
  }

  // ---------- Results ----------
  // Every match — 2 to 4 players, ranked or casual — is now a tourney of
  // rounds (one seek turn per player per round, repeated until someone has
  // a strict lead in cumulative wins). `wins` is a [[playerId, count], ...]
  // list as sent by the server; we just sort and render it.
  function renderTourneyResults(winnerId, wins, roundsPlayed, isRanked) {
    const won = winnerId === S.playerId;
    const roundLabel = `${roundsPlayed} round${roundsPlayed === 1 ? '' : 's'}`;
    $('results-outcome').textContent = won
      ? `🏆 You won the match! (${roundLabel})`
      : `${isRanked ? '💔 You lost the ranked match.' : 'The match is over.'} (${roundLabel})`;

    $('results-hiders-section').classList.add('hidden');
    $('results-seekers-section').classList.add('hidden');
    $('results-hiders').innerHTML = '';
    $('results-seekers').innerHTML = '';

    const winsList = [...(wins || [])].sort((a, b) => b[1] - a[1]);
    const summary = $('results-ranked-summary');
    summary.innerHTML = '';
    summary.classList.remove('hidden');
    winsList.forEach(([id, count], i) => {
      const p = S.players.get(id);
      const row = document.createElement('div');
      row.className = 'result-row' + (id === winnerId ? ' result-winner' : '');
      const rank = document.createElement('span');
      rank.className = 'result-rank';
      rank.textContent = i + 1;
      const dot = document.createElement('span');
      dot.className = 'result-dot';
      dot.style.background = p ? TEAM_COLORS[p.colorIndex] : '#999';
      const name = document.createElement('span');
      name.className = 'result-name';
      name.textContent = (p ? p.name : 'Unknown') + (id === S.playerId ? ' (you)' : '');
      const tag = document.createElement('span');
      tag.className = 'result-tag';
      tag.textContent = id === winnerId ? `Winner · ${count} win${count === 1 ? '' : 's'}` : `${count} win${count === 1 ? '' : 's'}`;
      row.append(rank, dot, name, tag);
      summary.appendChild(row);
    });

    $('btn-play-again').classList.toggle('hidden', S.hostId !== S.playerId);
    S.rematchReady = new Set();
    S.rematchClicked = false;
    $('btn-rematch').classList.remove('hidden');
    $('btn-rematch').disabled = false;
    $('btn-rematch').textContent = 'Rematch';
    renderRematchStatus();
  }

  function renderRematchStatus() {
    const btn = $('btn-rematch');
    const status = $('rematch-status');
    if (S.rematchClicked) {
      btn.disabled = true;
      btn.textContent = 'Waiting for others…';
    }
    const readyNames = [...S.rematchReady].map(id => {
      const p = S.players.get(id);
      return p ? (p.id === S.playerId ? 'You' : p.name) : null;
    }).filter(Boolean);
    if (readyNames.length) {
      status.textContent = `Ready for a rematch: ${readyNames.join(', ')}`;
      status.classList.remove('hidden');
    } else {
      status.classList.add('hidden');
    }
  }

  $('btn-rematch').addEventListener('click', () => {
    if (S.rematchClicked) return;
    S.rematchClicked = true;
    send({ type: 'rematch' });
    renderRematchStatus();
  });
})();
