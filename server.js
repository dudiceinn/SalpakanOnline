require('dotenv').config();
const http      = require('http');
const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const { Pool }  = require('pg');

const PORT               = process.env.PORT || 8080;
const RECONNECT_WINDOW_MS = 60000;
const HOTEL_API_URL      = process.env.HOTEL_API_URL || 'https://api.dudicehotel.com';

// ─── Neon PostgreSQL ─────────────────────────────────────────────────────────

const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pgPool.query('SELECT 1').then(() => console.log('Connected to Neon PostgreSQL'))
    .catch(e => console.error('Neon connection failed:', e.message));

// ─── Collections ──────────────────────────────────────────────────────────────

const rooms        = new Map();
const lobbyClients = new Set();

// ─── Room Factory ─────────────────────────────────────────────────────────────

function makeRoom(id) {
    return {
        id,
        redClient: null, blueClient: null,
        redSessionId: null, blueSessionId: null,
        redPlayerName: null, bluePlayerName: null,
        redCustomerId: null, blueCustomerId: null,
        redContactNumber: null, blueContactNumber: null,
        gameState: 'WAITING_FOR_OPPONENT',
        redReady: false, blueReady: false,
        board: {},
        currentTurn: 'RED',
        gameResetTimer: null,
        redCaptured: [],   // pieces captured FROM red (red's losses)
        blueCaptured: [],  // pieces captured FROM blue (blue's losses)
        spectators: new Set(), // ws clients watching
        rematchVotes: { RED: false, BLUE: false },
        createdAt: Date.now()
    };
}

function generateRoomId() {
    let id;
    do { id = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(id));
    return id;
}

// ─── Messaging Helpers ────────────────────────────────────────────────────────

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcastRoom(room, data) {
    send(room.redClient, data);
    send(room.blueClient, data);
}

function broadcastAll(room, data) {
    broadcastRoom(room, data);
    for (const s of room.spectators) send(s, data);
}

function broadcastLobbyState() {
    const list = openRooms();
    const msg  = JSON.stringify({ type: 'lobby_state', payload: { rooms: list } });
    for (const c of lobbyClients) {
        if (c.readyState === WebSocket.OPEN) c.send(msg);
    }
}

function sendLobbyState(ws) {
    send(ws, { type: 'lobby_state', payload: { rooms: openRooms() } });
}

function openRooms() {
    return [...rooms.values()]
        .filter(r => r.gameState === 'WAITING_FOR_OPPONENT')
        .map(r => ({ id: r.id, creatorName: r.redPlayerName || null }));
}

function activeGames() {
    return [...rooms.values()]
        .filter(r => r.gameState === 'BATTLE_PHASE' || r.gameState === 'PLACEMENT_PHASE')
        .map(r => ({
            id: r.id,
            redName: r.redPlayerName || 'Guest',
            blueName: r.bluePlayerName || 'Guest',
            spectatorCount: r.spectators.size,
            gameState: r.gameState
        }));
}

function spectatorNames(room) {
    return [...room.spectators]
        .filter(s => s.readyState === WebSocket.OPEN)
        .map(s => s.playerName || 'Guest');
}

function broadcastSpectatorList(room) {
    const names = spectatorNames(room);
    broadcastAll(room, { type: 'spectator_list', payload: { spectators: names, count: names.length } });
}

// ─── Rank & Battle ────────────────────────────────────────────────────────────

function getRankValue(rank) {
    return { Private:1, Sergeant:2, '2ndLt':3, '1stLt':4, Captain:5,
             Major:6, LtCol:7, Colonel:8, '1Star':9, '2Star':10,
             '3Star':11, '4Star':12, '5Star':13 }[rank] || 0;
}

function resolveBattle(a, d) {
    if (d === 'Flag') return { Outcome: 3, WinnerRank: a };
    if (a === 'Spy' || d === 'Spy') {
        if (a === 'Spy' && d === 'Spy') return { Outcome: 2, WinnerRank: null };
        if (a === 'Private') return { Outcome: 0, WinnerRank: 'Private' };
        if (d === 'Private') return { Outcome: 1, WinnerRank: 'Private' };
        return a === 'Spy' ? { Outcome: 0, WinnerRank: 'Spy' }
                           : { Outcome: 1, WinnerRank: 'Spy' };
    }
    if (a === d) return { Outcome: 2, WinnerRank: null };
    return getRankValue(a) > getRankValue(d)
        ? { Outcome: 0, WinnerRank: a }
        : { Outcome: 1, WinnerRank: d };
}

// ─── Placement Validation ─────────────────────────────────────────────────────

function validatePlacement(role, pieces, board) {
    if (pieces.length !== 21)
        return { isValid: false, errorMessage: `Need exactly 21 pieces, got ${pieces.length}.` };

    const pos = new Set();
    for (const p of pieces) {
        const k = `${p.x}_${p.y}`;
        if (pos.has(k)) return { isValid: false, errorMessage: `Duplicate position (${p.x},${p.y})` };
        pos.add(k);
    }
    for (const p of pieces)
        if (p.x < 0 || p.x > 8 || p.y < 0 || p.y > 7)
            return { isValid: false, errorMessage: `Out-of-bounds: (${p.x},${p.y})` };

    const validRows = role === 'RED' ? [5,6,7] : [0,1,2];
    for (const p of pieces)
        if (!validRows.includes(p.y))
            return { isValid: false, errorMessage: `(${p.x},${p.y}) is outside your starting zone` };

    for (const p of pieces)
        if (board[`${p.x}_${p.y}`])
            return { isValid: false, errorMessage: `(${p.x},${p.y}) is already occupied` };

    const counts = {};
    for (const p of pieces) counts[p.rank] = (counts[p.rank] || 0) + 1;
    const expected = { Flag:1, Spy:2, Private:6, Sergeant:1, '2ndLt':1, '1stLt':1,
                       Captain:1, Major:1, LtCol:1, Colonel:1, '1Star':1, '2Star':1,
                       '3Star':1, '4Star':1, '5Star':1 };
    for (const [rank, exp] of Object.entries(expected)) {
        if ((counts[rank] || 0) !== exp)
            return { isValid: false, errorMessage: `${rank}: need ${exp}, got ${counts[rank] || 0}` };
    }
    return { isValid: true };
}

function boardForPlayer(board, role) {
    return Object.entries(board).map(([key, cell]) => {
        const [x, y] = key.split('_').map(Number);
        return { x, y, owner: cell.owner,
                 rank: cell.owner === role ? cell.rank : 'Unknown',
                 revealed: cell.owner === role };
    });
}

// Spectators see all pieces as unknown
function boardForSpectator(board) {
    return Object.entries(board).map(([key, cell]) => {
        const [x, y] = key.split('_').map(Number);
        return { x, y, owner: cell.owner, rank: cell.rank, revealed: true };
    });
}

// ─── Room Actions ─────────────────────────────────────────────────────────────

function createRoom(ws) {
    const id   = generateRoomId();
    const room = makeRoom(id);
    room.redClient    = ws;
    room.redSessionId = crypto.randomBytes(16).toString('hex');
    room.redPlayerName = ws.playerName || null;
    room.redCustomerId = ws.customerId || null;
    room.redContactNumber = ws.contactNumber || null;
    ws.role      = 'RED';
    ws.roomId    = id;
    ws.sessionId = room.redSessionId;
    rooms.set(id, room);
    lobbyClients.delete(ws);
    send(ws, { type: 'room_created', roomId: id, role: 'RED', sessionId: room.redSessionId });
    broadcastLobbyState();
    console.log(`Room ${id} created by ${ws.playerName || 'Guest'}.`);
}

function joinRoom(ws, roomId) {
    const id   = (roomId || '').toUpperCase();
    const room = rooms.get(id);
    if (!room) {
        send(ws, { type: 'room_error', payload: { reason: `Room "${id}" not found.` } });
        return;
    }
    if (room.gameState !== 'WAITING_FOR_OPPONENT' || room.blueSessionId) {
        send(ws, { type: 'room_error', payload: { reason: 'Room is full or game already started.' } });
        return;
    }
    room.blueClient    = ws;
    room.blueSessionId = crypto.randomBytes(16).toString('hex');
    room.bluePlayerName = ws.playerName || null;
    room.blueCustomerId = ws.customerId || null;
    room.blueContactNumber = ws.contactNumber || null;
    ws.role      = 'BLUE';
    ws.roomId    = id;
    ws.sessionId = room.blueSessionId;
    lobbyClients.delete(ws);
    send(ws,             { type: 'room_joined', roomId: id, role: 'BLUE', sessionId: room.blueSessionId });
    send(room.redClient, { type: 'opponent_joined', roomId: id, opponentName: ws.playerName || 'Guest' });
    broadcastLobbyState();
    sendPlacementStart(room);
    console.log(`Room ${id}: BLUE (${ws.playerName || 'Guest'}) joined.`);
}

function spectateRoom(ws, roomId) {
    const id = (roomId || '').toUpperCase();
    const room = rooms.get(id);
    if (!room) { send(ws, { type: 'room_error', payload: { reason: 'Game not found.' } }); return; }
    if (!ws.customerId) { send(ws, { type: 'room_error', payload: { reason: 'Login required to spectate.' } }); return; }
    if (room.gameState !== 'BATTLE_PHASE' && room.gameState !== 'PLACEMENT_PHASE') {
        send(ws, { type: 'room_error', payload: { reason: 'Game is not in progress.' } }); return;
    }

    lobbyClients.delete(ws);
    ws.roomId = id;
    ws.role = 'SPECTATOR';
    room.spectators.add(ws);

    send(ws, { type: 'spectate_joined', roomId: id, payload: {
        gameState: room.gameState,
        currentTurn: room.currentTurn,
        boardState: boardForSpectator(room.board),
        redName: room.redPlayerName || 'Guest',
        blueName: room.bluePlayerName || 'Guest',
        spectators: spectatorNames(room)
    }});

    broadcastSpectatorList(room);
    console.log(`Room ${id}: ${ws.playerName} spectating.`);
}

function cancelRoom(ws) {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    if (room.blueClient) send(room.blueClient, { type: 'room_cancelled' });
    rooms.delete(ws.roomId);
    ws.roomId = null; ws.role = null; ws.sessionId = null;
    lobbyClients.add(ws);
    sendLobbyState(ws);
    broadcastLobbyState();
    console.log(`Room ${room.id} cancelled.`);
}

function deleteRoom(room) {
    if (room.gameResetTimer) { clearTimeout(room.gameResetTimer); room.gameResetTimer = null; }

    [room.redClient, room.blueClient].forEach(c => {
        if (c && c.readyState === WebSocket.OPEN) {
            c.roomId = null; c.role = null; c.sessionId = null;
            lobbyClients.add(c);
        }
    });

    // Return spectators to lobby
    for (const s of room.spectators) {
        if (s.readyState === WebSocket.OPEN) {
            s.roomId = null; s.role = null;
            lobbyClients.add(s);
            sendLobbyState(s);
        }
    }

    rooms.delete(room.id);
    broadcastLobbyState();
    console.log(`Room ${room.id} removed.`);
}

// ─── Game Flow ────────────────────────────────────────────────────────────────

function sendPlacementStart(room) {
    room.gameState = 'PLACEMENT_PHASE';
    broadcastRoom(room, { type: 'placement_start', matchId: room.id, payload: {
        redName: room.redPlayerName || 'Guest',
        blueName: room.bluePlayerName || 'Guest'
    }});
    console.log(`Room ${room.id}: placement started.`);
}

function handlePlacement(ws, room, raw) {
    try {
        const json   = JSON.parse(raw);
        const pieces = json.pieces;
        const v      = validatePlacement(ws.role, pieces, room.board);
        if (!v.isValid) {
            send(ws, { type: 'placement_error', matchId: room.id, payload: { reason: v.errorMessage } });
            return;
        }
        if (ws.role === 'RED') room.redReady = true;
        else                   room.blueReady = true;
        for (const p of pieces) room.board[`${p.x}_${p.y}`] = { owner: ws.role, rank: p.rank };
        console.log(`Room ${room.id}: ${ws.role} placed pieces.`);
        if (room.redReady && room.blueReady) startBattle(room);
    } catch (err) {
        console.error('Placement error:', err.message);
        send(ws, { type: 'placement_error', matchId: room.id, payload: { reason: 'Invalid placement format' } });
    }
}

function startBattle(room) {
    room.gameState   = 'BATTLE_PHASE';
    room.currentTurn = 'RED';
    const names = { redName: room.redPlayerName || 'Guest', blueName: room.bluePlayerName || 'Guest' };
    send(room.redClient,  { type: 'battle_start', matchId: room.id,
        payload: { firstTurn: 'RED', boardState: boardForPlayer(room.board, 'RED'), ...names } });
    send(room.blueClient, { type: 'battle_start', matchId: room.id,
        payload: { firstTurn: 'RED', boardState: boardForPlayer(room.board, 'BLUE'), ...names } });
    // Spectators
    for (const s of room.spectators) {
        send(s, { type: 'battle_start', matchId: room.id,
            payload: { firstTurn: 'RED', boardState: boardForSpectator(room.board), ...names } });
    }
    console.log(`Room ${room.id}: battle started.`);
}

function handleMove(ws, room, raw) {
    if (room.gameState !== 'BATTLE_PHASE') return;
    if (ws.role !== room.currentTurn) { send(ws, { type: 'move_error', payload: { reason: 'Not your turn' } }); return; }

    const move = JSON.parse(raw).payload;
    if (move.fromX < 0 || move.fromX > 8 || move.fromY < 0 || move.fromY > 7 ||
        move.toX   < 0 || move.toX   > 8 || move.toY   < 0 || move.toY   > 7) {
        send(ws, { type: 'move_error', payload: { reason: 'Out of bounds' } }); return;
    }

    const src = room.board[`${move.fromX}_${move.fromY}`];
    if (!src || src.owner !== ws.role) { send(ws, { type: 'move_error', payload: { reason: 'Invalid source' } }); return; }
    if (Math.abs(move.fromX - move.toX) + Math.abs(move.fromY - move.toY) !== 1) {
        send(ws, { type: 'move_error', payload: { reason: 'Must move exactly 1 square' } }); return;
    }

    const tgt = room.board[`${move.toX}_${move.toY}`];
    if (tgt && tgt.owner !== ws.role && src.rank === 'Flag') {
        send(ws, { type: 'move_error', payload: { reason: 'Flag cannot attack' } }); return;
    }

    if (!tgt) {
        room.board[`${move.toX}_${move.toY}`] = src;
        delete room.board[`${move.fromX}_${move.fromY}`];
        room.currentTurn = room.currentTurn === 'RED' ? 'BLUE' : 'RED';
        const update = { ...move, battle: null, nextTurn: room.currentTurn };
        send(room.redClient, { type: 'board_update', payload: { ...update, myCaptured: room.redCaptured } });
        send(room.blueClient, { type: 'board_update', payload: { ...update, myCaptured: room.blueCaptured } });
        for (const s of room.spectators) send(s, { type: 'board_update', payload: { ...update, boardState: boardForSpectator(room.board) } });
        return;
    }
    if (tgt.owner === ws.role) { send(ws, { type: 'move_error', payload: { reason: 'Cannot capture own piece' } }); return; }

    const battle = resolveBattle(src.rank, tgt.rank);

    // Track captured pieces
    if (battle.Outcome === 0) {
        // Attacker wins — defender's piece captured
        if (tgt.owner === 'RED') room.redCaptured.push(tgt.rank);
        else room.blueCaptured.push(tgt.rank);
        room.board[`${move.toX}_${move.toY}`] = src;
        delete room.board[`${move.fromX}_${move.fromY}`];
    } else if (battle.Outcome === 1) {
        // Defender wins — attacker's piece captured
        if (src.owner === 'RED') room.redCaptured.push(src.rank);
        else room.blueCaptured.push(src.rank);
        delete room.board[`${move.fromX}_${move.fromY}`];
    } else if (battle.Outcome === 2) {
        // Both die
        if (src.owner === 'RED') { room.redCaptured.push(src.rank); room.blueCaptured.push(tgt.rank); }
        else { room.blueCaptured.push(src.rank); room.redCaptured.push(tgt.rank); }
        delete room.board[`${move.fromX}_${move.fromY}`];
        delete room.board[`${move.toX}_${move.toY}`];
    } else if (battle.Outcome === 3) {
        // Flag captured
        if (tgt.owner === 'RED') room.redCaptured.push(tgt.rank);
        else room.blueCaptured.push(tgt.rank);
        room.board[`${move.toX}_${move.toY}`] = src;
        delete room.board[`${move.fromX}_${move.fromY}`];

        // Send battle info with attacker/defender ranks for both players
        const updatePayload = { ...move, battle: { ...battle, attackerRank: src.rank, defenderRank: tgt.rank }, nextTurn: room.currentTurn };
        // Players get their own captured list
        send(room.redClient, { type: 'board_update', payload: { ...updatePayload, myCaptured: room.redCaptured } });
        send(room.blueClient, { type: 'board_update', payload: { ...updatePayload, myCaptured: room.blueCaptured } });
        for (const s of room.spectators) send(s, { type: 'board_update', payload: { ...updatePayload, boardState: boardForSpectator(room.board) } });

        broadcastGameOver(room, ws.role);
        return;
    }

    room.currentTurn = room.currentTurn === 'RED' ? 'BLUE' : 'RED';

    // Send with battle ranks and captured pieces
    const updatePayload = { ...move, battle: { ...battle, attackerRank: src.rank, defenderRank: tgt.rank }, nextTurn: room.currentTurn };
    send(room.redClient, { type: 'board_update', payload: { ...updatePayload, myCaptured: room.redCaptured } });
    send(room.blueClient, { type: 'board_update', payload: { ...updatePayload, myCaptured: room.blueCaptured } });
    for (const s of room.spectators) send(s, { type: 'board_update', payload: { ...updatePayload, boardState: boardForSpectator(room.board) } });
}

// ─── Surrender ───────────────────────────────────────────────────────────────

function handleSurrender(ws, room) {
    if (room.gameState !== 'BATTLE_PHASE') return;
    const winner = ws.role === 'RED' ? 'BLUE' : 'RED';
    broadcastAll(room, { type: 'player_surrendered', payload: { role: ws.role } });
    broadcastGameOver(room, winner);
    console.log(`Room ${room.id}: ${ws.role} surrendered.`);
}

// ─── Rematch ─────────────────────────────────────────────────────────────────

function handleRematchVote(ws, room) {
    if (room.gameState !== 'GAME_OVER') return;
    room.rematchVotes[ws.role] = true;
    broadcastRoom(room, { type: 'rematch_vote', payload: { role: ws.role, votes: room.rematchVotes } });

    if (room.rematchVotes.RED && room.rematchVotes.BLUE) {
        // Reset for new game
        room.board = {};
        room.redReady = false;
        room.blueReady = false;
        room.redCaptured = [];
        room.blueCaptured = [];
        room.rematchVotes = { RED: false, BLUE: false };
        room.currentTurn = 'RED';

        // Swap colors
        const tmpClient = room.redClient;
        const tmpSession = room.redSessionId;
        const tmpName = room.redPlayerName;
        const tmpId = room.redCustomerId;
        const tmpContact = room.redContactNumber;

        room.redClient = room.blueClient;
        room.redSessionId = room.blueSessionId;
        room.redPlayerName = room.bluePlayerName;
        room.redCustomerId = room.blueCustomerId;
        room.redContactNumber = room.blueContactNumber;

        room.blueClient = tmpClient;
        room.blueSessionId = tmpSession;
        room.bluePlayerName = tmpName;
        room.blueCustomerId = tmpId;
        room.blueContactNumber = tmpContact;

        if (room.redClient) { room.redClient.role = 'RED'; room.redClient.sessionId = room.redSessionId; }
        if (room.blueClient) { room.blueClient.role = 'BLUE'; room.blueClient.sessionId = room.blueSessionId; }

        broadcastRoom(room, { type: 'rematch_start', payload: {
            redName: room.redPlayerName || 'Guest',
            blueName: room.bluePlayerName || 'Guest'
        }});
        sendPlacementStart(room);
        console.log(`Room ${room.id}: rematch — colors swapped.`);
    }
}

// ─── Rankings Update ─────────────────────────────────────────────────────────

async function updateRankings(room, winnerRole) {
    const winnerId   = winnerRole === 'RED' ? room.redCustomerId : room.blueCustomerId;
    const loserId    = winnerRole === 'RED' ? room.blueCustomerId : room.redCustomerId;
    const winnerName = winnerRole === 'RED' ? room.redPlayerName : room.bluePlayerName;
    const loserName  = winnerRole === 'RED' ? room.bluePlayerName : room.redPlayerName;
    const winnerContact = winnerRole === 'RED' ? room.redContactNumber : room.blueContactNumber;
    const loserContact  = winnerRole === 'RED' ? room.blueContactNumber : room.redContactNumber;

    try {
        if (winnerId) {
            await pgPool.query(`
                INSERT INTO salpakan_rankings (customer_id, customer_name, contact_number, wins, games_played, last_played)
                VALUES ($1, $2, $3, 1, 1, NOW())
                ON CONFLICT (customer_id) DO UPDATE SET
                    wins = salpakan_rankings.wins + 1,
                    games_played = salpakan_rankings.games_played + 1,
                    customer_name = $2, last_played = NOW()
            `, [winnerId, winnerName, winnerContact]);
        }
        if (loserId) {
            await pgPool.query(`
                INSERT INTO salpakan_rankings (customer_id, customer_name, contact_number, losses, games_played, last_played)
                VALUES ($1, $2, $3, 1, 1, NOW())
                ON CONFLICT (customer_id) DO UPDATE SET
                    losses = salpakan_rankings.losses + 1,
                    games_played = salpakan_rankings.games_played + 1,
                    customer_name = $2, last_played = NOW()
            `, [loserId, loserName, loserContact]);
        }

        // Save game history
        await pgPool.query(`
            INSERT INTO salpakan_game_history (winner_id, winner_name, loser_id, loser_name, played_at)
            VALUES ($1, $2, $3, $4, NOW())
        `, [winnerId, winnerName || 'Guest', loserId, loserName || 'Guest']);

        console.log(`Rankings updated: winner=${winnerName || 'Guest'}, loser=${loserName || 'Guest'}`);
    } catch (err) {
        console.error('Rankings update error:', err.message);
    }
}

function broadcastGameOver(room, winner) {
    if (room.gameResetTimer) { clearTimeout(room.gameResetTimer); room.gameResetTimer = null; }
    const payload = { winner,
        redName: room.redPlayerName || 'Guest',
        blueName: room.bluePlayerName || 'Guest'
    };
    // Players get their captured pieces
    send(room.redClient, { type: 'game_over', payload: { ...payload, myCaptured: room.redCaptured } });
    send(room.blueClient, { type: 'game_over', payload: { ...payload, myCaptured: room.blueCaptured } });
    for (const s of room.spectators) send(s, { type: 'game_over', payload });

    room.gameState = 'GAME_OVER';
    console.log(`Room ${room.id}: GAME OVER — ${winner} wins.`);
    updateRankings(room, winner);
    // Don't auto-delete — wait for rematch or timeout
    room.gameResetTimer = setTimeout(() => deleteRoom(room), 30000);
}

// ─── Reconnect ────────────────────────────────────────────────────────────────

function handleReconnect(ws, sessionId, roomId) {
    const room = roomId ? rooms.get(roomId) : null;
    if (room) {
        let role = null;
        if      (sessionId === room.redSessionId)  role = 'RED';
        else if (sessionId === room.blueSessionId) role = 'BLUE';

        if (role) {
            const oldClient = role === 'RED' ? room.redClient : room.blueClient;
            if (oldClient && oldClient !== ws) { try { oldClient.terminate(); } catch (_) {} }

            if (role === 'RED') room.redClient = ws;
            else                room.blueClient = ws;

            ws.role = role; ws.roomId = room.id; ws.sessionId = sessionId;
            lobbyClients.delete(ws);
            if (room.gameResetTimer && room.gameState !== 'GAME_OVER') {
                clearTimeout(room.gameResetTimer); room.gameResetTimer = null;
            }

            const other = role === 'RED' ? room.blueClient : room.redClient;
            send(other, { type: 'opponent_reconnected', payload: { role } });
            send(ws, { type: 'reconnect_success', matchId: room.id,
                payload: { role, sessionId, roomId: room.id,
                    gameState: room.gameState, currentTurn: room.currentTurn,
                    boardState: boardForPlayer(room.board, role),
                    redName: room.redPlayerName || 'Guest',
                    blueName: room.bluePlayerName || 'Guest',
                    myCaptured: role === 'RED' ? room.redCaptured : room.blueCaptured,
                    spectators: spectatorNames(room)
                }});
            broadcastSpectatorList(room);
            console.log(`Room ${room.id}: ${role} reconnected.`);
            return;
        }
    }
    send(ws, { type: 'reconnect_failed' });
    lobbyClients.add(ws);
    sendLobbyState(ws);
}

// ─── Disconnect Handler ───────────────────────────────────────────────────────

function handleDisconnect(ws) {
    lobbyClients.delete(ws);

    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;

    // Spectator disconnect
    if (ws.role === 'SPECTATOR') {
        room.spectators.delete(ws);
        broadcastSpectatorList(room);
        return;
    }

    const role = ws.role;
    if (ws === room.redClient) room.redClient = null;
    else if (ws === room.blueClient) room.blueClient = null;
    else return;

    console.log(`Room ${room.id}: ${role} disconnected.`);

    if (room.gameState === 'WAITING_FOR_OPPONENT') { deleteRoom(room); return; }

    const remaining = room.redClient || room.blueClient;
    if (remaining) {
        send(remaining, { type: 'opponent_disconnected', payload: { role } });
        if (room.gameResetTimer) clearTimeout(room.gameResetTimer);
        room.gameResetTimer = setTimeout(() => {
            send(room.redClient || room.blueClient, { type: 'opponent_gave_up' });
            // Award win to remaining player
            const winnerRole = room.redClient ? 'RED' : 'BLUE';
            if (room.gameState === 'BATTLE_PHASE') {
                broadcastGameOver(room, winnerRole);
            } else {
                deleteRoom(room);
            }
        }, RECONNECT_WINDOW_MS);
    } else {
        deleteRoom(room);
    }
}

// ─── Message Router ───────────────────────────────────────────────────────────

function handleMessage(ws, raw) {
    try {
        const json = JSON.parse(raw);
        console.log(`[${ws.role || 'lobby'}@${ws.roomId || '-'}] ${json.type}`);

        if (json.type === 'identify') {
            ws.customerId    = json.customerId || null;
            ws.playerName    = json.playerName || null;
            ws.contactNumber = json.contactNumber || null;
            return;
        }

        // Pre-room messages
        if (!ws.roomId) {
            switch (json.type) {
                case 'get_rooms':     sendLobbyState(ws); return;
                case 'get_games':     send(ws, { type: 'active_games', payload: { games: activeGames() } }); return;
                case 'create_room':   createRoom(ws); return;
                case 'join_room':     joinRoom(ws, json.roomId); return;
                case 'spectate_room': spectateRoom(ws, json.roomId); return;
            }
            return;
        }

        const room = rooms.get(ws.roomId);
        if (!room) return;

        // Spectator can only chat
        if (ws.role === 'SPECTATOR') {
            if (json.type === 'leave_spectate') {
                room.spectators.delete(ws);
                ws.roomId = null; ws.role = null;
                lobbyClients.add(ws);
                sendLobbyState(ws);
                broadcastSpectatorList(room);
            }
            return;
        }

        switch (json.type) {
            case 'cancel_room':      cancelRoom(ws); break;
            case 'submit_placement': handlePlacement(ws, room, raw); break;
            case 'move_request':     handleMove(ws, room, raw); break;
            case 'surrender':        handleSurrender(ws, room); break;
            case 'rematch_vote':     handleRematchVote(ws, room); break;
            case 'chat':
                broadcastAll(room, { type: 'chat',
                    payload: { role: ws.role, message: json.payload.message, isEmoji: !!json.payload.isEmoji,
                               playerName: ws.playerName || 'Guest' } });
                break;
        }
    } catch (err) {
        console.error('Message error:', err.message);
    }
}

// ─── HTTP REST API ───────────────────────────────────────────────────────────

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
}

async function handleApi(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

    if (req.method === 'POST' && url.pathname === '/api/login') {
        try {
            const { contactNumber } = await parseBody(req);
            if (!contactNumber) { res.writeHead(400); res.end(JSON.stringify({ error: 'contactNumber required' })); return true; }
            const apiRes = await fetch(`${HOTEL_API_URL}/api/customers/lookup?contact=${encodeURIComponent(contactNumber)}`);
            if (!apiRes.ok) { res.writeHead(404); res.end(JSON.stringify({ error: 'Contact number not found in hotel system' })); return true; }
            const customer = await apiRes.json();
            res.writeHead(200); res.end(JSON.stringify({ id: customer.id, name: customer.name, contactNumber: customer.contact_number }));
        } catch (err) {
            console.error('Login error:', err.message);
            res.writeHead(500); res.end(JSON.stringify({ error: 'Server error' }));
        }
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/rankings') {
        try {
            const result = await pgPool.query(
                'SELECT customer_id, customer_name, wins, losses, games_played, last_played FROM salpakan_rankings ORDER BY wins DESC, games_played ASC LIMIT 50'
            );
            res.writeHead(200); res.end(JSON.stringify(result.rows));
        } catch (err) {
            console.error('Rankings error:', err.message);
            res.writeHead(500); res.end(JSON.stringify({ error: 'Server error' }));
        }
        return true;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/rankings/')) {
        const customerId = parseInt(url.pathname.split('/').pop());
        if (isNaN(customerId)) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid customer ID' })); return true; }
        try {
            const result = await pgPool.query(
                'SELECT customer_id, customer_name, wins, losses, games_played, last_played FROM salpakan_rankings WHERE customer_id = $1',
                [customerId]
            );
            if (result.rows.length === 0) {
                res.writeHead(200); res.end(JSON.stringify({ customer_id: customerId, wins: 0, losses: 0, games_played: 0 }));
            } else {
                res.writeHead(200); res.end(JSON.stringify(result.rows[0]));
            }
        } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: 'Server error' }));
        }
        return true;
    }

    // GET /api/history/:customerId — last 10 games
    if (req.method === 'GET' && url.pathname.startsWith('/api/history/')) {
        const customerId = parseInt(url.pathname.split('/').pop());
        if (isNaN(customerId)) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid customer ID' })); return true; }
        try {
            const result = await pgPool.query(
                `SELECT winner_id, winner_name, loser_id, loser_name, played_at
                 FROM salpakan_game_history
                 WHERE winner_id = $1 OR loser_id = $1
                 ORDER BY played_at DESC LIMIT 10`,
                [customerId]
            );
            res.writeHead(200); res.end(JSON.stringify(result.rows));
        } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: 'Server error' }));
        }
        return true;
    }

    return false;
}

// ─── HTTP + WebSocket Server ──────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    try {
        const handled = await handleApi(req, res);
        if (handled) return;
    } catch (_) {}

    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'Salpakan_Enhanced.html'), (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } else {
        res.writeHead(404); res.end('Not found');
    }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ws.roomId = null; ws.role = null; ws.sessionId = null;
    ws.customerId = null; ws.playerName = null; ws.contactNumber = null;
    lobbyClients.add(ws);
    sendLobbyState(ws);

    ws.on('message', (data) => {
        const raw  = data.toString();
        const json = JSON.parse(raw);
        if (json.type === 'reconnect') { handleReconnect(ws, json.sessionId, json.roomId); return; }
        handleMessage(ws, raw);
    });

    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', (err) => console.error('WS error:', err.message));
});

server.listen(PORT, () => {
    console.log(`Salpakan server on port ${PORT}`);
    console.log(`Local: http://localhost:${PORT}`);
});
