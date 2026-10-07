/** 本地 JSON 命令入口。 */
import { readFile } from "node:fs/promises";
import { Service, SettlementService } from "./service.js";

const [command, file] = [process.argv[2], process.argv[3]];

if (command === "validate" && file) {
  const payload = JSON.parse(await readFile(file, "utf8"));
  console.log(JSON.stringify(new Service().register(payload)));
} else if (command === "scenario" && file) {
  const input = JSON.parse(await readFile(file, "utf8"));
  const service = new SettlementService();
  for (const enrollment of input.enrollments ?? []) service.registerEnrollment(enrollment);
  for (const policy of input.policies ?? []) service.registerPolicyVersion(policy);
  if (input.case) service.openCase(input.case);
  if (input.preauth) service.authorize(input.preauth);
  for (const charge of input.charges ?? []) service.addCharge(charge);
  const settlement = input.case ? service.settleCase(input.case.case_id) : null;
  const allowance = input.allowance
    ? service.applyAllowance({ ...input.allowance, case_id: input.case?.case_id, person_id: input.case?.person_id })
    : null;
  const statement = input.case ? service.familyStatement(input.case.person_id) : null;
  console.log(JSON.stringify({ settlement, allowance, statement }, null, 2));
} else {
  console.log(JSON.stringify(new Service().health()));
}
