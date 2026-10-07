/** 生育津贴台账：幂等申请、业务号冲突停止支付、已到账津贴的冲正链。 */
import { deepFreeze, requireFields, toCents } from "./domain.js";

export class AllowanceLedger {
  constructor(store) { this.store = store; }

  /** 链条净到账金额：支付与重发为正，冲正为负。 */
  static netPaid(app) { return app.chain.reduce((sum, e) => sum + e.amount_cents, 0); }

  /** 申请津贴：同一幂等键或同一申请号重试返回原结果；同一业务号金额冲突时停止支付。 */
  apply(input) {
    requireFields(input, ["application_id", "business_no", "case_id", "person_id"]);
    const amount = toCents(input.amount_cents, "津贴金额");
    if (!(amount > 0)) throw new Error("津贴金额必须为正");
    const key = input.idempotency_key ? `allowance:${input.idempotency_key}` : null;
    if (key) {
      const seen = this.store.idempotentGet(key);
      if (seen) return seen;
    }
    const duplicate = this.store.get("allowances", input.application_id);
    if (duplicate) return this.#remember(key, duplicate);
    const sameBusiness = this.store.all("allowances").filter((a) => a.business_no === String(input.business_no));
    const conflict = sameBusiness.find((a) => a.amount_cents !== amount);
    if (conflict) {
      // 金额冲突：新旧两笔都停止支付，等待人工核查
      if (conflict.state === "approved") {
        this.store.put("allowances", conflict.application_id,
          deepFreeze({ ...conflict, state: "halted", halt_reason: "同一业务号金额冲突，停止支付" }));
      }
      const halted = this.#record(input, amount, "halted", "同一业务号金额冲突，停止支付");
      this.store.add("allowances", halted.application_id, halted);
      return this.#remember(key, halted);
    }
    if (sameBusiness.length) return this.#remember(key, sameBusiness[0]); // 同业务号同金额视为重试
    const approved = this.#record(input, amount, "approved", null);
    this.store.add("allowances", approved.application_id, approved);
    return this.#remember(key, approved);
  }

  /** 支付津贴：重复回调返回原结果；冲突中的申请拒绝支付。 */
  pay(applicationId, at = new Date().toISOString()) {
    const app = this.#mustGet(applicationId);
    if (app.state === "halted") throw new Error("同一业务号金额冲突，已停止支付");
    if (app.state === "paid") return app;
    if (app.state !== "approved") throw new Error(`当前状态不可支付：${app.state}`);
    return this.#append(app, "paid", { type: "payment", amount_cents: app.amount_cents, reason: "生育津贴直发", at });
  }

  /** 冲正：已到账津贴需要追回时，沿链条记一笔等额负向分录。 */
  reverse(applicationId, reason, at = new Date().toISOString()) {
    const app = this.#mustGet(applicationId);
    if (app.state !== "paid") throw new Error("仅已支付的津贴可以冲正");
    const net = AllowanceLedger.netPaid(app);
    if (!(net > 0)) throw new Error("当前链条无可冲正金额");
    return this.#append(app, "reversed", { type: "reversal", amount_cents: -net, reason, at });
  }

  /** 重发：冲正之后按新金额重新发放，链条保持完整。 */
  reissue(applicationId, amount, reason, at = new Date().toISOString()) {
    const app = this.#mustGet(applicationId);
    if (app.state !== "reversed") throw new Error("仅冲正后的津贴可以重发");
    const value = toCents(amount, "重发金额");
    if (!(value >= 0)) throw new Error("重发金额不能为负");
    return this.#append(app, "paid", { type: "reissue", amount_cents: value, reason, at }, { amount_cents: value });
  }

  /** 政策追溯调整：已到账的冲正后重发，未支付的直接改额。 */
  adjust(applicationId, newAmount, reason, at = new Date().toISOString()) {
    const app = this.#mustGet(applicationId);
    const value = toCents(newAmount, "调整后金额");
    if (!(value >= 0)) throw new Error("调整后金额不能为负");
    if (app.state === "paid") {
      this.reverse(applicationId, reason, at);
      return this.reissue(applicationId, value, reason, at);
    }
    if (app.state === "approved") {
      const updated = deepFreeze({ ...app, amount_cents: value, adjust_note: reason });
      return this.store.put("allowances", app.application_id, updated);
    }
    throw new Error(`当前状态不可调整：${app.state}`);
  }

  #record(input, amount, state, haltReason) {
    return deepFreeze({
      application_id: String(input.application_id),
      business_no: String(input.business_no),
      case_id: String(input.case_id),
      person_id: String(input.person_id),
      amount_cents: amount,
      state,
      halt_reason: haltReason,
      chain: deepFreeze([]),
      created_at: input.at ?? new Date().toISOString(),
    });
  }

  #append(app, state, entry, extra = {}) {
    const chainEntry = deepFreeze({ seq: app.chain.length + 1, ...entry });
    const updated = deepFreeze({ ...app, ...extra, state, chain: deepFreeze([...app.chain, chainEntry]) });
    return this.store.put("allowances", app.application_id, updated);
  }

  #remember(key, record) {
    if (key) this.store.idempotentPut(key, record);
    return record;
  }

  #mustGet(applicationId) {
    const app = this.store.get("allowances", applicationId);
    if (!app) throw new Error(`津贴申请不存在：${applicationId}`);
    return app;
  }
}
