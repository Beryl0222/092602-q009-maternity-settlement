import test from "node:test";
import assert from "node:assert/strict";
import { seededService, POLICY_V2 } from "./helpers.js";

function settledWithAllowance() {
  const service = seededService();
  service.settleCase("CASE-001");
  const app = service.applyAllowance({
    application_id: "AL-001", business_no: "BIZ-1", case_id: "CASE-001",
    person_id: "P-1001", idempotency_key: "cb-1",
  });
  return { service, app };
}

test("津贴金额缺省时按冻结快照计算", () => {
  const { app } = settledWithAllowance();
  assert.equal(app.amount_cents, 30000 * 98);
  assert.equal(app.state, "approved");
});

test("申请重试与医院回调返回原结果", () => {
  const { service, app } = settledWithAllowance();
  const retry = service.applyAllowance({
    application_id: "AL-001", business_no: "BIZ-1", case_id: "CASE-001",
    person_id: "P-1001", idempotency_key: "cb-1",
  });
  assert.equal(retry, app);
  const paid = service.payAllowance("AL-001");
  const again = service.payAllowance("AL-001");
  assert.equal(again, paid);
  assert.equal(paid.chain.length, 1);
});

test("同一业务号金额冲突时停止支付", () => {
  const { service } = settledWithAllowance();
  const conflict = service.applyAllowance({
    application_id: "AL-002", business_no: "BIZ-1", case_id: "CASE-001",
    person_id: "P-1001", amount_cents: 12345, idempotency_key: "cb-2",
  });
  assert.equal(conflict.state, "halted");
  assert.equal(service.getAllowance("AL-001").state, "halted");
  assert.throws(() => service.payAllowance("AL-001"), /停止支付/);
  assert.throws(() => service.payAllowance("AL-002"), /停止支付/);
});

test("已到账津贴的追溯调整走冲正链", () => {
  const { service } = settledWithAllowance();
  service.payAllowance("AL-001");
  const { allowance_adjustments } = service.recalculate("CASE-001", POLICY_V2);
  assert.equal(allowance_adjustments.length, 1);
  const adjusted = service.getAllowance("AL-001");
  assert.equal(adjusted.state, "paid");
  assert.deepEqual(adjusted.chain.map((e) => e.type), ["payment", "reversal", "reissue"]);
  assert.deepEqual(adjusted.chain.map((e) => e.amount_cents), [30000 * 98, -30000 * 98, 30000 * 113]);
  assert.equal(adjusted.amount_cents, 30000 * 113);
});

test("仅已支付津贴可冲正", () => {
  const { service } = settledWithAllowance();
  assert.throws(() => service.reverseAllowance("AL-001", "测试"), /冲正/);
});
