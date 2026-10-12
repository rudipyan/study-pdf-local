# Contributing

Report bugs and propose features in [this fork’s issue tracker](https://github.com/rudipyan/study-pdf-local/issues). For bugs, include Obsidian version, OS/device, expected and actual behavior, and a non-sensitive reproduction file if possible.

Preserve the original MIT attribution and keep changes focused. Build with `npm run build` and lint with `npm run lint`. The repository also contains a Vitest suite (`npm test`); the first public preview did not run it. UI/viewer changes need checks in a running Obsidian instance, including mobile where relevant. Do not claim physical-device verification from browser emulation.

Do not commit user PDFs, vault settings, credentials, local audit logs, or generated `main.js`. Release files are attached manually. No automatic release workflow is enabled.
