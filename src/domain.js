/** 基础领域记录及输入校验。 */
export function createRecord(payload) {
  const required = ["record_id", "owner_id", "state"];
  const missing = required.filter((name) => !String(payload[name] ?? "").trim());
  if (missing.length) throw new Error(`缺少必要字段：${missing.join("、")}`);
  const revision = Number(payload.revision ?? 1);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("revision 必须是正整数");
  return Object.freeze({
    record_id: String(payload.record_id), owner_id: String(payload.owner_id),
    state: String(payload.state), revision,
    created_at: payload.created_at || new Date().toISOString(),
  });
}

/** 深冻结：政策快照与分录生成后不可再被修改。 */
export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** 金额一律使用整数“分”，避免浮点误差。 */
export function toCents(value, field = "金额") {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${field}必须是整数（单位：分）`);
  return n;
}

/** 必填字段校验。 */
export function requireFields(payload, fields) {
  const missing = fields.filter((name) => !String(payload?.[name] ?? "").trim());
  if (missing.length) throw new Error(`缺少必要字段：${missing.join("、")}`);
}

/** 解析时间并归一化为 ISO 字符串，便于比较与顺延计算。 */
export function parseTime(value, field = "时间") {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`${field}不是有效时间`);
  return new Date(t).toISOString();
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 人员类别。 */
export const PERSON_CATEGORIES = Object.freeze({
  EMPLOYEE: "employee", // 在职职工
  RESIDENT: "resident", // 城乡居民
  FLEXIBLE: "flexible", // 灵活就业
});

/** 参保关系时段：人员在某地区、某人员类别下的有效参保区间。 */
export function createEnrollment(payload) {
  requireFields(payload, ["enrollment_id", "person_id", "region_id", "category", "start", "end"]);
  if (!Object.values(PERSON_CATEGORIES).includes(payload.category)) {
    throw new Error(`未知人员类别：${payload.category}`);
  }
  const start = parseTime(payload.start, "参保开始");
  const end = parseTime(payload.end, "参保结束");
  if (Date.parse(start) > Date.parse(end)) throw new Error("参保时段起止颠倒");
  return deepFreeze({
    enrollment_id: String(payload.enrollment_id),
    person_id: String(payload.person_id),
    region_id: String(payload.region_id),
    category: payload.category,
    start, end,
  });
}

/** 地区政策版本：基础服务包、并发症分组、津贴规则与零自付范围。 */
export function createPolicyVersion(payload) {
  requireFields(payload, ["policy_id", "region_id", "version", "effective_from"]);
  const version = Number(payload.version);
  if (!Number.isInteger(version) || version < 1) throw new Error("政策版本号必须是正整数");
  const pkg = payload.basic_package;
  if (!pkg || !String(pkg.package_id ?? "").trim()) throw new Error("缺少必要字段：basic_package.package_id");
  const covered = Array.isArray(pkg.covered_categories) ? pkg.covered_categories.map(String) : [];
  if (!covered.length) throw new Error("基础服务包必须至少覆盖一个费用类目");
  const pkgRatio = Number(pkg.fund_ratio ?? 1);
  if (!(pkgRatio >= 0 && pkgRatio <= 1)) throw new Error("基础服务包基金承担比例必须在 0 到 1 之间");
  const groups = (payload.complication_groups ?? []).map((g) => {
    if (!String(g?.group_id ?? "").trim()) throw new Error("并发症分组缺少 group_id");
    const categories = Array.isArray(g.categories) ? g.categories.map(String) : [];
    if (!categories.length) throw new Error(`并发症分组 ${g.group_id} 必须包含费用类目`);
    const ratio = Number(g.fund_ratio ?? 1);
    if (!(ratio >= 0 && ratio <= 1)) throw new Error("并发症分组基金承担比例必须在 0 到 1 之间");
    return deepFreeze({ group_id: String(g.group_id), categories: deepFreeze(categories), fund_ratio: ratio });
  });
  let allowance = null;
  if (payload.allowance) {
    const daily = toCents(payload.allowance.daily_base_cents, "津贴日基数");
    const days = Number(payload.allowance.days);
    if (!(daily > 0) || !(Number.isInteger(days) && days > 0)) {
      throw new Error("津贴规则需要正的日基数与整数天数");
    }
    allowance = deepFreeze({ daily_base_cents: daily, days, direct_payment: payload.allowance.direct_payment !== false });
  }
  const effectiveFrom = parseTime(payload.effective_from, "政策生效时间");
  const effectiveTo = payload.effective_to ? parseTime(payload.effective_to, "政策失效时间") : null;
  if (effectiveTo && Date.parse(effectiveFrom) > Date.parse(effectiveTo)) throw new Error("政策生效时段起止颠倒");
  return deepFreeze({
    policy_id: String(payload.policy_id),
    region_id: String(payload.region_id),
    version,
    effective_from: effectiveFrom,
    effective_to: effectiveTo,
    basic_package: deepFreeze({
      package_id: String(pkg.package_id),
      covered_categories: deepFreeze(covered),
      zero_self_pay: pkg.zero_self_pay !== false,
      fund_ratio: pkgRatio,
    }),
    complication_groups: deepFreeze(groups),
    allowance,
  });
}

/** 住院分娩就医案例。 */
export function openCase(payload) {
  requireFields(payload, ["case_id", "person_id", "hospital_id", "treat_region_id", "admitted_at", "discharged_at", "delivery_type"]);
  const admitted = parseTime(payload.admitted_at, "入院时间");
  const discharged = parseTime(payload.discharged_at, "出院时间");
  if (Date.parse(admitted) > Date.parse(discharged)) throw new Error("入出院时间颠倒");
  return deepFreeze({
    case_id: String(payload.case_id),
    person_id: String(payload.person_id),
    hospital_id: String(payload.hospital_id),
    treat_region_id: String(payload.treat_region_id),
    admitted_at: admitted,
    discharged_at: discharged,
    delivery_type: String(payload.delivery_type),
    state: "open",
  });
}

/** 费用明细：记录录入人，用于例外审批的职责分离。 */
export function createCharge(payload) {
  requireFields(payload, ["charge_id", "case_id", "category", "entered_by"]);
  const amount = toCents(payload.amount_cents, "费用金额");
  if (!(amount > 0)) throw new Error("费用金额必须为正");
  return deepFreeze({
    charge_id: String(payload.charge_id),
    case_id: String(payload.case_id),
    category: String(payload.category),
    amount_cents: amount,
    entered_by: String(payload.entered_by),
    entered_at: payload.entered_at ? parseTime(payload.entered_at, "录入时间") : new Date().toISOString(),
  });
}

/** 预授权：限定可用基金的费用类目与限额，超范围费用需要例外审批。 */
export function createPreAuthorization(payload) {
  requireFields(payload, ["auth_id", "case_id"]);
  const categories = Array.isArray(payload.categories) ? payload.categories.map(String) : [];
  const limit = payload.limit_cents == null ? null : toCents(payload.limit_cents, "预授权限额");
  if (limit !== null && !(limit > 0)) throw new Error("预授权限额必须为正");
  return deepFreeze({
    auth_id: String(payload.auth_id),
    case_id: String(payload.case_id),
    categories: deepFreeze(categories),
    limit_cents: limit,
    status: "active",
  });
}
