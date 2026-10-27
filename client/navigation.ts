import type { ComponentType } from 'react';
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { OVERVIEW_SCREEN, type Range } from './range.ts';

// Structural types let the 0.10 compiler load this module without 0.11-only exports.
export type OverviewScreenProps = PluginSurfaceProps & { params: Record<string, string> };
export type SidebarProps = Pick<PluginSurfaceProps, 'theme' | 'layout'> & {
  currentScreen: { screenId: string } | null;
  openScreen(input: { screenId: string; params?: Record<string, string> }): void;
};
type LegacyNavigation = {
  addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): unknown;
  addSidebarItem(item: { id: string; title: string; icon: string; surface: string }): unknown;
  openSurface(id: string): void;
};
type ScreenNavigation = {
  addScreen(item: { id: string; title(params: Record<string, string>): string; Component: ComponentType<OverviewScreenProps> }): unknown;
  addSidebarFooterItem(item: { id: string; title: string; Component: ComponentType<SidebarProps> }): unknown;
  openScreen(input: { screenId: string; params?: Record<string, string> }): void;
};

export function registerOverview(client: LegacyNavigation, components: {
  Screen: ComponentType<OverviewScreenProps>;
  Surface: ComponentType<PluginSurfaceProps>;
  Sidebar: ComponentType<SidebarProps>;
}): { open(range?: Range): void } {
  const screens = client as LegacyNavigation & Partial<ScreenNavigation>;
  if (typeof screens.addScreen === 'function' && typeof screens.addSidebarFooterItem === 'function' && typeof screens.openScreen === 'function') {
    screens.addScreen({ id: OVERVIEW_SCREEN,
      title: () => 'TokenLedger Canary Overview',
      Component: components.Screen });
    screens.addSidebarFooterItem({ id: 'ledger-today', title: 'TokenLedger Canary', Component: components.Sidebar });
    return { open: range => screens.openScreen!({ screenId: OVERVIEW_SCREEN, ...(range ? { params: { range } } : {}) }) };
  }
  client.addSurface(OVERVIEW_SCREEN, components.Surface);
  client.addSidebarItem({ id: OVERVIEW_SCREEN, title: 'TokenLedger Canary Overview', icon: 'Coins', surface: OVERVIEW_SCREEN });
  return { open: () => client.openSurface(OVERVIEW_SCREEN) };
}
