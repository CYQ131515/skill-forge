# Contributing

Thanks for taking a look at Skill Forge.

## Development

```bash
# browser mode
node server.mjs
# http://127.0.0.1:4318

# tests
node --test test/*.test.js

# rebuild the macOS app
./desktop/build.sh
```

No `npm install` is needed. Please keep the runtime dependency-free.

## Pull requests

- Keep the scope focused; explain the user-facing problem in the PR description.
- Add or update tests for behavior changes (`test/core.test.js`).
- Run `node --test test/*.test.js` before opening the PR.
- For UI changes, include a screenshot (desktop + mobile if relevant).
- Never commit secrets, personal absolute paths, or generated export packages.

## Security

Skill Forge binds to `127.0.0.1` only and never uploads files. If you find a security issue,
please open a private security advisory instead of a public issue.
