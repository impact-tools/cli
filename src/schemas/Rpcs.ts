import { RpcGroup } from "effect/rpc";

import { BillingRpcs } from "./Billing.ts";
import { Authentication } from "./CurrentUser.ts";

export class ImpactRpcs extends RpcGroup.make(BillingRpcs[0]).middleware(Authentication) {}
