# Connecteur SIMKL

Implémentation vérifiée contre la documentation officielle disponible le 16 septembre 2026. Les tests automatiques utilisent des réponses simulées : une connexion et une lecture/écriture réelles nécessitent votre application SIMKL et votre consentement.

## Authentification

L’opérateur fournit `SIMKL_CLIENT_ID` et `SIMKL_CLIENT_SECRET`. Chaque configuration conserve son propre jeton utilisateur. Le connecteur valide ce jeton avec `POST /users/settings`.

OAuth : autorisation sur `https://simkl.com/oauth/authorize`, échange du code sur `https://api.simkl.com/oauth/token`. Le `redirect_uri` doit correspondre exactement à celui enregistré. SIMKL annonce des jetons valides environ cinq ans et ne fournit pas de refresh token : une révocation impose une nouvelle connexion. Les requêtes du connecteur incluent `client_id`, `app-name`, `app-version`, `User-Agent` et `Authorization: Bearer ...`.

Sources : [authentification](https://api.simkl.org/authentication), [OAuth](https://api.simkl.org/api-reference/oauth), [paramètres et en-têtes](https://api.simkl.org/conventions/headers).

## Écritures

| Événement AIOStreams | Opération SIMKL |
| --- | --- |
| `start` avec progression connue | `POST /scrobble/start` |
| `pause` avec progression connue | `POST /scrobble/pause` |
| `stop`, non terminé | `POST /scrobble/pause`, à la progression réelle |
| `stop` avec `played:true`, ou `played` | `POST /sync/history`, avec `watched_at` issu de l’événement |
| `unplayed` | `POST /sync/history/remove` et suppression des reprises correspondantes |

Le choix de `pause` pour un arrêt incomplet est intentionnel : `/scrobble/stop` SIMKL marque terminé dès 80 %, alors que le contrat AIOStreams transmet son résultat à 90 %. Un arrêt à 85 % avec `played:false` doit donc conserver 85 % sans ajouter de visionnage.

En l’absence de durée ou de position, le connecteur renvoie un avertissement et ne remplace pas la progression distante par zéro. Un `played:true` explicite reste exploitable sans durée.

Sources : [cycle de lecture SIMKL](https://api.simkl.org/guides/scrobble), [contrat AIOStreams](https://github.com/Viren070/AIOStreams/blob/feat/jellyfin/packages/docs/content/docs/reference/watch-state-resource.mdx).

Les marques groupées envoient exclusivement les épisodes de `videos`, répartis par saison, y compris la saison 0. Elles n’envoient jamais une série sans liste d’épisodes. Les étapes d’historique, lecture des reprises et chaque suppression sont enregistrées par le mécanisme de checkpoints du serveur pour éviter de répéter les étapes déjà réussies.

Le connecteur contrôle `not_found` même si SIMKL répond HTTP 201. Une marque individuelle non résolue produit une erreur 422 visible. Pour une marque groupée partiellement réussie, le job conserve un avertissement indiquant les identifiants et épisodes non résolus, sans répéter les écritures réussies. La suppression d’un film par `/sync/history/remove` retire aussi son entrée de liste SIMKL : c’est le comportement de l’API. Pour une série, seuls les épisodes explicitement listés sont retirés. Les anime sont toujours envoyés sous `shows[]` pour la suppression, car la documentation narrative de cette route précise que `anime[]` est ignoré malgré son apparition dans le schéma généré.

Sources : [ajout d’historique](https://api.simkl.org/api-reference/simkl/add-to-history), [suppression d’historique](https://api.simkl.org/api-reference/simkl/remove-from-history), [suppression de reprise](https://api.simkl.org/api-reference/simkl/delete-playback).

## Lectures

La première lecture vérifie `/sync/activities`, puis récupère successivement les séries, films et anime. Les paramètres `extended=full_anime_seasons`, `episode_watched_at=yes` et `include_all_episodes=yes` incluent les épisodes des titres terminés. `next_watch_info=yes` fournit le prochain épisode quand SIMKL le connaît.

Les lectures suivantes vérifient les activités : un changement déclenche un delta avec `date_from`. Le connecteur remplace chaque titre modifié dans son cache. Lorsque `removed_from_list` change, une lecture des identifiants seuls permet de supprimer les titres disparus. Chaque résultat exposé à AIOStreams est néanmoins l’ensemble complet, jamais un delta. Le cache de lecture vit en mémoire : après un redémarrage, une nouvelle lecture initiale est nécessaire.

Le cache n’est validé qu’après réussite de toutes les lectures et conversions. Une erreur n’est jamais convertie en bibliothèque vide. Les réponses HTTP 200 contenant `error` ou une enveloppe inattendue sont également rejetées. SIMKL documente explicitement `{}` comme réponse légitime pour une bibliothèque vide, et omet les catégories vides : cette forme reste donc acceptée, y compris lors d’une suppression complète. Les reprises sont relues à chaque pull via `/sync/playback`.

Sources : [synchronisation](https://api.simkl.org/guides/sync), [lecture de bibliothèque](https://api.simkl.org/api-reference/simkl/get-all-items).

## Identifiants et anime

Les espaces acceptés sont IMDb, TMDB, TVDB, SIMKL, Kitsu, MAL, AniList et AniDB. Les ID de `ids` sont des identifiants de titre, jamais d’épisode. Un `videoId` Kitsu est traité dans sa numérotation native même lorsque son `metaId` est IMDb.

Chaque reprise ou pointeur Next Up produit une seule entrée. Parmi les identifiants dont la numérotation est exploitable, la préférence est IMDb, TMDB, TVDB, Kitsu, MAL, AniList, AniDB, puis SIMKL. Un anime sans correspondance TV conserve donc un identifiant natif, avec priorité à Kitsu. Les listes d’épisodes et films déjà vus conservent leurs alias pour faciliter leur reconnaissance.

Les écritures TV activent `use_tvdb_anime_seasons:true`. Les écritures anime natives n’envoient pas d’identifiant de franchise TV avec des coordonnées absolues. À la lecture, les alias TV d’un anime utilisent uniquement la correspondance `episode.tvdb`. Sans correspondance, les identifiants anime natifs sont conservés avec `season:null`. Un spécial SIMKL reste en saison 0.

Le connecteur ne suppose pas que les découpages TMDB et TVDB sont toujours identiques : la documentation SIMKL reconnaît leurs divergences. Une métadonnée source qui expose des saisons TMDB incompatibles doit être corrigée ou utiliser des ID/coordonnées natives cohérents. Aucune reconstruction implicite n’est faite.

Source : [prise en charge des anime](https://api.simkl.org/guides/anime).

## Limites explicites

- `counts` reprend les compteurs du fournisseur. Un total absent vaut 0. Les compteurs d’un cour anime ne sont pas attribués à un ID IMDb/TMDB/TVDB partagé par toute la franchise ; ils restent associés aux ID anime natifs.
- `nextUp` utilise seulement le pointeur du fournisseur, jamais « épisode précédent + 1 ».
- SIMKL fournit un pourcentage de reprise. Quand sa réponse ou son catalogue fournit aussi `runtime`, le connecteur expose cette durée en millisecondes et calcule la position correspondante. Pour les séries, cette durée est la durée nominale du fournisseur, pas nécessairement celle du fichier vidéo. Sans durée fournisseur, seul le pourcentage est renvoyé.
- Les dates d’épisodes marqués terminés en une seule fois peuvent être synthétisées par SIMKL ; `include_all_episodes=yes` privilégie la couverture de l’historique.
- Les rewatchs Pro/VIP ne sont pas créés artificiellement lors des retransmissions. Le contrat d’état de visionnage n’est pas un journal de sessions de rewatch.
- SIMKL limite `/sync/playback` à 10 000 résultats. Atteindre cette limite produit une erreur explicite au lieu d’exposer un résultat potentiellement tronqué.
- Les reprises expirent selon l’offre SIMKL : gratuite 7 jours, Pro 30 jours, VIP 90 jours.

Sources : [reprises](https://api.simkl.org/api-reference/simkl/get-playback-sessions), [pagination](https://api.simkl.org/conventions/pagination), [rewatchs](https://api.simkl.org/guides/rewatches).

Les appels de production du connecteur sont espacés de 1,1 seconde par jeton afin de respecter notamment la limite d’une écriture par seconde. Il n’effectue aucun polling autonome : une lecture est déclenchée par les demandes du consommateur, avec contrôle des activités. Les appels HTTP simulés dans les tests sont exemptés de cet espacement.

Source : [limites de requêtes](https://api.simkl.org/resources/rate-limits).
