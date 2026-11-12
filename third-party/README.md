# Local Superagent installation

English | [中文](README.zh.md)

The original DeepSeek Superagent prototype is copied into [dsh-superagent](dsh-superagent/README.md). [dsh-superagent.source.json](dsh-superagent.source.json) records the upstream commit and source tree. The 216-file snapshot preserves the upstream source and MIT license; the source record lists one trailing-space cleanup. This snapshot stays outside the Harness pnpm workspace and has its own locked dependencies.

The `superagent` profile under `~/.dsh_charles` uses a packaged installation of this snapshot. It has no dependency on `~/dev/tebra-superagent`. Its separate state directory is `~/.dsh_charles/state/superagent-prototype`.

## Start or restart

Stop the existing process first, then run from the Harness repository root:

```sh
DSH_HOME="$HOME/.dsh_charles" pnpm dsh --profile superagent --host 127.0.0.1 --port 3081
```

The app opens the authenticated browser URL on port 3081. Configure a model in **Settings → Models** and a repository in **Superagent → Settings → Sources → GitHub**. The fresh prototype currently reports that no GitHub repository is configured; it creates its managed chat workspace after deployment setup succeeds.

## Rebuild the package

Run inside `third-party/dsh-superagent`:

```sh
pnpm --ignore-workspace --config.manage-package-manager-versions=false install --frozen-lockfile
node node_modules/typescript/bin/tsc --noEmit
node node_modules/tsdown/dist/run.mjs
pnpm --ignore-workspace --config.manage-package-manager-versions=false pack --pack-destination ../../.artifacts/superagent
```

Then stop the app and run from the Harness repository root. Remove the previous package first because a same-version replacement can retain its previous installation:

```sh
DSH_HOME="$HOME/.dsh_charles" pnpm dsh plugin --profile superagent remove dsh-superagent
DSH_HOME="$HOME/.dsh_charles" pnpm dsh plugin --profile superagent add file:"$PWD/.artifacts/superagent/dsh-superagent-0.1.0.tgz"
```

Restart with the command above. The profile owns its installed files; it does not link to the snapshot's source directory.
