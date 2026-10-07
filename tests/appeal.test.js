import test from "node:test";
import assert from "node:assert/strict";
import { seededService } from "./helpers.js";

test("申诉登记后可在未决争议中查询，办结后消失", () => {
  const service = seededService();
  service.settleCase("CASE-001");
  service.fileAppeal({
    appeal_id: "AP-1", case_id: "CASE-001", person_id: "P-1001",
    target_type: "entry", target_id: "STL-CASE-001:C-003:fund",
    filed_at: "2026-03-20T00:00:00Z", deadline_days: 10,
  });
  const disputes = service.openDisputes({ person_id: "P-1001" });
  assert.equal(disputes.length, 1);
  assert.equal(disputes[0].deadline_at, "2026-03-30T00:00:00.000Z");
  service.resolveAppeal("AP-1", "维持原结算");
  assert.equal(service.openDisputes({ person_id: "P-1001" }).length, 0);
});

test("服务故障恢复后申诉与待结算时限顺延", () => {
  const service = seededService();
  service.fileAppeal({
    appeal_id: "AP-2", case_id: "CASE-001", person_id: "P-1001",
    target_type: "settlement", target_id: "STL-CASE-001",
    filed_at: "2026-03-20T00:00:00Z", deadline_days: 10,
  });
  assert.equal(service.getCase("CASE-001").settlement_due_at, "2026-04-04T10:00:00.000Z");
  const result = service.recordOutage({
    outage_id: "OUT-1", started_at: "2026-03-22T00:00:00Z", recovered_at: "2026-03-24T00:00:00Z",
  });
  assert.equal(result.extended_appeals.length, 1);
  assert.equal(result.extended_cases.length, 1);
  const appeal = result.extended_appeals[0];
  assert.equal(appeal.deadline_at, "2026-04-01T00:00:00.000Z");
  assert.equal(appeal.extensions[0].added_ms, 2 * 24 * 60 * 60 * 1000);
  assert.equal(service.getCase("CASE-001").settlement_due_at, "2026-04-06T10:00:00.000Z");
});
