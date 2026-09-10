import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { PendingEncryptedEventStore } from '../lib/pending-encrypted-event-store.js';

describe('pending encrypted approval event store', () => {
  const temporaryDirectories = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('an encrypted history batch writes once and rolls back completely on persistence failure', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hagency-pending-batch-'));
    temporaryDirectories.push(directory);
    const store = new PendingEncryptedEventStore(path.join(directory, 'pending.json'));
    const input = id => ({ roomId: '!room:test', event: { type: 'm.room.encrypted', event_id: id, content: { ciphertext: id } } });
    const save = vi.spyOn(store, '_save');
    store.putMany([input('$one'), input('$two')]);
    expect(save).toHaveBeenCalledOnce();
    save.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => store.putMany([input('$three'), input('$four')])).toThrow('disk full');
    expect(store.list().map(row => row.eventId)).toEqual(['$one', '$two']);
    expect(new PendingEncryptedEventStore(store.filePath).list().map(row => row.eventId)).toEqual(['$one', '$two']);
  });

  test('retains an encrypted event across restart and removes it after recovery', () => {
    /*
     * REQ-OWNER-UI-APPROVAL-DELIVERY, the word "durably". A second store instance is
     * constructed over the same path — the stand-in for a bridge restart — and the ciphertext
     * plus its original receivedAt are still there, so a verdict that arrived before its room
     * key survives the process that could not read it. The 0600 check belongs to the same
     * claim: retaining an undecrypted owner verdict is only acceptable if it is retained
     * privately.
     */
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hagency-pending-e2ee-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'pending.json');
    const event = {
      type: 'm.room.encrypted',
      event_id: '$verdict',
      sender: '@owner:palpo.test',
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'encrypted' },
    };

    const first = new PendingEncryptedEventStore(filePath, { now: () => 1000 });
    first.put({ roomId: '!approval:palpo.test', event });

    const restarted = new PendingEncryptedEventStore(filePath, { now: () => 1001 });
    expect(restarted.list()).toEqual([expect.objectContaining({
      eventId: '$verdict',
      roomId: '!approval:palpo.test',
      event,
      receivedAt: 1000,
    })]);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);

    expect(restarted.remove('$verdict')).toBe(true);
    expect(restarted.list()).toEqual([]);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).records).toEqual([]);
  });

  test('prunes retained ciphertext after the bounded recovery window', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hagency-pending-e2ee-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'pending.json');
    let now = 1000;
    const store = new PendingEncryptedEventStore(filePath, {
      now: () => now,
      maxAgeMs: 500,
    });
    store.put({
      roomId: '!approval:palpo.test',
      event: {
        type: 'm.room.encrypted',
        event_id: '$stale',
        content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'encrypted' },
      },
    });

    now = 1501;
    expect(store.prune()).toEqual([expect.objectContaining({ eventId: '$stale' })]);
    expect(store.list()).toEqual([]);
  });

  test('fails closed instead of evicting an unprocessed event at capacity', () => {
    /*
     * REQ-OWNER-UI-APPROVAL-DELIVERY. "Retained durably" has to hold under pressure too: at
     * capacity the store throws and keeps `$first`, rather than making room by dropping the
     * oldest retained verdict. An LRU here would lose exactly the verdict that has been
     * waiting longest for its key, which is the one most likely to be about to arrive.
     */
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hagency-pending-e2ee-'));
    temporaryDirectories.push(directory);
    const store = new PendingEncryptedEventStore(path.join(directory, 'pending.json'), {
      maxEntries: 1,
    });
    store.put({
      roomId: '!approval:palpo.test',
      event: {
        type: 'm.room.encrypted',
        event_id: '$first',
        content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'first' },
      },
    });

    expect(() => store.put({
      roomId: '!approval:palpo.test',
      event: {
        type: 'm.room.encrypted',
        event_id: '$second',
        content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'second' },
      },
    })).toThrow('capacity exceeded');
    expect(store.list().map((record) => record.eventId)).toEqual(['$first']);
  });
});
