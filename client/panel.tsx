import { useDenseLayout } from "./layout.ts";
import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useLedger } from "./data.ts";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { Ctx, InFlight, TurnRow } from "../shared/ledger.ts";
import { cacheRatio } from "../shared/pricing.ts";
import {
  fmtCost,
  fmtCostSmall,
  fmtDuration,
  fmtPct,
  fmtResidual,
  fmtTime,
  fmtTokens,
  statusColor,
  SummaryRow,
  tokensLine,
  turnColumns,
  TurnTableHeader,
  UsageCoverageNote,
} from "./ui.tsx";

function useElapsed(startedAt: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return "";
  return fmtDuration(Math.max(0, now - Date.parse(startedAt)));
}

function CtxBar({ ctx, theme }: { ctx: Ctx; theme: PluginTheme }) {
  const ratio = ctx.max > 0 ? Math.min(1, ctx.used / ctx.max) : 0;
  return (
    <View style={{ gap: 4 }}>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.border, overflow: "hidden" }}>
        <View
          style={{
            width: `${Math.round(ratio * 100)}%`,
            height: 4,
            borderRadius: 2,
            backgroundColor: theme.colors.accent,
          }}
        />
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>
        context {fmtTokens(ctx.used)} / {fmtTokens(ctx.max)}
      </Text>
    </View>
  );
}

function InFlightCard({ inFlight, seq, theme }: { inFlight: InFlight; seq: number; theme: PluginTheme }) {
  const elapsed = useElapsed(inFlight.startedAt);
  const tokens = tokensLine(inFlight.input, inFlight.cached, inFlight.output, inFlight.cacheWrite);
  const pct = fmtPct(cacheRatio(inFlight.input, inFlight.cached, inFlight.cacheWrite));
  const ctx = inFlight.ctxUsed !== null && inFlight.ctxMax !== null ? { used: inFlight.ctxUsed, max: inFlight.ctxMax } : null;
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.accent,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.accent }} />
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>
          Turn #{seq} in progress
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {elapsed}
        </Text>
      </View>
      {tokens ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {tokens}
          {pct ? ` (${pct} cached)` : ""}
          {inFlight.modelCalls > 0 ? ` · ${inFlight.modelCalls} call${inFlight.modelCalls > 1 ? "s" : ""}` : ""}
        </Text>
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" }}>
          tokens & cost reported at turn end
        </Text>
      )}
      {inFlight.effectiveCostUsd !== null ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          ≈{fmtCost(inFlight.effectiveCostUsd)} current turn
        </Text>
      ) : null}
      {ctx ? <CtxBar ctx={ctx} theme={theme} /> : null}
      {inFlight.usageGap ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Connection interrupted · usage may be incomplete.</Text> : null}
    </View>
  );
}

/** One cell of the TURNS table: tokens on top, estimated cost below. */
function TurnCell({
  top,
  bottom,
  width,
  theme,
}: {
  top: string;
  bottom: string;
  width: { minWidth: number };
  theme: PluginTheme;
}) {
  return (
    <View style={{ ...width, alignItems: "flex-end" }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>{top}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontVariant: ["tabular-nums"] }}>
        {bottom}
      </Text>
    </View>
  );
}

function RecordRow({ record, theme, dense }: { record: TurnRow; theme: PluginTheme; dense: boolean }) {
  const cols = turnColumns(dense);
  const hasUsage = record.input !== null || record.cached !== null || record.output !== null || record.cacheWrite != null;
  const split = record.costBreakdown;
  const pct = fmtPct(cacheRatio(record.input, record.cached, record.cacheWrite));
  const cacheCost = split ? fmtCostSmall(split.cacheUsd) : "–";
  const costDetail =
    record.costSource === "override"
      ? "override"
      : record.costSource === "openrouter"
        ? "OR ref"
        : record.costSource === "builtin"
          ? "list"
          : record.costSource === 'mixed' ? 'mixed refs' : fmtResidual(split?.otherUsd ?? null);
  const seqWidth = dense ? 20 : 24;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: cols.gap,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <View style={{ flex: 1, minWidth: dense ? 72 : 88 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: statusColor(record.status, theme) }} />
          <Text
            style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"], minWidth: seqWidth }}
          >
            #{record.seq}
          </Text>
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>
            {fmtTime(record.endedAt)}
          </Text>
        </View>
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 10,
            fontVariant: ["tabular-nums"],
            // Align under the time text: dot(7) + gap(6) + seq col + gap(6).
            paddingLeft: 19 + seqWidth,
          }}
        >
          {fmtDuration(record.durationMs)}
            {record.usageGap ? ' · gap' : record.quality === "partial" ? " ≈" : ""}
          {record.serviceTier === 'priority' || record.serviceTier === 'fast' ? ' · Fast' : record.serviceTier === 'ultrafast' ? ' · Ultrafast' : ''}
          {record.source === 'codex_transcript' ? ' · logs' : ''}
        </Text>
        {record.accountingWarnings?.length ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
            {record.accountingWarnings.includes('cache-retention-unknown-30m-assumed') ? 'Cache writes priced at 30m retention. ' : ''}
            {record.accountingWarnings.includes('processing-tier-unknown-standard-assumed') ? 'Speed unknown; Standard assumed. ' : ''}
            {record.accountingWarnings.includes('cache-write-count-unavailable') ? 'Cache write counts unavailable. ' : ''}
            {record.accountingWarnings.some(warning => warning === 'invalid-token-sample' || warning === 'cumulative-counter-unavailable') ? 'Some usage records are incomplete.' : ''}
          </Text>
        ) : null}
      </View>
      {hasUsage ? (
        <>
          <TurnCell
            top={fmtTokens(record.input)}
            bottom={split ? fmtCostSmall(split.inUsd) : "–"}
            width={cols.in}
            theme={theme}
          />
          <View style={{ gap: 3 }}>
            <TurnCell
              top={fmtTokens(record.cached)}
              bottom={pct ? `${cacheCost}·${pct}` : cacheCost}
              width={cols.cache}
              theme={theme}
            />
            {record.cacheWrite != null ? (
              <TurnCell top={`${fmtTokens(record.cacheWrite)} write`}
                bottom={split ? fmtCostSmall(split.cacheWriteUsd ?? 0) : '–'} width={cols.cache} theme={theme} />
            ) : null}
          </View>
          <TurnCell
            top={fmtTokens(record.output)}
            bottom={split ? fmtCostSmall(split.outUsd) : "–"}
            width={cols.out}
            theme={theme}
          />
        </>
      ) : (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            fontStyle: "italic",
            minWidth: cols.in.minWidth + cols.cache.minWidth + cols.out.minWidth + cols.gap * 2,
            textAlign: "right",
          }}
        >
          usage unavailable
        </Text>
      )}
      <TurnCell
        top={`${record.costSource && record.costSource !== "reported" ? "≈" : ""}${fmtCost(record.effectiveCostUsd) ?? "–"}`}
        bottom={costDetail}
        width={cols.cost}
        theme={theme}
      />
    </View>
  );
}

export function TokenLedgerPanel({ theme, layout, agentId }: PluginAgentPanelProps) {
  const { dense, setWidth } = useDenseLayout(layout.compact);
  const { data, error } = useLedger(agentId);
  // Make the panel↔agent binding visible: which session is this ledger for?
  const agentLabel = useAgent(agentId, (agent) => {
    const name = agent.title ?? agentId.slice(0, 8);
    return agent.model ? `${name} · ${agent.model}` : name;
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: dense ? 10 : 20, gap: 14 },
      sectionLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
        letterSpacing: 0.6,
        textTransform: "uppercase" as const,
      },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme, dense],
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{String(error)}</Text> : null}
      {data ? (
        <>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              <Text style={styles.sectionLabel}>Session</Text>
              <Text numberOfLines={1} style={{ ...styles.muted, fontSize: 12, flexShrink: 1 }}>
                {agentLabel ?? agentId.slice(0, 8)}
              </Text>
            </View>
            <SummaryRow summary={data.summary} theme={theme} dense={dense} />
            <UsageCoverageNote theme={theme} />
            {!data.inFlight && data.ctx ? <CtxBar ctx={data.ctx} theme={theme} /> : null}
          </View>
          {data.inFlight ? <InFlightCard inFlight={data.inFlight} seq={data.summary.turns + 1} theme={theme} /> : null}
          <View style={{ gap: 2 }}>
            <TurnTableHeader theme={theme} dense={dense} />
            {data.records.length === 0 && !data.inFlight ? (
              <Text style={styles.muted}>
                No turns recorded yet. Usage is tracked per turn while this plugin is running.
              </Text>
            ) : (
              <>
                {data.records.map((record) => (
                  // Keyed by seq, not record.id: ids of records persisted before
                  // v0.1.x lack the endedAt component and collide across session
                  // restarts (turnId reuse), which made React render ghost rows.
                  <RecordRow key={record.seq} record={record} theme={theme} dense={dense} />
                ))}
                {data.records.some((record) => fmtResidual(record.costBreakdown?.otherUsd ?? null).trim() !== "") ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, paddingTop: 6 }}>
                    ± under COST: difference between reported cost and the token-based estimate, including charges
                    for usage Paseo does not expose.
                  </Text>
                ) : null}
                {data.records.some((record) => record.costSource && record.costSource !== "reported") ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, paddingTop: 4 }}>
                    ≈ estimated: override = local pricing.json · OR ref = OpenRouter reference · list = built-in prices.
                  </Text>
                ) : null}
                {data.records.some((record) => record.usageGap) ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, paddingTop: 4 }}>
                    gap: connection interrupted; usage may be incomplete. A missing turn outcome is recorded as unknown.
                  </Text>
                ) : null}
              </>
            )}
          </View>
        </>
      ) : (
        <Text style={styles.muted}>Loading…</Text>
      )}
    </ScrollView>
  );
}
