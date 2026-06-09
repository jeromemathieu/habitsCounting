# ✅ Suivi des habitudes (Habits Counting)

Application web pour **noter chaque jour les actions réalisées** et obtenir un
**récapitulatif mensuel** de ta régularité.

## Fonctionnalités

- **Comptes & authentification** : inscription / connexion par email + mot de
  passe ; chaque utilisateur ne voit que ses propres habitudes. Sessions par
  cookie httpOnly, mots de passe hachés (scrypt).
- **Partage en lecture** : partager la consultation de ses habitudes avec un
  autre utilisateur (par email) ; il les voit en lecture seule dans l'onglet
  « Partagé » (statut du jour, récap mensuel, calendrier et synthèse). Les
  écritures restent toujours limitées à ses propres données.
- **Mes habitudes** : créer, renommer, recolorer et supprimer tes habitudes.
- **Jour** : cocher d'un clic les habitudes réalisées, naviguer entre les jours.
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

> L'autorisation des inscriptions n'est plus une variable d'environnement :
> elle se règle désormais dans la **console d'administration**.

## Administration

Si `ADMIN_PASSWORD` est défini, une console est accessible sur **`/admin.html`**
(identifiants `ADMIN_EMAIL` / `ADMIN_PASSWORD`, indépendants des comptes
utilisateurs). Elle permet de : lister les utilisateurs et leur nombre
d'habitudes, modifier leur email, **définir un nouveau mot de passe**, supprimer
un compte, et **activer/désactiver les inscriptions**.

## API

Toutes les routes `/api` (hors authentification) requièrent une session valide
(cookie) et ne renvoient que les données de l'utilisateur connecté.

| Méthode  | Route                      | Description                                   |
| -------- | -------------------------- | --------------------------------------------- |
| `POST`   | `/api/auth/register`       | Inscription `{email, password}` (8 car. min.) |
| `POST`   | `/api/auth/login`          | Connexion `{email, password}`                 |
| `POST`   | `/api/auth/logout`         | Déconnexion                                   |
| `GET`    | `/api/auth/me`             | Utilisateur courant (ou 401)                  |
| `GET`    | `/api/habits`              | Liste des habitudes actives                   |
| `POST`   | `/api/habits`              | Créer une habitude `{name, color, days, start_date, end_date}` |
| `PUT`    | `/api/habits/:id`          | Modifier une habitude                         |
| `DELETE` | `/api/habits/:id`          | Supprimer une habitude (et son historique)    |
| `GET`    | `/api/logs?date=YYYY-MM-DD`| Ids des habitudes cochées ce jour-là          |
| `POST`   | `/api/logs/toggle`         | Basculer `{habit_id, date}`                   |
| `GET`    | `/api/notes?date=YYYY-MM-DD`| Commentaires des habitudes pour ce jour      |
| `PUT`    | `/api/notes`               | Enregistrer/supprimer `{habit_id, date, text}` |
| `GET`    | `/api/summary?month=YYYY-MM`| Récapitulatif mensuel                        |
| `GET`    | `/api/trends?year=YYYY`    | Complétions par mois et par habitude (synthèse) |
| `GET`    | `/api/habits/:id/calendar?month=YYYY-MM` | Dates réalisées + jours prévus, pour le calendrier |
| `GET`    | `/api/shares`              | Personnes avec qui je partage (sortant)       |
| `POST`   | `/api/shares`              | Partager avec `{email}`                       |
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
- `logs` : id, habit_id, date — une ligne = habitude cochée ce jour
  (contrainte d'unicité sur `(habit_id, date)`)
- `notes` : id, habit_id, date, text — un commentaire par habitude et par jour
  (contrainte d'unicité sur `(habit_id, date)`)
- `shares` : id, owner_id, viewer_id — partage en lecture du propriétaire vers
  le lecteur (contrainte d'unicité sur `(owner_id, viewer_id)`)
- `settings` : key, value — réglages applicatifs (ex. `allow_registration`)

> **Migration** : au démarrage, les colonnes manquantes sont ajoutées
> automatiquement. La **première inscription** récupère les habitudes
> existantes créées avant l'ajout de l'authentification.
