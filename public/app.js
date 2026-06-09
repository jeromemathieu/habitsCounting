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

  const grid = $("#calendar-grid");
  grid.innerHTML = "";

  // En-têtes L M M J V S D
  for (const { label } of WEEKDAYS) {
    const h = document.createElement("div");
    h.className = "cal-head";
    h.textContent = label;
    grid.appendChild(h);
  }

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

function drawChart() {
  const wrap = $("#chart-wrap");
  if (!trendsCache || trendsCache.habits.length === 0) {
    wrap.innerHTML = '<div class="chart-empty">Aucune donnée.</div>';
    return;
  }
  const shown = trendsCache.habits.filter((h) => selectedHabits.has(h.id));
  if (shown.length === 0) {
    wrap.innerHTML = '<div class="chart-empty">Sélectionne au moins une habitude.</div>';
    return;
  }

  // Géométrie
  const W = 900, H = 380;
  const padL = 44, padR = 16, padT = 20, padB = 36;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const x = (i) => padL + (plotW * i) / 11;

  const isRate = chartMode === "rate";
  const isStacked = chartMode === "stacked";

  // Valeur affichée par habitude/mois selon le mode
  const valOf = (h, i) =>
    isRate ? (h.scheduled[i] ? Math.round((h.monthly[i] / h.scheduled[i]) * 100) : 0) : h.monthly[i];

  // Échelle Y
  let yMax;
  if (isRate) {
    yMax = 100;
  } else if (isStacked) {
    const totals = Array.from({ length: 12 }, (_, i) =>
      shown.reduce((s, h) => s + h.monthly[i], 0));
    const maxVal = Math.max(1, ...totals);
    yMax = Math.max(5, Math.ceil(maxVal / 5) * 5);
  } else {
    const maxVal = Math.max(1, ...shown.flatMap((h) => h.monthly));
    yMax = Math.max(5, Math.ceil(maxVal / 5) * 5);
  }
  const y = (v) => padT + plotH - (plotH * v) / yMax;

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution mensuelle">`;

  // Grille horizontale + labels Y
  for (let g = 0; g <= 5; g++) {
    const val = Math.round((yMax / 5) * g);
    const gy = y(val);
    svg += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#e5e7eb" stroke-width="1"/>`;
    svg += `<text x="${padL - 8}" y="${gy + 4}" font-size="11" fill="#6b7280" text-anchor="end">${val}${isRate ? "%" : ""}</text>`;
  }
  // Labels X (mois)
  for (let i = 0; i < 12; i++) {
    svg += `<text x="${x(i)}" y="${H - 12}" font-size="11" fill="#6b7280" text-anchor="middle">${MONTHS_FR[i]}</text>`;
  }

  if (isStacked) {
    // Barres empilées : un segment par habitude, cumul du nombre de complétions.
    const slot = plotW / 12;
    const bw = slot * 0.6;
    for (let i = 0; i < 12; i++) {
      const cx = padL + slot * i + slot / 2;
      let acc = 0;
      for (const h of shown) {
        const v = h.monthly[i];
        if (v <= 0) continue;
        const yTop = y(acc + v);
        const hgt = y(acc) - yTop;
        svg += `<rect x="${cx - bw / 2}" y="${yTop}" width="${bw}" height="${hgt}" fill="${h.color}"><title>${escapeHtml(h.name)} — ${MONTHS_FR[i]} : ${v}</title></rect>`;
        acc += v;
      }
    }
  } else {
    // Lignes : une par habitude (nombre ou taux %)
    for (const h of shown) {
      const pts = h.monthly.map((_, i) => `${x(i)},${y(valOf(h, i))}`).join(" ");
      svg += `<polyline points="${pts}" fill="none" stroke="${h.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
      h.monthly.forEach((_, i) => {
        const v = valOf(h, i);
        svg += `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${h.color}"><title>${escapeHtml(h.name)} — ${MONTHS_FR[i]} : ${v}${isRate ? "%" : ""}</title></circle>`;
      });
    }
  }

  svg += `</svg>`;
  wrap.innerHTML = svg;
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
