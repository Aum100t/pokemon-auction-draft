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
  const auctionSelector = document.getElementById("create-auction-selector").value;
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
      mode, auctionSelector, hostParticipation, phases, bestOf, checkIn, topCut, swissRounds,
      startMoney: 10000,
      minBidIncrement: 50,
      timerSeconds: 10,
      teamSize: 10
    },
    players: {
      [playerId]: {
        name: name,
        userUid: currentUser?.uid || null,
        money: 10000,
        isHost: true,
        isSpectator: hostParticipation === "spectator",
        joinedAt: Date.now(),
        pickTicketUsed: false,
        banTicketUsed: false,
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
  const requiresTeamSheet = room.settings?.mode !== "auction";
  const playersMissingTeamSheet = requiresTeamSheet ? playerIds.filter(pid => !hasSubmittedTeamSheet(players[pid])) : [];
  const submittedTeamSheets = playerIds.length - playersMissingTeamSheet.length;

  document.getElementById("lobby-count").textContent = `ผู้เล่น ${playerIds.length}/${maxPlayers}`;
  const teamSheetCount = document.getElementById("lobby-team-sheet-count");
  if (teamSheetCount) {
    teamSheetCount.classList.toggle("hidden", !requiresTeamSheet);
    if (requiresTeamSheet) teamSheetCount.innerHTML = `<span>📄 Team Sheet</span><b>${submittedTeamSheets}/${playerIds.length || 0} คนส่งแล้ว</b><div class="team-sheet-progress-bar"><i style="width:${playerIds.length ? Math.round(submittedTeamSheets / playerIds.length * 100) : 0}%"></i></div>`;
  }

  const listEl = document.getElementById("lobby-player-list");
  listEl.innerHTML = "";
  Object.keys(players).forEach((pid) => {
    const p = players[pid];
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.name)}</span>${p.isHost ? '<span class="badge">HOST</span>' : ''}${p.isSpectator ? '<span class="badge">SPECTATOR</span>' : ''}${requiresTeamSheet && !p.isSpectator ? (hasSubmittedTeamSheet(p) ? '<span class="badge team-sheet-ready">📄 ส่ง Team Sheet แล้ว</span>' : '<span class="badge team-sheet-missing">⏳ รอ Team Sheet</span>') : ''}`;
    listEl.appendChild(li);
  });

  if (isHost) {
    const startBtn = document.getElementById("btn-start");
    startBtn.disabled = playerIds.length < 2 || playersMissingTeamSheet.length > 0;
    startBtn.textContent = playerIds.length < 2
      ? "รอผู้เล่น... (อย่างน้อย 2 คน)"
      : !requiresTeamSheet
        ? `เริ่มประมูล (${playerIds.length} คน)`
        : playersMissingTeamSheet.length
          ? `รอ Team Sheet อีก ${playersMissingTeamSheet.length} คน`
          : `เริ่มเกม (${playerIds.length} คน • ส่ง Team Sheet ครบแล้ว)`;
  }

  renderLobbyTeamEditor(room);
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
  const requiresTeamSheet = room.settings?.mode !== "auction";
  editor.classList.toggle("hidden", !!player?.isSpectator || !requiresTeamSheet);
  if (player?.isSpectator || !requiresTeamSheet) return;
  if (!player) return;
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
  (room.tournament?.history||[]).forEach(round => round.matches.forEach(m => { if (!m.winnerId || m.isBye) return; const loser=m.winnerId===m.player1Id?m.player2Id:m.player1Id; if(stats[m.winnerId]) {stats[m.winnerId].wins++;stats[m.winnerId].points+=3;stats[m.winnerId].played++;} if(stats[loser]) {stats[loser].losses++;stats[loser].played++;} }));
  return Object.values(stats).sort((a,b)=>b.points-a.points||b.wins-a.wins||a.name.localeCompare(b.name));
}
function shouldCheckIn(room) {
  const t=room.tournament, policy=room.settings.checkIn; return policy === "everyRound" || (policy === "once" && t.round === 0) || (policy === "perPhase" && t.round === 0);
}
async function startTournament(roomId) {
  await runTransaction(ref(db,"rooms/"+roomId), room => {
    if(!room || room.status !== "waiting") return room;
    if (room.settings?.mode !== "auction" && competitivePlayerIds(room).some(pid => !hasSubmittedTeamSheet(room.players?.[pid]))) return room;
    room.status="tournament"; room.tournament=initialTournament(room); return room;
  });
}
function completeTournamentInTransaction(room, winnerId) {
  room.tournament.championId=winnerId||null; room.status="completed"; room.completedAt=Date.now();
  // ล้างข้อความทุกประเภททันทีที่ระบบตัดสินว่ารายการจบ
  room.chat=null; room.matchChats=null; room.adminChat=null; room.adminCalls=null;
}
async function beginNextRound() {
  await updateRoom(room => {
    if(currentPlayerId !== room.hostId || room.status !== "tournament") return room;
    const t=room.tournament; if(t.phaseComplete) return room;
    let format=room.settings.phases[t.phaseIndex];
    Object.keys(t.pendingWithdrawals||{}).forEach(pid => room.players[pid].withdrawn=true); t.pendingWithdrawals={};
    let ids=(t.phaseParticipants||activePlayerIds(room)).filter(pid=>!room.players[pid].withdrawn), stats=tournamentStats(room);
    if (t.started && t.history.length) {
      const previous=t.history[t.history.length-1];
      previous.matches.forEach(m => { if(!m.winnerId && m.pendingWinnerId && Date.now()-m.reportedAt >= 10000) {m.winnerId=m.pendingWinnerId;m.score=m.pendingScore;} });
      const incomplete=previous.matches.some(m=>!m.winnerId); if(incomplete) return room;
      if(format === "single") ids=previous.matches.filter(m=>m.winnerId).map(m=>m.winnerId);
      if(format === "double") { t.losses=t.losses||{}; previous.matches.forEach(m=>{if(!m.isBye&&m.winnerId){const loser=m.winnerId===m.player1Id?m.player2Id:m.player1Id;t.losses[loser]=(t.losses[loser]||0)+1;}}); ids=ids.filter(pid=>(t.losses[pid]||0)<2); }
      const rrRounds=format === "roundRobin" ? generateRoundRobinSchedule(ids).length : 0;
      const phaseEnded=(format === "single" || format === "double") && ids.length<=1 || (format === "swiss" && t.round+1 >= (room.settings.swissRounds||3)) || (format === "roundRobin" && t.round+1 >= rrRounds);
      if(phaseEnded) {
        if(t.phaseIndex+1 < room.settings.phases.length) { t.phaseComplete=true; return room; }
        const winner=(format === "single" || format === "double") ? ids[0] : tournamentStats(room).filter(s=>!room.players[s.pid].withdrawn)[0]?.pid;
        completeTournamentInTransaction(room,winner); return room;
      }
      else t.round++;
    }
    if(shouldCheckIn(room)) { const checked=Object.keys(t.checkins||{}).filter(pid=>t.checkins[pid]); if(!checked.length) {t.checkinRequired=true; return room;} ids=ids.filter(pid=>checked.includes(pid)); t.checkins={}; t.checkinRequired=false; }
    const matches = format === "roundRobin" ? generateRoundRobinSchedule(ids)[t.round % Math.max(1,ids.length-1)]?.matches || [] : makePairs(ids,stats);
    t.history.push({phaseIndex:t.phaseIndex,round:t.round+1,format,matches}); t.started=true; return room;
  });
}
async function advanceTournamentPhase() {
  await updateRoom(room => {
    if(currentPlayerId!==room.hostId || room.status!=="tournament") return room;
    const t=room.tournament; if(t.phaseIndex+1 >= room.settings.phases.length) return room;
    const last=t.history[t.history.length-1]; if(last?.matches.some(m=>!m.winnerId)) return room;
    // นำอันดับถัดไปมาแทนที่ผู้ถอนตัวทันทีตอนคัด Top
    Object.keys(t.pendingWithdrawals||{}).forEach(pid=>room.players[pid].withdrawn=true); t.pendingWithdrawals={};
    const cut=room.settings.topCut||activePlayerIds(room).length;
    t.phaseParticipants=tournamentStats(room).filter(s=>!room.players[s.pid].withdrawn).slice(0,cut).map(s=>s.pid);
    t.phaseIndex++; t.round=0; t.history=[]; t.started=false; t.checkins={}; t.phaseComplete=false; return room;
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
    const moves = lines.filter(line => /^-\s+/.test(line)).map(line => line.replace(/^-\s+/, "").trim());
    return { pokemon, moves, item: itemPart.trim(), nature };
  }).filter(member => member.pokemon).slice(0, 6);
}
function tournamentTeamOf(player) {
  if (Array.isArray(player?.team) && player.team.length) return player.team.map(member => ({
    pokemon: member.displayName || "Pokémon",
    moves: [],
    item: member.price ? `ประมูล ${Number(member.price).toLocaleString()}` : (member.viaTicket ? "รับจากตั๋ว" : (member.viaRandom ? "สุ่มให้" : "")),
    nature: ""
  }));
  return parseTeamSheetProfile(player?.teamSheet || player?.teamText);
}
function profileOf(player) { return tournamentTeamOf(player); }
function teamPreviewHtml(player, key) {
  const profile=profileOf(player); if(!profile.length) return `<p class="small-text">ยังไม่ได้บันทึกข้อมูลทีม</p>`;
  const source = Array.isArray(player?.team) && player.team.length ? "ทีมจากการประมูล" : "Team Sheet";
  return `<button class="team-toggle" data-team-toggle="${key}">👁️ ดูทีมของ ${escapeHtml(player?.name || "ผู้เล่น")}</button><div id="team-preview-${key}" class="team-preview hidden"><b class="team-preview-owner">${source} ของ ${escapeHtml(player?.name || "ผู้เล่น")}</b>${profile.map(p=>`<div><b>${escapeHtml(p.pokemon)}</b>${p.item?` — ${escapeHtml(p.item)}`:""}${p.nature?` (${escapeHtml(p.nature)})`:""}${p.moves?.length?`<br><span class="small-text">${p.moves.map(escapeHtml).join(" · ")}</span>`:""}</div>`).join("")}</div>`;
}
function bindTeamToggles(root) { root.querySelectorAll("button[data-team-toggle]").forEach(btn=>btn.addEventListener("click",()=>document.getElementById("team-preview-"+btn.dataset.teamToggle)?.classList.toggle("hidden"))); }
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
    const context = currentMatchContext(room, currentPlayerId);
    const duplicate = Object.values(room.adminCalls || {}).some(call => call.playerId === currentPlayerId && call.matchKey === context.matchKey && call.status !== "closed");
    if (duplicate) { status.textContent = "มีคำขอสำหรับคู่นี้อยู่แล้ว"; return; }
    try {
      await push(ref(db,`rooms/${currentRoomId}/adminCalls`),{playerId:currentPlayerId,name:room.players[currentPlayerId]?.name||"ผู้เล่น",time:Date.now(),status:"open",...context});
      status.textContent = `ส่งคำขอเรียกแอดมินแล้ว (${context.matchLabel})`;
    } catch (error) { console.error("admin call failed:", error); status.textContent = "ส่งคำขอไม่สำเร็จ กรุณาลองใหม่"; }
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
  // รองรับห้องเก่าที่สร้างก่อนเพิ่มตัวเลือกรูปแบบการแข่งขัน
  room.settings={maxPlayers:4,mode:"normal",phases:["swiss"],bestOf:"BO1",checkIn:"once",...room.settings,phases:room.settings?.phases?.length?room.settings.phases:["swiss"]};
  const t=room.tournament||initialTournament(room), phase=room.settings.phases[t.phaseIndex]||"swiss", stats=tournamentStats(room), current=t.history[t.history.length-1];
  const amSpectator=!!room.players[currentPlayerId]?.isSpectator;
  document.getElementById("tournament-room-code").textContent=currentRoomId;
  document.getElementById("tournament-meta").textContent=`เฟส ${t.phaseIndex+1}/${room.settings.phases.length}: ${tournamentLabel(phase)} • ${room.settings.bestOf} • ผู้เล่นสมัคร ${competitivePlayerIds(room).length}/${room.settings.maxPlayers}`;
  document.getElementById("tournament-date").textContent=`เริ่มการแข่งขัน: ${formatTournamentDate(room.createdAt)}${room.completedAt?` • จบ: ${formatTournamentDate(room.completedAt)}`:""}`;
  if(room.status === "tournament") mountAdminChat(room);
  syncAdminCallDrawer(room);
  const editor=document.getElementById("team-profile-input"); editor?.closest(".team-editor")?.classList.add("hidden");
  const check=document.getElementById("tournament-checkin"), need=shouldCheckIn(room)&&(!current||current.matches.every(m=>m.winnerId)), checkedCount=Object.keys(t.checkins||{}).filter(pid=>t.checkins[pid]).length, eligibleCount=activePlayerIds(room).length; check.innerHTML=need?`<div class="checkin-content"><span class="checkin-icon">✅</span><div><b>เช็คอินสำหรับรอบถัดไป</b><span class="small-text">${checkedCount}/${eligibleCount} คนเช็คอินแล้ว • ${room.settings.checkIn}</span></div>${amSpectator?"<span class=\"small-text\">ผู้สังเกตการณ์ไม่ต้องเช็คอิน</span>":`<button id="btn-checkin" ${t.checkins?.[currentPlayerId]?"disabled":""}>${t.checkins?.[currentPlayerId]?"เช็คอินแล้ว ✓":"เช็คอิน"}</button>`}</div>${t.checkinRequired?"<p class=\"checkin-warning\">รอผู้เล่นเช็คอินก่อนเริ่มรอบถัดไป</p>":""}`:""; document.getElementById("btn-checkin")?.addEventListener("click",()=>tournamentAction("checkin"));
  const pairs=document.getElementById("tournament-pairings");
  if(t.championId) pairs.innerHTML=`<div class="match-card"><h3>👑 แชมป์: ${escapeHtml(room.players[t.championId]?.name||"-")}</h3></div>`;
  else if(!current) { pairs.innerHTML=`<p class="small-text">กำลังสร้างคู่แข่งขันรอบแรก...</p>`; ensureFirstTournamentRound(); }
  else pairs.innerHTML=`<h3>รอบ ${current.round} — ${tournamentLabel(current.format)}</h3>`+current.matches.map((m,i)=>{const a=room.players[m.player1Id]?.name||"-",b=m.player2Id?room.players[m.player2Id]?.name:"BYE",canReport=isHost||currentPlayerId===m.player1Id||currentPlayerId===m.player2Id,chatId=`match-chat-${t.history.length-1}-${i}`; const scoreOptions=room.settings.bestOf==="BO3"?'<option value="2-0">2 – 0</option><option value="2-1">2 – 1</option><option value="1-2">1 – 2</option><option value="0-2">0 – 2</option>':'<option value="1-0">1 – 0</option><option value="0-1">0 – 1</option>'; const controls=canReport&&!m.isBye&&!m.winnerId?`<div class="report-controls score-entry"><div class="score-entry-title"><span>🏁 บันทึกผลการแข่งขัน</span><small>สกอร์เรียง: ${escapeHtml(a)} – ${escapeHtml(b)}</small></div><label><span>เลือกสกอร์</span><select data-score-match="${i}">${scoreOptions}</select></label><button data-save-result="${i}">✓ ยืนยันผล</button></div>`:""; const chat=canReport&&!m.isBye?`<div class="match-chat"><b>💬 แชทเฉพาะคู่แข่งขัน</b><div class="chat-messages" id="${chatId}-messages"></div><div class="chat-input-row"><input id="${chatId}-input" maxlength="300" placeholder="คุยกับคู่แข่ง"><button id="${chatId}-send">ส่ง</button></div></div>`:""; const pending=m.pendingWinnerId?`รายงาน: ${escapeHtml(room.players[m.pendingWinnerId]?.name||"")} ชนะ (${m.pendingScore||"-"}) — แก้ไขได้ 10 วินาที` : "รอรายงานผล";return `<div class="match-card"><div class="match-players"><span>${escapeHtml(a)}</span><span class="vs">VS</span><span>${escapeHtml(b)}</span></div><p class="small-text">${m.isBye?"ชนะบาย":m.winnerId?`ผู้ชนะ: ${escapeHtml(room.players[m.winnerId]?.name||"")} (${m.score||"-"})`:pending}</p>${controls}${teamPreviewHtml(room.players[m.player1Id],`match-${i}-a`)}${m.player2Id?teamPreviewHtml(room.players[m.player2Id],`match-${i}-b`):""}${chat}</div>`}).join("");
  pairs.querySelectorAll("button[data-save-result]").forEach(button=>button.addEventListener("click",()=>{const matchIndex=+button.dataset.saveResult,match=current.matches[matchIndex],score=pairs.querySelector(`[data-score-match="${matchIndex}"]`)?.value;const winner=String(score).startsWith("2")||score==="1-0"?match.player1Id:match.player2Id;tournamentAction("result",{round:t.history.length-1,match:matchIndex,winner,score});}));
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
  const activeTournament=room.status==="tournament";
  document.getElementById("btn-next-round").classList.toggle("hidden",!isHost||!activeTournament||t.phaseComplete); document.getElementById("btn-next-round").onclick=beginNextRound;
  document.getElementById("btn-advance-phase").classList.toggle("hidden",!isHost || !activeTournament || !t.phaseComplete || t.phaseIndex+1>=room.settings.phases.length); document.getElementById("btn-advance-phase").onclick=advanceTournamentPhase;
  document.getElementById("btn-finish-tournament").classList.toggle("hidden",!isHost||!activeTournament); document.getElementById("btn-finish-tournament").onclick=()=>finishTournament(room);
  const withdrawn=!!room.players[currentPlayerId]?.withdrawn; const withdrawButton=document.getElementById("btn-withdraw"); withdrawButton.classList.toggle("hidden",withdrawn||amSpectator||!activeTournament); document.getElementById("btn-cancel-withdraw").classList.add("hidden"); withdrawButton.onclick=async()=>{if(!confirm("ยืนยันถอนตัว? คุณจะกลับเข้ารายการนี้ไม่ได้")) return; withdrawButton.disabled=true; const saved=await tournamentAction("withdraw"); if(saved) document.getElementById("admin-call-status").textContent="ถอนตัวสำเร็จแล้ว"; withdrawButton.disabled=false;};
  const table=document.getElementById("tournament-standings"); table.innerHTML=`<tr><th>#</th><th>ผู้เล่น</th><th>ชนะ</th><th>แพ้</th><th>แต้ม</th><th>ทีม</th></tr>`+stats.map((s,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(s.name)}${room.players[s.pid].withdrawn?" (ถอนตัว)":""}</td><td>${s.wins}</td><td>${s.losses}</td><td>${s.points}</td><td>${teamPreviewHtml(room.players[s.pid],`standing-${s.pid}`)}</td></tr>`).join(""); bindTeamToggles(table);
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
  const missingTeamSheets = current.settings?.mode === "auction" ? [] : competitivePlayerIds(current).filter(pid => !hasSubmittedTeamSheet(current.players?.[pid]));
  if (missingTeamSheets.length) {
    alert(`ยังเริ่มไม่ได้: รอ Team Sheet จากผู้เล่นอีก ${missingTeamSheets.length} คน`);
    renderLobby(current);
    return;
  }
  if (current?.settings?.mode === "normal") {
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
      if (latest.settings?.mode !== "auction" && competitivePlayerIds(latest).some(pid => !hasSubmittedTeamSheet(latest.players?.[pid]))) return latest;
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
  if (room.settings?.auctionSelector === "organizer") return;
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

  if (noOneCanBid || onlyOneLeft) fillTeamsRandomly(room);

  const allFull = players.every(
    p => (p.team ? p.team.length : 0) >= teamSize
  );
  const poolExhausted = Object.values(room.pool).every(
    p => p.status !== "available" && p.status !== "auctioning"
  );
  if (noOneCanBid || onlyOneLeft || allFull || poolExhausted) {
    room.status = "tournament";
    room.tournament = initialTournament(room);
  }
}

// ---------- Actions ----------
async function nominatePokemon(poolKey) {
  await updateRoom((room) => {
    if (room.status !== "picking" || room.auction) return room;
    const organizerSelects = room.settings?.auctionSelector === "organizer";
    if (organizerSelects ? currentPlayerId !== room.hostId : room.turnOrder[room.currentTurnIndex] !== currentPlayerId) return room;
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

  const organizerSelects = room.settings?.auctionSelector === "organizer";
  const myTurnPid = organizerSelects ? room.hostId : room.turnOrder[room.currentTurnIndex];
  const isMyTurn = myTurnPid === currentPlayerId;
  const me = room.players[currentPlayerId];
  const meFull = (me.team?.length || 0) >= room.settings.teamSize;

  const turnIndicator = document.getElementById("turn-indicator");
  if (organizerSelects) {
    turnIndicator.textContent = isHost
      ? "🧭 คุณเป็นผู้จัด เลือกโปเกม่อนขึ้นประมูลได้"
      : `🧭 ผู้จัด (${room.players[room.hostId]?.name || "-"}) กำลังเลือกโปเกม่อนขึ้นประมูล`;
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
      const canNominate = room.settings?.auctionSelector === "organizer" ? isHost : isMyTurn;
      if (poke.status === "available" && !room.auction && canNominate) {
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
  grid.innerHTML = competitivePlayerIds(room).map(pid => [pid, room.players[pid]]).map(([pid, p]) => `
    <article class="team-summary-card draft-team-card">
      <div class="draft-team-heading"><div><h4>${escapeHtml(p.name)}${pid === room.hostId ? ' <span class="badge">HOST</span>' : ''}</h4><p class="small-text">ทีมจากการประมูล</p></div><div class="team-count-badge">${(p.team || []).length}/${room.settings.teamSize}</div></div>
      <div class="draft-team-meta"><span>💰 ${(p.money || 0).toLocaleString()}</span><span>🎒 ${(p.team || []).length} ตัว</span></div>
      <div class="draft-team-roster">
        ${(p.team || []).map(t => `
          <div class="team-slot draft-pokemon-card">
            <img src="${t.sprite}" alt="">
            <span>${t.displayName}${t.isMega ? ' 🌟' : ''}</span>
            ${t.price ? `<span class="price-tag">💰${t.price.toLocaleString()}</span>` : (t.viaTicket ? '<span class="price-tag">🎫 ตั๋ว</span>' : (t.viaRandom ? '<span class="price-tag">🎲 สุ่มให้</span>' : ''))}
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

  try {
    if (roomId && playerId) {
      try { await onDisconnect(ref(db, `rooms/${roomId}/players/${playerId}`)).cancel(); } catch (e) {}

      if (preservePlayer) {
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
  if (!canManageRoom(roomSnap.val())) { alert("คุณดูแลได้เฉพาะทัวร์นาเมนต์ที่คุณสร้างเอง"); return; }
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
    const scoreOptions = room.settings?.bestOf === "BO3"
      ? '<option value="2-0">2-0</option><option value="2-1">2-1</option><option value="1-2">1-2</option><option value="0-2">0-2</option>'
      : '<option value="1-0">1-0</option><option value="0-1">0-1</option>';
    const result = `<div class="admin-result-form"><span class="small-text">${match.winnerId ? `ผลปัจจุบัน: ${escapeHtml(room.players?.[match.winnerId]?.name || "-")} (${escapeHtml(match.score || "-")})` : "ยังไม่บันทึกผล"}</span><select id="${id}-winner"><option value="${match.player1Id}">${escapeHtml(a)} ชนะ</option><option value="${match.player2Id}">${escapeHtml(b)} ชนะ</option></select><select id="${id}-score">${scoreOptions}</select><button class="primary" data-admin-result-round="${roundIndex}" data-admin-result-match="${matchIndex}">💾 บันทึกผล</button></div>`;
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
    return `<article class="team-summary-card draft-team-card"><div class="draft-team-heading"><div><h4>${escapeHtml(player.name)}${playerId === room.hostId ? ' <span class="badge">HOST</span>' : ''}</h4><p class="small-text">ทีมจากการประมูล</p></div><div class="team-count-badge">${team.length}/${room.settings?.teamSize || 10}</div></div><div class="draft-team-meta"><span>💰 ${(player.money || 0).toLocaleString()}</span><span>🎒 ${team.length} ตัว</span></div><div class="draft-team-roster">${team.map(member => `<div class="team-slot draft-pokemon-card"><img src="${member.sprite}" alt=""><span>${escapeHtml(member.displayName)}${member.isMega ? ' 🌟' : ''}</span>${member.price ? `<span class="price-tag">💰${member.price.toLocaleString()}</span>` : (member.viaTicket ? '<span class="price-tag">🎫 ตั๋ว</span>' : (member.viaRandom ? '<span class="price-tag">🎲 สุ่มให้</span>' : ''))}</div>`).join("") || '<span class="small-text">ยังไม่มีโปเกม่อนจากการประมูล</span>'}</div></article>`;
  }).join("") || '<p class="small-text">ยังไม่มีผู้เล่นในห้อง</p>';
}

async function saveAdminMatchResult(roomId, roundIndex, matchIndex, winnerId, score) {
  const roomSnap = await get(ref(db, `rooms/${roomId}`));
  const room = roomSnap.val();
  if (!room || !canManageRoom(room)) throw new Error("Not allowed");
  const match = room.tournament?.history?.[roundIndex]?.matches?.[matchIndex];
  const validScore = room.settings?.bestOf === "BO3" ? /^(2-[01]|[01]-2)$/.test(score) : score === "1-0" || score === "0-1";
  const winnerMatchesScore = winnerId === match?.player1Id ? (score.startsWith("2") || score === "1-0") : (score.endsWith("2") || score === "0-1");
  if (!match || match.isBye || !validScore || !winnerMatchesScore || ![match.player1Id, match.player2Id].includes(winnerId)) throw new Error("Invalid result");
  await runTransaction(ref(db, `rooms/${roomId}/tournament`), tournament => {
    const currentMatch = tournament?.history?.[roundIndex]?.matches?.[matchIndex];
    if (!currentMatch) return tournament;
    currentMatch.winnerId = winnerId;
    currentMatch.score = score;
    currentMatch.pendingWinnerId = null;
    currentMatch.pendingScore = null;
    currentMatch.reportedAt = Date.now();
    currentMatch.reportedBy = `admin:${currentUser?.uid || "unknown"}`;
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
