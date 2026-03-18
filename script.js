/**
 * ============================================================
 * CLICK SPAM PRO — script.js
 * Full multiplayer browser game logic
 * Firebase Authentication + Realtime Database
 * ============================================================
 *
 * SETUP GUIDE (read this before anything else):
 *
 * STEP 1 — Create a Firebase Project:
 *   1. Go to https://console.firebase.google.com
 *   2. Click "Add project", name it (e.g. "click-spam-pro")
 *   3. Disable Google Analytics if you don't need it
 *   4. Click "Create project"
 *
 * STEP 2 — Enable Authentication:
 *   1. In Firebase console, click "Authentication" in the left sidebar
 *   2. Click "Get started"
 *   3. Go to "Sign-in method" tab
 *   4. Click "Email/Password" and ENABLE it (toggle on), then Save
 *   (We use email/password but convert "username" to "username@game.com")
 *
 * STEP 3 — Enable Realtime Database:
 *   1. Click "Realtime Database" in the left sidebar
 *   2. Click "Create Database"
 *   3. Choose a location (any is fine)
 *   4. Start in TEST MODE (you'll add security rules below)
 *   5. Click "Enable"
 *   6. Go to the "Rules" tab and paste these rules:
 *
 *   {
 *     "rules": {
 *       "users": {
 *         "$uid": {
 *           ".read": "auth != null",
 *           ".write": "auth != null && auth.uid === $uid"
 *         }
 *       },
 *       "usernames": {
 *         ".read": "auth != null",
 *         "$username": {
 *           ".write": "auth != null"
 *         }
 *       },
 *       "rooms": {
 *         ".read": "auth != null",
 *         ".write": "auth != null"
 *       },
 *       "leaderboard": {
 *         ".read": true,
 *         ".write": "auth != null"
 *       },
 *       "banned": {
 *         ".read": "auth != null",
 *         ".write": "auth != null"
 *       }
 *     }
 *   }
 *
 * STEP 4 — Get Firebase Config and paste it in index.html:
 *   1. In Firebase console, click the gear icon ⚙ → "Project settings"
 *   2. Scroll to "Your apps" section
 *   3. Click the Web icon (</>)
 *   4. Register the app (name it anything)
 *   5. Copy the firebaseConfig object
 *   6. Open index.html and REPLACE the firebaseConfig object
 *      inside the <script type="module"> tag
 *
 * STEP 5 — Deploy to GitHub Pages:
 *   1. Create a GitHub repository (public)
 *   2. Push index.html, style.css, script.js to the repo
 *   3. Go to repo Settings → Pages
 *   4. Source: Deploy from branch → main → / (root)
 *   5. Save. Your game will be live at:
 *      https://YOUR-USERNAME.github.io/YOUR-REPO-NAME/
 *   6. IMPORTANT: Add your GitHub Pages URL to Firebase Auth
 *      → Authentication → Settings → Authorized domains → Add domain
 *
 * ============================================================
 */

// ============================================================
// IMPORTS — Firebase modules loaded after Firebase init
// ============================================================

// We wait for Firebase to be attached to window by index.html's module script
// then pull in specific functions via dynamic import.

(async function () {
  // Wait for Firebase to be initialized by index.html
  await waitForFirebase();

  const auth = window._firebaseAuth;
  const db   = window._firebaseDB;

  // Import Firebase functions
  const {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged,
  } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");

  const {
    ref, set, get, push, remove, update, onValue, off, serverTimestamp,
  } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js");

  // ============================================================
  // CONSTANTS
  // ============================================================

  const ADMIN_PASSWORD   = "2307";           // Admin panel password
  const ADMIN_UIDS       = [];               // Add trusted UID strings here
  const ROUND_DURATION   = 5;               // seconds per round
  const COUNTDOWN_SECS   = 3;               // countdown before round
  const WINS_NEEDED      = 2;               // first to X wins
  const FREEZE_DURATION  = 2000;            // ms player is frozen
  const DOUBLE_DURATION  = 3000;            // ms double clicks active
  const POWERUP_COOLDOWN = 15000;           // ms cooldown between powerups

  // ============================================================
  // STATE
  // ============================================================

  let currentUser     = null;   // Firebase auth user
  let myUID           = null;
  let myUsername      = null;
  let myDisplayName   = null;
  let isAdmin         = false;

  let currentRoomCode = null;
  let isHost          = false;
  let roomRef         = null;   // Firebase ref for current room
  let roomListener    = null;   // unsubscribe handle

  let gameState       = null;   // snapshot of room.game
  let myClicks        = 0;
  let isFrozen        = false;
  let isDoubled       = false;
  let frozenTimeout   = null;
  let doubledTimeout  = null;
  let puDoubleCooldown= false;
  let puFreezeCooldown= false;

  let timerInterval   = null;
  let timerEnd        = null;
  let cpsStartTime    = null;
  let cpsClickCount   = 0;

  // Click sound (Web Audio API — no external file needed)
  let audioCtx = null;

  // ============================================================
  // UTILITIES
  // ============================================================

  function waitForFirebase() {
    return new Promise(resolve => {
      const check = () => {
        if (window._firebaseAuth && window._firebaseDB) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  /** Show a named screen, hide all others */
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + id).classList.add('active');
  }

  /** Display an error message in a given element */
  function showError(elemId, msg) {
    const el = document.getElementById(elemId);
    if (el) { el.textContent = msg; setTimeout(() => { el.textContent = ''; }, 5000); }
  }

  /** Generate a 6-char uppercase room code */
  function genRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  /** Convert username to fake email for Firebase auth */
  function toEmail(username) {
    return username.trim().toLowerCase() + '@game.com';
  }

  // ============================================================
  // SOUND — Web Audio API click sound (no file needed)
  // ============================================================

  function initAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  function playClickSound() {
    try {
      if (!audioCtx) initAudio();
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.setValueAtTime(800, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(200, audioCtx.currentTime + 0.06);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.07);
      osc.start(audioCtx.currentTime);
      osc.stop(audioCtx.currentTime + 0.08);
    } catch (e) { /* silence audio errors */ }
  }

  // ============================================================
  // VISUAL EFFECTS
  // ============================================================

  /** Flash the screen white briefly */
  function flashScreen() {
    const overlay = document.getElementById('flash-overlay');
    overlay.classList.remove('flash');
    void overlay.offsetWidth; // reflow
    overlay.classList.add('flash');
  }

  /** Shake the app container */
  function shakeScreen() {
    const app = document.getElementById('app');
    app.classList.remove('shake');
    void app.offsetWidth;
    app.classList.add('shake');
    setTimeout(() => app.classList.remove('shake'), 350);
  }

  /** Animate click button press */
  function animateClickBtn() {
    const btn = document.getElementById('click-btn');
    btn.classList.remove('clicked');
    void btn.offsetWidth;
    btn.classList.add('clicked');
    setTimeout(() => btn.classList.remove('clicked'), 100);
  }

  /** Firework particles for game over */
  function launchFireworks() {
    const container = document.getElementById('gameover-fireworks');
    container.innerHTML = '';
    const colors = ['#00f5ff', '#ff2d78', '#ffe000', '#00ff88', '#a259ff'];
    for (let i = 0; i < 60; i++) {
      const p = document.createElement('div');
      p.className = 'firework-particle';
      const x = Math.random() * window.innerWidth;
      const y = Math.random() * (window.innerHeight * 0.6) + 40;
      const dx = (Math.random() - 0.5) * 300;
      const dy = -(Math.random() * 200 + 100);
      p.style.left = x + 'px';
      p.style.top  = y + 'px';
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.setProperty('--dx', dx + 'px');
      p.style.setProperty('--dy', dy + 'px');
      p.style.animationDelay = (Math.random() * 0.8) + 's';
      p.style.animationDuration = (1 + Math.random() * 0.8) + 's';
      container.appendChild(p);
    }
  }

  // ============================================================
  // AUTH SYSTEM
  // ============================================================

  /** Switch between login and register tabs */
  window.switchTab = function (tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector(`[onclick="switchTab('${tab}')"]`).classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');
    showError('auth-error', '');
  };

  /** Toggle admin login form */
  window.toggleAdminLogin = function () {
    const f = document.getElementById('admin-login-form');
    f.style.display = f.style.display === 'none' ? 'flex' : 'none';
    f.style.flexDirection = 'column';
    f.style.gap = '8px';
  };

  /** Admin login by password (no Firebase account needed) */
  window.adminLoginByPassword = function () {
    const pass = document.getElementById('admin-pass-input').value.trim();
    if (pass === ADMIN_PASSWORD) {
      isAdmin = true;
      showError('auth-error', '✓ Admin mode active. Now sign in normally.');
    } else {
      showError('auth-error', '✗ Wrong admin password.');
    }
  };

  /** Register new user */
  window.registerUser = async function () {
    const username    = document.getElementById('reg-username').value.trim().toLowerCase();
    const displayName = document.getElementById('reg-displayname').value.trim();
    const password    = document.getElementById('reg-password').value;

    if (!username || !displayName || !password) return showError('auth-error', 'Fill in all fields.');
    if (username.includes(' ')) return showError('auth-error', 'Username cannot have spaces.');
    if (password.length < 6) return showError('auth-error', 'Password must be at least 6 characters.');

    // Check username uniqueness in DB
    const usernameSnap = await get(ref(db, `usernames/${username}`));
    if (usernameSnap.exists()) return showError('auth-error', 'Username already taken.');

    try {
      const cred = await createUserWithEmailAndPassword(auth, toEmail(username), password);
      const uid  = cred.user.uid;

      // Store user data
      await set(ref(db, `users/${uid}`), {
        username,
        displayName,
        score: 0,
        wins:  0,
      });

      // Reserve username
      await set(ref(db, `usernames/${username}`), uid);

      // onAuthStateChanged will handle screen transition
    } catch (err) {
      showError('auth-error', err.message);
    }
  };

  /** Login existing user */
  window.loginUser = async function () {
    const username = document.getElementById('login-username').value.trim().toLowerCase();
    const password = document.getElementById('login-password').value;

    if (!username || !password) return showError('auth-error', 'Enter username and password.');

    try {
      await signInWithEmailAndPassword(auth, toEmail(username), password);
      // onAuthStateChanged handles the rest
    } catch (err) {
      let msg = 'Invalid username or password.';
      if (err.code === 'auth/too-many-requests') msg = 'Too many attempts. Try later.';
      showError('auth-error', msg);
    }
  };

  /** Sign out */
  window.logoutUser = async function () {
    await leaveRoomCleanup();
    await signOut(auth);
  };

  /** Auth state change — runs on every page load */
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      currentUser = user;
      myUID = user.uid;

      // Check if banned
      const banSnap = await get(ref(db, `banned/${myUID}`));
      if (banSnap.exists()) {
        await signOut(auth);
        showError('auth-error', '🚫 You are banned from this game.');
        return;
      }

      // Load user profile
      const snap = await get(ref(db, `users/${myUID}`));
      if (snap.exists()) {
        const data = snap.val();
        myUsername    = data.username;
        myDisplayName = data.displayName;

        document.getElementById('lobby-display-name').textContent = myDisplayName;
        document.getElementById('lobby-score-display').textContent = `🏆 ${data.wins || 0}`;
      }

      // Check admin by UID
      if (ADMIN_UIDS.includes(myUID)) isAdmin = true;

      showScreen('lobby');
    } else {
      currentUser = null;
      myUID = null;
      showScreen('auth');
    }
  });

  // ============================================================
  // LOBBY / ROOM MANAGEMENT
  // ============================================================

  /** Create a new room */
  window.createRoom = async function () {
    if (!currentUser) return;
    await leaveRoomCleanup();

    const code = genRoomCode();
    currentRoomCode = code;
    isHost = true;

    const roomData = {
      host: myUID,
      status: 'waiting',           // waiting | countdown | playing | roundResult | gameover
      players: {
        [myUID]: {
          displayName: myDisplayName,
          username: myUsername,
          clicks: 0,
          wins: 0,
          frozen: false,
        }
      },
      createdAt: serverTimestamp(),
    };

    await set(ref(db, `rooms/${code}`), roomData);
    listenToRoom(code);
    renderRoomScreen(code);
    showScreen('room');
  };

  /** Join an existing room */
  window.joinRoom = async function () {
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    if (!code || code.length !== 6) return showError('lobby-error', 'Enter a valid 6-character room code.');

    // Check if banned
    const banSnap = await get(ref(db, `banned/${myUID}`));
    if (banSnap.exists()) return showError('lobby-error', '🚫 You are banned.');

    const snap = await get(ref(db, `rooms/${code}`));
    if (!snap.exists()) return showError('lobby-error', 'Room not found.');

    const room = snap.val();
    if (room.status !== 'waiting') return showError('lobby-error', 'Game already in progress.');

    const playerCount = Object.keys(room.players || {}).length;
    if (playerCount >= 8) return showError('lobby-error', 'Room is full (max 8 players).');

    await update(ref(db, `rooms/${code}/players/${myUID}`), {
      displayName: myDisplayName,
      username: myUsername,
      clicks: 0,
      wins: 0,
      frozen: false,
    });

    currentRoomCode = code;
    isHost = (room.host === myUID);
    listenToRoom(code);
    renderRoomScreen(code);
    showScreen('room');
  };

  /** Render room screen UI (header, host button, etc.) */
  function renderRoomScreen(code) {
    document.getElementById('room-code-display').textContent = code;
  }

  /** Leave current room */
  window.leaveRoom = async function () {
    await leaveRoomCleanup();
    showScreen('lobby');
  };

  /** Clean up room listeners and remove player from room */
  async function leaveRoomCleanup() {
    if (roomListener && roomRef) {
      off(roomRef, 'value', roomListener);
      roomListener = null;
    }
    if (currentRoomCode && myUID) {
      // Remove this player
      await remove(ref(db, `rooms/${currentRoomCode}/players/${myUID}`));

      // If host left, reassign or delete room
      const snap = await get(ref(db, `rooms/${currentRoomCode}`));
      if (snap.exists()) {
        const room = snap.val();
        const players = Object.keys(room.players || {});
        if (isHost) {
          if (players.length === 0) {
            await remove(ref(db, `rooms/${currentRoomCode}`));
          } else {
            // Assign new host
            await update(ref(db, `rooms/${currentRoomCode}`), { host: players[0] });
          }
        }
      }
    }
    currentRoomCode = null;
    isHost = false;
    clearGameState();
  }

  function clearGameState() {
    clearInterval(timerInterval);
    timerInterval   = null;
    myClicks        = 0;
    isFrozen        = false;
    isDoubled       = false;
    puDoubleCooldown= false;
    puFreezeCooldown= false;
    if (frozenTimeout) clearTimeout(frozenTimeout);
    if (doubledTimeout) clearTimeout(doubledTimeout);
  }

  // ============================================================
  // REAL-TIME ROOM LISTENER
  // ============================================================

  function listenToRoom(code) {
    roomRef = ref(db, `rooms/${code}`);
    roomListener = onValue(roomRef, (snap) => {
      if (!snap.exists()) {
        // Room deleted — go to lobby
        clearGameState();
        showScreen('lobby');
        return;
      }
      const room = snap.val();
      isHost = (room.host === myUID);
      handleRoomUpdate(room);
    });
  }

  /** Master handler for all room state changes */
  function handleRoomUpdate(room) {
    const status = room.status;

    // Always update player list on room screen
    if (status === 'waiting') {
      updatePlayersListUI(room);
      showScreen('room');
      document.getElementById('start-btn').style.display  = isHost ? 'block' : 'none';
      document.getElementById('waiting-msg').style.display = isHost ? 'none'  : 'block';
      updateAdminPanel(room);
    }

    if (status === 'countdown') {
      showScreen('countdown');
      if (isHost) runCountdown(room);
      const roundNum = (room.game && room.game.round) || 1;
      document.getElementById('round-info').textContent = `ROUND ${roundNum}`;
    }

    if (status === 'playing') {
      gameState = room.game || {};
      if (document.getElementById('screen-game').classList.contains('active')) {
        updateLiveLeaderboard(room);
        updateRoundScoreDisplay(room);
      } else {
        enterGameScreen(room);
      }
      // Check if I'm frozen by another player
      const me = room.players && room.players[myUID];
      if (me && me.frozen && !isFrozen) applyFreeze(FREEZE_DURATION);
    }

    if (status === 'roundResult') {
      clearInterval(timerInterval);
      showRoundResult(room);
    }

    if (status === 'gameover') {
      clearInterval(timerInterval);
      showGameOver(room);
    }
  }

  // ============================================================
  // ROOM SCREEN UI
  // ============================================================

  function updatePlayersListUI(room) {
    const container = document.getElementById('players-list');
    container.innerHTML = '';
    const players = room.players || {};
    Object.entries(players).forEach(([uid, p]) => {
      const card = document.createElement('div');
      card.className = 'player-card';
      card.innerHTML = `
        <span class="player-name">${p.displayName}</span>
        <div style="display:flex;gap:6px;align-items:center;">
          ${uid === room.host ? '<span class="player-badge badge-host">HOST</span>' : ''}
          ${uid === myUID    ? '<span class="player-badge badge-you">YOU</span>'   : ''}
          <span class="player-badge badge-wins">🏆 ${p.wins || 0}</span>
        </div>
      `;
      container.appendChild(card);
    });
  }

  // ============================================================
  // ADMIN PANEL
  // ============================================================

  function updateAdminPanel(room) {
    const panel = document.getElementById('admin-panel');
    if (!isAdmin) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';

    const list = document.getElementById('admin-player-list');
    list.innerHTML = '';
    const players = room.players || {};
    Object.entries(players).forEach(([uid, p]) => {
      if (uid === myUID) return; // don't show self
      const row = document.createElement('div');
      row.className = 'admin-player-row';
      row.innerHTML = `
        <span class="admin-player-name">${p.displayName} (@${p.username})</span>
        <button class="admin-btn kick"   onclick="adminKick('${uid}')">Kick</button>
        <button class="admin-btn ban"    onclick="adminBan('${uid}', '${p.username}')">Ban</button>
        <button class="admin-btn freeze" onclick="adminFreezePlayer('${uid}')">Freeze</button>
      `;
      list.appendChild(row);
    });
  }

  /** Admin: kick player from room */
  window.adminKick = async function (uid) {
    if (!isAdmin || !currentRoomCode) return;
    await remove(ref(db, `rooms/${currentRoomCode}/players/${uid}`));
  };

  /** Admin: ban player */
  window.adminBan = async function (uid, username) {
    if (!isAdmin) return;
    await set(ref(db, `banned/${uid}`), { username, bannedAt: serverTimestamp() });
    await remove(ref(db, `rooms/${currentRoomCode}/players/${uid}`));
  };

  /** Admin: freeze a player (they can't click) */
  window.adminFreezePlayer = async function (uid) {
    if (!isAdmin || !currentRoomCode) return;
    await update(ref(db, `rooms/${currentRoomCode}/players/${uid}`), { frozen: true });
    // Auto-unfreeze after FREEZE_DURATION
    setTimeout(async () => {
      await update(ref(db, `rooms/${currentRoomCode}/players/${uid}`), { frozen: false });
    }, FREEZE_DURATION);
  };

  // ============================================================
  // GAME START (host only)
  // ============================================================

  window.startGame = async function () {
    if (!isHost || !currentRoomCode) return;

    const snap = await get(ref(db, `rooms/${currentRoomCode}/players`));
    if (!snap.exists() || Object.keys(snap.val()).length < 2) {
      alert('Need at least 2 players to start!');
      return;
    }

    // Initialize wins for all players
    const players = snap.val();
    const winsInit = {};
    Object.keys(players).forEach(uid => { winsInit[uid] = { wins: 0 }; });

    await update(ref(db, `rooms/${currentRoomCode}`), {
      status: 'countdown',
      game: { round: 1, winsMap: winsInit },
    });
  };

  // ============================================================
  // COUNTDOWN (host drives it)
  // ============================================================

  function runCountdown(room) {
    let count = COUNTDOWN_SECS;
    const el  = document.getElementById('countdown-number');
    el.textContent = count;
    flashScreen();

    const interval = setInterval(async () => {
      count--;
      if (count <= 0) {
        clearInterval(interval);
        // Reset clicks, start playing
        const snap = await get(ref(db, `rooms/${currentRoomCode}/players`));
        const clicksReset = {};
        if (snap.exists()) {
          Object.keys(snap.val()).forEach(uid => { clicksReset[uid] = { clicks: 0, frozen: false }; });
        }
        await update(ref(db, `rooms/${currentRoomCode}`), {
          status: 'playing',
          'game/startTime': Date.now() + 300, // slight sync offset
        });
        // Apply clicks reset
        for (const uid of Object.keys(clicksReset)) {
          await update(ref(db, `rooms/${currentRoomCode}/players/${uid}`), clicksReset[uid]);
        }
      } else {
        el.textContent = count;
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = 'countAnim 0.8s ease';
        flashScreen();
      }
    }, 1000);
  }

  // ============================================================
  // GAME SCREEN
  // ============================================================

  function enterGameScreen(room) {
    myClicks     = 0;
    cpsClickCount= 0;
    cpsStartTime  = Date.now();
    isFrozen     = false;
    isDoubled    = false;

    updateClickDisplay(0);
    updateCPS(0);
    enablePowerups();

    const btn = document.getElementById('click-btn');
    btn.classList.remove('frozen', 'double-active');
    document.getElementById('click-btn-text') && (document.querySelector('.click-btn-text').textContent = 'CLICK!');

    showScreen('game');

    // Start local countdown timer
    const startTime = room.game && room.game.startTime ? room.game.startTime : Date.now();
    startTimer(startTime);

    updateLiveLeaderboard(room);
    updateRoundScoreDisplay(room);
  }

  /** Start the visual timer synced to startTime */
  function startTimer(startTime) {
    clearInterval(timerInterval);
    timerEnd = startTime + ROUND_DURATION * 1000;

    timerInterval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000));
      document.getElementById('timer-display').textContent = remaining;

      // Update CPS
      const elapsed = (Date.now() - cpsStartTime) / 1000;
      const cps     = elapsed > 0 ? (cpsClickCount / elapsed).toFixed(1) : '0.0';
      document.getElementById('cps-display').textContent = cps;

      if (remaining <= 0) {
        clearInterval(timerInterval);
        document.getElementById('timer-display').textContent = '0';
        // Host ends the round
        if (isHost) endRound();
      }
    }, 200);
  }

  function updateClickDisplay(n) {
    document.getElementById('my-clicks').textContent = n;
  }

  function updateCPS(val) {
    document.getElementById('cps-display').textContent = val;
  }

  // ============================================================
  // CLICK HANDLER
  // ============================================================

  window.handleClick = function () {
    if (isFrozen) return;
    if (!document.getElementById('screen-game').classList.contains('active')) return;
    if (!currentRoomCode) return;

    initAudio();
    playClickSound();
    animateClickBtn();

    const increment = isDoubled ? 2 : 1;
    myClicks      += increment;
    cpsClickCount += increment;

    updateClickDisplay(myClicks);

    // Write to DB (throttled)
    throttledUpdateClicks(myClicks);

    // Visual effects every 10 clicks
    if (myClicks % 10 === 0) flashScreen();
    if (myClicks % 25 === 0) shakeScreen();
  };

  // Throttle DB writes to ~8 per second
  let pendingClickUpdate = false;
  function throttledUpdateClicks(count) {
    if (pendingClickUpdate) return;
    pendingClickUpdate = true;
    setTimeout(async () => {
      if (currentRoomCode && myUID) {
        await update(ref(db, `rooms/${currentRoomCode}/players/${myUID}`), { clicks: count });
      }
      pendingClickUpdate = false;
    }, 120);
  }

  // ============================================================
  // LIVE LEADERBOARD
  // ============================================================

  function updateLiveLeaderboard(room) {
    const container = document.getElementById('live-lb-list');
    const players   = room.players || {};
    const sorted    = Object.entries(players).sort((a, b) => (b[1].clicks || 0) - (a[1].clicks || 0));

    const medals = ['🥇', '🥈', '🥉'];
    container.innerHTML = sorted.map(([uid, p], i) => `
      <div class="lb-row">
        <span class="lb-rank">${medals[i] || (i + 1)}</span>
        <span class="lb-name ${uid === myUID ? 'is-me' : ''}">${p.displayName}</span>
        ${p.frozen ? '<span class="lb-frozen">❄</span>' : ''}
        <span class="lb-clicks">${p.clicks || 0}</span>
      </div>
    `).join('');
  }

  function updateRoundScoreDisplay(room) {
    const roundNum = room.game && room.game.round ? room.game.round : 1;
    const winsMap  = room.game && room.game.winsMap ? room.game.winsMap : {};
    const players  = room.players || {};

    const winsText = Object.entries(players).map(([uid, p]) => {
      const w = (winsMap[uid] && winsMap[uid].wins) || 0;
      return `${p.displayName}: ${w}W`;
    }).join(' — ');

    document.getElementById('round-score-text').textContent = `Round ${roundNum} — ${winsText}`;
  }

  // ============================================================
  // POWER-UPS
  // ============================================================

  function enablePowerups() {
    const dBtn = document.getElementById('pu-double');
    const fBtn = document.getElementById('pu-freeze');
    dBtn.disabled = false;
    fBtn.disabled = false;
    dBtn.classList.remove('active-pu');
    fBtn.classList.remove('active-pu');
  }

  window.activatePowerup = function (type) {
    if (type === 'double') {
      if (puDoubleCooldown || isDoubled) return;
      activateDouble();
    } else if (type === 'freeze') {
      if (puFreezeCooldown) return;
      activateFreezeOther();
    }
  };

  /** x2 clicks for DOUBLE_DURATION ms */
  function activateDouble() {
    isDoubled        = true;
    puDoubleCooldown = true;
    const btn        = document.getElementById('pu-double');
    const clickBtn   = document.getElementById('click-btn');
    btn.disabled     = true;
    btn.classList.add('active-pu');
    clickBtn.classList.add('double-active');
    document.getElementById('effect-indicator').textContent = '⚡ x2 CLICKS ACTIVE!';

    doubledTimeout = setTimeout(() => {
      isDoubled = false;
      clickBtn.classList.remove('double-active');
      document.getElementById('effect-indicator').textContent = '';
      btn.classList.remove('active-pu');

      // Cooldown timer shown on button
      let cd = POWERUP_COOLDOWN / 1000;
      const cdInterval = setInterval(() => {
        btn.textContent = `⚡ x2 (${--cd}s)`;
        if (cd <= 0) {
          clearInterval(cdInterval);
          btn.disabled     = false;
          btn.textContent  = '⚡ x2 Clicks';
          puDoubleCooldown = false;
        }
      }, 1000);
    }, DOUBLE_DURATION);
  }

  /** Freeze a random other player for FREEZE_DURATION ms */
  async function activateFreezeOther() {
    if (!currentRoomCode) return;
    puFreezeCooldown = true;
    const fBtn = document.getElementById('pu-freeze');
    fBtn.disabled = true;

    const snap    = await get(ref(db, `rooms/${currentRoomCode}/players`));
    if (!snap.exists()) return;
    const players = snap.val();
    const others  = Object.keys(players).filter(uid => uid !== myUID);
    if (others.length === 0) return;

    // Pick random target
    const targetUID = others[Math.floor(Math.random() * others.length)];
    await update(ref(db, `rooms/${currentRoomCode}/players/${targetUID}`), { frozen: true });

    // Unfreeze after delay
    setTimeout(async () => {
      await update(ref(db, `rooms/${currentRoomCode}/players/${targetUID}`), { frozen: false });
    }, FREEZE_DURATION);

    document.getElementById('effect-indicator').textContent = '❄ FREEZE SENT!';
    setTimeout(() => { document.getElementById('effect-indicator').textContent = ''; }, 2000);

    // Cooldown
    let cd = POWERUP_COOLDOWN / 1000;
    const cdInterval = setInterval(() => {
      fBtn.textContent = `❄ Freeze (${--cd}s)`;
      if (cd <= 0) {
        clearInterval(cdInterval);
        fBtn.disabled     = false;
        fBtn.textContent  = '❄ Freeze';
        puFreezeCooldown  = false;
      }
    }, 1000);
  }

  /** Apply freeze locally (can't click) */
  function applyFreeze(duration) {
    isFrozen = true;
    const btn = document.getElementById('click-btn');
    btn.classList.add('frozen');
    document.querySelector('.click-btn-text').textContent = '❄ FROZEN';
    document.getElementById('effect-indicator').textContent = '❄ YOU ARE FROZEN!';
    shakeScreen();

    if (frozenTimeout) clearTimeout(frozenTimeout);
    frozenTimeout = setTimeout(() => {
      isFrozen = false;
      btn.classList.remove('frozen');
      document.querySelector('.click-btn-text').textContent = 'CLICK!';
      document.getElementById('effect-indicator').textContent = '';
    }, duration);
  }

  // ============================================================
  // ROUND END (host only)
  // ============================================================

  async function endRound() {
    if (!isHost || !currentRoomCode) return;

    const snap = await get(ref(db, `rooms/${currentRoomCode}`));
    if (!snap.exists()) return;
    const room   = snap.val();
    const players = room.players || {};
    const game    = room.game || {};
    const round   = game.round || 1;
    const winsMap = game.winsMap || {};

    // Determine round winner (highest clicks)
    let winnerUID   = null;
    let maxClicks   = -1;
    Object.entries(players).forEach(([uid, p]) => {
      if ((p.clicks || 0) > maxClicks) {
        maxClicks  = p.clicks || 0;
        winnerUID  = uid;
      }
    });

    // Increment winner's round wins
    if (winnerUID) {
      if (!winsMap[winnerUID]) winsMap[winnerUID] = { wins: 0 };
      winsMap[winnerUID].wins = (winsMap[winnerUID].wins || 0) + 1;
    }

    // Check if someone has won the match
    let matchWinnerUID = null;
    Object.entries(winsMap).forEach(([uid, w]) => {
      if ((w.wins || 0) >= WINS_NEEDED) matchWinnerUID = uid;
    });

    if (matchWinnerUID) {
      // Game over
      // Update global leaderboard (increment wins)
      const winnerProfile = await get(ref(db, `users/${matchWinnerUID}`));
      if (winnerProfile.exists()) {
        const current = winnerProfile.val();
        const newWins = (current.wins || 0) + 1;
        await update(ref(db, `users/${matchWinnerUID}`), { wins: newWins });
        // Leaderboard node
        await set(ref(db, `leaderboard/${matchWinnerUID}`), {
          displayName: current.displayName,
          username: current.username,
          wins: newWins,
        });
      }

      await update(ref(db, `rooms/${currentRoomCode}`), {
        status: 'gameover',
        'game/winsMap': winsMap,
        'game/matchWinner': matchWinnerUID,
        'game/roundWinner': winnerUID,
      });
    } else {
      // Next round
      await update(ref(db, `rooms/${currentRoomCode}`), {
        status: 'roundResult',
        'game/winsMap': winsMap,
        'game/roundWinner': winnerUID,
        'game/round': round,
        'game/nextRound': round + 1,
      });

      // Auto-advance to next round after 4 seconds
      setTimeout(async () => {
        const still = await get(ref(db, `rooms/${currentRoomCode}`));
        if (still.exists() && still.val().status === 'roundResult') {
          await update(ref(db, `rooms/${currentRoomCode}`), {
            status: 'countdown',
            'game/round': round + 1,
          });
        }
      }, 4000);
    }
  }

  // ============================================================
  // ROUND RESULT SCREEN
  // ============================================================

  function showRoundResult(room) {
    showScreen('round-result');
    const players    = room.players || {};
    const game       = room.game || {};
    const winsMap    = game.winsMap || {};
    const winnerUID  = game.roundWinner;

    // Title
    const winnerName = (winnerUID && players[winnerUID]) ? players[winnerUID].displayName : 'Tie!';
    document.getElementById('round-result-title').textContent =
      winnerUID ? `${winnerName} wins the round!` : "It's a tie!";

    // Scores
    const scoresDiv  = document.getElementById('round-result-scores');
    const sorted     = Object.entries(players).sort((a, b) => (b[1].clicks || 0) - (a[1].clicks || 0));
    scoresDiv.innerHTML = sorted.map(([uid, p]) => `
      <div class="result-score-row ${uid === winnerUID ? 'winner-row' : ''}">
        <span>${p.displayName}</span>
        <span style="color:var(--yellow)">${p.clicks || 0} clicks</span>
      </div>
    `).join('');

    // Wins tally
    const winsDiv = document.getElementById('round-result-wins');
    winsDiv.innerHTML = Object.entries(players).map(([uid, p]) => {
      const w = (winsMap[uid] && winsMap[uid].wins) || 0;
      return `<span>${p.displayName}: ${w}/${WINS_NEEDED} wins</span>`;
    }).join(' &nbsp;|&nbsp; ');
  }

  // ============================================================
  // GAME OVER SCREEN
  // ============================================================

  function showGameOver(room) {
    showScreen('gameover');
    launchFireworks();

    const players      = room.players || {};
    const game         = room.game || {};
    const winnerUID    = game.matchWinner;
    const winnerName   = (winnerUID && players[winnerUID]) ? players[winnerUID].displayName : '???';

    document.getElementById('gameover-winner').textContent =
      winnerUID === myUID ? '🏆 YOU WIN! 🏆' : `🏆 ${winnerName} WINS!`;

    // Final wins tally
    const winsMap  = game.winsMap || {};
    const finalDiv = document.getElementById('gameover-final-scores');
    const sorted   = Object.entries(players).sort((a, b) => {
      const wa = (winsMap[a[0]] && winsMap[a[0]].wins) || 0;
      const wb = (winsMap[b[0]] && winsMap[b[0]].wins) || 0;
      return wb - wa;
    });
    finalDiv.innerHTML = sorted.map(([uid, p], i) => {
      const w = (winsMap[uid] && winsMap[uid].wins) || 0;
      return `
        <div class="final-score-row ${i === 0 ? 'champion' : ''}">
          <span>${p.displayName}</span>
          <span>${w} wins</span>
        </div>
      `;
    }).join('');

    // Update local lobby score display for this session
    if (winnerUID === myUID) {
      get(ref(db, `users/${myUID}`)).then(snap => {
        if (snap.exists()) {
          document.getElementById('lobby-score-display').textContent = `🏆 ${snap.val().wins || 0}`;
        }
      });
    }
  }

  /** Return to lobby from game over */
  window.returnToLobby = async function () {
    // Remove from room
    if (currentRoomCode && myUID) {
      await remove(ref(db, `rooms/${currentRoomCode}/players/${myUID}`));
    }
    // If last player or host, clean up room
    if (currentRoomCode) {
      const snap = await get(ref(db, `rooms/${currentRoomCode}/players`));
      if (!snap.exists() || Object.keys(snap.val()).length === 0) {
        await remove(ref(db, `rooms/${currentRoomCode}`));
      }
    }
    if (roomListener && roomRef) {
      off(roomRef, 'value', roomListener);
      roomListener = null;
    }
    currentRoomCode = null;
    isHost          = false;
    clearGameState();
    showScreen('lobby');
  };

  // ============================================================
  // GLOBAL LEADERBOARD
  // ============================================================

  window.openLeaderboard = async function () {
    document.getElementById('leaderboard-modal').style.display = 'flex';
    const snap = await get(ref(db, 'leaderboard'));
    const list = document.getElementById('global-lb-list');
    list.innerHTML = '';

    if (!snap.exists()) {
      list.innerHTML = '<p style="color:var(--text-dim);text-align:center;font-size:0.85rem;">No data yet.</p>';
      return;
    }

    const entries = Object.entries(snap.val())
      .sort((a, b) => (b[1].wins || 0) - (a[1].wins || 0))
      .slice(0, 20);

    const rankClass = ['gold', 'silver', 'bronze'];
    entries.forEach(([uid, data], i) => {
      const row = document.createElement('div');
      row.className = 'glb-row';
      row.innerHTML = `
        <span class="glb-rank ${rankClass[i] || ''}">#${i + 1}</span>
        <span class="glb-name">${data.displayName} <span style="color:var(--text-dim);font-size:0.75rem">@${data.username}</span></span>
        <span class="glb-wins">${data.wins} wins</span>
      `;
      list.appendChild(row);
    });
  };

  window.closeLeaderboard = function () {
    document.getElementById('leaderboard-modal').style.display = 'none';
  };

  // ============================================================
  // KEYBOARD SUPPORT
  // ============================================================

  document.addEventListener('keydown', (e) => {
    // Space or Enter to click
    if ((e.code === 'Space' || e.code === 'Enter') &&
        document.getElementById('screen-game').classList.contains('active')) {
      e.preventDefault();
      window.handleClick();
    }
  });

  // ============================================================
  // PREVENT DOUBLE-TAP ZOOM ON MOBILE
  // ============================================================

  let lastTap = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) e.preventDefault();
    lastTap = now;
  }, { passive: false });

  console.log('✅ Click Spam PRO — Game engine loaded.');

})(); // end async IIFE
