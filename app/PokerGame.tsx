"use client";

import { type CSSProperties, useEffect, useState } from "react";
import {
  BIG_BLIND,
  SMALL_BLIND,
  advanceStreet,
  applyAction,
  canPlayerRaise,
  chooseBotAction,
  createTable,
  humanHandLabel,
  maxTargetFor,
  minimumRaiseTarget,
  nextHand,
  potSize,
  streetLabel,
  toCallFor,
  type Card,
  type GameState,
  type Player,
  type PokerAction,
} from "./poker-engine";

const SUIT_SYMBOLS = {
  spades: "♠",
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
} as const;

const SUIT_NAMES = {
  spades: "黑桃",
  hearts: "红桃",
  diamonds: "方块",
  clubs: "梅花",
} as const;

const chipNumber = new Intl.NumberFormat("zh-CN");

function PlayingCard({ card, hidden = false, compact = false }: { card?: Card; hidden?: boolean; compact?: boolean }) {
  if (hidden) {
    return <span className={`playing-card card-back${compact ? " card-compact" : ""}`} aria-label="隐藏的手牌"><i /></span>;
  }

  if (!card) {
    return <span className={`playing-card card-slot${compact ? " card-compact" : ""}`} aria-hidden="true" />;
  }

  const red = card.suit === "hearts" || card.suit === "diamonds";
  return (
    <span
      className={`playing-card card-face${red ? " card-red" : ""}${compact ? " card-compact" : ""}`}
      aria-label={`${SUIT_NAMES[card.suit]} ${card.rank}`}
    >
      <b>{card.rank}</b>
      <em>{SUIT_SYMBOLS[card.suit]}</em>
      <small>{SUIT_SYMBOLS[card.suit]}</small>
    </span>
  );
}

function Seat({
  player,
  state,
}: {
  player: Player;
  state: GameState;
}) {
  const current = state.pending[0] === player.id;
  const winner = state.winners.includes(player.id);
  const reveal = player.isHuman || (state.street === "showdown" && !player.folded);
  const seatStyle = { "--seat-accent": player.accent } as CSSProperties;
  const roleLabels = [
    player.id === state.dealer ? "D" : "",
    player.id === state.smallBlind ? "SB" : "",
    player.id === state.bigBlind ? "BB" : "",
  ].filter(Boolean);

  return (
    <div
      className={`seat seat-slot-${player.slot}${current ? " seat-current" : ""}${winner ? " seat-winner" : ""}${player.folded ? " seat-folded" : ""}${player.isHuman ? " seat-human" : ""}`}
      style={seatStyle}
      aria-label={`${player.name}，筹码 ${player.stack}，${player.lastAction}`}
    >
      <div className="seat-cards" aria-label={`${player.name}的手牌`}>
        {player.hole.map((card, index) => (
          <PlayingCard key={`${card.rank}-${card.suit}-${index}`} card={card} hidden={!reveal} compact={!player.isHuman} />
        ))}
      </div>
      <div className="seat-panel">
        <span className="avatar" aria-hidden="true">{player.avatar}</span>
        <span className="seat-copy">
          <strong>{player.name}</strong>
          <small><i className="mini-chip" />{chipNumber.format(player.stack)}</small>
        </span>
        {roleLabels.length > 0 && <span className="seat-roles">{roleLabels.map((role) => <i key={role}>{role}</i>)}</span>}
      </div>
      <span className="seat-action">{player.lastAction}</span>
      {player.streetBet > 0 && <span className="seat-bet"><i />{chipNumber.format(player.streetBet)}</span>}
    </div>
  );
}

function EmptySeat({ slot, onClick }: { slot: number; onClick: () => void }) {
  return (
    <button className={`empty-seat seat-slot-${slot}`} onClick={onClick} aria-label={`在第 ${slot + 1} 个座位添加电脑玩家`}>
      <span>＋</span>
      <small>空位</small>
    </button>
  );
}

function SetupDialog({
  currentCount,
  onClose,
  onStart,
}: {
  currentCount: number;
  onClose: () => void;
  onStart: (count: number) => void;
}) {
  const [count, setCount] = useState(currentCount);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title">
        <button className="dialog-close" onClick={onClose} aria-label="关闭">×</button>
        <p className="eyebrow">TABLE SETUP</p>
        <h2 id="setup-title">创建你的私人牌局</h2>
        <p className="dialog-lead">你将坐在主位，其余座位由电脑玩家加入。盲注固定为 5/5。</p>
        <div className="setup-row">
          <span>牌桌人数</span>
          <strong>{count} 人</strong>
        </div>
        <div className="player-count-grid" aria-label="选择牌桌人数">
          {Array.from({ length: 8 }, (_, index) => index + 2).map((value) => (
            <button key={value} className={value === count ? "selected" : ""} onClick={() => setCount(value)}>{value}</button>
          ))}
        </div>
        <div className="setup-facts">
          <span><small>玩法</small>无限注德州扑克</span>
          <span><small>盲注</small>5 / 5</span>
          <span><small>起始筹码</small>1,000</span>
        </div>
        <button className="dialog-primary" onClick={() => onStart(count)}>开始新牌局</button>
        <p className="dialog-note">本局为本地单人练习模式，电脑玩家会自动行动。</p>
      </section>
    </div>
  );
}

function RulesDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog rules-dialog" role="dialog" aria-modal="true" aria-labelledby="rules-title">
        <button className="dialog-close" onClick={onClose} aria-label="关闭">×</button>
        <p className="eyebrow">HOUSE RULES</p>
        <h2 id="rules-title">暗桌规则</h2>
        <ol>
          <li><b>拿到两张底牌</b><span>与桌面五张公共牌组合，选出最强五张牌。</span></li>
          <li><b>四轮行动</b><span>翻牌前、翻牌、转牌、河牌，可过牌、跟注、加注或弃牌。</span></li>
          <li><b>赢下底池</b><span>让所有对手弃牌，或在摊牌时持有更大的牌型。</span></li>
          <li><b>固定 5/5</b><span>大小盲均为 5，最低完整加注增量也是 5。</span></li>
        </ol>
        <button className="dialog-secondary" onClick={onClose}>回到牌桌</button>
      </section>
    </div>
  );
}

export default function PokerGame() {
  const [state, setState] = useState<GameState>(() => createTable(6));
  const [setupOpen, setSetupOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [raiseDraft, setRaiseDraft] = useState(BIG_BLIND * 2);
  const me = state.players[0];
  const actorIndex = state.pending[0];
  const actor = state.players[actorIndex];
  const isMyTurn = state.street !== "showdown" && actorIndex === 0 && !me.folded && !me.allIn;
  const toCall = toCallFor(state, 0);
  const pot = state.street === "showdown" ? state.lastPot : potSize(state);
  const minimum = minimumRaiseTarget(state);
  const maximum = maxTargetFor(state, 0);
  const canRaise = isMyTurn && canPlayerRaise(state, 0);
  const sliderMinimum = Math.min(minimum, maximum);
  useEffect(() => {
    if (state.street === "showdown") return;

    if (state.pending.length === 0) {
      const timer = window.setTimeout(() => {
        setState((current) => current.street !== "showdown" && current.pending.length === 0 ? advanceStreet(current) : current);
      }, 620);
      return () => window.clearTimeout(timer);
    }

    if (!actor || actor.isHuman) return;
    const handNo = state.handNo;
    const street = state.street;
    const decision = chooseBotAction(state);
    const delay = 620 + ((state.seed >>> 4) % 420);
    const timer = window.setTimeout(() => {
      setState((current) => {
        if (current.handNo !== handNo || current.street !== street || current.pending[0] !== actorIndex) return current;
        return applyAction(current, actorIndex, decision.action, decision.target);
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [actor, actorIndex, state]);

  useEffect(() => {
    if (!isMyTurn || !canRaise) {
      setRaiseOpen(false);
      return;
    }
    setRaiseDraft(Math.min(maximum, Math.max(minimum, state.currentBet + Math.max(state.lastRaise, Math.round(pot / 2 / 5) * 5))));
  }, [canRaise, isMyTurn, maximum, minimum, pot, state.currentBet, state.lastRaise]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isMyTurn || setupOpen || rulesOpen || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "f") setState((current) => applyAction(current, 0, "fold"));
      if (event.key.toLowerCase() === "c" || event.key === " ") {
        event.preventDefault();
        setState((current) => applyAction(current, 0, toCallFor(current, 0) === 0 ? "check" : "call"));
      }
      if (event.key.toLowerCase() === "r" && canRaise) setRaiseOpen((open) => !open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canRaise, isMyTurn, rulesOpen, setupOpen]);

  const act = (action: PokerAction, target?: number) => {
    setState((current) => applyAction(current, 0, action, target));
    setRaiseOpen(false);
  };

  const statusText = state.street === "showdown"
    ? state.result
    : state.pending.length === 0
      ? "本轮行动结束，正在发牌…"
      : actorIndex === 0
        ? toCall > 0 ? `轮到你 · 跟注 ${chipNumber.format(toCall)}` : "轮到你 · 可以过牌"
        : `${actor?.name ?? "玩家"} 正在思考…`;

  const setQuickRaise = (fraction: number) => {
    const target = state.currentBet + Math.max(state.lastRaise, Math.round((pot * fraction) / 5) * 5);
    setRaiseDraft(Math.min(maximum, Math.max(sliderMinimum, target)));
  };

  return (
    <main className="poker-shell">
      <header className="room-header">
        <button className="brand-lockup" onClick={() => setSetupOpen(true)} aria-label="打开牌局设置">
          <span className="brand-monogram">B</span>
          <span><strong>THE BACKROOM</strong><small>暗桌私人局</small></span>
        </button>
        <div className="room-identity" aria-label="牌局信息">
          <i className="live-dot" />
          <span>PRIVATE TABLE</span>
          <b>NLH · {SMALL_BLIND}/{BIG_BLIND}</b>
        </div>
        <nav className="header-actions" aria-label="牌桌操作">
          <span className="seat-count"><i />{state.players.length}<small>/9</small></span>
          <button onClick={() => setRulesOpen(true)}>规则</button>
          <button className="new-table-button" onClick={() => setSetupOpen(true)}>新牌局</button>
        </nav>
      </header>

      <section className="game-stage">
        <div className="ambient-glow ambient-one" />
        <div className="ambient-glow ambient-two" />

        <aside className="table-readout readout-left" aria-label="牌桌参数">
          <span>TABLE 07</span>
          <strong>NO LIMIT<br />HOLD&apos;EM</strong>
          <small>BLINDS {SMALL_BLIND} / {BIG_BLIND}<br />BUY-IN 1,000</small>
        </aside>

        <aside className="hand-history" aria-label="本手记录">
          <header><span>本手记录</span><b>#{String(state.handNo).padStart(3, "0")}</b></header>
          <div>
            {state.log.slice(-5).reverse().map((entry, index) => <p key={`${entry}-${index}`} className={index === 0 ? "latest" : ""}>{entry}</p>)}
          </div>
        </aside>

        <div className="table-orbit">
          <div className="table-rim" aria-label={`${state.players.length} 人德州扑克牌桌`}>
            <div className="rail-stitch" />
            <div className="table-felt">
              <div className="felt-mark" aria-hidden="true"><span>B</span><small>BACKROOM<br />POKER CLUB</small></div>
              <div className="board-zone">
                <span className="street-pill">{streetLabel(state.street)}</span>
                <div className="pot-display" aria-live="polite">
                  <small>{state.street === "showdown" ? "本手底池" : "当前底池"}</small>
                  <strong><i className="pot-chip" />{chipNumber.format(pot)}</strong>
                </div>
                <div className="community-cards" aria-label="公共牌">
                  {Array.from({ length: 5 }, (_, index) => <PlayingCard key={state.board[index] ? `${state.board[index].rank}-${state.board[index].suit}` : `slot-${index}`} card={state.board[index]} />)}
                </div>
                <p className={`table-status${isMyTurn ? " your-turn" : ""}`} aria-live="polite">{statusText}</p>
              </div>
            </div>
          </div>

          {Array.from({ length: 9 }, (_, slot) => {
            const player = state.players.find((candidate) => candidate.slot === slot);
            return player
              ? <Seat key={player.id} player={player} state={state} />
              : <EmptySeat key={`empty-${slot}`} slot={slot} onClick={() => setSetupOpen(true)} />;
          })}
        </div>

        <section className={`action-dock${raiseOpen ? " raise-expanded" : ""}`} aria-label="玩家操作区">
          {raiseOpen && canRaise && (
            <div className="raise-tray">
              <div className="raise-presets">
                <button onClick={() => setQuickRaise(0.5)}>½ 底池</button>
                <button onClick={() => setQuickRaise(0.67)}>⅔ 底池</button>
                <button onClick={() => setQuickRaise(1)}>1× 底池</button>
                <button onClick={() => setRaiseDraft(maximum)}>全下</button>
              </div>
              <div className="raise-slider-row">
                <button onClick={() => setRaiseDraft((value) => Math.max(sliderMinimum, value - 5))} aria-label="减少加注额">−</button>
                <input
                  type="range"
                  min={sliderMinimum}
                  max={Math.max(sliderMinimum, maximum)}
                  step={5}
                  value={Math.min(maximum, Math.max(sliderMinimum, raiseDraft))}
                  onChange={(event) => setRaiseDraft(Number(event.target.value))}
                  aria-label="加注金额"
                />
                <button onClick={() => setRaiseDraft((value) => Math.min(maximum, value + 5))} aria-label="增加加注额">＋</button>
                <strong>{chipNumber.format(raiseDraft)}</strong>
              </div>
            </div>
          )}

          <div className="dock-info">
            <span><i />{humanHandLabel(state)}</span>
            <p>{state.street === "showdown" ? state.result : me.folded ? "你已弃牌，正在观看本手" : me.allIn ? "你已全下，等待公共牌" : statusText}</p>
            <small>筹码 {chipNumber.format(me.stack)}</small>
          </div>

          {state.street === "showdown" ? (
            <button className="next-hand-button" onClick={() => setState((current) => nextHand(current))}>下一手牌 <span>→</span></button>
          ) : (
            <div className="action-buttons">
              <button className="action-fold" disabled={!isMyTurn} onClick={() => act("fold")}><span>F</span>弃牌</button>
              <button className="action-call" disabled={!isMyTurn} onClick={() => act(toCall === 0 ? "check" : "call")}>
                <span>C</span>{toCall === 0 ? "过牌" : `跟注 ${chipNumber.format(Math.min(toCall, me.stack))}`}
              </button>
              <button className={`action-raise${raiseOpen ? " active" : ""}`} disabled={!canRaise} onClick={() => raiseOpen ? act("wagerTo", raiseDraft) : setRaiseOpen(true)}>
                <span>R</span>{raiseOpen ? `加注至 ${chipNumber.format(raiseDraft)}` : "加注"}
              </button>
            </div>
          )}
        </section>

        <p className="fair-play-note"><i /> 本地练习局 · 随机洗牌 · 1 位真人 + {state.players.length - 1} 位电脑玩家</p>
      </section>

      {setupOpen && (
        <SetupDialog
          currentCount={state.players.length}
          onClose={() => setSetupOpen(false)}
          onStart={(count) => {
            setState(createTable(count, Date.now() >>> 0));
            setSetupOpen(false);
            setRaiseOpen(false);
          }}
        />
      )}
      {rulesOpen && <RulesDialog onClose={() => setRulesOpen(false)} />}
    </main>
  );
}
