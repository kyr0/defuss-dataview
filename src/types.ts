export type DataviewJsonValue =
  | null
  | boolean
  | number
  | string
  | DataviewJsonValue[]
  | { [key: string]: DataviewJsonValue };

export type DataviewFilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "contains"
  | "startsWith"
  | "endsWith";

export interface DataviewFilter {
  field: string;
  op: DataviewFilterOperator;
  value: DataviewJsonValue;
}

export type DataviewSortDirection = "asc" | "desc";

export interface DataviewSorter {
  field: string;
  direction?: DataviewSortDirection;
  dir?: DataviewSortDirection;
}

export interface DataviewRequest {
  filters?: DataviewFilter[];
  sorters?: DataviewSorter[];
  page?: number;
  pageSize?: number;
  /** Field used as the row identifier in flat mode (default: "id"). Tree mode falls back to tree.idField. */
  idField?: string;
  meta?: Partial<DataviewMeta>;
  tree?: DataviewTreeOptions;
}

export interface DataviewMeta {
  selectedRowIds: DataviewJsonValue[];
  lockedColumns: string[];
}

export interface DataviewState {
  filters: DataviewFilter[];
  sorters: Array<DataviewSorter & { direction: DataviewSortDirection }>;
  page: number;
  pageSize?: number;
  /** Selection identifier (default: "id" or tree.idField). Graph identity always uses tree.idField. */
  idField: string;
  meta: DataviewMeta;
  tree?: {
    idField: string;
    parentIdField: string;
    expandedIds: DataviewJsonValue[];
    /** Omitted input expandedIds defaults to all expanded; explicit [] collapses all. */
    expandAll?: boolean;
    /** Exceptions when expandAll is true. */
    collapsedIds?: DataviewJsonValue[];
    maxDepth?: number;
    includeAncestors: boolean;
    includeDescendantsOfMatch: boolean;
  };
}

export type DataviewRow = Record<string, unknown>;

export interface DataviewTreeOptions {
  idField: string;
  parentIdField: string;
  expandedIds?: DataviewJsonValue[];
  expandAll?: boolean;
  collapsedIds?: DataviewJsonValue[];
  maxDepth?: number;
  includeAncestors?: boolean;
  includeDescendantsOfMatch?: boolean;
}

export interface DataviewRowMeta {
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  isMatch: boolean;
  isSelected: boolean;
  parentId: DataviewJsonValue | null;
}

export interface DataviewEntry<T extends DataviewRow = DataviewRow> {
  row: T;
  meta: DataviewRowMeta;
}

export interface DataviewResult<T extends DataviewRow = DataviewRow> {
  entries: Array<DataviewEntry<T>>;
  totalRows: number;
  /** Rows satisfying filters, before hierarchy inclusion or visibility. */
  matchedRows: number;
  /** Included rows after expansion/maxDepth, before pagination. */
  visibleRows: number;
  page: number;
  pageSize?: number;
  pageCount: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}
