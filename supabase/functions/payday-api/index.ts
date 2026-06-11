import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// @ts-ignore Deno import
import { GameEngine } from "./game-engine.ts";

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
