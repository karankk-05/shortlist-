import test from 'node:test';
import assert from 'node:assert/strict';
import { isIitkNetwork, campusAccessDenied } from '../lib/campus-network.ts';

const request = (ip, extra = {}) => new Request('https://shortlist.test/', { headers: { ...(ip ? { 'CF-Connecting-IP': ip } : {}), ...extra } });
test('accepts registered IITK IPv4 ranges, IPv6 and mapped IPv4', () => {
  for (const ip of ['14.139.38.0', '14.139.38.255', '202.3.77.1', '103.246.106.1', '161.248.106.254', '2001:df0:92::1', '2001:DF0:92:ffff:ffff:ffff:ffff:ffff', '::ffff:14.139.38.102']) assert.equal(isIitkNetwork(request(ip)), true, ip);
});
test('rejects adjacent institutions, other networks, invalid and absent addresses', () => {
  for (const ip of [null, '14.139.37.255', '14.139.39.0', '202.3.78.1', '2001:df0:93::1', '8.8.8.8', '127.0.0.1', '172.24.1.2', 'invalid', '14.139.38.102, 8.8.8.8', '2001:df0:92::1%eth0']) assert.equal(isIitkNetwork(request(ip)), false, String(ip));
});
test('ignores forged forwarding, identity and alternate IP headers', () => {
  assert.equal(isIitkNetwork(request('203.0.113.1', { 'X-Forwarded-For': '14.139.38.102', 'X-Real-IP': '14.139.38.102', 'CF-Connecting-IPv6': '2001:df0:92::1', 'X-ChatGPT-User-Email': 'owner@example.invalid' })), false);
});
test('campus denials contain no records and cannot be cached', async () => {
  for (const html of [false, true]) {
    const response = campusAccessDenied(html);
    assert.equal(response.status, 403); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.match(await response.text(), /Connect to the IIT Kanpur campus network/);
  }
});
