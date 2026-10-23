import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerOverview } from '../client/navigation.ts';

const components = { Screen: () => null, Surface: () => null, Sidebar: () => null };
test('Paseo 0.10 registers and opens the legacy overview without calling screen APIs', () => {
  const calls: unknown[] = [];
  const navigation = registerOverview({
    addSurface: (...args) => calls.push(['surface', ...args]),
    addSidebarItem: item => calls.push(['sidebar', item]),
    openSurface: id => { calls.push(['open', id]); },
  }, components);
  navigation.open('7d');
  assert.deepEqual(calls, [
    ['surface', 'ledger-overview', components.Surface],
    ['sidebar', { id: 'ledger-overview', title: 'TokenLedger Canary Overview', icon: 'Coins', surface: 'ledger-overview' }],
    ['open', 'ledger-overview'],
  ]);
});

test('Paseo 0.11 keeps screen range params and the live footer instead of legacy surfaces', () => {
  const calls: unknown[] = [];
  let title: ((params: Record<string, string>) => string) | undefined;
  const legacy = () => { throw new Error('legacy API called on a screen-capable host'); };
  const client = {
    addSurface: legacy, addSidebarItem: legacy, openSurface: legacy,
    addScreen: (item: { id: string; title(params: Record<string, string>): string }) => { title = item.title; calls.push(['screen', item.id]); },
    addSidebarFooterItem: (item: { id: string }) => { calls.push(['footer', item.id]); },
    openScreen: (input: object) => { calls.push(['open', input]); },
  };
  const navigation = registerOverview(client, components);
  navigation.open(); navigation.open('today');
  assert.deepEqual(calls, [['screen', 'ledger-overview'], ['footer', 'ledger-today'],
    ['open', { screenId: 'ledger-overview' }], ['open', { screenId: 'ledger-overview', params: { range: 'today' } }]]);
  assert.equal(title!({ range: '7d' }), 'TokenLedger Canary · Last 7 days');
  assert.equal(title!({ range: 'invalid' }), 'TokenLedger Canary · All time');
});
