import { Console, Effect, Schedule } from "effect";

import { width } from "./Layout.ts";
import { Output } from "./Output.ts";
import { clean, paint } from "./Theme.ts";

export const withProgress = Effect.fnUntraced(function* <A, E, R>(message: string, task: Effect.Effect<A, E, R>) {
  const { stdout } = yield* Output;
  const label = clean(message);
  if (!stdout.decorative || !stdout.color || width(label) + 5 >= stdout.width) {
    yield* Console.log(label);
    return yield* task;
  }
  const frames = stdout.unicode ? ["·", "✧", "✦", "✧"] : [".", "o", "O", "o"];
  let frame = 0;
  const render = Effect.sync(() =>
    process.stdout.write(`\r\x1b[2K  ${paint(stdout, "primary", frames[frame++ % frames.length]!)} ${label}`),
  );
  yield* render;
  yield* Effect.addFinalizer(() => Effect.sync(() => process.stdout.write("\r\x1b[2K")));
  yield* render.pipe(Effect.schedule(Schedule.spaced("120 millis")), Effect.forkScoped);
  return yield* task;
}, Effect.scoped);
