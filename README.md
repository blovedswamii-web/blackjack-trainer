# Blackjack Trainer

A blackjack game that teaches basic strategy, card counting and count-based
play. Everything is in one file, `blackjack-trainer.html`: no frameworks, no
downloads, no network access (a Content-Security-Policy blocks it). Open it in
any modern browser and it works offline.

Play money only. There is no real-money or gambling functionality.

## Files

| File | What it is |
|---|---|
| `blackjack-trainer.html` | The whole app. The engine is in `<script id="bj-engine">`, the UI in `<script id="bj-app">`. |
| `test.js` | Unit tests. Pulls the engine block out of the HTML and runs it under Node. |
| `README.md` | This file. |

## Using it

**Play tab.** Deal with <kbd>Space</kbd>, then <kbd>H</kbd> hit, <kbd>S</kbd> stand,
<kbd>D</kbd> double, <kbd>P</kbd> split, <kbd>R</kbd> surrender, <kbd>I</kbd>/<kbd>N</kbd> for
insurance, <kbd>↑</kbd>/<kbd>↓</kbd> to change the bet. Pick a training mode in the
Count & bet panel:

- **Free play:** the count is hidden; press <kbd>C</kbd> to type your running count and check it.
- **Guided:** the count is shown, each card shows its tag, and the Why panel gives advice before every decision.
- **Test:** the count is hidden and you're asked for it (timed) after each round, or at random.

The **Why** panel shows the right play, whether an index play (count-based
deviation) applies, and the exact EV of every option. Every decision is graded.
**Distractions** adds generated casino noise, table chatter and slow, uneven dealing.

**Drills tab.** Strategy drill (all hands, hard, soft, pairs, index plays, or
*review mistakes*), speed count (cards flash at a set speed, optional pairs
mode), and true count (estimate decks left from a discard tray).

**Strategy tab.** The basic-strategy chart computed for your rules, the house
edge, the Illustrious 18 and Fab 4 index plays, and a Kelly bet ramp.

**Stats tab.** Session and all-time accuracy by hand type, index plays, counting
accuracy and speed, the costliest mistakes, a bankroll chart, and the mistake
log. Mistakes come back on a spaced-repetition schedule (10 min, 1 h, 1 day,
3 days, 1 week, 3 weeks); a new mistake resets the hand.

**Simulator tab.** Plays 100k–1M hands in a Web Worker with your rules, counting
system, playing strategy and bet ramp, and reports the house edge, your edge
(with 95% intervals), standard deviation, hourly win, risk of ruin and the edge
at each true count.

**Rules tab.** Every table rule, trainer settings (deck-estimate precision,
dealing speed, test frequency), and JSON export/import. Settings, bankroll and
stats are saved in `localStorage`; if storage is unavailable the app still works,
it just forgets on reload.

## How the solver works

No strategy tables are typed in. Everything comes from expected values (EV)
computed from the composition of the unseen cards (`CompSolver` in the engine).

1. **Dealer outcomes.** For an up card, the dealer's possible draws form a graph
   built once and reused. A state is the *multiset* of cards drawn, not their
   order, because the same cards give the same total and leave the same shoe.
   For a given composition, one backward pass over that graph gives the
   probability of the dealer finishing on 17–21 or busting. With an ace or ten
   up the hole card is conditioned on "no blackjack" (the dealer has peeked).
2. **Stand** compares your total against that distribution.
3. **Hit** averages, over every possible next card, max(stand, hit again).
   Results are cached by the multiset of your cards.
4. **Double** = one card, then stand, at twice the stake.
5. **Split** is the one approximation (as in most analyzers): one post-split hand
   is solved exactly with the other split card removed, then a small recursive
   calculation over "hands still to deal / hands on the table" decides, each time a pair comes
   up again, whether to resplit or play on, up to the max-hands rule.

Running this for every up card and every two-card hand, weighted by probability,
gives the house edge; grouping by total gives the basic-strategy chart. A live
decision takes 1–50 ms, and a full rule-set analysis about 0.6 s (then cached).
The tests check the house edge against published values (6D S17 DAS: 0.40%;
8D: 0.43%; 6D H17: 0.62%) and the chart against the textbook chart, cell by cell.

**Index plays** (Hi-Lo Illustrious 18 and Fab 4) override basic strategy when the
true count crosses the index. For other systems the Hi-Lo indices are rescaled
by the system's `scale` (×2 for Omega II and Zen). This is an approximation;
for exact numbers use your system's published index tables.

**Bets** use edge ≈ (edge off the top) + 0.5% per true count, and Kelly:
bet = bankroll × fraction × edge ÷ 1.3 (the variance of one hand).

## Adding a counting system

Add an entry to `COUNT_SYSTEMS` in the engine (`blackjack-trainer.html`):

```js
myCount: {
  id: 'myCount', name: 'My Count', level: 1, balanced: true, scale: 1,
  //     _   A   2  3  4  5  6  7  8  9  T
  tags: [0, -1,  1, 1, 1, 1, 1, 0, 0, 0, -1],
  about: 'One line shown on the reference card.',
},
```

- `tags[v]` is the tag for card value `v` (1 = ace … 10 = any ten-valued card; slot 0 unused).
- `balanced: false` needs `perDeck` (how much a full deck adds). The count then starts
  at −perDeck × (decks − 1), like KO.
- `scale` converts its true count to the Hi-Lo scale (≈ 1 for level-1 systems, ½ for level 2).

It appears in the system menu, the reference card, the drills and the simulator
automatically. `node test.js` checks that a balanced system sums to zero over a deck.

## Tests

```bash
node test.js
```

Node 18+ and no dependencies. `node test.js solver`, for example, runs only the
groups whose name contains "solver". There are 78 tests, covering the shuffle (chi-square
uniformity with `crypto.getRandomValues`), rules, payouts, invariants over random play,
the solver against naive reference implementations and published numbers, the counting
systems, the drill generators, spaced repetition and the simulator (1M hands must land
within 3 standard errors of the solver's house edge).

## Limits worth knowing

- One player at the table, US rules (dealer peeks, late surrender only, no hitting split aces).
- Insurance is offered as a side bet for half the main bet; even money is that same bet when you have blackjack.
- The simulator's risk of ruin uses the standard formula, which assumes a fixed bet ramp (no resizing as the bankroll changes).
