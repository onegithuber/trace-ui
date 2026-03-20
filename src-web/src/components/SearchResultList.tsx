import { useRef, useCallback, useEffect, useState, useMemo } from "react";
import { useVirtualizerNoSync } from "../hooks/useVirtualizerNoSync";
import type { SearchMatch, TraceLine } from "../types/trace";
import type { ResolvedRow } from "../hooks/useFoldState";
import DisasmHighlight from "./DisasmHighlight";
import Minimap, { MINIMAP_WIDTH } from "./Minimap";
import { useSelectedSeq } from "../stores/selectedSeqStore";
import CustomScrollbar from "./CustomScrollbar";
import { useResizableColumn } from "../hooks/useResizableColumn";
import { highlightText, highlightHexdump } from "../utils/highlightText";
import VirtualizedHighlight from "./VirtualizedHighlight";
import { findSeqIndex } from "../utils/binarySearch";

const BASE_ROW_HEIGHT = 22;
const DETAIL_LINE_HEIGHT = 16;
const DETAIL_TOP_MARGIN = 4;
const DETAIL_BOTTOM_GAP = 6;
const DETAIL_VERTICAL_PADDING = 6;
const DETAIL_BORDER = 1;
const DETAIL_INDENT = 40 + 30 + 90 + 90;
const DETAIL_LEFT_PADDING = 8 + DETAIL_INDENT;
const DETAIL_MAX_LINES = 16; // hexdump 16 行 = 256 字节

/** 检测 hidden_content 是否含有 hexdump 数据行 */
function isHexdumpContent(text: string): boolean {
  return /^[0-9a-fA-F]+:\s+([0-9a-fA-F]{2}\s)/m.test(text);
}

interface SearchResultListProps {
  matchSeqs: number[];
  getMatchDetail: (seq: number) => SearchMatch | undefined;
  selectedSeq?: number | null;
  onJumpToSeq: (seq: number) => void;
  onJumpToMatch?: (match: SearchMatch) => void;
  searchQuery?: string;
  caseSensitive?: boolean;
  fuzzy?: boolean;
  useRegex?: boolean;
  showSoName?: boolean;
  showAbsAddress?: boolean;
  addrColorHighlight?: boolean;
  requestDetails?: (seqs: number[]) => void;
  cacheVersion?: number;
}

export default function SearchResultList({
  matchSeqs,
  getMatchDetail,
  selectedSeq: selectedSeqProp,
  onJumpToSeq,
  onJumpToMatch,
  searchQuery,
  caseSensitive,
  fuzzy,
  useRegex,
  showSoName = false,
  showAbsAddress = false,
  addrColorHighlight = false,
  requestDetails,
  cacheVersion = 0,
}: SearchResultListProps) {
  const rwCol = useResizableColumn(30, "right", 20, "search:rw");
  const seqCol = useResizableColumn(90, "right", 50, "search:seq");
  const addrCol = useResizableColumn(90, "right", 50, "search:addr");
  const disasmCol = useResizableColumn(320, "right", 200);
  const beforeCol = useResizableColumn(420, "right", 40);
  const HANDLE_W = 8;

  // 地址列宽度随显示模式自适应（与 TraceTable 同步）
  const [addrWidthEstimated, setAddrWidthEstimated] = useState(false);

  useEffect(() => { setAddrWidthEstimated(false); }, [matchSeqs]);

  const formatAddr = useCallback((match: SearchMatch) => {
    const parts: string[] = [];
    if (showSoName && match.so_name) parts.push(`[${match.so_name}]`);
    if (showAbsAddress && match.address) {
      parts.push(`${match.address}!${match.so_offset}`);
    } else {
      parts.push(match.so_offset || match.address);
    }
    return parts.join(" ");
  }, [showSoName, showAbsAddress]);

  const HANDLE_STYLE: React.CSSProperties = {
    width: 8, cursor: "col-resize", flexShrink: 0, alignSelf: "stretch",
    display: "flex", alignItems: "center", justifyContent: "center",
  };

  const selectedSeqFromStore = useSelectedSeq();
  const selectedSeq = selectedSeqProp !== undefined ? selectedSeqProp : selectedSeqFromStore;

  const parentRef = useRef<HTMLDivElement>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [containerHeight, setContainerHeight] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollRow, setScrollRow] = useState(0);

  // 推式布局：与 TraceTable 一致，Disasm/Before 受容器宽度约束，Changes 吸收剩余
  const colFixedLeft = 40 + rwCol.width + HANDLE_W + seqCol.width + HANDLE_W + addrCol.width + HANDLE_W;
  const MIN_CHANGES_WIDTH = 60;
  const availableForRight = Math.max(0, containerWidth - colFixedLeft - 2 * HANDLE_W - MIN_CHANGES_WIDTH);
  const effectiveDisasmWidth = Math.max(200, Math.min(disasmCol.width, availableForRight - 40));
  const effectiveBeforeWidth = Math.max(40, Math.min(beforeCol.width, availableForRight - effectiveDisasmWidth));

  useEffect(() => {
    if (selectedSeq == null) return;
    const idx = findSeqIndex(matchSeqs, selectedSeq);
    if (idx >= 0) {
      setSelectedIdx(idx);
      virtualizer.scrollToIndex(idx, { align: "auto" });
    }
  }, [selectedSeq, matchSeqs]);

  const virtualizer = useVirtualizerNoSync({
    count: matchSeqs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => BASE_ROW_HEIGHT,
    overscan: 12,
  });

  const jumpToMatch = useCallback((match: SearchMatch, idx: number) => {
    setSelectedIdx(idx);
    if (onJumpToMatch) {
      onJumpToMatch(match);
      return;
    }
    onJumpToSeq(match.seq);
  }, [onJumpToMatch, onJumpToSeq]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const len = matchSeqs.length;
    if (len === 0) return;
    const cur = selectedIdx ?? -1;
    const next = e.key === "ArrowDown" ? Math.min(cur + 1, len - 1) : Math.max(cur - 1, 0);
    const seq = matchSeqs[next];
    if (seq === undefined) return;
    setSelectedIdx(next);
    const match = getMatchDetail(seq);
    if (match && onJumpToMatch) {
      onJumpToMatch(match);
    } else {
      onJumpToSeq(seq);
    }
    virtualizer.scrollToIndex(next, { align: "auto" });
  }, [matchSeqs, selectedIdx, onJumpToMatch, onJumpToSeq, virtualizer, getMatchDetail]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const handleScroll = () => {
      setScrollRow(Math.floor(el.scrollTop / BASE_ROW_HEIGHT));
    };
    let timer = 0;
    const ro = new ResizeObserver((entries) => {
      clearTimeout(timer);
      const { height: h, width: w } = entries[0].contentRect;
      timer = window.setTimeout(() => {
        setContainerHeight(h);
        setContainerWidth(w);
      }, document.documentElement.dataset.separatorDrag ? 300 : 0);
    });
    el.addEventListener("scroll", handleScroll);
    handleScroll();
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      el.removeEventListener("scroll", handleScroll);
      ro.disconnect();
    };
  }, [matchSeqs.length]);

  const searchResolve = useCallback((vi: number): ResolvedRow => {
    return { type: "line", seq: matchSeqs[vi] ?? vi } as ResolvedRow;
  }, [matchSeqs]);

  const searchGetLines = useCallback(async (seqs: number[]): Promise<TraceLine[]> => {
    const seqSet = new Set(seqs);
    const lines: TraceLine[] = [];
    const missing: number[] = [];
    for (const seq of seqSet) {
      const match = getMatchDetail(seq);
      if (match) lines.push(match as unknown as TraceLine);
      else missing.push(seq);
    }
    // 触发 fetch 让缓存填充（Minimap 采样的 seq 大多不在缓存中）
    if (missing.length > 0 && requestDetails) {
      requestDetails(missing);
    }
    return lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getMatchDetail, requestDetails, cacheVersion]);

  const hl = useCallback((text: string | null | undefined) => {
    if (!text || !searchQuery) return text ?? "";
    return highlightText(text, searchQuery, caseSensitive ?? false, fuzzy ?? false, useRegex ?? false);
  }, [searchQuery, caseSensitive, fuzzy, useRegex]);

  const visibleRows = Math.max(1, Math.ceil(containerHeight / BASE_ROW_HEIGHT));
  const maxRow = Math.max(0, matchSeqs.length - visibleRows);
  const virtualItems = virtualizer.getVirtualItems();

  // Address column width estimation from visible rows
  useEffect(() => {
    if (addrWidthEstimated) return;
    // Estimate from visible rows that have details loaded
    const CHAR_W = 7.2;
    const PAD = 16;
    let maxLen = 0;
    for (const vi of virtualItems) {
      const match = getMatchDetail(matchSeqs[vi.index]);
      if (!match) continue;
      let len = (match.so_offset || match.address || "").length;
      if (showSoName && match.so_name) len += match.so_name.length + 3;
      if (showAbsAddress && match.address) len += match.address.length + 1;
      if (len > maxLen) maxLen = len;
    }
    if (maxLen > 0) {
      const estimated = Math.max(90, Math.ceil(maxLen * CHAR_W + PAD));
      addrCol.setWidth(estimated);
      setAddrWidthEstimated(true);
    }
  }, [virtualItems, showSoName, showAbsAddress, addrWidthEstimated, matchSeqs, getMatchDetail]);

  // Detail fetch trigger for visible rows
  const visibleRange = useMemo(() => {
    if (virtualItems.length === 0) return "";
    return `${virtualItems[0].index}-${virtualItems[virtualItems.length - 1].index}`;
  }, [virtualItems]);

  useEffect(() => {
    if (!requestDetails || matchSeqs.length === 0 || virtualItems.length === 0) return;
    const visibleSeqs = virtualItems.map(vi => matchSeqs[vi.index]).filter(s => s !== undefined);
    requestDetails(visibleSeqs);
  }, [visibleRange, matchSeqs, requestDetails]);

  return (
    <>
      <div style={{
        display: "flex",
        alignItems: "center",
        padding: "4px 8px",
        background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border-color)",
        fontSize: "var(--font-size-sm)",
        color: "var(--text-secondary)",
        flexShrink: 0,
      }}>
        <span style={{ width: 40, flexShrink: 0 }}></span>
        <span style={{ width: rwCol.width, flexShrink: 0 }}>R/W</span>
        <div onMouseDown={rwCol.onMouseDown} style={HANDLE_STYLE}><div style={{ width: 1, height: "100%", background: "var(--border-color)" }} /></div>
        <span style={{ width: seqCol.width, flexShrink: 0 }}>Seq</span>
        <div onMouseDown={seqCol.onMouseDown} style={HANDLE_STYLE}><div style={{ width: 1, height: "100%", background: "var(--border-color)" }} /></div>
        <span style={{ width: addrCol.width, flexShrink: 0 }}>Address</span>
        <div onMouseDown={addrCol.onMouseDown} style={HANDLE_STYLE}><div style={{ width: 1, height: "100%", background: "var(--border-color)" }} /></div>
        <span style={{ width: effectiveDisasmWidth, flexShrink: 0 }}>Disassembly</span>
        <div onMouseDown={disasmCol.onMouseDown} style={HANDLE_STYLE}><div style={{ width: 1, height: "100%", background: "var(--border-color)" }} /></div>
        <span style={{ width: effectiveBeforeWidth, flexShrink: 0 }}>Before</span>
        <div onMouseDown={beforeCol.onMouseDown} style={HANDLE_STYLE}><div style={{ width: 1, height: "100%", background: "var(--border-color)" }} /></div>
        <span style={{ flex: 1 }}>Changes</span>
        <span style={{ width: MINIMAP_WIDTH + 12, flexShrink: 0 }}></span>
      </div>

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div
          ref={parentRef}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          style={{
            flex: 1,
            overflow: "auto",
            outline: "none",
            scrollbarWidth: "none",
            fontSize: "var(--font-size-sm)",
          }}
        >
          <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
            {virtualItems.map((vRow) => {
              const seq = matchSeqs[vRow.index];
              const match = getMatchDetail(seq);
              const isSelected = selectedIdx === vRow.index;
              const baseBg = isSelected
                ? "var(--bg-selected)"
                : vRow.index % 2 === 0 ? "var(--bg-row-even)" : "var(--bg-row-odd)";

              if (!match) {
                return (
                  <div
                    key={vRow.index}
                    ref={virtualizer.measureElement}
                    data-index={vRow.index}
                    onClick={() => onJumpToSeq(seq)}
                    style={{
                      position: "absolute", top: 0, left: 0, width: "100%",
                      height: BASE_ROW_HEIGHT,
                      transform: `translateY(${vRow.start}px)`,
                      background: baseBg,
                      display: "flex", alignItems: "center", padding: "0 8px",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ width: 40, flexShrink: 0 }} />
                    <span style={{ color: "var(--text-disabled, #555)", fontSize: "var(--font-size-sm)" }}>
                      #{seq + 1}
                    </span>
                  </div>
                );
              }

              return (
                <div
                  key={vRow.index}
                  ref={virtualizer.measureElement}
                  data-index={vRow.index}
                  onClick={() => jumpToMatch(match, vRow.index)}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vRow.start}px)`,
                    cursor: "pointer",
                    fontSize: "var(--font-size-sm)",
                    background: baseBg,
                    boxSizing: "border-box",
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.background = "rgba(255,255,255,0.04)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.background = vRow.index % 2 === 0
                        ? "var(--bg-row-even)"
                        : "var(--bg-row-odd)";
                    }
                  }}
                >
                  <div style={{
                    height: BASE_ROW_HEIGHT,
                    display: "flex",
                    alignItems: "center",
                    padding: "0 8px",
                  }}>
                    <span style={{ width: 40, flexShrink: 0 }}></span>
                    <span style={{ width: rwCol.width, flexShrink: 0, color: "var(--text-secondary)" }}>
                      {hl(match.mem_rw === "W" || match.mem_rw === "R" ? match.mem_rw : "")}
                    </span>
                    <span style={{ width: HANDLE_W, flexShrink: 0 }} />
                    <span style={{ width: seqCol.width, flexShrink: 0, color: "var(--text-secondary)" }}>{match.seq + 1}</span>
                    <span style={{ width: HANDLE_W, flexShrink: 0 }} />
                    <span style={{
                      width: addrCol.width, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      color: addrColorHighlight ? "var(--text-address)" : "var(--text-secondary)",
                    }}>
                      {addrColorHighlight && showSoName && match.so_name ? (
                        <>
                          <span style={{ color: "var(--text-so-name)" }}>[{match.so_name}] </span>
                          {showAbsAddress && match.address ? (
                            <><span style={{ color: "var(--text-abs-address)" }}>{match.address}</span>!{match.so_offset}</>
                          ) : (match.so_offset || match.address)}
                        </>
                      ) : hl(formatAddr(match))}
                    </span>
                    <span style={{ width: HANDLE_W, flexShrink: 0 }} />
                    <span style={{ width: effectiveDisasmWidth, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <DisasmHighlight text={match.disasm} highlightQuery={searchQuery} caseSensitive={caseSensitive} fuzzy={fuzzy} useRegex={useRegex} />
                      {match.call_info && (
                        <span
                          style={{
                            marginLeft: 8,
                            fontStyle: "italic",
                            color: match.call_info.is_jni ? "var(--call-info-jni)" : "var(--call-info-normal)",
                          }}
                          title={match.call_info.tooltip}
                        >
                          {hl(match.call_info.summary.length > 80
                            ? match.call_info.summary.slice(0, 80) + "..."
                            : match.call_info.summary)}
                        </span>
                      )}
                    </span>
                    <span style={{ width: HANDLE_W, flexShrink: 0 }} />
                    <span
                      style={{
                        width: effectiveBeforeWidth, flexShrink: 0,
                        color: "var(--text-secondary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {hl(match.reg_before)}
                    </span>
                    <span style={{ width: HANDLE_W, flexShrink: 0 }} />
                    <span
                      style={{
                        flex: 1,
                        color: "var(--text-changes)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {hl(match.changes)}
                    </span>
                  </div>

                  {match.hidden_content && (
                    <div style={{
                      padding: `${DETAIL_TOP_MARGIN}px 8px ${DETAIL_BOTTOM_GAP}px ${8 + 48 + rwCol.width + 8 + seqCol.width + 8 + addrCol.width + 8}px`,
                    }}>
                      <VirtualizedHighlight
                        text={match.hidden_content}
                        query={searchQuery ?? ""}
                        caseSensitive={caseSensitive ?? false}
                        fuzzy={fuzzy ?? false}
                        useRegex={useRegex ?? false}
                        isHex={isHexdumpContent(match.hidden_content)}
                        lineHeight={DETAIL_LINE_HEIGHT}
                        maxVisibleLines={DETAIL_MAX_LINES}
                        verticalPadding={DETAIL_VERTICAL_PADDING}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {containerHeight > 0 && (
          <div style={{ width: MINIMAP_WIDTH + 12, flexShrink: 0, position: "relative" }}>
            <Minimap
              virtualTotalRows={matchSeqs.length}
              visibleRows={visibleRows}
              currentRow={scrollRow}
              maxRow={maxRow}
              height={containerHeight}
              onScroll={(row) => {
                virtualizer.scrollToIndex(row, { align: "start" });
              }}
              resolveVirtualIndex={searchResolve}
              getLines={searchGetLines}
              selectedSeq={selectedSeq}
              rightOffset={12}
              showSoName={showSoName}
              showAbsAddress={showAbsAddress}
            />
            <CustomScrollbar
              currentRow={scrollRow}
              maxRow={maxRow}
              visibleRows={visibleRows}
              virtualTotalRows={matchSeqs.length}
              trackHeight={containerHeight}
              onScroll={(row) => {
                virtualizer.scrollToIndex(row, { align: "start" });
              }}
            />
          </div>
        )}
      </div>
    </>
  );
}
