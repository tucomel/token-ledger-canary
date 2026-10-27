import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import { createElement, type ComponentType } from 'react';
import ts from 'typescript';
import { rangeStart } from '../client/range.ts';
import * as ranges from '../client/range.ts';
import type { OverviewScreenProps } from '../client/navigation.ts';

const require = createRequire(import.meta.url);
const { act, create } = require('react-test-renderer');

test('period buttons update the mounted overview without adding navigation leaves, on desktop and compact layouts', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    for (const compact of [false, true]) {
      let since: string | null = null;
      const imports: Record<string, unknown> = {
        './layout.ts': { useDenseLayout: (value: boolean) => ({ dense: value, setWidth: () => {} }) },
        '@getpaseo/plugin/client/react-native': { ScrollView: 'ScrollView' },
        'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View' },
        './data.ts': { useOverview: (value: string | null) => {
          since = value;
          return { data: { groups: [], totals: {} }, error: null };
        } },
        './ui.tsx': { SummaryRow: 'SummaryRow', UsageCoverageNote: 'UsageCoverageNote' },
        './range.ts': ranges,
      };
      // Render the production TSX with React; only host primitives and RPC data are stubbed.
      const source = readFileSync(new URL('../client/overview.tsx', import.meta.url), 'utf8');
      const code = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020,
      } }).outputText;
      const module = { exports: {} as Record<string, unknown> };
      new Function('require', 'module', 'exports', code)(
        (id: string) => id in imports ? imports[id] : require(id), module, module.exports,
      );
      const Overview = module.exports.TokenLedgerOverview as ComponentType<OverviewScreenProps>;
      let leaves = 1;
      const props = {
        theme: { colors: { surface0: '#111', foreground: '#eee', foregroundMuted: '#aaa' } },
        layout: { compact, platform: 'web' }, params: { range: 'today' },
        // Regression trap: the old component delegated every period click to openScreen.
        onRange: () => { leaves++; },
      } as unknown as OverviewScreenProps;
      let view: ReturnType<typeof create>;
      await act(async () => { view = create(createElement(Overview, props)); });
      try {
        for (const [range, label] of [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'All time'], ['today', 'Today']] as const) {
          const button = view!.root.findAllByType('Pressable').find((node: { findByType(type: string): { props: { children: string } } }) => node.findByType('Text').props.children === label);
          await act(async () => { button.props.onPress(); });
          assert.equal(leaves, 1, 'period selection must not create a new leaf');
          assert.equal(button.props.accessibilityState.selected, true);
          assert.equal(since, rangeStart(range), 'the ledger query must use the newly selected range');
        }
        // Opening an existing screen with other initial params still selects those params.
        await act(async () => { view!.update(createElement(Overview, { ...props, params: { range: '7d' } })); });
        assert.equal(since, rangeStart('7d'));
        assert.equal(leaves, 1);
      } finally { await act(async () => { view!.unmount(); }); }
    }
  } finally {
    if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
    else environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
