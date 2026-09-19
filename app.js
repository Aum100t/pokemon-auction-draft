import { db } from "./firebase-config.js";
import {
  ref, set, get, push, onValue, update, onDisconnect, child, runTransaction
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { POKEMON_LIST } from "./pokemon-list.js";

// ---------- Utility ----------
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function generatePlayerId() {
  return "p_" + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

// ---------- State ----------
let currentRoomId = null;
let currentPlayerId = null;
let isHost = false;
let currentFilter = "all";
let currentSearch = "";
let currentSection = "pool";
let currentWeekView = 1;
let latestRoom = null;
let disconnectCancelled = false;

// ---------- DOM ----------
const screenHome = document.getElementById("screen-home");
const screenLobby = document.getElementById("screen-lobby");
const screenGame = document.getElementById("screen-game");
const screenPostgame = document.getElementById("screen-postgame");

const tabCreate = document.getElementById("tab-create");
const tabJoin = document.getElementById("tab-join");
const formCreate = document.getElementById("form-create");
const formJoin = document.getElementById("form-join");
const homeError = document.getElementById("home-error");

tabCreate.addEventListener("click", () => {
  tabCreate.classList.add("active");
  tabJoin.classList.remove("active");
  formCreate.classList.remove("hidden");
  formJoin.classList.add("hidden");
  homeError.textContent = "";
});
tabJoin.addEventListener("click", () => {
  tabJoin.classList.add("active");
  tabCreate.classList.remove("active");
  formJoin.classList.remove("hidden");
  formCreate.classList.add("hidden");
  homeError.textContent = "";
});

// ---------- Create Room ----------
document.getElementById("btn-create").addEventListener("click", async () => {
  const name = document.getElementById("create-name").value.trim();
  const maxPlayers = parseInt(document.getElementById("create-max-players").value);
  if (!name) { homeError.textContent = "กรุณากรอกชื่อ"; return; }

  const roomId = generateRoomCode();
  const playerId = generatePlayerId();

  const roomData = {
    hostId: playerId,
    status: "waiting",
    settings: {
      maxPlayers: maxPlayers,
      startMoney: 10000,
      minBidIncrement: 50,
      timerSeconds: 10,
      teamSize: 10
    },
    players: {
      [playerId]: {
        name: name,
        money: 10000,
        isHost: true,
        joinedAt: Date.now(),
        pickTicketUsed: false,
        banTicketUsed: false,
        team: []
      }
    },
    createdAt: Date.now()
  };

  await set(ref(db, "rooms/" + roomId), roomData);
  onDisconnect(ref(db, `rooms/${roomId}/players/${playerId}`)).remove();
  enterLobby(roomId, playerId, true);
});

// ---------- Join Room ----------
document.getElementById("btn-join").addEventListener("click", async () => {
  const name = document.getElementById("join-name").value.trim();
  const code = document.getElementById("join-code").value.trim().toUpperCase();
  if (!name) { homeError.textContent = "กรุณากรอกชื่อ"; return; }
  if (!code) { homeError.textContent = "กรุณากรอกรหัสห้อง"; return; }

  const roomRef = ref(db, "rooms/" + code);
  const snapshot = await get(roomRef);
  if (!snapshot.exists()) { homeError.textContent = "ไม่พบห้องนี้"; return; }

  const room = snapshot.val();
  if (room.status !== "waiting") { homeError.textContent = "ห้องนี้เริ่มเกมไปแล้ว"; return; }

  const currentPlayers = room.players ? Object.keys(room.players).length : 0;
  if (currentPlayers >= room.settings.maxPlayers) { homeError.textContent = "ห้องเต็มแล้ว"; return; }

  const playerId = generatePlayerId();
  await update(ref(db, `rooms/${code}/players/${playerId}`), {
    name: name,
    money: room.settings.startMoney,
    isHost: false,
    joinedAt: Date.now(),
    pickTicketUsed: false,
    banTicketUsed: false,
    team: []
  });

  onDisconnect(ref(db, `rooms/${code}/players/${playerId}`)).remove();
  enterLobby(code, playerId, false);
});

// ---------- Lobby ----------
function enterLobby(roomId, playerId, hostStatus) {
  currentRoomId = roomId;
  currentPlayerId = playerId;
  isHost = hostStatus;
  disconnectCancelled = false;

  localStorage.setItem("pokeAuction_roomId", roomId);
  localStorage.setItem("pokeAuction_playerId", playerId);

  screenHome.classList.add("hidden");
  screenLobby.classList.remove("hidden");
  document.getElementById("lobby-room-code").textContent = roomId;

  const startBtn = document.getElementById("btn-start");
  const waitMsg = document.getElementById("lobby-wait-msg");
  if (isHost) {
    startBtn.classList.remove("hidden");
    waitMsg.classList.add("hidden");
  } else {
    startBtn.classList.add("hidden");
    waitMsg.classList.remove("hidden");
  }

  onValue(ref(db, "rooms/" + roomId), (snapshot) => {
    if (!snapshot.exists()) return;
    const room = snapshot.val();
    latestRoom = room;

    // เกมเริ่มแล้ว -> ยกเลิกการลบอัตโนมัติตอนหลุดการเชื่อมต่อ
    if (room.status !== "waiting" && !disconnectCancelled) {
      onDisconnect(ref(db, `rooms/${roomId}/players/${playerId}`)).cancel();
      disconnectCancelled = true;
    }

    if (room.status === "waiting") {
      screenGame.classList.add("hidden");
      screenPostgame.classList.add("hidden");
      screenLobby.classList.remove("hidden");
      document.querySelector(".container").classList.remove("game-mode");
      currentWeekView = 1;
      currentFilter = "all";
      currentSearch = "";
      renderLobby(room);
    } else if (room.status === "finished") {
      screenLobby.classList.add("hidden");
      screenGame.classList.add("hidden");
      screenPostgame.classList.remove("hidden");
      document.querySelector(".container").classList.add("game-mode");
      renderPostgame(room);
    } else {
      screenLobby.classList.add("hidden");
      screenPostgame.classList.add("hidden");
      screenGame.classList.remove("hidden");
      document.querySelector(".container").classList.add("game-mode");
      renderGame(room);
    }
  });
}

function renderLobby(room) {
  const players = room.players || {};
  const playerIds = Object.keys(players);
  const maxPlayers = room.settings.maxPlayers;

  document.getElementById("lobby-count").textContent = `ผู้เล่น ${playerIds.length}/${maxPlayers}`;

  const listEl = document.getElementById("lobby-player-list");
  listEl.innerHTML = "";
  playerIds.forEach((pid) => {
    const p = players[pid];
    const li = document.createElement("li");
    li.innerHTML = `<span>${p.name}</span>${p.isHost ? '<span class="badge">HOST</span>' : ''}`;
    listEl.appendChild(li);
  });

  if (isHost) {
    const startBtn = document.getElementById("btn-start");
    startBtn.disabled = false;
    startBtn.textContent = playerIds.length >= 2
      ? `เริ่มเกม (${playerIds.length} คน)`
      : "รอผู้เล่น... (อย่างน้อย 2 คน)";
    if (playerIds.length < 2) startBtn.disabled = true;
  }
}

// ---------- Start Game ----------
async function fetchPokeData(entry) {
  const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${entry.apiName}`);
  if (!res.ok) throw new Error("โหลดข้อมูลไม่สำเร็จ: " + entry.apiName);
  const data = await res.json();
  const sprite =
    data.sprites?.other?.["official-artwork"]?.front_default ||
    data.sprites?.front_default || "";
  return {
    id: entry.id,
    displayName: entry.displayName,
    isMega: entry.isMega,
    sprite,
    status: "available",
    ownerId: null,
    bannedBy: null
  };
}

document.getElementById("btn-start").addEventListener("click", async () => {
  if (!isHost || !currentRoomId) return;
  const btn = document.getElementById("btn-start");
  btn.disabled = true;
  btn.textContent = "กำลังโหลดข้อมูลโปเกม่อน...";

  try {
    const poolArr = await Promise.all(POKEMON_LIST.map(fetchPokeData));
    const pool = {};
    poolArr.forEach(p => (pool[p.id] = p));

    const roomSnap = await get(ref(db, "rooms/" + currentRoomId));
    const room = roomSnap.val();
    const playerIds = Object.keys(room.players);
    for (let i = playerIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
    }

    await update(ref(db, "rooms/" + currentRoomId), {
      status: "picking",
      pool,
      turnOrder: playerIds,
      currentTurnIndex: 0,
      auction: null
    });
  } catch (err) {
    alert("เกิดข้อผิดพลาด: " + err.message);
    btn.disabled = false;
    btn.textContent = "เริ่มเกม";
  }
});

// ---------- Transaction helper ----------
async function updateRoom(mutator) {
  const roomRef = ref(db, "rooms/" + currentRoomId);
  await runTransaction(roomRef, (room) => {
    if (room === null) return room;
    return mutator(room);
  });
}

function advanceTurn(room) {
  const n = room.turnOrder.length;
  room.currentTurnIndex = (room.currentTurnIndex + 1) % n;
}

// ---------- League / Round-Robin Schedule ----------
function generateRoundRobinSchedule(playerIds) {
  let ids = [...playerIds];
  if (ids.length % 2 !== 0) ids.push(null);
  const n = ids.length;
  const rounds = n - 1;
  const half = n / 2;
  let arr = ids.slice();
  const weeks = [];

  for (let r = 0; r < rounds; r++) {
    const matches = [];
    for (let i = 0; i < half; i++) {
      const p1 = arr[i];
      const p2 = arr[n - 1 - i];
      if (p1 === null || p2 === null) {
        const byePlayer = p1 === null ? p2 : p1;
        matches.push({ player1Id: byePlayer, player2Id: null, isBye: true, winnerId: byePlayer });
      } else {
        matches.push({ player1Id: p1, player2Id: p2, isBye: false, winnerId: null });
      }
    }
    weeks.push({ weekNumber: r + 1, matches });

    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop());
    arr = [fixed, ...rest];
  }
  return weeks;
}

function generateLeagueIfNeeded(room) {
  if (room.league) return;
  const playerIds = Object.keys(room.players);
  room.league = { weeks: generateRoundRobinSchedule(playerIds) };
}

function checkGameEnd(room) {
  const allFull = Object.values(room.players).every(
    p => (p.team ? p.team.length : 0) >= room.settings.teamSize
  );
  const poolExhausted = Object.values(room.pool).every(
    p => p.status !== "available" && p.status !== "auctioning"
  );
  if (allFull || poolExhausted) {
    room.status = "finished";
    generateLeagueIfNeeded(room);
  }
}

// ---------- Actions ----------
async function nominatePokemon(poolKey) {
  await updateRoom((room) => {
    if (room.status !== "picking" || room.auction) return room;
    if (room.turnOrder[room.currentTurnIndex] !== currentPlayerId) return room;
    const poke = room.pool[poolKey];
    if (!poke || poke.status !== "available") return room;
    poke.status = "auctioning";
    room.auction = {
      poolKey,
      displayName: poke.displayName,
      isMega: poke.isMega,
      sprite: poke.sprite,
      nominatedBy: currentPlayerId,
      nominatedByName: room.players[currentPlayerId].name,
      currentBid: 0,
      currentBidderId: null,
      currentBidderName: null,
      endTime: Date.now() + room.settings.timerSeconds * 1000
    };
    return room;
  });
}

async function placeBid(amount) {
  await updateRoom((room) => {
    if (!room.auction || Date.now() >= room.auction.endTime) return room;
    const player = room.players[currentPlayerId];
    if (!player) return room;
    if ((player.team?.length || 0) >= room.settings.teamSize) return room;
    const minNext = room.auction.currentBid + room.settings.minBidIncrement;
    if (amount < minNext || amount > player.money) return room;
    room.auction.currentBid = amount;
    room.auction.currentBidderId = currentPlayerId;
    room.auction.currentBidderName = player.name;
    room.auction.endTime = Date.now() + room.settings.timerSeconds * 1000;
    return room;
  });
}

async function usePickTicket(poolKey) {
  await updateRoom((room) => {
    const player = room.players[currentPlayerId];
    if (!player || player.pickTicketUsed) return room;
    if ((player.team?.length || 0) >= room.settings.teamSize) return room;
    const poke = room.pool[poolKey];
    if (!poke || poke.status === "banned" || poke.status === "owned" || poke.status === "discarded") return room;
    if (poke.status === "auctioning" && room.auction?.nominatedBy === currentPlayerId) return room;

    poke.status = "owned";
    poke.ownerId = currentPlayerId;
    player.pickTicketUsed = true;
    if (!player.team) player.team = [];
    player.team.push({ id: poke.id, displayName: poke.displayName, isMega: poke.isMega, sprite: poke.sprite, viaTicket: true });

    if (room.auction && room.auction.poolKey === poolKey) {
      room.auction = null;
      advanceTurn(room);
    }
    checkGameEnd(room);
    return room;
  });
}

async function useBanTicket(poolKey) {
  await updateRoom((room) => {
    const player = room.players[currentPlayerId];
    if (!player || player.banTicketUsed) return room;
    const poke = room.pool[poolKey];
    if (!poke || poke.status !== "available") return room;
    poke.status = "banned";
    poke.bannedBy = currentPlayerId;
    player.banTicketUsed = true;
    checkGameEnd(room);
    return room;
  });
}

async function resolveAuctionIfExpired() {
  await updateRoom((room) => {
    if (!room.auction || Date.now() < room.auction.endTime) return room;
    const auction = room.auction;
    const poke = room.pool[auction.poolKey];

    if (auction.currentBidderId) {
      const winner = room.players[auction.currentBidderId];
      winner.money -= auction.currentBid;
      if (!winner.team) winner.team = [];
      winner.team.push({
        id: poke.id, displayName: poke.displayName, isMega: poke.isMega,
        sprite: poke.sprite, price: auction.currentBid
      });
      poke.status = "owned";
      poke.ownerId = auction.currentBidderId;
    } else {
      poke.status = "discarded";
    }

    room.auction = null;
    advanceTurn(room);
    checkGameEnd(room);
    return room;
  });
}

async function setMatchWinner(weekNumber, matchIndex, winnerId) {
  await updateRoom((room) => {
    if (currentPlayerId !== room.hostId) return room;
    if (!room.league) return room;
    const week = room.league.weeks.find(w => w.weekNumber === weekNumber);
    if (!week) return room;
    const match = week.matches[matchIndex];
    if (!match || match.isBye) return room;
    match.winnerId = winnerId;
    return room;
  });
}

// รีเซ็ตห้องเดิมให้เริ่มประมูลรอบใหม่ (เฉพาะโฮสต์)
async function startNewSeason() {
  await updateRoom((room) => {
    if (currentPlayerId !== room.hostId) return room;
    Object.keys(room.players).forEach(pid => {
      const p = room.players[pid];
      p.money = room.settings.startMoney;
      p.team = [];
      p.pickTicketUsed = false;
      p.banTicketUsed = false;
    });
    room.status = "waiting";
    room.pool = null;
    room.turnOrder = null;
    room.currentTurnIndex = null;
    room.auction = null;
    room.league = null;
    return room;
  });
}

setInterval(() => {
  if (currentRoomId && !screenGame.classList.contains("hidden")) {
    resolveAuctionIfExpired();
  }
}, 1000);

setInterval(() => {
  if (!latestRoom || !latestRoom.auction) return;
  const timerEl = document.getElementById("auc-timer");
  if (!timerEl) return;
  const remain = Math.max(0, Math.ceil((latestRoom.auction.endTime - Date.now()) / 1000));
  timerEl.textContent = remain;
}, 250);

// ---------- Render Game Screen (ระหว่างประมูล) ----------
function renderGame(room) {
  document.getElementById("game-room-code").textContent = currentRoomId;
  if (!room.turnOrder) return;

  const myTurnPid = room.turnOrder[room.currentTurnIndex];
  const isMyTurn = myTurnPid === currentPlayerId;
  const me = room.players[currentPlayerId];
  const meFull = (me.team?.length || 0) >= room.settings.teamSize;

  const turnIndicator = document.getElementById("turn-indicator");
  if (isMyTurn) {
    turnIndicator.textContent = meFull
      ? "🎯 ตาของคุณ (ทีมเต็มแล้ว แต่ยังเสนอประมูลให้คนอื่นได้)"
      : "🎯 ตาของคุณ! เลือกโปเกม่อนขึ้นประมูล";
  } else {
    turnIndicator.textContent = `⏳ ตาของ: ${room.players[myTurnPid]?.name || "-"}`;
  }
  turnIndicator.classList.toggle("my-turn", isMyTurn);

  document.getElementById("my-money").textContent = me.money.toLocaleString();
  document.getElementById("my-team-count").textContent = `${(me.team||[]).length}/${room.settings.teamSize}`;
  document.getElementById("team-tab-count").textContent = `${(me.team||[]).length}/${room.settings.teamSize}`;
  document.getElementById("my-pick-status").textContent = me.pickTicketUsed ? "❌" : "🎫";
  document.getElementById("my-ban-status").textContent = me.banTicketUsed ? "❌" : "🚫";

  const strip = document.getElementById("players-strip");
  strip.innerHTML = room.turnOrder.map(pid => {
    const p = room.players[pid];
    const active = pid === myTurnPid;
    const full = (p.team?.length || 0) >= room.settings.teamSize;
    return `<div class="player-chip ${active ? 'active-turn' : ''}">
      <div>${p.name}${pid === currentPlayerId ? ' (คุณ)' : ''}${full ? ' ✅' : ''}</div>
      <div class="p-money">💰${p.money.toLocaleString()} | 🎒${(p.team||[]).length}/${room.settings.teamSize}</div>
    </div>`;
  }).join("");

  const aucBox = document.getElementById("auction-box");
  if (room.auction) {
    aucBox.classList.remove("hidden");
    const a = room.auction;
    document.getElementById("auc-img").src = a.sprite;
    document.getElementById("auc-name").innerHTML = a.displayName + (a.isMega ? '<span class="mega-tag">MEGA</span>' : '');
    document.getElementById("auc-nominator").textContent = `เสนอโดย: ${a.nominatedByName}`;
    document.getElementById("auc-bid").textContent = a.currentBidderId
      ? `บิดล่าสุด ${a.currentBid.toLocaleString()} โดย ${a.currentBidderName}`
      : "ยังไม่มีการบิด (ถ้าหมดเวลาไม่มีคนบิด ตัวนี้จะตกไปกองขยะ)";

    const remain = Math.max(0, Math.ceil((a.endTime - Date.now()) / 1000));
    document.getElementById("auc-timer").textContent = remain;

    const increment = room.settings.minBidIncrement;
    const controlsDiv = document.getElementById("bid-controls");
    controlsDiv.innerHTML = "";
    if (!meFull) {
      [increment, increment * 2, increment * 5].forEach(step => {
        const amt = a.currentBid + step;
        if (amt <= me.money) {
          const b = document.createElement("button");
          b.textContent = `บิด ${amt.toLocaleString()}`;
          b.onclick = () => placeBid(amt);
          controlsDiv.appendChild(b);
        }
      });
    } else {
      controlsDiv.innerHTML = '<p class="small-text">ทีมของคุณเต็มแล้ว ไม่สามารถบิดได้</p>';
    }

    const customBtn = document.getElementById("btn-custom-bid");
    customBtn.disabled = meFull;
    customBtn.onclick = () => {
      const val = parseInt(document.getElementById("custom-bid-input").value);
      if (!isNaN(val)) placeBid(val);
    };

    const snipeBtn = document.getElementById("btn-snipe-current");
    const canSnipe = !me.pickTicketUsed && !meFull && a.nominatedBy !== currentPlayerId;
    snipeBtn.classList.toggle("hidden", !canSnipe);
    snipeBtn.onclick = () => usePickTicket(a.poolKey);
  } else {
    aucBox.classList.add("hidden");
  }

  renderPool(room, isMyTurn, me);
  renderMyTeam(me, room.settings.teamSize);
}

function renderPool(room, isMyTurn, me) {
  const grid = document.getElementById("pool-grid");
  grid.innerHTML = "";
  const meFull = (me.team?.length || 0) >= room.settings.teamSize;

  Object.values(room.pool).forEach(poke => {
    if (currentFilter === "normal" && poke.isMega) return;
    if (currentFilter === "mega" && !poke.isMega) return;
    if (currentSearch && !poke.displayName.toLowerCase().includes(currentSearch)) return;

    const card = document.createElement("div");
    card.className = `poke-card status-${poke.status}`;
    let html = `<img src="${poke.sprite}" alt=""><div class="name">${poke.displayName}${poke.isMega ? '<br><span class="mega-tag">MEGA</span>' : ''}</div>`;

    if (poke.status === "owned") {
      html += `<div class="owner-tag">👤 ${room.players[poke.ownerId]?.name || "?"}</div>`;
    } else if (poke.status === "banned") {
      html += `<div class="owner-tag">🚫 ถูกแบน</div>`;
    } else if (poke.status === "discarded") {
      html += `<div class="owner-tag">🗑️ ตกไปแล้ว</div>`;
    } else {
      html += `<div class="card-actions">`;
      if (poke.status === "available" && !room.auction && isMyTurn) {
        html += `<button class="btn-nominate" data-action="nominate" data-id="${poke.id}">เสนอประมูล</button>`;
      }
      if (poke.status === "available" && !me.banTicketUsed) {
        html += `<button class="btn-ban" data-action="ban" data-id="${poke.id}">แบน 🚫</button>`;
      }
      const cantSnipeOwn = poke.status === "auctioning" && room.auction?.nominatedBy === currentPlayerId;
      if (!me.pickTicketUsed && !meFull && !cantSnipeOwn) {
        html += `<button class="btn-pick" data-action="pick" data-id="${poke.id}">ใช้ตั๋วเลือก 🎫</button>`;
      }
      if (poke.status === "auctioning") html += `<div class="owner-tag">⚔️ กำลังประมูล</div>`;
      html += `</div>`;
    }
    card.innerHTML = html;
    grid.appendChild(card);
  });

  grid.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === "nominate") nominatePokemon(id);
      if (action === "ban") useBanTicket(id);
      if (action === "pick") usePickTicket(id);
    });
  });
}

function renderMyTeam(me, teamSize) {
  const grid = document.getElementById("my-team-grid");
  grid.innerHTML = "";
  const team = me.team || [];
  for (let i = 0; i < teamSize; i++) {
    const t = team[i];
    const slot = document.createElement("div");
    slot.className = "team-slot" + (t ? "" : " empty");
    slot.innerHTML = t
      ? `<img src="${t.sprite}" alt=""><span>${t.displayName}${t.isMega ? ' 🌟' : ''}</span>`
      : "ว่าง";
    grid.appendChild(slot);
  }
}

document.querySelectorAll(".pool-tabs button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".pool-tabs button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    rerenderPoolOnly();
  });
});

document.getElementById("pool-search").addEventListener("input", (e) => {
  currentSearch = e.target.value.trim().toLowerCase();
  rerenderPoolOnly();
});

document.getElementById("sec-tab-pool").addEventListener("click", () => {
  currentSection = "pool";
  document.getElementById("sec-tab-pool").classList.add("active");
  document.getElementById("sec-tab-team").classList.remove("active");
  document.getElementById("pool-section").classList.remove("hidden");
  document.getElementById("team-section").classList.add("hidden");
});
document.getElementById("sec-tab-team").addEventListener("click", () => {
  currentSection = "team";
  document.getElementById("sec-tab-team").classList.add("active");
  document.getElementById("sec-tab-pool").classList.remove("active");
  document.getElementById("team-section").classList.remove("hidden");
  document.getElementById("pool-section").classList.add("hidden");
});

function rerenderPoolOnly() {
  if (!latestRoom || !latestRoom.turnOrder || latestRoom.status !== "picking") return;
  const myTurnPid = latestRoom.turnOrder[latestRoom.currentTurnIndex];
  const me = latestRoom.players[currentPlayerId];
  renderPool(latestRoom, myTurnPid === currentPlayerId, me);
}

// ---------- Render Post-game Screen (สรุปทีม + ลีก) ----------
function renderPostgame(room) {
  renderTeamsSummary(room);
  renderLeague(room);
  const newSeasonBtn = document.getElementById("btn-new-season");
  if (newSeasonBtn) newSeasonBtn.classList.toggle("hidden", !isHost);
}

function renderTeamsSummary(room) {
  const grid = document.getElementById("teams-summary-grid");
  grid.innerHTML = Object.entries(room.players).map(([pid, p]) => `
    <div class="team-summary-card">
      <h4>${p.name}${pid === room.hostId ? ' <span class="badge">HOST</span>' : ''}</h4>
      <p class="small-text">เงินคงเหลือ: ${p.money.toLocaleString()}</p>
      <div class="my-team">
        ${(p.team || []).map(t => `
          <div class="team-slot">
            <img src="${t.sprite}" alt="">
            <span>${t.displayName}${t.isMega ? ' 🌟' : ''}</span>
            ${t.price ? `<span class="price-tag">💰${t.price.toLocaleString()}</span>` : (t.viaTicket ? '<span class="price-tag">🎫 ตั๋ว</span>' : '')}
          </div>`).join("")}
      </div>
    </div>
  `).join("");
}

function computeStandings(room) {
  const stats = {};
  Object.keys(room.players).forEach(pid => {
    stats[pid] = { name: room.players[pid].name, wins: 0, losses: 0, points: 0, played: 0 };
  });

  room.league.weeks.forEach(week => {
    week.matches.forEach(m => {
      if (m.isBye) {
        // BYE ไม่นับแต้ม ไม่นับแข่ง ไม่นับชนะ
        return;
      }

      if (!m.winnerId) return;
      const loserId = m.winnerId === m.player1Id ? m.player2Id : m.player1Id;
      if (stats[m.winnerId]) {
        stats[m.winnerId].wins += 1;
        stats[m.winnerId].points += 3;
        stats[m.winnerId].played += 1;
      }
      if (stats[loserId]) {
        stats[loserId].losses += 1;
        stats[loserId].played += 1;
      }
    });
  });

  return Object.entries(stats)
    .map(([pid, s]) => ({ pid, ...s }))
    .sort((a, b) => b.points - a.points || b.wins - a.wins);
}

function renderLeague(room) {
  if (!room.league) return;
  const weeks = room.league.weeks;

  const weekTabsDiv = document.getElementById("week-tabs");
  weekTabsDiv.innerHTML = weeks.map(w =>
    `<button class="week-tab-btn ${w.weekNumber === currentWeekView ? 'active' : ''}" data-week="${w.weekNumber}">สัปดาห์ ${w.weekNumber}</button>`
  ).join("");
  weekTabsDiv.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      currentWeekView = parseInt(btn.dataset.week);
      renderLeague(room);
    });
  });

  const week = weeks.find(w => w.weekNumber === currentWeekView) || weeks[0];
  const matchesDiv = document.getElementById("week-matches");
  matchesDiv.innerHTML = week.matches.map((m, idx) => {
    if (m.isBye) {
        const p = room.players[m.player1Id];
        return `<div class="match-card bye-card">
          <span>${p?.name || "?"}</span>
          <span class="badge">BYE (ไม่มีคู่แข่งสัปดาห์นี้ ไม่นับแต้ม)</span>
        </div>`;
      }
  
    const p1 = room.players[m.player1Id];
    const p2 = room.players[m.player2Id];
    const p1Win = m.winnerId === m.player1Id;
    const p2Win = m.winnerId === m.player2Id;
    let controls = "";
    if (isHost) {
      controls = `
        <div class="match-controls">
          <button class="btn-winner ${p1Win ? 'selected' : ''}" data-week="${week.weekNumber}" data-idx="${idx}" data-winner="${m.player1Id}">${p1?.name} ชนะ</button>
          <button class="btn-winner ${p2Win ? 'selected' : ''}" data-week="${week.weekNumber}" data-idx="${idx}" data-winner="${m.player2Id}">${p2?.name} ชนะ</button>
        </div>`;
    }
    return `<div class="match-card">
      <div class="match-players">
        <span class="${p1Win ? 'winner-name' : ''}">${p1?.name || "?"}</span>
        <span class="vs">VS</span>
        <span class="${p2Win ? 'winner-name' : ''}">${p2?.name || "?"}</span>
      </div>
      ${m.winnerId ? `<p class="small-text">ผู้ชนะ: ${room.players[m.winnerId]?.name}</p>` : `<p class="small-text">ยังไม่ได้แข่ง</p>`}
      ${controls}
    </div>`;
  }).join("");

  if (isHost) {
    matchesDiv.querySelectorAll(".btn-winner").forEach(btn => {
      btn.addEventListener("click", () => {
        setMatchWinner(parseInt(btn.dataset.week), parseInt(btn.dataset.idx), btn.dataset.winner);
      });
    });
  }

  const standings = computeStandings(room);
  const table = document.getElementById("standings-table");
  table.innerHTML = `
    <tr><th>#</th><th>ผู้เล่น</th><th>แข่ง</th><th>ชนะ</th><th>แพ้</th><th>แต้ม</th></tr>
    ${standings.map((s, i) => `
      <tr class="${s.pid === currentPlayerId ? 'me-row' : ''}">
        <td>${i + 1}</td><td>${s.name}</td><td>${s.played}</td><td>${s.wins}</td><td>${s.losses}</td><td><b>${s.points}</b></td>
      </tr>`).join("")}
  `;
}

document.getElementById("post-tab-teams").addEventListener("click", () => {
  document.getElementById("post-tab-teams").classList.add("active");
  document.getElementById("post-tab-league").classList.remove("active");
  document.getElementById("post-teams-section").classList.remove("hidden");
  document.getElementById("post-league-section").classList.add("hidden");
});
document.getElementById("post-tab-league").addEventListener("click", () => {
  document.getElementById("post-tab-league").classList.add("active");
  document.getElementById("post-tab-teams").classList.remove("active");
  document.getElementById("post-league-section").classList.remove("hidden");
  document.getElementById("post-teams-section").classList.add("hidden");
});

// ---------- Post-game: New Season / Leave Room ----------
document.getElementById("btn-new-season").addEventListener("click", async () => {
  if (!isHost) return;
  const btn = document.getElementById("btn-new-season");
  btn.disabled = true;
  btn.textContent = "กำลังรีเซ็ต...";
  try {
    await startNewSeason();
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 เริ่มฤดูกาลใหม่ (ห้องเดิม)";
  }
});

document.getElementById("btn-leave-room").addEventListener("click", async () => {
  if (currentRoomId && currentPlayerId) {
    try {
      await set(ref(db, `rooms/${currentRoomId}/players/${currentPlayerId}`), null);
    } catch (e) { /* ignore */ }
  }
  localStorage.removeItem("pokeAuction_roomId");
  localStorage.removeItem("pokeAuction_playerId");
  location.reload();
});

// ---------- Auto-rejoin ----------
window.addEventListener("load", async () => {
  const savedRoomId = localStorage.getItem("pokeAuction_roomId");
  const savedPlayerId = localStorage.getItem("pokeAuction_playerId");
  if (savedRoomId && savedPlayerId) {
    const snap = await get(ref(db, `rooms/${savedRoomId}/players/${savedPlayerId}`));
    if (snap.exists()) {
      const roomSnap = await get(ref(db, `rooms/${savedRoomId}`));
      const room = roomSnap.val();
      enterLobby(savedRoomId, savedPlayerId, room.hostId === savedPlayerId);
    }
  }
});