import type { Grant } from '@cloudflare/workers-oauth-provider';

type EventConnection = { user_id: string; grant_id: string; principal_id: string };

/** Targeted read of the grant record written by workers-oauth-provider 1.2.4.
 * That pinned version has no single-grant helper; keep this adapter isolated and
 * verify its storage contract against a real provider grant in integration tests.
 * Never enumerate grants, decrypt props, or cache authorization in the app. */
export async function eventConnectionActive(env: Pick<Cloudflare.Env, 'OAUTH_KV'>, connection: EventConnection, time = Date.now()) {
  if (!connection.user_id || connection.user_id.includes(':') || !connection.grant_id || connection.grant_id.includes(':') || !connection.principal_id) return false;
  let grant: Grant | null;
  try {
    grant = await env.OAUTH_KV.get<Grant>(`grant:${connection.user_id}:${connection.grant_id}`, { type: 'json', cacheTtl: 30 });
  } catch { throw new Error('subscription_check_unavailable'); }
  return !!grant && grant.id === connection.grant_id && grant.userId === connection.user_id
    && grant.metadata?.key_id === connection.principal_id
    && Array.isArray(grant.scope) && grant.scope.includes('queue:events')
    && (grant.expiresAt === undefined || typeof grant.expiresAt === 'number' && Number.isFinite(grant.expiresAt) && grant.expiresAt * 1000 > time);
}
