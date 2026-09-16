# AIOSync — AIOStreams Tracker Bridge pour Simkl et PublicMetaDB

Addon de suivi de lecture destiné à la branche `feat/jellyfin` d’AIOStreams. Il reçoit les événements Jellyfin, les transmet à Simkl et/ou PublicMetaDB, puis fournit l’historique et les reprises à AIOStreams via la ressource `watch_state` v2.

Le service utilise **Node.js 24**, son exécution TypeScript native et SQLite intégré. Déploie une seule instance du service par volume SQLite ; la file n’est pas prévue pour plusieurs réplicas concurrents. Il n’a aucune dépendance npm d’exécution. Le conteneur fonctionne avec l’utilisateur non privilégié `node` et conserve ses données dans un volume Docker.

La compatibilité a été étudiée sur le commit AIOStreams **`e3879da60f65c741ada8375559903aa58a51a707`**. Cette branche évolue : les limites de sa mise en œuvre sont détaillées plus bas.

## Ce que fait le service

- Clé globale pour ouvrir l’interface de configuration.
- Plusieurs profils indépendants de synchronisation, avec une URL d’addon propre à chacun.
- Comptes Simkl et PublicMetaDB configurables par profil ; identifiants par défaut facultatifs dans `.env`.
- Connexion OAuth Simkl, ou saisie directe d’un jeton d’accès.
- Événements `start`, `pause`, `stop`, `played`, `unplayed`, y compris les marques de saisons/séries par lots.
- Plusieurs destinations d’écriture possibles, mais **une seule source de lecture par profil**, pour éviter de fusionner des historiques contradictoires.
- File d’écriture et données de synchronisation persistantes dans SQLite ; identifiants fournisseurs chiffrés avec `ENCRYPTION_KEY`.
- État `watched` complet et versionné ; suppression des titres retirés de la source, sans publier comme complet un historique partiellement lu.

Ce n’est pas un fournisseur de films, de séries ou de métadonnées. Il s’installe dans **AIOStreams**, à côté de tes addons habituels. La lecture dans Stremio lui-même ne produit pas les événements Jellyfin utilisés ici.

## Démarrage avec Docker Compose

Prérequis : Docker, Docker Compose v2 et Node.js 24 pour le petit générateur de configuration. Lance les commandes depuis ce dossier.

```bash
node scripts/generate-env.mjs https://tracker.example.com
```

Le script crée `.env` avec deux clés aléatoires, des permissions `0600` et l’URL publique choisie. Il **refuse d’écraser un fichier existant**. Pour une première utilisation sur la machine locale :

```bash
node scripts/generate-env.mjs http://localhost:7000
```

Si Node n’est pas installé sur l’hôte, le même générateur peut être exécuté dans son image officielle :

```bash
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/work" -w /work node:24-bookworm-slim \
  node scripts/generate-env.mjs https://tracker.example.com
```

Complète ensuite `.env` avec ton client Simkl et/ou ta clé PublicMetaDB, puis construis et démarre :

```bash
docker compose up -d --build
docker compose logs -f tracker
```

```bash
curl --fail http://127.0.0.1:7000/healthz
```

Ouvre `http://localhost:7000` sur l’hôte, ou l’URL HTTPS configurée dans ton reverse proxy. Entre la valeur de `GLOBAL_API_KEY` qui se trouve dans `.env`.

`compose.yaml` construit **le code de ce dossier** avec `build.context: .`, lui attribue le nom local `aiostreams-tracker-bridge:local` et utilise `pull_policy: build`. Il ne cherche pas une image préconstruite de cet addon sur un registre. Le port interne est toujours `7000` ; `HOST_PORT` règle uniquement sa publication sur l’hôte.

Par défaut, le port publié écoute sur `127.0.0.1`. Pour l’ouvrir sur le réseau local, renseigne `HOST_BIND=0.0.0.0` dans `.env`, puis recrée le service avec `docker compose up -d --build`.

## Variables d’environnement

| Variable | Rôle |
| --- | --- |
| `GLOBAL_API_KEY` | Clé d’administration partagée, au moins 32 caractères. Générée automatiquement. |
| `ENCRYPTION_KEY` | Clé de chiffrement, exactement 64 caractères hexadécimaux. Générée automatiquement. À conserver avec la sauvegarde de la base. |
| `PUBLIC_BASE_URL` | Origine publique, par exemple `https://tracker.example.com`. Aucun sous-chemin, paramètre ou fragment. |
| `SIMKL_CLIENT_ID` | Identifiant de ton application Simkl. Nécessaire pour les appels Simkl. |
| `SIMKL_CLIENT_SECRET` | Secret de l’application Simkl, utilisé pour OAuth. |
| `SIMKL_ACCESS_TOKEN` | Jeton personnel Simkl facultatif, disponible comme identifiant par défaut lors de la configuration d’un profil. |
| `PMDB_API_KEY` | Clé personnelle PublicMetaDB facultative, disponible comme identifiant par défaut d’un profil. |
| `SYNC_INTERVAL_SECONDS` | Rafraîchissement distant périodique, `300` par défaut, minimum `30`. |
| `MAX_PULL_BYTES` | Réponse pull maximale : `4900000` octets par défaut, sous la limite AIOStreams. |
| `MAX_RESUME_ITEMS` | Nombre de reprises récentes exposées : `5000` par défaut. |
| `MAX_WATCHED_MOVIES`, `MAX_WATCHED_EPISODES` | Plafonds d’historique : `50000` chacun. Augmente aussi les limites correspondantes côté AIOStreams. |
| `HOST`, `PORT`, `DATA_DIR` | Écoute et dossier SQLite en exécution native. Compose impose `0.0.0.0`, `7000`, `/app/data` dans le conteneur. |
| `HOST_BIND`, `HOST_PORT` | Publication Compose sur l’hôte : `127.0.0.1` et `7000` par défaut. |

Ne remplace pas `ENCRYPTION_KEY` en gardant la même base : les identifiants déjà stockés deviendraient illisibles.

### Simkl

Crée ton application dans l’espace développeur Simkl et configure exactement cette URL de retour, avec ton domaine :

```text
https://tracker.example.com/oauth/simkl/callback
```

Elle doit correspondre à `PUBLIC_BASE_URL` suivi de `/oauth/simkl/callback`. Renseigne `SIMKL_CLIENT_ID` et `SIMKL_CLIENT_SECRET`, puis utilise le bouton de connexion Simkl du profil. Un jeton d’accès déjà obtenu peut également être saisi directement.

Le client et le secret identifient l’application ; chaque connexion OAuth ou jeton de profil identifie son compte Simkl. Plusieurs profils peuvent donc utiliser des comptes distincts avec la même application.

### PublicMetaDB

« PMDB » désigne ici **PublicMetaDB**. Crée une clé personnelle dans **Settings → API**, puis colle-la dans le profil ou renseigne `PMDB_API_KEY` comme valeur par défaut. L’API documentée utilise un jeton `Bearer` ; elle ne demande pas de client OAuth ni de secret d’application.

## Configuration des profils

1. Connecte-toi à l’interface avec la clé globale.
2. Crée un profil, par exemple « Lucas » ou « Salon ».
3. Connecte les comptes fournisseurs de ce profil et active les destinations d’écriture voulues.
4. Choisis **Simkl ou PublicMetaDB comme source de lecture**, ou désactive la lecture si tu souhaites uniquement envoyer les événements.
5. Confirme le consentement demandé : il active les échanges en lecture et en écriture. Le décocher suspend la synchronisation en conservant tes choix.
6. Copie l’URL de manifeste fournie pour ce profil dans les addons personnalisés d’AIOStreams.

Pour changer le compte d’un fournisseur, déconnecte d’abord le compte existant. Cela supprime ses travaux en attente et ses reprises locales ; reconnecte ensuite le nouveau compte et réactive le routage souhaité. Cette séparation évite de rejouer la file d’un ancien compte sur un autre.

Les comptes et les choix d’un profil ne sont pas automatiquement ceux d’un autre. Les variables `SIMKL_ACCESS_TOKEN` et `PMDB_API_KEY` sont des valeurs facultatives de configuration, pas une obligation d’utiliser un même compte partout.

**La clé globale ouvre une administration partagée.** Toute personne qui la connaît peut administrer les profils. Les profils ne constituent pas une isolation entre utilisateurs non fiables. Les URL d’addon incluent un secret propre au profil et donnent accès à sa synchronisation : partage uniquement l’URL du profil concerné avec AIOStreams. Une rotation du secret du profil invalide son ancienne URL ; une rotation de `GLOBAL_API_KEY` invalide toutes les sessions d’administration et toutes les URL d’addon. Recopie les nouvelles URL après cette opération. Désactive ou masque les journaux d’URL de ton reverse proxy pour les chemins `/addon/`.

## Réglages nécessaires dans AIOStreams

Ces variables appartiennent au conteneur **AIOStreams**, pas à celui du bridge :

```dotenv
WATCH_STATE_REPORT_ENABLED=true
WATCH_STATE_PULL_ENABLED=true
```

Dans la configuration de l’addon, garde la ressource **Watch State** activée. Il n’est pas nécessaire que cet addon publie une ressource `meta`.

Pour un manifeste sur une adresse interne, par exemple le nom d’un service Docker, active également dans AIOStreams :

```dotenv
WATCH_STATE_ALLOW_PRIVATE_URLS=true
```

Ce réglage autorise AIOStreams à joindre des adresses internes ; utilise-le sur ton instance privée. Si tu souhaites que les configurations inactives continuent également à être lues en arrière-plan :

```dotenv
WATCH_STATE_PULL_ACTIVE_WITHIN_HOURS=0
```

La limite par défaut est de trois addons de suivi par configuration AIOStreams. Si tu en installes davantage, adapte `WATCH_STATE_MAX_SINKS` côté AIOStreams.

### Métadonnées et identifiants

AIOStreams demande les métadonnées aux autres addons installés pour afficher les lignes importées. Il faut donc un addon capable de résoudre les identifiants retournés : IMDb (`tt…`), TMDB (`tmdb:…`) et, pour les animes concernés, Kitsu/MAL/autres identifiants disponibles.

PublicMetaDB fournit nativement des identifiants TMDB. Une bibliothèque uniquement IMDb ne suffit pas systématiquement à afficher son historique si aucune correspondance exploitable n’est disponible. Un addon de métadonnées acceptant TMDB reste nécessaire pour ces entrées.

Les correspondances d’identifiants ne rendent pas les numérotations d’épisodes interchangeables. Le connecteur ne convertit pas arbitrairement un épisode absolu d’anime en « saison 1 » TV/TMDB. Une identité ou une numérotation ambiguë est signalée au lieu d’écrire un autre épisode.

## Dokploy et Dockhand

### Dokploy

Crée une application **Docker Compose** à partir de ce dossier et utilise `compose.yaml`. Renseigne les variables de `.env` dans la configuration de déploiement ; si Dokploy les injecte directement sans créer de fichier `.env`, retire le bloc `env_file` et configure les variables d’environnement du service dans ton Compose. La définition fournie suppose qu’un fichier `.env` est présent.

Configure le domaine HTTPS pour le service `tracker`, port interne **7000**, et garde `PUBLIC_BASE_URL` identique à ce domaine. Le service se construit depuis le Dockerfile local. Aucun registre privé ni publication d’image de l’addon ne sont requis.

Si ton installation Dokploy demande que le service rejoigne explicitement `dokploy-network`, ajoute ces blocs **au même fichier Compose** :

```yaml
services:
  tracker:
    networks:
      - default
      - dokploy-network

networks:
  dokploy-network:
    external: true
```

Il s’agit de blocs à intégrer à la définition existante, pas d’un remplacement complet du fichier. Le réseau externe doit déjà exister dans ton installation. Le reverse proxy utilise le port du conteneur ; tu peux retirer entièrement `ports` si tu ne souhaites pas de publication sur l’hôte. Aucun fichier de surcharge avec une fusion de ports implicite n’est nécessaire.

### Dockhand

Crée une stack Compose dont le répertoire de projet contient le Dockerfile, `src`, `public` et `.env`. Utilise `compose.yaml` et lance une construction locale. Un simple collage du YAML sans ses fichiers ne permet pas de construire l’image.

Pour un reverse proxy dans un autre conteneur, relie `tracker` au réseau partagé de ce proxy et utilise `tracker:7000` comme cible. `127.0.0.1` dans un conteneur proxy désigne ce proxy, pas le bridge.

## Contrat et comportement de synchronisation

Le manifeste annonce `watchState.version: 2`, les cinq événements et le support des lots. Les routes de ressource sont relatives à l’URL du manifeste privé, comme dans AIOStreams :

| Route | Usage |
| --- | --- |
| `GET /healthz` | Vérification locale de disponibilité du serveur. |
| `POST {addonBase}/watch_state/push/{type}/{id}.json` | Acceptation d’un événement ou d’un lot de marques. |
| `GET {addonBase}/watch_state/pull.json?since={version}` | Lecture des reprises et de l’historique. |
| `GET /oauth/simkl/callback` | Retour de l’autorisation OAuth Simkl. |

`addonBase` est l’URL de manifeste du profil privée de `/manifest.json`. AIOStreams ne fournit pas d’en-tête utilisateur supplémentaire : c’est l’URL de configuration qui autorise l’accès.

Une marque groupée contient la liste exacte des vidéos. Seules ces vidéos sont envoyées aux trackers ; une marque de saison n’est jamais remplacée par « toute la série ». PublicMetaDB exige une écriture par vidéo : le serveur les traite en arrière-plan en respectant son rythme d’appels.

La version décrit l’ensemble `watched`, pas les positions de reprise. Quand `since` correspond, `watched` est omis et `items` reste présent. Un historique absent et un historique vide sont deux états différents. Une erreur de lecture distante ne doit pas vider un historique déjà importé. Si un client ne possède pas encore la version en cache, une erreur distante produit un HTTP 503 : il ne reçoit jamais une nouvelle version sans son historique.

Les événements sont dédupliqués par profil et identifiant pendant 30 jours. Les checkpoints persistants évitent de recommencer les étapes distantes déjà confirmées après un redémarrage. Comme pour toute API sans clé d’idempotence de bout en bout, une coupure entre la validation distante et son enregistrement local laisse une petite fenêtre d’incertitude. PMDB utilise `dedupe=true` et SIMKL synchronise un état vu ; aucun compteur exact de relectures n’est promis.

### Différences entre les services

| Comportement | Simkl | PublicMetaDB |
| --- | --- | --- |
| Historique et marques vu/non vu | Oui | Oui |
| Reprises | Pourcentage natif | Position et durée en millisecondes |
| Lots de marques | Appels d’historique avec épisodes explicitement listés | Écritures individuelles en arrière-plan |
| Prochain épisode | Pointeur du fournisseur lorsqu’il est fourni | Aucun pointeur fiable documenté : liste vide |
| Total d’épisodes | Valeur du fournisseur lorsqu’elle est fournie | `0`, pour « inconnu » |

Simkl peut terminer automatiquement une lecture dès 80 % avec son opération `stop`. Le bridge respecte la décision `played` d’AIOStreams : un arrêt incomplet utilise une pause côté Simkl ; un arrêt terminé écrit l’historique.

PublicMetaDB ne conserve ses reprises que de **2 % inclus à 80 % exclus**. À partir de 80 %, son API efface la reprise, alors qu’AIOStreams utilise un seuil de lecture terminée à 90 %. Le bridge conserve les positions concernées dans son état local, sans les transformer en lectures terminées. Cet état local est visible via ce bridge, pas dans les autres applications qui interrogent directement PublicMetaDB. Une durée absente n’est jamais inventée.

PublicMetaDB est utilisé avec sa protection `dedupe=true` : le bridge synchronise l’état vu et ne promet pas un compteur exhaustif de tous les revisionnages. Les détails d’API et de pagination sont dans [docs/pmdb.md](docs/pmdb.md).

### Limites de la branche AIOStreams vérifiée

- Une reprise Simkl ne comportant qu’un pourcentage peut être ignorée par AIOStreams si sa base ne connaît encore aucune durée pour cette vidéo. Le code de la branche ne résout pas cette durée au moment de l’import. Le bridge ne fabrique pas de durée.
- `watched.nextUp` n’est pas exploité comme pointeur d’épisode par cette version d’AIOStreams : elle recalcule « À suivre » depuis les vidéos de ses addons de métadonnées. Les compteurs numériques ne sont pas directement importés non plus.
- Le TTL annoncé dans le manifeste n’impose pas le rythme de lecture : cette version utilise son réglage global `WATCH_STATE_PULL_TTL`, 300 secondes par défaut. La lecture périodique est de 1 800 secondes par défaut.
- Les demandes Jellyfin de reprise/épisode suivant déclenchent le rafraîchissement en arrière-plan. L’état actualisé apparaît au rafraîchissement suivant du client.
- Délai maximal d’une requête AIOStreams : **15 secondes en écriture, 20 secondes en lecture**. Le traitement asynchrone évite de faire attendre un lot PMDB dans la requête HTTP.
- Plafonds AIOStreams par défaut : **5 000 000 octets**, **5 000 reprises**, **50 000 films vus** et **50 000 épisodes vus**. Ces plafonds se règlent dans AIOStreams ; un historique ne doit pas être tronqué pour les contourner.
- Installer plusieurs profils qui lisent des comptes différents dans une même identité Jellyfin peut produire des états contradictoires. Utilise le profil correspondant à chaque configuration/persona et choisis une source de lecture faisant autorité.

## Exécution locale et vérification

```bash
node --version
node scripts/generate-env.mjs http://localhost:7000
node --env-file=.env src/server.ts
```

Pour redémarrer automatiquement après modification :

```bash
npm run dev
```

Vérifications sans installer de dépendances :

```bash
npm run check
npm test
```

`check` vérifie la syntaxe native Node des fichiers TypeScript et JavaScript. Il ne remplace pas un contrôle statique TypeScript. Les tests automatisés utilisent des réponses fournisseurs simulées et une base temporaire ; ils ne prouvent pas qu’une connexion OAuth, un compte réel ou un reverse proxy particulier fonctionne.

Cette livraison ne vaut pas validation d’un déploiement Docker ou d’échanges avec tes comptes : aucun identifiant réel n’a été fourni pour les tester. Après configuration, vérifie une lecture courte, une pause, un arrêt et une marque vu/non vu dans les diagnostics du profil et sur le tracker choisi.

Le bilan de cette livraison (54 tests réussis et limites de validation) est dans [docs/validation.md](docs/validation.md).

## Mise à jour et sauvegarde

Après remplacement du code :

```bash
docker compose up -d --build
```

Le volume `tracker-data` conserve la base lors d’une recréation normale. N’utilise pas `docker compose down -v` si tu souhaites conserver tes profils, tes identifiants et la file d’événements.

Pour une sauvegarde cohérente de SQLite, arrête brièvement le service :

```bash
docker compose stop tracker
docker compose run --rm --no-deps -T --entrypoint tar tracker \
  -czf - -C /app/data . > tracker-data-backup.tar.gz
docker compose start tracker
```

Conserve également `.env` dans un emplacement privé : la base seule ne suffit pas sans la même `ENCRYPTION_KEY`. Un montage de dossier hôte à la place du volume nommé doit être inscriptible par l’utilisateur `node` de l’image, UID/GID `1000:1000`.

## Sources du contrat

- [Documentation `watch_state` v2 au commit vérifié](https://github.com/Viren070/AIOStreams/blob/e3879da60f65c741ada8375559903aa58a51a707/packages/docs/content/docs/reference/watch-state-resource.mdx)
- [Import et délais de lecture AIOStreams](https://github.com/Viren070/AIOStreams/blob/e3879da60f65c741ada8375559903aa58a51a707/packages/core/src/watch-state/handoff/pull.ts)
- [Envoi et reprises sur erreur AIOStreams](https://github.com/Viren070/AIOStreams/blob/e3879da60f65c741ada8375559903aa58a51a707/packages/core/src/watch-state/handoff/deliver.ts)
- [Résolution des addons de suivi](https://github.com/Viren070/AIOStreams/blob/e3879da60f65c741ada8375559903aa58a51a707/packages/core/src/watch-state/handoff/resolve.ts)
- [Réglages AIOStreams et valeurs par défaut](https://github.com/Viren070/AIOStreams/blob/e3879da60f65c741ada8375559903aa58a51a707/packages/core/src/config/schema/watch-state.ts)
- [Affichage des épisodes et calcul de « À suivre »](https://github.com/Viren070/AIOStreams/blob/e3879da60f65c741ada8375559903aa58a51a707/packages/server/src/routes/jellyfin/items.ts)
- [Documentation officielle PublicMetaDB](https://publicmetadb.com/api-docs)
- [Documentation officielle Simkl](https://api.simkl.org/)
