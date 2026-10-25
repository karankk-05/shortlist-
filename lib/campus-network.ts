import ipaddr from 'ipaddr.js';

// APNIC RDAP registrations checked 2026-10-25, including IITK's NKN egress.
// https://rdap.apnic.net/ip/14.139.38.102 and the corresponding address records.
export const IITK_PUBLIC_NETWORKS = ['14.139.38.0/24', '202.3.77.0/24', '103.246.106.0/24', '161.248.106.0/24', '2001:df0:92::/48'];
const networks = IITK_PUBLIC_NETWORKS.map(network => ipaddr.parseCIDR(network));
export const campusRestrictionEnabled = (env: Pick<Cloudflare.Env, 'PUBLIC_CAMPUS_ONLY'>) => env.PUBLIC_CAMPUS_ONLY === 'true';

/** Cloudflare overwrites this header at the edge. Never trust X-Forwarded-For. */
export function isIitkNetwork(request: Request): boolean {
  const value = request.headers.get('CF-Connecting-IP');
  if (!value || value.includes('%')) return false;
  try {
    const address = ipaddr.process(value);
    return networks.some(([network, prefix]) => address.kind() === network.kind() && address.match(network, prefix));
  } catch { return false; }
}

export function campusAccessDenied(html = false): Response {
  const message = 'Connect to the IIT Kanpur campus network to view shortlists.';
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Vary': 'CF-Connecting-IP, Cookie, Authorization' };
  if (!html) return Response.json({ error: message, code: 'iitk_network_required' }, { status: 403, headers });
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IITK network required · Shortlist Desk</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111113;color:#efeff1;font:16px system-ui}main{max-width:480px;padding:32px}h1{font-size:24px}p{color:#a8a8b2;line-height:1.6}</style><main><h1>IITK network required</h1><p>${message}</p></main></html>`, { status: 403, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" } });
}
