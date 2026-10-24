declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    ADMIN_KEY_SHA256?: string;
    OWNER_ENTRY_PATH?: string;
    MAIL_USERNAME?: string;
    MAIL_PASSWORD?: string;
  }
}
