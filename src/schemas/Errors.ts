import { Schema } from "effect";
import { RpcMiddleware } from "effect/rpc";

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  message: Schema.String,
}) {}

/** Signed in, but this needs a role the user doesn't have. */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String,
}) {}

/** Nothing with that id in the caller's reach (another workspace's rows read as missing too). */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

/**
 * The server failed in a way the caller can't fix. What happened stays in the server's log, never
 * in the reply; the call may be repeated.
 */
export class InternalError extends Schema.TaggedError<InternalError>()("InternalError", {
  message: Schema.String,
}) {}

/** What every {@link InternalError} says. */
export const INTERNAL_ERROR_MESSAGE = "The request could not be completed.";

/**
 * RPC middleware contract: on the server, a defect in any call (a bug, a database that is down) is
 * logged there in full and answered as {@link InternalError}, so no stack, SQL or driver message
 * reaches the client. Clients need nothing for it.
 */
export class ErrorBoundary extends RpcMiddleware.Service<ErrorBoundary>()("@impact-llm/schemas/ErrorBoundary", {
  error: InternalError,
}) {}
