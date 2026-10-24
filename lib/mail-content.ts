import PostalMime from 'postal-mime';
import { InputError } from './records.ts';

export type MailConfig = { enabled: boolean; folder: string; lookback_days: number; senders: string[]; link_domains: string[] };
export const DEFAULT_MAIL_CONFIG: MailConfig = { enabled: true, folder: 'INBOX', lookback_days: 30, senders: [], link_domains: ['iitk.ac.in', 'docs.google.com', 'drive.google.com', 'onedrive.live.com', '1drv.ms'] };
/** Match complete shortlist words, including separated and inflected forms. */
export function hasShortlistKeyword(subject: string, text: string) {
  const keyword = /(?<![\p{L}\p{N}_])short[\s\p{Pd}]*list(?:s|ed|ing)?(?![\p{L}\p{N}_])/iu;
  return keyword.test(subject.normalize('NFKC')) || keyword.test(text.normalize('NFKC'));
}
export function validateMailConfig(input: Record<string, unknown>): MailConfig {
  if (typeof input.enabled !== 'boolean' || typeof input.folder !== 'string' || !input.folder || input.folder.length > 200 || /[^\x20-\x7e]/.test(input.folder)) throw new InputError('Provide an enabled flag and an ASCII IMAP folder name.');
  const days = Number(input.lookback_days);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new InputError('Lookback must be 1–365 days.');
  const list = (value: unknown, name: string) => {
    if (!Array.isArray(value) || value.length > 50 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 240)) throw new InputError(`Invalid ${name}.`);
    return [...new Set((value as string[]).map(item => item.trim().toLowerCase()))];
  };
  const senders = list(input.senders, 'senders'), domains = list(input.link_domains, 'link domains');
  if (senders.some(value => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) || domains.some(value => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(value))) throw new InputError('Use complete sender addresses and bare domain names, without URLs.');
  return { enabled: input.enabled, folder: input.folder, lookback_days: days, senders, link_domains: domains };
}
function entities(value: string) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/gi, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  });
}
export function extractMailLinks(text: string, html: string, domains: string[]) {
  const raw = [...text.matchAll(/https?:\/\/[^\s<>"']+/gi)].map(match => match[0]);
  for (const match of html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) raw.push(entities(match[1] || match[2] || match[3]));
  for (const match of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) raw.push(entities(match[1] || match[2] || match[3]));
  const seen = new Set<string>(), links: { url: string; allowed: boolean }[] = [];
  for (const value of raw.slice(0, 1000)) {
    try {
      const url = new URL(value.replace(/[.,;!?]+$/, ''));
      if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.href.length > 8000) continue;
      url.hash = '';
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      links.push({ url: url.href, allowed: domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain)) });
    } catch {}
  }
  return links.slice(0, 100);
}
export async function parseMail(bytes: Uint8Array, config: MailConfig, headersOnly = false) {
  const email = await PostalMime.parse(bytes, { maxNestingDepth: 15, maxHeadersSize: 65536 });
  const html = (email.html || '').slice(0, 500000);
  const fallback = entities(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' '));
  const text = (email.text || fallback).slice(0, 500000);
  const imageExtensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  const supported = (headersOnly ? [] : email.attachments || []).filter(item => /\.(xlsx?|csv|tsv|json|pdf|txt|png|jpe?g|webp|gif)$/i.test(item.filename || '') || Object.hasOwn(imageExtensions, item.mimeType));
  const attachments = supported.slice(0, 20).map((item, index) => ({
    filename: (item.filename || `inline-image-${index + 1}.${imageExtensions[item.mimeType] || 'bin'}`).replace(/[\r\n\0\\/]/g, '_').slice(0, 240),
    content_type: item.mimeType || 'application/octet-stream', bytes: new Uint8Array(item.content as ArrayBuffer),
    inline: item.disposition === 'inline' || !!item.related, content_id: (item.contentId || '').slice(0, 998),
  }));
  const links = extractMailLinks(text, html, config.link_domains);
  const truncated = supported.length > 20 || (email.text || '').length > 500000 || (email.html || '').length > 500000 || links.length >= 100;
  return { message_id: (email.messageId || '').slice(0, 998), subject: (email.subject || '(No subject)').slice(0, 1000), sender: (email.from?.address || '').toLowerCase().slice(0, 240), received_at: (email.date || '').slice(0, 1000) || null, text, links, attachments, truncated };
}
