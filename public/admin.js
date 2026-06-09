// --- Helpers ---
const $ = (sel) => document.querySelector(sel);
const api = async (url, opts) => {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Erreur ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
};
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
const frDateTime = (s) => {
  const d = new Date((s || "").replace(" ", "T") + "Z");
  return isNaN(d) ? (s || "") : d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
};

// --- Login ---
$("#admin-login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#admin-login-error");
  err.classList.add("hidden");
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        email: $("#admin-email").value.trim(),
        password: $("#admin-password").value,
      }),
    });
    $("#admin-password").value = "";
    enterAdmin();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove("hidden");
  }
});

$("#admin-logout").addEventListener("click", async () => {
  await fetch("/api/admin/logout", { method: "POST" });
  location.reload();
});

function enterAdmin() {
  $("#admin-login").classList.add("hidden");
  $("#admin-app").classList.remove("hidden");
  loadSettings();
  loadUsers();
}

// --- Réglages ---
async function loadSettings() {
  const s = await api("/api/admin/settings");
  $("#set-registration").checked = !!s.allow_registration;
}
$("#set-registration").addEventListener("change", async (e) => {
  await api("/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify({ allow_registration: e.target.checked }),
  });
});

// --- Utilisateurs ---
async function loadUsers() {
  const users = await api("/api/admin/users");
  $("#users-count").textContent = `(${users.length})`;
  const tb = $("#users-tbody");
  tb.innerHTML = "";
  for (const u of users) {
    const tr = document.createElement("tr");

    const emailInput = document.createElement("input");
    emailInput.type = "email";
    emailInput.value = u.email;
    emailInput.className = "admin-input";

    const pwInput = document.createElement("input");
    pwInput.type = "password";
    pwInput.placeholder = "Laisser vide = inchangé";
    pwInput.className = "admin-input";
    pwInput.autocomplete = "new-password";

    const tdEmail = document.createElement("td");
    tdEmail.appendChild(emailInput);
    const tdCount = document.createElement("td");
    tdCount.className = "center";
    tdCount.textContent = `${u.active_count}${u.habit_count !== u.active_count ? ` (${u.habit_count})` : ""}`;
    tdCount.title = "Actives (total avec archivées)";
    const tdDate = document.createElement("td");
    tdDate.textContent = frDateTime(u.created_at);
    const tdPw = document.createElement("td");
    tdPw.appendChild(pwInput);

    const save = document.createElement("button");
    save.className = "admin-btn";
    save.textContent = "Enregistrer";
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await api("/api/admin/users/" + u.id, {
          method: "PUT",
          body: JSON.stringify({
            email: emailInput.value.trim(),
            password: pwInput.value, // vide = inchangé côté serveur
          }),
        });
        pwInput.value = "";
        flash(save, "Enregistré ✓");
        loadUsers();
      } catch (err) {
        flash(save, err.message, true);
        save.disabled = false;
      }
    });

    const del = document.createElement("button");
    del.className = "admin-btn danger";
    del.textContent = "Supprimer";
    del.addEventListener("click", async () => {
      if (!confirm(`Supprimer ${u.email} et toutes ses données ?`)) return;
      await api("/api/admin/users/" + u.id, { method: "DELETE" });
      loadUsers();
    });

    const tdActions = document.createElement("td");
    tdActions.className = "admin-actions";
    tdActions.append(save, del);

    tr.append(tdEmail, tdCount, tdDate, tdPw, tdActions);
    tb.appendChild(tr);
  }
}

function flash(btn, msg, isError) {
  const old = btn.textContent;
  btn.textContent = msg;
  btn.classList.toggle("err", !!isError);
  setTimeout(() => {
    btn.textContent = old;
    btn.classList.remove("err");
  }, 1800);
}

// --- Init ---
(async function init() {
  try {
    const res = await fetch("/api/admin/me");
    if (res.ok) {
      enterAdmin();
    } else {
      const body = await res.json().catch(() => ({}));
      if (body.configured === false) {
        $("#admin-login-sub").textContent =
          "Console non configurée : définissez ADMIN_PASSWORD (et ADMIN_EMAIL) côté serveur.";
        $("#admin-login-form").style.display = "none";
      }
    }
  } catch {
    /* écran de login affiché par défaut */
  }
})();
