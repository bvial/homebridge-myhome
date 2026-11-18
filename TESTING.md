# Tester le plugin en local avec Homebridge

## 1. Mettre en place l'environnement de développement

### Prérequis système

- [Node.js](https://nodejs.org) 22 (≥ 22.13.0), 24 ou 26 (`node --version`)
- npm ≥ 9 (inclus avec Node.js)
- Git

### Cloner le dépôt et installer les dépendances

```bash
git clone https://github.com/bvial/homebridge-myhome.git
cd homebridge-myhome
npm install
```

`npm install` installe TypeScript localement dans `node_modules/.bin/tsc` — pas besoin de l'installer globalement. Les scripts `npm run build` et `npm test` utilisent automatiquement cette version locale.

Si tu veux aussi utiliser `tsc` directement dans ton terminal :

```bash
npm install -g typescript
tsc --version
```

### Compiler et lancer les tests

```bash
npm run build   # compile TypeScript → dist/
npm run lint    # vérifie les sources et les tests
npm test        # compile + suite de tests automatisés
```

Les tests ne nécessitent pas de passerelle réelle : le transport OWN est simulé.
Les tests d'intégration HAP et Matter utilisent les véritables bibliothèques
Homebridge pour vérifier les services, commandes et types d'appareils. Les
endpoints Matter utilisent un stockage en mémoire, sans publication d'un pont.

La revue du 18 novembre 2026 a validé **1 421 tests** sous Homebridge **2.5.0**,
puis les mêmes tests compilés sous **2.4.0**, avec Node 22.23.4. La CI couvre
Node 22/24/26 × Homebridge 2.4.0/2.5.0. Voir le
[rapport de revue](docs/PROTOCOL_REVIEW.md) pour les sources et la portée vérifiée.

### Tests du protocole et de la restauration

- `OpenWebNetSpec.test.ts` : niveaux WHAT/DIM, adresses, scénarios, polarité des
  contacts/IR, énergie, chauffage et réponses nécessaires à la découverte.
- `OwnAuth.test.ts` : vecteurs SHA-1/SHA-256 recoupés avec `hashlib`, preuve
  serveur, refus d'authentification et fermeture pendant l'établissement de session.
- `OwnMatterReal.test.ts` : conservation des endpoints composés sous Homebridge
  2.5, compatibilité de restauration 2.4 et commandes des variateurs après redémarrage.

Pour reproduire le contrôle d'une version de Homebridge dans une copie de travail :

```bash
npm ci
npm install --no-save --package-lock=false --ignore-scripts homebridge@2.4.0
npm test
```

`npm ci` rétablit ensuite les dépendances du verrouillage de développement.

### Tests des volets

- `BlindPositionEstimator.test.ts` : temps écoulé, callbacks retardés, fractions,
  durées montée/descente et traversée de la zone des lames.
- `OwnBlindController.test.ts` : inversions rapides, dernière consigne prioritaire,
  STOP mural pendant une requête, calibration refusée/interrompue ou finie en butée,
  DIM 10 (position mesurée/inconnue, refus), reconnexion et cache.
- `OwnNet.test.ts` : réserve et priorité STOP, annulation avant écriture et expiration
  des commandes obsolètes, tout en conservant l'ordre par appareil.
- `OwnBlindHap.test.ts` et `OwnMatterReal.test.ts` : erreurs, position inconnue,
  contrôle de calibration et synchronisation des protocoles avec les véritables services.

L'horloge de l'estimateur est injectable. Les tests avancent le temps réel simulé,
plutôt que d'appeler une fonction « +1 % » pour chaque tick. Les anciennes assertions
sur les indicateurs internes ont été remplacées par ces scénarios observables.

`OwnThermostatHap.test.ts` vérifie également la priorité des changements effectués
sur la centrale face aux ACK retardés, aux écritures en file et aux connexions
incomplètes. Les tests de variation Matter couvrent l'annulation d'un tick déjà
en file ou en cours de connexion après OFF, STOP ou destruction du pont. Une
commande déjà écrite reste suivie jusqu'à son résultat réel.

Sur l'installation, mesurer séparément les courses de montée et descente. Vérifier
une cible intermédiaire, un STOP mural pendant le mouvement, puis une inversion
rapide. Le journal debug indique les délais de file et d'ACK. Avec une position
inconnue, tester une course complète ou le contrôle Calibration avant une cible partielle.

### Validation Matter sur une installation réelle

1. Utiliser Homebridge 2.4 ou ultérieur (2.x), activer Matter sur le pont et mettre
   `expose: "both"` dans la plateforme MyHome.
2. Associer le pont avec le code Matter fourni par Homebridge. Vérifier la
   connectivité IPv6 et la découverte locale entre le pont et le contrôleur.
3. Tester marche/arrêt, variation, commandes murales et synchronisation des deux
   protocoles. Pour les volets : STOP, inversion et cible intermédiaire.
4. Vérifier les températures et la commande séparée du programme automatique.
   Une modification de consigne en mode programme doit être refusée.
5. Tester capteurs, puissance instantanée, scénarios, relais de porte et sonnerie
   selon les appareils disponibles et les fonctions de l'application Matter.
6. Redémarrer Homebridge, puis simuler une indisponibilité de la passerelle :
   les accessoires doivent conserver leurs identifiants et récupérer leur état.
7. Vérifier les modes `homekit`, `matter` et `both`. Un changement de protocole
   peut supprimer des accessoires associés aux automatisations de l'application.

### Structure du projet

```
lib/            Sources TypeScript du plugin
test/           Tests automatisés (node:test)
dist/           Fichiers compilés (généré par npm run build, ignoré par git)
scan.ts         Outil de découverte des appareils (compile → dist/scan.js)
test.js         Test d'intégration manuel contre une vraie passerelle (nécessite npm run build)
config.schema.json  Schéma de configuration pour l'UI Homebridge
```

### Éditeur recommandé

VS Code avec l'extension **ESLint**. Le projet est configuré avec TypeScript strict —
les erreurs de type apparaissent en temps réel dans l'éditeur.

---

## 2. Prérequis Homebridge

Homebridge doit être installé sur ta machine (pas seulement sur le serveur de prod) :

```bash
npm install -g homebridge homebridge-config-ui-x
```

---

## 3. Méthode 1 — `npm link` (recommandée pour le développement)

Crée un lien symbolique entre le dossier du plugin et les modules globaux npm,
sans avoir à publier ni copier de fichiers à chaque modification.

```bash
# 1. Dans le dossier du plugin : compiler et enregistrer le lien global
cd /chemin/vers/homebridge-myhome
npm run build
npm link

# 2. Dans le dossier de stockage Homebridge (en général ~/.homebridge) :
#    activer le lien vers le plugin
cd ~/.homebridge
npm link homebridge-myhome-unik

# 3. Lancer Homebridge en mode debug
homebridge -D -U ~/.homebridge
```

Après chaque modification du code, recompiler suffit :

```bash
npm run build
# Homebridge détecte le rechargement au prochain redémarrage
```

Pour recompiler automatiquement à chaque sauvegarde :

```bash
npx tsc --watch
```

---

## 4. Méthode 2 — Installation directe depuis le dossier local

Plus simple, mais il faut relancer à chaque modification importante.

```bash
npm run build

# Installer le plugin directement depuis le dossier local
npm install -g /chemin/vers/homebridge-myhome

# Lancer Homebridge
homebridge -D -U ~/.homebridge
```

---

## 5. Configuration minimale de test

Éditer `~/.homebridge/config.json` et ajouter la section `platforms` :

```json
{
  "bridge": {
    "name": "Homebridge Test",
    "username": "CC:22:3D:E3:CE:30",
    "port": 51826,
    "pin": "031-45-154"
  },
  "platforms": [
    {
      "platform": "MyHome",
      "name": "MyHome",
      "host": "192.168.1.35",
      "port": 20000,
      "password": "12345",
      "lights": [
        { "id": 11, "name": "Salon" }
      ]
    }
  ]
}
```

---

## 6. Lecture des logs

Le mode `-D` (debug) affiche tous les logs du plugin, y compris les paquets OWN
reçus et envoyés.

```bash
# Lancer et afficher les logs en continu
homebridge -D -U ~/.homebridge 2>&1 | tee homebridge.log

# Filtrer uniquement les logs du plugin
homebridge -D -U ~/.homebridge 2>&1 | grep -i myhome
```

---

## 7. Vérifier que le plugin est bien chargé

Au démarrage, Homebridge doit afficher une ligne comme :

```
[MyHome] LegrandMyHome for MyHome Gateway at 192.168.1.35:20000
[MyHome] Discovering OpenWebNet devices from config
[MyHome] maxConcurrent auto-set to 2 (gateway: F454 v1.2)
```

Si le plugin n'apparaît pas, vérifier :

```bash
# Lister les plugins installés globalement
npm list -g --depth=0 | grep homebridge
```

---

## 8. Désactiver le lien après les tests

```bash
cd ~/.homebridge
npm unlink homebridge-myhome-unik

cd /chemin/vers/homebridge-myhome
npm unlink
```
