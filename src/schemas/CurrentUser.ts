import { Context, Schema } from "effect";
import { RpcMiddleware } from "effect/rpc";

import { Unauthorized } from "./Errors.ts";

export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

/** better-auth admin plugin roles. Any stored role other than `admin` is treated as `user`. */
export const UserRole = Schema.Literals(["user", "admin"]);
export type UserRole = typeof UserRole.Type;

/** Better Auth stores comma-separated roles; the API exposes the highest supported role. */
export const userRole = (role: string | null | undefined): UserRole =>
  role?.split(",").some((entry) => entry.trim() === "admin") ? "admin" : "user";

export class User extends Schema.Class<User>("@impact-llm/schemas/User")({
  id: UserId,
  name: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean,
  role: UserRole,
  /** Authoritative session marker; absent for a normal session. Impersonation never grants admin rights. */
  impersonatedBy: Schema.optional(UserId),
}) {}

/** The authenticated user of the current request, provided by {@link Authentication}. */
export class CurrentUser extends Context.Service<CurrentUser, User>()("@impact-llm/schemas/CurrentUser") {}

/**
 * RPC middleware contract: resolves the better-auth session from the request cookie and provides
 * {@link CurrentUser}. The server implements it; clients only send their cookies.
 */
export class Authentication extends RpcMiddleware.Service<Authentication, { provides: CurrentUser }>()(
  "@impact-llm/schemas/Authentication",
  { error: Unauthorized },
) {}
