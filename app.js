import { db, auth } from "./firebase-config.js";
import {
  ref, set, get, push, onValue, update, onDisconnect, child, runTransaction
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import {
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { POKEMON_LIST } from "./pokemon-list.js";

// ---------- Server-synced clock ----------
// นาฬิกาเครื่องผู้เล่นแต่ละคนอาจไม่ตรงกัน ถ้าใช้ Date.now() ตรงๆ ในการตั้ง/เช็คเวลาหมดอายุ
// การประมูล จะทำให้ผู้เล่นที่นาฬิกาเดินเร็ว/ช้ากว่าเครื่องอื่น ปิดประมูลเร็วหรือช้ากว่าที่ตั้งไว้จริง
// จึงต้องอ้างอิง serverTimeOffset จาก Firebase เพื่อให้ทุกเครื่องเห็นเวลาเดียวกัน
let serverTimeOffset = 0;
onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
  serverTimeOffset = snap.val() || 0;
});
function serverNow() {
  return Date.now() + serverTimeOffset;
}

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
let currentTournamentView = "matches";
let latestRoom = null;
let disconnectCancelled = false;
let selfLeaving = false; // กันไม่ให้ตัวเองเห็น alert "ถูกเตะออก" ตอนที่กดออกจากห้องเอง

// ระบบสิทธิ์ / บทบาท (ตรวจสิทธิ์จริงที่ Firebase Rules — ฝั่งนี้แค่ใช้ซ่อน/โชว์ปุ่ม)
let currentUser = null;
let isOwner = false;
let isOrganizer = false;
let isStaff = false;
let myAffiliation = null;
let myRoleData = null;
let roomNotificationsStarted = false;
const seenAdminCalls = new Set();
let adminCallsUnsub = null;
let adminCallsRoomId = null;

let currentArchiveId = null;
let currentArchiveData = null;
let archiveEditMode = false;
let archivesDirty = false;
let spectateRoomId = null;
let spectateChatUnsubs = [];
let spectateMatchSignature = "";

// ---------- DOM ----------
const screenHome = document.getElementById("screen-home");
const screenLobby = document.getElementById("screen-lobby");
const screenGame = document.getElementById("screen-game");
const screenPostgame = document.getElementById("screen-postgame");
const screenArchives = document.getElementById("screen-archives");
const screenArchiveDetail = document.getElementById("screen-archive-detail");
const screenSpectate = document.getElementById("screen-spectate");
const screenTournament = document.getElementById("screen-tournament");
const screenMyHistory = document.getElementById("screen-my-history");

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

// ---------- สิทธิ์การใช้งาน (Permissions) ----------
function canCreateRoom() {
  return isOwner || isOrganizer;
}

function canEditArchive(archive) {
  if (!archive) return false;
  if (isOwner) return true;
  if (isOrganizer && archive.creatorUid && currentUser?.uid === archive.creatorUid) return true;
  return false;
}

function canDeleteArchive(archive) {
  if (!archive) return false;
  if (isOwner) return true;
  if (isOrganizer && archive.creatorUid && currentUser?.uid === archive.creatorUid) return true;
  return false; // ลูกน้องลบไม่ได้
}

function updateCreateRoomGate() {
  const allowed = canCreateRoom();
  document.getElementById("create-gate-msg")?.classList.toggle("hidden", allowed);
  document.getElementById("form-create")?.classList.toggle("force-hidden", !allowed);
  if (!allowed && tabCreate.classList.contains("active")) {
    // ถ้าไม่มีสิทธิ์ ให้สลับไปแท็บเข้าห้องแทน
  }
}

// ---------- Create Room ----------
document.getElementById("btn-create").addEventListener("click", async () => {
  if (!canCreateRoom()) {
    homeError.textContent = "คุณไม่มีสิทธิ์สร้างห้อง กรุณาเข้าสู่ระบบด้วยบัญชีที่ได้รับสิทธิ์ผู้สร้างห้อง";
    return;
  }
  const name = document.getElementById("create-name").value.trim();
  const hostParticipation = document.getElementById("create-host-participation").value;
  const maxPlayers = parseInt(document.getElementById("create-max-players").value);
  const mode = document.getElementById("create-room-mode").value;
  const teamSize = mode === "auction" ? parseInt(document.getElementById("create-auction-team-size").value) : mode === "gacha" ? parseInt(document.getElementById("create-gacha-box-size").value) : 6;
  const auctionSelector = document.getElementById("create-auction-selector").value;
  const auctionReveal = document.getElementById("create-auction-reveal").value;
  const timerSeconds = parseInt(document.getElementById("create-auction-timer").value);
  const startMoney = mode === "auction" ? parseInt(document.getElementById("create-auction-start-money").value) : 0;
  const phases = [document.getElementById("create-phase-1").value, document.getElementById("create-phase-2").value].filter(Boolean);
  const bestOf = document.getElementById("create-best-of").value;
  const checkIn = document.getElementById("create-checkin").value;
  const swissRounds = parseInt(document.getElementById("create-swiss-rounds").value);
  const topCut = parseInt(document.getElementById("create-top-cut").value);
  if (!name) { homeError.textContent = "กรุณากรอกชื่อ"; return; }

  const roomId = generateRoomCode();
  const playerId = generatePlayerId();

  const roomData = {
    hostId: playerId,
    creatorUid: currentUser?.uid || null,
    creatorEmail: currentUser?.email || null,
    affiliation: myAffiliation || null,
    status: "waiting",
    settings: {
      maxPlayers: maxPlayers,
      mode, auctionSelector, auctionReveal, hostParticipation, phases, bestOf, checkIn, topCut, swissRounds,
      startMoney,
      minBidIncrement: 50,
      timerSeconds,
      teamSize,
      ...readExtraCreateSettings(mode)
    },
    players: {
      [playerId]: {
        name: name,
        userUid: currentUser?.uid || null,
        money: startMoney,
        isHost: true,
        isSpectator: hostParticipation === "spectator",
        joinedAt: Date.now(),
        pickTicketUsed: false,
        banTicketUsed: false,
        giftCount: 0,
        team: []
      }
    },
    memberUids: { [currentUser.uid]: true },
    createdAt: Date.now()
  };

  await set(ref(db, "rooms/" + roomId), roomData);
  onDisconnect(ref(db, `rooms/${roomId}/players/${playerId}`)).remove();
  enterLobby(roomId, playerId, true);
});

// แสดงเฉพาะการตั้งค่าที่เกี่ยวข้องกับโหมดและรูปแบบการแข่งขันที่เลือก
function syncCreateRoomOptions() {
  const mode = document.getElementById("create-room-mode").value;
  const phase1 = document.getElementById("create-phase-1").value;
  const phase2 = document.getElementById("create-phase-2").value;
  document.getElementById("create-auction-settings").classList.toggle("hidden", mode !== "auction");
  document.getElementById("create-gacha-settings").classList.toggle("hidden", mode !== "gacha");
  document.getElementById("create-teamsheet-settings").classList.toggle("hidden", mode !== "normal");
  document.getElementById("create-gacha-return-wrap").classList.toggle("hidden", document.getElementById("create-gacha-duplicates").value === "yes");
  document.getElementById("create-swiss-rounds-wrap").classList.toggle("hidden", phase1 !== "swiss" && phase2 !== "swiss");
  document.getElementById("create-top-cut-wrap").classList.toggle("hidden", !phase2);
}
["create-room-mode", "create-phase-1", "create-phase-2", "create-gacha-duplicates"].forEach(id => {
  document.getElementById(id).addEventListener("change", syncCreateRoomOptions);
});
syncCreateRoomOptions();

// ---------- Join Room ----------
document.getElementById("btn-join").addEventListener("click", async () => {
  if (!currentUser) { homeError.textContent = "กรุณาเข้าสู่ระบบก่อนเข้าร่วมห้อง เพื่อคุ้มครองสิทธิ์และแชทของผู้เล่น"; return; }
  const name = document.getElementById("join-name").value.trim();
  const code = document.getElementById("join-code").value.trim().toUpperCase();
  if (!name) { homeError.textContent = "กรุณากรอกชื่อ"; return; }
  if (!code) { homeError.textContent = "กรุณากรอกรหัสห้อง"; return; }

  const roomRef = ref(db, "rooms/" + code);
  const snapshot = await get(roomRef);
  if (!snapshot.exists()) { homeError.textContent = "ไม่พบห้องนี้"; return; }

  const room = snapshot.val();
  // ผู้เล่นที่ออกจากหน้าห้องระหว่างทัวร์นาเมนต์ กลับเข้ามาด้วยบัญชีเดิมได้
  const existingEntry = Object.entries(room.players || {}).find(([, player]) => player?.userUid === currentUser.uid);
  if (room.status !== "waiting" && existingEntry) {
    const [existingPlayerId, existingPlayer] = existingEntry;
    enterLobby(code, existingPlayerId, !!existingPlayer.isHost);
    return;
  }
  if (room.status !== "waiting") { homeError.textContent = "ห้องนี้เริ่มเกมไปแล้ว"; return; }

  const currentPlayers = competitivePlayerIds(room).length;
  if (currentPlayers >= room.settings.maxPlayers) { homeError.textContent = "ห้องเต็มแล้ว"; return; }

  const playerId = generatePlayerId();
  await update(ref(db, `rooms/${code}/memberUids`), { [currentUser.uid]: true });
  await update(ref(db, `rooms/${code}/players/${playerId}`), {
    name: name,
    userUid: currentUser?.uid || null,
    money: room.settings.startMoney,
    isHost: false,
    joinedAt: Date.now(),
    pickTicketUsed: false,
    banTicketUsed: false,
    giftCount: 0,
    team: []
  });

  onDisconnect(ref(db, `rooms/${code}/players/${playerId}`)).remove();
  enterLobby(code, playerId, false);
});

// ---------- เข้าดูแบบผู้ชม ----------
// ผู้ชมถูกเก็บเป็นผู้เล่นแบบ isSpectator + isViewer จึงใช้มุมมองผู้สังเกตการณ์เดิมทั้งหมด
// (ดูได้ทุกอย่างรวมโปเกม่อนที่ซ่อน, ไม่มีปุ่มบิด/กรอกคะแนน/ส่งทีม) และไม่นับเป็นผู้แข่งขัน เข้าได้ทุกสถานะห้อง
document.getElementById("btn-join-viewer").addEventListener("click", async () => {
  if (!currentUser) { homeError.textContent = "กรุณาเข้าสู่ระบบก่อนเข้าดูการแข่งขัน"; return; }
  const code = document.getElementById("join-code").value.trim().toUpperCase();
  if (!code) { homeError.textContent = "กรุณากรอกรหัสห้อง"; return; }
  try {
    const snapshot = await get(ref(db, "rooms/" + code));
    if (!snapshot.exists()) { homeError.textContent = "ไม่พบห้องนี้"; return; }
    const room = snapshot.val();
    // เป็นสมาชิกของห้องอยู่แล้ว (ผู้เล่น/โฮสต์/ผู้ชมเดิม) -> กลับเข้าด้วยบทบาทเดิม ไม่สร้างรายการซ้ำ
    const existing = Object.entries(room.players || {}).find(([, p]) => p?.userUid === currentUser.uid);
    if (existing) { enterLobby(code, existing[0], !!existing[1].isHost); return; }
    const name = document.getElementById("join-name").value.trim() || currentUser.displayName || "ผู้ชม";
    const playerId = generatePlayerId();
    await update(ref(db, `rooms/${code}/memberUids`), { [currentUser.uid]: true });
    await update(ref(db, `rooms/${code}/players/${playerId}`), {
      name, userUid: currentUser.uid, money: 0, isHost: false, isSpectator: true, isViewer: true,
      joinedAt: Date.now(), pickTicketUsed: false, banTicketUsed: false, giftCount: 0, team: []
    });
    if (room.status === "waiting") onDisconnect(ref(db, `rooms/${code}/players/${playerId}`)).remove();
    homeError.textContent = "";
    enterLobby(code, playerId, false);
  } catch (e) {
    console.error("join viewer error:", e);
    homeError.textContent = "เข้าดูไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
  }
});

// ---------- Lobby ----------
function enterLobby(roomId, playerId, hostStatus) {
  currentRoomId = roomId;
  currentPlayerId = playerId;
  isHost = hostStatus;
  disconnectCancelled = false;

  localStorage.setItem("vgcLab_roomId", roomId);
  localStorage.setItem("vgcLab_playerId", playerId);

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
      localStorage.removeItem("vgcLab_roomId");
      localStorage.removeItem("vgcLab_playerId");
      alert("ห้องนี้ถูกปิดแล้ว");
      location.reload();
      return;
    }
    const room = snapshot.val();
    latestRoom = room;

    // โดนโฮสต์เตะออกจากห้อง (เฉพาะตอนยังรอเริ่ม ผู้เล่นจะถูกลบออกจาก room.players ไปเลย) -> เด้งกลับหน้าแรก
    if (!selfLeaving && room.players && !room.players[currentPlayerId]) {
      localStorage.removeItem("vgcLab_roomId");
      localStorage.removeItem("vgcLab_playerId");
      alert("คุณถูกโฮสต์เตะออกจากห้องนี้แล้ว");
      location.reload();
      return;
    }

    // เกมเริ่มแล้ว -> ยกเลิกการลบอัตโนมัติตอนหลุดการเชื่อมต่อ
    if (room.status !== "waiting" && !disconnectCancelled) {
      onDisconnect(ref(db, `rooms/${roomId}/players/${playerId}`)).cancel();
      disconnectCancelled = true;
    }

    if (room.status === "waiting") {
      screenTournament.classList.add("hidden");
      screenGame.classList.add("hidden");
      screenPostgame.classList.add("hidden");
      screenLobby.classList.remove("hidden");
      document.querySelector(".container").classList.remove("game-mode");
      currentWeekView = 1;
      currentFilter = "all";
      currentSearch = "";
      renderLobby(room);
    } else if (room.status === "tournament") {
      screenLobby.classList.add("hidden"); screenGame.classList.add("hidden"); screenPostgame.classList.add("hidden");
      screenTournament.classList.remove("hidden");
      document.querySelector(".container").classList.add("game-mode");
      renderTournament(room);
    } else if (room.status === "completed") {
      screenLobby.classList.add("hidden"); screenGame.classList.add("hidden"); screenPostgame.classList.add("hidden");
      screenTournament.classList.remove("hidden");
      document.querySelector(".container").classList.add("game-mode");
      renderTournament(room); saveMyTournamentHistory(room);
    } else if (room.status === "finished") {
      screenTournament.classList.add("hidden");
      screenLobby.classList.add("hidden");
      screenGame.classList.add("hidden");
      screenPostgame.classList.remove("hidden");
      document.querySelector(".container").classList.add("game-mode");
      renderPostgame(room);
    } else {
      screenTournament.classList.add("hidden");
      screenLobby.classList.add("hidden");
      screenPostgame.classList.add("hidden");
      screenGame.classList.remove("hidden");
      document.querySelector(".container").classList.add("game-mode");
      renderGame(room);
    }
  });

  // แชทในห้อง (อัปเดตสดตลอดตั้งแต่ล็อบบี้ยันจบเกม)
  onValue(ref(db, `rooms/${roomId}/chat`), (snap) => {
    const val = snap.exists() ? snap.val() : {};
    const msgs = Object.values(val).sort((a, b) => a.time - b.time);
    const box = document.getElementById("game-chat-messages");
    if (!box) return;
    box.innerHTML = msgs.map(m => `<div class="chat-msg${m.isOwnerMsg ? ' owner-msg' : ''}"><b>${escapeHtml(m.senderName)}:</b> ${escapeHtml(m.text)}</div>`).join("");
    box.scrollTop = box.scrollHeight;
  });
}

function renderLobby(room) {
  const players = room.players || {};
  const playerIds = competitivePlayerIds(room);
  const maxPlayers = room.settings.maxPlayers;
  const requiresTeamSheet = isTeamSheetMode(room);
  const sheetMandatory = teamSheetRequired(room);
  const playersMissingTeamSheet = requiresTeamSheet ? playerIds.filter(pid => !hasSubmittedTeamSheet(players[pid])) : [];
  const submittedTeamSheets = playerIds.length - playersMissingTeamSheet.length;
  const gachaMode = isGachaRoom(room);
  const gachaShort = gachaMode ? playerIds.filter(pid => (players[pid].team?.length || 0) < GACHA_MIN_TO_START) : [];
  const gachaPendingIds = gachaMode ? playerIds.filter(pid => !!players[pid].pendingPull) : [];

  document.getElementById("lobby-count").textContent = `ผู้เล่น ${playerIds.length}/${maxPlayers}`;
  const teamSheetCount = document.getElementById("lobby-team-sheet-count");
  if (teamSheetCount) {
    teamSheetCount.classList.toggle("hidden", !requiresTeamSheet && !gachaMode);
    if (gachaMode) { const ready = playerIds.length - gachaShort.length; teamSheetCount.innerHTML = `<span>📦 Box พร้อมแล้ว (≥${GACHA_MIN_TO_START} ตัว)</span><b>${ready}/${playerIds.length || 0} คน</b><div class="team-sheet-progress-bar"><i style="width:${playerIds.length ? Math.round(ready / playerIds.length * 100) : 0}%"></i></div>`; }
    if (requiresTeamSheet) teamSheetCount.innerHTML = `<span>📄 Team Sheet${sheetMandatory ? "" : " (ไม่บังคับ)"}</span><b>${submittedTeamSheets}/${playerIds.length || 0} คนส่งแล้ว</b><div class="team-sheet-progress-bar"><i style="width:${playerIds.length ? Math.round(submittedTeamSheets / playerIds.length * 100) : 0}%"></i></div>`;
  }

  const listEl = document.getElementById("lobby-player-list");
  listEl.innerHTML = "";
  Object.keys(players).forEach((pid) => {
    const p = players[pid];
    const li = document.createElement("li");
    const canKick = isHost && pid !== currentPlayerId && !p.isHost;
    li.innerHTML = `<span>${escapeHtml(p.name)}</span>${p.isHost ? '<span class="badge">HOST</span>' : ''}${p.isSpectator ? '<span class="badge">SPECTATOR</span>' : ''}${requiresTeamSheet && !p.isSpectator ? (hasSubmittedTeamSheet(p) ? '<span class="badge team-sheet-ready">📄 ส่ง Team Sheet แล้ว</span>' : `<span class="badge team-sheet-missing">${sheetMandatory ? "⏳ รอ Team Sheet" : "ยังไม่ส่ง (ไม่บังคับ)"}</span>`) : ''}${gachaMode && !p.isSpectator ? `<span class="badge ${(p.team?.length || 0) >= GACHA_MIN_TO_START ? 'team-sheet-ready' : 'team-sheet-missing'}">📦 ${p.team?.length || 0}/${gachaBoxSize(room)}</span>` : ''}${canKick ? `<button class="btn-kick" data-kick-lobby="${pid}">เตะออก</button>` : ''}`;
    listEl.appendChild(li);
  });
  listEl.querySelectorAll("button[data-kick-lobby]").forEach(btn => btn.addEventListener("click", () => kickPlayerFromLobby(btn.dataset.kickLobby)));

  if (isHost) {
    const startBtn = document.getElementById("btn-start");
    startBtn.disabled = playerIds.length < 2 || (sheetMandatory && playersMissingTeamSheet.length > 0) || gachaShort.length > 0 || gachaPendingIds.length > 0;
    startBtn.textContent = playerIds.length < 2
      ? "รอผู้เล่น... (อย่างน้อย 2 คน)"
      : gachaMode
        ? (gachaShort.length ? `รอผู้เล่นสุ่มให้ครบ ${GACHA_MIN_TO_START} ตัว (อีก ${gachaShort.length} คน)` : gachaPendingIds.length ? `รอผู้เล่นตัดสินใจทิ้ง/แทนที่ (${gachaPendingIds.length} คน)` : `เริ่มการแข่งขัน (${playerIds.length} คน • Box พร้อมแล้ว)`)
      : !requiresTeamSheet
        ? `เริ่มประมูล (${playerIds.length} คน)`
        : !sheetMandatory
          ? `เริ่มเกม (${playerIds.length} คน • ส่งชีทแล้ว ${submittedTeamSheets} คน • ไม่บังคับส่ง)`
        : playersMissingTeamSheet.length
          ? `รอ Team Sheet อีก ${playersMissingTeamSheet.length} คน`
          : `เริ่มเกม (${playerIds.length} คน • ส่ง Team Sheet ครบแล้ว)`;
  }

  renderLobbyTeamEditor(room);
  renderGachaPanel(room, document.getElementById("lobby-gacha-panel"), { showAllBoxes: true });
}

function teamSheetWithoutEvs(text) {
  return String(text || "").replace(/\r?\nEVs:\s*[^\r\n]*/gi, "").trim();
}

function hasSubmittedTeamSheet(player) {
  return Boolean(String(player?.teamSheet || player?.teamText || "").trim());
}

function renderLobbyTeamEditor(room) {
  const editor = document.getElementById("lobby-team-editor");
  if (!editor) return;
  const player = room.players?.[currentPlayerId];
  const requiresTeamSheet = isTeamSheetMode(room);
  editor.classList.toggle("hidden", !!player?.isSpectator || !requiresTeamSheet);
  if (player?.isSpectator || !requiresTeamSheet) return;
  if (!player) return;
  const mandatory = teamSheetRequired(room);
  const sheetTitle = editor.querySelector("h3"), sheetHint = editor.querySelector("p.small-text");
  if (sheetTitle) sheetTitle.textContent = mandatory ? "📝 ส่ง Team Sheet ก่อนเริ่มการแข่งขัน" : "📝 ส่ง Team Sheet (ไม่บังคับ)";
  if (sheetHint) sheetHint.textContent = mandatory
    ? "ผู้เล่นทุกคนต้องส่งก่อนผู้จัดเริ่มได้ วางโค้ดทีมจาก Pokémon Showdown ได้เลย ระบบจะไม่นำบรรทัด EVs ไปแสดง และใช้ข้อมูลนี้คำนวณ Meta"
    : "ห้องนี้ไม่บังคับส่ง จะส่งหรือไม่ส่งก็ได้ ถ้าส่ง ระบบจะไม่นำบรรทัด EVs ไปแสดง และใช้ข้อมูลนี้คำนวณ Meta";
  refreshLobbySavedTeams();
  const input = document.getElementById("lobby-team-input");
  const preview = document.getElementById("lobby-team-preview");
  const save = document.getElementById("btn-save-lobby-team");
  if (document.activeElement !== input) input.value = player.teamText || "";
  const sheet = player.teamSheet || teamSheetWithoutEvs(player.teamText);
  preview.textContent = sheet;
  preview.classList.toggle("hidden", !sheet);
  save.onclick = async () => {
    const teamText = input.value.trim();
    const teamSheet = teamSheetWithoutEvs(teamText);
    await update(ref(db, `rooms/${currentRoomId}/players/${currentPlayerId}`), { teamText: teamText || null, teamSheet: teamSheet || null });
  };
}

// ---------- Tournament engine ----------
function competitivePlayerIds(room) { return Object.keys(room.players || {}).filter(id => !room.players[id].isSpectator); }
function activePlayerIds(room) { return competitivePlayerIds(room).filter(id => !room.players[id].withdrawn); }
function tournamentLabel(format) { return ({ swiss:"Swiss", single:"Single Elimination", double:"Double Elimination", roundRobin:"Round Robin" })[format] || format; }
function makePairs(ids, standings = []) {
  const ranked = standings.length ? standings.filter(s => ids.includes(s.pid)).map(s => s.pid) : [...ids].sort(() => Math.random() - .5);
  const pairs = []; for (let i=0;i<ranked.length;i+=2) pairs.push({ player1Id:ranked[i], player2Id:ranked[i+1] || null, isBye:!ranked[i+1], winnerId: ranked[i+1] ? null : ranked[i] }); return pairs;
}
function initialTournament(room) {
  const ids = activePlayerIds(room);
  const firstPhase = room.settings?.phases?.[0] || "swiss";
  const weeklySchedule = firstPhase === "roundRobin" ? generateRoundRobinSchedule(ids) : [];
  const firstMatches = firstPhase === "roundRobin"
    ? (weeklySchedule[0]?.matches || [])
    : makePairs(ids);
  // Create round one as part of starting the event, rather than waiting for a
  // second host action. This makes every format immediately playable.
  return { phaseIndex:0, round:0, started:true, checkins:{}, pendingWithdrawals:{}, history:[{phaseIndex:0,round:1,format:firstPhase,matches:firstMatches}], phaseParticipants:ids, weeklySchedule, championId:null };
}
function tournamentStats(room) {
  const stats = Object.fromEntries(competitivePlayerIds(room).map(pid => [pid,{pid,name:room.players[pid].name,wins:0,losses:0,points:0,played:0}]));
  (room.tournament?.history||[]).forEach(round => round.matches.forEach(m => {
    if (!m.winnerId) return;
    // Round Robin ให้ BYE เป็นเพียงการพักรอบ จึงไม่นับสถิติหรือแต้ม
    if (m.isBye) {
      if (round.format !== "roundRobin" && stats[m.winnerId]) { stats[m.winnerId].wins++; stats[m.winnerId].points += 3; stats[m.winnerId].played++; }
      return;
    }
    const loser=m.winnerId===m.player1Id?m.player2Id:m.player1Id;
    if(stats[m.winnerId]) {stats[m.winnerId].wins++;stats[m.winnerId].points+=3;stats[m.winnerId].played++;}
    if(stats[loser]) {stats[loser].losses++;stats[loser].played++;}
  }));
  return Object.values(stats).sort((a,b)=>b.points-a.points||b.wins-a.wins||a.name.localeCompare(b.name));
}
function shouldCheckIn(room, roundIndex) {
  const t=room.tournament, policy=room.settings.checkIn; const idx = roundIndex ?? t.round;
  return policy === "everyRound" || (policy === "once" && idx === 0) || (policy === "perPhase" && idx === 0);
}
async function startTournament(roomId) {
  await runTransaction(ref(db,"rooms/"+roomId), room => {
    if(!room || room.status !== "waiting") return room;
    if (teamSheetRequired(room) && competitivePlayerIds(room).some(pid => !hasSubmittedTeamSheet(room.players?.[pid]))) return room;
    if (isGachaRoom(room) && gachaNotReadyIds(room).length) return room;
    room.status="tournament"; room.tournament=initialTournament(room); return room;
  });
}
function completeTournamentInTransaction(room, winnerId) {
  room.tournament.championId=winnerId||null; room.status="completed"; room.completedAt=Date.now();
  // ล้างข้อความทุกประเภททันทีที่ระบบตัดสินว่ารายการจบ
  room.chat=null; room.matchChats=null; room.adminChat=null; room.adminCalls=null;
}
async function beginNextRound() {
  let blockedReason = "";
  await updateRoom(room => {
    if(currentPlayerId !== room.hostId || room.status !== "tournament") return room;
    const t=room.tournament; if(t.phaseComplete) return room;
    let format=room.settings.phases[t.phaseIndex];
    Object.keys(t.pendingWithdrawals||{}).forEach(pid => room.players[pid].withdrawn=true); t.pendingWithdrawals={};
    let ids=(t.phaseParticipants||activePlayerIds(room)).filter(pid=>room.players[pid] && !room.players[pid].withdrawn), stats=tournamentStats(room);
    // เก็บ "เลขรอบที่จะเปิดถัดไป" ไว้ในตัวแปรชั่วคราวก่อน ยังไม่เขียนทับ t.round จริง
    // จนกว่าจะผ่านด่านเช็คอิน (ถ้ามี) และพร้อมสร้างรอบนั้นจริงๆ แล้วเท่านั้น
    // (เดิมบวก t.round ก่อนเช็ค แล้ว return ตอนยังไม่มีคนเช็คอิน ทำให้เลขรอบเพี้ยนค้างถาวร
    //  ส่งผลให้ระบบคิดว่าจบเฟสก่อนกำหนดจริง เพราะไปเทียบเลขรอบที่เพี้ยนนั้นกับจำนวนรอบที่ตั้งไว้)
    let nextRoundIndex = t.round;
    if (t.started && t.history.length) {
      const previous=t.history[t.history.length-1];
      // รองรับ BYE จากห้องเวอร์ชันเก่า และยืนยันผลที่รายงานแล้ว "ครบเวลารอแก้ไข 10 วินาทีแล้วเท่านั้น"
      // เมื่อโฮสต์เปิดรอบถัดไป — ถ้ายังไม่ครบ 10 วินาที ต้องรอ ไม่ยืนยันให้ล่วงหน้า เผื่อยังมีคนต้องการแก้ไขผลที่รายงานผิด
      const PENDING_CONFIRM_WINDOW_MS = 10000;
      previous.matches.forEach(m => {
        if (m.isBye && !m.winnerId) { m.winnerId = m.player1Id; m.score = "BYE"; }
        if (!m.winnerId && m.pendingWinnerId && Date.now() - (m.reportedAt || 0) >= PENDING_CONFIRM_WINDOW_MS) {
          m.winnerId=m.pendingWinnerId; m.score=m.pendingScore; m.pendingWinnerId=null; m.pendingScore=null;
        }
      });
      const incomplete=previous.matches.some(m=>!m.winnerId);
      if(incomplete) {
        const stillPending = previous.matches.some(m=>!m.winnerId && m.pendingWinnerId);
        blockedReason = stillPending ? "ยังมีผลการแข่งขันที่กำลังรอยืนยัน กรุณารอให้ครบเวลายืนยันก่อน" : "ยังมีคู่แข่งขันที่ไม่ได้บันทึกผล";
        return room;
      }
      if (isGachaRoom(room) && activePlayerIds(room).some(pid => room.players[pid].pendingPull)) { blockedReason = "มีผู้เล่นที่สุ่มได้แล้วแต่ยังไม่เลือกทิ้ง/แทนที่ตัวใหม่ กรุณารอให้ทุกคนตัดสินใจก่อน"; return room; }
      if(format === "single") ids=previous.matches.filter(m=>m.winnerId).map(m=>m.winnerId).filter(pid=>room.players[pid] && !room.players[pid].withdrawn);
      if(format === "double") { t.losses=t.losses||{}; previous.matches.forEach(m=>{if(!m.isBye&&m.winnerId){const loser=m.winnerId===m.player1Id?m.player2Id:m.player1Id;t.losses[loser]=(t.losses[loser]||0)+1;}}); ids=ids.filter(pid=>(t.losses[pid]||0)<2 && room.players[pid] && !room.players[pid].withdrawn); }
      const rrRounds=format === "roundRobin" ? (t.weeklySchedule?.length || generateRoundRobinSchedule(ids).length) : 0;
      const phaseEnded=(format === "single" || format === "double") && ids.length<=1 || (format === "swiss" && t.round+1 >= (room.settings.swissRounds||3)) || (format === "roundRobin" && t.round+1 >= rrRounds);
      if(phaseEnded) {
        if(t.phaseIndex+1 < room.settings.phases.length) { t.phaseComplete=true; return room; }
        const winner=(format === "single" || format === "double") ? ids[0] : tournamentStats(room).filter(s=>!room.players[s.pid].withdrawn)[0]?.pid;
        completeTournamentInTransaction(room,winner); return room;
      }
      nextRoundIndex = t.round + 1;
    }
    if(shouldCheckIn(room, nextRoundIndex)) { const checked=Object.keys(t.checkins||{}).filter(pid=>t.checkins[pid]); if(!checked.length) {t.checkinRequired=true; return room;} ids=ids.filter(pid=>checked.includes(pid)); t.checkins={}; t.checkinRequired=false; }
    t.round = nextRoundIndex;
    const matches = format === "roundRobin" ? (t.weeklySchedule?.[t.round]?.matches || []) : makePairs(ids,stats);
    // ตารางแบบ Round Robin ถูกสร้างไว้ล่วงหน้าตั้งแต่ต้นทัวร์นาเมนต์ ถ้ามีใครถอนตัว/ถูกเตะออกไปแล้ว
    // ระหว่างทาง คู่ของรอบถัดไปที่มีเขาอยู่ต้องถูกปรับให้อีกฝ่ายชนะอัตโนมัติ ไม่ใช่ปล่อยให้ยังจับคู่แข่งกันอยู่
    matches.forEach(m => {
      if (m.winnerId) return;
      const p1Out = !!room.players[m.player1Id]?.withdrawn;
      const p2Out = !!(m.player2Id && room.players[m.player2Id]?.withdrawn);
      if (p1Out && p2Out) { m.winnerId = null; m.isBye = true; m.score = "ถอนตัวทั้งคู่"; }
      else if (p1Out) { m.winnerId = m.player2Id; m.score = "ถอนตัว"; m.reportedAt = Date.now(); }
      else if (p2Out) { m.winnerId = m.player1Id; m.score = "ถอนตัว"; m.reportedAt = Date.now(); }
    });
    t.history.push({phaseIndex:t.phaseIndex,round:t.round+1,format,matches}); t.started=true; return room;
  });
  if (blockedReason) alert(`${blockedReason} — กรุณาระบุผู้ชนะให้ครบก่อนเริ่มรอบต่อไป`);
}
async function advanceTournamentPhase() {
  await updateRoom(room => {
    if(currentPlayerId!==room.hostId || room.status!=="tournament") return room;
    const t=room.tournament; if(t.phaseIndex+1 >= room.settings.phases.length) return room;
    const last=t.history[t.history.length-1]; if(last?.matches.some(m=>!m.winnerId)) return room;
    if (isGachaRoom(room) && activePlayerIds(room).some(pid=>room.players[pid].pendingPull)) return room;
    // นำอันดับถัดไปมาแทนที่ผู้ถอนตัวทันทีตอนคัด Top
    Object.keys(t.pendingWithdrawals||{}).forEach(pid=>room.players[pid].withdrawn=true); t.pendingWithdrawals={};
    const cut=room.settings.topCut||activePlayerIds(room).length;
    t.phaseParticipants=tournamentStats(room).filter(s=>!room.players[s.pid].withdrawn).slice(0,cut).map(s=>s.pid);
    // เก็บประวัติแมตช์ของเฟสที่เพิ่งจบไว้ใน phaseHistory ก่อนเคลียร์ history สำหรับเฟสใหม่
    // (ไม่งั้นข้อมูลรอบของเฟส 1 จะหายไปถาวรทันทีที่กดปิดเฟส ทำให้ดูประวัติย้อนหลังไม่ได้)
    t.phaseHistory=[...(t.phaseHistory||[]), ...t.history];
    t.phaseIndex++; t.round=0; t.history=[]; t.started=false; t.checkins={}; t.checkinRequired=false; t.phaseComplete=false; t.losses={};
    // สร้างคู่แข่งขันรอบแรกของเฟสใหม่ทันทีในธุรกรรมเดียวกันนี้เลย แทนที่จะรอให้หน้าจอของโฮสต์
    // เรนเดอร์ใหม่แล้วค่อยยิงคำสั่งสร้างรอบแยกต่างหากทีหลัง (ซึ่งถ้าหน้าจอโฮสต์ไม่ได้เปิดอยู่พอดี
    // หรือมีปัญหาใดๆ ระหว่างทาง จะทำให้ "กดปิดเฟสแล้วไม่มีอะไรเกิดขึ้น" ค้างอยู่แบบนี้)
    const newFormat=room.settings.phases[t.phaseIndex]||"swiss";
    const ids=t.phaseParticipants;
    const weeklySchedule = newFormat === "roundRobin" ? generateRoundRobinSchedule(ids) : [];
    t.weeklySchedule = weeklySchedule;
    t.history=[{phaseIndex:t.phaseIndex, round:1, format:newFormat, matches: newFormat === "roundRobin" ? (weeklySchedule[0]?.matches||[]) : makePairs(ids, [])}];
    t.started=true;
    return room;
  });
}
async function tournamentAction(action, payload={}) {
  try {
    const result = await updateRoom(room => {
      const t=room.tournament, spectator=room.players?.[currentPlayerId]?.isSpectator;
      if(!t || !room.players?.[currentPlayerId]) return room;
      if(action==='checkin'&&!spectator) t.checkins[currentPlayerId]=true;
      if(action==='withdraw'&&!spectator) {
        room.players[currentPlayerId].withdrawn=true;
        delete t.pendingWithdrawals?.[currentPlayerId];
        const current=t.history?.[t.history.length-1];
        const match=current?.matches?.find(m=>!m.isBye&&!m.winnerId&&(m.player1Id===currentPlayerId||m.player2Id===currentPlayerId));
        if(match) { match.winnerId=match.player1Id===currentPlayerId?match.player2Id:match.player1Id; match.score="ถอนตัว"; match.reportedAt=Date.now(); }
      }
      if(action==='result') { const m=t.history[payload.round]?.matches[payload.match]; const validScore=room.settings.bestOf==="BO3" ? /^(2-[01]|[01]-2)$/.test(payload.score||"") : payload.score==="1-0" || payload.score==="0-1"; const winnerMatchesScore=payload.winner===m?.player1Id ? String(payload.score).startsWith("2")||payload.score==="1-0" : String(payload.score).endsWith("2")||payload.score==="0-1"; if(m&&!m.isBye&&validScore&&winnerMatchesScore&&(currentPlayerId===room.hostId||currentPlayerId===m.player1Id||currentPlayerId===m.player2Id)) { m.pendingWinnerId=payload.winner; m.pendingScore=payload.score; m.reportedAt=Date.now(); m.reportedBy=currentPlayerId; } }
      // ผู้จัดห้อง (host) หรือแอดมิน แก้ไขผลที่ยืนยันไปแล้วได้ เฉพาะรอบปัจจุบัน ก่อนเริ่มรอบต่อไป
      if(action==='editResult') {
        const canEdit = currentPlayerId===room.hostId || isOwner || (isStaff && !!myAffiliation && myAffiliation===room.affiliation);
        const latestRoundIndex = t.history.length-1;
        const m = payload.round===latestRoundIndex ? t.history[latestRoundIndex]?.matches[payload.match] : null;
        const validScore=room.settings.bestOf==="BO3" ? /^(2-[01]|[01]-2)$/.test(payload.score||"") : payload.score==="1-0" || payload.score==="0-1";
        const winnerMatchesScore=payload.winner===m?.player1Id ? String(payload.score).startsWith("2")||payload.score==="1-0" : String(payload.score).endsWith("2")||payload.score==="0-1";
        if(m&&!m.isBye&&canEdit&&validScore&&winnerMatchesScore&&m.winnerId) { m.winnerId=payload.winner; m.score=payload.score; m.pendingWinnerId=null; m.pendingScore=null; m.editedBy=currentPlayerId; m.editedAt=Date.now(); }
      }
      return room;
    });
    if (!result.committed) throw new Error("Firebase did not commit the change");
    return true;
  } catch (error) {
    console.error("tournament action failed:", error);
    alert("บันทึกไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตหรือสิทธิ์เข้าห้อง แล้วลองใหม่อีกครั้ง");
    return false;
  }
}

// ---------- เตะผู้เล่นออกจากห้อง (โฮสต์เท่านั้น) ----------
// ห้องรอเริ่ม: ลบผู้เล่นออกจากห้องไปเลย เพราะยังไม่มีสถิติ/แมตช์ผูกอยู่
async function kickPlayerFromLobby(targetPlayerId) {
  if (!isHost || !currentRoomId || !targetPlayerId || targetPlayerId === currentPlayerId) return;
  const targetName = latestRoom?.players?.[targetPlayerId]?.name || "ผู้เล่นนี้";
  if (!confirm(`เตะ "${targetName}" ออกจากห้องหรือไม่?`)) return;
  try {
    await updateRoom((room) => {
      if (currentPlayerId !== room.hostId || room.status !== "waiting") return room;
      const target = room.players?.[targetPlayerId];
      if (!target || target.isHost) return room;
      if (isGachaRoom(room) && !gachaAllowDup(room) && room.gachaTaken) {
        (target.team || []).forEach(m => { if (m?.id) delete room.gachaTaken[m.id]; });
        if (target.pendingPull?.id) delete room.gachaTaken[target.pendingPull.id];
      }
      if (target.userUid && room.memberUids) delete room.memberUids[target.userUid];
      delete room.players[targetPlayerId];
      return room;
    });
  } catch (error) {
    console.error("kickPlayerFromLobby failed:", error);
    alert("เตะผู้เล่นไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }
}
// ระหว่างทัวร์นาเมนต์: ทำเสมือนถอนตัวให้ (คงสถิติ/ทีมไว้เพื่อดูย้อนหลัง) พร้อมปรับให้คู่แข่งขันปัจจุบันชนะทันที
async function kickPlayerFromTournament(targetPlayerId) {
  if (!isHost || !currentRoomId || !targetPlayerId || targetPlayerId === currentPlayerId) return;
  const targetName = latestRoom?.players?.[targetPlayerId]?.name || "ผู้เล่นนี้";
  if (!confirm(`เตะ "${targetName}" ออกจากทัวร์นาเมนต์หรือไม่? ระบบจะถือว่าถอนตัว และปรับให้คู่แข่งขันปัจจุบันชนะทันที`)) return;
  try {
    await updateRoom((room) => {
      const t = room.tournament;
      if (currentPlayerId !== room.hostId || room.status !== "tournament" || !t) return room;
      const target = room.players?.[targetPlayerId];
      if (!target || target.withdrawn) return room;
      target.withdrawn = true;
      target.kicked = true;
      const current = t.history?.[t.history.length - 1];
      const match = current?.matches?.find(m => !m.isBye && !m.winnerId && (m.player1Id === targetPlayerId || m.player2Id === targetPlayerId));
      if (match) { match.winnerId = match.player1Id === targetPlayerId ? match.player2Id : match.player1Id; match.score = "ถูกเตะออก"; match.reportedAt = Date.now(); }
      return room;
    });
  } catch (error) {
    console.error("kickPlayerFromTournament failed:", error);
    alert("เตะผู้เล่นไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }
}

function parseTeamProfile(text) {
  return String(text||"").split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const [pokemon="", moves="", item="", nature=""] = line.split("|").map(x=>x.trim());
    return { pokemon, moves:moves.split(",").map(x=>x.trim()).filter(Boolean), item, nature };
  }).filter(p=>p.pokemon).slice(0, 6);
}
function parseTeamSheetProfile(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  if (raw.includes("|")) return parseTeamProfile(raw);
  return raw.split(/\r?\n\s*\r?\n/).map(block => {
    const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const header = lines[0] || "";
    const [namePart, itemPart = ""] = header.split(/\s+@\s+/, 2);
    const speciesMatches = [...namePart.matchAll(/\(([^)]+)\)/g)].map(match => match[1]).filter(value => !/^[MF]$/i.test(value));
    const pokemon = (speciesMatches[0] || namePart.replace(/\s+\([MF]\)$/, "")).trim();
    const nature = lines.find(line => /\sNature$/i.test(line))?.replace(/\sNature$/i, "").trim() || "";
    const ability = lines.find(line => /^Ability:\s*/i.test(line))?.replace(/^Ability:\s*/i, "").trim() || "";
    const moves = lines.filter(line => /^-\s+/.test(line)).map(line => line.replace(/^-\s+/, "").trim());
    return { pokemon, moves, item: itemPart.trim(), nature, ability };
  }).filter(member => member.pokemon).slice(0, 6);
}
function tournamentTeamOf(player) {
  if (Array.isArray(player?.team) && player.team.length) return player.team.map(member => ({
    pokemon: member.displayName || "Pokémon",
    sprite: member.sprite || "",
    moves: [],
    item: member.price ? `ประมูล ${Number(member.price).toLocaleString()}` : (member.viaGacha ? (member.machine === "mega" ? "จากตู้เมก้า" : "จากตู้ธรรมดา") : member.viaTicket ? "รับจากตั๋ว" : (member.viaRandom ? "สุ่มให้" : (member.viaGift ? `ของขวัญจาก ${member.giftedFromName || "เพื่อน"}` : ""))),
    nature: ""
  }));
  return parseTeamSheetProfile(player?.teamSheet || player?.teamText);
}
function profileOf(player) { return tournamentTeamOf(player); }
function teamPreviewHtml(player, key) {
  const profile=profileOf(player); if(!profile.length) return `<p class="small-text">ยังไม่ได้บันทึกข้อมูลทีม</p>`;
  const isAuctionTeam = Array.isArray(player?.team) && player.team.length;
  const source = isAuctionTeam ? (player.team.some(m => m?.viaGacha) ? "Box จากตู้สุ่ม" : "ทีมจากการประมูล") : "Team Sheet";
  if (isAuctionTeam) {
    // ทีมจากการประมูล/ดราฟต์ ไม่มีข้อมูลท่า/นิสัย/อบิลิตี้ -> ใช้การ์ดแบบเดิม (ชื่อ + ไอเทม)
    const roster = profile.map((p, index) => `<div class="auction-sheet-member"><img src="${p.sprite || teamSheetSprite(p.pokemon)}"${p.sprite ? "" : ` data-poke-name="${escapeHtml(p.pokemon)}"`} alt="${escapeHtml(p.pokemon)}" onerror="this.style.visibility='hidden'"><b>${escapeHtml(p.pokemon)}</b><small>#${index + 1}${p.item ? ` • ${escapeHtml(p.item)}` : ""}</small></div>`).join("");
    return `<button class="team-toggle" data-team-toggle="${key}">👁️ ดูทีมของ ${escapeHtml(player?.name || "ผู้เล่น")}</button><div id="team-preview-${key}" class="team-preview live-team-preview hidden"><b class="team-preview-owner">${source} ของ ${escapeHtml(player?.name || "ผู้เล่น")}</b><div class="auction-sheet-roster">${roster}</div></div>`;
  }
  // Team Sheet ที่พิมพ์เอง -> การ์ดชีทแบบ VGCode (ท่า/ไอเทม/นิสัย + กดดูรายละเอียดได้ ไม่โชว์ตัวเลข EV แสดงเฉพาะสีของนิสัย)
  return `<button class="team-toggle" data-team-toggle="${key}">👁️ ดูทีมของ ${escapeHtml(player?.name || "ผู้เล่น")}</button><div id="team-preview-${key}" class="team-preview live-team-preview hidden"><b class="team-preview-owner">${source} ของ ${escapeHtml(player?.name || "ผู้เล่น")}</b>${sheetViewerHtml("sheet-" + key, sheetMonsOf(player), { showEvs: false })}</div>`;
}
function bindTeamToggles(root) { root.querySelectorAll("button[data-team-toggle]").forEach(btn=>btn.addEventListener("click",()=>{const pv=document.getElementById("team-preview-"+btn.dataset.teamToggle); pv?.classList.toggle("hidden"); if(pv && !pv.classList.contains("hidden")) pv.querySelectorAll(".sheet-viewer").forEach(hydrateSheetViewer);})); hydratePokeApiSprites(root); }
function renderMetaAnalytics(room) {
  const box=document.getElementById("meta-analytics"), content=document.getElementById("meta-content");
  box.classList.remove("hidden");
  const teams=competitivePlayerIds(room).map(pid=>tournamentTeamOf(room.players[pid])).filter(team=>team.length);
  if (!teams.length) { content.innerHTML='<p class="small-text">ยังไม่มี Team Sheet สำหรับคำนวณ Meta</p>'; return; }
  const totals={pokemon:{},moves:{},items:{},natures:{}};
  teams.forEach(team=>team.forEach(mon=>{const add=(group,value)=>{if(value) totals[group][value]=(totals[group][value]||0)+1;};add("pokemon",mon.pokemon);(mon.moves||[]).forEach(x=>add("moves",x));add("items",mon.item);add("natures",mon.nature);}));
  const rows=(title,obj,percent)=>`<div><b>${title}</b>${Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([name,count])=>`<br>${escapeHtml(name)}: ${count}${percent?` (${Math.round(count/Math.max(1,teams.length)*100)}%)`:""}`).join("")||"<br>ยังไม่มีข้อมูล"}</div>`;
  content.innerHTML=`<p class="small-text">คำนวณจาก Team Sheet ที่ส่งแล้ว ${teams.length}/${competitivePlayerIds(room).length} ทีม</p><div class="meta-grid">${rows("Pokémon usage",totals.pokemon,true)}${rows("Moves",totals.moves)}${rows("Items",totals.items)}${rows("Natures",totals.natures)}</div>`;
}
function formatTournamentDate(time) { return new Intl.DateTimeFormat("th-TH",{dateStyle:"full",timeStyle:"short"}).format(new Date(time)); }
function renderChatMessages(element, messages) { element.innerHTML=Object.values(messages||{}).sort((a,b)=>a.time-b.time).map(m=>`<div class="chat-msg"><b>${escapeHtml(m.name)}:</b> ${escapeHtml(m.text)}</div>`).join(""); element.scrollTop=element.scrollHeight; }
function mountMatchChat(room, roundIndex, matchIndex, canChat) {
  if(!canChat) return; const key=`match-chat-${roundIndex}-${matchIndex}`, input=document.getElementById(`${key}-input`), box=document.getElementById(`${key}-messages`); if(!box||!input) return;
  const chatRef=ref(db,`rooms/${currentRoomId}/matchChats/${roundIndex}/${matchIndex}`); onValue(chatRef,snap=>renderChatMessages(box,snap.val()));
  document.getElementById(`${key}-send`).onclick=()=>{const text=input.value.trim(); if(text) {push(chatRef,{name:room.players[currentPlayerId]?.name||"ผู้เล่น",text,time:Date.now()});input.value="";}};
}
function currentMatchContext(room, playerId) {
  const rounds = room.tournament?.history || [];
  const roundIndex = rounds.length - 1;
  const round = rounds[roundIndex];
  const matchIndex = round?.matches?.findIndex(m => !m.isBye && !m.winnerId && (m.player1Id === playerId || m.player2Id === playerId)) ?? -1;
  const match = matchIndex >= 0 ? round.matches[matchIndex] : null;
  if (!match) return { matchKey: "general", matchLabel: "คำขอทั่วไป (ยังไม่มีคู่ที่กำลังแข่ง)" };
  const a = room.players?.[match.player1Id]?.name || "-";
  const b = room.players?.[match.player2Id]?.name || "-";
  return { roundIndex, matchIndex, matchKey: `${roundIndex}-${matchIndex}`, matchLabel: `รอบ ${round.round || roundIndex + 1}: ${a} VS ${b}`, player1Id: match.player1Id, player2Id: match.player2Id };
}
function canManageRoom(room) {
  return !!room && !!currentUser && (isOwner || room.creatorUid === currentUser.uid || (isStaff && !!myAffiliation && room.affiliation === myAffiliation));
}

// ผลที่ยืนยันแล้วแก้ได้เฉพาะแอดมินหลัก หรือผู้จัดที่สร้างทัวร์นาเมนต์นี้
// (ทีมงานสังกัดเดียวกันยังดูแลแชท/คำขอได้ แต่แก้ผลแข่งขันไม่ได้)
function canEditConfirmedResults(room) {
  return !!room && !!currentUser && (isOwner || room.creatorUid === currentUser.uid);
}
function closeAdminCallDrawer() { document.getElementById("admin-call-drawer")?.classList.add("hidden"); }
function syncAdminCallDrawer(room, roomId = currentRoomId) {
  const drawer = document.getElementById("admin-call-drawer");
  const openButton = document.getElementById("btn-open-admin-calls");
  const allowed = canManageRoom(room);
  openButton?.classList.toggle("hidden", !allowed || room.status !== "tournament");
  if (!allowed) {
    closeAdminCallDrawer();
    if (adminCallsUnsub) adminCallsUnsub();
    adminCallsUnsub = null; adminCallsRoomId = null;
    return;
  }
  openButton.onclick = () => drawer.classList.remove("hidden");
  if (adminCallsRoomId === roomId) return;
  if (adminCallsUnsub) adminCallsUnsub();
  adminCallsRoomId = roomId;
  adminCallsUnsub = onValue(ref(db, `rooms/${roomId}/adminCalls`), snap => {
    const calls = Object.entries(snap.val() || {}).filter(([, call]) => call.status !== "closed");
    const groups = calls.reduce((all, [id, call]) => {
      const key = call.matchKey || "general";
      (all[key] ||= { label: call.matchLabel || "คำขอทั่วไป", calls: [] }).calls.push({ id, ...call });
      return all;
    }, {});
    document.getElementById("admin-call-drawer-content").innerHTML = Object.values(groups).map(group => `<section class="admin-call-group"><h4>${escapeHtml(group.label)}</h4>${group.calls.sort((a,b)=>b.time-a.time).map(call => `<div class="admin-call-item"><b>${escapeHtml(call.name || "ผู้เล่น")}</b><br><span class="small-text">${formatTournamentDate(call.time)} • ${call.status === "acknowledged" ? "รับเรื่องแล้ว" : "รอรับเรื่อง"}</span><div class="admin-call-actions">${call.status === "open" ? `<button class="primary" data-admin-call-action="acknowledged" data-call-id="${call.id}">รับเรื่อง</button>` : ""}<button class="btn-leave-small" data-admin-call-action="closed" data-call-id="${call.id}">ปิดคำขอ</button></div></div>`).join("")}</section>`).join("") || '<p class="small-text">ไม่มีคำขอเรียกแอดมิน</p>';
    if (calls.length) drawer.classList.remove("hidden");
    document.querySelectorAll("[data-admin-call-action]").forEach(button => button.onclick = async () => {
      try { await update(ref(db, `rooms/${roomId}/adminCalls/${button.dataset.callId}`), { status: button.dataset.adminCallAction, handledBy: currentUser.uid, handledAt: Date.now() }); }
      catch (error) { console.error("admin call update failed:", error); alert("อัปเดตคำขอไม่สำเร็จ"); }
    });
  });
}
document.getElementById("btn-close-admin-calls")?.addEventListener("click", closeAdminCallDrawer);
function mountAdminChat(room) {
  const box=document.getElementById("admin-chat-messages"), input=document.getElementById("admin-chat-input"), chatRef=ref(db,`rooms/${currentRoomId}/adminChat`); onValue(chatRef,snap=>renderChatMessages(box,snap.val()));
  document.getElementById("btn-admin-chat-send").onclick=async()=>{const text=input.value.trim();if(text){try { await push(chatRef,{name:room.players[currentPlayerId]?.name||"ผู้เล่น",text,time:Date.now(),senderId:currentPlayerId}); input.value=""; } catch(error) { console.error("admin chat failed:", error); alert("ส่งข้อความไม่สำเร็จ"); }}};
  document.getElementById("btn-call-admin").onclick=async()=>{
    const status = document.getElementById("admin-call-status");
    const btn = document.getElementById("btn-call-admin");
    if (btn.disabled) return; // กันกดรัว/ดับเบิลแตะ ระหว่างรอผลจากรอบก่อนหน้า
    btn.disabled = true;
    const context = currentMatchContext(room, currentPlayerId);
    // ใช้คีย์คงที่ต่อผู้เล่น+คู่แข่งขัน (ไม่ใช้ push ซึ่งสุ่มคีย์ใหม่ทุกครั้ง) เพื่อให้ต่อให้กดรัวกี่ครั้ง
    // ก็จะยังเป็นคำขอเดียวกันเสมอ ไม่สร้างรายการซ้ำซ้อนในศูนย์ดูแลทัวร์ของแอดมิน
    const callRef = ref(db, `rooms/${currentRoomId}/adminCalls/${currentPlayerId}_${context.matchKey}`);
    try {
      const existingSnap = await get(callRef);
      const existing = existingSnap.exists() ? existingSnap.val() : null;
      if (existing && existing.status !== "closed") {
        status.textContent = "มีคำขอสำหรับคู่นี้อยู่แล้ว";
      } else {
        await set(callRef, {playerId:currentPlayerId,name:room.players[currentPlayerId]?.name||"ผู้เล่น",time:Date.now(),status:"open",...context});
        status.textContent = `ส่งคำขอเรียกแอดมินแล้ว (${context.matchLabel})`;
      }
    } catch (error) { console.error("admin call failed:", error); status.textContent = "ส่งคำขอไม่สำเร็จ กรุณาลองใหม่"; }
    finally { btn.disabled = false; }
  };
}
async function finishTournament(room) {
  if(!isHost || !currentRoomId || !confirm("จบทัวร์นาเมนต์และล้างแชททั้งหมดใช่หรือไม่?")) return;
  const summary={roomId:currentRoomId,finishedAt:Date.now(),organizer:room.players[room.hostId]?.name||"-",format:(room.settings.phases||[]).map(tournamentLabel).join(" → "),champion:room.tournament?.championId?room.players[room.tournament.championId]?.name||"-":"-"};
  await update(ref(db,`rooms/${currentRoomId}`),{status:"completed",chat:null,matchChats:null,adminChat:null,adminCalls:null,completedAt:summary.finishedAt});
  if(currentUser?.uid) await set(ref(db,`userHistory/${currentUser.uid}/${currentRoomId}`),{...summary,role:"organizer"});
}
async function saveMyTournamentHistory(room) {
  if(!currentUser?.uid || !currentPlayerId || !room.players[currentPlayerId] || room.historySaved?.[currentPlayerId]) return;
  const summary={roomId:currentRoomId,finishedAt:room.completedAt||Date.now(),organizer:room.players[room.hostId]?.name||"-",format:(room.settings.phases||[]).map(tournamentLabel).join(" → "),role:currentPlayerId===room.hostId?"organizer":"player"};
  await update(ref(db,`userHistory/${currentUser.uid}/${currentRoomId}`),summary);
  await update(ref(db,`rooms/${currentRoomId}/historySaved/${currentPlayerId}`),true);
}
function renderTournament(room) {
  try {
    renderTournamentInner(room);
  } catch (error) {
    // กันหน้าจอขาวโล่งไม่มีอะไรขึ้นเลยเวลามีบั๊กไม่คาดคิด อย่างน้อยให้เห็นข้อความแจ้ง และ error ไปลง console เพื่อตามแก้ได้
    console.error("renderTournament failed:", error);
    const pairs = document.getElementById("tournament-pairings");
    if (pairs) pairs.innerHTML = '<p class="small-text">⚠️ เกิดข้อผิดพลาดระหว่างแสดงผลหน้านี้ ลองรีเฟรชหน้าเว็บ ถ้ายังไม่หายกรุณาแจ้งผู้ดูแลระบบ</p>';
  }
}
function renderTournamentInner(room) {
  // รองรับห้องเก่าที่สร้างก่อนเพิ่มตัวเลือกรูปแบบการแข่งขัน
  room.settings={maxPlayers:4,mode:"normal",phases:["swiss"],bestOf:"BO1",checkIn:"once",...room.settings,phases:room.settings?.phases?.length?room.settings.phases:["swiss"]};
  const t=room.tournament||initialTournament(room), phase=room.settings.phases[t.phaseIndex]||"swiss", stats=tournamentStats(room), current=t.history[t.history.length-1];
  const amSpectator=!!room.players[currentPlayerId]?.isSpectator;
  document.getElementById("tournament-room-code").textContent=currentRoomId;
  renderGachaPanel(room, document.getElementById("tournament-gacha-panel"), {});
  document.getElementById("tournament-meta").textContent=`เฟส ${t.phaseIndex+1}/${room.settings.phases.length}: ${tournamentLabel(phase)} • ${room.settings.bestOf} • ผู้เล่นสมัคร ${competitivePlayerIds(room).length}/${room.settings.maxPlayers}`;
  document.getElementById("tournament-date").textContent=`เริ่มการแข่งขัน: ${formatTournamentDate(room.createdAt)}${room.completedAt?` • จบ: ${formatTournamentDate(room.completedAt)}`:""}`;
  const archiveSave = document.getElementById("completed-archive-save");
  archiveSave?.classList.toggle("hidden", room.status !== "completed" || !isHost || !!room.archiveId);
  document.getElementById("btn-save-completed-archive").onclick = saveCompletedTournamentArchive;
  if(room.status === "tournament") mountAdminChat(room);
  syncAdminCallDrawer(room);
  const editor=document.getElementById("team-profile-input"); editor?.closest(".team-editor")?.classList.add("hidden");
  const check=document.getElementById("tournament-checkin"), need=shouldCheckIn(room, t.round + 1)&&(!current||current.matches.every(m=>m.winnerId)), checkedCount=Object.keys(t.checkins||{}).filter(pid=>t.checkins[pid]).length, eligibleCount=activePlayerIds(room).length; check.innerHTML=need?`<div class="checkin-content"><span class="checkin-icon">✅</span><div><b>เช็คอินสำหรับรอบถัดไป</b><span class="small-text">${checkedCount}/${eligibleCount} คนเช็คอินแล้ว • ${room.settings.checkIn}</span></div>${amSpectator?"<span class=\"small-text\">ผู้สังเกตการณ์ไม่ต้องเช็คอิน</span>":`<button id="btn-checkin" ${t.checkins?.[currentPlayerId]?"disabled":""}>${t.checkins?.[currentPlayerId]?"เช็คอินแล้ว ✓":"เช็คอิน"}</button>`}</div>${t.checkinRequired?"<p class=\"checkin-warning\">รอผู้เล่นเช็คอินก่อนเริ่มรอบถัดไป</p>":""}`:""; document.getElementById("btn-checkin")?.addEventListener("click",()=>tournamentAction("checkin"));
  const pairs=document.getElementById("tournament-pairings");
  if(t.championId) pairs.innerHTML=`<div class="match-card"><h3>👑 แชมป์: ${escapeHtml(room.players[t.championId]?.name||"-")}</h3></div>`;
  else if(!current) { pairs.innerHTML=`<p class="small-text">กำลังสร้างคู่แข่งขันรอบแรก...</p>`; ensureFirstTournamentRound(); }
  else pairs.innerHTML=`<h3>รอบ ${current.round} — ${tournamentLabel(current.format)}</h3>`+current.matches.map((m,i)=>{const a=room.players[m.player1Id]?.name||"-",b=m.player2Id?room.players[m.player2Id]?.name:"BYE",canReport=isHost||currentPlayerId===m.player1Id||currentPlayerId===m.player2Id,canEditResult=(isHost||canManageRoom(room))&&!m.isBye&&!!m.winnerId,chatId=`match-chat-${t.history.length-1}-${i}`; const scoreOptions=room.settings.bestOf==="BO3"?'<option value="2-0">2 – 0</option><option value="2-1">2 – 1</option><option value="1-2">1 – 2</option><option value="0-2">0 – 2</option>':'<option value="1-0">1 – 0</option><option value="0-1">0 – 1</option>'; const controls=canReport&&!m.isBye&&!m.winnerId?`<div class="report-controls score-entry"><div class="score-entry-title"><span>🏁 บันทึกผลการแข่งขัน</span><small>สกอร์เรียง: ${escapeHtml(a)} – ${escapeHtml(b)}</small></div><label><span>เลือกสกอร์</span><select data-score-match="${i}">${scoreOptions}</select></label><button data-save-result="${i}">✓ ยืนยันผล</button></div>`:""; const editScoreOptions=room.settings.bestOf==="BO3"?['2-0','2-1','1-2','0-2']:['1-0','0-1']; const editWinnerOptions=`<option value="${m.player1Id}" ${m.winnerId===m.player1Id?"selected":""}>${escapeHtml(a)} ชนะ</option><option value="${m.player2Id}" ${m.winnerId===m.player2Id?"selected":""}>${escapeHtml(b)} ชนะ</option>`; const editScoreSelect=editScoreOptions.map(value=>`<option value="${value}" ${m.score===value?"selected":""}>${value}</option>`).join(""); const editControls=canEditResult?`<div class="report-controls score-entry edit-result-controls"><div class="score-entry-title"><span>✏️ แก้ไขผลที่ยืนยันแล้ว</span><small>แก้ได้เฉพาะรอบนี้ ก่อนเริ่มรอบต่อไป</small></div><label><span>ผู้ชนะ</span><select data-edit-winner-match="${i}">${editWinnerOptions}</select></label><label><span>สกอร์</span><select data-edit-score-match="${i}">${editScoreSelect}</select></label><button data-edit-result="${i}">✏️ บันทึกการแก้ไข</button></div>`:""; const chat=canReport&&!m.isBye?`<div class="match-chat"><b>💬 แชทเฉพาะคู่แข่งขัน</b><div class="chat-messages" id="${chatId}-messages"></div><div class="chat-input-row"><input id="${chatId}-input" maxlength="300" placeholder="คุยกับคู่แข่ง"><button id="${chatId}-send">ส่ง</button></div></div>`:""; const pending=m.pendingWinnerId?`รายงาน: ${escapeHtml(room.players[m.pendingWinnerId]?.name||"")} ชนะ (${m.pendingScore||"-"}) — แก้ไขได้ 10 วินาที` : "รอรายงานผล"; const byeText=current.format==="roundRobin"?"พักรอบนี้ (ไม่คิดแต้ม)":"ชนะบาย (+3 แต้ม)";return `<div class="match-card"><div class="match-players"><span>${escapeHtml(a)}</span><span class="vs">VS</span><span>${escapeHtml(b)}</span></div><p class="small-text">${m.isBye?byeText:m.winnerId?`ผู้ชนะ: ${escapeHtml(room.players[m.winnerId]?.name||"")} (${m.score||"-"})`:pending}</p>${controls}${editControls}${teamPreviewHtml(room.players[m.player1Id],`match-${i}-a`)}${m.player2Id?teamPreviewHtml(room.players[m.player2Id],`match-${i}-b`):""}${chat}</div>`}).join("");
  pairs.querySelectorAll("button[data-save-result]").forEach(button=>button.addEventListener("click",()=>{const matchIndex=+button.dataset.saveResult,match=current.matches[matchIndex],score=pairs.querySelector(`[data-score-match="${matchIndex}"]`)?.value;const winner=String(score).startsWith("2")||score==="1-0"?match.player1Id:match.player2Id;tournamentAction("result",{round:t.history.length-1,match:matchIndex,winner,score});}));
  pairs.querySelectorAll("button[data-edit-result]").forEach(button=>button.addEventListener("click",()=>{const matchIndex=+button.dataset.editResult,winner=pairs.querySelector(`[data-edit-winner-match="${matchIndex}"]`)?.value,score=pairs.querySelector(`[data-edit-score-match="${matchIndex}"]`)?.value;if(!confirm("ยืนยันแก้ไขผลการแข่งขันนี้?")) return;tournamentAction("editResult",{round:t.history.length-1,match:matchIndex,winner,score});}));
  current?.matches.forEach((match, index) => {
    const card = pairs.querySelectorAll(".match-card")[index];
    const players = card?.querySelectorAll(".match-players span:not(.vs)");
    if (!match.isBye && match.winnerId && players?.length === 2) {
      players[0].classList.add(match.winnerId === match.player1Id ? "winner-name" : "loser-name");
      players[1].classList.add(match.winnerId === match.player2Id ? "winner-name" : "loser-name");
    }
    if (match.pendingWinnerId && !match.winnerId) {
      const status = card?.querySelector(".small-text");
      if (status) status.innerHTML = `⏳ รอยืนยันผล: <b>${escapeHtml(room.players[match.pendingWinnerId]?.name || "")}</b> ชนะ (${escapeHtml(match.pendingScore || "-")}) <span class="pending-countdown" data-pending-until="${(match.reportedAt || Date.now()) + 10000}"></span>`;
    }
  });
  bindTeamToggles(pairs);
  current?.matches.forEach((m,i)=>mountMatchChat(room,t.history.length-1,i,isHost||currentPlayerId===m.player1Id||currentPlayerId===m.player2Id));
  renderTournamentWeeklySchedule(room, t, phase);
  renderTournamentAuctionTeams(room);
  const activeTournament=room.status==="tournament";
  document.getElementById("btn-next-round").classList.toggle("hidden",!isHost||!activeTournament||t.phaseComplete); document.getElementById("btn-next-round").onclick=beginNextRound;
  document.getElementById("btn-advance-phase").classList.toggle("hidden",!isHost || !activeTournament || !t.phaseComplete || t.phaseIndex+1>=room.settings.phases.length); document.getElementById("btn-advance-phase").onclick=advanceTournamentPhase;
  document.getElementById("btn-finish-tournament").classList.toggle("hidden",!isHost||!activeTournament); document.getElementById("btn-finish-tournament").onclick=()=>finishTournament(room);
  const withdrawn=!!room.players[currentPlayerId]?.withdrawn; const withdrawButton=document.getElementById("btn-withdraw"); withdrawButton.classList.toggle("hidden",withdrawn||amSpectator||!activeTournament); document.getElementById("btn-cancel-withdraw").classList.add("hidden"); withdrawButton.onclick=async()=>{if(!confirm("ยืนยันถอนตัว? คุณจะกลับเข้ารายการนี้ไม่ได้")) return; withdrawButton.disabled=true; const saved=await tournamentAction("withdraw"); if(saved) document.getElementById("admin-call-status").textContent="ถอนตัวสำเร็จแล้ว"; withdrawButton.disabled=false;};
  const table=document.getElementById("tournament-standings"); table.innerHTML=`<tr><th>#</th><th>ผู้เล่น</th><th>ชนะ</th><th>แพ้</th><th>แต้ม</th>${isGachaRoom(room)?"<th>แต้มสุ่ม</th>":""}<th>ทีม</th><th></th></tr>`+stats.map((s,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(s.name)}${room.players[s.pid].withdrawn?" (ถอนตัว)":""}</td><td>${s.wins}</td><td>${s.losses}</td><td>${s.points}</td>${isGachaRoom(room)?`<td>${gachaBalance(room,s.pid)}P</td>`:""}<td>${teamPreviewHtml(room.players[s.pid],`standing-${s.pid}`)}</td><td>${isHost&&activeTournament&&s.pid!==currentPlayerId&&!room.players[s.pid].withdrawn?`<button class="btn-kick" data-kick-tournament="${s.pid}">เตะออก</button>`:""}</td></tr>`).join(""); bindTeamToggles(table); table.querySelectorAll("button[data-kick-tournament]").forEach(btn=>btn.addEventListener("click",()=>kickPlayerFromTournament(btn.dataset.kickTournament)));
}

function renderTournamentAuctionTeams(room) {
  const tabs = document.getElementById("tournament-auction-tabs");
  const matchesTab = document.getElementById("tournament-tab-matches");
  const draftTab = document.getElementById("tournament-tab-draft");
  const matches = document.getElementById("tournament-pairings");
  const schedule = document.getElementById("tournament-weekly-schedule");
  const summary = document.getElementById("tournament-draft-summary");
  const isAuction = room.settings?.mode === "auction";
  tabs?.classList.toggle("hidden", !isAuction);
  if (!isAuction || !summary) return;
  const players = competitivePlayerIds(room);
  const perRow = (room.settings.teamSize || 10) === 6 ? 3 : 5;
  summary.innerHTML = `<div class="auction-summary-heading"><div><h3>🎒 ทีมจากการประมูล</h3><p class="small-text">โปเกม่อนที่ผู้เล่นแต่ละคนได้จากการประมูล — เรียง ${perRow} ตัวต่อแถว</p></div></div><div class="auction-team-grid">${players.map(pid => {
    const player = room.players[pid], team = player.team || [];
    return `<article class="auction-team-card"><header><div><b>${escapeHtml(player.name)}</b>${pid === room.hostId ? ' <span class="badge">HOST</span>' : ''}</div><span>${team.length}/${room.settings.teamSize || 10} ตัว</span></header><div class="auction-team-roster team-size-${room.settings.teamSize || 10}">${team.map(member => `<div class="auction-team-mon"><img src="${member.sprite}" alt=""><b>${escapeHtml(member.displayName)}</b>${monTypesHtml(member)}${member.isMega ? '<small>🌟 MEGA</small>' : ''}${member.price ? `<small>💰 ${Number(member.price).toLocaleString()}</small>` : (member.viaTicket ? '<small>🎫 ตั๋ว</small>' : (member.viaRandom ? '<small>🎲 สุ่ม</small>' : (member.viaGift ? '<small>🎁 ของขวัญ</small>' : '')))}</div>`).join("") || '<p class="small-text">ยังไม่มีโปเกม่อน</p>'}</div></article>`;
  }).join("")}</div>`;
  const showView = view => {
    currentTournamentView = view;
    matches?.classList.toggle("hidden", view !== "matches");
    schedule?.classList.toggle("hidden", view !== "matches");
    summary.classList.toggle("hidden", view !== "draft");
    matchesTab?.classList.toggle("active", view === "matches");
    draftTab?.classList.toggle("active", view === "draft");
  };
  showView(currentTournamentView);
  matchesTab.onclick = () => showView("matches");
  draftTab.onclick = () => showView("draft");
}

let lastPendingResultCommit = 0;
function updatePendingResultCountdowns() {
  document.querySelectorAll(".pending-countdown[data-pending-until]").forEach(el => {
    const remaining = Math.max(0, Math.ceil((Number(el.dataset.pendingUntil) - Date.now()) / 1000));
    el.textContent = remaining ? `• ยืนยันอัตโนมัติใน ${remaining} วินาที` : "• กำลังยืนยันผล...";
  });
}
async function confirmExpiredPendingResults() {
  if (!isHost || !currentRoomId || Date.now() - lastPendingResultCommit < 1000) return;
  lastPendingResultCommit = Date.now();
  await updateRoom(room => {
    if (room.status !== "tournament" || currentPlayerId !== room.hostId) return room;
    (room.tournament?.history || []).forEach(round => round.matches.forEach(match => {
      if (!match.winnerId && match.pendingWinnerId && Date.now() - (match.reportedAt || 0) >= 10000) {
        match.winnerId = match.pendingWinnerId; match.score = match.pendingScore; match.pendingWinnerId = null; match.pendingScore = null;
      }
    }));
    return room;
  });
}
setInterval(() => {
  updatePendingResultCountdowns();
  if (latestRoom?.tournament && !screenTournament.classList.contains("hidden")) confirmExpiredPendingResults();
}, 250);

// Rooms created by earlier versions had an empty tournament history.  Upgrade
// those rooms in place when their host opens them, so nobody has to re-create a room.
async function ensureFirstTournamentRound() {
  await updateRoom(room => {
    if (!room || room.status !== "tournament" || currentPlayerId !== room.hostId) return room;
    const tournament = room.tournament;
    if (!tournament || tournament.history?.length) return room;
    const phase = room.settings?.phases?.[tournament.phaseIndex || 0] || "swiss";
    const ids = tournament.phaseParticipants?.length ? tournament.phaseParticipants : activePlayerIds(room);
    const weeklySchedule = phase === "roundRobin"
      ? (tournament.weeklySchedule?.length ? tournament.weeklySchedule : generateRoundRobinSchedule(ids))
      : [];
    tournament.weeklySchedule = weeklySchedule;
    tournament.history = [{ phaseIndex:tournament.phaseIndex || 0, round:1, format:phase, matches:phase === "roundRobin" ? (weeklySchedule[0]?.matches || []) : makePairs(ids) }];
    tournament.round = 0;
    tournament.started = true;
    return room;
  });
}

function renderTournamentWeeklySchedule(room, tournament, phase) {
  const section = document.getElementById("tournament-weekly-schedule");
  if (!section) return;
  if (phase !== "roundRobin") {
    section.innerHTML = `<p class="small-text fixture-note">รูปแบบ ${tournamentLabel(phase)} จะจัดคู่ทีละรอบตามผลและการเช็กอิน หากต้องการเห็นคู่ครบทุกสัปดาห์ ให้เลือก Round Robin ตอนสร้างห้อง</p>`;
    return;
  }
  const weeks = tournament.weeklySchedule?.length ? tournament.weeklySchedule : generateRoundRobinSchedule(tournament.phaseParticipants || activePlayerIds(room));
  if (!weeks.length) { section.innerHTML = '<p class="small-text fixture-note">ต้องมีผู้เล่นอย่างน้อย 2 คนเพื่อสร้างตารางแข่งขัน</p>'; return; }
  const selected = weeks.find(week => week.weekNumber === currentWeekView) || weeks[0];
  section.innerHTML = `<div class="fixture-header"><h3>🗓️ ตารางจับคู่รายสัปดาห์</h3><p class="small-text">ล็อกคู่ล่วงหน้าแล้ว ${weeks.length} สัปดาห์ — ผลการแข่งขันจะบันทึกในรอบที่ผู้จัดเปิด</p></div><div class="week-tabs">${weeks.map(week => `<button class="week-tab-btn ${week.weekNumber === selected.weekNumber ? "active" : ""}" data-tournament-week="${week.weekNumber}">สัปดาห์ ${week.weekNumber}</button>`).join("")}</div><div class="fixture-grid">${selected.matches.map(match => {
    const first = room.players?.[match.player1Id]?.name || "-";
    const second = match.isBye ? "BYE" : room.players?.[match.player2Id]?.name || "-";
    return `<article class="fixture-card ${match.isBye ? "fixture-bye" : ""}"><span class="fixture-label">${match.isBye ? "พักรอบนี้" : "MATCH"}</span><strong>${escapeHtml(first)}</strong><span class="vs">${match.isBye ? "—" : "VS"}</span><strong>${escapeHtml(second)}</strong></article>`;
  }).join("")}</div>`;
  section.querySelectorAll("[data-tournament-week]").forEach(button => button.addEventListener("click", () => {
    currentWeekView = Number(button.dataset.tournamentWeek);
    renderTournamentWeeklySchedule(room, tournament, phase);
  }));
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

// จับคู่ชื่อโปเกม่อนที่พิมพ์มาจาก Team Sheet (เช่นจาก Showdown export)
// กับรายการ POKEMON_LIST เพื่อหา apiName ที่ถูกต้อง แล้วดึงรูปจาก PokeAPI แบบเดียวกับตอนประมูล
function normalizePokeName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
const pokemonListLookup = (() => {
  const byApiName = new Map(), byDisplayName = new Map();
  POKEMON_LIST.forEach(pk => {
    byApiName.set(normalizePokeName(pk.apiName), pk);
    byDisplayName.set(normalizePokeName(pk.displayName), pk);
  });
  return { byApiName, byDisplayName };
})();
function findPokemonEntry(name) {
  const norm = normalizePokeName(name);
  if (!norm) return null;
  return pokemonListLookup.byApiName.get(norm)
    || pokemonListLookup.byDisplayName.get(norm)
    // ตัดท้ายร่าง/ฟอร์มออก แล้วลองจับคู่แค่ชื่อร่างพื้นฐาน (เช่น "Aegislash-Blank" -> "Aegislash")
    || pokemonListLookup.byApiName.get(normalizePokeName(String(name).split(/[-\s]/)[0]))
    || pokemonListLookup.byDisplayName.get(normalizePokeName(String(name).split(/[-\s]/)[0]))
    || null;
}
// ดึงรูปจาก PokeAPI ให้ <img data-poke-name="..."> ที่ยังไม่มีรูปจริง (ใช้ cache เดียวกับตอนประมูล)
async function hydratePokeApiSprites(root) {
  if (!root) return;
  const imgs = [...root.querySelectorAll("img[data-poke-name]")];
  for (const img of imgs) {
    const entry = findPokemonEntry(img.dataset.pokeName);
    if (!entry) continue;
    try {
      const sprite = await fetchSprite(entry);
      if (sprite) img.src = sprite;
    } catch (e) { /* เน็ตหลุด/หา PokeAPI ไม่เจอ -> ปล่อยรูปเดิมไว้ */ }
  }
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

// ฟังก์ชันหลักที่หน้าเริ่มเกมเรียกใช้
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
  const current = (await get(ref(db, "rooms/" + currentRoomId))).val();
  if (!current) return;
  const missingTeamSheets = teamSheetRequired(current) ? competitivePlayerIds(current).filter(pid => !hasSubmittedTeamSheet(current.players?.[pid])) : [];
  if (missingTeamSheets.length) {
    alert(`ยังเริ่มไม่ได้: รอ Team Sheet จากผู้เล่นอีก ${missingTeamSheets.length} คน`);
    renderLobby(current);
    return;
  }
  if (isGachaRoom(current)) {
    const notReady = gachaNotReadyIds(current);
    if (notReady.length) {
      alert(`ยังเริ่มไม่ได้: ผู้เล่น ${notReady.length} คนยังมีโปเกม่อนไม่ครบ ${GACHA_MIN_TO_START} ตัว หรือยังไม่ได้ตัดสินใจกับตัวที่สุ่มได้`);
      renderLobby(current);
      return;
    }
  }
  if (current?.settings?.mode === "normal" || isGachaRoom(current)) {
    btn.disabled = true;
    btn.textContent = "กำลังเปิดการแข่งขัน...";
    await startTournament(currentRoomId);
    return;
  }
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
    const playerIds = competitivePlayerIds(room);
    for (let i = playerIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
    }

    await runTransaction(ref(db, "rooms/" + currentRoomId), latest => {
      if (!latest || latest.status !== "waiting") return latest;
      if (isTeamSheetMode(latest) && competitivePlayerIds(latest).some(pid => !hasSubmittedTeamSheet(latest.players?.[pid]))) return latest;
      latest.status = "picking";
      latest.pool = pool;
      latest.turnOrder = playerIds;
      latest.currentTurnIndex = 0;
      latest.auction = null;
      return latest;
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
  return runTransaction(roomRef, (room) => {
    if (room === null) return room;
    return mutator(room);
  });
}

function advanceTurn(room) {
  if (room.settings?.auctionSelector === "organizer" || room.settings?.auctionSelector === "random") return;
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
  const playerIds = competitivePlayerIds(room);
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

  const needy = competitivePlayerIds(room).filter(
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
  const players = competitivePlayerIds(room).map(pid => room.players[pid]);

  const teamSize = room.settings.teamSize;

  // 1) ไม่เหลือใครที่บิดได้แล้ว (ทีมเต็ม หรือเงินหมด) -> คนที่ทีมยังไม่เต็มโดนสุ่มโปเกม่อนให้จนครบ
  const noOneCanBid = !players.some(p => canStillBid(p, room));

  // 2) เหลือผู้เล่นที่ทีมยังไม่เต็มแค่คนเดียว (คนอื่นเต็มหมดแล้ว) -> ไม่มีคู่แข่ง สุ่มให้เต็มเลย
  const incompleteCount = players.filter(
    p => (p.team ? p.team.length : 0) < teamSize
  ).length;
  const onlyOneLeft = incompleteCount === 1;
  // หากเหลือคนที่ยังมีเงินบิดได้เพียงคนเดียว จะไม่มีการแข่งขันราคาแล้ว
  // จึงสุ่มตัวที่เหลือให้ทุกคนที่ทีมยังไม่เต็มทันที
  const onlyOneCanBid = players.filter(p => canStillBid(p, room)).length === 1;

  if (noOneCanBid || onlyOneLeft || onlyOneCanBid) fillTeamsRandomly(room);

  const allFull = players.every(
    p => (p.team ? p.team.length : 0) >= teamSize
  );
  const poolExhausted = Object.values(room.pool).every(
    p => p.status !== "available" && p.status !== "auctioning"
  );
  if (noOneCanBid || onlyOneLeft || onlyOneCanBid || allFull || poolExhausted) {
    room.status = "tournament";
    room.tournament = initialTournament(room);
  }
}

// ---------- Actions ----------
async function nominatePokemon(poolKey) {
  await updateRoom((room) => {
    if (room.status !== "picking" || room.auction) return room;
    const organizerSelects = room.settings?.auctionSelector === "organizer";
    if (room.settings?.auctionSelector === "random") return room; // โหมดนี้สุ่มเท่านั้น ห้ามเลือกเอง ใช้ nominateRandomPokemon แทน
    if (organizerSelects ? currentPlayerId !== room.hostId : room.turnOrder[room.currentTurnIndex] !== currentPlayerId) return room;
    const poke = room.pool[poolKey];
    if (!poke || poke.status !== "available") return room;
    const timerSeconds = Number(room.settings?.timerSeconds ?? 10);
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
      endTime: timerSeconds > 0 ? serverNow() + timerSeconds * 1000 : null
    };
    return room;
  });
}

// โหมดสุ่มตัวขึ้นประมูล: ผู้จัดห้อง (host) กดปุ่มเพื่อสุ่มโปเกม่อนที่ยังว่างขึ้นประมูลทีละตัว
// nominatedBy ตั้งเป็น null (ไม่ใช่ host) เพื่อให้ host เองก็ร่วมบิด/ใช้ตั๋วเลือกกับตัวนี้ได้ตามปกติ ไม่ถือว่าเป็นคนเสนอ
async function nominateRandomPokemon() {
  await updateRoom((room) => {
    if (room.status !== "picking" || room.auction) return room;
    if (room.settings?.auctionSelector !== "random") return room;
    if (currentPlayerId !== room.hostId) return room;
    const availableKeys = Object.keys(room.pool).filter(key => room.pool[key].status === "available");
    if (!availableKeys.length) return room;
    const poolKey = availableKeys[Math.floor(Math.random() * availableKeys.length)];
    const poke = room.pool[poolKey];
    const timerSeconds = Number(room.settings?.timerSeconds ?? 10);
    poke.status = "auctioning";
    room.auction = {
      poolKey,
      displayName: poke.displayName,
      isMega: poke.isMega,
      sprite: poke.sprite,
      nominatedBy: null,
      nominatedByName: "🎲 สุ่มโดยระบบ",
      currentBid: 0,
      currentBidderId: null,
      currentBidderName: null,
      endTime: timerSeconds > 0 ? serverNow() + timerSeconds * 1000 : null
    };
    return room;
  });
}

async function placeBid(amount) {
  await updateRoom((room) => {
    if (!room.auction || (room.auction.endTime && serverNow() >= room.auction.endTime)) return room;
    const player = room.players[currentPlayerId];
    if (!player || player.isSpectator) return room;
    // โหมดผู้จัดเลือกเอง: ผู้จัดมีหน้าที่คัดโปเกม่อนขึ้นประมูลเท่านั้น ห้ามร่วมบิดเอง
    if (room.settings?.auctionSelector === "organizer" && currentPlayerId === room.hostId) return room;
    if ((player.team?.length || 0) >= room.settings.teamSize) return room;
    const minNext = room.auction.currentBid + room.settings.minBidIncrement;
    if (amount < minNext || amount > player.money) return room;
    room.auction.currentBid = amount;
    room.auction.currentBidderId = currentPlayerId;
    room.auction.currentBidderName = player.name;
    const timerSeconds = Number(room.settings?.timerSeconds ?? 10);
    if (timerSeconds > 0) room.auction.endTime = serverNow() + timerSeconds * 1000;
    return room;
  });
}

async function usePickTicket(poolKey) {
  await updateRoom((room) => {
    const player = room.players[currentPlayerId];
    if (!player || player.isSpectator || player.pickTicketUsed) return room;
    // โหมดผู้จัดเลือกเอง: ผู้จัดใช้ตั๋วเลือก/สแนปไม่ได้
    if (room.settings?.auctionSelector === "organizer" && currentPlayerId === room.hostId) return room;
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
    if (!player || player.isSpectator || player.banTicketUsed) return room;
    // โหมดผู้จัดเลือกเอง: ผู้จัดใช้ตั๋วแบนไม่ได้
    if (room.settings?.auctionSelector === "organizer" && currentPlayerId === room.hostId) return room;
    const poke = room.pool[poolKey];
    if (!poke || poke.status !== "available") return room;
    poke.status = "banned";
    poke.bannedBy = currentPlayerId;
    player.banTicketUsed = true;
    checkGameEnd(room);
    return room;
  });
}

// ตั๋วส่งของขวัญ: ส่งโปเกม่อนในทีมของตัวเอง 1 ตัว ให้เพื่อนที่ช่องทีมยังไม่เต็ม
// ใช้ได้ครั้งเดียวต่อทัวร์นาเมนต์ และต้องส่งก่อนเริ่มประมูลรอบต่อไป (ระหว่างที่ไม่มีการประมูลค้างอยู่เท่านั้น)
async function sendGiftPokemon(memberIndex, targetPlayerId) {
  await updateRoom((room) => {
    // ต้องอยู่ในช่วงเลือก/ประมูล และไม่มีการประมูลค้างอยู่ ณ ขณะนี้ (ถือว่าเป็น "ก่อนเริ่มประมูลรอบต่อไป")
    if (room.status !== "picking" || room.auction) return room;
    if (!targetPlayerId || targetPlayerId === currentPlayerId) return room;

    const player = room.players[currentPlayerId];
    if (!player || player.isSpectator) return room;

    const target = room.players[targetPlayerId];
    if (!target || target.isSpectator) return room;

    const teamSize = room.settings.teamSize;
    if ((target.team?.length || 0) >= teamSize) return room;

    const team = player.team || [];
    const member = team[memberIndex];
    if (!member) return room;

    // ครั้งแรกส่งฟรี ครั้งต่อไปจ่าย 500 แล้วเพิ่มขึ้นทีละ 500 ต่อการส่งของขวัญแต่ละครั้ง
    const giftCount = player.giftCount || 0;
    const cost = giftCount * 500;
    if ((player.money || 0) < cost) return room;

    // เอาออกจากทีมผู้ส่ง
    team.splice(memberIndex, 1);
    player.team = team;

    if (cost > 0) player.money = (player.money || 0) - cost;

    // เพิ่มเข้าทีมผู้รับ พร้อมระบุว่าได้มาจากของขวัญ (ล้างป้ายราคา/ตั๋ว/สุ่มเดิมออก)
    if (!target.team) target.team = [];
    target.team.push({
      id: member.id,
      displayName: member.displayName,
      isMega: member.isMega,
      sprite: member.sprite,
      viaGift: true,
      giftedFromName: player.name
    });

    // อัปเดตเจ้าของใน pool ให้ตรงกับทีมใหม่
    if (member.id && room.pool && room.pool[member.id]) {
      room.pool[member.id].ownerId = targetPlayerId;
    }

    player.giftCount = giftCount + 1;
    checkGameEnd(room);
    return room;
  });
}

async function resolveAuctionIfExpired() {
  await updateRoom((room) => {
    if (!room.auction?.endTime || serverNow() < room.auction.endTime) return room;
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

async function confirmAuction() {
  await updateRoom((room) => {
    if (!room.auction || room.auction.endTime || room.auction.nominatedBy !== currentPlayerId) return room;
    const auction = room.auction;
    const poke = room.pool?.[auction.poolKey];
    if (!poke) return room;
    if (auction.currentBidderId) {
      const winner = room.players[auction.currentBidderId];
      if (!winner) return room;
      winner.money -= auction.currentBid;
      if (!winner.team) winner.team = [];
      winner.team.push({ id: poke.id, displayName: poke.displayName, isMega: poke.isMega, sprite: poke.sprite, price: auction.currentBid });
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
      p.giftCount = 0;
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
  if (!latestRoom?.auction?.endTime) return;
  const timerEl = document.getElementById("auc-timer");
  if (!timerEl) return;
  const remain = Math.max(0, Math.ceil((latestRoom.auction.endTime - serverNow()) / 1000));
  timerEl.textContent = remain;
}, 250);

// ---------- Render Game Screen (ระหว่างประมูล) ----------
function renderGame(room) {
  document.getElementById("game-room-code").textContent = currentRoomId;
  if (!room.turnOrder) return;

  const organizerSelects = room.settings?.auctionSelector === "organizer";
  const randomSelects = room.settings?.auctionSelector === "random";
  const myTurnPid = organizerSelects ? room.hostId : (randomSelects ? null : room.turnOrder[room.currentTurnIndex]);
  const isMyTurn = !randomSelects && myTurnPid === currentPlayerId;
  const me = room.players[currentPlayerId];
  const amSpectator = !!me.isSpectator;
  const isRestrictedOrganizerHost = organizerSelects && currentPlayerId === room.hostId;
  const meFull = amSpectator || isRestrictedOrganizerHost || (me.team?.length || 0) >= room.settings.teamSize;

  const turnIndicator = document.getElementById("turn-indicator");
  // ผู้จัด (host) ที่เลือกโหมด "ผู้จัดเป็นผู้เลือกขึ้นประมูล" ต้องเลือกโปเกม่อนขึ้นประมูลได้เสมอ
  // แม้จะตั้งสถานะตัวเองเป็นผู้สังเกตการณ์ (spectator) ก็ตาม จึงต้องเช็ค isRestrictedOrganizerHost ก่อน amSpectator
  if (isRestrictedOrganizerHost) {
    turnIndicator.textContent = "🧭 คุณเป็นผู้จัด เลือกโปเกม่อนขึ้นประมูลได้ แต่ร่วมบิด/แบน/ใช้ตั๋วเองไม่ได้";
  } else if (amSpectator) {
    turnIndicator.textContent = "👀 คุณเป็นผู้สังเกตการณ์ — ดูการประมูลได้ แต่ร่วมประมูล/แบน/ใช้ตั๋วไม่ได้";
  } else if (organizerSelects) {
    turnIndicator.textContent = isHost
      ? "🧭 คุณเป็นผู้จัด เลือกโปเกม่อนขึ้นประมูลได้"
      : `🧭 ผู้จัด (${room.players[room.hostId]?.name || "-"}) กำลังเลือกโปเกม่อนขึ้นประมูล`;
  } else if (randomSelects) {
    turnIndicator.textContent = room.auction
      ? "🎲 กำลังประมูลตัวที่สุ่มได้ — ร่วมบิดได้เลย"
      : (isHost ? "🎲 กดปุ่ม \"สุ่มโปเกม่อนขึ้นประมูล\" เพื่อเริ่มรอบถัดไป" : `🎲 รอผู้จัด (${room.players[room.hostId]?.name || "-"}) สุ่มโปเกม่อนตัวถัดไป`);
  } else if (isMyTurn) {
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
  const randomNominateBtn = document.getElementById("btn-random-nominate");
  if (randomNominateBtn) {
    randomNominateBtn.classList.toggle("hidden", !(randomSelects && isHost && room.status === "picking" && !room.auction));
    randomNominateBtn.onclick = () => { randomNominateBtn.disabled = true; nominateRandomPokemon().finally(() => { randomNominateBtn.disabled = false; }); };
  }
  turnIndicator.classList.toggle("my-turn", isMyTurn);

  document.getElementById("my-money").textContent = me.money.toLocaleString();
  document.getElementById("my-team-count").textContent = `${(me.team||[]).length}/${room.settings.teamSize}`;
  document.getElementById("team-tab-count").textContent = `${(me.team||[]).length}/${room.settings.teamSize}`;
  document.getElementById("my-pick-status").textContent = me.pickTicketUsed ? "❌" : "🎫";
  document.getElementById("my-ban-status").textContent = me.banTicketUsed ? "❌" : "🚫";
  const myNextGiftCost = (me.giftCount || 0) * 500;
  document.getElementById("my-gift-status").textContent = myNextGiftCost > 0 ? `💰${myNextGiftCost.toLocaleString()}` : "ฟรี";

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
    // สปอยล์เตอร์ (spectator) รวมถึงคนสร้างห้องที่ตั้งตัวเองเป็นผู้สังเกตการณ์ ควรเห็นโปเกม่อนที่กำลังประมูลอยู่เสมอ
    // แม้จะตั้งโหมดซ่อนตัวไว้ ส่วนผู้เล่นที่แข่งขันจริงยังคงถูกซ่อนตามปกติ
    const revealAuctionPokemon = room.settings?.auctionReveal !== "hidden" || amSpectator;
    document.getElementById("auc-img").src = revealAuctionPokemon ? a.sprite : "";
    document.getElementById("auc-img").alt = revealAuctionPokemon ? a.displayName : "โปเกม่อนลับ";
    document.getElementById("auc-img").classList.toggle("auction-secret-image", !revealAuctionPokemon);
    const aucTypes = document.getElementById("auc-types"); if (aucTypes) aucTypes.innerHTML = revealAuctionPokemon ? monTypesHtml(a) : "";
    document.getElementById("auc-name").innerHTML = revealAuctionPokemon ? a.displayName + (a.isMega ? '<span class="mega-tag">MEGA</span>' : '') : "❓ โปเกม่อนลับ";
    document.getElementById("auc-nominator").textContent = `เสนอโดย: ${a.nominatedByName}`;
    document.getElementById("auc-bid").textContent = a.currentBidderId
      ? `บิดล่าสุด ${a.currentBid.toLocaleString()} โดย ${a.currentBidderName}`
      : (a.endTime ? "ยังไม่มีการบิด (หมดเวลาแล้วจะตกไปกองขยะ)" : "ยังไม่มีการบิด");

    document.getElementById("auc-timer").textContent = a.endTime ? Math.max(0, Math.ceil((a.endTime - serverNow()) / 1000)) : "∞";

    const increment = room.settings.minBidIncrement;
    const controlsDiv = document.getElementById("bid-controls");
    controlsDiv.innerHTML = "";
    if (isRestrictedOrganizerHost) {
      controlsDiv.innerHTML = '<p class="small-text">🧭 คุณเป็นผู้จัด มีหน้าที่คัดโปเกม่อนขึ้นประมูล ไม่สามารถร่วมบิดเองได้</p>';
    } else if (amSpectator) {
      controlsDiv.innerHTML = '<p class="small-text">👀 คุณเป็นผู้สังเกตการณ์ ไม่สามารถร่วมประมูลได้</p>';
    } else if (!meFull && me.money < increment) {
      controlsDiv.innerHTML = '<p class="small-text">💸 เงินของคุณหมดแล้ว ไม่สามารถบิดได้ (เมื่อไม่เหลือใครบิดได้ ระบบจะสุ่มโปเกม่อนให้จนครบทีม)</p>';
    } else if (!meFull) {
      [increment, increment * 2, increment * 5].forEach(step => {
        const amt = a.currentBid + step;
        if (amt <= me.money) {
          const b = document.createElement("button");
          b.className = "quick-bid";
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
    const confirmBtn = document.getElementById("btn-confirm-auction");
    const canConfirm = !a.endTime && a.nominatedBy === currentPlayerId;
    confirmBtn.classList.toggle("hidden", !canConfirm);
    confirmBtn.onclick = canConfirm ? confirmAuction : null;
  } else {
    aucBox.classList.add("hidden");
  }

  renderPool(room, isMyTurn, me);
  renderMyTeam(me, room.settings.teamSize);
  renderOthersTeams(room);
  renderGiftBox(room, me);
}

// กล่องส่งของขวัญ: เลือกโปเกม่อนในทีมตัวเอง + เพื่อนที่ช่องยังไม่เต็ม แล้วส่งได้ก่อนเริ่มประมูลตัวถัดไป
function renderGiftBox(room, me) {
  const box = document.getElementById("gift-box");
  const pokeSelect = document.getElementById("gift-pokemon-select");
  const targetSelect = document.getElementById("gift-target-select");
  const sendBtn = document.getElementById("btn-send-gift");
  const statusEl = document.getElementById("gift-status");
  if (!box) return;

  const teamSize = room.settings.teamSize;
  const myTeam = me.team || [];
  const targets = (room.turnOrder || [])
    .filter(pid => pid !== currentPlayerId && room.players[pid])
    .map(pid => ({ pid, p: room.players[pid] }))
    .filter(({ p }) => (p.team?.length || 0) < teamSize);

  const auctionOpen = !!room.auction;
  const nextGiftCost = (me.giftCount || 0) * 500;
  const canAfford = (me.money || 0) >= nextGiftCost;

  if (!myTeam.length) {
    statusEl.textContent = "คุณยังไม่มีโปเกม่อนในทีมให้ส่ง";
  } else if (!targets.length) {
    statusEl.textContent = "ตอนนี้ไม่มีเพื่อนที่ช่องทีมยังไม่เต็ม";
  } else if (auctionOpen) {
    statusEl.textContent = "⏳ กำลังมีการประมูลอยู่ ต้องรอให้จบก่อนถึงจะส่งของขวัญได้";
  } else if (!canAfford) {
    statusEl.textContent = `❌ เงินไม่พอ ของขวัญครั้งต่อไปราคา ${nextGiftCost.toLocaleString()}`;
  } else if (nextGiftCost > 0) {
    statusEl.textContent = `ของขวัญครั้งต่อไปมีค่าใช้จ่าย ${nextGiftCost.toLocaleString()}`;
  } else {
    statusEl.textContent = "🎁 ส่งของขวัญครั้งแรกได้ฟรี!";
  }

  const disabled = !myTeam.length || !targets.length || auctionOpen || !canAfford;
  sendBtn.disabled = disabled;
  pokeSelect.disabled = disabled;
  targetSelect.disabled = disabled;

  pokeSelect.innerHTML = myTeam
    .map((t, i) => `<option value="${i}">${escapeHtml(t.displayName)}${t.isMega ? " 🌟" : ""}</option>`)
    .join("") || '<option value="">-</option>';

  targetSelect.innerHTML = targets
    .map(({ pid, p }) => `<option value="${escapeHtml(pid)}">${escapeHtml(p.name)} (${(p.team?.length || 0)}/${teamSize})</option>`)
    .join("") || '<option value="">-</option>';

  sendBtn.onclick = () => {
    const idx = parseInt(pokeSelect.value, 10);
    const targetPid = targetSelect.value;
    if (isNaN(idx) || !targetPid) return;
    const mon = myTeam[idx];
    const costText = nextGiftCost > 0 ? `(เสียเงิน ${nextGiftCost.toLocaleString()})` : "(ฟรี)";
    if (!confirm(`ส่ง ${mon?.displayName || "โปเกม่อนตัวนี้"} ให้ ${room.players[targetPid]?.name || "เพื่อน"} ใช่หรือไม่? ${costText}`)) return;
    sendGiftPokemon(idx, targetPid);
  };
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
      : (t.viaRandom ? '<span class="price-tag">🎲 สุ่มให้</span>'
        : (t.viaGift ? `<span class="price-tag">🎁 ของขวัญจาก ${escapeHtml(t.giftedFromName || "เพื่อน")}</span>` : '')));
  const removeBtn = edit
    ? `<button class="slot-remove" title="เอาออกจากทีม" data-remove-pid="${escapeHtml(edit.pid)}" data-remove-idx="${edit.idx}">✕</button>`
    : '';
  return `<div class="team-slot${edit ? ' editable' : ''}${t.viaGift ? ' gifted-slot' : ''}">
    ${removeBtn}
    <img src="${t.sprite}" alt="">
    <span>${escapeHtml(t.displayName)}${t.isMega ? ' 🌟' : ''}</span>${monTypesHtml(t)}
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
        <div class="my-team size-${teamSize}">${body}</div>
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
  const amSpectator = !!me.isSpectator;
  const organizerSelects = room.settings?.auctionSelector === "organizer";
  const randomSelects = room.settings?.auctionSelector === "random";
  const isRestrictedOrganizerHost = organizerSelects && currentPlayerId === room.hostId;
  const meFull = amSpectator || isRestrictedOrganizerHost || (me.team?.length || 0) >= room.settings.teamSize;

  // โหมด "ผู้จัดเป็นผู้เลือก": ผู้จัดต้องเลือกโปเกม่อนขึ้นประมูลได้เสมอ แม้จะตั้งตัวเองเป็นผู้สังเกตการณ์
  // (การเป็นผู้สังเกตการณ์มีผลแค่ห้ามร่วมบิด/แบน/ใช้ตั๋วเท่านั้น ไม่ควรห้ามการเลือกตัวขึ้นประมูลของผู้จัด)
  const canChoosePokemon = !randomSelects && (organizerSelects ? isHost : (!amSpectator && isMyTurn));
  const hidePokemon = room.settings?.auctionReveal === "hidden";
  Object.values(room.pool).forEach(poke => {
    if (currentFilter === "normal" && poke.isMega) return;
    if (currentFilter === "mega" && !poke.isMega) return;
    if (currentSearch && !poke.displayName.toLowerCase().includes(currentSearch)) return;

    const card = document.createElement("div");
    card.className = `poke-card status-${poke.status}`;
    const conceal = hidePokemon && !amSpectator && (poke.status === "auctioning" || (poke.status === "available" && !canChoosePokemon));
    let html = conceal
      ? '<div class="secret-pokemon">❓</div><div class="name">โปเกม่อนลับ</div>'
      : `<img src="${poke.sprite}" alt=""><div class="name">${poke.displayName}${poke.isMega ? '<br><span class="mega-tag">MEGA</span>' : ''}</div>${monTypesHtml(poke)}`;

    if (poke.status === "owned") {
      html += `<div class="owner-tag">👤 ${room.players[poke.ownerId]?.name || "?"}</div>`;
    } else if (poke.status === "banned") {
      html += `<div class="owner-tag">🚫 ถูกแบน</div>`;
    } else if (poke.status === "discarded") {
      html += `<div class="owner-tag">🗑️ ตกไปแล้ว</div>`;
    } else {
      html += `<div class="card-actions">`;
      const canNominate = canChoosePokemon;
      if (poke.status === "available" && !room.auction && canNominate) {
        html += `<button class="btn-nominate" data-action="nominate" data-id="${poke.id}">เสนอประมูล</button>`;
      }
      if (poke.status === "available" && !me.banTicketUsed && !amSpectator && !isRestrictedOrganizerHost) {
        html += `<button class="btn-ban" data-action="ban" data-id="${poke.id}">แบน 🚫</button>`;
      }
      const cantSnipeOwn = poke.status === "auctioning" && room.auction?.nominatedBy === currentPlayerId;
      if (poke.status === "auctioning" && !me.pickTicketUsed && !meFull && !cantSnipeOwn && !amSpectator && !isRestrictedOrganizerHost) {
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
  grid.className = "my-team size-" + teamSize;   // 10 ตัว = 5 ต่อแถว 2 แถว / 6 ตัว = 3 ต่อแถว 2 แถว
  grid.innerHTML = "";
  const team = me.team || [];
  for (let i = 0; i < teamSize; i++) {
    const t = team[i];
    const slot = document.createElement("div");
    slot.className = "team-slot" + (t ? "" : " empty");
    slot.innerHTML = t
      ? `<img src="${t.sprite}" alt=""><span>${t.displayName}${t.isMega ? ' 🌟' : ''}</span>${monTypesHtml(t)}`
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
  grid.innerHTML = competitivePlayerIds(room).map(pid => [pid, room.players[pid]]).map(([pid, p]) => `
    <article class="team-summary-card draft-team-card">
      <div class="draft-team-heading"><div><h4>${escapeHtml(p.name)}${pid === room.hostId ? ' <span class="badge">HOST</span>' : ''}</h4><p class="small-text">ทีมจากการประมูล</p></div><div class="team-count-badge">${(p.team || []).length}/${room.settings.teamSize}</div></div>
      <div class="draft-team-meta"><span>💰 ${(p.money || 0).toLocaleString()}</span><span>🎒 ${(p.team || []).length} ตัว</span></div>
      <div class="draft-team-roster size-${room.settings?.teamSize || 10}">
        ${(p.team || []).map(t => `
          <div class="team-slot draft-pokemon-card">
            <img src="${t.sprite}" alt="">
            <span>${t.displayName}${t.isMega ? ' 🌟' : ''}</span>${monTypesHtml(t)}
            ${t.price ? `<span class="price-tag">💰${t.price.toLocaleString()}</span>` : (t.viaTicket ? '<span class="price-tag">🎫 ตั๋ว</span>' : (t.viaRandom ? '<span class="price-tag">🎲 สุ่มให้</span>' : (t.viaGift ? '<span class="price-tag">🎁 ของขวัญ</span>' : '')))}
          </div>`).join("")}
      </div>
    </article>
  `).join("");

  const bannedBox = document.getElementById("banned-summary");
  if (bannedBox) bannedBox.innerHTML = bannedSummaryHtml(getBannedList(room));
}

function computeStandings(room) {
  const stats = {};
  competitivePlayerIds(room).forEach(pid => {
    stats[pid] = { name: room.players[pid].name, wins: 0, losses: 0, points: 0, played: 0 };
  });

  room.league.weeks.forEach(week => {
    week.matches.forEach(m => {
      if (m.isBye) {
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
async function leaveRoom({ confirmFirst = true, preservePlayer = false } = {}) {
  if (confirmFirst) {
    const msg = preservePlayer
      ? "ออกจากหน้าห้องใช่หรือไม่? คุณจะไม่ถูกถอนตัว และยังกลับเข้าห้องนี้ได้ภายหลัง"
      : isHost && latestRoom?.status === "waiting"
      ? "คุณเป็นโฮสต์ ถ้าออกตอนนี้ห้องจะถูกปิดและผู้เล่นทุกคนจะหลุดออก\nยืนยันออกจากห้อง?"
      : "ยืนยันออกจากห้อง? ทีมและข้อมูลของคุณในห้องนี้จะหายไป";
    if (!confirm(msg)) return;
  }

  const roomId = currentRoomId;
  const playerId = currentPlayerId;
  selfLeaving = true;

  try {
    if (roomId && playerId) {
      try { await onDisconnect(ref(db, `rooms/${roomId}/players/${playerId}`)).cancel(); } catch (e) {}

      if (preservePlayer && !latestRoom?.players?.[playerId]?.isViewer) {
        // สำหรับทัวร์นาเมนต์: ออกจากหน้าห้องเท่านั้น ไม่กระทบผลแข่งหรือรายชื่อผู้เล่น
      } else if (isHost && latestRoom?.status === "waiting") {
        await set(ref(db, "rooms/" + roomId), null);
      } else {
        await set(ref(db, `rooms/${roomId}/players/${playerId}`), null);

        const rest = await get(ref(db, `rooms/${roomId}/players`));
        if (!rest.exists() || Object.keys(rest.val() || {}).length === 0) {
          await set(ref(db, "rooms/" + roomId), null);
        }
      }
    }
  } catch (e) {
    console.error("leaveRoom error:", e);
  }

  localStorage.removeItem("vgcLab_roomId");
  localStorage.removeItem("vgcLab_playerId");
  location.reload();
}

["btn-leave-room", "btn-leave-lobby", "btn-leave-game"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", () => leaveRoom());
});
document.getElementById("btn-leave-tournament")?.addEventListener("click", () => leaveRoom({ preservePlayer: true }));

// ---------- แชทในห้องเกม (ผู้เล่นทั่วไปพิมพ์คุยกัน) ----------
document.getElementById("btn-game-chat-send")?.addEventListener("click", () => {
  const input = document.getElementById("game-chat-input");
  const text = input.value.trim();
  if (!text || !currentRoomId) return;
  push(ref(db, `rooms/${currentRoomId}/chat`), {
    senderName: latestRoom?.players?.[currentPlayerId]?.name || "ผู้เล่น",
    text,
    time: Date.now(),
    isOwnerMsg: false
  });
  input.value = "";
});
document.getElementById("game-chat-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-game-chat-send").click();
});

// ---------- Auto-rejoin ----------
let restoringSavedRoom = false;
async function restoreSavedRoom() {
  if (restoringSavedRoom || currentRoomId || !currentUser) return;
  const savedRoomId = localStorage.getItem("vgcLab_roomId");
  const savedPlayerId = localStorage.getItem("vgcLab_playerId");
  if (!savedRoomId || !savedPlayerId) return;
  restoringSavedRoom = true;
  try {
    const snap = await get(ref(db, `rooms/${savedRoomId}/players/${savedPlayerId}`));
    if (snap.exists()) {
      const roomSnap = await get(ref(db, `rooms/${savedRoomId}`));
      const room = roomSnap.val();
      if (room) enterLobby(savedRoomId, savedPlayerId, room.hostId === savedPlayerId);
    }
  } catch (e) {
    console.warn("restore room failed:", e);
  } finally {
    restoringSavedRoom = false;
  }
}
window.addEventListener("load", restoreSavedRoom);
// =====================================================================
// ระบบคลังทัวร์นาเมนต์ (Archives)
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

  const pseudoArchive = { creatorUid: room.creatorUid, affiliation: room.affiliation };
  const canUseControls = saved ? (isHost && canEditArchive(pseudoArchive)) : isHost;
  controlsEl.classList.toggle("hidden", !canUseControls);
  if (saved && !canUseControls) {
    statusEl.innerHTML += `<br><span class="small-text">การอัปเดตภายหลังทำได้เฉพาะผู้สร้างห้องนี้ / เจ้าของเว็บ</span>`;
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
      creatorUid: room.creatorUid || null,
      creatorEmail: room.creatorEmail || null,
      affiliation: room.affiliation || null,
      hostName: (room.players && room.players[room.hostId]?.name) || "-",
      playerCount: competitivePlayerIds(room).length,
      createdAt,
      updatedAt: Date.now(),
      settings: room.settings || null,
      players: room.players || {},
      hostId: room.hostId || null,
      league: room.league || null,
      // เก็บ bracket จริงของการแข่งขันไว้กับ archive เพื่อให้ย้อนดูผลได้
      // แม้ห้องต้นทางจะถูกล้างแชทหรือเริ่มรายการใหม่ภายหลังแล้ว
      tournament: room.tournament || null,
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

// ---------- หน้ารายการทัวร์นาเมนต์ ----------
let allArchivesCache = [];

function hideAllTopScreens() {
  screenHome.classList.add("hidden");
  screenLobby.classList.add("hidden");
  screenGame.classList.add("hidden");
  screenPostgame.classList.add("hidden");
  screenTournament.classList.add("hidden");
  screenArchives.classList.add("hidden");
  screenMyHistory.classList.add("hidden");
  screenArchiveDetail.classList.add("hidden");
  screenSpectate.classList.add("hidden");
  document.getElementById("screen-events")?.classList.add("hidden");
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
          <div class="a-meta">ผู้เล่น ${a.playerCount || 0} คน • โฮสต์: ${escapeHtml(a.hostName || "-")}${a.affiliation ? ` • สังกัด: ${escapeHtml(a.affiliation)}` : ""} • อัปเดตล่าสุด ${date}</div>
        </div>
        <div class="archive-item-actions">
          <span class="badge">ดูรายละเอียด ➜</span>
          ${canDeleteArchive(a) ? `<button class="btn-del-mini" data-del="${escapeHtml(a.id)}" title="ลบทัวร์นาเมนต์">🗑️</button>` : ""}
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
document.getElementById("btn-open-my-history").addEventListener("click", async () => {
  if(!currentUser?.uid) { homeError.textContent="กรุณาเข้าสู่ระบบเพื่อดูประวัติของคุณ"; return; }
  hideAllTopScreens(); screenMyHistory.classList.remove("hidden");
  const list=document.getElementById("my-history-list"); list.innerHTML="กำลังโหลด...";
  const snap=await get(ref(db,`userHistory/${currentUser.uid}`)); const history=Object.values(snap.val()||{}).sort((a,b)=>(b.finishedAt||0)-(a.finishedAt||0));
  list.innerHTML=history.length?history.map(h=>`<div class="match-card"><b>${escapeHtml(h.organizer||"-")}</b><p class="small-text">${escapeHtml(h.format||"-")} • ${h.role==="organizer"?"ผู้จัด":"ผู้เล่น"} • ${formatTournamentDate(h.finishedAt)}</p></div>`).join(""):`<p class="archives-empty">ยังไม่มีประวัติการแข่งขัน</p>`;
});
document.getElementById("btn-history-back").addEventListener("click",()=>{hideAllTopScreens();screenHome.classList.remove("hidden");});
document.getElementById("btn-archives-back").addEventListener("click", () => {
  hideAllTopScreens();
  screenHome.classList.remove("hidden");
});

// ---------- หน้ารายละเอียดทัวร์นาเมนต์ ----------
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
  const canEdit = canEditArchive(archive);
  const canDelete = canDeleteArchive(archive);
  const editing = canEdit && archiveEditMode;

  document.getElementById("archive-detail-title").textContent = `🏆 ${archive.name || "ไม่มีชื่อ"}`;
  const date = archive.updatedAt ? new Date(archive.updatedAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) : "-";
  document.getElementById("archive-detail-meta").textContent =
    `ห้อง: ${archive.roomId || "-"} • โฮสต์: ${archive.hostName || "-"}${archive.affiliation ? ` • สังกัด: ${archive.affiliation}` : ""} • ผู้เล่น ${archive.playerCount || 0} คน • อัปเดตล่าสุด ${date}`;

  document.getElementById("archive-admin-bar").classList.toggle("hidden", !canEdit);
  document.getElementById("btn-archive-edit").textContent = editing ? "✅ เสร็จสิ้นการแก้ไข" : "✏️ โหมดแก้ไข";
  document.getElementById("btn-archive-delete").classList.toggle("hidden", !canDelete);
  const renameBox = document.getElementById("archive-rename-box");
  renameBox.classList.toggle("hidden", !editing);
  const renameInput = document.getElementById("archive-rename-input");
  if (editing && document.activeElement !== renameInput) renameInput.value = archive.name || "";

  const players = archive.players || {};
  const grid = document.getElementById("adet-teams-grid");
  grid.innerHTML = Object.entries(players).filter(([, p]) => !p.isSpectator).map(([pid, p]) => archiveTeamSheetHtml(p, pid, archive, editing)).join("") || `<p class="archives-empty">ไม่มีข้อมูล Team Sheet</p>`;
  hydratePokeApiSprites(grid);

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
  const tournamentHistory = [...(archive.tournament?.phaseHistory || []), ...(archive.tournament?.history || [])];
  if (tournamentHistory.length) {
    renderArchiveMatchHistory(archive);
  } else if (!league || !league.weeks || !league.weeks.length) {
    leagueSection.innerHTML = `<p class="archives-empty">ทัวร์นาเมนต์นี้ยังไม่มีประวัติการต่อสู้</p>`;
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
  const editing = canEditArchive(archive) && archiveEditMode;
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
// ระบบสิทธิ์: เข้าสู่ระบบด้วย Google + แก้ไข/ลบทัวร์นาเมนต์ย้อนหลัง
// หมายเหตุ: การอนุญาตจริงถูกบังคับที่ Firebase Realtime Database Rules
// (ฝั่งหน้าเว็บแค่ซ่อน/โชว์ปุ่ม)
// =====================================================================
const emailKey = (email) => String(email || "").trim().toLowerCase().replace(/\./g, ",");
// เจ้าของเว็บเริ่มต้น: ใช้สำหรับ bootstrap สิทธิ์ครั้งแรก ก่อนมีข้อมูลใน Firebase /admins
const OWNER_EMAIL = "chanatun73344@gmail.com";

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  isOwner = false;
  isOrganizer = false;
  isStaff = false;
  myAffiliation = null;
  myRoleData = null;
  if (user && user.email) {
    isOwner = String(user.email).trim().toLowerCase() === OWNER_EMAIL;
    try {
      const snap = await get(ref(db, `admins/${emailKey(user.email)}`));
      myRoleData = snap.exists() ? snap.val() : null;
      const role = myRoleData?.role;
      isOwner = String(user.email).trim().toLowerCase() === OWNER_EMAIL || role === "owner";
      // รองรับข้อมูลเดิม creator/moderator เพื่อไม่ตัดสิทธิ์ทีมงานเก่า
      isOrganizer = role === "organizer" || role === "creator" || isOwner;
      isStaff = role === "staff" || role === "moderator";
      myAffiliation = myRoleData?.affiliation || null;
    } catch (e) {
      console.error("check role error:", e);
    }
  }
  if (!isOwner) archiveEditMode = false;
  updateAuthUI();
  updateCreateRoomGate();
  if (currentUser) restoreSavedRoom();
  if (isOwner) loadRoleRequests();
  if ((isOrganizer || isStaff) && !roomNotificationsStarted) startOwnTournamentNotifications();
});

function updateAuthUI() {
  const loginBtn = document.getElementById("btn-login");
  const info = document.getElementById("auth-info");
  loginBtn.classList.toggle("hidden", !!currentUser);
  info.classList.toggle("hidden", !currentUser);
  if (currentUser) {
    let roleLabel = " (ไม่มีสิทธิ์พิเศษ)";
    if (isOwner) roleLabel = " (เจ้าของเว็บ)";
    else if (isOrganizer) roleLabel = " (คนจัดงาน)";
    else if (isStaff) roleLabel = ` (ลูกน้อง${myAffiliation ? `: ${myAffiliation}` : ""})`;
    document.getElementById("auth-email").textContent = (currentUser.email || "") + roleLabel;
  }

  if (!screenArchives.classList.contains("hidden")) {
    document.getElementById("archives-search").dispatchEvent(new Event("input"));
  }
  if (!screenArchiveDetail.classList.contains("hidden") && currentArchiveData) {
    renderArchiveDetail(currentArchiveData);
  }
  document.getElementById("admin-panel").classList.toggle("hidden", !isOwner);
  document.getElementById("admin-spectate-box")?.classList.toggle("hidden", !isOwner);
  const requestBtn = document.getElementById("btn-request-role");
  requestBtn?.classList.toggle("hidden", !currentUser || isOwner || isOrganizer || isStaff);
  document.getElementById("btn-open-organizer-dashboard")?.classList.toggle("hidden", !isOrganizer && !isOwner && !isStaff);
  document.getElementById("role-request-status")?.classList.add("hidden");
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

document.getElementById("btn-open-organizer-dashboard")?.addEventListener("click", () => {
  if (!isOwner && !isOrganizer && !isStaff) return;
  const roomId = prompt(isStaff ? "กรอกรหัสห้องทัวร์นาเมนต์ในสังกัดที่คุณดูแล" : "กรอกรหัสห้องทัวร์นาเมนต์ที่คุณสร้าง");
  if (roomId) openSpectate(roomId.trim().toUpperCase());
});

document.getElementById("btn-request-role")?.addEventListener("click", async () => {
  if (!currentUser?.email) return;
  try {
    await set(ref(db, `roleRequests/${emailKey(currentUser.email)}`), {
      email: currentUser.email.toLowerCase(), uid: currentUser.uid, requestedAt: Date.now(), status: "pending"
    });
    const status = document.getElementById("role-request-status");
    status.textContent = "ส่งคำขอถึงเจ้าของแล้ว";
    status.classList.remove("hidden");
    document.getElementById("btn-request-role").classList.add("hidden");
  } catch (e) {
    console.error("request role error:", e);
    alert("ส่งคำขอไม่สำเร็จ กรุณาลองใหม่");
  }
});

// --- ลบ / แก้ไขทัวร์นาเมนต์
async function deleteArchive(id, name) {
  const item = allArchivesCache.find(x => x.id === id) || currentArchiveData;
  if (!canDeleteArchive(item) || !id) return;
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
  if (!canEditArchive(currentArchiveData) || !currentArchiveId) return;
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
  if (!canEditArchive(currentArchiveData) || !currentArchiveData) return;
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

// --- เจ้าของเว็บจัดการรายชื่อผู้มีสิทธิ์
async function loadAdminList() {
  const listEl = document.getElementById("admin-list");
  try {
    const snap = await get(ref(db, "admins"));
    const val = snap.exists() ? snap.val() : {};
    listEl.innerHTML = Object.entries(val).map(([key, data]) => {
      const email = key.replace(/,/g, ".");
      const role = (typeof data === "object" ? data?.role : data) || "owner";
      const aff = typeof data === "object" ? data?.affiliation : null;
      const roleLabel = role === "owner" ? "OWNER" : (role === "organizer" || role === "creator") ? "คนจัดงาน" : "ลูกน้อง";
      return `<li>
        <span>${escapeHtml(email)}${aff ? ` <span class="badge aff-badge">${escapeHtml(aff)}</span>` : ""}</span>
        ${role === "owner"
          ? '<span class="badge">OWNER</span>'
          : `<span class="badge role-badge">${roleLabel}</span> <button class="btn-leave-small" data-remove-admin="${escapeHtml(key)}">ลบสิทธิ์</button>`}
      </li>`;
    }).join("") || '<li>ยังไม่มีรายชื่อ</li>';
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
  const emailInput = document.getElementById("admin-email-input");
  const roleSelect = document.getElementById("admin-role-select");
  const affInput = document.getElementById("admin-affiliation-input");

  const email = emailInput.value.trim().toLowerCase();
  const role = roleSelect.value;
  const affiliation = affInput.value.trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { alert("อีเมลไม่ถูกต้อง"); return; }
  if (role === "staff" && !affiliation) { alert("กรุณาระบุชื่อสังกัดสำหรับลูกน้อง"); return; }

  try {
    await set(ref(db, `admins/${emailKey(email)}`), { role, affiliation });
    emailInput.value = "";
    affInput.value = "";
    loadAdminList();
  } catch (e) {
    console.error("add admin error:", e);
    alert("เพิ่มไม่สำเร็จ");
  }
});

// =====================================================================
// โหมดตรวจสอบห้องแข่งขันสด (เฉพาะเจ้าของเว็บ) - ดู + แชทได้ทุกห้อง
// =====================================================================
document.getElementById("btn-spectate-room")?.addEventListener("click", () => {
  if (!isOwner && !isOrganizer) return;
  const code = document.getElementById("spectate-room-code").value.trim().toUpperCase();
  if (code) openSpectate(code);
});

async function openSpectate(roomId) {
  const roomSnap = await get(ref(db, "rooms/" + roomId));
  if (!roomSnap.exists()) { alert("ไม่พบห้องนี้"); return; }
  const roomData = roomSnap.val();
  // ถ้าคนที่กดเข้ามาจริงๆ แล้วเป็นผู้เล่น/โฮสต์ของห้องนี้อยู่แล้ว (เช่น กดออกจากห้องแล้วใช้ปุ่มนี้กลับเข้ามาใหม่)
  // ให้พาเข้าห้องแบบผู้เล่นปกติที่มีปุ่มกรอก/แก้ไขคะแนนครบ แทนที่จะโชว์แผงดูแลแบบแอดมินภายนอกซึ่งเป็นแค่โหมดดูอย่างเดียว
  // ใช้ userUid เทียบ ซึ่งมีอยู่แล้วในข้อมูลผู้เล่นทุกห้องตั้งแต่เดิม จึงใช้ได้กับทัวร์นาเมนต์เก่าด้วยโดยไม่ต้องย้ายข้อมูลใดๆ
  const myEntry = currentUser ? Object.entries(roomData.players || {}).find(([, p]) => p?.userUid === currentUser.uid) : null;
  if (myEntry) {
    const [myPlayerId, myPlayer] = myEntry;
    enterLobby(roomId, myPlayerId, !!myPlayer.isHost);
    return;
  }
  if (!canManageRoom(roomData)) { alert("คุณดูแลได้เฉพาะทัวร์นาเมนต์ที่คุณสร้างเอง"); return; }
  hideAllTopScreens();
  screenSpectate.classList.remove("hidden");
  setSpectateTab("matches");
  document.getElementById("spectate-room-code-title").textContent = roomId;
  spectateRoomId = roomId;
  syncAdminCallDrawer(roomSnap.val(), roomId);

  onValue(ref(db, "rooms/" + roomId), (snap) => {
    const strip = document.getElementById("spectate-players-strip");
    if (!snap.exists()) { strip.innerHTML = '<p class="archives-empty">ไม่พบห้องนี้ (อาจปิดไปแล้ว)</p>'; return; }
    const room = snap.val();
    strip.innerHTML = Object.values(room.players || {}).map(p => `
      <div class="player-chip"><div>${escapeHtml(p.name)}${p.isHost ? ' 👑' : ''}</div>
      <div class="p-money">💰${(p.money||0).toLocaleString()} | 🎒${(p.team||[]).length}</div></div>`).join("");
    renderSpectateStandings(room);
    renderSpectateDraftTeams(room);
    const signature = JSON.stringify((room.tournament?.history || []).map(round => (round.matches || []).map(match => [match.player1Id, match.player2Id, match.winnerId, match.score])));
    if (signature !== spectateMatchSignature) {
      spectateMatchSignature = signature;
      mountSpectateMatchChats(roomId, room);
    }
  });

  onValue(ref(db, `rooms/${roomId}/adminChat`), snap => renderChatMessages(document.getElementById("spectate-chat-messages"), snap.val()));
  onValue(ref(db, `rooms/${roomId}/adminCalls`), snap => {
    const calls=Object.values(snap.val()||{}).filter(c=>c.status!=="closed").sort((a,b)=>b.time-a.time);
    document.getElementById("spectate-admin-calls").innerHTML=calls.length?`<b>🆘 คำขอเรียกแอดมิน</b>${calls.map(c=>`<div>${escapeHtml(c.matchLabel || "คำขอทั่วไป")}: ${escapeHtml(c.name)} — ${formatTournamentDate(c.time)}</div>`).join("")}`:"<span class=\"small-text\">ไม่มีคำขอเรียกแอดมิน</span>";
  });
  mountSpectateMatchChats(roomId, roomSnap.val());
}

function mountSpectateMatchChats(roomId, room) {
  spectateChatUnsubs.forEach(unsub => unsub());
  spectateChatUnsubs = [];
  const box = document.getElementById("spectate-match-chats");
  const sections = [];
  const subscriptions = [];
  (room.tournament?.history || []).forEach((round, roundIndex) => (round.matches || []).forEach((match, matchIndex) => {
    if (match.isBye) return;
    const a = room.players?.[match.player1Id]?.name || "-", b = room.players?.[match.player2Id]?.name || "-";
    const id = `staff-match-${roundIndex}-${matchIndex}`;
    const scoreValues = room.settings?.bestOf === "BO3" ? ["2-0", "2-1", "1-2", "0-2"] : ["1-0", "0-1"];
    const scoreOptions = scoreValues.map(value => `<option value="${value}" ${match.score === value ? "selected" : ""}>${value}</option>`).join("");
    const result = match.winnerId && canEditConfirmedResults(room)
      ? `<div class="admin-result-form"><span class="small-text">ผลที่ยืนยันแล้ว: ${escapeHtml(room.players?.[match.winnerId]?.name || "-")} (${escapeHtml(match.score || "-")})</span><select id="${id}-winner"><option value="${match.player1Id}" ${match.winnerId === match.player1Id ? "selected" : ""}>${escapeHtml(a)} ชนะ</option><option value="${match.player2Id}" ${match.winnerId === match.player2Id ? "selected" : ""}>${escapeHtml(b)} ชนะ</option></select><select id="${id}-score">${scoreOptions}</select><button class="primary" data-admin-result-round="${roundIndex}" data-admin-result-match="${matchIndex}">✏️ แก้ไขผล</button></div>`
      : `<p class="small-text">${match.winnerId ? `ผลที่ยืนยันแล้ว: ${escapeHtml(room.players?.[match.winnerId]?.name || "-")} (${escapeHtml(match.score || "-")})` : "ยังไม่ยืนยันผล"}</p>`;
    sections.push(`<div class="match-chat"><b>รอบ ${round.round || roundIndex + 1}: ${escapeHtml(a)} VS ${escapeHtml(b)}</b>${result}<div class="chat-messages" id="${id}"></div></div>`);
    subscriptions.push({ roundIndex, matchIndex, id, match });
  }));
  box.innerHTML = sections.join("") || '<p class="small-text">ยังไม่มีคู่แข่งขันหรือแชทเฉพาะคู่</p>';
  subscriptions.forEach(({ roundIndex, matchIndex, id }) => spectateChatUnsubs.push(onValue(ref(db, `rooms/${roomId}/matchChats/${roundIndex}/${matchIndex}`), snap => renderChatMessages(document.getElementById(id), snap.val()))));
  box.querySelectorAll("button[data-admin-result-round]").forEach(button => button.addEventListener("click", async () => {
    const roundIndex = +button.dataset.adminResultRound, matchIndex = +button.dataset.adminResultMatch;
    const id = `staff-match-${roundIndex}-${matchIndex}`;
    const winnerId = document.getElementById(`${id}-winner`).value;
    const score = document.getElementById(`${id}-score`).value;
    button.disabled = true;
    try { await saveAdminMatchResult(roomId, roundIndex, matchIndex, winnerId, score); }
    catch (error) { console.error("admin result failed:", error); alert("บันทึกผลไม่สำเร็จ กรุณาตรวจสอบสิทธิ์และลองใหม่"); }
    finally { button.disabled = false; }
  }));
}

function renderSpectateStandings(room) {
  const table = document.getElementById("spectate-standings-table");
  if (!table) return;
  const standings = tournamentStats(room);
  table.innerHTML = `<tr><th>#</th><th>ผู้เล่น</th><th>แข่ง</th><th>ชนะ</th><th>แพ้</th><th>แต้ม</th></tr>${standings.map((player, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(player.name)}${room.players?.[player.pid]?.withdrawn ? " (ถอนตัว)" : ""}</td><td>${player.played}</td><td>${player.wins}</td><td>${player.losses}</td><td><b>${player.points}</b></td></tr>`).join("") || '<tr><td colspan="6" class="small-text">ยังไม่มีผู้เล่น</td></tr>'}`;
}

function renderSpectateDraftTeams(room) {
  const grid = document.getElementById("spectate-draft-teams");
  if (!grid) return;
  grid.innerHTML = Object.entries(room.players || {}).filter(([, player]) => !player.isSpectator).map(([playerId, player]) => {
    const team = player.team || [];
    return `<article class="team-summary-card draft-team-card"><div class="draft-team-heading"><div><h4>${escapeHtml(player.name)}${playerId === room.hostId ? ' <span class="badge">HOST</span>' : ''}</h4><p class="small-text">ทีมจากการประมูล</p></div><div class="team-count-badge">${team.length}/${room.settings?.teamSize || 10}</div></div><div class="draft-team-meta"><span>💰 ${(player.money || 0).toLocaleString()}</span><span>🎒 ${team.length} ตัว</span></div><div class="draft-team-roster size-${room.settings?.teamSize || 10}">${team.map(member => `<div class="team-slot draft-pokemon-card"><img src="${member.sprite}" alt=""><span>${escapeHtml(member.displayName)}${member.isMega ? ' 🌟' : ''}</span>${monTypesHtml(member)}${member.price ? `<span class="price-tag">💰${member.price.toLocaleString()}</span>` : (member.viaTicket ? '<span class="price-tag">🎫 ตั๋ว</span>' : (member.viaRandom ? '<span class="price-tag">🎲 สุ่มให้</span>' : (member.viaGift ? '<span class="price-tag">🎁 ของขวัญ</span>' : '')))}</div>`).join("") || '<span class="small-text">ยังไม่มีโปเกม่อนจากการประมูล</span>'}</div></article>`;
  }).join("") || '<p class="small-text">ยังไม่มีผู้เล่นในห้อง</p>';
}

async function saveAdminMatchResult(roomId, roundIndex, matchIndex, winnerId, score) {
  const roomSnap = await get(ref(db, `rooms/${roomId}`));
  const room = roomSnap.val();
  if (!room || !canEditConfirmedResults(room)) throw new Error("Not allowed");
  const match = room.tournament?.history?.[roundIndex]?.matches?.[matchIndex];
  const validScore = room.settings?.bestOf === "BO3" ? /^(2-[01]|[01]-2)$/.test(score) : score === "1-0" || score === "0-1";
  const winnerMatchesScore = winnerId === match?.player1Id ? (score.startsWith("2") || score === "1-0") : (score.endsWith("2") || score === "0-1");
  if (!match?.winnerId || match.isBye || !validScore || !winnerMatchesScore || ![match.player1Id, match.player2Id].includes(winnerId)) throw new Error("Invalid result");
  await runTransaction(ref(db, `rooms/${roomId}/tournament`), tournament => {
    const currentMatch = tournament?.history?.[roundIndex]?.matches?.[matchIndex];
    if (!currentMatch?.winnerId) return tournament;
    currentMatch.winnerId = winnerId;
    currentMatch.score = score;
    currentMatch.pendingWinnerId = null;
    currentMatch.pendingScore = null;
    currentMatch.reportedAt = Date.now();
    currentMatch.reportedBy = `admin:${currentUser?.uid || "unknown"}`;
    currentMatch.editedAt = Date.now();
    currentMatch.editedBy = currentUser?.uid || "unknown";
    return tournament;
  });
}

document.getElementById("btn-spectate-chat-send")?.addEventListener("click", () => {
  const input = document.getElementById("spectate-chat-input");
  const text = input.value.trim();
  if (!text || !spectateRoomId || (!isOwner && !isOrganizer)) return;
  push(ref(db, `rooms/${spectateRoomId}/adminChat`), {
    name: isOwner ? "🛡️ เจ้าของเว็บ" : "🧭 คนจัดงาน",
    text,
    time: Date.now(),
    isOwnerMsg: true
  });
  input.value = "";
});

function setSpectateTab(tab) {
  const showMatches = tab === "matches";
  document.getElementById("spectate-tab-matches")?.classList.toggle("active", showMatches);
  document.getElementById("spectate-tab-teams")?.classList.toggle("active", !showMatches);
  document.getElementById("spectate-matches-section")?.classList.toggle("hidden", !showMatches);
  document.getElementById("spectate-teams-section")?.classList.toggle("hidden", showMatches);
}
document.getElementById("spectate-tab-matches")?.addEventListener("click", () => setSpectateTab("matches"));
document.getElementById("spectate-tab-teams")?.addEventListener("click", () => setSpectateTab("teams"));
document.getElementById("spectate-chat-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-spectate-chat-send").click();
});

document.getElementById("btn-spectate-back")?.addEventListener("click", () => {
  spectateChatUnsubs.forEach(unsub => unsub());
  spectateChatUnsubs = [];
  spectateMatchSignature = "";
  spectateRoomId = null;
  hideAllTopScreens();
  screenArchives.classList.remove("hidden");
});

async function loadRoleRequests() {
  const list = document.getElementById("role-request-list");
  if (!list || !isOwner) return;
  try {
    const snap = await get(ref(db, "roleRequests"));
    const requests = Object.entries(snap.val() || {}).filter(([, item]) => item?.status === "pending");
    list.innerHTML = requests.map(([key, item]) => `<li><span>${escapeHtml(item.email || key.replace(/,/g, "."))}</span><span><button class="btn-leave-small" data-approve-request="${escapeHtml(key)}">อนุมัติเป็นคนจัดงาน</button> <button class="btn-leave-small" data-deny-request="${escapeHtml(key)}">ปฏิเสธ</button></span></li>`).join("") || "<li>ไม่มีคำขอค้างอยู่</li>";
    list.querySelectorAll("[data-approve-request]").forEach(btn => btn.addEventListener("click", async () => {
      const key = btn.dataset.approveRequest;
      const request = (await get(ref(db, `roleRequests/${key}`))).val();
      if (!request?.email) return;
      await update(ref(db), { [`admins/${key}`]: { role: "organizer", grantedAt: Date.now() }, [`roleRequests/${key}/status`]: "approved" });
      loadAdminList(); loadRoleRequests();
    }));
    list.querySelectorAll("[data-deny-request]").forEach(btn => btn.addEventListener("click", async () => {
      await update(ref(db, `roleRequests/${btn.dataset.denyRequest}`), { status: "denied", handledAt: Date.now() });
      loadRoleRequests();
    }));
  } catch (e) { console.error("load role requests error:", e); }
}

function startOwnTournamentNotifications() {
  roomNotificationsStarted = true;
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  onValue(ref(db, "rooms"), snap => {
    Object.entries(snap.val() || {}).forEach(([roomId, room]) => {
      if (!canManageRoom(room)) return;
      Object.entries(room.adminCalls || {}).forEach(([callId, call]) => {
        const key = `${roomId}/${callId}`;
        if (seenAdminCalls.has(key) || call.status === "closed") return;
        seenAdminCalls.add(key);
        const message = `${call.name || "ผู้เล่น"} เรียกแอดมินในห้อง ${roomId}`;
        if ("Notification" in window && Notification.permission === "granted") new Notification("VGC Lab", { body: message });
      });
    });
  });
}

async function saveCompletedTournamentArchive() {
  const room = latestRoom;
  if (!room || !isHost || room.status !== "completed" || !currentRoomId) return;
  const input = document.getElementById("completed-archive-name");
  const button = document.getElementById("btn-save-completed-archive");
  const name = input.value.trim() || `ทัวร์นาเมนต์ ${currentRoomId}`;
  button.disabled = true;
  try {
    const archiveId = push(ref(db, "archives")).key;
    const createdAt = Date.now();
    await set(ref(db, `archives/${archiveId}`), {
      name, roomId:currentRoomId, creatorUid:room.creatorUid || null, creatorEmail:room.creatorEmail || null,
      affiliation:room.affiliation || null, hostName:room.players?.[room.hostId]?.name || "-",
      playerCount:competitivePlayerIds(room).length, createdAt, updatedAt:createdAt, settings:room.settings || null,
      players:room.players || {}, hostId:room.hostId || null, league:room.league || null,
      tournament:room.tournament || null, bannedList:getBannedList(room), hasBanInfo:true
    });
    await update(ref(db, `rooms/${currentRoomId}`), { archiveId, archiveName:name, archiveCreatedAt:createdAt });
  } catch (error) {
    console.error("save completed archive error:", error);
    alert("บันทึกทัวร์นาเมนต์ไม่สำเร็จ กรุณาลองใหม่");
  } finally { button.disabled = false; }
}

function teamSheetSprite(name) {
  const slug = String(name || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `https://play.pokemonshowdown.com/sprites/ani/${slug}.gif`;
}
function archiveTeamSheetHtml(player, pid, archive, editing) {
  const team = profileOf(player);
  const isAuctionTeam = Array.isArray(player.team) && player.team.length;
  const source = isAuctionTeam ? (player.team.some(m => m?.viaGacha) ? "Box จากตู้สุ่ม" : "ทีมจากการประมูล") : "Team Sheet";
  // ทีมจากการประมูล/ดราฟต์ ไม่มีข้อมูลท่า/นิสัย/อบิลิตี้ -> การ์ดแบบเดิม (ชื่อ + ไอเทม/ราคา)
  // ส่วน Team Sheet ที่พิมพ์เอง มีข้อมูลครบ จึงโชว์การ์ดแบบละเอียดเหมือนตอนดูทีมระหว่างแข่งขัน (ท่า/ไอเทม/นิสัย/อบิลิตี้)
  const roster = isAuctionTeam
    ? `<div class="auction-sheet-roster team-size-${archive.settings?.teamSize || 10}">${player.team.map((member, index) => `<div class="auction-sheet-member"><img src="${member.sprite || teamSheetSprite(member.displayName)}" alt="${escapeHtml(member.displayName)}"><b>${escapeHtml(member.displayName)}</b>${monTypesHtml(member)}<small>#${index + 1}${member.price ? ` • 💰${Number(member.price).toLocaleString()}` : ""}</small></div>`).join("")}</div>`
    : (team.length ? sheetViewerHtml("archive-" + pid, sheetMonsOf(player), { showEvs: false }) : '<p class="archives-empty">ยังไม่ได้ส่ง Team Sheet</p>');
  return `<article class="archive-team-sheet">
    <header><div><h3>${escapeHtml(player.name || "ผู้เล่น")}${pid === archive.hostId ? ' <span class="badge">HOST</span>' : ''}</h3><p>${source} • ${team.length || 0}/${isAuctionTeam ? (archive.settings?.teamSize || 10) : 6} ตัว</p></div></header>
    ${roster}
    ${editing ? `<div class="add-poke-row"><select data-add-select="${escapeHtml(pid)}"><option value="">— เลือกโปเกม่อนที่จะเพิ่ม —</option>${POKEMON_LIST.map((pk, i) => `<option value="${i}">${escapeHtml(pk.displayName)}</option>`).join("")}</select><button data-add-pid="${escapeHtml(pid)}">➕ เพิ่ม</button></div>` : ""}
  </article>`;
}

function renderArchiveMatchHistory(archive) {
  // รวมประวัติของทุกเฟส (phaseHistory ของเฟสก่อนหน้า + history ของเฟสปัจจุบัน/เฟสสุดท้าย) ให้ครบทุกรอบ
  const history = [...(archive.tournament?.phaseHistory || []), ...(archive.tournament?.history || [])];
  const section = document.getElementById("adet-league-section");
  const stats = Object.fromEntries(Object.entries(archive.players || {}).filter(([, p]) => !p.isSpectator).map(([pid, p]) => [pid, { pid, name:p.name, wins:0, losses:0, played:0, points:0 }]));
  history.forEach(round => (round.matches || []).forEach(match => {
    if (!match.winnerId || !stats[match.winnerId]) return;
    if (match.isBye) {
      if (round.format !== "roundRobin") { stats[match.winnerId].wins++; stats[match.winnerId].played++; stats[match.winnerId].points += 3; }
      return;
    }
    const loser = match.winnerId === match.player1Id ? match.player2Id : match.player1Id;
    stats[match.winnerId].wins++; stats[match.winnerId].played++; stats[match.winnerId].points += 3;
    if (stats[loser]) { stats[loser].losses++; stats[loser].played++; }
  }));
  const labels = history.map((round, index) => round.format ? `${tournamentLabel(round.format)} • รอบ ${round.round || index + 1}` : `รอบ ${index + 1}`);
  const renderRound = roundIndex => {
    const round = history[roundIndex];
    if (!round) return "";
    return `<section class="history-round"><h3>${escapeHtml(labels[roundIndex])}</h3>${(round.matches || []).map(match => {
      const p1 = archive.players?.[match.player1Id], p2 = archive.players?.[match.player2Id];
      if (match.isBye) return `<div class="history-match bye-card"><b>${escapeHtml(p1?.name || "?")}</b><span class="badge">${round.format === "roundRobin" ? "พักรอบนี้ • 0 แต้ม" : "BYE • ชนะ +3"}</span></div>`;
      const p1Won = match.winnerId === match.player1Id, p2Won = match.winnerId === match.player2Id;
      return `<div class="history-match"><span class="${p1Won ? "winner-name" : ""}">${escapeHtml(p1?.name || "?")}</span><b class="history-score">${escapeHtml(match.score || "VS")}</b><span class="${p2Won ? "winner-name" : ""}">${escapeHtml(p2?.name || "?")}</span><small>${match.winnerId ? `ชนะ: ${escapeHtml(archive.players?.[match.winnerId]?.name || "?")}` : "ยังไม่ได้แข่ง"}</small></div>`;
    }).join("")}</section>`;
  };
  section.innerHTML = `<div id="adet-match-history" class="archive-match-history"><div class="week-tabs history-round-tabs">${labels.map((label, index) => `<button class="week-tab-btn ${index === 0 ? "active" : ""}" data-history-round="${index}">${escapeHtml(label)}</button>`).join("")}</div><div id="adet-history-round-content">${renderRound(0)}</div></div><h3 style="margin:20px 0 10px;">📊 ตารางคะแนน</h3><table class="standings-table" id="adet-standings-table"></table>`;
  section.querySelectorAll("[data-history-round]").forEach(button => button.addEventListener("click", () => {
    const roundIndex = Number(button.dataset.historyRound);
    section.querySelectorAll("[data-history-round]").forEach(tab => tab.classList.toggle("active", tab === button));
    section.querySelector("#adet-history-round-content").innerHTML = renderRound(roundIndex);
  }));
  const standings = Object.values(stats).sort((a,b) => b.points-a.points || b.wins-a.wins || a.name.localeCompare(b.name));
  const standingsTable = document.getElementById("adet-standings-table");
  standingsTable.innerHTML = `<tr><th>#</th><th>ผู้เล่น</th><th>แข่ง</th><th>ชนะ</th><th>แพ้</th><th>แต้ม</th><th>ทีม</th></tr>${standings.map((s,i) => `<tr><td>${i+1}</td><td>${escapeHtml(s.name)}</td><td>${s.played}</td><td>${s.wins}</td><td>${s.losses}</td><td><b>${s.points}</b></td><td>${teamPreviewHtml(archive.players?.[s.pid], `adet-standing-${s.pid}`)}</td></tr>`).join("")}`;
  bindTeamToggles(standingsTable);
}
// ---------- อีเวนต์สมัครล่วงหน้า + เช็คอิน ----------
// events/{id}: { title, hostName, creatorUid, startAt, capacity, config, status: open|checkin|started,
//                checkinMinutes, checkinEndsAt, roomId, playerMap, registrations/{uid} }
const screenEvents = document.getElementById("screen-events");
let eventsCache = {};
let eventsUnsub = null;
let openEventId = null;

function fmtEventDate(ms) {
  return new Date(ms).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
}
function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function eventStatusLabel(ev) {
  if (ev.status === "checkin") return "🟢 กำลังเช็คอิน";
  if (ev.status === "started") return "🏁 เริ่มแล้ว";
  return "📝 เปิดรับสมัคร";
}
function isEventHost(ev) {
  return !!currentUser && (currentUser.uid === ev.creatorUid || isOwner);
}
// ผู้ที่ได้ที่นั่งจริง = คนที่เช็คอินแล้ว เรียงตามเวลาสมัคร ตัดที่จำนวน capacity (ที่เหลือเป็นสำรอง)
function eventSortedRegs(ev) {
  return Object.values(ev.registrations || {}).sort((a, b) => (a.registeredAt || 0) - (b.registeredAt || 0));
}
function eventSeatUids(ev) {
  return new Set(eventSortedRegs(ev).filter(r => r.checkedIn).slice(0, ev.capacity).map(r => r.uid));
}

function readRoomFormForEvent() {
  const mode = document.getElementById("create-room-mode").value;
  const hostParticipation = document.getElementById("create-host-participation").value;
  const maxPlayers = parseInt(document.getElementById("create-max-players").value);
  return {
    hostName: document.getElementById("create-name").value.trim(),
    hostParticipation,
    maxPlayers,
    settings: {
      maxPlayers,
      mode,
      auctionSelector: document.getElementById("create-auction-selector").value,
      auctionReveal: document.getElementById("create-auction-reveal").value,
      hostParticipation,
      phases: [document.getElementById("create-phase-1").value, document.getElementById("create-phase-2").value].filter(Boolean),
      bestOf: document.getElementById("create-best-of").value,
      checkIn: document.getElementById("create-checkin").value,
      topCut: parseInt(document.getElementById("create-top-cut").value),
      swissRounds: parseInt(document.getElementById("create-swiss-rounds").value),
      startMoney: mode === "auction" ? parseInt(document.getElementById("create-auction-start-money").value) : 0,
      minBidIncrement: 50,
      timerSeconds: parseInt(document.getElementById("create-auction-timer").value),
      teamSize: mode === "auction" ? parseInt(document.getElementById("create-auction-team-size").value) : mode === "gacha" ? parseInt(document.getElementById("create-gacha-box-size").value) : 6,
      ...readExtraCreateSettings(mode)
    }
  };
}

document.getElementById("btn-create-event").addEventListener("click", async () => {
  if (!canCreateRoom()) { homeError.textContent = "คุณไม่มีสิทธิ์สร้างอีเวนต์ กรุณาเข้าสู่ระบบด้วยบัญชีที่ได้รับสิทธิ์"; return; }
  const title = document.getElementById("create-event-title").value.trim();
  const startStr = document.getElementById("create-event-start").value;
  const cfg = readRoomFormForEvent();
  if (!cfg.hostName) { homeError.textContent = "กรุณากรอกชื่อของคุณ"; return; }
  if (!title) { homeError.textContent = "กรุณากรอกชื่ออีเวนต์"; return; }
  const startAt = startStr ? new Date(startStr).getTime() : NaN;
  if (!startAt || isNaN(startAt)) { homeError.textContent = "กรุณาเลือกวันและเวลาเริ่มอีเวนต์"; return; }
  // ที่นั่งสำหรับผู้สมัคร = จำนวนผู้เล่นสูงสุด (หักที่ของโฮสต์ถ้าโฮสต์ร่วมเล่น)
  const capacity = Math.max(1, cfg.maxPlayers - (cfg.hostParticipation === "play" ? 1 : 0));
  const eventId = generateRoomCode();
  try {
    await set(ref(db, "events/" + eventId), {
      title, hostName: cfg.hostName, creatorUid: currentUser.uid, creatorEmail: currentUser.email || null,
      affiliation: myAffiliation || null, startAt, capacity, config: cfg.settings,
      status: "open", checkinMinutes: 10, checkinEndsAt: null, roomId: null, createdAt: serverNow()
    });
    homeError.textContent = "";
    openEventsScreen(eventId);
  } catch (e) {
    console.error("create event error:", e);
    homeError.textContent = "สร้างอีเวนต์ไม่สำเร็จ (อาจยังไม่ได้อัปเดต Database Rules ส่วน events)";
  }
});

function openEventsScreen(eventId = null) {
  if (!currentUser) { homeError.textContent = "กรุณาเข้าสู่ระบบก่อนดูอีเวนต์"; return; }
  hideAllTopScreens();
  screenEvents.classList.remove("hidden");
  openEventId = eventId;
  if (eventsUnsub) eventsUnsub();
  document.getElementById("events-list").innerHTML = '<p class="small-text">กำลังโหลด...</p>';
  eventsUnsub = onValue(ref(db, "events"), (snap) => {
    eventsCache = snap.val() || {};
    renderEventsScreen();
  }, (err) => {
    console.error("events read error:", err);
    document.getElementById("events-list").innerHTML = '<p class="error">โหลดอีเวนต์ไม่สำเร็จ (ต้องยืนยันอีเมลและอัปเดต Database Rules)</p>';
  });
}
function closeEventsScreen() {
  if (eventsUnsub) { eventsUnsub(); eventsUnsub = null; }
  openEventId = null;
  hideAllTopScreens();
  screenHome.classList.remove("hidden");
}
document.getElementById("btn-open-events").addEventListener("click", () => openEventsScreen());
document.getElementById("btn-events-back").addEventListener("click", closeEventsScreen);

function renderEventsScreen() {
  const listEl = document.getElementById("events-list");
  const detailEl = document.getElementById("event-detail");
  if (openEventId) {
    listEl.classList.add("hidden");
    detailEl.classList.remove("hidden");
    renderEventDetail();
    return;
  }
  detailEl.classList.add("hidden");
  listEl.classList.remove("hidden");
  const now = Date.now();
  const evs = Object.entries(eventsCache)
    .filter(([, ev]) => !(ev.status === "started" && (ev.startAt || 0) < now - 86400000))
    .sort((a, b) => (a[1].startAt || 0) - (b[1].startAt || 0));
  listEl.innerHTML = evs.length ? evs.map(([id, ev]) => {
    const regCount = Object.keys(ev.registrations || {}).length;
    return `<div class="match-card"><b>${escapeHtml(ev.title)}</b> <span class="badge">${eventStatusLabel(ev)}</span>
      <p class="small-text">🗓 ${fmtEventDate(ev.startAt)} • โดย ${escapeHtml(ev.hostName || "-")} • สมัครแล้ว ${regCount}/${ev.capacity}</p>
      <button class="btn-leave-small" data-open-event="${id}">ดูรายละเอียด</button></div>`;
  }).join("") : '<p class="small-text">ยังไม่มีอีเวนต์ที่เปิดอยู่</p>';
  listEl.querySelectorAll("[data-open-event]").forEach(btn => btn.addEventListener("click", () => {
    openEventId = btn.dataset.openEvent;
    renderEventsScreen();
  }));
}

function renderEventDetail() {
  const box = document.getElementById("event-detail");
  const prevName = document.getElementById("ev-reg-name")?.value;
  const prevTeam = document.activeElement?.id === "ev-team-input" ? document.getElementById("ev-team-input").value : null;
  const ev = eventsCache[openEventId];
  const backBtn = '<button class="btn-leave-small" data-ev-act="back">⬅ รายการอีเวนต์</button>';
  if (!ev) { box.innerHTML = `${backBtn}<p class="small-text">ไม่พบอีเวนต์นี้ (อาจถูกลบแล้ว)</p>`; bindEventActions(box); return; }

  const uid = currentUser?.uid;
  const host = isEventHost(ev);
  const regs = eventSortedRegs(ev);
  const mine = uid ? ev.registrations?.[uid] : null;
  const seats = eventSeatUids(ev);
  const remaining = (ev.checkinEndsAt || 0) - serverNow();
  const checkinOpen = ev.status === "checkin" && remaining > 0;
  const myPid = uid ? ev.playerMap?.[uid] : null;
  const requiresTeamSheet = isTeamSheetMode({ settings: ev.config });

  const rows = regs.map((r, i) => {
    let state;
    if (r.checkedIn) state = seats.has(r.uid) ? "✅ เช็คอินแล้ว" : "🕓 สำรอง (ที่นั่งเต็ม)";
    else state = ev.status === "open" && i >= ev.capacity ? "🕓 สำรอง" : "⏳ ยังไม่เช็คอิน";
    const teamBadge = requiresTeamSheet ? (hasSubmittedTeamSheet(r) ? ' <span class="badge team-sheet-ready">📄 ส่งทีมแล้ว</span>' : ' <span class="badge team-sheet-missing">⏳ รอทีม</span>') : "";
    const kick = host && ev.status !== "started" ? `<button class="btn-kick" data-ev-act="kick" data-uid="${escapeHtml(r.uid)}">ลบ</button>` : "";
    return `<li><span>${i + 1}. ${escapeHtml(r.name)}${r.uid === ev.creatorUid ? ' <span class="badge">HOST</span>' : ""}${teamBadge}</span> <span class="small-text">${state}</span>${kick}</li>`;
  }).join("") || '<li class="small-text">ยังไม่มีผู้สมัคร</li>';

  let playerArea = "";
  if (ev.status === "started") {
    playerArea = myPid && ev.roomId
      ? `<button class="primary" data-ev-act="enter">🚪 เข้าห้อง (${escapeHtml(ev.roomId)})</button>`
      : `<p class="small-text">อีเวนต์เริ่มแล้ว${mine ? " — คุณไม่ได้เช็คอินทันเวลา จึงไม่ได้อยู่ในห้อง" : ""}</p>`;
  } else if (!mine) {
    playerArea = `<input type="text" id="ev-reg-name" placeholder="ชื่อที่จะใช้ในเกม" maxlength="20" value="${escapeHtml(prevName ?? currentUser?.displayName ?? "")}">
      <button class="primary" data-ev-act="register">✍️ สมัครเข้าร่วม</button>`;
  } else if (ev.status === "checkin") {
    playerArea = mine.checkedIn
      ? '<p class="small-text">✅ คุณเช็คอินแล้ว รอโฮสต์เริ่มห้อง</p>'
      : `<button class="primary" id="ev-checkin-btn" data-ev-act="checkin" ${checkinOpen ? "" : "disabled"}>✅ เช็คอิน</button>`;
  } else {
    playerArea = `<p class="small-text">✅ คุณสมัครแล้ว — รอโฮสต์เปิดเช็คอินตอนถึงเวลา</p><button class="btn-leave-small" data-ev-act="unregister">ยกเลิกการสมัคร</button>`;
  }

  // ให้ผู้สมัครส่ง Team Sheet ล่วงหน้าได้เลยตั้งแต่ตอนสมัคร (ก่อนถึงเวลาแข่ง) ไม่ต้องรอเข้าห้องก่อน
  if (mine && ev.status !== "started" && requiresTeamSheet) {
    const sheet = mine.teamSheet || teamSheetWithoutEvs(mine.teamText);
    playerArea += `<section class="team-editor">
      <h3>📝 ส่ง Team Sheet ล่วงหน้า</h3>
      <p class="small-text">วางโค้ดทีมจาก Pokémon Showdown ได้เลย ไม่ต้องรอเข้าห้อง ระบบจะไม่นำบรรทัด EVs ไปแสดง</p>
      ${evSavedPicker()}<textarea id="ev-team-input" rows="14" placeholder="วางโค้ดทีมจาก Pokémon Showdown ที่นี่">${escapeHtml(prevTeam ?? mine.teamText ?? "")}</textarea>
      <button class="primary" data-ev-act="save-team">ส่ง Team Sheet</button>
      <pre class="team-sheet-preview${sheet ? "" : " hidden"}">${escapeHtml(sheet)}</pre>
    </section>`;
  }

  let hostArea = "";
  if (host) {
    if (ev.status === "open") {
      hostArea = `<div class="match-card"><b>ควบคุมอีเวนต์ (โฮสต์)</b>
        <p class="small-text">เมื่อถึงเวลา กดเริ่มเพื่อเปิดเช็คอิน ผู้สมัครต้องกดเช็คอินภายในเวลาที่กำหนด</p>
        <select id="ev-checkin-min"><option value="5">เช็คอิน 5 นาที</option><option value="10" selected>เช็คอิน 10 นาที</option><option value="15">เช็คอิน 15 นาที</option></select>
        <button class="primary" data-ev-act="start-checkin">▶ เริ่ม / เปิดเช็คอิน</button></div>`;
    } else if (ev.status === "checkin") {
      const checkedCount = regs.filter(r => r.checkedIn && r.uid !== ev.creatorUid).length;
      hostArea = `<div class="match-card"><b>ควบคุมอีเวนต์ (โฮสต์)</b>
        <p class="small-text">เช็คอินแล้ว ${checkedCount} คน • ${checkinOpen ? "หมดเวลาใน <b id=\"ev-countdown\">" + fmtCountdown(remaining) + "</b>" : "หมดเวลาเช็คอินแล้ว"}</p>
        <button class="primary" data-ev-act="create-room">🏁 สร้างห้องจากผู้ที่เช็คอิน</button></div>`;
    }
    hostArea += '<button class="btn-kick" data-ev-act="delete" style="margin:8px 0;">🗑 ลบอีเวนต์</button>';
  }

  const countdownForPlayers = ev.status === "checkin" && !host
    ? `<p class="small-text">⏱ เวลาเช็คอินคงเหลือ <b id="ev-countdown">${fmtCountdown(remaining)}</b></p>` : "";

  box.innerHTML = `${backBtn}
    <h3 style="margin:10px 0 2px;">${escapeHtml(ev.title)} <span class="badge">${eventStatusLabel(ev)}</span></h3>
    <p class="small-text">🗓 ${fmtEventDate(ev.startAt)} • โฮสต์: ${escapeHtml(ev.hostName || "-")} • รับ ${ev.capacity} ที่นั่ง</p>
    ${countdownForPlayers}${playerArea}${hostArea}
    <h4>รายชื่อผู้สมัคร (${regs.length})</h4><ul class="player-list">${rows}</ul>`;
  bindEventActions(box);
}

// ตัวนับเวลาเช็คอิน อัปเดตเฉพาะตัวเลข ไม่ render ใหม่ (กันช่องพิมพ์ชื่อถูกล้าง)
setInterval(() => {
  if (!openEventId || screenEvents.classList.contains("hidden")) return;
  const ev = eventsCache[openEventId];
  if (!ev || ev.status !== "checkin") return;
  const remaining = (ev.checkinEndsAt || 0) - serverNow();
  const cd = document.getElementById("ev-countdown");
  if (cd) cd.textContent = fmtCountdown(remaining);
  const btn = document.getElementById("ev-checkin-btn");
  if (btn && remaining <= 0) btn.disabled = true;
}, 1000);

function bindEventActions(box) {
  box.querySelectorAll("[data-ev-act]").forEach(el => el.addEventListener("click", () => handleEventAction(el.dataset.evAct, el)));
}

async function handleEventAction(act, el) {
  if (act === "back") { openEventId = null; renderEventsScreen(); return; }
  const ev = eventsCache[openEventId];
  if (!ev || !currentUser) return;
  const uid = currentUser.uid;
  const evRef = ref(db, "events/" + openEventId);
  try {
    if (act === "register") {
      const name = document.getElementById("ev-reg-name").value.trim();
      if (!name) { alert("กรุณากรอกชื่อที่จะใช้ในเกม"); return; }
      await set(child(evRef, "registrations/" + uid), { uid, name, registeredAt: serverNow(), checkedIn: false });
    } else if (act === "unregister") {
      if (!confirm("ยกเลิกการสมัครอีเวนต์นี้ใช่หรือไม่?")) return;
      await set(child(evRef, "registrations/" + uid), null);
    } else if (act === "checkin") {
      const mine = ev.registrations?.[uid];
      if (!mine) return;
      if (serverNow() > (ev.checkinEndsAt || 0)) { alert("หมดเวลาเช็คอินแล้ว"); return; }
      await set(child(evRef, "registrations/" + uid), { ...mine, checkedIn: true });
    } else if (act === "save-team") {
      const mine = ev.registrations?.[uid];
      if (!mine) return;
      const teamText = document.getElementById("ev-team-input")?.value.trim() || "";
      const teamSheet = teamSheetWithoutEvs(teamText);
      await update(child(evRef, "registrations/" + uid), { teamText: teamText || null, teamSheet: teamSheet || null });
    } else if (act === "load-saved-team") {
      const saved = builder.teams[document.getElementById("ev-saved-team")?.value];
      const ta = document.getElementById("ev-team-input");
      if (saved && ta) ta.value = exportShowdownTeam(saved.mons);
    } else if (act === "enter") {
      const pid = ev.playerMap?.[uid];
      if (!pid || !ev.roomId) return;
      await onDisconnect(ref(db, `rooms/${ev.roomId}/players/${pid}`)).remove();
      hideAllTopScreens();
      if (eventsUnsub) { eventsUnsub(); eventsUnsub = null; }
      enterLobby(ev.roomId, pid, false);
    } else if (act === "start-checkin") {
      if (!isEventHost(ev)) return;
      const minutes = parseInt(document.getElementById("ev-checkin-min").value);
      await update(evRef, { status: "checkin", checkinMinutes: minutes, checkinEndsAt: serverNow() + minutes * 60000 });
    } else if (act === "kick") {
      if (!isEventHost(ev)) return;
      if (!confirm("ลบผู้สมัครคนนี้ออกจากอีเวนต์ใช่หรือไม่?")) return;
      await set(child(evRef, "registrations/" + el.dataset.uid), null);
    } else if (act === "delete") {
      if (!isEventHost(ev) || !confirm("ลบอีเวนต์นี้ทิ้งใช่หรือไม่?")) return;
      openEventId = null;
      await set(evRef, null);
    } else if (act === "create-room") {
      await createRoomFromEvent(openEventId);
    }
  } catch (e) {
    console.error("event action error:", act, e);
    alert("ทำรายการไม่สำเร็จ (เช่น หมดเวลาเช็คอิน หรือสิทธิ์ไม่พอ) กรุณาลองใหม่");
  }
}

async function createRoomFromEvent(eventId) {
  const ev = eventsCache[eventId];
  if (!ev || !isEventHost(ev) || ev.status === "started") return;
  const cfg = ev.config;
  const checked = eventSortedRegs(ev).filter(r => r.checkedIn && r.uid !== ev.creatorUid).slice(0, ev.capacity);
  const remaining = (ev.checkinEndsAt || 0) - serverNow();
  const msg = `สร้างห้องพร้อมผู้เล่นที่เช็คอินแล้ว ${checked.length} คน${ev.status === "checkin" && remaining > 0 ? " (ยังไม่หมดเวลาเช็คอิน คนที่ยังไม่เช็คอินจะไม่ได้อยู่ในห้อง)" : ""} ใช่หรือไม่?`;
  if (!confirm(msg)) return;

  const roomId = generateRoomCode();
  const hostPid = generatePlayerId();
  const baseMoney = cfg.startMoney || 0;
  const mkPlayer = (name, userUid, isHostP, isSpectator, teamText, teamSheet) => ({
    name, userUid, money: baseMoney, isHost: isHostP, isSpectator, joinedAt: Date.now(),
    pickTicketUsed: false, banTicketUsed: false, giftCount: 0, team: [],
    teamText: teamText || null, teamSheet: teamSheet || null
  });
  const players = { [hostPid]: mkPlayer(ev.hostName, currentUser.uid, true, cfg.hostParticipation === "spectator") };
  const memberUids = { [currentUser.uid]: true };
  const playerMap = {};
  checked.forEach(r => {
    const pid = generatePlayerId();
    players[pid] = mkPlayer(r.name, r.uid, false, false, r.teamText, r.teamSheet);
    memberUids[r.uid] = true;
    playerMap[r.uid] = pid;
  });

  await set(ref(db, "rooms/" + roomId), {
    hostId: hostPid, creatorUid: currentUser.uid, creatorEmail: currentUser.email || null,
    affiliation: ev.affiliation || myAffiliation || null, status: "waiting", eventId,
    settings: cfg, players, memberUids, createdAt: Date.now()
  });
  await update(ref(db, "events/" + eventId), { status: "started", roomId, playerMap });
  onDisconnect(ref(db, `rooms/${roomId}/players/${hostPid}`)).remove();
  if (eventsUnsub) { eventsUnsub(); eventsUnsub = null; }
  hideAllTopScreens();
  enterLobby(roomId, hostPid, true);
}

// =====================================================================
// โหมดที่ 3: สุ่มตัว (Gacha)
// - ทุกคนเริ่มที่ 20P / ตู้ธรรมดา 1P / ตู้เมก้า 2P (ดึงรายชื่อจาก POKEMON_LIST เดิม)
// - แต้มที่ได้จากแมตช์ "คำนวณจากประวัติผลแข่ง" (เกมที่ชนะ + 1 ต่อแมตช์) แล้วหักด้วย pointsSpent ที่ใช้ไปแล้ว
//   จึงไม่มีทางแต้มเบิ้ล/ตกหล่นเวลาแก้ผล และใช้ได้กับทุกทางที่ผลถูกยืนยัน
// - สุ่มได้ตอนรอเริ่ม (ล็อบบี้) และช่วงรอระหว่างรอบ (ทุกคู่ยืนยันผลครบ ก่อนโฮสต์กดเริ่มรอบถัดไป)
// - สุ่ม ×5, ฟีดสด, อนิเมชันตอนสุ่ม, แลกเปลี่ยน (ยืนยันทั้งคู่ + นับถอยหลัง 10 วิ), ตัวเลือกคืนตัวที่ทิ้งเข้าตู้
// =====================================================================
const GACHA_MIN_TO_START = 6;
const GACHA_MULTI = 5;
const GACHA_TRADE_COUNTDOWN_MS = 10000;
let gachaBusy = false;
let gachaTradeBusy = false;
let gachaMachineViewOpen = false;
let gachaMachineFilter = "all"; // all | left | gone
let gachaTradeTarget = "";
let gachaTradeExecKey = "";
const gachaOpenPreviews = new Set();
const gachaStaleClosed = new Set();

function isGachaRoom(room) { return room?.settings?.mode === "gacha"; }
function isTeamSheetMode(room) { return !["auction", "gacha"].includes(room?.settings?.mode); }
// โหมดปกติเลือกได้ว่าบังคับส่ง Team Sheet หรือไม่ (ห้องเก่าที่ไม่มีค่านี้ = บังคับเหมือนเดิม)
function teamSheetRequired(room) { return isTeamSheetMode(room) && room?.settings?.teamSheetRequired !== false; }
function gachaBoxSize(room) { return Number(room?.settings?.gachaBoxSize || room?.settings?.teamSize || 6); }
function gachaAllowDup(room) { return !!room?.settings?.gachaAllowDuplicates; }
// เปิดตัวเลือก "คืนตัวที่ทิ้ง/ถูกแทนที่เข้าตู้" (มีผลเฉพาะโหมดไม่ซ้ำ)
function gachaReturnOnDrop(room) { return !!room?.settings?.gachaReturnToMachine && !gachaAllowDup(room); }
function gachaCost(room, machine) {
  return machine === "mega" ? Number(room?.settings?.gachaCostMega ?? 2) : Number(room?.settings?.gachaCostNormal ?? 1);
}
function gachaMachinePool(machine) {
  const wantMega = machine === "mega";
  return POKEMON_LIST.filter(p => !!p.isMega === wantMega);
}
function gachaAnimEnabled() { try { return localStorage.getItem("vgcLabGachaAnim") !== "off"; } catch (e) { return true; } }
function gachaSetAnim(on) { try { localStorage.setItem("vgcLabGachaAnim", on ? "on" : "off"); } catch (e) { /* ignore */ } }

function readGachaCreateSettings(mode) {
  if (mode !== "gacha") return {};
  return {
    gachaBoxSize: parseInt(document.getElementById("create-gacha-box-size").value),
    gachaAllowDuplicates: document.getElementById("create-gacha-duplicates").value === "yes",
    gachaReturnToMachine: document.getElementById("create-gacha-return").value === "yes",
    gachaStartPoints: 20,
    gachaCostNormal: 1,
    gachaCostMega: 2
  };
}
// ตั้งค่าเฉพาะโหมดที่ถูกส่งต่อเข้า settings ตอนสร้างห้อง/อีเวนต์
function readExtraCreateSettings(mode) {
  const extra = readGachaCreateSettings(mode);
  if (mode === "normal") extra.teamSheetRequired = document.getElementById("create-teamsheet-required").value !== "no";
  return extra;
}

// แต้มที่ได้จากแมตช์: แต่ละฝ่ายได้ (จำนวนเกมที่ตัวเองชนะ + 1)  เช่น 2-1 -> ผู้ชนะ 3 / ผู้แพ้ 2, BO1 1-0 -> 2 / 1
// BYE / ถอนตัว (ไม่มีสกอร์) -> ผู้ชนะได้ขั้นต่ำของผู้ชนะ (BO1 = 2, BO3 = 3) ผู้แพ้ไม่ได้
function gachaEarnedPoints(room, pid) {
  const t = room?.tournament;
  if (!t) return 0;
  const bo = parseInt(String(room.settings?.bestOf || "BO1").replace(/\D/g, ""), 10) || 1;
  const minWinPoints = Math.ceil(bo / 2) + 1;
  let total = 0;
  [...(t.phaseHistory || []), ...(t.history || [])].forEach(round => (round.matches || []).forEach(m => {
    if (!m || !m.winnerId) return;
    const isP1 = m.player1Id === pid, isP2 = m.player2Id === pid;
    if (!isP1 && !isP2) return;
    const parsed = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(String(m.score || ""));
    if (parsed && !m.isBye) total += Number(isP1 ? parsed[1] : parsed[2]) + 1;
    else if (m.winnerId === pid) total += minWinPoints;
  }));
  return total;
}
function gachaBalance(room, pid) {
  const start = Number(room?.settings?.gachaStartPoints ?? 20);
  return start + gachaEarnedPoints(room, pid) - Number(room?.players?.[pid]?.pointsSpent || 0);
}
// สุ่ม/แลกได้: ตอนรอเริ่ม หรือช่วงที่รอบล่าสุดทุกคู่ยืนยันผลครบแล้ว (ยังไม่เริ่มรอบถัดไป)
function gachaWindowOpen(room) {
  if (!room) return false;
  if (room.status === "waiting") return true;
  if (room.status !== "tournament") return false;
  const t = room.tournament;
  if (!t || t.championId) return false;
  const cur = t.history?.[t.history.length - 1];
  if (!cur) return true;
  return (cur.matches || []).every(m => m.winnerId);
}
function gachaNotReadyIds(room) {
  return competitivePlayerIds(room).filter(pid => {
    const p = room.players[pid];
    return (p.team?.length || 0) < GACHA_MIN_TO_START || !!p.pendingPull;
  });
}
function gachaTradeOf(room, pid) {
  for (const [id, t] of Object.entries(room?.gachaTrades || {})) {
    if (t && (t.a === pid || t.b === pid)) return { ...t, id };
  }
  return null;
}
function gachaCanPull(room, pid, machine, count = 1) {
  if (!isGachaRoom(room)) return { ok: false, reason: "ห้องนี้ไม่ใช่โหมดสุ่มตัว" };
  const me = room.players?.[pid];
  if (!me || me.isSpectator) return { ok: false, reason: "ผู้ชม/ผู้สังเกตการณ์สุ่มตัวไม่ได้" };
  if (me.withdrawn) return { ok: false, reason: "คุณถอนตัวจากการแข่งขันแล้ว" };
  if (!gachaWindowOpen(room)) return { ok: false, reason: "สุ่มได้เฉพาะตอนรอเริ่ม หรือช่วงรอระหว่างรอบ (หลังทุกคู่ยืนยันผลครบ และก่อนโฮสต์กดเริ่มรอบถัดไป)" };
  if (me.pendingPull) return { ok: false, reason: "มีตัวที่สุ่มได้ค้างอยู่ กรุณาเลือกทิ้งหรือแทนที่ก่อน" };
  const trade = gachaTradeOf(room, pid);
  if (trade && trade.aOk && trade.bOk) return { ok: false, reason: "กำลังนับถอยหลังแลกเปลี่ยนอยู่ กดยกเลิกการยืนยันก่อนถ้าต้องการสุ่ม" };
  const cost = gachaCost(room, machine) * count;
  if (gachaBalance(room, pid) < cost) return { ok: false, reason: `แต้มไม่พอ (ต้องใช้ ${cost}P)` };
  return { ok: true };
}
function gachaPushFeed(room, entry) {
  const feed = Array.isArray(room.gachaFeed) ? room.gachaFeed : Object.values(room.gachaFeed || {});
  feed.push(entry);
  room.gachaFeed = feed.slice(-30);
}

function renderGachaPanels(room) {
  if (!room) return;
  renderGachaPanel(room, document.getElementById("lobby-gacha-panel"), { showAllBoxes: true });
  renderGachaPanel(room, document.getElementById("tournament-gacha-panel"), {});
}

// ---------- อนิเมชันตอนสุ่ม ----------
function playGachaReveal(machine, items) {
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!gachaAnimEnabled() || reduce || !items?.length) return Promise.resolve();
  return new Promise(resolve => {
    items.forEach(it => { if (it.sprite) { const img = new Image(); img.src = it.sprite; } });
    const overlay = document.createElement("div");
    overlay.className = `gacha-overlay ${machine}`;
    overlay.innerHTML = '<div class="gacha-stage"></div><button type="button" class="gacha-skip">ข้าม ⏭</button>';
    document.body.appendChild(overlay);
    const stage = overlay.querySelector(".gacha-stage");
    const skipBtn = overlay.querySelector(".gacha-skip");
    const waiters = [];
    let skipped = false, closed = false, summaryShown = false;
    const wait = ms => new Promise(res => { const id = setTimeout(res, ms); waiters.push({ id, res }); });
    const flushWaiters = () => waiters.splice(0).forEach(w => { clearTimeout(w.id); w.res(); });
    const finish = () => {
      if (closed) return;
      closed = true;
      flushWaiters();
      overlay.classList.add("closing");
      setTimeout(() => { overlay.remove(); resolve(); }, 220);
    };
    const monCard = (it, cls = "") => `<div class="gacha-card${it.isMega ? " is-mega" : ""} ${cls}"><img src="${escapeHtml(it.sprite || teamSheetSprite(it.displayName))}" alt="${escapeHtml(it.displayName)}" onerror="this.style.visibility='hidden'"><b>${escapeHtml(it.displayName)}</b>${monTypesHtml(it)}${it.isMega ? "<em>✨ MEGA!</em>" : ""}${it.status === "pending" ? "<small>กล่องเต็ม — รอคุณตัดสินใจ</small>" : ""}</div>`;
    const showSummary = () => {
      if (closed || summaryShown) return;
      summaryShown = true;
      skipBtn.remove();
      stage.innerHTML = `<div class="gacha-summary">${items.map(it => monCard(it, "small")).join("")}</div><button type="button" class="gacha-done primary">ตกลง</button>`;
      stage.querySelector(".gacha-done").onclick = finish;
    };
    skipBtn.onclick = () => {
      skipped = true;
      flushWaiters();
      if (items.length > 1) showSummary(); else finish();
    };
    (async () => {
      for (let i = 0; i < items.length && !skipped && !closed; i++) {
        const it = items[i];
        stage.innerHTML = `<div class="gacha-capsule ${machine}"><span></span></div>${items.length > 1 ? `<p class="gacha-count">${i + 1}/${items.length}</p>` : ""}`;
        await wait(1100);
        if (skipped || closed) break;
        stage.innerHTML = '<div class="gacha-burst"></div>';
        await wait(260);
        if (skipped || closed) break;
        stage.innerHTML = monCard(it) + (items.length > 1 ? `<p class="gacha-count">${i + 1}/${items.length}</p>` : "");
        await wait(items.length > 1 ? 850 : 1500);
      }
      if (skipped || closed) return;
      if (items.length > 1) showSummary(); else finish();
    })();
  });
}

// ---------- สุ่ม ----------
// สุ่ม 1 หรือหลายครั้ง: ฝั่งเครื่องสุ่มเลือกตัวก่อน แล้วให้ธุรกรรมตรวจ/ตัดแต้ม/ใส่กล่องแบบอะตอมมิก
// (ถ้าไม่ให้ซ้ำแล้วมีคนชิงสุ่มตัวเดียวกันไปก่อน จะสุ่มใหม่ให้อัตโนมัติ) ถ้ากล่องเต็มกลางทาง
// จะหยุดที่ตัวที่ล้น (รอตัดสินใจ) และไม่ตัดแต้มของครั้งที่เหลือ
async function gachaPull(machine, count = 1) {
  if (gachaBusy || !currentRoomId || !currentPlayerId) return;
  gachaBusy = true;
  renderGachaPanels(latestRoom);
  try {
    let revealItems = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const room = (await get(ref(db, "rooms/" + currentRoomId))).val();
      if (!room) return;
      const check = gachaCanPull(room, currentPlayerId, machine, count);
      if (!check.ok) { alert(check.reason); return; }
      const allowDup = gachaAllowDup(room);
      const pool = gachaMachinePool(machine).filter(p => allowDup || !room.gachaTaken?.[poolKeyOf(p)]);
      if (!pool.length) { alert("ตู้นี้ไม่มีโปเกม่อนเหลือแล้ว"); return; }
      const bag = [...pool], picks = [];
      for (let i = 0; i < count && bag.length; i++) {
        const idx = Math.floor(Math.random() * bag.length);
        picks.push(bag[idx]);
        if (!allowDup) bag.splice(idx, 1);
      }
      const sprites = await Promise.all(picks.map(p => fetchSprite(p)));
      let outcome = { ok: false, reason: "สุ่มไม่สำเร็จ" };
      await updateRoom((r) => {
        const chk = gachaCanPull(r, currentPlayerId, machine, 1);
        if (!chk.ok) { outcome = chk; return; }
        const me = r.players[currentPlayerId];
        const cost = gachaCost(r, machine);
        const items = [];
        for (let i = 0; i < picks.length; i++) {
          if (gachaBalance(r, currentPlayerId) < cost) break;
          const pick = picks[i], key = poolKeyOf(pick);
          if (!gachaAllowDup(r) && r.gachaTaken?.[key]) { outcome = { ok: false, retry: true, reason: "taken" }; return; }
          me.pointsSpent = Number(me.pointsSpent || 0) + cost;
          if (!gachaAllowDup(r)) { r.gachaTaken = r.gachaTaken || {}; r.gachaTaken[key] = true; }
          const mon = { id: key, displayName: pick.displayName, isMega: !!pick.isMega, sprite: sprites[i] || "", machine, viaGacha: true };
          const team = me.team || [];
          let status;
          if (team.length < gachaBoxSize(r)) { team.push(mon); me.team = team; status = "added"; }
          else { me.pendingPull = mon; status = "pending"; }
          me.lastPull = { ...mon, status, at: Date.now() };
          gachaPushFeed(r, { kind: "pull", name: me.name || "ผู้เล่น", mon: mon.displayName, isMega: mon.isMega, machine, at: Date.now() });
          items.push({ id: key, displayName: mon.displayName, isMega: mon.isMega, sprite: mon.sprite, machine, status });
          if (status === "pending") break;
        }
        if (!items.length) { outcome = { ok: false, reason: "แต้มไม่พอ" }; return; }
        outcome = { ok: true, items };
        return r;
      });
      if (outcome.ok) { revealItems = outcome.items; break; }
      if (!outcome.retry) { alert(outcome.reason); return; }
    }
    if (!revealItems) { alert("สุ่มไม่สำเร็จ (มีคนสุ่มชนกันหลายครั้ง) กรุณาลองใหม่"); return; }
    await playGachaReveal(machine, revealItems);
  } catch (error) {
    console.error("gacha pull failed:", error);
    alert("สุ่มไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
  } finally {
    gachaBusy = false;
    renderGachaPanels(latestRoom);
  }
}

// กล่องเต็ม: ทิ้งตัวใหม่ หรือแทนที่ตัวในกล่อง (ปกติตัวที่ถูกแทนที่/ถูกทิ้งหายไปถาวร
// แต่ถ้าห้องเปิดตัวเลือก "คืนเข้าตู้" และเป็นโหมดไม่ซ้ำ ตัวนั้นจะกลับไปให้สุ่มได้อีก)
async function gachaResolvePending(action, index) {
  if (gachaBusy || !currentRoomId) return;
  gachaBusy = true;
  try {
    await updateRoom((r) => {
      const me = r.players?.[currentPlayerId];
      if (!me || !me.pendingPull) return;
      const { machine, ...rest } = me.pendingPull;
      const base = me.lastPull ? { ...me.lastPull } : { ...me.pendingPull };
      if (action === "replace") {
        const team = me.team || [];
        const old = team[index];
        if (!old) return;
        team[index] = { ...rest, machine: machine || "normal" };
        me.team = team;
        me.lastPull = { ...base, status: "replaced", replacedName: old.displayName || "" };
        if (gachaReturnOnDrop(r) && old.id && r.gachaTaken) delete r.gachaTaken[old.id];
      } else {
        me.lastPull = { ...base, status: "discarded" };
        if (gachaReturnOnDrop(r) && rest.id && r.gachaTaken) delete r.gachaTaken[rest.id];
      }
      me.pendingPull = null;
      return r;
    });
  } catch (error) {
    console.error("gacha resolve failed:", error);
    alert("บันทึกไม่สำเร็จ กรุณาลองใหม่");
  } finally {
    gachaBusy = false;
    renderGachaPanels(latestRoom);
  }
}

// ---------- แลกเปลี่ยน ----------
// ขั้นตอน: ชวนแลก -> ต่างฝ่ายเลือกตัวของตัวเอง -> ทั้งคู่กดยืนยัน -> นับถอยหลัง 10 วิ -> สลับตัวให้อัตโนมัติ
// ถ้ามีใครเปลี่ยนตัวที่เสนอ การยืนยันของทั้งคู่จะรีเซ็ต / ระหว่างนับถอยหลังกดยกเลิกแล้วเลือกใหม่ได้
function gachaTradeValid(r, t) {
  const A = r.players?.[t.a], B = r.players?.[t.b];
  return !!(A && B && !A.pendingPull && !B.pendingPull && !A.withdrawn && !B.withdrawn
    && t.aIdx >= 0 && t.bIdx >= 0
    && A.team?.[t.aIdx]?.id === t.aMonId && B.team?.[t.bIdx]?.id === t.bMonId);
}
async function gachaTradeOpen(targetPid) {
  if (gachaTradeBusy || !targetPid || !currentRoomId) return;
  gachaTradeBusy = true;
  try {
    let result = { ok: false, reason: "เริ่มการแลกไม่สำเร็จ" };
    await updateRoom((r) => {
      if (!isGachaRoom(r) || !gachaWindowOpen(r)) { result = { ok: false, reason: "แลกเปลี่ยนได้เฉพาะตอนรอเริ่ม หรือช่วงรอระหว่างรอบ" }; return; }
      if (targetPid === currentPlayerId) return;
      for (const pid of [currentPlayerId, targetPid]) {
        const p = r.players?.[pid];
        if (!p || p.isSpectator || p.withdrawn) { result = { ok: false, reason: "ผู้เล่นคนนี้แลกเปลี่ยนไม่ได้" }; return; }
        if (p.pendingPull) { result = { ok: false, reason: "ต้องตัดสินใจกับตัวที่สุ่มได้ค้างอยู่ก่อน (ทั้งสองฝ่าย)" }; return; }
        if (gachaTradeOf(r, pid)) { result = { ok: false, reason: "คุณหรืออีกฝ่ายกำลังแลกกับคนอื่นอยู่" }; return; }
      }
      r.gachaTrades = r.gachaTrades || {};
      r.gachaTrades[generatePlayerId()] = { a: currentPlayerId, b: targetPid, aIdx: -1, bIdx: -1, aMonId: "", bMonId: "", aOk: false, bOk: false, endsAt: 0, createdAt: Date.now() };
      result = { ok: true };
      return r;
    });
    if (!result.ok) alert(result.reason);
  } catch (error) {
    console.error("trade open failed:", error);
    alert("เริ่มการแลกไม่สำเร็จ กรุณาลองใหม่");
  } finally {
    gachaTradeBusy = false;
    renderGachaPanels(latestRoom);
  }
}
async function gachaTradeUpdate(tradeId, fn) {
  if (gachaTradeBusy || !currentRoomId) return;
  gachaTradeBusy = true;
  try {
    await updateRoom((r) => {
      const t = r.gachaTrades?.[tradeId];
      if (!t || !isGachaRoom(r)) return;
      const side = t.a === currentPlayerId ? "a" : t.b === currentPlayerId ? "b" : "";
      if (!side) return;
      if (fn(r, t, side) === false) return;
      return r;
    });
  } catch (error) {
    console.error("trade update failed:", error);
    alert("ทำรายการไม่สำเร็จ กรุณาลองใหม่");
  } finally {
    gachaTradeBusy = false;
    renderGachaPanels(latestRoom);
  }
}
function gachaTradeAct(kind, idx) {
  const trade = gachaTradeOf(latestRoom, currentPlayerId);
  if (!trade) return;
  const id = trade.id;
  if (kind === "offer") {
    gachaTradeUpdate(id, (r, t, side) => {
      const p = r.players[currentPlayerId];
      const mon = p?.team?.[idx];
      if (!gachaWindowOpen(r) || !mon || p.pendingPull) return false;
      t[side + "Idx"] = idx; t[side + "MonId"] = mon.id;
      t.aOk = false; t.bOk = false; t.endsAt = 0;   // เปลี่ยนตัวเสนอ -> ล้างการยืนยันทั้งคู่
    });
  } else if (kind === "confirm") {
    gachaTradeUpdate(id, (r, t, side) => {
      if (!gachaWindowOpen(r) || !gachaTradeValid(r, t)) return false;
      t[side + "Ok"] = true;
      if (t.aOk && t.bOk) t.endsAt = serverNow() + GACHA_TRADE_COUNTDOWN_MS;
    });
  } else if (kind === "unconfirm") {
    gachaTradeUpdate(id, (r, t) => { t.aOk = false; t.bOk = false; t.endsAt = 0; });
  } else if (kind === "close") {
    gachaTradeUpdate(id, (r) => { delete r.gachaTrades[id]; });
  }
}
async function gachaTradeExecute(tradeId) {
  await updateRoom((r) => {
    const t = r.gachaTrades?.[tradeId];
    if (!t) return;
    if (!gachaWindowOpen(r) || !gachaTradeValid(r, t)) { delete r.gachaTrades[tradeId]; return r; }  // เงื่อนไขพัง -> ยกเลิกแลก
    if (!t.aOk || !t.bOk || !t.endsAt || serverNow() < t.endsAt) return;                               // ยังไม่ถึงเวลา/ยังไม่ครบยืนยัน
    const A = r.players[t.a], B = r.players[t.b];
    const monA = A.team[t.aIdx], monB = B.team[t.bIdx];
    A.team[t.aIdx] = monB;
    B.team[t.bIdx] = monA;
    gachaPushFeed(r, { kind: "trade", name: A.name || "ผู้เล่น", other: B.name || "ผู้เล่น", give: monA.displayName, get: monB.displayName, at: Date.now() });
    delete r.gachaTrades[tradeId];
    return r;
  });
}
// ทุกเครื่องในห้องเช็คทุกวินาที: อัปเดตตัวนับถอยหลัง / สั่งสลับตัวเมื่อครบเวลา / เก็บกวาดการแลกที่ค้างหลังเริ่มรอบ
setInterval(() => {
  const room = latestRoom;
  if (!room || !isGachaRoom(room) || !currentPlayerId) return;
  const t = gachaTradeOf(room, currentPlayerId);
  if (!t) return;
  if (!gachaWindowOpen(room)) {
    if (!gachaStaleClosed.has(t.id)) {
      gachaStaleClosed.add(t.id);
      gachaTradeExecute(t.id).catch(e => console.error("trade cleanup failed:", e));
    }
    return;
  }
  if (!(t.aOk && t.bOk && t.endsAt)) return;
  const left = t.endsAt - serverNow();
  document.querySelectorAll("[data-gacha-trade-count]").forEach(el => { el.textContent = Math.max(0, Math.ceil(left / 1000)); });
  const key = t.id + ":" + t.endsAt;
  if (left <= 0 && gachaTradeExecKey !== key) {
    gachaTradeExecKey = key;
    gachaTradeExecute(t.id).catch(e => { console.error("trade execute failed:", e); gachaTradeExecKey = ""; });
  }
}, 1000);

// ---------- ส่วนแสดงผล ----------
function gachaMonCard(mon, label) {
  const sprite = mon.sprite || teamSheetSprite(mon.displayName);
  const dataAttr = mon.sprite ? "" : ` data-poke-name="${escapeHtml(mon.displayName)}"`;
  const tag = label ?? (mon.machine === "mega" ? "✨ ตู้เมก้า" : mon.machine ? "🎰 ตู้ธรรมดา" : "");
  return `<img src="${escapeHtml(sprite)}"${dataAttr} alt="${escapeHtml(mon.displayName)}" onerror="this.style.visibility='hidden'"><b>${escapeHtml(mon.displayName)}</b>${monTypesHtml(mon)}${tag ? `<small>${tag}</small>` : ""}`;
}

function gachaMachineViewHtml(room) {
  const allowDup = gachaAllowDup(room), taken = room.gachaTaken || {};
  const f = gachaMachineFilter;
  const section = (machine, title) => {
    const pool = gachaMachinePool(machine);
    const isGone = p => !allowDup && !!taken[poolKeyOf(p)];
    const goneCount = pool.filter(isGone).length;
    const chips = pool
      .filter(p => f === "all" || (f === "left" ? !isGone(p) : isGone(p)))
      .map(p => `<span class="gacha-chip${isGone(p) ? " gone" : ""}">${escapeHtml(p.displayName)}</span>`).join("")
      || '<span class="small-text">ไม่มีรายการ</span>';
    return `<div class="gacha-machine-section"><h4>${title} <small>เหลือ ${pool.length - goneCount}/${pool.length}</small></h4><div class="gacha-chips">${chips}</div></div>`;
  };
  const filterBtn = (key, label) => `<button type="button" class="gacha-filter${f === key ? " active" : ""}" data-gacha-act="filter" data-filter="${key}">${label}</button>`;
  const note = allowDup
    ? "🔁 โหมดนี้สุ่มซ้ำได้ ตู้จึงไม่หมด (รายการด้านล่างคือโปเกม่อนทั้งหมดในแต่ละตู้)"
    : gachaReturnOnDrop(room)
      ? "🚫 ไม่ให้ซ้ำ: ตัวที่ถูกสุ่มไปแล้วจะหายจากตู้ แต่ถ้าถูกทิ้ง/ถูกแทนที่จะกลับเข้าตู้ให้สุ่มใหม่ได้"
      : "🚫 ไม่ให้ซ้ำ: ตัวที่ถูกสุ่มไปแล้ว (รวมตัวที่ถูกทิ้ง/ถูกแทนที่) จะหายจากตู้ถาวร";
  return `<div class="gacha-machine-view">
    <p class="small-text">${note}</p>
    <div class="gacha-filters">${filterBtn("all", "ทั้งหมด")}${filterBtn("left", "ยังอยู่")}${filterBtn("gone", "หายไปแล้ว")}</div>
    ${section("normal", "🎰 ตู้ร่างธรรมดา")}${section("mega", "✨ ตู้เมก้า")}
  </div>`;
}

function gachaFeedHtml(room) {
  const feed = Array.isArray(room.gachaFeed) ? room.gachaFeed : Object.values(room.gachaFeed || {});
  if (!feed.length) return "";
  const items = feed.slice(-10).reverse().map(f => f.kind === "trade"
    ? `<li>🔄 <b>${escapeHtml(f.name)}</b> แลก <b>${escapeHtml(f.give)}</b> กับ <b>${escapeHtml(f.other)}</b> ได้ <b>${escapeHtml(f.get)}</b></li>`
    : `<li class="${f.isMega ? "mega" : ""}">${f.machine === "mega" ? "✨" : "🎰"} <b>${escapeHtml(f.name)}</b> สุ่มได้ <b>${escapeHtml(f.mon)}</b>${f.isMega ? " 🌟" : ""}</li>`).join("");
  return `<div class="gacha-feed"><h4>📜 ฟีดการสุ่ม/แลกล่าสุด</h4><ul>${items}</ul></div>`;
}

function gachaTradeHtml(room, me, trade, open, pending) {
  if (!trade) {
    if (!open) return "";
    const others = competitivePlayerIds(room).filter(pid => pid !== currentPlayerId && !room.players[pid].withdrawn);
    const opts = others.map(pid => `<option value="${escapeHtml(pid)}"${pid === gachaTradeTarget ? " selected" : ""}>${escapeHtml(room.players[pid].name)}</option>`).join("");
    return `<div class="gacha-trade"><h4>🔄 แลกเปลี่ยนโปเกม่อน</h4>${others.length
      ? `<div class="gacha-trade-start"><select id="gacha-trade-target">${opts}</select><button type="button" data-gacha-act="trade-open" ${pending ? "disabled" : ""}>ชวนแลก</button></div>`
      : '<p class="small-text">ยังไม่มีผู้เล่นคนอื่นให้แลก</p>'}<p class="small-text">เลือกตัวที่จะแลก → ทั้งคู่กดยืนยัน → นับถอยหลัง 10 วินาที (ยกเลิกแล้วเลือกใหม่ได้)</p></div>`;
  }
  const side = trade.a === currentPlayerId ? "a" : "b", otherSide = side === "a" ? "b" : "a";
  const other = room.players[trade[otherSide]];
  const myIdx = trade[side + "Idx"], theirIdx = trade[otherSide + "Idx"];
  const myMon = myIdx >= 0 ? me.team?.[myIdx] : null, theirMon = theirIdx >= 0 ? other?.team?.[theirIdx] : null;
  const myOk = !!trade[side + "Ok"], theirOk = !!trade[otherSide + "Ok"];
  const counting = myOk && theirOk && trade.endsAt;
  const left = counting ? Math.max(0, Math.ceil((trade.endsAt - serverNow()) / 1000)) : 0;
  const card = mon => mon ? `<div class="gacha-mon${mon.isMega ? " is-mega" : ""}">${gachaMonCard(mon, "")}</div>` : "";
  let actions;
  if (counting) actions = `<p class="gacha-countdown">⏱ จะสลับตัวอัตโนมัติใน <b data-gacha-trade-count>${left}</b> วินาที</p><button type="button" class="btn-danger" data-gacha-act="trade-unconfirm">❌ ยกเลิกการยืนยัน (เลือกใหม่)</button>`;
  else if (myOk) actions = `<p class="small-text">⏳ รอ ${escapeHtml(other?.name || "อีกฝ่าย")} กดยืนยัน</p><button type="button" data-gacha-act="trade-unconfirm">↩ ยกเลิกการยืนยัน</button>`;
  else actions = `<button type="button" class="primary" data-gacha-act="trade-confirm" ${myMon && theirMon && !pending ? "" : "disabled"}>✅ ยืนยันการแลก</button><p class="small-text">ตรวจตัวของอีกฝ่ายให้ดีก่อนกดยืนยัน — ถ้ามีใครเปลี่ยนตัวที่เสนอ การยืนยันของทั้งคู่จะรีเซ็ตทันที</p>`;
  return `<div class="gacha-trade active"><h4>🔄 แลกเปลี่ยนกับ ${escapeHtml(other?.name || "ผู้เล่น")}</h4>
    <div class="gacha-trade-sides">
      <div class="gacha-trade-side"><span>คุณเสนอ ${myOk ? "✅" : "⏳"}</span>${myMon ? card(myMon) : '<p class="small-text">กดเลือกตัวใน Box ด้านล่าง</p>'}</div>
      <div class="gacha-trade-arrow">⇄</div>
      <div class="gacha-trade-side"><span>${escapeHtml(other?.name || "อีกฝ่าย")} เสนอ ${theirOk ? "✅" : "⏳"}</span>${theirMon ? card(theirMon) : '<p class="small-text">รออีกฝ่ายเลือก...</p>'}</div>
    </div>${actions}
    <button type="button" class="gacha-trade-close" data-gacha-act="trade-close">🚪 ปิดการแลก</button></div>`;
}

function renderGachaPanel(room, el, opts = {}) {
  if (!el) return;
  if (!isGachaRoom(room)) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  el.classList.remove("hidden");
  const me = room.players?.[currentPlayerId];
  const isPlayer = !!me && !me.isSpectator;
  const boxSize = gachaBoxSize(room), allowDup = gachaAllowDup(room);
  const team = me?.team || [];
  const pending = me?.pendingPull || null;
  const open = gachaWindowOpen(room);
  const balance = isPlayer ? gachaBalance(room, currentPlayerId) : 0;
  const costN = gachaCost(room, "normal"), costM = gachaCost(room, "mega");
  const taken = room.gachaTaken || {};
  const leftOf = machine => gachaMachinePool(machine).filter(p => !taken[poolKeyOf(p)]).length;
  const trade = isPlayer ? gachaTradeOf(room, currentPlayerId) : null;
  const tradeSide = trade ? (trade.a === currentPlayerId ? "a" : "b") : "";
  const tradeMyIdx = trade ? trade[tradeSide + "Idx"] : -1;
  const tradeMyOk = trade ? !!trade[tradeSide + "Ok"] : false;
  const tradeCounting = !!(trade && trade.aOk && trade.bOk);

  const machineBtn = (machine, label, cost, count) => {
    const left = allowDup ? 99 : leftOf(machine);
    const disabled = !isPlayer || !open || !!pending || tradeCounting || balance < cost * count || gachaBusy || left < 1;
    const sub = count === 1 && !allowDup ? `<small>เหลือ ${left}</small>` : "";
    return `<button type="button" class="gacha-machine-btn ${machine}${count > 1 ? " multi" : ""}" data-gacha-act="pull" data-machine="${machine}" data-count="${count}" ${disabled ? "disabled" : ""}><span>${count > 1 ? `×${count}` : label}</span><b>${cost * count}P</b>${sub}</button>`;
  };

  let status;
  if (!isPlayer) status = "👀 คุณอยู่ในโหมดดูอย่างเดียว (ดูตู้ ฟีด และ Box ของผู้เล่นได้)";
  else if (pending) status = "⚠️ กล่องเต็ม — เลือกทิ้งตัวใหม่ หรือกดตัวในกล่องเพื่อแทนที่";
  else if (!open) status = "🔒 ล็อกระหว่างแข่ง — สุ่ม/แลกได้ตอนทุกคู่ยืนยันผลครบ และก่อนโฮสต์กดเริ่มรอบถัดไป";
  else if (balance < Math.min(costN, costM)) status = "💸 แต้มไม่พอสุ่ม (ชนะแมตช์เพื่อรับแต้มเพิ่ม)";
  else status = "🟢 สุ่มได้ตอนนี้";

  const dupRule = allowDup ? "สุ่มซ้ำได้" : gachaReturnOnDrop(room) ? "ไม่ซ้ำ (ตัวที่ทิ้ง/ถูกแทนที่กลับเข้าตู้)" : "ไม่ซ้ำ (ตัวที่สุ่มแล้วหายจากตู้)";
  let html = `<div class="gacha-head"><h3>🎰 ตู้สุ่มโปเกม่อน</h3>${isPlayer ? `<span class="gacha-points">💰 ${balance}P</span>` : ""}</div>
    <p class="small-text">คนละ ${Number(room.settings?.gachaStartPoints ?? 20)}P • ตู้ธรรมดา ${costN}P • ตู้เมก้า ${costM}P • ${dupRule} • Box ${boxSize} ช่อง • ต้องมีอย่างน้อย ${GACHA_MIN_TO_START} ตัวถึงเริ่มได้</p>
    <p class="gacha-status">${status}</p>`;

  if (isPlayer) {
    html += `<div class="gacha-machines">
      <div class="gacha-machine">${machineBtn("normal", "🎰 ตู้ร่างธรรมดา", costN, 1)}${machineBtn("normal", "", costN, GACHA_MULTI)}</div>
      <div class="gacha-machine">${machineBtn("mega", "✨ ตู้เมก้า", costM, 1)}${machineBtn("mega", "", costM, GACHA_MULTI)}</div>
    </div>
    <label class="gacha-anim-toggle"><input type="checkbox" data-gacha-act="anim-toggle" ${gachaAnimEnabled() ? "checked" : ""}> เปิดอนิเมชันตอนสุ่ม</label>`;
    const lp = me.lastPull;
    if (lp) {
      const text = lp.status === "added" ? "ได้เข้า Box แล้ว"
        : lp.status === "pending" ? "รอคุณตัดสินใจ (กล่องเต็ม)"
        : lp.status === "replaced" ? `แทนที่ ${escapeHtml(lp.replacedName || "ตัวเดิม")} แล้ว`
        : "ทิ้งไปแล้ว";
      html += `<div class="gacha-last"><span class="gacha-last-title">ครั้งล่าสุด • ${text}</span><div class="gacha-mon${lp.isMega ? " is-mega" : ""}">${gachaMonCard(lp)}</div></div>`;
    }
    if (pending) {
      html += `<div class="gacha-pending"><b>📦 กล่องเต็ม! เพิ่งสุ่มได้</b><div class="gacha-mon is-new${pending.isMega ? " is-mega" : ""}">${gachaMonCard(pending)}</div>
        <button type="button" class="btn-danger gacha-discard" data-gacha-act="discard">🗑 ทิ้งตัวใหม่</button>
        <p class="small-text">หรือกดที่ตัวใน Box ด้านล่างเพื่อ "แทนที่" (${gachaReturnOnDrop(room) ? "ตัวที่ถูกแทนที่จะกลับเข้าตู้" : "ตัวที่ถูกแทนที่จะหายไปถาวร"})</p></div>`;
    }
    const slots = [];
    for (let i = 0; i < boxSize; i++) {
      const mon = team[i];
      const mega = mon?.isMega ? " is-mega" : "";
      if (!mon) slots.push('<div class="gacha-empty-slot">ว่าง</div>');
      else if (pending) slots.push(`<button type="button" class="gacha-mon replaceable${mega}" data-gacha-act="replace" data-idx="${i}">${gachaMonCard(mon, "↔ แทนที่ตัวนี้")}</button>`);
      else if (trade && !tradeMyOk) slots.push(`<button type="button" class="gacha-mon tradeable${mega}${i === tradeMyIdx ? " offered" : ""}" data-gacha-act="trade-offer" data-idx="${i}">${gachaMonCard(mon, i === tradeMyIdx ? "✅ ตัวที่เสนอ" : "🔄 เสนอตัวนี้")}</button>`);
      else slots.push(`<div class="gacha-mon${mega}${trade && i === tradeMyIdx ? " offered" : ""}">${gachaMonCard(mon, trade && i === tradeMyIdx ? "✅ ตัวที่เสนอ" : undefined)}</div>`);
    }
    html += `<h4 class="gacha-box-title">📦 Box ของคุณ (${team.length}/${boxSize})</h4><div class="gacha-box-grid">${slots.join("")}</div>`;
    html += gachaTradeHtml(room, me, trade, open, pending);
  }

  html += `<button type="button" class="gacha-view-toggle" data-gacha-act="toggle-machines">${gachaMachineViewOpen ? "🙈 ซ่อนตู้" : "📖 ดูตู้ (โปเกม่อนที่ยังอยู่/หายไปแล้ว)"}</button>`;
  if (gachaMachineViewOpen) html += gachaMachineViewHtml(room);
  html += gachaFeedHtml(room);

  if (opts.showAllBoxes) {
    const rows = competitivePlayerIds(room).map(pid => {
      const p = room.players[pid], n = (p.team || []).length;
      return `<div class="gacha-player-row"><span>${escapeHtml(p.name)}${pid === room.hostId ? ' <span class="badge">HOST</span>' : ""} <small>📦 ${n}/${boxSize}</small></span>${n ? teamPreviewHtml(p, "gacha-" + pid) : ""}</div>`;
    }).join("");
    html += `<div class="gacha-all-boxes"><h4>👥 Box ของผู้เล่นทุกคน</h4>${rows || '<p class="small-text">ยังไม่มีผู้เล่น</p>'}</div>`;
  }

  el.innerHTML = html;
  gachaOpenPreviews.forEach(key => el.querySelector(`[id="team-preview-${key}"]`)?.classList.remove("hidden"));

  el.onchange = (event) => {
    if (event.target?.id === "gacha-trade-target") gachaTradeTarget = event.target.value;
  };
  el.onclick = (event) => {
    const target = event.target.closest("[data-gacha-act],[data-team-toggle]");
    if (!target || target.disabled) return;
    const live = latestRoom;
    if (target.dataset.teamToggle) {
      const key = target.dataset.teamToggle;
      const preview = el.querySelector(`[id="team-preview-${key}"]`);
      if (!preview) return;
      preview.classList.toggle("hidden");
      if (preview.classList.contains("hidden")) gachaOpenPreviews.delete(key); else gachaOpenPreviews.add(key);
      return;
    }
    const act = target.dataset.gachaAct;
    if (act === "pull") gachaPull(target.dataset.machine, Number(target.dataset.count || 1));
    else if (act === "discard") {
      if (confirm(gachaReturnOnDrop(live) ? "ทิ้งตัวที่เพิ่งสุ่มได้ใช่หรือไม่? ตัวนี้จะกลับเข้าตู้" : "ทิ้งตัวที่เพิ่งสุ่มได้ใช่หรือไม่? ตัวนี้จะหายไปจากตู้ถาวร")) gachaResolvePending("discard");
    } else if (act === "replace") {
      const idx = Number(target.dataset.idx);
      const mine = live?.players?.[currentPlayerId];
      const oldName = mine?.team?.[idx]?.displayName || "ตัวนี้";
      const newName = mine?.pendingPull?.displayName || "ตัวใหม่";
      if (confirm(`แทนที่ ${oldName} ด้วย ${newName} ใช่หรือไม่? ${oldName} จะ${gachaReturnOnDrop(live) ? "กลับเข้าตู้" : "หายไปถาวร"}`)) gachaResolvePending("replace", idx);
    } else if (act === "toggle-machines") { gachaMachineViewOpen = !gachaMachineViewOpen; renderGachaPanels(live); }
    else if (act === "filter") { gachaMachineFilter = target.dataset.filter || "all"; renderGachaPanels(live); }
    else if (act === "anim-toggle") gachaSetAnim(!!target.checked);
    else if (act === "trade-open") {
      const sel = el.querySelector("#gacha-trade-target");
      if (sel?.value) { gachaTradeTarget = sel.value; gachaTradeOpen(sel.value); }
    }
    else if (act === "trade-offer") gachaTradeAct("offer", Number(target.dataset.idx));
    else if (act === "trade-confirm") gachaTradeAct("confirm");
    else if (act === "trade-unconfirm") gachaTradeAct("unconfirm");
    else if (act === "trade-close") gachaTradeAct("close");
  };
}

// =====================================================================
// Team Builder + การ์ดชีททีม (สไตล์ VGCode)
// - ข้อมูลอ้างอิงดึงอัตโนมัติจาก Pokémon Showdown (pokedex / moves / items / abilities)
// - สร้างทีมเอง หรือวางโค้ดจาก Showdown ได้ / เก็บได้คนละ 3 ทีม (ต้องล็อกอิน) ที่ userTeams/{uid}
// - การ์ดเดียวกันถูกใช้ตอนดูชีทระหว่างแข่ง (ไม่โชว์ตัวเลข EV แสดงเฉพาะสีของนิสัย)
// =====================================================================
const SHOWDOWN_DATA_URL = "https://play.pokemonshowdown.com/data/";
const SHEET_STATS = ["hp", "atk", "def", "spa", "spd", "spe"];
const SHEET_STAT_LABELS = { hp: "HP", atk: "Atk", def: "Def", spa: "SpA", spd: "SpD", spe: "Spe" };
// นิสัย -> [สเตตัสที่เพิ่ม, สเตตัสที่ลด] (null = นิสัยกลาง)
const SHEET_NATURES = {
  adamant: ["atk", "spa"], bashful: null, bold: ["def", "atk"], brave: ["atk", "spe"], calm: ["spd", "atk"],
  careful: ["spd", "spa"], docile: null, gentle: ["spd", "def"], hardy: null, hasty: ["spe", "def"],
  impish: ["def", "spa"], jolly: ["spe", "spa"], lax: ["def", "spd"], lonely: ["atk", "def"], mild: ["spa", "def"],
  modest: ["spa", "atk"], naive: ["spe", "spd"], naughty: ["atk", "spd"], quiet: ["spa", "spe"], quirky: null,
  rash: ["spa", "spd"], relaxed: ["def", "spe"], sassy: ["spd", "spe"], serious: null, timid: ["spe", "atk"]
};
const SHEET_NATURE_NAMES = Object.keys(SHEET_NATURES).map(n => n[0].toUpperCase() + n.slice(1));
const SHEET_TYPE_COLORS = {
  Normal: "#a8a77a", Fire: "#ee8130", Water: "#6390f0", Electric: "#f7d02c", Grass: "#7ac74c", Ice: "#96d9d6",
  Fighting: "#c22e28", Poison: "#a33ea1", Ground: "#e2bf65", Flying: "#a98ff3", Psychic: "#f95587", Bug: "#a6b91a",
  Rock: "#b6a136", Ghost: "#735797", Dragon: "#6f35fc", Dark: "#705746", Steel: "#b7b7ce", Fairy: "#d685ad", Stellar: "#40b5a5"
};
const SHEET_TARGETS = {
  normal: "One adjacent target", any: "Any one target", adjacentAlly: "One adjacent ally", adjacentAllyOrSelf: "Self or one adjacent ally",
  adjacentFoe: "One adjacent opponent", allAdjacentFoes: "All adjacent opponents", allAdjacent: "All adjacent Pokémon", self: "User",
  all: "Entire field", allySide: "User's side", allyTeam: "User's team", foeSide: "Opponent's side", randomNormal: "Random opponent",
  scripted: "Depends on the move", allies: "All allies"
};
function toID(text) { return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function sheetNature(nature) {
  const v = SHEET_NATURES[toID(nature)];
  return v ? { plus: v[0], minus: v[1] } : null;
}

// ---------- โหลดข้อมูลอ้างอิงจาก Pokémon Showdown ----------
const DEX = { pokedexReady: false, ready: false, failed: false, failedAt: 0, pokedex: {}, moves: {}, items: {}, abilities: {}, megaIndex: {}, speciesNames: [], itemNames: [], moveNames: [] };
let dexPromise = null;
let dexScriptQueue = Promise.resolve();
// ไฟล์ data/*.js ของ Showdown เป็น exports.BattleXxx = {...}; โหลดผ่าน <script> ได้โดยไม่ติด CORS (โหลดทีละไฟล์กัน exports ชนกัน)
function dexLoadScript(file, globalName) {
  const run = () => new Promise((resolve, reject) => {
    const prev = window.exports, holder = {};
    window.exports = holder;
    const el = document.createElement("script");
    const done = () => { window.exports = prev; el.remove(); };
    el.onload = () => { done(); holder[globalName] ? resolve(holder[globalName]) : reject(new Error("missing " + globalName)); };
    el.onerror = () => { done(); reject(new Error("cannot load " + file)); };
    el.src = SHOWDOWN_DATA_URL + file + ".js";
    document.head.appendChild(el);
  });
  const p = dexScriptQueue.then(run, run);
  dexScriptQueue = p.catch(() => {});
  return p;
}
let pokedexPromise = null;
function dexIndexPokedex() {
  DEX.megaIndex = {};
  Object.values(DEX.pokedex).forEach(sp => {
    if (!sp || !sp.name || !/^Mega/.test(sp.forme || "")) return;
    const reqs = sp.requiredItems || (sp.requiredItem ? [sp.requiredItem] : []);
    reqs.forEach(it => { DEX.megaIndex[`${toID(sp.baseSpecies)}|${toID(it)}`] = sp; });
  });
  DEX.speciesNames = Object.values(DEX.pokedex)
    .filter(sp => sp && sp.name && sp.num > 0 && !/^(Mega|Gmax|Primal|Totem)/.test(sp.forme || ""))
    .sort((a, b) => a.num - b.num || a.name.localeCompare(b.name)).map(sp => sp.name);
}
// โหลดเฉพาะ Pokédex (ธาตุ/สเตตัส/ร่างเมก้า) ใช้กับป้ายธาตุในโหมดประมูล-สุ่มตัว เบากว่าโหลดทั้งชุด
function loadPokedexOnly() {
  if (DEX.pokedexReady) return Promise.resolve(DEX);
  if (DEX.failed && Date.now() - DEX.failedAt < 60000) return Promise.reject(new Error("dex unavailable"));
  if (!pokedexPromise) {
    pokedexPromise = (async () => {
      const json = await fetch(SHOWDOWN_DATA_URL + "pokedex.json").then(r => (r.ok ? r.json() : null)).catch(() => null);
      DEX.pokedex = json || await dexLoadScript("pokedex", "BattlePokedex");
      dexIndexPokedex();
      DEX.pokedexReady = true;
      return DEX;
    })().catch(error => {
      DEX.failed = true; DEX.failedAt = Date.now(); pokedexPromise = null;
      console.error("load pokedex failed:", error);
      throw error;
    });
  }
  return pokedexPromise;
}
function loadDex() {
  if (DEX.ready) return Promise.resolve(DEX);
  if (DEX.failed && Date.now() - DEX.failedAt < 60000) return Promise.reject(new Error("dex unavailable"));
  if (!dexPromise) {
    dexPromise = (async () => {
      await loadPokedexOnly();
      const files = ["moves", "items", "abilities"];
      const json = await Promise.all(files.map(f => fetch(SHOWDOWN_DATA_URL + f + ".json").then(r => (r.ok ? r.json() : null)).catch(() => null)));
      const hasDesc = d => !!d && Object.values(d).some(v => v && (v.shortDesc || v.desc));
      // ถ้า JSON ไม่มีคำอธิบายท่า/ไอเทม/อบิลิตี้ ให้ใช้ไฟล์ .js แทน
      DEX.moves = hasDesc(json[0]) ? json[0] : await dexLoadScript("moves", "BattleMovedex");
      DEX.items = hasDesc(json[1]) ? json[1] : await dexLoadScript("items", "BattleItems");
      DEX.abilities = hasDesc(json[2]) ? json[2] : await dexLoadScript("abilities", "BattleAbilities");
      DEX.itemNames = Object.values(DEX.items).filter(i => i && i.name).map(i => i.name).sort();
      DEX.moveNames = Object.values(DEX.moves).filter(m => m && m.name && !m.isZ && !m.isMax).map(m => m.name).sort();
      DEX.ready = true;
      return DEX;
    })().catch(error => {
      DEX.failed = true; DEX.failedAt = Date.now(); dexPromise = null;
      console.error("load pokemon data failed:", error);
      throw error;
    });
  }
  return dexPromise;
}
function dexSpecies(name) { return DEX.pokedexReady ? (DEX.pokedex[toID(name)] || null) : null; }
function dexMove(name) { return DEX.ready ? (DEX.moves[toID(name)] || null) : null; }
function dexItem(name) { return DEX.ready ? (DEX.items[toID(name)] || null) : null; }
function dexAbility(name) { return DEX.ready ? (DEX.abilities[toID(name)] || null) : null; }

// ---------- Showdown import / export ----------
function parseSheetEvs(line) {
  const evs = {};
  String(line).replace(/^evs:\s*/i, "").split("/").forEach(part => {
    const m = part.trim().match(/^(\d+)\s*(HP|Atk|Def|SpA|SpD|Spe)$/i);
    if (m) evs[m[2].toLowerCase()] = Number(m[1]);
  });
  return Object.keys(evs).length ? evs : null;
}
function parseShowdownTeam(text) {
  const raw = String(text || "").replace(/\r/g, "").trim();
  if (!raw) return [];
  // รูปแบบเก่า: ชื่อ|ท่า,ท่า|ไอเทม|นิสัย
  if (raw.includes("|")) {
    return parseTeamProfile(raw).map(p => ({ species: p.pokemon, nickname: "", gender: "", item: p.item || "", ability: "", nature: p.nature || "", level: "", moves: (p.moves || []).slice(0, 4), evs: null }));
  }
  return raw.split(/\n\s*\n/).map(block => {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    const mon = { species: "", nickname: "", gender: "", item: "", ability: "", nature: "", level: "", moves: [], evs: null };
    const parts = lines[0].split(/\s+@\s+/);
    let head = parts[0].trim();
    mon.item = (parts[1] || "").trim();
    const g = head.match(/\s+\((M|F)\)\s*$/i);
    if (g) { mon.gender = g[1].toUpperCase(); head = head.slice(0, g.index).trim(); }
    const nick = head.match(/^(.*)\s+\(([^()]+)\)\s*$/);
    if (nick) { mon.nickname = nick[1].trim(); mon.species = nick[2].trim(); } else mon.species = head;
    lines.slice(1).forEach(line => {
      if (/^ability:/i.test(line)) mon.ability = line.replace(/^ability:\s*/i, "").trim();
      else if (/^level:/i.test(line)) mon.level = line.replace(/^level:\s*/i, "").trim();
      else if (/^evs:/i.test(line)) mon.evs = parseSheetEvs(line);
      else if (/\bnature$/i.test(line)) mon.nature = line.replace(/\s*nature$/i, "").trim();
      else if (/^-\s*/.test(line)) mon.moves.push(line.replace(/^-\s*/, "").trim());
    });
    mon.moves = mon.moves.slice(0, 4);
    return mon.species ? mon : null;
  }).filter(Boolean).slice(0, 6);
}
function sheetEvLine(evs) {
  return SHEET_STATS.filter(k => Number(evs?.[k]) > 0).map(k => `${Number(evs[k])} ${SHEET_STAT_LABELS[k]}`).join(" / ");
}
function exportShowdownTeam(mons) {
  return (mons || []).filter(m => m?.species).map(m => {
    const head = (m.nickname ? `${m.nickname} (${m.species})` : m.species) + (m.gender ? ` (${m.gender})` : "") + (m.item ? ` @ ${m.item}` : "");
    const lines = [head];
    if (m.ability) lines.push(`Ability: ${m.ability}`);
    if (m.level) lines.push(`Level: ${m.level}`);
    const evs = sheetEvLine(m.evs);
    if (evs) lines.push(`EVs: ${evs}`);
    if (m.nature) lines.push(`${m.nature} Nature`);
    (m.moves || []).filter(Boolean).forEach(mv => lines.push(`- ${mv}`));
    return lines.join("\n");
  }).join("\n\n");
}
// ชีทที่ผู้เล่นส่งในห้อง -> รายการโปเกม่อน (ใช้ teamSheet ที่ตัด EV แล้วก่อน)
function sheetMonsOf(player) {
  return parseShowdownTeam(player?.teamSheet || player?.teamText || "");
}

// ---------- การ์ดชีท ----------
const sheetRegistry = new Map();
const sheetSpriteResolved = new Map();
// ---------- ป้ายธาตุของโปเกม่อน (ใช้ในโหมดประมูล/สุ่มตัว/ทีมจากประมูล) ----------
// entry = { apiName?, id?, displayName } ; หาใน Pokédex ของ Showdown จากชื่อ PokeAPI ก่อน แล้วตัดท้ายฟอร์มที่ไม่ตรงกัน
function typeLookupIds(entry) {
  const ids = [];
  const add = v => { const id = toID(v); if (id && !ids.includes(id)) ids.push(id); };
  add(entry.apiName); add(entry.id); add(entry.displayName);
  const strip = /^(.*)-(incarnate|male|female|midday|shield|average|amped|ordinary|solo|standard|disguised|plant|normal|altered|aria|full-belly|single-strike|zero|curly|baile|blade|land|50|two-segment|family-of-four|green-plumage)$/;
  [entry.apiName, entry.id].forEach(v => { const m = String(v || "").match(strip); if (m) add(m[1]); });
  return ids;
}
function monTypes(entry) {
  if (!DEX.pokedexReady || !entry) return null;
  for (const id of typeLookupIds(entry)) { const sp = DEX.pokedex[id]; if (sp && sp.types) return sp.types; }
  return null;
}
function monTypesInner(entry) { const t = monTypes(entry); return t ? t.map(sheetTypeBadge).join("") : ""; }
// ใส่ใน template ได้เลย ถ้ายังโหลดข้อมูลไม่เสร็จจะเป็นกล่องว่างแล้วเติมให้เองทีหลัง
function monTypesHtml(entry) {
  if (!entry) return "";
  return `<span class="mon-types" data-ta="${escapeHtml(entry.apiName || "")}" data-ti="${escapeHtml(entry.id || "")}" data-td="${escapeHtml(entry.displayName || "")}">${monTypesInner(entry)}</span>`;
}
function fillMonTypes(root) {
  const list = root.matches?.(".mon-types") ? [root] : [...(root.querySelectorAll?.(".mon-types") || [])];
  list.forEach(el => {
    if (el.childElementCount) return;
    const html = monTypesInner({ apiName: el.dataset.ta, id: el.dataset.ti, displayName: el.dataset.td });
    if (html) el.innerHTML = html;
  });
}
let monTypesLoading = false;
function scheduleMonTypes(node) {
  if (DEX.pokedexReady) { fillMonTypes(node); return; }
  if (monTypesLoading) return;
  monTypesLoading = true;
  loadPokedexOnly().then(() => fillMonTypes(document.body)).catch(() => {}).finally(() => { monTypesLoading = false; });
}

function sheetForms(mon) {
  const sp = dexSpecies(mon.species);
  if (!sp) return { base: null, mega: null, species: null };
  if (/^Mega/.test(sp.forme || "")) return { base: dexSpecies(sp.baseSpecies) || sp, mega: sp, species: sp };
  return { base: sp, mega: DEX.megaIndex[`${toID(sp.name)}|${toID(mon.item)}`] || null, species: sp };
}
function sheetDisplay(st, mon, idx) {
  const forms = sheetForms(mon);
  const defaultMega = !!(forms.mega && forms.species === forms.mega);
  const megaOn = !!forms.mega && (st.mega[idx] ?? defaultMega);
  const entry = megaOn ? forms.mega : (forms.base || forms.species);
  const ability = megaOn ? (forms.mega.abilities?.["0"] || mon.ability) : mon.ability;
  return { forms, megaOn, entry, name: entry?.name || mon.species, ability: ability || "", types: entry?.types || [] };
}
function sheetTypeBadge(type) {
  return `<span class="type-badge" style="--tc:${SHEET_TYPE_COLORS[type] || "#888"}">${escapeHtml(type)}</span>`;
}
function sheetItemIconHtml(itemName) {
  const it = dexItem(itemName);
  if (!it || typeof it.spritenum !== "number") return "";
  return `<span class="item-icon" style="background-position:-${(it.spritenum % 16) * 24}px -${Math.floor(it.spritenum / 16) * 24}px"></span>`;
}
function sheetNatureBarHtml(mon, showEvs) {
  const nat = sheetNature(mon.nature);
  const withValues = showEvs && mon.evs && SHEET_STATS.some(k => Number(mon.evs[k]) > 0);
  const stats = SHEET_STATS.map(k => `<span class="sheet-stat ${nat?.plus === k ? "up" : nat?.minus === k ? "down" : ""}"><small>${SHEET_STAT_LABELS[k]}</small>${withValues ? `<b>${Number(mon.evs[k]) || 0}</b>` : ""}</span>`).join("");
  return `<span class="sheet-nature">${escapeHtml(mon.nature || "-")} <small>Nature</small></span><span class="sheet-stats">${withValues ? "<em>EVs</em>" : ""}${stats}</span>`;
}
function sheetCardHtml(st, mon, idx) {
  const d = sheetDisplay(st, mon, idx);
  const active = st.focus && st.focus.mon === idx;
  const src = sheetSpriteResolved.get(d.name) || teamSheetSprite(d.name);
  const moves = (mon.moves || []).filter(Boolean).map((mv, i) => {
    const info = dexMove(mv);
    const color = info ? (SHEET_TYPE_COLORS[info.type] || "#999") : "#bdb8cc";
    const on = active && st.focus.kind === "move" && st.focus.move === i;
    return `<li><button type="button" class="sheet-move${on ? " on" : ""}" data-sheet-move="${i}"><i style="background:${color}"></i>${escapeHtml(mv)}</button></li>`;
  }).join("");
  return `<article class="sheet-card${active ? " active" : ""}${d.megaOn ? " is-mega" : ""}" data-sheet-card="${idx}">
    <header data-sheet-mon="${idx}"><img class="sheet-sprite" src="${escapeHtml(src)}" data-poke-name="${escapeHtml(d.name)}" alt="${escapeHtml(d.name)}" onerror="this.style.visibility='hidden'"><h4>${escapeHtml(d.name)}</h4><div class="sheet-types">${d.types.map(sheetTypeBadge).join("")}</div></header>
    <div class="sheet-body">
      <div class="sheet-info"><span class="sheet-label">Ability</span><button type="button" class="sheet-link" data-sheet-ability="${idx}">${escapeHtml(d.ability || "-")}</button><span class="sheet-label">Held item</span><button type="button" class="sheet-link" data-sheet-item="${idx}">${escapeHtml(mon.item || "-")}${sheetItemIconHtml(mon.item)}</button></div>
      <ul class="sheet-moves">${moves || '<li class="small-text">ไม่มีข้อมูลท่า</li>'}</ul>
      <span class="sheet-index">${idx + 1}</span>
    </div>
    <footer>${sheetNatureBarHtml(mon, st.showEvs)}</footer>
  </article>`;
}
function sheetPanelHtml(st) {
  const f = st.focus, mon = st.mons[f.mon];
  const close = '<button type="button" class="sheet-close" data-sheet-close aria-label="ปิด">✕</button>';
  if (!DEX.ready) return `${close}<p class="small-text">${DEX.failed ? "โหลดข้อมูลโปเกม่อนไม่สำเร็จ ลองรีเฟรชหน้าเว็บ" : "กำลังโหลดข้อมูล..."}</p>`;
  if (f.kind === "move") {
    const name = mon.moves?.[f.move], mv = dexMove(name);
    if (!mv) return `${close}<div class="sheet-panel-label">MOVE</div><h3>${escapeHtml(name || "-")}</h3><p class="small-text">ไม่พบข้อมูลท่านี้ในฐานข้อมูลอ้างอิง</p>`;
    return `${close}<div class="sheet-panel-label">MOVE</div><h3>${escapeHtml(mv.name)}</h3>
      <p class="sheet-sub"><b style="color:${SHEET_TYPE_COLORS[mv.type] || "#777"}">${escapeHtml(mv.type)}</b> · ${escapeHtml(mv.category)}</p>
      <div class="sheet-facts"><div><small>Power</small><b>${mv.basePower || "—"}</b></div><div><small>Accuracy</small><b>${mv.accuracy === true ? "—" : mv.accuracy}</b></div><div><small>Priority</small><b>${mv.priority ?? 0}</b></div><div><small>PP</small><b>${mv.pp ?? "—"}</b></div></div>
      <p class="sheet-target">Target: ${escapeHtml(SHEET_TARGETS[mv.target] || mv.target || "-")}</p>
      ${mv.shortDesc ? `<p class="sheet-short">${escapeHtml(mv.shortDesc)}</p>` : ""}
      ${mv.desc ? `<details class="sheet-more"><summary>Full reference mechanics (English)</summary><p>${escapeHtml(mv.desc)}</p></details>` : ""}
      <p class="sheet-note">ข้อมูลอ้างอิงจาก Pokémon Showdown อาจต่างจากเกมจริงหลังมีการอัปเดต</p>`;
  }
  if (f.kind === "item") {
    const it = dexItem(mon.item);
    return `${close}<div class="sheet-panel-label">HELD ITEM</div><h3>${sheetItemIconHtml(mon.item)} ${escapeHtml(it?.name || mon.item || "-")}</h3>${it?.shortDesc ? `<p class="sheet-short">${escapeHtml(it.shortDesc)}</p>` : '<p class="small-text">ไม่พบข้อมูลไอเทมนี้</p>'}${it?.desc ? `<details class="sheet-more"><summary>Full reference mechanics (English)</summary><p>${escapeHtml(it.desc)}</p></details>` : ""}`;
  }
  if (f.kind === "ability") {
    const d = sheetDisplay(st, mon, f.mon), ab = dexAbility(d.ability);
    return `${close}<div class="sheet-panel-label">ABILITY</div><h3>${escapeHtml(ab?.name || d.ability || "-")}</h3>${ab?.shortDesc ? `<p class="sheet-short">${escapeHtml(ab.shortDesc)}</p>` : '<p class="small-text">ไม่พบข้อมูลอบิลิตี้นี้</p>'}${ab?.desc ? `<details class="sheet-more"><summary>Full reference mechanics (English)</summary><p>${escapeHtml(ab.desc)}</p></details>` : ""}`;
  }
  // POKÉMON FOCUS
  const d = sheetDisplay(st, mon, f.mon), nat = sheetNature(mon.nature);
  const natHint = nat ? `${SHEET_STAT_LABELS[nat.plus]} ↑ · ${SHEET_STAT_LABELS[nat.minus]} ↓` : "นิสัยกลาง";
  const stats = d.entry?.baseStats, baseStats = d.megaOn ? d.forms.base?.baseStats : null;
  const src = sheetSpriteResolved.get(d.name) || teamSheetSprite(d.name);
  let bars = "";
  if (stats) {
    bars = SHEET_STATS.map(k => {
      const v = stats[k], delta = baseStats ? v - baseStats[k] : null;
      return `<div class="sheet-stat-row"><span>${SHEET_STAT_LABELS[k]}</span><div class="sheet-bar"><i style="width:${Math.min(100, v / 255 * 100)}%"></i></div><b>${v}</b>${delta === null ? "<em></em>" : `<em class="${delta > 0 ? "plus" : delta < 0 ? "minus" : ""}">${delta > 0 ? "+" : ""}${delta}</em>`}</div>`;
    }).join("");
    const total = SHEET_STATS.reduce((sum, k) => sum + stats[k], 0);
    const baseTotal = baseStats ? SHEET_STATS.reduce((sum, k) => sum + baseStats[k], 0) : null;
    bars += `<div class="sheet-stat-row total"><span>BST</span><div></div><b>${total}</b>${baseTotal === null ? "<em></em>" : `<em class="${total - baseTotal > 0 ? "plus" : ""}">${total - baseTotal > 0 ? "+" : ""}${total - baseTotal}</em>`}</div>`;
  }
  return `${close}<div class="sheet-panel-label">POKÉMON FOCUS</div>
    <img class="sheet-big" src="${escapeHtml(src)}" data-poke-name="${escapeHtml(d.name)}" alt="${escapeHtml(d.name)}" onerror="this.style.visibility='hidden'">
    <h3 class="sheet-focus-name">${escapeHtml(d.name)}</h3>
    ${d.forms.mega ? `<button type="button" class="sheet-mega-btn" data-sheet-mega="${f.mon}">✦ ${d.megaOn ? "Normal form" : "Mega Evolve"}</button>` : ""}
    <div class="sheet-row"><span>Ability</span><b>${escapeHtml(d.ability || "-")}</b></div>
    <div class="sheet-row"><span>Nature</span><b>${escapeHtml(mon.nature || "-")}</b><small>${natHint}</small></div>
    ${bars ? `<p class="sheet-sub">Base stats · form comparison</p>${bars}` : '<p class="small-text">ไม่พบค่าสเตตัสของโปเกม่อนตัวนี้</p>'}`;
}
function sheetViewerInner(id) {
  const st = sheetRegistry.get(id);
  if (!st) return "";
  if (st.focus && !st.mons[st.focus.mon]) st.focus = null;
  const head = (st.title || st.code) ? `<div class="sheet-title">${st.title ? `<h3>${escapeHtml(st.title)}</h3>` : ""}${st.code ? `<p>Team ID: ${escapeHtml(st.code)}</p>` : ""}</div>` : "";
  const cards = st.mons.map((m, i) => sheetCardHtml(st, m, i)).join("") || '<p class="small-text">ยังไม่มีโปเกม่อนในทีม</p>';
  return `${head}<div class="sheet-layout"><div class="sheet-grid">${cards}</div>${st.focus ? `<aside class="sheet-side">${sheetPanelHtml(st)}</aside>` : ""}</div>`;
}
// id ต้องคงที่ต่อจุดแสดงผล เพื่อให้จำสถานะ (โปเกม่อนที่เปิดดู/เมก้า) ข้ามการเรนเดอร์ใหม่ได้
function sheetViewerHtml(id, mons, opts = {}) {
  const prev = sheetRegistry.get(id);
  sheetRegistry.set(id, { mons: mons || [], showEvs: !!opts.showEvs, title: opts.title || "", code: opts.code || "", focus: prev?.focus || null, mega: prev?.mega || {} });
  return `<div class="sheet-viewer" data-sheet-id="${escapeHtml(id)}" data-dex="${DEX.ready ? 1 : 0}">${sheetViewerInner(id)}</div>`;
}
async function hydrateSheetSprites(root) {
  await hydratePokeApiSprites(root);
  root.querySelectorAll("img[data-poke-name]").forEach(img => sheetSpriteResolved.set(img.dataset.pokeName, img.src));
}
function refreshSheetViewer(id) {
  document.querySelectorAll(".sheet-viewer").forEach(v => {
    if (v.dataset.sheetId !== id) return;
    v.innerHTML = sheetViewerInner(id);
    v.dataset.dex = DEX.ready ? "1" : "0";
    hydrateSheetSprites(v);
  });
}
// เติมข้อมูลธาตุ/ไอคอนไอเทม/สีท่า/เมก้า หลังโหลดข้อมูลอ้างอิงเสร็จ (เฉพาะการ์ดที่มองเห็นอยู่)
function hydrateSheetViewer(v) {
  if (!v || !v.isConnected) return;
  if (v.getClientRects().length === 0) return;
  if (v.dataset.dex === "1") { hydrateSheetSprites(v); return; }
  hydrateSheetSprites(v);
  loadDex().then(() => refreshSheetViewer(v.dataset.sheetId)).catch(() => { /* ใช้การ์ดแบบพื้นฐานต่อไป */ });
}
document.addEventListener("click", (event) => {
  const t = event.target;
  const viewer = t.closest?.(".sheet-viewer");
  if (!viewer) return;
  const id = viewer.dataset.sheetId, st = sheetRegistry.get(id);
  if (!st) return;
  const card = t.closest("[data-sheet-card]");
  const monIdx = card ? Number(card.dataset.sheetCard) : null;
  let changed = true;
  if (t.closest("[data-sheet-close]")) st.focus = null;
  else if (t.closest("[data-sheet-mega]")) {
    const i = Number(t.closest("[data-sheet-mega]").dataset.sheetMega);
    st.mega[i] = !sheetDisplay(st, st.mons[i], i).megaOn;
  }
  else if (t.closest("[data-sheet-move]")) st.focus = { kind: "move", mon: monIdx, move: Number(t.closest("[data-sheet-move]").dataset.sheetMove) };
  else if (t.closest("[data-sheet-item]")) st.focus = { kind: "item", mon: monIdx };
  else if (t.closest("[data-sheet-ability]")) st.focus = { kind: "ability", mon: monIdx };
  else if (t.closest("[data-sheet-mon]")) st.focus = { kind: "mon", mon: monIdx };
  else changed = false;
  if (!changed) return;
  refreshSheetViewer(id);
  if (!DEX.ready) loadDex().then(() => refreshSheetViewer(id)).catch(() => refreshSheetViewer(id));
});
if (typeof MutationObserver !== "undefined") {
  new MutationObserver(mutations => {
    for (const m of mutations) for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      const viewers = node.matches?.(".sheet-viewer") ? [node] : [...(node.querySelectorAll?.(".sheet-viewer") || [])];
      viewers.forEach(hydrateSheetViewer);
      if (node.matches?.(".mon-types") || node.querySelector?.(".mon-types")) scheduleMonTypes(node);
    }
  }).observe(document.body, { childList: true, subtree: true });
}

// ---------- Team Builder ----------
const TB_LIMIT = 3;
const builder = { uid: "", failedAt: 0, loaded: false, loading: null, teams: {}, view: "list", editingId: null, draft: null, slot: 0, previewTimer: null };
function tbBlankMon() { return { species: "", nickname: "", gender: "", item: "", ability: "", nature: "", level: "", moves: ["", "", "", ""], evs: null }; }
function tbBlankDraft() { return { name: "", code: "", evMode: "sp", mons: Array.from({ length: 6 }, tbBlankMon) }; }
function tbNormalizeMon(m) {
  const base = tbBlankMon();
  const moves = Array.from(m?.moves || []).slice(0, 4);
  while (moves.length < 4) moves.push("");
  return { ...base, ...(m || {}), moves: moves.map(x => String(x || "")), evs: m?.evs ? { ...m.evs } : null };
}
function tbNormalizeTeam(t) {
  const mons = Array.from(t?.mons || []).slice(0, 6).map(tbNormalizeMon);
  while (mons.length < 6) mons.push(tbBlankMon());
  return { name: t?.name || "", code: t?.code || "", evMode: t?.evMode === "ev" ? "ev" : "sp", mons, createdAt: t?.createdAt || 0, updatedAt: t?.updatedAt || 0 };
}
function ensureMyTeamsLoaded(force = false) {
  if (!currentUser) return Promise.resolve({});
  if (builder.uid !== currentUser.uid) { builder.uid = currentUser.uid; builder.loaded = false; builder.loading = null; builder.teams = {}; }
  if (builder.loaded && !force) return Promise.resolve(builder.teams);
  if (!force && builder.failedAt && Date.now() - builder.failedAt < 60000) return Promise.reject(new Error("teams unavailable"));
  if (!builder.loading || force) {
    builder.loading = get(ref(db, `userTeams/${currentUser.uid}`)).then(snap => {
      const raw = snap.val() || {};
      builder.teams = Object.fromEntries(Object.entries(raw).map(([id, t]) => [id, tbNormalizeTeam(t)]));
      builder.loaded = true;
      builder.failedAt = 0;
      return builder.teams;
    }).catch(error => { builder.loading = null; builder.failedAt = Date.now(); throw error; });
  }
  return builder.loading;
}
function tbSortedTeams() { return Object.entries(builder.teams).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)); }
function tbEvLimits(mode) { return mode === "ev" ? { per: 252, total: 510 } : { per: 32, total: 66 }; }
function tbEvTotal(m) { return SHEET_STATS.reduce((sum, k) => sum + (Number(m.evs?.[k]) || 0), 0); }
function tbCleanMons() {
  return builder.draft.mons.filter(m => m.species.trim()).map(m => ({
    ...m, species: m.species.trim(), moves: m.moves.map(x => x.trim()).filter(Boolean),
    evs: tbEvTotal(m) > 0 ? { ...m.evs } : null
  }));
}
function tbRecordFromDraft() {
  const d = builder.draft;
  return {
    name: d.name.trim().slice(0, 60), code: d.code.trim().slice(0, 30), evMode: d.evMode,
    mons: d.mons.map(m => {
      const out = { species: m.species.trim(), nickname: m.nickname || "", gender: m.gender || "", item: m.item.trim(), ability: m.ability.trim(), nature: m.nature.trim(), level: m.level || "", moves: m.moves.map(x => x.trim()) };
      if (tbEvTotal(m) > 0) out.evs = Object.fromEntries(SHEET_STATS.filter(k => Number(m.evs?.[k]) > 0).map(k => [k, Number(m.evs[k])]));
      return out;
    })
  };
}

function tbOptionHtml(names) { return names.map(n => `<option value="${escapeHtml(n)}"></option>`).join(""); }
function tbFillDatalists() {
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const species = DEX.ready ? DEX.speciesNames : POKEMON_LIST.filter(p => !p.isMega).map(p => p.displayName);
  set("tb-dl-species", tbOptionHtml(species));
  set("tb-dl-items", tbOptionHtml(DEX.itemNames));
  set("tb-dl-moves", tbOptionHtml(DEX.moveNames));
  tbFillAbilityList(builder.draft?.mons?.[builder.slot]?.species);
}
function tbFillAbilityList(species) {
  const el = document.getElementById("tb-dl-abilities");
  if (!el) return;
  const sp = dexSpecies(species);
  el.innerHTML = sp ? tbOptionHtml(Object.values(sp.abilities || {})) : "";
}

function tbListHtml() {
  const teams = tbSortedTeams();
  const cards = teams.map(([id, t]) => {
    const names = t.mons.filter(m => m.species).map(m => `<span class="tb-chip">${escapeHtml(m.species)}</span>`).join("");
    return `<div class="tb-team-card"><div><b>${escapeHtml(t.name || "ทีมไม่มีชื่อ")}</b>${t.code ? ` <small>Team ID: ${escapeHtml(t.code)}</small>` : ""}<div class="tb-chips">${names || '<small>ยังไม่มีโปเกม่อน</small>'}</div></div>
      <div class="tb-team-actions"><button type="button" class="btn-leave-small" data-tb="edit" data-id="${escapeHtml(id)}">✏️ เปิด/แก้ไข</button><button type="button" class="btn-leave-small" data-tb="copy-saved" data-id="${escapeHtml(id)}">📋 คัดลอก Showdown</button><button type="button" class="btn-kick" data-tb="delete" data-id="${escapeHtml(id)}">🗑 ลบ</button></div></div>`;
  }).join("");
  const full = teams.length >= TB_LIMIT;
  return `<div class="tb-head"><h2>🧩 Team Builder</h2><button type="button" class="btn-leave-small" data-tb="close">✕ ปิด</button></div>
    <p class="small-text">สร้างชีททีมสไตล์การ์ด หรือวางโค้ดจาก Pokémon Showdown ได้ • เก็บได้คนละ ${TB_LIMIT} ทีม (ตอนนี้ ${teams.length}/${TB_LIMIT}) • ใช้ส่งเป็น Team Sheet ในห้องได้</p>
    <div class="tb-list">${cards || '<p class="small-text">ยังไม่มีทีมที่บันทึกไว้</p>'}</div>
    <button type="button" class="primary" data-tb="new" ${full ? "disabled" : ""}>➕ สร้างทีมใหม่</button>
    ${full ? '<p class="small-text">ครบ 3 ทีมแล้ว ลบทีมเก่าก่อนถึงจะสร้างทีมใหม่ได้</p>' : ""}`;
}
function tbSlotFormHtml() {
  const d = builder.draft, m = d.mons[builder.slot], lim = tbEvLimits(d.evMode);
  const natOpts = '<option value="">— ไม่ระบุ —</option>' + SHEET_NATURE_NAMES.map(n => {
    const nat = sheetNature(n);
    return `<option value="${n}"${toID(m.nature) === toID(n) ? " selected" : ""}>${n}${nat ? ` (${SHEET_STAT_LABELS[nat.plus]}↑ ${SHEET_STAT_LABELS[nat.minus]}↓)` : ""}</option>`;
  }).join("");
  const evs = SHEET_STATS.map(k => `<label class="tb-ev"><span>${SHEET_STAT_LABELS[k]}</span><input type="number" inputmode="numeric" min="0" max="${lim.per}" placeholder="0" data-tb-field="ev:${k}" value="${Number(m.evs?.[k]) > 0 ? Number(m.evs[k]) : ""}"></label>`).join("");
  const moves = [0, 1, 2, 3].map(i => `<input type="text" list="tb-dl-moves" placeholder="ท่าที่ ${i + 1}" data-tb-field="move${i}" value="${escapeHtml(m.moves[i] || "")}" autocomplete="off">`).join("");
  return `<div class="tb-slot-form">
    <label class="field-label">โปเกม่อน</label><input type="text" list="tb-dl-species" placeholder="พิมพ์ชื่อ เช่น Garchomp" data-tb-field="species" value="${escapeHtml(m.species)}" autocomplete="off">
    <div class="tb-two"><div><label class="field-label">ไอเทม</label><input type="text" list="tb-dl-items" placeholder="เช่น Garchompite Z" data-tb-field="item" value="${escapeHtml(m.item)}" autocomplete="off"></div>
    <div><label class="field-label">อบิลิตี้</label><input type="text" list="tb-dl-abilities" placeholder="เช่น Rough Skin" data-tb-field="ability" value="${escapeHtml(m.ability)}" autocomplete="off"></div></div>
    <label class="field-label">นิสัย</label><select data-tb-field="nature">${natOpts}</select>
    <label class="field-label">ท่า (4 ท่า)</label><div class="tb-moves">${moves}</div>
    <label class="field-label">EV (ใส่หรือไม่ใส่ก็ได้) <small id="tb-ev-total">รวม ${tbEvTotal(m)}/${lim.total}</small></label><div class="tb-evs">${evs}</div>
    <button type="button" class="btn-leave-small" data-tb="clear-slot">🧹 ล้างช่องนี้</button></div>`;
}
function tbEditorHtml() {
  const d = builder.draft;
  const tabs = d.mons.map((m, i) => `<button type="button" class="tb-slot-tab${i === builder.slot ? " active" : ""}" data-tb="slot" data-i="${i}">${i + 1}. ${escapeHtml(m.species || "ว่าง")}</button>`).join("");
  return `<div class="tb-head"><h2>${builder.editingId ? "✏️ แก้ไขทีม" : "➕ สร้างทีมใหม่"}</h2><button type="button" class="btn-leave-small" data-tb="back">⬅ กลับรายการทีม</button></div>
    <div class="tb-two"><div><label class="field-label">ชื่อทีม</label><input type="text" maxlength="60" placeholder="เช่น My Regional Team" data-tb-field="name" value="${escapeHtml(d.name)}"></div>
    <div><label class="field-label">โค้ดทีม (Team ID)</label><input type="text" maxlength="30" placeholder="เช่น 9979J V2YPM" data-tb-field="code" value="${escapeHtml(d.code)}"></div></div>
    <details class="tb-import"><summary>📥 วางทีมจาก Pokémon Showdown (นำเข้าแทนการกรอกเอง)</summary>
      <textarea id="tb-import-text" rows="10" placeholder="วางโค้ดทีมจาก Pokémon Showdown ที่นี่ (EV ใส่หรือไม่ใส่ก็ได้)"></textarea>
      <button type="button" class="primary" data-tb="import">นำเข้าทีมนี้</button></details>
    <label class="field-label">หน่วยของค่า EV</label>
    <select data-tb-field="evmode"><option value="sp"${d.evMode === "sp" ? " selected" : ""}>Stat Points (สูงสุด 32 ต่อค่า รวม 66)</option><option value="ev"${d.evMode === "ev" ? " selected" : ""}>EV แบบเดิม (สูงสุด 252 ต่อค่า รวม 510)</option></select>
    <div class="tb-slot-tabs">${tabs}</div>
    <div id="tb-slot-form">${tbSlotFormHtml()}</div>
    <datalist id="tb-dl-species"></datalist><datalist id="tb-dl-items"></datalist><datalist id="tb-dl-moves"></datalist><datalist id="tb-dl-abilities"></datalist>
    <h3 class="tb-preview-title">ตัวอย่างชีท (กดท่า/โปเกม่อนเพื่อดูรายละเอียด)</h3>
    <div id="tb-preview"></div>
    <div class="tb-actions"><button type="button" class="primary" data-tb="save">💾 บันทึกทีม</button><button type="button" class="btn-leave-small" data-tb="copy">📋 คัดลอกเป็นโค้ด Showdown</button></div>`;
}
function tbRender() {
  const panel = document.getElementById("tb-panel");
  if (!panel) return;
  panel.innerHTML = builder.view === "edit" ? tbEditorHtml() : tbListHtml();
  if (builder.view === "edit") { tbFillDatalists(); tbUpdatePreview(); }
}
function tbUpdatePreview() {
  const el = document.getElementById("tb-preview");
  if (!el) return;
  const d = builder.draft;
  el.innerHTML = sheetViewerHtml("builder", tbCleanMons(), { showEvs: true, title: d.name.trim(), code: d.code.trim() });
}
function tbSchedulePreview() {
  clearTimeout(builder.previewTimer);
  builder.previewTimer = setTimeout(tbUpdatePreview, 150);
}
function openTeamBuilder() {
  if (!currentUser) {
    if (confirm("ต้องเข้าสู่ระบบด้วย Google ก่อนถึงจะใช้ Team Builder และเก็บทีมได้ ต้องการเข้าสู่ระบบตอนนี้ไหม?")) document.getElementById("btn-login")?.click();
    return;
  }
  const root = document.getElementById("screen-teambuilder");
  root.classList.remove("hidden");
  document.body.classList.add("tb-open");
  builder.view = "list";
  const panel = document.getElementById("tb-panel");
  panel.innerHTML = '<p class="small-text">กำลังโหลดทีมของคุณ...</p>';
  ensureMyTeamsLoaded(true).then(() => tbRender()).catch(error => {
    console.error("load teams failed:", error);
    panel.innerHTML = '<div class="tb-head"><h2>🧩 Team Builder</h2><button type="button" class="btn-leave-small" data-tb="close">✕ ปิด</button></div><p class="error">โหลดทีมไม่สำเร็จ (ตรวจอินเทอร์เน็ต และตรวจว่าอัปเดต Database Rules ส่วน userTeams แล้ว)</p>';
  });
  loadDex().then(() => { if (builder.view === "edit") { tbFillDatalists(); tbUpdatePreview(); } }).catch(() => {});
}
function closeTeamBuilder() {
  document.getElementById("screen-teambuilder")?.classList.add("hidden");
  document.body.classList.remove("tb-open");
}
async function tbCopyText(text) {
  try { await navigator.clipboard.writeText(text); alert("คัดลอกโค้ดทีมแล้ว"); }
  catch (e) { prompt("คัดลอกโค้ดทีมด้านล่างนี้", text); }
}
async function tbSave() {
  const d = builder.draft;
  if (!d.name.trim()) { alert("กรุณาตั้งชื่อทีม"); return; }
  if (!d.mons.some(m => m.species.trim())) { alert("ใส่โปเกม่อนอย่างน้อย 1 ตัวก่อนบันทึก"); return; }
  if (!builder.editingId && Object.keys(builder.teams).length >= TB_LIMIT) { alert(`เก็บทีมได้สูงสุด ${TB_LIMIT} ทีม ลบทีมเก่าก่อน`); return; }
  const id = builder.editingId || `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const record = { ...tbRecordFromDraft(), updatedAt: now, createdAt: builder.teams[id]?.createdAt || now };
  try {
    await set(ref(db, `userTeams/${currentUser.uid}/${id}`), record);
    builder.teams[id] = tbNormalizeTeam(record);
    builder.editingId = id;
    alert("บันทึกทีมแล้ว");
    builder.view = "list";
    tbRender();
  } catch (error) {
    console.error("save team failed:", error);
    alert("บันทึกไม่สำเร็จ (ตรวจอินเทอร์เน็ต และตรวจว่าอัปเดต Database Rules ส่วน userTeams แล้ว)");
  }
}
(function initTeamBuilder() {
  const root = document.getElementById("screen-teambuilder");
  if (!root) return;
  document.getElementById("btn-open-teambuilder")?.addEventListener("click", openTeamBuilder);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !root.classList.contains("hidden") && !document.querySelector(".gacha-overlay")) closeTeamBuilder(); });
  root.addEventListener("click", async (event) => {
    if (event.target === root) { closeTeamBuilder(); return; }
    const btn = event.target.closest("[data-tb]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.tb;
    if (act === "close") closeTeamBuilder();
    else if (act === "back") { builder.view = "list"; tbRender(); }
    else if (act === "new") {
      if (Object.keys(builder.teams).length >= TB_LIMIT) return;
      builder.editingId = null; builder.draft = tbBlankDraft(); builder.slot = 0; builder.view = "edit"; tbRender();
    } else if (act === "edit") {
      const t = builder.teams[btn.dataset.id]; if (!t) return;
      builder.editingId = btn.dataset.id; builder.draft = tbNormalizeTeam(t); builder.slot = 0; builder.view = "edit"; tbRender();
    } else if (act === "delete") {
      const t = builder.teams[btn.dataset.id];
      if (!t || !confirm(`ลบทีม "${t.name || "ทีมไม่มีชื่อ"}" ใช่หรือไม่?`)) return;
      try { await set(ref(db, `userTeams/${currentUser.uid}/${btn.dataset.id}`), null); delete builder.teams[btn.dataset.id]; tbRender(); }
      catch (error) { console.error("delete team failed:", error); alert("ลบไม่สำเร็จ กรุณาลองใหม่"); }
    } else if (act === "copy-saved") {
      const t = builder.teams[btn.dataset.id]; if (t) tbCopyText(exportShowdownTeam(t.mons));
    } else if (act === "slot") {
      builder.slot = Number(btn.dataset.i);
      document.querySelectorAll(".tb-slot-tab").forEach(b => b.classList.toggle("active", Number(b.dataset.i) === builder.slot));
      document.getElementById("tb-slot-form").innerHTML = tbSlotFormHtml();
      tbFillAbilityList(builder.draft.mons[builder.slot].species);
    } else if (act === "clear-slot") {
      builder.draft.mons[builder.slot] = tbBlankMon();
      document.getElementById("tb-slot-form").innerHTML = tbSlotFormHtml();
      const tab = document.querySelector(`.tb-slot-tab[data-i="${builder.slot}"]`); if (tab) tab.textContent = `${builder.slot + 1}. ว่าง`;
      tbUpdatePreview();
    } else if (act === "import") {
      const mons = parseShowdownTeam(document.getElementById("tb-import-text").value);
      if (!mons.length) { alert("อ่านโค้ดทีมไม่ได้ ตรวจรูปแบบจาก Pokémon Showdown อีกครั้ง"); return; }
      const padded = mons.map(tbNormalizeMon);
      while (padded.length < 6) padded.push(tbBlankMon());
      builder.draft.mons = padded;
      // ถ้ามีค่าเกิน 32 ต่อค่า หรือรวมเกิน 66 แปลว่าเป็น EV แบบเดิม
      const legacy = padded.some(m => SHEET_STATS.some(k => Number(m.evs?.[k]) > 32) || tbEvTotal(m) > 66);
      builder.draft.evMode = legacy ? "ev" : "sp";
      builder.slot = 0; tbRender();
    } else if (act === "save") tbSave();
    else if (act === "copy") tbCopyText(exportShowdownTeam(tbCleanMons()));
  });
  root.addEventListener("input", (event) => {
    const field = event.target.dataset?.tbField;
    if (!field || !builder.draft) return;
    const d = builder.draft, m = d.mons[builder.slot], value = event.target.value;
    if (field === "name") d.name = value;
    else if (field === "code") d.code = value;
    else if (field === "species" || field === "item" || field === "ability") m[field] = value;
    else if (field === "nature") m.nature = value;
    else if (field.startsWith("move")) m.moves[Number(field.slice(4))] = value;
    else if (field.startsWith("ev:")) {
      const key = field.slice(3), lim = tbEvLimits(d.evMode);
      m.evs = m.evs || {};
      const others = SHEET_STATS.reduce((sum, k) => sum + (k === key ? 0 : (Number(m.evs[k]) || 0)), 0);
      let n = Math.max(0, Math.floor(Number(value) || 0));
      n = Math.min(n, lim.per, Math.max(0, lim.total - others));
      m.evs[key] = n;
      if (String(n) !== value && value !== "") event.target.value = n;
      const totalEl = document.getElementById("tb-ev-total"); if (totalEl) totalEl.textContent = `รวม ${tbEvTotal(m)}/${lim.total}`;
    } else return;
    tbSchedulePreview();
  });
  root.addEventListener("change", (event) => {
    const field = event.target.dataset?.tbField;
    if (!field || !builder.draft) return;
    const d = builder.draft, m = d.mons[builder.slot];
    if (field === "evmode") {
      d.evMode = event.target.value === "ev" ? "ev" : "sp";
      const lim = tbEvLimits(d.evMode);
      d.mons.forEach(mon => { if (mon.evs) SHEET_STATS.forEach(k => { if (Number(mon.evs[k]) > lim.per) mon.evs[k] = lim.per; }); });
      document.getElementById("tb-slot-form").innerHTML = tbSlotFormHtml();
      tbUpdatePreview();
    } else if (field === "species") {
      tbFillAbilityList(m.species);
      const sp = dexSpecies(m.species);
      if (sp && !m.ability.trim()) {
        m.ability = Object.values(sp.abilities || {})[0] || "";
        const abilityInput = root.querySelector('[data-tb-field="ability"]'); if (abilityInput) abilityInput.value = m.ability;
      }
      const tab = document.querySelector(`.tb-slot-tab[data-i="${builder.slot}"]`); if (tab) tab.textContent = `${builder.slot + 1}. ${m.species.trim() || "ว่าง"}`;
      tbUpdatePreview();
    }
  });
})();

// ---------- เลือกจากทีมที่บันทึกไว้ ตอนส่ง Team Sheet ----------
function savedTeamOptionsHtml() {
  return tbSortedTeams().map(([id, t]) => `<option value="${escapeHtml(id)}">${escapeHtml(t.name || "ทีมไม่มีชื่อ")}${t.code ? ` (${escapeHtml(t.code)})` : ""} • ${t.mons.filter(m => m.species).length} ตัว</option>`).join("");
}

function refreshLobbySavedTeams() {
  const row = document.getElementById("lobby-saved-team-row");
  if (!row) return;
  if (!currentUser) { row.classList.add("hidden"); return; }
  if (!builder.loaded) { ensureMyTeamsLoaded().then(() => { if (latestRoom) refreshLobbySavedTeams(); }).catch(() => {}); return; }
  const sel = document.getElementById("lobby-saved-team-select"), html = savedTeamOptionsHtml();
  row.classList.toggle("hidden", !html);
  if (sel && sel.dataset.sig !== html) { sel.innerHTML = html; sel.dataset.sig = html; }
}
document.getElementById("btn-load-saved-team")?.addEventListener("click", () => {
  const t = builder.teams[document.getElementById("lobby-saved-team-select")?.value];
  const input = document.getElementById("lobby-team-input");
  if (t && input) { input.value = exportShowdownTeam(t.mons); input.focus(); }
});
function evSavedPicker() {
  if (!currentUser) return "";
  if (!builder.loaded) { ensureMyTeamsLoaded().then(() => { if (openEventId) renderEventDetail(); }).catch(() => {}); return ""; }
  const html = savedTeamOptionsHtml();
  return html ? `<div class="saved-team-row"><select id="ev-saved-team">${html}</select><button type="button" class="btn-leave-small" data-ev-act="load-saved-team">📂 ใช้ทีมที่บันทึกไว้</button></div>` : "";
}