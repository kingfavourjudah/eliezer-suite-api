import "dotenv/config";
import express          from "express";
import cors             from "cors";
import shippingRouter   from "./routes/shipping";
import complianceRouter from "./routes/compliance";
import ratesRouter      from "./routes/rates";

const app  = express();
const PORT = process.env.PORT ?? 3100;

app.use(cors());
app.use(express.json());

// ── Health ─────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status:  "ok",
    service: "eliezer-suite-api",
    version: "1.0.1",
    chain:   process.env.CHAIN_ID ?? "421614",
    ts:      new Date().toISOString(),
  });
});

// ── Routes ─────────────────────────────────────────────────────────────────
app.use("/shipping",   shippingRouter);
app.use("/compliance", complianceRouter);
app.use("/rates",      ratesRouter);

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`[eliezer-suite-api] listening on :${PORT}`);
});
