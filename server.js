'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '1.4.0';
const PLAYER_NAMES = ['Daryl', 'Cristi', 'Cindy'];
const PLAYER_TIMEOUT_MS = Math.max(3000, Number(process.env.PLAYER_TIMEOUT_MS || 12000));
const BOT_DELAY_MS = Math.max(20, Number(process.env.BOT_DELAY_MS || 650));
const FINAL_HOLE = 9;
const sessions = new Map();
let botTimer = null;

const SCORE_HISTORY_FILE = process.env.SCORE_HISTORY_FILE || path.join(__dirname, 'score-history.json');

function cleanDisplayName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return name || null;
}

function loadScoreHistory() {
  try {
    const entries = JSON.parse(fs.readFileSync(SCORE_HISTORY_FILE, 'utf8'));
    return Array.isArray(entries) ? entries
      .map(entry => ({ ...entry, name: cleanDisplayName(entry?.name), bot: Boolean(entry?.bot) }))
      .filter(entry => entry.name && Number.isFinite(entry.score)) : [];
  } catch {
    return [];
  }
}

let scoreHistory = loadScoreHistory();

function saveScoreHistory() {
  try {
    fs.writeFileSync(SCORE_HISTORY_FILE, `${JSON.stringify(scoreHistory, null, 2)}\n`);
  } catch (error) {
    console.error('Could not save Play Nine score history:', error.message);
  }
}

function allTimeScores(direction) {
  const multiplier = direction === 'high' ? -1 : 1;
  return [...scoreHistory]
    .sort((a, b) => multiplier * (a.score - b.score) || String(a.playedAt).localeCompare(String(b.playedAt)))
    .slice(0, 5)
    .map(({ name, score, bot }) => ({ name, score, bot }));
}

function buildDeck() {
  const cards = [];
  for (let value = 0; value <= 12; value++) {
    for (let copy = 0; copy < 8; copy++) cards.push({ id: `${value}-${copy}`, value });
  }
  for (let copy = 0; copy < 4; copy++) cards.push({ id: `ace-${copy}`, value: -5 });
  return cards;
}

function shuffle(cards) {
  const copy = cards.map(card => ({ ...card }));
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = crypto.randomInt(index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function scoreBoard(board) {
  const cards = board.map(slot => slot.card);
  let score = cards.reduce((sum, card) => sum + card.value, 0);
  const matchedByValue = new Map();
  const matchedColumns = [];

  for (let column = 0; column < 4; column++) {
    const top = cards[column];
    const bottom = cards[column + 4];
    if (top.value !== bottom.value) continue;
    matchedColumns.push(column);
    const count = (matchedByValue.get(top.value) || 0) + 1;
    matchedByValue.set(top.value, count);
    if (top.value !== -5) score -= top.value * 2;
  }

  let bonus = 0;
  for (const [value, count] of matchedByValue) {
    if (count >= 2) bonus -= count * 5;
    // Hole-in-One pairs retain their -5 face values; only the four-card bonus applies.
    if (value === -5 && count < 2) bonus += 0;
  }
  score += bonus;
  return { score, bonus, matchedColumns };
}

const game = {
  version: VERSION,
  phase: 'waiting',
  hole: 0,
  dealer: 2,
  turn: 0,
  stage: 'draw',
  totals: [0, 0, 0],
  boards: [[], [], []],
  stock: [],
  discard: [],
  drawn: null,
  teeOffCounts: [0, 0, 0],
  closer: null,
  finalTurns: [],
  holeHistory: [],
  lastHole: null,
  winnerSeats: [],
  live: [false, false, false],
  bot: [true, true, true],
  lastSeen: [0, 0, 0],
  seatNames: [...PLAYER_NAMES],
  botSkips: [0, 0, 0],
  prompt: 'Choose Daryl, Cristi, or Cindy to begin.'
};

function playerName(seat) {
  return game.seatNames[seat] || PLAYER_NAMES[seat];
}

function randomToken() {
  return crypto.randomBytes(20).toString('hex');
}

function facedownIndexes(seat) {
  return game.boards[seat].map((slot, index) => slot.faceUp ? -1 : index).filter(index => index >= 0);
}

function boardComplete(seat) {
  return game.boards[seat].length === 8 && game.boards[seat].every(slot => slot.faceUp);
}

function ensureStock() {
  if (game.stock.length) return true;
  if (game.discard.length <= 1) return false;
  const top = game.discard.pop();
  game.stock = shuffle(game.discard);
  game.discard = [top];
  return true;
}

function autoTeeOffBots() {
  for (let seat = 0; seat < 3; seat++) {
    if (!game.bot[seat] || game.teeOffCounts[seat] >= 2) continue;
    const choices = shuffle(game.boards[seat].map((slot, index) => ({ index })));
    for (const { index } of choices.slice(0, 2 - game.teeOffCounts[seat])) {
      game.boards[seat][index].faceUp = true;
      game.teeOffCounts[seat]++;
    }
  }
  finishTeeOffIfReady();
}

function finishTeeOffIfReady() {
  if (game.phase !== 'teeOff' || !game.teeOffCounts.every(count => count === 2)) return false;
  game.phase = 'playing';
  game.turn = (game.dealer + 1) % 3;
  game.stage = 'draw';
  game.prompt = `${playerName(game.turn)} is up on Hole ${game.hole}.`;
  scheduleBot();
  return true;
}

function dealHole() {
  clearTimeout(botTimer);
  if (game.hole >= FINAL_HOLE) return false;
  game.hole++;
  if (game.hole > 1) game.dealer = (game.dealer + 1) % 3;
  const deck = shuffle(buildDeck());
  game.boards = [[], [], []];
  for (let card = 0; card < 8; card++) {
    for (let seat = 0; seat < 3; seat++) game.boards[seat].push({ card: deck.pop(), faceUp: false });
  }
  game.stock = deck;
  game.discard = [game.stock.pop()];
  game.drawn = null;
  game.teeOffCounts = [0, 0, 0];
  game.closer = null;
  game.finalTurns = [];
  game.lastHole = null;
  game.winnerSeats = [];
  game.botSkips = [0, 0, 0];
  game.phase = 'teeOff';
  game.stage = 'teeOff';
  game.prompt = `Hole ${game.hole}: flip any two cards to tee off.`;
  autoTeeOffBots();
  return true;
}

function startGame() {
  game.hole = 0;
  game.dealer = 2;
  game.totals = [0, 0, 0];
  game.holeHistory = [];
  game.lastHole = null;
  game.winnerSeats = [];
  return dealHole();
}

function flipTeeOff(seat, index) {
  if (game.phase !== 'teeOff' || game.bot[seat] || game.teeOffCounts[seat] >= 2) return false;
  const slot = game.boards[seat]?.[index];
  if (!slot || slot.faceUp) return false;
  slot.faceUp = true;
  game.teeOffCounts[seat]++;
  game.prompt = game.teeOffCounts.every(count => count === 2)
    ? `${playerName((game.dealer + 1) % 3)} tees off first.`
    : 'Waiting for every player to flip two cards.';
  finishTeeOffIfReady();
  return true;
}

function drawCard(seat, source) {
  if (game.phase !== 'playing' || game.turn !== seat || game.stage !== 'draw') return false;
  let card;
  if (source === 'discard') {
    if (!game.discard.length) return false;
    card = game.discard.pop();
  } else {
    if (!ensureStock()) return false;
    card = game.stock.pop();
    source = 'stock';
  }
  game.drawn = { card, source };
  game.stage = 'play';
  game.prompt = source === 'discard'
    ? `${playerName(seat)} must replace one card with the discard.`
    : `${playerName(seat)} can replace a card, or discard and flip.`;
  return true;
}

function replaceCard(seat, index) {
  if (game.phase !== 'playing' || game.turn !== seat || game.stage !== 'play' || !game.drawn) return false;
  const slot = game.boards[seat]?.[index];
  if (!slot) return false;
  game.discard.push(slot.card);
  slot.card = game.drawn.card;
  slot.faceUp = true;
  completeTurn(seat);
  return true;
}

function discardAndFlip(seat, index) {
  if (game.phase !== 'playing' || game.turn !== seat || game.stage !== 'play' || game.drawn?.source !== 'stock') return false;
  const slot = game.boards[seat]?.[index];
  if (!slot || slot.faceUp) return false;
  game.discard.push(game.drawn.card);
  slot.faceUp = true;
  completeTurn(seat);
  return true;
}

function skipFinalPutt(seat) {
  if (game.phase !== 'playing' || game.turn !== seat || game.stage !== 'play' || game.drawn?.source !== 'stock') return false;
  if (facedownIndexes(seat).length !== 1) return false;
  game.discard.push(game.drawn.card);
  completeTurn(seat);
  return true;
}

function completeTurn(seat) {
  game.drawn = null;
  game.stage = 'draw';
  if (game.closer === null && boardComplete(seat)) {
    game.closer = seat;
    game.finalTurns = [1, 2].map(offset => (seat + offset) % 3);
    game.turn = game.finalTurns[0];
    game.prompt = `${playerName(seat)} putts out. Everyone else gets one last shot.`;
  } else if (game.closer !== null) {
    game.finalTurns = game.finalTurns.filter(player => player !== seat);
    if (!game.finalTurns.length) return scoreHole();
    game.turn = game.finalTurns[0];
    game.prompt = `${playerName(game.turn)} takes a final shot.`;
  } else {
    game.turn = (seat + 1) % 3;
    game.prompt = `${playerName(game.turn)} is up.`;
  }
  scheduleBot();
}

function scoreHole() {
  clearTimeout(botTimer);
  for (const board of game.boards) for (const slot of board) slot.faceUp = true;
  const results = game.boards.map((board, seat) => ({ seat, name: playerName(seat), ...scoreBoard(board) }));
  for (const result of results) game.totals[result.seat] += result.score;
  game.lastHole = { hole: game.hole, closer: game.closer, results, totals: game.totals.slice() };
  game.holeHistory.push(game.lastHole);
  if (game.hole >= FINAL_HOLE) {
    const low = Math.min(...game.totals);
    game.winnerSeats = game.totals.map((score, seat) => score === low ? seat : -1).filter(seat => seat >= 0);
    game.phase = 'gameover';
    game.prompt = game.winnerSeats.length === 1
      ? `${playerName(game.winnerSeats[0])} wins with ${low} strokes.`
      : `${game.winnerSeats.map(playerName).join(' and ')} tie with ${low} strokes.`;
    const playedAt = new Date().toISOString();
    scoreHistory.push(...game.totals.map((score, seat) => ({ name: playerName(seat), score, bot: game.bot[seat], playedAt })));
    scoreHistory = scoreHistory.slice(-1000);
    saveScoreHistory();
  } else {
    game.phase = 'holeEnd';
    game.prompt = `Hole ${game.hole} complete. Review the scorecard.`;
  }
}

function pairTarget(seat, value) {
  const board = game.boards[seat];
  for (let column = 0; column < 4; column++) {
    const top = board[column];
    const bottom = board[column + 4];
    if (top.faceUp && top.card.value === value && (!bottom.faceUp || bottom.card.value !== value)) return column + 4;
    if (bottom.faceUp && bottom.card.value === value && (!top.faceUp || top.card.value !== value)) return column;
  }
  return null;
}

function visibleUpgradeTarget(seat, value) {
  const board = game.boards[seat];
  const visible = board.map((slot, index) => ({ slot, index })).filter(item => item.slot.faceUp).sort((a, b) => b.slot.card.value - a.slot.card.value);
  if (visible[0]?.slot.card.value > value) return visible[0].index;
  return null;
}

function botIsLate(seat) {
  const ownHidden = facedownIndexes(seat).length;
  const closestOpponent = Math.min(...game.boards.map((board, player) => player === seat ? 8 : board.filter(slot => !slot.faceUp).length));
  return game.closer !== null || ownHidden <= 2 || closestOpponent <= 2;
}

function visibleBoardScore(board) {
  let score = board.reduce((sum, slot) => sum + (slot.faceUp ? slot.card.value : 0), 0);
  const matchedByValue = new Map();
  for (let column = 0; column < 4; column++) {
    const top = board[column];
    const bottom = board[column + 4];
    if (!top?.faceUp || !bottom?.faceUp || top.card.value !== bottom.card.value) continue;
    const value = top.card.value;
    matchedByValue.set(value, (matchedByValue.get(value) || 0) + 1);
    if (value !== -5) score -= value * 2;
  }
  for (const count of matchedByValue.values()) if (count >= 2) score -= count * 5;
  return score;
}

function estimatedBoardScore(board) {
  return visibleBoardScore(board) + board.filter(slot => !slot.faceUp).length * 5;
}

function botShouldGoOut(boards, seat) {
  const botEstimate = estimatedBoardScore(boards[seat]);
  return botEstimate < 5 || boards.every((board, player) => player === seat || estimatedBoardScore(board) >= botEstimate + 12);
}

function replacementTarget(seat, value, allowVisible = false) {
  const pair = pairTarget(seat, value);
  if (pair !== null) return pair;
  const hidden = facedownIndexes(seat);
  if (hidden.length && value <= 4) return hidden[crypto.randomInt(hidden.length)];
  if (allowVisible) return visibleUpgradeTarget(seat, value);
  return null;
}

function botDraw(seat) {
  if (game.phase !== 'playing' || game.turn !== seat || !game.bot[seat] || game.stage !== 'draw') return;
  const discard = game.discard.at(-1);
  const discardTarget = discard ? replacementTarget(seat, discard.value, botIsLate(seat)) : null;
  drawCard(seat, discardTarget !== null ? 'discard' : 'stock');
  botTimer = setTimeout(() => botPlay(seat), Math.max(20, BOT_DELAY_MS * 0.65));
  botTimer.unref?.();
}

function botPlay(seat) {
  if (game.phase !== 'playing' || game.turn !== seat || !game.bot[seat] || game.stage !== 'play' || !game.drawn) return;
  const hidden = facedownIndexes(seat);
  if (game.drawn.source === 'stock' && hidden.length === 1 && botShouldGoOut(game.boards, seat)) {
    game.botSkips[seat] = 0;
    discardAndFlip(seat, hidden[0]);
    return;
  }
  const target = replacementTarget(seat, game.drawn.card.value, botIsLate(seat));
  if (target !== null) {
    game.botSkips[seat] = 0;
    replaceCard(seat, target);
    return;
  }
  if (game.drawn.source === 'stock' && hidden.length) {
    if (hidden.length === 1 && game.drawn.card.value > 3 && game.botSkips[seat] < 2) {
      game.botSkips[seat]++;
      skipFinalPutt(seat);
    } else {
      game.botSkips[seat] = 0;
      discardAndFlip(seat, hidden[crypto.randomInt(hidden.length)]);
    }
    return;
  }
  replaceCard(seat, 0);
}

function scheduleBot() {
  clearTimeout(botTimer);
  if (game.phase !== 'playing' || !game.bot[game.turn]) return;
  botTimer = setTimeout(() => game.stage === 'draw' ? botDraw(game.turn) : botPlay(game.turn), BOT_DELAY_MS);
  botTimer.unref?.();
}

function touchSession(token) {
  const session = sessions.get(token);
  if (!session) return null;
  session.lastSeen = Date.now();
  game.lastSeen[session.seat] = session.lastSeen;
  game.live[session.seat] = true;
  game.bot[session.seat] = false;
  game.seatNames[session.seat] = session.name;
  return session;
}

function publicState(seat) {
  return {
    version: VERSION,
    phase: game.phase,
    hole: game.hole,
    finalHole: FINAL_HOLE,
    dealer: game.dealer,
    turn: game.turn,
    stage: game.stage,
    totals: game.totals,
    handScores: game.boards.map(visibleBoardScore),
    boards: game.boards.map(board => board.map((slot, index) => ({ index, faceUp: slot.faceUp, value: slot.faceUp ? slot.card.value : null }))),
    stockCount: game.stock.length,
    discardTop: game.discard.at(-1) || null,
    drawn: game.drawn,
    teeOffCounts: game.teeOffCounts,
    closer: game.closer,
    finalTurns: game.finalTurns,
    holeHistory: game.holeHistory,
    lastHole: game.lastHole,
    winnerSeats: game.winnerSeats,
    seats: PLAYER_NAMES.map((name, player) => ({ seat: player, name: playerName(player), connected: game.live[player], bot: game.bot[player] })),
    prompt: game.prompt,
    you: seat,
    canSkip: game.phase === 'playing' && game.turn === seat && game.stage === 'play' && game.drawn?.source === 'stock' && facedownIndexes(seat).length === 1,
    allTime: { high: allTimeScores('high'), low: allTimeScores('low') }
  };
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 100000) request.destroy();
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

async function handleApi(request, response, url) {
  try {
    if (request.method === 'POST' && url.pathname === '/api/join') {
      const data = await readBody(request);
      const seat = PLAYER_NAMES.indexOf(String(data.name || ''));
      if (seat < 0) return json(response, 400, { ok: false, message: 'Choose Daryl, Cristi, or Cindy.' });
      const existing = data.token && sessions.get(data.token);
      const name = existing?.seat === seat ? existing.name : (cleanDisplayName(data.displayName) || PLAYER_NAMES[seat]);
      const token = existing?.seat === seat ? data.token : randomToken();
      sessions.set(token, { token, seat, name, lastSeen: Date.now() });
      game.live[seat] = true;
      game.bot[seat] = false;
      game.lastSeen[seat] = Date.now();
      game.seatNames[seat] = name;
      return json(response, 200, { ok: true, token, seat, name, state: publicState(seat) });
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      const session = touchSession(url.searchParams.get('token'));
      if (!session) return json(response, 401, { ok: false, message: 'Choose your player again.' });
      return json(response, 200, { ok: true, state: publicState(session.seat) });
    }

    if (request.method === 'POST' && url.pathname === '/api/heartbeat') {
      const data = await readBody(request);
      return json(response, touchSession(data.token) ? 200 : 401, { ok: Boolean(sessions.get(data.token)) });
    }

    if (request.method === 'POST' && url.pathname === '/api/action') {
      const data = await readBody(request);
      const session = touchSession(data.token);
      if (!session) return json(response, 401, { ok: false, message: 'Choose your player again.' });

      if (data.action === 'resetScores') {
        scoreHistory = [];
        saveScoreHistory();
        game.prompt = `${session.name} cleared the all-time score board.`;
        return json(response, 200, { ok: true, state: publicState(session.seat) });
      }

      let ok = false;
      if (data.action === 'rename') {
        const name = cleanDisplayName(data.name);
        if (!name) return json(response, 400, { ok: false, message: 'Enter a player name.' });
        session.name = name;
        game.seatNames[session.seat] = name;
        ok = true;
      } else if (data.action === 'start' || data.action === 'newGame') ok = startGame();
      else if (data.action === 'nextHole' && game.phase === 'holeEnd') ok = dealHole();
      else if (data.action === 'teeOff') ok = flipTeeOff(session.seat, Number(data.index));
      else if (data.action === 'draw') ok = drawCard(session.seat, data.source === 'discard' ? 'discard' : 'stock');
      else if (data.action === 'replace') ok = replaceCard(session.seat, Number(data.index));
      else if (data.action === 'discardFlip') ok = discardAndFlip(session.seat, Number(data.index));
      else if (data.action === 'skip') ok = skipFinalPutt(session.seat);

      if (!ok) return json(response, 400, { ok: false, message: 'That play is not available now.' });
      return json(response, 200, { ok: true, state: publicState(session.seat) });
    }

    return json(response, 404, { ok: false, message: 'Not found.' });
  } catch (error) {
    return json(response, 500, { ok: false, message: error.message || 'Server error.' });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return response.end();
  }
  if (url.pathname.startsWith('/api/')) return handleApi(request, response, url);
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const root = path.resolve(__dirname);
  const filePath = path.resolve(root, requested);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403);
    return response.end('Forbidden');
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      return response.end('Not found');
    }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
    response.writeHead(200, { 'Content-Type': types[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(data);
  });
});

setInterval(() => {
  const now = Date.now();
  if (game.phase === 'waiting' || game.phase === 'gameover') {
    for (let seat = 0; seat < 3; seat++) {
      if (game.live[seat] && now - game.lastSeen[seat] > PLAYER_TIMEOUT_MS) {
        game.live[seat] = false;
        game.bot[seat] = true;
      }
    }
  }
  if (game.phase === 'teeOff') autoTeeOffBots();
  if (game.phase === 'playing' && game.bot[game.turn]) scheduleBot();
}, 3000).unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`Play Nine v${VERSION} running at http://${HOST}:${PORT}`));
}

module.exports = { buildDeck, scoreBoard, visibleBoardScore, estimatedBoardScore, botShouldGoOut, server };
