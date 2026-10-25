import { OAuthProvider, getOAuthApi, OAuthError, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { actor, keyActor } from './server';
import { mailHash } from './mail-service';
import { mcpHandler } from './mcp';

export type AgentProps = { userId: string; key: string; keyId: string; grantId?: string };
export const AGENT_SCOPES = ['shortlists:read', 'shortlists:write', 'queue:events'];
const defaultOrigin = 'https://shortlist-desk.shortlists.workers.dev';
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function providerOptions(env: Cloudflare.Env, defaultHandler: ExportedHandler<Cloudflare.Env> = { fetch: () => new Response('Not found', { status: 404 }) }) {
  const origin = env.PORTAL_ORIGIN || defaultOrigin;
  return {
    apiRoute: '/mcp', apiHandler: mcpHandler,
    defaultHandler, authorizeEndpoint: '/oauth/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
    resourceMetadata: { resource: origin + '/mcp', authorization_servers: [origin] },
    scopesSupported: [...AGENT_SCOPES, 'offline_access'], requiredScopes: AGENT_SCOPES,
    clientIdMetadataDocumentEnabled: true, accessTokenTTL: 3600, refreshTokenTTL: 60 * 86400,
    clientRegistrationCallback: async ({ clientMetadata }: { clientMetadata: Record<string, unknown> }) => {
      if (!Array.isArray(clientMetadata.redirect_uris) || !clientMetadata.redirect_uris.every(value => { try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'chatgpt.com' && (url.pathname === '/connector_platform_oauth_redirect' || url.pathname.startsWith('/connector/oauth/')); } catch { return false; } })) return { description: 'Only ChatGPT redirect URIs are supported.' };
    },
    tokenExchangeCallback: async ({ props, grantId, env: currentEnv }: { props: AgentProps; grantId: string; env: Cloudflare.Env }) => {
      const row = await currentEnv.DB.prepare('SELECT id FROM access_keys WHERE id = ? AND revoked_at IS NULL AND expires_at > ?').bind(props.keyId, new Date().toISOString()).first();
      if (!row) throw new OAuthError('invalid_grant', { description: 'This agent connection has expired or been revoked.' });
      return { newProps: { ...props, grantId } };
    },
  };
}
export function oauthHelpers(env: Cloudflare.Env): OAuthHelpers { return env.OAUTH_PROVIDER || getOAuthApi(providerOptions(env), env); }
export function oauthProvider(env: Cloudflare.Env, defaultHandler: ExportedHandler<Cloudflare.Env>) { return new OAuthProvider<Cloudflare.Env>(providerOptions(env, defaultHandler)); }

export async function authorizeAgent(request: Request, env: Cloudflare.Env): Promise<Response> {
  const api = oauthHelpers(env);
  const secureHeaders = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
  try {
    if (request.method === 'GET') {
      const auth = await api.parseAuthRequest(request);
      if (!AGENT_SCOPES.every(scope => auth.scope.includes(scope)) || auth.scope.some(scope => ![...AGENT_SCOPES, 'offline_access'].includes(scope))) return new Response('The connection must request the Shortlist Desk agent scopes.', { status: 400, headers: secureHeaders });
      const redirect = new URL(auth.redirectUri);
      if (auth.clientId.startsWith('https://') && new URL(auth.clientId).hostname !== 'chatgpt.com') return new Response('Only ChatGPT clients are supported.', { status: 400, headers: secureHeaders });
      if (redirect.hostname !== 'chatgpt.com' || redirect.protocol !== 'https:') return new Response('Only ChatGPT connections are supported.', { status: 400, headers: secureHeaders });
      const transaction = await api.beginConsent(auth), description = await api.describeConsent(auth), owner = await actor(request);
      for (const [name, value] of new Headers(transaction.headers)) secureHeaders.append(name, value);
      return new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Shortlist Desk</title><style>body{color:#eee;background:#151515;font:16px system-ui;margin:8vh auto;padding:24px;max-width:580px}form{background:#222;padding:24px;border:1px solid #444;border-radius:16px}h1{font-size:25px}li{margin:12px 0}input{box-sizing:border-box;width:100%;padding:14px;background:#111;color:#fff;border:1px solid #777;border-radius:8px}button{font:inherit;padding:12px 20px;border-radius:8px;border:1px solid #777;cursor:pointer;margin:20px 10px 0 0}p{line-height:1.6;color:#bbb}</style><h1>Connect Shortlist Desk to ChatGPT</h1><form method="post" action="/oauth/authorize"><input type="hidden" name="handle" value="${escape(transaction.handle)}"><p>Client: <strong>${escape(description.clientName || 'ChatGPT')}</strong>${description.clientDomain ? ' · ' + escape(description.clientDomain) : ' (registered OAuth client)'}<br>Return address: <strong>${escape(description.redirectHost)}</strong></p><p>Allow access to:</p><ul><li>Read the private shortlist email queue, attachments and student master.</li><li>Match existing shortlisted students and publish results on Shortlist Desk.</li><li>Receive notifications when jobs are ready.</li></ul><p>Mailbox passwords, mailbox changes, master imports, shortlist deletion and owner settings are excluded. Access expires after 60 days and can be revoked from the owner area.</p>${owner?.role === 'admin' ? '<p>You are signed in as the owner.</p>' : '<label for="owner-key">Existing owner access key</label><p>Use the key you already use for the private owner page.</p><input id="owner-key" type="password" name="owner_key" autocomplete="off" required>'}<button type="submit" name="decision" value="allow">Connect ChatGPT</button><button type="submit" name="decision" value="deny" formnovalidate>Cancel</button></form></html>`, { headers: secureHeaders });
    }
    if (request.method !== 'POST' || request.headers.get('Origin') !== new URL(request.url).origin) return new Response('Authorization form could not be verified. Return to ChatGPT and start Connect again to load a fresh form. Your key has not been checked.', { status: 403, headers: secureHeaders });
    if (Number(request.headers.get('Content-Length') || 0) > 16384) return new Response('Request too large', { status: 413 });
    const form = await request.formData(), handle = String(form.get('handle') || '');
    if (form.get('decision') !== 'allow') { const denied = await api.denyConsent(request, handle); const headers = new Headers(denied.headers); headers.set('Location', denied.redirectTo); return new Response(null, { status: 303, headers }); }
    const ownerKey = form.get('owner_key');
    const owner = typeof ownerKey === 'string' && ownerKey ? await keyActor(ownerKey) : await actor(request);
    if (owner?.role !== 'admin') return new Response('Invalid owner key. Return to ChatGPT and reconnect.', { status: 401, headers: secureHeaders });
    const approval = await api.approveConsent(request, handle);
    const key = 'upl_' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const keyId = crypto.randomUUID(), time = new Date().toISOString();
    await env.DB.prepare('INSERT INTO access_keys (id, token_hash, label, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)').bind(keyId, await mailHash(key), 'ChatGPT event workflow', time, new Date(Date.now() + 60 * 86400000).toISOString()).run();
    const result = await api.completeAuthorization({ request: approval.request, userId: 'owner', metadata: { label: 'Shortlist Desk event workflow', key_id: keyId }, scope: approval.request.scope, props: { userId: 'owner', key, keyId }, revokeExistingGrants: true });
    const headers = new Headers(approval.headers); headers.set('Location', result.redirectTo); headers.set('Cache-Control', 'no-store'); headers.set('Referrer-Policy', 'no-referrer');
    return new Response(null, { status: 303, headers });
  } catch { return new Response('The connection request is invalid or expired. Return to ChatGPT and reconnect.', { status: 400, headers: secureHeaders }); }
}
