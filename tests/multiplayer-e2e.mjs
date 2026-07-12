const base = process.env.MULTIPLAYER_API_URL ?? "http://127.0.0.1:8787";

async function call(path, init = {}, token) {
  const headers = {
    ...(init.body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const suffix = String(Date.now()).slice(-6);
const aliceId = `Alice_${suffix}`;
const bobId = `Bob_${suffix}`;
const carolId = `Carol_${suffix}`;
const alice = await call("/api/session", { method: "POST", body: JSON.stringify({ playerId: aliceId }) });
const bob = await call("/api/session", { method: "POST", body: JSON.stringify({ playerId: bobId }) });
const carol = await call("/api/session", { method: "POST", body: JSON.stringify({ playerId: carolId }) });

const duplicateResponse = await fetch(`${base}/api/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ playerId: aliceId }),
});
if (duplicateResponse.status !== 409) throw new Error("duplicate id was not rejected");

const anonymousLobby = await fetch(`${base}/api/lobby`);
if (anonymousLobby.status !== 401) throw new Error("lobby did not require a player session");

const created = await call("/api/tables", {
  method: "POST",
  body: JSON.stringify({ name: "真人测试桌", maxPlayers: 2 }),
}, alice.token);
await call(`/api/tables/${created.tableId}/join`, { method: "POST" }, bob.token);

const lobby = await call("/api/lobby", {}, alice.token);
const listed = lobby.tables.find((table) => table.id === created.tableId);
if (!listed || listed.joinedCount !== 2 || listed.maxPlayers !== 2) throw new Error("lobby counts were not shared");

await call(`/api/tables/${created.tableId}/ready`, { method: "POST", body: JSON.stringify({ ready: true }) }, alice.token);
await call(`/api/tables/${created.tableId}/ready`, { method: "POST", body: JSON.stringify({ ready: true }) }, bob.token);
let aliceView = await call(`/api/tables/${created.tableId}/start`, { method: "POST" }, alice.token);
const bobView = await call(`/api/tables/${created.tableId}/state`, {}, bob.token);

const aliceSelf = aliceView.table.game.players.find((player) => player.name === aliceId);
const aliceViewOfBob = aliceView.table.game.players.find((player) => player.name === bobId);
const bobSelf = bobView.table.game.players.find((player) => player.name === bobId);
if (aliceSelf.hole.length !== 2 || bobSelf.hole.length !== 2 || aliceViewOfBob.hole.length !== 0) {
  throw new Error("private hole-card filtering failed");
}
if (JSON.stringify(aliceView).includes('"deck"') || JSON.stringify(aliceView).includes('"seed"')) {
  throw new Error("private game state leaked to a player");
}

await call(`/api/tables/${created.tableId}/leave`, { method: "POST" }, bob.token);
aliceView = await call(`/api/tables/${created.tableId}/state`, {}, alice.token);
if (aliceView.table.status !== "showdown") throw new Error("leaving actor did not finish the heads-up hand");
await call(`/api/tables/${created.tableId}/join`, { method: "POST" }, carol.token);
const carolView = await call(`/api/tables/${created.tableId}/state`, {}, carol.token);
const carolSeat = carolView.table.seats.find((seat) => seat.playerId === carolId)?.seat;
if (!Number.isInteger(carolSeat) || carolSeat < 0 || carolSeat >= carolView.table.maxPlayers) {
  throw new Error("departed seat was not safely reused");
}
aliceView = await call(`/api/tables/${created.tableId}/next`, { method: "POST" }, alice.token);

let actions = 0;
while (aliceView.table.status === "playing" && actions < 60) {
  const game = aliceView.table.game;
  const actorId = game.pending[0];
  const actor = game.players.find((player) => player.id === actorId);
  const action = game.currentBet > actor.streetBet ? "call" : "check";
  const token = actorId === aliceId ? alice.token : carol.token;
  aliceView = await call(`/api/tables/${created.tableId}/action`, {
    method: "POST",
    body: JSON.stringify({ action }),
  }, token);
  actions += 1;
}
if (aliceView.table.status !== "showdown") throw new Error("hand did not reach showdown");

await call(`/api/tables/${created.tableId}/leave`, { method: "POST" }, carol.token);
await call(`/api/tables/${created.tableId}/leave`, { method: "POST" }, alice.token);
const cleanedLobby = await call("/api/lobby", {}, alice.token);
if (cleanedLobby.tables.some((table) => table.id === created.tableId)) throw new Error("test table was not cleaned up");

console.log(JSON.stringify({
  sessions: 3,
  duplicateRejected: true,
  lobbyRequiresSession: true,
  lobbyCount: listed.joinedCount,
  privateCardsProtected: true,
  departedSeatReused: true,
  testTableCleaned: true,
  actions,
  finalStatus: aliceView.table.status,
}));
