import test from "node:test";
import assert from "node:assert/strict";
import { seededService } from "./helpers.js";

test("未知人员类别被拒绝", () => {
  const service = seededService();
  assert.throws(
    () => service.registerEnrollment({
      enrollment_id: "ENR-X", person_id: "P-9", region_id: "henan",
      category: "tourist", start: "2026-01-01", end: "2026-12-31",
    }),
    /人员类别/,
  );
});

test("费用金额必须是正的整数分", () => {
  const service = seededService();
  assert.throws(
    () => service.addCharge({ charge_id: "C-BAD", case_id: "CASE-001", category: "ward", amount_cents: 10.5, entered_by: "recorder-1" }),
    /整数/,
  );
  assert.throws(
    () => service.addCharge({ charge_id: "C-BAD2", case_id: "CASE-001", category: "ward", amount_cents: -100, entered_by: "recorder-1" }),
    /必须为正/,
  );
});

test("基础服务包必须覆盖至少一个费用类目", () => {
  const service = seededService();
  assert.throws(
    () => service.registerPolicyVersion({
      policy_id: "POL-X", region_id: "henan", version: 1,
      effective_from: "2026-01-01", basic_package: { package_id: "PKG-X", covered_categories: [] },
    }),
    /至少覆盖一个费用类目/,
  );
});

test("就医期间无参保关系或无适用政策时无法结算", () => {
  const service = seededService();
  service.openCase({
    case_id: "CASE-404", person_id: "P-UNKNOWN", hospital_id: "H-1", treat_region_id: "jiangsu",
    admitted_at: "2026-03-01T00:00:00Z", discharged_at: "2026-03-02T00:00:00Z", delivery_type: "vaginal",
  });
  service.addCharge({ charge_id: "C-404", case_id: "CASE-404", category: "delivery", amount_cents: 1000, entered_by: "recorder-1" });
  assert.throws(() => service.settleCase("CASE-404"), /无有效参保关系/);
});
