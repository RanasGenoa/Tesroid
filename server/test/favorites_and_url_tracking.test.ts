import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientProtocol } from '../../client/src/transport/protocol.js';
import { AuthService } from '../src/auth.js';
import { BrowserManager } from '../src/browser/manager.js';
import {
  ConfigStore,
  DEFAULT_FAVORITES,
  DEFAULT_HOME_FAVORITE_ID,
  type FavoriteItem,
  pinHomeFavoriteFirst,
  resolveHomeUrl,
} from '../src/config.js';
import { LockoutManager } from '../src/lockout.js';
import { registerBrowserRoutes } from '../src/routes/browser.js';
import { registerSettingsRoutes } from '../src/routes/settings.js';
import { WebSocketHandler } from '../src/ws/handler.js';
import { WSS_CHANNEL } from '../src/ws/protocol.js';

function parseControlMessages(packets: Buffer[]): any[] {
  return packets
    .filter((p) => p[0] === WSS_CHANNEL.CONTROL_RESPONSE)
    .map((p) => JSON.parse(p.subarray(1).toString('utf-8')));
}

describe('Favorites, Home Presets & Real-Time URL/Title Tracking (Issue #49)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-issue49-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('ConfigStore & Preset Favorites', () => {
    it('seeds all 11 default preset favorites in exact order with youtube as default home', () => {
      expect(DEFAULT_HOME_FAVORITE_ID).toBe('youtube');
      expect(DEFAULT_FAVORITES).toHaveLength(11);
      expect(DEFAULT_FAVORITES[0].id).toBe(DEFAULT_HOME_FAVORITE_ID);
      expect(DEFAULT_FAVORITES.map((f) => f.id)).toEqual([
        'youtube',
        'tver',
        'primevideo',
        'netflix',
        'abema',
        'disneyplus',
        'unext',
        'dazn',
        'nicovideo',
        'twitch',
        'google',
      ]);
      expect(DEFAULT_FAVORITES[0]).toEqual({
        id: 'youtube',
        title: 'YouTube',
        url: 'https://www.youtube.com',
      });
      expect(DEFAULT_FAVORITES[1]).toEqual({
        id: 'tver',
        title: 'TVer',
        url: 'https://tver.jp',
      });
      expect(DEFAULT_FAVORITES[2]).toEqual({
        id: 'primevideo',
        title: 'Prime Video',
        url: 'https://www.amazon.co.jp/primevideo',
      });
      expect(DEFAULT_FAVORITES[8]).toEqual({
        id: 'nicovideo',
        title: 'ニコニコ動画',
        url: 'https://www.nicovideo.jp',
      });
      expect(DEFAULT_FAVORITES[10]).toEqual({
        id: 'google',
        title: 'Google 検索',
        url: 'https://www.google.com',
      });

      const store = new ConfigStore(tmpDir);
      const cfg = store.getConfig();
      expect(cfg.favorites).toEqual(DEFAULT_FAVORITES);
      expect(cfg.homeFavoriteId).toBe('youtube');
      expect(resolveHomeUrl(cfg)).toBe('https://www.youtube.com');

      // getConfig() returns deep-cloned favorites array
      cfg.favorites[0].title = 'Mutated';
      expect(store.getConfig().favorites[0].title).toBe('YouTube');
    });

    it('persists custom favorites & homeFavoriteId, preserves supplied order, pins only on home-only update, and clones updates', () => {
      const store = new ConfigStore(tmpDir);
      const custom: FavoriteItem[] = [
        { id: 'tver', title: 'TVer', url: 'https://tver.jp' },
        { id: 'abema', title: 'ABEMA', url: 'https://abema.tv' },
      ];

      store.updateConfig({ favorites: custom, homeFavoriteId: 'abema' });
      // Mutating caller array must not mutate stored config
      custom[1].title = 'Mutated After Update';

      const reloaded = new ConfigStore(tmpDir);
      expect(reloaded.getConfig().favorites).toEqual([
        { id: 'tver', title: 'TVer', url: 'https://tver.jp' },
        { id: 'abema', title: 'ABEMA', url: 'https://abema.tv' },
      ]);
      expect(reloaded.getConfig().homeFavoriteId).toBe('abema');
      expect(resolveHomeUrl(reloaded.getConfig())).toBe('https://abema.tv');

      // Pure homeFavoriteId update (without favorites) moves new Home to index 0
      reloaded.updateConfig({ homeFavoriteId: 'abema' });
      expect(reloaded.getConfig().favorites).toEqual([
        { id: 'abema', title: 'ABEMA', url: 'https://abema.tv' },
        { id: 'tver', title: 'TVer', url: 'https://tver.jp' },
      ]);
    });

    it('migrates legacy config.json missing favorites, preserves explicit empty [], and filters invalid entries', () => {
      const legacyDir = path.join(tmpDir, 'legacy');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyDir, 'config.json'),
        JSON.stringify({ isSetupCompleted: true, displayScale: 120 }),
        'utf-8',
      );
      const legacyStore = new ConfigStore(legacyDir);
      expect(legacyStore.getConfig().favorites).toEqual(DEFAULT_FAVORITES);
      expect(legacyStore.getConfig().homeFavoriteId).toBe('youtube');

      // Explicit empty array [] must stay empty rather than re-seeding defaults
      const emptyDir = path.join(tmpDir, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });
      fs.writeFileSync(
        path.join(emptyDir, 'config.json'),
        JSON.stringify({ favorites: [], homeFavoriteId: 'youtube' }),
        'utf-8',
      );
      const emptyStore = new ConfigStore(emptyDir);
      expect(emptyStore.getConfig().favorites).toEqual([]);
      expect(emptyStore.getConfig().homeFavoriteId).toBe('youtube');
      expect(resolveHomeUrl(emptyStore.getConfig())).toBe('https://www.youtube.com');

      // Corrupted items inside array are sanitized out and stale homeFavoriteId falls back to first valid item
      const dirtyDir = path.join(tmpDir, 'dirty');
      fs.mkdirSync(dirtyDir, { recursive: true });
      fs.writeFileSync(
        path.join(dirtyDir, 'config.json'),
        JSON.stringify({
          favorites: [
            { id: 'bad-js', title: 'Evil', url: 'javascript:alert(1)' },
            { id: 'bad-file', title: 'Local', url: 'file:///etc/passwd' },
            { id: '', title: 'NoId', url: 'https://example.com' },
            { id: 'tver', title: ' TVer ', url: ' https://tver.jp ' },
            { id: 'tver', title: 'Duplicate', url: 'https://duplicate.example.com' },
          ],
          homeFavoriteId: 'deleted-id',
        }),
        'utf-8',
      );
      const dirtyStore = new ConfigStore(dirtyDir);
      expect(dirtyStore.getConfig().favorites).toEqual([
        { id: 'tver', title: 'TVer', url: 'https://tver.jp' },
      ]);
      expect(dirtyStore.getConfig().homeFavoriteId).toBe('tver');
    });

    it('resolveHomeUrl resolves matched home, falls back to first favorite, and defaults to YouTube when unsafe/empty', () => {
      expect(
        resolveHomeUrl({
          favorites: [
            { id: 'a', title: 'A', url: 'https://tver.jp' },
            { id: 'b', title: 'B', url: 'https://abema.tv' },
          ],
          homeFavoriteId: 'b',
        }),
      ).toBe('https://abema.tv');

      expect(
        resolveHomeUrl({
          favorites: [{ id: 'a', title: 'A', url: 'https://tver.jp' }],
          homeFavoriteId: 'missing',
        }),
      ).toBe('https://tver.jp');

      expect(
        resolveHomeUrl({
          favorites: [{ id: 'bad', title: 'Bad', url: 'javascript:alert(1)' }],
          homeFavoriteId: 'bad',
        }),
      ).toBe('https://www.youtube.com');

      expect(resolveHomeUrl({ favorites: [], homeFavoriteId: 'youtube' })).toBe(
        'https://www.youtube.com',
      );
    });

    it('preserves custom favorites order on ConfigStore load when homeFavoriteId is at index > 0 and still resolves homeUrl', () => {
      const unpinnedDir = path.join(tmpDir, 'unpinned');
      fs.mkdirSync(unpinnedDir, { recursive: true });
      fs.writeFileSync(
        path.join(unpinnedDir, 'config.json'),
        JSON.stringify({
          favorites: [
            { id: 'tver', title: 'TVer', url: 'https://tver.jp' },
            { id: 'primevideo', title: 'Prime Video', url: 'https://www.amazon.co.jp/primevideo' },
            { id: 'abema', title: 'ABEMA', url: 'https://abema.tv' },
            { id: 'youtube', title: 'YouTube', url: 'https://www.youtube.com' },
          ],
          homeFavoriteId: 'abema',
        }),
        'utf-8',
      );

      const store = new ConfigStore(unpinnedDir);
      expect(store.getConfig().homeFavoriteId).toBe('abema');
      expect(store.getConfig().favorites.map((f) => f.id)).toEqual([
        'tver',
        'primevideo',
        'abema',
        'youtube',
      ]);
      expect(resolveHomeUrl(store.getConfig())).toBe('https://abema.tv');
    });

    it('pinHomeFavoriteFirst clones each FavoriteItem so mutating the output does not mutate caller objects', () => {
      const input: FavoriteItem[] = [
        { id: 'tver', title: 'TVer', url: 'https://tver.jp' },
        { id: 'abema', title: 'ABEMA', url: 'https://abema.tv' },
        { id: 'youtube', title: 'YouTube', url: 'https://www.youtube.com' },
      ];

      // Case 1: home item moved from idx > 0 to index 0
      const pinned = pinHomeFavoriteFirst(input, 'abema');
      expect(pinned.map((f) => f.id)).toEqual(['abema', 'tver', 'youtube']);
      for (let i = 0; i < pinned.length; i++) {
        expect(input.includes(pinned[i])).toBe(false);
      }
      pinned[0].title = 'Mutated ABEMA';
      pinned[1].title = 'Mutated TVer';
      expect(input[1].title).toBe('ABEMA');
      expect(input[0].title).toBe('TVer');

      // Case 2: idx <= 0 (already first or missing) still returns cloned item objects
      const unchanged = pinHomeFavoriteFirst(input, 'tver');
      expect(unchanged.map((f) => f.id)).toEqual(['tver', 'abema', 'youtube']);
      expect(unchanged[0]).not.toBe(input[0]);
      unchanged[0].title = 'Mutated First';
      expect(input[0].title).toBe('TVer');

      const missing = pinHomeFavoriteFirst(input, 'nonexistent');
      expect(missing.map((f) => f.id)).toEqual(['tver', 'abema', 'youtube']);
      expect(missing[2]).not.toBe(input[2]);
      missing[2].title = 'Mutated Missing';
      expect(input[2].title).toBe('YouTube');
    });
  });

  describe('REST API (/api/settings & /api/browser/status)', () => {
    let app: FastifyInstance;
    let configStore: ConfigStore;
    let token: string;
    let bm: BrowserManager;

    beforeEach(async () => {
      configStore = new ConfigStore(tmpDir);
      const lockout = new LockoutManager(tmpDir);
      const auth = new AuthService(configStore, lockout);
      await auth.setPin('1234');
      const res = await auth.verifyPin('1234');
      if (!res.token) throw new Error('Expected auth token');
      token = res.token;

      bm = new BrowserManager({ profileDir: path.join(tmpDir, 'profile') });
      bm.updatePageInfo('https://tver.jp/live', 'TVer ライブ配信');

      app = fastify();
      registerSettingsRoutes(app, configStore, auth, bm);
      registerBrowserRoutes(app, bm, auth);
      await app.ready();
    });

    afterEach(async () => {
      bm.stop();
      await app.close();
    });

    it('GET /api/settings & GET /api/browser/status include favorites, homeFavoriteId, homeUrl, browserUrl, and browserTitle', async () => {
      const settingsRes = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(settingsRes.statusCode).toBe(200);
      const settingsBody = settingsRes.json();
      expect(settingsBody.favorites).toEqual(DEFAULT_FAVORITES);
      expect(settingsBody.homeFavoriteId).toBe('youtube');
      expect(settingsBody.homeUrl).toBe('https://www.youtube.com');
      expect(settingsBody.browserUrl).toBe('https://tver.jp/live');
      expect(settingsBody.browserTitle).toBe('TVer ライブ配信');

      const statusRes = await app.inject({ method: 'GET', url: '/api/browser/status' });
      expect(statusRes.statusCode).toBe(200);
      const statusBody = statusRes.json();
      expect(statusBody.url).toBe('https://tver.jp/live');
      expect(statusBody.title).toBe('TVer ライブ配信');
    });

    it('PUT /api/settings supports adding, updating, reordering, changing home, auto-fallback, and resetting favorites', async () => {
      const authHeaders = { authorization: `Bearer ${token}` };

      // Reorder and add custom favorite + set it as home
      const customList: FavoriteItem[] = [
        { id: 'custom-1', title: ' My Stream ', url: ' https://example.com/watch ' },
        { id: 'tver', title: 'TVer', url: 'https://tver.jp' },
      ];
      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: authHeaders,
        payload: { favorites: customList, homeFavoriteId: 'custom-1' },
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json().settings.favorites).toEqual([
        { id: 'custom-1', title: 'My Stream', url: 'https://example.com/watch' },
        { id: 'tver', title: 'TVer', url: 'https://tver.jp' },
      ]);
      expect(putRes.json().settings.homeFavoriteId).toBe('custom-1');

      // Remove current home favorite without specifying homeFavoriteId -> auto-fallback to remaining first item
      const removeHomeRes = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: authHeaders,
        payload: { favorites: [{ id: 'tver', title: 'TVer', url: 'https://tver.jp' }] },
      });
      expect(removeHomeRes.statusCode).toBe(200);
      expect(removeHomeRes.json().settings.homeFavoriteId).toBe('tver');

      // Verify GET /api/settings reflects updated homeUrl
      const getAfter = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: authHeaders,
      });
      expect(getAfter.json().homeUrl).toBe('https://tver.jp');

      // Reset to defaults via resetFavorites: true
      const resetRes = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: authHeaders,
        payload: { resetFavorites: true },
      });
      expect(resetRes.statusCode).toBe(200);
      expect(resetRes.json().settings.favorites).toEqual(DEFAULT_FAVORITES);
      expect(resetRes.json().settings.homeFavoriteId).toBe(DEFAULT_HOME_FAVORITE_ID);

      // Updating homeFavoriteId only (without passing favorites) moves the new Home favorite to index 0
      const homeOnlyRes = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: authHeaders,
        payload: { homeFavoriteId: 'primevideo' },
      });
      expect(homeOnlyRes.statusCode).toBe(200);
      expect(homeOnlyRes.json().settings.homeFavoriteId).toBe('primevideo');
      expect(homeOnlyRes.json().settings.favorites[0].id).toBe('primevideo');
      expect(
        homeOnlyRes
          .json()
          .settings.favorites.slice(0, 4)
          .map((f: FavoriteItem) => f.id),
      ).toEqual(['primevideo', 'youtube', 'tver', 'netflix']);

      // Updating favorites + homeFavoriteId preserves the exact supplied order without re-pinning
      const bothRes = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: authHeaders,
        payload: {
          favorites: [
            { id: 'tver', title: 'TVer', url: 'https://tver.jp' },
            { id: 'abema', title: 'ABEMA', url: 'https://abema.tv' },
            { id: 'youtube', title: 'YouTube', url: 'https://www.youtube.com' },
          ],
          homeFavoriteId: 'abema',
        },
      });
      expect(bothRes.statusCode).toBe(200);
      expect(bothRes.json().settings.homeFavoriteId).toBe('abema');
      expect(bothRes.json().settings.favorites.map((f: FavoriteItem) => f.id)).toEqual([
        'tver',
        'abema',
        'youtube',
      ]);

      // Reordering favorites when Home is moved off index 0 preserves order across GET, disk reload, and delete of non-home item
      const reorderRes = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: authHeaders,
        payload: {
          favorites: [
            { id: 'tver', title: 'TVer', url: 'https://tver.jp' },
            { id: 'youtube', title: 'YouTube', url: 'https://www.youtube.com' },
            { id: 'abema', title: 'ABEMA', url: 'https://abema.tv' },
          ],
        },
      });
      expect(reorderRes.statusCode).toBe(200);
      expect(reorderRes.json().settings.homeFavoriteId).toBe('abema');
      expect(reorderRes.json().settings.favorites.map((f: FavoriteItem) => f.id)).toEqual([
        'tver',
        'youtube',
        'abema',
      ]);

      const getReordered = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: authHeaders,
      });
      expect(getReordered.json().homeFavoriteId).toBe('abema');
      expect(getReordered.json().homeUrl).toBe('https://abema.tv');
      expect(getReordered.json().favorites.map((f: FavoriteItem) => f.id)).toEqual([
        'tver',
        'youtube',
        'abema',
      ]);

      const reloadedStore = new ConfigStore(tmpDir);
      expect(reloadedStore.getConfig().favorites.map((f) => f.id)).toEqual([
        'tver',
        'youtube',
        'abema',
      ]);
      expect(reloadedStore.getConfig().homeFavoriteId).toBe('abema');
      expect(resolveHomeUrl(reloadedStore.getConfig())).toBe('https://abema.tv');

      // Deleting non-home item while Home is at index > 0 preserves order and homeFavoriteId
      const deleteNonHomeRes = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: authHeaders,
        payload: {
          favorites: [
            { id: 'youtube', title: 'YouTube', url: 'https://www.youtube.com' },
            { id: 'abema', title: 'ABEMA', url: 'https://abema.tv' },
          ],
          homeFavoriteId: 'abema',
        },
      });
      expect(deleteNonHomeRes.statusCode).toBe(200);
      expect(deleteNonHomeRes.json().settings.homeFavoriteId).toBe('abema');
      expect(deleteNonHomeRes.json().settings.favorites.map((f: FavoriteItem) => f.id)).toEqual([
        'youtube',
        'abema',
      ]);
    });

    it('PUT /api/settings rejects unsafe URLs, malformed items, duplicate IDs, >100 items, and invalid homeFavoriteId with HTTP 400', async () => {
      const authHeaders = { authorization: `Bearer ${token}` };

      for (const unsafeUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings']) {
        const res = await app.inject({
          method: 'PUT',
          url: '/api/settings',
          headers: authHeaders,
          payload: { favorites: [{ id: 'evil', title: 'Evil', url: unsafeUrl }] },
        });
        expect(res.statusCode).toBe(400);
      }

      // Duplicate ID
      const dupRes = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: authHeaders,
        payload: {
          favorites: [
            { id: 'dup', title: 'One', url: 'https://one.example.com' },
            { id: 'dup', title: 'Two', url: 'https://two.example.com' },
          ],
        },
      });
      expect(dupRes.statusCode).toBe(400);

      // Empty title
      const emptyTitleRes = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: authHeaders,
        payload: { favorites: [{ id: 'a', title: '   ', url: 'https://example.com' }] },
      });
      expect(emptyTitleRes.statusCode).toBe(400);

      // > 100 items
      const tooMany = Array.from({ length: 101 }, (_, i) => ({
        id: `fav-${i}`,
        title: `Fav ${i}`,
        url: `https://example.com/${i}`,
      }));
      const tooManyRes = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: authHeaders,
        payload: { favorites: tooMany },
      });
      expect(tooManyRes.statusCode).toBe(400);

      // Non-matching homeFavoriteId
      const badHomeRes = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: authHeaders,
        payload: { homeFavoriteId: 'non-existent-id' },
      });
      expect(badHomeRes.statusCode).toBe(400);

      // Empty homeFavoriteId
      const emptyHomeRes = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: authHeaders,
        payload: { homeFavoriteId: '   ' },
      });
      expect(emptyHomeRes.statusCode).toBe(400);

      // Original defaults must remain untouched after all 400 rejections
      expect(configStore.getConfig().favorites).toEqual(DEFAULT_FAVORITES);
      expect(configStore.getConfig().homeFavoriteId).toBe('youtube');
    });
  });

  describe('BrowserManager Real-Time Page Info & CDP Tracking', () => {
    it('tracks valid HTTP/HTTPS URL and title updates, ignores unsafe schemes, deduplicates, and notifies subscribers', async () => {
      const bm = new BrowserManager({
        profileDir: path.join(tmpDir, 'profile'),
        defaultUrl: 'https://www.youtube.com',
      });
      const events: Array<{ url: string; title: string }> = [];
      const unsubscribe = bm.onPageInfoChanged((info) => events.push(info));

      // Unsafe URLs are ignored completely
      expect(bm.updatePageInfo('chrome://settings', 'Settings')).toBe(false);
      expect(bm.updatePageInfo('javascript:alert(1)', 'XSS')).toBe(false);
      expect(bm.updatePageInfo('file:///etc/passwd', 'Secret')).toBe(false);
      expect(bm.getCurrentUrl()).toBe('https://www.youtube.com');
      expect(bm.getCurrentTitle()).toBe('');
      expect(events).toEqual([]);

      // Valid URL & title updates fire listener once
      expect(
        bm.updatePageInfo('https://www.youtube.com/watch?v=abc', '  Test Video - YouTube  '),
      ).toBe(true);
      expect(bm.getCurrentUrl()).toBe('https://www.youtube.com/watch?v=abc');
      expect(bm.getCurrentTitle()).toBe('Test Video - YouTube');
      expect(events).toEqual([
        { url: 'https://www.youtube.com/watch?v=abc', title: 'Test Video - YouTube' },
      ]);

      // Duplicate unchanged update is ignored
      expect(bm.updatePageInfo('https://www.youtube.com/watch?v=abc', 'Test Video - YouTube')).toBe(
        false,
      );
      expect(events).toHaveLength(1);

      // Title-only update works
      expect(bm.updatePageInfo(undefined, 'Updated Title')).toBe(true);
      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({
        url: 'https://www.youtube.com/watch?v=abc',
        title: 'Updated Title',
      });

      // navigate() updates currentUrl and clears stale title when moving to a new URL
      vi.spyOn(bm as any, 'navigateViaCdp').mockResolvedValue(true);
      await bm.navigate('https://tver.jp');
      expect(bm.getCurrentUrl()).toBe('https://tver.jp');
      expect(bm.getCurrentTitle()).toBe('');
      expect(events[2]).toEqual({ url: 'https://tver.jp', title: '' });

      unsubscribe();
      expect(bm.updatePageInfo('https://abema.tv', 'ABEMA')).toBe(true);
      expect(events).toHaveLength(3); // unsubscribed listener not called
      bm.stop();
    });

    it('processes CDP Page.frameNavigated, Page.navigatedWithinDocument (+400ms SPA title recheck), and fallback /json/list poll', async () => {
      vi.useFakeTimers();
      const bm = new BrowserManager({ profileDir: path.join(tmpDir, 'profile') });
      const events: Array<{ url: string; title: string }> = [];
      bm.onPageInfoChanged((info) => events.push(info));

      (bm as any).isPageMonitorStopped = false;
      (bm as any).chromeProcess = { pid: 1234, exitCode: null };
      (bm as any).state = 'running';

      const sentCdpCommands: Array<{ id: number; method: string; params: any }> = [];
      const mockWs: any = {
        readyState: 1, // WebSocket.OPEN
        send: vi.fn((raw: string) => {
          sentCdpCommands.push(JSON.parse(raw));
        }),
        removeAllListeners: vi.fn(),
        close: vi.fn(),
      };
      (bm as any).pageMonitorWs = mockWs;

      // 1. Subframe navigation (has parentId) should NOT trigger Runtime.evaluate
      (bm as any).handlePageMonitorMessage(
        mockWs,
        JSON.stringify({
          method: 'Page.frameNavigated',
          params: { frame: { parentId: 'root-frame', url: 'https://ads.example.com' } },
        }),
      );
      expect(sentCdpCommands).toHaveLength(0);

      // 2. Top-level frame navigation triggers URL update & Runtime.evaluate
      (bm as any).handlePageMonitorMessage(
        mockWs,
        JSON.stringify({
          method: 'Page.frameNavigated',
          params: { frame: { url: 'https://www.youtube.com/watch?v=1' } },
        }),
      );
      expect(bm.getCurrentUrl()).toBe('https://www.youtube.com/watch?v=1');
      expect(sentCdpCommands).toHaveLength(1);
      expect(sentCdpCommands[0].method).toBe('Runtime.evaluate');

      // Simulate Runtime.evaluate response
      (bm as any).handlePageMonitorMessage(
        mockWs,
        JSON.stringify({
          id: sentCdpCommands[0].id,
          result: {
            result: { value: { url: 'https://www.youtube.com/watch?v=1', title: 'Initial Video' } },
          },
        }),
      );
      expect(bm.getCurrentTitle()).toBe('Initial Video');

      // 3. Page.loadEventFired & Page.domContentEventFired also trigger Runtime.evaluate
      sentCdpCommands.length = 0;
      (bm as any).handlePageMonitorMessage(
        mockWs,
        JSON.stringify({ method: 'Page.domContentEventFired' }),
      );
      (bm as any).handlePageMonitorMessage(
        mockWs,
        JSON.stringify({ method: 'Page.loadEventFired' }),
      );
      expect(sentCdpCommands).toHaveLength(2);
      expect(sentCdpCommands.every((c) => c.method === 'Runtime.evaluate')).toBe(true);

      // 4. SPA navigation (YouTube watch click) triggers immediate + 400ms delayed check
      sentCdpCommands.length = 0;
      (bm as any).handlePageMonitorMessage(
        mockWs,
        JSON.stringify({
          method: 'Page.navigatedWithinDocument',
          params: { url: 'https://www.youtube.com/watch?v=2' },
        }),
      );
      expect(bm.getCurrentUrl()).toBe('https://www.youtube.com/watch?v=2');
      expect(sentCdpCommands).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(450);
      expect(sentCdpCommands).toHaveLength(2);

      // Simulate delayed SPA title response
      (bm as any).handlePageMonitorMessage(
        mockWs,
        JSON.stringify({
          id: sentCdpCommands[1].id,
          result: {
            result: { value: { url: 'https://www.youtube.com/watch?v=2', title: 'SPA Video 2' } },
          },
        }),
      );
      expect(bm.getCurrentTitle()).toBe('SPA Video 2');

      // 4. Fallback /json/list poll updates URL & title if CDP events were missed
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          json: async () => [
            {
              type: 'page',
              url: 'https://abema.tv/now-on-air/abema-news',
              title: 'ABEMA NEWS',
              webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
            },
          ],
        })),
      );
      (bm as any).pageMonitorTargetWsUrl = 'ws://127.0.0.1:9222/devtools/page/1';
      await (bm as any).pollPageInfoFromJsonList();
      expect(bm.getCurrentUrl()).toBe('https://abema.tv/now-on-air/abema-news');
      expect(bm.getCurrentTitle()).toBe('ABEMA NEWS');

      bm.stop();
      expect(mockWs.close).toHaveBeenCalled();
    });
  });

  describe('WebSocketHandler BROWSER_STATUS Broadcasts', () => {
    it('sends BROWSER_STATUS with url and title on auth, broadcasts on pageInfoChanged, and cleans up on close()', async () => {
      const configStore = new ConfigStore(tmpDir);
      const lockout = new LockoutManager(tmpDir);
      const auth = new AuthService(configStore, lockout);
      await auth.setPin('1234');

      const bm = new BrowserManager({
        profileDir: path.join(tmpDir, 'profile'),
        defaultUrl: 'https://www.youtube.com',
      });
      bm.updatePageInfo('https://www.youtube.com', 'YouTube');
      vi.spyOn(bm, 'isChromeAlive').mockReturnValue(true);
      vi.spyOn(bm, 'navigate').mockImplementation(async (url: string) => {
        bm.updatePageInfo(url, '');
      });

      const mockEncoder: any = {
        isRunning: vi.fn(() => true),
        start: vi.fn(),
        stop: vi.fn(),
        restart: vi.fn(async () => {}),
        getCachedKeyframe: vi.fn(() => null),
        getCachedSpsPps: vi.fn(() => null),
        getCachedOpusHead: vi.fn(() => null),
        on: vi.fn(),
      };
      const mockInput: any = {};

      const handler = new WebSocketHandler(auth, bm, mockEncoder, mockInput, configStore);

      const sentPackets: Buffer[] = [];
      const listeners = new Map<string, (...args: any[]) => any>();
      const mockSocket: any = {
        readyState: 1,
        send: vi.fn((data: Buffer | Uint8Array) => sentPackets.push(Buffer.from(data))),
        on: vi.fn((ev: string, cb: (...args: any[]) => any) => listeners.set(ev, cb)),
      };

      handler.handleConnection(mockSocket);
      const onMessage = listeners.get('message');
      expect(onMessage).toBeDefined();
      if (!onMessage) throw new Error('Expected message listener');
      await onMessage(ClientProtocol.packAuth('1234'), true);

      const authStatusMsgs = parseControlMessages(sentPackets).filter(
        (m) => m.type === 'BROWSER_STATUS',
      );
      expect(authStatusMsgs).toHaveLength(1);
      expect(authStatusMsgs[0]).toMatchObject({
        type: 'BROWSER_STATUS',
        url: 'https://www.youtube.com',
        title: 'YouTube',
        dimensions: { width: 1280, height: 720 },
      });

      // Live CDP page update triggers immediate BROWSER_STATUS broadcast with title
      sentPackets.length = 0;
      bm.updatePageInfo('https://www.youtube.com/watch?v=xyz', 'Awesome Tesla Video');
      const liveMsgs = parseControlMessages(sentPackets).filter((m) => m.type === 'BROWSER_STATUS');
      expect(liveMsgs).toHaveLength(1);
      expect(liveMsgs[0]).toMatchObject({
        type: 'BROWSER_STATUS',
        url: 'https://www.youtube.com/watch?v=xyz',
        title: 'Awesome Tesla Video',
      });

      // NAVIGATE command emits BROWSER_STATUS with url & title
      sentPackets.length = 0;
      await onMessage(
        ClientProtocol.packCommand({ type: 'NAVIGATE', url: 'https://tver.jp' }),
        true,
      );
      const navMsgs = parseControlMessages(sentPackets).filter((m) => m.type === 'BROWSER_STATUS');
      expect(navMsgs.some((m) => m.url === 'https://tver.jp' && m.title === '')).toBe(true);

      // Closing handler unsubscribes from BrowserManager updates
      handler.close();
      sentPackets.length = 0;
      bm.updatePageInfo('https://abema.tv', 'ABEMA');
      expect(sentPackets).toHaveLength(0);

      bm.stop();
    });
  });
});
