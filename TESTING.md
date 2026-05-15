# Tester le plugin en local avec Homebridge

## 1. Mettre en place l'environnement de développement

### Prérequis système

- [Node.js](https://nodejs.org) ≥ 18 (`node --version`)
- npm ≥ 9 (inclus avec Node.js)
- Git

### Cloner le dépôt et installer les dépendances

```bash
git clone https://github.com/bvial/homebridge-myhome.git
cd homebridge-myhome
npm install
```

### Compiler et lancer les tests

```bash
npm run build   # compile TypeScript → dist/
npm test        # compile + suite de tests automatisés
```

Les tests ne nécessitent pas de passerelle réelle — tout est simulé.

### Structure du projet

```
lib/            Sources TypeScript du plugin
test/           Tests automatisés (node:test)
dist/           Fichiers compilés (généré par npm run build, ignoré par git)
scan.ts         Outil de découverte des appareils (compile → dist/scan.js)
test.ts         Test d'intégration manuel contre une vraie passerelle (hors build)
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
