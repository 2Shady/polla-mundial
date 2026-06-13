/* ============================================================
   Polla Mundial 2026 — app.js (Día 6)
   Nuevo hoy:
   - Autosellado del UID admin al validar el PIN (para las reglas
     de seguridad de Firestore).
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, getDocs, getDoc, setDoc, doc, runTransaction,
  serverTimestamp, updateDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCPZ_yh1EDj6RK1RvV5WXJiq7rAIR0d2lU",
  authDomain: "polla-mundial-2026-ca093.firebaseapp.com",
  projectId: "polla-mundial-2026-ca093",
  storageBucket: "polla-mundial-2026-ca093.firebasestorage.app",
  messagingSenderId: "224627178926",
  appId: "1:224627178926:web:4b0e99d10284bc1aa1dc3f"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ====== Estado global ====== */
const state = {
  uid: null,
  participant: null,
  participants: [],
  config: null,       // config/global
  matches: [],        // partidos ordenados
  myM1: null,         // mi predicción de Módulo 1
  myM2: {},           // { matchId: { colombiaGoals, opponentGoals } }
  allM1: {},          // { participantId: pred }  — para el motor de puntos
  allM2: {},          // { participantId: { matchId: pred } }
  scores: []          // ranking calculado [{ participant, m1, m2, total, exactos }]
};

/* ====== Utilidades ====== */
const $ = (sel) => document.querySelector(sel);

const fmtColombia = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  weekday: "short", day: "numeric", month: "short",
  hour: "numeric", minute: "2-digit", hour12: true
});
const horaCol = (ts) => fmtColombia.format(ts.toDate()) + " (Col)";

const fmtCortoCol = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  weekday: "short", day: "numeric", month: "short",
  hour: "numeric", minute: "2-digit", hour12: true
});
const horaColCorta = (ts) => fmtCortoCol.format(ts.toDate());

const FASE_LABEL = {
  groups: "Fase de grupos",
  r32: "Dieciseisavos",
  r16: "Octavos",
  qf: "Cuartos de final",
  sf: "Semifinal",
  final: "Final"
};

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const RONDAS = [
  { value: "groups",   label: "Eliminada en fase de grupos (0 pts)" },
  { value: "r32",      label: "Dieciseisavos — Round of 32 (5 pts)" },
  { value: "r16",      label: "Octavos — Round of 16 (10 pts)" },
  { value: "qf",       label: "Cuartos de final (15 pts)" },
  { value: "sf",       label: "Semifinal (20 pts)" },
  { value: "final",    label: "Final — subcampeona (25 pts)" },
  { value: "champion", label: "¡Campeona del mundo! (30 pts)" }
];

/* Estado efectivo de un partido (el override del admin manda) */
function matchStatus(m) {
  if (m.colombiaGoals !== null && m.opponentGoals !== null) return "finished";
  if (m.manualOverride === "open") return "open";
  if (m.manualOverride === "closed") return "closed";
  return Date.now() < m.predictionDeadlineUtc.toDate().getTime() ? "open" : "closed";
}

/* Puntos de una predicción de partido (regla: 12 exacto, 5 G/E/P, 0) */
function puntosPartido(pred, m) {
  if (!pred || m.colombiaGoals === null) return null;
  if (pred.colombiaGoals === m.colombiaGoals && pred.opponentGoals === m.opponentGoals) return 12;
  const signo = (a, b) => Math.sign(a - b);
  return signo(pred.colombiaGoals, pred.opponentGoals) === signo(m.colombiaGoals, m.opponentGoals) ? 5 : 0;
}

/* ============================================================
   MOTOR DE PUNTOS (derivado — no se almacena)
   Recorre a los 10 participantes y calcula M1 + M2, exactos y
   el ranking. Se ejecuta en cada carga y tras cada cambio.
   ============================================================ */
const PTS_RONDA = { groups: 0, r32: 5, r16: 10, qf: 15, sf: 20, final: 25, champion: 30 };

function puntosM1(pred) {
  if (!pred) return 0;
  const r = state.config.m1Results || {};
  let pts = 0;
  if (r.champion && pred.champion === r.champion) pts += 25;
  if (r.runnerUp && pred.runnerUp === r.runnerUp) pts += 15;
  // topScorers es un array: la Bota de Oro puede quedar compartida
  if (r.topScorers && r.topScorers.length && r.topScorers.includes(pred.topScorer)) pts += 15;
  if (r.colombiaRound && pred.colombiaRound === r.colombiaRound) pts += PTS_RONDA[r.colombiaRound] ?? 0;
  return pts;
}

function computeScores() {
  const finishedPortugal = state.matches.find(
    (m) => m.id === "g3-portugal" && m.colombiaGoals !== null
  );

  const filas = state.participants.map((p) => {
    const m1 = puntosM1(state.allM1[p.id]);
    let m2 = 0;
    let exactos = 0;
    let exactoPortugal = false;

    state.matches.forEach((m) => {
      const pred = state.allM2[p.id]?.[m.id];
      const pts = puntosPartido(pred, m);
      if (pts !== null) {
        m2 += pts;
        if (pts === 12) {
          exactos++;
          if (m.id === "g3-portugal") exactoPortugal = true;
        }
      }
    });

    return { participant: p, m1, m2, total: m1 + m2, exactos, exactoPortugal };
  });

  // Ranking: total desc → desempate por exactos desc
  filas.sort((a, b) => b.total - a.total || b.exactos - a.exactos);
  state.scores = filas;

  // Premio mejor exacto: máximo de exactos excluyendo el top 3 del ranking
  state.mejorExacto = computeMejorExacto(filas, finishedPortugal);
}

function computeMejorExacto(filasOrdenadas, portugalJugado) {
  const top3Ids = filasOrdenadas.slice(0, 3).map((f) => f.participant.id);
  const elegibles = filasOrdenadas.filter(
    (f) => !top3Ids.includes(f.participant.id) && f.exactos > 0
  );
  if (!elegibles.length) return { ganadores: [], maxExactos: 0 };

  const maxExactos = Math.max(...elegibles.map((f) => f.exactos));
  let candidatos = elegibles.filter((f) => f.exactos === maxExactos);

  // Desempate 1: quien acertó el exacto de Colombia vs Portugal
  if (candidatos.length > 1 && portugalJugado) {
    const conPortugal = candidatos.filter((f) => f.exactoPortugal);
    if (conPortugal.length >= 1 && conPortugal.length < candidatos.length) {
      candidatos = conPortugal;
    }
  }
  // Desempate 2: comparten el premio (se devuelven todos)
  return { ganadores: candidatos.map((f) => f.participant), maxExactos };
}

/* ============================================================
   ARRANQUE
   ============================================================ */
signInAnonymously(auth).catch((err) => {
  showWhoError("No pude conectar con la base de datos. Revisa tu internet. (" + err.code + ")");
});

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  state.uid = user.uid;

  await loadParticipants();

  const savedId = localStorage.getItem("participantId");
  const mine = state.participants.find(
    (p) => p.id === savedId && p.claimedByUid === state.uid
  );

  if (mine) {
    state.participant = mine;
    await enterApp();
  } else {
    localStorage.removeItem("participantId");
    showWhoScreen();
  }
});

/* ============================================================
   CARGA DE DATOS
   ============================================================ */
async function loadParticipants() {
  const snap = await getDocs(collection(db, "participants"));
  state.participants = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

async function loadGameData() {
  const [configSnap, matchesSnap, m1Snap, m2Snap] = await Promise.all([
    getDoc(doc(db, "config", "global")),
    getDocs(collection(db, "matches")),
    getDocs(collection(db, "m1_predictions")),
    getDocs(collection(db, "m2_predictions"))
  ]);

  state.config = configSnap.data();

  state.matches = matchesSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  // Predicciones Módulo 1 de TODOS (la clave del doc es el participantId)
  state.allM1 = {};
  m1Snap.docs.forEach((d) => { state.allM1[d.id] = d.data(); });
  state.myM1 = state.allM1[state.participant.id] || null;

  // Predicciones Módulo 2 de TODOS, agrupadas por participante
  state.allM2 = {};
  state.myM2 = {};
  m2Snap.docs.forEach((d) => {
    const data = d.data();
    if (!state.allM2[data.participantId]) state.allM2[data.participantId] = {};
    state.allM2[data.participantId][data.matchId] = data;
    if (data.participantId === state.participant.id) {
      state.myM2[data.matchId] = data;
    }
  });

  computeScores();
}

/* ============================================================
   PANTALLA "¿QUIÉN ERES?"
   ============================================================ */
function showWhoScreen() {
  const grid = $("#who-grid");
  grid.innerHTML = "";

  state.participants.forEach((p) => {
    const btn = document.createElement("button");
    btn.className = "who-btn";
    btn.textContent = p.name;
    const takenByOther = p.claimedByUid && p.claimedByUid !== state.uid;
    if (takenByOther) {
      btn.disabled = true;
      btn.title = "Este nombre ya fue tomado en otro celular";
    }
    btn.addEventListener("click", () => claimName(p));
    grid.appendChild(btn);
  });

  $("#screen-loading").classList.add("hidden");
  $("#app").classList.add("hidden");
  $("#screen-who").classList.remove("hidden");
}

async function claimName(p) {
  hideWhoError();
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "participants", p.id);
      const snap = await tx.get(ref);
      const data = snap.data();
      if (data.claimedByUid && data.claimedByUid !== state.uid) {
        throw new Error("ocupado");
      }
      tx.update(ref, { claimedByUid: state.uid });
    });
    state.participant = { ...p, claimedByUid: state.uid };
    localStorage.setItem("participantId", p.id);
    await enterApp();
  } catch (err) {
    if (err.message === "ocupado") {
      showWhoError(`"${p.name}" acaba de ser tomado en otro celular. Si eres tú, avísale al administrador.`);
      await loadParticipants();
      showWhoScreen();
    } else {
      showWhoError("Algo falló al guardar. Intenta de nuevo. (" + err.message + ")");
    }
  }
}

function showWhoError(msg) {
  const el = $("#who-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function hideWhoError() { $("#who-error").classList.add("hidden"); }

/* ============================================================
   APP PRINCIPAL
   ============================================================ */
async function enterApp() {
  await loadGameData();

  $("#header-greeting").textContent = "Hola, " + state.participant.name;
  if (state.participant.isAdmin) $("#tab-admin").classList.remove("hidden");

  $("#view-admin").innerHTML    = ph("El panel de admin llega el Día 5");

  renderTabla();
  renderPredecir();
  renderPartidos();
  renderPremios();
  if (state.participant.isAdmin) renderAdminGate();

  $("#screen-who").classList.add("hidden");
  $("#screen-loading").classList.add("hidden");
  $("#app").classList.remove("hidden");
}

function ph(texto) {
  return `<p class="placeholder"><i class="ti ti-barrier-block" style="font-size:28px; display:block; margin-bottom:8px;"></i>${texto}</p>`;
}

/* ============================================================
   VISTA TABLA (Ranking)
   ============================================================ */
function renderTabla() {
  const view = $("#view-tabla");
  const filas = state.scores;
  const torneoArrancado = filas.some((f) => f.total > 0);

  // Cabecera con pozo
  const pozo = (state.config.pozoTotal || 220000).toLocaleString("es-CO");

  let html = `
    <div class="tabla-header">
      <p class="tabla-pozo-label">Pozo acumulado</p>
      <p class="tabla-pozo display">$${pozo}</p>
      <p class="tabla-sub">${state.participants.length} participantes</p>
    </div>
  `;

  if (!torneoArrancado) {
    html += `<p class="placeholder"><i class="ti ti-hourglass-high" style="font-size:28px; display:block; margin-bottom:8px;"></i>
      La tabla se llena cuando empiecen a cargarse resultados.<br>Por ahora, ¡a pronosticar!</p>`;
    view.innerHTML = html;
    return;
  }

  const ultimoIdx = filas.length - 1;

  filas.forEach((f, i) => {
    const pos = i + 1;
    const esPodio = pos <= 3;
    const esUltimo = i === ultimoIdx && f.total >= 0;
    let cls = "rank-row";
    if (pos === 1) cls += " rank-gold";
    else if (pos === 2) cls += " rank-silver";
    else if (pos === 3) cls += " rank-bronze";
    if (esUltimo && !esPodio) cls += " rank-last";

    const medalla = esUltimo && !esPodio
      ? '<i class="ti ti-tools-kitchen-2"></i>'
      : pos;

    const castigo = esUltimo && !esPodio
      ? '<p class="rank-castigo">prepara el desayuno 😅</p>'
      : "";

    html += `
      <button class="${cls}" data-pid="${f.participant.id}">
        <span class="rank-pos">${medalla}</span>
        <span class="rank-name">
          ${f.participant.name}
          ${castigo}
        </span>
        <span class="rank-pts">${f.total}<small> pts</small></span>
        <i class="ti ti-chevron-down rank-chevron"></i>
      </button>
      <div class="rank-detail hidden" id="detail-${f.participant.id}">
        <p><span>Módulo 1 (torneo)</span> ${f.m1} pts</p>
        <p><span>Módulo 2 (partidos)</span> ${f.m2} pts</p>
        <p><span>Marcadores exactos</span> ${f.exactos}</p>
      </div>
    `;
  });

  view.innerHTML = html;

  // Expandir/colapsar detalle al tocar una fila
  view.querySelectorAll(".rank-row").forEach((row) => {
    row.addEventListener("click", () => {
      const det = $("#detail-" + row.dataset.pid);
      const chev = row.querySelector(".rank-chevron");
      det.classList.toggle("hidden");
      chev.style.transform = det.classList.contains("hidden") ? "" : "rotate(180deg)";
    });
  });
}

/* ============================================================
   VISTA PREDECIR
   ============================================================ */
function renderPredecir() {
  const view = $("#view-predecir");
  view.innerHTML = "";
  view.appendChild(buildM1Card());
  state.matches.forEach((m) => view.appendChild(buildMatchCard(m)));
}

/* ---------- Módulo 1 ---------- */
function buildM1Card() {
  const abierto = Date.now() < state.config.m1DeadlineUtc.toDate().getTime();
  const card = document.createElement("div");
  card.className = "card";

  const opciones = (lista, sel) =>
    lista.map((t) => `<option value="${t}" ${t === sel ? "selected" : ""}>${t}</option>`).join("");

  const m1 = state.myM1 || {};

  if (abierto) {
    card.innerHTML = `
      <div class="card-head">
        <p class="card-title">Pronósticos del torneo</p>
        <span class="badge badge-abierta">Abierto</span>
      </div>
      <p class="card-meta"><i class="ti ti-clock"></i> Cierra ${horaCol(state.config.m1DeadlineUtc)}</p>

      <label class="field-label" for="m1-champion">Campeón del mundial (25 pts)</label>
      <select id="m1-champion" class="field">
        <option value="">— Elige una selección —</option>
        ${opciones(state.config.teams, m1.champion)}
      </select>

      <label class="field-label" for="m1-runnerup">Subcampeón (15 pts)</label>
      <select id="m1-runnerup" class="field">
        <option value="">— Elige una selección —</option>
        ${opciones(state.config.teams, m1.runnerUp)}
      </select>

      <label class="field-label" for="m1-scorer">Goleador del torneo (15 pts)</label>
      <select id="m1-scorer" class="field">
        <option value="">— Elige un jugador —</option>
        ${opciones(state.config.topScorerCandidates, m1.topScorer)}
      </select>

      <label class="field-label" for="m1-round">¿Hasta dónde llega Colombia?</label>
      <select id="m1-round" class="field">
        <option value="">— Elige una ronda —</option>
        ${RONDAS.map((r) => `<option value="${r.value}" ${r.value === m1.colombiaRound ? "selected" : ""}>${r.label}</option>`).join("")}
      </select>

      <button id="btn-save-m1" class="btn-primary">Guardar pronósticos</button>
      <p id="m1-msg" class="form-msg hidden"></p>
    `;
    card.querySelector("#btn-save-m1").addEventListener("click", saveM1);
  } else {
    const ronda = RONDAS.find((r) => r.value === m1.colombiaRound);
    card.innerHTML = `
      <div class="card-head">
        <p class="card-title">Pronósticos del torneo</p>
        <span class="badge badge-cerrada">Cerrado</span>
      </div>
      ${state.myM1 ? `
        <div class="locked-grid">
          <p><span>Campeón</span>${m1.champion}</p>
          <p><span>Subcampeón</span>${m1.runnerUp}</p>
          <p><span>Goleador</span>${m1.topScorer}</p>
          <p><span>Colombia llega a</span>${ronda ? ronda.label : "—"}</p>
        </div>
      ` : `<p class="card-meta">No alcanzaste a enviar tus pronósticos antes del cierre — 0 pts en este módulo.</p>`}
    `;
  }
  return card;
}

async function saveM1() {
  const champion = $("#m1-champion").value;
  const runnerUp = $("#m1-runnerup").value;
  const topScorer = $("#m1-scorer").value;
  const colombiaRound = $("#m1-round").value;
  const msg = $("#m1-msg");

  if (!champion || !runnerUp || !topScorer || !colombiaRound) {
    msg.textContent = "Te falta llenar alguno de los 4 campos.";
    msg.className = "form-msg form-msg-error";
    return;
  }
  if (champion === runnerUp) {
    msg.textContent = "El campeón y el subcampeón no pueden ser la misma selección.";
    msg.className = "form-msg form-msg-error";
    return;
  }

  try {
    await setDoc(doc(db, "m1_predictions", state.participant.id), {
      champion, runnerUp, topScorer, colombiaRound,
      submittedAt: serverTimestamp(),
      editedByAdmin: false
    });
    state.myM1 = { champion, runnerUp, topScorer, colombiaRound };
    state.allM1[state.participant.id] = state.myM1;
    computeScores();
    renderTabla();
    renderPremios();
    confirmarBoton($("#btn-save-m1"), "Guardar pronósticos");
    msg.className = "form-msg hidden";
  } catch (err) {
    msg.textContent = "No se pudo guardar. Revisa tu internet e intenta de nuevo.";
    msg.className = "form-msg form-msg-error";
  }
}

/* ---------- Tarjetas de partido (Módulo 2) ---------- */
function buildMatchCard(m) {
  const status = matchStatus(m);
  const pred = state.myM2[m.id] || null;
  const card = document.createElement("div");
  card.className = "card";

  if (status === "open") {
    const cg = pred ? pred.colombiaGoals : 0;
    const og = pred ? pred.opponentGoals : 0;
    card.innerHTML = `
      <div class="card-head">
        <p class="card-title">Colombia vs ${m.opponent}</p>
        <span class="badge badge-abierta">Abierta</span>
      </div>
      <p class="card-meta"><i class="ti ti-clock"></i> Cierra ${horaCol(m.predictionDeadlineUtc)}</p>
      <div class="score-row">
        ${stepperHTML("Colombia", "cg", cg)}
        <span class="score-dash">–</span>
        ${stepperHTML(m.opponent, "og", og)}
      </div>
      <button class="btn-primary btn-save-match">Guardar marcador</button>
      <p class="form-msg hidden"></p>
    `;
    wireStepper(card, "cg");
    wireStepper(card, "og");
    card.querySelector(".btn-save-match").addEventListener("click", () => saveM2(m, card));
  } else if (status === "closed") {
    card.innerHTML = `
      <div class="card-head">
        <p class="card-title">Colombia vs ${m.opponent}</p>
        <span class="badge badge-cerrada">Cerrada</span>
      </div>
      <p class="card-meta">${pred
        ? `Tu predicción quedó: <strong>${pred.colombiaGoals} – ${pred.opponentGoals}</strong>. ¡Suerte!`
        : "No enviaste predicción a tiempo — 0 pts en este partido."}</p>
    `;
  } else { // finished
    const pts = puntosPartido(pred, m);
    const detalle = pts === 12 ? "¡marcador exacto!" : pts === 5 ? "acertaste el resultado" : "no acertaste esta vez";
    card.innerHTML = `
      <div class="card-head">
        <p class="card-title">Colombia vs ${m.opponent}</p>
        <span class="badge badge-final">Finalizado</span>
      </div>
      <p class="score-final display">${m.colombiaGoals} – ${m.opponentGoals}</p>
      <p class="card-meta" style="text-align:center;">${pred
        ? `Tu predicción: <strong>${pred.colombiaGoals} – ${pred.opponentGoals}</strong>`
        : "No enviaste predicción"}</p>
      ${pred ? `<p class="pill-row"><span class="pill ${pts > 0 ? "pill-gold" : "pill-neutral"}">${pts > 0 ? '<i class="ti ti-check"></i>' : ""} +${pts} pts · ${detalle}</span></p>` : ""}
    `;
  }
  return card;
}

function stepperHTML(nombre, key, valor) {
  return `
    <div class="stepper">
      <p class="stepper-name">${nombre}</p>
      <div class="stepper-controls">
        <button class="step-btn" data-step="${key}" data-dir="-1" aria-label="Menos goles ${nombre}">−</button>
        <span class="step-val" data-val="${key}">${valor}</span>
        <button class="step-btn" data-step="${key}" data-dir="1" aria-label="Más goles ${nombre}">+</button>
      </div>
    </div>
  `;
}

function wireStepper(card, key) {
  card.querySelectorAll(`.step-btn[data-step="${key}"]`).forEach((btn) => {
    btn.addEventListener("click", () => {
      const span = card.querySelector(`.step-val[data-val="${key}"]`);
      let v = parseInt(span.textContent, 10) + parseInt(btn.dataset.dir, 10);
      v = Math.max(0, Math.min(9, v)); // entre 0 y 9 goles
      span.textContent = v;
    });
  });
}

async function saveM2(m, card) {
  // Doble verificación del deadline en el cliente (la regla del
  // servidor lo bloqueará de verdad desde el Día 5)
  if (matchStatus(m) !== "open") {
    card.querySelector(".form-msg").textContent = "La ventana de este partido ya cerró.";
    card.querySelector(".form-msg").className = "form-msg form-msg-error";
    return;
  }

  const colombiaGoals = parseInt(card.querySelector('.step-val[data-val="cg"]').textContent, 10);
  const opponentGoals = parseInt(card.querySelector('.step-val[data-val="og"]').textContent, 10);

  try {
    await setDoc(doc(db, "m2_predictions", `${state.participant.id}_${m.id}`), {
      participantId: state.participant.id,
      matchId: m.id,
      colombiaGoals, opponentGoals,
      submittedAt: serverTimestamp(),
      editedByAdmin: false
    });
    state.myM2[m.id] = { participantId: state.participant.id, matchId: m.id, colombiaGoals, opponentGoals };
    if (!state.allM2[state.participant.id]) state.allM2[state.participant.id] = {};
    state.allM2[state.participant.id][m.id] = state.myM2[m.id];
    computeScores();
    renderTabla();
    renderPremios();
    confirmarBoton(card.querySelector(".btn-save-match"), "Guardar marcador");
    card.querySelector(".form-msg").className = "form-msg hidden";
  } catch (err) {
    card.querySelector(".form-msg").textContent = "No se pudo guardar. Revisa tu internet e intenta de nuevo.";
    card.querySelector(".form-msg").className = "form-msg form-msg-error";
  }
}

/* Confirmación visual abuela-friendly del botón Guardar */
function confirmarBoton(btn, textoOriginal) {
  btn.textContent = "✓ Guardado";
  btn.classList.add("btn-saved");
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = textoOriginal;
    btn.classList.remove("btn-saved");
    btn.disabled = false;
  }, 2000);
}

/* ============================================================
   VISTA PARTIDOS
   ============================================================ */
let countdownTimer = null;

function renderPartidos() {
  const view = $("#view-partidos");
  view.innerHTML = "";

  // Cabecera
  const head = document.createElement("div");
  head.className = "partidos-head";
  head.innerHTML = `
    <p class="card-title">Partidos de Colombia</p>
    <p class="card-meta" style="margin:0;">Grupo K · Portugal, Uzbekistán, RD Congo</p>
  `;
  view.appendChild(head);

  // El "próximo" partido (primero abierto sin resultado) lleva countdown
  const proximo = state.matches.find((m) => matchStatus(m) === "open");

  state.matches.forEach((m) => {
    view.appendChild(buildPartidoCard(m, m === proximo));
  });

  // Tarjeta punteada de eliminatorias si solo hay fase de grupos
  const hayElim = state.matches.some((m) => m.phase !== "groups");
  if (!hayElim) {
    const elim = document.createElement("div");
    elim.className = "card card-dashed";
    elim.innerHTML = `
      <i class="ti ti-tournament" style="font-size:24px; color:var(--texto-3);"></i>
      <p class="card-title" style="margin:6px 0 2px;">Fase eliminatoria</p>
      <p class="card-meta" style="margin:0;">Si Colombia avanza, los partidos aparecerán aquí automáticamente.</p>
    `;
    view.appendChild(elim);
  }

  // Arrancar el countdown en vivo
  if (countdownTimer) clearInterval(countdownTimer);
  if (proximo) {
    actualizarCountdown(proximo);
    countdownTimer = setInterval(() => actualizarCountdown(proximo), 1000);
  }
}

function buildPartidoCard(m, esProximo) {
  const status = matchStatus(m);
  const card = document.createElement("div");
  card.className = "card partido-card";

  let badge, badgeCls;
  if (status === "finished") { badge = "Finalizado"; badgeCls = "badge-final"; }
  else if (status === "open") { badge = "Predicciones abiertas"; badgeCls = "badge-abierta"; }
  else { badge = esProximo ? "Próximo" : "Cerrada"; badgeCls = "badge-neutra"; }

  let cuerpo = `
    <div class="card-head">
      <span class="card-meta" style="margin:0; font-weight:600;">${FASE_LABEL[m.phase] || ""}</span>
      <span class="badge ${badgeCls}">${badge}</span>
    </div>
    <p class="partido-vs">Colombia vs ${m.opponent}</p>
    <p class="card-meta" style="text-align:center;">${horaColCorta(m.kickoffUtc)} · ${m.venue}</p>
  `;

  if (status === "finished") {
    cuerpo += `<p class="score-final display">${m.colombiaGoals} – ${m.opponentGoals}</p>`;
  } else if (esProximo && status === "open") {
    cuerpo += `
      <div class="countdown-box" id="cd-${m.id}">
        <p class="countdown-label"><i class="ti ti-hourglass"></i> Cierre de predicciones en</p>
        <p class="countdown-val display" id="cd-val-${m.id}">—</p>
      </div>
      <button class="btn-primary" data-goto-predict="${m.id}">Predecir este partido</button>
    `;
  }

  // Predicciones reveladas (solo si cerrada o finalizada)
  if (status === "closed" || status === "finished") {
    cuerpo += buildPrediccionesReveladas(m);
  }

  card.innerHTML = cuerpo;

  const btn = card.querySelector("[data-goto-predict]");
  if (btn) btn.addEventListener("click", irAPredecir);

  return card;
}

function buildPrediccionesReveladas(m) {
  const filas = state.participants.map((p) => {
    const pred = state.allM2[p.id]?.[m.id];
    const pts = puntosPartido(pred, m);
    return { name: p.name, pred, pts };
  });

  const items = filas.map((f) => {
    if (!f.pred) {
      return `<li class="reveal-item reveal-empty"><span>${f.name}</span><span>no jugó</span></li>`;
    }
    const acerto = f.pts === 12;
    const check = acerto ? '<i class="ti ti-check reveal-check"></i>' : "";
    const marcador = `${f.pred.colombiaGoals}–${f.pred.opponentGoals}`;
    return `<li class="reveal-item"><span>${check}${f.name}</span><span class="reveal-score">${marcador}</span></li>`;
  }).join("");

  return `
    <details class="reveal">
      <summary><i class="ti ti-eye"></i> Ver qué predijo cada uno</summary>
      <ul class="reveal-list">${items}</ul>
    </details>
  `;
}

function actualizarCountdown(m) {
  const el = document.getElementById("cd-val-" + m.id);
  if (!el) return;

  // Si ya cerró mientras mirábamos, re-render para cambiar el estado
  if (matchStatus(m) !== "open") {
    if (countdownTimer) clearInterval(countdownTimer);
    renderPartidos();
    return;
  }

  const diff = m.predictionDeadlineUtc.toDate().getTime() - Date.now();
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const min = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);

  el.textContent = d > 0
    ? `${d} d · ${h} h · ${min} min`
    : `${String(h).padStart(2,"0")}:${String(min).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function irAPredecir() {
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('.tab[data-view="predecir"]').classList.add("active");
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $("#view-predecir").classList.remove("hidden");
}

/* ============================================================
   VISTA PREMIOS
   ============================================================ */
function renderPremios() {
  const view = $("#view-premios");
  const pozo = (state.config.pozoTotal || 220000);
  const p1 = Math.round(pozo * 0.5).toLocaleString("es-CO");
  const p2 = Math.round(pozo * 0.3).toLocaleString("es-CO");
  const p3 = Math.round(pozo * 0.2).toLocaleString("es-CO");

  // Líder provisional del mejor exacto
  const me = state.mejorExacto || { ganadores: [], maxExactos: 0 };
  let mejorTexto;
  if (!me.ganadores.length) {
    mejorTexto = "Aún nadie acierta un marcador exacto fuera del podio — se define partido a partido.";
  } else {
    const nombres = me.ganadores.map((g) => g.name).join(" y ");
    mejorTexto = `${nombres} · ${me.maxExactos} ${me.maxExactos === 1 ? "exacto" : "exactos"}`;
  }

  view.innerHTML = `
    <div class="premio-pozo">
      <p class="tabla-pozo-label">Pozo acumulado</p>
      <p class="tabla-pozo display">$${pozo.toLocaleString("es-CO")}</p>
      <div class="pozo-split">
        <div><span>1er lugar</span><strong>$${p1}</strong></div>
        <div><span>2do lugar</span><strong>$${p2}</strong></div>
        <div><span>3er lugar</span><strong>$${p3}</strong></div>
      </div>
    </div>

    <p class="premio-section-title">Premios experienciales</p>
    <div class="card" style="padding:0;">
      <div class="premio-row">
        <i class="ti ti-tools-kitchen-2" style="color:#BA7517;"></i>
        <div><p class="premio-nombre">Cena donde quiera el ganador</p><p class="premio-quien">1er lugar · invitan Alexis y Carlos Andrés</p></div>
      </div>
      <div class="premio-row">
        <i class="ti ti-flame" style="color:#D85A30;"></i>
        <div><p class="premio-nombre">Asado en su honor</p><p class="premio-quien">2do lugar · lo hacen Hernando y Carlos Alberto</p></div>
      </div>
      <div class="premio-row" style="border-bottom:none;">
        <i class="ti ti-movie" style="color:#534AB7;"></i>
        <div><p class="premio-nombre">Salida al cine</p><p class="premio-quien">3er lugar · invita Aliria</p></div>
      </div>
    </div>

    <div class="card premio-mejor">
      <div class="premio-row" style="border-bottom:none; padding:0;">
        <i class="ti ti-target-arrow" style="color:var(--azul);"></i>
        <div><p class="premio-nombre">Mejor marcador exacto</p><p class="premio-quien">Helado o café · invita Alexandra</p></div>
      </div>
      <div class="premio-lider">
        <p class="premio-lider-label">Líder provisional</p>
        <p class="premio-lider-val">${mejorTexto}</p>
      </div>
    </div>

    <div class="premio-castigo">
      <i class="ti ti-egg-fried"></i>
      <div><p class="premio-nombre" style="color:var(--rojo-texto);">Castigo del último lugar</p><p class="premio-quien" style="color:var(--rojo-texto);">Prepara el desayuno para todos en la próxima reunión familiar.</p></div>
    </div>
  `;
}

/* ============================================================
   VISTA ADMIN (solo administrador, tras PIN)
   ============================================================ */
let adminDesbloqueado = false;

function renderAdminGate() {
  const view = $("#view-admin");
  if (adminDesbloqueado) { renderAdminPanel(); return; }

  view.innerHTML = `
    <div class="card admin-gate">
      <i class="ti ti-lock" style="font-size:32px; color:var(--azul);"></i>
      <p class="card-title" style="margin:10px 0 4px;">Panel de administrador</p>
      <p class="card-meta">Ingresa el PIN de 4 dígitos.</p>
      <input id="admin-pin" class="field" type="password" inputmode="numeric"
             maxlength="4" placeholder="••••" style="text-align:center; font-size:24px; letter-spacing:8px; max-width:160px; margin:0 auto;">
      <button id="btn-admin-unlock" class="btn-primary" style="margin-top:14px;">Entrar</button>
      <p id="admin-pin-msg" class="form-msg hidden"></p>
    </div>
  `;

  const input = $("#admin-pin");
  const tryUnlock = async () => {
    const msg = $("#admin-pin-msg");
    const hash = await sha256(input.value.trim());
    if (hash === state.config.adminPinHash) {
      adminDesbloqueado = true;
      // Autosellado: si aún no hay un dispositivo admin registrado (o se
      // reseteó), este dispositivo queda como el admin oficial. Las reglas
      // de Firestore dan permiso de escribir resultados solo a este UID.
      if (!state.config.adminUid) {
        try {
          await updateDoc(doc(db, "config", "global"), { adminUid: state.uid });
          state.config.adminUid = state.uid;
        } catch (e) { /* si falla, el panel igual abre; se reintenta al próximo login */ }
      }
      renderAdminPanel();
    } else {
      msg.textContent = "PIN incorrecto.";
      msg.className = "form-msg form-msg-error";
      input.value = "";
    }
  };
  $("#btn-admin-unlock").addEventListener("click", tryUnlock);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
}

function renderAdminPanel() {
  const view = $("#view-admin");
  view.innerHTML = `
    <p class="card-title" style="margin-bottom:12px;"><i class="ti ti-settings"></i> Panel de administrador</p>
    <div class="admin-tabs">
      <button class="admin-tab active" data-atab="resultados">Resultados</button>
      <button class="admin-tab" data-atab="torneo">Módulo 1</button>
      <button class="admin-tab" data-atab="ventanas">Ventanas</button>
      <button class="admin-tab" data-atab="elim">Eliminatorias</button>
      <button class="admin-tab" data-atab="correg">Corregir</button>
    </div>
    <div id="admin-content"></div>
  `;
  view.querySelectorAll(".admin-tab").forEach((t) => {
    t.addEventListener("click", () => {
      view.querySelectorAll(".admin-tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      renderAdminSection(t.dataset.atab);
    });
  });
  renderAdminSection("resultados");
}

function renderAdminSection(sec) {
  const c = $("#admin-content");
  if (sec === "resultados") renderAdminResultados(c);
  else if (sec === "torneo") renderAdminTorneo(c);
  else if (sec === "ventanas") renderAdminVentanas(c);
  else if (sec === "elim") renderAdminElim(c);
  else if (sec === "correg") renderAdminCorregir(c);
}

/* ---------- Admin: cargar resultados de partidos ---------- */
function renderAdminResultados(c) {
  c.innerHTML = `<p class="card-meta">Carga el marcador final (90 min). Al guardar, los puntos de todos se recalculan solos.</p>`;
  state.matches.forEach((m) => {
    const cg = m.colombiaGoals ?? 0;
    const og = m.opponentGoals ?? 0;
    const yaTiene = m.colombiaGoals !== null;
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <p class="card-title">Colombia vs ${m.opponent} ${yaTiene ? '<span class="badge badge-final">cargado</span>' : ''}</p>
      <div class="score-row">
        ${stepperHTML("Colombia", "cg", cg)}
        <span class="score-dash">–</span>
        ${stepperHTML(m.opponent, "og", og)}
      </div>
      <button class="btn-primary btn-save-result">Guardar resultado</button>
      ${yaTiene ? '<button class="btn-secondary btn-clear-result">Borrar resultado</button>' : ''}
      <p class="form-msg hidden"></p>
    `;
    wireStepper(card, "cg");
    wireStepper(card, "og");
    card.querySelector(".btn-save-result").addEventListener("click", () => saveResult(m, card));
    const clr = card.querySelector(".btn-clear-result");
    if (clr) clr.addEventListener("click", () => clearResult(m, card));
    c.appendChild(card);
  });
}

async function saveResult(m, card) {
  const cg = parseInt(card.querySelector('.step-val[data-val="cg"]').textContent, 10);
  const og = parseInt(card.querySelector('.step-val[data-val="og"]').textContent, 10);
  try {
    await updateDoc(doc(db, "matches", m.id), { colombiaGoals: cg, opponentGoals: og, status: "finished" });
    m.colombiaGoals = cg; m.opponentGoals = og; m.status = "finished";
    computeScores();
    refreshAllViews();
    confirmarBoton(card.querySelector(".btn-save-result"), "Guardar resultado");
  } catch (err) {
    showMsg(card, "No se pudo guardar: " + err.message);
  }
}

async function clearResult(m, card) {
  if (!confirm(`¿Borrar el resultado de Colombia vs ${m.opponent}?`)) return;
  try {
    await updateDoc(doc(db, "matches", m.id), { colombiaGoals: null, opponentGoals: null, status: "open" });
    m.colombiaGoals = null; m.opponentGoals = null; m.status = "open";
    computeScores();
    refreshAllViews();
    renderAdminSection("resultados");
  } catch (err) {
    showMsg(card, "No se pudo borrar: " + err.message);
  }
}

/* ---------- Admin: resultados del Módulo 1 ---------- */
function renderAdminTorneo(c) {
  const r = state.config.m1Results || {};
  const opciones = (lista, sel) =>
    lista.map((t) => `<option value="${t}" ${t === sel ? "selected" : ""}>${t}</option>`).join("");

  c.innerHTML = `
    <div class="card">
      <p class="card-meta">Define los resultados reales del torneo. Puedes ir actualizándolos a medida que avanza el Mundial.</p>

      <label class="field-label">Campeón</label>
      <select id="r-champion" class="field"><option value="">— sin definir —</option>${opciones(state.config.teams, r.champion)}</select>

      <label class="field-label">Subcampeón</label>
      <select id="r-runnerup" class="field"><option value="">— sin definir —</option>${opciones(state.config.teams, r.runnerUp)}</select>

      <label class="field-label">Goleador(es) del torneo — marca uno o varios si la Bota de Oro queda compartida</label>
      <div id="r-scorers" class="scorer-checks">
        ${state.config.topScorerCandidates.map((s) => `
          <label class="scorer-check">
            <input type="checkbox" value="${s}" ${(r.topScorers || []).includes(s) ? "checked" : ""}> ${s}
          </label>`).join("")}
      </div>

      <label class="field-label">¿Hasta dónde llegó Colombia?</label>
      <select id="r-round" class="field"><option value="">— sin definir —</option>
        ${RONDAS.map((rd) => `<option value="${rd.value}" ${rd.value === r.colombiaRound ? "selected" : ""}>${rd.label}</option>`).join("")}
      </select>

      <button id="btn-save-m1results" class="btn-primary">Guardar resultados del torneo</button>
      <p class="form-msg hidden"></p>
    </div>
  `;
  c.querySelector("#btn-save-m1results").addEventListener("click", () => saveM1Results(c));
}

async function saveM1Results(c) {
  const champion = $("#r-champion").value || null;
  const runnerUp = $("#r-runnerup").value || null;
  const colombiaRound = $("#r-round").value || null;
  const topScorers = Array.from(c.querySelectorAll("#r-scorers input:checked")).map((i) => i.value);

  try {
    await updateDoc(doc(db, "config", "global"), {
      m1Results: { champion, runnerUp, topScorers, colombiaRound }
    });
    state.config.m1Results = { champion, runnerUp, topScorers, colombiaRound };
    computeScores();
    refreshAllViews();
    confirmarBoton($("#btn-save-m1results"), "Guardar resultados del torneo");
  } catch (err) {
    showMsg(c, "No se pudo guardar: " + err.message);
  }
}

/* ---------- Admin: abrir/cerrar ventanas manualmente ---------- */
function renderAdminVentanas(c) {
  c.innerHTML = `<p class="card-meta">El cierre automático es 1 hora antes de cada partido. Usa estos controles solo si un partido se aplaza o cambia de hora.</p>`;
  state.matches.forEach((m) => {
    const status = matchStatus(m);
    const card = document.createElement("div");
    card.className = "card";
    const ov = m.manualOverride ? `Forzado: ${m.manualOverride === "open" ? "ABIERTA" : "CERRADA"}` : "Automático";
    card.innerHTML = `
      <p class="card-title">Colombia vs ${m.opponent}</p>
      <p class="card-meta">Estado actual: <strong>${status}</strong> · ${ov}</p>
      <div class="admin-btn-row">
        <button class="btn-secondary" data-ov="open">Forzar abierta</button>
        <button class="btn-secondary" data-ov="closed">Forzar cerrada</button>
        <button class="btn-secondary" data-ov="auto">Volver a automático</button>
      </div>
      <p class="form-msg hidden"></p>
    `;
    card.querySelectorAll("[data-ov]").forEach((b) => {
      b.addEventListener("click", () => setOverride(m, b.dataset.ov === "auto" ? null : b.dataset.ov, card));
    });
    c.appendChild(card);
  });
}

async function setOverride(m, val, card) {
  try {
    await updateDoc(doc(db, "matches", m.id), { manualOverride: val });
    m.manualOverride = val;
    refreshAllViews();
    renderAdminSection("ventanas");
  } catch (err) {
    showMsg(card, "No se pudo cambiar: " + err.message);
  }
}

/* ---------- Admin: agregar partido de eliminatoria ---------- */
function renderAdminElim(c) {
  c.innerHTML = `
    <div class="card">
      <p class="card-meta">Agrega un partido de eliminatoria si Colombia avanza. Aparecerá para los 10 participantes.</p>

      <label class="field-label">Fase</label>
      <select id="e-phase" class="field">
        <option value="r32">Dieciseisavos (Round of 32)</option>
        <option value="r16">Octavos (Round of 16)</option>
        <option value="qf">Cuartos de final</option>
        <option value="sf">Semifinal</option>
        <option value="final">Final</option>
      </select>

      <label class="field-label">Rival</label>
      <input id="e-opponent" class="field" type="text" placeholder="Ej: Brasil">

      <label class="field-label">Sede</label>
      <input id="e-venue" class="field" type="text" placeholder="Ej: MetLife Stadium, Nueva York">

      <label class="field-label">Fecha y hora del partido (hora Colombia)</label>
      <input id="e-datetime" class="field" type="datetime-local">

      <button id="btn-add-elim" class="btn-primary">Agregar partido</button>
      <p class="form-msg hidden"></p>
    </div>
  `;
  c.querySelector("#btn-add-elim").addEventListener("click", () => addElim(c));
}

async function addElim(c) {
  const phase = $("#e-phase").value;
  const opponent = $("#e-opponent").value.trim();
  const venue = $("#e-venue").value.trim();
  const dt = $("#e-datetime").value;
  if (!opponent || !venue || !dt) { showMsg(c, "Llena todos los campos."); return; }

  // El input está en hora Colombia (UTC-5). Interpretamos sus componentes
  // explícitamente para no depender de la zona horaria del dispositivo del
  // admin (que puede estar en EE.UU.). Col = UTC-5 → UTC = hora + 5.
  const [fecha, hora] = dt.split("T");
  const [yy, mm, dd] = fecha.split("-").map(Number);
  const [hh, mi] = hora.split(":").map(Number);
  const kickoffUtc = new Date(Date.UTC(yy, mm - 1, dd, hh + 5, mi));
  const deadlineUtc = new Date(kickoffUtc.getTime() - 3600000);

  const order = state.matches.length + 1;
  const id = `${phase}-${opponent.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

  try {
    await setDoc(doc(db, "matches", id), {
      phase, opponent, venue,
      kickoffUtc, predictionDeadlineUtc: deadlineUtc,
      colombiaGoals: null, opponentGoals: null,
      status: "open", manualOverride: null, order
    });
    // Recargar partidos desde la base
    const snap = await getDocs(collection(db, "matches"));
    state.matches = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    computeScores();
    refreshAllViews();
    confirmarBoton($("#btn-add-elim"), "Agregar partido");
    showMsg(c, `✓ Agregado: Colombia vs ${opponent}`, true);
  } catch (err) {
    showMsg(c, "No se pudo agregar: " + err.message);
  }
}

/* ---------- Admin: corregir predicciones ajenas ---------- */
function renderAdminCorregir(c) {
  c.innerHTML = `
    <div class="card">
      <p class="card-meta">Corrige la predicción de alguien (caso: guardó mal y te pide ayuda). Queda marcada como editada por admin.</p>
      <label class="field-label">Participante</label>
      <select id="cor-person" class="field">
        ${state.participants.map((p) => `<option value="${p.id}">${p.name}</option>`).join("")}
      </select>
      <label class="field-label">Partido</label>
      <select id="cor-match" class="field">
        ${state.matches.map((m) => `<option value="${m.id}">Colombia vs ${m.opponent}</option>`).join("")}
      </select>
      <div id="cor-stepper"></div>
    </div>
  `;
  const render = () => renderCorrectorStepper(c);
  $("#cor-person").addEventListener("change", render);
  $("#cor-match").addEventListener("change", render);
  render();
}

function renderCorrectorStepper(c) {
  const pid = $("#cor-person").value;
  const mid = $("#cor-match").value;
  const pred = state.allM2[pid]?.[mid];
  const cg = pred ? pred.colombiaGoals : 0;
  const og = pred ? pred.opponentGoals : 0;
  const m = state.matches.find((x) => x.id === mid);

  const box = $("#cor-stepper");
  box.innerHTML = `
    <p class="card-meta">${pred ? `Predicción actual: <strong>${pred.colombiaGoals}–${pred.opponentGoals}</strong>` : "Esta persona no tiene predicción para este partido."}</p>
    <div class="score-row">
      ${stepperHTML("Colombia", "cg", cg)}
      <span class="score-dash">–</span>
      ${stepperHTML(m.opponent, "og", og)}
    </div>
    <button class="btn-primary btn-save-cor">Guardar corrección</button>
    <p class="form-msg hidden"></p>
  `;
  wireStepper(box, "cg");
  wireStepper(box, "og");
  box.querySelector(".btn-save-cor").addEventListener("click", () => saveCorreccion(pid, mid, box));
}

async function saveCorreccion(pid, mid, box) {
  const cg = parseInt(box.querySelector('.step-val[data-val="cg"]').textContent, 10);
  const og = parseInt(box.querySelector('.step-val[data-val="og"]').textContent, 10);
  try {
    await setDoc(doc(db, "m2_predictions", `${pid}_${mid}`), {
      participantId: pid, matchId: mid,
      colombiaGoals: cg, opponentGoals: og,
      submittedAt: serverTimestamp(), editedByAdmin: true
    });
    if (!state.allM2[pid]) state.allM2[pid] = {};
    state.allM2[pid][mid] = { participantId: pid, matchId: mid, colombiaGoals: cg, opponentGoals: og };
    if (pid === state.participant.id) state.myM2[mid] = state.allM2[pid][mid];
    computeScores();
    refreshAllViews();
    confirmarBoton(box.querySelector(".btn-save-cor"), "Guardar corrección");
  } catch (err) {
    showMsg(box, "No se pudo guardar: " + err.message);
  }
}

/* ---------- Helpers de admin ---------- */
function showMsg(container, texto, ok = false) {
  const msg = container.querySelector(".form-msg");
  if (!msg) return;
  msg.textContent = texto;
  msg.className = ok ? "form-msg form-msg-ok" : "form-msg form-msg-error";
}

function refreshAllViews() {
  renderTabla();
  renderPredecir();
  renderPartidos();
  renderPremios();
}

/* ============================================================
   NAVEGACIÓN
   ============================================================ */
$("#tabbar").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  tab.classList.add("active");
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $("#view-" + tab.dataset.view).classList.remove("hidden");
});

$("#btn-switch-user").addEventListener("click", () => {
  if (confirm("¿Salir y volver a la pantalla de nombres?")) {
    localStorage.removeItem("participantId");
    location.reload();
  }
});
