# 012 Jira MCP context

Jira MCP gives ordinary chat sessions tools for reading Jira while handling an existing request. It does not watch Jira comments or start work. To accept `/superagent` requests in Jira comments, enable the separate Jira command Source described in `docs/014-jira-source.md`. GitHub intake continues as before.

## Account and host prerequisites

Use a Jira Cloud account that can view the intended project. In Atlassian Administration, select **Connectors → Atlassian MCP server** and allow API-token authentication under **Authentication**. Under **Permissions**, allow Jira **Read** and **Search**. See [Atlassian authentication](https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-authentication-via-api-token/) and [MCP permissions](https://support.atlassian.com/security-and-access-policies/docs/configure-atlassian-mcp-server-permissions/).

At [API token settings](https://id.atlassian.com/manage-profile/security/api-tokens), select **Create API token with scopes**, choose **Atlassian MCP V2**, and select only:

```text
read:jira:agent-interface
search:jira:agent-interface
```

The existing token list may show only names, dates and Revoke; use a replacement scoped token if its permissions cannot be confirmed. Selecting the older **Atlassian MCP** app or granting only Rovo search can leave the connection with a single `search` tool and no Jira issue/JQL tools. The preflight rejects that incomplete configuration. See [Atlassian tool scopes](https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/).

The host needs `@deepseek-ai/dsh-mcp-client`, included in DSH `0.2.1-rc.3`. This setup configures the host's native client rather than adding an event Source or replacing the model provider. An older host without the client must be upgraded before enabling the entry.

## Configure an existing profile

Install dependencies with `pnpm install --frozen-lockfile`. Save the API token in the private `$HOME/.dsh_charles/.env` using [the Jira environment example](../examples/jira.env.example), or export it into the environment of the DSH process. Treat `.env` as a private file (`chmod 600 "$HOME/.dsh_charles/.env"`). Do not place a token in command arguments, profile patches or Git. The existing database credential stays in its separate private file, as described in [PostgreSQL deployment](011-postgresql.md).

From this checkout, run:

```sh
DSH_HOME="$HOME/.dsh_charles" node scripts/setup-jira-mcp.mjs \
  --email operator@example.com \
  --site https://example.atlassian.net \
  --project DEMO
```

Use the email of the token owner, the Jira Cloud site origin, and the project's key. `--profile NAME` selects another existing profile, and `--token-env JIRA_OTHER_TOKEN` selects a different credential variable. The default is `JIRA_MYCGUO_TOKEN`. The script reads inherited variables before the checkout `.env`, then `$DSH_HOME/.env`, matching the documented launcher. It never evaluates dotenv contents as shell code.

### Keep personal and work accounts together

For Kareo work Jira, prefer the REST-backed `jira-kareo` integration documented in `docs/013-jira-rest.md`. It can coexist with the personal `mcp-jira` connection and does not require hosted MCP API-token access. When migrating, disable the old `mcp-jira_kareo` entry; the REST tools are named `jira_kareo_search`, `jira_kareo_get_issue`, `jira_kareo_comments`, and `jira_kareo_history`. The named MCP alternative below is only usable when your organization permits it.

Each account can have its own named MCP connection in the same `superagent` profile. The default `--server-name jira` retains the existing `mcp-jira` entry and `mcp__jira__…` tools. To add a separate account for Kareo Jira, keep the personal token and save the work token as `JIRA_TEBRA_TOKEN` in the same private environment file. Then run:

```sh
DSH_HOME="$HOME/.dsh_charles" node scripts/setup-jira-mcp.mjs \
  --server-name jira_kareo \
  --email your.work.account@tebra.com \
  --token-env JIRA_TEBRA_TOKEN \
  --site https://kareodev.atlassian.net \
  --project BILL
```

Use the work account's actual Atlassian email. Named connections require an explicit `--token-env`, so accidentally omitting it cannot reuse the default personal credential. Names must contain 1–32 letters, numbers, underscores or hyphens. This creates `mcp-jira_kareo`, with tools such as `mcp__jira_kareo__getJiraIssue`; it leaves `mcp-jira` and all other connections unchanged. Repeating the command or adding `--check` targets only that named connection. It refuses a server-name collision or an entry ID already assigned to a different plugin or namespace. Site and project still select the access test rather than restricting all runtime access for that credential.

The work account needs its own read/search-scoped token and any required organization approval. A connection in Codex or another app is separate from the credentials configured in this DSH profile. Configuration does not start or restart the app.

Before editing, setup connects to Atlassian's fixed HTTPS endpoint, requires issue, comment, history and JQL tools, rejects advertised Jira mutation tools, and performs a bounded JQL access test for the chosen project. Failures leave the profile untouched. Setup preserves PostgreSQL, Google login, models, comments and Harness `!!js` expressions, saves an owner-only backup and atomically inserts or updates the selected `mcp-<server-name>` entry. Repeat runs do not duplicate entries or backups.

The saved Authorization header is a `!!js` expression that reads the token from the host environment at startup. It contains no token value. The site and project arguments target the access test; they do not impose a runtime project allowlist. Use account permissions to limit accessible projects, and specify the site and project in agent requests. The native client exposes the upstream tools permitted by the credential; after rotating a token or expanding its scopes, rerun the check. The preflight is not a substitute for read-only token scopes.

From the Harness repository root, stop the existing process and restart with `DSH_HOME="$HOME/.dsh_charles" pnpm dsh --profile superagent --host 127.0.0.1 --port 3081` (add `--profile NAME` for another profile). The launcher runs DSH from this checkout so its `.env` is loaded. A manual launch from a different directory needs the token exported into that process. The setup command does not restart the app or alter the Jira organization, token, issue data, or existing Source settings. An MCP startup failure leaves the rest of the app available and appears in the host log; overall Superagent health alone is not an MCP check.

## Verify credentials, configuration and live tool use

Add `--probe` to the setup command to test only upstream credentials/capabilities without reading or writing a profile. Add `--check` to verify the saved MCP entry and repeat the access test without modifying it. Both require the same email, site and project arguments. Successful output lists the four required Jira tools and, when present, an example issue key. Upstream response bodies and authentication headers are excluded from diagnostics.

After a restart, ask the app:

> Use the Jira MCP tools on https://example.atlassian.net to search project DEMO. Return issue keys and links, then read one issue and its comments and history.

In **Trajectory**, confirm actual calls such as `mcp__jira__searchJiraIssuesUsingJql` and `mcp__jira__getJiraIssue` with returned Jira data. A successful standalone probe proves upstream access, not that the running host loaded the profile or exposed tools to a particular session. Verify MCP calls in an ordinary chat. Use the native REST integration for managed router and worker Sessions.

For the work account, request the `jira_kareo` tools explicitly, for example: “Use `jira_kareo` to read BILL-12099 on https://kareodev.atlassian.net, including its comments and history.” Confirm `mcp__jira_kareo__…` calls in Trajectory. Both connections expose the data their respective credentials can access; their names distinguish accounts and do not impose project isolation.

If only Rovo search is available, check the token's **Atlassian MCP V2** app/scopes and the organization's Jira permissions. Authentication uses the token owner's Atlassian email, independently of Google sign-in to the local workspace. The current model must also be able to make successful tool calls; a model transport error does not diagnose Jira connectivity.

The deployment operator must verify live Jira access with the intended credentials. Automated tests use offline Jira responses and a local MCP server; they do not establish access to an organization’s Jira site.

Run the setup helper from `third-party/dsh-superagent`. It reads the token from the launching environment, that checkout’s `.env`, or `DSH_HOME/.env`, in that order. Use `$HOME/.dsh_charles/.env` so the source Harness and helper read the same local credentials. Managed router/worker Sessions use the four native REST read tools; their restricted tool sets do not inherit arbitrary MCP tools.
