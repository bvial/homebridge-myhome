# Revue OpenWebNet et Homebridge

Revue du 18 novembre 2026, pour la version **0.5.0**.

## Références officielles

Les documents OpenWebNet proviennent du [portail développeur Legrand](https://developer.legrand.com/local-interoperability/).
Les versions indiquées sont celles des documents, indépendamment de leur date de mise en ligne.

| Document | Version | Partie utilisée dans la revue |
|---|---|---|
| [Introduction OpenWebNet](https://developer.legrand.com/uploads/2019/12/OWN_Intro_ENG.pdf) | 2.0.0 | Structure des trames, sessions et acquittements |
| [WHO 0 — scénarios](https://developer.legrand.com/uploads/2019/12/WHO_0.pdf) | 2.0.0 | Numéros de scénario et adresses de module |
| [WHO 1 — éclairage](https://static.developer.legrand.com/files/2024/05/WHO_1.pdf) | 1.2 | WHAT absolus, commandes temporisées, retour DIM 1 |
| [WHO 2 — automatismes](https://developer.legrand.com/uploads/2019/12/WHO_2.pdf) | 1.0 | UP/DOWN/STOP, fin de course, état détaillé DIM 10 |
| [WHO 4 — température](https://developer.legrand.com/uploads/2019/12/WHO_4.pdf) | 2.0.0 | Adresses, modes, programmes, températures et vannes/fan-coils |
| [WHO 7 — portier vidéo](https://developer.legrand.com/uploads/2019/12/WHO_7.pdf) | 1.0.1 | Structure des trames vidéo ; voir la limite ci-dessous pour les relais |
| [WHO 13 — passerelle](https://developer.legrand.com/uploads/2019/12/WHO_13.pdf) | Document du portail | Requêtes d'identification de passerelle |
| [WHO 18 — énergie](https://developer.legrand.com/uploads/2019/12/WHO_18.pdf) | 1.0.0 | Adresses `5N` / `7N#0` et puissance active DIM 113 |
| [WHO 25 — contacts et IR](https://developer.legrand.com/uploads/2019/12/WHO_25.pdf) | 1.0.0 | Adresses `3N`, états 31/32, événements et réponses |
| [Authentification HMAC](https://developer.legrand.com/uploads/2019/12/Hmac.pdf) | 1.1 | Négociation SHA-1/SHA-256, encodage et preuves mutuelles |

La [dernière version stable de Homebridge vérifiée est 2.5.0](https://github.com/homebridge/homebridge/releases/tag/v2.5.0),
publiée le 1er novembre 2026. Elle utilise `@homebridge/hap-nodejs` 2.3.0 et
`@matter/main` 0.18.0. Les déclarations d'API et le code de restauration Matter
de cette version ont également été examinés. La version minimale du plugin reste
Homebridge 2.4.0 ; les dépendances de développement ciblent `^2.5.0`.

## Corrections et comportement vérifié

### Éclairage et décodage

- WHAT 2 à 10 signifie **20 à 100 %**, par pas de 10 %. Ainsi, `*1*7*11##`
  représente 70 %. Les commandes non nulles inférieures à 20 % utilisent le niveau 2.
- DIM 1 transporte un niveau 100 à 200 et une vitesse :
  `*#1*11*1*163*0##` représente 63 %. Les commandes relatives ou temporisées
  ne sont plus interprétées comme des pourcentages absolus.
- WHERE est extrait selon la position du champ dans la trame. Les adresses avec
  `#` et les paramètres suivant WHERE ne faussent plus le routage.
- Les retours du bus priment sur les valeurs de repli appliquées à réception d'un ACK.

### Volets

- Contrôleur commun HomeKit/Matter, horloge monotone, durées distinctes de montée
  et descente, remplacement des commandes obsolètes et priorité des STOP.
- Un STOP naturel après une course complète peut terminer la calibration avant
  la marge d'une seconde. Un STOP anticipé laisse la référence temporelle inconnue.
- DIM 10 corrige l'estimation avec la position mesurée. La valeur 255 reste
  inconnue ; les états de refus/désactivation de l'actionneur sont pris en compte.
- Un état détaillé de mouvement ne devient pas artificiellement une commande
  murale annulant un STOP en cours. Un retour de cible reçu avant l'ACK ne valide
  pas prématurément la commande.
- Le cache conserve position, confiance, date et mouvement interrompu. Les
  positions inconnues sont signalées dans HAP et Matter.

### Température, scénarios, contacts et énergie

- WHO 4 utilise OFF générique 303 et AUTO 311 pour les zones `#N`, avec une
  adresse de commande configurable. Les programmes de refroidissement et les
  vitesses de fan-coil sont décodés ; le choix chauffage/refroidissement ne suffit
  plus à déclarer une vanne active.
- WHO 0 adresse explicitement un module : `*0*3*23##` active le scénario 3
  du module 23. Une activation sans module est refusée avant tout envoi.
- WHO 25 distingue contact fermé/ouvert et détection IR. Les variantes de
  réponse `#0` et d'événement `#1` sont prises en charge.
- WHO 18 accepte les adresses d'actionneur comme `71#0`. Zéro watt reste zéro
  dans l'état métier et Matter ; seul l'ancien affichage HAP en lux applique
  le minimum imposé par cette caractéristique.

### Transport et découverte

- SHA-1/SHA-256 sont négociés avec la passerelle et sa preuve est vérifiée avant
  l'ouverture de la session. Le format Legrand emploie un digest de chaînes
  hexadécimales ASCII avec `736F70653E` et `636F70653E`, pas `crypto.createHmac`.
- Les vecteurs cryptographiques sont recoupés avec Python `hashlib`. Les tests
  couvrent aussi preuve invalide, fermeture pendant le handshake, arrêt de la
  file et du monitoring après un échec d'authentification.
- La découverte exige une réponse correspondant au WHO et au WHERE interrogés.
  Un ACK seul confirme l'acceptation de la requête, pas l'existence d'un appareil.
- Le scan utilise `5N` pour les compteurs, `3N` pour les contacts et les zones
  de température jusqu'à 99, dans la plage demandée.
- Les collections/entrées de configuration malformées sont isolées ;
  `--max-addr` exige un entier décimal compris entre 1 et 999.

### Intégration Homebridge et Matter

- Les écritures, erreurs et retours matériels sont vérifiés avec les véritables
  bibliothèques HAP et des endpoints Matter utilisant un stockage en mémoire.
- Sous Homebridge 2.5, les thermostats et capteurs de présence aux descripteurs
  inchangés sont restaurés sur place, avec leurs fonctionnalités, commandes et
  identités. Sous 2.4, leur reconstruction reste nécessaire.
- Les variateurs conservent la reconstruction nécessaire pour rattacher leur
  classe LevelControl personnalisée au contrôleur courant. Les tests exécutent
  leurs huit commandes après restauration et vérifient les numéros d'endpoints.
- Le contexte métier et le dernier mode manuel du thermostat survivent aux
  reconstructions et à une tentative d'enregistrement échouée.

## Configuration à adapter

1. **Scénarios existants : ajouter `where`.** Par exemple :
   `{ "id": 101, "scenario": 3, "where": "23" }`.
   `scenario` est compris entre 1 et 20 et vaut `id` lorsqu'il est omis.
2. **Contacts standards : choisir le protocole.**
   `{ "id": 1, "protocol": "dry-contact" }` utilise WHO 25, adresse `31`.
   Pour un détecteur IR, sélectionner `protocol: "ir"` et le `sensorType` voulu.
   Le défaut `auxiliary` conserve le comportement historique WHO 9.
3. **Adresses particulières : utiliser `where`.** Par exemple `#1` pour une zone
   de centrale 99 zones, `71#0` pour un actionneur d'énergie et `68#4#01` pour
   un volet sur bus local. L'adresse par défaut des thermostats reste `#0#<zone>`.
4. **Variation : tenir compte des pas réels.** Les mêmes trames absolues
   produisent désormais les pourcentages documentés ; un niveau OWN 7 affiche 70 %.

Les champs et exemples complets figurent dans le [README](../README.md).

## Résultats des passes finales

| Contrôle | Résultat |
|---|---|
| Homebridge 2.5.0, Node 22.23.4 | Compilation et **1 421 tests réussis**, aucun échec ni test ignoré |
| Homebridge 2.4.0, Node 22.23.4 | **1 421 tests JavaScript compilés réussis** dans une installation isolée |
| ESLint | Réussi |
| `git diff --check` | Réussi |
| `npm audit --include=dev` | 0 vulnérabilité signalée au moment du contrôle |
| `npm pack --dry-run` | Réussi |

La CI est configurée pour Node 22/24/26 × Homebridge 2.4.0/2.5.0.
Les validations locales ci-dessus ont été exécutées sous Node 22 ; elles ne
constituent pas un résultat d'exécution de toute cette matrice CI.
Les commandes reproductibles et essais sur installation sont décrits dans
[TESTING.md](../TESTING.md).

## Portée et limites

Les passes successives ont corrigé les défauts reproduits dans les fonctions
prises en charge. Cette revue n'est pas une certification de tout OpenWebNet.
Aucun essai sur passerelle physique n'a été effectué pendant cette revue.

- Les actionneurs sans retour de position conservent une estimation temporelle,
  dépendante des durées configurées. DIM 10 est exploité lorsqu'il est reçu ; les
  écritures natives GoToLevel et l'inclinaison indépendante ne sont pas exposées.
- Une passerelle qui n'émet aucune réponse d'état ne permet pas la découverte
  fiable de l'appareil concerné ; sa configuration manuelle reste nécessaire.
- La documentation WHO 7 consultée porte principalement sur la vidéo. Elle ne
  permet pas de déclarer entièrement validées les commandes historiques de
  relais de porte et tous les événements d'interphone selon les matériels.
- Les adaptateurs WHO 9 historiques restent disponibles ; les contacts secs
  standards ont été vérifiés contre WHO 25.
- L'authentification HMAC authentifie la session, mais ne chiffre pas les trames
  OpenWebNet, conformément au document Legrand.
