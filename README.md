# ✅ Suivi des habitudes (Habits Counting)

Application web pour **noter chaque jour les actions réalisées** et obtenir un
**récapitulatif mensuel** de ta régularité.

## Fonctionnalités

- **Mes habitudes** : créer, renommer, recolorer et supprimer tes habitudes.
- **Jour** : cocher d'un clic les habitudes réalisées, naviguer entre les jours.
- **Récap mensuel** : nombre d'actions cochées, régularité moyenne, et une barre
  de progression par habitude (X jours sur le mois + pourcentage).
- **Jours prévus** : pour chaque habitude, choix des jours de la semaine où
  elle s'applique. Le taux de régularité se calcule sur ces jours-là.
- **Calendrier** : pour une habitude donnée, un calendrier mensuel cliquable
  pour cocher/décocher directement les jours réalisés.
- **Synthèse** : graphique de l'évolution mois par mois sur une année, avec
  filtre par habitude et 3 modes (nombre, taux %, cumulé empilé).

## Stack

- Backend : **Node.js** + **Express**
- Base de données : **SQLite** (fichier `data.sqlite`, via `better-sqlite3`)
- Frontend : **HTML / CSS / JS** purs (servis en statique), sans framework.

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

| Variable  | Défaut          | Description                          |
| --------- | --------------- | ------------------------------------ |
| `PORT`    | `3000`          | Port d'écoute du serveur             |
| `DB_PATH` | `./data.sqlite` | Chemin du fichier base de données    |

## API

| Méthode  | Route                      | Description                                   |
| -------- | -------------------------- | --------------------------------------------- |
| `GET`    | `/api/habits`              | Liste des habitudes actives                   |
| `POST`   | `/api/habits`              | Créer une habitude `{name, color}`            |
| `PUT`    | `/api/habits/:id`          | Modifier une habitude `{name, color}`         |
| `DELETE` | `/api/habits/:id`          | Supprimer une habitude (et son historique)    |
| `GET`    | `/api/logs?date=YYYY-MM-DD`| Ids des habitudes cochées ce jour-là          |
| `POST`   | `/api/logs/toggle`         | Basculer `{habit_id, date}`                   |
| `GET`    | `/api/summary?month=YYYY-MM`| Récapitulatif mensuel                        |
| `GET`    | `/api/trends?year=YYYY`    | Complétions par mois et par habitude (synthèse) |
| `GET`    | `/api/habits/:id/calendar?month=YYYY-MM` | Dates réalisées + jours prévus, pour le calendrier |

## Modèle de données

- `habits` : id, name, color, sort_order, archived, created_at, days
  (`days` = masque de 7 caractères '1'/'0', indexé par `getDay()` :
  0 = dimanche … 6 = samedi)
- `logs` : id, habit_id, date — une ligne = habitude cochée ce jour
  (contrainte d'unicité sur `(habit_id, date)`)
