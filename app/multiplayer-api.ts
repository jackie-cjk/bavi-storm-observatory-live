import type { Card, PokerAction, Street } from "./poker-engine";

declare global {
  interface Window {
    __BACKROOM_API__?: string;
  }
}

export type TableStatus = "waiting" | "playing" | "showdown" | "closed";

export interface SessionIdentity {
  playerId: string;
  token: string;
}

export interface LobbyTable {
  id: string;
  name: string;
  status: TableStatus;
  maxPlayers: number;
  joinedCount: number;
  playerIds: string[];
  handNo: number;
  updatedAt: number;
}

export interface SeatView {
  playerId: string;
  seat: number;
  ready: boolean;
  stack: number;
  connected: boolean;
}

export interface GamePlayerView {
  id: string;
  slot: number;
  name: string;
  stack: number;
  hole: Card[];
  hasCards: boolean;
  folded: boolean;
  allIn: boolean;
  streetBet: number;
  lastAction: string;
}

export interface GameView {
  street: Street;
  board: Card[];
  currentBet: number;
  lastRaise: number;
  pending: string[];
  dealer: string;
  smallBlind: string;
  bigBlind: string;
  handNo: number;
  pot: number;
  result: string;
  lastPot: number;
  winners: string[];
  players: GamePlayerView[];
}

export interface TableView {
  table: {
    id: string;
    name: string;
    status: TableStatus;
    maxPlayers: number;
    joinedCount: number;
    version: number;
    hostId: string;
    seats: SeatView[];
    game: GameView | null;
  };
  me: {
    playerId: string;
    seat: number;
    isHost: boolean;
    ready: boolean;
  };
}

export interface ApiErrorPayload {
  error?: string | { code?: string; message?: string };
  message?: string;
}

export class MultiplayerApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "MultiplayerApiError";
    this.status = status;
  }
}

function apiBase(): string {
  if (typeof window === "undefined") return "";
  return (window.__BACKROOM_API__ ?? "").replace(/\/$/, "");
}

export function multiplayerConfigured(): boolean {
  return apiBase().length > 0 || (typeof window !== "undefined" && window.location.hostname === "localhost");
}

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const base = apiBase() || (typeof window !== "undefined" && window.location.hostname === "localhost" ? "http://localhost:8787" : "");
  if (!base) throw new MultiplayerApiError("真人牌局服务尚未连接", 503);

  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${base}${path}`, { ...init, headers, cache: "no-store" });
  const payload = (await response.json().catch(() => ({}))) as T & ApiErrorPayload;
  if (!response.ok) {
    const nestedMessage = typeof payload.error === "object" ? payload.error.message : payload.error;
    throw new MultiplayerApiError(payload.message || nestedMessage || `请求失败（${response.status}）`, response.status);
  }
  return payload;
}

export function openSession(playerId: string, resumeToken?: string): Promise<SessionIdentity> {
  return request<SessionIdentity>("/api/session", {
    method: "POST",
    body: JSON.stringify({ playerId, resumeToken }),
  });
}

export function getLobby(token: string): Promise<{ tables: LobbyTable[] }> {
  return request<{ tables: LobbyTable[] }>("/api/lobby", {}, token);
}

export function createRemoteTable(
  token: string,
  name: string,
  maxPlayers: number,
): Promise<{ tableId: string }> {
  return request<{ tableId: string }>("/api/tables", {
    method: "POST",
    body: JSON.stringify({ name, maxPlayers }),
  }, token);
}

export function joinRemoteTable(token: string, tableId: string): Promise<{ tableId: string }> {
  return request<{ tableId: string }>(`/api/tables/${encodeURIComponent(tableId)}/join`, { method: "POST" }, token);
}

export function getRemoteTable(token: string, tableId: string): Promise<TableView> {
  return request<TableView>(`/api/tables/${encodeURIComponent(tableId)}/state`, {}, token);
}

export function tableCommand(
  token: string,
  tableId: string,
  command: "leave" | "ready" | "start" | "next",
  body?: Record<string, unknown>,
): Promise<TableView | { ok: true }> {
  return request<TableView | { ok: true }>(`/api/tables/${encodeURIComponent(tableId)}/${command}`, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  }, token);
}

export function sendPokerAction(
  token: string,
  tableId: string,
  action: PokerAction,
  target?: number,
): Promise<TableView> {
  return request<TableView>(`/api/tables/${encodeURIComponent(tableId)}/action`, {
    method: "POST",
    body: JSON.stringify({ action, target }),
  }, token);
}
