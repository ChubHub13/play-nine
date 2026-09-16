'use strict';

const assert = require('node:assert/strict');
process.env.BOT_DELAY_MS = '20';
process.env.PLAYER_TIMEOUT_MS = '3000';

const game = require('./server');

function board(values) {
  return values.map((value, index) => ({ card: { id: String(index), value }, faceUp: true }));
}

async function request(baseUrl, pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json();
  assert.equal(response.ok, true, body.message);
  return body;
}

async function run() {
  const deck = game.buildDeck();
  assert.equal(deck.length, 108);
  for (let value = 0; value <= 12; value++) assert.equal(deck.filter(card => card.value === value).length, 8);
  assert.equal(deck.filter(card => card.value === -5).length, 4);

  assert.deepEqual(game.scoreBoard(board([6, 7, 8, 9, 6, 0, 8, 12])), { score: 28, bonus: 0, matchedColumns: [0, 2] });
  assert.equal(game.scoreBoard(board([7, 7, 1, 2, 7, 7, 3, 4])).score, 0, 'Two equal pair-columns cancel and earn -10.');
  assert.equal(game.scoreBoard(board([11, 11, 11, 0, 11, 11, 11, 12])).score, -3, 'Three equal pair-columns earn -15.');
  assert.equal(game.scoreBoard(board([3, 3, 3, 3, 3, 3, 3, 3])).score, -20, 'Four equal pair-columns earn -20.');
  assert.equal(game.scoreBoard(board([-5, 1, 2, 3, -5, 4, 5, 6])).score, 11, 'A Hole-in-One pair retains both -5 values.');
  assert.equal(game.scoreBoard(board([-5, -5, 2, 3, -5, -5, 5, 6])).score, -14, 'Four Hole-in-One cards total -30 before other cards.');
  const leadingBot = board([0, 1, 2, 3, 4, 5, 6, 7]);
  const trailingPlayer = board([5, 5, 5, 5, 6, 6, 6, 6]);
  const closePlayer = board([4, 4, 4, 4, 5, 5, 5, 5]);
  assert.equal(game.visibleBoardScore(leadingBot), 28);
  assert.equal(game.estimatedBoardScore(leadingBot), 28);
  assert.equal(game.botShouldGoOut([leadingBot, trailingPlayer, trailingPlayer], 0), true, 'Bot should finish when both estimated opponents trail by at least twelve.');
  assert.equal(game.botShouldGoOut([leadingBot, trailingPlayer, closePlayer], 0), false, 'Bot should keep playing when either estimated opponent is within twelve points.');
  const excellentBot = board([-5, 0, 1, 1, -5, 0, 1, 1]);
  assert.equal(game.botShouldGoOut([excellentBot, closePlayer, closePlayer], 0), true, 'Bot should finish with an estimated round score below five.');
  const estimatedHand = board([0, 1, 2, 3, 4, 5, 6, 7]);
  estimatedHand[6].faceUp = false;
  estimatedHand[7].faceUp = false;
  assert.equal(game.estimatedBoardScore(estimatedHand), 25, 'Each facedown card should be estimated at five points.');
  const pairOpportunity = board([7, 1, 2, 3, 12, 4, 5, 6]);
  assert.equal(game.bestReplacementForBoard(pairOpportunity, 7).index, 4, 'High-level bots should complete a matching column.');

  await new Promise((resolve, reject) => {
    game.server.once('error', reject);
    game.server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${game.server.address().port}`;
  const joined = await request(baseUrl, '/api/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Daryl', botLevel: 'high' })
  });
  assert.equal(joined.state.botLevel, 'high');
  const difficulty = await request(baseUrl, '/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: joined.token, action: 'setBotLevel', level: 'medium' })
  });
  assert.equal(difficulty.state.botLevel, 'medium');
  const renamed = await request(baseUrl, '/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: joined.token, action: 'rename', name: '  Guest   Golfer  ' })
  });
  assert.equal(renamed.state.seats[0].name, 'Guest Golfer');

  let state = await request(baseUrl, '/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: joined.token, action: 'start' })
  });
  assert.equal(state.state.phase, 'teeOff');
  state = await request(baseUrl, '/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: joined.token, action: 'teeOff', index: 0 })
  });
  state = await request(baseUrl, '/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: joined.token, action: 'teeOff', index: 1 })
  });
  assert.equal(state.state.phase, 'playing');
  assert.equal(state.state.turn, 0);
  await new Promise(resolve => setTimeout(resolve, 6500));
  state = await request(baseUrl, `/api/state?token=${encodeURIComponent(joined.token)}`);
  assert.equal(state.state.turn, 0, 'An inactive live player turn must remain paused.');
  assert.equal(state.state.boards[0].filter(slot => slot.faceUp).length, 2, 'The server must not play an inactive live player\'s cards.');
  state = await request(baseUrl, '/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: joined.token, action: 'draw', source: 'discard' })
  });
  assert.equal(state.state.stage, 'play');
  assert.equal(state.state.drawn.source, 'discard');
  state = await request(baseUrl, '/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: joined.token, action: 'switchDraw', source: 'stock' })
  });
  assert.equal(state.state.drawn.source, 'stock', 'A live player can change from the discard to the draw pile before playing.');
  state = await request(baseUrl, '/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: joined.token, action: 'replace', index: 0 })
  });
  assert.equal(state.state.turn, 1);

  let completedGame = null;
  let testedFinalPuttSkip = false;
  for (let step = 0; step < 3000; step++) {
    const snapshot = (await request(baseUrl, `/api/state?token=${encodeURIComponent(joined.token)}`)).state;
    if (snapshot.phase === 'gameover') {
      completedGame = snapshot;
      break;
    }
    if (snapshot.phase === 'holeEnd') {
      await request(baseUrl, '/api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: joined.token, action: 'nextHole' })
      });
      continue;
    }
    if (snapshot.phase === 'teeOff' && snapshot.teeOffCounts[0] < 2) {
      const target = snapshot.boards[0].find(slot => !slot.faceUp).index;
      await request(baseUrl, '/api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: joined.token, action: 'teeOff', index: target })
      });
      continue;
    }
    if (snapshot.phase === 'playing' && snapshot.turn === 0) {
      if (snapshot.stage === 'draw') {
        await request(baseUrl, '/api/action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: joined.token, action: 'draw', source: 'stock' })
        });
      } else {
        const hidden = snapshot.boards[0].find(slot => !slot.faceUp);
        const hiddenCount = snapshot.boards[0].filter(slot => !slot.faceUp).length;
        const action = hiddenCount === 1 && snapshot.drawn.source === 'stock' && !testedFinalPuttSkip
          ? { action: 'skip' }
          : hidden && snapshot.drawn.source === 'stock'
            ? { action: 'discardFlip', index: hidden.index }
            : { action: 'replace', index: 0 };
        const played = await request(baseUrl, '/api/action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: joined.token, ...action })
        });
        if (action.action === 'skip') {
          testedFinalPuttSkip = true;
          if (played.state.phase === 'playing') assert.equal(played.state.boards[0].filter(slot => !slot.faceUp).length, 1);
          else assert.ok(['holeEnd', 'gameover'].includes(played.state.phase), 'A final-turn stand may immediately score the hole.');
        }
      }
      continue;
    }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.ok(completedGame, 'Automated live/bot play should finish all nine holes.');
  assert.equal(completedGame.hole, 9);
  assert.equal(completedGame.holeHistory.length, 9);
  assert.equal(testedFinalPuttSkip, true);
}

run()
  .then(() => console.log('Play Nine tests passed.'))
  .finally(() => {
    game.server.close();
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
