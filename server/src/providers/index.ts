import type { Platform } from '@realllmfree/shared/types.js';
import type { BaseProvider } from './base.js';
import { GoogleProvider } from './google.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { CohereProvider } from './cohere.js';
import { CloudflareProvider } from './cloudflare.js';
import { HuggingFaceProvider } from './huggingface.js';

const providers = new Map<Platform, BaseProvider>();

function register(provider: BaseProvider) {
  providers.set(provider.platform, provider);
}

// Google - unique Gemini API format
register(new GoogleProvider());

// Groq - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'groq',
  name: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
}));

// Cerebras - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'cerebras',
  name: 'Cerebras',
  baseUrl: 'https://api.cerebras.ai/v1',
}));

// SambaNova - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'sambanova',
  name: 'SambaNova',
  baseUrl: 'https://api.sambanova.ai/v1',
}));

// NVIDIA NIM - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'nvidia',
  name: 'NVIDIA NIM',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
}));

// Mistral - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'mistral',
  name: 'Mistral',
  baseUrl: 'https://api.mistral.ai/v1',
}));

// OpenRouter - OpenAI-compatible with extra headers
register(new OpenAICompatProvider({
  platform: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  extraHeaders: {
    'HTTP-Referer': 'http://localhost:3001',
    'X-Title': 'RealLLMFree',
  },
}));

// GitHub Models - OpenAI-compatible via Azure endpoint
register(new OpenAICompatProvider({
  platform: 'github',
  name: 'GitHub Models',
  baseUrl: 'https://models.inference.ai.azure.com',
}));

// Cohere - OpenAI-compatible via Cohere compatibility endpoint
register(new CohereProvider());

// Cloudflare Workers AI - OpenAI-compatible endpoint (key = "account_id:token")
register(new CloudflareProvider());

// Hugging Face - OpenAI-compatible per-model endpoint
register(new HuggingFaceProvider());

// Zhipu (Z.ai / bigmodel.cn) - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'zhipu',
  name: 'Zhipu AI',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
}));

// Moonshot (Kimi) - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'moonshot',
  name: 'Moonshot',
  baseUrl: 'https://api.moonshot.ai/v1',
}));

// MiniMax - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'minimax',
  name: 'MiniMax',
  baseUrl: 'https://api.minimax.io/v1',
}));

// Kiro AI — sidecar gateway for AWS Q Developer / Kiro IDE free-tier access
// (Claude Sonnet 4.5, Haiku 4.5, GLM-5, DeepSeek-V3.2, MiniMax M2.5, etc.).
//
// We do NOT re-implement Kiro's AWS event-stream protocol or OAuth refresh
// here — that's 21 files of Python in jwadow/kiro-gateway. Instead we treat
// kiro-gateway as a sidecar process at KIRO_GATEWAY_URL exposing an OpenAI-
// compatible /v1/chat/completions; we route to it like any other provider.
//
// User runs:
//   docker run -d -p 8000:8000 -e PROXY_API_KEY=<random> \
//     -e REFRESH_TOKEN=<from kiro IDE> ghcr.io/jwadow/kiro-gateway:latest
//
// Then sets KIRO_GATEWAY_URL=http://kiro-gateway:8000/v1 (Railway sibling
// service) or http://host.docker.internal:8000/v1 (local Docker), and adds
// the PROXY_API_KEY value as a regular API key for platform=kiro.
//
// We always register the provider so /api/models#hasProvider stays consistent.
// Kiro models are inserted with enabled=0 in migrateModelsV8 — the user flips
// them on via the dashboard once they've launched the sidecar and set up an
// api_keys row with the PROXY_API_KEY they configured for kiro-gateway.
register(new OpenAICompatProvider({
  platform: 'kiro',
  name: 'Kiro AI',
  baseUrl: (process.env.KIRO_GATEWAY_URL ?? 'http://localhost:8000/v1').replace(/\/$/, ''),
  timeoutMs: 60000, // first-token can take 10-20s when AWS auth is cold
}));

// OpenCode Free - no-auth passthrough proxy at opencode.ai/zen/v1.
// Models with the `-free` suffix work without an API key (cost: 0); the rest
// require a paid OpenCode account. The platform is registered with noAuth so the
// router never sends an Authorization header. Slow path — 30s timeout because
// requests cascade through OpenCode → upstream provider.
register(new OpenAICompatProvider({
  platform: 'opencode',
  name: 'OpenCode Free',
  baseUrl: 'https://opencode.ai/zen/v1',
  noAuth: true,
  timeoutMs: 30000,
}));

export function getProvider(platform: Platform): BaseProvider | undefined {
  return providers.get(platform);
}

export function getAllProviders(): BaseProvider[] {
  return Array.from(providers.values());
}

export function hasProvider(platform: Platform): boolean {
  return providers.has(platform);
}
