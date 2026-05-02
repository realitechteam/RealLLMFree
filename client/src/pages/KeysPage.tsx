import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import type { ApiKey, Platform } from '../../../shared/types'

const PLATFORMS: { value: Platform; label: string; signupUrl: string }[] = [
  { value: 'google', label: 'Google AI Studio', signupUrl: 'https://aistudio.google.com/apikey' },
  { value: 'groq', label: 'Groq', signupUrl: 'https://console.groq.com/keys' },
  { value: 'cerebras', label: 'Cerebras', signupUrl: 'https://cloud.cerebras.ai/' },
  { value: 'sambanova', label: 'SambaNova', signupUrl: 'https://cloud.sambanova.ai/apis' },
  { value: 'nvidia', label: 'NVIDIA NIM', signupUrl: 'https://build.nvidia.com/' },
  { value: 'mistral', label: 'Mistral', signupUrl: 'https://console.mistral.ai/api-keys' },
  { value: 'openrouter', label: 'OpenRouter', signupUrl: 'https://openrouter.ai/keys' },
  { value: 'github', label: 'GitHub Models', signupUrl: 'https://github.com/settings/personal-access-tokens' },
  { value: 'huggingface', label: 'Hugging Face', signupUrl: 'https://huggingface.co/settings/tokens' },
  { value: 'cohere', label: 'Cohere', signupUrl: 'https://dashboard.cohere.com/api-keys' },
  { value: 'cloudflare', label: 'Cloudflare Workers AI', signupUrl: 'https://dash.cloudflare.com/profile/api-tokens' },
  { value: 'zhipu', label: 'Zhipu AI (Z.ai)', signupUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { value: 'moonshot', label: 'Moonshot (Kimi)', signupUrl: 'https://platform.moonshot.ai/console/api-keys' },
  { value: 'minimax', label: 'MiniMax', signupUrl: 'https://platform.minimax.io/login' },
  { value: 'opencode', label: 'OpenCode Free', signupUrl: 'https://opencode.ai/' },
]

// Recommended starter pack: 3 providers covering speed (Cerebras), code (OpenRouter qwen3-coder),
// and breadth (Groq → 1000 RPD on Llama 3.3 70B). Together they unlock ~80% of the catalog
// with the lowest possible signup friction (no card, no phone for any of these three).
const STARTER_PACK: Platform[] = ['groq', 'cerebras', 'openrouter']

const statusDot: Record<string, string> = {
  healthy: 'bg-emerald-500',
  rate_limited: 'bg-amber-500',
  invalid: 'bg-rose-500',
  error: 'bg-rose-500',
  unknown: 'bg-muted-foreground/40',
}

const statusLabel: Record<string, string> = {
  healthy: 'healthy',
  rate_limited: 'rate-limited',
  invalid: 'invalid',
  error: 'error',
  unknown: 'unchecked',
}

interface HealthPlatform {
  platform: string
  totalKeys: number
  healthyKeys: number
  rateLimitedKeys: number
  invalidKeys: number
  errorKeys: number
  unknownKeys: number
}

interface HealthData {
  platforms: HealthPlatform[]
  keys: { id: number; platform: string; status: string; lastCheckedAt: string | null }[]
}

function UnifiedKeySection() {
  const queryClient = useQueryClient()
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)

  const { data } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const regenerate = useMutation({
    mutationFn: () => apiFetch('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unified-key'] }),
  })

  const apiKey = data?.apiKey ?? ''
  const masked = apiKey ? apiKey.slice(0, 13) + '•'.repeat(32) : '…'

  function copy() {
    navigator.clipboard.writeText(apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">Your unified API key</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Use this as your OpenAI <code className="font-mono">api_key</code>; it authenticates requests to this proxy.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => regenerate.mutate()}
          disabled={regenerate.isPending}
        >
          Regenerate
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-md select-all truncate tabular-nums">
          {showKey ? apiKey : masked}
        </code>
        <Button variant="outline" size="sm" onClick={() => setShowKey(!showKey)}>
          {showKey ? 'Hide' : 'Show'}
        </Button>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <span className="text-muted-foreground">Base URL</span>
        <code className="font-mono">http://localhost:3001/v1</code>
        <span className="text-muted-foreground">Endpoint</span>
        <code className="font-mono">/v1/chat/completions</code>
      </div>
    </section>
  )
}

interface BulkResult {
  ok: { line: number; platform: string; id: number }[]
  skipped: { line: number; reason: string; raw: string }[]
}

export default function KeysPage() {
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState<Platform | ''>('')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null)

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
    refetchInterval: 30000,
  })

  const addKey = useMutation({
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setPlatform('')
      setApiKey('')
      setAccountId('')
      setLabel('')
    },
  })

  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })

  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const checkKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const bulkImport = useMutation({
    mutationFn: (text: string) =>
      apiFetch<BulkResult>('/api/keys/bulk', { method: 'POST', body: JSON.stringify({ text }) }),
    onSuccess: (data) => {
      setBulkResult(data)
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      // Trigger health check on all newly added keys
      if (data.ok.length > 0) {
        apiFetch('/api/health/check-all', { method: 'POST' }).catch(() => {})
      }
    },
  })

  const configuredPlatforms = new Set(keys.map(k => k.platform))
  const missingStarter = STARTER_PACK.filter(p => !configuredPlatforms.has(p))

  const needsAccountId = platform === 'cloudflare'

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!platform || !apiKey) return
    if (needsAccountId && !accountId) return
    const key = needsAccountId ? `${accountId}:${apiKey}` : apiKey
    addKey.mutate({ platform, key, label: label || undefined })
  }

  const healthKeyMap = new Map<number, { status: string; lastCheckedAt: string | null }>()
  for (const k of healthData?.keys ?? []) healthKeyMap.set(k.id, k)

  const grouped = PLATFORMS.map(p => ({
    ...p,
    keys: keys.filter(k => k.platform === p.value),
  })).filter(p => p.keys.length > 0)

  return (
    <div>
      <PageHeader
        title="Keys"
        description="Provider credentials and the unified API key your apps connect with."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setBulkOpen(true)}>
              Bulk import
            </Button>
            {keys.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => checkAll.mutate()} disabled={checkAll.isPending}>
                {checkAll.isPending ? 'Checking…' : 'Check all'}
              </Button>
            )}
          </div>
        }
      />

      <div className="space-y-8">
        <UnifiedKeySection />

        {missingStarter.length > 0 && (
          <section className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-5">
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <h2 className="text-sm font-medium">Quick start — recommended starter pack</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  These three free-tier providers cover ~80% of the catalog with no card and no phone verification. Sign up for each, then bulk-paste below.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setBulkOpen(true)}>
                Bulk import keys
              </Button>
            </div>
            <ol className="space-y-2 text-xs">
              {STARTER_PACK.map((p, i) => {
                const meta = PLATFORMS.find(x => x.value === p)!
                const done = configuredPlatforms.has(p)
                return (
                  <li key={p} className="flex items-center gap-3">
                    <span className={`size-5 inline-flex items-center justify-center rounded-full text-[10px] font-medium ${done ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                      {done ? '✓' : i + 1}
                    </span>
                    <span className="font-medium">{meta.label}</span>
                    <span className="text-muted-foreground">— {p === 'groq' ? 'fast Llama 3.3 70B + GPT-OSS' : p === 'cerebras' ? 'fastest, Qwen3 235B' : '5+ free models incl. qwen3-coder'}</span>
                    <div className="flex-1" />
                    {done ? (
                      <span className="text-[11px] text-emerald-700 dark:text-emerald-400">configured</span>
                    ) : (
                      <a href={meta.signupUrl} target="_blank" rel="noreferrer" className="text-[11px] underline hover:no-underline">
                        Get key →
                      </a>
                    )}
                  </li>
                )
              })}
            </ol>
          </section>
        )}

        {bulkOpen && (
          <section className="rounded-lg border p-5 bg-card">
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <h2 className="text-sm font-medium">Bulk import</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Paste one key per line in <code className="font-mono">platform=key</code> format. Comments (<code className="font-mono">#</code>) and blank lines are ignored. <code className="font-mono">GROQ_API_KEY=…</code> style works too.
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => { setBulkOpen(false); setBulkResult(null); setBulkText('') }}>
                Close
              </Button>
            </div>
            <textarea
              value={bulkText}
              onChange={e => setBulkText(e.target.value)}
              placeholder={`groq=gsk_xxxxxxxxxxxxxxxxxxxx\ncerebras=csk-xxxxxxxxxxxxxxxxxxxx\nopenrouter=sk-or-v1-xxxxxxxxxxxxxxxxxxxx\n# Cloudflare needs account_id:token\ncloudflare=YOUR_ACCOUNT_ID:YOUR_TOKEN\n# .env-style aliases also work\nGOOGLE_API_KEY=AIza...`}
              className="w-full h-40 font-mono text-xs rounded-md border bg-background px-3 py-2 resize-y focus:outline-none focus:ring-2 focus:ring-ring"
              spellCheck={false}
            />
            <div className="flex items-center gap-3 mt-3">
              <Button size="sm" onClick={() => bulkImport.mutate(bulkText)} disabled={!bulkText.trim() || bulkImport.isPending}>
                {bulkImport.isPending ? 'Importing…' : 'Import all'}
              </Button>
              {bulkImport.isError && (
                <span className="text-destructive text-xs">{(bulkImport.error as Error).message}</span>
              )}
            </div>
            {bulkResult && (
              <div className="mt-4 grid grid-cols-2 gap-4 text-xs">
                <div>
                  <p className="font-medium text-emerald-700 dark:text-emerald-400 mb-1">Imported ({bulkResult.ok.length})</p>
                  <ul className="space-y-0.5 text-muted-foreground">
                    {bulkResult.ok.map(o => (
                      <li key={o.id}>✓ line {o.line}: {o.platform}</li>
                    ))}
                    {bulkResult.ok.length === 0 && <li>—</li>}
                  </ul>
                </div>
                <div>
                  <p className="font-medium text-rose-700 dark:text-rose-400 mb-1">Skipped ({bulkResult.skipped.length})</p>
                  <ul className="space-y-0.5 text-muted-foreground">
                    {bulkResult.skipped.map((s, i) => (
                      <li key={i}>line {s.line}: {s.reason}</li>
                    ))}
                    {bulkResult.skipped.length === 0 && <li>—</li>}
                  </ul>
                </div>
              </div>
            )}
          </section>
        )}

        <section>
          <h2 className="text-sm font-medium mb-3">Add a provider key</h2>
          <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3 rounded-lg border p-4 bg-card">
            <div className="space-y-1.5">
              <Label className="text-xs">Platform</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map(p => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {needsAccountId && (
              <div className="space-y-1.5">
                <Label className="text-xs">Account ID</Label>
                <Input
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  placeholder="a1b2c3d4…"
                  className="w-[200px] font-mono text-xs"
                />
              </div>
            )}
            <div className="space-y-1.5 flex-1 min-w-[240px]">
              <Label className="text-xs">{needsAccountId ? 'API token' : 'API key'}</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={needsAccountId ? 'Bearer token' : 'paste key here'}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Label</Label>
              <Input
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="optional"
                className="w-[160px]"
              />
            </div>
            <Button type="submit" size="sm" disabled={!platform || !apiKey || (needsAccountId && !accountId) || addKey.isPending}>
              {addKey.isPending ? 'Adding…' : 'Add key'}
            </Button>
          </form>
          {addKey.isError && (
            <p className="text-destructive text-xs mt-2">{(addKey.error as Error).message}</p>
          )}
        </section>

        <section>
          <h2 className="text-sm font-medium mb-3">Configured providers</h2>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : keys.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No provider keys yet. Add one above to start routing.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map(group => (
                <div key={group.value}>
                  <div className="flex items-baseline justify-between mb-2">
                    <h3 className="text-sm font-medium">{group.label}</h3>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {group.keys.length} key{group.keys.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="rounded-lg border divide-y bg-card overflow-hidden">
                    {group.keys.map(k => {
                      const h = healthKeyMap.get(k.id)
                      const status = h?.status ?? k.status
                      const lastChecked = h?.lastCheckedAt
                      return (
                        <div key={k.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                          <span className={`size-1.5 rounded-full flex-shrink-0 ${statusDot[status] ?? statusDot.unknown}`} />
                          <code className="text-xs font-mono flex-shrink-0">{k.maskedKey}</code>
                          {k.label && <span className="text-xs text-muted-foreground">{k.label}</span>}
                          <span className="text-xs text-muted-foreground">{statusLabel[status] ?? status}</span>
                          <div className="flex-1" />
                          {lastChecked && (
                            <span className="text-[11px] text-muted-foreground tabular-nums">
                              {new Date(lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                          <Button variant="ghost" size="xs" onClick={() => checkKey.mutate(k.id)} disabled={checkKey.isPending}>
                            Check
                          </Button>
                          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={() => deleteKey.mutate(k.id)} disabled={deleteKey.isPending}>
                            Remove
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
