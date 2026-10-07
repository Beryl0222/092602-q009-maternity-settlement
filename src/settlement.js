/** 结算引擎：冻结政策快照、拆分基金/个人分录、校验总额守恒、支持异地重算。 */
import { deepFreeze } from "./domain.js";

/** 选择就医期间参保地适用的政策版本（取生效版本号最高者）。 */
export function selectPolicyVersion(policies, regionId, at) {
  const t = Date.parse(at);
  const candidates = policies
    .filter((p) => p.region_id === regionId
      && Date.parse(p.effective_from) <= t
      && (!p.effective_to || t <= Date.parse(p.effective_to)))
    .sort((a, b) => b.version - a.version);
  if (!candidates.length) throw new Error(`就医期间 ${at} 参保地 ${regionId} 无适用政策版本`);
  return candidates[0];
}

/** 冻结结算适用的政策快照：结算生成后，政策更新不影响本次结算。 */
export function freezeSnapshot({ policy, homeRegionId, treatRegionId, personCategory }) {
  return deepFreeze(JSON.parse(JSON.stringify({
    policy_id: policy.policy_id,
    version: policy.version,
    home_region_id: homeRegionId,
    treat_region_id: treatRegionId,
    person_category: personCategory,
    basic_package: policy.basic_package,
    complication_groups: policy.complication_groups,
    allowance: policy.allowance,
  })));
}

export const PAYER_FUND = "fund"; // 统筹基金
export const PAYER_PERSONAL = "personal"; // 个人支付

/** 按快照判定费用类目归属：基础服务包、并发症分组或包外。 */
function classify(category, snapshot) {
  if (snapshot.basic_package.covered_categories.includes(category)) {
    const zeroSelfPay = snapshot.basic_package.zero_self_pay;
    return {
      component: "basic",
      fund_ratio: zeroSelfPay ? 1 : snapshot.basic_package.fund_ratio,
      rule_ref: `basic_package:${snapshot.basic_package.package_id}`,
      reason: zeroSelfPay
        ? "基础服务包内项目，住院分娩零自付，由统筹基金承担"
        : "基础服务包内项目，按比例由统筹基金与个人分担",
    };
  }
  const group = snapshot.complication_groups.find((g) => g.categories.includes(category));
  if (group) {
    return {
      component: "complication",
      fund_ratio: group.fund_ratio,
      rule_ref: `complication:${group.group_id}`,
      reason: "并发症分组费用，按分组责任比例拆分",
    };
  }
  return {
    component: "out_of_package",
    fund_ratio: 0,
    rule_ref: "fallback:personal",
    reason: "基础服务包外费用，不享受零自付，由个人承担",
  };
}

/**
 * 把费用明细拆分为基金/个人分录。
 * 每个分录只承担一个付款方；同一费用的分录合计必须等于费用金额（总额守恒）。
 * 预授权范围外且需基金承担的费用标记为待例外审批。
 */
export function buildEntries({ settlementId, charges, snapshot, preAuth = null, revisionOf = new Map() }) {
  const inBasic = (category) => snapshot.basic_package.covered_categories.includes(category);
  const inScope = (category) => !preAuth || preAuth.categories.length === 0 || preAuth.categories.includes(category);
  const entries = [];
  for (const charge of charges) {
    const rule = classify(charge.category, snapshot);
    const fund = Math.round(charge.amount_cents * rule.fund_ratio);
    const parts = [
      [PAYER_FUND, fund],
      [PAYER_PERSONAL, charge.amount_cents - fund],
    ];
    for (const [payer, amount] of parts) {
      if (amount <= 0) continue;
      const entryId = `${settlementId}:${charge.charge_id}:${payer}`;
      entries.push(deepFreeze({
        entry_id: entryId,
        revision: (revisionOf.get(entryId) ?? 0) + 1,
        charge_id: charge.charge_id,
        component: rule.component,
        payer,
        amount_cents: amount,
        rule_ref: rule.rule_ref,
        reason: rule.reason,
        requires_exception: payer === PAYER_FUND && !inBasic(charge.category) && !inScope(charge.category),
      }));
    }
  }
  return entries;
}

/** 汇总基金责任与个人支付。 */
export function summarize(entries) {
  let fund = 0; let personal = 0;
  for (const e of entries) {
    if (e.payer === PAYER_FUND) fund += e.amount_cents; else personal += e.amount_cents;
  }
  return deepFreeze({ fund_cents: fund, personal_cents: personal, total_cents: fund + personal });
}

/** 总额守恒：每笔费用的分录合计必须等于费用本身。 */
export function assertConservation(charges, entries) {
  const byCharge = new Map();
  for (const e of entries) byCharge.set(e.charge_id, (byCharge.get(e.charge_id) ?? 0) + e.amount_cents);
  for (const charge of charges) {
    if (byCharge.get(charge.charge_id) !== charge.amount_cents) {
      throw new Error(`费用拆分不守恒：${charge.charge_id}`);
    }
  }
}

/** 异地重算差异：未受影响的分录保持原对象，受影响的记录前后值。 */
export function diffEntries(oldEntries, newEntries) {
  const oldById = new Map(oldEntries.map((e) => [e.entry_id, e]));
  const newById = new Map(newEntries.map((e) => [e.entry_id, e]));
  const kept = []; const changed = []; const added = []; const removed = [];
  for (const n of newEntries) {
    const o = oldById.get(n.entry_id);
    if (!o) { added.push(n); continue; }
    if (o.amount_cents === n.amount_cents && o.component === n.component && o.rule_ref === n.rule_ref) {
      kept.push(o);
    } else {
      changed.push(deepFreeze({ before: o, after: n }));
    }
  }
  for (const o of oldEntries) if (!newById.has(o.entry_id)) removed.push(o);
  return { kept, changed, added, removed };
}
