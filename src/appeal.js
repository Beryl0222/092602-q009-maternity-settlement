/** 申诉台账：申诉登记、办结与时限的故障顺延。 */
import { DAY_MS, deepFreeze, parseTime, requireFields } from "./domain.js";

export class AppealBook {
  constructor(store) { this.store = store; }

  /** 登记申诉，时限自登记日起算。 */
  file(input) {
    requireFields(input, ["appeal_id", "case_id", "person_id", "target_type", "target_id", "filed_at"]);
    const filedAt = parseTime(input.filed_at, "申诉登记时间");
    const days = Number(input.deadline_days ?? 30);
    if (!(Number.isInteger(days) && days > 0)) throw new Error("申诉时限天数必须为正整数");
    const appeal = deepFreeze({
      appeal_id: String(input.appeal_id),
      case_id: String(input.case_id),
      person_id: String(input.person_id),
      target_type: String(input.target_type),
      target_id: String(input.target_id),
      filed_at: filedAt,
      deadline_at: new Date(Date.parse(filedAt) + days * DAY_MS).toISOString(),
      state: "open",
      extensions: deepFreeze([]),
      resolution: null,
    });
    return this.store.add("appeals", appeal.appeal_id, appeal);
  }

  /** 办结申诉；重复办结返回原结果。 */
  resolve(appealId, resolution, at = new Date().toISOString()) {
    const appeal = this.store.get("appeals", appealId);
    if (!appeal) throw new Error(`申诉不存在：${appealId}`);
    if (appeal.state !== "open") return appeal;
    const updated = deepFreeze({ ...appeal, state: "resolved", resolution: String(resolution ?? ""), resolved_at: at });
    return this.store.put("appeals", appeal.appeal_id, updated);
  }

  /** 服务故障恢复后，故障发生时仍在办理中的申诉时限按故障时长顺延。 */
  extendForOutage(outage) {
    const duration = Date.parse(outage.recovered_at) - Date.parse(outage.started_at);
    if (duration <= 0) return [];
    const affected = [];
    for (const appeal of this.store.all("appeals")) {
      if (appeal.state !== "open") continue;
      if (Date.parse(appeal.filed_at) > Date.parse(outage.recovered_at)) continue;
      const updated = deepFreeze({
        ...appeal,
        deadline_at: new Date(Date.parse(appeal.deadline_at) + duration).toISOString(),
        extensions: deepFreeze([...appeal.extensions, deepFreeze({ outage_id: outage.outage_id, added_ms: duration })]),
      });
      this.store.put("appeals", appeal.appeal_id, updated);
      affected.push(updated);
    }
    return affected;
  }

  /** 未决争议查询。 */
  open(filter = {}) {
    return this.store.all("appeals").filter((a) => a.state === "open"
      && (!filter.person_id || a.person_id === filter.person_id)
      && (!filter.case_id || a.case_id === filter.case_id));
  }
}
