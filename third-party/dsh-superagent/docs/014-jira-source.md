# 014 Jira command Source

The optional Jira Source turns a new Jira comment such as `/superagent fix this export and open a PR` into work through the same authorization, main Session, Ticket, worker, and Outbox flow used by GitHub. The issue's summary and description accompany the request. Acknowledgements and results return to that Jira issue, including the PR URL when work produces one. New command comments on the issue reach its existing ticket; the worker and main Session use the normal follow-up routing rules.

## Enable and configure

1. Follow the [bundle rebuild and installation steps](../../README.md#rebuild-the-package) first. In the existing profile's `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, enable the bundled Source:

   ```yaml
   - id: dsh-superagent-jira
     disabled: false
   ```

2. Put a **Jira REST API token** in the private `$HOME/.dsh_charles/.env` as `JIRA_SUPERAGENT_TOKEN`, or export it into the DSH process environment. Keep that file owner-only (`chmod 600 "$HOME/.dsh_charles/.env"`). This token is separate from the read-only MCP V2 agent-interface token in [Jira MCP setup](012-jira-mcp.md). The Source needs issue search/read, comment read/create with comment properties, and current-user access. The token owner's Jira account needs Browse Projects and Add Comments in the intended projects. Use the scopes documented for [enhanced issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/), [comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/), and [current user](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/). Classic scopes, where available, are `read:jira-work`, `write:jira-work`, and `read:jira-user`.

3. From the Harness repository root, stop the existing process and restart with `DSH_HOME="$HOME/.dsh_charles" pnpm dsh --profile superagent --host 127.0.0.1 --port 3081`. Under **Settings → Sources → Jira**, enter the site origin (`https://example.atlassian.net`), token owner's email, and the **environment variable name**, never the token value. For a scoped REST token, also enter the site's Cloud ID: requests then use `https://api.atlassian.com/ex/jira/<cloudId>`. Leave Cloud ID empty for an unscoped token using the site endpoint. See [Atlassian's scoped-token endpoint guidance](https://support.atlassian.com/atlassian-cloud/kb/401-unauthorized-error-when-service-account-accesses-jira-or-confluence-api/).

4. Add project/repository rows, for example `DEMO` → `acme/widgets`. Every mapping must name a Watching GitHub repository in this deployment, using the configured GitHub CLI account with push access. Each Jira project maps to exactly one repository. Enable the Jira Source and save.

5. Under **Settings → Eval → Policy**, add the requesting user's **Atlassian accountId** to **Jira users who may originate work**, then save. This is independent of GitHub usernames and the token owner's email. Account IDs are returned by Jira's user APIs, including `GET /rest/api/3/myself` for your own account. Do not put an email or display name in the ID field.

6. Wait for **Sources → Jira** to show Ready, then add a new unrestricted issue comment whose first nonblank line starts with the command:

   ```text
   /superagent fix the missing date column described in this issue and open a PR
   ```

   The default poll interval is 60 seconds. Explicit allowed requests work in Off, Observe and Auto evaluation modes. Processing pause still prevents dispatch. Repeat `/superagent` for follow-ups; ordinary Jira discussion does not become work.

## Behavior and boundaries

- Intake uses the enhanced `/rest/api/3/search/jql` endpoint, paginates all returned issues and comments, and resumes from durable per-site/project/repository cursors. The first poll establishes the activation boundary. Older comments are not replayed; edit the command or post a new one after Ready. Comment edits use the editing account's identity for authorization. A five-minute overlap accommodates ordinary Jira indexing delays; extreme search-index delays beyond that window can require reposting a request.
- The Jira account ID is checked against the current allowed list before ingestion, including on issues with an existing worker. The regular engine policy check also applies. Project/site/repository changes suspend old scopes; they never silently move an existing ticket to another repository. A different repository reports a Source error rather than using the deployment's default repository.
- Commands inside quotes, code blocks or lists do not start work. App accounts, agent-marked output and restricted comments are excluded. Restricted comments are also excluded from the assessment context reader. The Source does not change Jira status, assignee, fields or issue descriptions.
- Replies use the token owner's Jira identity. Each carries a visible `dsh-superagent:<message-id>` marker and a comment property so Outbox retries can recognize an already posted reply. Those markers prevent feedback loops when the operator and agent share a Jira account. Replies are plain text with full URLs. Permission loss or a missing issue remains retryable and visible through the Outbox, rather than discarding the result as delivered.
- Jira request context includes the issue description at intake. The main Session can read paginated issue/comment context through the Source adapter; the optional [Jira REST read tools](013-jira-rest.md) provide further worker investigation. A [Jira MCP connection](012-jira-mcp.md) is available separately in ordinary chats. Both can coexist with this Source. The Source needs its own comment-capable REST credential; the read tools remain GET-only. MCP is not required for command intake or result delivery.
- Credentials stay in the host environment. Source settings, Triggers, execution environment variables and channel addresses contain no token value. HTTP redirects are refused. Health errors omit upstream response bodies; polling honors `Retry-After` on 429 responses, and other repeated poll failures back off. Reply failures use the existing Outbox retry schedule. Failed pages or ingestion leave the project cursor unchanged for retry.

## Verify and troubleshoot

Check the new Trigger under the issue's Jira Thread, its explicit routing Decision, and the resulting Ticket/worker in the panel. Verify that `DSH_SUPERAGENT_GITHUB_REPOSITORY` names the mapped repository and that the acknowledgement and final result appear on the original Jira issue. Follow up with a second `/superagent` comment to exercise the existing worker.

For no Trigger, check Source Ready, activation time, project mapping, the first-line command and the comment author's account ID. For 401/403, check the REST token, scoped-token Cloud ID, scopes and Jira project permissions; a working MCP read connection alone does not establish Source access. For a queued but unstarted Ticket, check processing pause, worker slots and the configured model as with GitHub intake.

The deployment operator must verify live Jira access with the intended credentials. Automated tests use offline Jira responses and a local MCP server; they do not establish access to an organization’s Jira site.

Every Jira project mapping selects a Watching GitHub repository. An unwatched or paused target is rejected before Jira polling. Project moves still create a distinct thread identity.
