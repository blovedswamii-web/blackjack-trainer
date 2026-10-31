#!/usr/bin/env node
/* ============================================================================
 * Unit tests for the Blackjack Trainer engine.
 *
 *   node test.js            run everything
 *   node test.js shuffle    run only test groups whose name contains "shuffle"
 *
 * The engine lives inside blackjack-trainer.html in <script id="bj-engine">.
 * We pull that block out of the HTML and run it in a fresh V8 context, so the
 * tests exercise exactly the code the page runs, with no copy to keep in sync.
 * No dependencies: plain Node (v18+).
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadEngine() {
  const html = fs.readFileSync(path.join(__dirname, 'blackjack-trainer.html'), 'utf8');
  const m = html.match(/<script id="bj-engine">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Could not find <script id="bj-engine"> in blackjack-trainer.html');
  const context = { console, crypto: globalThis.crypto || require('crypto').webcrypto };
  vm.createContext(context);
  vm.runInContext(m[1], context, { filename: 'bj-engine (blackjack-trainer.html)' });
  return context.BJ;
}
const BJ = loadEngine();

/* ---------------- tiny test harness ---------------- */
const filter = process.argv[2] ? process.argv[2].toLowerCase() : null;
const groups = [];
function group(name, fn) { groups.push({ name, fn }); }
let passed = 0, failed = 0, current = [];
function test(name, fn) { current.push({ name, fn }); }

class AssertionError extends Error {}
function assert(cond, msg) { if (!cond) throw new AssertionError(msg || 'assertion failed'); }
function eq(actual, expected, msg) {
  // JSON comparison sidesteps cross-realm prototype differences (objects come from the vm context).
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${e}, got ${a}`);
}
function near(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol))
    throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${expected} ± ${tol}, got ${actual}`);
}
function throws(fn, re, msg) {
  try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new AssertionError(`${msg || 'wrong error'}: ${e.message}`); return; }
  throw new AssertionError(msg || 'expected an exception');
}

/** Pearson chi-square statistic for observed counts vs a uniform expectation. */
function chiSquare(counts) {
  const n = counts.reduce((a, b) => a + b, 0), e = n / counts.length;
  return counts.reduce((s, o) => s + (o - e) ** 2 / e, 0);
}
/**
 * Critical value of chi-square at significance p = 0.0001 (Wilson–Hilferty
 * approximation, z = 3.719). A correct shuffle fails this about once in 10,000
 * runs, so a failure means something is really wrong.
 */
function chiCritical(df) {
  const z = 3.719;
  return df * Math.pow(1 - 2 / (9 * df) + z * Math.sqrt(2 / (9 * df)), 3);
}

/* Game helper: a fresh game whose next cards are stacked. Order of dealing is
 * player, dealer-up, player, dealer-hole, then any further draws. */
function stackedGame(rules, cards, bankroll = 1000) {
  const g = new BJ.Game(rules, { randomInt: BJ.seededRandomInt(42), bankroll });
  g.shoe.arrange(cards);
  return g;
}

/* ============================================================================
 * STAGE 1: randomness, rules, cards, shoe, game
 * ========================================================================== */

group('Stage 1 · random numbers and shuffle', () => {
  test('cryptoRandomInt stays in [0, n)', () => {
    for (const n of [1, 2, 3, 7, 52, 416, 1e6, 2 ** 32]) {
      for (let i = 0; i < 2000; i++) {
        const x = BJ.cryptoRandomInt(n);
        assert(Number.isInteger(x) && x >= 0 && x < n, `n=${n} gave ${x}`);
      }
    }
  });

  test('cryptoRandomInt is uniform (chi-square, n=6 and n=13)', () => {
    for (const n of [6, 13]) {
      const counts = new Array(n).fill(0);
      for (let i = 0; i < n * 20000; i++) counts[BJ.cryptoRandomInt(n)]++;
      const chi = chiSquare(counts);
      assert(chi < chiCritical(n - 1), `n=${n}: chi²=${chi.toFixed(1)} > ${chiCritical(n - 1).toFixed(1)}`);
    }
  });

  test('boundedInt rejects the biased tail (n = 3·2^30 → never returns from the top quarter)', () => {
    // With n = 3·2^30, 2^32 mod n = 2^30, so words ≥ 3·2^30 must be rejected.
    // Feed it one "bad" word followed by a good one and check it skipped the bad one.
    const words = [0xFFFFFFFF, 5];
    const x = BJ.boundedInt(() => words.shift(), 3 * 2 ** 30);
    eq(x, 5);
  });

  test('shuffle returns a permutation (no lost or duplicated cards)', () => {
    const a = Array.from({ length: 416 }, (_, i) => i);
    BJ.shuffle(a);
    eq(a.slice().sort((x, y) => x - y), Array.from({ length: 416 }, (_, i) => i));
  });

  test('all 24 orderings of 4 items are equally likely (120k shuffles)', () => {
    const counts = new Map();
    for (let t = 0; t < 120000; t++) {
      const key = BJ.shuffle([0, 1, 2, 3]).join('');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    eq(counts.size, 24, 'number of distinct permutations');
    const chi = chiSquare([...counts.values()]);
    assert(chi < chiCritical(23), `chi²=${chi.toFixed(1)} > ${chiCritical(23).toFixed(1)}`);
  });

  test('every card is equally likely to land in every position (52 cards)', () => {
    // Track where card 0 and card 51 end up across 52k shuffles.
    const first = new Array(52).fill(0), last = new Array(52).fill(0);
    for (let t = 0; t < 52000; t++) {
      const a = BJ.shuffle(Array.from({ length: 52 }, (_, i) => i));
      first[a.indexOf(0)]++;
      last[a.indexOf(51)]++;
    }
    for (const [name, c] of [['card 0', first], ['card 51', last]]) {
      const chi = chiSquare(c);
      assert(chi < chiCritical(51), `${name}: chi²=${chi.toFixed(1)}`);
    }
  });

  test('the test has teeth: the classic "swap with any position" bug fails it', () => {
    const badShuffle = a => { for (let i = 0; i < a.length; i++) { const j = BJ.cryptoRandomInt(a.length); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const counts = new Map();
    for (let t = 0; t < 120000; t++) {
      const key = badShuffle([0, 1, 2, 3]).join('');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const chi = chiSquare([...counts.values()]);
    assert(chi > chiCritical(23), `biased shuffle should fail, chi²=${chi.toFixed(1)}`);
  });

  test('seeded generator is reproducible', () => {
    const a = BJ.seededRandomInt(7), b = BJ.seededRandomInt(7), c = BJ.seededRandomInt(8);
    const sa = Array.from({ length: 20 }, () => a(1000));
    const sb = Array.from({ length: 20 }, () => b(1000));
    const sc = Array.from({ length: 20 }, () => c(1000));
    eq(sa, sb);
    assert(JSON.stringify(sa) !== JSON.stringify(sc), 'different seeds should differ');
  });
});

group('Stage 1 · rules', () => {
  test('defaults are complete and valid', () => {
    const r = BJ.normalizeRules({});
    eq(r, { decks: 6, h17: true, bjPayout: 1.5, das: true, rsa: false, maxHands: 4, lateSurrender: true,
            doubleOn: 'any', penetration: 0.75, minBet: 10, maxBet: 1000 });
  });
  test('bad values fall back to defaults, strings are coerced', () => {
    const r = BJ.normalizeRules({ decks: 5, h17: 'false', bjPayout: '1.2', das: 'maybe', maxHands: '2', doubleOn: 'never', bogus: 1 });
    eq(r.decks, 6); eq(r.h17, false); eq(r.bjPayout, 1.2); eq(r.das, true); eq(r.maxHands, 2); eq(r.doubleOn, 'any');
    assert(!('bogus' in r), 'unknown keys are dropped');
  });
  test('penetration is clamped to 50–90% and snapped to 5% steps', () => {
    eq(BJ.normalizeRules({ penetration: 0.95 }).penetration, 0.9);
    eq(BJ.normalizeRules({ penetration: 0.2 }).penetration, 0.5);
    eq(BJ.normalizeRules({ penetration: 0.67 }).penetration, 0.65);
    eq(BJ.normalizeRules({ penetration: 'abc' }).penetration, 0.75);
  });
  test('max bet is never below min bet', () => {
    const r = BJ.normalizeRules({ minBet: 50, maxBet: 20 });
    eq([r.minBet, r.maxBet], [50, 50]);
  });
  test('JSON round-trip is lossless; garbage input is safe', () => {
    const r = BJ.normalizeRules({ decks: 2, h17: false, bjPayout: 1.2, rsa: true, penetration: 0.8 });
    eq(BJ.normalizeRules(JSON.parse(JSON.stringify(r))), r);
    eq(BJ.normalizeRules(null), BJ.normalizeRules({}));
    eq(BJ.normalizeRules('nonsense'), BJ.normalizeRules({}));
  });
  test('summary string', () => {
    eq(BJ.rulesSummary(BJ.normalizeRules({})), '6D · H17 · BJ 3:2 · DAS · LS · SP4 · 75% pen');
    eq(BJ.rulesSummary(BJ.normalizeRules({ decks: 1, h17: false, bjPayout: 1.2, das: false, lateSurrender: false, rsa: true, maxHands: 2, doubleOn: '9-11' })),
       '1D · S17 · BJ 6:5 · NDAS · NS · RSA · SP2 · D9-11 · 75% pen');
  });
});

group('Stage 1 · hand values', () => {
  const v = (...cards) => BJ.handValue(cards);
  test('hard and soft totals', () => {
    eq(v(1, 6), { total: 17, soft: true });
    eq(v(1, 6, 10), { total: 17, soft: false });
    eq(v(1, 1), { total: 12, soft: true });
    eq(v(1, 1, 9), { total: 21, soft: true });
    eq(v(10, 6, 1), { total: 17, soft: false });
    eq(v(10, 10, 5), { total: 25, soft: false });
    eq(v(1, 10), { total: 21, soft: true });
    eq(v(1, 1, 1, 1, 1, 1), { total: 16, soft: true });
  });
  test('dealer soft-17 rule', () => {
    assert(BJ.dealerShouldHit([1, 6], true), 'H17 hits soft 17');
    assert(!BJ.dealerShouldHit([1, 6], false), 'S17 stands on soft 17');
    assert(!BJ.dealerShouldHit([10, 7], true), 'hard 17 always stands');
    assert(BJ.dealerShouldHit([10, 6], false), '16 always hits');
    assert(!BJ.dealerShouldHit([1, 7], true), 'soft 18 stands');
  });
  test('rank values', () => {
    eq(['A', '2', '9', '10', 'J', 'Q', 'K', 'T'].map(BJ.rankValue), [1, 2, 9, 10, 10, 10, 10, 10]);
  });
});

group('Stage 1 · shoe', () => {
  test('size and composition for every deck count', () => {
    for (const d of [1, 2, 4, 6, 8]) {
      const s = new BJ.Shoe(d, 0.75);
      eq(s.size, 52 * d);
      const c = s.remainingCounts();
      for (let v = 1; v <= 9; v++) eq(c[v], 4 * d, `value ${v}, ${d} decks`);
      eq(c[10], 16 * d, `tens, ${d} decks`);
      eq(new Set(s.cards.map(x => x.id)).size, 52 * d, 'unique ids');
    }
  });
  test('cut card position follows penetration; needsShuffle after it', () => {
    const s = new BJ.Shoe(6, 0.8, BJ.seededRandomInt(1));
    eq(s.cutIndex, Math.round(312 * 0.8));
    while (s.dealt < s.cutIndex - 1) s.draw();
    assert(!s.needsShuffle, 'one card before the cut');
    s.draw();
    assert(s.needsShuffle, 'at the cut');
    s.shuffle();
    eq([s.dealt, s.needsShuffle], [0, false]);
  });
  test('arrange stacks the next cards without changing composition', () => {
    const s = new BJ.Shoe(1, 0.75, BJ.seededRandomInt(3));
    s.draw(); s.draw();
    const before = s.remainingCounts();
    s.arrange(['A', 'K', 5, 1]);
    eq(s.remainingCounts(), before);
    eq([s.draw().v, s.draw().v, s.draw().v, s.draw().v], [1, 10, 5, 1]);
    throws(() => { s.arrange([1, 1, 1]); }, /no card/);   // only 4 aces in one deck
  });
  test('running out mid-round reshuffles everything except the table cards', () => {
    const s = new BJ.Shoe(1, 0.75, BJ.seededRandomInt(4));
    for (let i = 0; i < 50; i++) s.draw();
    const table = [s.cards[48], s.cards[49]];
    s.onEmpty = () => s.reshuffleExcluding(table);
    s.draw(); s.draw(); // empties the shoe
    const c = s.draw(); // triggers the reshuffle
    assert(!table.includes(c), 'table cards are not redealt');
    eq(s.size, 52);
    eq(s.dealt, 3);
  });
});

group('Stage 1 · game flow and payouts', () => {
  test('player blackjack pays 3:2, 6:5 and 1:1', () => {
    for (const [pay, win] of [[1.5, 15], [1.2, 12], [1, 10]]) {
      const g = stackedGame({ bjPayout: pay }, ['A', 9, 'K', 7]);
      g.deal(10);
      eq([g.state, g.result.hands[0].outcome, g.result.net, g.bankroll], ['roundOver', 'blackjack', win, 1000 + win]);
    }
  });
  test('dealer blackjack with a ten up: player loses only the original bet', () => {
    const g = stackedGame({}, [10, 10, 10, 'A']);
    g.deal(10);
    eq([g.state, g.result.dealerBJ, g.result.net, g.bankroll], ['roundOver', true, -10, 990]);
  });
  test('ace up offers insurance; insurance pays 2:1 against a dealer blackjack', () => {
    const g = stackedGame({}, [10, 'A', 9, 'K']);
    g.deal(10);
    eq(g.state, 'insurance');
    g.insurance(true);
    eq([g.result.insuranceNet, g.result.net, g.bankroll], [10, 0, 1000]);
  });
  test('insurance loses when the dealer has no blackjack and play continues', () => {
    const g = stackedGame({}, [10, 'A', 9, 7]);
    g.deal(10);
    g.insurance(true);
    eq([g.state, g.bankroll], ['player', 985]);
    g.stand(); // 19 vs dealer A,7 = soft 18; H17 stands on 18
    eq([g.result.hands[0].outcome, g.result.insuranceNet, g.result.net, g.bankroll], ['win', -5, 5, 1005]);
  });
  test('blackjack vs blackjack is a push', () => {
    const g = stackedGame({}, ['A', 'A', 'K', 'K']);
    g.deal(10);
    g.insurance(false);
    eq([g.result.hands[0].outcome, g.result.net], ['push', 0]);
  });
  test('late surrender returns half; not allowed when disabled or after a hit', () => {
    let g = stackedGame({}, [10, 10, 6, 7]);
    g.deal(10);
    g.surrender();
    eq([g.result.hands[0].outcome, g.result.net, g.bankroll], ['surrender', -5, 995]);
    g = stackedGame({ lateSurrender: false }, [10, 10, 6, 7]);
    g.deal(10);
    eq(g.legalActions().surrender, false);
    g = stackedGame({}, [5, 10, 6, 7, 2]);
    g.deal(10);
    g.hit();
    eq(g.legalActions().surrender, false);
  });
  test('double down: one card, doubled stake', () => {
    // Player 6,5 = 11 vs dealer 6 (hole 10 → 16). Double gets a 10 → 21. Dealer draws 10 → bust.
    const g = stackedGame({}, [6, 6, 5, 10, 10, 10]);
    g.deal(10);
    g.double();
    eq([g.hands[0].cards.length, g.result.hands[0].outcome, g.result.net, g.bankroll], [3, 'win', 20, 1020]);
  });
  test('double restricted to 9–11', () => {
    let g = stackedGame({ doubleOn: '9-11' }, [5, 6, 3, 10]);
    g.deal(10);
    eq(g.legalActions().double, false, 'hard 8');
    g = stackedGame({ doubleOn: '9-11' }, [6, 6, 4, 10]);
    g.deal(10);
    eq(g.legalActions().double, true, 'hard 10');
    g = stackedGame({ doubleOn: '9-11' }, ['A', 6, 7, 10]);
    g.deal(10);
    eq(g.legalActions().double, false, 'soft 18');
  });
  test('split 8s; DAS controls doubling the split hands', () => {
    for (const das of [true, false]) {
      // P:8,8 vs D:6 (hole 10). Split: hand 1 gets 3 (=11), hand 2 gets 10 (=18).
      const g = stackedGame({ das }, [8, 6, 8, 10, 3, 10, 10]);
      g.deal(10);
      g.split();
      eq([g.hands.length, g.bankroll, g.hands[0].cards.length], [2, 980, 2]);
      eq(g.legalActions().double, das, `double after split with das=${das}`);
      if (das) g.double(); else g.stand();
      g.stand();
      eq(g.state, 'roundOver');
    }
  });
  test('split aces get one card each and cannot hit; 21 there is not a blackjack', () => {
    const g = stackedGame({}, ['A', 7, 'A', 10, 'K', 9]);
    g.deal(10);
    g.split();
    // Both split aces were dealt one card and stood automatically.
    eq(g.state, 'roundOver');
    eq(g.result.hands.map(h => [h.total, h.outcome, h.net]), [[21, 'win', 10], [20, 'win', 10]]);
  });
  test('resplit aces only when RSA is on', () => {
    for (const rsa of [false, true]) {
      const g = stackedGame({ rsa }, ['A', 7, 'A', 10, 'A', 9, 9, 9]);
      g.deal(10);
      g.split();
      if (!rsa) {
        // Hand 1 drew an ace (soft 12) and must stand; hand 2 drew a 9 (soft 20). Round over.
        eq([g.state, g.hands.length], ['roundOver', 2]);
        eq(g.result.hands.map(h => h.total), [12, 20]);
      } else {
        eq([g.state, g.active, g.legalActions().split, g.legalActions().hit], ['player', 0, true, false]);
        g.split();
        eq(g.hands.length, 3);
      }
    }
  });
  test('max hands caps the number of splits', () => {
    const g = stackedGame({ maxHands: 2 }, [8, 6, 8, 10, 8, 10, 10]);
    g.deal(10);
    g.split();
    eq(g.hands[0].cards.map(c => c.v), [8, 8]);
    eq(g.legalActions().split, false, 'already at 2 hands');
  });
  test('dealer hits soft 17 under H17 and stands under S17', () => {
    for (const h17 of [true, false]) {
      const g = stackedGame({ h17 }, [10, 'A', 8, 6, 2]);
      g.deal(10);
      g.insurance(false);
      g.stand();
      // Player 18 vs dealer A,6. H17: dealer draws the 2 → 19 and wins. S17: dealer stays on 17 and loses.
      eq(g.dealer.length, h17 ? 3 : 2, `h17=${h17}`);
      eq(g.result.net, h17 ? -10 : 10, `18 vs ${h17 ? '19' : '17'}`);
    }
  });
  test('hitting to 21 stands automatically; busting ends the hand and the dealer does not draw', () => {
    let g = stackedGame({}, [5, 10, 6, 6, 10]);
    g.deal(10);
    g.hit();
    eq(g.state, 'roundOver', '21 auto-stands');
    g = stackedGame({}, [10, 10, 6, 6, 10, 9]);
    g.deal(10);
    g.hit();
    eq([g.result.hands[0].outcome, g.dealer.length, g.holeHidden], ['bust', 2, false]);
  });
  test('bankroll limits: bets, doubles and splits need the money', () => {
    const g = stackedGame({}, [8, 6, 8, 10], 15);
    throws(() => g.deal(20), /Not enough/);
    throws(() => g.deal(5), /minimum/);
    g.deal(10);
    eq([g.legalActions().double, g.legalActions().split], [false, false]);
  });
  test('illegal actions throw and change nothing', () => {
    const g = stackedGame({}, [10, 6, 9, 10]);
    g.deal(10);
    throws(() => g.split(), /Can't split/);
    eq(g.hands.length, 1);
  });
});

group('Stage 1 · invariants under random play (20,000 rounds)', () => {
  test('money is conserved, every card is shown exactly once, no crashes', () => {
    const rng = BJ.seededRandomInt(2024);
    for (const rules of [{}, { decks: 1, penetration: 0.9, rsa: true, maxHands: 4 }, { decks: 2, h17: false, das: false, doubleOn: '9-11', lateSurrender: false }]) {
      const g = new BJ.Game(rules, { randomInt: rng, bankroll: 1e9 });
      let shown = 0, sumNet = 0, start = g.bankroll;
      g.on((type, data) => {
        if (type === 'card') shown++;
        // A mid-round reshuffle keeps the table cards as "dealt"; all but the hole card were shown.
        if (type === 'shuffle') shown = data.midRound ? g.shoe.dealt - (g.holeHidden ? 1 : 0) : 0;
        if (type === 'roundEnd') sumNet += data.net;
      });
      for (let round = 0; round < 20000 / 3; round++) {
        g.deal(10 + rng(5) * 10);
        if (g.state === 'insurance') g.insurance(rng(2) === 1);
        while (g.state === 'player') {
          const legal = Object.keys(g.legalActions()).filter(k => g.legalActions()[k]);
          g.act(legal[rng(legal.length)]);
        }
        eq(g.state, 'roundOver');
        // Every dealt card has been revealed by the end of the round.
        eq(shown, g.shoe.dealt, `round ${round}: cards shown vs dealt`);
      }
      near(g.bankroll - start, sumNet, 1e-6, 'bankroll change equals the sum of round results');
    }
  });
});

/* ============================================================================
 * STAGE 2: strategy engine
 * ========================================================================== */

/* Independent, deliberately naive reference implementations: no memoization,
 * no graph, just the definitions. The solver must agree with them exactly. */
function naiveDealerDist(counts, up, h17) {
  const c = counts.slice();
  const out = [0, 0, 0, 0, 0, 0];
  const ex = up === 1 ? 10 : up === 10 ? 1 : 0;
  const rec = (cards, p) => {
    const { total, soft } = BJ.handValue(cards);
    if (total > 21) { out[5] += p; return; }
    if (total >= 17 && !(total === 17 && soft && h17)) { out[total - 17] += p; return; }
    const n = c.reduce((a, b) => a + b, 0);
    const first = cards.length === 1;
    const denom = first && ex ? n - c[ex] : n;
    for (let v = 1; v <= 10; v++) {
      if (!c[v] || (first && v === ex)) continue;
      const q = c[v] / denom;
      c[v]--; rec(cards.concat(v), p * q); c[v]++;
    }
  };
  rec([up], 1);
  return out;
}
function naiveStand(counts, up, h17, total) {
  if (total > 21) return -1;
  const d = naiveDealerDist(counts, up, h17);
  let ev = d[5];
  for (let i = 0; i < 5; i++) ev += total > 17 + i ? d[i] : total < 17 + i ? -d[i] : 0;
  return ev;
}
function naiveHit(counts, up, h17, cards) {   // counts exclude `cards`
  const n = counts.reduce((a, b) => a + b, 0);
  let ev = 0;
  for (let v = 1; v <= 10; v++) {
    if (!counts[v]) continue;
    const p = counts[v] / n;
    const c = counts.slice(); c[v]--;
    const hand = cards.concat(v), t = BJ.handValue(hand).total;
    ev += p * (t > 21 ? -1 : t === 21 ? naiveStand(c, up, h17, 21) : Math.max(naiveStand(c, up, h17, t), naiveHit(c, up, h17, hand)));
  }
  return ev;
}

/* A shoe with a given Hi-Lo running count: start from `decks` full decks and
 * pull out low cards (count goes up) or tens (count goes down). */
function shoeWithCount(decks, rc) {
  const c = BJ.fullShoeCounts(decks);
  for (let i = 0; i < Math.abs(rc); i++) {
    if (rc > 0) c[2 + (i % 5)]--; else c[10]--;
  }
  return c;
}
const SOLVER_RULES_6D = BJ.normalizeRules({ decks: 6, h17: false, das: true, lateSurrender: false });

group('Stage 2 · dealer probabilities', () => {
  test('match a naive enumeration exactly (1 deck, every up card, H17 and S17, with peek)', () => {
    const base = BJ.fullShoeCounts(1);
    base[5] -= 2; base[10] -= 3; base[1] -= 1;          // some cards already gone
    for (const h17 of [true, false]) {
      for (let up = 1; up <= 10; up++) {
        const c = base.slice(); c[up]--;
        const s = new BJ.CompSolver(BJ.normalizeRules({ h17 }), c, up);
        const got = Array.from(s.dealerDist());
        const want = naiveDealerDist(c, up, h17);
        got.forEach((x, i) => near(x, want[i], 1e-12, `up ${up} h17=${h17} outcome ${i}`));
        near(got.reduce((a, b) => a + b, 0), 1, 1e-12, 'probabilities sum to 1');
      }
    }
  });

  test('infinite-deck bust rates match the standard S17 table (2–9 up)', () => {
    // Standard infinite-deck dealer-bust probabilities, S17 (no hole-card peek for 2–9).
    const table = { 2: 0.3536, 3: 0.3739, 4: 0.3945, 5: 0.4164, 6: 0.4232, 7: 0.2623, 8: 0.2447, 9: 0.2284 };
    // ...and an independent infinite-deck recursion (every value 1/13, tens 4/13).
    const infBust = up => {
      const rec = (h, a) => {
        const t = a && h + 10 <= 21 ? h + 10 : h;
        if (t > 21) return 1;
        if (t >= 17) return 0;
        let b = 0;
        for (let v = 1; v <= 10; v++) b += (v === 10 ? 4 : 1) / 13 * rec(h + v, a || v === 1);
        return b;
      };
      return rec(up, up === 1);
    };
    const big = BJ.fullShoeCounts(100000);              // effectively infinite
    for (const up in table) {
      const c = big.slice(); c[up]--;
      const d = new BJ.CompSolver(BJ.normalizeRules({ h17: false }), c, Number(up)).dealerDist();
      near(d[5], table[up], 0.0001, `bust with ${up} up vs table`);
      near(d[5], infBust(Number(up)), 0.00002, `bust with ${up} up vs independent recursion`);
    }
  });
});

group('Stage 2 · player EVs', () => {
  test('stand and hit EVs match naive recursion (small shoe, many hands)', () => {
    const base = BJ.fullShoeCounts(1);
    for (const v of [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 1, 2, 3, 4, 5, 6]) base[v]--;   // a 34-card stub
    const rules = BJ.normalizeRules({ h17: true });
    for (const [cards, up] of [[[10, 6], 10], [[10, 2], 4], [[1, 6], 2], [[9, 3], 7], [[5, 4], 6], [[2, 3, 2, 7], 1]]) {
      const c = base.slice(); c[up]--;
      const s = new BJ.CompSolver(rules, c, up);
      const ev = s.analyze(cards, { canDouble: true });
      const cc = c.slice(); for (const v of cards) cc[v]--;
      const t = BJ.handValue(cards).total;
      near(ev.stand, naiveStand(cc, up, true, t), 1e-12, `stand ${cards} v ${up}`);
      near(ev.hit, naiveHit(cc, up, true, cards), 1e-12, `hit ${cards} v ${up}`);
    }
  });

  test('textbook split decisions come out right at a neutral shoe', () => {
    const legal = { hit: true, stand: true, double: true, split: true, surrender: false };
    const ev = (cards, up) => {
      const c = BJ.fullShoeCounts(6); c[up]--; for (const v of cards) c[v]--;
      return BJ.analyzeHand(SOLVER_RULES_6D, c, up, cards, legal);
    };
    eq(ev([1, 1], 6).best, 'split', 'A,A v 6');
    eq(ev([8, 8], 10).best, 'split', '8,8 v 10');
    eq(ev([10, 10], 6).best, 'stand', '10,10 v 6');
    eq(ev([5, 5], 6).best, 'double', '5,5 v 6');
    eq(ev([9, 9], 7).best, 'stand', '9,9 v 7');
  });

  test('a live decision is fast (worst case 2,2 v 2 off a fresh 8-deck shoe < 400 ms)', () => {
    const c = BJ.fullShoeCounts(8); c[2] -= 3;
    const t = Date.now();
    BJ.analyzeHand(BJ.normalizeRules({ decks: 8 }), c, 2, [2, 2], { hit: true, stand: true, double: true, split: true, surrender: true });
    const dt = Date.now() - t;
    assert(dt < 400, `took ${dt} ms`);
  });
});

group('Stage 2 · house edge for standard rule sets', () => {
  // Published reference: Wizard of Odds house-edge tables (basic strategy player).
  // Our solver plays the two-card decision with the exact composition, which can
  // only be equal or slightly better, so tolerances are a few hundredths of a %.
  const he = r => BJ.analyzeRules(r).houseEdge * 100;
  const base = { decks: 6, h17: false, das: true, lateSurrender: false, rsa: false, maxHands: 4 };
  let baseEdge;
  test('6 decks, S17, DAS, no surrender, split to 4: 0.40%', () => {
    baseEdge = he(base);
    near(baseEdge, 0.40, 0.03);
  });
  test('8 decks, S17, DAS: 0.43%', () => near(he(Object.assign({}, base, { decks: 8 })), 0.43, 0.03));
  test('6 decks, H17, DAS: 0.62%', () => near(he(Object.assign({}, base, { h17: true })), 0.62, 0.03));
  test('single deck, S17, no DAS: about break-even', () => near(he(Object.assign({}, base, { decks: 1, das: false })), 0.0, 0.07));
  test('rule effects have the published size', () => {
    const delta = (change, want, tol, label) => near(he(Object.assign({}, base, change)) - baseEdge, want, tol, label);
    delta({ h17: true }, 0.22, 0.03, 'H17');
    delta({ lateSurrender: true }, -0.08, 0.02, 'late surrender');
    delta({ das: false }, 0.14, 0.02, 'no DAS');
    delta({ bjPayout: 1.2 }, 1.39, 0.05, '6:5');
    delta({ bjPayout: 1 }, 2.27, 0.08, '1:1');
    delta({ rsa: true }, -0.07, 0.02, 'RSA');
    delta({ doubleOn: '9-11' }, 0.09, 0.03, 'double 9-11 only');
  });
});

group('Stage 2 · computed basic strategy chart', () => {
  const UPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1];
  // The textbook 4–8 deck, S17, DAS, no-surrender chart, columns 2..10, A.
  // It's typed in here ONLY as a test oracle; the app derives its chart.
  const ORACLE = {
    hard: {
      8: 'H H H H H H H H H H', 9: 'H Dh Dh Dh Dh H H H H H', 10: 'Dh Dh Dh Dh Dh Dh Dh Dh H H',
      11: 'Dh Dh Dh Dh Dh Dh Dh Dh Dh H', 12: 'H H S S S H H H H H', 13: 'S S S S S H H H H H',
      14: 'S S S S S H H H H H', 15: 'S S S S S H H H H H', 16: 'S S S S S H H H H H', 17: 'S S S S S S S S S S',
    },
    soft: {
      13: 'H H H Dh Dh H H H H H', 14: 'H H H Dh Dh H H H H H', 15: 'H H Dh Dh Dh H H H H H',
      16: 'H H Dh Dh Dh H H H H H', 17: 'H Dh Dh Dh Dh H H H H H', 18: 'S Ds Ds Ds Ds S S H H H',
      19: 'S S S S S S S S S S', 20: 'S S S S S S S S S S',
    },
    pair: {
      1: 'P P P P P P P P P P', 2: 'P P P P P P - - - -', 3: 'P P P P P P - - - -', 4: '- - - P P - - - - -',
      5: '- - - - - - - - - -', 6: 'P P P P P - - - - -', 7: 'P P P P P P - - - -', 8: 'P P P P P P P P P P',
      9: 'P P P P P - P P - -', 10: '- - - - - - - - - -',
    },
  };
  test('6D S17 DAS NS chart matches the textbook chart cell for cell', () => {
    const { chart } = BJ.analyzeRules(SOLVER_RULES_6D);
    const wrong = [];
    for (const kind in ORACLE) for (const row in ORACLE[kind]) {
      ORACLE[kind][row].split(' ').forEach((want, i) => {
        const got = chart[kind][row][UPS[i]] || '-';
        if (got !== want) wrong.push(`${kind} ${row} v ${UPS[i] === 1 ? 'A' : UPS[i]}: ${got} (want ${want})`);
      });
    }
    eq(wrong, []);
  });
  test('H17 with late surrender adds the known H17/LS plays', () => {
    const { chart } = BJ.analyzeRules({ decks: 6, h17: true, das: true, lateSurrender: true });
    const at = (kind, row, up) => chart[kind][row][up];
    eq(at('hard', 11, 1), 'Dh', '11 v A doubles in H17');
    eq(at('soft', 19, 6), 'Ds', 'A8 v 6 doubles in H17');
    eq(at('soft', 18, 2), 'Ds', 'A7 v 2 doubles in H17');
    eq(at('hard', 15, 1), 'Rh', 'surrender 15 v A');
    eq(at('hard', 17, 1), 'Rs', 'surrender 17 v A');
    eq(at('hard', 16, 10), 'Rh', 'surrender 16 v 10');
    eq(at('hard', 15, 10), 'Rh', 'surrender 15 v 10');
    eq(at('pair', 8, 1), 'Rp', 'surrender 8,8 v A, else split');
  });
  test('basicAction falls back correctly when an option is not allowed', () => {
    const { chart } = BJ.analyzeRules(SOLVER_RULES_6D);
    const all = { hit: true, stand: true, double: true, split: true, surrender: false };
    const noDouble = Object.assign({}, all, { double: false, split: false });
    eq(BJ.basicAction(chart, [1, 7], 3, all), 'double');
    eq(BJ.basicAction(chart, [1, 7], 3, noDouble), 'stand', 'Ds → stand');
    eq(BJ.basicAction(chart, [6, 5], 6, noDouble), 'hit', 'Dh → hit');
    eq(BJ.basicAction(chart, [8, 8], 10, all), 'split');
    eq(BJ.basicAction(chart, [8, 8], 10, noDouble), 'hit', 'max hands reached: play 16');
    eq(BJ.basicAction(chart, [5, 4, 3], 4, noDouble), 'stand', 'multi-card 12 v 4');
  });
});

group('Stage 2 · counts, deviations and betting', () => {
  test('hard 16 vs 10 stands at positive counts and hits at negative ones (exact solver)', () => {
    const legal = { hit: true, stand: true, double: false, split: false, surrender: false };
    for (const [rc, want] of [[12, 'stand'], [24, 'stand'], [-12, 'hit']]) {
      const c = shoeWithCount(6, rc);
      c[10]--; c[10]--; c[6]--;                   // the up card and the player's 10,6
      const tc = rc / (c.reduce((a, b) => a + b, 0) / 52);
      const a = BJ.analyzeHand(SOLVER_RULES_6D, c, 10, [10, 6], legal);
      eq(a.best, want, `TC ${tc.toFixed(1)}: stand ${a.ev.stand.toFixed(4)} vs hit ${a.ev.hit.toFixed(4)}`);
    }
  });
  const chart = BJ.analyzeRules(SOLVER_RULES_6D).chart;
  const rec = (cards, up, tc, extra = {}) => BJ.recommend({
    chart, rules: Object.assign({}, SOLVER_RULES_6D, extra.rules || {}), cards, up, tc,
    legal: Object.assign({ hit: true, stand: true, double: cards.length === 2, split: cards.length === 2 && cards[0] === cards[1], surrender: false }, extra.legal || {}),
  });
  test('16 vs 10: the index play overrides basic strategy at TC >= 0', () => {
    let r = rec([10, 6], 10, 0.5);
    eq([r.action, r.basic, r.deviation, r.play.id], ['stand', 'hit', true, '16v10']);
    r = rec([10, 6], 10, -0.5);
    eq([r.action, r.deviation], ['hit', false]);
    r = rec([4, 5, 7], 10, 2);
    eq(r.action, 'stand', 'multi-card 16 too');
  });
  test('other Illustrious 18 plays', () => {
    eq(rec([10, 2], 3, 2).action, 'stand', '12 v 3 at +2');
    eq(rec([10, 2], 3, 1.9).action, 'hit', '12 v 3 below +2');
    eq(rec([10, 2], 4, -0.1).action, 'hit', '12 v 4 below 0');
    eq(rec([6, 4], 10, 4).action, 'double', '10 v 10 at +4');
    eq(rec([3, 3, 4], 10, 5).action, 'hit', 'three-card 10 cannot double');
    eq(rec([10, 10], 6, 4).action, 'split', 'T,T v 6 at +4');
    eq(rec([10, 10], 6, 3).action, 'stand', 'T,T v 6 at +3');
    eq(rec([8, 8], 10, 3).action, 'split', '8,8 is split, not played as 16');
    eq(rec([6, 5], 1, 1).action, 'double', '11 v A at +1 (S17)');
    eq(rec([6, 5], 1, 0).action, 'hit', '11 v A at 0 (S17)');
  });
  test('Fab 4 surrenders', () => {
    const ls = { rules: { lateSurrender: true }, legal: { surrender: true } };
    eq(rec([10, 4], 10, 3, ls).action, 'surrender', '14 v 10 at +3');
    eq(rec([10, 4], 10, 2, ls).action, 'hit', '14 v 10 at +2');
    eq(rec([10, 5], 9, 2, ls).action, 'surrender', '15 v 9 at +2');
    const lsChart = BJ.analyzeRules(Object.assign({}, SOLVER_RULES_6D, { lateSurrender: true })).chart;
    const r = BJ.recommend({ chart: lsChart, rules: Object.assign({}, SOLVER_RULES_6D, { lateSurrender: true }), cards: [10, 5], up: 10, tc: -1,
                             legal: { hit: true, stand: true, double: true, split: false, surrender: true } });
    eq([r.basic, r.action, r.deviation], ['surrender', 'hit', true], '15 v 10 below 0: don’t surrender');
  });
  test('insurance: EV is zero at exactly one-third tens; take it at TC +3', () => {
    const c = new Array(11).fill(0); c[10] = 10; c[5] = 20;
    near(BJ.insuranceEV(c), 0, 1e-12);
    eq([BJ.insuranceAdvice(3).take, BJ.insuranceAdvice(2.9).take], [true, false]);
  });
  test('true count and running count', () => {
    eq(BJ.runningCount([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10]), 0, 'one of each rank balances');
    eq(BJ.runningCount([2, 2, 10]), 1);
    eq(BJ.trueCount(6, 156), 2);
  });
  test('Kelly bet ramp: minimum without an edge, rises with the count, capped by the table', () => {
    const opts = { bankroll: 50000, baseEdge: -0.004, fraction: 0.5, minBet: 10, maxBet: 500 };
    const ramp = BJ.betRamp(opts, -2, 12);
    eq(ramp.filter(r => r.tc <= 0).map(r => r.bet), [10, 10, 10], 'no edge → minimum');
    for (let i = 1; i < ramp.length; i++) assert(ramp[i].bet >= ramp[i - 1].bet, 'monotonic');
    const tc4 = ramp.find(r => r.tc === 4);
    near(tc4.edge, 0.016, 1e-12);
    near(tc4.raw, opts.bankroll * 0.5 * 0.016 / BJ.HAND_VARIANCE, 1e-9);
    eq(tc4.bet, Math.floor(tc4.raw / 10) * 10);
    eq(ramp[ramp.length - 1].bet, 500, 'capped at the table maximum');
  });
});

/* ============================================================================
 * STAGE 3: counting systems and drills
 * ========================================================================== */

group('Stage 3 · counting systems', () => {
  const oneDeck = () => new BJ.Shoe(1, 1, BJ.seededRandomInt(5)).cards;
  test('every balanced system sums to exactly zero over a full deck (and a full 6-deck shoe)', () => {
    for (const s of Object.values(BJ.COUNT_SYSTEMS)) {
      if (!s.balanced) continue;
      eq(BJ.runningCount(oneDeck(), s.tags), 0, `${s.name}, one deck`);
      eq(BJ.runningCount(new BJ.Shoe(6, 1).cards, s.tags), 0, `${s.name}, six decks`);
    }
  });
  test('KO is unbalanced by +4 per deck; from its IRC a full shoe ends exactly at the +4 pivot', () => {
    const ko = BJ.COUNT_SYSTEMS.ko;
    eq(BJ.runningCount(oneDeck(), ko.tags), 4);
    for (const d of [1, 2, 4, 6, 8]) {
      const irc = BJ.initialRunningCount(ko, d);
      eq(irc, -4 * (d - 1), `IRC for ${d} decks`);
      eq(irc + BJ.runningCount(new BJ.Shoe(d, 1).cards, ko.tags), 4, `end of a ${d}-deck shoe`);
    }
  });
  test('tag values match the published systems', () => {
    // Columns: A 2 3 4 5 6 7 8 9 T
    const want = {
      hilo:   [-1, 1, 1, 1, 1, 1, 0, 0, 0, -1],
      ko:     [-1, 1, 1, 1, 1, 1, 1, 0, 0, -1],
      omega2: [0, 1, 1, 2, 2, 2, 1, 0, -1, -2],
      zen:    [-1, 1, 1, 2, 2, 2, 1, 0, 0, -2],
      halves: [-1, 0.5, 1, 1, 1.5, 1, 0.5, 0, -0.5, -1],
    };
    for (const id in want) eq(BJ.COUNT_SYSTEMS[id].tags.slice(1), want[id], id);
  });
  test('running count with real cards and with a counts array agree', () => {
    const cards = BJ.drawCards(150, BJ.seededRandomInt(11));
    const counts = new Array(11).fill(0);
    for (const c of cards) counts[c.v]++;
    for (const s of Object.values(BJ.COUNT_SYSTEMS)) eq(BJ.runningCountOfCounts(counts, s.tags), BJ.runningCount(cards, s.tags), s.name);
  });
  test('decks-remaining estimator: exact, half-deck and whole-deck rounding', () => {
    eq(BJ.estimateDecks(156, 'exact'), 3);
    eq(BJ.estimateDecks(170, 'half'), 3.5);      // 3.27 decks → 3.5
    eq(BJ.estimateDecks(160, 'half'), 3);        // 3.08 → 3
    eq(BJ.estimateDecks(170, 'full'), 3);
    eq(BJ.estimateDecks(10, 'half'), 0.5, 'never below half a deck');
    eq(BJ.estimateDecks(5, 'exact'), 0.25, 'exact floors at a quarter deck');
  });
  test('count state: balanced TC = RC / decks; KO TC subtracts the expected drift', () => {
    const hl = BJ.countState(BJ.COUNT_SYSTEMS.hilo, 6, 156, 312);
    eq([hl.rc, hl.tc, hl.hiLoTC], [6, 2, 2]);
    const zen = BJ.countState(BJ.COUNT_SYSTEMS.zen, 8, 104, 312);
    eq([zen.tc, zen.hiLoTC], [4, 2], 'level-2 systems are rescaled by ½ for Hi-Lo indices');
    // KO: deal exactly one complete deck out of two. Balanced-equivalent TC must be 0.
    const ko = BJ.COUNT_SYSTEMS.ko;
    const tagSum = BJ.runningCount(oneDeck(), ko.tags);     // +4
    const st = BJ.countState(ko, tagSum, 52, 104);
    eq([st.rc, st.tc], [0, 0], 'RC = IRC(−4) + 4 = 0, TC = 0');
  });
});

group('Stage 3 · drill generators', () => {
  test('removedForCount hits the requested Hi-Lo count and card total', () => {
    const rnd = BJ.seededRandomInt(9);
    for (let i = 0; i < 300; i++) {
      const decks = [1, 2, 6, 8][i % 4];
      const dealt = 10 + rnd(Math.floor(decks * 52 * 0.7));
      const rc = rnd(21) - 10;
      const removed = BJ.removedForCount(decks, dealt, rc, rnd);
      const full = BJ.fullShoeCounts(decks);
      eq(removed.reduce((a, b) => a + b, 0), dealt, 'cards removed');
      eq(BJ.runningCountOfCounts(removed), rc, `Hi-Lo RC (${decks}D, ${dealt} dealt)`);
      for (let v = 1; v <= 10; v++) assert(removed[v] <= full[v], 'never removes more than exist');
    }
  });
  test('strategy-drill scenarios are valid for every focus', () => {
    const rnd = BJ.seededRandomInt(10);
    for (const focus of ['all', 'hard', 'soft', 'pair', 'index']) {
      for (let i = 0; i < 200; i++) {
        const rules = BJ.normalizeRules({ decks: [1, 2, 6, 8][i % 4], lateSurrender: i % 2 === 0 });
        const s = BJ.drillScenario(rules, focus, rnd);
        const unseen = s.counts.reduce((a, b) => a + b, 0);
        eq(unseen + s.dealt + 1 + s.cards.length, 52 * rules.decks, 'all cards accounted for');
        assert(s.counts.every(c => c >= 0), 'composition is non-negative');
        const { total, soft } = BJ.handValue(s.cards);
        assert(total < 21 || s.cards.length !== 2 || !(s.cards.includes(1) && s.cards.includes(10)), 'no naturals');
        if (focus === 'hard') assert(!soft && s.cards[0] !== s.cards[1], 'hard, not a pair');
        if (focus === 'soft') assert(s.cards.includes(1) && soft, 'soft');
        if (focus === 'pair') eq(s.cards[0], s.cards[1], 'pair');
        if (focus === 'index') {
          assert(s.play && s.up === s.play.up, 'up card matches the index play');
          if (s.play.pair) eq(s.cards, [s.play.pair, s.play.pair]); else eq(total, s.play.hard, 'hand total matches');
          assert(s.play.at !== 'surrender' || rules.lateSurrender, 'surrender plays only when allowed');
        }
      }
    }
  });
  test('index drill spans both sides of the index', () => {
    const rnd = BJ.seededRandomInt(12);
    const rules = BJ.normalizeRules({ decks: 6 });
    let above = 0, below = 0;
    for (let i = 0; i < 300; i++) {
      const s = BJ.drillScenario(rules, 'index', rnd);
      const seen = s.removed.slice(); seen[s.up]++; for (const v of s.cards) seen[v]++;
      const st = BJ.countState(BJ.COUNT_SYSTEMS.hilo, BJ.runningCountOfCounts(seen), s.counts.reduce((a, b) => a + b, 0), 312);
      if (st.tc >= BJ.indexValue(s.play, rules)) above++; else below++;
    }
    assert(above > 60 && below > 60, `above ${above}, below ${below}`);
  });
  test('drawCards returns real cards in shoe proportions', () => {
    const cards = BJ.drawCards(520, BJ.seededRandomInt(13));
    eq(cards.length, 520);
    eq(cards.filter(c => c.v === 10).length, 160, '10 decks → 160 ten-valued cards');
    eq(BJ.runningCount(cards), 0, 'a whole number of decks balances');
  });
});

/* ============================================================================
 * STAGE 4: stats, spaced repetition, simulator
 * ========================================================================== */

group('Stage 4 · spaced repetition (mistake log)', () => {
  const rec = (correct, extra = {}) => Object.assign({ kind: 'play', cards: [10, 6], type: 'hard', up: 10, label: 'Hard 16',
    tc: 0.5, recommended: 'stand', indexId: '16v10', correct, cost: correct ? 0 : 0.01 }, extra);
  test('keys identify the situation, not the exact cards', () => {
    eq(BJ.srsKey(rec(false)), 'H16v10:16v10');
    eq(BJ.srsKey(rec(false, { cards: [7, 9] })), 'H16v10:16v10', 'same class');
    eq(BJ.srsKey(rec(false, { cards: [8, 8], type: 'pair', indexId: null })), 'P8v10');
    eq(BJ.srsKey(rec(false, { cards: [1, 7], type: 'soft', up: 3, indexId: null })), 'S18v3');
  });
  test('a mistake is due at once; right answers push it out 10 min, 1 h, 1 day …; a new mistake resets it', () => {
    const deck = {}, t0 = 1e12;
    BJ.srsRecord(deck, rec(false), t0);
    const item = deck['H16v10:16v10'];
    eq([item.box, item.wrong, item.due], [0, 1, t0]);
    eq(BJ.srsDue(deck, t0).length, 1);
    BJ.srsRecord(deck, rec(true), t0 + 1);
    eq([item.box, item.due], [1, t0 + 1 + BJ.SRS_INTERVALS[1]]);
    eq(BJ.srsDue(deck, t0 + 2).length, 0, 'not due for 10 minutes');
    BJ.srsRecord(deck, rec(true), t0 + 5);             // right again, but not due: no promotion
    eq(item.box, 1);
    BJ.srsRecord(deck, rec(true), item.due);
    eq(item.box, 2);
    BJ.srsRecord(deck, rec(false), item.due + 1);
    eq([item.box, item.wrong], [0, 2]);
  });
  test('correct answers on hands never missed do not create entries; review order is hardest first', () => {
    const deck = {}, t = 1e12;
    BJ.srsRecord(deck, rec(true, { up: 9 }), t);
    eq(Object.keys(deck).length, 0);
    BJ.srsRecord(deck, rec(false, { up: 9, indexId: null }), t);
    BJ.srsRecord(deck, rec(false, { up: 7, indexId: null }), t);
    BJ.srsRecord(deck, rec(false, { up: 7, indexId: null }), t + 1);
    eq(BJ.srsDue(deck, t + 2).map(i => i.key), ['H16v7', 'H16v9'], 'missed twice comes first');
  });
  test('drillScenarioFor rebuilds the same hand at about the same count', () => {
    const rules = BJ.normalizeRules({ decks: 6 });
    const s = BJ.drillScenarioFor(rules, [10, 6], 10, 2, BJ.seededRandomInt(3));
    eq([s.cards, s.up], [[10, 6], 10]);
    const seen = s.removed.slice(); seen[10] += 2; seen[6]++;
    const st = BJ.countState(BJ.COUNT_SYSTEMS.hilo, BJ.runningCountOfCounts(seen), s.counts.reduce((a, b) => a + b, 0), 312);
    near(st.tc, 2, 0.6, 'true count');
  });
});

group('Stage 4 · stats summary', () => {
  test('accuracy by type, basic vs index situations, costliest mistakes', () => {
    const recs = [
      { kind: 'play', type: 'hard', cards: [10, 6], up: 10, label: 'Hard 16', indexId: '16v10', deviation: true, correct: false, cost: 0.02 },
      { kind: 'play', type: 'hard', cards: [10, 2], up: 4, label: 'Hard 12', indexId: '12v4', deviation: false, correct: true, cost: 0 },
      { kind: 'play', type: 'soft', cards: [1, 7], up: 9, label: 'Soft 18', indexId: null, deviation: false, correct: false, cost: 0.15 },
      { kind: 'play', type: 'pair', cards: [8, 8], up: 10, label: 'Pair of 8s', indexId: null, deviation: false, correct: true, cost: 0 },
      { kind: 'insurance', type: 'insurance', up: 1, label: 'Insurance', indexId: 'ins', deviation: false, correct: true, cost: 0 },
    ];
    const s = BJ.summarizeDecisions(recs);
    eq([s.all.n, s.all.ok], [5, 3]);
    eq([s.basic.n, s.basic.ok], [2, 1]);
    eq([s.index.n, s.index.ok], [3, 2]);
    eq([s.deviation.n, s.deviation.ok], [1, 0]);
    eq([s.byType.hard.n, s.byType.hard.ok, s.byType.soft.ok, s.byType.pair.ok, s.byType.insurance.ok], [2, 1, 0, 1, 1]);
    near(s.evLost, 0.17, 1e-12);
    eq(s.costly.map(r => r.label), ['Soft 18', 'Hard 16']);
    eq(s.bySituation[0].key, 'S18v9');
  });
});

group('Stage 4 · simulator', () => {
  test('risk of ruin formula', () => {
    near(BJ.riskOfRuin(0.01, 1.3, 100), Math.exp(-2 * 0.01 * 100 / 1.3), 1e-15);
    eq(BJ.riskOfRuin(0, 1, 100), 1, 'no edge: certain ruin');
    eq(BJ.riskOfRuin(-0.01, 1, 100), 1);
  });
  test('bet ramps: flat, 1–8 spread, Kelly', () => {
    const rules = BJ.normalizeRules({ minBet: 10, maxBet: 500 });
    const spread = BJ.makeBetFn({ mode: 'spread', spread: 8 }, rules, 0.005);
    eq([-2, 0, 1, 1.9, 2, 3, 4, 5, 9].map(spread), [10, 10, 10, 10, 20, 40, 60, 80, 80]);
    eq(BJ.makeBetFn({ mode: 'flat' }, rules, 0.005)(6), 10);
    const kelly = BJ.makeBetFn({ mode: 'kelly', bankroll: 20000, kellyFraction: 0.5 }, rules, 0.005);
    eq(kelly(4), BJ.kellyBet({ tc: 4, bankroll: 20000, baseEdge: -0.005, fraction: 0.5, minBet: 10, maxBet: 500 }).bet);
  });
  test('flat-bet basic strategy reproduces the computed house edge (1,000,000 hands, within 3 standard errors)', () => {
    const r = BJ.simulate({ rules: SOLVER_RULES_6D, hands: 1000000, seed: 77, indexPlays: false });
    const z = (r.gameEV - -r.analyticHouseEdge) / r.gameSE;
    assert(Math.abs(z) < 3, `simulated ${(r.gameEV * 100).toFixed(3)}% ± ${(r.gameSE * 100).toFixed(3)}%, solver ${(-r.analyticHouseEdge * 100).toFixed(3)}% (z = ${z.toFixed(2)})`);
    near(r.unitSD, 1.15, 0.02, 'standard deviation per hand ≈ 1.15 bets');
  });
  test('counting works: the edge rises with the true count, and a 1–8 spread beats flat betting', () => {
    const r = BJ.simulate({ rules: SOLVER_RULES_6D, hands: 400000, seed: 78, indexPlays: true,
                            betting: { mode: 'spread', spread: 8 }, bankroll: 10000 });
    const pool = rows => { const n = rows.reduce((s, b) => s + b.n, 0); return rows.reduce((s, b) => s + b.edge * b.n, 0) / n; };
    const low = pool(r.byCount.filter(b => b.tc <= -1)), high = pool(r.byCount.filter(b => b.tc >= 3));
    assert(high - low > 0.02, `edge at TC ≤ −1: ${(low * 100).toFixed(2)}%, at TC ≥ +3: ${(high * 100).toFixed(2)}%`);
    assert(r.playerEdge > r.gameEV + 0.004, `spread edge ${(r.playerEdge * 100).toFixed(2)}% vs flat ${(r.gameEV * 100).toFixed(2)}%`);
    assert(r.riskOfRuin > 0 && r.riskOfRuin < 1, 'risk of ruin is a probability');
    near(r.hourly, r.evRound * 80, 1e-9, 'hourly = EV per round × rounds per hour');
  });
  test('wonging out skips negative counts', () => {
    const r = BJ.simulate({ rules: SOLVER_RULES_6D, hands: 50000, seed: 79, wongOut: 0, betting: { mode: 'flat' } });
    assert(r.betRounds < r.rounds * 0.75, `bet ${r.betRounds} of ${r.rounds} rounds`);
  });
});

/* ---------------- run ---------------- */
const t0 = Date.now();
for (const gr of groups) {
  if (filter && !gr.name.toLowerCase().includes(filter)) continue;
  current = [];
  gr.fn();
  console.log(`\n${gr.name}`);
  for (const t of current) {
    const start = Date.now();
    try {
      t.fn();
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${t.name} \x1b[2m(${Date.now() - start} ms)\x1b[0m`);
    } catch (e) {
      failed++;
      console.log(`  \x1b[31m✗ ${t.name}\x1b[0m\n      ${e instanceof AssertionError ? e.message : e.stack}`);
    }
  }
}
console.log(`\n${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
