import test from 'node:test';
import assert from 'node:assert/strict';
import { ImapReader, imapQuote } from '../lib/imap.ts';
import { DEFAULT_MAIL_CONFIG, extractMailLinks, parseMail, validateMailConfig } from '../lib/mail-content.ts';

const enc = new TextEncoder(), dec = new TextDecoder();
function mockImap(rejectLogin = false) {
  let controller; const commands = [];
  const header = 'Subject: Synthetic shortlist\r\nFrom: placement@example.invalid\r\n\r\n';
  const message = header + 'S999 OK this is literal email text, not a protocol response\r\n';
  function emit(text) { const bytes = enc.encode(text); for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7)); }
  const socket = {
    readable: new ReadableStream({ start(value) { controller = value; emit('* OK synthetic server\r\n'); } }),
    writable: new WritableStream({ write(bytes) {
      const command = dec.decode(bytes).trim(); commands.push(command);
      const tag = command.split(' ')[0], input = command.slice(tag.length + 1);
      if (input.startsWith('LOGIN')) emit(`${tag} ${rejectLogin ? 'NO secret echoed by server' : 'OK authenticated'}\r\n`);
      else if (input.startsWith('EXAMINE')) emit(`* OK [UIDVALIDITY 99] valid\r\n* OK [UIDNEXT 16] next\r\n${tag} OK [READ-ONLY] examined\r\n`);
      else if (input.startsWith('UID SEARCH')) emit(`* SEARCH 11 13 15\r\n${tag} OK searched\r\n`);
      else if (input.includes('HEADER.FIELDS')) emit(`* 1 FETCH (UID 11 RFC822.SIZE ${enc.encode(message).length} BODY[HEADER.FIELDS (MESSAGE-ID SUBJECT FROM DATE)] {${enc.encode(header).length}}\r\n${header})\r\n${tag} OK fetched\r\n`);
      else if (input.startsWith('UID FETCH')) emit(`* 1 FETCH (UID 11 BODY[] {${enc.encode(message).length}}\r\n${message})\r\n${tag} OK fetched\r\n`);
      else if (input === 'LOGOUT') emit(`* BYE logout\r\n${tag} OK logout\r\n`);
      else throw Error('Unexpected test command');
    } }), close() { controller.close(); },
  };
  return { reader: new ImapReader(socket), commands, message };
}
test('IMAP uses EXAMINE and BODY.PEEK, parses split literals, and handles an empty UID interval', async () => {
  const { reader, commands, message } = mockImap();
  await reader.greeting(); await reader.login('synthetic', 'fake-test-password');
  assert.deepEqual(await reader.examine('INBOX'), { validity: '99', lastUid: 15 });
  assert.deepEqual(await reader.search(11, 15, new Date('2026-10-01')), [11,13,15]);
  const before = commands.length; assert.deepEqual(await reader.search(16, 15, new Date()), []); assert.equal(commands.length, before);
  assert.ok((await reader.header(11)).size > 0);
  assert.equal(dec.decode(await reader.message(11)), message);
  await reader.close();
  assert.ok(commands.some(line => line.includes('BODY.PEEK[]')));
  assert.equal(commands.some(line => /\b(?:SELECT|STORE|APPEND|DELETE|MOVE|EXPUNGE)\b/.test(line)), false);
});
test('IMAP escapes quotes and rejects command injection; login errors do not expose server text', async () => {
  assert.equal(imapQuote('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => imapQuote('password\r\nDELETE INBOX'));
  const { reader } = mockImap(true); await reader.greeting();
  await assert.rejects(reader.login('synthetic','fake'), error => error.message === 'authentication_failed' && !error.message.includes('secret'));
  await reader.close();
});
test('MIME decodes base64 attachments, encoded subjects and HTML links without executing HTML', async () => {
  const csv = 'name,roll\r\nSynthetic,240001\r\n';
  const raw = `From: Placement <placement@example.invalid>\r\nSubject: =?UTF-8?B?U2hvcnRsaXN0?=\r\nMessage-ID: <synthetic@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="test"\r\n\r\n--test\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<script>neverExecute()</script><p>shortlist</p><a href="https://docs.google.com/spreadsheets/d/synthetic?a=1&amp;b=2">Sheet</a>\r\n--test\r\nContent-Type: text/csv\r\nContent-Disposition: attachment; filename="synthetic.csv"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(csv).toString('base64')}\r\n--test--\r\n`;
  const result = await parseMail(enc.encode(raw), DEFAULT_MAIL_CONFIG);
  assert.equal(result.subject, 'Shortlist'); assert.equal(result.sender,'placement@example.invalid');
  assert.equal(dec.decode(result.attachments[0].bytes), csv);
  assert.equal(result.links[0].allowed,true); assert.match(result.links[0].url,/a=1&b=2/);
  assert.equal(result.text.includes('neverExecute'),false);
});
test('link allowlist rejects lookalike hosts, credential URLs and insecure protocols', () => {
  const links = extractMailLinks('https://spo.iitk.ac.in/sheet https://iitk.ac.in.evil.example/sheet http://iitk.ac.in/old https://user:secret@iitk.ac.in/file', '', ['iitk.ac.in']);
  assert.equal(links.length,2); assert.equal(links[0].allowed,true); assert.equal(links[1].allowed,false);
});
test('mail settings accept optional exact senders and reject injected folders or URL-shaped domains', () => {
  assert.equal(validateMailConfig(DEFAULT_MAIL_CONFIG).folder,'INBOX');
  assert.throws(()=>validateMailConfig({...DEFAULT_MAIL_CONFIG,folder:'INBOX\r\nDELETE'}));
  assert.throws(()=>validateMailConfig({...DEFAULT_MAIL_CONFIG,lookback_days:366}));
  assert.throws(()=>validateMailConfig({...DEFAULT_MAIL_CONFIG,link_domains:['https://iitk.ac.in']}));
  assert.throws(()=>validateMailConfig({...DEFAULT_MAIL_CONFIG,senders:['all']}));
});
