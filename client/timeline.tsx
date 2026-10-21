import { useAgent, type PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { Text, View } from 'react-native';
import type { UsageTimeline } from '../shared/timeline.ts';
import { fmtCost, fmtDuration, tokensLine, statusColor } from './ui.tsx';
import { isTrackedProvider } from '../shared/provider-scope.ts';

/** A final summary with no ledger polling while scrolling. */
export function UsageTimelineRow({ agentId, item, theme }: PluginTimelineItemProps<UsageTimeline>) {
  const provider = useAgent(agentId, agent => agent.provider);
  const row = item.data;
  if (!isTrackedProvider(provider)) return null;
  const cost = fmtCost(row.effectiveCostUsd);
  const tokens = tokensLine(row.input, row.cached, row.output, row.cacheWrite);
  const details = [row.status === 'completed' ? null : row.status,
    row.usageGap ? 'usage gap' : null,
    tokens ? `${row.quality === 'partial' ? '≈ ' : ''}${tokens}` : 'usage unavailable',
    cost ? `${row.costSource !== 'reported' ? '≈' : ''}${cost}` : null,
    row.durationMs === null ? null : fmtDuration(row.durationMs),
  ].filter(Boolean).join(' · ');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 4 }}>
      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: statusColor(row.status, theme) }} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1, fontVariant: ['tabular-nums'] }}>
        {details}
      </Text>
    </View>
  );
}
