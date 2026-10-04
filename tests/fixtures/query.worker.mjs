import { createDataview, evaluateDataview } from '/dist/browser.mjs';
self.onmessage = ({ data }) => {
  try {
    const rows = Array.from({ length: data.size }, (_, id) => ({ id, parentId: id ? id - 1 : null }));
    const result = evaluateDataview(rows, createDataview({ tree: { idField: 'id', parentIdField: 'parentId' }, pageSize: 1, page: data.size - 1 }));
    self.postMessage({ total: result.visibleRows, depth: result.entries[0].meta.depth, id: result.entries[0].row.id });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
