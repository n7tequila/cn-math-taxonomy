#!/usr/bin/env node
/* 档案导出测试：node tests/test_children.js（无依赖，不访问真实浏览器存储）。 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/children.js'), 'utf8');
const PROFILE_KEY = 'cnmChildren.v1';
const RECORD_KEY = 'cnmChildren.records.v1';
let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log('  ok   ' + name);
}

function load(entries, failKey) {
  const storage = new Map(Object.entries(entries || {}));
  const writes = [];
  const context = {
    window: {},
    localStorage: {
      getItem(key) {
        if (key === failKey) throw new Error('Storage access denied');
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) { writes.push(key); storage.set(key, value); }
    }
  };
  vm.runInNewContext(source, context, { filename: 'assets/children.js' });
  return { api: context.window.CnmChildren, storage, writes };
}

function exported(api) { return JSON.parse(JSON.stringify(api.exportBackup())); }
const profiles = {
  v: 1, current: 'child-b', children: [
    { id: 'child-a', name: '小满', grade: '三年级', textbook: '人教版', createdAt: '2026-10-01T00:00:00.000Z' },
    { id: 'child-b', name: '小禾', grade: '五年级', textbook: '沪教版', createdAt: '2026-10-02T00:00:00.000Z' }
  ]
};
const records = {
  'child-a': ['math', 'chinese', 'english', 'physics'].map((subject, i) => ({
    key: subject + '|seed|target', subject, label: '测试范围 ' + i, mode: 'target', asked: 8,
    targets: ['topic-' + i], counts: { weak: 1, shaky: 1, mastered: 1, untested: 2 },
    weak: ['weak-' + i], roots: ['weak-' + i], shaky: ['shaky-' + i], mastered: ['mastered-' + i],
    savedAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z'
  })),
  'child-b': [{ key: 'screen|seed|targets', subject: 'math', mode: 'screen', targets: null, weak: [] }]
};
function fixture() {
  return { [PROFILE_KEY]: JSON.stringify(profiles), [RECORD_KEY]: JSON.stringify(records) };
}

test('导出包含全部孩子、当前孩子和四学科完整历史，并带备份版本和时间', () => {
  const { api } = load(fixture());
  const before = Date.now();
  const backup = exported(api);
  assert.equal(backup.format, 'cn-math-taxonomy.children');
  assert.equal(backup.version, 1);
  assert.ok(Date.parse(backup.exportedAt) >= before && Date.parse(backup.exportedAt) <= Date.now());
  assert.deepStrictEqual(backup.profiles, profiles);
  assert.deepStrictEqual(backup.records, records);
});

test('导出不改写存储、当前孩子或记录时间', () => {
  const entries = fixture();
  const { api, storage, writes } = load(entries);
  api.exportBackup();
  assert.deepStrictEqual(Object.fromEntries(storage), entries);
  assert.deepStrictEqual(writes, []);
});

test('保留未选择当前孩子、未知扩展字段和超过 40 条的已存历史', () => {
  const entries = fixture();
  const extraProfiles = { ...profiles, current: null, futureMetadata: { note: '保留' } };
  const extraRecords = { 'child-a': Array.from({ length: 45 }, (_, i) => ({ key: 'record-' + i, extra: i })) };
  entries[PROFILE_KEY] = JSON.stringify(extraProfiles);
  entries[RECORD_KEY] = JSON.stringify(extraRecords);
  const backup = exported(load(entries).api);
  assert.deepStrictEqual(backup.profiles, extraProfiles);
  assert.deepStrictEqual(backup.records, extraRecords);
});

test('有孩子但没有诊断记录时仍能备份资料', () => {
  const backup = exported(load({ [PROFILE_KEY]: JSON.stringify(profiles) }).api);
  assert.deepStrictEqual(backup.profiles, profiles);
  assert.deepStrictEqual(backup.records, {});
});

test('只导出档案和历史，不混入会话、统计或其他站点存储', () => {
  const entries = { ...fixture(), unrelated: 'private', 'cnmDiagnose.session.v2': '{"seed":"x"}', 'cnmStats.v1': '{}' };
  const backup = exported(load(entries).api);
  assert.deepStrictEqual(Object.keys(backup).sort(), ['exportedAt', 'format', 'profiles', 'records', 'version']);
  assert.ok(!JSON.stringify(backup).includes('private'));
});

test('每次读取最新数据，修改导出快照不会污染已存档案', () => {
  const { api, storage } = load(fixture());
  const backup = api.exportBackup();
  backup.profiles.children[0].name = '修改快照';
  backup.records['child-a'][0].weak.push('extra');
  assert.deepStrictEqual(exported(api).profiles, profiles);
  assert.deepStrictEqual(exported(api).records, records);
  const next = { ...profiles, current: 'child-a' };
  storage.set(PROFILE_KEY, JSON.stringify(next));
  assert.deepStrictEqual(exported(api).profiles, next);
});

test('没有孩子时不生成无意义的空备份', () => {
  assert.throws(() => load().api.exportBackup(), /还没有可导出/);
  assert.throws(() => load({ [PROFILE_KEY]: '{"v":1,"current":null,"children":[]}' }).api.exportBackup(), /还没有可导出/);
});

test('读取任一存储键失败时报告错误，不使用空数据兜底', () => {
  for (const key of [PROFILE_KEY, RECORD_KEY]) {
    const { api, writes } = load(fixture(), key);
    assert.throws(() => api.exportBackup(), /无法读取档案数据/);
    assert.deepStrictEqual(writes, []);
  }
});

test('任一 JSON 损坏时拒绝生成部分备份', () => {
  for (const key of [PROFILE_KEY, RECORD_KEY]) {
    assert.throws(() => load({ ...fixture(), [key]: '{broken' }).api.exportBackup(), /无法读取档案数据/);
  }
});

test('拒绝异常结构，避免静默丢失档案或历史', () => {
  for (const value of [null, [], {}, { children: [null] }, { children: [{ id: '' }] }]) {
    assert.throws(() => load({ ...fixture(), [PROFILE_KEY]: JSON.stringify(value) }).api.exportBackup(), /格式异常/);
  }
  for (const value of [null, [], 'bad', { 'child-a': {} }]) {
    assert.throws(() => load({ ...fixture(), [RECORD_KEY]: JSON.stringify(value) }).api.exportBackup(), /格式异常/);
  }
});

console.log('\n' + passed + ' passed, 0 failed');
