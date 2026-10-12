# Сборка `frontend/static/vendor/cm.bundle.js`

Вендорный ESM-бандл CodeMirror 6 (редактор JSON-вкладки). Исходники не
коммитятся, только точка входа (`entry.js`) и манифест.

Пересборка (нужны node и npm; на этой машине рабочий node — `/usr/local/bin/node`):

```bash
cd scripts/cm-bundle
npm install
npm run build
```

Набор экспортов — в `entry.js`; потребитель — `frontend/static/context.js`.
При добавлении возможностей редактора (новые команды/расширения) сначала
добавьте экспорт в `entry.js`, пересоберите бандл, затем используйте в коде.
