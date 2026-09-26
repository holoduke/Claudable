import { describe, expect, it } from 'vitest';
import { parsePublishedPorts } from './docker';

describe('parsePublishedPorts (cross-project preview leak guard)', () => {
  it('reads host ports bound to the gateway IP, which a loopback probe cannot see', () => {
    expect([...parsePublishedPorts('10.0.1.1:3711->3711/tcp\n10.0.1.1:3710->3710/tcp')]).toEqual([3711, 3710]);
  });
  it('handles v4+v6, ranges and containers without published ports', () => {
    const ports = parsePublishedPorts('0.0.0.0:8080->80/tcp, :::8080->80/tcp\n\n127.0.0.1:5432-5434->5432-5434/tcp\n3000/tcp');
    expect([...ports].sort()).toEqual([5432, 5433, 5434, 8080]);
  });
  it('parses docker inspect port JSON after normalisation', () => {
    const json = '{"3711/tcp":[{"HostIp":"10.0.1.1","HostPort":"3711"}]}';
    expect(parsePublishedPorts(json.replace(/"HostPort":"(\d+)"/g, ':$1->')).has(3711)).toBe(true);
  });
});
