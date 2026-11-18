/** Following the optional services a DSH host may or may not offer. */

import type { Context } from "@deepseek-ai/cordis";

/**
 * Follows one optional host service (`ctx.inject` fences on it): `current()` is
 * the service while the host offers it and `undefined` otherwise. The fence's
 * scope runs again when the service is replaced, so a vanished scope clears the
 * value only if no newer scope installed a replacement first. `onChange` hears
 * about every change, including the clear.
 *
 * It subscribes in its constructor: registering the fence with Cordis is how a
 * service is followed at all, and the one place a constructor reaches outside
 * itself.
 */
export class OptionalService<K extends keyof Context & string> {
  private value: Context[K] | undefined;

  constructor(
    ctx: Pick<Context, "inject">,
    key: K,
    label: string,
    private readonly onChange?: (value: Context[K] | undefined) => void,
  ) {
    ctx.inject([key], (scope) => {
      const service = scope[key];
      this.value = service;
      this.onChange?.(service);
      scope.effect(
        () => () => {
          if (this.value !== service) return;
          this.value = undefined;
          this.onChange?.(undefined);
        },
        label,
      );
    });
  }

  current(): Context[K] | undefined {
    return this.value;
  }
}
