/** A bounded IMAP reader. The command allowlist cannot send, delete or set flags. */
export type MailSocket = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close(): Promise<void> | void };
export class MailError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export const IMAP_HOST = 'qasid.iitk.ac.in';
export const IMAP_PORT = 993;
export const MAX_MAIL_BYTES = 10 * 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder();
export function imapQuote(value: string) {
  if (!value || value.length > 512 || /[^\x20-\x7e]/.test(value)) throw new MailError('invalid_login_or_folder');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}
export class ImapReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = new Uint8Array();
  private sequence = 0;
  private totalRead = 0;
  private socket: MailSocket;
  constructor(socket: MailSocket) { this.socket = socket; this.reader = socket.readable.getReader(); this.writer = socket.writable.getWriter(); }
  private async bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { void this.socket.close(); reject(new MailError('imap_timeout')); }, 20000); })]); }
    finally { clearTimeout(timer!); }
  }
  private async more() {
    const { value, done } = await this.bounded(this.reader.read());
    if (done || !value) throw new MailError('imap_disconnected');
    this.totalRead += value.length;
    if (this.totalRead > 24 * 1024 * 1024) throw new MailError('sync_byte_limit');
    const combined = new Uint8Array(this.buffer.length + value.length); combined.set(this.buffer); combined.set(value, this.buffer.length); this.buffer = combined;
  }
  private async line() {
    while (true) {
      for (let index = 0; index + 1 < this.buffer.length; index++) if (this.buffer[index] === 13 && this.buffer[index + 1] === 10) {
        const line = decoder.decode(this.buffer.subarray(0, index)); this.buffer = this.buffer.slice(index + 2); return line;
      }
      if (this.buffer.length > 256 * 1024) throw new MailError('imap_response_limit');
      await this.more();
    }
  }
  private async literal(length: number) {
    if (length > MAX_MAIL_BYTES) throw new MailError('message_too_large');
    const bytes = new Uint8Array(length);
    let offset = Math.min(length, this.buffer.length);
    bytes.set(this.buffer.subarray(0, offset)); this.buffer = this.buffer.slice(offset);
    while (offset < length) {
      const { value, done } = await this.bounded(this.reader.read());
      if (done || !value) throw new MailError('imap_disconnected');
      this.totalRead += value.length;
      if (this.totalRead > 24 * 1024 * 1024) throw new MailError('sync_byte_limit');
      const used = Math.min(value.length, length - offset);
      bytes.set(value.subarray(0, used), offset); offset += used;
      if (used < value.length) this.buffer = value.slice(used);
    }
    return bytes;
  }
  async greeting() { if (!/^\* OK\b/i.test(await this.line())) throw new MailError('imap_unavailable'); }
  private async command(command: string) {
    if (!/^(LOGIN |EXAMINE |UID SEARCH |UID FETCH |LOGOUT$)/.test(command) || /[\r\n\0]/.test(command)) throw new MailError('invalid_imap_command');
    const tag = 'S' + (++this.sequence);
    await this.bounded(this.writer.write(encoder.encode(`${tag} ${command}\r\n`)));
    const lines: string[] = [], literals: Uint8Array[] = [];
    for (let count = 0; count < 10000; count++) {
      const line = await this.line();
      if (line.startsWith(tag + ' ')) {
        if (!line.startsWith(tag + ' OK')) throw new MailError(command.startsWith('LOGIN') ? 'authentication_failed' : 'imap_command_failed');
        return { lines, literals };
      }
      if (/^\* BYE/i.test(line) && command !== 'LOGOUT') throw new MailError('imap_disconnected');
      lines.push(line);
      const literal = line.match(/\{(\d+)\+?\}$/);
      if (literal) literals.push(await this.literal(Number(literal[1])));
    }
    throw new MailError('imap_response_limit');
  }
  async login(username: string, password: string) { await this.command(`LOGIN ${imapQuote(username)} ${imapQuote(password)}`); }
  async examine(folder: string) {
    const { lines } = await this.command('EXAMINE ' + imapQuote(folder));
    const validity = lines.join('\n').match(/\[UIDVALIDITY (\d+)\]/i)?.[1];
    const next = Number(lines.join('\n').match(/\[UIDNEXT (\d+)\]/i)?.[1]);
    if (!validity || !Number.isSafeInteger(next) || next < 1) throw new MailError('imap_uid_metadata_missing');
    return { validity, lastUid: next - 1 };
  }
  async search(first: number, last: number, since: Date) {
    if (first > last) return [];
    if (![first, last].every(value => Number.isSafeInteger(value) && value > 0) || !Number.isFinite(since.getTime())) throw new MailError('invalid_uid_range');
    const date = `${since.getUTCDate()}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][since.getUTCMonth()]}-${since.getUTCFullYear()}`;
    const { lines } = await this.command(`UID SEARCH UID ${first}:${last} SINCE ${date} OR SUBJECT "short" BODY "short"`);
    return [...new Set(lines.filter(line => line.startsWith('* SEARCH')).flatMap(line => line.slice(8).trim().split(/\s+/).filter(Boolean).map(Number)))].filter(uid => Number.isSafeInteger(uid) && uid >= first && uid <= last).sort((a, b) => a - b);
  }
  async header(uid: number) {
    const response = await this.command(`UID FETCH ${uid} (UID RFC822.SIZE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT FROM DATE)])`);
    if (!response.lines.some(line => new RegExp(`\\bUID ${uid}\\b`).test(line))) return null;
    const size = Number(response.lines.join(' ').match(/RFC822\.SIZE (\d+)/i)?.[1]);
    if (!Number.isSafeInteger(size)) throw new MailError('imap_size_missing');
    return { size, bytes: response.literals[0] || new Uint8Array() };
  }
  async message(uid: number) {
    const response = await this.command(`UID FETCH ${uid} (UID BODY.PEEK[])`);
    if (!response.lines.some(line => new RegExp(`\\bUID ${uid}\\b`).test(line))) return null;
    return response.literals[0] || null;
  }
  async close() { try { await this.command('LOGOUT'); } catch {} finally { await this.socket.close(); } }
}
