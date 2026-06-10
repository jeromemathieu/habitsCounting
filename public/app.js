// --- Helpers ---
const $ = (sel) => document.querySelector(sel);
const api = async (url, opts) => {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) {
    // Session expirée ou absente : on revient à l'écran de connexion.
    document.body.classList.remove("authed");
    throw new Error("Session expirée, reconnecte-toi.");
  }
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Erreur ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
};

// Local date as YYYY-MM-DD (avoids UTC shift)
const toISODate = (d) => {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
};

const frDate = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

const frMonth = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("fr-FR", {
    month: "long",
    year: "numeric",
  });
};

// Jours de la semaine, ordre d'affichage lundi→dimanche.
// `idx` = valeur getDay() (0=dimanche … 6=samedi) = position dans le masque.
const WEEKDAYS = [
  { idx: 1, label: "L" }, { idx: 2, label: "M" }, { idx: 3, label: "M" },
  { idx: 4, label: "J" }, { idx: 5, label: "V" }, { idx: 6, label: "S" },
  { idx: 0, label: "D" },
];

// Construit un sélecteur de jours dans `container` à partir d'un masque "1111111".
// Le masque courant est stocké dans container.dataset.mask. `onChange(mask)` optionnel.
function buildDaysPicker(container, mask, onChange) {
  container.dataset.mask = mask;
  container.innerHTML = "";
  for (const { idx, label } of WEEKDAYS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "day-toggle" + (mask[idx] === "1" ? " on" : "");
    b.textContent = label;
    b.addEventListener("click", () => {
      const m = container.dataset.mask.split("");
      m[idx] = m[idx] === "1" ? "0" : "1";
      if (!m.includes("1")) return; // garder au moins un jour
      container.dataset.mask = m.join("");
      b.classList.toggle("on");
      if (onChange) onChange(container.dataset.mask);
    });
    container.appendChild(b);
  }
}

// Convertit un masque "1111111" en tableau d'index [0..6] pour l'API.
const maskToDays = (mask) =>
  mask.split("").map((c, i) => (c === "1" ? i : -1)).filter((i) => i >= 0);

// --- State ---
let currentDate = toISODate(new Date());
let currentMonth = currentDate.slice(0, 7);
let currentYear = new Date().getFullYear();
let selectedHabits = null; // Set d'ids affichés dans la synthèse (null = tous)
let chartMode = "count"; // count | rate | stacked
let calHabitId = null; // habitude sélectionnée dans le calendrier
let calMonth = currentMonth; // mois affiché dans le calendrier
let calSelectedDate = null; // jour sélectionné dans le calendrier (pour le panneau)

// --- Thème clair / sombre ---
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
  const btn = $("#theme-toggle");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
}
function currentTheme() {
  return localStorage.getItem("theme") || "light";
}
applyTheme(currentTheme());
$("#theme-toggle").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
  if (chartInstance) drawChart(); // recolorer le graphique selon le thème
});

// Lit une variable CSS du thème courant.
const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// --- Tabs ---
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    const view = tab.dataset.view;
    $("#view-" + view).classList.add("active");
    if (view === "day") renderDay();
    if (view === "calendar") renderCalendar();
    if (view === "month") renderMonth();
    if (view === "synthese") renderSynthese();
    if (view === "shared") renderShared();
    if (view === "manage") renderManage();
    if (view === "account") renderAccount();
  });
});

// --- Day view ---
async function renderDay() {
  $("#day-picker").value = currentDate;
  $("#day-label").textContent = frDate(currentDate);

  const [habits, statuses, notes] = await Promise.all([
    api("/api/habits"),
    api("/api/logs?date=" + currentDate), // { id: 'done' | 'missed' }
    api("/api/notes?date=" + currentDate),
  ]);

  const list = $("#day-list");
  list.innerHTML = "";
  $("#day-empty").classList.toggle("hidden", habits.length > 0);

  // Cycle des états : rien -> fait -> pas fait -> rien
  const NEXT = { none: "done", done: "missed", missed: "none" };
  const MISSED = "#dc2626";

  for (const h of habits) {
    const status = statuses[h.id] || "none";
    const note = notes[h.id] || "";

    const li = document.createElement("li");
    li.className = "habit-item" + (status === "done" ? " done" : status === "missed" ? " missed" : "");
    li.style.background =
      status === "done" ? h.color + "1a" : status === "missed" ? MISSED + "14" : "";

    // Ligne principale (clic = change d'état)
    const main = document.createElement("div");
    main.className = "habit-main";
    main.innerHTML = `
      <span class="dot" style="background:${h.color}"></span>
      <span class="name">${escapeHtml(h.name)}</span>
    `;
    const noteBtn = document.createElement("button");
    noteBtn.className = "note-btn" + (note ? " has-note" : "");
    noteBtn.textContent = "💬";
    noteBtn.title = note ? "Modifier le commentaire" : "Ajouter un commentaire";
    const check = document.createElement("span");
    check.className = "checkbox";
    if (status === "done") {
      check.style.background = h.color;
      check.style.borderColor = h.color;
      check.textContent = "✓";
    } else if (status === "missed") {
      check.style.background = MISSED;
      check.style.borderColor = MISSED;
      check.textContent = "✗";
    }
    main.title = "Cliquer : " + { none: "marquer fait", done: "marquer pas fait", missed: "remettre à zéro" }[status];
    main.append(noteBtn, check);

    // Éditeur de note (déplié par le bouton 💬)
    const editor = document.createElement("div");
    editor.className = "note-editor hidden";
    const ta = document.createElement("textarea");
    ta.rows = 2;
    ta.placeholder = "Commentaire pour ce jour…";
    ta.value = note;
    editor.appendChild(ta);
    if (note) editor.classList.remove("hidden");

    main.addEventListener("click", async (e) => {
      if (e.target === noteBtn) return; // le bouton note ne change pas l'état
      await api("/api/logs/set", {
        method: "POST",
        body: JSON.stringify({ habit_id: h.id, date: currentDate, status: NEXT[status] }),
      });
      renderDay();
    });
    noteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      editor.classList.toggle("hidden");
      if (!editor.classList.contains("hidden")) ta.focus();
    });
    ta.addEventListener("blur", async () => {
      const saved = await api("/api/notes", {
        method: "PUT",
        body: JSON.stringify({ habit_id: h.id, date: currentDate, text: ta.value.trim() }),
      });
      noteBtn.classList.toggle("has-note", !!saved.text);
    });

    li.append(main, editor);
    list.appendChild(li);
  }
}

$("#day-picker").addEventListener("change", (e) => {
  currentDate = e.target.value;
  renderDay();
});
$("#prev-day").addEventListener("click", () => shiftDay(-1));
$("#next-day").addEventListener("click", () => shiftDay(1));
$("#today-btn").addEventListener("click", () => {
  currentDate = toISODate(new Date());
  renderDay();
});

function shiftDay(delta) {
  const d = new Date(currentDate + "T00:00:00");
  d.setDate(d.getDate() + delta);
  currentDate = toISODate(d);
  renderDay();
}

// --- Calendar view (saisie par habitude) ---
let calHabits = []; // cache des habitudes (pour la couleur du jour coché)

async function renderCalendar() {
  const habits = await api("/api/habits");
  calHabits = habits;
  $("#calendar-empty").classList.toggle("hidden", habits.length > 0);

  const sel = $("#calendar-habit");
  sel.style.display = habits.length ? "" : "none";
  $("#calendar-card").style.display = habits.length ? "" : "none";
  if (!habits.length) return;

  // (Re)remplit la liste déroulante d'habitudes
  if (calHabitId === null || !habits.some((h) => h.id === calHabitId)) {
    calHabitId = habits[0].id;
  }
  sel.innerHTML = "";
  for (const h of habits) {
    const opt = document.createElement("option");
    opt.value = h.id;
    opt.textContent = h.name;
    if (h.id === calHabitId) opt.selected = true;
    sel.appendChild(opt);
  }

  await drawCalendar();
}

let calData = null; // dernières données du calendrier (done/notes/période)

async function drawCalendar() {
  const [y, m] = calMonth.split("-").map(Number);
  $("#cal-month-label").textContent = frMonth(calMonth);

  const data = await api(`/api/habits/${calHabitId}/calendar?month=${calMonth}`);
  calData = data;
  const statuses = data.statuses || {};
  const notes = data.notes || {};
  const MISSED = "#dc2626";
  const mask = data.days;
  const start = data.start_date;
  const end = data.end_date;
  const today = toISODate(new Date());
  const color = getHabitColor();

  // En-têtes L M M J V S D (grille séparée, hauteur indépendante des cases)
  const head = $("#cal-weekdays");
  head.innerHTML = "";
  for (const { label } of WEEKDAYS) {
    const h = document.createElement("div");
    h.className = "cal-head";
    h.textContent = label;
    head.appendChild(h);
  }

  const grid = $("#calendar-grid");
  grid.innerHTML = "";

  // Cases vides avant le 1er (lundi en première colonne)
  const firstDow = new Date(y, m - 1, 1).getDay(); // 0=dim..6=sam
  const lead = (firstDow + 6) % 7; // décalage avec lundi en tête
  for (let i = 0; i < lead; i++) {
    const e = document.createElement("div");
    e.className = "cal-cell empty";
    grid.appendChild(e);
  }

  const daysInMonth = new Date(y, m, 0).getDate();
  let scheduledCount = 0;
  let doneScheduled = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${calMonth}-${String(d).padStart(2, "0")}`;
    const dow = new Date(y, m - 1, d).getDay();
    const status = statuses[iso] || "none"; // 'done' | 'missed' | 'none'
    const isDone = status === "done";
    const outRange = (start && iso < start) || (end && iso > end);
    const scheduled = mask[dow] === "1" && !outRange;
    if (scheduled) scheduledCount++;
    if (scheduled && isDone) doneScheduled++;

    const cell = document.createElement("div");
    cell.className = "cal-cell";
    cell.dataset.iso = iso;
    if (outRange) cell.classList.add("out");
    if (scheduled) cell.classList.add("scheduled");
    else cell.classList.add("off");
    if (iso === today) cell.classList.add("today");
    if (iso === calSelectedDate) cell.classList.add("selected");
    if (notes[iso]) cell.classList.add("has-note");
    if (isDone) {
      cell.classList.add("done");
      cell.style.background = color;
    } else if (status === "missed") {
      cell.classList.add("missed");
      cell.style.background = MISSED;
    }

    const num = document.createElement("span");
    num.className = "cal-num";
    num.textContent = d;
    const dot = document.createElement("span");
    dot.className = "cal-dot";
    if (scheduled && status === "none") dot.style.background = color; // point « jour prévu »
    cell.append(num, dot);

    if (outRange) {
      cell.title = "Hors période de l'habitude";
    } else {
      cell.title = "Voir / modifier ce jour";
      cell.addEventListener("click", () => selectCalDay(iso));
    }
    grid.appendChild(cell);
  }

  // Stats du mois : jours prévus réalisés
  const pct = scheduledCount ? Math.round((doneScheduled / scheduledCount) * 100) : 0;
  $("#cal-stats").innerHTML = `
    <div class="cal-progress"><span style="width:${pct}%;background:${color}"></span></div>
    <span class="cal-stats-text"><b>${doneScheduled}</b> / ${scheduledCount} jours prévus · ${pct}%</span>
  `;

  // Légende
  $("#cal-legend").innerHTML = `
    <span><i class="lg-swatch" style="background:${color}"></i> Réalisé</span>
    <span><i class="lg-dot" style="background:${color}"></i> Jour prévu</span>
    <span><i class="lg-note">💬</i> Commentaire</span>
    <span><i class="lg-swatch" style="background:var(--bg);border:1.5px solid var(--primary)"></i> Aujourd'hui</span>
  `;

  renderCalPanel(); // (ré)affiche le panneau du jour sélectionné s'il existe
}

// Sélectionne un jour : surligne la case et ouvre le panneau d'édition.
function selectCalDay(iso) {
  calSelectedDate = iso;
  document
    .querySelectorAll("#calendar-grid .cal-cell.selected")
    .forEach((c) => c.classList.remove("selected"));
  const cell = document.querySelector(`#calendar-grid .cal-cell[data-iso="${iso}"]`);
  if (cell) cell.classList.add("selected");
  renderCalPanel();
}

// Panneau d'un jour : état « fait » + commentaire.
function renderCalPanel() {
  const panel = $("#cal-day-panel");
  if (!calSelectedDate || !calData) {
    panel.classList.add("hidden");
    return;
  }
  const iso = calSelectedDate;
  const status = (calData.statuses || {})[iso] || "none";
  const note = (calData.notes || {})[iso] || "";
  const color = getHabitColor();
  const MISSED = "#dc2626";

  const styleFor = (s) =>
    s === "done"
      ? `background:${color};border-color:${color};color:#fff`
      : s === "missed"
      ? `background:${MISSED};border-color:${MISSED};color:#fff`
      : "";

  panel.classList.remove("hidden");
  panel.innerHTML = `
    <div class="panel-head">
      <span class="panel-date">${frDate(iso)}</span>
      <div class="panel-status">
        <button class="panel-btn" data-status="done" style="${status === "done" ? styleFor("done") : ""}">✓ Fait</button>
        <button class="panel-btn" data-status="missed" style="${status === "missed" ? styleFor("missed") : ""}">✗ Pas fait</button>
        <button class="panel-btn" data-status="none" style="${status === "none" ? "background:var(--border)" : ""}">Rien</button>
      </div>
    </div>
    <textarea id="panel-note" class="panel-note" rows="3"
      placeholder="Ajouter un commentaire pour ce jour…">${escapeHtml(note)}</textarea>
  `;

  panel.querySelectorAll(".panel-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api("/api/logs/set", {
        method: "POST",
        body: JSON.stringify({ habit_id: calHabitId, date: iso, status: btn.dataset.status }),
      });
      await drawCalendar(); // met à jour case, stats et panneau (sélection conservée)
    });
  });

  const ta = $("#panel-note");
  ta.addEventListener("blur", async () => {
    const text = ta.value.trim();
    const saved = await api("/api/notes", {
      method: "PUT",
      body: JSON.stringify({ habit_id: calHabitId, date: iso, text }),
    });
    if (!calData.notes) calData.notes = {};
    if (saved.text) calData.notes[iso] = saved.text;
    else delete calData.notes[iso];
    // met à jour l'indicateur de commentaire sur la case
    const cell = document.querySelector(`#calendar-grid .cal-cell[data-iso="${iso}"]`);
    if (cell) cell.classList.toggle("has-note", !!saved.text);
  });
}

// Couleur de l'habitude sélectionnée.
function getHabitColor() {
  const h = calHabits.find((x) => x.id === calHabitId);
  return h ? h.color : "#4f46e5";
}

$("#calendar-habit").addEventListener("change", async (e) => {
  calHabitId = Number(e.target.value);
  calSelectedDate = null; // la note dépend de l'habitude : on referme le panneau
  await drawCalendar();
});
$("#cal-prev-month").addEventListener("click", () => shiftCalMonth(-1));
$("#cal-next-month").addEventListener("click", () => shiftCalMonth(1));

function shiftCalMonth(delta) {
  const [y, m] = calMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  calSelectedDate = null;
  drawCalendar();
}

// --- Month view ---
async function renderMonth() {
  $("#month-picker").value = currentMonth;
  const data = await api("/api/summary?month=" + currentMonth);

  $("#month-empty").classList.toggle("hidden", data.habits.length > 0);

  const avgRate = data.habits.length
    ? Math.round(data.habits.reduce((s, h) => s + h.rate, 0) / data.habits.length)
    : 0;

  $("#month-stats").innerHTML = `
    <div class="stat-card"><div class="big">${data.totalCompletions}</div><div class="label">actions cochées</div></div>
    <div class="stat-card"><div class="big">${data.habits.length}</div><div class="label">habitudes suivies</div></div>
    <div class="stat-card"><div class="big">${avgRate}%</div><div class="label">régularité moyenne</div></div>
  `;

  const wrap = $("#month-summary");
  wrap.innerHTML = "";
  for (const h of data.habits) {
    const row = document.createElement("div");
    row.className = "summary-row";
    row.innerHTML = `
      <div class="top">
        <span class="dot" style="background:${h.color}"></span>
        <span class="name">${escapeHtml(h.name)}</span>
        <span class="count">${h.count} / ${h.scheduled} j prévus · ${h.rate}%</span>
      </div>
      <div class="bar"><span style="width:${h.rate}%;background:${h.color}"></span></div>
    `;
    wrap.appendChild(row);
  }
}

$("#month-picker").addEventListener("change", (e) => {
  currentMonth = e.target.value;
  renderMonth();
});
$("#prev-month").addEventListener("click", () => shiftMonth(-1));
$("#next-month").addEventListener("click", () => shiftMonth(1));

function shiftMonth(delta) {
  const [y, m] = currentMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  renderMonth();
}

// --- Synthèse view ---
const MONTHS_FR = ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin", "Juil", "Août", "Sep", "Oct", "Nov", "Déc"];
let trendsCache = null; // dernières données /api/trends
let knownHabitIds = new Set(); // ids connus au dernier rendu (pour repérer les nouvelles)

async function renderSynthese() {
  $("#year-picker").value = currentYear;
  const data = await api("/api/trends?year=" + currentYear);
  trendsCache = data;

  $("#synthese-empty").classList.toggle("hidden", data.habits.length > 0);

  // Initialise / nettoie la sélection (par défaut : toutes les habitudes)
  const ids = new Set(data.habits.map((h) => h.id));
  if (selectedHabits === null) {
    selectedHabits = new Set(ids);
  } else {
    for (const id of [...selectedHabits]) if (!ids.has(id)) selectedHabits.delete(id);
    for (const id of ids) if (!knownHabitIds.has(id)) selectedHabits.add(id); // nouvelles habitudes
    if (selectedHabits.size === 0) selectedHabits = new Set(ids);
  }
  knownHabitIds = ids;

  renderFilter(data.habits);
  drawChart();
}

function renderFilter(habits) {
  const wrap = $("#habit-filter");
  wrap.innerHTML = "";
  for (const h of habits) {
    const active = selectedHabits.has(h.id);
    const chip = document.createElement("button");
    chip.className = "filter-chip" + (active ? " active" : "");
    chip.innerHTML = `<span class="chip-dot" style="background:${active ? h.color : "var(--border)"}"></span>${escapeHtml(h.name)}`;
    chip.style.borderColor = active ? h.color : "";
    chip.addEventListener("click", () => {
      if (selectedHabits.has(h.id)) selectedHabits.delete(h.id);
      else selectedHabits.add(h.id);
      if (selectedHabits.size === 0) selectedHabits.add(h.id); // garde-en au moins une
      renderFilter(habits);
      drawChart();
    });
    wrap.appendChild(chip);
  }
}

let chartInstance = null;

// Convertit une couleur hex (#rrggbb) en rgba avec alpha.
function hexAlpha(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Plugin : trace une ligne de référence horizontale en pointillés (moyenne).
const referenceLinePlugin = {
  id: "referenceLine",
  afterDatasetsDraw(chart) {
    const opt = chart.options.plugins.referenceLine;
    if (!opt || opt.value == null) return;
    const y = chart.scales.y.getPixelForValue(opt.value);
    const { left, right } = chart.chartArea;
    const c = chart.ctx;
    c.save();
    c.beginPath();
    c.setLineDash([6, 4]);
    c.lineWidth = 1.5;
    c.strokeStyle = opt.color;
    c.moveTo(left, y);
    c.lineTo(right, y);
    c.stroke();
    c.setLineDash([]);
    c.font = "600 11px system-ui, sans-serif";
    c.fillStyle = opt.color;
    c.textAlign = "right";
    c.textBaseline = "bottom";
    c.fillText(opt.label, right - 4, y - 3);
    c.restore();
  },
};
if (typeof Chart !== "undefined") Chart.register(referenceLinePlugin);

// Construit la config Chart.js pour des données de trends et un mode donné.
function trendsChartConfig(shown, mode) {
  const isRate = mode === "rate";
  const isStacked = mode === "stacked";
  const valOf = (h, i) =>
    isRate
      ? (h.scheduled[i] ? Math.round((h.monthlyScheduled[i] / h.scheduled[i]) * 100) : 0)
      : h.monthly[i];

  // Dégradé vertical sous une courbe (du plus opaque en haut vers transparent).
  const makeGradient = (color) => (context) => {
    const { chart } = context;
    const { ctx: g, chartArea } = chart;
    if (!chartArea) return hexAlpha(color, 0.12);
    const grad = g.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    grad.addColorStop(0, hexAlpha(color, 0.35));
    grad.addColorStop(1, hexAlpha(color, 0));
    return grad;
  };

  const datasets = shown.map((h) => ({
    label: h.name,
    data: h.monthly.map((_, i) => valOf(h, i)),
    borderColor: h.color,
    backgroundColor: isStacked ? h.color : makeGradient(h.color),
    fill: isStacked ? true : "origin",
    tension: 0.35,
    borderWidth: 2.5,
    pointRadius: 3,
    pointHoverRadius: 5,
    pointBackgroundColor: h.color,
    borderRadius: isStacked ? 6 : 0,
    maxBarThickness: 26,
  }));

  // Ligne de référence = moyenne des valeurs affichées (modes lignes uniquement).
  const allVals = datasets.flatMap((d) => d.data);
  const avg = allVals.length ? allVals.reduce((a, b) => a + b, 0) / allVals.length : 0;
  const refLine = isStacked
    ? { value: null }
    : {
        value: Math.round(avg),
        label: `Moyenne ${Math.round(avg)}${isRate ? " %" : ""}`,
        color: cssVar("--muted") || "#6b7280",
      };

  const tickColor = cssVar("--muted") || "#6b7280";
  const gridColor = cssVar("--border") || "#e5e7eb";

  return {
    type: isStacked ? "bar" : "line",
    data: { labels: MONTHS_FR, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false }, // on garde nos « chips » de filtre à la place
        referenceLine: refLine,
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label} : ${c.parsed.y}${isRate ? " %" : ""}`,
          },
        },
      },
      scales: {
        x: { stacked: isStacked, grid: { display: false }, ticks: { color: tickColor } },
        y: {
          stacked: isStacked,
          beginAtZero: true,
          ...(isRate ? { max: 100 } : {}),
          grid: { color: gridColor },
          ticks: { color: tickColor, precision: 0, callback: (v) => (isRate ? v + " %" : v) },
        },
      },
    },
  };
}

// Dessine un graphique de trends dans `wrapEl`. L'instance Chart est mémorisée
// sur l'élément (wrapEl._chart) pour pouvoir être détruite au prochain rendu.
function renderTrendsChart(wrapEl, trends, selectedSet, mode) {
  const showMessage = (msg) => {
    if (wrapEl._chart) { wrapEl._chart.destroy(); wrapEl._chart = null; }
    wrapEl.innerHTML = `<div class="chart-empty">${msg}</div>`;
  };
  if (!trends || trends.habits.length === 0) return showMessage("Aucune donnée.");
  const shown = trends.habits.filter((h) => selectedSet.has(h.id));
  if (shown.length === 0) return showMessage("Sélectionne au moins une habitude.");

  let canvas = wrapEl.querySelector("canvas");
  if (!canvas) {
    wrapEl.innerHTML = "<canvas></canvas>";
    canvas = wrapEl.querySelector("canvas");
  }
  if (wrapEl._chart) wrapEl._chart.destroy();
  wrapEl._chart = new Chart(canvas, trendsChartConfig(shown, mode));
}

function drawChart() {
  renderTrendsChart($("#chart-wrap"), trendsCache, selectedHabits || new Set(), chartMode);
  chartInstance = $("#chart-wrap")._chart; // pour le re-render au changement de thème
}

// Sélecteur de mode du graphique
document.querySelectorAll("#chart-modes .mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#chart-modes .mode-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    chartMode = btn.dataset.mode;
    drawChart();
  });
});

$("#year-picker").addEventListener("change", (e) => {
  const v = parseInt(e.target.value, 10);
  if (!Number.isNaN(v)) {
    currentYear = v;
    renderSynthese();
  }
});
$("#prev-year").addEventListener("click", () => { currentYear--; renderSynthese(); });
$("#next-year").addEventListener("click", () => { currentYear++; renderSynthese(); });

// --- Shared view (consultation des habitudes partagées avec moi) ---
let sharedOwnerId = null;

async function renderShared() {
  const owners = await api("/api/shared");
  $("#shared-empty").classList.toggle("hidden", owners.length > 0);
  const sel = $("#shared-owner");
  sel.style.display = owners.length ? "" : "none";
  $("#shared-content").innerHTML = "";
  if (!owners.length) {
    sharedOwnerId = null;
    $("#shared-cal-block").classList.add("hidden");
    $("#shared-chart-block").classList.add("hidden");
    return;
  }
  if (sharedOwnerId === null || !owners.some((o) => o.id === sharedOwnerId)) {
    sharedOwnerId = owners[0].id;
  }
  sel.innerHTML = "";
  for (const o of owners) {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = o.email;
    if (o.id === sharedOwnerId) opt.selected = true;
    sel.appendChild(opt);
  }
  await loadSharedOwner();
}

// Charge toutes les sections (jour, calendrier, synthèse) du propriétaire choisi.
async function loadSharedOwner() {
  await drawShared();
  await renderSharedCalendar();
  await renderSharedChart();
}

async function drawShared() {
  const today = toISODate(new Date());
  const month = today.slice(0, 7);
  const [summary, statuses] = await Promise.all([
    api(`/api/summary?owner=${sharedOwnerId}&month=${month}`),
    api(`/api/logs?date=${today}&owner=${sharedOwnerId}`),
  ]);
  const wrap = $("#shared-content");
  const MISSED = "#dc2626";

  if (!summary.habits.length) {
    wrap.innerHTML = '<p class="empty">Cette personne n\'a pas encore d\'habitude.</p>';
    return;
  }

  let html = `<p class="shared-sub">Aujourd'hui — ${frDate(today)}</p>`;
  html += '<ul class="habit-checklist">';
  for (const h of summary.habits) {
    const st = statuses[h.id] || "none";
    const bg = st === "done" ? `${h.color}1a` : st === "missed" ? `${MISSED}14` : "";
    const box =
      st === "done"
        ? `background:${h.color};border-color:${h.color}`
        : st === "missed"
        ? `background:${MISSED};border-color:${MISSED}`
        : "";
    const mark = st === "done" ? "✓" : st === "missed" ? "✗" : "";
    html += `<li class="habit-item ${st === "done" ? "done" : st === "missed" ? "missed" : ""}" style="background:${bg}">
      <div class="habit-main" style="cursor:default">
        <span class="dot" style="background:${h.color}"></span>
        <span class="name">${escapeHtml(h.name)}</span>
        <span class="checkbox" style="${box}">${mark}</span>
      </div></li>`;
  }
  html += "</ul>";

  html += `<p class="shared-sub">Régularité — ${frMonth(month)}</p>`;
  for (const h of summary.habits) {
    html += `<div class="summary-row">
      <div class="top">
        <span class="dot" style="background:${h.color}"></span>
        <span class="name">${escapeHtml(h.name)}</span>
        <span class="count">${h.count} / ${h.scheduled} j prévus · ${h.rate}%</span>
      </div>
      <div class="bar"><span style="width:${h.rate}%;background:${h.color}"></span></div>
    </div>`;
  }
  wrap.innerHTML = html;
}

$("#shared-owner").addEventListener("change", (e) => {
  sharedOwnerId = Number(e.target.value);
  // Réinitialise l'état des sous-vues pour le nouveau propriétaire
  sharedCalHabitId = null;
  sharedSelectedHabits = null;
  loadSharedOwner();
});

// --- Calendrier partagé (lecture seule) ---
let sharedCalHabitId = null;
let sharedCalMonth = currentMonth;
let sharedCalHabits = [];

async function renderSharedCalendar() {
  const habits = await api(`/api/habits?owner=${sharedOwnerId}`);
  sharedCalHabits = habits;
  const block = $("#shared-cal-block");
  if (!habits.length) {
    block.classList.add("hidden");
    return;
  }
  block.classList.remove("hidden");
  if (sharedCalHabitId === null || !habits.some((h) => h.id === sharedCalHabitId)) {
    sharedCalHabitId = habits[0].id;
  }
  const sel = $("#shared-cal-habit");
  sel.innerHTML = "";
  for (const h of habits) {
    const o = document.createElement("option");
    o.value = h.id;
    o.textContent = h.name;
    if (h.id === sharedCalHabitId) o.selected = true;
    sel.appendChild(o);
  }
  await drawSharedCalendar();
}

async function drawSharedCalendar() {
  const [y, m] = sharedCalMonth.split("-").map(Number);
  $("#shared-cal-label").textContent = frMonth(sharedCalMonth);
  const data = await api(
    `/api/habits/${sharedCalHabitId}/calendar?month=${sharedCalMonth}&owner=${sharedOwnerId}`
  );
  const statuses = data.statuses || {};
  const notes = data.notes || {};
  const mask = data.days;
  const start = data.start_date;
  const end = data.end_date;
  const today = toISODate(new Date());
  const color = (sharedCalHabits.find((h) => h.id === sharedCalHabitId) || {}).color || "#4f46e5";
  const MISSED = "#dc2626";

  const head = $("#shared-cal-weekdays");
  head.innerHTML = "";
  for (const { label } of WEEKDAYS) {
    const d = document.createElement("div");
    d.className = "cal-head";
    d.textContent = label;
    head.appendChild(d);
  }

  const grid = $("#shared-cal-grid");
  grid.innerHTML = "";
  const firstDow = new Date(y, m - 1, 1).getDay();
  const lead = (firstDow + 6) % 7;
  for (let i = 0; i < lead; i++) {
    const e = document.createElement("div");
    e.className = "cal-cell empty";
    grid.appendChild(e);
  }

  const daysInMonth = new Date(y, m, 0).getDate();
  let sc = 0, ds = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${sharedCalMonth}-${String(d).padStart(2, "0")}`;
    const dow = new Date(y, m - 1, d).getDay();
    const status = statuses[iso] || "none";
    const isDone = status === "done";
    const outRange = (start && iso < start) || (end && iso > end);
    const scheduled = mask[dow] === "1" && !outRange;
    if (scheduled) sc++;
    if (scheduled && isDone) ds++;

    const cell = document.createElement("div");
    cell.className = "cal-cell";
    if (outRange) cell.classList.add("out");
    if (scheduled) cell.classList.add("scheduled");
    else cell.classList.add("off");
    if (iso === today) cell.classList.add("today");
    if (notes[iso]) cell.classList.add("has-note");
    if (isDone) {
      cell.classList.add("done");
      cell.style.background = color;
    } else if (status === "missed") {
      cell.classList.add("missed");
      cell.style.background = MISSED;
    }
    const num = document.createElement("span");
    num.className = "cal-num";
    num.textContent = d;
    const dot = document.createElement("span");
    dot.className = "cal-dot";
    if (scheduled && status === "none") dot.style.background = color;
    cell.append(num, dot);

    if (notes[iso]) {
      cell.style.cursor = "pointer";
      cell.title = "Voir le commentaire";
      cell.addEventListener("click", () => {
        const nv = $("#shared-cal-noteview");
        nv.classList.remove("hidden");
        nv.innerHTML = `<strong>${frDate(iso)}</strong><br>${escapeHtml(notes[iso])}`;
      });
    }
    grid.appendChild(cell);
  }

  const pct = sc ? Math.round((ds / sc) * 100) : 0;
  $("#shared-cal-stats").innerHTML = `
    <div class="cal-progress"><span style="width:${pct}%;background:${color}"></span></div>
    <span class="cal-stats-text"><b>${ds}</b> / ${sc} jours prévus · ${pct}%</span>`;
  $("#shared-cal-legend").innerHTML = `
    <span><i class="lg-swatch" style="background:${color}"></i> Réalisé</span>
    <span><i class="lg-dot" style="background:${color}"></i> Jour prévu</span>
    <span><i class="lg-note">💬</i> Commentaire (cliquer)</span>`;
  $("#shared-cal-noteview").classList.add("hidden");
}

$("#shared-cal-habit").addEventListener("change", (e) => {
  sharedCalHabitId = Number(e.target.value);
  drawSharedCalendar();
});
$("#shared-cal-prev").addEventListener("click", () => shiftSharedCalMonth(-1));
$("#shared-cal-next").addEventListener("click", () => shiftSharedCalMonth(1));
function shiftSharedCalMonth(delta) {
  const [y, m] = sharedCalMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  sharedCalMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  drawSharedCalendar();
}

// --- Synthèse partagée (lecture seule) ---
let sharedYear = currentYear;
let sharedChartMode = "count";
let sharedSelectedHabits = null;
let sharedTrends = null;
let sharedKnownIds = new Set();

async function renderSharedChart() {
  $("#shared-year").value = sharedYear;
  const data = await api(`/api/trends?year=${sharedYear}&owner=${sharedOwnerId}`);
  sharedTrends = data;
  const block = $("#shared-chart-block");
  if (!data.habits.length) {
    block.classList.add("hidden");
    return;
  }
  block.classList.remove("hidden");

  const ids = new Set(data.habits.map((h) => h.id));
  if (sharedSelectedHabits === null) {
    sharedSelectedHabits = new Set(ids);
  } else {
    for (const id of [...sharedSelectedHabits]) if (!ids.has(id)) sharedSelectedHabits.delete(id);
    for (const id of ids) if (!sharedKnownIds.has(id)) sharedSelectedHabits.add(id);
    if (!sharedSelectedHabits.size) sharedSelectedHabits = new Set(ids);
  }
  sharedKnownIds = ids;

  renderSharedFilter(data.habits);
  renderTrendsChart($("#shared-chart-wrap"), sharedTrends, sharedSelectedHabits, sharedChartMode);
}

function renderSharedFilter(habits) {
  const wrap = $("#shared-habit-filter");
  wrap.innerHTML = "";
  for (const h of habits) {
    const active = sharedSelectedHabits.has(h.id);
    const chip = document.createElement("button");
    chip.className = "filter-chip" + (active ? " active" : "");
    chip.innerHTML = `<span class="chip-dot" style="background:${active ? h.color : "var(--border)"}"></span>${escapeHtml(h.name)}`;
    chip.style.borderColor = active ? h.color : "";
    chip.addEventListener("click", () => {
      if (sharedSelectedHabits.has(h.id)) sharedSelectedHabits.delete(h.id);
      else sharedSelectedHabits.add(h.id);
      if (!sharedSelectedHabits.size) sharedSelectedHabits.add(h.id);
      renderSharedFilter(habits);
      renderTrendsChart($("#shared-chart-wrap"), sharedTrends, sharedSelectedHabits, sharedChartMode);
    });
    wrap.appendChild(chip);
  }
}

document.querySelectorAll("#shared-chart-modes .mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#shared-chart-modes .mode-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    sharedChartMode = btn.dataset.mode;
    renderTrendsChart($("#shared-chart-wrap"), sharedTrends, sharedSelectedHabits, sharedChartMode);
  });
});
$("#shared-year").addEventListener("change", (e) => {
  const v = parseInt(e.target.value, 10);
  if (!Number.isNaN(v)) {
    sharedYear = v;
    renderSharedChart();
  }
});
$("#shared-year-prev").addEventListener("click", () => { sharedYear--; renderSharedChart(); });
$("#shared-year-next").addEventListener("click", () => { sharedYear++; renderSharedChart(); });

// --- Gestion des partages (qui peut voir mes habitudes) ---
async function renderShares() {
  const shares = await api("/api/shares");
  const list = $("#share-list");
  list.innerHTML = "";
  for (const s of shares) {
    const li = document.createElement("li");
    li.className = "share-item";
    const span = document.createElement("span");
    const scope = s.habit_name ? s.habit_name : "Toutes les habitudes";
    span.innerHTML = `${escapeHtml(s.email)} <span class="share-scope">— ${escapeHtml(scope)}</span>`;
    const del = document.createElement("button");
    del.className = "icon-btn danger";
    del.textContent = "✕";
    del.title = "Révoquer le partage";
    del.addEventListener("click", async () => {
      await api("/api/shares/" + s.id, { method: "DELETE" });
      renderShares();
    });
    li.append(span, del);
    list.appendChild(li);
  }
}

$("#password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#pw-msg");
  msg.classList.remove("hidden");
  const current = $("#pw-current").value;
  const next = $("#pw-new").value;
  const confirm = $("#pw-confirm").value;
  if (next !== confirm) {
    msg.textContent = "Les deux nouveaux mots de passe ne correspondent pas.";
    msg.className = "share-msg err";
    return;
  }
  try {
    await api("/api/auth/password", {
      method: "PUT",
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
    $("#password-form").reset();
    msg.textContent = "Mot de passe changé ✓";
    msg.className = "share-msg ok";
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "share-msg err";
  }
});

$("#share-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#share-email").value.trim();
  const habitId = $("#share-habit").value; // "" = toutes
  const msg = $("#share-msg");
  try {
    await api("/api/shares", {
      method: "POST",
      body: JSON.stringify({ email, habit_id: habitId || null }),
    });
    $("#share-email").value = "";
    $("#share-habit").value = "";
    msg.textContent = "Partagé ✓";
    msg.className = "share-msg ok";
    renderShares();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "share-msg err";
  }
});

// --- Manage view ---
async function renderManage() {
  renderShares();
  const habits = await api("/api/habits");
  const list = $("#manage-list");
  list.innerHTML = "";
  $("#manage-empty").classList.toggle("hidden", habits.length > 0);

  // Sélecteur d'habitude du partage (Toutes + une option par habitude).
  const shareSel = $("#share-habit");
  shareSel.innerHTML = '<option value="">Toutes les habitudes</option>';
  for (const h of habits) {
    const o = document.createElement("option");
    o.value = h.id;
    o.textContent = h.name;
    shareSel.appendChild(o);
  }

  for (const h of habits) {
    const li = document.createElement("li");
    li.className = "manage-item";

    const top = document.createElement("div");
    top.className = "manage-top";

    const color = document.createElement("input");
    color.type = "color";
    color.value = h.color;

    const name = document.createElement("input");
    name.type = "text";
    name.value = h.name;

    const daysWrap = document.createElement("div");
    daysWrap.className = "days-picker";

    // Ligne de dates de validité
    const datesRow = document.createElement("div");
    datesRow.className = "habit-dates";
    const start = document.createElement("input");
    start.type = "date";
    start.value = h.start_date || "";
    const end = document.createElement("input");
    end.type = "date";
    end.value = h.end_date || "";
    const lblStart = document.createElement("label");
    lblStart.append("Début ", start);
    const lblEnd = document.createElement("label");
    lblEnd.append("Fin ", end);
    datesRow.append(lblStart, lblEnd);

    const save = async () => {
      const newName = name.value.trim();
      if (!newName) {
        name.value = h.name;
        return;
      }
      try {
        await api("/api/habits/" + h.id, {
          method: "PUT",
          body: JSON.stringify({
            name: newName,
            color: color.value,
            days: maskToDays(daysWrap.dataset.mask),
            start_date: start.value || null,
            end_date: end.value || null,
          }),
        });
      } catch (err) {
        alert(err.message);
        // restaure les valeurs connues
        start.value = h.start_date || "";
        end.value = h.end_date || "";
        return;
      }
      h.name = newName;
      h.color = color.value;
      h.days = daysWrap.dataset.mask;
      h.start_date = start.value || null;
      h.end_date = end.value || null;
    };
    name.addEventListener("blur", save);
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
    });
    color.addEventListener("change", save);
    start.addEventListener("change", save);
    end.addEventListener("change", save);

    buildDaysPicker(daysWrap, h.days || "1111111", save);

    const del = document.createElement("button");
    del.className = "icon-btn danger";
    del.textContent = "🗑";
    del.title = "Supprimer";
    del.addEventListener("click", async () => {
      if (!confirm(`Supprimer « ${h.name} » et tout son historique ?`)) return;
      await api("/api/habits/" + h.id, { method: "DELETE" });
      renderManage();
    });

    top.append(color, name, del);
    li.append(top, daysWrap, datesRow);
    list.appendChild(li);
  }
}

buildDaysPicker($("#new-habit-days"), "1111111");

$("#habit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#habit-name").value.trim();
  if (!name) return;
  try {
    await api("/api/habits", {
      method: "POST",
      body: JSON.stringify({
        name,
        color: $("#habit-color").value,
        days: maskToDays($("#new-habit-days").dataset.mask),
        start_date: $("#habit-start").value || null,
        end_date: $("#habit-end").value || null,
      }),
    });
  } catch (err) {
    alert(err.message);
    return;
  }
  $("#habit-name").value = "";
  $("#habit-color").value = "#4f46e5";
  $("#habit-start").value = "";
  $("#habit-end").value = "";
  buildDaysPicker($("#new-habit-days"), "1111111"); // réinitialise à « tous »
  renderManage();
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// --- Authentification (frontend) ---
let authMode = "login"; // login | register

function showAuthError(msg) {
  const el = $("#auth-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function hideAuthError() {
  $("#auth-error").classList.add("hidden");
}

function setAuthMode(mode) {
  authMode = mode;
  const login = mode === "login";
  $("#auth-submit").textContent = login ? "Se connecter" : "Créer mon compte";
  $("#auth-subtitle").textContent = login
    ? "Connecte-toi pour accéder à tes habitudes."
    : "Crée ton compte pour commencer.";
  $("#auth-switch-text").textContent = login ? "Pas encore de compte ?" : "Déjà un compte ?";
  $("#auth-switch-btn").textContent = login ? "Créer un compte" : "Se connecter";
  $("#auth-password").setAttribute("autocomplete", login ? "current-password" : "new-password");
  hideAuthError();
}

$("#auth-switch-btn").addEventListener("click", () =>
  setAuthMode(authMode === "login" ? "register" : "login")
);

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAuthError();
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  const url = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error || `Erreur ${res.status}`);
    }
    const user = await res.json();
    $("#auth-password").value = "";
    enterApp(user);
  } catch (err) {
    showAuthError(err.message);
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  location.reload();
});

let currentUserEmail = "";
function enterApp(user) {
  document.body.classList.add("authed");
  currentUserEmail = user.email;
  $("#user-email").textContent = user.email;
  renderDay();
}

// --- Vue Mon compte ---
async function renderAccount() {
  $("#account-email").textContent = currentUserEmail;
  const { url } = await api("/api/calendar-url");
  $("#ical-url").value = url;
}

$("#ical-copy").addEventListener("click", async () => {
  const input = $("#ical-url");
  const msg = $("#ical-msg");
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select(); // repli si le presse-papiers est indisponible
    document.execCommand("copy");
  }
  msg.textContent = "URL copiée ✓";
  msg.className = "share-msg ok";
});

$("#ical-regen").addEventListener("click", async () => {
  if (!confirm("Régénérer l'URL ? L'ancienne cessera de fonctionner.")) return;
  const { url } = await api("/api/calendar-url/regenerate", { method: "POST" });
  $("#ical-url").value = url;
  const msg = $("#ical-msg");
  msg.textContent = "Nouvelle URL générée. Mets à jour ton agenda.";
  msg.className = "share-msg ok";
});

// --- Init : vérifie la session puis affiche l'app ou l'écran de connexion ---
(async function init() {
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) enterApp(await res.json());
    else setAuthMode("login");
  } catch {
    setAuthMode("login");
  }
})();
