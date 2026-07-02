# @polyant-ai/plugin-sdk

Guida per chi lavora **dentro** questa repo (sviluppatori + agenti AI). Per l'authoring di un tool/plugin vedi il **[README.md](README.md)**.

## Cos'è

Il **contratto pubblico e STATELESS** per gli autori di plugin Polyant. Espone solo `defineTool` + i tipi che un tool consuma (`ToolSpec`, `ToolDefinition`, `ToolContext`, `RequiredSecretSpec`, `ToolInfo`, `InstanceSlug`, `AuditLogger`, `Attachment`, `ConversationStateApi`, `ToolApiKeys`, …).

Questo pacchetto **NON possiede il registro dei tool** — lo possiede il loader del motore (`polyant-enterprise`). Di conseguenza avere **più copie dell'SDK in giro è innocuo**: ogni plugin risolve la propria copia (e il proprio `zod`, `ai`, …) senza coupling da singleton condiviso.

## Principio del confine dati (regola cardine)

`defineTool` serializza lo schema `zod` (`parameters`) → JSON Schema **al load del modulo, NEL realm del plugin** (`toJsonSchema` in `src/contract.ts`). Il motore riceve **solo dati** (`inputSchema`, un plain object) più la funzione `execute`.

- Un oggetto zod **vivo NON deve MAI attraversare il confine** motore↔plugin.
- **Mai** fare `instanceof` cross-package (fallirebbe: classi diverse da copie diverse dell'SDK/zod).
- I tipi in `context-types.ts` sono interfacce **strutturali** che mirrorano le forme concrete del motore (`AuditLogger`, `Attachment`, `ConversationStateApi`, `ToolApiKeys`): il brand `InstanceSlug` è solo type-level (phantom field), così gli oggetti concreti del motore soddisfano il contratto **senza importare gli internals**.

## Regole ferree

1. **Zero import dagli internals del motore.** L'SDK è autonomo; i tipi condivisi sono ridichiarati strutturalmente in `context-types.ts`.
2. **Deve restare stateless.** Niente `Map`/registri/singleton/stato di modulo. Solo funzioni pure + tipi.
3. **Deve shippare buildato.** `main: dist/index.js`, `types: dist/index.d.ts`. Lo script `prepare` builda `dist` così il pacchetto è consumabile come **git-dependency** (npm esegue `prepare` al clone del git ref).
4. **`Buffer` richiede `@types/node`** (usato in `Attachment.data`) — già in `devDependencies`.

## Come viene consumato

Sia il motore (`polyant-enterprise`) sia i plugin lo referenziano come **git-dependency** con tag:

```
git+https://github.com/polyant-ai/polyant-sdk.git#<tag>
```
(repo pubblico → clone https senza auth; niente chiavi SSH necessarie)

Ognuno risolve la **propria** copia (vedi il principio del confine dati sopra). `zod` è una **peer dependency** — la fornisce il consumer.

## Versioning

La **versione dell'SDK È il contratto di compatibilità.** Si lega a `plugin.json.engine` (range semver delle versioni motore supportate) tramite la versione del motore.

- Bump semver **deliberati**.
- **Rompere il contratto dei tool = major bump.**
- Pubblicare una nuova versione:
  1. bump di `version` in `package.json`
  2. commit
  3. tag `vX.Y.Z`
  4. push del tag
  5. i consumer aggiornano il git ref (`#vX.Y.Z`)

## Comandi

```bash
npm run build       # tsc → dist/ (tsconfig.build.json)
npm run typecheck   # tsc --noEmit
npm test            # vitest (7 test sul contratto)
```

## Come aggiungere/cambiare il contratto

1. Modifica `src/contract.ts` o `src/context-types.ts` (e riesporta da `src/index.ts` se serve).
2. Aggiorna/aggiungi i test.
3. `npm test` + `npm run build`.
4. Bump versione + tag (vedi Versioning) — un cambiamento incompatibile è un major.
