import { describe, expect, it, beforeEach } from 'vitest';
import { getDb } from './db';
import { CapLibService } from './cap-lib-service';
import { QualificationService } from './qualification-service';
import type { DiffRow } from './cap-lib-service';
import type { DiffStatus } from '../shared/cap-lib-status';

/** 构造一个最小 DiffRow，仅字段对齐用。 */
function row(over: Partial<DiffRow> & { stdCode: string; diffStatus: DiffStatus }): DiffRow {
  const { stdCode, diffStatus, ...rest } = over;
  return {
    qualId: 0,
    stdCode,
    stdName: '',
    category: '',
    testItem: '',
    testItems: [],
    diffStatus,
    libStatus: '',
    libRemark: '',
    libDomain: '',
    seriesNewCode: '',
    seriesDomain: '',
    ...rest,
  };
}

describe('cma_diff_change_events 写入与聚合', () => {
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    db = getDb(':memory:');
  });

  it('recordDiffEvents 对同一标准号的状态变化写 status_changed', () => {
    const qsvc = new QualificationService(db);
    const prev = [row({ stdCode: 'GB/T 1-2020', diffStatus: 'in_lib' })];
    const next = [row({ stdCode: 'GB/T 1-2020', diffStatus: 'series_only' })];
    (qsvc as any).recordDiffEvents('CERT1', prev, next);

    const events = db.prepare('SELECT * FROM cma_diff_change_events').all() as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].change_type).toBe('status_changed');
    expect(events[0].from_status).toBe('in_lib');
    expect(events[0].to_status).toBe('series_only');
    expect(events[0].cert_number).toBe('CERT1');
  });

  it('recordDiffEvents 对新增/移除分别写 added/removed', () => {
    const qsvc = new QualificationService(db);
    const prev = [
      row({ stdCode: 'GB/T 2-2020', diffStatus: 'in_lib' }),
      row({ stdCode: 'GB/T 0-2019', diffStatus: 'cite_only' }),
    ];
    const next = [
      row({ stdCode: 'GB/T 2-2020', diffStatus: 'in_lib' }),
      row({ stdCode: 'GB/T 3-2021', diffStatus: 'not_in_lib' }),
    ];
    (qsvc as any).recordDiffEvents('CERT1', prev, next);

    const events = db.prepare('SELECT change_type, std_code, from_status, to_status FROM cma_diff_change_events ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    const added = events.find(e => e.std_code === 'GB/T 3-2021')!;
    expect(added.change_type).toBe('added');
    expect(added.to_status).toBe('not_in_lib');
    expect(added.from_status).toBe('');
    const removed = events.find(e => e.std_code === 'GB/T 0-2019')!;
    expect(removed.change_type).toBe('removed');
    expect(removed.from_status).toBe('cite_only');
    expect(removed.to_status).toBe('');
  });

  it('recordDiffEvents 对状态未变的标准号不写事件', () => {
    const qsvc = new QualificationService(db);
    const prev = [row({ stdCode: 'GB/T 4-2020', diffStatus: 'in_lib' })];
    const next = [row({ stdCode: 'GB/T 4-2020', diffStatus: 'in_lib' })];
    (qsvc as any).recordDiffEvents('CERT1', prev, next);

    const count = db.prepare('SELECT COUNT(*) AS c FROM cma_diff_change_events').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('changesForLab 返回 null 当无事件', () => {
    const svc = new CapLibService(db);
    expect(svc.changesForLab('CERT1', 90, 50)).toBeNull();
  });

  it('changesForLab 正确聚合 deltaByStatus 与事件列表', () => {
    const svc = new CapLibService(db);
    const ins = db.prepare(`
      INSERT INTO cma_diff_change_events
        (cert_number, std_code, std_code_norm, std_name, change_type, from_status, to_status, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    // 两条：in_lib -> series_only（in_lib -1, series_only +1）；added not_in_lib（not_in_lib +1）
    ins.run('CERT1', 'GB/T 1-2020', 'GB1-2020', '标准一', 'status_changed', 'in_lib', 'series_only');
    ins.run('CERT1', 'GB/T 2-2021', 'GB2-2021', '标准二', 'added', '', 'not_in_lib');

    const changes = svc.changesForLab('CERT1', 90, 50)!;
    expect(changes).not.toBeNull();
    expect(changes.totalEvents).toBe(2);
    expect(changes.deltaByStatus.in_lib).toBe(-1);
    expect(changes.deltaByStatus.series_only).toBe(1);
    expect(changes.deltaByStatus.not_in_lib).toBe(1);
    expect(changes.events).toHaveLength(2);
    expect(changes.events[0].stdCode).toBe('GB/T 2-2021'); // 倒序，最新在前
  });

  it('changesForLab 按 limit 截断但 totalEvents 保持真实总数', () => {
    const svc = new CapLibService(db);
    const ins = db.prepare(`
      INSERT INTO cma_diff_change_events
        (cert_number, std_code, change_type, from_status, to_status, changed_at)
      VALUES (?, ?, 'status_changed', 'in_lib', 'series_only', datetime('now', ?))
    `);
    for (let i = 0; i < 5; i++) ins.run('CERT1', `GB/T ${i}-2020`, `-${i} minutes`);

    const changes = svc.changesForLab('CERT1', 90, 3)!;
    expect(changes.totalEvents).toBe(5);
    expect(changes.events).toHaveLength(3);
  });

  it('changesForLab limit=0 返回全部事件', () => {
    const svc = new CapLibService(db);
    const ins = db.prepare(`
      INSERT INTO cma_diff_change_events
        (cert_number, std_code, change_type, from_status, to_status, changed_at)
      VALUES (?, ?, 'status_changed', 'in_lib', 'series_only', datetime('now', ?))
    `);
    for (let i = 0; i < 5; i++) ins.run('CERT1', `GB/T ${i}-2020`, `-${i} minutes`);

    const changes = svc.changesForLab('CERT1', 90, 0)!;
    expect(changes.events).toHaveLength(5);
  });

  it('changesForLab 只统计窗口内的事件', () => {
    const svc = new CapLibService(db);
    const ins = db.prepare(`
      INSERT INTO cma_diff_change_events
        (cert_number, std_code, change_type, from_status, to_status, changed_at)
      VALUES (?, ?, 'status_changed', 'in_lib', 'series_only', datetime('now', ?))
    `);
    ins.run('CERT1', 'GB/T 1-2020', '-10 days');   // 窗口内
    ins.run('CERT1', 'GB/T 2-2020', '-200 days'); // 窗口外

    const changes = svc.changesForLab('CERT1', 90, 50)!;
    expect(changes.totalEvents).toBe(1);
    expect(changes.events[0].stdCode).toBe('GB/T 1-2020');
  });

  it('labsCounts 附带 changes 块', () => {
    const svc = new CapLibService(db);
    db.prepare(`INSERT INTO cma_labs (cert_number, lab_name, subscribed_at) VALUES ('CERT1', '测试院', datetime('now'))`).run();
    const ins = db.prepare(`
      INSERT INTO cma_diff_change_events
        (cert_number, std_code, change_type, from_status, to_status, changed_at)
      VALUES (?, ?, 'status_changed', 'in_lib', 'abolished', datetime('now'))
    `);
    ins.run('CERT1', 'GB/T 1-2020');

    const items = svc.labsCounts();
    expect(items).toHaveLength(1);
    expect(items[0].changes).not.toBeNull();
    expect(items[0].changes!.deltaByStatus.abolished).toBe(1);
  });
});
