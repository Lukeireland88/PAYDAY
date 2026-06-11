/**
 * Supabase multiplayer client for Payday Bank.
 */
window.PaydayMultiplayer = (function () {
  const cfg = window.PAYDAY_CONFIG;
  const supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  let session = loadSession();
  let gameRow = null;
  let sessions = [];
  let channel = null;
  let onUpdate = null;
  let heartbeatTimer = null;

  function loadSession() {
    try {
      const raw = localStorage.getItem(cfg.SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function saveSession(s) {
    session = s;
    if (s) localStorage.setItem(cfg.SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(cfg.SESSION_KEY);
  }

  async function api(body) {
    const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/payday-api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.SUPABASE_ANON_KEY}`,
        'apikey': cfg.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ sessionId: session?.sessionId, ...body })
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.err || `Request failed (${res.status})`);
    return data;
  }

  function applyResponse(data) {
    if (data.sessionId) {
      saveSession({
        sessionId: data.sessionId,
        gameId: data.gameId,
        roomCode: data.roomCode,
        role: data.role,
        playerId: data.playerId || null
      });
    }
    if (data.playerId !== undefined && session) {
      session.playerId = data.playerId;
      saveSession(session);
    }
    if (data.game) gameRow = data.game;
    if (data.sessions) sessions = data.sessions;
    return data;
  }

  function getState() {
    return gameRow?.state || null;
  }

  function isBanker() {
    return session?.role === 'banker';
  }

  function getPlayerId() {
    return session?.playerId || null;
  }

  function getRoomCode() {
    return session?.roomCode || gameRow?.room_code || null;
  }

  function getGameStatus() {
    return gameRow?.status || 'lobby';
  }

  function joinLink() {
    const code = getRoomCode();
    if (!code) return location.href.split('?')[0];
    const base = location.href.split('?')[0];
    return `${base}?room=${code}`;
  }

  async function createGame(payload) {
    const data = applyResponse(await api({ action: 'create_game', payload }));
    subscribe(data.gameId);
    return data;
  }

  async function joinGame(roomCode, displayName) {
    const data = applyResponse(await api({
      action: 'join_game',
      roomCode: String(roomCode).toUpperCase(),
      payload: { displayName }
    }));
    subscribe(data.gameId);
    return data;
  }

  async function reconnect() {
    if (!session?.sessionId || !session?.roomCode) return null;
    const data = applyResponse(await api({
      action: 'join_game',
      roomCode: session.roomCode,
      payload: {}
    }));
    subscribe(data.gameId);
    return data;
  }

  async function claimPlayer(playerId, displayName) {
    const data = applyResponse(await api({
      action: 'claim_player',
      payload: { playerId, displayName }
    }));
    return data;
  }

  async function startGame() {
    const data = applyResponse(await api({ action: 'start_game' }));
    return data;
  }

  async function dispatchGameAction(gameAction) {
    const data = applyResponse(await api({
      action: 'game_action',
      payload: { gameAction }
    }));
    onUpdate?.();
    return data;
  }

  async function heartbeat() {
    if (!session?.sessionId) return;
    try {
      applyResponse(await api({ action: 'heartbeat' }));
      onUpdate?.();
    } catch (_) { /* ignore */ }
  }

  function subscribe(gameId) {
    if (channel) {
      supabase.removeChannel(channel);
      channel = null;
    }
    if (!gameId) return;

    channel = supabase
      .channel(`game:${gameId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'games',
        filter: `id=eq.${gameId}`
      }, payload => {
        gameRow = payload.new;
        onUpdate?.();
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'game_sessions',
        filter: `game_id=eq.${gameId}`
      }, async () => {
        try {
          applyResponse(await api({ action: 'heartbeat' }));
        } catch (_) { /* ignore */ }
        onUpdate?.();
      })
      .subscribe();

    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(heartbeat, 30000);
  }

  function setOnUpdate(fn) {
    onUpdate = fn;
  }

  function clearSession() {
    if (channel) supabase.removeChannel(channel);
    channel = null;
    clearInterval(heartbeatTimer);
    gameRow = null;
    sessions = [];
    saveSession(null);
  }

  function claimedPlayerIds() {
    return new Set(sessions.filter(s => s.player_id).map(s => s.player_id));
  }

  function sessionForPlayer(playerId) {
    return sessions.find(s => s.player_id === playerId);
  }

  function isPlayerOnline(playerId) {
    const s = sessionForPlayer(playerId);
    if (!s) return false;
    const seen = new Date(s.last_seen_at).getTime();
    return Date.now() - seen < 90000;
  }

  return {
    supabase,
    getState,
    isBanker,
    getPlayerId,
    getRoomCode,
    getGameStatus,
    joinLink,
    createGame,
    joinGame,
    reconnect,
    claimPlayer,
    startGame,
    dispatchGameAction,
    setOnUpdate,
    clearSession,
    loadSession,
    get session() { return session; },
    get sessions() { return sessions; },
    get gameRow() { return gameRow; },
    claimedPlayerIds,
    sessionForPlayer,
    isPlayerOnline
  };
})();
