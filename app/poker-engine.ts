export type Suit = "spades" | "hearts" | "diamonds" | "clubs";
export type Rank = "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K" | "A";

export interface Card {
  rank: Rank;
  suit: Suit;
}

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";
export type PokerAction = "fold" | "check" | "call" | "wagerTo";

export interface Player {
  id: number;
  slot: number;
  name: string;
  isHuman: boolean;
  avatar: string;
  accent: string;
  stack: number;
  hole: Card[];
  folded: boolean;
  allIn: boolean;
  streetBet: number;
  totalBet: number;
  lastAction: string;
}

export interface GameState {
  players: Player[];
  board: Card[];
  deck: Card[];
  street: Street;
  dealer: number;
  smallBlind: number;
  bigBlind: number;
  currentBet: number;
  lastRaise: number;
  pending: number[];
  acted: number[];
  handNo: number;
  seed: number;
  log: string[];
  winners: number[];
  result: string;
  lastPot: number;
}

export interface HandResult {
  score: number[];
  name: string;
  cards: Card[];
}

export interface BotDecision {
  action: PokerAction;
  target?: number;
}

export const SMALL_BLIND = 5;
export const BIG_BLIND = 5;
export const STARTING_STACK = 1000;

const RANKS: Rank[] = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS: Suit[] = ["spades", "hearts", "diamonds", "clubs"];

const PLAYER_PROFILES = [
  { name: "你", avatar: "YOU", accent: "#d3a65c" },
  { name: "MOSS", avatar: "M", accent: "#6f8e84" },
  { name: "夏野", avatar: "夏", accent: "#a26f55" },
  { name: "RAY", avatar: "R", accent: "#687b9f" },
  { name: "林墨", avatar: "林", accent: "#7f6e91" },
  { name: "七喜", avatar: "7", accent: "#8b805e" },
  { name: "阿港", avatar: "港", accent: "#5d8575" },
  { name: "NEO", avatar: "N", accent: "#8e665d" },
  { name: "DORA", avatar: "D", accent: "#697a89" },
];

const SLOT_MAP: Record<number, number[]> = {
  2: [0, 5],
  3: [0, 4, 6],
  4: [0, 3, 5, 7],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 7, 8],
  7: [0, 1, 3, 4, 5, 7, 8],
  8: [0, 1, 2, 3, 5, 6, 7, 8],
  9: [0, 1, 2, 3, 4, 5, 6, 7, 8],
};

const STREET_LABELS: Record<Street, string> = {
  preflop: "翻牌前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
  showdown: "摊牌",
};

function nextSeed(seed: number): number {
  return (Math.imul(seed >>> 0, 1664525) + 1013904223) >>> 0;
}

function randomFromSeed(seed: number): [number, number] {
  const next = nextSeed(seed);
  return [next / 4294967296, next];
}

export function createStandardDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}

function shuffle(seed: number): { deck: Card[]; seed: number } {
  const deck = createStandardDeck();
  let cursor = seed >>> 0;

  for (let index = deck.length - 1; index > 0; index -= 1) {
    const [roll, next] = randomFromSeed(cursor);
    cursor = next;
    const swapIndex = Math.floor(roll * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }

  return { deck, seed: cursor };
}

function clockwiseAfter(players: Player[], index: number): number[] {
  return Array.from({ length: players.length }, (_, offset) => (index + 1 + offset) % players.length);
}

function nextFunded(players: Player[], index: number): number {
  return clockwiseAfter(players, index).find((candidate) => players[candidate].stack > 0) ?? index;
}

function isActionable(player: Player): boolean {
  return !player.folded && !player.allIn && player.stack > 0;
}

function pay(player: Player, amount: number): number {
  const paid = Math.max(0, Math.min(amount, player.stack));
  player.stack -= paid;
  player.streetBet += paid;
  player.totalBet += paid;
  player.allIn = player.stack === 0;
  return paid;
}

function appendLog(log: string[], entry: string): string[] {
  return [...log, entry].slice(-12);
}

function dealPreparedHand(
  basePlayers: Player[],
  dealer: number,
  handNo: number,
  sourceDeck: Card[],
  seed: number,
): GameState {
  const refreshed = basePlayers.map((player) => ({
    ...player,
    stack: player.stack === 0 ? STARTING_STACK : player.stack,
    hole: [] as Card[],
    folded: false,
    allIn: false,
    streetBet: 0,
    totalBet: 0,
    lastAction: "等待",
  }));
  const deck = sourceDeck.map((card) => ({ ...card }));

  for (let round = 0; round < 2; round += 1) {
    for (const playerIndex of clockwiseAfter(refreshed, dealer)) {
      const card = deck.pop();
      if (card) refreshed[playerIndex].hole.push(card);
    }
  }

  const headsUp = refreshed.length === 2;
  const smallBlind = headsUp ? dealer : nextFunded(refreshed, dealer);
  const bigBlind = nextFunded(refreshed, smallBlind);
  const smallPaid = pay(refreshed[smallBlind], SMALL_BLIND);
  const bigPaid = pay(refreshed[bigBlind], BIG_BLIND);
  refreshed[smallBlind].lastAction = `小盲 ${smallPaid}`;
  refreshed[bigBlind].lastAction = `大盲 ${bigPaid}`;

  const pending = clockwiseAfter(refreshed, bigBlind).filter((index) => isActionable(refreshed[index]));
  const currentBet = Math.max(refreshed[smallBlind].streetBet, refreshed[bigBlind].streetBet);

  return {
    players: refreshed,
    board: [],
    deck,
    street: "preflop",
    dealer,
    smallBlind,
    bigBlind,
    currentBet,
    lastRaise: BIG_BLIND,
    pending,
    acted: [],
    handNo,
    seed,
    log: [
      `第 ${handNo} 手开始`,
      `${refreshed[smallBlind].name} 投入小盲 ${smallPaid}`,
      `${refreshed[bigBlind].name} 投入大盲 ${bigPaid}`,
    ],
    winners: [],
    result: "",
    lastPot: 0,
  };
}

export function dealHand(basePlayers: Player[], dealer: number, handNo: number, seed: number): GameState {
  const shuffled = shuffle(seed);
  return dealPreparedHand(basePlayers, dealer, handNo, shuffled.deck, shuffled.seed);
}

/**
 * Deals from an already shuffled deck. The multiplayer Worker uses this entry
 * point with a cryptographically shuffled deck, while local/demo games retain
 * the deterministic seeded `dealHand` behavior above.
 */
export function dealHandFromDeck(basePlayers: Player[], dealer: number, handNo: number, deck: Card[]): GameState {
  if (deck.length !== 52) throw new Error("A complete 52-card deck is required");
  return dealPreparedHand(basePlayers, dealer, handNo, deck, 0);
}

export function createTable(playerCount = 6, seed = 0x5f3759df): GameState {
  const count = Math.max(2, Math.min(9, Math.round(playerCount)));
  const slots = SLOT_MAP[count];
  const players = Array.from({ length: count }, (_, index): Player => ({
    id: index,
    slot: slots[index],
    name: PLAYER_PROFILES[index].name,
    isHuman: index === 0,
    avatar: PLAYER_PROFILES[index].avatar,
    accent: PLAYER_PROFILES[index].accent,
    stack: STARTING_STACK,
    hole: [],
    folded: false,
    allIn: false,
    streetBet: 0,
    totalBet: 0,
    lastAction: "等待",
  }));

  return dealHand(players, 0, 1, seed);
}

export function nextHand(state: GameState): GameState {
  const nextDealer = nextFunded(state.players, state.dealer);
  return dealHand(state.players, nextDealer, state.handNo + 1, nextSeed(state.seed));
}

export function potSize(state: GameState): number {
  return state.players.reduce((sum, player) => sum + player.totalBet, 0);
}

export function toCallFor(state: GameState, playerIndex: number): number {
  const player = state.players[playerIndex];
  return player ? Math.max(0, state.currentBet - player.streetBet) : 0;
}

export function maxTargetFor(state: GameState, playerIndex: number): number {
  const player = state.players[playerIndex];
  return player ? player.streetBet + player.stack : 0;
}

export function minimumRaiseTarget(state: GameState): number {
  return state.currentBet === 0 ? BIG_BLIND : state.currentBet + state.lastRaise;
}

export function canPlayerRaise(state: GameState, playerIndex: number): boolean {
  const player = state.players[playerIndex];
  if (!player || state.street === "showdown" || !isActionable(player)) return false;
  const responderExists = state.players.some(
    (opponent, index) => index !== playerIndex && !opponent.folded && !opponent.allIn && opponent.stack > 0,
  );
  return responderExists && maxTargetFor(state, playerIndex) > state.currentBet && !state.acted.includes(playerIndex);
}

function settleFoldWin(state: GameState, players: Player[]): GameState {
  const winnerIndex = players.findIndex((player) => !player.folded);
  const pot = players.reduce((sum, player) => sum + player.totalBet, 0);
  if (winnerIndex >= 0) {
    players[winnerIndex].stack += pot;
    players[winnerIndex].lastAction = `赢得 ${pot}`;
  }
  for (const player of players) {
    player.streetBet = 0;
    player.totalBet = 0;
  }
  const winnerName = winnerIndex >= 0 ? players[winnerIndex].name : "玩家";

  return {
    ...state,
    players,
    street: "showdown",
    pending: [],
    currentBet: 0,
    winners: winnerIndex >= 0 ? [winnerIndex] : [],
    result: `${winnerName} 收下底池，其他玩家均已弃牌`,
    lastPot: pot,
    log: appendLog(state.log, `${winnerName} 赢得 ${pot}`),
  };
}

export function forceFold(state: GameState, actor: number, label = "离桌弃牌"): GameState {
  if (state.street === "showdown") return state;
  const players = state.players.map((player) => ({ ...player, hole: [...player.hole] }));
  const player = players[actor];
  if (!player || player.folded) return state;
  player.folded = true;
  player.lastAction = label;
  const nextState: GameState = {
    ...state,
    players,
    pending: state.pending.filter((index) => index !== actor),
    acted: [...new Set([...state.acted, actor])],
    log: appendLog(state.log, `${player.name} ${label}`),
  };
  if (players.filter((candidate) => !candidate.folded).length === 1) {
    return settleFoldWin(nextState, players);
  }
  return nextState;
}

function sortedPending(players: Player[], actor: number, candidates: Set<number>): number[] {
  return clockwiseAfter(players, actor).filter((index) => candidates.has(index) && isActionable(players[index]));
}

export function applyAction(
  state: GameState,
  actor: number,
  action: PokerAction,
  requestedTarget?: number,
): GameState {
  if (state.street === "showdown" || state.pending[0] !== actor) return state;
  const players = state.players.map((player) => ({ ...player, hole: [...player.hole] }));
  const player = players[actor];
  if (!isActionable(player)) return state;

  const toCall = Math.max(0, state.currentBet - player.streetBet);
  let currentBet = state.currentBet;
  let lastRaise = state.lastRaise;
  let pending = state.pending.slice(1);
  let acted = [...state.acted];
  let logEntry = "";

  if (action === "fold") {
    player.folded = true;
    player.lastAction = "弃牌";
    logEntry = `${player.name} 弃牌`;
    acted = [...new Set([...acted, actor])];
  } else if (action === "check" && toCall === 0) {
    player.lastAction = "过牌";
    logEntry = `${player.name} 过牌`;
    acted = [...new Set([...acted, actor])];
  } else if (action === "call" || (action === "check" && toCall > 0)) {
    const paid = pay(player, toCall);
    player.lastAction = paid < toCall || player.allIn ? `全下 ${paid}` : `跟注 ${paid}`;
    logEntry = `${player.name} ${paid < toCall || player.allIn ? "全下" : "跟注"} ${paid}`;
    acted = [...new Set([...acted, actor])];
  } else if (action === "wagerTo") {
    const maximum = player.streetBet + player.stack;
    const target = Math.max(player.streetBet, Math.min(maximum, Math.round(requestedTarget ?? maximum)));

    if (target <= currentBet) {
      const paid = pay(player, toCall);
      player.lastAction = `全下 ${paid}`;
      logEntry = `${player.name} 全下 ${paid}`;
      acted = [...new Set([...acted, actor])];
    } else {
      const minimum = currentBet === 0 ? BIG_BLIND : currentBet + lastRaise;
      const isFullRaise = target >= minimum;
      if (!isFullRaise && target !== maximum) return state;

      const oldBet = currentBet;
      const paid = pay(player, target - player.streetBet);
      currentBet = player.streetBet;
      player.lastAction = player.allIn ? `全下至 ${currentBet}` : oldBet === 0 ? `下注 ${currentBet}` : `加注至 ${currentBet}`;
      logEntry = `${player.name} ${player.lastAction}`;

      if (isFullRaise) {
        lastRaise = oldBet === 0 ? currentBet : currentBet - oldBet;
        acted = [actor];
        pending = clockwiseAfter(players, actor).filter(
          (index) => index !== actor && isActionable(players[index]),
        );
      } else {
        acted = [...new Set([...acted, actor])];
        const candidates = new Set(pending);
        players.forEach((opponent, index) => {
          if (index !== actor && isActionable(opponent) && opponent.streetBet < currentBet) candidates.add(index);
        });
        pending = sortedPending(players, actor, candidates);
      }

      if (paid === 0) return state;
    }
  } else {
    return state;
  }

  const remaining = players.filter((candidate) => !candidate.folded);
  const nextState: GameState = {
    ...state,
    players,
    currentBet,
    lastRaise,
    pending,
    acted,
    seed: nextSeed(state.seed),
    log: appendLog(state.log, logEntry),
  };

  if (remaining.length === 1) return settleFoldWin(nextState, players);
  return nextState;
}

function drawStreet(state: GameState, street: Exclude<Street, "preflop" | "showdown">): GameState {
  const deck = [...state.deck];
  deck.pop();
  const drawCount = street === "flop" ? 3 : 1;
  const drawn: Card[] = [];
  for (let index = 0; index < drawCount; index += 1) {
    const card = deck.pop();
    if (card) drawn.push(card);
  }

  const players = state.players.map((player) => ({
    ...player,
    streetBet: 0,
    lastAction: player.folded ? "已弃牌" : player.allIn ? "已全下" : "等待",
  }));
  const pending = clockwiseAfter(players, state.dealer).filter((index) => isActionable(players[index]));

  return {
    ...state,
    players,
    board: [...state.board, ...drawn],
    deck,
    street,
    currentBet: 0,
    lastRaise: BIG_BLIND,
    pending,
    acted: [],
    log: appendLog(state.log, `进入${STREET_LABELS[street]}`),
  };
}

function runOutBoard(state: GameState): GameState {
  let next = state;
  if (next.board.length === 0) next = drawStreet(next, "flop");
  if (next.board.length === 3) next = drawStreet(next, "turn");
  if (next.board.length === 4) next = drawStreet(next, "river");
  return next;
}

function compareScores(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function rankValue(rank: Rank): number {
  return RANKS.indexOf(rank) + 2;
}

function evaluateFive(cards: Card[]): HandResult {
  const values = cards.map((card) => rankValue(card.rank)).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  const groups = [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0]);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const unique = [...new Set(values)];
  if (unique.includes(14)) unique.push(1);
  unique.sort((a, b) => b - a);
  let straightHigh = 0;
  for (let index = 0; index <= unique.length - 5; index += 1) {
    if (unique[index] - unique[index + 4] === 4) {
      straightHigh = unique[index];
      break;
    }
  }

  const score = (...parts: number[]) => [...parts, 0, 0, 0, 0, 0].slice(0, 6);
  if (flush && straightHigh) return { score: score(8, straightHigh), name: straightHigh === 14 ? "皇家同花顺" : "同花顺", cards };
  if (groups[0][1] === 4) return { score: score(7, groups[0][0], groups[1][0]), name: "四条", cards };
  if (groups[0][1] === 3 && groups[1]?.[1] === 2) return { score: score(6, groups[0][0], groups[1][0]), name: "葫芦", cards };
  if (flush) return { score: score(5, ...values), name: "同花", cards };
  if (straightHigh) return { score: score(4, straightHigh), name: "顺子", cards };
  if (groups[0][1] === 3) {
    const kickers = groups.filter((group) => group[1] === 1).map((group) => group[0]).sort((a, b) => b - a);
    return { score: score(3, groups[0][0], ...kickers), name: "三条", cards };
  }
  const pairs = groups.filter((group) => group[1] === 2).map((group) => group[0]).sort((a, b) => b - a);
  if (pairs.length >= 2) {
    const kicker = groups.find((group) => group[1] === 1)?.[0] ?? 0;
    return { score: score(2, pairs[0], pairs[1], kicker), name: "两对", cards };
  }
  if (pairs.length === 1) {
    const kickers = groups.filter((group) => group[1] === 1).map((group) => group[0]).sort((a, b) => b - a);
    return { score: score(1, pairs[0], ...kickers), name: "一对", cards };
  }
  return { score: score(0, ...values), name: "高牌", cards };
}

export function evaluateBest(cards: Card[]): HandResult {
  if (cards.length < 5) {
    return { score: [0, 0, 0, 0, 0, 0], name: "未成牌", cards: [...cards] };
  }

  let best: HandResult | null = null;
  for (let a = 0; a < cards.length - 4; a += 1) {
    for (let b = a + 1; b < cards.length - 3; b += 1) {
      for (let c = b + 1; c < cards.length - 2; c += 1) {
        for (let d = c + 1; d < cards.length - 1; d += 1) {
          for (let e = d + 1; e < cards.length; e += 1) {
            const candidate = evaluateFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareScores(candidate.score, best.score) > 0) best = candidate;
          }
        }
      }
    }
  }
  return best ?? { score: [0, 0, 0, 0, 0, 0], name: "未成牌", cards: [] };
}

function payoutShowdown(state: GameState): GameState {
  const players = state.players.map((player) => ({ ...player, hole: [...player.hole] }));
  const pot = players.reduce((sum, player) => sum + player.totalBet, 0);
  const results = new Map<number, HandResult>();
  players.forEach((player, index) => {
    if (!player.folded) results.set(index, evaluateBest([...player.hole, ...state.board]));
  });

  const levels = [...new Set(players.map((player) => player.totalBet).filter((bet) => bet > 0))].sort((a, b) => a - b);
  const payouts = new Map<number, number>();
  const trueWinners = new Set<number>();
  let previous = 0;

  for (const level of levels) {
    const contributors = players.map((player, index) => ({ player, index })).filter(({ player }) => player.totalBet >= level);
    const amount = (level - previous) * contributors.length;
    previous = level;
    if (amount <= 0) continue;

    if (contributors.length === 1) {
      const index = contributors[0].index;
      payouts.set(index, (payouts.get(index) ?? 0) + amount);
      continue;
    }

    const eligible = contributors.filter(({ player }) => !player.folded).map(({ index }) => index);
    if (eligible.length === 0) continue;
    let best = results.get(eligible[0])!;
    let winners = [eligible[0]];
    for (const index of eligible.slice(1)) {
      const comparison = compareScores(results.get(index)!.score, best.score);
      if (comparison > 0) {
        best = results.get(index)!;
        winners = [index];
      } else if (comparison === 0) {
        winners.push(index);
      }
    }

    const share = Math.floor(amount / winners.length);
    const remainder = amount % winners.length;
    winners.forEach((index) => {
      payouts.set(index, (payouts.get(index) ?? 0) + share);
      trueWinners.add(index);
    });
    const oddChipOrder = clockwiseAfter(players, state.dealer).filter((index) => winners.includes(index));
    for (let chip = 0; chip < remainder; chip += 1) {
      const index = oddChipOrder[chip % oddChipOrder.length];
      payouts.set(index, (payouts.get(index) ?? 0) + 1);
    }
  }

  players.forEach((player, index) => {
    const won = payouts.get(index) ?? 0;
    player.stack += won;
    player.streetBet = 0;
    player.totalBet = 0;
    player.lastAction = won > 0 ? `赢得 ${won}` : player.folded ? "已弃牌" : results.get(index)?.name ?? "摊牌";
  });

  const winners = [...trueWinners];
  const result = winners.length
    ? winners.map((index) => `${players[index].name} 以${results.get(index)?.name ?? "好牌"}赢得 ${payouts.get(index) ?? 0}`).join(" · ")
    : "本手牌已结算";

  return {
    ...state,
    players,
    street: "showdown",
    pending: [],
    currentBet: 0,
    winners,
    result,
    lastPot: pot,
    log: appendLog(state.log, result),
  };
}

export function advanceStreet(state: GameState): GameState {
  if (state.street === "showdown" || state.pending.length > 0) return state;
  const livePlayers = state.players.filter((player) => !player.folded);
  if (livePlayers.length === 1) return settleFoldWin(state, state.players.map((player) => ({ ...player })));

  const playersWhoCanBet = livePlayers.filter((player) => isActionable(player));
  if (playersWhoCanBet.length <= 1) return payoutShowdown(runOutBoard(state));

  if (state.street === "preflop") return drawStreet(state, "flop");
  if (state.street === "flop") return drawStreet(state, "turn");
  if (state.street === "turn") return drawStreet(state, "river");
  return payoutShowdown(runOutBoard(state));
}

function preflopStrength(player: Player): number {
  const [first, second] = player.hole.map((card) => rankValue(card.rank)).sort((a, b) => b - a);
  const pair = first === second;
  const suited = player.hole[0]?.suit === player.hole[1]?.suit;
  const connected = Math.abs(first - second) <= 2;
  let strength = (first + second) / 32;
  if (pair) strength += 0.28 + first / 60;
  if (suited) strength += 0.06;
  if (connected) strength += 0.04;
  return Math.min(1, strength);
}

function botStrength(state: GameState, actor: number): number {
  const player = state.players[actor];
  if (state.board.length < 3) return preflopStrength(player);
  const result = evaluateBest([...player.hole, ...state.board]);
  return Math.min(1, result.score[0] / 8 + (result.score[1] ?? 0) / 56 + 0.04);
}

export function chooseBotAction(state: GameState): BotDecision {
  const actor = state.pending[0];
  const player = state.players[actor];
  if (!player) return { action: "check" };
  const [roll] = randomFromSeed(state.seed);
  const toCall = toCallFor(state, actor);
  const pot = Math.max(BIG_BLIND, potSize(state));
  const strength = botStrength(state, actor);
  const pressure = toCall / (pot + toCall);
  const canRaise = canPlayerRaise(state, actor);

  if (toCall > 0 && strength + roll * 0.38 < 0.28 + pressure * 0.95) {
    return { action: "fold" };
  }

  if (canRaise && ((strength > 0.7 && roll < 0.66) || roll < 0.075)) {
    const minimum = minimumRaiseTarget(state);
    const maximum = maxTargetFor(state, actor);
    const potRaise = Math.max(state.lastRaise, Math.round((pot * (0.38 + strength * 0.5)) / 5) * 5);
    const target = Math.min(maximum, Math.max(minimum, state.currentBet + potRaise));
    if (target > state.currentBet) return { action: "wagerTo", target };
  }

  return { action: toCall === 0 ? "check" : "call" };
}

export function streetLabel(street: Street): string {
  return STREET_LABELS[street];
}

export function humanHandLabel(state: GameState): string {
  const player = state.players[0];
  if (!player?.hole.length) return "等待发牌";
  if (state.board.length >= 3) return evaluateBest([...player.hole, ...state.board]).name;
  const values = player.hole.map((card) => rankValue(card.rank)).sort((a, b) => b - a);
  if (values[0] === values[1]) return `手牌一对 ${player.hole[0].rank}`;
  return `${player.hole[0].rank === "A" || player.hole[1].rank === "A" ? "A" : player.hole.find((card) => rankValue(card.rank) === values[0])?.rank} 高`;
}
