/**
 * market-panel.ts — assemble a jury panel from the Agent Market.
 *
 * The protocol's design is that the marketplace catalog IS the jury registry:
 * an agent joins the pool by listing itself with our tag, and the panel is
 * assembled by querying it. There is no registry contract to deploy and no
 * onboarding database to keep.
 *
 * Two things this proves, and both are executable today without spending:
 *
 *   pool   — who is in the jury pool right now, with their price and track record
 *   quote  — the live x402 price of one call to a listed agent (free: the quote
 *            is a 402, and a 402 costs nothing)
 *
 * What it deliberately does not do: pay a call. A paid call needs a wallet
 * holding the settlement asset on the quoted network; we have not exercised
 * that leg, and pretending otherwise would be the exact dishonesty this repo
 * argues against. The payment path is specified in the caller skill:
 * https://market.near.ai/skill/x402-caller/SKILL.md
 *
 * Usage:
 *   npm run panel:market                      # the pool
 *   npm run panel:market -- --tag <tag>       # a different tag
 *   npm run panel:market -- --quote <handle>  # the live 402 for one agent
 */
import { existsSync, readFileSync } from 'node:fs';

const MARKET = (process.env.MARKET_BASE_URL || 'https://market.near.ai').replace(/\/$/, '');
const TAG = 'confidential-second-opinion';

/* Trusted JSON boundaries: responses from the public marketplace API and the
 * A2A endpoint. Shapes are read defensively; unknown fields are ignored. */
interface CatalogAgent {
  agent_id: string;
  handle: string;
  name?: string;
  description?: string | null;
  category?: string;
  available_now?: boolean | null;
  delivered_jobs?: number | null;
  success_rate?: number | null;
  sla_seconds?: number;
  tags?: string[];
}
interface PricingPlan { price_amount?: string; sla_seconds?: number | null; is_default?: boolean; listing_status?: string }
interface X402Accept { scheme?: string; network?: string; asset?: string; amount?: string; payTo?: string; maxTimeoutSeconds?: number }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * The catalog's `q` is a FUZZY text match (it matched "confidential" and
 * "opinion" separately), so it is a retrieval hint, not a registry key. The
 * registry key is the EXACT tag: an agent is in the pool only when its `tags`
 * array carries ours. That is what the juror skill tells agents to set.
 */
async function pool(): Promise<{ exact: CatalogAgent[]; fuzzy: number }> {
  const tag = arg('tag') || TAG;
  const data = await getJson<{ agents?: CatalogAgent[] }>(`${MARKET}/v1/agents?q=${encodeURIComponent(tag)}&limit=50`);
  const agents = data?.agents ?? [];
  const exact = agents.filter((a) => (a.tags ?? []).some((t) => t.toLowerCase() === tag.toLowerCase()));
  return { exact, fuzzy: agents.length - exact.length };
}

async function defaultPrice(agentId: string): Promise<PricingPlan | null> {
  const data = await getJson<{ pricing_plans?: PricingPlan[]; data?: PricingPlan[] }>(`${MARKET}/v1/agents/${agentId}/pricing-plans`);
  const plans = data?.pricing_plans ?? data?.data ?? [];
  return plans.find((p) => p.is_default) ?? plans[0] ?? null;
}

async function quote(handle: string): Promise<{ status: number; accepts: X402Accept[] } | null> {
  const url = `https://${handle}.${new URL(MARKET).hostname}/a2a/v1`;
  const body = {
    jsonrpc: '2.0', id: 1, method: 'SendMessage',
    params: {
      message: {
        messageId: crypto.randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text: 'Decision: Pay vendor.near 20 USDC for a completed security review. Evidence: published, milestones met. The question: should this payment be approved? Tier: attested.' }],
      },
      configuration: { historyLength: 0 },
    },
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'confidential-second-opinion/0.1' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { accepts?: X402Accept[] };
    return { status: res.status, accepts: data.accepts ?? [] };
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const handle = arg('quote');
  if (handle) {
    console.log(`MARKET PANEL — quote one call from ${handle}`);
    const q = await quote(handle);
    if (!q) { console.log('  the agent did not answer (unreachable host)'); return 2; }
    if (q.status === 402 && q.accepts.length > 0) {
      for (const a of q.accepts) {
        const usd = a.amount ? (Number(a.amount) / 1e6).toFixed(2) : '?';
        console.log(`  HTTP 402 · ${a.amount} atomic ($${usd}) on ${a.network} · asset ${a.asset?.slice(0, 12)}… · payTo ${a.payTo?.slice(0, 12)}… · window ${a.maxTimeoutSeconds}s`);
      }
      console.log(`\nMARKET PANEL: one call quoted · ${q.accepts[0].amount} ${q.accepts[0].network} · unpaid (the quote is a 402, the call is not)`);
      return 0;
    }
    const why = q.status === 200 ? 'the agent answered without payment (unexpected)' : `HTTP ${q.status}`;
    console.log(`  no 402: ${why}. An agent that is paused, unpriced or silent answers with a JSON-RPC error instead.`);
    console.log('MARKET PANEL: no quote');
    return 2;
  }

  const { exact: agents, fuzzy } = await pool();
  console.log(`MARKET PANEL — the jury pool (exact catalog tag \`${arg('tag') || TAG}\`)`);
  console.log('  the marketplace catalog IS the registry: an agent joins by listing itself with the tag');
  if (fuzzy > 0) console.log(`  (${fuzzy} fuzzy text match(es) ignored — only the exact tag counts)`);
  if (agents.length === 0) {
    console.log('\n  the pool is empty right now. That is expected before a first listing carries the tag:');
    console.log('  the default panel is our own jurors (persistent identities, TEE-attested). The market');
    console.log('  panel is an option, not a requirement — the skill is how a stranger joins it.');
    console.log(`\nMARKET PANEL: 0 in the pool`);
    return 0;
  }
  console.log(`\n  ${'handle'.padEnd(28)} ${'price'.padEnd(8)} ${'sla'.padEnd(6)} ${'jobs'.padEnd(5)} state`);
  for (const a of agents) {
    const plan = await defaultPrice(a.agent_id);
    const price = plan?.price_amount ? `$${plan.price_amount}` : 'no plan';
    const sla = plan?.sla_seconds ?? a.sla_seconds ?? '—';
    const state = a.available_now ? 'available' : 'not available';
    console.log(`  ${String(a.handle).slice(0, 28).padEnd(28)} ${price.padEnd(8)} ${String(sla).padEnd(6)} ${String(a.delivered_jobs ?? 0).padEnd(5)} ${state}`);
  }
  console.log(`\nMARKET PANEL: ${agents.length} in the pool`);
  return 0;
}

if (process.argv[1]?.includes('market-panel')) void main().then((c) => process.exit(c));
