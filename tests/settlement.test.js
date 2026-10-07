import test from "node:test";
import assert from "node:assert/strict";
import { seededService, POLICY_V2, CHARGES } from "./helpers.js";

test("结算冻结政策快照并拆分基金与个人责任", () => {
  const service = seededService();
  const s = service.settleCase("CASE-001");
  assert.equal(s.state, "settled");
  assert.equal(s.totals.total_cents, 850000);
  assert.equal(s.totals.fund_cents, 790000);
  assert.equal(s.totals.personal_cents, 60000);
  assert.equal(s.policy_snapshot.version, 1);
  assert.equal(s.policy_snapshot.home_region_id, "henan");
  assert.equal(s.policy_snapshot.treat_region_id, "jiangsu");
  assert.equal(s.policy_snapshot.person_category, "employee");
});

test("总额守恒：分录合计等于费用合计", () => {
  const service = seededService();
  const s = service.settleCase("CASE-001");
  const chargeSum = CHARGES.reduce((sum, c) => sum + c.amount_cents, 0);
  assert.equal(s.totals.total_cents, chargeSum);
  assert.equal(s.totals.fund_cents + s.totals.personal_cents, s.totals.total_cents);
  for (const charge of CHARGES) {
    const entries = s.entries.filter((e) => e.charge_id === charge.charge_id);
    assert.equal(entries.reduce((sum, e) => sum + e.amount_cents, 0), charge.amount_cents);
  }
});

test("奇数金额按比例拆分时仍保持守恒", () => {
  const service = seededService();
  service.addCharge({ charge_id: "C-009", case_id: "CASE-001", category: "hemorrhage_care", amount_cents: 999, entered_by: "recorder-1" });
  const s = service.settleCase("CASE-001");
  const entries = s.entries.filter((e) => e.charge_id === "C-009");
  assert.equal(entries.reduce((sum, e) => sum + e.amount_cents, 0), 999);
});

test("服务包外费用不享受零自付", () => {
  const service = seededService();
  const s = service.settleCase("CASE-001");
  const vip = s.entries.filter((e) => e.charge_id === "C-004");
  assert.equal(vip.length, 1);
  assert.equal(vip[0].payer, "personal");
  assert.equal(vip[0].component, "out_of_package");
  // 基金承担的费用必须来自基础包或并发症分组
  const covered = new Set(["delivery", "ward", "routine_check", "hemorrhage_care"]);
  for (const e of s.entries) {
    if (e.payer !== "fund") continue;
    const charge = CHARGES.find((c) => c.charge_id === e.charge_id);
    assert.ok(covered.has(charge.category), `基金不应承担包外费用：${charge.category}`);
  }
});

test("医院回调重试返回原结算结果", () => {
  const service = seededService();
  const first = service.settleCase("CASE-001");
  const second = service.settleCase("CASE-001");
  assert.equal(second, first);
});

test("结算后登记新政策不影响已冻结的分录", () => {
  const service = seededService();
  const before = service.settleCase("CASE-001");
  service.registerPolicyVersion(POLICY_V2);
  const again = service.settleCase("CASE-001");
  assert.equal(again, before);
  assert.equal(again.totals.fund_cents, 790000);
});

test("异地重算只调整受影响分录", () => {
  const service = seededService();
  const before = service.settleCase("CASE-001");
  const { settlement: after } = service.recalculate("CASE-001", POLICY_V2);
  assert.equal(after.version, 2);
  assert.equal(after.totals.fund_cents, 780000);
  assert.equal(after.totals.personal_cents, 70000);
  assert.equal(after.totals.total_cents, 850000);
  const beforeBy = new Map(before.entries.map((e) => [e.entry_id, e]));
  const afterBy = new Map(after.entries.map((e) => [e.entry_id, e]));
  // 未受影响分录保持原对象与版本
  assert.equal(afterBy.get("STL-CASE-001:C-001:fund"), beforeBy.get("STL-CASE-001:C-001:fund"));
  assert.equal(afterBy.get("STL-CASE-001:C-004:personal"), beforeBy.get("STL-CASE-001:C-004:personal"));
  // 受影响分录版本递增、金额更新
  const hemo = afterBy.get("STL-CASE-001:C-003:fund");
  assert.equal(hemo.revision, 2);
  assert.equal(hemo.amount_cents, 80000);
  assert.equal(after.history.length, 1);
  assert.equal(after.history[0].changed.length, 2);
});
