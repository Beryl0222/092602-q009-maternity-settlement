import test from "node:test";
import assert from "node:assert/strict";
import { seededService } from "./helpers.js";

const PREAUTH = { auth_id: "PA-001", case_id: "CASE-001", categories: ["delivery", "ward"], limit_cents: null };

test("预授权范围外的基金费用需要例外审批", () => {
  const service = seededService({ preAuth: PREAUTH });
  const s = service.settleCase("CASE-001");
  assert.equal(s.state, "pending_exception");
  const flagged = s.entries.filter((e) => e.requires_exception);
  assert.ok(flagged.length > 0);
  assert.ok(flagged.every((e) => e.payer === "fund"));
});

test("录入费用的人不得批准例外", () => {
  const service = seededService({ preAuth: PREAUTH });
  service.settleCase("CASE-001");
  assert.throws(() => service.approveException("STL-CASE-001", "recorder-1"), /不得批准例外/);
  const approved = service.approveException("STL-CASE-001", "manager-2");
  assert.equal(approved.state, "settled");
  assert.equal(approved.exception_approval.approver, "manager-2");
});

test("预授权范围内且限额内无需例外", () => {
  const service = seededService({
    preAuth: { auth_id: "PA-002", case_id: "CASE-001", categories: ["delivery", "ward", "hemorrhage_care"], limit_cents: 2000000 },
  });
  const s = service.settleCase("CASE-001");
  assert.equal(s.state, "settled");
});

test("超出预授权限额需要例外审批", () => {
  const service = seededService({
    preAuth: { auth_id: "PA-003", case_id: "CASE-001", categories: ["delivery", "ward", "hemorrhage_care"], limit_cents: 100000 },
  });
  const s = service.settleCase("CASE-001");
  assert.equal(s.state, "pending_exception");
  assert.equal(s.over_limit, true);
});
