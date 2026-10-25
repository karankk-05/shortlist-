declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    ADMIN_KEY_SHA256?: string;
    OWNER_ENTRY_PATH?: string;
    MAIL_USERNAME?: string;
    MAIL_PASSWORD?: string;
    OAUTH_KV: KVNamespace;
    OAUTH_PROVIDER: import('@cloudflare/workers-oauth-provider').OAuthHelpers;
    PORTAL_ORIGIN?: string;
    PUBLIC_CAMPUS_ONLY?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
  }
}
