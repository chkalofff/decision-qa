# Vendored: Deep Chat

Браузерный ESM-бандл [Deep Chat](https://deepchat.dev) — web component
`<deep-chat>`, используется чатом ассистента (`frontend/static/assistant.js`).
Сборка не требуется: модуль подключается напрямую из `<script type="module">`.

## Состав

| Путь | Пакет | Версия | Лицензия |
| --- | --- | --- | --- |
| `deepChat.bundle.js` | `deep-chat` | 2.5.1 | MIT (`LICENSE.deep-chat`) |
| `remarkable/index.js`, `remarkable/linkify.js` | `remarkable` | 2.0.1 | MIT (`LICENSE.remarkable`) |
| `autolinker/` | `autolinker` | 4.1.5 | MIT (`LICENSE.autolinker`) |
| `tslib.mjs` | `tslib` | 2.8.1 | 0BSD (`LICENSE.tslib`) |

Источник — npm registry (`npm pack deep-chat@2.5.1` и т.д.). Из `deep-chat`
взят только `dist/deepChat.bundle.js`; из `remarkable` — `dist/esm/`; из
`autolinker` — `dist/es2015/` без `.d.ts` и `.js.map`; из `tslib` — `tslib.es6.mjs`.

## Локальные правки

Бандл `deep-chat` импортирует `remarkable` по bare-спецификаторам, которых
в браузере нет. Импорты переписаны на относительные пути:

- `deepChat.bundle.js`: `from 'remarkable'` → `from './remarkable/index.js'`,
  `from 'remarkable/linkify'` → `from './remarkable/linkify.js'`.
- `remarkable/linkify.js`: `from 'autolinker'` → `from '../autolinker/index.js'`.
- `autolinker/**/*.js`: `from "tslib"` → `from '<rel>/tslib.mjs'`; импорты без
  расширения (`./foo`, `./dir`) дописаны до `./foo.js` / `./dir/index.js` —
  браузерный ESM требует явных путей.

## Обновление

1. Скачать новые версии (`npm pack`), положить файлы по тем же путям.
2. Повторить правки импортов выше.
3. Обновить версии в таблице.
