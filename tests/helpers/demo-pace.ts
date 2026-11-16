import type { ProviderAdapter } from "@/server/providers/types";

/**
 * Runs the demo provider's placeholders at `times` its own pace (a demo clip takes 7 s), for tests that run long chains
 * of demo steps to the end. Pass the mock provider as the test file imported it (after its data folder is set).
 */
export function demoPace(provider: ProviderAdapter, times: number): void {
  const poll = provider.poll.bind(provider);
  provider.poll = (ctx) => {
    const started = Number(ctx.meta.startedAt);
    return poll({ ...ctx, meta: { ...ctx.meta, startedAt: Date.now() - (Date.now() - started) * times } });
  };
}
