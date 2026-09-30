import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: ReactNode;
  align?: "left" | "right";
  width?: string;
  sortable?: boolean;
  /** Rendered in the cell. */
  cell: (row: T, index: number) => ReactNode;
}

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** Number of skeleton rows to draw instead of `rows`. */
  loading?: number;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  rowClass?: (row: T) => string;
  sort?: { key: string; dir: "asc" | "desc" };
  onSort?: (key: string) => void;
  /** Rows injected before a data row, e.g. a group heading spanning all columns. */
  groupRow?: (row: T, index: number) => ReactNode;
  minWidth?: string;
  caption?: string;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  loading,
  empty,
  onRowClick,
  rowClass,
  sort,
  onSort,
  groupRow,
  minWidth = "640px",
  caption,
}: TableProps<T>) {
  const showSkeleton = !!loading;
  return (
    <div className="scroll-x rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-left" style={{ minWidth }}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="sticky top-0 z-10">
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  style={c.width ? { width: c.width } : undefined}
                  className={`whitespace-nowrap border-b border-line bg-panel px-3 py-2 text-xs font-medium text-slate ${
                    c.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {c.sortable && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(c.key)}
                      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
                      className={`inline-flex items-center gap-1 hover:text-ink ${
                        active ? "text-ink" : ""
                      }`}
                    >
                      {c.header}
                      <span aria-hidden className={active ? "" : "opacity-30"}>
                        {active && sort!.dir === "asc" ? "▲" : "▼"}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {showSkeleton
            ? Array.from({ length: loading! }).map((_, i) => (
                <tr key={"s" + i}>
                  {columns.map((c) => (
                    <td key={c.key} className="border-b border-line px-3 py-2.5">
                      <span
                        className="skel h-3"
                        style={{ width: c.align === "right" ? "48px" : i % 2 ? "60%" : "85%" }}
                      />
                    </td>
                  ))}
                </tr>
              ))
            : rows.length === 0
              ? empty !== undefined && (
                  <tr>
                    <td colSpan={columns.length} className="px-3 py-6 text-sm text-slate">
                      {empty}
                    </td>
                  </tr>
                )
              : rows.map((row, i) => (
                  <FragmentRow
                    key={rowKey(row, i)}
                    group={groupRow?.(row, i)}
                    colSpan={columns.length}
                  >
                    <tr
                      className={`${onRowClick ? "cursor-pointer" : ""} hover:bg-panel ${
                        rowClass?.(row) || ""
                      }`}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      tabIndex={onRowClick ? 0 : undefined}
                      onKeyDown={
                        onRowClick
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onRowClick(row);
                              }
                            }
                          : undefined
                      }
                    >
                      {columns.map((c) => (
                        <td
                          key={c.key}
                          className={`border-b border-line px-3 py-2.5 align-top ${
                            c.align === "right" ? "text-right" : ""
                          }`}
                        >
                          {c.cell(row, i)}
                        </td>
                      ))}
                    </tr>
                  </FragmentRow>
                ))}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({
  group,
  colSpan,
  children,
}: {
  group?: ReactNode;
  colSpan: number;
  children: ReactNode;
}) {
  return (
    <>
      {group ? (
        <tr className="bg-paper">
          <td colSpan={colSpan} className="border-b border-line px-3 pb-1.5 pt-4">
            {group}
          </td>
        </tr>
      ) : null}
      {children}
    </>
  );
}

/** A plain two-column definition table (used by Words and the readiness grid). */
export function GridTable({ children, minWidth = "480px" }: { children: ReactNode; minWidth?: string }) {
  return (
    <div className="scroll-x rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-left" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}
