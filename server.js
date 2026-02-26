const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// ─── Game State ───────────────────────────────────────────────────────────────

let redClient = null;
let blueClient = null;
let gameState = 'WAITING_FOR_PLAYERS';
let redReady = false;
let blueReady = false;
let redPieces = null;
let bluePieces = null;
let board = {};   // key: "x_y", value: { owner, rank }
let currentTurn = 'RED';

// Reconnection tracking
let redSessionId = null;
let blueSessionId = null;
let gameResetTimer = null;
const RECONNECT_WINDOW_MS = 60000; // 60 seconds to reconnect

function clearBoard() {
    board = {};
}

function resetGame() {
    redClient = null;
    blueClient = null;
    gameState = 'WAITING_FOR_PLAYERS';
    redReady = false;
    blueReady = false;
    redPieces = null;
    bluePieces = null;
    currentTurn = 'RED';
    redSessionId = null;
    blueSessionId = null;
    if (gameResetTimer) { clearTimeout(gameResetTimer); gameResetTimer = null; }
    clearBoard();
    console.log('Game reset — waiting for new players.');
}

// ─── Rank Values ──────────────────────────────────────────────────────────────

function getRankValue(rank) {
    const ranks = {
        'Private':  1,
        'Sergeant': 2,
        '2ndLt':    3,
        '1stLt':    4,
        'Captain':  5,
        'Major':    6,
        'LtCol':    7,
        'Colonel':  8,
        '1Star':    9,
        '2Star':   10,
        '3Star':   11,
        '4Star':   12,
        '5Star':   13
    };
    return ranks[rank] || 0;
}

// ─── Battle Resolution ────────────────────────────────────────────────────────
// Ported 1-to-1 from VB.NET ResolveBattle().
// Outcome numbers match the VB.NET BattleOutcome enum the client expects:
//   0 = AttackerWins, 1 = DefenderWins, 2 = BothDie, 3 = FlagCaptured
//
// Spy rules (traditional Salpakan):
//   Spy beats ALL officer ranks, regardless of who attacks whom
//   Private beats Spy, regardless of who attacks whom
//   Spy vs Spy → both die
function resolveBattle(attackerRank, defenderRank) {
    // Flag is always captured by whoever reaches it
    if (defenderRank === 'Flag') {
        return { Outcome: 3, WinnerRank: attackerRank };
    }

    // Spy is involved — handle all Spy cases before rank comparison
    if (attackerRank === 'Spy' || defenderRank === 'Spy') {
        // Spy vs Spy → both die
        if (attackerRank === 'Spy' && defenderRank === 'Spy') {
            return { Outcome: 2, WinnerRank: null };
        }

        // Private always beats Spy, regardless of direction
        if (attackerRank === 'Private') {
            return { Outcome: 0, WinnerRank: 'Private' }; // attacker (Private) wins
        }
        if (defenderRank === 'Private') {
            return { Outcome: 1, WinnerRank: 'Private' }; // defender (Private) wins
        }

        // Spy beats any other rank (all officers), regardless of direction
        if (attackerRank === 'Spy') {
            return { Outcome: 0, WinnerRank: 'Spy' }; // attacker (Spy) wins
        } else {
            return { Outcome: 1, WinnerRank: 'Spy' }; // defender (Spy) wins
        }
    }

    // Same rank → both eliminated
    if (attackerRank === defenderRank) {
        return { Outcome: 2, WinnerRank: null };
    }

    // General rank comparison
    const attackerValue = getRankValue(attackerRank);
    const defenderValue = getRankValue(defenderRank);

    if (attackerValue > defenderValue) {
        return { Outcome: 0, WinnerRank: attackerRank };
    } else {
        return { Outcome: 1, WinnerRank: defenderRank };
    }
}

// ─── Placement Validation ─────────────────────────────────────────────────────

function validatePlacement(role, pieces) {
    if (pieces.length !== 21) {
        return { isValid: false, errorMessage: `Must place exactly 21 pieces. You placed ${pieces.length}.` };
    }

    // No duplicate positions
    const positions = new Set();
    for (const piece of pieces) {
        const key = `${piece.x}_${piece.y}`;
        if (positions.has(key)) {
            return { isValid: false, errorMessage: `Duplicate position at (${piece.x}, ${piece.y})` };
        }
        positions.add(key);
    }

    // Valid coordinates
    for (const piece of pieces) {
        if (piece.x < 0 || piece.x > 8 || piece.y < 0 || piece.y > 7) {
            return { isValid: false, errorMessage: `Invalid coordinates: (${piece.x}, ${piece.y})` };
        }
    }

    // Valid starting rows
    const validRows = role === 'RED' ? [5, 6, 7] : role === 'BLUE' ? [0, 1, 2] : null;
    if (!validRows) return { isValid: false, errorMessage: 'Invalid role' };

    for (const piece of pieces) {
        if (!validRows.includes(piece.y)) {
            return { isValid: false, errorMessage: `Piece at (${piece.x}, ${piece.y}) is outside your starting zone` };
        }
    }

    // No overlap with existing board pieces
    for (const piece of pieces) {
        if (board[`${piece.x}_${piece.y}`]) {
            return { isValid: false, errorMessage: `Square (${piece.x}, ${piece.y}) is already occupied` };
        }
    }

    // Correct rank distribution
    const rankCounts = {};
    for (const piece of pieces) {
        rankCounts[piece.rank] = (rankCounts[piece.rank] || 0) + 1;
    }

    const expectedRanks = {
        'Flag': 1, 'Spy': 2, 'Private': 6, 'Sergeant': 1,
        '2ndLt': 1, '1stLt': 1, 'Captain': 1, 'Major': 1,
        'LtCol': 1, 'Colonel': 1, '1Star': 1, '2Star': 1,
        '3Star': 1, '4Star': 1, '5Star': 1
    };

    for (const [rank, expected] of Object.entries(expectedRanks)) {
        const actual = rankCounts[rank] || 0;
        if (actual !== expected) {
            return { isValid: false, errorMessage: `Invalid ${rank} count: expected ${expected}, got ${actual}` };
        }
    }

    return { isValid: true };
}

// ─── Board State ──────────────────────────────────────────────────────────────

function getBoardStateForPlayer(playerRole) {
    return Object.entries(board).map(([key, cell]) => {
        const [x, y] = key.split('_').map(Number);
        return {
            x,
            y,
            owner: cell.owner,
            rank: cell.owner === playerRole ? cell.rank : 'Unknown',
            revealed: cell.owner === playerRole
        };
    });
}

// ─── Messaging ────────────────────────────────────────────────────────────────

function sendMessage(client, data) {
    if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
    }
}

function sendRole(client, role, sessionId) {
    sendMessage(client, {
        type: 'role_assignment',
        matchId: 'MATCH_001',
        payload: { role, sessionId }
    });
}

function sendError(client, reason) {
    sendMessage(client, { type: 'move_error', payload: { reason } });
}

function broadcastMove(move, battle) {
    const msg = {
        type: 'board_update',
        payload: {
            fromX: move.fromX,
            fromY: move.fromY,
            toX:   move.toX,
            toY:   move.toY,
            battle,
            nextTurn: currentTurn
        }
    };
    sendMessage(redClient, msg);
    sendMessage(blueClient, msg);
}

function broadcastGameOver(winner) {
    const msg = { type: 'game_over', payload: { winner } };
    sendMessage(redClient, msg);
    sendMessage(blueClient, msg);
    console.log(`GAME OVER — ${winner} wins!`);
}

// ─── Game Flow ────────────────────────────────────────────────────────────────

function registerClient(ws) {
    // Slot is free only if there's no active client AND no disconnected session waiting
    const redFree = !redClient && !redSessionId;
    const blueFree = !blueClient && !blueSessionId;

    if (redFree) {
        redClient = ws;
        ws.role = 'RED';
        redSessionId = crypto.randomBytes(16).toString('hex');
        ws.sessionId = redSessionId;
        sendRole(ws, 'RED', redSessionId);
        console.log('RED connected.');
    } else if (blueFree) {
        blueClient = ws;
        ws.role = 'BLUE';
        blueSessionId = crypto.randomBytes(16).toString('hex');
        ws.sessionId = blueSessionId;
        sendRole(ws, 'BLUE', blueSessionId);
        console.log('BLUE connected.');
        sendPlacementStart();
    } else {
        sendMessage(ws, {
            type: 'role_assignment',
            matchId: 'MATCH_001',
            payload: { role: 'REJECTED' }
        });
        ws.close();
        console.log('Connection rejected — game in progress.');
    }
}

function handleReconnect(ws, sessionId) {
    if (sessionId === redSessionId && !redClient) {
        redClient = ws;
        ws.role = 'RED';
        ws.sessionId = sessionId;
        if (gameResetTimer) { clearTimeout(gameResetTimer); gameResetTimer = null; }
        sendMessage(blueClient, { type: 'opponent_reconnected', payload: { role: 'RED' } });
        sendMessage(ws, {
            type: 'reconnect_success',
            matchId: 'MATCH_001',
            payload: { role: 'RED', sessionId, gameState, currentTurn, boardState: getBoardStateForPlayer('RED') }
        });
        console.log('RED reconnected.');
        return;
    }

    if (sessionId === blueSessionId && !blueClient) {
        blueClient = ws;
        ws.role = 'BLUE';
        ws.sessionId = sessionId;
        if (gameResetTimer) { clearTimeout(gameResetTimer); gameResetTimer = null; }
        sendMessage(redClient, { type: 'opponent_reconnected', payload: { role: 'BLUE' } });
        sendMessage(ws, {
            type: 'reconnect_success',
            matchId: 'MATCH_001',
            payload: { role: 'BLUE', sessionId, gameState, currentTurn, boardState: getBoardStateForPlayer('BLUE') }
        });
        console.log('BLUE reconnected.');
        return;
    }

    // Invalid session — treat as a new player
    registerClient(ws);
}

function sendPlacementStart() {
    gameState = 'PLACEMENT_PHASE';
    const msg = { type: 'placement_start', matchId: 'MATCH_001', payload: {} };
    sendMessage(redClient, msg);
    sendMessage(blueClient, msg);
    console.log('Placement phase started.');
}

function handlePlacement(client, data) {
    try {
        const json = JSON.parse(data);
        const pieces = json.pieces;

        const validation = validatePlacement(client.role, pieces);
        if (!validation.isValid) {
            sendMessage(client, {
                type: 'placement_error',
                matchId: 'MATCH_001',
                payload: { reason: validation.errorMessage }
            });
            console.log(`${client.role} placement REJECTED: ${validation.errorMessage}`);
            return;
        }

        if (client.role === 'RED') {
            redPieces = pieces;
            redReady = true;
        } else {
            bluePieces = pieces;
            blueReady = true;
        }

        for (const piece of pieces) {
            board[`${piece.x}_${piece.y}`] = { owner: client.role, rank: piece.rank };
        }

        console.log(`${client.role} placed ${pieces.length} pieces.`);

        if (redReady && blueReady) {
            startBattle();
        }
    } catch (err) {
        console.error('Error processing placement:', err.message);
        sendMessage(client, {
            type: 'placement_error',
            matchId: 'MATCH_001',
            payload: { reason: 'Invalid placement format' }
        });
    }
}

function startBattle() {
    gameState = 'BATTLE_PHASE';
    currentTurn = 'RED';

    sendMessage(redClient, {
        type: 'battle_start',
        matchId: 'MATCH_001',
        payload: { firstTurn: currentTurn, boardState: getBoardStateForPlayer('RED') }
    });

    sendMessage(blueClient, {
        type: 'battle_start',
        matchId: 'MATCH_001',
        payload: { firstTurn: currentTurn, boardState: getBoardStateForPlayer('BLUE') }
    });

    console.log(`BATTLE PHASE STARTED! First turn: ${currentTurn}`);
}

function isInsideBoard(x, y) {
    return x >= 0 && x <= 8 && y >= 0 && y <= 7;
}

function endTurn() {
    currentTurn = currentTurn === 'RED' ? 'BLUE' : 'RED';
}

function handleMove(client, data) {
    if (gameState !== 'BATTLE_PHASE') return;
    if (client.role !== currentTurn) {
        sendError(client, 'Not your turn');
        return;
    }

    const json = JSON.parse(data);
    const move = json.payload;

    if (!isInsideBoard(move.fromX, move.fromY) || !isInsideBoard(move.toX, move.toY)) {
        sendError(client, 'Move out of bounds');
        return;
    }

    const source = board[`${move.fromX}_${move.fromY}`];
    if (!source || source.owner !== client.role) {
        sendError(client, 'Invalid source piece');
        return;
    }

    const dx = Math.abs(move.fromX - move.toX);
    const dy = Math.abs(move.fromY - move.toY);
    if (dx + dy !== 1) {
        sendError(client, 'Invalid move distance');
        return;
    }

    const target = board[`${move.toX}_${move.toY}`];

    // Empty square — just move
    if (!target) {
        board[`${move.toX}_${move.toY}`] = source;
        delete board[`${move.fromX}_${move.fromY}`];
        endTurn();
        broadcastMove(move, null);
        return;
    }

    // Friendly piece — block
    if (target.owner === client.role) {
        sendError(client, 'Cannot move onto your own piece');
        return;
    }

    // Combat
    const battle = resolveBattle(source.rank, target.rank);

    if (battle.Outcome === 0) {         // AttackerWins
        board[`${move.toX}_${move.toY}`] = source;
        delete board[`${move.fromX}_${move.fromY}`];
    } else if (battle.Outcome === 1) {  // DefenderWins
        delete board[`${move.fromX}_${move.fromY}`];
    } else if (battle.Outcome === 2) {  // BothDie
        delete board[`${move.fromX}_${move.fromY}`];
        delete board[`${move.toX}_${move.toY}`];
    } else if (battle.Outcome === 3) {  // FlagCaptured
        board[`${move.toX}_${move.toY}`] = source;
        delete board[`${move.fromX}_${move.fromY}`];
        broadcastGameOver(client.role);
        return;
    }

    endTurn();
    broadcastMove(move, battle);
}

function handleMessage(client, rawData) {
    try {
        const json = JSON.parse(rawData);
        console.log(`[${client.role}] → ${json.type}`);

        if (json.type === 'submit_placement') {
            handlePlacement(client, rawData);
        } else if (json.type === 'move_request') {
            handleMove(client, rawData);
        } else {
            console.log(`Unknown message type: ${json.type}`);
        }
    } catch (err) {
        console.error('Error handling message:', err.message);
    }
}

// ─── HTTP + WebSocket Server ──────────────────────────────────────────────────

const server = http.createServer((req, res) => {
    // Serve the game client
    if (req.url === '/' || req.url === '/index.html') {
        const filePath = path.join(__dirname, 'Salpakan_Enhanced.html');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Game client not found');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('New WebSocket connection');

    // Wait for client's first message to decide: reconnect or new player
    // Fallback: if no message in 2 seconds, treat as new player
    const initTimeout = setTimeout(() => {
        if (!ws.role) registerClient(ws);
    }, 2000);

    ws.on('message', (data) => {
        const raw = data.toString();
        try {
            const json = JSON.parse(raw);

            if (!ws.role) {
                // First message — determine reconnect or new player
                clearTimeout(initTimeout);
                if (json.type === 'reconnect' && json.sessionId) {
                    handleReconnect(ws, json.sessionId);
                } else {
                    registerClient(ws);
                }
            } else {
                handleMessage(ws, raw);
            }
        } catch (err) {
            console.error('Error parsing message:', err.message);
        }
    });

    ws.on('close', () => {
        clearTimeout(initTimeout);
        const role = ws.role || 'Unknown';
        console.log(`${role} disconnected.`);

        if (ws === redClient) redClient = null;
        else if (ws === blueClient) blueClient = null;
        else return; // Was not a registered player

        const remaining = redClient || blueClient;
        if (remaining) {
            // Notify the other player and start the reconnect countdown
            sendMessage(remaining, { type: 'opponent_disconnected', payload: { role } });

            if (gameResetTimer) clearTimeout(gameResetTimer);
            gameResetTimer = setTimeout(() => {
                console.log('Reconnect window expired — resetting game.');
                const r = redClient || blueClient;
                if (r) sendMessage(r, { type: 'opponent_gave_up', payload: {} });
                resetGame();
            }, RECONNECT_WINDOW_MS);
        } else {
            // Both disconnected — reset immediately
            resetGame();
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
});

server.listen(PORT, () => {
    console.log(`Salpakan server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to play locally`);
});
