/** 进程内基础仓库，后续可替换为持久实现。 */
export class Repository {
  #records = new Map();
  add(record) {
    if (this.#records.has(record.record_id)) throw new Error("记录编号已存在");
    this.#records.set(record.record_id, record);
    return record;
  }
  get(recordId) { return this.#records.get(recordId) ?? null; }
}

/** 跨域结算簿的进程内存储：按集合保存冻结后的领域对象，并记录幂等键与故障窗口。 */
export class LedgerStore {
  #collections = new Map();
  #idempotency = new Map();
  #outages = [];

  #collection(name) {
    if (!this.#collections.has(name)) this.#collections.set(name, new Map());
    return this.#collections.get(name);
  }

  /** 新增对象，编号重复时拒绝。 */
  add(name, id, value) {
    const collection = this.#collection(name);
    const key = String(id);
    if (collection.has(key)) throw new Error(`${name} 编号已存在：${key}`);
    collection.set(key, value);
    return value;
  }

  /** 写入或覆盖对象，用于状态推进。 */
  put(name, id, value) {
    this.#collection(name).set(String(id), value);
    return value;
  }

  get(name, id) { return this.#collection(name).get(String(id)) ?? null; }
  all(name) { return [...this.#collection(name).values()]; }

  /** 幂等键：回调与重试返回首次结果。 */
  idempotentGet(key) { return this.#idempotency.get(key) ?? null; }
  idempotentPut(key, value) {
    if (!this.#idempotency.has(key)) this.#idempotency.set(key, value);
    return this.#idempotency.get(key);
  }

  recordOutage(outage) { this.#outages.push(outage); }
  outages() { return [...this.#outages]; }
}
