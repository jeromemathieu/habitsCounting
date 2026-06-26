# ✅ Suivi des habitudes (Habits Counting)

Application web pour **noter chaque jour les actions réalisées** et obtenir un
**récapitulatif mensuel** de ta régularité.

## Fonctionnalités

- **Comptes & authentification** : inscription / connexion par email + mot de
  passe ; chaque utilisateur ne voit que ses propres habitudes. Sessions par
  cookie httpOnly, mots de passe hachés (scrypt).
- **Partage en lecture** : partager la consultation de ses habitudes avec un
  autre utilisateur (par email), **toutes ou une seule** ; il les voit en
  lecture seule dans l'onglet « Partagé » (statut du jour, récap mensuel,
  calendrier et synthèse). Les écritures restent limitées à ses propres données.
- **Emoji par habitude** : un emoji optionnel, suggéré automatiquement selon le nom.
- **Activité & notifications** : onglet « Activité » listant les actions sur les
  habitudes ; badge de notification quand quelqu'un commente une habitude partagée.
- **Commentaires de lecteurs** : sur une habitude partagée, le lecteur peut
  laisser un commentaire qui notifie le propriétaire.
- **Mon compte** : onglet dédié pour voir son email et changer son mot de passe.
- **Mes habitudes** : créer, renommer, recolorer et supprimer tes habitudes.
- **Jour** : 3 états par habitude — **fait** ✓, **pas fait** ✗ ou **rien** —
  d'un clic (cycle), avec un code couleur distinct ; navigation entre les jours.
- **Abonnement calendrier (iCal)** : une URL secrète à ajouter dans Google
  Agenda / Apple Calendrier pour voir ses habitudes (✓/✗) en lecture seule.
- **Récap mensuel** : nombre d'actions cochées, régularité moyenne, et une barre
  de progression par habitude (X jours sur le mois + pourcentage).
- **Jours prévus** : pour chaque habitude, choix des jours de la semaine où
  elle s'applique. Le taux de régularité se calcule sur ces jours-là.
- **Période de validité** : dates de début et de fin optionnelles par habitude ;
  le taux ne compte que les jours prévus dans cette période.
- **Calendrier** : pour une habitude donnée, un calendrier mensuel ; un clic sur
  un jour ouvre un panneau pour le marquer fait/pas fait et y ajouter un commentaire.
- **Commentaires** : une note libre par habitude et par jour, éditable depuis la
  vue Jour (bouton 💬) comme depuis le calendrier.
- **Synthèse** : graphique interactif (Chart.js) de l'évolution mois par mois
  sur une année, avec filtre par habitude et 3 modes (nombre, taux %,
  cumulé empilé).
- **PWA** : installable sur mobile/desktop (icône, plein écran) avec un
  service worker (shell en cache pour le hors-ligne ; l'API n'est jamais cachée).

## Stack

- Backend : **Node.js** + **Express**
- Base de données : **SQLite** (fichier `data.sqlite`, via `better-sqlite3`)
- Frontend : **HTML / CSS / JS** purs (servis en statique), sans framework.
  Graphiques via **Chart.js** (vendoré en local dans `public/vendor/`, aucun CDN).

## Démarrage

```bash
npm install
npm start
```

Puis ouvrir http://localhost:3000

En développement (rechargement auto) : `npm run dev`

## Avec Docker

Avec **docker compose** (recommandé — la base SQLite est conservée dans un volume) :

```bash
docker compose up --build
```

Puis ouvrir http://localhost:3000. Les données persistent dans le volume
`habits-data` entre les redémarrages.

Sans compose, en image seule :

```bash
docker build -t habits-counting .
docker run -p 3000:3000 -v habits-data:/data habits-counting
```

## Configuration

| Variable         | Défaut          | Description                                              |
| ---------------- | --------------- | ------------------------------------------------------- |
| `PORT`           | `3000`          | Port d'écoute du serveur                                |
| `DB_PATH`        | `./data.sqlite` | Chemin du fichier base de données                       |
| `ADMIN_PASSWORD` | _(non défini)_  | Active la console d'admin (`/admin.html`) avec ce mot de passe unique. Non défini = console désactivée. |
| `ADMIN_EMAIL`    | `admin`         | Identifiant de connexion de la console d'admin          |
| `VAPID_SUBJECT`  | `mailto:admin@localhost` | Contact des notifications push (optionnel ; clés VAPID auto-générées) |

> L'autorisation des inscriptions n'est plus une variable d'environnement :
> elle se règle désormais dans la **console d'administration**.

## Administration

Si `ADMIN_PASSWORD` est défini, une console est accessible sur **`/admin.html`**
(identifiants `ADMIN_EMAIL` / `ADMIN_PASSWORD`, indépendants des comptes
utilisateurs). Elle permet de : lister les utilisateurs et leur nombre
d'habitudes, modifier leur email, **définir un nouveau mot de passe**, supprimer
un compte, et **activer/désactiver les inscriptions**.

## Serveur MCP (pilotage en langage naturel)

Le fichier `mcp-server.js` expose l'application comme **serveur MCP** (Model
Context Protocol). Connecté à Claude (Desktop, Code…), il permet de demander en
langage naturel : « combien d'habitudes je suis ? », « ajoute une habitude
Lecture le week-end », « coche Sport pour hier », « mes stats de mai »…

**Outils disponibles** : `list_habits`, `add_habit`, `mark_habit`,
`day_status`, `monthly_summary`, `yearly_stats`, `add_note`,
`notifications`, `recent_activity`, `search_comments`.

Authentification (au choix) :

| Variable          | Description                                                   |
| ----------------- | ------------------------------------------------------------- |
| `HABITS_URL`      | URL de l'app (défaut `http://localhost:3000`)                 |
| `HABITS_API_KEY`  | **Clé API** (recommandé) — à générer dans « Mon compte »      |
| `HABITS_EMAIL`    | Email du compte (si pas de clé API)                          |
| `HABITS_PASSWORD` | Mot de passe du compte (si pas de clé API)                  |

La clé API évite de stocker ton mot de passe : génère-la depuis l'onglet
**Mon compte → Clé API (MCP)**, puis renseigne `HABITS_API_KEY`.

Exemple de configuration (Claude Desktop `claude_desktop_config.json`, ou
`.mcp.json` pour Claude Code) :

```json
{
  "mcpServers": {
    "habits": {
      "command": "node",
      "args": ["/chemin/vers/habitsCounting/mcp-server.js"],
      "env": {
        "HABITS_URL": "https://habits.exemple.com",
        "HABITS_EMAIL": "toi@exemple.com",
        "HABITS_PASSWORD": "ton-mot-de-passe"
      }
    }
  }
}
```

> Le serveur MCP tourne sur **ta machine** (transport stdio) et parle à l'app
> via HTTP — il fonctionne donc aussi bien avec une instance locale qu'avec le
> VPS en HTTPS. Il faut `npm install` dans le dossier pour ses dépendances.

## API

Toutes les routes `/api` (hors authentification) requièrent une session valide
(cookie) et ne renvoient que les données de l'utilisateur connecté.

| Méthode  | Route                      | Description                                   |
| -------- | -------------------------- | --------------------------------------------- |
| `POST`   | `/api/auth/register`       | Inscription `{email, password}` (8 car. min.) |
| `POST`   | `/api/auth/login`          | Connexion `{email, password}`                 |
| `POST`   | `/api/auth/logout`         | Déconnexion                                   |
| `GET`    | `/api/auth/me`             | Utilisateur courant (ou 401)                  |
| `PUT`    | `/api/auth/password`       | Changer son mot de passe `{current_password, new_password}` |
| `GET`    | `/api/habits`              | Liste des habitudes actives                   |
| `POST`   | `/api/habits`              | Créer une habitude `{name, color, days, start_date, end_date}` |
| `PUT`    | `/api/habits/:id`          | Modifier une habitude                         |
| `DELETE` | `/api/habits/:id`          | Supprimer une habitude (et son historique)    |
| `GET`    | `/api/logs?date=YYYY-MM-DD`| Statuts du jour `{habit_id: 'done'\|'missed'}` |
| `POST`   | `/api/logs/set`            | Définir `{habit_id, date, status}` (done/missed/none) |
| `POST`   | `/api/logs/toggle`         | Basculer fait/rien `{habit_id, date}`         |
| `GET`    | `/api/calendar-url`        | URL d'abonnement iCal de l'utilisateur        |
| `POST`   | `/api/calendar-url/regenerate` | Régénère le jeton iCal                    |
| `GET`    | `/calendar/:token.ics`     | Flux iCalendar public (par jeton)             |
| `GET`    | `/api/notes?date=YYYY-MM-DD`| Commentaires des habitudes pour ce jour      |
| `PUT`    | `/api/notes`               | Enregistrer/supprimer `{habit_id, date, text}` |
| `GET`    | `/api/summary?month=YYYY-MM`| Récapitulatif mensuel                        |
| `GET`    | `/api/trends?year=YYYY`    | Complétions par mois et par habitude (synthèse) |
| `GET`    | `/api/habits/:id/calendar?month=YYYY-MM` | Dates réalisées + jours prévus, pour le calendrier |
| `GET`    | `/api/shares`              | Personnes avec qui je partage (sortant)       |
| `POST`   | `/api/shares`              | Partager avec `{email, habit_id?}` (habit_id absent = toutes) |
| `DELETE` | `/api/shares/:id`          | Révoquer un partage                           |
| `GET`    | `/api/shared`              | Personnes qui partagent avec moi (entrant)    |
| `POST`   | `/api/admin/login`         | Connexion admin `{email, password}`           |
| `GET`    | `/api/admin/users`         | (admin) Utilisateurs + nombre d'habitudes     |
| `PUT`    | `/api/admin/users/:id`     | (admin) Modifier email / mot de passe         |
| `DELETE` | `/api/admin/users/:id`     | (admin) Supprimer un utilisateur              |
| `GET/PUT`| `/api/admin/settings`      | (admin) Réglages (inscriptions on/off)        |

> Les routes de **lecture** (`/api/habits`, `/api/logs`, `/api/summary`,
> `/api/trends`, `/api/notes`, calendrier) acceptent `?owner=<id>` pour
> consulter les données d'un utilisateur qui m'a accordé un partage.

## Modèle de données

- `users` : id, email (unique), password (haché scrypt), created_at
- `sessions` : token, user_id, expires_at
- `habits` : id, name, color, sort_order, archived, created_at, days,
  start_date, end_date, **user_id**
  (`days` = masque de 7 caractères '1'/'0', indexé par `getDay()` :
  0 = dimanche … 6 = samedi ; `start_date`/`end_date` optionnelles, bornent
  le calcul du taux)
- `logs` : id, habit_id, date, status (`done`/`missed` ; absence = rien)
  (contrainte d'unicité sur `(habit_id, date)`)
- `notes` : id, habit_id, date, text — un commentaire par habitude et par jour
  (contrainte d'unicité sur `(habit_id, date)`)
- `shares` : id, owner_id, viewer_id, habit_id — partage en lecture
  (`habit_id` NULL = toutes les habitudes ; unicité sur `(owner_id, viewer_id, habit_id)`)
- `settings` : key, value — réglages applicatifs (ex. `allow_registration`)

> **Migration** : au démarrage, les colonnes manquantes sont ajoutées
> automatiquement. La **première inscription** récupère les habitudes
> existantes créées avant l'ajout de l'authentification.
