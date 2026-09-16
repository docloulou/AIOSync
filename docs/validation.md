# Vérifications de la livraison

Vérification effectuée le 16 septembre 2026, avec Node.js 24.19.0.

## Résultats

- **54 tests automatisés réussis**, aucune erreur ni test ignoré.
- 3 tests du transport HTTP : limitation/sérialisation, Retry-After, protection des credentials.
- 12 tests PublicMetaDB : pagination, dates, scopes exacts, reprises, erreurs et identifiants.
- 14 tests SIMKL : événements, lots, activités/deltas, suppressions, anime et réponses incorrectes.
- 16 tests du service : persistance, checkpoints, versions, alias, consentement, reconnexion, lots et retries.
- 9 tests HTTP de bout en bout contre le serveur local avec fournisseurs simulés : administration, cookies, OAuth state, multi-profils, manifestes, push/pull et révocation.
- Vérification de syntaxe native Node : **18 fichiers** TypeScript/JavaScript de code et tests.
- Démarrage du point d’entrée réel dans un processus Node distinct : `/healthz`, HTML, JavaScript, CSS, manifeste public et refus d’une requête administrative non authentifiée vérifiés. Arrêt SIGTERM effectué.
- Générateur `.env` : clés aléatoires, permissions 0600 et refus d’écrasement vérifiés dans un dossier temporaire.
- Structure Compose et paramètres de construction locale vérifiés.

Un test ouvre une vraie base SQLite sur disque, la ferme puis la rouvre : les credentials chiffrés, tâches et checkpoints validés persistent sans répéter une écriture déjà confirmée.

## Ce qui reste à vérifier dans l’installation cible

- Construction et démarrage Docker : moteur Docker indisponible dans l’environnement de préparation.
- Connexion OAuth réelle et appels aux comptes SIMKL/PMDB : aucun identifiant utilisateur fourni. Les API des tests sont simulées à partir des contrats documentés.
- Parcours visuel dans un navigateur : navigateur et CLI agent-browser indisponibles. Les routes et assets sont vérifiés par HTTP.
- Échanges avec une instance AIOStreams et un client Jellyfin réels : code source examiné au commit `e3879da60f65c741ada8375559903aa58a51a707`, aucun client réel connecté.
- Contrôle statique TypeScript : `npm run check` vérifie la syntaxe exécutée par Node, pas les types.

Le serveur n’a pas été publié sur Internet et aucun compte distant n’a été modifié pendant ces tests.

## Rejouer les vérifications

```bash
npm run check
npm test
```

Aucune installation de dépendances n’est nécessaire avec Node.js 24. Les limitations fonctionnelles connues sont documentées dans le README et les fiches des deux connecteurs.
