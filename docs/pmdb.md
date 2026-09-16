# PublicMetaDB

Vérifié le 16 septembre 2026 dans la [documentation officielle](https://publicmetadb.com/api-docs). Cette page est une application JavaScript ; les définitions consultées étaient publiées dans son [bundle officiel](https://publicmetadb.com/assets/index-ClcxtUSz.js).

La connexion utilise une clé personnelle `pm-…`, créée dans **Settings → API**, passée comme `Authorization: Bearer …`. PublicMetaDB ne demande pas de client OAuth ni de secret d'application pour cette API.

## Contrat implémenté

- Historique complet via `GET /api/external/watched?page=N&perPage=500`.
- Reprises complètes via `GET /api/external/resume?page=N&perPage=500`.
- Marquer vu via `POST /api/external/watched?dedupe=true` avec `watched_at` dérivé de la date de l'événement.
- Marquer non vu via `DELETE /api/external/watched` filtré sur la vidéo exacte. Toutes ses lectures sont supprimées, les autres épisodes sont préservés.
- Enregistrer une reprise via `POST /api/external/resume`, en millisecondes réelles.
- Effacer les reprises via `DELETE /api/external/resume/:id` lors d'un démarrage, d'une lecture terminée ou d'une marque non vue.
- Résolution d'un IMDb via `GET /api/external/mappings/lookup`, filtrée sur `movie` ou `tv`. Les résultats absents ou ambigus sont signalés, jamais devinés.

Le serveur répartit les marques de saisons/séries en vidéos individuelles. Les appels sont espacés d'au moins 50 ms avec un budget partagé entre tous les profils PMDB : la limite publiée est de 300 requêtes par 10 secondes **par IP**. Le transport traite aussi les réponses 429. Les sous-opérations sont enregistrées dans le journal persistant de la tâche.

Une page manquante, malformée, tronquée ou un total changeant pendant la pagination provoque une erreur. Le connecteur ne retourne jamais un historique partiel comme ensemble complet.

## Limites du service

PublicMetaDB ignore une reprise sous 2 %. À partir de 80 %, il supprime la reprise et retourne `action: completed` ; cela ne prouve pas que l'utilisateur a terminé, puisque le seuil AIOStreams est de 90 %. Le connecteur garde ces positions dans la projection locale gérée par le serveur, sans les convertir en lecture terminée et sans inventer de durée. Une durée absente est également conservée localement. Les anciennes reprises PMDB de la même vidéo sont effacées pour éviter d'en servir une périmée. Les autres applications connectées directement à PMDB ne verront pas cette projection locale.

Les dates des reprises PMDB (`created`, `updated`) sont gérées par le service et ne peuvent pas être antidatées. L'historique permet en revanche une date explicite ou inconnue.

Le mode `dedupe=true` protège l'état vu contre les doublons, y compris après un arrêt entre écriture distante et validation locale. Il conserve le comportement historique de PMDB et ne garantit pas l'ajout d'une nouvelle lecture à chaque revisionnage : ce connecteur synchronise l'état vu, pas un compteur exhaustif de revisionnages.

La numérotation absolue (`season: null`) et les métadonnées de séries en espace Kitsu/MAL/AniList/AniDB ne sont pas converties arbitrairement en saisons TMDB. Une erreur explicite conserve la tâche en diagnostic.

La sortie native utilise `tmdb:<id>` et `tmdb:<id>:<saison>:<épisode>`. Le serveur peut enrichir ces identités avec les correspondances connues. Les compteurs comptent les épisodes uniques et annoncent `total: 0` (total inconnu). PMDB ne fournit pas de pointeur fiable « prochain épisode » : `nextUp` est vide, sans inventer un épisode suivant.

Les tests utilisent des réponses simulées conformes à la documentation. Aucune clé personnelle n'a été fournie pour valider un compte réel.
