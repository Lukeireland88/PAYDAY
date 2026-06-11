import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// @ts-ignore Deno import
export const GameEngine = (() => {
'use strict';

  const LOTTERY_BANK_AMOUNT = 1000;
  const LOTTERY_PLAYER_AMOUNT = 100;

  function uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  function defaultState() {
    return {
      gameStarted: false,
      enforceIncrements: true,
      startingBalance: 3500,
      jackpot: 0,
      players: [],
      transactions: [],
      theme: 'light',
      peakBalances: {}
    };
  }

  function defaultPlayer(name, salary, cash) {
    return { id: uid(), name, cash, loan: 0, savings: 0, salary, paydayCount: 0, bills: [] };
  }

  function editionRules() {
    return { loanRate: 0.10, repayInc: 1000 };
  }

  function getPlayer(state, id) {
    return state.players.find(p => p.id === id);
  }

  function billsTotal(p) {
    return p.bills.reduce((s, b) => s + b.amount, 0);
  }

  function netWorth(p) {
    return p.cash - p.loan - billsTotal(p);
  }

  function loanIncrement(state) {
    return editionRules().repayInc;
  }

  function calcAutoLoanAmount(shortfall) {
    if (shortfall <= 0) return 0;
    const inc = editionRules().repayInc;
    return Math.ceil(shortfall / inc) * inc;
  }

  function validateLoanTakeAmount(amount) {
    const inc = editionRules().repayInc;
    if (amount < inc) return `Loans must be at least ${inc}.`;
    if (amount % inc !== 0) return `Loans must be taken in ${inc} increments.`;
    return null;
  }

  function validateLoanBalance(remainingLoan) {
    if (remainingLoan <= 0) return null;
    const inc = editionRules().repayInc;
    if (remainingLoan < inc) {
      return `Loan balance cannot be less than ${inc}. Repay in full or leave at least ${inc}.`;
    }
    if (remainingLoan % inc !== 0) {
      return `Loan balance must be in ${inc} increments.`;
    }
    return null;
  }

  function validateRepayIncrement(state, amount) {
    if (!state.enforceIncrements) return null;
    const inc = editionRules().repayInc;
    if (amount % inc !== 0) return `Repayments must be in ${inc} increments.`;
    return null;
  }

  function captureSnapshot(state, ids) {
    const snap = { jackpot: state.jackpot, players: {} };
    ids.forEach(id => {
      const p = getPlayer(state, id);
      if (p) {
        snap.players[id] = {
          cash: p.cash, loan: p.loan, savings: p.savings,
          bills: JSON.parse(JSON.stringify(p.bills)),
          paydayCount: p.paydayCount, salary: p.salary
        };
      }
    });
    return snap;
  }

  function restoreSnapshot(state, snap) {
    if (!snap) return;
    state.jackpot = snap.jackpot;
    Object.entries(snap.players || {}).forEach(([id, d]) => {
      const p = getPlayer(state, id);
      if (p) Object.assign(p, d);
    });
  }

  function trackPeak(state, p) {
    const nw = p.cash - p.loan;
    if (!state.peakBalances[p.id] || nw > state.peakBalances[p.id]) {
      state.peakBalances[p.id] = nw;
    }
  }

  function logTxn(state, type, amount, from, to, note, snap) {
    state.transactions.push({
      id: uid(), timestamp: Date.now(), type, amount, from, to,
      note: note || '', undoSnapshot: snap
    });
  }

  function applyAutoLoan(player, shortfall) {
    const loanAmount = calcAutoLoanAmount(shortfall);
    const loanErr = validateLoanTakeAmount(loanAmount);
    if (loanErr) return { ok: false, err: loanErr };
    player.cash += loanAmount;
    player.loan += loanAmount;
    return { ok: true, loanAmount };
  }

  function mutateBankPayment(state, playerId, amount) {
    getPlayer(state, playerId).cash += amount;
    return { ok: true };
  }

  function mutateBankDeposit(state, playerId, amount) {
    getPlayer(state, playerId).cash -= amount;
    return { ok: true };
  }

  function mutateTransfer(state, fromId, toId, amount, allowLoan) {
    const payer = getPlayer(state, fromId);
    const recip = getPlayer(state, toId);
    const short = amount - payer.cash;
    if (short > 0) {
      if (!allowLoan) return { ok: false, err: `Insufficient cash (short ${short})` };
      const lr = applyAutoLoan(payer, short);
      if (!lr.ok) return lr;
    }
    if (payer.cash < amount) return { ok: false, err: 'Insufficient cash' };
    payer.cash -= amount;
    recip.cash += amount;
    return { ok: true };
  }

  function mutateLoan(state, playerId, amount) {
    const loanErr = validateLoanTakeAmount(amount);
    if (loanErr) return { ok: false, err: loanErr };
    const p = getPlayer(state, playerId);
    p.cash += amount;
    p.loan += amount;
    return { ok: true };
  }

  function mutateRepay(state, playerId, amount) {
    const p = getPlayer(state, playerId);
    if (amount > p.loan) return { ok: false, err: 'Exceeds loan balance' };
    if (amount > p.cash) return { ok: false, err: 'Insufficient cash' };
    const incErr = validateRepayIncrement(state, amount);
    if (incErr) return { ok: false, err: incErr };
    const remaining = p.loan - amount;
    const balErr = validateLoanBalance(remaining);
    if (balErr) return { ok: false, err: balErr };
    p.cash -= amount;
    p.loan -= amount;
    return { ok: true };
  }

  function mutateJackpotContrib(state, fromId, amount) {
    const p = getPlayer(state, fromId);
    if (p.cash < amount) return { ok: false, err: 'Insufficient cash' };
    p.cash -= amount;
    state.jackpot += amount;
    return { ok: true };
  }

  function mutateJackpotPayout(state, toId, amount) {
    if (amount > state.jackpot) return { ok: false, err: 'Exceeds jackpot' };
    state.jackpot -= amount;
    getPlayer(state, toId).cash += amount;
    return { ok: true };
  }

  function calcLoanInterest(p) {
    if (p.loan <= 0) return 0;
    return Math.round(p.loan * editionRules().loanRate);
  }

  function paydayCashAfterInterest(p) {
    return p.cash + p.salary - calcLoanInterest(p);
  }

  function getPaydayLoanRepayOptions(state, p) {
    const afterInt = paydayCashAfterInterest(p);
    const inc = loanIncrement(state);
    const amounts = [0];
    for (let repay = inc; repay <= Math.min(p.loan, afterInt); repay += inc) {
      if (validateLoanBalance(p.loan - repay) === null) amounts.push(repay);
    }
    if (p.loan > 0 && p.loan <= afterInt && validateLoanBalance(0) === null && !amounts.includes(p.loan)) {
      amounts.push(p.loan);
    }
    return amounts;
  }

  function processPayday(state, playerId, loanRepayAmount, autoLoan) {
    const p = getPlayer(state, playerId);
    const snap = captureSnapshot(state, [playerId]);
    const salary = p.salary;
    const loanInt = calcLoanInterest(p);
    const billsDue = billsTotal(p);

    p.cash += salary;
    if (loanInt > 0) p.cash -= loanInt;

    if (loanRepayAmount > 0) {
      const rr = mutateRepay(state, playerId, loanRepayAmount);
      if (!rr.ok) { restoreSnapshot(state, snap); return rr; }
    }

    if (p.cash < billsDue) {
      if (!autoLoan) {
        restoreSnapshot(state, snap);
        return { ok: false, err: `Insufficient cash for all bills (${billsDue} due). Enable auto-loan.` };
      }
      const lr = applyAutoLoan(p, billsDue - p.cash);
      if (!lr.ok) { restoreSnapshot(state, snap); return lr; }
    }

    p.cash -= billsDue;
    p.bills = [];
    p.paydayCount += 1;

    const repayNote = loanRepayAmount > 0 ? `, Loan repaid -${loanRepayAmount}` : '';
    const note = `Salary +${salary}, Interest -${loanInt}${repayNote}, Bills -${billsDue}`;
    logTxn(state, 'payday_salary', salary, 'bank', playerId, note, snap);
    trackPeak(state, p);
    return { ok: true };
  }

  function lotteryPrizeFromEntrantCount(n) {
    return LOTTERY_BANK_AMOUNT + LOTTERY_PLAYER_AMOUNT * n;
  }

  function runLottery(state, winnerId, entrantIds) {
    const winner = getPlayer(state, winnerId);
    if (!winner) return { ok: false, err: 'Winner not found.' };

    const entrants = entrantIds.map(id => getPlayer(state, id)).filter(Boolean);
    const broke = entrants.filter(p => p.cash < LOTTERY_PLAYER_AMOUNT);
    if (broke.length) {
      return { ok: false, err: `Cannot afford ${LOTTERY_PLAYER_AMOUNT} entry: ${broke.map(p => p.name).join(', ')}` };
    }

    const prize = lotteryPrizeFromEntrantCount(entrants.length);
    const snap = captureSnapshot(state, state.players.map(p => p.id));
    snap.jackpot = state.jackpot;

    entrants.forEach(p => { p.cash -= LOTTERY_PLAYER_AMOUNT; });
    winner.cash += prize;

    const entrantNote = entrants.length
      ? `Entrants (${LOTTERY_PLAYER_AMOUNT} each): ${entrants.map(p => p.name).join(', ')}`
      : 'No player entries';
    const note = `Bank ${LOTTERY_BANK_AMOUNT} + ${entrants.length} × ${LOTTERY_PLAYER_AMOUNT}. ${entrantNote}`;
    logTxn(state, 'lottery_draw', prize, 'bank', winnerId, note, snap);
    state.players.forEach(p => trackPeak(state, p));
    return { ok: true, prize };
  }

  function doTxn(state, type, amount, from, to, note, mutateFn) {
    const ids = [];
    if (from && from !== 'bank' && from !== 'jackpot') ids.push(from);
    if (to && to !== 'bank' && to !== 'jackpot') ids.push(to);
    const unique = [...new Set(ids)];
    const snap = captureSnapshot(state, unique.length ? unique : state.players.map(p => p.id));
    snap.jackpot = state.jackpot;
    const result = mutateFn();
    if (result && result.ok === false) return result;
    logTxn(state, type, amount, from, to, note, snap);
    state.players.forEach(p => trackPeak(state, p));
    return { ok: true, ...result };
  }

  function undo(state, n) {
    n = n || 1;
    for (let i = 0; i < n && state.transactions.length; i++) {
      const t = state.transactions.pop();
      restoreSnapshot(state, t.undoSnapshot);
    }
    return { ok: true };
  }

  function canActOnPlayer(ctx, targetPlayerId) {
    if (ctx.role === 'banker') return true;
    return ctx.playerId === targetPlayerId;
  }

  function isBankerOnly(actionType) {
    return [
      'payday', 'lottery', 'jackpot_six', 'jackpot_edit', 'edit',
      'undo', 'reset', 'bill_remove', 'start_game'
    ].includes(actionType);
  }

  /**
   * Apply a game action. ctx: { role: 'banker'|'player', playerId: string|null }
   * payload shapes match client dispatchAction calls.
   */
  function applyGameAction(state, ctx, action) {
    const type = action.type;
    const p = action.playerId;

    if (isBankerOnly(type) && ctx.role !== 'banker') {
      return { ok: false, err: 'Banker only action.' };
    }
    if (p && !canActOnPlayer(ctx, p) && !['lottery', 'jackpot_six'].includes(type)) {
      return { ok: false, err: 'Cannot act on another player.' };
    }

    switch (type) {
      case 'bank_payment':
        return doTxn(state, 'bank_payment', action.amount, 'bank', p, action.note || '',
          () => mutateBankPayment(state, p, action.amount));
      case 'bank_deposit': {
        const player = getPlayer(state, p);
        if (player.cash < action.amount) return { ok: false, err: 'Insufficient cash' };
        return doTxn(state, 'bank_deposit', action.amount, p, 'bank', action.note || '',
          () => mutateBankDeposit(state, p, action.amount));
      }
      case 'player_transfer':
        return doTxn(state, 'player_transfer', action.amount, p, action.toPlayerId, action.note || '',
          () => mutateTransfer(state, p, action.toPlayerId, action.amount, !!action.useLoan));
      case 'loan_taken':
        return doTxn(state, 'loan_taken', action.amount, p, 'bank', action.note || '',
          () => mutateLoan(state, p, action.amount));
      case 'bill_added': {
        const player = getPlayer(state, p);
        const snap = captureSnapshot(state, [p]);
        player.bills.push({ id: uid(), amount: action.amount, description: action.description || 'Bill' });
        logTxn(state, 'bill_added', action.amount, p, 'bank', action.description || 'Bill', snap);
        trackPeak(state, player);
        return { ok: true };
      }
      case 'bill_paid': {
        const player = getPlayer(state, p);
        const bill = player.bills.find(b => b.id === action.billId);
        if (!bill) return { ok: false, err: 'Bill not found.' };
        if (player.cash < bill.amount) {
          if (!action.useLoan) return { ok: false, err: 'Insufficient cash' };
          const lr = applyAutoLoan(player, bill.amount - player.cash);
          if (!lr.ok) return lr;
        }
        const snap = captureSnapshot(state, [p]);
        player.cash -= bill.amount;
        player.bills = player.bills.filter(b => b.id !== action.billId);
        logTxn(state, 'bill_paid', bill.amount, p, 'bank', bill.description, snap);
        trackPeak(state, player);
        return { ok: true };
      }
      case 'bill_remove': {
        const player = getPlayer(state, p);
        const bill = player.bills.find(b => b.id === action.billId);
        if (!bill) return { ok: false, err: 'Bill not found.' };
        const snap = captureSnapshot(state, [p]);
        player.bills = player.bills.filter(b => b.id !== action.billId);
        logTxn(state, 'manual_adjustment', bill.amount, p, 'bank', 'Bill removed: ' + bill.description, snap);
        return { ok: true };
      }
      case 'payday':
        return processPayday(state, p, action.loanRepayAmount || 0, action.autoLoan !== false);
      case 'jackpot_contribution':
        return doTxn(state, 'jackpot_contribution', action.amount, p, 'jackpot', action.note || '',
          () => mutateJackpotContrib(state, p, action.amount));
      case 'jackpot_six': {
        const amt = state.jackpot;
        if (amt <= 0) return { ok: false, err: 'Jackpot is empty.' };
        return doTxn(state, 'jackpot_six', amt, 'jackpot', action.winnerId, 'Rolled a 6 on regular turn',
          () => mutateJackpotPayout(state, action.winnerId, amt));
      }
      case 'jackpot_edit': {
        const snap = { jackpot: state.jackpot, players: {} };
        state.jackpot = action.amount;
        logTxn(state, 'manual_adjustment', action.amount, 'bank', 'jackpot', action.note || 'Jackpot edit', snap);
        return { ok: true };
      }
      case 'lottery':
        return runLottery(state, action.winnerId, action.entrantIds || []);
      case 'edit': {
        const player = getPlayer(state, p);
        const snap = captureSnapshot(state, [p]);
        const loanBalErr = validateLoanBalance(action.loan);
        if (loanBalErr) return { ok: false, err: loanBalErr };
        player.name = action.name;
        player.cash = action.cash;
        player.loan = action.loan;
        player.salary = action.salary;
        logTxn(state, 'manual_adjustment', 0, p, p, action.note || 'Manual edit', snap);
        return { ok: true };
      }
      case 'undo':
        return undo(state, action.count || 1);
      case 'reset': {
        state.players.forEach(pl => {
          pl.cash = state.startingBalance;
          pl.loan = 0;
          pl.bills = [];
          pl.paydayCount = 0;
        });
        state.jackpot = 0;
        state.transactions = [];
        return { ok: true };
      }
      default:
        return { ok: false, err: 'Unknown action: ' + type };
    }
  }

  function buildLobbyState(names, salaries, startingBalance, enforceIncrements) {
    const state = defaultState();
    state.enforceIncrements = enforceIncrements !== false;
    state.startingBalance = startingBalance;
    state.players = names.map((n, i) => defaultPlayer(n, salaries[i] || 3500, startingBalance));
    return state;
  }

  function startGameState(state) {
    state.gameStarted = true;
    return state;
  }

  return {
    LOTTERY_BANK_AMOUNT,
    LOTTERY_PLAYER_AMOUNT,
    uid,
    defaultState,
    defaultPlayer,
    editionRules,
    getPlayer,
    billsTotal,
    netWorth,
    loanIncrement,
    calcAutoLoanAmount,
    getPaydayLoanRepayOptions,
    paydayCashAfterInterest,
    calcLoanInterest,
    lotteryPrizeFromEntrantCount,
    applyGameAction,
    buildLobbyState,
    startGameState,
    canActOnPlayer,
    isBankerOnly
  };
})();


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400) {
  return json({ ok: false, err: message }, status);
}

async function uniqueRoomCode(supabase: ReturnType<typeof createClient>) {
  for (let i = 0; i < 10; i++) {
    const code = Array.from({ length: 6 }, () => {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      return chars[Math.floor(Math.random() * chars.length)];
    }).join("");
    const { data } = await supabase.from("games").select("id").eq("room_code", code).maybeSingle();
    if (!data) return code;
  }
  throw new Error("Could not generate room code");
}

async function getSession(supabase: ReturnType<typeof createClient>, sessionId: string) {
  const { data, error } = await supabase
    .from("game_sessions")
    .select("*, games(*)")
    .eq("id", sessionId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const { action, sessionId, roomCode, payload = {} } = body;

    if (action === "create_game") {
      const { playerNames, salaries, startingBalance, enforceIncrements, bankerName } = payload;
      if (!Array.isArray(playerNames) || playerNames.length < 2 || playerNames.length > 6) {
        return err("Need 2–6 players.");
      }
      const code = await uniqueRoomCode(supabase);
      const state = GameEngine.buildLobbyState(
        playerNames,
        salaries || playerNames.map(() => 3500),
        startingBalance ?? 3500,
        enforceIncrements
      );

      const { data: game, error: gameErr } = await supabase
        .from("games")
        .insert({ room_code: code, state, status: "lobby" })
        .select()
        .single();
      if (gameErr || !game) return err(gameErr?.message || "Failed to create game", 500);

      const { data: session, error: sessErr } = await supabase
        .from("game_sessions")
        .insert({
          game_id: game.id,
          role: "banker",
          display_name: bankerName || "Banker",
          player_id: null,
        })
        .select()
        .single();
      if (sessErr || !session) return err(sessErr?.message || "Failed to create session", 500);

      await supabase.from("games").update({ banker_session_id: session.id }).eq("id", game.id);

      return json({
        ok: true,
        sessionId: session.id,
        gameId: game.id,
        roomCode: code,
        role: "banker",
        game: { ...game, banker_session_id: session.id },
        sessions: [session],
      });
    }

    if (action === "join_game") {
      if (!roomCode) return err("Room code required.");
      const { data: game, error: gameErr } = await supabase
        .from("games")
        .select("*")
        .eq("room_code", String(roomCode).toUpperCase())
        .maybeSingle();
      if (gameErr || !game) return err("Game not found.");

      let session;
      if (sessionId) {
        session = await getSession(supabase, sessionId);
        if (!session || session.game_id !== game.id) session = null;
      }

      if (!session) {
        const { data: newSession, error: sessErr } = await supabase
          .from("game_sessions")
          .insert({
            game_id: game.id,
            role: "player",
            display_name: payload.displayName || "Player",
            player_id: null,
          })
          .select()
          .single();
        if (sessErr || !newSession) return err(sessErr?.message || "Failed to join", 500);
        session = { ...newSession, games: game };
      } else {
        await supabase
          .from("game_sessions")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("id", session.id);
      }

      const { data: sessions } = await supabase
        .from("game_sessions")
        .select("*")
        .eq("game_id", game.id)
        .order("created_at");

      return json({
        ok: true,
        sessionId: session.id,
        gameId: game.id,
        roomCode: game.room_code,
        role: session.role,
        playerId: session.player_id,
        game,
        sessions: sessions || [],
      });
    }

    if (!sessionId) return err("Session required.");

    const session = await getSession(supabase, sessionId);
    if (!session) return err("Invalid session.", 401);

    const game = session.games as Record<string, unknown>;
    const gameId = game.id as string;

    if (action === "claim_player") {
      const { playerId } = payload;
      if (!playerId) return err("Player slot required.");

      const state = game.state as ReturnType<typeof GameEngine.defaultState>;
      if (!state.players?.find((p: { id: string }) => p.id === playerId)) {
        return err("Invalid player slot.");
      }

      const { data: taken } = await supabase
        .from("game_sessions")
        .select("id")
        .eq("game_id", gameId)
        .eq("player_id", playerId)
        .neq("id", sessionId)
        .maybeSingle();
      if (taken) return err("Slot already claimed.");

      const updates: Record<string, unknown> = {
        player_id: playerId,
        last_seen_at: new Date().toISOString(),
      };
      if (payload.displayName) updates.display_name = payload.displayName;

      await supabase.from("game_sessions").update(updates).eq("id", sessionId);

      const { data: sessions } = await supabase
        .from("game_sessions")
        .select("*")
        .eq("game_id", gameId);

      const { data: updatedGame } = await supabase.from("games").select("*").eq("id", gameId).single();

      return json({
        ok: true,
        playerId,
        game: updatedGame,
        sessions: sessions || [],
      });
    }

    if (action === "start_game") {
      if (session.role !== "banker") return err("Banker only.", 403);
      const state = JSON.parse(JSON.stringify(game.state));
      GameEngine.startGameState(state);

      const { data: updated, error: upErr } = await supabase
        .from("games")
        .update({ state, status: "active", version: (game.version as number) + 1, updated_at: new Date().toISOString() })
        .eq("id", gameId)
        .eq("version", game.version)
        .select()
        .single();

      if (upErr || !updated) return err("Concurrent update — retry.", 409);

      await supabase.from("game_actions").insert({
        game_id: gameId,
        session_id: sessionId,
        action_type: "start_game",
        payload: {},
      });

      return json({ ok: true, game: updated });
    }

    if (action === "game_action") {
      if (game.status !== "active") return err("Game not active.");
      const gameAction = payload.gameAction;
      if (!gameAction?.type) return err("Invalid game action.");
      if (session.role === "player" && !session.player_id) {
        return err("Claim a player slot before taking actions.");
      }

      const state = JSON.parse(JSON.stringify(game.state));
      const ctx = {
        role: session.role as "banker" | "player",
        playerId: session.player_id as string | null,
      };

      const result = GameEngine.applyGameAction(state, ctx, gameAction);
      if (!result.ok) return err(result.err || "Action failed.");

      const { data: updated, error: upErr } = await supabase
        .from("games")
        .update({
          state,
          version: (game.version as number) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", gameId)
        .eq("version", game.version)
        .select()
        .single();

      if (upErr || !updated) return err("Concurrent update — retry.", 409);

      await supabase.from("game_actions").insert({
        game_id: gameId,
        session_id: sessionId,
        action_type: gameAction.type,
        payload: gameAction,
      });

      return json({ ok: true, game: updated, result });
    }

    if (action === "heartbeat") {
      await supabase
        .from("game_sessions")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", sessionId);

      const { data: sessions } = await supabase
        .from("game_sessions")
        .select("*")
        .eq("game_id", gameId);

      const { data: freshGame } = await supabase.from("games").select("*").eq("id", gameId).single();

      return json({ ok: true, game: freshGame, sessions: sessions || [] });
    }

    return err("Unknown action.");
  } catch (e) {
    return err(e instanceof Error ? e.message : "Server error", 500);
  }
});
