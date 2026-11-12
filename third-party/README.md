# Local Superagent installation

English | [中文](README.zh.md)

The original DeepSeek Superagent prototype is copied into [dsh-superagent](dsh-superagent/README.md). [dsh-superagent.source.json](dsh-superagent.source.json) records the upstream commit and source tree. The 216-file snapshot preserves the upstream source and MIT license; the source record lists local changes, including the opt-in Single-account mode port. This snapshot stays outside the Harness pnpm workspace and has its own locked dependencies.

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

For the existing Tebra Google Cloud VM, follow [the Harness replacement guide](../docs/cookbook/deploy-google-cloud.md).

## Single-account mode

Enable **Superagent → Settings → Sources → GitHub → Single-account mode** when the operator and agent share a GitHub account. Add that login to the GitHub Policy allowed list, then start each new request or follow-up with `/superagent` followed by instructions on the first nonblank line. The mode defaults to off; marked agent output stays excluded.

## Jira

Rebuild and reinstall the bundle before enabling its optional [Jira read tools](dsh-superagent/docs/013-jira-rest.md), [comment request Source](dsh-superagent/docs/014-jira-source.md), or [named MCP connections](dsh-superagent/docs/012-jira-mcp.md). Each Jira project maps to a Watching GitHub repository in this deployment.

## Multiple repositories

Use **Superagent → Settings → Sources → GitHub → Add repository** to manage Watching and Paused repositories. Rebuild and reinstall the bundle first, then configure the [repository-aware checkout helper](dsh-superagent/docs/006-deployment.md#multiple-repositories) before running jobs in another repository. Existing single-repository settings and history remain readable.
