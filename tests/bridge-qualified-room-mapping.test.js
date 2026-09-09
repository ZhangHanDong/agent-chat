import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOME = 'e2e-home.invalid';
const SIDE = '127.0.0.1:8008';
const OTHER_SIDE = 'other.example';
const ORIGINAL = `!original:${SIDE}`;
const NEW_ROOM = `!new:${SIDE}`;
const GROUP = 'e2e project room';

let module;
let bridge;
let runtime;
let stateFile;
let savedEnv;
let savedListeners;

const maps = () => {
  const state = module.bridgeStateForTest();
  return structuredClone({ roomGroupMap: state.roomGroupMap, groupRoomMap: state.groupRoomMap });
};
const persistedMaps = () => {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  return { roomGroupMap: state.roomGroupMap, groupRoomMap: state.groupRoomMap };
};
const conflicts = () => module.bridgeStateForTest().groupMapConflicts || [];
const nameEvent = (name = GROUP) => ({
  type: 'm.room.name', event_id: '$name', sender: `@alex:${SIDE}`,
  origin_server_ts: Date.now(), content: { name },
});

beforeEach(async () => {
  savedEnv = { ...process.env };
  savedListeners = new Map(['exit', 'SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
  runtime = mkdtempSync(path.join(tmpdir(), 'hafleet-qualified-room-'));
  stateFile = path.join(runtime, 'data', 'matrix', 'bridge-state.json');
  mkdirSync(path.dirname(stateFile), { recursive: true });
  // Real startup migration must run before the name event. A direct mapRoom
  // seed with a supplied side would hide the production credential-shape bug.
  writeFileSync(stateFile, JSON.stringify({
    roomGroupMap: { [ORIGINAL]: GROUP },
    groupRoomMap: { [GROUP]: ORIGINAL },
    trustedManagedRooms: { [ORIGINAL]: {}, [NEW_ROOM]: {} },
  }));
  process.env.HAFLEET_RUNTIME_DIR = runtime;
  process.env.HAFLEET_API = 'https://backend.invalid';
  process.env.MATRIX_SERVER_NAME = HOME;
  process.env.MATRIX_TRUST_MODE = 'enforce';
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const target = new URL(String(url));
    if (target.origin !== 'https://backend.invalid' || options.method !== 'GET'
      || !target.pathname.startsWith('/api/groups/')) {
      throw new Error(`Unexpected test network operation: ${options.method} ${url}`);
    }
    const name = decodeURIComponent(target.pathname.slice('/api/groups/'.length));
    return { ok: true, status: 200, text: async () => JSON.stringify({ name, members: [] }) };
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.resetModules();
  module = await import('../bridge-matrix.js');
  bridge = Object.create(module.MatrixBridge.prototype);
  Object.assign(bridge, {
    startupTs: 0,
    botUserId: `@hafleet:${HOME}`,
    _bridgeCreatedGroups: new Set(),
    actingCredentials: new Map([SIDE, OTHER_SIDE, HOME].map(side => [side, {
      kind: 'appservice', serverName: side, apiBaseUrl: `https://${side}`,
      asToken: 'test-only-token', senderLocalpart: 'hafleet',
    }])),
    reconcileRoomGroupMembership: vi.fn(async () => {}),
    syncApprovalBindingForRoom: vi.fn(async () => {}),
    botClient: {
      getJoinedRoomMembers: vi.fn(async () => [
        `@hafleet:${SIDE}`, `@alex:${SIDE}`, `@sam:${SIDE}`, `@pat:${SIDE}`,
      ]),
      getRoomStateEvent: vi.fn(async () => ({ name: GROUP })),
    },
  });
});

afterEach(() => {
  for (const [signal, original] of savedListeners) {
    for (const listener of process.listeners(signal)) {
      if (!original.includes(listener)) process.removeListener(signal, listener);
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = savedEnv;
  rmSync(runtime, { recursive: true, force: true });
});

describe('qualified room mappings through real credential helpers', () => {
  test('refuses a fresh same-side name after startup migration using real credential helpers', async () => {
    expect(maps().groupRoomMap).toEqual({ [`${GROUP}@${SIDE}`]: ORIGINAL });
    const before = maps();
    await bridge.onRoomEvent(NEW_ROOM, nameEvent());
    expect(maps()).toEqual(before);
    expect(persistedMaps()).toEqual(before);
    expect(conflicts()).toMatchObject([{ side: SIDE, fromRoom: ORIGINAL, toRoom: NEW_ROOM }]);
    expect(bridge.reconcileRoomGroupMembership).not.toHaveBeenCalled();
    expect(bridge.syncApprovalBindingForRoom).not.toHaveBeenCalled();
  });

  test('refused rename preserves both mapping directions and skips reconciliation', async () => {
    module.__mapRoomForTest(NEW_ROOM, 'Independent project', { side: SIDE });
    const before = maps();
    await bridge.onRoomEvent(NEW_ROOM, nameEvent());
    expect(maps()).toEqual(before);
    expect(persistedMaps()).toEqual(before);
    expect(conflicts()).toMatchObject([{ side: SIDE, fromRoom: ORIGINAL, toRoom: NEW_ROOM }]);
    expect(bridge.reconcileRoomGroupMembership).not.toHaveBeenCalled();
    expect(bridge.syncApprovalBindingForRoom).not.toHaveBeenCalled();
  });

  test('tryMapRoom refuses a migrated same-side collision', async () => {
    const before = maps();
    await expect(bridge.tryMapRoom(NEW_ROOM)).resolves.toBeNull();
    expect(maps()).toEqual(before);
    expect(persistedMaps()).toEqual(before);
    expect(conflicts()).toMatchObject([{ side: SIDE, fromRoom: ORIGINAL, toRoom: NEW_ROOM }]);
    expect(bridge.syncApprovalBindingForRoom).not.toHaveBeenCalled();
  });

  test('bindRoom refuses a same-side collision and preserves the old route', () => {
    module.__mapRoomForTest(NEW_ROOM, 'Independent project', { side: SIDE });
    const before = maps();
    bridge.bindRoom(NEW_ROOM, GROUP);
    expect(maps()).toEqual(before);
    expect(persistedMaps()).toEqual(before);
    expect(conflicts()).toMatchObject([{ side: SIDE, fromRoom: ORIGINAL, toRoom: NEW_ROOM }]);
  });

  test('real credential helpers keep same-name rooms on different sides independent', async () => {
    const otherRoom = `!different:${OTHER_SIDE}`;
    module.bridgeStateForTest().trustedManagedRooms[otherRoom] = {};
    await bridge.onRoomEvent(otherRoom, nameEvent());
    expect(maps().groupRoomMap).toEqual({
      [`${GROUP}@${SIDE}`]: ORIGINAL,
      [`${GROUP}@${OTHER_SIDE}`]: otherRoom,
    });
    expect(bridge.actingSideFor(OTHER_SIDE.toUpperCase()).side.id).toBe(OTHER_SIDE);
    expect(conflicts()).toEqual([]);
    expect(bridge.reconcileRoomGroupMembership).toHaveBeenCalledWith(otherRoom, GROUP);
  });

  test('home-server names remain bare even with a registered acting credential', async () => {
    const ownRoom = `!own:${HOME}`;
    module.bridgeStateForTest().trustedManagedRooms[ownRoom] = {};
    expect(bridge.sideForRoom(ownRoom)).toBeNull();
    await bridge.onRoomEvent(ownRoom, nameEvent('Home project'));
    expect(maps().roomGroupMap[ownRoom]).toBe('Home project');
    expect(maps().groupRoomMap['Home project']).toBe(ownRoom);
    expect(maps().groupRoomMap[`Home project@${HOME}`]).toBeUndefined();
    expect(conflicts()).toEqual([]);
  });

  test('mapRoom collision is atomic for an already mapped room', () => {
    module.__mapRoomForTest(NEW_ROOM, 'Independent project', { side: SIDE });
    const before = maps();
    expect(module.__mapRoomForTest(NEW_ROOM, GROUP, { side: SIDE })).toBe(false);
    expect(maps()).toEqual(before);
    expect(persistedMaps()).toEqual(before);
    expect(conflicts()).toHaveLength(1);
  });

  test.each(['bare', 'qualified'])('mixed-case persisted room keys cannot be bypassed by canonical side IDs (%s)', async (form) => {
    const rawSide = 'sideB.example';
    const canonicalSide = rawSide.toLowerCase();
    const oldRoom = `!old:${rawSide}`;
    const newRoom = `!new:${canonicalSide}`;
    const qualified = `${GROUP}@${rawSide}`;
    const key = form === 'bare' ? GROUP : qualified;
    writeFileSync(stateFile, JSON.stringify({
      roomGroupMap: { [oldRoom]: key },
      groupRoomMap: { [key]: oldRoom },
      trustedManagedRooms: { [oldRoom]: {}, [newRoom]: {} },
    }));
    vi.resetModules();
    module = await import('../bridge-matrix.js');
    Object.setPrototypeOf(bridge, module.MatrixBridge.prototype);
    bridge.actingCredentials.set(canonicalSide, {
      kind: 'appservice', serverName: canonicalSide, apiBaseUrl: 'https://sideb.example',
      asToken: 'test-only-token', senderLocalpart: 'hafleet',
    });
    const before = maps();
    expect(before.groupRoomMap).toEqual({ [qualified]: oldRoom });
    await bridge.onRoomEvent(newRoom, nameEvent());
    expect(maps()).toEqual(before);
    expect(persistedMaps()).toEqual(before);
    expect(conflicts()).toMatchObject([{ side: canonicalSide, fromRoom: oldRoom, toRoom: newRoom }]);
    expect(module.__roomForGroupForTest(GROUP, canonicalSide)).toBe(oldRoom);
    expect(bridge.reconcileRoomGroupMembership).not.toHaveBeenCalled();
    await bridge.onRoomEvent(oldRoom, nameEvent());
    expect(maps()).toEqual(before);
    expect(conflicts()).toHaveLength(1);
    expect(bridge.reconcileRoomGroupMembership).toHaveBeenCalledWith(oldRoom, GROUP);
  });

  test('conflicting case-equivalent side aliases reject mapping and lookup', () => {
    const state = module.bridgeStateForTest();
    state.groupRoomMap = { [`${GROUP}@other.example`]: ORIGINAL, [`${GROUP}@Other.Example`]: NEW_ROOM };
    state.roomGroupMap = { [ORIGINAL]: `${GROUP}@other.example`, [NEW_ROOM]: `${GROUP}@Other.Example` };
    const before = maps();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const side of ['other.example', 'Other.Example', 'OTHER.EXAMPLE']) {
      expect(module.__roomForGroupForTest(GROUP, side)).toBeNull();
      expect(module.__mapRoomForTest(ORIGINAL, GROUP, { side })).toBe(false);
      expect(maps()).toEqual(before);
    }
    expect(warning.mock.calls.flat().join(' ')).toContain('ambiguous');
    expect(conflicts()).toHaveLength(3);
    expect(conflicts().every(conflict => conflict.message.includes('ambiguous'))).toBe(true);
  });

  test('same-room side aliases stay usable while group names remain case-sensitive', () => {
    const state = module.bridgeStateForTest();
    state.groupRoomMap = { [`${GROUP}@other.example`]: ORIGINAL, [`${GROUP}@Other.Example`]: ORIGINAL };
    state.roomGroupMap = { [ORIGINAL]: `${GROUP}@Other.Example` };
    const before = maps();
    expect(module.__roomForGroupForTest(GROUP, 'OTHER.EXAMPLE')).toBe(ORIGINAL);
    expect(module.__mapRoomForTest(ORIGINAL, GROUP, { side: OTHER_SIDE })).toBe(true);
    expect(maps()).toEqual(before);
    expect(module.__mapRoomForTest(NEW_ROOM, GROUP.toUpperCase(), { side: OTHER_SIDE })).toBe(true);
    expect(module.__roomForGroupForTest(GROUP.toUpperCase(), OTHER_SIDE)).toBe(NEW_ROOM);
    expect(module.__roomForGroupForTest(GROUP, OTHER_SIDE)).toBe(ORIGINAL);
    expect(conflicts()).toEqual([]);
  });

  test('mixed-case home-server configuration retains bare collision protection', async () => {
    const oldRoom = `!old:${HOME}`;
    const newRoom = `!new:${HOME}`;
    process.env.MATRIX_SERVER_NAME = HOME.toUpperCase();
    writeFileSync(stateFile, JSON.stringify({
      roomGroupMap: { [oldRoom]: GROUP }, groupRoomMap: { [GROUP]: oldRoom },
      trustedManagedRooms: { [oldRoom]: {}, [newRoom]: {} },
    }));
    vi.resetModules();
    module = await import('../bridge-matrix.js');
    Object.setPrototypeOf(bridge, module.MatrixBridge.prototype);
    const before = maps();
    expect(bridge.sideForRoom(newRoom)).toBeNull();
    await bridge.onRoomEvent(newRoom, nameEvent());
    expect(maps()).toEqual(before);
    expect(conflicts()).toMatchObject([{ side: null, fromRoom: oldRoom, toRoom: newRoom }]);
  });

  test('successful rename removes only the prior same-room side aliases', () => {
    const state = module.bridgeStateForTest();
    state.groupRoomMap = {
      'Old@other.example': ORIGINAL, 'Old@Other.Example': ORIGINAL,
      'Old@different.example': NEW_ROOM, 'Other@other.example': NEW_ROOM,
    };
    state.roomGroupMap = { [ORIGINAL]: 'Old@other.example', [NEW_ROOM]: 'Old@different.example' };
    expect(module.__mapRoomForTest(ORIGINAL, 'New', { side: OTHER_SIDE })).toBe(true);
    expect(module.__roomForGroupForTest('Old', OTHER_SIDE)).toBeNull();
    expect(maps()).toEqual({
      groupRoomMap: {
        'New@other.example': ORIGINAL,
        'Old@different.example': NEW_ROOM, 'Other@other.example': NEW_ROOM,
      },
      roomGroupMap: { [ORIGINAL]: 'New@other.example', [NEW_ROOM]: 'Old@different.example' },
    });
    expect(persistedMaps()).toEqual(maps());
  });

  test('unmap removes same-room aliases without deleting another room or side', () => {
    const state = module.bridgeStateForTest();
    state.groupRoomMap = {
      'Old@other.example': ORIGINAL, 'Old@Other.Example': ORIGINAL,
      'Old@OTHER.EXAMPLE': NEW_ROOM, 'Old@different.example': NEW_ROOM,
    };
    state.roomGroupMap = { [ORIGINAL]: 'Old@other.example', [NEW_ROOM]: 'Old@OTHER.EXAMPLE' };
    expect(module.__unmapRoomForTest(ORIGINAL)).toBe('Old@other.example');
    expect(module.__roomForGroupForTest('Old', OTHER_SIDE)).toBe(NEW_ROOM);
    expect(maps()).toEqual({
      groupRoomMap: { 'Old@OTHER.EXAMPLE': NEW_ROOM, 'Old@different.example': NEW_ROOM },
      roomGroupMap: { [NEW_ROOM]: 'Old@OTHER.EXAMPLE' },
    });
    expect(persistedMaps()).toEqual(maps());
  });
});
