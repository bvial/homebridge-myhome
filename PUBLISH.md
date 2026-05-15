# Publication de homebridge-myhome-unik

## Prérequis

Avoir un compte sur [npmjs.com](https://www.npmjs.com) et être connecté :

```bash
npm login
```

## Étapes de publication

### 1. Merger la branche et créer un tag

```bash
git checkout master
git merge hardening
git tag v0.2.0
git push origin master
git push origin v0.2.0
```

### 2. Publier sur npm

```bash
npm publish
```

Le script `prepare` compile automatiquement le TypeScript avant la publication.
Le package publié contient uniquement `dist/lib/`, `dist/index.js`, `dist/scan.js` et `config.schema.json` — pas les sources ni les tests.

---

## Vérifier le package avant publication (optionnel)

```bash
npm pack --dry-run
```

Affiche la liste des fichiers qui seraient publiés sans rien envoyer.

---

## Installer le plugin dans Homebridge

**Via l'interface web Homebridge :**
Plugins → rechercher `homebridge-myhome-unik` → Installer

**En ligne de commande :**
```bash
npm install -g homebridge-myhome-unik
```

---

## Publier une nouvelle version

1. Modifier la version dans `package.json` (`0.2.0` → `0.2.1`, `0.3.0`, etc.)
2. Committer
3. Créer un tag et pousser
4. Publier

```bash
# Exemple pour une version patch (correction de bug)
npm version patch          # incrémente 0.2.0 → 0.2.1 et crée le commit + tag
git push origin master
git push origin --tags
npm publish
```

Conventions de versionnement :
- `npm version patch` → `0.2.x` correction de bug
- `npm version minor` → `0.x.0` nouvelle fonctionnalité rétrocompatible
- `npm version major` → `x.0.0` changement incompatible
