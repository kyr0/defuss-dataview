import { applyDataview, createDataview, evaluateDataview, updateMeta, updateRows } from 'defuss-dataview';
import type { DataviewResult, DataviewState } from 'defuss-dataview';
const rows: readonly { id: number; name: string }[] = [{ id: 1, name: 'Alice' }];
const view = createDataview({ sorters: [{ field: 'name', dir: 'asc' }], tree: { idField: 'id', parentIdField: 'parentId', expandAll: true, collapsedIds: [1] } });
const result: DataviewResult<{ id: number; name: string }> = evaluateDataview(rows, view);
const name: string = applyDataview(rows, view)[0].row.name;
const extra = updateMeta({ ...view, application: 'keep' }, { selectedRowIds: [1] });
const preserved: string = extra.application;
const state: DataviewState = view;
// @ts-expect-error Filters have a closed operator vocabulary.
createDataview({ filters: [{ field: 'id', op: 'regex', value: 'x' }] });
// @ts-expect-error JSON IDs cannot contain bigint.
createDataview({ meta: { selectedRowIds: [1n] } });
// @ts-expect-error Patch values must match the row type.
updateRows([{ id: 1, name: 'a' }], [1], [{ name: 3 }]);
// @ts-expect-error Row properties retain their original type.
const bad: number = result.entries[0].row.name;
void [name, preserved, state, bad];
