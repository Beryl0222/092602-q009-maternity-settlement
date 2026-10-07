import { SettlementService } from "../src/service.js";

export const POLICY_V1 = {
  policy_id: "POL-HN",
  region_id: "henan",
  version: 1,
  effective_from: "2026-01-01T00:00:00Z",
  basic_package: {
    package_id: "PKG-BASIC",
    covered_categories: ["delivery", "ward", "routine_check"],
    zero_self_pay: true,
  },
  complication_groups: [
    { group_id: "CG-HEM", categories: ["hemorrhage_care"], fund_ratio: 0.9 },
  ],
  allowance: { daily_base_cents: 30000, days: 98, direct_payment: true },
};

export const POLICY_V2 = {
  ...POLICY_V1,
  version: 2,
  complication_groups: [
    { group_id: "CG-HEM", categories: ["hemorrhage_care"], fund_ratio: 0.8 },
  ],
  allowance: { daily_base_cents: 30000, days: 113, direct_payment: true },
};

export const ENROLLMENT = {
  enrollment_id: "ENR-001",
  person_id: "P-1001",
  region_id: "henan",
  category: "employee",
  start: "2025-01-01T00:00:00Z",
  end: "2027-12-31T00:00:00Z",
};

export const CASE = {
  case_id: "CASE-001",
  person_id: "P-1001",
  hospital_id: "H-3201",
  treat_region_id: "jiangsu",
  admitted_at: "2026-03-01T08:00:00Z",
  discharged_at: "2026-03-05T10:00:00Z",
  delivery_type: "cesarean",
};

export const CHARGES = [
  { charge_id: "C-001", case_id: "CASE-001", category: "delivery", amount_cents: 500000, entered_by: "recorder-1" },
  { charge_id: "C-002", case_id: "CASE-001", category: "ward", amount_cents: 200000, entered_by: "recorder-1" },
  { charge_id: "C-003", case_id: "CASE-001", category: "hemorrhage_care", amount_cents: 100000, entered_by: "recorder-1" },
  { charge_id: "C-004", case_id: "CASE-001", category: "vip_service", amount_cents: 50000, entered_by: "recorder-1" },
];

export function seededService({ preAuth = null } = {}) {
  const service = new SettlementService();
  service.registerEnrollment(ENROLLMENT);
  service.registerPolicyVersion(POLICY_V1);
  service.openCase(CASE);
  if (preAuth) service.authorize(preAuth);
  for (const charge of CHARGES) service.addCharge(charge);
  return service;
}
