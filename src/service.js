/** 分娩保障跨域结算的应用服务入口。 */
import {
  createRecord, createEnrollment, createPolicyVersion, openCase, createCharge,
  createPreAuthorization, deepFreeze, parseTime, requireFields, DAY_MS,
} from "./domain.js";
import { Repository, LedgerStore } from "./repository.js";
import {
  selectPolicyVersion, freezeSnapshot, buildEntries, summarize, assertConservation, diffEntries,
} from "./settlement.js";
import { AllowanceLedger } from "./allowance.js";
import { AppealBook } from "./appeal.js";

/** 基础登记服务（保留原有能力）。 */
export class Service {
  constructor(repository = new Repository()) { this.repository = repository; }
  health() { return { service: "maternity_settlement", status: "ok" }; }
  register(payload) { return this.repository.add(createRecord(payload)); }
  find(recordId) { return this.repository.get(String(recordId)); }
}

/** 待结算时限：出院后 30 天。 */
const SETTLEMENT_DUE_DAYS = 30;

const PAYER_LABELS = Object.freeze({ fund: "统筹基金", personal: "个人现金" });
const COMPONENT_LABELS = Object.freeze({ basic: "基础分娩服务包", complication: "并发症分组", out_of_package: "服务包外" });

/** 跨域结算簿服务：结算、重算、津贴、申诉与说明接口。 */
export class SettlementService {
  constructor(store = new LedgerStore()) {
    this.store = store;
    this.allowanceLedger = new AllowanceLedger(store);
    this.appealBook = new AppealBook(store);
  }

  health() { return { service: "maternity_settlement_ledger", status: "ok" }; }

  // —— 登记 ——

  registerEnrollment(payload) {
    const enrollment = createEnrollment(payload);
    return this.store.add("enrollments", enrollment.enrollment_id, enrollment);
  }

  registerPolicyVersion(payload) {
    const policy = createPolicyVersion(payload);
    return this.store.add("policies", `${policy.policy_id}@${policy.version}`, policy);
  }

  openCase(payload) {
    const caseInfo = openCase(payload);
    const dueAt = new Date(Date.parse(caseInfo.discharged_at) + SETTLEMENT_DUE_DAYS * DAY_MS).toISOString();
    return this.store.add("cases", caseInfo.case_id, deepFreeze({ ...caseInfo, settlement_due_at: dueAt }));
  }

  addCharge(payload) {
    const charge = createCharge(payload);
    if (!this.store.get("cases", charge.case_id)) throw new Error(`就医案例不存在：${charge.case_id}`);
    return this.store.add("charges", charge.charge_id, charge);
  }

  authorize(payload) {
    const preAuth = createPreAuthorization(payload);
    if (!this.store.get("cases", preAuth.case_id)) throw new Error(`就医案例不存在：${preAuth.case_id}`);
    return this.store.add("preauths", preAuth.auth_id, preAuth);
  }

  // —— 结算 ——

  /** 结算：冻结就医期间适用的政策快照；医院回调重试返回原结果。 */
  settleCase(caseId, at = new Date().toISOString()) {
    const existing = this.store.all("settlements").find((s) => s.case_id === String(caseId));
    if (existing) return existing;
    const caseInfo = this.store.get("cases", caseId);
    if (!caseInfo) throw new Error(`就医案例不存在：${caseId}`);
    const charges = this.store.all("charges").filter((c) => c.case_id === caseInfo.case_id);
    if (!charges.length) throw new Error("无费用明细，无法结算");
    const enrollment = this.store.all("enrollments").find((e) => e.person_id === caseInfo.person_id
      && Date.parse(e.start) <= Date.parse(caseInfo.admitted_at)
      && Date.parse(caseInfo.admitted_at) <= Date.parse(e.end));
    if (!enrollment) throw new Error("就医期间无有效参保关系");
    const policy = selectPolicyVersion(this.store.all("policies"), enrollment.region_id, caseInfo.admitted_at);
    const snapshot = freezeSnapshot({
      policy,
      homeRegionId: enrollment.region_id,
      treatRegionId: caseInfo.treat_region_id,
      personCategory: enrollment.category,
    });
    const preAuth = this.store.all("preauths").find((a) => a.case_id === caseInfo.case_id) ?? null;
    const settlementId = `STL-${caseInfo.case_id}`;
    const entries = buildEntries({ settlementId, charges, snapshot, preAuth });
    assertConservation(charges, entries);
    const totals = summarize(entries);
    const overLimit = preAuth?.limit_cents != null && totals.fund_cents > preAuth.limit_cents;
    const needsException = overLimit || entries.some((e) => e.requires_exception);
    const settlement = deepFreeze({
      settlement_id: settlementId,
      case_id: caseInfo.case_id,
      person_id: caseInfo.person_id,
      policy_snapshot: snapshot,
      entries: deepFreeze(entries),
      totals,
      over_limit: overLimit,
      exception_approval: null,
      state: needsException ? "pending_exception" : "settled",
      version: 1,
      history: deepFreeze([]),
      created_at: at,
    });
    this.store.add("settlements", settlement.settlement_id, settlement);
    this.store.put("cases", caseInfo.case_id, deepFreeze({ ...caseInfo, state: settlement.state }));
    return settlement;
  }

  /** 例外审批：录入费用的人不得批准例外（职责分离）。 */
  approveException(settlementId, approver, at = new Date().toISOString()) {
    const settlement = this.store.get("settlements", settlementId);
    if (!settlement) throw new Error(`结算不存在：${settlementId}`);
    if (settlement.state !== "pending_exception") return settlement;
    const charges = this.store.all("charges").filter((c) => c.case_id === settlement.case_id);
    const flaggedIds = new Set(settlement.entries.filter((e) => e.requires_exception).map((e) => e.charge_id));
    const enterers = new Set();
    for (const charge of charges) {
      if (flaggedIds.has(charge.charge_id) || settlement.over_limit) enterers.add(charge.entered_by);
    }
    if (enterers.has(String(approver))) throw new Error("录入费用的人不得批准例外");
    const updated = deepFreeze({
      ...settlement,
      state: "settled",
      exception_approval: deepFreeze({ approver: String(approver), approved_at: at }),
    });
    this.store.put("settlements", updated.settlement_id, updated);
    const caseInfo = this.store.get("cases", settlement.case_id);
    this.store.put("cases", caseInfo.case_id, deepFreeze({ ...caseInfo, state: "settled" }));
    return updated;
  }

  /** 异地重算：只调整受影响分录，未受影响分录保持原样；已到账津贴走冲正链。 */
  recalculate(caseId, policyPayload, at = new Date().toISOString()) {
    const settlement = this.store.all("settlements").find((s) => s.case_id === String(caseId));
    if (!settlement) throw new Error(`案例未结算：${caseId}`);
    const key = `${policyPayload.policy_id}@${policyPayload.version}`;
    const policy = this.store.get("policies", key) ?? this.registerPolicyVersion(policyPayload);
    const snapshot = freezeSnapshot({
      policy,
      homeRegionId: settlement.policy_snapshot.home_region_id,
      treatRegionId: settlement.policy_snapshot.treat_region_id,
      personCategory: settlement.policy_snapshot.person_category,
    });
    const charges = this.store.all("charges").filter((c) => c.case_id === settlement.case_id);
    const preAuth = this.store.all("preauths").find((a) => a.case_id === settlement.case_id) ?? null;
    const revisionOf = new Map();
    for (const e of settlement.entries) revisionOf.set(e.entry_id, Math.max(revisionOf.get(e.entry_id) ?? 0, e.revision));
    const fresh = buildEntries({ settlementId: settlement.settlement_id, charges, snapshot, preAuth, revisionOf });
    assertConservation(charges, fresh);
    const diff = diffEntries(settlement.entries, fresh);
    const entries = [...diff.kept, ...diff.changed.map((c) => c.after), ...diff.added]
      .sort((a, b) => a.entry_id.localeCompare(b.entry_id));
    const totals = summarize(entries);
    const overLimit = preAuth?.limit_cents != null && totals.fund_cents > preAuth.limit_cents;
    const needsException = overLimit || entries.some((e) => e.requires_exception);
    const historyEntry = deepFreeze({
      version: settlement.version + 1,
      policy_from: deepFreeze({ policy_id: settlement.policy_snapshot.policy_id, version: settlement.policy_snapshot.version }),
      policy_to: deepFreeze({ policy_id: policy.policy_id, version: policy.version }),
      changed: deepFreeze(diff.changed),
      added: deepFreeze(diff.added),
      removed: deepFreeze(diff.removed),
      at,
    });
    const updated = deepFreeze({
      ...settlement,
      policy_snapshot: snapshot,
      entries: deepFreeze(entries),
      totals,
      over_limit: overLimit,
      state: needsException && !settlement.exception_approval ? "pending_exception" : "settled",
      version: settlement.version + 1,
      history: deepFreeze([...settlement.history, historyEntry]),
    });
    this.store.put("settlements", updated.settlement_id, updated);
    const allowanceAdjustments = this.#syncAllowances(updated);
    return deepFreeze({ settlement: updated, allowance_adjustments: deepFreeze(allowanceAdjustments) });
  }

  /** 政策追溯调整津贴：已到账的冲正后重发，未支付的直接改额。 */
  #syncAllowances(settlement) {
    const rule = settlement.policy_snapshot.allowance;
    if (!rule) return [];
    const entitlement = rule.daily_base_cents * rule.days;
    const adjustments = [];
    for (const app of this.store.all("allowances")) {
      if (app.case_id !== settlement.case_id) continue;
      if (app.state === "paid" && AllowanceLedger.netPaid(app) !== entitlement) {
        adjustments.push(this.allowanceLedger.adjust(app.application_id, entitlement, "政策追溯调整"));
      } else if (app.state === "approved" && app.amount_cents !== entitlement) {
        adjustments.push(this.allowanceLedger.adjust(app.application_id, entitlement, "政策追溯调整"));
      }
    }
    return adjustments;
  }

  // —— 津贴 ——

  /** 津贴申请：金额缺省时按冻结快照的津贴规则计算；重试返回原结果。 */
  applyAllowance(input) {
    let amount = input.amount_cents;
    if (amount === undefined || amount === null) {
      const settlement = this.store.all("settlements").find((s) => s.case_id === String(input.case_id));
      if (!settlement) throw new Error(`案例未结算：${input.case_id}`);
      const rule = settlement.policy_snapshot.allowance;
      if (!rule) throw new Error("适用政策不包含津贴规则");
      amount = rule.daily_base_cents * rule.days;
    }
    return this.allowanceLedger.apply({ ...input, amount_cents: amount });
  }

  payAllowance(applicationId) { return this.allowanceLedger.pay(applicationId); }
  reverseAllowance(applicationId, reason) { return this.allowanceLedger.reverse(applicationId, reason); }
  getAllowance(applicationId) { return this.store.get("allowances", applicationId); }

  // —— 申诉与故障恢复 ——

  fileAppeal(input) { return this.appealBook.file(input); }
  resolveAppeal(appealId, resolution) { return this.appealBook.resolve(appealId, resolution); }

  /** 服务故障恢复：待结算时限与申诉时限按故障时长顺延。 */
  recordOutage(input) {
    requireFields(input, ["outage_id", "started_at", "recovered_at"]);
    const startedAt = parseTime(input.started_at, "故障开始时间");
    const recoveredAt = parseTime(input.recovered_at, "故障恢复时间");
    if (Date.parse(recoveredAt) < Date.parse(startedAt)) throw new Error("故障恢复时间早于开始时间");
    const outage = deepFreeze({
      outage_id: String(input.outage_id),
      started_at: startedAt,
      recovered_at: recoveredAt,
      duration_ms: Date.parse(recoveredAt) - Date.parse(startedAt),
    });
    this.store.recordOutage(outage);
    const extendedAppeals = this.appealBook.extendForOutage(outage);
    const extendedCases = [];
    for (const caseInfo of this.store.all("cases")) {
      if (caseInfo.state === "settled") continue;
      const updated = deepFreeze({
        ...caseInfo,
        settlement_due_at: new Date(Date.parse(caseInfo.settlement_due_at) + outage.duration_ms).toISOString(),
      });
      this.store.put("cases", caseInfo.case_id, updated);
      extendedCases.push(updated);
    }
    return deepFreeze({
      outage,
      extended_appeals: deepFreeze(extendedAppeals),
      extended_cases: deepFreeze(extendedCases),
    });
  }

  // —— 说明接口 ——

  /** 说明每笔费用为何由哪一方承担。 */
  explainCharge(chargeId) {
    const charge = this.store.get("charges", chargeId);
    if (!charge) throw new Error(`费用不存在：${chargeId}`);
    const settlement = this.store.all("settlements").find((s) => s.case_id === charge.case_id);
    if (!settlement) {
      return { charge_id: charge.charge_id, case_id: charge.case_id, status: "未结算", allocations: [] };
    }
    const allocations = settlement.entries.filter((e) => e.charge_id === charge.charge_id).map((e) => ({
      payer: e.payer,
      payer_label: PAYER_LABELS[e.payer],
      component: e.component,
      component_label: COMPONENT_LABELS[e.component],
      amount_cents: e.amount_cents,
      reason: e.reason,
      rule_ref: e.rule_ref,
      policy_version: settlement.policy_snapshot.version,
    }));
    return {
      charge_id: charge.charge_id,
      case_id: charge.case_id,
      category: charge.category,
      amount_cents: charge.amount_cents,
      status: "已结算",
      allocations,
    };
  }

  /** 说明政策更新改变了什么。 */
  explainPolicyChange(caseId) {
    const settlement = this.store.all("settlements").find((s) => s.case_id === String(caseId));
    if (!settlement) throw new Error(`案例未结算：${caseId}`);
    if (!settlement.history.length) {
      return {
        case_id: settlement.case_id,
        changed: false,
        message: "结算后未发生政策更新",
        current_version: settlement.policy_snapshot.version,
      };
    }
    const last = settlement.history[settlement.history.length - 1];
    return {
      case_id: settlement.case_id,
      changed: true,
      policy_from: last.policy_from,
      policy_to: last.policy_to,
      affected_entries: last.changed.map((c) => ({
        charge_id: c.before.charge_id,
        payer: c.before.payer,
        before_cents: c.before.amount_cents,
        after_cents: c.after.amount_cents,
        before_rule: c.before.rule_ref,
        after_rule: c.after.rule_ref,
      })),
      added_entries: last.added.map((e) => ({ charge_id: e.charge_id, payer: e.payer, amount_cents: e.amount_cents })),
      removed_entries: last.removed.map((e) => ({ charge_id: e.charge_id, payer: e.payer, amount_cents: e.amount_cents })),
      totals: settlement.totals,
    };
  }

  /** 说明家庭尚可获得哪些款项。 */
  familyStatement(personId) {
    const items = this.store.all("allowances")
      .filter((a) => a.person_id === String(personId))
      .map((a) => ({
        application_id: a.application_id,
        business_no: a.business_no,
        state: a.state,
        amount_cents: a.amount_cents,
        paid_cents: AllowanceLedger.netPaid(a),
        receivable_cents: a.state === "approved" ? a.amount_cents : 0,
        halted: a.state === "halted",
      }));
    return {
      person_id: String(personId),
      receivable_cents: items.reduce((sum, i) => sum + i.receivable_cents, 0),
      paid_cents: items.reduce((sum, i) => sum + Math.max(0, i.paid_cents), 0),
      items,
      open_disputes: this.appealBook.open({ person_id: String(personId) }).length,
    };
  }

  /** 是否存在未决争议。 */
  openDisputes(filter = {}) {
    return this.appealBook.open(filter).map((a) => ({
      appeal_id: a.appeal_id,
      case_id: a.case_id,
      person_id: a.person_id,
      target_type: a.target_type,
      target_id: a.target_id,
      deadline_at: a.deadline_at,
    }));
  }

  getSettlement(caseId) { return this.store.all("settlements").find((s) => s.case_id === String(caseId)) ?? null; }
  getCase(caseId) { return this.store.get("cases", caseId); }
}
