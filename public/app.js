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

// --- State ---
let currentDate = toISODate(new Date());
let currentMonth = currentDate.slice(0, 7);
let currentYear = new Date().getFullYear();
let selectedHabits = null; // Set d'ids affichés dans la synthèse (null = tous)

// --- Tabs ---
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    const view = tab.dataset.view;
    $("#view-" + view).classList.add("active");
    if (view === "day") renderDay();
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
        <span class="count">${h.count} / ${data.daysInMonth} j · ${h.rate}%</span>
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

function drawChart() {
  const wrap = $("#chart-wrap");
  if (!trendsCache || trendsCache.habits.length === 0) {
    wrap.innerHTML = '<div class="chart-empty">Aucune donnée.</div>';
    return;
  }
  const shown = trendsCache.habits.filter((h) => selectedHabits.has(h.id));

  // Géométrie
  const W = 900, H = 380;
  const padL = 40, padR = 16, padT = 20, padB = 36;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxVal = Math.max(1, ...shown.flatMap((h) => h.monthly));
  // Échelle Y arrondie à un palier lisible
  const step = Math.max(1, Math.ceil(maxVal / 5));
  const yMax = step * 5;

  const x = (i) => padL + (plotW * i) / 11;
  const y = (v) => padT + plotH - (plotH * v) / yMax;

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution mensuelle">`;

  // Grille horizontale + labels Y
  for (let g = 0; g <= 5; g++) {
    const val = (yMax / 5) * g;
    const gy = y(val);
    svg += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#e5e7eb" stroke-width="1"/>`;
    svg += `<text x="${padL - 8}" y="${gy + 4}" font-size="11" fill="#6b7280" text-anchor="end">${val}</text>`;
  }
  // Labels X (mois)
  for (let i = 0; i < 12; i++) {
    svg += `<text x="${x(i)}" y="${H - 12}" font-size="11" fill="#6b7280" text-anchor="middle">${MONTHS_FR[i]}</text>`;
  }

  // Une ligne + points par habitude
  for (const h of shown) {
    const pts = h.monthly.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    svg += `<polyline points="${pts}" fill="none" stroke="${h.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    h.monthly.forEach((v, i) => {
      svg += `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${h.color}"><title>${escapeHtml(h.name)} — ${MONTHS_FR[i]} : ${v}</title></circle>`;
    });
  }

  svg += `</svg>`;
  wrap.innerHTML = svg;
}

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

    const color = document.createElement("input");
    color.type = "color";
    color.value = h.color;

    const name = document.createElement("input");
    name.type = "text";
    name.value = h.name;

    const save = async () => {
      const newName = name.value.trim();
      if (!newName) {
        name.value = h.name;
        return;
      }
      await api("/api/habits/" + h.id, {
        method: "PUT",
        body: JSON.stringify({ name: newName, color: color.value }),
      });
      h.name = newName;
      h.color = color.value;
    };
    name.addEventListener("blur", save);
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
    });
    color.addEventListener("change", save);

    const del = document.createElement("button");
    del.className = "icon-btn danger";
    del.textContent = "🗑";
    del.title = "Supprimer";
    del.addEventListener("click", async () => {
      if (!confirm(`Supprimer « ${h.name} » et tout son historique ?`)) return;
      await api("/api/habits/" + h.id, { method: "DELETE" });
      renderManage();
    });

    li.append(color, name, del);
    list.appendChild(li);
  }
}

$("#habit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#habit-name").value.trim();
  if (!name) return;
  await api("/api/habits", {
    method: "POST",
    body: JSON.stringify({ name, color: $("#habit-color").value }),
  });
  $("#habit-name").value = "";
  $("#habit-color").value = "#4f46e5";
  renderManage();
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// --- Init ---
renderDay();
