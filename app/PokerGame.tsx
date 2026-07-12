"use client";

import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import {
  BIG_BLIND,
  SMALL_BLIND,
  evaluateBest,
  streetLabel,
  type Card,
  type PokerAction,
} from "./poker-engine";
import {
  MultiplayerApiError,
  createRemoteTable,
  getLobby,
  getRemoteTable,
  joinRemoteTable,
  multiplayerConfigured,
  openSession,
  sendPokerAction,
  tableCommand,
  type GamePlayerView,
  type GameView,
  type LobbyTable,
  type SeatView,
  type SessionIdentity,
  type TableView,
} from "./multiplayer-api";

const SUIT_SYMBOLS = { spades: "♠", hearts: "♥", diamonds: "♦", clubs: "♣" } as const;
const SUIT_NAMES = { spades: "黑桃", hearts: "红桃", diamonds: "方块", clubs: "梅花" } as const;
const chipNumber = new Intl.NumberFormat("zh-CN");
const ID_PATTERN = /^[\p{L}\p{N}_-]{2,16}$/u;
const STORAGE_ID = "backroom-player-id";
const STORAGE_TOKEN = "backroom-session-token";

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

const ACCENTS = ["#d3a65c", "#6f8e84", "#a26f55", "#687b9f", "#7f6e91", "#8b805e", "#5d8575", "#8e665d", "#697a89"];

function colorForId(id: string): string {
  let hash = 0;
  for (const character of id) hash = ((hash << 5) - hash + character.codePointAt(0)!) | 0;
  return ACCENTS[Math.abs(hash) % ACCENTS.length];
}

function initials(id: string): string {
  return [...id].slice(0, 2).join("").toUpperCase();
}

function inviteTableId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.hash.replace(/^#/, "")).get("table");
}

function setInviteHash(tableId?: string) {
  if (typeof window === "undefined") return;
  const next = `${window.location.pathname}${window.location.search}${tableId ? `#table=${encodeURIComponent(tableId)}` : ""}`;
  window.history.replaceState(null, "", next);
}

function PlayingCard({ card, hidden = false, compact = false }: { card?: Card; hidden?: boolean; compact?: boolean }) {
  if (hidden) return <span className={`playing-card card-back${compact ? " card-compact" : ""}`} aria-label="隐藏的手牌"><i /></span>;
  if (!card) return <span className={`playing-card card-slot${compact ? " card-compact" : ""}`} aria-hidden="true" />;
  const red = card.suit === "hearts" || card.suit === "diamonds";
  return (
    <span className={`playing-card card-face${red ? " card-red" : ""}${compact ? " card-compact" : ""}`} aria-label={`${SUIT_NAMES[card.suit]} ${card.rank}`}>
      <b>{card.rank}</b><em>{SUIT_SYMBOLS[card.suit]}</em><small>{SUIT_SYMBOLS[card.suit]}</small>
    </span>
  );
}

function Brand({ onClick }: { onClick?: () => void }) {
  return (
    <button className="brand-lockup" onClick={onClick} aria-label="返回真人牌局大厅">
      <span className="brand-monogram">B</span>
      <span><strong>THE BACKROOM</strong><small>暗桌真人局</small></span>
    </button>
  );
}

function IdentityGate({
  initialId,
  busy,
  error,
  configured,
  onSubmit,
}: {
  initialId: string;
  busy: boolean;
  error: string;
  configured: boolean;
  onSubmit: (playerId: string) => void;
}) {
  const [value, setValue] = useState(initialId);
  useEffect(() => setValue(initialId), [initialId]);
  const valid = ID_PATTERN.test(value.trim());
  return (
    <main className="identity-screen">
      <div className="identity-atmosphere" />
      <section className="identity-card">
        <Brand />
        <div className="access-seal"><span>真人</span><small>ONLY</small></div>
        <p className="eyebrow">PLAYER ACCESS</p>
        <h1>输入你的玩家 ID</h1>
        <p className="identity-lead">进入共享牌局大厅，与拿到同一链接的真人玩家同桌。</p>
        <form onSubmit={(event) => { event.preventDefault(); if (valid && !busy) onSubmit(value.trim()); }}>
          <label htmlFor="player-id">玩家 ID</label>
          <div className="identity-input-wrap">
            <span aria-hidden="true">ID</span>
            <input
              id="player-id"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="例如 Jackie_88"
              minLength={2}
              maxLength={16}
              autoComplete="nickname"
              autoFocus
            />
          </div>
          <small className="input-hint">2–16 位，支持中文、字母、数字、下划线和短横线</small>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="identity-submit" type="submit" disabled={!valid || busy || !configured}>
            {busy ? "正在连接真人大厅…" : configured ? "进入大厅" : "真人服务尚未连接"}<span>→</span>
          </button>
        </form>
        <div className="human-only-note"><i /> 无电脑玩家 · 真人共享牌桌 · 固定盲注 {SMALL_BLIND}/{BIG_BLIND}</div>
      </section>
    </main>
  );
}

function CreateTableDialog({
  identity,
  busy,
  onClose,
  onCreate,
}: {
  identity: SessionIdentity;
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string, maxPlayers: number) => void;
}) {
  const [name, setName] = useState(`${identity.playerId} 的牌桌`.slice(0, 16));
  const [maxPlayers, setMaxPlayers] = useState(6);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog create-table-dialog" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <button className="dialog-close" onClick={onClose} aria-label="关闭">×</button>
        <p className="eyebrow">CREATE TABLE</p>
        <h2 id="create-title">创建真人牌桌</h2>
        <p className="dialog-lead">创建后你将成为房主，等待其他人通过同一链接加入。</p>
        <label className="field-label" htmlFor="table-name">牌桌名称</label>
        <input className="dialog-input" id="table-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={16} />
        <div className="setup-row"><span>人数上限</span><strong>{maxPlayers} 人</strong></div>
        <div className="player-count-grid" aria-label="选择牌桌人数上限">
          {Array.from({ length: 8 }, (_, index) => index + 2).map((value) => (
            <button key={value} className={value === maxPlayers ? "selected" : ""} onClick={() => setMaxPlayers(value)}>{value}</button>
          ))}
        </div>
        <div className="setup-facts">
          <span><small>玩法</small>无限注德州</span><span><small>盲注</small>5 / 5</span><span><small>起始筹码</small>1,000</span>
        </div>
        <button className="dialog-primary" disabled={busy || name.trim().length < 2} onClick={() => onCreate(name.trim(), maxPlayers)}>
          {busy ? "正在创建…" : "创建并入座"}
        </button>
        <p className="dialog-note">牌桌内只会出现真实加入的玩家 ID。</p>
      </section>
    </div>
  );
}

function RulesDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog rules-dialog" role="dialog" aria-modal="true" aria-labelledby="rules-title">
        <button className="dialog-close" onClick={onClose} aria-label="关闭">×</button>
        <p className="eyebrow">HOUSE RULES</p><h2 id="rules-title">暗桌规则</h2>
        <ol>
          <li><b>全部真人</b><span>大厅、座位和行动在所有访客之间实时同步，不会生成电脑玩家。</span></li>
          <li><b>输入 ID 入场</b><span>玩家 ID 是你的桌上身份，同一牌桌不能出现重复 ID。</span></li>
          <li><b>房主开局</b><span>至少两人入座且所有人准备后，房主可以开始发牌。</span></li>
          <li><b>固定 5/5</b><span>大小盲均为 5，起始筹码 1,000。</span></li>
        </ol>
        <button className="dialog-secondary" onClick={onClose}>我知道了</button>
      </section>
    </div>
  );
}

function LobbyCard({ table, currentPlayerId, busy, onJoin }: { table: LobbyTable; currentPlayerId: string; busy: boolean; onJoin: (id: string) => void }) {
  const full = table.joinedCount >= table.maxPlayers;
  const alreadySeated = table.playerIds.includes(currentPlayerId);
  const joinable = alreadySeated || (table.status !== "playing" && !full);
  const statusLabel = table.status === "waiting" ? "等待中" : table.status === "playing" ? "牌局中" : "等待下一手";
  return (
    <article className="lobby-table-card">
      <header><span>TABLE {table.id.slice(0, 4).toUpperCase()}</span><b className={`table-status-badge status-${table.status}`}><i />{statusLabel}</b></header>
      <h3>{table.name}</h3>
      <div className="occupancy"><strong>{table.joinedCount}<small>/ {table.maxPlayers}</small></strong><span>已进入<br />人数上限</span></div>
      <div className="joined-ids">
        {table.playerIds.length ? table.playerIds.slice(0, 4).map((id) => <span key={id}>{id}</span>) : <span className="no-players">等待第一位玩家</span>}
        {table.playerIds.length > 4 && <b>+{table.playerIds.length - 4}</b>}
      </div>
      <footer><span>NLH · {SMALL_BLIND}/{BIG_BLIND} · 1,000</span><button disabled={!joinable || busy} onClick={() => onJoin(table.id)}>{alreadySeated ? "返回牌桌" : full ? "已满员" : table.status === "playing" ? "牌局进行中" : table.status === "showdown" ? "加入下一手" : "加入牌桌"}</button></footer>
    </article>
  );
}

function LobbyView({
  identity,
  tables,
  busy,
  onCreate,
  onJoin,
  onRules,
  onSwitchId,
}: {
  identity: SessionIdentity;
  tables: LobbyTable[];
  busy: boolean;
  onCreate: () => void;
  onJoin: (id: string) => void;
  onRules: () => void;
  onSwitchId: () => void;
}) {
  const playerTotal = tables.reduce((sum, table) => sum + table.joinedCount, 0);
  return (
    <main className="poker-shell lobby-shell">
      <header className="room-header lobby-header">
        <Brand />
        <div className="room-identity"><i className="live-dot" /><span>LIVE LOBBY</span><b>NLH · {SMALL_BLIND}/{BIG_BLIND}</b></div>
        <nav className="header-actions"><button className="player-id-pill" onClick={onSwitchId}><i />{identity.playerId}</button><button onClick={onRules}>规则</button><button className="new-table-button" onClick={onCreate}>创建牌桌</button></nav>
      </header>
      <section className="lobby-main">
        <div className="lobby-title-row">
          <div><p className="eyebrow">REAL PLAYERS · LIVE TABLES</p><h1>正在进行的牌局</h1><p>{tables.length} 桌在线 · {playerTotal} 位真人玩家</p></div>
          <button className="lobby-create-large" onClick={onCreate}>＋ 创建牌桌</button>
        </div>
        {tables.length ? (
          <div className="lobby-grid">{tables.map((table) => <LobbyCard key={table.id} table={table} currentPlayerId={identity.playerId} busy={busy} onJoin={onJoin} />)}</div>
        ) : (
          <div className="lobby-empty"><span className="empty-table-mark">B</span><h2>还没有真人牌局</h2><p>创建第一桌，然后把链接发给朋友。</p><button onClick={onCreate}>创建第一桌</button></div>
        )}
        <p className="lobby-refresh"><i /> 大厅人数自动同步 · 不含任何电脑玩家</p>
      </section>
    </main>
  );
}

function TableSeat({
  seat,
  gamePlayer,
  game,
  slot,
  isMe,
}: {
  seat: SeatView;
  gamePlayer?: GamePlayerView;
  game: GameView | null;
  slot: number;
  isMe: boolean;
}) {
  const current = Boolean(game && gamePlayer && game.pending[0] === gamePlayer.id);
  const winner = Boolean(game && gamePlayer && game.winners.includes(gamePlayer.id));
  const roles = gamePlayer && game ? [gamePlayer.id === game.dealer ? "D" : "", gamePlayer.id === game.smallBlind ? "SB" : "", gamePlayer.id === game.bigBlind ? "BB" : ""].filter(Boolean) : [];
  const cards = gamePlayer?.hole ?? [];
  const hiddenCardCount = gamePlayer?.hasCards && cards.length === 0 ? 2 : 0;
  const style = { "--seat-accent": colorForId(seat.playerId) } as CSSProperties;
  return (
    <div className={`seat seat-slot-${slot}${current ? " seat-current" : ""}${winner ? " seat-winner" : ""}${gamePlayer?.folded ? " seat-folded" : ""}${isMe ? " seat-human" : ""}`} style={style}>
      <div className="seat-cards" aria-label={`${seat.playerId}的手牌`}>
        {cards.map((card, index) => <PlayingCard key={`${card.rank}-${card.suit}-${index}`} card={card} compact={!isMe} />)}
        {Array.from({ length: hiddenCardCount }, (_, index) => <PlayingCard key={`hidden-${index}`} hidden compact={!isMe} />)}
      </div>
      <div className="seat-panel">
        <span className="avatar" aria-hidden="true">{initials(seat.playerId)}</span>
        <span className="seat-copy"><strong title={seat.playerId}>{seat.playerId}</strong><small><i className="mini-chip" />{chipNumber.format(gamePlayer?.stack ?? seat.stack)}</small></span>
        {roles.length > 0 && <span className="seat-roles">{roles.map((role) => <i key={role}>{role}</i>)}</span>}
      </div>
      <span className="seat-action">{gamePlayer?.lastAction ?? (seat.ready ? "已准备" : "未准备")}</span>
      {gamePlayer && gamePlayer.streetBet > 0 && <span className="seat-bet"><i />{chipNumber.format(gamePlayer.streetBet)}</span>}
      {!seat.connected && <span className="reconnect-badge">重连中</span>}
    </div>
  );
}

function EmptyTableSeat({ slot }: { slot: number }) {
  return <div className={`empty-seat waiting-empty-seat seat-slot-${slot}`}><span>＋</span><small>等待真人</small></div>;
}

function TableRoom({
  view,
  identity,
  busy,
  onBack,
  onReady,
  onStart,
  onNext,
  onLeave,
  onAction,
  onCopy,
}: {
  view: TableView;
  identity: SessionIdentity;
  busy: boolean;
  onBack: () => void;
  onReady: () => void;
  onStart: () => void;
  onNext: () => void;
  onLeave: () => void;
  onAction: (action: PokerAction, target?: number) => void;
  onCopy: () => void;
}) {
  const { table, me } = view;
  const game = table.game;
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [raiseDraft, setRaiseDraft] = useState(BIG_BLIND * 2);
  const meGame = game?.players.find((player) => player.name === identity.playerId);
  const isMyTurn = Boolean(game && meGame && game.street !== "showdown" && game.pending[0] === meGame.id);
  const toCall = game && meGame ? Math.max(0, game.currentBet - meGame.streetBet) : 0;
  const minimum = game ? (game.currentBet === 0 ? BIG_BLIND : game.currentBet + game.lastRaise) : BIG_BLIND;
  const maximum = meGame ? meGame.streetBet + meGame.stack : 0;
  const canRaise = isMyTurn && maximum > (game?.currentBet ?? 0);
  const pot = game ? game.pot : 0;
  const allReady = table.seats.length >= 2 && table.seats.every((seat) => seat.ready);
  const myHand = meGame?.hole.length && game ? (game.board.length >= 3 ? evaluateBest([...meGame.hole, ...game.board]).name : `${meGame.hole[0]?.rank ?? ""}${meGame.hole[1]?.rank ?? ""}`) : "等待发牌";

  useEffect(() => {
    if (!canRaise) { setRaiseOpen(false); return; }
    setRaiseDraft(Math.min(maximum, Math.max(minimum, (game?.currentBet ?? 0) + Math.max(game?.lastRaise ?? 5, Math.round(pot / 2 / 5) * 5))));
  }, [canRaise, game?.currentBet, game?.lastRaise, maximum, minimum, pot]);

  const seatByNumber = new Map(table.seats.map((seat) => [seat.seat, seat]));
  const statusText = !game
    ? `等待玩家准备 · ${table.joinedCount}/${table.maxPlayers}`
    : game.street === "showdown"
      ? game.result
      : isMyTurn
        ? toCall > 0 ? `轮到你 · 跟注 ${toCall}` : "轮到你 · 可以过牌"
        : `${game.players.find((player) => player.id === game.pending[0])?.name ?? "其他玩家"} 行动中`;

  return (
    <main className="poker-shell">
      <header className="room-header table-room-header">
        <Brand onClick={onBack} />
        <div className="room-identity"><i className="live-dot" /><span>{table.name}</span><b>{table.joinedCount}/{table.maxPlayers} · {SMALL_BLIND}/{BIG_BLIND}</b></div>
        <nav className="header-actions"><button onClick={onCopy}>复制邀请链接</button><button onClick={onLeave}>离开牌桌</button></nav>
      </header>
      <section className="game-stage multiplayer-stage">
        <div className="ambient-glow ambient-one" /><div className="ambient-glow ambient-two" />
        <aside className="table-readout readout-left"><span>TABLE {table.id.slice(0, 4).toUpperCase()}</span><strong>REAL PLAYERS<br />HOLD&apos;EM</strong><small>BLINDS {SMALL_BLIND} / {BIG_BLIND}<br />SEATS {table.joinedCount} / {table.maxPlayers}</small></aside>
        <div className="table-orbit">
          <div className="table-rim"><div className="rail-stitch" /><div className="table-felt">
            <div className="felt-mark" aria-hidden="true"><span>B</span><small>BACKROOM<br />LIVE TABLE</small></div>
            <div className="board-zone">
              <span className="street-pill">{game ? streetLabel(game.street) : "等待开局"}</span>
              <div className="pot-display"><small>{game ? "当前底池" : "真人入座"}</small><strong><i className="pot-chip" />{game ? chipNumber.format(pot) : `${table.joinedCount} / ${table.maxPlayers}`}</strong></div>
              <div className="community-cards">{Array.from({ length: 5 }, (_, index) => <PlayingCard key={game?.board[index] ? `${game.board[index].rank}-${game.board[index].suit}` : `slot-${index}`} card={game?.board[index]} />)}</div>
              <p className={`table-status${isMyTurn ? " your-turn" : ""}`} aria-live="polite">{statusText}</p>
            </div>
          </div></div>
          {Array.from({ length: table.maxPlayers }, (_, seatNumber) => {
            const seat = seatByNumber.get(seatNumber);
            const slot = SLOT_MAP[table.maxPlayers][seatNumber];
            if (!seat) return <EmptyTableSeat key={`empty-${seatNumber}`} slot={slot} />;
            const gamePlayer = game?.players.find((player) => player.name === seat.playerId);
            return <TableSeat key={seat.playerId} seat={seat} gamePlayer={gamePlayer} game={game} slot={slot} isMe={seat.playerId === identity.playerId} />;
          })}
        </div>

        <section className={`action-dock multiplayer-dock${raiseOpen ? " raise-expanded" : ""}`}>
          {raiseOpen && canRaise && <div className="raise-tray">
            <div className="raise-presets"><button onClick={() => setRaiseDraft(Math.min(maximum, Math.max(minimum, (game?.currentBet ?? 0) + Math.round(pot * 0.5 / 5) * 5)))}>½ 底池</button><button onClick={() => setRaiseDraft(Math.min(maximum, Math.max(minimum, (game?.currentBet ?? 0) + Math.round(pot * 0.67 / 5) * 5)))}>⅔ 底池</button><button onClick={() => setRaiseDraft(Math.min(maximum, Math.max(minimum, (game?.currentBet ?? 0) + Math.round(pot / 5) * 5)))}>1× 底池</button><button onClick={() => setRaiseDraft(maximum)}>全下</button></div>
            <div className="raise-slider-row"><button onClick={() => setRaiseDraft((value) => Math.max(minimum, value - 5))}>−</button><input type="range" min={Math.min(minimum, maximum)} max={Math.max(minimum, maximum)} step={5} value={raiseDraft} onChange={(event) => setRaiseDraft(Number(event.target.value))} /><button onClick={() => setRaiseDraft((value) => Math.min(maximum, value + 5))}>＋</button><strong>{raiseDraft}</strong></div>
          </div>}
          <div className="dock-info"><span><i />{game ? myHand : me.ready ? "你已准备" : "等待你准备"}</span><p>{statusText}</p><small>{identity.playerId} · 筹码 {chipNumber.format(meGame?.stack ?? table.seats.find((seat) => seat.playerId === identity.playerId)?.stack ?? 1000)}</small></div>
          {!game ? <div className="waiting-actions">
            <button className={me.ready ? "ready-active" : ""} disabled={busy} onClick={onReady}>{me.ready ? "取消准备" : "准备"}</button>
            {me.isHost ? <button className="start-game-button" disabled={busy || !allReady} onClick={onStart}>开始牌局</button> : <button className="start-game-button" disabled>等待房主开始</button>}
          </div> : game.street === "showdown" ? <button className="next-hand-button" disabled={busy || !me.isHost} onClick={onNext}>{me.isHost ? "开始下一手" : "等待房主下一手"}<span>→</span></button> : <div className="action-buttons">
            <button className="action-fold" disabled={!isMyTurn || busy} onClick={() => onAction("fold")}><span>F</span>弃牌</button>
            <button className="action-call" disabled={!isMyTurn || busy} onClick={() => onAction(toCall === 0 ? "check" : "call")}><span>C</span>{toCall === 0 ? "过牌" : `跟注 ${Math.min(toCall, meGame?.stack ?? 0)}`}</button>
            <button className={`action-raise${raiseOpen ? " active" : ""}`} disabled={!canRaise || busy} onClick={() => raiseOpen ? onAction("wagerTo", raiseDraft) : setRaiseOpen(true)}><span>R</span>{raiseOpen ? `加注至 ${raiseDraft}` : "加注"}</button>
          </div>}
        </section>
        <p className="fair-play-note multiplayer-note"><i /> 真人牌局 · 实时同步 · 无电脑玩家</p>
      </section>
    </main>
  );
}

export default function PokerGame() {
  const [rememberedId, setRememberedId] = useState("");
  const [identity, setIdentity] = useState<SessionIdentity | null>(null);
  const [tables, setTables] = useState<LobbyTable[]>([]);
  const [tableId, setTableId] = useState<string | null>(null);
  const [tableView, setTableView] = useState<TableView | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    setRememberedId(window.localStorage.getItem(STORAGE_ID) ?? "");
    setConfigured(multiplayerConfigured());
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const refreshLobby = useCallback(async () => {
    if (!identity) return;
    try { const response = await getLobby(identity.token); setTables(response.tables); }
    catch (reason) { if (!tables.length) setError(reason instanceof Error ? reason.message : "大厅暂时无法连接"); }
  }, [identity, tables.length]);

  useEffect(() => {
    if (!identity || tableId) return;
    void refreshLobby();
    const timer = window.setInterval(() => void refreshLobby(), 1800);
    return () => window.clearInterval(timer);
  }, [identity, refreshLobby, tableId]);

  const refreshTable = useCallback(async () => {
    if (!identity || !tableId) return;
    try { setTableView(await getRemoteTable(identity.token, tableId)); setError(""); }
    catch (reason) {
      if (reason instanceof MultiplayerApiError && (reason.status === 404 || reason.status === 410)) {
        setNotice("牌桌已结束"); setTableId(null); setTableView(null); setInviteHash();
      } else setError(reason instanceof Error ? reason.message : "牌桌暂时无法同步");
    }
  }, [identity, tableId]);

  useEffect(() => {
    if (!identity || !tableId) return;
    void refreshTable();
    const timer = window.setInterval(() => void refreshTable(), 900);
    return () => window.clearInterval(timer);
  }, [identity, refreshTable, tableId]);

  const enterTable = async (id: string, token = identity?.token) => {
    if (!token) return;
    setBusy(true); setError("");
    try {
      await joinRemoteTable(token, id);
      setTableId(id); setInviteHash(id); setTableView(await getRemoteTable(token, id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "加入牌桌失败"); }
    finally { setBusy(false); }
  };

  const handleIdentity = async (playerId: string) => {
    setBusy(true); setError("");
    try {
      const storedId = window.localStorage.getItem(STORAGE_ID);
      const storedToken = storedId === playerId ? window.localStorage.getItem(STORAGE_TOKEN) ?? undefined : undefined;
      const nextIdentity = await openSession(playerId, storedToken);
      window.localStorage.setItem(STORAGE_ID, nextIdentity.playerId);
      window.localStorage.setItem(STORAGE_TOKEN, nextIdentity.token);
      setIdentity(nextIdentity); setRememberedId(nextIdentity.playerId);
      const invited = inviteTableId();
      if (invited) await enterTable(invited, nextIdentity.token);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法进入真人大厅"); }
    finally { setBusy(false); }
  };

  const handleCreate = async (name: string, maxPlayers: number) => {
    if (!identity) return;
    setBusy(true); setError("");
    try {
      const created = await createRemoteTable(identity.token, name, maxPlayers);
      setCreateOpen(false); setTableId(created.tableId); setInviteHash(created.tableId);
      setTableView(await getRemoteTable(identity.token, created.tableId));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建牌桌失败"); }
    finally { setBusy(false); }
  };

  const command = async (name: "ready" | "start" | "next", body?: Record<string, unknown>) => {
    if (!identity || !tableId) return;
    setBusy(true);
    try { const response = await tableCommand(identity.token, tableId, name, body); if ("table" in response) setTableView(response); else await refreshTable(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { setBusy(false); }
  };

  const leaveTable = async () => {
    if (!identity || !tableId) return;
    setBusy(true);
    try { await tableCommand(identity.token, tableId, "leave"); }
    catch { /* The local exit still succeeds if the remote seat already expired. */ }
    setTableId(null); setTableView(null); setInviteHash(); setBusy(false); void refreshLobby();
  };

  const playAction = async (action: PokerAction, target?: number) => {
    if (!identity || !tableId) return;
    setBusy(true);
    try { setTableView(await sendPokerAction(identity.token, tableId, action, target)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "行动未能提交"); await refreshTable(); }
    finally { setBusy(false); }
  };

  const copyInvite = async () => {
    if (!tableId) return;
    const url = new URL(window.location.href); url.hash = `table=${tableId}`;
    await navigator.clipboard.writeText(url.toString()); setNotice("邀请链接已复制");
  };

  const switchId = async () => {
    if (!identity) return;
    setBusy(true);
    const occupiedTables = tables.filter((table) => table.playerIds.includes(identity.playerId));
    await Promise.allSettled(occupiedTables.map((table) => tableCommand(identity.token, table.id, "leave")));
    setIdentity(null); setTableId(null); setTableView(null); setInviteHash(); setError(""); setBusy(false);
  };

  const lobbySorted = useMemo(() => [...tables].sort((left, right) => right.updatedAt - left.updatedAt), [tables]);

  if (!identity) return <IdentityGate initialId={rememberedId} busy={busy} error={error} configured={configured} onSubmit={handleIdentity} />;

  return (
    <>
      {tableId && tableView ? <TableRoom
        view={tableView} identity={identity} busy={busy}
        onBack={() => { setTableId(null); setTableView(null); setInviteHash(); }}
        onReady={() => void command("ready", { ready: !tableView.me.ready })}
        onStart={() => void command("start")}
        onNext={() => void command("next")}
        onLeave={() => void leaveTable()}
        onAction={(action, target) => void playAction(action, target)}
        onCopy={() => void copyInvite()}
      /> : <LobbyView identity={identity} tables={lobbySorted} busy={busy} onCreate={() => setCreateOpen(true)} onJoin={(id) => void enterTable(id)} onRules={() => setRulesOpen(true)} onSwitchId={() => void switchId()} />}
      {createOpen && <CreateTableDialog identity={identity} busy={busy} onClose={() => setCreateOpen(false)} onCreate={(name, max) => void handleCreate(name, max)} />}
      {rulesOpen && <RulesDialog onClose={() => setRulesOpen(false)} />}
      {error && identity && <div className="global-toast error-toast" role="alert"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
      {notice && <div className="global-toast"><span>✓</span>{notice}</div>}
    </>
  );
}
