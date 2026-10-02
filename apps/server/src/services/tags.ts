import { getDb, newId, nowIso } from '../db.js';
import { errors } from '../http/errors.js';
import { slugify } from './inspirations.js';

/**
 * 断言一次"重挂父标签"合法：父标签必须存在、同库、同域，且不能是标签自身或其后代
 * （否则 parent_id 会指向别的库或形成环，标签树会断裂）。
 * createTag 传 tagId=null；updateTag / mergeTags 传被移动标签的 id。
 */
function assertValidParent(params: {
  libraryId: string;
  domain: string;
  parentId: string | null;
  tagId: string | null;
}): void {
  const parentId = params.parentId;
  if (!parentId) return;
  const db = getDb();
  const parent = db.prepare('SELECT id, domain, library_id FROM tag WHERE id = ?').get(parentId) as
    | { id: string; domain: string; library_id: string }
    | undefined;
  if (!parent) throw errors.notFound('父标签');
  if (parent.library_id !== params.libraryId) throw errors.scopeDenied();
  if (parent.domain !== params.domain) throw errors.badRequest('父标签必须属于同一标签域');
  if (params.tagId && (parentId === params.tagId || isInSubtree(parentId, params.tagId))) {
    throw errors.badRequest('不能把标签挂到自身或自己的子标签下（会形成环）');
  }
}

/** maybeDescendantId 是否位于 rootId 的子树内（沿 parent_id 链向上追溯能否到达 rootId） */
function isInSubtree(maybeDescendantId: string, rootId: string): boolean {
  const db = getDb();
  let current: string | null = maybeDescendantId;
  for (let depth = 0; current && depth < 10000; depth += 1) {
    if (current === rootId) return true;
    const row = db.prepare('SELECT parent_id FROM tag WHERE id = ?').get(current) as
      | { parent_id: string | null }
      | undefined;
    current = row?.parent_id ?? null;
  }
  return false;
}

export function createTag(params: {
  libraryId: string;
  domain: string;
  name: string;
  parentId?: string | null;
}): string {
  const db = getDb();
  const slug = slugify(params.name);
  const existing = db
    .prepare('SELECT id FROM tag WHERE library_id = ? AND domain = ? AND slug = ?')
    .get(params.libraryId, params.domain, slug) as { id: string } | undefined;
  if (existing) throw errors.badRequest('同域下已存在同名标签', { tagId: existing.id });

  assertValidParent({
    libraryId: params.libraryId,
    domain: params.domain,
    parentId: params.parentId ?? null,
    tagId: null,
  });

  const maxOrder = (
    db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tag WHERE library_id = ? AND domain = ?')
      .get(params.libraryId, params.domain) as { m: number }
  ).m;

  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO tag (id, library_id, domain, parent_id, name, slug, is_builtin, disabled, sort_order,
       usage_count, created_at, updated_at)
     VALUES (?,?,?,?,?,?,0,0,?,0,?,?)`,
  ).run(
    id,
    params.libraryId,
    params.domain,
    params.parentId ?? null,
    params.name,
    slug,
    maxOrder + 10,
    ts,
    ts,
  );
  return id;
}

export function updateTag(
  id: string,
  libraryId: string,
  patch: { name?: string; parentId?: string | null; sortOrder?: number; disabled?: boolean },
): void {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tag WHERE id = ?').get(id) as
    | { id: string; library_id: string; domain: string; is_builtin: number }
    | undefined;
  if (!row) throw errors.notFound('标签');
  if (row.library_id !== libraryId) throw errors.scopeDenied();
  if (patch.name !== undefined && row.is_builtin) {
    throw errors.forbiddenRole('内置标签不可改名，可停用或新增自定义标签');
  }
  // 先做全部校验，再在单个事务里落库，避免改到一半失败留下半截状态
  if (patch.parentId !== undefined) {
    assertValidParent({ libraryId, domain: row.domain, parentId: patch.parentId, tagId: id });
  }

  const ts = nowIso();
  const apply = db.transaction(() => {
    if (patch.name !== undefined) {
      db.prepare('UPDATE tag SET name = ?, slug = ?, updated_at = ? WHERE id = ?').run(
        patch.name,
        slugify(patch.name),
        ts,
        id,
      );
    }
    if (patch.parentId !== undefined) {
      // 重挂必须拒绝跨库 / 跨域 / 自身或后代成环，否则标签树会断裂
      db.prepare('UPDATE tag SET parent_id = ?, updated_at = ? WHERE id = ?').run(patch.parentId, ts, id);
    }
    if (patch.sortOrder !== undefined) {
      db.prepare('UPDATE tag SET sort_order = ?, updated_at = ? WHERE id = ?').run(patch.sortOrder, ts, id);
    }
    if (patch.disabled !== undefined) {
      db.prepare('UPDATE tag SET disabled = ?, updated_at = ? WHERE id = ?').run(patch.disabled ? 1 : 0, ts, id);
    }
  });
  apply();
}

/** 合并标签：绑定关系迁移 + 去重 + usage_count 重算（文档 11.2） */
export function mergeTags(sourceId: string, targetId: string, libraryId: string): void {
  const db = getDb();
  const src = db.prepare('SELECT * FROM tag WHERE id = ?').get(sourceId) as
    | { id: string; library_id: string; domain: string }
    | undefined;
  const tgt = db.prepare('SELECT * FROM tag WHERE id = ?').get(targetId) as
    | { id: string; library_id: string; domain: string }
    | undefined;
  if (!src || !tgt) throw errors.notFound('标签');
  if (src.library_id !== libraryId || tgt.library_id !== libraryId) throw errors.scopeDenied();
  if (src.domain !== tgt.domain) throw errors.badRequest('只能合并同一标签域内的标签');
  if (sourceId === targetId) throw errors.badRequest('源标签与目标标签不能相同');
  // 源标签是目标标签的祖先时合并会把目标挂到自己的子孙下成环，必须拒绝
  if (isInSubtree(targetId, sourceId)) {
    throw errors.badRequest('不能将标签合并到它自己的子标签下（会形成环）');
  }

  const run = db.transaction(() => {
    const bindings = db
      .prepare('SELECT inspiration_id FROM inspiration_tag WHERE tag_id = ?')
      .all(sourceId) as { inspiration_id: string }[];
    for (const b of bindings) {
      db.prepare(
        `INSERT INTO inspiration_tag (inspiration_id, tag_id, source, created_at) VALUES (?,?, 'bulk', ?)
         ON CONFLICT (inspiration_id, tag_id) DO NOTHING`,
      ).run(b.inspiration_id, targetId, nowIso());
    }
    // 删除源标签前先把它的子标签挂到源标签的原父级（同库同域，层级不丢；
    // 根标签的子标签则升为根），避免 ON DELETE SET NULL 之外出现语义上的层级断裂
    db.prepare('UPDATE tag SET parent_id = (SELECT parent_id FROM tag WHERE id = ?), updated_at = ? WHERE parent_id = ?').run(
      sourceId,
      nowIso(),
      sourceId,
    );
    db.prepare('DELETE FROM tag WHERE id = ?').run(sourceId);
    const n = (
      db.prepare('SELECT COUNT(*) AS n FROM inspiration_tag WHERE tag_id = ?').get(targetId) as { n: number }
    ).n;
    db.prepare('UPDATE tag SET usage_count = ? WHERE id = ?').run(n, targetId);
  });
  run();
}

export function listTags(libraryId: string, includeDisabled = false): Record<string, unknown>[] {
  const where = includeDisabled ? '' : 'AND disabled = 0';
  return getDb()
    .prepare(`SELECT * FROM tag WHERE library_id = ? ${where} ORDER BY domain, sort_order, name`)
    .all(libraryId) as Record<string, unknown>[];
}

/** 标签补全建议：基于同库共现频次（只建议、不自动写入，文档 11.2） */
export function suggestTags(
  libraryId: string,
  tagIds: string[],
  limit = 8,
): { id: string; name: string; domain: string; score: number }[] {
  const db = getDb();
  if (!tagIds.length) {
    return (
      db
        .prepare(
          'SELECT id, name, domain, usage_count FROM tag WHERE library_id = ? AND disabled = 0 ORDER BY usage_count DESC LIMIT ?',
        )
        .all(libraryId, limit) as { id: string; name: string; domain: string; usage_count: number }[]
    ).map((t) => ({ id: t.id, name: t.name, domain: t.domain, score: t.usage_count }));
  }

  const placeholders = tagIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.domain, COUNT(*) AS co
       FROM inspiration_tag a
       JOIN inspiration_tag b ON a.inspiration_id = b.inspiration_id
       JOIN tag t ON t.id = b.tag_id
       WHERE a.tag_id IN (${placeholders})
         AND b.tag_id NOT IN (${placeholders})
         AND t.library_id = ? AND t.disabled = 0
       GROUP BY t.id
       ORDER BY co DESC
       LIMIT ?`,
    )
    .all(...tagIds, ...tagIds, libraryId, limit) as {
    id: string;
    name: string;
    domain: string;
    co: number;
  }[];
  return rows.map((r) => ({ id: r.id, name: r.name, domain: r.domain, score: r.co }));
}
