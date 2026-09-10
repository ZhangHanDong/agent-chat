import { expect, test } from 'vitest';
import { OwnedProcessTree } from '../router/dist/index.js';

const row = (pid, ppid, pgid, started = `birth-${pid}`, state = 'S') => ({ pid, ppid, pgid, started, state });
const snapshot = (...rows) => new Map(rows.map(item => [item.pid, item]));

test('process ownership rejects reused leader and parent PIDs and never reacquires a retired group', () => {
  const tree = new OwnedProcessTree(20, 10);
  const initial = snapshot(row(10, 1, 10), row(20, 10, 20), row(30, 20, 30), row(31, 30, 31));
  tree.observe(initial);
  expect(tree.liveMembers(initial).map(p => p.pid)).toEqual([20, 30, 31]);
  const reused = snapshot(row(10, 1, 10), row(20, 99, 20, 'new-leader'), row(21, 20, 20),
    row(30, 99, 30, 'new-parent'), row(32, 30, 32), row(31, 1, 31));
  tree.observe(reused);
  expect(tree.liveMembers(reused).map(p => p.pid)).toEqual([31]);
  tree.observe(snapshot(row(10, 1, 10), row(31, 1, 31)));
  const later = snapshot(row(22, 1, 20), row(31, 1, 31, 'birth-31', 'Z'));
  tree.observe(later);
  expect(tree.liveMembers(later)).toEqual([]);
});

test('process ownership cannot acquire a root from a different guardian or process group', () => {
  const tree = new OwnedProcessTree(20, 10);
  for (const invalid of [snapshot(row(20, 99, 20), row(21, 20, 20)), snapshot(row(20, 10, 99))]) {
    tree.observe(invalid); expect(tree.rootObserved).toBe(false); expect(tree.liveMembers(invalid)).toEqual([]);
  }
});
