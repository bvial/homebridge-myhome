# Publication de homebridge-myhome-unik

## Checklist avant chaque publication

- [ ] Version mise à jour dans `package.json`
- [ ] `npm test` passe sans erreur
- [ ] `npm pack --dry-run` affiche les bons fichiers
- [ ] Connecté à npm (`npm whoami`)

---

## Prérequis

Avoir un compte sur [npmjs.com](https://www.npmjs.com) et être connecté :

```bash
npm login
npm whoami   # vérifie que tu es bien connecté
```

---

## Publier une nouvelle version (procédure complète)

### 1. Changer la version

```bash
# Correction de bug : 0.2.0 → 0.2.1
npm version patch

# Nouvelle fonctionnalité : 0.2.0 → 0.3.0
npm version minor

# Changement incompatible : 0.2.0 → 1.0.0
npm version major
```

`npm version` met à jour `package.json`, crée un commit et un tag git automatiquement.

Conventions :
| Commande | Exemple | Quand l'utiliser |
|----------|---------|------------------|
| `npm version patch` | `0.2.0` → `0.2.1` | Correction de bug |
| `npm version minor` | `0.2.0` → `0.3.0` | Nouvelle fonctionnalité rétrocompatible |
| `npm version major` | `0.2.0` → `1.0.0` | Changement incompatible de config ou d'API |

### 2. Vérifier le package

```bash
npm pack --dry-run
```

Affiche la liste des fichiers qui seraient publiés sans rien envoyer.

### 3. Lancer les tests

```bash
npm test
```

### 4. Merger, pousser et publier

```bash
git checkout master
git merge hardening          # ou la branche en cours
git push origin master
git push origin --tags       # pousse le tag créé par npm version
npm publish
```

Le script `prepare` compile automatiquement le TypeScript avant la publication.
Le package publié contient uniquement `dist/lib/`, `dist/index.js`, `dist/scan.js`
et `config.schema.json` — pas les sources TypeScript ni les tests.

---

## Installer le plugin dans Homebridge

**Via l'interface web Homebridge :**
Plugins → rechercher `homebridge-myhome-unik` → Installer

**En ligne de commande :**
```bash
npm install -g homebridge-myhome-unik
```
