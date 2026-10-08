import { Schema } from "effect";

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
