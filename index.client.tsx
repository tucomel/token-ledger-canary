import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TokenLedgerOverview } from "./client/overview.tsx";
import { TokenLedgerPanel } from "./client/panel.tsx";
import { contributePills } from "./client/pill.tsx";
import { registerOverview, type OverviewScreenProps } from './client/navigation.ts';
import { LedgerSidebarItem } from "./client/sidebar.tsx";

import { createPanelPlacement } from "./client/layout.ts";
import { UsageTimelineRow } from "./client/timeline.tsx";
import { UsageTimelineSchema, USAGE_TIMELINE_KIND } from "./shared/timeline.ts";
import { TokenLedgerSettings } from './client/settings.tsx';

export default function contribute(client: PluginClientContext) {
  const placement = createPanelPlacement();
  client.addSettingsScreen({ id: 'preferences', title: 'TokenLedger Canary', icon: 'Coins', Component: TokenLedgerSettings });
  client.addTimelineRenderer({ kind: USAGE_TIMELINE_KIND, version: 1, schema: UsageTimelineSchema, Component: UsageTimelineRow });
  client.addWorkspacePanel({
    id: "ledger",
    title: "TokenLedger Canary Session Ledger",
    icon: "Coins",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: TokenLedgerPanel,
  });
  function OverviewScreen(props: OverviewScreenProps) {
    return <TokenLedgerOverview {...props} />;
  }
  function OverviewSurface(props: PluginSurfaceProps) {
    return <TokenLedgerOverview {...props} params={{}} />;
  }
  const navigation = registerOverview(client, { Screen: OverviewScreen, Surface: OverviewSurface, Sidebar: LedgerSidebarItem });
  client.addCommandCenterItem({
    id: "open-ledger",
    title: "Open TokenLedger Canary Session Ledger",
    icon: "Coins",
    keywords: ["token", "usage", "cost", "ledger"],
    context: "agent",
    onSelect({ openPanel, agent }) {
      openPanel("ledger", placement.options(agent.id));
    },
  });
  client.addCommandCenterItem({
    id: "open-ledger-overview",
    title: "Open TokenLedger Canary Overview",
    icon: "Coins",
    keywords: ["token", "usage", "cost", "ledger", "overview", "all"],
    context: "global",
    onSelect() {
      navigation.open();
    },
  });
  return contributePills(client, placement);
}
