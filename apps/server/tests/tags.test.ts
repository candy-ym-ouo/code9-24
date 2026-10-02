import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb, migrate, newId, nowIso, closeDb } from '../src/db.js';
import { ApiError } from '../src/http/errors.js';
import { createTag, mergeTags, updateTag } from '../src/services/tags.js';
import { buildTagTree } from '../src/services/serialization.js';

let tmpDir = '';
let libA = '';
let libB = '';

function expectError(fn: () => unknown, status: number, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    const err = e as ApiError;
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    return;
  }
  throw new Error('预期抛出错误，但没有抛出');
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-tags-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'off';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';
  migrate();
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeLibrary(): string {
  const db = getDb();
  const ts = nowIso();
  const userId = newId();
  db.prepare(
    'INSERT INTO "user" (id, email, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run(userId, `${newId()}@test.local`, 'x', 'u', ts, ts);
  const libraryId = newId();
  db.prepare(
    'INSERT INTO library (id, name, owner_id, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run(libraryId, 'lib', userId, ts, ts);
  return libraryId;
}

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM tag').run();
  libA = makeLibrary();
  libB = makeLibrary();
});

describe('标签树完整性（重挂不得跨库 / 成环）', () => {
  it('createTag：拒绝挂到其他资料库的标签下', () => {
    const foreign = createTag({ libraryId: libB, domain: 'light', name: 'B库父标签' });
    expectError(
      () => createTag({ libraryId: libA, domain: 'light', name: 'A库子标签', parentId: foreign }),
      403,
      'LIBRARY_SCOPE_DENIED',
    );
  });

  it('createTag：拒绝挂到其他标签域', () => {
    const parent = createTag({ libraryId: libA, domain: 'light', name: '光线父标签' });
    expectError(
      () => createTag({ libraryId: libA, domain: 'scene', name: '场景子标签', parentId: parent }),
      400,
      'BAD_REQUEST',
    );
  });

  it('createTag：父标签不存在 → 404', () => {
    expectError(
      () => createTag({ libraryId: libA, domain: 'light', name: '孤儿', parentId: newId() }),
      404,
      'NOT_FOUND',
    );
  });

  it('updateTag：重挂到其他资料库的标签下被拒绝，原 parent_id 不变', () => {
    const rootA = createTag({ libraryId: libA, domain: 'light', name: 'A根' });
    const child = createTag({ libraryId: libA, domain: 'light', name: 'A子', parentId: rootA });
    const rootB = createTag({ libraryId: libB, domain: 'light', name: 'B根' });

    expectError(
      () => updateTag(child, libA, { parentId: rootB }),
      403,
      'LIBRARY_SCOPE_DENIED',
    );
    const row = getDb().prepare('SELECT parent_id FROM tag WHERE id = ?').get(child) as {
      parent_id: string | null;
    };
    expect(row.parent_id).toBe(rootA);
  });

  it('updateTag：挂到自身被拒绝', () => {
    const tag = createTag({ libraryId: libA, domain: 'light', name: '自挂标签' });
    expectError(() => updateTag(tag, libA, { parentId: tag }), 400, 'BAD_REQUEST');
  });

  it('updateTag：挂到直接子标签被拒绝', () => {
    const parent = createTag({ libraryId: libA, domain: 'light', name: '父' });
    const child = createTag({ libraryId: libA, domain: 'light', name: '子', parentId: parent });
    expectError(() => updateTag(parent, libA, { parentId: child }), 400, 'BAD_REQUEST');
  });

  it('updateTag：挂到深层孙标签被拒绝（跨多级环）', () => {
    const a = createTag({ libraryId: libA, domain: 'light', name: 'A' });
    const b = createTag({ libraryId: libA, domain: 'light', name: 'B', parentId: a });
    const c = createTag({ libraryId: libA, domain: 'light', name: 'C', parentId: b });
    const d = createTag({ libraryId: libA, domain: 'light', name: 'D', parentId: c });
    expectError(() => updateTag(a, libA, { parentId: d }), 400, 'BAD_REQUEST');
    // 数据未被污染
    const rows = getDb().prepare('SELECT * FROM tag WHERE library_id = ?').all(libA) as Record<
      string,
      unknown
    >[];
    expect(buildTagTree(rows)).toHaveLength(1);
  });

  it('updateTag：跨域重挂被拒绝', () => {
    const lightTag = createTag({ libraryId: libA, domain: 'light', name: '光线标签' });
    const sceneParent = createTag({ libraryId: libA, domain: 'scene', name: '场景标签' });
    expectError(() => updateTag(lightTag, libA, { parentId: sceneParent }), 400, 'BAD_REQUEST');
  });

  it('updateTag：重挂到不存在的标签 → 404', () => {
    const tag = createTag({ libraryId: libA, domain: 'light', name: '标签' });
    expectError(() => updateTag(tag, libA, { parentId: newId() }), 404, 'NOT_FOUND');
  });

  it('updateTag：合法重挂（同库同域、非后代）成功；挂 null 升为根', () => {
    const root1 = createTag({ libraryId: libA, domain: 'light', name: '根1' });
    const root2 = createTag({ libraryId: libA, domain: 'light', name: '根2' });
    const child = createTag({ libraryId: libA, domain: 'light', name: '子', parentId: root1 });

    updateTag(child, libA, { parentId: root2 });
    let row = getDb().prepare('SELECT parent_id FROM tag WHERE id = ?').get(child) as {
      parent_id: string | null;
    };
    expect(row.parent_id).toBe(root2);

    updateTag(child, libA, { parentId: null });
    row = getDb().prepare('SELECT parent_id FROM tag WHERE id = ?').get(child) as {
      parent_id: string | null;
    };
    expect(row.parent_id).toBeNull();
  });

  it('updateTag：他库调用方对本库标签的重挂一律 scopeDenied', () => {
    const tag = createTag({ libraryId: libA, domain: 'light', name: 'A标签' });
    const bParent = createTag({ libraryId: libB, domain: 'light', name: 'B标签' });
    expectError(() => updateTag(tag, libB, { parentId: bParent }), 403, 'LIBRARY_SCOPE_DENIED');
  });

  it('mergeTags：祖先合并到后代被拒绝（会成环）', () => {
    const a = createTag({ libraryId: libA, domain: 'light', name: '祖先' });
    const b = createTag({ libraryId: libA, domain: 'light', name: '父', parentId: a });
    const c = createTag({ libraryId: libA, domain: 'light', name: '孙', parentId: b });
    expectError(() => mergeTags(a, c, libA), 400, 'BAD_REQUEST');
    // 三个标签都还在
    const n = (
      getDb().prepare('SELECT COUNT(*) AS n FROM tag WHERE library_id = ?').get(libA) as {
        n: number;
      }
    ).n;
    expect(n).toBe(3);
  });

  it('mergeTags：删除源标签后其子标签挂到源的原父级，层级不断裂', () => {
    const root = createTag({ libraryId: libA, domain: 'light', name: '根' });
    const mid = createTag({ libraryId: libA, domain: 'light', name: '中层', parentId: root });
    const leaf = createTag({ libraryId: libA, domain: 'light', name: '叶', parentId: mid });
    const sibling = createTag({ libraryId: libA, domain: 'light', name: '合并目标', parentId: root });

    mergeTags(mid, sibling, libA);

    const row = getDb().prepare('SELECT parent_id FROM tag WHERE id = ?').get(leaf) as {
      parent_id: string | null;
    };
    expect(row.parent_id).toBe(root);

    const rows = getDb().prepare('SELECT * FROM tag WHERE library_id = ?').all(libA) as Record<
      string,
      unknown
    >[];
    const tree = buildTagTree(rows);
    expect(tree).toHaveLength(1);
    const leaves = tree[0].children as { id: string }[];
    expect(leaves.map((t) => t.id).sort()).toEqual([leaf, sibling].sort());
  });

  it('mergeTags：源标签是根时，其子标签升为根，仍在同一棵树集合里', () => {
    const root = createTag({ libraryId: libA, domain: 'light', name: '要被合并的根' });
    const leaf = createTag({ libraryId: libA, domain: 'light', name: '叶子', parentId: root });
    const target = createTag({ libraryId: libA, domain: 'light', name: '目标根' });

    mergeTags(root, target, libA);

    const row = getDb().prepare('SELECT parent_id FROM tag WHERE id = ?').get(leaf) as {
      parent_id: string | null;
    };
    expect(row.parent_id).toBeNull();
  });

  it('buildTagTree：合法重挂后整库标签仍能组成连通的树（无标签丢失）', () => {
    const a = createTag({ libraryId: libA, domain: 'light', name: 'A' });
    const b = createTag({ libraryId: libA, domain: 'light', name: 'B', parentId: a });
    const c = createTag({ libraryId: libA, domain: 'light', name: 'C', parentId: b });

    // 把最深的 C 重挂为根，再把 A 挂到 C 下（合法：此时 A 不在 C 子树里）
    updateTag(c, libA, { parentId: null });
    updateTag(a, libA, { parentId: c });

    const rows = getDb().prepare('SELECT * FROM tag WHERE library_id = ?').all(libA) as Record<
      string,
      unknown
    >[];
    const tree = buildTagTree(rows);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe(c);
    const firstLevel = tree[0].children as { id: string; children?: { id: string }[] }[];
    expect(firstLevel).toHaveLength(1);
    expect(firstLevel[0].id).toBe(a);
    expect(firstLevel[0].children?.[0].id).toBe(b);
  });
});
