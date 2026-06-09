// --- Helpers ---
const $ = (sel) => document.querySelector(sel);
const api = async (url, opts) => {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
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
    if (view === "manage") renderManage();
  });
});

// --- Day view ---
async function renderDay() {
  $("#day-picker").value = currentDate;
  $("#day-label").textContent = frDate(currentDate);

  const [habits, doneIds] = await Promise.all([
    api("/api/habits"),
    api("/api/logs?date=" + currentDate),
  ]);
  const doneSet = new Set(doneIds);

  const list = $("#day-list");
  list.innerHTML = "";
  $("#day-empty").classList.toggle("hidden", habits.length > 0);

  for (const h of habits) {
    const li = document.createElement("li");
    const done = doneSet.has(h.id);
    li.className = "habit-item" + (done ? " done" : "");
    li.style.background = done ? h.color + "1a" : "";
    li.innerHTML = `
      <span class="dot" style="background:${h.color}"></span>
      <span class="name">${escapeHtml(h.name)}</span>
      <span class="checkbox" style="${done ? `background:${h.color};border-color:${h.color}` : ""}">${done ? "✓" : ""}</span>
    `;
    li.addEventListener("click", async () => {
      await api("/api/logs/toggle", {
        method: "POST",
        body: JSON.stringify({ habit_id: h.id, date: currentDate }),
      });
      renderDay();
    });
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

async function drawCalendar() {
  const [y, m] = calMonth.split("-").map(Number);
  $("#cal-month-label").textContent = frMonth(calMonth);

  const data = await api(`/api/habits/${calHabitId}/calendar?month=${calMonth}`);
  const done = new Set(data.dates);
  const mask = data.days;
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
    const isDone = done.has(iso);
    const scheduled = mask[dow] === "1";
    if (scheduled) scheduledCount++;
    if (scheduled && isDone) doneScheduled++;

    const cell = document.createElement("div");
    cell.className = "cal-cell";
    if (scheduled) cell.classList.add("scheduled");
    else cell.classList.add("off");
    if (iso === today) cell.classList.add("today");
    if (isDone) {
      cell.classList.add("done");
      cell.style.background = color;
    }

    const num = document.createElement("span");
    num.className = "cal-num";
    num.textContent = d;
    const dot = document.createElement("span");
    dot.className = "cal-dot";
    if (scheduled && !isDone) dot.style.background = color; // point « jour prévu »
    cell.append(num, dot);

    cell.title = scheduled ? "Jour prévu" : "Jour non prévu";
    cell.addEventListener("click", async () => {
      await api("/api/logs/toggle", {
        method: "POST",
        body: JSON.stringify({ habit_id: calHabitId, date: iso }),
      });
      drawCalendar();
    });
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
    <span><i class="lg-swatch" style="background:var(--bg);border:1.5px solid var(--primary)"></i> Aujourd'hui</span>
  `;
}

// Couleur de l'habitude sélectionnée.
function getHabitColor() {
  const h = calHabits.find((x) => x.id === calHabitId);
  return h ? h.color : "#4f46e5";
}

$("#calendar-habit").addEventListener("change", async (e) => {
  calHabitId = Number(e.target.value);
  await drawCalendar();
});
$("#cal-prev-month").addEventListener("click", () => shiftCalMonth(-1));
$("#cal-next-month").addEventListener("click", () => shiftCalMonth(1));

function shiftCalMonth(delta) {
  const [y, m] = calMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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

function drawChart() {
  const wrap = $("#chart-wrap");
  const showMessage = (msg) => {
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    wrap.innerHTML = `<div class="chart-empty">${msg}</div>`;
  };

  if (!trendsCache || trendsCache.habits.length === 0) return showMessage("Aucune donnée.");
  const shown = trendsCache.habits.filter((h) => selectedHabits.has(h.id));
  if (shown.length === 0) return showMessage("Sélectionne au moins une habitude.");

  const isRate = chartMode === "rate";
  const isStacked = chartMode === "stacked";
  const valOf = (h, i) =>
    isRate ? (h.scheduled[i] ? Math.round((h.monthly[i] / h.scheduled[i]) * 100) : 0) : h.monthly[i];

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

  // Couleurs d'axes selon le thème
  const tickColor = cssVar("--muted") || "#6b7280";
  const gridColor = cssVar("--border") || "#e5e7eb";

  // (Re)crée le canvas
  if (!$("#chart-canvas")) wrap.innerHTML = '<canvas id="chart-canvas"></canvas>';
  const ctx = $("#chart-canvas");

  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart(ctx, {
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
        x: {
          stacked: isStacked,
          grid: { display: false },
          ticks: { color: tickColor },
        },
        y: {
          stacked: isStacked,
          beginAtZero: true,
          ...(isRate ? { max: 100 } : {}),
          grid: { color: gridColor },
          ticks: {
            color: tickColor,
            precision: 0,
            callback: (v) => (isRate ? v + " %" : v),
          },
        },
      },
    },
  });
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

// --- Manage view ---
async function renderManage() {
  const habits = await api("/api/habits");
  const list = $("#manage-list");
  list.innerHTML = "";
  $("#manage-empty").classList.toggle("hidden", habits.length > 0);

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

    const save = async () => {
      const newName = name.value.trim();
      if (!newName) {
        name.value = h.name;
        return;
      }
      await api("/api/habits/" + h.id, {
        method: "PUT",
        body: JSON.stringify({
          name: newName,
          color: color.value,
          days: maskToDays(daysWrap.dataset.mask),
        }),
      });
      h.name = newName;
      h.color = color.value;
      h.days = daysWrap.dataset.mask;
    };
    name.addEventListener("blur", save);
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
    });
    color.addEventListener("change", save);

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
    li.append(top, daysWrap);
    list.appendChild(li);
  }
}

buildDaysPicker($("#new-habit-days"), "1111111");

$("#habit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#habit-name").value.trim();
  if (!name) return;
  await api("/api/habits", {
    method: "POST",
    body: JSON.stringify({
      name,
      color: $("#habit-color").value,
      days: maskToDays($("#new-habit-days").dataset.mask),
    }),
  });
  $("#habit-name").value = "";
  $("#habit-color").value = "#4f46e5";
  buildDaysPicker($("#new-habit-days"), "1111111"); // réinitialise à « tous »
  renderManage();
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// --- Init ---
renderDay();
