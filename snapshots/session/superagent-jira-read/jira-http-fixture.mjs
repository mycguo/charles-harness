/** Deterministic Jira HTTP response for the shipped headless profile's recorded-session replay. */
export const name = 'jira-http-fixture'

/**
 * Replace only the configured Jira gateway request and restore fetch when the fixture unloads.
 * @param ctx - Cordis context owning this test fixture.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (!url.startsWith('https://api.atlassian.com/ex/jira/12345678-1234-4234-8234-123456789abc/')) return original(input, init)
      if (init?.method !== 'GET' || !url.includes('/rest/api/3/issue/DEMO-1?')) throw new Error('Unexpected Jira fixture request')
      return new Response(JSON.stringify({ id: '1', key: 'DEMO-1', fields: { summary: 'Jira snapshot issue' } }))
    }
    return () => { globalThis.fetch = original }
  })
}
