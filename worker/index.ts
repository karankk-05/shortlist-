import { handle } from '../lib/server';
import { agentGuide } from '../lib/agent-guide';
import { mailGuide } from '../lib/mail-guide';
import { scheduledMail, notifyQueue } from '../lib/queue-runtime';
import { authorizeAgent, oauthProvider } from '../lib/oauth';

const portal: ExportedHandler<Cloudflare.Env> = {
  async fetch(request: Request, env: Cloudflare.Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    if (path === '/oauth/authorize') return authorizeAgent(request, env);
    const ownerEntry = !!env.OWNER_ENTRY_PATH && path === env.OWNER_ENTRY_PATH;
    if (path === '/admin' || path.startsWith('/admin/') || (path.startsWith('/gate/') && !ownerEntry)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' } });
    if (url.pathname === '/agent') return new Response(agentGuide(url.origin), {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
    if (url.pathname === '/mail-agent') return new Response(mailGuide(url.origin), {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
    if (url.pathname.startsWith('/api/')) {
      const response = await handle(request);
      if (response.ok && request.method === 'POST' && (/\/mail\/(sync|import)$/.test(path) || /\/mail-jobs\/[^/]+\/retry$/.test(path))) context.waitUntil(notifyQueue(env).catch(() => { console.error('Queue notification failed; the next server tick will retry.'); }));
      return response;
    }
    const response = ownerEntry
      ? new HTMLRewriter().on('html', { element(element) { element.setAttribute('data-owner-entry', 'true'); } }).transform(await env.ASSETS.fetch(new Request(new URL('/', request.url), request)))
      : await env.ASSETS.fetch(request);
    const secured = new Response(response.body, response);
    secured.headers.set('X-Content-Type-Options', 'nosniff');
    secured.headers.set('Referrer-Policy', 'same-origin');
    if (ownerEntry) { secured.headers.set('Cache-Control', 'no-store'); secured.headers.set('Referrer-Policy', 'no-referrer'); secured.headers.set('X-Robots-Tag', 'noindex, nofollow'); }
    secured.headers.set('X-Frame-Options', 'DENY');
    secured.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    return secured;
  },
};

export default {
  async scheduled(controller: ScheduledController, env: Cloudflare.Env) { await scheduledMail(env, controller.cron); },
  async fetch(request: Request, env: Cloudflare.Env, context: ExecutionContext) { return oauthProvider(env, portal).fetch(request, env, context); },
} satisfies ExportedHandler<Cloudflare.Env>;
