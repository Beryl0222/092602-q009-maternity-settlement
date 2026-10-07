import test from "node:test";
import assert from "node:assert/strict";
import { seededService, POLICY_V2 } from "./helpers.js";

test("说明每笔费用为何由哪一方承担", () => {
  const service = seededService();
  service.settleCase("CASE-001");
  const basic = service.explainCharge("C-001");
  assert.equal(basic.allocations[0].payer_label, "统筹基金");
  assert.match(basic.allocations[0].reason, /零自付/);
  const vip = service.explainCharge("C-004");
  assert.equal(vip.allocations[0].payer_label, "个人现金");
  assert.match(vip.allocations[0].reason, /服务包外/);
  const hemo = service.explainCharge("C-003");
  assert.equal(hemo.allocations.length, 2);
  assert.equal(hemo.allocations.find((a) => a.payer === "fund").amount_cents, 90000);
  assert.equal(hemo.allocations.find((a) => a.payer === "personal").amount_cents, 10000);
});

test("说明政策更新改变了什么", () => {
  const service = seededService();
  service.settleCase("CASE-001");
  const none = service.explainPolicyChange("CASE-001");
  assert.equal(none.changed, false);
  service.recalculate("CASE-001", POLICY_V2);
  const diff = service.explainPolicyChange("CASE-001");
  assert.equal(diff.changed, true);
  assert.equal(diff.policy_from.version, 1);
  assert.equal(diff.policy_to.version, 2);
  const hemo = diff.affected_entries.find((a) => a.charge_id === "C-003" && a.payer === "fund");
  assert.equal(hemo.before_cents, 90000);
  assert.equal(hemo.after_cents, 80000);
});

test("说明家庭尚可获得哪些款项", () => {
  const service = seededService();
  service.settleCase("CASE-001");
  service.applyAllowance({ application_id: "AL-1", business_no: "BIZ-9", case_id: "CASE-001", person_id: "P-1001" });
  let statement = service.familyStatement("P-1001");
  assert.equal(statement.receivable_cents, 30000 * 98);
  assert.equal(statement.paid_cents, 0);
  service.payAllowance("AL-1");
  statement = service.familyStatement("P-1001");
  assert.equal(statement.receivable_cents, 0);
  assert.equal(statement.paid_cents, 30000 * 98);
  assert.equal(statement.open_disputes, 0);
});
