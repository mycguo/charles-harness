# 013 Jira REST read tools

The optional `jira-kareo` integration reads Jira through the standard Jira Cloud REST v3 API, not Atlassian's hosted MCP endpoint. Use it when your Jira account has REST access but the organization's MCP API-token policy denies access. It still requires normal Jira account permissions and REST token scopes; it does not bypass authorization.

## Configure the existing profile

1. Put the token owner's email in `ATLASSIAN_ACCOUNT_EMAIL` and their Jira REST token in `ATLASSIAN_API_TOKEN` in the private `$HOME/.dsh_charles/.env`, or export both into the DSH process environment. Never put a token value in profile YAML, commands, or Git. Keep that file owner-only.
2. Obtain the site's Cloud ID from `https://YOUR-SITE.atlassian.net/_edge/tenant_info`. This integration uses the scoped-token gateway `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/…`.
3. Follow the [bundle rebuild and installation steps](../../README.md#rebuild-the-package). Add this override to the existing profile's `cordis.patch.yml`:

   ```yaml
   - id: jira-kareo
     disabled: false
     config:
       site: https://example.atlassian.net
       cloudId: 00000000-0000-4000-8000-000000000000
       emailEnv: ATLASSIAN_ACCOUNT_EMAIL
       tokenEnv: ATLASSIAN_API_TOKEN
   ```

4. From the Harness repository root, stop the existing process and restart the profile with `DSH_HOME="$HOME/.dsh_charles" pnpm dsh --profile superagent --host 127.0.0.1 --port 3081`. Do not start a second server. Refresh the existing workspace and verify the tools appear in its Trajectory. A standalone REST probe proves access but does not prove the running host has loaded the tools.

If replacing the named hosted MCP connection from the Jira MCP guide, also add `- id: mcp-jira_kareo` with `disabled: true` in the same profile. If you used a different server name, disable its corresponding `mcp-<server-name>` entry instead. This avoids duplicate connections. Leave the personal `mcp-jira` entry unchanged; its tools continue to use that account. The separate Jira command Source described in `docs/014-jira-source.md` can run alongside these tools; enable its `dsh-superagent-jira` plugin to receive `/superagent` comments and post replies. Its comment-capable credential is configured separately from these GET-only tools.

## Available tools

- `jira_kareo_search`: JQL search, optional `maxResults` (1–100) and `nextPageToken`.
- `jira_kareo_get_issue`: read summary, description, status, assignee, project, and update time by `issueIdOrKey`.
- `jira_kareo_comments`: read comments, with `startAt` and `maxResults` pagination.
- `jira_kareo_history`: read change history, with `startAt` and `maxResults` pagination.

For tasks assigned to the authenticated account, search with `assignee = currentUser() ORDER BY updated DESC`. Search results can include completed tasks; add `AND resolution = Unresolved` for open tasks. Follow the returned pagination markers to retrieve additional pages.

All operations are GET requests. The integration exposes no Jira write operations, invokes no MCP server, does not poll for work, and creates no Tickets or replies. Credentials are resolved from the host environment for each call, HTTP redirects are refused, calls have timeouts and cancellation, and errors exclude upstream response bodies and credential values. Jira issue text and comments remain untrusted external content, not instructions.

A 401 or 403 requires checking the REST token, account permissions, scopes, and Cloud ID. Removing an MCP setup check does not change Jira permissions.

The deployment operator must verify live Jira access with the intended credentials. Automated tests use offline Jira responses and a local MCP server; they do not establish access to an organization’s Jira site.
