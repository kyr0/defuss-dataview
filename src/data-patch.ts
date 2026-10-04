import { compileAccessor, setField } from './fields.js';
import { idKey, rowIdKey } from './identity.js';
import type { DataviewRow } from './types.js';

export function updateRows<T extends DataviewRow>(rows: T[], ids: unknown[], updates: Array<Partial<T>>, idField = 'id'): T[] {
  if (ids.length !== updates.length) throw new Error('updateRows expects ids and updates arrays with equal length.');
  const getId = compileAccessor(idField);
  if (!ids.length) return rows;
  const patches = new Map<string, Partial<T>>();
  for (let index = 0; index < ids.length; index++) {
    const patch = updates[index];
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Row patches must be objects.');
    patches.set(idKey(ids[index]), patch);
  }
  let next: T[] | undefined;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], value = getId(row);
    if (value === undefined) continue;
    const patch = patches.get(idKey(value));
    if (!patch) continue;
    const keys = Reflect.ownKeys(patch).filter(key => Object.prototype.propertyIsEnumerable.call(patch, key));
    if (!keys.some(key => !Object.hasOwn(row, key) || !Object.is(Reflect.get(row, key), Reflect.get(patch, key)))) continue;
    next ??= rows.slice();
    next[index] = { ...row, ...patch };
  }
  return next ?? rows;
}
export function addRows<T extends DataviewRow>(rows: T[], newRows: T[], anchorId?: unknown, position: 'before' | 'after' = 'after', idField = 'id'): T[] {
  const getId = compileAccessor(idField);
  if (position !== 'before' && position !== 'after') throw new TypeError('Row insertion position must be before or after.');
  if (!newRows.length) return rows;
  if (!rows.length || anchorId === undefined) return [...rows, ...newRows];
  const key = idKey(anchorId);
  const anchor = rows.findIndex(row => { const id = getId(row); return id !== undefined && idKey(id) === key; });
  const index = anchor < 0 ? rows.length : anchor + Number(position === 'after');
  return [...rows.slice(0, index), ...newRows, ...rows.slice(index)];
}
export function removeRows<T extends DataviewRow>(rows: T[], ids: unknown[], idField = 'id'): T[] {
  const getId = compileAccessor(idField);
  if (!ids.length) return rows;
  const keys = new Set(ids.map(idKey));
  const result = rows.filter(row => { const value = getId(row); return value === undefined || !keys.has(idKey(value)); });
  return result.length === rows.length ? rows : result;
}
export function setParent<T extends DataviewRow>(rows: T[], nodeId: unknown, parentId: unknown, idField = 'id', parentIdField = 'parentId'): T[] {
  const getId = compileAccessor(idField), getParent = compileAccessor(parentIdField);
  const node = idKey(nodeId), parent = rowIdKey(parentId);
  if (!rows.length) return rows;
  const byId = new Map<string, T>();
  const targets: number[] = [];
  for (let index = 0; index < rows.length; index++) {
    const key = rowIdKey(getId(rows[index]));
    if (key !== undefined && !byId.has(key)) byId.set(key, rows[index]);
    if (key === node) targets.push(index);
  }
  if (!targets.length) return rows;
  const seen = new Set<string>();
  for (let key = parent; key !== undefined;) {
    if (key === node || seen.has(key)) throw new Error('setParent would create or attach to a parent cycle.');
    seen.add(key);
    const ancestor = byId.get(key);
    key = ancestor ? rowIdKey(getParent(ancestor)) : undefined;
  }
  let next: T[] | undefined;
  for (const index of targets) {
    if (rowIdKey(getParent(rows[index])) === parent) continue;
    next ??= rows.slice();
    next[index] = setField(rows[index], parentIdField, parentId);
  }
  return next ?? rows;
}
