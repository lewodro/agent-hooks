# Example — dynamic LTV on a Marginfi pool

Wires `DynamicLTV` + `AntiMEVLiq` onto a Marginfi v2 group and runs a 240-step simulation. Use this as a starting point for a real operator pool.

```
ts-node index.ts --pool sol-usdc-marginfi
```

The composition is built off-chain by the SDK; the on-chain install requires the pool authority signature and the deployed executor program ID.
