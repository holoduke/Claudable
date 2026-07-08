import { describe, expect, it } from 'vitest';
import { pluginContainerDir, slugify, toView, CONTAINER_PLUGINS_MOUNT } from './plugins';
import type { PluginMarketplace } from '@prisma/client';

function fakeMarketplace(over: Partial<PluginMarketplace> = {}): PluginMarketplace {
  return {
    id: 'm1', orgId: null, name: 'newstory-dev-tools', gitUrl: 'https://github.com/x/y', ref: null,
    subpath: null, tokenProvider: 'github', enabled: true, includeMcpServers: false,
    catalogJson: JSON.stringify([
      { name: 'newstory-global', source: './plugins/newstory/newstory-global' },
      { name: 'filament', source: './plugins/filament/filament' },
    ]),
    enabledPluginsJson: null, lastSyncedAt: null, lastSyncError: null, syncedRef: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  } as PluginMarketplace;
}

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('NewStory Dev_Tools!')).toBe('newstory-dev_tools');
    expect(slugify('a--b')).toBe('a-b');
  });
});

describe('pluginContainerDir', () => {
  it('joins mount + slug + normalized source', () => {
    expect(pluginContainerDir('newstory-dev-tools', null, './plugins/newstory/newstory-global'))
      .toBe(`${CONTAINER_PLUGINS_MOUNT}/newstory-dev-tools/plugins/newstory/newstory-global`);
  });

  it('handles a marketplace subpath', () => {
    expect(pluginContainerDir('mkt', 'sub/dir', 'plugins/x'))
      .toBe(`${CONTAINER_PLUGINS_MOUNT}/mkt/sub/dir/plugins/x`);
  });

  it('strips a leading source slash', () => {
    expect(pluginContainerDir('mkt', null, '/plugins/x')).toBe(`${CONTAINER_PLUGINS_MOUNT}/mkt/plugins/x`);
  });
});

describe('toView', () => {
  it('defaults enabledPlugins to the full catalog when the column is null', () => {
    const v = toView(fakeMarketplace());
    expect(v.enabledPlugins).toEqual(['newstory-global', 'filament']);
    expect(v.catalog).toHaveLength(2);
  });

  it('respects an explicit enabled set', () => {
    const v = toView(fakeMarketplace({ enabledPluginsJson: JSON.stringify(['filament']) }));
    expect(v.enabledPlugins).toEqual(['filament']);
  });

  it('tolerates a corrupt catalog', () => {
    const v = toView(fakeMarketplace({ catalogJson: '{bad' }));
    expect(v.catalog).toEqual([]);
    expect(v.enabledPlugins).toEqual([]);
  });
});
