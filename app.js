import { db, auth } from "./firebase-config.js";
import {
  ref, set, get, push, onValue, update, onDisconnect, child, runTransaction
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import {
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
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
// แอดมิน (ตรวจสิทธิ์จริงที่ Firebase Rules — ฝั่งนี้แค่ใช้ซ่อน/โชว์ปุ่ม)
let currentUser = null;
let isAdmin = false;
let isOwner = false;
let currentArchiveId = null;
let currentArchiveData = null;
let archiveEditMode = false;
let archivesDirty = false;

// ---------- DOM ----------
const screenHome = document.getElementById("screen-home");
const screenLobby = document.getElementById("screen-lobby");
const screenGame = document.getElementById("screen-game");
const screenPostgame = document.getElementById("screen-postgame");
const screenArchives = document.getElementById("screen-archives");
const screenArchiveDetail = document.getElementById("screen-archive-detail");

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
    // ห้องถูกปิด (โฮสต์ออก หรือไม่เหลือผู้เล่น) -> เด้งกลับหน้าแรก
    if (!snapshot.exists()) {
      localStorage.removeItem("pokeAuction_roomId");
      localStorage.removeItem("pokeAuction_playerId");
      alert("ห้องนี้ถูกปิดแล้ว");
      location.reload();
      return;
    }
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
// ---------- ดึงข้อมูล/รูปโปเกม่อนจาก PokeAPI ----------
// รูปสำรองเมื่อหาจาก PokeAPI ไม่เจอ (ฝังเป็น data URI จะได้ไม่ต้องพึ่งไฟล์ภายนอก)
const FALLBACK_SPRITE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
    '<circle cx="48" cy="48" r="44" fill="#ffcb05" stroke="#1e3c72" stroke-width="6"/>' +
    '<path d="M4 48h88" stroke="#1e3c72" stroke-width="6"/>' +
    '<circle cx="48" cy="48" r="14" fill="#fff" stroke="#1e3c72" stroke-width="6"/>' +
    '</svg>'
  );

// PokeAPI ใช้รูปแบบ "venusaur-mega" / "charizard-mega-x"
// แต่ในลิสต์เราเขียนเป็น "mega-venusaur" / "mega-charizard-x"
// ฟังก์ชันนี้จะไล่เดาชื่อที่เป็นไปได้ตามลำดับ ถ้าตัวแรกไม่เจอก็ลองตัวถัดไป
function apiNameCandidates(pokemon) {
  const n = String(pokemon.apiName || "").toLowerCase().trim();
  const out = [];
  if (n.startsWith("mega-")) {
    const base = n.slice(5);                       // charizard-x
    const m = base.match(/^(.+)-(x|y|z)$/);
    if (m) {
      out.push(`${m[1]}-mega-${m[2]}`, `${m[1]}-mega`, m[1]);
    } else {
      out.push(`${base}-mega`, base);
    }
  } else {
    out.push(n);
    const f = n.match(/^(.+)-(f|female|m|male)$/);
        if (f) out.push(f[1]);
    if (n.includes("-")) out.push(n.split("-")[0]); // ตัดท้ายเป็นร่างพื้นฐาน
  }
  return [...new Set(out.filter(Boolean))];
}

// key ที่ใช้เก็บใน Firebase ต้องไม่มีอักขระ . # $ [ ] /
function poolKeyOf(pokemon) {
  return String(pokemon.apiName || pokemon.id).toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

const spriteCache = new Map();

async function fetchSprite(pokemon) {
  for (const name of apiNameCandidates(pokemon)) {
    if (spriteCache.has(name)) return spriteCache.get(name);
    try {
      const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${name}`);
      if (!res.ok) continue;                        // 404 -> ลองชื่อถัดไป
      const data = await res.json();
      const sprite =
        data?.sprites?.other?.["official-artwork"]?.front_default ||
        data?.sprites?.front_default ||
        FALLBACK_SPRITE;
      spriteCache.set(name, sprite);
      return sprite;
    } catch (e) {
      // เน็ตหลุด/โดน rate limit -> ลองชื่อถัดไป
    }
  }
  return FALLBACK_SPRITE;
}

// ฟังก์ชันหลักที่หน้าเริ่มเกมเรียกใช้ (เดิมหายไป จึงขึ้น error "fetchPokeData is not defined")
async function fetchPokeData(pokemon) {
  return {
    id: poolKeyOf(pokemon),
    numId: pokemon.id,
    apiName: pokemon.apiName,
    displayName: pokemon.displayName,
    isMega: !!pokemon.isMega,
    sprite: await fetchSprite(pokemon),
    status: "available"
  };
}

// ยิงทีละชุด กัน PokeAPI ตัดการเชื่อมต่อเพราะโหลดพร้อมกัน 300+ requests
async function mapWithLimit(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let index = 0, done = 0;
  async function run() {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i]);
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
document.getElementById("btn-start").addEventListener("click", async () => {
  if (!isHost || !currentRoomId) return;
  const btn = document.getElementById("btn-start");
  btn.disabled = true;
  btn.textContent = "กำลังโหลดข้อมูลโปเกม่อน...";

  try {
    const poolArr = await mapWithLimit(POKEMON_LIST, 8, fetchPokeData, (done, total) => {
      btn.textContent = `กำลังโหลดโปเกม่อน... ${done}/${total}`;
    });
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

// ผู้เล่นคนนี้ยัง "บิดได้" อยู่ไหม = ช่องทีมยังไม่เต็ม และมีเงินพอบิดขั้นต่ำ
function canStillBid(player, room) {
  const teamCount = player.team ? player.team.length : 0;
  return teamCount < room.settings.teamSize && (player.money || 0) >= room.settings.minBidIncrement;
}

// สุ่มโปเกม่อนที่ยังว่าง (available) ให้ผู้เล่นที่เงินหมดแต่ทีมยังไม่เต็ม จนครบ
// แจกวนทีละตัวทีละคน เพื่อให้แฟร์ถ้าโปเกม่อนในพูลเหลือไม่พอ
function fillTeamsRandomly(room) {
  const teamSize = room.settings.teamSize;
  const available = Object.values(room.pool).filter(p => p.status === "available");
  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [available[i], available[j]] = [available[j], available[i]];
  }

  const needy = Object.keys(room.players).filter(
    pid => (room.players[pid].team ? room.players[pid].team.length : 0) < teamSize
  );

  let gaveAny = true;
  while (gaveAny && available.length > 0) {
    gaveAny = false;
    for (const pid of needy) {
      const player = room.players[pid];
      if (!player.team) player.team = [];
      if (player.team.length >= teamSize || available.length === 0) continue;
      const poke = available.pop();
      poke.status = "owned";
      poke.ownerId = pid;
      player.team.push({
        id: poke.id,
        displayName: poke.displayName,
        isMega: poke.isMega,
        sprite: poke.sprite,
        viaRandom: true
      });
      gaveAny = true;
    }
  }
}

function checkGameEnd(room) {
  const players = Object.values(room.players);

  const teamSize = room.settings.teamSize;

  // 1) ไม่เหลือใครที่บิดได้แล้ว (ทีมเต็ม หรือเงินหมด) -> คนที่ทีมยังไม่เต็มโดนสุ่มโปเกม่อนให้จนครบ
  //    ตราบใดที่ยังมีคนมีเงิน+ช่องว่าง การประมูลจะดำเนินต่อตามปกติ
  const noOneCanBid = !players.some(p => canStillBid(p, room));

  // 2) เหลือผู้เล่นที่ทีมยังไม่เต็มแค่คนเดียว (คนอื่นเต็มหมดแล้ว) -> ไม่มีคู่แข่ง สุ่มให้เต็มเลย
  const incompleteCount = players.filter(
    p => (p.team ? p.team.length : 0) < teamSize
  ).length;
  const onlyOneLeft = incompleteCount === 1;

  if (noOneCanBid || onlyOneLeft) fillTeamsRandomly(room);

  const allFull = players.every(
    p => (p.team ? p.team.length : 0) >= teamSize
  );
  const poolExhausted = Object.values(room.pool).every(
    p => p.status !== "available" && p.status !== "auctioning"
  );
  if (noOneCanBid || onlyOneLeft || allFull || poolExhausted) {
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
    // ใช้ได้เฉพาะโปเกม่อนที่กำลังขึ้นประมูลอยู่ตอนนี้เท่านั้น
    if (!room.auction || room.auction.poolKey !== poolKey) return room;
    if (!poke || poke.status !== "auctioning") return room;
    if (room.auction.nominatedBy === currentPlayerId) return room;

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
      winner.team.push({        id: poke.id, displayName: poke.displayName, isMega: poke.isMega,
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
    // รอบใหม่ = ทัวร์นาเมนต์ใหม่ -> เริ่มบันทึกไฟล์ archive แยกจากรอบก่อน
    room.archiveId = null;
    room.archiveName = null;
    room.archiveCreatedAt = null;
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
  const meBrokeNotFull = !meFull && me.money < room.settings.minBidIncrement;
  if (meBrokeNotFull) {
    turnIndicator.textContent += " | 💸 เงินหมดแล้ว รอระบบสุ่มโปเกม่อนให้จนครบ";
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
    const broke = !full && p.money < room.settings.minBidIncrement;
    return `<div class="player-chip ${active ? 'active-turn' : ''}">
      <div>${p.name}${pid === currentPlayerId ? ' (คุณ)' : ''}${full ? ' ✅' : ''}${broke ? ' 💸' : ''}</div>
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
    if (!meFull && me.money < increment) {
      controlsDiv.innerHTML = '<p class="small-text">💸 เงินของคุณหมดแล้ว ไม่สามารถบิดได้ (เมื่อไม่เหลือใครบิดได้ ระบบจะสุ่มโปเกม่อนให้จนครบทีม)</p>';
    } else if (!meFull) {
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
    customBtn.disabled = meFull || me.money < increment;
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
  renderOthersTeams(room);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function teamSlotHtml(t, edit) {
  const tag = t.price
    ? `<span class="price-tag">💰${t.price.toLocaleString()}</span>`
    : (t.viaTicket ? '<span class="price-tag">🎫 ตั๋ว</span>'
      : (t.viaRandom ? '<span class="price-tag">🎲 สุ่มให้</span>' : ''));
  const removeBtn = edit
    ? `<button class="slot-remove" title="เอาออกจากทีม" data-remove-pid="${escapeHtml(edit.pid)}" data-remove-idx="${edit.idx}">✕</button>`
    : '';
  return `<div class="team-slot${edit ? ' editable' : ''}">
    ${removeBtn}
    <img src="${t.sprite}" alt="">
    <span>${escapeHtml(t.displayName)}${t.isMega ? ' 🌟' : ''}</span>
    ${tag}
  </div>`;
}

// ดูทีมของผู้เล่นคนอื่นระหว่างดราฟ (อัปเดตสดตามห้อง)
let lastOthersHtml = "";
function renderOthersTeams(room) {
  const grid = document.getElementById("others-team-grid");
  if (!grid || !room.turnOrder) return;
  const teamSize = room.settings.teamSize;

  const html = room.turnOrder
    .filter(pid => pid !== currentPlayerId && room.players[pid])
    .map(pid => {
      const p = room.players[pid];
      const team = p.team || [];
      const body = team.length
        ? team.map(t => teamSlotHtml(t)).join("")
        : '<p class="small-text" style="grid-column:1/-1;">ยังไม่มีโปเกม่อน</p>';
      return `<div class="team-summary-card">
        <h4>${escapeHtml(p.name)}${pid === room.hostId ? ' <span class="badge">HOST</span>' : ''}</h4>
        <p class="small-text">💰${(p.money || 0).toLocaleString()} | 🎒${team.length}/${teamSize}</p>
        <div class="my-team">${body}</div>
      </div>`;
    }).join("") || '<p class="archives-empty">ไม่มีผู้เล่นคนอื่น</p>';

  if (html !== lastOthersHtml) {
    grid.innerHTML = html;
    lastOthersHtml = html;
  }
}

// รายชื่อโปเกม่อนที่ถูกแบน (ไว้โชว์ตอนสรุป และเก็บลงคลังทัวร์นาเมนต์)
function getBannedList(room) {
  return Object.values(room.pool || {})
    .filter(poke => poke.status === "banned")
    .map(poke => ({
      displayName: poke.displayName,
      isMega: !!poke.isMega,
      sprite: poke.sprite || "",
      bannedByName: room.players?.[poke.bannedBy]?.name || "?"
    }));
}

function bannedSummaryHtml(list) {
  const body = list.length
    ? `<div class="my-team">${list.map(b => `
        <div class="team-slot banned-slot">
          <img src="${b.sprite}" alt="">
          <span>${escapeHtml(b.displayName)}${b.isMega ? ' 🌟' : ''}</span>
          <span class="price-tag">🚫 แบนโดย ${escapeHtml(b.bannedByName)}</span>
        </div>`).join("")}</div>`
    : '<p class="small-text">ไม่มีโปเกม่อนที่ถูกแบน</p>';
  return `<div class="team-summary-card banned-card">
    <h4>🚫 โปเกม่อนที่ถูกแบน (${list.length})</h4>
    ${body}
  </div>`;
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
      if (poke.status === "auctioning" && !me.pickTicketUsed && !meFull && !cantSnipeOwn) {
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

function switchSection(name) {
  currentSection = name;
  const map = { pool: "pool-section", team: "team-section", others: "others-section" };
  Object.entries(map).forEach(([key, secId]) => {
    document.getElementById(secId).classList.toggle("hidden", key !== name);
    document.getElementById(`sec-tab-${key}`).classList.toggle("active", key === name);
  });
}
document.getElementById("sec-tab-pool").addEventListener("click", () => switchSection("pool"));
document.getElementById("sec-tab-team").addEventListener("click", () => switchSection("team"));
document.getElementById("sec-tab-others").addEventListener("click", () => switchSection("others"));

function rerenderPoolOnly() {  if (!latestRoom || !latestRoom.turnOrder || latestRoom.status !== "picking") return;
  const myTurnPid = latestRoom.turnOrder[latestRoom.currentTurnIndex];
  const me = latestRoom.players[currentPlayerId];
  renderPool(latestRoom, myTurnPid === currentPlayerId, me);
}

// ---------- Render Post-game Screen (สรุปทีม + ลีก) ----------
function renderPostgame(room) {
  renderTeamsSummary(room);
  renderLeague(room);
  renderArchiveBox(room);
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
            ${t.price ? `<span class="price-tag">💰${t.price.toLocaleString()}</span>` : (t.viaTicket ? '<span class="price-tag">🎫 ตั๋ว</span>' : (t.viaRandom ? '<span class="price-tag">🎲 สุ่มให้</span>' : ''))}
          </div>`).join("")}
      </div>
    </div>
  `).join("");

  const bannedBox = document.getElementById("banned-summary");
  if (bannedBox) bannedBox.innerHTML = bannedSummaryHtml(getBannedList(room));
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

// ---------- ออกจากห้อง (ใช้ร่วมกันทุกหน้าจอ) ----------
async function leaveRoom({ confirmFirst = true } = {}) {
  if (confirmFirst) {
    const msg = isHost && latestRoom?.status === "waiting"
      ? "คุณเป็นโฮสต์ ถ้าออกตอนนี้ห้องจะถูกปิดและผู้เล่นทุกคนจะหลุดออก\nยืนยันออกจากห้อง?"
      : "ยืนยันออกจากห้อง? ทีมและข้อมูลของคุณในห้องนี้จะหายไป";
    if (!confirm(msg)) return;
  }

  const roomId = currentRoomId;
  const playerId = currentPlayerId;

  try {
    if (roomId && playerId) {
      // ยกเลิก onDisconnect ก่อน จะได้ไม่ไปลบข้อมูลซ้ำทีหลัง
      try { await onDisconnect(ref(db, `rooms/${roomId}/players/${playerId}`)).cancel(); } catch (e) {}

      if (isHost && latestRoom?.status === "waiting") {
        // โฮสต์ออกตอนยังไม่เริ่มเกม -> ปิดห้องทิ้งเลย
        await set(ref(db, "rooms/" + roomId), null);
      } else {
        await set(ref(db, `rooms/${roomId}/players/${playerId}`), null);

        // ถ้าออกแล้วไม่เหลือใครในห้อง ก็ลบห้องทิ้ง กัน DB รก
        const rest = await get(ref(db, `rooms/${roomId}/players`));
        if (!rest.exists() || Object.keys(rest.val() || {}).length === 0) {
          await set(ref(db, "rooms/" + roomId), null);
        }
      }
    }
  } catch (e) {
    console.error("leaveRoom error:", e);
  }

  localStorage.removeItem("pokeAuction_roomId");
  localStorage.removeItem("pokeAuction_playerId");
  location.reload();
}

["btn-leave-room", "btn-leave-lobby", "btn-leave-game"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", () => leaveRoom());
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
// =====================================================================
// ระบบคลังทัวร์นาเมนต์ (Archives)
// - บันทึกผลของรอบที่ประมูลเสร็จแล้วไว้ที่ /archives/{archiveId} (แยกจาก /rooms)
// - ใครก็เข้ามาดูได้จากหน้าแรก โดยไม่ต้องมีรหัสห้อง
// - โฮสต์กด "บันทึก" ครั้งแรกเพื่อตั้งชื่อ จากนั้นกด "อัปเดตผลล่าสุด" ได้เรื่อย ๆ
//   (เช่น หลังจากกรอกผลแข่งแต่ละสัปดาห์เพิ่ม)
// =====================================================================

function renderArchiveBox(room) {
  const statusEl = document.getElementById("archive-status");
  const controlsEl = document.getElementById("archive-save-controls");
  const nameInput = document.getElementById("archive-name-input");
  const btn = document.getElementById("btn-save-archive");
  if (!statusEl || !btn) return;

  const saved = !!room.archiveId;

  if (saved) {
    statusEl.innerHTML = `บันทึกแล้วในชื่อ <span class="archive-saved-text">"${room.archiveName || ""}"</span> — ใครก็เข้าไปดูได้จากหน้าแรก`;
    nameInput.classList.add("hidden");
    btn.textContent = "🔄 อัปเดตผลล่าสุด";
  } else {
    statusEl.textContent = isHost
      ? "ตั้งชื่อทัวร์นาเมนต์นี้แล้วกดบันทึก เพื่อให้ทุกคนเข้ามาดูย้อนหลังได้"
      : "ยังไม่ได้บันทึกทัวร์นาเมนต์นี้ (รอโฮสต์กดบันทึก)";
    nameInput.classList.remove("hidden");
    btn.textContent = "💾 บันทึกทัวร์นาเมนต์ (ให้ทุกคนดูได้)";
  }

  // สร้างครั้งแรก: โฮสต์กดได้ | หลังบันทึกแล้ว: ต้องเป็นโฮสต์ที่เป็นแอดมินด้วยถึงจะอัปเดตทับได้
  const canUseControls = saved ? (isHost && isAdmin) : isHost;
  controlsEl.classList.toggle("hidden", !canUseControls);
  if (saved && !isAdmin) {
    statusEl.innerHTML += `<br><span class="small-text">การแก้ไขภายหลังทำได้เฉพาะแอดมิน</span>`;
  }
}
async function saveOrUpdateArchive() {
  const room = latestRoom;
  if (!room || !isHost || !currentRoomId) return;

  const btn = document.getElementById("btn-save-archive");
  const nameInput = document.getElementById("archive-name-input");
  const isUpdate = !!room.archiveId;
  const name = isUpdate ? (room.archiveName || "ทัวร์นาเมนต์") : (nameInput.value.trim() || "ทัวร์นาเมนต์ไม่มีชื่อ");

  btn.disabled = true;
  btn.textContent = isUpdate ? "กำลังอัปเดต..." : "กำลังบันทึก...";

  try {
    let archiveId = room.archiveId;
    let createdAt = room.archiveCreatedAt || Date.now();
    let creating = !isUpdate;
    if (isUpdate) {
      // ถ้าอันเดิมโดนแอดมินลบไปแล้ว ให้ถือว่าบันทึกใหม่
      const existing = await get(ref(db, `archives/${archiveId}`));
      if (!existing.exists()) {
        creating = true;
        archiveId = push(ref(db, "archives")).key;
        createdAt = Date.now();
      }
    } else {
      archiveId = push(ref(db, "archives")).key;
    }

    const snapshot = {
      name,
      roomId: currentRoomId,
      hostName: (room.players && room.players[room.hostId]?.name) || "-",
      playerCount: room.players ? Object.keys(room.players).length : 0,
      createdAt,
      updatedAt: Date.now(),
      settings: room.settings || null,
      players: room.players || {},
      hostId: room.hostId || null,
      league: room.league || null,
      bannedList: getBannedList(room),
      hasBanInfo: true
    };

    await set(ref(db, `archives/${archiveId}`), snapshot);

    if (creating) {
      await updateRoom((r) => {
        r.archiveId = archiveId;
        r.archiveName = name;
        r.archiveCreatedAt = createdAt;
        return r;
      });
    }
  } catch (e) {
    console.error("saveOrUpdateArchive error:", e);
    alert("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
  } finally {
    btn.disabled = false;
    if (latestRoom) renderArchiveBox(latestRoom);
  }
}

document.getElementById("btn-save-archive").addEventListener("click", saveOrUpdateArchive);

// ---------- หน้ารายการทัวร์นาเมนต์ (เข้าได้จากหน้าแรก ไม่ต้องมีรหัสห้อง) ----------
let allArchivesCache = [];

function hideAllTopScreens() {
  screenHome.classList.add("hidden");
  screenLobby.classList.add("hidden");
  screenGame.classList.add("hidden");
  screenPostgame.classList.add("hidden");
  screenArchives.classList.add("hidden");
  screenArchiveDetail.classList.add("hidden");
}

async function openArchivesList() {
  hideAllTopScreens();
  document.querySelector(".container").classList.remove("game-mode");
  screenArchives.classList.remove("hidden");
  document.getElementById("archives-list").innerHTML = `<p class="loading-text">กำลังโหลด...</p>`;

  try {
    const snap = await get(ref(db, "archives"));
    const val = snap.exists() ? snap.val() : {};
    allArchivesCache = Object.entries(val)
      .map(([id, a]) => ({ id, ...a }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    renderArchivesList(allArchivesCache);
  } catch (e) {
    console.error("openArchivesList error:", e);
    document.getElementById("archives-list").innerHTML = `<p class="archives-empty">โหลดข้อมูลไม่สำเร็จ</p>`;
  }
}

function renderArchivesList(list) {
  const container = document.getElementById("archives-list");
  if (!list.length) {
    container.innerHTML = `<p class="archives-empty">ยังไม่มีทัวร์นาเมนต์ที่บันทึกไว้</p>`;
    return;
  }
  container.innerHTML = list.map(a => {
    const date = a.updatedAt ? new Date(a.updatedAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) : "-";
    return `
      <div class="archive-item" data-id="${escapeHtml(a.id)}">
        <div>
          <div class="a-name">🏆 ${escapeHtml(a.name || "ไม่มีชื่อ")}</div>
          <div class="a-meta">ผู้เล่น ${a.playerCount || 0} คน • โฮสต์: ${escapeHtml(a.hostName || "-")} • อัปเดตล่าสุด ${date}</div>
        </div>
        <div class="archive-item-actions">
          <span class="badge">ดูรายละเอียด ➜</span>
          ${isAdmin ? `<button class="btn-del-mini" data-del="${escapeHtml(a.id)}" title="ลบทัวร์นาเมนต์">🗑️</button>` : ""}
        </div>
      </div>`;
  }).join("");

  container.querySelectorAll(".archive-item").forEach(el => {
    el.addEventListener("click", () => openArchiveDetail(el.dataset.id));
  });
  container.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const item = allArchivesCache.find(x => x.id === btn.dataset.del);
      deleteArchive(btn.dataset.del, item?.name || "ไม่มีชื่อ");
    });
  });
}

document.getElementById("archives-search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  const filtered = q
    ? allArchivesCache.filter(a => (a.name || "").toLowerCase().includes(q) || (a.hostName || "").toLowerCase().includes(q))
    : allArchivesCache;
  renderArchivesList(filtered);
});

document.getElementById("btn-open-archives").addEventListener("click", openArchivesList);
document.getElementById("btn-archives-back").addEventListener("click", () => {
  hideAllTopScreens();
  screenHome.classList.remove("hidden");
});

// ---------- หน้ารายละเอียดทัวร์นาเมนต์ (read-only) ----------
let currentArchiveWeekView = 1;

async function openArchiveDetail(archiveId) {
  hideAllTopScreens();
  screenArchiveDetail.classList.remove("hidden");
  document.getElementById("archive-detail-title").textContent = "กำลังโหลด...";
  document.getElementById("archive-detail-meta").textContent = "";
  document.getElementById("adet-teams-grid").innerHTML = "";

  try {
    const snap = await get(ref(db, `archives/${archiveId}`));
    if (!snap.exists()) {
      document.getElementById("archive-detail-title").textContent = "ไม่พบข้อมูล";
      return;
    }
    const archive = snap.val();
    currentArchiveWeekView = 1;
    currentArchiveId = archiveId;
    archiveEditMode = false;
    renderArchiveDetail(archive);
  } catch (e) {
    console.error("openArchiveDetail error:", e);
    document.getElementById("archive-detail-title").textContent = "โหลดข้อมูลไม่สำเร็จ";
  }
}

function renderArchiveDetail(archive) {
  currentArchiveData = archive;
  const editing = isAdmin && archiveEditMode;

  document.getElementById("archive-detail-title").textContent = `🏆 ${archive.name || "ไม่มีชื่อ"}`;
  const date = archive.updatedAt ? new Date(archive.updatedAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) : "-";
  document.getElementById("archive-detail-meta").textContent =
    `ห้อง: ${archive.roomId || "-"} • โฮสต์: ${archive.hostName || "-"} • ผู้เล่น ${archive.playerCount || 0} คน • อัปเดตล่าสุด ${date}`;

  // แถบเครื่องมือแอดมิน
  document.getElementById("archive-admin-bar").classList.toggle("hidden", !isAdmin);
  document.getElementById("btn-archive-edit").textContent = editing ? "✅ เสร็จสิ้นการแก้ไข" : "✏️ โหมดแก้ไข";
  const renameBox = document.getElementById("archive-rename-box");
  renameBox.classList.toggle("hidden", !editing);
  const renameInput = document.getElementById("archive-rename-input");
  if (editing && document.activeElement !== renameInput) renameInput.value = archive.name || "";

  const players = archive.players || {};
  const grid = document.getElementById("adet-teams-grid");
  grid.innerHTML = Object.entries(players).map(([pid, p]) => `
    <div class="team-summary-card">
      <h4>${escapeHtml(p.name)}${pid === archive.hostId ? ' <span class="badge">HOST</span>' : ''}</h4>
      <p class="small-text">เงินคงเหลือ: ${(p.money || 0).toLocaleString()}</p>
      <div class="my-team">
        ${(p.team || []).map((t, idx) => teamSlotHtml(t, editing ? { pid, idx } : null)).join("")}
      </div>
      ${editing ? `
        <div class="add-poke-row">
          <select data-add-select="${escapeHtml(pid)}">
            <option value="">— เลือกโปเกม่อนที่จะเพิ่ม —</option>
            ${POKEMON_LIST.map((pk, i) => `<option value="${i}">${escapeHtml(pk.displayName)}</option>`).join("")}
          </select>
          <button data-add-pid="${escapeHtml(pid)}">➕ เพิ่ม</button>
        </div>` : ""}
    </div>
  `).join("") || `<p class="archives-empty">ไม่มีข้อมูลทีม</p>`;

  if (editing) {
    grid.querySelectorAll("[data-remove-pid]").forEach(btn => {
      btn.addEventListener("click", () => archiveRemovePokemon(btn.dataset.removePid, parseInt(btn.dataset.removeIdx)));
    });
    grid.querySelectorAll("[data-add-pid]").forEach(btn => {
      btn.addEventListener("click", () => {
        const sel = grid.querySelector(`select[data-add-select="${CSS.escape(btn.dataset.addPid)}"]`);
        if (sel && sel.value !== "") archiveAddPokemon(btn.dataset.addPid, parseInt(sel.value), btn);
      });
    });
  }

  const adetBanned = document.getElementById("adet-banned-summary");
  if (adetBanned) {
    adetBanned.innerHTML = archive.hasBanInfo ? bannedSummaryHtml(Object.values(archive.bannedList || {})) : "";
  }

  const league = archive.league;
  const leagueSection = document.getElementById("adet-league-section");
  if (!league || !league.weeks || !league.weeks.length) {
    leagueSection.innerHTML = `<p class="archives-empty">ทัวร์นาเมนต์นี้ไม่มีตารางแข่งขัน</p>`;
  } else {
    leagueSection.innerHTML = `
      <div class="week-tabs" id="adet-week-tabs"></div>
      <div id="adet-week-matches"></div>
      <h3 style="margin:20px 0 10px;">📊 ตารางคะแนน</h3>
      <table class="standings-table" id="adet-standings-table"></table>
    `;
    renderArchiveLeague(archive);
  }
}

function computeArchiveStandings(archive) {
  const stats = {};
  Object.keys(archive.players || {}).forEach(pid => {
    stats[pid] = { name: archive.players[pid].name, wins: 0, losses: 0, points: 0, played: 0 };
  });
  (archive.league.weeks || []).forEach(week => {
    week.matches.forEach(m => {
      if (m.isBye || !m.winnerId) return;
      const loserId = m.winnerId === m.player1Id ? m.player2Id : m.player1Id;
      if (stats[m.winnerId]) { stats[m.winnerId].wins += 1; stats[m.winnerId].points += 3; stats[m.winnerId].played += 1; }
      if (stats[loserId]) { stats[loserId].losses += 1; stats[loserId].played += 1; }
    });
  });
  return Object.entries(stats).map(([pid, s]) => ({ pid, ...s })).sort((a, b) => b.points - a.points || b.wins - a.wins);
}

function renderArchiveLeague(archive) {
  const weeks = archive.league.weeks;
  const weekTabsDiv = document.getElementById("adet-week-tabs");
  weekTabsDiv.innerHTML = weeks.map(w =>
    `<button class="week-tab-btn ${w.weekNumber === currentArchiveWeekView ? 'active' : ''}" data-week="${w.weekNumber}">สัปดาห์ ${w.weekNumber}</button>`
  ).join("");
  weekTabsDiv.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      currentArchiveWeekView = parseInt(btn.dataset.week);
      renderArchiveLeague(archive);
    });
  });

  const week = weeks.find(w => w.weekNumber === currentArchiveWeekView) || weeks[0];
  const weekIdx = weeks.indexOf(week);
  const editing = isAdmin && archiveEditMode;
  const matchesDiv = document.getElementById("adet-week-matches");
  matchesDiv.innerHTML = week.matches.map((m, matchIdx) => {
    if (m.isBye) {
      const p = archive.players[m.player1Id];
      return `<div class="match-card bye-card"><span>${escapeHtml(p?.name || "?")}</span><span class="badge">BYE</span></div>`;
    }
    const p1 = archive.players[m.player1Id];
    const p2 = archive.players[m.player2Id];
    const p1Win = m.winnerId === m.player1Id;
    const p2Win = m.winnerId === m.player2Id;
    const controls = editing ? `
      <div class="match-controls">
        <button class="btn-winner ${p1Win ? 'selected' : ''}" data-wi="${weekIdx}" data-mi="${matchIdx}" data-winner="${escapeHtml(m.player1Id)}">${escapeHtml(p1?.name || "?")} ชนะ</button>
        <button class="btn-winner ${p2Win ? 'selected' : ''}" data-wi="${weekIdx}" data-mi="${matchIdx}" data-winner="${escapeHtml(m.player2Id)}">${escapeHtml(p2?.name || "?")} ชนะ</button>
        <button class="btn-winner" data-wi="${weekIdx}" data-mi="${matchIdx}" data-winner="">ล้างผล</button>
      </div>` : "";
    return `<div class="match-card">
      <div class="match-players">
        <span class="${p1Win ? 'winner-name' : ''}">${escapeHtml(p1?.name || "?")}</span>
        <span class="vs">VS</span>
        <span class="${p2Win ? 'winner-name' : ''}">${escapeHtml(p2?.name || "?")}</span>
      </div>
      ${m.winnerId ? `<p class="small-text">ผู้ชนะ: ${escapeHtml(archive.players[m.winnerId]?.name || "?")}</p>` : `<p class="small-text">ยังไม่ได้แข่ง</p>`}
      ${controls}
    </div>`;
  }).join("");

  if (editing) {
    matchesDiv.querySelectorAll("button[data-wi]").forEach(btn => {
      btn.addEventListener("click", () => {
        applyArchiveEdit({
          [`league/weeks/${btn.dataset.wi}/matches/${btn.dataset.mi}/winnerId`]: btn.dataset.winner || null
        });
      });
    });
  }

  const standings = computeArchiveStandings(archive);
  const table = document.getElementById("adet-standings-table");
  table.innerHTML = `
    <tr><th>#</th><th>ผู้เล่น</th><th>แข่ง</th><th>ชนะ</th><th>แพ้</th><th>แต้ม</th></tr>
    ${standings.map((s, i) => `
      <tr><td>${i + 1}</td><td>${s.name}</td><td>${s.played}</td><td>${s.wins}</td><td>${s.losses}</td><td><b>${s.points}</b></td></tr>`).join("")}
  `;
}

document.getElementById("adet-tab-teams").addEventListener("click", () => {
  document.getElementById("adet-tab-teams").classList.add("active");
  document.getElementById("adet-tab-league").classList.remove("active");
  document.getElementById("adet-teams-section").classList.remove("hidden");
  document.getElementById("adet-league-section").classList.add("hidden");
});
document.getElementById("adet-tab-league").addEventListener("click", () => {
  document.getElementById("adet-tab-league").classList.add("active");
  document.getElementById("adet-tab-teams").classList.remove("active");
  document.getElementById("adet-league-section").classList.remove("hidden");
  document.getElementById("adet-teams-section").classList.add("hidden");
});
document.getElementById("btn-archive-detail-back").addEventListener("click", () => {
  archiveEditMode = false;
  if (archivesDirty) {
    archivesDirty = false;
    openArchivesList();
    return;
  }
  hideAllTopScreens();
  screenArchives.classList.remove("hidden");
});

// =====================================================================
// ระบบแอดมิน: เข้าสู่ระบบด้วย Google + แก้ไข/ลบทัวร์นาเมนต์ย้อนหลัง
// หมายเหตุ: การอนุญาตจริงถูกบังคับที่ Firebase Realtime Database Rules
// (ฝั่งหน้าเว็บแค่ซ่อน/โชว์ปุ่ม) ดูตัวอย่าง rules ในคำอธิบาย
// =====================================================================
const emailKey = (email) => String(email || "").trim().toLowerCase().replace(/\./g, ",");

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  isAdmin = false;
  isOwner = false;
  if (user && user.email) {
    try {
      const snap = await get(ref(db, `admins/${emailKey(user.email)}`));
      const role = snap.exists() ? snap.val() : null;
      isAdmin = !!role;
      isOwner = role === "owner";
    } catch (e) {
      console.error("check admin error:", e);
    }
  }
  if (!isAdmin) archiveEditMode = false;
  updateAuthUI();
});

function updateAuthUI() {
  const loginBtn = document.getElementById("btn-login");
  const info = document.getElementById("auth-info");
  loginBtn.classList.toggle("hidden", !!currentUser);
  info.classList.toggle("hidden", !currentUser);
  if (currentUser) {
    const role = isOwner ? " (เจ้าของ)" : (isAdmin ? " (แอดมิน)" : " (ไม่มีสิทธิ์แก้ไข)");
    document.getElementById("auth-email").textContent = (currentUser.email || "") + role;
  }

  // รีเฟรชหน้าที่เปิดอยู่ให้ตรงกับสิทธิ์ล่าสุด
  if (!screenArchives.classList.contains("hidden")) {
    document.getElementById("archives-search").dispatchEvent(new Event("input"));
  }
  if (!screenArchiveDetail.classList.contains("hidden") && currentArchiveData) {
    renderArchiveDetail(currentArchiveData);
  }
  document.getElementById("admin-panel").classList.toggle("hidden", !isOwner);
  if (isOwner) loadAdminList();
  if (latestRoom && latestRoom.status === "finished") renderArchiveBox(latestRoom);
}

document.getElementById("btn-login").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    console.error("login error:", e);
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
    if (e.code === "auth/unauthorized-domain") {
      alert("โดเมนนี้ยังไม่ได้เพิ่มใน Firebase (Authentication > Settings > Authorized domains)");
    } else {
      alert("เข้าสู่ระบบไม่สำเร็จ: " + (e.code || e.message));
    }
  }
});
document.getElementById("btn-logout").addEventListener("click", () => signOut(auth));

// --- ลบ / แก้ไขทัวร์นาเมนต์
async function deleteArchive(id, name) {
  if (!isAdmin || !id) return;
  if (!confirm(`ลบทัวร์นาเมนต์ "${name}" ถาวร?\nกู้คืนไม่ได้นะ`)) return;
  try {
    await set(ref(db, `archives/${id}`), null);
    archivesDirty = false;
    archiveEditMode = false;
    await openArchivesList();
  } catch (e) {
    console.error("deleteArchive error:", e);
    alert("ลบไม่สำเร็จ (อาจไม่มีสิทธิ์ หรือเน็ตมีปัญหา)");
  }
}

async function applyArchiveEdit(patch) {
  if (!isAdmin || !currentArchiveId) return;
  try {
    await update(ref(db, `archives/${currentArchiveId}`), { ...patch, updatedAt: Date.now() });
    archivesDirty = true;
    const snap = await get(ref(db, `archives/${currentArchiveId}`));
    if (snap.exists()) renderArchiveDetail(snap.val());
  } catch (e) {
    console.error("applyArchiveEdit error:", e);
    alert("แก้ไขไม่สำเร็จ (อาจไม่มีสิทธิ์ หรือเน็ตมีปัญหา)");
  }
}

async function archiveRemovePokemon(pid, idx) {
  const player = currentArchiveData?.players?.[pid];
  const team = (player?.team || []).slice();
  const t = team[idx];
  if (!t) return;
  if (!confirm(`เอา ${t.displayName} ออกจากทีมของ ${player.name}?`)) return;
  team.splice(idx, 1);
  await applyArchiveEdit({ [`players/${pid}/team`]: team.length ? team : null });
}

async function archiveAddPokemon(pid, listIdx, btn) {
  const poke = POKEMON_LIST[listIdx];
  const player = currentArchiveData?.players?.[pid];
  if (!poke || !player) return;
  if (btn) btn.disabled = true;
  const sprite = await fetchSprite(poke);
  const team = (player.team || []).slice();
  team.push({ id: poolKeyOf(poke), displayName: poke.displayName, isMega: !!poke.isMega, sprite });
  await applyArchiveEdit({ [`players/${pid}/team`]: team });
}

document.getElementById("btn-archive-edit").addEventListener("click", () => {
  if (!isAdmin || !currentArchiveData) return;
  archiveEditMode = !archiveEditMode;
  renderArchiveDetail(currentArchiveData);
});
document.getElementById("btn-archive-delete").addEventListener("click", () => {
  if (currentArchiveData) deleteArchive(currentArchiveId, currentArchiveData.name || "ไม่มีชื่อ");
});
document.getElementById("btn-archive-rename").addEventListener("click", () => {
  const name = document.getElementById("archive-rename-input").value.trim();
  if (!name) { alert("ชื่อห้ามว่าง"); return; }
  applyArchiveEdit({ name });
});

// --- เจ้าของจัดการรายชื่อผู้มีสิทธิ์
async function loadAdminList() {
  const listEl = document.getElementById("admin-list");
  try {
    const snap = await get(ref(db, "admins"));
    const val = snap.exists() ? snap.val() : {};
    listEl.innerHTML = Object.entries(val).map(([key, role]) => `
      <li>
        <span>${escapeHtml(key.replace(/,/g, "."))}</span>
        ${role === "owner"
          ? '<span class="badge">OWNER</span>'
          : `<button class="btn-leave-small" data-remove-admin="${escapeHtml(key)}">ลบสิทธิ์</button>`}
      </li>`).join("") || '<li>ยังไม่มีรายชื่อ</li>';
    listEl.querySelectorAll("[data-remove-admin]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("ยกเลิกสิทธิ์ของคนนี้?")) return;
        try {
          await set(ref(db, `admins/${btn.dataset.removeAdmin}`), null);
          loadAdminList();
        } catch (e) {
          alert("ลบสิทธิ์ไม่สำเร็จ");
        }
      });
    });
  } catch (e) {
    console.error("loadAdminList error:", e);
    listEl.innerHTML = "<li>โหลดรายชื่อไม่สำเร็จ</li>";
  }
}

document.getElementById("btn-add-admin").addEventListener("click", async () => {
  if (!isOwner) return;
  const input = document.getElementById("admin-email-input");
  const email = input.value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { alert("อีเมลไม่ถูกต้อง"); return; }
  try {
    await set(ref(db, `admins/${emailKey(email)}`), true);
    input.value = "";
    loadAdminList();
  } catch (e) {
    console.error("add admin error:", e);
    alert("เพิ่มไม่สำเร็จ");
  }
});