const http      = require('http');
const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');

const PORT               = process.env.PORT || 8080;
const RECONNECT_WINDOW_MS = 60000; // 60 s to reconnect after drop

// ─── Collections ──────────────────────────────────────────────────────────────

const rooms        = new Map();  // roomId → room object
const lobbyClients = new Set();  // ws clients in the lobby (no room yet)

// ─── Room Factory ─────────────────────────────────────────────────────────────

function makeRoom(id) {
    return {
        id,
        redClient:    null, blueClient:    null,
        redSessionId: null, blueSessionId: null,
        gameState:  'WAITING_FOR_OPPONENT',
        redReady: false, blueReady: false,
        board:        {},
        currentTurn: 'RED',
        gameResetTimer: null,
        createdAt: Date.now()
    };
}

function generateRoomId() {
    let id;
    do {
        id = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 hex chars
    } while (rooms.has(id));
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
        .map(r => ({ id: r.id }));
}

// ─── Rank & Battle ────────────────────────────────────────────────────────────

function getRankValue(rank) {
    return { Private:1, Sergeant:2, '2ndLt':3, '1stLt':4, Captain:5,
             Major:6, LtCol:7, Colonel:8, '1Star':9, '2Star':10,
             '3Star':11, '4Star':12, '5Star':13 }[rank] || 0;
}

// Outcome: 0=AttackerWins, 1=DefenderWins, 2=BothDie, 3=FlagCaptured
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
        const got = counts[rank] || 0;
        if (got !== exp)
            return { isValid: false, errorMessage: `${rank}: need ${exp}, got ${got}` };
    }
    return { isValid: true };
}

function boardForPlayer(board, role) {
    return Object.entries(board).map(([key, cell]) => {
        const [x, y] = key.split('_').map(Number);
        return { x, y, owner: cell.owner,
                 rank:     cell.owner === role ? cell.rank : 'Unknown',
                 revealed: cell.owner === role };
    });
}

// ─── Room Actions ─────────────────────────────────────────────────────────────

function createRoom(ws) {
    const id   = generateRoomId();
    const room = makeRoom(id);
    room.redClient    = ws;
    room.redSessionId = crypto.randomBytes(16).toString('hex');
    ws.role      = 'RED';
    ws.roomId    = id;
    ws.sessionId = room.redSessionId;
    rooms.set(id, room);
    lobbyClients.delete(ws);
    send(ws, { type: 'room_created', roomId: id, role: 'RED', sessionId: room.redSessionId });
    broadcastLobbyState();
    console.log(`Room ${id} created.`);
}

function joinRoom(ws, roomId) {
    const id   = (roomId || '').toUpperCase();
    const room = rooms.get(id);
    if (!room) {
        send(ws, { type: 'room_error', payload: { reason: `Room "${id}" not found. Check the code and try again.` } });
        return;
    }
    if (room.gameState !== 'WAITING_FOR_OPPONENT' || room.blueSessionId) {
        send(ws, { type: 'room_error', payload: { reason: 'Room is full or the game already started.' } });
        return;
    }
    room.blueClient    = ws;
    room.blueSessionId = crypto.randomBytes(16).toString('hex');
    ws.role      = 'BLUE';
    ws.roomId    = id;
    ws.sessionId = room.blueSessionId;
    lobbyClients.delete(ws);
    send(ws,               { type: 'room_joined',     roomId: id, role: 'BLUE', sessionId: room.blueSessionId });
    send(room.redClient,   { type: 'opponent_joined', roomId: id });
    broadcastLobbyState();
    sendPlacementStart(room);
    console.log(`Room ${id}: BLUE joined.`);
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
    rooms.delete(room.id);
    broadcastLobbyState();
    console.log(`Room ${room.id} removed.`);
}

// ─── Game Flow ────────────────────────────────────────────────────────────────

function sendPlacementStart(room) {
    room.gameState = 'PLACEMENT_PHASE';
    const msg = { type: 'placement_start', matchId: room.id, payload: {} };
    broadcastRoom(room, msg);
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
    send(room.redClient,  { type: 'battle_start', matchId: room.id,
        payload: { firstTurn: 'RED', boardState: boardForPlayer(room.board, 'RED') } });
    send(room.blueClient, { type: 'battle_start', matchId: room.id,
        payload: { firstTurn: 'RED', boardState: boardForPlayer(room.board, 'BLUE') } });
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
    if (!tgt) {
        room.board[`${move.toX}_${move.toY}`] = src;
        delete room.board[`${move.fromX}_${move.fromY}`];
        room.currentTurn = room.currentTurn === 'RED' ? 'BLUE' : 'RED';
        broadcastRoom(room, { type: 'board_update', payload: { ...move, battle: null, nextTurn: room.currentTurn } });
        return;
    }
    if (tgt.owner === ws.role) { send(ws, { type: 'move_error', payload: { reason: 'Cannot capture own piece' } }); return; }

    const battle = resolveBattle(src.rank, tgt.rank);
    if      (battle.Outcome === 0) { room.board[`${move.toX}_${move.toY}`] = src; delete room.board[`${move.fromX}_${move.fromY}`]; }
    else if (battle.Outcome === 1) { delete room.board[`${move.fromX}_${move.fromY}`]; }
    else if (battle.Outcome === 2) { delete room.board[`${move.fromX}_${move.fromY}`]; delete room.board[`${move.toX}_${move.toY}`]; }
    else if (battle.Outcome === 3) {
        room.board[`${move.toX}_${move.toY}`] = src;
        delete room.board[`${move.fromX}_${move.fromY}`];
        broadcastRoom(room, { type: 'board_update', payload: { ...move, battle, nextTurn: room.currentTurn } });
        broadcastGameOver(room, ws.role);
        return;
    }

    room.currentTurn = room.currentTurn === 'RED' ? 'BLUE' : 'RED';
    broadcastRoom(room, { type: 'board_update', payload: { ...move, battle, nextTurn: room.currentTurn } });
}

function broadcastGameOver(room, winner) {
    broadcastRoom(room, { type: 'game_over', payload: { winner } });
    room.gameState = 'GAME_OVER';
    console.log(`Room ${room.id}: GAME OVER — ${winner} wins.`);
    setTimeout(() => deleteRoom(room), 10000);
}

// ─── Reconnect ────────────────────────────────────────────────────────────────

function handleReconnect(ws, sessionId, roomId) {
    const room = roomId ? rooms.get(roomId) : null;
    if (room) {
        if (sessionId === room.redSessionId && !room.redClient) {
            room.redClient = ws;
            ws.role = 'RED'; ws.roomId = room.id; ws.sessionId = sessionId;
            lobbyClients.delete(ws);
            if (room.gameResetTimer) { clearTimeout(room.gameResetTimer); room.gameResetTimer = null; }
            send(room.blueClient, { type: 'opponent_reconnected', payload: { role: 'RED' } });
            send(ws, { type: 'reconnect_success', matchId: room.id,
                payload: { role: 'RED', sessionId, roomId: room.id,
                           gameState: room.gameState, currentTurn: room.currentTurn,
                           boardState: boardForPlayer(room.board, 'RED') } });
            console.log(`Room ${room.id}: RED reconnected.`);
            return;
        }
        if (sessionId === room.blueSessionId && !room.blueClient) {
            room.blueClient = ws;
            ws.role = 'BLUE'; ws.roomId = room.id; ws.sessionId = sessionId;
            lobbyClients.delete(ws);
            if (room.gameResetTimer) { clearTimeout(room.gameResetTimer); room.gameResetTimer = null; }
            send(room.redClient, { type: 'opponent_reconnected', payload: { role: 'BLUE' } });
            send(ws, { type: 'reconnect_success', matchId: room.id,
                payload: { role: 'BLUE', sessionId, roomId: room.id,
                           gameState: room.gameState, currentTurn: room.currentTurn,
                           boardState: boardForPlayer(room.board, 'BLUE') } });
            console.log(`Room ${room.id}: BLUE reconnected.`);
            return;
        }
    }
    // No match — send to lobby
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

    const role = ws.role;
    if (ws === room.redClient)  room.redClient  = null;
    else if (ws === room.blueClient) room.blueClient = null;
    else return;

    console.log(`Room ${room.id}: ${role} disconnected.`);

    // Host left waiting room before anyone joined — just delete
    if (room.gameState === 'WAITING_FOR_OPPONENT') {
        deleteRoom(room);
        return;
    }

    const remaining = room.redClient || room.blueClient;
    if (remaining) {
        send(remaining, { type: 'opponent_disconnected', payload: { role } });
        if (room.gameResetTimer) clearTimeout(room.gameResetTimer);
        room.gameResetTimer = setTimeout(() => {
            send(room.redClient || room.blueClient, { type: 'opponent_gave_up' });
            deleteRoom(room);
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

        // Pre-room messages
        if (!ws.roomId) {
            switch (json.type) {
                case 'get_rooms':   sendLobbyState(ws); return;
                case 'create_room': createRoom(ws);     return;
                case 'join_room':   joinRoom(ws, json.roomId); return;
            }
            return;
        }

        // Room messages
        const room = rooms.get(ws.roomId);
        if (!room) return;

        switch (json.type) {
            case 'cancel_room':      cancelRoom(ws); break;
            case 'submit_placement': handlePlacement(ws, room, raw); break;
            case 'move_request':     handleMove(ws, room, raw); break;
            case 'chat':
                broadcastRoom(room, { type: 'chat',
                    payload: { role: ws.role, message: json.payload.message, isEmoji: !!json.payload.isEmoji } });
                break;
        }
    } catch (err) {
        console.error('Message error:', err.message);
    }
}

// ─── HTTP + WebSocket Server ──────────────────────────────────────────────────

const server = http.createServer((req, res) => {
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
    lobbyClients.add(ws);
    sendLobbyState(ws); // immediately send current open rooms

    ws.on('message', (data) => {
        const raw  = data.toString();
        const json = JSON.parse(raw);

        // Reconnect is handled before anything else
        if (json.type === 'reconnect') {
            handleReconnect(ws, json.sessionId, json.roomId);
            return;
        }
        handleMessage(ws, raw);
    });

    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', (err) => console.error('WS error:', err.message));
});

server.listen(PORT, () => {
    console.log(`Salpakan server on port ${PORT}`);
    console.log(`Local: http://localhost:${PORT}`);
});
