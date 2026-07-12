import {
  STARTING_STACK,
  advanceStreet,
  applyAction,
  canPlayerRaise,
  createStandardDeck,
  dealHandFromDeck,
  forceFold,
  potSize,
  type Card,
  type GameState,
  type Player,
  type PokerAction,
} from "../app/poker-engine";

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
}

interface Env {
  LOBBY: DurableObjectNamespace;
  TABLES: DurableObjectNamespace;
}

type TableStatus = "waiting" | "playing" | "showdown" | "closed";

interface SessionRecord {
  playerId: string;
  normalizedId: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
}

interface Caller {
  playerId: string;
  sessionHash: string;
}

interface SessionRateRecord {
  windowStartedAt: number;
  count: number;
  lastSeenAt: number;
}

interface TableSeat {
  playerId: string;
  sessionHash: string;
  seat: number;
  ready: boolean;
  stack: number;
  joinedAt: number;
  lastSeenAt: number;
  leaving: boolean;
}

interface StoredTable {
  id: string;
  name: string;
  status: TableStatus;
  maxPlayers: number;
  hostId: string;
  hostHash: string;
  seats: TableSeat[];
  game: GameState | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

interface LobbySummary {
  id: string;
  name: string;
  status: TableStatus;
  maxPlayers: number;
  joinedCount: number;
  playerIds: string[];
  handNo: number;
  updatedAt: number;
}

const SESSION_ACTIVE_MS = 30 * 60 * 1000;
const SESSION_CAP = 2000;
const SESSION_RATE_WINDOW_MS = 60 * 1000;
const SESSION_RATE_LIMIT = 12;
const SESSION_RATE_BUCKET_CAP = 256;
const CONNECTION_ACTIVE_MS = 15 * 1000;
const SEAT_INACTIVE_MS = 45 * 1000;
const TABLE_VISIBLE_MS = 24 * 60 * 60 * 1000;
const TABLE_SUMMARY_CAP = 200;
const VALID_ID = /^[\p{L}\p{N}_-]{2,16}$/u;
const VALID_TABLE_ID = /^[a-z0-9-]{4,40}$/;
const ALLOWED_ORIGINS = new Set([
  "https://jackie-cjk.github.io",
  "https://bavi-storm-observatory-2609.jackie-cjk.chatgpt.site",
]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function apiError(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

async function readJson<T extends Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function secureRandomIndex(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error("INVALID_RANDOM_RANGE");
  const range = 0x1_0000_0000;
  const limit = Math.floor(range / maxExclusive) * maxExclusive;
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0] >= limit);
  return values[0] % maxExclusive;
}

function cryptographicDeck(): Card[] {
  const deck = createStandardDeck();
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = secureRandomIndex(index + 1);
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
}

function dealSecureHand(players: Player[], dealer: number, handNo: number): GameState {
  return dealHandFromDeck(players, dealer, handNo, cryptographicDeck());
}

async function tokenHash(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizePlayerId(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function callerFromHeaders(request: Request): Caller | null {
  const playerId = request.headers.get("X-Player-Id");
  const sessionHash = request.headers.get("X-Session-Hash");
  return playerId && sessionHash ? { playerId, sessionHash } : null;
}

function lobbyStub(env: Env): DurableObjectStub {
  return env.LOBBY.get(env.LOBBY.idFromName("global-lobby"));
}

function tableStub(env: Env, tableId: string): DurableObjectStub {
  return env.TABLES.get(env.TABLES.idFromName(tableId));
}

function requestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("Origin");
  headers.set("Access-Control-Allow-Origin", origin && requestOriginAllowed(request) ? origin : "*");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function forward(
  stub: DurableObjectStub,
  path: string,
  request: Request,
  caller?: Caller,
): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "local-or-unknown";
  headers.set("X-Client-IP", clientIp);
  if (caller) {
    headers.set("X-Player-Id", caller.playerId);
    headers.set("X-Session-Hash", caller.sessionHash);
  }
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  return stub.fetch(new Request(`https://internal${path}`, { method: request.method, headers, body }));
}

async function validateCaller(request: Request, env: Env): Promise<Caller | Response> {
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return apiError("UNAUTHORIZED", "请先输入玩家 ID", 401);
  const response = await lobbyStub(env).fetch("https://internal/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) return response;
  return (await response.json()) as Caller;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request);
    }
    if (!requestOriginAllowed(request)) {
      return withCors(apiError("ORIGIN_NOT_ALLOWED", "当前来源不允许访问真人牌局服务", 403), request);
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/session" && request.method === "POST") {
        return withCors(await forward(lobbyStub(env), "/session", request), request);
      }

      const caller = await validateCaller(request, env);
      if (caller instanceof Response) return withCors(caller, request);

      if (url.pathname === "/api/lobby" && request.method === "GET") {
        return withCors(await lobbyStub(env).fetch("https://internal/lobby"), request);
      }

      if (url.pathname === "/api/tables" && request.method === "POST") {
        return withCors(await forward(lobbyStub(env), "/create", request, caller), request);
      }

      const match = url.pathname.match(/^\/api\/tables\/([^/]+)\/(join|leave|ready|start|next|action|state)$/);
      if (!match || !VALID_TABLE_ID.test(match[1])) {
        return withCors(apiError("NOT_FOUND", "接口不存在", 404), request);
      }
      const [, tableId, operation] = match;
      const expectedMethod = operation === "state" ? "GET" : "POST";
      if (request.method !== expectedMethod) {
        return withCors(apiError("METHOD_NOT_ALLOWED", "请求方式不正确", 405), request);
      }
      return withCors(await forward(tableStub(env, tableId), `/${operation}`, request, caller), request);
    } catch (error) {
      console.error("multiplayer api error", error);
      return withCors(apiError("INTERNAL_ERROR", "真人牌局服务暂时繁忙，请稍后重试", 500), request);
    }
  },
};

export class PokerLobby {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/session" && request.method === "POST") return this.openSession(request);
      if (path === "/validate" && request.method === "POST") return this.validateSession(request);
      if (path === "/lobby" && request.method === "GET") return this.listTables();
      if (path === "/create" && request.method === "POST") return this.createTable(request);
      if (path === "/summary" && request.method === "PUT") return this.putSummary(request);
      return apiError("NOT_FOUND", "大厅接口不存在", 404);
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_JSON") return apiError("INVALID_JSON", "请求内容格式不正确", 400);
      console.error("lobby durable object error", error);
      return apiError("LOBBY_ERROR", "真人大厅暂时繁忙", 500);
    }
  }

  private async openSession(request: Request): Promise<Response> {
    const rateError = await this.enforceSessionRate(request);
    if (rateError) return rateError;
    const body = await readJson<{ playerId?: unknown; resumeToken?: unknown }>(request);
    const playerId = typeof body.playerId === "string" ? body.playerId.normalize("NFKC").trim() : "";
    if (!VALID_ID.test(playerId)) {
      return apiError("INVALID_PLAYER_ID", "玩家 ID 需为 2–16 位中文、字母、数字、下划线或短横线", 400);
    }

    const normalizedId = normalizePlayerId(playerId);
    const now = Date.now();
    const activeSessionCount = await this.pruneSessions(now);
    const existingHash = await this.ctx.storage.get<string>(`id:${normalizedId}`);
    const existing = existingHash ? await this.ctx.storage.get<SessionRecord>(`session:${existingHash}`) : undefined;

    if (existing && typeof body.resumeToken === "string" && (await tokenHash(body.resumeToken)) === existing.tokenHash) {
      existing.lastSeenAt = now;
      await this.ctx.storage.put(`session:${existing.tokenHash}`, existing);
      return json({ playerId: existing.playerId, token: body.resumeToken });
    }
    if (existing && now - existing.lastSeenAt < SESSION_ACTIVE_MS) {
      return apiError("PLAYER_ID_IN_USE", "该玩家 ID 已在线，请换一个", 409);
    }
    if (!existing && activeSessionCount >= SESSION_CAP) {
      return apiError("LOBBY_AT_CAPACITY", "真人大厅当前人数已满，请稍后重试", 503);
    }

    if (existingHash) await this.ctx.storage.delete(`session:${existingHash}`);
    const token = randomToken();
    const hash = await tokenHash(token);
    const record: SessionRecord = { playerId, normalizedId, tokenHash: hash, createdAt: now, lastSeenAt: now };
    await this.ctx.storage.put(`id:${normalizedId}`, hash);
    await this.ctx.storage.put(`session:${hash}`, record);
    return json({ playerId, token }, 201);
  }

  private async enforceSessionRate(request: Request): Promise<Response | null> {
    const now = Date.now();
    const ip = request.headers.get("X-Client-IP") ?? "local-or-unknown";
    const key = (await tokenHash(ip)).slice(0, 24);
    const rates = (await this.ctx.storage.get<Record<string, SessionRateRecord>>("session-rates")) ?? {};
    for (const [candidate, rate] of Object.entries(rates)) {
      if (now - rate.lastSeenAt > SESSION_RATE_WINDOW_MS * 2) delete rates[candidate];
    }
    if (!rates[key] && Object.keys(rates).length >= SESSION_RATE_BUCKET_CAP) {
      const oldest = Object.entries(rates).sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)[0]?.[0];
      if (oldest) delete rates[oldest];
    }
    const current = rates[key];
    const rate = !current || now - current.windowStartedAt >= SESSION_RATE_WINDOW_MS
      ? { windowStartedAt: now, count: 0, lastSeenAt: now }
      : current;
    rate.lastSeenAt = now;
    if (rate.count >= SESSION_RATE_LIMIT) {
      rates[key] = rate;
      await this.ctx.storage.put("session-rates", rates);
      return apiError("RATE_LIMITED", "尝试次数过多，请一分钟后再试", 429);
    }
    rate.count += 1;
    rates[key] = rate;
    await this.ctx.storage.put("session-rates", rates);
    return null;
  }

  private async pruneSessions(now: number): Promise<number> {
    const sessions = await this.ctx.storage.list<SessionRecord>({ prefix: "session:", limit: SESSION_CAP + 1 });
    let active = 0;
    for (const [key, record] of sessions) {
      if (now - record.lastSeenAt <= SESSION_ACTIVE_MS) {
        active += 1;
        continue;
      }
      await this.ctx.storage.delete(key);
      const currentHash = await this.ctx.storage.get<string>(`id:${record.normalizedId}`);
      if (currentHash === record.tokenHash) await this.ctx.storage.delete(`id:${record.normalizedId}`);
    }
    return active;
  }

  private async validateSession(request: Request): Promise<Response> {
    const body = await readJson<{ token?: unknown }>(request);
    if (typeof body.token !== "string" || body.token.length < 32) return apiError("UNAUTHORIZED", "登录状态已失效", 401);
    const hash = await tokenHash(body.token);
    const record = await this.ctx.storage.get<SessionRecord>(`session:${hash}`);
    if (!record) return apiError("UNAUTHORIZED", "登录状态已失效，请重新输入 ID", 401);
    const now = Date.now();
    if (now - record.lastSeenAt > SESSION_ACTIVE_MS) {
      await this.ctx.storage.delete(`session:${hash}`);
      const currentHash = await this.ctx.storage.get<string>(`id:${record.normalizedId}`);
      if (currentHash === hash) await this.ctx.storage.delete(`id:${record.normalizedId}`);
      return apiError("SESSION_EXPIRED", "登录状态已过期，请重新输入 ID", 401);
    }
    if (now - record.lastSeenAt > 5000) {
      record.lastSeenAt = now;
      await this.ctx.storage.put(`session:${hash}`, record);
    }
    return json({ playerId: record.playerId, sessionHash: record.tokenHash });
  }

  private async listTables(): Promise<Response> {
    const summaries = (await this.ctx.storage.get<Record<string, LobbySummary>>("tables")) ?? {};
    const changed = this.pruneSummaries(summaries, Date.now());
    if (changed) await this.ctx.storage.put("tables", summaries);
    const tables = Object.values(summaries)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return json({ tables });
  }

  private async createTable(request: Request): Promise<Response> {
    const caller = callerFromHeaders(request);
    if (!caller) return apiError("UNAUTHORIZED", "请先输入玩家 ID", 401);
    const body = await readJson<{ name?: unknown; maxPlayers?: unknown }>(request);
    const name = typeof body.name === "string" ? body.name.normalize("NFKC").trim() : "";
    const maxPlayers = Number(body.maxPlayers);
    if (name.length < 2 || name.length > 16) return apiError("INVALID_TABLE_NAME", "牌桌名称需为 2–16 个字符", 400);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 9) return apiError("INVALID_MAX_PLAYERS", "人数上限需在 2–9 人之间", 400);

    const summaries = (await this.ctx.storage.get<Record<string, LobbySummary>>("tables")) ?? {};
    const summariesChanged = this.pruneSummaries(summaries, Date.now());
    if (summariesChanged) await this.ctx.storage.put("tables", summaries);
    if (Object.keys(summaries).length >= TABLE_SUMMARY_CAP) {
      return apiError("TABLE_LIMIT_REACHED", "当前牌桌数量已满，请稍后重试", 503);
    }

    const tableId = crypto.randomUUID().split("-")[0];
    const response = await tableStub(this.env, tableId).fetch("https://internal/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tableId, name, maxPlayers, hostId: caller.playerId, hostHash: caller.sessionHash }),
    });
    if (!response.ok) return response;
    const summary = (await response.json()) as LobbySummary;
    await this.saveSummary(summary);
    return json({ tableId }, 201);
  }

  private async putSummary(request: Request): Promise<Response> {
    const summary = await readJson<LobbySummary & Record<string, unknown>>(request);
    if (!summary.id || !VALID_TABLE_ID.test(summary.id)) return apiError("INVALID_TABLE", "牌桌摘要无效", 400);
    await this.saveSummary(summary);
    return json({ ok: true });
  }

  private async saveSummary(summary: LobbySummary): Promise<void> {
    const summaries = (await this.ctx.storage.get<Record<string, LobbySummary>>("tables")) ?? {};
    this.pruneSummaries(summaries, Date.now());
    if (summary.status === "closed") delete summaries[summary.id];
    else summaries[summary.id] = summary;
    const overflow = Object.values(summaries)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(TABLE_SUMMARY_CAP);
    overflow.forEach((table) => delete summaries[table.id]);
    await this.ctx.storage.put("tables", summaries);
  }

  private pruneSummaries(summaries: Record<string, LobbySummary>, now: number): boolean {
    let changed = false;
    const cutoff = now - TABLE_VISIBLE_MS;
    for (const [id, summary] of Object.entries(summaries)) {
      if (summary.status === "closed" || summary.updatedAt < cutoff) {
        delete summaries[id];
        changed = true;
      }
    }
    const overflow = Object.values(summaries)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(TABLE_SUMMARY_CAP);
    overflow.forEach((summary) => {
      delete summaries[summary.id];
      changed = true;
    });
    return changed;
  }
}

export class PokerTable {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/create" && request.method === "POST") return this.create(request);
      const caller = callerFromHeaders(request);
      if (!caller) return apiError("UNAUTHORIZED", "请先输入玩家 ID", 401);
      await this.sweepInactive(caller);
      if (path === "/join" && request.method === "POST") return this.join(caller);
      if (path === "/state" && request.method === "GET") return this.stateView(caller);
      if (path === "/leave" && request.method === "POST") return this.leave(caller);
      if (path === "/ready" && request.method === "POST") return this.ready(caller, request);
      if (path === "/start" && request.method === "POST") return this.start(caller);
      if (path === "/action" && request.method === "POST") return this.action(caller, request);
      if (path === "/next" && request.method === "POST") return this.next(caller);
      return apiError("NOT_FOUND", "牌桌接口不存在", 404);
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_JSON") return apiError("INVALID_JSON", "请求内容格式不正确", 400);
      console.error("table durable object error", error);
      return apiError("TABLE_ERROR", "牌桌暂时无法同步", 500);
    }
  }

  private async load(): Promise<StoredTable | undefined> {
    return this.ctx.storage.get<StoredTable>("state");
  }

  private async sweepInactive(caller: Caller): Promise<void> {
    const table = await this.load();
    if (!table || table.status === "closed") return;
    const now = Date.now();
    let touched = false;
    const callerSeat = this.member(table, caller);
    if (callerSeat && now - callerSeat.lastSeenAt > 3000) {
      callerSeat.lastSeenAt = now;
      touched = true;
    }

    const staleSeats = table.seats.filter((seat) =>
      !seat.leaving
      && !(seat.playerId === caller.playerId && seat.sessionHash === caller.sessionHash)
      && now - seat.lastSeenAt > SEAT_INACTIVE_MS,
    );
    if (staleSeats.length === 0) {
      if (touched) await this.persist(table, false);
      return;
    }

    if (table.status === "playing" && table.game) {
      for (const seat of staleSeats) {
        seat.leaving = true;
        seat.ready = false;
        const actorIndex = table.game.players.findIndex((player) => player.name === seat.playerId);
        const player = actorIndex >= 0 ? table.game.players[actorIndex] : undefined;
        if (actorIndex >= 0 && player && !player.folded && !player.allIn) {
          table.game = forceFold(table.game, actorIndex, "断线自动弃牌");
        }
      }
      table.game = this.advanceAutomatic(table.game);
      if (table.game.street === "showdown") {
        table.status = "showdown";
        this.syncStacks(table);
      }
    } else {
      const stale = new Set(staleSeats);
      table.seats = table.seats.filter((seat) => !stale.has(seat));
    }

    if (!table.seats.some((seat) => !seat.leaving)) {
      table.status = "closed";
      table.game = null;
    }
    this.reassignHost(table);
    await this.persist(table);
    await this.publishSummary(table);
  }

  private async persist(table: StoredTable, bumpVersion = true): Promise<void> {
    table.updatedAt = Date.now();
    if (bumpVersion) table.version += 1;
    await this.ctx.storage.put("state", table);
  }

  private summary(table: StoredTable): LobbySummary {
    const activeSeats = table.seats.filter((seat) => !seat.leaving || table.status === "playing");
    return {
      id: table.id,
      name: table.name,
      status: table.status,
      maxPlayers: table.maxPlayers,
      joinedCount: activeSeats.length,
      playerIds: activeSeats.map((seat) => seat.playerId),
      handNo: table.game?.handNo ?? 0,
      updatedAt: table.updatedAt,
    };
  }

  private async publishSummary(table: StoredTable): Promise<void> {
    try {
      await lobbyStub(this.env).fetch("https://internal/summary", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.summary(table)),
      });
    } catch (error) {
      console.warn("failed to publish table summary", error);
    }
  }

  private async create(request: Request): Promise<Response> {
    if (await this.load()) return apiError("TABLE_EXISTS", "牌桌已存在", 409);
    const body = await readJson<{ tableId?: unknown; name?: unknown; maxPlayers?: unknown; hostId?: unknown; hostHash?: unknown }>(request);
    const tableId = typeof body.tableId === "string" ? body.tableId : "";
    const name = typeof body.name === "string" ? body.name : "";
    const hostId = typeof body.hostId === "string" ? body.hostId : "";
    const hostHash = typeof body.hostHash === "string" ? body.hostHash : "";
    const maxPlayers = Number(body.maxPlayers);
    if (!VALID_TABLE_ID.test(tableId) || !hostId || !hostHash || !Number.isInteger(maxPlayers)) return apiError("INVALID_TABLE", "牌桌参数无效", 400);
    const now = Date.now();
    const table: StoredTable = {
      id: tableId,
      name,
      status: "waiting",
      maxPlayers,
      hostId,
      hostHash,
      seats: [{ playerId: hostId, sessionHash: hostHash, seat: 0, ready: false, stack: STARTING_STACK, joinedAt: now, lastSeenAt: now, leaving: false }],
      game: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.ctx.storage.put("state", table);
    return json(this.summary(table), 201);
  }

  private member(table: StoredTable, caller: Caller): TableSeat | undefined {
    return table.seats.find((seat) => seat.playerId === caller.playerId && seat.sessionHash === caller.sessionHash);
  }

  private async join(caller: Caller): Promise<Response> {
    const table = await this.load();
    if (!table || table.status === "closed") return apiError("TABLE_NOT_FOUND", "牌桌不存在或已结束", 404);
    const existingById = table.seats.find((seat) => normalizePlayerId(seat.playerId) === normalizePlayerId(caller.playerId));
    if (existingById) {
      if (existingById.sessionHash !== caller.sessionHash) return apiError("DUPLICATE_ID", "该玩家 ID 已在牌桌中", 409);
      existingById.lastSeenAt = Date.now();
      existingById.leaving = false;
      await this.persist(table, false);
      return json({ tableId: table.id });
    }
    if (table.status === "playing") return apiError("HAND_IN_PROGRESS", "牌局正在进行，请等待本手结束", 409);
    if (table.seats.filter((seat) => !seat.leaving).length >= table.maxPlayers) return apiError("TABLE_FULL", "牌桌刚刚满员", 409);
    const occupied = new Set(table.seats.filter((seat) => !seat.leaving).map((seat) => seat.seat));
    let seatNumber = 0;
    while (occupied.has(seatNumber) && seatNumber < table.maxPlayers) seatNumber += 1;
    if (seatNumber >= table.maxPlayers) return apiError("TABLE_FULL", "牌桌刚刚满员", 409);
    table.seats.push({ playerId: caller.playerId, sessionHash: caller.sessionHash, seat: seatNumber, ready: false, stack: STARTING_STACK, joinedAt: Date.now(), lastSeenAt: Date.now(), leaving: false });
    await this.persist(table);
    await this.publishSummary(table);
    return json({ tableId: table.id });
  }

  private async stateView(caller: Caller): Promise<Response> {
    const table = await this.load();
    if (!table || table.status === "closed") return apiError("TABLE_NOT_FOUND", "牌桌不存在或已结束", 404);
    const member = this.member(table, caller);
    if (!member) return apiError("NOT_SEATED", "你尚未加入该牌桌", 403);
    const now = Date.now();
    if (now - member.lastSeenAt > 3000) {
      member.lastSeenAt = now;
      await this.persist(table, false);
    }
    return json(this.filteredView(table, caller));
  }

  private async leave(caller: Caller): Promise<Response> {
    const table = await this.load();
    if (!table) return apiError("TABLE_NOT_FOUND", "牌桌不存在", 404);
    const member = this.member(table, caller);
    if (!member) return json({ ok: true });
    if (table.status === "playing" && table.game) {
      member.leaving = true;
      member.ready = false;
      const actorIndex = table.game.players.findIndex((player) => player.name === caller.playerId);
      if (actorIndex >= 0) {
        table.game = forceFold(table.game, actorIndex);
        table.game = this.advanceAutomatic(table.game);
        if (table.game.street === "showdown") {
          table.status = "showdown";
          this.syncStacks(table);
        }
      }
    } else {
      table.seats = table.seats.filter((seat) => seat !== member);
      if (table.seats.length === 0) table.status = "closed";
    }
    this.reassignHost(table);
    await this.persist(table);
    await this.publishSummary(table);
    return json({ ok: true });
  }

  private async ready(caller: Caller, request: Request): Promise<Response> {
    const table = await this.load();
    if (!table) return apiError("TABLE_NOT_FOUND", "牌桌不存在", 404);
    if (table.status !== "waiting") return apiError("ALREADY_STARTED", "牌局已经开始", 409);
    const member = this.member(table, caller);
    if (!member) return apiError("NOT_SEATED", "你尚未入座", 403);
    const body = await readJson<{ ready?: unknown }>(request);
    member.ready = body.ready === true;
    member.lastSeenAt = Date.now();
    await this.persist(table);
    await this.publishSummary(table);
    return json(this.filteredView(table, caller));
  }

  private async start(caller: Caller): Promise<Response> {
    const table = await this.load();
    if (!table) return apiError("TABLE_NOT_FOUND", "牌桌不存在", 404);
    if (table.hostId !== caller.playerId || table.hostHash !== caller.sessionHash) return apiError("HOST_ONLY", "只有房主可以开始牌局", 403);
    if (table.status !== "waiting") return apiError("ALREADY_STARTED", "牌局已经开始", 409);
    const active = table.seats.filter((seat) => !seat.leaving).sort((left, right) => left.seat - right.seat);
    if (active.length < 2) return apiError("NOT_ENOUGH_PLAYERS", "至少需要两位真人玩家", 409);
    if (!active.every((seat) => seat.ready)) return apiError("PLAYERS_NOT_READY", "请等待所有玩家准备", 409);
    table.game = dealSecureHand(this.enginePlayers(active), 0, 1);
    table.status = "playing";
    await this.persist(table);
    await this.publishSummary(table);
    return json(this.filteredView(table, caller));
  }

  private async action(caller: Caller, request: Request): Promise<Response> {
    const table = await this.load();
    if (!table || !table.game) return apiError("NO_ACTIVE_HAND", "当前没有正在进行的牌局", 409);
    if (table.status !== "playing") return apiError("HAND_FINISHED", "本手牌已经结束", 409);
    const member = this.member(table, caller);
    if (!member || member.leaving) return apiError("NOT_SEATED", "你不在本手牌中", 403);
    const actorIndex = table.game.pending[0];
    const actor = table.game.players[actorIndex];
    if (!actor || actor.name !== caller.playerId) return apiError("NOT_YOUR_TURN", "还没有轮到你行动", 409);
    const body = await readJson<{ action?: unknown; target?: unknown }>(request);
    const action = body.action;
    if (action !== "fold" && action !== "check" && action !== "call" && action !== "wagerTo") return apiError("INVALID_ACTION", "行动类型无效", 400);
    const target = body.target === undefined ? undefined : Number(body.target);
    if (action === "wagerTo" && (!canPlayerRaise(table.game, actorIndex) || (target !== undefined && (!Number.isFinite(target) || target <= table.game.currentBet)))) {
      return apiError("RAISE_NOT_REOPENED", "当前行动尚未重新开放加注", 409);
    }
    const next = applyAction(table.game, actorIndex, action as PokerAction, target);
    if (next === table.game) return apiError("ILLEGAL_ACTION", "当前不能执行该行动", 409);
    table.game = this.advanceAutomatic(next);
    if (table.game.street === "showdown") {
      table.status = "showdown";
      this.syncStacks(table);
    }
    await this.persist(table);
    await this.publishSummary(table);
    return json(this.filteredView(table, caller));
  }

  private async next(caller: Caller): Promise<Response> {
    const table = await this.load();
    if (!table || !table.game) return apiError("NO_FINISHED_HAND", "还没有可继续的牌局", 409);
    if (table.hostId !== caller.playerId || table.hostHash !== caller.sessionHash) return apiError("HOST_ONLY", "只有房主可以开始下一手", 403);
    if (table.status !== "showdown") return apiError("HAND_IN_PROGRESS", "本手牌尚未结束", 409);
    this.syncStacks(table);
    table.seats = table.seats.filter((seat) => !seat.leaving);
    this.reassignHost(table);
    const active = table.seats.sort((left, right) => left.seat - right.seat);
    if (active.length < 2) {
      table.status = active.length ? "waiting" : "closed";
      table.game = null;
      active.forEach((seat) => { seat.ready = false; });
    } else {
      const dealer = (table.game.dealer + 1) % active.length;
      table.game = dealSecureHand(this.enginePlayers(active), dealer, table.game.handNo + 1);
      table.status = "playing";
    }
    await this.persist(table);
    await this.publishSummary(table);
    return json(this.filteredView(table, caller));
  }

  private enginePlayers(seats: TableSeat[]): Player[] {
    return seats.map((seat, index) => ({
      id: index,
      slot: seat.seat,
      name: seat.playerId,
      isHuman: true,
      avatar: seat.playerId.slice(0, 2),
      accent: "#d3a65c",
      stack: seat.stack || STARTING_STACK,
      hole: [],
      folded: false,
      allIn: false,
      streetBet: 0,
      totalBet: 0,
      lastAction: "等待",
    }));
  }

  private advanceAutomatic(game: GameState): GameState {
    let next = game;
    let guard = 0;
    while (next.street !== "showdown" && next.pending.length === 0 && guard < 8) {
      next = advanceStreet(next);
      guard += 1;
    }
    return next;
  }

  private syncStacks(table: StoredTable): void {
    if (!table.game) return;
    for (const seat of table.seats) {
      const player = table.game.players.find((candidate) => candidate.name === seat.playerId);
      if (player) seat.stack = player.stack;
    }
  }

  private reassignHost(table: StoredTable): void {
    const currentHost = table.seats.find((seat) => seat.playerId === table.hostId && !seat.leaving);
    if (currentHost) return;
    const next = table.seats.filter((seat) => !seat.leaving).sort((left, right) => left.seat - right.seat)[0];
    if (next) {
      table.hostId = next.playerId;
      table.hostHash = next.sessionHash;
    }
  }

  private filteredView(table: StoredTable, caller: Caller): Record<string, unknown> {
    const member = this.member(table, caller);
    if (!member) return { error: { code: "NOT_SEATED", message: "你尚未入座" } };
    const now = Date.now();
    const game = table.game;
    const publicGame = game ? {
      street: game.street,
      board: game.board,
      currentBet: game.currentBet,
      lastRaise: game.lastRaise,
      pending: game.pending.map((index) => game.players[index]?.name).filter(Boolean),
      dealer: game.players[game.dealer]?.name ?? "",
      smallBlind: game.players[game.smallBlind]?.name ?? "",
      bigBlind: game.players[game.bigBlind]?.name ?? "",
      handNo: game.handNo,
      pot: game.street === "showdown" ? game.lastPot : potSize(game),
      result: game.result,
      lastPot: game.lastPot,
      winners: game.winners.map((index) => game.players[index]?.name).filter(Boolean),
      players: game.players.map((player) => {
        const reveal = player.name === caller.playerId || (game.street === "showdown" && !player.folded);
        return {
          id: player.name,
          slot: player.slot,
          name: player.name,
          stack: player.stack,
          hole: reveal ? player.hole : [],
          hasCards: player.hole.length === 2,
          folded: player.folded,
          allIn: player.allIn,
          streetBet: player.streetBet,
          lastAction: player.lastAction,
        };
      }),
    } : null;

    return {
      table: {
        id: table.id,
        name: table.name,
        status: table.status,
        maxPlayers: table.maxPlayers,
        joinedCount: table.seats.filter((seat) => !seat.leaving || table.status === "playing").length,
        version: table.version,
        hostId: table.hostId,
        seats: table.seats.filter((seat) => !seat.leaving || table.status === "playing").map((seat) => ({
          playerId: seat.playerId,
          seat: seat.seat,
          ready: seat.ready,
          stack: seat.stack,
          connected: !seat.leaving && now - seat.lastSeenAt < CONNECTION_ACTIVE_MS,
        })),
        game: publicGame,
      },
      me: { playerId: caller.playerId, seat: member.seat, isHost: table.hostId === caller.playerId, ready: member.ready },
    };
  }
}
